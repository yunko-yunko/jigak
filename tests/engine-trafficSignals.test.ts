// Regression cases from mvp/tests/trafficSignals.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySignalWaits,
  crossedLegs,
  crosswalkWaitSeconds,
  epsg5186ToWgs84,
  SeoulIntersections,
  TrafficSignalFeed,
} from '../src/common/engine/realtime/trafficSignals.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import type { BaseRoute } from '../src/common/shared/domain/types.js';

const NOW = Date.UTC(2026, 9, 28, 2);
// 남영역 교차로 (Seoul traffic safety facility table A008P, EPSG:5186).
const center = { latitude: 37.541683, longitude: 126.970787 };
const offset = (north: number, east: number) => ({
  latitude: center.latitude + north / 111_320,
  longitude: center.longitude + east / (111_320 * Math.cos((center.latitude * Math.PI) / 180)),
});
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

test('Seoul facility coordinates convert from EPSG:5186 to the map position of the intersection', () => {
  const station = epsg5186ToWgs84(197612.859714465, 550504.185037582);
  assert.ok(
    metersBetween(station, { latitude: 37.554058, longitude: 126.972984 }) < 1,
    '서울역광장 sits in front of the station',
  );
  assert.ok(metersBetween(epsg5186ToWgs84(197418.294444605, 549130.779493609), center) < 1);
});

test('a walk crosses the leg it passes around the centre, and staying on one corner crosses none', () => {
  const legs = [{ bearing: 0 }, { bearing: 90 }, { bearing: 180 }, { bearing: 270 }];
  // West to east along the north side: the north crosswalk.
  const north = crossedLegs([offset(25, -60), offset(25, 60)], center, legs);
  assert.deepEqual(
    north.map((crossing) => crossing.leg),
    [0],
  );
  assert.ok(Math.abs(north[0].along - 60) < 6, 'the crossing is where the walk passes the leg');
  // South to east around the south-east corner: no road crossed.
  assert.deepEqual(
    crossedLegs([offset(-60, 20), offset(-20, 20), offset(-20, 60)], center, legs),
    [],
  );
  // A walk that never comes near the intersection crosses nothing there.
  assert.deepEqual(crossedLegs([offset(200, -60), offset(200, 60)], center, legs), []);
});

test('the wait at a crosswalk follows the live phase only until it changes', () => {
  const red = { direction: 'nt' as const, bearing: 0, go: false, remainingSeconds: 40 };
  const green = { ...red, go: true, remainingSeconds: 20 };
  assert.equal(
    crosswalkWaitSeconds(red, NOW, NOW + 10_000),
    30,
    'arriving with 30 seconds of red left',
  );
  assert.equal(crosswalkWaitSeconds(red, NOW, NOW + 45_000), 0, 'the light has just turned green');
  assert.equal(
    crosswalkWaitSeconds(red, NOW, NOW + 90_000),
    null,
    'the next phase length is unknown',
  );
  assert.equal(crosswalkWaitSeconds(green, NOW, NOW + 10_000), 0);
  assert.equal(
    crosswalkWaitSeconds(green, NOW, NOW + 18_000),
    null,
    'too little green left to start, and the red length is unknown',
  );
});

