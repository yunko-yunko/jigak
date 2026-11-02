// Preserved regression cases from perception-map/mvp/tests/journeyGraph.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';
import { LIVE_MISSED_HEADWAY_EXPLANATION } from '../src/common/shared/domain/routing.js';
const NOW = Date.parse('2026-10-12T05:00:00Z');
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 중구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
const O = point('출발', 0),
  A = point('대여소', 300),
  B = point('반납소', 600),
  D = point('도착', 900);
function leg(
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '실제 조회 구간',
    start,
    end,
    distanceMeters: start === end ? 0 : 300,
    durationSeconds: { min: seconds, max: seconds },
    runAllowed: false,
    ...(start !== end ? { polyline: [start, end] } : {}),
    ...extra,
  };
}
function source(id: string, segments: BaseSegment[], fareWon?: number): BaseRoute {
  return {
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
  };
}
const request = (overrides = {}) => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3600000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowBicycle: true,
    bicycleReady: true,
    maxBicycleMeters: 3000,
    ...overrides,
  },
});
const bike = () =>
  source('bike', [
    leg('hire', 'hire', A, A, 30),
    leg('ride', 'bicycle', A, B, 100, { routingProfile: 'bicycle' }),
    leg('return', 'return', B, B, 20),
  ]);
const taxi = () =>
  source('taxi', [
    leg('pickup', 'wait', B, B, 40),
    leg('taxi', 'taxi', B, D, 100, { costWon: 5000 }),
  ]);
const bus = () =>
  source(
    'bus',
    [leg('bus-wait-expected-wait', 'wait', O, O, 30), leg('bus', 'bus', O, A, 100)],
    1500,
  );
const walking = () => source('walking', [leg('walk', 'walk', O, D, 1200)]);
/** These fixtures walk 900 m in 20 minutes and ride 300 m hops, so a ride beats walking only on their own toy clocks;
 * the regressions below test timing and evidence, not ranking costs (engine-journeyRankingCosts.test.ts does). */
const TOY_GEOMETRY = { rankingCosts: false } as const;

test('whole journey cost keeps searching beyond the first physical arrival without shifting boarding clocks', () => {
  const fast = source('fast', [leg('fast-walk', 'walk', O, D, 200)]);
  const slower = source('slower', [
    leg('slower-walk', 'walk', O, A, 150),
    leg('last-walk', 'walk', A, D, 150),
  ]);
  const result = planJourneyGraph(request(), [fast, slower], {
    receivedAt: NOW,
    maxResults: 1,
    scoreCompleteRoute: (route) =>
      route.durationSeconds.max + (route.segments.length === 1 ? 1000 : 0),
  });
  assert.equal(result.routes[0].durationSeconds.max, 300);
  assert.equal(result.routes[0].segments.length, 2);
  assert.equal(result.diagnostics.limitReached, false);
  const invalidCost = planJourneyGraph(request(), [fast, slower], {
    receivedAt: NOW,
    maxResults: 1,
    scoreCompleteRoute: () => -100,
  });
  assert.equal(
    invalidCost.routes[0].durationSeconds.max,
    200,
    'a learned cost cannot shorten the physical lower bound',
  );
  const limited = planJourneyGraph(request(), [fast, slower], {
    receivedAt: NOW,
    maxResults: 1,
    maxExpansions: 2,
    scoreCompleteRoute: (route) => route.durationSeconds.max + 1000,
  });
  assert.equal(limited.diagnostics.limitReached, true);
});

test('search composes fetched bus then rental bicycle then taxi arcs with every transition time', () => {
  const result = planJourneyGraph(request(), [walking(), bus(), bike(), taxi()], {
    receivedAt: NOW,
  });
  const fastest = result.routes[0];
  assert.ok(fastest);
  assert.deepEqual(
    fastest.segments.map((s) => s.mode),
    ['wait', 'bus', 'hire', 'bicycle', 'return', 'wait', 'taxi'],
  );
  assert.equal(fastest.durationSeconds.min, 420);
  assert.equal(fastest.durationSeconds.max, 420);
  assert.equal(
    fastest.fareWon,
    undefined,
    'a partial bus fare cannot be added as a complete journey fare',
  );
  assert.equal(result.diagnostics.scope, 'bounded-fetched-network');
  assert.equal(fastest.timingEvaluatedAt, NOW);
});

test('geographically close anchors are not invented transfer links and riding never uses walking geometry', () => {
  const disconnected = source('nearby', [leg('taxi', 'taxi', point('nearby', 605), D, 10)]);
  const nakedRide = source('naked', [
    leg('unleased', 'bicycle', O, D, 1, { routingProfile: 'bicycle' }),
  ]);
  const wrongProfile = bike();
  wrongProfile.segments[1].routingProfile = undefined;
  const result = planJourneyGraph(
    request(),
    [walking(), bus(), bike(), disconnected, nakedRide, wrongProfile],
    { receivedAt: NOW },
  );
  assert.equal(
    result.routes[0].segments.some((s) => s.mode === 'bicycle'),
    false,
  );
  assert.equal(result.routes[0].durationSeconds.min, 1200);
});

