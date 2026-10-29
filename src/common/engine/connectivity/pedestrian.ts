import { z } from 'zod';
import type { BaseRoute, Maneuver, Place, Provenance } from '../../shared/domain/types.js';
import type { RouteEndpoints } from '../kakao.js';
import type { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import { metersBetween } from '../realtime/names.js';

const DEFAULT_ENDPOINT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const MAX_BODY_BYTES = 2_000_000;
const MAX_SNAP_METERS = 75;

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
}

const responseProblem = () =>
  new ApiError('PROVIDER_RESPONSE', '보행망 응답을 검증하지 못해 해당 경로를 제외했어요.');

const timeoutProblem = () =>
  new ApiError('PROVIDER_TIMEOUT', '보행 경로 조회 시간이 초과됐어요. 다시 조회해 주세요.', 504);

const noRoute = () =>
  new ApiError(
    'NO_ROUTES',
    '출발·도착 지점까지 연결되는 검증 가능한 보행 경로를 찾지 못했어요.',
    404,
  );

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
  mode: z.literal('walking'),
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
  legs: z
    .array(
      z.object({
        steps: z.array(stepSchema).min(1).max(2000),
      }),
    )
    .length(1),
});

const payloadSchema = z.object({
  code: z.literal('Ok'),
  data_version: z.unknown().optional(),
  waypoints: z
    .array(
      z.object({
        location: coordinate,
        distance,
      }),
    )
    .length(2),
  // Validate alternatives independently: a malformed sibling is not evidence
  // against another complete, connected provider path in the same response.
  routes: z.array(z.unknown()).min(1).max(MAX_ROUTES),
});

type Coordinate = z.infer<typeof coordinate>;

const same = (a: Coordinate, b: Coordinate) => a[0] === b[0] && a[1] === b[1];

function dedupe(points: readonly Coordinate[]): Coordinate[] {
  return points.filter((point, index) => index === 0 || !same(point, points[index - 1]));
}

const point = ([longitude, latitude]: Coordinate) => ({
  latitude,
  longitude,
});

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

  for (const character of value) {
    number = Math.imul(number ^ character.charCodeAt(0), 16777619);
  }

  return (number >>> 0).toString(36);
};

function mapVersion(value: unknown, receivedAt: number): number | null {
  if (
    typeof value !== 'string' ||
    !z
      .string()
      .datetime({
        offset: true,
      })
      .safeParse(value).success
  ) {
    return null;
  }

  const timestamp = Date.parse(value);

  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= receivedAt + 30_000
    ? timestamp
    : null;
}

function instruction(type: string, modifier: string | undefined, name: string | undefined): string {
  if (type === 'arrive') {
    return '도착 지점을 현장에서 확인해 주세요.';
  }

  const road = name?.trim().replace(/\s+/g, ' ');
  const prefix = road ? `${road}에서 ` : '';

  return modifier?.includes('left')
    ? `${prefix}왼쪽으로 이동해요.`
    : modifier?.includes('right')
      ? `${prefix}오른쪽으로 이동해요.`
      : `${road ? `${road}을 따라 ` : '보행 경로를 따라 '}이동해요.`;
}

function normalize(
  input: unknown,
  request: RouteEndpoints,
  receivedAt: number,
  routeKey: string,
  sourceLabel: string,
): BaseRoute[] {
  if (
    input &&
    typeof input === 'object' &&
    'code' in input &&
    ['NoRoute', 'NoSegment'].includes(String(input.code))
  ) {
    throw noRoute();
  }

  const parsed = payloadSchema.safeParse(input);

  if (!parsed.success) {
    throw responseProblem();
  }

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

    if (seen.has(signature)) {
      continue;
    }

    try {
      routes.push(
        normalizeRoute(
          route.data,
          parsed.data,
          request,
          receivedAt,
          `${routeKey}:${signature}`,
          sourceLabel,
        ),
      );
      seen.add(signature);
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }

      rejected ??= error;
    }
  }

  if (!routes.length) {
    throw rejected ?? responseProblem();
  }

  return routes;
}

