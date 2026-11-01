// Regression cases from mvp/tests/railGateTimeline.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import {
  applyRailGateEnvelope,
  type RailGatePredictor,
} from '../src/common/engine/intelligence/rail-gate-service.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Place,
  SubwayTimetable,
} from '../src/common/shared/domain/types.js';

const now = Date.parse('2026-10-16T12:00:00+09:00');
const point = (name: string, latitude: number): Place => ({
  id: name,
  name,
  address: '',
  latitude,
  longitude: 126.97,
});
const origin = point('출발', 37.55),
  station = point('서울역', 37.56),
  destination = point('종로3가', 37.57);
const request: BasePlanningRequest = {
  origin,
  destination,
  now,
  deadline: now + 3_600_000,
  preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
};
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '공개 시간표',
  receivedAt: now,
  sourceTimestamp: null,
  isRealtime: false,
};
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: id,
  start,
  end,
  distanceMeters: start === end ? 0 : 300,
  polyline: [start, end],
  runAllowed: false,
  durationSeconds: { min: seconds, max: seconds },
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
const timetable: SubwayTimetable = {
  provider: 'seoul-metro-timetable',
  serviceDate: '2026-10-16',
  dayType: 'weekday',
  receivedAt: now,
  validFrom: Date.parse('2026-10-16T05:00:00+09:00'),
  validUntil: Date.parse('2026-10-17T05:00:00+09:00'),
  calendarSource: 'official-fixture',
  line: '1호선',
  boardingStation: station.name,
  nextStation: '시청',
  alightingStation: destination.name,
  complete: true,
  departures: [180, 600].map((seconds, index) => ({
    departureAt: now + seconds * 1000,
    arrivalAt: now + (seconds + 300) * 1000,
    trainNo: `K${index}`,
    direction: '1',
    destination: destination.name,
  })),
};
const sources = [
  route('rail', [
    leg('access', 'walk', origin, station, 80),
    leg('fixed-platform-delay', 'wait', station, station, 20),
    {
      ...leg('rail', 'subway', station, destination, 300),
      lineName: '1호선',
      transit: { lines: ['1호선'], stops: [station.name, '시청', destination.name] },
      timetable,
    },
  ]),
  route('walking', [leg('direct', 'walk', origin, destination, 1200)]),
];
const predictor =
  (upperSeconds: number): RailGatePredictor =>
  () => ({
    modelVersion: 'seoul-rail-gate-v1',
    target: 'rail-gate-elapsed',
    lowerSeconds: 200,
    medianSeconds: 420,
    upperSeconds,
  });

// Live regression 10/29: widening a timetable subway leg made the timetable check reject the whole route.
test('a subway envelope on a timetable ride keeps the route and only delays its latest arrival', () => {
  for (const objective of ['estimated-arrival', 'conservative-arrival'] as const) {
    const graph = planJourneyGraph(request, sources, { receivedAt: now, objective, maxResults: 2 });
    const plain = planBaseRoutes(request, graph.routes, provenance, { objective }).routes;
    const railPlain = plain.find((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'subway'),
    )!;
    const enveloped = applyRailGateEnvelope(graph.routes, request, predictor(900));
    const ride = enveloped
      .flatMap((candidate) => candidate.segments)
      .find((segment) => segment.mode === 'subway')!;
    assert.ok(ride.railEtaPrediction, 'the envelope is attached to the subway leg');
    const extra = ride.durationSeconds.max - ride.railEtaPrediction!.sourceDurationSeconds.max;
    assert.ok(extra > 0);
    const planned = planBaseRoutes(request, enveloped, provenance, { objective }).routes;
    assert.deepEqual(
      planned.map((candidate) => candidate.id),
      plain.map((candidate) => candidate.id),
      'same routes in the same order',
    );
    const rail = planned.find((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'subway'),
    )!;
    assert.equal(rail.arrivalTime.earliest, railPlain.arrivalTime.earliest);
    assert.equal(rail.arrivalTime.latest, railPlain.arrivalTime.latest + extra * 1000);
    const source = graph.routes.find((candidate) => candidate.id === rail.id)!;
    assert.equal(
      estimateBaseTimeline(enveloped.find((candidate) => candidate.id === rail.id)!.segments, now)
        ?.arrivalAt,
      estimateBaseTimeline(source.segments, now)?.arrivalAt,
      'the estimate keeps the timetable arrival',
    );
  }
});

test('no envelope when the model upper bound is inside the plan or a timed boarding follows the run', () => {
  const graph = planJourneyGraph(request, sources, {
    receivedAt: now,
    objective: 'estimated-arrival',
    maxResults: 2,
  });
  assert.deepEqual(applyRailGateEnvelope(graph.routes, request, predictor(60)), graph.routes);
  const rail = graph.routes.find((candidate) =>
    candidate.segments.some((segment) => segment.mode === 'subway'),
  )!;
  const timedAfter: BaseRoute = {
    ...rail,
    segments: [
      ...rail.segments,
      {
        ...leg('bus-wait', 'wait', destination, destination, 0),
        plannedConnection: {
          departureAt: now + 3_000_000,
          fallbackDepartureAt: now + 3_100_000,
          status: 'comfortable',
          boardingMarginSeconds: 60,
          explanation: '시간표 승차',
        },
      },
    ],
  };
  const [result] = applyRailGateEnvelope([timedAfter], request, predictor(900));
  assert.equal(
    result.segments.some((segment) => segment.railEtaPrediction),
    false,
  );
});
