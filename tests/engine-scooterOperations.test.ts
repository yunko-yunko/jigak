import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { ASSUMPTIONS, VEHICLE_TYPES } from '../src/common/engine/simulation/assumptions.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { computeModelVersion } from '../src/common/engine/simulation/model-version.js';
import {
  allocate,
  compareDispatch,
  DEPOT_TYPE_WIDTH,
} from '../src/common/engine/simulation/operations.js';
import {
  bundledParkingRules,
  inSeocho,
  metersApart,
  ParkingRules,
  parseParkingRules,
  Placement,
} from '../src/common/engine/simulation/parking-rules.js';
import {
  ALLOWED_TRANSITIONS,
  CATEGORY,
  CATEGORY_NAMES,
  EV,
  EVENT_TYPES,
  FIELD,
  FINE_KINDS,
  IMMEDIATE_TOW,
  LAYER,
  OP,
  OP_NAMES,
  REGIME,
  STAGE,
  VEHICLE_TYPE_NAMES,
  VTYPE,
  WANTED_NAMES,
  type OpStateName,
} from '../src/common/engine/simulation/sim-codes.js';
import { RETURN } from '../src/common/engine/simulation/return-rules.js';
import {
  Engine,
  windowStart,
  type WindowInput,
} from '../src/common/engine/simulation/sim-engine.js';
import { Stream } from '../src/common/engine/simulation/keyed-random.js';
import { MIX } from '../src/common/engine/simulation/riders.js';
import { inHourBand } from '../src/common/engine/simulation/calendar.js';
import { C } from '../src/common/engine/simulation/ledger.js';
import {
  serviceDayOf,
  SharedScooterSimulation,
} from '../src/common/engine/simulation/shared-scooter-sim.js';
import {
  compactWindow,
  SimWindow as SimWindowView,
  type SimWindow,
} from '../src/common/engine/simulation/sim-window.js';

/**
 * The operating model of the demo scooter simulator (docs/2026-11-01-scooter-simulation.md §16):
 * state machine, movement, crews, ledger, enforcement, determinism, the 04:00 seam, the route
 * policy and the realism bands. One inline-built simulation is shared; each window is ~1 s.
 */
const HOUR = 3_600_000,
  MINUTE = 60_000;
const at = (iso: string) => Date.parse(`${iso}+09:00`);
const TUESDAY = '2026-11-03',
  SATURDAY = '2026-11-07',
  JUNE = '2026-06-10',
  CHRISTMAS = '2026-12-25',
  WINTER_WEEKDAY = '2027-01-13';
// Tests keep the measured 6,000-scooter fleet; the default is Seoul's real fleet (§21).
const simulation = new SharedScooterSimulation({ builder: 'inline', cacheSize: 10, fleet: 6_000 });
const FLEET = simulation.fleet;
const rules = new ParkingRules(bundledParkingRules(), bundledDemand());

const windowOf = (date: string): SimWindow => simulation.window(at(`${date}T12:00:00`))!;
const dayOf = (date: string) => serviceDayOf(at(`${date}T12:00:00`));

const allowed = new Set(ALLOWED_TRANSITIONS.map(([from, to]) => from * 100 + to));
const depotPoints = ASSUMPTIONS.depots.map((depot) => [depot.latitude, depot.longitude] as const);
const lotPoints = ASSUMPTIONS.lots.map((lot) => [lot.latitude, lot.longitude] as const);
const atOneOf = (points: readonly (readonly [number, number])[], lat: number, lon: number) =>
  points.some(([pointLat, pointLon]) => metersApart(pointLat, pointLon, lat, lon) < 1);

/** Events of one type in a window, with their decoded detail columns. */
function eventsOf(view: SimWindow, type: (typeof EVENT_TYPES)[number]) {
  const events = view.data.events,
    code = EVENT_TYPES.indexOf(type);
  const found: {
    index: number;
    t: number;
    vehicle: number;
    lat: number;
    lon: number;
    amount: number;
    d: number[];
  }[] = [];
  for (let index = 0; index < events.t.length; index++)
    if (events.type[index] === code)
      found.push({
        index,
        t: events.t[index],
        vehicle: events.vehicle[index],
        lat: events.lat[index],
        lon: events.lon[index],
        amount: events.amount[index],
        d: Array.from(events.detail.subarray(index * 4, index * 4 + 4)),
      });
  return found;
}

/** Realism metrics of a served day (§16.7). */
function metrics(view: SimWindow) {
  const day = view.meta;
  const counters = view.counters(day.endsAt - 1);
  const abandoned = eventsOf(view, 'reserve-ended').filter((event) => event.d[0] === 0).length;
  const rides = counters[C.rides],
    lost = counters[C.lost];
  const hourly = (hour: number) => view.status(day.startsAt + ((hour - 4 + 24) % 24) * HOUR);
  const rentsByHour = new Array<number>(24).fill(0);
  for (const event of eventsOf(view, 'rent'))
    rentsByHour[new Date(event.t + 9 * HOUR).getUTCHours()]++;
  return {
    counters,
    rides,
    lost,
    arrivals: rides + lost + abandoned,
    hourly,
    rentsByHour,
  };
}

test('every vehicle is in exactly one operating state, the fleet is conserved and rentable means available', () => {
  for (const date of [TUESDAY, SATURDAY]) {
    const day = dayOf(date);
    for (let time = day.startsAt; time < day.endsAt; time += 30 * MINUTE) {
      const status = simulation.status(time);
      assert.ok(status.ready);
      const total = Object.values(status.states).reduce((sum, count) => sum + count, 0);
      assert.equal(total, FLEET, `${date} ${new Date(time).toISOString()} conserves the fleet`);
      assert.equal(status.available, status.rentable);
      // §15.1: hidden vehicles stay in the available state but are not rentable.
      assert.equal(status.rentable, status.states.available - status.parking.hiddenAvailable);
      // `on-crew-van` and `deploying` are van cargo, plus the depot intake inspection (T17).
      const cargo = simulation
        .crews(time)
        .crews.reduce((sum, crew) => sum + ('load' in crew ? (crew.load ?? 0) : 0), 0);
      assert.equal(
        status.states['on-crew-van'] + status.states.deploying,
        cargo + status.depots.intakeInspection,
        `${date} ${new Date(time).toISOString()} van cargo`,
      );
    }
    // Field attributes live on field vehicles only; rentable ones carry a usable battery.
    const time = day.startsAt + 9 * HOUR;
    for (const vehicle of simulation.vehicles(time)) {
      assert.equal(vehicle.field, FIELD[OP_NAMES.indexOf(vehicle.state)] === 1);
      if (!vehicle.field) assert.equal(vehicle.parking, null);
      if (vehicle.rentable) {
        assert.equal(vehicle.state, 'available');
        assert.equal(vehicle.hidden, false);
        assert.ok(
          vehicle.battery >= ASSUMPTIONS.battery.lowPercent,
          `${vehicle.id} ${vehicle.battery}%`,
        );
      }
    }
  }
});

test('every recorded state change is an allowed transition (§3.5 T1–T32)', () => {
  for (const date of [TUESDAY, SATURDAY, CHRISTMAS]) {
    const data = windowOf(date).data;
    let changes = 0;
    for (let vehicle = 0; vehicle < FLEET; vehicle++)
      for (let slot = data.vStart[vehicle] + 1; slot < data.vStart[vehicle + 1]; slot++) {
        const from = data.iOp[slot - 1],
          to = data.iOp[slot];
        if (from === to) continue;
        changes++;
        assert.ok(
          allowed.has(from * 100 + to),
          `${date} JS${vehicle + 1}: ${OP_NAMES[from]} → ${OP_NAMES[to]}`,
        );
      }
    // §22 Seoul's riders are fixed (1.83 a scooter, was 4.6), so fewer state changes a day.
    assert.ok(changes > 10_000, `${changes} transitions on ${date}`);
  }
});

test('a vehicle moves only by a ride, a crew, a tow truck or a GPS-lost spell (§3.4)', () => {
  const limits = ASSUMPTIONS.parking;
  for (const date of [TUESDAY, SATURDAY]) {
    const data = windowOf(date).data;
    const movers: Record<string, number> = {};
    for (let vehicle = 0; vehicle < FLEET; vehicle++)
      for (let slot = data.vStart[vehicle] + 1; slot < data.vStart[vehicle + 1]; slot++) {
        const a = slot - 1;
        const meters = metersApart(data.iLat[a], data.iLon[a], data.iLat[slot], data.iLon[slot]);
        if (meters === 0) continue;
        const from = data.iOp[a],
          to = data.iOp[slot];
        const name = `${OP_NAMES[from]}→${OP_NAMES[to]}`;
        movers[name] = (movers[name] ?? 0) + 1;
        const where = `${date} JS${vehicle + 1} ${name} ${meters.toFixed(1)} m`;
        if (from === OP.IN_USE) assert.ok(FIELD[to] || to === OP.OUT_OF_AREA, where);
        else if (FIELD[from] && FIELD[to])
          // A patrol re-park or a swap crew's tidy-up; farther only off a no-return spot (§20.3).
          assert.ok(
            meters <= limits.reparkMaxMeters + 1 ||
              (rules.returnEffect(VTYPE.SCOOTER, data.iLat[a], data.iLon[a]) === RETURN.NO_RETURN &&
                rules.returnEffect(VTYPE.SCOOTER, data.iLat[slot], data.iLon[slot]) !==
                  RETURN.NO_RETURN),
            where,
          );
        else if (from === OP.MISSING)
          assert.ok(
            meters <= ASSUMPTIONS.missing.movedMaxMeters + limits.landSnapRingMeters + 20,
            where,
          );
        else if (from === OP.ON_CREW_VAN && to === OP.ON_CREW_VAN)
          assert.ok(atOneOf(depotPoints, data.iLat[slot], data.iLon[slot]), where);
        else if (from === OP.TOWING)
          assert.ok(atOneOf(lotPoints, data.iLat[slot], data.iLon[slot]), where);
        else if ((from === OP.WRITTEN_OFF || from === OP.DEPLOYING) && to === OP.DEPOT_READY)
          assert.ok(atOneOf(depotPoints, data.iLat[slot], data.iLon[slot]), where);
        else
          assert.ok(
            (from === OP.ON_CREW_VAN || from === OP.DEPLOYING) && to === OP.AVAILABLE,
            `unexplained move: ${where}`,
          );
      }
    assert.ok(movers['in-use→available'] > 4_000, JSON.stringify(movers));
    assert.ok(movers['on-crew-van→available'] > 100, 'vans rebalance');
    assert.ok(movers['deploying→available'] > 50, 'vans deploy');
  }
});

