import { ASSUMPTIONS, VEHICLE_TYPES, type VehicleTypeSpec } from './assumptions.js';
import {
  DAY,
  HOUR,
  MINUTE,
  absoluteHour,
  dayTypeAt,
  isWinter,
  kstHour,
  monthAt,
  type DayType,
} from './calendar.js';
import type { Demand } from './demand.js';
import { Enforcement } from './enforcement.js';
import { hashText, keyOf, PURPOSE, Stream } from './keyed-random.js';
import { Operations } from './operations.js';
import {
  COS_LATITUDE,
  METERS_PER_DEGREE,
  metersApart,
  ParkingRules,
  Placement,
} from './parking-rules.js';
import { Riders } from './riders.js';
import { buildSpatialDemand, type SpatialDemand } from './spatial-demand.js';
import { CATEGORY, FIELD, FLAG, OP, STAGE, VISIBLE_FLAGS, VTYPE } from './sim-codes.js';

import { K, RANK } from './sim-kinds.js';

/** Growable typed columns. */
class F64 {
  data: Float64Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Float64Array(capacity);
  }
  push(value: number) {
    if (this.length === this.data.length) {
      const grown = new Float64Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }
}
class I32 {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  push(value: number) {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }
}
export { F64, I32 };

/** A binary heap on parallel typed arrays, ordered by (time, rank, sequence). */
class EventQueue {
  private time = new Float64Array(4096);
  private order = new Float64Array(4096);
  private kind = new Uint8Array(4096);
  private a = new Int32Array(4096);
  private b = new Int32Array(4096);
  private c = new Int32Array(4096);
  size = 0;
  private sequence = 0;

  // The popped entry.
  t = 0;
  k = 0;
  pa = 0;
  pb = 0;
  pc = 0;

  push(time: number, kind: number, a: number, b: number, c: number) {
    if (this.size === this.time.length) this.grow();
    const order = RANK[kind] * 1e12 + this.sequence++;
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.time[parent] < time || (this.time[parent] === time && this.order[parent] <= order))
        break;
      this.move(parent, index);
      index = parent;
    }
    this.time[index] = time;
    this.order[index] = order;
    this.kind[index] = kind;
    this.a[index] = a;
    this.b[index] = b;
    this.c[index] = c;
  }

  pop(): boolean {
    if (!this.size) return false;
    this.t = this.time[0];
    this.k = this.kind[0];
    this.pa = this.a[0];
    this.pb = this.b[0];
    this.pc = this.c[0];
    const last = --this.size;
    if (last > 0) {
      const time = this.time[last],
        order = this.order[last];
      let index = 0;
      for (;;) {
        let child = index * 2 + 1;
        if (child >= last) break;
        if (
          child + 1 < last &&
          (this.time[child + 1] < this.time[child] ||
            (this.time[child + 1] === this.time[child] &&
              this.order[child + 1] < this.order[child]))
        )
          child++;
        if (time < this.time[child] || (time === this.time[child] && order <= this.order[child]))
          break;
        this.move(child, index);
        index = child;
      }
      this.time[index] = time;
      this.order[index] = order;
      this.kind[index] = this.kind[last];
      this.a[index] = this.a[last];
      this.b[index] = this.b[last];
      this.c[index] = this.c[last];
    }
    return true;
  }

  peekTime() {
    return this.size ? this.time[0] : Infinity;
  }

  private move(from: number, to: number) {
    this.time[to] = this.time[from];
    this.order[to] = this.order[from];
    this.kind[to] = this.kind[from];
    this.a[to] = this.a[from];
    this.b[to] = this.b[from];
    this.c[to] = this.c[from];
  }

  private grow() {
    const grow = <T extends Float64Array | Uint8Array | Int32Array>(array: T): T => {
      const next = new (array.constructor as new (length: number) => T)(array.length * 2);
      next.set(array);
      return next;
    };
    this.time = grow(this.time);
    this.order = grow(this.order);
    this.kind = grow(this.kind);
    this.a = grow(this.a);
    this.b = grow(this.b);
    this.c = grow(this.c);
  }
}

/** Grid membership with O(1) insert and remove; one list of vehicle ids per cell. */
class VehicleGrid {
  readonly cellLatitude: number;
  readonly cellLongitude: number;
  readonly rows: number;
  readonly cols: number;
  readonly lists: number[][];
  private readonly cellOf: Int32Array;
  private readonly slotOf: Int32Array;

