import type { RoadIncident, RoadTrafficLink } from '../../shared/domain/types.js';
import {
  asArray,
  FeedError,
  fetchFeedJson,
  finiteNumber,
  parseKstDateTime,
  text,
  type FeedOptions,
} from './http.js';
import { SEOUL_TRAFFIC_AREAS } from './seoulAreas.js';
import { roadObservationIsFresh } from '../../shared/journey/realtimeFreshness.js';

export interface AreaTraffic {
  links: RoadTrafficLink[];
  incidents: RoadIncident[];
  observedAt: number | null;
}

/** 서울 실시간 도시데이터의 도로소통 구분. */
const LEVELS: Record<string, RoadTrafficLink['level']> = {
  원활: 'free',
  서행: 'slow',
  정체: 'jam',
};

const round = (value: number) => Math.round(value * 1e5) / 1e5;

const inKorea = (longitude: number, latitude: number) =>
  longitude > 124 && longitude < 132 && latitude > 33 && latitude < 39;

function point(value: unknown): [number, number] | null {
  const [x, y] = text(value).split('_').map(Number);

  return Number.isFinite(x) && Number.isFinite(y) && inKorea(x, y) ? [round(x), round(y)] : null;
}

const gap = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** One citydata response: road links oriented from their start node, and reported incidents. */
export function parseCityData(payload: unknown): AreaTraffic {
  if (!payload || typeof payload !== 'object') {
    throw new FeedError('format');
  }

  const record = payload as Record<string, unknown>;
  const city = record.CITYDATA as Record<string, unknown> | undefined;

  if (!city || typeof city !== 'object') {
    const code = text(
      (record.RESULT as Record<string, unknown> | undefined)?.['RESULT.CODE'] ??
        record['RESULT.CODE'],
    );

    throw new FeedError(
      code === 'INFO-100' || code === 'ERROR-337'
        ? 'auth'
        : code.startsWith('ERROR-5')
          ? 'status'
          : 'format',
    );
  }

  const road = (city.ROAD_TRAFFIC_STTS ?? {}) as Record<string, unknown>;
  const links: RoadTrafficLink[] = [];

  for (const raw of asArray<Record<string, unknown>>(road.ROAD_TRAFFIC_STTS)) {
    const id = text(raw.LINK_ID),
      level = LEVELS[text(raw.IDX)],
      speed = finiteNumber(raw.SPD);

    if (!id || !level || speed === null || speed < 0) {
      continue;
    }

    const path: [number, number][] = [];

    for (const part of text(raw.XYLIST).split('|').slice(0, 400)) {
      const next = point(part),
        last = path[path.length - 1];

      if (next && (!last || last[0] !== next[0] || last[1] !== next[1])) {
        path.push(next);
      }
    }

    if (path.length < 2) {
      continue;
    }

    // XYLIST is not always listed in the direction of travel; the start node decides.
    const start = point(raw.START_ND_XY);

    if (start && gap(path[0], start) > gap(path[path.length - 1], start)) {
      path.reverse();
    }

    links.push({
      id,
      name: text(raw.ROAD_NM).slice(0, 80),
      level,
      speedKmh: Math.round(Math.min(speed, 200)),
      path,
    });
  }

  const incidents: RoadIncident[] = [];

  for (const raw of asArray<Record<string, unknown>>(city.ACDNT_CNTRL_STTS)) {
    const longitude = finiteNumber(raw.ACDNT_X),
      latitude = finiteNumber(raw.ACDNT_Y);
    const detail = text(raw.ACDNT_INFO).replace(/\|/g, ', ').replace(/\s+/g, ' ').slice(0, 400);

    if (longitude === null || latitude === null || !inKorea(longitude, latitude) || !detail) {
      continue;
    }

    const kind =
      [text(raw.ACDNT_TYPE), text(raw.ACDNT_DTYPE)].filter(Boolean).join(' · ').slice(0, 60) ||
      '도로 통제';

    incidents.push({
      id: `${round(longitude)},${round(latitude)}:${text(raw.ACDNT_OCCR_DT)}`.slice(0, 100),
      kind,
      detail,
      latitude: round(latitude),
      longitude: round(longitude),
      startedAt: parseKstDateTime(raw.ACDNT_OCCR_DT),
      clearsAt: parseKstDateTime(raw.EXP_CLR_DT),
    });
  }

  const average = (road.AVG_ROAD_DATA ?? {}) as Record<string, unknown>;

  return {
    links,
    incidents,
    observedAt: parseKstDateTime(average.ROAD_TRAFFIC_TIME),
  };
}

