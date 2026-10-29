import { z } from 'zod';

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
  .object({
    initial: finite,
    trees: z.array(z.array(node).min(1).max(125)).min(1).max(220),
  })
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
      .object({
        mean: ensemble,
        lower: ensemble,
        median: ensemble,
        upper: ensemble,
      })
      .strict(),
    featureQuantization: z.literal('nearest-1e-10-ties-to-positive'),
    conformalSeconds: finite.min(0).max(10800),
    labelUncertaintySeconds: z.literal(60),
    domain: z
      .object({
        minimum: z.array(finite).length(N),
        maximum: z.array(finite).length(N),
      })
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
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024) {
    throw new Error('invalid-spatial-bus-model');
  }

  const model = modelSchema.parse(JSON.parse(text));

  if (
    model.featureNames.some((name, i) => name !== SPATIAL_BUS_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((value, i) => value > model.domain.maximum[i])
  ) {
    throw new Error('invalid-bus-feature-contract');
  }

  for (const value of Object.values(model.models)) {
    for (const tree of value.trees) {
      const parents = Array<number>(tree.length).fill(0);

      for (let index = 0; index < tree.length; index++) {
        const entry = tree[index];

        if (entry.leaf) {
          continue;
        }

        if (
          entry.left <= index ||
          entry.right <= index ||
          entry.left >= tree.length ||
          entry.right >= tree.length ||
          entry.left === entry.right
        ) {
          throw new Error('invalid-bus-tree');
        }

        parents[entry.left]++;
        parents[entry.right]++;
      }

      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1)) {
        throw new Error('disconnected-bus-tree');
      }
    }
  }

  return model;
}

/** All features exist before boarding; observed duration, weather and private IDs are absent. */
export function spatialBusFeatures(input: SpatialBusInput): number[] | null {
  if (!input) {
    return null;
  }

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
  ) {
    return null;
  }

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

  if (endpoint > distance * 1.25 + 100) {
    return null;
  }

  const local = new Date(startedAt + 9 * 3600000);

  if (!Number.isFinite(local.getTime())) {
    return null;
  }

  const hour =
      ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    weekday = (local.getUTCDay() / 7) * 2 * Math.PI;

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
    Number(local.getUTCDay() === 0 || local.getUTCDay() === 6),
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

  if (!features) {
    return null;
  }

  const mean = predictEnsemble(model.models.mean, features),
    median = predictEnsemble(model.models.median, features),
    lower = predictEnsemble(model.models.lower, features),
    upper = predictEnsemble(model.models.upper, features);

  return {
    mean,
    median,
    lower,
    upper,
  };
}

export function predictSpatialBusShadow(model: SpatialBusModel, input: SpatialBusInput) {
  const features = spatialBusFeatures(input);

  if (!features) {
    return null;
  }

  for (const i of [0, 1, 3, 4, 5, 6]) {
    const tolerance =
      i === 0 || i === 1
        ? Math.max(0.05, (model.domain.maximum[i] - model.domain.minimum[i]) * 0.15)
        : 0.015;

    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    ) {
      return null;
    }
  }

  const raw = predictSpatialBusRaw(model, input);

  if (!raw) {
    return null;
  }

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