test('crews keep within capacity and shift, take only urgent jobs at meals, and end shifts at their depot', () => {
  for (const date of [TUESDAY, SATURDAY]) {
    const view = windowOf(date);
    const data = view.data;
    const day = view.meta;
    view.meta.crews.forEach((crew, index) => {
      const shift = ASSUMPTIONS.shifts[crew.shift];
      const depot = depotPoints[crew.depot];
      for (let row = data.cStart[index]; row < data.cStart[index + 1]; row++) {
        const time = data.cT[row],
          state = data.cState[row];
        const load = data.cLoad[row];
        if (crew.type === 0)
          assert.ok(load <= ASSUMPTIONS.capacity.vanVehicles, `${crew.id} van load ${load}`);
        if (crew.type === 1)
          assert.ok(
            Math.floor(load / 100) + (load % 100) <= ASSUMPTIONS.capacity.swapSlots,
            `${crew.id} carries ${load}`,
          );
        if (state === 0) {
          // Off: the shift has just ended at the depot, or the crew is not on duty.
          const previous = row - 1;
          if (previous >= data.cStart[index] && data.cState[previous] !== 0) {
            assert.equal(
              data.cState[previous],
              1,
              `${crew.id} idle before going off at ${new Date(time).toISOString()}`,
            );
            assert.ok(
              metersApart(depot[0], depot[1], data.cLat[previous], data.cLon[previous]) < 1,
              `${crew.id} back at its depot`,
            );
          }
          continue;
        }
        // On duty only inside its own shift.
        const hours = ((((time + 9 * HOUR) % (24 * HOUR)) + 24 * HOUR) % (24 * HOUR)) / HOUR;
        const inside =
          shift.end <= 24
            ? hours >= shift.start && hours < shift.end
            : hours >= shift.start || hours < shift.end - 24;
        assert.ok(
          inside || time === day.startsAt,
          `${crew.id} works at ${hours.toFixed(2)}h on ${date}`,
        );
        // A meal already running at the day's first snapshot started earlier.
        if (state === 6 && time > day.startsAt) {
          const next = row + 1;
          if (
            next < data.cStart[index + 1] &&
            data.cT[next] < time + ASSUMPTIONS.meal.minutes * MINUTE
          ) {
            const nextState = data.cState[next];
            if (nextState === 2 || nextState === 3)
              assert.equal(
                data.cTask[next] % 100,
                1,
                `${crew.id} leaves a meal only for priority 1`,
              );
          }
        }
      }
    });
  }
});

test('the ledger: day totals are sums of event amounts; fares, storage fees and pass-through follow §8 and §10', () => {
  for (const date of [TUESDAY, SATURDAY]) {
    const view = windowOf(date);
    const status = view.status(view.meta.endsAt - 1);
    const money = status.today.money;
    const sum = (type: (typeof EVENT_TYPES)[number]) =>
      eventsOf(view, type).reduce((total, event) => total + event.amount, 0);
    assert.equal(money.rideRevenue, sum('ride-end'));
    assert.equal(money.refunds, sum('refund'));
    assert.equal(money.riderPenalties, sum('photo-rejected') + sum('ride-end-refused'));
    assert.equal(money.outOfAreaFees, sum('out-of-area'));
    assert.equal(money.passedToRiders, sum('rider-charge'));
    assert.equal(money.paymentFailed, sum('payment-failed'));
    assert.equal(money.paymentRecovered, sum('payment-recovered'));
    assert.equal(status.today.fines.sumWon, sum('fine'));
    const releases = eventsOf(view, 'impound-release');
    assert.equal(money.towFees + money.storageFees, sum('impound-release'));
    assert.equal(
      money.operatorNet,
      money.rideRevenue -
        money.paymentFailed +
        money.paymentRecovered +
        money.riderPenalties +
        money.outOfAreaFees +
        money.passedToRiders -
        money.refunds -
        money.towFees -
        money.storageFees,
    );
    const prices = ASSUMPTIONS.money;
    for (const ride of eventsOf(view, 'ride-end')) {
      const auto = (ride.d[3] & 15) === 1,
        designated = (ride.d[3] & 16) !== 0;
      const base =
        prices.unlockFeeWon + prices.perMinuteWon * Math.max(1, Math.ceil(ride.d[0] / 60));
      if (auto) assert.ok(ride.amount <= prices.autoEndCapWon, `auto-ended fare ${ride.amount}`);
      else {
        assert.equal(
          (ride.amount - prices.unlockFeeWon + (designated ? prices.designatedDiscountWon : 0)) %
            prices.perMinuteWon,
          0,
        );
        assert.ok(
          ride.amount >= base - prices.designatedDiscountWon,
          `fare ${ride.amount} for ${ride.d[0]} s`,
        );
      }
    }
    for (const release of releases) {
      assert.equal(release.d[2], prices.towFeeWon);
      assert.equal(release.d[3], prices.storageWonPer30Minutes * Math.ceil(release.d[1] / 30));
      assert.equal(release.amount, release.d[2] + release.d[3]);
    }
    for (const tow of eventsOf(view, 'tow'))
      assert.equal(tow.amount, 0, 'a tow itself is a zero-won record');
    for (const photo of eventsOf(view, 'photo-rejected'))
      assert.equal(
        photo.amount,
        photo.d[1] === 1 ? prices.photoPenaltyWon : 0,
        'only riders who leave pay',
      );
    const towedImmediate = new Set(
      eventsOf(view, 'tow')
        .filter((tow) => tow.d[1] === 1 && IMMEDIATE_TOW[tow.d[0]])
        .map((tow) => tow.vehicle),
    );
    for (const charge of eventsOf(view, 'rider-charge')) {
      const release = releases.find(
        (event) => event.vehicle === charge.vehicle && event.t === charge.t,
      );
      assert.ok(release, 'a pass-through comes with its release');
      assert.equal(charge.amount, release.amount);
      // Towed today at an immediate-tow spot, or towed before the day started.
      assert.ok(
        towedImmediate.has(charge.vehicle) ||
          !eventsOf(view, 'tow').some((tow) => tow.vehicle === charge.vehicle && tow.d[1] === 1),
      );
    }
  }
});

test('complaints, towing and impound lots follow the district rules (§7)', () => {
  for (const date of [TUESDAY, SATURDAY]) {
    const view = windowOf(date);
    const [towFrom, towTo] = ASSUMPTIONS.towing.hours;
    const complaints = eventsOf(view, 'complaint');
    const dispatched = eventsOf(view, 'tow').filter((event) => event.d[1] === 0);
    for (const tow of eventsOf(view, 'tow').filter((event) => event.d[1] === 1)) {
      const hour = new Date(tow.t + 9 * HOUR).getUTCHours();
      assert.ok(hour >= towFrom && hour < towTo, `tow at ${hour}h`);
      assert.ok(
        IMMEDIATE_TOW[tow.d[0]] || tow.d[0] !== CATEGORY.PROPER,
        'only violations are towed',
      );
      // Dispatched today before the pickup, or reported before the day began.
      const sent = dispatched.find((event) => event.vehicle === tow.vehicle && event.t <= tow.t);
      const startSlot = view.interval(tow.vehicle, view.meta.startsAt);
      assert.ok(
        sent || ((view.data.iMeta[startSlot] >> 8) & 0xf) > 0,
        `JS${tow.vehicle + 1} towed unreported`,
      );
      if (sent && !IMMEDIATE_TOW[sent.d[0]]) {
        const first = complaints.find(
          (event) => event.vehicle === tow.vehicle && event.t <= sent.t,
        );
        if (first)
          assert.ok(
            sent.t - first.t >= ASSUMPTIONS.towing.graceMinutes * MINUTE - 1,
            'grace categories wait out the operator grace period',
          );
      }
      // Never outside the service area.
      const before = view.interval(tow.vehicle, tow.t - 1);
      assert.notEqual(view.data.iOp[before], OP.OUT_OF_AREA);
    }
    for (const release of eventsOf(view, 'impound-release')) {
      const [open, close] = ASSUMPTIONS.lotHours[dayOf(date).dayType];
      const hour = ((release.t + 9 * HOUR) % (24 * HOUR)) / HOUR;
      assert.ok(hour >= open && hour <= close, `release at ${hour.toFixed(2)}h`);
    }
    // A queued tow that the vehicle escaped (rented, re-parked) is cancelled, never towed.
    const cancelled = eventsOf(view, 'tow-cancelled');
    assert.ok(cancelled.length > 0);
  }
});

test('parking: geometric violations sit in their feature buffer, proper spots outside the tow buffers and the no-return rules, all on land', () => {
  const view = windowOf(TUESDAY);
  const buffers = ASSUMPTIONS.parking.bufferMeters;
  const layerOf = {
    [CATEGORY.SUBWAY_EXIT]: LAYER.EXIT,
    [CATEGORY.BUS_TAXI]: LAYER.BUS,
    [CATEGORY.CROSSWALK]: LAYER.CROSSWALK,
  } as Record<number, number>;
  const bufferOf = {
    [LAYER.EXIT]: buffers.subwayExit,
    [LAYER.BUS]: buffers.busStop,
    [LAYER.CROSSWALK]: buffers.crosswalk,
  } as Record<number, number>;
  let geometric = 0;
  for (const event of eventsOf(view, 'improper-parking')) {
    if (!event.d[2]) continue;
    const layer = layerOf[event.d[0]];
    assert.ok(layer, `geometry flag on ${event.d[0]}`);
    const scan = rules.nearScan(event.lat, event.lon, bufferOf[layer] + 1);
    assert.ok(
      scan.index[layer] >= 0,
      `geometric ${event.d[0]} within its ${bufferOf[layer]} m buffer`,
    );
    geometric++;
  }
  assert.ok(geometric > 30, `${geometric} geometric violations`);
  for (const hour of [6, 12, 18, 23]) {
    const time = view.meta.startsAt + (hour - 4) * HOUR;
    let proper = 0,
      inBuffer = 0,
      noReturn = 0;
    for (const vehicle of simulation.vehicles(time)) {
      if (!vehicle.field || vehicle.state === 'out-of-area') continue;
      // On the land proxy: near a dock, stop, exit or crosswalk, by a door point (§20.1) or at
      // a designated spot (§20.3).
      const near = rules.nearScan(vehicle.latitude, vehicle.longitude, 120);
      assert.ok(
        [0, 1, 2, 3].some((layer) => near.index[layer] >= 0) ||
          rules.nearDoor(vehicle.latitude, vehicle.longitude, 60) ||
          rules.nearSpot(vehicle.latitude, vehicle.longitude, 60),
        `${vehicle.id} at ${vehicle.latitude},${vehicle.longitude} is off the land proxy`,
      );
      if (vehicle.parking !== 'proper') continue;
      proper++;
      if (rules.immediateHit(vehicle.latitude, vehicle.longitude)) inBuffer++;
      const type = VEHICLE_TYPE_NAMES.indexOf(vehicle.type);
      if (rules.returnEffect(type, vehicle.latitude, vehicle.longitude) === RETURN.NO_RETURN)
        noReturn++;
    }
    // Only dock-fallback spots (and fallen, unfixed ones) may sit inside a tow buffer or a
    // no-return zone of the rule table (§20.3).
    assert.ok(
      inBuffer / proper <= 0.02,
      `${inBuffer} of ${proper} proper vehicles in a tow buffer at ${hour}h`,
    );
    assert.ok(
      noReturn / proper <= 0.02,
      `${noReturn} of ${proper} proper vehicles in a no-return zone at ${hour}h`,
    );
  }
});

