import type { Place } from '../../shared/domain/types.js';
import type {
  DocklessMode,
  DocklessRentalPermission,
  DocklessRentalPolicy,
} from '../scooter-bridge.js';
import { metersBetween } from '../realtime/names.js';
import { ASSUMPTIONS, VEHICLE_TYPES } from './assumptions.js';
import { inHourBand, kstHour } from './calendar.js';
import { bundledDemand } from './demand.js';
import {
  bundledParkingRules,
  metersApart,
  ParkingRules,
  Placement,
  PointGrid,
} from './parking-rules.js';
import { RETURN } from './return-rules.js';
import { LAYER, VEHICLE_TYPE_NAMES, type VehicleTypeName } from './sim-codes.js';
import {
  SIMULATION_LABELS,
  SIMULATION_PROVIDER,
  simulationProvenance,
  type SharedScooterSimulation,
} from './shared-scooter-sim.js';
import { MARKER_KIND } from './simulated-vehicle-feed.js';

const policy = ASSUMPTIONS.policy;
/** The longest a permission lasts; it ends earlier when the simulated day next moves the vehicle. */
const HOLD_MS = policy.holdMinutes * 60_000;
/** The rental each simulated type answers (§19). */
const MODE_OF = { 'kick-scooter': 'scooter', 'e-bike': 'ebike' } as const;
const TYPE_OF: Readonly<Record<DocklessMode, VehicleTypeName>> = {
  scooter: 'kick-scooter',
  ebike: 'e-bike',
};
/** A station's street entrance is looked for this far from its platform coordinate (가정값). */
const ENTRANCE_SEARCH_METERS = 250;
/** Door points looked at when no spot near the point itself is allowed (가정값, under the 500 m egress cap). */
const DOOR_SEARCH_METERS = 400;
/** The nearest door points whose legal spots are compared (가정값). */
const DOOR_CANDIDATES = 8;
const DOOR_CELL_METERS = 100;
/** A banned run this long is riding along the street, not crossing it (가정값). */
const CROSSING_METERS = 25;
/** A ridden path is checked against riding bans this often. */
const BAN_SAMPLE_METERS = 5;
/** Ids of the spots this policy names, so a spot handed back as a destination stays put. */
const RETURN_ID = 'return:';

type Point = { latitude: number; longitude: number };

/** One door-point grid per rule set, built on first use. */
const doorGrids = new WeakMap<ParkingRules, PointGrid>();

/** Up to DOOR_CANDIDATES door points within DOOR_SEARCH_METERS of a point, nearest first. */
function nearestDoors(rules: ParkingRules, latitude: number, longitude: number): number[] {
  let grid = doorGrids.get(rules);
  if (!grid) {
    grid = new PointGrid(rules.doors.points, DOOR_CELL_METERS);
    doorGrids.set(rules, grid);
  }
  const found: { door: number; meters: number }[] = [];
  const rings = Math.ceil(DOOR_SEARCH_METERS / grid.cellMeters);
  const row = grid.row(latitude),
    col = grid.col(longitude);
  for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
    for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
      const cell = r * grid.cols + c;
      for (let slot = grid.start[cell]; slot < grid.start[cell + 1]; slot++) {
        const door = grid.items[slot];
        const meters = metersApart(
          latitude,
          longitude,
          grid.points[door * 2],
          grid.points[door * 2 + 1],
        );
        if (meters <= DOOR_SEARCH_METERS) found.push({ door, meters });
      }
    }
  found.sort((a, b) => a.meters - b.meters || a.door - b.door);
  return found.slice(0, DOOR_CANDIDATES).map(({ door }) => door);
}

/**
 * §20.3 where a dockless ride of `type` ends near a point, the spot a compliant simulated rider
 * parks at: `legalReturnSpot`, the closest spot the rule table allows, a discouraged one only when
 * no allowed spot lies within its penalty (30 m). When nothing near the point is allowed (inside a
 * complex, a school or a building: R14, R22, R24), riders bound there arrive at its doors, so the
 * dropoff is the best legal spot by the nearest door points (`doorSpot`). The simulator's dock
 * fallback is kept only where the rules allow a return. Null when no allowed spot is in reach or
 * the spot is outside the service area (R01).
 */
