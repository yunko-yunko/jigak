// Routing and the simulator agree on where a dockless ride may end and be ridden (docs §20.3, CONTRACT3 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { MobilityFeeds, type VehicleFeed } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  scooterConnection,
  type DocklessConnectionContext,
  type DocklessRentalPolicy,
  type DocklessVehicle,
} from '../src/common/engine/scooter-bridge.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { parseDoorPoints } from '../src/common/engine/simulation/door-points.js';
import {
  bundledParkingRules,
  ParkingRules,
  parseParkingRules,
  Placement,
} from '../src/common/engine/simulation/parking-rules.js';
import { RETURN, ReturnRules } from '../src/common/engine/simulation/return-rules.js';
import {
  legalDropoff,
  rideAllowedOn,
  SimulatedScooterPolicy,
} from '../src/common/engine/simulation/scooter-policy.js';
import type { SharedScooterSimulation } from '../src/common/engine/simulation/shared-scooter-sim.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';
import type { MobilityMarker } from '../src/common/shared/intelligence/types.js';

const NOW = Date.parse('2026-11-01T14:00:00+09:00');
const TYPES = [
  { type: 'kick-scooter', code: 0, mode: 'scooter', kind: 'kick-scooter' },
  { type: 'e-bike', code: 1, mode: 'ebike', kind: 'e-bicycle' },
] as const;
/** The routing side and a separate copy standing in for the simulator worker's tables. */
const routing = new ParkingRules(bundledParkingRules(), bundledDemand());
const simulator = new ParkingRules(bundledParkingRules(), bundledDemand());

/** Destinations from the reported trips, a 킥보드 없는 거리, a station and a street corner. */
const PLACES: [string, number, number][] = [
  ['숙대입구역', 37.5446, 126.9721],
  ['선린인터넷고', 37.54276, 126.96719],
  ['대치동부센트레빌', 37.49279568772742, 127.05577609518149],
  ['유니브고입대입입시센터학원', 37.5025261092833, 127.058562037964],
  ['홍대 레드로드', 37.5547, 126.9227],
  ['강남역', 37.4979, 127.0276],
  ['여의도공원', 37.5256, 126.9226],
  ['연신내역', 37.619, 126.9213],
];
/** Each place and a 5 × 5 grid 40 m apart around it. */
const POINTS = PLACES.flatMap(([name, latitude, longitude]) =>
  Array.from({ length: 25 }, (_, index): Place => {
    const north = (Math.floor(index / 5) - 2) * 40,
      east = ((index % 5) - 2) * 40;
    return {
      id: `${name}:${index}`,
      name,
      address: '',
      latitude: latitude + north / 111_195,
      longitude: longitude + east / 88_000,
    };
  }),
);

const simulation = (type: 'kick-scooter' | 'e-bike') =>
  ({
    modelVersion: 'sim-1',
    vehicle: (_id: string) => ({
      rentable: true,
      type,
      latitude: 0,
      longitude: 0,
      rangeMeters: 1e9,
    }),
    parkedUntil: (_id: string, now: number) => now + 3_600_000,
  }) as unknown as SharedScooterSimulation;
const device = (kind: DocklessVehicle['kind'], near: Place): DocklessVehicle => ({
  id: 'SIM-1',
  provider: 'jigak-sim',
  source: 'gbfs',
  kind,
  latitude: near.latitude,
  longitude: near.longitude,
  battery: 80,
  distanceMeters: 0,
  observedAt: NOW,
  receivedAt: NOW,
});
const dropoffs = async (type: (typeof TYPES)[number]) => {
  const policy = new SimulatedScooterPolicy(simulation(type.type), routing);
  return Promise.all(
    POINTS.map(
      async (destination) =>
        (
          await policy.verify({
            vehicle: device(type.kind, destination),
            origin: destination,
            destination,
            now: NOW,
            mode: type.mode,
          })
        )?.dropoff ?? null,
    ),
  );
};

