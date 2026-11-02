import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { parseSpatialBusCheckpoint, predictSpatialBusEnvelope, type SpatialBusInput } from '../../../src/common/engine/intelligence/spatial-bus-model';
import { parseRailGateCheckpoint, predictRailGate, type RailGateInput } from '../../../src/common/engine/intelligence/rail-gate-model';

/** Candidate may be at most 2% worse in MAE and 0.5 points lower in coverage than the incumbent on the same day. */
export const INCUMBENT_MAE_RATIO = 1.02, INCUMBENT_COVERAGE_SLACK = 0.005, INCUMBENT_MIN_ROWS = 100, LABEL_UNCERTAINTY = 60;
export interface Metrics { rows: number; maeSeconds: number; intervalCoverage: number; upperCoverage: number }
export interface IncumbentComparison { comparable: boolean; passed: boolean; reason: string; evaluationDate: string; commonRows: number; candidate?: Metrics; incumbent?: Metrics }
/**
 * The model in service alone on the fresh evaluation day, through the trainers' own promotion gate (model-refresh/incumbent-gate.py):
 * every group (all, OD seen/unseen, each day part, the day) must pass. `failed` names the failing groups, or why the gate could not run.
 */
export interface IncumbentGate {
  passed: boolean; failed: string[]; rows: number; evaluationDate: string;
  /** Per group, the numbers the promotion report writes under `evaluations`. */
  evaluations?: Record<string, Record<string, number | null> | null>;
}
type Envelope = { point: number; lower: number; upper: number };

/** Rows of one service day, in file order. */
async function* rowsOn(path: string, date: string): AsyncGenerator<Record<string, unknown>> {
  const needle = `"sourceDate":"${date}"`;
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) { if (line.includes(needle)) { const row = JSON.parse(line); if (row.sourceDate === date) yield row; } }
}
async function collect<T>(rows: AsyncGenerator<Record<string, unknown>>, map: (row: Record<string, unknown>) => T[], limit = 50_000) {
  const out: T[] = [];
  for await (const row of rows) { out.push(...map(row)); if (out.length >= limit) break; }
  return out;
}

export function compare(evaluationDate: string, pairs: { actual: number; candidate: Envelope | null; incumbent: Envelope | null }[]): IncumbentComparison {
  const common = pairs.filter(pair => pair.candidate && pair.incumbent);
  if (common.length < INCUMBENT_MIN_ROWS) return { comparable: false, passed: true, reason: 'incumbent-not-comparable', evaluationDate, commonRows: common.length };
  const metrics = (pick: 'candidate' | 'incumbent'): Metrics => {
    let error = 0, interval = 0, upper = 0;
    for (const pair of common) {
      const value = pair[pick]!;
      error += Math.abs(value.point - pair.actual);
      interval += Number(value.lower <= pair.actual - LABEL_UNCERTAINTY && value.upper >= pair.actual + LABEL_UNCERTAINTY);
      upper += Number(value.upper >= pair.actual + LABEL_UNCERTAINTY);
    }
    return { rows: common.length, maeSeconds: error / common.length, intervalCoverage: interval / common.length, upperCoverage: upper / common.length };
  };
  const candidate = metrics('candidate'), incumbent = metrics('incumbent');
  const passed = candidate.maeSeconds <= incumbent.maeSeconds * INCUMBENT_MAE_RATIO
    && candidate.intervalCoverage >= incumbent.intervalCoverage - INCUMBENT_COVERAGE_SLACK && candidate.upperCoverage >= incumbent.upperCoverage - INCUMBENT_COVERAGE_SLACK;
  return { comparable: true, passed, reason: passed ? 'not-worse-than-incumbent' : 'worse-than-incumbent', evaluationDate, commonRows: common.length, candidate, incumbent };
}

const spatialInput = (row: Record<string, unknown>): SpatialBusInput => ({ startedAt: row.startedAt as number, distanceMeters: row.distanceMeters as number, stopCount: (row.toOrder as number) - (row.fromOrder as number),
  originLatitude: row.fromLatitude as number, originLongitude: row.fromLongitude as number, destinationLatitude: row.toLatitude as number, destinationLongitude: row.toLongitude as number });

/** Spatial bus: mean prediction against the tag-to-tag seconds of the evaluation day, on rows both models support. */
export async function compareSpatialBus(candidateText: string | null, incumbentText: string | null, contextJsonl: string, evaluationDate: string): Promise<IncumbentComparison> {
  if (!incumbentText) return { comparable: false, passed: true, reason: 'no-incumbent', evaluationDate, commonRows: 0 };
  const candidate = candidateText ? parseSpatialBusCheckpoint(candidateText) : null, incumbent = parseSpatialBusCheckpoint(incumbentText);
  const shape = (value: ReturnType<typeof predictSpatialBusEnvelope>) => value ? { point: value.meanSeconds, lower: value.lowerSeconds, upper: value.upperSeconds } : null;
  const pairs = await collect(rowsOn(contextJsonl, evaluationDate), row => {
    const input = spatialInput(row);
    return [{ actual: row.actualSeconds as number, candidate: candidate ? shape(predictSpatialBusEnvelope(candidate, input)) : null, incumbent: shape(predictSpatialBusEnvelope(incumbent, input)) }];
  });
  return compare(evaluationDate, pairs);
}

