// Each shared-mode tab keeps the ride that uses its kind alone whenever the trip is in that kind's range (quality
// INTEGRATION-QUALITY 11-02, "범위 안인데 순수 후보가 생성되지 않은 곳"). Two causes are covered: on self-hosted
// networks a closed optional-stage window refused the e-bike's and kick-scooter's whole trip although it spends no call,
// and a 따릉이 whole trip within the rider's cap as the crow flies rode past the cap on the network (a river crossing).
// Same cases as mvp/tests/pureSharedRides.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import {
  buildMixedModeBridges,
  type BridgeGenerationDiagnostics,
} from '../src/common/engine/mixed-mode-bridges.js';
import {
  cappedBicycleStationPairs,
  MAX_CAPPED_BICYCLE_RETURNS,
} from '../src/common/engine/multimodal.js';
import { MobilityFeeds, type VehicleFeed } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  docklessRoutingIsFree,
  type DocklessMode,
  type DocklessRentalPolicy,
} from '../src/common/engine/scooter-bridge.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type MobilityPreferences,
  type Place,
} from '../src/common/shared/domain/index.js';
import type { MobilityMarker } from '../src/common/shared/intelligence/types.js';

const NOW = Date.UTC(2026, 10, 2, 3);
const point = (id: string, north: number, east = 0): Place => ({
  id,
  name: id,
  address: '',
  latitude: 37.5 + north / 111195,
  longitude: 127 + east / 88000,
});
const leg = (
  mode: BaseSegment['mode'],
  from: Place,
  to: Place,
  meters: number,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id: mode,
  mode,
  title: mode,
  instructions: '통제된 공급원 경로',
  start: from,
  end: to,
  distanceMeters: meters,
  durationSeconds: { min: seconds, max: seconds },
  polyline: [from, to],
  runAllowed: false,
  ...extra,
});
const routeOf = (segments: BaseSegment[]): BaseRoute => ({
  id: segments.map((segment) => segment.id).join('+'),
  title: 'fixture',
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
  durationSeconds: {
    min: segments.reduce((sum, segment) => sum + segment.durationSeconds.min, 0),
    max: segments.reduce((sum, segment) => sum + segment.durationSeconds.max, 0),
  },
});
const walkRoute = (request: { origin: Place; destination: Place }) => {
  const meters = metersBetween(request.origin, request.destination);
  return [routeOf([leg('walk', request.origin, request.destination, meters, meters / 1.2)])];
};
const vehicles = (route: BaseRoute) =>
  route.segments
    .map((segment) => segment.mode)
    .filter((mode) => !['walk', 'run', 'wait', 'hire', 'return', 'entry'].includes(mode));

// ---------------------------------------------------------------------------------------------------------------------------
// The e-bike's and kick-scooter's whole trip on self-hosted networks.

const origin = point('origin', 0),
  destination = point('destination', 4000);
// A bus that runs most of the way, so the search has spans other than the whole trip to rent for.
const stop = point('stop', 400),
  alight = point('alight', 3600);
const transit = [
  routeOf([
    { ...leg('walk', origin, stop, 400, 330), id: 'walk-a' },
    { ...leg('bus', stop, alight, 3200, 700), id: 'bus', lineName: '2412' },
    { ...leg('walk', alight, destination, 400, 330), id: 'walk-b' },
  ]),
];
const devices = [
  { id: 'e-origin', kind: 'e-bicycle' as const, north: 30 },
  { id: 's-origin', kind: 'kick-scooter' as const, north: 30, east: 20 },
  { id: 'e-alight', kind: 'e-bicycle' as const, north: 3620 },
  { id: 's-alight', kind: 'kick-scooter' as const, north: 3580, east: 20 },
];
const marker = (device: (typeof devices)[number]): MobilityMarker => {
  const at = point(device.id, device.north, device.east);
  return {
    id: `gbfs:fixture:${device.id}`,
    sourceId: device.id,
    provider: 'fixture-operator',
    kind: device.kind,
    entity: 'vehicle',
    name: device.id,
    latitude: at.latitude,
    longitude: at.longitude,
    distanceMeters: 0,
    available: true,
    availableCount: 1,
    batteryPercent: 80,
    observedAt: NOW,
    receivedAt: NOW,
    freshness: 'fresh',
    source: 'gbfs',
    returnPolicy: 'unverified',
  };
};