test('the same seed agrees in every instance, in any build order and in the worker; another seed differs', async () => {
  const time = at(`${TUESDAY}T08:30:00`);
  const first = new SharedScooterSimulation({ builder: 'inline', fleet: 6_000 });
  // Build the next day first: windows are independent of the order they are computed in.
  first.window(at('2026-11-04T08:30:00'));
  const second = new SharedScooterSimulation({ builder: 'inline', fleet: 6_000 });
  for (const other of [first, second]) {
    assert.deepEqual(other.status(time), simulation.status(time));
    assert.deepEqual(other.vehicles(time), simulation.vehicles(time));
    assert.deepEqual(other.events({ limit: 500 }, time), simulation.events({ limit: 500 }, time));
    assert.deepEqual(other.crews(time), simulation.crews(time));
  }
  const worker = new SharedScooterSimulation({ fleet: 6_000 });
  try {
    await worker.ensure(time);
    assert.deepEqual(worker.window(time)!.data, windowOf(TUESDAY).data, 'worker = buildWindowSync');
  } finally {
    await worker.close();
  }
  const reseeded = new SharedScooterSimulation({
    builder: 'inline',
    seed: 'another',
    fleet: 6_000,
  });
  assert.notDeepEqual(reseeded.vehicles(time), simulation.vehicles(time));
  assert.notEqual(reseeded.status(time).modelVersion, undefined);
});

test('rider types follow the hourly mix and 따릉이 destinations the pair table (§5.1, §5.3)', () => {
  const stream = new Stream().reseed(20261101);
  // Every hour draws its own four-way table, not the tail of a running total.
  for (const day of ['weekday', 'weekend'] as const)
    for (let hour = 0; hour < 24; hour++) {
      const band = ASSUMPTIONS.riderMix[day].find(([first, last]) =>
        inHourBand(hour, first, last),
      )!;
      const counts = [0, 0, 0, 0];
      for (let draw = 0; draw < 4000; draw++)
        counts[stream.weightedSegment(MIX[day], hour * 4, hour * 4 + 4) - hour * 4]++;
      counts.forEach((count, type) =>
        assert.ok(
          Math.abs(count / 4000 - band[2][type]) < 0.03,
          `${day} ${hour}h type ${type}: ${count / 4000} vs ${band[2][type]}`,
        ),
      );
    }
  // Destination pairs: each origin's draws match its trip counts.
  const demand = bundledDemand();
  let origins = 0,
    distance = 0;
  for (let origin = 0; origin < demand.count && origins < 120; origin += 7) {
    const from = demand.odStart[origin],
      to = demand.odStart[origin + 1];
    if (to - from < 3) continue;
    origins++;
    const draws = 3000,
      counts = new Map<number, number>();
    for (let draw = 0; draw < draws; draw++) {
      const slot = stream.weightedSegment(demand.odCumulative, from, to);
      assert.ok(slot >= from && slot < to);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    const total = demand.odCumulative[to - 1];
    let tv = 0;
    for (let slot = from; slot < to; slot++) {
      const share =
        (demand.odCumulative[slot] - (slot > from ? demand.odCumulative[slot - 1] : 0)) / total;
      tv += Math.abs((counts.get(slot) ?? 0) / draws - share);
    }
    distance += tv / 2;
  }
  assert.ok(origins >= 50);
  assert.ok(distance / origins < 0.06, `mean total-variation distance ${distance / origins}`);
  // In the engine, rentals carry the rider type: the weekday hours keep their own mix.
  const shares = (hours: number[]) => {
    const counts = [0, 0, 0, 0];
    for (const event of eventsOf(windowOf(TUESDAY), 'rent'))
      if (hours.includes(new Date(event.t + 9 * HOUR).getUTCHours())) counts[event.d[0]]++;
    const sum = counts.reduce((a, b) => a + b, 0);
    return counts.map((count) => count / sum);
  };
  const peak = shares([7, 8, 9]),
    midday = shares([10, 11, 12, 13, 14]),
    night = shares([23, 0, 1, 2, 3]);
  // Late-night riders appear by day only to fetch a vehicle they hid overnight (§5.8).
  assert.ok(peak[0] > 0.6 && peak[3] < 0.02, `07–09 ${peak.join(' ')}`);
  assert.ok(midday[2] > 0.55 && midday[3] < 0.02, `10–14 ${midday.join(' ')}`);
  assert.ok(night[3] > 0.6, `23–03 ${night.join(' ')}`);
});

test('the template keeps the rider grid and per-cell counts in step with every state', () => {
  const day = dayOf(TUESDAY);
  const engine = new Engine({
    demand: bundledDemand(),
    rules,
    seed: 'jigak',
    fleet: FLEET,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    date: day.date,
  });
  engine.ops.initTemplate(engine.warmupFrom);
  let rentable = 0,
    available = 0,
    gridded = 0;
  for (let vehicle = 0; vehicle < FLEET; vehicle++) {
    if (engine.rentable(vehicle)) rentable++;
    if (engine.op[vehicle] === OP.AVAILABLE) available++;
    if (engine.riderGrid.has(vehicle)) {
      gridded++;
      assert.equal(engine.op[vehicle], OP.AVAILABLE, `vehicle ${vehicle} in the rider grid`);
    }
  }
  assert.equal(gridded, available);
  assert.equal(
    engine.cellAvailable.reduce((sum, count) => sum + count, 0),
    rentable,
  );
  // The template starts every non-street state the steady state has.
  for (const op of [OP.MISSING, OP.IMPOUNDED, OP.DEPOT_REPAIR, OP.DEPOT_READY, OP.WRITTEN_OFF])
    assert.ok(
      engine.op.some((value) => value === op),
      OP_NAMES[op],
    );
});

test('state counts converge over two weeks and the template starts near that steady state (§11.2)', () => {
  const day = dayOf('2026-11-24');
  const counts = (days: number) => {
    const input = {
      demand: bundledDemand(),
      rules,
      seed: 'jigak',
      fleet: FLEET,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
      date: day.date,
    };
    const engine = new Engine({ ...input, warmupFrom: day.startsAt - days * 24 * HOUR });
    engine.run();
    const view = new SimWindowView(
      compactWindow(engine, { ...input, seed: 'jigak', modelVersion: 'test' }, rules),
    );
    const status = view.status(day.startsAt);
    assert.ok(status.ready);
    return status.states;
  };
  const week = counts(7),
    fortnight = counts(14);
  const template = ASSUMPTIONS.template;
  const expected: [OpStateName, number][] = [
    ['low-battery', template.lowBattery],
    ['missing', template.missing],
    ['impounded', template.impounded],
    ['at-depot-repair', template.repair],
    ['written-off', template.writtenOff],
  ];
  for (const [name, share] of expected) {
    // One more week changes no state by more than 1% of the fleet: nothing keeps piling up.
    assert.ok(
      Math.abs(fortnight[name] - week[name]) <= FLEET * 0.01,
      `${name}: ${week[name]} after a week, ${fortnight[name]} after two`,
    );
    // And the template's share is within 1% of the fleet of where two weeks settle.
    assert.ok(
      Math.abs(fortnight[name] - share * FLEET) <= FLEET * 0.01,
      `${name}: template ${share * FLEET}, two weeks ${fortnight[name]}`,
    );
  }
});

test('the 04:00 seam: windows sharing an anchor continue exactly; a new anchor is no bigger a change than a day', () => {
  const kmCell = (latitude: number, longitude: number) =>
    `${Math.floor(latitude / (1000 / 111_195))}:${Math.floor(longitude / (1000 / (111_195 * Math.cos((37.55 * Math.PI) / 180))))}`;
  type Vehicles = ReturnType<typeof simulation.vehicles>;
  /** Share of 1 km cells (≥3 rentable on either side) whose rentable count stays within 20%. */
  const cellShare = (before: Vehicles, after: Vehicles) => {
    const count = (list: Vehicles) => {
      const cells = new Map<string, number>();
      for (const vehicle of list)
        if (vehicle.rentable) {
          const key = kmCell(vehicle.latitude, vehicle.longitude);
          cells.set(key, (cells.get(key) ?? 0) + 1);
        }
      return cells;
    };
    const a = count(before),
      b = count(after);
    let busy = 0,
      close = 0;
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(key) ?? 0,
        y = b.get(key) ?? 0;
      if (Math.max(x, y) < 3) continue;
      busy++;
      if (Math.abs(x - y) <= 0.2 * Math.max(x, y)) close++;
    }
    return close / busy;
  };
  const compare = (iso: string) => {
    const seam = at(iso);
    const before = simulation.vehicles(seam - 1),
      after = simulation.vehicles(seam);
    const a = simulation.status(seam - 1),
      b = simulation.status(seam);
    assert.ok(a.ready && b.ready);
    let worst = 0;
    for (const name of OP_NAMES) worst = Math.max(worst, Math.abs(a.states[name] - b.states[name]));
    const identical = before.filter((vehicle, index) =>
      isDeepStrictEqual(vehicle, after[index]),
    ).length;
    // The same continuous run one day earlier: how much a day changes the map on its own.
    const natural = cellShare(simulation.vehicles(seam - 24 * HOUR), before);
    return { worst, cellShare: cellShare(before, after), natural, identical };
  };
  // 11-05 and 11-06 both start from the 11-03 04:00 anchor: one continuous simulation.
  assert.equal(
    windowStart(dayOf('2026-11-05').startsAt),
    windowStart(dayOf('2026-11-06').startsAt),
  );
  const continuous = compare('2026-11-06T04:00:00');
  assert.equal(continuous.worst, 0);
  assert.equal(continuous.cellShare, 1);
  assert.ok(continuous.identical >= FLEET - 10, `${continuous.identical} identical vehicles`);
  // 11-05 starts from a new anchor: vehicles part ways, but the state mix stays within 3% of
  // the fleet and the map changes no more than one day of the old run changed it (§11.4).
  assert.notEqual(
    windowStart(dayOf('2026-11-04').startsAt),
    windowStart(dayOf('2026-11-05').startsAt),
  );
  const fresh = compare('2026-11-05T04:00:00');
  assert.ok(fresh.worst <= FLEET * 0.03, `state counts differ by ${fresh.worst}`);
  assert.ok(
    fresh.cellShare >= fresh.natural - 0.05,
    `seam cells ${fresh.cellShare.toFixed(2)} vs a day ${fresh.natural.toFixed(2)}`,
  );
});

