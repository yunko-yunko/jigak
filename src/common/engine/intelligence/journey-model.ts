import { z } from 'zod';
import {
  JOURNEY_MODES,
  journeyFeaturesSchema,
  journeyObservationSchema,
  type JourneyLearningFeatures,
  type JourneyLearningObservation,
} from '../../shared/intelligence/journeyLearning.js';

export const JOURNEY_MODEL_MAX_AGE_MS = 30 * 86_400_000;

export const JOURNEY_FEATURE_NAMES = Object.freeze([
  ...JOURNEY_MODES.map((mode) => `share:${mode}`),
  'logBaselineSeconds',
  'logDistanceMeters',
  'seoulHourSin',
  'seoulHourCos',
  'seoulDaySin',
  'seoulDayCos',
  'logTransfers',
  'logVehicleLegs',
  'logPrecipitation',
  'precipitationMissing',
  'temperatureC',
  'temperatureMissing',
  'logWind',
  'windMissing',
  'logRoadDelay',
  'logSegmentCount',
]);

const DIMENSIONS = JOURNEY_FEATURE_NAMES.length,
  DAY = 86_400_000,
  LOG_LIMIT = Math.log(4),
  MIN_RADIUS = 0.03,
  MAX_RADIUS = Math.log(2);

const FEATURE_LIMITS: [number, number][] = [
  ...JOURNEY_MODES.map((): [number, number] => [0, 1.001001]),
  [0, Math.log(86_400)],
  [0, Math.log1p(500_000)],
  [-1, 1],
  [-1, 1],
  [-1, 1],
  [-1, 1],
  [0, Math.log1p(99)],
  [0, Math.log1p(100)],
  [0, Math.log1p(300)],
  [0, 1],
  [-50, 60],
  [0, 1],
  [0, Math.log1p(75)],
  [0, 1],
  [0, Math.log1p(86_400)],
  [0, Math.log1p(100)],
];

const MOVEMENT = new Set(['walk', 'run', 'bus', 'subway', 'bicycle', 'taxi', 'car', 'scooter']);

export function journeyCombination(features: JourneyLearningFeatures): string {
  return features.modeSequence
    .filter((mode) => MOVEMENT.has(mode))
    .filter((mode, index, all) => index === 0 || mode !== all[index - 1])
    .join('>');
}

export interface JourneyNormalization {
  centers: number[];
  scales: number[];
  clip: 4;
}

export interface JourneyDomain {
  minimum: number[];
  maximum: number[];
}

export interface JourneyEvaluation {
  observations: number;
  baselineMaeSeconds: number;
  modelMaeSeconds: number;
  intervalCoverage: number;
  upperCoverage: number;
  meanRelativeWidth: number;
}

export interface JourneySplit {
  observations: number;
  serviceDays: number;
  earliestStartedAt: number;
  latestObservedAt: number;
}

export interface JourneyCombinationModel {
  counts: {
    train: number;
    calibration: number;
    test: number;
  };
  domain: JourneyDomain;
  logOffset: number;
  logRadius: number;
  evaluation: JourneyEvaluation;
  unseenPaths: JourneyEvaluation;
}

export interface JourneyEtaModel {
  version: 'eta-journey-v1';
  trainedAt: number;
  labelSource: 'recorded-journey';
  target: 'log-actual-whole-over-routed-timeline';
  policy: 'rank-only-conservative-envelope';
  legModelProfile: string;
  featureNames: string[];
  coefficients: number[];
  regularization: 1;
  normalization: JourneyNormalization;
  splits: {
    train: JourneySplit;
    calibration: JourneySplit;
    test: JourneySplit;
  };
  combinations: Record<string, JourneyCombinationModel>;
}

export interface JourneyEtaPrediction {
  modelVersion: 'eta-journey-v1';
  policy: 'rank-only-conservative-envelope';
  lowerSeconds: number;
  medianSeconds: number;
  upperSeconds: number;
}

