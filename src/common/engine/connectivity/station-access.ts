import { readFileSync } from 'node:fs';
import { stationBaseName, subwayLineId } from '../realtime/names.js';

/**
 * Gate-to-platform (entry) and platform-to-gate (exit) seconds per station and line, fitted from public T-DATA gate
 * taps against the published weekday timetable (seoul-station-access-v1). The access walk ends at the station's map
 * point, so these seconds never overlap a routed street walk. In-station transfers are not covered here: the provider's
 * transfer walk and the official transfer reference already run platform to platform.
 */
export type StationAccessKind = 'entry' | 'exit';
export interface StationAccess {
  seconds: number;
  source: 'measured' | 'default';
}
type Period = 'base' | 'am-peak' | 'pm-peak' | 'late';
interface StationAccessTable {
  version: 'seoul-station-access-v1';
  periodMultipliers: Record<StationAccessKind, Record<Period, number>>;
  default: { entrySeconds: number; exitSeconds: number };
  clamps: { entrySeconds: [number, number]; exitSeconds: [number, number] };
  stations: Map<string, { entrySeconds: number; exitSeconds: number }>;
}

export const STATION_ACCESS_VERSION = 'seoul-station-access-v1';
/** Network medians of the fit (day-block bootstrap 12-14 s and 156-165 s); also used for every line the table lacks. */
const DEFAULT_TABLE: Omit<StationAccessTable, 'stations'> = {
  version: STATION_ACCESS_VERSION,
  periodMultipliers: {
    entry: { base: 1, 'am-peak': 0.749, 'pm-peak': 0.749, late: 0.945 },
    exit: { base: 1, 'am-peak': 0.974, 'pm-peak': 1.184, late: 0.969 },
  },
  default: { entrySeconds: 12, exitSeconds: 160 },
  clamps: { entrySeconds: [5, 240], exitSeconds: [60, 360] },
};
const PERIODS: readonly Period[] = ['base', 'am-peak', 'pm-peak', 'late'];
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 3600;
const bounds = (value: unknown): value is [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  seconds(value[0]) &&
  seconds(value[1]) &&
  value[0] <= value[1];

/** A missing or malformed file never throws: every station then uses the network default. */
export function parseStationAccessTable(raw: string): StationAccessTable | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value?.version !== STATION_ACCESS_VERSION ||
      !Array.isArray(value.stations) ||
      !value.stations.length
    )
      return null;
    const multipliers = value.periodMultipliers as
      Record<string, Record<string, unknown>> | undefined;
    const fallback = value.default as Record<string, unknown> | undefined,
      clamps = value.clamps as Record<string, unknown> | undefined;
    if (
      !multipliers ||
      !(['entry', 'exit'] as const).every((kind) =>
        PERIODS.every(
          (period) =>
            positive(multipliers[kind]?.[period]) && (multipliers[kind][period] as number) <= 2,
        ),
      )
    )
      return null;
    if (
      !fallback ||
      !seconds(fallback.entrySeconds) ||
      !seconds(fallback.exitSeconds) ||
      !clamps ||
      !bounds(clamps.entrySeconds) ||
      !bounds(clamps.exitSeconds)
    )
      return null;
    const stations = new Map<string, { entrySeconds: number; exitSeconds: number }>();
    for (const row of value.stations as Record<string, unknown>[]) {
      if (
        typeof row?.key !== 'string' ||
        !/^[^|]+\|[0-9]{4}$/.test(row.key) ||
        stations.has(row.key) ||
        !seconds(row.entrySeconds) ||
        !seconds(row.exitSeconds)
      )
        return null;
      stations.set(row.key, { entrySeconds: row.entrySeconds, exitSeconds: row.exitSeconds });
    }
    return {
      version: STATION_ACCESS_VERSION,
      stations,
      periodMultipliers: {
        entry: { ...multipliers.entry } as Record<Period, number>,
        exit: { ...multipliers.exit } as Record<Period, number>,
      },
      default: { entrySeconds: fallback.entrySeconds, exitSeconds: fallback.exitSeconds },
      clamps: {
        entrySeconds: clamps.entrySeconds as [number, number],
        exitSeconds: clamps.exitSeconds as [number, number],
      },
    };
  } catch {
    return null;
  }
}

let loaded: StationAccessTable | null | undefined;
function table(): StationAccessTable | null {
  if (loaded === undefined) {
    try {
      loaded = parseStationAccessTable(
        readFileSync(new URL('./data/seoul-station-access-v1.json', import.meta.url), 'utf8'),
      );
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

/** KST period the multipliers were fitted on: 07:00-09:30, 17:30-19:30, 22:00-06:00, otherwise base. */
export function stationAccessPeriod(at: number): Period {
  const kst = new Date(at + 9 * 3_600_000),
    minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minutes >= 420 && minutes < 570) return 'am-peak';
  if (minutes >= 1050 && minutes < 1170) return 'pm-peak';
  if (minutes >= 1320 || minutes < 360) return 'late';
  return 'base';
}

export function stationAccessKey(stop: string, line: string): string | null {
  const id = subwayLineId(line);
  return id ? `${stationBaseName(stop)}|${id}` : null;
}

/** Whole seconds between the gate and the platform of `line` at `stop` for a rider passing at `at`. */
export function stationAccessSeconds(
  stop: string,
  line: string,
  kind: StationAccessKind,
  at: number,
  source: StationAccessTable | null = table(),
): StationAccess {
  const config = source ?? DEFAULT_TABLE;
  const key = stationAccessKey(stop, line);
  const row = key ? source?.stations.get(key) : undefined;
  const base = row ? row[`${kind}Seconds`] : config.default[`${kind}Seconds`];
  const [low, high] = config.clamps[`${kind}Seconds`];
  const multiplier = Number.isFinite(at)
    ? config.periodMultipliers[kind][stationAccessPeriod(at)]
    : 1;
  return {
    seconds: Math.round(Math.max(low, Math.min(high, base * multiplier))),
    source: row ? 'measured' : 'default',
  };
}
