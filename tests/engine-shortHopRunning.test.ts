// A short ride is compared only with what the rider could do instead on foot (Windows review P1-1): the walk of the same
// stretch. A run of the stretch is no such alternative, because the running cap is spent along the whole route and the
// run in place of the ride may already be spent elsewhere.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_RIDE_SAVING_SECONDS, planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.parse('2026-10-12T05:00:00Z');
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 중구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
// Points on one street: the hop is 300 m, the rest 600 m.
const O = point('출발', 0),
  A = point('가', 300),
  D = point('도착', 900);
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
const source = (id: string, segments: BaseSegment[], fareWon?: number): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((n, s) => n + s.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (n, s) => ({ min: n.min + s.durationSeconds.min, max: n.max + s.durationSeconds.max }),
    { min: 0, max: 0 },
  ),
  fareWon,
});
const request = {
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3600000,
  preferences: { ...DEFAULT_PREFERENCES, allowRunning: true, maxRunningMeters: 600 },
};
const search = (sources: BaseRoute[], options: { rankingCosts?: boolean } = {}) =>
  planJourneyGraph(request, sources, { receivedAt: NOW, maxResults: 6, ...options });
const modes = (route: BaseRoute) => route.segments.map((segment) => segment.mode);
const hop = (waitSeconds: number) =>
  source(
    'hop',
    [leg('hop-wait', 'wait', O, O, waitSeconds), leg('hop-bus', 'bus', O, A, 60)],
    1500,
  );
const restRun = () =>
  source('rest-run', [leg('rest-run', 'run', A, D, 200, { runAllowed: true })]);
const restWalk = () => source('rest-walk', [leg('rest-walk', 'walk', A, D, 440)]);
const stretchWalk = () => source('stretch', [leg('stretch-walk', 'walk', O, A, 260)]);
const stretchRun = () =>
  source('stretch-run', [leg('stretch-run', 'run', O, A, 100, { runAllowed: true })]);

test('a bus is not dropped for a run of its stretch that the running cap leaves no room for', () => {
  // The 90 s hop beats running the 300 m stretch (100 s) by less than two minutes, but the 600 m run after it
  // already uses the whole cap. Against the walk (260 s) the bus saves 170 s, so the 290 s bus route is the fastest.
  const sources = [hop(30), restRun(), restWalk(), stretchWalk(), stretchRun()];
  const result = search(sources);
  assert.deepEqual(modes(result.routes[0]), ['wait', 'bus', 'run']);
  assert.deepEqual(result.routes[0].durationSeconds, { min: 290, max: 290 });
  assert.equal(result.diagnostics.shortRides, 0);
  // The run-the-stretch alternative the old comparison used is no route at all: 900 m of running is over the cap.
  assert.equal(
    result.routes.some((route) => modes(route).join('+') === 'run+run'),
    false,
  );
  // Same answer as with the costs off: the comparison no longer costs the rider 170 s.
  const plain = search(sources, { rankingCosts: false });
  assert.deepEqual(plain.routes[0].durationSeconds, result.routes[0].durationSeconds);
});

test('with running allowed, a bus that walking its stretch nearly matches is still dropped', () => {
  // A 120 s wait leaves the hop 180 s against a 260 s walk: 80 s saved, under the two minutes asked for.
  assert.ok(260 - 180 < MIN_RIDE_SAVING_SECONDS);
  const result = search([hop(120), restRun(), restWalk(), stretchWalk(), stretchRun()]);
  assert.equal(
    result.routes.some((route) => modes(route).includes('bus')),
    false,
  );
  assert.deepEqual(modes(result.routes[0]), ['walk', 'run']);
  assert.deepEqual(result.routes[0].durationSeconds, { min: 460, max: 460 });
  assert.ok(result.diagnostics.shortRides > 0);
});

test('a run of the stretch alone, with no walk of it in the network, does not drop the bus', () => {
  // Only a running source covers O to A: there is no walk to compare with, so the ride stays, as when no foot source
  // came back at all.
  const result = search([hop(120), restRun(), restWalk(), stretchRun()]);
  assert.deepEqual(modes(result.routes[0]), ['wait', 'bus', 'run']);
  assert.deepEqual(result.routes[0].durationSeconds, { min: 380, max: 380 });
  assert.equal(result.diagnostics.shortRides, 0);
});
