import type { BaseSegment, BoardingRealtime } from '../../shared/domain/types.js';
import {
  chooseBusStops,
  medianBusStopCandidates,
  unlabelledBusStopCandidates,
  SeoulBusFeed,
  selectBusArrivals,
  TagoBusFeed,
  type BusArrivalRow,
  type BusFeed,
  type BusSheetFacts,
  type BusStopCandidate,
} from './bus.js';
import { sheetLineKey } from './headway-evidence.js';
import { metersBetween, stopNamesMatch } from './names.js';
import { decodeServiceKey, FeedError, type FeedOptions } from './http.js';
import {
  DATA_GO_KR_DAILY_LIMIT,
  ServiceKeyPool,
  type CallPurpose,
  type KeyPoolUsage,
} from './key-pool.js';
import { selectSubwayArrivals, SeoulSubwayFeed, type SubwayArrivalRow } from './seoulSubway.js';

export interface BoardingQuery {
  mode: 'bus' | 'subway';
  /** Provider name of the boarding stop. */
  stop: string;
  lines: string[];
  /** Following stop names in travel order; used to pick the direction. */
  nextStops: string[];
  latitude: number;
  longitude: number;
}

export interface RealtimeOptions extends FeedOptions {
  seoulOpenApiKey?: string;
  /** Spare Seoul open data key, used once the first key's daily traffic is spent. */
  seoulOpenApiKeyFallback?: string;
  dataGoKrServiceKey?: string;
  /** Spare data.go.kr key (another account), used per operation once the first key's daily quota is spent. */
  dataGoKrServiceKeyFallback?: string;
  /** Bus calls per operation, key and Korean day this process sends at most (default 1,000; 0 = unguarded). */
  dataGoKrDailyLimit?: number;
  now?: () => number;
  /** Arrival cache for both feeds; by default 15 s for trains and 30 s for buses. */
  arrivalCacheMs?: number;
}

/** TOPIS refreshes bus positions about every 30 s, so a younger sheet adds little and costs a daily-quota call. */
const BUS_ARRIVAL_CACHE_MS = 30_000;

export interface RealtimeCapabilities {
  subway: boolean;
  bus: boolean;
}
/** The Seoul stop sheet of a bus boarding: per requested line (by `sheetLineKey`), the line's facts in the boarding direction. */
export interface BusStopSheet {
  provider: 'seoul-bus';
  stopId: string;
  stopName: string;
  lines: Map<string, BusSheetFacts & { ended: boolean }>;
}
type RealtimeProvider = BoardingRealtime['provider'];
export interface RealtimeSourceDiagnostic {
  provider: RealtimeProvider;
  status: 'unconfigured' | 'configured' | 'available' | 'auth-error' | 'quota' | 'unavailable';
  checkedAt: number | null;
  reason: FeedError['reason'] | null;
  /** With status 'quota': when the first key opens again (00:00 KST). */
  resetsAt?: number;
  /** Calls this process sent today per key and operation; keys themselves are never shown. */
  usage?: KeyPoolUsage;
}

/** The arrival operation; while its quota is open a boarding at an already listed stop can still be observed. */
const ARRIVAL_OPERATION: Readonly<Record<RealtimeProvider, string>> = {
  'seoul-subway': 'realtimeStationArrival',
  'seoul-bus': 'getStationByUid',
  'tago-bus': 'getSttnAcctoArvlPrearngeInfoList',
};

/** Every operation a live arrival needs: the stops around a boarding, then their sheet. Quotas are per operation
 * (11-01: getStationByUid was spent while getStationByPos still answered), so any one spent makes the source spent. */
const QUOTA_OPERATIONS: Readonly<Record<RealtimeProvider, readonly string[]>> = {
  'seoul-subway': ['realtimeStationArrival'],
  'seoul-bus': ['getStationByUid', 'getStationByPos'],
  'tago-bus': ['getSttnAcctoArvlPrearngeInfoList', 'getCrdntPrxmtSttnList'],
};

/** Copy on a bus wait that fell back to the headway rule because the day's live arrival calls are spent. */
export const BUS_QUOTA_WAIT_COPY = '실시간 버스 도착 한도 초과 · 배차 기준 대기';

