import { LEDGER } from './ledger.js';
import {
  CATEGORY_NAMES,
  COLLECT_REASONS,
  COMPLAINT_SOURCE,
  DISCOVERED_BY,
  ENDED_BY,
  EV,
  EVENT_TYPES,
  FAULT_NAMES,
  FINE_KINDS,
  GPS_LOST_REASONS,
  LOST_REASONS,
  OUTCOME_RETRY,
  PHOTO_OUTCOME,
  REFUND_REASONS,
  REFUSED_OUTCOME,
  RESERVE_END,
  RESOLUTION,
  RIDER_TYPE_NAMES,
  TASK_FAIL_REASONS,
  TOW_PHASE,
  TOW_REGIMES,
  VEHICLE_ID_PREFIX,
  VEHICLE_TYPE_NAMES,
  WANTED_NAMES,
  WRITE_OFF_REASONS,
  type EventTypeName,
  type VehicleTypeName,
} from './sim-codes.js';

/** One simulated event as the API prints it (§14). */
export interface SimulationEvent {
  id: string;
  at: number;
  type: EventTypeName;
  vehicleId?: string;
  /** The vehicle's type, whenever the event has a vehicle (§19). */
  vehicleType?: VehicleTypeName;
  crewId?: string;
  latitude: number;
  longitude: number;
  amountWon?: number;
  ledger?: { payer: string; payee: string; item: string };
  detail: Record<string, unknown>;
  simulated: true;
}

/** The columns of an event log, as the window stores them. */
export interface EventColumns {
  t: Float64Array;
  type: Uint8Array;
  vehicle: Int32Array;
  crew: Int32Array;
  lat: Float64Array;
  lon: Float64Array;
  amount: Int32Array;
  /** Four detail values per event. */
  detail: Int32Array;
}

/**
 * A vehicle's id: scooters [0, scooters) are JS00001.., e-bikes after them JB00001... Without
 * `scooters` every index is a scooter, as before e-bikes existed.
 */
export const vehicleIdOf = (index: number, scooters = Number.MAX_SAFE_INTEGER) =>
  index < scooters
    ? `${VEHICLE_ID_PREFIX[0]}${String(index + 1).padStart(5, '0')}`
    : `${VEHICLE_ID_PREFIX[1]}${String(index - scooters + 1).padStart(5, '0')}`;

/** The index of a vehicle id for a fleet of `scooters` + `ebikes`; -1 when malformed or absent. */
export function vehicleIndexOf(id: string, scooters: number, ebikes = 0): number {
  const match = /^J([SB])(\d{5})$/.exec(id);
  if (!match) return -1;
  const number = Number(match[2]) - 1;
  if (match[1] === 'S') return number >= 0 && number < scooters ? number : -1;
  return number >= 0 && number < ebikes ? scooters + number : -1;
}

export const eventId = (date: string, index: number) => `${date}:${String(index).padStart(6, '0')}`;

/** Parses an event id into (service date, index); null when malformed. */
export function parseEventId(id: string): { date: string; index: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2}):(\d{6,})$/.exec(id);
  return match ? { date: match[1], index: Number(match[2]) } : null;
}

const name = <T extends readonly string[]>(names: T, code: number): T[number] | 'unknown' =>
  names[code] ?? 'unknown';

