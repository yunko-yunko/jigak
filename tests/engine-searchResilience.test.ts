// Route search when suppliers fail, and the response an app older than the e-bike tab can read (FIXPLAN D2, D3).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import type { DrivingLeg, RouteProvider } from '../src/common/engine/kakao.js';
import { mergeWalkingRoute, taxiConnection } from '../src/common/engine/multimodal.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';
import {
  executeRouteSearch,
  legacyRentalAvailability,
  namesEbikePreferences,
} from '../src/modules/routing/domain/route-search.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';

const NOW = Date.UTC(2026, 10, 1, 3);
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const O = place('대치동부센트레빌', 37.492796, 127.055776),
  D = place('유니브학원', 37.502526, 127.058562);
// Kakao's taxi kerbs: about 130 m from the origin pin and 12 m from the destination pin.
const PICKUP = { latitude: 37.49361, longitude: 127.05475 },
  DROPOFF = { latitude: 37.50243, longitude: 127.05862 };
const road: DrivingLeg = {
  distanceMeters: 1_880,
  durationSeconds: 420,
  polyline: [PICKUP, { latitude: 37.498, longitude: 127.0566 }, DROPOFF],
  maneuvers: [],
  taxiFareWon: 5_600,
  traffic: [],
};
const outage = () =>
  new ApiError(
    'PROVIDER_UNAVAILABLE',
    '보행망 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
  );
const request = (preferences: Record<string, unknown> = {}) => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowRunning: false,
    preparationSeconds: 0,
    allowBicycle: false,
    bicycleReady: false,
    allowScooter: false,
    ...preferences,
  },
});

function options(provider: RouteProvider): RoutingOptions {
  const now = () => NOW;
  return {
    provider,
    realtime: new RealtimeService({}),
    nearbyTransit: new NearbyTransitService({ provider, now }),
    traffic: new RoadTrafficService({ now }),
    mobility: new MobilityFeeds({ now }),
    weather: new WeatherFeed(),
    parking: new SeoulParkingFeed(undefined, { now }),
    now,
  };
}

/** Walking and transit both fail; the road answers unless `driving` is false. */
function brokenProvider(driving = true): RouteProvider {
  return {
    configured: true,
    searchPlaces: async () => [],
    walking: async () => {
      throw outage();
    },
    transit: async () => {
      throw new ApiError('PROVIDER_UNAVAILABLE', '카카오 지도에 연결하지 못했어요.');
    },
    ...(driving
      ? { driving: async (_: unknown, budget: CallBudget) => budget.run(() => road) }
      : {}),
  };
}

type Body = {
  routes: BaseRoute[];
  failures: { provider: string; code: string }[];
  rentalAvailability: Record<string, unknown>;
};
const parse = (result: Awaited<ReturnType<typeof executeRouteSearch>>) => {
  assert.ok(result);
  return JSON.parse(result.encoded.body.toString()) as Body;
};

test('with walking and transit both down, the door-to-door taxi still answers the search', async () => {
  const body = parse(await executeRouteSearch(request(), options(brokenProvider())));
  const taxi = body.routes.find((route) => route.segments.some((part) => part.mode === 'taxi'));
  assert.ok(taxi, 'a taxi route is returned');
  assert.deepEqual(
    body.failures.map((failure) => failure.provider),
    ['pedestrian-routing', 'kakao-publictraffic'],
  );
  // The kerb walks fall back to the street estimate (1.25 detour at 1.2 m/s) instead of dropping the taxi.
  const access = taxi.segments[0];
  assert.equal(access.mode, 'walk');
  assert.equal(access.distanceMeters, Math.round(metersBetween(O, PICKUP) * 1.25));
  assert.equal(access.durationSeconds.min, Math.ceil(access.distanceMeters / 1.2));
});

test('with nothing to route at all, the search reports the supplier failure, not an empty result', async () => {
  await assert.rejects(
    executeRouteSearch(request(), options(brokenProvider(false))),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE',
  );
});

test('an app that names no e-bike preference gets no e-bike entry; one that names either does', async () => {
  const provider = brokenProvider();
  const legacy = parse(await executeRouteSearch(request(), options(provider)));
  assert.deepEqual(Object.keys(legacy.rentalAvailability).sort(), ['bicycle', 'scooter']);
  const current = parse(
    await executeRouteSearch(request({ hasScooterLicense: false }), options(provider)),
  );
  assert.deepEqual(Object.keys(current.rentalAvailability).sort(), ['bicycle', 'ebike', 'scooter']);
});