  constructor(
    fleet: number,
    readonly cellMeters: number,
  ) {
    this.cellLatitude = cellMeters / METERS_PER_DEGREE;
    this.cellLongitude = cellMeters / (METERS_PER_DEGREE * COS_LATITUDE);
    this.rows = Math.ceil((GRID_BOUNDS.north - GRID_BOUNDS.south) / this.cellLatitude);
    this.cols = Math.ceil((GRID_BOUNDS.east - GRID_BOUNDS.west) / this.cellLongitude);
    this.lists = Array.from({ length: this.rows * this.cols }, () => []);
    this.cellOf = new Int32Array(fleet).fill(-1);
    this.slotOf = new Int32Array(fleet).fill(-1);
  }

  row(latitude: number) {
    return Math.floor((latitude - GRID_BOUNDS.south) / this.cellLatitude);
  }

  col(longitude: number) {
    return Math.floor((longitude - GRID_BOUNDS.west) / this.cellLongitude);
  }

  cell(latitude: number, longitude: number) {
    const row = this.row(latitude),
      col = this.col(longitude);
    return row < 0 || col < 0 || row >= this.rows || col >= this.cols ? -1 : row * this.cols + col;
  }

  /** Squared planar metres from the point to cell (row, col); 0 inside it. */
  gapSquared(row: number, col: number, latitude: number, longitude: number) {
    const north = (latitude - GRID_BOUNDS.south) * METERS_PER_DEGREE,
      east = (longitude - GRID_BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE,
      size = this.cellMeters;
    const rowGap = Math.max(0, row * size - north, north - (row + 1) * size),
      colGap = Math.max(0, col * size - east, east - (col + 1) * size);
    return rowGap * rowGap + colGap * colGap;
  }

  has(vehicle: number) {
    return this.cellOf[vehicle] >= 0;
  }

  set(vehicle: number, latitude: number, longitude: number) {
    const cell = this.cell(latitude, longitude);
    if (cell === this.cellOf[vehicle]) return;
    this.remove(vehicle);
    if (cell < 0) return;
    const list = this.lists[cell];
    this.cellOf[vehicle] = cell;
    this.slotOf[vehicle] = list.length;
    list.push(vehicle);
  }

  remove(vehicle: number) {
    const cell = this.cellOf[vehicle];
    if (cell < 0) return;
    const list = this.lists[cell];
    const slot = this.slotOf[vehicle];
    const last = list.pop()!;
    if (last !== vehicle) {
      list[slot] = last;
      this.slotOf[last] = slot;
    }
    this.cellOf[vehicle] = -1;
    this.slotOf[vehicle] = -1;
  }
}

export const GRID_BOUNDS = { south: 37.4, north: 37.72, west: 126.74, east: 127.22 } as const;

/**
 * Cell size of the rider grid in metres. A tuning constant, not a model number: searches cover
 * `ceil(radius / cell)` rings, so a smaller cell scans less area at the real fleet's density and
 * every result stays the same (§21.7).
 */
export const RIDER_GRID_METERS = 150;

/**
 * Where the window serving the day starting at `startsAt` begins (§11.2): the latest anchor
 * (04:00 KST every `anchorDays` days since the epoch) at least `warmupHours` earlier. Windows of
 * consecutive days that share an anchor simulate the same history.
 */
export function windowStart(startsAt: number): number {
  const clock = ASSUMPTIONS.clock;
  const latest = startsAt - clock.warmupHours * HOUR;
  const day = Math.floor((latest + 9 * HOUR - clock.serviceDayStartHour * HOUR) / DAY);
  const anchor = day - (((day % clock.anchorDays) + clock.anchorDays) % clock.anchorDays);
  return anchor * DAY - 9 * HOUR + clock.serviceDayStartHour * HOUR;
}

/** Vehicles per type; scooters take indices [0, scooter), e-bikes the rest. */
export interface Fleets {
  scooter: number;
  ebike: number;
}

/** The fleets of a request: `fleets` when given (it must add up to `fleet`), else all scooters. */
export function fleetsOf(input: { fleet: number; fleets?: Fleets }): Fleets {
  const fleets = input.fleets ?? { scooter: input.fleet, ebike: 0 };
  if (fleets.scooter + fleets.ebike !== input.fleet)
    throw new RangeError(
      `Fleets ${fleets.scooter}+${fleets.ebike} do not add up to ${input.fleet}`,
    );
  return fleets;
}

/**
 * The text a run's keyed streams hash from. A scooter-only run keeps its old `seed|fleet`, so it
 * reproduces every draw it made before e-bikes existed.
 */
export function seedTextOf(seed: string, fleets: Fleets): string {
  return fleets.ebike > 0
    ? `${seed}|${fleets.scooter}|${fleets.ebike}`
    : `${seed}|${fleets.scooter}`;
}

export interface WindowInput {
  demand: Demand;
  rules: ParkingRules;
  seed: string;
  /** Total vehicles, scooters and e-bikes. */
  fleet: number;
  fleets?: Fleets;
  /** The served service day: [startsAt, endsAt). */
  startsAt: number;
  endsAt: number;
  date: string;
  /**
   * Diagnostics and tests only: start the template at this 04:00 instead of the anchor, for long
   * continuous runs. Served windows always use `windowStart`.
   */
  warmupFrom?: number;
  /**
   * Tests and what-if runs: tow e-bikes under the pending 2027 ordinance (§19). Default: the
   * assumption's flag (off).
   */
  ordinance2027?: boolean;
}

/**
 * One window of the discrete-event simulation (§11.2): 72–120 hours from its anchor (the warm-up
 * start) to the end of the served service day. State lives in typed arrays indexed by vehicle; changes are
 * recorded as intervals and events, and the window keeps those from the service-day start.
 */
export class Engine {
  readonly fleet: number;
  readonly fleets: Fleets;
  /** Both types on the street, so riders choose between them. */
  readonly mixed: boolean;
  /** Seoul tows e-bikes too (the pending 2027 ordinance, §19). */
  readonly ordinance2027: boolean;
  readonly seedHash: number;
  readonly demand: Demand;
  readonly rules: ParkingRules;
  readonly warmupFrom: number;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly date: string;

