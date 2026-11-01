import { createHash } from 'node:crypto';
import type {
  BaseSegment,
  Connection,
  DurationRange,
  Route,
  ScheduledConnection,
  Segment,
  TimeRange,
} from '../../shared/domain/types.js';
import type { JourneyLearningFeatures } from '../../shared/intelligence/journeyLearning.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import {
  REALTIME_BOARDING_BUFFER_SECONDS,
  selectLiveBoarding,
} from '../../shared/domain/routing.js';
import { TIMETABLE_BOARDING_BUFFER_SECONDS } from '../../shared/domain/waitEstimates.js';
import { boardingObservationIsFresh } from '../../shared/journey/realtimeFreshness.js';
import { taxiPickupSeconds } from '../multimodal.js';
import { expectedWaitSeconds } from '../transit-enrichment.js';
import { journeyFeaturesForRoute } from './journey-features.js';
import { restorePublicBusSource } from './public-bus-timing.js';
import { restoreRailGateSource } from './rail-gate-service.js';
import { timetableIsFresh, timetableMatchesSegment } from '../../shared/domain/subwayTimetable.js';

const DAY = 86_400_000,
  KST = 9 * 3_600_000;

const validRange = (value: DurationRange) =>
  !!value &&
  Number.isFinite(value.min) &&
  Number.isFinite(value.max) &&
  value.min >= 0 &&
  value.max >= value.min &&
  value.max <= 86_400;

const transit = (segment: BaseSegment | undefined) =>
  segment?.mode === 'bus' || segment?.mode === 'subway';

const at = (a: BaseSegment['start'], b: BaseSegment['start']) =>
  Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;

const connectionOf = (segment: Segment) => segment.plannedConnection ?? segment.connection;

const matches = (a: Connection, b: Connection) =>
  a.departureAt === b.departureAt &&
  a.fallbackDepartureAt === b.fallbackDepartureAt &&
  a.status === b.status &&
  a.boardingMarginSeconds === b.boardingMarginSeconds;

/** Exact identity of the reference recipe, independent of contextual/public model generations and their expiry. */
export function journeyReferenceProfile(
  calibrationPolicy: unknown = null,
  version: 1 | 2 = 1,
): string {
  if (version === 2) {
    return `journey-source-reference-v2:${createHash('sha256')
      .update(
        JSON.stringify({
          policy: 'provider-source-correlated-selected-published-and-observed-boardings-v2',
          calibration: calibrationPolicy,
        }),
      )
      .digest('hex')}`;
  }

  return `journey-source-reference-v1:${createHash('sha256')
    .update(
      JSON.stringify({
        policy: 'provider-source-correlated-selected-boardings-v1',
        calibration: calibrationPolicy,
      }),
    )
    .digest('hex')}`;
}

const sameScheduled = (a: ScheduledConnection, b: ScheduledConnection) =>
  matches(a, b) &&
  a.trainNo === b.trainNo &&
  a.latestTrainNo === b.latestTrainNo &&
  a.trainArrivalAt === b.trainArrivalAt &&
  a.latestTrainArrivalAt === b.latestTrainArrivalAt;

/** Retain the delivered train choices. Rebuilding a baseline must not select a different plan after the fact. */
function publishedBoarding(
  wait: Segment,
  vehicle: Segment | undefined,
  reach: TimeRange,
  now: number,
) {
  const selected = wait.scheduledConnection,
    table = vehicle?.timetable;

  if (
    !selected ||
    !vehicle?.scheduledConnection ||
    vehicle.mode !== 'subway' ||
    !sameScheduled(selected, vehicle.scheduledConnection) ||
    wait.realtime ||
    vehicle.realtime ||
    wait.plannedConnection ||
    vehicle.plannedConnection ||
    (wait.connection && !matches(wait.connection, selected)) ||
    (vehicle.connection && !matches(vehicle.connection, selected)) ||
    !timetableIsFresh(table, now) ||
    !timetableMatchesSegment(table, vehicle) ||
    JSON.stringify(wait.timetable) !== JSON.stringify(table) ||
    wait.distanceMeters !== 0 ||
    !at(wait.start, wait.end) ||
    !at(wait.end, vehicle.start) ||
    selected.status === 'missed'
  ) {
    return null;
  }

  const latestDepartureAt =
    selected.status === 'borderline' ? selected.fallbackDepartureAt : selected.departureAt;
  const first = table.departures.find(
    (row) =>
      row.departureAt === selected.departureAt &&
      row.arrivalAt === selected.trainArrivalAt &&
      row.trainNo === selected.trainNo,
  );
  const last = table.departures.find(
    (row) =>
      row.departureAt === latestDepartureAt &&
      row.arrivalAt === selected.latestTrainArrivalAt &&
      row.trainNo === selected.latestTrainNo,
  );
  const buffer = TIMETABLE_BOARDING_BUFFER_SECONDS * 1000;

  if (
    !first ||
    !last ||
    first.departureAt > last.departureAt ||
    first.arrivalAt > last.arrivalAt ||
    first.departureAt < reach.earliest + buffer ||
    last.departureAt < reach.latest + buffer ||
    (selected.status === 'comfortable' &&
      (first.trainNo !== last.trainNo || first.arrivalAt !== last.arrivalAt))
  ) {
    return null;
  }

  return {
    departure: {
      earliest: first.departureAt,
      latest: last.departureAt,
    },
    arrival: {
      earliest: first.arrivalAt,
      latest: last.arrivalAt,
    },
    evidence: {
      receivedAt: table.receivedAt,
      departureAt: first.departureAt,
      latestDepartureAt: last.departureAt,
      arrivalAt: first.arrivalAt,
      latestArrivalAt: last.arrivalAt,
    },
  };
}