test('each live boarding is recalculated after preceding mixed legs and a missed observed train waits for the next one', () => {
  const first = source('first', [leg('access', 'walk', O, A, 60)]);
  const second = source('second', [
    leg('bus', 'bus', A, B, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 120000 }],
      },
    }),
  ]);
  const third = source('third', [
    leg('subway', 'subway', B, D, 120, {
      realtime: {
        provider: 'seoul-subway',
        status: 'live',
        stopName: B.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '1호선', message: '도착 예측', arrivesAt: NOW + 300000 }],
      },
    }),
  ]);
  const result = planJourneyGraph(request(), [walking(), first, second, third], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  });
  const fastest = result.routes[0];
  assert.equal(fastest.durationSeconds.min, 420);
  assert.deepEqual(
    fastest.segments.filter((s) => s.mode === 'wait').map((s) => s.durationSeconds.min),
    [60, 120],
  );
  const planned = planBaseRoutes(request(), [fastest], {
    mode: 'live',
    provider: 'test',
    label: '실제 조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.equal(
    planned.routes[0].durationSeconds.min,
    420,
    'domain must not add a second first-boarding wait',
  );
  assert.equal(
    planned.routes[0].segments
      .filter((s) => s.mode === 'bus' || s.mode === 'subway')
      .every((s) => s.connection && s.provenance.isRealtime),
    true,
  );
  third.segments[0].realtime!.predictions[0].arrivesAt = NOW + 200000;
  // The only observed train leaves before the rider reaches B (180 s + 60 s platform): the route stays, on the next
  // train, which runs no earlier than one 420-second headway after the listed 200-second one.
  const missed = planJourneyGraph(request(), [walking(), first, second, third], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  }).routes[0];
  assert.equal(missed.durationSeconds.min, 740);
  assert.equal(
    missed.segments.find((s) => s.mode === 'wait' && s.title === '다음 차량 대기')?.durationSeconds
      .min,
    440,
  );
});

test('stale or no-service boarding evidence cannot turn into a zero-wait vehicle edge', () => {
  for (const status of ['stale', 'no-service'] as const) {
    const current = bus();
    current.segments[1].realtime = {
      provider: 'seoul-bus',
      status: status === 'no-service' ? 'no-service' : 'live',
      stopName: O.name,
      observedAt: status === 'stale' ? NOW - 121000 : NOW,
      receivedAt: NOW,
      predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 60000 }],
    };
    const result = planJourneyGraph(request(), [walking(), current, bike(), taxi()], {
      receivedAt: NOW,
    });
    assert.equal(result.routes[0].durationSeconds.min, 1200);
  }
  assert.equal(
    planJourneyGraph(request(), [walking()], { receivedAt: NOW - 121000 }).routes.length,
    0,
  );
});

test('own car arcs require its saved location and a public parking action and cannot be reused', () => {
  const parking = {
    publicAccess: true as const,
    provider: 'seoul-parking',
    operating: 'open' as const,
    occupancy: 'available' as const,
    fee: 'paid' as const,
    verifiedAt: NOW,
    occupancyObservedAt: NOW,
    availableSpaces: 3,
  };
  const car = source('car', [
    leg('drive', 'car', A, B, 100, { parkingAccess: parking }),
    leg('park', 'wait', B, B, 180),
  ]);
  const result = planJourneyGraph(
    request({ hasCar: true, carLocation: A }),
    [source('access', [leg('access', 'walk', O, A, 60)]), car, taxi(), walking()],
    { receivedAt: NOW },
  );
  assert.equal(result.routes[0].segments.find((s) => s.mode === 'car')?.start.id, A.id);
  assert.equal(result.routes[0].segments.filter((s) => s.mode === 'car').length, 1);
  const wrong = planJourneyGraph(
    request({ hasCar: true, carLocation: O }),
    [source('access', [leg('access', 'walk', O, A, 60)]), car, taxi(), walking()],
    { receivedAt: NOW },
  );
  assert.equal(
    wrong.routes[0].segments.some((s) => s.mode === 'car'),
    false,
  );
  car.segments.pop();
  assert.equal(
    planJourneyGraph(request({ hasCar: true, carLocation: A }), [car, walking()], {
      receivedAt: NOW,
    }).routes[0].segments.some((s) => s.mode === 'car'),
    false,
  );
});

test('cumulative resource limits exclude excess rental distance and unsafe blocked roads', () => {
  const blocked = taxi();
  blocked.segments[1].traffic = [{ from: 0, to: 1, level: 'blocked' }];
  assert.equal(
    planJourneyGraph(request(), [walking(), bus(), bike(), blocked], { receivedAt: NOW }).routes[0]
      .durationSeconds.min,
    1200,
  );
  assert.equal(
    planJourneyGraph(request({ maxBicycleMeters: 100 }), [walking(), bus(), bike(), taxi()], {
      receivedAt: NOW,
    }).routes[0].durationSeconds.min,
    1200,
  );
});

test('search limits are explicit and never assert an exhaustive Seoul optimum', () => {
  const result = planJourneyGraph(request(), [walking(), bus(), bike(), taxi()], {
    receivedAt: NOW,
    maxExpansions: 1,
  });
  assert.equal(result.diagnostics.limitReached, true);
  assert.equal(result.diagnostics.complete, false);
  assert.equal(result.diagnostics.scope, 'bounded-fetched-network');
});

test('a taxi leg cannot silently omit its pickup', () => {
  const uncalledTaxi = source('uncalled', [leg('taxi', 'taxi', O, D, 1, { costWon: 1000 })]);
  assert.equal(
    planJourneyGraph(request(), [walking(), uncalledTaxi], { receivedAt: NOW }).routes[0]
      .durationSeconds.min,
    1200,
  );
});
test('a single rental cannot change vehicle types without a new hire', () => {
  const impossibleRental = source('two-types', [
    leg('hire', 'hire', O, O, 30),
    leg('bike', 'bicycle', O, A, 10, { routingProfile: 'bicycle' }),
    leg('scooter', 'scooter', A, D, 10, { routingProfile: 'scooter' }),
    leg('return', 'return', D, D, 20),
  ]);
  assert.equal(
    planJourneyGraph(request(), [walking(), impossibleRental], { receivedAt: NOW }).routes[0]
      .durationSeconds.min,
    1200,
  );
});

test('graph search respects disabled vehicles and the final domain rejects a changed timing anchor', () => {
  const result = planJourneyGraph(
    request({ allowTaxi: false }),
    [walking(), bus(), bike(), taxi()],
    { receivedAt: NOW },
  );
  assert.equal(result.routes[0].durationSeconds.min, 1200);
  const graph = planJourneyGraph(request(), [walking(), bus(), bike(), taxi()], {
    receivedAt: NOW,
  });
  const planned = planBaseRoutes({ ...request(), now: NOW + 1000 }, graph.routes, {
    mode: 'live',
    provider: 'test',
    label: '실제 조회',
    sourceTimestamp: null,
    receivedAt: NOW + 1000,
    isRealtime: false,
  });
  assert.equal(planned.routes.length, 0);
});

