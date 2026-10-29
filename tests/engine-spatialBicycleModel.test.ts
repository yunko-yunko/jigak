// Preserved regression cases from perception-map/mvp/tests/spatialBicycleModel.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSpatialBicycleModel,
  predictSpatialBicycleRaw,
  predictSpatialBicycleShadow,
} from '../src/common/engine/intelligence/spatial-bicycle-model.js';

const reference = JSON.parse(
  readFileSync(
    new URL('./fixtures/engine-spatial-bicycle-portability.json', import.meta.url),
    'utf8',
  ),
);

// Protects exported numerical inference, including sklearn's already-scaled leaves.
test('portable TypeScript trees reproduce independently calculated Python predictions across departure contexts', () => {
  const model = parseSpatialBicycleModel(JSON.stringify(reference.model));

  for (const { input, expected } of reference.queries) {
    const predicted = predictSpatialBicycleRaw(model, input);

    assert.ok(predicted);

    for (const key of ['lower', 'median', 'upper'] as const) {
      assert.ok(
        Math.abs(predicted[key] - expected[key]) <= 1e-8,
        `${key} differs from Python tree inference`,
      );
    }
  }

  const distinct = new Set(
    reference.queries.map(
      (row: { input: Parameters<typeof predictSpatialBicycleRaw>[1] }) =>
        predictSpatialBicycleRaw(model, row.input)!.median,
    ),
  );

  assert.ok(distinct.size > 1, 'the reference exercises different branches, not one constant leaf');
});

// Protects the runtime from malformed checkpoints and accidental research promotion.
test('a cyclic export or a relabeled production rental model cannot load', () => {
  const cycle = structuredClone(reference.model);

  cycle.models.median.trees[0][0].left = 0;

  assert.throws(() => parseSpatialBicycleModel(JSON.stringify(cycle)), /invalid-spatial-tree/);

  const production = {
    ...reference.model,
    deployment: 'production',
    productionEligible: true,
  };

  assert.throws(() => parseSpatialBicycleModel(JSON.stringify(production)));

  const changedOrder = structuredClone(reference.model);

  changedOrder.featureNames.reverse();

  assert.throws(() => parseSpatialBicycleModel(JSON.stringify(changedOrder)), /feature-contract/);
});

// Protects geographic extrapolation and the independently calibrated interval contract.
test('research predictions preserve rental target and reject geographic and distance extrapolation', () => {
  const model = parseSpatialBicycleModel(JSON.stringify(reference.model)),
    input = reference.queries[0].input;
  const result = predictSpatialBicycleShadow(model, input),
    raw = predictSpatialBicycleRaw(model, input);

  assert.ok(result && raw);
  assert.equal(result.target, 'bicycle-rental-elapsed');
  assert.equal(result.productionEligible, false);
  assert.ok(
    Math.abs(
      result.upperSeconds -
        (Math.max(raw.upper, result.medianSeconds) + model.conformalSeconds + 1),
    ) < 1e-8,
  );
  assert.equal(
    predictSpatialBicycleShadow(model, {
      ...input,
      originLatitude: 35.17,
      destinationLatitude: 35.18,
    }),
    null,
  );
  assert.equal(
    predictSpatialBicycleShadow(model, {
      ...input,
      destinationLatitude: input.originLatitude,
      destinationLongitude: input.originLongitude,
    }),
    null,
  );
  assert.equal(
    predictSpatialBicycleShadow(model, {
      ...input,
      startedAt: NaN,
    }),
    null,
  );
});
