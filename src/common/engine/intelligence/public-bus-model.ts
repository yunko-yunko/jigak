import { createHash } from 'node:crypto';
import { publicBusTrainingWindow } from './public-bus-window.js';
import { z } from 'zod';
import { PUBLIC_BUS_TRANSPORT_CODES } from './public-bus-shadow.js';
import {
  preparePublishedRoadPriorLookup,
  roadPriorArchiveSchema,
  type RoadPriorArchive,
} from './historical-context.js';

const DAY = 86_400_000,
  MAX_ROWS = 140_000;

export const PUBLIC_BUS_SCOPE_BOUNDS = {
  south: 37.4,
  north: 37.72,
  west: 126.73,
  east: 127.28,
} as const;

const withinScope = (latitude: number, longitude: number) =>
  latitude >= PUBLIC_BUS_SCOPE_BOUNDS.south &&
  latitude <= PUBLIC_BUS_SCOPE_BOUNDS.north &&
  longitude >= PUBLIC_BUS_SCOPE_BOUNDS.west &&
  longitude <= PUBLIC_BUS_SCOPE_BOUNDS.east;

const number = z.number().finite();
const stamp = number.int().positive().max(8_640_000_000_000_000);

const opaque = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const coordinate = z
  .object({
    latitude: number.min(-90).max(90),
    longitude: number.min(-180).max(180),
  })
  .strict();

const weatherMeasurements = {
  observedAt: stamp,
  ageSeconds: number.int().min(0).max(10_800),
  temperatureC: number.min(-60).max(60).nullable(),
  windMetersPerSecond: number.min(0).max(100).nullable(),
  precipitationMm: number.min(0).max(500).nullable(),
  precipitationTrace: z.boolean(),
};

const retrospectiveWeather = z
  .object({
    ...weatherMeasurements,
    source: z.literal('noaa-ghcnh'),
    stationId: z.literal('KSI0000RKSL'),
    retrospective: z.literal(true),
    availability: z.literal('historical-publication-unknown'),
  })
  .strict();

const runtimeWeather = z.object(weatherMeasurements).strict();

export const publicBusRoadPriorSchema = z
  .object({
    source: z.literal('topis-monthly'),
    publishedAt: stamp,
    referenceMonth: z.string().regex(/^\d{4}-\d{2}$/),
    spatialScope: z.literal('seoul-citywide'),
    weekType: z.enum(['weekday', 'saturday', 'sunday']),
    hour: number.int().min(0).max(23),
    speedKmh: number.positive().max(150),
    sampleCount: number.int().positive(),
    missingCount: number.int().min(0),
  })
  .strict();

const observationSchema = z
  .object({
    version: z.literal(2),
    id: opaque,
    groupId: opaque,
    vehicleGroup: opaque,
    odGroup: opaque,
    startedAt: stamp,
    observedAt: stamp,
    actualSeconds: number.int().min(180).max(10_800),
    uncertaintySeconds: z.literal(60),
    distanceMeters: number.min(100).max(50_000),
    transportCode: z.enum(PUBLIC_BUS_TRANSPORT_CODES),
    source: z.literal('seoul-tdata-card'),
    sourceDate: daySchema,
    target: z.literal('bus-tag-elapsed'),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    routeId: z.string().trim().min(1).max(128),
    routeNumber: z.string().trim().min(1).max(80),
    fromStopId: z.string().trim().min(1).max(128),
    toStopId: z.string().trim().min(1).max(128),
    fromOrder: number.int().min(0),
    toOrder: number.int().positive(),
    fromLatitude: number.min(-90).max(90),
    fromLongitude: number.min(-180).max(180),
    toLatitude: number.min(-90).max(90),
    toLongitude: number.min(-180).max(180),
    pathStopCoordinates: z.array(coordinate).min(2).max(100),
    weather: retrospectiveWeather.nullable(),
    roadPrior: publicBusRoadPriorSchema.nullable(),
  })
  .strict();

export type PublicBusModelObservation = z.infer<typeof observationSchema>;

export interface PublicBusPredictionInput {
  distanceMeters: number;
  startedAt: number;
  weather: z.infer<typeof runtimeWeather> | null;
  roadPrior: z.infer<typeof publicBusRoadPriorSchema> | null;
}

const inputSchema = z
  .object({
    distanceMeters: number.min(100).max(50_000),
    startedAt: stamp,
    weather: runtimeWeather.nullable(),
    roadPrior: publicBusRoadPriorSchema.nullable(),
  })
  .strict();

// Fixed before inspecting the final evaluation day. No class or public-ID inference is required at runtime.
export const PUBLIC_BUS_FEATURE_NAMES = [
  'logDistanceMeters',
  'seoulHourSin',
  'seoulHourCos',
  'seoulWeekdaySin',
  'seoulWeekdayCos',
  'temperatureC',
  'temperatureMissing',
  'windMetersPerSecond',
  'windMissing',
  'logPrecipitationMm',
  'precipitationMissing',
  'precipitationTrace',
  'weatherAgeHours',
  'weatherMissing',
  'logRoadPriorSpeedKmh',
  'roadPriorMissing',
] as const;