test('a permission lasts until the vehicle next leaves its spot: a rental, reservation, crew, tow, fault or GPS loss', () => {
  const view = windowOf(TUESDAY);
  const day = view.meta;
  // Every kind of next change is honoured.
  const kinds: (typeof EVENT_TYPES)[number][] = [
    'reserve',
    'rent',
    'collect',
    'tow',
    'fault',
    'gps-lost',
    'battery-theft',
    'patrol-repark',
  ];
  for (const type of kinds) {
    let checked = 0;
    for (const event of eventsOf(view, type)) {
      if (checked >= 40) break;
      const probe = event.t - 5 * MINUTE;
      if (probe < day.startsAt || event.vehicle < 0) continue;
      const id = `JS${String(event.vehicle + 1).padStart(5, '0')}`;
      const before = simulation.vehicle(id, probe)!;
      const later = simulation.vehicle(id, event.t)!;
      if (!before.rentable) continue;
      if (
        later.rentable &&
        later.latitude === before.latitude &&
        later.longitude === before.longitude
      )
        continue;
      const until = simulation.parkedUntil(id, probe)!;
      assert.ok(until <= event.t, `${type} at ${event.t} but parked until ${until}`);
      checked++;
    }
    if (['reserve', 'rent', 'collect'].includes(type))
      assert.ok(checked > 10, `${checked} ${type} checks`);
  }
  // And until then the vehicle stays rentable on the same spot.
  const time = day.startsAt + 9 * HOUR;
  const parked = simulation.vehicles(time).filter((vehicle) => vehicle.rentable);
  for (const vehicle of parked.filter((_, index) => index % 25 === 0).slice(0, 200)) {
    const until = simulation.parkedUntil(vehicle.id, time)!;
    assert.ok(until > time && until <= day.endsAt);
    for (let step = 1; step <= 4; step++) {
      const probe = time + Math.floor(((until - time) * step) / 5);
      if (probe >= until) continue;
      const later = simulation.vehicle(vehicle.id, probe)!;
      assert.ok(
        later.rentable &&
          later.latitude === vehicle.latitude &&
          later.longitude === vehicle.longitude,
      );
    }
    if (until < day.endsAt) {
      const after = simulation.vehicle(vehicle.id, until)!;
      assert.ok(
        !after.rentable ||
          after.latitude !== vehicle.latitude ||
          after.longitude !== vehicle.longitude,
      );
    }
  }
});

test('realism bands for 6,000 vehicles (§16.7)', () => {
  const tuesday = metrics(windowOf(TUESDAY));
  const saturday = metrics(windowOf(SATURDAY));
  const june = metrics(windowOf(JUNE));
  const christmas = metrics(windowOf(CHRISTMAS));
  const winter = metrics(windowOf(WINTER_WEEKDAY));
  const band = (name: string, value: number, low: number, high: number) =>
    assert.ok(value >= low && value <= high, `${name} ${value} outside ${low}–${high}`);
  // Weekday 08:00 rentable share, in a busy and in a quiet month (seasonal reserve, §9.7). §22:
  // at Seoul's real demand fewer packs run low and the November shelf is 2%, so up to 0.95.
  for (const day of [tuesday, june, winter])
    band('08:00 rentable share', day.hourly(8).rentable / FLEET, 0.7, 0.95);
  band('winter lost demand', winter.lost / winter.arrivals, 0, 0.25);
  for (const day of [tuesday, saturday, june]) {
    const c = day.counters;
    // Daytime low and dead batteries stay a small share of street vehicles thanks to swaps. §22.9
    // outside busy cells a hidden pack waits for its swap round (30 h for a scooter): up to 12%.
    for (let hour = 10; hour <= 18; hour++) {
      const s = day.hourly(hour);
      const field =
        s.states.available +
        s.states.reserved +
        s.states['low-battery'] +
        s.states['battery-dead'] +
        s.states.broken +
        s.states['out-of-area'];
      band(
        `${hour}h low+dead share`,
        (s.states['low-battery'] + s.states['battery-dead']) / field,
        0,
        0.12,
      );
      band(`${hour}h broken on the street`, s.states.broken / FLEET, 0, 0.015);
    }
    band('improper parking per ride', c[C.improper] / day.rides, 0.05, 0.15);
    band('tows a day', c[C.tows], 5, 40);
    band('faults found per ride', c[C.rideFaults] / day.rides, 0.001, 0.005);
    band(
      'unlock failures per attempt',
      c[C.unlockFailures] / (day.rides + c[C.unlockFailures]),
      0.01,
      0.03,
    );
    band(
      'vehicle not found per attempt',
      c[C.vehicleNotFound] / (day.rides + c[C.unlockFailures] + c[C.vehicleNotFound]),
      0.01,
      0.04,
    );
    band('lost demand', day.lost / day.arrivals, 0.005, 0.25);
    band('average fare', c[C.rideRevenue] / c[C.rideEnds], 2_400, 3_600);
    band('mid-ride battery deaths', c[C.batteryDeadMidRide] / day.rides, 0, 0.002);
    band('out-of-area returns', c[C.outOfArea], 1, 15);
    band('falls', c[C.falls], 50, 250);
    band('fall damage share', c[C.fallsDamaged] / c[C.falls], 0, 0.2);
    band('fines', c[C.fines], 5, 60);
    // About 0.1% a day (a ~3-year life); a day's count is Poisson, so the band allows 0.2%.
    band('write-offs', c[C.writeOffs], 0, FLEET * 0.002);
    if (c[C.impoundReleases] > 0)
      band('hours in the lot', c[C.impoundMinutes] / c[C.impoundReleases] / 60, 1, 30);
  }
  // §22 Seoul's riders: 1.83 a scooter in June, × 0.79 in November (R-DEMAND §5.3: 1.43).
  band('November rides per vehicle', tuesday.rides / FLEET, 0.8, 2);
  // Field swaps; vehicles rotating through the depot (overnight sweep, seasonal reserve) are
  // charged there instead, and the daytime low-battery share above shows the energy keeps up.
  // §22 fewer rides drain fewer packs, and swap crews are 0.4 of the old roster.
  band('weekday swaps', tuesday.counters[C.swaps], 200, 3_000);
  band('June swaps', june.counters[C.swaps], 300, 3_000);
  band('Christmas lost demand', christmas.lost / christmas.arrivals, 0, 0.25);
  // GPS signal losses only (not-found and not-returned are separate reasons).
  const signal = eventsOf(windowOf(TUESDAY), 'gps-lost').filter((event) => event.d[0] === 0).length;
  band('GPS signal losses', signal, 1, 10);
  // Weekday shape: 08 and 18 peaks, 03–04 the quietest hours (§22 hour weights: 04 is 0.53%).
  const hours = tuesday.rentsByHour;
  assert.ok(hours[8] > hours[3] * 8 && hours[18] > hours[3] * 8, JSON.stringify(hours));
  assert.ok([3, 4].includes(hours.indexOf(Math.min(...hours))), JSON.stringify(hours));
});

test('crews work 40–95% of their shift; open tasks do not pile up; depot stock stays within bounds', () => {
  for (const date of [TUESDAY, SATURDAY]) {
    const view = windowOf(date);
    const data = view.data,
      day = view.meta;
    const busy = [0, 0, 0],
      onShift = [0, 0, 0];
    view.meta.crews.forEach((crew, index) => {
      for (let row = data.cStart[index]; row < data.cStart[index + 1]; row++) {
        const from = Math.max(data.cT[row], day.startsAt);
        const to = row + 1 < data.cStart[index + 1] ? data.cT[row + 1] : day.endsAt;
        if (to <= from || data.cState[row] === 0) continue;
        onShift[crew.type] += to - from;
        if (data.cState[row] >= 2 && data.cState[row] <= 5) busy[crew.type] += to - from;
      }
    });
    busy.forEach((time, type) => {
      const share = time / onShift[type];
      assert.ok(
        share >= 0.4 && share <= 0.95,
        `${date} crew type ${type} busy ${share.toFixed(2)}`,
      );
    });
    const open = [0, 6, 12, 18, 23.99].map((hours) =>
      view.openTasksAt(day.startsAt + hours * HOUR).reduce((sum, count) => sum + count, 0),
    );
    assert.ok(open.at(-1)! <= open[0] * 1.5 + 50, `open tasks ${open.join(' → ')}`);
    assert.ok(
      open.some((count, index) => index > 0 && count < open[index - 1]),
      'the backlog also shrinks',
    );
    for (let hour = 0; hour < 24; hour++) {
      const time = day.startsAt + hour * HOUR;
      view.meta.depots.forEach((depot, index) => {
        const stock = view.depotAt(index, time);
        for (const value of Object.values(stock)) assert.ok(value >= 0);
        assert.ok(stock.chargingBatteries <= depot.chargerSlots);
        const over =
          stock.ready + stock.charging + stock.repair + stock.inspecting - depot.capacity;
        assert.ok(over <= depot.capacity * 0.1, `${depot.id} over capacity by ${over}`);
      });
    }
  }
});

test('no 04:00 reset: across a served day the state changes only through events', () => {
  // Inside one continuous simulation the 04:00 of 11-06 changes no more than a few vehicles.
  const seam = at('2026-11-06T04:00:00');
  const before = simulation.vehicles(seam - MINUTE),
    after = simulation.vehicles(seam + MINUTE);
  const changed = before.filter(
    (vehicle, index) =>
      vehicle.state !== after[index].state ||
      vehicle.latitude !== after[index].latitude ||
      vehicle.longitude !== after[index].longitude,
  ).length;
  assert.ok(changed < FLEET * 0.01, `${changed} vehicles changed across 04:00`);
});

