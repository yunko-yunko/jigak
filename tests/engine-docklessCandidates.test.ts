// Dockless candidate selection and the map/GBFS reads at the real Seoul fleet (CONTRACT4 §1.4, 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import {
  MAX_MARKERS_PER_GROUP,
  MAX_SNAPSHOT_MARKERS,
  MobilityFeeds,
  type VehicleFeed,
  type VehicleFeedQuery,
} from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  docklessConnection,
  DOCKLESS_PROFILES,
  ROUTER_DEVICES_PER_KIND,
  ROUTER_FEED_PER_KIND,
  type DocklessConnectionContext,
  type DocklessRentalPolicy,
} from '../src/common/engine/scooter-bridge.js';
import { SimulatedVehicleFeed } from '../src/common/engine/simulation/simulated-vehicle-feed.js';
import type { SharedScooterSimulation } from '../src/common/engine/simulation/shared-scooter-sim.js';
import {
  gbfsVehicleStatusBody,
  MAX_BODY_BYTES,
} from '../src/modules/simulation/domain/gbfs-feed.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';
import type { MobilityMarker } from '../src/common/shared/intelligence/types.js';

const NOW = Date.UTC(2026, 10, 1, 3);
const point = (id: string, north: number, east = 0): Place => ({
  id,
  name: id,
  address: '',
  latitude: 37.55 + north / 111195,
  longitude: 126.97 + east / 88000,
});
const origin = point('origin', 0),
  destination = point('destination', 2000);
const preferences = { ...DEFAULT_PREFERENCES, allowBicycle: false, allowEbike: true };
const MODEL = 'model-1';

interface Device {
  id: string;
  north: number;
  east?: number;
  battery?: number;
  /** Seconds the operator's permission lasts; an hour by default. */
  validSeconds?: number;
  /** Routed walk to the device, metres; the straight line by default. */
  access?: number;
}
const leg = (
  mode: BaseSegment['mode'],
  from: Place,
  to: Place,
  meters: number,
  seconds: number,
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
  ...(mode === 'ebike' ? { routingProfile: 'ebike' as const } : {}),
});
const routeOf = (segment: BaseSegment): BaseRoute => ({
  id: segment.id,
  title: 'fixture',
  segments: [segment],
  transfers: 0,
  distanceMeters: segment.distanceMeters,
  durationSeconds: { ...segment.durationSeconds },
});

