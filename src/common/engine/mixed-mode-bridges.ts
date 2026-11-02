import type { BaseRoute, BaseSegment, Place } from '../shared/domain/index.js';
import { ApiError } from './errors.js';
import { metersBetween, stationBaseName } from './realtime/names.js';
import {
  DOCKLESS_MODES,
  DOCKLESS_PROFILES,
  docklessConnection,
  docklessEnabled,
  docklessRoutingIsFree,
  type DocklessMode,
  type ScooterConnectionContext,
} from './scooter-bridge.js';
import {
  bicycleAccessStationCandidates,
  bicycleConnection,
  bicycleNotes,
  resolveBicycleStationPairs,
  screenBicycleStationPairs,
  spanKey,
  MAX_SCREENED_SPANS,
  cappedBicycleConnection,
  cappedBicycleStationPairs,
  multimodalRoutes,
  multimodalTitle,
  taxiConnection,
  taxiNote,
  groundedStationPoints,
  taxiSplices,
  totals,
  vehiclePoint,
  walkBetween,
  type BicycleScreen,
  type BicycleStationPair,
  type BicycleWalkingConnections,
  type MultimodalRequest,
  type ScreenedBicyclePair,
} from './multimodal.js';
import type { BikeStation } from './realtime/mobility.js';
import type { RouteEndpoints } from './kakao.js';
import {
  routeQueryIsFree,
  routeQueryIsReusable,
  type RouteQueryMode,
} from './connectivity/query-reuse.js';
import { needsRentalAccessComparison, rentalAccessSeconds } from './rental-access.js';
import type { RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming, contextualAcquisitionTimings } from './acquisition-priority.js';
import { MAX_CONNECTOR_METERS } from './connectivity/walking-comparison.js';

interface BridgePair {
  from: Place;
  to: Place;
  priority: number;
  /** Preserve the existing source-bound exploration threshold when only ordering changes. */ possibleSaving?: number;
  /** Fetch order only, never a routed duration or a pruning bound. */ journeyPriority?: number;
  walkGap?: boolean;
  crossTransfer?: boolean;
  direct?: boolean;
  continuation?: 'first' | 'last' | 'both';
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
  failures: { mode: RentalKind | 'taxi' | 'car' | 'walk'; code: ApiError['code'] }[];
  budgetSkipped: number;
  /** Taxi lookups that never started: the search's call budget was spent, or the optional-stage window had closed. */
  taxiSkippedBudget: number;
  taxiSkippedWindow: number;
  candidateLimitSkipped: number;
  /** Nearby unique anchor pairs inspected without materializing their cross-product. */
  walkingPairChecks: number;
  /** Peak number of retained walking candidate pairs, independent of input size. */
  walkingCandidatePeak: number;
  /** Rental comparisons left out per kind (candidate caps, omitted devices, skipped calls), so one kind's
   * omissions never mark another kind's search as cut short. */
  rentalLimitedByMode: Record<RentalKind, number>;
  /** Rentals to the trip's destination refused per kind because no legal return spot lies within a
   * walk of it, so an empty kind says why instead of reading as a search cut short. */
  returnBlockedByMode: Record<RentalKind, number>;
  limitReached: boolean;
}
/** 따릉이 (docked), kick-scooter and dockless e-bike rentals. */
export type RentalKind = 'bicycle' | DocklessMode;
const RENTAL_KINDS: readonly RentalKind[] = ['bicycle', ...DOCKLESS_MODES];

/** What the rental availability statement may read: a skipped taxi lookup says nothing about whether a rental was found,
 * and an omitted scooter says nothing about 따릉이 or e-bikes. */
export function rentalLimitDiagnostics(
  diagnostics: BridgeGenerationDiagnostics,
): BridgeGenerationDiagnostics & { candidateLimitSkippedByMode: Record<RentalKind, number> } {
  const byMode = diagnostics.rentalLimitedByMode;
  return {
    ...diagnostics,
    limitReached:
      diagnostics.budgetSkipped > 0 ||
      diagnostics.candidateLimitSkipped > 0 ||
      diagnostics.accessProbeLimitReached,
    candidateLimitSkippedByMode: {
      ...byMode,
      // Unprobed 따릉이 docks are the bicycle search's own omission.
      bicycle: byMode.bicycle + Number(diagnostics.accessProbeLimitReached),
    },
  };
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
/** Rentals that join the trip's own origin or destination to a transit query have their own slots: they are the only way to
 * combine a rental with a different public itinerary, so a full set of plain rentals must not starve them. Every rental
 * kind draws on the same slots, so dockless continuations ask no more transit queries than 따릉이 alone could. */
const MAX_CONTINUATION_CANDIDATES_PER_MODE = 4;
/** Rental continuations whose transit query starts before the rounds that need it. */
const MAX_PREFETCHED_CONTINUATIONS = 4;
const MAX_RENTAL_INSPECTIONS_PER_MODE = 32;
const MAX_WALKING_BRIDGES = 2;
/** A transfer walk on a self-hosted foot network spends no budget; this many pairs bound the search's latency instead. */
const MAX_UNMETERED_WALKING_BRIDGES = 12;
/** Transfer walks shorter than this are not asked for while each one costs a call; a free lookup is made for any two distinct stops. */
const MIN_METERED_TRANSFER_METERS = 150;
const MIN_UNMETERED_TRANSFER_METERS = 5;
/** While walks and bicycle rides cost calls, a ride must beat walking by this much to be worth its calls. Free
 * (self-hosted) lookups keep a ride up to the slack below slower than walking: the screen times both sides at a
 * walk, while the routed rental may run its access and pays its minute of hire and return, so a near tie can
 * still win (선린인터넷고→숙대입구 2026-11-01: 14 s slower at a walk, about a minute faster as routed). */
const SCREEN_MIN_SAVING_SECONDS = 60;
const SCREEN_FREE_SLACK_SECONDS = 120;
const SCREENED_RENTAL_WINDOW_MILLISECONDS = 5_000;
const SCREEN_WINDOW_MILLISECONDS = 3_000;
/** The fastest screened pair, then the fastest with another pickup and another return, so one bad dock cannot fill every slot. */
function distinctScreenedPairs(
  pairs: readonly ScreenedBicyclePair[],
  limit: number,
): BicycleStationPair[] {
  const chosen = pairs.slice(0, 1);
  const otherPickup = pairs.find((pair) => pair.hire.id !== chosen[0]?.hire.id);
  const otherReturn = pairs.find(
    (pair) => pair.drop.id !== chosen[0]?.drop.id && pair !== otherPickup,
  );
  for (const pair of [otherPickup, otherReturn, ...pairs])
    if (pair && !chosen.includes(pair) && chosen.length < limit) chosen.push(pair);
  return chosen.map(({ hire, drop }) => ({ hire, drop }));
}
/** A pair already connected may be connected again from other docks; a new one needs a free slot of its own kind. */
export function rentalSlotAvailable(
  successful: ReadonlySet<string>,
  continuations: ReadonlySet<string>,
  pair: BridgePair,
): boolean {
  return (
    successful.has(pairKey(pair)) ||
    (pair.continuation
      ? continuations.size < MAX_CONTINUATION_CANDIDATES_PER_MODE
      : successful.size - continuations.size < MAX_RENTAL_CANDIDATES_PER_MODE)
  );
}

/** A dockless ride continues into transit at one end only: a two-sided one would ask two queries, so
 * such a pair is no candidate for it and takes no inspection place. */
export const rentalPairUsable = (pair: BridgePair, mode: RentalKind) =>
  mode === 'bicycle' || pair.continuation !== 'both';
/** The first pairs in rank order, except that the last few places go to the best-ranked continuation pairs left out, so a long
 * list of plain rentals cannot push every transit continuation past the inspection limit. */
export function inspectedRentalPairs(
  eligible: readonly BridgePair[],
  mode: RentalKind,
): BridgePair[] {
  const usable = eligible.filter((pair) => rentalPairUsable(pair, mode));
  const inspected = usable.slice(0, MAX_RENTAL_INSPECTIONS_PER_MODE);
  const continues = (pair: BridgePair) => !!pair.continuation;
  const present = inspected.filter(continues).length;
  const missing = usable
    .slice(MAX_RENTAL_INSPECTIONS_PER_MODE)
    .filter(continues)
    .slice(0, Math.max(0, MAX_CONTINUATION_CANDIDATES_PER_MODE - present));
  if (!missing.length) return inspected;
  const keep = inspected.filter(continues);
  const plain = inspected
    .filter((pair) => !pair.continuation)
    .slice(0, MAX_RENTAL_INSPECTIONS_PER_MODE - keep.length - missing.length);
  const kept = new Set([...plain, ...keep]);
  return [...inspected.filter((pair) => kept.has(pair)), ...missing];
}
/** "아현", "아현역" and "아현역 2호선" (a platform name carries its line after the station) name one station. */
const subwayStationName = (name: string) => {
  const compact = name
      .normalize('NFC')
      .replace(/\s+/g, '')
      .replace(/\([^)]*\)/g, ''),
    end = compact.indexOf('역', 1);
  return end > 0 ? compact.slice(0, end) : stationBaseName(compact);
};
const SAME_STATION_METERS = 300;
const sameSubwayStation = (left: Place, right: Place) =>
  !!left.name &&
  !!right.name &&
  metersBetween(left, right) <= SAME_STATION_METERS &&
  subwayStationName(left.name) === subwayStationName(right.name);
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
      if (seen.has(key)) return false;
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
  if (at(point, request.origin) || at(point, request.destination)) return true;
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
    metersBetween(path[0], segment.start) > MAX_CONNECTOR_METERS ||
    metersBetween(path.at(-1)!, segment.end) > MAX_CONNECTOR_METERS ||
    route.notes?.some(
      (note) =>
        note.title === '역 내부 보행 연결 미확인' &&
        (!note.segmentId || note.segmentId === segment.id),
    )
  )
    return null;
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
    )
      return null;
  }
  const priority = timing.segments[index] - segment.distanceMeters / 3.6;
  const possibleSaving = segment.durationSeconds.max - segment.distanceMeters / 3.6;
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

