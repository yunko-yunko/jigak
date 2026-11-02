import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ASSUMPTIONS, VEHICLE_TYPES } from '../src/common/engine/simulation/assumptions.js';
import { serviceDayOf } from '../src/common/engine/simulation/calendar.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { vehicleIdOf, vehicleIndexOf } from '../src/common/engine/simulation/event-log.js';
import {
  bundledParkingRules,
  ParkingRules,
} from '../src/common/engine/simulation/parking-rules.js';
import {
  EV,
  FAULT,
  FINE_KINDS,
  OP_NAMES,
  VTYPE,
  WANTED,
} from '../src/common/engine/simulation/sim-codes.js';
import {
  buildWindowSync,
  SimWindow,
  type WindowData,
} from '../src/common/engine/simulation/sim-window.js';

/**
 * Kick-scooters and shared e-bikes in one engine (§19). A scooter-only run must stay
 * byte-identical to the simulator before e-bikes existed; a mixed run keeps each type whole.
 */
const demand = bundledDemand();
const rules = new ParkingRules(bundledParkingRules(), demand);
const HOUR = 3_600_000;

function request(date: string, scooter: number, ebike: number) {
  const day = serviceDayOf(Date.parse(`${date}T12:00:00+09:00`));
  return {
    date: day.date,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    seed: 'jigak',
    fleet: scooter + ebike,
    fleets: { scooter, ebike },
    modelVersion: 'golden',
  };
}

/** The window as it was before e-bikes: its old columns in their old order and its old meta. */
function legacyHash(data: WindowData) {
  const arrays = [
    data.vStart,
    data.iT,
    data.iOp,
    data.iLat,
    data.iLon,
    data.iBattery,
    data.iMeta,
    data.events.t,
    data.events.type,
    data.events.vehicle,
    data.events.crew,
    data.events.lat,
    data.events.lon,
    data.events.amount,
    data.events.detail,
    data.checkpointEvent,
    data.checkpoints,
    data.cStart,
    data.cT,
    data.cState,
    data.cLat,
    data.cLon,
    data.cDestLat,
    data.cDestLon,
    data.cEta,
    data.cTask,
    data.cLoad,
    data.cVehicles,
    data.cVehicleCount,
    data.vehiclePool,
    data.dT,
    data.dValues,
    data.lT,
    data.lValues,
    data.oT,
    data.oValues,
  ];
  const hash = createHash('sha256');
  const seen = new Set<ArrayBufferLike>();
  for (const array of arrays) {
    if (seen.has(array.buffer)) continue;
    seen.add(array.buffer);
    hash.update(new Uint8Array(array.buffer));
  }
  const meta = data.meta;
  hash.update(
    JSON.stringify({
      date: meta.date,
      startsAt: meta.startsAt,
      endsAt: meta.endsAt,
      warmupFrom: meta.warmupFrom,
      dayType: meta.dayType,
      fleet: meta.fleet,
      seed: meta.seed,
      modelVersion: meta.modelVersion,
      geometry: meta.geometry,
      crews: meta.crews.map(({ id, type, depot, shift }) => ({ id, type, depot, shift })),
      depots: meta.depots.map((depot) => ({
        id: depot.id,
        name: depot.name,
        latitude: depot.latitude,
        longitude: depot.longitude,
        capacity: depot.capacity,
        chargerSlots: depot.chargerSlots,
        spares: depot.spares,
        mechanicsWeekday: depot.mechanicsWeekday,
        mechanicsWeekend: depot.mechanicsWeekend,
      })),
    }),
  );
  return hash.digest('hex').slice(0, 16);
}

test('with no e-bikes the window is byte-identical to the scooter-only simulator', () => {
  for (const [date, expected] of [
    ['2026-11-03', 'f24dc191e687a77e'],
    ['2026-11-05', '73baeccd6b92eff9'],
  ] as const) {
    assert.equal(legacyHash(buildWindowSync(request(date, 6_000, 0), demand, rules)), expected);
    const { fleets: _fleets, ...legacy } = request(date, 6_000, 0);
    assert.equal(legacyHash(buildWindowSync(legacy, demand, rules)), expected, 'old request shape');
  }
});

test('vehicle ids are numbered within each type', () => {
  assert.equal(vehicleIdOf(0), 'JS00001');
  assert.equal(vehicleIdOf(3_999, 4_000), 'JS04000');
  assert.equal(vehicleIdOf(4_000, 4_000), 'JB00001');
  assert.equal(vehicleIndexOf('JB00001', 4_000, 8_000), 4_000);
  assert.equal(vehicleIndexOf('JS04000', 4_000, 8_000), 3_999);
  assert.equal(vehicleIndexOf('JS04001', 4_000, 8_000), -1);
  assert.equal(vehicleIndexOf('JB08001', 4_000, 8_000), -1);
  assert.equal(vehicleIndexOf('JB00001', 4_000), -1);
  assert.equal(vehicleIndexOf('XX00001', 4_000, 8_000), -1);
});

