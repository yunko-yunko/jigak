// Numbered subway exits: the street walk starts at the chosen exit's sidewalk point (CONTRACT-EXITS §2, §6 A1-A3, A8, A9).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { normalizeTransit, type RouteProvider } from '../src/common/engine/kakao.js';
import {
  bundledStationExits,
  chooseStationExit,
  exitPassage,
  MAX_EXIT_TABLES_PER_SEARCH,
  parseStationExits,
  resetStationExitChoices,
  stationExitsFor,
  type StationExitTable,
} from '../src/common/engine/connectivity/station-exits.js';
import { stationAccessSeconds } from '../src/common/engine/connectivity/station-access.js';
import { applyRailGateEnvelope } from '../src/common/engine/intelligence/rail-gate-service.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { walkingBridgePairs } from '../src/common/engine/mixed-mode-bridges.js';
import { groundedStationPoints } from '../src/common/engine/multimodal.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { enrichTransitRoutes } from '../src/common/engine/transit-enrichment.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';

/** Wednesday 2026-10-28 12:00 KST. */
const NOW = Date.UTC(2026, 9, 28, 3, 0);
const place = (name: string, latitude: number, longitude: number): Place => ({
  id: name,
  name,
  address: '서울',
  latitude,
  longitude,
});
/** Each exit's sidewalk point sits 4 m north of the exit (fixture only; the real table snaps to OSM footways). */
const exit = (ref: string | null, lat: number, lon: number) => [
  ref,
  lat,
  lon,
  +(lat + 0.000036).toFixed(6),
  lon,
  'o',
  null,
  null,
];
// OSM railway=subway_entrance points of 숙대입구 and 서울 (prototype subway-exits-v1).
const FIXTURE = JSON.stringify({
  version: 'subway-exits-v1',
  builtAt: '2026-11-01T21:00:00+09:00',
  sources: [{ name: 'fixture', licence: 'ODbL', count: 14 }],
  exitFields: ['ref', 'lat', 'lon', 'slat', 'slon', 'src', 'lift', 'alt'],
  stations: [
    {
      id: '0427',
      name: '숙대입구',
      lines: ['4호선'],
      lat: 37.54456,
      lon: 126.972106,
      exits: [
        exit('1', 37.545471, 126.97208),
        exit('2', 37.545265, 126.972296),
        exit('3', 37.544997, 126.972328),
        exit('4', 37.544729, 126.972271),
        exit('5', 37.544142, 126.972421),
        exit('6', 37.543797, 126.9725),
        exit('7', 37.543731, 126.972097),
        exit('8', 37.544057, 126.972032),
        exit('9', 37.544683, 126.971882),
        exit('10', 37.54537, 126.971703),
      ],
      area: null,
      areaKind: null,
    },
    {
      id: '0150',
      name: '서울',
      lines: ['1호선', '4호선'],
      lat: 37.554924,
      lon: 126.971597,
      exits: [exit('1', 37.555049, 126.9717), exit('12', 37.552511, 126.972734)],
      area: null,
      areaKind: null,
    },
    {
      id: '9999',
      name: '무번호',
      lines: ['9호선'],
      lat: 37.6,
      lon: 127.1,
      exits: [exit(null, 37.6003, 127.1002)],
      area: null,
      areaKind: null,
    },
  ],
});
const TABLE = parseStationExits(FIXTURE)!;
// Real Kakao platform points: 서울역 4호선 and 숙대입구 (mvp/data/sunrin-transit-raw-debug.json route 8).
const SEOUL: [number, number] = [126.97264, 37.55303];
const SOOKDAE: [number, number] = [126.97211813, 37.54459523];

