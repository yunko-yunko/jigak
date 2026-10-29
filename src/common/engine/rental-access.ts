import type { BaseSegment } from '../shared/domain/index.js';
import { estimateBaseTimeline } from '../shared/domain/estimatedTiming.js';
import { metersBetween } from './realtime/names.js';

/** Use the same point estimate as recommendation; uncertainty is not travel time. */
export function rentalAccessSeconds(walk: BaseSegment | undefined, now: number): number {
  if (!walk) {
    return 0;
  }

  const timeline = estimateBaseTimeline([walk], now);

  return timeline ? (timeline.arrivalAt - now) / 1000 : Infinity;
}

/**
 * Trigger an additional provider comparison only after observing poor access.
 * The ratio is an exploration signal, never proof that another route is faster.
 */
export function needsRentalAccessComparison(walk: BaseSegment | undefined, now: number): boolean {
  if (!walk) {
    return false;
  }

  const seconds = rentalAccessSeconds(walk, now);

  if (!Number.isFinite(seconds)) {
    return false;
  }

  const straight = metersBetween(walk.start, walk.end);

  return (
    walk.distanceMeters >= 600 ||
    seconds >= 600 ||
    (seconds >= 300 &&
      walk.distanceMeters >= 3 * Math.max(1, straight) &&
      walk.distanceMeters - straight >= 300)
  );
}