function restore(segment: Segment, now: number): Segment | null {
  if (segment.etaPrediction && (segment.publicEtaPrediction || segment.railEtaPrediction)) {
    return null;
  }

  const source =
    segment.etaPrediction?.sourceDurationSeconds ??
    segment.publicEtaPrediction?.sourceDurationSeconds ??
    segment.railEtaPrediction?.sourceDurationSeconds ??
    segment.durationSeconds;

  if (
    !validRange(source) ||
    !Number.isFinite(segment.distanceMeters) ||
    segment.distanceMeters < 0
  ) {
    return null;
  }

  if (segment.etaPrediction) {
    if (
      segment.etaPrediction.evaluatedAt !== now ||
      segment.etaPrediction.features.mode !== segment.mode
    ) {
      return null;
    }

    const { etaPrediction: _learned, ...original } = segment;

    // Original bounds already contain road, snap and the source planning allowances. Never add them a second time.
    return {
      ...original,
      durationSeconds: {
        ...source,
      },
      planningBuffer: {
        weatherSeconds: 0,
        calibrationSeconds: 0,
      },
    };
  }

  if (
    segment.publicEtaPrediction &&
    (segment.mode !== 'bus' || segment.publicEtaPrediction.evaluatedAt !== now)
  ) {
    return null;
  }

  if (
    segment.railEtaPrediction &&
    (segment.mode !== 'subway' || segment.railEtaPrediction.evaluatedAt !== now)
  ) {
    return null;
  }

  return {
    ...restoreRailGateSource(restorePublicBusSource(segment)),
    durationSeconds: {
      ...source,
    },
    timeRange: {
      ...segment.timeRange,
    },
    provenance: {
      ...segment.provenance,
    },
  };
}