function normalizeRoute(
  route: z.infer<typeof routeSchema>,
  payload: z.infer<typeof payloadSchema>,
  request: RouteEndpoints,
  receivedAt: number,
  routeKey: string,
  sourceLabel: string,
): BaseRoute {
  const { waypoints } = payload;
  const path = dedupe(route.geometry.coordinates);

  if (
    path.length < 2 ||
    !sameSourcePosition(path[0], waypoints[0].location) ||
    !sameSourcePosition(path.at(-1)!, waypoints[1].location)
  ) {
    throw responseProblem();
  }

  const physicalMeters = path
    .slice(1)
    .reduce(
      (total, coordinate, index) => total + metersBetween(point(path[index]), point(coordinate)),
      0,
    );

  // Source coordinates/lengths are rounded independently. Permit bounded drift,
  // but reject a distance that cannot cover the supplied path rather than infer time.
  const geometryToleranceMeters = Math.min(50, Math.max(5, path.length * 0.2));

  if (route.distance + geometryToleranceMeters < physicalMeters) {
    throw responseProblem();
  }

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

  if (startMeters > MAX_SNAP_METERS || endMeters > MAX_SNAP_METERS) {
    throw noRoute();
  }

  const joined: Coordinate[] = [],
    maneuvers: Maneuver[] = [];
  let stepSeconds = 0,
    stepMeters = 0;

  for (const step of route.legs[0].steps) {
    const coordinates = dedupe(step.geometry.coordinates);

    if (
      !coordinates.length ||
      ((step.distance > 0 || step.duration > 0) && coordinates.length < 2) ||
      (joined.length && !same(joined.at(-1)!, coordinates[0])) ||
      !sameSourcePosition(step.maneuver.location, coordinates[0])
    ) {
      throw responseProblem();
    }

    for (const coordinate of coordinates) {
      if (!joined.length || !same(joined.at(-1)!, coordinate)) {
        joined.push(coordinate);
      }
    }

    stepSeconds += step.duration;
    stepMeters += step.distance;
    maneuvers.push({
      ...point(step.maneuver.location),
      instruction: instruction(step.maneuver.type, step.maneuver.modifier, step.name),
      distanceMeters: Math.ceil(step.distance),
    });
  }

  // Keep any unclassified provider overhead, while rejecting totals that erase
  // timed/distance-bearing steps. OSRM rounds individual values to tenths.
  const roundingTolerance = Math.max(1, route.legs[0].steps.length * 0.1);

  if (
    route.duration + roundingTolerance < stepSeconds ||
    route.distance + roundingTolerance < stepMeters
  ) {
    throw responseProblem();
  }

  if (
    joined.length !== path.length ||
    joined.some((coordinate, index) => !same(coordinate, path[index]))
  ) {
    throw responseProblem();
  }

  const providerSeconds = Math.ceil(route.duration),
    allowanceSeconds = Math.ceil(startMeters + endMeters);

  const routingSource: Provenance = {
    mode: 'live',
    provider: 'osrm-foot',
    label: sourceLabel,
    sourceTimestamp: mapVersion(payload.data_version, receivedAt),
    receivedAt,
    isRealtime: false,
  };

  const id = `osrm-foot-${hash(routeKey)}`;
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
  const durationSeconds = {
    min: providerSeconds,
    max: providerSeconds + allowanceSeconds,
  };

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
        distanceMeters: Math.ceil(route.distance),
        durationSeconds: {
          ...durationSeconds,
        },
        start,
        end,
        runAllowed: false,
        polyline: path.map(point),
        maneuvers,
        routingSource,
        networkSnap: {
          startMeters,
          endMeters,
          allowanceSeconds,
        },
      },
    ],
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(timeoutProblem());
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutProblem());

    signal.addEventListener('abort', abort, {
      once: true,
    });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);

        if (signal.aborted) {
          reject(timeoutProblem());
        } else {
          resolve(value);
        }
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function cancelUnreadBody(response: Response): Promise<void> | undefined {
  if (response.body && !response.bodyUsed && !response.body.locked) {
    return response.body.cancel().catch(() => {});
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(timeoutProblem());
  }

  if (milliseconds <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(timeoutProblem());
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, Math.ceil(milliseconds));

    signal.addEventListener('abort', abort, {
      once: true,
    });
  });
}

