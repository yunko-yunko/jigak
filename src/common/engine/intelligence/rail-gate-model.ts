import { z } from 'zod';
import { holidayAsSunday, HOLIDAY_AS_SUNDAY } from './korean-holidays.js';

/** Subway gate-to-gate elapsed time (entry gate to exit gate) learned from T-DATA card tags. */
export const RAIL_GATE_VERSION = 'seoul-rail-gate-v1' as const;
export const RAIL_GATE_FEATURE_NAMES = [
  'log1pEndpointMeters',
  'originLatitude',
  'originLongitude',
  'destinationLatitude',
  'destinationLongitude',
  'northMeters',
  'eastMeters',
  'seoulHourSin',
  'seoulHourCos',
  'seoulWeekdaySin',
  'seoulWeekdayCos',
  'weekend',
  'odLogMedian',
  'odLogCount',
  'originLogEffect',
  'originLogCount',
  'destinationLogEffect',
  'destinationLogCount',
] as const;
export const RAIL_GATE_DAY_PARTS = [
  ['overnight', 0, 6],
  ['morning', 6, 10],
  ['daytime', 10, 17],
  ['evening', 17, 21],
  ['night', 21, 24],
] as const;
export const RAIL_GATE_GROUPS = (['weekday', 'weekend'] as const).flatMap((kind) =>
  RAIL_GATE_DAY_PARTS.map(([name]) => `${kind}:${name}`),
);
const N = RAIL_GATE_FEATURE_NAMES.length,
  finite = z.number().finite(),
  isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const node = z
  .object({
    value: finite,
    feature: finite
      .int()
      .min(0)
      .max(N - 1),
    threshold: finite,
    left: finite.int().min(0),
    right: finite.int().min(0),
    leaf: z.boolean(),
  })
  .strict();
const ensemble = z
  .object({ initial: finite, trees: z.array(z.array(node).min(1).max(125)).min(1).max(200) })
  .strict();
const name = z.string().min(1).max(80),
  count = finite.int().min(1).max(1_000_000);
const logAdjustment = finite.min(-Math.log(4)).max(Math.log(4));
const checkpointSchema = z
  .object({
    version: z.literal(RAIL_GATE_VERSION),
    deployment: z.literal('production'),
    target: z.literal('rail-gate-elapsed'),
    trainedAt: finite.int().positive(),
    expiresAt: finite.int().positive(),
    trainingThrough: isoDay,
    lastEvaluatedServiceDate: isoDay,
    featureNames: z.array(z.string()).length(N),
    featureQuantizationDecimals: z.literal(6),
    models: z.object({ lower: ensemble, median: ensemble, upper: ensemble }).strict(),
    secondsPerMeter: finite.positive().max(10),
    priorRows: finite.int().min(1).max(100),
    encodings: z
      .object({
        pairs: z.array(z.tuple([name, name, finite, count])).max(200_000),
        origins: z.array(z.tuple([name, finite, count])).max(2000),
        destinations: z.array(z.tuple([name, finite, count])).max(2000),
      })
      .strict(),
    calendar: z
      .object({
        rule: z.literal(HOLIDAY_AS_SUNDAY),
        firstDate: isoDay,
        lastDate: isoDay,
        holidays: z.array(isoDay).max(60),
      })
      .strict(),
    conformal: z
      .array(
        z.object({ group: z.string(), logLower: logAdjustment, logUpper: logAdjustment }).strict(),
      )
      .length(RAIL_GATE_GROUPS.length),
    labelUncertaintySeconds: z.literal(60),
    domain: z
      .object({ minimum: z.array(finite).length(N), maximum: z.array(finite).length(N) })
      .strict(),
    evaluation: z.record(z.string(), z.unknown()),
    source: z
      .object({
        experiment: z.string(),
        protocolSha256: z.string().regex(/^[a-f0-9]{64}$/),
        modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
export type RailGateCheckpoint = Checkpoint & {
  lookup: {
    pairs: Map<string, [number, number]>;
    origins: Map<string, [number, number]>;
    destinations: Map<string, [number, number]>;
  };
};
export interface RailGateInput {
  originName: string;
  destinationName: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  startedAt: number;
}
export interface RailGatePrediction {
  lowerSeconds: number;
  medianSeconds: number;
  upperSeconds: number;
}

const pairKey = (origin: string, destination: string) => `${origin}\u0000${destination}`;

export function parseRailGateCheckpoint(text: string): RailGateCheckpoint {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 48 * 1024 * 1024)
    throw new Error('invalid-rail-gate-model');
  const model = checkpointSchema.parse(JSON.parse(text));
  if (
    model.featureNames.some((value, i) => value !== RAIL_GATE_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((value, i) => value > model.domain.maximum[i]) ||
    model.conformal.some((entry, i) => entry.group !== RAIL_GATE_GROUPS[i]) ||
    model.expiresAt <= model.trainedAt ||
    model.expiresAt - model.trainedAt > 7 * 86_400_000 ||
    model.calendar.firstDate > model.calendar.lastDate ||
    model.calendar.holidays.some(
      (day) => day < model.calendar.firstDate || day > model.calendar.lastDate,
    )
  )
    throw new Error('invalid-rail-gate-contract');
  for (const value of Object.values(model.models))
    for (const tree of value.trees) {
      const parents = Array<number>(tree.length).fill(0);
      for (let index = 0; index < tree.length; index++) {
        const entry = tree[index];
        if (entry.leaf) continue;
        if (
          entry.left <= index ||
          entry.right <= index ||
          entry.left >= tree.length ||
          entry.right >= tree.length ||
          entry.left === entry.right
        )
          throw new Error('invalid-rail-gate-tree');
        parents[entry.left]++;
        parents[entry.right]++;
      }
      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1))
        throw new Error('disconnected-rail-gate-tree');
    }
  const pairs = new Map(
    model.encodings.pairs.map(([o, d, median, n]) => [
      pairKey(o, d),
      [median, n] as [number, number],
    ]),
  );
  if (pairs.size !== model.encodings.pairs.length) throw new Error('duplicate-rail-gate-pair');
  return {
    ...model,
    lookup: {
      pairs,
      origins: new Map(
        model.encodings.origins.map(([k, median, n]) => [k, [median, n] as [number, number]]),
      ),
      destinations: new Map(
        model.encodings.destinations.map(([k, median, n]) => [k, [median, n] as [number, number]]),
      ),
    },
  };
}

/** Same haversine as the trainer, including the max(0, 1 - v) guard. */
function meters(a: readonly [number, number], b: readonly [number, number]): number {
  const r = Math.PI / 180,
    v =
      Math.sin(((b[0] - a[0]) * r) / 2) ** 2 +
      Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));
}