test('only outer walking boundaries can align with a requested point within the provider tolerance', () => {
  const snappedStart = point('snapped origin', 25),
    snappedEnd = point('snapped destination', 880);
  const route = source('snapped', [leg('walk', 'walk', snappedStart, snappedEnd, 1200)]);
  const result = planJourneyGraph(request(), [route], { receivedAt: NOW });
  assert.equal(result.routes.length, 1);
  assert.deepEqual(result.routes[0].segments[0].start, O);
  assert.deepEqual(result.routes[0].segments[0].end, D);
  assert.deepEqual(
    result.routes[0].segments[0].polyline,
    [snappedStart, snappedEnd],
    'normalization must not invent geometry between snapped points and the request',
  );
  assert.deepEqual(route.segments[0].start, snappedStart, 'provider source remains unchanged');
  const far = source('far', [leg('far-walk', 'walk', point('far origin', 76), D, 900)]);
  assert.equal(planJourneyGraph(request(), [far], { receivedAt: NOW }).routes.length, 0);
  const interior = source('interior', [
    leg('access', 'walk', O, point('near boarding', 295), 20),
    leg('bus', 'bus', A, D, 10),
  ]);
  assert.equal(
    planJourneyGraph(request(), [interior], { receivedAt: NOW }).routes.length,
    0,
    'nearby interior anchors still need a real transfer leg',
  );
  const nearTaxi = source('near taxi', [
    leg('pickup', 'wait', snappedStart, snappedStart, 30),
    leg('taxi', 'taxi', snappedStart, D, 100),
  ]);
  assert.equal(
    planJourneyGraph(request(), [nearTaxi], { receivedAt: NOW }).routes.length,
    0,
    'boundary alignment cannot move a vehicle pickup',
  );
});

test('snapped foot endpoint and its provider allowance align together without dropping time', () => {
  const end = point('snapped destination', 880);
  const route = source('allowance', [
    leg('walk', 'walk', point('snapped origin', 20), end, 100),
    leg('allowance-provider-extra', 'wait', end, end, 25),
  ]);
  const result = planJourneyGraph(request(), [route], { receivedAt: NOW });
  assert.equal(result.routes[0]?.durationSeconds.max, 125);
  assert.deepEqual(result.routes[0].segments.at(-1)?.end, D);
});

test('source-equivalent arcs do not consume result slots or the edge budget and distinct lines remain', () => {
  const copies = Array.from({ length: 20 }, (_, index) =>
    source(`copy-${index}`, [
      leg(`wait-${index}`, 'wait', O, O, 30),
      leg(`bus-${index}`, 'bus', O, D, 100, {
        lineName: '100',
        direction: '출발 → 도착',
        transit: { lines: ['100'], stops: [O.name, D.name] },
      }),
    ]),
  );
  const distinct = source('different-line', [
    leg('different-wait', 'wait', O, O, 30),
    leg('different-bus', 'bus', O, D, 120, {
      lineName: '200',
      direction: '출발 → 도착',
      transit: { lines: ['200'], stops: [O.name, D.name] },
    }),
  ]);
  const result = planJourneyGraph(request(), [...copies, distinct, walking()], {
    receivedAt: NOW,
    maxResults: 3,
    maxEdges: 3,
  });
  assert.equal(result.diagnostics.edges, 3);
  assert.equal(result.diagnostics.limitReached, false);
  assert.equal(result.routes.length, 3);
  assert.deepEqual(
    result.routes.map(
      (route) => route.segments.find((segment) => segment.mode === 'bus')?.lineName,
    ),
    ['100', '200', undefined],
  );
});

test('a declared provider transfer tolerates small source-local endpoint rounding without joining separate routes', () => {
  const transfer = point('rounded transfer start', 303),
    boarding = point('rounded transfer end', 597);
  const itinerary = source('declared-itinerary', [
    leg('first-bus', 'bus', O, A, 60),
    leg('transfer', 'walk', transfer, boarding, 60),
    leg('next-wait', 'wait', B, B, 30),
    leg('next-bus', 'bus', B, D, 60),
  ]);
  const result = planJourneyGraph(request(), [itinerary], { ...TOY_GEOMETRY, receivedAt: NOW });
  assert.equal(result.routes.length, 1);
  const walk = result.routes[0].segments.find((segment) => segment.mode === 'walk')!;
  assert.deepEqual(walk.start, A);
  assert.deepEqual(walk.end, B);
  assert.deepEqual(walk.polyline, [transfer, boarding]);
  const separate = [
    source('first', [leg('first-bus', 'bus', O, A, 60)]),
    source('unrelated', [leg('transfer', 'walk', transfer, boarding, 60)]),
    source('next', [leg('next-bus', 'bus', B, D, 60)]),
  ];
  assert.equal(
    planJourneyGraph(request(), separate, { ...TOY_GEOMETRY, receivedAt: NOW }).routes.length,
    0,
  );
});

test('taxi dispatch rules use the actual downstream pickup time and only marked waits are retimed', () => {
  const departure = Date.parse('2026-10-12T08:25:00Z'); // 17:25 KST; pickup reaches rush hour.
  const timedTaxi = taxi();
  timedTaxi.segments[0].timingRule = 'taxi-dispatch';
  const input = { ...request(), now: departure, deadline: departure + 3600000 };
  const access = source('walk-to-taxi', [leg('access', 'walk', O, B, 600)]);
  const result = planJourneyGraph(input, [access, timedTaxi], { receivedAt: departure });
  assert.equal(
    result.routes[0].segments.find((segment) => segment.mode === 'wait')?.durationSeconds.max,
    420,
  );
  assert.equal(result.routes[0].durationSeconds.max, 1120);
  assert.equal(
    planJourneyGraph(input, [access, taxi()], { receivedAt: departure }).routes[0].durationSeconds
      .max,
    740,
    'provider or fixture waits are never guessed to be dispatch rules',
  );
});

