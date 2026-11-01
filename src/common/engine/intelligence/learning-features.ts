import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  SegmentMode,
} from '../../shared/domain/types.js';
import type { EtaLearningFeatures } from '../../shared/intelligence/learning.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import { localWeatherIsFresh } from './planningTiming.js';

export interface ContextualEstimate {
  medianSeconds: number;
  lowerSeconds: number;
  upperSeconds: number;
  modelVersion: 'eta-context-v2' | 'eta-hgb-v1';
}
export type ContextualPredictor = (features: EtaLearningFeatures) => ContextualEstimate | null;
const LEVELS = ['unknown', 'free', 'slow', 'delay', 'jam'] as const;
function congestion(segment: BaseSegment): EtaLearningFeatures['congestionLevel'] {
  return (
    segment.traffic?.reduce<EtaLearningFeatures['congestionLevel']>(
      (level, span) =>
        LEVELS.indexOf(span.level as typeof level) > LEVELS.indexOf(level)
          ? (span.level as typeof level)
          : level,
      'unknown',
    ) ?? 'unknown'
  );
}
/** Search-time weather describes only stages that start this soon after the search; the observation store clears it for later starts. */
export const SEARCH_CONTEXT_HORIZON_MS = 120_000;
export interface ContextualTimingState {
  startedAt: number;
  precedingWaitSeconds: number;
  vehicleCount: number;
  requestNow: number;
}
export function learningFeaturesForSegment(
  segment: BaseSegment,
  state: ContextualTimingState,
  weather: WeatherSnapshot | null,
): EtaLearningFeatures | null {
  // The learned ETA models have no e-bike mode; the provider estimate stands.
  if (segment.mode === 'ebike') return null;
  const original =
    segment.etaPrediction?.sourceDurationSeconds ??
    segment.publicEtaPrediction?.sourceDurationSeconds ??
    segment.railEtaPrediction?.sourceDurationSeconds ??
    segment.durationSeconds;
  const allowance =
    (segment.planningBuffer?.weatherSeconds ?? 0) +
    (segment.planningBuffer?.calibrationSeconds ?? 0) +
    (segment.networkSnap?.allowanceSeconds ?? 0);
  const predictedSeconds =
    segment.etaPrediction?.features.predictedSeconds ??
    (original.min + Math.max(original.min, original.max - allowance)) / 2;
  if (!(predictedSeconds > 0) || !Number.isFinite(predictedSeconds)) return null;
  const weatherAtStage =
    weather && state.startedAt - state.requestNow <= SEARCH_CONTEXT_HORIZON_MS ? weather : null;
  return {
    mode: segment.mode,
    predictedSeconds,
    distanceMeters: segment.distanceMeters,
    startedAt: Math.round(state.startedAt),
    precipitationMm: weatherAtStage?.precipitationMm ?? null,
    temperatureC: weatherAtStage?.temperatureC ?? null,
    windMetersPerSecond: weatherAtStage?.windMetersPerSecond ?? null,
    congestionLevel: congestion(segment),
    roadDelaySeconds: segment.roadDelaySeconds ?? 0,
    precedingWaitSeconds: state.precedingWaitSeconds,
    transferIndex: Math.max(0, state.vehicleCount - 1),
    liveWait: segment.mode === 'wait' && !!segment.realtime,
  };
}

/** Fastest plausible speed along the routed path, in m/s. Deliberately generous: express rail, urban expressways, a sprint. */
const MAX_PHYSICAL_SPEED: Partial<Record<SegmentMode, number>> = {
  walk: 3,
  entry: 3,
  run: 6.5,
  bicycle: 11,
  scooter: 8,
  // 25 km/h assist limit is 6.9 m/s; a downhill coast may beat it a little.
  ebike: 7,
  bus: 30,
  subway: 50,
  taxi: 36,
  car: 36,
};
/** No learned duration may beat this, so the graph search can use it as an admissible time heuristic. Never above the provider minimum. */
export function physicalFloorSeconds(segment: BaseSegment): number {
  const speed = MAX_PHYSICAL_SPEED[segment.mode];
  const source =
    segment.etaPrediction?.sourceDurationSeconds ??
    segment.publicEtaPrediction?.sourceDurationSeconds ??
    segment.railEtaPrediction?.sourceDurationSeconds ??
    segment.durationSeconds;
  if (!speed || !(segment.distanceMeters > 0) || !(source.min >= 0)) return 0;
  return Math.floor(Math.min(segment.distanceMeters / speed, source.min));
}

