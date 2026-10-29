import type { BoardingRealtime } from '../domain/types.js';

export const ROAD_OBSERVATION_MAX_AGE_MS = 10 * 60_000;

const timestampFresh = (
  value: number | null | undefined,
  now: number,
  maxAge: number,
  futureTolerance: number,
): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Number.isFinite(now) &&
  value <= now + futureTolerance &&
  now - value <= maxAge;

/** Receipt time cannot make an old source observation current. */
export function boardingObservationIsFresh(
  value: BoardingRealtime | null | undefined,
  now: number,
): value is BoardingRealtime {
  return (
    !!value &&
    timestampFresh(value.observedAt, now, 120_000, 30_000) &&
    timestampFresh(value.receivedAt, now, 120_000, 30_000)
  );
}

/** Seoul republishes road observations every five minutes; allow two source cycles. */
export function roadObservationIsFresh(
  observedAt: number | null | undefined,
  now: number,
): observedAt is number {
  return timestampFresh(observedAt, now, ROAD_OBSERVATION_MAX_AGE_MS, 60_000);
}
