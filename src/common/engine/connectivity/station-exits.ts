import { readFileSync } from 'node:fs';
import type { CallBudget } from '../call-budget.js';
import type { RouteProvider } from '../kakao.js';
import { metersBetween, stationBaseName } from '../realtime/names.js';
import type { Place } from '../../shared/domain/index.js';
import { stationAccessSeconds } from './station-access.js';

/**
 * Numbered subway exits (subway-exits-v1: OSM railway=subway_entrance, ODbL) and the sidewalk point where each exit's
 * street walk begins. A train ride that leaves or enters the paid area picks the exit with the least platform, passage
 * and street-walk time; the street walk then starts at that exit's sidewalk point, never at the platform coordinate.
 */
export const STATION_EXITS_VERSION = 'subway-exits-v1';
const EXIT_FIELDS = ['ref', 'lat', 'lon', 'slat', 'slon', 'src', 'lift', 'alt'] as const;

/** Gate-to-street passage time. 가정값, 출처 없음: no public source times the walk from the gates to a numbered exit. */
export const PASSAGE_ASSUMPTIONS = {
  /** One flight of stairs or an escalator from the concourse to the street. */
  stairSeconds: 15,
  /** The gates sit within this distance of the line's platform point. */
  gateReachMeters: 30,
  /** Corridors bend around the platform box. */
  detour: 1.3,
  metersPerSecond: 1.2,
  /** The step's faster and slower bounds around the passage estimate. */
  lowFactor: 0.8,
  highFactor: 1.4,
} as const;
/** Straight-line street ranking when no walking table answers (the same 1.25 detour at 1.2 m/s as estimatedWalk). */
const STREET_DETOUR = 1.25;
const STREET_METERS_PER_SECOND = 1.2;
const STATION_MATCH_METERS = 600;
const EXIT_REACH_METERS = 500;
const MAX_TABLED_EXITS = 12;
export const MAX_EXIT_TABLES_PER_SEARCH = 6;
const TABLE_TIMEOUT_MS = 1_500;
const CHOICE_TTL_MS = 15 * 60_000;
const MAX_CHOICES = 2_000;

export interface StationExit {
  id: string;
  /** "2", "6-1"; null for a station whose exits carry no number (a sidewalk point near the station). */
  ref: string | null;
  latitude: number;
  longitude: number;
  /** Sidewalk point where the street walk starts or ends. */
  street: { latitude: number; longitude: number };
  lift: boolean | null;
}
export interface ExitStation {
  id: string;
  name: string;
  lines: readonly string[];
  latitude: number;
  longitude: number;
  exits: readonly StationExit[];
}
export interface StationExitTable {
  version: typeof STATION_EXITS_VERSION;
  builtAt: string;
  stations: readonly ExitStation[];
  byName: ReadonlyMap<string, readonly ExitStation[]>;
}
export interface StationExitChoice {
  station: ExitStation;
  exit: StationExit;
  kind: 'exit' | 'entrance';
  platformSeconds: number;
  platformBasis: 'measured' | 'default';
  passageSeconds: number;
  passageMeters: number;
  /** Network seconds between the exit's sidewalk point and the target; null when ranked by straight line. */
  walkSeconds: number | null;
}

const finite = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

/** A missing or malformed file never throws: every station then keeps its platform point (the feature is off). */
export function parseStationExits(raw: string): StationExitTable | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value?.version !== STATION_EXITS_VERSION ||
      JSON.stringify(value.exitFields) !== JSON.stringify(EXIT_FIELDS) ||
      !Array.isArray(value.stations) ||
      !value.stations.length
    )
      return null;
    const stations: ExitStation[] = [],
      byName = new Map<string, ExitStation[]>(),
      ids = new Set<string>();
    for (const row of value.stations as Record<string, unknown>[]) {
      if (
        typeof row?.id !== 'string' ||
        !row.id ||
        ids.has(row.id) ||
        typeof row.name !== 'string' ||
        !row.name ||
        !Array.isArray(row.lines) ||
        !row.lines.every((line) => typeof line === 'string') ||
        !finite(row.lat, 90) ||
        !finite(row.lon, 180) ||
        !Array.isArray(row.exits)
      )
        return null;
      ids.add(row.id);
      const counts = new Map<string, number>();
      const exits: StationExit[] = [];
      for (const exit of row.exits as unknown[]) {
        // The builder omits trailing null cells (`lift`, `alt`).
        if (!Array.isArray(exit) || exit.length < 6 || exit.length > EXIT_FIELDS.length)
          return null;
        const [ref, lat, lon, slat, slon, , lift = null] = exit as unknown[];
        if (
          !finite(lat, 90) ||
          !finite(lon, 180) ||
          !finite(slat, 90) ||
          !finite(slon, 180) ||
          (lift !== null && lift !== 0 && lift !== 1)
        )
          return null;
        // A label that is not a short exit number ("한강진역 2번출구") is never shown; that one exit is left out.
        if (ref !== null && (typeof ref !== 'string' || !/^\d{1,2}(-\d{1,2})?$/.test(ref)))
          continue;
        const label = ref ?? 'x',
          k = counts.get(label) ?? 0;
        counts.set(label, k + 1);
        exits.push({
          id: `${row.id}-${label}-${k}`,
          ref,
          latitude: lat,
          longitude: lon,
          street: { latitude: slat, longitude: slon },
          lift: lift === null ? null : lift === 1,
        });
      }
      const station: ExitStation = {
        id: row.id,
        name: row.name,
        lines: row.lines as string[],
        latitude: row.lat,
        longitude: row.lon,
        exits,
      };
      stations.push(station);
      const name = stationBaseName(row.name);
      byName.set(name, [...(byName.get(name) ?? []), station]);
    }
    return {
      version: STATION_EXITS_VERSION,
      builtAt: typeof value.builtAt === 'string' ? value.builtAt : '',
      stations,
      byName,
    };
  } catch {
    return null;
  }
}

