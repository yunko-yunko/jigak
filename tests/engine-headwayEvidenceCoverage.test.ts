// Engine and shared-timing cases from mvp/tests/headwayEvidenceCoverage.test.ts (the app-client, urgency and current-ranking
// case lives there) plus the timetable budget case from mvp/tests/subwayTimetable.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { sheetMinute } from '../src/common/engine/realtime/bus.js';
import {
  busHeadwayEvidence,
  busLineModel,
  mergedPeriodicWait,
  mergeLineWindows,
  timetableHeadwayEvidence,
} from '../src/common/engine/realtime/headway-evidence.js';
import {
  RealtimeService,
  type BoardingQuery,
  type RealtimeService as RealtimeServiceType,
} from '../src/common/engine/realtime/service.js';
import { SeoulTimetableService } from '../src/common/engine/realtime/subwayTimetable.js';
import {
  enrichTransitRoutes,
  selectRealtimeQueries,
} from '../src/common/engine/transit-enrichment.js';
import {
  dynamicWaitDurationRange,
  estimateBaseTimeline,
  estimatedSegmentSeconds,
  waitServiceEndsAt,
} from '../src/common/shared/domain/estimatedTiming.js';
import { headwayEndedTail } from '../src/common/shared/domain/waitEstimates.js';
import type {
  BaseRoute,
  BaseSegment,
  HeadwayEvidence,
  Place,
} from '../src/common/shared/domain/index.js';

const MINUTE = 60_000,
  KST = 9 * 3_600_000,
  DAY = 86_400_000;
/** Wednesday 2026-10-28 08:47:40 KST: a reviewed weekday. */
const NOW = Date.UTC(2026, 9, 27, 23, 47, 40);
const kst = (hours: number, minutes = 0) => Date.UTC(2026, 9, 28, hours, minutes) - KST;
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const evidence = (windows: HeadwayEvidence['windows']): HeadwayEvidence => ({
  version: 1,
  basis: 'tdata-dispatch',
  derivedAt: NOW,
  windows,
});
const vehicle = (
  mode: 'bus' | 'subway',
  lines: string[],
  headwayEvidence?: HeadwayEvidence,
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
  transit: { lines, stops: ['승차', '다음', '하차'] },
  ...(headwayEvidence ? { headwayEvidence } : {}),
});
const expectedWait = (seconds: number): BaseSegment => ({
  id: 'x-wait-0-expected-wait',
  mode: 'wait',
  title: '승차 대기',
  instructions: '',
  distanceMeters: 0,
  runAllowed: false,
  start: place('승차', 37.55, 126.97),
  end: place('승차', 37.55, 126.97),
  durationSeconds: { min: seconds, max: seconds },
  expectedWaitBasisSeconds: seconds,
});

// ---- Realtime cap: the mode-coverage replacement never evicts a candidate's first boarding. ----
const query = (mode: 'bus' | 'subway', stop: number, line: string): BoardingQuery => ({
  mode,
  stop: `stop-${stop}`,
  lines: [line],
  nextStops: ['next'],
  latitude: 37.55,
  longitude: 126.97 + stop / 1000,
});
const keyOf = (value: BoardingQuery) => `${value.mode}:${value.stop}:${value.lines[0]}`;

test('mode coverage replaces the most recently opened stop without a first boarding, never a first boarding', () => {
  // Route A boards at stop-0. Route B rides stop-1..16 then returns through stop-0 on another line, then a bus.
  const first = query('subway', 0, '1호선'),
    b = Array.from({ length: 16 }, (_, index) => query('subway', index + 1, '2호선'));
  const hub = query('subway', 0, '5호선'),
    bus = query('bus', 17, '100');
  const available = new Map(
    [first, b[0], ...b.slice(1), hub, bus].map((value) => [keyOf(value), value]),
  );
  const selected = [
    ...selectRealtimeQueries(available, new Set([keyOf(first), keyOf(b[0])]), 16).keys(),
  ];
  assert.ok(selected.includes('subway:stop-0:1호선'), 'route A keeps its live lookup');
  assert.ok(selected.includes('subway:stop-0:5호선'), 'the hub revisit shares the stop-0 sheet');
  assert.ok(selected.includes('bus:stop-17:100'), 'the missing mode is observed');
  assert.ok(
    !selected.includes('subway:stop-16:2호선'),
    'the most recently opened transfer stop gives way',
  );
  assert.equal(new Set(selected.map((key) => key.split(':')[1])).size, 16);
  // When every kept stop is a first boarding, the lowest-priority one gives way (the old behaviour).
  const firsts = Array.from({ length: 16 }, (_, index) => query('subway', index, '2호선'));
  const all = new Map([...firsts, bus].map((value) => [keyOf(value), value]));
  const kept = [...selectRealtimeQueries(all, new Set(firsts.map(keyOf)), 16).keys()];
  assert.ok(
    kept.includes('bus:stop-17:100') &&
      !kept.includes('subway:stop-15:2호선') &&
      kept.includes('subway:stop-0:2호선'),
  );
});

