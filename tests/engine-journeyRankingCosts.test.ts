// Ranking rules of the journey graph (quality FIXPLAN R1, R3, R4, user decision D1 of 2026-11-02): ranking is the arrival
// alone, so a second rental or a boarding after a taxi is neither refused nor priced and wins exactly when it arrives sooner,
// in the main search, a tab's search and a pure tab search alike. No ride is planned that a walk in the fetched network
// beats, and no run is made for a boarding timed only by a rule. Shown clocks stay physical.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as journeyGraph from '../src/common/engine/journey-graph.js';
import { rideKey } from '../src/common/engine/ride-identity.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

const { MIN_RIDE_SAVING_SECONDS, planJourneyGraph } = journeyGraph;
const NOW = Date.parse('2026-10-12T05:00:00Z');
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 중구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
// Points on one street, 300 m apart.
const O = point('출발', 0),
  A = point('가', 300),
  B = point('나', 600),
  D = point('도착', 900);
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '실제 조회 구간',
  start,
  end,
  distanceMeters: start === end ? 0 : Math.round(Math.abs(end.latitude - start.latitude) * 111195),
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  ...(start !== end ? { polyline: [start, end] } : {}),
  ...extra,
});
const source = (id: string, segments: BaseSegment[], fareWon?: number): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((n, s) => n + s.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (n, s) => ({ min: n.min + s.durationSeconds.min, max: n.max + s.durationSeconds.max }),
    { min: 0, max: 0 },
  ),
  fareWon,
});
const request = (overrides = {}) => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3600000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowBicycle: true,
    bicycleReady: true,
    allowEbike: true,
    maxBicycleMeters: 3000,
    ...overrides,
  },
});
const search = (sources: BaseRoute[], options: { rankingCosts?: boolean } = {}) =>
  planJourneyGraph(request(), sources, { receivedAt: NOW, maxResults: 6, ...options });
const modes = (route: BaseRoute) => route.segments.map((segment) => segment.mode);
const walkAll = () => source('walk-all', [leg('walk-all', 'walk', O, D, 700)]);

test('the short-ride saving is the assumed value and no price per vehicle use is left (D1)', () => {
  assert.equal(MIN_RIDE_SAVING_SECONDS, 120);
  // The Windows session's ranking costs are gone, not merely set to zero.
  for (const name of ['BOARDING_PENALTY_SECONDS', 'RENTAL_PENALTY_SECONDS', 'rankingPenaltySeconds'])
    assert.equal(name in journeyGraph, false, name);
  // Two boardings: the objective is the physical arrival (the boarding waits and rides on the clock), nothing added for the
  // second boarding.
  const transfer = search([
    source('first', [leg('first-bus', 'bus', O, A, 60)]),
    source('between', [leg('between-walk', 'walk', A, B, 60)]),
    source('second', [leg('second-train', 'subway', B, D, 60)]),
  ]);
  assert.deepEqual(
    modes(transfer.routes[0]).filter((mode) => mode !== 'wait'),
    ['bus', 'walk', 'subway'],
  );
  assert.equal(transfer.diagnostics.bestObjectiveSeconds, transfer.routes[0].durationSeconds.max);
});

