import { readFileSync } from 'node:fs';
import { dataFile } from './calendar.js';

/**
 * §20.1 door points (shared-mobility-door-points-v1, mvp/scripts/
 * build-shared-mobility-door-points.py): building and complex entrances, gates, complex exits,
 * station-exit sides and inferred edge points from OpenStreetMap. Riders start and end at them,
 * and crews set vehicles down by them; 따릉이 docks only say when and between which areas.
 */
export const DOOR_POINTS_VERSION = 'shared-mobility-door-points-v1';

/** Door categories in file order. */
export const DOOR_CATEGORY_NAMES = ['entrance', 'gate', 'exit', 'station', 'inferred'] as const;
/** Flag bits of the file: an edge point with no mapped door, and a gate marked access=no. */
export const DOOR_FLAG = { INFERRED: 1, RESTRICTED: 2 } as const;

export interface DoorPointsMeta {
  version: string | null;
  builtAt: number | null;
  points: number;
  areas: number;
  /** School building entrances folded into a gate or edge point of their school (`foldSchoolEntrances`). */
  foldedSchoolEntrances: number;
  /** True when the file was missing or malformed: riders and crews use the docks (§20.1). */
  fallback: boolean;
}

/** The door points, lat/lon interleaved, with the per-point columns. */
export interface DoorPointSet {
  meta: DoorPointsMeta;
  points: Float64Array;
  /** The point's share of its area's occupants (a relative weight, 가정값 per kind). */
  weight: Float64Array;
  category: Uint8Array;
  flags: Uint8Array;
}

const emptyDoors = (): DoorPointSet => ({
  meta: {
    version: null,
    builtAt: null,
    points: 0,
    areas: 0,
    foldedSchoolEntrances: 0,
    fallback: true,
  },
  points: new Float64Array(0),
  weight: new Float64Array(0),
  category: new Uint8Array(0),
  flags: new Uint8Array(0),
});

/** Reads the door-point file; a missing or malformed file yields no points. */
export function parseDoorPoints(raw: unknown): DoorPointSet {
  const file = raw as {
    version?: unknown;
    builtAt?: unknown;
    meta?: { kinds?: unknown };
    areas?: { lat?: unknown; kind?: unknown };
    points?: Record<'lat' | 'lon' | 'cat' | 'w' | 'flags', unknown> & { area?: unknown };
  };
  if (!file || typeof file !== 'object' || file.version !== DOOR_POINTS_VERSION)
    return emptyDoors();
  const columns = file.points;
  const count = Array.isArray(columns?.lat) ? columns.lat.length : 0;
  const column = (values: unknown) =>
    Array.isArray(values) &&
    values.length === count &&
    values.every((value) => Number.isFinite(value) && value >= -180 && value <= 1e9);
  if (
    !count ||
    !columns ||
    !column(columns.lat) ||
    !column(columns.lon) ||
    !column(columns.cat) ||
    !column(columns.w) ||
    !column(columns.flags)
  )
    return emptyDoors();
  const lat = columns.lat as number[],
    lon = columns.lon as number[],
    category = columns.cat as number[],
    flags = columns.flags as number[];
  const weight = (columns.w as number[]).map((value) => Math.max(0, value));
  const kinds = file.meta?.kinds,
    areaKinds = file.areas?.kind;
  const kept =
    column(columns.area) && Array.isArray(kinds) && Array.isArray(areaKinds)
      ? foldSchoolEntrances(
          lat,
          lon,
          category,
          flags,
          weight,
          columns.area as number[],
          (area) => kinds[areaKinds[area] as number] === 'school',
        )
      : null;
  const order = kept ?? Array.from({ length: count }, (_, index) => index);
  const points = new Float64Array(order.length * 2);
  order.forEach((index, slot) => {
    points[slot * 2] = lat[index];
    points[slot * 2 + 1] = lon[index];
  });
  return {
    meta: {
      version: DOOR_POINTS_VERSION,
      builtAt: Number.isFinite(file.builtAt) ? (file.builtAt as number) : null,
      points: order.length,
      areas: Array.isArray(file.areas?.lat) ? file.areas.lat.length : 0,
      foldedSchoolEntrances: count - order.length,
      fallback: false,
    },
    points,
    weight: Float64Array.from(order, (index) => weight[index]),
    category: Uint8Array.from(order, (index) => category[index]),
    flags: Uint8Array.from(order, (index) => flags[index]),
  };
}

const CATEGORY_OF = Object.fromEntries(DOOR_CATEGORY_NAMES.map((name, index) => [name, index]));
const metersApart = (latA: number, lonA: number, latB: number, lonB: number) =>
  Math.hypot(
    (latA - latB) * 111_195,
    (lonA - lonB) * 111_195 * Math.cos((((latA + latB) / 2) * Math.PI) / 180),
  );

/**
 * A building entrance inside primary or secondary school grounds (초·중·고) is where pupils walk in,
 * not where a shared vehicle stands: nothing may be ridden in or left inside (R22). Each one is
 * folded into its school's nearest open gate or boundary exit, else its nearest edge point, which
 * takes over its weight, so riders bound for the school arrive at the gate; one whose school has
 * neither is dropped. Universities keep their entrances: their grounds have roads. Returns the
 * indices kept, in file order; `weight` is updated in place.
 */
function foldSchoolEntrances(
  lat: readonly number[],
  lon: readonly number[],
  category: readonly number[],
  flags: readonly number[],
  weight: number[],
  area: readonly number[],
  school: (area: number) => boolean,
): number[] {
  const bySchool = new Map<number, number[]>();
  area.forEach((value, index) => {
    if (school(value)) bySchool.set(value, [...(bySchool.get(value) ?? []), index]);
  });
  const folded = new Set<number>();
  for (const members of bySchool.values()) {
    const nearest = (index: number, categories: readonly number[]) => {
      let best = -1,
        bestMeters = Infinity;
      for (const other of members) {
        if (!categories.includes(category[other]) || flags[other] & DOOR_FLAG.RESTRICTED) continue;
        const meters = metersApart(lat[index], lon[index], lat[other], lon[other]);
        if (meters < bestMeters) [best, bestMeters] = [other, meters];
      }
      return best;
    };
    for (const index of members) {
      if (category[index] !== CATEGORY_OF.entrance) continue;
      let target = nearest(index, [CATEGORY_OF.gate, CATEGORY_OF.exit]);
      if (target < 0) target = nearest(index, [CATEGORY_OF.inferred]);
      if (target >= 0) weight[target] += weight[index];
      folded.add(index);
    }
  }
  return Array.from({ length: lat.length }, (_, index) => index).filter(
    (index) => !folded.has(index),
  );
}

let bundled: DoorPointSet | null = null;

export function bundledDoorPoints(): DoorPointSet {
  if (!bundled) {
    try {
      bundled = parseDoorPoints(
        JSON.parse(readFileSync(dataFile('shared-mobility-door-points-v1.json'), 'utf8')),
      );
    } catch {
      bundled = emptyDoors();
    }
  }
  return bundled;
}
