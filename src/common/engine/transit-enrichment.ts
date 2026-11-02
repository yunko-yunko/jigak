import { expectedWaitSeconds } from '../shared/domain/waitEstimates.js';
import type { BaseRoute, BaseSegment, HeadwayEvidence, Place } from '../shared/domain/index.js';
import { busHeadwayEvidence } from './realtime/headway-evidence.js';
import { ApiError } from './errors.js';
import type { CallBudget } from './call-budget.js';
import { busLabel, type RouteEndpoints, type RouteProvider } from './kakao.js';
import {
  isNightOnlyLine,
  isNightServiceHour,
  metersBetween,
  stationBaseName,
} from './realtime/names.js';
import type { BoardingQuery, RealtimeService } from './realtime/service.js';
import { boardingObservationIsFresh } from '../shared/journey/realtimeFreshness.js';
import { bestWalkingSegment, type MultimodalContext } from './multimodal.js';
import {
  routeQueryIsCached,
  routeQueryIsFree,
  routeQueryIsReusable,
} from './connectivity/query-reuse.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming } from './acquisition-priority.js';
import { stationAccessSeconds } from './connectivity/station-access.js';
import {
  bundledStationExits,
  chooseStationExit,
  exitPassage,
  PASSAGE_ASSUMPTIONS,
  STATION_EXITS_VERSION,
  stationExitsFor,
  type StationExitChoice,
  type StationExitTable,
} from './connectivity/station-exits.js';

/** Below this the rider is already at the stop; no access walk is added. */
// A nearby stop still needs a fetched foot edge; proximity never creates a graph link.
const ACCESS_THRESHOLD_METERS = 0.1;
/** Distinct stops (not line bundles) observed per pass; every line bundle at an observed stop shares its sheet. */
const MAX_REALTIME_STOPS = 16;
/** Seoul subway and bus feeds answer in about 0.1 s; only the national TAGO fallback takes 1-4 s. */
const REALTIME_WAIT_MS = 600;
const EXISTING_WALK_REVIEW_SECONDS = 600;

export interface EnrichmentContext {
  provider: RouteProvider;
  budget: CallBudget;
  realtime?: RealtimeService;
  /** How long routes wait for live arrivals before using the estimated wait (default 0.6 s). */
  realtimeWaitMs?: number;
  now: number;
  acquisitionObjective?: RoutingObjective;
  onWalkingAlternatives?: MultimodalContext['onWalkingAlternatives'];
  /** Reserve the rest of the shared budget for bridges between transport modes. */
  maxAccessCalls?: number;
  /** The same bound while walks come from a self-hosted network: they spend no budget, so only this keeps one search's latency in check. */
  maxUnmeteredAccessCalls?: number;
  /** Belongs to one search; attempted walks are shared by both endpoint coordinates across passes and transit fragments. */
  accessCache?: TransitAccessCache;
  /** Belongs to one search; bus headway evidence by boarding stop, lines and direction, shared by every pass and fragment. */
  headwayBook?: HeadwayBook;
  /** Belongs to one search; the distinct bus stops it may observe live across every pass. Unset keeps only the pass cap. */
  busStopAllowance?: BusStopAllowance;
  /** Candidate ordering only; a priority estimate never becomes a route duration or edge. */
  accessPriority?: (route: BaseRoute) => number;
  /** After the priority winner, verify the best source containing its missing bus/subway mode. */
  accessModeCoverage?: boolean;
  /** Complete two source-ranked direct bus boarding families before speculative rental access. */
  baselineDirectBusCoverage?: boolean;
  /** Reports an actual capped fallback, never an ordinary provider failure or cache hit. */
  onAccessLimited?: (reason: 'access-cap' | 'route-budget') => void;
  /** Subway exits (default: the bundled subway-exits-v1 table); null keeps every walk on the platform point. */
  stationExits?: StationExitTable | null;
}

const isVehicle = (segment: BaseSegment) => segment.mode === 'bus' || segment.mode === 'subway';
const isAllowance = (segment: BaseSegment) =>
  segment.mode === 'wait' && segment.id.endsWith('-provider-extra');
export const EXPECTED_WAIT_SUFFIX = '-expected-wait';

/**
 * Average wait (half the usual headway) when no live arrival is known.
 * Seoul subway runs every 2–5 min at peak and up to 10 min late; city buses 8–15 min.
 * Several listed bus routes at one stop shorten the wait for "whichever comes first".
 */
