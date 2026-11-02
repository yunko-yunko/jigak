import { z } from 'zod';
import type { BaseSegment } from '../../shared/domain/types.js';
import { HOLIDAY_AS_SUNDAY, holidayAsSunday, type SeoulWeekday } from './korean-holidays.js';
import { SPATIAL_BICYCLE_FEATURE_NAMES } from './spatial-bicycle-model.js';
import {
  candidateReasons,
  ModelFileLoader,
  provenanceFields,
  type LoadedModel,
  type ModelPathSource,
} from './model-manifest.js';

/**
 * 따릉이 dock-to-dock ride time learned from June 2026 direct rides (unlock to lock, no long stop
 * or loop). Serves quartiles for dock pairs the measured table does not cover; OSRM's bike profile
 * runs well faster than 따릉이 riders do.
 */
export const SPATIAL_BICYCLE_V2 = 'seoul-bicycle-spatial-v2' as const;
export const SPATIAL_BICYCLE_DAY_PARTS = [
  ['night', 0, 6],
  ['morning', 6, 10],
  ['day', 10, 17],
  ['evening', 17, 21],
  ['late', 21, 24],
] as const;
export const SPATIAL_BICYCLE_GROUPS = (['weekday', 'weekend'] as const).flatMap((kind) =>
  SPATIAL_BICYCLE_DAY_PARTS.map(([name]) => `${kind}:${name}`),
);
const N = SPATIAL_BICYCLE_FEATURE_NAMES.length,
  finite = z.number().finite(),
  isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
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
  .object({ initial: finite, trees: z.array(z.array(node).min(1).max(125)).min(1).max(180) })
  .strict();
const logAdjustment = finite.min(-Math.log(4)).max(Math.log(4));
const checkpointSchema = z
  .object({
    version: z.literal(SPATIAL_BICYCLE_V2),
    deployment: z.literal('production'),
    target: z.literal('bicycle-direct-ride-elapsed'),
    region: z.literal('seoul'),
    trainedAt: finite.int().positive(),
    expiresAt: finite.int().positive(),
    trainingThrough: isoDay,
    lastEvaluatedServiceDate: isoDay,
    sourceMonth: z.string().regex(/^\d{4}-\d{2}$/),
    featureNames: z.array(z.string()).length(N),
    models: z
      .object({ lower: ensemble, q25: ensemble, median: ensemble, q75: ensemble, upper: ensemble })
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
      .length(SPATIAL_BICYCLE_GROUPS.length),
    labelUncertaintySeconds: z.literal(1),
    domain: z
      .object({ minimum: z.array(finite).length(N), maximum: z.array(finite).length(N) })
      .strict(),
    targetDefinition: z.record(z.string(), z.unknown()),
    evaluation: z.record(z.string(), z.unknown()),
    source: z
      .object({
        experiment: z.string(),
        protocolSha256: z.string().regex(/^[a-f0-9]{64}$/),
        modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    limitations: z.array(z.string()).min(1).max(20),
  })
  .strict();
export type SpatialBicycleCheckpoint = z.infer<typeof checkpointSchema>;
export interface BicycleRidePoint {
  latitude: number;
  longitude: number;
}
export interface SpatialBicycleRideInput {
  startedAt: number;
  originLatitude: number;
  originLongitude: number;
  destinationLatitude: number;
  destinationLongitude: number;
}

export function parseSpatialBicycleCheckpoint(text: string): SpatialBicycleCheckpoint {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new Error('invalid-spatial-bicycle-model');
  const model = checkpointSchema.parse(JSON.parse(text));
  if (
    model.featureNames.some((name, i) => name !== SPATIAL_BICYCLE_FEATURE_NAMES[i]) ||
    model.domain.minimum.some((value, i) => value > model.domain.maximum[i]) ||
    model.conformal.some((entry, i) => entry.group !== SPATIAL_BICYCLE_GROUPS[i]) ||
    model.expiresAt <= model.trainedAt ||
    model.calendar.firstDate > model.calendar.lastDate ||
    model.calendar.holidays.some(
      (day) => day < model.calendar.firstDate || day > model.calendar.lastDate,
    )
  )
    throw new Error('invalid-spatial-bicycle-contract');
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
          throw new Error('invalid-spatial-bicycle-tree');
        parents[entry.left]++;
        parents[entry.right]++;
      }
      if (parents[0] !== 0 || parents.slice(1).some((count) => count !== 1))
        throw new Error('disconnected-spatial-bicycle-tree');
    }
  return model;
}

