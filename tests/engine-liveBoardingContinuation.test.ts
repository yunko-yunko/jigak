// Regression cases from mvp/tests/liveBoardingContinuation.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { rankRouteIntelligence } from '../src/common/engine/intelligence/arrival.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import {
  estimateBaseTimeline,
  liveBoardingEstimate,
} from '../src/common/shared/domain/estimatedTiming.js';
import {
  evaluateBaseTimeline,
  LIVE_MISSED_HEADWAY_EXPLANATION,
  LIVE_TIMETABLE_FALLBACK_EXPLANATION,
  selectLiveBoarding,
} from '../src/common/shared/domain/routing.js';
import {
  nextUnlistedDeparture,
  unlistedHeadway,
} from '../src/common/shared/domain/liveBoarding.js';
import { journeyReferenceFeaturesForRoute } from '../src/common/engine/intelligence/journey-reference.js';
import type {
  BaseRoute,
  BaseSegment,
  BoardingRealtime,
  Place,
  SubwayTimetable,
} from '../src/common/shared/domain/types.js';
import { expectedWaitSeconds } from '../src/common/shared/domain/waitEstimates.js';

// 14:00 KST: off-peak, so one bus line waits 360 s and a subway 210 s on the headway rule.
const NOW = Date.parse('2026-10-12T05:00:00Z');
const place = (id: string, metres: number, east = 0): Place => ({
  id,
  name: id,
  address: '서울',
  latitude: 37.55 + metres / 111195,
  longitude: 126.97 + east / 88000,
});
const origin = place('O', 0),
  stop = place('A', 500),
  destination = place('D', 6000),
  station = place('S', 0, 300);
