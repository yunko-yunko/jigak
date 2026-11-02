import {
  asArray,
  decodeServiceKey,
  FeedError,
  fetchFeedJson,
  finiteNumber,
  text,
  type FeedOptions,
} from './http.js';
import { metersBetween } from './names.js';
import type {
  MobilityKind,
  MobilityMarker,
  MobilitySnapshot,
  MobilitySourceStatus,
} from '../../shared/intelligence/types.js';
import { GbfsVehicleFeed, type GbfsFeedConfiguration } from '../intelligence/gbfs.js';
import type { MeasuredBicycleRides } from './bicycle-ride-times.js';
import type { SpatialBicycleRideService } from '../intelligence/spatial-bicycle-ride.js';
import { SIMULATION_NOTICE } from '../simulation/shared-scooter-sim.js';

type Point = { latitude: number; longitude: number };
/** A shared e-scooter reported by TAGO. Battery/position do not guarantee unlock availability. */
export interface SharedScooter {
  id: string;
  provider: string;
  latitude: number;
  longitude: number;
  battery: number | null;
  distanceMeters: number;
  observedAt?: number | null;
  receivedAt?: number;
  /** A demo-simulator vehicle, never a real operator's device. */
  simulated?: true;
}
/** A public-bike station with its live stock. */
export interface BikeStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  bikes: number;
  racks: number;
  distanceMeters: number;
  observedAt?: number | null;
  receivedAt?: number;
}

/** Operator codes as TAGO reports them, in the names riders know. */
const SCOOTER_BRANDS: Record<string, string> = {
  GBIKE: '지쿠',
  ALPACA: '알파카',
  SWING: '스윙',
  XINGXING: '씽씽',
  KICKGOING: '킥고잉',
  BEAM: '빔',
  DEER: '디어',
  DART: '다트',
};
export const scooterBrand = (provider: string) =>
  SCOOTER_BRANDS[provider.toUpperCase()] ?? provider;
/** Below this the scooter may not finish a first- or last-mile ride. */
const MIN_BATTERY = 20;

class Cached<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly fallback: T,
    private readonly retryMs = 30_000,
  ) {}
  /** A failed load yields the fallback and is retried after `retryMs`, not on every search. */
  get(key: string, load: () => Promise<T>, onError?: (error: unknown) => void): Promise<T> {
    const time = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > time) return hit.value;
    const value = load().catch((error) => {
      onError?.(error);
      const entry = this.entries.get(key);
      if (entry?.value === value) entry.expiresAt = this.now() + this.retryMs;
      return this.fallback;
    });
    this.entries.set(key, { expiresAt: time + this.ttlMs, value });
    return value;
  }
}

interface Fleet {
  provider: string;
  cityCode: string;
  cityName: string;
}
interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * 국토교통부 TAGO 공유 퍼스널모빌리티정보: every operator's parked scooters with battery and
 * position, per city. Only cities whose operators report to TAGO are covered; elsewhere
 * `nearest` finds nothing and no scooter leg is offered.
 */
export class SharedScooterFeed {
  private static readonly BASE = 'https://apis.data.go.kr/1613000/PersonalMobilityInfo';
  private readonly key: string;
  private readonly feed: FeedOptions;
  private readonly now: () => number;
  private readonly fleets: Cached<Fleet[]>;
  private readonly devices: Cached<Omit<SharedScooter, 'distanceMeters'>[]>;
  /** Where each fleet's scooters were last seen, so searches elsewhere cost no calls. */
  private readonly coverage = new Map<string, Box>();
  private readonly failures = new Map<string, FeedError['reason']>();
  get lastFailure(): FeedError['reason'] | null {
    return this.failures.values().next().value ?? null;
  }

  constructor(key: string | undefined, options: FeedOptions & { now?: () => number } = {}) {
    this.key = decodeServiceKey(key);
    this.feed = { fetcher: options.fetcher, timeoutMs: options.timeoutMs ?? 5_000 };
    this.now = options.now ?? Date.now;
    this.fleets = new Cached<Fleet[]>(6 * 3_600_000, this.now, [], 60_000);
    this.devices = new Cached<Omit<SharedScooter, 'distanceMeters'>[]>(45_000, this.now, []);
  }

  get configured(): boolean {
    return !!this.key;
  }

