import type { MobilityPreferences } from './types.js';

/** Walking-only is a temporary comparison scope, not a change to the rider's per-mode choices. */
export function withWalkingOnly(
  preferences: MobilityPreferences,
  enabled: boolean,
): MobilityPreferences {
  return {
    ...preferences,
    walkingOnly: enabled,
  };
}

/** An explicit compare action can enable cycling; readiness still requires the rider's confirmation. */
export function bicycleComparisonPreferences(
  preferences: MobilityPreferences,
  readyConfirmed = false,
): MobilityPreferences | null {
  if (!preferences.bicycleReady && !readyConfirmed) {
    return null;
  }

  return {
    ...preferences,
    allowBicycle: true,
    bicycleReady: true,
    walkingOnly: false,
    maxBicycleMeters: preferences.maxBicycleMeters > 0 ? preferences.maxBicycleMeters : 5000,
  };
}
