import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import {
  asArray,
  decodeServiceKey,
  FeedError,
  fetchFeedJson,
  finiteNumber,
  text,
  type FeedOptions,
} from './http.js';

export type WeatherConditions = WeatherSnapshot;

type Point = {
  latitude: number;
  longitude: number;
};

/** One grid cell's observation, shared by every request in that cell; each response adds only its requester's coordinates. */
type GridWeather = Omit<WeatherSnapshot, 'latitude' | 'longitude'>;

function located({ source, status, ...observation }: GridWeather, point: Point): WeatherSnapshot {
  return {
    source,
    status,
    latitude: point.latitude,
    longitude: point.longitude,
    ...observation,
  };
}

/** KMA DFS Lambert conformal conic grid, 5 km (standard parallels 30°/60°, origin 126°/38°). */
export function kmaGrid(point: Point): {
  x: number;
  y: number;
} {
  if (
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    point.latitude < 33 ||
    point.latitude > 39 ||
    point.longitude < 124 ||
    point.longitude > 132
  ) {
    throw new RangeError('Weather point is outside Korea');
  }

  const rad = Math.PI / 180,
    re = 6371.00877 / 5;
  const slat1 = 30 * rad,
    slat2 = 60 * rad,
    olat = 38 * rad;
  const sn =
    Math.log(Math.cos(slat1) / Math.cos(slat2)) /
    Math.log(Math.tan(Math.PI / 4 + slat2 / 2) / Math.tan(Math.PI / 4 + slat1 / 2));
  const sf = (Math.pow(Math.tan(Math.PI / 4 + slat1 / 2), sn) * Math.cos(slat1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(Math.PI / 4 + olat / 2), sn);
  const ra = (re * sf) / Math.pow(Math.tan(Math.PI / 4 + (point.latitude * rad) / 2), sn);
  const theta = (point.longitude - 126) * rad * sn;

  return {
    x: Math.floor(ra * Math.sin(theta) + 43 + 0.5),
    y: Math.floor(ro - ra * Math.cos(theta) + 136 + 0.5),
  };
}

/** Use only a published hour. 40 minutes is a conservative ingestion allowance, not source latency. */
export function kmaObservationBase(now: number): {
  date: string;
  time: string;
} {
  const kst = new Date(now + 9 * 3_600_000 - 40 * 60_000);

  return {
    date: `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`,
    time: `${String(kst.getUTCHours()).padStart(2, '0')}00`,
  };
}

export function parseKmaWeather(
  payload: unknown,
  point: Point,
  receivedAt: number,
): WeatherSnapshot {
  return located(parseKmaObservation(payload, point, receivedAt), point);
}

function parseKmaObservation(payload: unknown, point: Point, receivedAt: number): GridWeather {
  const response = (
    payload as {
      response?: {
        header?: {
          resultCode?: unknown;
        };
        body?: {
          items?: {
            item?: unknown;
          };
        };
      };
    } | null
  )?.response;

  const code = text(response?.header?.resultCode);

  if (['20', '30', '31'].includes(code)) {
    throw new FeedError('auth');
  }

  if (code !== '00') {
    throw new FeedError('format');
  }

  const grid = kmaGrid(point);
  const records = asArray<Record<string, unknown>>(response?.body?.items?.item).filter(
    (row) => finiteNumber(row.nx) === grid.x && finiteNumber(row.ny) === grid.y,
  );
  const values = new Map<string, number>();
  let observedAt: number | null = null;

  for (const row of records) {
    const date = text(row.baseDate),
      time = text(row.baseTime).padStart(4, '0'),
      value = finiteNumber(row.obsrValue);

    if (!/^\d{8}$/.test(date) || !/^\d{4}$/.test(time) || value === null) {
      continue;
    }

    const year = Number(date.slice(0, 4)),
      month = Number(date.slice(4, 6)),
      day = Number(date.slice(6, 8)),
      hour = Number(time.slice(0, 2)),
      minute = Number(time.slice(2, 4));

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      continue;
    }

    const stamp = Date.UTC(year, month - 1, day, hour - 9, minute);
    const local = new Date(stamp + 9 * 3_600_000);

    if (
      local.getUTCFullYear() !== year ||
      local.getUTCMonth() !== month - 1 ||
      local.getUTCDate() !== day ||
      local.getUTCHours() !== hour ||
      local.getUTCMinutes() !== minute
    ) {
      continue;
    }

    if (!Number.isFinite(stamp) || stamp > receivedAt + 60_000) {
      continue;
    }

    if (observedAt !== null && observedAt !== stamp) {
      continue;
    }

    observedAt = stamp;
    values.set(text(row.category), value);
  }

  if (observedAt === null || !values.has('PTY') || !values.has('RN1') || !values.has('WSD')) {
    throw new FeedError('format');
  }

  const precipitationMm = values.get('RN1')!;
  const precipitationType = values.get('PTY')!;
  const windMetersPerSecond = values.get('WSD')!;
  const temperatureC = values.get('T1H') ?? null;

  // Broad validity bounds match the client contract; malformed provider values cannot poison all route results.
  if (
    precipitationMm < 0 ||
    precipitationMm > 1000 ||
    windMetersPerSecond < 0 ||
    windMetersPerSecond > 150 ||
    !Number.isInteger(precipitationType) ||
    precipitationType < 0 ||
    precipitationType > 7 ||
    (temperatureC !== null && (temperatureC < -80 || temperatureC > 70))
  ) {
    throw new FeedError('format');
  }

  const stale = receivedAt - observedAt > 100 * 60_000;

  return {
    source: 'kma-ultra-short',
    status: stale ? 'stale' : 'live',
    grid,
    temperatureC,
    precipitationMm,
    precipitationType,
    windMetersPerSecond,
    observedAt,
    receivedAt,
    message: stale
      ? '기상 관측이 오래되어 현재 날씨로 추천에 반영하지 않습니다.'
      : '기상청 5km 격자 초단기실황 · 이동 구간 전체의 날씨를 보장하지 않습니다.',
  };
}

