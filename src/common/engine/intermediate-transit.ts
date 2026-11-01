import type { BaseRoute, BaseSegment, Place } from '../shared/domain/types.js';
import { MAX_CONNECTOR_METERS } from './connectivity/walking-comparison.js';
import type { CallBudget } from './call-budget.js';
import type { NearbyPlace, RouteEndpoints, RouteProvider } from './kakao.js';
import { ApiError } from './errors.js';
import { metersBetween, stationBaseName, subwayLineId, subwayLineName } from './realtime/names.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming } from './acquisition-priority.js';
import { findStationTransferReference } from './connectivity/station-transfers.js';
import { continuesRide, firstRideSegment, lastRideSegment } from './ride-identity.js';

export interface IntermediateTransitDiagnostics {
  candidateStops: number;
  stationLookups: number;
  verifiedHubs: number;
  connectedHubs: number;
  routeQueries: number;
  routeCalls: number;
  budgetSkipped: number;
  candidateLimitSkipped: number;
  rejectedStations: number;
  providerFailures: number;
  unverifiedConnections: number;
  limitReached: boolean;
  /** Subjourney fragments dropped because every pairing would ride one line in one direction on both sides of the hub. */
  sameLineSplits: number;
  /** Stations of a single-line source ride that no other line serves; splitting that ride there can only give the same line twice. */
  nonInterchangeSkipped: number;
}
export interface IntermediateTransitContext {
  /** Application limits production searches to two; offline acquisition audits may compare up to six. */
  provider: RouteProvider;
  budget: CallBudget;
  maxHubs?: number;
  maxRouteCalls?: number;
  now?: number;
  acquisitionObjective?: RoutingObjective;
  /** Fetch and enrich against these endpoints, using the same provider/cache/budget as the parent search. */
  connectTransit: (endpoints: RouteEndpoints) => Promise<BaseRoute[]>;
  queryCallCost?: (endpoints: RouteEndpoints) => number;
}
export interface IntermediateTransitResult {
  routes: BaseRoute[];
  hubs: Place[];
  diagnostics: IntermediateTransitDiagnostics;
}
type Point = Pick<Place, 'latitude' | 'longitude'>;
interface Candidate {
  name: string;
  center: Point;
  radius: number;
  segment: BaseSegment;
  /** Another line stops here, so a transfer is possible. */ interchange: boolean;
}
const validPoint = (point: Point) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;
const at = (left: Point, right: Point) =>
  Math.abs(left.latitude - right.latitude) < 0.000001 &&
  Math.abs(left.longitude - right.longitude) < 0.000001;
const isFoot = (segment: BaseSegment) => segment.mode === 'walk' || segment.mode === 'run';

function stationName(value: string): string {
  const match = value.trim().match(/^(.+역)\s+(.+)$/);
  return stationBaseName(match && subwayLineId(match[2]) ? match[1] : value).toLocaleLowerCase();
}

function stationKeyword(candidate: Candidate): string {
  const name = candidate.name.endsWith('역') ? candidate.name : `${candidate.name}역`;
  const line = [candidate.segment.lineName, ...(candidate.segment.transit?.lines ?? [])].flatMap(
    (value) => {
      const id = value ? subwayLineId(value) : null;
      return id ? [subwayLineName(id)!] : [];
    },
  )[0];
  // With a geometry-derived search center, nearby businesses can occupy every
  // distance-sorted result. The provider's known line disambiguates the station
  // without extra queries or relaxing the name/category/railway checks.
  return line ? `${name} ${line}` : name;
}

/** Only a lookup hint along supplied geometry; this point is never inserted into a route or timed. */
function lookupCenter(path: readonly Point[], fraction: number): { center: Point; length: number } {
  const lengths = path.slice(1).map((point, index) => metersBetween(path[index], point));
  const length = lengths.reduce((sum, value) => sum + value, 0);
  let remaining = length * fraction;
  for (let index = 0; index < lengths.length; index++) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const ratio = lengths[index] ? remaining / lengths[index] : 0;
      return {
        length,
        center: {
          latitude:
            path[index].latitude + (path[index + 1].latitude - path[index].latitude) * ratio,
          longitude:
            path[index].longitude + (path[index + 1].longitude - path[index].longitude) * ratio,
        },
      };
    }
    remaining -= lengths[index];
  }
  return { center: path[0], length };
}

