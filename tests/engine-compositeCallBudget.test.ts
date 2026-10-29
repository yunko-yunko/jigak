// Preserved regression cases from perception-map/mvp/tests/compositeCallBudget.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as budgets from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';

for (const [label, requestedLimit, expectedLimit] of [
  ['ordinary', undefined, 10],
  ['composite', 20, 20],
  ['expanded', 32, 32],
] as const) {
  test(`${label} concurrent failed attempts retain every reservation without exceeding their shared ceiling`, async () => {
    const budget = new budgets.CallBudget(requestedLimit);
    let executed = 0;
    const pending = Promise.allSettled(
      Array.from(
        {
          length: expectedLimit + 3,
        },
        (_value, index) =>
          budget.run(async () => {
            executed++;

            await Promise.resolve();

            if (index < 4) {
              throw new ApiError('PROVIDER_TIMEOUT', '통제된 공급원 실패', 504);
            }

            return index;
          }),
      ),
    );

    assert.equal(
      executed,
      expectedLimit,
      'concurrent attempts reserve before the provider promise settles',
    );
    assert.equal(budget.used, expectedLimit);
    assert.equal(budget.remaining, 0);

    const outcomes = await pending;

    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );

    assert.equal(
      failures.filter(
        (outcome) =>
          outcome.reason instanceof ApiError && outcome.reason.code === 'PROVIDER_TIMEOUT',
      ).length,
      4,
    );
    assert.equal(
      failures.filter(
        (outcome) =>
          outcome.reason instanceof ApiError && outcome.reason.code === 'CALL_BUDGET_EXCEEDED',
      ).length,
      3,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      expectedLimit - 4,
    );
    await assert.rejects(
      budget.run(() => {
        throw new Error('an exhausted retry must not execute');
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'CALL_BUDGET_EXCEEDED',
    );
    assert.equal(budget.used, expectedLimit);
  });
}

test('routing budgets reject invalid bounds before permitting external requests', () => {
  for (const invalid of [0, -1, 1.5, 33, NaN, Infinity]) {
    assert.throws(() => new budgets.CallBudget(invalid));
  }

  assert.equal(new budgets.CallBudget(1).limit, 1);
  assert.equal(new budgets.CallBudget(16).limit, 16);
});
