import { z } from 'zod';
import type { EtaLearningFeatures } from '../../shared/intelligence/learning.js';
import type { SegmentMode } from '../../shared/domain/types.js';

export const CONTEXTUAL_MODEL_MAX_AGE_MS = 30 * 86_400_000;

export const CONTEXTUAL_MODES = [
  'walk',
  'run',
  'entry',
  'wait',
  'bus',
  'subway',
  'hire',
  'bicycle',
  'return',
  'taxi',
  'car',
  'scooter',
] as const;

const CONGESTION = ['unknown', 'free', 'slow', 'delay', 'jam'] as const;

export const CONTEXTUAL_FEATURE_NAMES: readonly string[] = Object.freeze([
  ...CONTEXTUAL_MODES.map((mode) => `mode:${mode}`),
  'logBaselineSeconds',
  'logDistanceMeters',
  'seoulHourSin',
  'seoulHourCos',
  'seoulDaySin',
  'seoulDayCos',
  'logPrecipitation',
  'precipitationMissing',
  'temperatureC',
  'temperatureMissing',
  'logWind',
  'windMissing',
  ...CONGESTION.map((level) => `congestion:${level}`),
  'logRoadDelay',
  'logPrecedingWait',
  'transferIndex',
  'liveWait',
]);

const DIMENSIONS = CONTEXTUAL_FEATURE_NAMES.length;
export const CONTEXTUAL_RIDGE_LAMBDA = 1;
export const CONTEXTUAL_LOG_RATIO_LIMIT = Math.log(4);
export const CONTEXTUAL_MIN_LOG_RADIUS = 0.03;
export const CONTEXTUAL_MAX_LOG_RADIUS = Math.log(2);

export const contextualFeatureSchema = z
  .object({
    mode: z.enum(CONTEXTUAL_MODES),
    predictedSeconds: z.number().finite().min(1).max(86_400),
    distanceMeters: z.number().finite().min(0).max(1_000_000),
    startedAt: z.number().int().positive().max(8_640_000_000_000_000),
    precipitationMm: z.number().finite().min(0).max(300).nullable(),
    temperatureC: z.number().finite().min(-50).max(60).nullable(),
    windMetersPerSecond: z.number().finite().min(0).max(75).nullable(),
    congestionLevel: z.enum(CONGESTION),
    roadDelaySeconds: z.number().finite().min(0).max(86_400),
    precedingWaitSeconds: z.number().finite().min(0).max(86_400),
    transferIndex: z.number().int().min(0).max(20),
    liveWait: z.boolean(),
  })
  .strict();

export interface ContextualDomain {
  minimum: number[];
  maximum: number[];
}

export interface ContextualNormalization {
  centers: number[];
  scales: number[];
  clip: 4;
}

export interface ContextualSplit {
  observations: number;
  groups: number;
  earliestStartedAt: number;
  latestObservedAt: number;
}

export interface ContextualEvaluation {
  /** Trip groups have equal weight; correlated segments do not create independent evidence. */
  baselineMaeSeconds: number;
  modelMaeSeconds: number;
  intervalCoverage: number;
  upperCoverage: number;
  meanRelativeWidth: number;
}

export interface ContextualModeModel {
  counts: {
    train: number;
    calibration: number;
    test: number;
  };
  groups: {
    train: number;
    calibration: number;
    test: number;
  };
  domain: ContextualDomain;
  logOffset: number;
  logRadius: number;
  evaluation: ContextualEvaluation;
}

export interface ContextualEtaModel {
  version: 'eta-context-v2';
  trainedAt: number;
  target: 'log-actual-over-predicted';
  labelSource: 'recorded-trip';
  /** Intercept first, then exactly featureNames order. */
  featureNames: string[];
  coefficients: number[];
  regularization: 1;
  normalization: ContextualNormalization;
  splits: {
    train: ContextualSplit;
    calibration: ContextualSplit;
    test: ContextualSplit;
  };
  modes: Partial<Record<SegmentMode, ContextualModeModel>>;
}

export interface ContextualEtaPrediction {
  medianSeconds: number;
  lowerSeconds: number;
  upperSeconds: number;
  modelVersion: 'eta-context-v2';
}

