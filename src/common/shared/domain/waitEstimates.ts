import type { BaseSegment } from './types.js';

export const REALTIME_BOARDING_BUFFER_SECONDS = {
  bus: 30,
  subway: 60,
} as const;

const minutesKst = (now: number) => {
  const kst = new Date(now + 9 * 3_600_000);

  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
};

/** Heuristic headway allowance, not an observed departure or a trained mean. */
export function expectedWaitSeconds(segment: BaseSegment, now: number): number {
  const minutes = minutesKst(now);
  const peak = (minutes >= 420 && minutes < 570) || (minutes >= 1050 && minutes < 1200);
  const late = minutes >= 1320 || minutes < 360;

  if (segment.mode === 'subway') {
    return peak ? 120 : late ? 300 : 210;
  }

  return Math.max(
    120,
    Math.round((peak ? 300 : late ? 480 : 360) / Math.max(1, segment.transit?.lines.length ?? 1)),
  );
}

/** Dispatch allowance evaluated at pickup time; no vehicle reservation is implied. */
export function taxiPickupSeconds(now: number): number {
  const minutes = minutesKst(now);

  if ((minutes >= 450 && minutes < 570) || (minutes >= 1050 && minutes < 1170)) {
    return 420;
  }

  if (minutes >= 1350 || minutes < 90) {
    return 540;
  }

  return 300;
}
