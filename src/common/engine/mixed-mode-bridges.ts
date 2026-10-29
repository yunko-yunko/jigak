import type { BaseRoute, BaseSegment, Place } from '../shared/domain/index.js';
import { ApiError } from './errors.js';
import { metersBetween } from './realtime/names.js';
import { scooterConnection, type ScooterConnectionContext } from './scooter-bridge.js';
import {
  bicycleAccessStationCandidates,
  bicycleConnection,
  bicycleNotes,
  resolveBicycleStationPairs,
  multimodalRoutes,
  multimodalTitle,
  taxiConnection,
  taxiNote,
  taxiSplices,
  totals,
  vehiclePoint,
  walkBetween,
  type BicycleWalkingConnections,
  type MultimodalRequest,
} from './multimodal.js';
import type { BikeStation } from './realtime/mobility.js';
import type { RouteEndpoints } from './kakao.js';
import { routeQueryIsReusable, type RouteQueryMode } from './connectivity/query-reuse.js';
import { needsRentalAccessComparison, rentalAccessSeconds } from './rental-access.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming, contextualAcquisitionTimings } from './acquisition-priority.js';

interface BridgePair {
  from: Place;
  to: Place;
  priority: number;
  /** Preserve the existing source-bound exploration threshold when only ordering changes. */ possibleSaving?: number;
  /** Fetch order only, never a routed duration or a pruning bound. */ journeyPriority?: number;
  walkGap?: boolean;
  crossTransfer?: boolean;
  direct?: boolean;
  continuation?: 'first' | 'last';
}

export interface BridgeGenerationDiagnostics {
  rentalCandidates: number;
  rentalAttempts: number;
  rentalConnections: number;
  accessProbes: number;
  accessImprovements: number;
  accessProbeLimitReached: boolean;
  unavailableRentals: number;
  providerFailures: number;
  failures: {
    mode: 'bicycle' | 'scooter' | 'taxi' | 'car' | 'walk';
    code: ApiError['code'];
  }[];
  budgetSkipped: number;
  candidateLimitSkipped: number;
  /** Nearby unique anchor pairs inspected without materializing their cross-product. */
  walkingPairChecks: number;
  /** Peak number of retained walking candidate pairs, independent of input size. */
  walkingCandidatePeak: number;
  limitReached: boolean;
}

export interface MixedModeBridgeContext extends ScooterConnectionContext {
  acquisitionObjective?: RoutingObjective;
  onDiagnostics?: (diagnostics: BridgeGenerationDiagnostics) => void;
  /** Reclaim unused rental capacity for missing transit access before optional road comparisons. */
  onRentalsComplete?: () => Promise<void>;
  /** A fresh transit query from/to an actual street-level rental station, never an invented platform connector. */
  connectTransit?: (endpoints: RouteEndpoints) => Promise<BaseRoute[]>;
  /** A cached/pending query costs no new route call; never used as a travel time. */
  queryCallCost?: (mode: RouteQueryMode, endpoints: RouteEndpoints) => 0 | 1;
}

const MAX_RENTAL_CANDIDATES_PER_MODE = 8;
const MAX_RENTAL_INSPECTIONS_PER_MODE = 32;
const MAX_WALKING_BRIDGES = 2;

const pointKey = (point: Place) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

const isTransit = (mode: string) => mode === 'bus' || mode === 'subway';

const at = (
  left: Pick<Place, 'latitude' | 'longitude'>,
  right: Pick<Place, 'latitude' | 'longitude'>,
) =>
  Math.abs(left.latitude - right.latitude) < 0.000001 &&
  Math.abs(left.longitude - right.longitude) < 0.000001;

const validPoint = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;

const pairKey = (pair: Pick<BridgePair, 'from' | 'to'>) =>
  `${pointKey(pair.from)}>${pointKey(pair.to)}`;