function subwayPayload(stops: string[], points: [number, number][], line = '4호선', extra = []) {
  return {
    status: 'OK',
    routes: [
      {
        properties: extra.length
          ? { type: 'BUS_AND_SUBWAY', totalDistance: 5_000, totalTime: 1_200, transfers: 1 }
          : { type: 'SUBWAY', totalDistance: 1_500, totalTime: 400, transfers: 0 },
        steps: [
          {
            properties: {
              type: 'SUBWAY',
              guidance: `${line} (${stops[0]} > ${stops.at(-1)})`,
              distance: 1_000,
              time: 180,
              stops: stops.map((name) => ({ name })),
              vehicles: [{ name: line, type: '일반' }],
            },
            path: { points },
          },
          ...extra,
        ],
      },
    ],
  };
}

/** Network seconds = straight line × 1.3 / 1.2, plus `penalty` seconds from points the test names. */
function tableProvider(penalty: (point: Place) => number = () => 0) {
  const calls = { table: 0, walking: 0, transit: 0 };
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => {
      calls.transit++;
      throw new Error('Kakao transit is never called here');
    },
    walking: async () => {
      calls.walking++;
      throw new Error('no walking route in this fixture');
    },
    travelTable: async (_mode, sources, destinations) => {
      calls.table++;
      return {
        seconds: sources.map((source) =>
          destinations.map(
            (target) =>
              (metersBetween(source, target) * 1.3) / 1.2 + penalty(source) + penalty(target),
          ),
        ),
      };
    },
  };
  return { provider, calls };
}

async function enrich(
  payload: unknown,
  origin: Place,
  destination: Place,
  provider: RouteProvider,
  source: StationExitTable | null = TABLE,
  budget = new CallBudget(),
) {
  return enrichTransitRoutes(
    normalizeTransit(payload, { origin, destination }),
    { origin, destination },
    { provider, budget, now: NOW, maxAccessCalls: 0, stationExits: source },
  );
}
const modes = (route: BaseRoute) => route.segments.map((segment) => segment.mode);

test('the table parser keeps every exit and rejects a malformed file', () => {
  assert.equal(TABLE.stations.length, 3);
  assert.deepEqual(
    TABLE.stations[0].exits.map((value) => value.ref),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
  );
  assert.equal(TABLE.stations[0].exits[1].id, '0427-2-0');
  assert.equal(parseStationExits('{'), null);
  assert.equal(parseStationExits(FIXTURE.replace('"slat"', '"street"')), null);
  assert.equal(
    parseStationExits(FIXTURE.replace('"0150"', '"0427"')),
    null,
    'duplicate station id',
  );
  // The builder omits trailing null cells; a label that is not an exit number drops that exit only.
  const short = parseStationExits(
    FIXTURE.replace(
      '[null,37.6003,127.1002,37.600336,127.1002,"o",null,null]',
      '[null,37.6003,127.1002,37.600336,127.1002,"o"]',
    ).replace(
      '["12",37.552511,126.972734,37.552547,126.972734,"o",null,null]',
      '["서울역 12번출구",37.552511,126.972734,37.552547,126.972734,"o",1]',
    ),
  );
  assert.equal(short?.stations[2].exits.length, 1);
  assert.deepEqual(
    short?.stations[1].exits.map((value) => value.ref),
    ['1'],
  );
});

test('the bundled subway-exits-v1 table loads', () => {
  const table = bundledStationExits();
  assert.ok(table, 'connectivity/data/seoul-subway-exits-v1.json parses');
  assert.ok(table.stations.length >= 600);
  const sookdae = stationExitsFor(
    '숙대입구',
    { latitude: SOOKDAE[1], longitude: SOOKDAE[0] },
    table,
  );
  assert.ok(sookdae && sookdae.exits.length >= 10);
});

test('a stop matches its station by base name within 600 m of the train point', () => {
  const point = { latitude: SOOKDAE[1], longitude: SOOKDAE[0] };
  assert.equal(stationExitsFor('숙대입구(갈월)', point, TABLE)?.station.id, '0427');
  assert.equal(stationExitsFor('숙대입구역', point, TABLE)?.exits.length, 10);
  assert.equal(stationExitsFor('남영', point, TABLE), null, 'another name');
  assert.equal(
    stationExitsFor('숙대입구', { latitude: 37.56, longitude: 126.972 }, TABLE),
    null,
    'too far from the station',
  );
});

