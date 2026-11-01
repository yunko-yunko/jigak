// Engine and shared-timing cases from mvp/tests/headwayServiceDay.test.ts (the urgency and app-client cases live there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import {
  busHeadwayEvidence,
  busLineModel,
  timetableHeadwayEvidence,
} from '../src/common/engine/realtime/headway-evidence.js';
import { SeoulTimetableService } from '../src/common/engine/realtime/subwayTimetable.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import { nextUnlistedDeparture } from '../src/common/shared/domain/liveBoarding.js';
import { publishedServiceEnded } from '../src/common/shared/domain/subwayTimetable.js';
import {
  evidenceHeadway,
  expectedWaitSeconds,
  headwayEndedTail,
  headwayServiceEnded,
} from '../src/common/shared/domain/waitEstimates.js';
import {
  DEFAULT_PREFERENCES,
  planBaseRoutes,
  type BaseRoute,
  type BaseSegment,
  type HeadwayEvidence,
  type Place,
  type Provenance,
  type SubwayTimetable,
} from '../src/common/shared/domain/index.js';

const MINUTE = 60_000,
  DAY = 86_400_000;
const at = (date: string, clock: string) => Date.parse(`${date}T${clock}:00+09:00`);
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const vehicle = (
  mode: 'bus' | 'subway',
  lines: string[],
  headwayEvidence?: HeadwayEvidence | null,
  stops = ['승차', '다음', '하차'],
): BaseSegment => ({
  id: `${mode}-ride`,
  mode,
  title: lines.join(' / '),
  instructions: '',
  distanceMeters: 3_000,
  durationSeconds: { min: 600, max: 600 },
  start: place('승차', 37.55, 126.97),
  end: place('하차', 37.56, 126.98),
  runAllowed: false,
  transit: { lines, stops },
  ...(headwayEvidence ? { headwayEvidence } : {}),
});
const windowAt = (evidence: HeadwayEvidence, clock: number) =>
  evidence.windows.find((window) => clock >= window.from && clock < window.to);

// ---- (1) Name rules read the operating day, not the calendar date. ----
// 2026-11-06 is a Friday, 11-07 a Saturday, 11-08 a Sunday and 11-09 a Monday (reviewed calendar).
test('a (평일) line runs after midnight on a Friday night and not after midnight on a Sunday night', () => {
  const friday = at('2026-11-06', '23:30'),
    sunday = at('2026-11-08', '23:30');
  const afterFriday = busLineModel('1900(평일)', undefined, friday),
    afterSunday = busLineModel('1900(평일)', undefined, sunday);
  // Saturday 00:10 belongs to Friday's operating day: no hours are known from the name, so the line is unclassified.
  assert.equal(afterFriday.state(at('2026-11-07', '00:10')).kind, 'unknown');
  assert.equal(afterFriday.state(at('2026-11-07', '03:59')).kind, 'unknown');
  // Saturday's own day starts at 04:00: a weekday line does not run.
  assert.equal(afterFriday.state(at('2026-11-07', '04:00')).kind, 'not-running');
  // Monday 00:10 still belongs to Sunday: no weekday bus, until Monday's day starts at 04:00.
  assert.equal(afterSunday.state(at('2026-11-09', '00:10')).kind, 'not-running');
  assert.equal(afterSunday.state(at('2026-11-09', '03:59')).kind, 'not-running');
  assert.equal(afterSunday.state(at('2026-11-09', '04:00')).kind, 'unknown');
  assert.ok(
    afterSunday.edges(sunday, sunday + 6 * 3_600_000).includes(at('2026-11-09', '04:00')),
    'the day change is a window edge',
  );

  const fridayEvidence = busHeadwayEvidence(['1900(평일)'], null, friday)!;
  assert.equal(
    windowAt(fridayEvidence, at('2026-11-07', '00:30'))!.waitSeconds,
    480,
    'the late rule for the one line',
  );
  assert.equal(windowAt(fridayEvidence, at('2026-11-07', '04:30'))!.waitSeconds, null);
  assert.equal(
    expectedWaitSeconds(vehicle('bus', ['1900(평일)'], fridayEvidence), at('2026-11-07', '00:30')),
    480,
  );
  assert.equal(
    headwayServiceEnded(vehicle('bus', ['1900(평일)'], fridayEvidence), at('2026-11-07', '00:30')),
    false,
  );

  const sundayEvidence = busHeadwayEvidence(['1900(평일)'], null, sunday)!;
  assert.deepEqual(
    sundayEvidence.windows.map((window) => [window.from, window.waitSeconds]),
    [
      [sunday, null],
      [at('2026-11-09', '04:00'), 480],
    ],
  );
  // No rule bus at 00:38: the rider at 00:30 waits for Monday's service.
  assert.equal(
    expectedWaitSeconds(vehicle('bus', ['1900(평일)'], sundayEvidence), at('2026-11-09', '00:30')),
    (3 * 60 + 30) * 60 + 480,
  );
});

