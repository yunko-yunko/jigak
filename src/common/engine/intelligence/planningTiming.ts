import type { BasePlanningRequest, BaseRoute, BaseSegment } from '../../shared/domain/types.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import { metersBetween } from '../realtime/names.js';
import { WEATHER_RECEIPT_MAX_AGE_MS } from '../realtime/weather.js';
import { usableCalibration, type EtaCalibration } from './calibration.js';

export interface PlanningTimingContext {
  weather?: WeatherSnapshot | null;
  calibration?: EtaCalibration;
}

/** A receipt never makes a stale or distant weather observation local and current.
 * A receipt the weather feed still serves from its cache is the latest one; it stays usable for the cache lifetime plus the search that read it. */
export function localWeatherIsFresh(
  weather: WeatherSnapshot | null | undefined,
  request: Pick<BasePlanningRequest, 'origin' | 'now'>,
): weather is WeatherSnapshot {
  return (
    !!weather &&
    weather.status === 'live' &&
    Number.isFinite(request.now) &&
    Number.isFinite(weather.latitude) &&
    Number.isFinite(weather.longitude) &&
    typeof weather.observedAt === 'number' &&
    Number.isFinite(weather.observedAt) &&
    weather.observedAt <= request.now + 60_000 &&
    request.now - weather.observedAt <= 100 * 60_000 &&
    Number.isFinite(weather.receivedAt) &&
    weather.receivedAt <= request.now + 60_000 &&
    request.now - weather.receivedAt <= WEATHER_RECEIPT_MAX_AGE_MS &&
    metersBetween(request.origin, weather) < 12_000
  );
}

/** Included planning seconds only widen the source's slower bound. */
export function validPlanningBuffer(
  segment: Pick<BaseSegment, 'durationSeconds' | 'planningBuffer'>,
): boolean {
  const buffer = segment.planningBuffer;

  if (buffer === undefined) {
    return true;
  }

  if (
    !buffer ||
    typeof buffer !== 'object' ||
    Object.keys(buffer).some((key) => key !== 'weatherSeconds' && key !== 'calibrationSeconds')
  ) {
    return false;
  }

  return (
    [buffer.weatherSeconds, buffer.calibrationSeconds].every(
      (seconds) => Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400,
    ) &&
    buffer.weatherSeconds + buffer.calibrationSeconds <=
      segment.durationSeconds.max - segment.durationSeconds.min
  );
}

const outdoor = (segment: BaseSegment) =>
  ['walk', 'run', 'bicycle', 'scooter', 'ebike'].includes(segment.mode) &&
  segment.distanceMeters > 0;

const validRange = ({ min, max }: BaseSegment['durationSeconds']) =>
  Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min;

/**
 * Add explicit planning uncertainty before any connection is selected. These are policy
 * allowances, not measured signal/dwell delays or a trained probability distribution.
 * Valid previous metadata is removed before recomputation so repeated passes cannot compound it.
 */
export function applyPlanningTimingAdjustments(
  routes: readonly BaseRoute[],
  request: BasePlanningRequest,
  context: PlanningTimingContext = {},
): BaseRoute[] {
  const weather = localWeatherIsFresh(context.weather, request) ? context.weather : null;
  const rain =
    !!weather &&
    ((Number.isFinite(weather.precipitationMm) && weather.precipitationMm! > 0) ||
      (Number.isFinite(weather.precipitationType) && weather.precipitationType! > 0));
  const calibration = usableCalibration(context.calibration, request.now)
    ? context.calibration
    : null;

  return routes.flatMap((route) => {
    if (
      !route.segments.length ||
      !validRange(route.durationSeconds) ||
      route.segments.some(
        (segment) => !validRange(segment.durationSeconds) || !validPlanningBuffer(segment),
      )
    ) {
      return [];
    }

    let delta = 0;

    const segments = route.segments.map((segment) => {
      const previous = segment.planningBuffer;
      const previousSeconds = (previous?.weatherSeconds ?? 0) + (previous?.calibrationSeconds ?? 0);
      const sourceMax = segment.durationSeconds.max - previousSeconds;
      const weatherSeconds = rain && outdoor(segment) ? Math.ceil(sourceMax * 0.15) : 0;
      const calibrationSeconds = calibration?.modes[segment.mode]?.upperResidualSeconds ?? 0;

      delta += weatherSeconds + calibrationSeconds - previousSeconds;

      return {
        ...segment,
        durationSeconds: {
          min: segment.durationSeconds.min,
          max: sourceMax + weatherSeconds + calibrationSeconds,
        },
        planningBuffer: {
          weatherSeconds,
          calibrationSeconds,
        },
      };
    });

    const max = route.durationSeconds.max + delta;

    if (
      !Number.isFinite(max) ||
      max < route.durationSeconds.min ||
      segments.some((segment) => !validPlanningBuffer(segment))
    ) {
      return [];
    }

    return [
      {
        ...route,
        segments,
        durationSeconds: {
          min: route.durationSeconds.min,
          max,
        },
      },
    ];
  });
}
