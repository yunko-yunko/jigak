// 11-02 daytime findings: a timetabled train counts its shortest published ride in the remaining-time bound (F1, 강남역→광화문역
// ran out of expansions with no route), a vehicle use that walking beats is refused on both ends of a journey (F2, loops past
// the origin or the destination), and a station end with no chosen exit still passes the nearest numbered exit (F3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStationExits, exitPassage } from '../src/common/engine/connectivity/station-exits.js';
import { stationAccessSeconds } from '../src/common/engine/connectivity/station-access.js';
import {
  planJourneyGraph,
  WALK_DOMINANCE_SLACK_SECONDS,
} from '../src/common/engine/journey-graph.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  insertStationAccess,
  stationAccessStep,
  stationGateStep,
} from '../src/common/engine/transit-enrichment.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type {
  BaseRoute,
  BaseSegment,
  Place,
  SubwayTimetable,
} from '../src/common/shared/domain/types.js';

const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 중구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
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
const source = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((n, s) => n + s.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (n, s) => ({ min: n.min + s.durationSeconds.min, max: n.max + s.durationSeconds.max }),
    { min: 0, max: 0 },
  ),
});
const modes = (route: BaseRoute) => route.segments.map((segment) => segment.mode);

// F1 ------------------------------------------------------------------------------------------------------------------
const serviceDate = '2026-10-13',
  validFrom = Date.parse(`${serviceDate}T05:00:00+09:00`),
  TABLE_NOW = validFrom + 3_600_000;
/** Trains every 5 minutes taking 15 minutes, and one express taking 700 s. */
function timetable(): SubwayTimetable {
  const departures: SubwayTimetable['departures'] = [];
  for (let index = 0; index < 60; index++) {
    const at = validFrom + 3_600_000 + index * 300_000;
    departures.push({
      departureAt: at,
      arrivalAt: at + (index === 7 ? 700_000 : 900_000),
      trainNo: `T${index}`,
      direction: '1',
      destination: '도착',
    });
  }
  return {
    provider: 'seoul-metro-timetable',
    serviceDate,
    dayType: 'weekday',
    receivedAt: TABLE_NOW,
    validFrom,
    validUntil: validFrom + 86_400_000,
    calendarSource: 'fixture',
    line: '2호선',
    boardingStation: '역',
    nextStation: '다음',
    alightingStation: '도착',
    complete: true,
    departures,
  };
}

test('a timetabled train counts its shortest published ride, not nothing, in the remaining-time bound', () => {
  const O = point('출발', 0),
    S = point('역', 100),
    D = point('도착', 9000);
  const train = leg('train', 'subway', S, D, 1200, {
    transit: { lines: ['2호선'], stops: ['역', '다음', '도착'] },
    timetable: timetable(),
  });
  const sources = [
    source('walk', [leg('walk', 'walk', O, S, 100)]),
    source('train', [leg('train-wait', 'wait', S, S, 150), train]),
  ];
  const request = {
    origin: O,
    destination: D,
    now: TABLE_NOW,
    deadline: TABLE_NOW + 7_200_000,
    preferences: DEFAULT_PREFERENCES,
  };
  // Stopped after the first expansion, the bound left on the queue is the walk plus the express ride (700 s); the provider's
  // 1,200 s and the 900 s rows are larger, and before 11-02 the train counted 0 s, so the bound was the walk alone.
  const cut = planJourneyGraph(request, sources, { receivedAt: TABLE_NOW, maxExpansions: 1 });
  assert.equal(cut.diagnostics.termination, 'expansion-limit');
  assert.equal(cut.diagnostics.unexploredLowerBoundSeconds, 100 + 700);
  // Still admissible: the journey the full search finds takes at least that long.
  const full = planJourneyGraph(request, sources, { receivedAt: TABLE_NOW });
  assert.equal(full.routes.length, 1);
  assert.equal(full.diagnostics.optimalityProven, true);
  assert.ok(full.diagnostics.bestObjectiveSeconds! >= 100 + 700);
  assert.ok(full.routes[0].durationSeconds.max >= 100 + 700);
});

// F2 ------------------------------------------------------------------------------------------------------------------
const NOW = Date.parse('2026-10-12T05:00:00Z');
const lease = (id: string, start: Place, end: Place, rideSeconds: number) =>
  source(id, [
    leg(`${id}-hire`, 'hire', start, start, 30, {
      rentalValidity: {
        verifiedAt: NOW,
        validUntil: NOW + 3_600_000,
        vehicleId: id,
        provider: 'test-operator',
      },
    }),
    leg(`${id}-ride`, 'bicycle', start, end, rideSeconds, { routingProfile: 'bicycle' }),
    leg(`${id}-return`, 'return', end, end, 30),
  ]);
