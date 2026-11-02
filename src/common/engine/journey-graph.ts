import {
  scheduledArrivalAt,
  publishedServiceEnded,
  scheduledDepartures,
  timetableIsFresh,
  timetableMatchesSegment,
} from '../shared/domain/subwayTimetable.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Connection,
  ParkingAccess,
  Place,
  Risk,
  SubwayTimetable,
} from '../shared/domain/types.js';
import {
  evaluateBaseTimeline,
  LAST_SERVICE_RISK,
  LIVE_MISSED_HEADWAY_RISK,
  LIVE_MISSED_TIMETABLE_RISK,
  liveBoardingExplanation,
  selectLiveBoarding,
  TAB_MODES,
  type TabMode,
} from '../shared/domain/routing.js';
import { validLiveVehicles } from '../shared/domain/vehicleConstraints.js';
import { metersBetween, stationBaseName } from './realtime/names.js';
import { MAX_CONNECTOR_METERS } from './connectivity/walking-comparison.js';
import { expectedWaitSeconds, stationGateStep } from './transit-enrichment.js';
import { headwayServiceEnded, waitChangeTimes } from '../shared/domain/waitEstimates.js';
import { taxiPickupSeconds } from './multimodal.js';
import type { WeatherSnapshot } from '../shared/intelligence/types.js';
import {
  applyContextualEtaSegment,
  learningFeaturesForSegment,
  physicalFloorSeconds,
  SEARCH_CONTEXT_HORIZON_MS,
  type ContextualPredictor,
} from './intelligence/learning-features.js';
import { localWeatherIsFresh } from './intelligence/planningTiming.js';
import {
  applyPublicBusSegment,
  restorePublicBusSource,
  type PublicBusPredictor,
} from './intelligence/public-bus-timing.js';
import {
  estimateBaseTimeline,
  estimatedSegmentSeconds,
  type RoutingObjective,
} from '../shared/domain/estimatedTiming.js';
import { compareRouteEffort } from '../shared/domain/routeEffort.js';
import { MinPriorityQueue } from './min-priority-queue.js';
import {
  boardingAccessComparator,
  continuesRide,
  firstRideSegment,
  lastRideSegment,
  rideKey,
} from './ride-identity.js';

export interface JourneyGraphOptions {
  receivedAt: number;
  objective?: RoutingObjective;
  /** Exact is for small-network validation; it removes computation caps, not user constraints. */ searchMode?:
    'bounded' | 'exact';
  maxExpansions?: number;
  maxResults?: number;
  maxEdges?: number;
  maxLabelsPerState?: number;
  maxLegs?: number;
  maxJourneySeconds?: number;
  /** Default true: one result per ride key, so result slots hold distinct rides. False keeps every path variant (frontier audits). */
  distinctRides?: boolean;
  /** Default true: never plan a ride that walking its stretch nearly matches, a run to a rule-timed boarding, or a vehicle use
   * that walking would beat (WALK_DOMINANCE_SLACK_SECONDS). Ranking is the arrival either way; false drops these walk-only
   * comparisons for the plain fastest-arrival search (audits, toy geometry). */
  rankingCosts?: boolean;
  /** Reserve a results tab's best route from the already fetched paths without changing their arrivals. */ requiredMode?: TabMode;
  /** Reserve a results tab's best pure route: like `requiredMode`, and no other vehicle (bus, train, taxi, car, rental) is
   * used anywhere on the journey; walking, running, gates and waits are free. */
  pureMode?: TabMode;
  parkingAt?: (lot: Place, arrivalAt: number) => ParkingAccess | null;
  contextualEta?: { weather: WeatherSnapshot | null; predict: ContextualPredictor };
  publicBusEta?: { predict: PublicBusPredictor };
  acceptRoute?: (route: BaseRoute) => boolean;
  /** Nonnegative correction to the selected objective, never a change of physical chronology. */ scoreCompleteRoute?: (
    route: BaseRoute,
  ) => number;
}
export type JourneyGraphLimit =
  'edges' | 'expansions' | 'labels' | 'legs' | 'duration' | 'comparison-results';
export interface JourneyGraphDiagnostics {
  scope: 'bounded-fetched-network';
  searchMode: 'bounded' | 'exact';
  objective: RoutingObjective;
  pathDomain: 'no-repeated-transfer-node';
  nodes: number;
  edges: number;
  expanded: number;
  excludedEdges: number;
  complete: boolean;
  limitReached: boolean;
  termination: 'exhausted' | 'result-bound' | 'expansion-limit' | 'stale-input';
  limitsReached: JourneyGraphLimit[];
  omittedLabels: number;
  /** All bounds use the selected objective's elapsed seconds, plus any nonnegative complete-route correction. */
  bestObjectiveSeconds: number | null;
  unexploredLowerBoundSeconds: number | null;
  optimalityGapSeconds: number | null;
  optimalityProven: boolean;
  /** compile() exclusions by kind; the values add up to excludedEdges. */
  excludedEdgeReasons: Record<string, number>;
  /** Expansions refused because they would alight and re-board the same line in the same direction at one station. */
  sameRideReboards: number;
  /** Complete journeys dropped because a better one boards the same rides (one result per ride key). */
  duplicateRideResults: number;
  /** Expansions refused because their ride saves less than MIN_RIDE_SAVING_SECONDS over walking the same stretch. */
  shortRides: number;
  /** Expansions refused because a run leads to a boarding timed only by a rule (average headway or taxi dispatch). */
  runsBeforeRuleWaits: number;
  /** Vehicle uses refused because walking would do better (WALK_DOMINANCE_SLACK_SECONDS): the vehicles so far reach this point
   * later than a walk from the origin, or the journey already stood where a walk to the destination arrives sooner. */
  walkableDetours: number;
}
export interface JourneyGraphResult {
  routes: BaseRoute[];
  diagnostics: JourneyGraphDiagnostics;
}
export const DEFAULT_MAX_JOURNEY_SECONDS = 4 * 60 * 60;
/** Default computation bounds, the largest the options accept. Live searches compile about 700-750 arcs (2026-10-31:
 * 서울역→강남역 746, 강남역→잠실역 688) and their main search ends by the result bound after 4,400-17,300 expansions, so
 * normal searches stop by the bound or by exhaustion, not by a cap. Per expansion the search now costs about 0.15 ms. */
export const DEFAULT_MAX_EDGES = 2000,
  DEFAULT_MAX_EXPANSIONS = 20000;
/** compile() merges arcs with equal content; `itineraries` keeps every provider itinerary that contributed one, so a merged arc is still each source's own.
 * A gate arc times a station's gates between its paid area and its street point; gates never count toward the arc cap. */
interface Arc {
  id: string;
  from: string;
  to: string;
  segments: BaseSegment[];
  notes: Risk[];
  resource: 'rental' | 'car' | null;
  itineraries: ReadonlySet<string>;
  gate?: boolean;
}
const sharesItinerary = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string>) =>
  !!a && [...a].some((id) => b.has(id));
const containsAll = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined) =>
  !b || (!!a && [...b].every((id) => a.has(id)));
interface Label {
  node: string;
  min: number;
  max: number;
  estimated: number;
  segments: BaseSegment[];
  arcs: string[];
  visited: Set<string>;
  rentals: number;
  /** Notes of warning severity, counted when the label is made. */
  warnings: number;
  carUsed: boolean;
  requiredModeUsed: boolean;
  bicycleMeters: number;
  runningMeters: number;
  precedingWaitSeconds: number;
  vehicleCount: number;
  notes: Risk[];
  /** Provider itineraries of the arc that held the last vehicle boarded. */
  rideSources?: ReadonlySet<string>;
  /** Vehicle uses so far: boardings (a continued ride counts once) and rentals. */
  uses: number;
  /** The run that brought the rider to this street point, while nothing else followed it. */
  trailingRun?: Stretch;
  /** The street stretch now being covered by vehicles (from the street point the rider left on foot or by gates). */
  riding?: Stretch;
  /** The earliest arrival of walking to the destination from a point this journey reached after a vehicle use. */
  homeBy: number;
  discarded?: boolean;
}
/** Where a stretch began, on the point-estimate and latest clocks, and the metres covered on it so far. */
interface Stretch {
  from: Place;
  estimated: number;
  max: number;
  meters: number;
  rides: number;
}
const key = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
const at = (a: Place, b: Place) =>
  Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;
const transit = (segment: BaseSegment) => segment.mode === 'bus' || segment.mode === 'subway';
const moving = (segment: BaseSegment) =>
  ['walk', 'run', 'bus', 'subway', 'bicycle', 'scooter', 'ebike', 'car', 'taxi'].includes(
    segment.mode,
  );
