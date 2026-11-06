// Spare Kakao REST key (KAKAO_REST_API_KEY_SUB): per API failover, midnight reset, no key in errors.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import { KakaoProvider, type RouteEndpoints } from '../src/common/engine/kakao.js';

const PRIMARY = 'primary-secret-aaaa1111';
const SPARE = 'spare-secret-bbbb2222';
const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const spent = () =>
  json({ errorType: 'BadRequest', message: 'API limit has been exceeded.', code: -10 }, 400);
const request: RouteEndpoints = {
  origin: { id: 'a', name: '출발', address: '', latitude: 37.55, longitude: 126.97 },
  destination: { id: 'b', name: '도착', address: '', latitude: 37.551, longitude: 126.971 },
};
const directionsBody = {
  routes: [
    {
      result_code: 0,
      summary: { distance: 1000, duration: 300 },
      sections: [{ roads: [{ vertexes: [126.97, 37.55, 126.971, 37.551] }], guides: [] }],
    },
  ],
};

type Slot = 'primary' | 'spare';
interface Call {
  path: string;
  slot: Slot;
}
/** A fake Kakao: `rule(path, slot)` answers each call; every call is recorded. */
function fake(rule: (path: string, slot: Slot) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = String((init?.headers as Record<string, string>).Authorization);
    const slot: Slot = auth === `KakaoAK ${PRIMARY}` ? 'primary' : 'spare';
    calls.push({ path: url.pathname, slot });
    return rule(url.pathname, slot);
  }) as typeof fetch;
  return { calls, fetcher };
}
const ok = (path: string) =>
  path === '/v1/directions'
    ? json(directionsBody)
    : path === '/v2/routing/publictraffic'
      ? json({ status: 'OK', routes: [] })
      : json({ documents: [], meta: {} });

test('a spent primary quota on one API moves only that API to the spare key', async () => {
  const { calls, fetcher } = fake((path, slot) =>
    path === '/v2/routing/publictraffic' && slot === 'primary' ? spent() : ok(path),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  const budget = new CallBudget(10);
  await kakao.transit(request, budget).catch(() => undefined);
  assert.deepEqual(calls, [
    { path: '/v2/routing/publictraffic', slot: 'primary' },
    { path: '/v2/routing/publictraffic', slot: 'spare' },
  ]);
  assert.equal(budget.used, 2, 'the retry is a real supplier call and spends a slot');
  await kakao.searchPlaces({ q: '서울역' });
  assert.deepEqual(calls.at(-1), { path: '/v2/local/search/keyword.json', slot: 'primary' });
  await kakao.transit(request, budget).catch(() => undefined);
  assert.deepEqual(
    calls.slice(-1),
    [{ path: '/v2/routing/publictraffic', slot: 'spare' }],
    'the spent primary is not asked again today',
  );
  const { apis } = kakao.activeKeySlots();
  assert.equal(apis['/v2/routing/publictraffic'], 'fallback');
  assert.equal(apis['/v2/local/search/keyword.json'], 'primary');
});

test('Local and Directions quota errors switch to the spare until midnight, then retry the primary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00+09:00') });
  const cases: [string, (provider: KakaoProvider) => Promise<unknown>][] = [
    ['/v2/local/search/keyword.json', (provider) => provider.searchPlaces({ q: '서울역' })],
    [
      '/v2/local/search/address.json',
      (provider) => provider.searchPlaces({ q: '서울특별시 중구 세종대로 110' }),
    ],
    ['/v2/local/geo/coord2address.json', (provider) => provider.reverseGeocode(request.origin)],
    ['/v1/directions', (provider) => provider.driving(request, new CallBudget(10))],
  ];
  for (const status of [400, 429]) {
    for (const [path, run] of cases) {
      t.mock.timers.setTime(Date.parse('2026-11-06T12:00:00+09:00'));
      const { calls, fetcher } = fake((calledPath, slot) =>
        calledPath === path && slot === 'primary'
          ? json({ code: -10, msg: 'API limit has been exceeded.' }, status)
          : ok(calledPath),
      );
      const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
      await run(kakao);
      t.mock.timers.setTime(Date.parse('2026-11-06T23:59:59+09:00'));
      await run(kakao);
      assert.deepEqual(
        calls.filter((call) => call.path === path).map((call) => call.slot),
        ['primary', 'spare', 'spare'],
        `${path} HTTP ${status}: the spent primary stays skipped past the short rate-limit cooldown`,
      );
      t.mock.timers.setTime(Date.parse('2026-11-07T00:00:00+09:00'));
      await run(kakao);
      assert.deepEqual(
        calls
          .filter((call) => call.path === path)
          .slice(-2)
          .map((call) => call.slot),
        ['primary', 'spare'],
      );
    }
  }
});