/** The feature order is versioned, with no coordinates or user identifiers. */
export function contextualFeatureVector(features: EtaLearningFeatures): number[] | null {
  const result = contextualFeatureSchema.safeParse(features);

  if (!result.success) {
    return null;
  }

  const value = result.data,
    local = new Date(value.startedAt + 9 * 3_600_000);

  if (!Number.isFinite(local.getTime())) {
    return null;
  }

  const hour =
    ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
    2 *
    Math.PI;
  const day = (local.getUTCDay() / 7) * 2 * Math.PI;

  return [
    ...CONTEXTUAL_MODES.map((mode) => Number(value.mode === mode)),
    Math.log(value.predictedSeconds),
    Math.log1p(value.distanceMeters),
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(day),
    Math.cos(day),
    Math.log1p(value.precipitationMm ?? 0),
    Number(value.precipitationMm === null),
    value.temperatureC ?? 0,
    Number(value.temperatureC === null),
    Math.log1p(value.windMetersPerSecond ?? 0),
    Number(value.windMetersPerSecond === null),
    ...CONGESTION.map((level) => Number(value.congestionLevel === level)),
    Math.log1p(value.roadDelaySeconds),
    Math.log1p(value.precedingWaitSeconds),
    value.transferIndex,
    Number(value.liveWait),
  ];
}

const limits: [number, number][] = [
  ...CONTEXTUAL_MODES.map((): [number, number] => [0, 1]),
  [0, Math.log(86_400)],
  [0, Math.log1p(1_000_000)],
  [-1, 1],
  [-1, 1],
  [-1, 1],
  [-1, 1],
  [0, Math.log1p(300)],
  [0, 1],
  [-50, 60],
  [0, 1],
  [0, Math.log1p(75)],
  [0, 1],
  ...CONGESTION.map((): [number, number] => [0, 1]),
  [0, Math.log1p(86_400)],
  [0, Math.log1p(86_400)],
  [0, 20],
  [0, 1],
];

const binary = (index: number) =>
  CONTEXTUAL_FEATURE_NAMES[index].startsWith('mode:') ||
  CONTEXTUAL_FEATURE_NAMES[index].startsWith('congestion:') ||
  /Missing$|^liveWait$/.test(CONTEXTUAL_FEATURE_NAMES[index]);

/** Clip moderate deviations for numerical robustness; refuse unsupported context instead of extrapolating. */
export function contextualStandardizedVector(
  raw: readonly number[],
  normalization: ContextualNormalization,
  domain?: ContextualDomain,
): number[] | null {
  if (raw.length !== DIMENSIONS) {
    return null;
  }

  const normalized: number[] = [];

  for (let index = 0; index < DIMENSIONS; index++) {
    const value = raw[index],
      scale = normalization.scales[index],
      center = normalization.centers[index];

    if (
      !Number.isFinite(value) ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(center)
    ) {
      return null;
    }

    if (domain) {
      const min = domain.minimum[index],
        max = domain.maximum[index];
      const tolerance = binary(index) ? 0 : Math.max(0.05, (max - min) * 0.15, scale * 0.25);

      if (
        !Number.isFinite(min) ||
        !Number.isFinite(max) ||
        value < min - tolerance ||
        value > max + tolerance
      ) {
        return null;
      }
    }

    const score = (value - center) / scale;

    if (domain && Math.abs(score) > 6) {
      return null;
    }

    normalized.push(Math.max(-normalization.clip, Math.min(normalization.clip, score)));
  }

  return normalized;
}

const finite = z.number().finite();
const vector = z.array(finite).length(DIMENSIONS);
const count = z.number().int().min(1).max(100_000);

const countTriple = z
  .object({
    train: count,
    calibration: count,
    test: count,
  })
  .strict();

const splitSchema = z
  .object({
    observations: count,
    groups: count,
    earliestStartedAt: z.number().int().positive(),
    latestObservedAt: z.number().int().positive(),
  })
  .strict();

const evaluationSchema = z
  .object({
    baselineMaeSeconds: finite.min(0).max(86_400),
    modelMaeSeconds: finite.min(0).max(86_400),
    intervalCoverage: finite.min(0).max(1),
    upperCoverage: finite.min(0).max(1),
    meanRelativeWidth: finite.positive().max(1.5),
  })
  .strict();