export interface JourneyTrainingReport {
  version: 'eta-journey-v1';
  trainedAt: number;
  model?: JourneyEtaModel;
  reasons: string[];
  rankingEvidence: 'observed-selected-journey-only';
  counts: {
    input: number;
    accepted: number;
    rejected: number;
    duplicate: number;
    train: number;
    calibration: number;
    test: number;
    purged: number;
  };
  normalization?: JourneyNormalization;
  evaluations: Record<
    string,
    {
      all: JourneyEvaluation | null;
      unseenPaths: JourneyEvaluation | null;
    }
  >;
  /** Leave-one-combination-out fit probes are diagnostic, never promoted as a new supported combination. */
  combinationHoldouts: Record<
    string,
    {
      observations: number;
      supported: number;
      baselineMaeSeconds: number | null;
      modelMaeSeconds: number | null;
    }
  >;
}

type Encoded = {
  row: JourneyLearningObservation;
  raw: number[];
  combination: string;
};

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const quantile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
};

const dayKey = (stamp: number) => new Date(stamp + 9 * 3_600_000).toISOString().slice(0, 10);

function vector(features: JourneyLearningFeatures): number[] | null {
  const parsed = journeyFeaturesSchema.safeParse(features);

  if (!parsed.success) {
    return null;
  }

  const value = parsed.data,
    local = new Date(value.startedAt + 9 * 3_600_000);

  if (!Number.isFinite(local.getTime())) {
    return null;
  }

  const hour =
      ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    day = (local.getUTCDay() / 7) * 2 * Math.PI;

  return [
    ...JOURNEY_MODES.map((mode) => value.modeSeconds[mode] / value.predictedSeconds),
    Math.log(value.predictedSeconds),
    Math.log1p(value.distanceMeters),
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(day),
    Math.cos(day),
    Math.log1p(value.transfers),
    Math.log1p(value.vehicleLegs),
    Math.log1p(value.precipitationMm ?? 0),
    Number(value.precipitationMm === null),
    value.temperatureC ?? 0,
    Number(value.temperatureC === null),
    Math.log1p(value.windMetersPerSecond ?? 0),
    Number(value.windMetersPerSecond === null),
    Math.log1p(value.roadDelaySeconds),
    Math.log1p(value.modeSequence.length),
  ];
}

function standardized(
  raw: readonly number[],
  normalization: JourneyNormalization,
  domain?: JourneyDomain,
): number[] | null {
  if (raw.length !== DIMENSIONS) {
    return null;
  }

  const result: number[] = [];

  for (let index = 0; index < DIMENSIONS; index++) {
    const value = raw[index],
      scale = normalization.scales[index],
      center = normalization.centers[index];

    if (
      !Number.isFinite(value) ||
      !Number.isFinite(center) ||
      !Number.isFinite(scale) ||
      scale <= 0
    ) {
      return null;
    }

    if (domain) {
      const min = domain.minimum[index],
        max = domain.maximum[index],
        binary = /Missing$/.test(JOURNEY_FEATURE_NAMES[index]);
      const tolerance = binary ? 0 : Math.max(0.05, (max - min) * 0.15, scale * 0.25);

      if (
        value < min - tolerance ||
        value > max + tolerance ||
        Math.abs((value - center) / scale) > 6
      ) {
        return null;
      }
    }

    result.push(Math.max(-4, Math.min(4, (value - center) / scale)));
  }

  return result;
}

function ratio(
  raw: readonly number[],
  coefficients: readonly number[],
  normalization: JourneyNormalization,
  domain?: JourneyDomain,
): number | null {
  const encoded = standardized(raw, normalization, domain);

  if (!encoded) {
    return null;
  }

  const predicted = encoded.reduce(
    (sum, value, index) => sum + value * coefficients[index + 1],
    coefficients[0],
  );

  return Number.isFinite(predicted) && Math.abs(predicted) <= LOG_LIMIT ? predicted : null;
}

function range(
  baseline: number,
  predicted: number,
  offset: number,
  radius: number,
): JourneyEtaPrediction | null {
  const median = baseline * Math.exp(predicted + offset),
    lower = median * Math.exp(-radius),
    upper = median * Math.exp(radius);

  if (![lower, median, upper].every(Number.isFinite) || lower < 1 || upper > 86_400) {
    return null;
  }

  return {
    modelVersion: 'eta-journey-v1',
    policy: 'rank-only-conservative-envelope',
    lowerSeconds: Math.floor(lower),
    medianSeconds: Math.ceil(median),
    upperSeconds: Math.ceil(upper),
  };
}

