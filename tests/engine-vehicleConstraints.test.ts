// Preserved regression cases from perception-map/mvp/tests/vehicleConstraints.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import { validLiveVehicles } from '../src/common/shared/domain/vehicleConstraints.js';
import type { BaseSegment, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.parse('2026-10-14T00:00:00Z');

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
  distanceMeters: start === end ? 0 : 100,
  durationSeconds: {
    min: 10,
    max: 10,
  },
  runAllowed: false,
  ...(start !== end
    ? {
        polyline: [start, end],
      }
    : {}),
});

const lease = (mode: 'bicycle' | 'scooter', start: Place, end: Place): BaseSegment[] => [
  {
    ...segment(`${mode}-hire`, 'hire', start, start),
    rentalValidity: {
      verifiedAt: NOW,
      validUntil: NOW + 600000,
      vehicleId: mode,
      provider: 'test',
    },
  },
  {
    ...segment(`${mode}-ride`, mode, start, end),
    routingProfile: mode,
  },
  segment(`${mode}-return`, 'return', end, end),
];

test('complete connected leases can use different devices after each confirmed return', () => {
  assert.equal(
    validLiveVehicles([...lease('bicycle', O, A), ...lease('scooter', A, B)], preferences, O),
    true,
  );
});

test('a started lease must end after its ride without another vehicle or hire inside it', () => {
  const bicycle = lease('bicycle', O, A);

  assert.equal(validLiveVehicles(bicycle.slice(0, 2), preferences, O), false);
  assert.equal(
    validLiveVehicles(
      [
        bicycle[0],
        bicycle[1],
        {
          ...segment('mixed', 'scooter', A, B),
          routingProfile: 'scooter',
        },
        segment('return', 'return', B, B),
      ],
      preferences,
      O,
    ),
    false,
  );
  assert.equal(
    validLiveVehicles([...bicycle.slice(0, 2), ...lease('scooter', A, B)], preferences, O),
    false,
  );
  assert.equal(
    validLiveVehicles(
      [bicycle[0], bicycle[1], segment('bad-return', 'return', B, B)],
      preferences,
      O,
    ),
    false,
  );
  assert.equal(
    validLiveVehicles([bicycle[0], segment('bus', 'bus', O, A), bicycle[2]], preferences, O),
    false,
  );
});

test('a new lease cannot move the rider to an unconnected pickup point', () => {
  assert.equal(
    validLiveVehicles([...lease('bicycle', O, A), ...lease('scooter', B, O)], preferences, O),
    false,
  );
});

test('rental permission rejects malformed identity instead of throwing at the feasibility boundary', () => {
  const malformed = lease('scooter', O, A);

  malformed[0].rentalValidity!.provider = undefined as unknown as string;

  assert.equal(validLiveVehicles(malformed, preferences, O), false);
});

test('each subsequent lease permission must stay fresh and valid through its own return', () => {
  const first = lease('bicycle', O, A),
    second = lease('scooter', A, B);

  second[0].rentalValidity!.validUntil = NOW + 55000;

  assert.equal(validLiveVehicles([...first, ...second], preferences, O, NOW), false);

  second[0].rentalValidity!.validUntil = NOW + 60000;

  assert.equal(validLiveVehicles([...first, ...second], preferences, O, NOW), true);

  second[0].rentalValidity!.verifiedAt = NOW - 121000;

  assert.equal(validLiveVehicles([...first, ...second], preferences, O, NOW), false);
});
