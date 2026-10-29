import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Offline gate/first-last-tag elapsed targets. Neither includes the app's initial/final walk. */
export const SPATIAL_TRANSIT_FEATURE_NAMES = [
  'log1pEndpointMeters',
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
  'busLegCount',
  'railLegCount',
  'transferCount',
  'startsOnBus',
  'endsOnBus',
] as const;

const N = SPATIAL_TRANSIT_FEATURE_NAMES.length;
const finite = z.number().finite(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);

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

const ensembleSchema = z
  .object({
    initial: finite,
    trees: z.array(z.array(nodeSchema).min(1).max(63)).min(1).max(180),
  })
  .strict();

const modelSchema = z
  .object({
    version: z.literal('seoul-transit-spatial-v1'),
    kind: z.enum(['rail', 'transit-chain']),
    target: z.enum(['rail-gate-elapsed', 'transit-chain-elapsed']),
    region: z.literal('seoul'),
    deployment: z.literal('shadow'),
    productionEligible: z.literal(false),
    trainedAt: finite.int().positive().max(8_640_000_000_000_000),
    featureNames: z.array(z.string()).length(N),
    featureQuantizationDecimals: z.literal(6),
    models: z
      .object({
        lower: ensembleSchema,
        median: ensembleSchema,
        upper: ensembleSchema,
      })
      .strict(),
    conformalSeconds: finite.min(0).max(21600),
    labelUncertaintySeconds: z.literal(60),
    domain: z
      .object({
        minimum: z.array(finite).length(N),
        maximum: z.array(finite).length(N),
      })
      .strict(),
    trainingThrough: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/),
    inputSha256: hash,
    protocolSha256: hash,
    assessmentAlreadyInspected: z.literal(true),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();

export type SpatialTransitModel = z.infer<typeof modelSchema>;

export interface SpatialTransitInput {
  startedAt: number;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
  /** Requested route order; do not substitute later actual transfer times or outcomes. */
  modeSequence: readonly ('bus' | 'subway')[];
}

export function parseSpatialTransitModel(text: string): SpatialTransitModel {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) {
    throw new Error('invalid-spatial-transit-model');
  }

  const model = modelSchema.parse(JSON.parse(text));

  if (model.target !== (model.kind === 'rail' ? 'rail-gate-elapsed' : 'transit-chain-elapsed')) {
    throw new Error('invalid-spatial-transit-target');
  }

  if (
    model.featureNames.some((name, i) => name !== SPATIAL_TRANSIT_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((min, i) => min > model.domain.maximum[i])
  ) {
    throw new Error('invalid-spatial-transit-features');
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
          throw new Error('invalid-spatial-transit-tree');
        }

        parents[node.left]++;
        parents[node.right]++;
      }

      if (parents[0] !== 0 || parents.slice(1).some((value) => value !== 1)) {
        throw new Error('disconnected-spatial-transit-tree');
      }
    }
  }

  return model;
}

/** Spatial/time/plan descriptors only; no identity, historical OD table or observed result. */
export function spatialTransitFeatures(input: SpatialTransitInput): number[] | null {
  if (
    !input ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0 ||
    !Array.isArray(input.modeSequence)
  ) {
    return null;
  }

  const {
    originLatitude: a,
    originLongitude: b,
    destinationLatitude: c,
    destinationLongitude: d,
    modeSequence: modes,
  } = input;

  if (
    ![a, b, c, d].every(Number.isFinite) ||
    !(36 < a && a < 39 && 36 < c && c < 39 && 125 < b && b < 130 && 125 < d && d < 130)
  ) {
    return null;
  }

  if (
    modes.length < 1 ||
    modes.length > 5 ||
    modes.some((mode) => mode !== 'bus' && mode !== 'subway')
  ) {
    return null;
  }

  const rad = Math.PI / 180,
    v =
      Math.sin(((c - a) * rad) / 2) ** 2 +
      Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));

  if (distance > 200000) {
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
    Math.log1p(distance),
    a,
    b,
    c,
    d,
    north,
    east,
    norm ? east / norm : 0,
    norm ? north / norm : 0,
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(day),
    Math.cos(day),
    Number(local.getUTCDay() === 0 || local.getUTCDay() === 6),
    modes.filter((mode) => mode === 'bus').length,
    modes.filter((mode) => mode === 'subway').length,
    modes.length - 1,
    Number(modes[0] === 'bus'),
    Number(modes.at(-1) === 'bus'),
  ].map((value) => Math.floor(value * 1_000_000 + 0.5) / 1_000_000);
}