const uniquePairs = (pairs: BridgePair[]) => {
  const seen = new Set<string>();

  return pairs
    .sort(
      (a, b) =>
        Number(!!b.walkGap) - Number(!!a.walkGap) ||
        Number(!!b.direct) - Number(!!a.direct) ||
        (a.journeyPriority ?? Infinity) - (b.journeyPriority ?? Infinity) ||
        b.priority - a.priority,
    )
    .filter((pair) => {
      const key = pairKey(pair);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
};

/** A newly acquired half-journey must not outrank an entire journey merely
 * because its missing half costs nothing in the ordering score. Use only the
 * supplied route endpoints to find that context. This is a query-order hint;
 * graph search still checks every actual segment, wait and connection.
 */
const contextualTimings = contextualAcquisitionTimings;

/** A station coordinate is not evidence of a street entrance or a platform exit. */
function outdoorAnchor(
  point: Place,
  request: MultimodalRequest,
  transit: readonly BaseRoute[],
): boolean {
  if (at(point, request.origin) || at(point, request.destination)) {
    return true;
  }

  return !transit.some((route) =>
    route.segments.some(
      (segment) =>
        segment.mode === 'subway' &&
        (at(point, vehiclePoint(segment, 'start')) || at(point, vehiclePoint(segment, 'end'))),
    ),
  );
}

/** A routed outdoor walk is stronger evidence than a station's bare coordinate. */
function rentalWalkPair(
  segment: BaseSegment,
  route: BaseRoute,
  request: MultimodalRequest,
  transit: BaseRoute[],
  now: number,
  timing: ReturnType<typeof acquisitionTiming>,
  index: number,
): BridgePair | null {
  const path = segment.polyline;

  if (
    segment.mode !== 'walk' ||
    segment.distanceMeters <= 0 ||
    (segment.distanceMeters < 600 && segment.durationSeconds.max < 600) ||
    !Number.isFinite(segment.distanceMeters) ||
    !Number.isFinite(segment.durationSeconds.min) ||
    !Number.isFinite(segment.durationSeconds.max) ||
    segment.durationSeconds.min < 0 ||
    segment.durationSeconds.max < segment.durationSeconds.min ||
    !path ||
    path.length < 2 ||
    !path.every(validPoint) ||
    !validPoint(segment.start) ||
    !validPoint(segment.end) ||
    segment.traffic?.some((span) => span.level === 'blocked') ||
    metersBetween(path[0], segment.start) > 75 ||
    metersBetween(path.at(-1)!, segment.end) > 75 ||
    route.notes?.some(
      (note) =>
        note.title === '역 내부 보행 연결 미확인' &&
        (!note.segmentId || note.segmentId === segment.id),
    )
  ) {
    return null;
  }

  const touchesStation =
    !outdoorAnchor(segment.start, request, transit) ||
    !outdoorAnchor(segment.end, request, transit);

  if (touchesStation) {
    const source = segment.routingSource,
      snap = segment.networkSnap;

    if (
      !source ||
      source.mode !== 'live' ||
      !source.provider ||
      !Number.isFinite(source.receivedAt) ||
      source.receivedAt > now + 30_000 ||
      source.isRealtime ||
      !snap ||
      ![snap.startMeters, snap.endMeters, snap.allowanceSeconds].every(
        (value) => Number.isFinite(value) && value >= 0,
      ) ||
      Math.abs(metersBetween(segment.start, path[0]) - snap.startMeters) > 2 ||
      Math.abs(metersBetween(segment.end, path.at(-1)!) - snap.endMeters) > 2 ||
      snap.allowanceSeconds < snap.startMeters + snap.endMeters ||
      snap.allowanceSeconds > segment.durationSeconds.max - segment.durationSeconds.min
    ) {
      return null;
    }
  }

  const priority = timing.segments[index] - segment.distanceMeters / 3.6 - 150;
  const possibleSaving = segment.durationSeconds.max - segment.distanceMeters / 3.6 - 150;

  return possibleSaving >= 120
    ? {
        from: segment.start,
        to: segment.end,
        priority,
        journeyPriority: timing.total - priority,
        walkGap: true,
      }
    : null;
}

/** Only real provider boarding/alighting anchors become places to change transport. */
export function transferBridgePairs(
  request: MultimodalRequest,
  transit: BaseRoute[],
  now = Date.now(),
  objective: RoutingObjective = 'estimated-arrival',
): BridgePair[] {
  const pairs: BridgePair[] = [];
  const timings = contextualTimings(request, transit, now, objective);
  const rentalReach = Math.max(
    request.preferences.maxBicycleMeters,
    request.preferences.allowScooter !== false ? 6000 : 0,
  );

  // Walking gaps from every supplied itinerary are cheap to inspect. Apply the
  // explicit per-mode candidate cap later, where omissions can be reported.
  for (const route of transit) {
    for (const [index, segment] of route.segments.entries()) {
      const pair = rentalWalkPair(
        segment,
        route,
        request,
        transit,
        now,
        timings.get(route)!,
        index,
      );

      if (pair) {
        pairs.push(pair);
      }
    }
  }

  for (const route of [...transit].sort((a, b) => timings.get(a)!.total - timings.get(b)!.total)) {
    const timing = timings.get(route)!,
      journeySeconds = timing.total;
    const vehicleIndices = route.segments.flatMap((segment, index) =>
      isTransit(segment.mode) ? [index] : [],
    );

    vehicleIndices.forEach((index, order) => {
      const segment = route.segments[index];
      const from = vehiclePoint(segment, 'start'),
        to = vehiclePoint(segment, 'end');
      const distance = metersBetween(from, to);

      if (
        distance >= 600 &&
        distance <= rentalReach &&
        metersBetween(to, request.destination) >= 350
      ) {
        // Prioritization only. This straight-line bound is never an ETA or route edge.
        const saving = timing.segments[index] - distance / 3.6 - 150;

        pairs.push({
          from,
          to,
          priority: saving + (order > 0 ? 240 : 0),
          possibleSaving:
            segment.durationSeconds.max - distance / 3.6 - 150 + (order > 0 ? 240 : 0),
          journeyPriority: journeySeconds - saving,
        });
      }

      for (const point of [from, to]) {
        const first = metersBetween(request.origin, point),
          last = metersBetween(point, request.destination);
        const cut = point === from ? index : index + 1;
        const prefix =
          timing.prefix + timing.segments.slice(0, cut).reduce((sum, part) => sum + part, 0);
        const suffix =
          timing.suffix + timing.segments.slice(cut).reduce((sum, part) => sum + part, 0);

        if (first >= 600 && first <= rentalReach && last >= 500) {
          const cost = first / 3.6 + 150,
            priority = (Number.isFinite(prefix) ? prefix : 0) - cost;
          const possibleSaving =
            route.segments.slice(0, cut).reduce((sum, part) => sum + part.durationSeconds.max, 0) -
            cost;

          pairs.push({
            from: request.origin,
            to: point,
            priority,
            possibleSaving,
            journeyPriority: suffix + cost,
          });
        }

        if (first >= 500 && last >= 600 && last <= rentalReach) {
          const cost = last / 3.6 + 150,
            priority = (Number.isFinite(suffix) ? suffix : 0) - cost;
          const possibleSaving =
            route.segments.slice(cut).reduce((sum, part) => sum + part.durationSeconds.max, 0) -
            cost;

          pairs.push({
            from: point,
            to: request.destination,
            priority,
            possibleSaving,
            journeyPriority: prefix + cost,
          });
        }
      }
    });
  }

  return uniquePairs(pairs);
}

/** Query-order hints only; every selected connection still needs a real foot route. */
function walkingBridgePairs(
  request: MultimodalRequest,
  transit: readonly BaseRoute[],
  now: number,
  objective: RoutingObjective,
) {
  const pairs: BridgePair[] = [];

  const compare = (left: BridgePair, right: BridgePair) =>
    (left.journeyPriority ?? Infinity) - (right.journeyPriority ?? Infinity) ||
    right.priority - left.priority;

  let candidateCount = 0,
    pairChecks = 0,
    candidatePeak = 0;

  const retain = (pair: BridgePair) => {
    if (pairs.length === MAX_WALKING_BRIDGES && compare(pair, pairs[pairs.length - 1]) >= 0) {
      return;
    }

    const existing = pairs.findIndex((value) => pairKey(value) === pairKey(pair));

    if (existing >= 0) {
      if (compare(pair, pairs[existing]) >= 0) {
        return;
      }

      pairs[existing] = pair;
    } else if (pairs.length < MAX_WALKING_BRIDGES) {
      pairs.push(pair);
    } else if (compare(pair, pairs[pairs.length - 1]) < 0) {
      pairs[pairs.length - 1] = pair;
    } else {
      return;
    }

    pairs.sort(compare);
    candidatePeak = Math.max(candidatePeak, pairs.length);
  };

  const timings = contextualTimings(request, transit, now, objective);

  type AnchorContext = {
    point: Place;
    route: BaseRoute;
    seconds: number;
    total: number;
  };
  type Anchor = {
    point: Place;
    key: string;
    contexts: AnchorContext[];
  };

  const alighting = new Map<string, Anchor>(),
    boarding = new Map<string, Anchor>();
  const localPairs = new Map<string, BridgePair>();

  const subwayPoints = transit.flatMap((route) =>
    route.segments.flatMap((segment) =>
      segment.mode === 'subway'
        ? [vehiclePoint(segment, 'start'), vehiclePoint(segment, 'end')]
        : [],
    ),
  );

  const outdoor = (point: Place) =>
    validPoint(point) &&
    (at(point, request.origin) ||
      at(point, request.destination) ||
      !subwayPoints.some((station) => at(point, station)));

  const addAnchor = (
    anchors: Map<string, Anchor>,
    point: Place,
    route: BaseRoute,
    seconds: number,
    total: number,
  ) => {
    if (!Number.isFinite(seconds)) {
      return;
    }

    const key = pointKey(point),
      anchor = anchors.get(key) ?? {
        point,
        key,
        contexts: [],
      };

    const context = {
        point,
        route,
        seconds,
        total,
      },
      existing = anchor.contexts.findIndex((value) => value.route === route);

    const compareContext = (left: AnchorContext, right: AnchorContext) =>
      left.seconds - right.seconds || right.total - left.total;

    if (existing >= 0) {
      if (compareContext(context, anchor.contexts[existing]) >= 0) {
        return;
      }

      anchor.contexts[existing] = context;
    } else {
      anchor.contexts.push(context);
    }

    // The cheapest context and cheapest different source suffice to find the
    // minimum sum with source A != source B. Higher source totals break ties by
    // the same potential-saving priority as the full candidate enumeration.
    anchor.contexts.sort(compareContext);

    if (anchor.contexts.length > 2) {
      anchor.contexts.pop();
    }

    anchors.set(key, anchor);
  };

  const suppliedWalks = new Set<string>();

  for (const route of transit) {
    for (const [index, segment] of route.segments.entries()) {
      if (segment.mode !== 'walk') {
        continue;
      }

      const pair = {
        from: segment.start,
        to: segment.end,
        priority: 0,
      };
      const extra = route.segments[index + 1];
      const segments = [
        segment,
        ...(extra?.mode === 'wait' && extra.id.endsWith('-provider-extra') ? [extra] : []),
      ];

      if (
        actualWalkingSegments(
          {
            ...route,
            segments,
          },
          pair,
          'supplied',
        )
      ) {
        suppliedWalks.add(pairKey(pair));
      }
    }
  }

  for (const route of [...transit].sort((a, b) => timings.get(a)!.total - timings.get(b)!.total)) {
    const timing = timings.get(route)!;

    for (let index = 0; index < route.segments.length; index++) {
      const segment = route.segments[index];

      if (segment.mode !== 'bus') {
        continue;
      }

      const from = vehiclePoint(segment, 'start'),
        to = vehiclePoint(segment, 'end');
      let before = index;

      while (
        before > 0 &&
        route.segments[before - 1].mode === 'wait' &&
        at(route.segments[before - 1].start, from) &&
        at(route.segments[before - 1].end, from)
      ) {
        before--;
      }

      let after = index + 1;

      // A provider's vehicle allowance belongs to the arriving ride, not to a
      // new transfer that could accidentally avoid it.
      if (
        route.segments[after]?.mode === 'wait' &&
        route.segments[after].id.endsWith('-provider-extra') &&
        at(route.segments[after].start, to) &&
        at(route.segments[after].end, to)
      ) {
        after++;
      }

      if (!at(from, request.origin) && outdoor(from)) {
        addAnchor(
          boarding,
          from,
          route,
          timing.suffix + timing.segments.slice(before).reduce((sum, seconds) => sum + seconds, 0),
          timing.total,
        );
      }

      if (!at(to, request.destination) && outdoor(to)) {
        addAnchor(
          alighting,
          to,
          route,
          timing.prefix +
            timing.segments.slice(0, after).reduce((sum, seconds) => sum + seconds, 0),
          timing.total,
        );
      }

      const distance = metersBetween(from, to);

      if (distance < 150 || distance > 1600 || !outdoor(from) || !outdoor(to)) {
        continue;
      }

      let replacedSeconds = timing.segments[index],
        possibleSeconds = segment.durationSeconds.max;

      for (
        let before = index - 1;
        before >= 0 &&
        route.segments[before].mode === 'wait' &&
        at(route.segments[before].start, from) &&
        at(route.segments[before].end, from);
        before--
      ) {
        replacedSeconds += timing.segments[before];
        possibleSeconds += route.segments[before].durationSeconds.max;
      }

      const priority = replacedSeconds - distance / 1.2;

      if (possibleSeconds - distance / 1.2 >= 120) {
        const pair = {
            from,
            to,
            priority,
            journeyPriority: timing.total - priority,
          },
          key = pairKey(pair),
          existing = localPairs.get(key);

        if (!existing || compare(pair, existing) < 0) {
          localPairs.set(key, pair);
        }
      }
    }
  }

  candidateCount = localPairs.size;

  for (const pair of localPairs.values()) {
    retain(pair);
  }

  // Earth-centred 1600 m cells work across longitude wrap and at the poles.
  // A <=1600 m surface arc has a <=1600 m chord, so only adjacent cells can
  // contain a candidate. The exact spherical distance remains the final gate.
  const cell = (point: Place) => {
    const latitude = (point.latitude * Math.PI) / 180,
      longitude = (point.longitude * Math.PI) / 180,
      scale = 6371000 / 1600;

    return [
      Math.floor(scale * Math.cos(latitude) * Math.cos(longitude)),
      Math.floor(scale * Math.cos(latitude) * Math.sin(longitude)),
      Math.floor(scale * Math.sin(latitude)),
    ];
  };

  const buckets = new Map<string, Anchor[]>();

  for (const anchor of boarding.values()) {
    const key = cell(anchor.point).join(','),
      bucket = buckets.get(key) ?? [];

    bucket.push(anchor);
    buckets.set(key, bucket);
  }

  for (const arrival of alighting.values()) {
    const [x, y, z] = cell(arrival.point);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const departure of buckets.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
            pairChecks++;

            const distance = metersBetween(arrival.point, departure.point);

            if (distance < 150 || distance > 1600) {
              continue;
            }

            const key = `${arrival.key}>${departure.key}`;

            // The graph already reuses supplied walks; duplicates do not earn calls.
            if (suppliedWalks.has(key)) {
              continue;
            }

            let best: BridgePair | undefined;

            for (const prefix of arrival.contexts) {
              for (const suffix of departure.contexts) {
                if (prefix.route === suffix.route) {
                  continue;
                }

                const journeyPriority = prefix.seconds + distance / 1.2 + suffix.seconds;
                const priority = Math.min(prefix.total, suffix.total) - journeyPriority;

                const pair = {
                  from: prefix.point,
                  to: suffix.point,
                  priority,
                  journeyPriority,
                  crossTransfer: true,
                };

                if (!best || compare(pair, best) < 0) {
                  best = pair;
                }
              }
            }

            if (!best) {
              continue;
            }

            if (!localPairs.has(key)) {
              candidateCount++;
            }

            retain(best);
          }
        }
      }
    }
  }

  return {
    pairs,
    candidateCount,
    pairChecks,
    candidatePeak,
  };
}