test('the passage estimate is 15 s of stairs plus the corridor beyond 30 m at 1.2 m/s with a 1.3 detour', () => {
  const train = { latitude: 37.5, longitude: 127 };
  assert.deepEqual(exitPassage(train, train), { seconds: 15, meters: 0 });
  const far = { latitude: 37.5009, longitude: 127 };
  const meters = metersBetween(train, far);
  assert.deepEqual(exitPassage(train, far), {
    meters: Math.round(meters),
    seconds: Math.round(15 + ((meters - 30) * 1.3) / 1.2),
  });
});

test('after alighting the walk starts at the chosen exit, which costs no more than any other exit (A1, A3, A4)', async () => {
  resetStationExitChoices();
  const { provider, calls } = tableProvider();
  const origin = place('서울로7017', 37.556, 126.969);
  // East of the station, closer to exits 3 and 4 than to the west exits 9 and 10.
  const destination = place('숙명여대', 37.5446, 126.9765);
  const [route] = await enrich(
    subwayPayload(['서울역', '숙대입구(갈월)'], [SEOUL, [126.9724, 37.549], SOOKDAE]),
    origin,
    destination,
    provider,
  );
  assert.deepEqual(modes(route), ['walk', 'entry', 'wait', 'subway', 'entry', 'walk']);
  const [access, entry, , ride, exitStep, egress] = route.segments;
  assert.ok(exitStep.stationExit, 'the exit step names its exit');
  const chosen = exitStep.stationExit!;
  assert.match(exitStep.title, /^숙대입구역 \d{1,2}번 출구로 나가기$/);
  assert.equal(exitStep.title, `숙대입구역 ${chosen.ref}번 출구로 나가기`);
  assert.equal(exitStep.instructions, `개찰구를 지나 ${chosen.ref}번 출구로 나가요.`);
  // A1: exit end = next walk start = the exit's sidewalk point, exactly.
  assert.deepEqual(
    [exitStep.end.latitude, exitStep.end.longitude],
    [chosen.street.latitude, chosen.street.longitude],
  );
  assert.ok(metersBetween(exitStep.end, egress.start) <= 0.5);
  assert.deepEqual(exitStep.start, ride.end, 'the step starts where the train stopped');
  assert.ok(metersBetween(egress.start, ride.end) > 5, 'never on the platform point');
  assert.equal(exitStep.polyline?.length, 3);
  assert.equal(egress.start.name, `숙대입구역 ${chosen.ref}번 출구`);
  // Platform seconds are the measured T-DATA value; the passage is assumed and widens only the slower bound.
  const platform = stationAccessSeconds('숙대입구', '4호선', 'exit', NOW);
  assert.equal(chosen.platformSeconds, platform.seconds);
  assert.equal(chosen.platformBasis, platform.source);
  assert.equal(chosen.passageBasis, 'assumed');
  assert.deepEqual(exitStep.durationSeconds, {
    min: platform.seconds + Math.round(chosen.passageSeconds * 0.8),
    max: platform.seconds + Math.round(chosen.passageSeconds * 1.4),
  });
  // A3: the same table ranks every exit; the chosen one is the cheapest.
  const train = { latitude: SOOKDAE[1], longitude: SOOKDAE[0] };
  const costs = TABLE.stations[0].exits.map((candidate) => ({
    ref: candidate.ref,
    cost:
      exitPassage(train, candidate).seconds +
      (metersBetween(candidate.street, destination) * 1.3) / 1.2,
  }));
  const best = Math.min(...costs.map((value) => value.cost));
  assert.equal(costs.find((value) => value.ref === chosen.ref)!.cost, best);
  // The boarding side picks an entrance at 서울역 the same way.
  assert.ok(entry.stationExit);
  assert.equal(entry.title, `서울역 ${entry.stationExit!.ref}번 출구로 들어가기`);
  assert.deepEqual(access.end, entry.start);
  assert.equal(access.title, `서울역 ${entry.stationExit!.ref}번 출구까지 걷기`);
  assert.deepEqual(entry.end, ride.start);
  // A8: one table per station end, no walking route call (maxAccessCalls 0), no Kakao.
  assert.deepEqual(calls, { table: 2, walking: 0, transit: 0 });
});

