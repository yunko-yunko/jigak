import {
  CATEGORY_NAMES,
  EV,
  EVENT_TYPES,
  FAULT_NAMES,
  FINE_KINDS,
  LOST_REASONS,
  SCOOTER_FAULT_CODES,
} from './sim-codes.js';

/**
 * The ledger (§10) and the day's counters (§15.1 `today`). Every amount is one event; a day's
 * totals are sums over its events, kept as running counters so a status read is a checkpoint
 * plus a short scan.
 */

/** Who pays whom for each money event (§8, §10). Amounts are whole won. */
export const LEDGER: Partial<Record<number, { payer: string; payee: string; item: string }>> = {
  [EV['ride-end']]: { payer: 'rider', payee: 'operator', item: 'fare' },
  [EV.refund]: { payer: 'operator', payee: 'rider', item: 'refund' },
  [EV['photo-rejected']]: { payer: 'rider', payee: 'operator', item: 'parking-penalty' },
  [EV['ride-end-refused']]: { payer: 'rider', payee: 'operator', item: 'forced-end-penalty' },
  [EV['out-of-area']]: { payer: 'rider', payee: 'operator', item: 'out-of-area-fee' },
  [EV['impound-release']]: { payer: 'operator', payee: 'district', item: 'tow-and-storage' },
  [EV['rider-charge']]: { payer: 'rider', payee: 'operator', item: 'tow-pass-through' },
  [EV.fine]: { payer: 'rider', payee: 'police', item: 'fine' },
  [EV['payment-failed']]: { payer: 'rider', payee: 'operator', item: 'unpaid-fare' },
  [EV['payment-recovered']]: { payer: 'rider', payee: 'operator', item: 'recovered-fare' },
  [EV.tow]: { payer: 'operator', payee: 'district', item: 'tow-recorded' },
  [EV.accident]: { payer: 'operator', payee: 'insurer', item: 'insurance-claim' },
};

const names: string[] = [];
const add = (name: string) => names.push(name) - 1;
const series = (prefix: string, keys: readonly string[]) => {
  const first = names.length;
  for (const key of keys) add(`${prefix}.${key}`);
  return first;
};

/** Counter slots. */
export const C = {
  rides: add('rides'),
  rideEnds: add('rideEnds'),
  lost: add('lostDemand'),
  lostBy: series('lostDemand', LOST_REASONS),
  reserves: add('reserves'),
  unlockFailures: add('unlockFailures'),
  vehicleNotFound: add('vehicleNotFound'),
  faults: add('faults'),
  /** Scooter fault codes only, so the checkpoint row keeps its width; e-bike-only faults count in `faults`. */
  faultsBy: series('faults', FAULT_NAMES.slice(1, SCOOTER_FAULT_CODES + 1)),
  /** Faults found on or by riders' rides, excluding accidents and fall damage (§16.7). */
  rideFaults: add('rideFaults'),
  improper: add('improperParking'),
  improperBy: series('improperParking', CATEGORY_NAMES),
  photoRejections: add('photoRejections'),
  rideEndRefusals: add('rideEndRefusals'),
  falls: add('falls'),
  fallsDamaged: add('fallsDamaged'),
  complaints: add('complaints'),
  tows: add('tows'),
  towsCancelled: add('towsCancelled'),
  impoundReleases: add('impoundReleases'),
  impoundMinutes: add('impoundMinutes'),
  fines: add('fines'),
  finesSum: add('finesSum'),
  finesBy: series('fines', FINE_KINDS),
  swaps: add('swaps'),
  collections: add('collections'),
  deployments: add('deployments'),
  rebalances: add('rebalances'),
  repairs: add('repairs'),
  writeOffs: add('writeOffs'),
  commissions: add('commissions'),
  gpsLost: add('gpsLost'),
  outOfArea: add('outOfArea'),
  taskFailures: add('taskFailures'),
  batteryDeadMidRide: add('batteryDeadMidRide'),
  accidents: add('accidents'),
  // Money (§10).
  rideRevenue: add('money.rideRevenue'),
  designatedDiscounts: add('money.designatedDiscounts'),
  riderPenalties: add('money.riderPenalties'),
  outOfAreaFees: add('money.outOfAreaFees'),
  refunds: add('money.refunds'),
  towFees: add('money.towFees'),
  storageFees: add('money.storageFees'),
  passedToRiders: add('money.passedToRiders'),
  paymentFailed: add('money.paymentFailed'),
  paymentRecovered: add('money.paymentRecovered'),
} as const;

export const COUNTER_NAMES: readonly string[] = names;
export const COUNTERS = names.length;

