import { z } from 'zod';
import {
  MAX_NETWORK_SNAP_METERS,
  type BaseRoute,
  type BaseSegment,
  type Maneuver,
  type Place,
  type Provenance,
} from '../../shared/domain/types.js';
import type { RouteEndpoints, TravelTable } from '../kakao.js';
import type { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import { metersBetween } from '../realtime/names.js';

const PUBLIC_HOST = 'routing.openstreetmap.de';
const MAX_BODY_BYTES = 2_000_000;
/** A bike dock stands at the kerb; a ride whose network starts further away does not start at that dock. */
export const MAX_DOCK_SNAP_METERS = 75;

/** One OpenStreetMap network on an OSRM server. FOSSGIS serves each profile from its own path. */
interface Profile {
  publicPath: string;
  pathSuffix: string;
  /** Step modes this network may use; a ferry or train is neither a walk nor a ride. */
  stepModes: readonly string[];
  provider: 'osrm-foot' | 'osrm-bike';
  network: string;
  maxSnapMeters: number;
  userAgent: string;
}
const FOOT: Profile = {
  publicPath: '/routed-foot/route/v1/foot',
  pathSuffix: '/route/v1/foot',
  stepModes: ['walking'],
  provider: 'osrm-foot',
  network: '보행망',
  maxSnapMeters: MAX_NETWORK_SNAP_METERS,
  userAgent: 'Jigakjido/0.1 (Seoul pedestrian route comparison)',
};
const BIKE: Profile = {
  publicPath: '/routed-bike/route/v1/bike',
  pathSuffix: '/route/v1/bike',
  stepModes: ['cycling', 'pushing bike'],
  provider: 'osrm-bike',
  network: '자전거망',
  maxSnapMeters: MAX_DOCK_SNAP_METERS,
  userAgent: 'Jigakjido/0.1 (Seoul bicycle route comparison)',
};

type PathPoint = { latitude: number; longitude: number };
/** The stretches of a bicycle-network ride where OSRM has the rider walk the bike. */
export interface PushedStretches {
  readonly meters: number;
  /** OSRM's own seconds for them, at the profile's walking pace (4 km/h, 2 km/h on steps). */
  readonly seconds: number;
  /** The ridden parts of the path in order, without the walked ones. */
  readonly ridden: readonly (readonly PathPoint[])[];
}
/** A walked stretch's step; a scooter or e-bike ride names its own vehicle in its place. */
export const PUSH_INSTRUCTION = '자전거에서 내려 끌고 걸어요.';
/** Kept beside the segment, never on it, so the API response and its schema stay as they are. */
const pushedStretches = new WeakMap<BaseSegment, PushedStretches>();
/** The walked stretches of a ride segment this router returned; undefined for any other source. */
export const pushedAlong = (segment: BaseSegment): PushedStretches | undefined =>
  pushedStretches.get(segment);
// OSRM waypoint/maneuver positions can differ slightly from their own full
// geometry (0.37 m in a captured Seoul response). This tolerance does not join
// separate path fragments or move any returned geometry.
const MAX_SOURCE_POSITION_DRIFT_METERS = 1;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_PUBLIC_QUEUE = 64;
const PUBLIC_INTERVAL_MS = 1000;
const MAX_PUBLIC_IN_FLIGHT = 2;
const MAX_ROUTES = 3;
/** Sources plus destinations in one table request; keeps the URL and the public server's work small. */
const MAX_TABLE_POINTS = 60;
/** A map point inside a large building can snap to a path on its far side (서울역: 166 m became 20 min).
 * A detouring walk is retried from points this far around the snapped end. */
const AROUND_METERS = 90;
const AROUND_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];
const MAX_AROUND_WALK_METERS = 2_000;
const DETOUR_RATIO = 1.6;
const DETOUR_EXTRA_METERS = 200;
/** Two points this close that snapped onto parallel ways (the two sidewalks of one road) are
 * routed to the next junction and back; a route this much longer than the step is that U-turn. */
const SAME_SPOT_METERS = 10;
const SAME_SPOT_DETOUR_METERS = 30;
/** A self-hosted server answers in milliseconds: a request still open after this is a stalled server, not a slow answer. */
const LOCAL_TIMEOUT_MS = 3_000;
/** Its calls spend no budget, so only this cap keeps one search from flooding it. */
const LOCAL_MAX_IN_FLIGHT = 8;
/** After this many stalled or refused requests in a row it is skipped, and stops counting as free, for a while. */
const LOCAL_FAILURE_LIMIT = 3;
const LOCAL_COOLDOWN_MS = 30_000;
/** Errors that mean the server itself is silent or broken (no connection, a 5xx), not that one query had no answer. */
const serverFailures = new WeakSet<ApiError>();
const serverFailure = (error: ApiError) => {
  serverFailures.add(error);
  return error;
};
/**
 * True when the server gave no usable answer: silence, no connection, a 5xx or another refusal, a
 * rate limit, or a rest after failures in a row. "No route" and a malformed route are answers, and
 * another network asked in their place would only spend its quota.
 */
export const routerOutage = (error: unknown): boolean =>
  error instanceof ApiError &&
  ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_LIMIT'].includes(error.code);

/** One FOSSGIS request stream across app instances and simultaneous user searches. */
let publicQueue: Promise<void> = Promise.resolve();
let publicQueued = 0;
let lastPublicStart = -Infinity;
const publicInFlight = new Set<Promise<void>>();

export interface PedestrianOptions {
  endpoint?: string;
  enabled?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Test hook for virtual delays; production uses abortable real-time throttling. */
  throttle?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  userAgent?: string;
  /** Walks requested within this window share one multi-stop request (0 sends each alone). */
  batchWindowMs?: number;
  /** False for a self-hosted server: it has no quota, so its calls do not spend a search's call budget. */
  metered?: boolean;
}

