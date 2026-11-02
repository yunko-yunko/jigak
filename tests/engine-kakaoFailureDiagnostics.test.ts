// A failed Kakao call leaves one log line (path, status, Kakao code and message, key slot, time) and a dropped
// connection, a timeout or a 5xx gets exactly one more try inside the search's call budget.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import { KakaoProvider, type RouteEndpoints } from '../src/common/engine/kakao.js';

const PRIMARY = 'primary-secret-aaaa1111';
const SPARE = 'spare-secret-bbbb2222';
const TYPED = '내가-입력한-검색어';
const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request: RouteEndpoints = {
  origin: { id: 'a', name: '출발', address: '', latitude: 37.55, longitude: 126.97 },
  destination: { id: 'b', name: '도착', address: '', latitude: 37.551, longitude: 126.971 },
};

/** A scripted Kakao: each call takes the next answer (the last one repeats); every call is recorded. */
function scripted(...answers: (Response | Error | (() => Promise<Response>))[]) {
  const calls: { path: string; query: string; auth: string }[] = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      query: url.search,
      auth: String((init?.headers as Record<string, string>).Authorization),
    });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer.clone();
  }) as typeof fetch;
  return { calls, fetcher };
}
function provider(
  fetcher: typeof fetch,
  extra: ConstructorParameters<typeof KakaoProvider>[0] = {},
) {
  const lines: string[] = [];
  const kakao = new KakaoProvider({
    key: PRIMARY,
    fetcher,
    retryDelayMs: () => 0,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { kakao, lines };
}

test('a 5xx is logged with path, status, key slot and time, retried once, and may then succeed', async () => {
  const { calls, fetcher } = scripted(
    new Response('upstream down', { status: 502 }),
    json({ documents: [], meta: {} }),
  );
  const { kakao, lines } = provider(fetcher);
  assert.deepEqual(await kakao.searchPlaces({ q: TYPED }), []);
  assert.equal(calls.length, 2);
  assert.equal(lines.length, 1, 'one line per failed call, none for the success');
  assert.match(lines[0], /^Kakao call failed: \/v2\/local\/search\/keyword\.json status=502 /);
  assert.match(lines[0], / code=PROVIDER_UNAVAILABLE /);
  assert.match(lines[0], / key=primary attempt=1 elapsedMs=\d+$/);
});

test('a log line never holds a key, the Authorization header, the query or the typed text', async () => {
  const body = {
    errorType: 'ServerError',
    message: `bad ${PRIMARY} and ${SPARE}`,
    code: -9,
  };
  const { fetcher } = scripted(json(body, 500));
  const { kakao, lines } = provider(fetcher, { fallbackKey: SPARE });
  await assert.rejects(kakao.searchPlaces({ q: TYPED }), code('PROVIDER_UNAVAILABLE'));
  assert.equal(lines.length, 2, 'both tries are logged');
  for (const line of lines) {
    assert.ok(!line.includes(PRIMARY) && !line.includes(SPARE), 'no key');
    assert.ok(!/authorization|kakaoak/i.test(line), 'no header');
    assert.ok(!line.includes(TYPED) && !line.includes(encodeURIComponent(TYPED)), 'no user text');
    assert.ok(!line.includes('?') && !line.includes('http'), 'a path, not a URL');
    assert.match(line, /kakaoCode=-9 kakaoMsg="bad \*\*\* and \*\*\*"/);
  }
});

test('a dropped connection is retried once and logged as status none', async () => {
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const { calls, fetcher } = scripted(dropped, json({ documents: [], meta: {} }));
  const { kakao, lines } = provider(fetcher);
  assert.deepEqual(
    await kakao.nearby({ keyword: '주차장', latitude: 37.5, longitude: 127, radius: 500 }),
    [],
  );
  assert.equal(calls.length, 2);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /status=none code=PROVIDER_UNAVAILABLE kakaoCode=- kakaoMsg="TypeError ECONNRESET"/,
  );
});

test('a timeout is retried once; a second timeout is the answer', async () => {
  const never = () => new Promise<Response>(() => undefined);
  const { calls, fetcher } = scripted(never);
  const { kakao, lines } = provider(fetcher, { timeoutMs: 15 });
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_TIMEOUT'));
  assert.equal(calls.length, 2, 'one retry, not a loop');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /code=PROVIDER_TIMEOUT .* attempt=2 /);
});

test('a 5xx twice is the answer after exactly two calls, both on the same key', async () => {
  const { calls, fetcher } = scripted(new Response('', { status: 503 }));
  const { kakao } = provider(fetcher, { fallbackKey: SPARE });
  await assert.rejects(kakao.driving(request, new CallBudget(10)), code('PROVIDER_UNAVAILABLE'));
  assert.deepEqual(
    calls.map((call) => call.auth),
    [`KakaoAK ${PRIMARY}`, `KakaoAK ${PRIMARY}`],
  );
});

