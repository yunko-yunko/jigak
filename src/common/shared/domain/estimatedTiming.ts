import { scheduledArrivalAt, scheduledDepartures } from './subwayTimetable.js';
import type { BaseSegment, DurationRange, TimeRange } from './types.js';
import { boardingObservationIsFresh } from '../journey/realtimeFreshness.js';
import {
  expectedWaitSeconds,
  REALTIME_BOARDING_BUFFER_SECONDS,
  taxiPickupSeconds,
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

/** Policy transitions, including those strictly inside an uncertain arrival interval. */
function dailyRuleRange(
  at: TimeRange,
  changes: readonly number[],
  rule: (time: number) => number,
): DurationRange | null {
  if (
    ![at.earliest, at.latest].every(Number.isFinite) ||
    at.latest < at.earliest ||
    at.latest - at.earliest > 7 * 86_400_000
  ) {
    return null;
  }

  const times = [at.earliest, at.latest],
    day = 86_400_000,
    offset = 9 * 3_600_000;

  for (
    let start = Math.floor((at.earliest + offset) / day) * day - offset;
    start <= at.latest;
    start += day
  ) {
    for (const minute of changes) {
      const change = start + minute * 60_000;

      if (change >= at.earliest && change <= at.latest) {
        times.push(change);
      }
    }
  }

  const values = times.map(rule);

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Refresh an unobserved waiting policy at the current arrival clock; preserve non-wait allowances. */
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
  ) {
    return null;
  }

  if (segment.timingRule === 'taxi-dispatch') {
    const range = dailyRuleRange(at, [90, 450, 570, 1050, 1170, 1350], taxiPickupSeconds);

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

  if (!nextVehicle || !isVehicle(nextVehicle) || !segment.id.endsWith('-expected-wait')) {
    return null;
  }

  const basis =
    segment.expectedWaitBasisRangeSeconds ??
    (segment.expectedWaitBasisSeconds === undefined
      ? null
      : {
          min: segment.expectedWaitBasisSeconds,
          max: segment.expectedWaitBasisSeconds,
        });

  if (
    !basis ||
    ![basis.min, basis.max].every(Number.isFinite) ||
    basis.min < 0 ||
    basis.max < basis.min ||
    segment.durationSeconds.min < basis.min ||
    segment.durationSeconds.max < basis.max
  ) {
    return null;
  }

  const range = dailyRuleRange(at, [360, 420, 570, 1050, 1200, 1320], (time) =>
    expectedWaitSeconds(nextVehicle, time),
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
  if (!Number.isFinite(at)) {
    return null;
  }

  if (segment.mode === 'subway' && segment.scheduledConnection) {
    // Freshness was checked at the query clock by the preceding schedule wait. Future departure is not a new receipt clock.
    if (
      !segment.timetable ||
      at < segment.timetable.validFrom ||
      at >= segment.timetable.validUntil
    ) {
      return null;
    }

    const arrival = scheduledArrivalAt(segment.timetable, at);

    return arrival === null ? null : (arrival - at) / 1000;
  }

  const dynamic = dynamicWaitDurationRange(
    segment,
    {
      earliest: at,
      latest: at,
    },
    nextVehicle,
  );

  if (dynamic) {
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
  }

  const source = segment.publicEtaPrediction?.sourceDurationSeconds ?? segment.durationSeconds;
  const snap = segment.networkSnap?.allowanceSeconds ?? 0;
  const buffer =
    (segment.planningBuffer?.weatherSeconds ?? 0) +
    (segment.planningBuffer?.calibrationSeconds ?? 0);
  // A public bus tag model currently expands uncertainty only. Its median must not replace a routed driving ETA.
  const value = segment.etaPrediction
    ? segment.etaPrediction.medianSeconds + snap
    : (source.min + Math.max(source.min, source.max - buffer - snap)) / 2 + snap;

  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Follow a single estimated clock through actual catchable departures; never average two different trains. */
export function estimateBaseTimeline(
  segments: readonly BaseSegment[],
  now: number,
  initialAt = now,
): {
  arrivalAt: number;
  components: EstimatedComponent[];
} | null {
  if (![now, initialAt].every(Number.isFinite) || initialAt < now) {
    return null;
  }

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
        nextVehicle &&
        scheduledDepartures(
          nextVehicle,
          {
            earliest: clock,
            latest: clock,
          },
          now,
        );

      if (!selected || !nextVehicle?.scheduledConnection) {
        return null;
      }

      seconds = (selected.departure.earliest - clock) / 1000;
      basis = 'published-departure';
    } else if (segment.mode === 'wait' && connection) {
      const live = segment.realtime ?? nextVehicle?.realtime;

      if (
        !isVehicle(nextVehicle) ||
        !boardingObservationIsFresh(live, now) ||
        live.status !== 'live'
      ) {
        return null;
      }

      const earliest =
        clock + REALTIME_BOARDING_BUFFER_SECONDS[nextVehicle.mode as 'bus' | 'subway'] * 1000;
      const departure = live.predictions
        .filter((value) => value.arrivesAt >= earliest)
        .sort((a, b) => a.arrivesAt - b.arrivesAt)[0];

      if (!departure) {
        return null;
      }

      seconds = (departure.arrivesAt - clock) / 1000;
      basis = 'live-departure';
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

    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
      return null;
    }

    clock += seconds * 1000;

    components.push({
      segmentId: segment.id,
      startedAt,
      arrivalAt: clock,
      seconds,
      basis,
    });
  }

  return {
    arrivalAt: clock,
    components,
  };
}