test('the chosen exit follows the destination around the station', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const train = { latitude: SOOKDAE[1], longitude: SOOKDAE[0] };
  const refs: (string | null)[] = [];
  for (const [lat, lon] of [
    [37.549, 126.9721],
    [37.54456, 126.9777],
    [37.5401, 126.9721],
    [37.54456, 126.9664],
  ]) {
    const choice = await chooseStationExit({
      stopName: '숙대입구',
      line: '4호선',
      trainPoint: train,
      target: { latitude: lat, longitude: lon },
      kind: 'exit',
      at: NOW,
      provider,
      budget: new CallBudget(),
      source: TABLE,
    });
    refs.push(choice!.exit.ref);
  }
  assert.equal(new Set(refs).size, 4, `north, east, south and west exits differ: ${refs}`);
});

test('a search spends at most six exit tables, then ranks by straight line (A8)', async () => {
  resetStationExitChoices();
  const { provider, calls } = tableProvider();
  const budget = new CallBudget();
  const train = { latitude: SOOKDAE[1], longitude: SOOKDAE[0] };
  const choices = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      chooseStationExit({
        stopName: '숙대입구',
        line: '4호선',
        trainPoint: train,
        target: { latitude: 37.55 - index * 0.001, longitude: 126.98 },
        kind: 'exit',
        at: NOW,
        provider,
        budget,
        source: TABLE,
      }),
    ),
  );
  assert.equal(calls.table, MAX_EXIT_TABLES_PER_SEARCH);
  assert.equal(choices.filter((choice) => choice?.walkSeconds === null).length, 4);
  // The same station end and target inside one search shares one lookup.
  const again = await chooseStationExit({
    stopName: '숙대입구',
    line: '4호선',
    trainPoint: train,
    target: { latitude: 37.55, longitude: 126.98 },
    kind: 'exit',
    at: NOW,
    provider,
    budget,
    source: TABLE,
  });
  assert.equal(again?.exit.id, choices[0]?.exit.id);
  assert.equal(calls.table, MAX_EXIT_TABLES_PER_SEARCH);
});

test('a failing table still picks an exit by straight line', async () => {
  resetStationExitChoices();
  const provider: Pick<RouteProvider, 'travelTable'> = {
    travelTable: async () => {
      throw new Error('osrm down');
    },
  };
  const choice = await chooseStationExit({
    stopName: '숙대입구',
    line: '4호선',
    trainPoint: { latitude: SOOKDAE[1], longitude: SOOKDAE[0] },
    target: { latitude: 37.5401, longitude: 126.9721 },
    kind: 'exit',
    at: NOW,
    provider,
    budget: new CallBudget(),
    source: TABLE,
  });
  assert.equal(choice?.walkSeconds, null);
  const train = { latitude: SOOKDAE[1], longitude: SOOKDAE[0] },
    target = { latitude: 37.5401, longitude: 126.9721 };
  const straight = TABLE.stations[0].exits
    .map((candidate) => ({
      ref: candidate.ref,
      cost:
        exitPassage(train, candidate).seconds +
        (metersBetween(candidate.street, target) * 1.25) / 1.2,
    }))
    .sort((a, b) => a.cost - b.cost);
  assert.equal(choice!.exit.ref, straight[0].ref);
});

test('a table that never answers is dropped after 1.5 s and the exit is ranked by straight line', async () => {
  resetStationExitChoices();
  const provider: Pick<RouteProvider, 'travelTable'> = { travelTable: () => new Promise(() => {}) };
  const started = Date.now();
  const choice = await chooseStationExit({
    stopName: '숙대입구',
    line: '4호선',
    trainPoint: { latitude: SOOKDAE[1], longitude: SOOKDAE[0] },
    target: { latitude: 37.5401, longitude: 126.9721 },
    kind: 'exit',
    at: NOW,
    provider,
    budget: new CallBudget(),
    source: TABLE,
  });
  assert.ok(choice?.exit.ref, 'an exit is still chosen');
  assert.equal(choice.walkSeconds, null);
  assert.ok(Date.now() - started < 2_500, 'the search waits at most the table timeout');
});