test("a night line's operating day runs to 05:00 and a 새벽A line's day starts at 03:30", () => {
  // Hypothetical day restrictions on night and dawn lines exercise the boundary of each kind of line.
  const night = busLineModel('N99(평일)', undefined, at('2026-11-06', '23:30'));
  assert.equal(
    night.state(at('2026-11-07', '04:30')).kind,
    'unknown',
    'Friday night service at 04:30 Saturday',
  );
  assert.equal(
    night.state(at('2026-11-07', '23:30')).kind,
    'not-running',
    'Saturday night is not a weekday night',
  );
  const dawn = busLineModel('새벽A99(평일)', undefined, at('2026-11-09', '03:00'));
  assert.equal(
    dawn.state(at('2026-11-09', '03:40')).kind,
    'unknown',
    "Monday 03:40 is Monday's first service",
  );
  assert.equal(
    busLineModel('새벽A99(평일)', undefined, at('2026-11-08', '03:00')).state(
      at('2026-11-08', '03:40'),
    ).kind,
    'not-running',
  );
  // (주말) lines mirror (평일): Saturday 00:30 is still Friday.
  assert.equal(
    busLineModel('9000(주말)', undefined, at('2026-11-06', '23:30')).state(
      at('2026-11-07', '00:30'),
    ).kind,
    'not-running',
  );
  assert.equal(
    busLineModel('9000(주말)', undefined, at('2026-11-08', '23:30')).state(
      at('2026-11-09', '00:30'),
    ).kind,
    'unknown',
  );
});

// ---- (2) A finished sheet without published first and last departures. ----
test('an ended sheet without first and last departures holds for one band in the day, then the line is unknown', () => {
  const sheet = new Map([['A1', { routeId: 'x', ended: true, termMinutes: 10 }]]);
  for (const now of [at('2026-11-02', '04:20'), at('2026-11-02', '13:00')]) {
    const line = busLineModel('A1', sheet.get('A1'), now);
    assert.equal(line.state(now).kind, 'not-running');
    assert.equal(line.state(now + 30 * MINUTE - 1).kind, 'not-running');
    assert.equal(
      line.state(now + 30 * MINUTE).kind,
      'unknown',
      'not ended: nothing is known after the report',
    );
    assert.ok(line.edges(now, now + 3_600_000).includes(now + 30 * MINUTE));
    const evidence = busHeadwayEvidence(['A1'], sheet, now)!;
    const bus = vehicle('bus', ['A1'], evidence);
    assert.equal(
      headwayEndedTail(bus),
      null,
      'no ended tail: the horizon is not six hours of nothing',
    );
    assert.equal(headwayServiceEnded(bus, now + 5 * MINUTE), false);
    assert.equal(
      windowAt(evidence, now + 30 * MINUTE)!.waitSeconds !== null,
      true,
      'the rule for the unclassified line',
    );
    assert.equal(
      expectedWaitSeconds(bus, now + 10 * MINUTE),
      20 * 60 + windowAt(evidence, now + 30 * MINUTE)!.waitSeconds!,
    );
  }
  // Late in the evening and overnight a finished day line stays finished until the next service day.
  for (const now of [
    at('2026-11-02', '22:10'),
    at('2026-11-03', '01:00'),
    at('2026-11-03', '03:50'),
  ]) {
    const line = busLineModel('A1', sheet.get('A1'), now);
    assert.equal(line.state(at('2026-11-03', '03:59')).kind, 'not-running');
    assert.equal(line.state(at('2026-11-03', '04:00')).kind, 'unknown');
  }
});

