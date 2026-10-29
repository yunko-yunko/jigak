import { z } from 'zod';
import type { EtaLearningObservation } from '../../shared/intelligence/learning.js';
import type { SegmentMode } from '../../shared/domain/types.js';
import {
  CONTEXTUAL_FEATURE_NAMES,
  CONTEXTUAL_LOG_RATIO_LIMIT,
  CONTEXTUAL_MAX_LOG_RADIUS,
  CONTEXTUAL_MIN_LOG_RADIUS,
  CONTEXTUAL_MODES,
  CONTEXTUAL_RIDGE_LAMBDA,
  contextualDurationRange,
  contextualFeatureSchema,
  contextualFeatureVector,
  contextualLogPrediction,
  contextualStandardizedVector,
  usableContextualEtaModel,
  type ContextualDomain,
  type ContextualEtaModel,
  type ContextualEvaluation,
  type ContextualNormalization,
  type ContextualSplit,
} from './contextual-model.js';

export interface ContextualEtaTrainingReport {
  version: 'eta-context-v2';
  trainedAt: number;
  model?: ContextualEtaModel;
  reasons: string[];
  counts: {
    input: number;
    accepted: number;
    rejected: number;
    excludedArrival: number;
    duplicate: number;
    groups: number;
    train: number;
    calibration: number;
    test: number;
    trainGroups: number;
    calibrationGroups: number;
    testGroups: number;
    purgedGroups: number;
  };
  evaluations: Partial<Record<SegmentMode, ContextualEvaluation>>;
}

const observationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    tripId: z.string().min(1).max(128),
    source: z.enum(['recorded-trip', 'observed-arrival']),
    features: contextualFeatureSchema,
    actualSeconds: z.number().finite().positive().max(86_400),
    observedAt: z.number().int().positive(),
    evidence: z.enum(['user-confirmed', 'sensor-confirmed', 'provider-arrival']),
  })
  .strict();

type Encoded = {
  row: EtaLearningObservation;
  raw: number[];
};

type Group = {
  rows: Encoded[];
  start: number;
  end: number;
};

const quantile = (values: readonly number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
};

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const tripRowCounts = (rows: readonly Encoded[]) => {
  const counts = new Map<string, number>();

  for (const { row } of rows) {
    counts.set(row.tripId, (counts.get(row.tripId) ?? 0) + 1);
  }

  return counts;
};

function balancedQuantile(
  rows: Encoded[],
  counts: Map<string, number>,
  index: number,
  fraction: number,
): number {
  const weighted = rows
    .map((value) => ({
      value: value.raw[index],
      weight: 1 / counts.get(value.row.tripId)!,
    }))
    .sort((left, right) => left.value - right.value);
  const target = weighted.reduce((sum, value) => sum + value.weight, 0) * fraction;
  let cumulative = 0;

  for (const value of weighted) {
    cumulative += value.weight;

    if (cumulative + 1e-9 >= target) {
      return value.value;
    }
  }

  return weighted.at(-1)!.value;
}

const groupCount = (rows: readonly Encoded[]) =>
  new Set(rows.map((value) => value.row.tripId)).size;

const summary = (groups: Group[]): ContextualSplit => ({
  observations: groups.reduce((sum, group) => sum + group.rows.length, 0),
  groups: groups.length,
  earliestStartedAt: Math.min(...groups.map((group) => group.start)),
  latestObservedAt: Math.max(...groups.map((group) => group.end)),
});