test('a one-stop bus that saves under two minutes over walking its stretch is not planned', () => {
  // The 300 m hop takes 120 s of wait plus 60 s on the bus; walking it takes about 260 s, a saving of about 80 s.
  const hop = source(
    'hop',
    [leg('hop-wait', 'wait', O, O, 120), leg('hop-bus', 'bus', O, A, 60)],
    1500,
  );
  const rest = source('rest', [leg('rest-walk', 'walk', A, D, 440)]);
  // The walk of the same stretch is a source of its own, as the fetched network has it.
  const stretch = source('stretch', [leg('stretch-walk', 'walk', O, A, 260)]);
  const sources = [walkAll(), hop, rest, stretch];

  const priced = search(sources);
  assert.ok(priced.routes.length > 0);
  assert.equal(
    priced.routes.some((route) => modes(route).includes('bus')),
    false,
  );
  assert.deepEqual(priced.routes[0].durationSeconds, { min: 700, max: 700 });
  assert.ok(priced.diagnostics.shortRides > 0);

  // With the walk comparisons off the same graph takes the bus, because it does arrive 80 s sooner: the rule is the ranking, not the data.
  const plain = search(sources, { rankingCosts: false });
  assert.deepEqual(modes(plain.routes[0]), ['wait', 'bus', 'walk']);
  assert.deepEqual(plain.routes[0].durationSeconds, { min: 620, max: 620 });
  assert.equal(plain.diagnostics.shortRides, 0);
});

test('a one-stop bus with no walk of its stretch in the network is kept, however short', () => {
  // The same hop as above, but no source walks O to A (the walking source failed, or the stretch has no footpath): the
  // assumed walking speed is no proof of an alternative, so the bus stays the way to get there.
  const hop = source(
    'hop',
    [leg('hop-wait', 'wait', O, O, 120), leg('hop-bus', 'bus', O, A, 60)],
    1500,
  );
  const rest = source('rest', [leg('rest-walk', 'walk', A, D, 440)]);
  const result = search([hop, rest]);
  assert.deepEqual(modes(result.routes[0]), ['wait', 'bus', 'walk']);
  assert.equal(result.diagnostics.shortRides, 0);

  // The only way to a place is a short bus: with the walk comparisons on, it is still found.
  const alone = search([
    source('alone', [leg('a-wait', 'wait', O, O, 480), leg('a-bus', 'bus', O, D, 220)], 1500),
  ]);
  assert.equal(alone.routes.length, 1);
  assert.equal(alone.diagnostics.shortRides, 0);
});

test('a bus that clearly beats walking its stretch is still planned', () => {
  // The same hop with a 30 s wait saves about 170 s, more than the two minutes asked for.
  const hop = source(
    'hop',
    [leg('hop-wait', 'wait', O, O, 30), leg('hop-bus', 'bus', O, A, 60)],
    1500,
  );
  const rest = source('rest', [leg('rest-walk', 'walk', A, D, 440)]);
  const stretch = source('stretch', [leg('stretch-walk', 'walk', O, A, 260)]);
  const result = search([walkAll(), hop, rest, stretch]);
  assert.deepEqual(modes(result.routes[0]), ['wait', 'bus', 'walk']);
  assert.deepEqual(result.routes[0].durationSeconds, { min: 530, max: 530 });
  assert.equal(result.diagnostics.shortRides, 0);
});

