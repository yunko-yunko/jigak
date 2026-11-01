import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import {
  discoverIntermediateTransit,
  intermediateStationQueries,
} from '../src/common/engine/intermediate-transit.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import type { NearbyPlace, RouteProvider } from '../src/common/engine/kakao.js';
import { continuesRide, rideGroups, rideKey } from '../src/common/engine/ride-identity.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.parse('2026-10-12T05:00:00Z');
const place = (id: string, name: string, meters: number): Place => ({
  id,
  name,
  address: '서울',
  latitude: 37.55 + meters / 111_195,
  longitude: 126.97,
});
const O = place('o', '출발', 0),
  M = place('m', '당산', 3_000),
  D = place('d', '도착', 6_000);

function ride(
  id: string,
  start: Place,
  end: Place,
  line: string,
  stops: string[],
  extra: Partial<BaseSegment> = {},
  mode: 'subway' | 'bus' = 'subway',
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '실제 조회 구간',
    start,
    end,
    distanceMeters: 3_000,
    durationSeconds: { min: 300, max: 300 },
    runAllowed: false,
    polyline: [start, end],
    lineName: line,
    transit: { lines: line.split(' / '), stops },
    ...extra,
  };
}
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
    ...(start === end ? {} : { polyline: [start, end] }),
    ...extra,
  };
}
function source(id: string, segments: BaseSegment[]): BaseRoute {
  return {
    id,
    title: id,
    segments,
    transfers: 0,
    distanceMeters: segments.reduce((sum, part) => sum + part.distanceMeters, 0),
    durationSeconds: segments.reduce(
      (sum, part) => ({
        min: sum.min + part.durationSeconds.min,
        max: sum.max + part.durationSeconds.max,
      }),
      { min: 0, max: 0 },
    ),
  };
}
const request = (preferences = {}) => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: { ...DEFAULT_PREFERENCES, preparationSeconds: 0, ...preferences },
});

test('one service ridden through a shared station is one ride, while real changes of train stay separate rides', () => {
  const first = ride('a', O, M, '4호선', ['노원', '창동', '미아사거리']);
  const second = ride('b', M, D, '4호선', ['미아사거리', '길음', '혜화']);
  assert.equal(continuesRide(first, second), true, 'the benchmark 노원→미아사거리→혜화 split');
  assert.equal(
    continuesRide({ ...first, lineName: undefined, transit: undefined }, second),
    false,
    'no named line is no evidence',
  );
  assert.equal(
    continuesRide(first, ride('c', M, D, '6호선', ['미아사거리', '길음', '혜화'])),
    false,
    'another line is a transfer',
  );
  assert.equal(
    continuesRide(first, ride('d', M, O, '4호선', ['미아사거리', '창동', '노원'])),
    false,
    'reversing along the stops just ridden is not a continuation',
  );
  assert.equal(
    continuesRide(first, ride('e', M, D, '4호선', ['길음', '혜화'])),
    false,
    'a different boarding station is a different ride',
  );
  assert.equal(
    continuesRide(first, ride('f', M, D, '4호선', ['미아사거리', '길음', '혜화'], {}, 'bus')),
    false,
    'modes never merge',
  );
  // Provider vehicle classes: a pinned express ride and a pinned local ride are two trains.
  const express = ride('g', O, M, '9호선', ['개화', '김포공항', '당산'], {
    transit: { lines: ['9호선'], stops: ['개화', '김포공항', '당산'], vehicleTypes: ['급행'] },
  });
  const local = ride('h', M, D, '9호선', ['당산', '선유도', '여의도'], {
    transit: { lines: ['9호선'], stops: ['당산', '선유도', '여의도'], vehicleTypes: ['일반'] },
  });
  const both = ride('i', M, D, '9호선', ['당산', '선유도', '여의도'], {
    transit: {
      lines: ['9호선'],
      stops: ['당산', '선유도', '여의도'],
      vehicleTypes: ['일반', '급행'],
    },
  });
  assert.equal(continuesRide(express, local), false);
  assert.equal(
    continuesRide(express, both),
    true,
    'a stretch served by both classes can be ridden on one train',
  );
  // Branches of one line: the 성수지선 shuttle is another train from the main ring.
  const ring = ride('j', O, M, '2호선', ['뚝섬', '성수']),
    shuttle = ride('k', M, D, '2호선', ['성수', '용답', '신답']),
    onward = ride('l', M, D, '2호선', ['성수', '건대입구']);
  assert.equal(continuesRide(ring, shuttle), false, '성수지선 change');
  assert.equal(continuesRide(ring, onward), true, '뚝섬→성수→건대입구 is one 2호선 ride');
  const lines = ride('m', O, M, '402 / 8441', ['A', 'B'], {}, 'bus'),
    more = ride('n', M, D, '8441', ['B', 'C'], {}, 'bus');
  assert.equal(
    continuesRide(lines, more),
    false,
    'a stop lists every route that calls there: 402/8441 then 8441 is the first-bus strategy, not one bus',
  );
  assert.equal(
    continuesRide(lines, ride('o', M, D, '402 / 8441', ['B', 'C'], {}, 'bus')),
    true,
    'the same routes carry on in the same direction',
  );
  assert.equal(continuesRide(ride('p', O, M, '8441', ['A', 'B'], {}, 'bus'), more), true);
});