function actualWalkingSegments(
  route: BaseRoute | undefined,
  pair: BridgePair,
  prefix: string,
): BaseSegment[] | null {
  if (!route?.segments.length || !route.segments.some((segment) => segment.mode === 'walk')) {
    return null;
  }

  const segments = route.segments;

  if (
    segments.some(
      (segment, index) =>
        !validPoint(segment.start) ||
        !validPoint(segment.end) ||
        !Number.isFinite(segment.distanceMeters) ||
        segment.distanceMeters < 0 ||
        !Number.isFinite(segment.durationSeconds.min) ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.min < 0 ||
        segment.durationSeconds.max < segment.durationSeconds.min ||
        (index > 0 && !at(segments[index - 1].end, segment.start)) ||
        segment.traffic?.some((span) => span.level === 'blocked') ||
        (segment.mode === 'wait' &&
          (segment.distanceMeters !== 0 ||
            !at(segment.start, segment.end) ||
            segment.timingRule !== undefined ||
            !segment.id.endsWith('-provider-extra') ||
            segments[index - 1]?.mode !== 'walk')) ||
        (segment.mode !== 'walk' && segment.mode !== 'wait') ||
        (segment.mode === 'walk' &&
          (!segment.polyline ||
            segment.polyline.length < 2 ||
            !segment.polyline.every(validPoint) ||
            metersBetween(segment.polyline[0], segment.start) > 75 ||
            metersBetween(segment.polyline.at(-1)!, segment.end) > 75)),
    )
  ) {
    return null;
  }

  const firstWalk = segments.find((segment) => segment.mode === 'walk')!,
    lastWalk = segments.filter((segment) => segment.mode === 'walk').at(-1)!;

  if (
    metersBetween(segments[0].start, pair.from) > 75 ||
    metersBetween(segments.at(-1)!.end, pair.to) > 75 ||
    metersBetween(firstWalk.polyline![0], pair.from) > 75 ||
    metersBetween(lastWalk.polyline!.at(-1)!, pair.to) > 75 ||
    segments.reduce((sum, segment) => sum + segment.distanceMeters, 0) > 2000
  ) {
    return null;
  }

  const lastPoint = lastWalk.end;
  const firstIndex = segments.indexOf(firstWalk),
    lastIndex = segments.indexOf(lastWalk);

  return segments.map((segment, index) => ({
    ...segment,
    id: `${prefix}-${index}${segment.id.endsWith('-provider-extra') ? '-provider-extra' : ''}`,
    start:
      index === firstIndex
        ? pair.from
        : segment.mode === 'wait' && index > lastIndex && at(segment.start, lastPoint)
          ? pair.to
          : segment.start,
    end:
      index === lastIndex ||
      (segment.mode === 'wait' && index > lastIndex && at(segment.end, lastPoint))
        ? pair.to
        : segment.end,
  }));
}