function dispatchRange(clock: TimeRange): DurationRange {
  const times = [clock.earliest, clock.latest];

  for (
    let day = Math.floor((clock.earliest + KST) / DAY) * DAY - KST;
    day <= clock.latest;
    day += DAY
  ) {
    for (const minute of [90, 450, 570, 1050, 1170, 1350]) {
      const change = day + minute * 60_000;

      if (change >= clock.earliest && change <= clock.latest) {
        times.push(change);
      }
    }
  }

  const values = times.map(taxiPickupSeconds);

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Build only a learning reference. The delivered route, its geometry and its selected vehicle stay untouched.
 * Selected observed and published boardings are fixed plans; an unreachable source reference is refused, never rerouted.
 */
export function journeyReferenceFeaturesForRoute(
  route: Route,
  now: number,
  weather: WeatherSnapshot | null,
  calibrationPolicy: unknown = null,
): JourneyLearningFeatures | null {
  if (
    route.provenance.mode !== 'live' ||
    route.provenance.receivedAt !== now ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !route.segments.length ||
    route.segments.length > 100
  ) {
    return null;
  }

  const hasPublished = route.segments.some((segment) => segment.scheduledConnection);
  const publishedLegs: NonNullable<JourneyLearningFeatures['planningEvidence']>['publishedLegs'] =
    [];
  const restored = route.segments.map((segment) => restore(segment, now));

  if (restored.some((segment) => !segment)) {
    return null;
  }

  const segments = restored as Segment[],
    times: TimeRange[] = [];
  let clock: TimeRange = {
    earliest: now,
    latest: now,
  };

  for (let index = 0; index < segments.length; index++) {
    let segment = segments[index];
    const connection = connectionOf(segment);

    if (segment.scheduledConnection) {
      if (segment.mode === 'wait') {
        const published = publishedBoarding(segment, segments[index + 1], clock, now);

        if (!published) {
          return null;
        }

        const wait = {
          min: Math.max(0, (published.departure.earliest - clock.latest) / 1000),
          max: Math.max(0, (published.departure.latest - clock.earliest) / 1000),
        };

        segment = {
          ...segment,
          durationSeconds: wait,
          planningBuffer: {
            weatherSeconds: 0,
            calibrationSeconds: 0,
          },
        };
        publishedLegs.push({
          segmentIndex: index + 1,
          ...published.evidence,
        });
        clock = published.departure;
      } else {
        const previous = segments[index - 1],
          evidence = publishedLegs.at(-1);

        if (
          segment.mode !== 'subway' ||
          previous?.mode !== 'wait' ||
          !previous.scheduledConnection ||
          !sameScheduled(previous.scheduledConnection, segment.scheduledConnection) ||
          !evidence ||
          evidence.segmentIndex !== index ||
          clock.earliest !== evidence.departureAt ||
          clock.latest !== evidence.latestDepartureAt
        ) {
          return null;
        }

        clock = {
          earliest: evidence.arrivalAt,
          latest: evidence.latestArrivalAt,
        };
      }
    } else if (connection && segment.mode === 'wait') {
      const vehicle = segments[index + 1],
        nextConnection = vehicle && connectionOf(vehicle),
        live = segment.realtime;

      if (
        !vehicle ||
        !transit(vehicle) ||
        !nextConnection ||
        !matches(connection, nextConnection) ||
        connection.status === 'missed' ||
        !boardingObservationIsFresh(live, now) ||
        live.status !== 'live' ||
        JSON.stringify(live) !== JSON.stringify(vehicle.realtime) ||
        segment.distanceMeters !== 0 ||
        !at(segment.start, segment.end) ||
        !at(segment.end, vehicle.start)
      ) {
        return null;
      }

      const earliest = connection.departureAt,
        latest =
          connection.status === 'borderline'
            ? (connection.fallbackDepartureAt ?? earliest)
            : earliest;
      const buffer = REALTIME_BOARDING_BUFFER_SECONDS[vehicle.mode as 'bus' | 'subway'] * 1000;

      if (!Number.isSafeInteger(earliest) || !Number.isSafeInteger(latest) || latest < earliest) {
        return null;
      }
      // The delivered choice stands when the shared selector makes it again for this reference clock (including a
      // slower bound continued past the list), or when both bounds are listed vehicles this clock still catches.
      const selected = selectLiveBoarding(vehicle, clock, now);
      const reselected =
        !!selected &&
        matches(connection, { ...selected.connection, explanation: connection.explanation });
      const listed =
        earliest >= clock.earliest + buffer &&
        latest >= clock.latest + buffer &&
        live.predictions.some((prediction) => prediction.arrivesAt === earliest) &&
        live.predictions.some((prediction) => prediction.arrivesAt === latest);

      if (!reselected && !listed) {
        return null;
      }

      const wait = {
        min: Math.max(0, (earliest - clock.latest) / 1000),
        max: Math.max(0, (latest - clock.earliest) / 1000),
      };

      segment = {
        ...segment,
        durationSeconds: wait,
        planningBuffer: {
          weatherSeconds: 0,
          calibrationSeconds: 0,
        },
      };
      clock = {
        earliest,
        latest,
      };
    } else {
      if (
        connection &&
        (!transit(segment) ||
          index === 0 ||
          segments[index - 1].mode !== 'wait' ||
          !connectionOf(segments[index - 1]) ||
          !matches(connection, connectionOf(segments[index - 1])!))
      ) {
        return null;
      }

      if (segment.mode === 'wait' && segment.timingRule === 'taxi-dispatch') {
        if (segments[index + 1]?.mode !== 'taxi') {
          return null;
        }

        const dispatch = dispatchRange(clock),
          buffer =
            (segment.planningBuffer?.weatherSeconds ?? 0) +
            (segment.planningBuffer?.calibrationSeconds ?? 0);

        segment = {
          ...segment,
          durationSeconds: {
            min: dispatch.min,
            max: dispatch.max + buffer,
          },
        };
      } else if (segment.mode === 'wait' && segment.expectedWaitBasisSeconds !== undefined) {
        const vehicle = segments[index + 1],
          basis = segment.expectedWaitBasisSeconds;

        if (
          !transit(vehicle) ||
          !Number.isFinite(basis) ||
          basis <= 0 ||
          segment.durationSeconds.min < basis
        ) {
          return null;
        }

        const value = expectedWaitSeconds(vehicle, clock.latest);

        segment = {
          ...segment,
          durationSeconds: {
            min: segment.durationSeconds.min - basis + value,
            max: segment.durationSeconds.max - basis + value,
          },
          expectedWaitBasisSeconds: value,
        };
      }

      if (!validRange(segment.durationSeconds)) {
        return null;
      }

      clock = {
        earliest: clock.earliest + segment.durationSeconds.min * 1000,
        latest: clock.latest + segment.durationSeconds.max * 1000,
      };
    }

    if (
      !Number.isFinite(clock.earliest) ||
      !Number.isFinite(clock.latest) ||
      clock.earliest < now ||
      clock.latest < clock.earliest ||
      clock.latest - now > 86_400_000
    ) {
      return null;
    }

    segments[index] = {
      ...segment,
      timeRange: {
        ...clock,
      },
    };
    times.push({
      ...clock,
    });
  }

  const last = times.at(-1)!;

  const reference: Route = {
    ...route,
    segments,
    durationSeconds: {
      min: (last.earliest - now) / 1000,
      max: (last.latest - now) / 1000,
    },
    arrivalTime: {
      ...last,
    },
  };

  return journeyFeaturesForRoute(
    reference,
    now,
    weather,
    journeyReferenceProfile(calibrationPolicy, hasPublished ? 2 : 1),
    hasPublished
      ? {
          version: 2,
          basis: 'published-schedule-source-reference',
          queriedAt: now,
          publishedLegs,
        }
      : undefined,
  );
}