/** Shrunken median toward `prior` with priorRows pseudo-rows; an unseen key keeps the prior with count 0. */
const summary = (entry: [number, number] | undefined, prior: number, priorRows: number) =>
  entry
    ? [(entry[0] * entry[1] + prior * priorRows) / (entry[1] + priorRows), Math.log1p(entry[1])]
    : [prior, 0];

/** Features exactly as scripts/train-rail-gate.py builds them; null when a day type or station is unknown. */
export function railGateFeatures(model: RailGateCheckpoint, input: RailGateInput): number[] | null {
  const { origin, destination, startedAt } = input;
  if (
    !input ||
    ![
      origin?.latitude,
      origin?.longitude,
      destination?.latitude,
      destination?.longitude,
      startedAt,
    ].every(Number.isFinite) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0
  )
    return null;
  const a = origin.latitude,
    b = origin.longitude,
    c = destination.latitude,
    d = destination.longitude;
  if (!(36 < a && a < 39 && 36 < c && c < 39 && 125 < b && b < 130 && 125 < d && d < 130))
    return null;
  const originEffect = model.lookup.origins.get(input.originName),
    destinationEffect = model.lookup.destinations.get(input.destinationName);
  // A station the trainer never saw has no station encoding; serve nothing rather than extrapolate.
  if (!originEffect || !destinationEffect) return null;
  const day = holidayAsSunday(model.calendar)(startedAt);
  if (day === null) return null;
  const local = new Date(startedAt + 9 * 3_600_000);
  const hour =
    ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
    2 *
    Math.PI;
  const logDistance = Math.log1p(meters([a, b], [c, d]));
  const spatialLog = Math.log(Math.max(50, Math.expm1(logDistance)) * model.secondsPerMeter);
  const values = [
    logDistance,
    a,
    b,
    c,
    d,
    (c - a) * 111195.0802335329,
    (d - b) * 111195.0802335329 * Math.cos((((a + c) / 2) * Math.PI) / 180),
    Math.sin(hour),
    Math.cos(hour),
    Math.sin((day / 7) * 2 * Math.PI),
    Math.cos((day / 7) * 2 * Math.PI),
    Number(day === 0 || day === 6),
    ...summary(
      model.lookup.pairs.get(pairKey(input.originName, input.destinationName)),
      spatialLog,
      model.priorRows,
    ),
    ...summary(originEffect, 0, model.priorRows),
    ...summary(destinationEffect, 0, model.priorRows),
  ];
  return values.map((value) => Math.floor(value * 1e6 + 0.5) / 1e6);
}

function predictEnsemble(
  value: Checkpoint['models']['median'],
  features: readonly number[],
): number {
  let result = value.initial;
  for (const tree of value.trees) {
    let index = 0;
    while (!tree[index].leaf) {
      const entry = tree[index];
      index = features[entry.feature] <= entry.threshold ? entry.left : entry.right;
    }
    result += tree[index].value;
  }
  return result;
}

/** Quantiles plus the one-sided log calibration of the evaluated group; null outside the trained support. */
export function predictRailGate(
  model: RailGateCheckpoint,
  input: RailGateInput,
): RailGatePrediction | null {
  const features = railGateFeatures(model, input);
  if (!features) return null;
  for (const i of [0, 1, 2, 3, 4]) {
    const tolerance = i === 0 ? 0.15 * (model.domain.maximum[i] - model.domain.minimum[i]) : 0.015;
    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    )
      return null;
  }
  const day = holidayAsSunday(model.calendar)(input.startedAt)!,
    hour = new Date(input.startedAt + 9 * 3_600_000).getUTCHours();
  const part = RAIL_GATE_DAY_PARTS.find(([, from, to]) => hour >= from && hour < to)![0];
  const adjustment = model.conformal.find(
    (entry) => entry.group === `${day === 0 || day === 6 ? 'weekend' : 'weekday'}:${part}`,
  )!;
  const clip = (value: number) => Math.max(1, Math.min(10800, value));
  const median = clip(predictEnsemble(model.models.median, features));
  const lower = clip(Math.min(predictEnsemble(model.models.lower, features), median)),
    upper = clip(Math.max(predictEnsemble(model.models.upper, features), median));
  const lowerSeconds = lower / Math.exp(adjustment.logLower);
  return {
    lowerSeconds,
    medianSeconds: median,
    upperSeconds: Math.max(lowerSeconds, upper * Math.exp(adjustment.logUpper)),
  };
}