// ---- (3) Subway: past the last train, and before 05:00, the rider waits for the next day's first train. ----
const LAST_DAY = '2026-11-05',
  FIRST_DAY = '2026-11-06';
const ownDay = (): number[] => {
  const departures: number[] = [];
  for (let clock = at(LAST_DAY, '05:32'); clock <= at(FIRST_DAY, '00:48'); clock += 6 * MINUTE)
    departures.push(clock);
  return departures;
};
const nextDay = (): number[] =>
  Array.from({ length: 120 }, (_, index) => at(FIRST_DAY, '05:31') + index * 6 * MINUTE);

test("subway evidence past the last train waits for the next service day's first train", () => {
  const now = at(FIRST_DAY, '04:40'),
    validFrom = at(LAST_DAY, '05:00'),
    validUntil = validFrom + DAY;
  const evidence = timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now, undefined, {
    departures: nextDay(),
    validUntil: validUntil + DAY,
  })!;
  assert.equal(evidence.windows[0].from, at(FIRST_DAY, '04:30'));
  assert.equal(evidence.windows[0].waitSeconds, null);
  assert.equal(
    evidence.windows[0].to,
    at(FIRST_DAY, '05:31'),
    'idle across the table rollover, up to the first train',
  );
  const first = evidence.windows[1];
  assert.equal(first.from, at(FIRST_DAY, '05:31'));
  assert.ok(first.waitSeconds! > 0 && first.waitSeconds! <= 200, 'six-minute spacing');
  assert.equal(evidence.windows.at(-1)!.to, now + 6 * 3_600_000, 'on to the horizon');
  const subway = vehicle('subway', ['2호선'], evidence);
  assert.equal(headwayEndedTail(subway), null);
  assert.equal(headwayServiceEnded(subway, at(FIRST_DAY, '04:50')), false);
  assert.deepEqual(evidenceHeadway(subway, at(FIRST_DAY, '04:50')), {
    waitSeconds: 41 * 60 + first.waitSeconds!,
    headwaySeconds: 41 * 60 + first.headwaySeconds!,
  });
  // Same piece of the next day without the following day: the old 'ended' tail, the route would be dropped.
  const alone = timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now)!;
  assert.deepEqual(headwayEndedTail(vehicle('subway', ['2호선'], alone)), {
    from: at(FIRST_DAY, '04:30'),
    to: validUntil,
  });
  // After the last train (00:44) the wait runs to 05:31 too.
  const late = timetableHeadwayEvidence(
    ownDay(),
    validFrom,
    validUntil,
    at(FIRST_DAY, '00:20'),
    undefined,
    { departures: nextDay(), validUntil: validUntil + DAY },
  )!;
  const gap = late.windows.find((window) => window.waitSeconds === null)!;
  assert.deepEqual([gap.from, gap.to], [at(FIRST_DAY, '00:44'), at(FIRST_DAY, '05:31')]);
  // A following day that does not follow (or is empty) changes nothing.
  assert.deepEqual(
    timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now, undefined, {
      departures: [],
      validUntil: validUntil + DAY,
    }),
    alone,
  );
  assert.deepEqual(
    timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now, undefined, {
      departures: nextDay(),
      validUntil,
    }),
    alone,
  );
});

const subwayTable = (receivedAt: number): SubwayTimetable => ({
  provider: 'seoul-metro-timetable',
  serviceDate: LAST_DAY,
  dayType: 'weekday',
  calendarSource: 'fixture',
  receivedAt,
  validFrom: at(LAST_DAY, '05:00'),
  validUntil: at(FIRST_DAY, '05:00'),
  line: '2호선',
  boardingStation: '승차',
  nextStation: '다음',
  alightingStation: '하차',
  complete: true,
  departures: ownDay().map((departureAt, index) => ({
    departureAt,
    arrivalAt: departureAt + 600_000,
    trainNo: `T${index}`,
    direction: '1',
    destination: '하차',
  })),
});

