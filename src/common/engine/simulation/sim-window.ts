import { ASSUMPTIONS, VEHICLE_TYPES } from './assumptions.js';
import {
  DAY,
  HOUR,
  MINUTE,
  dayTypeAt,
  isWinter,
  kstDateIndex,
  kstHour,
  midnightOfIndex,
  monthAt,
  type DayType,
} from './calendar.js';
import type { Demand } from './demand.js';
import {
  eventId,
  formatEvent,
  parseEventId,
  vehicleIdOf,
  type EventColumns,
  type SimulationEvent,
} from './event-log.js';
import { keyOf, hashText, PURPOSE, Stream } from './keyed-random.js';
import {
  accumulate,
  accumulateTyped,
  C,
  COUNTERS,
  operatorNet,
  TYPED_COUNTERS,
  X,
} from './ledger.js';
import { DEPOT_TYPE_WIDTH } from './operations.js';
import {
  COS_LATITUDE,
  METERS_PER_DEGREE,
  metersApart,
  type GeometryMeta,
  type ParkingRules,
} from './parking-rules.js';
import {
  CATEGORY,
  CATEGORY_NAMES,
  CREW_STATES,
  CREW_TYPES,
  EVENT_TYPES,
  FAULT_NAMES,
  FIELD,
  FINE_KINDS,
  FLAG,
  LOST_REASONS,
  OP,
  OP_NAMES,
  SCOOTER_FAULT_CODES,
  STAGE,
  STAGE_NAMES,
  TASK_KINDS,
  VEHICLE_TYPE_NAMES,
  WANTED,
  type CategoryName,
  type EventTypeName,
  type OpStateName,
  type VehicleTypeName,
} from './sim-codes.js';
import { Engine, fleetsOf, GRID_BOUNDS, seedTextOf, type Fleets } from './sim-engine.js';

export const SIMULATION_NOTICE = '시연용 가상 데이터';

export interface WindowRequest {
  date: string;
  startsAt: number;
  endsAt: number;
  seed: string;
  /** Total vehicles. */
  fleet: number;
  /** Per type; omitted means all scooters. */
  fleets?: Fleets;
  modelVersion: string;
}

export interface WindowMeta {
  date: string;
  startsAt: number;
  endsAt: number;
  warmupFrom: number;
  dayType: DayType;
  fleet: number;
  seed: string;
  modelVersion: string;
  geometry: GeometryMeta;
  crews: { id: string; type: number; depot: number; shift: number }[];
  depots: {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    capacity: number;
    chargerSlots: number;
    spares: number;
    mechanicsWeekday: number;
    mechanicsWeekend: number;
  }[];
  queueEvents: number;
  fleets: Fleets;
}

/** A computed window as transferable columns (§12 storage). */
export interface WindowData {
  meta: WindowMeta;
  vStart: Int32Array;
  iT: Float64Array;
  iOp: Uint8Array;
  iLat: Float64Array;
  iLon: Float64Array;
  iBattery: Float64Array;
  /** category | stage << 8 | visible flags << 12. */
  iMeta: Int32Array;
  events: EventColumns;
  checkpointEvent: Int32Array;
  checkpoints: Float64Array;
  cStart: Int32Array;
  cT: Float64Array;
  cState: Uint8Array;
  cLat: Float64Array;
  cLon: Float64Array;
  cDestLat: Float64Array;
  cDestLon: Float64Array;
  cEta: Float64Array;
  cTask: Int32Array;
  cLoad: Int32Array;
  cVehicles: Int32Array;
  cVehicleCount: Int32Array;
  vehiclePool: Int32Array;
  dT: Float64Array;
  dValues: Int32Array;
  lT: Float64Array;
  lValues: Int32Array;
  oT: Float64Array;
  oValues: Int32Array;
  /** Vehicle type per vehicle (VTYPE). */
  vType: Uint8Array;
  /**
   * Counter checkpoints per group (§19): one `TYPED_COUNTERS`-wide row per vehicle type and a last
   * one for events of no single type, at every checkpoint. Groups add up to `checkpoints`.
   */
  typedCheckpoints: Float64Array;
  /** The e-bike part of `cLoad`. */
  cLoadB: Int32Array;
  /** Per `dT` row: DEPOT_TYPE_WIDTH values per vehicle type. */
  dTypeValues: Int32Array;
}

/** Every typed column of `WindowData`, in a fixed order; transfer and the window store read this list. */
export const WINDOW_COLUMNS: readonly string[] = [
  'vStart',
  'iT',
  'iOp',
  'iLat',
  'iLon',
  'iBattery',
  'iMeta',
  'events.t',
  'events.type',
  'events.vehicle',
  'events.crew',
  'events.lat',
  'events.lon',
  'events.amount',
  'events.detail',
  'checkpointEvent',
  'checkpoints',
  'cStart',
  'cT',
  'cState',
  'cLat',
  'cLon',
  'cDestLat',
  'cDestLon',
  'cEta',
  'cTask',
  'cLoad',
  'cVehicles',
  'cVehicleCount',
  'vehiclePool',
  'dT',
  'dValues',
  'lT',
  'lValues',
  'oT',
  'oValues',
  'vType',
  'typedCheckpoints',
  'cLoadB',
  'dTypeValues',
];

/** One column of a window by its `WINDOW_COLUMNS` path. */
export function windowColumn(data: WindowData, path: string): ArrayBufferView {
  let value: unknown = data;
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key];
  return value as ArrayBufferView;
}

/** Every buffer of a window, for a zero-copy transfer out of the worker. */
export function windowBuffers(data: WindowData): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const path of WINDOW_COLUMNS) buffers.add(windowColumn(data, path).buffer as ArrayBuffer);
  return [...buffers];
}

/** Vehicles per type name, for the types the fleets have (§19). */
export function fleetByTypeOf(fleets: Fleets): Partial<Record<VehicleTypeName, number>> {
  return Object.fromEntries(
    [fleets.scooter, fleets.ebike].flatMap((count, type) =>
      count > 0 ? [[VEHICLE_TYPE_NAMES[type], count]] : [],
    ),
  );
}

/** Counter groups of `typedCheckpoints`: each vehicle type, then events of no single type. */
export const COUNTER_GROUPS = VEHICLE_TYPES.length + 1;
const SHARED_GROUP = VEHICLE_TYPES.length;

/**
 * The counter group of an event: its vehicle's type; for lost demand the one type the rider
 * wanted (in a one-type fleet, that type); anything else is shared.
 */
function groupOf(
  vType: ArrayLike<number>,
  fleets: Fleets,
  type: number,
  vehicle: number,
  d2: number,
): number {
  if (vehicle >= 0) return vType[vehicle];
  if (type !== EV_LOST) return SHARED_GROUP;
  if (d2 === WANTED.SCOOTER) return VTYPE_SCOOTER;
  if (d2 === WANTED.EBIKE) return VTYPE_EBIKE;
  if (d2 === 0 && !(fleets.scooter > 0 && fleets.ebike > 0))
    return fleets.ebike > 0 ? VTYPE_EBIKE : VTYPE_SCOOTER;
  return SHARED_GROUP;
}
const EV_LOST = EVENT_TYPES.indexOf('lost-demand'),
  VTYPE_SCOOTER = 0,
  VTYPE_EBIKE = 1;

/**
 * Simulates one window and keeps what the served day needs (§11.2): vehicle intervals from the
 * state at the day's start, events inside the day, and crew, depot and task series. A pure
 * function of the request and the bundled tables.
 */