  private async call(
    operation: string,
    params: Record<string, string>,
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const url = new URL(`${SharedScooterFeed.BASE}/${operation}`);
    url.search = new URLSearchParams({
      serviceKey: this.key,
      _type: 'json',
      pageNo: '1',
      numOfRows: '3000',
      ...params,
    }).toString();
    const payload = (await fetchFeedJson(url, this.feed)) as {
      response?: {
        header?: { resultCode?: unknown };
        body?: { items?: { item?: unknown } | ''; totalCount?: unknown };
      };
      header?: { resultCode?: unknown };
    };
    const code = text(payload.response?.header?.resultCode ?? payload.header?.resultCode);
    if (code === '30' || code === '31' || code === '20' || code === '22')
      throw new FeedError('auth');
    if (code !== '00' || !payload.response?.body) throw new FeedError('format');
    const items = payload.response.body.items;
    return {
      items: asArray<Record<string, unknown>>(items ? items.item : []),
      total: finiteNumber(payload.response.body.totalCount) ?? 0,
    };
  }

  private fleetList(): Promise<Fleet[]> {
    return this.fleets.get(
      'all',
      async () => {
        const { items } = await this.call('GetPMProvider', { numOfRows: '500' });
        this.failures.delete('@fleets');
        // Provider coverage can expand. Rediscover device bounds when the six-hour list refreshes.
        this.coverage.clear();
        return items
          .map((item) => ({
            provider: text(item.providername),
            cityCode: text(item.citycode),
            cityName: text(item.cityname),
          }))
          .filter((fleet) => fleet.provider && fleet.cityCode);
      },
      (error) => {
        this.failures.set('@fleets', error instanceof FeedError ? error.reason : 'network');
      },
    );
  }

  private fleetDevices(fleet: Fleet): Promise<Omit<SharedScooter, 'distanceMeters'>[]> {
    const key = `${fleet.provider}:${fleet.cityCode}`;
    return this.devices.get(
      key,
      async () => {
        const first = await this.call('GetPMListByProvider', {
          providerName: fleet.provider,
          cityCode: fleet.cityCode,
        });
        if (first.total > 30_000) throw new FeedError('format');
        const pages =
          first.total > 3_000
            ? await Promise.all(
                Array.from({ length: Math.ceil(first.total / 3_000) - 1 }, (_, index) =>
                  this.call('GetPMListByProvider', {
                    providerName: fleet.provider,
                    cityCode: fleet.cityCode,
                    pageNo: String(index + 2),
                  }),
                ),
              )
            : [];
        const receivedAt = this.now();
        const scooters = [first, ...pages]
          .flatMap((page) => page.items)
          .flatMap((item) => {
            const latitude = finiteNumber(item.latitude),
              longitude = finiteNumber(item.longitude),
              id = text(item.vehicleid);
            if (
              latitude === null ||
              longitude === null ||
              !id ||
              latitude < 33 ||
              latitude > 39 ||
              longitude < 124 ||
              longitude > 132
            )
              return [];
            const rawBattery = finiteNumber(item.battery);
            const battery =
              rawBattery !== null && rawBattery >= 0 && rawBattery <= 100 ? rawBattery : null;
            return [
              {
                id,
                provider: fleet.provider,
                latitude,
                longitude,
                battery,
                observedAt: null,
                receivedAt,
              },
            ];
          });
        if (scooters.length)
          this.coverage.set(
            key,
            scooters.reduce<Box>(
              (box, scooter) => ({
                west: Math.min(box.west, scooter.longitude),
                south: Math.min(box.south, scooter.latitude),
                east: Math.max(box.east, scooter.longitude),
                north: Math.max(box.north, scooter.latitude),
              }),
              { west: 180, south: 90, east: -180, north: -90 },
            ),
          );
        this.failures.delete(key);
        return scooters;
      },
      (error) => {
        this.failures.set(key, error instanceof FeedError ? error.reason : 'network');
      },
    );
  }

  covered(point: Point): boolean {
    return [...this.coverage.values()].some(
      (box) =>
        point.longitude >= box.west - 0.02 &&
        point.longitude <= box.east + 0.02 &&
        point.latitude >= box.south - 0.02 &&
        point.latitude <= box.north + 0.02,
    );
  }