test('the e-bike numbers follow bicycle law: no helmet, licence or two-rider fines', () => {
  const [scooter, ebike] = VEHICLE_TYPES;
  assert.deepEqual(scooter.fines, ASSUMPTIONS.money.fines);
  assert.equal(scooter.battery.metersPerPercent, ASSUMPTIONS.battery.metersPerPercent);
  assert.equal(ebike.fines.drunk, 30_000);
  assert.equal(ebike.fines['drunk-refusal'], 100_000);
  assert.ok(!ebike.police.helmetFined && !ebike.police.unlicensedFined);
  assert.ok(ebike.maxKmh <= 25);
  for (const range of ebike.cruiseKmh) assert.ok(range[0] >= 15 && range[1] <= 21);
  const shares = (types: readonly { share: number }[]) => types.reduce((a, b) => a + b.share, 0);
  assert.ok(Math.abs(shares(ebike.faults.types) - 1) < 1e-9);
  for (const type of ebike.faults.types) assert.ok(ebike.repair[type.code], type.code);
});

test('a mixed fleet keeps each type whole and its e-bike rides pedal on past the assist cut-off', () => {
  const scooters = 4_000,
    ebikes = 8_000;
  const data = buildWindowSync(request('2026-11-05', scooters, ebikes), demand, rules);
  const view = new SimWindow(data);
  assert.deepEqual(data.meta.fleets, { scooter: scooters, ebike: ebikes });
  for (let vehicle = 0; vehicle < view.fleet; vehicle++)
    assert.equal(view.vType(vehicle), vehicle < scooters ? VTYPE.SCOOTER : VTYPE.EBIKE);
  for (let slot = 0; slot < data.iBattery.length; slot++) {
    assert.ok(Number.isFinite(data.iBattery[slot]) && data.iBattery[slot] >= 0);
    assert.ok(data.iOp[slot] < OP_NAMES.length);
  }
  for (const hour of [0, 4, 8, 12, 16, 20]) {
    const counts = [0, 0];
    for (let vehicle = 0; vehicle < view.fleet; vehicle++) {
      const state = view.vehicle(vehicle, data.meta.startsAt + hour * HOUR);
      assert.ok(OP_NAMES.includes(state.state));
      assert.ok(state.battery >= 0);
      assert.equal(state.id.slice(0, 2), vehicle < scooters ? 'JS' : 'JB');
      counts[view.vType(vehicle)]++;
    }
    assert.deepEqual(counts, [scooters, ebikes]);
  }

  const events = data.events;
  const fines = [new Array(FINE_KINDS.length).fill(0), new Array(FINE_KINDS.length).fill(0)];
  const cutAt = new Map<number, number>();
  let ebikeMeters = 0,
    ebikeSeconds = 0,
    ebikeRides = 0,
    cutoffs = 0,
    continued = 0,
    wanted = 0;
  for (let index = 0; index < events.t.length; index++) {
    const type = events.type[index],
      vehicle = events.vehicle[index];
    const d = events.detail.subarray(index * 4, index * 4 + 4);
    if (type === EV.fine) fines[data.vType[vehicle]][d[0]]++;
    if (type === EV['lost-demand'] && d[2] >= WANTED.SCOOTER && d[2] <= WANTED.EITHER) wanted++;
    if (type === EV['assist-cutoff']) {
      assert.equal(data.vType[vehicle], VTYPE.EBIKE);
      cutoffs++;
      cutAt.set(vehicle, d[0]);
    }
    if (type === EV['ride-end']) {
      const cut = cutAt.get(vehicle);
      if (cut !== undefined) {
        cutAt.delete(vehicle);
        assert.ok(d[1] > cut, 'the ride goes on past the cut-off');
        assert.notEqual(d[3] & 15, 2, 'not ended by the battery');
        continued++;
      }
      if (data.vType[vehicle] === VTYPE.EBIKE && (d[3] & 15) === 0 && d[0] > 0) {
        ebikeMeters += d[1];
        ebikeSeconds += d[0];
        ebikeRides++;
      }
    }
  }
  // §22 an e-bike gets 1.31 riders a day at most (was 3.6).
  assert.ok(ebikeRides > 5_000, `e-bike rides ${ebikeRides}`);
  const kmh = (ebikeMeters / ebikeSeconds) * 3.6;
  assert.ok(kmh >= 11 && kmh <= 16, `e-bike ride speed ${kmh}`);
  for (const kind of ['helmet', 'unlicensed', 'two-riders'] as const)
    assert.equal(fines[VTYPE.EBIKE][FINE_KINDS.indexOf(kind)], 0, kind);
  // §22 at Seoul's demand (1.31 riders an e-bike) a pack rarely runs flat mid-ride, so a window
  // may hold none; every one that happens still pedals on.
  assert.equal(continued, cutoffs, `assist cut-offs ${cutoffs}`);
  assert.ok(wanted > 0, 'lost demand records what the rider wanted');
});