function distanceToPath(point: Point, path: readonly Point[]): number {
  const longitudeScale = Math.cos((point.latitude * Math.PI) / 180);
  let closest = Infinity;
  for (let index = 1; index < path.length; index++) {
    const start = path[index - 1],
      end = path[index];
    const dx = (end.longitude - start.longitude) * longitudeScale,
      dy = end.latitude - start.latitude;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared
      ? Math.max(
          0,
          Math.min(
            1,
            ((point.longitude - start.longitude) * longitudeScale * dx +
              (point.latitude - start.latitude) * dy) /
              lengthSquared,
          ),
        )
      : 0;
    closest = Math.min(
      closest,
      metersBetween(point, {
        latitude: start.latitude + (end.latitude - start.latitude) * fraction,
        longitude: start.longitude + (end.longitude - start.longitude) * fraction,
      }),
    );
  }
  return closest;
}

const INTERCHANGE_LINES = [
  '1호선',
  '2호선',
  '3호선',
  '4호선',
  '5호선',
  '6호선',
  '7호선',
  '8호선',
  '9호선',
  '경의중앙선',
  '공항철도',
  '경춘선',
  '수인분당선',
  '신분당선',
  '우이신설선',
  '신림선',
  'GTX-A',
  '서해선',
  '경강선',
  '김포골드라인',
];
/** Stations the official transfer table lists for this line and another one; either direction counts. */
const ownLines = (segment: BaseSegment) =>
  (segment.transit?.lines.length
    ? segment.transit.lines
    : segment.lineName
      ? segment.lineName.split(' / ')
      : []
  )
    .map((line) => line.trim())
    .filter(Boolean);
function isInterchange(station: string, segment: BaseSegment): boolean {
  const own = ownLines(segment);
  return own.some((line) =>
    INTERCHANGE_LINES.some(
      (other) =>
        other !== line.trim() &&
        !!(
          findStationTransferReference(station, line.trim(), other) ||
          findStationTransferReference(station, other, line.trim())
        ),
    ),
  );
}

function candidateScan(
  sources: readonly BaseRoute[],
  now: number,
  objective: RoutingObjective,
): { output: Candidate[]; skipped: number } {
  const output: Candidate[] = [],
    seen = new Set<string>(),
    skippedNames = new Set<string>();
  const priorities = new Map(
    sources.map((route) => [route, acquisitionTiming(route, now, objective).total]),
  );
  for (const route of [...sources].sort((a, b) => priorities.get(a)! - priorities.get(b)!))
    for (const segment of route.segments) {
      const stops = segment.transit?.stops,
        path = segment.polyline;
      if (
        segment.mode !== 'subway' ||
        !stops ||
        stops.length < 3 ||
        !path ||
        path.length < 2 ||
        !path.every(validPoint)
      )
        continue;
      const order = stops
        .slice(1, -1)
        .map((name, index) => ({
          name: stationName(name),
          index: index + 1,
          interchange: isInterchange(name, segment),
        }))
        .sort(
          (a, b) =>
            Math.abs(a.index - (stops.length - 1) / 2) - Math.abs(b.index - (stops.length - 1) / 2),
        );
      for (const stop of order) {
        if (
          !stop.name ||
          seen.has(stop.name) ||
          [stops[0], stops.at(-1)!, segment.start.name, segment.end.name].some(
            (name) => stationName(name) === stop.name,
          )
        )
          continue;
        // A single-line ride gains nothing from a hub no other line serves: the provider answers both halves with that same line.
        if (!stop.interchange && ownLines(segment).length === 1) {
          skippedNames.add(stop.name);
          continue;
        }
        seen.add(stop.name);
        const lookup = lookupCenter(path, stop.index / (stops.length - 1));
        output.push({
          name: stop.name,
          center: lookup.center,
          radius: Math.min(5_000, Math.max(1_500, (lookup.length / (stops.length - 1)) * 1.5)),
          segment,
          interchange: stop.interchange,
        });
      }
    }
  // A hub where another line stops can offer a real transfer; splitting one line in two cannot. Stable, so the existing order holds within each group.
  const skipped = [...skippedNames].filter((name) => !seen.has(name)).length;
  return { output: output.sort((a, b) => Number(b.interchange) - Number(a.interchange)), skipped };
}
const candidates = (sources: readonly BaseRoute[], now: number, objective: RoutingObjective) =>
  candidateScan(sources, now, objective).output;