const responseProblem = () =>
  new ApiError(
    'PROVIDER_RESPONSE',
    'OpenStreetMap 경로 응답을 검증하지 못해 해당 경로를 제외했어요.',
  );
const timeoutProblem = () =>
  new ApiError(
    'PROVIDER_TIMEOUT',
    'OpenStreetMap 경로 조회 시간이 초과됐어요. 다시 조회해 주세요.',
    504,
  );
const noRoute = () =>
  new ApiError('NO_ROUTES', '출발·도착 지점까지 연결되는 검증 가능한 경로를 찾지 못했어요.', 404);
/** OSRM's answer for a point it cannot snap within the radius, or for points it cannot connect. */
const saysNoRoute = (input: unknown) =>
  !!input &&
  typeof input === 'object' &&
  'code' in input &&
  ['NoRoute', 'NoSegment'].includes(String(input.code));
const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const geometry = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(coordinate).min(1).max(20_000),
});
const seconds = z.number().finite().nonnegative().max(604_800);
const distance = z.number().finite().nonnegative().max(1_000_000);
const stepSchema = z.object({
  mode: z.string().min(1).max(100),
  name: z.string().max(500).optional(),
  duration: seconds,
  distance,
  geometry,
  maneuver: z.object({
    type: z.string().min(1).max(100),
    modifier: z.string().max(100).optional(),
    location: coordinate,
  }),
});
const routeSchema = z.object({
  duration: seconds.positive(),
  distance: distance.positive(),
  geometry,
  legs: z.array(z.object({ steps: z.array(stepSchema).min(1).max(2000) })).length(1),
});
const payloadSchema = z.object({
  code: z.literal('Ok'),
  data_version: z.unknown().optional(),
  waypoints: z.array(z.object({ location: coordinate, distance })).length(2),
  // Validate alternatives independently: a malformed sibling is not evidence
  // against another complete, connected provider path in the same response.
  routes: z.array(z.unknown()).min(1).max(MAX_ROUTES),
});
const chainSchema = z.object({
  code: z.literal('Ok'),
  data_version: z.unknown().optional(),
  waypoints: z.array(z.object({ location: coordinate, distance })).min(4),
  routes: z
    .array(
      z.object({
        legs: z
          .array(
            z.object({ duration: seconds, distance, steps: z.array(stepSchema).min(1).max(2000) }),
          )
          .min(3),
      }),
    )
    .min(1),
});
const tableSchema = z.object({
  code: z.literal('Ok'),
  durations: z.array(z.array(seconds.nullable())),
  sources: z.array(z.object({ distance })),
  destinations: z.array(z.object({ distance })),
});
/** Legs per chained request: 2n-1 legs between 2n waypoints (96 points answer in about two seconds). */
const MAX_CHAIN_WALKS = 48;
type Coordinate = z.infer<typeof coordinate>;
const same = (a: Coordinate, b: Coordinate) => a[0] === b[0] && a[1] === b[1];
function dedupe(points: readonly Coordinate[]): Coordinate[] {
  return points.filter((point, index) => index === 0 || !same(point, points[index - 1]));
}
const point = ([longitude, latitude]: Coordinate) => ({ latitude, longitude });
const sameSourcePosition = (a: Coordinate, b: Coordinate) =>
  same(a, b) || metersBetween(point(a), point(b)) <= MAX_SOURCE_POSITION_DRIFT_METERS;
const validPlace = (place: Place) =>
  !!place &&
  Number.isFinite(place.latitude) &&
  Number.isFinite(place.longitude) &&
  Math.abs(place.latitude) <= 90 &&
  Math.abs(place.longitude) <= 180 &&
  typeof place.name === 'string' &&
  !!place.name.trim() &&
  place.name.length <= 300;
const hash = (value: string) => {
  let number = 2166136261;
  for (const character of value) number = Math.imul(number ^ character.charCodeAt(0), 16777619);
  return (number >>> 0).toString(36);
};

function mapVersion(value: unknown, receivedAt: number): number | null {
  if (typeof value !== 'string' || !z.string().datetime({ offset: true }).safeParse(value).success)
    return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= receivedAt + 30_000
    ? timestamp
    : null;
}
function instruction(profile: Profile, step: z.infer<typeof stepSchema>): string {
  const { type, modifier } = step.maneuver;
  if (type === 'arrive') return '도착 지점을 현장에서 확인해 주세요.';
  const road = step.name?.trim().replace(/\s+/g, ' ');
  const prefix = road ? `${road}에서 ` : '';
  if (step.mode === 'pushing bike') return `${prefix}${PUSH_INSTRUCTION}`;
  return modifier?.includes('left')
    ? `${prefix}왼쪽으로 이동해요.`
    : modifier?.includes('right')
      ? `${prefix}오른쪽으로 이동해요.`
      : `${road ? `${road}을 따라 ` : profile === BIKE ? '자전거 경로를 따라 ' : '보행 경로를 따라 '}이동해요.`;
}

