import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStationAccessTable,
  stationAccessKey,
  stationAccessPeriod,
  stationAccessSeconds,
} from '../src/common/engine/connectivity/station-access.js';
import {
  applyRailGateEnvelope,
  type RailGatePredictor,
} from '../src/common/engine/intelligence/rail-gate-service.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { stationBaseName } from '../src/common/engine/realtime/names.js';
import { taxiSplices } from '../src/common/engine/multimodal.js';
import { insertStationAccess } from '../src/common/engine/transit-enrichment.js';
import {
  DEFAULT_PREFERENCES,
  type BasePlanningRequest,
  type BaseRoute,
  type BaseSegment,
  type Place,
  type SubwayTimetable,
} from '../src/common/shared/domain/index.js';
import { scheduledDepartures } from '../src/common/shared/domain/subwayTimetable.js';

// Engine copy of mvp/tests/stationAccess.test.ts (the app-client cases live in the mvp suite).
const kst = (clock: string) => Date.parse(`2026-10-16T${clock}:00+09:00`);
const NOON = kst('12:00');
const place = (name: string, latitude: number, longitude = 126.97): Place => ({
  id: name,
  name,
  address: '',
  latitude,
  longitude,
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
  instructions: id,
  start,
  end,
  distanceMeters: start === end ? 0 : 300,
  runAllowed: false,
  durationSeconds: { min: seconds, max: seconds },
  ...(start === end ? {} : { polyline: [start, end] }),
  ...extra,
});
const ride = (
  id: string,
  start: Place,
  end: Place,
  seconds: number,
  line: string,
  stops: string[],
  extra: Partial<BaseSegment> = {},
) =>
  leg(id, 'subway', start, end, seconds, {
    lineName: line,
    transit: { lines: [line], stops },
    ...extra,
  });
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (sum, segment) => ({
      min: sum.min + segment.durationSeconds.min,
      max: sum.max + segment.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});
const modes = (segments: readonly { mode: string }[]) => segments.map((segment) => segment.mode);

test('the station table is keyed by the realtime names, scaled by the fitted period and clamped', () => {
  assert.equal(stationAccessKey('서울역', '수도권 1호선'), '서울|1001');
  assert.equal(stationAccessKey('숙대입구(갈월)', '4호선'), '숙대입구|1004');
  assert.equal(
    stationAccessKey('강남', '없는선'),
    null,
    'a line outside the realtime names has no key',
  );
  // Measured rows (seoul-station-access-v1): 서울|1001 entry 10 s exit 224 s, 종로3가|1005 exit 299 s.
  assert.deepEqual(stationAccessSeconds('서울역', '1호선', 'entry', NOON), {
    seconds: 10,
    source: 'measured',
  });
  assert.deepEqual(stationAccessSeconds('서울역', '1호선', 'exit', NOON), {
    seconds: 224,
    source: 'measured',
  });
  assert.deepEqual(stationAccessSeconds('종로3가', '5호선', 'exit', NOON), {
    seconds: 299,
    source: 'measured',
  });
  for (const [clock, period] of [
    ['06:59', 'base'],
    ['07:00', 'am-peak'],
    ['09:29', 'am-peak'],
    ['09:30', 'base'],
    ['17:30', 'pm-peak'],
    ['19:29', 'pm-peak'],
    ['19:30', 'base'],
    ['22:00', 'late'],
    ['05:59', 'late'],
    ['06:00', 'base'],
  ] as const) {
    assert.equal(stationAccessPeriod(kst(clock)), period, clock);
  }
  // Multiply, clamp, then round: 224 × 1.184 = 265.2 → 265; 10 × 0.749 = 7.49 → 7; 224 × 0.969 = 217.06 → 217.
  assert.equal(stationAccessSeconds('서울역', '1호선', 'exit', kst('18:00')).seconds, 265);
  assert.equal(stationAccessSeconds('서울역', '1호선', 'entry', kst('08:00')).seconds, 7);
  assert.equal(stationAccessSeconds('서울역', '1호선', 'exit', kst('23:30')).seconds, 217);
  // No row (another line, an unmeasured station, an unknown line): the network medians.
  for (const [stop, line] of [
    ['서울역', '공항철도'],
    ['없는역', '2호선'],
    ['서울역', '경춘선'],
  ]) {
    assert.deepEqual(stationAccessSeconds(stop, line, 'entry', NOON), {
      seconds: 12,
      source: 'default',
    });
    assert.deepEqual(stationAccessSeconds(stop, line, 'exit', NOON), {
      seconds: 160,
      source: 'default',
    });
  }
  assert.equal(
    stationAccessSeconds('없는역', '2호선', 'exit', kst('18:00')).seconds,
    189,
    '160 × 1.184',
  );
  const table = parseStationAccessTable(
    JSON.stringify({
      version: 'seoul-station-access-v1',
      periodMultipliers: {
        entry: { base: 1, 'am-peak': 1, 'pm-peak': 1, late: 1 },
        exit: { base: 1, 'am-peak': 1, 'pm-peak': 2, late: 1 },
      },
      default: { entrySeconds: 12, exitSeconds: 160 },
      clamps: { entrySeconds: [5, 240], exitSeconds: [60, 360] },
      stations: [
        { key: '가|1002', entrySeconds: 2, exitSeconds: 300 },
        { key: '나|1002', entrySeconds: 300, exitSeconds: 30 },
      ],
    }),
  );
  assert.ok(table);
  assert.equal(stationAccessSeconds('가', '2호선', 'entry', NOON, table).seconds, 5);
  assert.equal(
    stationAccessSeconds('가', '2호선', 'exit', kst('18:00'), table).seconds,
    360,
    '300 × 2 clamps to 360',
  );
  assert.equal(stationAccessSeconds('나', '2호선', 'entry', NOON, table).seconds, 240);
  assert.equal(stationAccessSeconds('나', '2호선', 'exit', NOON, table).seconds, 60);
});

