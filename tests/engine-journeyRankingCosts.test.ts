// Ranking costs of the journey graph (quality FIXPLAN R1, R3, R4): extra vehicle uses cost seconds instead of being
// refused (a second rental and a boarding after a taxi stay possible when they win by more than their cost), no ride is
// planned that a walk in the fetched network beats, and no run is made for a boarding timed only by a rule. Shown clocks
// stay physical.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARDING_PENALTY_SECONDS,
  MIN_RIDE_SAVING_SECONDS,
  RENTAL_PENALTY_SECONDS,
  planJourneyGraph,
  rankingPenaltySeconds,
} from '../src/common/engine/journey-graph.js';
import { rideKey } from '../src/common/engine/ride-identity.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

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

test('the constants are the assumed values and a fixed price per extra vehicle use', () => {
  assert.equal(BOARDING_PENALTY_SECONDS, 120);
  assert.equal(RENTAL_PENALTY_SECONDS, 150);
  assert.equal(MIN_RIDE_SAVING_SECONDS, 120);
  const bus = (id: string) => leg(id, 'bus', O, A, 60);
  assert.equal(rankingPenaltySeconds([bus('a')]), 0);
  assert.equal(
    rankingPenaltySeconds([bus('a'), leg('walk', 'walk', A, B, 60), leg('b', 'subway', B, D, 60)]),
    BOARDING_PENALTY_SECONDS,
  );
  assert.equal(
    rankingPenaltySeconds([
      leg('hire', 'hire', O, O, 30),
      leg('ride', 'ebike', O, A, 60),
      leg('return', 'return', A, A, 20),
      bus('b'),
    ]),
    BOARDING_PENALTY_SECONDS,
  );
  // A second rental after a bus is priced as a rental.
  assert.equal(
    rankingPenaltySeconds([
      bus('a'),
      leg('hire', 'hire', A, A, 30),
      leg('ride', 'ebike', A, B, 60),
      leg('return', 'return', B, B, 20),
    ]),
    RENTAL_PENALTY_SECONDS,
  );
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

  // With the costs off the same graph takes the bus, because it does arrive 80 s sooner: the rule is the ranking, not the data.
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

  // The only way to a place is a short bus: with the costs on, it is still found.
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

test('a boarding after a taxi is priced like any other, so it is planned when it is the fastest way', () => {
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

  // Taxi 140 s and bus 90 s arrive in 230 s; with the 120 s boarding cost that is 350 s, far under the 700 s walk.
  const priced = search([walkAll(), taxiHop, busRest]);
  assert.deepEqual(
    modes(priced.routes[0]).filter((mode) => mode !== 'wait'),
    ['taxi', 'bus'],
  );
  assert.deepEqual(priced.routes[0].durationSeconds, { min: 230, max: 230 });
  assert.equal(afterTaxi(priced.routes[0]), true);

  // A walk only 70 s slower than the taxi and bus (300 s against 230 s) wins once the boarding is priced.
  const nearWalk = () => source('near', [leg('near-walk', 'walk', O, D, 300)]);
  const near = search([nearWalk(), taxiHop, busRest]);
  assert.deepEqual(modes(near.routes[0]), ['walk']);
  assert.deepEqual(near.routes[0].durationSeconds, { min: 300, max: 300 });
  const plain = search([nearWalk(), taxiHop, busRest], { rankingCosts: false });
  assert.equal(afterTaxi(plain.routes[0]), true);
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

test('a second rental costs RENTAL_PENALTY_SECONDS: e-bike, bus, e-bike loses to a pure e-bike but beats a slow one', () => {
  const first = lease('first', O, A, 40);
  const second = lease('second', B, D, 40);
  const middle = source(
    'middle',
    [leg('middle-wait', 'wait', A, A, 20), leg('middle-bus', 'bus', A, B, 40)],
    1500,
  );

  // The chain is 240 s plus a boarding (120 s) and a second rental (150 s) = 510 s, against a 350 s pure e-bike.
  const pure = lease('pure', O, D, 300);
  const priced = search([first, middle, second, pure]);
  assert.ok(priced.routes.length > 0);
  assert.equal(modes(priced.routes[0]).includes('bus'), false);
  assert.deepEqual(priced.routes[0].durationSeconds, { min: 350, max: 350 });
  assert.equal(hires(priced.routes[0]), 1);

  // Priced alone, the chain is the faster journey by two rentals' worth of time.
  const plain = search([first, middle, second, pure], { rankingCosts: false });
  assert.equal(hires(plain.routes[0]), 2);
  assert.deepEqual(plain.routes[0].durationSeconds, { min: 240, max: 240 });
  assert.ok(
    plain.routes[0].durationSeconds.max + RENTAL_PENALTY_SECONDS + BOARDING_PENALTY_SECONDS > 350,
  );

  // Against a pure e-bike that takes 850 s the chain wins by more than its 270 s of cost, so it is the route chosen.
  const slow = search([first, middle, second, lease('slow', O, D, 800)]);
  assert.equal(hires(slow.routes[0]), 2);
  assert.equal(modes(slow.routes[0]).includes('bus'), true);
  assert.deepEqual(slow.routes[0].durationSeconds, { min: 240, max: 240 });
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
