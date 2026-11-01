// Regression cases from mvp/tests/trafficSignalBackoff.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareSignalWaits,
  TrafficSignalFeed,
} from '../src/common/engine/realtime/trafficSignals.js';

const START = Date.UTC(2026, 9, 31, 1);
const phase = (id: string, observedAt: number) => [
  { itstId: id, trsmUtcTime: observedAt, ntPdsgRmdrCs: 400, ntPdsgStatNm: 'stop-And-Remain' },
];
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const clock = () => {
  const state = { now: START };
  return {
    state,
    now: () => state.now,
    advance: (milliseconds: number) => {
      state.now += milliseconds;
    },
  };
};
const idOf = (input: RequestInfo | URL) => new URL(String(input)).searchParams.get('itstId')!;

test('an intersection that failed is not asked again until its backoff ends, which doubles while it keeps failing', async () => {
  const time = clock(),
    asked: string[] = [];
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      return reply({ error: 'boom' }, 500);
    },
  });
  assert.equal(await feed.lookup('1'), null);
  time.advance(2_000);
  assert.equal(await feed.lookup('1'), null);
  assert.deepEqual(asked, ['1'], 'the second lookup used the remembered failure');
  time.advance(14_000);
  assert.equal(await feed.lookup('1'), null);
  assert.deepEqual(asked, ['1', '1'], 'asked again once the first 15 s were over');
  time.advance(20_000);
  assert.equal(await feed.lookup('1'), null);
  assert.deepEqual(asked, ['1', '1'], 'the second failure waits 30 s');
  time.advance(11_000);
  await feed.lookup('1');
  assert.equal(asked.length, 3);
});

test('one failing intersection does not hold back the others, and a success clears its record', async () => {
  const time = clock(),
    asked: string[] = [];
  let healthy = false;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      const id = idOf(input);
      asked.push(id);
      return id === 'bad' || (!healthy && id === 'flaky')
        ? reply({}, 500)
        : reply(phase(id, time.now()));
    },
  });
  assert.equal(await feed.lookup('bad'), null);
  assert.equal(await feed.lookup('flaky'), null);
  assert.equal((await feed.lookup('good'))?.id, 'good');
  healthy = true;
  time.advance(16_000);
  assert.equal((await feed.lookup('flaky'))?.id, 'flaky');
  time.advance(2_000);
  assert.equal(
    (await feed.lookup('flaky'))?.id,
    'flaky',
    'a cleared record caches for the usual second only',
  );
  assert.equal(asked.filter((id) => id === 'flaky').length, 3);
});

test('an answer with no usable phase is left alone for a minute', async () => {
  const time = clock(),
    asked: string[] = [];
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      return reply([]);
    },
  });
  assert.equal(await feed.lookup('7'), null);
  time.advance(30_000);
  assert.equal(await feed.lookup('7'), null);
  assert.equal(asked.length, 1);
  time.advance(31_000);
  await feed.lookup('7');
  assert.equal(asked.length, 2);
});

test("a 429 pauses every lookup until the gateway's own reset time", async () => {
  for (const [headers, pauseMs] of [
    [{ 'Retry-After': '20' }, 20_000],
    [{ 'X-RateLimit-Reset': String(Math.floor((START + 45_000) / 1000)) }, 45_000],
    [{ 'X-RateLimit-Reset': '12' }, 12_000],
    [{}, 30_000],
  ] as const) {
    const time = clock(),
      asked: string[] = [];
    const feed = new TrafficSignalFeed({
      key: 'k',
      now: time.now,
      fetcher: async (input) => {
        asked.push(idOf(input));
        return reply({ message: 'too many' }, 429, headers);
      },
    });
    await feed.lookup('1');
    assert.deepEqual(asked, ['1']);
    for (const id of ['2', '3', '4']) assert.equal(await feed.lookup(id), null);
    assert.deepEqual(asked, ['1'], `other intersections wait too (${JSON.stringify(headers)})`);
    time.advance(pauseMs - 1_000);
    await feed.lookup('5');
    assert.deepEqual(asked, ['1'], 'still paused just before the reset');
    time.advance(2_000);
    await feed.lookup('6');
    assert.deepEqual(asked, ['1', '6'], `resumes after ${pauseMs} ms`);
  }
});

test('a spent rate limit announced on a good answer pauses the next lookups', async () => {
  const time = clock(),
    asked: string[] = [];
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      return reply(phase(idOf(input), time.now()), 200, {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': '8',
      });
    },
  });
  assert.equal((await feed.lookup('1'))?.id, '1', 'the answer itself is still used');
  assert.equal(await feed.lookup('2'), null);
  time.advance(9_000);
  assert.equal((await feed.lookup('2'))?.id, '2');
  assert.deepEqual(asked, ['1', '2']);
});

test('a search that looks up a dozen intersections at once sends at most four requests into a refusing gateway', async () => {
  const time = clock(),
    asked: string[] = [];
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return reply({ message: 'too many' }, 429, { 'Retry-After': '30' });
    },
  });
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) => feed.lookup(String(index))),
  );
  assert.ok(results.every((result) => result === null));
  assert.ok(asked.length <= 4, `asked ${asked.length}`);
  // The same crossings in the next route's walk cost nothing.
  await Promise.all(Array.from({ length: 12 }, (_, index) => feed.lookup(String(index))));
  assert.ok(asked.length <= 4);
});

