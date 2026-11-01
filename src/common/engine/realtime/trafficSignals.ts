import type { BaseRoute, BaseSegment } from '../../shared/domain/types.js';
import { fetchFeedJson, type FeedOptions } from './http.js';
import { metersBetween } from './names.js';

type Point = { latitude: number; longitude: number };

/** EPSG:5186 (Korea 2000 / Central Belt 2010, GRS80) used by Seoul's traffic safety facility data. */
export function epsg5186ToWgs84(x: number, y: number): Point {
  const a = 6_378_137,
    f = 1 / 298.257222101,
    e2 = f * (2 - f),
    ep2 = e2 / (1 - e2);
  const lat0 = (38 * Math.PI) / 180,
    lon0 = (127 * Math.PI) / 180;
  const meridian = (phi: number) =>
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const mu =
    (meridian(lat0) + (y - 600_000)) /
    (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const c1 = ep2 * Math.cos(phi1) ** 2,
    t1 = Math.tan(phi1) ** 2,
    sin = Math.sin(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin ** 2),
    r1 = (a * (1 - e2)) / (1 - e2 * sin ** 2) ** 1.5,
    d = (x - 200_000) / n1;
  const latitude =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const longitude =
    lon0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) /
      Math.cos(phi1);
  return { latitude: (latitude * 180) / Math.PI, longitude: (longitude * 180) / Math.PI };
}

export interface Intersection extends Point {
  id: string;
  name: string;
}

const CELL_DEGREES = 0.002;
const cellKey = (latitude: number, longitude: number) =>
  `${Math.floor(latitude / CELL_DEGREES)}:${Math.floor(longitude / CELL_DEGREES)}`;

/** 서울시 교통안전시설물 교차로(A008P): every signalled intersection's code and position, refreshed daily. */
export class SeoulIntersections {
  private loaded: Promise<Map<string, Intersection[]>> | null = null;
  /** The last list that finished loading, for callers that must not wait for one. */
  private ready: Map<string, Intersection[]> | null = null;
  private loadedAt = 0;
  private readonly now: () => number;

  constructor(private readonly options: FeedOptions & { key?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.options.key?.trim();
  }

  async near(point: Point, radiusMeters: number): Promise<Intersection[]> {
    return this.scan(await this.grid(), point, radiusMeters);
  }

  /** Like `near`, without waiting: null until the list has loaded once (the load starts here). */
  loadedNear(point: Point, radiusMeters: number): Intersection[] | null {
    if (this.configured) void this.grid().catch(() => undefined);
    return this.ready ? this.scan(this.ready, point, radiusMeters) : null;
  }

  private scan(
    grid: Map<string, Intersection[]>,
    point: Point,
    radiusMeters: number,
  ): Intersection[] {
    const reach = Math.ceil(radiusMeters / 180) + 1,
      row = Math.floor(point.latitude / CELL_DEGREES),
      column = Math.floor(point.longitude / CELL_DEGREES);
    const found: Intersection[] = [];
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        for (const item of grid.get(`${row + dy}:${column + dx}`) ?? [])
          if (metersBetween(point, item) <= radiusMeters) found.push(item);
      }
    return found;
  }

  private grid(): Promise<Map<string, Intersection[]>> {
    if (!this.loaded || this.now() - this.loadedAt > 86_400_000) {
      this.loadedAt = this.now();
      const pending = this.load();
      this.loaded = pending;
      // A failed load is retried on a later search rather than cached as an empty city.
      pending.catch(() => {
        if (this.loaded === pending) this.loaded = null;
      });
    }
    return this.loaded;
  }

