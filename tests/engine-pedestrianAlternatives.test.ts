// Regression cases from mvp/tests/pedestrianAlternatives.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import type { RouteEndpoints, RouteProvider } from '../src/common/engine/kakao.js';
import { withPedestrianRouting } from '../src/common/engine/connectivity/provider.js';
import { withRouteQueryReuse } from '../src/common/engine/connectivity/query-reuse.js';
import { bestWalkingSegment } from '../src/common/engine/multimodal.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import type { BaseRoute, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.UTC(2026, 9, 28, 3);
// 서울역's map point sits inside the station building, 97 m from Kakao's nearest walkable link.
const origin: Place = {
  id: 'kakao-station',
  name: '서울역',
  address: '',
  latitude: 37.55406888733184,
  longitude: 126.97070335253385,
};
const destination: Place = {
  id: 'platform-3',
  name: '3번 승강장',
  address: '',
  latitude: 37.55491338,
  longitude: 126.97224974,
};
const endpoints: RouteEndpoints = { origin, destination };
const eastAccess: Place = {
  id: 'kakao-walk-source-start',
  name: '서울역 보행 출발점',
  address: '',
  latitude: 37.55443504,
  longitude: 126.97169899,
};
type Walking = (request: RouteEndpoints) => BaseRoute[];

function sourceRoute(
  id: string,
  start: Place,
  end: Place,
  distance: number,
  seconds: number,
  extraSeconds = 0,
): BaseRoute {
  const walk = {
    id: `${id}-walk`,
    mode: 'walk' as const,
    title: id,
    instructions: '공급원에서 반환한 보행 경로',
    start: { ...start },
    end: { ...end },
    distanceMeters: distance,
    durationSeconds: { min: seconds, max: seconds },
    polyline: [start, end].map(({ latitude, longitude }) => ({ latitude, longitude })),
    runAllowed: false,
  };
  const extra = extraSeconds
    ? [
        {
          id: `${id}-provider-extra`,
          mode: 'wait' as const,
          title: '추가 소요',
          instructions: '',
          start: { ...end },
          end: { ...end },
          distanceMeters: 0,
          durationSeconds: { min: extraSeconds, max: extraSeconds },
          runAllowed: false,
        },
      ]
    : [];
  return {
    id,
    title: id,
    transfers: 0,
    distanceMeters: distance,
    durationSeconds: { min: seconds + extraSeconds, max: seconds + extraSeconds },
    segments: [walk, ...extra],
  };
}
// Kakao's real answer for this walk: 112 m in 130 s from its own snapped start.
const kakaoFromStreet: Walking = (request) => [
  sourceRoute('kakao-street', eastAccess, request.destination, 112, 130, 4),
];
const osrmDetour: Walking = (request) => {
  const route = sourceRoute('osrm-detour', request.origin, request.destination, 1665, 1332);
  route.segments[0].polyline!.splice(1, 0, { latitude: 37.54863, longitude: 126.9705 });
  return [route];
};
const osrmDirect: Walking = (request) => [
  sourceRoute('osrm-direct', request.origin, request.destination, 200, 160),
];

function harness(
  options: {
    kakao?: Walking;
    osrm?: Walking;
    kakaoConfigured?: boolean;
    secondOpinion?: () => boolean;
  } = {},
) {
  const calls = { kakao: 0, osrm: 0 };
  const base: RouteProvider = {
    configured: options.kakaoConfigured !== false,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (request, budget) =>
      budget.run(() => {
        calls.kakao++;
        return (options.kakao ?? kakaoFromStreet)(request);
      }),
  };
  const pedestrian = {
    configured: true,
    walking: async (request: RouteEndpoints, budget: CallBudget) =>
      budget.run(() => {
        calls.osrm++;
        return (options.osrm ?? osrmDetour)(request);
      }),
    walkingIsCached: () => false,
  };
  return {
    provider: withPedestrianRouting(
      base,
      pedestrian,
      options.secondOpinion ? { secondOpinion: options.secondOpinion } : {},
    ),
    calls,
  };
}

test('a direct OpenStreetMap walk spends no Kakao quota', async () => {
  const { provider, calls } = harness({ osrm: osrmDirect });
  const budget = new CallBudget(2);
  assert.deepEqual(
    (await provider.walking(endpoints, budget)).map((route) => route.id),
    ['osrm-direct'],
  );
  assert.deepEqual(calls, { kakao: 0, osrm: 1 });
  assert.equal(budget.used, 1);
});