function normalize(
  input: unknown,
  request: RouteEndpoints,
  receivedAt: number,
  routeKey: string,
  profile: Profile,
  sourceLabel: string,
): BaseRoute[] {
  if (saysNoRoute(input)) throw noRoute();
  const parsed = payloadSchema.safeParse(input);
  if (!parsed.success) throw responseProblem();
  const routes: BaseRoute[] = [],
    seen = new Set<string>();
  let rejected: ApiError | undefined;
  for (const candidate of parsed.data.routes) {
    const route = routeSchema.safeParse(candidate);
    if (!route.success) {
      rejected ??= responseProblem();
      continue;
    }
    const signature = JSON.stringify(route.data);
    if (seen.has(signature)) continue;
    try {
      routes.push(
        normalizeRoute(
          route.data,
          parsed.data,
          request,
          receivedAt,
          `${routeKey}:${signature}`,
          profile,
          sourceLabel,
        ),
      );
      seen.add(signature);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      rejected ??= error;
    }
  }
  if (!routes.length) throw rejected ?? responseProblem();
  return routes;
}

function normalizeRoute(
  route: z.infer<typeof routeSchema>,
  payload: z.infer<typeof payloadSchema>,
  request: RouteEndpoints,
  receivedAt: number,
  routeKey: string,
  profile: Profile,
  sourceLabel: string,
): BaseRoute {
  const { waypoints } = payload;
  const path = dedupe(route.geometry.coordinates);
  if (
    path.length < 2 ||
    !sameSourcePosition(path[0], waypoints[0].location) ||
    !sameSourcePosition(path.at(-1)!, waypoints[1].location)
  )
    throw responseProblem();
  const physicalMeters = path
    .slice(1)
    .reduce(
      (total, coordinate, index) => total + metersBetween(point(path[index]), point(coordinate)),
      0,
    );
  // Source coordinates/lengths are rounded independently. Permit bounded drift,
  // but reject a distance that cannot cover the supplied path rather than infer time.
  const geometryToleranceMeters = Math.min(50, Math.max(5, path.length * 0.2));
  if (route.distance + geometryToleranceMeters < physicalMeters) throw responseProblem();
  const startMeters = Math.max(
    waypoints[0].distance,
    metersBetween(request.origin, point(waypoints[0].location)),
    metersBetween(request.origin, point(path[0])),
  );
  const endMeters = Math.max(
    waypoints[1].distance,
    metersBetween(request.destination, point(waypoints[1].location)),
    metersBetween(request.destination, point(path.at(-1)!)),
  );
  if (startMeters > profile.maxSnapMeters || endMeters > profile.maxSnapMeters) throw noRoute();
  const joined: Coordinate[] = [],
    maneuvers: Maneuver[] = [];
  let stepSeconds = 0,
    stepMeters = 0,
    pushedMeters = 0,
    pushedSeconds = 0,
    riding = false;
  const ridden: Coordinate[][] = [];
  for (const step of route.legs[0].steps) {
    const coordinates = dedupe(step.geometry.coordinates);
    if (
      !profile.stepModes.includes(step.mode) ||
      !coordinates.length ||
      ((step.distance > 0 || step.duration > 0) && coordinates.length < 2) ||
      (joined.length && !same(joined.at(-1)!, coordinates[0])) ||
      !sameSourcePosition(step.maneuver.location, coordinates[0])
    )
      throw responseProblem();
    for (const coordinate of coordinates)
      if (!joined.length || !same(joined.at(-1)!, coordinate)) joined.push(coordinate);
    stepSeconds += step.duration;
    stepMeters += step.distance;
    if (step.mode === 'pushing bike') {
      pushedMeters += step.distance;
      pushedSeconds += step.duration;
      riding = false;
    } else if (coordinates.length > 1) {
      // A ridden step begins where the previous one ended, so consecutive ones are one piece.
      if (riding) ridden.at(-1)!.push(...coordinates.slice(1));
      else ridden.push([...coordinates]);
      riding = true;
    }
    maneuvers.push({
      ...point(step.maneuver.location),
      instruction: instruction(profile, step),
      distanceMeters: Math.ceil(step.distance),
    });
  }
  // Keep any unclassified provider overhead, while rejecting totals that erase
  // timed/distance-bearing steps. OSRM rounds individual values to tenths.
  const roundingTolerance = Math.max(1, route.legs[0].steps.length * 0.1);
  if (
    route.duration + roundingTolerance < stepSeconds ||
    route.distance + roundingTolerance < stepMeters
  )
    throw responseProblem();
  if (
    joined.length !== path.length ||
    joined.some((coordinate, index) => !same(coordinate, path[index]))
  )
    throw responseProblem();
  const providerSeconds = Math.ceil(route.duration),
    allowanceSeconds = Math.ceil(startMeters + endMeters);
  const routingSource: Provenance = {
    mode: 'live',
    provider: profile.provider,
    label: sourceLabel,
    sourceTimestamp: mapVersion(payload.data_version, receivedAt),
    receivedAt,
    isRealtime: false,
  };
  const id = `${profile.provider}-${hash(routeKey)}`;
  if (profile === BIKE) {
    // The bike is walked between its dock and the network: a second a metre, as a walk's snap allowance.
    const durationSeconds = {
      min: providerSeconds + allowanceSeconds,
      max: providerSeconds + allowanceSeconds,
    };
    const pushed =
      pushedMeters >= 10 ? ` 약 ${Math.round(pushedMeters)}m는 자전거를 끌고 걸어요.` : '';
    const segment: BaseSegment = {
      id: `${id}-bicycle`,
      mode: 'bicycle',
      routingProfile: 'bicycle',
      title: `${request.destination.name}까지 자전거`,
      instructions: `OpenStreetMap 자전거 경로를 따라 이동해요.${pushed} 교차로와 현장 통행 제한을 확인하세요.`,
      distanceMeters: Math.ceil(route.distance),
      durationSeconds: { ...durationSeconds },
      start: { ...request.origin },
      end: { ...request.destination },
      runAllowed: false,
      polyline: path.map(point),
      maneuvers,
      routingSource,
    };
    pushedStretches.set(segment, {
      meters: pushedMeters,
      seconds: pushedSeconds,
      ridden: ridden.map((piece) => piece.map(point)),
    });
    return {
      id,
      title: '자전거망으로 이동',
      distanceMeters: Math.ceil(route.distance),
      durationSeconds,
      transfers: 0,
      segments: [segment],
    };
  }
  const start: Place = {
    ...point(path[0]),
    id: `${id}-start`,
    name: request.origin.name,
    address: '',
  };
  const end: Place = {
    ...point(path.at(-1)!),
    id: `${id}-end`,
    name: request.destination.name,
    address: '',
  };
  const durationSeconds = { min: providerSeconds, max: providerSeconds + allowanceSeconds };
  return {
    id,
    title: '보행망으로 걷기',
    distanceMeters: Math.ceil(route.distance),
    durationSeconds,
    transfers: 0,
    segments: [
      {
        id: `${id}-walk`,
        mode: 'walk',
        title: `${request.destination.name}까지 걷기`,
        instructions:
          'OpenStreetMap 보행망 경로를 따라 이동해요. 현장 출입·통행 제한을 확인해 주세요.',
        // An outdoor pedestrian-network path; running it still needs the rider's own permission and distance cap.
        distanceMeters: Math.ceil(route.distance),
        durationSeconds: { ...durationSeconds },
        start,
        end,
        runAllowed: true,
        polyline: path.map(point),
        maneuvers,
        routingSource,
        networkSnap: { startMeters, endMeters, allowanceSeconds },
      },
    ],
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutProblem());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutProblem());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(timeoutProblem());
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function cancelUnreadBody(response: Response): Promise<void> | undefined {
  if (response.body && !response.bodyUsed && !response.body.locked)
    return response.body.cancel().catch(() => {});
}
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(timeoutProblem());
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(timeoutProblem());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, Math.ceil(milliseconds));
    signal.addEventListener('abort', abort, { once: true });
  });
}
function publicRequest<T>(
  operation: () => Promise<T>,
  transportSettled: () => Promise<void>,
  signal: AbortSignal,
  throttle: NonNullable<PedestrianOptions['throttle']>,
): Promise<T> {
  if (publicQueued >= MAX_PUBLIC_QUEUE)
    return Promise.reject(
      new ApiError('PROVIDER_LIMIT', '경로 조회가 많아 잠시 후 다시 시도해야 해요.', 429),
    );
  publicQueued++;
  const started = publicQueue.then(async () => {
    if (signal.aborted) throw timeoutProblem();
    // Serialise starts, not the complete response bodies. A slow response must
    // not block the next permitted start, while at most two requests can be active.
    while (publicInFlight.size >= MAX_PUBLIC_IN_FLIGHT)
      await abortable(Promise.race(publicInFlight), signal);
    await abortable(
      throttle(Math.max(0, lastPublicStart + PUBLIC_INTERVAL_MS - performance.now()), signal),
      signal,
    );
    if (signal.aborted) throw timeoutProblem();
    lastPublicStart = performance.now();
    const result = operation();
    // A caller deadline cannot release the physical slot while a degraded
    // transport ignores abort or its response body still needs cancellation.
    const released = result
      .then(
        () => {},
        () => {},
      )
      .then(transportSettled)
      .finally(() => {
        publicInFlight.delete(released);
      });
    publicInFlight.add(released);
    return { result };
  });
  publicQueue = started.then(
    () => {},
    () => {},
  );
  const queued = started
    .then(({ result }) => result)
    .finally(() => {
      publicQueued--;
    });
  return abortable(queued, signal);
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
  track: (promise: Promise<unknown>) => void,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (/^\d+$/.test(length) ? Number(length) > MAX_BODY_BYTES : true))
    throw responseProblem();
  if (
    !response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
    !response.body
  )
    throw responseProblem();
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw responseProblem();
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (signal.aborted) throw timeoutProblem();
    if (error instanceof ApiError) throw error;
    throw responseProblem();
  } finally {
    track(reader.cancel());
  }
}

