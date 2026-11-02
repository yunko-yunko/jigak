// Legal return points, signal waits on dockless rides and the kick-scooter licence (CONTRACT2 G2, 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { rentalAvailabilityForSearch } from '../src/common/engine/intelligence/rental-availability.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { DOCKLESS_PROFILES, type DocklessVehicle } from '../src/common/engine/scooter-bridge.js';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { ParkingRules, parseParkingRules } from '../src/common/engine/simulation/parking-rules.js';
import { RETURN } from '../src/common/engine/simulation/return-rules.js';
import {
  legalDropoff,
  SimulatedScooterPolicy,
} from '../src/common/engine/simulation/scooter-policy.js';
import {
  ebikeRoutesFromBicycle,
  scooterRoutesFromBicycle,
  SIGNAL_DELAY_SECONDS,
  SIGNALS_PER_KM,
  signalsAlong,
} from '../src/common/engine/simulation/scooter-router.js';
import type { SharedScooterSimulation } from '../src/common/engine/simulation/shared-scooter-sim.js';
import {
  DEFAULT_PREFERENCES,
  validatePreferences,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';
import { validLiveVehicles } from '../src/common/shared/domain/vehicleConstraints.js';
import {
  rentalAvailabilitySchema,
  rentalAvailabilityText,
} from '../src/common/shared/intelligence/rentalAvailability.js';
import { preferencesSchema } from '../src/modules/routing/dto/routing.dto.js';

const NOW = Date.parse('2026-11-01T14:00:00+09:00');
/** 숙대입구역 exit area; real 따릉이 docks lie within the 700 m service area. */
const EXIT = { latitude: 37.5446, longitude: 126.9721 };
const place = (id: string, north: number, east = 0): Place => ({
  id,
  name: id,
  address: '',
  latitude: EXIT.latitude + north / 111_195,
  longitude: EXIT.longitude + east / 88_000,
});
const rules = new ParkingRules(
  parseParkingRules({
    version: 'seoul-pm-parking-rules-v1',
    builtAt: 1,
    busStops: [[EXIT.latitude + 0.003, EXIT.longitude]],
    subwayExits: [[EXIT.latitude, EXIT.longitude]],
    crosswalks: [[EXIT.latitude - 0.003, EXIT.longitude]],
  }),
  bundledDemand(),
);

test('a ride ends at the rule table spot for the rented type, and an allowed point keeps its place', () => {
  const atExit = place('exit-front', 2);
  const ebike = legalDropoff(rules, 'e-bike', atExit)!;
  assert.ok(metersBetween(ebike, EXIT) > 10, 'out of the 10 m subway-exit radius (R04)');
  assert.ok(metersBetween(ebike, atExit) <= 20, 'only pushed, never sent away');
  assert.equal(rules.returnEffect(1, ebike.latitude, ebike.longitude), RETURN.CLEAN);
  // 용산구 takes kick-scooters only at its designated spots (R21); e-bikes are not bound by it.
  const scooter = legalDropoff(rules, 'kick-scooter', atExit)!;
  assert.notEqual(rules.returnEffect(0, scooter.latitude, scooter.longitude), RETURN.NO_RETURN);
  assert.ok(metersBetween(scooter, atExit) > metersBetween(ebike, atExit));
  const street = place('street', 0, 200);
  assert.ok(metersBetween(legalDropoff(rules, 'e-bike', street)!, street) < 0.5);
});

const simulation = (type: 'kick-scooter' | 'e-bike') =>
  ({
    modelVersion: 'sim-1',
    vehicle: () => ({
      rentable: true,
      type,
      latitude: EXIT.latitude - 0.01,
      longitude: EXIT.longitude,
      rangeMeters: 40_000,
    }),
    parkedUntil: (_id: string, now: number) => now + 3_600_000,
  }) as unknown as SharedScooterSimulation;
const device = (id: string, kind: DocklessVehicle['kind']): DocklessVehicle => ({
  id,
  provider: 'jigak-sim',
  source: 'gbfs',
  kind,
  latitude: EXIT.latitude - 0.01,
  longitude: EXIT.longitude,
  battery: 80,
  distanceMeters: 0,
  observedAt: NOW,
  receivedAt: NOW,
});

test('the simulated policy parks by the station exit, outside its buffer, and leaves the rest to walk', async () => {
  const policy = new SimulatedScooterPolicy(simulation('e-bike'), rules);
  const station = { ...place('exit-front', 1), name: '숙대입구역' };
  const permission = await policy.verify({
    vehicle: device('JB00001', 'e-bicycle'),
    origin: place('origin', -1100),
    destination: station,
    now: NOW,
    mode: 'ebike',
  });
  assert.ok(permission);
  assert.match(permission.dropoff.id, /^return:/);
  assert.equal(permission.dropoff.name, '숙대입구역 근처');
  assert.ok(metersBetween(permission.dropoff, EXIT) > 5);
  const street = place('street', 0, 200);
  const legal = await policy.verify({
    vehicle: device('JB00001', 'e-bicycle'),
    origin: place('origin', -1100),
    destination: street,
    now: NOW,
    mode: 'ebike',
  });
  assert.deepEqual(legal?.dropoff, street, 'a legal destination is the dropoff itself');
});

test('a station continuation starts from the street entrance nearest the platform, the same spot for both kinds', () => {
  const platform = { ...place('platform', 120), name: '숙대입구역' };
  const scooter = new SimulatedScooterPolicy(simulation('kick-scooter'), rules);
  const ebike = new SimulatedScooterPolicy(simulation('e-bike'), rules);
  const spot = scooter.returnPoint(platform, true)!;
  // The kick-scooter spot by the exit, whose rules are the stricter, and allowed for e-bikes too.
  const exitSpot = legalDropoff(rules, 'kick-scooter', EXIT)!;
  assert.deepEqual([spot.latitude, spot.longitude], [exitSpot.latitude, exitSpot.longitude]);
  assert.ok(metersBetween(spot, EXIT) > 10);
  assert.notEqual(rules.returnEffect(1, spot.latitude, spot.longitude), RETURN.NO_RETURN);
  assert.deepEqual(ebike.returnPoint(platform, true), spot);
  const own = legalDropoff(rules, 'kick-scooter', platform)!;
  const plain = scooter.returnPoint(platform)!;
  assert.deepEqual(
    [plain.latitude, plain.longitude],
    [own.latitude, own.longitude],
    'without an entrance the spot is the legal spot by the platform point',
  );
});

test('each kind continues from its own legal spot: kick-scooter-only rules never move an e-bike', () => {
  const platform = { ...place('platform', 120), name: '숙대입구역' };
  const policy = new SimulatedScooterPolicy(simulation('e-bike'), rules);
  const ebike = policy.returnPoint(platform, true, 'ebike')!;
  const own = legalDropoff(rules, 'e-bike', EXIT)!;
  assert.deepEqual([ebike.latitude, ebike.longitude], [own.latitude, own.longitude]);
  const scooter = policy.returnPoint(platform, true, 'scooter')!;
  const strict = legalDropoff(rules, 'kick-scooter', EXIT)!;
  assert.deepEqual([scooter.latitude, scooter.longitude], [strict.latitude, strict.longitude]);
  // 용산구 R21 pushes the kick-scooter away from the exit; the e-bike parks right outside its buffer.
  assert.ok(metersBetween(ebike, EXIT) < metersBetween(scooter, EXIT));
  assert.ok(metersBetween(ebike, EXIT) <= 20);
});

const intersections = (points: Place[]) => ({
  loadedNear: (point: { latitude: number; longitude: number }, radius: number) =>
    points.filter((item) => metersBetween(point, item) <= radius),
});
const ride = (meters: number): BaseRoute => {
  const from = place('a', 0),
    to = place('b', meters);
  const segment: BaseSegment = {
    id: 'bicycle',
    mode: 'bicycle',
    title: 'bicycle',
    instructions: '',
    start: from,
    end: to,
    distanceMeters: meters,
    durationSeconds: { min: meters / 4, max: meters / 4 },
    polyline: [from, to],
    runAllowed: false,
  };
  return {
    id: 'r',
    title: 'r',
    segments: [segment],
    transfers: 0,
    distanceMeters: meters,
    durationSeconds: segment.durationSeconds,
  };
};

test('a dockless ride waits at each signalled intersection on its path, once', () => {
  const lights = [
    { ...place('light-1', 300), id: 'L1' },
    { ...place('light-2', 900, 10), id: 'L2' },
    { ...place('off-path', 600, 80), id: 'L3' },
  ];
  const path = [place('a', 0), place('b', 1500)];
  assert.equal(signalsAlong(path, intersections(lights)), 2);
  assert.equal(signalsAlong(path, { loadedNear: () => null }), null, 'not loaded yet');
  const [scooter] = scooterRoutesFromBicycle(
    [ride(1500)],
    {
      origin: path[0],
      destination: path[1],
    },
    intersections(lights),
  );
  assert.deepEqual(scooter.segments[0].durationSeconds, {
    min: Math.ceil(1500 / (20 / 3.6) + 2 * SIGNAL_DELAY_SECONDS.lower),
    max: Math.ceil(1500 / (14 / 3.6) + 2 * SIGNAL_DELAY_SECONDS.upper),
  });
  const [ebike] = ebikeRoutesFromBicycle([ride(1500)], { origin: path[0], destination: path[1] });
  assert.deepEqual(ebike.segments[0].durationSeconds, {
    min: Math.ceil(1500 / (21 / 3.6) + 1.5 * SIGNALS_PER_KM * SIGNAL_DELAY_SECONDS.lower),
    max: Math.ceil(1500 / (17 / 3.6) + 1.5 * SIGNALS_PER_KM * SIGNAL_DELAY_SECONDS.upper),
  });
});

const capabilities = {
  bicycleFeed: true,
  scooterFeed: true,
  ebikeFeed: true,
  bicycleRouter: true,
  scooterRouter: true,
  ebikeRouter: true,
  scooterRentalPolicy: true,
  ebikeRentalPolicy: true,
};

test('without a confirmed licence kick-scooters are left out and say why; e-bikes need none', () => {
  const unlicensed = { ...DEFAULT_PREFERENCES, hasScooterLicense: false };
  assert.equal(DOCKLESS_PROFILES.scooter.allowed(unlicensed), false);
  assert.equal(DOCKLESS_PROFILES.ebike.allowed(unlicensed), true);
  assert.equal(DOCKLESS_PROFILES.scooter.allowed(DEFAULT_PREFERENCES), true, 'omitted is legacy');
  const availability = rentalAvailabilityForSearch({
    preferences: unlicensed,
    routes: [],
    capabilities,
  });
  assert.deepEqual(availability.scooter, { status: 'not-found', reason: 'license-unconfirmed' });
  assert.deepEqual(availability.ebike, { status: 'not-found', reason: 'no-route' });
  assert.equal(rentalAvailabilitySchema.safeParse(availability).success, true);
  assert.equal(rentalAvailabilityText('scooter', availability.scooter), '킥보드 면허 확인 필요');
  const legacy = rentalAvailabilityForSearch({
    preferences: DEFAULT_PREFERENCES,
    routes: [],
    capabilities,
  });
  assert.deepEqual(legacy.scooter, { status: 'not-found', reason: 'no-route' });
  assert.equal(
    rentalAvailabilityForSearch({
      preferences: { ...unlicensed, allowScooter: false },
      routes: [],
      capabilities,
    }).scooter.reason,
    'disabled',
    'switched off is still disabled',
  );
});

test('the licence flag is an optional boolean everywhere preferences are checked', () => {
  for (const value of [true, false, undefined])
    assert.doesNotThrow(() =>
      validatePreferences({ ...DEFAULT_PREFERENCES, hasScooterLicense: value }),
    );
  assert.throws(() =>
    validatePreferences({
      ...DEFAULT_PREFERENCES,
      hasScooterLicense: 'yes' as unknown as boolean,
    }),
  );
  assert.equal(
    preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, hasScooterLicense: false }).success,
    true,
  );
  assert.equal(
    preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, hasScooterLicense: 1 }).success,
    false,
  );
  const scooter: BaseSegment = {
    ...ride(500).segments[0],
    mode: 'scooter',
    routingProfile: 'scooter',
  };
  assert.equal(
    validLiveVehicles([scooter], { ...DEFAULT_PREFERENCES, hasScooterLicense: false }),
    false,
  );
});