test('a quota body arriving after the diagnostic timeout still switches to the spare', async () => {
  for (const status of [400, 429]) {
    const { calls, fetcher } = fake((path, slot) =>
      slot === 'primary'
        ? new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: -10 })));
                controller.close();
              },
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          )
        : ok(path),
    );
    const kakao = new KakaoProvider({
      key: PRIMARY,
      fallbackKey: SPARE,
      fetcher,
      timeoutMs: 1_000,
    });
    await kakao.searchPlaces({ q: '서울역' });
    assert.deepEqual(
      calls.map((call) => call.slot),
      ['primary', 'spare'],
    );
    assert.equal(kakao.activeKeySlots().apis['/v2/local/search/keyword.json'], 'fallback');
  }
});

test('a stalled 429 body still hands over to the spare within the transport deadline', async () => {
  const { calls, fetcher } = fake((path, slot) =>
    slot === 'primary' ? new Response(new ReadableStream<Uint8Array>(), { status: 429 }) : ok(path),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher, timeoutMs: 25 });
  await kakao.searchPlaces({ q: '서울역' });
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'spare'],
  );
});

test('a 429 without a daily quota code uses the spare briefly and retries the primary after cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00+09:00') });
  const { calls, fetcher } = fake((path, slot) =>
    slot === 'primary' ? json({ message: 'Too many requests' }, 429) : ok(path),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await kakao.searchPlaces({ q: '서울역' });
  t.mock.timers.tick(59_999);
  await kakao.searchPlaces({ q: '서울역' });
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'spare', 'spare'],
  );
  t.mock.timers.tick(1);
  await kakao.searchPlaces({ q: '서울역' });
  assert.deepEqual(
    calls.slice(-2).map((call) => call.slot),
    ['primary', 'spare'],
  );
});

test('invalid Local input does not switch to the spare key', async () => {
  const { calls, fetcher } = fake(() => json({ code: -2, msg: 'wrong input' }, 400));
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await assert.rejects(kakao.searchPlaces({ q: '서울역' }), code('PROVIDER_UNAVAILABLE'));
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary'],
  );
  assert.equal(kakao.activeKeySlots().apis['/v2/local/search/keyword.json'], 'primary');
});

test('a spare key rejected for Directions leaves the primary serving it', async () => {
  const { calls, fetcher } = fake((path, slot) =>
    path === '/v1/directions' && slot === 'spare' ? new Response('', { status: 401 }) : ok(path),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await kakao.driving(request, new CallBudget(10));
  await kakao.driving(request, new CallBudget(10));
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'primary'],
    'the spare is never tried while the primary works',
  );
  assert.equal(kakao.activeKeySlots().apis['/v1/directions'], 'primary');
});

test('the spare is rejected for Directions only after the primary quota is gone, and that is reported', async () => {
  const { calls, fetcher } = fake((path, slot) =>
    slot === 'primary' ? new Response('', { status: 429 }) : new Response('', { status: 401 }),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await assert.rejects(kakao.driving(request, new CallBudget(10)), code('PROVIDER_AUTH'));
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'spare'],
  );
  // Both keys are now skipped for a while; the answer is still the spare's real failure.
  await assert.rejects(kakao.driving(request, new CallBudget(10)), code('PROVIDER_AUTH'));
  assert.equal(calls.length, 2);
  assert.equal(kakao.activeKeySlots().apis['/v1/directions'], 'exhausted');
});

test('a primary rejected with 401 or 403 hands that API to the spare and is skipped for a while', async () => {
  for (const status of [401, 403]) {
    const { calls, fetcher } = fake((path, slot) =>
      path === '/v1/directions' && slot === 'primary' ? new Response('', { status }) : ok(path),
    );
    const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
    await kakao.driving(request, new CallBudget(10));
    await kakao.driving(request, new CallBudget(10));
    assert.deepEqual(
      calls.map((call) => call.slot),
      ['primary', 'spare', 'spare'],
    );
  }
});

test('with both keys spent the old PROVIDER_LIMIT error stays and no more requests are sent', async () => {
  const { calls, fetcher } = fake((path) => (path === '/v2/routing/walk' ? spent() : ok(path)));
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  const budget = new CallBudget(10);
  await assert.rejects(kakao.walking(request, budget), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'PROVIDER_LIMIT');
    assert.equal(error.status, 429);
    assert.equal(
      error.message,
      '오늘 카카오 경로 조회 한도를 모두 사용했어요. 다른 경로 공급원으로 계산해요.',
    );
    return true;
  });
  await assert.rejects(kakao.walking(request, budget), code('PROVIDER_LIMIT'));
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'spare'],
  );
  assert.equal(kakao.activeKeySlots().apis['/v2/routing/walk'], 'exhausted');
});

test('both keys come back at 00:00 in Korea', async (t) => {
  // 23:59:50 KST on 2026-11-01.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T23:59:50+09:00') });
  const { calls, fetcher } = fake((path) => (path === '/v2/routing/walk' ? spent() : ok(path)));
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
  assert.equal(calls.length, 2);
  t.mock.timers.setTime(Date.parse('2026-11-01T23:59:59+09:00'));
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
  assert.equal(calls.length, 2, 'still closed one second before midnight');
  t.mock.timers.setTime(Date.parse('2026-11-02T00:00:01+09:00'));
  assert.equal(kakao.activeKeySlots().apis['/v2/routing/walk'], 'primary');
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
  assert.deepEqual(
    calls.slice(2).map((call) => call.slot),
    ['primary', 'spare'],
    'after midnight the primary is tried first again',
  );
});