/**
 * Fetches actual bridges between transit legs. The graph can reuse these in several
 * combinations; each bridge is fully routed, not a faster copy of another mode.
 */
export async function buildMixedModeBridges(
  request: MultimodalRequest,
  transit: BaseRoute[],
  context: MixedModeBridgeContext,
): Promise<BaseRoute[]> {
  const diagnostics: BridgeGenerationDiagnostics = {
    rentalCandidates: 0,
    rentalAttempts: 0,
    rentalConnections: 0,
    accessProbes: 0,
    accessImprovements: 0,
    accessProbeLimitReached: false,
    unavailableRentals: 0,
    providerFailures: 0,
    failures: [],
    budgetSkipped: 0,
    candidateLimitSkipped: 0,
    walkingPairChecks: 0,
    walkingCandidatePeak: 0,
    limitReached: false,
  };

  const finish = () => {
    diagnostics.limitReached =
      diagnostics.budgetSkipped > 0 ||
      diagnostics.candidateLimitSkipped > 0 ||
      diagnostics.accessProbeLimitReached;
    context.onDiagnostics?.({
      ...diagnostics,
    });
  };

  if (request.preferences.walkingOnly) {
    finish();

    return [];
  }

  const bridges: BaseRoute[] = [];

  const allPairs = transferBridgePairs(
    {
      ...request,
      preferences: {
        ...request.preferences,
        ...(!context.provider.scooter || !context.scooterPolicy
          ? {
              allowScooter: false,
            }
          : {}),
      },
    },
    transit,
    context.now,
    context.acquisitionObjective,
  );

  const pairs = allPairs.flatMap((pair) => {
    if (
      pair.walkGap ||
      (outdoorAnchor(pair.from, request, transit) && outdoorAnchor(pair.to, request, transit))
    ) {
      return [pair];
    }

    if (!context.connectTransit || (pair.possibleSaving ?? pair.priority) < 120) {
      return [];
    }

    // A nearby platform only identifies a promising area. Re-query transit at the
    // real pickup/return station; never connect the rental to the platform itself.
    if (at(pair.from, request.origin)) {
      return [
        {
          ...pair,
          continuation: 'first' as const,
        },
      ];
    }

    if (at(pair.to, request.destination)) {
      return [
        {
          ...pair,
          continuation: 'last' as const,
        },
      ];
    }

    return [];
  });

  const blockedModes = new Set<BridgeGenerationDiagnostics['failures'][number]['mode']>();
  const skippedBudgetKeys = new Set<string>();

  const markBudgetSkipped = (key: string) => {
    if (!skippedBudgetKeys.has(key)) {
      skippedBudgetKeys.add(key);
      diagnostics.budgetSkipped++;
    }
  };

  let transitBlocked = false;

  const guarded = async <T>(
    mode: BridgeGenerationDiagnostics['failures'][number]['mode'],
    work: () => Promise<T>,
    domain: 'routing' | 'transit' = 'routing',
    budgetKey = `${domain}:${mode}`,
    onBudgetExceeded?: () => void,
  ): Promise<T | null> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'CALL_BUDGET_EXCEEDED') {
          onBudgetExceeded?.();
          markBudgetSkipped(budgetKey);

          return null;
        }

        diagnostics.providerFailures++;

        if (['PROVIDER_AUTH', 'PROVIDER_FORBIDDEN', 'PROVIDER_LIMIT'].includes(error.code)) {
          if (domain === 'transit') {
            transitBlocked = true;
          } else {
            blockedModes.add(mode);
          }
        }

        if (
          !diagnostics.failures.some(
            (failure) => failure.mode === mode && failure.code === error.code,
          )
        ) {
          diagnostics.failures.push({
            mode,
            code: error.code,
          });
        }

        return null;
      }

      throw error;
    }
  };

  const walkingSearch = walkingBridgePairs(
    request,
    transit,
    context.now,
    context.acquisitionObjective ?? 'estimated-arrival',
  );
  const walkingPairs = walkingSearch.pairs;

  diagnostics.candidateLimitSkipped += walkingSearch.candidateCount - walkingPairs.length;
  diagnostics.walkingPairChecks = walkingSearch.pairChecks;
  diagnostics.walkingCandidatePeak = walkingSearch.candidatePeak;

  const attemptedWalkingPairs = new Set<string>();

  const walking = async (pair: BridgePair, index: number, reportBudget: boolean) => {
    const key = pairKey(pair);

    if (attemptedWalkingPairs.has(key) || blockedModes.has('walk')) {
      return;
    }

    if (
      context.budget.remaining < 1 &&
      !routeQueryIsReusable(
        context.provider,
        'walking',
        {
          origin: pair.from,
          destination: pair.to,
        },
        context.budget,
      )
    ) {
      if (reportBudget) {
        markBudgetSkipped(`walking:${key}`);
      }

      return;
    }

    attemptedWalkingPairs.add(key);

    const routed = await guarded(
      'walk',
      () =>
        context.provider.walking(
          {
            origin: pair.from,
            destination: pair.to,
          },
          context.budget,
        ),
      'routing',
      `walking:${key}`,
    );

    // Keep the provider's bounded sibling paths independent. A slower walk can
    // permit a shorter run that catches an earlier bus; graph timing and the
    // user's running cap decide after footVariants, with every allowance intact.
    for (const [alternative, route] of (routed ?? []).slice(0, 3).entries()) {
      const id = `graph-walk-${index}-${alternative}`;
      const segments = actualWalkingSegments(route, pair, id);

      if (!segments) {
        continue;
      }

      const segmentIds = new Map(
        route.segments.map((segment, position) => [segment.id, segments[position].id]),
      );

      const notes = route.notes?.map((note) =>
        note.segmentId
          ? {
              ...note,
              segmentId: segmentIds.get(note.segmentId) ?? note.segmentId,
            }
          : note,
      );

      bridges.push(
        totals({
          id: `${id}-bridge`,
          title: '정류장 사이 걷기',
          segments,
          transfers: 0,
          notes,
        }),
      );
    }
  };

  const roadPairs = new Set<string>();

  const taxi = async (from: Place, to: Place, id: string) => {
    const key = pairKey({
      from,
      to,
    });

    if (
      blockedModes.has('taxi') ||
      !context.provider.driving ||
      request.preferences.allowTaxi === false ||
      (context.budget.remaining < 1 &&
        !routeQueryIsReusable(
          context.provider,
          'driving',
          {
            origin: from,
            destination: to,
          },
          context.budget,
        )) ||
      metersBetween(from, to) < 350 ||
      roadPairs.has(key)
    ) {
      return;
    }

    roadPairs.add(key);

    const onBudgetLimited = () => {
      roadPairs.delete(key);
      markBudgetSkipped('routing:taxi');
    };

    const segments = await guarded(
      'taxi',
      () => taxiConnection(context, from, to, id, onBudgetLimited),
      'routing',
      undefined,
      onBudgetLimited,
    );

    if (segments) {
      bridges.push(
        totals({
          id,
          title: multimodalTitle(segments),
          transfers: 0,
          fareWon: segments.find((segment) => segment.mode === 'taxi')?.costWon,
          segments,
          notes: [taxiNote],
        }),
      );
    }
  };

  const carReserved =
    !!context.provider.driving && request.preferences.hasCar && request.preferences.carLocation
      ? 2 + Number(metersBetween(request.origin, request.preferences.carLocation) >= 1)
      : 0;

  const rentalPairs = uniquePairs([
    ...pairs,
    {
      from: request.origin,
      to: request.destination,
      priority: -Infinity,
      direct: true,
    },
  ]);

  const queryCost = (mode: RouteQueryMode, origin: Place, destination: Place) =>
    context.queryCallCost?.(mode, {
      origin,
      destination,
    }) ?? 1;

  type RentalJob = {
    mode: 'bicycle' | 'scooter';
    pair: BridgePair;
    stations?: {
      hire: BikeStation;
      drop: BikeStation;
    };
    from: Place;
    to: Place;
    walks?: BicycleWalkingConnections;
    requiredCalls: () => number;
    index: number;
  };

  const place = (station: BikeStation): Place => ({
    id: `ddareungi-${station.id}`,
    name: station.name,
    address: '',
    latitude: station.latitude,
    longitude: station.longitude,
  });

  const bicycleJob = (
    pair: BridgePair,
    stations: NonNullable<RentalJob['stations']>,
    index: number,
    walks?: BicycleWalkingConnections,
  ): RentalJob => {
    const from = pair.continuation === 'last' ? place(stations.hire) : pair.from;
    const to = pair.continuation === 'first' ? place(stations.drop) : pair.to;
    const hire = place(stations.hire),
      drop = place(stations.drop);

    const job: RentalJob = {
      mode: 'bicycle',
      pair,
      stations,
      from,
      to,
      index,
      walks,
      requiredCalls: () =>
        queryCost('bicycle', hire, drop) +
        (!job.walks?.access && metersBetween(from, hire) >= 1
          ? queryCost('walking', from, hire)
          : 0) +
        (!job.walks?.egress && metersBetween(drop, to) >= 1 ? queryCost('walking', drop, to) : 0) +
        (pair.continuation === 'first'
          ? queryCost('transit', to, request.destination)
          : pair.continuation === 'last'
            ? queryCost('transit', request.origin, from)
            : 0),
    };

    return job;
  };

  const jobs: Record<'bicycle' | 'scooter', RentalJob[]> = {
    bicycle: [],
    scooter: [],
  };
  const alternateBicycles: RentalJob[] = [];

  for (const mode of ['bicycle', 'scooter'] as const) {
    const enabled =
      mode === 'bicycle'
        ? request.preferences.allowBicycle &&
          request.preferences.bicycleReady &&
          context.provider.bicycle &&
          context.mobility?.bikes.configured
        : context.provider.scooter &&
          context.scooterPolicy &&
          request.preferences.allowScooter !== false;

    if (!enabled) {
      continue;
    }

    const reach = mode === 'bicycle' ? request.preferences.maxBicycleMeters : 6000;
    const eligible = rentalPairs.filter((pair) => metersBetween(pair.from, pair.to) <= reach);

    diagnostics.rentalCandidates += eligible.length;

    const inspected = eligible.slice(0, MAX_RENTAL_INSPECTIONS_PER_MODE);

    diagnostics.candidateLimitSkipped += eligible.length - inspected.length;

    let prepared = 0;

    for (const pair of inspected) {
      if (mode === 'scooter') {
        if (!pair.continuation) {
          jobs.scooter.push({
            mode,
            pair,
            from: pair.from,
            to: pair.to,
            requiredCalls: () => 1,
            index: prepared++,
          });
        }

        continue;
      }

      // Station lookups do not spend routing calls; their actual positions determine
      // the complete ride/access/egress cost, including one-call coincident anchors.
      const stationPairs = await resolveBicycleStationPairs(
        context,
        pair.from,
        pair.to,
        pair.walkGap ? 3 : 2,
      );

      if (!stationPairs.length) {
        diagnostics.unavailableRentals++;
        continue;
      }

      // Inventory alone cannot establish a routed connection. Prepare the
      // bounded pool and apply the successful-pair cap during execution instead.
      const index = prepared++;

      for (const [alternative, stations] of stationPairs.entries()) {
        // Re-evaluate after previous jobs: they may have fetched this exact ride
        // or access already. A new transit query is staged separately; its actual
        // walks are enriched under the remaining shared cap, then graph-validated.
        const job = bicycleJob(
          pair,
          stations,
          index + alternative * MAX_RENTAL_INSPECTIONS_PER_MODE,
        );

        // A long walk needs a genuinely different return location, not just two
        // pickups ending at the same station with the same long final walk.
        const returnCoverage =
          pair.walkGap && alternative > 0 && stations.drop.id !== stationPairs[0].drop.id;

        (alternative && !returnCoverage ? alternateBicycles : jobs.bicycle).push(job);
      }
    }
  }

  let primaryBicycleCount = jobs.bicycle.length;

  jobs.bicycle.push(...alternateBicycles);

  const firstRentalJob = [...jobs.bicycle, ...jobs.scooter][0];

  const firstPickupAlternative =
    firstRentalJob?.mode === 'bicycle' && firstRentalJob.pair.walkGap
      ? jobs.bicycle.find(
          (job) =>
            pairKey(job.pair) === pairKey(firstRentalJob.pair) &&
            job.stations?.hire.id !== firstRentalJob.stations?.hire.id,
        )
      : undefined;

  const firstRentalCoverageCalls =
    (firstRentalJob?.requiredCalls() ?? 0) + (firstPickupAlternative?.requiredCalls() ?? 0);

  // Cross-itinerary walks have a complete supplied prefix and suffix. Give a
  // promising transfer its bounded foot lookup before optional road spending,
  // while retaining the existing complete rental and saved-car reservations.
  // A higher-ranked local bypass keeps its place ahead of that transfer.
  const earlyWalkingCount = walkingPairs.reduce(
    (count, pair, index) => (pair.crossTransfer && pair.priority >= 120 ? index + 1 : count),
    0,
  );

  await context.budget.withReservedCalls(firstRentalCoverageCalls + carReserved, async () => {
    for (const [index, pair] of walkingPairs.slice(0, earlyWalkingCount).entries()) {
      await walking(pair, index, false);
    }
  });

  // Keep a complete rental comparison when a direct taxi's unknown kerb walks
  // could spend its remaining calls. The same shared hard limit still applies.
  const deferDirectTaxi =
    !!firstRentalJob && context.budget.remaining < firstRentalCoverageCalls + carReserved + 3;

  if (!deferDirectTaxi) {
    await context.budget.withReservedCalls(firstRentalCoverageCalls + carReserved, () =>
      taxi(request.origin, request.destination, 'graph-taxi-direct'),
    );
  }

  const connectedRentals: BridgePair[] = [];
  const connectedKeys = new Set<string>();
  const successfulRentalPairs: Record<'bicycle' | 'scooter', Set<string>> = {
    bicycle: new Set(),
    scooter: new Set(),
  };
  const skippedCandidateKeys = new Set<string>();

  const completeRentalRoads = async () => {
    for (const [index, pair] of connectedRentals.entries()) {
      if (metersBetween(pair.to, request.destination) >= 350) {
        await taxi(pair.to, request.destination, `graph-taxi-tail-${index}`);
      }

      if (metersBetween(request.origin, pair.from) >= 350) {
        await taxi(request.origin, pair.from, `graph-taxi-head-${index}`);
      }
    }
  };

  let primaryRounds = Math.max(primaryBicycleCount, jobs.scooter.length);
  let firstRentalRoadsCompared = false;
  let deferRoadUntilRound = -1;
  let adaptiveIndex = 3 * MAX_RENTAL_INSPECTIONS_PER_MODE;

  // Selection evidence is request-local. Provider responses still use the
  // existing route-query/foot caches; no long-lived coordinate cache is added.
  const accessObservations = new Map<string, BaseSegment | null>();

  const observationKey = (pair: BridgePair, side: 'access' | 'egress', station: BikeStation) =>
    `${pairKey(pair)}:${side}:${station.id}`;

  const completedBicyclePairs = new Set<string>();

  const bicyclePairKey = (pair: BridgePair, stations: NonNullable<RentalJob['stations']>) =>
    `${pairKey(pair)}:${stations.hire.id}>${stations.drop.id}`;

  const refineAccess = async (job: RentalJob, segments: BaseSegment[], round: number) => {
    if (!job.pair.walkGap || !job.stations) {
      return;
    }

    const hireIndex = segments.findIndex((segment) => segment.mode === 'hire');
    const returnIndex = segments.findIndex((segment) => segment.mode === 'return');
    const measured: BicycleWalkingConnections = {
      access: segments.slice(0, hireIndex).find((segment) => segment.mode === 'walk'),
      egress: segments.slice(returnIndex + 1).find((segment) => segment.mode === 'walk'),
    };
    const selected = {
        ...job.stations,
      },
      selectedWalks = {
        ...measured,
      };

    for (const side of ['access', 'egress'] as const) {
      const station = side === 'access' ? job.stations.hire : job.stations.drop;

      if (measured[side]) {
        accessObservations.set(observationKey(job.pair, side, station), measured[side]!);
      }
    }

    const sides = (['access', 'egress'] as const)
      .filter((side) => needsRentalAccessComparison(measured[side], context.now))
      .sort(
        (left, right) =>
          rentalAccessSeconds(measured[right], context.now) -
          rentalAccessSeconds(measured[left], context.now),
      );

    for (const side of sides) {
      const pickup = side === 'access',
        anchor = pickup ? job.from : job.to;

      const candidates = await bicycleAccessStationCandidates(context, anchor, pickup);

      let probes = 0;

      for (const station of candidates) {
        if (station.id === (pickup ? selected.drop.id : selected.hire.id)) {
          continue;
        }

        const key = observationKey(job.pair, side, station);

        if (accessObservations.has(key)) {
          const previous = accessObservations.get(key);

          if (
            previous &&
            rentalAccessSeconds(previous, context.now) <
              rentalAccessSeconds(selectedWalks[side], context.now)
          ) {
            selected[pickup ? 'hire' : 'drop'] = station;
            selectedWalks[side] = previous;

            if (!needsRentalAccessComparison(previous, context.now)) {
              break;
            }
          }

          continue;
        }

        if (blockedModes.has('walk')) {
          break;
        }

        const proposed = {
          ...selected,
          [pickup ? 'hire' : 'drop']: station,
        };
        const from = pickup ? job.from : place(station),
          to = pickup ? place(station) : job.to;

        // Reserve completion of one real bicycle connection and this round's
        // other mode before probing. A cheap foot lookup cannot strand a route
        // without the calls needed for its ride/remaining connection.
        const otherModeCalls = blockedModes.has('scooter')
          ? 0
          : (jobs.scooter[round]?.requiredCalls() ?? 0);
        const completionCalls = queryCost('bicycle', place(proposed.hire), place(proposed.drop));

        if (
          context.budget.remaining - carReserved - otherModeCalls <
          queryCost('walking', from, to) + completionCalls
        ) {
          markBudgetSkipped(`bicycle-access:${pairKey(job.pair)}:${side}`);
          break;
        }

        diagnostics.accessProbes++;
        probes++;

        const walk = await context.budget.withReservedCalls(
          carReserved + otherModeCalls + completionCalls,
          () =>
            guarded(
              'walk',
              () =>
                walkBetween(
                  context,
                  `graph-bicycle-probe-${adaptiveIndex++}`,
                  from,
                  to,
                  `${to.name}까지 걷기`,
                ),
              'routing',
              `bicycle-access:${key}`,
            ),
        );

        accessObservations.set(key, walk);

        if (
          walk &&
          rentalAccessSeconds(walk, context.now) <
            rentalAccessSeconds(selectedWalks[side], context.now)
        ) {
          selected[pickup ? 'hire' : 'drop'] = station;
          selectedWalks[side] = walk;
        }

        // Avoid paying for a ride to every bad pickup. At most two new walks
        // per observed detour, stopping early after finding ordinary access.
        if (walk && !needsRentalAccessComparison(walk, context.now)) {
          break;
        }

        if (probes >= 2) {
          diagnostics.accessProbeLimitReached ||= candidates.some(
            (other) =>
              other.id !== (pickup ? selected.drop.id : selected.hire.id) &&
              !accessObservations.has(observationKey(job.pair, side, other)),
          );
          break;
        }
      }

      // Stopping after ordinary access is a latency policy, not an optimality
      // proof. Report the remaining inventory candidates conservatively even
      // when a later primary job may happen to cover one of them.
      diagnostics.accessProbeLimitReached ||= candidates.some(
        (other) =>
          other.id !== (pickup ? selected.drop.id : selected.hire.id) &&
          !accessObservations.has(observationKey(job.pair, side, other)),
      );
    }

    if (selected.hire.id === job.stations.hire.id && selected.drop.id === job.stations.drop.id) {
      return;
    }

    diagnostics.accessImprovements++;

    const promote = (stations: NonNullable<RentalJob['stations']>, position: number) => {
      if (
        stations.hire.id === stations.drop.id ||
        completedBicyclePairs.has(bicyclePairKey(job.pair, stations))
      ) {
        return false;
      }

      const walks: BicycleWalkingConnections = {
        access:
          accessObservations.get(observationKey(job.pair, 'access', stations.hire)) ?? undefined,
        egress:
          accessObservations.get(observationKey(job.pair, 'egress', stations.drop)) ?? undefined,
      };

      const existing = jobs.bicycle.findIndex(
        (candidate, index) =>
          index > round &&
          pairKey(candidate.pair) === pairKey(job.pair) &&
          candidate.stations?.hire.id === stations.hire.id &&
          candidate.stations.drop.id === stations.drop.id,
      );

      const next =
        existing >= 0
          ? jobs.bicycle.splice(existing, 1)[0]
          : bicycleJob(job.pair, stations, adaptiveIndex++, walks);

      next.walks = {
        ...next.walks,
        ...walks,
      };
      jobs.bicycle.splice(position, 0, next);

      if (existing < 0 || existing >= primaryBicycleCount) {
        primaryBicycleCount++;
      }

      return true;
    };

    const promoted = promote(selected, round + 1);

    // Keep the return comparison when a better pickup was discovered. The old
    // pair remains queued too: an access saving alone cannot prune its ride.
    if (selected.hire.id !== job.stations.hire.id) {
      const returnVariant = jobs.bicycle
        .slice(round + 2)
        .find(
          (candidate) =>
            pairKey(candidate.pair) === pairKey(job.pair) &&
            candidate.stations?.drop.id !== selected.drop.id,
        );

      if (returnVariant?.stations) {
        promote(
          {
            hire: selected.hire,
            drop: returnVariant.stations.drop,
          },
          round + 2,
        );
      }
    }

    primaryRounds = Math.max(primaryBicycleCount, jobs.scooter.length);

    if (promoted) {
      deferRoadUntilRound = Math.max(deferRoadUntilRound, round + 1);
    }
  };

  for (let round = 0; round < Math.max(jobs.bicycle.length, jobs.scooter.length); round++) {
    for (const mode of ['bicycle', 'scooter'] as const) {
      const job = jobs[mode][round];

      if (!job) {
        continue;
      }

      if (blockedModes.has(mode) || (job.pair.continuation && transitBlocked)) {
        continue;
      }

      const { pair, index } = job;
      const key = pairKey(pair),
        logicalKey = `${mode}:${key}`,
        successful = successfulRentalPairs[mode];

      if (!successful.has(key) && successful.size >= MAX_RENTAL_CANDIDATES_PER_MODE) {
        if (!skippedCandidateKeys.has(logicalKey)) {
          skippedCandidateKeys.add(logicalKey);
          diagnostics.candidateLimitSkipped++;
        }

        continue;
      }

      if (context.budget.remaining - carReserved < job.requiredCalls()) {
        markBudgetSkipped(logicalKey);
        continue;
      }

      const prefix = `graph-${mode}-${index}`;

      diagnostics.rentalAttempts++;

      const segments = await guarded(
        mode,
        () =>
          mode === 'bicycle'
            ? bicycleConnection(
                context,
                request.preferences,
                job.from,
                job.to,
                prefix,
                job.stations,
                job.walks,
              )
            : scooterConnection(context, request.preferences, job.from, job.to, prefix),
        'routing',
        logicalKey,
      );

      if (!segments?.length) {
        diagnostics.unavailableRentals++;
        continue;
      }

      if (pair.continuation) {
        const endpoints =
          pair.continuation === 'first'
            ? {
                origin: job.to,
                destination: request.destination,
              }
            : {
                origin: request.origin,
                destination: job.from,
              };

        const continuation = await guarded(
          'bicycle',
          () => context.connectTransit!(endpoints),
          'transit',
          logicalKey,
        );

        const routes = continuation?.filter((route) =>
          route.segments.some((segment) => isTransit(segment.mode)),
        );

        if (!routes?.length) {
          diagnostics.unavailableRentals++;
          continue;
        }

        for (const [routeIndex, route] of routes.entries()) {
          const ids = new Map(
            route.segments.map((segment) => [
              segment.id,
              `${prefix}-transit-${routeIndex}-${segment.id}`,
            ]),
          );

          bridges.push({
            ...route,
            id: `${prefix}-transit-${routeIndex}`,
            segments: route.segments.map((segment) => ({
              ...segment,
              id: ids.get(segment.id)!,
            })),
            notes: route.notes?.map((note) =>
              note.segmentId
                ? {
                    ...note,
                    segmentId: ids.get(note.segmentId) ?? note.segmentId,
                  }
                : note,
            ),
          });
        }
      }

      successful.add(key);
      diagnostics.rentalConnections++;

      if (mode === 'bicycle' && job.stations) {
        completedBicyclePairs.add(bicyclePairKey(pair, job.stations));

        await refineAccess(job, segments, round);
      }

      const connected = {
        ...pair,
        from: job.from,
        to: job.to,
      };

      if (!connectedKeys.has(pairKey(connected))) {
        connectedKeys.add(pairKey(connected));
        connectedRentals.push(connected);
      }

      bridges.push(
        totals({
          id: `${prefix}-bridge`,
          title: multimodalTitle(segments),
          segments,
          transfers: 0,
          notes:
            mode === 'bicycle'
              ? bicycleNotes(segments, context.now)
              : [
                  {
                    code: 'vehicle-availability',
                    severity: 'info',
                    title: '공유 기기 위치는 변동 가능',
                    description:
                      '운영사가 확인한 기기와 반납 위치를 사용했어요. 예약된 기기가 아니므로 접근 중 위치·배터리·대여 가능 여부를 다시 확인하세요.',
                  },
                ],
        }),
      );
    }

    // Both modes finish their job for this round before the first successful
    // rental gets a road comparison, even when earlier rental attempts failed.
    if (
      round >= deferRoadUntilRound &&
      (!firstRentalRoadsCompared || round + 1 === primaryRounds) &&
      !carReserved &&
      connectedRentals.length
    ) {
      firstRentalRoadsCompared = true;

      const nextRentalCalls = Math.max(
        0,
        ...(['bicycle', 'scooter'] as const).map((mode) => {
          if (blockedModes.has(mode)) {
            return 0;
          }

          const successful = successfulRentalPairs[mode];

          const next = jobs[mode]
            .slice(round + 1, mode === 'bicycle' ? primaryBicycleCount : undefined)
            .find(
              (job) =>
                !(job.pair.continuation && transitBlocked) &&
                (successful.has(pairKey(job.pair)) ||
                  successful.size < MAX_RENTAL_CANDIDATES_PER_MODE) &&
                job.requiredCalls() > 0,
            );

          return next?.requiredCalls() ?? 0;
        }),
      );

      // Protect the next paid primary comparison, including a different return.
      // Cached jobs stay free; pickup-only refinement remains after road expansion.
      await context.budget.withReservedCalls(nextRentalCalls, async () => {
        if (deferDirectTaxi) {
          await taxi(request.origin, request.destination, 'graph-taxi-direct');
        }

        await completeRentalRoads();
      });
    }
  }

  if (carReserved && context.budget.remaining >= carReserved) {
    const car = await guarded('car', () =>
      multimodalRoutes(
        {
          ...request,
          preferences: {
            ...request.preferences,
            allowTaxi: false,
            allowBicycle: false,
            allowScooter: false,
          },
        },
        {
          walking: [],
          transit: [],
        },
        {
          ...context,
          candidateScope: 'primary',
        },
      ),
    );

    bridges.push(...(car ?? []));
  }

  await context.onRentalsComplete?.();

  await taxi(request.origin, request.destination, 'graph-taxi-direct');

  // Tail/head bridges allow bicycle/scooter→taxi and taxi→rental compositions.
  await completeRentalRoads();

  // Taxi connections use their own eligibility and saving bounds, independent of the
  // user's bicycle distance. Every ride is fetched separately from the road provider.
  for (const [index, splice] of taxiSplices(transit, request, context.now, {
    objective: context.acquisitionObjective,
    acceptPoint: (point) => outdoorAnchor(point, request, transit),
  }).entries()) {
    await taxi(
      splice.kind === 'first' ? request.origin : splice.point,
      splice.kind === 'first' ? splice.point : request.destination,
      `graph-taxi-splice-${index}`,
    );
  }

  for (const [index, pair] of walkingPairs.entries()) {
    await walking(pair, index, true);
  }

  finish();

  return bridges;
}