test('a kind whose rides to the destination all lack a legal return says so, unless its search was cut', () => {
  const blocked = (byMode: Record<string, number>, limited: Record<string, number> = {}) =>
    rentalAvailabilityForSearch({
      preferences: { ...DEFAULT_PREFERENCES, allowBicycle: true, bicycleReady: true },
      routes: [],
      capabilities,
      diagnostics: { returnBlockedByMode: byMode, candidateLimitSkippedByMode: limited },
    });
  const scooterOnly = blocked({ scooter: 1 });
  assert.deepEqual(scooterOnly.scooter, { status: 'not-found', reason: 'no-legal-return' });
  assert.deepEqual(scooterOnly.ebike, { status: 'not-found', reason: 'no-route' });
  assert.deepEqual(scooterOnly.bicycle, { status: 'not-found', reason: 'no-route' });
  assert.equal(rentalAvailabilitySchema.safeParse(scooterOnly).success, true);
  assert.equal(
    rentalAvailabilityText('scooter', scooterOnly.scooter),
    '도착지 근처 킥보드 반납 가능 구역 없음',
  );
  assert.equal(
    rentalAvailabilityText('ebike', { status: 'not-found', reason: 'no-legal-return' }),
    '도착지 근처 전기자전거 반납 가능 구역 없음',
  );
  // Devices left out of another of its rides could still have found a route: that stays the reason.
  assert.equal(blocked({ scooter: 1 }, { scooter: 2 }).scooter.reason, 'search-limited');
  assert.equal(blocked({ scooter: 0 }).scooter.reason, 'no-route');
  // The licence is asked first: no return rule is reported for a kind the rider may not ride.
  assert.equal(
    rentalAvailabilityForSearch({
      preferences: { ...DEFAULT_PREFERENCES, hasScooterLicense: false },
      routes: [],
      capabilities,
      diagnostics: { returnBlockedByMode: { scooter: 1 } },
    }).scooter.reason,
    'license-unconfirmed',
  );
  // An older server never sends the reason, and its responses still parse.
  assert.equal(
    rentalAvailabilitySchema.safeParse({
      bicycle: { status: 'not-found', reason: 'no-route' },
      scooter: { status: 'not-found', reason: 'search-limited' },
    }).success,
    true,
  );
});
