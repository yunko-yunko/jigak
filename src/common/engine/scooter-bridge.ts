import {
  MAX_NETWORK_SNAP_METERS,
  type BaseRoute,
  type BaseSegment,
  type MobilityPreferences,
  type Place,
  type Provenance,
} from '../shared/domain/index.js';
import type { MobilityKind } from '../shared/intelligence/types.js';
import { ApiError } from './errors.js';
import type { MultimodalContext } from './multimodal.js';
import type { SharedScooter } from './realtime/mobility.js';
import { metersBetween } from './realtime/names.js';
import { acquisitionTiming } from './acquisition-priority.js';
import { routeQueryIsFree } from './connectivity/query-reuse.js';
import { EBIKE_TOP_KMH, SCOOTER_TOP_KMH } from './simulation/scooter-router.js';
import { SIMULATION_LABEL, SIMULATION_PROVIDER } from './simulation/shared-scooter-sim.js';

/** Dockless shared vehicles: found parked, ridden, parked again where the operator allows. */
export type DocklessMode = 'scooter' | 'ebike';
export const DOCKLESS_MODES: readonly DocklessMode[] = ['scooter', 'ebike'];

export interface ScooterVehicle extends SharedScooter {
  source: 'tago-pm' | 'gbfs';
  /** Rider-facing name of the device; defaults to the provider's. */
  label?: string;
  /** The map kind the device was reported as; a policy refuses a device of another kind. */
  kind?: MobilityKind;
}
export type DocklessVehicle = ScooterVehicle;
/** Supplied by an authorized operator adapter, never inferred from a vehicle dot. */
export interface ScooterRentalPermission {
  vehicleId: string;
  provider: string;
  dropoff: Place;
  verifiedAt: number;
  validUntil: number;
  pickupAllowed: boolean;
  returnAllowed: boolean;
  eligibilityAllowed: boolean;
  /** Unlock and park/lock/photo seconds, as the operator (or the simulator's assumptions) states them. */
  hireSeconds: number;
  returnSeconds: number;
  unlockFeeWon: number;
  /** Operator-confirmed whole-minute ride tariff; adapters with other tariffs must quote separately. */
  perMinuteWon: number;
  returnFeeWon: number;
  /** Source of the hire, ride and return segments; required for simulated vehicles. */
  provenance?: Provenance;
}
export type DocklessRentalPermission = ScooterRentalPermission;
export interface DocklessRentalPolicy {
  /** A simulator's model version; its simulated permissions must carry the same one. */
  readonly modelVersion?: string;
  verify(input: {
    vehicle: DocklessVehicle;
    origin: Place;
    destination: Place;
    now: number;
    /** The kind of rental asked for; absent from older callers, which only rent scooters. */
    mode?: DocklessMode;
  }): Promise<DocklessRentalPermission | null>;
  /**
   * A legal street spot near `near` where a ride of `mode` may end (or begin), or one legal for
   * every kind when `mode` is absent; with `entrance`, `near` is a subway platform and the spot is
   * by its street entrance. Null means no ride of that kind may end near `near` at all, so no
   * device is looked for. Without it, a dockless ride never continues into a transit query.
   */
  returnPoint?(near: Place, entrance?: boolean, mode?: DocklessMode): Place | null;
  /**
   * False when a ridden path breaks a street rule for this kind (킥보드 없는 거리, R28): the ride
   * then takes the router's next alternative, or the next device. Absent means no such rule.
   */
  rideAllowed?(path: readonly Pick<Place, 'latitude' | 'longitude'>[], mode: DocklessMode): boolean;
}
export interface ScooterConnectionContext extends MultimodalContext {
  scooterPolicy?: DocklessRentalPolicy;
  /** Permissions for dockless e-bikes; without it no e-bike rental is offered. */
  ebikePolicy?: DocklessRentalPolicy;
  onScooterCandidateLimited?: (count: number) => void;
  onScooterBudgetLimited?: () => void;
}
export type DocklessConnectionContext = ScooterConnectionContext;

export interface DocklessProfile {
  mode: DocklessMode;
  /** Only map markers of this kind are offered for this rental. */
  markerKind: Extract<MobilityKind, 'kick-scooter' | 'e-bicycle'>;
  noun: string;
  /** Label of the server's own simulated devices of this kind. */
  simulatedLabel: string;
  /** Straight-line radius in which parked devices are looked for; only a pre-filter for the routed walk cap. */
  searchMeters: number;
  /** Longest routed walk to the device. */
  accessMeters: number;
  /** Typical riding speed; it only orders which parked devices are routed first. */
  rideKmh: number;
  /** The fastest the router times a ride of this kind; the best case a device not routed could still reach. */
  topKmh: number;
  /** Longest routed walk from the parking spot, and its distance from the destination. */
  egressMeters: number;
  rideMeters: number;
  minBattery: number;
  /** Distinct pickup spots compared with complete routes before the best one is kept. */
  pickupComparisons: number;
  policy(context: DocklessConnectionContext): DocklessRentalPolicy | undefined;
  router(context: DocklessConnectionContext): MultimodalContext['provider']['scooter'];
  allowed(preferences: MobilityPreferences): boolean;
}
/** About five minutes' walk (research §6) as the crow flies, up to 700 m walked around blocks. The walked
 * distance is the cap; the straight-line radius only skips devices no walk under the cap can reach. */
