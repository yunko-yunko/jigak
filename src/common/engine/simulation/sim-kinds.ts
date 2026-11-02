/** Event-queue kinds. The rank orders kinds that fall on the same millisecond (§11.1). */
export const K = {
  HOUR: 0,
  RIDE_END: 1,
  AUTO_END: 2,
  BATTERY: 3,
  MISSING_RETURN: 4,
  MISSING_WRITE_OFF: 5,
  COMMISSION: 6,
  UNHIDE: 7,
  RERIDE: 8,
  INSPECT_DONE: 9,
  DEPOT_SWAP_DONE: 10,
  CHARGE_DONE: 11,
  REPAIR_DONE: 12,
  MECHANICS: 13,
  TOW_READY: 14,
  GRACE_END: 15,
  DISMISS: 16,
  TOW_PICKUP: 17,
  IMPOUND_ARRIVE: 18,
  PAYMENT_RECOVERED: 19,
  TOW_HOURS: 20,
  TASK_REOPEN: 21,
  HAZARD: 22,
  ARRIVAL: 23,
  REACH: 24,
  ABANDON: 25,
  SHIFT_START: 26,
  SHIFT_END: 27,
  CREW_ARRIVE: 28,
  CREW_DONE: 29,
  CREW_CHECK: 30,
  DISPATCH: 31,
  REBALANCE: 32,
  PLAN_MORNING: 33,
  PLAN_OVERNIGHT: 34,
  /** The served day starts: recording begins with a full snapshot. */
  SNAPSHOT: 35,
} as const;

export const RANK = new Uint8Array(36);
for (const kind of [K.RIDE_END, K.AUTO_END]) RANK[kind] = 1;
for (let kind = K.BATTERY; kind <= K.TASK_REOPEN; kind++) RANK[kind] = 2;
RANK[K.HAZARD] = 3;
for (const kind of [K.ARRIVAL, K.REACH, K.ABANDON]) RANK[kind] = 4;
for (let kind = K.SHIFT_START; kind <= K.CREW_CHECK; kind++) RANK[kind] = 5;
for (let kind = K.DISPATCH; kind <= K.PLAN_OVERNIGHT; kind++) RANK[kind] = 6;
