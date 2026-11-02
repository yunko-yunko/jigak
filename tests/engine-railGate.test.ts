// Regression cases from mvp/tests/railGate.test.ts (Python parity and app session cases stay in mvp).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRailGateCheckpoint,
  predictRailGate,
  RAIL_GATE_FEATURE_NAMES,
  RAIL_GATE_GROUPS,
  type RailGateInput,
} from '../src/common/engine/intelligence/rail-gate-model.js';
import {
  applyRailGateEnvelope,
  RailGateModelService,
  restoreRailGateSource,
  type RailGatePredictor,
} from '../src/common/engine/intelligence/rail-gate-service.js';
import { estimatedSegmentSeconds } from '../src/common/shared/domain/estimatedTiming.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

const kst = (day: string, hour: number, minute = 20) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
const HOLIDAYS = ['2026-10-03', '2026-10-05', '2026-10-09'];
const leaf = (value: number) => ({
  initial: value,
  trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]],
});
const N = RAIL_GATE_FEATURE_NAMES.length;
function checkpoint(
  trainedAt: number,
  encodings = {
    pairs: [['서울역', '숙대입구(서울시교육청)', Math.log(420), 21]],
    origins: [['서울역', 0.12, 900]],
    destinations: [['숙대입구(서울시교육청)', 0.2, 300]],
  },
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 'seoul-rail-gate-v1',
    deployment: 'production',
    target: 'rail-gate-elapsed',
    trainedAt,
    expiresAt: trainedAt + 7 * 86_400_000,
    trainingThrough: '2026-10-06',
    lastEvaluatedServiceDate: '2026-10-16',
    featureNames: [...RAIL_GATE_FEATURE_NAMES],
    featureQuantizationDecimals: 6,
    models: { lower: leaf(240), median: leaf(420), upper: leaf(700) },
    secondsPerMeter: 0.4,
    priorRows: 5,
    encodings,
    calendar: {
      rule: 'korean-public-holiday-as-sunday',
      firstDate: '2026-09-28',
      lastDate: '2026-11-06',
      holidays: HOLIDAYS,
    },
    conformal: RAIL_GATE_GROUPS.map((group) => ({
      group,
      logLower: 0,
      logUpper: group === 'weekday:evening' ? Math.log(1.1) : 0,
    })),
    labelUncertaintySeconds: 60,
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) },
    evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) },
    limitations: ['unit'],
    ...overrides,
  };
}
const SEOUL = { latitude: 37.5547, longitude: 126.9707 },
  SOOKDAE = { latitude: 37.5448, longitude: 126.9723 };

test('prediction uses its day-type calibration and refuses unknown stations and days outside the calendar', () => {
  const model = parseRailGateCheckpoint(JSON.stringify(checkpoint(kst('2026-10-29', 18))));
  const input = (startedAt: number, originName = '서울역'): RailGateInput => ({
    originName,
    destinationName: '숙대입구(서울시교육청)',
    origin: SEOUL,
    destination: SOOKDAE,
    startedAt,
  });
  assert.ok(
    Math.abs(predictRailGate(model, input(kst('2026-10-30', 18)))!.upperSeconds - 770) < 1e-9,
  );
  assert.equal(predictRailGate(model, input(kst('2026-10-31', 18)))!.upperSeconds, 700);
  assert.equal(predictRailGate(model, input(kst('2026-10-30', 18), '없는역')), null);
  assert.equal(predictRailGate(model, input(kst('2026-11-07', 18))), null);
  assert.throws(() =>
    parseRailGateCheckpoint(
      JSON.stringify(checkpoint(1, undefined, { expiresAt: 1 + 8 * 86_400_000 })),
    ),
  );
});

const place = (id: string, name: string, at: { latitude: number; longitude: number }): Place => ({
  id,
  name,
  address: '',
  ...at,
});
const segment = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  distanceMeters = 0,
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '',
  start,
  end,
  distanceMeters,
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  ...(distanceMeters ? { polyline: [start, end] } : {}),
});