test('geometry: an empty or broken file falls back to probabilities; station centroids are recognised', () => {
  const broken = parseParkingRules({ version: 'seoul-pm-parking-rules-v1', busStops: [[1, 2, 3]] });
  assert.equal(broken.meta.fallback, true);
  assert.equal(parseParkingRules(null).meta.fallback, true);
  const centroids = parseParkingRules({
    version: 'seoul-pm-parking-rules-v1',
    builtAt: 1,
    meta: { sources: [{ layer: 'subwayExits', notes: 'T-DATA station centroids used' }] },
    busStops: [[37.5, 127]],
    subwayExits: [[37.51, 127.01]],
    crosswalks: [[37.52, 127.02]],
  });
  assert.equal(centroids.meta.subwayKind, 'centroids');
  assert.equal(bundledParkingRules().meta.subwayKind, 'exits');
  assert.equal(bundledParkingRules().meta.fallback, false);

  const empty = parseParkingRules({
    version: 'seoul-pm-parking-rules-v1',
    busStops: [],
    subwayExits: [],
    crosswalks: [],
  });
  const fallback = new SharedScooterSimulation({
    builder: 'inline',
    fleet: 3_000,
    geometry: empty,
  });
  const time = at(`${TUESDAY}T20:00:00`);
  const status = fallback.status(time);
  assert.ok(status.ready);
  assert.equal(status.geometry.fallback, true);
  const view = fallback.window(time)!;
  const improper = eventsOf(view, 'improper-parking');
  assert.ok(improper.length > 100);
  assert.ok(
    improper.every((event) => event.d[2] === 0),
    'no geometric categories without geometry',
  );
  assert.ok(improper.some((event) => event.d[0] === CATEGORY.BUS_TAXI));
  assert.notEqual(fallback.modelVersion, simulation.modelVersion);
});

test('the model is a pure function: no Math.random, Date.now or clock reads in model sources', () => {
  const directory = new URL('../src/common/engine/simulation/', import.meta.url);
  const model = readdirSync(directory).filter(
    (name) =>
      name.endsWith('.ts') &&
      ![
        'shared-scooter-sim.ts',
        'sim-worker.ts',
        'simulated-vehicle-feed.ts',
        'scooter-policy.ts',
        'scooter-router.ts',
      ].includes(name),
  );
  assert.ok(model.length >= 14, model.join(', '));
  for (const name of model) {
    const source = readFileSync(new URL(name, directory), 'utf8');
    assert.doesNotMatch(source, /Math\.random|Date\.now|new Date\(\)|performance\.now/, name);
  }
});

test('the model version follows every assumption; dispatch keys must be finite integers', () => {
  const inputs = { demand: bundledDemand(), geometry: bundledParkingRules().meta };
  const base = computeModelVersion(inputs);
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(base, simulation.modelVersion);
  const changed = structuredClone(ASSUMPTIONS) as unknown as { towing: { graceMinutes: number } };
  changed.towing.graceMinutes = 61;
  assert.notEqual(computeModelVersion(inputs, changed), base);
  assert.notEqual(computeModelVersion(inputs, ASSUMPTIONS, 'other-revision'), base);
  assert.notEqual(computeModelVersion(inputs, ASSUMPTIONS, undefined, '0.0'), base);

  assert.ok(compareDispatch([1, 30, 4], [2, 1, 1]) < 0);
  assert.ok(compareDispatch([2, 30, 4], [2, 31, 1]) < 0);
  assert.ok(compareDispatch([2, 30, 4], [2, 30, 5]) < 0);
  assert.throws(() => compareDispatch([1, Number.NaN, 1], [1, 1, 1]), RangeError);
  assert.throws(() => compareDispatch([1, 1, 1], [1, Infinity, 1]), RangeError);
  assert.throws(() => compareDispatch([1, 1.5, 1], [1, 1, 1]), RangeError);
  assert.deepEqual(allocate(10, [0.5, 0.3, 0.2]), [5, 3, 2]);
  assert.deepEqual(allocate(3, [1, 1, 1, 1]), [1, 1, 1, 0]);
});

// ---- Kick-scooters and shared e-bikes in one engine (§19) ----

const MIXED = { scooter: 4_000, ebike: 8_000 } as const;
const fleetOfType = (type: number) => (type === VTYPE.EBIKE ? MIXED.ebike : MIXED.scooter);
const TYPE_NAMES = ['scooter', 'e-bike'];

function mixedInput(date: string, extra: Partial<WindowInput> = {}): WindowInput {
  const day = dayOf(date);
  return {
    demand: bundledDemand(),
    rules,
    seed: 'jigak',
    fleet: MIXED.scooter + MIXED.ebike,
    fleets: { ...MIXED },
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    date: day.date,
    ...extra,
  };
}

/** A mixed window together with its engine, whose crew columns carry the e-bike loads. */
function mixedRun(date: string, options: { ordinance2027?: boolean; hideScooters?: boolean } = {}) {
  const input = mixedInput(date, { ordinance2027: options.ordinance2027 });
  const engine = new Engine(input);
  if (options.hideScooters) {
    // Riders find vehicles through the rider grid only: keep every scooter out of it.
    const sync = engine.syncAvailability.bind(engine);
    engine.syncAvailability = (vehicle: number) => {
      sync(vehicle);
      if (engine.vType[vehicle] === VTYPE.SCOOTER) engine.riderGrid.remove(vehicle);
    };
  }
  engine.run();
  const view = new SimWindowView(
    compactWindow(engine, { ...input, seed: 'jigak', modelVersion: 'test' }, rules),
  );
  return { engine, view };
}
const mixedCache = new Map<string, ReturnType<typeof mixedRun>>();
const mixed = (date: string) => {
  if (!mixedCache.has(date)) mixedCache.set(date, mixedRun(date));
  return mixedCache.get(date)!;
};
/** 11-05 starts from the 11-03 anchor: a 72-hour window, the cheapest to build. */
const MIXED_DAY = '2026-11-05';

/** Operating-state counts per vehicle type at `time`. */
function typeStates(view: SimWindow, time: number) {
  const counts = [0, 1].map(() => new Array<number>(OP_NAMES.length).fill(0));
  for (let vehicle = 0; vehicle < view.fleet; vehicle++)
    counts[view.vType(vehicle)][view.op(vehicle, time)]++;
  return counts;
}

test('mixed fleet: each type is conserved, every vehicle has one state and rentable e-bikes carry their own minimum', () => {
  const { view } = mixed(MIXED_DAY);
  const day = view.meta;
  for (let time = day.startsAt; time < day.endsAt; time += 30 * MINUTE) {
    const counts = typeStates(view, time);
    counts.forEach((row, type) =>
      assert.equal(
        row.reduce((sum, count) => sum + count, 0),
        fleetOfType(type),
        `${TYPE_NAMES[type]} at ${new Date(time).toISOString()}`,
      ),
    );
  }
  let rentableEbikes = 0;
  for (let vehicle = 0; vehicle < view.fleet; vehicle++) {
    const state = view.vehicle(vehicle, day.startsAt + 9 * HOUR);
    const type = view.vType(vehicle);
    assert.equal(state.id.slice(0, 2), type === VTYPE.SCOOTER ? 'JS' : 'JB');
    if (!state.rentable) continue;
    assert.ok(
      state.battery >= VEHICLE_TYPES[type].battery.lowPercent,
      `${state.id} ${state.battery}%`,
    );
    if (type === VTYPE.EBIKE) rentableEbikes++;
  }
  assert.ok(rentableEbikes > MIXED.ebike * 0.7, `${rentableEbikes} rentable e-bikes at 13:00`);
});

test('mixed fleet: allowed transitions only, and an e-bike reaches TOWING only through 서초구 removal', () => {
  const { view } = mixed(MIXED_DAY);
  const data = view.data;
  const removals = new Set(
    eventsOf(view, 'district-removal').map((event) => `${event.vehicle}@${event.t}`),
  );
  let ebikeChanges = 0;
  for (let vehicle = 0; vehicle < view.fleet; vehicle++)
    for (let slot = data.vStart[vehicle] + 1; slot < data.vStart[vehicle + 1]; slot++) {
      const from = data.iOp[slot - 1],
        to = data.iOp[slot];
      if (from === to) continue;
      assert.ok(allowed.has(from * 100 + to), `${vehicle}: ${OP_NAMES[from]} → ${OP_NAMES[to]}`);
      if (view.vType(vehicle) !== VTYPE.EBIKE) continue;
      ebikeChanges++;
      if (to === OP.TOWING)
        assert.ok(removals.has(`${vehicle}@${data.iT[slot]}`), `e-bike ${vehicle} towed`);
    }
  assert.ok(ebikeChanges > 12_000, `${ebikeChanges} e-bike transitions`);
  // Seoul's PM towing never touches an e-bike, and no e-bike spot counts as tow-on-sight.
  for (const tow of eventsOf(view, 'tow')) assert.equal(view.vType(tow.vehicle), VTYPE.SCOOTER);
  const improper = eventsOf(view, 'improper-parking');
  assert.ok(improper.some((event) => view.vType(event.vehicle) === VTYPE.EBIKE));
  for (const event of improper)
    if (view.vType(event.vehicle) === VTYPE.EBIKE) assert.equal(event.d[1], 0, 'no immediate tow');
});

