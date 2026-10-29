import { z } from 'zod';

/** Official Seoul bus transport codes; nonbus and unlisted codes are not inferred. */
export const PUBLIC_BUS_TRANSPORT_CODES = [
  '100',
  '101',
  '102',
  '103',
  '104',
  '105',
  '106',
  '110',
  '115',
  '120',
  '121',
  '122',
  '130',
  '131',
  '132',
  '133',
  '134',
  '135',
  '136',
  '140',
  '141',
  '142',
  '151',
  '152',
] as const;

const DAY = 86_400_000;
const MAX_ROWS = 100_000;

const opaque = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const stamp = z.number().int().positive().max(8_640_000_000_000_000);

const observationSchema = z
  .object({
    version: z.literal(1),
    id: opaque,
    groupId: opaque,
    odGroup: opaque,
    startedAt: stamp,
    observedAt: stamp,
    actualSeconds: z.number().int().min(180).max(10_800),
    uncertaintySeconds: z.literal(60),
    distanceMeters: z.number().finite().min(100).max(50_000),
    transportCode: z.enum(PUBLIC_BUS_TRANSPORT_CODES),
    source: z.literal('seoul-tdata-card'),
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    target: z.literal('bus-tag-elapsed'),
  })
  .strict();

export type PublicBusShadowObservation = z.infer<typeof observationSchema>;

const featureNames = [
  'logDistanceMeters',
  'seoulHourSin',
  'seoulHourCos',
  ...PUBLIC_BUS_TRANSPORT_CODES.map((code) => `busClass:${code}`),
];

type Encoded = {
  row: PublicBusShadowObservation;
  raw: number[];
};

type Normalization = {
  centers: number[];
  scales: number[];
  clip: 4;
};

type Domain = {
  minimum: number[];
  maximum: number[];
};

interface Split {
  rows: number;
  physicalRuns: number;
  earliestStartedAt: number;
  latestObservedAt: number;
}

export interface PublicBusShadowEvaluation {
  rows: number;
  supported: number;
  unsupported: number;
  /** Tag midpoint errors, not independently observed second-precision ride errors. */
  baselineMaeSeconds: number;
  /** Whole-test MAE is unavailable when any held-out row lacks a supported prediction. */
  modelMaeSeconds: number | null;
  /** Paired comparison on exactly the same supported rows; distinct from whole-test metrics. */
  supportedBaselineMaeSeconds: number | null;
  supportedModelMaeSeconds: number | null;
  /** Full [tag delta - 60, tag delta + 60] must be inside the predicted interval. */
  robustIntervalCoverage: number | null;
  robustUpperCoverage: number | null;
  meanRelativeWidth: number | null;
}

export interface PublicBusShadowModel {
  version: 'public-bus-shadow-v1';
  deployment: 'shadow';
  productionEligible: false;
  target: 'bus-tag-elapsed';
  source: 'seoul-tdata-card';
  trainedAt: number;
  featureNames: string[];
  coefficients: number[];
  regularization: 1;
  normalization: Normalization;
  domain: Domain;
  logRadius: number | null;
  labelUncertaintySeconds: 60;
  baselineSecondsPerMeter: number;
  splits: {
    train: Split;
    calibration: Split;
    test: Split;
  };
}

export interface PublicBusShadowReport {
  version: 'public-bus-shadow-v1';
  deployment: 'shadow';
  productionEligible: false;
  target: 'bus-tag-elapsed';
  source: 'seoul-tdata-card';
  trainedAt: number;
  status: 'refused' | 'shadow-candidate';
  qualityPassed: boolean;
  reasons: string[];
  sourceDates: string[];
  counts: {
    input: number;
    accepted: number;
    rejected: number;
    duplicate: number;
    train: number;
    calibration: number;
    test: number;
    purged: number;
    unsupportedCalibration: number;
  };
  evaluations: {
    all?: PublicBusShadowEvaluation;
    seenOd?: PublicBusShadowEvaluation;
    newOd?: PublicBusShadowEvaluation;
  };
  model?: PublicBusShadowModel;
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const quantile = (values: number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);

  return ordered[
    Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1))
  ];
};

const dateInSeoul = (at: number) => new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);