/** While the bus quota is spent, every bus wait without live arrivals says why instead of the usual headway note. */
export function labelBusQuotaWaits<R extends { segments: BaseSegment[] }>(routes: R[]): R[] {
  const quotaWait = (segments: BaseSegment[], index: number) => {
    const boarding = segments.slice(index + 1).find((segment) => segment.mode !== 'wait');
    return (
      segments[index].mode === 'wait' &&
      !segments[index].realtime &&
      boarding?.mode === 'bus' &&
      !boarding.realtime
    );
  };
  return routes.map((route) =>
    route.segments.some((_, index) => quotaWait(route.segments, index))
      ? {
          ...route,
          segments: route.segments.map((segment, index) =>
            quotaWait(route.segments, index)
              ? { ...segment, instructions: BUS_QUOTA_WAIT_COPY }
              : segment,
          ),
        }
      : route,
  );
}

const SEOUL_AREA = { south: 37.4, north: 37.72, west: 126.73, east: 127.28 };
const inSeoulArea = (point: { latitude: number; longitude: number }) =>
  point.latitude >= SEOUL_AREA.south &&
  point.latitude <= SEOUL_AREA.north &&
  point.longitude >= SEOUL_AREA.west &&
  point.longitude <= SEOUL_AREA.east;

class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly limit = 500,
  ) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const time = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > time) return hit.value;
    if (this.entries.size >= this.limit)
      for (const [entryKey, entry] of this.entries)
        if (entry.expiresAt <= time || this.entries.size >= this.limit)
          this.entries.delete(entryKey);
    const value = load();
    this.entries.set(key, { expiresAt: time + this.ttlMs, value });
    // A failed lookup is not cached; the next request may succeed.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}

/** Best-effort live arrivals. Any feed problem yields null so route search continues without it. */
export class RealtimeService {
  private readonly subway: SeoulSubwayFeed;
  private readonly seoulBus: SeoulBusFeed;
  private readonly tagoBus: TagoBusFeed;
  private readonly now: () => number;
  private readonly subwayRows: TtlCache<{ rows: SubwayArrivalRow[]; receivedAt: number }>;
  private readonly busRows: TtlCache<{
    rows: Awaited<ReturnType<BusFeed['arrivals']>>;
    queriedAt: number;
    receivedAt: number;
  }>;
  private readonly busStops: TtlCache<BusStopCandidate[]>;
  /** One pool for both bus feeds: the same data.go.kr keys, counted per operation. */
  private readonly busKeys: ServiceKeyPool;
  private readonly subwayKeys: ServiceKeyPool;
  lastFailure: FeedError['reason'] | null = null;
  /** A failed key is isolated to its own supplier. */
  private readonly busBlockedUntil = new Map<BusFeed['provider'], number>();
  private readonly busPasses = new Map<
    string,
    Promise<{ result: BoardingRealtime | null; sheet: BusStopSheet | null }>
  >();
  private readonly sourceStates = new Map<RealtimeProvider, RealtimeSourceDiagnostic>();

  constructor(options: RealtimeOptions = {}) {
    const feed = { fetcher: options.fetcher, timeoutMs: options.timeoutMs ?? 4_000 };
    this.now = options.now ?? Date.now;
    this.subwayKeys = new ServiceKeyPool(
      [options.seoulOpenApiKey, options.seoulOpenApiKeyFallback],
      {
        now: this.now,
      },
    );
    this.busKeys = new ServiceKeyPool(
      [
        decodeServiceKey(options.dataGoKrServiceKey),
        decodeServiceKey(options.dataGoKrServiceKeyFallback),
      ],
      { now: this.now, dailyLimit: options.dataGoKrDailyLimit ?? DATA_GO_KR_DAILY_LIMIT },
    );
    this.subway = new SeoulSubwayFeed(this.subwayKeys, feed);
    this.seoulBus = new SeoulBusFeed(this.busKeys, feed);
    this.tagoBus = new TagoBusFeed(this.busKeys, feed);
    this.subwayRows = new TtlCache(options.arrivalCacheMs ?? 15_000, this.now);
    this.busRows = new TtlCache(options.arrivalCacheMs ?? BUS_ARRIVAL_CACHE_MS, this.now);
    this.busStops = new TtlCache(10 * 60_000, this.now, 2_000);
  }