const DOCKLESS_SEARCH = {
  searchMeters: 700,
  accessMeters: 700,
  egressMeters: 500,
  minBattery: 20,
  pickupComparisons: 3,
};
export const DOCKLESS_PROFILES: Readonly<Record<DocklessMode, DocklessProfile>> = {
  scooter: {
    mode: 'scooter',
    markerKind: 'kick-scooter',
    noun: '킥보드',
    simulatedLabel: SIMULATION_LABEL,
    ...DOCKLESS_SEARCH,
    rideMeters: 6_000,
    // Middle of the 14–20 km/h ride timing (simulation/scooter-router.ts).
    rideKmh: 17,
    topKmh: SCOOTER_TOP_KMH,
    policy: (context) => context.scooterPolicy,
    router: (context) => context.provider.scooter?.bind(context.provider),
    // Kick-scooters need a 원동기장치자전거 licence (도로교통법); e-bikes need none.
    allowed: (preferences) =>
      preferences.allowScooter !== false && preferences.hasScooterLicense !== false,
  },
  ebike: {
    mode: 'ebike',
    markerKind: 'e-bicycle',
    noun: '전기자전거',
    simulatedLabel: '시연용 가상 전기자전거',
    ...DOCKLESS_SEARCH,
    // Assist range covers far more; past 8 km another mode is nearly always faster (가정값).
    rideMeters: 8_000,
    // Middle of the 17–21 km/h ride timing (simulation/scooter-router.ts).
    rideKmh: 19,
    topKmh: EBIKE_TOP_KMH,
    policy: (context) => context.ebikePolicy,
    router: (context) => context.provider.ebike?.bind(context.provider),
    allowed: (preferences) => preferences.allowEbike !== false,
  },
};
/** True when this search can offer the kind at all: a router, a policy and the rider's consent. */
export const docklessEnabled = (
  context: DocklessConnectionContext,
  preferences: MobilityPreferences,
  mode: DocklessMode,
) =>
  !preferences.walkingOnly &&
  DOCKLESS_PROFILES[mode].allowed(preferences) &&
  !!DOCKLESS_PROFILES[mode].router(context) &&
  !!DOCKLESS_PROFILES[mode].policy(context);
type WalkingAlternatives = Parameters<
  NonNullable<DocklessConnectionContext['onWalkingAlternatives']>
>[0];
const MAX_AGE_MS = 120_000;
/** Walking speed that only orders which devices are routed first (4.5 km/h, 가정값). */
const ORDER_WALK_KMH = 4.5;
/** The fastest walk a device not routed could still have (6 km/h, a brisk walk; 가정값). */
const BEST_WALK_KMH = 6;
/** Devices this close together are one pickup: the rider walks to the best-charged of them (가정값). */
const PICKUP_MERGE_METERS = 10;
/** Other devices of a merged pickup tried when its best-charged one is refused (가정값). */
const PICKUP_ALTERNATES = 3;
/**
 * Devices of the asked kind kept for one search: those with the shortest walk-and-ride estimate,
 * not merely the nearest (§15.5, CONTRACT4 §1.4).
 */
export const ROUTER_DEVICES_PER_KIND = 200;
/**
 * Devices of the asked kind read from a feed before that cut: 1.5 times the most rentable devices
 * measured within 700 m (392, 목동 weekday 08:30), so the cut, not the feed, decides (가정값).
 */
export const ROUTER_FEED_PER_KIND = 600;
/**
 * Devices routed in full for one search. Each costs at most three route calls (ride, walk to it,
 * walk from the spot) and the return check one more, so a search stays within 24 calls however
 * many devices stand near (가정값).
 */
const ROUTED_DEVICES = 7;
const validPoint = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;
const at = (
  left: Pick<Place, 'latitude' | 'longitude'>,
  right: Pick<Place, 'latitude' | 'longitude'>,
) =>
  Math.abs(left.latitude - right.latitude) < 0.000001 &&
  Math.abs(left.longitude - right.longitude) < 0.000001;
const recent = (stamp: number | null | undefined, now: number) =>
  typeof stamp === 'number' &&
  Number.isFinite(stamp) &&
  stamp > 0 &&
  stamp <= now + 30_000 &&
  now - stamp <= MAX_AGE_MS;
const nonnegative = (number: number) => Number.isSafeInteger(number) && number >= 0;
const sum = (segments: BaseSegment[], edge: 'min' | 'max') =>
  segments.reduce((total, segment) => total + segment.durationSeconds[edge], 0);
const meters = (segments: BaseSegment[]) =>
  segments.reduce((total, segment) => total + segment.distanceMeters, 0);
/** A ride's path and a walk's unrecorded gap stay within 75 m of their anchors. A foot network that
 * moved a start inside a park or campus onto its nearest link records that gap, up to 150 m: the
 * same reach the journey graph gives it. */
const reach = (segment: BaseSegment, side: 'start' | 'end') =>
  segment.mode !== 'walk'
    ? 75
    : Math.min(
        MAX_NETWORK_SNAP_METERS,
        Math.max(
          75,
          (segment.networkSnap?.[side === 'start' ? 'startMeters' : 'endMeters'] ?? 0) + 2,
        ),
      );