  readonly queue = new EventQueue();
  readonly stream = new Stream();
  readonly park = new Stream();
  readonly spare = new Stream();
  readonly place = new Placement();
  now = 0;
  /** Queue entries processed, for diagnostics. */
  queueEvents = 0;

  // Vehicle state (§3).
  /** Vehicle type (VTYPE), fixed per index. */
  readonly vType: Uint8Array;
  readonly op: Uint8Array;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly battery: Float64Array;
  readonly batteryAt: Float64Array;
  readonly km: Float64Array;
  readonly latent: Uint8Array;
  readonly fault: Uint8Array;
  readonly flags: Uint16Array;
  readonly category: Uint8Array;
  readonly stage: Uint8Array;
  readonly firstComplaintAt: Float64Array;
  readonly complaints: Uint16Array;
  readonly towJob: Int32Array;
  readonly towReadyAt: Float64Array;
  readonly graceUntil: Float64Array;
  readonly segMinute: Int32Array;
  readonly segSeq: Int32Array;
  readonly segVersion: Int32Array;
  readonly segStartAt: Float64Array;
  readonly segDock: Int32Array;
  readonly hazardVersion: Int32Array;
  readonly parkState: Int32Array;
  readonly version: Int32Array;
  readonly unlockFails: Uint8Array;
  readonly taskFails: Uint8Array;
  readonly taskRetryAt: Float64Array;
  readonly unit: Uint16Array;
  readonly home: Uint8Array;
  readonly lot: Uint8Array;
  readonly impoundedAt: Float64Array;
  readonly towedCategory: Uint8Array;
  readonly holder: Int32Array;
  readonly missingKind: Uint8Array;

  /** Riders can take vehicles here (available, hidden included); `RIDER_GRID_METERS` cells. */
  readonly riderGrid: VehicleGrid;
  /** Rentable vehicles set down at each door point (door-points index), for placement caps. */
  readonly doorLoad: Int32Array;
  /** The door point each vehicle was last set down at (-1 none). */
  readonly doorOfVehicle: Int32Array;
  /** The door each vehicle counts in `doorLoad` (-1 none). */
  private readonly doorCounted: Int32Array;
  /** Rentable and visible vehicles per 500 m cell, for rebalancing (§9.5-7). */
  readonly cellGrid: VehicleGrid;
  readonly cellAvailable: Int32Array;
  /** `cellAvailable` split by vehicle type. */
  readonly cellAvailableOf: readonly Int32Array[];
  private readonly cellOfVehicle: Int32Array;

  // Interval log: one row per visible change.
  readonly iT = new F64(1 << 16);
  readonly iVehicle = new I32(1 << 16);
  readonly iOp = new I32(1 << 16);
  readonly iLat = new F64(1 << 16);
  readonly iLon = new F64(1 << 16);
  readonly iBattery = new F64(1 << 16);
  readonly iMeta = new I32(1 << 16);
  private readonly lastInterval: Int32Array;

  // Event log (§14).
  readonly eT = new F64(1 << 16);
  readonly eType = new I32(1 << 16);
  readonly eVehicle = new I32(1 << 16);
  readonly eCrew = new I32(1 << 16);
  readonly eLat = new F64(1 << 16);
  readonly eLon = new F64(1 << 16);
  readonly eAmount = new I32(1 << 16);
  readonly eD0 = new I32(1 << 16);
  readonly eD1 = new I32(1 << 16);
  readonly eD2 = new I32(1 << 16);
  readonly eD3 = new I32(1 << 16);

