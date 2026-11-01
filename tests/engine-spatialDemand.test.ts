import assert from 'node:assert/strict';
import test from 'node:test';
import { ASSUMPTIONS } from '../src/common/engine/simulation/assumptions.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import {
  bundledFootWeights,
  FOOT_HOURS,
  footCellOf,
  footWeekdayAt,
} from '../src/common/engine/simulation/foot-traffic.js';
import {
  bundledParkingRules,
  ParkingRules,
} from '../src/common/engine/simulation/parking-rules.js';
import { Engine, GRID_BOUNDS } from '../src/common/engine/simulation/sim-engine.js';
import { buildSpatialDemand } from '../src/common/engine/simulation/spatial-demand.js';

const demand = bundledDemand();
const foot = bundledFootWeights();
// The engine's 500 m grid (§9.5), rebuilt here so the demand map can be read without a window.
const cellLatitude = 500 / 111_195,
  cellLongitude = 500 / (111_195 * Math.cos((37.55 * Math.PI) / 180));
const rows = Math.ceil((GRID_BOUNDS.north - GRID_BOUNDS.south) / cellLatitude),
  cols = Math.ceil((GRID_BOUNDS.east - GRID_BOUNDS.west) / cellLongitude);
const grid = {
  cells: rows * cols,
  cell(latitude: number, longitude: number) {
    const row = Math.floor((latitude - GRID_BOUNDS.south) / cellLatitude),
      col = Math.floor((longitude - GRID_BOUNDS.west) / cellLongitude);
    return row < 0 || col < 0 || row >= rows || col >= cols ? -1 : row * cols + col;
  },
};
const real = { scooter: ASSUMPTIONS.fleet.scooterDefault, ebike: ASSUMPTIONS.fleet.ebikeDefault };

test('the shipped foot-traffic weights load: 6,906 cells of 250 m, five layers, each dock a 구', () => {
  assert.ok(foot, 'foot weights');
  assert.equal(foot.listed.length, 6_906);
  assert.equal(foot.gu.length, 25);
  assert.equal(foot.guOfDock.length, demand.count);
  assert.ok(foot.guOfDock.every((gu) => gu >= 0));
  // 잠실역 holds the busiest cell of the weekday day layer (10.5 in the OSM-based file, 21 in the
  // NGII-based one), well above the mean of 1.
  assert.ok(footWeekdayAt(foot, 37.5135, 127.1016) > 8);
  assert.ok(footCellOf(foot, 37.5135, 127.1016) >= 0);
  for (const day of ['weekday', 'weekend'] as const)
    for (let hour = 0; hour < 24; hour++) {
      const total = FOOT_HOURS[day][hour].reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(total - 1) < 1e-12, `${day} ${hour} layer weights sum to 1`);
    }
});

test('foot traffic moves riders between docks but keeps each hour’s riders per type', () => {
  const spatial = buildSpatialDemand(demand, real, grid);
  const plain = buildSpatialDemand(demand, real, grid, null);
  assert.ok(spatial.dockRate && plain.dockRate);
  for (const day of ['weekday', 'weekend'] as const)
    for (let type = 0; type < 2; type++)
      for (let hour = 0; hour < 24; hour++) {
        let blended = 0,
          table = 0;
        for (let dock = 0; dock < demand.count; dock++) {
          blended += spatial.dockRate[type][day][dock * 24 + hour];
          table += plain.dockRate[type][day][dock * 24 + hour];
        }
        assert.ok(Math.abs(blended - table) <= table * 1e-4, `${day} type ${type} hour ${hour}`);
      }
  // Riders a day follow ASSUMPTIONS.demand.ridersPerDay × typeShare at the real fleet.
  for (const day of ['weekday', 'weekend'] as const)
    for (let type = 0; type < 2; type++) {
      let riders = 0;
      for (let index = 0; index < demand.count * 24; index++)
        riders += spatial.dockRate[type][day][index];
      const expected =
        ASSUMPTIONS.demand.ridersPerDay[day] * ASSUMPTIONS.demand.typeShare[day][type];
      assert.ok(Math.abs(riders - expected) < expected * 1e-4, `${day} type ${type} ${riders}`);
    }
});

test('scooter riders are shared over the 자치구 by scooterGuShare before foot traffic places them', () => {
  const spatial = buildSpatialDemand(demand, real, grid);
  const byGu = new Float64Array(foot!.gu.length);
  let total = 0;
  for (let dock = 0; dock < demand.count; dock++)
    for (let hour = 0; hour < 24; hour++) {
      const rate = spatial.dockRate![0].weekday[dock * 24 + hour];
      byGu[foot!.guOfDock[dock]] += rate;
      total += rate;
    }
  const shares = ASSUMPTIONS.foot.scooterGuShare as Readonly<Record<string, number>>;
  foot!.gu.forEach((name, gu) =>
    assert.ok(Math.abs(byGu[gu] / total - shares[name]) < 0.005, `${name} ${byGu[gu] / total}`),
  );
});

test('a test fleet keeps the real demand per vehicle; a bigger one does not draw more riders', () => {
  const small = buildSpatialDemand(demand, { scooter: 6_000, ebike: 0 }, grid);
  const large = buildSpatialDemand(demand, { scooter: 30_000, ebike: 0 }, grid);
  const ratio = small.scale.weekday / large.scale.weekday;
  assert.ok(Math.abs(ratio - 6_000 / ASSUMPTIONS.fleet.scooterDefault) < 1e-9);
});

test('crews see the cells without a dock: busy and door cells are rebalanced too (§22 M4)', () => {
  const rules = new ParkingRules(bundledParkingRules(), demand);
  const engine = new Engine({
    demand,
    rules,
    seed: 'jigak',
    fleet: 4_000,
    fleets: { scooter: 3_000, ebike: 1_000 },
    startsAt: Date.parse('2026-11-04T04:00:00+09:00'),
    endsAt: Date.parse('2026-11-05T04:00:00+09:00'),
    date: '2026-11-04',
  });
  const active: number[] = (engine.ops as unknown as { activeCells: number[] }).activeCells;
  const dockless = active.filter((cell) => engine.cellDock[cell] < 0);
  assert.ok(dockless.length > 300, `${dockless.length} active cells without a dock`);
  assert.ok(active.length > dockless.length);
});