test("a complete table whose own day has ended leaves the boarding to the next day's first trains in the evidence", () => {
  const now = at(FIRST_DAY, '04:40'),
    validFrom = at(LAST_DAY, '05:00'),
    validUntil = validFrom + DAY;
  const evidence = timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now, undefined, {
    departures: nextDay(),
    validUntil: validUntil + DAY,
  })!;
  const withTable = { ...vehicle('subway', ['2호선'], evidence), timetable: subwayTable(now) };
  const reach = { earliest: at(FIRST_DAY, '04:45'), latest: at(FIRST_DAY, '04:50') };
  assert.equal(publishedServiceEnded(withTable, reach, now), false);
  const next = nextUnlistedDeparture(withTable, undefined, reach.earliest, now)!;
  assert.equal(next.basis, 'wait-rule');
  assert.ok(
    next.departureAt >= at(FIRST_DAY, '05:31') && next.departureAt <= at(FIRST_DAY, '05:35'),
  );
  // The same table with the own-day evidence alone has ended, as before.
  const alone = {
    ...withTable,
    headwayEvidence: timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now)!,
  };
  assert.equal(publishedServiceEnded(alone, reach, now), true);
  assert.equal(nextUnlistedDeparture(alone, undefined, reach.earliest, now), null);
  // During the table's own day the published train still binds.
  assert.equal(
    publishedServiceEnded(
      withTable,
      { earliest: at(FIRST_DAY, '00:30'), latest: at(FIRST_DAY, '00:30') },
      now,
    ),
    false,
  );
  assert.equal(
    nextUnlistedDeparture(withTable, undefined, at(FIRST_DAY, '00:30'), now)!.basis,
    'published-departure',
  );
});

// The station tables a fake Seoul feed serves for 2호선 승차 (0201) → 다음 (0202) → 하차 (0203).
function subwayFeed(firstTrain: Record<string, string>) {
  const requests: string[] = [];
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
  const fetcher = (async (url: URL | RequestInfo) => {
    const parts = new URL(String(url)).pathname.split('/').map(decodeURIComponent),
      service = parts[3];
    const master = [
      { STATION_CD: '0201', STATION_NM: '승차', LINE_NUM: '02호선' },
      { STATION_CD: '0202', STATION_NM: '다음', LINE_NUM: '02호선' },
      { STATION_CD: '0203', STATION_NM: '하차', LINE_NUM: '02호선' },
    ];
    let rows: Record<string, string>[] = master;
    if (service !== 'SearchSTNBySubwayLineInfo') {
      const [code, tag, direction] = parts.slice(6, 9),
        delta = code === '0201' ? 0 : code === '0202' ? 2 : 10;
      requests.push(`${code}:${tag}:${direction}`);
      const [hours, minutes] = firstTrain[tag].split(':').map(Number);
      rows = Array.from({ length: 200 }, (_, index) => hours * 60 + minutes + index * 6)
        .filter((minute) => minute <= 24 * 60 + 48)
        .map((minute, index) => {
          const time = clock((minute + delta) % (24 * 60));
          return {
            STATION_CD: code,
            STATION_NM: code,
            LINE_NUM: '02호선',
            TRAIN_NO: `${tag}${direction}${index}`,
            ARRIVETIME: time,
            LEFTTIME: time,
            WEEK_TAG: tag,
            INOUT_TAG: direction,
            ORIGINSTATION: '0200',
            DESTSTATION: '0203',
            SUBWAYENAME: '하차',
            EXPRESS_YN: 'G',
            BRANCH_LINE: '',
          };
        });
    }
    return new Response(
      JSON.stringify({
        [service]: { RESULT: { CODE: 'INFO-000' }, list_total_count: rows.length, row: rows },
      }),
    );
  }) as typeof fetch;
  return { fetcher, requests };
}
const subwaySource = (): BaseRoute => {
  const origin = place('출발', 37.549, 126.97),
    stop = place('승차', 37.55, 126.97),
    destination = place('도착', 37.56, 126.98);
  const segments: BaseSegment[] = [
    {
      id: 's-access',
      mode: 'walk',
      title: '걷기',
      instructions: '',
      distanceMeters: 300,
      durationSeconds: { min: 300, max: 300 },
      start: origin,
      end: stop,
      runAllowed: false,
      polyline: [origin, stop],
    },
    {
      id: 's-wait-0-expected-wait',
      mode: 'wait',
      title: '승차 대기',
      instructions: '',
      distanceMeters: 0,
      durationSeconds: { min: 300, max: 300 },
      expectedWaitBasisSeconds: 300,
      start: stop,
      end: stop,
      runAllowed: false,
    },
    {
      ...vehicle('subway', ['2호선']),
      start: stop,
      end: destination,
      lineName: '2호선',
      polyline: [stop, destination],
    },
  ];
  return {
    id: 'subway',
    title: '2호선',
    segments,
    transfers: 0,
    distanceMeters: 3_300,
    durationSeconds: { min: 1_200, max: 1_200 },
  };
};

