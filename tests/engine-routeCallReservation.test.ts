// Preserved regression cases from perception-map/mvp/tests/routeCallReservation.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { withRouteQueryReuse } from '../src/common/engine/connectivity/query-reuse.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';

test('a branch leaves held calls available for the next candidate without counting them as HTTP attempts', async () => {
  const budget = new CallBudget(5);

  await budget.withReservedCalls(2, async () => {
    assert.equal(budget.remaining, 3);

    for (let i = 0; i < 3; i++) {
      await budget.run(() => i);
    }

    await assert.rejects(
      budget.run(() => assert.fail('spent a held slot')),
      {
        code: 'CALL_BUDGET_EXCEEDED',
      },
    );
    assert.equal(budget.used, 3);
  });

  assert.equal(budget.remaining, 2);

  await budget.run(() => 1);
  await budget.run(() => 2);

  assert.equal(budget.used, 5);
});

test('a throwing branch releases its hold but its failed physical call stays spent', async () => {
  const budget = new CallBudget(5);

  await assert.rejects(
    budget.withReservedCalls(3, () =>
      budget.run(() => {
        throw new Error('controlled failure');
      }),
    ),
    /controlled failure/,
  );
  assert.equal(budget.used, 1);
  assert.equal(budget.remaining, 4);
});

test('nested holds are bounded by available calls and release independently', async () => {
  const budget = new CallBudget(5);

  await budget.withReservedCalls(2, async () => {
    await budget.withReservedCalls(10, async () => {
      assert.equal(budget.remaining, 0);
      await assert.rejects(
        budget.run(() => 1),
        {
          code: 'CALL_BUDGET_EXCEEDED',
        },
      );
    });

    assert.equal(budget.remaining, 3);

    await budget.run(() => 1);
  });

  assert.equal(budget.remaining, 4);

  for (const invalid of [-1, 0.5, NaN, Infinity]) {
    await assert.rejects(
      budget.withReservedCalls(invalid, () => assert.fail('invalid hold executed')),
      RangeError,
    );
  }

  assert.equal(budget.remaining, 4);
});

test('concurrent physical attempts cannot spend another candidates held calls', async () => {
  const budget = new CallBudget(5);

  await budget.withReservedCalls(3, async () => {
    const results = await Promise.allSettled(
      Array.from(
        {
          length: 6,
        },
        () => budget.run(async () => 1),
      ),
    );

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 2);
    assert.equal(budget.used, 2);
  });

  assert.equal(budget.remaining, 3);
});

test('a reservation retains the search identity so positive cached routes work with zero available calls', async () => {
  let attempts = 0;
  const source: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (_request, budget) =>
      budget.run(() => {
        attempts++;

        return [
          {
            id: 'cached-route',
            title: '확인된 경로',
            distanceMeters: 0,
            transfers: 0,
            durationSeconds: {
              min: 0,
              max: 0,
            },
            segments: [],
          },
        ];
      }),
  };
  const provider = withRouteQueryReuse(source),
    budget = new CallBudget(2);
  const origin = {
    id: 'a',
    name: '서울역',
    address: '서울',
    latitude: 37.5547,
    longitude: 126.9707,
  };
  const destination = {
    ...origin,
    id: 'b',
    name: '시청',
    latitude: 37.5663,
  };

  const cached = await provider.walking(
    {
      origin,
      destination,
    },
    budget,
  );

  await budget.withReservedCalls(1, async () => {
    assert.equal(budget.remaining, 0);
    assert.deepEqual(
      await provider.walking(
        {
          origin,
          destination,
        },
        budget,
      ),
      cached,
    );
    assert.equal(attempts, 1);
  });
  await budget.run(() => 1);

  assert.equal(budget.used, 2);
});