function compatible(model: SpatialTransitModel, input: SpatialTransitInput) {
  return model.kind === 'rail'
    ? input.modeSequence.length === 1 && input.modeSequence[0] === 'subway'
    : input.modeSequence.includes('bus') && input.modeSequence.includes('subway');
}

function ensemblePrediction(
  model: SpatialTransitModel['models']['median'],
  features: readonly number[],
) {
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

/** Independent Python/TypeScript numeric parity entry point. */
export function predictSpatialTransitRaw(model: SpatialTransitModel, input: SpatialTransitInput) {
  const features = spatialTransitFeatures(input);

  if (!features || !compatible(model, input)) {
    return null;
  }

  return {
    lower: ensemblePrediction(model.models.lower, features),
    median: ensemblePrediction(model.models.median, features),
    upper: ensemblePrediction(model.models.upper, features),
  };
}

export function predictSpatialTransitShadow(
  model: SpatialTransitModel,
  input: SpatialTransitInput,
) {
  const features = spatialTransitFeatures(input);

  if (!features || !compatible(model, input)) {
    return null;
  }

  for (const i of [0, 1, 2, 3, 4, 14, 15, 16, 17, 18]) {
    const tolerance =
      i === 0 ? 0.15 * (model.domain.maximum[i] - model.domain.minimum[i]) : i < 5 ? 0.015 : 0;

    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    ) {
      return null;
    }
  }

  const raw = predictSpatialTransitRaw(model, input)!;
  const medianSeconds = Math.max(1, Math.min(model.kind === 'rail' ? 10800 : 21600, raw.median));
  const lowerSeconds = Math.max(
      0,
      Math.min(raw.lower, medianSeconds) - model.conformalSeconds - 60,
    ),
    upperSeconds = Math.max(raw.upper, medianSeconds) + model.conformalSeconds + 60;

  if (![lowerSeconds, medianSeconds, upperSeconds].every(Number.isFinite)) {
    return null;
  }

  return {
    modelVersion: model.version,
    target: model.target,
    deployment: 'shadow' as const,
    productionEligible: false as const,
    lowerSeconds,
    medianSeconds,
    upperSeconds,
  };
}

const metric = finite.min(0),
  fraction = metric.max(1);

const evaluationSchema = z
  .object({
    rows: metric.int(),
    supported: metric.int(),
    unsupported: metric.int(),
    modelMaeSeconds: metric.nullable(),
    supportedModelMaeSeconds: metric.nullable(),
    supportedBaselineMaeSeconds: metric.nullable(),
    supportedRidgeMaeSeconds: metric.nullable(),
    robustIntervalCoverage: fraction,
    robustUpperCoverage: fraction,
    meanRelativeWidth: metric.nullable(),
  })
  .strict();

const reportSchema = z.object({
  version: z.literal('seoul-transit-spatial-v1'),
  kind: z.enum(['rail', 'transit-chain']),
  target: z.enum(['rail-gate-elapsed', 'transit-chain-elapsed']),
  deployment: z.literal('shadow'),
  productionEligible: z.literal(false),
  assessmentAlreadyInspected: z.literal(true),
  qualityPassed: z.boolean(),
  qualityFailedGroups: z.array(z.string()),
  counts: z.object({
    unsupportedCalibration: metric.int(),
  }),
  evaluations: z
    .object({
      all: evaluationSchema,
      seenOd: evaluationSchema.nullable(),
      unseenOd: evaluationSchema.nullable(),
      heldOutCard: evaluationSchema.nullable(),
      dayParts: z
        .object({
          night: evaluationSchema.nullable(),
          morning: evaluationSchema.nullable(),
          daytime: evaluationSchema.nullable(),
          evening: evaluationSchema.nullable(),
          late: evaluationSchema.nullable(),
        })
        .strict(),
    })
    .strict(),
  reproducibility: z.object({
    modelSha256: hash,
    protocolSha256: hash,
    inputSha256: hash,
  }),
});