test('re-evaluated taxi dispatch retains its included planning buffer exactly once', () => {
  const departure = Date.parse('2026-10-12T08:35:00Z'); // 17:35 KST rush hour.
  const input = { ...request(), now: departure, deadline: departure + 3600000 };
  const dispatch = leg('dispatch', 'wait', O, O, 420, {
    durationSeconds: { min: 420, max: 480 },
    timingRule: 'taxi-dispatch',
    planningBuffer: { weatherSeconds: 0, calibrationSeconds: 60 },
  });
  const route = source('buffered-taxi', [
    dispatch,
    leg('taxi', 'taxi', O, D, 100, { costWon: 5000 }),
  ]);
  const graph = planJourneyGraph(input, [route], { receivedAt: departure });
  assert.deepEqual(graph.routes[0]?.durationSeconds, { min: 520, max: 580 });
  assert.deepEqual(graph.routes[0]?.segments[0].durationSeconds, { min: 420, max: 480 });
  assert.deepEqual(graph.routes[0]?.segments[0].planningBuffer, {
    weatherSeconds: 0,
    calibrationSeconds: 60,
  });
  assert.deepEqual(
    planJourneyGraph(input, graph.routes, { receivedAt: departure }).routes[0]?.durationSeconds,
    { min: 520, max: 580 },
  );
});

test('graph chronology rejects negative fractional or unincluded planning buffer metadata', () => {
  for (const planningBuffer of [
    { weatherSeconds: -1, calibrationSeconds: 0 },
    { weatherSeconds: 0.5, calibrationSeconds: 0 },
    { weatherSeconds: 0, calibrationSeconds: 101 },
  ]) {
    const candidate = source('invalid-buffer', [
      leg('invalid-buffer', 'walk', O, D, 100, {
        durationSeconds: { min: 100, max: 200 },
        planningBuffer,
      }),
    ]);
    assert.equal(planJourneyGraph(request(), [candidate], { receivedAt: NOW }).routes.length, 0);
  }
});

test('different access ranges that catch the same observed vehicle share its absolute arrival', () => {
  const broad = source('broad', [
    leg('broad', 'walk', O, A, 60, { durationSeconds: { min: 60, max: 120 } }),
  ]);
  const narrow = source('narrow', [
    leg('narrow', 'walk', O, A, 100, { durationSeconds: { min: 100, max: 120 } }),
  ]);
  const next = source('next', [
    leg('next', 'bus', A, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 180000 }],
      },
    }),
  ]);
  const result = planJourneyGraph(request(), [broad, narrow, next], {
    receivedAt: NOW,
    distinctRides: false,
  });
  assert.deepEqual(
    result.routes.map((route) => route.durationSeconds),
    [
      { min: 240, max: 240 },
      { min: 240, max: 240 },
    ],
  );
  assert.equal(
    result.routes.some((route) => route.segments[0].id.includes('narrow')),
    true,
  );
  assert.equal(
    result.routes.some((route) => route.segments[0].id.includes('broad')),
    true,
  );
});

test('parking operating access is checked at the recomposed car arrival before admitting its edge', () => {
  const parking = {
    publicAccess: true as const,
    provider: 'seoul-parking',
    operating: 'open' as const,
    occupancy: 'available' as const,
    fee: 'paid' as const,
    verifiedAt: NOW,
    occupancyObservedAt: NOW,
    availableSpaces: 3,
  };
  const car = source('car', [
    leg('drive', 'car', A, D, 100, { parkingAccess: parking }),
    leg('park', 'wait', D, D, 180),
  ]);
  const access = source('access', [leg('access', 'walk', O, A, 120)]);
  let observedArrival = 0;
  const result = planJourneyGraph(
    request({ hasCar: true, carLocation: A }),
    [access, car, walking()],
    {
      receivedAt: NOW,
      parkingAt: (lot, arrival) => {
        assert.equal(lot.id, D.id);
        observedArrival = arrival;
        return { ...parking, operating: 'closed' };
      },
    },
  );
  assert.equal(
    observedArrival,
    NOW + 220000,
    'check entrance at 120s car access + 100s driving, before the parking action',
  );
  assert.equal(
    result.routes[0].segments.some((segment) => segment.mode === 'car'),
    false,
  );
  const updated = planJourneyGraph(request({ hasCar: true, carLocation: A }), [access, car], {
    receivedAt: NOW,
    parkingAt: () => ({ ...parking, availableSpaces: 7 }),
  });
  assert.equal(
    updated.routes[0].segments.find((segment) => segment.mode === 'car')?.parkingAccess
      ?.availableSpaces,
    7,
  );
  assert.equal(
    planJourneyGraph(request({ hasCar: true, carLocation: A }), [access, car, walking()], {
      receivedAt: NOW,
      parkingAt: () => null,
    }).routes[0].segments.some((segment) => segment.mode === 'car'),
    false,
  );
});

test('parking completion after opening cannot justify entering a lot before it opens', () => {
  const parking = {
    publicAccess: true as const,
    provider: 'seoul-parking',
    operating: 'open' as const,
    occupancy: 'available' as const,
    fee: 'paid' as const,
    verifiedAt: NOW,
    occupancyObservedAt: NOW,
    availableSpaces: 3,
  };
  const car = source('early-car', [
    leg('drive', 'car', A, D, 100, { parkingAccess: parking }),
    leg('park', 'wait', D, D, 180),
  ]);
  const access = source('access', [leg('access', 'walk', O, A, 120)]);
  const result = planJourneyGraph(
    request({ hasCar: true, carLocation: A }),
    [access, car, walking()],
    {
      receivedAt: NOW,
      parkingAt: (_lot, arrival) => ({
        ...parking,
        operating: arrival < NOW + 300000 ? 'closed' : 'open',
      }),
    },
  );
  assert.equal(
    result.routes[0].segments.some((segment) => segment.mode === 'car'),
    false,
  );
});

