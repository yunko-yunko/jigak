import {
  ASSUMPTIONS,
  VEHICLE_TYPES,
  type FaultTypeSpec,
  type VehicleTypeSpec,
} from './assumptions.js';
import {
  HOUR,
  MINUTE,
  dayTypeAt,
  inHourBand,
  isWinter,
  kstDateIndex,
  kstHour,
  midnightOfIndex,
} from './calendar.js';
import { PURPOSE, RIDER_STREAM, Stream } from './keyed-random.js';
import {
  COS_LATITUDE,
  METERS_PER_DEGREE,
  metersApart,
  offsetLatitude,
  offsetLongitude,
  Placement,
} from './parking-rules.js';
import {
  CATEGORY,
  CATEGORY_NAMES,
  ENDED_BY,
  EV,
  FAULT,
  FAULT_NAMES,
  FINE_KINDS,
  FLAG,
  LOST_REASONS,
  OP,
  RESOLUTION,
  RIDER,
  VTYPE,
  WANTED,
} from './sim-codes.js';
import type { Engine } from './sim-engine.js';
import { K } from './sim-kinds.js';

/** One rider looking for a vehicle (§5). Riders are transient; their draws are keyed. */
interface Rider {
  id: number;
  dock: number;
  hour: number;
  k: number;
  /** Hash of (RIDER, dock, hour, k), the base of per-vehicle choice draws. */
  key: number;
  type: number;
  lat: number;
  lon: number;
  destLat: number;
  destLon: number;
  /** The door point the rider heads for (§20.1), or -1 for a dock-jitter destination. */
  destDoor: number;
  loop: boolean;
  loopMeters: number;
  outOfArea: boolean;
  attempt: number;
  tried: number[];
  reserved: boolean;
  /** WANTED mask; 0 when only one type is on the street. */
  wanted: number;
}

/** One ride in progress, planned when the vehicle is unlocked (§5.6). */
interface Ride {
  version: number;
  rider: Rider;
  startAt: number;
  fromLat: number;
  fromLon: number;
  turnLat: number;
  turnLon: number;
  pathMeters: number;
  metersPerSecond: number;
  /** E-bike: metres to the assist cut-off and the pedalling speed after it (Infinity: none). */
  cutMeters: number;
  pedalMetersPerSecond: number;
  batteryStart: number;
  winter: number;
  endMeters: number;
  endedBy: number;
  faultType: number;
  faultReported: boolean;
  /** The rideable fault that showed itself on the way (display, or an e-bike's motor or battery). */
  displayFault: number;
  displayRevealed: boolean;
  displayReported: boolean;
  newLatent: number;
  accident: boolean;
  theft: boolean;
  forgot: boolean;
  forgotAt: number;
  payFail: number;
  payRecover: number;
  payDelay: number;
}

const ENDED = Object.fromEntries(ENDED_BY.map((name, index) => [name, index])) as Record<
  (typeof ENDED_BY)[number],
  number
>;
const LOST = Object.fromEntries(LOST_REASONS.map((name, index) => [name, index])) as Record<
  (typeof LOST_REASONS)[number],
  number
>;
const RES = Object.fromEntries(RESOLUTION.map((name, index) => [name, index])) as Record<
  (typeof RESOLUTION)[number],
  number
>;
const FINE = Object.fromEntries(FINE_KINDS.map((name, index) => [name, index])) as Record<
  (typeof FINE_KINDS)[number],
  number
>;

/**
 * Cumulative rider-type mix per (day type, hour): 24 tables of 4 back to back, each restarting
 * from zero, so a draw takes `weightedSegment` (exported for tests).
 */
export const MIX = (() => {
  const table = { weekday: new Float64Array(24 * 4), weekend: new Float64Array(24 * 4) };
  for (const day of ['weekday', 'weekend'] as const)
    for (let hour = 0; hour < 24; hour++) {
      const band = ASSUMPTIONS.riderMix[day].find(([first, last]) => inHourBand(hour, first, last));
      const shares = band ? band[2] : [0.25, 0.25, 0.25, 0.25];
      let total = 0;
      for (let type = 0; type < 4; type++) table[day][hour * 4 + type] = total += shares[type];
    }
  return table;
})();

/**
 * Fault specs per vehicle type, indexed by fault code. A code missing from a type's table (a
 * scooter fault on an e-bike from the start template) falls back to the scooter's spec.
 */
const FAULT_SPECS: readonly (readonly FaultTypeSpec[])[] = VEHICLE_TYPES.map((spec) =>
  FAULT_NAMES.map(
    (name) =>
      spec.faults.types.find((type) => type.code === name) ??
      VEHICLE_TYPES[VTYPE.SCOOTER].faults.types.find((type) => type.code === name) ??
      VEHICLE_TYPES[VTYPE.SCOOTER].faults.types[0],
  ),
);
/** Each type's hidden-fault table with its fault codes, in table order. */
const FAULT_CODES: readonly (readonly number[])[] = VEHICLE_TYPES.map((spec) =>
  spec.faults.types.map((type) => FAULT_NAMES.indexOf(type.code)),
);

/**
 * Riders (§5): Poisson arrivals at 따릉이 docks, the choice of a vehicle, unlocking, the ride with
 * its faults, police stops and battery, and where the vehicle is left (§6).
 */
/** Vehicles within this distance of a spot count as standing at it (§21). */
const PILE_METERS = 15;

/**
 * §22 how crowded a spot is for one more vehicle (0 = free): available vehicles within
 * `doors.coordinateMeters`, plus one when `doors.spotMeters5Cap` already stand within 5 m. One
 * scan of the rider grid; riders and crews pass it to `spreadSpot`. §22.9 also plus one when a
 * vehicle within 5 m already has the cap within its own 5 m (one more would pass it there); that
 * second look runs only when 10 m hold the cap.
 */
export function crowdOf(e: Engine): (latitude: number, longitude: number) => number {
  const { coordinateMeters, spotMeters5Cap } = ASSUMPTIONS.doors;
  let close = 0,
    within5 = 0,
    within10 = 0,
    crowded = false;
  const visit = (_vehicle: number, meters: number) => {
    within10++;
    if (meters > 5) return;
    within5++;
    if (meters <= coordinateMeters) close++;
  };
  const neighbour = (vehicle: number, meters: number) => {
    if (
      !crowded &&
      meters <= 5 &&
      e.countAvailableNear(e.lat[vehicle], e.lon[vehicle], 5, -1) >= spotMeters5Cap
    )
      crowded = true;
  };
  return (latitude, longitude) => {
    close = 0;
    within5 = 0;
    within10 = 0;
    e.forEachAvailableNear(latitude, longitude, 10, -1, visit);
    if (within5 >= spotMeters5Cap) return close + 1;
    crowded = false;
    if (within5 > 0 && within10 >= spotMeters5Cap)
      e.forEachAvailableNear(latitude, longitude, 5, -1, neighbour);
    return close + (crowded ? 1 : 0);
  };
}

/**
 * §22 does a spot already hold `doors.pileCap` available vehicles within 15 m? §22.9 or would one
 * more pass the cap within 15 m of a vehicle standing within 15 m of it, or of the 용산 zone point
 * within 15 m? The neighbour look runs only when 30 m hold the cap, so it costs nothing away
 * from piles.
 */
export function fullOf(e: Engine): (latitude: number, longitude: number) => boolean {
  const pileCap = ASSUMPTIONS.doors.pileCap;
  let full = false,
    within15 = 0,
    within30 = 0;
  const visit = (_vehicle: number, meters: number) => {
    within30++;
    if (meters <= PILE_METERS) within15++;
  };
  const neighbour = (vehicle: number, meters: number) => {
    if (
      !full &&
      meters <= PILE_METERS &&
      e.countAvailableNear(e.lat[vehicle], e.lon[vehicle], PILE_METERS, -1) >= pileCap
    )
      full = true;
  };
  const zone = [0, 0];
  return (latitude, longitude) => {
    within15 = 0;
    within30 = 0;
    e.forEachAvailableNear(latitude, longitude, 2 * PILE_METERS, -1, visit);
    if (within15 >= pileCap) return true;
    // A 용산 zone holds `pileCap` within 15 m of its own point, wherever in it a vehicle stands.
    if (
      within15 > 0 &&
      e.rules.spotPointNear(latitude, longitude, PILE_METERS, zone) &&
      e.countAvailableNear(zone[0], zone[1], PILE_METERS, -1) >= pileCap
    )
      return true;
    if (within30 < pileCap) return false;
    full = false;
    e.forEachAvailableNear(latitude, longitude, PILE_METERS, -1, neighbour);
    return full;
  };
}