  readonly riders: Riders;
  readonly enforcement: Enforcement;
  readonly ops: Operations;

  /** The window's demand map (§5.2); the four fields below are its shorthands. */
  readonly spatial: SpatialDemand;
  /** Arrivals per vehicle scale, per day type (§5.2): the sum over vehicle types. */
  readonly scale: Record<DayType, number>;
  /** Each type's share of the arrivals per day type, [scooter, e-bike]. */
  readonly arrivalShare: Record<DayType, readonly number[]>;
  /** Expected rentals per 500 m cell and hour (season applied when read). */
  readonly cellDemand: Record<DayType, Float32Array>;
  /** The busiest dock of each 500 m cell, where crews drop vehicles (-1 none). */
  readonly cellDock: Int32Array;

  constructor(input: WindowInput) {
    const fleets = fleetsOf(input);
    const fleet = fleets.scooter + fleets.ebike;
    this.fleet = fleet;
    this.fleets = fleets;
    this.mixed = fleets.scooter > 0 && fleets.ebike > 0;
    this.ordinance2027 = input.ordinance2027 ?? ASSUMPTIONS.ebike.towing.ordinance2027.enabled;
    this.seedHash = hashText(seedTextOf(input.seed, fleets));
    this.demand = input.demand;
    this.rules = input.rules;
    this.startsAt = input.startsAt;
    this.endsAt = input.endsAt;
    this.date = input.date;
    this.warmupFrom = input.warmupFrom ?? windowStart(input.startsAt);

    this.vType = new Uint8Array(fleet).fill(VTYPE.EBIKE, fleets.scooter);
    this.op = new Uint8Array(fleet);
    this.lat = new Float64Array(fleet);
    this.lon = new Float64Array(fleet);
    this.battery = new Float64Array(fleet);
    this.batteryAt = new Float64Array(fleet);
    this.km = new Float64Array(fleet);
    this.latent = new Uint8Array(fleet);
    this.fault = new Uint8Array(fleet);
    this.flags = new Uint16Array(fleet);
    this.category = new Uint8Array(fleet).fill(CATEGORY.NONE);
    this.stage = new Uint8Array(fleet);
    this.firstComplaintAt = new Float64Array(fleet);
    this.complaints = new Uint16Array(fleet);
    this.towJob = new Int32Array(fleet).fill(-1);
    this.towReadyAt = new Float64Array(fleet);
    this.graceUntil = new Float64Array(fleet);
    this.segMinute = new Int32Array(fleet).fill(-1);
    this.segSeq = new Int32Array(fleet);
    this.segVersion = new Int32Array(fleet);
    this.segStartAt = new Float64Array(fleet);
    this.segDock = new Int32Array(fleet).fill(-1);
    this.hazardVersion = new Int32Array(fleet);
    this.parkState = new Int32Array(fleet);
    this.version = new Int32Array(fleet);
    this.unlockFails = new Uint8Array(fleet);
    this.taskFails = new Uint8Array(fleet);
    this.taskRetryAt = new Float64Array(fleet);
    this.unit = new Uint16Array(fleet);
    this.home = new Uint8Array(fleet);
    this.lot = new Uint8Array(fleet);
    this.impoundedAt = new Float64Array(fleet);
    this.towedCategory = new Uint8Array(fleet).fill(CATEGORY.NONE);
    this.holder = new Int32Array(fleet).fill(-1);
    this.missingKind = new Uint8Array(fleet);
    this.lastInterval = new Int32Array(fleet).fill(-1);

    this.riderGrid = new VehicleGrid(fleet, RIDER_GRID_METERS);
    this.doorLoad = new Int32Array(this.rules.doors.meta.points);
    this.doorOfVehicle = new Int32Array(fleet).fill(-1);
    this.doorCounted = new Int32Array(fleet).fill(-1);
    this.cellGrid = new VehicleGrid(fleet, ASSUMPTIONS.dispatch.gridMeters);
    this.cellAvailable = new Int32Array(this.cellGrid.rows * this.cellGrid.cols);
    this.cellAvailableOf = VEHICLE_TYPES.map(() => new Int32Array(this.cellAvailable.length));
    this.cellOfVehicle = new Int32Array(fleet).fill(-1);

    const spatial = buildSpatialDemand(this.demand, fleets, {
      cells: this.cellGrid.rows * this.cellGrid.cols,
      cell: (lat, lon) => this.cellGrid.cell(lat, lon),
    });
    this.spatial = spatial;
    this.scale = spatial.scale;
    this.arrivalShare = spatial.arrivalShare;
    this.cellDemand = spatial.cellDemand;
    this.cellDock = spatial.cellDock;

    this.riders = new Riders(this);
    this.enforcement = new Enforcement(this);
    this.ops = new Operations(this);
  }