test("a station POI that OSRM routes around the building gets Kakao's short walk with a connector, never a start-point prompt", async () => {
  const { provider, calls } = harness();
  const budget = new CallBudget(2);
  const routes = await provider.walking(endpoints, budget);
  assert.deepEqual(
    routes.map((route) => route.id),
    ['osrm-detour', 'kakao-street'],
  );
  assert.deepEqual(calls, { kakao: 1, osrm: 1 });
  assert.equal(budget.used, 2);
  const [walk, extra] = routes[1].segments;
  assert.deepEqual(walk.polyline![0], { latitude: origin.latitude, longitude: origin.longitude });
  assert.equal(walk.start.latitude, origin.latitude);
  const gap = Math.round(metersBetween(origin, eastAccess));
  assert.ok(gap > 96 && gap < 98);
  assert.equal(walk.distanceMeters, 112 + gap);
  assert.deepEqual(
    walk.durationSeconds,
    { min: 130, max: 130 + Math.ceil(metersBetween(origin, eastAccess)) },
    'the connector widens only the upper bound',
  );
  assert.equal(
    extra.start.latitude,
    destination.latitude,
    'the provider allowance stays at the end of the walk',
  );
  assert.equal(
    bestWalkingSegment(routes, 'access', origin, destination, '승강장까지 걷기', NOW)
      ?.durationSeconds.min,
    134,
    'the planner keeps the short walk',
  );
});

test('once a search stops second opinions, an OSRM detour is kept without asking Kakao', async () => {
  const { provider, calls } = harness({ secondOpinion: () => false });
  assert.deepEqual(
    (await provider.walking(endpoints, new CallBudget(2))).map((route) => route.id),
    ['osrm-detour'],
  );
  assert.equal(calls.kakao, 0);
});

test('an exhausted shared budget skips the second network', async () => {
  const { provider, calls } = harness();
  const budget = new CallBudget(1);
  assert.deepEqual(
    (await provider.walking(endpoints, budget)).map((route) => route.id),
    ['osrm-detour'],
  );
  assert.equal(calls.kakao, 0);
  assert.equal(budget.used, 1);
});

test("each network covers the other's failure, and both failing reports the error", async () => {
  const osrmDown = harness({
    osrm: () => {
      throw new ApiError('PROVIDER_UNAVAILABLE', '통제된 실패');
    },
  });
  assert.deepEqual(
    (await osrmDown.provider.walking(endpoints, new CallBudget(2))).map((route) => route.id),
    ['kakao-street'],
  );
  const kakaoDown = harness({
    kakao: () => {
      throw new ApiError('PROVIDER_LIMIT', '오늘 한도 소진', 429);
    },
  });
  assert.deepEqual(
    (await kakaoDown.provider.walking(endpoints, new CallBudget(2))).map((route) => route.id),
    ['osrm-detour'],
  );
  const bothDown = harness({
    osrm: () => {
      throw new ApiError('NO_ROUTES', '없음', 404);
    },
    kakao: () => {
      throw new ApiError('PROVIDER_LIMIT', '한도', 429);
    },
  });
  await assert.rejects(
    bothDown.provider.walking(endpoints, new CallBudget(2)),
    (error: unknown) => error instanceof ApiError && error.code === 'NO_ROUTES',
    'a spent Kakao quota does not hide the walking failure',
  );
  const kakaoOff = harness({ kakaoConfigured: false });
  assert.deepEqual(
    (await kakaoOff.provider.walking(endpoints, new CallBudget(2))).map((route) => route.id),
    ['osrm-detour'],
  );
  assert.equal(kakaoOff.calls.kakao, 0);
});

test('a Kakao start beyond the connector range, or invalid Kakao geometry, is never selected', async () => {
  const far = { ...eastAccess, latitude: origin.latitude + 0.003 };
  for (const corrupt of [
    'too-far',
    'missing-path',
    'blocked',
    'wrong-mode',
    'negative-time',
  ] as const) {
    const { provider } = harness({
      kakao: (request) => {
        const route = kakaoFromStreet(request)[0],
          segment = route.segments[0];
        if (corrupt === 'too-far') {
          segment.start = far;
          segment.polyline![0] = { latitude: far.latitude, longitude: far.longitude };
        }
        if (corrupt === 'missing-path') delete segment.polyline;
        if (corrupt === 'blocked') segment.traffic = [{ from: 0, to: 1, level: 'blocked' }];
        if (corrupt === 'wrong-mode') segment.mode = 'bicycle';
        if (corrupt === 'negative-time') segment.durationSeconds.min = -1;
        return [route];
      },
    });
    const routes = await provider.walking(endpoints, new CallBudget(2));
    assert.equal(
      bestWalkingSegment(routes, 'access', origin, destination, '승강장까지 걷기', NOW)
        ?.durationSeconds.max,
      1332,
      corrupt,
    );
  }
});

test('concurrent consumers of one walk share a single provider answer', async () => {
  const h = harness();
  const shared = withRouteQueryReuse(h.provider);
  const budget = new CallBudget(4);
  const [left, right] = await Promise.all([
    shared.walking(endpoints, budget),
    shared.walking(endpoints, budget),
  ]);
  assert.deepEqual(left, right);
  assert.deepEqual(h.calls, { kakao: 1, osrm: 1 });
});