/**
 * Where a ride is boarded or left on the street: the sidewalk end of the entrance or exit a journey chose (a gate step with
 * `stationExit` next to the train), else the train's own point.
 */
function gatePoint(route: BaseRoute, index: number, edge: 'start' | 'end'): Place {
  const train = vehiclePoint(route.segments[index], edge);
  if (edge === 'end') {
    const after = route.segments[index + 1];
    return after?.stationExit && at(after.start, train) ? after.end : train;
  }
  for (
    let before = index - 1;
    before >= 0 && ['wait', 'entry'].includes(route.segments[before].mode);
    before--
  ) {
    const step = route.segments[before];
    if (step.stationExit && at(step.end, train)) return step.start;
  }
  return train;
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
    ...DOCKLESS_MODES.map((mode) =>
      DOCKLESS_PROFILES[mode].allowed(request.preferences) ? DOCKLESS_PROFILES[mode].rideMeters : 0,
    ),
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
      if (pair) pairs.push(pair);
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
      const from = gatePoint(route, index, 'start'),
        to = gatePoint(route, index, 'end');
      const distance = metersBetween(from, to);
      if (
        distance >= 600 &&
        distance <= rentalReach &&
        metersBetween(to, request.destination) >= 350
      ) {
        // Prioritization only. This straight-line bound is never an ETA or route edge.
        const saving = timing.segments[index] - distance / 3.6;
        pairs.push({
          from,
          to,
          priority: saving + (order > 0 ? 240 : 0),
          possibleSaving: segment.durationSeconds.max - distance / 3.6 + (order > 0 ? 240 : 0),
          journeyPriority: journeySeconds - saving,
        });
      }
      for (const point of [from, to]) {
        const first = metersBetween(request.origin, point),
          last = metersBetween(point, request.destination);
        const cut =
          point === from
            ? index
            : segment.mode === 'subway' && route.segments[index + 1]?.mode === 'entry'
              ? index + 2
              : index + 1;
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
export function walkingBridgePairs(
  request: MultimodalRequest,
  transit: readonly BaseRoute[],
  now: number,
  objective: RoutingObjective,
  options: { limit: number; minTransferMeters: number; grounded: readonly Place[] },
) {
  const pairs: BridgePair[] = [];
  const compare = (left: BridgePair, right: BridgePair) =>
    (left.journeyPriority ?? Infinity) - (right.journeyPriority ?? Infinity) ||
    right.priority - left.priority;
  let candidateCount = 0,
    pairChecks = 0,
    candidatePeak = 0;
  const retain = (pair: BridgePair) => {
    if (pairs.length === options.limit && compare(pair, pairs[pairs.length - 1]) >= 0) return;
    const existing = pairs.findIndex((value) => pairKey(value) === pairKey(pair));
    if (existing >= 0) {
      if (compare(pair, pairs[existing]) >= 0) return;
      pairs[existing] = pair;
    } else if (pairs.length < options.limit) pairs.push(pair);
    else if (compare(pair, pairs[pairs.length - 1]) < 0) pairs[pairs.length - 1] = pair;
    else return;
    pairs.sort(compare);
    candidatePeak = Math.max(candidatePeak, pairs.length);
  };
  const timings = contextualTimings(request, transit, now, objective);
  type AnchorContext = { point: Place; route: BaseRoute; seconds: number; total: number };
  type Anchor = { point: Place; key: string; contexts: AnchorContext[] };
  const alighting = new Map<string, Anchor>(),
    boarding = new Map<string, Anchor>();
  const localPairs = new Map<string, BridgePair>();
  /** Anchors that are subway platform coordinates (reached by a verified walk), not bus stops. */
  const subwayAnchors = new Set<string>();
  const subwayPoints = transit.flatMap((route) =>
    route.segments.flatMap((segment) =>
      segment.mode === 'subway'
        ? [vehiclePoint(segment, 'start'), vehiclePoint(segment, 'end')]
        : [],
    ),
  );
  // A station coordinate counts only where a verified walk reaches it; see groundedStationPoints.
  const outdoor = (point: Place) =>
    validPoint(point) &&
    (at(point, request.origin) ||
      at(point, request.destination) ||
      !subwayPoints.some((station) => at(point, station)) ||
      options.grounded.some((station) => at(point, station)));
  const addAnchor = (
    anchors: Map<string, Anchor>,
    point: Place,
    route: BaseRoute,
    seconds: number,
    total: number,
  ) => {
    if (!Number.isFinite(seconds)) return;
    const key = pointKey(point),
      anchor = anchors.get(key) ?? { point, key, contexts: [] };
    const context = { point, route, seconds, total },
      existing = anchor.contexts.findIndex((value) => value.route === route);
    const compareContext = (left: AnchorContext, right: AnchorContext) =>
      left.seconds - right.seconds || right.total - left.total;
    if (existing >= 0) {
      if (compareContext(context, anchor.contexts[existing]) >= 0) return;
      anchor.contexts[existing] = context;
    } else anchor.contexts.push(context);
    // The cheapest context and cheapest different source suffice to find the
    // minimum sum with source A != source B. Higher source totals break ties by
    // the same potential-saving priority as the full candidate enumeration.
    anchor.contexts.sort(compareContext);
    if (anchor.contexts.length > 2) anchor.contexts.pop();
    anchors.set(key, anchor);
  };
  const suppliedWalks = new Set<string>();
  for (const route of transit)
    for (const [index, segment] of route.segments.entries()) {
      if (segment.mode !== 'walk') continue;
      const pair = { from: segment.start, to: segment.end, priority: 0 };
      const extra = route.segments[index + 1];
      const segments = [
        segment,
        ...(extra?.mode === 'wait' && extra.id.endsWith('-provider-extra') ? [extra] : []),
      ];
      if (actualWalkingSegments({ ...route, segments }, pair, 'supplied'))
        suppliedWalks.add(pairKey(pair));
    }
  for (const route of [...transit].sort((a, b) => timings.get(a)!.total - timings.get(b)!.total)) {
    const timing = timings.get(route)!;
    for (let index = 0; index < route.segments.length; index++) {
      const segment = route.segments[index];
      if (segment.mode === 'subway') {
        // Only the station end of a verified access or egress walk becomes a place to change over; nothing is replaced locally.
        const train = { from: vehiclePoint(segment, 'start'), to: vehiclePoint(segment, 'end') };
        let before = index;
        // A chosen entrance (stationExit) starts on its sidewalk point and ends on the train's point.
        while (
          before > 0 &&
          ['wait', 'entry'].includes(route.segments[before - 1].mode) &&
          at(route.segments[before - 1].end, train.from) &&
          (at(route.segments[before - 1].start, train.from) ||
            !!route.segments[before - 1].stationExit)
        )
          before--;
        const from = route.segments[before]?.stationExit
          ? route.segments[before].start
          : train.from;
        let after = index + 1;
        // The station exit is part of reaching the street at this alighting; a chosen exit ends on its sidewalk point.
        if (
          route.segments[after]?.mode === 'entry' &&
          at(route.segments[after].start, train.to) &&
          (at(route.segments[after].end, train.to) || !!route.segments[after].stationExit)
        )
          after++;
        const to = route.segments[after - 1]?.stationExit
          ? route.segments[after - 1].end
          : train.to;
        if (
          route.segments[after]?.mode === 'wait' &&
          route.segments[after].id.endsWith('-provider-extra') &&
          at(route.segments[after].start, train.to) &&
          at(route.segments[after].end, train.to)
        )
          after++;
        if (!at(from, request.origin) && options.grounded.some((station) => at(station, from))) {
          addAnchor(
            boarding,
            from,
            route,
            timing.suffix +
              timing.segments.slice(before).reduce((sum, seconds) => sum + seconds, 0),
            timing.total,
          );
          subwayAnchors.add(pointKey(from));
        }
        if (!at(to, request.destination) && options.grounded.some((station) => at(station, to))) {
          addAnchor(
            alighting,
            to,
            route,
            timing.prefix +
              timing.segments.slice(0, after).reduce((sum, seconds) => sum + seconds, 0),
            timing.total,
          );
          subwayAnchors.add(pointKey(to));
        }
        continue;
      }
      if (segment.mode !== 'bus') continue;
      const from = vehiclePoint(segment, 'start'),
        to = vehiclePoint(segment, 'end');
      let before = index;
      while (
        before > 0 &&
        route.segments[before - 1].mode === 'wait' &&
        at(route.segments[before - 1].start, from) &&
        at(route.segments[before - 1].end, from)
      )
        before--;
      let after = index + 1;
      // A provider's vehicle allowance belongs to the arriving ride, not to a
      // new transfer that could accidentally avoid it.
      if (
        route.segments[after]?.mode === 'wait' &&
        route.segments[after].id.endsWith('-provider-extra') &&
        at(route.segments[after].start, to) &&
        at(route.segments[after].end, to)
      )
        after++;
      if (!at(from, request.origin) && outdoor(from))
        addAnchor(
          boarding,
          from,
          route,
          timing.suffix + timing.segments.slice(before).reduce((sum, seconds) => sum + seconds, 0),
          timing.total,
        );
      if (!at(to, request.destination) && outdoor(to))
        addAnchor(
          alighting,
          to,
          route,
          timing.prefix +
            timing.segments.slice(0, after).reduce((sum, seconds) => sum + seconds, 0),
          timing.total,
        );
      const distance = metersBetween(from, to);
      if (distance < 150 || distance > 1600 || !outdoor(from) || !outdoor(to)) continue;
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
        const pair = { from, to, priority, journeyPriority: timing.total - priority },
          key = pairKey(pair),
          existing = localPairs.get(key);
        if (!existing || compare(pair, existing) < 0) localPairs.set(key, pair);
      }
    }
  }
  candidateCount = localPairs.size;
  for (const pair of localPairs.values()) retain(pair);
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
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const departure of buckets.get(`${x + dx},${y + dy},${z + dz}`) ?? []) {
            pairChecks++;
            const distance = metersBetween(arrival.point, departure.point);
            if (distance < options.minTransferMeters || distance > 1600) continue;
            // Two platforms of one station are joined by the station's own transfer (its reference time and gate walks), never by a street walk.
            if (
              subwayAnchors.has(arrival.key) &&
              subwayAnchors.has(departure.key) &&
              sameSubwayStation(arrival.point, departure.point)
            )
              continue;
            const key = `${arrival.key}>${departure.key}`;
            // The graph already reuses supplied walks; duplicates do not earn calls.
            if (suppliedWalks.has(key)) continue;
            let best: BridgePair | undefined;
            for (const prefix of arrival.contexts)
              for (const suffix of departure.contexts) {
                if (prefix.route === suffix.route) continue;
                const journeyPriority = prefix.seconds + distance / 1.2 + suffix.seconds;
                const priority = Math.min(prefix.total, suffix.total) - journeyPriority;
                const pair = {
                  from: prefix.point,
                  to: suffix.point,
                  priority,
                  journeyPriority,
                  crossTransfer: true,
                };
                if (!best || compare(pair, best) < 0) best = pair;
              }
            if (!best) continue;
            if (!localPairs.has(key)) candidateCount++;
            retain(best);
          }
        }
  }
  return { pairs, candidateCount, pairChecks, candidatePeak };
}

