// The bicycle network under scooter and e-bike rides: walked stretches timed at walking pace, and an
// OSRM "no route" answer kept apart from an outage (quality FIXPLAN B1, B4, 2026-11-02).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import {
  BicycleRouter,
  PUSH_INSTRUCTION,
  pushedAlong,
  routerOutage,
} from '../src/common/engine/connectivity/pedestrian.js';
import { withPedestrianRouting } from '../src/common/engine/connectivity/provider.js';
import { ApiError } from '../src/common/engine/errors.js';
import type { RouteEndpoints, RouteProvider } from '../src/common/engine/kakao.js';
import {
  SIGNAL_DELAY_SECONDS,
  SIGNALS_PER_KM,
  ebikeRoutesFromBicycle,
  scooterRoutesFromBicycle,
  type IntersectionLookup,
} from '../src/common/engine/simulation/scooter-router.js';
import type { BaseRoute } from '../src/common/shared/domain/index.js';

const NOW = Date.UTC(2026, 10, 1, 16);
const LATITUDE = 37.55;
const METERS_PER_LONGITUDE = 111_195 * Math.cos((LATITUDE * Math.PI) / 180);
type Coordinate = [number, number];
/** A point this many metres east of 126.97° on the 37.55° parallel. */
const east = (meters: number): Coordinate => [126.97 + meters / METERS_PER_LONGITUDE, LATITUDE];
const ride: RouteEndpoints = {
  origin: { id: 'device', name: '기기', address: '', latitude: LATITUDE, longitude: east(0)[0] },
  destination: {
    id: 'spot',
    name: '반납 위치',
    address: '',
    latitude: LATITUDE,
    longitude: east(1000)[0],
  },
};
const step = (mode: string, from: number, to: number, seconds: number, type: string) => ({
  mode,
  name: '',
  distance: to - from,
  duration: seconds,
  geometry: { type: 'LineString', coordinates: [east(from), east(to)] },
  maneuver: { type, location: east(from) },
});
/** 1 km on the bicycle network; the middle `pushed` metres are walked at OSRM's 4 km/h. */
function osrmRide(pushed: number) {
  const first = (1000 - pushed) / 2,
    pushSeconds = pushed / (4 / 3.6),
    rideSeconds = (1000 - pushed) / (15 / 3.6);
  const steps = pushed
    ? [
        step('cycling', 0, first, rideSeconds / 2, 'depart'),
        step('pushing bike', first, first + pushed, pushSeconds, 'turn'),
        step('cycling', first + pushed, 1000, rideSeconds / 2, 'turn'),
      ]
    : [step('cycling', 0, 1000, rideSeconds, 'depart')];
  steps.push(step('cycling', 1000, 1000, 0, 'arrive'));
  const coordinates = pushed
    ? [east(0), east(first), east(first + pushed), east(1000)]
    : [east(0), east(1000)];
  return {
    code: 'Ok',
    waypoints: [
      { distance: 0, location: east(0) },
      { distance: 0, location: east(1000) },
    ],
    routes: [
      {
        distance: 1000,
        duration: pushSeconds + rideSeconds,
        geometry: { type: 'LineString', coordinates },
        legs: [{ steps }],
      },
    ],
  };
}
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const router = (fetcher: typeof fetch) =>
  new BicycleRouter({
    endpoint: 'http://127.0.0.1:5002/route/v1/bike',
    now: () => NOW,
    metered: false,
    fetcher,
  });
const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;
/** One signalled intersection, 500 m along: in the middle of the walked stretch below. */
const lightAt500: IntersectionLookup = {
  loadedNear: (point, radius) =>
    Math.abs((point.longitude - east(500)[0]) * METERS_PER_LONGITUDE) <= radius
      ? [{ id: 'light-500' }]
      : [],
};

test('a ride that walks 200 m of its kilometre takes longer than one that rides it all', async () => {
  const [pushed] = await router(async () => reply(osrmRide(200))).bicycle(ride, new CallBudget());
  const [cycled] = await router(async () => reply(osrmRide(0))).bicycle(ride, new CallBudget());
  assert.equal(pushed.distanceMeters, cycled.distanceMeters);
  const walked = pushedAlong(pushed.segments[0]);
  assert.equal(walked?.meters, 200);
  assert.equal(walked?.seconds, 180);
  assert.equal(walked?.ridden.length, 2, 'the walked stretch splits the ridden path in two');
  const [ebikePushed] = ebikeRoutesFromBicycle([pushed], ride);
  const [ebikeCycled] = ebikeRoutesFromBicycle([cycled], ride);
  // 800 m ridden at 17–21 km/h and 200 m walked in OSRM's 180 s, signals by density on 800 m.
  const signals = 0.8 * SIGNALS_PER_KM;
  assert.deepEqual(ebikePushed.durationSeconds, {
    min: Math.ceil(800 / (21 / 3.6) + 180 + signals * SIGNAL_DELAY_SECONDS.lower),
    max: Math.ceil(800 / (17 / 3.6) + 180 + signals * SIGNAL_DELAY_SECONDS.upper),
  });
  assert.ok(ebikePushed.durationSeconds.min > ebikeCycled.durationSeconds.min + 100);
  assert.ok(ebikePushed.durationSeconds.max > ebikeCycled.durationSeconds.max + 100);
  const [scooterPushed] = scooterRoutesFromBicycle([pushed], ride);
  const [scooterCycled] = scooterRoutesFromBicycle([cycled], ride);
  assert.ok(scooterPushed.durationSeconds.min > scooterCycled.durationSeconds.min + 100);
});