const plan = (
  origin: Place,
  destination: Place,
  sources: BaseRoute[],
  options: Record<string, unknown> = {},
) =>
  planJourneyGraph(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW + 7_200_000,
      preferences: {
        ...DEFAULT_PREFERENCES,
        allowBicycle: true,
        bicycleReady: true,
        maxBicycleMeters: 5000,
      },
    },
    sources,
    { receivedAt: NOW, maxResults: 6, ...options },
  );

test('the constant is the assumed minute of walking-estimate drift', () => {
  assert.equal(WALK_DOMINANCE_SLACK_SECONDS, 60);
});

test('a bike ridden away from the start and walked back to the station is no bicycle route (잠실역→강남역)', () => {
  // 출발 is beside 역; the dock 가 lies the other way, 나 further on, and the walk back from 나 to 역 is long.
  const O = point('출발', 0),
    S = point('역', 100),
    A = point('가', -300),
    B = point('나', -900),
    D = point('도착', 6000);
  const sources = [
    source('to-station', [leg('to-station', 'walk', O, S, 90)]),
    source('to-dock', [leg('to-dock', 'walk', O, A, 240)]),
    lease('loop', A, B, 200),
    source('back', [leg('back', 'walk', B, S, 800)]),
    source('train', [leg('train-wait', 'wait', S, S, 60), leg('train', 'subway', S, D, 600)]),
  ];
  const priced = plan(O, D, sources, { requiredMode: 'bicycle', maxResults: 1 });
  assert.equal(priced.routes.length, 0);
  assert.ok(priced.diagnostics.walkableDetours > 0);
  const main = plan(O, D, sources);
  assert.deepEqual(modes(main.routes[0]), ['walk', 'wait', 'subway']);
  assert.equal(
    main.routes.some((route) => modes(route).includes('bicycle')),
    false,
  );
  // The plain fastest-arrival search (audits) still has the loop: the rule is the ranking, not the data.
  const plain = plan(O, D, sources, {
    requiredMode: 'bicycle',
    maxResults: 1,
    rankingCosts: false,
  });
  assert.deepEqual(
    modes(plain.routes[0]).filter((mode) => mode !== 'wait'),
    ['walk', 'hire', 'bicycle', 'return', 'walk', 'subway'],
  );
  assert.equal(plain.diagnostics.walkableDetours, 0);
});

test('alighting near the end, walking on and riding back is no bicycle route (2호선 → 따릉이 at 강남역)', () => {
  // The train stops at 역 beside 도착; 가 and 나 lie beyond it, and the bike rides back from 나 to 도착.
  const O = point('출발', 0),
    S = point('역', 6000),
    A = point('가', 6800),
    B = point('나', 6300),
    D = point('도착', 6100);
  const sources = [
    source('train', [
      leg('to-station', 'walk', O, point('승강장', 50), 60),
      leg('train-wait', 'wait', point('승강장', 50), point('승강장', 50), 60),
      leg('train', 'subway', point('승강장', 50), S, 600),
    ]),
    source('home', [leg('home', 'walk', S, D, 90)]),
    source('away', [leg('away', 'walk', S, A, 600)]),
    lease('back', A, B, 150),
    source('last', [leg('last', 'walk', B, D, 150)]),
  ];
  const priced = plan(O, D, sources, { requiredMode: 'bicycle', maxResults: 1 });
  assert.equal(priced.routes.length, 0);
  assert.ok(priced.diagnostics.walkableDetours > 0);
  // The walk home is never refused: it is the route.
  const main = plan(O, D, sources);
  assert.deepEqual(modes(main.routes[0]), ['walk', 'wait', 'subway', 'walk']);
  assert.equal(
    main.routes.some((route) => modes(route).includes('bicycle')),
    false,
  );
  const plain = plan(O, D, sources, {
    requiredMode: 'bicycle',
    maxResults: 1,
    rankingCosts: false,
  });
  assert.equal(modes(plain.routes[0]).includes('bicycle'), true);
});

test('a bike that beats walking on from the station is kept, and so is a slow last ride with nothing after it', () => {
  const O = point('출발', 0),
    S = point('역', 6000),
    D = point('도착', 7500);
  const platform = point('승강장', 50);
  const train = source('train', [
    leg('to-station', 'walk', O, platform, 60),
    leg('train-wait', 'wait', platform, platform, 60),
    leg('train', 'subway', platform, S, 600),
  ]);
  // Walking the last 1.5 km takes 1,200 s; the bike from the station takes 30 + 300 + 30 s.
  const sources = [
    train,
    source('home', [leg('home', 'walk', S, D, 1200)]),
    lease('bike', S, D, 300),
  ];
  const tab = plan(O, D, sources, { requiredMode: 'bicycle', maxResults: 1 });
  assert.deepEqual(
    modes(tab.routes[0]).filter((mode) => mode !== 'wait'),
    ['walk', 'subway', 'hire', 'bicycle', 'return'],
  );
  // A bus that is slower than walking its whole way but ends the journey is not a detour: its tab still shows it. (Over
  // SHORT_HOP_METERS, so the short-ride rule does not apply either.)
  const E = point('끝', 1500);
  const slowBus = plan(
    O,
    E,
    [
      source('walk-all', [leg('walk-all', 'walk', O, E, 1250)]),
      source('bus', [leg('bus-wait', 'wait', O, O, 900), leg('bus', 'bus', O, E, 600)]),
    ],
    { requiredMode: 'bus', maxResults: 1 },
  );
  assert.deepEqual(modes(slowBus.routes[0]), ['wait', 'bus']);
});