export function buildWindowSync(
  request: WindowRequest,
  demand: Demand,
  rules: ParkingRules,
): WindowData {
  const engine = new Engine({
    demand,
    rules,
    seed: request.seed,
    fleet: request.fleet,
    fleets: request.fleets,
    startsAt: request.startsAt,
    endsAt: request.endsAt,
    date: request.date,
  });
  engine.run();
  return compactWindow(engine, request, rules);
}

/** Keeps from a finished engine what the served day needs, as transferable columns. */
export function compactWindow(
  engine: Engine,
  request: WindowRequest,
  rules: ParkingRules,
): WindowData {
  const { startsAt, endsAt } = request;
  const fleets = fleetsOf(request);
  const fleet = request.fleet;

  // Vehicle intervals as CSR, from the state at the service-day start.
  const total = engine.iT.length;
  const perVehicle = new Int32Array(fleet + 1);
  for (let index = 0; index < total; index++) perVehicle[engine.iVehicle.data[index] + 1]++;
  for (let vehicle = 0; vehicle < fleet; vehicle++) perVehicle[vehicle + 1] += perVehicle[vehicle];
  const order = new Int32Array(total);
  const cursor = perVehicle.slice(0, fleet);
  for (let index = 0; index < total; index++) order[cursor[engine.iVehicle.data[index]]++] = index;
  const vStart = new Int32Array(fleet + 1);
  const keep: number[] = [];
  for (let vehicle = 0; vehicle < fleet; vehicle++) {
    let first = perVehicle[vehicle];
    for (let slot = perVehicle[vehicle]; slot < perVehicle[vehicle + 1]; slot++)
      if (engine.iT.data[order[slot]] <= startsAt) first = slot;
    for (let slot = first; slot < perVehicle[vehicle + 1]; slot++) keep.push(order[slot]);
    vStart[vehicle + 1] = keep.length;
  }
  const iT = new Float64Array(keep.length),
    iOp = new Uint8Array(keep.length),
    iLat = new Float64Array(keep.length),
    iLon = new Float64Array(keep.length),
    iBattery = new Float64Array(keep.length),
    iMeta = new Int32Array(keep.length);
  keep.forEach((index, slot) => {
    iT[slot] = engine.iT.data[index];
    iOp[slot] = engine.iOp.data[index];
    iLat[slot] = engine.iLat.data[index];
    iLon[slot] = engine.iLon.data[index];
    iBattery[slot] = engine.iBattery.data[index];
    const meta = engine.iMeta.data[index];
    iMeta[slot] =
      ((meta >> 8) & 0xff) | (((meta >> 16) & 0xf) << 8) | (((meta >> 20) & 0xfff) << 12);
  });

  // Events inside the served day, in (time, write order) — fines are written ahead of time.
  const eventCount = engine.eT.length;
  const kept: number[] = [];
  for (let index = 0; index < eventCount; index++) {
    const time = engine.eT.data[index];
    if (time >= startsAt && time < endsAt) kept.push(index);
  }
  kept.sort((left, right) => engine.eT.data[left] - engine.eT.data[right] || left - right);
  const events: EventColumns = {
    t: new Float64Array(kept.length),
    type: new Uint8Array(kept.length),
    vehicle: new Int32Array(kept.length),
    crew: new Int32Array(kept.length),
    lat: new Float64Array(kept.length),
    lon: new Float64Array(kept.length),
    amount: new Int32Array(kept.length),
    detail: new Int32Array(kept.length * 4),
  };
  kept.forEach((index, slot) => {
    events.t[slot] = engine.eT.data[index];
    events.type[slot] = engine.eType.data[index];
    events.vehicle[slot] = engine.eVehicle.data[index];
    events.crew[slot] = engine.eCrew.data[index];
    events.lat[slot] = engine.eLat.data[index];
    events.lon[slot] = engine.eLon.data[index];
    events.amount[slot] = engine.eAmount.data[index];
    events.detail[slot * 4] = engine.eD0.data[index];
    events.detail[slot * 4 + 1] = engine.eD1.data[index];
    events.detail[slot * 4 + 2] = engine.eD2.data[index];
    events.detail[slot * 4 + 3] = engine.eD3.data[index];
  });

  // Counter checkpoints every five minutes (§12: today's counters in one short scan).
  const step = ASSUMPTIONS.clock.checkpointMinutes * MINUTE;
  const checkpointCount = Math.ceil((endsAt - startsAt) / step) + 1;
  const checkpoints = new Float64Array(checkpointCount * COUNTERS);
  const checkpointEvent = new Int32Array(checkpointCount);
  const running = new Float64Array(COUNTERS);
  const typedWidth = COUNTER_GROUPS * TYPED_COUNTERS;
  const typedCheckpoints = new Float64Array(checkpointCount * typedWidth);
  const typedRunning = new Float64Array(typedWidth);
  const vType = engine.vType.slice();
  let next = 0;
  const discount = ASSUMPTIONS.money.designatedDiscountWon;
  for (let checkpoint = 0; checkpoint < checkpointCount; checkpoint++) {
    const until = startsAt + checkpoint * step;
    while (next < kept.length && events.t[next] < until) {
      const base = next * 4;
      const type = events.type[next],
        amount = events.amount[next];
      const d0 = events.detail[base],
        d1 = events.detail[base + 1],
        d2 = events.detail[base + 2],
        d3 = events.detail[base + 3];
      accumulate(running, 0, type, amount, d0, d1, d2, d3, discount);
      const group = groupOf(vType, fleets, type, events.vehicle[next], d2);
      accumulateTyped(typedRunning, group * TYPED_COUNTERS, type, amount, d0, d1, d2, d3, discount);
      next++;
    }
    checkpointEvent[checkpoint] = next;
    checkpoints.set(running, checkpoint * COUNTERS);
    typedCheckpoints.set(typedRunning, checkpoint * typedWidth);
  }

  // Crew rows as CSR, from each crew's state at the day start.
  const ops = engine.ops;
  const crews = ops.crews.length;
  const crewRows = ops.cT.length;
  const perCrew = new Int32Array(crews + 1);
  for (let row = 0; row < crewRows; row++) perCrew[ops.cCrew.data[row] + 1]++;
  for (let crew = 0; crew < crews; crew++) perCrew[crew + 1] += perCrew[crew];
  const crewOrder = new Int32Array(crewRows);
  const crewCursor = perCrew.slice(0, crews);
  for (let row = 0; row < crewRows; row++) crewOrder[crewCursor[ops.cCrew.data[row]]++] = row;
  const cStart = new Int32Array(crews + 1);
  const crewKeep: number[] = [];
  for (let crew = 0; crew < crews; crew++) {
    let first = perCrew[crew + 1];
    for (let slot = perCrew[crew]; slot < perCrew[crew + 1]; slot++)
      if (ops.cT.data[crewOrder[slot]] <= startsAt) first = slot;
    if (first === perCrew[crew + 1]) first = perCrew[crew];
    for (let slot = first; slot < perCrew[crew + 1]; slot++) crewKeep.push(crewOrder[slot]);
    cStart[crew + 1] = crewKeep.length;
  }
  const pick = <T extends Float64Array | Int32Array | Uint8Array>(
    make: new (length: number) => T,
    source: ArrayLike<number>,
  ) => {
    const out = new make(crewKeep.length);
    crewKeep.forEach((row, slot) => (out[slot] = source[row]));
    return out;
  };
  const cVehicleCount = pick(Int32Array, ops.cVehicleCount.data);
  const cVehicles = new Int32Array(crewKeep.length);
  const pool: number[] = [];
  crewKeep.forEach((row, slot) => {
    cVehicles[slot] = pool.length;
    const from = ops.cVehicles.data[row];
    for (let index = 0; index < ops.cVehicleCount.data[row]; index++)
      pool.push(ops.vehiclePool.data[from + index]);
  });

  // Depot, lot and task series from the last row at or before the day start.
  const series = (
    times: { data: Float64Array; length: number },
    values: { data: Int32Array },
    width: number,
    key?: (row: number) => number,
    /** Values kept per the same rows, `extraWidth` per row. */
    extra?: { data: Int32Array },
    extraWidth = 0,
  ) => {
    const rows: number[] = [];
    const lastBefore = new Map<number, number>();
    for (let row = 0; row < times.length; row++) {
      const group = key ? key(row) : 0;
      if (times.data[row] <= startsAt) lastBefore.set(group, row);
      else rows.push(row);
    }
    const all = [...lastBefore.values(), ...rows].sort(
      (a, b) => times.data[a] - times.data[b] || a - b,
    );
    const t = new Float64Array(all.length),
      v = new Int32Array(all.length * width),
      x = new Int32Array(all.length * extraWidth);
    all.forEach((row, slot) => {
      t[slot] = times.data[row];
      for (let index = 0; index < width; index++)
        v[slot * width + index] = values.data[row * width + index];
      for (let index = 0; index < extraWidth; index++)
        x[slot * extraWidth + index] = extra!.data[row * extraWidth + index];
    });
    return [t, v, x] as const;
  };
  const [dT, dValues, dTypeValues] = series(
    ops.dT,
    ops.dValues,
    8,
    (row) => ops.dValues.data[row * 8],
    ops.dTypeValues,
    DEPOT_TYPE_WIDTH * VEHICLE_TYPES.length,
  );
  const [lT, lValues] = series(ops.lT, ops.lValues, ASSUMPTIONS.lots.length);
  const [oT, oValues] = series(ops.oT, ops.oValues, 7);

  return {
    meta: {
      date: request.date,
      startsAt,
      endsAt,
      warmupFrom: engine.warmupFrom,
      dayType: dayTypeAt(startsAt),
      fleet,
      seed: request.seed,
      modelVersion: request.modelVersion,
      geometry: rules.meta,
      crews: ops.crews.map((crew) => ({
        id: crew.id,
        type: crew.type,
        depot: crew.depot,
        shift: crew.shift,
      })),
      depots: ops.depots.map((depot) => ({
        id: depot.id,
        name: depot.name,
        latitude: depot.lat,
        longitude: depot.lon,
        capacity: depot.capacity,
        chargerSlots: depot.slots,
        spares: depot.spares,
        mechanicsWeekday: depot.mechanicsWeekday,
        mechanicsWeekend: depot.mechanicsWeekend,
      })),
      queueEvents: engine.queueEvents,
      fleets,
    },
    vStart,
    iT,
    iOp,
    iLat,
    iLon,
    iBattery,
    iMeta,
    events,
    checkpointEvent,
    checkpoints,
    cStart,
    cT: pick(Float64Array, ops.cT.data),
    cState: pick(Uint8Array, ops.cState.data),
    cLat: pick(Float64Array, ops.cLat.data),
    cLon: pick(Float64Array, ops.cLon.data),
    cDestLat: pick(Float64Array, ops.cDestLat.data),
    cDestLon: pick(Float64Array, ops.cDestLon.data),
    cEta: pick(Float64Array, ops.cEta.data),
    cTask: pick(Int32Array, ops.cTask.data),
    cLoad: pick(Int32Array, ops.cLoad.data),
    cVehicles,
    cVehicleCount,
    vehiclePool: Int32Array.from(pool),
    dT,
    dValues,
    lT,
    lValues,
    oT,
    oValues,
    vType,
    typedCheckpoints,
    cLoadB: pick(Int32Array, ops.cLoadB.data),
    dTypeValues,
  };
}