function fit(rows: readonly Encoded[], normalization: JourneyNormalization): number[] | null {
  const width = DIMENSIONS + 1,
    matrix = Array.from(
      {
        length: width,
      },
      () => Array<number>(width + 1).fill(0),
    );

  for (const { row, raw } of rows) {
    const encoded = standardized(raw, normalization);

    if (!encoded) {
      return null;
    }

    const values = [1, ...encoded],
      target = Math.log(row.actualSeconds / row.features.predictedSeconds);

    for (let left = 0; left < width; left++) {
      for (let right = 0; right < width; right++) {
        matrix[left][right] += values[left] * values[right];
      }

      matrix[left][width] += values[left] * target;
    }
  }

  for (let index = 0; index < width; index++) {
    matrix[index][index] += index === 0 ? 1e-8 : 1;
  }

  for (let column = 0; column < width; column++) {
    let pivot = column;

    for (let row = column + 1; row < width; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }

    if (!Number.isFinite(matrix[pivot][column]) || Math.abs(matrix[pivot][column]) < 1e-10) {
      return null;
    }

    [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];

    const divisor = matrix[column][column];

    for (let index = column; index <= width; index++) {
      matrix[column][index] /= divisor;
    }

    for (let row = 0; row < width; row++) {
      if (row !== column) {
        const factor = matrix[row][column];

        for (let index = column; index <= width; index++) {
          matrix[row][index] -= factor * matrix[column][index];
        }
      }
    }
  }

  const result = matrix.map((row) => row[width]);

  return result.every((value) => Number.isFinite(value) && Math.abs(value) <= 8) ? result : null;
}

function domainOf(rows: readonly Encoded[]): JourneyDomain {
  return {
    minimum: JOURNEY_FEATURE_NAMES.map((_, index) =>
      Math.min(...rows.map((value) => value.raw[index])),
    ),
    maximum: JOURNEY_FEATURE_NAMES.map((_, index) =>
      Math.max(...rows.map((value) => value.raw[index])),
    ),
  };
}

function evaluate(
  rows: readonly Encoded[],
  coefficients: number[],
  normalization: JourneyNormalization,
  domain: JourneyDomain,
  offset: number,
  radius: number,
): JourneyEvaluation | null {
  if (!rows.length) {
    return null;
  }

  const predictions = rows.map(({ row, raw }) => {
    const predicted = ratio(raw, coefficients, normalization, domain);

    return predicted === null
      ? null
      : range(row.features.predictedSeconds, predicted, offset, radius);
  });

  if (predictions.some((value) => value === null)) {
    return null;
  }

  return {
    observations: rows.length,
    baselineMaeSeconds: mean(
      rows.map(({ row }) => Math.abs(row.actualSeconds - row.features.predictedSeconds)),
    ),
    modelMaeSeconds: mean(
      rows.map(({ row }, index) => Math.abs(row.actualSeconds - predictions[index]!.medianSeconds)),
    ),
    intervalCoverage: mean(
      rows.map(({ row }, index) =>
        Number(
          row.actualSeconds >= predictions[index]!.lowerSeconds &&
            row.actualSeconds <= predictions[index]!.upperSeconds,
        ),
      ),
    ),
    upperCoverage: mean(
      rows.map(({ row }, index) => Number(row.actualSeconds <= predictions[index]!.upperSeconds)),
    ),
    meanRelativeWidth: mean(
      rows.map(
        ({ row }, index) =>
          (predictions[index]!.upperSeconds - predictions[index]!.lowerSeconds) / row.actualSeconds,
      ),
    ),
  };
}

const passed = (value: JourneyEvaluation) =>
  value.modelMaeSeconds < value.baselineMaeSeconds &&
  value.intervalCoverage >= 0.8 &&
  value.upperCoverage >= 0.9 &&
  value.upperCoverage >= value.intervalCoverage &&
  value.meanRelativeWidth <= 1.5;

const splitSummary = (rows: readonly Encoded[]): JourneySplit => ({
  observations: rows.length,
  serviceDays: new Set(rows.map((value) => dayKey(value.row.features.startedAt))).size,
  earliestStartedAt: Math.min(...rows.map((value) => value.row.features.startedAt)),
  latestObservedAt: Math.max(...rows.map((value) => value.row.observedAt)),
});

