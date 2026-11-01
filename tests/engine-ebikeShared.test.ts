// Shared e-bike mode: types, preferences, rental gates, availability text and the learning landmines.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import { validatePreferences } from '../src/common/shared/domain/routing.js';
import {
  hasBicycleAvailabilityEvidence,
  validLiveVehicles,
} from '../src/common/shared/domain/vehicleConstraints.js';
import type { BaseSegment, Place, Route } from '../src/common/shared/domain/types.js';
import {
  rentalAvailabilitySchema,
  rentalAvailabilityText,
  RENTAL_MODES,
} from '../src/common/shared/intelligence/rentalAvailability.js';
import { journeyFeaturesForRoute } from '../src/common/engine/intelligence/journey-features.js';
import {
  learningFeaturesForSegment,
  physicalFloorSeconds,
} from '../src/common/engine/intelligence/learning-features.js';
import { rentalAvailabilityForSearch } from '../src/common/engine/intelligence/rental-availability.js';
import { preferencesSchema } from '../src/modules/routing/dto/routing.dto.js';

const NOW = Date.parse('2026-11-01T01:00:00Z');
const point = (id: string, index: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude: 37.55 + index * 0.001,
  longitude: 126.97,
});
const O = point('O', 0),
  A = point('A', 1),
  B = point('B', 2);
const preferences = {
  ...DEFAULT_PREFERENCES,
  allowBicycle: true,
  bicycleReady: true,
  maxBicycleMeters: 3000,
};

const segment = (id: string, mode: BaseSegment['mode'], start: Place, end: Place): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '조회',
  start,
  end,
  distanceMeters: start === end ? 0 : 1200,
  durationSeconds: { min: 100, max: 200 },
  runAllowed: false,
  ...(start !== end ? { polyline: [start, end] } : {}),
});

const lease = (mode: 'bicycle' | 'scooter' | 'ebike', start: Place, end: Place): BaseSegment[] => [
  {
    ...segment(`${mode}-hire`, 'hire', start, start),
    rentalValidity: {
      verifiedAt: NOW,
      validUntil: NOW + 600000,
      vehicleId: mode,
      provider: 'test',
    },
  },
  { ...segment(`${mode}-ride`, mode, start, end), routingProfile: mode },
  segment(`${mode}-return`, 'return', end, end),
];

test('an e-bike lease is valid on its own and between other kinds, and needs its own routing profile', () => {
  assert.equal(validLiveVehicles(lease('ebike', O, A), preferences, O, NOW), true);
  assert.equal(
    validLiveVehicles([...lease('bicycle', O, A), ...lease('ebike', A, B)], preferences, O),
    true,
  );
  assert.equal(
    validLiveVehicles([...lease('ebike', O, A), ...lease('scooter', A, B)], preferences, O),
    true,
  );
  const wrongProfile = lease('ebike', O, A);
  wrongProfile[1] = { ...wrongProfile[1], routingProfile: 'bicycle' };
  assert.equal(validLiveVehicles(wrongProfile, preferences, O), false);
  const noGeometry = lease('ebike', O, A);
  noGeometry[1] = { ...noGeometry[1], polyline: undefined };
  assert.equal(validLiveVehicles(noGeometry, preferences, O), false);
  const mixed = lease('ebike', O, A);
  mixed.splice(2, 0, { ...segment('scooter-ride', 'scooter', A, B), routingProfile: 'scooter' });
  assert.equal(validLiveVehicles(mixed, preferences, O), false);
});

test('allowEbike switches off only e-bike legs and does not touch the 따릉이 gates', () => {
  const off = { ...preferences, allowEbike: false };
  assert.equal(validLiveVehicles(lease('ebike', O, A), off, O), false);
  assert.equal(validLiveVehicles(lease('scooter', O, A), off, O), true);
  assert.equal(
    validLiveVehicles(
      lease('ebike', O, A),
      { ...preferences, allowBicycle: false, bicycleReady: false, maxBicycleMeters: 0 },
      O,
    ),
    true,
  );
  assert.doesNotThrow(() => validatePreferences({ ...preferences, allowEbike: false }));
  assert.throws(() =>
    validatePreferences({ ...preferences, allowEbike: 'no' as unknown as boolean }),
  );
  assert.equal(preferencesSchema.safeParse({ ...preferences, allowEbike: false }).success, true);
  assert.equal(preferencesSchema.safeParse({ ...preferences, allowEbike: 1 }).success, false);
});

test('a 따릉이 hire with station proof does not accept an e-bike ride inside the same rental', () => {
  const hire = {
    ...lease('bicycle', O, A)[0],
    bicycleAvailability: {
      source: 'seoul-bike' as const,
      hireStationId: '1',
      returnStationId: '2',
      availableBikes: 3,
      receivedAt: NOW,
      observedAt: NOW,
      returnPolicy: 'designated-station' as const,
    },
  };
  assert.equal(
    hasBicycleAvailabilityEvidence(
      [
        hire,
        { ...segment('e', 'ebike', O, A), routingProfile: 'ebike' },
        segment('r', 'return', A, A),
      ],
      NOW,
    ),
    false,
  );
});