test('ride keys fold consecutive continuations and keep the previous key for genuine transfers', () => {
  const first = ride('a', O, M, '4호선', ['노원', '창동', '미아사거리']);
  const second = ride('b', M, D, '4호선', ['미아사거리', '길음', '혜화']);
  const whole = ride('w', O, D, '4호선', ['노원', '창동', '미아사거리', '길음', '혜화']);
  const split = [leg('walk', 'walk', O, O, 60), first, leg('wait', 'wait', M, M, 300), second];
  assert.equal(rideKey(split), rideKey([whole]), 'a split and the whole ride are one identity');
  assert.equal(rideGroups(split).length, 1);
  const transfer = [first, ride('c', M, D, '6호선', ['미아사거리', '길음', '혜화'])];
  assert.equal(rideGroups(transfer).length, 2);
  assert.equal(rideKey(transfer), `subway:4호선:출발>당산|subway:6호선:당산>도착`);
  assert.equal(rideKey([leg('walk', 'walk', O, D, 600)]), 'walk');
});

function fragments(
  line: string,
  extra: Partial<BaseSegment> = {},
  firstStops = ['출발', '당산'],
  secondStops = ['당산', '도착'],
) {
  return [
    source('before', [
      leg('before-wait', 'wait', O, O, 30),
      ride('before-ride', O, M, '4호선', firstStops),
    ]),
    source('after', [
      leg('after-wait', 'wait', M, M, 30),
      ride('after-ride', M, D, line, secondStops, extra),
    ]),
  ];
}

test('the graph never alights and re-boards the same line in the same direction at one station', () => {
  const split = planJourneyGraph(request(), fragments('4호선'), { receivedAt: NOW });
  assert.equal(split.routes.length, 0, 'one 4호선 ride cannot be assembled from two halves');
  assert.ok(split.diagnostics.sameRideReboards > 0);
  assert.equal(
    planJourneyGraph(request(), fragments('6호선'), { receivedAt: NOW }).routes.length,
    1,
    'another line is a real transfer',
  );
  const withClass = (before: string, after: string) =>
    planJourneyGraph(
      request(),
      [
        source('before', [
          leg('w0', 'wait', O, O, 30),
          ride('r0', O, M, '4호선', ['출발', '당산'], {
            transit: { lines: ['4호선'], stops: ['출발', '당산'], vehicleTypes: [before] },
          }),
        ]),
        source('after', [
          leg('w1', 'wait', M, M, 30),
          ride('r1', M, D, '4호선', ['당산', '도착'], {
            transit: { lines: ['4호선'], stops: ['당산', '도착'], vehicleTypes: [after] },
          }),
        ]),
      ],
      { receivedAt: NOW },
    );
  assert.equal(
    withClass('일반', '급행').routes.length,
    1,
    'local to express is a change of trains',
  );
  assert.equal(withClass('일반', '일반').routes.length, 0);
  const branch = planJourneyGraph(
    request(),
    [
      source('before', [leg('w1', 'wait', O, O, 30), ride('r1', O, M, '2호선', ['뚝섬', '성수'])]),
      source('after', [
        leg('w2', 'wait', M, M, 30),
        ride('r2', M, D, '2호선', ['성수', '용답', '신답']),
      ]),
    ],
    { receivedAt: NOW },
  );
  assert.equal(branch.routes.length, 1, '성수지선 is a change of trains');
});

