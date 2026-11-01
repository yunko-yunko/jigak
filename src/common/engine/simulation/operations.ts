import { ASSUMPTIONS, VEHICLE_TYPES, type TemplateSpec } from './assumptions.js';
import {
  HOUR,
  MINUTE,
  absoluteHour,
  dayTypeAt,
  dayTypeOfIndex,
  inHourBand,
  kstDateIndex,
  kstHour,
  midnightOfIndex,
  monthAt,
} from './calendar.js';
import { FOOT_HOURS, FOOT_LAYER, FOOT_LAYERS } from './foot-traffic.js';
import { PURPOSE, Stream } from './keyed-random.js';
import {
  COS_LATITUDE,
  METERS_PER_DEGREE,
  offsetLatitude,
  offsetLongitude,
  Placement,
} from './parking-rules.js';
import {
  CATEGORY,
  CREW_STATE,
  EV,
  FAULT,
  FAULT_NAMES,
  FIELD,
  FLAG,
  OP,
  REGIME,
  RESOLUTION,
  STAGE,
  TASK,
  VTYPE,
} from './sim-codes.js';
import { crowdOf, doorSpotNotFull, fullOf } from './riders.js';
import { F64, I32, type Engine } from './sim-engine.js';
import { K } from './sim-kinds.js';

const RES = Object.fromEntries(RESOLUTION.map((name, index) => [name, index])) as Record<
  (typeof RESOLUTION)[number],
  number
>;
const COLLECT = {
  broken: 0,
  battery: 1,
  'out-of-area': 2,
  impound: 3,
  'missing-check': 4,
  overnight: 5,
  rebalance: 6,
} as const;
const WRITE_OFF = { repair: 0, missing: 1, stolen: 2, vandalism: 3 } as const;
const DISCOVERED = { 'rider-check': 0, unlock: 1, 'swap-crew': 4, patrol: 5, depot: 6 } as const;

/** Crew types, matching CREW_TYPES. */
export const CREW = { VAN: 0, SWAP: 1, PATROL: 2 } as const;
const POOL = { PATROL: 0, SWAP: 1, VAN: 2 } as const;
const STATUS = { OPEN: 0, ASSIGNED: 1, DONE: 2, CANCELLED: 3 } as const;
const PHASE = {
  NONE: 0,
  TASK: 1,
  UNLOAD: 2,
  RESTOCK: 3,
  LOAD_DEPOT: 4,
  HOME: 5,
  DROP: 6,
  REBALANCE_PICK: 7,
  LOT: 8,
  LOADING: 9,
} as const;
const CHECK = { MEAL_START: 0, MEAL_END: 1, RETURN: 2 } as const;
const CARGO = { NONE: 0, PICKUP: 1, DEPLOY: 2, REBALANCE: 3 } as const;

export interface Task {
  id: number;
  kind: number;
  /** Internal priority ×10 (§9.4); the API prints floor(priority / 10). */
  priority: number;
  vehicle: number;
  lat: number;
  lon: number;
  openedAt: number;
  deadline: number;
  status: number;
  crew: number;
  pool: number;
  slot: number;
  depot: number;
  lot: number;
  count: number;
  toLat: number;
  toLon: number;
  fromCell: number;
  toCell: number;
  /** The vehicle type the task moves or swaps (a deployment or rebalance moves one type). */
  vType: number;
}

interface Drop {
  task: number;
  lat: number;
  lon: number;
  count: number;
  cell: number;
  fromCell: number;
}

export interface Crew {
  index: number;
  id: string;
  type: number;
  depot: number;
  shift: number;
  number: number;
  onShift: boolean;
  shiftStart: number;
  shiftEnd: number;
  mealAt: number;
  mealDone: boolean;
  mealPending: boolean;
  state: number;
  phase: number;
  lat: number;
  lon: number;
  destLat: number;
  destLon: number;
  eta: number;
  task: number;
  basePriority: number;
  load: number[];
  cargo: number;
  drops: Drop[];
  /** Swap crews: charged and spent pack levels per vehicle type (VTYPE). */
  charged: number[][];
  depleted: number[][];
  version: number;
  restockBlockedUntil: number;
  lateReturns: number;
  /** The slowest speed of this shift, for return plans that never miss the shift end. */
  slowKmh: number;
}

/** One vehicle type's packs at a depot: spares, charger slots and the charge queue (§9.1). */
export interface BatteryPool {
  type: number;
  spares: number;
  slots: number;
  /** Vehicles at the depot waiting for a charged pack of this type. */
  waitingVehicles: number[];
  /** Times charged spares reached 95% (ascending), from `chargedHead`. */
  charged: number[];
  chargedHead: number;
  chargingBatteries: number;
  waitingBatteries: number[];
  msPerPercent: number;
}

export interface Depot {
  index: number;
  id: string;
  name: string;
  lat: number;
  lon: number;
  share: number;
  /** Storage in van places (a scooter takes one, an e-bike `ebike.ops.vanUnits`). */
  capacity: number;
  /** Spares and charger slots of all types; `pools` holds them per type. */
  spares: number;
  slots: number;
  mechanicsWeekday: number;
  mechanicsWeekend: number;
  ready: number[];
  chargingVehicles: number;
  repairVehicles: number;
  inspecting: number;
  /** Per vehicle type: ready, charging, repair and intake-inspection counts (totals above). */
  readyOf: number[];
  chargingOf: number[];
  repairOf: number[];
  inspectingOf: number[];
  pools: BatteryPool[];
  repairQueue: number[];
  mechanicBusy: number[];
}

/** Largest-remainder split of `total` by shares; ties go to the lower index (§9.1). */
export function allocate(total: number, shares: readonly number[]): number[] {
  const sum = shares.reduce((a, b) => a + b, 0) || 1;
  const raw = shares.map((share) => (total * share) / sum);
  const result = raw.map(Math.floor);
  let rest = total - result.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => [value - Math.floor(value), index] as const)
    .sort((left, right) => right[0] - left[0] || left[1] - right[1]);
  for (let index = 0; rest > 0; index++, rest--) result[order[index % order.length][1]]++;
  return result;
}

/**
 * The dispatch order (§9.5): (priority, travel seconds, task id), all integers. Anything else
 * is a bug, so it throws instead of sorting silently.
 */
export function compareDispatch(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < 3; index++)
    if (!Number.isSafeInteger(left[index]) || !Number.isSafeInteger(right[index]))
      throw new RangeError('Dispatch keys must be finite integers');
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Per vehicle type: van places, handling factor and swap-slot units (§19). */
const VAN_UNITS = VEHICLE_TYPES.map((spec) => spec.ops.vanUnits);
/** Values per vehicle type in a `dTypeValues` row. */
export const DEPOT_TYPE_WIDTH = 7;
const HANDLING = VEHICLE_TYPES.map((spec) => spec.ops.handlingFactor);
const BATTERY_UNITS = VEHICLE_TYPES.map((spec) => spec.ops.batteryUnits);
/** Depot charge time per percent; a range of charge hours charges at its midpoint (가정값). */
const MS_PER_PERCENT = VEHICLE_TYPES.map(
  (spec) => (((spec.ops.chargeHours[0] + spec.ops.chargeHours[1]) / 2) * HOUR) / 100,
);
const TYPES = VEHICLE_TYPES.map((_, type) => type);

/**
 * The fictional operator (§9): depots with chargers and mechanics, crews on shifts, a task list
 * kept in step with every vehicle's state, and the dispatcher that sends crews out.
 */
/** Vehicles within this distance of one another count as one spot when a crew clears piles. */
const PILE_METERS = 15;

export class Operations {
  readonly crews: Crew[] = [];
  readonly depots: Depot[] = [];
  readonly tasks: Task[] = [];
  private readonly pools: number[][] = [[], [], []];
  private readonly patrolTask: Int32Array;
  private readonly fieldTask: Int32Array;
  private readonly batteryTimer: Int32Array;
  private readonly batteryTicket: Int32Array;
  /** §22.9 when each vehicle's pack went low (its swap waits for the round), -1 otherwise. */
  private readonly lowSince: Float64Array;
  private readonly pendingLevel: Float64Array;
  private readonly chargeQueuedAt: Float64Array;
  private readonly repairWork: Float64Array;
  private readonly repairParts: Float64Array;
  private readonly repairFault: Uint8Array;
  private readonly repairPreventive: Uint8Array;
  private readonly repairStarted: Float64Array;
  private readonly cellDepot: Int32Array;
  private readonly activeCells: number[] = [];
  /** Docks of each 500 m cell (CSR) with cumulative weekday + weekend rentals (§20.1). */
  private readonly cellDockStart: Int32Array;
  private readonly cellDockItems: Int32Array;
  private readonly cellDockCumulative: Float64Array;
  /** §22 door points inside each 500 m cell (CSR) with cumulative weights, for dockless cells. */
  private readonly cellDoorStart: Int32Array;
  private readonly cellDoorItems: Int32Array;
  private readonly cellDoorCumulative: Float64Array;
  /** Where a crew drives for a cell: its busiest dock, else its heaviest door, else its centre. */
  private readonly cellPoint: Float64Array;
  /** §22 foot share of each active cell per (day type, hour window), cached. */
  private readonly footShares = new Map<string, Float64Array>();
  /**
   * §22 vehicles crowding a spot and full spots (riders.ts `crowdOf`, `fullOf`). §22.9 `crowd`
   * counts a full 15 m as crowded too, as the riders' `crowdOrFull` does: a van's ten vehicles
   * no longer stack past `doors.pileCap` around a door that was not full when it was chosen.
   */
  private readonly crowd: (latitude: number, longitude: number) => number;
  private readonly full: (latitude: number, longitude: number) => boolean;
  private readonly doorFull: (door: number) => boolean;
  /** Open or running deployments and rebalances per (type, 500 m cell), either end (§9.5-7). */
  private readonly targeted: Int32Array;
  /** Open battery-swap tasks per vehicle type, for the swap crews' pack mix. */
  private readonly swapOpen = new Int32Array(VEHICLE_TYPES.length);
  /** Vehicle types with vehicles, scooters first. */
  private readonly types: number[];
  private readonly shiftCrews: Crew[][] = [[], [], [], []];
  private readonly weekendActive: Uint8Array;
  private hotThreshold = Infinity;
  private readonly stream = new Stream();
  private readonly place = new Placement();
  private readonly nearby: number[] = [];
  /** `loadDeploy`: the depot's open deployments of one type, in pool order. */
  private readonly ownDeploys: Task[] = [];
  /** `speedKmh` per crew type for one KST hour: the hour it holds, then the speed. */
  private readonly speedHour = new Float64Array(Object.keys(CREW).length).fill(NaN);
  private readonly speedOfHour = new Float64Array(Object.keys(CREW).length);

  // Crew interval log.
  readonly cT = new F64(1 << 14);
  readonly cCrew = new I32(1 << 14);
  readonly cState = new I32(1 << 14);
  readonly cLat = new F64(1 << 14);
  readonly cLon = new F64(1 << 14);
  readonly cDestLat = new F64(1 << 14);
  readonly cDestLon = new F64(1 << 14);
  readonly cEta = new F64(1 << 14);
  readonly cTask = new I32(1 << 14);
  readonly cLoad = new I32(1 << 14);
  /**
   * The e-bike part of `cLoad` (§19): e-bikes on a van, or a swap crew's e-bike packs as
   * charged × 100 + spent. `cLoad` keeps the totals over both types.
   */
  readonly cLoadB = new I32(1 << 14);
  readonly cVehicles = new I32(1 << 14);
  readonly cVehicleCount = new I32(1 << 14);
  readonly vehiclePool = new I32(1 << 14);
  // Depot, lot and task series.
  readonly dT = new F64(1 << 12);
  readonly dValues = new I32(1 << 14);
  /**
   * Per `dT` row and vehicle type: ready, charging, repair, charged packs, charging packs,
   * waiting packs and intake inspection (DEPOT_TYPE_WIDTH values × types). `dValues` keeps the
   * totals.
   */
  readonly dTypeValues = new I32(1 << 14);
  readonly lT = new F64(1 << 10);
  readonly lValues = new I32(1 << 10);
  readonly oT = new F64(1 << 12);
  readonly oValues = new I32(1 << 14);
  private readonly openCounts = new Int32Array(7);
  private readonly lotCounts: Int32Array;

  constructor(private readonly e: Engine) {
    const fleet = e.fleet,
      demand = e.demand,
      counts = [e.fleets.scooter, e.fleets.ebike];
    this.types = TYPES.filter((type) => counts[type] > 0);
    this.patrolTask = new Int32Array(fleet).fill(-1);
    this.fieldTask = new Int32Array(fleet).fill(-1);
    this.batteryTimer = new Int32Array(fleet).fill(-1);
    this.batteryTicket = new Int32Array(fleet);
    this.lowSince = new Float64Array(fleet).fill(-1);
    this.pendingLevel = new Float64Array(fleet);
    this.chargeQueuedAt = new Float64Array(fleet);
    this.repairWork = new Float64Array(fleet);
    this.repairParts = new Float64Array(fleet);
    this.repairFault = new Uint8Array(fleet);
    this.repairPreventive = new Uint8Array(fleet);
    this.repairStarted = new Float64Array(fleet);
    this.lotCounts = new Int32Array(ASSUMPTIONS.lots.length);

    // Each dock belongs to its nearest depot; depot shares follow daily rentals (§9.1).
    const depots = ASSUMPTIONS.depots;
    const nearestDepot = (lat: number, lon: number) => {
      let best = 0,
        bestMeters = Infinity;
      depots.forEach((depot, index) => {
        const meters = e.meters(lat, lon, depot.latitude, depot.longitude);
        if (meters < bestMeters) {
          bestMeters = meters;
          best = index;
        }
      });
      return best;
    };
    const volume = new Array<number>(depots.length).fill(0);
    for (let dock = 0; dock < demand.count; dock++) {
      let daily = 0;
      for (let hour = 0; hour < 24; hour++) daily += demand.rent.weekday[dock * 24 + hour];
      volume[nearestDepot(demand.docks[dock * 2], demand.docks[dock * 2 + 1])] += daily;
    }
    const total = volume.reduce((a, b) => a + b, 0);
    const shares = volume.map((value) => value / total);
    const depotConfig = ASSUMPTIONS.depot;
    // Spare packs and charger slots per type; storage counts van places (§19).
    const sparesOf = VEHICLE_TYPES.map((spec, type) =>
      allocate(Math.round(counts[type] * spec.ops.sparesPerVehicle), shares),
    );
    const storageUnits = counts[VTYPE.SCOOTER] + counts[VTYPE.EBIKE] * VAN_UNITS[VTYPE.EBIKE];
    const mechanicsTotal = Math.max(
      1,
      Math.round(fleet / ASSUMPTIONS.mechanics.vehiclesPerMechanic),
    );
    const mechanicsWeekday = allocate(mechanicsTotal, shares);
    const mechanicsWeekend = allocate(
      Math.max(1, Math.round(mechanicsTotal * ASSUMPTIONS.mechanics.weekendFactor)),
      shares,
    );
    depots.forEach((spec, index) => {
      const pools = VEHICLE_TYPES.map((_, type): BatteryPool => ({
        type,
        spares: sparesOf[type][index],
        slots: Math.round(sparesOf[type][index] * depotConfig.slotsPerSpare),
        waitingVehicles: [],
        charged: new Array<number>(sparesOf[type][index]).fill(-Infinity),
        chargedHead: 0,
        chargingBatteries: 0,
        waitingBatteries: [],
        msPerPercent: MS_PER_PERCENT[type],
      }));
      const depot: Depot = {
        index,
        id: spec.id,
        name: spec.name,
        lat: spec.latitude,
        lon: spec.longitude,
        share: shares[index],
        capacity: Math.round(storageUnits * shares[index] * depotConfig.storagePerVehicle),
        spares: pools.reduce((sum, pool) => sum + pool.spares, 0),
        slots: pools.reduce((sum, pool) => sum + pool.slots, 0),
        mechanicsWeekday: mechanicsWeekday[index],
        mechanicsWeekend: mechanicsWeekend[index],
        ready: [],
        chargingVehicles: 0,
        repairVehicles: 0,
        inspecting: 0,
        readyOf: TYPES.map(() => 0),
        chargingOf: TYPES.map(() => 0),
        repairOf: TYPES.map(() => 0),
        inspectingOf: TYPES.map(() => 0),
        pools,
        repairQueue: [],
        mechanicBusy: new Array<number>(
          Math.max(mechanicsWeekday[index], mechanicsWeekend[index]),
        ).fill(0),
      };
      this.depots.push(depot);
    });

    const cells = e.cellDock.length;
    this.cellDepot = new Int32Array(cells).fill(-1);
    this.targeted = new Int32Array(cells * VEHICLE_TYPES.length);
    const crowd = crowdOf(e);
    this.full = fullOf(e);
    this.crowd = (latitude, longitude) =>
      crowd(latitude, longitude) + (this.full(latitude, longitude) ? 1 : 0);
    this.doorFull = (door) => this.full(e.rules.doorLatitude(door), e.rules.doorLongitude(door));
    // §22 door points by 500 m cell: a cell with no dock is served from its own doors.
    const rules = e.rules,
      doorCount = rules.doors.meta.points,
      { weightCap, weightPower } = ASSUMPTIONS.doors;
    const doorCells = new Int32Array(doorCount);
    this.cellDoorStart = new Int32Array(cells + 1);
    for (let door = 0; door < doorCount; door++) {
      const latitude = rules.doorLatitude(door),
        longitude = rules.doorLongitude(door);
      const cell = rules.inServiceArea(latitude, longitude) ? e.cellOf(latitude, longitude) : -1;
      doorCells[door] = cell;
      if (cell >= 0) this.cellDoorStart[cell + 1]++;
    }
    for (let cell = 0; cell < cells; cell++)
      this.cellDoorStart[cell + 1] += this.cellDoorStart[cell];
    this.cellDoorItems = new Int32Array(this.cellDoorStart[cells]);
    this.cellDoorCumulative = new Float64Array(this.cellDoorStart[cells]);
    const doorFill = this.cellDoorStart.slice(0, cells);
    const heaviest = new Int32Array(cells).fill(-1);
    for (let door = 0; door < doorCount; door++) {
      const cell = doorCells[door];
      if (cell < 0) continue;
      const slot = doorFill[cell]++;
      const weight = Math.pow(Math.min(rules.doors.weight[door], weightCap), weightPower) + 1e-6;
      this.cellDoorItems[slot] = door;
      this.cellDoorCumulative[slot] =
        (slot > this.cellDoorStart[cell] ? this.cellDoorCumulative[slot - 1] : 0) + weight;
      if (heaviest[cell] < 0 || rules.doors.weight[door] > rules.doors.weight[heaviest[cell]])
        heaviest[cell] = door;
    }
    // Active cells (§21, §22): every cell with a dock, a door in the service area, or a busy foot
    // cell in it; before §22 only dock cells, so a quarter of the street fleet went unseen.
    const footCell = e.spatial.footCell,
      cellMin = ASSUMPTIONS.foot.cellMin;
    this.cellPoint = new Float64Array(cells * 2);
    for (let cell = 0; cell < cells; cell++) {
      const dock = e.cellDock[cell];
      const [centerLat, centerLon] = e.cellCenter(cell);
      const busy =
        !!footCell &&
        footCell[FOOT_LAYER.WD_DAY * cells + cell] >= cellMin &&
        rules.inServiceArea(centerLat, centerLon);
      if (dock < 0 && heaviest[cell] < 0 && !busy) continue;
      let lat = centerLat,
        lon = centerLon;
      if (dock >= 0) [lat, lon] = [demand.docks[dock * 2], demand.docks[dock * 2 + 1]];
      else if (heaviest[cell] >= 0)
        [lat, lon] = [rules.doorLatitude(heaviest[cell]), rules.doorLongitude(heaviest[cell])];
      else {
        // A busy cell with neither: the nearest stop, exit or crosswalk within the cell's reach,
        // so crews set vehicles down on the land proxy; with none, the cell is left out.
        const scan = rules.nearScan(centerLat, centerLon, ASSUMPTIONS.dispatch.gridMeters / 2);
        let best = -1;
        for (let layer = 1; layer < 4; layer++)
          if (scan.index[layer] >= 0 && (best < 0 || scan.meters[layer] < scan.meters[best]))
            best = layer;
        if (best < 0) continue;
        lat = rules.featureLatitude(best, scan.index[best]);
        lon = rules.featureLongitude(best, scan.index[best]);
      }
      this.cellPoint[cell * 2] = lat;
      this.cellPoint[cell * 2 + 1] = lon;
      this.cellDepot[cell] = nearestDepot(lat, lon);
      this.activeCells.push(cell);
    }
    const dockCells = Array.from({ length: demand.count }, (_, dock) =>
      e.cellOf(demand.docks[dock * 2], demand.docks[dock * 2 + 1]),
    );
    this.cellDockStart = new Int32Array(cells + 1);
    for (const cell of dockCells) if (cell >= 0) this.cellDockStart[cell + 1]++;
    for (let cell = 0; cell < cells; cell++)
      this.cellDockStart[cell + 1] += this.cellDockStart[cell];
    this.cellDockItems = new Int32Array(this.cellDockStart[cells]);
    this.cellDockCumulative = new Float64Array(this.cellDockStart[cells]);
    const fill = this.cellDockStart.slice(0, cells);
    dockCells.forEach((cell, dock) => {
      if (cell < 0) return;
      const slot = fill[cell]++;
      let volume = 0;
      for (let hour = 0; hour < 24; hour++)
        volume += demand.rent.weekday[dock * 24 + hour] + demand.rent.weekend[dock * 24 + hour];
      this.cellDockItems[slot] = dock;
      // A dock with no recorded rentals still gets a sliver, so every dock can be drawn.
      this.cellDockCumulative[slot] =
        (slot > this.cellDockStart[cell] ? this.cellDockCumulative[slot - 1] : 0) + volume + 1e-6;
    });

    // Crew roster (§9.2): per shift and type, split by depot shares, numbered per depot and type.
    // An e-bike counts as its type's crew workload against a scooter (§19).
    const numbers = depots.map(() => [0, 0, 0]);
    const prefix = ['VAN', 'SWAP', 'PATROL'];
    const weight = VEHICLE_TYPES[VTYPE.EBIKE].ops.crewWeight;
    const workload = [weight.van, weight.swap, weight.patrol].map(
      (factor) => counts[VTYPE.SCOOTER] + counts[VTYPE.EBIKE] * factor,
    );
    const weekendActive: number[] = [];
    ASSUMPTIONS.shifts.forEach((shift, shiftIndex) => {
      for (let type = 0; type < 3; type++) {
        const rate = [shift.van, shift.swap, shift.patrol][type];
        const count = Math.max(1, Math.round((workload[type] / 1000) * rate));
        const perDepot = allocate(count, shares);
        const factor =
          ASSUMPTIONS.weekendShiftFactor[shift.name as keyof typeof ASSUMPTIONS.weekendShiftFactor];
        const weekendPerDepot = allocate(Math.max(1, Math.round(count * factor)), shares);
        perDepot.forEach((crewCount, depot) => {
          for (let rank = 0; rank < crewCount; rank++) {
            const number = ++numbers[depot][type];
            const crew: Crew = {
              index: this.crews.length,
              id: `${prefix[type]}-${depots[depot].id}-${String(number).padStart(2, '0')}`,
              type,
              depot,
              shift: shiftIndex,
              number,
              onShift: false,
              shiftStart: 0,
              shiftEnd: 0,
              mealAt: 0,
              mealDone: false,
              mealPending: false,
              state: CREW_STATE.OFF,
              phase: PHASE.NONE,
              lat: depots[depot].latitude,
              lon: depots[depot].longitude,
              destLat: depots[depot].latitude,
              destLon: depots[depot].longitude,
              eta: 0,
              task: -1,
              basePriority: 9,
              load: [],
              cargo: CARGO.NONE,
              drops: [],
              charged: TYPES.map(() => []),
              depleted: TYPES.map(() => []),
              version: 0,
              restockBlockedUntil: 0,
              lateReturns: 0,
              slowKmh: 14,
            };
            this.crews.push(crew);
            this.shiftCrews[shiftIndex].push(crew);
            weekendActive.push(rank < weekendPerDepot[depot] ? 1 : 0);
          }
        });
      }
    });
    this.weekendActive = Uint8Array.from(weekendActive);
  }