/** One dedicated OpenStreetMap network; no driving URL or arbitrary straight connector is a fallback. */
class OsrmRouter {
  readonly configured: boolean;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly throttle: NonNullable<PedestrianOptions['throttle']>;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { routes: BaseRoute[]; receivedAt: number }>();
  private readonly pending = new Map<string, Promise<BaseRoute[]>>();
  private readonly tables = new Map<string, { table: TravelTable; receivedAt: number }>();
  private readonly batchWindowMs: number;
  protected readonly metered: boolean;
  private localInFlight = 0;
  private readonly localWaiting: (() => void)[] = [];
  private localFailures = 0;
  private localDownUntil = 0;
  private queued: {
    request: RouteEndpoints;
    budget: CallBudget;
    key: string;
    resolve: (routes: BaseRoute[]) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    options: PedestrianOptions,
    private readonly profile: Profile,
  ) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? `https://${PUBLIC_HOST}${profile.publicPath}`);
    } catch {
      throw new ApiError(
        'INVALID_INPUT',
        `${profile.network} 경로 서버 설정을 확인해 주세요.`,
        400,
      );
    }
    // DNS root dots do not make a public service a separately hosted endpoint.
    endpoint.hostname = endpoint.hostname.replace(/\.+$/, '');
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
    if (
      !['https:', 'http:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !endpoint.pathname.endsWith(profile.pathSuffix) ||
      (endpoint.hostname === PUBLIC_HOST &&
        (endpoint.protocol !== 'https:' || endpoint.pathname !== profile.publicPath))
    )
      throw new ApiError(
        'INVALID_INPUT',
        `전용 ${profile.network} 프로필의 경로 서버 설정이 필요해요.`,
        400,
      );
    this.endpoint = endpoint;
    this.configured = options.enabled !== false;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.metered = options.metered !== false || endpoint.hostname === PUBLIC_HOST;
    this.timeoutMs = options.timeoutMs ?? (this.metered ? 12_000 : LOCAL_TIMEOUT_MS);
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000)
      throw new ApiError(
        'INVALID_INPUT',
        `${profile.network} 경로 조회 제한 시간을 확인해 주세요.`,
        400,
      );
    this.throttle = options.throttle ?? sleep;
    this.userAgent = options.userAgent ?? profile.userAgent;
    if (!/^[\x20-\x7e]{10,256}$/.test(this.userAgent))
      throw new ApiError(
        'INVALID_INPUT',
        `${profile.network} 경로 조회 앱 식별 설정을 확인해 주세요.`,
        400,
      );
    this.batchWindowMs = Math.max(0, Math.min(1_000, options.batchWindowMs ?? 0));
  }

  /** True while a self-hosted server is answering: its queries spend no call budget and are not cut off by the optional-stage window. */
  get unmetered(): boolean {
    return !this.metered && this.configured && performance.now() >= this.localDownUntil;
  }

  protected async route(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    if (!this.configured)
      throw new ApiError(
        'LIVE_NOT_CONFIGURED',
        `${this.profile.network} 경로 서버가 비활성화되어 있어요.`,
        503,
      );
    if (!validPlace(request?.origin) || !validPlace(request?.destination))
      throw new ApiError(
        'INVALID_INPUT',
        `${this.profile.network} 출발·도착 좌표를 확인해 주세요.`,
        400,
      );
    const now = this.now();
    if (!Number.isFinite(now) || now <= 0) throw responseProblem();
    const key = this.key(request);
    const cached = this.cache.get(key);
    if (cached && now >= cached.receivedAt && now - cached.receivedAt <= CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.routes.map((route) => this.label(route, request));
    }
    this.cache.delete(key);
    let pending = this.pending.get(key);
    // A closed search budget must not wait in the public server's one-request-a-second queue.
    if (!pending && this.metered && budget.remaining <= 0)
      throw new ApiError(
        'CALL_BUDGET_EXCEEDED',
        '이번 검색의 경로 호출 예산을 모두 사용했어요. 확인된 경로만 표시해요.',
        429,
      );
    if (!pending) {
      pending = this.enqueue(request, budget, key).then((routes) => {
        this.cache.set(key, {
          routes,
          receivedAt: routes[0].segments[0].routingSource!.receivedAt,
        });
        while (this.cache.size > MAX_CACHE_ENTRIES)
          this.cache.delete(this.cache.keys().next().value!);
        return routes;
      });
      this.pending.set(key, pending);
      void pending.then(
        () => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        },
        () => {
          if (this.pending.get(key) === pending) this.pending.delete(key);
        },
      );
    }
    return (await pending).map((route) => this.label(route, request));
  }

  /** Only a completed, still-fresh route proves zero HTTP cost. Pending work can
   * fail and trigger the composite provider's fallback, so it is not a free hint.
   * This never changes receipt timestamps or extends the bounded cache lifetime.
   */
  protected isCached(request: RouteEndpoints): boolean {
    if (!this.configured || !validPlace(request?.origin) || !validPlace(request?.destination))
      return false;
    const cached = this.cache.get(this.key(request)),
      now = this.now();
    return (
      !!cached &&
      Number.isFinite(now) &&
      now >= cached.receivedAt &&
      now - cached.receivedAt <= CACHE_TTL_MS
    );
  }

  private key(request: RouteEndpoints): string {
    return JSON.stringify([
      this.endpoint.href,
      request.origin.latitude,
      request.origin.longitude,
      request.destination.latitude,
      request.destination.longitude,
    ]);
  }

  private label(route: BaseRoute, request: RouteEndpoints): BaseRoute {
    const copy = structuredClone(route),
      segment = copy.segments[0];
    // A clone carries no side table entry: hand over the walked stretches by hand.
    const walked = pushedStretches.get(route.segments[0]);
    if (walked) pushedStretches.set(segment, walked);
    if (this.profile === BIKE) {
      // A ride runs between the requested docks themselves; the cache key holds only their coordinates.
      segment.start = { ...request.origin };
      segment.end = { ...request.destination };
      segment.title = `${request.destination.name}까지 자전거`;
    } else {
      segment.start.name = request.origin.name;
      segment.end.name = request.destination.name;
      segment.title = `${request.destination.name}까지 걷기`;
    }
    return copy;
  }

  private get sourceLabel(): string {
    return `OpenStreetMap ${this.profile.network} (${this.endpoint.hostname === PUBLIC_HOST ? 'FOSSGIS/OSRM' : 'OSRM'})`;
  }

  /** The public server allows one request a second, so routes asked for together travel together. */
  private enqueue(request: RouteEndpoints, budget: CallBudget, key: string): Promise<BaseRoute[]> {
    if (!this.batchWindowMs) return this.load(request, budget, key);
    return new Promise((resolve, reject) => {
      this.queued.push({ request, budget, key, resolve, reject });
      this.flushTimer ??= setTimeout(() => this.flush(), this.batchWindowMs);
    });
  }

  private flush(): void {
    this.flushTimer = undefined;
    const queued = this.queued.splice(0);
    const budgets = [...new Set(queued.map((item) => item.budget))];
    for (const budget of budgets) {
      // Legs into one stop sit next to each other, so the unused connecting legs stay short.
      const items = queued
        .filter((item) => item.budget === budget)
        .sort((a, b) =>
          this.key({ origin: a.request.destination, destination: a.request.origin }).localeCompare(
            this.key({ origin: b.request.destination, destination: b.request.origin }),
          ),
        );
      for (let start = 0; start < items.length; start += MAX_CHAIN_WALKS) {
        const group = items.slice(start, start + MAX_CHAIN_WALKS);
        if (group.length === 1) {
          this.load(group[0].request, budget, group[0].key).then(group[0].resolve, group[0].reject);
          continue;
        }
        this.loadChain(
          group.map((item) => ({ request: item.request, key: item.key })),
          budget,
        ).then(
          (results) =>
            results.forEach((result, index) => {
              if (result instanceof Error) group[index].reject(result);
              else group[index].resolve(result);
            }),
          () => {
            // A stop the chain could not snap fails the whole request; ask for each walk on its own.
            for (const item of group)
              this.load(item.request, budget, item.key).then(item.resolve, item.reject);
          },
        );
      }
    }
  }

  private load(request: RouteEndpoints, budget: CallBudget, key: string): Promise<BaseRoute[]> {
    // OSRM alternatives=n adds up to n alternatives to the primary route.
    return this.fetchRoute(
      [request.origin, request.destination],
      budget,
      { alternatives: String(MAX_ROUTES - 1) },
      (payload, receivedAt) =>
        normalize(payload, request, receivedAt, key, this.profile, this.sourceLabel),
    );
  }

  /** One route through o1, d1, o2, d2, ...: legs 0, 2, 4, ... are the requested walks. */
  private loadChain(
    walks: { request: RouteEndpoints; key: string }[],
    budget: CallBudget,
  ): Promise<(BaseRoute[] | Error)[]> {
    const points = walks.flatMap((walk) => [walk.request.origin, walk.request.destination]);
    return this.fetchRoute(
      points,
      budget,
      { alternatives: 'false', continue_straight: 'false' },
      (input, receivedAt) => {
        if (saysNoRoute(input)) throw noRoute();
        const parsed = chainSchema.safeParse(input);
        if (
          !parsed.success ||
          parsed.data.waypoints.length !== points.length ||
          parsed.data.routes[0].legs.length !== points.length - 1
        )
          throw responseProblem();
        const {
          waypoints,
          routes: [route],
          data_version,
        } = parsed.data;
        return walks.map((walk, index) => {
          const leg = route.legs[index * 2];
          const coordinates = dedupe(leg.steps.flatMap((step) => step.geometry.coordinates));
          const single = {
            code: 'Ok',
            data_version,
            waypoints: waypoints.slice(index * 2, index * 2 + 2),
            routes: [
              {
                duration: leg.duration,
                distance: leg.distance,
                geometry: { type: 'LineString', coordinates },
                legs: [{ steps: leg.steps }],
              },
            ],
          };
          try {
            return normalize(
              single,
              walk.request,
              receivedAt,
              walk.key,
              this.profile,
              this.sourceLabel,
            );
          } catch (error) {
            if (error instanceof ApiError) return error;
            throw error;
          }
        });
      },
    );
  }

  /** Network seconds between every source and destination in one request, each end's distance onto the network walked at 1 s/m. */
  protected async table(
    sources: readonly Place[],
    destinations: readonly Place[],
    budget: CallBudget,
  ): Promise<TravelTable> {
    if (!this.configured)
      throw new ApiError(
        'LIVE_NOT_CONFIGURED',
        `${this.profile.network} 경로 서버가 비활성화되어 있어요.`,
        503,
      );
    const points = [...sources, ...destinations];
    if (
      !sources.length ||
      !destinations.length ||
      points.length > MAX_TABLE_POINTS ||
      !points.every(validPlace)
    )
      throw new ApiError(
        'INVALID_INPUT',
        `${this.profile.network} 비교 지점을 확인해 주세요.`,
        400,
      );
    const key = JSON.stringify([
      this.endpoint.href,
      'table',
      points.map((point) => [point.latitude, point.longitude]),
      sources.length,
    ]);
    const cached = this.tables.get(key),
      now = this.now();
    if (cached && now >= cached.receivedAt && now - cached.receivedAt <= CACHE_TTL_MS)
      return structuredClone(cached.table);
    if (this.metered && budget.remaining <= 0)
      throw new ApiError(
        'CALL_BUDGET_EXCEEDED',
        '이번 검색의 경로 호출 예산을 모두 사용했어요. 확인된 경로만 표시해요.',
        429,
      );
    const indices = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => from + index).join(';');
    const result = await this.fetchRoute(
      points,
      budget,
      {
        sources: indices(0, sources.length),
        destinations: indices(sources.length, destinations.length),
        annotations: 'duration',
      },
      (payload, receivedAt) => {
        const parsed = tableSchema.safeParse(payload);
        if (
          !parsed.success ||
          parsed.data.durations.length !== sources.length ||
          parsed.data.sources.length !== sources.length ||
          parsed.data.destinations.length !== destinations.length ||
          parsed.data.durations.some((row) => row.length !== destinations.length)
        )
          throw responseProblem();
        const {
          durations,
          sources: snappedSources,
          destinations: snappedDestinations,
        } = parsed.data;
        return {
          receivedAt,
          table: {
            seconds: durations.map((row, i) =>
              row.map((value, j) =>
                value === null
                  ? null
                  : value + snappedSources[i].distance + snappedDestinations[j].distance,
              ),
            ),
          },
        };
      },
      'table',
    );
    this.tables.set(key, result);
    while (this.tables.size > MAX_CACHE_ENTRIES)
      this.tables.delete(this.tables.keys().next().value!);
    return structuredClone(result.table);
  }

  private async fetchRoute<T>(
    points: Place[],
    budget: CallBudget,
    options: Record<string, string>,
    parse: (payload: unknown, receivedAt: number) => T,
    service: 'route' | 'table' = 'route',
  ): Promise<T> {
    if (this.metered) return this.send(points, budget, options, parse, service);
    const stalled = () =>
      new ApiError(
        'PROVIDER_UNAVAILABLE',
        `${this.profile.network} 서버가 응답하지 않아 잠시 건너뛰어요.`,
      );
    if (performance.now() < this.localDownUntil) throw stalled();
    await this.acquireLocalSlot();
    try {
      if (performance.now() < this.localDownUntil) throw stalled();
      const result = await this.send(points, budget, options, parse, service);
      this.localFailures = 0;
      return result;
    } catch (error) {
      // Only silence or refusal says the server is down; "no route" and bad bodies prove it answered.
      if (
        error instanceof ApiError &&
        (error.code === 'PROVIDER_TIMEOUT' || serverFailures.has(error))
      ) {
        if (++this.localFailures >= LOCAL_FAILURE_LIMIT)
          this.localDownUntil = performance.now() + LOCAL_COOLDOWN_MS;
      } else this.localFailures = 0;
      throw error;
    } finally {
      this.releaseLocalSlot();
    }
  }

  private async acquireLocalSlot(): Promise<void> {
    if (this.localInFlight < LOCAL_MAX_IN_FLIGHT) {
      this.localInFlight++;
      return;
    }
    // The finishing request hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => this.localWaiting.push(resolve));
  }

  private releaseLocalSlot(): void {
    const next = this.localWaiting.shift();
    if (next) next();
    else this.localInFlight--;
  }

  private async send<T>(
    points: Place[],
    budget: CallBudget,
    options: Record<string, string>,
    parse: (payload: unknown, receivedAt: number) => T,
    service: 'route' | 'table',
  ): Promise<T> {
    const controller = new AbortController(),
      deadline = performance.now() + this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL(this.endpoint.href);
    if (service === 'table')
      url.pathname = url.pathname.replace(/\/route\/v1\/([^/]+)$/, '/table/v1/$1');
    url.pathname += `/${points.map((place) => `${place.longitude.toFixed(8)},${place.latitude.toFixed(8)}`).join(';')}`;
    // A table point far from the network is charged its walk onto it rather than failing the whole request.
    url.search = new URLSearchParams(
      service === 'table'
        ? options
        : {
            overview: 'full',
            geometries: 'geojson',
            steps: 'true',
            ...options,
            radiuses: points.map(() => String(this.profile.maxSnapMeters)).join(';'),
          },
    ).toString();
    const transportWork = new Set<Promise<void>>();
    const track = (promise: Promise<unknown> | undefined) => {
      if (!promise) return;
      const settled = promise
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          transportWork.delete(settled);
        });
      transportWork.add(settled);
    };
    const transportSettled = async () => {
      // A late fetch may add its body cancellation while settling, so drain
      // again rather than capturing only the promises present at timeout.
      while (transportWork.size) await Promise.all(transportWork);
    };
    const execute = async () => {
      let received: Response | undefined;
      try {
        const request = () =>
          this.fetcher(url, {
            redirect: 'error',
            headers: { Accept: 'application/json', 'User-Agent': this.userAgent },
            signal: controller.signal,
          });
        const pendingResponse = (this.metered ? budget.run(request) : request()).then((value) => {
          received = value;
          // An injected/degraded transport may resolve after abortable has timed out.
          if (controller.signal.aborted) track(cancelUnreadBody(value));
          return value;
        });
        track(pendingResponse);
        const response = await abortable(pendingResponse, controller.signal);
        if (response.redirected || (response.status >= 300 && response.status < 400))
          throw responseProblem();
        if (response.status === 429)
          throw new ApiError(
            'PROVIDER_LIMIT',
            `${this.profile.network} 서버의 조회 한도에 도달했어요. 잠시 후 다시 시도해 주세요.`,
            429,
          );
        // OSRM answers a point it cannot snap within the radius (NoSegment), or points in
        // separate parts of the network (NoRoute), with a 400: an answer, not an outage.
        if (
          response.status === 400 &&
          saysNoRoute(await boundedJson(response, controller.signal, track).catch(() => null))
        )
          throw noRoute();
        if (!response.ok) {
          const unavailable = new ApiError(
            'PROVIDER_UNAVAILABLE',
            `${this.profile.network} 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`,
          );
          throw response.status >= 500 ? serverFailure(unavailable) : unavailable;
        }
        const payload = await boundedJson(response, controller.signal, track);
        if (controller.signal.aborted || performance.now() > deadline) throw timeoutProblem();
        const receivedAt = this.now();
        if (!Number.isFinite(receivedAt) || receivedAt <= 0) throw responseProblem();
        return parse(payload, Math.floor(receivedAt));
      } finally {
        if (received) track(cancelUnreadBody(received));
      }
    };
    try {
      return this.endpoint.hostname === PUBLIC_HOST
        ? await publicRequest(execute, transportSettled, controller.signal, this.throttle)
        : await execute();
    } catch (error) {
      if (controller.signal.aborted || performance.now() > deadline) throw timeoutProblem();
      if (error instanceof ApiError) throw error;
      throw serverFailure(
        new ApiError(
          'PROVIDER_UNAVAILABLE',
          `${this.profile.network} 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.`,
        ),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** OpenStreetMap foot network: every walk, with a retry from around a building whose point snapped to its far side. */
export class PedestrianRouter extends OsrmRouter {
  constructor(options: PedestrianOptions = {}) {
    super(options, FOOT);
  }

  async walking(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    const routes = await this.route(request, budget);
    const straight = metersBetween(request.origin, request.destination);
    const lengths = routes.map(
      (route) =>
        route.distanceMeters +
        (route.segments[0].networkSnap?.startMeters ?? 0) +
        (route.segments[0].networkSnap?.endMeters ?? 0),
    );
    if (
      routes.length &&
      straight <= SAME_SPOT_METERS &&
      Math.min(...lengths) > straight + SAME_SPOT_DETOUR_METERS
    )
      return [this.step(routes[0], request, straight)];
    const detoured =
      Math.min(...lengths) > straight * DETOUR_RATIO &&
      Math.min(...lengths) - straight > DETOUR_EXTRA_METERS;
    // Only an end that snapped far from its point can be on the wrong side of a building.
    const sides = (['origin', 'destination'] as const).filter(
      (side) =>
        Math.min(
          ...routes.map(
            (route) =>
              route.segments[0].networkSnap?.[side === 'origin' ? 'startMeters' : 'endMeters'] ?? 0,
          ),
        ) > 20,
    );
    if (
      !detoured ||
      !sides.length ||
      straight > MAX_AROUND_WALK_METERS ||
      (this.metered && budget.remaining <= 0)
    )
      return routes;
    const around = await Promise.allSettled(
      sides.flatMap((side) =>
        AROUND_BEARINGS.map((bearing) => {
          const anchor = request[side],
            radians = (bearing * Math.PI) / 180;
          const moved = {
            ...anchor,
            latitude: anchor.latitude + (AROUND_METERS * Math.cos(radians)) / 111_320,
            longitude:
              anchor.longitude +
              (AROUND_METERS * Math.sin(radians)) /
                (111_320 * Math.cos((anchor.latitude * Math.PI) / 180)),
          };
          return this.route(
            side === 'origin'
              ? { origin: moved, destination: request.destination }
              : { origin: request.origin, destination: moved },
            budget,
          );
        }),
      ),
    );
    const reanchored = around
      .flatMap((result) =>
        result.status === 'fulfilled'
          ? result.value.flatMap((route) => {
              const value = this.reanchor(route, request);
              return value ? [value] : [];
            })
          : [],
      )
      .sort((a, b) => a.durationSeconds.max - b.durationSeconds.max)
      .slice(0, 2);
    return [...routes, ...reanchored];
  }

  /** The few metres between two points as one straight walk, a metre a second. */
  private step(route: BaseRoute, request: RouteEndpoints, meters: number): BaseRoute {
    const { maneuvers: _maneuvers, ...segment } = route.segments[0];
    const distanceMeters = Math.ceil(meters),
      durationSeconds = { min: distanceMeters, max: distanceMeters };
    const at = ({ latitude, longitude }: Place) => ({ latitude, longitude });
    return {
      ...route,
      id: `${route.id}-step`,
      distanceMeters,
      durationSeconds,
      segments: [
        {
          ...segment,
          id: `${segment.id}-step`,
          distanceMeters,
          durationSeconds: { ...durationSeconds },
          start: { ...segment.start, ...at(request.origin) },
          end: { ...segment.end, ...at(request.destination) },
          polyline: [at(request.origin), at(request.destination)],
          networkSnap: { startMeters: 0, endMeters: 0, allowanceSeconds: 0 },
        },
      ],
    };
  }

  /** Express a walk from a nearby point as one from the requested point; the gap stays a snap allowance. */
  private reanchor(route: BaseRoute, request: RouteEndpoints): BaseRoute | null {
    const segment = route.segments[0],
      path = segment.polyline;
    if (route.segments.length !== 1 || !path || path.length < 2) return null;
    const startMeters = metersBetween(request.origin, path[0]),
      endMeters = metersBetween(request.destination, path.at(-1)!);
    if (startMeters > FOOT.maxSnapMeters || endMeters > FOOT.maxSnapMeters) return null;
    const allowanceSeconds = Math.ceil(startMeters + endMeters),
      durationSeconds = {
        min: route.durationSeconds.min,
        max: route.durationSeconds.min + allowanceSeconds,
      };
    return {
      ...route,
      id: `${route.id}-around`,
      durationSeconds,
      segments: [
        {
          ...segment,
          id: `${segment.id}-around`,
          title: `${request.destination.name}까지 걷기`,
          start: { ...segment.start, name: request.origin.name },
          end: { ...segment.end, name: request.destination.name },
          durationSeconds: { ...durationSeconds },
          networkSnap: { startMeters, endMeters, allowanceSeconds },
        },
      ],
    };
  }

  /** Only a completed, still-fresh route proves zero HTTP cost. */
  walkingIsCached(request: RouteEndpoints): boolean {
    return this.isCached(request);
  }

  walkingTable(
    sources: readonly Place[],
    destinations: readonly Place[],
    budget: CallBudget,
  ): Promise<TravelTable> {
    return this.table(sources, destinations, budget);
  }
}

/** OpenStreetMap bicycle network between two docks. It has no daily quota, unlike Kakao's bicycle routing. */
export class BicycleRouter extends OsrmRouter {
  constructor(options: PedestrianOptions = {}) {
    super(options, BIKE);
  }

  bicycle(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    return this.route(request, budget);
  }

  bicycleIsCached(request: RouteEndpoints): boolean {
    return this.isCached(request);
  }

  bicycleTable(
    sources: readonly Place[],
    destinations: readonly Place[],
    budget: CallBudget,
  ): Promise<TravelTable> {
    return this.table(sources, destinations, budget);
  }
}