export interface RoadTrafficOptions extends FeedOptions {
  /** 서울 열린데이터광장 일반 인증키 (실시간 도시데이터). */
  seoulCityDataKey?: string;
  now?: () => number;
  cacheMs?: number;
  /** Hotspot areas read for one set of paths. */
  maxAreas?: number;
}

type Point = {
  latitude: number;
  longitude: number;
};

/** Every reported road link and incident around a set of paths. */
export interface CorridorTraffic {
  links: RoadTrafficLink[];
  incidents: RoadIncident[];
  observedAt: number | null;
}

/**
 * Live road speeds from Seoul's real-time city data: speed and 원활/서행/정체 per road link
 * around its major places, republished by the city every five minutes. Read for the roads a
 * route uses, never for the whole map. Each area is cached, and a failed area is skipped so
 * the rest of the route is still judged.
 */
export class RoadTrafficService {
  private readonly key: string;
  private readonly feed: FeedOptions;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly maxAreas: number;
  private readonly areas = new Map<
    string,
    {
      expiresAt: number;
      value: Promise<AreaTraffic | null>;
    }
  >();
  lastFailure: FeedError['reason'] | null = null;

  constructor(options: RoadTrafficOptions = {}) {
    this.key = options.seoulCityDataKey?.trim() ?? '';
    this.feed = {
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs ?? 6_000,
    };
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 120_000;
    this.maxAreas = options.maxAreas ?? 24;
  }

  get configured(): boolean {
    return !!this.key;
  }

  private area(code: string): Promise<AreaTraffic | null> {
    const time = this.now();
    const hit = this.areas.get(code);

    if (hit && hit.expiresAt > time) {
      return hit.value;
    }

    const url = new URL(
      `http://openapi.seoul.go.kr:8088/${encodeURIComponent(this.key)}/json/citydata/1/5/${code}`,
    );

    const value = fetchFeedJson(url, this.feed)
      .then(parseCityData)
      .then(
        (result) => {
          this.lastFailure = null;

          return result;
        },
        (error) => {
          this.lastFailure = error instanceof FeedError ? error.reason : 'network';

          // A failed area is retried soon, not on every search.
          const entry = this.areas.get(code);

          if (entry?.value === value) {
            entry.expiresAt = this.now() + 20_000;
          }

          return null;
        },
      );

    this.areas.set(code, {
      expiresAt: time + this.cacheMs,
      value,
    });

    return value;
  }

  /** Links and incidents of every area the paths pass through. */
  async along(paths: Point[][]): Promise<CorridorTraffic> {
    const empty: CorridorTraffic = {
      links: [],
      incidents: [],
      observedAt: null,
    };

    if (!this.configured) {
      return empty;
    }

    const margin = 0.002;
    const passes = new Map<string, number>();

    for (const path of paths) {
      const stride = Math.max(1, Math.floor(path.length / 80));

      for (let index = 0; index < path.length; index += stride) {
        const { latitude, longitude } = path[index];

        for (const [code, , west, south, east, north] of SEOUL_TRAFFIC_AREAS) {
          if (
            longitude >= west - margin &&
            longitude <= east + margin &&
            latitude >= south - margin &&
            latitude <= north + margin
          ) {
            passes.set(code, (passes.get(code) ?? 0) + 1);
          }
        }
      }
    }

    // Areas holding more of the route come first when the cap applies.
    const selected = [...passes]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxAreas)
      .map(([code]) => code);

    if (!selected.length) {
      return empty;
    }

    const snapshots: (AreaTraffic | null)[] = new Array(selected.length).fill(null);
    let cursor = 0;

    await Promise.all(
      Array.from(
        {
          length: Math.min(6, selected.length),
        },
        async () => {
          while (cursor < selected.length) {
            const index = cursor++;

            snapshots[index] = await this.area(selected[index]);
          }
        },
      ),
    );

    const time = this.now();
    const links = new Map<string, RoadTrafficLink>();
    const incidents = new Map<string, RoadIncident>();
    let observedAt: number | null = null;

    for (const snapshot of snapshots) {
      if (!snapshot || !roadObservationIsFresh(snapshot.observedAt, time)) {
        continue;
      }

      // A newer neighboring area cannot launder an older link's observation time.
      observedAt = Math.min(observedAt ?? snapshot.observedAt, snapshot.observedAt);

      for (const link of snapshot.links) {
        if (!links.has(link.id)) {
          links.set(link.id, link);
        }
      }

      for (const incident of snapshot.incidents) {
        if (incident.clearsAt === null || incident.clearsAt >= time) {
          incidents.set(incident.id, incident);
        }
      }
    }

    return {
      links: [...links.values()],
      incidents: [...incidents.values()],
      observedAt,
    };
  }
}
