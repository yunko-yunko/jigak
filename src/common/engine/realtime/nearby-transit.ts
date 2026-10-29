import type {
  NearbyTransitArrival,
  NearbyTransitGroup,
  NearbyTransitPoint,
  NearbyTransitSnapshot,
  NearbyTransitStop,
} from '../../shared/domain/nearbyTransit.js';
import { NEARBY_TRANSIT_FRESH_MS } from '../../shared/domain/nearbyTransit.js';
import type { NearbyPlace, RouteProvider } from '../kakao.js';
import { SeoulBusFeed, TagoBusFeed, type BusFeed, type BusStopCandidate } from './bus.js';
import { FeedError, type FeedOptions } from './http.js';
import { metersBetween, stationBaseName, subwayLineName } from './names.js';
import { SeoulSubwayFeed } from './seoulSubway.js';

interface NearbyTransitOptions extends FeedOptions {
  dataGoKrServiceKey?: string;
  seoulOpenApiKey?: string;
  provider?: Pick<RouteProvider, 'configured' | 'nearby'>;
  now?: () => number;
}

const BUS_RADIUS = 200,
  SUBWAY_RADIUS = 1200;

const inSeoul = (point: NearbyTransitPoint) =>
  point.latitude >= 37.4 &&
  point.latitude <= 37.72 &&
  point.longitude >= 126.73 &&
  point.longitude <= 127.28;

const validPoint = (point: NearbyTransitPoint) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;

/** Bounded promise cache coalesces riders; failed requests are removed rather than cached as empty. */
class Cache<T> {
  private readonly entries = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<T>;
    }
  >();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now(),
      hit = this.entries.get(key);

    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    this.entries.delete(key);

    if (this.entries.size >= 200) {
      for (const [id, item] of this.entries) {
        if (item.expiresAt <= now) {
          this.entries.delete(id);
        }
      }

      if (this.entries.size >= 200) {
        this.entries.delete(this.entries.keys().next().value!);
      }
    }

    const value = Promise.resolve().then(load);

    this.entries.set(key, {
      expiresAt: now + this.ttlMs,
      value,
    });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
    });

    return value;
  }
}

function emptyGroup(
  source: NearbyTransitGroup['source'],
  radiusMeters: number,
  status: NearbyTransitGroup['status'],
  message: string,
): NearbyTransitGroup {
  return {
    source,
    radiusMeters,
    status,
    observedAt: null,
    message,
    stops: [],
  };
}

function summarize(group: NearbyTransitGroup, stops: NearbyTransitStop[]): NearbyTransitGroup {
  const failures = stops.filter((stop) => stop.status === 'error').length;
  const stamps = stops.flatMap((stop) => (stop.observedAt === null ? [] : [stop.observedAt]));

  return {
    ...group,
    stops,
    status: !stops.length
      ? 'empty'
      : failures === stops.length
        ? 'error'
        : failures
          ? 'partial'
          : 'available',
    observedAt: stamps.length ? Math.min(...stamps) : null,
    message: !stops.length
      ? `반경 ${group.radiusMeters}m 안에서 확인된 ${group.source === 'seoul-subway' ? '지하철역' : '버스 정류장'}이 없어요.`
      : failures
        ? '일부 도착 자료를 확인하지 못했어요. 표시된 정류장과 역에서 다시 확인해 주세요.'
        : group.message,
  };
}

function stopResult(
  place: Pick<
    NearbyTransitStop,
    'id' | 'name' | 'address' | 'latitude' | 'longitude' | 'distanceMeters'
  >,
  arrivals: NearbyTransitArrival[],
  observedAt: number | null,
  now: number,
  status: NearbyTransitStop['status'] = 'available',
): NearbyTransitStop {
  const freshness =
    observedAt === null ? 'unknown' : freshSource(observedAt, now) ? 'fresh' : 'stale';

  return {
    ...place,
    arrivals,
    observedAt,
    freshness,
    status:
      status === 'available'
        ? freshness === 'stale'
          ? 'stale'
          : arrivals.length
            ? 'available'
            : 'empty'
        : status,
  };
}

const freshSource = (observedAt: number, now: number) =>
  Number.isFinite(observedAt) &&
  observedAt <= now + 30_000 &&
  now - observedAt <= NEARBY_TRANSIT_FRESH_MS;

/** Position and arrival feeds are kept separate: a discovered station is never proof of live arrivals. */
export class NearbyTransitService {
  private readonly seoulBus: SeoulBusFeed;
  private readonly tagoBus: TagoBusFeed;
  private readonly subway: SeoulSubwayFeed;
  private readonly now: () => number;
  private readonly busPositions: Cache<BusStopCandidate[]>;
  private readonly stationPositions: Cache<NearbyPlace[]>;
  private readonly busArrivals: Cache<{
    rows: Awaited<ReturnType<BusFeed['arrivals']>>;
    observedAt: number;
  }>;
  private readonly subwayArrivals: Cache<{
    rows: Awaited<ReturnType<SeoulSubwayFeed['stationRows']>>;
    observedAt: number;
  }>;
  private readonly busBlockedUntil = new Map<BusFeed['provider'], number>();
  private subwayBlockedUntil = 0;