let loaded: StationExitTable | null | undefined;
/** The bundled table, read once. */
export function bundledStationExits(): StationExitTable | null {
  if (loaded === undefined) {
    try {
      loaded = parseStationExits(
        readFileSync(new URL('./data/seoul-subway-exits-v1.json', import.meta.url), 'utf8'),
      );
    } catch {
      loaded = null;
    }
  }
  return loaded;
}

/** The provider's stop name and any station name it gives in parentheses ("총신대입구(이수)"). */
const stopNames = (name: string) => [
  stationBaseName(name),
  ...[...name.normalize('NFC').matchAll(/\(([^)]*)\)/g)].map((match) => stationBaseName(match[1])),
];

/** The station named `stopName` nearest the train's end point (within 600 m), and its exits within 500 m of that point. */
export function stationExitsFor(
  stopName: string,
  trainPoint: { latitude: number; longitude: number },
  source: StationExitTable | null = bundledStationExits(),
): { station: ExitStation; exits: StationExit[] } | null {
  if (!source) return null;
  const station = stopNames(stopName)
    .flatMap((name) => source.byName.get(name) ?? [])
    .map((candidate) => ({ candidate, meters: metersBetween(candidate, trainPoint) }))
    .filter(({ meters }) => meters <= STATION_MATCH_METERS)
    .sort((a, b) => a.meters - b.meters)[0]?.candidate;
  if (!station) return null;
  const exits = station.exits.filter(
    (exit) => metersBetween(exit, trainPoint) <= EXIT_REACH_METERS,
  );
  return exits.length ? { station, exits } : null;
}

/** Gate-to-street passage from the line's platform point to an exit (가정값, see PASSAGE_ASSUMPTIONS). */
export function exitPassage(
  trainPoint: { latitude: number; longitude: number },
  exit: { latitude: number; longitude: number },
): { seconds: number; meters: number } {
  const meters = metersBetween(trainPoint, exit),
    { stairSeconds, gateReachMeters, detour, metersPerSecond } = PASSAGE_ASSUMPTIONS;
  return {
    meters: Math.round(meters),
    seconds: Math.round(
      stairSeconds + (Math.max(0, meters - gateReachMeters) * detour) / metersPerSecond,
    ),
  };
}

const streetSeconds = (exit: StationExit, target: { latitude: number; longitude: number }) =>
  (metersBetween(exit.street, target) * STREET_DETOUR) / STREET_METERS_PER_SECOND;

/** Counters for diagnostics only; they never change a choice. */
export const stationExitDiagnostics = { tables: 0, straightLine: 0, cached: 0 };

interface SearchExits {
  tables: number;
  pending: Map<string, Promise<{ id: string; walkSeconds: number | null } | null>>;
}
/** Per search (one CallBudget): bounded walking tables and one lookup per station end and target. */
const searches = new WeakMap<CallBudget, SearchExits>();
/** Across searches: the chosen exit per station end and target, kept 15 minutes. */
const choices = new Map<string, { id: string; walkSeconds: number | null; at: number }>();

