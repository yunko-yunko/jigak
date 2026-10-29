import type { BaseRoute, BaseSegment, Place } from '../shared/domain/types.js';
import type { CallBudget } from './call-budget.js';
import type { NearbyPlace, RouteEndpoints, RouteProvider } from './kakao.js';
import { ApiError } from './errors.js';
import { metersBetween, stationBaseName, subwayLineId, subwayLineName } from './realtime/names.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming } from './acquisition-priority.js';

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
function lookupCenter(
  path: readonly Point[],
  fraction: number,
): {
  center: Point;
  length: number;
} {
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

  return {
    center: path[0],
    length,
  };
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

function candidates(
  sources: readonly BaseRoute[],
  now: number,
  objective: RoutingObjective,
): Candidate[] {
  const output: Candidate[] = [],
    seen = new Set<string>();
  const priorities = new Map(
    sources.map((route) => [route, acquisitionTiming(route, now, objective).total]),
  );

  for (const route of [...sources].sort((a, b) => priorities.get(a)! - priorities.get(b)!)) {
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
      ) {
        continue;
      }

      const order = stops
        .slice(1, -1)
        .map((name, index) => ({
          name: stationName(name),
          index: index + 1,
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
        ) {
          continue;
        }

        seen.add(stop.name);

        const lookup = lookupCenter(path, stop.index / (stops.length - 1));

        output.push({
          name: stop.name,
          center: lookup.center,
          radius: Math.min(5_000, Math.max(1_500, (lookup.length / (stops.length - 1)) * 1.5)),
          segment,
        });
      }
    }
  }

  return output;
}

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
  if (at(segment[edge], point)) {
    return true;
  }

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
    metersBetween(segment[edge], point) > 75 ||
    ![snap.startMeters, snap.endMeters, snap.allowanceSeconds].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    snap.allowanceSeconds < snap.startMeters + snap.endMeters ||
    snap.allowanceSeconds > segment.durationSeconds.max - segment.durationSeconds.min
  ) {
    return false;
  }

  const pathEnd = edge === 'start' ? path[0] : path.at(-1)!;

  return (
    metersBetween(pathEnd, point) <= 75 &&
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
          metersBetween(segment.polyline[0], segment.start) <= 75 &&
          metersBetween(segment.polyline.at(-1)!, segment.end) <= 75),
    ) ||
    route.notes?.some(
      (note) => note.title === '역 내부 보행 연결 미확인' || note.title === '출발·환승 연결 미확인',
    )
  ) {
    return null;
  }

  const segments = route.segments.map((segment) => ({
      ...segment,
    })),
    lastIndex = route.segments.indexOf(last);

  segments[0].start = endpoints.origin;
  segments[lastIndex].end = endpoints.destination;

  if (allowance !== last) {
    if (!at(allowance!.start, last.end) || !at(allowance!.end, last.end)) {
      return null;
    }

    segments[segments.length - 1].start = endpoints.destination;
    segments[segments.length - 1].end = endpoints.destination;
  }

  return {
    ...route,
    segments,
  };
}