  // ---- Keys, time and geometry helpers ----

  /** Seeds the shared stream for a key tuple and returns it. */
  keyed(purpose: number, a = 0, b = 0, c = 0, d = 0): Stream {
    return this.stream.reseed(keyOf(this.seedHash, purpose, a, b, c, d));
  }

  key(purpose: number, a = 0, b = 0, c = 0, d = 0): number {
    return keyOf(this.seedHash, purpose, a, b, c, d);
  }

  season(time: number) {
    return ASSUMPTIONS.demand.seasonByMonth[monthAt(time) - 1];
  }

  /** Riders per hour at a dock before season, all vehicle types together (§5.2). */
  dockRateAt(day: DayType, dock: number, hour: number): number {
    const rates = this.spatial.dockRate;
    if (!rates) return this.demand.rent[day][dock * 24 + hour] * this.scale[day];
    let sum = 0;
    for (const rate of rates) sum += rate[day][dock * 24 + hour];
    return sum;
  }

  /** Expected rentals in a 500 m cell over [from, from + hours). */
  expectedRentals(cell: number, from: number, hours: number): number {
    const own = this.spatial.cellDemandOf;
    if (own) {
      let sum = 0;
      for (let offset = 0; offset < hours; offset++) {
        const time = from + offset * HOUR;
        const day = dayTypeAt(time),
          slot = cell * 24 + kstHour(time);
        let rate = 0;
        for (const type of own) rate += type[day][slot];
        sum += rate * this.season(time);
      }
      return sum;
    }
    let total = 0;
    for (let offset = 0; offset < hours; offset++) {
      const time = from + offset * HOUR;
      total += this.cellDemand[dayTypeAt(time)][cell * 24 + kstHour(time)] * this.season(time);
    }
    return total;
  }

  /** `expectedRentals` for one vehicle type, by its share of the arrivals (가정값: same map). */
  expectedRentalsOf(type: number, cell: number, from: number, hours: number): number {
    const own = this.spatial.cellDemandOf?.[type];
    if (own) {
      let sum = 0;
      for (let offset = 0; offset < hours; offset++) {
        const time = from + offset * HOUR;
        sum += own[dayTypeAt(time)][cell * 24 + kstHour(time)] * this.season(time);
      }
      return sum;
    }
    let total = 0;
    for (let offset = 0; offset < hours; offset++) {
      const time = from + offset * HOUR;
      const day = dayTypeAt(time);
      total +=
        this.cellDemand[day][cell * 24 + kstHour(time)] *
        this.season(time) *
        this.arrivalShare[day][type];
    }
    return total;
  }

  /** The numbers of the vehicle's type. */
  spec(vehicle: number): VehicleTypeSpec {
    return VEHICLE_TYPES[this.vType[vehicle]];
  }

  /** Idle drain per millisecond in this season (§3.7), for a vehicle type (default scooter). */
  idleDrain(time: number, type: number = VTYPE.SCOOTER) {
    const battery = VEHICLE_TYPES[type].battery;
    return (battery.idlePercentPerDay * (isWinter(time) ? battery.winterIdleFactor : 1)) / DAY;
  }

  /** Battery at `time`; field and missing vehicles drain while parked. */
  batteryNow(vehicle: number, time: number): number {
    const op = this.op[vehicle];
    const base = this.battery[vehicle];
    if (!(FIELD[op] || op === OP.MISSING) || time <= this.batteryAt[vehicle]) return base;
    return Math.max(
      0,
      base -
        this.idleDrain(this.batteryAt[vehicle], this.vType[vehicle]) *
          (time - this.batteryAt[vehicle]),
    );
  }

  /** Fixes the drained battery at `time` so a state change starts from it. */
  commitBattery(vehicle: number, time: number) {
    this.battery[vehicle] = this.batteryNow(vehicle, time);
    this.batteryAt[vehicle] = time;
  }

  setBattery(vehicle: number, percent: number, time: number) {
    this.battery[vehicle] = Math.max(0, Math.min(100, percent));
    this.batteryAt[vehicle] = time;
  }

  /** The operating state a field vehicle's battery gives it (§3.2), per type (default scooter). */
  opForBattery(percent: number, type: number = VTYPE.SCOOTER) {
    const battery = VEHICLE_TYPES[type].battery;
    return percent >= battery.lowPercent
      ? OP.AVAILABLE
      : percent > battery.deadPercent
        ? OP.LOW_BATTERY
        : OP.BATTERY_DEAD;
  }

  rangeMeters(vehicle: number, time: number) {
    const battery = this.spec(vehicle).battery;
    return (
      (this.batteryNow(vehicle, time) * battery.metersPerPercent) /
      (isWinter(time) ? battery.winterRideFactor : 1)
    );
  }