  private async load(): Promise<Map<string, Intersection[]>> {
    const grid = new Map<string, Intersection[]>();
    for (let start = 1, total = Infinity; start <= total; start += 1000) {
      const url = new URL(
        `http://openapi.seoul.go.kr:8088/${encodeURIComponent(this.options.key!.trim())}/json/trafficSafetyA008PInfo/${start}/${start + 999}/`,
      );
      const body = (await fetchFeedJson(url, {
        ...this.options,
        timeoutMs: this.options.timeoutMs ?? 8_000,
      })) as {
        trafficSafetyA008PInfo?: { list_total_count?: number; row?: Record<string, string>[] };
      };
      const page = body.trafficSafetyA008PInfo;
      if (!page?.row?.length) break;
      total = Number(page.list_total_count) || 0;
      for (const row of page.row) {
        const id = String(row.INTR_CD ?? '').trim(),
          x = Number(row.XCRD),
          y = Number(row.YCRD);
        if (!id || !Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) continue;
        const position = epsg5186ToWgs84(x, y);
        if (
          position.latitude < 37.4 ||
          position.latitude > 37.75 ||
          position.longitude < 126.7 ||
          position.longitude > 127.25
        )
          continue;
        const item = { id, name: String(row.INTR_NM ?? '').trim(), ...position },
          key = cellKey(item.latitude, item.longitude);
        grid.set(key, [...(grid.get(key) ?? []), item]);
      }
    }
    if (!grid.size) throw new Error('No intersections');
    this.ready = grid;
    return grid;
  }
}

const DIRECTIONS = [
  ['nt', 0],
  ['ne', 45],
  ['et', 90],
  ['se', 135],
  ['st', 180],
  ['sw', 225],
  ['wt', 270],
  ['nw', 315],
] as const;
type Direction = (typeof DIRECTIONS)[number][0];
export interface PedestrianSignal {
  direction: Direction;
  bearing: number;
  go: boolean;
  remainingSeconds: number;
}
export interface IntersectionSignals {
  id: string;
  observedAt: number;
  pedestrian: PedestrianSignal[];
}

/** 36001 marks an unknown time in the SPaT feed; past an hour there is nothing to plan with. */
const UNKNOWN_REMAINING = 36_000;
const GO_STATES = new Set(['protected-Movement-Allowed', 'permissive-Movement-Allowed']);
const STOP_STATES = new Set(['stop-And-Remain', 'stop-Then-Proceed']);

/** After a failed or empty lookup an intersection is left alone for this long, then twice as long after each repeat. */
const BLOCK_FIRST_MS = 15_000;
const BLOCK_MAX_MS = 5 * 60_000;
/** An intersection T-DATA answers without a usable phase (not signalled, or no data) is not asked again for a while. */
const NO_SIGNAL_MS = 60_000;
/** A refusal from the gateway pauses every lookup; without a stated reset time the pause is this long. */
const LIMIT_PAUSE_MS = 30_000;
/** This many failures in a row, whichever intersections, say the feed itself is down. */
const OUTAGE_FAILURES = 4;
/** Until the gateway has answered once without refusing (a cold start, or after a refusal or failure), only this many lookups are open together. */
const PROBING_LOOKUPS = 4;
/** Once it answers normally nothing holds a search's crossings back (a search asks for well under a hundred), so the live phases arrive inside the 2 s signal window however slowly the gateway answers. */
const HEALTHY_LOOKUPS = Number.POSITIVE_INFINITY;

/** Seconds from "Retry-After" (delay or date) and the "X-RateLimit-Reset" family (delay or epoch), as milliseconds from now. */
function resetDelayMs(headers: Headers, now: number): number | null {
  const delays: number[] = [];
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter),
      date = Date.parse(retryAfter);
    if (Number.isFinite(seconds)) delays.push(seconds * 1000);
    else if (Number.isFinite(date)) delays.push(date - now);
  }
  for (const name of ['x-ratelimit-reset', 'x-ratelimit-reset-after', 'ratelimit-reset']) {
    const value = Number(headers.get(name));
    if (!headers.has(name) || !Number.isFinite(value) || value < 0) continue;
    // Epoch seconds when large, a delay in seconds otherwise.
    delays.push(value > 1e9 ? value * 1000 - now : value * 1000);
  }
  const usable = delays.filter((delay) => Number.isFinite(delay) && delay > 0);
  return usable.length ? Math.min(Math.max(...usable), BLOCK_MAX_MS) : null;
}

/** T-DATA (서울시 교통빅데이터플랫폼) 신호제어기 신호정보 및 잔여시간: live phase per intersection leg. */
export class TrafficSignalFeed {
  private readonly cache = new Map<
    string,
    { at: number; value: Promise<IntersectionSignals | null> }
  >();
  /** Intersections not to ask before `until` (epoch ms); `failures` doubles the wait while they keep failing. */
  private readonly blocked = new Map<string, { until: number; failures: number }>();
  private pausedUntil = 0;
  private outageFailures = 0;
  private active = 0;
  /** The last request got an ordinary answer: no refusal, no failure. */
  private healthy = false;
  private readonly waiting: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly options: FeedOptions & { key?: string; now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.options.key?.trim();
  }

