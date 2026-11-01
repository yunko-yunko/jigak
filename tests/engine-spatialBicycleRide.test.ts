// Regression cases from mvp/tests/spatialBicycleRide.test.ts (the Python parity case stays in mvp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPATIAL_BICYCLE_FEATURE_NAMES } from '../src/common/engine/intelligence/spatial-bicycle-model.js';
import {
  modelledBicycleRide,
  parseSpatialBicycleCheckpoint,
  predictSpatialBicycleRide,
  SpatialBicycleRideService,
  SPATIAL_BICYCLE_GROUPS,
  type SpatialBicycleRideInput,
} from '../src/common/engine/intelligence/spatial-bicycle-ride.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import type { BaseSegment } from '../src/common/shared/domain/types.js';

const kst = (day: string, hour: number) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:20:00+09:00`);
const ride = (startedAt: number, east = 0.02): SpatialBicycleRideInput => ({
  startedAt,
  originLatitude: 37.5551,
  originLongitude: 126.9727,
  destinationLatitude: 37.5437,
  destinationLongitude: 126.9727 + east,
});
const leaf = (value: number) => ({
  initial: value,
  trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]],
});
const N = SPATIAL_BICYCLE_FEATURE_NAMES.length;
function checkpoint(trainedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 'seoul-bicycle-spatial-v2',
    deployment: 'production',
    target: 'bicycle-direct-ride-elapsed',
    region: 'seoul',
    trainedAt,
    expiresAt: Date.parse('2026-11-15T00:00:00+09:00'),
    trainingThrough: '2026-06-19',
    lastEvaluatedServiceDate: '2026-06-30',
    sourceMonth: '2026-06',
    featureNames: [...SPATIAL_BICYCLE_FEATURE_NAMES],
    models: {
      lower: leaf(300),
      q25: leaf(420),
      median: leaf(480),
      q75: leaf(560),
      upper: leaf(800),
    },
    featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: {
      rule: 'korean-public-holiday-as-sunday',
      firstDate: '2026-06-01',
      lastDate: '2026-11-14',
      holidays: ['2026-06-03', '2026-06-06', '2026-10-03', '2026-10-05', '2026-10-09'],
    },
    conformal: SPATIAL_BICYCLE_GROUPS.map((group) => ({
      group,
      logLower: 0,
      logUpper:
        group === 'weekday:morning'
          ? Math.log(1.25)
          : group.startsWith('weekend')
            ? Math.log(1.1)
            : 0,
    })),
    labelUncertaintySeconds: 1,
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) },
    targetDefinition: {},
    evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) },
    limitations: ['june-2026-rentals-only'],
    ...overrides,
  };
}

test('served quartiles and the calibrated band follow the day type and part, and refuse outside the domain or calendar', () => {
  const model = parseSpatialBicycleCheckpoint(JSON.stringify(checkpoint(kst('2026-10-29', 18))));
  const weekdayMorning = predictSpatialBicycleRide(model, ride(kst('2026-10-30', 8)))!;
  assert.deepEqual(
    [weekdayMorning.lowerSeconds, weekdayMorning.medianSeconds, weekdayMorning.upperSeconds],
    [420, 480, 560],
  );
  assert.equal(weekdayMorning.bandUpperSeconds, 800 * 1.25);
  assert.equal(
    predictSpatialBicycleRide(model, ride(kst('2026-10-30', 13)))!.bandUpperSeconds,
    800,
  );
  assert.equal(
    predictSpatialBicycleRide(model, ride(kst('2026-10-31', 8)))!.bandUpperSeconds,
    800 * 1.1,
  );
  assert.equal(
    predictSpatialBicycleRide(model, ride(kst('2026-10-09', 8)))!.bandUpperSeconds,
    800 * 1.1,
    'a holiday morning is calibrated as weekend',
  );
  assert.equal(
    predictSpatialBicycleRide(model, ride(kst('2026-11-16', 8))),
    null,
    'no reviewed calendar after lastDate',
  );
  assert.equal(
    predictSpatialBicycleRide(model, {
      ...ride(kst('2026-10-30', 8)),
      destinationLatitude: 37.5552,
      destinationLongitude: 126.9728,
    }),
    null,
    'docks under 100 m apart are outside the model',
  );
  const maximum = Array(N).fill(1000);
  maximum[1] = 37.4;
  const narrow = parseSpatialBicycleCheckpoint(
    JSON.stringify(checkpoint(1, { domain: { minimum: Array(N).fill(-1000), maximum } })),
  );
  assert.equal(
    predictSpatialBicycleRide(narrow, ride(kst('2026-10-30', 8))),
    null,
    'features outside the trained domain are refused',
  );
  assert.throws(() =>
    parseSpatialBicycleCheckpoint(
      JSON.stringify(checkpoint(1, { conformal: [...checkpoint(1).conformal].reverse() })),
    ),
  );
  assert.throws(() =>
    parseSpatialBicycleCheckpoint(
      JSON.stringify(checkpoint(1, { version: 'seoul-bicycle-spatial-v1' })),
    ),
  );
});

test('the service stops at expiry, reports why, and MobilityFeeds carries it next to the measured table', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-bicycle-')),
    path = join(directory, 'model.json');
  try {
    writeFileSync(path, JSON.stringify(checkpoint(kst('2026-10-29', 18))));
    let now = kst('2026-10-30', 8);
    const service = new SpatialBicycleRideService({ modelPath: path, now: () => now });
    const hire = { latitude: 37.5551, longitude: 126.9727 },
      drop = { latitude: 37.5437, longitude: 126.9927 };
    const estimate = service.ride(hire, drop, now)!;
    assert.equal(estimate.modelVersion, 'seoul-bicycle-spatial-v2');
    assert.equal(estimate.sourceMonth, '2026-06');
    assert.equal(new MobilityFeeds({ bikeModel: service }).bikeModel, service);
    assert.equal(new MobilityFeeds().bikeModel, null);
    now = Date.parse('2026-11-15T00:00:00+09:00');
    assert.equal(service.ride(hire, drop, now), null);
    assert.deepEqual(service.status().reasons, ['expired-checkpoint']);
    writeFileSync(path, '{"version":"broken"}');
    const broken = new SpatialBicycleRideService({
      modelPath: path,
      now: () => kst('2026-10-30', 8),
    });
    assert.equal(broken.ride(hire, drop, kst('2026-10-30', 8)), null);
    assert.deepEqual(broken.status().reasons, ['invalid-checkpoint']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a modelled ride replaces the router seconds with quartiles and says where they came from', () => {
  const segment = {
    id: 'bike',
    mode: 'bicycle',
    title: '자전거',
    instructions: '자전거 도로로 가요.',
    distanceMeters: 2100,
    durationSeconds: { min: 412, max: 412 },
    start: { id: 'a', name: 'a', latitude: 37.55, longitude: 126.97 },
    end: { id: 'b', name: 'b', latitude: 37.56, longitude: 126.98 },
    runAllowed: false,
  } as BaseSegment;
  const modelled = modelledBicycleRide(segment, {
    modelVersion: 'seoul-bicycle-spatial-v2',
    sourceMonth: '2026-06',
    lowerSeconds: 600.4,
    medianSeconds: 690,
    upperSeconds: 812.6,
    bandLowerSeconds: 450,
    bandUpperSeconds: 1100,
  });
  assert.deepEqual(modelled.durationSeconds, { min: 600, max: 813 });
  assert.match(modelled.instructions, /6월 따릉이 대여 기록으로 추정했어요\(보통 12분\)/);
  assert.equal(modelled.distanceMeters, 2100);
});
