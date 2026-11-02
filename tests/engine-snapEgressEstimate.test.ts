// An egress walk whose range is only its network-snap allowance: the assessment's estimate is the
// returned segments' own timeline, the one the app recomputes. Numbers from a rejected 11-02 answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rankRouteIntelligence } from '../src/common/engine/intelligence/arrival.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import type { BaseRoute, Place } from '../src/common/shared/domain/index.js';

const NOW = Date.parse('2026-11-02T00:04:59+09:00');
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '',
  latitude,
  longitude,
});
const dock = place('dock', 37.49655151, 127.0542984),
  door = place('door', 37.4979503946468, 127.053729670291);
const provenance = {
  mode: 'live' as const,
  provider: 'osrm-foot',
  label: '보행망',
  sourceTimestamp: null,
  receivedAt: NOW,
  isRealtime: false,
};

/** One routed walk: min is the path, max adds the snap allowance (the stale server scored max). */
function egress(
  id: string,
  meters: number,
  min: number,
  snap: { startMeters: number; endMeters: number; allowanceSeconds: number },
): BaseRoute {
  const duration = { min, max: min + snap.allowanceSeconds };
  return {
    id,
    title: '도보',
    distanceMeters: meters,
    durationSeconds: duration,
    transfers: 0,
    segments: [
      {
        id: `${id}-walk`,
        mode: 'walk',
        title: '도착지까지 걷기',
        instructions: `${meters}m 걸어요.`,
        distanceMeters: meters,
        durationSeconds: { ...duration },
        start: dock,
        end: door,
        runAllowed: false,
        polyline: [
          { latitude: 37.496703, longitude: 127.054224 },
          { latitude: 37.498039, longitude: 127.053686 },
        ],
        routingSource: provenance,
        networkSnap: snap,
      },
    ],
  };
}

test('a snap-ranged egress walk is scored at its returned timeline, not at the range maximum', () => {
  const preferences = { ...DEFAULT_PREFERENCES, preparationSeconds: 120 };
  const request = {
    origin: dock,
    destination: door,
    now: NOW,
    deadline: NOW + 3 * 3_600_000,
    preferences,
    purpose: 'search' as const,
  };
  const planned = planBaseRoutes(
    request,
    [
      egress('bicycle-egress', 238, 190, {
        startMeters: 18.0785361610285,
        endMeters: 10.61691152,
        allowanceSeconds: 29,
      }),
      egress('bus-egress', 230, 166, {
        startMeters: 10.098807147876055,
        endMeters: 10.61691152,
        allowanceSeconds: 21,
      }),
    ],
    provenance,
    { objective: 'estimated-arrival' },
  );
  const intelligence = rankRouteIntelligence(planned.routes, request, {
    objective: 'estimated-arrival',
  });

  assert.equal(intelligence.assessments.length, 2);
  for (const assessment of intelligence.assessments) {
    const route = planned.routes.find((value) => value.id === assessment.routeId)!;
    const walk = route.segments[0];
    const snap = walk.networkSnap!;
    // Half the snap gap, walked at the path's own pace, capped by the allowance.
    const walked =
      walk.durationSeconds.min +
      Math.min(
        snap.allowanceSeconds,
        ((snap.startMeters + snap.endMeters) / 2) *
          (walk.durationSeconds.min / walk.distanceMeters),
      );
    const readyAt = estimateBaseTimeline(route.segments, NOW)!.arrivalAt + 120_000;

    assert.equal(assessment.estimatedReadyAt, readyAt);
    assert.equal(assessment.estimatedSeconds, (readyAt - NOW) / 1000);
    assert.equal(assessment.score, assessment.estimatedSeconds);
    assert.ok(Math.abs(assessment.estimatedSeconds! - (walked + 120)) < 1e-6);
    assert.ok(assessment.estimatedReadyAt! < route.readyTime.latest);
  }
  assert.ok(
    Math.abs(
      intelligence.assessments.find((value) => value.routeId === 'bicycle-egress')!
        .estimatedSeconds! - 321.4540651855,
    ) < 1e-6,
  );
});