/** One KMA observation per grid and base hour is reused this long, so a receipt this old is still the latest one. */
export const WEATHER_CACHE_MS = 10 * 60_000;
/** A search reads the weather when it starts and judges it when it finishes, so the last receipt the cache serves stays usable through a search of up to a minute. */
export const WEATHER_RECEIPT_MAX_AGE_MS = WEATHER_CACHE_MS + 60_000;

export class WeatherFeed {
  private readonly key: string;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    {
      until: number;
      value: Promise<GridWeather>;
    }
  >();
  lastFailure: FeedError['reason'] | null = null;

  constructor(
    key?: string,
    private readonly options: FeedOptions & {
      now?: () => number;
    } = {},
  ) {
    this.key = decodeServiceKey(key);
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.key;
  }

  async conditions(point: Point): Promise<WeatherSnapshot> {
    const now = this.now();
    let grid: WeatherSnapshot['grid'] = null;

    const absent = (status: 'unconfigured' | 'unavailable', receivedAt: number): GridWeather => ({
      source: 'kma-ultra-short',
      status,
      grid,
      temperatureC: null,
      precipitationMm: null,
      precipitationType: null,
      windMetersPerSecond: null,
      observedAt: null,
      receivedAt,
      message:
        status === 'unconfigured'
          ? '기상청 인증키가 설정되지 않았습니다. 날씨를 임의로 추정하지 않습니다.'
          : '현재 기상 관측을 확인하지 못했습니다. 날씨를 임의로 추정하지 않습니다.',
    });

    try {
      grid = kmaGrid(point);
    } catch {
      return located(
        {
          ...absent('unavailable', now),
          message: '기상청 관측의 지원 지역 밖입니다. 날씨를 임의로 추정하지 않습니다.',
        },
        point,
      );
    }

    if (!this.configured) {
      return located(absent('unconfigured', now), point);
    }

    const base = kmaObservationBase(now),
      cacheKey = `${grid.x},${grid.y}:${base.date}:${base.time}`;
    const hit = this.cache.get(cacheKey);

    if (hit && hit.until > now) {
      return located(await hit.value, point);
    }

    const url = new URL(
      'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst',
    );

    url.search = new URLSearchParams({
      serviceKey: this.key,
      dataType: 'JSON',
      pageNo: '1',
      numOfRows: '30',
      base_date: base.date,
      base_time: base.time,
      nx: String(grid.x),
      ny: String(grid.y),
    }).toString();

    const value = fetchFeedJson(url, this.options)
      .then((raw) => {
        const result = parseKmaObservation(raw, point, this.now());

        this.lastFailure = null;

        return result;
      })
      .catch((error) => {
        this.lastFailure = error instanceof FeedError ? error.reason : 'network';

        const entry = this.cache.get(cacheKey);

        if (entry?.value === value) {
          entry.until = this.now() + 30_000;
        }

        return absent('unavailable', this.now());
      });

    this.cache.set(cacheKey, {
      until: now + WEATHER_CACHE_MS,
      value,
    });

    // Exact coordinates are never persisted; trim old in-memory grid entries.
    if (this.cache.size > 300) {
      this.cache.delete(this.cache.keys().next().value!);
    }

    return located(await value, point);
  }
}