  constructor(private readonly options: NearbyTransitOptions = {}) {
    this.now = options.now ?? Date.now;
    this.seoulBus = new SeoulBusFeed(options.dataGoKrServiceKey, options);
    this.tagoBus = new TagoBusFeed(options.dataGoKrServiceKey, options);
    this.subway = new SeoulSubwayFeed(options.seoulOpenApiKey?.trim() ?? '', options);
    this.busPositions = new Cache(this.now, 5 * 60_000);
    this.stationPositions = new Cache(this.now, 5 * 60_000);
    this.busArrivals = new Cache(this.now, 15_000);
    this.subwayArrivals = new Cache(this.now, 15_000);
  }

  async snapshot(point: NearbyTransitPoint): Promise<NearbyTransitSnapshot> {
    if (!validPoint(point)) {
      throw new RangeError('Nearby transit coordinates are invalid');
    }

    const [bus, subway] = await Promise.all([this.nearbyBus(point), this.nearbySubway(point)]);

    return {
      mode: 'live',
      generatedAt: this.now(),
      center: {
        latitude: point.latitude,
        longitude: point.longitude,
      },
      bus,
      subway,
    };
  }

  private async nearbyBus(point: NearbyTransitPoint): Promise<NearbyTransitGroup> {
    const feed: BusFeed = inSeoul(point) ? this.seoulBus : this.tagoBus;
    const group = emptyGroup(
      feed.provider,
      BUS_RADIUS,
      'available',
      `${feed.provider === 'seoul-bus' ? '서울 TOPIS' : '국토교통부 TAGO'} 버스 도착 예측 · 직선거리 200m 이내 최대 4곳`,
    );

    if (!feed.configured) {
      return {
        ...group,
        status: 'unconfigured',
        message: '버스 정류장·도착 정보 연결이 설정되지 않았어요.',
      };
    }

    if (this.now() < (this.busBlockedUntil.get(feed.provider) ?? 0)) {
      return {
        ...group,
        status: 'error',
        message: '버스 정보 공급원의 인증을 확인해야 해요. 잠시 후 다시 시도해 주세요.',
      };
    }

    try {
      const positions = await this.busPositions.get(
        `${feed.provider}:${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
        () => feed.nearbyStops(point),
      );

      const seen = new Set<string>();

      const nearby = positions
        .filter((stop) => validPoint(stop) && stop.id && stop.name)
        .map((stop) => ({
          stop,
          distance: metersBetween(point, stop),
        }))
        .filter(
          ({ stop, distance }) =>
            distance <= BUS_RADIUS && !seen.has(stop.id) && !!seen.add(stop.id),
        )
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 4);

      const stops = await Promise.all(
        nearby.map(async ({ stop, distance }) => {
          const place = {
            id: `${feed.provider}:${stop.id}`,
            name: stop.name,
            address: '',
            latitude: stop.latitude,
            longitude: stop.longitude,
            distanceMeters: Math.round(distance),
          };

          try {
            const cached = await this.busArrivals.get(
              `${feed.provider}:${stop.cityCode ?? ''}:${stop.id}`,
              async () => {
                const observedAt = this.now();

                return {
                  rows: await feed.arrivals(stop, observedAt),
                  observedAt,
                };
              },
            );

            const now = this.now();

            const arrivals: NearbyTransitArrival[] = cached.rows
              .filter((row) => row.arrivesAt === null || row.arrivesAt >= now)
              .sort(
                (a, b) =>
                  Number(a.ended) - Number(b.ended) ||
                  (a.arrivesAt ?? Infinity) - (b.arrivesAt ?? Infinity),
              )
              .slice(0, 12)
              .map((row) => ({
                line: row.route,
                arrivesAt: row.arrivesAt,
                stopsAway: row.stopsAway,
                message: row.message,
                ...(row.nextStop
                  ? {
                      destination: `${row.nextStop} 방면`,
                    }
                  : {}),
                ...(row.lastService
                  ? {
                      lastService: true,
                    }
                  : {}),
                ended: row.ended,
              }));

            return stopResult(place, arrivals, cached.observedAt, now);
          } catch (error) {
            if (error instanceof FeedError && error.reason === 'auth') {
              this.busBlockedUntil.set(feed.provider, this.now() + 60_000);
            }

            return stopResult(place, [], null, this.now(), 'error');
          }
        }),
      );

      return summarize(group, stops);
    } catch (error) {
      if (error instanceof FeedError && error.reason === 'auth') {
        this.busBlockedUntil.set(feed.provider, this.now() + 60_000);
      }

      return {
        ...group,
        status: 'error',
        message: '버스 정류장 자료를 확인하지 못했어요. 연결 상태와 공급원 권한을 확인해 주세요.',
      };
    }
  }

  private async nearbySubway(point: NearbyTransitPoint): Promise<NearbyTransitGroup> {
    const group = emptyGroup(
      'seoul-subway',
      SUBWAY_RADIUS,
      'available',
      '카카오 역 위치 · 서울 열린데이터광장 도착 예측 · 직선거리 1.2km 이내 최대 3역',
    );

    if (!inSeoul(point)) {
      return {
        ...group,
        status: 'uncovered',
        message: '현재 지하철 도착 정보는 서울 실증 범위에서 제공해요.',
      };
    }

    const provider = this.options.provider;

    if (!provider?.configured || !provider.nearby) {
      return {
        ...group,
        status: 'unconfigured',
        message: '주변 지하철역 위치 연결이 설정되지 않았어요.',
      };
    }

    try {
      const positions = await this.stationPositions.get(
        `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`,
        () =>
          provider.nearby!({
            keyword: '지하철역',
            latitude: point.latitude,
            longitude: point.longitude,
            radius: SUBWAY_RADIUS,
          }),
      );

      const seen = new Set<string>();

      const stations = positions
        .flatMap((place) => {
          if (
            !validPoint(place) ||
            !/(?:지하철,전철|지하철역|전철역)(?:\s|>|$)/.test(place.category)
          ) {
            return [];
          }

          const name = place.name.match(/^(.+?역)(?:\s|$)/)?.[1];

          if (!name) {
            return [];
          }

          const distance = metersBetween(point, place),
            key = stationBaseName(name);

          return distance <= SUBWAY_RADIUS
            ? [
                {
                  place,
                  name,
                  distance,
                  key,
                },
              ]
            : [];
        })
        .sort((a, b) => a.distance - b.distance)
        .filter((item) => !seen.has(item.key) && !!seen.add(item.key))
        .slice(0, 3);

      const stops = await Promise.all(
        stations.map(async ({ place, name, distance, key }) => {
          const station = {
            id: `kakao-subway:${place.id}`,
            name,
            address: place.address,
            latitude: place.latitude,
            longitude: place.longitude,
            distanceMeters: Math.round(distance),
          };

          if (!this.subway.configured) {
            return stopResult(station, [], null, this.now(), 'unconfigured');
          }

          if (this.now() < this.subwayBlockedUntil) {
            return stopResult(station, [], null, this.now(), 'error');
          }

          try {
            const cached = await this.subwayArrivals.get(key, async () => {
              const observedAt = this.now();

              return {
                rows: await this.subway.stationRows(name, observedAt),
                observedAt,
              };
            });

            const now = this.now(),
              seenTrains = new Set<string>();
            const upcoming = cached.rows.filter((row) => row.arrivesAt >= now);
            const fresh = upcoming.filter((row) => freshSource(row.observedAt, now));

            // Old observations remain visibly stale when no current rows exist;
            // they cannot age an independently current row or borrow receipt time.
            const rows = (fresh.length ? fresh : upcoming)
              .sort((a, b) => a.arrivesAt - b.arrivesAt)
              .filter((row) => {
                const id = `${row.lineId}:${row.trainNo || `${row.towards}:${row.arrivesAt}`}`;

                if (seenTrains.has(id)) {
                  return false;
                }

                seenTrains.add(id);

                return true;
              })
              .slice(0, 12);

            const sourceRows = rows.length ? rows : cached.rows;
            const observedAt = sourceRows.length
              ? Math.min(...sourceRows.map((row) => row.observedAt))
              : null;

            const arrivals: NearbyTransitArrival[] = rows.map((row) => ({
              line: subwayLineName(row.lineId) ?? `지하철 ${row.lineId}`,
              arrivesAt: row.arrivesAt,
              stopsAway: row.stopsAway,
              message: row.message,
              destination: [
                row.terminus ? `${row.terminus}행` : '',
                row.towards ? `${row.towards} 방면` : '',
              ]
                .filter(Boolean)
                .join(' · '),
              ...(row.lastService
                ? {
                    lastService: true,
                  }
                : {}),
              ended: false,
            }));

            return stopResult(station, arrivals, observedAt, now);
          } catch (error) {
            if (error instanceof FeedError && error.reason === 'auth') {
              this.subwayBlockedUntil = this.now() + 60_000;
            }

            return stopResult(station, [], null, this.now(), 'error');
          }
        }),
      );

      const result = summarize(group, stops);

      if (stops.length && !this.subway.configured) {
        return {
          ...result,
          status: 'unconfigured',
          message: '역 위치는 확인했지만 서울 실시간 도착 정보 연결이 설정되지 않았어요.',
        };
      }

      return result;
    } catch {
      return {
        ...group,
        status: 'error',
        message: '주변 지하철역 자료를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.',
      };
    }
  }
}