export function legalDropoff(
  rules: ParkingRules,
  type: VehicleTypeName,
  point: Point,
  out = new Placement(),
): Point | null {
  const spot = rules.legalReturnSpot(type, point.latitude, point.longitude, out);
  if (spot && !spot.dockFallback) return { latitude: spot.latitude, longitude: spot.longitude };
  const fallback = spot ? { latitude: spot.latitude, longitude: spot.longitude } : null;
  const code = VEHICLE_TYPE_NAMES.indexOf(type);
  const { discouragedPenaltyMeters } = ASSUMPTIONS.returns;
  let best: Point | null = null,
    bestScore = Infinity;
  for (const door of nearestDoors(rules, point.latitude, point.longitude)) {
    rules.doorSpot(code, door, out);
    if (out.dockFallback || !rules.inServiceArea(out.latitude, out.longitude)) continue;
    const score =
      metersApart(point.latitude, point.longitude, out.latitude, out.longitude) +
      (out.discouraged ? discouragedPenaltyMeters : 0);
    if (score >= bestScore) continue;
    bestScore = score;
    best = { latitude: out.latitude, longitude: out.longitude };
  }
  if (best) return best;
  return fallback &&
    rules.returnEffect(code, fallback.latitude, fallback.longitude) !== RETURN.NO_RETURN
    ? fallback
    : null;
}

/**
 * False when a ridden path runs along a street where `type` may not be ridden (킥보드 없는 거리,
 * R28) for more than a crossing; crossing such a street is still allowed.
 */
export function rideAllowedOn(
  rules: ParkingRules,
  type: VehicleTypeName,
  path: readonly Point[],
): boolean {
  const code = VEHICLE_TYPE_NAMES.indexOf(type);
  let run = 0;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1],
      to = path[index];
    const meters = metersApart(from.latitude, from.longitude, to.latitude, to.longitude);
    const steps = Math.max(1, Math.ceil(meters / BAN_SAMPLE_METERS));
    for (let step = 1; step <= steps; step++) {
      const banned = rules.returns.ridingBanned(
        code,
        from.latitude + ((to.latitude - from.latitude) * step) / steps,
        from.longitude + ((to.longitude - from.longitude) * step) / steps,
      );
      run = banned ? run + meters / steps : 0;
      if (run > CROSSING_METERS) return false;
    }
  }
  return true;
}

/** The place a ride ends at: `near` itself when it is already legal, else a named spot by it. */
const returnPlace = (spot: Point | null, near: Place): Place | null =>
  !spot
    ? null
    : metersBetween(spot, near) < 0.5
      ? { ...near }
      : {
          id: `${RETURN_ID}${spot.latitude.toFixed(6)},${spot.longitude.toFixed(6)}`,
          name: near.id.startsWith(RETURN_ID) ? near.name : `${near.name} 근처`,
          address: '',
          latitude: spot.latitude,
          longitude: spot.longitude,
        };

/**
 * Answers the dockless bridge for simulator vehicles only; real operators' devices get null
 * (§15.5). A permission needs a ready window, a rentable and visible vehicle of the asked kind
 * whose charge covers the ride, and lasts until the vehicle's next state change on that spot: a
 * reservation or rental, a crew, a tow truck, a fault, a GPS loss, the low-battery threshold or
 * 04:00. Unlock and return seconds and the fictional demo tariff (§8, §19) are the vehicle type's.
 * The dropoff is the simulator's legal return spot for the rented type (§20.3), so a route ends a
 * ride where a compliant simulated rider parks; the rider walks the rest.
 */
export class SimulatedScooterPolicy implements DocklessRentalPolicy {
  private rules: ParkingRules | null;
  private readonly placement = new Placement();

  /** `rules` defaults to the simulator's own tables: parking geometry, docks, rules and doors. */
  constructor(
    private readonly simulation: SharedScooterSimulation,
    rules?: ParkingRules,
  ) {
    this.rules = rules ?? null;
  }

  /** The bridge refuses simulated permissions of any other model version (§11.1). */
  get modelVersion() {
    return this.simulation.modelVersion;
  }

  private parkingRules() {
    this.rules ??= new ParkingRules(bundledParkingRules(), bundledDemand());
    return this.rules;
  }