test('a boarding after a taxi is neither refused nor priced: it is planned exactly when it arrives sooner', () => {
  const taxiHop = source('taxi-hop', [
    leg('pickup', 'wait', O, O, 40),
    leg('taxi-hop', 'taxi', O, A, 100, { costWon: 5000 }),
  ]);
  const busRest = source(
    'bus-rest',
    [leg('bus-rest-wait', 'wait', A, A, 30), leg('bus-rest', 'bus', A, D, 60)],
    1500,
  );
  const afterTaxi = (route: BaseRoute) => {
    const taxiAt = modes(route).indexOf('taxi');
    return taxiAt >= 0 && modes(route).slice(taxiAt).includes('bus');
  };

  // Taxi 140 s and bus 90 s arrive in 230 s, far under the 700 s walk; the objective is that arrival, nothing added.
  const fast = search([walkAll(), taxiHop, busRest]);
  assert.deepEqual(
    modes(fast.routes[0]).filter((mode) => mode !== 'wait'),
    ['taxi', 'bus'],
  );
  assert.deepEqual(fast.routes[0].durationSeconds, { min: 230, max: 230 });
  assert.equal(afterTaxi(fast.routes[0]), true);
  assert.equal(fast.diagnostics.bestObjectiveSeconds, 230);

  // A walk 70 s slower than the taxi and bus (300 s against 230 s) no longer wins: the taxi and bus arrive sooner (D1).
  const nearWalk = () => source('near', [leg('near-walk', 'walk', O, D, 300)]);
  const near = search([nearWalk(), taxiHop, busRest]);
  assert.equal(afterTaxi(near.routes[0]), true);
  assert.deepEqual(near.routes[0].durationSeconds, { min: 230, max: 230 });
  assert.equal(near.diagnostics.bestObjectiveSeconds, 230);
  assert.ok(near.routes.some((route) => modes(route).join() === 'walk'));
  // The walk comparisons do not change it: the same route without them.
  const plain = search([nearWalk(), taxiHop, busRest], { rankingCosts: false });
  assert.equal(afterTaxi(plain.routes[0]), true);
  assert.deepEqual(plain.routes[0].durationSeconds, { min: 230, max: 230 });

  // A walk that arrives a second sooner (229 s) is the route chosen: the arrival alone decides.
  const quick = search([source('quick', [leg('quick-walk', 'walk', O, D, 229)]), taxiHop, busRest]);
  assert.deepEqual(modes(quick.routes[0]), ['walk']);
  assert.deepEqual(quick.routes[0].durationSeconds, { min: 229, max: 229 });
});

const lease = (id: string, start: Place, end: Place, rideSeconds: number) =>
  source(id, [
    leg(`${id}-hire`, 'hire', start, start, 30, {
      rentalValidity: {
        verifiedAt: NOW,
        validUntil: NOW + 3600000,
        vehicleId: id,
        provider: 'test-operator',
      },
    }),
    leg(`${id}-ride`, 'ebike', start, end, rideSeconds, { routingProfile: 'ebike' }),
    leg(`${id}-return`, 'return', end, end, 20),
  ]);
const hires = (route: BaseRoute) => route.segments.filter((s) => s.mode === 'hire').length;

test('a second rental is neither refused nor priced: e-bike, bus, e-bike wins whenever it arrives sooner', () => {
  const first = lease('first', O, A, 40);
  const second = lease('second', B, D, 40);
  const middle = source(
    'middle',
    [leg('middle-wait', 'wait', A, A, 20), leg('middle-bus', 'bus', A, B, 40)],
    1500,
  );

  // The chain arrives in 240 s (90 s, 60 s, 90 s) against a 350 s pure e-bike: the chain is the route chosen (D1).
  const pure = lease('pure', O, D, 300);
  const result = search([first, middle, second, pure]);
  assert.equal(hires(result.routes[0]), 2);
  assert.equal(modes(result.routes[0]).includes('bus'), true);
  assert.deepEqual(result.routes[0].durationSeconds, { min: 240, max: 240 });
  assert.equal(result.diagnostics.bestObjectiveSeconds, 240);
  assert.ok(result.routes.some((route) => hires(route) === 1 && route.durationSeconds.max === 350));
  const plain = search([first, middle, second, pure], { rankingCosts: false });
  assert.equal(hires(plain.routes[0]), 2);
  assert.deepEqual(plain.routes[0].durationSeconds, { min: 240, max: 240 });

  // A pure e-bike that arrives a second sooner (239 s) wins: the arrival alone decides.
  const quick = search([first, middle, second, lease('quick', O, D, 189)]);
  assert.equal(hires(quick.routes[0]), 1);
  assert.deepEqual(quick.routes[0].durationSeconds, { min: 239, max: 239 });
});