const normalizationOf = (rows: readonly Encoded[]): JourneyNormalization => ({
  centers: JOURNEY_FEATURE_NAMES.map((_, index) =>
    quantile(
      rows.map((value) => value.raw[index]),
      0.5,
    ),
  ),
  scales: JOURNEY_FEATURE_NAMES.map((_, index) =>
    Math.max(
      0.000001,
      quantile(
        rows.map((value) => value.raw[index]),
        0.75,
      ) -
        quantile(
          rows.map((value) => value.raw[index]),
          0.25,
        ) || 1,
    ),
  ),
  clip: 4,
});

/** One row is one complete rider-confirmed journey. Neither API estimates nor independent leg sums are labels. */
export function trainJourneyEta(
  observations: readonly unknown[],
  now = Date.now(),
): JourneyTrainingReport {
  const report: JourneyTrainingReport = {
    version: 'eta-journey-v1',
    trainedAt: now,
    reasons: [],
    rankingEvidence: 'observed-selected-journey-only',
    counts: {
      input: Array.isArray(observations) ? observations.length : 0,
      accepted: 0,
      rejected: 0,
      duplicate: 0,
      train: 0,
      calibration: 0,
      test: 0,
      purged: 0,
    },
    evaluations: {},
    combinationHoldouts: {},
  };

  if (
    !Array.isArray(observations) ||
    observations.length > 50_000 ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    report.reasons.push('invalid-training-input');

    return report;
  }

  const encoded: Encoded[] = [],
    ids = new Set<string>(),
    trips = new Set<string>();

  for (const input of observations) {
    const parsed = journeyObservationSchema.safeParse(input);

    if (!parsed.success) {
      report.counts.rejected++;
      continue;
    }

    const row = parsed.data;

    if (ids.has(row.id) || trips.has(row.tripId)) {
      report.counts.duplicate++;
      continue;
    }

    ids.add(row.id);
    trips.add(row.tripId);

    const raw = vector(row.features),
      combination = journeyCombination(row.features);

    if (
      !raw ||
      !combination ||
      row.observedAt > now ||
      row.observedAt < now - 90 * DAY ||
      row.features.startedAt > row.observedAt ||
      Math.abs((row.observedAt - row.features.startedAt) / 1000 - row.actualSeconds) > 2 ||
      row.actualSeconds < Math.max(5, row.features.predictedSeconds * 0.1) ||
      row.actualSeconds > row.features.predictedSeconds * 8
    ) {
      report.counts.rejected++;
      continue;
    }

    encoded.push({
      row,
      raw,
      combination,
    });
    report.counts.accepted++;
  }

  if (report.counts.rejected || report.counts.duplicate) {
    report.reasons.push('invalid-or-duplicate-journey-observations');

    return report;
  }

  if (encoded.length < 50) {
    report.reasons.push('insufficient-independent-journeys');

    return report;
  }

  const profiles = new Set(encoded.map((value) => value.row.features.legModelProfile));

  if (profiles.size !== 1) {
    report.reasons.push('mixed-baseline-profiles');

    return report;
  }

  const ordered = encoded.sort(
    (left, right) =>
      left.row.features.startedAt - right.row.features.startedAt ||
      left.row.id.localeCompare(right.row.id),
  );
  const days = [...new Set(ordered.map((value) => dayKey(value.row.features.startedAt)))].sort();

  if (days.length < 11) {
    report.reasons.push('insufficient-service-day-coverage');

    return report;
  }

  const calibrationDay = days[Math.ceil(days.length * 0.6)],
    testDay = days[Math.ceil(days.length * 0.8)];
  const calStart = Date.parse(`${calibrationDay}T00:00:00+09:00`),
    testStart = Date.parse(`${testDay}T00:00:00+09:00`);
  const train = ordered.filter(
    (value) => value.row.features.startedAt < calStart && value.row.observedAt < calStart,
  );
  const calibration = ordered.filter(
    (value) =>
      value.row.features.startedAt >= calStart &&
      value.row.features.startedAt < testStart &&
      value.row.observedAt < testStart,
  );
  const test = ordered.filter((value) => value.row.features.startedAt >= testStart);

  Object.assign(report.counts, {
    train: train.length,
    calibration: calibration.length,
    test: test.length,
    purged: ordered.length - train.length - calibration.length - test.length,
  });

  if (train.length < 30 || calibration.length < 10 || test.length < 10) {
    report.reasons.push('insufficient-chronological-journey-splits');

    return report;
  }

  const summaries = {
    train: splitSummary(train),
    calibration: splitSummary(calibration),
    test: splitSummary(test),
  };

  if (
    summaries.train.serviceDays < 7 ||
    summaries.calibration.serviceDays < 2 ||
    summaries.test.serviceDays < 2
  ) {
    report.reasons.push('insufficient-service-day-coverage');

    return report;
  }

  const normalization = normalizationOf(train);

  report.normalization = normalization;

  const coefficients = fit(train, normalization);

  if (!coefficients) {
    report.reasons.push('regression-fit-refused');

    return report;
  }

  const combinations = [...new Set(train.map((value) => value.combination))].sort();

  if (combinations.length > 32) {
    report.reasons.push('too-many-combination-scopes');

    return report;
  }

  const model: JourneyEtaModel = {
    version: 'eta-journey-v1',
    trainedAt: now,
    labelSource: 'recorded-journey',
    target: 'log-actual-whole-over-routed-timeline',
    policy: 'rank-only-conservative-envelope',
    legModelProfile: [...profiles][0],
    featureNames: [...JOURNEY_FEATURE_NAMES],
    coefficients,
    regularization: 1,
    normalization,
    splits: summaries,
    combinations: {},
  };

  const knownPaths = new Set([...train, ...calibration].map((value) => value.row.pathGroup));

  for (const combination of combinations) {
    const rows = {
      train: train.filter((value) => value.combination === combination),
      calibration: calibration.filter((value) => value.combination === combination),
      test: test.filter((value) => value.combination === combination),
    };

    if (rows.train.length < 30 || rows.calibration.length < 10 || rows.test.length < 10) {
      report.reasons.push(`combination:${combination}:insufficient-splits`);
      continue;
    }

    const domain = domainOf(rows.train),
      residuals = rows.calibration.map((value) => {
        const predicted = ratio(value.raw, coefficients, normalization, domain);

        return predicted === null
          ? null
          : Math.log(value.row.actualSeconds / value.row.features.predictedSeconds) - predicted;
      });

    if (residuals.some((value) => value === null)) {
      report.reasons.push(`combination:${combination}:calibration-context-unsupported`);
      continue;
    }

    // The regression center is frozen from training; calibration labels only determine split-conformal uncertainty.
    const values = residuals as number[],
      offset = 0,
      radius = Math.max(
        MIN_RADIUS,
        quantile(
          values.map((value) => Math.abs(value)),
          Math.ceil((values.length + 1) * 0.9) / values.length,
        ),
      );

    if (Math.abs(offset) > LOG_LIMIT || !Number.isFinite(radius) || radius > MAX_RADIUS) {
      report.reasons.push(`combination:${combination}:calibration-range-unusable`);
      continue;
    }

    const unseen = rows.test.filter((value) => !knownPaths.has(value.row.pathGroup));
    const evaluation = evaluate(rows.test, coefficients, normalization, domain, offset, radius),
      unseenPaths = evaluate(unseen, coefficients, normalization, domain, offset, radius);

    report.evaluations[combination] = {
      all: evaluation,
      unseenPaths,
    };

    if (!evaluation || !passed(evaluation)) {
      report.reasons.push(`combination:${combination}:held-out-evaluation-not-improved`);
      continue;
    }

    if (!unseenPaths || unseenPaths.observations < 10 || !passed(unseenPaths)) {
      report.reasons.push(`combination:${combination}:unseen-path-evaluation-not-improved`);
      continue;
    }

    model.combinations[combination] = {
      counts: {
        train: rows.train.length,
        calibration: rows.calibration.length,
        test: rows.test.length,
      },
      domain,
      logOffset: offset,
      logRadius: radius,
      evaluation,
      unseenPaths,
    };
  }

  // Stress the shared fit by withholding each whole combination, without reusing these probes for fitting or promotion.
  for (const combination of combinations.slice(0, 8)) {
    const without = train.filter((value) => value.combination !== combination),
      probe = test.filter((value) => value.combination === combination);
    const holdoutNormalization = without.length ? normalizationOf(without) : null;
    const fitted =
        without.length >= 30 && holdoutNormalization ? fit(without, holdoutNormalization) : null,
      domain = without.length ? domainOf(without) : null;

    const paired =
      fitted && domain && holdoutNormalization
        ? probe.flatMap((value) => {
            const predicted = ratio(value.raw, fitted, holdoutNormalization, domain);

            return predicted === null
              ? []
              : [
                  {
                    value,
                    seconds: value.row.features.predictedSeconds * Math.exp(predicted),
                  },
                ];
          })
        : [];

    report.combinationHoldouts[combination] = {
      observations: probe.length,
      supported: paired.length,
      baselineMaeSeconds: paired.length
        ? mean(
            paired.map(({ value }) =>
              Math.abs(value.row.actualSeconds - value.row.features.predictedSeconds),
            ),
          )
        : null,
      modelMaeSeconds: paired.length
        ? mean(paired.map(({ value, seconds }) => Math.abs(value.row.actualSeconds - seconds)))
        : null,
    };
  }

  if (!Object.keys(model.combinations).length) {
    report.reasons.push('no-validated-journey-combinations');

    return report;
  }

  try {
    report.model = parseJourneyEtaModel(JSON.stringify(model), now);
  } catch {
    report.reasons.push('model-integrity-check-failed');
  }

  return report;
}

