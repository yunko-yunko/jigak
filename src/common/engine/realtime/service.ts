import type { BoardingRealtime } from '../../shared/domain/types.js';
import {
  chooseBusStops,
  SeoulBusFeed,
  selectBusArrivals,
  TagoBusFeed,
  type BusFeed,
  type BusStopCandidate,
} from './bus.js';
import { FeedError, type FeedOptions } from './http.js';
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
  dataGoKrServiceKey?: string;
  now?: () => number;
  arrivalCacheMs?: number;
}

export interface RealtimeCapabilities {
  subway: boolean;
  bus: boolean;
}

type RealtimeProvider = BoardingRealtime['provider'];

export interface RealtimeSourceDiagnostic {
  provider: RealtimeProvider;
  status: 'unconfigured' | 'configured' | 'available' | 'auth-error' | 'unavailable';
  checkedAt: number | null;
  reason: FeedError['reason'] | null;
}

const SEOUL_AREA = {
  south: 37.4,
  north: 37.72,
  west: 126.73,
  east: 127.28,
};

const inSeoulArea = (point: { latitude: number; longitude: number }) =>
  point.latitude >= SEOUL_AREA.south &&
  point.latitude <= SEOUL_AREA.north &&
  point.longitude >= SEOUL_AREA.west &&
  point.longitude <= SEOUL_AREA.east;