test('an earlier exact arrival cannot prune a later pickup whose coarse dispatch estimate improves', () => {
  const departure = Date.parse('2026-10-12T10:27:00Z'); // 19:27 KST; dispatch drops at 19:30.
  const early = source('early', [leg('early', 'walk', O, B, 120)]);
  const later = source('later', [leg('later', 'walk', O, B, 180)]);
  const dispatch = taxi();
  dispatch.segments[0].timingRule = 'taxi-dispatch';
  const result = planJourneyGraph(
    { ...request(), now: departure, deadline: departure + 3600000 },
    [early, later, dispatch],
    { receivedAt: departure, maxResults: 1 },
  );
  assert.equal(result.routes[0].durationSeconds.max, 580);
  assert.equal(result.routes[0].segments[0].id.includes('later'), true);
});

test('a borderline fallback always identifies an actual observed next vehicle', () => {
  const access = source('variable-access', [
    leg('access', 'walk', O, A, 0, { durationSeconds: { min: 0, max: 100 } }),
  ]);
  const next = source('next', [
    leg('next', 'bus', A, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [
          { line: '100', message: '도착 예측', arrivesAt: NOW + 90000 },
          { line: '100', message: '도착 예측', arrivesAt: NOW + 140000 },
        ],
      },
    }),
  ]);
  const result = planJourneyGraph(request(), [access, next], { receivedAt: NOW });
  const connection = result.routes[0].segments.find(
    (segment) => segment.mode === 'bus',
  )?.plannedConnection;
  assert.equal(connection?.status, 'borderline');
  assert.equal(
    connection?.fallbackDepartureAt,
    NOW + 140000,
    'uncertainty arithmetic is not evidence of an additional vehicle',
  );
  assert.equal(
    connection?.boardingMarginSeconds,
    -40,
    'the first vehicle margin must include the slow access case',
  );
});

test('far-future transfers outside a fresh prediction horizon use labeled average waits without inventing vehicles', () => {
  const first = source('long-first', [
    leg('first-wait', 'wait', O, O, 30),
    leg('first', 'bus', O, A, 1200),
  ]);
  const next = source('future', [
    leg('future', 'subway', A, D, 600, {
      realtime: {
        provider: 'seoul-subway',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [
          { line: '2호선', message: '도착 예측', arrivesAt: NOW + 90000 },
          { line: '2호선', message: '도착 예측', arrivesAt: NOW + 240000 },
        ],
      },
    }),
  ]);
  const graph = planJourneyGraph(request(), [first, next, walking()], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  });
  const candidate = graph.routes.find((route) =>
    route.segments.some((segment) => segment.mode === 'subway'),
  )!;
  assert.ok(candidate);
  const last = candidate.segments.find((segment) => segment.mode === 'subway')!;
  // The list still bounds the next train (never before one headway after its last entry); no listed train is claimed.
  assert.ok(last.realtime);
  assert.equal(last.plannedConnection?.explanation, LIVE_MISSED_HEADWAY_EXPLANATION);
  assert.ok(
    last.realtime.predictions.every(
      (prediction) => prediction.arrivesAt < last.plannedConnection!.departureAt,
    ),
  );
  assert.ok(
    candidate.notes?.some(
      (note) => note.code === 'unverified-schedule' && /평균 배차/.test(note.description),
    ),
  );
  const planned = planBaseRoutes(request(), [candidate], {
    mode: 'live',
    provider: 'test',
    label: '실제 조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.ok(
    planned.routes[0].risks.some(
      (risk) => risk.code === 'unverified-schedule' && risk.severity === 'warning',
    ),
  );
  for (const live of [
    { ...next.segments[0].realtime!, status: 'no-service' as const },
    {
      ...next.segments[0].realtime!,
      predictions: next.segments[0].realtime!.predictions.map((prediction) => ({
        ...prediction,
        lastService: true,
      })),
    },
  ]) {
    const blocked = source('ended', [{ ...next.segments[0], realtime: live }]);
    assert.equal(
      planJourneyGraph(request(), [first, blocked, walking()], {
        ...TOY_GEOMETRY,
        receivedAt: NOW,
      }).routes.some((route) => route.segments.some((segment) => segment.mode === 'subway')),
      false,
    );
  }
  const immediate = source('immediate', [leg('late-access', 'walk', O, A, 120)]);
  // A nearby boarding that misses the only listed train still has the next train.
  const missed = planJourneyGraph(
    request(),
    [
      immediate,
      source('missed', [
        {
          ...next.segments[0],
          realtime: {
            ...next.segments[0].realtime!,
            predictions: [{ line: '2호선', message: '도착 예측', arrivesAt: NOW + 90000 }],
          },
        },
      ]),
      walking(),
    ],
    { ...TOY_GEOMETRY, receivedAt: NOW },
  ).routes.find((route) => route.segments.some((segment) => segment.mode === 'subway'));
  assert.ok(missed?.segments.some((segment) => segment.title === '다음 차량 대기'));
});