/** The straight stretch between the requested points and the walked path, which the rider still walks. */
const offPath = (segments: BaseSegment[], from: Place, to: Place) => {
  const walks = segments.filter((segment) => segment.mode === 'walk' && segment.polyline?.length);
  return walks.length
    ? metersBetween(from, walks[0].polyline![0]) +
        metersBetween(walks.at(-1)!.polyline!.at(-1)!, to)
    : 0;
};
/** The ridden path of a ride's moving segments, in order. */
const ridePath = (segments: BaseSegment[], mode: DocklessMode) =>
  segments.flatMap((segment) => (segment.mode === mode ? (segment.polyline ?? []) : []));
const pointKey = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

/**
 * A device the router may take. A simulated device is usable exactly when the simulator shows it
 * as rentable, which already applies the simulated operator's own low-battery rule (R1), so the
 * flat threshold of real operator feeds is not applied to it a second time.
 */
function usableVehicle(
  vehicle: DocklessVehicle,
  from: Place,
  now: number,
  profile: DocklessProfile,
): boolean {
  return (
    !!vehicle.id &&
    !!vehicle.provider &&
    validPoint(vehicle) &&
    metersBetween(from, vehicle) <= profile.searchMeters &&
    vehicle.battery !== null &&
    Number.isFinite(vehicle.battery) &&
    vehicle.battery >= (vehicle.simulated ? 0 : profile.minBattery) &&
    vehicle.battery <= 100 &&
    recent(vehicle.receivedAt, now) &&
    recent(vehicle.observedAt, now)
  );
}

/**
 * One pickup per spot: devices within PICKUP_MERGE_METERS of a better-charged device stand behind
 * it. A pile of fifty devices is one comparison, not fifty tabled places, and if the best-charged
 * device is refused the next of its pickup is tried (at most PICKUP_ALTERNATES).
 */
function mergePickups(devices: readonly DocklessVehicle[]) {
  const cell = (point: Pick<Place, 'latitude' | 'longitude'>) => [
    Math.floor((point.latitude * 111_195) / PICKUP_MERGE_METERS),
    Math.floor(
      (point.longitude * 111_195 * Math.cos((point.latitude * Math.PI) / 180)) /
        PICKUP_MERGE_METERS,
    ),
  ];
  const grid = new Map<string, DocklessVehicle[]>();
  const alternates = new Map<DocklessVehicle, DocklessVehicle[]>();
  const kept: DocklessVehicle[] = [];
  const byCharge = [...devices].sort(
    (a, b) =>
      (b.battery ?? 0) - (a.battery ?? 0) ||
      a.distanceMeters - b.distanceMeters ||
      a.id.localeCompare(b.id),
  );
  for (const device of byCharge) {
    const [row, column] = cell(device);
    let head: DocklessVehicle | undefined;
    for (let r = row - 1; r <= row + 1 && !head; r++)
      for (let c = column - 1; c <= column + 1 && !head; c++)
        head = grid
          .get(`${r}:${c}`)
          ?.find((other) => metersBetween(other, device) <= PICKUP_MERGE_METERS);
    if (head) {
      const behind = alternates.get(head) ?? [];
      if (behind.length < PICKUP_ALTERNATES) alternates.set(head, [...behind, device]);
      continue;
    }
    kept.push(device);
    const key = `${row}:${column}`;
    grid.set(key, [...(grid.get(key) ?? []), device]);
  }
  return { pickups: kept, alternates };
}

/** Geometry is validated before outer anchors are normalized to the actual requested points. */
function routed(
  route: BaseRoute | undefined,
  mode: 'walk' | DocklessMode,
  from: Place,
  to: Place,
): BaseSegment[] | null {
  if (!route?.segments.length || !route.segments.some((segment) => segment.mode === mode))
    return null;
  const segments = route.segments;
  if (
    segments.some((segment, index) => {
      if (
        !validPoint(segment.start) ||
        !validPoint(segment.end) ||
        !Number.isFinite(segment.distanceMeters) ||
        segment.distanceMeters < 0 ||
        !Number.isFinite(segment.durationSeconds.min) ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.min < 0 ||
        segment.durationSeconds.max < segment.durationSeconds.min ||
        segment.traffic?.some((span) => span.level === 'blocked') ||
        (index > 0 && !at(segments[index - 1].end, segment.start))
      )
        return true;
      if (segment.mode === 'wait')
        return (
          segment.distanceMeters !== 0 ||
          !at(segment.start, segment.end) ||
          segment.timingRule !== undefined
        );
      if (segment.mode !== mode || (mode !== 'walk' && segment.routingProfile !== mode))
        return true;
      const path = segment.polyline;
      return (
        !path ||
        path.length < 2 ||
        !path.every(validPoint) ||
        metersBetween(path[0], segment.start) > reach(segment, 'start') ||
        metersBetween(path.at(-1)!, segment.end) > reach(segment, 'end')
      );
    })
  )
    return null;
  const first = segments[0],
    last = segments.at(-1)!;
  const firstMoving = segments.find((segment) => segment.mode === mode)!,
    lastMoving = segments.filter((segment) => segment.mode === mode).at(-1)!;
  if (
    metersBetween(first.start, from) > reach(firstMoving, 'start') ||
    metersBetween(last.end, to) > reach(lastMoving, 'end') ||
    metersBetween(firstMoving.polyline![0], from) > reach(firstMoving, 'start') ||
    metersBetween(lastMoving.polyline!.at(-1)!, to) > reach(lastMoving, 'end')
  )
    return null;
  return segments.map((segment, index) => ({
    ...segment,
    start: index === 0 ? from : segment.start,
    end: index === segments.length - 1 ? to : segment.end,
  }));
}