/** Decodes the detail columns of one event type into its §14 shape. */
export function eventDetail(
  type: number,
  amount: number,
  d0: number,
  d1: number,
  d2: number,
  d3: number,
  names: { depots: readonly string[]; lots: readonly string[] },
): Record<string, unknown> {
  switch (type) {
    case EV.reserve:
      return { riderType: name(RIDER_TYPE_NAMES, d0), walkMeters: d1 };
    case EV['reserve-ended']:
      return { reason: name(RESERVE_END, d0) };
    case EV['vehicle-not-found']:
      return { outcome: name(OUTCOME_RETRY, d0) };
    case EV['unlock-failed']:
      return { attempt: d0 + 1, persistent: d1 === 1, outcome: name(OUTCOME_RETRY, d2) };
    case EV.rent:
      return { riderType: name(RIDER_TYPE_NAMES, d0), batteryPercent: Math.floor(d1 / 10) };
    case EV['ride-end']:
      return {
        durationSeconds: d0,
        meters: d1,
        batteryPercent: Math.floor(d2 / 10),
        endedBy: name(ENDED_BY, d3 & 15),
        fareWon: amount,
        designated: (d3 & 16) !== 0,
      };
    case EV['ride-end-refused']:
      return { outcome: name(REFUSED_OUTCOME, d0), movedMeters: d1 };
    case EV['improper-parking']:
      return { category: name(CATEGORY_NAMES, d0), immediateTow: d1 === 1, geometry: d2 === 1 };
    case EV['photo-rejected']:
      return { category: name(CATEGORY_NAMES, d0), outcome: name(PHOTO_OUTCOME, d1) };
    case EV.fall:
      return { damaged: d0 === 1 };
    case EV.complaint:
      return { category: name(CATEGORY_NAMES, d0), count: d1, source: name(COMPLAINT_SOURCE, d2) };
    case EV['complaint-resolved']:
      return {
        category: name(CATEGORY_NAMES, d0),
        count: d1,
        resolution: name(RESOLUTION, d2),
      };
    case EV['patrol-repark']:
      return { fromCategory: name(CATEGORY_NAMES, d0), movedMeters: d1 / 10, righted: d2 === 1 };
    case EV.tow:
      return {
        category: name(CATEGORY_NAMES, d0),
        phase: name(TOW_PHASE, d1),
        lotId: names.lots[d2] ?? null,
      };
    case EV['tow-cancelled']:
      return { reason: name(RESOLUTION, d0) };
    case EV['impound-release']:
      return { lotId: names.lots[d0] ?? null, storedMinutes: d1, towWon: d2, storageWon: d3 };
    case EV['rider-charge']:
      return { towWon: d0, storageWon: d1 };
    case EV.fine:
      return { kind: name(FINE_KINDS, d0) };
    case EV.fault:
      return { faultType: name(FAULT_NAMES, d0), discoveredBy: name(DISCOVERED_BY, d1) };
    case EV.accident:
      return { insuranceClaim: true };
    case EV['battery-dead']:
      return { midRide: d0 === 1 };
    case EV['battery-swap']:
      return { fromPercent: Math.floor(d0 / 10), toPercent: Math.floor(d1 / 10), tidied: d2 === 1 };
    case EV.collect:
      return { reason: name(COLLECT_REASONS, d0) };
    case EV.deploy:
      return { depotId: names.depots[d0] ?? null, cell: d1 };
    case EV.rebalance:
      return { fromCell: d0, toCell: d1 };
    case EV['charge-done']:
      return { depotId: names.depots[d0] ?? null, waitedMinutes: d1 };
    case EV['repair-done']:
      return { faultType: name(FAULT_NAMES, d0), hours: d1 / 10, preventive: d2 === 1 };
    case EV['write-off']:
      return { reason: name(WRITE_OFF_REASONS, d0) };
    case EV.commission:
      return { depotId: names.depots[d0] ?? null, unit: d1 };
    case EV['gps-lost']:
      return { reason: name(GPS_LOST_REASONS, d0) };
    case EV['gps-recovered']:
      return { movedMeters: d0 };
    case EV['task-failed']:
      return { reason: name(TASK_FAIL_REASONS, d0), attempt: d1 };
    case EV.refund:
      return { reason: name(REFUND_REASONS, d0), share: d1 / 100 };
    case EV['payment-recovered']:
      return { delayHours: d0 };
    case EV['lost-demand']:
      return {
        reason: name(LOST_REASONS, d0),
        riderType: name(RIDER_TYPE_NAMES, d1),
        // Only when both types were on the street and the rider chose.
        ...(d2 ? { wanted: name(WANTED_NAMES, d2) } : {}),
      };
    case EV['assist-cutoff']:
      return { atMeters: d0, pedalKmh: d1 / 10, batteryPercent: Math.floor(d2 / 10) };
    case EV['operator-notice']:
      return {
        category: name(CATEGORY_NAMES, d0),
        deadlineMinutes: d1,
        regime: name(TOW_REGIMES, d2),
      };
    case EV['district-removal']:
      return {
        category: name(CATEGORY_NAMES, d0),
        lotId: names.lots[d1] ?? null,
        district: '서초구',
      };
    default:
      return {};
  }
}

/** Event types that carry money in `amountWon` (§10). */
const MONEY = new Set<number>([
  EV['ride-end'],
  EV.refund,
  EV['photo-rejected'],
  EV['ride-end-refused'],
  EV['out-of-area'],
  EV['impound-release'],
  EV['rider-charge'],
  EV.fine,
  EV['payment-failed'],
  EV['payment-recovered'],
  EV.tow,
  EV.accident,
]);

export function formatEvent(
  columns: EventColumns,
  index: number,
  date: string,
  names: {
    crews: readonly string[];
    depots: readonly string[];
    lots: readonly string[];
    /** Scooters in the fleet; e-bike ids follow them. Omitted: all scooters. */
    scooters?: number;
    /** Type code per vehicle index (the window's `vType`). Omitted: all scooters. */
    vehicleTypes?: ArrayLike<number>;
  },
): SimulationEvent {
  const type = columns.type[index];
  const amount = columns.amount[index];
  const base = index * 4;
  const vehicle = columns.vehicle[index],
    crew = columns.crew[index];
  const event: SimulationEvent = {
    id: eventId(date, index),
    at: columns.t[index],
    type: EVENT_TYPES[type],
    ...(vehicle >= 0
      ? {
          vehicleId: vehicleIdOf(vehicle, names.scooters),
          vehicleType: VEHICLE_TYPE_NAMES[names.vehicleTypes?.[vehicle] ?? 0],
        }
      : {}),
    ...(crew >= 0 ? { crewId: names.crews[crew] } : {}),
    latitude: columns.lat[index],
    longitude: columns.lon[index],
    ...(MONEY.has(type) ? { amountWon: amount, ledger: LEDGER[type] } : {}),
    detail: eventDetail(
      type,
      amount,
      columns.detail[base],
      columns.detail[base + 1],
      columns.detail[base + 2],
      columns.detail[base + 3],
      names,
    ),
    simulated: true,
  };
  return event;
}