test('mixed fleet: vans count places (an e-bike takes two), swap crews carry both packs within their slots', () => {
  const { engine, view } = mixed(MIXED_DAY);
  const ops = engine.ops;
  let ebikeVans = 0,
    ebikePacks = 0;
  for (let row = 0; row < ops.cT.length; row++) {
    const crew = ops.crews[ops.cCrew.data[row]];
    const load = ops.cLoad.data[row],
      ebike = ops.cLoadB.data[row];
    if (crew.type === 0) {
      const places = load - ebike + ebike * VEHICLE_TYPES[VTYPE.EBIKE].ops.vanUnits;
      assert.ok(places <= ASSUMPTIONS.capacity.vanVehicles, `${crew.id} ${places} places`);
      if (ebike) ebikeVans++;
    } else if (crew.type === 1) {
      const all = Math.floor(load / 100) + (load % 100),
        packs = Math.floor(ebike / 100) + (ebike % 100);
      const slots = all - packs + packs * VEHICLE_TYPES[VTYPE.EBIKE].ops.batteryUnits;
      assert.ok(slots <= ASSUMPTIONS.capacity.swapSlots, `${crew.id} ${slots} slots`);
      if (packs) ebikePacks++;
    }
  }
  assert.ok(ebikeVans > 100 && ebikePacks > 100, `${ebikeVans} van rows, ${ebikePacks} swap rows`);
  // Both types are swapped, collected, deployed and rebalanced; a rebalance moves one type.
  for (const type of ['battery-swap', 'collect', 'deploy', 'rebalance'] as const) {
    const byType = [0, 0];
    for (const event of eventsOf(view, type)) byType[view.vType(event.vehicle)]++;
    assert.ok(byType[0] > 20 && byType[1] > 20, `${type} ${byType.join('/')}`);
  }
  const moves = new Map<string, Set<number>>();
  for (const event of eventsOf(view, 'rebalance')) {
    const key = `${event.t}:${event.d[0]}:${event.d[1]}`;
    if (!moves.has(key)) moves.set(key, new Set());
    moves.get(key)!.add(view.vType(event.vehicle));
  }
  for (const [key, types] of moves) assert.equal(types.size, 1, `rebalance ${key}`);
  // Depot rows per type add up to the totals.
  const width = DEPOT_TYPE_WIDTH * VEHICLE_TYPES.length;
  for (let row = 0; row < ops.dT.length; row++)
    for (const [column, offset] of [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5],
      [7, 6],
    ])
      assert.equal(
        ops.dValues.data[row * 8 + column],
        ops.dTypeValues.data[row * width + offset] +
          ops.dTypeValues.data[row * width + DEPOT_TYPE_WIDTH + offset],
      );
});

test('mixed fleet: the ledger adds up over both types; e-bike fares and fines follow their own tables', () => {
  const { view } = mixed(MIXED_DAY);
  const status = view.status(view.meta.endsAt - 1);
  const sumBy = (type: (typeof EVENT_TYPES)[number]) => {
    const sums = [0, 0];
    for (const event of eventsOf(view, type)) sums[view.vType(event.vehicle)] += event.amount;
    return sums;
  };
  const fares = sumBy('ride-end'),
    fines = sumBy('fine'),
    releases = sumBy('impound-release');
  assert.equal(status.today.money.rideRevenue, fares[0] + fares[1]);
  assert.equal(status.today.fines.sumWon, fines[0] + fines[1]);
  assert.equal(
    status.today.money.towFees + status.today.money.storageFees,
    releases[0] + releases[1],
  );
  assert.ok(fares[0] > 0 && fares[1] > fares[0], `fares ${fares.join(' / ')}`);
  const tariff = VEHICLE_TYPES[VTYPE.EBIKE].fares,
    discount = ASSUMPTIONS.money.designatedDiscountWon;
  let checked = 0;
  for (const ride of eventsOf(view, 'ride-end')) {
    if (view.vType(ride.vehicle) !== VTYPE.EBIKE || (ride.d[3] & 15) === 1) continue;
    const gross = ride.amount + ((ride.d[3] & 16) !== 0 ? discount : 0);
    assert.ok(
      [tariff.unlockDayWon, tariff.unlockNightWon].some(
        (unlock) =>
          gross >= unlock + tariff.perMinuteWon && (gross - unlock) % tariff.perMinuteWon === 0,
      ),
      `e-bike fare ${ride.amount}`,
    );
    checked++;
  }
  assert.ok(checked > 4_000);
  const ebikeFines = VEHICLE_TYPES[VTYPE.EBIKE].fines;
  for (const fine of eventsOf(view, 'fine')) {
    if (view.vType(fine.vehicle) !== VTYPE.EBIKE) continue;
    const kind = FINE_KINDS[fine.d[0]];
    assert.ok(!['helmet', 'unlicensed', 'two-riders'].includes(kind), kind);
    assert.equal(fine.amount, ebikeFines[kind]);
  }
  // 서초구 charges nothing for a removal.
  for (const release of eventsOf(view, 'impound-release'))
    if (view.vType(release.vehicle) === VTYPE.EBIKE) assert.equal(release.amount, 0);
});

test('e-bike parking: an operator notice everywhere, 서초구 removal in its zones, towing only under the 2027 ordinance', () => {
  // The outline: 서초구청, 고속터미널 and 교대역 inside; 시청, 강남구청 and 사당 west of the line outside.
  for (const [lat, lon] of [
    [37.4837, 127.0324],
    [37.5049, 127.0049],
    [37.4934, 127.0142],
  ])
    assert.ok(inSeocho(lat, lon), `${lat},${lon}`);
  for (const [lat, lon] of [
    [37.5665, 126.978],
    [37.5172, 127.0473],
    [37.4766, 126.97],
  ])
    assert.ok(!inSeocho(lat, lon), `${lat},${lon}`);

  // In the run: notices go to e-bikes only, 서초구 ones from its zones with a 1–3 hour deadline.
  const { view } = mixed(MIXED_DAY);
  const notices = eventsOf(view, 'operator-notice');
  assert.ok(notices.length > 20, `${notices.length} notices`);
  const zones = ASSUMPTIONS.ebike.towing.district.categories as readonly string[];
  for (const notice of notices) {
    assert.equal(view.vType(notice.vehicle), VTYPE.EBIKE);
    if (notice.d[2] === REGIME.DISTRICT) {
      assert.ok(inSeocho(notice.lat, notice.lon) && zones.includes(CATEGORY_NAMES[notice.d[0]]));
      assert.ok(notice.d[1] >= 60 && notice.d[1] <= 180, `${notice.d[1]} minutes`);
    } else {
      assert.equal(notice.d[2], REGIME.OPERATOR);
      assert.equal(notice.d[1], ASSUMPTIONS.ebike.towing.operatorReparkMinutes);
    }
  }

  // Step by step on a fresh template, at 10:00 on a Tuesday.
  const day = dayOf(TUESDAY);
  const ten = day.startsAt + 6 * HOUR;
  const fresh = (ordinance2027: boolean) => {
    const engine = new Engine(mixedInput(TUESDAY, { ordinance2027 }));
    engine.ops.initTemplate(engine.warmupFrom);
    return engine;
  };
  const street = (engine: Engine, skip: number[] = []) => {
    for (let vehicle = MIXED.scooter; vehicle < engine.fleet; vehicle++)
      if (engine.op[vehicle] === OP.AVAILABLE && !skip.includes(vehicle)) return vehicle;
    throw new Error('no e-bike on the street');
  };
  const park = (
    engine: Engine,
    vehicle: number,
    lat: number,
    lon: number,
    category: number,
    time: number,
  ) => {
    engine.moveTo(vehicle, lat, lon);
    engine.startSegment(vehicle, time, category);
  };
  const engine = fresh(false);
  const enforcement = engine.enforcement;

  // 서초구, at a subway exit: removal 1–3 hours later unless re-parked; no fee.
  const seocho = street(engine);
  park(engine, seocho, 37.4934, 127.0142, CATEGORY.SUBWAY_EXIT, ten - MINUTE);
  enforcement.complain(seocho, ten, 0);
  assert.equal(engine.stage[seocho], STAGE.REPORTED);
  assert.equal(enforcement.regime[seocho], REGIME.DISTRICT);
  const removeAt = engine.towReadyAt[seocho];
  assert.ok(removeAt >= ten + HOUR && removeAt <= ten + 3 * HOUR);
  enforcement.towReady(seocho, engine.segVersion[seocho], removeAt);
  assert.equal(engine.op[seocho], OP.TOWING);
  enforcement.impoundArrive(seocho, engine.version[seocho], removeAt + 30 * MINUTE);
  assert.equal(engine.op[seocho], OP.IMPOUNDED);
  assert.deepEqual(enforcement.releaseFees(seocho, 600), [0, 0]);

  // Elsewhere: the operator has two hours; past them nothing is towed and it stays reported.
  const cityHall = street(engine, [seocho]);
  park(engine, cityHall, 37.5665, 126.978, CATEGORY.CROSSWALK, ten - MINUTE);
  enforcement.complain(cityHall, ten, 0);
  assert.equal(enforcement.regime[cityHall], REGIME.OPERATOR);
  assert.equal(
    engine.graceUntil[cityHall],
    ten + ASSUMPTIONS.ebike.towing.operatorReparkMinutes * MINUTE,
  );
  enforcement.graceEnd(cityHall, engine.segVersion[cityHall], engine.graceUntil[cityHall]);
  enforcement.towReady(cityHall, engine.segVersion[cityHall], engine.graceUntil[cityHall]);
  assert.equal(engine.op[cityHall], OP.AVAILABLE);
  assert.equal(engine.stage[cityHall], STAGE.REPORTED);

  // A 서초구 removal due after 22:00 waits for the district's next morning.
  const late = street(engine, [seocho, cityHall]);
  const evening = day.startsAt + 17.9 * HOUR;
  park(engine, late, 37.5049, 127.0049, CATEGORY.SIDEWALK, evening - MINUTE);
  enforcement.complain(late, evening, 0);
  enforcement.towReady(late, engine.segVersion[late], day.startsAt + 18.5 * HOUR);
  assert.equal(engine.op[late], OP.AVAILABLE);
  assert.equal(engine.towReadyAt[late], day.endsAt + 3 * HOUR, 'next 07:00');
  assert.ok(!enforcement.districtZone(late, CATEGORY.PRIVATE), 'a doorway is no 서초구 zone');

  // Under the 2027 ordinance e-bikes are towed like scooters, storage capped at 500,000원.
  const towed = fresh(true);
  const crosswalk = street(towed);
  park(towed, crosswalk, 37.5665, 126.978, CATEGORY.CROSSWALK, ten - MINUTE);
  towed.enforcement.complain(crosswalk, ten, 0);
  assert.equal(towed.enforcement.regime[crosswalk], REGIME.ORDINANCE);
  towed.enforcement.towReady(crosswalk, towed.segVersion[crosswalk], towed.towReadyAt[crosswalk]);
  assert.equal(towed.stage[crosswalk], STAGE.TOW_DISPATCHED);
  const ordinance = ASSUMPTIONS.ebike.towing.ordinance2027;
  assert.deepEqual(towed.enforcement.releaseFees(crosswalk, 90), [ordinance.towFeeWon, 2_100]);
  assert.deepEqual(towed.enforcement.releaseFees(crosswalk, 100_000), [
    ordinance.towFeeWon,
    ordinance.storageCapWon,
  ]);
  assert.deepEqual(towed.enforcement.releaseFees(0, 100_000), [
    ASSUMPTIONS.money.towFeeWon,
    ASSUMPTIONS.money.storageWonPer30Minutes * Math.ceil(100_000 / 30),
  ]);
  assert.ok(
    towed.enforcement.trucks.length > engine.enforcement.trucks.length,
    'trucks follow the towed fleet',
  );

  // A whole day under the ordinance: e-bikes are towed and pay its fees at the lot.
  const { view: ordinanceView } = mixedRun(MIXED_DAY, { ordinance2027: true });
  const ebikeTows = eventsOf(ordinanceView, 'tow').filter(
    (tow) => tow.d[1] === 1 && ordinanceView.vType(tow.vehicle) === VTYPE.EBIKE,
  );
  assert.ok(ebikeTows.length > 0, 'e-bikes towed');
  assert.equal(eventsOf(ordinanceView, 'operator-notice').length, 0);
  for (const release of eventsOf(ordinanceView, 'impound-release'))
    if (ordinanceView.vType(release.vehicle) === VTYPE.EBIKE && release.d[2] > 0)
      assert.equal(release.d[2], ordinance.towFeeWon);
});