test('result slots hold distinct rides, so a slower mode is not crowded out by variants of one ride', () => {
  const S = place('s', '정류장', 300);
  const bus = source('bus', [
    leg('bus-expected-wait', 'wait', S, S, 60),
    ride('bus', S, D, '100', ['정류장', '도착'], { distanceMeters: 5_000 }, 'bus'),
  ]);
  const accesses = [
    source('fast-access', [leg('fast-walk', 'walk', O, S, 100)]),
    source('slow-access', [leg('slow-walk', 'walk', O, S, 200)]),
    source('slower-access', [leg('slower-walk', 'walk', O, S, 300)]),
  ];
  const taxi = source('taxi', [
    leg('pickup', 'wait', O, O, 40),
    leg('taxi', 'taxi', O, D, 900, { costWon: 9_000 }),
  ]);
  const options = { receivedAt: NOW, maxResults: 3 };
  const plain = planJourneyGraph(request(), [...accesses, bus], {
    ...options,
    distinctRides: false,
  });
  assert.equal(
    plain.routes.filter((route) => route.segments.some((part) => part.mode === 'bus')).length,
    3,
    'three walk variants of one bus fill every slot',
  );
  const distinct = planJourneyGraph(request(), [...accesses, bus, taxi], options);
  assert.deepEqual(
    distinct.routes.map(
      (route) => route.segments.find((part) => part.mode === 'bus' || part.mode === 'taxi')!.mode,
    ),
    ['bus', 'taxi'],
  );
  assert.equal(
    distinct.routes[0].segments[0].id.includes('fast-walk'),
    true,
    'the best estimate represents the ride',
  );
  assert.equal(distinct.diagnostics.duplicateRideResults, 2);
  assert.equal(
    new Set(distinct.routes.map((route) => rideKey(route.segments))).size,
    distinct.routes.length,
  );
  assert.equal(
    distinct.diagnostics.bestObjectiveSeconds,
    plain.diagnostics.bestObjectiveSeconds,
    'the winner is unchanged',
  );
});

test('compile exclusions are counted by kind and add up to the excluded edge count', () => {
  const disallowedRun = source('run', [leg('run', 'run', O, D, 100, { runAllowed: true })]);
  const nakedBike = source('bike', [
    leg('ride', 'bicycle', O, D, 100, { routingProfile: 'bicycle' }),
  ]);
  const unprofiled = source('rental', [
    leg('hire', 'hire', O, O, 10),
    leg('ride', 'bicycle', O, D, 100),
    leg('return', 'return', D, D, 10),
  ]);
  const brokenDuration = source('broken', [leg('walk-broken', 'walk', O, D, Number.NaN)]);
  const result = planJourneyGraph(
    request({ allowRunning: false }),
    [
      source('walk', [leg('walk', 'walk', O, D, 900)]),
      disallowedRun,
      nakedBike,
      unprofiled,
      brokenDuration,
    ],
    { receivedAt: NOW },
  );
  const reasons = result.diagnostics.excludedEdgeReasons;
  assert.equal(reasons['running-not-allowed'], 1);
  assert.equal(reasons['rental-profile'], 1);
  assert.equal(
    reasons['unplaceable-segment'],
    1,
    'a bicycle ride with no hire in front of it has no place in the network',
  );
  assert.equal(reasons.duration, 1);
  assert.equal(
    Object.values(reasons).reduce((sum, count) => sum + count, 0),
    result.diagnostics.excludedEdges,
  );
});

const station = (change: Partial<NearbyPlace> = {}): NearbyPlace => ({
  ...M,
  name: '당산역 2호선',
  category: '교통,수송 > 지하철,전철 > 수도권2호선',
  distanceMeters: 0,
  ...change,
});
const original = () =>
  source('provider-result-0', [
    ride('ride', O, D, '2호선', ['출발', '당산', '도착'], {
      durationSeconds: { min: 1_200, max: 1_200 },
    }),
  ]);
function provider(afterLine: string): RouteProvider {
  return {
    configured: true,
    searchPlaces: async () => [],
    walking: async () => [],
    nearby: async () => [station()],
    transit: async (endpoints, budget) =>
      budget.run(() => {
        const before = endpoints.origin.id === O.id;
        return [
          source('kakao', [
            leg('wait', 'wait', endpoints.origin, endpoints.origin, 30),
            before
              ? ride('ride', endpoints.origin, endpoints.destination, '2호선', ['출발', '당산'])
              : ride('ride', endpoints.origin, endpoints.destination, afterLine, ['당산', '도착']),
          ]),
        ];
      }),
  };
}

test('intermediate discovery drops a hub whose two sides ride one line in one direction, and keeps a real transfer', async () => {
  for (const [afterLine, expectedHubs] of [
    ['2호선', 0],
    ['4호선', 1],
  ] as const) {
    const budget = new CallBudget(),
      api = provider(afterLine);
    const discovered = await discoverIntermediateTransit(
      { origin: O, destination: D },
      [original()],
      { provider: api, budget, connectTransit: (endpoints) => api.transit(endpoints, budget) },
    );
    assert.equal(discovered.hubs.length, expectedHubs, afterLine);
    assert.equal(discovered.routes.length, expectedHubs * 2);
    assert.equal(discovered.diagnostics.sameLineSplits, expectedHubs ? 0 : 2);
  }
});