  hour(time: number) {
    return kstHour(time);
  }

  absoluteHour(time: number) {
    return absoluteHour(time);
  }

  meters(lat1: number, lon1: number, lat2: number, lon2: number) {
    return metersApart(lat1, lon1, lat2, lon2);
  }

  // ---- State changes ----

  /** Changes the operating state, keeping the drained battery and availability indexes. */
  setOp(vehicle: number, op: number, time: number) {
    this.commitBattery(vehicle, time);
    this.op[vehicle] = op;
    this.version[vehicle]++;
    this.syncAvailability(vehicle);
  }

  moveTo(vehicle: number, latitude: number, longitude: number) {
    this.placeAtDoor(vehicle, -1, latitude, longitude);
  }

  /** `moveTo` for a vehicle set down at door point `door` (-1: not at a door). */
  placeAtDoor(vehicle: number, door: number, latitude: number, longitude: number) {
    this.lat[vehicle] = Math.round(latitude * 1e6) / 1e6;
    this.lon[vehicle] = Math.round(longitude * 1e6) / 1e6;
    this.doorOfVehicle[vehicle] = door;
    this.syncAvailability(vehicle);
  }

  setFlag(vehicle: number, flag: number, on: boolean) {
    const before = this.flags[vehicle];
    this.flags[vehicle] = on ? before | flag : before & ~flag;
    if (flag & FLAG.HIDDEN && before !== this.flags[vehicle]) this.syncAvailability(vehicle);
  }

  has(vehicle: number, flag: number) {
    return (this.flags[vehicle] & flag) !== 0;
  }

  rentable(vehicle: number) {
    return this.op[vehicle] === OP.AVAILABLE && !(this.flags[vehicle] & FLAG.HIDDEN);
  }

  /** Keeps the rider grid and the per-cell rentable counts in step with one vehicle. */
  syncAvailability(vehicle: number) {
    if (this.op[vehicle] === OP.AVAILABLE)
      this.riderGrid.set(vehicle, this.lat[vehicle], this.lon[vehicle]);
    else this.riderGrid.remove(vehicle);
    const rentable = this.rentable(vehicle);
    const door = rentable ? this.doorOfVehicle[vehicle] : -1,
      counted = this.doorCounted[vehicle];
    if (door !== counted) {
      if (counted >= 0) this.doorLoad[counted]--;
      if (door >= 0) this.doorLoad[door]++;
      this.doorCounted[vehicle] = door;
    }
    const cell = rentable ? this.cellGrid.cell(this.lat[vehicle], this.lon[vehicle]) : -1;
    const previous = this.cellOfVehicle[vehicle];
    if (cell === previous) return;
    const byType = this.cellAvailableOf[this.vType[vehicle]];
    if (previous >= 0) {
      this.cellAvailable[previous]--;
      byType[previous]--;
    }
    if (cell >= 0) {
      this.cellAvailable[cell]++;
      byType[cell]++;
    }
    this.cellOfVehicle[vehicle] = cell;
  }

  cellOf(latitude: number, longitude: number) {
    return this.cellGrid.cell(latitude, longitude);
  }

  /**
   * Calls `visit(vehicle, meters)` for each available vehicle (hidden included, as in the rider
   * grid) within `meters` of the point; `type` -1 means any type. Order follows the grid cells.
   */
  forEachAvailableNear(
    latitude: number,
    longitude: number,
    meters: number,
    type: number,
    visit: (vehicle: number, meters: number) => void,
  ) {
    const grid = this.riderGrid;
    const row = grid.row(latitude),
      col = grid.col(longitude),
      rings = Math.ceil(meters / grid.cellMeters);
    // Squared planar distances with slack skip only what `metersApart` puts surely out of reach.
    const reachSquared = (meters * 1.000001 + 0.01) ** 2,
      lonMeters = METERS_PER_DEGREE * COS_LATITUDE;
    for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
      for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
        if (grid.gapSquared(r, c, latitude, longitude) > reachSquared) continue;
        for (const vehicle of grid.lists[r * grid.cols + c]) {
          if (type >= 0 && this.vType[vehicle] !== type) continue;
          const dy = (this.lat[vehicle] - latitude) * METERS_PER_DEGREE,
            dx = (this.lon[vehicle] - longitude) * lonMeters;
          if (dy * dy + dx * dx > reachSquared) continue;
          const distance = metersApart(latitude, longitude, this.lat[vehicle], this.lon[vehicle]);
          if (distance <= meters) visit(vehicle, distance);
        }
      }
  }

  /** How many vehicles `forEachAvailableNear` would visit. */
  countAvailableNear(latitude: number, longitude: number, meters: number, type: number) {
    let count = 0;
    this.forEachAvailableNear(latitude, longitude, meters, type, () => count++);
    return count;
  }

