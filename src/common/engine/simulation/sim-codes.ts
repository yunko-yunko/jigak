/**
 * Integer codes shared by the simulator, its window data and its views (§3, §14). Columns store
 * these codes; the names below are what the API prints.
 */

/** Vehicle types, the `vType` column: scooters take indices [0, S), e-bikes [S, S + B). */
export const VTYPE = { SCOOTER: 0, EBIKE: 1 } as const;
export const VEHICLE_TYPE_NAMES = ['kick-scooter', 'e-bike'] as const;
export type VehicleTypeName = (typeof VEHICLE_TYPE_NAMES)[number];
/** Vehicle id prefixes per type (JS00001, JB00001). */
export const VEHICLE_ID_PREFIX = ['JS', 'JB'] as const;

/**
 * What an arriving rider wants, as a bit mask over vehicle types (bit = 1 << vType). 0 means no
 * choice was drawn (one type on the street) and is what `lost-demand` stores then.
 */
export const WANTED = { SCOOTER: 1, EBIKE: 2, EITHER: 3 } as const;
export const WANTED_NAMES = ['any', 'kick-scooter', 'e-bike', 'either'] as const;

/** §3.2 operating states. Exactly one per vehicle at any time. */
export const OP = {
  AVAILABLE: 0,
  RESERVED: 1,
  IN_USE: 2,
  LOW_BATTERY: 3,
  BATTERY_DEAD: 4,
  BROKEN: 5,
  OUT_OF_AREA: 6,
  MISSING: 7,
  TOWING: 8,
  IMPOUNDED: 9,
  ON_CREW_VAN: 10,
  DEPOT_CHARGING: 11,
  DEPOT_REPAIR: 12,
  DEPOT_READY: 13,
  DEPLOYING: 14,
  WRITTEN_OFF: 15,
} as const;

export const OP_NAMES = [
  'available',
  'reserved',
  'in-use',
  'low-battery',
  'battery-dead',
  'broken',
  'out-of-area',
  'missing',
  'towing',
  'impounded',
  'on-crew-van',
  'at-depot-charging',
  'at-depot-repair',
  'at-depot-ready',
  'deploying',
  'written-off',
] as const;
export type OpStateName = (typeof OP_NAMES)[number];

/** Vehicles standing on the street: only these have a parking category and complaint stage. */
export const FIELD = new Uint8Array(16);
for (const op of [
  OP.AVAILABLE,
  OP.RESERVED,
  OP.LOW_BATTERY,
  OP.BATTERY_DEAD,
  OP.BROKEN,
  OP.OUT_OF_AREA,
])
  FIELD[op] = 1;
export const DEPOT_STATES = [OP.DEPOT_CHARGING, OP.DEPOT_REPAIR, OP.DEPOT_READY] as const;

/** §6.1 parking categories. */
export const CATEGORY = {
  PROPER: 0,
  SIDEWALK: 1,
  ROADWAY: 2,
  SUBWAY_EXIT: 3,
  BUS_TAXI: 4,
  CROSSWALK: 5,
  TACTILE: 6,
  PRIVATE: 7,
  RESTRICTED: 8,
  NONE: 255,
} as const;

export const CATEGORY_NAMES = [
  'proper',
  'sidewalk-obstruction',
  'roadway',
  'subway-exit',
  'bus-taxi-stop',
  'crosswalk',
  'tactile-island',
  'private-entrance',
  'restricted-park-river',
] as const;
export type CategoryName = (typeof CATEGORY_NAMES)[number];

/** Categories towed right after a complaint (§7.2); the others get the operator's grace period. */
export const IMMEDIATE_TOW = [false, false, true, true, true, true, true, false, false];
/**
 * Per vehicle type. Seoul's PM towing ordinance does not cover e-bikes (R §2), so no category is
 * towed on sight; district removal and operator notices are their own regime.
 */