  lookup(id: string): Promise<IntersectionSignals | null> {
    const cached = this.cache.get(id),
      now = this.now();
    if (cached && now - cached.at < 1_000) return cached.value;
    // A remembered failure, an empty answer or a paused gateway answers at once, without a request.
    if (now < this.pausedUntil || now < (this.blocked.get(id)?.until ?? 0))
      return Promise.resolve(null);
    const value = this.gated(id);
    this.cache.set(id, { at: now, value });
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }

  /** A gateway that has not shown itself healthy sees only a few requests at once, so a refusal stops the rest. */
  private get limit(): number {
    return this.healthy ? HEALTHY_LOOKUPS : PROBING_LOOKUPS;
  }

  private release(): void {
    while (this.waiting.length && this.active < this.limit) {
      this.active++;
      this.waiting.shift()!();
    }
  }

  private async gated(id: string): Promise<IntersectionSignals | null> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const now = this.now();
      if (now < this.pausedUntil || now < (this.blocked.get(id)?.until ?? 0)) return null;
      return await this.request(id);
    } finally {
      this.active--;
      this.release();
    }
  }

  private async request(id: string): Promise<IntersectionSignals | null> {
    let status = 0,
      headers: Headers | undefined;
    const fetcher = this.options.fetcher ?? fetch;
    const watched: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init);
      status = response.status;
      headers = response.headers;
      return response;
    };
    try {
      const value = await this.fetch(id, watched);
      this.noteLimits(status, headers);
      this.healthy = this.now() >= this.pausedUntil;
      this.release();
      if (value) {
        this.blocked.delete(id);
        this.outageFailures = 0;
      } else this.block(id, NO_SIGNAL_MS, false);
      return value;
    } catch {
      this.noteLimits(status, headers);
      this.healthy = false;
      this.block(id, BLOCK_FIRST_MS, true);
      if (status !== 429 && ++this.outageFailures >= OUTAGE_FAILURES)
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + LIMIT_PAUSE_MS);
      return null;
    }
  }

  /** A 429 (or a spent quota the gateway announces) pauses every lookup until the reset it states, else for a default pause. */
  private noteLimits(status: number, headers: Headers | undefined): void {
    const now = this.now(),
      exhausted =
        headers?.get('x-ratelimit-remaining') === '0' ||
        headers?.get('ratelimit-remaining') === '0';
    if (status !== 429 && !exhausted) return;
    const delay = headers ? resetDelayMs(headers, now) : null;
    this.pausedUntil = Math.max(this.pausedUntil, now + (delay ?? LIMIT_PAUSE_MS));
  }

  private block(id: string, firstMs: number, escalate: boolean): void {
    const previous = this.blocked.get(id),
      failures = escalate ? (previous?.failures ?? 0) + 1 : 0;
    this.blocked.set(id, {
      until: this.now() + Math.min(BLOCK_MAX_MS, firstMs * 2 ** Math.max(0, failures - 1)),
      failures,
    });
    if (this.blocked.size > 2_048) this.blocked.delete(this.blocked.keys().next().value!);
  }

  private async fetch(id: string, fetcher: typeof fetch): Promise<IntersectionSignals | null> {
    const url = new URL(
      'https://t-data.seoul.go.kr/apig/apiman-gateway/tapi/v2xSignalPhaseTimingFusionCurrentInfo/1.0',
    );
    url.search = new URLSearchParams({
      apikey: this.options.key!.trim(),
      type: 'json',
      itstId: id,
    }).toString();
    const body = await fetchFeedJson(url, {
      ...this.options,
      fetcher,
      timeoutMs: this.options.timeoutMs ?? 1_500,
    });
    const item = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    const observedAt = Number(item?.trsmUtcTime);
    if (!item || String(item.itstId) !== id || !Number.isFinite(observedAt)) return null;
    const pedestrian = DIRECTIONS.flatMap(([direction, bearing]) => {
      const remaining = Number(item[`${direction}PdsgRmdrCs`]),
        state = String(item[`${direction}PdsgStatNm`] ?? '');
      if (
        item[`${direction}PdsgRmdrCs`] === null ||
        !Number.isFinite(remaining) ||
        remaining < 0 ||
        remaining >= UNKNOWN_REMAINING ||
        (!GO_STATES.has(state) && !STOP_STATES.has(state))
      )
        return [];
      // Remaining time is reported in tenths of a second.
      return [{ direction, bearing, go: GO_STATES.has(state), remainingSeconds: remaining / 10 }];
    });
    return { id, observedAt, pedestrian };
  }
}

