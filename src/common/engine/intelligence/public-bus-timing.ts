import type { BasePlanningRequest, BaseRoute, BaseSegment } from '../../shared/domain/types.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';

export interface PublicBusEstimate {
  modelVersion: 'public-bus-duration-v2';
  target: 'bus-tag-elapsed';
  lowerSeconds: number;
  medianSeconds: number;
  upperSeconds: number;
}

export type PublicBusPredictor = (
  segment: BaseSegment,
  startedAt: number,
  requestNow: number,
) => PublicBusEstimate | null;

export interface PublicBusRuntime {
  predictSegment(
    segment: BaseSegment,
    startedAt: number,
    requestNow: number,
    weather: WeatherSnapshot | null,
  ): PublicBusEstimate | null;
  status(): unknown;
}

/** Public tag-to-tag labels calibrate bus risk only; never turn them into paired rider labels. */
export function restorePublicBusSource(segment: BaseSegment): BaseSegment {
  if (!segment.publicEtaPrediction) {
    return segment;
  }

  const { publicEtaPrediction, ...source } = segment;

  return {
    ...source,
    durationSeconds: {
      ...publicEtaPrediction.sourceDurationSeconds,
    },
  };
}

/** Preserve provider/live-road time. Initial deployment may widen its upper bound, never promise a speed-up. */
export function applyPublicBusSegment(
  input: BaseSegment,
  startedAt: number,
  requestNow: number,
  predict: PublicBusPredictor,
): BaseSegment {
  const segment = restorePublicBusSource(input);

  if (
    segment.mode !== 'bus' ||
    segment.etaPrediction ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(requestNow) ||
    startedAt < requestNow ||
    startedAt - requestNow > 3 * 3_600_000 ||
    (segment.durationSeconds.min + segment.durationSeconds.max) / 2 < 180
  ) {
    return segment;
  }

  startedAt = Math.ceil(startedAt);

  const estimate = predict(segment, startedAt, requestNow);

  if (
    !estimate ||
    estimate.modelVersion !== 'public-bus-duration-v2' ||
    estimate.target !== 'bus-tag-elapsed' ||
    ![estimate.lowerSeconds, estimate.medianSeconds, estimate.upperSeconds].every(
      (value) => Number.isFinite(value) && value > 0 && value <= 86_400,
    ) ||
    estimate.lowerSeconds > estimate.medianSeconds ||
    estimate.medianSeconds > estimate.upperSeconds
  ) {
    return segment;
  }

  return {
    ...segment,
    durationSeconds: {
      min: segment.durationSeconds.min,
      max: Math.max(segment.durationSeconds.max, Math.ceil(estimate.upperSeconds)),
    },
    publicEtaPrediction: {
      ...estimate,
      evaluatedAt: requestNow,
      boardingAt: startedAt,
      sourceDurationSeconds: {
        ...segment.durationSeconds,
      },
      policy: 'conservative-envelope',
    },
  };
}

export function applyPublicBusTiming(
  routes: readonly BaseRoute[],
  request: BasePlanningRequest,
  predict: PublicBusPredictor,
): BaseRoute[] {
  return routes.map((route) => {
    let cursor = request.now;

    const segments = route.segments.map((segment) => {
      const corrected = applyPublicBusSegment(segment, cursor, request.now, predict);
      const connection = corrected.mode === 'wait' ? corrected.plannedConnection : undefined;
      const departure = connection
        ? connection.status === 'borderline'
          ? connection.fallbackDepartureAt
          : connection.departureAt
        : undefined;

      cursor =
        departure !== undefined && departure >= cursor
          ? departure
          : cursor + corrected.durationSeconds.max * 1000;

      return corrected;
    });

    return {
      ...route,
      segments,
      durationSeconds: segments.reduce(
        (sum, segment) => ({
          min: sum.min + segment.durationSeconds.min,
          max: sum.max + segment.durationSeconds.max,
        }),
        {
          min: 0,
          max: 0,
        },
      ),
    };
  });
}