test('only a declared same-station subway transfer can align a rail endpoint twenty metres from its walking platform', () => {
  const railEnd = { ...A, name: '동대문역사문화공원(DDP)' },
    platform = { ...point('platform', 323), name: '동대문역사문화공원역' };
  const route = source('provider-transfer', [
    leg('rail', 'subway', O, railEnd, 120),
    leg('transfer', 'walk', platform, B, 180),
    leg('second', 'subway', B, D, 300),
  ]);
  assert.equal(
    planJourneyGraph(request(), [route], { ...TOY_GEOMETRY, receivedAt: NOW }).routes.length,
    1,
  );
  const walk = planJourneyGraph(request(), [route], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  }).routes[0].segments.find((segment) => segment.mode === 'walk')!;
  assert.deepEqual(walk.start, railEnd);
  assert.deepEqual(walk.polyline?.[0], platform);
  const changedName = source(
    'different-station',
    route.segments.map((segment) =>
      segment.mode === 'walk' ? { ...segment, start: { ...platform, name: '다른역' } } : segment,
    ),
  );
  assert.equal(
    planJourneyGraph(request(), [changedName], { ...TOY_GEOMETRY, receivedAt: NOW }).routes.length,
    0,
  );
  const busRoute = source(
    'bus-transfer',
    route.segments.map((segment) =>
      segment.id === 'rail' ? { ...segment, mode: 'bus' } : segment,
    ),
  );
  assert.equal(
    planJourneyGraph(request(), [busRoute], { ...TOY_GEOMETRY, receivedAt: NOW }).routes.length,
    0,
  );
  assert.equal(
    planJourneyGraph(
      request(),
      [
        source('separate-rail', [route.segments[0]]),
        source('separate-foot', route.segments.slice(1)),
      ],
      { receivedAt: NOW },
    ).routes.length,
    0,
  );
});

test('a rental permission must remain valid through a delayed composed ride', () => {
  const rental = bike();
  rental.segments[0].rentalValidity = {
    verifiedAt: NOW,
    validUntil: NOW + 300000,
    vehicleId: 'device-1',
    provider: 'test-operator',
  };
  const delayed = source('delayed-access', [leg('slow', 'walk', O, A, 240)]);
  assert.equal(
    planJourneyGraph(request(), [delayed, rental, taxi(), walking()], {
      receivedAt: NOW,
    }).routes[0].segments.some((segment) => segment.mode === 'bicycle'),
    false,
  );
  rental.segments[0].rentalValidity.validUntil = NOW + 600000;
  assert.equal(
    planJourneyGraph(request(), [delayed, rental, taxi(), walking()], {
      receivedAt: NOW,
    }).routes[0].segments.some((segment) => segment.mode === 'bicycle'),
    true,
  );
  rental.segments[0].rentalValidity.verifiedAt = NOW - 121000;
  assert.equal(
    planJourneyGraph(request(), [delayed, rental, taxi(), walking()], {
      receivedAt: NOW,
    }).routes[0].segments.some((segment) => segment.mode === 'bicycle'),
    false,
  );
});

test('a recomposed path keeps only notes relevant to its used source segments', () => {
  const first = bus();
  first.segments.unshift(
    leg('unverified-access', 'walk', point('unused source origin', -300), O, 300, {
      polyline: undefined,
    }),
  );
  first.notes = [
    {
      code: 'unverified-duration-range',
      severity: 'warning',
      title: '일부 도보 경로 미확인',
      description:
        '정류장까지의 도보 시간을 거리로 추정했어요. 실제 보행 경로를 확인하기 전에는 추천하지 않아요.',
    },
    {
      code: 'destination-entry',
      severity: 'warning',
      title: '사용하지 않은 접근 구간',
      description: '원래 접근 구간에만 해당하는 경고예요.',
      segmentId: 'unverified-access',
    },
    {
      code: 'unverified-schedule',
      severity: 'warning',
      title: '이 버스의 운행 확인 필요',
      description: '실제로 사용하는 차량의 운행 경고예요.',
      segmentId: 'bus',
    },
    {
      code: 'unverified-duration-range',
      severity: 'warning',
      title: '공급원 시간 범위 확인',
      description: '실제로 조회한 이동 시간의 일반적인 제한이에요.',
    },
  ];
  const result = planJourneyGraph(request(), [first, bike(), taxi()], { receivedAt: NOW });
  assert.equal(result.routes.length, 1);
  const notes = result.routes[0].notes!;
  assert.equal(
    notes.some((note) => note.title === '일부 도보 경로 미확인'),
    false,
  );
  assert.equal(
    notes.some((note) => note.title === '사용하지 않은 접근 구간'),
    false,
  );
  assert.equal(
    notes.some((note) => note.title === '이 버스의 운행 확인 필요'),
    true,
  );
  assert.equal(
    notes.find((note) => note.title === '이 버스의 운행 확인 필요')?.segmentId,
    result.routes[0].segments.find((segment) => segment.mode === 'bus')?.id,
  );
  assert.equal(
    notes.some((note) => note.title === '공급원 시간 범위 확인'),
    true,
    'unrelated duration warnings must remain',
  );
  assert.equal(
    result.routes[0].segments.some((segment) => segment.id.includes('unverified-access')),
    false,
    'unverified geometry is still excluded',
  );
});

test('uncertain access to the same observed bus converges at its absolute departure instead of inflating arrival', () => {
  const access = source('variable-access', [
    leg('access', 'walk', O, A, 60, { durationSeconds: { min: 60, max: 120 } }),
  ]);
  const next = source('live-bus', [
    leg('live-bus', 'bus', A, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 180000 }],
      },
    }),
  ]);
  const direct = source('direct', [leg('direct', 'walk', O, D, 250)]);
  const result = planJourneyGraph(request(), [access, next, direct], { receivedAt: NOW });
  assert.deepEqual(result.routes[0].durationSeconds, { min: 240, max: 240 });
  assert.equal(result.routes[0].segments.at(-1)?.mode, 'bus');
  const planned = planBaseRoutes(request(), result.routes, {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  const route = planned.routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'bus'),
  )!;
  assert.deepEqual(route.arrivalTime, { earliest: NOW + 240000, latest: NOW + 240000 });
  assert.deepEqual(route.segments.find((segment) => segment.mode === 'wait')?.durationSeconds, {
    min: 60,
    max: 120,
  });
  assert.deepEqual(route.segments.find((segment) => segment.mode === 'wait')?.timeRange, {
    earliest: NOW + 180000,
    latest: NOW + 180000,
  });
});