const finite = z.number().finite(),
  count = z.number().int().positive().max(50_000),
  vectorSchema = z.array(finite).length(DIMENSIONS);

const evaluationSchema = z
  .object({
    observations: count,
    baselineMaeSeconds: finite.min(0).max(86_400),
    modelMaeSeconds: finite.min(0).max(86_400),
    intervalCoverage: finite.min(0).max(1),
    upperCoverage: finite.min(0).max(1),
    meanRelativeWidth: finite.positive().max(1.5),
  })
  .strict();

const splitSchema = z
  .object({
    observations: count,
    serviceDays: count,
    earliestStartedAt: z.number().int().positive(),
    latestObservedAt: z.number().int().positive(),
  })
  .strict();

const modelSchema = z
  .object({
    version: z.literal('eta-journey-v1'),
    trainedAt: z.number().int().positive(),
    labelSource: z.literal('recorded-journey'),
    target: z.literal('log-actual-whole-over-routed-timeline'),
    policy: z.literal('rank-only-conservative-envelope'),
    legModelProfile: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    featureNames: z.array(z.string().max(80)).length(DIMENSIONS),
    coefficients: z.array(finite.min(-8).max(8)).length(DIMENSIONS + 1),
    regularization: z.literal(1),
    normalization: z
      .object({
        centers: vectorSchema,
        scales: z.array(finite.min(0.000001).max(1000)).length(DIMENSIONS),
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
    combinations: z.record(
      z.string().min(1).max(600),
      z
        .object({
          counts: z
            .object({
              train: count,
              calibration: count,
              test: count,
            })
            .strict(),
          domain: z
            .object({
              minimum: vectorSchema,
              maximum: vectorSchema,
            })
            .strict(),
          logOffset: z.literal(0),
          logRadius: finite.min(MIN_RADIUS).max(MAX_RADIUS),
          evaluation: evaluationSchema,
          unseenPaths: evaluationSchema,
        })
        .strict(),
    ),
  })
  .strict();

/** Parsing verifies expiry, chronological evidence and every operational scope, not a trusted active flag. */
export function parseJourneyEtaModel(raw: string, now = Date.now()): JourneyEtaModel {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length > 1_000_000 ||
      !Number.isSafeInteger(now) ||
      now <= 0
    ) {
      throw new Error();
    }

    const model = modelSchema.parse(JSON.parse(raw)),
      splits = model.splits,
      scopes = Object.entries(model.combinations);

    if (
      model.trainedAt > now ||
      now - model.trainedAt > JOURNEY_MODEL_MAX_AGE_MS ||
      model.featureNames.some((name, index) => name !== JOURNEY_FEATURE_NAMES[index]) ||
      model.normalization.centers.some(
        (center, index) =>
          center < FEATURE_LIMITS[index][0] - 1e-9 ||
          center > FEATURE_LIMITS[index][1] + 1e-9 ||
          (/Missing$/.test(JOURNEY_FEATURE_NAMES[index]) && center !== 0 && center !== 1),
      ) ||
      !scopes.length ||
      scopes.length > 32 ||
      splits.train.observations < 30 ||
      splits.calibration.observations < 10 ||
      splits.test.observations < 10 ||
      splits.train.serviceDays < 7 ||
      splits.calibration.serviceDays < 2 ||
      splits.test.serviceDays < 2 ||
      splits.train.latestObservedAt > splits.calibration.earliestStartedAt ||
      splits.calibration.latestObservedAt > splits.test.earliestStartedAt ||
      dayKey(splits.train.latestObservedAt) >= dayKey(splits.calibration.earliestStartedAt) ||
      dayKey(splits.calibration.latestObservedAt) >= dayKey(splits.test.earliestStartedAt) ||
      Object.values(splits).some(
        (value) =>
          value.earliestStartedAt > value.latestObservedAt ||
          value.latestObservedAt > model.trainedAt ||
          value.earliestStartedAt < model.trainedAt - 91 * DAY ||
          value.latestObservedAt < model.trainedAt - 90 * DAY ||
          value.serviceDays > value.observations,
      )
    ) {
      throw new Error();
    }

    for (const [combination, scope] of scopes) {
      if (
        combination.split('>').some((mode) => !MOVEMENT.has(mode)) ||
        !passed(scope.evaluation) ||
        !passed(scope.unseenPaths) ||
        scope.counts.train < 30 ||
        scope.counts.calibration < 10 ||
        scope.counts.test < 10 ||
        scope.unseenPaths.observations < 10 ||
        scope.evaluation.observations !== scope.counts.test ||
        scope.unseenPaths.observations > scope.evaluation.observations ||
        scope.domain.minimum.some(
          (min, index) =>
            min > scope.domain.maximum[index] ||
            min < FEATURE_LIMITS[index][0] - 1e-9 ||
            scope.domain.maximum[index] > FEATURE_LIMITS[index][1] + 1e-9 ||
            (/Missing$/.test(JOURNEY_FEATURE_NAMES[index]) &&
              ((min !== 0 && min !== 1) ||
                (scope.domain.maximum[index] !== 0 && scope.domain.maximum[index] !== 1))),
        )
      ) {
        throw new Error();
      }

      for (const partition of ['train', 'calibration', 'test'] as const) {
        if (scope.counts[partition] > splits[partition].observations) {
          throw new Error();
        }
      }
    }

    for (const partition of ['train', 'calibration', 'test'] as const) {
      if (
        scopes.reduce((sum, [, scope]) => sum + scope.counts[partition], 0) >
        splits[partition].observations
      ) {
        throw new Error();
      }
    }

    return model;
  } catch {
    throw new Error('검증된 최근 전체 여정 ETA 모델 파일이 아닙니다.');
  }
}