test('rental availability carries an optional e-bike entry and names it 전기자전거', () => {
  assert.deepEqual(RENTAL_MODES, ['bicycle', 'ebike', 'scooter']);
  const entry = { status: 'included', reason: null } as const;
  assert.equal(
    rentalAvailabilitySchema.safeParse({ bicycle: entry, scooter: entry }).success,
    true,
  );
  assert.equal(
    rentalAvailabilitySchema.safeParse({ bicycle: entry, ebike: entry, scooter: entry }).success,
    true,
  );
  assert.equal(
    rentalAvailabilitySchema.safeParse({
      bicycle: entry,
      ebike: entry,
      scooter: entry,
      moped: entry,
    }).success,
    false,
  );
  assert.equal(
    rentalAvailabilityText('ebike', {
      status: 'unavailable',
      reason: 'unconfigured-rental-policy',
    }),
    '전기자전거 대여·반납 연동 준비 중',
  );
  assert.equal(
    rentalAvailabilityText('scooter', { status: 'unavailable', reason: 'unconfigured-router' }),
    '킥보드 경로·대여/반납 연동 준비 중',
  );
  assert.equal(
    rentalAvailabilityText('bicycle', { status: 'unavailable', reason: 'unconfigured-router' }),
    '따릉이 전용 경로 연동 준비 중',
  );
  assert.equal(
    rentalAvailabilityText('ebike', { status: 'not-found', reason: 'no-route' }),
    '이번 조회에서 이용 가능한 전기자전거 조합 없음',
  );
});

test('availability is decided per rental kind from its own preference, router, policy and feed', () => {
  const all = {
    bicycleFeed: true,
    scooterFeed: true,
    ebikeFeed: true,
    bicycleRouter: true,
    scooterRouter: true,
    ebikeRouter: true,
    scooterRentalPolicy: true,
    ebikeRentalPolicy: true,
  };
  const run = (over: Partial<typeof all>, prefs = preferences, extra = {}) =>
    rentalAvailabilityForSearch({
      preferences: prefs,
      routes: [],
      capabilities: { ...all, ...over },
      ...extra,
    });
  assert.equal(run({ ebikeRentalPolicy: false }).ebike?.reason, 'unconfigured-rental-policy');
  assert.equal(run({ ebikeRentalPolicy: false }).scooter.reason, 'no-route');
  assert.equal(run({ ebikeRouter: false }).ebike?.reason, 'unconfigured-router');
  assert.equal(run({ ebikeFeed: false }).ebike?.reason, 'unconfigured-feed');
  assert.equal(run({}, { ...preferences, allowEbike: false }).ebike?.reason, 'disabled');
  assert.equal(run({}, { ...preferences, allowEbike: false }).scooter.status, 'not-found');
  assert.equal(run({}, { ...preferences, allowScooter: false }).ebike?.status, 'not-found');
  const routes = [{ segments: [{ mode: 'ebike' as const }] }];
  const included = rentalAvailabilityForSearch({ preferences, routes, capabilities: all });
  assert.equal(included.ebike?.status, 'included');
  assert.equal(included.scooter.status, 'not-found');
  // An omitted scooter device never marks the other kinds search-limited.
  const limited = run({}, preferences, {
    diagnostics: { candidateLimitSkipped: 2, candidateLimitSkippedByMode: { scooter: 2 } },
  });
  assert.equal(limited.scooter.reason, 'search-limited');
  assert.equal(limited.bicycle.reason, 'no-route');
  assert.equal(limited.ebike?.reason, 'no-route');
  assert.equal(
    run({}, preferences, { diagnostics: { candidateLimitSkipped: 2 } }).ebike?.reason,
    'search-limited',
  );
});

const route = (segments: BaseSegment[]): Route => {
  let cursor = NOW;
  const timed = segments.map((s) => {
    const earliest = cursor,
      latest = cursor + s.durationSeconds.max * 1000;
    cursor = latest;
    return { ...s, timeRange: { earliest, latest } };
  });
  return {
    id: 'r',
    origin: O,
    destination: B,
    segments: timed,
    transfers: 0,
    provenance: { mode: 'live', receivedAt: NOW },
    // The journey feature wants the whole timeline to equal the sum of its stage midpoints.
    durationSeconds: (() => {
      const last = timed[timed.length - 1].timeRange;
      const mid = (last.earliest + last.latest) / 2000 - NOW / 1000;
      return { min: mid, max: mid };
    })(),
  } as unknown as Route;
};

test('journey features fold e-bike time into the bicycle key instead of producing NaN', () => {
  const features = journeyFeaturesForRoute(route(lease('ebike', O, A)), NOW, null, 'test-profile');
  assert.ok(features);
  assert.ok(Object.values(features.modeSeconds).every((n) => Number.isFinite(n)));
  assert.ok(features.modeSeconds.bicycle > 0);
  assert.ok(!('ebike' in features.modeSeconds));
  assert.ok(features.modeSequence.every((m) => m !== ('ebike' as never)));
  assert.ok(features.vehicleLegs >= 1);
});

test('e-bike legs have no learned feature and a 25 km/h physical floor', () => {
  const ride = segment('ride', 'ebike', O, A);
  assert.equal(
    learningFeaturesForSegment(
      ride,
      { startedAt: NOW, precedingWaitSeconds: 0, vehicleCount: 0, requestNow: NOW },
      null,
    ),
    null,
  );
  // 1200 m at 7 m/s is 171 s, but the provider minimum (100 s) caps the floor.
  assert.equal(physicalFloorSeconds({ ...ride, distanceMeters: 700 }), 100);
  assert.equal(physicalFloorSeconds({ ...ride, durationSeconds: { min: 400, max: 500 } }), 171);
});