/** A vehicle as the simulator reports it. */
export interface SimulatedVehicle {
  id: string;
  type: VehicleTypeName;
  latitude: number;
  longitude: number;
  /** Whole percent. */
  battery: number;
  state: OpStateName;
  /** Rentable: available and not hidden (§3.2). */
  rentable: boolean;
  /** On the street: has a parking category and complaint stage. */
  field: boolean;
  hidden: boolean;
  fallen: boolean;
  parking: CategoryName | null;
  complaint: (typeof STAGE_NAMES)[number] | null;
  rangeMeters: number;
}

export interface EventQuery {
  since?: number;
  cursor?: string;
  limit: number;
  types?: readonly EventTypeName[];
  /**
   * Vehicle types (§19): events of these types' vehicles, and lost demand of riders who wanted
   * one of them. Events with no vehicle are left out.
   */
  vehicleTypes?: readonly VehicleTypeName[];
  latitude?: number;
  longitude?: number;
  radius?: number;
}

/** Inspection budget of one events read (§15.2). */
export const EVENT_SCAN_LIMIT = 50_000;

const depotKey = [
  'ready',
  'charging',
  'repair',
  'chargedBatteries',
  'chargingBatteries',
  'waitingBatteries',
  'inspecting',
] as const;
/** The order of one type's values in a `dTypeValues` row. */
const depotTypeKey = [
  'ready',
  'charging',
  'repair',
  'chargedBatteries',
  'chargingBatteries',
  'waitingBatteries',
  'inspecting',
] as const satisfies readonly (typeof depotKey)[number][];
const VAN_UNITS = VEHICLE_TYPES.map((spec) => spec.ops.vanUnits);
const BATTERY_UNITS = VEHICLE_TYPES.map((spec) => spec.ops.batteryUnits);
/** Fault codes of each type's fault table, in code order. */
const FAULT_CODES_OF = VEHICLE_TYPES.map((spec) =>
  FAULT_NAMES.map((name, code) => [name, code] as const).filter(
    ([name, code]) => code > 0 && spec.faults.types.some((fault) => fault.code === name),
  ),
);

/** Read-only queries on a computed window: every answer is cut at the asked time (§15). */
/** Cell size of the window's position index for `nearby` (§12); a tuning constant. */
export const NEARBY_CELL_METERS = 300;
const NEARBY_CELL_LATITUDE = NEARBY_CELL_METERS / METERS_PER_DEGREE,
  NEARBY_CELL_LONGITUDE = NEARBY_CELL_METERS / (METERS_PER_DEGREE * COS_LATITUDE),
  NEARBY_ROWS = Math.ceil((GRID_BOUNDS.north - GRID_BOUNDS.south) / NEARBY_CELL_LATITUDE),
  NEARBY_COLS = Math.ceil((GRID_BOUNDS.east - GRID_BOUNDS.west) / NEARBY_CELL_LONGITUDE);

/**
 * Every cell any interval of a vehicle lies in, once per vehicle (CSR lists), and the vehicles
 * with a position off the grid or no interval, which every search checks.
 */
interface PositionIndex {
  start: Int32Array;
  vehicles: Int32Array;
  outside: Int32Array;
  /** Per vehicle: the search that last checked it. */
  stamp: Int32Array;
  search: number;
}

export class SimWindow {
  readonly meta: WindowMeta;
  private readonly crewNames: string[];
  private readonly depotNames: string[];
  private readonly lotNames: string[];
  private readonly jitterSeed: number;
  /** Vehicle types this window has, in VTYPE order. */
  readonly types: number[];

