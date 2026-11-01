import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { ASSUMPTIONS } from './assumptions.js';
import { dataFile, type DayType } from './calendar.js';

/**
 * §22 foot traffic (유동인구): where people are, by 250 m cell, five layers. The weights come from
 * 서울 생활인구 (OA-14991), subway boardings (OA-12914) and buildings (U-FOOT); each layer's mean
 * over the listed cells is 1, and a cell not listed (no buildings) weighs 0.
 */
export const FOOT_LAYERS = ['wdDay', 'wdNight', 'weDay', 'weNight', 'res'] as const;
export const FOOT_LAYER = { WD_DAY: 0, WD_NIGHT: 1, WE_DAY: 2, WE_NIGHT: 3, RES: 4 } as const;
const LAYERS = FOOT_LAYERS.length;

/** The bundled weights in a dense grid, and each demand dock's 자치구. */
export interface FootWeights {
  version: string;
  cellMeters: number;
  rows: number;
  cols: number;
  south: number;
  west: number;
  metersPerDegree: number;
  cosLatitude: number;
  /** Weight per 250 m cell and layer, cell * 5 + layer; 0 for unlisted cells. */
  weight: Float32Array;
  /** Cells listed in the file (cells with buildings). */
  listed: Int32Array;
  /** 자치구 names, and the 구 index of each dock of the demand file (same order). */
  gu: readonly string[];
  guOfDock: Int16Array;
}

interface FootFile {
  meta?: { version?: unknown; grid?: Record<string, unknown> };
  docks?: { gu?: unknown; guOfDock?: unknown };
  cells?: unknown;
}

/** Parses the weights file; throws a TypeError when it is malformed. */
export function parseFootWeights(raw: unknown): FootWeights {
  const file = raw as FootFile;
  const grid = file?.meta?.grid ?? {};
  const number = (key: string) => Number(grid[key]);
  const [cellMeters, rows, cols, south, west, metersPerDegree, cosRef] = [
    'cellMeters',
    'rows',
    'cols',
    'south',
    'west',
    'metersPerDegree',
    'cosLatitudeRefDeg',
  ].map(number);
  if (
    file?.meta?.version !== 'foot-weights-v1' ||
    ![cellMeters, rows, cols, south, west, metersPerDegree, cosRef].every(Number.isFinite) ||
    !Array.isArray(file.cells) ||
    !Array.isArray(file.docks?.gu) ||
    !Array.isArray(file.docks?.guOfDock)
  )
    throw new TypeError('Invalid foot-traffic weights file');
  const weight = new Float32Array(rows * cols * LAYERS);
  const listed: number[] = [];
  for (const row of file.cells as unknown[]) {
    const values = row as number[];
    const cell = values?.[0];
    if (!Number.isInteger(cell) || cell < 0 || cell >= rows * cols || values.length !== 6)
      throw new TypeError('Invalid foot-traffic cell');
    listed.push(cell);
    for (let layer = 0; layer < LAYERS; layer++)
      weight[cell * LAYERS + layer] = Math.max(0, Number(values[layer + 1]) || 0);
  }
  const gu = (file.docks!.gu as unknown[]).map(String);
  const guOfDock = Int16Array.from(file.docks!.guOfDock as number[], (index) =>
    Number.isInteger(index) && index >= 0 && index < gu.length ? index : -1,
  );
  return {
    version: 'foot-weights-v1',
    cellMeters,
    rows,
    cols,
    south,
    west,
    metersPerDegree,
    cosLatitude: Math.cos((cosRef * Math.PI) / 180),
    weight,
    listed: Int32Array.from(listed),
    gu,
    guOfDock,
  };
}

/**
 * The weights shipped in git, built from open data only (OSM buildings,
 * mvp/scripts/build-shared-mobility-foot-weights.py).
 */
export const FOOT_WEIGHTS_FILE = 'shared-mobility-foot-weights-osm-v1.json';
/**
 * Absolute path of another weights file with the same schema, read instead of the shipped one: the
 * NGII-based weights, which may not leave Korea and so stay out of git.
 */
export const FOOT_WEIGHTS_ENV = 'MOBILITY_FOOT_WEIGHTS_PATH';

/** The weights file this process reads, and whether the operator chose it. */
export function footWeightsPath(env: Readonly<Record<string, string | undefined>> = process.env): {
  path: string;
  chosen: boolean;
} {
  const value = env[FOOT_WEIGHTS_ENV]?.trim();
  if (!value) return { path: dataFile(FOOT_WEIGHTS_FILE), chosen: false };
  if (!isAbsolute(value)) throw new TypeError(`${FOOT_WEIGHTS_ENV} must be an absolute path`);
  return { path: value, chosen: true };
}