test("a tab's representative route is its fastest, with a second rental or a boarding after a taxi (D1)", () => {
  const tab = (sources: BaseRoute[], requiredMode: 'bus' | 'ebike' | 'taxi') =>
    planJourneyGraph(request(), sources, { receivedAt: NOW, maxResults: 1, requiredMode });
  const chain = () => [
    lease('first', O, A, 40),
    source('middle', [leg('middle-wait', 'wait', A, A, 20), leg('middle-bus', 'bus', A, B, 40)], 1500),
    lease('second', B, D, 40),
  ];
  // The e-bike tab: the 240 s chain over a 350 s pure e-bike (the costs had kept the pure one, 240 + 120 + 150 > 350).
  const ebike = tab([...chain(), lease('pure', O, D, 300)], 'ebike');
  assert.equal(ebike.routes.length, 1);
  assert.equal(hires(ebike.routes[0]), 2);
  assert.deepEqual(ebike.routes[0].durationSeconds, { min: 240, max: 240 });
  // The bus tab: the same chain over a 320 s direct bus.
  const direct = source(
    'direct',
    [leg('direct-wait', 'wait', O, O, 20), leg('direct-bus', 'bus', O, D, 300)],
    1500,
  );
  const bus = tab([...chain(), direct], 'bus');
  assert.equal(hires(bus.routes[0]), 2);
  assert.deepEqual(bus.routes[0].durationSeconds, { min: 240, max: 240 });

  // The taxi tab: taxi then bus (230 s) over a direct taxi of 300 s (the costs had kept the taxi, 230 + 120 > 300).
  const taxiHop = source('taxi-hop', [
    leg('pickup', 'wait', O, O, 40),
    leg('taxi-hop', 'taxi', O, A, 100, { costWon: 5000 }),
  ]);
  const busRest = source(
    'bus-rest',
    [leg('bus-rest-wait', 'wait', A, A, 30), leg('bus-rest', 'bus', A, D, 60)],
    1500,
  );
  const taxiOnly = source('taxi-only', [
    leg('pickup-direct', 'wait', O, O, 40),
    leg('taxi-direct', 'taxi', O, D, 260, { costWon: 7000 }),
  ]);
  const taxi = tab([taxiHop, busRest, taxiOnly], 'taxi');
  assert.deepEqual(
    modes(taxi.routes[0]).filter((mode) => mode !== 'wait'),
    ['taxi', 'bus'],
  );
  assert.deepEqual(taxi.routes[0].durationSeconds, { min: 230, max: 230 });
});

test('a pure tab search keeps a faster change of buses over a slower one-seat bus (D1)', () => {
  const firstBus = source(
    'first-bus',
    [
      leg('first-wait', 'wait', O, O, 20),
      leg('first-ride', 'bus', O, A, 40, { transit: { lines: ['100'], stops: [] } }),
    ],
    1500,
  );
  const secondBus = source(
    'second-bus',
    [
      leg('second-wait', 'wait', A, A, 20),
      leg('second-ride', 'bus', A, D, 60, { transit: { lines: ['200'], stops: [] } }),
    ],
    1500,
  );
  const oneSeat = source(
    'one-seat',
    [
      leg('one-seat-wait', 'wait', O, O, 20),
      leg('one-seat-ride', 'bus', O, D, 200, { transit: { lines: ['300'], stops: [] } }),
    ],
    1500,
  );
  // The change arrives in 140 s, the one-seat bus in 220 s (the costs had kept the one-seat bus, 140 + 120 > 220).
  const pure = planJourneyGraph(request(), [firstBus, secondBus, oneSeat], {
    receivedAt: NOW,
    maxResults: 1,
    pureMode: 'bus',
  });
  assert.equal(pure.routes.length, 1);
  assert.equal(modes(pure.routes[0]).filter((mode) => mode === 'bus').length, 2);
  assert.deepEqual(pure.routes[0].durationSeconds, { min: 140, max: 140 });
  assert.equal(pure.diagnostics.bestObjectiveSeconds, 140);
});

test('a bike returned and another hired with no transit between is still one rental cut in two', () => {
  const result = search([lease('one', O, A, 40), lease('two', A, D, 40), lease('slow', O, D, 800)]);
  assert.ok(result.routes.length > 0);
  assert.equal(
    result.routes.every((route) => hires(route) <= 1),
    true,
  );
});

