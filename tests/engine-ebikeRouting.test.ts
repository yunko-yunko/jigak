// Dockless e-bike routing next to kick-scooters and 따릉이 (contract D2, 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import {
  MAX_MARKERS_PER_GROUP,
  MAX_SNAPSHOT_MARKERS,
  MobilityFeeds,
  fairNearestMarkers,
  proportionalNearestMarkers,
  type VehicleFeed,
} from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  DOCKLESS_PROFILES,
  docklessConnection,
  ebikeConnection,
  scooterConnection,
  type DocklessConnectionContext,
  type DocklessMode,
  type DocklessRentalPolicy,
} from '../src/common/engine/scooter-bridge.js';
import {
  buildMixedModeBridges,
  rentalLimitDiagnostics,
  type BridgeGenerationDiagnostics,
} from '../src/common/engine/mixed-mode-bridges.js';
import {
  ebikeRoutesFromBicycle,
  SIGNAL_DELAY_SECONDS,
  SIGNALS_PER_KM,
} from '../src/common/engine/simulation/scooter-router.js';
import { rentalAvailabilityForSearch } from '../src/common/engine/intelligence/rental-availability.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { rideKey } from '../src/common/engine/ride-identity.js';
import { nameWalksAfterHires } from '../src/modules/routing/domain/route-search.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';
import type { MobilityKind, MobilityMarker } from '../src/common/shared/intelligence/types.js';

const NOW = Date.UTC(2026, 10, 1, 3);
const point = (id: string, north: number, east = 0): Place => ({
  id,
  name: id,
  address: '',
  latitude: 37.55 + north / 111195,
  longitude: 126.97 + east / 88000,
});
const origin = point('origin', 0),
  destination = point('destination', 3000);
const preferences = { ...DEFAULT_PREFERENCES, allowBicycle: false, allowScooter: true };

interface Device {
  id: string;
  kind: Extract<MobilityKind, 'kick-scooter' | 'e-bicycle'>;
  north: number;
  east?: number;
  /** Routed walk to the device, metres; the straight line by default. */
  access?: number;
  /** Routed ride, metres; the straight line by default. */
  ride?: number;
}
const marker = (device: Device, simulated: boolean): MobilityMarker => {
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
    distanceMeters: Math.round(metersBetween(origin, at)),
    available: true,
    availableCount: 1,
    batteryPercent: 80,
    observedAt: NOW,
    receivedAt: NOW,
    freshness: 'fresh',
    source: 'gbfs',
    returnPolicy: 'unverified',
    ...(simulated ? { simulated: true as const } : {}),
  };
};
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

function fixture(
  devices: Device[],
  options: {
    simulated?: boolean;
    modelVersion?: string;
    free?: boolean;
    /** Without the free networks' travel tables, devices keep their straight-line order. */
    noTable?: boolean;
    /** Every walk also comes with a slightly longer alternative. */
    alternatives?: boolean;
    /** Milliseconds each walk, ride and table lookup takes; none by default. */
    delay?: () => number;
    /** Walking-table seconds to each device on the free network; the routed walk at 1.2 m/s by default. */
    walkSeconds?: Record<string, number>;
    /** Where the operator lets the ride end; the destination itself by default. */
    dropoff?: (to: Place) => Place;
    /** The operator's legal spot by a station; none by default, so no transit continuation. */
    returnPoint?: DocklessRentalPolicy['returnPoint'];
  } = {},
) {
  const verified: { mode?: DocklessMode; vehicleId: string; destination: Place }[] = [];
  const routedRides: { mode: DocklessMode; vehicleId: string }[] = [];
  const feed: VehicleFeed = {
    provider: 'fixture-operator',
    lastFailure: null,
    simulated: options.simulated,
    kinds: ['kick-scooter', 'e-bicycle'],
    // Every device is reported; the bridge itself applies the search radius.
    nearby: async () => devices.map((device) => marker(device, !!options.simulated)),
  };
  const deviceAt = (place: Place) => devices.find((device) => place.id.endsWith(`:${device.id}`));
  const pause = () =>
    options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay!())) : null;
  const ride =
    (mode: DocklessMode) =>
    async (request: { origin: Place; destination: Place }, budget: CallBudget) => (
      await pause(),
      budget.run(() => {
        const device = deviceAt(request.origin)!;
        routedRides.push({ mode, vehicleId: device.id });
        const meters = device.ride ?? metersBetween(request.origin, request.destination);
        return [
          routeOf([
            leg(mode, request.origin, request.destination, meters, Math.round(meters / 5), {
              routingProfile: mode,
              routingSource: {
                mode: 'live',
                provider: 'osrm',
                label: 'OpenStreetMap 자전거망',
                sourceTimestamp: null,
                receivedAt: NOW,
                isRealtime: false,
              },
            }),
          ]),
        ];
      })
    );
  const walked: string[] = [];
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    ...(options.free
      ? {
          unmetered: { walking: true, bicycle: true },
          travelTable: options.noTable
            ? undefined
            : async (mode, sources, targets) => ({
                seconds: sources.map((source) =>
                  targets.map((target) => {
                    const device = devices.find((item) => [source.id, target.id].includes(item.id));
                    return mode === 'walking'
                      ? (options.walkSeconds?.[device!.id] ??
                          (device!.access ?? metersBetween(source, target)) / 1.2)
                      : metersBetween(source, target) / 5;
                  }),
                ),
              }),
        }
      : {}),
    walking: async (request, budget) => (
      await pause(),
      budget.run(() => {
        const device = deviceAt(request.destination);
        walked.push(device?.id ?? 'egress');
        const meters = device?.access ?? metersBetween(request.origin, request.destination);
        const walk = (extra: number) =>
          routeOf([
            leg(
              'walk',
              request.origin,
              request.destination,
              meters + extra,
              (meters + extra) / 1.2,
            ),
          ]);
        return options.alternatives
          ? [walk(0), { ...walk(20), id: `${walk(20).id}-long` }]
          : [walk(0)];
      })
    ),
    scooter: ride('scooter'),
    ebike: ride('ebike'),
  };
  const policy: DocklessRentalPolicy = {
    modelVersion: options.modelVersion,
    ...(options.returnPoint ? { returnPoint: options.returnPoint } : {}),
    verify: async ({ vehicle, destination: to, mode }) => {
      verified.push({ mode, vehicleId: vehicle.id, destination: to });
      return {
        vehicleId: vehicle.id,
        provider: vehicle.provider,
        dropoff: options.dropoff?.(to) ?? { ...to },
        verifiedAt: NOW,
        validUntil: NOW + 3_600_000,
        pickupAllowed: true,
        returnAllowed: true,
        eligibilityAllowed: true,
        hireSeconds: 30,
        returnSeconds: 45,
        unlockFeeWon: 600,
        perMinuteWon: 160,
        returnFeeWon: 0,
        ...(options.simulated
          ? {
              provenance: {
                mode: 'live' as const,
                provider: 'jigak-sim',
                label: '시연용 가상 전기자전거',
                sourceTimestamp: NOW,
                receivedAt: NOW,
                isRealtime: false,
                simulated: true as const,
                modelVersion: options.modelVersion,
              },
            }
          : {}),
      };
    },
  };
  const context: DocklessConnectionContext = {
    now: NOW,
    budget: new CallBudget(60),
    mobility: new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] }),
    provider,
    scooterPolicy: policy,
    ebikePolicy: policy,
  };
  return { context, verified, routedRides, walked };
}
const vehicleOf = (segments: BaseSegment[] | null) =>
  segments?.find((segment) => segment.mode === 'hire')?.rentalValidity?.vehicleId;

