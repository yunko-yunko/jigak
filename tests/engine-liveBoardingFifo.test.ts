// Regression cases from mvp/tests/liveBoardingFifo.test.ts. The app's client is not part of this package, so the
// app's acceptance is checked through the same shared re-derivation it runs (evaluateBaseTimeline per route).
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
  continuationEdges,
  nextUnlistedDeparture,
  unlistedWaitRange,
} from '../src/common/shared/domain/liveBoarding.js';
import { evaluateBaseTimeline, selectLiveBoarding } from '../src/common/shared/domain/routing.js';
import { TIMETABLE_BOARDING_BUFFER_SECONDS } from '../src/common/shared/domain/waitEstimates.js';
import type {
  BaseRoute,
  BaseSegment,
  BoardingRealtime,
  Place,
  SubwayTimetable,
} from '../src/common/shared/domain/types.js';

// Re-audit 2 R1: the continuation past an arrival list must be FIFO. A rider who reaches the stop earlier can always
// wait for the vehicle a later rider boards, so a later clock never departs earlier — not even where the headway
// rule shortens (06:00, 07:00, 17:30) or a published timetable starts.

const MINUTE = 60_000,
  HOUR = 3_600_000;
/** 00:00 KST on 2026-10-13. */
const DAY = Date.parse('2026-10-13T00:00:00+09:00');
const place = (id: string, metres: number, east = 0): Place => ({
  id,
  name: id,
  address: '서울',
  latitude: 37.55 + metres / 111195,
  longitude: 126.97 + east / 88000,
});
const origin = place('O', 0),
  stop = place('A', 500),
  destination = place('D', 6000);
const preferences = { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 };
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
type Mode = 'bus' | 'subway';
const feed = (mode: Mode, now: number, arrivals: number[]): BoardingRealtime => ({
  provider: mode === 'bus' ? 'seoul-bus' : 'seoul-subway',
  status: 'live',
  stopName: 'A',
  observedAt: now,
  receivedAt: now,
  predictions: arrivals.map((arrivesAt) => ({ line: '100', message: '', arrivesAt })),
});
const vehicle = (mode: Mode, extra: Partial<BaseSegment> = {}) =>
  leg('ride', mode, stop, destination, 600, 600, {
    transit: { lines: [mode === 'bus' ? '100' : '2호선'], stops: ['A', 'T', 'D'] },
    ...extra,
  });
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '공급원',
  receivedAt: 0,
  sourceTimestamp: null,
  isRealtime: false,
};
/** The app re-derives every route's timeline through the shared code and rejects the whole result on any mismatch. */
function appAccepts(
  now: number,
  wire: {
    routes: {
      segments: readonly BaseSegment[];
      arrivalTime: { earliest: number; latest: number };
    }[];
  },
) {
  return wire.routes.every((value) => {
    const timeline = evaluateBaseTimeline(
      value.segments.map((segment) => ({
        ...segment,
        plannedConnection:
          segment.plannedConnection ??
          ('connection' in segment
            ? (segment as { connection?: BaseSegment['plannedConnection'] }).connection
            : undefined),
      })),
      now,
    );
    const last = timeline?.at(-1);
    return (
      !!last &&
      last.earliest === value.arrivalTime.earliest &&
      last.latest === value.arrivalTime.latest &&
      !!estimateBaseTimeline(value.segments, now)
    );
  });
}
const requestAt = (now: number) => ({
  origin,
  destination,
  now,
  deadline: now + 2 * HOUR,
  preferences,
});
function wireOf(now: number, sources: BaseRoute[], graph: boolean) {
  const request = requestAt(now);
  const result = planBaseRoutes(
    request,
    graph
      ? planJourneyGraph(request, sources, { receivedAt: now, objective: 'estimated-arrival' })
          .routes
      : sources,
    { ...provenance, receivedAt: now },
    { objective: 'estimated-arrival' },
  );
  const intelligence = rankRouteIntelligence(result.routes, request, {
    objective: 'estimated-arrival',
  });
  for (const value of result.routes) value.recommended = value.id === intelligence.recommendationId;
  return { ...result, intelligence };
}
const isTransit = (value: { segments: readonly BaseSegment[] }) =>
  value.segments.some((segment) => segment.mode === 'bus' || segment.mode === 'subway');