const preferences = { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 };
const request = { origin, destination, now: NOW, deadline: NOW + 7_200_000, preferences };
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '공급원',
  receivedAt: NOW,
  sourceTimestamp: null,
  isRealtime: false,
};
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  min: number,
  max = min,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: id,
  start,
  end,
  distanceMeters: start === end ? 0 : 400,
  durationSeconds: { min, max },
  runAllowed: false,
  ...(start === end ? {} : { polyline: [start, end] }),
  ...extra,
});
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: 0,
  durationSeconds: segments.reduce(
    (sum, segment) => ({
      min: sum.min + segment.durationSeconds.min,
      max: sum.max + segment.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});
const feed = (
  provider: 'seoul-bus' | 'seoul-subway',
  seconds: number[],
  lastService = false,
): BoardingRealtime => ({
  provider,
  status: 'live',
  stopName: 'A',
  observedAt: NOW,
  receivedAt: NOW,
  predictions: seconds.map((value, index) => ({
    line: '100',
    message: '',
    arrivesAt: NOW + value * 1000,
    ...(lastService && index === seconds.length - 1 ? { lastService } : {}),
  })),
});
/** The walk's slower bound (540 s + 30 s boarding) misses both listed buses; its expected 510 s catches the 540 s bus. */
const busRoute = (realtime = feed('seoul-bus', [240, 540])) =>
  route('bus', [
    leg('access', 'walk', origin, stop, 480, 540),
    leg('ride', 'bus', stop, destination, 600, 600, {
      realtime,
      transit: { lines: ['100'], stops: ['A', 'D'] },
    }),
  ]);
const subwayRoute = () =>
  route('subway', [
    leg('access-2', 'walk', origin, station, 300),
    leg('train', 'subway', station, destination, 900, 900, {
      realtime: feed('seoul-subway', [420, 780]),
      transit: { lines: ['2호선'], stops: ['S', 'D'] },
    }),
  ]);
const graphRoutes = (sources: BaseRoute[]) =>
  planJourneyGraph(request, sources, { receivedAt: NOW, objective: 'estimated-arrival' }).routes;
const boardingWait = <T extends BaseSegment>(segments: readonly T[]) =>
  segments.find((segment) => segment.mode === 'wait' && segment.plannedConnection)!;
const serviceDate = '2026-10-12',
  validFrom = Date.parse(`${serviceDate}T05:00:00+09:00`);
const timetable = (seconds: number[]): SubwayTimetable => ({
  provider: 'seoul-metro-timetable',
  serviceDate,
  dayType: 'weekday',
  receivedAt: NOW,
  validFrom,
  validUntil: validFrom + 86_400_000,
  calendarSource: 'fixture',
  line: '2호선',
  boardingStation: 'S',
  nextStation: 'T',
  alightingStation: 'D',
  complete: true,
  departures: seconds.map((value, index) => ({
    departureAt: NOW + value * 1000,
    arrivalAt: NOW + (value + 900) * 1000,
    trainNo: `T${index}`,
    direction: '1' as const,
    destination: 'D',
  })),
});
const timedSubway = (listed: number[], published: number[]) =>
  route('subway', [
    leg('access', 'walk', origin, station, 450, 600),
    leg('train', 'subway', station, destination, 900, 900, {
      realtime: feed('seoul-subway', listed),
      timetable: timetable(published),
      transit: { lines: ['2호선'], stops: ['S', 'T', 'D'] },
    }),
  ]);
/** The server's own composition: graph → planner → intelligence. */
function serverResult(sources: BaseRoute[], graph = true) {
  const result = planBaseRoutes(request, graph ? graphRoutes(sources) : sources, provenance, {
    objective: 'estimated-arrival',
  });
  const intelligence = rankRouteIntelligence(result.routes, request, {
    objective: 'estimated-arrival',
  });
  return { routes: result.routes, intelligence };
}
/** The app re-derives every live timeline through the same shared selector. */
const revalidated = (segments: readonly BaseSegment[]) =>
  evaluateBaseTimeline(
    segments.map((segment) => ({
      ...segment,
      plannedConnection:
        segment.plannedConnection ??
        ('connection' in segment
          ? (segment as { connection?: BaseSegment['plannedConnection'] }).connection
          : undefined),
    })),
    NOW,
  )?.at(-1);

// Judged cause 4: the conservative clock must not decide which vehicle the estimate rides.
test('a graph search keeps the listed bus for the estimate when only the conservative clock misses it', () => {
  const routes = graphRoutes([busRoute(), subwayRoute()]);
  const bus = routes.find((value) => value.segments.some((segment) => segment.mode === 'bus'))!;
  const wait = boardingWait(bus.segments);
  assert.equal(expectedWaitSeconds(bus.segments.at(-1)!, NOW + 540_000), 360);
  // The next unlisted bus cannot run before one headway (2 × 360 s) after the last listed 540 s bus.
  assert.deepEqual(wait.plannedConnection, {
    departureAt: NOW + 540_000,
    fallbackDepartureAt: NOW + 1_260_000,
    status: 'borderline',
    boardingMarginSeconds: -30,
    explanation: wait.plannedConnection!.explanation,
  });
  assert.deepEqual(wait.durationSeconds, { min: 30, max: 750 });
  assert.deepEqual(bus.durationSeconds, { min: 1140, max: 1860 });
  const estimate = estimateBaseTimeline(bus.segments, NOW)!;
  assert.equal(
    (estimate.arrivalAt - NOW) / 1000,
    1140,
    'not 1470: the expected 510 s walk boards the 540 s bus',
  );
  assert.equal(
    estimate.components.find((part) => part.segmentId === wait.id)!.basis,
    'live-departure',
  );
  assert.equal(routes[0], bus, 'the bus beats the 1320 s subway again');
});

test('graph, planner, intelligence and re-validation agree on a live boarding continued past the list', () => {
  const selected = selectLiveBoarding(
    busRoute().segments[1],
    { earliest: NOW + 480_000, latest: NOW + 540_000 },
    NOW,
  )!;
  assert.equal(selected.headwayFallback, true);
  assert.equal(selected.continuation, 'wait-rule');
  assert.deepEqual(selected.departure, { earliest: NOW + 540_000, latest: NOW + 1_260_000 });
  for (const graph of [true, false]) {
    const { routes, intelligence } = serverResult(
      graph ? [busRoute(), subwayRoute()] : [busRoute()],
      graph,
    );
    const first = routes.find((value) => value.id === intelligence.recommendationId)!;
    assert.ok(
      first.segments.some((segment) => segment.mode === 'bus'),
      `graph=${graph}`,
    );
    assert.equal(
      intelligence.assessments.find((value) => value.routeId === first.id)!.estimatedSeconds,
      1140,
    );
    assert.deepEqual(first.arrivalTime, { earliest: NOW + 1_140_000, latest: NOW + 1_860_000 });
    assert.deepEqual(revalidated(first.segments), first.arrivalTime);
  }
});

// Judged cause 3: time passing alone never removes an estimate, and age never switches the boarded vehicle.
test('the point estimate continues one headway after the last listed vehicle once every listed vehicle is missed', () => {
  const bus = graphRoutes([busRoute()])[0];
  const wait = boardingWait(bus.segments);
  for (const at of [NOW + 60_000, NOW + 130_000]) {
    const component = estimateBaseTimeline(bus.segments, at)!.components.find(
      (part) => part.segmentId === wait.id,
    )!;
    assert.equal(component.basis, 'wait-rule');
    assert.equal(component.arrivalAt, NOW + 1_260_000, 'max(clock + 360 s, 540 s + 2 × 360 s)');
  }
});

// Audit P1: an aged single-bus list must not let a rule wait board earlier than the listed bus.
test('an aged list never lets the estimate board before its still-catchable vehicle', () => {
  const bus = route('bus', [
    leg('access', 'walk', origin, stop, 60),
    leg('ride', 'bus', stop, destination, 600, 600, {
      realtime: feed('seoul-bus', [900]),
      transit: { lines: ['100'], stops: ['A', 'D'] },
    }),
  ]);
  const walk = route('walk', [leg('walk-only', 'walk', origin, destination, 1300)]);
  const { routes } = serverResult([bus, walk]);
  const busRoute = routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'bus'),
  )!;
  for (const seconds of [0, 60, 119, 121, 130, 180]) {
    const estimate = estimateBaseTimeline(busRoute.segments, NOW + seconds * 1000)!;
    assert.equal(estimate.arrivalAt, NOW + 1_500_000, `${seconds}s: the 900 s bus still binds`);
  }
});