test('router dropoffs never fall in a no-return area for the rented type', async () => {
  for (const type of TYPES) {
    const spots = await dropoffs(type);
    const offered = spots.filter((spot) => spot !== null);
    assert.ok(offered.length >= POINTS.length * 0.9, `${type.type}: ${offered.length} offered`);
    for (const spot of offered) {
      assert.notEqual(
        simulator.returnEffect(type.code, spot.latitude, spot.longitude),
        RETURN.NO_RETURN,
        `${type.type} ${spot.id}`,
      );
      assert.equal(simulator.inServiceArea(spot.latitude, spot.longitude), true);
    }
  }
});

test('a router dropoff is where a compliant simulated rider parks for the same point', async () => {
  const out = new Placement();
  for (const type of TYPES) {
    const spots = await dropoffs(type);
    let same = 0;
    spots.forEach((spot, index) => {
      const point = POINTS[index];
      const parked = simulator.legalReturnSpot(type.type, point.latitude, point.longitude, out);
      if (!parked || parked.dockFallback) return;
      same++;
      assert.ok(spot, `${type.type} ${point.id}`);
      // The simulator stores six decimals; a destination that is already legal keeps its own.
      assert.ok(metersBetween(spot, parked) < 0.5, `${type.type} ${point.id}`);
      if (spot.id !== point.id)
        assert.deepEqual([spot.latitude, spot.longitude], [parked.latitude, parked.longitude]);
    });
    assert.ok(same >= POINTS.length * 0.6, `${type.type}: ${same} parked by the point itself`);
  }
});

test('a ride to a door point ends at the spot a simulated rider bound for that door parks at', () => {
  const out = new Placement();
  for (const type of TYPES) {
    let compared = 0;
    for (let door = 0; door < simulator.doors.meta.points; door += 211) {
      const point = {
        latitude: simulator.doorLatitude(door),
        longitude: simulator.doorLongitude(door),
      };
      simulator.doorSpot(type.code, door, out);
      if (out.dockFallback || !simulator.inServiceArea(out.latitude, out.longitude)) continue;
      compared++;
      assert.deepEqual(
        legalDropoff(routing, type.type, point),
        { latitude: out.latitude, longitude: out.longitude },
        `${type.type} door ${door}`,
      );
    }
    assert.ok(compared > 100, `${type.type}: ${compared} doors compared`);
  }
});

test('inside a complex with no allowed spot nearby the dropoff is by its nearest doors', () => {
  const [, latitude, longitude] = PLACES[2];
  for (const type of TYPES) {
    const parked = simulator.legalReturnSpot(type.type, latitude, longitude);
    const spot = legalDropoff(routing, type.type, { latitude, longitude })!;
    assert.ok(spot, type.type);
    assert.notEqual(
      simulator.returnEffect(type.code, spot.latitude, spot.longitude),
      RETURN.NO_RETURN,
    );
    if (parked && !parked.dockFallback)
      assert.deepEqual([spot.latitude, spot.longitude], [parked.latitude, parked.longitude]);
    else assert.ok(metersBetween(spot, { latitude, longitude }) <= 400, type.type);
  }
});

/** A synthetic 킥보드 없는 거리: a straight street 400 m long, banned for kick-scooters (R28). */
const BASE = { latitude: 37.5446, longitude: 126.9721 };
const COS = Math.cos((37.55 * Math.PI) / 180);
const at = (north: number, east: number) => ({
  latitude: BASE.latitude + north / 111_195,
  longitude: BASE.longitude + east / (111_195 * COS),
});
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The builder's codec: zig-zag integers in 5-bit groups, least significant first. */
const pack = (values: number[]) =>
  values
    .map((value) => {
      let z = value >= 0 ? value * 2 : -value * 2 - 1,
        text = '';
      for (;;) {
        const group = z % 32;
        z = Math.floor(z / 32);
        if (z) text += ALPHABET[group | 32];
        else return text + ALPHABET[group];
      }
    })
    .join('');