function stationMatches(
  place: NearbyPlace,
  candidate: Candidate,
  request: RouteEndpoints,
): boolean {
  return (
    validPoint(place) &&
    /지하철|전철/.test(place.category) &&
    stationName(place.name) === candidate.name &&
    metersBetween(place, candidate.center) <= candidate.radius &&
    distanceToPath(place, candidate.segment.polyline!) <= 500 &&
    !at(place, request.origin) &&
    !at(place, request.destination) &&
    !at(place, candidate.segment.start) &&
    !at(place, candidate.segment.end)
  );
}

/** Internal query boundaries need their own source evidence; global outer-pin tolerance cannot bridge a transfer. */
function verifiedBoundary(segment: BaseSegment, point: Place, edge: 'start' | 'end'): boolean {
  if (at(segment[edge], point)) return true;
  const source = segment.routingSource,
    snap = segment.networkSnap,
    path = segment.polyline;
  if (
    !isFoot(segment) ||
    !source ||
    source.mode !== 'live' ||
    !source.provider ||
    !Number.isFinite(source.receivedAt) ||
    !snap ||
    !path?.length ||
    metersBetween(segment[edge], point) > MAX_CONNECTOR_METERS ||
    ![snap.startMeters, snap.endMeters, snap.allowanceSeconds].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    snap.allowanceSeconds < snap.startMeters + snap.endMeters ||
    snap.allowanceSeconds > segment.durationSeconds.max - segment.durationSeconds.min
  )
    return false;
  const pathEnd = edge === 'start' ? path[0] : path.at(-1)!;
  return (
    metersBetween(pathEnd, point) <= MAX_CONNECTOR_METERS &&
    Math.abs(
      metersBetween(pathEnd, point) - snap[edge === 'start' ? 'startMeters' : 'endMeters'],
    ) <= 2
  );
}

/** Keep geometry and every supplied second. A snapped boundary moves only with its already-included allowance. */
function verifiedSubjourney(route: BaseRoute, endpoints: RouteEndpoints): BaseRoute | null {
  const first = route.segments[0],
    allowance = route.segments.at(-1);
  const last =
    allowance?.mode === 'wait' && allowance.id.endsWith('-provider-extra')
      ? route.segments.at(-2)
      : allowance;
  if (
    !first ||
    !last ||
    !verifiedBoundary(first, endpoints.origin, 'start') ||
    !verifiedBoundary(last, endpoints.destination, 'end') ||
    !route.segments.every(
      (segment) =>
        !['walk', 'run', 'bus', 'subway'].includes(segment.mode) ||
        segment.distanceMeters === 0 ||
        (!!segment.polyline &&
          segment.polyline.length >= 2 &&
          segment.polyline.every(validPoint) &&
          metersBetween(segment.polyline[0], segment.start) <= MAX_CONNECTOR_METERS &&
          metersBetween(segment.polyline.at(-1)!, segment.end) <= MAX_CONNECTOR_METERS),
    ) ||
    route.notes?.some(
      (note) => note.title === '역 내부 보행 연결 미확인' || note.title === '출발·환승 연결 미확인',
    )
  )
    return null;
  const segments = route.segments.map((segment) => ({ ...segment })),
    lastIndex = route.segments.indexOf(last);
  segments[0].start = endpoints.origin;
  segments[lastIndex].end = endpoints.destination;
  if (allowance !== last) {
    if (!at(allowance!.start, last.end) || !at(allowance!.end, last.end)) return null;
    segments[segments.length - 1].start = endpoints.destination;
    segments[segments.length - 1].end = endpoints.destination;
  }
  return { ...route, segments };
}

function namespaceRoute(route: BaseRoute, namespace: string): BaseRoute {
  const ids = new Map(route.segments.map((segment) => [segment.id, `${namespace}-${segment.id}`]));
  return {
    ...route,
    id: `${namespace}-${route.id}`,
    segments: route.segments.map((segment) => ({ ...segment, id: ids.get(segment.id)! })),
    ...(route.notes
      ? {
          notes: route.notes.map((note) =>
            note.segmentId
              ? { ...note, segmentId: ids.get(note.segmentId) ?? note.segmentId }
              : { ...note },
          ),
        }
      : {}),
  };
}