  get capabilities(): RealtimeCapabilities {
    return {
      subway: this.subway.configured,
      bus: this.seoulBus.configured || this.tagoBus.configured,
    };
  }

  /** When every key of a source is closed for the day on any operation a live arrival needs, the time all of
   * them are open again; else null. */
  quotaUntil(provider: RealtimeProvider, purpose: CallPurpose = 'search'): number | null {
    const keys = provider === 'seoul-subway' ? this.subwayKeys : this.busKeys;
    const closed = QUOTA_OPERATIONS[provider].flatMap((operation) => {
      const until = keys.closedUntil(operation, purpose);
      return until === null ? [] : [until];
    });
    return closed.length ? Math.max(...closed) : null;
  }

  /** Successful HTTP is availability, not proof that a route has a catchable prediction. */
  get diagnostics(): RealtimeSourceDiagnostic[] {
    return [this.subway, this.seoulBus, this.tagoBus].map((feed, index) => {
      const provider: RealtimeProvider =
        index === 0 ? 'seoul-subway' : index === 1 ? 'seoul-bus' : 'tago-bus';
      const state = this.sourceStates.get(provider),
        resetsAt = feed.configured ? this.quotaUntil(provider) : null;
      // tago-bus shares the seoul-bus pool, so only the first two carry usage.
      const usage =
        index === 0 ? this.subwayKeys.usage() : index === 1 ? this.busKeys.usage() : undefined;
      return {
        ...(state ?? {
          provider,
          status: feed.configured ? 'configured' : 'unconfigured',
          checkedAt: null,
          reason: null,
        }),
        ...(resetsAt !== null
          ? { status: 'quota' as const, reason: 'quota' as const, resetsAt }
          : {}),
        ...(usage && feed.configured ? { usage } : {}),
      };
    });
  }

  private record(provider: RealtimeProvider, error?: unknown): void {
    const reason =
      error === undefined ? null : error instanceof FeedError ? error.reason : 'network';
    // A spent quota is read from the key pool (`quotaUntil`); a reserve kept for guidance is not a supplier failure.
    if (reason === 'quota') return;
    this.sourceStates.set(provider, {
      provider,
      status: reason === null ? 'available' : reason === 'auth' ? 'auth-error' : 'unavailable',
      checkedAt: this.now(),
      reason,
    });
  }

  /** `purpose` decides how much of the day's quota this call may use: guidance polling keeps the last share. */
  async lookup(
    query: BoardingQuery,
    purpose: CallPurpose = 'search',
  ): Promise<BoardingRealtime | null> {
    if (
      !query.stop ||
      !query.lines.length ||
      !Number.isFinite(query.latitude) ||
      !Number.isFinite(query.longitude)
    )
      return null;
    try {
      const result =
        query.mode === 'subway'
          ? await this.subwayLookup(query)
          : (await this.busArrivals(query, purpose)).result;
      this.lastFailure = null;
      return result;
    } catch (error) {
      this.lastFailure = error instanceof FeedError ? error.reason : 'network';
      return null;
    }
  }

  private async subwayLookup(query: BoardingQuery): Promise<BoardingRealtime | null> {
    if (!this.subway.configured) return null;
    try {
      const cached = await this.subwayRows.get(`subway:${query.stop}`, async () => {
        const rows = await this.subway.stationRows(query.stop, this.now());
        this.record('seoul-subway');
        return { rows, receivedAt: this.now() };
      });
      const selected = selectSubwayArrivals(cached.rows, query.lines, query.nextStops, this.now());
      if (!selected?.predictions.length) return null;
      return {
        provider: 'seoul-subway',
        stopName: query.stop,
        status: 'live',
        observedAt: selected.observedAt,
        receivedAt: cached.receivedAt,
        predictions: selected.predictions,
      };
    } catch (error) {
      this.record('seoul-subway', error);
      throw error;
    }
  }

  /** The Seoul stop sheet behind a bus boarding, read through the same stop and arrival caches as `lookup`, so a
   * concurrent or repeated call costs no extra request. Null when the stop or none of the lines is on a Seoul sheet. */
  async busSheet(
    query: BoardingQuery,
    purpose: CallPurpose = 'search',
  ): Promise<BusStopSheet | null> {
    if (
      query.mode !== 'bus' ||
      !query.stop ||
      !query.lines.length ||
      !Number.isFinite(query.latitude) ||
      !Number.isFinite(query.longitude)
    )
      return null;
    try {
      return (await this.busArrivals(query, purpose)).sheet;
    } catch {
      return null;
    }
  }