test('a station without exit data keeps today’s response; a station without numbers walks from its sidewalk point (A9)', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const origin = place('출발', 37.556, 126.969),
    destination = place('도착', 37.4791, 126.986);
  // 사당 is not in the fixture table: identical to the feature switched off.
  const payload = subwayPayload(['서울역', '사당'], [SEOUL, [126.98, 37.5], [126.98163, 37.47653]]);
  const withTable = await enrich(payload, origin, destination, provider);
  const without = await enrich(payload, origin, destination, provider, null);
  assert.deepEqual(withTable[0].segments.slice(3), without[0].segments.slice(3));
  assert.equal(withTable[0].segments[4].title, '사당역 출구까지');
  assert.equal(withTable[0].segments[4].distanceMeters, 0);
  // 무번호 has one sidewalk point and no number: the walk starts there, the title stays as it is today.
  const near = place('근처', 37.603, 127.104);
  const [route] = await enrich(
    subwayPayload(['서울역', '무번호'], [SEOUL, [127.05, 37.58], [127.1001, 37.6001]], '9호선'),
    origin,
    near,
    provider,
  );
  const exitStep = route.segments[4],
    walk = route.segments[5];
  assert.equal(exitStep.title, '무번호역 출구까지');
  assert.equal(exitStep.stationExit?.ref, null);
  assert.deepEqual(exitStep.end, walk.start);
  assert.ok(metersBetween(walk.start, { latitude: 37.6001, longitude: 127.1001 }) > 20);
});

test('a transfer walk to a bus is routed again from the exit', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const origin = place('출발', 37.556, 126.969),
    destination = place('도착', 37.53, 126.99);
  const busStop: [number, number] = [126.9728, 37.5452];
  const payload = subwayPayload(
    ['서울역', '숙대입구'],
    [SEOUL, [126.9724, 37.549], SOOKDAE],
    '4호선',
    [
      {
        properties: { type: 'WALKING', guidance: '정류장까지', distance: 90, time: 80 },
        path: { points: [SOOKDAE, busStop] },
      },
      {
        properties: {
          type: 'BUS',
          guidance: '400',
          distance: 3_000,
          time: 600,
          stops: [{ name: '숙대입구' }, { name: '도착' }],
          vehicles: [{ name: '400', type: '간선' }],
        },
        path: { points: [busStop, [126.99, 37.53]] },
      },
    ] as never,
  );
  const [route] = await enrich(payload, origin, destination, provider);
  const index = route.segments.findIndex((segment) => segment.stationExit?.kind === 'exit');
  const exitStep = route.segments[index],
    transfer = route.segments[index + 1];
  assert.equal(transfer.mode, 'walk');
  assert.deepEqual(transfer.start, exitStep.end);
  assert.deepEqual(
    [transfer.end.latitude, transfer.end.longitude],
    [busStop[1], busStop[0]],
    'the walk still reaches the bus stop',
  );
});

test('the journey graph keeps the walk on the exit and grounds the sidewalk point (A1)', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const origin = place('서울로7017', 37.556, 126.969),
    destination = place('숙명여대', 37.5446, 126.9765);
  const sources = await enrich(
    subwayPayload(['서울역', '숙대입구'], [SEOUL, [126.9724, 37.549], SOOKDAE]),
    origin,
    destination,
    provider,
  );
  const request = {
    origin,
    destination,
    now: NOW,
    deadline: NOW + 2 * 3_600_000,
    preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
  };
  const graph = planJourneyGraph(request, sources, {
    receivedAt: NOW,
    maxResults: 2,
    objective: 'estimated-arrival',
  });
  assert.ok(graph.routes.length, 'the exit step and its walk still connect');
  const segments = graph.routes[0].segments;
  const exitIndex = segments.findIndex((segment) => segment.stationExit?.kind === 'exit');
  assert.ok(exitIndex > 0);
  assert.deepEqual(segments[exitIndex + 1].start, segments[exitIndex].end);
  const grounded = groundedStationPoints(sources, NOW);
  assert.ok(
    grounded.every(
      (point) => metersBetween(point, { latitude: SOOKDAE[1], longitude: SOOKDAE[0] }) > 1,
    ),
    'the platform point is never offered as a street point',
  );
});