  /** The closest charged scooter within `radiusMeters`, or null when none is reported there. */
  async nearest(point: Point, radiusMeters: number): Promise<SharedScooter | null> {
    return (await this.near(point, radiusMeters)).scooter;
  }

  /**
   * `covered` tells whether any operator reports positions around this point at all: a covered
   * place with no scooter means there is none to ride, an uncovered one means nobody can say.
   */
  async near(
    point: Point,
    radiusMeters: number,
  ): Promise<{ covered: boolean; scooter: SharedScooter | null }> {
    if (!this.configured) return { covered: false, scooter: null };
    const margin = 0.02;
    const inside = (box: Box | undefined) =>
      !!box &&
      point.longitude >= box.west - margin &&
      point.longitude <= box.east + margin &&
      point.latitude >= box.south - margin &&
      point.latitude <= box.north + margin;
    const key = (fleet: Fleet) => `${fleet.provider}:${fleet.cityCode}`;
    const all = await this.fleetList();
    // A fleet whose area is not known yet is read once; after that, searches elsewhere cost no calls.
    const fleets = all.filter(
      (fleet) => !this.coverage.has(key(fleet)) || inside(this.coverage.get(key(fleet))),
    );
    const rows = await Promise.all(fleets.map((fleet) => this.fleetDevices(fleet)));
    const vehicles = rows
      .flatMap((scooters) =>
        scooters.flatMap((scooter) => {
          const distanceMeters = metersBetween(point, scooter);
          return distanceMeters <= radiusMeters ? [{ ...scooter, distanceMeters }] : [];
        }),
      )
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
    const scooter =
      vehicles.find((item) => item.battery === null || item.battery >= MIN_BATTERY) ?? null;
    return { covered: all.some((fleet) => inside(this.coverage.get(key(fleet)))), scooter };
  }

  /** Every reported device near the map center, including low batteries shown as unavailable. */
  async nearby(point: Point, radiusMeters: number): Promise<SharedScooter[]> {
    if (!this.configured) return [];
    const all = await this.fleetList();
    const margin = radiusMeters / 80_000 + 0.02;
    const fleets = all.filter((fleet) => {
      const box = this.coverage.get(`${fleet.provider}:${fleet.cityCode}`);
      return (
        !box ||
        (point.longitude >= box.west - margin &&
          point.longitude <= box.east + margin &&
          point.latitude >= box.south - margin &&
          point.latitude <= box.north + margin)
      );
    });
    const rows = await Promise.all(fleets.map((fleet) => this.fleetDevices(fleet)));
    const unique = new Map<string, SharedScooter>();
    for (const item of rows.flat()) {
      const distanceMeters = metersBetween(point, item);
      if (distanceMeters <= radiusMeters)
        unique.set(`${item.provider}:${item.id}`, { ...item, distanceMeters });
    }
    return [...unique.values()].sort((a, b) => a.distanceMeters - b.distanceMeters);
  }
}

const SEOUL = { south: 37.41, north: 37.72, west: 126.76, east: 127.19 };

/** 서울시 공공자전거 실시간 대여정보: every 따릉이 station with the bikes parked there now. */
export class SeoulBikeFeed {
  private readonly key: string;
  private readonly feed: FeedOptions;
  private readonly all: Cached<Omit<BikeStation, 'distanceMeters'>[]>;
  private readonly now: () => number;
  lastFailure: FeedError['reason'] | null = null;

  constructor(key: string | undefined, options: FeedOptions & { now?: () => number } = {}) {
    this.key = key?.trim() ?? '';
    this.feed = { fetcher: options.fetcher, timeoutMs: options.timeoutMs ?? 5_000 };
    this.now = options.now ?? Date.now;
    this.all = new Cached<Omit<BikeStation, 'distanceMeters'>[]>(60_000, this.now, []);
  }

  get configured(): boolean {
    return !!this.key;
  }

