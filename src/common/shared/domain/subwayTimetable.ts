import type {
  BaseSegment,
  ScheduledConnection,
  DurationRange,
  SubwayTimetable,
  TimeRange,
} from './types.js';
import { headwayRunsFrom, TIMETABLE_BOARDING_BUFFER_SECONDS } from './waitEstimates.js';

const norm = (value: string) =>
  value
    .normalize('NFC')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s/g, '')
    .replace(/역$/, '');

const line = (value: string) =>
  value
    .replace(/^(서울|수도권|지하철)/, '')
    .replace(/^0/, '')
    .replace(/(급행|일반|특급|직통)$/, '')
    .trim();

export function timetableMatchesSegment(table: SubwayTimetable, segment: BaseSegment): boolean {
  const stops = segment.transit?.stops;

  return (
    segment.mode === 'subway' &&
    !!stops &&
    stops.length >= 2 &&
    !!segment.transit?.lines.some((value) => line(value) === table.line) &&
    norm(stops[0]) === norm(table.boardingStation) &&
    norm(stops[1]) === norm(table.nextStation) &&
    norm(stops.at(-1)!) === norm(table.alightingStation)
  );
}

export function timetableIsFresh(
  table: SubwayTimetable | undefined,
  now: number,
): table is SubwayTimetable {
  return (
    !!table &&
    Number.isFinite(now) &&
    table.validFrom === Date.parse(`${table.serviceDate}T05:00:00+09:00`) &&
    table.complete === true &&
    table.provider === 'seoul-metro-timetable' &&
    table.receivedAt <= now + 3000 &&
    now - table.receivedAt <= 6 * 3600000 &&
    table.validFrom <= now &&
    now < table.validUntil &&
    table.validUntil - table.validFrom === 86400000 &&
    table.departures.length > 0 &&
    table.departures.every(
      (row, index) =>
        Number.isFinite(row.departureAt) &&
        Number.isFinite(row.arrivalAt) &&
        row.departureAt >= table.validFrom &&
        row.departureAt < table.validUntil &&
        row.arrivalAt > row.departureAt &&
        row.arrivalAt - row.departureAt <= 4 * 3600000 &&
        (index === 0 || row.departureAt >= table.departures[index - 1].departureAt),
    )
  );
}

/** A later express may overtake an earlier local. Minimize arrival, then departure. */
export function bestScheduledTrip(table: SubwayTimetable, reachAt: number) {
  const cutoff = reachAt + TIMETABLE_BOARDING_BUFFER_SECONDS * 1000;
  let best: SubwayTimetable['departures'][number] | null = null;

  for (const row of table.departures) {
    if (
      row.departureAt >= cutoff &&
      (!best ||
        row.arrivalAt < best.arrivalAt ||
        (row.arrivalAt === best.arrivalAt &&
          (row.departureAt < best.departureAt ||
            (row.departureAt === best.departureAt && row.trainNo.localeCompare(best.trainNo) < 0))))
    ) {
      best = row;
    }
  }

  return best;
}

export function scheduledArrivalAt(table: SubwayTimetable, departureAt: number): number | null {
  const rows = table.departures.filter((row) => row.departureAt === departureAt);

  return rows.length ? Math.min(...rows.map((row) => row.arrivalAt)) : null;
}

/** Null means this snapshot cannot evaluate this clock, not evidence of no service. */
export function scheduledDepartures(
  segment: BaseSegment,
  reach: TimeRange,
  now: number,
): {
  connection: ScheduledConnection;
  wait: DurationRange;
  ride: DurationRange;
  departure: TimeRange;
  arrival: TimeRange;
} | null {
  const table = segment.timetable;

  if (
    !timetableIsFresh(table, now) ||
    !timetableMatchesSegment(table, segment) ||
    reach.earliest < table.validFrom ||
    reach.latest >= table.validUntil ||
    reach.latest < reach.earliest
  ) {
    return null;
  }

  const first = bestScheduledTrip(table, reach.earliest),
    last = bestScheduledTrip(table, reach.latest);

  if (!first || !last) {
    return null;
  }

  const buffer = TIMETABLE_BOARDING_BUFFER_SECONDS * 1000;
  const probes = [reach.earliest, reach.latest];

  for (const row of table.departures) {
    const boundary = row.departureAt - buffer;

    if (boundary >= reach.earliest && boundary <= reach.latest) {
      probes.push(boundary);
    }

    if (boundary + 0.001 >= reach.earliest && boundary + 0.001 <= reach.latest) {
      probes.push(boundary + 0.001);
    }
  }

  const waits: number[] = [],
    rides: number[] = [];

  for (const probe of probes) {
    const trip = bestScheduledTrip(table, probe);

    if (!trip) {
      return null;
    }

    waits.push((trip.departureAt - probe) / 1000);

    rides.push((trip.arrivalAt - trip.departureAt) / 1000);
  }

  const next = bestScheduledTrip(table, last.departureAt - buffer + 0.001);

  return {
    departure: {
      earliest: first.departureAt,
      latest: last.departureAt,
    },
    arrival: {
      earliest: first.arrivalAt,
      latest: last.arrivalAt,
    },
    wait: {
      min: Math.ceil(Math.min(...waits)),
      max: Math.ceil(Math.max(...waits)),
    },
    ride: {
      min: Math.min(...rides),
      max: Math.max(...rides),
    },
    connection: {
      trainNo: first.trainNo,
      trainArrivalAt: first.arrivalAt,
      latestTrainNo: last.trainNo,
      latestTrainArrivalAt: last.arrivalAt,
      departureAt: first.departureAt,
      fallbackDepartureAt:
        first.departureAt !== last.departureAt ? last.departureAt : next?.departureAt,
      status: first.departureAt === last.departureAt ? 'comfortable' : 'borderline',
      boardingMarginSeconds: Math.floor((first.departureAt - reach.latest - buffer) / 1000),
      explanation:
        '공개 시간표에서 방향·하차역 정차를 확인하고 가장 일찍 도착하는 편을 골랐어요. 실제 지연·결행을 관측한 정보는 아니에요.',
    },
  };
}

/** A complete current-day snapshot can rule out a departure of its own service day, but unavailable snapshots never
 * can, and neither can it rule out the next day's first trains that the boarding's dated headway evidence holds: a
 * rider past the last train, or before 05:00, waits for the first one. */
export function publishedServiceEnded(
  segment: BaseSegment,
  reach: TimeRange,
  now: number,
): boolean {
  const table = segment.timetable;

  return (
    timetableIsFresh(table, now) &&
    timetableMatchesSegment(table, segment) &&
    reach.earliest >= table.validFrom &&
    reach.latest < table.validUntil &&
    table.departures.every(
      (row) => row.departureAt < reach.latest + TIMETABLE_BOARDING_BUFFER_SECONDS * 1000,
    ) &&
    !headwayRunsFrom(segment, table.validUntil)
  );
}