test("the timetable service adds the next day's first trains to a night search, sharing a same-type table and paying for another", async () => {
  // Friday 04:40 is Thursday's service day: the next day is a weekday too, so its tables are the ones already read.
  const thursday = at(FIRST_DAY, '04:40'),
    weekday = subwayFeed({ 1: '05:31', 2: '05:40' });
  const service = new SeoulTimetableService({
    key: 'test',
    now: () => thursday,
    fetcher: weekday.fetcher,
  });
  const [enriched] = await service.enrich([subwaySource()], thursday);
  const ride = enriched.segments[2];
  assert.equal(ride.timetable?.serviceDate, LAST_DAY);
  assert.equal(
    weekday.requests.length,
    6,
    "the ride's three stations both ways; nothing more for the next day",
  );
  assert.equal(ride.headwayEvidence?.windows[0].waitSeconds, null);
  assert.equal(ride.headwayEvidence?.windows[1].from, at(FIRST_DAY, '05:31'));
  assert.equal(headwayEndedTail(ride), null);
  assert.equal(
    publishedServiceEnded(
      ride,
      { earliest: at(FIRST_DAY, '04:45'), latest: at(FIRST_DAY, '04:45') },
      thursday,
    ),
    false,
  );

  // Saturday 04:40 is Friday's service day; Saturday's first trains need Saturday's tables (tag 2), read after
  // every own-day table.
  const saturday = at('2026-11-07', '04:40'),
    weekend = subwayFeed({ 1: '05:31', 2: '05:40' });
  const later = new SeoulTimetableService({
    key: 'test',
    now: () => saturday,
    fetcher: weekend.fetcher,
  });
  const [weekendRide] = (await later.enrich([subwaySource()], saturday))[0].segments.slice(2);
  assert.deepEqual(weekend.requests.slice(6).sort(), [
    '0201:2:1',
    '0201:2:2',
    '0202:2:1',
    '0202:2:2',
  ]);
  assert.equal(weekendRide.headwayEvidence?.windows[1].from, at('2026-11-07', '05:40'));
  // Without the queries for it, the evidence ends with the service day as before.
  const poor = subwayFeed({ 1: '05:31', 2: '05:40' });
  const tight = new SeoulTimetableService({
    key: 'test',
    now: () => saturday,
    fetcher: poor.fetcher,
    maxQueries: 7,
  });
  const [tightRide] = (await tight.enrich([subwaySource()], saturday))[0].segments.slice(2);
  assert.equal(poor.requests.length, 6);
  assert.deepEqual(headwayEndedTail(tightRide), {
    from: at('2026-11-07', '04:30'),
    to: at('2026-11-07', '05:00'),
  });
});