test('hub candidates prefer interchange stations over the middle of the line', () => {
  const stops = [
    '노원',
    '창동',
    '쌍문',
    '수유(강북구청)',
    '미아',
    '미아사거리',
    '길음',
    '성신여대입구(돈암)',
    '한성대입구(삼선교)',
    '혜화',
  ];
  const path = stops.map((_, index) => place(`p${index}`, stops[index], index * 1_000));
  const nowon = { ...path[0] },
    hyehwa = { ...path[9] };
  const line = source('provider', [
    ride('ride', nowon, hyehwa, '4호선', stops, { polyline: path }),
  ]);
  const [first] = intermediateStationQueries([line], { maxHubs: 1, now: NOW });
  assert.equal(
    first.keyword,
    '성신여대입구역 4호선',
    '성신여대입구 is where 우이신설선 stops (the nearest such station to the middle); the middle station 미아 has no other line',
  );
  const [second] = intermediateStationQueries([line], { maxHubs: 2, now: NOW }).slice(1);
  assert.equal(
    second.keyword,
    '창동역 4호선',
    'the other interchange (1호선) follows before any plain station',
  );
});

test('forking lines: 5호선 trunk trains continue onto one branch, two branches and the 2호선 shuttles are changes of trains', () => {
  const at = (stops: string[], line = '5호선') => ride(stops.join('-'), O, M, line, stops),
    then = (stops: string[], line = '5호선') => ride(stops.join('-'), M, D, line, stops);
  const trunk = at(['방화', '천호', '강동']);
  assert.equal(
    continuesRide(trunk, then(['강동', '둔촌동', '마천'])),
    true,
    '5호선 trunk to 마천 is a through service',
  );
  assert.equal(
    continuesRide(trunk, then(['강동', '길동', '굽은다리', '명일', '고덕', '하남검단산'])),
    true,
    '5호선 trunk to 하남 is a through service',
  );
  assert.equal(
    continuesRide(at(['마천', '거여', '강동']), then(['강동', '길동', '고덕', '하남검단산'])),
    false,
    '마천 branch to 하남 branch is a change at 강동',
  );
  assert.equal(
    continuesRide(at(['하남검단산', '고덕', '길동', '강동']), then(['강동', '둔촌동', '마천'])),
    false,
  );
  for (const station of [
    '길동',
    '굽은다리',
    '명일',
    '고덕',
    '상일동',
    '강일',
    '미사',
    '하남풍산',
    '하남시청',
    '하남검단산',
  ]) {
    assert.equal(
      continuesRide(at(['마천', '둔촌동', '강동']), then(['강동', station])),
      false,
      `${station} is on the 하남 branch`,
    );
  }
  // 2호선 성수지선 and 신정지선 are shuttles apart from the ring: a change only when the shuttle part is ridden.
  assert.equal(
    continuesRide(at(['시청', '왕십리', '성수'], '2호선'), then(['성수', '용답', '신답'], '2호선')),
    false,
  );
  assert.equal(
    continuesRide(
      at(['신답', '용답', '성수'], '2호선'),
      then(['성수', '건대입구', '강변'], '2호선'),
    ),
    false,
  );
  assert.equal(
    continuesRide(at(['신답', '용답'], '2호선'), then(['용답', '성수'], '2호선')),
    true,
    'both halves ride the shuttle',
  );
  assert.equal(
    continuesRide(
      at(['시청', '왕십리', '성수'], '2호선'),
      then(['성수', '건대입구', '강변'], '2호선'),
    ),
    true,
    'the ring never leaves the ring',
  );
  assert.equal(
    continuesRide(
      at(['신도림', '도림천', '양천구청'], '2호선'),
      then(['양천구청', '신정네거리'], '2호선'),
    ),
    true,
  );
  assert.equal(
    continuesRide(
      at(['대림', '신도림'], '2호선'),
      then(['신도림', '도림천', '신정네거리'], '2호선'),
    ),
    false,
    '신정지선 is a shuttle',
  );
  assert.equal(
    continuesRide(
      ride('stopless-a', O, { ...M, name: '용답' }, '2호선', []),
      ride('stopless-b', { ...M, name: '용답' }, D, '2호선', []),
    ),
    true,
    'the end stations count when the provider lists no stops',
  );
});

