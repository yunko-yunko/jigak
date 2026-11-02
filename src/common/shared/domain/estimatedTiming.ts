import { scheduledArrivalAt, scheduledDepartures } from './subwayTimetable.js';
import type { BaseSegment, BoardingRealtime, DurationRange, TimeRange } from './types.js';
import { boardingBufferMs, listedDepartures, nextUnlistedDeparture } from './liveBoarding.js';
import {
  expectedWaitSeconds,
  headwayEndedTail,
  taxiPickupSeconds,
  waitChangeTimes,
} from './waitEstimates.js';

export type RoutingObjective = 'estimated-arrival' | 'conservative-arrival';
export type EstimateBasis =
  | 'provider-point'
  | 'range-midpoint'
  | 'learned-median'
  | 'live-departure'
  | 'published-departure'
  | 'wait-rule';
export interface EstimatedComponent {
  segmentId: string;
  startedAt: number;
  arrivalAt: number;
  seconds: number;
  basis: EstimateBasis;
}
const isVehicle = (segment: BaseSegment | undefined) =>
  segment?.mode === 'bus' || segment?.mode === 'subway';

/** Policy transitions, including those strictly inside an uncertain arrival interval. `changes` lists the clocks in
 * [earliest, latest] where the policy can change; between two of them it is constant or never rises. */
function ruleRange(
  at: TimeRange,
  changes: (from: number, to: number) => number[],
  rule: (time: number) => number,
): DurationRange | null {
  if (
    ![at.earliest, at.latest].every(Number.isFinite) ||
    at.latest < at.earliest ||
    at.latest - at.earliest > 7 * 86_400_000
  )
    return null;
  const values = [at.earliest, at.latest, ...changes(at.earliest, at.latest)].map(rule);
  return { min: Math.min(...values), max: Math.max(...values) };
}
/** Daily KST clock changes of a time-of-day policy inside [from, to]. */
const dailyChanges = (minutes: readonly number[]) => (from: number, to: number) => {
  const times: number[] = [],
    day = 86_400_000,
    offset = 9 * 3_600_000;
  for (let start = Math.floor((from + offset) / day) * day - offset; start <= to; start += day) {
    for (const minute of minutes) {
      const change = start + minute * 60_000;
      if (change >= from && change <= to) times.push(change);
    }
  }
  return times;
};

/** An unobserved boarding wait (no list, no bound or published vehicle) whose vehicle's dated headway evidence says
 * none of its lines runs again at some clock in `at`: the first such clock, else null. There is no vehicle to wait
 * for from that clock on, so the wait has no duration there and the route no arrival. */
export function waitServiceEndsAt(
  segment: BaseSegment,
  at: TimeRange,
  nextVehicle?: BaseSegment,
): number | null {
  const connection =
    segment.plannedConnection ??
    ('connection' in segment ? (segment as import('./types.js').Segment).connection : undefined);
  if (
    segment.mode !== 'wait' ||
    segment.realtime ||
    connection ||
    segment.scheduledConnection ||
    !segment.id.endsWith('-expected-wait') ||
    !nextVehicle ||
    !isVehicle(nextVehicle) ||
    ![at.earliest, at.latest].every(Number.isFinite) ||
    at.latest < at.earliest
  )
    return null;
  const tail = headwayEndedTail(nextVehicle);
  return tail && at.earliest < tail.to && at.latest >= tail.from
    ? Math.max(at.earliest, tail.from)
    : null;
}

/** Refresh an unobserved waiting policy at the current arrival clock; preserve non-wait allowances. Null as well when
 * the boarding's service has ended somewhere in `at` (see `waitServiceEndsAt`): no policy value describes that. */
export function dynamicWaitDurationRange(
  segment: BaseSegment,
  at: TimeRange,
  nextVehicle?: BaseSegment,
): DurationRange | null {
  const connection =
    segment.plannedConnection ??
    ('connection' in segment ? (segment as import('./types.js').Segment).connection : undefined);
  if (
    segment.mode !== 'wait' ||
    segment.etaPrediction ||
    segment.realtime ||
    connection ||
    segment.scheduledConnection
  )
    return null;
  if (segment.timingRule === 'taxi-dispatch') {
    const range = ruleRange(at, dailyChanges([90, 450, 570, 1050, 1170, 1350]), taxiPickupSeconds);
    return range
      ? {
          min: range.min,
          max:
            range.max +
            (segment.planningBuffer?.weatherSeconds ?? 0) +
            (segment.planningBuffer?.calibrationSeconds ?? 0),
        }
      : null;
  }
  if (
    !nextVehicle ||
    !isVehicle(nextVehicle) ||
    !segment.id.endsWith('-expected-wait') ||
    waitServiceEndsAt(segment, at, nextVehicle) !== null
  )
    return null;
  const basis =
    segment.expectedWaitBasisRangeSeconds ??
    (segment.expectedWaitBasisSeconds === undefined
      ? null
      : { min: segment.expectedWaitBasisSeconds, max: segment.expectedWaitBasisSeconds });
  if (
    !basis ||
    ![basis.min, basis.max].every(Number.isFinite) ||
    basis.min < 0 ||
    basis.max < basis.min ||
    segment.durationSeconds.min < basis.min ||
    segment.durationSeconds.max < basis.max
  )
    return null;
  const range = ruleRange(
    at,
    (from, to) => waitChangeTimes(nextVehicle, from, to),
    (time) => expectedWaitSeconds(nextVehicle, time),
  );
  return range
    ? {
        min: segment.durationSeconds.min - basis.min + range.min,
        max: segment.durationSeconds.max - basis.max + range.max,
      }
    : null;
}