  /** `lookup` and `busSheet` of one boarding run concurrently; they share one pass, so a failing feed is asked and
   * recorded once, not twice (stop and arrival caches keep only successes). */
  private busArrivals(
    query: BoardingQuery,
    purpose: CallPurpose,
  ): Promise<{ result: BoardingRealtime | null; sheet: BusStopSheet | null }> {
    const key = JSON.stringify([
      purpose,
      query.stop,
      query.lines,
      query.nextStops[0] ?? '',
      query.latitude,
      query.longitude,
    ]);
    const running = this.busPasses.get(key);
    if (running) return running;
    const pass = this.busArrivalPass(query, purpose);
    this.busPasses.set(key, pass);
    const settle = () => {
      if (this.busPasses.get(key) === pass) this.busPasses.delete(key);
    };
    pass.then(settle, settle);
    return pass;
  }

  /** The bus feed that serves a point: Seoul TOPIS inside Seoul, the national TAGO feed elsewhere. */
  busFeedAt(point: { latitude: number; longitude: number }): BusFeed {
    return inSeoulArea(point) ? this.seoulBus : this.tagoBus;
  }

  /** The error that keeps a bus feed shut right now: a rejected key for 10 minutes, or the day's spent arrival
   * quota. A spent stop list alone still leaves the stops already in the 10-minute stop cache. */
  busBlocked(provider: BusFeed['provider'], purpose: CallPurpose = 'search'): FeedError | null {
    if (this.now() < (this.busBlockedUntil.get(provider) ?? 0)) return new FeedError('auth');
    return this.busKeys.closedUntil(ARRIVAL_OPERATION[provider], purpose) !== null
      ? new FeedError('quota')
      : null;
  }