/** Ridge solve with pivoting; no new numerical dependency and no test-set tuning. */
function fit(rows: Encoded[], normalization: ContextualNormalization): number[] | null {
  const width = CONTEXTUAL_FEATURE_NAMES.length + 1;
  const matrix = Array.from(
    {
      length: width,
    },
    () => Array<number>(width + 1).fill(0),
  );
  const tripRows = tripRowCounts(rows);

  for (const { row, raw } of rows) {
    const encoded = contextualStandardizedVector(raw, normalization);

    if (!encoded) {
      return null;
    }

    const values = [1, ...encoded],
      weight = 1 / tripRows.get(row.tripId)!;

    const target = Math.max(
      -CONTEXTUAL_LOG_RATIO_LIMIT,
      Math.min(
        CONTEXTUAL_LOG_RATIO_LIMIT,
        Math.log(row.actualSeconds / row.features.predictedSeconds),
      ),
    );

    for (let left = 0; left < width; left++) {
      for (let right = 0; right < width; right++) {
        matrix[left][right] += weight * values[left] * values[right];
      }

      matrix[left][width] += weight * values[left] * target;
    }
  }

  for (let index = 0; index < width; index++) {
    matrix[index][index] += index === 0 ? 1e-8 : CONTEXTUAL_RIDGE_LAMBDA;
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

  const coefficients = matrix.map((row) => row[width]);

  return coefficients.every((value) => Number.isFinite(value) && Math.abs(value) <= 8)
    ? coefficients
    : null;
}

function evaluate(
  rows: Encoded[],
  coefficients: number[],
  normalization: ContextualNormalization,
  domain: ContextualDomain,
  offset: number,
  radius: number,
): ContextualEvaluation | null {
  const groups = new Map<
    string,
    {
      baseline: number[];
      model: number[];
      widths: number[];
      inside: boolean;
      belowUpper: boolean;
    }
  >();

  for (const { row, raw } of rows) {
    const ratio = contextualLogPrediction(raw, coefficients, normalization, domain);
    const prediction =
      ratio === null
        ? null
        : contextualDurationRange(row.features.predictedSeconds, ratio, offset, radius);

    if (!prediction) {
      return null;
    } // Unsupported later context must not be silently removed from evaluation.

    const group = groups.get(row.tripId) ?? {
      baseline: [],
      model: [],
      widths: [],
      inside: true,
      belowUpper: true,
    };

    group.baseline.push(Math.abs(row.actualSeconds - row.features.predictedSeconds));
    group.model.push(Math.abs(row.actualSeconds - prediction.medianSeconds));
    group.widths.push((prediction.upperSeconds - prediction.lowerSeconds) / row.actualSeconds);
    group.inside &&=
      row.actualSeconds >= prediction.lowerSeconds && row.actualSeconds <= prediction.upperSeconds;
    group.belowUpper &&= row.actualSeconds <= prediction.upperSeconds;
    groups.set(row.tripId, group);
  }

  const values = [...groups.values()];

  return values.length
    ? {
        baselineMaeSeconds: mean(values.map((group) => mean(group.baseline))),
        modelMaeSeconds: mean(values.map((group) => mean(group.model))),
        intervalCoverage: mean(values.map((group) => Number(group.inside))),
        upperCoverage: mean(values.map((group) => Number(group.belowUpper))),
        meanRelativeWidth: mean(values.map((group) => mean(group.widths))),
      }
    : null;
}

/** Only completed, consistently timed rider observations fit this duration target. Public arrivals stay separate. */
export function trainContextualEta(
  observations: readonly EtaLearningObservation[],
  now = Date.now(),
): ContextualEtaTrainingReport {
  const report: ContextualEtaTrainingReport = {
    version: 'eta-context-v2',
    trainedAt: now,
    reasons: [],
    counts: {
      input: Array.isArray(observations) ? observations.length : 0,
      accepted: 0,
      rejected: 0,
      excludedArrival: 0,
      duplicate: 0,
      groups: 0,
      train: 0,
      calibration: 0,
      test: 0,
      trainGroups: 0,
      calibrationGroups: 0,
      testGroups: 0,
      purgedGroups: 0,
    },
    evaluations: {},
  };

  if (
    !Array.isArray(observations) ||
    observations.length > 100_000 ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    report.reasons.push('invalid-training-input');

    return report;
  }

  const seen = new Set<string>(),
    groups = new Map<string, Group>();

  for (const value of observations) {
    const parsed = observationSchema.safeParse(value);

    if (!parsed.success) {
      report.counts.rejected++;
      continue;
    }

    const row = parsed.data;

    if (seen.has(row.id)) {
      report.counts.duplicate++;
      continue;
    }

    seen.add(row.id);

    if (
      row.observedAt > now ||
      now - row.observedAt > 90 * 86_400_000 ||
      row.features.startedAt > row.observedAt ||
      Math.abs((row.observedAt - row.features.startedAt) / 1000 - row.actualSeconds) > 2
    ) {
      report.counts.rejected++;
      continue;
    }

    if (row.source === 'observed-arrival') {
      if (
        row.evidence !== 'provider-arrival' ||
        row.features.mode !== 'wait' ||
        !row.features.liveWait
      ) {
        report.counts.rejected++;
      } else {
        report.counts.excludedArrival++;
      }

      continue;
    }

    if (row.evidence === 'provider-arrival') {
      report.counts.rejected++;
      continue;
    }

    const raw = contextualFeatureVector(row.features);

    if (!raw) {
      report.counts.rejected++;
      continue;
    }

    report.counts.accepted++;

    const group = groups.get(row.tripId) ?? {
      rows: [],
      start: row.features.startedAt,
      end: row.observedAt,
    };

    group.rows.push({
      row,
      raw,
    });
    group.start = Math.min(group.start, row.features.startedAt);
    group.end = Math.max(group.end, row.observedAt);
    groups.set(row.tripId, group);
  }

  report.counts.groups = groups.size;

  if (report.counts.rejected || report.counts.duplicate) {
    report.reasons.push('invalid-or-duplicate-observations');

    return report;
  }

  for (const group of groups.values()) {
    const stages = [...group.rows].sort(
      (left, right) => left.row.features.startedAt - right.row.features.startedAt,
    );

    if (
      stages.some(
        (stage, index) =>
          index > 0 && stage.row.features.startedAt < stages[index - 1].row.observedAt,
      )
    ) {
      report.reasons.push('overlapping-trip-completions');

      return report;
    }
  }

  if (groups.size < 50) {
    report.reasons.push('insufficient-independent-trip-groups');

    return report;
  }

  const ordered = [...groups.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const first = Math.floor(ordered.length * 0.6),
    second = Math.floor(ordered.length * 0.8);
  const calibrationStarts = ordered[first].start,
    testStarts = ordered[second].start;

  // Whole trips crossing a time cut are purged. No segment of that trip leaks to another split.
  const trainingGroups = ordered.slice(0, first).filter((group) => group.end <= calibrationStarts);
  const calibrationGroups = ordered.slice(first, second).filter((group) => group.end <= testStarts),
    testGroups = ordered.slice(second);
  const train = trainingGroups.flatMap((group) => group.rows),
    calibration = calibrationGroups.flatMap((group) => group.rows),
    test = testGroups.flatMap((group) => group.rows);

  Object.assign(report.counts, {
    train: train.length,
    calibration: calibration.length,
    test: test.length,
    trainGroups: trainingGroups.length,
    calibrationGroups: calibrationGroups.length,
    testGroups: testGroups.length,
    purgedGroups:
      ordered.length - trainingGroups.length - calibrationGroups.length - testGroups.length,
  });

  const eligible = CONTEXTUAL_MODES.filter(
    (mode) =>
      groupCount(train.filter((value) => value.row.features.mode === mode)) >= 30 &&
      groupCount(calibration.filter((value) => value.row.features.mode === mode)) >= 10 &&
      groupCount(test.filter((value) => value.row.features.mode === mode)) >= 10,
  );

  if (!eligible.length) {
    report.reasons.push('insufficient-per-mode-trip-groups');

    return report;
  }

  const fittedRows = train.filter((value) => eligible.includes(value.row.features.mode));
  const counts = tripRowCounts(fittedRows);
  const centers = CONTEXTUAL_FEATURE_NAMES.map((_, index) =>
    balancedQuantile(fittedRows, counts, index, 0.5),
  );

  const scales = CONTEXTUAL_FEATURE_NAMES.map((_, index) =>
    Math.max(
      0.000001,
      balancedQuantile(fittedRows, counts, index, 0.75) -
        balancedQuantile(fittedRows, counts, index, 0.25) || 1,
    ),
  );

  const normalization: ContextualNormalization = {
      centers,
      scales,
      clip: 4,
    },
    coefficients = fit(fittedRows, normalization);

  if (!coefficients) {
    report.reasons.push('regression-fit-refused');

    return report;
  }

  const model: ContextualEtaModel = {
    version: 'eta-context-v2',
    trainedAt: now,
    target: 'log-actual-over-predicted',
    labelSource: 'recorded-trip',
    featureNames: [...CONTEXTUAL_FEATURE_NAMES],
    coefficients,
    regularization: 1,
    normalization,
    splits: {
      train: summary(trainingGroups),
      calibration: summary(calibrationGroups),
      test: summary(testGroups),
    },
    modes: {},
  };

  for (const mode of eligible) {
    const rows = {
      train: train.filter((value) => value.row.features.mode === mode),
      calibration: calibration.filter((value) => value.row.features.mode === mode),
      test: test.filter((value) => value.row.features.mode === mode),
    };

    const domain = {
      minimum: CONTEXTUAL_FEATURE_NAMES.map((_, index) =>
        Math.min(...rows.train.map((value) => value.raw[index])),
      ),
      maximum: CONTEXTUAL_FEATURE_NAMES.map((_, index) =>
        Math.max(...rows.train.map((value) => value.raw[index])),
      ),
    };

    const residuals = new Map<string, number[]>();
    let unsupported = false;

    for (const { row, raw } of rows.calibration) {
      const prediction = contextualLogPrediction(raw, coefficients, normalization, domain);

      if (prediction === null) {
        unsupported = true;
        break;
      }

      const values = residuals.get(row.tripId) ?? [];

      values.push(Math.log(row.actualSeconds / row.features.predictedSeconds) - prediction);
      residuals.set(row.tripId, values);
    }

    if (unsupported) {
      report.reasons.push(`mode:${mode}:calibration-context-unsupported`);
      continue;
    }

    // Freeze the fitted center before seeing calibration outcomes. Estimating an offset from
    // these same residuals invalidates their split-conformal interpretation and moves the ETA.
    const logOffset = 0;
    const scores = [...residuals.values()].map((values) =>
      Math.max(...values.map((value) => Math.abs(value - logOffset))),
    );

    // Finite-sample split calibration: one max residual per independent trip group.
    const logRadius = Math.max(
      CONTEXTUAL_MIN_LOG_RADIUS,
      quantile(scores, Math.ceil((scores.length + 1) * 0.9) / scores.length),
    );

    if (
      !Number.isFinite(logOffset) ||
      Math.abs(logOffset) > CONTEXTUAL_LOG_RATIO_LIMIT ||
      !Number.isFinite(logRadius) ||
      logRadius > CONTEXTUAL_MAX_LOG_RADIUS
    ) {
      report.reasons.push(`mode:${mode}:calibration-range-unusable`);
      continue;
    }

    const evaluation = evaluate(
      rows.test,
      coefficients,
      normalization,
      domain,
      logOffset,
      logRadius,
    );

    if (!evaluation) {
      report.reasons.push(`mode:${mode}:test-context-unsupported`);
      continue;
    }

    report.evaluations[mode] = evaluation;

    if (
      evaluation.modelMaeSeconds >= evaluation.baselineMaeSeconds ||
      evaluation.intervalCoverage < 0.8 ||
      evaluation.upperCoverage < 0.9 ||
      evaluation.meanRelativeWidth > 1.5
    ) {
      report.reasons.push(`mode:${mode}:held-out-evaluation-not-improved`);
      continue;
    }

    model.modes[mode] = {
      counts: {
        train: rows.train.length,
        calibration: rows.calibration.length,
        test: rows.test.length,
      },
      groups: {
        train: groupCount(rows.train),
        calibration: groupCount(rows.calibration),
        test: groupCount(rows.test),
      },
      domain,
      logOffset,
      logRadius,
      evaluation,
    };
  }

  if (!Object.keys(model.modes).length) {
    report.reasons.push('no-validated-modes');

    return report;
  }

  if (!usableContextualEtaModel(model, now)) {
    report.reasons.push('model-integrity-check-failed');

    return report;
  }

  report.model = model;

  return report;
}