// F3 ------------------------------------------------------------------------------------------------------------------
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
const TABLE = parseStationExits(
  JSON.stringify({
    version: 'subway-exits-v1',
    builtAt: '2026-11-01T21:00:00+09:00',
    sources: [{ name: 'fixture', licence: 'ODbL', count: 4 }],
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
          exit('4', 37.544729, 126.972271),
          exit('8', 37.544057, 126.972032),
          exit('10', 37.54537, 126.971703),
        ],
        area: null,
        areaKind: null,
      },
    ],
  }),
)!;
const station = (name: string, latitude: number, longitude: number): Place => ({
  id: name,
  name,
  address: '서울',
  latitude,
  longitude,
});
const SEOUL = station('서울역', 37.55303, 126.97264),
  SOOKDAE = station('숙대입구', 37.54459523, 126.97211813);
const ride = (): BaseSegment => ({
  ...leg('ride', 'subway', SEOUL, SOOKDAE, 180),
  transit: { lines: ['4호선'], stops: ['서울역', '숙대입구'] },
});

test('a station end at the station point passes the nearest numbered exit, with its passage and street walk', () => {
  const now = Date.UTC(2026, 9, 28, 3, 0);
  const step = stationGateStep(ride(), 'exit', 'gate', now, TABLE);
  const nearest = TABLE.stations[0].exits
    .map((candidate) => ({
      candidate,
      seconds:
        exitPassage(SOOKDAE, candidate).seconds +
        (metersBetween(candidate.street, SOOKDAE) * 1.25) / 1.2,
    }))
    .sort((a, b) => a.seconds - b.seconds)[0].candidate;
  assert.equal(step.mode, 'entry');
  assert.equal(step.title, `숙대입구역 ${nearest.ref}번 출구로 나가기`);
  assert.equal(step.stationExit?.ref, nearest.ref);
  // It stays on the station point, where the connection that follows starts.
  assert.deepEqual(step.start, SOOKDAE);
  assert.deepEqual(step.end, SOOKDAE);
  const platform = stationAccessSeconds('숙대입구', '4호선', 'exit', now).seconds,
    passage = exitPassage(SOOKDAE, nearest),
    streetMeters = Math.round(metersBetween(nearest.street, SOOKDAE) * 1.25),
    streetSeconds = Math.ceil(streetMeters / 1.2);
  assert.deepEqual(step.durationSeconds, {
    min: platform + Math.round(passage.seconds * 0.8) + streetSeconds,
    max: platform + Math.round(passage.seconds * 1.4) + streetSeconds,
  });
  assert.equal(
    step.distanceMeters,
    passage.meters + Math.round(metersBetween(nearest, nearest.street)) + streetMeters,
  );
  // Longer than the unnamed platform step it replaces (대림역 출구까지 0 m, platform seconds only).
  const plain = stationAccessStep(ride(), 'exit', 'gate', now);
  assert.ok(step.durationSeconds.min > plain.durationSeconds.min);
  // No exit data: the plain platform step, unchanged.
  assert.deepEqual(stationGateStep(ride(), 'exit', 'gate', now, null), plain);
});

test('a hub fragment that ends at the station point gets a named exit when the table is given', () => {
  const now = Date.UTC(2026, 9, 28, 3, 0);
  const segments = [leg('wait', 'wait', SEOUL, SEOUL, 120), ride()];
  const named = insertStationAccess(segments, 'hub', now, () => undefined, TABLE);
  const exitStep = named.at(-1)!;
  assert.match(exitStep.title, /^숙대입구역 \d+번 출구로 나가기$/);
  assert.deepEqual(exitStep.end, SOOKDAE);
  // Without the table argument the old unnamed step stays (other callers and tests).
  const plain = insertStationAccess(segments, 'hub', now, () => undefined);
  assert.equal(plain.at(-1)!.title, '숙대입구역 출구까지');
  // Exits turned off (a null table) keep the unnamed step too.
  assert.equal(
    insertStationAccess(segments, 'hub', now, () => null, null).at(-1)!.title,
    '숙대입구역 출구까지',
  );
});