export { expectedWaitSeconds } from '../shared/domain/waitEstimates.js';
// Match graph anchor precision; metre-level rounding can reuse the wrong stop's
// terminal point and leave a valid alternative disconnected.
const pointKey = (point: { latitude: number; longitude: number }) =>
  `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
const sumSeconds = (segments: BaseSegment[], edge: 'min' | 'max' = 'min') =>
  segments.reduce((sum, segment) => sum + segment.durationSeconds[edge], 0);

const isFoot = (segment: BaseSegment | undefined) =>
  segment?.mode === 'walk' || segment?.mode === 'run';
const firstStop = (segment: BaseSegment) => segment.transit?.stops[0] ?? segment.start.name;
const lastStop = (segment: BaseSegment) => segment.transit?.stops.at(-1) ?? segment.end.name;
/** Index of the nearest segment before (step -1) or after (step 1) `index` that is not a boarding wait. */
const physicalNeighbour = (segments: readonly BaseSegment[], index: number, step: -1 | 1) => {
  let next = index + step;
  while (segments[next]?.mode === 'wait') next += step;
  return next;
};
/** The ride continues inside the paid area: straight onto another train, or a foot transfer between two trains at one
 * station (the provider's transfer walk and the official transfer reference already run platform to platform). */
function staysInStation(
  segments: readonly BaseSegment[],
  rideIndex: number,
  step: -1 | 1,
): boolean {
  const ride = segments[rideIndex],
    neighbourIndex = physicalNeighbour(segments, rideIndex, step),
    neighbour = segments[neighbourIndex];
  if (neighbour?.mode === 'subway') return true;
  if (!isFoot(neighbour)) return false;
  const other = segments[physicalNeighbour(segments, neighbourIndex, step)];
  if (other?.mode !== 'subway') return false;
  return step < 0
    ? sameStation(lastStop(other), firstStop(ride))
    : sameStation(lastStop(ride), firstStop(other));
}
/** A station's names: its base name and any station name the provider gives in parentheses ("총신대입구(이수)" is 이수 on 7호선). */
const stationNames = (name: string) => [
  stationBaseName(name),
  ...[...name.normalize('NFC').matchAll(/\(([^)]*)\)/g)]
    .map((match) => stationBaseName(match[1]))
    .filter((alias) => alias.length >= 2 && !/(호선|선|방면)$/.test(alias)),
];
const sameStation = (a: string, b: string) => {
  const names = stationNames(b);
  return stationNames(a).some((name) => names.includes(name));
};

/** The sidewalk point of a chosen exit, as a place on the ride's station end; the street walk starts or ends exactly here. */
export function stationExitStreet(
  ride: BaseSegment,
  kind: 'entry' | 'exit',
  exit: StationExitChoice,
): Place {
  const point = kind === 'entry' ? ride.start : ride.end,
    stop = kind === 'entry' ? firstStop(ride) : lastStop(ride);
  return {
    ...point,
    name: exit.exit.ref ? `${stationBaseName(stop)}역 ${exit.exit.ref}번 출구` : point.name,
    latitude: exit.exit.street.latitude,
    longitude: exit.exit.street.longitude,
  };
}

/** The gate passage at one end of a train ride: 'entry' (gate to platform, before boarding) or 'exit' (platform to gate,
 * after alighting). Both are 'entry' steps. Without a chosen exit the step sits on the ride's station point; with one it
 * runs from the platform point through the exit to the exit's sidewalk point (reversed for entry). */
export function stationAccessStep(
  ride: BaseSegment,
  kind: 'entry' | 'exit',
  id: string,
  now: number,
  exit?: StationExitChoice | null,
): BaseSegment {
  const line = ride.transit?.lines[0] ?? ride.lineName ?? '',
    stop = kind === 'entry' ? firstStop(ride) : lastStop(ride),
    point = kind === 'entry' ? ride.start : ride.end;
  if (exit) {
    const street = stationExitStreet(ride, kind, exit),
      { ref } = exit.exit,
      name = stationBaseName(stop),
      leaving = kind === 'exit';
    const path = [point, exit.exit, street].map(({ latitude, longitude }) => ({
      latitude,
      longitude,
    }));
    const low = Math.round(exit.passageSeconds * PASSAGE_ASSUMPTIONS.lowFactor),
      high = Math.round(exit.passageSeconds * PASSAGE_ASSUMPTIONS.highFactor);
    return {
      id,
      mode: 'entry',
      title: !ref
        ? `${name}역 ${leaving ? '출구까지' : '승강장까지'}`
        : `${name}역 ${ref}번 출구로 ${leaving ? '나가기' : '들어가기'}`,
      instructions: !ref
        ? leaving
          ? '승강장에서 개찰구를 지나 역을 나가는 시간이에요.'
          : '개찰구를 지나 승강장까지 걷는 시간이에요.'
        : leaving
          ? `개찰구를 지나 ${ref}번 출구로 나가요.`
          : `${ref}번 출구로 들어가 개찰구를 지나요.`,
      distanceMeters: exit.passageMeters + Math.round(metersBetween(exit.exit, street)),
      durationSeconds: { min: exit.platformSeconds + low, max: exit.platformSeconds + high },
      start: leaving ? point : street,
      end: leaving ? street : point,
      polyline: leaving ? path : path.reverse(),
      runAllowed: false,
      stationExit: {
        ref,
        kind: exit.kind,
        latitude: exit.exit.latitude,
        longitude: exit.exit.longitude,
        street: { ...exit.exit.street },
        platformSeconds: exit.platformSeconds,
        passageSeconds: exit.passageSeconds,
        passageMeters: exit.passageMeters,
        platformBasis: exit.platformBasis,
        passageBasis: 'assumed',
        dataset: STATION_EXITS_VERSION,
      },
    };
  }
  const seconds = stationAccessSeconds(stop, line, kind, now).seconds;
  return {
    id,
    mode: 'entry',
    title:
      kind === 'entry'
        ? `${stationBaseName(stop)}역 승강장까지`
        : `${stationBaseName(stop)}역 출구까지`,
    instructions:
      kind === 'entry'
        ? '개찰구를 지나 승강장까지 걷는 시간이에요.'
        : '승강장에서 개찰구를 지나 역을 나가는 시간이에요.',
    distanceMeters: 0,
    durationSeconds: { min: seconds, max: seconds },
    start: point,
    end: point,
    runAllowed: false,
  };
}

/** The street walk between an exit's sidewalk point and the station point a graph connection starts or ends at: the same
 * 1.25 street detour at 1.2 m/s as an estimated walk (가정값). */
const GATE_STREET_DETOUR = 1.25,
  GATE_STREET_METERS_PER_SECOND = 1.2;

/**
 * The gate step the journey graph adds where a connection leaves or joins a train at the station's map point (a bridge or a
 * fragment that starts or ends there instead of at an exit). It goes through the exit nearest that point by passage and street
 * walk (bundled subway-exits-v1 table), so the step names the exit and counts the platform, the passage and the street walk
 * from the exit's sidewalk point to the station point where the connection continues. The step stays on that station point
 * at both ends, as the connection does; without exit data it is the plain platform step.
 */
export function stationGateStep(
  ride: BaseSegment,
  kind: 'entry' | 'exit',
  id: string,
  now: number,
  source: StationExitTable | null = bundledStationExits(),
): BaseSegment {
  const point = kind === 'entry' ? ride.start : ride.end,
    stop = kind === 'entry' ? firstStop(ride) : lastStop(ride);
  const found = stationExitsFor(stop, point, source);
  if (!found) return stationAccessStep(ride, kind, id, now);
  const streetSeconds = (exit: { street: { latitude: number; longitude: number } }) =>
    (metersBetween(exit.street, point) * GATE_STREET_DETOUR) / GATE_STREET_METERS_PER_SECOND;
  const exit = found.exits
    .map((candidate) => ({
      candidate,
      seconds: exitPassage(point, candidate).seconds + streetSeconds(candidate),
    }))
    .sort(
      (a, b) => a.seconds - b.seconds || a.candidate.id.localeCompare(b.candidate.id),
    )[0].candidate;
  const platform = stationAccessSeconds(
      stop,
      ride.transit?.lines[0] ?? ride.lineName ?? '',
      kind,
      now,
    ),
    passage = exitPassage(point, exit);
  const step = stationAccessStep(ride, kind, id, now, {
    station: found.station,
    exit,
    kind: kind === 'exit' ? 'exit' : 'entrance',
    platformSeconds: platform.seconds,
    platformBasis: platform.source,
    passageSeconds: passage.seconds,
    passageMeters: passage.meters,
    walkSeconds: null,
  });
  const meters = Math.round(metersBetween(exit.street, point) * GATE_STREET_DETOUR),
    seconds = Math.ceil(meters / GATE_STREET_METERS_PER_SECOND);
  return {
    ...step,
    start: point,
    end: point,
    distanceMeters: step.distanceMeters + meters,
    durationSeconds: {
      min: step.durationSeconds.min + seconds,
      max: step.durationSeconds.max + seconds,
    },
  };
}

/**
 * Gate-to-platform time before the first boarding of each run of trains, and platform-to-gate time after its last
 * alighting. The access walk ends at the station's map point, so these never overlap the routed street walk; in-station
 * transfers get neither. Entry goes before the boarding waits, so live and published trains are chosen from the clock
 * at which the rider reaches the platform. With `gateExits`, a station end that `exitFor` leaves open (the itinerary starts or
 * ends at the station point itself, as an intermediate hub's fragments do, or meets another vehicle there) passes the nearest
 * exit of that table (stationGateStep) instead of the unnamed platform step.
 */
export function insertStationAccess(
  segments: readonly BaseSegment[],
  routeId: string,
  now: number,
  exitFor?: (ride: BaseSegment, kind: 'entry' | 'exit') => StationExitChoice | null | undefined,
  gateExits?: StationExitTable | null,
): BaseSegment[] {
  const step = (ride: BaseSegment, kind: 'entry' | 'exit', id: string) => {
    const chosen = exitFor?.(ride, kind);
    return chosen || gateExits === undefined
      ? stationAccessStep(ride, kind, id, now, chosen)
      : stationGateStep(ride, kind, id, now, gateExits);
  };
  // Already timed (a re-enriched itinerary): never count the station twice.
  if (segments.some((segment) => segment.mode === 'entry')) return [...segments];
  const entries = new Map<number, BaseSegment>(),
    exits = new Map<number, BaseSegment>();
  let order = 0;
  segments.forEach((ride, index) => {
    if (ride.mode !== 'subway') return;
    const k = order++;
    if (!staysInStation(segments, index, -1)) {
      let before = index;
      while (segments[before - 1]?.mode === 'wait') before--;
      entries.set(before, step(ride, 'entry', `${routeId}-entry-${k}`));
    }
    if (!staysInStation(segments, index, 1))
      exits.set(index, step(ride, 'exit', `${routeId}-exit-${k}`));
  });
  return segments.flatMap((segment, index) => [
    ...(entries.has(index) ? [entries.get(index)!] : []),
    segment,
    ...(exits.has(index) ? [exits.get(index)!] : []),
  ]);
}

function stopTitle(segment: BaseSegment, edge: 'start' | 'end'): string {
  const name = segment[edge].name;
  return segment.mode === 'subway' ? `${stationBaseName(name)}역` : name;
}

/** Kakao ignores the time of day; night-only buses are removed outside their service window. */
export function applyServiceHours(routes: BaseRoute[], now: number): BaseRoute[] {
  if (isNightServiceHour(now)) return routes;
  return routes.flatMap((route) => {
    let changed = false;
    const segments: BaseSegment[] = [];
    for (const segment of route.segments) {
      if (segment.mode !== 'bus' || !segment.transit) {
        segments.push(segment);
        continue;
      }
      const lines = segment.transit.lines.filter((line) => !isNightOnlyLine(line));
      if (!lines.length) return [];
      if (lines.length === segment.transit.lines.length) {
        segments.push(segment);
        continue;
      }
      changed = true;
      const label = busLabel(lines);
      const stops = segment.transit.stops;
      segments.push({
        ...segment,
        title: label,
        lineName: lines.join(' / '),
        transit: { ...segment.transit, lines },
        instructions: `${stops[0] ?? segment.start.name}에서 ${lines.length > 1 ? `${lines.join(', ')} 중 먼저 오는 버스를` : `${label}를`} 타고 ${stops.at(-1) ?? segment.end.name}에서 내려요. (${Math.max(1, stops.length - 1)}개 정류장)`,
      });
    }
    if (!changed) return [route];
    const title = segments
      .filter(isVehicle)
      .map((segment) =>
        segment.mode === 'bus'
          ? busLabel(segment.transit?.lines.slice(0, 2) ?? [])
          : (segment.transit?.lines[0] ?? '지하철'),
      )
      .join(' → ');
    return [{ ...route, title: title || route.title, segments }];
  });
}

interface AccessLeg {
  segments: BaseSegment[];
  seconds: number;
  routed: boolean;
}
export type HeadwayBook = Map<string, Promise<HeadwayEvidence | null>>;
export type TransitAccessCache = Map<string, Promise<AccessLeg>>;

/** A short walk neither network could route still connects its stop, so one failed lookup cannot drop the fastest ride. */
const MAX_ESTIMATED_LINK_METERS = 1_500;

function estimatedWalk(id: string, from: Place, to: Place, title: string): AccessLeg {
  // Fallback when no walking-route call is available: 1.25 street detour at 1.2 m/s.
  const meters = Math.round(metersBetween(from, to) * 1.25);
  const seconds = Math.ceil(meters / 1.2);
  return {
    seconds,
    routed: false,
    segments: [
      {
        id,
        mode: 'walk',
        title,
        instructions: `약 ${meters}m 걸어요.`,
        distanceMeters: meters,
        durationSeconds: { min: seconds, max: seconds },
        start: from,
        end: to,
        runAllowed: false,
        ...(meters <= MAX_ESTIMATED_LINK_METERS
          ? { polyline: [from, to].map(({ latitude, longitude }) => ({ latitude, longitude })) }
          : {}),
      },
    ],
  };
}

async function walkLeg(
  context: EnrichmentContext,
  id: string,
  from: Place,
  to: Place,
  title: string,
): Promise<AccessLeg> {
  const endpoints = { origin: from, destination: to };
  if (
    context.budget.remaining <= 0 &&
    !routeQueryIsReusable(context.provider, 'walking', endpoints, context.budget)
  ) {
    context.onAccessLimited?.('route-budget');
    return estimatedWalk(id, from, to, title);
  }
  try {
    const routes = await context.provider.walking(endpoints, context.budget);
    const merged = bestWalkingSegment(
      routes,
      id,
      from,
      to,
      title,
      context.now,
      context.acquisitionObjective,
      context.onWalkingAlternatives,
    );
    if (!merged) return estimatedWalk(id, from, to, title);
    return { seconds: merged.durationSeconds.min, segments: [merged], routed: true };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'CALL_BUDGET_EXCEEDED') context.onAccessLimited?.('route-budget');
      return estimatedWalk(id, from, to, title);
    }
    throw error;
  }
}

function boardingQuery(segment: BaseSegment): BoardingQuery | null {
  if (!isVehicle(segment) || !segment.transit?.stops.length || !segment.transit.lines.length)
    return null;
  const point = segment.polyline?.[0] ?? segment.start;
  return {
    mode: segment.mode as 'bus' | 'subway',
    stop: segment.transit.stops[0],
    lines: segment.transit.lines,
    nextStops: segment.transit.stops.slice(1),
    latitude: point.latitude,
    longitude: point.longitude,
  };
}
export const boardingKey = (query: BoardingQuery) =>
  `${query.mode}:${query.stop}:${query.lines.join(',')}:${query.nextStops[0] ?? ''}:${pointKey(query)}`;
/** One physical stop or platform; the realtime service resolves and caches it at this precision. */
const stopKey = (query: BoardingQuery) =>
  `${query.mode}:${query.stop}:${query.latitude.toFixed(4)},${query.longitude.toFixed(4)}`;
/** Evidence depends on the stop, the direction and the set of lines, not on Kakao's line order. */
const headwayKey = (query: BoardingQuery) =>
  `${stopKey(query)}:${[...query.lines].sort().join(',')}:${query.nextStops[0] ?? ''}`;

/** One search's live bus stops: each costs a stop list and a sheet call from the day's per-operation quota. */
export interface BusStopAllowance {
  observed: Set<string>;
  max: number;
}

/** Keeps one search's live bus observations within its allowance of distinct stops, in the selection's priority order;
 * a stop this search already observed costs nothing more. Rail boardings are another supplier's quota and pass. */
export function withinBusStopAllowance(
  queries: ReadonlyMap<string, BoardingQuery>,
  allowance: BusStopAllowance | undefined,
): Map<string, BoardingQuery> {
  return new Map(
    [...queries].filter(([, query]) => {
      if (!allowance || query.mode !== 'bus') return true;
      const stop = stopKey(query);
      if (allowance.observed.has(stop)) return true;
      if (allowance.observed.size >= allowance.max) return false;
      allowance.observed.add(stop);
      return true;
    }),
  );
}

/** The boardings observed live in one pass, in priority order (`available` lists every candidate's first boarding
 * before any later transfer). The cap counts distinct stops: a line bundle at an already observed stop costs no
 * request. When the kept stops hold only one mode, the first boarding of the other mode replaces the most recently
 * opened stop that holds no first boarding (a later transfer), never a candidate's first boarding unless every kept
 * stop is one; then the lowest-priority one goes. */
export function selectRealtimeQueries(
  available: ReadonlyMap<string, BoardingQuery>,
  firstBoardings: ReadonlySet<string>,
  maxStops = MAX_REALTIME_STOPS,
): Map<string, BoardingQuery> {
  const queries = new Map<string, BoardingQuery>(),
    opened: string[] = [];
  for (const [key, query] of available) {
    const stop = stopKey(query);
    if (!opened.includes(stop)) {
      if (opened.length >= maxStops) continue;
      opened.push(stop);
    }
    queries.set(key, query);
  }
  // Keep the priority order when it already covers both source modes. Otherwise
  // one itinerary's many rail/bus boardings must not consume every observation
  // slot before the competing mode can replace its estimated wait.
  for (const mode of ['bus', 'subway'] as const) {
    if ([...queries.values()].some((query) => query.mode === mode)) continue;
    const missing = [...available].find(([, query]) => query.mode === mode);
    if (!missing || maxStops <= 0) continue;
    const stop = stopKey(missing[1]);
    if (!opened.includes(stop) && opened.length >= maxStops) {
      const holdsFirst = (candidate: string) =>
        [...queries].some(
          ([key, query]) => stopKey(query) === candidate && firstBoardings.has(key),
        );
      const dropped =
        [...opened].reverse().find((candidate) => !holdsFirst(candidate)) ?? opened.at(-1)!;
      for (const [key, query] of queries) if (stopKey(query) === dropped) queries.delete(key);
      opened.splice(opened.indexOf(dropped), 1);
    }
    if (!opened.includes(stop)) opened.push(stop);
    queries.set(...missing);
  }
  return queries;
}

/** One route's chosen exits by `${ride.id}:entry|exit`, and the foot transfers that now start or end at an exit. */
interface RouteExits {
  rides: Map<string, StationExitChoice>;
  walks: Map<string, { from: Place; to: Place }>;
}

/**
 * Picks the exit of every station end where the rider leaves or enters the paid area, best candidates first so the
 * bounded walking tables go to them. The target is the next point after alighting (the destination or the far end of
 * the transfer walk) and the previous point before boarding. A train that meets another vehicle with no walk between
 * keeps its platform point.
 */
async function chooseRouteExits(
  routes: readonly BaseRoute[],
  request: RouteEndpoints,
  context: EnrichmentContext,
): Promise<Map<BaseRoute, RouteExits>> {
  const chosen = new Map<BaseRoute, RouteExits>(),
    pending: Promise<void>[] = [];
  for (const route of routes) {
    const segments = route.segments;
    if (!segments.some((segment) => segment.mode === 'subway')) continue;
    if (segments.some((segment) => segment.mode === 'entry')) continue;
    const exits: RouteExits = { rides: new Map(), walks: new Map() };
    chosen.set(route, exits);
    segments.forEach((ride, index) => {
      if (ride.mode !== 'subway') return;
      for (const step of [-1, 1] as const) {
        if (staysInStation(segments, index, step)) continue;
        const kind = step < 0 ? 'entry' : 'exit',
          neighbour = segments[physicalNeighbour(segments, index, step)],
          point = kind === 'entry' ? ride.start : ride.end;
        const target = !neighbour
          ? kind === 'entry'
            ? request.origin
            : request.destination
          : isFoot(neighbour)
            ? kind === 'entry'
              ? neighbour.start
              : neighbour.end
            : null;
        if (!target || metersBetween(point, target) <= ACCESS_THRESHOLD_METERS) continue;
        pending.push(
          chooseStationExit({
            stopName: kind === 'entry' ? firstStop(ride) : lastStop(ride),
            line: ride.transit?.lines[0] ?? ride.lineName ?? '',
            trainPoint: point,
            target,
            kind: kind === 'entry' ? 'entrance' : 'exit',
            at: context.now,
            provider: context.provider,
            budget: context.budget,
            ...(context.stationExits !== undefined ? { source: context.stationExits } : {}),
          }).then((choice) => {
            if (choice) exits.rides.set(`${ride.id}:${kind}`, choice);
          }),
        );
      }
    });
  }
  await Promise.all(pending);
  for (const [route, exits] of chosen) {
    const segments = route.segments;
    segments.forEach((foot, index) => {
      if (!isFoot(foot)) return;
      const before = segments[physicalNeighbour(segments, index, -1)],
        after = segments[physicalNeighbour(segments, index, 1)];
      const leaving = before?.mode === 'subway' && exits.rides.get(`${before.id}:exit`),
        entering = after?.mode === 'subway' && exits.rides.get(`${after.id}:entry`);
      if (!leaving && !entering) return;
      exits.walks.set(foot.id, {
        from: leaving ? stationExitStreet(before, 'exit', leaving) : foot.start,
        to: entering ? stationExitStreet(after, 'entry', entering) : foot.end,
      });
    });
  }
  return chosen;
}

/**
 * Turns Kakao transit candidates into door-to-door routes:
 * real walking legs to the first stop and from the last stop, the provider's lump-sum
 * allowance reduced by those walks, and bounded live arrivals for every boarding.
 */
export async function enrichTransitRoutes(
  input: BaseRoute[],
  request: RouteEndpoints,
  context: EnrichmentContext,
): Promise<BaseRoute[]> {
  const routes = applyServiceHours(input, context.now).sort(
    (a, b) =>
      (context.accessPriority?.(a) ?? a.durationSeconds.min) -
      (context.accessPriority?.(b) ?? b.durationSeconds.min),
  );
  const firstModes = new Set(routes[0]?.segments.filter(isVehicle).map((segment) => segment.mode));
  const diverseIndex = context.accessModeCoverage
    ? routes.findIndex(
        (route, index) =>
          index > 0 &&
          route.segments.some((segment) => isVehicle(segment) && !firstModes.has(segment.mode)),
      )
    : -1;
  if (diverseIndex > 1) routes.splice(1, 0, routes.splice(diverseIndex, 1)[0]);
  // Exits come first: every street walk at a subway station starts or ends at the chosen exit's sidewalk point.
  const routeExits = await chooseRouteExits(routes, request, context);
  // Shared access/egress walks are fetched once, fastest candidates first.
  const legs = new Map<string, Promise<AccessLeg>>();
  let accessCalls = 0;
  const accessLeg = (id: string, from: Place, to: Place, title: string): Promise<AccessLeg> => {
    const cached = context.accessCache?.get(id);
    if (cached) return cached;
    const endpoints = { origin: from, destination: to };
    const free = routeQueryIsFree(context.provider, 'walking');
    const reusable = routeQueryIsCached(context.provider, 'walking', endpoints, context.budget);
    // A self-hosted network ignores the call budget and the optional-stage window; its own cap bounds the latency.
    const cap = free
      ? (context.maxUnmeteredAccessCalls ?? context.maxAccessCalls ?? Infinity)
      : (context.maxAccessCalls ?? Infinity);
    if (!reusable && (accessCalls >= cap || (!free && context.budget.remaining <= 0))) {
      context.onAccessLimited?.(
        !free && context.budget.remaining <= 0 ? 'route-budget' : 'access-cap',
      );
      return Promise.resolve(estimatedWalk(id, from, to, title));
    }
    if (!reusable) accessCalls++;
    const pending = walkLeg(context, id, from, to, title);
    context.accessCache?.set(id, pending);
    return pending;
  };
  // A cache can also serve rental-to-transit fragments in this same search.
  // Both ends belong to its identity; sharing only the station would reuse a
  // walk from the wrong journey origin or to the wrong destination.
  const legKey = (kind: 'access' | 'egress' | 'transfer', from: Place, to: Place) =>
    `${kind}:${pointKey(from)}>${pointKey(to)}`;
  const reviewedWalks = new Map<BaseRoute, Map<number, string>>();
  // Kakao can already include an exterior walk. Long ones still need a real
  // pedestrian-network check before they can seed a rental replacement. Keep
  // internal transfer walks and short source walks intact, and reserve this
  // work before fetching optional access for other route alternatives.
  const reviewExistingWalks = (route: BaseRoute) => {
    const physical = route.segments.flatMap((segment, index) =>
      !isAllowance(segment) ? [index] : [],
    );
    const vehicles = route.segments.flatMap((segment, index) =>
      isVehicle(segment) ? [index] : [],
    );
    if (!vehicles.length) return;
    for (const [index, kind] of [
      [physical[0], 'access'],
      [physical.at(-1)!, 'egress'],
    ] as const) {
      const segment = route.segments[index];
      if (
        !segment ||
        segment.mode !== 'walk' ||
        segment.distanceMeters <= 0 ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.max < EXISTING_WALK_REVIEW_SECONDS ||
        (segment.routingSource && segment.networkSnap) ||
        routeExits.get(route)?.walks.has(segment.id) ||
        (kind === 'access' && index >= vehicles[0]) ||
        (kind === 'egress' && index <= vehicles.at(-1)!)
      )
        continue;
      const from = kind === 'access' ? request.origin : segment.start;
      const to = kind === 'access' ? segment.end : request.destination;
      const key = legKey(kind, from, to);
      if (!legs.has(key)) legs.set(key, accessLeg(key, from, to, segment.title));
      if (!reviewedWalks.has(route)) reviewedWalks.set(route, new Map());
      reviewedWalks.get(route)!.set(index, key);
    }
  };
  const planRoute = (route: BaseRoute) => {
    const first = route.segments.find((segment) => !isAllowance(segment))!;
    const last = [...route.segments].reverse().find((segment) => !isAllowance(segment))!;
    const exits = routeExits.get(route),
      entrance = exits?.rides.get(`${first.id}:entry`),
      exit = exits?.rides.get(`${last.id}:exit`);
    const boarding: Place = entrance
      ? stationExitStreet(first, 'entry', entrance)
      : {
          ...first.start,
          latitude: first.polyline?.[0]?.latitude ?? first.start.latitude,
          longitude: first.polyline?.[0]?.longitude ?? first.start.longitude,
        };
    const lastPoint = last.polyline?.at(-1) ?? last.end;
    const alighting: Place = exit
      ? stationExitStreet(last, 'exit', exit)
      : {
          ...last.end,
          latitude: lastPoint.latitude,
          longitude: lastPoint.longitude,
        };
    // Transfer walks that leave or reach the paid area are routed again from or to the exit.
    for (const [id, walk] of exits?.walks ?? []) {
      const key = legKey('transfer', walk.from, walk.to),
        foot = route.segments.find((segment) => segment.id === id)!;
      if (!legs.has(key)) legs.set(key, accessLeg(key, walk.from, walk.to, foot.title));
      if (!reviewedWalks.has(route)) reviewedWalks.set(route, new Map());
      reviewedWalks.get(route)!.set(route.segments.indexOf(foot), key);
    }
    const needsAccess =
      first.mode !== 'walk' && metersBetween(request.origin, boarding) > ACCESS_THRESHOLD_METERS;
    const needsEgress =
      last.mode !== 'walk' &&
      metersBetween(alighting, request.destination) > ACCESS_THRESHOLD_METERS;
    const accessKey = legKey('access', request.origin, boarding),
      egressKey = legKey('egress', alighting, request.destination);
    if (needsAccess && !legs.has(accessKey))
      legs.set(
        accessKey,
        accessLeg(
          `${accessKey}`,
          request.origin,
          boarding,
          `${entrance ? boarding.name : stopTitle(first, 'start')}까지 걷기`,
        ),
      );
    if (needsEgress && !legs.has(egressKey))
      legs.set(
        egressKey,
        accessLeg(
          `${egressKey}`,
          alighting,
          request.destination,
          `${request.destination.name}까지 걷기`,
        ),
      );
    return { route, needsAccess, needsEgress, accessKey, egressKey };
  };
  // Complete the winner's and missing mode's exterior queries first. Otherwise
  // later rail variants with existing long walks could spend every access slot
  // before a vehicle-only bus source reaches the ordinary planning pass.
  const coveredPlans = new Map<BaseRoute, ReturnType<typeof planRoute>>();
  const baselineFamilies = new Set<string>();
  const baselineBuses = context.baselineDirectBusCoverage
    ? [...routes]
        .filter((route) => {
          const vehicles = route.segments.filter(isVehicle);
          return vehicles.length === 1 && vehicles[0].mode === 'bus';
        })
        .sort(
          (left, right) =>
            acquisitionTiming(left, context.now, context.acquisitionObjective).total -
            acquisitionTiming(right, context.now, context.acquisitionObjective).total,
        )
        .filter((route) => {
          const bus = route.segments.find(isVehicle)!;
          const family = JSON.stringify([
            pointKey(bus.polyline?.[0] ?? bus.start),
            [...(bus.transit?.lines ?? [])].sort(),
          ]);
          if (baselineFamilies.has(family)) return false;
          baselineFamilies.add(family);
          return true;
        })
        .slice(0, 2)
    : [];
  const coveredModes = new Set(
    baselineBuses.flatMap((route) =>
      route.segments.filter(isVehicle).map((segment) => segment.mode),
    ),
  );
  const missingMode =
    baselineBuses.length && context.accessModeCoverage
      ? routes.find((route) =>
          route.segments.some((segment) => isVehicle(segment) && !coveredModes.has(segment.mode)),
        )
      : undefined;
  const priorityCoverage = baselineBuses.length
    ? [...baselineBuses, ...(missingMode ? [missingMode] : [])]
    : diverseIndex > 0
      ? routes.slice(0, 2)
      : [];
  for (const route of priorityCoverage) {
    reviewExistingWalks(route);
    coveredPlans.set(route, planRoute(route));
  }
  for (const route of routes) if (!coveredPlans.has(route)) reviewExistingWalks(route);
  const plans = routes.map((route) => coveredPlans.get(route) ?? planRoute(route));
  const resolved = new Map<string, AccessLeg>();
  const walks = Promise.all(
    [...legs].map(async ([key, leg]) => {
      resolved.set(key, await leg);
    }),
  );

  const availableQueries = new Map<string, BoardingQuery>();
  // Observe each candidate's first boarding before spending the cap on later transfers.
  // Otherwise a fast multi-transfer rail route can starve a catchable direct bus.
  for (const { route } of plans) {
    const first = route.segments.find(isVehicle);
    const query = first && boardingQuery(first);
    if (query && !availableQueries.has(boardingKey(query)))
      availableQueries.set(boardingKey(query), query);
  }
  const firstBoardings = new Set(availableQueries.keys());
  for (const { route } of plans) {
    for (const segment of route.segments) {
      const query = boardingQuery(segment);
      if (query && !availableQueries.has(boardingKey(query)))
        availableQueries.set(boardingKey(query), query);
    }
  }
  const queries = withinBusStopAllowance(
    selectRealtimeQueries(availableQueries, firstBoardings),
    context.busStopAllowance,
  );
  // Arrivals depend only on the boardings, so they load while the walks are routed. A feed that
  // has not answered in time (Seoul stops that fall back to the national TAGO feed take 2-4 s)
  // leaves its boarding on the estimated wait; the lookup still finishes into the feed's cache.
  const arrivals = new Map<string, Awaited<ReturnType<RealtimeService['lookup']>>>();
  const waitMs = context.realtimeWaitMs ?? REALTIME_WAIT_MS;
  const inTime = <T>(promise: Promise<T>, late: T) =>
    new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(late), waitMs);
      timer.unref?.();
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        () => {
          clearTimeout(timer);
          resolve(late);
        },
      );
    });
  // Bus headway evidence comes from the same stop sheet as the arrivals (shared caches, no extra request) and is kept
  // for the whole search, so every candidate and later pass boarding there reads the same windows.
  const book = context.headwayBook ?? new Map<string, Promise<HeadwayEvidence | null>>();
  const evidence = new Map<string, HeadwayEvidence | null>();
  const busEvidence = (query: BoardingQuery) => {
    const key = headwayKey(query);
    let pending = book.get(key);
    if (!pending) {
      // A test double or a non-Seoul service may not offer stop sheets; the boarding then keeps the rule.
      pending = (context.realtime!.busSheet?.(query) ?? Promise.resolve(null)).then(
        (sheet) => busHeadwayEvidence(query.lines, sheet?.lines ?? null, context.now),
        () => busHeadwayEvidence(query.lines, null, context.now),
      );
      book.set(key, pending);
    }
    return pending;
  };
  const busQueries = [...availableQueries.values()].filter((query) => query.mode === 'bus');
  const bookedEvidence = context.realtime
    ? busQueries.filter((query) => queries.has(boardingKey(query)) || book.has(headwayKey(query)))
    : [];
  // Every other bus boarding still gets what its line names alone establish ((평일), (출근), (심야), ...), which needs no
  // request; a later pass that observes the stop replaces it with the sheet's evidence.
  for (const query of busQueries)
    if (!bookedEvidence.includes(query))
      evidence.set(headwayKey(query), busHeadwayEvidence(query.lines, null, context.now));
  await Promise.all([
    walks,
    ...(context.realtime
      ? [...queries].map(async ([key, query]) => {
          arrivals.set(key, await inTime(context.realtime!.lookup(query), null));
        })
      : []),
    // A sheet that has not answered in time still leaves the name rules.
    ...bookedEvidence.map(async (query) => {
      evidence.set(
        headwayKey(query),
        (await inTime(busEvidence(query), undefined)) ??
          busHeadwayEvidence(query.lines, null, context.now),
      );
    }),
  ]);

  const enriched: BaseRoute[] = [];
  for (const { route, needsAccess, needsEgress, accessKey, egressKey } of plans) {
    const access = needsAccess ? resolved.get(accessKey)! : null;
    const egress = needsEgress ? resolved.get(egressKey)! : null;
    const allowance = route.segments.find(isAllowance);
    let segments = route.segments.flatMap((segment, index) => {
      if (isAllowance(segment)) return [];
      const key = reviewedWalks.get(route)?.get(index),
        reviewed = key ? resolved.get(key) : undefined;
      // A walk moved to an exit keeps its new ends even when only the straight-line estimate answered.
      if (reviewed && routeExits.get(route)?.walks.has(segment.id))
        return [{ ...reviewed.segments[0], id: segment.id }];
      const actual = reviewed?.routed ? reviewed.segments[0] : undefined;
      // A failed lookup or a fallback with no pedestrian provenance cannot
      // relabel the provider's original walk as a verified outdoor connection.
      return [
        { ...(actual?.routingSource && actual.networkSnap ? actual : segment), id: segment.id },
      ];
    });
    const vehicles = segments.flatMap((segment, index) => (isVehicle(segment) ? [index] : []));
    if (vehicles.length) {
      let noService = false;
      for (const index of vehicles) {
        const query = boardingQuery(segments[index]);
        const live = query ? arrivals.get(boardingKey(query)) : null;
        // Neither stale arrivals nor stale termination notices establish the present state.
        delete segments[index].realtime;
        const headway = query?.mode === 'bus' ? evidence.get(headwayKey(query)) : undefined;
        if (headway) segments[index].headwayEvidence = headway;
        if (!boardingObservationIsFresh(live, context.now)) continue;
        if (live.status === 'no-service') {
          noService = true;
          break;
        }
        segments[index].realtime = live;
      }
      if (noService) continue;
      // Kakao's unlabeled remainder is its own estimate of the first and last walk
      // (totalTime = access walk + rides + egress walk). Those walks are replaced above,
      // so the remainder is dropped rather than padded onto a wait. Each boarding gets the
      // usual half-headway wait, which live arrivals and timetables replace in the planner.
      for (let k = vehicles.length - 1; k >= 0; k -= 1) {
        const vehicle = segments[vehicles[k]];
        const wait = expectedWaitSeconds(vehicle, context.now);
        segments.splice(vehicles[k], 0, {
          id: `${route.id}-wait-${k}${EXPECTED_WAIT_SUFFIX}`,
          mode: 'wait',
          title: k === 0 ? '승차 대기' : '환승 대기',
          instructions: '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
          distanceMeters: 0,
          runAllowed: false,
          expectedWaitBasisSeconds: wait,
          durationSeconds: { min: wait, max: wait },
          start: vehicle.start,
          end: vehicle.start,
        });
      }
      const exits = routeExits.get(route)?.rides;
      segments = insertStationAccess(
        segments,
        route.id,
        context.now,
        (ride, kind) => exits?.get(`${ride.id}:${kind}`),
        context.stationExits === undefined ? bundledStationExits() : context.stationExits,
      );
    } else if (allowance) {
      const remaining = Math.max(
        0,
        allowance.durationSeconds.min - (access?.seconds ?? 0) - (egress?.seconds ?? 0),
      );
      const remainingMaximum = Math.max(
        remaining,
        allowance.durationSeconds.max -
          (access ? sumSeconds(access.segments, 'max') : 0) -
          (egress ? sumSeconds(egress.segments, 'max') : 0),
      );
      if (remainingMaximum > 0)
        segments.push({ ...allowance, durationSeconds: { min: remaining, max: remainingMaximum } });
    }
    segments = [
      ...(access?.segments.map((segment) => ({ ...segment, id: `${route.id}-access` })) ?? []),
      ...segments,
      ...(egress?.segments.map((segment) => ({ ...segment, id: `${route.id}-egress` })) ?? []),
    ];
    enriched.push({
      ...route,
      segments,
      durationSeconds: { min: sumSeconds(segments, 'min'), max: sumSeconds(segments, 'max') },
      distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    });
  }
  return enriched;
}