const pin = (id: string, index: number) => ({
  id,
  name: id,
  address: 'fx',
  latitude: 37.55,
  longitude: 126.97 + index / 1000,
});
const points = Array.from({ length: 19 }, (_, index) => pin(`stop-${index}`, index));
const leg = (
  id: string,
  mode: string,
  from: Place,
  to: Place,
  seconds: number,
  line?: string,
): BaseSegment =>
  ({
    id,
    mode,
    title: id,
    instructions: 'fx',
    start: from,
    end: to,
    distanceMeters: 100,
    durationSeconds: { min: seconds, max: seconds },
    runAllowed: false,
    polyline: [from, to],
    ...(['bus', 'subway'].includes(mode)
      ? {
          transit: {
            lines: [line ?? (mode === 'bus' ? '100' : '1호선')],
            stops: [from.name, to.name],
          },
        }
      : {}),
  }) as BaseSegment;
const base = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: 1_000,
  durationSeconds: {
    min: segments.reduce((sum, value) => sum + value.durationSeconds.min, 0),
    max: segments.reduce((sum, value) => sum + value.durationSeconds.max, 0),
  },
});
const noWalks: RouteProvider = {
  configured: true,
  searchPlaces: async () => [],
  walking: async () => {
    throw new Error('no walk');
  },
  transit: async () => [],
};

test("the enrichment pass keeps the top route's first boarding observed when a hub revisit lands past the cap", async () => {
  const origin = points[0],
    destination = points.at(-1)!;
  const a = base('a', [leg('a-ride', 'subway', origin, destination, 300)]);
  const b = base('b', [
    ...points
      .slice(1, 17)
      .map((from, index) => leg(`b-${index}`, 'subway', from, points[index + 2], 25)),
    leg('b-hub', 'subway', origin, points[17], 25, '2호선'),
    leg('b-bus', 'bus', points[17], destination, 25),
  ]);
  const observed: string[] = [];
  const realtime = {
    lookup: async (value: BoardingQuery) => {
      observed.push(`${value.mode}:${value.stop}:${value.lines}`);
      return null;
    },
  } as unknown as RealtimeServiceType;
  await enrichTransitRoutes(
    [a, b],
    { origin, destination },
    { provider: noWalks, budget: new CallBudget(), realtime, now: NOW, maxAccessCalls: 0 },
  );
  assert.ok(observed.includes('subway:stop-0:1호선'));
  assert.ok(observed.some((value) => value.startsWith('bus:')));
});

// ---- Name rules reach every bus boarding, observed or not. ----
test('a bus boarding beyond the realtime cap still reads what its line names establish', async () => {
  const at = kst(23, 39),
    origin = points[0],
    destination = points.at(-1)!;
  // Seventeen first boardings at distinct stops: the last one is past the 16-stop cap.
  const routes = points
    .slice(0, 17)
    .map((from, index) =>
      base(`r${index}`, [
        leg(
          `r${index}-ride`,
          'bus',
          from,
          destination,
          600 + index,
          index === 16 ? '8101(출근)' : `${100 + index}`,
        ),
      ]),
    );
  routes[16].segments[0].transit!.lines.push('7016');
  const sheets: string[] = [];
  const realtime = {
    lookup: async () => null,
    busSheet: async (value: BoardingQuery) => {
      sheets.push(value.stop);
      return null;
    },
  } as unknown as RealtimeServiceType;
  const enriched = await enrichTransitRoutes(
    routes,
    { origin, destination },
    { provider: noWalks, budget: new CallBudget(), realtime, now: at, maxAccessCalls: 0 },
  );
  assert.ok(!sheets.includes('stop-16'), 'no sheet request past the cap');
  const late = enriched.find((route) => route.id === 'r16')!;
  const ride = late.segments.find((segment) => segment.mode === 'bus')!;
  assert.equal(
    ride.headwayEvidence?.lines?.find((line) => line.name === '8101(출근)')?.status,
    'not-running',
  );
  // 8101(출근) does not run at 23:39: the rule counts 7016 alone (480 s), not both listed lines (240 s).
  assert.equal(late.segments.find((segment) => segment.mode === 'wait')!.durationSeconds.min, 480);
  // Lines without a restriction in their names keep the rule exactly: no evidence at all.
  assert.equal(
    enriched.find((route) => route.id === 'r3')!.segments.find((segment) => segment.mode === 'bus')!
      .headwayEvidence,
    undefined,
  );
  // Without any realtime service the name rules still apply.
  const offline = await enrichTransitRoutes(
    [routes[16]],
    { origin, destination },
    { provider: noWalks, budget: new CallBudget(), now: at, maxAccessCalls: 0 },
  );
  assert.equal(
    offline[0].segments.find((segment) => segment.mode === 'wait')!.durationSeconds.min,
    480,
  );
});