async function walk(
  context: DocklessConnectionContext,
  from: Place,
  to: Place,
  maxMeters: number,
  maxSeconds = Infinity,
  onAlternatives = context.onWalkingAlternatives,
): Promise<BaseSegment[] | null> {
  if (metersBetween(from, to) < 1) return [];
  const alternatives = await context.provider.walking(
    { origin: from, destination: to },
    context.budget,
  );
  const candidates = alternatives.flatMap((route) => {
    const segments = routed(route, 'walk', from, to);
    // The snapped stretch is walked too, so it counts toward the cap.
    if (!segments || meters(segments) + offPath(segments, from, to) > maxMeters) return [];
    return [
      {
        route,
        segments,
        cost: acquisitionTiming({ ...route, segments }, context.now, context.acquisitionObjective)
          .total,
        id: route.id,
      },
    ];
  });
  if (candidates.length > 1)
    onAlternatives?.(
      candidates.map(({ route, segments }) => ({
        ...route,
        segments,
        durationSeconds: { min: sum(segments, 'min'), max: sum(segments, 'max') },
        distanceMeters: meters(segments),
      })),
    );
  return (
    candidates
      .filter((candidate) => sum(candidate.segments, 'max') <= maxSeconds)
      .sort(
        (a, b) =>
          a.cost - b.cost ||
          sum(a.segments, 'max') - sum(b.segments, 'max') ||
          a.id.localeCompare(b.id),
      )[0]?.segments ?? null
  );
}

function permitted(
  permission: DocklessRentalPermission | null,
  vehicle: DocklessVehicle,
  to: Place,
  now: number,
  profile: DocklessProfile,
): permission is DocklessRentalPermission {
  return (
    !!permission &&
    permission.vehicleId === vehicle.id &&
    permission.provider === vehicle.provider &&
    permission.pickupAllowed === true &&
    permission.returnAllowed === true &&
    permission.eligibilityAllowed === true &&
    recent(permission.verifiedAt, now) &&
    Number.isFinite(permission.validUntil) &&
    permission.validUntil >= now &&
    validPoint(permission.dropoff) &&
    metersBetween(permission.dropoff, to) <= profile.egressMeters &&
    [
      permission.hireSeconds,
      permission.returnSeconds,
      permission.unlockFeeWon,
      permission.perMinuteWon,
      permission.returnFeeWon,
    ].every(nonnegative)
  );
}

/** Devices ranked by one walking and one riding table on the free networks; the straight-line order is the fallback. */
const TABLED_DEVICES = 50;
/**
 * A walk to a device loops when it is longer than LOOP_METERS and LOOP_RATIO times the straight
 * line (가정값): a device across a fence or a road with no mapped crossing (압구정역: 21 m apart,
 * 679 m walked). Such a device is routed after the others and does not use up a comparison, so
 * devices with a plain walk are looked at too; it still wins when its rental is the fastest.
 */
const LOOP_RATIO = 3;
const LOOP_METERS = 150;
/** Turns a tabled walk's seconds back into metres for the loop test: the foot network's 5 km/h. */
const TABLED_WALK_METERS_PER_SECOND = 5 / 3.6;
const loops = (walkedMeters: number, straightMeters: number) =>
  walkedMeters > LOOP_METERS && walkedMeters > LOOP_RATIO * straightMeters;

/**
 * Re-ranks the nearest devices by walked time to each plus riding time from each, as the networks
 * measure them, so a railway or a campus wall cannot make the nearest device use up the comparisons.
 * Devices whose walk loops go last (`loops`). Only the order changes: every device is still routed
 * and its walk held to the walked cap.
 */