test('the rail gate span leaves out the assumed street passage at both ends', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const origin = place('서울로7017', 37.556, 126.969),
    destination = place('숙명여대', 37.5446, 126.9765);
  const [route] = await enrich(
    subwayPayload(['서울역', '숙대입구'], [SEOUL, [126.9724, 37.549], SOOKDAE]),
    origin,
    destination,
    provider,
  );
  const spanOf = (segments: readonly BaseSegment[]) => {
    const [checked] = applyRailGateEnvelope(
      [{ ...route, segments: [...segments] }],
      { now: NOW },
      () => ({
        modelVersion: 'seoul-rail-gate-v1',
        target: 'rail-gate-elapsed',
        lowerSeconds: 1,
        medianSeconds: 2,
        upperSeconds: 86_000,
      }),
    );
    return checked.segments.find((segment) => segment.railEtaPrediction)!.railEtaPrediction!
      .plannedSpanSeconds;
  };
  const withExits = spanOf(route.segments);
  const entry = route.segments[1],
    exitStep = route.segments[4];
  const passage =
    entry.durationSeconds.max -
    entry.stationExit!.platformSeconds +
    exitStep.durationSeconds.max -
    exitStep.stationExit!.platformSeconds;
  const bare = route.segments.map((segment) => {
    if (!segment.stationExit) return segment;
    const { stationExit, ...rest } = segment;
    return {
      ...rest,
      durationSeconds: {
        min: stationExit.platformSeconds,
        max: stationExit.platformSeconds,
      },
    };
  });
  assert.ok(passage > 0);
  assert.equal(withExits, spanOf(bare));
});

test('a chosen exit and entrance still give the change-over anchors between two journeys (R1)', async () => {
  resetStationExitChoices();
  const { provider } = tableProvider();
  const origin = place('서울로7017', 37.556, 126.969),
    destination = place('숙명여대', 37.5446, 126.9765);
  const payload = subwayPayload(['서울역', '숙대입구'], [SEOUL, [126.9724, 37.549], SOOKDAE]);
  const first = (await enrich(payload, origin, destination, provider))[0];
  const second = (await enrich(payload, origin, destination, provider))[0];
  const kinds = first.segments.flatMap((segment) =>
    segment.stationExit ? [segment.stationExit.kind] : [],
  );
  assert.deepEqual(kinds, ['entrance', 'exit'], 'both ends carry a chosen exit');
  const entrance = first.segments.find((segment) => segment.stationExit?.kind === 'entrance')!,
    exitStep = first.segments.find((segment) => segment.stationExit?.kind === 'exit')!;
  // The sidewalk ends are the verified street points, as groundedStationPoints returns them after a grounded walk.
  const grounded = [entrance.start, exitStep.end];
  const request = {
    origin,
    destination,
    now: NOW,
    deadline: NOW + 2 * 3_600_000,
    preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
  };
  const { pairs } = walkingBridgePairs(request, [first, second], NOW, 'estimated-arrival', {
    limit: 50,
    minTransferMeters: 5,
    grounded,
  });
  const change = pairs.filter((pair) => pair.crossTransfer);
  assert.ok(change.length > 0, 'the alighting exit links to the other journey boarding entrance');
  assert.ok(
    change.every(
      (pair) =>
        grounded.some((point) => metersBetween(point, pair.from) < 1) &&
        grounded.some((point) => metersBetween(point, pair.to) < 1),
    ),
    'every change-over starts and ends on a sidewalk point, never behind the gates',
  );
});