test('a missing or malformed table never throws and falls back to the network default', () => {
  const valid = {
    version: 'seoul-station-access-v1',
    periodMultipliers: {
      entry: { base: 1, 'am-peak': 1, 'pm-peak': 1, late: 1 },
      exit: { base: 1, 'am-peak': 1, 'pm-peak': 1, late: 1 },
    },
    default: { entrySeconds: 12, exitSeconds: 160 },
    clamps: { entrySeconds: [5, 240], exitSeconds: [60, 360] },
    stations: [{ key: '가|1002', entrySeconds: 20, exitSeconds: 200 }],
  };
  assert.ok(parseStationAccessTable(JSON.stringify(valid)));
  for (const broken of [
    '{',
    '[]',
    'null',
    JSON.stringify({ ...valid, version: 'v0' }),
    JSON.stringify({ ...valid, stations: [] }),
    JSON.stringify({ ...valid, stations: [{ key: '가', entrySeconds: 20, exitSeconds: 200 }] }),
    JSON.stringify({
      ...valid,
      stations: [{ key: '가|1002', entrySeconds: 20.5, exitSeconds: 200 }],
    }),
    JSON.stringify({ ...valid, stations: [valid.stations[0], valid.stations[0]] }),
    JSON.stringify({ ...valid, clamps: { entrySeconds: [240, 5], exitSeconds: [60, 360] } }),
    JSON.stringify({ ...valid, periodMultipliers: { entry: valid.periodMultipliers.entry } }),
  ]) {
    assert.equal(parseStationAccessTable(broken), null, broken.slice(0, 60));
  }
  assert.deepEqual(stationAccessSeconds('서울역', '1호선', 'entry', NOON, null), {
    seconds: 12,
    source: 'default',
  });
  assert.deepEqual(
    stationAccessSeconds('서울역', '1호선', 'exit', kst('08:00'), null),
    { seconds: 156, source: 'default' },
    '160 × 0.974',
  );
});

const O = place('출발', 37.55),
  A = place('서울역', 37.555),
  B = place('종로3가', 37.57),
  B3 = place('종로3가', 37.5705),
  C = place('안국', 37.576),
  E = place('을지로3가', 37.566),
  D = place('도착', 37.58);
const line1 = (start = A, end = B) =>
  ride('line1', start, end, 400, '1호선', ['서울역', '시청', '종각', '종로3가']);
