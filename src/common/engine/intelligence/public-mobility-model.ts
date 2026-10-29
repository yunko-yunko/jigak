import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PUBLIC_MOBILITY_KINDS = ['rail', 'transit-chain', 'bicycle', 'taxi', 'walk'] as const;

export type PublicMobilityKind = (typeof PUBLIC_MOBILITY_KINDS)[number];

const DAY = 86_400_000,
  MAX_ROWS = 150_000;
const finite = z.number().finite(),
  stamp = finite.int().positive().max(8_640_000_000_000_000);
const token = z.string().regex(/^[a-f0-9]{64}$/),
  date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name = z.string().trim().min(1).max(180);

const weatherSchema = z
  .object({
    source: z.literal('noaa-ghcnh'),
    stationId: z.literal('KSI0000RKSL'),
    observedAt: stamp,
    temperatureC: finite.min(-60).max(60).nullable(),
    windMetersPerSecond: finite.min(0).max(100).nullable(),
    precipitationMm: finite.min(0).max(500).nullable(),
    precipitationTrace: z.boolean(),
    ageSeconds: finite.int().min(0).max(10_800),
    retrospective: z.literal(true),
    availability: z.literal('historical-publication-unknown'),
  })
  .strict();

type Weather = z.infer<typeof weatherSchema>;

const base = {
  version: z.literal(1),
  id: token,
  groupId: token,
  sourceArchiveSha256: token,
  sourceDate: date,
  startedAt: stamp,
  observedAt: stamp,
  actualSeconds: finite.positive().max(86_400),
  uncertaintySeconds: finite.min(0).max(60),
  weather: weatherSchema.nullable().optional(),
};

const legSchema = z
  .object({
    mode: z.enum(['bus', 'subway']),
    originName: name,
    destinationName: name,
    startedAt: stamp,
    observedAt: stamp,
    routeNumber: name.optional(),
  })
  .strict();

const railSchema = z
  .object({
    ...base,
    journeyGroup: token,
    cardGroup: token,
    source: z.enum(['seoul-tdata-rail', 'seoul-tdata-transit-journey']),
    target: z.enum(['rail-gate-elapsed', 'transit-chain-elapsed']),
    uncertaintySeconds: z.literal(60),
    originName: name,
    destinationName: name,
    originStationId: name.nullable(),
    destinationStationId: name.nullable(),
    modeSequence: z
      .array(z.enum(['bus', 'subway']))
      .min(1)
      .max(5),
    transferCount: finite.int().min(0).max(4),
    legCount: finite.int().min(1).max(5),
    transferGapSeconds: finite.int().min(0).max(28_800),
    legs: z.array(legSchema).min(1).max(5),
  })
  .strict();

const numericSchema = z
  .object({
    ...base,
    entityGroup: token.optional(),
    source: z.enum(['seoul-ddareungi-rental', 'nyc-tlc-yellow', 'microsoft-geolife']),
    region: z.enum(['seoul', 'nyc', 'beijing']),
    mode: z.enum(['bicycle', 'taxi', 'walk']),
    target: z.enum(['bicycle-rental-elapsed', 'taxi-meter-elapsed', 'labeled-walk-elapsed']),
    deploymentEligible: z.literal(false),
    uncertaintySeconds: z.literal(1),
    originLatitude: finite.min(-90).max(90),
    originLongitude: finite.min(-180).max(180),
    destinationLatitude: finite.min(-90).max(90),
    destinationLongitude: finite.min(-180).max(180),
    inputDistanceMeters: finite.positive().max(200_000),
    observedPathMeters: finite.min(0).max(1_000_000).nullable(),
    coordinatePrecision: z.enum(['station', 'taxi-zone-centroid', 'gps-endpoint']),
    inputDistanceKind: z.enum([
      'station-geodesic',
      'taxi-zone-centroid-geodesic',
      'gps-endpoint-geodesic',
    ]),
    originStationId: name.optional(),
    destinationStationId: name.optional(),
    originZoneId: name.optional(),
    destinationZoneId: name.optional(),
    licenseScope: z.literal('noncommercial-research-no-redistribution').optional(),
    labelCoverageToleranceSeconds: z.literal(60).optional(),
  })
  .strict();

type RailObservation = z.infer<typeof railSchema>;

type NumericObservation = z.infer<typeof numericSchema>;

type Observation = RailObservation | NumericObservation;

export interface PublicMobilityPredictionInput {
  kind: PublicMobilityKind;
  startedAt: number;
  region: 'seoul' | 'nyc' | 'beijing';
  inputDistanceMeters: number | null;
  originName: string | null;
  destinationName: string | null;
  modeSequence: string[];
  weather: Weather | null;
}