/** Same inputs and rounding as scripts/train-spatial-bicycle-v2.py; a reviewed holiday is read as Sunday. */
export function spatialBicycleRideFeatures(
  input: SpatialBicycleRideInput,
  weekdayOf: SeoulWeekday,
): number[] | null {
  if (
    !input ||
    ![
      input.startedAt,
      input.originLatitude,
      input.originLongitude,
      input.destinationLatitude,
      input.destinationLongitude,
    ].every(Number.isFinite) ||
    !Number.isSafeInteger(input.startedAt) ||
    input.startedAt <= 0
  )
    return null;
  const {
    originLatitude: a,
    originLongitude: b,
    destinationLatitude: c,
    destinationLongitude: d,
  } = input;
  if (!(a > 37 && a < 38 && c > 37 && c < 38 && b > 126 && b < 128 && d > 126 && d < 128))
    return null;
  const rad = Math.PI / 180,
    v =
      Math.sin(((c - a) * rad) / 2) ** 2 +
      Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(((d - b) * rad) / 2) ** 2;
  const distance = 6371000 * 2 * Math.atan2(Math.sqrt(v), Math.sqrt(Math.max(0, 1 - v)));
  if (distance < 100 || distance > 20000) return null;
  const north = (c - a) * 111195.0802335329,
    east = (d - b) * 111195.0802335329 * Math.cos(((a + c) / 2) * rad),
    norm = Math.hypot(north, east);
  const local = new Date(input.startedAt + 9 * 3600000),
    day = weekdayOf(input.startedAt);
  if (!Number.isFinite(local.getTime()) || day === null) return null;
  const hour =
      ((local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600) / 24) *
      2 *
      Math.PI,
    weekday = (day / 7) * 2 * Math.PI;
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
    Math.sin(weekday),
    Math.cos(weekday),
    Number(day === 0 || day === 6),
  ].map((value) => Math.round(value * 1e10) / 1e10);
}

function predictEnsemble(
  model: SpatialBicycleCheckpoint['models']['median'],
  features: readonly number[],
): number {
  let result = model.initial;
  for (const tree of model.trees) {
    let index = 0;
    while (!tree[index].leaf) {
      const entry = tree[index];
      index = features[entry.feature] <= entry.threshold ? entry.left : entry.right;
    }
    result += tree[index].value;
  }
  return result;
}

export interface SpatialBicycleRideEstimate {
  medianSeconds: number;
  lowerSeconds: number;
  upperSeconds: number;
  bandLowerSeconds: number;
  bandUpperSeconds: number;
}
/** Quartiles (what the app serves) and the calibrated 5–95% band; null outside the trained domain or reviewed calendar. */
export function predictSpatialBicycleRide(
  model: Pick<SpatialBicycleCheckpoint, 'models' | 'domain' | 'conformal' | 'calendar'>,
  input: SpatialBicycleRideInput,
): SpatialBicycleRideEstimate | null {
  const weekdayOf = holidayAsSunday(model.calendar),
    features = spatialBicycleRideFeatures(input, weekdayOf);
  if (!features) return null;
  for (const i of [0, 1, 2, 3, 4]) {
    const tolerance = i === 0 ? 0.15 * (model.domain.maximum[0] - model.domain.minimum[0]) : 0.015;
    if (
      features[i] < model.domain.minimum[i] - tolerance ||
      features[i] > model.domain.maximum[i] + tolerance
    )
      return null;
  }
  const day = weekdayOf(input.startedAt)!,
    hour = new Date(input.startedAt + 9 * 3600000).getUTCHours();
  const part = SPATIAL_BICYCLE_DAY_PARTS.find(([, from, to]) => hour >= from && hour < to)![0];
  const adjustment = model.conformal.find(
    (entry) => entry.group === `${day === 0 || day === 6 ? 'weekend' : 'weekday'}:${part}`,
  )!;
  const clip = (value: number) => Math.max(1, Math.min(10800, value));
  const median = clip(predictEnsemble(model.models.median, features));
  const q25 = clip(Math.min(predictEnsemble(model.models.q25, features), median)),
    q75 = clip(Math.max(predictEnsemble(model.models.q75, features), median));
  const low = clip(Math.min(predictEnsemble(model.models.lower, features), median)),
    high = clip(Math.max(predictEnsemble(model.models.upper, features), median));
  const bandLowerSeconds = low / Math.exp(adjustment.logLower);
  return {
    medianSeconds: median,
    lowerSeconds: q25,
    upperSeconds: q75,
    bandLowerSeconds,
    bandUpperSeconds: Math.max(bandLowerSeconds, high * Math.exp(adjustment.logUpper)),
  };
}