/** Reuse the provider baseline, never a previous learned duration, in a changed context. */
export function applyContextualEtaSegment(
  segment: BaseSegment,
  feature: EtaLearningFeatures | null,
  evaluatedAt: number,
  predict: ContextualPredictor,
): BaseSegment {
  if (
    (segment.mode === 'wait' &&
      (segment.realtime || segment.plannedConnection || segment.scheduledConnection)) ||
    segment.timingRule === 'taxi-dispatch'
  )
    return segment;
  const raw = feature ? predict(feature) : null;
  const snap = segment.networkSnap?.allowanceSeconds ?? 0;
  if (
    feature &&
    raw &&
    [raw.lowerSeconds, raw.medianSeconds, raw.upperSeconds].every(
      (value) => Number.isFinite(value) && value > 0 && value <= 86_400,
    ) &&
    raw.lowerSeconds <= raw.medianSeconds &&
    raw.medianSeconds <= raw.upperSeconds
  ) {
    const floor = physicalFloorSeconds(segment);
    const estimate = {
      ...raw,
      lowerSeconds: Math.max(raw.lowerSeconds, floor),
      medianSeconds: Math.max(raw.medianSeconds, floor),
      upperSeconds: Math.max(raw.upperSeconds, floor),
    };
    const min = Math.max(1, Math.floor(estimate.lowerSeconds)),
      max = Math.max(min, Math.ceil(estimate.upperSeconds)) + snap;
    const {
      publicEtaPrediction: _publicEstimate,
      railEtaPrediction: _railEstimate,
      ...source
    } = segment;
    const sourcePlanningBuffer =
      segment.etaPrediction?.sourcePlanningBuffer ??
      (!segment.etaPrediction ? segment.planningBuffer : undefined);
    if (max <= 86_400)
      return {
        ...source,
        durationSeconds: { min, max },
        planningBuffer: { weatherSeconds: 0, calibrationSeconds: 0 },
        etaPrediction: {
          ...estimate,
          evaluatedAt,
          sourceDurationSeconds: segment.etaPrediction?.sourceDurationSeconds ??
            segment.publicEtaPrediction?.sourceDurationSeconds ??
            segment.railEtaPrediction?.sourceDurationSeconds ?? { ...segment.durationSeconds },
          ...(sourcePlanningBuffer ? { sourcePlanningBuffer: { ...sourcePlanningBuffer } } : {}),
          features: feature,
        },
      };
  }
  if (!segment.etaPrediction) return segment;
  const { etaPrediction, ...baseline } = segment;
  return {
    ...baseline,
    durationSeconds: { ...etaPrediction.sourceDurationSeconds },
    planningBuffer: {
      ...(etaPrediction.sourcePlanningBuffer ?? { weatherSeconds: 0, calibrationSeconds: 0 }),
    },
  };
}

export function learningFeaturesForRoute(
  route: Pick<BaseRoute, 'segments'>,
  now: number,
  weather: WeatherSnapshot | null,
  reanchor = true,
): (EtaLearningFeatures | null)[] {
  let cursor = now,
    precedingWaitSeconds = 0,
    transferIndex = 0;
  const localWeather =
    route.segments[0] && localWeatherIsFresh(weather, { origin: route.segments[0].start, now })
      ? weather
      : null;
  return route.segments.map((segment) => {
    const supplied = segment.etaPrediction?.features;
    const features =
      supplied && !reanchor
        ? supplied
        : learningFeaturesForSegment(
            segment,
            {
              startedAt: cursor,
              precedingWaitSeconds,
              vehicleCount: transferIndex,
              requestNow: now,
            },
            localWeather,
          );
    const clock = (segment as BaseSegment & { timeRange?: { latest: number } }).timeRange?.latest;
    const end =
      typeof clock === 'number' && Number.isFinite(clock) && clock >= cursor
        ? clock
        : cursor + segment.durationSeconds.max * 1000;
    if (segment.mode === 'wait') precedingWaitSeconds += (end - cursor) / 1000;
    else if (
      ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter', 'ebike'].includes(segment.mode)
    ) {
      transferIndex++;
      precedingWaitSeconds = 0;
    }
    cursor = end;
    return features;
  });
}

/** Fit corrections before catching vehicles. Real arrival anchors retain their own absolute clock. */
export function applyContextualEtaTiming(
  routes: readonly BaseRoute[],
  request: BasePlanningRequest,
  weather: WeatherSnapshot | null,
  predict: ContextualPredictor,
): BaseRoute[] {
  const localWeather = localWeatherIsFresh(weather, request) ? weather : null;
  return routes.map((route) => {
    let cursor = request.now,
      precedingWaitSeconds = 0,
      vehicleCount = 0;
    let changed = false;
    const segments = route.segments.map((segment): BaseSegment => {
      const feature = learningFeaturesForSegment(
        segment,
        { startedAt: cursor, precedingWaitSeconds, vehicleCount, requestNow: request.now },
        localWeather,
      );
      const corrected = applyContextualEtaSegment(segment, feature, request.now, predict);
      changed ||= corrected !== segment;
      const connection = corrected.mode === 'wait' ? corrected.plannedConnection : undefined;
      const absolute = connection
        ? connection.status === 'borderline'
          ? (connection.fallbackDepartureAt ?? connection.departureAt)
          : connection.departureAt
        : undefined;
      const end =
        absolute !== undefined && absolute >= cursor
          ? absolute
          : cursor + corrected.durationSeconds.max * 1000;
      if (corrected.mode === 'wait') precedingWaitSeconds += (end - cursor) / 1000;
      else if (
        ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter', 'ebike'].includes(corrected.mode)
      ) {
        vehicleCount++;
        precedingWaitSeconds = 0;
      }
      cursor = end;
      return corrected;
    });
    if (!changed) return route;
    return {
      ...route,
      segments,
      durationSeconds: segments.reduce(
        (sum, segment) => ({
          min: sum.min + segment.durationSeconds.min,
          max: sum.max + segment.durationSeconds.max,
        }),
        { min: 0, max: 0 },
      ),
    };
  });
}