test('without a spare key a rejection is neither remembered nor retried elsewhere', async () => {
  const { calls, fetcher } = fake(() => new Response('', { status: 401 }));
  const kakao = new KakaoProvider({ key: PRIMARY, fetcher });
  await assert.rejects(kakao.driving(request, new CallBudget(10)), code('PROVIDER_AUTH'));
  await assert.rejects(kakao.driving(request, new CallBudget(10)), code('PROVIDER_AUTH'));
  assert.equal(calls.length, 2);
  assert.equal(kakao.activeKeySlots().fallbackConfigured, false);
});

test('a blank or repeated spare key is ignored and a spare alone still counts as configured', async () => {
  const { calls, fetcher } = fake(() => spent());
  for (const fallbackKey of ['', '   ', PRIMARY, undefined]) {
    calls.length = 0;
    const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey, fetcher });
    assert.equal(kakao.activeKeySlots().fallbackConfigured, false);
    await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
    assert.equal(calls.length, 1);
  }
  assert.equal(new KakaoProvider({ key: '', fallbackKey: SPARE, fetcher }).configured, true);
  assert.equal(new KakaoProvider({ key: '', fetcher }).configured, false);
});

test('errors and diagnostics never contain either key, even when Kakao echoes it back', async () => {
  const seen: string[] = [];
  for (const status of [400, 401, 403, 429, 500]) {
    const { fetcher } = fake(() =>
      status === 400 ? spent() : new Response(`echo ${PRIMARY} ${SPARE}`, { status }),
    );
    const kakao = new KakaoProvider({
      key: PRIMARY,
      fallbackKey: SPARE,
      fetcher,
      retryDelayMs: () => 0,
      log: (line) => seen.push(line),
    });
    for (const run of [
      () => kakao.walking(request, new CallBudget(10)),
      () => kakao.driving(request, new CallBudget(10)),
      () => kakao.searchPlaces({ q: '서울역' }),
    ])
      await run().catch((error: unknown) => {
        assert.ok(error instanceof ApiError);
        seen.push(error.message, String(error.stack ?? ''), JSON.stringify(error));
      });
    seen.push(JSON.stringify(kakao.activeKeySlots()));
  }
  assert.ok(seen.length > 20);
  for (const text of seen)
    assert.ok(!text.includes(PRIMARY) && !text.includes(SPARE), 'no key text in any error');
});

test('a failure that is not about the key (server error) does not move to the spare key', async () => {
  const { calls, fetcher } = fake(() => new Response('', { status: 500 }));
  const kakao = new KakaoProvider({
    key: PRIMARY,
    fallbackKey: SPARE,
    fetcher,
    retryDelayMs: () => 0,
    log: () => undefined,
  });
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_UNAVAILABLE'));
  // One retry of the same key (a 5xx may pass), and never the spare.
  assert.deepEqual(
    calls.map((call) => call.slot),
    ['primary', 'primary'],
  );
});

test('requests already in flight when the primary quota runs out each move to the spare once and never loop', async () => {
  const calls: Slot[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetcher = (async (_input: URL | string, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).Authorization);
    const slot: Slot = auth === `KakaoAK ${PRIMARY}` ? 'primary' : 'spare';
    calls.push(slot);
    if (slot === 'spare') return spent();
    if (calls.filter((call) => call === 'primary').length === 4) release();
    await gate;
    return spent();
  }) as typeof fetch;
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => kakao.walking(request, new CallBudget(10))),
  );
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(calls.filter((call) => call === 'primary').length, 4);
  assert.equal(calls.filter((call) => call === 'spare').length, 4);
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
  assert.equal(calls.length, 8, 'both keys are closed, nothing else is sent');
});

test('a spent call budget during the hand-over is reported as such and does not close the spare key', async () => {
  const { calls, fetcher } = fake((path, slot) =>
    path === '/v2/routing/walk' && slot === 'primary' ? spent() : ok(path),
  );
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await assert.rejects(kakao.walking(request, new CallBudget(1)), code('CALL_BUDGET_EXCEEDED'));
  assert.equal(calls.length, 1);
  assert.equal(kakao.activeKeySlots().apis['/v2/routing/walk'], 'fallback');
});

test('a network failure whose text carries the key is replaced by a fixed message', async () => {
  const fetcher = (async (input: URL | string) => {
    throw new TypeError(`fetch failed ${String(input)} KakaoAK ${PRIMARY} ${SPARE}`);
  }) as typeof fetch;
  const kakao = new KakaoProvider({ key: PRIMARY, fallbackKey: SPARE, fetcher });
  await assert.rejects(kakao.walking(request, new CallBudget(10)), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    const text = `${error.message} ${String(error.stack)} ${JSON.stringify(error)}`;
    assert.ok(!text.includes(PRIMARY) && !text.includes(SPARE));
    return true;
  });
});
