// Regression cases from mvp/tests/headwayEvidence.test.ts (the app-client validation case lives there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import {
  busHeadwayEvidence,
  busLineModel,
  mergeLineWindows,
  setDispatchTableForTest,
  sheetLineKey,
  timetableHeadwayEvidence,
} from '../src/common/engine/realtime/headway-evidence.js';
import { dynamicWaitDurationRange } from '../src/common/shared/domain/estimatedTiming.js';
import {
  continuationEdges,
  liveDepartureRange,
  nextUnlistedDeparture,
  unlistedHeadway,
  unlistedWaitRange,
} from '../src/common/shared/domain/liveBoarding.js';
import {
  evidenceHeadway,
  expectedWaitSeconds,
  headwayServiceEnded,
  waitChangeTimes,
} from '../src/common/shared/domain/waitEstimates.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type HeadwayEvidence,
  type Place,
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
const evidence = (windows: HeadwayEvidence['windows']): HeadwayEvidence => ({
  version: 1,
  basis: 'tdata-dispatch',
  derivedAt: NOW,
  windows,
});

/** The time-of-day rule as it stood before headway evidence, copied verbatim. A subway boarding with no timetable is the
 * one addition: between 01:00 and 05:30 no train runs, so the rider waits for the first ones (11-02, quality defect 1). */
function referenceRule(segment: BaseSegment, now: number): number {
  const date = new Date(now + KST),
    minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const peak = (minutes >= 420 && minutes < 570) || (minutes >= 1050 && minutes < 1200);
  const late = minutes >= 1320 || minutes < 360;
  if (segment.mode === 'subway') {
    if (minutes >= 60 && minutes < 330) {
      const sinceMidnight = (((now + KST) % DAY) + DAY) % DAY;
      return Math.ceil((330 * 60_000 - sinceMidnight) / 1000) + 300;
    }
    return peak ? 120 : late ? 300 : 210;
  }
  return Math.max(
    120,
    Math.round((peak ? 300 : late ? 480 : 360) / Math.max(1, segment.transit?.lines.length ?? 1)),
  );
}
function referenceChanges(segment: BaseSegment, from: number, to: number): number[] {
  const times: number[] = [];
  for (let day = Math.floor((from + KST) / DAY) * DAY - KST; day <= to; day += DAY)
    for (const minute of segment.mode === 'subway'
      ? [60, 330, 360, 420, 570, 1050, 1200, 1320]
      : [360, 420, 570, 1050, 1200, 1320]) {
      const time = day + minute * MINUTE;
      if (time >= from && time <= to) times.push(time);
    }
  return times;
}

test('without headway evidence every shared wait reads exactly the previous rule and its change clocks', () => {
  const segments = [
    vehicle('subway', ['2호선']),
    vehicle('bus', ['402']),
    vehicle('bus', ['402', '405', 'N15(심야)']),
  ];
  for (const segment of segments) {
    for (let at = kst(0) - DAY; at < kst(0) + DAY; at += 7 * MINUTE + 13_000) {
      assert.equal(expectedWaitSeconds(segment, at), referenceRule(segment, at));
      assert.equal(evidenceHeadway(segment, at), null);
      assert.equal(headwayServiceEnded(segment, at), false);
      assert.deepEqual(unlistedHeadway(segment, at), {
        waitSeconds: referenceRule(segment, at),
        headwaySeconds: 2 * referenceRule(segment, at),
      });
    }
    for (const [from, to] of [
      [kst(5, 59), kst(7, 1)],
      [kst(0), kst(23, 59)],
      [kst(21), kst(21) + DAY],
    ]) {
      assert.deepEqual(waitChangeTimes(segment, from, to), referenceChanges(segment, from, to));
      assert.deepEqual(
        continuationEdges(segment, from, to),
        referenceChanges(segment, from, to).filter((time) => time > from),
      );
    }
    // The continuation at a rule edge still follows the rule's FIFO envelope.
    const late = nextUnlistedDeparture(segment, undefined, kst(16, 59), NOW)!;
    assert.equal(
      late.departureAt,
      Math.min(
        kst(16, 59) + referenceRule(segment, kst(16, 59)) * 1000,
        kst(17, 30) + referenceRule(segment, kst(17, 30)) * 1000,
      ),
    );
  }
});

