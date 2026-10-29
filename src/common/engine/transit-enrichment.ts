import { expectedWaitSeconds } from '../shared/domain/waitEstimates.js';
import type { BaseRoute, BaseSegment, Place } from '../shared/domain/index.js';
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
import { routeQueryIsReusable } from './connectivity/query-reuse.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';

/** Below this the rider is already at the stop; no access walk is added. */
// A nearby stop still needs a fetched foot edge; proximity never creates a graph link.
const ACCESS_THRESHOLD_METERS = 0.1;
const MAX_REALTIME_LOOKUPS = 8;
const EXISTING_WALK_REVIEW_SECONDS = 600;

export interface EnrichmentContext {
  provider: RouteProvider;
  budget: CallBudget;
  realtime?: RealtimeService;
  now: number;
  acquisitionObjective?: RoutingObjective;
  onWalkingAlternatives?: MultimodalContext['onWalkingAlternatives'];
  /** Reserve the rest of the shared budget for bridges between transport modes. */
  maxAccessCalls?: number;
  /** Belongs to one search; attempted walks are shared by both endpoint coordinates across passes and transit fragments. */
  accessCache?: TransitAccessCache;
  /** Candidate ordering only; a priority estimate never becomes a route duration or edge. */
  accessPriority?: (route: BaseRoute) => number;
  /** After the priority winner, verify the best source containing its missing bus/subway mode. */
  accessModeCoverage?: boolean;
  /** Reports an actual capped fallback, never an ordinary provider failure or cache hit. */
  onAccessLimited?: (reason: 'access-cap' | 'route-budget') => void;
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

function stopTitle(segment: BaseSegment, edge: 'start' | 'end'): string {
  const name = segment[edge].name;

  return segment.mode === 'subway' ? `${stationBaseName(name)}역` : name;
}

/** Kakao ignores the time of day; night-only buses are removed outside their service window. */
export function applyServiceHours(routes: BaseRoute[], now: number): BaseRoute[] {
  if (isNightServiceHour(now)) {
    return routes;
  }

  return routes.flatMap((route) => {
    let changed = false;
    const segments: BaseSegment[] = [];

    for (const segment of route.segments) {
      if (segment.mode !== 'bus' || !segment.transit) {
        segments.push(segment);
        continue;
      }

      const lines = segment.transit.lines.filter((line) => !isNightOnlyLine(line));

      if (!lines.length) {
        return [];
      }

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
        transit: {
          ...segment.transit,
          lines,
        },
        instructions: `${stops[0] ?? segment.start.name}에서 ${lines.length > 1 ? `${lines.join(', ')} 중 먼저 오는 버스를` : `${label}를`} 타고 ${stops.at(-1) ?? segment.end.name}에서 내려요. (${Math.max(1, stops.length - 1)}개 정류장)`,
      });
    }

    if (!changed) {
      return [route];
    }

    const title = segments
      .filter(isVehicle)
      .map((segment) =>
        segment.mode === 'bus'
          ? busLabel(segment.transit?.lines.slice(0, 2) ?? [])
          : (segment.transit?.lines[0] ?? '지하철'),
      )
      .join(' → ');

    return [
      {
        ...route,
        title: title || route.title,
        segments,
      },
    ];
  });
}

interface AccessLeg {
  segments: BaseSegment[];
  seconds: number;
  routed: boolean;
}

export type TransitAccessCache = Map<string, Promise<AccessLeg>>;

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
        durationSeconds: {
          min: seconds,
          max: seconds,
        },
        start: from,
        end: to,
        runAllowed: false,
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
  const endpoints = {
    origin: from,
    destination: to,
  };

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

    if (!merged) {
      return estimatedWalk(id, from, to, title);
    }

    return {
      seconds: merged.durationSeconds.min,
      segments: [merged],
      routed: true,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'CALL_BUDGET_EXCEEDED') {
        context.onAccessLimited?.('route-budget');
      }

      return estimatedWalk(id, from, to, title);
    }

    throw error;
  }
}