const N = PUBLIC_BUS_FEATURE_NAMES.length;

interface Normalization {
  centers: number[];
  scales: number[];
  clip: 4;
}

interface Domain {
  minimum: number[];
  maximum: number[];
}

export interface PublicBusEvaluation {
  rows: number;
  supported: number;
  unsupported: number;
  baselineMaeSeconds: number;
  modelMaeSeconds: number | null;
  supportedModelMaeSeconds: number | null;
  robustIntervalCoverage: number;
  robustUpperCoverage: number;
  meanRelativeWidth: number | null;
}

interface SplitSummary {
  rows: number;
  physicalRuns: number;
  vehicles: number;
  dates: string[];
  firstDay: string | null;
  lastDay: string | null;
  earliestStartedAt: number | null;
  latestObservedAt: number | null;
}

export interface PublicBusModel {
  version: 'public-bus-duration-v2';
  target: 'bus-tag-elapsed';
  deployment: 'production';
  usage: 'conservative-bus-envelope';
  trainedAt: number;
  expiresAt: number;
  featureNames: string[];
  coefficients: number[];
  regularization: 1;
  normalization: Normalization;
  domain: Domain;
  logRadius: number;
  labelUncertaintySeconds: 60;
  scope: {
    kind: 'seoul-bounding-box-bus-endpoints';
    bounds: typeof PUBLIC_BUS_SCOPE_BOUNDS;
    sourceRows: number;
    eligibleRows: number;
    excludedOutsideScope: number;
  };
  roadPriorArchives: RoadPriorArchive[];
  baselineSecondsPerMeter: number;
  evaluation: PublicBusEvaluation;
  validation: {
    protocol: 'whole-service-day-future-v1';
    qualityPassed: true;
    trainThrough: string;
    calibrationDates: [string, string];
    testDates: [string];
    heldOutVehicleFraction: 0.1;
    heldOutVehicle: PublicBusEvaluation;
    newOd: PublicBusEvaluation;
    seenOd: PublicBusEvaluation | null;
    dayParts: Record<string, PublicBusEvaluation>;
    sourceDates: string[];
    sourceArchiveCount: number;
    sourceArchives: {
      sourceDate: string;
      sha256: string;
      rows: number;
    }[];
    context: {
      historicalWeather: true;
      historicalPublicationAvailability: 'unknown';
      road: 'published-monthly-citywide-prior';
      contemporaneousProviderBaseline: false;
    };
  };
  split: {
    train: SplitSummary;
    calibration: SplitSummary;
    test: SplitSummary;
  };
}

export interface PublicBusModelReport {
  version: 'public-bus-duration-v2';
  target: 'bus-tag-elapsed';
  trainedAt: number;
  qualityPassed: boolean;
  status: 'refused' | 'production-candidate';
  reasons: string[];
  featureNames: string[];
  counts: {
    input: number;
    accepted: number;
    eligible: number;
    excludedOutsideScope: number;
    rejected: number;
    duplicate: number;
    train: number;
    calibration: number;
    test: number;
    purgedBoundary: number;
    heldOutVehicles: number;
    excludedHeldOutTrainingRows: number;
    unsupportedCalibration: number;
  };
  split: {
    train: SplitSummary;
    calibration: SplitSummary;
    test: SplitSummary;
  };
  evaluations: {
    all?: PublicBusEvaluation;
    seenOd?: PublicBusEvaluation;
    newOd?: PublicBusEvaluation;
    heldOutVehicle?: PublicBusEvaluation;
    dayParts?: Record<string, PublicBusEvaluation>;
    days?: Record<string, PublicBusEvaluation>;
  };
  contextCounts: {
    weather: number;
    temperature: number;
    wind: number;
    precipitation: number;
    roadPrior: number;
  };
  model?: PublicBusModel;
}

type Encoded = {
  row: PublicBusModelObservation;
  raw: number[];
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const quantile = (values: number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b);

  return ordered[
    Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1))
  ];
};

const local = (at: number) => new Date(at + 9 * 3600_000);

const emptySplit = (): SplitSummary => ({
  rows: 0,
  physicalRuns: 0,
  vehicles: 0,
  dates: [],
  firstDay: null,
  lastDay: null,
  earliestStartedAt: null,
  latestObservedAt: null,
});

const summary = (rows: Encoded[]): SplitSummary => {
  if (!rows.length) {
    return emptySplit();
  }

  const dates = [...new Set(rows.map((value) => value.row.sourceDate))].sort();

  return {
    rows: rows.length,
    physicalRuns: new Set(rows.map((value) => value.row.groupId)).size,
    vehicles: new Set(rows.map((value) => value.row.vehicleGroup)).size,
    dates,
    firstDay: dates[0],
    lastDay: dates.at(-1)!,
    earliestStartedAt: Math.min(...rows.map((value) => value.row.startedAt)),
    latestObservedAt: Math.max(...rows.map((value) => value.row.observedAt)),
  };
};