function docklessSearch(options: { free: boolean; closed: boolean }) {
  const verified: { mode?: DocklessMode; vehicle: string; destination: string }[] = [];
  const feed: VehicleFeed = {
    provider: 'fixture-operator',
    lastFailure: null,
    kinds: ['kick-scooter', 'e-bicycle'],
    nearby: async () => devices.map(marker),
  };
  const ride =
    (mode: DocklessMode) =>
    async (request: { origin: Place; destination: Place }, budget: CallBudget) => {
      const meters = metersBetween(request.origin, request.destination);
      const route = [
        routeOf([
          leg(mode, request.origin, request.destination, meters, Math.round(meters / 5), {
            routingProfile: mode,
          }),
        ]),
      ];
      // A self-hosted network answers without the search's budget; a paid one spends it.
      return options.free ? route : budget.run(() => route);
    };
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (request, budget) =>
      options.free ? walkRoute(request) : budget.run(() => walkRoute(request)),
    scooter: ride('scooter'),
    ebike: ride('ebike'),
    ...(options.free ? { unmetered: { walking: true, bicycle: true } } : {}),
  };
  const policy: DocklessRentalPolicy = {
    verify: async ({ vehicle, destination: to, mode }) => {
      verified.push({ mode, vehicle: vehicle.id, destination: to.id });
      return {
        vehicleId: vehicle.id,
        provider: vehicle.provider,
        dropoff: { ...to },
        verifiedAt: NOW,
        validUntil: NOW + 3_600_000,
        pickupAllowed: true,
        returnAllowed: true,
        eligibilityAllowed: true,
        hireSeconds: 30,
        returnSeconds: 30,
        unlockFeeWon: 600,
        perMinuteWon: 160,
        returnFeeWon: 0,
      };
    },
  };
  const budget = new CallBudget(60);
  // A slow search: the optional-stage window closed before the rentals started, and the extra time the rental rounds
  // ask for has run out too (a slow machine spends it on the network tables).
  if (options.closed) {
    budget.closeAfter(0);
    budget.extendWindow = () => () => {};
  }
  let diagnostics!: BridgeGenerationDiagnostics;
  const run = () =>
    buildMixedModeBridges(
      {
        origin,
        destination,
        preferences: {
          ...DEFAULT_PREFERENCES,
          allowBicycle: false,
          allowScooter: true,
          hasScooterLicense: true,
          allowEbike: true,
          allowTaxi: false,
        },
      },
      transit,
      {
        now: NOW,
        budget,
        provider,
        mobility: new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] }),
        scooterPolicy: policy,
        ebikePolicy: policy,
        onDiagnostics: (value) => {
          diagnostics = value;
        },
      },
    );
  return { run, verified, diagnostics: () => diagnostics, provider };
}
const wholeTrips = (bridges: BaseRoute[], mode: DocklessMode) =>
  bridges.filter(
    (route) =>
      route.segments.some((segment) => segment.mode === mode) &&
      metersBetween(route.segments[0].start, origin) < 1 &&
      metersBetween(route.segments.at(-1)!.end, destination) < 1 &&
      vehicles(route).every((vehicle) => vehicle === mode),
  );

test('dockless routing is free only while both the walking and the bicycle networks are self-hosted', () => {
  const base: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async () => [],
  };
  assert.equal(docklessRoutingIsFree(base), false);
  assert.equal(docklessRoutingIsFree({ ...base, unmetered: { walking: true } }), false);
  assert.equal(docklessRoutingIsFree({ ...base, unmetered: { bicycle: true } }), false);
  assert.equal(
    docklessRoutingIsFree({ ...base, unmetered: { walking: true, bicycle: true } }),
    true,
  );
});