/** A free-network search over fixed devices; every call is counted. */
function rig(devices: Device[], options: { simulated?: boolean; free?: boolean } = {}) {
  const simulated = options.simulated ?? true;
  const calls = { walking: 0, ride: 0, table: 0, rides: [] as string[], verified: [] as string[] };
  const queries: (VehicleFeedQuery | undefined)[] = [];
  const tables: number[] = [];
  const marker = (device: Device): MobilityMarker => {
    const at = point(device.id, device.north, device.east);
    return {
      id: `gbfs:fixture:${device.id}`,
      sourceId: device.id,
      provider: 'fixture-operator',
      kind: 'e-bicycle',
      entity: 'vehicle',
      name: device.id,
      latitude: at.latitude,
      longitude: at.longitude,
      distanceMeters: Math.round(metersBetween(origin, at)),
      available: true,
      availableCount: 1,
      batteryPercent: device.battery ?? 80,
      observedAt: NOW,
      receivedAt: NOW,
      freshness: 'fresh',
      source: 'gbfs',
      returnPolicy: 'unverified',
      ...(simulated ? { simulated: true as const } : {}),
    };
  };
  const feed: VehicleFeed = {
    provider: 'fixture-operator',
    lastFailure: null,
    simulated,
    kinds: ['e-bicycle'],
    nearby: async (_point, _radius, query) => {
      queries.push(query);
      return devices.map(marker);
    },
  };
  const deviceAt = (place: Place) => devices.find((device) => place.id.endsWith(`:${device.id}`));
  const policy: DocklessRentalPolicy = {
    modelVersion: MODEL,
    verify: async ({ vehicle, destination: to }) => {
      calls.verified.push(vehicle.id);
      const device = devices.find((item) => item.id === vehicle.id)!;
      return {
        vehicleId: vehicle.id,
        provider: vehicle.provider,
        dropoff: { ...to },
        verifiedAt: NOW,
        validUntil: NOW + (device.validSeconds ?? 3600) * 1000,
        pickupAllowed: true,
        returnAllowed: true,
        eligibilityAllowed: true,
        hireSeconds: 30,
        returnSeconds: 45,
        unlockFeeWon: 600,
        perMinuteWon: 160,
        returnFeeWon: 0,
        ...(simulated
          ? {
              provenance: {
                mode: 'live' as const,
                provider: 'jigak-sim',
                label: '시연용 가상 전기자전거',
                sourceTimestamp: NOW,
                receivedAt: NOW,
                isRealtime: false,
                simulated: true as const,
                modelVersion: MODEL,
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
    provider: {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      ...(options.free === false
        ? {}
        : {
            unmetered: { walking: true, bicycle: true },
            travelTable: async (_mode, sources, targets) => {
              calls.table++;
              tables.push(sources.length + targets.length);
              return {
                seconds: sources.map((source) =>
                  targets.map((target) => metersBetween(source, target) / 3),
                ),
              };
            },
          }),
      walking: async (request, budget) =>
        budget.run(() => {
          calls.walking++;
          const device = deviceAt(request.destination);
          const meters = device?.access ?? metersBetween(request.origin, request.destination);
          return [routeOf(leg('walk', request.origin, request.destination, meters, meters / 1.2))];
        }),
      ebike: async (request, budget) =>
        budget.run(() => {
          calls.ride++;
          calls.rides.push(deviceAt(request.origin)!.id);
          const meters = metersBetween(request.origin, request.destination);
          return [routeOf(leg('ebike', request.origin, request.destination, meters, meters / 5))];
        }),
    },
    ebikePolicy: policy,
  };
  return { context, calls, queries, tables };
}
const search = (
  context: DocklessConnectionContext,
  hooks: Parameters<typeof docklessConnection>[6] = {},
) =>
  docklessConnection(
    context,
    DOCKLESS_PROFILES.ebike,
    preferences,
    origin,
    destination,
    'cand',
    hooks,
  );
const vehicleOf = (segments: BaseSegment[] | null) =>
  segments?.find((segment) => segment.mode === 'hire')?.rentalValidity?.vehicleId;
const total = (calls: ReturnType<typeof rig>['calls']) => calls.walking + calls.ride;

test('a simulated device is usable at any charge the simulator shows; a real operator device under 20% is not', async () => {
  const device = { id: 'low', north: 100, battery: 8 };
  const simulated = rig([device], { simulated: true });
  assert.equal(vehicleOf(await search(simulated.context)), 'low');
  const real = rig([device], { simulated: false });
  assert.equal(await search(real.context), null);
  assert.equal(real.calls.verified.length, 0, 'the flat threshold still guards real feeds');
  const enough = rig([{ ...device, battery: 20 }], { simulated: false });
  assert.equal(vehicleOf(await search(enough.context)), 'low');
});

test('the feed is asked for 600 devices of the asked kind only; the search keeps 200 of them', async () => {
  const { context, queries } = rig([{ id: 'a', north: 100 }]);
  await search(context);
  assert.deepEqual(queries, [{ kind: 'e-bicycle', perKind: 600 }]);
  assert.equal(ROUTER_FEED_PER_KIND, 600);
  assert.equal(ROUTER_DEVICES_PER_KIND, 200);
});

test('the 200 kept are those on the way, not merely the nearest (startup-spec §4.4)', async () => {
  // 200 devices 330-450 m behind the rider, 60 on the way 520-690 m ahead: the nearest 200 are all
  // behind, yet a walk ahead plus the shorter ride beats most of them.
  const behind: Device[] = Array.from({ length: 200 }, (_, index) => ({
    id: `b${index}`,
    north: -(330 + (index % 10) * 12),
    east: (Math.floor(index / 10) - 10) * 12,
  }));
  const ahead: Device[] = Array.from({ length: 60 }, (_, index) => ({
    id: `a${index}`,
    north: 520 + (index % 6) * 30,
    east: (Math.floor(index / 6) - 5) * 12,
  }));
  const { context } = rig([...behind, ...ahead]);
  const tabled: string[] = [];
  const table = context.provider.travelTable!.bind(context.provider);
  context.provider.travelTable = async (mode, sources, targets, budget) => {
    if (mode === 'walking') tabled.push(...targets.map((target) => target.id));
    return table(mode, sources, targets, budget);
  };
  await docklessConnection(
    context,
    DOCKLESS_PROFILES.ebike,
    preferences,
    origin,
    point('far', 6000),
    'cand',
  );
  assert.ok(tabled.length > 0, 'a travel table was asked');
  assert.ok(
    tabled.some((id) => id.startsWith('a')),
    `devices on the way reach the table: ${tabled.slice(0, 8).join(',')}`,
  );
});

test('devices within 10 m are one pickup: a pile costs one ride and one walk, led by the best charge', async () => {
  const pile: Device[] = Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`,
    north: 100,
    east: (index % 3) * 2,
    battery: 30 + index,
  }));
  const { context, calls } = rig(pile);
  const chosen = await search(context);
  assert.equal(vehicleOf(chosen), 'p11', 'the best-charged device of the pile');
  assert.deepEqual(calls.rides, ['p11'], 'one comparison, not twelve');
  assert.equal(calls.walking, 1, 'one walk to the pile; the ride ends at the destination');
  assert.ok(calls.verified.length <= 4, 'only the head and three behind it are asked');
});

test('a device about to be rented is passed over for the next of its pickup', async () => {
  const pile: Device[] = [
    { id: 'leaving', north: 100, battery: 90, validSeconds: 40 },
    { id: 'staying', north: 100, battery: 70 },
    { id: 'low', north: 100, battery: 40 },
  ];
  const { context, calls } = rig(pile);
  assert.equal(vehicleOf(await search(context)), 'staying');
  assert.deepEqual(calls.rides, ['staying']);
});

test('when the best-charged device of a pile cannot be walked to, the one nearer the rider is tried', async () => {
  const devices: Device[] = [
    { id: 'far-end', north: 400, battery: 90, access: 720 },
    { id: 'near-end', north: 395, east: 3, battery: 50, access: 690 },
  ];
  const { context, calls } = rig(devices);
  assert.equal(vehicleOf(await search(context)), 'near-end');
  assert.deepEqual(calls.rides, ['far-end', 'near-end']);
});

test('a search routes at most seven devices: 24 route calls however many stand near', async () => {
  // Forty distinct spots on the way; every walk is over the 700 m cap, so every device is refused after routing.
  const devices: Device[] = Array.from({ length: 40 }, (_, index) => ({
    id: `d${index}`,
    north: 60 + index * 12,
    access: 800,
  }));
  const { context, calls } = rig(devices);
  let omitted = 0;
  assert.equal(
    await search(context, {
      onCandidateLimited: (count) => {
        omitted += count;
      },
    }),
    null,
  );
  assert.equal(calls.ride, 7);
  assert.ok(total(calls) <= 24, `route calls ${total(calls)}`);
  assert.ok(omitted > 0, 'devices that could have been reached are left unrouted and reported');
});

test('on free networks a search asks for two travel tables of at most 50 devices each', async () => {
  const devices: Device[] = Array.from({ length: 120 }, (_, index) => ({
    id: `t${index}`,
    north: 40 + index * 5,
    east: (index % 7) * 15,
  }));
  const { context, calls, tables } = rig(devices);
  await search(context);
  assert.equal(calls.table, 2);
  assert.ok(
    tables.every((points) => points <= 51),
    `table sizes ${tables}`,
  );
});

test('devices that cannot beat the best rental are not an omission, however many there are', async () => {
  // Three good spots on the way, and thirty behind the rider whose best case is already slower.
  const good: Device[] = [
    { id: 'g1', north: 50 },
    { id: 'g2', north: 90, east: 30 },
    { id: 'g3', north: 130, east: -30 },
  ];
  const behind: Device[] = Array.from({ length: 30 }, (_, index) => ({
    id: `b${index}`,
    north: -450 - index * 5,
    east: index * 12,
  }));
  const { context, calls } = rig([...good, ...behind]);
  let omitted = 0;
  const chosen = await search(context, {
    onCandidateLimited: (count) => {
      omitted += count;
    },
  });
  assert.ok(['g1', 'g2', 'g3'].includes(vehicleOf(chosen)!));
  assert.equal(omitted, 0, 'no unrouted device could arrive sooner');
  assert.ok(
    calls.rides.every((id) => id.startsWith('g')),
    'and none of them was routed',
  );
});

test('an unrouted device that could arrive sooner is reported as an omission', async () => {
  // The three spots routed first walk 290 m each, under three times their straight line, so
  // they are plain slow walks; a quicker spot beyond them is not routed.
  const slow: Device[] = [
    { id: 's1', north: 100, access: 290 },
    { id: 's2', north: 110, east: 30, access: 290 },
    { id: 's3', north: 120, east: -30, access: 290 },
    { id: 'quick', north: 200, east: 100 },
  ];
  const { context, calls } = rig(slow);
  let omitted = 0;
  await search(context, {
    onCandidateLimited: (count) => {
      omitted += count;
    },
  });
  assert.equal(calls.rides.length, 3);
  assert.equal(omitted, 1);
});

test('devices whose walk loops do not use up the comparisons, so a plain walk is still found', async () => {
  // Three spots 20–40 m away that the foot network reaches only by a 680 m loop (no crossing).
  const looping: Device[] = [
    { id: 'l1', north: 20, access: 680 },
    { id: 'l2', north: 30, east: 20, access: 680 },
    { id: 'l3', north: 40, east: -20, access: 680 },
    { id: 'plain', north: 200, east: 100 },
  ];
  const { context, calls } = rig(looping);
  let omitted = 0;
  const chosen = await search(context, {
    onCandidateLimited: (count) => {
      omitted += count;
    },
  });
  assert.equal(vehicleOf(chosen), 'plain');
  assert.deepEqual(calls.rides.sort(), ['l1', 'l2', 'l3', 'plain']);
  assert.equal(omitted, 0);
});

test('a device whose walk loops still wins when its rental is the fastest', async () => {
  // A 200 m walk to a device 30 m away loops, but every other device stands far behind.
  const devices: Device[] = [
    { id: 'loop', north: 30, access: 200 },
    { id: 'far1', north: -500 },
    { id: 'far2', north: -520, east: 40 },
    { id: 'far3', north: -540, east: -40 },
  ];
  const { context } = rig(devices);
  assert.equal(vehicleOf(await search(context)), 'loop');
});

test('a device the tabled walk shows looping is routed after the plain ones', async () => {
  const devices: Device[] = [
    { id: 'loop', north: 10, access: 600 },
    { id: 'p1', north: 150 },
    { id: 'p2', north: 160, east: 40 },
    { id: 'p3', north: 170, east: -40 },
  ];
  const { context, calls } = rig(devices);
  const table = context.provider.travelTable!.bind(context.provider);
  context.provider.travelTable = async (mode, sources, targets, budget) => {
    const result = await table(mode, sources, targets, budget);
    // The foot network walks 600 m to the device 10 m away: 432 s at 5 km/h.
    if (mode === 'walking')
      targets.forEach((target, index) => {
        if (target.id === 'loop') result.seconds[0][index] = 432;
      });
    return result;
  };
  let omitted = 0;
  const chosen = await search(context, {
    onCandidateLimited: (count) => {
      omitted += count;
    },
  });
  assert.equal(calls.rides[0], 'p1', 'plain walks are routed first');
  assert.ok(['p1', 'p2', 'p3'].includes(vehicleOf(chosen)!));
  assert.equal(omitted, 0, 'a looping device left unrouted is not reported as an omission');
});

// ---- the simulated feed, the map snapshot and the GBFS body ----

type Type = 'kick-scooter' | 'e-bike';
const simulatedVehicle = (type: Type, index: number, meters: number) => ({
  id: `${type === 'e-bike' ? 'JB' : 'JS'}${String(index).padStart(5, '0')}`,
  type,
  latitude: origin.latitude + meters / 111195,
  longitude: origin.longitude,
  battery: 60,
  distanceMeters: meters,
});
/**
 * A simulation that answers `nearby` with every device of each type, nearest first, and counts
 * each type in the radius when asked for `totals` (VTYPE order: scooter, e-bike).
 */
function stubSimulation(perType: number, ebikes = perType, ready = true) {
  const list = (['kick-scooter', 'e-bike'] as const)
    .flatMap((type) =>
      Array.from({ length: type === 'e-bike' ? ebikes : perType }, (_, index) =>
        simulatedVehicle(type, index, 1 + index * 0.7 + (type === 'e-bike' ? 0.3 : 0)),
      ),
    )
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
  const asked: unknown[] = [];
  const simulation = {
    fleets: { scooter: perType, ebike: ebikes },
    vehicleTypes: ['kick-scooter', 'e-bike'],
    modelVersion: MODEL,
    isReady: () => ready,
    nearby: (
      _point: unknown,
      radius: number,
      _time: number,
      _which: string,
      options: { perType?: number; totals?: number[] },
    ) => {
      asked.push({ ...options, ...(options.totals ? { totals: 'out' } : {}) });
      if (!ready) return [];
      const within = list.filter((v) => v.distanceMeters <= radius);
      if (options.totals) {
        options.totals.length = 0;
        options.totals.push(
          within.filter((v) => v.type === 'kick-scooter').length,
          within.filter((v) => v.type === 'e-bike').length,
        );
      }
      return within;
    },
  } as unknown as SharedScooterSimulation;
  return { simulation, asked };
}

test('the simulated feed reads at most 1,500 of each type nearest first, what the caller asks otherwise', async () => {
  const { simulation, asked } = stubSimulation(1600);
  const feed = new SimulatedVehicleFeed(simulation, { now: () => NOW });
  const count = (markers: MobilityMarker[], kind: string) =>
    markers.filter((item) => item.kind === kind).length;
  const map = await feed.nearby(origin, 1200);
  assert.equal(count(map, 'kick-scooter'), MAX_MARKERS_PER_GROUP);
  assert.equal(count(map, 'e-bicycle'), MAX_MARKERS_PER_GROUP);
  const router = await feed.nearby(origin, 1200, { kind: 'e-bicycle', perKind: 200 });
  assert.deepEqual(asked, [{ perType: 1500 }, { perType: 200 }], 'the window skips the rest');
  assert.equal(router.length, 200);
  assert.ok(router.every((item) => item.kind === 'e-bicycle'));
  assert.deepEqual(
    router.map((item) => item.distanceMeters),
    [...router].map((item) => item.distanceMeters).sort((a, b) => a - b),
  );
});

test('the map snapshot keeps at most 1,000 markers by default, shared by true counts, nearest first', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(1500).simulation, { now: () => NOW });
  const mobility = new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] });
  const snapshot = await mobility.snapshot(origin, 1200);
  assert.equal(MAX_SNAPSHOT_MARKERS, 1000, 'older apps accept at most 1,000 markers');
  assert.equal(snapshot.markers.length, MAX_SNAPSHOT_MARKERS);
  for (const kind of ['kick-scooter', 'e-bicycle'])
    assert.equal(
      snapshot.markers.filter((item) => item.kind === kind).length,
      MAX_SNAPSHOT_MARKERS / 2,
    );
  assert.deepEqual(snapshot.totals, { 'kick-scooter': 1500, 'e-bicycle': 1500 });
  assert.deepEqual(
    snapshot.markers.map((item) => item.distanceMeters),
    [...snapshot.markers].map((item) => item.distanceMeters).sort((a, b) => a - b),
  );
  assert.ok(
    JSON.stringify(snapshot).length <= 450_000,
    'a dense fleet cannot swell the map answer',
  );
  const line = snapshot.sources.find((source) => source.source === 'gbfs')!.message;
  assert.match(
    line,
    /반경 안 총 3,000대\(킥보드 1,500대·전기자전거 1,500대\) 중 가까운 1,000대만 지도에 보여요\./,
  );
});

/** 따릉이 stations as a feed of station markers 1-30 m away. */
const stationFeed = (count: number): VehicleFeed => ({
  provider: '따릉이 fixture',
  lastFailure: null,
  kinds: ['bicycle'],
  nearby: async () =>
    Array.from({ length: count }, (_, index) => ({
      id: `station-${index}`,
      sourceId: `station-${index}`,
      provider: '따릉이',
      kind: 'bicycle' as const,
      entity: 'station' as const,
      name: `대여소 ${index}`,
      latitude: origin.latitude,
      longitude: origin.longitude,
      distanceMeters: 1 + index,
      available: true,
      availableCount: 3,
      batteryPercent: null,
      observedAt: null,
      receivedAt: NOW,
      freshness: 'unknown' as const,
      source: 'gbfs' as const,
      returnPolicy: 'station' as const,
    })),
});

test('the map follows the true e-bike to scooter mix and keeps every station (startup-spec §5.3)', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(400, 1500).simulation, { now: () => NOW });
  const mobility = new MobilityFeeds({
    now: () => NOW,
    vehicleFeeds: [stationFeed(30), feed],
  });
  const snapshot = await mobility.snapshot(origin, 1200);
  const count = (kind: string) => snapshot.markers.filter((item) => item.kind === kind).length;
  assert.equal(snapshot.markers.length, MAX_SNAPSHOT_MARKERS);
  assert.equal(count('bicycle'), 30);
  const ratio = count('e-bicycle') / count('kick-scooter');
  assert.ok(Math.abs(ratio - 1500 / 400) <= 0.2, `e-bike : scooter ${ratio}`);
  assert.deepEqual(snapshot.totals, { bicycle: 30, 'kick-scooter': 400, 'e-bicycle': 1500 });
  const [stations, simulated] = snapshot.sources.filter((source) => source.source === 'gbfs');
  assert.doesNotMatch(stations.message, /반경 안/, 'a row that was not cut says nothing');
  assert.match(
    simulated.message,
    /반경 안 총 1,900대\(킥보드 400대·전기자전거 1,500대\) 중 가까운 970대만 지도에 보여요\./,
  );
});

test('a radius under the limit shows everything and says nothing about a cut', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(100, 300).simulation, { now: () => NOW });
  const mobility = new MobilityFeeds({ now: () => NOW, vehicleFeeds: [stationFeed(20), feed] });
  const snapshot = await mobility.snapshot(origin, 1200);
  assert.equal(snapshot.markers.length, 420);
  assert.ok(snapshot.sources.every((source) => !source.message.includes('반경 안')));
});

test('an app asking for more markers or fewer kinds gets them, never past 2,500', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(1500, 1500).simulation, { now: () => NOW });
  const mobility = new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] });
  const wide = await mobility.snapshot(origin, 2000, { limit: 2000 });
  assert.equal(wide.markers.length, 2000);
  const ebikes = await mobility.snapshot(origin, 2000, { limit: 2000, kinds: ['e-bicycle'] });
  assert.equal(ebikes.markers.length, 1500, 'one kind is at most 1,500');
  assert.ok(ebikes.markers.every((item) => item.kind === 'e-bicycle'));
  assert.deepEqual(ebikes.totals, { 'e-bicycle': 1500 });
  await assert.rejects(() => mobility.snapshot(origin, 2000, { limit: 2501 }), RangeError);
});

test('a rare kind keeps a floor of 5 % of the limit next to a dense one', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(60, 1500).simulation, { now: () => NOW });
  const mobility = new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] });
  const snapshot = await mobility.snapshot(origin, 2000);
  assert.equal(snapshot.markers.filter((item) => item.kind === 'kick-scooter').length, 50);
  assert.equal(snapshot.markers.filter((item) => item.kind === 'e-bicycle').length, 950);
});

test('while the window is computed the map row says so instead of showing none', async () => {
  const feed = new SimulatedVehicleFeed(stubSimulation(10, 10, false).simulation, {
    now: () => NOW,
  });
  assert.equal(feed.pending, true);
  const snapshot = await new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] }).snapshot(
    origin,
    1200,
  );
  const line = snapshot.sources.find((source) => source.source === 'gbfs')!;
  assert.equal(line.status, 'empty');
  assert.match(line.message, /지금 가상 기기 위치를 계산하고 있어요\. 잠시 뒤 다시 보여요\.$/);
  assert.deepEqual(snapshot.totals, { 'kick-scooter': 0, 'e-bicycle': 0 });
});

const fieldVehicle = (type: Type, index: number) => ({
  ...simulatedVehicle(type, index, 0),
  latitude: 37.4 + (index % 300) * 0.001,
  longitude: 126.8 + Math.floor(index / 300) * 0.001,
  state: 'available',
  rangeMeters: 12_345,
  lastReported: NOW,
});
/** A simulation that lists `scooters` and `ebikes` street vehicles; counts how often the list is built. */
function stubField(scooters: number, ebikes: number) {
  let built = 0;
  const vehicles = [
    ...Array.from({ length: scooters }, (_, index) => fieldVehicle('kick-scooter', index)),
    ...Array.from({ length: ebikes }, (_, index) => fieldVehicle('e-bike', index)),
  ];
  const simulation = {
    modelVersion: MODEL,
    fieldVehicles: () => {
      built++;
      return { ready: true, vehicles };
    },
  } as unknown as SharedScooterSimulation;
  return { simulation, built: () => built };
}

test('the GBFS vehicle_status lists every street vehicle of both types and is built once a minute', () => {
  const { simulation, built } = stubField(14_933, 20_000);
  const first = gbfsVehicleStatusBody(simulation, NOW);
  const document = JSON.parse(first);
  assert.equal(document.total, 34_933);
  assert.equal(document.data.vehicles.length, 34_933);
  assert.equal(document.truncated, false);
  assert.equal(document.ready, true);
  assert.equal(gbfsVehicleStatusBody(simulation, NOW + 30_000), first, 'the same minute');
  assert.equal(built(), 1);
  gbfsVehicleStatusBody(simulation, NOW + 61_000);
  assert.equal(built(), 2, 'the next minute builds again');
});

test('a body past 16 MB is cut by the same share of each type and says so', () => {
  const { simulation } = stubField(40_000, 40_000);
  const document = JSON.parse(gbfsVehicleStatusBody(simulation, NOW));
  const body = JSON.stringify(document);
  assert.ok(body.length <= MAX_BODY_BYTES, `${body.length} bytes`);
  assert.equal(document.total, 80_000);
  assert.equal(document.truncated, true);
  const listed = (type: string) =>
    document.data.vehicles.filter((v: { vehicle_type_id: string }) => v.vehicle_type_id === type)
      .length;
  assert.equal(listed('sim-kick-scooter'), listed('sim-e-bike'), 'neither type starves the other');
  assert.ok(listed('sim-e-bike') > 20_000);
});

test('a feed that is not ready is never kept', () => {
  let ready = false;
  const simulation = {
    modelVersion: MODEL,
    fieldVehicles: () => ({ ready, vehicles: ready ? [fieldVehicle('e-bike', 0)] : [] }),
  } as unknown as SharedScooterSimulation;
  assert.equal(JSON.parse(gbfsVehicleStatusBody(simulation, NOW)).ready, false);
  ready = true;
  const second = JSON.parse(gbfsVehicleStatusBody(simulation, NOW));
  assert.equal(second.ready, true);
  assert.equal(second.data.vehicles.length, 1);
});
