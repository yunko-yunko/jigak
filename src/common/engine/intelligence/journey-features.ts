import { createHash } from 'node:crypto';
import type { Route } from '../../shared/domain/types.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import {
  JOURNEY_MODES,
  journeyFeaturesSchema,
  type JourneyLearningFeatures,
} from '../../shared/intelligence/journeyLearning.js';
import { localWeatherIsFresh } from './planningTiming.js';

export function journeyBaselineProfile(policyState: unknown): string {
  return `journey-baseline-v1:${createHash('sha256').update(JSON.stringify(policyState)).digest('hex')}`;
}

/** The journey model has no e-bike feature: its seconds count as cycling so no trained feature list changes. */
const journeyMode = (mode: Route['segments'][number]['mode']) =>
  mode === 'ebike' ? 'bicycle' : mode;

/** Approximate 500m OD cells and ordered movement types, not surveyed path geometry or jittering GPS points. */
export function journeyPathIdentity(route: Route): string {
  const cell = (point: Route['origin']) => [
    Math.floor((point.latitude * 111_320) / 500),
    Math.floor((point.longitude * 111_320 * Math.cos((37.56 * Math.PI) / 180)) / 500),
  ];

  const movement = route.segments
    .map((segment) => segment.mode)
    .filter((mode) =>
      ['walk', 'run', 'bus', 'subway', 'bicycle', 'taxi', 'car', 'scooter', 'ebike'].includes(mode),
    );

  return JSON.stringify([
    cell(route.origin),
    cell(route.destination),
    movement.filter((mode, index) => index === 0 || movement[index - 1] !== mode),
  ]);
}

/** One pre-journey correlated timeline. No observed endpoint/time, identity or future weather is an input. */
export function journeyFeaturesForRoute(
  route: Route,
  now: number,
  weather: WeatherSnapshot | null,
  legModelProfile: string,
  planningEvidence?: JourneyLearningFeatures['planningEvidence'],
): JourneyLearningFeatures | null {
  if (route.provenance.mode !== 'live' || !route.segments.length || !Number.isSafeInteger(now)) {
    return null;
  }

  const modeSeconds = Object.fromEntries(
    JOURNEY_MODES.map((mode) => [mode, 0]),
  ) as JourneyLearningFeatures['modeSeconds'];
  let cursor = now;

  for (const segment of route.segments) {
    const end = (segment.timeRange.earliest + segment.timeRange.latest) / 2;

    if (!Number.isFinite(end) || end < cursor) {
      return null;
    }

    modeSeconds[journeyMode(segment.mode)] += (end - cursor) / 1000;
    cursor = end;
  }

  const local = localWeatherIsFresh(weather, {
    origin: route.origin,
    now,
  })
    ? weather
    : null;

  const value = {
    version: 1,
    startedAt: now,
    predictedSeconds: (route.durationSeconds.min + route.durationSeconds.max) / 2,
    distanceMeters: route.segments.reduce((n, s) => n + s.distanceMeters, 0),
    modeSeconds,
    modeSequence: route.segments.map((s) => journeyMode(s.mode)),
    transfers: route.transfers,
    vehicleLegs: route.segments.filter((s) =>
      ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter', 'ebike'].includes(s.mode),
    ).length,
    precipitationMm: local?.precipitationMm ?? null,
    temperatureC: local?.temperatureC ?? null,
    windMetersPerSecond: local?.windMetersPerSecond ?? null,
    roadDelaySeconds: route.segments.reduce((n, s) => n + (s.roadDelaySeconds ?? 0), 0),
    legModelProfile,
    ...(planningEvidence
      ? {
          planningEvidence,
        }
      : {}),
  };

  const parsed = journeyFeaturesSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
