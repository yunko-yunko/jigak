// A subway boarding before the first train waits for that train, and one in the day waits its headway (quality
// INTEGRATION-QUALITY, 11-02 defect 1). The 151-minute wait seen in the live check was a 03:25 search: the first 2호선
// train of the day was 05:46, so the wait was real. These cases pin the shape of the wait around the first train, at
// 04:53 and at a daytime hour, with the published timetable and with the time-of-day rule alone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { timetableHeadwayEvidence } from '../src/common/engine/realtime/headway-evidence.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import {
  expectedWaitSeconds,
  waitChangeTimes,
} from '../src/common/shared/domain/waitEstimates.js';
import {
  DEFAULT_PREFERENCES,
  planBaseRoutes,
  type BaseRoute,
  type BaseSegment,
  type HeadwayEvidence,
  type Place,
  type Provenance,
} from '../src/common/shared/domain/index.js';

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
const at = (date: string, clock: string) => Date.parse(`${date}T${clock}:00+09:00`);
const LAST_DAY = '2026-11-05',
  FIRST_DAY = '2026-11-06';
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const ride = (headwayEvidence?: HeadwayEvidence | null): BaseSegment => ({
  id: 'subway-ride',
  mode: 'subway',
  title: '2호선',
  instructions: '',
  distanceMeters: 3_000,
  durationSeconds: { min: 600, max: 600 },
  start: place('승차', 37.55, 126.97),
  end: place('하차', 37.56, 126.98),
  runAllowed: false,
  transit: { lines: ['2호선'], stops: ['승차', '다음', '하차'] },
  ...(headwayEvidence ? { headwayEvidence } : {}),
});
// Friday's trains run 05:32 to 00:48 every six minutes; Saturday's first train is 05:31 (the same shape as the
// service-day cases in engine-headwayServiceDay.test.ts).
const ownDay = (): number[] => {
  const departures: number[] = [];
  for (let clock = at(LAST_DAY, '05:32'); clock <= at(FIRST_DAY, '00:48'); clock += 6 * MINUTE)
    departures.push(clock);
  return departures;
};
const nextDay = (): number[] =>
  Array.from({ length: 120 }, (_, index) => at(FIRST_DAY, '05:31') + index * 6 * MINUTE);
const evidenceAt = (now: number): HeadwayEvidence => {
  const validFrom = at(LAST_DAY, '05:00');
  return timetableHeadwayEvidence(ownDay(), validFrom, validFrom + DAY, now, undefined, {
    departures: nextDay(),
    validUntil: validFrom + 2 * DAY,
  })!;
};

test('the rule alone gives a night subway boarding the first train, and the day its headway', () => {
  const subway = ride();
  const wait = (clock: string, date = FIRST_DAY) => expectedWaitSeconds(subway, at(date, clock));
  // 04:53: about 37 minutes to the first trains at 05:30, plus the first headway allowance.
  assert.ok(wait('04:53') >= 2_100 && wait("04:53") <= 2_600, `04:53 waits ${wait('04:53')} s`);
  assert.equal(wait('04:53'), (330 - 293) * 60 + 300);
  // A 03:25 search waits two hours: no train runs yet. It is the right answer, not an overflow.
  assert.equal(wait('03:25'), (330 - 205) * 60 + 300);
  // The wait runs out into the allowance at the first train, with no jump.
  assert.equal(wait('05:29'), 60 + 300);
  assert.equal(wait('05:30'), 300);
  // The day keeps its headway rule: 210 s off peak, 120 s in the morning peak, 300 s late evening.
  assert.equal(wait('14:00'), 210);
  assert.equal(wait('08:00'), 120);
  assert.equal(wait('23:00'), 300);
  assert.equal(wait('00:30'), 300);
  // A bus is not closed at night; the night buses run on their own headway.
  const bus = { ...ride(), mode: 'bus' as const, transit: { lines: ['N13'], stops: ['승차', '하차'] } };
  assert.equal(expectedWaitSeconds(bus, at(FIRST_DAY, '04:53')), 480);
  // The planner samples the wait where the rule changes: the service edges are among them.
  const edges = waitChangeTimes(subway, at(FIRST_DAY, '00:00'), at(FIRST_DAY, '06:00'));
  assert.ok(edges.includes(at(FIRST_DAY, '01:00')) && edges.includes(at(FIRST_DAY, '05:30')));
});

test('the timetable wait at 04:53 runs to the first train and never to the day after', () => {
  const now = at(FIRST_DAY, '04:53');
  const evidence = evidenceAt(now);
  const subway = ride(evidence);
  const first = evidence.windows.find((window) => window.waitSeconds !== null)!;
  assert.equal(first.from, at(FIRST_DAY, '05:31'));
  const wait = expectedWaitSeconds(subway, now);
  assert.equal(wait, (at(FIRST_DAY, '05:31') - now) / 1000 + first.waitSeconds!);
  assert.ok(wait >= 38 * 60 && wait <= 45 * 60, `04:53 waits ${wait} s`);
  // The same boarding at 03:25 (the live check's hour) waits for the same first train: about 2 hours 6 minutes.
  const early = at(FIRST_DAY, '03:25');
  const earlyWait = expectedWaitSeconds(ride(evidenceAt(early)), early);
  assert.equal(earlyWait, (at(FIRST_DAY, '05:31') - early) / 1000 + first.waitSeconds!);
  assert.ok(earlyWait > 2 * 3600 && earlyWait < 2.3 * 3600);
  // At 05:20 a rider reaching the platform at 05:25 waits the same train; a rider at 05:31 is in the headway window.
  assert.ok(expectedWaitSeconds(subway, at(FIRST_DAY, "05:25")) < 10 * 60);
});