test('a 4xx and a spent quota are logged but never retried', async () => {
  const cases: [Response, ApiError['code']][] = [
    [
      json({ errorType: 'InvalidArgument', message: 'query is required' }, 400),
      'PROVIDER_UNAVAILABLE',
    ],
    [new Response('', { status: 404 }), 'PROVIDER_UNAVAILABLE'],
    [new Response('', { status: 401 }), 'PROVIDER_AUTH'],
    [new Response('', { status: 403 }), 'PROVIDER_FORBIDDEN'],
    [new Response('', { status: 429 }), 'PROVIDER_LIMIT'],
  ];
  for (const [answer, expected] of cases) {
    const { calls, fetcher } = scripted(answer);
    const { kakao, lines } = provider(fetcher);
    await assert.rejects(kakao.searchPlaces({ q: TYPED }), code(expected));
    assert.equal(calls.length, 1, `${answer.status} is not retried`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`status=${answer.status} code=${expected} `));
  }
  const spent = json(
    { errorType: 'BadRequest', message: 'API limit has been exceeded.', code: -10 },
    400,
  );
  const { calls, fetcher } = scripted(spent);
  const { kakao, lines } = provider(fetcher);
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_LIMIT'));
  assert.equal(calls.length, 1, 'code -10 is not retried');
  assert.match(
    lines[0],
    /status=400 code=PROVIDER_LIMIT kakaoCode=-10 kakaoMsg="API limit has been exceeded\."/,
  );
  // A routing 400 with any other code is a failure of the call, not a quota, and not worth a second try.
  const { calls: other, fetcher: otherFetcher } = scripted(
    json({ code: -2, msg: 'wrong input' }, 400),
  );
  await assert.rejects(
    provider(otherFetcher).kakao.transit(request, new CallBudget(10)),
    code('PROVIDER_UNAVAILABLE'),
  );
  assert.equal(other.length, 1);
});

test('the retry spends a call of the search budget and never exceeds it', async () => {
  const { calls, fetcher } = scripted(new Response('', { status: 500 }));
  const { kakao, lines } = provider(fetcher);
  const roomy = new CallBudget(5);
  await assert.rejects(kakao.walking(request, roomy), code('PROVIDER_UNAVAILABLE'));
  assert.equal(roomy.used, 2);
  calls.length = 0;
  lines.length = 0;
  const tight = new CallBudget(1);
  await assert.rejects(kakao.walking(request, tight), code('PROVIDER_UNAVAILABLE'));
  assert.equal(calls.length, 1, 'no slot left, so no second call');
  assert.equal(tight.used, 1);
  assert.equal(lines.length, 1);
  // A budget that fills up during the pause also leaves the first failure as the answer.
  const filling = new CallBudget(2);
  const slow = provider(fetcher, {
    retryDelayMs: () => {
      void filling.run(() => undefined);
      return 0;
    },
  });
  calls.length = 0;
  await assert.rejects(slow.kakao.walking(request, filling), code('PROVIDER_UNAVAILABLE'));
  assert.equal(calls.length, 1);
});

test('the pause before the retry is 300-600 ms', async () => {
  const delays: number[] = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) => {
    // Only the retry pause sits between 250 ms and the 8 s call timeout.
    const pause = ms !== undefined && ms >= 250 && ms < 1_000;
    if (pause) delays.push(ms);
    return real(handler, pause ? 0 : ms, ...rest);
  }) as typeof setTimeout;
  try {
    for (let run = 0; run < 20; run++) {
      const { fetcher } = scripted(new Response('', { status: 500 }));
      const kakao = new KakaoProvider({ key: PRIMARY, fetcher, log: () => undefined });
      await assert.rejects(kakao.searchPlaces({ q: TYPED }), code('PROVIDER_UNAVAILABLE'));
    }
  } finally {
    globalThis.setTimeout = real;
  }
  assert.equal(delays.length, 20);
  for (const delay of delays) assert.ok(delay >= 300 && delay <= 600, `${delay} ms`);
});

test('a broken logger never changes what the caller gets', async () => {
  const { fetcher } = scripted(new Response('', { status: 500 }));
  const kakao = new KakaoProvider({
    key: PRIMARY,
    fetcher,
    retryDelayMs: () => 0,
    log: () => {
      throw new Error('disk full');
    },
  });
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_UNAVAILABLE'));
});

test('Kakao code and message are logged from a rejected key; a stalled error body only delays by a moment', async () => {
  const { fetcher } = scripted(json({ code: -401, msg: 'wrong appKey' }, 401));
  const { kakao, lines } = provider(fetcher);
  await assert.rejects(kakao.walking(request, new CallBudget(10)), code('PROVIDER_AUTH'));
  assert.match(
    lines[0],
    /status=401 code=PROVIDER_AUTH kakaoCode=-401 kakaoMsg="wrong appKey" key=primary/,
  );

  const stalled = async () =>
    new Response(
      new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) }),
      {
        status: 403,
      },
    );
  const slow = scripted(stalled);
  const quick = provider(slow.fetcher);
  const started = Date.now();
  await assert.rejects(
    quick.kakao.walking(request, new CallBudget(10)),
    code('PROVIDER_FORBIDDEN'),
  );
  assert.ok(Date.now() - started < 1_000, 'the answer does not wait for the error body');
  assert.match(quick.lines[0], /status=403 code=PROVIDER_FORBIDDEN kakaoCode=- kakaoMsg=""/);
});