test('only an explicit allowEbike or hasScooterLicense marks a request as e-bike aware', () => {
  assert.equal(namesEbikePreferences({ preferences: { allowBicycle: true } }), false);
  assert.equal(namesEbikePreferences({ preferences: { allowEbike: false } }), true);
  assert.equal(namesEbikePreferences({ preferences: { hasScooterLicense: true } }), true);
  assert.equal(namesEbikePreferences(null), false);
  assert.equal(namesEbikePreferences({ preferences: 'x' }), false);
});

test('an older app reads a return refused for want of a legal spot as no route', () => {
  assert.deepEqual(
    legacyRentalAvailability({
      bicycle: { status: 'included', reason: null },
      ebike: { status: 'included', reason: null },
      scooter: { status: 'not-found', reason: 'no-legal-return' },
    }),
    {
      bicycle: { status: 'included', reason: null },
      scooter: { status: 'not-found', reason: 'no-route' },
    },
  );
});

/** OSRM's answer when both pins snap to one street point: a path under a metre plus the two snaps. */
const snappedWalk = (snap: boolean): BaseRoute => {
  const start = { ...place('osrm-start', DROPOFF.latitude, DROPOFF.longitude) },
    end = { ...place('osrm-end', 37.502432, 127.058624) };
  const segment: BaseSegment = {
    id: 'osrm-walk',
    mode: 'walk',
    title: '걷기',
    instructions: '보행망',
    distanceMeters: 1,
    durationSeconds: { min: 1, max: 14 },
    start,
    end,
    runAllowed: true,
    polyline: [DROPOFF, { latitude: 37.502432, longitude: 127.058624 }],
    ...(snap
      ? { networkSnap: { startMeters: 0, endMeters: metersBetween(end, D), allowanceSeconds: 13 } }
      : {}),
  };
  return {
    id: 'osrm',
    title: '걷기',
    segments: [segment],
    transfers: 0,
    distanceMeters: 1,
    durationSeconds: { min: 1, max: 14 },
  };
};
const dropoff = place('하차 연결점', DROPOFF.latitude, DROPOFF.longitude);

test('a walk whose two pins snap to one street point is its snap connectors, not a broken route', () => {
  const merged = mergeWalkingRoute(snappedWalk(true), 'egress', dropoff, D, '걷기');
  assert.ok(merged);
  assert.equal(
    merged.distanceMeters,
    Math.ceil(1 + metersBetween(snappedWalk(true).segments[0].end, D)),
  );
  assert.deepEqual(merged.durationSeconds, { min: 1, max: 14 });
  // Without a network snap a path that never moves still cannot connect two separate points.
  assert.equal(mergeWalkingRoute(snappedWalk(false), 'egress', dropoff, D, '걷기'), null);
});

test('a taxi kerb walk falls back to the estimate only on a supplier outage and only near the pin', async () => {
  const context = (walking: RouteProvider['walking'], polyline = road.polyline) => ({
    provider: {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      walking,
      driving: async (_: unknown, budget: CallBudget) => budget.run(() => ({ ...road, polyline })),
    } satisfies RouteProvider,
    budget: new CallBudget(10),
    now: NOW,
  });
  const segments = await taxiConnection(
    context(async () => {
      throw new ApiError('PROVIDER_LIMIT', '한도');
    }),
    O,
    D,
    'taxi',
  );
  assert.deepEqual(
    segments?.map((segment) => segment.mode),
    ['walk', 'wait', 'taxi', 'walk'],
  );
  // A "no path" answer is an answer: the taxi is not offered on a guess.
  await assert.rejects(
    taxiConnection(
      context(async () => {
        throw new ApiError('NO_ROUTES', '경로 없음', 404);
      }),
      O,
      D,
      'taxi',
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'NO_ROUTES',
  );
  // A kerb 400 m from the pin is not a kerb the estimate may stand in for.
  const far = { latitude: 37.4964, longitude: 127.0558 };
  await assert.rejects(
    taxiConnection(
      context(async () => {
        throw outage();
      }, [far, ...road.polyline.slice(1)]),
      O,
      D,
      'taxi',
    ),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE',
  );
});