const modeSchema = z
  .object({
    counts: countTriple,
    groups: countTriple,
    domain: z
      .object({
        minimum: vector,
        maximum: vector,
      })
      .strict(),
    logOffset: finite.min(-CONTEXTUAL_LOG_RATIO_LIMIT).max(CONTEXTUAL_LOG_RATIO_LIMIT),
    logRadius: finite.min(CONTEXTUAL_MIN_LOG_RADIUS).max(CONTEXTUAL_MAX_LOG_RADIUS),
    evaluation: evaluationSchema,
  })
  .strict();

const modelSchema = z
  .object({
    version: z.literal('eta-context-v2'),
    trainedAt: z.number().int().positive(),
    target: z.literal('log-actual-over-predicted'),
    labelSource: z.literal('recorded-trip'),
    featureNames: z.array(z.string().max(80)).length(DIMENSIONS),
    coefficients: z.array(finite.min(-8).max(8)).length(DIMENSIONS + 1),
    regularization: z.literal(1),
    normalization: z
      .object({
        centers: vector,
        scales: z.array(finite.positive().min(0.000001).max(1000)).length(DIMENSIONS),
        clip: z.literal(4),
      })
      .strict(),
    splits: z
      .object({
        train: splitSchema,
        calibration: splitSchema,
        test: splitSchema,
      })
      .strict(),
    modes: z.partialRecord(z.enum(CONTEXTUAL_MODES), modeSchema),
  })
  .strict();

function checkedModel(value: unknown, now: number): ContextualEtaModel | null {
  if (!Number.isSafeInteger(now) || now <= 0) {
    return null;
  }

  const parsed = modelSchema.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const model = parsed.data;

  if (
    model.trainedAt > now ||
    now - model.trainedAt > CONTEXTUAL_MODEL_MAX_AGE_MS ||
    model.featureNames.some((name, index) => name !== CONTEXTUAL_FEATURE_NAMES[index])
  ) {
    return null;
  }

  if (
    model.normalization.centers.some(
      (center, index) =>
        center < limits[index][0] - 1e-9 ||
        center > limits[index][1] + 1e-9 ||
        (binary(index) && center !== 0 && center !== 1),
    )
  ) {
    return null;
  }

  const split = model.splits;

  if (
    split.train.groups < 30 ||
    split.calibration.groups < 10 ||
    split.test.groups < 10 ||
    split.train.latestObservedAt > split.calibration.earliestStartedAt ||
    split.calibration.latestObservedAt > split.test.earliestStartedAt ||
    Object.values(split).some(
      (value) =>
        value.observations < value.groups ||
        value.earliestStartedAt > value.latestObservedAt ||
        value.latestObservedAt > model.trainedAt ||
        value.earliestStartedAt < model.trainedAt - 91 * 86_400_000 ||
        value.latestObservedAt < model.trainedAt - 90 * 86_400_000,
    )
  ) {
    return null;
  }

  const modes = Object.entries(model.modes);

  if (!modes.length) {
    return null;
  }

  for (const [name, mode] of modes) {
    if (
      mode.groups.train < 30 ||
      mode.groups.calibration < 10 ||
      mode.groups.test < 10 ||
      mode.evaluation.modelMaeSeconds >= mode.evaluation.baselineMaeSeconds ||
      mode.evaluation.intervalCoverage < 0.8 ||
      mode.evaluation.upperCoverage < 0.9 ||
      mode.evaluation.upperCoverage < mode.evaluation.intervalCoverage
    ) {
      return null;
    }

    for (const partition of ['train', 'calibration', 'test'] as const) {
      if (
        mode.groups[partition] > split[partition].groups ||
        mode.counts[partition] < mode.groups[partition] ||
        mode.counts[partition] > split[partition].observations
      ) {
        return null;
      }
    }

    if (
      mode.domain.minimum.some(
        (min, index) =>
          min > mode.domain.maximum[index] ||
          min < limits[index][0] - 1e-9 ||
          mode.domain.maximum[index] > limits[index][1] + 1e-9,
      )
    ) {
      return null;
    }

    if (
      mode.domain.minimum.some(
        (min, index) =>
          binary(index) &&
          ((min !== 0 && min !== 1) ||
            (mode.domain.maximum[index] !== 0 && mode.domain.maximum[index] !== 1)),
      )
    ) {
      return null;
    }

    if (
      CONTEXTUAL_MODES.some(
        (modeName, index) =>
          mode.domain.minimum[index] !== Number(modeName === name) ||
          mode.domain.maximum[index] !== Number(modeName === name),
      )
    ) {
      return null;
    }
  }

  for (const partition of ['train', 'calibration', 'test'] as const) {
    if (
      modes.reduce((sum, [, mode]) => sum + mode.counts[partition], 0) >
      split[partition].observations
    ) {
      return null;
    }
  }

  return model as ContextualEtaModel;
}