function boardingQuery(segment: BaseSegment): BoardingQuery | null {
  if (!isVehicle(segment) || !segment.transit?.stops.length || !segment.transit.lines.length) {
    return null;
  }

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

  if (diverseIndex > 1) {
    routes.splice(1, 0, routes.splice(diverseIndex, 1)[0]);
  }

  // Shared access/egress walks are fetched once, fastest candidates first.
  const legs = new Map<string, Promise<AccessLeg>>();
  let accessCalls = 0;

  const accessLeg = (id: string, from: Place, to: Place, title: string): Promise<AccessLeg> => {
    const cached = context.accessCache?.get(id);

    if (cached) {
      return cached;
    }

    const reusable = routeQueryIsReusable(
      context.provider,
      'walking',
      {
        origin: from,
        destination: to,
      },
      context.budget,
    );

    if (
      !reusable &&
      (accessCalls >= (context.maxAccessCalls ?? Infinity) || context.budget.remaining <= 0)
    ) {
      context.onAccessLimited?.(context.budget.remaining <= 0 ? 'route-budget' : 'access-cap');

      return Promise.resolve(estimatedWalk(id, from, to, title));
    }

    if (!reusable) {
      accessCalls++;
    }

    const pending = walkLeg(context, id, from, to, title);

    context.accessCache?.set(id, pending);

    return pending;
  };

  // A cache can also serve rental-to-transit fragments in this same search.
  // Both ends belong to its identity; sharing only the station would reuse a
  // walk from the wrong journey origin or to the wrong destination.
  const legKey = (kind: 'access' | 'egress', from: Place, to: Place) =>
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

    if (!vehicles.length) {
      return;
    }

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
        (kind === 'access' && index >= vehicles[0]) ||
        (kind === 'egress' && index <= vehicles.at(-1)!)
      ) {
        continue;
      }

      const from = kind === 'access' ? request.origin : segment.start;
      const to = kind === 'access' ? segment.end : request.destination;
      const key = legKey(kind, from, to);

      if (!legs.has(key)) {
        legs.set(key, accessLeg(key, from, to, segment.title));
      }

      if (!reviewedWalks.has(route)) {
        reviewedWalks.set(route, new Map());
      }

      reviewedWalks.get(route)!.set(index, key);
    }
  };

  const planRoute = (route: BaseRoute) => {
    const first = route.segments.find((segment) => !isAllowance(segment))!;
    const last = [...route.segments].reverse().find((segment) => !isAllowance(segment))!;
    const boarding: Place = {
      ...first.start,
      latitude: first.polyline?.[0]?.latitude ?? first.start.latitude,
      longitude: first.polyline?.[0]?.longitude ?? first.start.longitude,
    };
    const lastPoint = last.polyline?.at(-1) ?? last.end;
    const alighting: Place = {
      ...last.end,
      latitude: lastPoint.latitude,
      longitude: lastPoint.longitude,
    };
    const needsAccess =
      first.mode !== 'walk' && metersBetween(request.origin, boarding) > ACCESS_THRESHOLD_METERS;
    const needsEgress =
      last.mode !== 'walk' &&
      metersBetween(alighting, request.destination) > ACCESS_THRESHOLD_METERS;
    const accessKey = legKey('access', request.origin, boarding),
      egressKey = legKey('egress', alighting, request.destination);

    if (needsAccess && !legs.has(accessKey)) {
      legs.set(
        accessKey,
        accessLeg(
          `${accessKey}`,
          request.origin,
          boarding,
          `${stopTitle(first, 'start')}까지 걷기`,
        ),
      );
    }

    if (needsEgress && !legs.has(egressKey)) {
      legs.set(
        egressKey,
        accessLeg(
          `${egressKey}`,
          alighting,
          request.destination,
          `${request.destination.name}까지 걷기`,
        ),
      );
    }

    return {
      route,
      needsAccess,
      needsEgress,
      accessKey,
      egressKey,
    };
  };

  // Complete the winner's and missing mode's exterior queries first. Otherwise
  // later rail variants with existing long walks could spend every access slot
  // before a vehicle-only bus source reaches the ordinary planning pass.
  const coveredPlans = new Map<BaseRoute, ReturnType<typeof planRoute>>();

  if (diverseIndex > 0) {
    for (const route of routes.slice(0, 2)) {
      reviewExistingWalks(route);
      coveredPlans.set(route, planRoute(route));
    }
  }

  for (const route of routes) {
    if (!coveredPlans.has(route)) {
      reviewExistingWalks(route);
    }
  }

  const plans = routes.map((route) => coveredPlans.get(route) ?? planRoute(route));
  const resolved = new Map<string, AccessLeg>();

  await Promise.all(
    [...legs].map(async ([key, leg]) => {
      resolved.set(key, await leg);
    }),
  );

  const availableQueries = new Map<string, BoardingQuery>();

  for (const { route } of plans) {
    for (const segment of route.segments) {
      const query = boardingQuery(segment);

      if (query && !availableQueries.has(boardingKey(query))) {
        availableQueries.set(boardingKey(query), query);
      }
    }
  }

  const queries = new Map([...availableQueries].slice(0, MAX_REALTIME_LOOKUPS));

  // Keep the priority order when it already covers both source modes. Otherwise
  // one itinerary's many rail/bus boardings must not consume every observation
  // slot before the competing mode can replace its estimated wait.
  for (const mode of ['bus', 'subway'] as const) {
    if ([...queries.values()].some((query) => query.mode === mode)) {
      continue;
    }

    const missing = [...availableQueries].find(([, query]) => query.mode === mode);

    if (!missing) {
      continue;
    }

    if (queries.size >= MAX_REALTIME_LOOKUPS) {
      queries.delete([...queries.keys()].at(-1)!);
    }

    queries.set(...missing);
  }

  const arrivals = new Map<string, Awaited<ReturnType<RealtimeService['lookup']>>>();

  if (context.realtime) {
    await Promise.all(
      [...queries].map(async ([key, query]) => {
        arrivals.set(key, await context.realtime!.lookup(query));
      }),
    );
  }

  const enriched: BaseRoute[] = [];

  for (const { route, needsAccess, needsEgress, accessKey, egressKey } of plans) {
    const access = needsAccess ? resolved.get(accessKey)! : null;
    const egress = needsEgress ? resolved.get(egressKey)! : null;
    const allowance = route.segments.find(isAllowance);
    const remainingAllowance = Math.max(
      0,
      (allowance?.durationSeconds.min ?? 0) - (access?.seconds ?? 0) - (egress?.seconds ?? 0),
    );
    const remainingMaximumAllowance = Math.max(
      remainingAllowance,
      (allowance?.durationSeconds.max ?? 0) -
        (access ? sumSeconds(access.segments, 'max') : 0) -
        (egress ? sumSeconds(egress.segments, 'max') : 0),
    );

    let segments = route.segments.flatMap((segment, index) => {
      if (isAllowance(segment)) {
        return [];
      }

      const key = reviewedWalks.get(route)?.get(index),
        reviewed = key ? resolved.get(key) : undefined;
      const actual = reviewed?.routed ? reviewed.segments[0] : undefined;

      // A failed lookup or a fallback with no pedestrian provenance cannot
      // relabel the provider's original walk as a verified outdoor connection.
      return [
        {
          ...(actual?.routingSource && actual.networkSnap ? actual : segment),
          id: segment.id,
        },
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

        if (!boardingObservationIsFresh(live, context.now)) {
          continue;
        }

        if (live.status === 'no-service') {
          noService = true;
          break;
        }

        segments[index].realtime = live;
      }

      if (noService) {
        continue;
      }

      // Kakao folds platform access and waiting into one unlabeled lump. Each boarding gets the
      // usual half-headway wait (which live data can replace); the rest of the lump is time to
      // reach the platform for subway legs (at most 5 min each) and extra waiting for buses.
      const expected = vehicles.map((index) => expectedWaitSeconds(segments[index], context.now));
      const totalExpected = expected.reduce((sum, value) => sum + value, 0);
      const surplus = Math.max(0, remainingAllowance - totalExpected);
      const extraRange = remainingMaximumAllowance - remainingAllowance;

      // Cumulative allocation preserves the complete source range despite rounding.
      const rangeShares = expected.map(
        (value, index) =>
          Math.round(
            (extraRange * expected.slice(0, index + 1).reduce((sum, item) => sum + item, 0)) /
              totalExpected,
          ) -
          Math.round(
            (extraRange * expected.slice(0, index).reduce((sum, item) => sum + item, 0)) /
              totalExpected,
          ),
      );

      for (let k = vehicles.length - 1; k >= 0; k -= 1) {
        const vehicle = segments[vehicles[k]];
        const share = Math.round((surplus * expected[k]) / totalExpected);
        const platform = vehicle.mode === 'subway' ? Math.min(share, 300) : 0;
        const wait = expected[k] + share - platform;
        const added: BaseSegment[] = [];

        if (platform >= 30) {
          added.push({
            id: `${route.id}-entry-${k}`,
            mode: 'entry',
            title: `${stopTitle(vehicle, 'start')} 승강장으로 이동`,
            instructions: '개찰구를 지나 승강장까지 가는 예상 시간이에요.',
            distanceMeters: 0,
            runAllowed: false,
            durationSeconds: {
              min: platform,
              max: platform,
            },
            start: vehicle.start,
            end: vehicle.start,
          });
        }

        added.push({
          id: `${route.id}-wait-${k}${EXPECTED_WAIT_SUFFIX}`,
          mode: 'wait',
          title: k === 0 ? '승차 대기' : '환승 대기',
          instructions: '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
          distanceMeters: 0,
          runAllowed: false,
          expectedWaitBasisSeconds: expected[k],
          durationSeconds: {
            min: wait + (platform < 30 ? platform : 0),
            max: wait + (platform < 30 ? platform : 0) + rangeShares[k],
          },
          start: vehicle.start,
          end: vehicle.start,
        });
        segments.splice(vehicles[k], 0, ...added);
      }
    } else if (remainingMaximumAllowance > 0 && allowance) {
      segments.push({
        ...allowance,
        durationSeconds: {
          min: remainingAllowance,
          max: remainingMaximumAllowance,
        },
      });
    }

    segments = [
      ...(access?.segments.map((segment) => ({
        ...segment,
        id: `${route.id}-access`,
      })) ?? []),
      ...segments,
      ...(egress?.segments.map((segment) => ({
        ...segment,
        id: `${route.id}-egress`,
      })) ?? []),
    ];
    enriched.push({
      ...route,
      segments,
      durationSeconds: {
        min: sumSeconds(segments, 'min'),
        max: sumSeconds(segments, 'max'),
      },
      distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    });
  }

  return enriched;
}