test('a feed that keeps failing across different intersections is skipped as a whole', async () => {
  const time = clock(),
    asked: string[] = [];
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      throw new TypeError('network down');
    },
  });
  for (let index = 0; index < 4; index++) await feed.lookup(`id-${index}`);
  assert.equal(asked.length, 4);
  for (let index = 4; index < 20; index++) assert.equal(await feed.lookup(`id-${index}`), null);
  assert.equal(asked.length, 4, 'four failures in a row pause the whole feed for 30 s');
  time.advance(31_000);
  await feed.lookup('id-20');
  assert.equal(asked.length, 5);
});

test("a healthy gateway is not throttled: after its first good answer a search's crossings are asked together", async () => {
  const time = clock();
  let open = 0,
    peak = 0,
    asked = 0;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked++;
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open--;
      return reply(phase(idOf(input), time.now()));
    },
  });
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: 48 }, (_, index) => feed.lookup(`id-${index}`)),
  );
  const elapsed = performance.now() - started;
  assert.ok(
    results.every((result) => result),
    'every crossing got its live phase',
  );
  assert.equal(asked, 48);
  assert.ok(peak >= 16, `peak ${peak}`);
  // Four at a time would need twelve rounds of 20 ms; one probing round then two more is far shorter.
  assert.ok(elapsed < 150, `${Math.round(elapsed)} ms`);
});

test('after a refusal the gateway is probed with four lookups again until it answers normally', async () => {
  const time = clock();
  let open = 0,
    peak = 0,
    refusing = true;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return refusing
        ? reply({}, 429, { 'Retry-After': '10' })
        : reply(phase(idOf(input), time.now()));
    },
  });
  await feed.lookup('first');
  refusing = false;
  time.advance(11_000);
  peak = 0;
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, index) => feed.lookup(`id-${index}`)),
  );
  assert.ok(results.every((result) => result));
  assert.ok(peak >= 5 && peak <= 32, `after the probe the cap lifts (peak ${peak})`);
  assert.ok(open === 0);
  // Probing: the first wave is four wide.
  const probe = clock();
  const waves: number[] = [];
  let live = 0;
  const cold = new TrafficSignalFeed({
    key: 'k',
    now: probe.now,
    fetcher: async (input) => {
      live++;
      waves.push(live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live--;
      return reply(phase(idOf(input), probe.now()));
    },
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => cold.lookup(`c-${index}`)));
  assert.ok(
    waves.slice(0, 4).every((width) => width <= 4),
    `cold start opens at most four: ${waves.slice(0, 6)}`,
  );
});

test("with a healthy gateway the first walks' signal waits arrive inside the two-second window", async () => {
  // Four routes whose first walk passes twelve signalled crossings each; the gateway takes 250 ms per answer.
  const centres: { id: string; name: string; latitude: number; longitude: number }[] = [];
  const routes = Array.from({ length: 4 }, (_, r) => {
    const path: { latitude: number; longitude: number }[] = [];
    const longitude = 126.9 + r * 0.02;
    for (let i = 0; i < 12; i++) {
      const latitude = 37.5 + i * 0.002;
      centres.push({ id: `${r}-${i}`, name: `교차로${r}-${i}`, latitude, longitude });
      path.push(
        { latitude: latitude - 0.0003, longitude: longitude + 0.0001 },
        { latitude: latitude + 0.0003, longitude: longitude + 0.0001 },
      );
    }
    const place = (point: { latitude: number; longitude: number }, id: string) => ({
      ...point,
      id,
      name: id,
      address: '',
    });
    return {
      id: `r${r}`,
      title: 'r',
      transfers: 0,
      distanceMeters: 2700,
      durationSeconds: { min: 2000, max: 2000 },
      segments: [
        {
          id: `w${r}`,
          mode: 'walk',
          title: 'walk',
          instructions: '걷기',
          start: place(path[0], 'o'),
          end: place(path.at(-1)!, 'd'),
          distanceMeters: 2700,
          durationSeconds: { min: 2000, max: 2000 },
          runAllowed: false,
          polyline: path,
        },
      ],
    };
  }) as unknown as Parameters<typeof prepareSignalWaits>[0];
  const intersections = {
    configured: true,
    near: async (point: { latitude: number; longitude: number }, radius: number) =>
      centres.filter(
        (c) =>
          Math.hypot(
            (c.latitude - point.latitude) * 111_000,
            (c.longitude - point.longitude) * 88_000,
          ) <= radius,
      ),
  };
  const now = Date.now();
  const signals = new TrafficSignalFeed({
    key: 'k',
    fetcher: async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return reply([
        {
          itstId: idOf(input),
          trsmUtcTime: now,
          etPdsgRmdrCs: 300,
          etPdsgStatNm: 'stop-And-Remain',
        },
      ]);
    },
  });
  const apply = prepareSignalWaits(routes, { intersections: intersections as never, signals });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const timed = await apply(routes, now, 2_000);
  const waits = timed.map((route) => route.segments[0].durationSeconds.min - 2000);
  assert.ok(
    waits.every((wait) => wait > 0),
    `signal waits ${waits}`,
  );
});