export const IMMEDIATE_TOW_BY_TYPE: readonly (readonly boolean[])[] = [
  IMMEDIATE_TOW,
  IMMEDIATE_TOW.map(() => false),
];

/** §3.3 complaint stage. */
export const STAGE = { NONE: 0, REPORTED: 1, TOW_DISPATCHED: 2 } as const;
export const STAGE_NAMES = ['none', 'reported', 'tow-dispatched'] as const;

/** Vehicle flags (bit set). */
export const FLAG = {
  FALLEN: 1,
  HIDDEN: 2,
  DESIGNATED: 4,
  BATTERY_MISSING: 8,
  FAULT_REVEALED: 16,
  /** The last rider left it at this spot and nobody moved it since (§7.2 cost pass-through). */
  RIDER_PLACED: 32,
  DOCK_FALLBACK: 64,
  GEOMETRY: 128,
  /** Back from missing; a van checks it (§3.5 T25). */
  MISSING_CHECK: 256,
  /** The operator saw this violation (photo left or GPS detection) and sends a patrol. */
  OPERATOR_FLAGGED: 512,
  /** Gyeonggi complaint on an out-of-area vehicle raises its pickup (§5.7). */
  OUT_OF_AREA_COMPLAINED: 1024,
  /** Parked on a discouraged spot of the rule table (§20.3): allowed, complained about more. */
  DISCOURAGED: 2048,
} as const;
/** Flags that change what a viewer sees; intervals record these. */
export const VISIBLE_FLAGS = FLAG.FALLEN | FLAG.HIDDEN | FLAG.DESIGNATED | FLAG.BATTERY_MISSING;

/** §3.6 fault types; 0 means none. */
export const FAULT_NAMES = [
  'none',
  'unlock-iot',
  'brake',
  'tyre',
  'throttle-motor',
  'display-qr',
  'battery-bms',
  'frame',
  // E-bike only; appended so the scooter codes keep their numbers.
  'chain-drivetrain',
  'pedal-crank',
  'saddle-seatpost',
  'motor-sensor',
] as const;
export const FAULT = {
  NONE: 0,
  UNLOCK_IOT: 1,
  BRAKE: 2,
  TYRE: 3,
  THROTTLE: 4,
  DISPLAY: 5,
  BMS: 6,
  FRAME: 7,
  CHAIN: 8,
  PEDAL: 9,
  SADDLE: 10,
  MOTOR_SENSOR: 11,
} as const;
/** The scooter fault codes 1..7: the ledger's per-fault counter series covers these. */
export const SCOOTER_FAULT_CODES = FAULT.FRAME;

/** §5.1 rider types. */
export const RIDER_TYPE_NAMES = ['commuter', 'student', 'casual', 'late-night'] as const;
export const RIDER = { COMMUTER: 0, STUDENT: 1, CASUAL: 2, LATE_NIGHT: 3 } as const;

/** Geometry layers. */
export const LAYER = { DOCK: 0, BUS: 1, EXIT: 2, CROSSWALK: 3 } as const;

/** §14 event types. The order is the code; append only. */
export const EVENT_TYPES = [
  'reserve',
  'reserve-ended',
  'vehicle-not-found',
  'unlock-failed',
  'rent',
  'ride-end',
  'ride-end-refused',
  'improper-parking',
  'photo-rejected',
  'fall',
  'complaint',
  'complaint-resolved',
  'patrol-repark',
  'tow',
  'tow-cancelled',
  'impound-release',
  'rider-charge',
  'fine',
  'fault',
  'accident',
  'battery-dead',
  'battery-theft',
  'battery-swap',
  'collect',
  'deploy',
  'rebalance',
  'charge-done',
  'repair-done',
  'write-off',
  'commission',
  'gps-lost',
  'gps-recovered',
  'task-failed',
  'out-of-area',
  'refund',
  'payment-failed',
  'payment-recovered',
  'lost-demand',
  // E-bike: the battery is spent, assist stops and the rider pedals on (§19).
  'assist-cutoff',
  // E-bike parking enforcement (§19): the operator is told to re-park; 서초구 removes.
  'operator-notice',
  'district-removal',
] as const;
export type EventTypeName = (typeof EVENT_TYPES)[number];
export const EV = Object.fromEntries(EVENT_TYPES.map((name, index) => [name, index])) as {
  [K in EventTypeName]: number;
};