const bearingFrom = (center: Point, point: Point) => {
  const dy = point.latitude - center.latitude,
    dx = (point.longitude - center.longitude) * Math.cos((center.latitude * Math.PI) / 180);
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
};
const signedAngle = (from: number, to: number) => ((to - from + 540) % 360) - 180;

/** Samples every few metres along a path with their distance from its start. */
function densify(path: readonly Point[], step = 4): { point: Point; along: number }[] {
  const samples = [{ point: path[0], along: 0 }];
  let along = 0;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1],
      to = path[index],
      length = metersBetween(from, to);
    for (let part = 1; part <= Math.max(1, Math.ceil(length / step)); part++) {
      const ratio = part / Math.max(1, Math.ceil(length / step));
      samples.push({
        point: {
          latitude: from.latitude + (to.latitude - from.latitude) * ratio,
          longitude: from.longitude + (to.longitude - from.longitude) * ratio,
        },
        along: along + length * ratio,
      });
    }
    along += length;
  }
  return samples;
}

/**
 * Crosswalk legs a walk crosses at one intersection, as distance along the walk. Going around the
 * centre past a leg's bearing means crossing that leg's road; staying on one corner crosses none.
 */
export function crossedLegs(
  path: readonly Point[],
  center: Point,
  legs: readonly { bearing: number }[],
  radiusMeters = 50,
): { leg: number; along: number }[] {
  const near = densify(path).filter(
    (sample) =>
      metersBetween(sample.point, center) <= radiusMeters &&
      metersBetween(sample.point, center) >= 3,
  );
  const crossings: { leg: number; along: number }[] = [];
  legs.forEach((leg, index) => {
    for (let at = 1; at < near.length; at++) {
      const previous = near[at - 1],
        current = near[at];
      if (current.along - previous.along > 12) continue;
      const before = signedAngle(leg.bearing, bearingFrom(center, previous.point)),
        after = signedAngle(leg.bearing, bearingFrom(center, current.point));
      if (Math.abs(before) < 90 && Math.abs(after) < 90 && before < 0 !== after < 0) {
        crossings.push({ leg: index, along: current.along });
        break;
      }
    }
  });
  return crossings.sort((a, b) => a.along - b.along);
}

/** Seconds to wait at a crosswalk reached at `arrivalAt`, or null when the live phase cannot tell. */
export function crosswalkWaitSeconds(
  signal: PedestrianSignal,
  observedAt: number,
  arrivalAt: number,
): number | null {
  const elapsed = (arrivalAt - observedAt) / 1000;
  if (elapsed < -5) return null;
  if (signal.go) return elapsed <= signal.remainingSeconds - 4 ? 0 : null;
  if (elapsed < signal.remainingSeconds)
    return Math.ceil(signal.remainingSeconds - Math.max(0, elapsed));
  return elapsed < signal.remainingSeconds + 10 ? 0 : null;
}

export interface SignalTiming {
  intersections: SeoulIntersections;
  signals: TrafficSignalFeed;
}

type Crossing = {
  item: Intersection;
  live: IntersectionSignals;
  signal: IntersectionSignals['pedestrian'][number];
  along: number;
};
/** The crosswalks a walk crosses, in order, with their live phases. Independent of when the rider starts. */
async function firstWalkCrossings(
  segment: BaseSegment,
  timing: SignalTiming,
): Promise<{ crossings: Crossing[]; length: number } | null> {
  const path = segment.polyline!;
  const length = path
    .slice(1)
    .reduce((sum, point, index) => sum + metersBetween(path[index], point), 0);
  if (length < 20) return null;
  const nearby = new Map<string, Intersection>();
  for (const sample of densify(path, 40))
    for (const item of await timing.intersections.near(sample.point, 60)) nearby.set(item.id, item);
  const observed = (
    await Promise.all(
      [...nearby.values()]
        .slice(0, 12)
        .map(async (item) => ({ item, live: await timing.signals.lookup(item.id) })),
    )
  ).filter(({ live }) => live && live.pedestrian.length);
  const crossings = observed
    .flatMap(({ item, live }) =>
      crossedLegs(path, item, live!.pedestrian).map((crossing) => ({
        item,
        live: live!,
        signal: live!.pedestrian[crossing.leg],
        along: crossing.along,
      })),
    )
    .sort((a, b) => a.along - b.along);
  return { crossings, length };
}