/* Provider shapes as Kakao returns them: one entry per line, vehicle classes listed when the stretch has both. */
const station2 = (id: string, name: string, meters: number, east = 0): Place => ({
  id,
  name,
  address: '서울',
  latitude: 37.5 + meters / 111_195,
  longitude: 126.88 + east / 88_000,
});
const KO = station2('o', '출발', 0),
  KA = station2('a', '구로', 3_000),
  KA2 = station2('a2', '구로', 3_000, 30),
  KD = station2('d', '도착', 3_000, 2_500);
const kakaoRequest = { ...request(), origin: KO, destination: KD };
const slowTaxi = source('taxi', [
  leg('pickup', 'wait', KO, KO, 600),
  leg('taxi', 'taxi', KO, KD, 2_400, { costWon: 30_000 }),
]);
const subwayRide = (
  id: string,
  start: Place,
  end: Place,
  line: string,
  stops: string[],
  types: string[],
) => ride(id, start, end, line, stops, { transit: { lines: [line], stops, vehicleTypes: types } });
const modes = (result: ReturnType<typeof planJourneyGraph>) =>
  result.routes.map((route) =>
    route.segments
      .filter((part) => ['subway', 'bus', 'taxi'].includes(part.mode))
      .map((part) => `${part.mode}:${part.transit?.lines.join('/') ?? ''}`)
      .join('>'),
  );

test('a change of trains inside one provider itinerary stays, however the provider names the line and its classes', () => {
  // 1호선 개봉 → 구로 (경인선), change, 구로 → 가산디지털단지 (경부선): Kakao lists 일반 and 급행 on both steps.
  const wye = source('kakao-transit-0', [
    leg('w0', 'wait', KO, KO, 60),
    subwayRide('r1', KO, KA, '1호선', ['개봉', '구일', '구로'], ['일반', '급행']),
    leg('xfer', 'walk', KA, KA2, 120, { title: '구로 환승', runAllowed: false }),
    leg('w1', 'wait', KA2, KA2, 60),
    subwayRide('r2', KA2, KD, '1호선', ['구로', '가산디지털단지'], ['일반', '급행']),
  ]);
  const kept = planJourneyGraph(kakaoRequest, [wye, slowTaxi], { receivedAt: NOW });
  assert.deepEqual(
    modes(kept)[0],
    'subway:1호선>subway:1호선',
    "the provider's own 구로 change is the fastest route",
  );
  assert.equal(kept.diagnostics.sameRideReboards, 0);
  // 9호선: local to an express stop, the second stretch served by both classes.
  const nine = source('kakao-transit-0', [
    leg('w0', 'wait', KO, KO, 60),
    subwayRide('r1', KO, KA, '9호선', ['등촌', '염창'], ['일반']),
    leg('xfer', 'walk', KA, KA2, 60),
    leg('w1', 'wait', KA2, KA2, 60),
    subwayRide('r2', KA2, KD, '9호선', ['염창', '당산', '여의도'], ['일반', '급행']),
  ]);
  assert.equal(
    modes(planJourneyGraph(kakaoRequest, [nine, slowTaxi], { receivedAt: NOW }))[0],
    'subway:9호선>subway:9호선',
  );
  // The same two halves taken from two separate provider itineraries are one ride cut in two, and are refused.
  const halves = [
    source('kakao-transit-0', [
      leg('w0', 'wait', KO, KO, 60),
      subwayRide('r1', KO, KA, '1호선', ['개봉', '구일', '구로'], ['일반']),
    ]),
    source('kakao-transit-1', [
      leg('w1', 'wait', KA, KA, 60),
      subwayRide('r2', KA, KD, '1호선', ['구로', '가산디지털단지'], ['일반']),
    ]),
    slowTaxi,
  ];
  const split = planJourneyGraph(kakaoRequest, halves, { receivedAt: NOW });
  assert.deepEqual(
    modes(split),
    ['taxi:'],
    'two fragments of one line never compose into a fake change',
  );
  assert.ok(split.diagnostics.sameRideReboards > 0);
});