export interface ModelledBicycleRide extends SpatialBicycleRideEstimate {
  modelVersion: typeof SPATIAL_BICYCLE_V2;
  sourceMonth: string;
}

/** Loads the served checkpoint; re-reads it when the file changes. */
export class SpatialBicycleRideService {
  private model?: SpatialBicycleCheckpoint;
  private reason = 'missing-checkpoint';
  private checkedAt = 0;
  private loaded: LoadedModel<SpatialBicycleCheckpoint> = {
    reason: 'missing-checkpoint',
    provenance: null,
    candidate: null,
  };
  private readonly loader: ModelFileLoader<SpatialBicycleCheckpoint>;
  private counters = { attempts: 0, applied: 0, inactive: 0, unsupported: 0 };
  private readonly now: () => number;
  constructor(private readonly options: { modelPath: ModelPathSource; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.loader = new ModelFileLoader({
      source: options.modelPath,
      maxBytes: 32 * 1024 * 1024,
      parse: (text) => parseSpatialBicycleCheckpoint(text),
    });
    this.reload();
  }
  private reload() {
    const now = this.now();
    if (
      this.checkedAt &&
      now - this.checkedAt >= 0 &&
      now - this.checkedAt < 30_000 &&
      !this.loader.pending()
    )
      return;
    this.checkedAt = now;
    this.loaded = this.loader.read(now);
    this.model = this.loaded.model;
    this.reason = this.loaded.reason;
  }
  /** Unlock-to-lock seconds between two docks for a ride starting at `startedAt`. */
  ride(
    hire: BicycleRidePoint,
    drop: BicycleRidePoint,
    startedAt: number,
  ): ModelledBicycleRide | null {
    this.reload();
    this.counters.attempts++;
    const now = this.now();
    if (!this.model || now < this.model.trainedAt || now >= this.model.expiresAt) {
      this.counters.inactive++;
      return null;
    }
    const estimate = predictSpatialBicycleRide(this.model, {
      startedAt: Math.ceil(startedAt),
      originLatitude: hire.latitude,
      originLongitude: hire.longitude,
      destinationLatitude: drop.latitude,
      destinationLongitude: drop.longitude,
    });
    if (!estimate) {
      this.counters.unsupported++;
      return null;
    }
    this.counters.applied++;
    return { ...estimate, modelVersion: SPATIAL_BICYCLE_V2, sourceMonth: this.model.sourceMonth };
  }
  status() {
    this.reload();
    const now = this.now(),
      active = !!this.model && this.model.trainedAt <= now && this.model.expiresAt > now;
    return {
      version: SPATIAL_BICYCLE_V2,
      target: 'bicycle-direct-ride-elapsed',
      active,
      usage: 'dock-pairs-without-measured-rides',
      sourceMonth: this.model?.sourceMonth ?? null,
      trainedAt: this.model?.trainedAt ?? null,
      expiresAt: this.model?.expiresAt ?? null,
      ...provenanceFields(this.loaded),
      operations: {
        remainingSeconds: this.model
          ? Math.max(0, Math.floor((this.model.expiresAt - now) / 1000))
          : null,
        lastEvaluatedServiceDate: this.model?.lastEvaluatedServiceDate ?? null,
        counters: { ...this.counters },
        fallback: 'measured-dock-pair-first-then-this-model-then-osrm',
      },
      reasons: [
        ...(active
          ? []
          : [
              this.model && this.model.expiresAt <= now
                ? 'expired-checkpoint'
                : this.reason || 'inactive-checkpoint',
            ]),
        ...candidateReasons(this.loaded),
      ],
      ...(active
        ? {
            evaluation: this.model!.evaluation,
            targetDefinition: this.model!.targetDefinition,
            holidays: this.model!.calendar.holidays,
            source: this.model!.source,
          }
        : {}),
      limitations: this.model?.limitations ?? [],
    };
  }
}

/** Puts a modelled ride on a router bicycle segment, as measuredRide does for a measured dock pair. */
export function modelledBicycleRide(segment: BaseSegment, ride: ModelledBicycleRide): BaseSegment {
  const lower = Math.round(ride.lowerSeconds),
    upper = Math.max(lower, Math.round(ride.upperSeconds)),
    month = Number(ride.sourceMonth.slice(5, 7));
  return {
    ...segment,
    durationSeconds: { min: lower, max: upper },
    instructions:
      `${segment.instructions ?? ''} 소요 시간은 ${month}월 따릉이 대여 기록으로 추정했어요(보통 ${Math.round(ride.medianSeconds / 60)}분).`.trim(),
  };
}
