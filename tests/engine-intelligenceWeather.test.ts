// Preserved regression cases from perception-map/mvp/tests/intelligenceWeather.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedError } from '../src/common/engine/realtime/http.js';
import {
  kmaGrid,
  kmaObservationBase,
  parseKmaWeather,
  WeatherFeed,
} from '../src/common/engine/realtime/weather.js';

const SEOUL = {
  latitude: 37.5665,
  longitude: 126.978,
};

const NOW = Date.UTC(2026, 9, 12, 7, 45);

const payload = (overrides: Record<string, unknown> = {}) => ({
  response: {
    header: {
      resultCode: '00',
    },
    body: {
      items: {
        item: [
          ['T1H', '18.2'],
          ['PTY', '1'],
          ['RN1', '1.5'],
          ['WSD', '3.1'],
        ].map(([category, obsrValue]) => ({
          category,
          obsrValue,
          baseDate: '20261012',
          baseTime: '1600',
          nx: 60,
          ny: 127,
          ...overrides,
        })),
      },
    },
  },
});

test('KMA 5km projection and previous available hour handle KST midnight', () => {
  assert.deepEqual(kmaGrid(SEOUL), {
    x: 60,
    y: 127,
  });
  assert.deepEqual(kmaObservationBase(NOW), {
    date: '20261012',
    time: '1600',
  });
  assert.deepEqual(kmaObservationBase(Date.UTC(2026, 9, 11, 15, 10)), {
    date: '20261011',
    time: '2300',
  });
  assert.throws(
    () =>
      kmaGrid({
        latitude: 0,
        longitude: 0,
      }),
    RangeError,
  );
});

test('weather is source-timestamped and stale/future/wrong-grid data cannot become live', () => {
  const live = parseKmaWeather(payload(), SEOUL, NOW);

  assert.equal(live.status, 'live');
  assert.equal(live.precipitationMm, 1.5);
  assert.equal(live.observedAt, Date.UTC(2026, 9, 12, 7));
  assert.equal(live.receivedAt, NOW);
  assert.equal(parseKmaWeather(payload(), SEOUL, NOW + 2 * 3_600_000).status, 'stale');
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '1800',
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          nx: 59,
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        {
          response: {
            header: {
              resultCode: '30',
            },
          },
        },
        SEOUL,
        NOW,
      ),
    (error: unknown) => error instanceof FeedError && error.reason === 'auth',
  );
});

test('weather feed caches by grid, retries failure later, and never fabricates missing conditions', async () => {
  let calls = 0,
    clock = NOW;
  const fetcher = (async (input: URL) => {
    calls++;

    const url = new URL(String(input));

    assert.equal(url.searchParams.get('serviceKey'), 'decoded+key=');
    assert.equal(url.searchParams.get('base_time'), '1600');

    return new Response(JSON.stringify(payload()));
  }) as typeof fetch;
  const feed = new WeatherFeed('decoded%2Bkey%3D', {
    fetcher,
    now: () => clock,
  });

  await feed.conditions(SEOUL);
  await feed.conditions({
    latitude: SEOUL.latitude + 0.0001,
    longitude: SEOUL.longitude,
  });

  assert.equal(calls, 1);

  clock += 11 * 60_000;

  await feed.conditions(SEOUL);

  assert.equal(calls, 2);

  const absent = await new WeatherFeed(undefined, {
    fetcher,
  }).conditions(SEOUL);

  assert.equal(absent.status, 'unconfigured');
  assert.equal(absent.windMetersPerSecond, null);

  let failedCalls = 0;
  const broken = new WeatherFeed('bad', {
    now: () => NOW,
    fetcher: (async () => {
      failedCalls++;

      return new Response('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', {
        status: 403,
      });
    }) as typeof fetch,
  });

  assert.equal((await broken.conditions(SEOUL)).status, 'unavailable');

  await broken.conditions(SEOUL);

  assert.equal(failedCalls, 1);
  assert.equal(broken.lastFailure, 'auth');
});

test('unsupported coordinates return unavailable weather without rejecting an optional route dependency', async () => {
  let calls = 0;
  const feed = new WeatherFeed('configured', {
    now: () => NOW,
    fetcher: (async () => {
      calls++;

      throw new Error('must not query');
    }) as typeof fetch,
  });

  for (const point of [
    {
      latitude: 35.68,
      longitude: 139.76,
    },
    {
      latitude: 0,
      longitude: 0,
    },
  ]) {
    const result = await feed.conditions(point);

    assert.equal(result.status, 'unavailable');
    assert.equal(result.grid, null);
    assert.equal(result.observedAt, null);
    assert.equal(result.temperatureC, null);
    assert.match(result.message, /지원 지역/);
  }

  assert.equal(calls, 0);
});

test('weather rejects impossible values before they can invalidate an otherwise usable route response', () => {
  for (const [category, value] of [
    ['T1H', '-81'],
    ['T1H', '71'],
    ['RN1', '-1'],
    ['RN1', '1e308'],
    ['WSD', '-1'],
    ['WSD', '151'],
    ['PTY', '1.5'],
  ]) {
    const data = payload();

    data.response.body.items.item.find((row) => row.category === category)!.obsrValue = value;

    assert.throws(() => parseKmaWeather(data, SEOUL, NOW), FeedError, `${category}=${value}`);
  }
});

test('weather does not normalize impossible source calendar dates or hour overflow into live observations', () => {
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '1560',
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '2400',
        }),
        SEOUL,
        Date.UTC(2026, 9, 12, 16),
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseDate: '20260230',
        }),
        SEOUL,
        Date.UTC(2026, 2, 2, 8),
      ),
    FeedError,
  );
});