test('a provider change of trains survives when another itinerary shares its second ride and is listed first', () => {
  // compile() merges arcs with equal content. A bus itinerary that is quicker by the provider's wait-free total sorts
  // first and contributes the identical [wait + 1호선] arc from 구로; the merged arc still belongs to the 구로 change too.
  const KS = station2('bs', '버스정류장', 0, 200);
  const second = () => [
    leg('w1', 'wait', KA2, KA2, 60),
    subwayRide('r2', KA2, KD, '1호선', ['구로', '가산디지털단지'], ['일반', '급행']),
  ];
  const wye = source('kakao-transit-1', [
    leg('w0', 'wait', KO, KO, 60),
    subwayRide('r1', KO, KA, '1호선', ['개봉', '구일', '구로'], ['일반', '급행']),
    leg('xfer', 'walk', KA, KA2, 120),
    ...second(),
  ]);
  const bus = source('kakao-transit-0', [
    leg('wb', 'walk', KO, KS, 120),
    leg('w0b', 'wait', KS, KS, 60),
    ride(
      'b1',
      KS,
      KA2,
      '6513',
      ['버스정류장', '구로'],
      { durationSeconds: { min: 900, max: 900 } },
      'bus',
    ),
    ...second(),
  ]);
  for (const order of [
    [wye, bus, slowTaxi],
    [bus, wye, slowTaxi],
  ]) {
    const result = planJourneyGraph(kakaoRequest, order, { receivedAt: NOW, maxResults: 6 });
    assert.deepEqual(
      modes(result),
      ['subway:1호선>subway:1호선', 'bus:6513>subway:1호선', 'taxi:'],
      `listed ${order.map((item) => item.id).join(', ')}`,
    );
    assert.equal(result.routes[0].durationSeconds.max, 840);
    assert.equal(result.diagnostics.sameRideReboards, 0);
  }
  // A quicker walk of another itinerary between the provider's two trains keeps the provider's change: only a ride arc decides.
  const quickWalk = source('kakao-transit-2', [
    leg('wb', 'walk', KO, KS, 120),
    leg('w0b', 'wait', KS, KS, 60),
    ride(
      'b1',
      KS,
      KA,
      '6513',
      ['버스정류장', '구로'],
      { durationSeconds: { min: 900, max: 900 } },
      'bus',
    ),
    leg('xfer', 'walk', KA, KA2, 30),
    leg('w9', 'wait', KA2, KA2, 60),
    subwayRide('r9', KA2, KD, '2호선', ['구로', '가산디지털단지'], ['일반']),
  ]);
  const mixed = planJourneyGraph(kakaoRequest, [quickWalk, wye, slowTaxi], {
    receivedAt: NOW,
    maxResults: 6,
  });
  assert.deepEqual(modes(mixed)[0], 'subway:1호선>subway:1호선');
  assert.equal(mixed.routes[0].durationSeconds.max, 750, 'the 1호선 change uses the 30 s walk');
});

test('buses: the first-bus strategy across itineraries is a transfer, one route cut in two is not', () => {
  const bus = (id: string, start: Place, end: Place, lines: string[]) =>
    ride(
      id,
      start,
      end,
      lines.join(' / '),
      [start.name, end.name],
      { transit: { lines, stops: [start.name, end.name], vehicleTypes: ['간선'] } },
      'bus',
    );
  const composite = [
    source('k0', [leg('w0', 'wait', KO, KO, 60), bus('b1', KO, KA, ['143', '401'])]),
    source('k1', [leg('w1', 'wait', KA, KA, 60), bus('b2', KA, KD, ['401', '406'])]),
    slowTaxi,
  ];
  assert.equal(
    modes(planJourneyGraph(kakaoRequest, composite, { receivedAt: NOW }))[0],
    'bus:143/401>bus:401/406',
    '143/401 then 401/406 shares only 401, so the rider may change',
  );
  const cut = [
    source('k0', [leg('w0', 'wait', KO, KO, 60), bus('b1', KO, KA, ['401'])]),
    source('k1', [leg('w1', 'wait', KA, KA, 60), bus('b2', KA, KD, ['401'])]),
    slowTaxi,
  ];
  assert.deepEqual(modes(planJourneyGraph(kakaoRequest, cut, { receivedAt: NOW })), ['taxi:']);
  const within = source('k0', [
    leg('w0', 'wait', KO, KO, 60),
    bus('b1', KO, KA, ['401']),
    leg('xfer', 'walk', KA, KA2, 60),
    leg('w1', 'wait', KA2, KA2, 60),
    bus('b2', KA2, KD, ['401']),
  ]);
  assert.equal(
    modes(planJourneyGraph(kakaoRequest, [within, slowTaxi], { receivedAt: NOW }))[0],
    'bus:401>bus:401',
    'one provider itinerary decides its own changes',
  );
});