test('the run envelope widens only the last subway leg, keeps the estimate and never compounds', () => {
  const origin = place('o', '출발', { latitude: 37.556, longitude: 126.97 }),
    seoul = place('s', '서울역', SEOUL),
    sookdae = place('k', '숙대입구(서울시교육청)', SOOKDAE);
  const samgakji = place('g', '삼각지', { latitude: 37.5347, longitude: 126.9731 }),
    destination = place('d', '도착', { latitude: 37.533, longitude: 126.975 });
  const segments = [
    segment('walk', 'walk', origin, seoul, 120, 150),
    segment('wait-0-expected-wait', 'wait', seoul, seoul, 210),
    segment('ride-1', 'subway', seoul, sookdae, 120, 1000),
    segment('transfer', 'walk', sookdae, sookdae, 60, 80),
    segment('wait-1-expected-wait', 'wait', sookdae, sookdae, 120),
    segment('ride-2', 'subway', sookdae, samgakji, 90, 1100),
    segment('egress', 'walk', samgakji, destination, 200, 250),
  ];
  const route: BaseRoute = {
    id: 'subway',
    title: '지하철',
    segments,
    distanceMeters: 2580,
    transfers: 1,
    durationSeconds: { min: 920, max: 920 },
  };
  const now = kst('2026-10-30', 18),
    calls: RailGateInput[] = [];
  const predict: RailGatePredictor = (input) => {
    calls.push(input);
    return {
      modelVersion: 'seoul-rail-gate-v1',
      target: 'rail-gate-elapsed',
      lowerSeconds: 300,
      medianSeconds: 700,
      upperSeconds: 1000,
    };
  };
  const [enveloped] = applyRailGateEnvelope([route], { now }, predict);
  assert.deepEqual(
    calls.map((call) => [call.originName, call.destinationName, call.startedAt]),
    [['서울역', '삼각지', now + 120_000]],
  );
  const last = enveloped.segments[5];
  assert.deepEqual(
    last.durationSeconds,
    { min: 90, max: 90 + (1000 - 600) },
    'span 210+120+60+120+90 = 600 s grows to the 1000 s upper bound',
  );
  assert.equal(last.railEtaPrediction?.plannedSpanSeconds, 600);
  assert.deepEqual(enveloped.durationSeconds, { min: 920, max: 1320 });
  assert.deepEqual(enveloped.segments.slice(0, 5), segments.slice(0, 5));
  assert.equal(
    estimatedSegmentSeconds(last, now),
    estimatedSegmentSeconds(segments[5], now),
    'the estimate keeps the provider ride time',
  );
  const [again] = applyRailGateEnvelope([enveloped], { now }, predict);
  assert.deepEqual(again.segments[5].durationSeconds, last.durationSeconds);
  assert.deepEqual(again.durationSeconds, enveloped.durationSeconds);
  assert.deepEqual(restoreRailGateSource(last).durationSeconds, { min: 90, max: 90 });
  // A long walk leaves the paid area: two runs, each judged on its own span.
  calls.splice(0);
  const split = applyRailGateEnvelope(
    [
      {
        ...route,
        segments: segments.map((value) =>
          value.id === 'transfer' ? { ...value, distanceMeters: 700 } : value,
        ),
      },
    ],
    { now },
    (input) => {
      calls.push(input);
      return {
        modelVersion: 'seoul-rail-gate-v1',
        target: 'rail-gate-elapsed',
        lowerSeconds: 100,
        medianSeconds: 200,
        upperSeconds: 300,
      };
    },
  )[0];
  assert.deepEqual(
    calls.map((call) => [call.originName, call.destinationName]),
    [
      ['서울역', '숙대입구(서울시교육청)'],
      ['숙대입구(서울시교육청)', '삼각지'],
    ],
  );
  assert.equal(
    split.segments[2].durationSeconds.max,
    120,
    'first run 210+120 s already covers its 300 s bound',
  );
  assert.equal(
    split.segments[5].durationSeconds.max,
    90 + 300 - 210,
    'second run 120+90 s grows to 300 s',
  );
  assert.deepEqual(
    applyRailGateEnvelope([route], { now }, () => null)[0],
    route,
    'no prediction keeps the route untouched',
  );
});

test('service stops serving at expiry and reports why', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rail-gate-')),
    path = join(directory, 'model.json'),
    trainedAt = kst('2026-10-29', 18);
  try {
    writeFileSync(path, JSON.stringify(checkpoint(trainedAt)));
    let now = kst('2026-10-30', 18);
    const service = new RailGateModelService({ modelPath: path, now: () => now });
    const input: RailGateInput = {
      originName: '서울역',
      destinationName: '숙대입구(서울시교육청)',
      origin: SEOUL,
      destination: SOOKDAE,
      startedAt: now,
    };
    assert.equal(service.predictRun(input, now)?.modelVersion, 'seoul-rail-gate-v1');
    now = trainedAt + 7 * 86_400_000;
    assert.equal(service.predictRun({ ...input, startedAt: now }, now), null);
    assert.deepEqual((service.status() as { reasons: string[] }).reasons, ['expired-checkpoint']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