function validServiceDate(row: PublicBusShadowObservation): boolean {
  const serviceStart = Date.parse(`${row.sourceDate}T04:00:00+09:00`);

  return (
    Number.isFinite(serviceStart) &&
    dateInSeoul(serviceStart) === row.sourceDate &&
    row.startedAt >= serviceStart &&
    row.startedAt < serviceStart + DAY
  );
}

function vector(row: PublicBusShadowObservation): number[] {
  const local = new Date(row.startedAt + 9 * 3_600_000);
  const hour =
    ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
    2 *
    Math.PI;

  return [
    Math.log(row.distanceMeters),
    Math.sin(hour),
    Math.cos(hour),
    ...PUBLIC_BUS_TRANSPORT_CODES.map((code) => Number(row.transportCode === code)),
  ];
}

function normalize(raw: number[], normalization: Normalization, domain?: Domain): number[] | null {
  const result: number[] = [];

  for (let index = 0; index < featureNames.length; index++) {
    const value = raw[index],
      center = normalization.centers[index],
      scale = normalization.scales[index];

    if (![value, center, scale].every(Number.isFinite) || scale <= 0) {
      return null;
    }

    if (domain) {
      const minimum = domain.minimum[index],
        maximum = domain.maximum[index];
      const tolerance = index >= 3 ? 0 : Math.max(0.05, (maximum - minimum) * 0.15, scale * 0.25);

      if (
        value < minimum - tolerance ||
        value > maximum + tolerance ||
        Math.abs((value - center) / scale) > 6
      ) {
        return null;
      }
    }

    result.push(
      Math.max(-normalization.clip, Math.min(normalization.clip, (value - center) / scale)),
    );
  }

  return result;
}