/** Detail vocabularies, indexed by the codes stored in event detail columns. */
export const ENDED_BY = ['rider', 'auto', 'battery', 'fault', 'accident', 'police'] as const;
export const LOST_REASONS = ['none-in-reach', 'no-range', 'not-found', 'unlock-gave-up'] as const;
export const RESERVE_END = ['abandoned', 'not-found'] as const;
export const OUTCOME_RETRY = ['retry', 'gave-up'] as const;
export const PHOTO_OUTCOME = ['reparked', 'left', 'false-reject'] as const;
export const REFUSED_OUTCOME = ['moved', 'forced'] as const;
export const COMPLAINT_SOURCE = ['citizen', 'district-patrol', 'gyeonggi'] as const;
export const RESOLUTION = [
  'rented',
  'reparked',
  'towed',
  'dismissed',
  'collected',
  'gone',
  'removed',
] as const;
/**
 * Which rules a complaint follows (§7, §19): Seoul's PM towing, an operator re-park notice
 * (e-bikes today), 서초구's own removal, or the 2027 ordinance towing shared bicycles.
 */
export const TOW_REGIMES = [
  'pm-towing',
  'operator-notice',
  'district-removal',
  'ordinance-2027',
] as const;
export const REGIME = { PM: 0, OPERATOR: 1, DISTRICT: 2, ORDINANCE: 3 } as const;
export const TOW_PHASE = ['dispatched', 'picked-up'] as const;
export const FINE_KINDS = [
  'helmet',
  'two-riders',
  'unlicensed',
  'drunk',
  'drunk-refusal',
  'sidewalk',
  'signal',
] as const;
export const DISCOVERED_BY = [
  'rider-check',
  'unlock',
  'mid-ride',
  'ride-end-report',
  'swap-crew',
  'patrol',
  'depot',
  'accident',
  'fall',
] as const;
export const COLLECT_REASONS = [
  'broken',
  'battery',
  'out-of-area',
  'impound',
  'missing-check',
  'overnight',
  'rebalance',
] as const;
export const WRITE_OFF_REASONS = ['repair', 'missing', 'stolen', 'vandalism'] as const;
export const GPS_LOST_REASONS = ['signal', 'not-found', 'not-returned'] as const;
export const TASK_FAIL_REASONS = ['not-found', 'inaccessible'] as const;
export const REFUND_REASONS = ['fault', 'accident', 'battery'] as const;

/** Crews (§9.2). */
export const CREW_TYPES = ['van', 'swap', 'patrol'] as const;
export type CrewType = (typeof CREW_TYPES)[number];
export const CREW_STATES = [
  'off',
  'idle',
  'travelling',
  'working',
  'returning',
  'restocking',
  'meal',
] as const;
export const CREW_STATE = {
  OFF: 0,
  IDLE: 1,
  TRAVELLING: 2,
  WORKING: 3,
  RETURNING: 4,
  RESTOCKING: 5,
  MEAL: 6,
} as const;

/** Task kinds (§9.4) with their crew types. */
export const TASK_KINDS = [
  'repark-immediate',
  'repark',
  'right-fallen',
  'impound-retrieval',
  'out-of-area-pickup',
  'broken-pickup',
  'missing-check',
  'battery-swap',
  'dead-pickup',
  'deploy',
  'rebalance',
  'overnight-collect',
] as const;
export const TASK = {
  REPARK_IMMEDIATE: 0,
  REPARK: 1,
  RIGHT_FALLEN: 2,
  IMPOUND: 3,
  OUT_OF_AREA: 4,
  BROKEN: 5,
  MISSING_CHECK: 6,
  SWAP: 7,
  DEAD_PICKUP: 8,
  DEPLOY: 9,
  REBALANCE: 10,
  OVERNIGHT: 11,
} as const;

