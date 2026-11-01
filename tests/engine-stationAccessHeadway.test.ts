// Engine and shared-timing cases from mvp/tests/stationAccessHeadway.test.ts (the app-client check lives there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { normalizeTransit, type RouteProvider } from '../src/common/engine/kakao.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { stationAccessSeconds } from '../src/common/engine/connectivity/station-access.js';
import { enrichTransitRoutes } from '../src/common/engine/transit-enrichment.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import {
  DEFAULT_PREFERENCES,
  planBaseRoutes,
  type BaseRoute,
  type HeadwayEvidence,
  type Place,
  type Provenance,
} from '../src/common/shared/domain/index.js';

// Station entry (gate to platform) and dated headway evidence meet at the boarding wait: the wait is read at the
// clock the rider reaches the platform, after the entry segment, never at the street point of the station.
const KST = 9 * 3_600_000;
/** Wednesday 2026-10-28 08:47:40 KST: a reviewed weekday. */
const NOW = Date.UTC(2026, 9, 27, 23, 47, 40);
const kst = (hours: number, minutes = 0) => Date.UTC(2026, 9, 28, hours, minutes) - KST;
const origin: Place = {
  id: 'origin',
  name: '서울로7017',
  address: '서울',
  latitude: 37.556,
  longitude: 126.969,
};
const destination: Place = {
  id: 'destination',
  name: '강남역 사거리',
  address: '서울',
  latitude: 37.4975,
  longitude: 127.0285,
};
const station: [number, number] = [126.97264, 37.55303];
const alight: [number, number] = [127.02764, 37.49794];
const transitPayload = {
  status: 'OK',
  routes: [
    {
      properties: { type: 'SUBWAY', totalDistance: 15_000, totalTime: 2_000, transfers: 0 },
      steps: [
        {
          properties: {
            type: 'SUBWAY',
            guidance: '4호선 (서울역 > 사당)',
            distance: 15_000,
            time: 1_500,
            stops: [{ name: '서울역' }, { name: '숙대입구(서울시교육청)' }, { name: '사당' }],
            vehicles: [{ name: '4호선', type: '일반' }],
          },
          path: { points: [station, [127.0, 37.52], alight] },
        },
      ],
    },
  ],
};
const provider: RouteProvider = {
  configured: true,
  searchPlaces: async () => [],
  transit: async () => [],
  walking: async () => {
    throw new Error('no walking call in this fixture');
  },
};
const request = {
  origin,
  destination,
  now: NOW,
  deadline: NOW + 2 * 3_600_000,
  preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
};
const provenance: Provenance = {
  mode: 'live',
  provider: 'kakao',
  label: '카카오 경로',
  sourceTimestamp: null,
  receivedAt: NOW,
  isRealtime: false,
};
const evidence = (windows: HeadwayEvidence['windows']): HeadwayEvidence => ({
  version: 1,
  basis: 'published-timetable',
  derivedAt: NOW,
  windows,
});
const modes = (route: Pick<BaseRoute, 'segments'>) => route.segments.map((segment) => segment.mode);

async function enrichedRail() {
  const [rail] = await enrichTransitRoutes(
    normalizeTransit(transitPayload, { origin, destination }),
    { origin, destination },
    // Platform-point gates (no numbered exit): this file times the wait, engine-stationExits covers exits.
    { provider, budget: new CallBudget(), now: NOW, maxAccessCalls: 0, stationExits: null },
  );
  assert.deepEqual(modes(rail), ['walk', 'entry', 'wait', 'subway', 'entry', 'walk']);
  const walk = rail.segments[0].durationSeconds,
    entry = rail.segments[1].durationSeconds;
  assert.deepEqual(entry, {
    min: stationAccessSeconds('서울역', '4호선', 'entry', NOW).seconds,
    max: stationAccessSeconds('서울역', '4호선', 'entry', NOW).seconds,
  });
  // The street point is reached by NOW + walk.max; the platform no earlier than NOW + walk.min + entry.
  const street = NOW + walk.max * 1000,
    platform = NOW + (walk.min + entry.min) * 1000;
  assert.ok(
    platform - street >= 2000,
    'the fixture needs a gap between the latest street clock and the earliest platform clock',
  );
  return { rail, boundary: Math.floor((street + platform) / 2000) * 1000 };
}
const withEvidence = (route: BaseRoute, headwayEvidence: HeadwayEvidence): BaseRoute => ({
  ...route,
  segments: route.segments.map((segment) =>
    segment.mode === 'subway' ? { ...segment, headwayEvidence } : segment,
  ),
});
function plan(base: BaseRoute) {
  const graph = planJourneyGraph(request, [base], {
    receivedAt: NOW,
    maxResults: 4,
    objective: 'estimated-arrival',
  });
  return planBaseRoutes(request, graph.routes, provenance, {
    maxRoutes: 4,
    objective: 'estimated-arrival',
  });
}

test('the headway window in force when the rider reaches the platform, after the entry segment, sets the wait', async () => {
  const { rail, boundary } = await enrichedRail();
  // A 15-minute wait applies until `boundary`, which falls after the street clock and before the platform clock.
  const base = withEvidence(
    rail,
    evidence([
      { from: kst(8, 30), to: boundary, waitSeconds: 900, headwaySeconds: 1800 },
      { from: boundary, to: kst(14, 30), waitSeconds: 90, headwaySeconds: 180 },
    ]),
  );
  const planned = plan(base);
  const route = planned.routes.find((candidate) =>
    candidate.segments.some((segment) => segment.mode === 'subway'),
  )!;
  assert.ok(route, 'the rail route stays a candidate');
  assert.deepEqual(
    modes(route).filter((mode) => mode !== 'walk'),
    ['entry', 'wait', 'subway', 'entry'],
  );
  const wait = route.segments.find((segment) => segment.mode === 'wait')!;
  assert.deepEqual(
    wait.durationSeconds,
    { min: 90, max: 90 },
    'the platform clock reads the 90 s window, not the 900 s one at the street',
  );
  const estimate = estimateBaseTimeline(route.segments, NOW)!;
  assert.equal(
    estimate.components.find((component) => component.segmentId === wait.id)?.seconds,
    90,
  );
});

test('evidence that ends between the street and the platform clock leaves the rider no train', async () => {
  const { rail, boundary } = await enrichedRail();
  const base = withEvidence(
    rail,
    evidence([
      { from: kst(8, 30), to: boundary, waitSeconds: 120, headwaySeconds: 240 },
      { from: boundary, to: kst(14, 30), waitSeconds: null, headwaySeconds: null },
    ]),
  );
  // Read at the street clock the last train would still run; at the platform clock the service has ended.
  const planned = plan(base);
  assert.equal(
    planned.routes.some((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'subway'),
    ),
    false,
  );
  assert.equal(estimateBaseTimeline(base.segments, NOW), null);
});