// ---- Several running lines merge as near-periodic streams. ----
test('running lines merge as independent periodic streams, not Poisson streams', () => {
  assert.equal(mergedPeriodicWait([300]), 300, 'one line keeps its own wait');
  // n equal periods H: E = H / (n + 1).
  assert.ok(Math.abs(mergedPeriodicWait([600, 600]) - 1200 / 3) < 1e-6);
  assert.ok(Math.abs(mergedPeriodicWait([300, 300, 300]) - 600 / 4) < 1e-6);
  // Unequal: ∫₀³⁰⁰ (1 − t/300)(1 − t/792) dt.
  const exact = 300 - (300 ** 2 / 2) * (1 / 300 + 1 / 792) + 300 ** 3 / 3 / (300 * 792);
  assert.ok(Math.abs(mergedPeriodicWait([150, 396]) - exact) < 1e-6);
  // Always at least the Poisson figure, and never above the shortest line's own wait.
  for (const waits of [
    [120, 180, 240],
    [300, 330, 360, 390, 420],
    [90, 600],
  ]) {
    const merged = mergedPeriodicWait(waits);
    assert.ok(
      merged >= 1 / waits.reduce((sum, wait) => sum + 1 / wait, 0) - 1e-9 &&
        merged <= Math.min(...waits) + 1e-9,
    );
  }
  // 신촌오거리 at 13:15 (six lines, term 6-10 minutes): the shipped window is no longer the 60 s floor.
  const line = (wait: number) => ({
    name: String(wait),
    reason: 'topis-term',
    state: () => ({
      kind: 'running' as const,
      wait,
      headway: 2 * wait,
      basis: 'topis-term' as const,
    }),
    edges: () => [],
  });
  const merged = mergeLineWindows(
    [396, 198, 231, 297, 330, 297].map(line),
    kst(13),
    NOW,
    30 * MINUTE,
  )!;
  assert.equal(
    merged.windows[0].waitSeconds,
    Math.round(mergedPeriodicWait([396, 198, 231, 297, 330, 297])),
  );
  assert.ok(merged.windows[0].waitSeconds! > 60);
});