/** Small pivoted ridge solve. All normalization and fitted targets come from training runs only. */
function fit(rows: Encoded[], normalization: Normalization): number[] | null {
  const width = featureNames.length + 1;
  const matrix = Array.from(
    {
      length: width,
    },
    () => Array<number>(width + 1).fill(0),
  );

  for (const { row, raw } of rows) {
    const normalized = normalize(raw, normalization);

    if (!normalized) {
      return null;
    }

    const values = [1, ...normalized],
      target = Math.log(row.actualSeconds);

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

  return result.every((value) => Number.isFinite(value) && Math.abs(value) <= 20) ? result : null;
}

function point(
  raw: number[],
  model: Pick<PublicBusShadowModel, 'normalization' | 'domain' | 'coefficients'>,
): number | null {
  const normalized = normalize(raw, model.normalization, model.domain);

  if (!normalized) {
    return null;
  }

  const value = Math.exp(
    normalized.reduce(
      (sum, input, index) => sum + input * model.coefficients[index + 1],
      model.coefficients[0],
    ),
  );

  return Number.isFinite(value) && value >= 1 && value <= 86_400 ? value : null;
}

const split = (rows: Encoded[]): Split => ({
  rows: rows.length,
  physicalRuns: rows.length,
  earliestStartedAt: Math.min(...rows.map((value) => value.row.startedAt)),
  latestObservedAt: Math.max(...rows.map((value) => value.row.observedAt)),
});

function evaluate(
  rows: Encoded[],
  model: PublicBusShadowModel,
): PublicBusShadowEvaluation | undefined {
  if (!rows.length) {
    return undefined;
  }

  const errors: number[] = [],
    pairedBaselineErrors: number[] = [],
    widths: number[] = [];
  let robustInside = 0,
    robustBelow = 0,
    unsupported = 0;

  for (const { row, raw } of rows) {
    const prediction = point(raw, model);

    if (prediction === null || model.logRadius === null) {
      unsupported++;
      continue;
    }

    const lower = Math.max(0, prediction * Math.exp(-model.logRadius) - row.uncertaintySeconds);
    const upper = prediction * Math.exp(model.logRadius) + row.uncertaintySeconds;
    const labelLower = Math.max(0, row.actualSeconds - row.uncertaintySeconds),
      labelUpper = row.actualSeconds + row.uncertaintySeconds;

    errors.push(Math.abs(prediction - row.actualSeconds));
    pairedBaselineErrors.push(
      Math.abs(row.actualSeconds - row.distanceMeters * model.baselineSecondsPerMeter),
    );
    widths.push((upper - lower) / row.actualSeconds);
    robustInside += Number(lower <= labelLower && upper >= labelUpper);
    robustBelow += Number(upper >= labelUpper);
  }

  return {
    rows: rows.length,
    supported: rows.length - unsupported,
    unsupported,
    baselineMaeSeconds: mean(
      rows.map(({ row }) =>
        Math.abs(row.actualSeconds - row.distanceMeters * model.baselineSecondsPerMeter),
      ),
    ),
    modelMaeSeconds: !unsupported && errors.length ? mean(errors) : null,
    supportedBaselineMaeSeconds: pairedBaselineErrors.length ? mean(pairedBaselineErrors) : null,
    supportedModelMaeSeconds: errors.length ? mean(errors) : null,
    // Unsupported test rows remain in the denominator; they are never hidden by filtering.
    robustIntervalCoverage: errors.length ? robustInside / rows.length : null,
    robustUpperCoverage: errors.length ? robustBelow / rows.length : null,
    meanRelativeWidth: widths.length ? mean(widths) : null,
  };
}

/**
 * Offline research target only. Fare-card tag deltas are not second-precision ride measurements,
 * app rider confirmations, or errors of a contemporaneous route-provider prediction.
 * No function in this module promotes or writes a production ETA model.
 */
export function trainPublicBusShadow(
  observations: readonly unknown[],
  now = Date.now(),
): PublicBusShadowReport {
  const report: PublicBusShadowReport = {
    version: 'public-bus-shadow-v1',
    deployment: 'shadow',
    productionEligible: false,
    target: 'bus-tag-elapsed',
    source: 'seoul-tdata-card',
    trainedAt: now,
    status: 'refused',
    qualityPassed: false,
    reasons: [
      'missing-historical-weather',
      'no-contemporaneous-provider-baseline',
      'unvalidated-production-generalization',
    ],
    sourceDates: [],
    counts: {
      input: Array.isArray(observations) ? observations.length : 0,
      accepted: 0,
      rejected: 0,
      duplicate: 0,
      train: 0,
      calibration: 0,
      test: 0,
      purged: 0,
      unsupportedCalibration: 0,
    },
    evaluations: {},
  };

  if (
    !Array.isArray(observations) ||
    observations.length > MAX_ROWS ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    now > 8_640_000_000_000_000 - DAY
  ) {
    report.reasons.push('invalid-training-input');

    return report;
  }

  const ids = new Set<string>(),
    runs = new Set<string>(),
    dates = new Set<string>(),
    rows: Encoded[] = [];

  for (const value of observations) {
    const parsed = observationSchema.safeParse(value);

    if (!parsed.success) {
      report.counts.rejected++;
      continue;
    }

    const row = parsed.data;

    if (ids.has(row.id) || runs.has(row.groupId)) {
      report.counts.duplicate++;
      continue;
    }

    ids.add(row.id);
    runs.add(row.groupId);

    if (
      row.startedAt % 60_000 !== 0 ||
      row.observedAt % 60_000 !== 0 ||
      row.actualSeconds % 60 !== 0 ||
      row.observedAt > now ||
      row.startedAt > now ||
      now - row.observedAt > 90 * DAY ||
      row.startedAt >= row.observedAt ||
      Math.abs((row.observedAt - row.startedAt) / 1000 - row.actualSeconds) > 1e-9 ||
      !validServiceDate(row)
    ) {
      report.counts.rejected++;
      continue;
    }

    rows.push({
      row,
      raw: vector(row),
    });
    dates.add(row.sourceDate);
    report.counts.accepted++;
  }

  report.sourceDates = [...dates].sort();

  if (dates.size === 1) {
    report.reasons.push('single-service-day');
  }

  if (report.counts.rejected || report.counts.duplicate) {
    if (report.counts.rejected) {
      report.reasons.push('invalid-public-bus-observations');
    }

    if (report.counts.duplicate) {
      report.reasons.push('duplicate-observation-or-physical-run');
    }

    return report;
  }

  if (rows.length < 167) {
    report.reasons.push('insufficient-independent-physical-runs');

    return report;
  }

  rows.sort((a, b) => a.row.startedAt - b.row.startedAt || a.row.observedAt - b.row.observedAt);

  const first = Math.floor(rows.length * 0.6),
    second = Math.floor(rows.length * 0.8);
  const calibrationStarts = rows[first].row.startedAt,
    testStarts = rows[second].row.startedAt;
  const train = rows.slice(0, first).filter((value) => value.row.observedAt <= calibrationStarts);
  const calibration = rows
      .slice(first, second)
      .filter((value) => value.row.observedAt <= testStarts),
    test = rows.slice(second);

  Object.assign(report.counts, {
    train: train.length,
    calibration: calibration.length,
    test: test.length,
    purged: rows.length - train.length - calibration.length - test.length,
  });

  if (train.length < 100 || calibration.length < 30 || test.length < 30) {
    report.reasons.push('insufficient-independent-physical-runs');

    return report;
  }

  const centers = featureNames.map((_, index) =>
    quantile(
      train.map((value) => value.raw[index]),
      0.5,
    ),
  );

  const scales = featureNames.map((_, index) =>
    Math.max(
      0.000001,
      quantile(
        train.map((value) => value.raw[index]),
        0.75,
      ) -
        quantile(
          train.map((value) => value.raw[index]),
          0.25,
        ) || 1,
    ),
  );

  const normalization: Normalization = {
      centers,
      scales,
      clip: 4,
    },
    coefficients = fit(train, normalization);

  if (!coefficients) {
    report.reasons.push('regression-fit-refused');

    return report;
  }

  const domain: Domain = {
    minimum: featureNames.map((_, index) => Math.min(...train.map((value) => value.raw[index]))),
    maximum: featureNames.map((_, index) => Math.max(...train.map((value) => value.raw[index]))),
  };

  const model: PublicBusShadowModel = {
    version: 'public-bus-shadow-v1',
    deployment: 'shadow',
    productionEligible: false,
    target: 'bus-tag-elapsed',
    source: 'seoul-tdata-card',
    trainedAt: now,
    featureNames: [...featureNames],
    coefficients,
    regularization: 1,
    normalization,
    domain,
    logRadius: null,
    labelUncertaintySeconds: 60,
    baselineSecondsPerMeter: quantile(
      train.map(({ row }) => row.actualSeconds / row.distanceMeters),
      0.5,
    ),
    splits: {
      train: split(train),
      calibration: split(calibration),
      test: split(test),
    },
  };

  const residuals: number[] = [];

  for (const { row, raw } of calibration) {
    const prediction = point(raw, model);

    if (prediction === null) {
      report.counts.unsupportedCalibration++;
      continue;
    }

    residuals.push(Math.abs(Math.log(row.actualSeconds / prediction)));
  }

  if (residuals.length >= 30) {
    model.logRadius = Math.max(
      0.01,
      quantile(residuals, Math.ceil((residuals.length + 1) * 0.9) / residuals.length),
    );
  } else {
    report.reasons.push('insufficient-supported-calibration-runs');
  }

  const trainOds = new Set(train.map(({ row }) => row.odGroup));

  report.evaluations = {
    all: evaluate(test, model),
    seenOd: evaluate(
      test.filter(({ row }) => trainOds.has(row.odGroup)),
      model,
    ),
    newOd: evaluate(
      test.filter(({ row }) => !trainOds.has(row.odGroup)),
      model,
    ),
  };
  report.model = model;
  report.status = 'shadow-candidate';

  if (report.counts.unsupportedCalibration || report.evaluations.all?.unsupported) {
    report.reasons.push('unsupported-held-out-context');
  }

  const good = (evaluation: PublicBusShadowEvaluation | undefined) =>
    !!evaluation &&
    !evaluation.unsupported &&
    evaluation.modelMaeSeconds !== null &&
    evaluation.modelMaeSeconds < evaluation.baselineMaeSeconds &&
    evaluation.robustIntervalCoverage !== null &&
    evaluation.robustIntervalCoverage >= 0.8 &&
    evaluation.robustUpperCoverage !== null &&
    evaluation.robustUpperCoverage >= 0.9 &&
    evaluation.meanRelativeWidth !== null &&
    evaluation.meanRelativeWidth <= 1.5;

  report.qualityPassed =
    !report.counts.unsupportedCalibration &&
    good(report.evaluations.all) &&
    (!report.evaluations.seenOd || good(report.evaluations.seenOd)) &&
    (!report.evaluations.newOd || good(report.evaluations.newOd));

  if (!report.qualityPassed) {
    report.reasons.push('shadow-held-out-quality-not-demonstrated');
  }

  if (!report.evaluations.newOd) {
    report.reasons.push('no-unseen-od-evaluation');
  }

  return report;
}
