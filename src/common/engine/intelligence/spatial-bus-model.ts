import { z } from 'zod';
import {
  calendarWeekday,
  holidayAsSunday,
  HOLIDAY_AS_SUNDAY,
  type SeoulWeekday,
} from './korean-holidays.js';

/** Explicit public stop geometry is required; this shadow model is not a route ETA. */
export const SPATIAL_BUS_FEATURE_NAMES = [
  'logRouteDistanceMeters',
  'logStopCount',
  'logMetersPerStop',
  'originLatitude',
  'originLongitude',
  'destinationLatitude',
  'destinationLongitude',
  'logEndpointMeters',
  'logCircuity',
  'northKilometers',
  'eastKilometers',
  'seoulHourSin',
  'seoulHourCos',
  'seoulWeekdaySin',
  'seoulWeekdayCos',
  'weekend',
] as const;
const N = SPATIAL_BUS_FEATURE_NAMES.length,
  finite = z.number().finite();
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
  .object({ initial: finite, trees: z.array(z.array(node).min(1).max(125)).min(1).max(220) })
  .strict();
const modelSchema = z
  .object({
    version: z.literal('seoul-bus-spatial-v2'),
    deployment: z.literal('shadow'),
    productionEligible: z.literal(false),
    target: z.literal('bus-tag-elapsed'),
    trainedAt: finite.int().positive(),
    trainingThrough: z.literal('2026-10-08'),
    featureNames: z.array(z.string()).length(N),
    models: z
      .object({ mean: ensemble, lower: ensemble, median: ensemble, upper: ensemble })
      .strict(),
    featureQuantization: z.literal('nearest-1e-10-ties-to-positive'),
    conformalSeconds: finite.min(0).max(10800),
    labelUncertaintySeconds: z.literal(60),
    domain: z
      .object({ minimum: z.array(finite).length(N), maximum: z.array(finite).length(N) })
      .strict(),
    inputSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(3),
    meanInterpretation: z.literal('conditional tag-elapsed mean, not validated route ETA'),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();
export type SpatialBusModel = z.infer<typeof modelSchema>;
export interface SpatialBusInput {
  startedAt: number;
  distanceMeters: number;
  stopCount: number;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
}

export function parseSpatialBusModel(text: string): SpatialBusModel {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('invalid-spatial-bus-model');
  const model = modelSchema.parse(JSON.parse(text));
  if (
    model.featureNames.some((name, i) => name !== SPATIAL_BUS_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((value, i) => value > model.domain.maximum[i])
  )
    throw new Error('invalid-bus-feature-contract');
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
          throw new Error('invalid-bus-tree');
        parents[entry.left]++;
        parents[entry.right]++;
      }
      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1))
        throw new Error('disconnected-bus-tree');
    }
  return model;
}

/** All features exist before boarding; observed duration, weather and private IDs are absent. */
export function spatialBusFeatures(
  input: SpatialBusInput,
  weekdayOf: SeoulWeekday = calendarWeekday,
): number[] | null {
  if (!input) return null;
  const {
    distanceMeters: distance,
    stopCount: stops,
    startedAt,
    originLatitude: a,
    originLongitude: b,
    destinationLatitude: c,
    destinationLongitude: d,
  } = input;
  if (
    ![distance, stops, startedAt, a, b, c, d].every(Number.isFinite) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    distance < 100 ||
    distance > 50000 ||
    !Number.isInteger(stops) ||
    stops < 1 ||
    stops > 500 ||
    a < 37.4 ||
    a > 37.72 ||
    c < 37.4 ||
    c > 37.72 ||
    b < 126.73 ||
    b > 127.28 ||
    d < 126.73 ||
    d > 127.28
  )
    return null;
  const rad = Math.PI / 180,
    hav = Math.max(
      0,
      Math.min(
        1,
        Math.sin(((c - a) * rad) / 2) ** 2 +
          Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2,
      ),
    );
  const endpoint = 6371000 * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
  if (endpoint > distance * 1.25 + 100) return null;
  const local = new Date(startedAt + 9 * 3600000),
    day = weekdayOf(startedAt);
  if (!Number.isFinite(local.getTime()) || day === null) return null;
  const hour =
      ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    weekday = (day / 7) * 2 * Math.PI;
  return [
    Math.log(distance),
    Math.log(stops),
    Math.log(distance / stops),
    a,
    b,
    c,
    d,
    Math.log(Math.max(10, endpoint)),
    Math.log(distance / Math.max(10, endpoint)),
    (c - a) * 111.1950802335329,
    (d - b) * 111.1950802335329 * Math.cos(((a + c) / 2) * rad),
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(weekday),
    Math.cos(weekday),
    Number(day === 0 || day === 6),
  ].map((value) => Math.round(value * 1e10) / 1e10);
}

function predictEnsemble(
  model: SpatialBusModel['models']['mean'],
  features: readonly number[],
): number {
  let result = model.initial;
  for (const tree of model.trees) {
    let index = 0;
    while (!tree[index].leaf) {
      const node = tree[index],
        value = features[node.feature];
      index = value <= node.threshold ? node.left : node.right;
    }
    result += tree[index].value;
  }
  return result;
}

export function predictSpatialBusRaw(model: SpatialBusModel, input: SpatialBusInput) {
  const features = spatialBusFeatures(input);
  if (!features) return null;
  const mean = predictEnsemble(model.models.mean, features),
    median = predictEnsemble(model.models.median, features),
    lower = predictEnsemble(model.models.lower, features),
    upper = predictEnsemble(model.models.upper, features);
  return { mean, median, lower, upper };
}