const line3 = (start = B3, end = C) => ride('line3', start, end, 120, '3호선', ['종로3가', '안국']);
const wait = (id: string, at: Place, seconds = 210) => leg(id, 'wait', at, at, seconds);

test('entry goes before the boarding waits of a run of trains and the exit after its last alighting', () => {
  const plain = insertStationAccess(
    [leg('access', 'walk', O, A, 200), wait('w0', A), line1(), leg('egress', 'walk', B, D, 150)],
    'r',
    NOON,
  );
  assert.deepEqual(modes(plain), ['walk', 'entry', 'wait', 'subway', 'entry', 'walk']);
  assert.deepEqual(
    plain.map((segment) => segment.id),
    ['access', 'r-entry-0', 'w0', 'line1', 'r-exit-0', 'egress'],
  );
  assert.ok(
    plain.every((segment) => !segment.id.endsWith('-expected-wait') || segment.mode === 'wait'),
    'no gate step can be mistaken for a replaceable wait',
  );
  assert.deepEqual(plain[1], {
    id: 'r-entry-0',
    mode: 'entry',
    title: '서울역 승강장까지',
    instructions: '개찰구를 지나 승강장까지 걷는 시간이에요.',
    distanceMeters: 0,
    durationSeconds: { min: 10, max: 10 },
    start: A,
    end: A,
    runAllowed: false,
  });
  assert.deepEqual(plain[4], {
    id: 'r-exit-0',
    mode: 'entry',
    title: '종로3가역 출구까지',
    instructions: '승강장에서 개찰구를 지나 역을 나가는 시간이에요.',
    distanceMeters: 0,
    durationSeconds: { min: 231, max: 231 },
    start: B,
    end: B,
    runAllowed: false,
  });

  // An in-station transfer (a transfer walk between two trains at one station, or straight onto the next train) passes no gates.
  const transfer = insertStationAccess(
    [
      leg('access', 'walk', O, A, 200),
      wait('w0', A),
      line1(),
      leg('transfer', 'walk', B, B3, 120),
      wait('w1', B3),
      line3(),
      leg('egress', 'walk', C, D, 150),
    ],
    'r',
    NOON,
  );
  assert.deepEqual(modes(transfer), [
    'walk',
    'entry',
    'wait',
    'subway',
    'walk',
    'wait',
    'subway',
    'entry',
    'walk',
  ]);
  assert.deepEqual(
    transfer
      .filter((segment) => segment.mode === 'entry')
      .map((segment) => [segment.id, segment.durationSeconds.min]),
    [
      ['r-entry-0', 10],
      ['r-exit-1', 142],
    ],
  );
  const through = insertStationAccess(
    [wait('w0', A), line1(), wait('w1', B), line3(B, C)],
    'r',
    NOON,
  );
  assert.deepEqual(modes(through), ['entry', 'wait', 'subway', 'wait', 'subway', 'entry']);

  // A street transfer between differently named stations exits and enters again.
  const street = insertStationAccess(
    [
      leg('access', 'walk', O, A, 200),
      wait('w0', A),
      ride('line1', A, E, 300, '1호선', ['서울역', '시청']),
      leg('street', 'walk', E, B3, 400),
      wait('w1', B3),
      line3(),
      leg('egress', 'walk', C, D, 150),
    ],
    'r',
    NOON,
  );
  assert.deepEqual(modes(street), [
    'walk',
    'entry',
    'wait',
    'subway',
    'entry',
    'walk',
    'entry',
    'wait',
    'subway',
    'entry',
    'walk',
  ]);
  assert.deepEqual(
    street.filter((segment) => segment.mode === 'entry').map((segment) => segment.id),
    ['r-entry-0', 'r-exit-0', 'r-entry-1', 'r-exit-1'],
  );
  assert.equal(
    stationBaseName(street[4].title.replace(/출구까지$/, '')),
    '시청',
    'the exit is named after the alighting station',
  );

  // The provider names a 4↔7 transfer differently on each line: 총신대입구(이수) on 4호선, 이수 on 7호선. One station, no gates.
  const I4 = place('총신대입구(이수)', 37.4865),
    I7 = place('이수', 37.4866),
    F = place('사당', 37.476),
    G = place('남성', 37.4847);
  const renamed = insertStationAccess(
    [
      leg('access', 'walk', O, F, 200),
      wait('w0', F),
      ride('line4', F, I4, 120, '4호선', ['사당', '총신대입구(이수)']),
      leg('transfer', 'walk', I4, I7, 90),
      wait('w1', I7),
      ride('line7', I7, G, 90, '7호선', ['이수', '남성']),
      leg('egress', 'walk', G, D, 150),
    ],
    'r',
    NOON,
  );
  assert.deepEqual(modes(renamed), [
    'walk',
    'entry',
    'wait',
    'subway',
    'walk',
    'wait',
    'subway',
    'entry',
    'walk',
  ]);

  // Buses pass no gates; a train reached from a bus still has its entry.
  const bus = leg('bus', 'bus', O, A, 300, {
    transit: { lines: ['402'], stops: ['출발', '서울역'] },
  });
  assert.deepEqual(modes(insertStationAccess([wait('w0', O), bus], 'r', NOON)), ['wait', 'bus']);
  assert.deepEqual(
    modes(
      insertStationAccess(
        [wait('w0', O), bus, wait('w1', A), line1(), leg('egress', 'walk', B, D, 150)],
        'r',
        NOON,
      ),
    ),
    ['wait', 'bus', 'entry', 'wait', 'subway', 'entry', 'walk'],
  );
  // A re-enriched itinerary keeps its timed gates once.
  assert.deepEqual(insertStationAccess(plain, 'r', NOON), plain);
});