test('the profiles carry the contract numbers for both dockless kinds', () => {
  for (const mode of ['scooter', 'ebike'] as const) {
    const profile = DOCKLESS_PROFILES[mode];
    assert.equal(profile.searchMeters, 700, 'the straight line only pre-filters the walked cap');
    assert.equal(profile.accessMeters, 700);
    assert.equal(profile.egressMeters, 500);
    assert.equal(profile.minBattery, 20);
    assert.equal(profile.pickupComparisons, 3);
  }
  assert.equal(DOCKLESS_PROFILES.scooter.rideMeters, 6000);
  assert.equal(DOCKLESS_PROFILES.ebike.rideMeters, 8000);
  assert.equal(DOCKLESS_PROFILES.ebike.markerKind, 'e-bicycle');
  assert.equal(DOCKLESS_PROFILES.scooter.markerKind, 'kick-scooter');
});

test('an e-bike rental uses e-bike markers only, and a scooter rental scooter markers only', async () => {
  const devices: Device[] = [
    { id: 'scooter-near', kind: 'kick-scooter', north: 30 },
    { id: 'ebike-farther', kind: 'e-bicycle', north: 200 },
  ];
  const { context, verified } = fixture(devices);
  const ebike = await ebikeConnection(context, preferences, origin, destination, 'e');
  assert.equal(vehicleOf(ebike), 'ebike-farther');
  assert.deepEqual(
    ebike!.map((segment) => segment.mode),
    ['walk', 'hire', 'ebike', 'return'],
  );
  const ride = ebike!.find((segment) => segment.mode === 'ebike')!;
  assert.equal(ride.routingProfile, 'ebike');
  assert.equal(ebike![1].durationSeconds.max, 30, 'unlock seconds come from the permission');
  assert.equal(ebike![3].durationSeconds.max, 45, 'park, lock and photo seconds too');
  assert.equal(ebike![1].title, 'fixture-operator 전기자전거 대여');
  assert.ok(verified.every((call) => call.mode === 'ebike' && call.vehicleId === 'ebike-farther'));
  const scooter = await scooterConnection(context, preferences, origin, destination, 's');
  assert.equal(vehicleOf(scooter), 'scooter-near');
  assert.equal(verified.at(-1)!.mode, 'scooter');
});

test('the walked distance is the access cap; the straight line only skips devices beyond it', async () => {
  const outside = fixture([{ id: 'outside', kind: 'e-bicycle', north: 720 }]);
  assert.equal(await ebikeConnection(outside.context, preferences, origin, destination, 'o'), null);
  assert.equal(outside.verified.length, 0, 'no walk under 700 m reaches a device 720 m away');
  const straight = fixture([{ id: 'straight', kind: 'e-bicycle', north: 460 }]);
  assert.equal(
    vehicleOf(await ebikeConnection(straight.context, preferences, origin, destination, 's')),
    'straight',
    'a device 460 m away and walked in 460 m is offered',
  );
  const detour = fixture([{ id: 'detour', kind: 'e-bicycle', north: 390, access: 690 }]);
  assert.equal(
    vehicleOf(await ebikeConnection(detour.context, preferences, origin, destination, 'd')),
    'detour',
    'a campus detour of 690 m to a device 390 m away is still a walk to it',
  );
  const tooLong = fixture([{ id: 'too-long', kind: 'e-bicycle', north: 390, access: 710 }]);
  assert.equal(await ebikeConnection(tooLong.context, preferences, origin, destination, 't'), null);
});

test('devices on the way are compared before nearer ones behind the rider', async () => {
  // Three spots 190–200 m behind are nearer than the one 210 m ahead; by nearness they would use up the comparisons.
  const devices: Device[] = [
    { id: 'behind-a', kind: 'e-bicycle', north: -190, east: -40 },
    { id: 'behind-b', kind: 'e-bicycle', north: -195, east: 30 },
    { id: 'behind-c', kind: 'e-bicycle', north: -200 },
    { id: 'ahead', kind: 'e-bicycle', north: 210 },
  ];
  const { context, routedRides } = fixture(devices);
  const chosen = await ebikeConnection(context, preferences, origin, destination, 'w');
  assert.equal(vehicleOf(chosen), 'ahead');
  assert.equal(routedRides[0].vehicleId, 'ahead', 'the device on the way is routed first');
});

test('on free networks the walking table ranks devices: three behind a railway no longer use up the comparisons', async () => {
  // The three nearest devices sit across a railway: a 650 m walk each, still under the cap.
  const devices: Device[] = [
    { id: 'rail-a', kind: 'e-bicycle', north: 120, access: 650 },
    { id: 'rail-b', kind: 'e-bicycle', north: 125, east: 30, access: 650 },
    { id: 'rail-c', kind: 'e-bicycle', north: 130, east: -30, access: 650 },
    { id: 'open', kind: 'e-bicycle', north: 200 },
  ];
  // Without the tables the straight line still routes the railway devices first, but a walk that
  // loops (650 m for a device 120 m away) is not a comparison, so 'open' is looked at too.
  const metered = fixture(devices);
  assert.equal(
    vehicleOf(await ebikeConnection(metered.context, preferences, origin, destination, 'm')),
    'open',
  );
  assert.deepEqual(
    metered.routedRides.slice(0, 3).map((ride) => ride.vehicleId),
    ['rail-a', 'rail-b', 'rail-c'],
    'by the straight line the railway devices are routed first',
  );
  const free = fixture(devices, { free: true });
  const chosen = await ebikeConnection(free.context, preferences, origin, destination, 'f');
  assert.equal(vehicleOf(chosen), 'open');
  assert.equal(free.routedRides[0].vehicleId, 'open', 'the walk the network measures goes first');
});

test('on self-hosted networks devices are routed ahead of their turn with the same outcome', async () => {
  const devices: Device[] = [
    { id: 'a1', kind: 'e-bicycle', north: 50 },
    { id: 'a2', kind: 'e-bicycle', north: 50 },
    { id: 'b', kind: 'e-bicycle', north: 100, access: 800 },
    { id: 'c', kind: 'e-bicycle', north: 150, east: 100 },
    { id: 'd', kind: 'e-bicycle', north: 250, east: 100 },
    { id: 'e', kind: 'e-bicycle', north: 300, east: -100 },
  ];
  const run = async (free: boolean) => {
    const { context, routedRides } = fixture(devices, { free, noTable: true });
    const reported: string[] = [];
    context.onWalkingAlternatives = (routes) =>
      reported.push(routes.map((route) => route.segments.at(-1)!.end.id).join(','));
    let omitted = 0;
    const chosen = await ebikeConnection(context, preferences, origin, destination, 'p', {
      onCandidateLimited: (count) => {
        omitted += count;
      },
    });
    return { chosen, omitted, reported, rides: routedRides.map((ride) => ride.vehicleId) };
  };
  const one = await run(false),
    ahead = await run(true);
  assert.deepEqual(ahead.chosen, one.chosen);
  assert.equal(ahead.omitted, one.omitted);
  assert.deepEqual(ahead.reported, one.reported);
  assert.deepEqual(
    one.rides,
    ['a1', 'b', 'c'],
    "b's walk is too long, and d cannot beat the rental through c, so it is never routed",
  );
  assert.ok(
    ahead.rides.length >= one.rides.length,
    'routing ahead may route a device it then skips',
  );
});