  constructor(readonly data: WindowData) {
    this.meta = data.meta;
    this.types = [data.meta.fleets.scooter, data.meta.fleets.ebike].flatMap((count, type) =>
      count > 0 ? [type] : [],
    );
    this.crewNames = data.meta.crews.map((crew) => crew.id);
    this.depotNames = data.meta.depots.map((depot) => depot.id);
    this.lotNames = ASSUMPTIONS.lots.map((lot) => lot.id);
    this.jitterSeed = hashText(seedTextOf(data.meta.seed, data.meta.fleets));
  }

  get fleet() {
    return this.meta.fleet;
  }

  covers(time: number) {
    return time >= this.meta.startsAt && time < this.meta.endsAt;
  }

  /** The vehicle's interval at `time`: the last one starting at or before it. */
  interval(vehicle: number, time: number): number {
    const data = this.data;
    let low = data.vStart[vehicle],
      high = data.vStart[vehicle + 1];
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (data.iT[middle] <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1 >= data.vStart[vehicle] ? low - 1 : data.vStart[vehicle];
  }

  /** The vehicle's type code (VTYPE). */
  vType(vehicle: number) {
    return this.data.vType[vehicle];
  }

  /**
   * Battery in percent at `time` within interval `slot`; field and missing vehicles drain at
   * their type's rate (`type` defaults to scooter).
   */
  batteryAt(slot: number, time: number, type = 0): number {
    const data = this.data;
    const op = data.iOp[slot];
    const base = data.iBattery[slot];
    if (!(FIELD[op] || op === OP.MISSING) || time <= data.iT[slot]) return base;
    const battery = VEHICLE_TYPES[type].battery;
    const drain =
      (battery.idlePercentPerDay * (isWinter(data.iT[slot]) ? battery.winterIdleFactor : 1)) / DAY;
    return Math.max(0, base - drain * (time - data.iT[slot]));
  }

  rangeMeters(percent: number, time: number, type = 0) {
    const battery = VEHICLE_TYPES[type].battery;
    return Math.round(
      (percent * battery.metersPerPercent) / (isWinter(time) ? battery.winterRideFactor : 1),
    );
  }

  op(vehicle: number, time: number) {
    return this.data.iOp[this.interval(vehicle, time)];
  }

  rentableAt(vehicle: number, time: number) {
    const slot = this.interval(vehicle, time);
    return this.data.iOp[slot] === OP.AVAILABLE && !((this.data.iMeta[slot] >> 12) & FLAG.HIDDEN);
  }

  vehicle(vehicle: number, time: number): SimulatedVehicle {
    const data = this.data,
      slot = this.interval(vehicle, time);
    const op = data.iOp[slot];
    const meta = data.iMeta[slot];
    const flags = meta >> 12;
    const field = FIELD[op] === 1;
    const type = data.vType[vehicle];
    const battery = this.batteryAt(slot, time, type);
    const category = meta & 0xff;
    return {
      id: vehicleIdOf(vehicle, this.meta.fleets.scooter),
      type: VEHICLE_TYPE_NAMES[type],
      latitude: data.iLat[slot],
      longitude: data.iLon[slot],
      battery: Math.floor(battery),
      state: OP_NAMES[op],
      rentable: op === OP.AVAILABLE && !(flags & FLAG.HIDDEN),
      field,
      hidden: (flags & FLAG.HIDDEN) !== 0,
      fallen: (flags & FLAG.FALLEN) !== 0,
      parking: field && category !== CATEGORY.NONE ? CATEGORY_NAMES[category] : null,
      complaint: field ? STAGE_NAMES[(meta >> 8) & 0xf] : null,
      rangeMeters: this.rangeMeters(battery, time, type),
    };
  }

  /**
   * §15.5 when a vehicle rentable at `time` stops being rentable on that spot: a reservation or
   * rental, a crew or tow truck taking it, a fault, theft, a GPS loss, hiding, the battery
   * threshold, or the window's end. In-place changes (complaints, falls, swaps) do not count.
   */
  parkedUntil(vehicle: number, time: number): number {
    const data = this.data;
    const slot = this.interval(vehicle, time);
    const end = data.vStart[vehicle + 1];
    const lat = data.iLat[slot],
      lon = data.iLon[slot];
    for (let next = slot + 1; next < end; next++) {
      if (data.iT[next] <= time) continue;
      if (
        data.iOp[next] !== OP.AVAILABLE ||
        (data.iMeta[next] >> 12) & FLAG.HIDDEN ||
        data.iLat[next] !== lat ||
        data.iLon[next] !== lon
      )
        return data.iT[next];
    }
    return this.meta.endsAt;
  }

  /**
   * Vehicles within `radius` of a point, nearest first; rentable only unless `field`. A search
   * reads only the vehicles the position index puts in reach; `scan` checks every vehicle, with
   * the same result (tests and wide areas). `perType` keeps the nearest that many of each type,
   * exactly what filtering the full list would keep, without building the rest. `totals`, when
   * given, receives how many of each type (VTYPE index) are in reach before that cut.
   */
  nearby(
    point: { latitude: number; longitude: number },
    radiusMeters: number,
    time: number,
    which: 'rentable' | 'field' = 'rentable',
    options: { scan?: boolean; perType?: number; totals?: number[] } = {},
  ): (SimulatedVehicle & { distanceMeters: number })[] {
    const scan = options.scan ?? false;
    const found: [number, number][] = [];
    const latitudeSpan = radiusMeters / 111_195 + 1e-6,
      longitudeSpan = radiusMeters / (METERS_PER_DEGREE * COS_LATITUDE) + 1e-6;
    const rowOf = (latitude: number) =>
        Math.floor((latitude - GRID_BOUNDS.south) / NEARBY_CELL_LATITUDE),
      colOf = (longitude: number) =>
        Math.floor((longitude - GRID_BOUNDS.west) / NEARBY_CELL_LONGITUDE);
    const firstRow = Math.max(0, rowOf(point.latitude - latitudeSpan)),
      lastRow = Math.min(NEARBY_ROWS - 1, rowOf(point.latitude + latitudeSpan)),
      firstCol = Math.max(0, colOf(point.longitude - longitudeSpan)),
      lastCol = Math.min(NEARBY_COLS - 1, colOf(point.longitude + longitudeSpan));
    const cells = Math.max(0, lastRow - firstRow + 1) * Math.max(0, lastCol - firstCol + 1);
    if (scan || cells * 4 > NEARBY_ROWS * NEARBY_COLS) {
      for (let vehicle = 0; vehicle < this.fleet; vehicle++)
        this.consider(vehicle, point, radiusMeters, latitudeSpan, time, which, found);
    } else {
      const index = this.positionIndex();
      const search = ++index.search;
      for (const vehicle of index.outside)
        this.consider(vehicle, point, radiusMeters, latitudeSpan, time, which, found);
      for (let row = firstRow; row <= lastRow; row++)
        for (let col = firstCol; col <= lastCol; col++) {
          const cell = row * NEARBY_COLS + col;
          for (let item = index.start[cell]; item < index.start[cell + 1]; item++) {
            const vehicle = index.vehicles[item];
            if (index.stamp[vehicle] === search) continue;
            index.stamp[vehicle] = search;
            this.consider(vehicle, point, radiusMeters, latitudeSpan, time, which, found);
          }
        }
    }
    found.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const totals = options.totals;
    if (totals) {
      totals.length = VEHICLE_TYPES.length;
      totals.fill(0);
      for (const item of found) totals[this.data.vType[item[1]]]++;
    }
    const perType = options.perType;
    if (perType !== undefined) {
      const kept = VEHICLE_TYPES.map(() => 0);
      let length = 0;
      for (const item of found)
        if (kept[this.data.vType[item[1]]]++ < perType) found[length++] = item;
      found.length = length;
    }
    return found.map(([distanceMeters, vehicle]) => {
      const near = this.vehicle(vehicle, time) as SimulatedVehicle & { distanceMeters: number };
      near.distanceMeters = distanceMeters;
      return near;
    });
  }

  private consider(
    vehicle: number,
    point: { latitude: number; longitude: number },
    radiusMeters: number,
    latitudeSpan: number,
    time: number,
    which: 'rentable' | 'field',
    found: [number, number][],
  ) {
    const data = this.data;
    const slot = this.interval(vehicle, time);
    const op = data.iOp[slot];
    const flags = data.iMeta[slot] >> 12;
    if (
      which === 'rentable'
        ? op !== OP.AVAILABLE || flags & FLAG.HIDDEN
        : !FIELD[op] || (op === OP.AVAILABLE && flags & FLAG.HIDDEN)
    )
      return;
    if (Math.abs(data.iLat[slot] - point.latitude) > latitudeSpan) return;
    const meters = metersApart(point.latitude, point.longitude, data.iLat[slot], data.iLon[slot]);
    if (meters <= radiusMeters) found.push([meters, vehicle]);
  }

  private index: PositionIndex | null = null;

  /** Builds the position index on the first search (§12): one pass over the intervals. */
  private positionIndex(): PositionIndex {
    if (this.index) return this.index;
    const data = this.data,
      fleet = this.fleet,
      cellCount = NEARBY_ROWS * NEARBY_COLS;
    const cellOf = (slot: number) => {
      const row = Math.floor((data.iLat[slot] - GRID_BOUNDS.south) / NEARBY_CELL_LATITUDE),
        col = Math.floor((data.iLon[slot] - GRID_BOUNDS.west) / NEARBY_CELL_LONGITUDE);
      return row >= 0 && col >= 0 && row < NEARBY_ROWS && col < NEARBY_COLS
        ? row * NEARBY_COLS + col
        : -1;
    };
    const start = new Int32Array(cellCount + 1),
      marked = new Int32Array(cellCount).fill(-1);
    const outside: number[] = [];
    for (let vehicle = 0; vehicle < fleet; vehicle++) {
      let off = data.vStart[vehicle] === data.vStart[vehicle + 1];
      for (let slot = data.vStart[vehicle]; slot < data.vStart[vehicle + 1]; slot++) {
        const cell = cellOf(slot);
        if (cell < 0) off = true;
        else if (marked[cell] !== vehicle) {
          marked[cell] = vehicle;
          start[cell + 1]++;
        }
      }
      if (off) outside.push(vehicle);
    }
    for (let cell = 0; cell < cellCount; cell++) start[cell + 1] += start[cell];
    const vehicles = new Int32Array(start[cellCount]),
      fill = start.slice(0, cellCount);
    marked.fill(-1);
    for (let vehicle = 0; vehicle < fleet; vehicle++)
      for (let slot = data.vStart[vehicle]; slot < data.vStart[vehicle + 1]; slot++) {
        const cell = cellOf(slot);
        if (cell < 0 || marked[cell] === vehicle) continue;
        marked[cell] = vehicle;
        vehicles[fill[cell]++] = vehicle;
      }
    this.index = {
      start,
      vehicles,
      outside: Int32Array.from(outside),
      stamp: new Int32Array(fleet),
      search: 0,
    };
    return this.index;
  }

  /** Field vehicles a GBFS feed lists: GPS-lost, riding, depot and lot vehicles are left out. */
  fieldVehicles(time: number): SimulatedVehicle[] {
    const result: SimulatedVehicle[] = [];
    for (let vehicle = 0; vehicle < this.fleet; vehicle++) {
      const slot = this.interval(vehicle, time);
      const op = this.data.iOp[slot];
      if (!FIELD[op]) continue;
      if (op === OP.AVAILABLE && (this.data.iMeta[slot] >> 12) & FLAG.HIDDEN) continue;
      result.push(this.vehicle(vehicle, time));
    }
    return result;
  }

  /** §15.4 last_reported: the minute floor less a fixed per-vehicle jitter of 0–90 seconds. */
  lastReported(vehicle: number, time: number) {
    const jitter = Math.floor(
      new Stream().reseed(keyOf(this.jitterSeed, PURPOSE.FEED, vehicle)).next() *
        (ASSUMPTIONS.feed.lastReportedJitterSeconds + 1),
    );
    return Math.floor(time / MINUTE) * MINUTE - jitter * 1000;
  }

  /** Counters of the service day up to and including `time`. */
  counters(time: number): Float64Array {
    const data = this.data;
    const step = ASSUMPTIONS.clock.checkpointMinutes * MINUTE;
    const clamped = Math.min(Math.max(time, this.meta.startsAt), this.meta.endsAt);
    const checkpoint = Math.min(
      data.checkpointEvent.length - 1,
      Math.floor((clamped - this.meta.startsAt) / step),
    );
    const counters = data.checkpoints.slice(checkpoint * COUNTERS, (checkpoint + 1) * COUNTERS);
    const events = data.events;
    const discount = ASSUMPTIONS.money.designatedDiscountWon;
    for (
      let index = data.checkpointEvent[checkpoint];
      index < events.t.length && events.t[index] <= time;
      index++
    ) {
      const base = index * 4;
      accumulate(
        counters,
        0,
        events.type[index],
        events.amount[index],
        events.detail[base],
        events.detail[base + 1],
        events.detail[base + 2],
        events.detail[base + 3],
        discount,
      );
    }
    return counters;
  }

  /** Per-group counters (`COUNTER_GROUPS` rows of `TYPED_COUNTERS`) up to and including `time`. */
  typedCounters(time: number): Float64Array {
    const data = this.data;
    const step = ASSUMPTIONS.clock.checkpointMinutes * MINUTE;
    const width = COUNTER_GROUPS * TYPED_COUNTERS;
    const clamped = Math.min(Math.max(time, this.meta.startsAt), this.meta.endsAt);
    const checkpoint = Math.min(
      data.checkpointEvent.length - 1,
      Math.floor((clamped - this.meta.startsAt) / step),
    );
    const counters = data.typedCheckpoints.slice(checkpoint * width, (checkpoint + 1) * width);
    const events = data.events;
    const discount = ASSUMPTIONS.money.designatedDiscountWon;
    for (
      let index = data.checkpointEvent[checkpoint];
      index < events.t.length && events.t[index] <= time;
      index++
    ) {
      const base = index * 4;
      const type = events.type[index];
      const d2 = events.detail[base + 2];
      const group = groupOf(data.vType, this.meta.fleets, type, events.vehicle[index], d2);
      accumulateTyped(
        counters,
        group * TYPED_COUNTERS,
        type,
        events.amount[index],
        events.detail[base],
        events.detail[base + 1],
        d2,
        events.detail[base + 3],
        discount,
      );
    }
    return counters;
  }

  /** The last row of a time series at or before `time`. */
  private row(times: Float64Array, time: number) {
    let low = 0,
      high = times.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (times[middle] <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }

  /** The depot's last `dT` row at or before `time`, or -1. */
  private depotRow(depot: number, time: number) {
    const data = this.data;
    // Rows are interleaved by depot; walk back from the last row at or before `time`.
    for (let row = this.row(data.dT, time); row >= 0; row--)
      if (data.dValues[row * 8] === depot) return row;
    return -1;
  }

  /** Depot stock at `time` (§15.3). */
  depotAt(depot: number, time: number): Record<(typeof depotKey)[number], number> {
    const data = this.data;
    const found = this.depotRow(depot, time);
    const result = Object.fromEntries(depotKey.map((key) => [key, 0])) as Record<
      (typeof depotKey)[number],
      number
    >;
    if (found >= 0)
      depotKey.forEach((key, index) => (result[key] = data.dValues[found * 8 + 1 + index]));
    return result;
  }

  /** One vehicle type's depot stock at `time` (§19); batteries are that type's packs. */
  depotTypeAt(
    depot: number,
    type: number,
    time: number,
  ): Record<(typeof depotTypeKey)[number], number> {
    const found = this.depotRow(depot, time);
    const width = DEPOT_TYPE_WIDTH * VEHICLE_TYPES.length;
    const result = Object.fromEntries(depotTypeKey.map((key) => [key, 0])) as Record<
      (typeof depotTypeKey)[number],
      number
    >;
    if (found >= 0)
      depotTypeKey.forEach(
        (key, index) =>
          (result[key] = this.data.dTypeValues[found * width + type * DEPOT_TYPE_WIDTH + index]),
      );
    return result;
  }

  /** Van places the depot's stored vehicles take (§19: an e-bike takes two). */
  private storedUnits(depot: number, time: number) {
    let units = 0;
    for (const type of VEHICLE_TYPES.keys()) {
      const stock = this.depotTypeAt(depot, type, time);
      units += (stock.ready + stock.charging + stock.repair + stock.inspecting) * VAN_UNITS[type];
    }
    return units;
  }

  lotsAt(time: number): number[] {
    const data = this.data,
      width = ASSUMPTIONS.lots.length;
    const row = this.row(data.lT, time);
    return Array.from({ length: width }, (_, lot) =>
      row >= 0 ? data.lValues[row * width + lot] : 0,
    );
  }

  openTasksAt(time: number): number[] {
    const row = this.row(this.data.oT, time);
    return Array.from({ length: 7 }, (_, index) =>
      row >= 0 ? this.data.oValues[row * 7 + index] : 0,
    );
  }

  /** The crew's row at `time`, or -1 before its first row. */
  crewRow(crew: number, time: number) {
    const data = this.data;
    let low = data.cStart[crew],
      high = data.cStart[crew + 1];
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (data.cT[middle] <= time) low = middle + 1;
      else high = middle;
    }
    return low - 1 >= data.cStart[crew] ? low - 1 : -1;
  }

  // ---- API views (§15) ----

  status(time: number) {
    const data = this.data,
      fleet = this.fleet;
    // One tally for the whole fleet and one per vehicle type (§19); the types add up to it.
    const tally = () => ({
      fleet: 0,
      states: Object.fromEntries(OP_NAMES.map((name) => [name, 0])) as Record<OpStateName, number>,
      byCategory: Object.fromEntries(CATEGORY_NAMES.slice(1).map((name) => [name, 0])) as Record<
        string,
        number
      >,
      improper: 0,
      reported: 0,
      dispatched: 0,
      fallen: 0,
      hidden: 0,
      hiddenAvailable: 0,
      rentable: 0,
    });
    // Plain counts per group (the fleet, then each type) in typed arrays; the tallies are filled
    // from them after the loop, in the same key order (§21.7).
    const tallies = VEHICLE_TYPES.length + 1,
      states = new Int32Array(tallies * OP_NAMES.length),
      categories = new Int32Array(tallies * CATEGORY_NAMES.length),
      sums = new Int32Array(tallies * 8);
    const SUM = { fleet: 0, improper: 1, reported: 2, dispatched: 3, fallen: 4, hidden: 5 };
    const SUM_HIDDEN_AVAILABLE = 6,
      SUM_RENTABLE = 7;
    const count = (group: number, op: number, flags: number, category: number, stage: number) => {
      const base = group * 8;
      if (op === OP.AVAILABLE) {
        if (flags & FLAG.HIDDEN) sums[base + SUM_HIDDEN_AVAILABLE]++;
        else sums[base + SUM_RENTABLE]++;
      }
      if (category !== CATEGORY.PROPER && category !== CATEGORY.NONE) {
        sums[base + SUM.improper]++;
        categories[group * CATEGORY_NAMES.length + category]++;
      }
      if (stage === STAGE.REPORTED) sums[base + SUM.reported]++;
      if (stage === STAGE.TOW_DISPATCHED) sums[base + SUM.dispatched]++;
      if (flags & FLAG.FALLEN) sums[base + SUM.fallen]++;
      if (flags & FLAG.HIDDEN) sums[base + SUM.hidden]++;
    };
    const ALL = VEHICLE_TYPES.length;
    for (let vehicle = 0; vehicle < fleet; vehicle++) {
      const slot = this.interval(vehicle, time);
      const op = data.iOp[slot];
      const type = data.vType[vehicle];
      sums[type * 8 + SUM.fleet]++;
      states[ALL * OP_NAMES.length + op]++;
      states[type * OP_NAMES.length + op]++;
      if (!FIELD[op]) continue;
      const meta = data.iMeta[slot];
      const flags = meta >> 12;
      const category = meta & 0xff;
      const stage = (meta >> 8) & 0xf;
      count(ALL, op, flags, category, stage);
      count(type, op, flags, category, stage);
    }
    const tallyOf = (group: number) => {
      const into = tally(),
        base = group * 8;
      into.fleet = sums[base + SUM.fleet];
      OP_NAMES.forEach((name, op) => (into.states[name] = states[group * OP_NAMES.length + op]));
      CATEGORY_NAMES.forEach((name, category) => {
        if (category !== CATEGORY.NONE && category !== CATEGORY.PROPER)
          into.byCategory[name] = categories[group * CATEGORY_NAMES.length + category];
      });
      into.improper = sums[base + SUM.improper];
      into.reported = sums[base + SUM.reported];
      into.dispatched = sums[base + SUM.dispatched];
      into.fallen = sums[base + SUM.fallen];
      into.hidden = sums[base + SUM.hidden];
      into.hiddenAvailable = sums[base + SUM_HIDDEN_AVAILABLE];
      into.rentable = sums[base + SUM_RENTABLE];
      return into;
    };
    const all = tallyOf(ALL);
    const typed = VEHICLE_TYPES.map((_, type) => tallyOf(type));
    const parkingOf = (count: ReturnType<typeof tally>) => ({
      improper: count.improper,
      byCategory: count.byCategory,
      byStage: { reported: count.reported, 'tow-dispatched': count.dispatched },
      fallen: count.fallen,
      hidden: count.hidden,
      // Available but hidden (§5.8): rentable == states.available − hiddenAvailable.
      hiddenAvailable: count.hiddenAvailable,
    });
    const counters = this.counters(time);
    const read = (slot: number) => counters[slot];
    const groups = this.typedCounters(time);
    const readGroup = (group: number) => (slot: number) => groups[group * TYPED_COUNTERS + slot];
    const readAll = (slot: number) => {
      let sum = 0;
      for (let group = 0; group < COUNTER_GROUPS; group++)
        sum += groups[group * TYPED_COUNTERS + slot];
      return sum;
    };
    const mixed = this.types.length > 1;
    const hasEbikes = this.meta.fleets.ebike > 0;
    const byKeys = (get: (slot: number) => number, first: number, keys: readonly string[]) =>
      Object.fromEntries(keys.map((key, index) => [key, get(first + index)]));
    const today = (get: (slot: number) => number, faults: Record<string, number>) => ({
      rides: get(C.rides),
      lostDemand: { total: get(C.lost), byReason: byKeys(get, C.lostBy, LOST_REASONS) },
      unlockFailures: get(C.unlockFailures),
      vehicleNotFound: get(C.vehicleNotFound),
      faults: { total: get(C.faults), byType: faults },
      improperParking: {
        total: get(C.improper),
        byCategory: byKeys(get, C.improperBy + 1, CATEGORY_NAMES.slice(1)),
      },
      photoRejections: get(C.photoRejections),
      rideEndRefusals: get(C.rideEndRefusals),
      falls: get(C.falls),
      complaints: get(C.complaints),
      tows: get(C.tows),
      towsCancelled: get(C.towsCancelled),
      impoundReleases: get(C.impoundReleases),
      fines: {
        count: get(C.fines),
        sumWon: get(C.finesSum),
        byKind: byKeys(get, C.finesBy, FINE_KINDS),
      },
      swaps: get(C.swaps),
      collections: get(C.collections),
      deployments: get(C.deployments),
      rebalances: get(C.rebalances),
      repairs: get(C.repairs),
      writeOffs: get(C.writeOffs),
      commissions: get(C.commissions),
      gpsLost: get(C.gpsLost),
      outOfArea: get(C.outOfArea),
      taskFailures: get(C.taskFailures),
      money: {
        rideRevenue: get(C.rideRevenue),
        designatedDiscounts: get(C.designatedDiscounts),
        riderPenalties: get(C.riderPenalties),
        outOfAreaFees: get(C.outOfAreaFees),
        refunds: get(C.refunds),
        towFees: get(C.towFees),
        storageFees: get(C.storageFees),
        passedToRiders: get(C.passedToRiders),
        paymentFailed: get(C.paymentFailed),
        paymentRecovered: get(C.paymentRecovered),
        operatorNet: operatorNet(get),
      },
    });
    // E-bike events the legacy row has no slot for (§19).
    const ebikeToday = (get: (slot: number) => number) => ({
      assistCutoffs: get(X.assistCutoffs),
      operatorNotices: get(X.operatorNotices),
      districtRemovals: get(X.districtRemovals),
    });
    const faultsOf = (
      get: (slot: number) => number,
      codes: readonly (readonly [string, number])[],
    ) => Object.fromEntries(codes.map(([name, code]) => [name, get(X.faultsBy + code - 1)]));
    // With e-bikes the fleet's faults list every code; a scooter-only window keeps its old keys.
    const totalFaults = hasEbikes
      ? faultsOf(readAll, FAULT_NAMES.map((name, code) => [name, code] as const).slice(1))
      : byKeys(read, C.faultsBy, FAULT_NAMES.slice(1, SCOOTER_FAULT_CODES + 1));
    const byType = Object.fromEntries(
      this.types.map((type) => {
        const count = typed[type];
        const get = readGroup(type);
        return [
          VEHICLE_TYPE_NAMES[type],
          {
            fleet: count.fleet,
            rentable: count.rentable,
            available: count.rentable,
            inUse: count.states['in-use'],
            lowBattery: count.states['low-battery'] + count.states['battery-dead'],
            ridesToday: get(C.rides),
            ridesInProgress: count.states['in-use'],
            // Riders who wanted this type only (or any vehicle, in a one-type fleet).
            lostDemandToday: get(C.lost),
            states: count.states,
            parking: parkingOf(count),
            today: {
              ...today(get, faultsOf(get, FAULT_CODES_OF[type])),
              ...(type === VTYPE_EBIKE ? ebikeToday(get) : {}),
            },
          },
        ];
      }),
    );
    const crews = this.crewSummary(time);
    const open = this.openTasksAt(time);
    let overCapacity = 0,
      intakeInspection = 0;
    this.meta.depots.forEach((depot, index) => {
      intakeInspection += this.depotAt(index, time).inspecting;
      // Capacity is in van places (§19): an e-bike takes two.
      overCapacity += Math.max(0, this.storedUnits(index, time) - depot.capacity);
    });
    const month = monthAt(time);
    const lost = read(C.lost);
    return {
      ready: true as const,
      modelVersion: this.meta.modelVersion,
      fleet,
      fleetByType: this.fleetByType(),
      rentable: all.rentable,
      available: all.rentable,
      inUse: all.states['in-use'],
      lowBattery: all.states['low-battery'] + all.states['battery-dead'],
      ridesToday: read(C.rides),
      ridesInProgress: all.states['in-use'],
      lostDemandToday: lost,
      serviceDay: this.meta.date,
      states: all.states,
      parking: parkingOf(all),
      today: {
        ...today(read, totalFaults),
        ...(mixed
          ? {
              lostDemand: {
                total: lost,
                byReason: byKeys(read, C.lostBy, LOST_REASONS),
                // What the riders who found nothing wanted; `either` took any type.
                byWanted: {
                  'kick-scooter': readGroup(VTYPE_SCOOTER)(C.lost),
                  'e-bike': readGroup(VTYPE_EBIKE)(C.lost),
                  either: readGroup(SHARED_GROUP)(C.lost),
                },
              },
            }
          : {}),
        ...(hasEbikes ? ebikeToday(readAll) : {}),
      },
      byType,
      crews: {
        ...crews,
        openTasks: {
          byPriority: Object.fromEntries(open.map((count, index) => [String(index + 1), count])),
        },
      },
      // `on-crew-van` counts van cargo and the 10-minute depot intake inspection (T17).
      depots: { overCapacity, intakeInspection },
      window: {
        startsAt: this.meta.startsAt,
        endsAt: this.meta.endsAt,
        warmupFrom: this.meta.warmupFrom,
      },
      season: {
        month,
        factor: ASSUMPTIONS.demand.seasonByMonth[month - 1],
        assumption: true as const,
      },
      geometry: this.meta.geometry,
      generatedAt: time,
      notice: SIMULATION_NOTICE,
    };
  }

  /** Vehicles per type name, for the types this window has. */
  fleetByType(): Partial<Record<VehicleTypeName, number>> {
    return fleetByTypeOf(this.meta.fleets);
  }

  private crewSummary(time: number) {
    const onShift = { van: 0, swap: 0, patrol: 0 },
      busy = { van: 0, swap: 0, patrol: 0 };
    let onMeal = 0;
    this.meta.crews.forEach((crew, index) => {
      const row = this.crewRow(index, time);
      if (row < 0) return;
      const state = this.data.cState[row];
      if (state === 0) return;
      const type = CREW_TYPES[crew.type];
      onShift[type]++;
      if (state >= 2 && state <= 5) busy[type]++;
      if (state === 6) onMeal++;
    });
    const hour = kstHour(time);
    const [from, to] = ASSUMPTIONS.mechanics.hours;
    const weekend = dayTypeAt(time) === 'weekend';
    const mechanicsOnShift =
      hour >= from && hour < to
        ? this.meta.depots.reduce(
            (sum, depot) => sum + (weekend ? depot.mechanicsWeekend : depot.mechanicsWeekday),
            0,
          )
        : 0;
    return { onShift, busy, onMeal, mechanicsOnShift };
  }

  /** §15.3 crews, depots and lots at `time`. Crews off shift carry no position. */
  crews(time: number) {
    const data = this.data;
    const midnight = midnightOfIndex(kstDateIndex(time));
    // Each shift's instance that is on now, else the one that starts on today's date.
    const shifts = ASSUMPTIONS.shifts.map((shift) => {
      const instances = [-1, 0].map((offset) => {
        const startsAt = midnight + offset * DAY + shift.start * HOUR;
        return { startsAt, endsAt: startsAt + (shift.end - shift.start) * HOUR };
      });
      const current =
        instances.find((instance) => time >= instance.startsAt && time < instance.endsAt) ??
        instances[1];
      return {
        name: shift.name,
        ...current,
        active: time >= current.startsAt && time < current.endsAt,
      };
    });
    const lots = this.lotsAt(time);
    const day = dayTypeAt(time);
    const [open, close] = ASSUMPTIONS.lotHours[day];
    const hour = kstHour(time);
    return {
      notice: SIMULATION_NOTICE,
      modelVersion: this.meta.modelVersion,
      generatedAt: time,
      shifts,
      depots: this.meta.depots.map((depot, index) => {
        const stock = this.depotAt(index, time);
        return {
          id: depot.id,
          name: depot.name,
          latitude: depot.latitude,
          longitude: depot.longitude,
          ready: stock.ready,
          charging: stock.charging,
          repair: stock.repair,
          inspecting: stock.inspecting,
          capacity: depot.capacity,
          chargedBatteries: stock.chargedBatteries,
          chargingBatteries: stock.chargingBatteries,
          waitingBatteries: stock.waitingBatteries,
          chargerSlots: depot.chargerSlots,
          // Capacity is in van places (§19): a scooter takes one, an e-bike two.
          storedUnits: this.storedUnits(index, time),
          byType: Object.fromEntries(
            this.types.map((type) => [
              VEHICLE_TYPE_NAMES[type],
              this.depotTypeAt(index, type, time),
            ]),
          ),
          simulated: true as const,
        };
      }),
      lots: ASSUMPTIONS.lots.map((lot, index) => ({
        id: lot.id,
        name: lot.name,
        latitude: lot.latitude,
        longitude: lot.longitude,
        impounded: lots[index],
        open: hour >= open && hour < close,
        simulated: true as const,
      })),
      crews: this.meta.crews.map((crew, index) => {
        const row = this.crewRow(index, time);
        const state = row >= 0 ? data.cState[row] : 0;
        const base = {
          id: crew.id,
          type: CREW_TYPES[crew.type],
          depotId: this.depotNames[crew.depot],
          shift: ASSUMPTIONS.shifts[crew.shift].name,
          state: CREW_STATES[state],
          simulated: true as const,
        };
        if (state === 0) return base;
        const task = data.cTask[row];
        const load = data.cLoad[row];
        const loadB = data.cLoadB[row];
        const moving = state === 2 || state === 4;
        const vehicleIds: string[] = [];
        for (let index = 0; index < data.cVehicleCount[row]; index++)
          vehicleIds.push(
            vehicleIdOf(data.vehiclePool[data.cVehicles[row] + index], this.meta.fleets.scooter),
          );
        return {
          ...base,
          latitude: data.cLat[row],
          longitude: data.cLon[row],
          ...(moving
            ? {
                destination: { latitude: data.cDestLat[row], longitude: data.cDestLon[row] },
                eta: data.cEta[row],
              }
            : {}),
          ...(crew.type === 1
            ? { batteries: this.swapLoad(load, loadB) }
            : crew.type === 0
              ? this.vanLoad(load, loadB)
              : {}),
          ...(task >= 0
            ? {
                task: {
                  kind: TASK_KINDS[Math.floor(task / 100)],
                  priority: task % 100,
                  vehicleIds,
                  ...(moving ? { eta: data.cEta[row] } : {}),
                },
              }
            : {}),
        };
      }),
    };
  }

  /**
   * A swap crew's packs (§19): charged × 100 + spent over all types, and the e-bike part the same
   * way. `slots` counts places; an e-bike pack takes 1.5 of them (`slotUnits`).
   */
  private swapLoad(load: number, loadB: number) {
    const charged = Math.floor(load / 100),
      depleted = load % 100;
    const ebike = { charged: Math.floor(loadB / 100), depleted: loadB % 100 };
    const scooter = { charged: charged - ebike.charged, depleted: depleted - ebike.depleted };
    const packs = [scooter, ebike];
    return {
      charged,
      depleted,
      slots: ASSUMPTIONS.capacity.swapSlots,
      slotUnits: packs.reduce(
        (sum, pack, type) => sum + (pack.charged + pack.depleted) * BATTERY_UNITS[type],
        0,
      ),
      byType: Object.fromEntries(this.types.map((type) => [VEHICLE_TYPE_NAMES[type], packs[type]])),
    };
  }

  /** A van's cargo (§19): `load` vehicles, `capacity` van places; an e-bike takes two. */
  private vanLoad(load: number, loadB: number) {
    const counts = [load - loadB, loadB];
    return {
      load,
      capacity: ASSUMPTIONS.capacity.vanVehicles,
      loadUnits: counts.reduce((sum, count, type) => sum + count * VAN_UNITS[type], 0),
      loadByType: Object.fromEntries(
        this.types.map((type) => [VEHICLE_TYPE_NAMES[type], counts[type]]),
      ),
    };
  }

  /** §15.2 the event log after `since` (or a cursor), cut at `now`. */
  events(query: EventQuery, now: number) {
    const data = this.data,
      events = data.events;
    const startsAt = this.meta.startsAt;
    let first = 0,
      seam = false;
    if (query.cursor !== undefined) {
      const parsed = parseEventId(query.cursor);
      if (!parsed || parsed.date > this.meta.date) first = events.t.length;
      else if (parsed.date < this.meta.date) seam = true;
      else first = parsed.index + 1;
    } else {
      const since = query.since ?? startsAt - 1;
      if (since < startsAt) seam = query.since !== undefined;
      else {
        let low = 0,
          high = events.t.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (events.t[middle] <= since) low = middle + 1;
          else high = middle;
        }
        first = low;
      }
    }
    const types = query.types?.length
      ? new Set(query.types.map((type) => EVENT_TYPES.indexOf(type)))
      : null;
    // Groups of the asked vehicle types; lost demand of riders who took either type matches any.
    const groups = query.vehicleTypes?.length
      ? new Set(query.vehicleTypes.map((name) => VEHICLE_TYPE_NAMES.indexOf(name)))
      : null;
    const fleets = this.meta.fleets;
    const matches = (index: number) => {
      const vehicle = events.vehicle[index];
      if (vehicle >= 0) return groups!.has(data.vType[vehicle]);
      if (events.type[index] !== EV_LOST) return false;
      const group = groupOf(data.vType, fleets, EV_LOST, -1, events.detail[index * 4 + 2]);
      return group === SHARED_GROUP || groups!.has(group);
    };
    const radius = query.radius ?? 1_000;
    const point =
      query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : null;
    const found: SimulationEvent[] = [];
    const names = {
      crews: this.crewNames,
      depots: this.depotNames,
      lots: this.lotNames,
      scooters: this.meta.fleets.scooter,
      vehicleTypes: data.vType,
    };
    let index = first,
      inspected = 0,
      lastInspected = -1,
      truncated = false;
    for (; index < events.t.length && events.t[index] <= now; index++) {
      if (found.length >= query.limit) break;
      if (inspected >= EVENT_SCAN_LIMIT) {
        truncated = true;
        break;
      }
      inspected++;
      lastInspected = index;
      if (types && !types.has(events.type[index])) continue;
      if (groups && !matches(index)) continue;
      if (
        point &&
        metersApart(point.latitude, point.longitude, events.lat[index], events.lon[index]) > radius
      )
        continue;
      found.push(formatEvent(events, index, this.meta.date, names));
    }
    const more = index < events.t.length && events.t[index] <= now;
    return {
      notice: SIMULATION_NOTICE,
      modelVersion: this.meta.modelVersion,
      generatedAt: now,
      serviceDay: this.meta.date,
      seam,
      windowStartsAt: startsAt,
      events: found,
      next: more && lastInspected >= 0 ? eventId(this.meta.date, lastInspected) : null,
      truncated,
    };
  }
}

export { HOUR };