export function predictSpatialBusShadow(model: SpatialBusModel, input: SpatialBusInput) {
  const features = spatialBusFeatures(input);
  if (!features) return null;
  for (const i of [0, 1, 3, 4, 5, 6]) {
    const tolerance =
      i === 0 || i === 1
        ? Math.max(0.05, (model.domain.maximum[i] - model.domain.minimum[i]) * 0.15)
        : 0.015;
    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    )
      return null;
  }
  const raw = predictSpatialBusRaw(model, input);
  if (!raw) return null;
  const meanSeconds = Math.max(1, Math.min(10800, raw.mean)),
    medianSeconds = Math.max(1, Math.min(10800, raw.median));
  return {
    modelVersion: 'seoul-bus-spatial-v2' as const,
    target: 'bus-tag-elapsed' as const,
    deployment: 'shadow' as const,
    productionEligible: false as const,
    meanSeconds,
    medianSeconds,
    lowerSeconds: Math.max(0, Math.min(raw.lower, medianSeconds) - model.conformalSeconds - 60),
    upperSeconds: Math.max(raw.upper, medianSeconds) + model.conformalSeconds + 60,
  };
}

/** v3: holidays read as Sunday and a per day-type/day-part interval, served for 7 days like the public bus model. */
export const SPATIAL_BUS_V3 = 'seoul-bus-spatial-v3' as const;
export const SPATIAL_BUS_DAY_PARTS = [
  ['overnight', 0, 6],
  ['morning', 6, 10],
  ['daytime', 10, 17],
  ['evening', 17, 21],
  ['night', 21, 24],
] as const;
export const SPATIAL_BUS_GROUPS = (['weekday', 'weekend'] as const).flatMap((kind) =>
  SPATIAL_BUS_DAY_PARTS.map(([name]) => `${kind}:${name}`),
);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const logAdjustment = finite.min(-Math.log(4)).max(Math.log(4));
const operationalSchema = z
  .object({
    version: z.literal(SPATIAL_BUS_V3),
    deployment: z.literal('production'),
    target: z.literal('bus-tag-elapsed'),
    trainedAt: finite.int().positive(),
    expiresAt: finite.int().positive(),
    trainingThrough: isoDay,
    lastEvaluatedServiceDate: isoDay,
    featureNames: z.array(z.string()).length(N),
    models: z
      .object({ mean: ensemble, lower: ensemble, median: ensemble, upper: ensemble })
      .strict(),
    featureQuantization: z.literal('nearest-1e-10-ties-to-positive'),
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
      .length(SPATIAL_BUS_GROUPS.length),
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
    meanInterpretation: z.literal('conditional tag-elapsed mean, not validated route ETA'),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();
export type SpatialBusCheckpoint = z.infer<typeof operationalSchema>;

function checkTrees(models: SpatialBusCheckpoint['models']) {
  for (const value of Object.values(models))
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
          throw new Error('invalid-bus-tree');
        parents[entry.left]++;
        parents[entry.right]++;
      }
      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1))
        throw new Error('disconnected-bus-tree');
    }
}

export function parseSpatialBusCheckpoint(text: string): SpatialBusCheckpoint {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('invalid-spatial-bus-model');
  const model = operationalSchema.parse(JSON.parse(text));
  if (
    model.featureNames.some((name, i) => name !== SPATIAL_BUS_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((value, i) => value > model.domain.maximum[i]) ||
    model.conformal.some((entry, i) => entry.group !== SPATIAL_BUS_GROUPS[i]) ||
    model.expiresAt <= model.trainedAt ||
    model.expiresAt - model.trainedAt > 7 * 86_400_000 ||
    model.calendar.firstDate > model.calendar.lastDate ||
    model.calendar.holidays.some(
      (day) => day < model.calendar.firstDate || day > model.calendar.lastDate,
    )
  )
    throw new Error('invalid-bus-feature-contract');
  checkTrees(model.models);
  return model;
}

export interface SpatialBusEnvelope {
  meanSeconds: number;
  medianSeconds: number;
  lowerSeconds: number;
  upperSeconds: number;
}
/** Same support, quantiles and one-sided log calibration as the trainer; null when outside the trained domain or calendar. */
export function predictSpatialBusEnvelope(
  model: Pick<SpatialBusCheckpoint, 'models' | 'domain' | 'conformal' | 'calendar'>,
  input: SpatialBusInput,
): SpatialBusEnvelope | null {
  const weekdayOf = holidayAsSunday(model.calendar),
    features = spatialBusFeatures(input, weekdayOf);
  if (!features) return null;
  for (const i of [0, 1, 3, 4, 5, 6]) {
    const tolerance =
      i === 0 || i === 1
        ? Math.max(0.05, (model.domain.maximum[i] - model.domain.minimum[i]) * 0.15)
        : 0.015;
    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    )
      return null;
  }
  const day = weekdayOf(input.startedAt)!,
    hour = new Date(input.startedAt + 9 * 3600000).getUTCHours();
  const part = SPATIAL_BUS_DAY_PARTS.find(([, from, to]) => hour >= from && hour < to)![0];
  const adjustment = model.conformal.find(
    (entry) => entry.group === `${day === 0 || day === 6 ? 'weekend' : 'weekday'}:${part}`,
  )!;
  const clip = (value: number) => Math.max(1, Math.min(10800, value));
  const mean = predictEnsemble(model.models.mean, features),
    median = clip(predictEnsemble(model.models.median, features));
  const lower = clip(Math.min(predictEnsemble(model.models.lower, features), median)),
    upper = clip(Math.max(predictEnsemble(model.models.upper, features), median));
  const lowerSeconds = lower / Math.exp(adjustment.logLower);
  return {
    meanSeconds: clip(mean),
    medianSeconds: median,
    lowerSeconds,
    upperSeconds: Math.max(lowerSeconds, upper * Math.exp(adjustment.logUpper)),
  };
}