function publicRequest<T>(
  operation: () => Promise<T>,
  transportSettled: () => Promise<void>,
  signal: AbortSignal,
  throttle: NonNullable<PedestrianOptions['throttle']>,
): Promise<T> {
  if (publicQueued >= MAX_PUBLIC_QUEUE) {
    return Promise.reject(
      new ApiError('PROVIDER_LIMIT', '보행 경로 조회가 많아 잠시 후 다시 시도해야 해요.', 429),
    );
  }

  publicQueued++;

  const started = publicQueue.then(async () => {
    if (signal.aborted) {
      throw timeoutProblem();
    }

    // Serialise starts, not the complete response bodies. A slow response must
    // not block the next permitted start, while at most two requests can be active.
    while (publicInFlight.size >= MAX_PUBLIC_IN_FLIGHT) {
      await abortable(Promise.race(publicInFlight), signal);
    }

    await abortable(
      throttle(Math.max(0, lastPublicStart + PUBLIC_INTERVAL_MS - performance.now()), signal),
      signal,
    );

    if (signal.aborted) {
      throw timeoutProblem();
    }

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

    return {
      result,
    };
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

  if (length && (/^\d+$/.test(length) ? Number(length) > MAX_BODY_BYTES : true)) {
    throw responseProblem();
  }

  if (
    !response.headers.get('content-type')?.toLowerCase().includes('application/json') ||
    !response.body
  ) {
    throw responseProblem();
  }

  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', {
      fatal: true,
    });
  let bytes = 0,
    text = '';

  try {
    for (;;) {
      const part = await abortable(reader.read(), signal);

      if (part.done) {
        break;
      }

      bytes += part.value.byteLength;

      if (bytes > MAX_BODY_BYTES) {
        throw responseProblem();
      }

      text += decoder.decode(part.value, {
        stream: true,
      });
    }

    text += decoder.decode();

    return JSON.parse(text);
  } catch (error) {
    if (signal.aborted) {
      throw timeoutProblem();
    }

    if (error instanceof ApiError) {
      throw error;
    }

    throw responseProblem();
  } finally {
    track(reader.cancel());
  }
}

/** Dedicated pedestrian network only; no driving URL or arbitrary straight connector is a fallback. */
export class PedestrianRouter {
  readonly configured: boolean;
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly throttle: NonNullable<PedestrianOptions['throttle']>;
  private readonly userAgent: string;
  private readonly cache = new Map<
    string,
    {
      routes: BaseRoute[];
      receivedAt: number;
    }
  >();
  private readonly pending = new Map<string, Promise<BaseRoute[]>>();

  constructor(options: PedestrianOptions = {}) {
    let endpoint: URL;

    try {
      endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    } catch {
      throw new ApiError('INVALID_INPUT', '보행 경로 서버 설정을 확인해 주세요.', 400);
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
      !endpoint.pathname.endsWith('/route/v1/foot') ||
      (endpoint.hostname === 'routing.openstreetmap.de' &&
        (endpoint.protocol !== 'https:' || endpoint.pathname !== '/routed-foot/route/v1/foot'))
    ) {
      throw new ApiError('INVALID_INPUT', '전용 보행 프로필의 경로 서버 설정이 필요해요.', 400);
    }

    this.endpoint = endpoint;
    this.configured = options.enabled !== false;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 12_000;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new ApiError('INVALID_INPUT', '보행 경로 조회 제한 시간을 확인해 주세요.', 400);
    }

    this.throttle = options.throttle ?? sleep;
    this.userAgent = options.userAgent ?? 'Jigakjido/0.1 (Seoul pedestrian route comparison)';