test('a single-line source ride is only split at interchange stations, and a split that fails opens no second wave', async () => {
  const stops = [
    '노원',
    '창동',
    '쌍문',
    '수유(강북구청)',
    '미아',
    '미아사거리',
    '길음',
    '성신여대입구(돈암)',
    '한성대입구(삼선교)',
    '혜화',
  ];
  const path = stops.map((name, index) => place(`p${index}`, name, index * 1_000));
  const line = source('provider-result-0', [
    ride('ride', path[0], path[9], '4호선', stops, {
      polyline: path,
      durationSeconds: { min: 1_500, max: 1_500 },
    }),
  ]);
  const keywords: string[] = [],
    transitQueries: string[] = [];
  const api: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    walking: async () => [],
    nearby: async (query) => {
      keywords.push(query.keyword);
      const hit = path.find((point) => query.keyword.startsWith(point.name.split('(')[0]));
      return hit
        ? [
            {
              ...hit,
              id: `st-${hit.id}`,
              name: query.keyword,
              category: '교통,수송 > 지하철,전철 > 수도권4호선',
              distanceMeters: 0,
            },
          ]
        : [];
    },
    transit: async (endpoints, budget) =>
      budget.run(() => {
        transitQueries.push(`${endpoints.origin.name}>${endpoints.destination.name}`);
        // Single-line trips: the provider answers both halves with the same 4호선.
        return [
          source('kakao', [
            leg('wait', 'wait', endpoints.origin, endpoints.origin, 30),
            ride('half', endpoints.origin, endpoints.destination, '4호선', [
              endpoints.origin.name,
              endpoints.destination.name,
            ]),
          ]),
        ];
      }),
  };
  const budget = new CallBudget();
  const discovered = await discoverIntermediateTransit(
    { origin: path[0], destination: path[9] },
    [line],
    {
      provider: api,
      budget,
      maxHubs: 2,
      now: NOW,
      connectTransit: (endpoints) => api.transit(endpoints, budget),
    },
  );
  assert.deepEqual(
    keywords,
    ['성신여대입구역 4호선', '창동역 4호선'],
    'only the two interchange stations of the ride are looked up',
  );
  assert.equal(transitQueries.length, 4);
  assert.equal(discovered.hubs.length, 0);
  assert.equal(
    discovered.diagnostics.stationLookups,
    2,
    'dropped same-line hubs do not open another wave',
  );
  assert.equal(discovered.diagnostics.sameLineSplits, 4);
  assert.equal(
    discovered.diagnostics.nonInterchangeSkipped,
    6,
    '6 of the 8 stations between the ends have no other line',
  );
  assert.equal(discovered.diagnostics.candidateStops, 2);
  assert.equal(budget.used, 4);
  assert.equal(
    discovered.diagnostics.candidateLimitSkipped,
    0,
    'every candidate was looked up before the search stopped',
  );
  assert.equal(discovered.diagnostics.limitReached, false);
  // A ride that already names two lines keeps every station as a candidate.
  const mixed = source('mixed', [
    ride('ride', path[0], path[9], '4호선 / 6호선', stops, { polyline: path }),
  ]);
  assert.equal(intermediateStationQueries([mixed], { maxHubs: 6, now: NOW }).length, 6);
});

test("without a stop list the ride's own end stations decide the branch", () => {
  const ring = ride('ring', O, { ...M, name: '성수' }, '2호선', []),
    shuttle = ride('shuttle', { ...M, name: '성수' }, { ...D, name: '용답' }, '2호선', []);
  assert.equal(continuesRide(ring, shuttle), false, '성수 to 용답 rides the 성수지선 shuttle');
  const trunk = ride('trunk', O, { ...M, name: '강동' }, '5호선', []);
  assert.equal(
    continuesRide(
      ride('machon', O, { ...M, name: '강동' }, '5호선', [], { start: { ...O, name: '마천' } }),
      ride('hanam', { ...M, name: '강동' }, { ...D, name: '하남검단산' }, '5호선', []),
    ),
    false,
  );
  assert.equal(
    continuesRide(
      trunk,
      ride('hanam', { ...M, name: '강동' }, { ...D, name: '하남검단산' }, '5호선', []),
    ),
    true,
  );
});