/**
 * What the server would answer for every row of the day, one line per row id (null where it serves nothing), for incumbent-gate.py.
 * No row limit: the gate needs the whole day, as the trainer's evaluation does.
 */
async function writePredictions(output: string, rows: AsyncGenerator<Record<string, unknown>>, predict: (row: Record<string, unknown>) => Record<string, number> | null) {
  const lines: string[] = []; let predicted = 0;
  for await (const row of rows) { const incumbent = predict(row); predicted += Number(incumbent !== null); lines.push(JSON.stringify({ id: row.id, incumbent })); }
  await writeFile(output, lines.length ? lines.join('\n') + '\n' : '');
  return { rows: lines.length, predicted };
}
export function writeSpatialBusPredictions(incumbentText: string, contextJsonl: string, evaluationDate: string, output: string) {
  const model = parseSpatialBusCheckpoint(incumbentText);
  return writePredictions(output, rowsOn(contextJsonl, evaluationDate), row => {
    const value = predictSpatialBusEnvelope(model, spatialInput(row));
    return value && { mean: value.meanSeconds, median: value.medianSeconds, lower: value.lowerSeconds, upper: value.upperSeconds };
  });
}

const bare = (name: string) => name ? name.replace(/\(.*?\)/g, '').trim().replace(/역$/, '') : '';
const meters = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180, v = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));
};
/** Same coordinate rule as train-rail-gate.py: official GEOM by station id, else a unique ≤100 m cluster by bare name. */
export async function loadRailStations(csvPath: string) {
  const text = (await readFile(csvPath, 'utf8')).replace(/^﻿/, ''), [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const columns = header.split(','), at = (name: string) => columns.indexOf(name);
  const byId = new Map<string, [number, number][]>(), byName = new Map<string, [number, number][]>();
  for (const line of lines) {
    const cells = line.split(','), point: [number, number] = [Number(cells[at('환승역Y좌표')]), Number(cells[at('환승역X좌표')])];
    const push = (map: Map<string, [number, number][]>, key: string) => { const list = map.get(key) ?? []; list.push(point); map.set(key, list); };
    push(byId, cells[at('외구간_역_수')].trim()); push(byName, bare(cells[at('역한글명칭')]));
  }
  const unique = (points: [number, number][] | undefined): [number, number] | null => {
    if (!points?.length) return null;
    if (points.some(a => points.some(b => meters(a, b) > 100))) return null;
    return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
  };
  return (id: string, name: string) => unique(byId.get(String(id).trim())) ?? unique(byName.get(bare(name)));
}

const railInput = (row: Record<string, unknown>, locate: Awaited<ReturnType<typeof loadRailStations>>): RailGateInput | null => {
  const origin = locate(row.originStationId as string, row.originName as string), destination = locate(row.destinationStationId as string, row.destinationName as string);
  if (!origin || !destination) return null;
  return { originName: row.originName as string, destinationName: row.destinationName as string, startedAt: row.startedAt as number,
    origin: { latitude: origin[0], longitude: origin[1] }, destination: { latitude: destination[0], longitude: destination[1] } };
};

/** Subway gates: median prediction, as the trainer's quality gate. */
export async function compareRailGate(candidateText: string | null, incumbentText: string | null, railJsonl: string, stationsCsv: string, evaluationDate: string): Promise<IncumbentComparison> {
  if (!incumbentText) return { comparable: false, passed: true, reason: 'no-incumbent', evaluationDate, commonRows: 0 };
  const candidate = candidateText ? parseRailGateCheckpoint(candidateText) : null, incumbent = parseRailGateCheckpoint(incumbentText), locate = await loadRailStations(stationsCsv);
  const shape = (value: ReturnType<typeof predictRailGate>) => value ? { point: value.medianSeconds, lower: value.lowerSeconds, upper: value.upperSeconds } : null;
  const pairs = await collect(rowsOn(railJsonl, evaluationDate), row => {
    const input = railInput(row, locate);
    return input ? [{ actual: row.actualSeconds as number, candidate: candidate ? shape(predictRailGate(candidate, input)) : null, incumbent: shape(predictRailGate(incumbent, input)) }] : [];
  });
  return compare(evaluationDate, pairs);
}

/** A row without coordinates is written as null: the gate counts it unsupported, as the trainer does. */
export async function writeRailGatePredictions(incumbentText: string, railJsonl: string, stationsCsv: string, evaluationDate: string, output: string) {
  const model = parseRailGateCheckpoint(incumbentText), locate = await loadRailStations(stationsCsv);
  return writePredictions(output, rowsOn(railJsonl, evaluationDate), row => {
    const input = railInput(row, locate), value = input && predictRailGate(model, input);
    return value ? { median: value.medianSeconds, lower: value.lowerSeconds, upper: value.upperSeconds } : null;
  });
}
