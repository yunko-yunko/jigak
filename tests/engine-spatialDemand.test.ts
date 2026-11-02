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
import {
  buildDestinationChoice,
  ringQuantilesKm,
  ringRange,
} from '../src/common/engine/simulation/destination-choice.js';
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

test('§22.10 the daily balance gives every dock back about the riders it sends, both day types', () => {
  const { destinations } = buildSpatialDemand(demand, real, grid);
  const [low, high] = ASSUMPTIONS.demand.balanceClip;
  for (const day of ['weekday', 'weekend'] as const) {
    const [before, after] = destinations.imbalance[day];
    // Without it a quarter of the riders end at another dock than the ones that send them.
    assert.ok(before > 0.2, `${day} unbalanced ${before}`);
    assert.ok(after < 0.015, `${day} balanced ${after}`);
    const balance = destinations.balance[day];
    assert.ok(balance.every((value) => value >= low && value <= high));
    // Each trip end's weight is its attraction (return weight + floor) × its balance.
    const returns = buildSpatialDemand(demand, real, grid).returnWeight![day];
    for (const dock of [0, 100, 1_000, demand.count - 1])
      for (const hour of [3, 8, 18]) {
        const expected =
          (returns[dock * 24 + hour] + ASSUMPTIONS.demand.returnWeightFloor) * balance[dock];
        assert.ok(Math.abs(destinations.weight[day][dock * 24 + hour] - expected) < 1e-9);
      }
    // The pair table keeps its own trips, each target weighted by its balance.
    const origin = demand.odStart.findIndex((start, dock) => demand.odStart[dock + 1] - start > 3);
    const from = demand.odStart[origin],
      to = demand.odStart[origin + 1];
    let running = 0;
    for (let slot = from; slot < to; slot++) {
      running +=
        (demand.odCumulative[slot] - (slot > from ? demand.odCumulative[slot - 1] : 0)) *
        balance[demand.odTo[slot]];
      assert.ok(Math.abs(destinations.odCumulative[day][slot] - running) < 1e-9);
    }
  }
});

test('§22.10 the destination model is the same for the same inputs, built again from scratch', () => {
  const spatial = buildSpatialDemand(demand, real, grid);
  // A copy of the table is another cache key: the neighbours and the balance are computed again.
  const copy = { ...demand };
  const again = buildDestinationChoice(copy, spatial.dockRate!, spatial.returnWeight!);
  assert.notEqual(again, spatial.destinations);
  assert.deepEqual(again.start, spatial.destinations.start);
  assert.deepEqual(again.near, spatial.destinations.near);
  for (const day of ['weekday', 'weekend'] as const) {
    assert.deepEqual(again.balance[day], spatial.destinations.balance[day]);
    assert.deepEqual(again.weight[day], spatial.destinations.weight[day]);
  }
  // Neighbours are sorted by distance and stop at `ringMaxMeters`.
  const { start, meters } = spatial.destinations;
  for (const dock of [0, 500, 2_000]) {
    for (let k = start[dock] + 1; k < start[dock + 1]; k++) assert.ok(meters[k] >= meters[k - 1]);
    assert.ok(meters[start[dock + 1] - 1] <= ASSUMPTIONS.demand.ringMaxMeters);
  }
});

test('§22.10 the ring holds the docks at the drawn distance; the balance spreads over the rider mix', () => {
  const { destinations } = buildSpatialDemand(demand, real, grid);
  const range = new Int32Array(2);
  const { ringHalfWidth, ringWiden } = ASSUMPTIONS.demand;
  for (const dock of [10, 700, 1_900])
    for (const meters of [400, 1_800, 4_000])
      for (let widening = 0; widening < 3; widening++) {
        if (!ringRange(destinations, dock, meters, widening, range)) continue;
        const width = ringHalfWidth * Math.pow(ringWiden, widening);
        for (let k = range[0]; k < range[1]; k++) {
          assert.ok(destinations.meters[k] >= meters * (1 - width));
          assert.ok(destinations.meters[k] < meters * (1 + width));
        }
      }
  // Equal-probability distances of the rider types' log-normals (§5.1): in their ranges, rising,
  // the median between the student's 1.2 km and the late-night rider's 2.5 km.
  const flat = new Array(24).fill(1);
  for (const day of ['weekday', 'weekend'] as const) {
    const km = ringQuantilesKm(flat, day, demand.loopShare);
    assert.equal(km.length, ASSUMPTIONS.demand.ringQuantiles);
    for (let index = 1; index < km.length; index++) assert.ok(km[index] > km[index - 1]);
    assert.ok(km[0] >= 0.4 && km[km.length - 1] <= 7);
    const median = (km[11] + km[12]) / 2;
    assert.ok(median > 1.2 && median < 2.5, `${day} median ${median}`);
  }
});
