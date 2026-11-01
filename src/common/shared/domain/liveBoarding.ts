import {
  publishedServiceEnded,
  timetableIsFresh,
  timetableMatchesSegment,
} from './subwayTimetable.js';
import type { BaseSegment, BoardingRealtime, DurationRange, TimeRange } from './types.js';
import {
  evidenceHeadway,
  expectedWaitSeconds,
  headwayRunsFrom,
  headwayServiceEnded,
  REALTIME_BOARDING_BUFFER_SECONDS,
  TIMETABLE_BOARDING_BUFFER_SECONDS,
  waitChangeTimes,
} from './waitEstimates.js';

const SECOND = 1000,
  EPSILON = 0.001;
const isVehicle = (segment: BaseSegment | undefined): segment is BaseSegment =>
  segment?.mode === 'bus' || segment?.mode === 'subway';
type ListedFeed = Pick<BoardingRealtime, 'status' | 'predictions'>;

/** Kerb or platform access between reaching the stop and boarding a listed (live) vehicle. */
export const boardingBufferMs = (vehicle: BaseSegment) =>
  REALTIME_BOARDING_BUFFER_SECONDS[vehicle.mode as 'bus' | 'subway'] * SECOND;
/** Platform to train for a published timetable departure; the same cutoff the timetable selector uses. */
const publishedBufferMs = TIMETABLE_BOARDING_BUFFER_SECONDS * SECOND;

/** Spacing of vehicles no feed has listed yet, at `at`: the wait of a rider who reaches the stop at random and the
 * headway between consecutive vehicles. Every continuation reads both from here: the boarding's dated headway
 * evidence where a window covers `at`, otherwise the rule wait and the even spacing it implies. */
export function unlistedHeadway(
  vehicle: BaseSegment,
  at: number,
): { waitSeconds: number; headwaySeconds: number } {
  const evidence = evidenceHeadway(vehicle, at);
  if (evidence && evidence !== 'ended') return evidence;
  const waitSeconds = expectedWaitSeconds(vehicle, at);
  return { waitSeconds, headwaySeconds: 2 * waitSeconds };
}

/** Listed departures, earliest first. A list binds at any age: no unlisted vehicle runs before its last entry,
 * and nobody boards before a listed vehicle that is still catchable. Age only lowers trust. */
export function listedDepartures(live: ListedFeed | undefined): number[] {
  return live?.status === 'live'
    ? live.predictions
        .map((prediction) => prediction.arrivesAt)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
    : [];
}

const usableTimetable = (vehicle: BaseSegment, at: number, now: number) => {
  const table = vehicle.timetable;
  return vehicle.mode === 'subway' &&
    timetableIsFresh(table, now) &&
    timetableMatchesSegment(table, vehicle) &&
    at >= table.validFrom &&
    at < table.validUntil
    ? table
    : null;
};

export interface UnlistedDeparture {
  departureAt: number;
  basis: 'published-departure' | 'wait-rule';
}

/** Clocks in (from, to] at which the raw continuation can step down: the unlisted-vehicle wait changes (rule pieces
 * or headway evidence windows) and the published timetable's validity edges. Between two of them the raw continuation
 * never decreases. Every caller that needs those pieces reads them here. */