function namespaceRoute(route: BaseRoute, namespace: string): BaseRoute {
  const ids = new Map(route.segments.map((segment) => [segment.id, `${namespace}-${segment.id}`]));

  return {
    ...route,
    id: `${namespace}-${route.id}`,
    segments: route.segments.map((segment) => ({
      ...segment,
      id: ids.get(segment.id)!,
    })),
    ...(route.notes
      ? {
          notes: route.notes.map((note) =>
            note.segmentId
              ? {
                  ...note,
                  segmentId: ids.get(note.segmentId) ?? note.segmentId,
                }
              : {
                  ...note,
                },
          ),
        }
      : {}),
  };
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
  };

  const result: IntermediateTransitResult = {
    routes: [],
    hubs: [],
    diagnostics,
  };
  const maxHubs = Number.isInteger(context.maxHubs)
    ? Math.max(0, Math.min(6, context.maxHubs!))
    : 2;

  if (!maxHubs || !context.provider.nearby) {
    return result;
  }

  const stops = candidates(
    sources,
    context.now ?? Date.now(),
    context.acquisitionObjective ?? 'estimated-arrival',
  );

  diagnostics.candidateStops = stops.length;

  const maxLookups = maxHubs * 2,
    selected = stops.slice(0, maxLookups),
    before = context.budget.used;

  diagnostics.candidateLimitSkipped = stops.length - selected.length;

  const allowance =
    Number.isSafeInteger(context.maxRouteCalls) && context.maxRouteCalls! >= 0
      ? context.maxRouteCalls!
      : 8;
  const retained = new Set<string>();

  await context.budget.withReservedCalls(
    Math.max(0, context.budget.remaining - allowance),
    async () => {
      for (const [index, candidate] of selected.entries()) {
        if (result.hubs.length >= maxHubs) {
          diagnostics.candidateLimitSkipped += selected.length - index;
          break;
        }

        if (context.budget.remaining < 2) {
          diagnostics.budgetSkipped += selected.length - index;
          break;
        }

        diagnostics.stationLookups++;

        let found: NearbyPlace[];

        try {
          found = await context.provider.nearby!({
            keyword: stationKeyword(candidate),
            ...candidate.center,
            radius: candidate.radius,
          });
        } catch {
          diagnostics.providerFailures++;
          continue;
        }

        const stations = found
          .filter((place) => stationMatches(place, candidate, request))
          .sort((a, b) => metersBetween(a, candidate.center) - metersBetween(b, candidate.center));

        diagnostics.rejectedStations += found.length - stations.length;

        const station = stations.find(
          (place) => !retained.has(`${place.latitude.toFixed(6)},${place.longitude.toFixed(6)}`),
        );

        if (!station) {
          continue;
        }

        diagnostics.verifiedHubs++;

        const hub: Place = {
          id: station.id,
          name: station.name,
          address: station.address,
          latitude: station.latitude,
          longitude: station.longitude,
        };

        const left = {
            origin: request.origin,
            destination: hub,
          },
          right = {
            origin: hub,
            destination: request.destination,
          };

        const cost = (endpoints: RouteEndpoints) =>
          Math.max(0, context.queryCallCost?.(endpoints) ?? 1);

        if (context.budget.remaining < cost(left) + cost(right)) {
          diagnostics.budgetSkipped++;
          continue;
        }

        try {
          diagnostics.routeQueries++;

          const beforeHub = await context.budget.withReservedCalls(cost(right), () =>
            context.connectTransit(left),
          );

          const verified = (routes: BaseRoute[], endpoints: RouteEndpoints) => {
            const accepted = routes
              .map((route) => verifiedSubjourney(route, endpoints))
              .filter((route): route is BaseRoute => !!route);

            diagnostics.unverifiedConnections += routes.length
              ? routes.length - accepted.length
              : 1;

            return accepted;
          };

          const prefixes = verified(beforeHub, left);

          if (!prefixes.length) {
            continue;
          }

          diagnostics.routeQueries++;

          const afterHub = await context.connectTransit(right);

          const suffixes = verified(afterHub, right);

          if (!prefixes.length || !suffixes.length) {
            continue;
          }

          result.routes.push(
            ...prefixes.map((route) => namespaceRoute(route, `intermediate-${index}-before`)),
            ...suffixes.map((route) => namespaceRoute(route, `intermediate-${index}-after`)),
          );
          result.hubs.push(hub);
          diagnostics.connectedHubs++;
          retained.add(`${hub.latitude.toFixed(6)},${hub.longitude.toFixed(6)}`);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'CALL_BUDGET_EXCEEDED') {
            diagnostics.budgetSkipped++;
            break;
          }

          diagnostics.providerFailures++;

          if (
            error instanceof ApiError &&
            ['PROVIDER_AUTH', 'PROVIDER_FORBIDDEN', 'PROVIDER_LIMIT'].includes(error.code)
          ) {
            break;
          }
        }
      }
    },
  );

  diagnostics.routeCalls = context.budget.used - before;
  diagnostics.limitReached = diagnostics.budgetSkipped > 0 || diagnostics.candidateLimitSkipped > 0;

  return result;
}