// Audit P2: a subway with a matching published timetable continues on that timetable, not on the headway rule.
test('a live subway whose slower access misses the list continues on the published timetable', () => {
  const walk = route('walk', [leg('walk-only', 'walk', origin, destination, 1900)]);
  const { routes, intelligence } = serverResult([
    timedSubway([240, 540], [240, 540, 1200, 1800]),
    walk,
  ]);
  const train = routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'subway'),
  )!;
  const wait = boardingWait(train.segments);
  assert.deepEqual(wait.plannedConnection, {
    departureAt: NOW + 540_000,
    fallbackDepartureAt: NOW + 1_200_000,
    status: 'borderline',
    boardingMarginSeconds: -120,
    explanation: LIVE_TIMETABLE_FALLBACK_EXPLANATION,
    fallbackArrivalAt: NOW + 2_100_000,
  });
  assert.deepEqual(wait.durationSeconds, { min: 60, max: 720 });
  assert.deepEqual(train.durationSeconds, { min: 1440, max: 2100 });
  const estimate = estimateBaseTimeline(train.segments, NOW)!;
  assert.equal(estimate.arrivalAt, NOW + 2_100_000);
  assert.equal(
    estimate.components.find((part) => part.segmentId === wait.id)!.basis,
    'published-departure',
  );
  assert.notEqual(intelligence.recommendationId, train.id, 'the 1900 s walk is faster');
  assert.deepEqual(revalidated(train.segments), train.arrivalTime);
});