test('the graph never boards a train without its entry or leaves one without its exit, even across sources', () => {
  const S = place('S', 37.56),
    S2 = place('S', 37.5602),
    R = place('R', 37.553),
    T = place('T', 37.57),
    V = place('V', 37.575);
  const request: BasePlanningRequest = {
    origin: O,
    destination: D,
    now: NOON,
    deadline: NOON + 7_200_000,
    preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
  };
  const gate = (id: string, at: Place, seconds: number) => leg(id, 'entry', at, at, seconds);
  const rideX = (id: string, from: Place, to: Place, seconds: number, line: string) =>
    ride(id, from, to, seconds, line, [from.name, to.name]);
  // P walks to S and passes a slow 100 s gate; Q reaches S's platform from another line and changes inside the station.
  const P = route('P', [
    leg('p-walk', 'walk', O, S, 60),
    gate('p-entry', S, 100),
    rideX('p-ride', S, T, 300, '2호선'),
    gate('p-exit', T, 50),
    leg('p-egress', 'walk', T, D, 60),
  ]);
  const Q = route('Q', [
    leg('q-walk', 'walk', O, R, 10),
    gate('q-entry', R, 5),
    rideX('q-ride', R, S2, 30, '1호선'),
    leg('q-transfer', 'walk', S2, S, 20),
    rideX('q-ride2', S, T, 300, '2호선'),
    gate('q-exit', T, 50),
    leg('q-egress', 'walk', T, D, 60),
  ]);
  // U changes inside T and finishes from V; a street walk from T must not skip U's way out of the station.
  const U = route('U', [
    leg('u-walk', 'walk', O, S, 60),
    gate('u-entry', S, 100),
    rideX('u-ride', S, T, 300, '2호선'),
    leg('u-transfer', 'walk', T, T, 0),
    rideX('u-ride2', T, V, 600, '3호선'),
    gate('u-exit', V, 50),
    leg('u-egress', 'walk', V, D, 60),
  ]);
  for (const objective of ['estimated-arrival', 'conservative-arrival'] as const)
    for (const searchMode of ['bounded', 'exact'] as const) {
      const graph = planJourneyGraph(request, [P, Q, U], {
        receivedAt: NOON,
        objective,
        searchMode,
        maxResults: 6,
        distinctRides: false,
      });
      assert.ok(graph.routes.length > 0);
      for (const candidate of graph.routes) {
        const physical = candidate.segments.filter((segment) => segment.mode !== 'wait');
        physical.forEach((segment, index) => {
          if (segment.mode !== 'subway') return;
          const before = physical[index - 1],
            after = physical[index + 1];
          const changesInside = (foot: BaseSegment | undefined, other: BaseSegment | undefined) =>
            foot?.mode === 'walk' && other?.mode === 'subway';
          assert.ok(
            before?.mode === 'entry' ||
              before?.mode === 'subway' ||
              changesInside(before, physical[index - 2]),
            `${candidate.title}: boards ${segment.id} through the gates`,
          );
          assert.ok(
            after?.mode === 'entry' ||
              after?.mode === 'subway' ||
              changesInside(after, physical[index + 2]),
            `${candidate.title}: leaves ${segment.id} through the gates`,
          );
        });
      }
      // P's walk to S joined to Q's in-station boarding would skip the gates (60 + 210 + 300 + 50 + 60 = 680 s); the join
      // passes S's timed entry instead, like any source that walks in from the street.
      assert.equal(
        graph.diagnostics.bestObjectiveSeconds,
        60 + stationAccessSeconds('S', '2호선', 'entry', NOON).seconds + 210 + 300 + 50 + 60,
        `${objective}/${searchMode}`,
      );
    }
});