/**
 * §22 a door's legal spot (`doorSpot`) for VTYPE `type`; when the rules moved it away from the
 * door (a designated spot, a gate, a dock) and that spot is full (`fullOf`), the next legal spot
 * from the door instead. Writes into `out`; true when every one in reach was full (the spot in
 * `out` is the first of them).
 */
export function doorSpotNotFull(
  e: Engine,
  type: number,
  door: number,
  out: Placement,
  full: (latitude: number, longitude: number) => boolean,
): boolean {
  e.rules.doorSpot(type, door, out);
  const latitude = e.rules.doorLatitude(door),
    longitude = e.rules.doorLongitude(door);
  if (
    metersApart(latitude, longitude, out.latitude, out.longitude) <= 1 ||
    !full(out.latitude, out.longitude)
  )
    return false;
  e.rules.legalSpot(type, latitude, longitude, out, full);
  return full(out.latitude, out.longitude);
}

export class Riders {
  /** Riders by id; a finished rider's slot is cleared so a multi-day window stays small. */
  private readonly riders: (Rider | undefined)[] = [];
  private readonly rides: (Ride | undefined)[];
  private readonly rideVersion: Int32Array;
  private readonly payments: number[] = [];
  private readonly candidates: number[] = [];
  private readonly candidateMeters: number[] = [];
  /** Walking metres plus the unwanted-type penalty: the order riders try vehicles in. */
  private readonly candidateScores: number[] = [];
  /** The grid cells a search reaches, nearest first, with their squared gaps. */
  private readonly seekCells: number[] = [];
  private readonly seekGaps: number[] = [];
  private readonly nearDocks: number[] = [];
  private readonly at = new Placement();
  /** Parking and photo draws run side by side, so each has its own stream. */
  private readonly parkingStream = new Stream();
  private readonly refusedStream = new Stream();
  private readonly overflowStream = new Stream();
  /** Destination docks' weights for one draw (§5.3). */
  private readonly nearWeights: number[] = [];
  private readonly crowd: (latitude: number, longitude: number) => number;
  private readonly full: (latitude: number, longitude: number) => boolean;
  /**
   * §22 `crowd` plus one when the spot's 15 m is full (`full`): a rider at a door, a dock spot or
   * a re-parked spot that already holds `doors.pileCap` moves along the kerb (`spreadSpot`
   * rings), so returns that end on one spot never stack past the cap.
   */
  private readonly crowdOrFull: (latitude: number, longitude: number) => number;
  /** §22 is a door's 15 m already full (`fullOf` at the door point)? */
  private readonly doorFull: (door: number) => boolean;
  /** §22 does a door hold `doors.cap` rentable vehicles, or is its 15 m full? */
  private doorTaken(door: number) {
    return this.e.doorLoad[door] >= ASSUMPTIONS.doors.cap || this.doorFull(door);
  }

  constructor(private readonly e: Engine) {
    this.rides = new Array(e.fleet);
    this.rideVersion = new Int32Array(e.fleet);
    this.crowd = crowdOf(e);
    this.full = fullOf(e);
    this.crowdOrFull = (latitude, longitude) =>
      this.crowd(latitude, longitude) + (this.full(latitude, longitude) ? 1 : 0);
    this.doorFull = (door) => this.full(e.rules.doorLatitude(door), e.rules.doorLongitude(door));
  }

  /**
   * Arrivals of one KST hour at every dock (§5.2): one Poisson draw of all types' riders per
   * dock-hour (§22 `dockRate`, foot traffic and 구 weights included).
   */
  generateHour(absoluteHour: number, time: number) {
    const e = this.e,
      demand = e.demand;
    const day = dayTypeAt(time),
      hour = kstHour(time);
    const season = e.season(time);
    for (let dock = 0; dock < demand.count; dock++) {
      const rate = e.dockRateAt(day, dock, hour) * season;
      if (rate <= 0) continue;
      const stream = e.keyed(PURPOSE.ARRIVALS, dock, absoluteHour);
      const count = stream.poisson(rate);
      for (let k = 0; k < count; k++) {
        const at = time + Math.floor(stream.next() * HOUR);
        const id = this.riders.length;
        this.riders.push({
          id,
          dock,
          hour: absoluteHour,
          k,
          key: e.key(PURPOSE.RIDER, dock, absoluteHour, k),
          type: 0,
          lat: 0,
          lon: 0,
          destLat: 0,
          destLon: 0,
          destDoor: -1,
          loop: false,
          loopMeters: 0,
          outOfArea: false,
          attempt: 0,
          tried: [],
          reserved: false,
          wanted: 0,
        });
        e.schedule(at, K.ARRIVAL, id);
      }
    }
  }

  private riderStream(rider: Rider, sub: number) {
    return this.e.keyed(PURPOSE.RIDER, rider.dock, rider.hour, rider.k, sub);
  }

  /**
   * A rider appears at a door near a dock and decides where to go (§5.1–5.3): the dock says
   * where and when, a door point in its reach says the spot (§20.1).
   */
  arrive(id: number, time: number) {
    const e = this.e,
      demand = e.demand,
      rider = this.riders[id]!;
    const stream = this.riderStream(rider, RIDER_STREAM.TRIP);
    const day = dayTypeAt(time),
      hour = kstHour(time);
    rider.type = stream.weightedSegment(MIX[day], hour * 4, hour * 4 + 4) - hour * 4;
    const type = ASSUMPTIONS.riderTypes[rider.type];
    this.doorOrJitter(rider.dock, ASSUMPTIONS.demand.riderJitterMeters, stream);
    rider.lat = this.at.latitude;
    rider.lon = this.at.longitude;

    rider.loop = stream.next() < demand.loopShare * type.loopFactor;
    const destination = rider.loop ? rider.dock : this.destination(rider, stream, day, hour);
    rider.loopMeters = rider.loop ? this.typeDistance(stream, rider.type) * 1000 : 0;
    // A few casual and late-night riders head out of the service area (§5.7).
    const outward = stream.next();
    const extraKm = stream.between(...ASSUMPTIONS.serviceArea.extraKm);
    let door = this.doorOrJitter(
      destination,
      ASSUMPTIONS.demand.destinationJitterMeters,
      stream,
      true,
    );
    if (!rider.loop && door >= 0) {
      // The two door draws are independent and can land side by side (§20.1): a destination door
      // much closer than the docks themselves is drawn again.
      const { minTripMeters, minTripShare, redraws } = ASSUMPTIONS.doors;
      const docks = demand.docks;
      const minMeters = Math.min(
        minTripMeters,
        minTripShare *
          e.meters(
            docks[rider.dock * 2],
            docks[rider.dock * 2 + 1],
            docks[destination * 2],
            docks[destination * 2 + 1],
          ),
      );
      for (
        let redraw = 0;
        redraw < redraws &&
        e.meters(rider.lat, rider.lon, this.at.latitude, this.at.longitude) < minMeters;
        redraw++
      )
        door = this.doorOrJitter(
          destination,
          ASSUMPTIONS.demand.destinationJitterMeters,
          stream,
          true,
        );
    }
    const jitteredLat = this.at.latitude,
      jitteredLon = this.at.longitude;
    rider.outOfArea = false;
    rider.destDoor = -1;
    if (
      (rider.type === RIDER.CASUAL || rider.type === RIDER.LATE_NIGHT) &&
      outward < ASSUMPTIONS.serviceArea.outOfAreaShare
    ) {
      const [centerLat, centerLon] = ASSUMPTIONS.serviceArea.center;
      const dy = (rider.lat - centerLat) * 111_195,
        dx = (rider.lon - centerLon) * 111_195 * Math.cos((37.55 * Math.PI) / 180);
      const norm = Math.hypot(dy, dx) || 1;
      const pointLat = rider.lat + offsetLatitude((dy / norm) * extraKm * 1000),
        pointLon = rider.lon + offsetLongitude((dx / norm) * extraKm * 1000);
      rider.loop = false;
      rider.loopMeters = 0;
      if (!e.rules.inServiceArea(pointLat, pointLon)) {
        rider.outOfArea = true;
        rider.destLat = pointLat;
        rider.destLon = pointLon;
      } else {
        e.rules.snap(pointLat, pointLon, stream, this.at);
        rider.destLat = this.at.latitude;
        rider.destLon = this.at.longitude;
      }
    } else {
      rider.destLat = jitteredLat;
      rider.destLon = jitteredLon;
      rider.destDoor = door;
    }
    if (e.mixed) rider.wanted = this.preference(rider, day, hour);
    this.seek(id, time, LOST['none-in-reach']);
  }