test('on self-hosted networks a closed optional-stage window still rides the e-bike and kick-scooter whole trip', async () => {
  const open = docklessSearch({ free: true, closed: false });
  const opened = await open.run();
  const closed = docklessSearch({ free: true, closed: true });
  const late = await closed.run();
  for (const mode of ['ebike', 'scooter'] as const) {
    assert.equal(
      wholeTrips(opened, mode).length,
      1,
      `${mode}: the open window rides the whole trip`,
    );
    assert.equal(wholeTrips(late, mode).length, 1, `${mode}: so does a closed one`);
    // The ride is the same one: the window changes which optional spans are tried, not the whole trip.
    assert.deepEqual(
      wholeTrips(late, mode)[0].segments.map((segment) => [segment.mode, segment.distanceMeters]),
      wholeTrips(opened, mode)[0].segments.map((segment) => [segment.mode, segment.distanceMeters]),
    );
  }
  // Only the whole trip is exempt: after the window closed no other span of either kind was asked for.
  assert.ok(closed.verified.length > 0);
  assert.ok(closed.verified.every((call) => call.destination === destination.id));
  assert.ok(
    open.verified.some((call) => call.destination !== destination.id),
    'with the window open the search also rents for the walks to and from the bus',
  );
  assert.ok(closed.diagnostics().budgetSkipped > 0, 'the skipped spans are still reported');
});

test('on a metered network a closed window still refuses every rental, the whole trip too', async () => {
  const closed = docklessSearch({ free: false, closed: true });
  const bridges = await closed.run();
  assert.equal(wholeTrips(bridges, 'ebike').length, 0);
  assert.equal(wholeTrips(bridges, 'scooter').length, 0);
  assert.equal(closed.verified.length, 0);
});

test('the e-bike tab gets its pure whole trip although faster e-bike and bus mixtures exist', async () => {
  const bridges = await docklessSearch({ free: true, closed: true }).run();
  const request = {
    origin,
    destination,
    now: NOW,
    deadline: NOW + 3_600_000,
    preferences: { ...DEFAULT_PREFERENCES, allowBicycle: false, allowEbike: true },
  };
  const pure = planJourneyGraph(request, [...transit, ...bridges], {
    receivedAt: NOW,
    maxResults: 1,
    pureMode: 'ebike',
  });
  assert.equal(pure.routes.length, 1);
  assert.deepEqual(vehicles(pure.routes[0]), ['ebike']);
});

// ---------------------------------------------------------------------------------------------------------------------------
// 따릉이 past the rider's cap on the network.