const west = at(0, -200),
  east = at(0, 200);
const westE6 = [Math.round(west.latitude * 1e6), Math.round(west.longitude * 1e6)];
const eastE6 = [Math.round(east.latitude * 1e6), Math.round(east.longitude * 1e6)];
const streetRules = new ParkingRules(
  parseParkingRules({ version: 'seoul-pm-parking-rules-v1', builtAt: 1 }),
  bundledDemand(),
  {
    returns: new ReturnRules({
      version: 'shared-mobility-return-rules-v1',
      builtAt: 1,
      meta: {
        codec: { alphabet: ALPHABET },
        rules: [
          {
            id: 'R28',
            effect: 'no-return',
            appliesTo: ['kick-scooter'],
            layers: ['noScooterStreet'],
            radiusM: 5,
            ridingBanned: true,
          },
        ],
      },
      layers: {
        noScooterStreet: {
          kind: 'line',
          q: 6,
          n: 1,
          xy: pack([...westE6, eastE6[0] - westE6[0], eastE6[1] - westE6[1]]),
          len: pack([2]),
        },
      },
    }),
    doors: parseDoorPoints(null),
  },
);

test('a kick-scooter ride may cross a 킥보드 없는 거리 but not run along it; e-bikes are not bound', () => {
  const along = [at(-100, -150), at(0, -150), at(0, 150), at(-100, 150)];
  const crossing = [at(-100, 0), at(100, 0)];
  const elsewhere = [at(-100, -150), at(-100, 150)];
  assert.equal(rideAllowedOn(streetRules, 'kick-scooter', along), false);
  assert.equal(rideAllowedOn(streetRules, 'kick-scooter', crossing), true);
  assert.equal(rideAllowedOn(streetRules, 'kick-scooter', elsewhere), true);
  assert.equal(rideAllowedOn(streetRules, 'e-bike', along), true);
  // A scooter does not end its ride on that street either.
  const spot = legalDropoff(streetRules, 'kick-scooter', at(0, 0))!;
  assert.ok(metersBetween(spot, at(0, 0)) > 5);
  assert.deepEqual(legalDropoff(streetRules, 'e-bike', at(0, 0)), {
    latitude: Math.round(at(0, 0).latitude * 1e6) / 1e6,
    longitude: Math.round(at(0, 0).longitude * 1e6) / 1e6,
  });
  const policy = new SimulatedScooterPolicy(simulation('kick-scooter'), streetRules);
  assert.equal(policy.rideAllowed(along, 'scooter'), false);
  assert.equal(policy.rideAllowed(along, 'ebike'), true);
});