const OFFSET = {
  rail: 9,
  'transit-chain': 9,
  bicycle: 9,
  taxi: -5,
  walk: 8,
} as const;

const local = (at: number, kind: PublicMobilityKind) => new Date(at + OFFSET[kind] * 3600_000);

const localDate = (at: number, kind: PublicMobilityKind) =>
  local(at - (kind === 'rail' || kind === 'transit-chain' ? 4 * 3600_000 : 0), kind)
    .toISOString()
    .slice(0, 10);

const isRail = (kind: PublicMobilityKind) => kind === 'rail' || kind === 'transit-chain';

const regionFor = (kind: PublicMobilityKind) =>
  kind === 'taxi' ? ('nyc' as const) : kind === 'walk' ? ('beijing' as const) : ('seoul' as const);

const normalizedName = (value: string) => value.normalize('NFC').trim();

const odKey = (input: PublicMobilityPredictionInput) =>
  createHash('sha256')
    .update(JSON.stringify([input.originName, input.destinationName, input.modeSequence]))
    .digest('hex');

const entity = (row: Observation) =>
  'cardGroup' in row ? row.cardGroup : (row.entityGroup ?? null);

const entityHeldOut = (value: string) =>
  createHash('sha256')
    .update(`public-mobility-entity-holdout-v1|${value}`)
    .digest()
    .readUInt32BE(0) %
    10 ===
  0;

const groupKey = (row: Observation, kind: PublicMobilityKind) =>
  kind === 'walk' ? `${entity(row)}:${row.sourceDate}` : row.groupId;

const sourceSpec = {
  bicycle: ['seoul-ddareungi-rental', 'bicycle-rental-elapsed', 'station', 'station-geodesic'],
  taxi: [
    'nyc-tlc-yellow',
    'taxi-meter-elapsed',
    'taxi-zone-centroid',
    'taxi-zone-centroid-geodesic',
  ],
  walk: ['microsoft-geolife', 'labeled-walk-elapsed', 'gps-endpoint', 'gps-endpoint-geodesic'],
} as const;

/** Selects only values known when the requested endpoints/mode order are chosen. */
export function publicMobilityInputForObservation(
  kind: PublicMobilityKind,
  value: unknown,
): PublicMobilityPredictionInput {
  const row = value as Observation;

  return {
    kind,
    startedAt: row.startedAt,
    region: regionFor(kind),
    inputDistanceMeters: 'inputDistanceMeters' in row ? row.inputDistanceMeters : null,
    originName: 'originName' in row ? normalizedName(row.originName) : null,
    destinationName: 'destinationName' in row ? normalizedName(row.destinationName) : null,
    modeSequence: 'modeSequence' in row ? [...row.modeSequence] : [row.mode],
    weather: row.weather ?? null,
  };
}