export function continuationEdges(vehicle: BaseSegment, from: number, to: number): number[] {
  const edges: number[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return edges;
  const add = (time: number) => {
    if (time > from && time <= to) edges.push(time);
  };
  for (const time of waitChangeTimes(vehicle, from, to)) add(time);
  const table = vehicle.mode === 'subway' ? vehicle.timetable : undefined;
  if (table) {
    add(table.validFrom);
    add(table.validUntil);
  }
  return edges.sort((a, b) => a - b);
}

/** The continuation on the piece that contains `at`: a matching current published timetable, otherwise the unlisted
 * headway, never earlier than one headway after the last listed vehicle. Not FIFO across piece edges. */
function rawUnlistedDeparture(
  vehicle: BaseSegment,
  live: ListedFeed | undefined,
  at: number,
  now: number,
): UnlistedDeparture | null {
  if (
    live?.predictions.some((prediction) => prediction.lastService) ||
    publishedServiceEnded(vehicle, { earliest: at, latest: at }, now) ||
    headwayServiceEnded(vehicle, at)
  )
    return null;
  const lastListed = listedDepartures(live).at(-1);
  const table = usableTimetable(vehicle, at, now);
  if (table) {
    // The published buffer is shorter than the live one, so a train the list shows as missed can still look catchable
    // on the timetable. The list binds: a published continuation departs after its last vehicle, and a complete current
    // timetable with no such train has ended.
    const cutoff = at + publishedBufferMs;
    const published = table.departures.find(
      (row) =>
        row.departureAt >= cutoff && (lastListed === undefined || row.departureAt > lastListed),
    );
    if (published) return { departureAt: published.departureAt, basis: 'published-departure' };
    // Past the table's last train only the next service day's first trains in the dated evidence still run.
    if (!headwayRunsFrom(vehicle, table.validUntil)) return null;
  }
  const afterListed =
    lastListed === undefined
      ? -Infinity
      : lastListed + unlistedHeadway(vehicle, lastListed).headwaySeconds * SECOND;
  return {
    departureAt: Math.max(at + unlistedHeadway(vehicle, at).waitSeconds * SECOND, afterListed),
    basis: 'wait-rule',
  };
}

/** The vehicle a rider reaching the stop at `at` boards once the listed vehicles are exhausted. A rider who arrives
 * earlier can always wait for the vehicle a later rider boards, so this is the FIFO envelope of the raw continuation:
 * the earliest raw departure over every clock from `at` on. The raw continuation only steps down at a piece edge and
 * always departs after its own clock, so the edges up to the raw departure decide it. Null when nothing runs after: a
 * listed last service, a published timetable that has ended, or headway evidence with no later running window. */
export function nextUnlistedDeparture(
  vehicle: BaseSegment,
  live: ListedFeed | undefined,
  at: number,
  now: number,
): UnlistedDeparture | null {
  if (!isVehicle(vehicle) || !Number.isFinite(at) || !Number.isFinite(now)) return null;
  let best = rawUnlistedDeparture(vehicle, live, at, now);
  if (!best) return null;
  for (const edge of continuationEdges(vehicle, at, best.departureAt)) {
    const later = rawUnlistedDeparture(vehicle, live, edge, now);
    if (later && later.departureAt < best.departureAt) best = later;
  }
  return best;
}

/** Marginal wait of access clocks in (after, to] — or [after, to] with `includeAfter` — that all board an unlisted
 * vehicle. Between two piece edges or timetable boardings the envelope's wait never rises, so those points bound it. */
export function unlistedWaitRange(
  vehicle: BaseSegment,
  live: ListedFeed | undefined,
  after: number,
  to: number,
  now: number,
  includeAfter = false,
): DurationRange | null {
  if (
    !isVehicle(vehicle) ||
    !Number.isFinite(after) ||
    !Number.isFinite(to) ||
    to < after ||
    (to === after && !includeAfter)
  )
    return null;
  const probes = [includeAfter ? after : after + EPSILON, to];
  const add = (time: number) => {
    if ((includeAfter ? time >= after : time > after) && time <= to) probes.push(time);
  };
  for (const edge of continuationEdges(vehicle, after - 1, to)) {
    add(edge);
    add(edge - EPSILON);
  }
  const table = vehicle.mode === 'subway' ? vehicle.timetable : undefined;
  if (table) {
    for (const row of table.departures) {
      add(row.departureAt - publishedBufferMs);
      add(row.departureAt - publishedBufferMs + EPSILON);
    }
  }
  let min = Infinity,
    max = -Infinity;
  for (const probe of probes) {
    const next = nextUnlistedDeparture(vehicle, live, probe, now);
    if (!next) return null;
    const wait = (next.departureAt - probe) / SECOND;
    min = Math.min(min, wait);
    max = Math.max(max, wait);
  }
  return { min: Math.ceil(min), max: Math.ceil(max) };
}

export interface LiveDepartureRange {
  /** Boarding clock of the fastest and the slowest access. */
  departure: TimeRange;
  /** The earliest access catches a listed vehicle. */
  earliestListed: boolean;
  /** The slowest access still catches a listed vehicle. */
  latestListed: boolean;
  /** The slowest access misses the last vehicle (a listed last service or the published end); its bound stays on that vehicle. */
  missesLastService: boolean;
  /** How any bound beyond the list was continued. */
  continuation?: UnlistedDeparture['basis'];
}

/** Boarding range for access clocks `reach` at a stop with a (possibly aged) arrival list: listed vehicles first,
 * then the shared continuation. One function for the graph, the planner, the app's re-validation and urgency. */
export function liveDepartureRange(
  vehicle: BaseSegment,
  live: ListedFeed | undefined,
  reach: TimeRange,
  now: number,
): LiveDepartureRange | null {
  if (
    !isVehicle(vehicle) ||
    !Number.isFinite(reach.earliest) ||
    !Number.isFinite(reach.latest) ||
    reach.latest < reach.earliest
  )
    return null;
  const buffer = boardingBufferMs(vehicle),
    listed = listedDepartures(live);
  const earliest = listed.find((departure) => departure >= reach.earliest + buffer);
  const latest = listed.find((departure) => departure >= reach.latest + buffer);
  if (earliest !== undefined && latest !== undefined)
    return {
      departure: { earliest, latest },
      earliestListed: true,
      latestListed: true,
      missesLastService: false,
    };
  const late = nextUnlistedDeparture(vehicle, live, reach.latest, now);
  if (earliest === undefined) {
    const early = nextUnlistedDeparture(vehicle, live, reach.earliest, now);
    return early && late
      ? {
          departure: { earliest: early.departureAt, latest: late.departureAt },
          earliestListed: false,
          latestListed: false,
          missesLastService: false,
          continuation: late.basis,
        }
      : null;
  }
  // Nothing runs after the last vehicle: a slower access misses it rather than boarding an invented one.
  if (!late)
    return {
      departure: { earliest, latest: listed.at(-1)! },
      earliestListed: true,
      latestListed: false,
      missesLastService: true,
    };
  return {
    departure: { earliest, latest: late.departureAt },
    earliestListed: true,
    latestListed: false,
    missesLastService: false,
    continuation: late.basis,
  };
}