test('mixed fleet: each type converges over two weeks and starts near its own template (§11.2, §19)', () => {
  const day = dayOf('2026-11-24');
  const counts = (days: number) => {
    // Stops at the served day's 04:00: the state two weeks of history leave there.
    const engine = new Engine(
      mixedInput('2026-11-24', {
        endsAt: day.startsAt,
        warmupFrom: day.startsAt - days * 24 * HOUR,
      }),
    );
    engine.run();
    const states = [0, 1].map(() => new Array<number>(OP_NAMES.length).fill(0));
    for (let vehicle = 0; vehicle < engine.fleet; vehicle++)
      states[engine.vType[vehicle]][engine.op[vehicle]]++;
    return states;
  };
  const week = counts(7),
    fortnight = counts(14),
    threeWeeks = counts(21);
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    const fleet = fleetOfType(type),
      template = VEHICLE_TYPES[type].template;
    const expected: [OpStateName, number][] = [
      ['low-battery', template.lowBattery],
      ['missing', template.missing],
      ['impounded', template.impounded],
      ['at-depot-repair', template.repair],
      ['written-off', template.writtenOff],
    ];
    for (const [name, share] of expected) {
      const op = OP_NAMES.indexOf(name);
      // Convergence compares two runs a week apart on the same history: the scooters' 7 and 14 days, the e-bikes' 14 and
      // 21 (their pack count is still settling at 7 days: 484 against 370 for the default seed, 460 against 396 on
      // average of six seeds). The template is the state a 14-day run leaves, so the 14-day count is held to it.
      // The pack count is the one state that moves with the sampling: six seeds of the same 14 days spread by about
      // 0.5% of the fleet, so it gets 0.75% for the week-to-week change. §22.10 recalibrated the pack templates to the
      // real fleet's 14 days (5.8% / 4.9%), which this fleet's 14 days also meet within 1% like every other state.
      const [earlier, later] = type === VTYPE.EBIKE ? [fortnight, threeWeeks] : [week, fortnight];
      const a = earlier[type][op],
        b = later[type][op],
        atTemplate = fortnight[type][op],
        pack = name === 'low-battery';
      assert.ok(
        Math.abs(b - a) <= fleet * (pack ? 0.0075 : 0.01),
        `${TYPE_NAMES[type]} ${name}: ${a} a week earlier, ${b} later`,
      );
      assert.ok(
        Math.abs(atTemplate - share * fleet) <= fleet * 0.01,
        `${TYPE_NAMES[type]} ${name}: template ${share * fleet}, two weeks ${atTemplate}`,
      );
    }
  }
});

test('mixed fleet: a new anchor changes each type by at most 3% per state and its map no more than a day does', () => {
  const kmCell = (latitude: number, longitude: number) =>
    `${Math.floor(latitude / (1000 / 111_195))}:${Math.floor(longitude / (1000 / (111_195 * Math.cos((37.55 * Math.PI) / 180))))}`;
  const seam = at('2026-11-05T04:00:00');
  const before = mixed('2026-11-04').view,
    after = mixed('2026-11-05').view;
  assert.notEqual(before.meta.warmupFrom, after.meta.warmupFrom);
  const rentableCells = (view: SimWindow, time: number, type: number) => {
    const cells = new Map<string, number>();
    for (let vehicle = 0; vehicle < view.fleet; vehicle++) {
      if (type >= 0 && view.vType(vehicle) !== type) continue;
      const state = view.vehicle(vehicle, time);
      if (!state.rentable) continue;
      const key = kmCell(state.latitude, state.longitude);
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    return cells;
  };
  const share = (a: Map<string, number>, b: Map<string, number>) => {
    let busy = 0,
      close = 0;
    for (const key of new Set([...a.keys(), ...b.keys()])) {
      const x = a.get(key) ?? 0,
        y = b.get(key) ?? 0;
      if (Math.max(x, y) < 3) continue;
      busy++;
      if (Math.abs(x - y) <= 0.2 * Math.max(x, y)) close++;
    }
    return close / busy;
  };
  const a = typeStates(before, seam - 1),
    b = typeStates(after, seam);
  for (const type of [-1, VTYPE.SCOOTER, VTYPE.EBIKE]) {
    if (type >= 0) {
      let worst = 0;
      for (let op = 0; op < OP_NAMES.length; op++)
        worst = Math.max(worst, Math.abs(a[type][op] - b[type][op]));
      assert.ok(worst <= fleetOfType(type) * 0.03, `${TYPE_NAMES[type]} states differ by ${worst}`);
    }
    const seamShare = share(
      rentableCells(before, seam - 1, type),
      rentableCells(after, seam, type),
    );
    const natural = share(
      rentableCells(before, seam - 24 * HOUR, type),
      rentableCells(before, seam - 1, type),
    );
    assert.ok(
      seamShare >= natural - 0.05,
      `${type < 0 ? 'all' : TYPE_NAMES[type]} seam cells ${seamShare.toFixed(2)} vs a day ${natural.toFixed(2)}`,
    );
  }
});

test('mixed fleet: riders want a type by rider and trip, lost demand says which, and a missing type is substituted', () => {
  const { view } = mixed(MIXED_DAY);
  // Students (no licence needed) lean to e-bikes more than late-night riders do.
  const rents = [0, 1, 2, 3].map(() => [0, 0]);
  for (const rent of eventsOf(view, 'rent')) rents[rent.d[0]][view.vType(rent.vehicle)]++;
  const ebikeShare = (row: number[]) => row[1] / (row[0] + row[1]);
  const student = ebikeShare(rents[1]),
    lateNight = ebikeShare(rents[3]);
  assert.ok(
    student > lateNight + 0.03,
    `e-bike share: students ${student}, late-night ${lateNight}`,
  );
  const wanted = new Map<string, number>();
  for (const lost of eventsOf(view, 'lost-demand')) {
    const name = WANTED_NAMES[lost.d[2]];
    wanted.set(name, (wanted.get(name) ?? 0) + 1);
  }
  for (const name of ['kick-scooter', 'e-bike', 'either'])
    assert.ok((wanted.get(name) ?? 0) > 20, `lost demand wanting ${name}: ${wanted.get(name)}`);
  assert.equal(wanted.get('any') ?? 0, 0, 'every rider in a mixed run chose');
  // A scooter-only run draws no choice.
  for (const lost of eventsOf(windowOf(TUESDAY), 'lost-demand')) assert.equal(lost.d[2], 0);

  // With every scooter out of reach, riders take e-bikes instead.
  const { view: hidden } = mixedRun(MIXED_DAY, { hideScooters: true });
  const rentals = (target: SimWindow) => {
    const counts = [0, 0];
    for (const rent of eventsOf(target, 'rent')) counts[target.vType(rent.vehicle)]++;
    return counts;
  };
  const normal = rentals(view),
    substituted = rentals(hidden);
  assert.ok(substituted[0] < normal[0] * 0.02, `scooter rentals ${substituted[0]}`);
  assert.ok(
    substituted[1] > normal[1] * 1.1,
    `e-bike rentals ${normal[1]} → ${substituted[1]} without scooters`,
  );
});

test('realism bands for 4,000 scooters + 8,000 e-bikes (§16.7, §19)', () => {
  const { view } = mixed(MIXED_DAY);
  const day = view.meta;
  const band = (name: string, value: number, low: number, high: number) =>
    assert.ok(value >= low && value <= high, `${name} ${value} outside ${low}–${high}`);
  const per = (
    type: (typeof EVENT_TYPES)[number],
    filter = (_event: ReturnType<typeof eventsOf>[number]) => true,
  ) => {
    const counts = [0, 0];
    for (const event of eventsOf(view, type))
      if (filter(event)) counts[view.vType(event.vehicle)]++;
    return counts;
  };
  const rides = per('rent'),
    lost = eventsOf(view, 'lost-demand').length,
    abandoned = eventsOf(view, 'reserve-ended').filter((event) => event.d[0] === 0).length;
  // §22 riders fixed at Seoul's level leave fewer riders without a vehicle.
  band('lost demand', lost / (rides[0] + rides[1] + lost + abandoned), 0.005, 0.25);
  const improper = per('improper-parking'),
    swaps = per('battery-swap'),
    faults = per('fault', (event) => event.d[1] <= 3 && event.d[0] !== 7),
    revenue = [0, 0],
    ends = per('ride-end');
  for (const ride of eventsOf(view, 'ride-end')) revenue[view.vType(ride.vehicle)] += ride.amount;
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    const name = TYPE_NAMES[type],
      fleet = fleetOfType(type);
    band(`${name} rides per vehicle`, rides[type] / fleet, 0.6, 2);
    band(`${name} improper parking per ride`, improper[type] / rides[type], 0.04, 0.15);
    band(`${name} swaps per vehicle`, swaps[type] / fleet, 0.02, 0.5);
    band(`${name} faults per ride`, faults[type] / rides[type], 0.001, 0.008);
    band(`${name} average fare`, revenue[type] / ends[type], 1_500, 3_600);
    for (let hour = 10; hour <= 18; hour++) {
      const states = typeStates(view, day.startsAt + (hour - 4) * HOUR)[type];
      const field = [
        OP.AVAILABLE,
        OP.RESERVED,
        OP.LOW_BATTERY,
        OP.BATTERY_DEAD,
        OP.BROKEN,
        OP.OUT_OF_AREA,
      ]
        .map((op) => states[op])
        .reduce((a, b) => a + b, 0);
      band(
        `${name} ${hour}h low+dead share`,
        (states[OP.LOW_BATTERY] + states[OP.BATTERY_DEAD]) / field,
        0,
        0.1,
      );
      band(`${name} ${hour}h broken`, states[OP.BROKEN] / fleet, 0, 0.015);
    }
  }
  // E-bike assist cut-offs happen and end no ride; fines are bicycle fines only.
  // §22 e-bike packs rarely run flat at Seoul's demand; a scooter never pedals on.
  assert.ok(per('assist-cutoff')[0] === 0);
  // E-bike ranges (§19, R §1/§4/§6): assisted cruise under the 25 km/h cap, rides a little longer
  // than scooters', cut-offs rare (charge covers most trips), no helmet, licence or pillion fines.
  const meters = [0, 0],
    seconds = [0, 0];
  for (const ride of eventsOf(view, 'ride-end')) {
    seconds[view.vType(ride.vehicle)] += ride.d[0];
    meters[view.vType(ride.vehicle)] += ride.d[1];
  }
  const kmh = meters.map((sum, type) => (sum / seconds[type]) * 3.6);
  band('scooter ride speed km/h', kmh[VTYPE.SCOOTER], 9, 16);
  band('e-bike ride speed km/h', kmh[VTYPE.EBIKE], 10, 18);
  band('e-bike ride km', meters[VTYPE.EBIKE] / ends[VTYPE.EBIKE] / 1000, 1.2, 3.5);
  band('e-bike assist cut-offs per ride', per('assist-cutoff')[1] / rides[VTYPE.EBIKE], 0, 0.005);
  band('e-bike share of rides', rides[VTYPE.EBIKE] / (rides[0] + rides[1]), 0.55, 0.8);
  const fineKinds = per('fine', (event) =>
    ['helmet', 'unlicensed', 'two-riders'].includes(FINE_KINDS[event.d[0]]),
  );
  assert.equal(fineKinds[VTYPE.EBIKE], 0, 'helmet, licence and pillion fines are PM-only');
  // The status view agrees with the events, per type.
  const status = view.status(day.endsAt);
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    const own = status.byType[type === VTYPE.EBIKE ? 'e-bike' : 'kick-scooter']!;
    assert.equal(own.fleet, fleetOfType(type));
    assert.equal(own.today.rides, rides[type]);
    assert.equal(own.today.money.rideRevenue, revenue[type]);
  }
  assert.equal(
    (status.byType['e-bike']!.today as { assistCutoffs: number }).assistCutoffs,
    per('assist-cutoff')[1],
  );
  // Crews shared by both types stay 40–95% busy.
  const data = view.data,
    busy = [0, 0, 0],
    onShift = [0, 0, 0];
  view.meta.crews.forEach((crew, index) => {
    for (let row = data.cStart[index]; row < data.cStart[index + 1]; row++) {
      const from = Math.max(data.cT[row], day.startsAt);
      const to = row + 1 < data.cStart[index + 1] ? data.cT[row + 1] : day.endsAt;
      if (to <= from || data.cState[row] === 0) continue;
      onShift[crew.type] += to - from;
      if (data.cState[row] >= 2 && data.cState[row] <= 5) busy[crew.type] += to - from;
    }
  });
  busy.forEach((time, type) => band(`crew type ${type} busy`, time / onShift[type], 0.4, 0.95));
});