/** The walk to the stop, then the ride on a live list whose only vehicle leaves `listedAt`. */
const liveRoute = (mode: Mode, now: number, listedAt: number, access: [number, number]) =>
  route('live', [
    leg('walk', 'walk', origin, stop, ...access),
    vehicle(mode, { realtime: feed(mode, now, [listedAt]) }),
  ]);
/** A provider route with its own expected wait, as the planner receives it when the graph is not used. */
const providerRoute = (mode: Mode, now: number, listedAt: number, access: [number, number]) =>
  route('provider', [
    leg('walk', 'walk', origin, stop, ...access),
    leg('provider-expected-wait', 'wait', stop, stop, 480, 480),
    vehicle(mode, { realtime: feed(mode, now, [listedAt]) }),
  ]);
const walkOnly = route('walk-only', [leg('walk-only', 'walk', origin, destination, 4000)]);

/** Deterministic random clocks so a failure reproduces. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const serviceDate = '2026-10-13',
  validFrom = Date.parse(`${serviceDate}T05:00:00+09:00`),
  TABLE_NOW = validFrom + HOUR;
/** A full service day: trains every 6–9 minutes from 05:32 to 00:32, with a long midday gap. */
function fullDayTimetable(): SubwayTimetable {
  const departures: SubwayTimetable['departures'] = [];
  for (let at = validFrom + 32 * MINUTE, index = 0; at <= validFrom + 19.5 * HOUR; index++) {
    departures.push({
      departureAt: at,
      arrivalAt: at + 900_000,
      trainNo: `T${index}`,
      direction: '1',
      destination: 'D',
    });
    at += (index % 3 === 0 ? 9 : 6) * MINUTE + (index === 60 ? 40 * MINUTE : 0);
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
    boardingStation: 'A',
    nextStation: 'T',
    alightingStation: 'D',
    complete: true,
    departures,
  };
}