test('two uncertain accesses each converge at their actual observed connecting vehicle', () => {
  const first = source('first-access', [
    leg('first-access', 'walk', O, A, 60, { durationSeconds: { min: 60, max: 120 } }),
  ]);
  const ride = source('first-vehicle', [
    leg('first-vehicle', 'bus', A, B, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 180000 }],
      },
    }),
  ]);
  const platform = point('platform', 700);
  const transfer = source('transfer', [
    leg('transfer', 'walk', B, platform, 60, { durationSeconds: { min: 60, max: 120 } }),
  ]);
  const second = source('second-vehicle', [
    leg('second-vehicle', 'bus', platform, D, 100, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: platform.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '200', message: '도착 예측', arrivesAt: NOW + 480000 }],
      },
    }),
  ]);
  const result = planJourneyGraph(request(), [first, ride, transfer, second], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  });
  assert.deepEqual(result.routes[0]?.durationSeconds, { min: 580, max: 580 });
  const planned = planBaseRoutes(request(), result.routes, {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.deepEqual(planned.routes[0]?.arrivalTime, {
    earliest: NOW + 580000,
    latest: NOW + 580000,
  });
  const ordinary = source('ordinary', [
    ...first.segments,
    ...ride.segments,
    ...transfer.segments,
    ...second.segments,
  ]);
  const baseline = planBaseRoutes(request(), [ordinary], {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.deepEqual(baseline.routes[0]?.arrivalTime, {
    earliest: NOW + 580000,
    latest: NOW + 580000,
  });
  assert.equal(
    baseline.routes[0]?.segments
      .filter((segment) => segment.mode === 'bus')
      .every((segment) => segment.plannedConnection && segment.provenance.isRealtime),
    true,
  );
});

test('different arrival clocks remain separate states and a later supplied faster candidate wins in either source order', () => {
  const slow = Array.from({ length: 12 }, (_, index) =>
    source(`slow-${index}`, [leg(`slow-${index}`, 'walk', O, A, 100 + index)]),
  );
  const fast = source('fast', [leg('fast', 'walk', O, A, 10)]),
    tail = source('tail', [leg('tail', 'walk', A, D, 50)]);
  for (const sources of [
    [...slow, fast, tail],
    [fast, ...slow, tail],
  ]) {
    const result = planJourneyGraph(request(), sources, { receivedAt: NOW, maxResults: 1 });
    assert.deepEqual(result.routes[0]?.durationSeconds, { min: 60, max: 60 });
    assert.equal(result.routes[0].segments[0].id.includes('fast'), true);
    assert.equal(result.diagnostics.limitReached, false);
    assert.equal(result.diagnostics.optimalityProven, true);
  }
});

test('a second rental is neither refused nor priced, and two leases keep their independent permissions', () => {
  const lease = (id: string, mode: 'bicycle' | 'scooter', start: Place, end: Place) =>
    source(id, [
      leg(`${id}-hire`, 'hire', start, start, 10, {
        rentalValidity: {
          verifiedAt: NOW,
          validUntil: NOW + 600000,
          vehicleId: id,
          provider: 'test-operator',
        },
      }),
      leg(`${id}-ride`, mode, start, end, 50, { routingProfile: mode }),
      leg(`${id}-return`, 'return', end, end, 10),
    ]);
  const first = lease('bike', 'bicycle', O, A),
    last = lease('scooter', 'scooter', B, D);
  const middle = source('middle', [
    leg('bus-wait', 'wait', A, A, 30),
    leg('middle-bus', 'bus', A, B, 60),
  ]);
  const hires = (route: BaseRoute) =>
    route.segments.filter((segment) => segment.mode === 'hire').length;
  // A second rental is neither refused nor priced (D1): the bicycle, bus and scooter chain takes 230 s against 1,200 s on
  // foot, so it is the fastest journey with the walk comparisons on as well.
  const single = planJourneyGraph(request(), [first, middle, last, walking()], {
    receivedAt: NOW,
  });
  assert.deepEqual(single.routes[0]?.durationSeconds, { min: 230, max: 230 });
  assert.equal(hires(single.routes[0]), 2);
  const result = planJourneyGraph(request(), [first, middle, last, walking()], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  });
  assert.deepEqual(result.routes[0]?.durationSeconds, { min: 230, max: 230 });
  assert.equal(result.routes[0].segments.filter((segment) => segment.mode === 'hire').length, 2);
  assert.equal(
    planBaseRoutes(request(), result.routes, {
      mode: 'live',
      provider: 'test',
      label: '조회',
      sourceTimestamp: null,
      receivedAt: NOW,
      isRealtime: false,
    }).routes.some((route) => route.bicycleRentals === 1),
    true,
  );
  last.segments[0].rentalValidity!.validUntil = NOW + 200000;
  assert.equal(
    planJourneyGraph(request(), [first, middle, last, walking()], {
      ...TOY_GEOMETRY,
      receivedAt: NOW,
    }).routes.some((route) => route.segments.some((segment) => segment.mode === 'scooter')),
    false,
  );
});

test('an equal-time estimated arrival cannot remove an observed connection with different confidence evidence', () => {
  const estimate = source('estimate', [
    leg('average-expected-wait', 'wait', O, O, 30),
    leg('estimate', 'bus', O, A, 100),
  ]);
  const observed = source('observed', [
    leg('observed', 'bus', O, A, 40, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: O.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 90000 }],
      },
    }),
  ]);
  const tail = source('tail', [leg('tail', 'walk', A, D, 60)]);
  const routes = planJourneyGraph(request(), [estimate, observed, tail], {
    receivedAt: NOW,
  }).routes;
  assert.equal(
    routes.some(
      (route) =>
        route.durationSeconds.max === 190 &&
        route.segments.some((segment) => segment.mode === 'bus' && segment.plannedConnection),
    ),
    true,
  );
});