async function networkOrder(
  context: DocklessConnectionContext,
  devices: DocklessVehicle[],
  from: Place,
  to: Place,
): Promise<{ order: DocklessVehicle[]; looping: Set<DocklessVehicle> }> {
  const table = context.provider.travelTable?.bind(context.provider);
  const ranked = devices.slice(0, TABLED_DEVICES);
  const looping = new Set<DocklessVehicle>();
  if (!table || ranked.length < 2) return { order: devices, looping };
  const points = ranked.map((vehicle) => ({
    id: vehicle.id,
    name: vehicle.id,
    address: '',
    latitude: vehicle.latitude,
    longitude: vehicle.longitude,
  }));
  try {
    const [walking, riding] = await Promise.all([
      table('walking', [from], points, context.budget),
      table('bicycle', points, [to], context.budget),
    ]);
    const seconds = ranked.map((_, index) => {
      const walk = walking.seconds[0]?.[index],
        ride = riding.seconds[index]?.[0];
      return typeof walk === 'number' &&
        typeof ride === 'number' &&
        Number.isFinite(walk) &&
        Number.isFinite(ride)
        ? walk + ride
        : Infinity;
    });
    ranked.forEach((vehicle, index) => {
      const walk = walking.seconds[0]?.[index];
      if (
        typeof walk === 'number' &&
        loops(walk * TABLED_WALK_METERS_PER_SECOND, metersBetween(from, vehicle))
      )
        looping.add(vehicle);
    });
    const late = (index: number) => (looping.has(ranked[index]) ? 1 : 0);
    const order = ranked
      .map((_, index) => index)
      .sort((a, b) => late(a) - late(b) || seconds[a] - seconds[b] || a - b);
    return {
      order: [...order.map((index) => ranked[index]), ...devices.slice(ranked.length)],
      looping,
    };
  } catch (error) {
    if (error instanceof ApiError) return { order: devices, looping };
    throw error;
  }
}

/** Hooks for what a dockless search leaves out, so each kind reports its own omissions. */
export interface DocklessHooks {
  onCandidateLimited?: (count: number) => void;
  onBudgetLimited?: () => void;
  /** No spot this kind may be returned at lies within a walk of `to`, so every device fails alike. */
  onReturnBlocked?: () => void;
}

/**
 * False when the legal return spot nearest `to` is beyond the walk a rider takes from a parked
 * device: farther than the egress cap as the crow flies, or, on a free walking network, by the
 * walked route (a railway or a wall between them). A failed lookup proves nothing and passes.
 */
async function returnWithinWalk(
  context: DocklessConnectionContext,
  spot: Place,
  to: Place,
  profile: DocklessProfile,
): Promise<boolean> {
  if (!validPoint(spot) || metersBetween(spot, to) > profile.egressMeters) return false;
  if (metersBetween(spot, to) < 1 || !routeQueryIsFree(context.provider, 'walking')) return true;
  try {
    return !!(await walk(context, spot, to, profile.egressMeters, Infinity, () => undefined));
  } catch (error) {
    if (error instanceof ApiError) return true;
    throw error;
  }
}

/**
 * A rental arc between exact graph anchors. No PM adapter or permission evidence means
 * no arc. Existing TAGO/GBFS vehicle dots never imply eligibility or legal return zones.
 */
export async function scooterConnection(
  context: ScooterConnectionContext,
  preferences: MobilityPreferences,
  from: Place,
  to: Place,
  prefix: string,
): Promise<BaseSegment[] | null> {
  return docklessConnection(context, DOCKLESS_PROFILES.scooter, preferences, from, to, prefix, {
    onCandidateLimited: (count) => context.onScooterCandidateLimited?.(count),
    onBudgetLimited: () => context.onScooterBudgetLimited?.(),
  });
}

/** The same rental arc for a dockless e-bike: hire, ride the bicycle network, park and lock. */
export async function ebikeConnection(
  context: DocklessConnectionContext,
  preferences: MobilityPreferences,
  from: Place,
  to: Place,
  prefix: string,
  hooks: DocklessHooks = {},
): Promise<BaseSegment[] | null> {
  return docklessConnection(context, DOCKLESS_PROFILES.ebike, preferences, from, to, prefix, hooks);
}

/**
 * Finds parked devices of one kind near `from`, asks the operator's policy for each one, and
 * routes access, ride and egress for up to `pickupComparisons` distinct pickup spots. The best
 * complete rental by the search's arrival objective wins; nearness only orders the discovery.
 *
 * However many devices stand near (the real Seoul fleet puts hundreds within a walk), a search
 * reads the nearest 200 of the kind, merges devices within 10 m into one pickup, asks the
 * network for two tables, and routes at most seven devices: 22 route calls. A device whose best
 * case cannot beat the best rental found is not routed, and `onCandidateLimited` fires only for
 * devices left unrouted that could still have beaten it.
 */