/** An engine at the template of `date`'s warm-up start, nothing run (§11.2). */
function templateEngine(date: string) {
  const day = dayOf(date);
  const engine = new Engine({
    demand: bundledDemand(),
    rules,
    seed: 'jigak',
    fleet: FLEET,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    date: day.date,
  });
  engine.ops.initTemplate(engine.warmupFrom);
  return engine;
}

test('§22.10 a swap-round wait ends with the low pack, and any wait when the vehicle leaves the street', () => {
  const engine = templateEngine(TUESDAY);
  const time = engine.warmupFrom + HOUR;
  const waiting: number[] = [];
  for (let vehicle = 0; vehicle < FLEET; vehicle++)
    if (engine.op[vehicle] === OP.LOW_BATTERY && engine.taskRetryAt[vehicle] > time + HOUR)
      waiting.push(vehicle);
  assert.ok(waiting.length >= 3, `${waiting.length} template packs waiting for their round`);
  const [still, swapped, collected] = waiting;
  // Still low: the round holds.
  const round = engine.taskRetryAt[still];
  engine.ops.vehicleChanged(still, time);
  assert.equal(engine.taskRetryAt[still], round);
  // Swapped by another round (a full pack, rentable): its next task is not held back any more.
  engine.setBattery(swapped, 100, time);
  engine.setOp(swapped, OP.AVAILABLE, time);
  engine.ops.vehicleChanged(swapped, time);
  assert.equal(engine.taskRetryAt[swapped], 0);
  // Taken off the street (a van): the wait is gone when it comes back.
  engine.setOp(collected, OP.ON_CREW_VAN, time);
  engine.ops.vehicleChanged(collected, time);
  assert.equal(engine.taskRetryAt[collected], 0);
});

test('§22.10 a violation moved off a pile takes the category of where it ends', () => {
  const stops = rules.meta.busStops;
  assert.ok(stops > 100);
  const buffer = ASSUMPTIONS.parking.bufferMeters.busStop;
  let pavement = 0,
    kept = 0;
  for (let stop = 0; stop < stops && (pavement < 5 || kept < 5); stop += 37) {
    const latitude = rules.featureLatitude(LAYER.BUS, stop),
      longitude = rules.featureLongitude(LAYER.BUS, stop);
    if (rules.immediateHit(latitude, longitude) !== LAYER.BUS) continue;
    // Everything within the stop's buffer (and a little more) is a pile.
    const crowd = (lat: number, lon: number) =>
      metersApart(lat, lon, latitude, longitude) <= buffer + 2 ? 1 : 0;
    for (const [category, geometry] of [
      [CATEGORY.BUS_TAXI, true],
      [CATEGORY.ROADWAY, false],
    ] as const) {
      const out = new Placement();
      out.latitude = latitude;
      out.longitude = longitude;
      out.category = category;
      out.geometry = geometry;
      if (!rules.clearOfPile(0.3, out, crowd)) continue;
      assert.ok(metersApart(out.latitude, out.longitude, latitude, longitude) > buffer + 2);
      if (!geometry) {
        // A drawn behaviour moves with the rider.
        assert.equal(out.category, CATEGORY.ROADWAY);
        assert.equal(out.geometry, false);
        kept++;
        continue;
      }
      // The stop is behind it now: the category is that of the new point.
      const layer = rules.immediateHit(out.latitude, out.longitude);
      if (layer > 0) assert.equal(out.geometry, true);
      else {
        assert.equal(out.category, CATEGORY.SIDEWALK, `stop ${stop}`);
        assert.equal(out.geometry, false);
        pavement++;
      }
    }
  }
  assert.ok(pavement >= 5 && kept >= 5, `${pavement} to the pavement, ${kept} kept`);
});

test('§22.10 a patrol that steps aside from a full spot stays within its re-park reach', () => {
  const engine = templateEngine(TUESDAY);
  const time = engine.warmupFrom + HOUR;
  const ops = engine.ops as unknown as {
    crowd: (latitude: number, longitude: number) => number;
    fixParking(
      vehicle: number,
      time: number,
      crew: number,
      maxMeters: number,
      log: boolean,
    ): number;
  };
  const maxMeters = 8,
    full = 6;
  let stepped = 0,
    stayed = 0;
  for (let vehicle = 0; vehicle < FLEET && stepped + stayed < 300; vehicle += 7) {
    const fromLat = engine.lat[vehicle],
      fromLon = engine.lon[vehicle];
    // Off a no-return spot a patrol goes as far as the next legal one (§20.3), as before.
    if (
      engine.op[vehicle] !== OP.AVAILABLE ||
      rules.returnEffect(engine.vType[vehicle], fromLat, fromLon) === RETURN.NO_RETURN
    )
      continue;
    // Every point within 6 m of where it stands is full: the step aside goes 6–60 m out.
    ops.crowd = (latitude, longitude) =>
      metersApart(latitude, longitude, fromLat, fromLon) <= full ? 1 : 0;
    engine.category[vehicle] = CATEGORY.SIDEWALK;
    const moved = ops.fixParking(vehicle, time, 0, maxMeters, false);
    assert.ok(moved <= maxMeters + 0.2, `vehicle ${vehicle} moved ${moved.toFixed(1)} m`);
    if (moved > full) stepped++;
    else stayed++;
  }
  assert.ok(stepped > 0 && stayed > 0, `${stepped} stepped aside, ${stayed} kept the spot`);
});

test('§22.10 the busiest cells keep most of their vehicles over a day (destination balance)', () => {
  // Cells ranked by the riders the demand map sends from them, not by the rentals that happened.
  const engine = templateEngine(TUESDAY);
  const cells = engine.cellDock.length;
  for (const date of [TUESDAY, SATURDAY]) {
    const data = windowOf(date).data;
    const day = dayOf(date);
    const dayType = data.meta.dayType;
    const expected = new Float64Array(cells);
    const docks = engine.demand.docks;
    for (let dock = 0; dock < engine.demand.count; dock++) {
      const cell = engine.cellGrid.cell(docks[dock * 2], docks[dock * 2 + 1]);
      if (cell < 0) continue;
      for (let hour = 0; hour < 24; hour++)
        expected[cell] += engine.dockRateAt(dayType, dock, hour);
    }
    const rents = new Float64Array(cells),
      ends = new Float64Array(cells);
    const rent = EVENT_TYPES.indexOf('rent'),
      end = EVENT_TYPES.indexOf('ride-end');
    const events = data.events;
    for (let index = 0; index < events.t.length; index++) {
      if (events.t[index] < day.startsAt || events.t[index] >= day.endsAt) continue;
      const type = events.type[index];
      if (type !== rent && type !== end) continue;
      const cell = engine.cellGrid.cell(events.lat[index], events.lon[index]);
      if (cell >= 0) (type === rent ? rents : ends)[cell]++;
    }
    const ranked = Array.from(expected.keys())
      .filter((cell) => expected[cell] > 0)
      .sort((a, b) => expected[b] - expected[a] || a - b);
    const top = ranked.slice(0, Math.round(ranked.length / 10));
    let rented = 0,
      ended = 0;
    for (const cell of top) {
      rented += rents[cell];
      ended += ends[cell];
    }
    // The random-bearing destinations of §22 lost 19–20% of these cells' vehicles a day (7–10% now;
    // real 따릉이 within ±3%, the rest is riders from around a hub taking its scooters).
    const gap = (ended - rented) / rented;
    assert.ok(
      gap > -0.13 && gap < 0.1,
      `${date} top 10% of cells ${rented} rented, ${ended} ended`,
    );
  }
});