  cellCenter(cell: number): [number, number] {
    const row = Math.floor(cell / this.cellGrid.cols),
      col = cell % this.cellGrid.cols;
    return [
      GRID_BOUNDS.south + (row + 0.5) * this.cellGrid.cellLatitude,
      GRID_BOUNDS.west + (col + 0.5) * this.cellGrid.cellLongitude,
    ];
  }

  /**
   * Starts a parking segment (P1/P4): a new category or position. The hazard stream is keyed by
   * (vehicle, start minute, sequence within that minute), so it is the same in every window.
   */
  startSegment(vehicle: number, time: number, category: number) {
    const minute = Math.floor(time / MINUTE);
    this.segSeq[vehicle] = this.segMinute[vehicle] === minute ? this.segSeq[vehicle] + 1 : 0;
    this.segMinute[vehicle] = minute;
    this.segVersion[vehicle]++;
    this.segStartAt[vehicle] = time;
    this.category[vehicle] = category;
    this.parkState[vehicle] = this.key(PURPOSE.PARK, vehicle, minute, this.segSeq[vehicle]);
    const dock = this.rules.nearestDock(
      this.lat[vehicle],
      this.lon[vehicle],
      ASSUMPTIONS.complaints.busyDockMeters,
    );
    this.segDock[vehicle] = dock;
    this.enforcement.scheduleHazard(vehicle, time);
    this.ops.ensureBatteryTimer(vehicle, time);
  }

  /** The vehicle leaves the street: its segment, complaint stage and tasks end. */
  leaveField(vehicle: number, time: number, resolution: number) {
    this.enforcement.resolve(vehicle, time, resolution);
    this.segVersion[vehicle]++;
    this.hazardVersion[vehicle]++;
    this.category[vehicle] = CATEGORY.NONE;
    this.flags[vehicle] &= ~(
      FLAG.FALLEN |
      FLAG.HIDDEN |
      FLAG.DESIGNATED |
      FLAG.RIDER_PLACED |
      FLAG.DOCK_FALLBACK |
      FLAG.GEOMETRY |
      FLAG.OPERATOR_FLAGGED |
      FLAG.OUT_OF_AREA_COMPLAINED |
      FLAG.DISCOURAGED
    );
  }

  /** Rows are written from the served day's start; the warm-up only builds up state. */
  recording = false;

  /** Appends (or rewrites, at the same instant) the vehicle's visible state. */
  record(vehicle: number, time: number) {
    if (!this.recording) return;
    const meta =
      this.op[vehicle] |
      ((FIELD[this.op[vehicle]] ? this.category[vehicle] : CATEGORY.NONE) << 8) |
      ((FIELD[this.op[vehicle]] ? this.stage[vehicle] : STAGE.NONE) << 16) |
      ((this.flags[vehicle] & VISIBLE_FLAGS) << 20);
    const battery = this.batteryNow(vehicle, time);
    const last = this.lastInterval[vehicle];
    if (last >= 0 && this.iT.data[last] === time) {
      this.iOp.data[last] = this.op[vehicle];
      this.iLat.data[last] = this.lat[vehicle];
      this.iLon.data[last] = this.lon[vehicle];
      this.iBattery.data[last] = battery;
      this.iMeta.data[last] = meta;
      return;
    }
    if (
      last >= 0 &&
      this.iMeta.data[last] === meta &&
      this.iLat.data[last] === this.lat[vehicle] &&
      this.iLon.data[last] === this.lon[vehicle] &&
      Math.abs(this.iBattery.data[last] - battery) < 1e-9
    )
      return;
    this.lastInterval[vehicle] = this.iT.length;
    this.iT.push(time);
    this.iVehicle.push(vehicle);
    this.iOp.push(this.op[vehicle]);
    this.iLat.push(this.lat[vehicle]);
    this.iLon.push(this.lon[vehicle]);
    this.iBattery.push(battery);
    this.iMeta.push(meta);
  }

  /** Appends one event (§14). Detail columns are decoded per type by the view. */
  log(
    time: number,
    type: number,
    vehicle: number,
    crew: number,
    latitude: number,
    longitude: number,
    amount = 0,
    d0 = 0,
    d1 = 0,
    d2 = 0,
    d3 = 0,
  ) {
    // Fines are written when a ride starts, possibly before the served day and after it.
    if (time < this.startsAt || time >= this.endsAt) return;
    this.eT.push(time);
    this.eType.push(type);
    this.eVehicle.push(vehicle);
    this.eCrew.push(crew);
    this.eLat.push(Math.round(latitude * 1e6) / 1e6);
    this.eLon.push(Math.round(longitude * 1e6) / 1e6);
    this.eAmount.push(Math.round(amount));
    this.eD0.push(d0);
    this.eD1.push(d1);
    this.eD2.push(d2);
    this.eD3.push(d3);
  }