  private async page(
    from: number,
  ): Promise<{ rows: Omit<BikeStation, 'distanceMeters'>[]; total: number }> {
    const url = new URL(
      `http://openapi.seoul.go.kr:8088/${encodeURIComponent(this.key)}/json/bikeList/${from}/${from + 999}/`,
    );
    const payload = (await fetchFeedJson(url, this.feed)) as {
      rentBikeStatus?: { list_total_count?: unknown; RESULT?: { CODE?: unknown }; row?: unknown };
      RESULT?: { CODE?: unknown };
      CODE?: unknown;
    };
    const status = payload.rentBikeStatus;
    const code = text(status?.RESULT?.CODE ?? payload.RESULT?.CODE ?? payload.CODE);
    if (code === 'INFO-100') throw new FeedError('auth');
    // INFO-200: no rows in this page range, which simply ends the list.
    if (!status || (code && code !== 'INFO-000')) {
      if (code === 'INFO-200') return { rows: [], total: 0 };
      throw new FeedError('format');
    }
    const rows = asArray<Record<string, unknown>>(status.row).flatMap((row) => {
      const latitude = finiteNumber(row.stationLatitude),
        longitude = finiteNumber(row.stationLongitude),
        id = text(row.stationId);
      if (
        latitude === null ||
        longitude === null ||
        !id ||
        latitude < SEOUL.south ||
        latitude > SEOUL.north ||
        longitude < SEOUL.west ||
        longitude > SEOUL.east
      )
        return [];
      // Missing or malformed inventory is unknown, never evidence of depletion.
      const bikes = finiteNumber(row.parkingBikeTotCnt);
      if (bikes === null || !Number.isSafeInteger(bikes) || bikes < 0) return [];
      return [
        {
          id,
          name: text(row.stationName).replace(/^\d+\.\s*/, ''),
          latitude,
          longitude,
          bikes,
          racks: Math.max(0, finiteNumber(row.rackTotCnt) ?? 0),
          observedAt: null,
          receivedAt: this.now(),
        },
      ];
    });
    return { rows, total: finiteNumber(status.list_total_count) ?? rows.length };
  }

  private stations(): Promise<Omit<BikeStation, 'distanceMeters'>[]> {
    return this.all.get(
      'all',
      async () => {
        // The list holds about 2,800 stations and is served 1,000 rows at a time.
        const pages = await Promise.all([1, 1_001, 2_001].map((from) => this.page(from)));
        const total = Math.max(...pages.map((page) => page.total));
        if (total > 20_000) throw new FeedError('format');
        const more =
          total > 3_000
            ? await Promise.all(
                Array.from({ length: Math.ceil((total - 3_000) / 1_000) }, (_, index) =>
                  this.page(3_001 + index * 1_000),
                ),
              )
            : [];
        this.lastFailure = null;
        return [...pages, ...more].flatMap((page) => page.rows);
      },
      (error) => {
        this.lastFailure = error instanceof FeedError ? error.reason : 'network';
      },
    );
  }

  /** Nearest station within `radiusMeters`: one with a bike to hire, or any station to return to. */
  async nearest(
    point: Point,
    radiusMeters: number,
    need: 'bike' | 'return',
  ): Promise<BikeStation | null> {
    if (
      !this.configured ||
      point.latitude < SEOUL.south ||
      point.latitude > SEOUL.north ||
      point.longitude < SEOUL.west ||
      point.longitude > SEOUL.east
    )
      return null;
    let best: BikeStation | null = null;
    for (const station of await this.nearby(point, radiusMeters)) {
      if (need === 'bike' && station.bikes < 1) continue;
      const distanceMeters = metersBetween(point, station);
      if (distanceMeters <= radiusMeters && (!best || distanceMeters < best.distanceMeters))
        best = { ...station, distanceMeters };
    }
    return best;
  }

