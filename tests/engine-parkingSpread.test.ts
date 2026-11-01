import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSUMPTIONS } from '../src/common/engine/simulation/assumptions.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import {
  bundledParkingRules,
  metersApart,
  ParkingRules,
  Placement,
} from '../src/common/engine/simulation/parking-rules.js';
import { VTYPE } from '../src/common/engine/simulation/sim-codes.js';

const rules = new ParkingRules(bundledParkingRules(), bundledDemand());

/** A deterministic draw in [0, 1) (an LCG), so the test needs no engine stream. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Sets 40 vehicles down at one spot through `spreadSpot` with a crowd count like the engine's
 * (`riders.ts crowdOf`: vehicles within 1 m, plus one when 5 m holds `spotMeters5Cap`).
 */
function spread(type: number, start: Placement, seed: number) {
  const placed: [number, number][] = [];
  const crowd = (latitude: number, longitude: number) => {
    let close = 0,
      within5 = 0;
    for (const [lat, lon] of placed) {
      const meters = metersApart(latitude, longitude, lat, lon);
      if (meters <= 5) within5++;
      if (meters <= ASSUMPTIONS.doors.coordinateMeters) close++;
    }
    return close + (within5 >= ASSUMPTIONS.doors.spotMeters5Cap ? 1 : 0);
  };
  const next = lcg(seed);
  const [near, far] = ASSUMPTIONS.doors.spreadMeters;
  for (let load = 0; load < 40; load++) {
    const out = new Placement();
    Object.assign(out, start);
    rules.spreadSpot(type, near + (far - near) * next(), next() * 2 * Math.PI, load, out, crowd);
    placed.push([out.latitude, out.longitude]);
  }
  return placed;
}

/** Legal spots for `type` on the 15 m rings `spreadSpot` searches around a start. */
function ringRoom(type: number, start: Placement) {
  let room = 0;
  for (let ring = 1.5; ring <= 15 + 1e-9; ring += 1.5)
    for (let bearing = 0; bearing < 8; bearing++) {
      const angle = (bearing * Math.PI) / 4;
      const effect = rules.returnEffect(
        type,
        start.latitude + (ring * Math.sin(angle)) / 111_195,
        start.longitude + (ring * Math.cos(angle)) / (111_195 * Math.cos((37.55 * Math.PI) / 180)),
      );
      if (effect === 0 || (start.discouraged && effect === 1)) room++;
    }
  return room;
}

function assertSpread(placed: [number, number][], start: Placement, name: string) {
  for (let a = 0; a < 20; a++)
    for (let b = a + 1; b < 20; b++)
      assert.ok(
        metersApart(placed[a][0], placed[a][1], placed[b][0], placed[b][1]) > 1,
        `${name}: vehicles ${a} and ${b} within 1 m`,
      );
  const stayed = placed.filter(
    ([lat, lon]) => metersApart(lat, lon, start.latitude, start.longitude) < 0.5,
  ).length;
  assert.ok(stayed <= 1, `${name}: ${stayed} vehicles left on the spot itself`);
}

test('vehicles sent to a 용산 PM zone stand apart, not on one point (§22, startup-spec T6.1)', () => {
  const zones = rules.returns.pointsOf(rules.returns.spotLayerOf(VTYPE.SCOOTER)!);
  assert.equal(zones.length / 2, 5, 'the five official zones');
  let checked = 0;
  for (let zone = 0; zone < zones.length / 2; zone++) {
    const start = new Placement();
    rules.legalSpot(VTYPE.SCOOTER, zones[zone * 2] + 30 / 111_195, zones[zone * 2 + 1], start);
    // A zone with no room for 20 is left out: 한강진's geocoded point sits in a building, 3 of the
    // 80 ring points around its legal spot are clean (a data gap, U-YONGSAN §7).
    if (start.noReturn || ringRoom(VTYPE.SCOOTER, start) < 20) continue;
    checked++;
    assertSpread(spread(VTYPE.SCOOTER, start, 7 + zone), start, `zone ${zone}`);
  }
  assert.ok(checked >= 3, `${checked} zones with room`);
});

test('an e-bike left at a discouraged door spot spreads too (the old early return is gone)', () => {
  const start = new Placement();
  let door = -1;
  for (let index = 0; index < rules.doors.meta.points && door < 0; index++) {
    rules.doorSpot(VTYPE.EBIKE, index, start);
    if (start.discouraged && !start.noReturn) door = index;
  }
  assert.ok(door >= 0, 'a discouraged e-bike door spot');
  assertSpread(spread(VTYPE.EBIKE, start, 99), start, `door ${door}`);
});
