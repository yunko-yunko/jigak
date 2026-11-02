import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { rideKey } from '../src/common/engine/ride-identity.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';
import { executeRouteSearch } from '../src/modules/routing/domain/route-search.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';

// Controlled provider fixtures shaped like Kakao's responses (one entry per line, 일반/급행 listed together on a
// stretch that has both) run through the real route search, not a live observation.
const NOW = Date.UTC(2026, 9, 16, 5);
const place = (id: string, name: string, latitude: number, longitude: number): Place => ({
  id,
  name,
  address: '서울',
  latitude,
  longitude,
});
const O = place('origin', '개봉', 37.4948, 126.8581),
  GURO = place('guro', '구로', 37.5031, 126.882),
  D = place('destination', '가산디지털단지', 37.4811, 126.8827);
const preferences = {
  allowRunning: false,
  allowBicycle: false,
  bicycleReady: false,
  allowScooter: false,
  allowTaxi: false,
  maxRunningMeters: 0,
  maxBicycleMeters: 0,
  runningPace: 'easy',
  preparationSeconds: 0,
};
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
  instructions: '조회한 공급원 구간',
  start,
  end,
  distanceMeters: metersBetween(start, end),
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  polyline: [start, end],
  ...extra,
});
const train = (id: string, start: Place, end: Place, seconds: number, stops: string[]) =>
  leg(id, 'subway', start, end, seconds, {
    lineName: '1호선',
    transit: { lines: ['1호선'], stops, vehicleTypes: ['일반', '급행'] },
  });
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, part) => sum + part.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (sum, part) => ({
      min: sum.min + part.durationSeconds.min,
      max: sum.max + part.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});

/** The provider's own 구로 change (경인선 then 경부선), offered twice with different timings: one ride, two variants. */
const itineraries = () => [
  route('kakao-0', [
    train('a', O, GURO, 600, ['개봉', '구일', '구로']),
    leg('x', 'walk', GURO, GURO, 60, { distanceMeters: 0, polyline: undefined }),
    train('b', GURO, D, 420, ['구로', '가산디지털단지']),
  ]),
  route('kakao-1', [
    train('c', O, GURO, 660, ['개봉', '구일', '구로']),
    leg('y', 'walk', GURO, GURO, 240, { distanceMeters: 0, polyline: undefined }),
    train('d', GURO, D, 420, ['구로', '가산디지털단지']),
  ]),
];

/** A bus to the same 구로 platform, then the identical 1호선 ride: quicker by the provider's wait-free total, slower once waits count. */
const STOP = place('stop', '개봉역 버스정류장', 37.495, 126.859);
const busFirst = () =>
  route('kakao-bus', [
    leg('w', 'walk', O, STOP, 60),
    leg('bus', 'bus', STOP, GURO, 460, {
      lineName: '6513',
      transit: { lines: ['6513'], stops: ['개봉역', '구로역'] },
    }),
    leg('z', 'walk', GURO, GURO, 60, { distanceMeters: 0, polyline: undefined }),
    train('b2', GURO, D, 420, ['구로', '가산디지털단지']),
  ]);

// Intermediate discovery on (with no station found) makes the search multimodal, so the response is the journey graph's.
async function search(sources: () => BaseRoute[] = itineraries) {
  const now = () => NOW;
  const graphs: { sameRideReboards: number; duplicateRideResults: number }[] = [];
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    nearby: async () => [],
    walking: async () => [],
    transit: async (_endpoints, budget) => budget.run(() => sources()),
  };
  const options: RoutingOptions = {
    provider,
    realtime: new RealtimeService({}),
    nearbyTransit: new NearbyTransitService({ provider, now }),
    traffic: new RoadTrafficService({ now }),
    mobility: new MobilityFeeds({ now }),
    weather: new WeatherFeed(),
    parking: new SeoulParkingFeed(undefined, { now }),
    intermediateTransitHubs: 2,
    now,
    observeGraphSearch: ({ result }) => {
      graphs.push(result.diagnostics);
    },
  };
  const result = await executeRouteSearch(
    { origin: O, destination: D, now: NOW, deadline: NOW + 3_600_000, preferences },
    options,
  );
  assert.ok(result);
  return { body: JSON.parse(result.encoded.body.toString()), graphs };
}

test('through the route search, a provider change of trains on one line survives and the ride gets exactly one card', async () => {
  const { body, graphs } = await search();
  const rides: string[] = body.routes.map((item: BaseRoute) => rideKey(item.segments));
  assert.equal(new Set(rides).size, rides.length, 'one card per distinct ride');
  const transit = body.routes.filter((item: BaseRoute) =>
    item.segments.some((part) => part.mode === 'subway'),
  );
  assert.equal(transit.length, 1, 'both variants of the 구로 change are one ride');
  assert.equal(
    transit[0].segments.filter((part: BaseSegment) => part.mode === 'subway').length,
    2,
    "the provider's own change of trains is kept, not refused as a re-boarding",
  );
  assert.ok(graphs.length > 0);
  assert.ok(
    graphs.every((graph) => graph.duplicateRideResults > 0),
    'the two variants of the change fold into one result',
  );
});

test('through the route search, the provider change wins even when an itinerary sharing its second train is listed first', async () => {
  for (const sources of [
    () => [...itineraries(), busFirst()],
    () => [busFirst(), ...itineraries()],
  ]) {
    const { body, graphs } = await search(sources);
    const recommended = body.routes.find(
      (item: BaseRoute & { recommended?: boolean }) => item.recommended,
    );
    assert.ok(recommended);
    assert.deepEqual(
      recommended.segments
        .filter((part: BaseSegment) => part.mode === 'bus' || part.mode === 'subway')
        .map((part: BaseSegment) => part.transit?.lines[0]),
      ['1호선', '1호선'],
      `listed ${sources()
        .map((item) => item.id)
        .join(', ')}`,
    );
    assert.ok(
      body.routes.some((item: BaseRoute) => item.segments.some((part) => part.mode === 'bus')),
      'the bus itinerary stays as another ride',
    );
    // The provider's change at 구로 stays behind the gates; only leaving through 구로's exit and entering the same line
    // again (the gate arcs that let the bus itinerary's street point reach the trains) is refused as a re-boarding.
    const trains = recommended.segments.flatMap((part: BaseSegment, index: number) =>
      part.mode === 'subway' ? [index] : [],
    );
    assert.ok(
      !recommended.segments
        .slice(trains[0] + 1, trains[1])
        .some((part: BaseSegment) => part.mode === 'entry'),
      'the 구로 change passes no gates',
    );
    assert.ok(graphs.length > 0);
  }
});