test('signal waits are counted on the ridden path only, not where the vehicle is walked', async () => {
  const [pushed] = await router(async () => reply(osrmRide(200))).bicycle(ride, new CallBudget());
  const [cycled] = await router(async () => reply(osrmRide(0))).bicycle(ride, new CallBudget());
  const [walkedPast] = ebikeRoutesFromBicycle([pushed], ride, lightAt500);
  assert.deepEqual(walkedPast.durationSeconds, {
    min: Math.ceil(800 / (21 / 3.6) + 180),
    max: Math.ceil(800 / (17 / 3.6) + 180),
  });
  const [riddenPast] = ebikeRoutesFromBicycle([cycled], ride, lightAt500);
  assert.deepEqual(riddenPast.durationSeconds, {
    min: Math.ceil(1000 / (21 / 3.6) + SIGNAL_DELAY_SECONDS.lower),
    max: Math.ceil(1000 / (17 / 3.6) + SIGNAL_DELAY_SECONDS.upper),
  });
});

test('the walked stretch is told in the ride, in the words of the vehicle ridden', async () => {
  const [pushed] = await router(async () => reply(osrmRide(200))).bicycle(ride, new CallBudget());
  const [ebike] = ebikeRoutesFromBicycle([pushed], ride);
  const [scooter] = scooterRoutesFromBicycle([pushed], ride);
  assert.equal(
    ebike.segments[0].instructions,
    '자전거 경로를 따라 전기자전거로 이동해요. 약 200m는 끌고 걸어요. 보도로 달리지 말고 교차로를 확인하세요.',
  );
  assert.ok(scooter.segments[0].instructions.includes('약 200m는 끌고 걸어요.'));
  assert.ok(pushed.segments[0].maneuvers?.some((item) => item.instruction === PUSH_INSTRUCTION));
  assert.ok(
    scooter.segments[0].maneuvers?.some(
      (item) => item.instruction === '킥보드에서 내려 끌고 걸어요.',
    ),
  );
  assert.ok(!scooter.segments[0].maneuvers?.some((item) => item.instruction === PUSH_INSTRUCTION));
  const [cycled] = await router(async () => reply(osrmRide(0))).bicycle(ride, new CallBudget());
  assert.equal(
    ebikeRoutesFromBicycle([cycled], ride)[0].segments[0].instructions,
    '자전거 경로를 따라 전기자전거로 이동해요. 보도로 달리지 말고 교차로를 확인하세요.',
  );
});

test('the walked stretches survive the cache and stay off the API response', async () => {
  let calls = 0;
  const cycling = router(async () => {
    calls++;
    return reply(osrmRide(200));
  });
  const [first] = await cycling.bicycle(ride, new CallBudget());
  const [cached] = await cycling.bicycle(ride, new CallBudget());
  assert.equal(calls, 1);
  assert.notEqual(cached.segments[0], first.segments[0]);
  assert.equal(pushedAlong(cached.segments[0])?.meters, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(cached)), cached, 'nothing hidden is serialized');
  assert.ok(!JSON.stringify(cached).includes('ridden'));
  // A ride from any other source (Kakao, a test fixture) is timed as before.
  const plain: BaseRoute = structuredClone(first);
  assert.equal(pushedAlong(plain.segments[0]), undefined);
});

test('OSRM "no segment" and "no route" answers are no route, not a server that is down', async () => {
  for (const answer of ['NoSegment', 'NoRoute']) {
    const cycling = router(async () => reply({ code: answer, message: 'fixture' }, 400));
    for (let attempt = 0; attempt < 4; attempt++)
      await assert.rejects(cycling.bicycle(ride, new CallBudget()), code('NO_ROUTES'));
    assert.equal(cycling.unmetered, true, 'answers keep the server trusted');
  }
  await assert.rejects(
    router(async () => reply({ code: 'InvalidQuery', message: 'fixture' }, 400)).bicycle(
      ride,
      new CallBudget(),
    ),
    code('PROVIDER_UNAVAILABLE'),
  );
});

test("Kakao's bicycle quota is spent only when the bicycle network is down", async () => {
  const kakaoCalls: string[] = [];
  const kakao: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    walking: async () => [],
    transit: async () => [],
    bicycle: async (request) => {
      kakaoCalls.push(request.origin.id);
      throw new ApiError('NO_ROUTES', 'fixture', 404);
    },
  };
  const ask = (fetcher: typeof fetch) =>
    withPedestrianRouting(kakao, undefined, { cycling: router(fetcher) }).bicycle!(
      ride,
      new CallBudget(),
    );
  await assert.rejects(
    ask(async () => reply({ code: 'NoSegment' }, 400)),
    code('NO_ROUTES'),
  );
  await assert.rejects(
    ask(async () => reply({ code: 'Ok' })),
    code('PROVIDER_RESPONSE'),
  );
  assert.deepEqual(kakaoCalls, [], 'an answer from the network, even a bad one, stands');
  await assert.rejects(ask(async () => reply({ message: 'down' }, 503)));
  await assert.rejects(
    ask(async () => {
      throw new TypeError('connection refused');
    }),
  );
  assert.deepEqual(kakaoCalls, ['device', 'device']);
  assert.equal(routerOutage(new ApiError('PROVIDER_TIMEOUT', 'fixture', 504)), true);
  assert.equal(routerOutage(new ApiError('NO_ROUTES', 'fixture', 404)), false);
  assert.equal(routerOutage(new ApiError('PROVIDER_RESPONSE', 'fixture')), false);
});