// ---- 'ended' evidence makes the shared wait unusable, not the rule. ----
test('an unobserved wait whose boarding has no later running window has no duration and the route no estimate', () => {
  // A subway service day ends at 00:48; a 04:40 search sees null windows until the 05:00 table rollover.
  const date = kst(5),
    departures: number[] = [];
  for (let at = kst(5, 32) - DAY; at <= kst(0, 48); at += 6 * MINUTE) departures.push(at);
  const ev = timetableHeadwayEvidence(departures, date - DAY, date, kst(4, 40))!;
  const subway = vehicle('subway', ['2호선'], ev);
  assert.deepEqual(headwayEndedTail(subway), { from: ev.windows[0].from, to: date });
  const wait = expectedWait(300);
  assert.equal(
    waitServiceEndsAt(wait, { earliest: kst(4, 50), latest: kst(4, 50) }, subway),
    kst(4, 50),
  );
  assert.equal(
    dynamicWaitDurationRange(wait, { earliest: kst(4, 50), latest: kst(4, 50) }, subway),
    null,
  );
  assert.equal(
    estimatedSegmentSeconds(wait, kst(4, 50), subway),
    null,
    'no 300 s rule wait after the last train',
  );
  assert.equal(estimateBaseTimeline([wait, subway], kst(4, 50)), null);
  // Beyond the evidence the rule applies again.
  assert.equal(waitServiceEndsAt(wait, { earliest: date, latest: date }, subway), null);
  assert.notEqual(estimatedSegmentSeconds(wait, date, subway), null);

  // A bus with a running window, then nothing: only clocks in the tail are ended.
  const bus = vehicle(
    'bus',
    ['8101(출근)'],
    evidence([
      { from: kst(6, 30), to: kst(7, 30), waitSeconds: 180, headwaySeconds: 420 },
      { from: kst(7, 30), to: kst(12), waitSeconds: null, headwaySeconds: null },
    ]),
  );
  assert.equal(waitServiceEndsAt(wait, { earliest: kst(7), latest: kst(7, 20) }, bus), null);
  assert.deepEqual(dynamicWaitDurationRange(wait, { earliest: kst(7), latest: kst(7, 20) }, bus), {
    min: 180,
    max: 180,
  });
  assert.equal(
    waitServiceEndsAt(wait, { earliest: kst(7, 20), latest: kst(7, 40) }, bus),
    kst(7, 30),
  );
  assert.equal(
    dynamicWaitDurationRange(wait, { earliest: kst(7, 20), latest: kst(7, 40) }, bus),
    null,
  );
  assert.equal(estimatedSegmentSeconds(wait, kst(7, 20), bus), 180);
  assert.equal(estimatedSegmentSeconds(wait, kst(7, 31), bus), null);
  // Observed or bound waits are not unobserved policies.
  assert.equal(
    waitServiceEndsAt(
      { ...wait, id: 'x-timetable-wait' },
      { earliest: kst(7, 31), latest: kst(7, 31) },
      bus,
    ),
    null,
  );
  // No evidence, no tail.
  assert.equal(headwayEndedTail(vehicle('bus', ['402'])), null);
});

// ---- Stop sheets: TOPIS home-city names, express lines past unlisted stops, median stops off the strict radius. ----
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function topis(
  stops: { arsId: string; stationNm: string; gpsX: number; gpsY: number }[],
  sheets: Record<string, Record<string, unknown>[]>,
) {
  return new RealtimeService({
    dataGoKrServiceKey: 'key',
    now: () => NOW,
    fetcher: async (url) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('getStationByPos'))
        return json({
          msgHeader: { headerCd: '0' },
          msgBody: {
            itemList: stops.map((stop) => ({
              ...stop,
              gpsX: String(stop.gpsX),
              gpsY: String(stop.gpsY),
            })),
          },
        });
      return json({
        msgHeader: { headerCd: '0' },
        msgBody: { itemList: sheets[target.searchParams.get('arsId')!] ?? [] },
      });
    },
  });
}
const row = (rtNm: string, nxtStn: string, extra: Record<string, unknown> = {}) => ({
  rtNm,
  nxtStn,
  arrmsg1: '5분후[2번째 전]',
  arrmsg2: '15분후[6번째 전]',
  busRouteId: `id-${rtNm}`,
  stId: 'st-1',
  term: '10',
  firstTm: '0430',
  lastTm: '2300',
  ...extra,
});

test('a Gyeonggi line named after its home city on the TOPIS sheet matches the plain Kakao number', async () => {
  const service = topis(
    [{ arsId: '14062', stationNm: '신촌오거리.현대백화점', gpsX: 126.9357, gpsY: 37.5557 }],
    { '14062': [row('7101파주', '이대역'), row('271', '이대역')] },
  );
  const boarding: BoardingQuery = {
    mode: 'bus',
    stop: '신촌오거리.현대백화점(중)',
    lines: ['7101'],
    nextStops: ['이대역(중)'],
    latitude: 37.55551379,
    longitude: 126.93570545,
  };
  const sheet = (await service.busSheet(boarding))!;
  assert.equal(sheet.lines.get('7101')?.routeId, 'id-7101파주');
  const live = (await service.lookup(boarding))!;
  assert.deepEqual(
    live.predictions.map((prediction) => prediction.line),
    ['7101', '7101'],
    'the arrivals bind under the Kakao name',
  );
});