  /**
   * Which type the rider wants (§19): either, or one leaning by the types' arrival shares at the
   * dock and hour (§22 `ebikeShare`: 구 and foot weights differ by type), toward the e-bike for
   * students and longer trips. Drawn on its own stream, only in mixed runs.
   */
  private preference(rider: Rider, day: 'weekday' | 'weekend', hour: number) {
    const e = this.e,
      preference = ASSUMPTIONS.preference;
    const stream = this.riderStream(rider, RIDER_STREAM.PREFERENCE);
    const either = stream.next(),
      lean = stream.next();
    if (either < preference.eitherShare) return WANTED.EITHER;
    const km =
      (rider.loop
        ? rider.loopMeters
        : e.meters(rider.lat, rider.lon, rider.destLat, rider.destLon) * ASSUMPTIONS.ride.detour) /
      1000;
    // §22 riders who take either type mostly find an e-bike (the fleet's share of them), so the
    // others lean less, and the riders' split by type matches the dock's share (`ebikeShare`).
    const share =
      e.spatial.ebikeShare?.[day][rider.dock * 24 + hour] ?? e.arrivalShare[day][VTYPE.EBIKE];
    const eitherShare = preference.eitherShare,
      fleetShare = e.fleets.ebike / e.fleet;
    const ebike = Math.min(
      preference.leanClip[1],
      Math.max(
        preference.leanClip[0],
        (Math.max(0, share - eitherShare * fleetShare) / (1 - eitherShare)) *
          preference.ebikeLean[rider.type] *
          (km > preference.longTripKm ? preference.longTripLean : 1),
      ),
    );
    return lean < ebike ? WANTED.EBIKE : WANTED.SCOOTER;
  }

  /** Log-normal trip distance in km within the type's range (§5.1). */
  private typeDistance(stream: Stream, type: number) {
    const spec = ASSUMPTIONS.riderTypes[type];
    const km = spec.medianKm * Math.exp(ASSUMPTIONS.riderDistanceSigma * stream.normal());
    return Math.min(spec.rangeKm[1], Math.max(spec.rangeKm[0], km));
  }

  /** §5.3 destination dock: the pair table, else a typical distance toward returning docks. */
  private destination(
    rider: Rider,
    stream: Stream,
    day: 'weekday' | 'weekend',
    hour: number,
  ): number {
    const e = this.e,
      demand = e.demand;
    const origin = rider.dock;
    const type = ASSUMPTIONS.riderTypes[rider.type];
    const originLat = demand.docks[origin * 2],
      originLon = demand.docks[origin * 2 + 1];
    const from = demand.odStart[origin],
      to = demand.odStart[origin + 1];
    if (stream.next() < demand.odShare[origin] && to > from) {
      for (let attempt = 0; attempt <= ASSUMPTIONS.demand.maxDestinationRedraws; attempt++) {
        const target = demand.odTo[stream.weightedSegment(demand.odCumulative, from, to)];
        const km =
          e.meters(originLat, originLon, demand.docks[target * 2], demand.docks[target * 2 + 1]) /
          1000;
        if (km <= type.rangeKm[1]) return target;
      }
    }
    // §22 trip ends lean to the foot mass too (`returnWeight`), fading from the drawn point.
    const returns = e.spatial.returnWeight?.[day] ?? demand.ret[day];
    const { returnWeightFloor, returnDecayMeters } = ASSUMPTIONS.demand;
    const weights = this.nearWeights;
    for (let attempt = 0; attempt < 3; attempt++) {
      const meters = this.typeDistance(stream, rider.type) * 1000;
      const angle = stream.next() * 2 * Math.PI;
      const lat = originLat + offsetLatitude(meters * Math.sin(angle)),
        lon = originLon + offsetLongitude(meters * Math.cos(angle));
      const docks = e.rules.docksNear(
        lat,
        lon,
        ASSUMPTIONS.demand.destinationSearchMeters,
        this.nearDocks,
      );
      let total = 0;
      weights.length = 0;
      for (const dock of docks) {
        const weight =
          dock === origin
            ? 0
            : (returns[dock * 24 + hour] + returnWeightFloor) *
              Math.exp(
                -metersApart(lat, lon, demand.docks[dock * 2], demand.docks[dock * 2 + 1]) /
                  returnDecayMeters,
              );
        weights.push(weight);
        total += weight;
      }
      const draw = stream.next() * total;
      if (total <= 0) continue;
      let running = 0;
      for (let index = 0; index < docks.length; index++) {
        if (docks[index] === origin) continue;
        running += weights[index];
        if (draw < running) return docks[index];
      }
    }
    return to > from ? demand.odTo[from] : origin;
  }

  /**
   * Puts `at` on a door point near the dock (§20.1) and returns it; a dock with no door in reach
   * keeps the old jitter around the dock, snapped to land. Returns -1 then. A destination
   * (`capped`) skips doors that already hold `doors.cap` rentable vehicles (§21).
   */
  private doorOrJitter(dock: number, jitterMeters: number, stream: Stream, capped = false): number {
    const rules = this.e.rules,
      docks = this.e.demand.docks;
    let door = capped
      ? rules.doorNearCapped(dock, stream, this.e.doorLoad, this.doorFull)
      : rules.doorNear(dock, stream);
    // §22 every door of the dock is full: a door of the nearest docks around it with room, else a
    // point around the dock.
    if (capped && door >= 0 && this.doorTaken(door)) {
      door = -1;
      const near = rules.docksNear(
        docks[dock * 2],
        docks[dock * 2 + 1],
        ASSUMPTIONS.doors.dockMeters,
        this.nearDocks,
      );
      const meters = near.map((other) =>
        metersApart(docks[dock * 2], docks[dock * 2 + 1], docks[other * 2], docks[other * 2 + 1]),
      );
      const order = near
        .map((_, index) => index)
        .sort((left, right) => meters[left] - meters[right] || near[left] - near[right]);
      for (const index of order.slice(0, 4)) {
        if (near[index] === dock) continue;
        const other = rules.doorNearCapped(near[index], stream, this.e.doorLoad, this.doorFull);
        if (other >= 0 && !this.doorTaken(other)) {
          door = other;
          break;
        }
      }
    }
    if (door >= 0) {
      this.at.latitude = rules.doorLatitude(door);
      this.at.longitude = rules.doorLongitude(door);
      return door;
    }
    this.jitter(docks[dock * 2], docks[dock * 2 + 1], jitterMeters, stream);
    rules.snap(this.at.latitude, this.at.longitude, stream, this.at);
    return -1;
  }

  private jitter(latitude: number, longitude: number, meters: number, stream: Stream) {
    const radius = meters * Math.sqrt(stream.next()),
      angle = stream.next() * 2 * Math.PI;
    this.at.latitude = latitude + offsetLatitude(radius * Math.sin(angle));
    this.at.longitude = longitude + offsetLongitude(radius * Math.cos(angle));
  }

  private pathMeters(rider: Rider, vehicle: number) {
    const e = this.e;
    return rider.loop
      ? rider.loopMeters
      : Math.max(
          ASSUMPTIONS.ride.minPathMeters,
          e.meters(e.lat[vehicle], e.lon[vehicle], rider.destLat, rider.destLon) *
            ASSUMPTIONS.ride.detour,
        );
  }