/**
 * Allowed operating-state transitions (§3.5 T1–T32), as from → to pairs. The tests replay the
 * interval log against this table.
 */
export const ALLOWED_TRANSITIONS: readonly (readonly [number, number])[] = (() => {
  const pairs: [number, number][] = [];
  const add = (from: number[], to: number[]) => {
    for (const a of from) for (const b of to) if (a !== b) pairs.push([a, b]);
  };
  const field = [OP.AVAILABLE, OP.RESERVED, OP.LOW_BATTERY, OP.BATTERY_DEAD, OP.BROKEN];
  add([OP.AVAILABLE], [OP.RESERVED]); // T1
  add([OP.RESERVED], [OP.AVAILABLE]); // T2
  add([OP.AVAILABLE, OP.RESERVED], [OP.IN_USE]); // T3
  add([OP.AVAILABLE, OP.RESERVED], [OP.BROKEN]); // T4, T5
  add([OP.IN_USE], [OP.AVAILABLE, OP.LOW_BATTERY, OP.BATTERY_DEAD]); // T6, T7
  add([OP.IN_USE], [OP.BROKEN, OP.OUT_OF_AREA, OP.MISSING]); // T8–T11
  add([...field, OP.OUT_OF_AREA], [OP.TOWING]); // T12
  add([OP.TOWING], [OP.IMPOUNDED]); // T13
  add([OP.IMPOUNDED], [OP.ON_CREW_VAN]); // T14
  add([OP.BROKEN, OP.BATTERY_DEAD, OP.LOW_BATTERY, OP.OUT_OF_AREA, OP.AVAILABLE], [OP.ON_CREW_VAN]); // T15, T16
  add([OP.ON_CREW_VAN], [OP.DEPOT_CHARGING, OP.DEPOT_REPAIR, OP.DEPOT_READY]); // T17
  add([OP.ON_CREW_VAN], [OP.AVAILABLE]); // T18
  add([OP.DEPOT_CHARGING], [OP.DEPOT_READY]); // T19
  add([OP.DEPOT_REPAIR], [OP.DEPOT_CHARGING, OP.DEPOT_READY, OP.WRITTEN_OFF]); // T20, T21
  add([OP.DEPOT_READY], [OP.DEPLOYING]); // T22
  add([OP.DEPLOYING], [OP.AVAILABLE]); // T23
  add([OP.DEPLOYING], [OP.DEPOT_READY]); // undelivered at the end of a shift, back on the shelf
  add([...field, OP.OUT_OF_AREA], [OP.MISSING]); // T24
  add([OP.MISSING], [OP.AVAILABLE, OP.LOW_BATTERY, OP.BATTERY_DEAD, OP.BROKEN, OP.OUT_OF_AREA]); // T25
  add([OP.MISSING], [OP.WRITTEN_OFF]); // T26
  add([OP.AVAILABLE], [OP.LOW_BATTERY]); // T27
  add([OP.LOW_BATTERY], [OP.BATTERY_DEAD]); // T27
  add([OP.AVAILABLE, OP.LOW_BATTERY], [OP.BATTERY_DEAD]); // T28
  add([OP.LOW_BATTERY, OP.BATTERY_DEAD], [OP.AVAILABLE]); // T29
  add([OP.AVAILABLE, OP.LOW_BATTERY, OP.BATTERY_DEAD], [OP.BROKEN]); // T30
  add([...field, OP.OUT_OF_AREA], [OP.WRITTEN_OFF]); // T31
  add([OP.WRITTEN_OFF], [OP.DEPOT_READY]); // T32
  add([OP.RESERVED], [OP.LOW_BATTERY, OP.BATTERY_DEAD]); // reservation ends below the threshold
  return pairs;
})();