test("the boarding's own stop gives an express line's sheet even when its next stop is one the line skips", async () => {
  // 연세대앞: Kakao's anchor is 0.9 m from 13012 (towards 신촌역로), the opposite 13013 is 25.6 m away.
  const stops = [
    { arsId: '13012', stationNm: '연세대앞', gpsX: 126.935342, gpsY: 37.559955 },
    { arsId: '13013', stationNm: '연세대앞', gpsX: 126.93534246, gpsY: 37.5601978 },
  ];
  const service = topis(stops, {
    '13012': [row('1000고양', '신촌역로(미정차)', { arrmsg1: '운행종료', arrmsg2: '운행종료' })],
    '13013': [row('1000고양', '사천교(미정차)')],
  });
  const boarding: BoardingQuery = {
    mode: 'bus',
    stop: '연세대앞(중)',
    lines: ['1000', '1900(평일)'],
    nextStops: ['광화문역6번출구.광화문빌딩'],
    latitude: 37.55996283,
    longitude: 126.93534246,
  };
  const sheet = (await service.busSheet(boarding))!;
  assert.equal(sheet.stopId, '13012');
  assert.equal(sheet.lines.get('1000')?.ended, true);
  assert.equal(
    await service.lookup(boarding),
    null,
    'no live vehicle is bound without next-stop evidence',
  );
  // Two same-name stops within the strict radius: the direction is not established, no sheet.
  const ambiguous = topis([stops[0], { ...stops[1], gpsY: 37.56005 }], {
    '13012': [row('1000고양', '신촌역로(미정차)')],
    '13013': [row('1000고양', '사천교(미정차)')],
  });
  assert.equal(await ambiguous.busSheet(boarding), null);
});

test('a median stop 44 m from its TOPIS stop resolves through the same next-stop evidence', async () => {
  const stops = [
    { arsId: '13045', stationNm: '충정로역', gpsX: 126.96359, gpsY: 37.56157 },
    { arsId: '13571', stationNm: '충정로역8번출구', gpsX: 126.963, gpsY: 37.5612 },
  ];
  const service = topis(stops, {
    '13045': [row('271', '서대문역사거리'), row('602', '서대문역사거리')],
    '13571': [row('7612', '서대문역사거리')],
  });
  const boarding: BoardingQuery = {
    mode: 'bus',
    stop: '충정로역(중)',
    lines: ['271', '602'],
    nextStops: ['서대문역사거리(중)'],
    latitude: 37.56118056,
    longitude: 126.96359447,
  };
  const sheet = (await service.busSheet(boarding))!;
  assert.deepEqual([...sheet.lines.keys()].sort(), ['271', '602']);
  assert.equal((await service.lookup(boarding))?.stopName, '충정로역');
  // The wrong direction never resolves.
  assert.equal(await service.busSheet({ ...boarding, nextStops: ['아현역(중)'] }), null);
  // A roadside stop name gets no widened radius.
  assert.equal(await service.busSheet({ ...boarding, stop: '충정로역' }), null);
  // With the sheet the merged evidence is built from its lines.
  assert.ok(busHeadwayEvidence(boarding.lines, sheet.lines, NOW));
});

test('sheet edge cases: no stop offset, an ended line without first and last departures, sheet clock formats', () => {
  // A Gyeonggi line (no T-DATA offset) with a 05:00 origin first departure: its first bus may not have reached a Seoul
  // stop at 05:05, so that is unknown, not running; by 06:31 it runs.
  const line = busLineModel(
    '1000',
    {
      routeId: '219000013',
      stopId: '112000012',
      termMinutes: 15,
      firstMinute: 300,
      lastMinute: 1380,
    },
    kst(5, 5),
  );
  assert.equal(line.state(kst(5, 5)).kind, 'unknown');
  assert.equal(line.state(kst(6, 31)).kind, 'running');
  assert.ok(line.edges(kst(5), kst(7)).includes(kst(6, 30)));
  // Ended with no published first/last departure: not running until 04:00, then unknown (not six hours of nothing).
  const ended = busLineModel(
    'A1',
    { routeId: 'x', ended: true, termMinutes: 10 } as never,
    kst(23, 50),
  );
  assert.equal(ended.state(kst(23, 55)).kind, 'not-running');
  assert.equal(
    ended.state(kst(4, 1) + DAY).kind,
    'unknown',
    'no running hours are known, so the rule applies again',
  );
  const evidenceAfter = busHeadwayEvidence(
    ['A1'],
    new Map([['A1', { routeId: 'x', ended: true, termMinutes: 10 }]]),
    kst(23, 50),
  )!;
  assert.ok(
    evidenceAfter.windows.some(
      (window) => window.from === kst(4) + DAY && window.waitSeconds !== null,
    ),
  );
  // TOPIS writes first/last departures as padded HHmm or a 14-digit stamp.
  assert.equal(sheetMinute('0430  '), 270);
  assert.equal(sheetMinute('20230927041000'), 250);
  assert.equal(sheetMinute('2530'), 25 * 60 + 30);
  assert.equal(sheetMinute('4:30'), undefined);
});