test('the timetable wait in the day is the window headway wait', () => {
  const now = at(FIRST_DAY, '14:00') - 10 * MINUTE;
  const validFrom = at(FIRST_DAY, '05:00');
  const evidence = timetableHeadwayEvidence(
    nextDay(),
    validFrom,
    validFrom + DAY,
    now,
  )!;
  const subway = ride(evidence);
  const wait = expectedWaitSeconds(subway, at(FIRST_DAY, '14:00'));
  const window = evidence.windows.find(
    (value) => at(FIRST_DAY, '14:00') >= value.from && at(FIRST_DAY, '14:00') < value.to,
  )!;
  assert.equal(wait, window.waitSeconds);
  assert.ok(wait > 0 && wait <= 200, `six-minute spacing waits ${wait} s on average`);
});

// ---- The planner ----
const provenanceAt = (now: number): Provenance => ({
  mode: 'live',
  provider: 'kakao',
  label: '카카오 경로',
  sourceTimestamp: null,
  receivedAt: now,
  isRealtime: false,
});
const source = (headwayEvidence?: HeadwayEvidence | null, waitBasis = 300): BaseRoute => {
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
      durationSeconds: { min: waitBasis, max: waitBasis },
      expectedWaitBasisSeconds: waitBasis,
      start: stop,
      end: stop,
      runAllowed: false,
    },
    {
      ...ride(headwayEvidence),
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
function plan(now: number, sources: BaseRoute[]) {
  const origin = sources[0].segments[0].start,
    destination = sources[0].segments.at(-1)!.end;
  const request = {
    origin,
    destination,
    now,
    deadline: now + 8 * HOUR,
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
const subwayRoute = (now: number, sources: BaseRoute[]) =>
  plan(now, sources).routes.find((route) => route.segments.some((s) => s.mode === 'subway'))!;
const waitOf = (route: { segments: readonly BaseSegment[] }) =>
  route.segments.filter((segment) => segment.mode === 'wait').reduce(
    (sum, segment) => sum + segment.durationSeconds.max,
    0,
  );

test('a 04:53 subway trip waits about forty minutes and boards no earlier than the first train', () => {
  const now = at(FIRST_DAY, '04:53');
  for (const [name, route] of [
    ['timetable', subwayRoute(now, [source(evidenceAt(now))])],
    ['rule', subwayRoute(now, [source()])],
  ] as const) {
    assert.ok(route, name);
    const wait = waitOf(route);
    assert.ok(wait >= 30 * MINUTE / 1000 && wait <= 45 * MINUTE / 1000, `${name}: waits ${wait} s`);
    const arrival = estimateBaseTimeline(route.segments, now)!.arrivalAt;
    assert.ok(arrival >= at(FIRST_DAY, '05:30') + 10 * MINUTE, `${name}: arrives before the first train rides`);
    assert.ok(arrival <= at(FIRST_DAY, '06:25'), `${name}: arrives ${new Date(arrival).toISOString()}`);
  }
});

test('a 03:25 subway trip waits the two hours to the first train, with the timetable and with the rule', () => {
  const now = at(FIRST_DAY, '03:25');
  for (const route of [
    subwayRoute(now, [source(evidenceAt(now))]),
    subwayRoute(now, [source()]),
  ]) {
    assert.ok(route);
    const wait = waitOf(route);
    assert.ok(wait > 2 * 3600 - 10 * MINUTE / 1000 && wait < 2.3 * 3600, `waits ${wait} s`);
    assert.ok(estimateBaseTimeline(route.segments, now)!.arrivalAt >= at(FIRST_DAY, '05:30'));
  }
});

test('a daytime subway trip waits the headway only', () => {
  const now = at(FIRST_DAY, '14:00');
  const validFrom = at(FIRST_DAY, '05:00');
  const evidence = timetableHeadwayEvidence(nextDay(), validFrom, validFrom + DAY, now)!;
  for (const route of [subwayRoute(now, [source(evidence)]), subwayRoute(now, [source()])]) {
    assert.ok(route);
    const wait = waitOf(route);
    assert.ok(wait > 0 && wait <= 4 * MINUTE / 1000 + 10, `waits ${wait} s`);
    const arrival = estimateBaseTimeline(route.segments, now)!.arrivalAt;
    assert.ok(arrival - now <= 30 * MINUTE, `arrives ${(arrival - now) / MINUTE} minutes later`);
  }
});
