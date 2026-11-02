import assert from 'node:assert/strict';
import test from 'node:test';
import { kmaGrid, WeatherFeed } from '../src/common/engine/realtime/weather.js';

const NOW = Date.UTC(2026, 9, 12, 7, 45);
const FIRST = {
  id: 'home-1',
  name: '첫 사용자 집',
  address: '서울 중구 세종대로 110',
  latitude: 37.5665,
  longitude: 126.978,
};
const SECOND = { latitude: 37.5702, longitude: 126.9841 };
const payload = () => ({
  response: {
    header: { resultCode: '00' },
    body: {
      items: {
        item: [
          ['T1H', '18.2'],
          ['PTY', '0'],
          ['RN1', '0'],
          ['WSD', '3.1'],
        ].map(([category, obsrValue]) => ({
          category,
          obsrValue,
          baseDate: '20261012',
          baseTime: '1600',
          nx: 60,
          ny: 127,
        })),
      },
    },
  },
});

function assertOnlyOwnPoint(weather: object, point: { latitude: number; longitude: number }) {
  const body = JSON.stringify(weather);
  for (const leaked of [
    FIRST.id,
    FIRST.name,
    FIRST.address,
    String(FIRST.latitude),
    String(FIRST.longitude),
  ])
    assert.ok(!body.includes(leaked), `${leaked} leaked into ${body}`);
  for (const field of ['id', 'name', 'address'])
    assert.ok(!(field in weather), `${field} must not be in a weather snapshot`);
  assert.equal((weather as { latitude: number }).latitude, point.latitude);
  assert.equal((weather as { longitude: number }).longitude, point.longitude);
}

test('a cached grid observation never carries the first requester place to another requester', async () => {
  assert.deepEqual(kmaGrid(SECOND), kmaGrid(FIRST));
  let calls = 0;
  const feed = new WeatherFeed('key', {
    now: () => NOW,
    fetcher: (async () => {
      calls++;
      return new Response(JSON.stringify(payload()));
    }) as typeof fetch,
  });
  const first = await feed.conditions(FIRST);
  assert.equal(first.status, 'live');
  for (const field of ['id', 'name', 'address'])
    assert.ok(!(field in first), `${field} must not be in the requester's own snapshot`);
  const second = await feed.conditions(SECOND);
  assert.equal(calls, 1, 'the second request is served from the grid cache');
  assert.equal(second.status, 'live');
  assert.equal(second.temperatureC, 18.2);
  assertOnlyOwnPoint(second, SECOND);
});

test('a failed lookup held for its retry window and a shared in-flight lookup also carry only each requester point', async () => {
  const broken = new WeatherFeed('key', {
    now: () => NOW,
    fetcher: (async () =>
      new Response('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', { status: 403 })) as typeof fetch,
  });
  assert.equal((await broken.conditions(FIRST)).status, 'unavailable');
  const retried = await broken.conditions(SECOND);
  assert.equal(retried.status, 'unavailable');
  assertOnlyOwnPoint(retried, SECOND);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = new WeatherFeed('key', {
    now: () => NOW,
    fetcher: (async () => {
      await gate;
      return new Response(JSON.stringify(payload()));
    }) as typeof fetch,
  });
  const pending = [slow.conditions(FIRST), slow.conditions(SECOND)];
  release();
  const [, concurrent] = await Promise.all(pending);
  assertOnlyOwnPoint(concurrent, SECOND);
});