test('lookup and sheet of one boarding share one feed pass, so a failing stop is asked and recorded once', async () => {
  let calls = 0;
  const service = new RealtimeService({
    dataGoKrServiceKey: 'key',
    now: () => NOW,
    fetcher: async () => {
      calls++;
      return new Response('nope', { status: 500 });
    },
  });
  const boarding: BoardingQuery = {
    mode: 'bus',
    stop: '충정로역(중)',
    lines: ['271'],
    nextStops: ['서대문역사거리(중)'],
    latitude: 37.56118056,
    longitude: 126.96359447,
  };
  const [live, sheet] = await Promise.all([service.lookup(boarding), service.busSheet(boarding)]);
  assert.equal(live, null);
  assert.equal(sheet, null);
  // One TOPIS stop request and one national (TAGO) fallback request, not two of each.
  assert.equal(calls, 2);
  assert.equal(
    service.diagnostics.find((item) => item.provider === 'seoul-bus')?.status,
    'unavailable',
  );
});

// ---- Timetable budget: what is left after the last ride that fits goes to the next boarding's wait. ----
const raw = (station: string, train: string, time: string, direction: string) => ({
  STATION_CD: station,
  STATION_NM: station,
  LINE_NUM: '01호선',
  TRAIN_NO: train,
  ARRIVETIME: time,
  LEFTTIME: time,
  WEEK_TAG: '1',
  INOUT_TAG: direction,
  ORIGINSTATION: '0199',
  DESTSTATION: '0153',
  SUBWAYENAME: '종로3가',
  EXPRESS_YN: 'G',
  BRANCH_LINE: '',
});
function fakeFeed() {
  let calls = 0;
  const fetcher = (async (url: URL | RequestInfo) => {
    calls++;
    const parts = new URL(String(url)).pathname.split('/').map(decodeURIComponent),
      service = parts[3];
    const master = [
      { STATION_CD: '0150', STATION_NM: '서울역', LINE_NUM: '01호선' },
      { STATION_CD: '0151', STATION_NM: '시청', LINE_NUM: '01호선' },
      { STATION_CD: '0153', STATION_NM: '종로3가', LINE_NUM: '01호선' },
    ];
    const code = parts[6],
      direction = parts[8],
      delta = code === '0150' ? 0 : code === '0151' ? 2 : 5;
    const row =
      service === 'SearchSTNBySubwayLineInfo'
        ? master
        : [
            raw(code, 'K1', `12:${String(3 + delta).padStart(2, '0')}:00`, direction),
            raw(code, 'K2', `12:${String(10 + delta).padStart(2, '0')}:00`, direction),
          ];
    return new Response(
      JSON.stringify({
        [service]: { RESULT: { CODE: 'INFO-000' }, list_total_count: row.length, row },
      }),
    );
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

test("the queries left after the last ride that fits go to the next boarding's wait evidence", async () => {
  const at = Date.parse('2026-10-16T12:00:00+09:00');
  const p = (id: string, latitude: number): Place => ({
    id,
    name: id,
    address: '',
    latitude,
    longitude: 126.97,
  });
  const from = p('출발', 37.55),
    boarding = p('서울역', 37.551),
    to = p('종로3가', 37.56);
  const ride = {
    ...leg('rail', 'subway', boarding, to, 300),
    transit: { lines: ['1호선'], stops: ['서울역', '시청', '종로3가'] },
    lineName: '1호선',
  } as BaseSegment;
  const transit = base('transit', [leg('access', 'walk', from, boarding, 100), ride]);
  const feed = fakeFeed(),
    service = new SeoulTimetableService({
      key: 'test',
      now: () => at,
      fetcher: feed.fetcher,
      maxQueries: 5,
    });
  const [enriched] = await service.enrich([transit], at);
  assert.equal(enriched.segments[1].scheduleCheck?.reason, 'budget');
  assert.equal(enriched.segments[1].timetable, undefined);
  assert.equal(enriched.segments[1].headwayEvidence?.basis, 'published-timetable');
  assert.equal(feed.calls(), 5);
  const poor = fakeFeed(),
    tight = new SeoulTimetableService({
      key: 'test',
      now: () => at,
      fetcher: poor.fetcher,
      maxQueries: 3,
    });
  assert.equal((await tight.enrich([transit], at))[0].segments[1].headwayEvidence, undefined);
  assert.equal(poor.calls(), 1);
});