/** Adds one event to running counters. `d` holds the event's four detail columns. */
export function accumulate(
  counters: Float64Array,
  offset: number,
  type: number,
  amount: number,
  d0: number,
  d1: number,
  d2: number,
  d3: number,
  designatedDiscountWon: number,
) {
  const at = (slot: number, value = 1) => (counters[offset + slot] += value);
  switch (type) {
    case EV.rent:
      at(C.rides);
      return;
    case EV['ride-end']:
      at(C.rideEnds);
      at(C.rideRevenue, amount);
      if (d3 & 16) at(C.designatedDiscounts, designatedDiscountWon);
      return;
    case EV['lost-demand']:
      at(C.lost);
      at(C.lostBy + d0);
      return;
    case EV.reserve:
      at(C.reserves);
      return;
    case EV['unlock-failed']:
      at(C.unlockFailures);
      return;
    case EV['vehicle-not-found']:
      at(C.vehicleNotFound);
      return;
    case EV.fault:
      at(C.faults);
      if (d0 <= SCOOTER_FAULT_CODES) at(C.faultsBy + d0 - 1);
      // rider-check, unlock, mid-ride and ride-end-report; not accidents or fall damage (frame).
      if (d1 <= 3 && d0 !== 7) at(C.rideFaults);
      return;
    case EV['improper-parking']:
      at(C.improper);
      at(C.improperBy + d0);
      return;
    case EV['photo-rejected']:
      at(C.photoRejections);
      at(C.riderPenalties, amount);
      return;
    case EV['ride-end-refused']:
      at(C.rideEndRefusals);
      at(C.riderPenalties, amount);
      return;
    case EV.fall:
      at(C.falls);
      if (d0) at(C.fallsDamaged);
      return;
    case EV.complaint:
      at(C.complaints);
      return;
    case EV.tow:
      if (d1 === 1) at(C.tows);
      return;
    case EV['tow-cancelled']:
      at(C.towsCancelled);
      return;
    case EV['impound-release']:
      at(C.impoundReleases);
      at(C.impoundMinutes, d1);
      at(C.towFees, d2);
      at(C.storageFees, d3);
      return;
    case EV['rider-charge']:
      at(C.passedToRiders, amount);
      return;
    case EV.fine:
      at(C.fines);
      at(C.finesSum, amount);
      at(C.finesBy + d0);
      return;
    case EV['battery-swap']:
      at(C.swaps);
      return;
    case EV.collect:
      at(C.collections);
      return;
    case EV.deploy:
      at(C.deployments);
      return;
    case EV.rebalance:
      at(C.rebalances);
      return;
    case EV['repair-done']:
      at(C.repairs);
      return;
    case EV['write-off']:
      at(C.writeOffs);
      return;
    case EV.commission:
      at(C.commissions);
      return;
    case EV['gps-lost']:
      at(C.gpsLost);
      return;
    case EV['out-of-area']:
      at(C.outOfArea);
      at(C.outOfAreaFees, amount);
      return;
    case EV['task-failed']:
      at(C.taskFailures);
      return;
    case EV.refund:
      at(C.refunds, amount);
      return;
    case EV['payment-failed']:
      at(C.paymentFailed, amount);
      return;
    case EV['payment-recovered']:
      at(C.paymentRecovered, amount);
      return;
    case EV['battery-dead']:
      if (d0) at(C.batteryDeadMidRide);
      return;
    case EV.accident:
      at(C.accidents);
      return;
  }
}

/**
 * Counters only the per-type checkpoints keep (§19), after the `C` slots: the legacy row keeps its
 * width, so a scooter-only window stays byte-identical. Every fault code counts here, and the
 * e-bike events that came after the row was fixed.
 */
export const X = {
  faultsBy: COUNTERS,
  assistCutoffs: COUNTERS + FAULT_NAMES.length - 1,
  operatorNotices: COUNTERS + FAULT_NAMES.length,
  districtRemovals: COUNTERS + FAULT_NAMES.length + 1,
} as const;
export const TYPED_COUNTERS = COUNTERS + FAULT_NAMES.length + 2;

/** `accumulate` over a `TYPED_COUNTERS`-wide row: the legacy slots and then the `X` slots. */
export function accumulateTyped(
  counters: Float64Array,
  offset: number,
  type: number,
  amount: number,
  d0: number,
  d1: number,
  d2: number,
  d3: number,
  designatedDiscountWon: number,
) {
  accumulate(counters, offset, type, amount, d0, d1, d2, d3, designatedDiscountWon);
  switch (type) {
    case EV.fault:
      if (d0 > 0 && d0 < FAULT_NAMES.length) counters[offset + X.faultsBy + d0 - 1]++;
      return;
    case EV['assist-cutoff']:
      counters[offset + X.assistCutoffs]++;
      return;
    case EV['operator-notice']:
      counters[offset + X.operatorNotices]++;
      return;
    case EV['district-removal']:
      counters[offset + X.districtRemovals]++;
      return;
  }
}

/** §10 operatorNet: fares less failures and refunds, plus penalties and fees, less district fees. */
export function operatorNet(read: (slot: number) => number): number {
  return (
    read(C.rideRevenue) -
    read(C.paymentFailed) +
    read(C.paymentRecovered) +
    read(C.riderPenalties) +
    read(C.outOfAreaFees) +
    read(C.passedToRiders) -
    read(C.refunds) -
    read(C.towFees) -
    read(C.storageFees)
  );
}

export { EVENT_TYPES };