test('after a same-line split fails, a ride with more interchange stations opens no second wave', async () => {
  // 2호선 홍대입구 → 동대문역사문화공원 passes four interchange stations (신촌 is not one; 충정로, 시청, 을지로3가, 을지로4가 are).
  const stops = [
    '홍대입구',
    '신촌',
    '이대',
    '아현',
    '충정로',
    '시청',
    '을지로입구',
    '을지로3가',
    '을지로4가',
    '동대문역사문화공원',
  ];
  const path = stops.map((name, index) => place(`p${index}`, name, index * 1_000));
  const line = source('provider-result-0', [
    ride('ride', path[0], path[9], '2호선', stops, {
      polyline: path,
      durationSeconds: { min: 1_500, max: 1_500 },
    }),
  ]);
  let lookups = 0,
    routeCalls = 0;
  const api: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    walking: async () => [],
    nearby: async (query) => {
      lookups++;
      const hit = path.find((point) => query.keyword.startsWith(point.name))!;
      return [
        {
          ...hit,
          id: `st-${hit.id}`,
          name: `${hit.name}역 2호선`,
          category: '교통,수송 > 지하철,전철 > 수도권2호선',
          distanceMeters: 0,
        },
      ];
    },
    transit: async (endpoints, budget) =>
      budget.run(() => {
        routeCalls++;
        const name = (point: Place) => point.name.replace(/역.*$/, '');
        return [
          source('kakao', [
            leg('wait', 'wait', endpoints.origin, endpoints.origin, 30),
            ride('half', endpoints.origin, endpoints.destination, '2호선', [
              name(endpoints.origin),
              name(endpoints.destination),
            ]),
          ]),
        ];
      }),
  };
  const budget = new CallBudget();
  const discovered = await discoverIntermediateTransit(
    { origin: path[0], destination: path[9] },
    [line],
    {
      provider: api,
      budget,
      maxHubs: 2,
      now: NOW,
      connectTransit: (endpoints) => api.transit(endpoints, budget),
    },
  );
  assert.equal(discovered.diagnostics.candidateStops, 4);
  assert.equal(discovered.hubs.length, 0);
  assert.equal(lookups, 2, 'the first two interchange stations are looked up once');
  assert.equal(routeCalls, 4, 'their four subjourneys are the only route calls');
  assert.equal(
    discovered.diagnostics.candidateLimitSkipped,
    2,
    'the two interchange stations the stopped search never looked up are counted',
  );
  assert.equal(
    discovered.diagnostics.limitReached,
    true,
    'so the acquisition is not reported complete',
  );
});

test('label dominance keeps a label that alone may continue the ride: equal timing, a different set of provider itineraries', () => {
  // Two itineraries ride the same 1호선 to 구로; only kakao-transit-1 carries the provider's own change onward. Their wait legs differ
  // in a field that is no part of the label's evidence (expectedWaitBasisSeconds), so both arcs stay and both labels meet at 구로 with equal timing.
  const first = (id: string, basis: number) => [
    leg(`w0-${id}`, 'wait', KO, KO, 60, { expectedWaitBasisSeconds: basis }),
    subwayRide(`r1-${id}`, KO, KA, '1호선', ['개봉', '구일', '구로'], ['일반']),
  ];
  const onward = source('kakao-transit-1', [
    ...first('b', 60),
    leg('xfer', 'walk', KA, KA2, 120),
    leg('w1', 'wait', KA2, KA2, 60),
    subwayRide('r2', KA2, KD, '1호선', ['구로', '가산디지털단지'], ['일반']),
  ]);
  const alone = source('kakao-transit-0', first('a', 59));
  for (const order of [
    [alone, onward, slowTaxi],
    [onward, alone, slowTaxi],
  ]) {
    const result = planJourneyGraph(kakaoRequest, order, {
      receivedAt: NOW,
      maxResults: 6,
      distinctRides: false,
    });
    assert.ok(
      modes(result).includes('subway:1호선>subway:1호선'),
      `the provider change survives, listed ${order.map((item) => item.id).join(', ')}`,
    );
  }
});

test('a ride arc is judged against the previous ride only: sharing an itinerary with the first ride does not license a same-line continuation', () => {
  // kakao-transit-0 rides 1호선 then changes to 6호선 at 구로 (arc C). kakao-transit-1 supplies another 6호선 stretch B that ends where C begins.
  // B then C is one 6호선 ride cut in two; C shares an itinerary with the first ride A, but not with B, so it is refused.
  const KB = station2('b', '대림', 1_500, 15);
  const a = source('kakao-transit-0', [
    leg('w0', 'wait', KO, KO, 60),
    subwayRide('rA', KO, KB, '1호선', ['개봉', '구일', '대림'], ['일반']),
    leg('xfer', 'walk', KB, KA2, 60),
    leg('w2', 'wait', KA2, KA2, 60),
    subwayRide('rC', KA2, KD, '6호선', ['구로', '가산디지털단지'], ['일반']),
  ]);
  const b = source('kakao-transit-1', [
    leg('wb', 'wait', KB, KB, 30),
    subwayRide('rB', KB, KA2, '6호선', ['대림', '구로'], ['일반']),
  ]);
  for (const order of [
    [a, b, slowTaxi],
    [b, a, slowTaxi],
  ]) {
    const result = planJourneyGraph(kakaoRequest, order, {
      receivedAt: NOW,
      maxResults: 6,
      distinctRides: false,
    });
    assert.deepEqual(
      modes(result).filter((route) => route.startsWith('subway')),
      ['subway:1호선>subway:6호선'],
      `listed ${order.map((item) => item.id).join(', ')}`,
    );
    assert.ok(result.diagnostics.sameRideReboards > 0);
  }
});