test('an e-bike rides up to 8 km and a kick-scooter up to 6 km', async () => {
  const far = point('far', 7500);
  const ok = fixture([{ id: 'long', kind: 'e-bicycle', north: 50, ride: 7900 }]);
  assert.equal(vehicleOf(await ebikeConnection(ok.context, preferences, origin, far, 'l')), 'long');
  const over = fixture([{ id: 'over', kind: 'e-bicycle', north: 50, ride: 8100 }]);
  assert.equal(await ebikeConnection(over.context, preferences, origin, far, 'v'), null);
  const scooter = fixture([{ id: 'scooter', kind: 'kick-scooter', north: 50, ride: 6100 }]);
  assert.equal(await scooterConnection(scooter.context, preferences, origin, far, 's'), null);
});

test('two devices on one spot are one comparison; three distinct spots are compared', async () => {
  const devices: Device[] = [
    { id: 'a1', kind: 'e-bicycle', north: 50 },
    { id: 'a2', kind: 'e-bicycle', north: 50 },
    { id: 'b', kind: 'e-bicycle', north: 100 },
    { id: 'c', kind: 'e-bicycle', north: 150, east: 100 },
    { id: 'd', kind: 'e-bicycle', north: 250, east: 100 },
  ];
  const { context, routedRides } = fixture(devices);
  let omitted = 0;
  await ebikeConnection(context, preferences, origin, destination, 'p', {
    onCandidateLimited: (count) => {
      omitted += count;
    },
  });
  assert.deepEqual(
    routedRides.map((ride) => ride.vehicleId),
    ['a1', 'b', 'c'],
    'the second device on spot a never costs a comparison; spot d is the fourth',
  );
  assert.equal(omitted, 0, 'spot d cannot beat the rental through spot a, so it is no omission');
  // Walks of three times the straight line (the longest that does not loop) make every compared
  // rental slow: now spot d could still beat them.
  const slow = fixture(
    devices.map((device) =>
      device.id === 'd'
        ? device
        : { ...device, access: Math.floor(3 * metersBetween(origin, point(device.id, device.north, device.east))) },
    ),
  );
  let slowOmitted = 0;
  await ebikeConnection(slow.context, preferences, origin, destination, 'q', {
    onCandidateLimited: (count) => {
      slowOmitted += count;
    },
  });
  assert.deepEqual(
    slow.routedRides.map((ride) => ride.vehicleId),
    ['a1', 'b', 'c'],
  );
  assert.equal(slowOmitted, 1, 'the unrouted spot d could arrive sooner than the slow walks');
});

test('the e-bike router keeps the bicycle network label and times rides at 17–21 km/h plus signal waits, walked ends at 1 m/s', () => {
  const start = point('pickup', 0),
    end = point('park', 3000);
  const onNetwork = [point('net-start', 10), point('net-end', 2990)];
  const bicycle = routeOf([
    leg('bicycle', start, end, 3000, 700, {
      routingProfile: 'bicycle',
      polyline: onNetwork,
      routingSource: {
        mode: 'live',
        provider: 'osrm',
        label: 'OpenStreetMap 자전거망',
        sourceTimestamp: null,
        receivedAt: NOW,
        isRealtime: false,
      },
    }),
  ]);
  const [ride] = ebikeRoutesFromBicycle([bicycle], { origin: start, destination: end });
  const segment = ride.segments[0];
  assert.equal(segment.mode, 'ebike');
  assert.equal(segment.routingProfile, 'ebike');
  assert.match(segment.routingSource!.label, /OpenStreetMap 자전거망/);
  const walked = metersBetween(start, onNetwork[0]) + metersBetween(onNetwork[1], end);
  // No intersection list: the measured 3.9 signals per km wait 5–20 s each.
  const signals = 3 * SIGNALS_PER_KM;
  assert.equal(
    segment.durationSeconds.min,
    Math.ceil(3000 / (21 / 3.6) + signals * SIGNAL_DELAY_SECONDS.lower + walked),
  );
  assert.equal(
    segment.durationSeconds.max,
    Math.ceil(3000 / (17 / 3.6) + signals * SIGNAL_DELAY_SECONDS.upper + walked),
  );
  assert.ok(
    (3000 / (segment.durationSeconds.min - walked)) * 3.6 <= 25,
    'never above the assist cut-off',
  );
});

test('a simulated e-bike keeps its simulated label and provenance on every rental leg', async () => {
  const { context } = fixture([{ id: 'JB00001', kind: 'e-bicycle', north: 40 }], {
    simulated: true,
    modelVersion: 'sim-1',
  });
  const segments = await ebikeConnection(context, preferences, origin, destination, 'sim');
  assert.equal(
    segments?.find((segment) => segment.mode === 'hire')?.title,
    '시연용 가상 전기자전거 대여',
  );
  for (const segment of segments!.filter((part) => part.mode !== 'walk'))
    assert.equal(segment.routingSource?.simulated, true);
  const ride = segments!.find((segment) => segment.mode === 'ebike')!;
  assert.match(ride.routingSource!.label, /OpenStreetMap 자전거망/);
  const stale = fixture([{ id: 'JB00001', kind: 'e-bicycle', north: 40 }], {
    simulated: true,
    modelVersion: 'sim-1',
  });
  stale.context.ebikePolicy = { ...stale.context.ebikePolicy!, modelVersion: 'sim-2' };
  assert.equal(await ebikeConnection(stale.context, preferences, origin, destination, 'x'), null);
});

test('allowEbike: false, or no e-bike policy, offers no e-bike rental', async () => {
  const { context } = fixture([{ id: 'e', kind: 'e-bicycle', north: 40 }]);
  assert.equal(
    await ebikeConnection(context, { ...preferences, allowEbike: false }, origin, destination, 'n'),
    null,
  );
  assert.equal(
    await ebikeConnection(
      { ...context, ebikePolicy: undefined },
      preferences,
      origin,
      destination,
      'n',
    ),
    null,
  );
});

test('omitted scooter devices limit the scooter search only, never 따릉이 or e-bikes', async () => {
  const devices: Device[] = [
    ...[50, 100, 150, 200, 250].map((north) => ({
      id: `s${north}`,
      kind: 'kick-scooter' as const,
      north,
    })),
    { id: 'e1', kind: 'e-bicycle', north: 60 },
  ];
  const { context } = fixture(devices);
  let diagnostics!: BridgeGenerationDiagnostics;
  const bridges = await buildMixedModeBridges(
    {
      origin,
      destination,
      preferences: { ...preferences, allowBicycle: true, bicycleReady: true },
    },
    [],
    {
      ...context,
      onDiagnostics: (value) => {
        diagnostics = value;
      },
    },
  );
  assert.ok(diagnostics.rentalLimitedByMode.scooter >= 1);
  assert.equal(diagnostics.rentalLimitedByMode.ebike, 0);
  assert.equal(diagnostics.rentalLimitedByMode.bicycle, 0);
  const availability = rentalAvailabilityForSearch({
    preferences: { ...preferences, allowBicycle: true, bicycleReady: true },
    routes: bridges,
    capabilities: {
      bicycleFeed: true,
      scooterFeed: true,
      ebikeFeed: true,
      bicycleRouter: true,
      scooterRouter: true,
      ebikeRouter: true,
      scooterRentalPolicy: true,
      ebikeRentalPolicy: true,
    },
    diagnostics: rentalLimitDiagnostics(diagnostics),
  });
  assert.equal(availability.bicycle.reason, 'no-route');
  assert.equal(availability.ebike?.status, 'included');
  assert.equal(availability.scooter.status, 'included');
  const bridged = bridges.filter((route) =>
    route.segments.some((segment) => segment.mode === 'ebike'),
  );
  assert.equal(bridged[0].title, '전기자전거');
});