  /** Stops around a point through the one stop cache every caller shares (10 minutes, 4-decimal point key). */
  busStopsNear(
    feed: BusFeed,
    point: { latitude: number; longitude: number },
    purpose: CallPurpose,
  ): Promise<BusStopCandidate[]> {
    return this.busStops
      .get(
        `${feed.provider}:${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
        async () => {
          const rows = await feed.nearbyStops(point, purpose);
          this.record(feed.provider);
          return rows;
        },
      )
      .catch((error: unknown) => this.busFailed(feed.provider, error));
  }

  /** One stop's arrival sheet through the one arrival cache every caller shares; concurrent askers share one request. */
  busStopRows(
    feed: BusFeed,
    stop: BusStopCandidate,
    purpose: CallPurpose,
  ): Promise<{ rows: BusArrivalRow[]; queriedAt: number; receivedAt: number }> {
    return this.busRows
      .get(`${feed.provider}:${stop.cityCode ?? ''}:${stop.id}`, async () => {
        // Relative countdowns stay anchored to the original query, never a cache lookup.
        const queriedAt = this.now();
        const rows = await feed.arrivals(stop, queriedAt, purpose);
        this.record(feed.provider);
        return { rows, queriedAt, receivedAt: this.now() };
      })
      .catch((error: unknown) => this.busFailed(feed.provider, error));
  }

  private busFailed(provider: BusFeed['provider'], error: unknown): never {
    this.record(provider, error);
    if (error instanceof FeedError && error.reason === 'auth')
      this.busBlockedUntil.set(provider, this.now() + 10 * 60_000);
    throw error;
  }

  private async busArrivalPass(
    query: BoardingQuery,
    purpose: CallPurpose,
  ): Promise<{ result: BoardingRealtime | null; sheet: BusStopSheet | null }> {
    const feeds: BusFeed[] = inSeoulArea(query) ? [this.seoulBus, this.tagoBus] : [this.tagoBus];
    let failure: unknown,
      seoulStops = false;
    for (const feed of feeds) {
      if (!feed.configured) continue;
      // TAGO does not publish Seoul's own stops; once TOPIS has listed the stops around this
      // point, the national feed can only add a 1-4 s wait, not an arrival.
      if (feed.provider === 'tago-bus' && seoulStops) continue;
      const blocked = this.busBlocked(feed.provider, purpose);
      if (blocked) {
        failure ??= blocked;
        // With the day's Seoul calls spent, TAGO would only spend its own on a city it does not publish.
        if (feed.provider === 'seoul-bus' && blocked.reason === 'quota') seoulStops = true;
        continue;
      }
      try {
        const point = { latitude: query.latitude, longitude: query.longitude };
        const stops = await this.busStopsNear(feed, point, purpose);
        if (feed.provider === 'seoul-bus' && stops.length) seoulStops = true;
        const strictStops = chooseBusStops(stops, query.stop, point);
        const inferPlatform =
          strictStops.length === 0 && feed.provider === 'seoul-bus' && !!query.nextStops[0];
        const candidates = inferPlatform
          ? [
              ...unlabelledBusStopCandidates(stops, query.stop, point),
              ...medianBusStopCandidates(stops, query.stop, point),
            ]
          : strictStops;
        // A Seoul stop serves one direction. The only same-name stop within a few metres of the boarding is its own,
        // even when the sheet's next stop is one the line skips ("신촌역로(미정차)") or Kakao lists only the alighting stop.
        const ownStop =
          !inferPlatform &&
          strictStops.length === 1 &&
          metersBetween(point, strictStops[0]) <= OWN_STOP_METERS;
        const matches: BoardingRealtime[] = [];
        const sheets: BusStopSheet[] = [];
        for (const stop of candidates) {
          const cached = await this.busStopRows(feed, stop, purpose);
          // The sheet's line facts do not depend on a listed vehicle in the boarding direction.
          const sheet =
            feed.provider === 'seoul-bus' ? stopSheet(stop, cached.rows, query, ownStop) : null;
          if (sheet) sheets.push(sheet);
          const selected = selectBusArrivals(
            cached.rows,
            query.lines,
            query.nextStops[0],
            this.now(),
          );
          if (!selected) continue;
          const result: BoardingRealtime = {
            provider: feed.provider,
            stopName: stop.name,
            status: selected.ended ? 'no-service' : 'live',
            observedAt: cached.queriedAt,
            receivedAt: cached.receivedAt,
            predictions: selected.predictions,
          };
          if (inferPlatform) matches.push(result);
          else if (selected.predictions.length || selected.ended) return { result, sheet };
        }
        if (inferPlatform) {
          const sheet = sheets.length === 1 ? sheets[0] : null;
          if (
            matches.length === 1 &&
            (matches[0].predictions.length || matches[0].status === 'no-service')
          )
            return { result: matches[0], sheet };
          if (sheet) return { result: null, sheet };
        } else if (sheets.length) return { result: null, sheet: sheets[0] };
      } catch (error) {
        failure ??= error;
        // A Seoul operation spent for the day (the stop list or a sheet): TAGO does not publish these stops either.
        if (feed.provider === 'seoul-bus' && error instanceof FeedError && error.reason === 'quota')
          seoulStops = true;
      }
    }
    if (failure) throw failure;
    return { result: null, sheet: null };
  }
}

/** Within this distance the single strict same-name stop is the boarding's own stop and direction. */
const OWN_STOP_METERS = 10;

/** The boarding direction's sheet facts for each requested line (matched without service-restriction labels). The
 * direction is the next stop's, or the stop's own when `ownStop` establishes it. */
function stopSheet(
  stop: BusStopCandidate,
  rows: BusArrivalRow[],
  query: BoardingQuery,
  ownStop = false,
): BusStopSheet | null {
  const wanted = new Set(query.lines.map(sheetLineKey)),
    nextStop = query.nextStops[0];
  const lines = new Map<string, BusSheetFacts & { ended: boolean }>();
  for (const row of rows) {
    const key = sheetLineKey(row.route);
    if (
      !wanted.has(key) ||
      !row.sheet ||
      (nextStop && !ownStop && !(row.nextStop && stopNamesMatch(row.nextStop, nextStop)))
    )
      continue;
    const previous = lines.get(key);
    // Both arrival rows of a line share its facts; the line has ended only when every row says so.
    lines.set(key, { ...row.sheet, ended: (previous?.ended ?? true) && row.ended });
  }
  return lines.size ? { provider: 'seoul-bus', stopId: stop.id, stopName: stop.name, lines } : null;
}