export async function docklessConnection(
  context: DocklessConnectionContext,
  profile: DocklessProfile,
  preferences: MobilityPreferences,
  from: Place,
  to: Place,
  prefix: string,
  hooks: DocklessHooks = {},
): Promise<BaseSegment[] | null> {
  const policy = profile.policy(context),
    router = profile.router(context);
  if (
    !docklessEnabled(context, preferences, profile.mode) ||
    !policy ||
    !router ||
    !context.mobility ||
    !validPoint(from) ||
    !validPoint(to) ||
    context.budget.remaining < 1
  )
    return null;
  // A destination no ride of this kind may end near refuses every device alike (용산구 R21 for
  // kick-scooters), and so does one whose only legal spot is beyond the walk from a parked device:
  // no device is looked for, so the search is not reported as cut short.
  if (policy.returnPoint) {
    const spot = policy.returnPoint(to, false, profile.mode);
    if (!spot || !(await returnWithinWalk(context, spot, to, profile))) {
      hooks.onReturnBlocked?.();
      return null;
    }
  }
  const mobility = context.mobility;
  // A feed that declares its kinds is asked only for its own; the operator-feed cap never pushes
  // the server's own simulator out of the search.
  const carries = (feed: (typeof mobility.gbfs)[number]) =>
    !feed.kinds || feed.kinds.includes(profile.markerKind);
  const feeds = [
    ...mobility.gbfs.filter((feed) => !feed.simulated && carries(feed)).slice(0, 20),
    ...mobility.gbfs.filter((feed) => feed.simulated && carries(feed)),
  ];
  const [tago, ...gbfs] = await Promise.all([
    // TAGO reports kick-scooters only.
    profile.mode === 'scooter'
      ? mobility.scooters.nearest(from, profile.searchMeters).catch(() => null)
      : null,
    ...feeds.map((feed) =>
      feed
        .nearby(from, profile.searchMeters, {
          kind: profile.markerKind,
          perKind: ROUTER_FEED_PER_KIND,
        })
        .catch(() => []),
    ),
  ]);
  const usable: DocklessVehicle[] = [
    ...(tago ? [{ ...tago, source: 'tago-pm' as const, kind: profile.markerKind }] : []),
    ...gbfs
      .flat()
      .filter(
        (marker) =>
          marker.kind === profile.markerKind &&
          marker.entity === 'vehicle' &&
          marker.available &&
          marker.freshness === 'fresh',
      )
      .map((marker) => ({
        id: marker.sourceId,
        provider: marker.provider,
        latitude: marker.latitude,
        longitude: marker.longitude,
        battery: marker.batteryPercent,
        distanceMeters: marker.distanceMeters,
        observedAt: marker.observedAt,
        receivedAt: marker.receivedAt,
        source: 'gbfs' as const,
        kind: profile.markerKind,
        // Simulated devices answer to the simulator's own policy and keep their label in every leg.
        ...(marker.simulated
          ? {
              provider: SIMULATION_PROVIDER,
              label: profile.simulatedLabel,
              simulated: true as const,
            }
          : {}),
      })),
  ].filter((vehicle) => usableVehicle(vehicle, from, context.now, profile));
  // Devices are ranked by a straight-line walk-and-ride estimate, so a device behind the rider
  // cannot use up the comparisons (or the cut) before one on the way; distance breaks ties.
  const ranked = (devices: readonly DocklessVehicle[]) =>
    devices
      .map((vehicle) => ({
        vehicle,
        near: metersBetween(from, vehicle),
        order:
          metersBetween(from, vehicle) / ORDER_WALK_KMH +
          metersBetween(vehicle, to) / profile.rideKmh,
      }))
      .sort((left, right) => left.order - right.order || left.near - right.near)
      .map(({ vehicle }) => vehicle);
  const { pickups, alternates } = mergePickups(ranked(usable).slice(0, ROUTER_DEVICES_PER_KIND));
  const nearby = ranked(pickups);
  // On self-hosted walk and bicycle networks a device's routing spends no budget.
  const free =
    routeQueryIsFree(context.provider, 'walking') && routeQueryIsFree(context.provider, 'bicycle');
  const { order: candidates, looping } = free
    ? await networkOrder(context, nearby, from, to)
    : { order: nearby, looping: new Set<DocklessVehicle>() };
  const seen = new Set<string>();
  /**
   * The fewest seconds a rental by this device could take, however it is routed: the straight walk
   * to it at a brisk pace and the straight ride from it at the kind's top speed, with no unlock,
   * park or signal wait. Nothing real can be faster, so a device that cannot beat the best
   * rental found needs no routing, and one left unrouted that could beat it is a limit.
   */
  const bestCase = (vehicle: DocklessVehicle) =>
    metersBetween(from, vehicle) / (BEST_WALK_KMH / 3.6) +
    metersBetween(vehicle, to) / (profile.topKmh / 3.6);
  /** `floor` is the best rental's seconds without the unlock and park time every rental pays alike. */
  let best: { segments: BaseSegment[]; cost: number; upperSeconds: number; floor: number } | null =
    null;
  let routedDevices = 0;
  // Two devices parked on one spot give one comparison, not two; one whose walk loops gives none.
  const comparedPickups = new Set<string>();
  let loopingPickups = 0;
  const keyOf = (vehicle: DocklessVehicle) => `${vehicle.source}:${vehicle.provider}:${vehicle.id}`;
  /** One device's complete rental; it changes nothing outside, so it can run ahead of its turn. */
  type Outcome =
    | { status: 'refused' | 'budget' | 'capped' }
    | {
        status: 'routed';
        segments: BaseSegment[];
        cost: number;
        upperSeconds: number;
        floor: number;
        alternatives: WalkingAlternatives[];
        /** The routed walk to the device loops (`loops`). */
        loop: boolean;
      };
  /**
   * The device of a pickup to take: of those the policy permits, the one permitted longest (a
   * device about to be rented or collected may be gone before the rider arrives), and among
   * equals the best-charged. A permission that ends before the best case of the trip does is no
   * permission.
   */
  const permit = async (head: DocklessVehicle) => {
    let chosen: { vehicle: DocklessVehicle; permission: DocklessRentalPermission } | null = null;
    for (const vehicle of [head, ...(alternates.get(head) ?? [])]) {
      const permission = await policy
        .verify({ vehicle, origin: from, destination: to, now: context.now, mode: profile.mode })
        .catch(() => null);
      if (
        permitted(permission, vehicle, to, context.now, profile) &&
        (permission.validUntil - context.now) / 1000 >=
          permission.hireSeconds + bestCase(vehicle) + permission.returnSeconds &&
        (!chosen || permission.validUntil > chosen.permission.validUntil)
      )
        chosen = { vehicle, permission };
    }
    return chosen;
  };
  const evaluate = async (head: DocklessVehicle): Promise<Outcome> => {
    const refused = { status: 'refused' } as const;
    const picked = await permit(head);
    if (!picked) return refused;
    const { vehicle, permission } = picked;
    // A simulated device is never shown without its simulated provenance on every rental leg.
    const source = permission.provenance;
    if (
      vehicle.simulated
        ? source?.simulated !== true ||
          source.mode !== 'live' ||
          source.isRealtime ||
          // A permission from another simulator revision never mixes into this one's routes.
          source.modelVersion !== policy.modelVersion
        : source?.simulated
    )
      return refused;
    const sourced = source ? { routingSource: { ...source } } : {};
    // The ride's path still comes from its router: its label keeps naming that network, so the
    // OpenStreetMap credit and the public router's notice stay with the route.
    const rideSourced = (segment: BaseSegment) =>
      source
        ? {
            routingSource: {
              ...source,
              ...(segment.routingSource
                ? { label: `${source.label} · ${segment.routingSource.label}` }
                : {}),
            },
          }
        : {};
    const pickup: Place = {
      id: keyOf(vehicle),
      name: vehicle.label ?? `${vehicle.provider} ${profile.noun}`,
      address: '',
      latitude: vehicle.latitude,
      longitude: vehicle.longitude,
    };
    const dropoff = permission.dropoff;
    const requiredCalls =
      1 + (metersBetween(from, pickup) >= 1 ? 1 : 0) + (metersBetween(dropoff, to) >= 1 ? 1 : 0);
    if (routedDevices >= ROUTED_DEVICES) return { status: 'capped' };
    if (context.budget.remaining < requiredCalls) return { status: 'budget' };
    routedDevices++;
    try {
      const routes = await router({ origin: pickup, destination: dropoff }, context.budget);
      // A ride along a street this kind may not be ridden on takes the router's next alternative.
      let ride: BaseSegment[] | null = null;
      for (const route of routes) {
        ride = routed(route, profile.mode, pickup, dropoff);
        if (!ride || policy.rideAllowed?.(ridePath(ride, profile.mode), profile.mode) !== false)
          break;
        ride = null;
      }
      if (!ride || meters(ride) > profile.rideMeters) return refused;
      const accessLimit =
        (permission.validUntil - context.now) / 1000 -
        permission.hireSeconds -
        sum(ride, 'max') -
        permission.returnSeconds;
      // Walking alternatives are reported only for the device whose turn comes, access before egress.
      const alternatives: WalkingAlternatives[][] = [[], []];
      const [access, egress] = await Promise.all([
        walk(context, from, pickup, profile.accessMeters, accessLimit, (routes) =>
          alternatives[0].push(routes),
        ),
        walk(context, dropoff, to, profile.egressMeters, Infinity, (routes) =>
          alternatives[1].push(routes),
        ),
      ]);
      if (!access || !egress) return refused;
      const returnAt =
        context.now +
        (sum(access, 'max') +
          permission.hireSeconds +
          sum(ride, 'max') +
          permission.returnSeconds) *
          1000;
      if (permission.validUntil < returnAt) return refused;
      const rideCost = Math.ceil(sum(ride, 'max') / 60) * permission.perMinuteWon;
      if (!Number.isSafeInteger(rideCost)) return refused;
      const renumber = (segments: BaseSegment[], phase: string) =>
        segments.map((segment, index) => ({
          ...segment,
          id: `${prefix}-${phase}-${index}`,
          runAllowed: false,
          costWon: phase === 'ride' && index === 0 ? rideCost : undefined,
          ...(phase === 'ride' ? rideSourced(segment) : {}),
        }));
      const segments: BaseSegment[] = [
        ...renumber(access, 'access'),
        {
          id: `${prefix}-hire`,
          mode: 'hire',
          title: `${pickup.name} 대여`,
          instructions: vehicle.simulated
            ? '시연용 가상 데이터예요. 실제 기기와 대여는 없어요.'
            : '운영사에서 이용 자격과 대여 허용을 확인한 기기예요. 앱에서 잠금 해제를 완료해 주세요.',
          distanceMeters: 0,
          durationSeconds: { min: permission.hireSeconds, max: permission.hireSeconds },
          start: pickup,
          end: pickup,
          runAllowed: false,
          costWon: permission.unlockFeeWon,
          rentalValidity: {
            verifiedAt: permission.verifiedAt,
            validUntil: permission.validUntil,
            vehicleId: vehicle.id,
            provider: vehicle.provider,
          },
          ...sourced,
        },
        ...renumber(ride, 'ride'),
        {
          id: `${prefix}-return`,
          mode: 'return',
          title: `${dropoff.name}에 반납`,
          instructions: vehicle.simulated
            ? '시연용 가상 데이터예요. 실제 반납 절차는 없어요.'
            : '운영사가 확인한 반납 위치예요. 안전하게 주차하고 앱에서 반납 완료를 확인해 주세요.',
          distanceMeters: 0,
          durationSeconds: { min: permission.returnSeconds, max: permission.returnSeconds },
          start: dropoff,
          end: dropoff,
          runAllowed: false,
          costWon: permission.returnFeeWon,
          ...sourced,
        },
        ...renumber(egress, 'egress'),
      ];
      const upperSeconds = sum(segments, 'max');
      const candidate: BaseRoute = {
        id: prefix,
        title: `${profile.noun} 대여 연결`,
        segments,
        transfers: 0,
        distanceMeters: meters(segments),
        durationSeconds: { min: sum(segments, 'min'), max: upperSeconds },
      };
      const timing = acquisitionTiming(candidate, context.now, context.acquisitionObjective);
      const cost = timing.total;
      if (!Number.isFinite(cost)) return refused;
      // What a faster device could still save: every rental pays the unlock and the park alike.
      const fixed =
        timing.segments.length === segments.length
          ? segments.reduce(
              (total, segment, index) =>
                total +
                (segment.mode === 'hire' || segment.mode === 'return' ? timing.segments[index] : 0),
              0,
            )
          : permission.hireSeconds + permission.returnSeconds;
      return {
        status: 'routed',
        segments,
        cost,
        upperSeconds,
        floor: Math.max(0, cost - fixed),
        alternatives: alternatives.flat(),
        loop: loops(meters(access) + offPath(access, from, pickup), metersBetween(from, pickup)),
      };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return refused;
    }
  };
  // Free routing also lets the next devices be routed while this one is: every outcome is still
  // taken in the same order as one at a time.
  const started = new Map<number, Promise<Outcome>>();
  const start = (index: number) => {
    let outcome = started.get(index);
    if (!outcome) {
      outcome = evaluate(candidates[index]);
      // A device whose turn never comes must not leave an unobserved failure behind.
      outcome.catch(() => undefined);
      started.set(index, outcome);
    }
    return outcome;
  };
  /** A device that cannot beat the best rental found so far is not worth a route call. */
  const hopeless = (vehicle: DocklessVehicle) => !!best && bestCase(vehicle) >= best.floor;
  // Candidates from `unread` on were never looked at: the loop stopped before them.
  let unread = candidates.length;
  for (const [candidateIndex, vehicle] of candidates.entries()) {
    const key = keyOf(vehicle);
    if (seen.has(key)) continue;
    seen.add(key);
    if (comparedPickups.has(pointKey(vehicle)) || hopeless(vehicle)) continue;
    const outcome = free ? start(candidateIndex) : evaluate(vehicle);
    if (free) {
      const spots = new Set([pointKey(vehicle)]);
      for (
        let next = candidateIndex + 1;
        next < candidates.length &&
        spots.size < profile.pickupComparisons - (comparedPickups.size - loopingPickups);
        next++
      ) {
        const later = candidates[next];
        if (seen.has(keyOf(later)) || comparedPickups.has(pointKey(later))) continue;
        if (spots.has(pointKey(later)) || hopeless(later)) continue;
        spots.add(pointKey(later));
        void start(next);
      }
    }
    let result = await outcome;
    // A device of the same pickup a few metres nearer the rider may still be within the walk.
    const nearer =
      result.status === 'refused'
        ? (alternates.get(vehicle) ?? []).find(
            (other) => metersBetween(from, other) + 1 < metersBetween(from, vehicle),
          )
        : undefined;
    if (nearer) result = await evaluate(nearer);
    if (result.status === 'capped') {
      unread = candidateIndex;
      break;
    }
    if (result.status === 'budget') {
      hooks.onBudgetLimited?.();
      continue;
    }
    if (result.status !== 'routed') continue;
    for (const routes of result.alternatives) context.onWalkingAlternatives?.(routes);
    const { segments, cost, upperSeconds, floor } = result;
    // Proximity orders discovery only. Compare complete routed rentals before
    // choosing a device, retaining the first result if later calls do not fit.
    if (!best || cost < best.cost || (cost === best.cost && upperSeconds < best.upperSeconds))
      best = { segments, cost, upperSeconds, floor };
    comparedPickups.add(pointKey(vehicle));
    if (result.loop) loopingPickups++;
    if (comparedPickups.size - loopingPickups >= profile.pickupComparisons) {
      unread = candidateIndex + 1;
      break;
    }
  }
  // The search is cut short only when a device left unrouted could still have beaten the best
  // rental: when nothing was routed at all, or when its best case is under what that rental
  // costs. Devices behind the rider, or far past the destination, are not a limit; nor is a
  // device whose tabled walk loops, which the straight-line best case would wrongly count.
  const couldBeat = candidates
    .slice(unread)
    .filter(
      (vehicle) =>
        !seen.has(keyOf(vehicle)) &&
        !comparedPickups.has(pointKey(vehicle)) &&
        !hopeless(vehicle) &&
        !(best && looping.has(vehicle)),
    ).length;
  if (couldBeat) hooks.onCandidateLimited?.(couldBeat);
  return best?.segments ?? null;
}