/** Recomputes offline gates and binds a report to exact model bytes. Never authorizes navigation. */
export function inspectSpatialTransitCandidate(modelText: string, reportText: string) {
  if (typeof reportText !== 'string' || Buffer.byteLength(reportText) > 1024 * 1024) {
    throw new Error('invalid-spatial-transit-report');
  }

  const model = parseSpatialTransitModel(modelText),
    report = reportSchema.parse(JSON.parse(reportText));

  if (
    report.kind !== model.kind ||
    report.target !== model.target ||
    report.reproducibility.inputSha256 !== model.inputSha256 ||
    report.reproducibility.protocolSha256 !== model.protocolSha256 ||
    report.reproducibility.modelSha256 !== createHash('sha256').update(modelText).digest('hex')
  ) {
    throw new Error('spatial-transit-report-model-mismatch');
  }

  const { all, seenOd, unseenOd, heldOutCard, dayParts } = report.evaluations;

  if (
    (seenOd?.rows ?? 0) + (unseenOd?.rows ?? 0) !== all.rows ||
    Object.values(dayParts).reduce((n, v) => n + (v?.rows ?? 0), 0) !== all.rows ||
    (heldOutCard?.rows ?? 0) > all.rows
  ) {
    throw new Error('invalid-spatial-transit-denominator');
  }

  const groups = {
    all,
    seenOd,
    unseenOd,
    heldOutCard,
    ...Object.fromEntries(
      Object.entries(dayParts).map(([key, value]) => [`dayPart:${key}`, value]),
    ),
  };

  const failedGroups: string[] = [];

  for (const [name, value] of Object.entries(groups)) {
    if (
      value &&
      (value.rows !== value.supported + value.unsupported ||
        value.robustUpperCoverage + 1e-12 < value.robustIntervalCoverage ||
        value.robustUpperCoverage > value.supported / Math.max(1, value.rows) + 1e-12 ||
        (value.modelMaeSeconds === null) !== (value.unsupported > 0 || value.supported === 0) ||
        (value.modelMaeSeconds !== null &&
          Math.abs(value.modelMaeSeconds - (value.supportedModelMaeSeconds ?? Infinity)) > 1e-8))
    ) {
      throw new Error('invalid-spatial-transit-metrics');
    }

    if (
      !value ||
      value.rows < 100 ||
      value.unsupported !== 0 ||
      value.modelMaeSeconds === null ||
      value.supportedBaselineMaeSeconds === null ||
      value.supportedRidgeMaeSeconds === null ||
      value.modelMaeSeconds >=
        Math.min(value.supportedBaselineMaeSeconds, value.supportedRidgeMaeSeconds) ||
      value.robustIntervalCoverage < 0.8 ||
      value.robustUpperCoverage < 0.9 ||
      value.meanRelativeWidth === null ||
      value.meanRelativeWidth > 1.5
    ) {
      failedGroups.push(name);
    }
  }

  if (report.counts.unsupportedCalibration) {
    failedGroups.push('unsupportedCalibration');
  }

  if (
    report.qualityPassed !== !failedGroups.length ||
    [...report.qualityFailedGroups].sort().join('|') !== [...failedGroups].sort().join('|')
  ) {
    throw new Error('spatial-transit-quality-claim-mismatch');
  }

  return {
    kind: model.kind,
    target: model.target,
    offlineQualityPassed: failedGroups.length === 0,
    failedGroups,
    deployment: 'shadow' as const,
    productionEligible: false as const,
    reasons: [
      'already-inspected-assessment',
      'coordinate-snapshot-historical-vintage-unverified',
      'no-initial-final-app-walk',
      'no-contemporaneous-provider-baseline',
      'offline-shadow-only',
    ],
  };
}
