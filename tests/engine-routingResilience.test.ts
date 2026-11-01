// Regression cases from mvp/tests/routingResilience.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { PedestrianRouter } from '../src/common/engine/connectivity/pedestrian.js';
import { ApiError } from '../src/common/engine/errors.js';
import { KakaoProvider, type RouteEndpoints } from '../src/common/engine/kakao.js';
import { bestWalkingSegment } from '../src/common/engine/multimodal.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';

const NOW = Date.UTC(2026, 9, 28, 3);
const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('a spent Kakao walking quota is remembered until midnight while other Kakao services keep working', async () => {
  const paths: string[] = [];
  const kakao = new KakaoProvider({
    key: 'test-key',
    fetcher: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/v2/routing/walk')
        return json(
          { errorType: 'BadRequest', message: 'API limit has been exceeded.', code: -10 },
          400,
        );
      return json({ documents: [], meta: {} });
    },
  });
  const request: RouteEndpoints = {
    origin: { id: 'a', name: '출발', address: '', latitude: 37.55, longitude: 126.97 },
    destination: { id: 'b', name: '도착', address: '', latitude: 37.551, longitude: 126.971 },
  };
  const budget = new CallBudget(5);
  await assert.rejects(kakao.walking(request, budget), code('PROVIDER_LIMIT'));
  await assert.rejects(kakao.walking(request, budget), code('PROVIDER_LIMIT'));
  assert.deepEqual(paths, ['/v2/routing/walk'], 'the second walk spends no request');
  assert.equal(budget.used, 1);
  await kakao.searchPlaces({ q: '서울역' });
  assert.equal(paths.at(-1), '/v2/local/search/keyword.json');
});

test('a closed search window stops new supplier calls without touching the call count', async () => {
  const budget = new CallBudget(5);
  await budget.run(() => 1);
  budget.closeAfter(0);
  assert.equal(budget.remaining, 0);
  await assert.rejects(
    budget.run(() => 2),
    code('CALL_BUDGET_EXCEEDED'),
  );
  assert.equal(budget.used, 1);
});

// 서울역's map point sits inside the station; the nearest foot path the server picks is on the far side.
test('a walk that snapped to the far side of a building is retried from points around it', async () => {
  const origin = {
    id: 'station',
    name: '서울역',
    address: '',
    latitude: 37.55406888733184,
    longitude: 126.97070335253385,
  };
  const destination = {
    id: 'stop',
    name: '버스 정류장',
    address: '',
    latitude: 37.55491338,
    longitude: 126.97224974,
  };
  const route = (points: number[][], duration: number) => {
    const distance =
      points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum +
            metersBetween(
              { longitude: points[index][0], latitude: points[index][1] },
              { longitude: point[0], latitude: point[1] },
            ),
          0,
        ) + 1;
    return {
      distance,
      duration,
      geometry: { type: 'LineString', coordinates: points },
      legs: [
        {
          steps: [
            {
              mode: 'walking',
              name: '',
              distance,
              duration,
              geometry: { type: 'LineString', coordinates: points },
              maneuver: { type: 'depart', location: points[0] },
            },
            {
              mode: 'walking',
              name: '',
              distance: 0,
              duration: 0,
              geometry: { type: 'LineString', coordinates: [points.at(-1), points.at(-1)] },
              maneuver: { type: 'arrive', location: points.at(-1) },
            },
          ],
        },
      ],
    };
  };
  const requests: number[][][] = [];
  const router = new PedestrianRouter({
    endpoint: 'https://foot.my-service.co.kr/route/v1/foot',
    now: () => NOW,
    fetcher: async (input) => {
      const points = new URL(String(input)).pathname
        .split('/')
        .at(-1)!
        .split(';')
        .map((pair) => pair.split(',').map(Number));
      requests.push(points);
      const [from, to] = points;
      if (
        Math.abs(from[1] - origin.latitude) < 1e-7 &&
        Math.abs(from[0] - origin.longitude) < 1e-7
      ) {
        // Snapped 73 m west, then all the way around the tracks.
        const west = [126.969957, 37.553778],
          detour = [[...west], [126.9695, 37.5485], [126.9735, 37.5486], [...to]];
        return json({
          code: 'Ok',
          waypoints: [
            { location: west, distance: 73 },
            { location: to, distance: 0 },
          ],
          routes: [route(detour, 1239)],
        });
      }
      return json({
        code: 'Ok',
        waypoints: [
          { location: from, distance: 0 },
          { location: to, distance: 0 },
        ],
        routes: [route([from, to], 90)],
      });
    },
  });
  const routes = await router.walking({ origin, destination }, new CallBudget(20));
  assert.equal(requests.length, 1 + 8, 'one original walk and eight points around the station');
  const around = routes.filter((candidate) => candidate.id.endsWith('-around'));
  assert.equal(around.length, 2);
  assert.ok(
    Math.abs(around[0].segments[0].networkSnap!.startMeters - 90) < 1,
    'the stretch from the station point stays a snap allowance',
  );
  const best = bestWalkingSegment(routes, 'access', origin, destination, '정류장까지 걷기', NOW)!;
  assert.ok(
    best.durationSeconds.max < 300,
    `the walk out of the near side wins (${best.durationSeconds.max}s)`,
  );
  assert.equal(best.start.latitude, origin.latitude);
});

test('a screened saving reopens a closed search window briefly, but never limits an open one', () => {
  const closed = new CallBudget(10);
  closed.closeAfter(0);
  assert.equal(closed.remaining, 0);
  const restore = closed.extendWindow(5_000);
  assert.equal(closed.remaining, 10);
  restore();
  assert.equal(closed.remaining, 0, 'unneeded extra time is given back');
  const open = new CallBudget(10);
  open.extendWindow(0);
  assert.equal(open.remaining, 10, 'a search without a window keeps no deadline');
});