// Audit F5: a last service the expected access still catches keeps the route, with the risk stated.
test('a last bus the expected walk catches keeps the route even when the slower walk misses it', () => {
  const night = () => busRoute(feed('seoul-bus', [240, 540], true));
  const selected = selectLiveBoarding(
    night().segments[1],
    { earliest: NOW + 480_000, latest: NOW + 540_000 },
    NOW,
  )!;
  assert.equal(selected.missesLastService, true);
  assert.deepEqual(selected.connection, {
    departureAt: NOW + 540_000,
    status: 'borderline',
    boardingMarginSeconds: -30,
  });
  const [bus] = graphRoutes([night()]);
  assert.deepEqual(bus.durationSeconds, { min: 1140, max: 1140 });
  assert.ok(
    bus.notes?.some((note) => note.code === 'borderline-boarding' && note.severity === 'warning'),
  );
  assert.equal(
    planJourneyGraph(request, [night()], { receivedAt: NOW, objective: 'conservative-arrival' })
      .routes.length,
    0,
  );
  assert.equal(
    graphRoutes([
      route('bus', [leg('access', 'walk', origin, stop, 500, 560), night().segments[1]]),
    ]).length,
    0,
    'an expected 530 s walk misses the last bus: nothing runs after it',
  );
  const { routes } = serverResult([night()]);
  const wait = boardingWait(routes[0].segments);
  assert.equal(wait.connection!.fallbackDepartureAt, undefined);
  assert.equal(wait.connection!.fallbackArrivalAt, undefined);
  assert.ok(routes[0].risks.some((risk) => risk.code === 'borderline-boarding'));
  assert.deepEqual(revalidated(routes[0].segments), routes[0].arrivalTime);
});

// Audit F6: the planner path checks the published service end through the shared selector.
test('the planner keeps the last published train as the slower bound instead of a headway train after the end', () => {
  const subway = timedSubway([240, 600], [240, 600]);
  const selected = selectLiveBoarding(
    subway.segments[1],
    { earliest: NOW + 450_000, latest: NOW + 600_000 },
    NOW,
  )!;
  assert.equal(selected.missesLastService, true);
  assert.deepEqual(selected.departure, { earliest: NOW + 600_000, latest: NOW + 600_000 });
  const planned = planBaseRoutes(request, [subway], provenance, { objective: 'estimated-arrival' })
    .routes[0];
  assert.deepEqual(planned.arrivalTime, { earliest: NOW + 1_500_000, latest: NOW + 1_500_000 });
  assert.ok(planned.risks.some((risk) => risk.code === 'borderline-boarding'));
  assert.equal(
    planBaseRoutes(request, [subway], provenance, { objective: 'conservative-arrival' }).routes
      .length,
    0,
  );
  assert.equal(
    liveBoardingEstimate(subway.segments[1], subway.segments[1].realtime, NOW + 560_000, NOW),
    null,
  );
});

// Audit F3: a route whose slower bound continues past the list still gets a whole-journey reference.
test('the journey reference accepts a live boarding continued past the list', () => {
  const planned = planBaseRoutes(request, graphRoutes([busRoute()]), provenance, {
    objective: 'estimated-arrival',
  }).routes[0];
  assert.equal(boardingWait(planned.segments).connection!.fallbackDepartureAt, NOW + 1_260_000);
  assert.ok(journeyReferenceFeaturesForRoute(planned, NOW, null));
});