/** A point estimate is not automatically a statistical expectation. Keep its source explicit. */
export function estimatedSegmentSeconds(
  segment: BaseSegment,
  at: number,
  nextVehicle?: BaseSegment,
): number | null {
  if (!Number.isFinite(at)) return null;
  if (segment.mode === 'subway' && segment.scheduledConnection) {
    // Freshness was checked at the query clock by the preceding schedule wait. Future departure is not a new receipt clock.
    if (
      !segment.timetable ||
      at < segment.timetable.validFrom ||
      at >= segment.timetable.validUntil
    )
      return null;
    const arrival = scheduledArrivalAt(segment.timetable, at);
    return arrival === null ? null : (arrival - at) / 1000;
  }
  // A boarding whose lines no longer run has no vehicle to reach: no estimate, so no arrival on this route.
  if (waitServiceEndsAt(segment, { earliest: at, latest: at }, nextVehicle) !== null) return null;
  const dynamic = dynamicWaitDurationRange(segment, { earliest: at, latest: at }, nextVehicle);
  if (dynamic)
    return (
      (dynamic.min +
        Math.max(
          dynamic.min,
          dynamic.max -
            (segment.planningBuffer?.weatherSeconds ?? 0) -
            (segment.planningBuffer?.calibrationSeconds ?? 0),
        )) /
      2
    );
  // A subway gate-to-gate envelope, like the bus tag model, only widens the slower bound.
  const source =
    segment.publicEtaPrediction?.sourceDurationSeconds ??
    segment.railEtaPrediction?.sourceDurationSeconds ??
    segment.durationSeconds;
  const snap = segment.networkSnap?.allowanceSeconds ?? 0;
  const buffer =
    (segment.planningBuffer?.weatherSeconds ?? 0) +
    (segment.planningBuffer?.calibrationSeconds ?? 0);
  // The snap gap is where the rider stands relative to the mapped path: anywhere from on it to the full
  // straight distance off it. The envelope keeps the full gap; the estimate walks half of it at the path's pace.
  const snapMeters =
    (segment.networkSnap?.startMeters ?? 0) + (segment.networkSnap?.endMeters ?? 0);
  const pace =
    segment.distanceMeters > 0 && source.min > 0 ? source.min / segment.distanceMeters : 1;
  const expectedSnap = Math.min(snap, (snapMeters / 2) * pace);
  // A public bus tag model currently expands uncertainty only. Its median must not replace a routed driving ETA.
  const value = segment.etaPrediction
    ? segment.etaPrediction.medianSeconds + expectedSnap
    : (source.min + Math.max(source.min, source.max - buffer - snap)) / 2 + expectedSnap;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Seconds from `at` until the vehicle the point estimate boards. A listed vehicle that is still catchable binds
 * whatever the list's age; once the list is exhausted the shared continuation supplies the next vehicle. Only a
 * last service or a published service end stops it. */
export function liveBoardingEstimate(
  vehicle: BaseSegment,
  live: BoardingRealtime | undefined,
  at: number,
  now: number,
): { seconds: number; basis: EstimateBasis } | null {
  if (!isVehicle(vehicle) || !Number.isFinite(at)) return null;
  const listed = listedDepartures(live).find(
    (departure) => departure >= at + boardingBufferMs(vehicle),
  );
  if (listed !== undefined) return { seconds: (listed - at) / 1000, basis: 'live-departure' };
  const next = nextUnlistedDeparture(vehicle, live, at, now);
  return next ? { seconds: (next.departureAt - at) / 1000, basis: next.basis } : null;
}

/** Follow a single estimated clock through actual catchable departures; never average two different trains. */
export function estimateBaseTimeline(
  segments: readonly BaseSegment[],
  now: number,
  initialAt = now,
): { arrivalAt: number; components: EstimatedComponent[] } | null {
  if (![now, initialAt].every(Number.isFinite) || initialAt < now) return null;
  let clock = initialAt;
  const components: EstimatedComponent[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index],
      nextVehicle = segments[index + 1];
    const connection =
      segment.plannedConnection ??
      ('connection' in segment ? (segment as import('./types.js').Segment).connection : undefined);
    const startedAt = clock;
    let seconds: number | null;
    let basis: EstimateBasis;
    if (segment.mode === 'wait' && segment.scheduledConnection) {
      const selected =
        nextVehicle && scheduledDepartures(nextVehicle, { earliest: clock, latest: clock }, now);
      if (!selected || !nextVehicle?.scheduledConnection) return null;
      seconds = (selected.departure.earliest - clock) / 1000;
      basis = 'published-departure';
    } else if (segment.mode === 'wait' && connection) {
      if (!isVehicle(nextVehicle)) return null;
      const boarding = liveBoardingEstimate(
        nextVehicle,
        segment.realtime ?? nextVehicle.realtime,
        clock,
        now,
      );
      if (!boarding) return null;
      ({ seconds, basis } = boarding);
    } else {
      seconds = estimatedSegmentSeconds(segment, clock, nextVehicle);
      basis = segment.etaPrediction
        ? 'learned-median'
        : segment.timingRule || (segment.mode === 'wait' && segment.id.endsWith('-expected-wait'))
          ? 'wait-rule'
          : segment.durationSeconds.min === segment.durationSeconds.max
            ? 'provider-point'
            : 'range-midpoint';
    }
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
    clock += seconds * 1000;
    components.push({ segmentId: segment.id, startedAt, arrivalAt: clock, seconds, basis });
  }
  return { arrivalAt: clock, components };
}