function actualWalkingSegments(
  route: BaseRoute | undefined,
  pair: BridgePair,
  prefix: string,
): BaseSegment[] | null {
  if (!route?.segments.length || !route.segments.some((segment) => segment.mode === 'walk'))
    return null;
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
            metersBetween(segment.polyline[0], segment.start) > MAX_CONNECTOR_METERS ||
            metersBetween(segment.polyline.at(-1)!, segment.end) > MAX_CONNECTOR_METERS)),
    )
  )
    return null;
  const firstWalk = segments.find((segment) => segment.mode === 'walk')!,
    lastWalk = segments.filter((segment) => segment.mode === 'walk').at(-1)!;
  if (
    metersBetween(segments[0].start, pair.from) > MAX_CONNECTOR_METERS ||
    metersBetween(segments.at(-1)!.end, pair.to) > MAX_CONNECTOR_METERS ||
    metersBetween(firstWalk.polyline![0], pair.from) > MAX_CONNECTOR_METERS ||
    metersBetween(lastWalk.polyline!.at(-1)!, pair.to) > MAX_CONNECTOR_METERS ||
    segments.reduce((sum, segment) => sum + segment.distanceMeters, 0) > 2000
  )
    return null;
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
    taxiSkippedBudget: 0,
    taxiSkippedWindow: 0,
    candidateLimitSkipped: 0,
    walkingPairChecks: 0,
    walkingCandidatePeak: 0,
    rentalLimitedByMode: { bicycle: 0, scooter: 0, ebike: 0 },
    returnBlockedByMode: { bicycle: 0, scooter: 0, ebike: 0 },
    limitReached: false,
  };
  // A road lookup that was refused is retried later in the search; only one that never started in the end is a skipped taxi.
  const skippedTaxis = new Map<string, 'budget' | 'window'>();
  const finish = () => {
    diagnostics.taxiSkippedBudget = [...skippedTaxis.values()].filter(
      (reason) => reason === 'budget',
    ).length;
    diagnostics.taxiSkippedWindow = [...skippedTaxis.values()].filter(
      (reason) => reason === 'window',
    ).length;
    diagnostics.limitReached =
      diagnostics.budgetSkipped > 0 ||
      diagnostics.taxiSkippedBudget > 0 ||
      diagnostics.taxiSkippedWindow > 0 ||
      diagnostics.candidateLimitSkipped > 0 ||
      diagnostics.accessProbeLimitReached;
    context.onDiagnostics?.({ ...diagnostics });
  };
  if (request.preferences.walkingOnly) {
    finish();
    return [];
  }
  const bridges: (BaseRoute | null)[] = [];
  const allPairs = transferBridgePairs(
    {
      ...request,
      preferences: {
        ...request.preferences,
        ...(!docklessEnabled(context, request.preferences, 'scooter')
          ? { allowScooter: false }
          : {}),
        ...(!docklessEnabled(context, request.preferences, 'ebike') ? { allowEbike: false } : {}),
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
    )
      return [pair];
    if (!context.connectTransit || (pair.possibleSaving ?? pair.priority) < 120) return [];
    // A nearby platform only identifies a promising area. Re-query transit at the
    // real pickup/return station; never connect the rental to the platform itself.
    if (at(pair.from, request.origin)) return [{ ...pair, continuation: 'first' as const }];
    if (at(pair.to, request.destination)) return [{ ...pair, continuation: 'last' as const }];
    return [{ ...pair, continuation: 'both' as const }];
  });
  const blockedModes = new Set<BridgeGenerationDiagnostics['failures'][number]['mode']>();
  const skippedBudgetKeys = new Set<string>();
  /** A rental key starts with its kind (`ebike:…`), a 따릉이 dock probe with `bicycle-access:`. */
  const rentalKindOf = (key: string): RentalKind | null => {
    const head = key.split(':')[0];
    return head === 'bicycle-access'
      ? 'bicycle'
      : RENTAL_KINDS.includes(head as RentalKind)
        ? (head as RentalKind)
        : null;
  };
  const markBudgetSkipped = (key: string) => {
    if (!skippedBudgetKeys.has(key)) {
      skippedBudgetKeys.add(key);
      diagnostics.budgetSkipped++;
      const kind = rentalKindOf(key);
      if (kind) diagnostics.rentalLimitedByMode[kind]++;
    }
  };
  const limitRental = (mode: RentalKind, count = 1) => {
    diagnostics.candidateLimitSkipped += count;
    diagnostics.rentalLimitedByMode[mode] += count;
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
          if (domain === 'transit') transitBlocked = true;
          else blockedModes.add(mode);
        }
        if (
          !diagnostics.failures.some(
            (failure) => failure.mode === mode && failure.code === error.code,
          )
        )
          diagnostics.failures.push({ mode, code: error.code });
        return null;
      }
      throw error;
    }
  };
  const walkingFree = routeQueryIsFree(context.provider, 'walking');
  // Where a verified walk reaches a subway station, a taxi or a transfer walk may end at (or start from) that station too.
  const groundedStations = groundedStationPoints(transit, context.now);
  const walkingSearch = walkingBridgePairs(
    request,
    transit,
    context.now,
    context.acquisitionObjective ?? 'estimated-arrival',
    {
      limit: walkingFree ? MAX_UNMETERED_WALKING_BRIDGES : MAX_WALKING_BRIDGES,
      minTransferMeters: walkingFree ? MIN_UNMETERED_TRANSFER_METERS : MIN_METERED_TRANSFER_METERS,
      grounded: groundedStations,
    },
  );
  const walkingPairs = walkingSearch.pairs;
  diagnostics.candidateLimitSkipped += walkingSearch.candidateCount - walkingPairs.length;
  diagnostics.walkingPairChecks = walkingSearch.pairChecks;
  diagnostics.walkingCandidatePeak = walkingSearch.candidatePeak;
  const attemptedWalkingPairs = new Set<string>();
  const walking = async (
    pair: BridgePair,
    index: number,
    reportBudget: boolean,
    target: (BaseRoute | null)[] = bridges,
  ) => {
    const key = pairKey(pair);
    if (attemptedWalkingPairs.has(key) || blockedModes.has('walk')) return;
    if (
      context.budget.remaining < 1 &&
      !routeQueryIsReusable(
        context.provider,
        'walking',
        { origin: pair.from, destination: pair.to },
        context.budget,
      )
    ) {
      if (reportBudget) markBudgetSkipped(`walking:${key}`);
      return;
    }
    attemptedWalkingPairs.add(key);
    const routed = await guarded(
      'walk',
      () => context.provider.walking({ origin: pair.from, destination: pair.to }, context.budget),
      'routing',
      `walking:${key}`,
    );
    // Keep the provider's bounded sibling paths independent. A slower walk can
    // permit a shorter run that catches an earlier bus; graph timing and the
    // user's running cap decide after footVariants, with every allowance intact.
    for (const [alternative, route] of (routed ?? []).slice(0, 3).entries()) {
      const id = `graph-walk-${index}-${alternative}`;
      const segments = actualWalkingSegments(route, pair, id);
      if (!segments) continue;
      const segmentIds = new Map(
        route.segments.map((segment, position) => [segment.id, segments[position].id]),
      );
      const notes = route.notes?.map((note) =>
        note.segmentId
          ? { ...note, segmentId: segmentIds.get(note.segmentId) ?? note.segmentId }
          : note,
      );
      target.push(
        totals({ id: `${id}-bridge`, title: '정류장 사이 걷기', segments, transfers: 0, notes }),
      );
    }
  };
  const roadPairs = new Set<string>();
  /** `slot` keeps a taxi started early at the place in `bridges` it had when its result was awaited before going on. */
  const taxi = async (
    from: Place,
    to: Place,
    id: string,
    slot?: number,
    target: (BaseRoute | null)[] = bridges,
  ) => {
    const key = pairKey({ from, to });
    if (
      blockedModes.has('taxi') ||
      !context.provider.driving ||
      request.preferences.allowTaxi === false ||
      metersBetween(from, to) < 350 ||
      roadPairs.has(key)
    )
      return;
    if (
      context.budget.remaining < 1 &&
      !routeQueryIsReusable(
        context.provider,
        'driving',
        { origin: from, destination: to },
        context.budget,
      )
    ) {
      // A skipped taxi is a missing option, so the search reports why instead of silently dropping it.
      skippedTaxis.set(key, context.budget.closed ? 'window' : 'budget');
      return;
    }
    skippedTaxis.delete(key);
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
    const route = segments
      ? totals({
          id,
          title: multimodalTitle(segments),
          transfers: 0,
          fareWon: segments.find((segment) => segment.mode === 'taxi')?.costWon,
          segments,
          notes: [taxiNote],
        })
      : null;
    if (slot !== undefined) target[slot] = route;
    else if (route) target.push(route);
  };
  const carReserved =
    !!context.provider.driving && request.preferences.hasCar && request.preferences.carLocation
      ? 2 +
        Number(metersBetween(request.origin, request.preferences.carLocation) >= 1) +
        (transit.some((route) => route.segments.some((segment) => segment.mode === 'subway')) ||
        context.parking?.candidates
          ? 2
          : 0)
      : 0;
  const wholeTrip = pairKey({ from: request.origin, to: request.destination });
  // A long walk that spans the whole trip is the whole trip too; it keeps its place among the screened spans.
  const rentalPairs = uniquePairs([
    ...pairs,
    { from: request.origin, to: request.destination, priority: -Infinity, direct: true },
  ]).map((pair) => (pairKey(pair) === wholeTrip ? { ...pair, direct: true } : pair));
  const queryCost = (mode: RouteQueryMode, origin: Place, destination: Place) =>
    context.queryCallCost?.(mode, { origin, destination }) ?? 1;
  type RentalJob = {
    mode: RentalKind;
    pair: BridgePair;
    stations?: { hire: BikeStation; drop: BikeStation };
    from: Place;
    to: Place;
    walks?: BicycleWalkingConnections;
    requiredCalls: () => number;
    index: number;
    /** Screened seconds saved over walking the span. */ saving?: number;
  };
  const place = (station: BikeStation): Place => ({
    id: `ddareungi-${station.id}`,
    name: station.name,
    address: '',
    latitude: station.latitude,
    longitude: station.longitude,
  });
  /** The transit legs that join a rental to the trip's own origin or destination. */
  const continuationEndpoints = (job: RentalJob): RouteEndpoints[] =>
    job.pair.continuation === 'both'
      ? [
          { origin: request.origin, destination: job.from },
          { origin: job.to, destination: request.destination },
        ]
      : job.pair.continuation === 'first'
        ? [{ origin: job.to, destination: request.destination }]
        : job.pair.continuation === 'last'
          ? [{ origin: request.origin, destination: job.from }]
          : [];
  const bicycleJob = (
    pair: BridgePair,
    stations: NonNullable<RentalJob['stations']>,
    index: number,
    walks?: BicycleWalkingConnections,
  ): RentalJob => {
    const from =
      pair.continuation === 'last' || pair.continuation === 'both'
        ? place(stations.hire)
        : pair.from;
    const to =
      pair.continuation === 'first' || pair.continuation === 'both'
        ? place(stations.drop)
        : pair.to;
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
        (pair.continuation === 'first' || pair.continuation === 'both'
          ? queryCost('transit', to, request.destination)
          : 0) +
        (pair.continuation === 'last' || pair.continuation === 'both'
          ? queryCost('transit', request.origin, from)
          : 0),
    };
    return job;
  };
  const jobs: Record<RentalKind, RentalJob[]> = { bicycle: [], scooter: [], ebike: [] };
  /** The sidewalk points of the exits and entrances the journeys use (their gate steps' street ends). */
  const exitStreets = transit.flatMap((route) =>
    route.segments.flatMap((segment) =>
      segment.stationExit
        ? [segment.stationExit.kind === 'exit' ? segment.end : segment.start]
        : [],
    ),
  );
  // The whole trip on self-hosted networks spends no call: a closed optional-stage window or a spent budget must not
  // leave a kind without the one ride riders compare against (its tab would show only mixtures).
  const docklessFree = docklessRoutingIsFree(context.provider);
  /**
   * A dockless rental between a pair's anchors. A continuation rides to (or starts from) the legal
   * spot for its kind by the station's street entrance that the operator names, and the transit
   * query starts (or ends) there; kinds whose spots coincide share that query. No such spot, or a
   * two-sided continuation, means no job.
   */
  const docklessJob = (mode: DocklessMode, pair: BridgePair, index: number): RentalJob | null => {
    if (!pair.continuation)
      return {
        mode,
        pair,
        from: pair.from,
        to: pair.to,
        requiredCalls: () => (pair.direct && docklessFree ? 0 : 1),
        index,
      };
    const policy = DOCKLESS_PROFILES[mode].policy(context);
    if (!rentalPairUsable(pair, mode) || !policy?.returnPoint) return null;
    const first = pair.continuation === 'first';
    // At a chosen exit's sidewalk point the rider is already at the street: the spot is by that exit, not by the nearest mapped entrance.
    const near = first ? pair.to : pair.from;
    const spot = policy.returnPoint(near, !exitStreets.some((street) => at(street, near)), mode);
    if (!spot || !validPoint(spot)) return null;
    const from = first ? pair.from : spot,
      to = first ? spot : pair.to;
    return {
      mode,
      pair,
      from,
      to,
      index,
      requiredCalls: () =>
        1 +
        (first
          ? queryCost('transit', to, request.destination)
          : queryCost('transit', request.origin, from)),
    };
  };
  /** Dockless kinds this search can rent, in round order. */
  const docklessKinds = DOCKLESS_MODES.filter((mode) =>
    docklessEnabled(context, request.preferences, mode),
  );
  let restoreWindow = () => {};
  const alternateBicycles: RentalJob[] = [];
  // Walk and bicycle tables from a self-hosted network cost nothing: a ride within the slack of walking is worth routing.
  const screenSaving =
    routeQueryIsFree(context.provider, 'walking') && routeQueryIsFree(context.provider, 'bicycle')
      ? 0
      : SCREEN_MIN_SAVING_SECONDS;
  const worthScreening = (saving: number) =>
    screenSaving ? saving >= screenSaving : saving > -SCREEN_FREE_SLACK_SECONDS;
  for (const mode of RENTAL_KINDS) {
    const enabled =
      mode === 'bicycle'
        ? request.preferences.allowBicycle &&
          request.preferences.bicycleReady &&
          context.provider.bicycle &&
          context.mobility?.bikes.configured
        : docklessKinds.includes(mode);
    if (!enabled) continue;
    const reach =
      mode === 'bicycle'
        ? request.preferences.maxBicycleMeters
        : DOCKLESS_PROFILES[mode].rideMeters;
    const eligible = rentalPairs.filter(
      (pair) => metersBetween(pair.from, pair.to) <= reach && rentalPairUsable(pair, mode),
    );
    diagnostics.rentalCandidates += eligible.length;
    const ranked = inspectedRentalPairs(eligible, mode);
    // Every kind compares the whole trip, however many other spans rank ahead of it.
    const whole = eligible.find((pair) => pair.direct);
    const inspected = whole && !ranked.includes(whole) ? [whole, ...ranked.slice(0, -1)] : ranked;
    if (eligible.length > inspected.length) limitRental(mode, eligible.length - inspected.length);
    let prepared = 0;
    // The whole trip and long walks are screened together: two table requests rank every dock pair.
    // The whole trip goes first; it sorts last among bridges but is the ride riders compare against.
    const spans =
      mode === 'bicycle'
        ? [
            ...inspected.filter((pair) => pair.direct),
            ...inspected.filter((pair) => pair.walkGap && !pair.direct),
          ].slice(0, MAX_SCREENED_SPANS)
        : [];
    // The two table requests must not lose to a window that closed while earlier stages ran.
    if (spans.length) restoreWindow = context.budget.extendWindow(SCREEN_WINDOW_MILLISECONDS);
    const screens = spans.length
      ? await screenBicycleStationPairs(context, spans)
      : new Map<string, BicycleScreen>();
    // A dockless kind tries the whole trip in its first round.
    const ordered =
      mode === 'bicycle'
        ? inspected
        : [...inspected].sort((a, b) => Number(!!b.direct) - Number(!!a.direct));
    for (const pair of ordered) {
      if (mode !== 'bicycle') {
        const job = docklessJob(mode, pair, prepared);
        if (job) {
          jobs[mode].push(job);
          prepared++;
        }
        continue;
      }
      const screen = screens.get(spanKey(pair)),
        replacesWalk = pair.walkGap || pair.direct;
      // A ride that cannot beat walking the same span (or the whole trip) is not worth its routing calls;
      // while those calls are paid it must save a minute.
      if (
        screen &&
        replacesWalk &&
        !(
          screen.walkSeconds !== null &&
          screen.pairs[0] &&
          worthScreening(screen.walkSeconds - screen.pairs[0].estimatedSeconds)
        )
      ) {
        diagnostics.unavailableRentals++;
        continue;
      }
      // Station lookups do not spend routing calls; their actual positions determine
      // the complete ride/access/egress cost, including one-call coincident anchors.
      const stationPairs = screen?.pairs.length
        ? distinctScreenedPairs(screen.pairs, pair.walkGap ? 3 : 2)
        : await resolveBicycleStationPairs(context, pair.from, pair.to, pair.walkGap ? 3 : 2);
      if (!stationPairs.length) {
        diagnostics.unavailableRentals++;
        continue;
      }
      const saving =
        screen && replacesWalk && screen.walkSeconds !== null
          ? screen.walkSeconds - screen.pairs[0].estimatedSeconds
          : undefined;
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
        job.saving = saving;
        // A long walk needs a genuinely different return location, not just two
        // pickups ending at the same station with the same long final walk.
        const returnCoverage =
          pair.walkGap && alternative > 0 && stations.drop.id !== stationPairs[0].drop.id;
        (alternative && !returnCoverage ? alternateBicycles : jobs.bicycle).push(job);
      }
    }
  }
  // Route the screened walk replacement that saves the most first; unscreened jobs keep their order after it.
  jobs.bicycle.sort((a, b) => (b.saving ?? -Infinity) - (a.saving ?? -Infinity));
  let primaryBicycleCount = jobs.bicycle.length;
  jobs.bicycle.push(...alternateBicycles);
  const docklessJobs = () => docklessKinds.flatMap((mode) => jobs[mode]);
  const firstRentalJob = [...jobs.bicycle, ...docklessJobs()][0];
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
    await Promise.all(
      walkingPairs.slice(0, earlyWalkingCount).map((pair, index) => walking(pair, index, false)),
    );
  });
  // Keep a complete rental comparison when a direct taxi's unknown kerb walks
  // could spend its remaining calls. The same shared hard limit still applies.
  // A continuation's transit query does not depend on the ride. Ask the first few now: each round
  // then reads the search's shared answer instead of waiting for its own provider round trip. Only
  // 따릉이 pairs had their docks' stock checked; a dockless continuation asks once a device is routed.
  const prefetch = new Map<string, RouteEndpoints>();
  for (const job of jobs.bicycle.slice(0, primaryBicycleCount)) {
    if (prefetch.size >= MAX_PREFETCHED_CONTINUATIONS || transitBlocked) break;
    for (const endpoints of continuationEndpoints(job))
      if (prefetch.size < MAX_PREFETCHED_CONTINUATIONS)
        prefetch.set(pairKey({ from: endpoints.origin, to: endpoints.destination }), endpoints);
  }
  // The early taxis and transfer walks below must leave the budget those first continuation queries need.
  const prefetchCalls = [...prefetch.values()].reduce(
    (sum, endpoints) => sum + queryCost('transit', endpoints.origin, endpoints.destination),
    0,
  );
  const deferDirectTaxi =
    !!firstRentalJob && context.budget.remaining < firstRentalCoverageCalls + carReserved + 3;
  // The direct taxi's road lookup runs while the rentals are routed; nothing below reads it before the rounds end.
  let directTaxiDone = deferDirectTaxi;
  const directTaxi = deferDirectTaxi
    ? undefined
    : context.budget
        .withReservedCalls(firstRentalCoverageCalls + carReserved, () =>
          taxi(request.origin, request.destination, 'graph-taxi-direct', bridges.push(null) - 1),
        )
        .finally(() => {
          directTaxiDone = true;
        });
  void directTaxi?.catch(() => undefined);
  // Taxi connections at a boarding or alighting point and transfer walks between itineraries depend only on the supplied
  // itineraries, not on any rental. Start them with the direct taxi: the optional-stage window closes during the rental
  // rounds, and a lookup begun after it closes is refused. Their bridges still join the result in the order they always had.
  const splices: (BaseRoute | null)[] = [],
    transfers: (BaseRoute | null)[] = [];
  const taxiSplicePoints = taxiSplices(transit, request, context.now, {
    objective: context.acquisitionObjective,
    acceptPoint: (point) =>
      outdoorAnchor(point, request, transit) ||
      groundedStations.some((station) => at(station, point)),
  });
  // Taxi connections use their own eligibility and saving bounds, independent of the user's bicycle distance.
  // Every ride is fetched separately from the road provider.
  const startSplices = () =>
    Promise.all(
      taxiSplicePoints.map((splice, index) =>
        taxi(
          splice.kind === 'first' ? request.origin : splice.point,
          splice.kind === 'first' ? splice.point : request.destination,
          `graph-taxi-splice-${index}`,
          undefined,
          splices,
        ),
      ),
    );
  const startTransfers = () =>
    Promise.all(walkingPairs.map((pair, index) => walking(pair, index, true, transfers)));
  // Only with room for them beside the rentals' and the direct taxi's calls; a tight budget keeps them for the end, as before.
  const earlyCalls =
    taxiSplicePoints.length * (walkingFree ? 1 : 3) +
    (walkingFree ? 0 : Math.max(0, walkingPairs.length - earlyWalkingCount));
  const startEarly =
    !deferDirectTaxi &&
    context.budget.remaining >=
      firstRentalCoverageCalls + carReserved + prefetchCalls + 3 + earlyCalls;
  let earlyDone = !startEarly;
  // The splices follow the direct taxi's lookup, which is already running: a road account the supplier rejects is then
  // refused once, not once per splice. Transfer walks use no road account and start at once.
  const early = startEarly
    ? context.budget
        .withReservedCalls(firstRentalCoverageCalls + carReserved + prefetchCalls, () =>
          Promise.all([startTransfers(), directTaxi!.then(startSplices, startSplices)]),
        )
        .finally(() => {
          earlyDone = true;
        })
    : undefined;
  void early?.catch(() => undefined);
  const connectedRentals: BridgePair[] = [];
  const connectedKeys = new Set<string>();
  const successfulRentalPairs: Record<RentalKind, Set<string>> = {
    bicycle: new Set(),
    scooter: new Set(),
    ebike: new Set(),
  };
  const successfulContinuations: Record<RentalKind, Set<string>> = {
    bicycle: new Set(),
    scooter: new Set(),
    ebike: new Set(),
  };
  // Continuations of every kind share their slots. A dockless slot is its transit query: a
  // kick-scooter and an e-bike ending at one spot share it; spots apart take a slot each.
  const continuationSlots = new Set<string>();
  const slotOf = (job: RentalJob) =>
    job.mode === 'bicycle'
      ? pairKey(job.pair)
      : `dockless:${continuationEndpoints(job)
          .map((endpoints) => pairKey({ from: endpoints.origin, to: endpoints.destination }))
          .join('|')}`;
  const rentalHasRoom = (job: RentalJob) => {
    const { mode, pair } = job;
    if (!pair.continuation)
      return rentalSlotAvailable(successfulRentalPairs[mode], successfulContinuations[mode], pair);
    return (
      successfulRentalPairs[mode].has(pairKey(pair)) ||
      continuationSlots.has(slotOf(job)) ||
      continuationSlots.size < MAX_CONTINUATION_CANDIDATES_PER_MODE
    );
  };
  const skippedCandidateKeys = new Set<string>();
  // Every road lookup is independent and checks the shared budget before its call; they travel together.
  const completeRentalRoads = (target: (BaseRoute | null)[] = bridges) =>
    Promise.all(
      connectedRentals.flatMap((pair, index) => [
        ...(metersBetween(pair.to, request.destination) >= 350
          ? [taxi(pair.to, request.destination, `graph-taxi-tail-${index}`, undefined, target)]
          : []),
        ...(metersBetween(request.origin, pair.from) >= 350
          ? [taxi(request.origin, pair.from, `graph-taxi-head-${index}`, undefined, target)]
          : []),
      ]),
    );
  // A road comparison started during the rental rounds keeps running while later rounds route their rentals.
  // Its bridges keep their place (`at`): after everything found before it started, before anything found after.
  type RoadBatch = {
    at: number;
    routes: (BaseRoute | null)[];
    taxis: number;
    done: boolean;
    task: Promise<void>;
  };
  const roadBatches: RoadBatch[] = [];
  const settleRoads = async () => {
    await Promise.all([directTaxi, early, ...roadBatches.map((batch) => batch.task)]);
  };
  /** Each taxi still running (the direct one included) may spend up to two kerb-walk calls and holds its reservation;
   * a transfer walk costs a call only while the foot network is metered. */
  const pendingRoadCalls = () =>
    (directTaxiDone ? 0 : 2) +
    roadBatches.reduce((sum, batch) => sum + (batch.done ? 0 : 2 * batch.taxis), 0) +
    (earlyDone ? 0 : 2 * taxiSplicePoints.length + (walkingFree ? 0 : walkingPairs.length));
  // Routing the best screened ride takes about three public-server requests at one a second.
  if (worthScreening(jobs.bicycle[0]?.saving ?? 0))
    context.budget.extendWindow(SCREENED_RENTAL_WINDOW_MILLISECONDS);
  else restoreWindow();
  const docklessRounds = () => Math.max(0, ...docklessKinds.map((mode) => jobs[mode].length));
  let primaryRounds = Math.max(primaryBicycleCount, docklessRounds());
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
    if (!job.stations || (!job.pair.walkGap && !job.pair.direct)) return;
    const hireIndex = segments.findIndex((segment) => segment.mode === 'hire');
    const returnIndex = segments.findIndex((segment) => segment.mode === 'return');
    const measured: BicycleWalkingConnections = {
      access: segments.slice(0, hireIndex).find((segment) => segment.mode === 'walk'),
      egress: segments.slice(returnIndex + 1).find((segment) => segment.mode === 'walk'),
    };
    const selected = { ...job.stations },
      selectedWalks = { ...measured };
    for (const side of ['access', 'egress'] as const) {
      const station = side === 'access' ? job.stations.hire : job.stations.drop;
      if (measured[side])
        accessObservations.set(observationKey(job.pair, side, station), measured[side]!);
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
        if (station.id === (pickup ? selected.drop.id : selected.hire.id)) continue;
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
            if (!needsRentalAccessComparison(previous, context.now)) break;
          }
          continue;
        }
        if (blockedModes.has('walk')) break;
        const proposed = { ...selected, [pickup ? 'hire' : 'drop']: station };
        const from = pickup ? job.from : place(station),
          to = pickup ? place(station) : job.to;
        // Reserve completion of one real bicycle connection and this round's
        // other mode before probing. A cheap foot lookup cannot strand a route
        // without the calls needed for its ride/remaining connection.
        const otherModeCalls = docklessKinds.reduce(
          (sum, mode) =>
            sum + (blockedModes.has(mode) ? 0 : (jobs[mode][round]?.requiredCalls() ?? 0)),
          0,
        );
        const completionCalls = queryCost('bicycle', place(proposed.hire), place(proposed.drop));
        if (
          pendingRoadCalls() &&
          !context.budget.closed &&
          context.budget.remaining - carReserved - otherModeCalls <
            queryCost('walking', from, to) + completionCalls + pendingRoadCalls()
        )
          await settleRoads();
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
        if (walk && !needsRentalAccessComparison(walk, context.now)) break;
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
    if (selected.hire.id === job.stations.hire.id && selected.drop.id === job.stations.drop.id)
      return;
    diagnostics.accessImprovements++;
    const promote = (stations: NonNullable<RentalJob['stations']>, position: number) => {
      if (
        stations.hire.id === stations.drop.id ||
        completedBicyclePairs.has(bicyclePairKey(job.pair, stations))
      )
        return false;
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
      next.walks = { ...next.walks, ...walks };
      jobs.bicycle.splice(position, 0, next);
      if (existing < 0 || existing >= primaryBicycleCount) primaryBicycleCount++;
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
      if (returnVariant?.stations)
        promote({ hire: selected.hire, drop: returnVariant.stations.drop }, round + 2);
    }
    primaryRounds = Math.max(primaryBicycleCount, docklessRounds());
    if (promoted) deferRoadUntilRound = Math.max(deferRoadUntilRound, round + 1);
  };
  for (const endpoints of prefetch.values()) {
    if (
      context.budget.remaining - carReserved <=
      queryCost('transit', endpoints.origin, endpoints.destination)
    )
      break;
    void context.provider.transit(endpoints, context.budget).catch(() => undefined);
  }
  /** A dockless rental between the job's anchors. With `effects`, what it reports (omitted devices, walking
   * alternatives) is held there until its turn comes, so a result that is never taken changes nothing. */
  const routeDockless = (mode: DocklessMode, job: RentalJob, effects?: (() => void)[]) => {
    const report = (effect: () => void) => (effects ? effects.push(effect) : effect());
    return docklessConnection(
      effects
        ? {
            ...context,
            onWalkingAlternatives: (routes) =>
              report(() => context.onWalkingAlternatives?.(routes)),
          }
        : context,
      DOCKLESS_PROFILES[mode],
      request.preferences,
      job.from,
      job.to,
      `graph-${mode}-${job.index}`,
      {
        onCandidateLimited: (count) =>
          report(() => {
            limitRental(mode, count);
            if (mode === 'scooter') context.onScooterCandidateLimited?.(count);
          }),
        onBudgetLimited: () =>
          report(() => {
            markBudgetSkipped(`${mode}:${pairKey(job.pair)}:devices`);
            if (mode === 'scooter') context.onScooterBudgetLimited?.();
          }),
        onReturnBlocked: () =>
          report(() => {
            if (at(job.to, request.destination)) diagnostics.returnBlockedByMode[mode]++;
          }),
      },
    );
  };
  // On self-hosted walk and bicycle networks a dockless rental spends no budget, so a round's dockless jobs are
  // routed while its 따릉이 job is. Each result is taken at its turn, after the same checks, in the same order.
  const docklessAhead =
    routeQueryIsFree(context.provider, 'walking') && routeQueryIsFree(context.provider, 'bicycle');
  for (let round = 0; round < Math.max(jobs.bicycle.length, docklessRounds()); round++) {
    const routedAhead = new Map<RentalKind, { take: () => Promise<BaseSegment[] | null> }>();
    for (const mode of docklessAhead ? docklessKinds : []) {
      const job = jobs[mode][round];
      if (
        !job ||
        blockedModes.has(mode) ||
        !rentalHasRoom(job) ||
        (job.requiredCalls() > 0 && context.budget.remaining - carReserved < job.requiredCalls())
      )
        continue;
      const effects: (() => void)[] = [];
      const routing = routeDockless(mode, job, effects);
      routing.catch(() => undefined);
      const replay = () => effects.splice(0).forEach((effect) => effect());
      routedAhead.set(mode, {
        take: () =>
          routing.then(
            (segments) => (replay(), segments),
            (error) => {
              replay();
              throw error;
            },
          ),
      });
    }
    for (const mode of ['bicycle', ...docklessKinds] as const) {
      const job = jobs[mode][round];
      if (!job) continue;
      if (blockedModes.has(mode) || (job.pair.continuation && transitBlocked)) continue;
      const { pair, index } = job;
      const key = pairKey(pair),
        logicalKey = `${mode}:${key}`,
        successful = successfulRentalPairs[mode];
      if (!rentalHasRoom(job)) {
        if (!skippedCandidateKeys.has(logicalKey)) {
          skippedCandidateKeys.add(logicalKey);
          limitRental(mode);
        }
        continue;
      }
      // Run alongside in-flight road lookups only when the free calls cover both; otherwise let them finish first, as before.
      // A closed window stays closed during the rounds, so waiting would not change that check.
      if (
        pendingRoadCalls() &&
        !context.budget.closed &&
        context.budget.remaining - carReserved < job.requiredCalls() + pendingRoadCalls()
      )
        await settleRoads();
      // A job that spends no call (a self-hosted network, a remembered answer) needs no room in the budget.
      if (job.requiredCalls() > 0 && context.budget.remaining - carReserved < job.requiredCalls()) {
        markBudgetSkipped(logicalKey);
        continue;
      }
      const prefix = `graph-${mode}-${index}`;
      diagnostics.rentalAttempts++;
      const continuationQueries = continuationEndpoints(job);
      const continuationCost = (queries: RouteEndpoints[]) =>
        queries.reduce(
          (sum, endpoints) => sum + queryCost('transit', endpoints.origin, endpoints.destination),
          0,
        );
      const rental = () =>
        guarded(
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
              : (routedAhead.get(mode)?.take() ?? routeDockless(mode, job)),
          'routing',
          logicalKey,
        );
      const segments =
        pair.continuation === 'both'
          ? await context.budget.withReservedCalls(
              carReserved + continuationCost(continuationQueries),
              rental,
            )
          : await context.budget.withReservedCalls(carReserved, rental);
      if (!segments?.length) {
        diagnostics.unavailableRentals++;
        continue;
      }
      if (pair.continuation) {
        const staged: BaseRoute[] = [];
        let complete = true;
        // Both halves of a two-sided continuation are asked for at once; neither is published unless both connect.
        const continuations = await context.budget.withReservedCalls(carReserved, () =>
          Promise.all(
            continuationQueries.map((endpoints) =>
              guarded(mode, () => context.connectTransit!(endpoints), 'transit', logicalKey),
            ),
          ),
        );
        for (const [queryIndex, endpoints] of continuationQueries.entries()) {
          const continuation = continuations[queryIndex];
          const routes = continuation?.filter(
            (route) =>
              route.segments.some((segment) => isTransit(segment.mode)) &&
              (pair.continuation !== 'both' ||
                (at(route.segments[0].start, endpoints.origin) &&
                  at(route.segments.at(-1)!.end, endpoints.destination) &&
                  !route.notes?.some(
                    (note) =>
                      note.title === '역 내부 보행 연결 미확인' ||
                      note.title === '출발·환승 연결 미확인',
                  ) &&
                  route.segments.every(
                    (segment, position) =>
                      validPoint(segment.start) &&
                      validPoint(segment.end) &&
                      ['walk', 'entry', 'wait', 'bus', 'subway'].includes(segment.mode) &&
                      Number.isFinite(segment.distanceMeters) &&
                      segment.distanceMeters >= 0 &&
                      Number.isFinite(segment.durationSeconds.min) &&
                      Number.isFinite(segment.durationSeconds.max) &&
                      segment.durationSeconds.min >= 0 &&
                      segment.durationSeconds.max >= segment.durationSeconds.min &&
                      (!position || at(route.segments[position - 1].end, segment.start)) &&
                      !segment.traffic?.some((span) => span.level === 'blocked') &&
                      (['entry', 'wait'].includes(segment.mode)
                        ? at(segment.start, segment.end)
                        : !segment.distanceMeters ||
                          (!!segment.polyline &&
                            segment.polyline.length >= 2 &&
                            segment.polyline.every(validPoint) &&
                            metersBetween(segment.polyline[0], segment.start) <=
                              MAX_CONNECTOR_METERS &&
                            metersBetween(segment.polyline.at(-1)!, segment.end) <=
                              MAX_CONNECTOR_METERS)),
                  ))),
          );
          if (!routes?.length) {
            diagnostics.unavailableRentals++;
            complete = false;
            break;
          }
          staged.push(...routes);
        }
        if (!complete) continue;
        // Publish neither half until both real street-level station connections exist.
        for (const [routeIndex, route] of staged.entries()) {
          const ids = new Map(
            route.segments.map((segment) => [
              segment.id,
              `${prefix}-transit-${routeIndex}-${segment.id}`,
            ]),
          );
          bridges.push({
            ...route,
            id: `${prefix}-transit-${routeIndex}`,
            segments: route.segments.map((segment) => ({ ...segment, id: ids.get(segment.id)! })),
            notes: route.notes?.map((note) =>
              note.segmentId
                ? { ...note, segmentId: ids.get(note.segmentId) ?? note.segmentId }
                : note,
            ),
          });
        }
      }
      successful.add(key);
      if (pair.continuation) {
        successfulContinuations[mode].add(key);
        continuationSlots.add(slotOf(job));
      }
      diagnostics.rentalConnections++;
      if (mode === 'bicycle' && job.stations) {
        completedBicyclePairs.add(bicyclePairKey(pair, job.stations));
        await refineAccess(job, segments, round);
      }
      const connected = { ...pair, from: job.from, to: job.to };
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
        ...(['bicycle', ...docklessKinds] as const).map((mode) => {
          if (blockedModes.has(mode)) return 0;
          const next = jobs[mode]
            .slice(round + 1, mode === 'bicycle' ? primaryBicycleCount : undefined)
            .find(
              (job) =>
                !(job.pair.continuation && transitBlocked) &&
                rentalHasRoom(job) &&
                job.requiredCalls() > 0,
            );
          return next?.requiredCalls() ?? 0;
        }),
      );
      // Protect the next paid primary comparison, including a different return.
      // Cached jobs stay free; pickup-only refinement remains after road expansion.
      // A later comparison starts after the earlier one has finished, as before.
      await Promise.all(roadBatches.map((batch) => batch.task));
      const routes: (BaseRoute | null)[] = [];
      const batch: RoadBatch = {
        at: bridges.length,
        routes,
        done: false,
        task: Promise.resolve(),
        taxis:
          Number(deferDirectTaxi) +
          connectedRentals.reduce(
            (sum, pair) =>
              sum +
              Number(metersBetween(pair.to, request.destination) >= 350) +
              Number(metersBetween(request.origin, pair.from) >= 350),
            0,
          ),
      };
      batch.task = context.budget
        .withReservedCalls(nextRentalCalls, async () => {
          if (deferDirectTaxi)
            await taxi(request.origin, request.destination, 'graph-taxi-direct', undefined, routes);
          await completeRentalRoads(routes);
        })
        .finally(() => {
          batch.done = true;
        });
      void batch.task.catch(() => undefined);
      roadBatches.push(batch);
    }
  }
  // Within the rider's 따릉이 cap as the crow flies, the whole trip can ride past the cap on the bicycle network (a river
  // crossing). Then no ride reaches the destination: return at a dock short of it, within the cap, and walk the rest, so
  // the 따릉이 tab keeps a route that rides 따릉이 alone. On self-hosted networks this costs no call.
  const wholeBicycle = jobs.bicycle.find((job) => job.pair.direct && job.stations);
  if (
    wholeBicycle &&
    !successfulRentalPairs.bicycle.has(wholeTrip) &&
    // Only the ride this search already has (or a free network) is read again: an unanswered ride is no evidence.
    routeQueryIsReusable(
      context.provider,
      'bicycle',
      {
        origin: place(wholeBicycle.stations!.hire),
        destination: place(wholeBicycle.stations!.drop),
      },
      context.budget,
    ) &&
    !blockedModes.has('bicycle') &&
    !blockedModes.has('walk')
  ) {
    const cappedKey = `bicycle:${wholeTrip}:capped`;
    const returns =
      (await guarded(
        'bicycle',
        () =>
          cappedBicycleStationPairs(
            context,
            request.preferences,
            wholeBicycle.stations!,
            request.destination,
          ),
        'routing',
        cappedKey,
      )) ?? [];
    for (const [alternative, stations] of returns.entries()) {
      const hire = place(stations.hire),
        drop = place(stations.drop);
      const calls =
        queryCost('bicycle', hire, drop) +
        (metersBetween(request.origin, hire) >= 1
          ? queryCost('walking', request.origin, hire)
          : 0) +
        queryCost('walking', drop, request.destination);
      if (calls > 0 && context.budget.remaining - carReserved < calls) {
        markBudgetSkipped(cappedKey);
        break;
      }
      diagnostics.rentalAttempts++;
      const prefix = `graph-bicycle-capped-${alternative}`;
      const segments = await context.budget.withReservedCalls(carReserved, () =>
        guarded(
          'bicycle',
          () =>
            cappedBicycleConnection(
              context,
              request.preferences,
              request.origin,
              request.destination,
              prefix,
              stations,
            ),
          'routing',
          cappedKey,
        ),
      );
      if (!segments?.length) {
        diagnostics.unavailableRentals++;
        continue;
      }
      diagnostics.rentalConnections++;
      bridges.push(
        totals({
          id: `${prefix}-bridge`,
          title: multimodalTitle(segments),
          segments,
          transfers: 0,
          notes: bicycleNotes(segments, context.now),
        }),
      );
      break;
    }
  }
  // Everything below reads what the road lookups found (their pairs, failures and blocked modes), as before.
  await settleRoads();
  if (
    carReserved &&
    context.budget.remaining >=
      2 + Number(metersBetween(request.origin, request.preferences.carLocation!) >= 1)
  ) {
    const car = await guarded('car', () =>
      multimodalRoutes(
        {
          ...request,
          preferences: {
            ...request.preferences,
            allowTaxi: false,
            allowBicycle: false,
            allowScooter: false,
            allowEbike: false,
          },
        },
        { walking: [], transit },
        {
          ...context,
          candidateScope: 'primary',
          includeParkAndRide: true,
          onCarBudgetLimited: () => markBudgetSkipped('routing:car-candidates'),
          onCarCandidateLimited: () => {
            diagnostics.candidateLimitSkipped++;
          },
        },
      ),
    );
    bridges.push(
      ...(car ?? []).filter((route) => route.segments.some((segment) => segment.mode === 'car')),
    );
  } else if (carReserved) {
    markBudgetSkipped('routing:car-candidates');
  }
  await context.onRentalsComplete?.();
  await taxi(request.origin, request.destination, 'graph-taxi-direct');
  // The last three batches are independent lookups, each checking the shared budget before its call, and are
  // started in this order: tail/head bridges (bicycle/scooter→taxi and taxi→rental), taxi splices, transfer walks.
  // They run together; their bridges are kept in batch order, as when each batch was awaited in turn.
  const roads: (BaseRoute | null)[] = [];
  await Promise.all([
    completeRentalRoads(roads),
    early ?? Promise.all([startSplices(), startTransfers()]),
  ]);
  bridges.push(...roads, ...splices, ...transfers);
  finish();
  const ordered: (BaseRoute | null)[] = [];
  for (let index = 0; index <= bridges.length; index++) {
    for (const batch of roadBatches) if (batch.at === index) ordered.push(...batch.routes);
    if (index < bridges.length) ordered.push(bridges[index]);
  }
  return ordered.filter((route): route is BaseRoute => route !== null);
}