/** Validation requires split-specific evidence and useful per-mode evaluation, not a trained:true flag. */
export function parseContextualEtaModel(raw: string, now = Date.now()): ContextualEtaModel {
  try {
    if (typeof raw !== 'string' || raw.length > 2_000_000) {
      throw new Error();
    }

    const model = checkedModel(JSON.parse(raw), now);

    if (model) {
      return model;
    }
  } catch {
    /* Never echo artifact contents. */
  }

  throw new Error('검증된 최근 문맥 ETA 모델 파일이 아닙니다.');
}

export function usableContextualEtaModel(model: unknown, now: number): model is ContextualEtaModel {
  return checkedModel(model, now) !== null;
}

/** log(actual / baseline) = intercept + sum(coefficient[i] * clipped robust feature[i]). */
export function contextualLogPrediction(
  raw: readonly number[],
  coefficients: readonly number[],
  normalization: ContextualNormalization,
  domain?: ContextualDomain,
): number | null {
  const vector = contextualStandardizedVector(raw, normalization, domain);

  if (!vector) {
    return null;
  }

  const result = vector.reduce(
    (sum, value, index) => sum + value * coefficients[index + 1],
    coefficients[0],
  );

  return Number.isFinite(result) && Math.abs(result) <= CONTEXTUAL_LOG_RATIO_LIMIT ? result : null;
}

export function contextualDurationRange(
  baseline: number,
  logRatio: number,
  logOffset: number,
  logRadius: number,
): ContextualEtaPrediction | null {
  const center = baseline * Math.exp(logRatio + logOffset),
    lower = center * Math.exp(-logRadius),
    upper = center * Math.exp(logRadius);

  if (
    ![center, lower, upper].every(Number.isFinite) ||
    center < 1 ||
    upper > 86_400 ||
    lower > upper
  ) {
    return null;
  }

  return {
    medianSeconds: Math.ceil(center),
    lowerSeconds: Math.max(1, Math.floor(lower)),
    upperSeconds: Math.ceil(upper),
    modelVersion: 'eta-context-v2',
  };
}

export function predictContextualEta(
  model: ContextualEtaModel,
  features: EtaLearningFeatures,
  now: number,
): ContextualEtaPrediction | null {
  const validated = checkedModel(model, now);

  if (!validated) {
    return null;
  }

  return predictValidatedContextualEta(validated, features);
}

function predictValidatedContextualEta(
  validated: ContextualEtaModel,
  features: EtaLearningFeatures,
): ContextualEtaPrediction | null {
  const mode = validated.modes[features?.mode],
    raw = contextualFeatureVector(features);

  if (!mode || !raw) {
    return null;
  }

  const ratio = contextualLogPrediction(
    raw,
    validated.coefficients,
    validated.normalization,
    mode.domain,
  );

  return ratio === null
    ? null
    : contextualDurationRange(features.predictedSeconds, ratio, mode.logOffset, mode.logRadius);
}

/** The schema creates a private snapshot. Caller mutation cannot bypass validation after preparation. */
export function prepareContextualEtaPredictor(
  model: ContextualEtaModel,
  now: number,
): ((features: EtaLearningFeatures, at: number) => ContextualEtaPrediction | null) | null {
  const validated = checkedModel(model, now);

  if (!validated) {
    return null;
  }

  return (features, at) => {
    if (
      !Number.isSafeInteger(at) ||
      at <= 0 ||
      validated.trainedAt > at ||
      at - validated.trainedAt > CONTEXTUAL_MODEL_MAX_AGE_MS
    ) {
      return null;
    }

    return predictValidatedContextualEta(validated, features);
  };
}