test('the public bicycle rental count does not include a scooter lease', () => {
  const scooter = source('scooter', [
    leg('scooter-hire', 'hire', O, O, 10),
    leg('scooter', 'scooter', O, D, 50, { routingProfile: 'scooter' }),
    leg('scooter-return', 'return', D, D, 10),
  ]);
  const graph = planJourneyGraph(request(), [scooter], { receivedAt: NOW });
  const route = planBaseRoutes(request(), graph.routes, {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  }).routes[0];
  assert.equal(route.bicycleRentals, 0);
  assert.equal(route.segments.filter((segment) => segment.mode === 'hire').length, 1);
});

test('equivalent geometry with different provider caveats keeps the independently verified candidate', () => {
  const conditional = source('conditional', [leg('bus', 'bus', O, A, 100)]);
  conditional.notes = [
    {
      code: 'vehicle-availability',
      severity: 'warning',
      title: '조건부 승차 확인',
      description: '이 공급원에는 별도 승차 조건이 남아 있어요.',
    },
  ];
  const verified = source('verified', [...conditional.segments]);
  const tail = source('tail', [leg('tail', 'walk', A, D, 60)]);
  const result = planJourneyGraph(request(), [conditional, verified, tail], {
    ...TOY_GEOMETRY,
    receivedAt: NOW,
  });
  assert.equal(
    result.routes.some(
      (route) => !route.notes?.some((note) => note.code === 'vehicle-availability'),
    ),
    true,
  );
});

test('trusted correlated graph timing cannot accept a forged departure, wait or route total', () => {
  const access = source('access', [
    leg('access', 'walk', O, A, 60, { durationSeconds: { min: 60, max: 120 } }),
  ]);
  const next = source('live', [
    leg('live', 'bus', A, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 180000 }],
      },
    }),
  ]);
  const graph = planJourneyGraph(request(), [access, next], { receivedAt: NOW }).routes[0];
  const provenance = {
    mode: 'live' as const,
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  assert.equal(planBaseRoutes(request(), [graph], provenance).routes.length, 1);
  for (const mutate of [
    (base: BaseRoute) => {
      base.durationSeconds.max++;
    },
    (base: BaseRoute) => {
      base.segments.find((segment) => segment.mode === 'wait')!.durationSeconds.min++;
    },
    (base: BaseRoute) => {
      for (const segment of base.segments)
        if (segment.plannedConnection) segment.plannedConnection.departureAt += 1000;
    },
    (base: BaseRoute) => {
      delete base.segments.find((segment) => segment.mode === 'wait')!.plannedConnection;
    },
    (base: BaseRoute) => {
      for (const segment of base.segments)
        if (segment.realtime) segment.realtime.observedAt = NOW - 121000;
    },
  ]) {
    const forged = structuredClone(graph);
    mutate(forged);
    assert.equal(planBaseRoutes(request(), [forged], provenance).routes.length, 0);
  }
});

test('physical wait bounds include the next vehicle switch while absolute boarding range uses observed predictions', () => {
  const access = source('access', [
    leg('access', 'walk', O, A, 0, { durationSeconds: { min: 0, max: 100 } }),
  ]);
  const next = source('live', [
    leg('live', 'bus', A, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: A.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [
          { line: '100', message: '첫 편', arrivesAt: NOW + 90000 },
          { line: '100', message: '다음 편', arrivesAt: NOW + 140000 },
        ],
      },
    }),
  ]);
  const graph = planJourneyGraph(request(), [access, next], { receivedAt: NOW }).routes[0];
  assert.deepEqual(graph.durationSeconds, { min: 150, max: 200 });
  assert.deepEqual(graph.segments.find((segment) => segment.mode === 'wait')?.durationSeconds, {
    min: 30,
    max: 90,
  });
  const planned = planBaseRoutes(request(), [graph], {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  }).routes[0];
  assert.deepEqual(planned.arrivalTime, { earliest: NOW + 150000, latest: NOW + 200000 });
  assert.equal(
    planned.segments.find((segment) => segment.mode === 'bus')?.connection?.fallbackDepartureAt,
    NOW + 140000,
  );
});

test('a live connection replaces identified average wait but preserves unclassified provider overhead', () => {
  const access = leg('access', 'walk', O, A, 60, { durationSeconds: { min: 60, max: 120 } });
  const ride = leg('bus', 'bus', A, D, 60, {
    realtime: {
      provider: 'seoul-bus',
      status: 'live',
      stopName: A.name,
      observedAt: NOW,
      receivedAt: NOW,
      predictions: [{ line: '100', message: '도착 예측', arrivesAt: NOW + 180000 }],
    },
  });
  const overhead = leg('unclassified-provider-extra', 'wait', D, D, 40, {
    durationSeconds: { min: 40, max: 80 },
  });
  const ordinary = source('ordinary', [access, ride, overhead]);
  assert.deepEqual(
    planJourneyGraph(request(), [ordinary], { receivedAt: NOW }).routes[0]?.durationSeconds,
    { min: 280, max: 320 },
  );
  const planned = planBaseRoutes(request(), [ordinary], {
    mode: 'live',
    provider: 'test',
    label: '조회',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.deepEqual(planned.routes[0]?.durationSeconds, { min: 280, max: 320 });
  assert.deepEqual(planned.routes[0]?.segments.at(-1)?.durationSeconds, { min: 40, max: 80 });
});

test('a supplied fixed stop delay is retained before choosing the catchable live vehicle', () => {
  const delay = leg('fixed-stop-delay', 'wait', O, O, 120);
  const ride = leg('live', 'bus', O, D, 60, {
    realtime: {
      provider: 'seoul-bus',
      status: 'live',
      stopName: O.name,
      observedAt: NOW,
      receivedAt: NOW,
      predictions: [
        { line: '100', message: '첫 편', arrivesAt: NOW + 90000 },
        { line: '100', message: '다음 편', arrivesAt: NOW + 180000 },
      ],
    },
  });
  const candidate = source('known-delay', [delay, ride]);
  assert.deepEqual(
    planJourneyGraph(request(), [candidate], { receivedAt: NOW }).routes[0]?.durationSeconds,
    { min: 240, max: 240 },
  );
});
