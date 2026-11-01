import assert from 'node:assert/strict';
import test from 'node:test';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { Stream } from '../src/common/engine/simulation/keyed-random.js';
import {
  bundledParkingRules,
  metersApart,
  ParkingRules,
} from '../src/common/engine/simulation/parking-rules.js';
import { OP, VTYPE } from '../src/common/engine/simulation/sim-codes.js';
import { Engine, GRID_BOUNDS } from '../src/common/engine/simulation/sim-engine.js';
import { serviceDayOf } from '../src/common/engine/simulation/shared-scooter-sim.js';
import { compactWindow, SimWindow } from '../src/common/engine/simulation/sim-window.js';

/**
 * The simulator's speed-ups (docs/2026-11-01-scooter-simulation.md §21.7) change no result: the
 * indexes they read answer exactly what a scan of every vehicle answers.
 */
const demand = bundledDemand();
const rules = new ParkingRules(bundledParkingRules(), demand);
const day = serviceDayOf(Date.parse('2026-11-04T12:00:00+09:00'));
const engine = new Engine({
  demand,
  rules,
  seed: 'jigak',
  fleet: 1_600,
  fleets: { scooter: 600, ebike: 1_000 },
  startsAt: day.startsAt,
  endsAt: day.endsAt,
  date: day.date,
});
engine.run();
const view = new SimWindow(
  compactWindow(
    engine,
    {
      date: day.date,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
      seed: 'jigak',
      fleet: 1_600,
      fleets: { scooter: 600, ebike: 1_000 },
      modelVersion: 'test',
    },
    rules,
  ),
);

test('vehicles near a point on the rider grid match a scan of the whole fleet', () => {
  const stream = new Stream().reseed(20261104);
  let total = 0;
  for (let query = 0; query < 400; query++) {
    const latitude = GRID_BOUNDS.south + 0.1 + stream.next() * 0.15,
      longitude = GRID_BOUNDS.west + 0.1 + stream.next() * 0.3,
      meters = 50 + stream.next() * 1_150,
      type = query % 3 === 0 ? -1 : query % 3 === 1 ? VTYPE.SCOOTER : VTYPE.EBIKE;
    const expected: number[] = [];
    for (let vehicle = 0; vehicle < engine.fleet; vehicle++)
      if (
        engine.op[vehicle] === OP.AVAILABLE &&
        (type < 0 || engine.vType[vehicle] === type) &&
        metersApart(latitude, longitude, engine.lat[vehicle], engine.lon[vehicle]) <= meters
      )
        expected.push(vehicle);
    const found: number[] = [];
    engine.forEachAvailableNear(latitude, longitude, meters, type, (vehicle, distance) => {
      assert.equal(
        distance,
        metersApart(latitude, longitude, engine.lat[vehicle], engine.lon[vehicle]),
      );
      found.push(vehicle);
    });
    assert.deepEqual(
      found.sort((left, right) => left - right),
      expected,
    );
    assert.equal(engine.countAvailableNear(latitude, longitude, meters, type), expected.length);
    total += expected.length;
  }
  assert.ok(total > 300, `${total} vehicles found`);
});

test('the door load counts every rentable vehicle set down at a door', () => {
  const load = new Int32Array(engine.doorLoad.length);
  for (let vehicle = 0; vehicle < engine.fleet; vehicle++) {
    const door = engine.doorOfVehicle[vehicle];
    if (door >= 0 && engine.rentable(vehicle)) load[door]++;
  }
  assert.deepEqual(engine.doorLoad, load);
  assert.ok(
    load.reduce((sum, count) => sum + count, 0) > 100,
    'riders and crews set vehicles down at doors',
  );
});

test('a window search on the position index returns what a scan of every vehicle returns', () => {
  const stream = new Stream().reseed(20261101);
  let total = 0;
  for (let query = 0; query < 600; query++) {
    const point = {
        latitude: GRID_BOUNDS.south + 0.08 + stream.next() * 0.18,
        longitude: GRID_BOUNDS.west + 0.08 + stream.next() * 0.34,
      },
      radius = 100 + stream.next() * 1_400,
      time = day.startsAt + Math.floor(stream.next() * (day.endsAt - day.startsAt)),
      which = query % 2 ? 'rentable' : 'field';
    const indexed = view.nearby(point, radius, time, which);
    const scanned = view.nearby(point, radius, time, which, { scan: true });
    assert.deepEqual(indexed, scanned);
    const perType = 1 + (query % 7);
    assert.deepEqual(
      view.nearby(point, radius, time, which, { perType }),
      scanned.filter(
        (vehicle, at) =>
          scanned.slice(0, at).filter((before) => before.type === vehicle.type).length < perType,
      ),
    );
    total += indexed.length;
  }
  assert.ok(total > 300, `${total} vehicles found`);
});