test('every dockless kind tries the whole trip first, ahead of long walks to the bus', async () => {
  const stop = point('stop', 1000),
    alight = point('alight', 2000);
  const transit = [
    routeOf([
      { ...leg('walk', origin, stop, 1000, 900), id: 'walk-a' },
      { ...leg('bus', stop, alight, 1000, 300), id: 'bus', lineName: '7016' },
      { ...leg('walk', alight, destination, 1000, 900), id: 'walk-b' },
    ]),
  ];
  const { context, verified } = fixture([
    { id: 'e-origin', kind: 'e-bicycle', north: 30 },
    { id: 's-origin', kind: 'kick-scooter', north: 30, east: 20 },
  ]);
  await buildMixedModeBridges({ origin, destination, preferences }, transit, context);
  for (const mode of ['scooter', 'ebike'] as const) {
    const first = verified.find((call) => call.mode === mode);
    assert.ok(first, `${mode} was tried`);
    assert.equal(first.destination.id, destination.id, `${mode} starts with the whole trip`);
  }
});

test('on free networks the rental rounds give the same bridges however long each lookup takes', async () => {
  const stop = point('stop', 1000),
    alight = point('alight', 2000);
  const transit = [
    routeOf([
      { ...leg('walk', origin, stop, 1000, 900), id: 'walk-a' },
      { ...leg('bus', stop, alight, 1000, 300), id: 'bus', lineName: '7016' },
      { ...leg('walk', alight, destination, 1000, 900), id: 'walk-b' },
    ]),
  ];
  const devices: Device[] = [
    { id: 'e-origin', kind: 'e-bicycle', north: 30 },
    { id: 'e-origin-2', kind: 'e-bicycle', north: 60, east: 40 },
    { id: 's-origin', kind: 'kick-scooter', north: 30, east: 20 },
    { id: 's-origin-2', kind: 'kick-scooter', north: 80, east: -30 },
    { id: 'e-alight', kind: 'e-bicycle', north: 2040 },
    { id: 's-alight', kind: 'kick-scooter', north: 1980, east: 30 },
  ];
  const run = async (seed: number | null) => {
    let state = seed ?? 1;
    const delay = () => ((state = (state * 48271) % 2147483647) % 7) + 1;
    const { context } = fixture(devices, {
      free: true,
      alternatives: true,
      ...(seed === null ? {} : { delay }),
    });
    const reported: string[] = [];
    context.onWalkingAlternatives = (routes) =>
      reported.push(routes.map((route) => route.segments.at(-1)!.end.id).join(','));
    const bridges = await buildMixedModeBridges(
      { origin, destination, preferences },
      transit,
      context,
    );
    return JSON.stringify({
      reported,
      bridges: bridges.map((route) => [
        route.id,
        route.segments.map((segment) => [segment.id, segment.mode, segment.durationSeconds.max]),
      ]),
    });
  };
  const settled = await run(null);
  assert.ok(JSON.parse(settled).reported.length > 2, 'walking alternatives are reported');
  assert.match(settled, /ebike/);
  assert.match(settled, /scooter/);
  for (const seed of [7, 11, 2026]) assert.equal(await run(seed), settled, `seed ${seed}`);
});

test('the e-bike tab keeps its best feasible route when twelve faster routes use other modes', () => {
  const pickup = point('JB00001', 100),
    park = point('park', 2900);
  const rental = routeOf([
    { ...leg('walk', origin, pickup, 100, 90), id: 'e-access' },
    {
      ...leg('hire', pickup, pickup, 0, 30),
      id: 'e-hire',
      polyline: undefined,
      rentalValidity: {
        verifiedAt: NOW,
        validUntil: NOW + 3_600_000,
        vehicleId: 'JB00001',
        provider: 'op',
      },
    },
    { ...leg('ebike', pickup, park, 2800, 600, { routingProfile: 'ebike' }), id: 'e-ride' },
    { ...leg('return', park, park, 0, 45), id: 'e-return', polyline: undefined },
    { ...leg('walk', park, destination, 100, 90), id: 'e-egress' },
  ]);
  const faster = Array.from({ length: 13 }, (_, index) =>
    routeOf([
      { ...leg('walk', origin, point(`s${index}`, 10), 10, 10), id: `w${index}` },
      {
        ...leg('bus', point(`s${index}`, 10), point(`t${index}`, 2990), 2980, 300 + index),
        id: `b${index}`,
        lineName: `line-${index}`,
      },
      { ...leg('walk', point(`t${index}`, 2990), destination, 10, 10), id: `x${index}` },
    ]),
  );
  const request = {
    origin,
    destination,
    now: NOW,
    deadline: NOW + 3_600_000,
    preferences: { ...preferences, allowRunning: false },
  };
  const main = planJourneyGraph(request, [...faster, rental], { receivedAt: NOW, maxResults: 12 });
  assert.ok(
    !main.routes.some((route) => route.segments.some((segment) => segment.mode === 'ebike')),
    'twelve faster bus routes fill the main list',
  );
  const reserved = planJourneyGraph(request, [...faster, rental], {
    receivedAt: NOW,
    maxResults: 1,
    requiredMode: 'ebike',
  });
  assert.equal(reserved.routes.length, 1);
  assert.ok(reserved.routes[0].segments.some((segment) => segment.mode === 'ebike'));
  assert.match(rideKey(reserved.routes[0].segments), /^ebike:/);
  const off = planJourneyGraph(
    { ...request, preferences: { ...request.preferences, allowEbike: false } },
    [...faster, rental],
    { receivedAt: NOW, maxResults: 1, requiredMode: 'ebike' },
  );
  assert.equal(off.routes.length, 0);
});

test('the map cap shares the answer out by the true count of each kind: a dense fleet cannot hide 따릉이 or the smaller kind', () => {
  const make = (
    kind: MobilityKind,
    count: number,
    from: number,
    source: MobilityMarker['source'],
  ) =>
    Array.from({ length: count }, (_, index) => ({
      ...marker({ id: `${kind}-${index}`, kind: 'e-bicycle', north: from + index }, true),
      kind,
      entity: kind === 'bicycle' ? ('station' as const) : ('vehicle' as const),
      source,
      distanceMeters: from + index,
    }));
  const count = (list: MobilityMarker[], kind: MobilityKind) =>
    list.filter((item) => item.kind === kind).length;
  const inOrder = (list: MobilityMarker[]) =>
    assert.deepEqual(
      list.map((item) => item.distanceMeters),
      [...list].map((item) => item.distanceMeters).sort((a, b) => a - b),
      'still ordered by distance',
    );
  const scooters = make('kick-scooter', 1500, 1, 'gbfs'),
    ebikes = make('e-bicycle', 200, 900, 'gbfs'),
    stations = make('bicycle', 30, 1100, 'seoul-bike');
  // Without true counts the group sizes decide: 따릉이 stations whole, then 1500 : 200 of the rest.
  const kept = fairNearestMarkers([stations, scooters, ebikes]);
  assert.equal(kept.length, MAX_SNAPSHOT_MARKERS);
  assert.equal(count(kept, 'bicycle'), 30);
  assert.equal(count(kept, 'kick-scooter'), 856);
  assert.equal(count(kept, 'e-bicycle'), 114);
  assert.ok(
    count(kept, 'e-bicycle') >= MAX_SNAPSHOT_MARKERS * 0.05,
    'the smaller kind keeps its floor',
  );
  inOrder(kept);
  // The real mix of the radius: 5,250 e-bikes to 1,500 scooters (3.5 : 1) reaches the answer, though each group is cut at 1,500.
  const dense = make('e-bicycle', 1500, 1, 'gbfs'),
    some = make('kick-scooter', 1500, 2, 'gbfs');
  const mixed = proportionalNearestMarkers([stations, some, dense], [30, 1500, 5250]);
  assert.equal(mixed.length, MAX_SNAPSHOT_MARKERS);
  assert.equal(count(mixed, 'bicycle'), 30);
  assert.equal(count(mixed, 'e-bicycle'), 754);
  assert.equal(count(mixed, 'kick-scooter'), 216);
  assert.ok(Math.abs(count(mixed, 'e-bicycle') / count(mixed, 'kick-scooter') - 3.5) < 0.05);
  inOrder(mixed);
  // A kind with few devices is not erased by a crowd of the other: it keeps all it has.
  const few = proportionalNearestMarkers([make('kick-scooter', 20, 1, 'gbfs'), dense], [20, 3000]);
  assert.equal(count(few, 'kick-scooter'), 20);
  assert.equal(count(few, 'e-bicycle'), 980);
  // One group is cut at the limit asked for, and never above the per-group cap.
  assert.equal(fairNearestMarkers([stations]).length, 30);
  assert.equal(fairNearestMarkers([scooters], 1000).length, 1000);
  assert.equal(fairNearestMarkers([scooters], 2500).length, MAX_MARKERS_PER_GROUP);
});