export function predictJourneyEta(
  model: JourneyEtaModel,
  features: JourneyLearningFeatures,
  now: number,
): JourneyEtaPrediction | null {
  let valid: JourneyEtaModel;

  try {
    valid = parseJourneyEtaModel(JSON.stringify(model), now);
  } catch {
    return null;
  }

  return predictValidatedJourneyEta(valid, features);
}

function predictValidatedJourneyEta(
  valid: JourneyEtaModel,
  features: JourneyLearningFeatures,
): JourneyEtaPrediction | null {
  const raw = vector(features);

  if (!raw || features.legModelProfile !== valid.legModelProfile) {
    return null;
  }

  const scope = valid.combinations[journeyCombination(features)];

  if (!scope) {
    return null;
  }

  const predicted = ratio(raw, valid.coefficients, valid.normalization, scope.domain);

  return predicted === null
    ? null
    : range(features.predictedSeconds, predicted, scope.logOffset, scope.logRadius);
}

/** A detached validated checkpoint lives only in this closure; expiry and query support remain per-call. */
export function prepareJourneyEtaPredictor(
  model: JourneyEtaModel,
  now: number,
): ((features: JourneyLearningFeatures, at: number) => JourneyEtaPrediction | null) | null {
  let valid: JourneyEtaModel;

  try {
    valid = parseJourneyEtaModel(JSON.stringify(model), now);
  } catch {
    return null;
  }

  return (features, at) => {
    if (
      !Number.isSafeInteger(at) ||
      at <= 0 ||
      valid.trainedAt > at ||
      at - valid.trainedAt > JOURNEY_MODEL_MAX_AGE_MS
    ) {
      return null;
    }

    return predictValidatedJourneyEta(valid, features);
  };
}