  schedule(time: number, kind: number, a = 0, b = 0, c = 0) {
    if (!Number.isFinite(time)) throw new RangeError(`Non-finite event time for kind ${kind}`);
    if (time >= this.endsAt) return;
    this.queue.push(Math.max(time, this.now), kind, a, b, c);
  }

  // ---- The run ----

  run() {
    this.now = this.warmupFrom;
    // First at the served day's start: everything earlier is warm-up and is not kept.
    this.queue.push(this.startsAt, K.SNAPSHOT, 0, 0, 0);
    this.ops.initTemplate(this.warmupFrom);
    for (let time = this.warmupFrom; time < this.endsAt; time += HOUR)
      this.schedule(time, K.HOUR, this.absoluteHour(time));
    this.ops.scheduleCalendar();
    const queue = this.queue;
    while (queue.pop()) {
      this.queueEvents++;
      const time = queue.t;
      this.now = time;
      const a = queue.pa,
        b = queue.pb,
        c = queue.pc;
      switch (queue.k) {
        case K.HOUR:
          this.riders.generateHour(a, time);
          break;
        case K.SNAPSHOT:
          this.recording = true;
          for (let vehicle = 0; vehicle < this.fleet; vehicle++) this.record(vehicle, time);
          this.ops.snapshot(time);
          break;
        case K.RIDE_END:
          this.riders.rideEnd(a, b, time, false);
          break;
        case K.AUTO_END:
          this.riders.rideEnd(a, b, time, true);
          break;
        case K.BATTERY:
          this.ops.batteryThreshold(a, b, time);
          break;
        case K.MISSING_RETURN:
          this.ops.missingReturn(a, b, time);
          break;
        case K.MISSING_WRITE_OFF:
          this.ops.missingWriteOff(a, b, time);
          break;
        case K.COMMISSION:
          this.ops.commission(a, b, time);
          break;
        case K.UNHIDE:
          this.riders.unhide(a, b, time);
          break;
        case K.RERIDE:
          this.riders.reride(a, b, time);
          break;
        case K.INSPECT_DONE:
          this.ops.inspectionDone(a, b, time);
          break;
        case K.DEPOT_SWAP_DONE:
          this.ops.depotSwapDone(a, b, time);
          break;
        case K.CHARGE_DONE:
          this.ops.chargeDone(a, b, time);
          break;
        case K.REPAIR_DONE:
          this.ops.repairDone(a, b, time);
          break;
        case K.MECHANICS:
          this.ops.serveRepairs(a, time);
          break;
        case K.TOW_READY:
          this.enforcement.towReady(a, b, time);
          break;
        case K.GRACE_END:
          this.enforcement.graceEnd(a, b, time);
          break;
        case K.DISMISS:
          this.enforcement.dismiss(a, b, time);
          break;
        case K.TOW_PICKUP:
          this.enforcement.towPickup(a, time);
          break;
        case K.IMPOUND_ARRIVE:
          this.enforcement.impoundArrive(a, b, time);
          break;
        case K.PAYMENT_RECOVERED:
          this.riders.paymentRecovered(a, time);
          break;
        case K.TOW_HOURS:
          this.enforcement.serveAll(time);
          break;
        case K.TASK_REOPEN:
          this.ops.taskReopen(a, time);
          break;
        case K.HAZARD:
          this.enforcement.hazard(a, b, time);
          break;
        case K.ARRIVAL:
          this.riders.arrive(a, time);
          break;
        case K.REACH:
          this.riders.reach(a, b, time);
          break;
        case K.ABANDON:
          this.riders.abandon(a, b, time);
          break;
        case K.SHIFT_START:
          this.ops.shiftStart(a, b, time);
          break;
        case K.SHIFT_END:
          this.ops.shiftEnd(a, b, time);
          break;
        case K.CREW_ARRIVE:
          this.ops.crewArrive(a, b, time);
          break;
        case K.CREW_DONE:
          this.ops.crewDone(a, b, time);
          break;
        case K.CREW_CHECK:
          this.ops.crewCheck(a, b, c, time);
          break;
        case K.DISPATCH:
          this.ops.dispatchTick(time);
          break;
        case K.REBALANCE:
          this.ops.rebalanceTick(time);
          break;
        case K.PLAN_MORNING:
          this.ops.planMorning(time);
          break;
        case K.PLAN_OVERNIGHT:
          this.ops.planOvernight(time);
          break;
        default:
          throw new Error(`Unknown simulation event kind ${queue.k}`);
      }
    }
    this.now = this.endsAt;
  }
}