test('the first walk carries the red-light wait from live T-DATA phases at a Seoul intersection', async () => {
  const intersections = new SeoulIntersections({
    key: 'seoul-key',
    now: () => NOW,
    fetcher: async () =>
      reply({
        trafficSafetyA008PInfo: {
          list_total_count: 1,
          row: [
            {
              INTR_CD: '343',
              INTR_NM: '남영역',
              XCRD: '197418.294444605',
              YCRD: '549130.779493609',
            },
          ],
        },
      }),
  });
  const urls: URL[] = [];
  const signals = new TrafficSignalFeed({
    key: 'tdata-key',
    now: () => NOW,
    fetcher: async (input) => {
      urls.push(new URL(String(input)));
      return reply([
        {
          itstId: '343',
          trsmUtcTime: NOW,
          ntPdsgRmdrCs: 400,
          ntPdsgStatNm: 'stop-And-Remain',
          etPdsgRmdrCs: 36001,
          etPdsgStatNm: 'stop-And-Remain',
          stPdsgRmdrCs: null,
        },
      ]);
    },
  });
  const start = offset(25, -100),
    end = offset(25, 100);
  const route: BaseRoute = {
    id: 'walk',
    title: '걷기',
    transfers: 0,
    distanceMeters: 200,
    durationSeconds: { min: 160, max: 170 },
    segments: [
      {
        id: 'walk-0',
        mode: 'walk',
        title: '정류장까지 걷기',
        instructions: '200m 걸어요.',
        distanceMeters: 200,
        durationSeconds: { min: 160, max: 170 },
        start: { id: 's', name: '출발', address: '', ...start },
        end: { id: 'e', name: '정류장', address: '', ...end },
        polyline: [start, end],
        runAllowed: false,
      },
    ],
  };
  const [timed] = await applySignalWaits([route], NOW, { intersections, signals });
  // The north crosswalk is reached after 100 m (80 s): the 40-second red is over and the next phase is unknown, so nothing is added.
  assert.deepEqual(timed.durationSeconds, { min: 160, max: 170 });
  const quick: BaseRoute = {
    ...route,
    segments: [{ ...route.segments[0], durationSeconds: { min: 40, max: 50 } }],
    durationSeconds: { min: 40, max: 50 },
  };
  const [hurried] = await applySignalWaits([quick], NOW, { intersections, signals });
  // Reached after 20 s, with 20 s of red left.
  assert.deepEqual(hurried.durationSeconds, { min: 60, max: 70 });
  assert.match(hurried.segments[0].instructions, /신호 대기 20초 포함\(남영역\)/);
  assert.equal(urls[0].searchParams.get('itstId'), '343');
  assert.equal(
    urls[0].pathname,
    '/apig/apiman-gateway/tapi/v2xSignalPhaseTimingFusionCurrentInfo/1.0',
  );
});

test('signal timing leaves routes unchanged when the feed has nothing usable or answers too late', async () => {
  const intersections = new SeoulIntersections({
    key: 'seoul-key',
    now: () => NOW,
    fetcher: async () =>
      reply({
        trafficSafetyA008PInfo: {
          list_total_count: 1,
          row: [
            {
              INTR_CD: '343',
              INTR_NM: '남영역',
              XCRD: '197418.294444605',
              YCRD: '549130.779493609',
            },
          ],
        },
      }),
  });
  const start = offset(25, -100),
    end = offset(25, 100);
  const route: BaseRoute = {
    id: 'walk',
    title: '걷기',
    transfers: 0,
    distanceMeters: 200,
    durationSeconds: { min: 40, max: 50 },
    segments: [
      {
        id: 'walk-0',
        mode: 'walk',
        title: '걷기',
        instructions: '200m 걸어요.',
        distanceMeters: 200,
        durationSeconds: { min: 40, max: 50 },
        start: { id: 's', name: '출발', address: '', ...start },
        end: { id: 'e', name: '도착', address: '', ...end },
        polyline: [start, end],
        runAllowed: false,
      },
    ],
  };
  const unknown = new TrafficSignalFeed({
    key: 'k',
    now: () => NOW,
    fetcher: async () =>
      reply([
        { itstId: '343', trsmUtcTime: NOW, ntPdsgRmdrCs: 36001, ntPdsgStatNm: 'stop-And-Remain' },
      ]),
  });
  assert.deepEqual(
    (await applySignalWaits([route], NOW, { intersections, signals: unknown }))[0],
    route,
  );
  const slow = new TrafficSignalFeed({
    key: 'k',
    now: () => NOW,
    fetcher: () => new Promise<Response>(() => {}),
  });
  assert.deepEqual(
    (await applySignalWaits([route], NOW, { intersections, signals: slow }, 50))[0],
    route,
  );
});