test('evidence windows set the wait, the spacing after a listed vehicle and every change clock', () => {
  const windows = [
    { from: kst(8), to: kst(8, 30), waitSeconds: 300, headwaySeconds: 600 },
    { from: kst(8, 30), to: kst(9), waitSeconds: 90, headwaySeconds: 200 },
    { from: kst(9), to: kst(9, 30), waitSeconds: 420, headwaySeconds: 840 },
  ];
  const bus = vehicle('bus', ['402', '405'], evidence(windows));
  assert.equal(expectedWaitSeconds(bus, kst(8, 10)), 300);
  assert.equal(expectedWaitSeconds(bus, kst(8, 30)), 90);
  assert.equal(expectedWaitSeconds(bus, kst(9, 29)), 420);
  // Outside the evidence the rule applies, two listed lines at 09:30 → 360 / 2.
  assert.equal(expectedWaitSeconds(bus, kst(9, 30)), 180);
  assert.equal(expectedWaitSeconds(bus, kst(7, 59)), 150);
  assert.deepEqual(unlistedHeadway(bus, kst(8, 45)), { waitSeconds: 90, headwaySeconds: 200 });
  assert.deepEqual(
    waitChangeTimes(bus, kst(7), kst(10)).sort((a, b) => a - b),
    [kst(7), kst(8), kst(8, 30), kst(9), kst(9, 30)],
  );
  // The planner's range over an access interval across two boundaries.
  const wait: BaseSegment = {
    id: 'x-wait-0-expected-wait',
    mode: 'wait',
    title: '승차 대기',
    instructions: '',
    distanceMeters: 0,
    runAllowed: false,
    start: bus.start,
    end: bus.start,
    durationSeconds: { min: 300, max: 300 },
    expectedWaitBasisSeconds: 300,
  };
  assert.deepEqual(
    dynamicWaitDurationRange(wait, { earliest: kst(8, 20), latest: kst(9, 5) }, bus),
    { min: 90, max: 420 },
  );
  assert.deepEqual(
    dynamicWaitDurationRange(wait, { earliest: kst(8, 31), latest: kst(8, 59) }, bus),
    { min: 90, max: 90 },
  );
  // After a listed vehicle at 08:40 the next one is one evidence headway later.
  const live = {
    status: 'live' as const,
    predictions: [{ line: '402', arrivesAt: kst(8, 40), message: '' }],
  };
  assert.equal(
    nextUnlistedDeparture(bus, live, kst(8, 41), NOW)!.departureAt,
    Math.max(kst(8, 41) + 90_000, kst(8, 40) + 200_000),
  );
  const range = liveDepartureRange(bus, live, { earliest: kst(8, 35), latest: kst(8, 50) }, NOW)!;
  assert.equal(range.departure.earliest, kst(8, 40));
  assert.equal(range.departure.latest, kst(8, 50) + 90_000);
});

test('the continuation stays FIFO across evidence windows: a rider never boards later by arriving earlier', () => {
  const bus = vehicle(
    'bus',
    ['402'],
    evidence([
      { from: kst(8), to: kst(8, 30), waitSeconds: 600, headwaySeconds: 1_200 },
      { from: kst(8, 30), to: kst(9), waitSeconds: 60, headwaySeconds: 120 },
      { from: kst(9), to: kst(9, 20), waitSeconds: null, headwaySeconds: null },
      { from: kst(9, 20), to: kst(10), waitSeconds: 240, headwaySeconds: 480 },
    ]),
  );
  // Just before 08:30 the 600 s window would board at 08:39:50; waiting for the 08:30 vehicle stream is earlier.
  assert.equal(
    nextUnlistedDeparture(bus, undefined, kst(8, 29) + 50_000, NOW)!.departureAt,
    kst(8, 30) + 60_000,
  );
  let previous = -Infinity;
  for (let at = kst(8); at < kst(10); at += 7_000) {
    const departure = nextUnlistedDeparture(bus, undefined, at, NOW)!.departureAt;
    assert.ok(departure >= at, 'never departs before the rider arrives');
    assert.ok(departure >= previous, `FIFO at ${new Date(at + KST).toISOString()}`);
    previous = departure;
  }
  // The marginal-wait range probes every window edge: from 08:20 to 08:31 it spans the envelope's 10 s to 600 s.
  const waits = unlistedWaitRange(bus, undefined, kst(8, 20), kst(8, 31), NOW, true)!;
  assert.equal(waits.max, 600);
  assert.ok(waits.min <= 60);
});

test("before the first departure the wait runs to the first running window, plus that window's own wait", () => {
  const bus = vehicle(
    'bus',
    ['8101(출근)'],
    evidence([
      { from: kst(5), to: kst(6, 55), waitSeconds: null, headwaySeconds: null },
      { from: kst(6, 55), to: kst(7, 30), waitSeconds: 180, headwaySeconds: 420 },
      { from: kst(7, 30), to: kst(11), waitSeconds: null, headwaySeconds: null },
    ]),
  );
  assert.equal(expectedWaitSeconds(bus, kst(6, 40)), 15 * 60 + 180);
  assert.equal(
    expectedWaitSeconds(bus, kst(6, 40) + 400),
    15 * 60 + 180,
    'whole seconds, rounded up',
  );
  for (const at of [kst(6, 40), kst(6, 40) + 400, kst(6, 54) + 59_999])
    assert.equal(nextUnlistedDeparture(bus, undefined, at, NOW)!.departureAt, kst(6, 55) + 180_000);
  // After the last running window nothing runs again inside the evidence: the continuation ends.
  assert.equal(headwayServiceEnded(bus, kst(7, 30)), true);
  assert.equal(nextUnlistedDeparture(bus, undefined, kst(7, 31), NOW), null);
  assert.equal(
    nextUnlistedDeparture(bus, undefined, kst(11, 1), NOW)?.basis,
    'wait-rule',
    'outside the evidence the rule continues',
  );
});