  /**
   * A street-level spot near `near` where a ride of `mode` may end or begin, by that kind's own
   * rules: kick-scooter-only rules (R21, R25, R26, R28) never move an e-bike's spot, and two kinds
   * share a transit query only where their spots coincide. Without `mode` the spot must suit both:
   * the kick-scooter's, whose rules are the stricter, kept only when an e-bike may end there too.
   * With `entrance`, `near` is a subway platform and the spot is by its nearest mapped street
   * entrance, else by the platform itself.
   */
  returnPoint(near: Place, entrance = false, mode?: DocklessMode): Place | null {
    const rules = this.parkingRules();
    const anchors: Point[] = [];
    if (entrance && rules.meta.subwayKind === 'exits') {
      const scan = rules.nearScan(near.latitude, near.longitude, ENTRANCE_SEARCH_METERS);
      const exit = scan.index[LAYER.EXIT];
      if (exit >= 0)
        anchors.push({
          latitude: rules.featureLatitude(LAYER.EXIT, exit),
          longitude: rules.featureLongitude(LAYER.EXIT, exit),
        });
    }
    anchors.push(near);
    const ebike = VEHICLE_TYPE_NAMES.indexOf('e-bike');
    for (const anchor of anchors) {
      const spot = legalDropoff(
        rules,
        mode ? TYPE_OF[mode] : 'kick-scooter',
        anchor,
        this.placement,
      );
      if (
        spot &&
        (mode || rules.returnEffect(ebike, spot.latitude, spot.longitude) !== RETURN.NO_RETURN)
      )
        return returnPlace(spot, near);
    }
    return null;
  }

  /** True unless the ride runs along a street this kind may not be ridden on (R28). */
  rideAllowed(path: readonly Point[], mode: DocklessMode): boolean {
    return rideAllowedOn(this.parkingRules(), TYPE_OF[mode], path);
  }

  /** The legal return spot nearest `destination` for this kind, or null when none exists. */
  private dropoff(destination: Place, mode: DocklessMode): Place | null {
    const rules = this.parkingRules(),
      type = TYPE_OF[mode];
    // A spot this policy named (a station continuation's) stays put while this kind may end there.
    if (
      destination.id.startsWith(RETURN_ID) &&
      rules.inServiceArea(destination.latitude, destination.longitude) &&
      rules.returnEffect(
        VEHICLE_TYPE_NAMES.indexOf(type),
        destination.latitude,
        destination.longitude,
      ) !== RETURN.NO_RETURN
    )
      return { ...destination };
    return returnPlace(legalDropoff(rules, type, destination, this.placement), destination);
  }

  async verify({
    vehicle,
    destination,
    now,
    mode = 'scooter',
  }: Parameters<DocklessRentalPolicy['verify']>[0]): Promise<DocklessRentalPermission | null> {
    if (vehicle.source !== 'gbfs' || vehicle.provider !== SIMULATION_PROVIDER) return null;
    const state = this.simulation.vehicle(vehicle.id, now);
    if (!state?.rentable) return null;
    // A scooter is never rented as an e-bike, nor shown as one.
    if (MODE_OF[state.type] !== mode) return null;
    if (vehicle.kind !== undefined && vehicle.kind !== MARKER_KIND[state.type]) return null;
    const dropoff = this.dropoff(destination, mode);
    if (!dropoff) return null;
    // The charge must cover the ride: straight line × detour with a margin.
    const ride = metersBetween(state, dropoff) * policy.rangeDetour * policy.rangeMargin;
    if (state.rangeMeters < ride) return null;
    const parkedUntil = this.simulation.parkedUntil(vehicle.id, now);
    if (parkedUntil === null) return null;
    const spec = VEHICLE_TYPES[VEHICLE_TYPE_NAMES.indexOf(state.type)];
    const { hireSeconds, returnSeconds } = spec.policy;
    const validUntil = Math.min(now + HOLD_MS, parkedUntil);
    if (validUntil - now < (hireSeconds + returnSeconds) * 1000) return null;
    const fares = spec.fares;
    return {
      vehicleId: vehicle.id,
      provider: SIMULATION_PROVIDER,
      dropoff,
      verifiedAt: now,
      validUntil,
      pickupAllowed: true,
      returnAllowed: true,
      eligibilityAllowed: true,
      hireSeconds,
      returnSeconds,
      unlockFeeWon: inHourBand(kstHour(now), fares.dayHours[0], fares.dayHours[1])
        ? fares.unlockDayWon
        : fares.unlockNightWon,
      perMinuteWon: fares.perMinuteWon,
      returnFeeWon: 0,
      provenance: simulationProvenance(
        now,
        this.simulation.modelVersion,
        SIMULATION_LABELS[state.type],
      ),
    };
  }
}