test('a remembered failure or a paused gateway answers at once, even when every request slot is taken', async () => {
  const time = clock();
  const release: (() => void)[] = [];
  let fail = true,
    asked = 0;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked++;
      if (fail) return reply({}, 500);
      await new Promise<void>((resolve) => release.push(resolve));
      return reply(phase(idOf(input), time.now()));
    },
  });
  assert.equal(await feed.lookup('broken'), null);
  fail = false;
  const busy = Array.from({ length: 4 }, (_, index) => feed.lookup(`busy-${index}`));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(release.length, 4, 'four requests are open and none has answered');
  time.advance(2_000);
  const outcome = await Promise.race([
    feed.lookup('broken'),
    new Promise((resolve) => setTimeout(() => resolve('queued'), 100)),
  ]);
  assert.equal(outcome, null, 'a remembered failure does not wait for a slot');
  assert.equal(asked, 5);
  release.forEach((resolve) => resolve());
  assert.ok((await Promise.all(busy)).every((result) => result));
});

test('a healthy gateway sees every crossing of a search at once, however slowly it answers', async () => {
  const time = clock();
  let open = 0,
    peak = 0;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 60));
      open--;
      return reply(phase(idOf(input), time.now()));
    },
  });
  const started = performance.now();
  // A cold gateway is probed first: the first answer opens the rest, so two answer times cover any number of crossings.
  assert.ok(
    (
      await Promise.all(Array.from({ length: 74 }, (_, index) => feed.lookup(`cold-${index}`)))
    ).every((result) => result),
  );
  const cold = performance.now() - started;
  assert.ok(cold < 60 * 6, `a cold search took ${Math.round(cold)} ms`);
  peak = 0;
  const warmStarted = performance.now();
  time.advance(5_000);
  assert.ok(
    (
      await Promise.all(Array.from({ length: 74 }, (_, index) => feed.lookup(`warm-${index}`)))
    ).every((result) => result),
  );
  const warm = performance.now() - warmStarted;
  assert.ok(peak >= 74, `peak ${peak}`);
  assert.ok(warm < 60 * 2.5, `a warm search took ${Math.round(warm)} ms`);
});

for (const trouble of ['refusal', 'failure', 'spent quota'] as const) {
  test(`a healthy gateway that answers with a ${trouble} is probed with four lookups again`, async () => {
    const time = clock();
    let mode: 'fine' | 'refuse' | 'fail' | 'spent' | 'hold' = 'fine',
      started = 0;
    const gate: (() => void)[] = [];
    const feed = new TrafficSignalFeed({
      key: 'k',
      now: time.now,
      fetcher: async (input) => {
        if (mode === 'refuse') return reply({}, 429, { 'Retry-After': '10' });
        if (mode === 'fail') return reply({}, 500);
        if (mode === 'spent')
          return reply(phase(idOf(input), time.now()), 200, {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': '10',
          });
        started++;
        if (mode === 'hold') await new Promise<void>((resolve) => gate.push(resolve));
        return reply(phase(idOf(input), time.now()));
      },
    });
    // Healthy: a full search of crossings is open together.
    assert.ok(
      (
        await Promise.all(Array.from({ length: 40 }, (_, index) => feed.lookup(`warm-${index}`)))
      ).every((result) => result),
    );
    assert.equal(started, 40);
    mode = trouble === 'refusal' ? 'refuse' : trouble === 'failure' ? 'fail' : 'spent';
    assert.equal((await feed.lookup('trouble')) === null, trouble !== 'spent quota');
    time.advance(11_000);
    started = 0;
    mode = 'hold';
    const results = Array.from({ length: 24 }, (_, index) => feed.lookup(`after-${index}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(started <= 4, `${started} lookups were open before the gateway answered once`);
    while (gate.length) {
      gate.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      (await Promise.all(results)).every((result) => result),
      'the first answer opens the rest',
    );
    assert.equal(started, 24);
  });
}

test('a healthy gateway that starts refusing is asked for at most four lookups of the next search', async () => {
  const time = clock(),
    asked: string[] = [];
  let refusing = false;
  const feed = new TrafficSignalFeed({
    key: 'k',
    now: time.now,
    fetcher: async (input) => {
      asked.push(idOf(input));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return refusing ? reply({ message: 'too many' }, 429) : reply(phase(idOf(input), time.now()));
    },
  });
  await Promise.all(Array.from({ length: 30 }, (_, index) => feed.lookup(`warm-${index}`)));
  refusing = true;
  assert.equal(await feed.lookup('first-refusal'), null);
  time.advance(31_000);
  asked.length = 0;
  const results = await Promise.all(
    Array.from({ length: 74 }, (_, index) => feed.lookup(`next-${index}`)),
  );
  assert.ok(results.every((result) => result === null));
  assert.ok(asked.length <= 4, `${asked.length} lookups reached the refusing gateway`);
});