const fixed = (point: { latitude: number; longitude: number }) =>
  `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
const placeOf = (id: string, point: { latitude: number; longitude: number }): Place => ({
  id,
  name: id,
  address: '',
  latitude: point.latitude,
  longitude: point.longitude,
});

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TABLE_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function rankExits(
  exits: readonly StationExit[],
  trainPoint: { latitude: number; longitude: number },
  target: { latitude: number; longitude: number },
  kind: 'exit' | 'entrance',
  provider: Pick<RouteProvider, 'travelTable'>,
  budget: CallBudget,
  search: SearchExits,
): Promise<{ id: string; walkSeconds: number | null } | null> {
  const ranked = exits
    .map((exit) => ({ exit, passage: exitPassage(trainPoint, exit).seconds }))
    .sort(
      (a, b) =>
        a.passage + streetSeconds(a.exit, target) - (b.passage + streetSeconds(b.exit, target)),
    )
    .slice(0, MAX_TABLED_EXITS);
  if (!ranked.length) return null;
  const table = provider.travelTable?.bind(provider);
  if (ranked.length > 1 && table && search.tables < MAX_EXIT_TABLES_PER_SEARCH) {
    search.tables++;
    stationExitDiagnostics.tables++;
    const streets = ranked.map(({ exit }) => placeOf(exit.id, exit.street)),
      point = placeOf('target', target);
    const answer = await withTimeout(
      kind === 'exit'
        ? table('walking', streets, [point], budget)
        : table('walking', [point], streets, budget),
    );
    const seconds = ranked.map((_, index) => {
      const value = kind === 'exit' ? answer?.seconds[index]?.[0] : answer?.seconds[0]?.[index];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    });
    if (seconds.some((value) => value !== null)) {
      const best = ranked
        .map((entry, index) => ({ ...entry, walk: seconds[index] }))
        .filter((entry): entry is typeof entry & { walk: number } => entry.walk !== null)
        .sort((a, b) => a.passage + a.walk - (b.passage + b.walk) || a.passage - b.passage)[0];
      return { id: best.exit.id, walkSeconds: Math.round(best.walk) };
    }
  }
  if (ranked.length > 1) stationExitDiagnostics.straightLine++;
  return { id: ranked[0].exit.id, walkSeconds: null };
}

/**
 * The exit (after alighting) or entrance (before boarding) with the least platform + passage + street-walk seconds to
 * `target` (the next point after alighting, the previous point before boarding). Platform seconds are equal for every
 * exit of one station, so they time the step but never change the choice. Null keeps the platform point (no data).
 */
export async function chooseStationExit(input: {
  stopName: string;
  line: string;
  trainPoint: { latitude: number; longitude: number };
  target: { latitude: number; longitude: number };
  kind: 'exit' | 'entrance';
  at: number;
  provider: Pick<RouteProvider, 'travelTable'>;
  budget: CallBudget;
  source?: StationExitTable | null;
}): Promise<StationExitChoice | null> {
  const found = stationExitsFor(
    input.stopName,
    input.trainPoint,
    input.source === undefined ? bundledStationExits() : input.source,
  );
  if (!found) return null;
  const key = `${found.station.id}|${input.kind}|${fixed(input.trainPoint)}|${fixed(input.target)}`;
  const now = Date.now(),
    remembered = choices.get(key);
  let picked: { id: string; walkSeconds: number | null } | null = null;
  if (remembered && now - remembered.at <= CHOICE_TTL_MS) {
    stationExitDiagnostics.cached++;
    picked = remembered;
  } else {
    let search = searches.get(input.budget);
    if (!search) {
      search = { tables: 0, pending: new Map() };
      searches.set(input.budget, search);
    }
    let pending = search.pending.get(key);
    if (!pending) {
      pending = rankExits(
        found.exits,
        input.trainPoint,
        input.target,
        input.kind,
        input.provider,
        input.budget,
        search,
      );
      search.pending.set(key, pending);
    }
    picked = await pending;
    // Straight-line picks are not remembered: the next search may have a table slot for this station.
    if (picked?.walkSeconds != null) {
      choices.delete(key);
      choices.set(key, { ...picked, at: now });
      while (choices.size > MAX_CHOICES) choices.delete(choices.keys().next().value!);
    }
  }
  const exit = picked && found.exits.find((candidate) => candidate.id === picked.id);
  if (!exit) return null;
  const platform = stationAccessSeconds(
    input.stopName,
    input.line,
    input.kind === 'exit' ? 'exit' : 'entry',
    input.at,
  );
  const passage = exitPassage(input.trainPoint, exit);
  return {
    station: found.station,
    exit,
    kind: input.kind,
    platformSeconds: platform.seconds,
    platformBasis: platform.source,
    passageSeconds: passage.seconds,
    passageMeters: passage.meters,
    walkSeconds: picked!.walkSeconds,
  };
}

/** Test hook: forget remembered choices. */
export function resetStationExitChoices(): void {
  choices.clear();
}

/** Test hook for this process: replace the bundled table (null turns exits off, undefined reads the file again). */
export function setBundledStationExits(table: StationExitTable | null | undefined): void {
  loaded = table;
  choices.clear();
}