test('capabilities tell kick-scooter feeds from e-bike feeds', () => {
  const feed = (kinds?: MobilityKind[], simulated?: boolean): VehicleFeed => ({
    provider: 'f',
    lastFailure: null,
    simulated,
    kinds,
    nearby: async () => [],
  });
  const both = new MobilityFeeds({ vehicleFeeds: [feed(['kick-scooter', 'e-bicycle'], true)] })
    .capabilities;
  assert.deepEqual([both.sharedScooter, both.sharedEbike, both.sharedBicycle], [true, true, false]);
  const ebikeOnly = new MobilityFeeds({ vehicleFeeds: [feed(['e-bicycle'], true)] }).capabilities;
  assert.deepEqual([ebikeOnly.sharedScooter, ebikeOnly.sharedEbike], [false, true]);
  const legacy = new MobilityFeeds({ vehicleFeeds: [feed(undefined, true)] }).capabilities;
  assert.deepEqual([legacy.sharedScooter, legacy.sharedEbike], [true, false]);
});

function stationFeed(stations: { id: string; north: number }[]) {
  return new MobilityFeeds({
    seoulBikeKey: 'fixture',
    now: () => NOW,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          rentBikeStatus: {
            list_total_count: stations.length,
            RESULT: { CODE: 'INFO-000' },
            row: stations.map((station) => {
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

test('따릉이 that beats walking by under a minute is routed while lookups are free, screened out while they are paid', async () => {
  const to = point('도착', 900);
  // Walk 660 s against 20 + 30 + 520 + 30 + 20 = 620 s by bicycle with its one minute of hire and return: 40 s
  // faster (the 선린인터넷고→숙대입구 shape saved 45.7 s).
  const seconds: Record<string, number> = {
    'origin>도착': 660,
    'origin>hire': 20,
    'drop>도착': 20,
    'hire>drop': 520,
  };
  const name = (place: Place) => place.name;
  const run = async (free: boolean) => {
    const provider: RouteProvider = {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      walking: async (request, budget) =>
        budget.run(() => [
          routeOf([
            leg(
              'walk',
              request.origin,
              request.destination,
              metersBetween(request.origin, request.destination),
              seconds[`${name(request.origin)}>${name(request.destination)}`] ?? 20,
            ),
          ]),
        ]),
      bicycle: async (request, budget) =>
        budget.run(() => [
          routeOf([
            leg('bicycle', request.origin, request.destination, 860, 520, {
              routingProfile: 'bicycle',
            }),
          ]),
        ]),
      travelTable: async (_mode, sources, destinations, budget) =>
        budget.run(() => ({
          seconds: sources.map((source) =>
            destinations.map(
              (destination) => seconds[`${name(source)}>${name(destination)}`] ?? null,
            ),
          ),
        })),
      ...(free ? { unmetered: { walking: true, bicycle: true } } : {}),
    };
    let diagnostics!: BridgeGenerationDiagnostics;
    const bridges = await buildMixedModeBridges(
      {
        origin,
        destination: to,
        preferences: {
          ...DEFAULT_PREFERENCES,
          allowBicycle: true,
          bicycleReady: true,
          maxBicycleMeters: 3000,
          allowScooter: false,
          allowEbike: false,
        },
      },
      [],
      {
        now: NOW,
        budget: new CallBudget(20),
        provider,
        mobility: stationFeed([
          { id: 'hire', north: 20 },
          { id: 'drop', north: 880 },
        ]),
        onDiagnostics: (value) => {
          diagnostics = value;
        },
      },
    );
    return { bridges, diagnostics };
  };
  const free = await run(true);
  assert.ok(
    free.bridges.some((route) => route.segments.some((segment) => segment.mode === 'bicycle')),
    'self-hosted walks and rides cost nothing, so any saving is worth routing',
  );
  const paid = await run(false);
  assert.equal(paid.diagnostics.rentalAttempts, 0, 'paid lookups still need a minute saved');
  assert.ok(paid.diagnostics.unavailableRentals > 0);
  assert.equal(
    paid.diagnostics.rentalLimitedByMode.bicycle,
    0,
    'a screened-out ride is not a limit',
  );
});

test('따릉이 that screens slightly slower than walking is still routed while lookups are free', async () => {
  const to = point('도착', 900);
  // Walk 600 s against 620 s by bicycle with its minute of hire and return: 20 s slower at a walk, yet a
  // routed rental may run its access, so free lookups still route it; paid ones need a minute saved.
  const seconds: Record<string, number> = {
    'origin>도착': 600,
    'origin>hire': 20,
    'drop>도착': 20,
    'hire>drop': 520,
  };
  const name = (place: Place) => place.name;
  const run = async (free: boolean) => {
    const provider: RouteProvider = {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      walking: async (request, budget) =>
        budget.run(() => [
          routeOf([
            leg(
              'walk',
              request.origin,
              request.destination,
              metersBetween(request.origin, request.destination),
              seconds[`${name(request.origin)}>${name(request.destination)}`] ?? 20,
            ),
          ]),
        ]),
      bicycle: async (request, budget) =>
        budget.run(() => [
          routeOf([
            leg('bicycle', request.origin, request.destination, 860, 520, {
              routingProfile: 'bicycle',
            }),
          ]),
        ]),
      travelTable: async (_mode, sources, destinations, budget) =>
        budget.run(() => ({
          seconds: sources.map((source) =>
            destinations.map(
              (destination) => seconds[`${name(source)}>${name(destination)}`] ?? null,
            ),
          ),
        })),
      ...(free ? { unmetered: { walking: true, bicycle: true } } : {}),
    };
    let diagnostics!: BridgeGenerationDiagnostics;
    const bridges = await buildMixedModeBridges(
      {
        origin,
        destination: to,
        preferences: {
          ...DEFAULT_PREFERENCES,
          allowBicycle: true,
          bicycleReady: true,
          maxBicycleMeters: 3000,
          allowScooter: false,
          allowEbike: false,
        },
      },
      [],
      {
        now: NOW,
        budget: new CallBudget(20),
        provider,
        mobility: stationFeed([
          { id: 'hire', north: 20 },
          { id: 'drop', north: 880 },
        ]),
        onDiagnostics: (value) => {
          diagnostics = value;
        },
      },
    );
    return { bridges, diagnostics };
  };
  const free = await run(true);
  assert.ok(
    free.bridges.some((route) => route.segments.some((segment) => segment.mode === 'bicycle')),
    'free lookups route a ride within two minutes of walking',
  );
  const paid = await run(false);
  assert.equal(paid.diagnostics.rentalAttempts, 0, 'paid lookups still need a minute saved');
  assert.ok(paid.diagnostics.unavailableRentals > 0);
  assert.equal(
    paid.diagnostics.rentalLimitedByMode.bicycle,
    0,
    'a screened-out ride is not a limit',
  );
});

test('a walk fetched for a scooter on the spot where an e-bike is hired is named after the e-bike', () => {
  const spot = point('spot', 300);
  const scooterSpot = { ...spot, id: 'gbfs:jigak-sim:JS00001', name: '시연용 가상 킥보드' },
    ebikeSpot = { ...spot, id: 'gbfs:jigak-sim:JB00001', name: '시연용 가상 전기자전거' };
  const route = routeOf([
    {
      ...leg('walk', origin, scooterSpot, 300, 250),
      id: 'walk',
      title: '시연용 가상 킥보드까지 걷기',
    },
    { ...leg('hire', ebikeSpot, ebikeSpot, 0, 30), id: 'hire', polyline: undefined },
    { ...leg('ebike', ebikeSpot, destination, 2700, 600), id: 'ride' },
  ]);
  const named = nameWalksAfterHires(route);
  assert.equal(named.segments[0].title, '시연용 가상 전기자전거까지 걷기');
  assert.equal(named.segments[0].end.id, ebikeSpot.id);
  const station = routeOf([
    { ...leg('walk', origin, spot, 300, 250), id: 'walk' },
    { ...leg('hire', spot, spot, 0, 30), id: 'hire', polyline: undefined },
  ]);
  assert.equal(
    nameWalksAfterHires(station),
    station,
    'a walk already named after its hire is kept',
  );
});

/** The foot network moves a start inside a park or campus `snap` metres west onto its nearest link. */
function snappedStart(devices: Device[], snap: number, recorded = true) {
  const built = fixture(devices);
  const provider = built.context.provider;
  const walking = provider.walking.bind(provider);
  built.context.provider = {
    ...provider,
    walking: async (request, budget) => {
      const routes = await walking(request, budget);
      if (request.origin.id !== origin.id) return routes;
      const start = { ...point('snapped', 0, -snap), name: request.origin.name };
      const gap = metersBetween(request.origin, start);
      return routes.map((route) =>
        routeOf(
          route.segments.map((segment) => ({
            ...segment,
            start,
            polyline: [start, ...segment.polyline!.slice(1)],
            durationSeconds: {
              min: segment.durationSeconds.min,
              max: segment.durationSeconds.max + Math.ceil(gap),
            },
            ...(recorded
              ? {
                  networkSnap: { startMeters: gap, endMeters: 0, allowanceSeconds: Math.ceil(gap) },
                }
              : {}),
          })),
        ),
      );
    },
  };
  return built;
}

test('a start snapped up to 150 m onto the foot network still walks to the device, and the snap counts toward the cap', async () => {
  // 롯데월드 어드벤처: OSRM snaps the start 102 m; a device 300 m away must still be reachable.
  for (const [ride, kind] of [
    [ebikeConnection, 'e-bicycle'],
    [scooterConnection, 'kick-scooter'],
  ] as const) {
    const near = snappedStart([{ id: 'near', kind, north: 300 }], 102);
    const rental = await ride(near.context, preferences, origin, destination, 'n');
    assert.equal(vehicleOf(rental), 'near', `${kind}: a 102 m recorded snap is not a refusal`);
    const access = rental![0];
    assert.equal(access.mode, 'walk');
    assert.deepEqual(access.start, origin, 'the walk still starts at the requested point');
    assert.ok(Math.abs(metersBetween(access.polyline![0], origin) - 102) < 2);
    assert.ok(Math.abs(access.networkSnap!.startMeters - 102) < 2, 'the recorded snap is kept');
  }
  const within = snappedStart([{ id: 'within', kind: 'e-bicycle', north: 300, access: 590 }], 102);
  assert.equal(
    vehicleOf(await ebikeConnection(within.context, preferences, origin, destination, 'w')),
    'within',
    '590 m walked plus 102 m snapped is under 700 m',
  );
  const over = snappedStart([{ id: 'over', kind: 'e-bicycle', north: 300, access: 650 }], 102);
  assert.equal(
    await ebikeConnection(over.context, preferences, origin, destination, 'o'),
    null,
    '650 m walked plus 102 m snapped is over the 700 m cap',
  );
  const unrecorded = snappedStart([{ id: 'gap', kind: 'e-bicycle', north: 300 }], 102, false);
  assert.equal(
    await ebikeConnection(unrecorded.context, preferences, origin, destination, 'u'),
    null,
    'a gap the network never recorded keeps the 75 m limit',
  );
  const far = snappedStart([{ id: 'far', kind: 'e-bicycle', north: 300 }], 160);
  assert.equal(
    await ebikeConnection(far.context, preferences, origin, destination, 'f'),
    null,
    'no snap beyond 150 m is accepted',
  );
});

test("a dockless ride ends at the operator's legal spot and walks on to the destination", async () => {
  const parked = point('parked', 2900, 30);
  const { context, walked } = fixture([{ id: 'e-near', kind: 'e-bicycle', north: 30 }], {
    dropoff: () => parked,
  });
  const segments = await ebikeConnection(context, preferences, origin, destination, 'e');
  assert.deepEqual(
    segments!.map((segment) => segment.mode),
    ['walk', 'hire', 'ebike', 'return', 'walk'],
  );
  assert.equal(segments![3].end.id, 'parked');
  assert.equal(segments![4].start.id, 'parked');
  assert.equal(segments![4].end.id, destination.id);
  assert.ok(walked.includes('egress'));
});

/** origin → 1.6 km walk → subway P1 → P2 → 500 m walk → far, with a slow first walk worth replacing. */
const subwayTrip = () => {
  const far = point('far', 7000),
    p1 = { ...point('P1', 1600), name: '숙대입구역' },
    p2 = { ...point('P2', 6500), name: '서울역' };
  const transit = [
    routeOf([
      { ...leg('walk', origin, p1, 1600, 1500), id: 'walk-a' },
      { ...leg('subway', p1, p2, 4900, 600), id: 'subway', lineName: '4호선' },
      { ...leg('walk', p2, far, 500, 450), id: 'walk-b' },
    ]),
  ];
  const asked: { origin: Place; destination: Place }[] = [];
  const connectTransit = async (endpoints: { origin: Place; destination: Place }) => {
    asked.push(endpoints);
    const entrance = point('entrance', 1610);
    return [
      routeOf([
        { ...leg('walk', endpoints.origin, entrance, 30, 40), id: 'walk-in' },
        { ...leg('subway', entrance, endpoints.destination, 5400, 660), id: 'subway-2' },
      ]),
    ];
  };
  return { far, p1, transit, asked, connectTransit };
};
const spotBy = (near: Place, entrance?: boolean): Place | null =>
  entrance
    ? {
        id: `return-${near.id}`,
        name: `${near.name} 근처`,
        address: '',
        latitude: near.latitude,
        longitude: near.longitude + 20 / 88000,
      }
    : { ...near };

test('an e-bike rides to the legal spot by a station entrance, then the trip continues by subway', async () => {
  const trip = subwayTrip();
  const { context } = fixture(
    [
      { id: 'e-origin', kind: 'e-bicycle', north: 30 },
      { id: 's-origin', kind: 'kick-scooter', north: 30, east: 20 },
    ],
    { returnPoint: spotBy },
  );
  const bridges = await buildMixedModeBridges(
    { origin, destination: trip.far, preferences },
    trip.transit,
    { ...context, connectTransit: trip.connectTransit },
  );
  const continued = trip.asked.filter((query) => query.origin.id === 'return-P1');
  assert.ok(continued.length >= 1, 'the transit query starts at the return spot');
  assert.equal(
    new Set(continued.map((query) => JSON.stringify(query))).size,
    1,
    'kick-scooter and e-bike continuations ask one and the same query',
  );
  for (const mode of ['ebike', 'scooter'] as const) {
    const ride = bridges.find(
      (route) =>
        route.segments.some((segment) => segment.mode === mode) &&
        route.segments.at(-1)!.end.id === 'return-P1',
    );
    assert.ok(ride, `${mode} ends its ride at the spot`);
    assert.equal(ride.segments.at(-1)!.mode, 'return', 'the spot is the dropoff, no egress walk');
  }
  assert.ok(
    bridges.some(
      (route) =>
        route.segments[0].start.id === 'return-P1' &&
        route.segments.some((segment) => segment.mode === 'subway'),
    ),
    'the continuation is published from the spot',
  );
  assert.ok(
    !trip.asked.some((query) => query.origin.id === 'P1' || query.destination.id === 'P1'),
    'never connected to the platform itself',
  );
});

test('after the subway an e-bike starts from the legal spot by the exit and rides the last mile', async () => {
  const far = point('far', 7000),
    p1 = { ...point('P1', 400), name: '숙대입구역' },
    p2 = { ...point('P2', 5400), name: '서울역' };
  const transit = [
    routeOf([
      { ...leg('walk', origin, p1, 400, 330), id: 'walk-a' },
      { ...leg('subway', p1, p2, 5000, 600), id: 'subway', lineName: '4호선' },
      { ...leg('walk', p2, far, 1600, 1500), id: 'walk-b' },
    ]),
  ];
  const asked: { origin: Place; destination: Place }[] = [];
  const connectTransit = async (endpoints: { origin: Place; destination: Place }) => {
    asked.push(endpoints);
    const exit = point('exit', 5390);
    return [
      routeOf([
        { ...leg('subway', endpoints.origin, exit, 5000, 600), id: 'subway-2' },
        { ...leg('walk', exit, endpoints.destination, 30, 40), id: 'walk-out' },
      ]),
    ];
  };
  const { context } = fixture([{ id: 'e-exit', kind: 'e-bicycle', north: 5440 }], {
    returnPoint: spotBy,
  });
  const bridges = await buildMixedModeBridges({ origin, destination: far, preferences }, transit, {
    ...context,
    connectTransit,
  });
  const spots = asked.map((query) => query.destination.id);
  assert.ok(
    spots.some((id) => id.startsWith('return-')),
    `the transit query ends at a return spot (${spots.join(', ')})`,
  );
  assert.ok(
    asked.every((query) => query.origin.id === origin.id),
    'last-mile queries start at the trip origin',
  );
  const ride = bridges.find(
    (route) =>
      route.segments.some((segment) => segment.mode === 'ebike') &&
      route.segments[0].start.id.startsWith('return-') &&
      route.segments.at(-1)!.end.id === far.id,
  );
  assert.ok(ride, 'the e-bike leg starts at the spot and ends at the destination');
});

test('a ride that starts at a chosen exit looks for its spot by that exit, a platform point by the nearest entrance (R2)', async () => {
  const far = point('far', 7000),
    p1 = { ...point('P1', 400), name: '숙대입구역' },
    p2 = { ...point('P2', 5400), name: '서울역' },
    street = point('exit-street', 5420, 30),
    exitNode = point('exit-node', 5415, 25);
  const stationExit = {
    ref: '3',
    kind: 'exit' as const,
    latitude: exitNode.latitude,
    longitude: exitNode.longitude,
    street: { latitude: street.latitude, longitude: street.longitude },
    platformSeconds: 90,
    passageSeconds: 40,
    passageMeters: 50,
    platformBasis: 'default' as const,
    passageBasis: 'assumed' as const,
    dataset: 'subway-exits-v1' as const,
  };
  const via = (withExit: boolean) => [
    routeOf([
      { ...leg('walk', origin, p1, 400, 330), id: 'walk-a' },
      { ...leg('subway', p1, p2, 5000, 600), id: 'subway', lineName: '4호선' },
      ...(withExit
        ? [
            {
              ...leg('entry', p2, street, 70, 120),
              id: 'exit-step',
              stationExit,
              runAllowed: false,
            },
          ]
        : []),
      { ...leg('walk', withExit ? street : p2, far, 1600, 1500), id: 'walk-b' },
    ]),
  ];
  const run = async (withExit: boolean) => {
    const asks: { near: string; entrance?: boolean }[] = [];
    const { context } = fixture([{ id: 'e-exit', kind: 'e-bicycle', north: 5440 }], {
      returnPoint: (near, entrance) => {
        asks.push({ near: near.id, entrance });
        return spotBy(near, entrance);
      },
    });
    await buildMixedModeBridges({ origin, destination: far, preferences }, via(withExit), {
      ...context,
      connectTransit: async (endpoints) => [
        routeOf([
          { ...leg('subway', endpoints.origin, point('x', 5390), 5000, 600), id: 'subway-2' },
          { ...leg('walk', point('x', 5390), endpoints.destination, 30, 40), id: 'walk-out' },
        ]),
      ],
    });
    return asks.filter((ask) => ask.near === (withExit ? street.id : p2.id));
  };
  const chosen = await run(true);
  assert.ok(chosen.length >= 1, 'the exit street point is the anchor of the last-mile ride');
  assert.ok(
    chosen.every((ask) => ask.entrance === false),
    'at a chosen exit the spot is by that exit, not by the nearest mapped entrance',
  );
  const platform = await run(false);
  assert.ok(platform.length >= 1);
  assert.ok(
    platform.every((ask) => ask.entrance === true),
    'a platform point without exit data keeps the entrance search',
  );
});

test('a dockless ride never continues into transit without an operator spot, nor on both sides', async () => {
  const trip = subwayTrip();
  const { context } = fixture([{ id: 'e-origin', kind: 'e-bicycle', north: 30 }]);
  await buildMixedModeBridges({ origin, destination: trip.far, preferences }, trip.transit, {
    ...context,
    connectTransit: trip.connectTransit,
  });
  assert.deepEqual(trip.asked, [], 'no spot, no continuation query');
  const withSpot = subwayTrip();
  const { context: spotted } = fixture([{ id: 'e-origin', kind: 'e-bicycle', north: 30 }], {
    returnPoint: spotBy,
  });
  await buildMixedModeBridges(
    { origin, destination: withSpot.far, preferences },
    withSpot.transit,
    { ...spotted, connectTransit: withSpot.connectTransit },
  );
  assert.ok(withSpot.asked.length >= 1);
  assert.ok(
    withSpot.asked.every(
      (query) => query.origin.id === origin.id || query.destination.id === withSpot.far.id,
    ),
    "every query joins the trip's own origin or destination: one-sided only",
  );
});

test('kick-scooter and e-bike continue from their own spots, one transit query each', async () => {
  const trip = subwayTrip();
  const ownSpot: DocklessRentalPolicy['returnPoint'] = (near, entrance, mode) =>
    entrance
      ? {
          ...spotBy(near, true)!,
          id: `return-${near.id}-${mode}`,
          longitude: near.longitude + (mode === 'scooter' ? 80 : 20) / 88000,
        }
      : { ...near };
  const { context } = fixture(
    [
      { id: 'e-origin', kind: 'e-bicycle', north: 30 },
      { id: 's-origin', kind: 'kick-scooter', north: 30, east: 20 },
    ],
    { returnPoint: ownSpot },
  );
  const bridges = await buildMixedModeBridges(
    { origin, destination: trip.far, preferences },
    trip.transit,
    { ...context, connectTransit: trip.connectTransit },
  );
  for (const mode of ['ebike', 'scooter'] as const) {
    const spot = `return-P1-${mode}`;
    assert.ok(
      trip.asked.some((query) => query.origin.id === spot),
      `${mode} asks its query from its own spot`,
    );
    assert.ok(
      bridges.some(
        (route) =>
          route.segments.some((segment) => segment.mode === mode) &&
          route.segments.at(-1)!.end.id === spot,
      ),
      `${mode} ends its ride at its own spot`,
    );
  }
});

test('a dockless continuation asks no transit query before a device is found', async () => {
  const trip = subwayTrip();
  const { context } = fixture([], { returnPoint: spotBy });
  const metered: string[] = [];
  const provider: RouteProvider = {
    ...context.provider,
    transit: async (endpoints, budget) =>
      budget.run(() => {
        metered.push(`${endpoints.origin.id}->${endpoints.destination.id}`);
        return [];
      }),
  };
  const bridges = await buildMixedModeBridges(
    { origin, destination: trip.far, preferences },
    trip.transit,
    { ...context, provider, connectTransit: trip.connectTransit },
  );
  assert.deepEqual(metered, [], 'no prefetched transit query without a device');
  assert.deepEqual(trip.asked, []);
  assert.equal(bridges.filter(Boolean).length, 0);
});

test('a destination no kick-scooter may end near refuses every device, not a search cut short', async () => {
  const devices = Array.from({ length: 25 }, (_, index) => ({
    id: `s-${index}`,
    kind: 'kick-scooter' as const,
    north: 10 + index,
  }));
  const { context, verified } = fixture(devices, {
    returnPoint: (near, entrance, mode) => (mode === 'scooter' ? null : { ...near }),
  });
  let limited = 0;
  const segments = await scooterConnection(
    { ...context, onScooterCandidateLimited: (count) => (limited += count) },
    preferences,
    origin,
    destination,
    's',
  );
  assert.equal(segments, null);
  assert.equal(limited, 0, 'more devices would be refused alike');
  assert.deepEqual(verified, [], 'no device is asked for');
});

test('without a confirmed licence no kick-scooter is rented; the e-bike still is', async () => {
  const { context, verified } = fixture([
    { id: 'e-origin', kind: 'e-bicycle', north: 30 },
    { id: 's-origin', kind: 'kick-scooter', north: 30, east: 20 },
  ]);
  const unlicensed = { ...preferences, hasScooterLicense: false };
  assert.equal(await scooterConnection(context, unlicensed, origin, destination, 's'), null);
  await buildMixedModeBridges({ origin, destination, preferences: unlicensed }, [], context);
  assert.ok(verified.length > 0);
  assert.ok(verified.every((call) => call.mode === 'ebike'));
});

/** The operator's spot by a destination lies `south` metres short of it; by a station, beside it. */
const spotShortOf =
  (south: number): NonNullable<DocklessRentalPolicy['returnPoint']> =>
  (near, entrance) =>
    entrance
      ? spotBy(near, true)
      : {
          ...near,
          id: `return-${near.id}`,
          name: `${near.name} 지정 구역`,
          latitude: near.latitude - south / 111195,
        };

test('a destination whose only legal spot is beyond the egress walk refuses every device unsearched', async () => {
  const devices: Device[] = Array.from({ length: 25 }, (_, index) => ({
    id: `s${index}`,
    kind: 'kick-scooter' as const,
    north: 20 + index * 10,
  }));
  const { context, verified } = fixture(devices, { returnPoint: spotShortOf(600) });
  const seen = { blocked: 0, limited: 0 };
  const hooks = {
    onReturnBlocked: () => seen.blocked++,
    onCandidateLimited: () => seen.limited++,
  };
  const profile = DOCKLESS_PROFILES.scooter;
  assert.equal(
    await docklessConnection(context, profile, preferences, origin, destination, 'x', hooks),
    null,
  );
  assert.deepEqual(seen, { blocked: 1, limited: 0 }, 'not a search cut short');
  assert.equal(verified.length, 0, 'no device is asked for');
  const none = fixture(devices, { returnPoint: () => null });
  assert.equal(
    await docklessConnection(none.context, profile, preferences, origin, destination, 'y', hooks),
    null,
  );
  assert.equal(seen.blocked, 2, 'no spot at all is the same reason');
});

test('on a free walking network a legal spot walled off from the destination is too far', async () => {
  const devices: Device[] = [{ id: 'e1', kind: 'e-bicycle', north: 40 }];
  const run = async (walkedMeters: number) => {
    const { context, verified } = fixture(devices, {
      free: true,
      returnPoint: spotShortOf(300),
      dropoff: (to) => spotShortOf(300)(to)!,
    });
    const walking = context.provider.walking.bind(context.provider);
    context.provider = {
      ...context.provider,
      // A railway between the spot and the destination: the walk goes round it.
      walking: async (request, budget) =>
        request.origin.id.startsWith('return-')
          ? [
              routeOf([
                leg('walk', request.origin, request.destination, walkedMeters, walkedMeters / 1.2),
              ]),
            ]
          : walking(request, budget),
    };
    let blocked = 0;
    const segments = await docklessConnection(
      context,
      DOCKLESS_PROFILES.ebike,
      preferences,
      origin,
      destination,
      'w',
      { onReturnBlocked: () => blocked++ },
    );
    return { segments, blocked, verified: verified.length };
  };
  const walledOff = await run(700);
  assert.deepEqual(walledOff, { segments: null, blocked: 1, verified: 0 });
  const reachable = await run(350);
  assert.equal(reachable.blocked, 0);
  assert.equal(vehicleOf(reachable.segments), 'e1');
  assert.equal(reachable.segments!.at(-1)!.distanceMeters, 350, 'the rider walks on from the spot');
});

test('an empty kick-scooter tab names the missing legal return, not a search cut short', async () => {
  const devices: Device[] = [
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `s${index}`,
      kind: 'kick-scooter' as const,
      north: 20 + index * 10,
    })),
    { id: 'e1', kind: 'e-bicycle', north: 60 },
  ];
  // 용산구 R21: kick-scooters may end only at a spot 600 m short; e-bikes park by the destination.
  const { context } = fixture(devices, {
    returnPoint: (near, entrance, mode) =>
      mode === 'scooter' && !entrance ? spotShortOf(600)(near, entrance) : spotBy(near, entrance),
  });
  let diagnostics!: BridgeGenerationDiagnostics;
  const bridges = await buildMixedModeBridges({ origin, destination, preferences }, [], {
    ...context,
    onDiagnostics: (value) => {
      diagnostics = value;
    },
  });
  assert.deepEqual(diagnostics.returnBlockedByMode, { bicycle: 0, scooter: 1, ebike: 0 });
  assert.equal(diagnostics.rentalLimitedByMode.scooter, 0);
  const availability = rentalAvailabilityForSearch({
    preferences,
    routes: bridges,
    capabilities: {
      bicycleFeed: true,
      scooterFeed: true,
      ebikeFeed: true,
      bicycleRouter: true,
      scooterRouter: true,
      ebikeRouter: true,
      scooterRentalPolicy: true,
      ebikeRentalPolicy: true,
    },
    diagnostics: rentalLimitDiagnostics(diagnostics),
  });
  assert.deepEqual(availability.scooter, { status: 'not-found', reason: 'no-legal-return' });
  assert.equal(availability.ebike?.status, 'included');
});
