// Regression cases from mvp/tests/spatialBusV3.test.ts (the Python parity case stays in mvp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSpatialBusCheckpoint,
  predictSpatialBusEnvelope,
  SPATIAL_BUS_FEATURE_NAMES,
  SPATIAL_BUS_GROUPS,
  type SpatialBusInput,
} from '../src/common/engine/intelligence/spatial-bus-model.js';
import {
  BusEnvelopeRuntime,
  SpatialBusModelService,
} from '../src/common/engine/intelligence/spatial-bus-service.js';
import type { BaseSegment } from '../src/common/shared/domain/types.js';

const kst = (day: string, hour: number) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:20:00+09:00`);
const input = (startedAt: number): SpatialBusInput => ({
  startedAt,
  distanceMeters: 1553,
  stopCount: 3,
  originLatitude: 37.5551,
  originLongitude: 126.9727,
  destinationLatitude: 37.5437,
  destinationLongitude: 126.9719,
});
const leaf = (value: number) => ({
  initial: value,
  trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]],
});
const N = SPATIAL_BUS_FEATURE_NAMES.length;
function checkpoint(trainedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    version: 'seoul-bus-spatial-v3',
    deployment: 'production',
    target: 'bus-tag-elapsed',
    trainedAt,
    expiresAt: trainedAt + 7 * 86_400_000,
    trainingThrough: '2026-10-10',
    lastEvaluatedServiceDate: '2026-10-16',
    featureNames: [...SPATIAL_BUS_FEATURE_NAMES],
    models: { mean: leaf(400), lower: leaf(300), median: leaf(380), upper: leaf(500) },
    featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: {
      rule: 'korean-public-holiday-as-sunday',
      firstDate: '2026-09-28',
      lastDate: '2026-11-06',
      holidays: ['2026-10-03', '2026-10-05', '2026-10-09'],
    },
    conformal: SPATIAL_BUS_GROUPS.map((group) => ({
      group,
      logLower: 0,
      logUpper:
        group === 'weekday:morning'
          ? Math.log(1.2)
          : group.startsWith('weekend')
            ? Math.log(1.1)
            : 0,
    })),
    labelUncertaintySeconds: 60,
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) },
    evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) },
    meanInterpretation: 'conditional tag-elapsed mean, not validated route ETA',
    limitations: ['unit'],
    ...overrides,
  };
}

test('v3 envelope uses the day-type and day-part calibration and refuses days outside its calendar', () => {
  const model = parseSpatialBusCheckpoint(JSON.stringify(checkpoint(kst('2026-10-29', 17))));
  assert.equal(
    predictSpatialBusEnvelope(model, input(kst('2026-10-30', 8)))!.upperSeconds,
    500 * 1.2,
  );
  assert.equal(predictSpatialBusEnvelope(model, input(kst('2026-10-30', 12)))!.upperSeconds, 500);
  assert.equal(
    predictSpatialBusEnvelope(model, input(kst('2026-10-31', 8)))!.upperSeconds,
    500 * 1.1,
  );
  assert.equal(
    predictSpatialBusEnvelope(model, input(kst('2026-10-09', 8)))!.upperSeconds,
    500 * 1.1,
    'holiday morning is calibrated as weekend',
  );
  assert.equal(
    predictSpatialBusEnvelope(model, input(kst('2026-11-07', 8))),
    null,
    'no reviewed calendar beyond lastDate',
  );
  assert.throws(() =>
    parseSpatialBusCheckpoint(JSON.stringify(checkpoint(1, { expiresAt: 1 + 8 * 86_400_000 }))),
  );
  assert.throws(() =>
    parseSpatialBusCheckpoint(
      JSON.stringify(checkpoint(1, { conformal: [...checkpoint(1).conformal].reverse() })),
    ),
  );
});

test('service needs the stop list, stops serving at expiry and hands unsupported legs to the public bus model', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spatial-bus-')),
    path = join(directory, 'model.json'),
    trainedAt = kst('2026-10-29', 17);
  try {
    writeFileSync(path, JSON.stringify(checkpoint(trainedAt)));
    let now = kst('2026-10-30', 8);
    const service = new SpatialBusModelService({ modelPath: path, now: () => now });
    const segment = {
      id: 'b',
      mode: 'bus',
      title: '',
      instructions: '',
      distanceMeters: 1553,
      durationSeconds: { min: 386, max: 386 },
      runAllowed: false,
      start: { id: 's', name: 's', latitude: 37.5551, longitude: 126.9727 },
      end: { id: 'e', name: 'e', latitude: 37.5437, longitude: 126.9719 },
      transit: {
        lines: ['7016'],
        stops: ['서울역버스환승센터', '갈월동', '갈월동.숙대입구역', '숙대입구'],
      },
    } as unknown as BaseSegment;
    assert.equal(service.predictSegment(segment, now, now)!.modelVersion, 'seoul-bus-spatial-v3');
    assert.equal(
      service.predictSegment(
        { ...segment, transit: { lines: ['7016'], stops: [] } } as unknown as BaseSegment,
        now,
        now,
      ),
      null,
    );
    const fallback = {
      predictSegment: () => ({
        modelVersion: 'public-bus-duration-v2' as const,
        target: 'bus-tag-elapsed' as const,
        lowerSeconds: 1,
        medianSeconds: 2,
        upperSeconds: 3,
      }),
      status: () => ({ active: true }),
    };
    const runtime = new BusEnvelopeRuntime(service, fallback);
    assert.equal(
      runtime.predictSegment(segment, now, now, null)!.modelVersion,
      'seoul-bus-spatial-v3',
    );
    now = trainedAt + 7 * 86_400_000;
    assert.equal(
      runtime.predictSegment(segment, now, now, null)!.modelVersion,
      'public-bus-duration-v2',
    );
    assert.deepEqual((runtime.status() as { spatial: { reasons: string[] } }).spatial.reasons, [
      'expired-checkpoint',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