class TtlCache<T> {
  private readonly entries = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<T>;
    }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly limit = 500,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const time = this.now();
    const hit = this.entries.get(key);

    if (hit && hit.expiresAt > time) {
      return hit.value;
    }

    if (this.entries.size >= this.limit) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.expiresAt <= time || this.entries.size >= this.limit) {
          this.entries.delete(entryKey);
        }
      }
    }

    const value = load();

    this.entries.set(key, {
      expiresAt: time + this.ttlMs,
      value,
    });

    // A failed lookup is not cached; the next request may succeed.
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
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
  private readonly subwayRows: TtlCache<{
    rows: SubwayArrivalRow[];
    receivedAt: number;
  }>;
  private readonly busRows: TtlCache<{
    rows: Awaited<ReturnType<BusFeed['arrivals']>>;
    queriedAt: number;
    receivedAt: number;
  }>;
  private readonly busStops: TtlCache<BusStopCandidate[]>;
  lastFailure: FeedError['reason'] | null = null;
  /** A failed key is isolated to its own supplier. */
  private readonly busBlockedUntil = new Map<BusFeed['provider'], number>();
  private readonly sourceStates = new Map<RealtimeProvider, RealtimeSourceDiagnostic>();

  constructor(options: RealtimeOptions = {}) {
    const feed = {
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs ?? 4_000,
    };

    this.subway = new SeoulSubwayFeed(options.seoulOpenApiKey?.trim() ?? '', feed);
    this.seoulBus = new SeoulBusFeed(options.dataGoKrServiceKey, feed);
    this.tagoBus = new TagoBusFeed(options.dataGoKrServiceKey, feed);
    this.now = options.now ?? Date.now;

    const ttl = options.arrivalCacheMs ?? 15_000;

    this.subwayRows = new TtlCache(ttl, this.now);
    this.busRows = new TtlCache(ttl, this.now);
    this.busStops = new TtlCache(10 * 60_000, this.now, 2_000);
  }

  get capabilities(): RealtimeCapabilities {
    return {
      subway: this.subway.configured,
      bus: this.seoulBus.configured || this.tagoBus.configured,
    };
  }

  /** Successful HTTP is availability, not proof that a route has a catchable prediction. */
  get diagnostics(): RealtimeSourceDiagnostic[] {
    return [this.subway, this.seoulBus, this.tagoBus].map((feed, index) => {
      const provider: RealtimeProvider =
        index === 0 ? 'seoul-subway' : index === 1 ? 'seoul-bus' : 'tago-bus';

      return (
        this.sourceStates.get(provider) ?? {
          provider,
          status: feed.configured ? 'configured' : 'unconfigured',
          checkedAt: null,
          reason: null,
        }
      );
    });
  }

  private record(provider: RealtimeProvider, error?: unknown): void {
    const reason =
      error === undefined ? null : error instanceof FeedError ? error.reason : 'network';

    this.sourceStates.set(provider, {
      provider,
      status: reason === null ? 'available' : reason === 'auth' ? 'auth-error' : 'unavailable',
      checkedAt: this.now(),
      reason,
    });
  }

  async lookup(query: BoardingQuery): Promise<BoardingRealtime | null> {
    if (
      !query.stop ||
      !query.lines.length ||
      !Number.isFinite(query.latitude) ||
      !Number.isFinite(query.longitude)
    ) {
      return null;
    }

    try {
      const result =
        query.mode === 'subway' ? await this.subwayLookup(query) : await this.busLookup(query);

      this.lastFailure = null;

      return result;
    } catch (error) {
      this.lastFailure = error instanceof FeedError ? error.reason : 'network';

      return null;
    }
  }

  private async subwayLookup(query: BoardingQuery): Promise<BoardingRealtime | null> {
    if (!this.subway.configured) {
      return null;
    }

    try {
      const cached = await this.subwayRows.get(`subway:${query.stop}`, async () => {
        const rows = await this.subway.stationRows(query.stop, this.now());

        this.record('seoul-subway');

        return {
          rows,
          receivedAt: this.now(),
        };
      });

      const selected = selectSubwayArrivals(cached.rows, query.lines, query.nextStops, this.now());

      if (!selected?.predictions.length) {
        return null;
      }

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

  private async busLookup(query: BoardingQuery): Promise<BoardingRealtime | null> {
    return this.busArrivals(query);
  }

  private async busArrivals(query: BoardingQuery): Promise<BoardingRealtime | null> {
    const feeds: BusFeed[] = inSeoulArea(query) ? [this.seoulBus, this.tagoBus] : [this.tagoBus];
    let failure: unknown;

    for (const feed of feeds) {
      if (!feed.configured) {
        continue;
      }

      if (this.now() < (this.busBlockedUntil.get(feed.provider) ?? 0)) {
        failure ??= new FeedError('auth');
        continue;
      }

      try {
        const point = {
          latitude: query.latitude,
          longitude: query.longitude,
        };

        const stops = await this.busStops.get(
          `${feed.provider}:${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
          async () => {
            const rows = await feed.nearbyStops(point);

            this.record(feed.provider);

            return rows;
          },
        );

        for (const stop of chooseBusStops(stops, query.stop, point)) {
          const cached = await this.busRows.get(
            `${feed.provider}:${stop.cityCode ?? ''}:${stop.id}`,
            async () => {
              // Relative countdowns stay anchored to the original query, never a cache lookup.
              const queriedAt = this.now();

              const rows = await feed.arrivals(stop, queriedAt);

              this.record(feed.provider);

              return {
                rows,
                queriedAt,
                receivedAt: this.now(),
              };
            },
          );

          const selected = selectBusArrivals(
            cached.rows,
            query.lines,
            query.nextStops[0],
            this.now(),
          );

          if (!selected || (!selected.predictions.length && !selected.ended)) {
            continue;
          }

          return {
            provider: feed.provider,
            stopName: stop.name,
            status: selected.ended ? 'no-service' : 'live',
            observedAt: cached.queriedAt,
            receivedAt: cached.receivedAt,
            predictions: selected.predictions,
          };
        }
      } catch (error) {
        this.record(feed.provider, error);

        if (error instanceof FeedError && error.reason === 'auth') {
          this.busBlockedUntil.set(feed.provider, this.now() + 10 * 60_000);
        }

        failure ??= error;
      }
    }

    if (failure) {
      throw failure;
    }

    return null;
  }
}