test("a bridge leaving or joining a source at its in-station transfer passes that station's gates", () => {
  const request: BasePlanningRequest = {
    origin: O,
    destination: D,
    now: NOON,
    deadline: NOON + 7_200_000,
    preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
  };
  const options = {
    receivedAt: NOON,
    objective: 'estimated-arrival',
    searchMode: 'exact',
    maxResults: 4,
    distinctRides: false,
  } as const;
  const exitB = stationAccessSeconds('종로3가', '1호선', 'exit', NOON).seconds,
    entryB3 = stationAccessSeconds('종로3가', '3호선', 'entry', NOON).seconds;
  const exitC = stationAccessSeconds('안국', '3호선', 'exit', NOON).seconds,
    entryA = stationAccessSeconds('서울역', '1호선', 'entry', NOON).seconds;
  // 서울역 → 종로3가 (1호선), in-station change, 종로3가 → 안국 (3호선): 종로3가 is a paid-area transfer in this source.
  const source = (egress: number, ride1 = 400) =>
    route(
      'A',
      insertStationAccess(
        [
          leg('access', 'walk', O, A, 60),
          wait('w0', A, 60),
          { ...line1(), durationSeconds: { min: ride1, max: ride1 } },
          leg('transfer', 'walk', B, B3, 90),
          wait('w1', B3, 120),
          line3(),
          leg('egress', 'walk', C, D, egress),
        ],
        'a',
        NOON,
      ),
    );
  const best = (sources: BaseRoute[]) => planJourneyGraph(request, sources, options);

  // Last mile: a walk from the transfer station's street point leaves through 1호선's exit at 종로3가.
  const walkOut = route('walk-out', [leg('out', 'walk', B, D, 240)]);
  const out = best([source(900), walkOut]);
  assert.equal(out.diagnostics.bestObjectiveSeconds, 60 + entryA + 60 + 400 + exitB + 240);
  assert.deepEqual(modes(out.routes[0].segments), [
    'walk',
    'entry',
    'wait',
    'subway',
    'entry',
    'walk',
  ]);
  assert.equal(out.routes[0].segments[4].durationSeconds.max, exitB);

  // First mile: a walk to the transfer station's street point boards 3호선 through its entry, before the boarding wait.
  const walkIn = route('walk-in', [leg('in', 'walk', O, B3, 240)]);
  const into = best([source(60, 900), walkIn]);
  assert.equal(into.diagnostics.bestObjectiveSeconds, 240 + entryB3 + 120 + 120 + exitC + 60);
  assert.deepEqual(modes(into.routes[0].segments), [
    'walk',
    'entry',
    'wait',
    'subway',
    'entry',
    'walk',
  ]);

  // A taxi spliced at the transfer station (taxiSplices proposes intermediate alightings on purpose).
  const taxi = route('taxi', [
    leg('pickup', 'wait', B, B, 40),
    leg('taxi', 'taxi', B, D, 100, { costWon: 5000 }),
  ]);
  const ride = best([source(900), taxi]);
  // The objective is the arrival alone: the taxi after the train adds no ranking cost (D1).
  assert.equal(ride.diagnostics.bestObjectiveSeconds, 60 + entryA + 60 + 400 + exitB + 40 + 100);
  assert.deepEqual(modes(ride.routes[0].segments), [
    'walk',
    'entry',
    'wait',
    'subway',
    'entry',
    'wait',
    'taxi',
  ]);

  // The taxi splicer cuts a source after the exit of a run of trains, so the taxi starts on the street.
  const slow = insertStationAccess(
    [leg('access', 'walk', O, A, 200), wait('w0', A), line1(), leg('egress', 'walk', B, D, 1800)],
    's',
    NOON,
  );
  const last = taxiSplices([route('slow', slow)], { origin: O, destination: D }, NOON).find(
    (splice) => splice.kind === 'last',
  );
  assert.ok(last);
  assert.equal(last.cut, slow.findIndex((segment) => segment.id === 's-exit-0') + 1);

  // Access walk, entry+wait+1호선, transfer, wait+3호선+exit, egress; one walk out of 종로3가 adds itself and one exit.
  const alone = best([source(900)]);
  assert.equal(alone.diagnostics.edges, 5);
  assert.equal(out.diagnostics.edges, 7);
  assert.equal(
    alone.diagnostics.bestObjectiveSeconds,
    60 + entryA + 60 + 400 + 90 + 120 + 120 + exitC + 900,
  );
});