    if (!/^[\x20-\x7e]{10,256}$/.test(this.userAgent)) {
      throw new ApiError('INVALID_INPUT', '보행 경로 조회 앱 식별 설정을 확인해 주세요.', 400);
    }
  }

  async walking(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    if (!this.configured) {
      throw new ApiError('LIVE_NOT_CONFIGURED', '보행 경로 서버가 비활성화되어 있어요.', 503);
    }

    if (!validPlace(request?.origin) || !validPlace(request?.destination)) {
      throw new ApiError('INVALID_INPUT', '보행 출발·도착 좌표를 확인해 주세요.', 400);
    }

    const now = this.now();

    if (!Number.isFinite(now) || now <= 0) {
      throw responseProblem();
    }

    const key = this.key(request);
    const cached = this.cache.get(key);

    if (cached && now >= cached.receivedAt && now - cached.receivedAt <= CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);

      return cached.routes.map((route) => this.label(route, request));
    }

    this.cache.delete(key);

    let pending = this.pending.get(key);

    if (!pending) {
      pending = this.load(request, budget, key).then((routes) => {
        this.cache.set(key, {
          routes,
          receivedAt: routes[0].segments[0].routingSource!.receivedAt,
        });

        while (this.cache.size > MAX_CACHE_ENTRIES) {
          this.cache.delete(this.cache.keys().next().value!);
        }

        return routes;
      });
      this.pending.set(key, pending);
      void pending.then(
        () => {
          if (this.pending.get(key) === pending) {
            this.pending.delete(key);
          }
        },
        () => {
          if (this.pending.get(key) === pending) {
            this.pending.delete(key);
          }
        },
      );
    }

    return (await pending).map((route) => this.label(route, request));
  }

  /** Only a completed, still-fresh route proves zero HTTP cost. Pending work can
   * fail and trigger the composite provider's fallback, so it is not a free hint.
   * This never changes receipt timestamps or extends the bounded cache lifetime.
   */
  walkingIsCached(request: RouteEndpoints): boolean {
    if (!this.configured || !validPlace(request?.origin) || !validPlace(request?.destination)) {
      return false;
    }

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

    segment.start.name = request.origin.name;
    segment.end.name = request.destination.name;
    segment.title = `${request.destination.name}까지 걷기`;

    return copy;
  }

  private async load(
    request: RouteEndpoints,
    budget: CallBudget,
    key: string,
  ): Promise<BaseRoute[]> {
    const controller = new AbortController(),
      deadline = performance.now() + this.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = new URL(this.endpoint.href);

    url.pathname += `/${request.origin.longitude.toFixed(8)},${request.origin.latitude.toFixed(8)};${request.destination.longitude.toFixed(8)},${request.destination.latitude.toFixed(8)}`;

    // OSRM alternatives=n adds up to n alternatives to the primary route.
    url.search = new URLSearchParams({
      overview: 'full',
      geometries: 'geojson',
      steps: 'true',
      alternatives: String(MAX_ROUTES - 1),
      radiuses: '75;75',
    }).toString();

    const transportWork = new Set<Promise<void>>();

    const track = (promise: Promise<unknown> | undefined) => {
      if (!promise) {
        return;
      }

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
      while (transportWork.size) {
        await Promise.all(transportWork);
      }
    };

    const execute = async () => {
      let received: Response | undefined;

      try {
        const pendingResponse = budget
          .run(() =>
            this.fetcher(url, {
              redirect: 'error',
              headers: {
                Accept: 'application/json',
                'User-Agent': this.userAgent,
              },
              signal: controller.signal,
            }),
          )
          .then((value) => {
            received = value;

            // An injected/degraded transport may resolve after abortable has timed out.
            if (controller.signal.aborted) {
              track(cancelUnreadBody(value));
            }

            return value;
          });

        track(pendingResponse);

        const response = await abortable(pendingResponse, controller.signal);

        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw responseProblem();
        }

        if (response.status === 429) {
          throw new ApiError(
            'PROVIDER_LIMIT',
            '보행망 서버의 조회 한도에 도달했어요. 잠시 후 다시 시도해 주세요.',
            429,
          );
        }

        if (!response.ok) {
          throw new ApiError(
            'PROVIDER_UNAVAILABLE',
            '보행망 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
          );
        }

        const payload = await boundedJson(response, controller.signal, track);

        if (controller.signal.aborted || performance.now() > deadline) {
          throw timeoutProblem();
        }

        const receivedAt = this.now();

        if (!Number.isFinite(receivedAt) || receivedAt <= 0) {
          throw responseProblem();
        }

        const sourceLabel =
          this.endpoint.hostname === 'routing.openstreetmap.de'
            ? 'OpenStreetMap 보행망 (FOSSGIS/OSRM)'
            : 'OpenStreetMap 보행망 (OSRM)';

        return normalize(payload, request, Math.floor(receivedAt), key, sourceLabel);
      } finally {
        if (received) {
          track(cancelUnreadBody(received));
        }
      }
    };

    try {
      return this.endpoint.hostname === 'routing.openstreetmap.de'
        ? await publicRequest(execute, transportSettled, controller.signal, this.throttle)
        : await execute();
    } catch (error) {
      if (controller.signal.aborted || performance.now() > deadline) {
        throw timeoutProblem();
      }

      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '보행망 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
