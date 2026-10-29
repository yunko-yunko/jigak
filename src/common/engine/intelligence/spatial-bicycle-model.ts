import { z } from 'zod';

/** Offline Seoul rental-time model. This is never a pure riding-time label. */
export const SPATIAL_BICYCLE_FEATURE_NAMES = [
  'logEndpointMeters',
  'originLatitude',
  'originLongitude',
  'destinationLatitude',
  'destinationLongitude',
  'northMeters',
  'eastMeters',
  'bearingSin',
  'bearingCos',
  'seoulHourSin',
  'seoulHourCos',
  'seoulWeekdaySin',
  'seoulWeekdayCos',
  'weekend',
] as const;

const N = SPATIAL_BICYCLE_FEATURE_NAMES.length;
const finite = z.number().finite();

const nodeSchema = z
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

const treeSchema = z.array(nodeSchema).min(1).max(63);

const ensembleSchema = z
  .object({
    initial: finite,
    trees: z.array(treeSchema).min(1).max(180),
  })
  .strict();

const hash = z.string().regex(/^[a-f0-9]{64}$/);

const modelSchema = z
  .object({
    version: z.literal('seoul-bicycle-spatial-v1'),
    deployment: z.literal('shadow'),
    productionEligible: z.literal(false),
    target: z.literal('bicycle-rental-elapsed'),
    region: z.literal('seoul'),
    trainedAt: finite.int().positive(),
    featureNames: z.array(z.string()).length(N),
    models: z
      .object({
        lower: ensembleSchema,
        median: ensembleSchema,
        upper: ensembleSchema,
      })
      .strict(),
    conformalSeconds: finite.min(0).max(10800),
    labelUncertaintySeconds: z.literal(1),
    domain: z
      .object({
        minimum: z.array(finite).length(N),
        maximum: z.array(finite).length(N),
      })
      .strict(),
    trainingThrough: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
    sourceArchiveSha256: z.array(hash).min(1).max(12),
    inputSha256: z.array(hash).min(1).max(12),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();

export type SpatialBicycleModel = z.infer<typeof modelSchema>;

export interface SpatialBicycleInput {
  startedAt: number;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
}

/** A forward-only connected tree is bounded and cannot form an inference loop. */
export function parseSpatialBicycleModel(text: string): SpatialBicycleModel {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) {
    throw new Error('invalid-spatial-bicycle-model');
  }

  const model = modelSchema.parse(JSON.parse(text));

  if (
    model.featureNames.some((name, i) => name !== SPATIAL_BICYCLE_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((min, i) => min > model.domain.maximum[i])
  ) {
    throw new Error('invalid-spatial-feature-contract');
  }

  for (const ensemble of Object.values(model.models)) {
    for (const tree of ensemble.trees) {
      const parents = Array<number>(tree.length).fill(0);

      for (let index = 0; index < tree.length; index++) {
        const node = tree[index];

        if (node.leaf) {
          continue;
        }

        if (
          node.left <= index ||
          node.right <= index ||
          node.left >= tree.length ||
          node.right >= tree.length ||
          node.left === node.right
        ) {
          throw new Error('invalid-spatial-tree');
        }

        parents[node.left]++;
        parents[node.right]++;
      }

      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1)) {
        throw new Error('disconnected-spatial-tree');
      }
    }
  }

  return model;
}

/** Uses requested station endpoints and departure time only; no observed trip outcomes. */
export function spatialBicycleFeatures(input: SpatialBicycleInput): number[] | null {
  if (
    !input ||
    !Object.values(input).every(Number.isFinite) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0
  ) {
    return null;
  }

  const {
    originLatitude: a,
    originLongitude: b,
    destinationLatitude: c,
    destinationLongitude: d,
  } = input;

  if (!(a > 37 && a < 38 && c > 37 && c < 38 && b > 126 && b < 128 && d > 126 && d < 128)) {
    return null;
  }

  const rad = Math.PI / 180,
    v =
      Math.sin(((c - a) * rad) / 2) ** 2 +
      Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));

  if (distance < 100 || distance > 20000) {
    return null;
  }

  const north = (c - a) * 111195.0802335329,
    east = (d - b) * 111195.0802335329 * Math.cos(((a + c) / 2) * rad),
    norm = Math.hypot(north, east);
  const local = new Date(input.startedAt + 9 * 3600000);

  if (!Number.isFinite(local.getTime())) {
    return null;
  }

  const hour =
      ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    day = (local.getUTCDay() / 7) * 2 * Math.PI;

  return [
    Math.log(distance),
    a,
    b,
    c,
    d,
    north,
    east,
    east / norm,
    north / norm,
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(day),
    Math.cos(day),
    Number(local.getUTCDay() === 0 || local.getUTCDay() === 6),
  ];
}

function ensemblePrediction(
  model: SpatialBicycleModel['models']['median'],
  features: readonly number[],
): number {
  let result = model.initial;

  for (const tree of model.trees) {
    let index = 0;

    while (!tree[index].leaf) {
      const node = tree[index];

      index = features[node.feature] <= node.threshold ? node.left : node.right;
    }

    result += tree[index].value;
  }

  return result;
}

/** Exported for independent Python/TypeScript numerical parity verification. */
export function predictSpatialBicycleRaw(model: SpatialBicycleModel, input: SpatialBicycleInput) {
  const features = spatialBicycleFeatures(input);

  if (!features) {
    return null;
  }

  return {
    lower: ensemblePrediction(model.models.lower, features),
    median: ensemblePrediction(model.models.median, features),
    upper: ensemblePrediction(model.models.upper, features),
  };
}

export function predictSpatialBicycleShadow(
  model: SpatialBicycleModel,
  input: SpatialBicycleInput,
) {
  const features = spatialBicycleFeatures(input);

  if (!features) {
    return null;
  }

  for (const i of [0, 1, 2, 3, 4]) {
    const tolerance = i === 0 ? 0.15 * (model.domain.maximum[i] - model.domain.minimum[i]) : 0.015;

    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    ) {
      return null;
    }
  }

  const raw = predictSpatialBicycleRaw(model, input)!;
  const medianSeconds = Math.max(1, Math.min(10800, raw.median));
  const lowerSeconds = Math.max(0, Math.min(raw.lower, medianSeconds) - model.conformalSeconds - 1);
  const upperSeconds = Math.max(raw.upper, medianSeconds) + model.conformalSeconds + 1;

  if (![lowerSeconds, medianSeconds, upperSeconds].every(Number.isFinite)) {
    return null;
  }

  return {
    modelVersion: 'seoul-bicycle-spatial-v1' as const,
    target: 'bicycle-rental-elapsed' as const,
    deployment: 'shadow' as const,
    productionEligible: false as const,
    lowerSeconds,
    medianSeconds,
    upperSeconds,
  };
}