  // ---- Time, travel and handling ----

  /** Crew speed in km/h now (§9.3). Swap crews drive light cars at van speeds. */
  speedKmh(type: number, time: number) {
    // The speed depends only on the KST hour and its day type, so it is kept per hour.
    const hour = absoluteHour(time);
    if (this.speedHour[type] === hour) return this.speedOfHour[type];
    const kmh = this.hourSpeedKmh(type, time);
    if (type < this.speedHour.length) {
      this.speedHour[type] = hour;
      this.speedOfHour[type] = kmh;
    }
    return kmh;
  }

  private hourSpeedKmh(type: number, time: number) {
    const travel = ASSUMPTIONS.travel;
    const hour = kstHour(time);
    let kmh: number;
    if (type === CREW.PATROL)
      kmh = inHourBand(hour, travel.patrolKmh.nightHours[0], travel.patrolKmh.nightHours[1] - 1)
        ? travel.patrolKmh.night
        : travel.patrolKmh.day;
    else {
      kmh = travel.vanKmh[travel.vanKmh.length - 1][2];
      for (const [first, last, value] of travel.vanKmh)
        if (inHourBand(hour, first, last)) {
          kmh = value;
          break;
        }
    }
    if (dayTypeAt(time) === 'weekend') kmh = Math.min(travel.maxKmh, kmh * travel.weekendFactor);
    return kmh;
  }

  /** Whole-second travel time in ms: straight line × detour at the hour's speed. */
  travelMs(
    type: number,
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
    time: number,
  ) {
    const meters = this.e.meters(fromLat, fromLon, toLat, toLon) * ASSUMPTIONS.travel.detour;
    const seconds = Math.ceil(meters / (this.speedKmh(type, time) / 3.6));
    if (!Number.isFinite(seconds)) throw new RangeError('Non-finite travel time');
    return seconds * 1000;
  }