test('a motor, sensor or BMS fault found mid-ride ends the assist there and the pack stops draining', () => {
  // Every e-bike ride grows a fault that shows within a few hundred metres and is reported:
  // half dead motors, sensors or BMS, half display faults that change nothing about the ride.
  const faults = VEHICLE_TYPES[VTYPE.EBIKE].faults;
  const saved = {
    hazardPerKm: faults.hazardPerKm,
    revealPerKm: faults.revealPerKm,
    types: faults.types.map((type) => ({ ...type })),
  };
  const writable = faults as { hazardPerKm: number; revealPerKm: number };
  const types = faults.types as unknown as { code: string; share: number; midRideReport: number }[];
  writable.hazardPerKm = 5;
  writable.revealPerKm = 4;
  for (const type of types) {
    type.share =
      type.code === 'display-qr'
        ? 0.5
        : type.code === 'motor-sensor' || type.code === 'battery-bms'
          ? 0.25
          : 0;
    type.midRideReport = 1;
  }
  let data: WindowData;
  try {
    // 6,000 e-bikes: a few hundred faulted rides, enough to compare speeds (1,500 gave about 25).
    data = buildWindowSync(request('2026-11-05', 0, 6_000), demand, rules);
  } finally {
    writable.hazardPerKm = saved.hazardPerKm;
    writable.revealPerKm = saved.revealPerKm;
    saved.types.forEach((type, index) => Object.assign(types[index], type));
  }
  const events = data.events,
    battery = new Map<number, number>(),
    ended = new Map<number, number[]>(),
    cutoffAt = new Map<number, number>();
  const sums = {
    [FAULT.MOTOR_SENSOR]: [0, 0, 0, 0],
    [FAULT.BMS]: [0, 0, 0, 0],
    [FAULT.DISPLAY]: [0, 0, 0, 0],
  };
  for (let index = 0; index < events.t.length; index++) {
    const type = events.type[index],
      vehicle = events.vehicle[index],
      t = events.t[index];
    const d = events.detail.subarray(index * 4, index * 4 + 4);
    if (type === EV.rent) battery.set(vehicle, d[1]);
    if (type === EV['assist-cutoff']) cutoffAt.set(vehicle, t);
    // Rides already under way when the window opens have no rent here and are skipped.
    if (type === EV['ride-end'] && battery.has(vehicle))
      ended.set(vehicle, [t, d[0], d[1], battery.get(vehicle)! - d[2]]);
    if (type === EV['ride-end']) battery.delete(vehicle);
    // A fault reported mid-ride is logged right after its ride's end, at the same instant.
    if (type === EV.fault && d[1] === 3 && ended.get(vehicle)?.[0] === t) {
      const [, seconds, meters, used] = ended.get(vehicle)!;
      const sum = sums[d[0] as keyof typeof sums];
      if (!sum) continue;
      sum[0]++;
      sum[1] += used / 10;
      sum[2] += meters / VEHICLE_TYPES[VTYPE.EBIKE].battery.metersPerPercent;
      sum[3] += seconds;
      if (d[0] !== FAULT.DISPLAY) {
        // Pedalling after the fault draws nothing and the battery never reaches its cut-off.
        assert.ok(used / 10 <= meters / VEHICLE_TYPES[VTYPE.EBIKE].battery.metersPerPercent + 0.1);
        assert.ok(!(cutoffAt.get(vehicle)! > t - seconds * 1000), 'a motor fault is no cut-off');
      }
    }
  }
  const display = sums[FAULT.DISPLAY];
  assert.ok(display[0] > 20, `display-fault rides ${display[0]}`);
  // A display fault leaves the ride as it was; a dead motor stops the drain where it shows.
  assert.ok(
    Math.abs(display[1] / display[2] - 1) < 0.02,
    `display drain ${display[1] / display[2]}`,
  );
  // The rider pedals on from there, slower than the assisted display-fault rides.
  const speed = (sum: number[]) => sum[2] / sum[3];
  for (const code of [FAULT.MOTOR_SENSOR, FAULT.BMS]) {
    const sum = sums[code];
    assert.ok(sum[0] > 10, `fault ${code} rides ${sum[0]}`);
    assert.ok(sum[1] / sum[2] < 0.6, `fault ${code} drain ${sum[1] / sum[2]}`);
  }
  // Speeds are compared over both dead-assist kinds together; one kind alone is too noisy.
  const dead = [FAULT.MOTOR_SENSOR, FAULT.BMS].map((code) => sums[code]);
  const pooled = [0, 1, 2, 3].map((index) => dead[0][index] + dead[1][index]);
  assert.ok(speed(pooled) < 0.85 * speed(display), `speeds ${speed(pooled)}, ${speed(display)}`);
});