/**
 * Reads a weights file: the parsed weights and the first 16 hex of the sha-256 of its bytes. Throws
 * when the file cannot be read or is malformed.
 */
export function readFootWeights(path: string): { weights: FootWeights; identity: string } {
  const bytes = readFileSync(path);
  return {
    weights: parseFootWeights(JSON.parse(bytes.toString('utf8'))),
    identity: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

let loaded: { weights: FootWeights | null; identity: string } | undefined;

function loadFootWeights(): { weights: FootWeights | null; identity: string } {
  if (loaded) return loaded;
  const { path, chosen } = footWeightsPath();
  // A file the operator named must load: a wrong path stops the server rather than quietly
  // simulating on other weights. Only the shipped file may be missing.
  if (chosen) return (loaded = readFootWeights(path));
  try {
    loaded = readFootWeights(path);
  } catch {
    let identity = 'missing';
    try {
      identity = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    } catch {
      /* The file is absent: 'missing' names it. */
    }
    loaded = { weights: null, identity };
  }
  return loaded;
}

/**
 * The weights in use (`MOBILITY_FOOT_WEIGHTS_PATH`, else the shipped OSM file), or null when the
 * shipped file is missing or malformed: the simulator then places by the 따릉이 table alone, as
 * before §22. A chosen file that cannot be read or parsed throws instead.
 */
export function bundledFootWeights(): FootWeights | null {
  return loadFootWeights().weights;
}

/**
 * Identity of the weights in use for the model version: the first 16 hex of the sha-256 of the
 * file's bytes, or 'missing'. Windows computed on different weights never share a key.
 */
export function footWeightsIdentity(): string {
  return loadFootWeights().identity;
}

/**
 * Which weights are in use, for health: the file's name (not its directory), whether
 * `MOBILITY_FOOT_WEIGHTS_PATH` chose it, and its identity.
 */
export function footWeightsStatus(): {
  file: string;
  source: 'env' | 'shipped';
  identity: string;
} {
  const { path, chosen } = footWeightsPath();
  return {
    file: basename(path),
    source: chosen ? 'env' : 'shipped',
    identity: footWeightsIdentity(),
  };
}

/**
 * Layer weights per (day type, KST hour), 5 each (U-FOOT §4.2, 가정값): 08–18 the day layer, 20–01
 * the night layer, 03–05 the residents' layer; 06–07, 19 and 02 blend their neighbours linearly.
 * Both day types share the residents' layer (only weekday nights were measured).
 */
export const FOOT_HOURS: Record<DayType, readonly Float64Array[]> = (() => {
  const table = (dayLayer: number, nightLayer: number) =>
    Array.from({ length: 24 }, (_, hour) => {
      const weights = new Float64Array(LAYERS);
      const mix = (layer: number, share: number) => (weights[layer] += share);
      if (hour >= 8 && hour <= 18) mix(dayLayer, 1);
      else if (hour >= 20 || hour <= 1) mix(nightLayer, 1);
      else if (hour >= 3 && hour <= 5) mix(FOOT_LAYER.RES, 1);
      else if (hour === 6 || hour === 7) {
        mix(FOOT_LAYER.RES, (8 - hour) / 3);
        mix(dayLayer, (hour - 5) / 3);
      } else if (hour === 19) {
        mix(dayLayer, 0.5);
        mix(nightLayer, 0.5);
      } else {
        mix(nightLayer, 0.5);
        mix(FOOT_LAYER.RES, 0.5);
      }
      return weights;
    });
  return {
    weekday: table(FOOT_LAYER.WD_DAY, FOOT_LAYER.WD_NIGHT),
    weekend: table(FOOT_LAYER.WE_DAY, FOOT_LAYER.WE_NIGHT),
  };
})();

/** The layer weights of an hour (`FOOT_HOURS`). */
export function footLayerAt(day: DayType, hour: number): Float64Array {
  return FOOT_HOURS[day][hour];
}

/** The 250 m cell of a point, or -1 outside the grid. */
export function footCellOf(foot: FootWeights, latitude: number, longitude: number): number {
  const row = Math.floor(((latitude - foot.south) * foot.metersPerDegree) / foot.cellMeters),
    col = Math.floor(
      ((longitude - foot.west) * foot.metersPerDegree * foot.cosLatitude) / foot.cellMeters,
    );
  return row < 0 || col < 0 || row >= foot.rows || col >= foot.cols ? -1 : row * foot.cols + col;
}

/** The centre of a 250 m cell, [latitude, longitude]. */
export function footCellCenter(foot: FootWeights, cell: number): [number, number] {
  const row = Math.floor(cell / foot.cols),
    col = cell % foot.cols;
  return [
    foot.south + ((row + 0.5) * foot.cellMeters) / foot.metersPerDegree,
    foot.west + ((col + 0.5) * foot.cellMeters) / (foot.metersPerDegree * foot.cosLatitude),
  ];
}

/** Weekday-day weight of the 250 m cell holding a point (§22 urban cells, service area). */
export function footWeekdayAt(foot: FootWeights, latitude: number, longitude: number): number {
  const cell = footCellOf(foot, latitude, longitude);
  return cell < 0 ? 0 : foot.weight[cell * LAYERS + FOOT_LAYER.WD_DAY];
}

/**
 * Per layer, the mean weight of the listed 250 m cells whose centre lies in each cell of a
 * coarser grid (the engine's 500 m cells; U-FOOT: divide by the listed children, not 4),
 * layer-major: layer * cells + cell.
 */
export function footCells(
  foot: FootWeights,
  grid: { cells: number; cell(latitude: number, longitude: number): number },
): Float32Array {
  const sums = new Float64Array(grid.cells * LAYERS),
    counts = new Int32Array(grid.cells);
  for (const cell of foot.listed) {
    const [latitude, longitude] = footCellCenter(foot, cell);
    const coarse = grid.cell(latitude, longitude);
    if (coarse < 0) continue;
    counts[coarse]++;
    for (let layer = 0; layer < LAYERS; layer++)
      sums[layer * grid.cells + coarse] += foot.weight[cell * LAYERS + layer];
  }
  const means = new Float32Array(grid.cells * LAYERS);
  for (let layer = 0; layer < LAYERS; layer++)
    for (let cell = 0; cell < grid.cells; cell++)
      if (counts[cell] > 0)
        means[layer * grid.cells + cell] = sums[layer * grid.cells + cell] / counts[cell];
  return means;
}

/** `footCells` of one coarse cell under layer weights (`footLayerAt`). */
export function footCell500(
  means: Float32Array,
  cells: number,
  cell: number,
  layers: Float64Array,
): number {
  let value = 0;
  for (let layer = 0; layer < LAYERS; layer++)
    if (layers[layer]) value += layers[layer] * means[layer * cells + cell];
  return value;
}

const dockCache = new WeakMap<Float64Array, Float32Array>();

/**
 * Per dock and layer (dock * 5 + layer), the foot mass of the listed 250 m cells whose nearest
 * dock within `serviceArea.dockBufferMeters` is that dock: the people a dock serves (U-FOOT §4.2).
 * Ties go to the lower dock index. Cached per dock table.
 */
export function footDocks(foot: FootWeights, docks: Float64Array): Float32Array {
  const cached = dockCache.get(docks);
  if (cached) return cached;
  const count = docks.length / 2,
    reach = ASSUMPTIONS.serviceArea.dockBufferMeters,
    lonMeters = foot.metersPerDegree * foot.cosLatitude;
  // Buckets of `reach` metres on the foot grid's projection.
  const bucketOf = (latitude: number, longitude: number): [number, number] => [
    Math.floor(((latitude - foot.south) * foot.metersPerDegree) / reach),
    Math.floor(((longitude - foot.west) * lonMeters) / reach),
  ];
  const buckets = new Map<number, number[]>();
  for (let dock = 0; dock < count; dock++) {
    const [row, col] = bucketOf(docks[dock * 2], docks[dock * 2 + 1]);
    const key = row * 100_000 + col;
    const list = buckets.get(key);
    if (list) list.push(dock);
    else buckets.set(key, [dock]);
  }
  const mass = new Float32Array(count * LAYERS);
  for (const cell of foot.listed) {
    const [latitude, longitude] = footCellCenter(foot, cell);
    const [row, col] = bucketOf(latitude, longitude);
    let best = -1,
      bestMeters: number = reach;
    for (let r = row - 1; r <= row + 1; r++)
      for (let c = col - 1; c <= col + 1; c++)
        for (const dock of buckets.get(r * 100_000 + c) ?? []) {
          const meters = Math.hypot(
            (docks[dock * 2] - latitude) * foot.metersPerDegree,
            (docks[dock * 2 + 1] - longitude) * lonMeters,
          );
          if (meters < bestMeters || (meters === bestMeters && dock < best)) {
            best = dock;
            bestMeters = meters;
          }
        }
    if (best < 0) continue;
    for (let layer = 0; layer < LAYERS; layer++)
      mass[best * LAYERS + layer] += foot.weight[cell * LAYERS + layer];
  }
  dockCache.set(docks, mass);
  return mass;
}

/** A dock's foot mass under layer weights (`footLayerAt`), from `footDocks`. */
export function footDock(mass: Float32Array, dock: number, layers: Float64Array): number {
  let value = 0;
  for (let layer = 0; layer < LAYERS; layer++)
    if (layers[layer]) value += layers[layer] * mass[dock * LAYERS + layer];
  return value;
}