/** The first wave of station searches discoverIntermediateTransit makes; it depends only on the source itineraries. */
export function intermediateStationQueries(
  sources: readonly BaseRoute[],
  options: Pick<IntermediateTransitContext, 'maxHubs' | 'now' | 'acquisitionObjective'>,
) {
  const maxHubs = Number.isInteger(options.maxHubs)
    ? Math.max(0, Math.min(6, options.maxHubs!))
    : 2;
  return candidates(
    sources,
    options.now ?? Date.now(),
    options.acquisitionObjective ?? 'estimated-arrival',
  )
    .slice(0, maxHubs)
    .map((candidate) => ({
      keyword: stationKeyword(candidate),
      ...candidate.center,
      radius: candidate.radius,
    }));
}

/** Discover real intermediate rail stations, then ask the provider for both actual subjourneys.
 * Stop names never become fabricated timed legs. The returned fragments require the ordinary graph search.
 */
export async function discoverIntermediateTransit(
  request: RouteEndpoints,
  sources: readonly BaseRoute[],
  context: IntermediateTransitContext,
): Promise<IntermediateTransitResult> {
  const diagnostics: IntermediateTransitDiagnostics = {
    candidateStops: 0,
    stationLookups: 0,
    verifiedHubs: 0,
    connectedHubs: 0,
    routeQueries: 0,
    routeCalls: 0,
    budgetSkipped: 0,
    candidateLimitSkipped: 0,
    rejectedStations: 0,
    providerFailures: 0,
    unverifiedConnections: 0,
    limitReached: false,
    sameLineSplits: 0,
    nonInterchangeSkipped: 0,
  };
  const result: IntermediateTransitResult = { routes: [], hubs: [], diagnostics };
  const maxHubs = Number.isInteger(context.maxHubs)
    ? Math.max(0, Math.min(6, context.maxHubs!))
    : 2;
  if (!maxHubs || !context.provider.nearby) return result;
  const scan = candidateScan(
      sources,
      context.now ?? Date.now(),
      context.acquisitionObjective ?? 'estimated-arrival',
    ),
    stops = scan.output;
  diagnostics.candidateStops = stops.length;
  diagnostics.nonInterchangeSkipped = scan.skipped;
  const maxLookups = maxHubs * 2,
    selected = stops.slice(0, maxLookups),
    before = context.budget.used;
  diagnostics.candidateLimitSkipped = stops.length - selected.length;
  const allowance =
    Number.isSafeInteger(context.maxRouteCalls) && context.maxRouteCalls! >= 0
      ? context.maxRouteCalls!
      : 8;
  const claimed = new Set<string>();
  const pointKey = (place: Point) => `${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}`;
  const cost = (endpoints: RouteEndpoints) => Math.max(0, context.queryCallCost?.(endpoints) ?? 1);
  const verified = (routes: BaseRoute[], endpoints: RouteEndpoints) => {
    const accepted = routes
      .map((route) => verifiedSubjourney(route, endpoints))
      .filter((route): route is BaseRoute => !!route);
    diagnostics.unverifiedConnections += routes.length ? routes.length - accepted.length : 1;
    return accepted;
  };
  // A pairing whose boundary vehicles are one line in one direction is a ride split in two, not a transfer.
  const distinctRides = (before: BaseRoute[], after: BaseRoute[]) => {
    const joins = (prefix: BaseRoute, suffix: BaseRoute) => {
      const last = lastRideSegment(prefix.segments),
        first = firstRideSegment(suffix.segments);
      return !(last && first && continuesRide(last, first));
    };
    const prefixes = before.filter((prefix) => after.some((suffix) => joins(prefix, suffix)));
    const suffixes = after.filter((suffix) => before.some((prefix) => joins(prefix, suffix)));
    diagnostics.sameLineSplits += before.length + after.length - prefixes.length - suffixes.length;
    return { prefixes, suffixes };
  };
  await context.budget.withReservedCalls(
    Math.max(0, context.budget.remaining - allowance),
    async () => {
      // Each wave looks up only as many stations as hubs are still missing, then asks for every
      // hub's two subjourneys at once: a rider waits for one round trip, not one per query.
      let next = 0,
        stopped = false;
      while (!stopped && result.hubs.length < maxHubs && next < selected.length) {
        if (context.budget.remaining < 2) {
          diagnostics.budgetSkipped += selected.length - next;
          next = selected.length;
          break;
        }
        const wave = selected
          .slice(next, next + maxHubs - result.hubs.length)
          .map((candidate, offset) => ({ candidate, index: next + offset }));
        next += wave.length;
        diagnostics.stationLookups += wave.length;
        const lookups = await Promise.all(
          wave.map(({ candidate }) =>
            context.provider.nearby!({
              keyword: stationKeyword(candidate),
              ...candidate.center,
              radius: candidate.radius,
            }).catch(() => {
              diagnostics.providerFailures++;
              return null;
            }),
          ),
        );
        const hubs: { index: number; hub: Place; left: RouteEndpoints; right: RouteEndpoints }[] =
          [];
        let planned = 0;
        for (const [position, found] of lookups.entries()) {
          if (!found) continue;
          const { candidate, index } = wave[position];
          const stations = found
            .filter((place) => stationMatches(place, candidate, request))
            .sort(
              (a, b) => metersBetween(a, candidate.center) - metersBetween(b, candidate.center),
            );
          diagnostics.rejectedStations += found.length - stations.length;
          const station = stations.find((place) => !claimed.has(pointKey(place)));
          if (!station) continue;
          diagnostics.verifiedHubs++;
          const hub: Place = {
            id: station.id,
            name: station.name,
            address: station.address,
            latitude: station.latitude,
            longitude: station.longitude,
          };
          const left = { origin: request.origin, destination: hub },
            right = { origin: hub, destination: request.destination };
          if (context.budget.remaining - planned < cost(left) + cost(right)) {
            diagnostics.budgetSkipped++;
            continue;
          }
          planned += cost(left) + cost(right);
          claimed.add(pointKey(hub));
          hubs.push({ index, hub, left, right });
        }
        const outcomes = await Promise.all(
          hubs.map(({ left, right }) => {
            diagnostics.routeQueries += 2;
            return Promise.allSettled([
              context.connectTransit(left),
              context.connectTransit(right),
            ]);
          }),
        );
        for (const [position, [beforeHub, afterHub]] of outcomes.entries()) {
          const { index, hub, left, right } = hubs[position];
          const failure = [beforeHub, afterHub].find(
            (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
          )?.reason;
          if (failure !== undefined) {
            claimed.delete(pointKey(hub));
            if (failure instanceof ApiError && failure.code === 'CALL_BUDGET_EXCEEDED') {
              diagnostics.budgetSkipped++;
              stopped = true;
              continue;
            }
            diagnostics.providerFailures++;
            if (
              failure instanceof ApiError &&
              ['PROVIDER_AUTH', 'PROVIDER_FORBIDDEN', 'PROVIDER_LIMIT'].includes(failure.code)
            )
              stopped = true;
            continue;
          }
          const verifiedPrefixes = verified(
            (beforeHub as PromiseFulfilledResult<BaseRoute[]>).value,
            left,
          );
          const verifiedSuffixes = verifiedPrefixes.length
            ? verified((afterHub as PromiseFulfilledResult<BaseRoute[]>).value, right)
            : [];
          const { prefixes, suffixes } = distinctRides(verifiedPrefixes, verifiedSuffixes);
          if (!prefixes.length || !suffixes.length) {
            claimed.delete(pointKey(hub));
            // Another wave of lookups would only find more hubs on the same line: the rider waits for nothing.
            if (verifiedPrefixes.length && verifiedSuffixes.length) stopped = true;
            continue;
          }
          result.routes.push(
            ...prefixes.map((route) => namespaceRoute(route, `intermediate-${index}-before`)),
            ...suffixes.map((route) => namespaceRoute(route, `intermediate-${index}-after`)),
          );
          result.hubs.push(hub);
          diagnostics.connectedHubs++;
        }
      }
      // Whatever the loop left unlooked (hub quota met, a stopped search or a provider limit) is a candidate the search did not try.
      if (next < selected.length) diagnostics.candidateLimitSkipped += selected.length - next;
    },
  );
  diagnostics.routeCalls = context.budget.used - before;
  diagnostics.limitReached = diagnostics.budgetSkipped > 0 || diagnostics.candidateLimitSkipped > 0;
  return result;
}