/** Dockless search fixture: devices north of the origin, rides through a waypoint `via`. */
function bannedStreetSearch(devices: { id: string; north: number; vias: number[] }[]) {
  const origin = { ...at(-300, 0), id: 'origin', name: 'origin', address: '' };
  const destination = { ...at(-300, 1200), id: 'destination', name: 'destination', address: '' };
  const placeOf = (id: string, north: number): Place => ({
    ...at(-300 + north, 0),
    id,
    name: id,
    address: '',
  });
  const marker = (item: (typeof devices)[number]): MobilityMarker => {
    const spot = placeOf(item.id, item.north);
    return {
      id: `gbfs:fixture:${item.id}`,
      sourceId: item.id,
      provider: 'fixture-operator',
      kind: 'kick-scooter',
      entity: 'vehicle',
      name: item.id,
      latitude: spot.latitude,
      longitude: spot.longitude,
      distanceMeters: Math.round(metersBetween(origin, spot)),
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
  const segment = (
    mode: 'walk' | 'scooter',
    from: Place,
    to: Place,
    path: { latitude: number; longitude: number }[],
  ): BaseSegment => {
    const meters = path
      .slice(1)
      .reduce((sum, point, index) => sum + metersBetween(path[index], point), 0);
    return {
      id: mode,
      mode,
      ...(mode === 'scooter' ? { routingProfile: 'scooter' as const } : {}),
      title: mode,
      instructions: '',
      start: from,
      end: to,
      distanceMeters: meters,
      durationSeconds: { min: meters / 5, max: meters / 4 },
      polyline: path,
      runAllowed: false,
    };
  };
  const routeOf = (segments: BaseSegment[]): BaseRoute => ({
    id: segments.map((item) => item.id).join('+'),
    title: 'fixture',
    segments,
    transfers: 0,
    distanceMeters: segments.reduce((sum, item) => sum + item.distanceMeters, 0),
    durationSeconds: {
      min: segments.reduce((sum, item) => sum + item.durationSeconds.min, 0),
      max: segments.reduce((sum, item) => sum + item.durationSeconds.max, 0),
    },
  });
  const ridden: string[] = [];
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (request, budget) =>
      budget.run(() => [
        routeOf([
          segment('walk', request.origin, request.destination, [
            request.origin,
            request.destination,
          ]),
        ]),
      ]),
    scooter: async (request, budget) =>
      budget.run(() => {
        const item = devices.find((entry) => request.origin.id.endsWith(`:${entry.id}`))!;
        ridden.push(item.id);
        // Each alternative rides through the waypoint `via` metres north of the origin's row.
        return item.vias.map((via) =>
          routeOf([
            segment('scooter', request.origin, request.destination, [
              request.origin,
              at(via, 0),
              at(via, 1200),
              request.destination,
            ]),
          ]),
        );
      }),
  };
  const feed: VehicleFeed = {
    provider: 'fixture-operator',
    lastFailure: null,
    kinds: ['kick-scooter'],
    nearby: async () => devices.map(marker),
  };
  const policy: DocklessRentalPolicy = {
    rideAllowed: (path, mode) =>
      rideAllowedOn(streetRules, TYPES[mode === 'scooter' ? 0 : 1].type, path),
    verify: async ({ vehicle, destination: to }) => ({
      vehicleId: vehicle.id,
      provider: vehicle.provider,
      dropoff: { ...to },
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
    }),
  };
  const context: DocklessConnectionContext = {
    now: NOW,
    budget: new CallBudget(60),
    mobility: new MobilityFeeds({ now: () => NOW, vehicleFeeds: [feed] }),
    provider,
    scooterPolicy: policy,
  };
  const search = () =>
    scooterConnection(
      context,
      { ...DEFAULT_PREFERENCES, allowScooter: true },
      origin,
      destination,
      'agree',
    );
  return { search, ridden };
}
const rideOf = (segments: BaseSegment[] | null) =>
  segments?.find((segment) => segment.mode === 'scooter');

test('a scooter ride along a 킥보드 없는 거리 takes the router alternative, else the next device', async () => {
  // The street lies on the row 300 m north of the origin (north 0 in `at`).
  const rerouted = bannedStreetSearch([{ id: 'near', north: 10, vias: [0, -60] }]);
  const ride = rideOf(await rerouted.search());
  assert.ok(ride, 'the second alternative avoids the street');
  assert.ok(ride.polyline!.some((point) => metersBetween(point, at(-60, 0)) < 1));
  assert.equal(rerouted.ridden.length, 1, 'one routing call returned both alternatives');
  const next = bannedStreetSearch([
    { id: 'banned-only', north: 10, vias: [0] },
    { id: 'farther', north: 40, vias: [-60] },
  ]);
  const segments = await next.search();
  assert.equal(
    segments?.find((segment) => segment.mode === 'hire')?.rentalValidity?.vehicleId,
    'farther',
  );
  assert.deepEqual(next.ridden.sort(), ['banned-only', 'farther']);
  const none = bannedStreetSearch([{ id: 'banned-only', north: 10, vias: [0] }]);
  assert.equal(await none.search(), null, 'no ride along the street is ever offered');
});