  /** Handling time × 0.8–1.2 keyed by (vehicle, start minute, crew) (§9.3). */
  private handlingMs(minutes: number, vehicle: number, crew: number, time: number) {
    const [low, high] = ASSUMPTIONS.handling.jitter;
    const draw = this.e.spare
      .reseed(this.e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew, 1))
      .next();
    return Math.ceil(minutes * 60 * (low + (high - low) * draw)) * 1000;
  }

  private worstMs(minutes: number) {
    return Math.ceil(minutes * 60 * ASSUMPTIONS.handling.jitter[1]) * 1000;
  }

  mechanicsOn(depot: Depot, time: number) {
    const [from, to] = ASSUMPTIONS.mechanics.hours;
    const hour = kstHour(time);
    if (hour < from || hour >= to) return 0;
    return dayTypeAt(time) === 'weekend' ? depot.mechanicsWeekend : depot.mechanicsWeekday;
  }

  // ---- Vehicle types: van places, handling and packs (§19) ----

  /** Van places a list of vehicles takes. */
  private units(list: readonly number[]) {
    let units = 0;
    for (const vehicle of list) units += VAN_UNITS[this.e.vType[vehicle]];
    return units;
  }

  /** Handling weight of the first `count` vehicles of a list: an e-bike loads 1.5× as long. */
  private handled(list: readonly number[], count = list.length) {
    let weight = 0;
    for (let index = 0; index < count && index < list.length; index++)
      weight += HANDLING[this.e.vType[list[index]]];
    return weight;
  }

  /** Van places of what a task brings aboard. */
  private taskUnits(task: Task) {
    return task.count * VAN_UNITS[task.vType];
  }

  /** Depot storage in use, in van places. */
  private storedUnits(depot: Depot) {
    let units = 0;
    for (const type of this.types)
      units +=
        (depot.readyOf[type] +
          depot.chargingOf[type] +
          depot.repairOf[type] +
          depot.inspectingOf[type]) *
        VAN_UNITS[type];
    return units;
  }

  private pushReady(depot: Depot, vehicle: number) {
    depot.ready.push(vehicle);
    depot.readyOf[this.e.vType[vehicle]]++;
  }

  /** Takes the oldest `count` ready vehicles of one type off the shelf. */
  private takeReady(depot: Depot, type: number, count: number): number[] {
    const taken: number[] = [];
    if (depot.readyOf[type] === depot.ready.length) taken.push(...depot.ready.splice(0, count));
    else {
      const kept: number[] = [];
      for (const vehicle of depot.ready)
        if (taken.length < count && this.e.vType[vehicle] === type) taken.push(vehicle);
        else kept.push(vehicle);
      depot.ready = kept;
    }
    depot.readyOf[type] -= taken.length;
    return taken;
  }

  private batteryPool(depot: Depot, vehicle: number) {
    return depot.pools[this.e.vType[vehicle]];
  }

  // ---- Template (§11.2) and calendar ----

  initTemplate(start: number) {
    const e = this.e,
      demand = e.demand;
    const dateIndex = kstDateIndex(start);
    const day = dayTypeAt(start);
    const placement = demand.placement[day];
    // Each vehicle type starts from its own measured template and fault table (§11.2, §19).
    const plans = VEHICLE_TYPES.map((spec) => {
      const template: TemplateSpec = spec.template;
      const shares = [
        template.lowBattery,
        template.broken,
        template.outOfArea,
        template.missing,
        template.impounded,
        template.charging,
        template.repair,
        // The seasonal reserve waits on the depot shelf too (§9.7).
        template.ready + ASSUMPTIONS.depot.reserveByMonth[monthAt(start) - 1],
        template.writtenOff,
      ];
      const cumulative: number[] = [];
      shares.reduce((sum, share) => (cumulative.push(sum + share), sum + share), 0);
      const faultTypes = spec.faults.types;
      const codes = faultTypes.map((type) => FAULT_NAMES.indexOf(type.code));
      const pickFault = (draw: number) => {
        let rest = draw;
        for (let index = 0; index < faultTypes.length; index++) {
          rest -= faultTypes[index].share;
          if (rest < 0) return codes[index];
        }
        return FAULT.TYRE;
      };
      return { template, cumulative, pickFault, faults: spec.faults };
    });
    const place = this.place;
    const depotShares = this.depots.map((depot) => depot.share);
    const depotCumulative: number[] = [];
    depotShares.reduce((sum, share) => (depotCumulative.push(sum + share), sum + share), 0);
    const pickDepot = (draw: number) => {
      const index = depotCumulative.findIndex((value) => draw * depotCumulative.at(-1)! < value);
      return index < 0 ? 0 : index;
    };
    for (let vehicle = 0; vehicle < e.fleet; vehicle++) {
      const type = e.vType[vehicle],
        { template, cumulative, pickFault, faults } = plans[type];
      const stream = this.stream.reseed(e.key(PURPOSE.INIT, dateIndex, vehicle));
      const stateDraw = stream.next();
      let kind = cumulative.findIndex((value) => stateDraw < value);
      if (kind < 0) kind = -1; // available
      const km = Math.min(
        ASSUMPTIONS.faults.initialKmMax,
        stream.exponential(1 / ASSUMPTIONS.faults.initialKmMean),
      );
      e.km[vehicle] = km;
      // Steady state: a hidden fault appears at h(km) per km and shows itself within about
      // 1 / revealPerKm km of riding, so about h(km) / revealPerKm of vehicles carry one.
      const latentShare = Math.min(
        0.05,
        (faults.hazardPerKm * (1 + km / faults.kmScale)) / faults.revealPerKm,
      );
      const latentDraw = stream.next(),
        faultDraw = stream.next(),
        depotDraw = stream.next();
      e.latent[vehicle] = latentDraw < latentShare ? pickFault(faultDraw) : FAULT.NONE;
      e.home[vehicle] = pickDepot(depotDraw);
      const dock = stream.weighted(placement);
      const dockLat = demand.docks[dock * 2],
        dockLon = demand.docks[dock * 2 + 1];
      const radius = ASSUMPTIONS.demand.destinationJitterMeters * Math.sqrt(stream.next()),
        angle = stream.next() * 2 * Math.PI;
      // Left overnight at a door near the dock (§20.1); a dock with no door in reach keeps the
      // jitter around it.
      const door = e.rules.doorNearCapped(dock, stream, e.doorLoad, this.doorFull);
      if (door >= 0) {
        place.latitude = e.rules.doorLatitude(door);
        place.longitude = e.rules.doorLongitude(door);
      } else
        e.rules.snap(
          dockLat + offsetLatitude(radius * Math.sin(angle)),
          dockLon + offsetLongitude(radius * Math.cos(angle)),
          stream,
          place,
        );
      const depot = this.depots[e.home[vehicle]];
      const battery = stream.between(...template.availableBattery);
      const lowBattery = stream.between(...template.lowBatteryRange);
      const extra = stream.next(),
        timer = stream.next(),
        missingDraw = stream.next(),
        depotBattery = stream.between(5, 60),
        spreadMeters = stream.between(...ASSUMPTIONS.doors.spreadMeters),
        spreadAngle = stream.next() * 2 * Math.PI;
      switch (kind) {
        case -1:
        case 0:
        case 1: {
          e.moveTo(vehicle, place.latitude, place.longitude);
          e.setBattery(vehicle, kind === 0 ? lowBattery : battery, start);
          // Parked by a late-night rider overnight (compliance 0.8, §11.2).
          const compliance = ASSUMPTIONS.riderTypes[3].compliance;
          const compliant = stream.next() < compliance;
          if (compliant) {
            if (door >= 0) {
              doorSpotNotFull(e, type, door, place, this.full);
              e.rules.spreadSpot(
                type,
                spreadMeters,
                spreadAngle,
                e.doorLoad[door],
                place,
                this.crowd,
              );
            } else e.rules.legalSpot(type, place.latitude, place.longitude, place);
          } else e.rules.violation(place.latitude, place.longitude, stream, false, place);
          e.placeAtDoor(vehicle, compliant ? door : -1, place.latitude, place.longitude);
          e.op[vehicle] =
            kind === 1 ? OP.BROKEN : kind === 0 ? OP.LOW_BATTERY : e.opForBattery(battery, type);
          if (kind === 1) {
            const fault = e.latent[vehicle] || pickFault(extra);
            e.latent[vehicle] = fault;
            e.fault[vehicle] = fault;
          } else if (kind === 0) {
            // §22.9 the template's hidden packs went low over the last swap round, not all at
            // once: each waits the rest of its round (the draw `timer`, unused for this state).
            const delay = e.spec(vehicle).battery.swapDelayHours * HOUR;
            this.lowSince[vehicle] = start - (1 - timer) * delay;
            e.taskRetryAt[vehicle] = start + Math.round(timer * delay);
            e.schedule(e.taskRetryAt[vehicle], K.TASK_REOPEN, vehicle);
          }
          e.flags[vehicle] |= FLAG.RIDER_PLACED;
          if (place.dockFallback) e.flags[vehicle] |= FLAG.DOCK_FALLBACK;
          if (place.discouraged) e.flags[vehicle] |= FLAG.DISCOURAGED;
          e.syncAvailability(vehicle);
          e.startSegment(vehicle, start, place.category);
          break;
        }
        case 2: {
          // Left 1–3 km outside the service area, beyond a dock away from the center.
          const [centerLat, centerLon] = ASSUMPTIONS.serviceArea.center;
          const dy = (dockLat - centerLat) * 111_195,
            dx = (dockLon - centerLon) * 111_195 * Math.cos((37.55 * Math.PI) / 180);
          const norm = Math.hypot(dy, dx) || 1;
          let lat = dockLat,
            lon = dockLon;
          for (let km = 1 + extra * 2; km < 12; km += 1) {
            lat = dockLat + offsetLatitude((dy / norm) * km * 1000);
            lon = dockLon + offsetLongitude((dx / norm) * km * 1000);
            if (!e.rules.inServiceArea(lat, lon)) break;
          }
          e.moveTo(vehicle, lat, lon);
          e.setBattery(vehicle, battery, start);
          e.op[vehicle] = OP.OUT_OF_AREA;
          e.syncAvailability(vehicle);
          e.startSegment(vehicle, start, CATEGORY.PROPER);
          break;
        }
        case 3: {
          e.moveTo(vehicle, place.latitude, place.longitude);
          e.setBattery(vehicle, battery, start);
          e.op[vehicle] = OP.MISSING;
          e.missingKind[vehicle] = 0;
          if (missingDraw < ASSUMPTIONS.missing.recoverShare) {
            const [low, high] = ASSUMPTIONS.missing.recoverHours;
            e.schedule(
              start + Math.round((low + (high - low) * timer) * HOUR),
              K.MISSING_RETURN,
              vehicle,
              e.version[vehicle],
            );
          } else {
            const [low, high] = template.missingWriteOffHours;
            e.schedule(
              start + Math.round((low + (high - low) * timer) * HOUR),
              K.MISSING_WRITE_OFF,
              vehicle,
              e.version[vehicle],
            );
          }
          break;
        }
        case 4: {
          const lot = e.enforcement.region(place.latitude, place.longitude);
          const spec = ASSUMPTIONS.lots[lot];
          e.moveTo(vehicle, spec.latitude, spec.longitude);
          e.setBattery(vehicle, battery, start);
          e.op[vehicle] = OP.IMPOUNDED;
          e.lot[vehicle] = lot;
          e.towedCategory[vehicle] = CATEGORY.SIDEWALK;
          // An e-bike in a lot was removed by 서초구, unless the ordinance tows e-bikes (§19).
          if (!e.enforcement.towedType(vehicle)) e.enforcement.regime[vehicle] = REGIME.DISTRICT;
          else if (type === VTYPE.EBIKE) e.enforcement.regime[vehicle] = REGIME.ORDINANCE;
          const [low, high] = template.impoundedHours;
          e.impoundedAt[vehicle] = start - Math.round((low + (high - low) * timer) * HOUR);
          this.lotCounts[lot]++;
          break;
        }
        case 5:
        case 6:
        case 7: {
          e.moveTo(vehicle, depot.lat, depot.lon);
          e.setBattery(vehicle, kind === 7 ? 100 : depotBattery, start);
          if (kind === 5) {
            e.op[vehicle] = OP.DEPOT_CHARGING;
            depot.chargingVehicles++;
            depot.chargingOf[type]++;
            this.batteryPool(depot, vehicle).waitingVehicles.push(vehicle);
            this.chargeQueuedAt[vehicle] = start;
          } else if (kind === 6) {
            const fault = e.latent[vehicle] || pickFault(extra);
            e.latent[vehicle] = fault;
            e.fault[vehicle] = fault;
            e.op[vehicle] = OP.DEPOT_REPAIR;
            depot.repairVehicles++;
            depot.repairOf[type]++;
            const spec = repairOf(e, vehicle, fault);
            this.repairWork[vehicle] = Math.round(
              timer * (spec.hours[0] + (spec.hours[1] - spec.hours[0]) * missingDraw) * HOUR,
            );
            this.repairParts[vehicle] = start;
            this.repairFault[vehicle] = fault;
            this.repairPreventive[vehicle] = 0;
            depot.repairQueue.push(vehicle);
          } else {
            e.op[vehicle] = OP.DEPOT_READY;
            this.pushReady(depot, vehicle);
          }
          break;
        }
        default: {
          e.moveTo(vehicle, depot.lat, depot.lon);
          e.setBattery(vehicle, 100, start);
          e.op[vehicle] = OP.WRITTEN_OFF;
          const [low, high] = template.writtenOffHours;
          e.schedule(
            start + Math.round((low + (high - low) * timer) * HOUR),
            K.COMMISSION,
            vehicle,
            e.version[vehicle],
          );
        }
      }
      // Cases above set `op` after `moveTo`; the rider grid and per-cell counts follow it here.
      e.syncAvailability(vehicle);
      e.record(vehicle, start);
    }
    for (const depot of this.depots) this.recordDepot(depot, start);
    this.recordLots(start);
    for (let vehicle = 0; vehicle < e.fleet; vehicle++) this.vehicleChanged(vehicle, start);
  }

  /** Shifts, mechanics, planners and ticks for the whole window. */
  scheduleCalendar() {
    const e = this.e,
      from = e.warmupFrom,
      to = e.endsAt;
    for (let index = kstDateIndex(from) - 1; midnightOfIndex(index) < to; index++) {
      const midnight = midnightOfIndex(index);
      const weekend = dayTypeOfIndex(index) === 'weekend';
      ASSUMPTIONS.shifts.forEach((shift, shiftIndex) => {
        const start = midnight + shift.start * HOUR,
          end = midnight + shift.end * HOUR;
        if (end <= from || start >= to) return;
        for (const crew of this.shiftCrews[shiftIndex]) {
          if (weekend && !this.weekendActive[crew.index]) continue;
          if (start < from) this.beginShift(crew, start, end, from);
          else e.schedule(start, K.SHIFT_START, crew.index, Math.round((end - start) / MINUTE));
          e.schedule(end, K.SHIFT_END, crew.index, index);
        }
      });
      const mechanics = midnight + ASSUMPTIONS.mechanics.hours[0] * HOUR;
      if (mechanics >= from)
        for (const depot of this.depots) e.schedule(mechanics, K.MECHANICS, depot.index);
      const morning = midnight + ASSUMPTIONS.morning.planHour * HOUR;
      if (morning >= from) e.schedule(morning, K.PLAN_MORNING);
      const overnight = midnight + ASSUMPTIONS.overnight.planHour * HOUR;
      if (overnight >= from) e.schedule(overnight, K.PLAN_OVERNIGHT);
    }
    e.enforcement.scheduleTowHours(from, to);
    for (let time = from; time < to; time += ASSUMPTIONS.dispatch.tickMinutes * MINUTE)
      e.schedule(time, K.DISPATCH);
    for (let time = from; time < to; time += ASSUMPTIONS.rebalance.tickMinutes * MINUTE)
      e.schedule(time, K.REBALANCE);
    // Charging and repairs that the template left waiting.
    for (const depot of this.depots) {
      for (const pool of depot.pools) this.serveCharging(depot, pool, from);
      this.serveRepairs(depot.index, from);
    }
  }

  // ---- Shifts and meals ----

  private beginShift(crew: Crew, start: number, end: number, now: number) {
    const e = this.e,
      depot = this.depots[crew.depot];
    crew.onShift = true;
    crew.shiftStart = start;
    crew.shiftEnd = end;
    crew.slowKmh = Infinity;
    for (let hour = start; hour < end; hour += HOUR)
      crew.slowKmh = Math.min(crew.slowKmh, this.speedKmh(crew.type, hour));
    const meal = ASSUMPTIONS.meal;
    crew.mealAt =
      start +
      meal.afterHours * HOUR +
      (crew.number % meal.staggerGroups) * meal.staggerMinutes * MINUTE;
    crew.mealDone = crew.mealAt < now;
    crew.mealPending = false;
    crew.lat = crew.destLat = depot.lat;
    crew.lon = crew.destLon = depot.lon;
    crew.load = [];
    crew.cargo = CARGO.NONE;
    crew.drops = [];
    crew.task = -1;
    crew.version++;
    if (!crew.mealDone)
      e.schedule(crew.mealAt, K.CREW_CHECK, crew.index, crew.version, CHECK.MEAL_START);
    if (crew.type === CREW.SWAP) {
      // Loading packs at the depot is the first job of a swap shift (§9.2).
      crew.state = CREW_STATE.RESTOCKING;
      crew.phase = PHASE.RESTOCK;
      this.recordCrew(crew, now);
      e.schedule(
        now + ASSUMPTIONS.handling.restock * MINUTE,
        K.CREW_DONE,
        crew.index,
        crew.version,
      );
      return;
    }
    crew.state = CREW_STATE.IDLE;
    crew.phase = PHASE.NONE;
    this.recordCrew(crew, now);
  }

  shiftStart(crewIndex: number, minutes: number, time: number) {
    const crew = this.crews[crewIndex];
    this.beginShift(crew, time, time + minutes * MINUTE, time);
    if (crew.state === CREW_STATE.IDLE) this.assign(crew, time);
  }

  shiftEnd(crewIndex: number, _date: number, time: number) {
    const e = this.e,
      crew = this.crews[crewIndex];
    if (!crew.onShift || Math.abs(crew.shiftEnd - time) > 1) return;
    const depot = this.depots[crew.depot];
    const atDepot = e.meters(crew.lat, crew.lon, depot.lat, depot.lon) < 1;
    if (!atDepot || crew.state !== CREW_STATE.IDLE) crew.lateReturns++;
    // Whatever is still on board goes into the depot (§9.2: back by the end of the shift).
    for (const drop of crew.drops) {
      const task = this.tasks[drop.task];
      if (task.status === STATUS.ASSIGNED) this.close(task, STATUS.CANCELLED, time);
    }
    if (crew.load.length) this.unloadAll(crew, depot, time);
    if (crew.task >= 0) {
      const task = this.tasks[crew.task];
      if (task.status === STATUS.ASSIGNED) this.reopen(task, time);
    }
    for (const type of TYPES) {
      const pool = depot.pools[type];
      for (const level of crew.charged[type]) this.returnCharged(pool, level, time);
      for (const level of crew.depleted[type]) this.addDepleted(depot, pool, level, time);
      crew.charged[type] = [];
      crew.depleted[type] = [];
    }
    crew.onShift = false;
    crew.state = CREW_STATE.OFF;
    crew.phase = PHASE.NONE;
    crew.task = -1;
    crew.lat = crew.destLat = depot.lat;
    crew.lon = crew.destLon = depot.lon;
    crew.version++;
    this.recordCrew(crew, time);
    this.recordDepot(depot, time);
  }

  crewCheck(crewIndex: number, version: number, check: number, time: number) {
    const crew = this.crews[crewIndex];
    if (!crew.onShift) return;
    if (check === CHECK.MEAL_START) {
      if (crew.mealDone) return;
      if (crew.state === CREW_STATE.IDLE) this.startMeal(crew, time);
      else crew.mealPending = true;
      return;
    }
    if (version !== crew.version) return;
    if (check === CHECK.MEAL_END && crew.state === CREW_STATE.MEAL) this.becomeIdle(crew, time);
    else if (check === CHECK.RETURN && crew.state === CREW_STATE.IDLE) this.goHome(crew, time);
  }

  private startMeal(crew: Crew, time: number) {
    crew.mealDone = true;
    crew.mealPending = false;
    crew.state = CREW_STATE.MEAL;
    crew.phase = PHASE.NONE;
    crew.version++;
    this.recordCrew(crew, time);
    this.e.schedule(
      time + ASSUMPTIONS.meal.minutes * MINUTE,
      K.CREW_CHECK,
      crew.index,
      crew.version,
      CHECK.MEAL_END,
    );
  }

  private atDepot(crew: Crew) {
    const depot = this.depots[crew.depot];
    return this.e.meters(crew.lat, crew.lon, depot.lat, depot.lon) < 1;
  }

  /** Return time to the crew's depot at the shift's slowest speed (a safe upper bound). */
  private homeMs(crew: Crew, lat: number, lon: number, _time?: number) {
    const depot = this.depots[crew.depot];
    const meters = this.e.meters(lat, lon, depot.lat, depot.lon) * ASSUMPTIONS.travel.detour;
    return Math.ceil(meters / (crew.slowKmh / 3.6)) * 1000;
  }

  private becomeIdle(crew: Crew, time: number) {
    crew.state = CREW_STATE.IDLE;
    crew.phase = PHASE.NONE;
    crew.task = -1;
    crew.version++;
    this.recordCrew(crew, time);
    const margin = ASSUMPTIONS.dispatch.returnMarginMinutes * MINUTE;
    const home = this.homeMs(crew, crew.lat, crew.lon, time);
    if (
      crew.mealPending &&
      time + ASSUMPTIONS.meal.minutes * MINUTE + home + margin < crew.shiftEnd
    ) {
      this.startMeal(crew, time);
      return;
    }
    if (!this.atDepot(crew)) {
      if (time + home + margin >= crew.shiftEnd - MINUTE) {
        this.goHome(crew, time);
        return;
      }
      this.e.schedule(
        crew.shiftEnd - home - margin - MINUTE,
        K.CREW_CHECK,
        crew.index,
        crew.version,
        CHECK.RETURN,
      );
    }
    this.assign(crew, time);
  }

  private goHome(crew: Crew, time: number) {
    if (this.atDepot(crew)) {
      if (crew.load.length) {
        this.startUnload(crew, time);
        return;
      }
      crew.state = CREW_STATE.IDLE;
      crew.version++;
      this.recordCrew(crew, time);
      return;
    }
    const depot = this.depots[crew.depot];
    this.goTo(crew, depot.lat, depot.lon, time, crew.load.length ? PHASE.UNLOAD : PHASE.HOME);
  }

  private goTo(crew: Crew, lat: number, lon: number, time: number, phase: number) {
    const travel = this.travelMs(crew.type, crew.lat, crew.lon, lat, lon, time);
    crew.destLat = lat;
    crew.destLon = lon;
    crew.eta = time + travel;
    crew.phase = phase;
    crew.state =
      phase === PHASE.HOME ||
      phase === PHASE.UNLOAD ||
      phase === PHASE.RESTOCK ||
      phase === PHASE.LOAD_DEPOT
        ? CREW_STATE.RETURNING
        : CREW_STATE.TRAVELLING;
    crew.version++;
    this.recordCrew(crew, time);
    this.e.schedule(crew.eta, K.CREW_ARRIVE, crew.index, crew.version);
  }

  // ---- Tasks ----

  private poolOf(kind: number) {
    return kind <= TASK.RIGHT_FALLEN ? POOL.PATROL : kind === TASK.SWAP ? POOL.SWAP : POOL.VAN;
  }

  private open(
    kind: number,
    priority: number,
    vehicle: number,
    lat: number,
    lon: number,
    time: number,
    deadline = Infinity,
    vType = vehicle >= 0 ? this.e.vType[vehicle] : VTYPE.SCOOTER,
  ): Task {
    const task: Task = {
      id: this.tasks.length,
      kind,
      priority,
      vehicle,
      lat,
      lon,
      openedAt: time,
      deadline,
      status: STATUS.OPEN,
      crew: -1,
      pool: this.poolOf(kind),
      slot: -1,
      depot: -1,
      lot: -1,
      count: 1,
      toLat: 0,
      toLon: 0,
      fromCell: -1,
      toCell: -1,
      vType,
    };
    this.tasks.push(task);
    this.addToPool(task);
    this.countOpen(Math.floor(priority / 10), 1, time);
    if (priority < 20) this.dispatchIdle(time, task.pool === POOL.PATROL ? CREW.PATROL : -1);
    return task;
  }

  private addToPool(task: Task) {
    const pool = this.pools[task.pool];
    task.slot = pool.length;
    pool.push(task.id);
    if (task.pool === POOL.SWAP) this.swapOpen[task.vType]++;
  }

  private removeFromPool(task: Task) {
    if (task.slot < 0) return;
    if (task.pool === POOL.SWAP) this.swapOpen[task.vType]--;
    const pool = this.pools[task.pool];
    const last = pool.pop()!;
    if (last !== task.id) {
      pool[task.slot] = last;
      this.tasks[last].slot = task.slot;
    }
    task.slot = -1;
  }

  /**
   * A door point for a vehicle of VTYPE `type` set down in `cell`: a dock of the cell drawn by its
   * rentals, then a door in that dock's reach whose legal spot lies inside the cell, up to
   * `dropTries` draws (§20.1); in a cell with no dock (§22) a door of the cell drawn by weight.
   * A full door is passed over; -1 when none does. Leaves the door's spot in `this.place`.
   */
  private dropDoor(cell: number, type: number, stream: Stream): number {
    if (cell < 0) return -1;
    const e = this.e,
      doors = ASSUMPTIONS.doors;
    const from = this.cellDockStart[cell],
      to = this.cellDockStart[cell + 1];
    if (to <= from) return this.dropOwnDoor(cell, type, stream);
    for (let attempt = 0; attempt < doors.dropTries; attempt++) {
      const dock = this.cellDockItems[stream.weightedSegment(this.cellDockCumulative, from, to)];
      const door = e.rules.doorNear(dock, stream);
      // A crew sets vehicles down by the dock it drives to (§21): a full door or one beyond
      // `dropMeters` of the dock is passed over.
      if (
        door < 0 ||
        e.doorLoad[door] >= doors.cap ||
        this.doorFull(door) ||
        e.meters(
          e.demand.docks[dock * 2],
          e.demand.docks[dock * 2 + 1],
          e.rules.doorLatitude(door),
          e.rules.doorLongitude(door),
        ) > doors.dropMeters
      )
        continue;
      // The dock's reach (400 m) is wider than a cell (500 m): a door outside it would leave the
      // target cell short and the task counted against it.
      doorSpotNotFull(e, type, door, this.place, this.full);
      if (
        !this.place.dockFallback &&
        e.cellOf(this.place.latitude, this.place.longitude) === cell &&
        !this.full(this.place.latitude, this.place.longitude)
      ) {
        e.rules.spreadSpot(
          type,
          stream.between(...doors.spreadMeters),
          stream.next() * 2 * Math.PI,
          e.doorLoad[door],
          this.place,
          this.crowd,
        );
        return door;
      }
    }
    // §22 no door by the cell's docks had room: the cell's own doors.
    return this.dropOwnDoor(cell, type, stream);
  }

  /** §22 `dropDoor` in a cell with no dock: one of its own doors, drawn by weight, not full. */
  private dropOwnDoor(cell: number, type: number, stream: Stream): number {
    const e = this.e,
      doors = ASSUMPTIONS.doors;
    const from = this.cellDoorStart[cell],
      to = this.cellDoorStart[cell + 1];
    if (to <= from) return -1;
    for (let attempt = 0; attempt < doors.dropTries; attempt++) {
      const door = this.cellDoorItems[stream.weightedSegment(this.cellDoorCumulative, from, to)];
      if (e.doorLoad[door] >= doors.cap || this.doorFull(door)) continue;
      doorSpotNotFull(e, type, door, this.place, this.full);
      if (
        this.place.dockFallback ||
        e.cellOf(this.place.latitude, this.place.longitude) !== cell ||
        this.full(this.place.latitude, this.place.longitude)
      )
        continue;
      e.rules.spreadSpot(
        type,
        stream.between(...doors.spreadMeters),
        stream.next() * 2 * Math.PI,
        e.doorLoad[door],
        this.place,
        this.crowd,
      );
      return door;
    }
    return -1;
  }

  /** Counts a deployment or rebalance against its cells while it is open or running (§9.5-7). */
  private target(task: Task, delta: number) {
    const cells = this.e.cellDock.length,
      base = task.vType * cells;
    this.targeted[base + task.toCell] += delta;
    if (task.fromCell >= 0) this.targeted[base + task.fromCell] += delta;
  }

  /** Is a cell already the target or source of an open move of this type? */
  private isTargeted(type: number, cell: number) {
    return this.targeted[type * this.e.cellDock.length + cell] > 0;
  }

  /**
   * Can a cell take one more move of this type (§22)? One open move a cell, or up to
   * `rebalance.openPerShortCell` while it holds under `shortShare` of its target.
   */
  private canTarget(type: number, cell: number, target: number) {
    const { openPerShortCell, shortShare } = ASSUMPTIONS.rebalance;
    const open = this.targeted[type * this.e.cellDock.length + cell];
    return open < (this.availableOf(type, cell) < target * shortShare ? openPerShortCell : 1);
  }

  private close(task: Task, status: number, time: number) {
    if (task.status === STATUS.DONE || task.status === STATUS.CANCELLED) return;
    if (task.kind === TASK.DEPLOY || task.kind === TASK.REBALANCE) this.target(task, -1);
    if (task.status === STATUS.OPEN) this.removeFromPool(task);
    task.status = status;
    this.countOpen(Math.floor(task.priority / 10), -1, time);
    if (task.vehicle >= 0) {
      if (this.patrolTask[task.vehicle] === task.id) this.patrolTask[task.vehicle] = -1;
      if (this.fieldTask[task.vehicle] === task.id) this.fieldTask[task.vehicle] = -1;
    }
  }

  /** A crew gave the task back unfinished (end of shift): it is open again. */
  private reopen(task: Task, time: number) {
    if (task.status !== STATUS.ASSIGNED) return;
    task.status = STATUS.OPEN;
    task.crew = -1;
    this.addToPool(task);
    void time;
  }

  private countOpen(priority: number, delta: number, time: number) {
    this.openCounts[Math.min(6, Math.max(0, priority - 1))] += delta;
    if (!this.e.recording) return;
    const last = this.oT.length - 1;
    if (last >= 0 && this.oT.data[last] === time) {
      for (let index = 0; index < 7; index++)
        this.oValues.data[last * 7 + index] = this.openCounts[index];
      return;
    }
    this.oT.push(time);
    for (let index = 0; index < 7; index++) this.oValues.push(this.openCounts[index]);
  }

  /** Keeps the vehicle's patrol and field tasks in step with its state (§9.4). */
  vehicleChanged(vehicle: number, time: number) {
    this.refreshPatrol(vehicle, time);
    this.refreshField(vehicle, time);
    this.ensureBatteryTimer(vehicle, time);
  }

  private refreshPatrol(vehicle: number, time: number) {
    const e = this.e;
    const op = e.op[vehicle];
    let kind = -1,
      priority = 0,
      deadline = Infinity;
    if (FIELD[op] && op !== OP.RESERVED && op !== OP.OUT_OF_AREA) {
      const effective = e.enforcement.effectiveCategory(vehicle);
      // An e-bike in a 서초구 zone is removed at `towReadyAt` like a tow (§19).
      const removal =
        e.stage[vehicle] !== STAGE.NONE && e.enforcement.regime[vehicle] === REGIME.DISTRICT;
      if (
        e.has(vehicle, FLAG.OPERATOR_FLAGGED) ||
        (e.enforcement.towTable(vehicle)[effective] && e.stage[vehicle] !== STAGE.NONE) ||
        e.stage[vehicle] === STAGE.TOW_DISPATCHED ||
        removal
      ) {
        kind = TASK.REPARK_IMMEDIATE;
        // A reported vehicle a tow truck may come for goes before a proactive alert.
        priority = e.stage[vehicle] !== STAGE.NONE ? 10 : 11;
        if (removal) deadline = e.towReadyAt[vehicle];
        else if (e.stage[vehicle] !== STAGE.NONE)
          deadline = e.towReadyAt[vehicle] + ASSUMPTIONS.towing.patrolMarginMinutes * MINUTE;
      } else if (effective !== CATEGORY.PROPER && e.stage[vehicle] === STAGE.REPORTED) {
        kind = e.category[vehicle] === CATEGORY.PROPER ? TASK.RIGHT_FALLEN : TASK.REPARK;
        priority = 20;
        deadline = e.graceUntil[vehicle];
        // Past an e-bike's re-park deadline nothing is towed; the job stays open without one.
        if (e.enforcement.regime[vehicle] === REGIME.OPERATOR && time >= deadline)
          deadline = Infinity;
      } else if (e.has(vehicle, FLAG.FALLEN)) {
        kind = TASK.RIGHT_FALLEN;
        priority = 21;
      }
    }
    this.sync(this.patrolTask, vehicle, kind, priority, deadline, time);
  }

  private refreshField(vehicle: number, time: number) {
    const e = this.e;
    const op = e.op[vehicle];
    let kind = -1,
      priority = 0;
    const current = this.fieldTask[vehicle] >= 0 ? this.tasks[this.fieldTask[vehicle]] : null;
    if (op !== OP.LOW_BATTERY && op !== OP.BATTERY_DEAD && !e.has(vehicle, FLAG.BATTERY_MISSING))
      this.lowSince[vehicle] = -1;
    if (op === OP.IMPOUNDED) {
      kind = TASK.IMPOUND;
      priority = 30;
    } else if (FIELD[op] && op !== OP.RESERVED && time >= e.taskRetryAt[vehicle]) {
      if (e.has(vehicle, FLAG.MISSING_CHECK)) {
        kind = TASK.MISSING_CHECK;
        priority = 40;
      } else if (op === OP.BROKEN) {
        kind = TASK.BROKEN;
        priority = 40;
      } else if (op === OP.OUT_OF_AREA) {
        kind = TASK.OUT_OF_AREA;
        priority = e.has(vehicle, FLAG.OUT_OF_AREA_COMPLAINED) ? 30 : 40;
      } else if (
        op === OP.LOW_BATTERY ||
        op === OP.BATTERY_DEAD ||
        e.has(vehicle, FLAG.BATTERY_MISSING)
      ) {
        // §22.9 a pack that went low outside the busiest cells waits for the next swap round
        // (`battery.swapDelayHours`), unless a pre-emptive swap is already planned for it; in a
        // busy cell the crews come at once, as before.
        const planned =
          !!current &&
          current.kind === TASK.SWAP &&
          (current.status === STATUS.OPEN || current.status === STATUS.ASSIGNED);
        const hot = this.hot(e.lat[vehicle], e.lon[vehicle], time);
        const delay = e.spec(vehicle).battery.swapDelayHours * HOUR;
        if (!planned && !hot && this.lowSince[vehicle] < 0 && delay > 0) {
          this.lowSince[vehicle] = time;
          e.taskRetryAt[vehicle] = time + delay;
          e.schedule(e.taskRetryAt[vehicle], K.TASK_REOPEN, vehicle);
        } else {
          kind = TASK.SWAP;
          priority = hot ? 50 : 51;
        }
      } else if (current && current.kind === TASK.SWAP && current.priority === 52) {
        if (e.batteryNow(vehicle, time) < e.spec(vehicle).battery.preemptiveSwapPercent) {
          kind = TASK.SWAP;
          priority = 52;
        }
      } else if (current && current.kind === TASK.OVERNIGHT && e.rentable(vehicle)) {
        kind = TASK.OVERNIGHT;
        priority = 70;
      }
    }
    this.sync(this.fieldTask, vehicle, kind, priority, current?.deadline ?? Infinity, time);
  }

  private sync(
    slots: Int32Array,
    vehicle: number,
    kind: number,
    priority: number,
    deadline: number,
    time: number,
  ) {
    const e = this.e;
    let current = slots[vehicle] >= 0 ? this.tasks[slots[vehicle]] : null;
    if (current && (current.status === STATUS.DONE || current.status === STATUS.CANCELLED)) {
      slots[vehicle] = -1;
      current = null;
    }
    if (current && current.kind === kind) {
      if (current.priority !== priority) {
        this.countOpen(Math.floor(current.priority / 10), -1, time);
        current.priority = priority;
        this.countOpen(Math.floor(priority / 10), 1, time);
      }
      current.deadline = kind === TASK.OVERNIGHT ? current.deadline : deadline;
      current.lat = e.lat[vehicle];
      current.lon = e.lon[vehicle];
      return;
    }
    if (current) this.close(current, STATUS.CANCELLED, time);
    if (kind < 0) return;
    const task = this.open(kind, priority, vehicle, e.lat[vehicle], e.lon[vehicle], time, deadline);
    if (kind === TASK.IMPOUND) task.lot = e.lot[vehicle];
    slots[vehicle] = task.id;
  }

  /** Is the point's 500 m cell among the busiest 20% for the next two hours (§9.4 p5). */
  private hot(lat: number, lon: number, time: number) {
    const cell = this.e.cellOf(lat, lon);
    return cell >= 0 && this.e.expectedRentals(cell, time, 2) >= this.hotThreshold;
  }

  taskReopen(vehicle: number, time: number) {
    this.vehicleChanged(vehicle, time);
  }

  // ---- Dispatch (§9.5) ----

  dispatchTick(time: number) {
    for (const crew of this.crews)
      if (crew.onShift && (crew.state === CREW_STATE.IDLE || crew.state === CREW_STATE.MEAL))
        this.assign(crew, time);
  }

  private dispatchIdle(time: number, type: number) {
    for (const crew of this.crews)
      if (
        crew.onShift &&
        (type < 0 || crew.type === type) &&
        (crew.state === CREW_STATE.IDLE || crew.state === CREW_STATE.MEAL)
      )
        this.assign(crew, time);
  }

  /** Travel to start a task, through the depot for a deployment. */
  private approachMs(crew: Crew, task: Task, time: number) {
    if (task.kind === TASK.DEPLOY) {
      const depot = this.depots[crew.depot];
      return this.travelMs(crew.type, crew.lat, crew.lon, depot.lat, depot.lon, time);
    }
    return this.travelMs(crew.type, crew.lat, crew.lon, task.lat, task.lon, time);
  }

  /** Worst-case handling of a task, for the deadline and end-of-shift checks. */
  private taskWorkMs(crew: Crew, task: Task) {
    const handling = ASSUMPTIONS.handling;
    const factor = HANDLING[task.vType];
    switch (task.kind) {
      case TASK.REPARK_IMMEDIATE:
      case TASK.REPARK:
        return this.worstMs(handling.repark);
      case TASK.RIGHT_FALLEN:
        return this.worstMs(handling.right);
      case TASK.SWAP:
        return crew.type === CREW.VAN
          ? this.worstMs(handling.vanLoad * factor)
          : this.worstMs(VEHICLE_TYPES[task.vType].ops.swapMinutes + handling.swapStop);
      case TASK.IMPOUND:
        return this.worstMs(handling.impoundVisit + handling.impoundPerVehicle);
      case TASK.DEPLOY: {
        const count = task.count * factor;
        return this.worstMs(handling.vanLoad * count + handling.vanUnload * count);
      }
      case TASK.REBALANCE:
        return this.worstMs((handling.vanLoad + handling.vanUnload) * (task.count * factor));
      default:
        return this.worstMs(handling.vanLoad * factor);
    }
  }

  private feasible(crew: Crew, task: Task, time: number, approach: number): boolean {
    const e = this.e;
    const arrive = time + approach;
    if (arrive > task.deadline) return false;
    const depot = this.depots[crew.depot];
    let finishLat = task.lat,
      finishLon = task.lon,
      extra = 0;
    switch (task.kind) {
      case TASK.DEPLOY: {
        if (task.depot !== crew.depot || crew.load.length || !depot.ready.length) return false;
        extra = this.travelMs(crew.type, depot.lat, depot.lon, task.lat, task.lon, time);
        if (arrive + extra > task.deadline + HOUR) return false;
        break;
      }
      case TASK.REBALANCE:
        if (crew.load.length) return false;
        extra = this.travelMs(crew.type, task.lat, task.lon, task.toLat, task.toLon, time);
        finishLat = task.toLat;
        finishLon = task.toLon;
        break;
      case TASK.IMPOUND: {
        if (crew.load.length && crew.cargo !== CARGO.PICKUP) return false;
        if (this.units(crew.load) + this.taskUnits(task) > ASSUMPTIONS.capacity.vanVehicles)
          return false;
        const [open, close] = e.enforcement.lotHours(arrive);
        if (arrive < open || arrive + this.taskWorkMs(crew, task) > close) return false;
        break;
      }
      case TASK.SWAP:
        if (crew.type === CREW.SWAP) {
          if (!crew.charged[task.vType].length) return false;
        } else if (
          this.units(crew.load) + this.taskUnits(task) > ASSUMPTIONS.capacity.vanVehicles ||
          (crew.load.length && crew.cargo !== CARGO.PICKUP)
        )
          return false;
        break;
      case TASK.REPARK_IMMEDIATE:
      case TASK.REPARK:
      case TASK.RIGHT_FALLEN:
        break;
      case TASK.OVERNIGHT:
        if (this.storedUnits(depot) + this.units(crew.load) >= depot.capacity) return false;
      // falls through: a pickup like the others
      default:
        if (
          this.units(crew.load) + this.taskUnits(task) > ASSUMPTIONS.capacity.vanVehicles ||
          (crew.load.length && crew.cargo !== CARGO.PICKUP)
        )
          return false;
    }
    const finish = arrive + extra + this.taskWorkMs(crew, task);
    const unload =
      crew.type === CREW.VAN
        ? this.worstMs(
            ASSUMPTIONS.handling.vanUnload *
              (this.handled(crew.load) + task.count * HANDLING[task.vType]),
          )
        : 0;
    const home = this.homeMs(crew, finishLat, finishLon, finish);
    return (
      finish + home + unload + ASSUMPTIONS.dispatch.returnMarginMinutes * MINUTE <= crew.shiftEnd
    );
  }

  /** May this crew type take this task (§9.4 target crews). */
  private eligible(crew: Crew, task: Task, time: number): boolean {
    const dispatch = ASSUMPTIONS.dispatch;
    if (task.pool === POOL.PATROL) {
      if (crew.type === CREW.PATROL) return true;
      // Vans and swap crews re-park only, when no patrol has taken it for a while.
      return (
        task.kind === TASK.REPARK_IMMEDIATE &&
        time - task.openedAt >= dispatch.patrolFallbackMinutes * MINUTE
      );
    }
    if (task.pool === POOL.SWAP) {
      if (crew.type === CREW.SWAP) return true;
      // A battery-dead vehicle nobody swapped for half a day is collected by a van.
      return (
        crew.type === CREW.VAN &&
        time - task.openedAt >= dispatch.staleSwapHours * HOUR &&
        this.e.op[task.vehicle] === OP.BATTERY_DEAD
      );
    }
    return crew.type === CREW.VAN;
  }

  private bestKey: [number, number, number] = [0, 0, 0];
  private candidateKey: [number, number, number] = [0, 0, 0];

  /** Picks the crew's next task by (priority, travel seconds, task id) (§9.5-4). */
  private assign(crew: Crew, time: number): boolean {
    if (!crew.onShift || (crew.state !== CREW_STATE.IDLE && crew.state !== CREW_STATE.MEAL))
      return false;
    const mealOnly = crew.state === CREW_STATE.MEAL;
    const limit = ASSUMPTIONS.dispatch.maxTravelMinutes * MINUTE;
    let best: Task | null = null;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let poolIndex = 0; poolIndex < 3; poolIndex++) {
        if (crew.type === CREW.PATROL && poolIndex !== POOL.PATROL) continue;
        if (crew.type === CREW.SWAP && poolIndex === POOL.VAN) continue;
        for (const id of this.pools[poolIndex]) {
          const task = this.tasks[id];
          if (
            mealOnly &&
            (task.priority >= 20 ||
              task.deadline > time + ASSUMPTIONS.meal.interruptDeadlineMinutes * MINUTE)
          )
            continue;
          if (!this.eligible(crew, task, time)) continue;
          const approach = this.approachMs(crew, task, time);
          if (mealOnly && approach > ASSUMPTIONS.meal.interruptTravelMinutes * MINUTE) continue;
          if (pass === 0 && approach > limit && task.priority >= 30) continue;
          // A van or swap crew only stands in for a patrol close by.
          if (
            task.pool === POOL.PATROL &&
            crew.type !== CREW.PATROL &&
            approach > ASSUMPTIONS.dispatch.batchTravelMinutes * MINUTE
          )
            continue;
          const key = this.candidateKey;
          // The rank with its urgency step inside (e.g. 10 tow risk before 11 operator alert).
          key[0] = task.priority;
          key[1] = approach / 1000;
          key[2] = task.id;
          if (best && compareDispatch(key, this.bestKey) >= 0) continue;
          if (!this.feasible(crew, task, time, approach)) continue;
          best = task;
          this.bestKey[0] = key[0];
          this.bestKey[1] = key[1];
          this.bestKey[2] = key[2];
        }
      }
    }
    if (best) {
      crew.basePriority = Math.floor(best.priority / 10);
      this.start(crew, best, time);
      return true;
    }
    if (
      crew.type === CREW.SWAP &&
      this.wantsRestock(crew) &&
      time >= crew.restockBlockedUntil &&
      !mealOnly
    )
      return this.goRestock(crew, time);
    return false;
  }

  /**
   * A swap crew goes back for packs when it is low on scooter packs, or out of a type's packs
   * that open swaps wait for (§9.2, §19).
   */
  private wantsRestock(crew: Crew) {
    const limit = ASSUMPTIONS.capacity.restockAtCharged;
    for (const type of this.types)
      if (crew.charged[type].length <= limit && (type === this.types[0] || this.swapOpen[type] > 0))
        return true;
    return false;
  }

  private start(crew: Crew, task: Task, time: number) {
    if (task.status === STATUS.OPEN) this.removeFromPool(task);
    task.status = STATUS.ASSIGNED;
    task.crew = crew.index;
    crew.task = task.id;
    if (crew.state === CREW_STATE.MEAL) crew.mealDone = true;
    const e = this.e;
    switch (task.kind) {
      case TASK.DEPLOY:
        if (this.atDepot(crew)) this.loadDeploy(crew, time);
        else {
          const depot = this.depots[crew.depot];
          this.goTo(crew, depot.lat, depot.lon, time, PHASE.LOAD_DEPOT);
        }
        return;
      case TASK.REBALANCE:
        this.goTo(crew, task.lat, task.lon, time, PHASE.REBALANCE_PICK);
        return;
      case TASK.IMPOUND: {
        const lot = ASSUMPTIONS.lots[task.lot];
        this.goTo(crew, lot.latitude, lot.longitude, time, PHASE.LOT);
        return;
      }
      default:
        this.goTo(crew, e.lat[task.vehicle], e.lon[task.vehicle], time, PHASE.TASK);
    }
  }

  crewArrive(crewIndex: number, version: number, time: number) {
    const crew = this.crews[crewIndex];
    if (crew.version !== version || !crew.onShift) return;
    crew.lat = crew.destLat;
    crew.lon = crew.destLon;
    const handling = ASSUMPTIONS.handling;
    switch (crew.phase) {
      case PHASE.TASK:
        this.atTask(crew, time);
        return;
      case PHASE.UNLOAD:
        this.startUnload(crew, time);
        return;
      case PHASE.RESTOCK:
        this.work(crew, time, handling.restock * MINUTE, CREW_STATE.RESTOCKING);
        return;
      case PHASE.LOAD_DEPOT:
        this.loadDeploy(crew, time);
        return;
      case PHASE.HOME:
        crew.state = CREW_STATE.IDLE;
        crew.phase = PHASE.NONE;
        crew.version++;
        this.recordCrew(crew, time);
        this.assign(crew, time);
        return;
      case PHASE.DROP: {
        const drop = crew.drops[0];
        this.work(
          crew,
          time,
          this.handlingMs(
            handling.vanUnload * this.handled(crew.load, Math.min(drop.count, crew.load.length)),
            -1,
            crew.index,
            time,
          ),
          CREW_STATE.WORKING,
        );
        return;
      }
      case PHASE.REBALANCE_PICK:
        this.pickRebalance(crew, time);
        return;
      case PHASE.LOT:
        this.atLot(crew, time);
        return;
    }
  }

  private work(crew: Crew, time: number, ms: number, state: number) {
    crew.state = state;
    crew.version++;
    this.recordCrew(crew, time);
    this.e.schedule(time + ms, K.CREW_DONE, crew.index, crew.version);
  }

  /** Still worth doing: the vehicle is where the task expects it, in the expected state. */
  private stillValid(task: Task): boolean {
    const e = this.e;
    if (task.status !== STATUS.ASSIGNED) return false;
    const vehicle = task.vehicle;
    if (vehicle < 0) return true;
    const op = e.op[vehicle];
    switch (task.kind) {
      case TASK.SWAP:
        return op === OP.AVAILABLE || op === OP.LOW_BATTERY || op === OP.BATTERY_DEAD;
      case TASK.BROKEN:
        return op === OP.BROKEN;
      case TASK.OUT_OF_AREA:
        return op === OP.OUT_OF_AREA;
      case TASK.OVERNIGHT:
        return e.rentable(vehicle);
      case TASK.MISSING_CHECK:
        return FIELD[op] === 1 && op !== OP.RESERVED;
      case TASK.IMPOUND:
        return op === OP.IMPOUNDED;
      default:
        return FIELD[op] === 1 && op !== OP.RESERVED && op !== OP.OUT_OF_AREA;
    }
  }

  private atTask(crew: Crew, time: number) {
    const e = this.e;
    const task = this.tasks[crew.task];
    const vehicle = task.vehicle;
    if (!this.stillValid(task) || this.movedAway(crew, vehicle)) {
      if (task.status === STATUS.ASSIGNED) this.close(task, STATUS.CANCELLED, time);
      this.vehicleChangedIfField(vehicle, time);
      this.continueAfter(crew, time);
      return;
    }
    // §9.5-8 a field vehicle is sometimes not found, or behind a locked gate.
    const failure = ASSUMPTIONS.taskFailure;
    const draw = e.spare
      .reseed(e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew.index, 0))
      .next();
    const hidden = e.has(vehicle, FLAG.HIDDEN);
    const reason = hidden
      ? draw < ASSUMPTIONS.hiding.operatorNotFoundShare
        ? 0
        : -1
      : draw < failure.notFound
        ? 0
        : draw < failure.notFound + failure.inaccessible
          ? 1
          : -1;
    if (reason >= 0) {
      e.taskFails[vehicle]++;
      e.log(
        time,
        EV['task-failed'],
        vehicle,
        crew.index,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        reason,
        e.taskFails[vehicle],
      );
      this.close(task, STATUS.DONE, time);
      if (e.taskFails[vehicle] >= failure.missingAfter) this.goMissing(vehicle, time, 1);
      else {
        const [low, high] = failure.reopenHours;
        const later = e.spare
          .reseed(e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew.index, 2))
          .between(low, high);
        e.taskRetryAt[vehicle] = time + Math.round(later * HOUR);
        e.schedule(e.taskRetryAt[vehicle], K.TASK_REOPEN, vehicle);
        this.vehicleChanged(vehicle, time);
      }
      this.continueAfter(crew, time);
      return;
    }
    // Found: only failures in a row count toward `missing` (§9.5-8).
    if (vehicle >= 0) e.taskFails[vehicle] = 0;
    const handling = ASSUMPTIONS.handling;
    let minutes: number;
    switch (task.kind) {
      case TASK.REPARK_IMMEDIATE:
      case TASK.REPARK:
        minutes = handling.repark;
        break;
      case TASK.RIGHT_FALLEN:
        minutes = handling.right;
        break;
      case TASK.SWAP:
        minutes =
          crew.type === CREW.VAN
            ? handling.vanLoad * HANDLING[task.vType]
            : VEHICLE_TYPES[task.vType].ops.swapMinutes + handling.swapStop;
        break;
      default:
        minutes = handling.vanLoad * HANDLING[task.vType];
    }
    crew.phase = PHASE.TASK;
    this.work(crew, time, this.handlingMs(minutes, vehicle, crew.index, time), CREW_STATE.WORKING);
  }

  /** The vehicle is no longer where the crew went (moved by a rider, patrol or tow). */
  private movedAway(crew: Crew, vehicle: number) {
    return this.e.meters(crew.lat, crew.lon, this.e.lat[vehicle], this.e.lon[vehicle]) > 60;
  }

  private vehicleChangedIfField(vehicle: number, time: number) {
    if (vehicle >= 0) this.vehicleChanged(vehicle, time);
  }

  crewDone(crewIndex: number, version: number, time: number) {
    const crew = this.crews[crewIndex];
    if (crew.version !== version || !crew.onShift) return;
    switch (crew.phase) {
      case PHASE.TASK:
        this.completeTask(crew, time);
        return;
      case PHASE.UNLOAD:
        this.unloadAll(crew, this.depots[crew.depot], time);
        this.becomeIdle(crew, time);
        return;
      case PHASE.RESTOCK:
        this.restock(crew, time);
        this.becomeIdle(crew, time);
        return;
      case PHASE.LOADING:
        this.nextDrop(crew, time);
        return;
      case PHASE.DROP:
        this.finishDrop(crew, time);
        return;
      case PHASE.REBALANCE_PICK:
        this.nextDrop(crew, time);
        return;
      case PHASE.LOT:
        this.releaseAtLot(crew, time);
        return;
    }
  }

  private completeTask(crew: Crew, time: number) {
    const e = this.e;
    const task = this.tasks[crew.task];
    const vehicle = task.vehicle;
    if (!this.stillValid(task) || this.movedAway(crew, vehicle)) {
      if (task.status === STATUS.ASSIGNED) this.close(task, STATUS.CANCELLED, time);
      this.vehicleChangedIfField(vehicle, time);
      this.continueAfter(crew, time);
      return;
    }
    this.close(task, STATUS.DONE, time);
    switch (task.kind) {
      case TASK.REPARK_IMMEDIATE:
      case TASK.REPARK:
      case TASK.RIGHT_FALLEN:
        this.patrolFix(crew, vehicle, time);
        break;
      case TASK.SWAP:
        if (crew.type === CREW.VAN) this.pickup(crew, vehicle, time, COLLECT.battery);
        else this.swapAt(crew, vehicle, time);
        break;
      case TASK.BROKEN:
        this.pickup(crew, vehicle, time, COLLECT.broken);
        break;
      case TASK.OUT_OF_AREA:
        this.pickup(crew, vehicle, time, COLLECT['out-of-area']);
        break;
      case TASK.MISSING_CHECK:
        this.pickup(crew, vehicle, time, COLLECT['missing-check']);
        break;
      case TASK.OVERNIGHT:
        this.pickup(crew, vehicle, time, COLLECT.overnight);
        break;
    }
    this.vehicleChanged(vehicle, time);
    this.continueAfter(crew, time);
  }

  /** After a job: the next nearby job of the same or higher priority, else back or idle (§9.5-5). */
  private continueAfter(crew: Crew, time: number) {
    const batch = ASSUMPTIONS.dispatch.batchTravelMinutes * MINUTE;
    if (crew.type !== CREW.PATROL) {
      let best: Task | null = null;
      let bestMs = Infinity;
      const pools =
        crew.type === CREW.SWAP
          ? [this.pools[POOL.SWAP]]
          : [this.pools[POOL.VAN], this.pools[POOL.SWAP]];
      // A van carrying deploys or rebalances takes no pickups on the way.
      const loaded = crew.type === CREW.VAN && crew.cargo !== CARGO.PICKUP && crew.load.length > 0;
      // `travelMs` is over `batch` exactly when the straight line is over this; the slack keeps it exact.
      const metersPerSecond = this.speedKmh(crew.type, time) / 3.6;
      const reach = ((batch / 1000) * metersPerSecond) / ASSUMPTIONS.travel.detour;
      const reachSquared = (reach * 1.000001 + 0.01) ** 2;
      const lonMeters = METERS_PER_DEGREE * COS_LATITUDE;
      for (const pool of loaded ? [] : pools)
        for (const id of pool) {
          const task = this.tasks[id];
          // The same kind of work (pickups, swaps) at any priority, as the route allows.
          if (
            task.vehicle < 0 ||
            task.kind === TASK.IMPOUND ||
            task.kind === TASK.DEPLOY ||
            task.kind === TASK.REBALANCE
          )
            continue;
          const dy = (task.lat - crew.lat) * METERS_PER_DEGREE,
            dx = (task.lon - crew.lon) * lonMeters;
          if (dy * dy + dx * dx > reachSquared) continue;
          if (!this.eligible(crew, task, time)) continue;
          const ms = this.travelMs(crew.type, crew.lat, crew.lon, task.lat, task.lon, time);
          if (ms > batch || ms > bestMs || (ms === bestMs && best && task.id > best.id)) continue;
          if (!this.feasible(crew, task, time, ms)) continue;
          best = task;
          bestMs = ms;
        }
      if (best) {
        this.start(crew, best, time);
        return;
      }
      if (crew.type === CREW.VAN && crew.load.length) {
        this.goHome(crew, time);
        return;
      }
      if (
        crew.type === CREW.SWAP &&
        this.wantsRestock(crew) &&
        time >= crew.restockBlockedUntil &&
        this.goRestock(crew, time)
      )
        return;
    }
    this.becomeIdle(crew, time);
  }

  // ---- Field work ----

  /** P3/P4: a patrol (or a crew standing in) rights and re-parks a vehicle (§9.4 p1–p2). */
  private patrolFix(crew: Crew, vehicle: number, time: number) {
    const e = this.e;
    const draw = e.spare
      .reseed(e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew.index, 3))
      .next();
    const op = e.op[vehicle];
    if (
      crew.type === CREW.PATROL &&
      e.latent[vehicle] &&
      (op === OP.AVAILABLE || op === OP.LOW_BATTERY || op === OP.BATTERY_DEAD) &&
      draw < ASSUMPTIONS.inspection.patrolFindShare
    )
      this.markBroken(vehicle, e.latent[vehicle], time, DISCOVERED.patrol);
    this.fixParking(vehicle, time, crew.index, ASSUMPTIONS.parking.reparkMaxMeters, true);
    e.setFlag(vehicle, FLAG.OPERATOR_FLAGGED, false);
    e.record(vehicle, time);
  }

  /** Re-parks an improper vehicle onto a proper spot nearby, righting it; returns metres moved. */
  private fixParking(vehicle: number, time: number, crew: number, maxMeters: number, log: boolean) {
    const e = this.e;
    const from = e.category[vehicle];
    const fallen = e.has(vehicle, FLAG.FALLEN);
    if (from !== CATEGORY.PROPER) {
      const fromLat = e.lat[vehicle],
        fromLon = e.lon[vehicle];
      const stream = this.stream.reseed(
        e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew, 4),
      );
      e.rules.properSpotNear(
        fromLat,
        fromLon,
        maxMeters,
        stream,
        this.place,
        ASSUMPTIONS.parking.reparkNudgeMeters,
        e.vType[vehicle],
      );
      // §22.9 a patrol does not stack a re-parked vehicle onto a full spot (a 용산 zone) either.
      if (this.crowd(this.place.latitude, this.place.longitude) > 0)
        e.rules.spreadSpot(
          e.vType[vehicle],
          stream.between(...ASSUMPTIONS.doors.spreadMeters),
          stream.next() * 2 * Math.PI,
          e.countAvailableNear(this.place.latitude, this.place.longitude, PILE_METERS, -1),
          this.place,
          this.crowd,
        );
      e.enforcement.resolve(vehicle, time, RES.reparked);
      e.moveTo(vehicle, this.place.latitude, this.place.longitude);
      e.setFlag(vehicle, FLAG.FALLEN, false);
      e.setFlag(vehicle, FLAG.RIDER_PLACED, false);
      e.setFlag(vehicle, FLAG.DESIGNATED, false);
      e.setFlag(vehicle, FLAG.GEOMETRY, false);
      e.setFlag(vehicle, FLAG.DOCK_FALLBACK, this.place.dockFallback);
      e.setFlag(vehicle, FLAG.DISCOURAGED, this.place.discouraged);
      e.startSegment(vehicle, time, CATEGORY.PROPER);
      const moved = e.meters(fromLat, fromLon, e.lat[vehicle], e.lon[vehicle]);
      if (log)
        e.log(
          time,
          EV['patrol-repark'],
          vehicle,
          crew,
          e.lat[vehicle],
          e.lon[vehicle],
          0,
          from,
          Math.round(moved * 10),
          fallen ? 1 : 0,
        );
      return moved;
    }
    if (fallen) {
      e.setFlag(vehicle, FLAG.FALLEN, false);
      if (e.stage[vehicle] !== STAGE.NONE) e.enforcement.resolve(vehicle, time, RES.reparked);
      e.enforcement.scheduleHazard(vehicle, time);
      if (log)
        e.log(
          time,
          EV['patrol-repark'],
          vehicle,
          crew,
          e.lat[vehicle],
          e.lon[vehicle],
          0,
          from,
          0,
          1,
        );
    }
    return 0;
  }

  /** T29 a field battery swap, with the crew's inspection and tidy-up (§9.6). */
  private swapAt(crew: Crew, vehicle: number, time: number) {
    const e = this.e;
    const stream = e.spare.reseed(
      e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew.index, 5),
    );
    const inspect = stream.next(),
      tidy = stream.next();
    if (e.latent[vehicle] && inspect < ASSUMPTIONS.inspection.swapFindShare) {
      this.markBroken(vehicle, e.latent[vehicle], time, DISCOVERED['swap-crew']);
      return;
    }
    const type = e.vType[vehicle];
    if (!crew.charged[type].length) return;
    const from = e.batteryNow(vehicle, time);
    const level = crew.charged[type].shift()!;
    if (!e.has(vehicle, FLAG.BATTERY_MISSING)) crew.depleted[type].push(from);
    e.setFlag(vehicle, FLAG.BATTERY_MISSING, false);
    e.setBattery(vehicle, level, time);
    e.setOp(vehicle, OP.AVAILABLE, time);
    let tidied = 0;
    if (e.category[vehicle] !== CATEGORY.PROPER && tidy < ASSUMPTIONS.inspection.tidyShare) {
      this.fixParking(vehicle, time, crew.index, ASSUMPTIONS.parking.tidyMaxMeters, false);
      tidied = 1;
    } else if (e.has(vehicle, FLAG.FALLEN)) this.fixParking(vehicle, time, crew.index, 0, false);
    e.record(vehicle, time);
    e.log(
      time,
      EV['battery-swap'],
      vehicle,
      crew.index,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      Math.round(from * 10),
      Math.round(level * 10),
      tidied,
    );
  }

  /** T15/T16 a van loads the vehicle. */
  private pickup(crew: Crew, vehicle: number, time: number, reason: number) {
    const e = this.e;
    e.leaveField(vehicle, time, RES.collected);
    e.setFlag(vehicle, FLAG.MISSING_CHECK, false);
    e.setOp(vehicle, OP.ON_CREW_VAN, time);
    e.record(vehicle, time);
    crew.load.push(vehicle);
    crew.cargo = CARGO.PICKUP;
    e.log(time, EV.collect, vehicle, crew.index, e.lat[vehicle], e.lon[vehicle], 0, reason);
  }

  private startUnload(crew: Crew, time: number) {
    crew.phase = PHASE.UNLOAD;
    this.work(
      crew,
      time,
      this.handlingMs(
        ASSUMPTIONS.handling.vanUnload * this.handled(crew.load),
        -1,
        crew.index,
        time,
      ),
      CREW_STATE.WORKING,
    );
  }

  /** T17: unloaded vehicles are inspected for 10 minutes at the depot. */
  private unloadAll(crew: Crew, depot: Depot, time: number) {
    const e = this.e;
    for (const vehicle of crew.load) {
      if (e.op[vehicle] === OP.DEPLOYING) {
        // Undelivered deployment cargo goes back on the ready shelf.
        e.moveTo(vehicle, depot.lat, depot.lon);
        e.setOp(vehicle, OP.DEPOT_READY, time);
        this.pushReady(depot, vehicle);
        e.record(vehicle, time);
        continue;
      }
      e.moveTo(vehicle, depot.lat, depot.lon);
      e.version[vehicle]++;
      e.record(vehicle, time);
      depot.inspecting++;
      depot.inspectingOf[e.vType[vehicle]]++;
      e.schedule(
        time + ASSUMPTIONS.depot.inspectionMinutes * MINUTE,
        K.INSPECT_DONE,
        vehicle,
        e.version[vehicle],
        depot.index,
      );
      e.home[vehicle] = depot.index;
    }
    crew.load = [];
    crew.cargo = CARGO.NONE;
    crew.drops = [];
    this.recordDepot(depot, time);
  }

  inspectionDone(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.ON_CREW_VAN) return;
    const depot = this.depots[e.home[vehicle]];
    depot.inspecting--;
    depot.inspectingOf[e.vType[vehicle]]--;
    const draw = e.spare.reseed(e.key(PURPOSE.DEPOT, vehicle, Math.floor(time / MINUTE), 0)).next();
    let fault = e.fault[vehicle] || (e.has(vehicle, FLAG.FAULT_REVEALED) ? e.latent[vehicle] : 0);
    if (!fault && e.latent[vehicle] && draw < ASSUMPTIONS.depot.hiddenFaultFindShare) {
      fault = e.latent[vehicle];
      e.log(time, EV.fault, vehicle, -1, depot.lat, depot.lon, 0, fault, DISCOVERED.depot);
    }
    if (fault) this.enqueueRepair(vehicle, depot, time, fault, false);
    else if (e.km[vehicle] > ASSUMPTIONS.depot.preventiveKm)
      this.enqueueRepair(vehicle, depot, time, FAULT.NONE, true);
    else this.toChargingOrReady(vehicle, depot, time);
  }

  private toChargingOrReady(vehicle: number, depot: Depot, time: number) {
    const e = this.e;
    if (
      e.battery[vehicle] < e.spec(vehicle).battery.depotChargeBelowPercent ||
      e.has(vehicle, FLAG.BATTERY_MISSING)
    ) {
      const pool = this.batteryPool(depot, vehicle);
      e.setOp(vehicle, OP.DEPOT_CHARGING, time);
      depot.chargingVehicles++;
      depot.chargingOf[e.vType[vehicle]]++;
      pool.waitingVehicles.push(vehicle);
      this.chargeQueuedAt[vehicle] = time;
      e.record(vehicle, time);
      this.serveCharging(depot, pool, time);
    } else {
      e.setOp(vehicle, OP.DEPOT_READY, time);
      this.pushReady(depot, vehicle);
      e.record(vehicle, time);
    }
    this.recordDepot(depot, time);
  }

  // ---- Depot batteries (§9.1, §9.7), one pool per vehicle type ----

  private chargedCount(pool: BatteryPool) {
    return pool.charged.length - pool.chargedHead;
  }

  private chargedTotal(depot: Depot) {
    let total = 0;
    for (const pool of depot.pools) total += this.chargedCount(pool);
    return total;
  }

  private takeCharged(pool: BatteryPool, time: number): number {
    const reached = pool.charged[pool.chargedHead++];
    if (pool.chargedHead > 512 && pool.chargedHead * 2 > pool.charged.length) {
      pool.charged.splice(0, pool.chargedHead);
      pool.chargedHead = 0;
    }
    return Math.min(
      100,
      ASSUMPTIONS.depot.chargedPercent + Math.max(0, time - reached) / pool.msPerPercent,
    );
  }

  private returnCharged(pool: BatteryPool, level: number, time: number) {
    const reached =
      time - Math.max(0, level - ASSUMPTIONS.depot.chargedPercent) * pool.msPerPercent;
    let index = pool.charged.length;
    while (index > pool.chargedHead && pool.charged[index - 1] > reached) index--;
    pool.charged.splice(index, 0, reached);
  }

  private addDepleted(depot: Depot, pool: BatteryPool, level: number, time: number) {
    if (pool.chargingBatteries < pool.slots) this.startCharging(depot, pool, level, time);
    else pool.waitingBatteries.push(level);
  }

  private startCharging(depot: Depot, pool: BatteryPool, level: number, time: number) {
    pool.chargingBatteries++;
    const reach = time + Math.max(0, ASSUMPTIONS.depot.chargedPercent - level) * pool.msPerPercent;
    this.e.schedule(Math.max(time, Math.round(reach)), K.CHARGE_DONE, depot.index, pool.type);
  }

  chargeDone(depotIndex: number, type: number, time: number) {
    const depot = this.depots[depotIndex],
      pool = depot.pools[type];
    pool.chargingBatteries--;
    pool.charged.push(time);
    if (pool.waitingBatteries.length)
      this.startCharging(depot, pool, pool.waitingBatteries.shift()!, time);
    this.serveCharging(depot, pool, time);
    this.recordDepot(depot, time);
  }

  /** Vehicles waiting at the depot get a charged pack of their type (5 minutes, T19). */
  private serveCharging(depot: Depot, pool: BatteryPool, time: number) {
    const e = this.e;
    while (pool.waitingVehicles.length && this.chargedCount(pool) > 0) {
      const vehicle = pool.waitingVehicles.shift()!;
      this.pendingLevel[vehicle] = this.takeCharged(pool, time);
      e.schedule(
        time + ASSUMPTIONS.depot.swapMinutes * MINUTE,
        K.DEPOT_SWAP_DONE,
        vehicle,
        e.version[vehicle],
      );
    }
  }

  depotSwapDone(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.DEPOT_CHARGING) return;
    const depot = this.depots[e.home[vehicle]];
    if (!e.has(vehicle, FLAG.BATTERY_MISSING))
      this.addDepleted(depot, this.batteryPool(depot, vehicle), e.battery[vehicle], time);
    e.setFlag(vehicle, FLAG.BATTERY_MISSING, false);
    e.setBattery(vehicle, this.pendingLevel[vehicle], time);
    depot.chargingVehicles--;
    depot.chargingOf[e.vType[vehicle]]--;
    e.setOp(vehicle, OP.DEPOT_READY, time);
    this.pushReady(depot, vehicle);
    e.record(vehicle, time);
    e.log(
      time,
      EV['charge-done'],
      vehicle,
      -1,
      depot.lat,
      depot.lon,
      0,
      depot.index,
      Math.round((time - this.chargeQueuedAt[vehicle]) / MINUTE),
    );
    this.recordDepot(depot, time);
  }

  private goRestock(crew: Crew, time: number): boolean {
    const e = this.e;
    let best = this.depots[crew.depot],
      bestMeters = Infinity;
    for (const depot of this.depots) {
      const meters = e.meters(crew.lat, crew.lon, depot.lat, depot.lon);
      if (meters < bestMeters && this.chargedTotal(depot) > 0) {
        best = depot;
        bestMeters = meters;
      }
    }
    const home = this.homeMs(crew, best.lat, best.lon, time);
    const there = Math.max(
      this.travelMs(crew.type, crew.lat, crew.lon, best.lat, best.lon, time),
      Math.ceil(
        (e.meters(crew.lat, crew.lon, best.lat, best.lon) * ASSUMPTIONS.travel.detour) /
          (crew.slowKmh / 3.6),
      ) * 1000,
    );
    if (
      time +
        there +
        this.worstMs(ASSUMPTIONS.handling.restock) +
        home +
        ASSUMPTIONS.dispatch.returnMarginMinutes * MINUTE >
      crew.shiftEnd
    )
      return false;
    crew.restockBlockedUntil = time + 30 * MINUTE;
    this.goTo(crew, best.lat, best.lon, time, PHASE.RESTOCK);
    return true;
  }

  /**
   * At a depot: drop spent packs on the chargers, load charged ones (§9.2 slots). The slots are
   * shared out by the open swaps of each type, an e-bike pack taking 1.5 slots (§19).
   */
  private restock(crew: Crew, time: number) {
    const e = this.e;
    let depot = this.depots[crew.depot];
    for (const candidate of this.depots)
      if (e.meters(crew.lat, crew.lon, candidate.lat, candidate.lon) < 1) depot = candidate;
    for (const type of TYPES) {
      for (const level of crew.depleted[type])
        this.addDepleted(depot, depot.pools[type], level, time);
      crew.depleted[type] = [];
    }
    const slots = ASSUMPTIONS.capacity.swapSlots;
    let need = 0;
    for (const type of this.types) need += this.swapOpen[type] * BATTERY_UNITS[type];
    let room = slots;
    for (const type of TYPES) room -= crew.charged[type].length * BATTERY_UNITS[type];
    // First each type's share of the slots, then whatever fits of any type, in type order.
    for (const pass of [0, 1])
      for (const type of this.types) {
        const units = BATTERY_UNITS[type];
        const share =
          need > 0
            ? (this.swapOpen[type] * units) / need
            : this.types.length === 1
              ? 1
              : this.swapShare(type);
        const wanted =
          pass === 0
            ? Math.floor((slots * share) / units) - crew.charged[type].length
            : Math.floor(room / units);
        const take = Math.min(
          Math.floor(room / units),
          wanted,
          this.chargedCount(depot.pools[type]),
        );
        for (let index = 0; index < take; index++)
          crew.charged[type].push(this.takeCharged(depot.pools[type], time));
        if (take > 0) room -= take * units;
      }
    let carried = 0;
    for (const type of TYPES) {
      crew.charged[type].sort((left, right) => right - left);
      carried += crew.charged[type].length;
    }
    if (!carried) crew.restockBlockedUntil = time + 30 * MINUTE;
    this.recordDepot(depot, time);
  }

  /** Each type's expected share of the swap work when no swap is open: fleet × swap weight. */
  private swapShare(type: number) {
    const fleets = [this.e.fleets.scooter, this.e.fleets.ebike];
    let total = 0;
    for (const other of this.types)
      total += fleets[other] * VEHICLE_TYPES[other].ops.crewWeight.swap * BATTERY_UNITS[other];
    return (fleets[type] * VEHICLE_TYPES[type].ops.crewWeight.swap * BATTERY_UNITS[type]) / total;
  }

  // ---- Repairs (§9.8) ----

  private enqueueRepair(
    vehicle: number,
    depot: Depot,
    time: number,
    fault: number,
    preventive: boolean,
  ) {
    const e = this.e;
    const stream = e.spare.reseed(e.key(PURPOSE.DEPOT, vehicle, Math.floor(time / MINUTE), 1));
    const hoursDraw = stream.next(),
      partsDraw = stream.next(),
      partsWait = stream.next();
    if (preventive) {
      this.repairWork[vehicle] = ASSUMPTIONS.depot.preventiveHours * HOUR;
      this.repairParts[vehicle] = time;
    } else {
      const spec = repairOf(this.e, vehicle, fault);
      this.repairWork[vehicle] = Math.round(
        (spec.hours[0] + (spec.hours[1] - spec.hours[0]) * hoursDraw) * HOUR,
      );
      this.repairParts[vehicle] =
        time + (partsDraw < spec.partsShare ? Math.round(partsWait * spec.partsHours * HOUR) : 0);
    }
    this.repairFault[vehicle] = fault;
    this.repairPreventive[vehicle] = preventive ? 1 : 0;
    e.fault[vehicle] = fault;
    e.setOp(vehicle, OP.DEPOT_REPAIR, time);
    depot.repairVehicles++;
    depot.repairOf[e.vType[vehicle]]++;
    depot.repairQueue.push(vehicle);
    e.record(vehicle, time);
    this.recordDepot(depot, time);
    this.serveRepairs(depot.index, time);
  }

  /** Mechanics take the oldest job whose parts are in, inside 08–18 (§9.8). */
  serveRepairs(depotIndex: number, time: number) {
    const e = this.e,
      depot = this.depots[depotIndex];
    const active = this.mechanicsOn(depot, time);
    if (!active) return;
    let nextParts = Infinity;
    for (let slot = 0; slot < active; slot++) {
      if (depot.mechanicBusy[slot] > time) continue;
      const index = depot.repairQueue.findIndex((vehicle) => this.repairParts[vehicle] <= time);
      if (index < 0) break;
      const vehicle = depot.repairQueue.splice(index, 1)[0];
      const finish = this.workFinish(depot, slot, time, this.repairWork[vehicle]);
      depot.mechanicBusy[slot] = finish;
      this.repairStarted[vehicle] = time;
      e.schedule(finish, K.REPAIR_DONE, vehicle, e.version[vehicle]);
    }
    for (const vehicle of depot.repairQueue)
      if (this.repairParts[vehicle] > time)
        nextParts = Math.min(nextParts, this.repairParts[vehicle]);
    if (Number.isFinite(nextParts)) e.schedule(nextParts, K.MECHANICS, depotIndex);
  }

  /** When work of `ms` started at `start` by this mechanic ends, counting only 08–18 hours. */
  private workFinish(depot: Depot, slot: number, start: number, ms: number) {
    const [from, to] = ASSUMPTIONS.mechanics.hours;
    let cursor = start,
      rest = ms;
    for (let guard = 0; guard < 30; guard++) {
      const midnight = midnightOfIndex(kstDateIndex(cursor));
      const open = midnight + from * HOUR,
        close = midnight + to * HOUR;
      const weekend = dayTypeAt(cursor) === 'weekend';
      const working = slot < (weekend ? depot.mechanicsWeekend : depot.mechanicsWeekday);
      if (working && cursor < close) {
        const begin = Math.max(cursor, open);
        if (begin + rest <= close) return begin + rest;
        rest -= close - begin;
      }
      cursor = midnight + 24 * HOUR + from * HOUR;
    }
    return cursor + rest;
  }

  repairDone(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.DEPOT_REPAIR) return;
    const depot = this.depots[e.home[vehicle]];
    depot.repairVehicles--;
    depot.repairOf[e.vType[vehicle]]--;
    const fault = this.repairFault[vehicle],
      preventive = this.repairPreventive[vehicle] === 1;
    const draw = e.spare.reseed(e.key(PURPOSE.DEPOT, vehicle, Math.floor(time / MINUTE), 2)).next();
    const hours = (time - this.repairStarted[vehicle]) / HOUR;
    if (!preventive && draw < repairOf(e, vehicle, fault).writeOff) {
      this.writeOff(vehicle, time, WRITE_OFF.repair);
    } else {
      e.km[vehicle] = 0;
      e.latent[vehicle] = FAULT.NONE;
      e.fault[vehicle] = FAULT.NONE;
      e.unlockFails[vehicle] = 0;
      e.taskFails[vehicle] = 0;
      e.setFlag(vehicle, FLAG.FAULT_REVEALED, false);
      e.log(
        time,
        EV['repair-done'],
        vehicle,
        -1,
        depot.lat,
        depot.lon,
        0,
        fault,
        Math.round(hours * 10),
        preventive ? 1 : 0,
      );
      this.toChargingOrReady(vehicle, depot, time);
    }
    this.recordDepot(depot, time);
    this.serveRepairs(depot.index, time);
  }

  // ---- Vehicle lifecycle (§3.5) ----

  /** T4/T5/T30: a fault is found and reported; a van will collect the vehicle. */
  markBroken(vehicle: number, fault: number, time: number, discoveredBy: number) {
    const e = this.e;
    e.holder[vehicle] = -1;
    e.setOp(vehicle, OP.BROKEN, time);
    e.fault[vehicle] = fault;
    e.latent[vehicle] = fault;
    e.setFlag(vehicle, FLAG.FAULT_REVEALED, false);
    e.record(vehicle, time);
    e.log(time, EV.fault, vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, fault, discoveredBy);
    this.vehicleChanged(vehicle, time);
  }

  /** T11/T24: the vehicle disappears from the operator's view. reason: 0 signal, 1 not found, 2 not returned. */
  goMissing(vehicle: number, time: number, reason: number) {
    const e = this.e;
    if (FIELD[e.op[vehicle]]) e.leaveField(vehicle, time, RES.gone);
    e.holder[vehicle] = -1;
    e.setOp(vehicle, OP.MISSING, time);
    e.missingKind[vehicle] = reason;
    e.taskFails[vehicle] = 0;
    e.record(vehicle, time);
    e.log(time, EV['gps-lost'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, reason);
    const stream = e.spare.reseed(e.key(PURPOSE.MISSING, vehicle, Math.floor(time / MINUTE)));
    const back = stream.next(),
      when = stream.next();
    const missing = ASSUMPTIONS.missing;
    const recoverShare = reason === 2 ? missing.stolenRecoverShare : missing.recoverShare;
    if (back < recoverShare) {
      const [low, high] = missing.recoverHours;
      e.schedule(
        time + Math.round((low + (high - low) * when) * HOUR),
        K.MISSING_RETURN,
        vehicle,
        e.version[vehicle],
      );
    } else
      e.schedule(
        time + missing.writeOffDays * 24 * HOUR,
        K.MISSING_WRITE_OFF,
        vehicle,
        e.version[vehicle],
      );
    this.vehicleChanged(vehicle, time);
  }

  /** T25: back where it was, or within a kilometre; a van checks it. */
  missingReturn(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.MISSING) return;
    const stream = this.stream.reseed(
      e.key(PURPOSE.MISSING, vehicle, Math.floor(time / MINUTE), 1),
    );
    const moved = stream.next() < ASSUMPTIONS.missing.movedShare;
    const fromLat = e.lat[vehicle],
      fromLon = e.lon[vehicle];
    if (moved) {
      const meters = ASSUMPTIONS.missing.movedMaxMeters * Math.sqrt(stream.next()),
        angle = stream.next() * 2 * Math.PI;
      const lat = fromLat + offsetLatitude(meters * Math.sin(angle)),
        lon = fromLon + offsetLongitude(meters * Math.cos(angle));
      if (e.rules.inServiceArea(fromLat, fromLon)) {
        e.rules.snap(lat, lon, stream, this.place);
        // A snap that ends on a far dock would carry it beyond the kilometre: it stays put.
        if (
          e.meters(fromLat, fromLon, this.place.latitude, this.place.longitude) <=
          ASSUMPTIONS.missing.movedMaxMeters + ASSUMPTIONS.parking.landSnapRingMeters
        )
          e.moveTo(vehicle, this.place.latitude, this.place.longitude);
      } else e.moveTo(vehicle, lat, lon);
    }
    e.commitBattery(vehicle, time);
    const outside = !e.rules.inServiceArea(e.lat[vehicle], e.lon[vehicle]);
    const op = e.fault[vehicle]
      ? OP.BROKEN
      : outside
        ? OP.OUT_OF_AREA
        : e.opForBattery(e.battery[vehicle], e.vType[vehicle]);
    e.missingKind[vehicle] = 0;
    e.setOp(vehicle, op, time);
    e.setFlag(vehicle, FLAG.MISSING_CHECK, true);
    e.startSegment(vehicle, time, CATEGORY.PROPER);
    e.record(vehicle, time);
    e.log(
      time,
      EV['gps-recovered'],
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      Math.round(e.meters(fromLat, fromLon, e.lat[vehicle], e.lon[vehicle])),
    );
    this.vehicleChanged(vehicle, time);
  }

  missingWriteOff(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.MISSING) return;
    this.writeOff(
      vehicle,
      time,
      e.missingKind[vehicle] === 2 ? WRITE_OFF.stolen : WRITE_OFF.missing,
    );
  }

  /** T21/T26/T31: written off; a new vehicle takes the number 72 hours later (§3.8). */
  writeOff(vehicle: number, time: number, reason: number) {
    const e = this.e;
    if (FIELD[e.op[vehicle]]) e.leaveField(vehicle, time, RES.gone);
    e.holder[vehicle] = -1;
    e.setOp(vehicle, OP.WRITTEN_OFF, time);
    e.record(vehicle, time);
    e.log(time, EV['write-off'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, reason);
    e.schedule(
      time + ASSUMPTIONS.missing.commissionHours * HOUR,
      K.COMMISSION,
      vehicle,
      e.version[vehicle],
    );
    this.vehicleChanged(vehicle, time);
  }

  /** T32: a new unit in the same slot, ready at its depot. */
  commission(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.WRITTEN_OFF) return;
    const depot = this.depots[e.home[vehicle]];
    e.unit[vehicle]++;
    e.km[vehicle] = 0;
    e.latent[vehicle] = FAULT.NONE;
    e.fault[vehicle] = FAULT.NONE;
    e.flags[vehicle] = 0;
    e.unlockFails[vehicle] = 0;
    e.taskFails[vehicle] = 0;
    e.moveTo(vehicle, depot.lat, depot.lon);
    e.setBattery(vehicle, 100, time);
    e.setOp(vehicle, OP.DEPOT_READY, time);
    this.pushReady(depot, vehicle);
    e.record(vehicle, time);
    e.log(time, EV.commission, vehicle, -1, depot.lat, depot.lon, 0, depot.index, e.unit[vehicle]);
    this.recordDepot(depot, time);
  }

  // ---- Battery thresholds (T27) ----

  scheduleBattery(vehicle: number, time: number) {
    const e = this.e;
    const op = e.op[vehicle];
    this.batteryTimer[vehicle] = e.version[vehicle];
    const ticket = ++this.batteryTicket[vehicle];
    if (op !== OP.AVAILABLE && op !== OP.LOW_BATTERY && op !== OP.RESERVED) return;
    const battery = e.batteryNow(vehicle, time);
    const thresholds = e.spec(vehicle).battery;
    const target =
      battery >= thresholds.lowPercent
        ? thresholds.lowPercent
        : battery > thresholds.deadPercent
          ? thresholds.deadPercent
          : -1;
    if (target < 0) return;
    const rate = e.idleDrain(time, e.vType[vehicle]);
    const at = time + Math.ceil((battery - target) / rate) + 1;
    e.schedule(at, K.BATTERY, vehicle, ticket);
  }

  /** Schedules the next threshold unless a timer for the current state is already pending. */
  ensureBatteryTimer(vehicle: number, time: number) {
    if (this.batteryTimer[vehicle] !== this.e.version[vehicle]) this.scheduleBattery(vehicle, time);
  }

  batteryThreshold(vehicle: number, ticket: number, time: number) {
    const e = this.e;
    if (this.batteryTicket[vehicle] !== ticket) return;
    const op = e.op[vehicle];
    if (op === OP.RESERVED) return; // settled when the reservation ends
    if (op !== OP.AVAILABLE && op !== OP.LOW_BATTERY) return;
    const next = e.opForBattery(e.batteryNow(vehicle, time), e.vType[vehicle]);
    if (next !== op) {
      e.setOp(vehicle, next, time);
      e.record(vehicle, time);
      if (next === OP.BATTERY_DEAD)
        e.log(time, EV['battery-dead'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, 0);
      this.vehicleChanged(vehicle, time);
    } else this.scheduleBattery(vehicle, time);
  }

  // ---- Lots (§7.3) ----

  private atLot(crew: Crew, time: number) {
    const e = this.e;
    const first = this.tasks[crew.task];
    const lot = first.lot;
    const [open, close] = e.enforcement.lotHours(time);
    const handling = ASSUMPTIONS.handling;
    const picked: number[] = [];
    // Van places left; an e-bike takes two (§19).
    let room = ASSUMPTIONS.capacity.vanVehicles - this.units(crew.load);
    const candidates = [
      first.id,
      ...this.pools[POOL.VAN].filter((id) => {
        const task = this.tasks[id];
        return task.kind === TASK.IMPOUND && task.lot === lot && task.status === STATUS.OPEN;
      }),
    ];
    const lotSpec = ASSUMPTIONS.lots[lot];
    const home = this.homeMs(crew, lotSpec.latitude, lotSpec.longitude);
    let handled = this.handled(crew.load);
    for (const id of candidates) {
      if (room <= 0) break;
      const units = VAN_UNITS[this.tasks[id].vType],
        factor = HANDLING[this.tasks[id].vType];
      if (units > room) continue;
      // Each further release must still fit the lot's hours and the van's way home.
      const visit = this.worstMs(
        handling.impoundVisit + handling.impoundPerVehicle * (picked.length + 1),
      );
      const unload = this.worstMs(handling.vanUnload * (handled + factor));
      if (
        picked.length &&
        (time + visit > close ||
          time + visit + home + unload + ASSUMPTIONS.dispatch.returnMarginMinutes * MINUTE >
            crew.shiftEnd)
      )
        break;
      const task = this.tasks[id];
      if (task.status === STATUS.OPEN) this.removeFromPool(task);
      if (task.status !== STATUS.OPEN && task.status !== STATUS.ASSIGNED) continue;
      if (e.op[task.vehicle] !== OP.IMPOUNDED) {
        this.close(task, STATUS.CANCELLED, time);
        continue;
      }
      task.status = STATUS.ASSIGNED;
      task.crew = crew.index;
      picked.push(id);
      room -= units;
      handled += factor;
    }
    const ms = this.handlingMs(
      handling.impoundVisit + handling.impoundPerVehicle * picked.length,
      -1,
      crew.index,
      time,
    );
    if (!picked.length || time < open || time + ms > close) {
      for (const id of picked) this.reopen(this.tasks[id], time);
      this.becomeIdle(crew, time);
      return;
    }
    crew.drops = picked.map((id) => ({
      task: id,
      lat: 0,
      lon: 0,
      count: 0,
      cell: -1,
      fromCell: -1,
    }));
    crew.phase = PHASE.LOT;
    this.work(crew, time, ms, CREW_STATE.WORKING);
  }

  /** T14: fees paid at release; an immediate-tow rider's own violation is passed on (§7.2). */
  private releaseAtLot(crew: Crew, time: number) {
    const e = this.e;
    for (const drop of crew.drops) {
      const task = this.tasks[drop.task];
      const vehicle = task.vehicle;
      if (e.op[vehicle] !== OP.IMPOUNDED) {
        this.close(task, STATUS.CANCELLED, time);
        continue;
      }
      this.close(task, STATUS.DONE, time);
      const minutes = Math.max(0, Math.ceil((time - e.impoundedAt[vehicle]) / MINUTE));
      // Seoul's fees for a towed scooter (or an e-bike under the 2027 ordinance); 서초구 none.
      const [tow, storage] = e.enforcement.releaseFees(vehicle, minutes);
      e.log(
        time,
        EV['impound-release'],
        vehicle,
        crew.index,
        e.lat[vehicle],
        e.lon[vehicle],
        tow + storage,
        e.lot[vehicle],
        minutes,
        tow,
        storage,
      );
      if (e.enforcement.passThrough[vehicle])
        e.log(
          time,
          EV['rider-charge'],
          vehicle,
          crew.index,
          e.lat[vehicle],
          e.lon[vehicle],
          tow + storage,
          tow,
          storage,
        );
      e.enforcement.passThrough[vehicle] = 0;
      this.lotCounts[e.lot[vehicle]]--;
      e.setOp(vehicle, OP.ON_CREW_VAN, time);
      e.record(vehicle, time);
      e.log(
        time,
        EV.collect,
        vehicle,
        crew.index,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        COLLECT.impound,
      );
      crew.load.push(vehicle);
      crew.cargo = CARGO.PICKUP;
      this.vehicleChanged(vehicle, time);
    }
    crew.drops = [];
    this.recordLots(time);
    this.goHome(crew, time);
  }

  // ---- Deployment and rebalancing (§9.5-7, §9.7) ----

  private loadDeploy(crew: Crew, time: number) {
    const e = this.e,
      depot = this.depots[crew.depot];
    const first = this.tasks[crew.task];
    const type = first.vType;
    // One type a run: as many as the van's places hold (§19).
    const capacity = Math.min(
      Math.floor(ASSUMPTIONS.capacity.vanVehicles / VAN_UNITS[type]),
      depot.readyOf[type],
    );
    const chosen: Task[] = [];
    let total = 0;
    if (first.status === STATUS.ASSIGNED && capacity > 0) {
      chosen.push(first);
      total = Math.min(first.count, capacity);
      // More of this depot's deployments whose targets are close to the last one, while the
      // whole route (load, drive, unload, return at the shift's slowest speed) fits the shift.
      const handling = ASSUMPTIONS.handling;
      const slow = (lat1: number, lon1: number, lat2: number, lon2: number) =>
        Math.ceil(
          (e.meters(lat1, lon1, lat2, lon2) * ASSUMPTIONS.travel.detour) / (crew.slowKmh / 3.6),
        ) * 1000;
      const fits = (count: number, route: number, lat: number, lon: number) =>
        time +
          this.worstMs((handling.vanLoad + handling.vanUnload) * (count * HANDLING[type])) +
          route +
          this.homeMs(crew, lat, lon) +
          ASSUMPTIONS.dispatch.returnMarginMinutes * MINUTE <=
        crew.shiftEnd;
      let lastLat = first.lat,
        lastLon = first.lon,
        route = slow(depot.lat, depot.lon, first.lat, first.lon);
      // Only taking a task changes the pool while the chain grows, so the matching tasks are
      // gathered once and kept in pool order; ties keep going to the earlier slot (§21.7).
      const own = this.ownDeploys;
      own.length = 0;
      for (const id of this.pools[POOL.VAN]) {
        const task = this.tasks[id];
        if (task.kind === TASK.DEPLOY && task.depot === crew.depot && task.vType === type)
          own.push(task);
      }
      for (;;) {
        if (total >= capacity) break;
        let next: Task | null = null,
          nextMs = Infinity;
        for (const task of own) {
          const ms = this.travelMs(crew.type, lastLat, lastLon, task.lat, task.lon, time);
          if (ms <= ASSUMPTIONS.dispatch.batchTravelMinutes * MINUTE && ms < nextMs) {
            next = task;
            nextMs = ms;
          }
        }
        if (!next) break;
        const leg = slow(lastLat, lastLon, next.lat, next.lon);
        if (!fits(total + Math.min(next.count, capacity - total), route + leg, next.lat, next.lon))
          break;
        route += leg;
        this.removeFromPool(next);
        own.splice(own.indexOf(next), 1);
        own.sort((left, right) => left.slot - right.slot);
        next.status = STATUS.ASSIGNED;
        next.crew = crew.index;
        chosen.push(next);
        total += Math.min(next.count, capacity - total);
        lastLat = next.lat;
        lastLon = next.lon;
      }
    }
    if (!total) {
      for (const task of chosen) this.close(task, STATUS.CANCELLED, time);
      if (first.status === STATUS.ASSIGNED) this.close(first, STATUS.CANCELLED, time);
      this.becomeIdle(crew, time);
      return;
    }
    let left = total;
    crew.drops = [];
    for (const task of chosen) {
      const count = Math.min(task.count, left);
      if (count <= 0) {
        this.close(task, STATUS.CANCELLED, time);
        continue;
      }
      left -= count;
      crew.drops.push({
        task: task.id,
        lat: task.lat,
        lon: task.lon,
        count,
        cell: task.toCell,
        fromCell: -1,
      });
    }
    for (const vehicle of this.takeReady(depot, type, total)) {
      e.setOp(vehicle, OP.DEPLOYING, time);
      e.record(vehicle, time);
      crew.load.push(vehicle);
    }
    crew.cargo = CARGO.DEPLOY;
    crew.phase = PHASE.LOADING;
    this.recordDepot(depot, time);
    this.work(
      crew,
      time,
      this.handlingMs(
        ASSUMPTIONS.handling.vanLoad * (total * HANDLING[type]),
        -1,
        crew.index,
        time,
      ),
      CREW_STATE.WORKING,
    );
  }

  private pickRebalance(crew: Crew, time: number) {
    const e = this.e;
    const task = this.tasks[crew.task];
    const grid = e.riderGrid;
    const radius = ASSUMPTIONS.dispatch.gridMeters * 0.75;
    const found = this.nearby;
    found.length = 0;
    const row = grid.row(task.lat),
      col = grid.col(task.lon),
      rings = Math.ceil(radius / grid.cellMeters);
    for (let r = row - rings; r <= row + rings; r++)
      for (let c = col - rings; c <= col + rings; c++) {
        if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols) continue;
        for (const vehicle of grid.lists[r * grid.cols + c])
          if (
            e.vType[vehicle] === task.vType &&
            e.rentable(vehicle) &&
            this.fieldTask[vehicle] < 0 &&
            e.meters(task.lat, task.lon, e.lat[vehicle], e.lon[vehicle]) <= radius
          )
            found.push(vehicle);
      }
    // The crew clears the fullest spots first (§21), nearest first among equals.
    const crowd = new Map<number, number>();
    for (const vehicle of found)
      crowd.set(
        vehicle,
        e.countAvailableNear(e.lat[vehicle], e.lon[vehicle], PILE_METERS, task.vType),
      );
    found.sort(
      (left, right) =>
        crowd.get(right)! - crowd.get(left)! ||
        e.meters(task.lat, task.lon, e.lat[left], e.lon[left]) -
          e.meters(task.lat, task.lon, e.lat[right], e.lon[right]) ||
        left - right,
    );
    const take = found.slice(0, task.count);
    if (!take.length) {
      this.close(task, STATUS.CANCELLED, time);
      this.becomeIdle(crew, time);
      return;
    }
    for (const vehicle of take) {
      e.leaveField(vehicle, time, RES.collected);
      e.setOp(vehicle, OP.ON_CREW_VAN, time);
      e.record(vehicle, time);
      e.log(
        time,
        EV.collect,
        vehicle,
        crew.index,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        COLLECT.rebalance,
      );
      crew.load.push(vehicle);
      this.vehicleChanged(vehicle, time);
    }
    crew.cargo = CARGO.REBALANCE;
    crew.drops = [
      {
        task: task.id,
        lat: task.toLat,
        lon: task.toLon,
        count: take.length,
        cell: task.toCell,
        fromCell: task.fromCell,
      },
    ];
    crew.phase = PHASE.REBALANCE_PICK;
    this.work(
      crew,
      time,
      this.handlingMs(ASSUMPTIONS.handling.vanLoad * this.handled(take), -1, crew.index, time),
      CREW_STATE.WORKING,
    );
  }

  private nextDrop(crew: Crew, time: number) {
    if (!crew.drops.length || !crew.load.length) {
      if (crew.load.length) this.goHome(crew, time);
      else this.becomeIdle(crew, time);
      return;
    }
    const drop = crew.drops[0];
    this.goTo(crew, drop.lat, drop.lon, time, PHASE.DROP);
  }

  /**
   * T18/T23: vehicles set down at door points of the target cell, each by a dock of the cell
   * drawn by its rentals and a door in that dock's reach inside the cell (§20.1), on the type's
   * legal spot.
   */
  private finishDrop(crew: Crew, time: number) {
    const e = this.e;
    const drop = crew.drops.shift()!;
    const task = this.tasks[drop.task];
    const count = Math.min(drop.count, crew.load.length);
    for (let index = 0; index < count; index++) {
      const vehicle = crew.load.shift()!;
      const stream = this.stream.reseed(
        e.key(PURPOSE.TASK, vehicle, Math.floor(time / MINUTE), crew.index, 6),
      );
      // Without a free door the vehicles go round the drop point, wider the more stand there.
      const crowd = e.countAvailableNear(
        drop.lat,
        drop.lon,
        ASSUMPTIONS.parking.deployJitterMeters,
        -1,
      );
      const spread =
        ASSUMPTIONS.parking.deployJitterMeters * Math.sqrt(1 + crowd / ASSUMPTIONS.doors.cap);
      const radius = spread * Math.sqrt(stream.next()),
        angle = stream.next() * 2 * Math.PI;
      const door = this.dropDoor(drop.cell, e.vType[vehicle], stream);
      if (door < 0) {
        const type = e.vType[vehicle];
        const jitterLat = drop.lat + offsetLatitude(radius * Math.sin(angle)),
          jitterLon = drop.lon + offsetLongitude(radius * Math.cos(angle));
        e.rules.properSpotNear(
          jitterLat,
          jitterLon,
          ASSUMPTIONS.parking.deployJitterMeters,
          stream,
          this.place,
          0,
          type,
        );
        // §22 a full legal spot (a gate, a dock's edge) sends the crew on to the next one, and
        // the vehicles stand apart (`crowd`); the jitter already drawn sets how far aside.
        const place = this.place;
        if (
          !place.noReturn &&
          e.meters(jitterLat, jitterLon, place.latitude, place.longitude) > 1 &&
          this.full(place.latitude, place.longitude)
        )
          e.rules.legalSpot(type, jitterLat, jitterLon, place, this.full);
        const [near, far] = ASSUMPTIONS.doors.spreadMeters;
        e.rules.spreadSpot(
          type,
          Math.min(far, Math.max(near, radius)),
          angle,
          e.countAvailableNear(place.latitude, place.longitude, PILE_METERS, -1),
          place,
          this.crowd,
        );
      }
      const deploying = e.op[vehicle] === OP.DEPLOYING;
      e.placeAtDoor(vehicle, door, this.place.latitude, this.place.longitude);
      e.flags[vehicle] &= FLAG.FAULT_REVEALED;
      if (this.place.dockFallback) e.flags[vehicle] |= FLAG.DOCK_FALLBACK;
      if (this.place.discouraged) e.flags[vehicle] |= FLAG.DISCOURAGED;
      e.commitBattery(vehicle, time);
      e.setOp(vehicle, e.opForBattery(e.battery[vehicle], e.vType[vehicle]), time);
      e.startSegment(vehicle, time, CATEGORY.PROPER);
      e.record(vehicle, time);
      if (deploying)
        e.log(
          time,
          EV.deploy,
          vehicle,
          crew.index,
          e.lat[vehicle],
          e.lon[vehicle],
          0,
          crew.depot,
          drop.cell,
        );
      else
        e.log(
          time,
          EV.rebalance,
          vehicle,
          crew.index,
          e.lat[vehicle],
          e.lon[vehicle],
          0,
          drop.fromCell,
          drop.cell,
        );
      this.vehicleChanged(vehicle, time);
    }
    this.close(task, STATUS.DONE, time);
    if (crew.drops.length && crew.load.length) {
      this.nextDrop(crew, time);
      return;
    }
    for (const left of crew.drops) this.close(this.tasks[left.task], STATUS.CANCELLED, time);
    crew.drops = [];
    if (crew.load.length) this.goHome(crew, time);
    else {
      crew.cargo = CARGO.NONE;
      this.becomeIdle(crew, time);
    }
  }

  // ---- Planners ----

  /** Vehicles of one type in the fleet. */
  private fleetOf(type: number) {
    return type === VTYPE.EBIKE ? this.e.fleets.ebike : this.e.fleets.scooter;
  }

  /** Expected rentals of one type in a cell; with one type running, the whole demand. */
  private expectedOf(type: number, cell: number, from: number, hours: number) {
    return this.e.mixed
      ? this.e.expectedRentalsOf(type, cell, from, hours)
      : this.e.expectedRentals(cell, from, hours);
  }

  /** Rentable vehicles of one type in a cell. */
  private availableOf(type: number, cell: number) {
    return this.e.mixed ? this.e.cellAvailableOf[type][cell] : this.e.cellAvailable[cell];
  }

  /** Vans of the shifts now on duty. */
  private vansOnShift() {
    let count = 0;
    for (const crew of this.crews) if (crew.onShift && crew.type === CREW.VAN) count++;
    return count;
  }

  /**
   * §22 each active cell's share of the foot-traffic target (`SpatialDemand.footTarget`, w^γ)
   * over [from, from + hours), the layers mixed by the hours (`FOOT_HOURS`); null without foot
   * data. Cached per day type and hours.
   */
  private footShareOf(type: number, from: number, hours: number): Float64Array | null {
    const spatial = this.e.spatial;
    // The scooter's foot target has the 구 shares in it (§22).
    const target =
      type === VTYPE.SCOOTER && spatial.scooterFootTarget
        ? spatial.scooterFootTarget
        : spatial.footTarget;
    if (!target) return null;
    const layers = new Float64Array(FOOT_LAYERS.length);
    let key = '';
    for (let offset = 0; offset < hours; offset++) {
      const time = from + offset * HOUR;
      const day = dayTypeAt(time),
        hour = kstHour(time);
      key += `${type}${day[4]}${hour},`;
      const weights = FOOT_HOURS[day][hour];
      for (let layer = 0; layer < layers.length; layer++) layers[layer] += weights[layer] / hours;
    }
    let shares = this.footShares.get(key);
    if (!shares) {
      shares = new Float64Array(this.activeCells.length);
      let total = 0;
      this.activeCells.forEach((cell, index) => {
        let value = 0;
        for (let layer = 0; layer < layers.length; layer++)
          if (layers[layer]) value += layers[layer] * target[layer][cell];
        shares![index] = value;
        total += value;
      });
      if (total > 0) for (let index = 0; index < shares.length; index++) shares[index] /= total;
      this.footShares.set(key, shares);
    }
    return shares;
  }

  /**
   * §21 each type's vehicles on the street (plus `extra` coming out of the depots) shared over the
   * active cells by expected rentals over [from, from + hours), with `rebalance.floorShare` of them
   * spread evenly (가정값): vehicles stand where riders start, and quiet cells keep a few. §22 the
   * rest is half the demand share and half the foot share (`foot.targetBlend`, 가정값, U-SPACE
   * §3.2): busy blocks the 따릉이 table misses (강남역, 역삼, 명동) are aimed at too.
   */
  private demandTargets(type: number, extra: number, from: number, hours: number): number[] {
    const floorShare = ASSUMPTIONS.rebalance.floorShare;
    let street = extra,
      total = 0;
    const expected = this.activeCells.map((cell) => {
      street += this.availableOf(type, cell);
      const value = this.expectedOf(type, cell, from, hours);
      total += value;
      return value;
    });
    // People move faster than the demand table looks ahead: the foot part follows the next
    // `rebalance.horizonHours` only (§22), so office blocks keep their vehicles into the evening.
    const foot = this.footShareOf(type, from, Math.min(hours, ASSUMPTIONS.rebalance.horizonHours));
    const footBlend = foot ? (total > 0 ? ASSUMPTIONS.foot.targetBlend : 1) : 0;
    const even = (street * floorShare) / Math.max(1, expected.length);
    return expected.map(
      (value, index) =>
        even +
        street *
          (1 - floorShare) *
          ((1 - footBlend) * (total > 0 ? value / total : 0) +
            footBlend * (foot ? foot[index] : 0)),
    );
  }

  /**
   * Deployment tasks for a depot's ready stock of one type (§21): the depot's cells furthest below
   * their demand share (`demandTargets` with every depot's deployable stock added), as many van
   * drops of up to `maxPerCell` as each cell is short, then (when `fillAll`) the rest to the cells
   * with the largest shares, until the stock is spoken for. Cells another move of the type already
   * targets are skipped (§9.5-7).
   */
  private deployTasks(
    depot: Depot,
    type: number,
    stock: number,
    targets: readonly number[],
    priority: number,
    deadline: number,
    time: number,
    fillAll: boolean,
  ) {
    const e = this.e,
      rebalance = ASSUMPTIONS.rebalance;
    const ranked: [number, number, number][] = [];
    this.activeCells.forEach((cell, index) => {
      if (this.cellDepot[cell] !== depot.index || !this.canTarget(type, cell, targets[index]))
        return;
      const need = targets[index] - this.availableOf(type, cell);
      if (need >= rebalance.minPerSpot) ranked.push([0, need, cell]);
      if (fillAll) ranked.push([1, targets[index], cell]);
    });
    ranked.sort((left, right) => left[0] - right[0] || right[1] - left[1] || left[2] - right[2]);
    let left = stock;
    for (const [stage, value, cell] of ranked) {
      // Stage 0 covers the shortfall; stage 1 adds one drop where the share is largest.
      let want = stage === 0 ? Math.ceil(value) : rebalance.maxPerCell;
      while (want >= rebalance.minPerSpot && left >= rebalance.minPerSpot) {
        const count = Math.min(rebalance.maxPerCell, want, left);
        const task = this.open(
          TASK.DEPLOY,
          priority,
          -1,
          this.cellPoint[cell * 2],
          this.cellPoint[cell * 2 + 1],
          time,
          deadline,
          type,
        );
        task.depot = depot.index;
        task.count = count;
        task.toCell = cell;
        task.toLat = task.lat;
        task.toLon = task.lon;
        this.target(task, 1);
        left -= count;
        want -= count;
      }
      if (left < rebalance.minPerSpot) break;
    }
  }

  /** Deployable stock of one type over every depot. */
  private deployableOf(type: number, time: number) {
    return this.depots.reduce((sum, depot) => sum + this.deployable(depot, type, time), 0);
  }

  /**
   * §9.7 seasonal reserve: the operator keeps a share of each type's fleet on the depot shelf
   * when the month's demand is low (winter lay-up and spares), so only ready stock above it is
   * deployed.
   */
  reserveOf(depot: Depot, type: number, time: number) {
    const share = ASSUMPTIONS.depot.reserveByMonth[monthAt(time) - 1];
    return Math.round(this.fleetOf(type) * share * depot.share);
  }

  private deployable(depot: Depot, type: number, time: number) {
    return Math.max(0, depot.readyOf[type] - this.reserveOf(depot, type, time));
  }

  /** §9.7 at 05:00: ready stock above the seasonal reserve goes to the 07–09 peak's short cells. */
  planMorning(time: number) {
    const morning = ASSUMPTIONS.morning;
    const midnight = midnightOfIndex(kstDateIndex(time));
    const forecastFrom = midnight + morning.forecastHours[0] * HOUR;
    const deadline = midnight + morning.endHour * HOUR;
    for (const type of this.types) {
      const targets = this.demandTargets(
        type,
        this.deployableOf(type, time),
        forecastFrom,
        morning.forecastHours[1] - morning.forecastHours[0],
      );
      for (const depot of this.depots)
        this.deployTasks(
          depot,
          type,
          this.deployable(depot, type, time),
          targets,
          50,
          deadline,
          time,
          true,
        );
    }
  }

  /**
   * Every 30 minutes: demand ranking, pre-emptive swaps, rebalancing and depot top-ups. Each
   * vehicle type is rebalanced toward its own share of the demand; vans are shared (§19).
   */
  rebalanceTick(time: number) {
    const e = this.e,
      rebalance = ASSUMPTIONS.rebalance;
    // Busiest 20% of cells for the next two hours.
    const expected = this.activeCells.map((cell) =>
      e.expectedRentals(cell, time, rebalance.horizonHours),
    );
    const sorted = [...expected].sort((a, b) => b - a);
    this.hotThreshold =
      sorted[Math.max(0, Math.floor(sorted.length * rebalance.preemptiveTopShare) - 1)] ?? Infinity;

    // Pre-emptive swaps of low packs where riders will be (§9.4 p5).
    for (let vehicle = 0; vehicle < e.fleet; vehicle++) {
      if (!e.rentable(vehicle) || this.fieldTask[vehicle] >= 0) continue;
      if (e.batteryNow(vehicle, time) >= e.spec(vehicle).battery.preemptiveSwapPercent) continue;
      if (!this.hot(e.lat[vehicle], e.lon[vehicle], time)) continue;
      const task = this.open(TASK.SWAP, 52, vehicle, e.lat[vehicle], e.lon[vehicle], time);
      this.fieldTask[vehicle] = task.id;
    }

    const hour = kstHour(time);
    // By day the next two hours set the targets; overnight, the coming morning peak does (§9.7).
    const overnight = !inHourBand(hour, rebalance.hours[0], rebalance.hours[1]);
    const morning =
      midnightOfIndex(kstDateIndex(time + 9 * HOUR)) + ASSUMPTIONS.morning.forecastHours[0] * HOUR;
    const morningHours =
      ASSUMPTIONS.morning.forecastHours[1] - ASSUMPTIONS.morning.forecastHours[0];
    // Each type's street fleet shared by the demand ahead (§21).
    const targetOf = (type: number) =>
      overnight
        ? this.demandTargets(type, 0, morning, morningHours)
        : this.demandTargets(type, 0, time, rebalance.targetHours);
    let openRebalances = 0;
    for (const id of this.pools[POOL.VAN])
      if (this.tasks[id].kind === TASK.REBALANCE) openRebalances++;
    const limit = this.vansOnShift() * rebalance.maxOpenPerVan;
    const deficits: [number, number, number][] = [],
      surpluses: [number, number][][] = TYPES.map(() => []);
    for (const type of this.types) {
      const target = targetOf(type);
      this.activeCells.forEach((cell, index) => {
        const available = this.availableOf(type, cell);
        const need = target[index] * rebalance.deficitFactor - available;
        // Overnight a quiet cell keeps nothing in reserve: its idle vehicles serve the morning.
        const spare =
          available -
          (target[index] * rebalance.surplusFactor + (overnight ? 0 : rebalance.surplusBase));
        const targeted = this.isTargeted(type, cell);
        if (need >= rebalance.minDeficit && this.canTarget(type, cell, target[index]))
          deficits.push([need, cell, type]);
        if (spare >= rebalance.minPerSpot && !targeted) surpluses[type].push([spare, cell]);
      });
    }
    deficits.sort((left, right) => right[0] - left[0] || left[1] - right[1] || left[2] - right[2]);
    for (const [need, cell, type] of deficits) {
      if (openRebalances >= limit) break;
      const [cellLat, cellLon] = e.cellCenter(cell);
      let best = -1,
        bestMeters: number = rebalance.maxPairMeters;
      surpluses[type].forEach(([spare, source], index) => {
        if (spare < rebalance.minPerSpot) return;
        const [lat, lon] = e.cellCenter(source);
        const meters = e.meters(cellLat, cellLon, lat, lon);
        if (meters < bestMeters) {
          best = index;
          bestMeters = meters;
        }
      });
      if (best < 0) continue;
      const [spare, source] = surpluses[type][best];
      const count = Math.min(
        rebalance.maxPerCell,
        Math.max(rebalance.minPerSpot, Math.ceil(need)),
        Math.floor(spare),
      );
      if (count < rebalance.minPerSpot) continue;
      surpluses[type][best][0] -= count;
      const [sourceLat, sourceLon] = e.cellCenter(source);
      const task = this.open(TASK.REBALANCE, 60, -1, sourceLat, sourceLon, time, Infinity, type);
      task.count = count;
      task.fromCell = source;
      task.toCell = cell;
      task.toLat = this.cellPoint[cell * 2];
      task.toLon = this.cellPoint[cell * 2 + 1];
      this.target(task, 1);
      openRebalances++;
    }

    // Daytime top-up from depot stock (§9.7), toward the same demand shares and, like the
    // morning deployment, before rebalancing: the shelf drains to its reserve by evening (§21).
    if (!overnight && inHourBand(hour, rebalance.topupHours[0], rebalance.topupHours[1]))
      for (const type of this.types) {
        const stock = this.deployableOf(type, time);
        if (stock <= this.fleetOf(type) * ASSUMPTIONS.depot.topupStockShare) continue;
        const targets = this.demandTargets(type, stock, time, rebalance.targetHours);
        for (const depot of this.depots)
          if (this.deployable(depot, type, time))
            this.deployTasks(
              depot,
              type,
              this.deployable(depot, type, time),
              targets,
              50,
              time + rebalance.horizonHours * HOUR,
              time,
              true,
            );
      }
  }

  /**
   * §9.4 p7 at 22:00: idle vehicles in quiet cells or parked 24 hours go in for the night, as
   * many as the night vans' places hold (an e-bike takes two, §19).
   */
  planOvernight(time: number) {
    const e = this.e,
      overnight = ASSUMPTIONS.overnight;
    let nightVans = 0;
    for (const crew of this.crews)
      if (crew.type === CREW.VAN && ASSUMPTIONS.shifts[crew.shift].name === 'night') nightVans++;
    const countLimit = Math.round(e.fleet * overnight.maxShare),
      unitLimit = nightVans * overnight.vehiclesPerVan * overnight.loadsPerVan;
    const quiet = new Map<number, boolean>();
    const candidates: number[] = [];
    // §22 the busiest cells by the night foot layer keep their vehicles out for the evening.
    const nightLayer = dayTypeAt(time) === 'weekday' ? FOOT_LAYER.WD_NIGHT : FOOT_LAYER.WE_NIGHT;
    const night = e.spatial.footTarget?.[nightLayer];
    let nightFloor = Infinity;
    if (night) {
      const values = this.activeCells.map((cell) => night[cell]).sort((a, b) => b - a);
      nightFloor =
        values[Math.max(0, Math.ceil(values.length * overnight.keepTopNightShare) - 1)] ?? Infinity;
    }
    for (let vehicle = 0; vehicle < e.fleet; vehicle++) {
      if (!e.rentable(vehicle) || this.fieldTask[vehicle] >= 0 || this.patrolTask[vehicle] >= 0)
        continue;
      const charge = e.batteryNow(vehicle, time) < overnight.chargeBelowPercent;
      // Long idle, due for routine maintenance (§9.8 preventive), or charged at the depot
      // overnight (§21).
      const long =
        e.segStartAt[vehicle] <= time - overnight.minParkedHours * HOUR ||
        e.km[vehicle] > ASSUMPTIONS.depot.preventiveKm ||
        charge;
      const cell = e.cellOf(e.lat[vehicle], e.lon[vehicle]);
      if (!charge && night && cell >= 0 && night[cell] >= nightFloor) continue;
      let isQuiet = false;
      if (cell >= 0) {
        if (!quiet.has(cell))
          quiet.set(cell, e.expectedRentals(cell, time, 9) < overnight.lowDemandPerHour * 9);
        isQuiet = quiet.get(cell)!;
      }
      if (long || isQuiet) candidates.push(vehicle);
    }
    // Packs to charge first, emptiest first; then the longest idle; routine maintenance fills
    // what is left.
    const charge = (vehicle: number) =>
      Math.min(e.batteryNow(vehicle, time), overnight.chargeBelowPercent);
    candidates.sort(
      (left, right) =>
        charge(left) - charge(right) || e.segStartAt[left] - e.segStartAt[right] || left - right,
    );
    let taken = 0,
      units = 0;
    for (const vehicle of candidates) {
      if (taken >= countLimit) break;
      const size = VAN_UNITS[e.vType[vehicle]];
      if (units + size > unitLimit) continue;
      taken++;
      units += size;
      // Night vans start the sweep; what they leave stays open for any van until it is done.
      const task = this.open(
        TASK.OVERNIGHT,
        overnight.priority,
        vehicle,
        e.lat[vehicle],
        e.lon[vehicle],
        time,
      );
      this.fieldTask[vehicle] = task.id;
    }
  }

  /** A towed vehicle reached its lot (§7.3). */
  impounded(vehicle: number, time: number) {
    this.lotCounts[this.e.lot[vehicle]]++;
    this.recordLots(time);
  }

  // ---- Records ----

  /** The first rows of the served day: every crew, depot, lot and the open task counts. */
  snapshot(time: number) {
    for (const crew of this.crews) this.recordCrew(crew, time);
    for (const depot of this.depots) this.recordDepot(depot, time);
    this.recordLots(time);
    this.countOpen(1, 0, time);
  }

  recordCrew(crew: Crew, time: number) {
    if (!this.e.recording) return;
    const task = crew.task >= 0 ? this.tasks[crew.task] : null;
    const last = this.cT.length - 1;
    // Collapse rows written at the same instant for the same crew.
    if (last >= 0 && this.cT.data[last] === time && this.cCrew.data[last] === crew.index) {
      this.cT.length--;
      this.cCrew.length--;
      this.cState.length--;
      this.cLat.length--;
      this.cLon.length--;
      this.cDestLat.length--;
      this.cDestLon.length--;
      this.cEta.length--;
      this.cTask.length--;
      this.cLoad.length--;
      this.cLoadB.length--;
      this.cVehicles.length--;
      this.cVehicleCount.length--;
    }
    this.cT.push(time);
    this.cCrew.push(crew.index);
    this.cState.push(crew.state);
    this.cLat.push(crew.lat);
    this.cLon.push(crew.lon);
    this.cDestLat.push(crew.destLat);
    this.cDestLon.push(crew.destLon);
    this.cEta.push(
      crew.state === CREW_STATE.TRAVELLING || crew.state === CREW_STATE.RETURNING ? crew.eta : 0,
    );
    this.cTask.push(task ? task.kind * 100 + Math.floor(task.priority / 10) : -1);
    if (crew.type === CREW.SWAP) {
      let charged = 0,
        depleted = 0;
      for (const type of TYPES) {
        charged += crew.charged[type].length;
        depleted += crew.depleted[type].length;
      }
      this.cLoad.push(charged * 100 + depleted);
      this.cLoadB.push(crew.charged[VTYPE.EBIKE].length * 100 + crew.depleted[VTYPE.EBIKE].length);
    } else {
      this.cLoad.push(crew.load.length);
      let ebikes = 0;
      for (const vehicle of crew.load) if (this.e.vType[vehicle] === VTYPE.EBIKE) ebikes++;
      this.cLoadB.push(ebikes);
    }
    const vehicles = task && task.vehicle >= 0 ? [task.vehicle] : crew.load;
    this.cVehicles.push(this.vehiclePool.length);
    this.cVehicleCount.push(vehicles.length);
    for (const vehicle of vehicles) this.vehiclePool.push(vehicle);
  }

  recordDepot(depot: Depot, time: number) {
    if (!this.e.recording) return;
    this.dT.push(time);
    this.dValues.push(depot.index);
    let charged = 0,
      charging = 0,
      waiting = 0;
    for (const pool of depot.pools) {
      charged += this.chargedCount(pool);
      charging += pool.chargingBatteries;
      waiting += pool.waitingBatteries.length;
    }
    this.dValues.push(depot.ready.length);
    this.dValues.push(depot.chargingVehicles);
    this.dValues.push(depot.repairVehicles);
    this.dValues.push(charged);
    this.dValues.push(charging);
    this.dValues.push(waiting);
    this.dValues.push(depot.inspecting);
    for (const type of TYPES) {
      const pool = depot.pools[type];
      this.dTypeValues.push(depot.readyOf[type]);
      this.dTypeValues.push(depot.chargingOf[type]);
      this.dTypeValues.push(depot.repairOf[type]);
      this.dTypeValues.push(this.chargedCount(pool));
      this.dTypeValues.push(pool.chargingBatteries);
      this.dTypeValues.push(pool.waitingBatteries.length);
      this.dTypeValues.push(depot.inspectingOf[type]);
    }
  }

  recordLots(time: number) {
    if (!this.e.recording) return;
    this.lT.push(time);
    for (let lot = 0; lot < this.lotCounts.length; lot++) this.lValues.push(this.lotCounts[lot]);
  }
}

const FAULT_KEYS = [
  'tyre',
  'unlock-iot',
  'brake',
  'tyre',
  'throttle-motor',
  'display-qr',
  'battery-bms',
  'frame',
  'chain-drivetrain',
  'pedal-crank',
  'saddle-seatpost',
  'motor-sensor',
] as const;

/** Repair numbers of a fault on the vehicle's type (e-bike faults have their own table). */
const repairOf = (e: Engine, vehicle: number, fault: number) =>
  e.spec(vehicle).repair[FAULT_KEYS[fault]] ?? ASSUMPTIONS.repair.tyre;
