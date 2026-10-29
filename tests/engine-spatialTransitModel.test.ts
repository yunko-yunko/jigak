// Preserved regression cases from perception-map/mvp/tests/spatialTransitModel.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  inspectSpatialTransitCandidate,
  parseSpatialTransitModel,
  predictSpatialTransitRaw,
  predictSpatialTransitShadow,
  spatialTransitFeatures,
} from '../src/common/engine/intelligence/spatial-transit-model.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/engine-spatial-transit-portability.json', import.meta.url),
    'utf8',
  ),
);

const modelText = JSON.stringify(fixture.model),
  model = parseSpatialTransitModel(modelText);

// The original real checkpoint diverged across Python/V8 at nearly equal tree thresholds.
test('portable quantile trees preserve independently computed Python feature and prediction values', () => {
  const distinct = new Set<number>();

  for (const { input, features, expected } of fixture.queries) {
    assert.deepEqual(spatialTransitFeatures(input), features);

    const result = predictSpatialTransitRaw(model, input);

    assert.ok(result);

    for (const key of ['lower', 'median', 'upper'] as const) {
      assert.ok(Math.abs(result[key] - expected[key]) <= 1e-8);
    }

    distinct.add(result.median);
  }

  assert.ok(distinct.size >= 4, 'references must traverse different learned branches');
});

// Prevents label leakage and accidental cross-mode/extrapolated inference.
test('unseen names need no OD lookup, observed transfer outcomes cannot change the prediction, and unsupported plans fail closed', () => {
  const input = fixture.queries[7].input,
    result = predictSpatialTransitShadow(model, input);

  assert.ok(result);

  const future = {
    ...input,
    originName: 'never-trained-name',
    destinationName: 'another-new-name',
    actualSeconds: 21000,
    observedAt: input.startedAt + 21000000,
    transferGapSeconds: 7200,
    legs: [
      {
        startedAt: input.startedAt + 100000,
        observedAt: input.startedAt + 900000,
      },
    ],
  };

  assert.deepEqual(predictSpatialTransitShadow(model, future), result);
  assert.equal(
    predictSpatialTransitShadow(model, {
      ...input,
      modeSequence: ['bus'],
    }),
    null,
  );
  assert.equal(
    predictSpatialTransitShadow(model, {
      ...input,
      modeSequence: ['subway'],
    }),
    null,
  );
  assert.equal(
    predictSpatialTransitShadow(model, {
      ...input,
      destinationLatitude: 35.1,
    }),
    null,
  );
  assert.equal(
    predictSpatialTransitShadow(model, {
      ...input,
      startedAt: Number.NaN,
    }),
    null,
  );

  const raw = predictSpatialTransitRaw(model, input)!;

  assert.equal(
    result.upperSeconds,
    Math.max(raw.upper, result.medianSeconds) + model.conformalSeconds + 60,
  );

  const spatialChange = {
    ...input,
    destinationLatitude: input.originLatitude + 0.05,
    destinationLongitude: input.originLongitude + 0.04,
  };

  assert.notEqual(
    predictSpatialTransitRaw(model, spatialChange)!.median,
    raw.median,
    'requested geometry participates in inference',
  );
});

function passingOfflineReport() {
  const evaluation = (rows: number) => ({
    rows,
    supported: rows,
    unsupported: 0,
    modelMaeSeconds: 200,
    supportedModelMaeSeconds: 200,
    supportedBaselineMaeSeconds: 300,
    supportedRidgeMaeSeconds: 250,
    robustIntervalCoverage: 0.9,
    robustUpperCoverage: 0.95,
    meanRelativeWidth: 1,
  });

  return {
    version: model.version,
    kind: model.kind,
    target: model.target,
    deployment: 'shadow',
    productionEligible: false,
    assessmentAlreadyInspected: true,
    qualityPassed: true,
    qualityFailedGroups: [] as string[],
    counts: {
      unsupportedCalibration: 0,
    },
    evaluations: {
      all: evaluation(1000),
      seenOd: evaluation(600),
      unseenOd: evaluation(400),
      heldOutCard: evaluation(100),
      dayParts: {
        night: evaluation(200),
        morning: evaluation(200),
        daytime: evaluation(200),
        evening: evaluation(200),
        late: evaluation(200),
      },
    },
    reproducibility: {
      modelSha256: createHash('sha256').update(modelText).digest('hex'),
      protocolSha256: model.protocolSha256,
      inputSha256: model.inputSha256,
    },
  };
}

// Protects against unbound/stale reports, inflated support and promoting retrospective labels.
test('runtime recomputes offline gates and never promotes an already inspected tag-label experiment', () => {
  const report = passingOfflineReport(),
    gate = inspectSpatialTransitCandidate(modelText, JSON.stringify(report));

  assert.equal(gate.offlineQualityPassed, true);
  assert.equal(gate.productionEligible, false);
  assert.ok(
    gate.reasons.includes('already-inspected-assessment') &&
      gate.reasons.includes('no-initial-final-app-walk'),
  );

  const missing = structuredClone(report);

  missing.counts.unsupportedCalibration = 1;

  assert.throws(
    () => inspectSpatialTransitCandidate(modelText, JSON.stringify(missing)),
    /quality-claim-mismatch/,
  );

  missing.qualityPassed = false;
  missing.qualityFailedGroups = ['unsupportedCalibration'];

  assert.equal(
    inspectSpatialTransitCandidate(modelText, JSON.stringify(missing)).offlineQualityPassed,
    false,
  );

  const fraudulent = structuredClone(report);

  fraudulent.evaluations.unseenOd.robustUpperCoverage = 0.89;

  assert.throws(
    () => inspectSpatialTransitCandidate(modelText, JSON.stringify(fraudulent)),
    /invalid-spatial-transit-metrics|quality-claim-mismatch/,
  );

  const denominator = structuredClone(report);

  denominator.evaluations.unseenOd.rows--;

  assert.throws(
    () => inspectSpatialTransitCandidate(modelText, JSON.stringify(denominator)),
    /denominator/,
  );
  assert.throws(
    () => inspectSpatialTransitCandidate(modelText + '\n', JSON.stringify(report)),
    /model-mismatch/,
  );
});

// A damaged tree can loop forever; a target relabel would hide missing app walking time.
test('corrupt trees, changed feature precision, wrong targets and production claims are rejected', () => {
  const loop = structuredClone(fixture.model);

  loop.models.median.trees[0][0].left = 0;

  assert.throws(
    () => parseSpatialTransitModel(JSON.stringify(loop)),
    /invalid-spatial-transit-tree/,
  );
  assert.throws(() =>
    parseSpatialTransitModel(
      JSON.stringify({
        ...fixture.model,
        featureQuantizationDecimals: 9,
      }),
    ),
  );
  assert.throws(
    () =>
      parseSpatialTransitModel(
        JSON.stringify({
          ...fixture.model,
          target: 'rail-gate-elapsed',
        }),
      ),
    /target/,
  );
  assert.throws(() =>
    parseSpatialTransitModel(
      JSON.stringify({
        ...fixture.model,
        deployment: 'production',
        productionEligible: true,
      }),
    ),
  );
});