  /** Station markers keep the station count and never synthesize individual bicycle coordinates. */
  async nearby(point: Point, radiusMeters: number): Promise<BikeStation[]> {
    if (
      !this.configured ||
      point.latitude < SEOUL.south ||
      point.latitude > SEOUL.north ||
      point.longitude < SEOUL.west ||
      point.longitude > SEOUL.east
    )
      return [];
    return (await this.stations())
      .flatMap((station) => {
        const distanceMeters = metersBetween(point, station);
        return distanceMeters <= radiusMeters ? [{ ...station, distanceMeters }] : [];
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }
}

/** What MobilityFeeds and the dockless bridges read from a GBFS-shaped vehicle source. */
export interface VehicleFeed {
  readonly provider: string;
  readonly lastFailure: FeedError['reason'] | null;
  /** Demo-simulator feeds carry no 따릉이 and are labelled as simulated everywhere. */
  readonly simulated?: boolean;
  /**
   * Marker kinds the feed carries. Undeclared: an operator feed may carry anything, and a
   * simulated feed carries kick-scooters only, as before e-bikes.
   */
  readonly kinds?: readonly MobilityKind[];
  /** The feed's own line in the map's source list; a simulated feed without one gets the scooter notice. */
  readonly notice?: string;
  /** True while a simulated feed is still computing its day: the map says so instead of "none". */
  readonly pending?: boolean;
  nearby(point: Point, radiusMeters: number, options?: VehicleFeedQuery): Promise<MobilityMarker[]>;
}
/** What a caller wants of a feed's answer; a feed that cannot narrow it answers whole. */
export interface VehicleFeedQuery {
  /** Only markers of this kind. */
  kind?: MobilityKind;
  /** At most this many markers of each kind, nearest first. */
  perKind?: number;
  /**
   * Output: a feed that can count fills in how many vehicles of each of its kinds are in the radius
   * before `perKind` cuts them. A feed that leaves it empty is counted by its markers.
   */
  totals?: Partial<Record<MobilityKind, number>>;
}
const carries = (feed: VehicleFeed, kind: MobilityKind) =>
  feed.kinds ? feed.kinds.includes(kind) : !feed.simulated || kind === 'kick-scooter';
/**
 * The map shows this many markers unless the app asks for another `limit`. A marker is about 420
 * bytes of JSON (measured), so 1,000 are about 420 KB plain and about 31 KB gzip; older apps accept
 * at most 1,000 markers, so this default must not grow past that.
 */
export const MAX_SNAPSHOT_MARKERS = 1_000;
/** The largest `limit` an app may ask for: 2,500 markers are about 1 MB plain, 80 KB gzip (가정값). */
export const MAX_SNAPSHOT_LIMIT = 2_500;
/** No source and kind puts more than this many markers on the map. */
export const MAX_MARKERS_PER_GROUP = 1_500;
/** Each group keeps at least this share of the limit (or all it has), so a rare kind still shows (가정값). */
const GROUP_FLOOR_SHARE = 0.05;
/**
 * The nearest `limit` markers, shared out by how many each source and kind really has in the
 * radius (`totals[i]`, at least the group's own length): 따릉이 stations come whole, then every
 * vehicle group keeps a floor of `min(size, 5 % of limit)` and the rest of the budget goes in
 * proportion to the true counts (largest remainder). A group that cannot use its share passes it
 * to the group with the nearest next marker. None takes more than `perGroup`; the result stays
 * ordered by distance, nearest first within each group.
 */
export function proportionalNearestMarkers(
  groups: readonly (readonly MobilityMarker[])[],
  totals: readonly number[] = [],
  limit = MAX_SNAPSHOT_MARKERS,
  perGroup = MAX_MARKERS_PER_GROUP,
): MobilityMarker[] {
  const sorted = groups.map((group) =>
    [...group].sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, perGroup),
  );
  const size = sorted.reduce((sum, group) => sum + group.length, 0);
  if (size <= limit) return sorted.flat().sort((a, b) => a.distanceMeters - b.distanceMeters);
  const take = sorted.map(() => 0);
  let budget = limit;
  const vehicles: number[] = [];
  sorted.forEach((group, index) => {
    if (!group.length) return;
    if (group[0].entity === 'station') {
      take[index] = Math.min(group.length, budget);
      budget -= take[index];
    } else vehicles.push(index);
  });
  if (vehicles.length && budget > 0) {
    const floor = Math.min(
      Math.floor(limit * GROUP_FLOOR_SHARE),
      Math.floor(budget / vehicles.length),
    );
    const weight = vehicles.map((index) => Math.max(totals[index] ?? 0, sorted[index].length));
    const weightSum = weight.reduce((sum, value) => sum + value, 0);
    const share = budget;
    for (const index of vehicles) take[index] = Math.min(sorted[index].length, floor);
    budget -= vehicles.reduce((sum, index) => sum + take[index], 0);
    // What each group should hold by its true count, beyond the floor it already has.
    const want = vehicles.map((index, slot) =>
      Math.max(0, Math.min(sorted[index].length, (share * weight[slot]) / weightSum) - take[index]),
    );
    const wanted = want.reduce((sum, value) => sum + value, 0);
    const scale = wanted > budget ? budget / wanted : 1;
    const exact = want.map((value) => value * scale);
    vehicles.forEach((index, slot) => {
      const whole = Math.floor(exact[slot]);
      take[index] += whole;
      budget -= whole;
    });
    const byRemainder = vehicles
      .map((index, slot) => ({ index, remainder: exact[slot] - Math.floor(exact[slot]) }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of byRemainder) {
      if (budget <= 0) break;
      if (take[index] < sorted[index].length) {
        take[index]++;
        budget--;
      }
    }
    // Shares a group could not use go to whichever group has the nearest marker left.
    while (budget > 0) {
      let next = -1;
      for (const index of vehicles)
        if (
          take[index] < sorted[index].length &&
          (next < 0 ||
            sorted[index][take[index]].distanceMeters < sorted[next][take[next]].distanceMeters)
        )
          next = index;
      if (next < 0) break;
      take[next]++;
      budget--;
    }
  }
  return sorted
    .flatMap((group, index) => group.slice(0, take[index]))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** Kept for callers of the old name; the same as `proportionalNearestMarkers` with no true counts. */
export function fairNearestMarkers(
  groups: readonly (readonly MobilityMarker[])[],
  limit = MAX_SNAPSHOT_MARKERS,
  perGroup = MAX_MARKERS_PER_GROUP,
): MobilityMarker[] {
  return proportionalNearestMarkers(groups, [], limit, perGroup);
}

/** Rider-facing nouns of each kind, for the "반경 안 총 N대" line. */
const KIND_NOUNS: Readonly<Record<MobilityKind, string>> = {
  bicycle: '자전거',
  'e-bicycle': '전기자전거',
  'kick-scooter': '킥보드',
  'motor-scooter': '스쿠터',
};
const count = (value: number) => value.toLocaleString('ko-KR');

/** How many markers of each kind a snapshot may carry and which kinds it reads. */
export interface MobilitySnapshotQuery {
  /** At most this many markers in all (1..2,500); 1,000 when omitted, which older apps accept. */
  limit?: number;
  /** Only these kinds; every kind when omitted. */
  kinds?: readonly MobilityKind[];
}

export interface MobilityOptions extends FeedOptions {
  /** 공공데이터포털 인증키: 국토교통부 TAGO 공유 퍼스널모빌리티정보. */
  tagoPmServiceKey?: string;
  /** 서울 열린데이터광장 일반 인증키: 공공자전거 실시간 대여정보. */
  seoulBikeKey?: string;
  /** Operator-authorized public GBFS endpoints, configured by the server operator. */
  gbfs?: GbfsFeedConfiguration[];
  /** Further vehicle sources read like GBFS feeds, such as the demo scooter simulator. */
  vehicleFeeds?: VehicleFeed[];
  /** Dock-to-dock ride times measured on past 따릉이 rentals. */
  bikeRides?: MeasuredBicycleRides | null;
  /** Learned dock-to-dock ride time for pairs the measured table does not cover. */
  bikeModel?: SpatialBicycleRideService | null;
  now?: () => number;
}

/** Live availability of the vehicles a rider must find before riding: shared scooters and 따릉이. */
export class MobilityFeeds {
  readonly scooters: SharedScooterFeed;
  readonly bikes: SeoulBikeFeed;
  readonly gbfs: VehicleFeed[];
  readonly bikeRides: MeasuredBicycleRides | null;
  readonly bikeModel: SpatialBicycleRideService | null;
  private readonly now: () => number;
  constructor(options: MobilityOptions = {}) {
    this.now = options.now ?? Date.now;
    this.bikeRides = options.bikeRides ?? null;
    this.bikeModel = options.bikeModel ?? null;
    const feed = { fetcher: options.fetcher, timeoutMs: options.timeoutMs, now: options.now };
    this.scooters = new SharedScooterFeed(options.tagoPmServiceKey, feed);
    this.bikes = new SeoulBikeFeed(options.seoulBikeKey, feed);
    this.gbfs = [
      ...(options.gbfs ?? []).map((configuration) => new GbfsVehicleFeed(configuration, feed)),
      ...(options.vehicleFeeds ?? []),
    ];
  }
  get capabilities(): { sharedScooter: boolean; sharedBicycle: boolean; sharedEbike: boolean } {
    return {
      sharedScooter:
        this.scooters.configured || this.gbfs.some((feed) => carries(feed, 'kick-scooter')),
      sharedBicycle: this.bikes.configured || this.gbfs.some((feed) => !feed.simulated),
      // Only a feed that declares e-bikes counts; an operator's undeclared feed has no e-bike policy anyway.
      sharedEbike: this.gbfs.some((feed) => !!feed.kinds?.includes('e-bicycle')),
    };
  }

  /**
   * A bounded, current map inventory with the true count of each kind in the radius (`totals`).
   * Key presence is not a claim of local coverage.
   */
  async snapshot(
    point: Point,
    radiusMeters = 1_000,
    query: MobilitySnapshotQuery = {},
  ): Promise<MobilitySnapshot> {
    const limit = query.limit ?? MAX_SNAPSHOT_MARKERS;
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180 ||
      !Number.isFinite(radiusMeters) ||
      radiusMeters < 1 ||
      radiusMeters > 5_000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_SNAPSHOT_LIMIT
    )
      throw new RangeError('Invalid mobility map bounds');
    const wanted = (kind: MobilityKind) => !query.kinds || query.kinds.includes(kind);
    const perKind = Math.min(limit, MAX_MARKERS_PER_GROUP);
    const feedTotals = this.gbfs.map((): Partial<Record<MobilityKind, number>> => ({}));
    const [stations, vehicles, ...gbfs] = await Promise.all([
      this.bikes.nearby(point, radiusMeters),
      this.scooters.nearby(point, radiusMeters),
      ...this.gbfs.map((feed, index) =>
        feed.nearby(point, radiusMeters, { perKind, totals: feedTotals[index] }),
      ),
    ]);
    const now = this.now();
    const stationMarkers: MobilityMarker[] = [
      ...stations.map((station) => ({
        id: `seoul-bike:${station.id}`,
        sourceId: station.id,
        provider: '따릉이',
        kind: 'bicycle' as const,
        entity: 'station' as const,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        distanceMeters: Math.round(station.distanceMeters),
        available: station.bikes > 0,
        availableCount: station.bikes,
        batteryPercent: null,
        observedAt: null,
        receivedAt: station.receivedAt ?? now,
        freshness: 'unknown' as const,
        source: 'seoul-bike' as const,
        returnPolicy: 'station' as const,
      })),
    ];
    const tagoMarkers: MobilityMarker[] = [
      ...vehicles.map((vehicle) => ({
        id: `tago-pm:${vehicle.provider}:${vehicle.id}`,
        sourceId: vehicle.id,
        provider: scooterBrand(vehicle.provider),
        kind: 'kick-scooter' as const,
        entity: 'vehicle' as const,
        name: `${scooterBrand(vehicle.provider)} 킥보드`,
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        distanceMeters: Math.round(vehicle.distanceMeters),
        available: vehicle.battery !== null && vehicle.battery >= MIN_BATTERY,
        availableCount: vehicle.battery !== null && vehicle.battery >= MIN_BATTERY ? 1 : 0,
        batteryPercent:
          vehicle.battery === null ? null : Math.max(0, Math.min(100, vehicle.battery)),
        observedAt: vehicle.observedAt ?? null,
        receivedAt: vehicle.receivedAt ?? now,
        freshness: 'unknown' as const,
        source: 'tago-pm' as const,
        returnPolicy: 'unverified' as const,
      })),
    ];
    // One group per source and kind, each with its true count in the radius; a source that is
    // not configured counts nothing.
    const groups: { feed: number; kind: MobilityKind; markers: MobilityMarker[]; total: number }[] =
      [];
    if (wanted('bicycle') && (this.bikes.configured || stations.length))
      groups.push({ feed: -1, kind: 'bicycle', markers: stationMarkers, total: stations.length });
    if (wanted('kick-scooter') && (this.scooters.configured || vehicles.length))
      groups.push({ feed: -1, kind: 'kick-scooter', markers: tagoMarkers, total: vehicles.length });
    gbfs.forEach((markers, feed) => {
      const kinds = new Map<MobilityKind, MobilityMarker[]>();
      for (const kind of Object.keys(feedTotals[feed]) as MobilityKind[]) kinds.set(kind, []);
      for (const marker of markers) {
        const list = kinds.get(marker.kind);
        if (list) list.push(marker);
        else kinds.set(marker.kind, [marker]);
      }
      for (const [kind, list] of kinds)
        if (wanted(kind))
          groups.push({
            feed,
            kind,
            markers: list,
            total: Math.max(feedTotals[feed][kind] ?? 0, list.length),
          });
    });
    const markers = proportionalNearestMarkers(
      groups.map((group) => group.markers),
      groups.map((group) => group.total),
      limit,
    );
    const totals: Partial<Record<MobilityKind, number>> = {};
    for (const group of groups) totals[group.kind] = (totals[group.kind] ?? 0) + group.total;
    const shown = new Set(markers);
    const shownOf = (list: readonly MobilityMarker[]) =>
      list.reduce((sum, marker) => sum + (shown.has(marker) ? 1 : 0), 0);
    const sources: MobilitySourceStatus[] = [
      {
        source: 'seoul-bike',
        configured: this.bikes.configured,
        status: !this.bikes.configured
          ? 'unconfigured'
          : this.bikes.lastFailure
            ? 'error'
            : stations.length
              ? 'available'
              : point.latitude < SEOUL.south ||
                  point.latitude > SEOUL.north ||
                  point.longitude < SEOUL.west ||
                  point.longitude > SEOUL.east
                ? 'uncovered'
                : 'empty',
        message:
          '따릉이는 대여소 위치와 대여 가능 대수이며 개별 자전거 좌표가 아닙니다. 원본 측정시각은 제공되지 않습니다.',
      },
      {
        source: 'tago-pm',
        configured: this.scooters.configured,
        status: !this.scooters.configured
          ? 'unconfigured'
          : this.scooters.lastFailure
            ? 'error'
            : vehicles.length
              ? 'available'
              : this.scooters.covered(point)
                ? 'empty'
                : 'uncovered',
        message:
          'TAGO 참여 운영사가 공개한 개별 킥보드 위치입니다. 미표시는 기기가 없다는 뜻이 아니며 배차·반납 가능 여부는 운영사에서 확인해야 합니다.',
      },
      ...this.gbfs.map((feed, index) => {
        const notice = feed.notice
          ? feed.notice
          : feed.simulated
            ? `${SIMULATION_NOTICE} · 따릉이 이용 패턴으로 움직이는 가상 킥보드예요. 실제 운영사 기기가 아니에요.`
            : `${feed.provider} 공식 GBFS 공개 위치 · 반납 가능 구역은 운영사 앱에서 확인하세요.`;
        return {
          source: 'gbfs' as const,
          configured: true,
          status: feed.lastFailure
            ? ('error' as const)
            : gbfs[index].length
              ? ('available' as const)
              : ('empty' as const),
          message:
            feed.pending && !gbfs[index].length
              ? `${notice} 지금 가상 기기 위치를 계산하고 있어요. 잠시 뒤 다시 보여요.`
              : notice,
        };
      }),
    ];
    // Only a row whose markers were cut says so, with its own numbers.
    const stationGroup = groups.find((group) => group.feed < 0 && group.kind === 'bicycle');
    if (stationGroup && shownOf(stationGroup.markers) < stationGroup.total)
      sources[0].message += ` 반경 안 대여소 ${count(stationGroup.total)}곳 중 가까운 ${count(shownOf(stationGroup.markers))}곳만 보여요.`;
    const tagoGroup = groups.find((group) => group.feed < 0 && group.kind === 'kick-scooter');
    if (tagoGroup && shownOf(tagoGroup.markers) < tagoGroup.total)
      sources[1].message += ` 반경 안 킥보드 총 ${count(tagoGroup.total)}대 중 가까운 ${count(shownOf(tagoGroup.markers))}대만 지도에 보여요.`;
    this.gbfs.forEach((_, feed) => {
      const own = groups.filter((group) => group.feed === feed);
      const total = own.reduce((sum, group) => sum + group.total, 0);
      const visible = own.reduce((sum, group) => sum + shownOf(group.markers), 0);
      if (visible >= total) return;
      const parts = own.map((group) => `${KIND_NOUNS[group.kind]} ${count(group.total)}대`);
      sources[2 + feed].message +=
        ` 반경 안 총 ${count(total)}대${parts.length > 1 ? `(${parts.join('·')})` : ''} 중 가까운 ${count(visible)}대만 지도에 보여요.`;
    });
    return {
      markers,
      sources,
      generatedAt: now,
      radiusMeters,
      completeCoverage: false,
      totals,
    };
  }
}