test('the continuation never departs earlier for a later clock, across whole days, every rule change and timetable edge', () => {
  const table = fullDayTimetable();
  const variants: { name: string; segment: BaseSegment; listed: number[] }[] = [
    { name: 'bus, one line', segment: vehicle('bus'), listed: [] },
    {
      name: 'bus, one line, listed',
      segment: vehicle('bus'),
      listed: [DAY + 5 * HOUR + 58 * MINUTE],
    },
    {
      name: 'bus, two lines',
      segment: vehicle('bus', { transit: { lines: ['100', '200'], stops: ['A', 'T', 'D'] } }),
      listed: [DAY + 17 * HOUR + 25 * MINUTE],
    },
    { name: 'subway', segment: vehicle('subway'), listed: [] },
    { name: 'subway, listed', segment: vehicle('subway'), listed: [DAY + 6 * HOUR + 57 * MINUTE] },
    {
      name: 'subway, published timetable',
      segment: vehicle('subway', { timetable: table }),
      listed: [],
    },
    {
      name: 'subway, published timetable, listed',
      segment: vehicle('subway', { timetable: table }),
      listed: [validFrom + 40 * MINUTE],
    },
  ];
  const from = DAY - 2 * HOUR,
    to = DAY + 50 * HOUR;
  let checked = 0;
  for (const [index, { name, segment, listed }] of variants.entries()) {
    const live = listed.length ? feed(segment.mode as Mode, TABLE_NOW, listed) : undefined;
    const next = random(index + 1);
    const clocks: number[] = [];
    for (let count = 0; count < 4000; count++) clocks.push(from + Math.floor(next() * (to - from)));
    for (const edge of [
      ...continuationEdges(segment, from, to),
      ...(segment.timetable?.departures.map(
        (row) => row.departureAt - TIMETABLE_BOARDING_BUFFER_SECONDS * 1000,
      ) ?? []),
    ]) {
      for (const offset of [
        -600_000, -300_000, -120_000, -61_000, -1000, -1, -0.001, 0, 0.001, 1, 1000, 60_000,
      ])
        clocks.push(edge + offset);
    }
    clocks.sort((a, b) => a - b);
    let previous: { at: number; departureAt: number } | null = null;
    for (const at of clocks) {
      const departure = nextUnlistedDeparture(segment, live, at, TABLE_NOW);
      if (!departure) continue;
      // A published train is timed from the platform (the station entry precedes it); other continuations keep the live buffer.
      const buffer =
        departure.basis === 'published-departure'
          ? TIMETABLE_BOARDING_BUFFER_SECONDS * 1000
          : segment.mode === 'bus'
            ? 30_000
            : 60_000;
      assert.ok(
        departure.departureAt >= at + buffer,
        `${name}: boards after reaching the stop at ${new Date(at).toISOString()}`,
      );
      if (live && departure.basis === 'published-departure')
        assert.ok(
          departure.departureAt > Math.max(...listed),
          `${name}: a published continuation leaves after the listed vehicles`,
        );
      if (previous)
        assert.ok(
          departure.departureAt >= previous.departureAt,
          `${name}: ${new Date(previous.at).toISOString()} departs ${new Date(previous.departureAt).toISOString()} but later ${new Date(at).toISOString()} departs ${new Date(departure.departureAt).toISOString()}`,
        );
      previous = { at, departureAt: departure.departureAt };
      checked++;
    }
    // The piece-edge probes still bound the wait of every clock in a range.
    for (let count = 0; count < 300; count++) {
      const after = from + Math.floor(next() * (to - from)),
        until = after + Math.floor(next() * 40 * MINUTE);
      const range = unlistedWaitRange(segment, live, after, until, TABLE_NOW, true);
      if (!range) continue;
      for (let sample = 0; sample < 20; sample++) {
        const at = after + Math.floor(next() * (until - after + 1));
        const wait = Math.ceil(
          (nextUnlistedDeparture(segment, live, at, TABLE_NOW)!.departureAt - at) / 1000,
        );
        assert.ok(
          wait >= range.min && wait <= range.max,
          `${name}: wait ${wait} s at ${new Date(at).toISOString()} outside ${range.min}–${range.max}`,
        );
      }
    }
  }
  assert.ok(checked > 25_000);
});

test('the continuation edges are the rule changes and the timetable validity edges', () => {
  assert.deepEqual(
    continuationEdges(vehicle('bus'), DAY, DAY + 86_400_000).map((edge) => (edge - DAY) / MINUTE),
    [360, 420, 570, 1050, 1200, 1320],
  );
  const table = fullDayTimetable();
  assert.deepEqual(
    continuationEdges(vehicle('subway', { timetable: table }), DAY + 4 * HOUR, DAY + 7 * HOUR).map(
      (edge) => (edge - DAY) / MINUTE,
    ),
    [300, 330, 360, 420],
  );
  assert.deepEqual(
    continuationEdges(vehicle('bus'), DAY + 360 * MINUTE, DAY + 420 * MINUTE - 1),
    [],
    'the start is excluded, the end included',
  );
});