const number = (value: number, fallback: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const fresh = (value: number, now: number) =>
  Number.isFinite(value) && value <= now + 30000 && now - value <= 120000;
const warning = (code: Risk['code'], title: string, description: string): Risk => ({
  code,
  severity: 'warning',
  title,
  description,
});
const distinctNotes = (notes: Risk[]) => [
  ...new Map(notes.map((note) => [JSON.stringify(note), note])).values(),
];
/** Rides inside a hire…return pair: 따릉이, kick-scooter and dockless e-bike. */
const RENTAL_RIDES: ReadonlySet<BaseSegment['mode']> = new Set(['bicycle', 'scooter', 'ebike']);
const VEHICLE_MODES: readonly BaseSegment['mode'][] = [
  'bus',
  'subway',
  'bicycle',
  'scooter',
  'ebike',
  'taxi',
  'car',
];
/**
 * Extra vehicle uses carry no ranking cost (user decision D1, 2026-11-02): the recommended route and each tab's route are
 * the earliest arrival. A second rental or a boarding after a taxi is neither refused nor priced; it is chosen exactly when
 * it arrives sooner. Its real handling time is already on the clock (hire and return legs, waits, boarding margins).
 */
/** A bus or train hop (at most SHORT_HOP_METERS in a straight line, about a 15-minute walk) must save at least
 * MIN_RIDE_SAVING_SECONDS over walking the same street stretch; both are assumptions. A longer stretch is no hop a
 * rider would walk instead (a first train after a long wait), so the walking estimate never removes it. */
export const MIN_RIDE_SAVING_SECONDS = 120,
  SHORT_HOP_METERS = 1000;
/** A vehicle use is refused when walking does better by more than this (an assumption: walking estimates are taken at the
 * search clock, so a minute absorbs their drift at the later clock the rider walks). Two cases, both over fetched walks and
 * station gates only: the vehicles so far reach a point later than a walk from the origin would (a loop near the start, e.g.
 * 잠실역→강남역 "따릉이 → 2호선" riding away and walking back to 잠실역), or the journey already stood where a walk to the
 * destination arrives sooner than any continuation by vehicle (a loop past the end, e.g. "2호선 → 따릉이" alighting at 강남역,
 * walking on to 역삼역 and riding back). Walking itself is never refused, so the walk it is compared with stays a result. */
export const WALK_DOMINANCE_SLACK_SECONDS = 60;
/** Seconds a ride over the stretch from `from` to `to` saves over the fetched walk of that stretch; Infinity when it is no
 * short hop. The walk is the fetched network's own time, not an assumed pace: where the street walk is long (a rail line or
 * an elevated road between the stops) the ride saves what it really saves. */
const hopSavingSeconds = (from: Place, to: Place, walkSeconds: number, rideSeconds: number) =>
  metersBetween(from, to) > SHORT_HOP_METERS ? Infinity : walkSeconds - rideSeconds;

/**
 * Signatures memoized for one search. Evaluated copies keep their source's polyline, stop list, feed, traffic, timetable
 * and headway evidence, and a child label shares its parent's segment objects, so each of those heavy values is
 * serialized and interned once. `path` is the JSON array of the segment signatures (route ids hash it). The keys stand
 * for the same strings by interned ids, a heavy value by the id of its JSON, so two keys are equal exactly when the JSON
 * forms are equal while maps hash short strings. Nothing a search reads is mutated during it.
 */
function signer() {
  const ids = new Map<string, number>();
  const intern = (text: string) => {
    let id = ids.get(text);
    if (id === undefined) {
      id = ids.size;
      ids.set(text, id);
    }
    return id;
  };
  type Heavy = { json: string; id: number };
  const objects = new WeakMap<object, Heavy>(),
    lines = new WeakMap<object, Heavy>();
  const heavy = (cache: WeakMap<object, Heavy>, value: object | undefined, json: () => string) => {
    if (!value) return undefined;
    let entry = cache.get(value);
    if (!entry) {
      const text = json();
      entry = { json: text, id: intern(`h:${text}`) };
      cache.set(value, entry);
    }
    return entry;
  };
  const shared = (value: object | undefined) => heavy(objects, value, () => JSON.stringify(value));
  const plain = (value: unknown) => JSON.stringify(value) as string | undefined;
  // Equal current estimates do not imply equal estimates after a different access path: re-evaluation consumes the
  // original baseline and features. Headway windows decide every later wait for this vehicle, like a timetable.
  // The JSON form is exactly JSON.stringify of an object with these keys in this order: an undefined value is left out.
  const fields = (value: BaseSegment): [string, string | Heavy | undefined][] => [
    ['mode', plain(value.mode)],
    ['start', plain(key(value.start))],
    ['end', plain(key(value.end))],
    ['distance', plain(value.distanceMeters)],
    ['duration', plain(value.durationSeconds)],
    ['line', plain(value.lineName)],
    ['direction', plain(value.direction)],
    ['transit', shared(value.transit)],
    ['realtime', shared(value.realtime)],
    ['profile', plain(value.routingProfile)],
    ['parking', plain(value.parkingAccess)],
    ['rental', plain(value.rentalValidity)],
    ['bicycleAvailability', plain(value.bicycleAvailability)],
    ['expectedWaitBasisSeconds', plain(value.expectedWaitBasisSeconds)],
    ['expectedWaitBasisRangeSeconds', plain(value.expectedWaitBasisRangeSeconds)],
    ['cost', plain(value.costWon)],
    ['traffic', shared(value.traffic)],
    ['roadDelay', plain(value.roadDelaySeconds)],
    ['planningBuffer', plain(value.planningBuffer)],
    ['routingSource', plain(value.routingSource)],
    ['networkSnap', plain(value.networkSnap)],
    ['runAllowed', plain(value.runAllowed)],
    ['walkingDuration', plain(value.walkingDurationSeconds)],
    ['polyline', heavy(lines, value.polyline, () => JSON.stringify(value.polyline!.map(key)))],
    ['timingRule', plain(value.timingRule)],
    ['etaPrediction', plain(value.etaPrediction)],
    ['publicEtaPrediction', plain(value.publicEtaPrediction)],
    ['plannedConnection', plain(value.plannedConnection)],
    ['timetable', shared(value.timetable)],
    ['scheduledConnection', plain(value.scheduledConnection)],
    ['headwayEvidence', shared(value.headwayEvidence)],
  ];
  const encode = (value: BaseSegment, heavyPart: (part: Heavy) => string) =>
    `{${fields(value)
      .filter(([, part]) => part !== undefined)
      .map(([name, part]) => `"${name}":${typeof part === 'string' ? part : heavyPart(part!)}`)
      .join(',')}}`;
  const segments = new WeakMap<BaseSegment, string>(),
    segmentIds = new WeakMap<BaseSegment, number>(),
    noteIds = new WeakMap<Risk, number>();
  const segment = (value: BaseSegment) => {
    let json = segments.get(value);
    if (json === undefined) {
      json = encode(value, (part) => part.json);
      segments.set(value, json);
    }
    return json;
  };
  const segmentId = (value: BaseSegment) => {
    let id = segmentIds.get(value);
    if (id === undefined) {
      id = intern(`s:${encode(value, (part) => `#${part.id}`)}`);
      segmentIds.set(value, id);
    }
    return id;
  };
  const noteId = (value: Risk) => {
    let id = noteIds.get(value);
    if (id === undefined) {
      id = intern(`n:${JSON.stringify(value)}`);
      noteIds.set(value, id);
    }
    return id;
  };
  const labelPaths = new WeakMap<Label, string>(),
    labelEvidence = new WeakMap<Label, string>();
  return {
    path: (list: readonly BaseSegment[]) => `[${list.map(segment).join(',')}]`,
    /** Equal ⟺ equal signature of the segment. */
    segment: segmentId,
    /** Equal ⟺ equal `path` of the label's segments. */
    labelPath(label: Label) {
      let value = labelPaths.get(label);
      if (value === undefined) {
        value = label.segments.map(segmentId).join(',');
        labelPaths.set(label, value);
      }
      return value;
    },
    /** Distinct notes (first occurrence order) and vehicle segment signatures: equal ⟺ equal
     * JSON.stringify({notes:distinctNotes(label.notes),vehicles:<vehicle segment signatures>}). */
    evidence(label: Label) {
      let value = labelEvidence.get(label);
      if (value !== undefined) return value;
      value = `${[...new Set(label.notes.map(noteId))].join(',')}|${label.segments
        .filter((segment) => VEHICLE_MODES.includes(segment.mode))
        .map(segmentId)
        .join(',')}`;
      labelEvidence.set(label, value);
      return value;
    },
  };
}
type Signer = ReturnType<typeof signer>;
/** Histories with different clocks, remaining resources or forbidden future nodes are not interchangeable. */
const continuationState = (label: Label) =>
  JSON.stringify([
    label.node,
    label.min,
    label.max,
    label.estimated,
    label.rentals,
    label.carUsed,
    label.requiredModeUsed,
    label.bicycleMeters,
    label.runningMeters,
    label.precedingWaitSeconds,
    label.vehicleCount,
    label.segments.length,
    [...label.visited].sort(),
    label.uses,
    stretchState(label.trailingRun),
    stretchState(label.riding),
  ]);
const stretchState = (stretch: Stretch | undefined) =>
  stretch && [key(stretch.from), stretch.estimated, stretch.max, stretch.meters, stretch.rides];
// A gap between a walk's geometry and its anchor is accepted up to 75 m, or as far as the
// foot network recorded snapping that end (a building's map point can sit up to 150 m away).
const snapReach = (segment: BaseSegment, side: 'start' | 'end') =>
  Math.min(
    MAX_CONNECTOR_METERS,
    Math.max(75, (segment.networkSnap?.[side === 'start' ? 'startMeters' : 'endMeters'] ?? 0) + 2),
  );
const usableGeometry = (segment: BaseSegment) =>
  !moving(segment) ||
  segment.distanceMeters === 0 ||
  (!!segment.polyline &&
    segment.polyline.length >= 2 &&
    segment.polyline.every(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180,
    ) &&
    metersBetween(segment.polyline[0], segment.start) <= snapReach(segment, 'start') &&
    metersBetween(segment.polyline.at(-1)!, segment.end) <= snapReach(segment, 'end'));

function notesForArc(source: BaseRoute, segments: readonly BaseSegment[]): Risk[] {
  const ids = new Set(segments.map((segment) => segment.id));
  const missingFoot = (segment: BaseSegment) =>
    ['walk', 'run'].includes(segment.mode) &&
    segment.distanceMeters > 0 &&
    (segment.polyline?.length ?? 0) < 2;
  const omittedSourceFoot = source.segments.some(missingFoot) && !segments.some(missingFoot);
  return (source.notes ?? []).filter((note) => {
    if (note.segmentId && !ids.has(note.segmentId)) return false;
    // This server-generated warning describes an estimated access/egress edge, not
    // the other verified fragments reused from the same original itinerary.
    return !(
      omittedSourceFoot &&
      note.code === 'unverified-duration-range' &&
      note.title === '일부 도보 경로 미확인'
    );
  });
}

/** Provider road snapping is tolerated only at the requested journey's outer foot boundaries. */
function alignedFootSnap(source: BaseSegment, aligned: BaseSegment): BaseSegment {
  const snap = source.networkSnap,
    path = aligned.polyline;
  if (
    !snap ||
    !path?.length ||
    (source.start.latitude === aligned.start.latitude &&
      source.start.longitude === aligned.start.longitude &&
      source.end.latitude === aligned.end.latitude &&
      source.end.longitude === aligned.end.longitude)
  )
    return aligned;
  const startMeters = metersBetween(aligned.start, path[0]),
    endMeters = metersBetween(aligned.end, path.at(-1)!);
  // Alignment changes only the outer connector, never the supplied path or its
  // physical travel time. Retain every old allowance and add only new uncertainty.
  const allowanceSeconds = Math.max(snap.allowanceSeconds, Math.ceil(startMeters + endMeters)),
    added = allowanceSeconds - snap.allowanceSeconds;
  const grow = (range: { min: number; max: number }) => ({ ...range, max: range.max + added });
  return {
    ...aligned,
    networkSnap: { startMeters, endMeters, allowanceSeconds },
    durationSeconds: grow(aligned.durationSeconds),
    ...(aligned.walkingDurationSeconds
      ? { walkingDurationSeconds: grow(aligned.walkingDurationSeconds) }
      : {}),
    ...(aligned.etaPrediction
      ? {
          etaPrediction: {
            ...aligned.etaPrediction,
            sourceDurationSeconds: grow(aligned.etaPrediction.sourceDurationSeconds),
          },
        }
      : {}),
    ...(aligned.publicEtaPrediction
      ? {
          publicEtaPrediction: {
            ...aligned.publicEtaPrediction,
            sourceDurationSeconds: grow(aligned.publicEtaPrediction.sourceDurationSeconds),
          },
        }
      : {}),
  };
}
function alignOuterFootBoundaries(source: BaseRoute, request: BasePlanningRequest): BaseRoute {
  const segments = source.segments.map((segment) => ({ ...segment }));
  const first = segments[0];
  if (
    first &&
    (first.mode === 'walk' || first.mode === 'run') &&
    metersBetween(first.start, request.origin) <= snapReach(first, 'start')
  )
    first.start = request.origin;
  let lastIndex = segments.length - 1;
  const allowance = segments[lastIndex];
  if (allowance?.mode === 'wait' && allowance.id.endsWith('-provider-extra')) lastIndex--;
  const last = segments[lastIndex];
  if (
    last &&
    (last.mode === 'walk' || last.mode === 'run') &&
    metersBetween(last.end, request.destination) <= snapReach(last, 'end')
  ) {
    const previousEnd = last.end;
    last.end = request.destination;
    if (
      allowance !== last &&
      allowance?.mode === 'wait' &&
      at(allowance.start, previousEnd) &&
      at(allowance.end, previousEnd)
    ) {
      allowance.start = request.destination;
      allowance.end = request.destination;
    }
  }
  return {
    ...source,
    segments: segments.map((segment, index) => alignedFootSnap(source.segments[index], segment)),
  };
}

/** A provider's explicitly adjacent transit/walk transfer can have a few metres of rounding. */
function alignDeclaredFootTransfers(source: BaseRoute): BaseRoute {
  const segments = source.segments;
  for (let index = 0; index < segments.length; index++) {
    const foot = segments[index];
    if (foot.mode !== 'walk' && foot.mode !== 'run') continue;
    // With a chosen exit the walk starts at the exit step's sidewalk end; a step without one sits on the train's point.
    const previous =
      segments[index - 1]?.mode === 'entry' &&
      stationExitAfter(segments, index - 2) &&
      at(segments[index - 1].start, segments[index - 1].end)
        ? segments[index - 2]
        : segments[index - 1];
    let nextIndex = index + 1;
    while (
      segments[nextIndex] &&
      ['entry', 'wait'].includes(segments[nextIndex].mode) &&
      segments[nextIndex].distanceMeters === 0 &&
      at(segments[nextIndex].start, segments[nextIndex].end)
    )
      nextIndex++;
    const next = segments[nextIndex];
    const transfer = !!previous && transit(previous) && !!next && transit(next);
    const startTolerance =
      transfer &&
      previous.mode === 'subway' &&
      stationBaseName(previous.end.name) === stationBaseName(foot.start.name)
        ? 35
        : 5;
    const endTolerance =
      transfer &&
      next.mode === 'subway' &&
      stationBaseName(foot.end.name) === stationBaseName(next.start.name)
        ? 35
        : 5;
    const aligned = { ...foot };
    if (previous && transit(previous) && metersBetween(previous.end, foot.start) <= startTolerance)
      aligned.start = previous.end;
    if (
      next &&
      transit(next) &&
      metersBetween(foot.end, next.start) <= endTolerance &&
      segments.slice(index + 1, nextIndex).every((segment) => at(segment.start, next.start))
    )
      aligned.end = next.start;
    segments[index] = alignedFootSnap(foot, aligned);
  }
  return source;
}

/** These policy functions are constant between their declared daily clock boundaries. */
function dailyRuleRange(
  earliest: number,
  latest: number,
  changes: readonly number[],
  rule: (at: number) => number,
) {
  const times = [earliest, latest],
    day = 86400000,
    kstOffset = 9 * 3600000;
  for (
    let start = Math.floor((earliest + kstOffset) / day) * day - kstOffset;
    start <= latest;
    start += day
  ) {
    for (const minute of changes) {
      const change = start + minute * 60000;
      if (change >= earliest && change <= latest) times.push(change);
    }
  }
  const seconds = times.map(rule);
  return { min: Math.min(...seconds), max: Math.max(...seconds) };
}
const dispatchRange = (earliest: number, latest: number) =>
  dailyRuleRange(earliest, latest, [90, 450, 570, 1050, 1170, 1350], taxiPickupSeconds);
/** The shared wait changes only at its own change clocks (rule pieces or headway evidence windows). */
const headwayRange = (vehicle: BaseSegment, earliest: number, latest: number) => {
  const seconds = [earliest, latest, ...waitChangeTimes(vehicle, earliest, latest)].map((at) =>
    expectedWaitSeconds(vehicle, at),
  );
  return { min: Math.min(...seconds), max: Math.max(...seconds) };
};

const isProviderExtra = (segment: BaseSegment | undefined) =>
  segment?.mode === 'wait' && segment.id.endsWith('-provider-extra');
/** The first vehicle of evaluated segments is a bus, train or taxi that starts on a rule's average wait or a taxi dispatch, not on a
 * live arrival or a published departure. A rental, an own bicycle and the rider's car have no such wait, so a run before them is kept. */
const ruleWaitBoarding = (segments: readonly BaseSegment[]) => {
  const index = segments.findIndex((segment) => VEHICLE_MODES.includes(segment.mode));
  if (index < 0) return false;
  const mode = segments[index].mode;
  return (
    mode === 'taxi' ||
    ((mode === 'bus' || mode === 'subway') &&
      !segments
        .slice(0, index + 1)
        .some((segment) => !!segment.plannedConnection || !!segment.scheduledConnection))
  );
};
/** A platform-to-gate step: the station-access segment that directly follows a train ride. */
const stationExitAfter = (segments: readonly BaseSegment[], index: number) =>
  segments[index]?.mode === 'subway' && segments[index + 1]?.mode === 'entry';
/** Node of a station's paid area. A source that times gate passage (it carries station-access steps) leaves a train
 * here unless the arc includes the exit, and boards one from here unless the arc includes the entry, so no street walk of
 * another source can join a train without passing the gates. */
const PAID = 'paid:';
const arcEnds = (segments: readonly BaseSegment[]) => ({
  first: segments.find((segment) => segment.mode !== 'wait'),
  last: [...segments].reverse().find((segment) => !isProviderExtra(segment)),
});
function paidBoundaries(
  segments: readonly BaseSegment[],
  source: readonly BaseSegment[],
  start: number,
  end: number,
) {
  const { first, last } = arcEnds(segments);
  const vehicleAt = (index: number, step: -1 | 1) => {
    let next = index;
    while (source[next]?.mode === 'wait') next += step;
    return source[next];
  };
  // A foot transfer between two trains with no exit or entry around it stays behind the gates.
  const transfer =
    first === last &&
    (first?.mode === 'walk' || first?.mode === 'run') &&
    source[start - 1]?.mode === 'subway' &&
    vehicleAt(end + 1, 1)?.mode === 'subway';
  return { from: transfer || first?.mode === 'subway', to: transfer || last?.mode === 'subway' };
}

/** The shortest ride a published timetable lists. A timetabled train takes one of its rows' ride times, or, when the table
 * cannot be used at that clock, the segment's own time like any other train, so the smaller of the two bounds its ride. */
const shortestRows = new WeakMap<SubwayTimetable, number>();
const shortestTimetabledRide = (table: SubwayTimetable) => {
  let seconds = shortestRows.get(table);
  if (seconds === undefined) {
    seconds = Infinity;
    for (const row of table.departures) {
      const ride = (row.arrivalAt - row.departureAt) / 1000;
      if (Number.isFinite(ride) && ride > 0 && ride < seconds) seconds = ride;
    }
    shortestRows.set(table, seconds);
  }
  return seconds;
};
/** h(n) and g(n) edge costs: an admissible elapsed time over fetched segments only. Replaceable waits cost zero.
 * A context model can shorten a segment below the provider's estimate, but never below its physical floor. A timetabled
 * train counts its shortest published ride; counting it as nothing (before 11-02) left the remaining-time bound so loose
 * that a long search (강남역→광화문역) spent every expansion on walk and bus prefixes and found no route at all. */
const arcLowerBoundSeconds = (arc: Arc, options: JourneyGraphOptions) =>
  arc.segments.reduce((sum, segment) => {
    if (segment.mode === 'wait') return sum;
    const seconds = options.contextualEta
      ? physicalFloorSeconds(segment)
      : restorePublicBusSource(segment).durationSeconds.min;
    return (
      sum +
      (segment.mode === 'subway' && segment.timetable
        ? Math.min(seconds, shortestTimetabledRide(segment.timetable))
        : seconds)
    );
  }, 0);
/** Rider preferences that hold for an arc whatever history reaches it: the search never expands an arc that fails them. */
const arcAllowed = (arc: Arc, request: BasePlanningRequest) =>
  arc.from !== arc.to &&
  !(
    request.preferences.walkingOnly &&
    arc.segments.some((segment) => !['walk', 'entry', 'wait'].includes(segment.mode))
  ) &&
  !arc.segments.some(
    (segment) =>
      (segment.mode === 'taxi' && request.preferences.allowTaxi === false) ||
      (segment.mode === 'scooter' &&
        (request.preferences.allowScooter === false ||
          request.preferences.hasScooterLicense === false)) ||
      (segment.mode === 'ebike' && request.preferences.allowEbike === false) ||
      (segment.mode === 'bicycle' &&
        (!request.preferences.allowBicycle || !request.preferences.bicycleReady)),
  );
/** Dijkstra over nonnegative seconds from the given start states. */
function shortestSeconds(
  starts: readonly string[],
  edges: ReadonlyMap<string, readonly { to: string; seconds: number }[]>,
): Map<string, number> {
  const best = new Map<string, number>(),
    queue = new MinPriorityQueue<{ node: string; seconds: number }>(
      (a, b) => a.seconds - b.seconds,
    );
  for (const node of starts) {
    best.set(node, 0);
    queue.push({ node, seconds: 0 });
  }
  while (queue.size) {
    const current = queue.pop()!;
    if (current.seconds !== best.get(current.node)) continue;
    for (const edge of edges.get(current.node) ?? []) {
      const seconds = current.seconds + edge.seconds;
      if (seconds >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, seconds);
      queue.push({ node: edge.to, seconds });
    }
  }
  return best;
}
/** For every arc, a lower bound of the objective of any complete journey through it: the cheapest fetched way from the origin
 * to its start, the arc, and the cheapest way on to the destination; with a required mode, over journeys that use it.
 * Arcs no allowed journey can use get Infinity. The bound only orders arcs when the cap binds and certifies what it cut. */
function journeyLowerBounds(
  arcs: readonly Arc[],
  request: BasePlanningRequest,
  options: JourneyGraphOptions,
): number[] {
  const origin = key(request.origin),
    destination = key(request.destination),
    mode = options.requiredMode;
  // A state is a node plus whether the required mode was used; without one every state counts as used.
  const state = (node: string, used: boolean) => `${Number(used)}|${node}`;
  const cost = arcs.map((arc) =>
    arcAllowed(arc, request) && arc.from !== destination && arc.to !== origin
      ? arcLowerBoundSeconds(arc, options)
      : Infinity,
  );
  const uses = arcs.map((arc) => !mode || arc.segments.some((segment) => segment.mode === mode));
  const forward = new Map<string, { to: string; seconds: number }[]>(),
    backward = new Map<string, { to: string; seconds: number }[]>();
  const link = (
    edges: Map<string, { to: string; seconds: number }[]>,
    from: string,
    to: string,
    seconds: number,
  ) => {
    const list = edges.get(from);
    if (list) list.push({ to, seconds });
    else edges.set(from, [{ to, seconds }]);
  };
  arcs.forEach((arc, index) => {
    if (!Number.isFinite(cost[index])) return;
    for (const used of mode ? [false, true] : [true]) {
      link(forward, state(arc.from, used), state(arc.to, used || uses[index]), cost[index]);
      link(backward, state(arc.to, used || uses[index]), state(arc.from, used), cost[index]);
    }
  });
  const fromOrigin = shortestSeconds([state(origin, !mode)], forward),
    toDestination = shortestSeconds([state(destination, true)], backward);
  return arcs.map((arc, index) =>
    Math.min(
      ...(mode ? [false, true] : [true]).map(
        (used) =>
          (fromOrigin.get(state(arc.from, used)) ?? Infinity) +
          cost[index] +
          (toDestination.get(state(arc.to, used || uses[index])) ?? Infinity),
      ),
    ),
  );
}

/** Exact transfer anchors only: nearby roads, station interiors and stops are never implicit links.
 * When more arcs than the cap exist, the cap keeps those with the lowest journey lower bound, so the arcs that can lie on the
 * fastest journeys survive whatever order the sources came in; `omittedLowerBound` bounds every journey through a cut arc. */
function compile(
  sources: readonly BaseRoute[],
  request: BasePlanningRequest,
  cap: number,
  options: JourneyGraphOptions,
  sign: Signer,
) {
  const origin = key(request.origin),
    destination = key(request.destination);
  const arcs: Arc[] = [];
  const seen = new Map<string, Set<string>>();
  let excluded = 0;
  const reasons: Record<string, number> = {};
  const gates: {
    kind: 'entry' | 'exit';
    paid: string;
    street: string;
    ride: BaseSegment;
    source: string;
  }[] = [];
  const exclude = (kind: string) => {
    excluded++;
    reasons[kind] = (reasons[kind] ?? 0) + 1;
  };
  function add(source: BaseRoute, start: number, end: number, resource: Arc['resource'] = null) {
    const segments = source.segments
      .slice(start, end + 1)
      .map((segment) => ({ ...segment, durationSeconds: { ...segment.durationSeconds } }));
    if (!segments.length) {
      exclude('empty');
      return;
    }
    if (segments.some((segment) => !usableGeometry(segment))) {
      exclude('geometry');
      return;
    }
    if (
      segments.some(
        (segment) =>
          !Number.isFinite(segment.distanceMeters) ||
          segment.distanceMeters < 0 ||
          !Number.isFinite(segment.durationSeconds.min) ||
          !Number.isFinite(segment.durationSeconds.max) ||
          segment.durationSeconds.min < 0 ||
          segment.durationSeconds.max < segment.durationSeconds.min,
      )
    ) {
      exclude('duration');
      return;
    }
    if (segments.some((segment) => segment.traffic?.some((span) => span.level === 'blocked'))) {
      exclude('blocked-road');
      return;
    }
    if (
      segments.some((segment, index) => index > 0 && !at(segments[index - 1].end, segment.start))
    ) {
      exclude('discontinuous');
      return;
    }
    if (
      segments.some(
        (segment) =>
          RENTAL_RIDES.has(segment.mode) &&
          (segment.routingProfile !== segment.mode || resource !== 'rental'),
      )
    ) {
      exclude('rental-profile');
      return;
    }
    if (
      resource === 'rental' &&
      new Set(
        segments.filter((segment) => RENTAL_RIDES.has(segment.mode)).map((segment) => segment.mode),
      ).size !== 1
    ) {
      exclude('rental-mode');
      return;
    }
    if (
      options.pureMode &&
      segments.some(
        (segment) =>
          segment.mode !== options.pureMode &&
          (TAB_MODES as readonly string[]).includes(segment.mode),
      )
    ) {
      exclude('other-vehicle');
      return;
    }
    const taxiIndex = segments.findIndex((segment) => segment.mode === 'taxi');
    if (
      taxiIndex >= 0 &&
      !segments
        .slice(0, taxiIndex)
        .some(
          (segment) =>
            segment.mode === 'wait' &&
            at(segment.start, segments[taxiIndex].start) &&
            at(segment.end, segments[taxiIndex].start),
        )
    ) {
      exclude('taxi-without-dispatch');
      return;
    }
    if (
      segments.some(
        (segment) =>
          segment.mode === 'run' && (!segment.runAllowed || !request.preferences.allowRunning),
      )
    ) {
      exclude('running-not-allowed');
      return;
    }
    if (resource === 'car') {
      const car = segments.find((segment) => segment.mode === 'car')!,
        parking = segments.at(-1)!;
      if (
        !request.preferences.hasCar ||
        !request.preferences.carLocation ||
        !at(car.start, request.preferences.carLocation) ||
        !car.parkingAccess?.publicAccess ||
        car.parkingAccess.operating === 'closed' ||
        car.parkingAccess.occupancy === 'full' ||
        parking.mode !== 'wait' ||
        !at(parking.start, car.end) ||
        !at(parking.end, car.end)
      ) {
        exclude('car-parking');
        return;
      }
    }
    const notes = notesForArc(source, segments);
    const signature = `${resource ?? 'none'}:${sign.path(segments)}:${JSON.stringify(notes)}`;
    if (seen.has(signature)) {
      seen.get(signature)!.add(source.id);
      return;
    }
    const itineraries = new Set([source.id]);
    seen.set(signature, itineraries);
    const paid = source.segments.some((segment) => segment.mode === 'entry')
      ? paidBoundaries(segments, source.segments, start, end)
      : { from: false, to: false };
    const node = (place: Place, inside: boolean) => {
      const value = key(place);
      return inside && value !== origin && value !== destination ? `${PAID}${value}` : value;
    };
    const arc: Arc = {
      id: `${source.id}:${start}-${end}`,
      from: node(segments[0].start, paid.from),
      to: node(segments.at(-1)!.end, paid.to),
      segments,
      resource,
      notes,
      itineraries,
    };
    arcs.push(arc);
    const { first, last } = arcEnds(segments);
    if (arc.from.startsWith(PAID) && first?.mode === 'subway')
      gates.push({
        kind: 'entry',
        paid: arc.from,
        street: key(first.start),
        ride: first,
        source: source.id,
      });
    if (arc.to.startsWith(PAID) && last?.mode === 'subway')
      gates.push({
        kind: 'exit',
        paid: arc.to,
        street: key(last.end),
        ride: last,
        source: source.id,
      });
  }
  for (const input of sources) {
    const source = alignDeclaredFootTransfers(alignOuterFootBoundaries(input, request));
    for (let i = 0; i < source.segments.length; i++) {
      const segment = source.segments[i];
      if (segment.mode === 'hire') {
        let end = i + 1;
        while (
          end < source.segments.length &&
          (RENTAL_RIDES.has(source.segments[end].mode) || source.segments[end].mode === 'wait')
        )
          end++;
        const body = source.segments.slice(i + 1, end);
        if (
          source.segments[end]?.mode === 'return' &&
          body.some((segment) => RENTAL_RIDES.has(segment.mode))
        ) {
          add(source, i, end, 'rental');
          i = end;
        } else exclude('rental-incomplete');
      } else if (segment.mode === 'car') {
        if (source.segments[i + 1]?.mode === 'wait') {
          add(source, i, i + 1, 'car');
          i++;
        } else exclude('car-incomplete');
      } else if (segment.mode === 'walk' || segment.mode === 'run') {
        const extra = source.segments[i + 1];
        if (extra?.mode === 'wait' && extra.id.endsWith('-provider-extra')) {
          add(source, i, i + 1);
          i++;
        } else add(source, i, i);
      } else if (segment.mode === 'entry' || segment.mode === 'wait') {
        let end = i;
        while (
          end < source.segments.length &&
          ['entry', 'wait'].includes(source.segments[end].mode)
        )
          end++;
        if (
          source.segments[end] &&
          (transit(source.segments[end]) || source.segments[end].mode === 'taxi')
        ) {
          // The exit belongs to the ride: an arc that drops it would leave the rider behind the gates.
          if (stationExitAfter(source.segments, end)) end++;
          if (isProviderExtra(source.segments[end + 1])) end++;
          add(source, i, end);
          i = end;
        }
      } else if (transit(segment) || segment.mode === 'taxi') {
        let end = i;
        if (stationExitAfter(source.segments, end)) end++;
        if (isProviderExtra(source.segments[end + 1])) end++;
        add(source, i, end);
        i = end;
      } else exclude('unplaceable-segment');
    }
  }
  // A ride arc that stops behind the gates (an in-station transfer follows it in its source) or starts there (it boards
  // after one) reaches the street only through that station's gates. Bridges, anchors and other sources that leave or
  // join at the station's street point pass them with the same timed exit or entry as a source that ends its run there.
  // Gate arcs are bounded by the paid boundaries of the ride arcs, so they never count toward (or fall to) the arc cap.
  const leaves = new Set(arcs.map((arc) => arc.from)),
    reaches = new Set(arcs.map((arc) => arc.to));
  for (const gate of gates) {
    if (gate.kind === 'exit' ? !leaves.has(gate.street) : !reaches.has(gate.street)) continue;
    // A connection that starts or ends at the station point passes the nearest exit, named and timed (stationGateStep).
    const step = stationGateStep(
      gate.ride,
      gate.kind,
      `${gate.source}-gate-${gate.kind}`,
      request.now,
    );
    const signature = `gate:${gate.kind}:${gate.paid}:${sign.path([step])}`;
    if (seen.has(signature)) {
      seen.get(signature)!.add(gate.source);
      continue;
    }
    const itineraries = new Set([gate.source]);
    seen.set(signature, itineraries);
    arcs.push({
      id: `${gate.source}:gate-${gate.kind}:${gate.street}`,
      from: gate.kind === 'exit' ? gate.paid : gate.street,
      to: gate.kind === 'exit' ? gate.street : gate.paid,
      segments: [step],
      resource: null,
      notes: [],
      itineraries,
      gate: true,
    });
  }
  const counted = arcs.filter((arc) => !arc.gate).length;
  if (counted <= cap)
    return { arcs, excluded, reasons, truncated: false, omittedLowerBound: Infinity };
  // Over the cap: keep the arcs with the lowest journey lower bound (source order breaks ties) and certify the cut by the
  // lowest bound among the cut arcs. Arcs no allowed journey can use (bound Infinity) are cut first and limit nothing.
  const bounds = journeyLowerBounds(arcs, request, options);
  const order = arcs
    .map((_, index) => index)
    .filter((index) => !arcs[index].gate)
    .sort((a, b) => (bounds[a] < bounds[b] ? -1 : bounds[a] > bounds[b] ? 1 : a - b));
  const kept = new Set(order.slice(0, cap));
  const omittedLowerBound = Math.min(Infinity, ...order.slice(cap).map((index) => bounds[index]));
  // A gate stays while kept arcs still meet it on both sides.
  const from = new Set(arcs.filter((arc, index) => kept.has(index)).map((arc) => arc.from)),
    to = new Set(arcs.filter((arc, index) => kept.has(index)).map((arc) => arc.to));
  const selected = arcs.filter(
    (arc, index) => kept.has(index) || (arc.gate && to.has(arc.from) && from.has(arc.to)),
  );
  return {
    arcs: selected,
    excluded,
    reasons,
    truncated: Number.isFinite(omittedLowerBound),
    omittedLowerBound,
  };
}

function evaluate(
  arc: Arc,
  label: Label,
  request: BasePlanningRequest,
  options: JourneyGraphOptions,
): {
  segments: BaseSegment[];
  min: number;
  max: number;
  estimated: number;
  notes: Risk[];
  precedingWaitSeconds: number;
  vehicleCount: number;
} | null {
  // Arc segments are never mutated: every change below makes a new object, so an unchanged segment keeps its identity
  // (and its memoized signature) across every label that uses the arc.
  const source: readonly BaseSegment[] = arc.segments;
  const vehicle = source.find(transit),
    notes = [...arc.notes],
    parts: BaseSegment[] = [];
  let min = label.min,
    max = label.max,
    estimated = label.estimated,
    precedingWaitSeconds = label.precedingWaitSeconds,
    vehicleCount = label.vehicleCount;
  let carArrivalSeconds: number | null = null;
  const estimateObjective = options.objective === 'estimated-arrival';
  const weather = localWeatherIsFresh(options.contextualEta?.weather, request)
    ? options.contextualEta!.weather
    : null;
  function append(input: BaseSegment, nextVehicle?: BaseSegment) {
    let segment = restorePublicBusSource(input);
    if (
      segment.mode === 'wait' &&
      segment.timingRule === 'taxi-dispatch' &&
      source.some((part) => part.mode === 'taxi')
    ) {
      const dispatch = dispatchRange(request.now + min * 1000, request.now + max * 1000);
      const includedBuffer =
        (segment.planningBuffer?.weatherSeconds ?? 0) +
        (segment.planningBuffer?.calibrationSeconds ?? 0);
      segment = {
        ...segment,
        durationSeconds: { min: dispatch.min, max: dispatch.max + includedBuffer },
      };
    } else if (
      segment.mode === 'wait' &&
      !segment.realtime &&
      !segment.plannedConnection &&
      !segment.scheduledConnection &&
      nextVehicle &&
      segment.id.endsWith('-expected-wait')
    ) {
      const baseline = segment.etaPrediction?.sourceDurationSeconds ?? segment.durationSeconds;
      const inferred = expectedWaitSeconds(nextVehicle, request.now);
      const basis =
        segment.expectedWaitBasisSeconds ?? (baseline.min >= inferred ? inferred : undefined);
      const previousRange =
        segment.expectedWaitBasisRangeSeconds ??
        (basis === undefined ? undefined : { min: basis, max: basis });
      if (
        previousRange &&
        Number.isFinite(previousRange.min) &&
        Number.isFinite(previousRange.max) &&
        previousRange.min > 0 &&
        previousRange.max >= previousRange.min &&
        baseline.min >= previousRange.min &&
        baseline.max >= previousRange.max
      ) {
        const seconds = expectedWaitSeconds(nextVehicle, request.now + max * 1000);
        const range = headwayRange(nextVehicle, request.now + min * 1000, request.now + max * 1000);
        if (range.min !== previousRange.min || range.max !== previousRange.max) {
          const { etaPrediction, ...rest } = segment;
          // The restored source range already includes its original safety margin.
          // Restore that metadata too, or the point clock and next model input would
          // reinterpret the margin as physical waiting after this headway change.
          segment = {
            ...rest,
            ...(etaPrediction
              ? {
                  planningBuffer: {
                    ...(etaPrediction.sourcePlanningBuffer ?? {
                      weatherSeconds: 0,
                      calibrationSeconds: 0,
                    }),
                  },
                }
              : {}),
            durationSeconds: {
              min: baseline.min - previousRange.min + range.min,
              max: baseline.max - previousRange.max + range.max,
            },
            expectedWaitBasisSeconds: seconds,
            expectedWaitBasisRangeSeconds: range,
          };
        } else if (
          segment.expectedWaitBasisSeconds === undefined ||
          segment.expectedWaitBasisRangeSeconds === undefined
        )
          segment = {
            ...segment,
            expectedWaitBasisSeconds: seconds,
            expectedWaitBasisRangeSeconds: range,
          };
      }
    }
    if (options.contextualEta && !segment.scheduledConnection) {
      // Learning tickets date stages on the conservative clock, so search weather follows that clock even when the objective plans on point estimates.
      const feature = learningFeaturesForSegment(
        segment,
        {
          startedAt: request.now + (estimateObjective ? estimated : max) * 1000,
          precedingWaitSeconds,
          vehicleCount,
          requestNow: request.now,
        },
        max * 1000 <= SEARCH_CONTEXT_HORIZON_MS ? weather : null,
      );
      segment = applyContextualEtaSegment(
        segment,
        feature,
        request.now,
        options.contextualEta.predict,
      );
    }
    if (options.publicBusEta)
      segment = applyPublicBusSegment(
        segment,
        request.now + (estimateObjective ? estimated : max) * 1000,
        request.now,
        options.publicBusEta.predict,
      );
    const previous = max,
      connection =
        segment.mode === 'wait'
          ? (segment.plannedConnection ?? segment.scheduledConnection)
          : undefined;
    const estimatedDuration =
      connection && nextVehicle
        ? estimateBaseTimeline([segment, nextVehicle], request.now, request.now + estimated * 1000)
            ?.components[0]?.seconds
        : estimatedSegmentSeconds(segment, request.now + estimated * 1000, nextVehicle);
    const previousEstimate = estimated;
    estimated += estimatedDuration ?? NaN;
    if (connection) {
      min = (connection.departureAt - request.now) / 1000;
      max =
        ((connection.status === 'borderline'
          ? (connection.fallbackDepartureAt ?? connection.departureAt)
          : connection.departureAt) -
          request.now) /
        1000;
    } else if (segment.mode === 'subway' && segment.scheduledConnection && segment.timetable) {
      const early = scheduledArrivalAt(segment.timetable, request.now + min * 1000),
        late = scheduledArrivalAt(segment.timetable, request.now + max * 1000);
      min = early === null ? NaN : (early - request.now) / 1000;
      max = late === null ? NaN : (late - request.now) / 1000;
    } else {
      min += segment.durationSeconds.min;
      max += segment.durationSeconds.max;
    }
    if (segment.mode === 'car') carArrivalSeconds = max;
    if (segment.mode === 'wait')
      precedingWaitSeconds += estimateObjective ? estimated - previousEstimate : max - previous;
    else if (
      ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter', 'ebike'].includes(segment.mode)
    ) {
      vehicleCount++;
      precedingWaitSeconds = 0;
    }
    parts.push(segment);
  }
  if (vehicle) {
    const index = source.findIndex(transit),
      prefix = source.slice(0, index);
    let live = vehicle.realtime;
    // Boarding waits belong to the old access clock. Replace both averages and
    // explicit departure bindings before selecting a train for this history;
    // only a fixed stop/platform delay remains physical access.
    const usableTable =
      timetableIsFresh(vehicle.timetable, request.now) &&
      timetableMatchesSegment(vehicle.timetable, vehicle);
    if (
      live &&
      usableTable &&
      (!fresh(live.receivedAt, request.now) || !fresh(live.observedAt, request.now))
    )
      live = undefined;
    const access =
      live || usableTable
        ? prefix.filter(
            (segment) =>
              segment.mode !== 'wait' ||
              (!segment.id.endsWith('-expected-wait') &&
                !segment.plannedConnection &&
                !segment.scheduledConnection),
          )
        : prefix;
    for (const segment of access) append(segment, live || usableTable ? undefined : vehicle);
    const reachMin = request.now + min * 1000,
      reachMax = request.now + max * 1000;
    const appendPublished = () => {
      const selected = scheduledDepartures(
        vehicle,
        { earliest: reachMin, latest: reachMax },
        request.now,
      );
      if (!selected) return false;
      const scheduledVehicle = {
        ...vehicle,
        realtime: undefined,
        plannedConnection: undefined,
        scheduledConnection: selected.connection,
        durationSeconds: selected.ride,
        etaPrediction: undefined,
        planningBuffer: { weatherSeconds: 0, calibrationSeconds: 0 },
      };
      append(
        {
          id: `${arc.id}-timetable-wait`,
          mode: 'wait',
          title: '공개 시간표에 맞춰 대기',
          instructions: selected.connection.explanation,
          start: vehicle.start,
          end: vehicle.start,
          distanceMeters: 0,
          durationSeconds: selected.wait,
          planningBuffer: { weatherSeconds: 0, calibrationSeconds: 0 },
          runAllowed: false,
          timetable: vehicle.timetable,
          scheduledConnection: selected.connection,
        },
        scheduledVehicle,
      );
      for (let next = index; next < source.length; next++)
        append(next === index ? scheduledVehicle : source[next]);
      notes.push({
        code: 'unverified-schedule',
        severity: 'info',
        title: '공개 시간표 적용',
        description:
          '해당 운행일의 공개 시간표에서 방향·후속역·하차역 정차를 확인했어요. 실시간 지연이나 결행은 반영되지 않을 수 있어요.',
      });
      return true;
    };
    if (live) {
      if (
        live.status !== 'live' ||
        !fresh(live.receivedAt, request.now) ||
        !fresh(live.observedAt, request.now)
      )
        return null;
      const reach = { earliest: reachMin, latest: reachMax };
      // The listed vehicle is kept whenever the earliest clock catches it; a slower bound that misses every
      // listed vehicle continues on the published timetable or the headway rule. Shared with the app's re-validation.
      const selected = selectLiveBoarding(vehicle, reach, request.now);
      // A slower access that misses the last vehicle has no arrival here; only a point-estimate ranking that still
      // boards it keeps the route (checked on the final estimate below), with the risk stated.
      if (selected?.missesLastService && !estimateObjective) return null;
      // Arrival feeds list only the next one or two vehicles. Missing those means the
      // next train or bus, not no service: continue on the timetable or the usual headway.
      const continued = !selected || !selected.boardsListed;
      if (continued && live.predictions.some((prediction) => prediction.lastService)) return null;
      if (
        continued &&
        (publishedServiceEnded(vehicle, { earliest: reachMin, latest: reachMax }, request.now) ||
          headwayServiceEnded(vehicle, reachMax))
      )
        return null;
      if (continued && appendPublished()) {
        // The published timetable names the exact train every access clock boards.
      } else if (!selected) {
        // An empty list: the usual headway from the stop.
        const seconds = expectedWaitSeconds(vehicle, reachMax);
        append(
          {
            id: `${arc.id}-future-expected-wait`,
            mode: 'wait',
            title: '다음 차량 대기',
            instructions:
              '실시간 도착 예정 차량은 정류장에 닿기 전에 지나가요. 다음 차량까지 평균 배차 간격으로 계산했어요.',
            start: vehicle.start,
            end: vehicle.start,
            distanceMeters: 0,
            durationSeconds: { min: seconds, max: seconds },
            expectedWaitBasisSeconds: seconds,
            runAllowed: false,
          },
          vehicle,
        );
        for (const segment of source.slice(index)) {
          const {
            realtime: _realtime,
            plannedConnection: _connection,
            scheduledConnection: _scheduled,
            ...estimate
          } = segment;
          append(estimate);
        }
        notes.push(
          warning(
            'unverified-schedule',
            '다음 차량은 평균 배차로 계산',
            '실시간 도착 정보에 아직 나오지 않은 다음 차량은 평균 배차 간격으로 계산했어요.',
          ),
        );
      } else {
        // Even when every access clock misses the list, the boarding stays on the shared selector: the next vehicle
        // runs no earlier than one headway after the last listed one, so a slower access never gets an earlier bus.
        const connection: Connection = {
          ...selected.connection,
          explanation: liveBoardingExplanation(
            selected,
            '현재 정류장 도착 예측과 앞 구간의 소요를 함께 계산했어요. 실제 정차·출발 시각은 달라질 수 있어요.',
          ),
        };
        if (selected.missesLastService)
          notes.push({ ...LAST_SERVICE_RISK, segmentId: `${arc.id}-graph-expected-wait` });
        if (!selected.boardsListed)
          notes.push({
            ...(selected.continuation === 'published-departure'
              ? LIVE_MISSED_TIMETABLE_RISK
              : LIVE_MISSED_HEADWAY_RISK),
            segmentId: `${arc.id}-graph-expected-wait`,
          });
        const liveVehicle = {
          ...vehicle,
          plannedConnection: connection,
          scheduledConnection: undefined,
        };
        append(
          {
            id: `${arc.id}-graph-expected-wait`,
            mode: 'wait',
            title: selected.boardsListed ? '정류장 도착 예측에 맞춰 대기' : '다음 차량 대기',
            instructions: connection.explanation,
            start: vehicle.start,
            end: vehicle.start,
            distanceMeters: 0,
            durationSeconds: selected.wait,
            planningBuffer: { weatherSeconds: 0, calibrationSeconds: 0 },
            runAllowed: false,
            realtime: live,
            plannedConnection: connection,
          },
          liveVehicle,
        );
        for (let next = index; next < source.length; next++)
          append(next === index ? liveVehicle : source[next]);
      }
    } else {
      // Dated headway evidence with no running window left: none of the boarding's lines runs again in the horizon.
      if (
        publishedServiceEnded(vehicle, { earliest: reachMin, latest: reachMax }, request.now) ||
        headwayServiceEnded(vehicle, reachMax)
      )
        return null;
      if (!appendPublished()) {
        if (usableTable || !prefix.some((segment) => segment.mode === 'wait')) {
          const seconds = expectedWaitSeconds(vehicle, reachMax);
          append(
            {
              id: `${arc.id}-graph-expected-wait`,
              mode: 'wait',
              title: '평균 배차 대기 추정',
              instructions:
                '실시간 도착편이 없어 평균 배차 대기를 사용해요. 첫차·막차와 실제 탑승 가능 여부를 확인해 주세요.',
              start: vehicle.start,
              end: vehicle.start,
              distanceMeters: 0,
              durationSeconds: { min: seconds, max: seconds },
              expectedWaitBasisSeconds: seconds,
              runAllowed: false,
            },
            vehicle,
          );
        }
        for (const segment of source.slice(index)) append(segment);
        notes.push(
          warning(
            'unverified-schedule',
            '일부 탑승 시각은 추정',
            '실시간 정류장 도착 정보가 없는 구간은 기존 경로의 평균 대기 시간을 적용했어요. 첫차·막차와 다음 차량을 확인해야 해요.',
          ),
        );
      }
    }
  } else for (const segment of source) append(segment);
  if (arc.resource === 'rental') {
    const permission = parts.find((segment) => segment.mode === 'hire')?.rentalValidity;
    if (
      permission &&
      (!fresh(permission.verifiedAt, request.now) ||
        !Number.isFinite(permission.validUntil) ||
        permission.validUntil < permission.verifiedAt ||
        !permission.vehicleId ||
        !permission.provider ||
        request.now + max * 1000 > permission.validUntil)
    )
      return null;
  }
  if (arc.resource === 'car' && options.parkingAt) {
    if (carArrivalSeconds === null) return null;
    const car = parts.find((segment) => segment.mode === 'car')!,
      parking = options.parkingAt(car.end, request.now + carArrivalSeconds * 1000);
    if (!parking?.publicAccess || parking.operating === 'closed' || parking.occupancy === 'full')
      return null;
    parts[parts.indexOf(car)] = { ...car, parkingAccess: parking };
  }
  const timeline = evaluateBaseTimeline(parts, request.now, {
    earliest: request.now + label.min * 1000,
    latest: request.now + label.max * 1000,
  });
  const arrival = timeline?.at(-1);
  if (!arrival) return null;
  const point = estimateBaseTimeline(parts, request.now, request.now + label.estimated * 1000);
  if (estimateObjective && (!point || !Number.isFinite(estimated))) return null;
  return {
    segments: parts,
    min: (arrival.earliest - request.now) / 1000,
    max: (arrival.latest - request.now) / 1000,
    estimated: point
      ? (point.arrivalAt - request.now) / 1000
      : (arrival.latest - request.now) / 1000,
    notes,
    precedingWaitSeconds,
    vehicleCount,
  };
}
const hash = (value: string) => {
  let n = 2166136261;
  for (const character of value) n = Math.imul(n ^ character.charCodeAt(0), 16777619);
  return (n >>> 0).toString(36);
};
function materialize(label: Label, request: BasePlanningRequest, sign: Signer): BaseRoute {
  const segments = label.segments.map((segment, index) => ({
    ...segment,
    id: `graph-${index}-${segment.id}`,
  }));
  const segmentIds = new Map(
    label.segments.map((segment, index) => [segment.id, segments[index].id]),
  );
  const notes = label.notes.map((note) =>
    note.segmentId
      ? { ...note, segmentId: segmentIds.get(note.segmentId) ?? note.segmentId }
      : note,
  );
  const vehicles = segments.filter((segment) =>
    ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter', 'ebike'].includes(segment.mode),
  );
  const names = vehicles.map((segment) =>
    segment.mode === 'bus'
      ? (segment.lineName ?? segment.transit?.lines[0] ?? '버스')
      : segment.mode === 'subway'
        ? (segment.lineName ?? segment.transit?.lines[0] ?? '지하철')
        : {
            taxi: '택시',
            car: '자가용',
            bicycle: '따릉이',
            scooter: '킥보드',
            ebike: '전기자전거',
          }[segment.mode as 'taxi'],
  );
  const costsKnown =
    vehicles.length > 0 &&
    vehicles.every((segment) => segment.mode === 'taxi' && Number.isFinite(segment.costWon));
  return {
    id: `graph-${hash(sign.path(segments))}`,
    title: names.filter((value, index) => value !== names[index - 1]).join(' → ') || '도보',
    segments,
    durationSeconds: { min: label.min, max: label.max },
    distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    transfers: Math.max(0, vehicles.length - 1),
    ...(costsKnown
      ? { fareWon: vehicles.reduce((sum, segment) => sum + segment.costWon!, 0) }
      : {}),
    timingEvaluatedAt: request.now,
    notes: distinctNotes([
      ...notes,
      {
        code: 'missing-source-time',
        severity: 'info',
        title: '조회한 이동망에서 조합 탐색',
        description:
          '실제로 조회한 경로와 같은 환승 지점만 연결해 탐색했어요. 서울 전체의 모든 경로를 조회한 결과는 아니에요. 공개되지 않은 신호·차량 정차 시간은 별도 실시간 관측값으로 가정하지 않았어요.',
      },
    ]),
  };
}

/** h(n): an admissible remaining time over the compiled arcs (see arcLowerBoundSeconds). With a required mode, the second
 * map bounds the rest of a journey that has not used the mode yet, so must still take an arc that uses it. */
function remainingLowerBounds(
  arcs: readonly Arc[],
  destination: string,
  options: JourneyGraphOptions,
): { used: Map<string, number>; unused: Map<string, number> } {
  const mode = options.requiredMode,
    state = (node: string, used: boolean) => (mode ? `${Number(used)}|${node}` : node);
  const incoming = new Map<string, { to: string; seconds: number }[]>();
  const link = (from: string, to: string, seconds: number) => {
    const list = incoming.get(from);
    if (list) list.push({ to, seconds });
    else incoming.set(from, [{ to, seconds }]);
  };
  for (const arc of arcs) {
    const seconds = arcLowerBoundSeconds(arc, options),
      uses = !!mode && arc.segments.some((segment) => segment.mode === mode);
    for (const used of mode ? [false, true] : [true])
      link(state(arc.to, used || uses), state(arc.from, used), seconds);
  }
  const bounds = shortestSeconds([state(destination, true)], incoming);
  if (!mode) return { used: bounds, unused: bounds };
  const layer = (used: boolean) =>
    new Map(
      [...bounds]
        .filter(([key]) => key.startsWith(`${Number(used)}|`))
        .map(([key, seconds]) => [key.slice(2), seconds]),
    );
  return { used: layer(true), unused: layer(false) };
}

/** Time-dependent resource-constrained label search over fetched paths, with no invented network edges. */
export function planJourneyGraph(
  request: BasePlanningRequest,
  sources: readonly BaseRoute[],
  given: JourneyGraphOptions,
): JourneyGraphResult {
  // A pure tab search is a required-mode search over the arcs of that one vehicle.
  let options: JourneyGraphOptions = given.pureMode
    ? { ...given, requiredMode: given.pureMode }
    : given;
  const exact = options.searchMode === 'exact',
    objective = options.objective ?? 'conservative-arrival';
  const costs = options.rankingCosts !== false;
  const elapsed = (label: Label) =>
    objective === 'estimated-arrival' ? label.estimated : label.max;
  // The search ranks by the objective alone: the arrival, never a cost added for a vehicle use.
  const routeElapsed = (route: BaseRoute) =>
    objective === 'estimated-arrival'
      ? ((estimateBaseTimeline(route.segments, request.now)?.arrivalAt ?? Infinity) - request.now) /
        1000
      : route.durationSeconds.max;
  const diagnostics: JourneyGraphDiagnostics = {
    scope: 'bounded-fetched-network',
    searchMode: exact ? 'exact' : 'bounded',
    objective,
    pathDomain: 'no-repeated-transfer-node',
    nodes: 0,
    edges: 0,
    expanded: 0,
    excludedEdges: 0,
    complete: true,
    limitReached: false,
    termination: 'exhausted',
    limitsReached: [],
    omittedLabels: 0,
    bestObjectiveSeconds: null,
    unexploredLowerBoundSeconds: null,
    optimalityGapSeconds: null,
    optimalityProven: false,
    excludedEdgeReasons: {},
    sameRideReboards: 0,
    duplicateRideResults: 0,
    shortRides: 0,
    runsBeforeRuleWaits: 0,
    walkableDetours: 0,
  };
  if (!fresh(options.receivedAt, request.now)) {
    diagnostics.complete = false;
    diagnostics.termination = 'stale-input';
    return { routes: [], diagnostics };
  }
  const maxEdges = exact
      ? Infinity
      : number(options.maxEdges ?? DEFAULT_MAX_EDGES, DEFAULT_MAX_EDGES, 1, 2000),
    maxExpansions = exact
      ? Infinity
      : number(options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS, DEFAULT_MAX_EXPANSIONS, 1, 20000),
    maxResults = number(options.maxResults ?? 6, 6, 1, 18),
    maxLabels = exact ? Infinity : number(options.maxLabelsPerState ?? 12, 12, 1, 100),
    maxLegs =
      exact && options.maxLegs === undefined ? Infinity : number(options.maxLegs ?? 24, 24, 1, 100),
    horizon =
      exact && options.maxJourneySeconds === undefined
        ? Infinity
        : number(
            options.maxJourneySeconds ?? DEFAULT_MAX_JOURNEY_SECONDS,
            DEFAULT_MAX_JOURNEY_SECONDS,
            1,
            86400,
          );
  const limits = new Set<JourneyGraphLimit>();
  let omittedLowerBound = Infinity;
  const sign = signer();
  // The bus envelope predictor is a function of its arguments, and labels that board the same bus at the same clock ask the
  // same question many times over: answer each distinct (segment signature, boarding clock) once per search.
  if (options.publicBusEta) {
    const predict = options.publicBusEta.predict,
      answers = new Map<string, ReturnType<PublicBusPredictor>>();
    options = {
      ...options,
      publicBusEta: {
        predict: (segment, startedAt, requestNow) => {
          const question = `${sign.segment(segment)}|${startedAt}|${requestNow}`;
          if (answers.has(question)) return answers.get(question)!;
          const answer = predict(segment, startedAt, requestNow);
          answers.set(question, answer);
          return answer;
        },
      },
    };
  }
  const compiled = compile(sources, request, maxEdges, options, sign),
    { arcs, excluded, reasons } = compiled;
  diagnostics.edges = arcs.length;
  diagnostics.excludedEdges = excluded;
  diagnostics.excludedEdgeReasons = reasons;
  // Every journey through a cut arc takes at least the cut's lower bound.
  if (compiled.truncated) {
    limits.add('edges');
    omittedLowerBound = compiled.omittedLowerBound;
  }
  const outgoing = new Map<string, Arc[]>(),
    incoming = new Map<string, string[]>(),
    nodes = new Set<string>();
  for (const arc of arcs) {
    nodes.add(arc.from);
    nodes.add(arc.to);
    const leaving = outgoing.get(arc.from),
      entering = incoming.get(arc.to);
    if (leaving) leaving.push(arc);
    else outgoing.set(arc.from, [arc]);
    if (entering) entering.push(arc.from);
    else incoming.set(arc.to, [arc.from]);
  }
  diagnostics.nodes = nodes.size;
  const origin = key(request.origin),
    destination = key(request.destination);
  const remaining = remainingLowerBounds(arcs, destination, options),
    arcSeconds = new Map(arcs.map((arc) => [arc, arcLowerBoundSeconds(arc, options)]));
  // Lowest bound among continuations not made because they could not beat the result bound (see below).
  let cutLowerBound = Infinity;
  const remainingAfter = (node: string, used: boolean) =>
    (used ? remaining.used : remaining.unused).get(node) ?? Infinity;
  const lowerBound = (label: Label) =>
    elapsed(label) + remainingAfter(label.node, label.requiredModeUsed || !options.requiredMode);
  const omit = (label: Label, reason: JourneyGraphLimit) => {
    limits.add(reason);
    diagnostics.omittedLabels++;
    omittedLowerBound = Math.min(omittedLowerBound, lowerBound(label));
  };
  // A missing directed path in the compiled network is conclusive. No geographic
  // distance, assumed speed or time estimate is used to discard a branch.
  const reachesDestination = new Set([destination]),
    reverseQueue = [destination];
  for (let index = 0; index < reverseQueue.length; index++)
    for (const from of incoming.get(reverseQueue[index]) ?? []) {
      if (!reachesDestination.has(from)) {
        reachesDestination.add(from);
        reverseQueue.push(from);
      }
    }
  // The walk a short ride is compared with must be in the fetched network: a street point reached from another over walking
  // arcs alone. Where no source returned that walk, the ride is the only way and is kept. Running arcs stay out: the
  // running cap is spent along the whole route, so a run in place of the ride may not be one the rider has left.
  const footArcs = new Map<string, { to: string; seconds: number }[]>();
  for (const arc of arcs)
    if (
      arc.resource === null &&
      !arc.gate &&
      !arc.from.startsWith(PAID) &&
      !arc.to.startsWith(PAID) &&
      arc.segments.length &&
      arc.segments.every((segment) => segment.mode === 'walk')
    ) {
      const seconds = arc.segments.reduce(
        (sum, segment) =>
          sum +
          (objective === 'estimated-arrival'
            ? (estimatedSegmentSeconds(segment, request.now) ?? segment.durationSeconds.max)
            : segment.durationSeconds.max),
        0,
      );
      const list = footArcs.get(arc.from);
      if (list) list.push({ to: arc.to, seconds });
      else footArcs.set(arc.from, [{ to: arc.to, seconds }]);
    }
  const onFoot = new Map<string, Map<string, number>>();
  /** The fewest seconds from one street point to another over walking arcs alone; null where no source walked it. */
  const walkSeconds = (from: string, to: string) => {
    let reached = onFoot.get(from);
    if (!reached) {
      reached = shortestSeconds([from], footArcs);
      onFoot.set(from, reached);
    }
    return reached.get(to) ?? null;
  };
  // Walking dominance (ranking rule): the fewest seconds from the origin to each point over walks and station entries, and from
  // each point to the destination over walks and station exits. A run, a ride or a rental never counts as walking.
  const walkingArcs = arcs.filter(
    (arc) =>
      arc.resource === null &&
      arc.segments.length > 0 &&
      arc.segments.every((segment) => ['walk', 'entry', 'wait'].includes(segment.mode)),
  );
  const walkedFrom = (forward: boolean) => {
    const edges = new Map<string, { to: string; seconds: number }[]>();
    for (const arc of walkingArcs) {
      // Leaving the paid area needs a ride first; entering it on the way to the destination is no walk there.
      if (arc.gate && (forward ? arc.from.startsWith(PAID) : arc.to.startsWith(PAID))) continue;
      const seconds = arc.segments.reduce(
        (sum, segment) =>
          sum +
          (objective === 'estimated-arrival'
            ? (estimatedSegmentSeconds(segment, request.now) ?? segment.durationSeconds.max)
            : segment.durationSeconds.max),
        0,
      );
      if (!Number.isFinite(seconds)) continue;
      const [from, to] = forward ? [arc.from, arc.to] : [arc.to, arc.from];
      const list = edges.get(from);
      if (list) list.push({ to, seconds });
      else edges.set(from, [{ to, seconds }]);
    }
    return shortestSeconds([forward ? origin : destination], edges);
  };
  const walkedFromOrigin = costs ? walkedFrom(true) : new Map<string, number>(),
    walkedToDestination = costs ? walkedFrom(false) : new Map<string, number>();
  const requiredMode = options.requiredMode;
  // Node numbers and arcs toward the destination only, for the per-label reachability check below.
  const nodeNumber = new Map([...reachesDestination].map((node, index) => [node, index]));
  const forward = [...reachesDestination].map((node) =>
    (outgoing.get(node) ?? [])
      .filter((arc) => reachesDestination.has(arc.to))
      .map((arc) => ({
        to: nodeNumber.get(arc.to)!,
        uses: !!requiredMode && arc.segments.some((segment) => segment.mode === requiredMode),
      })),
  );
  const destinationNumber = nodeNumber.get(destination)!,
    blocked = new Int32Array(nodeNumber.size),
    seenAt = new Int32Array(2 * nodeNumber.size);
  let query = 0;
  const canReachRequiredMode = (start: string, visited: ReadonlySet<string>): boolean => {
    if (!requiredMode) return true;
    if (start === destination || !reachesDestination.has(start)) return false;
    // Ignore time, eligibility and future visited nodes here. This is an
    // over-approximation over actual directed arcs: only a missing structural
    // completion may discard a history before it occupies the bounded frontier.
    query++;
    for (const node of visited) {
      const number = nodeNumber.get(node);
      if (number !== undefined) blocked[number] = query;
    }
    const first = nodeNumber.get(start)!,
      pending = [first * 2];
    seenAt[first * 2] = query;
    for (let index = 0; index < pending.length; index++) {
      const node = pending[index] >> 1,
        used = (pending[index] & 1) === 1;
      for (const arc of forward[node]) {
        if (blocked[arc.to] === query) continue;
        const next = used || arc.uses;
        if (arc.to === destinationNumber) {
          if (next) return true;
          continue;
        }
        const state = arc.to * 2 + Number(next);
        if (seenAt[state] !== query) {
          seenAt[state] = query;
          pending.push(state);
        }
      }
    }
    return false;
  };
  const initial: Label = {
    node: origin,
    min: 0,
    max: 0,
    estimated: 0,
    segments: [],
    arcs: [],
    visited: new Set([origin]),
    rentals: 0,
    warnings: 0,
    carUsed: false,
    requiredModeUsed: false,
    bicycleMeters: 0,
    runningMeters: 0,
    precedingWaitSeconds: 0,
    vehicleCount: 0,
    notes: [],
    uses: 0,
    homeBy: Infinity,
  };
  const frontier = new Map<string, Label[]>();
  const routes: BaseRoute[] = [];
  const completedPaths = new Set<string>();
  const accepted = new Set<BaseRoute>();
  let completed = 0;
  const scores = new Map<BaseRoute, number>();
  const rideOf = new Map<BaseRoute, string>();
  // Keep complete-arrival ties open through the bound check below. Access speed
  // and queue heuristics cannot decide which equal-arrival itinerary fills top-k.
  // After arrival and effort ties, the variant that reaches its boardings sooner and walks less goes first, never a hash.
  const access = boardingAccessComparator(request.now, objective);
  const compareRoutes = (a: BaseRoute, b: BaseRoute) =>
    Number(accepted.has(b)) - Number(accepted.has(a)) ||
    (scores.get(a) ?? routeElapsed(a)) - (scores.get(b) ?? routeElapsed(b)) ||
    a.durationSeconds.max - b.durationSeconds.max ||
    a.durationSeconds.min - b.durationSeconds.min ||
    compareRouteEffort(a, b) ||
    access(a, b) ||
    a.id.localeCompare(b.id);
  // Equal-estimate variants of one ride: keep the one resting on observed or published departures, then the least effort,
  // then the one that reaches every boarding sooner and walks less (a walk to a stop and back loses to the direct walk).
  const observed = (route: BaseRoute) =>
    route.segments.filter(
      (segment) =>
        !!segment.realtime || !!segment.plannedConnection || !!segment.scheduledConnection,
    ).length;
  const compareTwins = (a: BaseRoute, b: BaseRoute) =>
    (scores.get(a) ?? routeElapsed(a)) - (scores.get(b) ?? routeElapsed(b)) ||
    a.durationSeconds.max - b.durationSeconds.max ||
    a.durationSeconds.min - b.durationSeconds.min ||
    observed(b) - observed(a) ||
    compareRouteEffort(a, b) ||
    access(a, b) ||
    a.id.localeCompare(b.id);
  const priority = (a: Label, b: Label) =>
    lowerBound(a) - lowerBound(b) ||
    elapsed(a) - elapsed(b) ||
    a.max - b.max ||
    a.min - b.min ||
    a.warnings - b.warnings ||
    a.bicycleMeters - b.bicycleMeters ||
    a.runningMeters - b.runningMeters ||
    a.segments.length - b.segments.length;
  // Stable ties preserve the prior sort's expansion order, including when a
  // computation budget ends before every equal-arrival alternative is examined.
  const queue = new MinPriorityQueue<Label>(priority);
  if (canReachRequiredMode(origin, initial.visited)) queue.push(initial);
  const resultBound = () =>
    accepted.size < maxResults
      ? Infinity
      : (scores.get(
          routes.filter((route) => accepted.has(route)).sort(compareRoutes)[maxResults - 1],
        ) ?? Infinity);
  while (queue.size && diagnostics.expanded < maxExpansions) {
    const label = queue.peek()!;
    if (label.discarded) {
      queue.pop();
      continue;
    }
    // The complete-route correction is nonnegative. Physical elapsed time is
    // therefore a lower bound, while every actual boarding still uses its clock.
    const bound = resultBound();
    if (lowerBound(label) > bound) {
      diagnostics.termination = 'result-bound';
      break;
    }
    queue.pop();
    diagnostics.expanded++;
    if (label.node === destination && label.segments.length) {
      // Other modes neither fill the reserved slot nor count as omitted rental alternatives.
      if (options.requiredMode && !label.requiredModeUsed) continue;
      const signature = sign.labelPath(label);
      if (
        !completedPaths.has(signature) &&
        validLiveVehicles(label.segments, request.preferences, request.origin, request.now)
      ) {
        completedPaths.add(signature);
        completed++;
        const route = materialize(label, request, sign),
          usable = !options.acceptRoute || options.acceptRoute(route);
        if (usable) {
          const predicted = options.scoreCompleteRoute?.(route);
          const baseline = elapsed(label);
          scores.set(
            route,
            Number.isFinite(predicted) && predicted! >= baseline ? predicted! : baseline,
          );
          accepted.add(route);
          routes.push(route);
          // One slot per distinct ride: walk, wait and access variants of the same boardings compete, not fill the list.
          const ride = rideKey(route.segments);
          rideOf.set(route, ride);
          const twin =
            options.distinctRides === false
              ? undefined
              : [...accepted].find((other) => other !== route && rideOf.get(other) === ride);
          if (twin) {
            completed--;
            diagnostics.duplicateRideResults++;
            const worse = compareTwins(route, twin) < 0 ? twin : route;
            accepted.delete(worse);
            routes.splice(routes.indexOf(worse), 1);
            scores.delete(worse);
          } else if (accepted.size > maxResults) {
            const worst = routes
              .filter((candidate) => accepted.has(candidate))
              .sort(compareRoutes)
              .at(-1)!;
            accepted.delete(worst);
            routes.splice(routes.indexOf(worst), 1);
            scores.delete(worst);
          }
        } else if (routes.filter((candidate) => !accepted.has(candidate)).length < maxResults)
          routes.push(route);
      }
      continue;
    }
    const lastRide = lastRideSegment(label.segments);
    for (const arc of outgoing.get(label.node) ?? []) {
      if (
        !reachesDestination.has(arc.to) ||
        label.visited.has(arc.to) ||
        arc.from === arc.to ||
        (arc.resource === 'car' && label.carUsed)
      )
        continue;
      // Two itineraries that alight and board the same line in the same direction at one station are one ride split in two, not a transfer.
      // Consecutive vehicles of one provider itinerary keep the provider's own change of trains (1호선 at 구로, 5호선 at 강동).
      const nextRide = lastRide && firstRideSegment(arc.segments);
      if (
        lastRide &&
        nextRide &&
        !sharesItinerary(label.rideSources, arc.itineraries) &&
        continuesRide(lastRide, nextRide)
      ) {
        diagnostics.sameRideReboards++;
        continue;
      }
      // A second rental or a boarding after a taxi is neither refused nor priced: it wins exactly when it arrives sooner.
      const ride = firstRideSegment(arc.segments);
      // Returning a bike and hiring another without riding transit in between is one rental cut in two.
      if (
        arc.resource === 'rental' &&
        label.rentals &&
        !label.segments
          .slice(label.segments.findLastIndex((segment) => segment.mode === 'return') + 1)
          .some((segment) => ['bus', 'subway', 'taxi', 'car'].includes(segment.mode))
      )
        continue;
      if (!arcAllowed(arc, request)) continue;
      const vehicleArc =
        arc.resource !== null ||
        arc.segments.some((segment) => VEHICLE_MODES.includes(segment.mode));
      // The vehicles so far brought the rider here later than walking from the origin would have: walk here instead.
      if (costs && vehicleArc && label.uses) {
        const walked = walkedFromOrigin.get(label.node);
        if (walked !== undefined && elapsed(label) > walked + WALK_DOMINANCE_SLACK_SECONDS) {
          diagnostics.walkableDetours++;
          continue;
        }
      }
      // A new vehicle use (a continued ride is not one); the walk-dominance checks start after the first.
      const newUse = !!ride && !(lastRide && continuesRide(lastRide, ride));
      // The result bound only falls, and the loop stops before a label above it. A continuation already above it, even by the
      // arc's own lower bound, is never expanded or completed: skip timing it. Its bound still counts as unexplored.
      const ahead =
        elapsed(label) +
        arcSeconds.get(arc)! +
        remainingAfter(
          arc.to,
          label.requiredModeUsed ||
            !options.requiredMode ||
            arc.segments.some((segment) => segment.mode === options.requiredMode),
        );
      if (ahead > bound) {
        cutLowerBound = Math.min(cutLowerBound, ahead);
        continue;
      }
      const evaluated = evaluate(arc, label, request, options);
      if (!evaluated) continue;
      // A run pays only toward a boarding timed by a live arrival or a published departure. An average headway or a taxi
      // dispatch starts counting when the rider arrives, so running there only moves the wait earlier.
      if (costs && label.trailingRun && ride && ruleWaitBoarding(evaluated.segments)) {
        diagnostics.runsBeforeRuleWaits++;
        continue;
      }
      const moved = arc.segments.reduce(
          (sum, segment) => sum + (segment.mode === 'wait' ? 0 : segment.distanceMeters),
          0,
        ),
        transitRides = arc.segments.filter(transit).length;
      const run = !ride && !arc.gate && arc.segments.some((segment) => segment.mode === 'run');
      const trailingRun = run
        ? {
            ...(label.trailingRun ?? {
              from: arc.segments[0].start,
              estimated: label.estimated,
              max: label.max,
              meters: 0,
              rides: 0,
            }),
            meters: (label.trailingRun?.meters ?? 0) + moved,
          }
        : arc.gate
          ? label.trailingRun
          : undefined;
      // The street stretch a bus or train (with its gates and in-station walks) covers, from the street point left on
      // foot (or the start of the run that reached it) to the street point reached again.
      let riding =
        label.riding ??
        (!arc.from.startsWith(PAID) && arc.resource === null && (arc.gate || transitRides)
          ? (label.trailingRun ?? {
              from: arc.segments[0].start,
              estimated: label.estimated,
              max: label.max,
              meters: 0,
              rides: 0,
            })
          : undefined);
      if (riding)
        riding = { ...riding, meters: riding.meters + moved, rides: riding.rides + transitRides };
      if (riding && !arc.to.startsWith(PAID)) {
        const seconds =
          Number.isFinite(evaluated.estimated) && Number.isFinite(riding.estimated)
            ? evaluated.estimated - riding.estimated
            : evaluated.max - riding.max;
        const onFootSeconds = costs && riding.rides ? walkSeconds(key(riding.from), arc.to) : null;
        if (
          onFootSeconds !== null &&
          hopSavingSeconds(riding.from, arc.segments.at(-1)!.end, onFootSeconds, seconds) <
            MIN_RIDE_SAVING_SECONDS
        ) {
          diagnostics.shortRides++;
          continue;
        }
        riding = undefined;
      }
      const next: Label = {
        ...label,
        node: arc.to,
        min: evaluated.min,
        max: evaluated.max,
        estimated: evaluated.estimated,
        precedingWaitSeconds: evaluated.precedingWaitSeconds,
        vehicleCount: evaluated.vehicleCount,
        segments: [...label.segments, ...evaluated.segments],
        arcs: [...label.arcs, arc.id],
        rideSources: firstRideSegment(arc.segments) ? arc.itineraries : label.rideSources,
        visited: new Set([...label.visited, arc.to]),
        rentals: label.rentals + Number(arc.resource === 'rental'),
        carUsed: label.carUsed || arc.resource === 'car',
        requiredModeUsed:
          label.requiredModeUsed ||
          (!!options.requiredMode &&
            arc.segments.some((segment) => segment.mode === options.requiredMode)),
        bicycleMeters:
          label.bicycleMeters +
          arc.segments
            .filter((segment) => segment.mode === 'bicycle')
            .reduce((n, s) => n + s.distanceMeters, 0),
        runningMeters:
          label.runningMeters +
          arc.segments
            .filter((segment) => segment.mode === 'run')
            .reduce((n, s) => n + s.distanceMeters, 0),
        notes: [...label.notes, ...evaluated.notes],
        warnings:
          label.warnings + evaluated.notes.filter((note) => note.severity === 'warning').length,
        uses: label.uses + Number(newUse),
        trailingRun,
        riding,
        homeBy: label.homeBy,
      };
      // A vehicle onward cannot beat walking to the destination from a point already reached: walk from there instead.
      if (costs && vehicleArc && lowerBound(next) > label.homeBy + WALK_DOMINANCE_SLACK_SECONDS) {
        diagnostics.walkableDetours++;
        continue;
      }
      const home = next.uses ? walkedToDestination.get(next.node) : undefined;
      if (home !== undefined) next.homeBy = Math.min(next.homeBy, elapsed(next) + home);
      if (
        next.bicycleMeters > request.preferences.maxBicycleMeters ||
        next.runningMeters > request.preferences.maxRunningMeters
      )
        continue;
      if (next.max > horizon) {
        omit(next, 'duration');
        continue;
      }
      if (next.segments.length > maxLegs) {
        omit(next, 'legs');
        continue;
      }
      if (!next.requiredModeUsed && !canReachRequiredMode(next.node, next.visited)) continue;
      if (lowerBound(next) > bound) {
        cutLowerBound = Math.min(cutLowerBound, lowerBound(next));
        continue;
      }
      // Completed itineraries retain their distinct line/permission/price evidence for final ranking.
      if (next.node === destination) {
        queue.push(next);
        continue;
      }
      // A faster prefix can use up a resource or reach a different departure window.
      // Apply the per-state cap only to interchangeable continuation states. The
      // global expansion cap still bounds production work across distinct states.
      const state = `${continuationState(next)}|${sign.evidence(next)}${options.scoreCompleteRoute || options.acceptRoute ? `|${sign.labelPath(next)}` : ''}`;
      const previous = frontier.get(state) ?? [];
      const dominates = (a: Label, b: Label) =>
        a.min === b.min &&
        a.max === b.max &&
        a.estimated === b.estimated &&
        a.precedingWaitSeconds === b.precedingWaitSeconds &&
        a.vehicleCount === b.vehicleCount &&
        a.bicycleMeters <= b.bicycleMeters &&
        a.runningMeters <= b.runningMeters &&
        a.segments.length <= b.segments.length &&
        [...a.visited].every((node) => b.visited.has(node)) &&
        sign.evidence(a) === sign.evidence(b) &&
        containsAll(a.rideSources, b.rideSources) &&
        (!(exact || options.scoreCompleteRoute || options.acceptRoute) ||
          sign.labelPath(a) === sign.labelPath(b));
      if (next.node !== destination && previous.some((old) => dominates(old, next))) continue;
      const kept = previous.filter((old) => !dominates(next, old));
      for (const old of previous) if (!kept.includes(old)) old.discarded = true;
      if (kept.length >= maxLabels) {
        kept.sort(priority);
        const worst = kept.at(-1)!;
        if (priority(next, worst) >= 0) {
          omit(next, 'labels');
          continue;
        }
        omit(worst, 'labels');
        worst.discarded = true;
        kept.pop();
      }
      kept.push(next);
      frontier.set(state, kept);
      queue.push(next);
    }
  }
  // The primary priority is the admissible lower bound. Remove stale roots so
  // neither a discarded history nor a full frontier scan changes the certificate.
  while (queue.peek()?.discarded) queue.pop();
  const pending = queue.peek(),
    pendingLowerBound = Math.min(pending ? lowerBound(pending) : Infinity, cutLowerBound);
  // Continuations cut by the result bound end the search the way the bound would have ended it with them queued.
  if (diagnostics.termination === 'exhausted' && cutLowerBound < Infinity)
    diagnostics.termination = 'result-bound';
  if (pendingLowerBound < Infinity && diagnostics.expanded >= maxExpansions) {
    if (pendingLowerBound > resultBound()) diagnostics.termination = 'result-bound';
    else {
      limits.add('expansions');
      diagnostics.termination = 'expansion-limit';
    }
  }
  if (!options.scoreCompleteRoute && options.acceptRoute && completed > maxResults)
    limits.add('comparison-results');
  diagnostics.limitsReached = [...limits];
  diagnostics.limitReached = limits.size > 0;
  diagnostics.complete = !diagnostics.limitReached;
  const best = routes.filter((route) => accepted.has(route)).sort(compareRoutes)[0];
  diagnostics.bestObjectiveSeconds = best ? scores.get(best)! : null;
  const unexplored = Math.min(omittedLowerBound, pendingLowerBound);
  diagnostics.unexploredLowerBoundSeconds = Number.isFinite(unexplored) ? unexplored : null;
  diagnostics.optimalityGapSeconds = best ? Math.max(0, scores.get(best)! - unexplored) : null;
  diagnostics.optimalityProven = best ? unexplored >= scores.get(best)! : unexplored === Infinity;
  return { routes: routes.sort(compareRoutes).slice(0, maxResults), diagnostics };
}