test('a boarding whose lines do not run in the reachable windows is excluded from the graph; running evidence keeps it', () => {
  const origin = place('출발', 37.55, 126.97),
    stop = place('승차', 37.551, 126.97),
    destination = place('도착', 37.58, 126.99);
  const request = {
    origin,
    destination,
    now: kst(23, 39),
    deadline: kst(23, 39) + 2 * 3_600_000,
    preferences: { ...DEFAULT_PREFERENCES, preparationSeconds: 0 },
  };
  const route = (headwayEvidence: HeadwayEvidence): BaseRoute => {
    const ride = {
      ...vehicle('bus', ['8101(출근)', 'P9601(퇴근)'], headwayEvidence),
      start: stop,
      end: destination,
      polyline: [stop, destination],
    };
    const segments: BaseSegment[] = [
      {
        id: 'b-access',
        mode: 'walk',
        title: '걷기',
        instructions: '',
        distanceMeters: 100,
        durationSeconds: { min: 90, max: 90 },
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
        durationSeconds: { min: 120, max: 120 },
        expectedWaitBasisSeconds: 120,
        start: stop,
        end: stop,
        runAllowed: false,
      },
      ride,
    ];
    return {
      id: 'bus-only',
      title: '버스',
      segments,
      transfers: 0,
      distanceMeters: 4_000,
      durationSeconds: { min: 810, max: 810 },
    };
  };
  const idle = evidence([
    { from: kst(23, 30), to: kst(23, 30) + 6 * 3_600_000, waitSeconds: null, headwaySeconds: null },
  ]);
  const plan = (base: BaseRoute) =>
    planJourneyGraph(request, [base], { receivedAt: request.now, maxResults: 3 });
  assert.equal(
    plan(route(idle)).routes.length,
    0,
    'no running line in the horizon: the arc is excluded',
  );
  const running = evidence([
    { from: kst(23, 30), to: kst(23, 30) + 6 * 3_600_000, waitSeconds: 300, headwaySeconds: 600 },
  ]);
  const kept = plan(route(running)).routes;
  assert.equal(kept.length, 1);
  assert.equal(
    kept[0].segments.find((segment) => segment.mode === 'wait')!.durationSeconds.max,
    300,
  );
});

const TABLE = {
  version: 1 as const,
  reviewAfter: '2026-11-30T00:00:00+09:00',
  bandMinutes: 30,
  routes: {
    '100100063': {
      n: '402',
      o: { '101000003': 10 },
      d: {
        weekday: [
          [[240, 1380]],
          8,
          Array.from({ length: 38 }, (_, index) => (index === 9 ? 150 : index === 10 ? 420 : 300)),
          Array.from({ length: 38 }, (_, index) => (index === 9 ? 300 : 600)),
        ],
      },
    },
    '110000005': {
      n: '8101',
      o: { '101000003': 5 },
      d: { weekday: [[[414, 469]], 13, [602, 281, 271], [336, 600, 370]] },
    },
  },
} as unknown as Parameters<typeof setDispatchTableForTest>[0];