function geodesic(row: NumericObservation) {
  const radians = Math.PI / 180,
    lat = (row.destinationLatitude - row.originLatitude) * radians,
    lon = (row.destinationLongitude - row.originLongitude) * radians;
  const a =
    Math.sin(lat / 2) ** 2 +
    Math.cos(row.originLatitude * radians) *
      Math.cos(row.destinationLatitude * radians) *
      Math.sin(lon / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function inRegion(row: NumericObservation) {
  const bounds =
    row.region === 'seoul'
      ? [37, 38, 126, 128]
      : row.region === 'nyc'
        ? [40, 42, -75, -72]
        : [39, 41, 115, 118];

  return [
    [row.originLatitude, row.originLongitude],
    [row.destinationLatitude, row.destinationLongitude],
  ].every(([lat, lon]) => lat > bounds[0] && lat < bounds[1] && lon > bounds[2] && lon < bounds[3]);
}

function parseObservation(kind: PublicMobilityKind, raw: unknown, now: number): Observation | null {
  const parsed = isRail(kind) ? railSchema.safeParse(raw) : numericSchema.safeParse(raw);

  if (!parsed.success) {
    return null;
  }

  const row = parsed.data;

  if (
    row.startedAt >= row.observedAt ||
    row.observedAt > now ||
    Math.abs((row.observedAt - row.startedAt) / 1000 - row.actualSeconds) > 0.001 ||
    localDate(row.startedAt, kind) !== row.sourceDate
  ) {
    return null;
  }

  if (
    row.weather &&
    (regionFor(kind) !== 'seoul' ||
      row.weather.observedAt > row.startedAt ||
      row.startedAt - row.weather.observedAt > 10_800_000 ||
      Math.abs((row.startedAt - row.weather.observedAt) / 1000 - row.weather.ageSeconds) > 1)
  ) {
    return null;
  }

  if ('legs' in row) {
    if (
      (kind === 'rail') !== (row.target === 'rail-gate-elapsed') ||
      row.source !== (kind === 'rail' ? 'seoul-tdata-rail' : 'seoul-tdata-transit-journey') ||
      row.startedAt % 60_000 ||
      row.observedAt % 60_000 ||
      row.actualSeconds % 60 ||
      row.legCount !== row.legs.length ||
      row.transferCount !== row.legs.length - 1 ||
      row.modeSequence.some((mode, index) => mode !== row.legs[index]?.mode) ||
      row.modeSequence.length !== row.legs.length ||
      row.originName !== row.legs[0].originName ||
      row.destinationName !== row.legs.at(-1)!.destinationName ||
      row.startedAt !== row.legs[0].startedAt ||
      row.observedAt !== row.legs.at(-1)!.observedAt
    ) {
      return null;
    }

    if (
      kind === 'rail' &&
      (row.legs.length !== 1 ||
        row.modeSequence[0] !== 'subway' ||
        !row.originStationId ||
        !row.destinationStationId)
    ) {
      return null;
    }

    if (
      kind === 'transit-chain' &&
      (!row.modeSequence.includes('subway') || !row.modeSequence.includes('bus'))
    ) {
      return null;
    }

    if (row.actualSeconds < 180 || row.actualSeconds > (kind === 'rail' ? 10_800 : 21_600)) {
      return null;
    }

    let gaps = 0;

    for (let index = 0; index < row.legs.length; index++) {
      const leg = row.legs[index];

      if (
        leg.startedAt >= leg.observedAt ||
        leg.startedAt % 60_000 ||
        leg.observedAt % 60_000 ||
        leg.observedAt - leg.startedAt < 180_000 ||
        leg.observedAt - leg.startedAt > 10_800_000
      ) {
        return null;
      }

      if (index) {
        const gap = (leg.startedAt - row.legs[index - 1].observedAt) / 1000;

        if (gap < 0 || gap > 7200) {
          return null;
        }

        gaps += gap;
      }
    }

    if (gaps !== row.transferGapSeconds) {
      return null;
    }
  } else {
    if (isRail(kind)) {
      return null;
    }

    const expected = sourceSpec[kind as keyof typeof sourceSpec];

    if (
      row.source !== expected[0] ||
      row.target !== expected[1] ||
      row.coordinatePrecision !== expected[2] ||
      row.inputDistanceKind !== expected[3] ||
      row.region !== regionFor(kind) ||
      row.mode !== kind ||
      !inRegion(row)
    ) {
      return null;
    }

    if (
      Math.abs(geodesic(row) - row.inputDistanceMeters) >
      Math.max(2, row.inputDistanceMeters * 0.001)
    ) {
      return null;
    }

    if (
      kind === 'walk' &&
      (!row.entityGroup ||
        row.licenseScope !== 'noncommercial-research-no-redistribution' ||
        row.labelCoverageToleranceSeconds !== 60)
    ) {
      return null;
    }
  }

  return row;
}

export const PUBLIC_MOBILITY_FEATURE_NAMES = [
  'logEndpointGeodesicMeters',
  'distanceMissing',
  'localHourSin',
  'localHourCos',
  'localWeekdaySin',
  'localWeekdayCos',
  'temperatureC',
  'temperatureMissing',
  'windMetersPerSecond',
  'windMissing',
  'logPrecipitationMm',
  'precipitationMissing',
  'precipitationTrace',
  'weatherAgeHours',
  'weatherMissing',
] as const;

const N = PUBLIC_MOBILITY_FEATURE_NAMES.length,
  categorical = new Set([1, 7, 9, 11, 12, 14]);

interface Normalization {
  centers: number[];
  scales: number[];
  clip: 4;
}

interface Domain {
  minimum: number[];
  maximum: number[];
}

function vector(input: PublicMobilityPredictionInput) {
  const date = local(input.startedAt, input.kind),
    hour =
      ((date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600) / 24) *
      Math.PI *
      2,
    weekday = (date.getUTCDay() / 7) * Math.PI * 2,
    w = input.weather;

  return [
    input.inputDistanceMeters === null ? 0 : Math.log(input.inputDistanceMeters),
    Number(input.inputDistanceMeters === null),
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
    w ? (input.startedAt - w.observedAt) / 3600_000 : 0,
    Number(!w),
  ];
}

const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1))];
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function normalize(raw: number[], normalization: Normalization, domain?: Domain) {
  const result = [];

  for (let index = 0; index < N; index++) {
    const value = raw[index],
      scale = normalization.scales[index],
      center = normalization.centers[index];

    if (![value, scale, center].every(Number.isFinite) || scale <= 0) {
      return null;
    }

    if (domain) {
      const minimum = domain.minimum[index],
        maximum = domain.maximum[index],
        tolerance = categorical.has(index)
          ? 0
          : Math.max(0.05, (maximum - minimum) * 0.15, scale * 0.25);

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

export interface PublicMobilityModel {
  version: 'public-mobility-shadow-v1';
  deployment: 'shadow';
  productionEligible: false;
  kind: PublicMobilityKind;
  region: 'seoul' | 'nyc' | 'beijing';
  target: string;
  source: string;
  trainedAt: number;
  featureNames: string[];
  coefficients: number[];
  regularization: 1;
  normalization: Normalization;
  domain: Domain;
  baselineSecondsPerMeter: number | null;
  odBaselines: Record<string, number>;
  logRadius: number | null;
  labelUncertaintySeconds: 1 | 60;
  descriptor: 'requested-endpoint-geodesic' | 'public-endpoint-name-mode-order';
  baselineUsesTrainingOnly: true;
  timezone: string;
}

interface Encoded {
  row: Observation;
  input: PublicMobilityPredictionInput;
  raw: number[];
  group: string;
}

export interface PublicMobilityEvaluation {
  rows: number;
  supported: number;
  unsupported: number;
  baselineMaeSeconds: number | null;
  modelMaeSeconds: number | null;
  supportedBaselineMaeSeconds: number | null;
  supportedModelMaeSeconds: number | null;
  robustIntervalCoverage: number;
  robustUpperCoverage: number;
  meanRelativeWidth: number | null;
}

interface SplitSummary {
  rows: number;
  groups: number;
  entities: number;
  dates: string[];
  earliestStartedAt: number | null;
  latestObservedAt: number | null;
}

export interface PublicMobilityReport {
  version: 'public-mobility-shadow-v1';
  deployment: 'shadow';
  productionEligible: false;
  kind: PublicMobilityKind;
  target: string;
  source: string;
  region: string;
  trainedAt: number;
  status: 'refused' | 'shadow-candidate';
  qualityPassed: boolean;
  reasons: string[];
  protocol: {
    chronological: true;
    split: string;
    heldOutEntityFraction: 0.1;
    entityMeaning:
      'public-bicycle-device' | 'public-card-holder' | 'geolife-person' | 'unavailable';
    contemporaneousProviderBaseline: false;
    initialFinalAppWalkObserved: false;
    foreignSourceApplicableToSeoul: false;
  };
  counts: {
    input: number;
    accepted: number;
    rejected: number;
    duplicate: number;
    train: number;
    calibration: number;
    test: number;
    purgedBoundary: number;
    excludedHeldOutTrainingRows: number;
    excludedHeldOutCalibrationRows: number;
    unsupportedCalibration: number;
    weather: number;
  };
  split: {
    train: SplitSummary;
    calibration: SplitSummary;
    test: SplitSummary;
  };
  entityOverlap: {
    trainCalibration: number;
    trainTest: number;
    heldOutInTraining: number;
    heldOutInCalibration: number;
  };
  evaluations: {
    all?: PublicMobilityEvaluation;
    seenOd?: PublicMobilityEvaluation;
    unseenOd?: PublicMobilityEvaluation;
    heldOutEntity?: PublicMobilityEvaluation;
    dayParts?: Record<string, PublicMobilityEvaluation>;
  };
  model?: PublicMobilityModel;
}

const summary = (rows: Encoded[]): SplitSummary => ({
  rows: rows.length,
  groups: new Set(rows.map((value) => value.group)).size,
  entities: new Set(rows.map((value) => entity(value.row)).filter(Boolean)).size,
  dates: [...new Set(rows.map((value) => value.row.sourceDate))].sort(),
  earliestStartedAt: rows.length
    ? rows.reduce((min, value) => Math.min(min, value.row.startedAt), Infinity)
    : null,
  latestObservedAt: rows.length
    ? rows.reduce((max, value) => Math.max(max, value.row.observedAt), 0)
    : null,
});

function baseline(input: PublicMobilityPredictionInput, model: PublicMobilityModel): number | null {
  return isRail(model.kind)
    ? (model.odBaselines[odKey(input)] ?? null)
    : input.inputDistanceMeters !== null && model.baselineSecondsPerMeter !== null
      ? input.inputDistanceMeters * model.baselineSecondsPerMeter
      : null;
}

function point(input: PublicMobilityPredictionInput, model: PublicMobilityModel): number | null {
  if (
    input.kind !== model.kind ||
    input.region !== model.region ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0 ||
    (input.inputDistanceMeters !== null &&
      (!Number.isFinite(input.inputDistanceMeters) || input.inputDistanceMeters <= 0))
  ) {
    return null;
  }

  if (
    input.weather &&
    (input.region !== 'seoul' ||
      input.weather.observedAt > input.startedAt ||
      input.startedAt - input.weather.observedAt > 10_800_000 ||
      Math.abs((input.startedAt - input.weather.observedAt) / 1000 - input.weather.ageSeconds) > 1)
  ) {
    return null;
  }

  const origin = baseline(input, model),
    values = normalize(vector(input), model.normalization, model.domain);

  if (origin === null || !values) {
    return null;
  }

  const prediction =
    origin *
    Math.exp(
      values.reduce(
        (sum, value, index) => sum + value * model.coefficients[index + 1],
        model.coefficients[0],
      ),
    );

  return Number.isFinite(prediction) && prediction >= 1 && prediction <= 86_400 ? prediction : null;
}

export function predictPublicMobilityShadow(
  model: PublicMobilityModel,
  input: PublicMobilityPredictionInput,
) {
  if (model.labelUncertaintySeconds !== (isRail(model.kind) ? 60 : 1)) {
    return null;
  }

  const medianSeconds = point(input, model);

  return medianSeconds === null || model.logRadius === null
    ? null
    : {
        medianSeconds,
        lowerSeconds: Math.max(
          0,
          medianSeconds * Math.exp(-model.logRadius) - model.labelUncertaintySeconds,
        ),
        upperSeconds: medianSeconds * Math.exp(model.logRadius) + model.labelUncertaintySeconds,
        deployment: 'shadow' as const,
        productionEligible: false as const,
      };
}

function fit(rows: Encoded[], model: PublicMobilityModel): number[] | null {
  const width = N + 1,
    matrix = Array.from(
      {
        length: width,
      },
      () => Array<number>(width + 1).fill(0),
    );

  for (const value of rows) {
    const norm = normalize(value.raw, model.normalization),
      source = baseline(value.input, model);

    if (!norm || !source) {
      return null;
    }

    const vector = [1, ...norm],
      target = Math.log(value.row.actualSeconds / source);

    for (let row = 0; row < width; row++) {
      for (let column = 0; column < width; column++) {
        matrix[row][column] += vector[row] * vector[column];
      }

      matrix[row][width] += vector[row] * target;
    }
  }

  for (let index = 1; index < width; index++) {
    matrix[index][index] += 1;
  }

  for (let column = 0; column < width; column++) {
    let pivot = column;

    for (let row = column + 1; row < width; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }

    if (Math.abs(matrix[pivot][column]) < 1e-10) {
      return null;
    }

    [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];

    const divisor = matrix[column][column];

    for (let index = column; index <= width; index++) {
      matrix[column][index] /= divisor;
    }

    for (let row = 0; row < width; row++) {
      if (row !== column) {
        const multiplier = matrix[row][column];

        for (let index = column; index <= width; index++) {
          matrix[row][index] -= multiplier * matrix[column][index];
        }
      }
    }
  }

  const result = matrix.map((row) => row[width]);

  return result.every((value) => Number.isFinite(value) && Math.abs(value) <= 20) ? result : null;
}

function evaluation(
  rows: Encoded[],
  model: PublicMobilityModel,
): PublicMobilityEvaluation | undefined {
  if (!rows.length) {
    return undefined;
  }

  const errors: number[] = [],
    baseErrors: number[] = [],
    widths: number[] = [];
  let covered = 0,
    upperCovered = 0;

  for (const { row, input } of rows) {
    const prediction = predictPublicMobilityShadow(model, input),
      source = baseline(input, model);

    if (!prediction || source === null) {
      continue;
    }

    const lower = prediction.lowerSeconds,
      upper = prediction.upperSeconds;

    errors.push(Math.abs(prediction.medianSeconds - row.actualSeconds));
    baseErrors.push(Math.abs(source - row.actualSeconds));
    widths.push((upper - lower) / row.actualSeconds);
    covered += Number(
      lower <= Math.max(0, row.actualSeconds - row.uncertaintySeconds) &&
        upper >= row.actualSeconds + row.uncertaintySeconds,
    );
    upperCovered += Number(upper >= row.actualSeconds + row.uncertaintySeconds);
  }

  const unsupported = rows.length - errors.length;

  return {
    rows: rows.length,
    supported: errors.length,
    unsupported,
    baselineMaeSeconds: unsupported || !errors.length ? null : mean(baseErrors),
    modelMaeSeconds: unsupported || !errors.length ? null : mean(errors),
    supportedBaselineMaeSeconds: baseErrors.length ? mean(baseErrors) : null,
    supportedModelMaeSeconds: errors.length ? mean(errors) : null,
    robustIntervalCoverage: covered / rows.length,
    robustUpperCoverage: upperCovered / rows.length,
    meanRelativeWidth: widths.length ? mean(widths) : null,
  };
}

const good = (value: PublicMobilityEvaluation | undefined) =>
  !!value &&
  value.rows >= 50 &&
  value.supported >= 50 &&
  value.supportedModelMaeSeconds !== null &&
  value.supportedBaselineMaeSeconds !== null &&
  value.supportedModelMaeSeconds < value.supportedBaselineMaeSeconds &&
  value.robustIntervalCoverage >= 0.8 &&
  value.robustUpperCoverage >= 0.9 &&
  value.meanRelativeWidth !== null &&
  value.meanRelativeWidth <= 1.5;

const dayPart = (input: PublicMobilityPredictionInput) => {
  const hour = local(input.startedAt, input.kind).getUTCHours();

  return hour < 6
    ? 'night'
    : hour < 10
      ? 'morning'
      : hour < 17
        ? 'daytime'
        : hour < 21
          ? 'evening'
          : 'late';
};

/** Offline research only. This module cannot create or promote a production model. */
export function trainPublicMobilityShadow(
  kind: PublicMobilityKind,
  observations: readonly unknown[],
  now = Date.now(),
): PublicMobilityReport {
  const empty = summary([]),
    spec = isRail(kind)
      ? [
          kind === 'rail' ? 'seoul-tdata-rail' : 'seoul-tdata-transit-journey',
          kind === 'rail' ? 'rail-gate-elapsed' : 'transit-chain-elapsed',
        ]
      : sourceSpec[kind as keyof typeof sourceSpec];

  const report: PublicMobilityReport = {
    version: 'public-mobility-shadow-v1',
    deployment: 'shadow',
    productionEligible: false,
    kind,
    source: spec[0],
    target: spec[1],
    region: regionFor(kind),
    trainedAt: now,
    status: 'refused',
    qualityPassed: false,
    reasons: [
      'no-contemporaneous-app-provider-baseline',
      'source-target-boundary-differs-from-app-navigation',
      'offline-shadow-only',
    ],
    protocol: {
      chronological: true,
      split: isRail(kind)
        ? 'train-through-2026-10-08_cal-10-09-10_test-10-11'
        : kind === 'bicycle'
          ? '2026-06_train-01-20_cal-21-25_test-26-30'
          : kind === 'taxi'
            ? '2026-01_train-01-20_cal-21-25_test-26-31'
            : 'whole-person-service-date-groups-60-20-20-boundary-purged',
      heldOutEntityFraction: 0.1,
      entityMeaning:
        kind === 'bicycle'
          ? 'public-bicycle-device'
          : kind === 'walk'
            ? 'geolife-person'
            : kind === 'taxi'
              ? 'unavailable'
              : 'public-card-holder',
      contemporaneousProviderBaseline: false,
      initialFinalAppWalkObserved: false,
      foreignSourceApplicableToSeoul: false,
    },
    counts: {
      input: observations?.length ?? 0,
      accepted: 0,
      rejected: 0,
      duplicate: 0,
      train: 0,
      calibration: 0,
      test: 0,
      purgedBoundary: 0,
      excludedHeldOutTrainingRows: 0,
      excludedHeldOutCalibrationRows: 0,
      unsupportedCalibration: 0,
      weather: 0,
    },
    split: {
      train: empty,
      calibration: empty,
      test: empty,
    },
    entityOverlap: {
      trainCalibration: 0,
      trainTest: 0,
      heldOutInTraining: 0,
      heldOutInCalibration: 0,
    },
    evaluations: {},
  };

  if (
    !PUBLIC_MOBILITY_KINDS.includes(kind) ||
    !Array.isArray(observations) ||
    observations.length > MAX_ROWS ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    report.reasons.push('invalid-training-input');

    return report;
  }

  const ids = new Set<string>(),
    groups = new Set<string>(),
    rows: Encoded[] = [];

  for (const raw of observations) {
    const row = parseObservation(kind, raw, now);

    if (!row) {
      report.counts.rejected++;
      continue;
    }

    if (ids.has(row.id) || groups.has(row.groupId)) {
      report.counts.duplicate++;
      continue;
    }

    ids.add(row.id);
    groups.add(row.groupId);

    const input = publicMobilityInputForObservation(kind, row);

    rows.push({
      row,
      input,
      raw: vector(input),
      group: groupKey(row, kind),
    });
    report.counts.accepted++;
    report.counts.weather += Number(!!row.weather);
  }

  if (report.counts.rejected || report.counts.duplicate) {
    report.reasons.push('invalid-or-duplicate-public-source-observation');

    return report;
  }

  rows.sort((a, b) => a.row.startedAt - b.row.startedAt || a.row.id.localeCompare(b.row.id));

  let train: Encoded[] = [],
    calibration: Encoded[] = [],
    test: Encoded[] = [];

  if (kind === 'walk') {
    const buckets = new Map<string, Encoded[]>();

    for (const row of rows) {
      const bucket = buckets.get(row.group) ?? [];

      bucket.push(row);
      buckets.set(row.group, bucket);
    }

    const ordered = [...buckets.values()].sort((a, b) => a[0].row.startedAt - b[0].row.startedAt),
      first = Math.floor(ordered.length * 0.6),
      second = Math.floor(ordered.length * 0.8);
    const calStarts = ordered[first]?.[0].row.startedAt ?? Infinity,
      testStarts = ordered[second]?.[0].row.startedAt ?? Infinity;

    train = ordered
      .slice(0, first)
      .filter((bucket) => bucket.every((value) => value.row.observedAt <= calStarts))
      .flat();
    calibration = ordered
      .slice(first, second)
      .filter((bucket) => bucket.every((value) => value.row.observedAt <= testStarts))
      .flat();
    test = ordered.slice(second).flat();
  } else {
    const prefix = isRail(kind) ? '2026-' : kind === 'bicycle' ? '2026-06-' : '2026-01-';
    const start = isRail(kind) ? '2026-09-28' : `${prefix}01`,
      trainEnd = isRail(kind) ? '2026-10-08' : `${prefix}20`,
      calEnd = isRail(kind) ? '2026-10-10' : `${prefix}25`,
      end = isRail(kind) ? '2026-10-11' : `${prefix}${kind === 'taxi' ? '31' : '30'}`;

    if (rows.some((value) => value.row.sourceDate < start || value.row.sourceDate > end)) {
      report.reasons.push('outside-frozen-source-period');

      return report;
    }

    train = rows.filter((value) => value.row.sourceDate <= trainEnd);
    calibration = rows.filter(
      (value) => value.row.sourceDate > trainEnd && value.row.sourceDate <= calEnd,
    );
    test = rows.filter((value) => value.row.sourceDate > calEnd);

    const calStarts = calibration[0]?.row.startedAt ?? Infinity,
      testStarts = test[0]?.row.startedAt ?? Infinity;

    train = train.filter((value) => value.row.observedAt <= calStarts);
    calibration = calibration.filter((value) => value.row.observedAt <= testStarts);
  }

  report.counts.purgedBoundary = rows.length - train.length - calibration.length - test.length;

  const heldOut = (value: Encoded) => {
    const group = entity(value.row);

    return group !== null && entityHeldOut(group);
  };

  const heldOutTest = test.filter(heldOut);

  report.counts.excludedHeldOutTrainingRows = train.filter(heldOut).length;
  report.counts.excludedHeldOutCalibrationRows = calibration.filter(heldOut).length;
  train = train.filter((value) => !heldOut(value));
  calibration = calibration.filter((value) => !heldOut(value));
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

  const trainEntities = new Set(train.map((value) => entity(value.row)).filter(Boolean)),
    calEntities = new Set(calibration.map((value) => entity(value.row)).filter(Boolean)),
    testEntities = new Set(test.map((value) => entity(value.row)).filter(Boolean));

  report.entityOverlap = {
    trainCalibration: [...trainEntities].filter((value) => calEntities.has(value)).length,
    trainTest: [...trainEntities].filter((value) => testEntities.has(value)).length,
    heldOutInTraining: train.filter(heldOut).length,
    heldOutInCalibration: calibration.filter(heldOut).length,
  };

  if (train.length < 100 || calibration.length < 50 || test.length < 50) {
    report.reasons.push('insufficient-independent-chronological-splits');

    return report;
  }

  const normalization: Normalization = {
    centers: PUBLIC_MOBILITY_FEATURE_NAMES.map((_, index) =>
      quantile(
        train.map((value) => value.raw[index]),
        0.5,
      ),
    ),
    scales: PUBLIC_MOBILITY_FEATURE_NAMES.map((_, index) =>
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

  const domain = {
    minimum: PUBLIC_MOBILITY_FEATURE_NAMES.map((_, index) =>
      train.reduce((min, value) => Math.min(min, value.raw[index]), Infinity),
    ),
    maximum: PUBLIC_MOBILITY_FEATURE_NAMES.map((_, index) =>
      train.reduce((max, value) => Math.max(max, value.raw[index]), -Infinity),
    ),
  };

  const odValues = new Map<string, number[]>();

  if (isRail(kind)) {
    for (const value of train) {
      const key = odKey(value.input),
        values = odValues.get(key) ?? [];

      values.push(value.row.actualSeconds);
      odValues.set(key, values);
    }
  }

  const model: PublicMobilityModel = {
    version: 'public-mobility-shadow-v1',
    deployment: 'shadow',
    productionEligible: false,
    kind,
    region: regionFor(kind),
    target: report.target,
    source: report.source,
    trainedAt: now,
    featureNames: [...PUBLIC_MOBILITY_FEATURE_NAMES],
    coefficients: [],
    regularization: 1,
    normalization,
    domain,
    baselineSecondsPerMeter: isRail(kind)
      ? null
      : quantile(
          train.map((value) => value.row.actualSeconds / value.input.inputDistanceMeters!),
          0.5,
        ),
    odBaselines: Object.fromEntries(
      [...odValues].map(([key, values]) => [key, quantile(values, 0.5)]),
    ),
    logRadius: null,
    labelUncertaintySeconds: isRail(kind) ? 60 : 1,
    descriptor: isRail(kind) ? 'public-endpoint-name-mode-order' : 'requested-endpoint-geodesic',
    baselineUsesTrainingOnly: true,
    timezone:
      kind === 'taxi'
        ? 'America/New_York (January UTC-05:00)'
        : kind === 'walk'
          ? 'Asia/Shanghai'
          : 'Asia/Seoul',
  };

  const coefficients = fit(train, model);

  if (!coefficients) {
    report.reasons.push('ridge-fit-refused');

    return report;
  }

  model.coefficients = coefficients;

  const residuals: number[] = [];

  for (const value of calibration) {
    const median = point(value.input, model);

    if (median === null) {
      report.counts.unsupportedCalibration++;
    } else {
      residuals.push(Math.abs(Math.log(value.row.actualSeconds / median)));
    }
  }

  if (residuals.length >= 50) {
    model.logRadius = Math.max(
      0.01,
      quantile(residuals, Math.min(1, Math.ceil((residuals.length + 1) * 0.9) / residuals.length)),
    );
  } else {
    report.reasons.push('insufficient-supported-calibration-observations');
  }

  const trainOds = new Set(train.map((value) => odKey(value.input))),
    all = evaluation(test, model),
    seenOd = isRail(kind)
      ? evaluation(
          test.filter((value) => trainOds.has(odKey(value.input))),
          model,
        )
      : undefined,
    unseenOd = isRail(kind)
      ? evaluation(
          test.filter((value) => !trainOds.has(odKey(value.input))),
          model,
        )
      : undefined;

  const parts: Record<string, PublicMobilityEvaluation> = {};

  for (const part of new Set(test.map((value) => dayPart(value.input)))) {
    parts[part] = evaluation(
      test.filter((value) => dayPart(value.input) === part),
      model,
    )!;
  }

  report.evaluations = {
    all,
    seenOd,
    unseenOd,
    heldOutEntity: evaluation(heldOutTest, model),
    dayParts: parts,
  };
  report.model = model;
  report.status = 'shadow-candidate';
  report.qualityPassed =
    good(all) &&
    !report.counts.unsupportedCalibration &&
    Object.values(parts).every((value) => value.rows < 50 || good(value)) &&
    (!isRail(kind) || !unseenOd || good(unseenOd)) &&
    (kind === 'taxi' || good(report.evaluations.heldOutEntity));

  if (!report.qualityPassed) {
    report.reasons.push('held-out-quality-not-demonstrated');
  }

  if (report.counts.unsupportedCalibration || all?.unsupported) {
    report.reasons.push('unsupported-held-out-context-kept-in-coverage-denominator');
  }

  if (kind === 'taxi') {
    report.reasons.push('individual-taxi-vehicle-identity-unavailable');
  }

  if (report.counts.weather === 0) {
    report.reasons.push('no-source-time-weather-observations-joined');
  }

  return report;
}