  /**
   * §5.4 the rider looks for the nearest usable vehicle within 300 m and walks to it, reserving it
   * on longer walks. `reason` is the lost-demand reason if this is a retry and nothing is left.
   */
  private seek(id: number, time: number, reason: number) {
    const e = this.e,
      rider = this.riders[id]!,
      choice = ASSUMPTIONS.choice;
    const grid = e.riderGrid;
    const row = grid.row(rider.lat),
      col = grid.col(rider.lon);
    const candidates = this.candidates,
      candidateMeters = this.candidateMeters,
      scores = this.candidateScores;
    candidates.length = 0;
    candidateMeters.length = 0;
    scores.length = 0;
    // An unwanted type counts as a longer walk (§19); with one type on the street nobody minds.
    const penalty = ASSUMPTIONS.preference.unwantedPenaltyMeters;
    // Some riders walk further when nothing is within 300 m; the nearest usable one still wins.
    const limit =
      this.choiceDraw(rider, -1, 3) < choice.extendedShare
        ? choice.extendedPickupMeters
        : choice.pickupMeters;
    const rings = Math.ceil(limit / grid.cellMeters);
    // The cells in reach, nearest first. Squared planar gaps with a little slack skip only what
    // `e.meters` puts surely out of reach (§21.7).
    const reachSquared = (limit * 1.000001 + 0.01) ** 2,
      lonMeters = METERS_PER_DEGREE * COS_LATITUDE;
    const cells = this.seekCells,
      gaps = this.seekGaps;
    cells.length = 0;
    gaps.length = 0;
    for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
      for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
        const gap = grid.gapSquared(r, c, rider.lat, rider.lon);
        if (gap > reachSquared) continue;
        let at = cells.length;
        cells.push(0);
        gaps.push(0);
        for (; at > 0 && gaps[at - 1] > gap; at--) {
          cells[at] = cells[at - 1];
          gaps[at] = gaps[at - 1];
        }
        cells[at] = r * grid.cols + c;
        gaps[at] = gap;
      }
    let chosen = -1,
      distance = 0,
      noRange = false,
      scanned = 0,
      bound = cells.length ? Math.sqrt(gaps[0]) - 0.01 : Infinity;
    // Vehicles are tried in order of score, then vehicle id. The least untried candidate is next
    // once no cell left to scan can hold one that scores lower; a tried one scores Infinity.
    for (;;) {
      let index = -1;
      for (let next = 0; next < candidates.length; next++)
        if (
          scores[next] !== Infinity &&
          (index < 0 ||
            scores[next] < scores[index] ||
            (scores[next] === scores[index] && candidates[next] < candidates[index]))
        )
          index = next;
      if (index < 0 || scores[index] >= bound) {
        if (scanned === cells.length) break;
        for (const vehicle of grid.lists[cells[scanned]]) {
          if (e.op[vehicle] !== OP.AVAILABLE) continue;
          const dy = (e.lat[vehicle] - rider.lat) * METERS_PER_DEGREE,
            dx = (e.lon[vehicle] - rider.lon) * lonMeters;
          if (dy * dy + dx * dx > reachSquared || rider.tried.includes(vehicle)) continue;
          const meters = e.meters(rider.lat, rider.lon, e.lat[vehicle], e.lon[vehicle]);
          if (meters > limit) continue;
          // A hidden vehicle is found only by chance, inside its complex (§5.8).
          if (
            e.has(vehicle, FLAG.HIDDEN) &&
            this.choiceDraw(rider, vehicle, 0) >= choice.hiddenVisibleShare
          )
            continue;
          candidates.push(vehicle);
          candidateMeters.push(meters);
          scores.push(
            rider.wanted && !(rider.wanted & (1 << e.vType[vehicle])) ? meters + penalty : meters,
          );
        }
        scanned++;
        bound = scanned < cells.length ? Math.sqrt(gaps[scanned]) - 0.01 : Infinity;
        continue;
      }
      const vehicle = candidates[index];
      scores[index] = Infinity;
      const spec = e.spec(vehicle),
        battery = spec.battery;
      const winter = isWinter(time) ? battery.winterRideFactor : 1;
      const estimate =
        e.batteryNow(vehicle, time) +
        choice.batteryEstimateSigma * this.choiceNormal(rider, vehicle, 1);
      const reach =
        ((estimate - choice.estimateReservePercent) * battery.metersPerPercent) / winter;
      if (
        reach <
        this.pathMeters(rider, vehicle) * (1 + choice.rangeMargin) * spec.rangeCoverShare
      ) {
        noRange = true;
        continue;
      }
      if (
        e.has(vehicle, FLAG.FALLEN) &&
        this.choiceDraw(rider, vehicle, 2) < choice.fallenSkipShare
      )
        continue;
      chosen = vehicle;
      distance = candidateMeters[index];
      break;
    }
    if (chosen < 0) {
      this.lost(
        id,
        time,
        rider.attempt > 0 ? reason : noRange ? LOST['no-range'] : LOST['none-in-reach'],
      );
      return;
    }
    rider.tried.push(chosen);
    const attempt = this.attemptStream(rider);
    const reserveDraw = attempt.next(),
      abandonDraw = attempt.next(),
      abandonAt = attempt.next();
    const walk = Math.ceil((distance / choice.walkMetersPerSecond) * 1000);
    rider.reserved = distance > choice.reserveMinWalkMeters && reserveDraw < choice.reserveShare;
    if (rider.reserved) {
      e.holder[chosen] = id;
      e.setOp(chosen, OP.RESERVED, time);
      e.ops.vehicleChanged(chosen, time);
      e.record(chosen, time);
      e.log(
        time,
        EV.reserve,
        chosen,
        -1,
        e.lat[chosen],
        e.lon[chosen],
        0,
        rider.type,
        Math.round(distance),
      );
      if (abandonDraw < choice.abandonShare) {
        e.schedule(time + Math.floor(walk * abandonAt), K.ABANDON, id, chosen);
        return;
      }
    }
    e.schedule(time + walk, K.REACH, id, chosen);
  }

  private choiceDraw(rider: Rider, vehicle: number, slot: number) {
    const e = this.e;
    return e.spare.reseed(e.key(PURPOSE.CHOICE, rider.key, vehicle, slot)).next();
  }

  private choiceNormal(rider: Rider, vehicle: number, slot: number) {
    const e = this.e;
    return e.spare.reseed(e.key(PURPOSE.CHOICE, rider.key, vehicle, slot)).normal();
  }

  private attemptStream(rider: Rider) {
    return this.e.keyed(PURPOSE.ATTEMPT, rider.dock, rider.hour, rider.k * 4 + rider.attempt);
  }

  private lost(id: number, time: number, reason: number) {
    const rider = this.riders[id]!;
    this.e.log(
      time,
      EV['lost-demand'],
      -1,
      -1,
      rider.lat,
      rider.lon,
      0,
      reason,
      rider.type,
      rider.wanted,
    );
    this.riders[id] = undefined;
  }

  /** Ends a reservation without a rental (T2), keeping the vehicle where it is. */
  private release(vehicle: number, time: number, reason: number) {
    const e = this.e;
    if (e.op[vehicle] !== OP.RESERVED) return;
    e.holder[vehicle] = -1;
    e.commitBattery(vehicle, time);
    e.setOp(vehicle, e.opForBattery(e.battery[vehicle], e.vType[vehicle]), time);
    e.log(time, EV['reserve-ended'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, reason);
    e.ops.vehicleChanged(vehicle, time);
    e.record(vehicle, time);
  }

  abandon(id: number, vehicle: number, time: number) {
    const e = this.e;
    if (e.op[vehicle] === OP.RESERVED && e.holder[vehicle] === id) this.release(vehicle, time, 0);
    this.riders[id] = undefined;
  }

  /** Retry with the next vehicle or give up (§5.4–5.5). */
  private retry(id: number, time: number, reason: number) {
    const rider = this.riders[id]!;
    rider.attempt++;
    if (rider.attempt > ASSUMPTIONS.choice.maxRetries) {
      this.lost(id, time, reason);
      return;
    }
    this.seek(id, time, reason);
  }

  /** The rider reaches the vehicle: find it, check it, unlock it (§5.4–5.5, T3–T5). */
  reach(id: number, vehicle: number, time: number) {
    const e = this.e,
      rider = this.riders[id]!;
    rider.lat = e.lat[vehicle];
    rider.lon = e.lon[vehicle];
    const mine = rider.reserved
      ? e.op[vehicle] === OP.RESERVED && e.holder[vehicle] === id
      : e.op[vehicle] === OP.AVAILABLE;
    if (!mine) {
      // Someone else took it, or a crew or the tow truck did.
      this.retry(id, time, LOST['none-in-reach']);
      return;
    }
    const attempt = this.attemptStream(rider);
    // Fixed draw order keeps every rider's numbers aligned across windows.
    const notFound = attempt.next(),
      check = attempt.next(),
      report = attempt.next(),
      unlock = attempt.next(),
      retry = attempt.next();
    const choice = ASSUMPTIONS.choice;
    const retriesLeft = rider.attempt < choice.maxRetries;

    if (notFound < choice.notFoundShare) {
      e.log(
        time,
        EV['vehicle-not-found'],
        vehicle,
        -1,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        retriesLeft ? 0 : 1,
      );
      if (rider.reserved) this.release(vehicle, time, 1);
      this.retry(id, time, LOST['not-found']);
      return;
    }

    const latent = e.latent[vehicle];
    if (latent && latent !== FAULT.UNLOCK_IOT) {
      const spec = FAULT_SPECS[e.vType[vehicle]][latent];
      const boost = e.has(vehicle, FLAG.FAULT_REVEALED) ? ASSUMPTIONS.faults.revealedBoost : 0;
      const discovery = Math.min(ASSUMPTIONS.faults.maxDiscovery, spec.preRide + boost);
      if (check < discovery) {
        if (report < ASSUMPTIONS.faults.reportShare) {
          e.holder[vehicle] = -1;
          e.ops.markBroken(vehicle, latent, time, 0);
        } else if (rider.reserved) this.release(vehicle, time, 0);
        this.retry(id, time, LOST['none-in-reach']);
        return;
      }
    }

    const persistent = latent === FAULT.UNLOCK_IOT;
    if (persistent || unlock < ASSUMPTIONS.unlock.transientFailure) {
      const again = retriesLeft && retry < ASSUMPTIONS.unlock.retryShare;
      e.log(
        time,
        EV['unlock-failed'],
        vehicle,
        -1,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        rider.attempt,
        persistent ? 1 : 0,
        again ? 0 : 1,
      );
      if (rider.reserved) this.release(vehicle, time, 0);
      if (persistent) {
        e.unlockFails[vehicle]++;
        // The operator's server flags a vehicle that failed twice, whoever tried (T5).
        if (
          e.unlockFails[vehicle] >= ASSUMPTIONS.unlock.persistentFailuresToFlag &&
          e.op[vehicle] === OP.AVAILABLE
        )
          e.ops.markBroken(vehicle, FAULT.UNLOCK_IOT, time, 1);
      }
      if (again) {
        rider.attempt++;
        this.seek(id, time, LOST['unlock-gave-up']);
      } else this.lost(id, time, LOST['unlock-gave-up']);
      return;
    }
    this.rent(id, vehicle, time);
  }

  /** T3: the ride starts; its course, faults, stops and end are planned now (§5.6). */
  private rent(id: number, vehicle: number, time: number) {
    const e = this.e,
      rider = this.riders[id]!;
    e.holder[vehicle] = id;
    // The ride keeps the rider; the slot is not needed any more.
    this.riders[id] = undefined;
    e.leaveField(vehicle, time, RES.rented);
    e.commitBattery(vehicle, time);
    const batteryStart = e.battery[vehicle];
    e.setOp(vehicle, OP.IN_USE, time);
    // A rider found and unlocked it, so earlier crew misses no longer count (§9.5-8).
    e.taskFails[vehicle] = 0;
    e.ops.vehicleChanged(vehicle, time);
    e.record(vehicle, time);
    e.log(
      time,
      EV.rent,
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      rider.type,
      Math.round(batteryStart * 10),
    );
    this.plan(vehicle, rider, time, batteryStart);
  }

  private plan(vehicle: number, rider: Rider, time: number, batteryStart: number) {
    const e = this.e,
      spec = e.spec(vehicle),
      vType = e.vType[vehicle],
      faults = spec.faults;
    const fromLat = e.lat[vehicle],
      fromLon = e.lon[vehicle];
    const pathMeters = this.pathMeters(rider, vehicle);
    const speedStream = this.riderStream(rider, RIDER_STREAM.SPEED);
    const [slowest, fastest] = spec.cruiseKmh[rider.type];
    let cruise = Math.min(spec.maxKmh, speedStream.between(slowest, fastest));
    const bearing = speedStream.next() * 2 * Math.PI;
    if (batteryStart < spec.lowBatterySpeedPercent)
      cruise = Math.min(cruise, spec.lowBatteryCruiseKmh);
    const metersPerSecond = (cruise * ASSUMPTIONS.ride.effectiveSpeedFactor) / 3.6;
    const winter = isWinter(time) ? spec.battery.winterRideFactor : 1;
    const perPercent = spec.battery.metersPerPercent / winter;
    // A loop ride goes out to a turning point and comes back.
    const turnMeters = pathMeters / 2 / ASSUMPTIONS.ride.detour;
    const turnLat = fromLat + offsetLatitude(turnMeters * Math.sin(bearing)),
      turnLon = fromLon + offsetLongitude(turnMeters * Math.cos(bearing));

    const wear = e.keyed(PURPOSE.WEAR, vehicle, Math.floor(time / MINUTE));
    const creation = wear.exponential(1),
      revealKm = wear.exponential(faults.revealPerKm),
      newType = wear.next(),
      accidentDraw = wear.next(),
      accidentAt = wear.next(),
      theftDraw = wear.next(),
      reportDraw = wear.next(),
      displayDraw = wear.next();

    const pathKm = pathMeters / 1000;
    let latent = e.latent[vehicle],
      faultStartKm = 0,
      newLatent = 0;
    if (!latent) {
      // Hazard h(x) = base × (1 + (km0 + x) / scale): solve its integral for the creation point.
      const base = faults.hazardPerKm,
        km0 = e.km[vehicle];
      const a = base / (2 * faults.kmScale),
        b = base * (1 + km0 / faults.kmScale);
      const atKm = (-b + Math.sqrt(b * b + 4 * a * creation)) / (2 * a);
      if (atKm < pathKm) {
        const codes = FAULT_CODES[vType];
        let pick = newType,
          code = codes[0];
        for (let index = 0; index < faults.types.length; index++) {
          pick -= faults.types[index].share;
          if (pick < 0) {
            code = codes[index];
            break;
          }
        }
        latent = newLatent = code;
        faultStartKm = atKm;
      }
    }

    let endMeters = pathMeters,
      endedBy = ENDED.rider,
      faultType = 0,
      faultReported = false,
      displayFault = 0,
      displayRevealed = false,
      displayReported = false;
    const consider = (meters: number, by: number) => {
      if (meters < endMeters) {
        endMeters = Math.max(0, meters);
        endedBy = by;
        return true;
      }
      return false;
    };
    // Battery: a scooter's controller cuts power at the cut-off (T7). An e-bike's assist stops
    // there and the rider pedals on, slower, to the end (§19).
    const deathMeters = (batteryStart - spec.battery.cutoffPercent) * perPercent;
    let cutMeters = Infinity,
      batteryCutMeters = Infinity,
      pedalKmh = 0,
      pedalMetersPerSecond = metersPerSecond;
    if (spec.pedalKmh) {
      cutMeters = batteryCutMeters = Math.max(0, deathMeters);
      pedalKmh = Math.min(
        cruise,
        this.riderStream(rider, RIDER_STREAM.ASSIST).between(spec.pedalKmh[0], spec.pedalKmh[1]),
      );
      pedalMetersPerSecond = (pedalKmh * ASSUMPTIONS.ride.effectiveSpeedFactor) / 3.6;
    } else consider(deathMeters, ENDED.battery);
    // A hidden fault shows itself on the road (T8).
    if (latent && latent !== FAULT.UNLOCK_IOT) {
      const fault = FAULT_SPECS[vType][latent];
      const revealMeters = (faultStartKm + revealKm) * 1000;
      if (fault.midRide === 'stop') {
        if (consider(revealMeters, ENDED.fault)) {
          faultType = latent;
          faultReported = reportDraw < fault.midRideReport;
        }
      } else if (fault.midRide === 'continue' && revealMeters < pathMeters) {
        displayFault = latent;
        displayRevealed = true;
        displayReported = displayDraw < fault.midRideReport;
        // A dead hub motor, torque sensor or BMS ends an e-bike's assist where it shows: the
        // rider pedals on and the pack stops draining (§19).
        if (spec.pedalKmh && (latent === FAULT.MOTOR_SENSOR || latent === FAULT.BMS))
          cutMeters = Math.min(cutMeters, revealMeters);
      }
    }
    // Accidents (T9) end the ride where they happen.
    const accident = accidentDraw < faults.accidentPerRide;
    if (accident && consider(pathMeters * accidentAt, ENDED.accident)) {
      faultType = FAULT.FRAME;
      faultReported = true;
    }

    // Police stops (§5.9); unlicensed and drunk riding end the ride there.
    const conduct = this.riderStream(rider, RIDER_STREAM.CONDUCT);
    const police = ASSUMPTIONS.police;
    const hour = kstHour(time);
    const durationAt = (meters: number) =>
      time +
      Math.floor(
        (meters <= cutMeters
          ? meters / metersPerSecond
          : cutMeters / metersPerSecond + (meters - cutMeters) / pedalMetersPerSecond) * 1000,
      );
    const fines: [number, number][] = [];
    const caught = (share: number, catchProbability: number, kind: number) => {
      const violating = conduct.next(),
        catching = conduct.next(),
        where = conduct.next();
      if (violating < share && catching < catchProbability) fines.push([kind, pathMeters * where]);
    };
    // On an e-bike (a 자전거) helmets carry no fine, there is no licence to lack and a second
    // rider breaks only the operator's terms: the draws are taken, nobody is fined (§19).
    const helmet = ASSUMPTIONS.riderTypes[rider.type].helmet;
    caught(
      1 - helmet,
      spec.police.helmetFined &&
        inHourBand(hour, police.helmet.hours[0], police.helmet.hours[1] - 1)
        ? police.helmet.catch
        : 0,
      FINE.helmet,
    );
    caught(
      rider.type === RIDER.STUDENT
        ? police.twoRiders.student
        : rider.type === RIDER.LATE_NIGHT
          ? police.twoRiders.lateNight
          : police.twoRiders.other,
      spec.police.twoRidersFined ? police.twoRiders.catch : 0,
      FINE['two-riders'],
    );
    caught(
      rider.type === RIDER.STUDENT ? police.unlicensed.student : police.unlicensed.other,
      spec.police.unlicensedFined ? police.unlicensed.catch : 0,
      FINE.unlicensed,
    );
    const drunkNight = inHourBand(hour, police.drunk.nightHours[0], police.drunk.nightHours[1] - 1);
    const refusal = conduct.next();
    caught(
      rider.type === RIDER.LATE_NIGHT ? police.drunk.lateNight : police.drunk.other,
      police.drunk.catch * (drunkNight ? police.drunk.nightFactor : 1),
      refusal < police.drunkRefusalShare ? FINE['drunk-refusal'] : FINE.drunk,
    );
    caught(police.sidewalk.share, police.sidewalk.catch, FINE.sidewalk);
    caught(police.signal.share, police.signal.catch, FINE.signal);
    for (const [kind, meters] of fines)
      if (kind === FINE.unlicensed || kind === FINE.drunk || kind === FINE['drunk-refusal'])
        consider(meters, ENDED.police);

    const forget = conduct.next(),
      payFail = conduct.next(),
      payRecover = conduct.next(),
      payDelay = conduct.next(),
      theft = theftDraw < faults.theftPerRide;
    // Fines before the end are written now with their own instants; the log is sorted later.
    for (const [kind, meters] of fines) {
      if (meters > endMeters) continue;
      const point = this.alongPath(fromLat, fromLon, turnLat, turnLon, rider, pathMeters, meters);
      e.log(
        durationAt(meters),
        EV.fine,
        vehicle,
        -1,
        point[0],
        point[1],
        spec.fines[FINE_KINDS[kind]],
        kind,
      );
    }
    // Only the battery's cut-off is an `assist-cutoff`; a motor or BMS fault is logged as a fault.
    if (cutMeters < endMeters && cutMeters === batteryCutMeters) {
      const point = this.alongPath(
        fromLat,
        fromLon,
        turnLat,
        turnLon,
        rider,
        pathMeters,
        cutMeters,
      );
      e.log(
        durationAt(cutMeters),
        EV['assist-cutoff'],
        vehicle,
        -1,
        point[0],
        point[1],
        0,
        Math.round(cutMeters),
        Math.round(pedalKmh * 10),
        Math.round(spec.battery.cutoffPercent * 10),
      );
    }

    const version = ++this.rideVersion[vehicle];
    const ride: Ride = {
      version,
      rider,
      startAt: time,
      fromLat,
      fromLon,
      turnLat,
      turnLon,
      pathMeters,
      metersPerSecond,
      cutMeters,
      pedalMetersPerSecond,
      batteryStart,
      winter,
      endMeters,
      endedBy,
      faultType,
      faultReported,
      displayFault,
      displayRevealed,
      displayReported,
      newLatent,
      accident: accident && endedBy === ENDED.accident,
      theft: theft && endedBy === ENDED.rider,
      forgot: endedBy === ENDED.rider && forget < ASSUMPTIONS.ride.forgetShare,
      forgotAt: 0,
      payFail,
      payRecover,
      payDelay,
    };
    this.rides[vehicle] = ride;
    e.schedule(durationAt(endMeters), K.RIDE_END, vehicle, version);
  }

  /** The point `meters` along the ride: the straight line, or out and back for a loop. */
  private alongPath(
    fromLat: number,
    fromLon: number,
    turnLat: number,
    turnLon: number,
    rider: Rider,
    pathMeters: number,
    meters: number,
  ): [number, number] {
    const share = pathMeters > 0 ? Math.min(1, Math.max(0, meters / pathMeters)) : 1;
    if (!rider.loop)
      return [
        fromLat + (rider.destLat - fromLat) * share,
        fromLon + (rider.destLon - fromLon) * share,
      ];
    if (share < 0.5)
      return [fromLat + (turnLat - fromLat) * share * 2, fromLon + (turnLon - fromLon) * share * 2];
    const back = (share - 0.5) * 2;
    return [turnLat + (rider.destLat - turnLat) * back, turnLon + (rider.destLon - turnLon) * back];
  }

  /**
   * The ride ends (T6–T11): where the vehicle stands, what it costs, whether the operator's
   * photo check accepts the spot, and which state the vehicle is left in.
   */
  rideEnd(vehicle: number, version: number, time: number, auto: boolean) {
    const e = this.e,
      ride = this.rides[vehicle];
    if (!ride || ride.version !== version || e.op[vehicle] !== OP.IN_USE) return;
    const rider = ride.rider;
    if (ride.theft) {
      // Kept, never returned (T11): the operator only sees the ride never end.
      this.rides[vehicle] = undefined;
      e.holder[vehicle] = -1;
      e.km[vehicle] += ride.endMeters / 1000;
      e.setBattery(vehicle, this.batteryAfter(vehicle, ride), time);
      e.ops.goMissing(vehicle, time, 2);
      return;
    }
    if (ride.forgot && !auto) {
      // The rider walks away without ending; the operator ends it after two hours (§5.6).
      ride.forgotAt = time;
      e.schedule(time + ASSUMPTIONS.ride.autoEndMinutes * MINUTE, K.AUTO_END, vehicle, version);
      return;
    }
    this.rides[vehicle] = undefined;
    e.holder[vehicle] = -1;
    const money = ASSUMPTIONS.money,
      parkingRules = ASSUMPTIONS.parking;
    const early = ride.endedBy !== ENDED.rider;
    const end = this.alongPath(
      ride.fromLat,
      ride.fromLon,
      ride.turnLat,
      ride.turnLon,
      rider,
      ride.pathMeters,
      ride.endMeters,
    );
    const place = this.at;
    const spare = e.keyed(PURPOSE.RIDER, rider.dock, rider.hour, rider.k, RIDER_STREAM.SPARE);
    let endLat = end[0],
      endLon = end[1];
    // Outside the service area nothing is snapped (§5.7); inside, an early end lands on land.
    const outOfArea = rider.outOfArea ? !early || !e.rules.inServiceArea(endLat, endLon) : false;
    if (early && !outOfArea) {
      this.jitter(endLat, endLon, ASSUMPTIONS.ride.earlyEndJitterMeters, spare);
      e.rules.snap(place.latitude, place.longitude, spare, place);
      endLat = place.latitude;
      endLon = place.longitude;
    }
    const batteryAfter = Math.max(0, this.batteryAfter(vehicle, ride));
    e.km[vehicle] += ride.endMeters / 1000;
    if (ride.newLatent && !e.latent[vehicle]) e.latent[vehicle] = ride.newLatent;
    if (ride.accident) e.latent[vehicle] = FAULT.FRAME;

    const parking = this.parkingStream.reseed(
      e.key(PURPOSE.RIDER, rider.dock, rider.hour, rider.k, RIDER_STREAM.PARKING),
    );
    const refused = this.refusedStream.reseed(
      e.key(PURPOSE.RIDER, rider.dock, rider.hour, rider.k, RIDER_STREAM.REFUSED),
    );
    const type = ASSUMPTIONS.riderTypes[rider.type];
    let extraMinutes = 0,
      category: number = CATEGORY.PROPER,
      geometry = false,
      dockFallback = false,
      designated = false,
      discouraged = false,
      hidden = false,
      refusedOutcome = -1,
      refusedMeters = 0,
      photoOutcome = -1,
      photoCategory = 0,
      penalty = 0,
      // The door point whose spot the vehicle ends on, for `Engine.doorLoad` (-1 none).
      door = -1;
    if (outOfArea) {
      place.latitude = endLat;
      place.longitude = endLon;
    } else {
      const compliance = type.compliance * (early ? 0.5 : 1);
      const complianceDraw = parking.next(),
        designatedDraw = parking.next(),
        hideDraw = parking.next(),
        spreadMeters = parking.between(...ASSUMPTIONS.doors.spreadMeters),
        spreadAngle = parking.next() * 2 * Math.PI;
      const lateHour = kstHour(time);
      if (
        rider.type === RIDER.LATE_NIGHT &&
        !early &&
        !auto &&
        (ASSUMPTIONS.hiding.endHours as readonly number[]).includes(lateHour) &&
        hideDraw < ASSUMPTIONS.hiding.share
      ) {
        // Wheeled into an apartment complex or a building (§5.8).
        place.latitude = endLat;
        place.longitude = endLon;
        category = CATEGORY.PRIVATE;
        hidden = true;
      } else {
        let lat = endLat,
          lon = endLon,
          allowRestricted = true;
        for (let round = 0; round < 2; round++) {
          // §22 every legal spot in reach was full: the rider leaves the vehicle where the ride
          // ended, as a non-compliant rider would (용산구 tows outside its zones, F9/F10).
          let overflow = false;
          if (complianceDraw < compliance) {
            // §20.3 the closest spot the rule table allows for this type; a ride that reached its
            // door point reuses that door's spot.
            const atDoor =
              rider.destDoor >= 0 &&
              Math.abs(lat - rider.destLat) < 1e-9 &&
              Math.abs(lon - rider.destLon) < 1e-9;
            if (atDoor) {
              overflow = doorSpotNotFull(e, e.vType[vehicle], rider.destDoor, place, this.full);
              if (!overflow)
                e.rules.spreadSpot(
                  e.vType[vehicle],
                  spreadMeters,
                  spreadAngle,
                  e.doorLoad[rider.destDoor],
                  place,
                  this.crowdOrFull,
                );
            } else {
              e.rules.legalSpot(e.vType[vehicle], lat, lon, place);
              // §22 a spot already holding `doors.pileCap` sends the rider on to the next legal
              // spot (a designated spot, a gate, a dock), unless every one in reach is full.
              if (
                e.meters(lat, lon, place.latitude, place.longitude) > 1 &&
                this.full(place.latitude, place.longitude)
              ) {
                e.rules.legalSpot(e.vType[vehicle], lat, lon, place, this.full);
                overflow = this.full(place.latitude, place.longitude);
              }
              // A spot the rules moved the rider to (a gate, a designated spot) is shared by
              // everyone sent there, so it spreads by how many already stand at it (§21); so does
              // a spot where a vehicle already stands or whose 15 m is full (§22: a point snapped
              // onto a dock).
              if (
                !overflow &&
                (e.meters(lat, lon, place.latitude, place.longitude) > 1 ||
                  this.crowdOrFull(place.latitude, place.longitude) > 0)
              )
                e.rules.spreadSpot(
                  e.vType[vehicle],
                  spreadMeters,
                  spreadAngle,
                  e.countAvailableNear(place.latitude, place.longitude, PILE_METERS, -1),
                  place,
                  this.crowdOrFull,
                );
            }
            // §22.9 every legal spot in reach was full: the rider walks on along the kerb from
            // the first of them before giving up on the rules; so does one whose spread found no
            // free legal point (a narrow gate or zone spot).
            if (overflow) {
              e.rules.spreadSpot(
                e.vType[vehicle],
                spreadMeters,
                spreadAngle,
                e.countAvailableNear(place.latitude, place.longitude, PILE_METERS, -1),
                place,
                this.crowdOrFull,
              );
              overflow = this.crowdOrFull(place.latitude, place.longitude) > 0;
            } else overflow = this.crowdOrFull(place.latitude, place.longitude) > 0;
            door = atDoor && !overflow ? rider.destDoor : -1;
            category = CATEGORY.PROPER;
            dockFallback = place.dockFallback;
            discouraged = place.discouraged;
            designated =
              !dockFallback &&
              e.rules.nearTopDock(place.latitude, place.longitude) &&
              designatedDraw < parkingRules.designated.share;
          }
          if (complianceDraw >= compliance || overflow) {
            dockFallback = false;
            designated = false;
            e.rules.violation(
              lat,
              lon,
              overflow
                ? this.overflowStream.reseed(
                    e.key(PURPOSE.RIDER, rider.dock, rider.hour, rider.k, RIDER_STREAM.OVERFLOW),
                  )
                : parking,
              allowRestricted,
              place,
            );
            // §22.9 not on top of a pile either: on along the street to an uncrowded point.
            e.rules.clearOfPile(spreadAngle, place, this.crowdOrFull);
            door = -1;
            category = place.category;
            geometry = place.geometry;
            discouraged = false;
          }
          if (category !== CATEGORY.RESTRICTED) break;
          // §6.2-4 the app refuses a return inside a restricted area.
          const move = refused.next(),
            moveMeters = refused.between(...parkingRules.refused.moveMeters),
            moveAngle = refused.next() * 2 * Math.PI,
            moveMinutes = refused.between(...parkingRules.refused.extraMinutes);
          if (move < parkingRules.refused.moveShare && round === 0) {
            refusedOutcome = 0;
            refusedMeters = moveMeters;
            extraMinutes += Math.round(moveMinutes);
            const movedLat = place.latitude + offsetLatitude(moveMeters * Math.sin(moveAngle)),
              movedLon = place.longitude + offsetLongitude(moveMeters * Math.cos(moveAngle));
            e.rules.snap(movedLat, movedLon, refused, place);
            door = -1;
            lat = place.latitude;
            lon = place.longitude;
            allowRestricted = false;
            continue;
          }
          refusedOutcome = 1;
          penalty += money.refusedPenaltyWon;
          break;
        }
        // §6.4 the operator's end-of-ride photo check (normal and police ends only).
        const photoChecked =
          !auto &&
          (ride.endedBy === ENDED.rider || ride.endedBy === ENDED.police) &&
          category !== CATEGORY.RESTRICTED;
        if (photoChecked) {
          const rejectDraw = refused.next(),
            outcomeDraw = refused.next();
          const reject = parkingRules.photoReject[CATEGORY_NAMES[category]];
          if (rejectDraw < reject) {
            photoCategory = category;
            if (category === CATEGORY.PROPER) photoOutcome = 2;
            else if (outcomeDraw < parkingRules.photoReparkShare) {
              photoOutcome = 0;
              door = -1;
              extraMinutes += parkingRules.photoReparkExtraMinutes;
              e.rules.properSpotNear(
                place.latitude,
                place.longitude,
                parkingRules.photoReparkMeters,
                refused,
                place,
                0,
                e.vType[vehicle],
              );
              // §22 the re-parked spot is a legal one (often a dock's); a full one spreads too.
              if (this.crowdOrFull(place.latitude, place.longitude) > 0)
                e.rules.spreadSpot(
                  e.vType[vehicle],
                  spreadMeters,
                  spreadAngle,
                  e.countAvailableNear(place.latitude, place.longitude, PILE_METERS, -1),
                  place,
                  this.crowdOrFull,
                );
              category = CATEGORY.PROPER;
              geometry = false;
              dockFallback = place.dockFallback;
              discouraged = place.discouraged;
            } else {
              photoOutcome = 1;
              penalty += money.photoPenaltyWon;
            }
          }
        }
      }
    }

    // Fare (§5.6, §8): unlock + a price per started minute, capped for a forgotten ride. A
    // scooter pays 1,000 + 150; an e-bike 600 by day or 1,000 at night, + 160 (§19).
    const fares = e.spec(vehicle).fares;
    const minutes = Math.ceil((time - ride.startAt) / MINUTE) + extraMinutes;
    const unlockFee = inHourBand(kstHour(ride.startAt), fares.dayHours[0], fares.dayHours[1])
      ? fares.unlockDayWon
      : fares.unlockNightWon;
    let fare = unlockFee + fares.perMinuteWon * Math.max(1, minutes);
    if (designated) fare -= money.designatedDiscountWon;
    if (auto) fare = Math.min(money.autoEndCapWon, fare);
    const refundShare =
      ride.endedBy === ENDED.fault
        ? ASSUMPTIONS.ride.refundShare.fault
        : ride.endedBy === ENDED.accident
          ? ASSUMPTIONS.ride.refundShare.accident
          : ride.endedBy === ENDED.battery
            ? ASSUMPTIONS.ride.refundShare.battery
            : 0;
    const refund = Math.floor(fare * refundShare);

    // The new state.
    let op: number;
    let brokenType = 0;
    if (ride.faultType && ride.faultReported) {
      op = OP.BROKEN;
      brokenType = ride.faultType;
    } else if (ride.displayRevealed && ride.displayReported) {
      op = OP.BROKEN;
      brokenType = ride.displayFault;
    } else if (outOfArea) op = OP.OUT_OF_AREA;
    else op = e.opForBattery(batteryAfter, e.vType[vehicle]);
    if (ride.faultType && !ride.faultReported) e.setFlag(vehicle, FLAG.FAULT_REVEALED, true);
    if (ride.displayRevealed && !ride.displayReported)
      e.setFlag(vehicle, FLAG.FAULT_REVEALED, true);

    e.setBattery(vehicle, batteryAfter, time);
    e.placeAtDoor(vehicle, door, place.latitude, place.longitude);
    e.setOp(vehicle, op, time);
    if (op === OP.BROKEN) e.fault[vehicle] = brokenType;
    e.setFlag(vehicle, FLAG.RIDER_PLACED, true);
    e.setFlag(vehicle, FLAG.DESIGNATED, designated);
    e.setFlag(vehicle, FLAG.GEOMETRY, geometry);
    e.setFlag(vehicle, FLAG.DOCK_FALLBACK, dockFallback);
    e.setFlag(vehicle, FLAG.DISCOURAGED, discouraged && !outOfArea && !hidden);
    e.setFlag(vehicle, FLAG.HIDDEN, hidden);
    e.startSegment(vehicle, time, outOfArea ? CATEGORY.PROPER : category);
    e.unlockFails[vehicle] = 0;

    // §6.4 the operator's GPS sees roughly where it is; a hit near a tow zone sends a patrol.
    if (!outOfArea && !hidden) {
      const gps = e.keyed(PURPOSE.GPS, vehicle, e.segMinute[vehicle], e.segSeq[vehicle]);
      const sigma = parkingRules.gpsSigmaMeters;
      const reportedLat = place.latitude + offsetLatitude(sigma * gps.normal()),
        reportedLon = place.longitude + offsetLongitude(sigma * gps.normal());
      if (e.rules.geofenceHit(reportedLat, reportedLon) && gps.next() < parkingRules.gpsDetectShare)
        e.setFlag(vehicle, FLAG.OPERATOR_FLAGGED, true);
    }
    const immediateTow = e.enforcement.towTable(vehicle);
    if (photoOutcome === 1 && immediateTow[category])
      e.setFlag(vehicle, FLAG.OPERATOR_FLAGGED, true);
    e.record(vehicle, time);

    const lat = e.lat[vehicle],
      lon = e.lon[vehicle];
    const endedBy = auto ? ENDED.auto : ride.endedBy;
    e.log(
      time,
      EV['ride-end'],
      vehicle,
      -1,
      lat,
      lon,
      fare,
      Math.round((time - ride.startAt) / 1000),
      Math.round(ride.endMeters),
      Math.round(batteryAfter * 10),
      endedBy | (designated ? 16 : 0),
    );
    if (refund > 0)
      e.log(
        time,
        EV.refund,
        vehicle,
        -1,
        lat,
        lon,
        refund,
        ride.endedBy === ENDED.fault ? 0 : ride.endedBy === ENDED.accident ? 1 : 2,
        Math.round(refundShare * 100),
      );
    if (refusedOutcome >= 0)
      e.log(
        time,
        EV['ride-end-refused'],
        vehicle,
        -1,
        lat,
        lon,
        refusedOutcome === 1 ? money.refusedPenaltyWon : 0,
        refusedOutcome,
        Math.round(refusedMeters),
      );
    if (photoOutcome >= 0)
      e.log(
        time,
        EV['photo-rejected'],
        vehicle,
        -1,
        lat,
        lon,
        photoOutcome === 1 ? money.photoPenaltyWon : 0,
        photoCategory,
        photoOutcome,
      );
    if (!outOfArea && category !== CATEGORY.PROPER)
      e.log(
        time,
        EV['improper-parking'],
        vehicle,
        -1,
        lat,
        lon,
        0,
        category,
        immediateTow[category] ? 1 : 0,
        geometry ? 1 : 0,
      );
    if (outOfArea) e.log(time, EV['out-of-area'], vehicle, -1, lat, lon, money.outOfAreaFeeWon);
    if (ride.endedBy === ENDED.accident) e.log(time, EV.accident, vehicle, -1, lat, lon, 0, 1);
    if (op === OP.BROKEN)
      e.log(
        time,
        EV.fault,
        vehicle,
        -1,
        lat,
        lon,
        0,
        brokenType,
        ride.endedBy === ENDED.accident
          ? 7
          : brokenType === ride.displayFault && ride.displayReported
            ? 3
            : 2,
      );
    if (op === OP.BATTERY_DEAD || ride.endedBy === ENDED.battery)
      e.log(
        time,
        EV['battery-dead'],
        vehicle,
        -1,
        lat,
        lon,
        0,
        ride.endedBy === ENDED.battery ? 1 : 0,
      );

    // Payment (§5.6): a few fares fail to charge and most are recovered a day or more later.
    const charged = fare - refund;
    if (ride.payFail < ASSUMPTIONS.ride.paymentFailedShare && charged > 0) {
      e.log(time, EV['payment-failed'], vehicle, -1, lat, lon, charged);
      if (ride.payRecover < ASSUMPTIONS.ride.paymentRecoveredShare) {
        const [low, high] = ASSUMPTIONS.ride.paymentRecoveryHours;
        const hours = low + (high - low) * ride.payDelay;
        const index = this.payments.length;
        this.payments.push(charged, vehicle, lat, lon, Math.round(hours));
        e.schedule(time + Math.floor(hours * HOUR), K.PAYMENT_RECOVERED, index);
      }
    }

    if (hidden) {
      // Tomorrow morning the same rider usually takes it again; otherwise it is left out at 10:00.
      const hide = e.keyed(PURPOSE.HIDE, vehicle, e.segMinute[vehicle]);
      const again = hide.next(),
        when = hide.next();
      const hiding = ASSUMPTIONS.hiding;
      // 22:00–01:59 → the KST morning that follows.
      const morning = midnightOfIndex(kstDateIndex(time + 6 * HOUR));
      if (again < hiding.rerideShare) {
        const [from, to] = hiding.rerideWindowHours;
        e.schedule(
          morning + from * HOUR + Math.floor(when * (to - from) * HOUR),
          K.RERIDE,
          vehicle,
          e.segVersion[vehicle],
        );
      } else
        e.schedule(morning + hiding.releaseHour * HOUR, K.UNHIDE, vehicle, e.segVersion[vehicle]);
    }
    e.ops.vehicleChanged(vehicle, time);
  }

  /** Battery after the ride's metres; an e-bike stops drawing at its assist cut-off. */
  private batteryAfter(vehicle: number, ride: Ride) {
    const spec: VehicleTypeSpec = this.e.spec(vehicle);
    return (
      ride.batteryStart -
      (Math.min(ride.endMeters, ride.cutMeters) / spec.battery.metersPerPercent) * ride.winter
    );
  }

  paymentRecovered(index: number, time: number) {
    const [amount, vehicle, lat, lon, hours] = this.payments.slice(index, index + 5);
    this.e.log(time, EV['payment-recovered'], vehicle, -1, lat, lon, amount, hours);
  }

  /** §5.8 a hidden vehicle comes back out at 10:00. */
  unhide(vehicle: number, segment: number, time: number) {
    const e = this.e;
    if (e.segVersion[vehicle] !== segment || !e.has(vehicle, FLAG.HIDDEN)) return;
    e.setFlag(vehicle, FLAG.HIDDEN, false);
    e.record(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
  }

  /** §5.8 the late-night rider takes the hidden vehicle again next morning. */
  reride(vehicle: number, segment: number, time: number) {
    const e = this.e,
      demand = e.demand;
    if (
      e.segVersion[vehicle] !== segment ||
      !e.has(vehicle, FLAG.HIDDEN) ||
      e.op[vehicle] !== OP.AVAILABLE
    ) {
      if (e.segVersion[vehicle] === segment && e.has(vehicle, FLAG.HIDDEN))
        this.unhide(vehicle, segment, time);
      return;
    }
    const dock = e.rules.nearestDock(e.lat[vehicle], e.lon[vehicle], 5_000);
    if (dock < 0) {
      this.unhide(vehicle, segment, time);
      return;
    }
    const id = this.riders.length;
    const rider: Rider = {
      id,
      dock,
      hour: e.absoluteHour(time),
      k: 100_000 + vehicle,
      key: e.key(PURPOSE.RIDER, dock, e.absoluteHour(time), 100_000 + vehicle),
      type: RIDER.LATE_NIGHT,
      lat: e.lat[vehicle],
      lon: e.lon[vehicle],
      destLat: 0,
      destLon: 0,
      destDoor: -1,
      loop: false,
      loopMeters: 0,
      outOfArea: false,
      attempt: 0,
      tried: [vehicle],
      reserved: false,
      wanted: 0,
    };
    this.riders.push(rider);
    const stream = this.riderStream(rider, RIDER_STREAM.TRIP);
    const target = this.destination(rider, stream, dayTypeAt(time), kstHour(time));
    rider.destDoor = this.doorOrJitter(
      target,
      ASSUMPTIONS.demand.destinationJitterMeters,
      stream,
      true,
    );
    rider.destLat = this.at.latitude;
    rider.destLon = this.at.longitude;
    const spec = e.spec(vehicle),
      battery = spec.battery;
    const reach =
      (e.batteryNow(vehicle, time) * battery.metersPerPercent) /
      (isWinter(time) ? battery.winterRideFactor : 1);
    if (
      reach <
      this.pathMeters(rider, vehicle) * (1 + ASSUMPTIONS.choice.rangeMargin) * spec.rangeCoverShare
    ) {
      this.unhide(vehicle, segment, time);
      return;
    }
    e.setFlag(vehicle, FLAG.HIDDEN, false);
    this.rent(id, vehicle, time);
  }
}