test('bus lines are classified from the stop sheet, then T-DATA, then the name, and only running lines merge', () => {
  setDispatchTableForTest(TABLE);
  try {
    const sheet = new Map([
      [
        sheetLineKey('402'),
        {
          routeId: '100100063',
          stopId: '101000003',
          termMinutes: 8,
          firstMinute: 240,
          lastMinute: 1380,
          ended: false,
        },
      ],
      [
        sheetLineKey('405'),
        {
          routeId: '100100064',
          stopId: '101000003',
          termMinutes: 12,
          firstMinute: 240,
          lastMinute: 1380,
          ended: false,
        },
      ],
    ]);
    // 08:47 at the stop is 08:37 at the origin of 402: band 17 (08:30-09:00) → index 9 in the table, 150 s.
    const model402 = busLineModel('402', sheet.get('402'), NOW);
    assert.deepEqual(model402.state(kst(8, 47)), {
      kind: 'running',
      wait: 150,
      headway: 300,
      basis: 'tdata-dispatch',
    });
    // 405 has no T-DATA row: its published spacing, 12 × 1.1 minutes.
    assert.deepEqual(busLineModel('405', sheet.get('405'), NOW).state(kst(8, 47)), {
      kind: 'running',
      wait: 396,
      headway: 792,
      basis: 'topis-term',
    });
    // 8101(출근) is not on this sheet: the name keeps it out at 23:39 and lets it count as unclassified in the morning.
    assert.equal(busLineModel('8101(출근)', undefined, NOW).state(kst(23, 39)).kind, 'not-running');
    assert.equal(busLineModel('8101(출근)', undefined, NOW).state(kst(7)).kind, 'unknown');
    const merged = busHeadwayEvidence(['402', '405', '8101(출근)'], sheet, NOW)!;
    assert.equal(merged.basis, 'tdata-dispatch');
    const at = merged.windows.find(
      (window) => kst(8, 47) >= window.from && kst(8, 47) < window.to,
    )!;
    // Two periodic streams (periods 2W = 300 s and 792 s): ∫₀³⁰⁰ (1 − t/300)(1 − t/792) dt = 131 s, not the Poisson 109 s.
    assert.equal(at.waitSeconds, 131, 'no division by the number of listed lines');
    assert.equal(at.headwaySeconds, Math.round(1 / (1 / 300 + 1 / 792)));
    assert.deepEqual(
      merged.lines?.map((line) => line.status),
      ['running', 'running', 'unknown'],
    );
    // Windows are contiguous, start on the grid at or before the clock and change where 402's origin band changes.
    assert.equal(merged.windows[0].from, kst(8, 30));
    assert.ok(
      merged.windows.every(
        (window, index) => index === 0 || window.from === merged.windows[index - 1].to,
      ),
    );
    assert.ok(
      merged.windows.some((window) => window.from === kst(9)),
      'the stop grid edge',
    );
    // A sheet that reports the line finished stays not running until its next first departure.
    const ended = busLineModel('402', { ...sheet.get('402')!, ended: true }, kst(23, 50));
    assert.equal(ended.state(kst(23, 55)).kind, 'not-running');
    assert.equal(ended.state(kst(4, 11) + DAY).kind, 'running');
    // Nothing classified at all: no evidence, the rule applies unchanged.
    assert.equal(busHeadwayEvidence(['9999'], null, NOW), null);
    // Every line out of service for the whole horizon: null windows, which exclude the boarding.
    const night = busHeadwayEvidence(['8101(출근)', 'P9601(퇴근)'], null, kst(23, 39))!;
    assert.ok(
      night.windows
        .filter((window) => window.from < kst(5, 0) + DAY)
        .every((window) => window.waitSeconds === null),
    );
  } finally {
    setDispatchTableForTest(null);
  }
});

test('a window where only unclassified lines may run keeps the rule for those lines alone', () => {
  const unknown = {
    name: '9999',
    reason: 'none',
    state: () => ({ kind: 'unknown' as const }),
    edges: () => [],
  };
  const off = {
    name: '8101(출근)',
    reason: 'name-rule',
    state: () => ({ kind: 'not-running' as const }),
    edges: () => [],
  };
  const result = mergeLineWindows([unknown, off, off], kst(12), NOW, 3_600_000)!;
  assert.deepEqual(result.windows, [
    { from: kst(12), to: kst(13), waitSeconds: 360, headwaySeconds: 720 },
  ]);
  assert.equal(result.basis, 'rule');
});

test('subway evidence integrates the published departures and ends with the last train of the service day', () => {
  const validFrom = kst(5),
    validUntil = validFrom + DAY;
  const departures = [kst(23, 40), kst(23, 50), kst(0, 5) + DAY, kst(0, 35) + DAY];
  const result = timetableHeadwayEvidence(departures, validFrom, validUntil, kst(23, 31))!;
  assert.equal(result.basis, 'published-timetable');
  assert.equal(result.windows[0].from, kst(23, 30));
  const subway = vehicle('subway', ['4호선'], result);
  // 23:30 → the first train at 23:40: a null window then the running ones.
  assert.equal(expectedWaitSeconds(subway, kst(23, 31)), 9 * 60 + result.windows[1].waitSeconds!);
  const first = result.windows.find((window) => window.from === kst(23, 40))!;
  // Uniform 10-minute spacing from 23:40 to 23:50, then 15 minutes to 00:05 (window 23:40-24:00).
  assert.equal(first.waitSeconds, Math.round((((10 * 10) / 2 + (15 * 15 - 5 * 5) / 2) * 60) / 20));
  assert.equal(headwayServiceEnded(subway, kst(0, 36) + DAY), true);
  assert.equal(nextUnlistedDeparture(subway, undefined, kst(0, 40) + DAY, NOW), null);
});