// ---- The planner keeps both night cases (the app-client re-validation of the same routes lives in mvp). ----
const provenanceAt = (now: number): Provenance => ({
  mode: 'live',
  provider: 'kakao',
  label: '카카오 경로',
  sourceTimestamp: null,
  receivedAt: now,
  isRealtime: false,
});
function plan(now: number, sources: BaseRoute[]) {
  const origin = sources[0].segments[0].start,
    destination = sources[0].segments.at(-1)!.end;
  const request = {
    origin,
    destination,
    now,
    deadline: now + 8 * 3_600_000,
    preferences: { ...DEFAULT_PREFERENCES, preparationSeconds: 0 },
  };
  const graph = planJourneyGraph(request, sources, {
    receivedAt: now,
    maxResults: 4,
    objective: 'estimated-arrival',
  });
  return planBaseRoutes(request, graph.routes, provenanceAt(now), {
    maxRoutes: 4,
    objective: 'estimated-arrival',
  });
}

test('a Friday 23:30 search keeps a (평일) bus that boards at 00:30, with the late rule wait', () => {
  const origin = place('출발', 37.53, 126.97),
    stop = place('승차', 37.55, 126.97),
    destination = place('도착', 37.56, 126.98);
  const source = (now: number): BaseRoute => ({
    id: 'bus',
    title: '1900',
    transfers: 0,
    distanceMeters: 7_000,
    durationSeconds: { min: 4_680, max: 4_680 },
    segments: [
      {
        id: 'b-access',
        mode: 'walk',
        title: '걷기',
        instructions: '',
        distanceMeters: 4_000,
        durationSeconds: { min: 3_600, max: 3_600 },
        start: origin,
        end: stop,
        runAllowed: false,
        polyline: [origin, stop],
      },
      {
        id: 'b-wait-0-expected-wait',
        mode: 'wait',
        title: '승차 대기',
        instructions: '',
        distanceMeters: 0,
        durationSeconds: { min: 480, max: 480 },
        expectedWaitBasisSeconds: 480,
        start: stop,
        end: stop,
        runAllowed: false,
      },
      {
        ...vehicle('bus', ['1900(평일)'], busHeadwayEvidence(['1900(평일)'], null, now)),
        start: stop,
        end: destination,
        polyline: [stop, destination],
      },
    ],
  });
  const friday = at('2026-11-06', '23:30');
  const route = plan(friday, [source(friday)]).routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'bus'),
  )!;
  assert.ok(route);
  assert.equal(route.segments.find((segment) => segment.mode === 'wait')!.durationSeconds.min, 480);
  assert.equal(
    estimateBaseTimeline(route.segments, friday)!.arrivalAt,
    friday + (3_600 + 480 + 600) * 1000,
  );
  const sunday = at('2026-11-08', '23:30');
  assert.equal(
    estimateBaseTimeline(source(sunday).segments, sunday)!.arrivalAt,
    at('2026-11-09', '04:08') + 600_000,
  );
  assert.equal(
    plan(sunday, [source(sunday)]).routes.some((value) =>
      value.segments.some((segment) => segment.mode === 'bus'),
    ),
    false,
  );
});

test('a 04:40 subway boarding waits for the first train instead of being dropped', () => {
  const now = at(FIRST_DAY, '04:40'),
    validFrom = at(LAST_DAY, '05:00'),
    validUntil = validFrom + DAY;
  const withEvidence = (headwayEvidence: HeadwayEvidence): BaseRoute => {
    const source = subwaySource();
    source.segments[2] = { ...source.segments[2], headwayEvidence, timetable: subwayTable(now) };
    return source;
  };
  const evidence = timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now, undefined, {
    departures: nextDay(),
    validUntil: validUntil + DAY,
  })!;
  const route = plan(now, [withEvidence(evidence)]).routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'subway'),
  )!;
  assert.ok(route);
  const wait = route.segments.find((segment) => segment.mode === 'wait')!;
  assert.equal(
    wait.durationSeconds.min,
    expectedWaitSeconds(
      route.segments.find((segment) => segment.mode === 'subway')!,
      at(FIRST_DAY, '04:45'),
    ),
  );
  assert.ok(
    estimateBaseTimeline(route.segments, now)!.arrivalAt >= at(FIRST_DAY, '05:31') + 600_000,
  );
  const alone = plan(now, [
    withEvidence(timetableHeadwayEvidence(ownDay(), validFrom, validUntil, now)!),
  ]);
  assert.equal(
    alone.routes.some((value) => value.segments.some((segment) => segment.mode === 'subway')),
    false,
  );
});