test('only a missed last service or a published service end stops the estimate', () => {
  const night = graphRoutes([busRoute(feed('seoul-bus', [400, 900], true))])[0];
  assert.ok(estimateBaseTimeline(night.segments, NOW));
  assert.equal(estimateBaseTimeline(night.segments, NOW + 400_000), null);
  assert.equal(
    estimateBaseTimeline(night.segments, NOW + 150_000)!.components.find(
      (part) => part.segmentId === boardingWait(night.segments).id,
    )!.basis,
    'live-departure',
  );
  const train = leg('train', 'subway', station, destination, 900, 900, {
    timetable: timetable([100]),
    transit: { lines: ['2호선'], stops: ['S', 'T', 'D'] },
  });
  assert.equal(
    liveBoardingEstimate(train, feed('seoul-subway', [100]), NOW + 300_000, NOW),
    null,
    'the published last train has left',
  );
  assert.deepEqual(
    liveBoardingEstimate(
      { ...train, timetable: undefined },
      feed('seoul-subway', [100]),
      NOW + 300_000,
      NOW,
    ),
    { seconds: 220, basis: 'wait-rule' },
  );
});

test('the shared continuation reads the wait and the headway from one helper', () => {
  const vehicle = busRoute().segments[1];
  assert.deepEqual(unlistedHeadway(vehicle, NOW), { waitSeconds: 360, headwaySeconds: 720 });
  assert.deepEqual(
    nextUnlistedDeparture(vehicle, feed('seoul-bus', [240, 540]), NOW + 600_000, NOW),
    { departureAt: NOW + 1_260_000, basis: 'wait-rule' },
  );
  assert.deepEqual(
    nextUnlistedDeparture(vehicle, feed('seoul-bus', [240, 540]), NOW + 1_000_000, NOW),
    { departureAt: NOW + 1_360_000, basis: 'wait-rule' },
  );
  assert.equal(
    nextUnlistedDeparture(vehicle, feed('seoul-bus', [240, 540], true), NOW + 600_000, NOW),
    null,
  );
});

// Re-audit N1: missing every listed vehicle continues on the same shared rule as a slower bound, so a slower access
// to the same listed bus is never given an earlier next bus than a faster one.
const stopB = place('B', 500, 400);
const viaStop = (id: string, at: Place, access: [number, number], ride: number, seconds = [540]) =>
  route(id, [
    leg(`walk-${id}`, 'walk', origin, at, ...access),
    leg(`bus-${id}`, 'bus', at, destination, ride, ride, {
      realtime: { ...feed('seoul-bus', seconds), stopName: at.id },
      transit: { lines: ['100'], stops: [at.id, 'D'] },
    }),
  ]);
const busVia = <T extends { segments: readonly BaseSegment[] }>(routes: T[], id: string) =>
  routes.find((value) =>
    value.segments.some((segment) => segment.mode === 'bus' && segment.start.id === id),
  )!;

test('an access that misses every listed bus boards no earlier than one headway after the last listed one', () => {
  const vehicle = viaStop('B', stopB, [520, 530], 600).segments[1];
  const selected = selectLiveBoarding(
    vehicle,
    { earliest: NOW + 520_000, latest: NOW + 530_000 },
    NOW,
  )!;
  assert.equal(selected.boardsListed, false);
  assert.equal(selected.continuation, 'wait-rule');
  assert.deepEqual(
    selected.departure,
    { earliest: NOW + 1_260_000, latest: NOW + 1_260_000 },
    'max(c + 360 s, 540 s + 720 s)',
  );
  assert.deepEqual(selected.wait, { min: 730, max: 740 });
  assert.deepEqual(selected.connection, {
    departureAt: NOW + 1_260_000,
    status: 'comfortable',
    boardingMarginSeconds: 700,
  });
  const far = selectLiveBoarding(
    vehicle,
    { earliest: NOW + 1_000_000, latest: NOW + 1_100_000 },
    NOW,
  )!;
  assert.deepEqual(far.departure, { earliest: NOW + 1_360_000, latest: NOW + 1_460_000 });
  assert.deepEqual(far.connection, {
    departureAt: NOW + 1_360_000,
    fallbackDepartureAt: NOW + 1_460_000,
    status: 'borderline',
    boardingMarginSeconds: 230,
  });
  assert.deepEqual(far.wait, { min: 360, max: 360 });
});