/** Docks on one street, metres north of the origin. */
const DOCKS = [
  { id: 'hire', north: 20 },
  { id: 'mid', north: 3300 },
  { id: 'drop', north: 3980 },
];
function stationFeed() {
  return new MobilityFeeds({
    seoulBikeKey: 'fixture',
    now: () => NOW,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          rentBikeStatus: {
            list_total_count: DOCKS.length,
            RESULT: { CODE: 'INFO-000' },
            row: DOCKS.map((station) => {
              const at = point(station.id, station.north);
              return {
                stationId: station.id,
                stationName: station.id,
                stationLatitude: String(at.latitude),
                stationLongitude: String(at.longitude),
                parkingBikeTotCnt: '5',
                rackTotCnt: '10',
              };
            }),
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
}
/** The network crosses a river: a ride to the dock by the destination is 5.6 km, 1.4 times the straight line elsewhere. */
const BRIDGE_RIDE_METERS = 5600;
function bicycleSearch(maxBicycleMeters: number) {
  const rides: string[] = [];
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    unmetered: { walking: true, bicycle: true },
    walking: async (request) => walkRoute(request),
    bicycle: async (request) => {
      rides.push(`${request.origin.name}>${request.destination.name}`);
      const meters =
        request.destination.name === 'drop'
          ? BRIDGE_RIDE_METERS
          : Math.round(metersBetween(request.origin, request.destination) * 1.4);
      // The path follows the street in 100 m steps, as a network path does.
      const steps = Math.max(
        1,
        Math.round(metersBetween(request.origin, request.destination) / 100),
      );
      const polyline = Array.from({ length: steps + 1 }, (_, index) => ({
        latitude:
          request.origin.latitude +
          ((request.destination.latitude - request.origin.latitude) * index) / steps,
        longitude:
          request.origin.longitude +
          ((request.destination.longitude - request.origin.longitude) * index) / steps,
      }));
      return [
        routeOf([
          leg('bicycle', request.origin, request.destination, meters, Math.round(meters / 4), {
            routingProfile: 'bicycle',
            polyline: polyline.map((at, index) => ({
              ...at,
              id: `p${index}`,
              name: '',
              address: '',
            })),
          }),
        ]),
      ];
    },
  };
  const preferences: MobilityPreferences = {
    ...DEFAULT_PREFERENCES,
    allowBicycle: true,
    bicycleReady: true,
    maxBicycleMeters,
    allowScooter: false,
    allowEbike: false,
    allowTaxi: false,
  };
  let diagnostics!: BridgeGenerationDiagnostics;
  const context = {
    now: NOW,
    budget: new CallBudget(40),
    provider,
    mobility: stationFeed(),
    onDiagnostics: (value: BridgeGenerationDiagnostics) => {
      diagnostics = value;
    },
  };
  return {
    rides,
    preferences,
    context,
    diagnostics: () => diagnostics,
    run: () => buildMixedModeBridges({ origin, destination, preferences }, [], context),
  };
}
const bicycleWholeTrips = (bridges: BaseRoute[]) =>
  bridges.filter(
    (route) =>
      route.segments.some((segment) => segment.mode === 'bicycle') &&
      metersBetween(route.segments[0].start, origin) < 1 &&
      metersBetween(route.segments.at(-1)!.end, destination) < 1,
  );

test('a 따릉이 whole trip past the cap on the network returns short of the destination and walks the rest', async () => {
  // 4 km as the crow flies is within the 5 km cap; the 5.6 km ride over the river is not.
  assert.ok(metersBetween(origin, destination) < 5000);
  const search = bicycleSearch(5000);
  const bridges = await search.run();
  const whole = bicycleWholeTrips(bridges);
  assert.equal(whole.length, 1, 'one ride reaches the destination');
  const [route] = whole;
  assert.deepEqual(
    route.segments.map((segment) => segment.mode),
    ['walk', 'hire', 'bicycle', 'return', 'walk'],
  );
  const ride = route.segments.find((segment) => segment.mode === 'bicycle')!;
  assert.ok(ride.distanceMeters <= 5000, `the ride keeps the cap (${ride.distanceMeters} m)`);
  const returned = route.segments.find((segment) => segment.mode === 'return')!;
  assert.equal(returned.start.name, 'mid', 'it returns at the dock the capped ride reaches');
  assert.equal(route.segments.at(-1)!.title, `${destination.name}까지 걷기`);
  assert.ok(route.segments.at(-1)!.distanceMeters > 600, 'and walks the rest');
  // Rental and return together stay one minute.
  assert.equal(
    route.segments
      .filter((segment) => segment.mode === 'hire' || segment.mode === 'return')
      .reduce((sum, segment) => sum + segment.durationSeconds.max, 0),
    60,
  );
  assert.ok(search.rides.includes('hire>drop'), 'the full ride was tried first');

  // The 따릉이 tab's own search finds it.
  const pure = planJourneyGraph(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW + 3_600_000,
      preferences: search.preferences,
    },
    [...walkRoute({ origin, destination }), ...bridges],
    { receivedAt: NOW, maxResults: 1, pureMode: 'bicycle' },
  );
  assert.equal(pure.routes.length, 1);
  assert.deepEqual(vehicles(pure.routes[0]), ['bicycle']);
});

test('a 따릉이 whole trip within the cap on the network is ridden to the destination, with no shortened copy', async () => {
  const search = bicycleSearch(6000);
  const bridges = await search.run();
  const whole = bicycleWholeTrips(bridges);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].segments.find((segment) => segment.mode === 'return')!.start.name, 'drop');
  assert.ok(!bridges.some((route) => route.id.includes('capped')));
  assert.ok(!search.rides.some((ride) => ride.endsWith('>mid')), 'no shortened ride is asked for');
});

test('shortened returns: docks near where the cap ends on the ride, nearest the destination first, at most two', async () => {
  const search = bicycleSearch(5000);
  const stations = await search.context.mobility.bikes.nearby(origin, 5000);
  const byId = (id: string) => stations.find((station) => station.id === id)!;
  const returns = await cappedBicycleStationPairs(
    search.context,
    search.preferences,
    { hire: byId('hire'), drop: byId('drop') },
    destination,
  );
  assert.deepEqual(
    returns.map((pair) => [pair.hire.id, pair.drop.id]),
    [['hire', 'mid']],
  );
  assert.equal(MAX_CAPPED_BICYCLE_RETURNS, 2);
  // A ride that fits the cap needs no shortened return.
  assert.deepEqual(
    await cappedBicycleStationPairs(
      search.context,
      { ...search.preferences, maxBicycleMeters: 6000 },
      { hire: byId('hire'), drop: byId('drop') },
      destination,
    ),
    [],
  );
});