test('a run before a rule-timed wait is not planned, but a run before a car is', () => {
  const run = source('run-a', [leg('run-a', 'run', O, A, 40, { runAllowed: true })]);
  const walk = source('walk-a', [leg('walk-a', 'walk', O, A, 80)]);
  const fast = { allowRunning: true, maxRunningMeters: 5000 };
  const bus = () =>
    source(
      'bus-rest',
      [leg('bus-rest-wait', 'wait', A, A, 300), leg('bus-rest', 'bus', A, D, 200)],
      1500,
    );
  const plan = (sources: BaseRoute[], options: { rankingCosts?: boolean } = {}) =>
    planJourneyGraph(request(fast), sources, { receivedAt: NOW, maxResults: 6, ...options });
  const hasRun = (result: ReturnType<typeof plan>) =>
    result.routes.some((route) => modes(route).includes('run'));

  // An average headway starts counting when the rider arrives: running there only moves the wait earlier.
  const rule = plan([run, walk, bus()]);
  assert.equal(hasRun(rule), false);
  assert.ok(rule.diagnostics.runsBeforeRuleWaits > 0);
  assert.equal(hasRun(plan([run, walk, bus()], { rankingCosts: false })), true);

  // The rider's own car has no wait to be timed: the run to it is the fastest way and stays.
  const car = source('car', [
    leg('drive', 'car', A, D, 600, {
      parkingAccess: {
        publicAccess: true,
        provider: 'test-lot',
        operating: 'open',
        occupancy: 'available',
        fee: 'free',
        verifiedAt: NOW,
      },
    }),
    leg('park', 'wait', D, D, 60),
  ]);
  const withCar = planJourneyGraph(
    request({ ...fast, hasCar: true, carLocation: A, preparationSeconds: 0 }),
    [run, walk, car, source('far-walk', [leg('far-walk', 'walk', O, D, 4500)])],
    { receivedAt: NOW, maxResults: 6 },
  );
  assert.deepEqual(modes(withCar.routes[0]), ['run', 'car', 'wait']);
  assert.deepEqual(withCar.routes[0].durationSeconds, { min: 700, max: 700 });
  assert.equal(withCar.diagnostics.runsBeforeRuleWaits, 0);
});

test('a route with a run and no vehicle keeps its own ride key, apart from the pure walk', () => {
  const walk = [leg('w', 'walk', O, D, 700)];
  const run = [leg('r', 'run', O, D, 300)];
  const mixed = [leg('w', 'walk', O, A, 200), leg('r', 'run', A, D, 200)];
  assert.equal(rideKey(walk), 'walk');
  assert.equal(rideKey(run), 'run');
  assert.equal(rideKey(mixed), 'run');
  // With a vehicle the walk and run legs around it share one identity.
  const ride = (foot: BaseSegment['mode']) => [
    leg('a', foot, O, A, 100),
    leg('bus', 'bus', A, D, 60, { transit: { lines: ['100'], stops: [] } }),
  ];
  assert.equal(rideKey(ride('walk')), rideKey(ride('run')));
  assert.notEqual(rideKey(ride('walk')), 'walk');
});

test('a run variant never replaces the pure walk among the search results', () => {
  const walk = source('walk-only', [leg('walk-only', 'walk', O, D, 700)]);
  const run = source('run-only', [leg('run-only', 'run', O, D, 400, { runAllowed: true })]);
  const result = planJourneyGraph(
    request({ allowRunning: true, maxRunningMeters: 5000 }),
    [walk, run],
    {
      receivedAt: NOW,
      maxResults: 6,
    },
  );
  const keys = result.routes.map((route) => rideKey(route.segments)).sort();
  assert.deepEqual(keys, ['run', 'walk']);
  assert.equal(result.diagnostics.duplicateRideResults, 0);
});