// P8 from the re-audit: at 05:40 one listed bus leaves at +60 s and the walk reaches the stop between 05:58:30 and
// 06:00:01. Before the fix the 05:58:30 clock departed 06:06:30 (480 s rule) and the 06:00:01 clock 06:06:01 (360 s).
test('P8: a walk across 06:00 that misses the listed bus keeps an ordered boarding and the bus route', () => {
  const now = DAY + 5 * HOUR + 40 * MINUTE,
    listedAt = now + 60_000;
  const selected = selectLiveBoarding(
    vehicle('bus', { realtime: feed('bus', now, [listedAt]) }),
    { earliest: now + 1_110_000, latest: now + 1_201_000 },
    now,
  )!;
  assert.equal(selected.boardsListed, false);
  assert.deepEqual(
    selected.departure,
    { earliest: now + 1_560_000, latest: now + 1_561_000 },
    'the 05:58:30 rider waits for the 06:06 bus',
  );
  assert.deepEqual(selected.wait, { min: 360, max: 450 });
  assert.equal(selected.connection.status, 'borderline');

  const graph = wireOf(now, [liveRoute('bus', now, listedAt, [1110, 1201]), walkOnly], true);
  const bus = graph.routes.find(isTransit)!;
  assert.ok(bus, 'the graph keeps the bus');
  assert.equal(graph.routes[0], bus);
  assert.deepEqual(bus.durationSeconds, { min: 2160, max: 2161 });
  const planner = wireOf(now, [providerRoute('bus', now, listedAt, [1110, 1201])], false);
  assert.deepEqual(planner.routes[0].durationSeconds, { min: 2160, max: 2161 });
  for (const wire of [graph, planner]) {
    assert.ok(appAccepts(now, wire));
    assert.ok(isTransit(wire.routes[0]));
    assert.deepEqual(wire.routes[0].arrivalTime, {
      earliest: now + 2_160_000,
      latest: now + 2_161_000,
    });
  }
  // The point estimate reads the same envelope: reaching the stop at 05:58:30 boards the 06:06 bus.
  assert.deepEqual(
    liveBoardingEstimate(vehicle('bus'), feed('bus', now, [listedAt]), now + 1_110_000, now),
    { seconds: 450, basis: 'wait-rule' },
  );
});

const RULE_BOUNDARIES: [string, number][] = [
  ['06:00', 360],
  ['07:00', 420],
  ['09:30', 570],
  ['17:30', 1050],
  ['20:00', 1200],
  ['22:00', 1320],
];
for (const mode of ['bus', 'subway'] as const) {
  test(`a ${mode} boarding across each rule change stays ordered, kept by the graph and accepted by the app`, () => {
    for (const [label, minute] of RULE_BOUNDARIES) {
      const boundary = DAY + minute * MINUTE,
        now = boundary - 20 * MINUTE,
        listedAt = now + 60_000,
        seconds = (at: number) => (at - now) / 1000;
      for (const [before, after] of [
        [10, 1],
        [50, 1],
        [80, 1],
        [110, 1],
        [30, 30],
        [1, 60],
      ]) {
        const access: [number, number] = [seconds(boundary) - before, seconds(boundary) + after],
          name = `${mode} ${label} reach ${access.join('–')} s`;
        const selected = selectLiveBoarding(
          vehicle(mode, { realtime: feed(mode, now, [listedAt]) }),
          { earliest: now + access[0] * 1000, latest: now + access[1] * 1000 },
          now,
        );
        assert.ok(selected, name);
        assert.equal(selected.boardsListed, false, name);
        assert.ok(
          selected.departure.latest >= selected.departure.earliest,
          `${name}: ${seconds(selected.departure.earliest)}..${seconds(selected.departure.latest)}`,
        );
        const graph = wireOf(now, [liveRoute(mode, now, listedAt, access), walkOnly], true);
        const transit = graph.routes.find(isTransit);
        assert.ok(transit, `${name}: the graph keeps the ${mode}`);
        assert.equal(graph.routes[0], transit, name);
        assert.ok(evaluateBaseTimeline(transit.segments, now), name);
        assert.ok(estimateBaseTimeline(transit.segments, now), name);
        const planner = wireOf(now, [providerRoute(mode, now, listedAt, access)], false);
        assert.equal(planner.routes.length, 1, name);
        assert.ok(
          planner.routes[0].arrivalTime.latest >= planner.routes[0].arrivalTime.earliest,
          name,
        );
        for (const wire of [graph, planner]) assert.ok(appAccepts(now, wire), name);
      }
    }
  });
}