test('the rail-gate envelope spans entry to exit, so the gate-to-gate model never counts them twice', () => {
  const request = { now: NOON };
  const segments = [
    leg('access', 'walk', O, A, 200),
    leg('entry', 'entry', A, A, 10),
    wait('wait', A, 120),
    line1(),
    leg('exit', 'entry', B, B, 231),
    leg('egress', 'walk', B, D, 150),
  ];
  let seen: Parameters<RailGatePredictor>[0] | undefined;
  const predictor: RailGatePredictor = (input) => {
    seen = input;
    return {
      modelVersion: 'seoul-rail-gate-v1',
      target: 'rail-gate-elapsed',
      lowerSeconds: 500,
      medianSeconds: 700,
      upperSeconds: 900,
    };
  };
  const [enveloped] = applyRailGateEnvelope([route('r', segments)], request, predictor);
  assert.equal(seen?.startedAt, NOON + 200_000, 'the gate tap is where the entry starts');
  const subway = enveloped.segments.find((segment) => segment.mode === 'subway')!;
  assert.equal(subway.railEtaPrediction?.plannedSpanSeconds, 10 + 120 + 400 + 231);
  assert.equal(subway.durationSeconds.max, 400 + 900 - (10 + 120 + 400 + 231));
  assert.equal(enveloped.durationSeconds.max, route('r', segments).durationSeconds.max + 900 - 761);
  assert.deepEqual(
    applyRailGateEnvelope([route('r', segments)], request, () => ({
      modelVersion: 'seoul-rail-gate-v1',
      target: 'rail-gate-elapsed',
      lowerSeconds: 500,
      medianSeconds: 700,
      upperSeconds: 761,
    }))[0].segments,
    segments,
    'an upper bound that only covers entry, wait, ride and exit adds nothing',
  );
});

test('a published train is catchable when the rider reaches the platform by its departure', () => {
  const validFrom = kst('05:00');
  const timetable: SubwayTimetable = {
    provider: 'seoul-metro-timetable',
    serviceDate: '2026-10-16',
    dayType: 'weekday',
    receivedAt: NOON,
    validFrom,
    validUntil: validFrom + 86_400_000,
    calendarSource: 'fixture',
    line: '1호선',
    boardingStation: '서울역',
    nextStation: '시청',
    alightingStation: '종로3가',
    complete: true,
    departures: [210, 600].map((seconds, index) => ({
      departureAt: NOON + seconds * 1000,
      arrivalAt: NOON + (seconds + 400) * 1000,
      trainNo: `K${index}`,
      direction: '1',
      destination: '종로3가',
    })),
  };
  const train = { ...line1(), timetable };
  assert.equal(
    scheduledDepartures(train, { earliest: NOON + 210_000, latest: NOON + 210_000 }, NOON)
      ?.departure.earliest,
    NOON + 210_000,
    'the station entry already holds the gate-to-train time',
  );
  assert.equal(
    scheduledDepartures(train, { earliest: NOON + 210_001, latest: NOON + 210_001 }, NOON)
      ?.departure.earliest,
    NOON + 600_000,
  );
});