const vehicleHoldout = (vehicle: string) =>
  createHash('sha256').update(`bus-vehicle-holdout-v1|${vehicle}`).digest().readUInt32BE(0) % 10 ===
  0;

function weekType(at: number) {
  const day = local(at).getUTCDay();

  return day === 6 ? 'saturday' : day === 0 ? 'sunday' : 'weekday';
}

function validContext(input: PublicBusPredictionInput): boolean {
  const weather = input.weather,
    prior = input.roadPrior;

  if (
    weather &&
    (weather.observedAt > input.startedAt ||
      Math.abs((input.startedAt - weather.observedAt) / 1000 - weather.ageSeconds) > 1)
  ) {
    return false;
  }

  if (
    prior &&
    (prior.publishedAt > input.startedAt ||
      prior.referenceMonth >= local(input.startedAt).toISOString().slice(0, 7) ||
      prior.weekType !== weekType(input.startedAt) ||
      prior.hour !== local(input.startedAt).getUTCHours())
  ) {
    return false;
  }

  return true;
}

function vector(input: PublicBusPredictionInput): number[] {
  const date = local(input.startedAt),
    hour =
      ((date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    weekday = (date.getUTCDay() / 7) * 2 * Math.PI,
    w = input.weather;

  return [
    Math.log(input.distanceMeters),
    Math.sin(hour),
    Math.cos(hour),
    Math.sin(weekday),
    Math.cos(weekday),
    w?.temperatureC ?? 0,
    Number(w?.temperatureC == null),
    w?.windMetersPerSecond ?? 0,
    Number(w?.windMetersPerSecond == null),
    Math.log1p(w?.precipitationMm ?? 0),
    Number(w?.precipitationMm == null),
    Number(w?.precipitationTrace ?? false),
    (w?.ageSeconds ?? 0) / 3600,
    Number(!w),
    input.roadPrior ? Math.log(input.roadPrior.speedKmh) : 0,
    Number(!input.roadPrior),
  ];
}

const categorical = new Set([6, 8, 10, 11, 13, 15]);

function normalize(raw: number[], normalization: Normalization, domain?: Domain): number[] | null {
  const out: number[] = [];

  for (let index = 0; index < N; index++) {
    const value = raw[index],
      center = normalization.centers[index],
      scale = normalization.scales[index];

    if (![value, center, scale].every(Number.isFinite) || scale <= 0) {
      return null;
    }

    if (domain) {
      const min = domain.minimum[index],
        max = domain.maximum[index];
      const tolerance = categorical.has(index)
        ? 0
        : Math.max(0.05, (max - min) * 0.15, scale * 0.25);

      if (
        value < min - tolerance ||
        value > max + tolerance ||
        Math.abs((value - center) / scale) > 6
      ) {
        return null;
      }
    }

    out.push(Math.max(-normalization.clip, Math.min(normalization.clip, (value - center) / scale)));
  }

  return out;
}

function fit(rows: Encoded[], normalization: Normalization): number[] | null {
  const width = N + 1,
    matrix = Array.from(
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

type PointModel = Pick<PublicBusModel, 'normalization' | 'domain' | 'coefficients'>;

function point(raw: number[], model: PointModel): number | null {
  const normalized = normalize(raw, model.normalization, model.domain);

  if (!normalized) {
    return null;
  }

  const result = Math.exp(
    normalized.reduce(
      (sum, value, index) => sum + value * model.coefficients[index + 1],
      model.coefficients[0],
    ),
  );

  return Number.isFinite(result) && result >= 1 && result <= 10_800 ? result : null;
}

function evaluate(
  rows: Encoded[],
  model: PointModel & {
    logRadius: number;
    baselineSecondsPerMeter: number;
  },
): PublicBusEvaluation | undefined {
  if (!rows.length) {
    return undefined;
  }

  let baseline = 0,
    error = 0,
    supported = 0,
    inside = 0,
    below = 0,
    width = 0;

  for (const { row, raw } of rows) {
    baseline += Math.abs(row.actualSeconds - row.distanceMeters * model.baselineSecondsPerMeter);

    const prediction = point(raw, model);

    if (prediction === null) {
      continue;
    }

    const lower = Math.max(0, prediction * Math.exp(-model.logRadius) - 60),
      upper = prediction * Math.exp(model.logRadius) + 60;

    supported++;
    error += Math.abs(prediction - row.actualSeconds);
    inside += Number(lower <= row.actualSeconds - 60 && upper >= row.actualSeconds + 60);
    below += Number(upper >= row.actualSeconds + 60);
    width += (upper - lower) / row.actualSeconds;
  }

  return {
    rows: rows.length,
    supported,
    unsupported: rows.length - supported,
    baselineMaeSeconds: baseline / rows.length,
    modelMaeSeconds: supported === rows.length ? error / supported : null,
    supportedModelMaeSeconds: supported ? error / supported : null,
    robustIntervalCoverage: inside / rows.length,
    robustUpperCoverage: below / rows.length,
    meanRelativeWidth: supported ? width / supported : null,
  };
}

function good(evaluation: PublicBusEvaluation | undefined, minimum = 100): boolean {
  return (
    !!evaluation &&
    evaluation.rows >= minimum &&
    evaluation.unsupported === 0 &&
    evaluation.modelMaeSeconds !== null &&
    evaluation.modelMaeSeconds < evaluation.baselineMaeSeconds &&
    evaluation.robustIntervalCoverage >= 0.8 &&
    evaluation.robustUpperCoverage >= 0.9 &&
    evaluation.meanRelativeWidth !== null &&
    evaluation.meanRelativeWidth <= 1.5
  );
}

/** Offline comparison on the exact same future population; never changes checkpoint timestamps or runtime validity. */
export function evaluatePublicBusCheckpoint(
  model: PublicBusModel,
  observations: readonly unknown[],
) {
  const rows: Encoded[] = [];

  for (const value of observations) {
    const row = observationSchema.parse(value);

    if (
      !withinScope(row.fromLatitude, row.fromLongitude) ||
      !withinScope(row.toLatitude, row.toLongitude)
    ) {
      continue;
    }

    const input = {
      distanceMeters: row.distanceMeters,
      startedAt: row.startedAt,
      weather: row.weather,
      roadPrior: row.roadPrior,
    };

    if (!validContext(input)) {
      throw new Error('invalid-evaluation-context');
    }

    rows.push({
      row,
      raw: vector(input),
    });
  }

  return evaluate(rows, model);
}

const dayPart = (at: number) => {
  const hour = local(at).getUTCHours();

  return hour < 6
    ? 'overnight'
    : hour < 10
      ? 'morning'
      : hour < 17
        ? 'daytime'
        : hour < 21
          ? 'evening'
          : 'night';
};

/** Frozen, independent-day protocol. This is an absolute bus tag elapsed target, never a rider ETA residual. */
export function trainPublicBusModel(
  observations: readonly unknown[],
  options: {
    now?: number;
    roadPriorArchives?: readonly RoadPriorArchive[];
    serviceWindowStart?: string;
  } = {},
): PublicBusModelReport {
  const now = options.now ?? Date.now(),
    report: PublicBusModelReport = {
      version: 'public-bus-duration-v2',
      target: 'bus-tag-elapsed',
      trainedAt: now,
      qualityPassed: false,
      status: 'refused',
      reasons: [],
      featureNames: [...PUBLIC_BUS_FEATURE_NAMES],
      counts: {
        input: observations?.length ?? 0,
        accepted: 0,
        eligible: 0,
        excludedOutsideScope: 0,
        rejected: 0,
        duplicate: 0,
        train: 0,
        calibration: 0,
        test: 0,
        purgedBoundary: 0,
        heldOutVehicles: 0,
        excludedHeldOutTrainingRows: 0,
        unsupportedCalibration: 0,
      },
      split: {
        train: emptySplit(),
        calibration: emptySplit(),
        test: emptySplit(),
      },
      evaluations: {},
      contextCounts: {
        weather: 0,
        temperature: 0,
        wind: 0,
        precipitation: 0,
        roadPrior: 0,
      },
    };

  if (
    !Array.isArray(observations) ||
    observations.length > MAX_ROWS ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    report.reasons.push('invalid-training-input');

    return report;
  }

  let window: ReturnType<typeof publicBusTrainingWindow>;

  try {
    window = publicBusTrainingWindow(options.serviceWindowStart);
  } catch {
    report.reasons.push('invalid-service-window');

    return report;
  }

  if (window.endExclusive > now) {
    report.reasons.push('incomplete-service-window');

    return report;
  }

  const archives = z
    .array(roadPriorArchiveSchema)
    .max(24)
    .safeParse(options.roadPriorArchives ?? []);

  if (
    !archives.success ||
    new Set(archives.data.map((value) => value.referenceMonth)).size !== archives.data.length
  ) {
    report.reasons.push('invalid-road-prior-archives');

    return report;
  }

  const lookupRoad = preparePublishedRoadPriorLookup(archives.data);
  const dayCounts = new Map<string, number>();
  const ids = new Set<string>(),
    runs = new Set<string>(),
    archiveDays = new Map<string, string>(),
    dayArchives = new Map<string, string>(),
    rows: Encoded[] = [],
    heldVehicles = new Set<string>();

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

    const serviceStart = Date.parse(`${row.sourceDate}T04:00:00+09:00`);
    const input: PublicBusPredictionInput = {
      distanceMeters: row.distanceMeters,
      startedAt: row.startedAt,
      weather: row.weather,
      roadPrior: row.roadPrior,
    };

    if (
      row.sourceDate < window.dates[0] ||
      row.sourceDate > window.dates[13] ||
      !Number.isFinite(serviceStart) ||
      local(serviceStart).toISOString().slice(0, 10) !== row.sourceDate ||
      row.startedAt < serviceStart ||
      row.startedAt >= serviceStart + DAY ||
      row.observedAt > now ||
      now - row.observedAt > 90 * DAY ||
      row.startedAt % 60_000 ||
      row.observedAt % 60_000 ||
      row.actualSeconds % 60 ||
      row.observedAt - row.startedAt !== row.actualSeconds * 1000 ||
      row.toOrder <= row.fromOrder ||
      row.fromStopId === row.toStopId ||
      !validContext(input) ||
      JSON.stringify(row.roadPrior) !==
        JSON.stringify(
          ((prior) => (prior ? publicBusRoadPriorSchema.parse(prior) : null))(
            lookupRoad(row.startedAt),
          ),
        ) ||
      (archiveDays.has(row.sourceArchiveSha256) &&
        archiveDays.get(row.sourceArchiveSha256) !== row.sourceDate) ||
      (dayArchives.has(row.sourceDate) &&
        dayArchives.get(row.sourceDate) !== row.sourceArchiveSha256)
    ) {
      report.counts.rejected++;
      continue;
    }

    dayCounts.set(row.sourceDate, (dayCounts.get(row.sourceDate) ?? 0) + 1);
    archiveDays.set(row.sourceArchiveSha256, row.sourceDate);
    dayArchives.set(row.sourceDate, row.sourceArchiveSha256);
    report.counts.accepted++;

    if (
      !withinScope(row.fromLatitude, row.fromLongitude) ||
      !withinScope(row.toLatitude, row.toLongitude)
    ) {
      report.counts.excludedOutsideScope++;
      continue;
    }

    rows.push({
      row,
      raw: vector(input),
    });
    report.counts.eligible++;

    if (vehicleHoldout(row.vehicleGroup)) {
      heldVehicles.add(row.vehicleGroup);
    }

    if (row.weather) {
      report.contextCounts.weather++;
      report.contextCounts.temperature += Number(row.weather.temperatureC !== null);
      report.contextCounts.wind += Number(row.weather.windMetersPerSecond !== null);
      report.contextCounts.precipitation += Number(row.weather.precipitationMm !== null);
    }

    report.contextCounts.roadPrior += Number(!!row.roadPrior);
  }

  report.counts.heldOutVehicles = heldVehicles.size;

  if (report.counts.rejected || report.counts.duplicate) {
    report.reasons.push('invalid-or-duplicate-source-observations');

    return report;
  }

  if (dayArchives.size !== 14) {
    report.reasons.push('missing-required-service-days');

    return report;
  }

  if ([...dayCounts.values()].some((count) => count > 10_000)) {
    report.reasons.push('oversized-independent-day-samples');

    return report;
  }

  const calStart = window.calibrationStart,
    testStart = window.testStart;
  const train: Encoded[] = [],
    calibration: Encoded[] = [],
    test: Encoded[] = [];

  for (const row of rows) {
    const day = row.row.sourceDate;

    if (day <= window.trainThrough) {
      if (heldVehicles.has(row.row.vehicleGroup)) {
        report.counts.excludedHeldOutTrainingRows++;
      } else if (row.row.observedAt >= calStart) {
        report.counts.purgedBoundary++;
      } else {
        train.push(row);
      }
    } else if (day <= window.calibrationDates[1]) {
      if (heldVehicles.has(row.row.vehicleGroup)) {
        report.counts.excludedHeldOutTrainingRows++;
      } else if (row.row.observedAt >= testStart) {
        report.counts.purgedBoundary++;
      } else {
        calibration.push(row);
      }
    } else {
      test.push(row);
    }
  }

  Object.assign(report.counts, {
    train: train.length,
    calibration: calibration.length,
    test: test.length,
  });
  report.split = {
    train: summary(train),
    calibration: summary(calibration),
    test: summary(test),
  };

  if (
    train.length < 1000 ||
    calibration.length < 200 ||
    test.length < 200 ||
    report.split.train.dates.length !== 11 ||
    report.split.calibration.dates.length !== 2 ||
    report.split.test.dates.length !== 1
  ) {
    report.reasons.push('insufficient-independent-day-or-run-coverage');

    return report;
  }

  const normalization: Normalization = {
    centers: PUBLIC_BUS_FEATURE_NAMES.map((_, index) =>
      quantile(
        train.map((value) => value.raw[index]),
        0.5,
      ),
    ),
    scales: PUBLIC_BUS_FEATURE_NAMES.map((_, index) =>
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
    ),
    clip: 4,
  };

  const coefficients = fit(train, normalization);

  if (!coefficients) {
    report.reasons.push('regression-fit-refused');

    return report;
  }

  const domain: Domain = {
    minimum: PUBLIC_BUS_FEATURE_NAMES.map((_, index) =>
      Math.min(...train.map((value) => value.raw[index])),
    ),
    maximum: PUBLIC_BUS_FEATURE_NAMES.map((_, index) =>
      Math.max(...train.map((value) => value.raw[index])),
    ),
  };

  const pointModel = {
      coefficients,
      normalization,
      domain,
    },
    residuals: number[] = [];

  for (const { row, raw } of calibration) {
    const prediction = point(raw, pointModel);

    if (prediction === null) {
      report.counts.unsupportedCalibration++;
    } else {
      residuals.push(Math.abs(Math.log(row.actualSeconds / prediction)));
    }
  }

  if (report.counts.unsupportedCalibration || residuals.length < 200) {
    report.reasons.push('unsupported-calibration-context');

    return report;
  }

  const logRadius = Math.max(
    0.01,
    quantile(residuals, Math.ceil((residuals.length + 1) * 0.9) / residuals.length),
  );

  const baselineSecondsPerMeter = quantile(
      train.map(({ row }) => row.actualSeconds / row.distanceMeters),
      0.5,
    ),
    evaluationModel = {
      ...pointModel,
      logRadius,
      baselineSecondsPerMeter,
    };

  const trainOds = new Set(train.map(({ row }) => row.odGroup));

  const all = evaluate(test, evaluationModel)!,
    seenOd = evaluate(
      test.filter(({ row }) => trainOds.has(row.odGroup)),
      evaluationModel,
    ),
    newOd = evaluate(
      test.filter(({ row }) => !trainOds.has(row.odGroup)),
      evaluationModel,
    ),
    evaluationVehicle = evaluate(
      test.filter(({ row }) => heldVehicles.has(row.vehicleGroup)),
      evaluationModel,
    );

  const parts = [...new Set(test.map(({ row }) => dayPart(row.startedAt)))],
    dayParts: Record<string, PublicBusEvaluation> = {},
    days: Record<string, PublicBusEvaluation> = {};

  for (const part of parts) {
    dayParts[part] = evaluate(
      test.filter(({ row }) => dayPart(row.startedAt) === part),
      evaluationModel,
    )!;
  }

  for (const day of report.split.test.dates) {
    days[day] = evaluate(
      test.filter(({ row }) => row.sourceDate === day),
      evaluationModel,
    )!;
  }

  report.evaluations = {
    all,
    seenOd,
    newOd,
    heldOutVehicle: evaluationVehicle,
    dayParts,
    days,
  };

  if (!good(all)) {
    report.reasons.push('future-day-quality-failed');
  }

  if (!good(newOd)) {
    report.reasons.push('unseen-od-quality-or-coverage-failed');
  }

  if (!good(evaluationVehicle)) {
    report.reasons.push('held-out-vehicle-quality-or-coverage-failed');
  }

  if (seenOd && !good(seenOd)) {
    report.reasons.push('seen-od-quality-or-coverage-failed');
  }

  for (const [part, evaluation] of Object.entries(dayParts)) {
    if (!good(evaluation)) {
      report.reasons.push(`day-part-quality-or-coverage-failed:${part}`);
    }
  }

  for (const [day, evaluation] of Object.entries(days)) {
    if (!good(evaluation)) {
      report.reasons.push(`day-quality-or-coverage-failed:${day}`);
    }
  }

  if (report.reasons.length) {
    return report;
  }

  report.qualityPassed = true;
  report.status = 'production-candidate';
  report.model = {
    scope: {
      kind: 'seoul-bounding-box-bus-endpoints',
      bounds: {
        ...PUBLIC_BUS_SCOPE_BOUNDS,
      },
      sourceRows: report.counts.accepted,
      eligibleRows: report.counts.eligible,
      excludedOutsideScope: report.counts.excludedOutsideScope,
    },
    roadPriorArchives: archives.data,
    version: 'public-bus-duration-v2',
    target: 'bus-tag-elapsed',
    deployment: 'production',
    usage: 'conservative-bus-envelope',
    trainedAt: now,
    expiresAt: now + 7 * DAY,
    featureNames: [...PUBLIC_BUS_FEATURE_NAMES],
    coefficients,
    regularization: 1,
    normalization,
    domain,
    logRadius,
    labelUncertaintySeconds: 60,
    baselineSecondsPerMeter,
    evaluation: all,
    validation: {
      protocol: 'whole-service-day-future-v1',
      qualityPassed: true,
      trainThrough: window.trainThrough,
      calibrationDates: window.calibrationDates,
      testDates: window.testDates,
      heldOutVehicleFraction: 0.1,
      heldOutVehicle: evaluationVehicle!,
      newOd: newOd!,
      seenOd: seenOd ?? null,
      dayParts,
      sourceDates: [...dayArchives.keys()].sort(),
      sourceArchiveCount: archiveDays.size,
      sourceArchives: [...dayArchives.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([sourceDate, sha256]) => ({
          sourceDate,
          sha256,
          rows: dayCounts.get(sourceDate)!,
        })),
      context: {
        historicalWeather: true,
        historicalPublicationAvailability: 'unknown',
        road: 'published-monthly-citywide-prior',
        contemporaneousProviderBaseline: false,
      },
    },
    split: report.split,
  };

  return report;
}

const evaluationSchema = z
  .object({
    rows: number.int().min(0),
    supported: number.int().min(0),
    unsupported: number.int().min(0),
    baselineMaeSeconds: number.min(0),
    modelMaeSeconds: number.min(0).nullable(),
    supportedModelMaeSeconds: number.min(0).nullable(),
    robustIntervalCoverage: number.min(0).max(1),
    robustUpperCoverage: number.min(0).max(1),
    meanRelativeWidth: number.min(0).nullable(),
  })
  .strict();

const splitSchema = z
  .object({
    rows: number.int().min(0),
    physicalRuns: number.int().min(0),
    vehicles: number.int().min(0),
    dates: z.array(daySchema).max(14),
    firstDay: daySchema.nullable(),
    lastDay: daySchema.nullable(),
    earliestStartedAt: stamp.nullable(),
    latestObservedAt: stamp.nullable(),
  })
  .strict();

const values = z.array(number).length(N);

const scopeSchema = z
  .object({
    kind: z.literal('seoul-bounding-box-bus-endpoints'),
    bounds: z
      .object({
        south: z.literal(37.4),
        north: z.literal(37.72),
        west: z.literal(126.73),
        east: z.literal(127.28),
      })
      .strict(),
    sourceRows: number.int().positive().max(MAX_ROWS),
    eligibleRows: number.int().positive().max(MAX_ROWS),
    excludedOutsideScope: number.int().min(0).max(MAX_ROWS),
  })
  .strict();

const modelSchema = z
  .object({
    scope: scopeSchema,
    version: z.literal('public-bus-duration-v2'),
    target: z.literal('bus-tag-elapsed'),
    deployment: z.literal('production'),
    usage: z.literal('conservative-bus-envelope'),
    trainedAt: stamp,
    expiresAt: stamp,
    featureNames: z.array(z.string()).length(N),
    coefficients: z.array(number.min(-20).max(20)).length(N + 1),
    regularization: z.literal(1),
    normalization: z
      .object({
        centers: values,
        scales: z.array(number.positive()).length(N),
        clip: z.literal(4),
      })
      .strict(),
    domain: z
      .object({
        minimum: values,
        maximum: values,
      })
      .strict(),
    logRadius: number.min(0.01).max(5),
    labelUncertaintySeconds: z.literal(60),
    roadPriorArchives: z.array(roadPriorArchiveSchema).max(24),
    baselineSecondsPerMeter: number.positive(),
    evaluation: evaluationSchema,
    validation: z
      .object({
        protocol: z.literal('whole-service-day-future-v1'),
        qualityPassed: z.literal(true),
        trainThrough: daySchema,
        calibrationDates: z.tuple([daySchema, daySchema]),
        testDates: z.tuple([daySchema]),
        heldOutVehicleFraction: z.literal(0.1),
        heldOutVehicle: evaluationSchema,
        newOd: evaluationSchema,
        seenOd: evaluationSchema.nullable(),
        dayParts: z.record(z.string(), evaluationSchema),
        sourceDates: z.array(daySchema).length(14),
        sourceArchiveCount: z.literal(14),
        sourceArchives: z
          .array(
            z
              .object({
                sourceDate: daySchema,
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                rows: number.int().positive().max(10_000),
              })
              .strict(),
          )
          .length(14),
        context: z
          .object({
            historicalWeather: z.literal(true),
            historicalPublicationAvailability: z.literal('unknown'),
            road: z.literal('published-monthly-citywide-prior'),
            contemporaneousProviderBaseline: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    split: z
      .object({
        train: splitSchema,
        calibration: splitSchema,
        test: splitSchema,
      })
      .strict(),
  })
  .strict();

/** A filename, success flag, or shadow artifact cannot make a failed or expired model usable. */
export function parsePublicBusModel(
  json: string,
  now = Date.now(),
  options: {
    allowExpired?: boolean;
  } = {},
): PublicBusModel {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 1_048_576) {
    throw new Error('invalid-public-bus-model');
  }

  const model = modelSchema.parse(JSON.parse(json)) as PublicBusModel;

  if (
    !Number.isSafeInteger(now) ||
    model.trainedAt > now ||
    (!options.allowExpired && model.expiresAt <= now) ||
    model.expiresAt <= model.trainedAt ||
    model.expiresAt - model.trainedAt > 7 * DAY ||
    model.featureNames.some((name, index) => name !== PUBLIC_BUS_FEATURE_NAMES[index]) ||
    model.domain.minimum.some((min, index) => min > model.domain.maximum[index]) ||
    !good(model.evaluation) ||
    !good(model.validation.heldOutVehicle) ||
    !good(model.validation.newOd) ||
    (model.validation.seenOd && !good(model.validation.seenOd)) ||
    !Object.keys(model.validation.dayParts).length ||
    Object.values(model.validation.dayParts).some((value) => !good(value)) ||
    new Set(model.validation.sourceDates).size !== 14 ||
    model.split.train.rows < 1000 ||
    model.split.calibration.rows < 200 ||
    model.split.test.rows < 200 ||
    model.split.train.latestObservedAt! > model.split.calibration.earliestStartedAt! ||
    model.split.calibration.latestObservedAt! > model.split.test.earliestStartedAt!
  ) {
    throw new Error('invalid-public-bus-model');
  }

  const window = publicBusTrainingWindow(model.validation.sourceDates[0]),
    expectedDates = window.dates;

  if (
    window.endExclusive > model.trainedAt ||
    model.validation.trainThrough !== window.trainThrough ||
    JSON.stringify(model.validation.calibrationDates) !== JSON.stringify(window.calibrationDates) ||
    JSON.stringify(model.validation.testDates) !== JSON.stringify(window.testDates)
  ) {
    throw new Error('invalid-public-bus-model');
  }

  if (
    model.scope.sourceRows !== model.scope.eligibleRows + model.scope.excludedOutsideScope ||
    model.validation.sourceArchives.reduce((sum, value) => sum + value.rows, 0) !==
      model.scope.sourceRows ||
    Object.values(model.split).reduce((sum, value) => sum + value.rows, 0) >
      model.scope.eligibleRows ||
    JSON.stringify(model.validation.sourceDates) !== JSON.stringify(expectedDates) ||
    JSON.stringify(model.split.train.dates) !== JSON.stringify(expectedDates.slice(0, 11)) ||
    JSON.stringify(model.split.calibration.dates) !== JSON.stringify(expectedDates.slice(11, 13)) ||
    JSON.stringify(model.split.test.dates) !== JSON.stringify(expectedDates.slice(13)) ||
    model.split.train.latestObservedAt! >= window.calibrationStart ||
    model.split.calibration.latestObservedAt! >= window.testStart ||
    model.split.test.earliestStartedAt! < window.testStart ||
    model.split.test.latestObservedAt! > model.trainedAt ||
    model.evaluation.rows !== model.split.test.rows ||
    model.validation.sourceArchives.some(
      (archive, index) => archive.sourceDate !== expectedDates[index],
    ) ||
    new Set(model.validation.sourceArchives.map((value) => value.sha256)).size !== 14 ||
    Object.values(model.split).some(
      (value) =>
        value.rows !== value.physicalRuns ||
        value.vehicles > value.rows ||
        value.firstDay !== value.dates[0] ||
        value.lastDay !== value.dates.at(-1),
    ) ||
    Object.values(model.validation.dayParts).reduce((sum, value) => sum + value.rows, 0) !==
      model.evaluation.rows
  ) {
    throw new Error('invalid-public-bus-model');
  }

  for (const evaluation of [
    model.evaluation,
    model.validation.heldOutVehicle,
    model.validation.newOd,
    model.validation.seenOd,
    ...Object.values(model.validation.dayParts),
  ]) {
    if (evaluation && evaluation.supported + evaluation.unsupported !== evaluation.rows) {
      throw new Error('invalid-public-bus-model');
    }
  }

  return model;
}

export function predictPublicBusDuration(
  model: PublicBusModel,
  value: PublicBusPredictionInput,
  now = Date.now(),
) {
  const parsed = inputSchema.safeParse(value);

  if (
    !parsed.success ||
    !Number.isFinite(now) ||
    model.trainedAt > now ||
    model.expiresAt <= now ||
    value.startedAt > now + 4 * 3600_000 ||
    value.startedAt < now - 7 * DAY ||
    !validContext(parsed.data)
  ) {
    return null;
  }

  const prediction = point(vector(parsed.data), model);

  if (prediction === null) {
    return null;
  }

  const lowerSeconds = Math.max(1, prediction * Math.exp(-model.logRadius) - 60),
    upperSeconds = prediction * Math.exp(model.logRadius) + 60;

  if (upperSeconds > 86_400) {
    return null;
  }

  return {
    lowerSeconds,
    medianSeconds: prediction,
    upperSeconds,
    modelVersion: 'public-bus-duration-v2' as const,
    target: 'bus-tag-elapsed' as const,
    trainedAt: model.trainedAt,
    evaluatedAt: now,
  };
}