/** Live phases are only known until they change, so only the walk the rider starts now is timed. */
function firstWalkWait(
  segment: BaseSegment,
  startAt: number,
  observed: { crossings: Crossing[]; length: number },
): { seconds: number; names: string[] } {
  const { crossings, length } = observed;
  let waited = 0;
  const names: string[] = [];
  for (const crossing of crossings) {
    const arrivalAt =
      startAt + ((crossing.along / length) * segment.durationSeconds.min + waited) * 1000;
    const wait = crosswalkWaitSeconds(crossing.signal, crossing.live.observedAt, arrivalAt);
    if (wait === null) break;
    if (wait > 0) {
      waited += wait;
      names.push(crossing.item.name);
    }
  }
  return { seconds: waited, names };
}

const firstWalk = (route: BaseRoute) => {
  const segment = route.segments[0];
  return segment &&
    (segment.mode === 'walk' || segment.mode === 'run') &&
    segment.distanceMeters > 0 &&
    (segment.polyline?.length ?? 0) >= 2
    ? segment
    : null;
};
const walkKey = (segment: BaseSegment) =>
  `${segment.durationSeconds.min}:${segment.polyline!.map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`).join(';')}`;

/**
 * Starts reading the live crosswalk phases on each route's first walk now, while other route conditions load.
 * The returned function times the waits from `startAt` and adds them to those routes (matched by the same walk),
 * giving up `timeoutMs` after it is called, exactly as a call to applySignalWaits made at that moment would.
 */
export function prepareSignalWaits(
  routes: BaseRoute[],
  timing: SignalTiming,
): (routes: BaseRoute[], startAt: number, timeoutMs?: number) => Promise<BaseRoute[]> {
  const work = new Map<
    string,
    { segment: BaseSegment; pending: Promise<{ crossings: Crossing[]; length: number } | null> }
  >();
  for (const route of routes) {
    const segment = firstWalk(route);
    if (segment && !work.has(walkKey(segment)))
      work.set(walkKey(segment), {
        segment,
        pending: firstWalkCrossings(segment, timing).catch(() => null),
      });
  }
  return async (targets, startAt, timeoutMs = 2_000) => {
    if (!work.size) return targets;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      Promise.all(
        [...work].map(async ([id, { segment, pending }]) => {
          const observed = await pending;
          return [id, observed ? firstWalkWait(segment, startAt, observed) : null] as const;
        }),
      ).then((entries) => new Map(entries)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!results) return targets;
    return targets.map((route) => {
      const segment = firstWalk(route),
        wait = segment ? results.get(walkKey(segment)) : null;
      if (!segment || !wait?.seconds) return route;
      const timed: BaseSegment = {
        ...segment,
        durationSeconds: {
          min: segment.durationSeconds.min + wait.seconds,
          max: segment.durationSeconds.max + wait.seconds,
        },
        instructions: `${segment.instructions} 신호 대기 ${wait.seconds}초 포함(${[...new Set(wait.names)].join(', ')}).`,
      };
      return {
        ...route,
        segments: [timed, ...route.segments.slice(1)],
        durationSeconds: {
          min: route.durationSeconds.min + wait.seconds,
          max: route.durationSeconds.max + wait.seconds,
        },
      };
    });
  };
}

/** Adds the red-light wait at crosswalks on each route's first walk, from live pedestrian signals. */
export async function applySignalWaits(
  routes: BaseRoute[],
  startAt: number,
  timing: SignalTiming,
  timeoutMs = 2_000,
): Promise<BaseRoute[]> {
  return prepareSignalWaits(routes, timing)(routes, startAt, timeoutMs);
}