test('a bus via a stop the rider surely misses never beats the bus the rider may still catch', () => {
  for (const objective of ['estimated-arrival', 'conservative-arrival'] as const) {
    const sources = [viaStop('A', stop, [480, 560], 600), viaStop('B', stopB, [520, 530], 800)];
    const routes = planJourneyGraph(request, sources, { receivedAt: NOW, objective }).routes;
    const viaA = busVia(routes, 'A'),
      viaB = busVia(routes, 'B');
    assert.deepEqual(viaA.durationSeconds, { min: 1140, max: 1860 });
    assert.deepEqual(
      viaB.durationSeconds,
      { min: 2060, max: 2060 },
      'B reaches the stop after the 540 s bus: the next one runs at 1260 s',
    );
    assert.equal(routes[0], viaA, objective);
    const waitB = boardingWait(viaB.segments);
    assert.ok(waitB.realtime, 'kept as a live boarding so the app re-derives it');
    assert.equal(waitB.plannedConnection!.explanation, LIVE_MISSED_HEADWAY_EXPLANATION);
    assert.ok(viaB.notes?.some((note) => note.code === 'unverified-schedule'));
    assert.ok(evaluateBaseTimeline(viaB.segments, NOW));
    assert.equal(estimateBaseTimeline(viaA.segments, NOW)!.arrivalAt, NOW + 1_860_000);
    assert.equal(estimateBaseTimeline(viaB.segments, NOW)!.arrivalAt, NOW + 2_060_000);
    const planned = planBaseRoutes(request, routes, provenance, { objective });
    assert.ok(
      busVia(planned.routes, 'B').risks.some((risk) => risk.code === 'unverified-schedule'),
    );
  }
  const routes = graphRoutes([
    viaStop('A', stop, [480, 560], 600),
    viaStop('B', stopB, [520, 530], 600),
  ]);
  const a = busVia(routes, 'A'),
    b = busVia(routes, 'B');
  assert.ok(
    estimateBaseTimeline(b.segments, NOW)!.arrivalAt >=
      estimateBaseTimeline(a.segments, NOW)!.arrivalAt,
  );
  assert.ok(b.durationSeconds.max >= a.durationSeconds.max);
});

test('a later access to the same listed buses never lowers the estimate or either bound', () => {
  for (const seconds of [[540], [240, 540], [300, 900]]) {
    let previous: { estimate: number; min: number; max: number } | null = null;
    for (let start = 200; start <= 1500; start += 10) {
      const [bus] = graphRoutes([viaStop('A', stop, [start, start + 40], 600, seconds)]);
      assert.ok(bus, `${seconds}@${start}`);
      assert.ok(evaluateBaseTimeline(bus.segments, NOW), `${seconds}@${start}`);
      const current = {
        estimate: estimateBaseTimeline(bus.segments, NOW)!.arrivalAt,
        min: bus.durationSeconds.min,
        max: bus.durationSeconds.max,
      };
      if (previous)
        for (const key of ['estimate', 'min', 'max'] as const)
          assert.ok(
            current[key] >= previous[key],
            `${seconds}@${start} ${key}: ${previous[key]} -> ${current[key]}`,
          );
      previous = current;
    }
  }
});

test('the planner continues past the list on the shared selector and states the unlisted vehicle', () => {
  const planned = planBaseRoutes(request, [viaStop('B', stopB, [520, 530], 600)], provenance, {
    objective: 'estimated-arrival',
  }).routes[0];
  assert.deepEqual(planned.arrivalTime, { earliest: NOW + 1_860_000, latest: NOW + 1_860_000 });
  const wait = boardingWait(planned.segments);
  assert.equal(wait.connection!.departureAt, NOW + 1_260_000);
  assert.equal(wait.connection!.explanation, LIVE_MISSED_HEADWAY_EXPLANATION);
  assert.ok(
    planned.risks.some(
      (risk) => risk.code === 'unverified-schedule' && risk.severity === 'warning',
    ),
  );
  assert.ok(journeyReferenceFeaturesForRoute(planned, NOW, null));
});
