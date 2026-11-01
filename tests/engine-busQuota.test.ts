// Seoul bus daily quota (2026-11-01): quota is told apart from a bad key, spare keys fail over per operation until
// 00:00 KST, one arrival cache serves search, guidance and nearby stops, and a daily budget keeps guidance last.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseSegment } from '../src/common/shared/domain/types.js';
import { FeedError, fetchFeedJson, nextKstMidnight } from '../src/common/engine/realtime/http.js';
import { ServiceKeyPool } from '../src/common/engine/realtime/key-pool.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { SeoulSubwayFeed } from '../src/common/engine/realtime/seoulSubway.js';
import {
  BUS_QUOTA_WAIT_COPY,
  labelBusQuotaWaits,
  RealtimeService,
  type BoardingQuery,
} from '../src/common/engine/realtime/service.js';

const PRIMARY = 'primary-secret-aaaa1111';
const SPARE = 'spare-secret-bbbb2222';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const reason = (expected: FeedError['reason']) => (error: unknown) =>
  error instanceof FeedError && error.reason === expected;
// The portal's own 401 bodies, read on 2026-11-01 (busquota/U-BUS.md §0).
const SPENT_401 = {
  error: 'Unauthorized',
  message: '유효하지 않은 서비스키입니다: 서비스 요청제한 횟수 초과 에러',
  status: 401,
};
const UNREGISTERED_401 = {
  error: 'Unauthorized',
  message: '유효하지 않은 서비스키입니다: 등록되지 않은 서비스키',
  status: 401,
};
const point = { latitude: 37.5496, longitude: 126.9139 };
const query: BoardingQuery = {
  mode: 'bus',
  stop: '합정역',
  lines: ['7612'],
  nextStops: ['홍대입구역'],
  ...point,
};
const at = (iso: string) => Date.parse(`${iso}+09:00`);

type Slot = 'primary' | 'spare';
/** A fake ws.bus.go.kr with one stop; `spent(slot, operation)` makes that key answer the portal's quota 401. */
function topis(spent: (slot: Slot, operation: string) => boolean = () => false) {
  const calls: { slot: Slot; operation: string }[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    const slot: Slot = url.searchParams.get('serviceKey') === PRIMARY ? 'primary' : 'spare';
    const operation = url.pathname.split('/').at(-1)!;
    calls.push({ slot, operation });
    if (spent(slot, operation)) return json(SPENT_401, 401);
    if (operation === 'getStationByPos')
      return json({
        msgHeader: { headerCd: '0' },
        msgBody: {
          itemList: [
            { arsId: '14001', stationNm: '합정역', gpsX: point.longitude, gpsY: point.latitude },
          ],
        },
      });
    return json({
      msgHeader: { headerCd: '0' },
      msgBody: {
        itemList: [{ rtNm: '7612', nxtStn: '홍대입구역', arrmsg1: '4분12초후[2번째 전]' }],
      },
    });
  }) as typeof fetch;
  const count = (operation: string, slot?: Slot) =>
    calls.filter((call) => call.operation === operation && (!slot || call.slot === slot)).length;
  return { calls, fetcher, count };
}

test('the portal says a spent daily quota and a bad key with the same 401; only the body tells them apart', async () => {
  const url = new URL('https://feed.example/?serviceKey=private-fixture');
  await assert.rejects(
    fetchFeedJson(url, { fetcher: async () => json(SPENT_401, 401) }),
    reason('quota'),
  );
  await assert.rejects(
    fetchFeedJson(url, { fetcher: async () => json(UNREGISTERED_401, 401) }),
    reason('auth'),
  );
  const xml = (code: string, message: string) =>
    `<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>${message}</returnAuthMsg><returnReasonCode>${code}</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  await assert.rejects(
    fetchFeedJson(url, {
      fetcher: async () =>
        new Response(xml('22', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR')),
    }),
    reason('quota'),
  );
  // The per-second limit passes in a moment; it is not a day's quota.
  await assert.rejects(
    fetchFeedJson(url, {
      fetcher: async () =>
        new Response(xml('23', 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR')),
    }),
    (error) => error instanceof FeedError && error.reason !== 'quota',
  );
});

test('quota resets at the next 00:00 in Korea', () => {
  assert.equal(nextKstMidnight(at('2026-11-01T23:25:00')), at('2026-11-02T00:00:00'));
  assert.equal(nextKstMidnight(at('2026-11-02T00:00:00')), at('2026-11-03T00:00:00'));
});

test('a spent primary moves only that operation to the spare key until 00:00 KST, and no key leaks', async () => {
  let time = at('2026-11-01T23:00:00');
  const fake = topis((slot, operation) => slot === 'primary' && operation === 'getStationByUid');
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    dataGoKrServiceKeyFallback: SPARE,
    fetcher: fake.fetcher,
    now: () => time,
  });
  const first = await realtime.lookup(query, 'guidance');
  assert.equal(first?.predictions[0].arrivesAt, time + 252_000);
  // Stops still come from the primary; only the arrival operation moved.
  assert.equal(fake.count('getStationByPos', 'primary'), 1);
  assert.equal(fake.count('getStationByPos', 'spare'), 0);
  assert.deepEqual(
    fake.calls.filter((call) => call.operation === 'getStationByUid').map((call) => call.slot),
    ['primary', 'spare'],
  );
  // While the primary is closed, it is not asked again.
  time += 40_000;
  await realtime.lookup(query, 'guidance');
  assert.equal(fake.count('getStationByUid', 'primary'), 1);
  assert.equal(fake.count('getStationByUid', 'spare'), 2);
  // After midnight the primary is asked first again.
  time = at('2026-11-02T00:00:01');
  await realtime.lookup(query, 'guidance');
  assert.equal(fake.count('getStationByUid', 'primary'), 2);
  const health = JSON.stringify(realtime.diagnostics);
  assert.equal(health.includes(PRIMARY) || health.includes(SPARE), false);
});

test('only a spent quota fails over; a rejected key is the answer and the spare is not asked', async () => {
  const calls: string[] = [];
  const pool = new ServiceKeyPool([PRIMARY, SPARE]);
  await assert.rejects(
    pool.call('getStationByUid', 'guidance', async (key) => {
      calls.push(key);
      throw new FeedError('auth');
    }),
    reason('auth'),
  );
  assert.deepEqual(calls, [PRIMARY]);
});

test('with every key spent, health says quota until midnight and route waits say why', async () => {
  const time = at('2026-11-01T23:25:00');
  const fake = topis((_, operation) => operation === 'getStationByUid');
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    dataGoKrServiceKeyFallback: SPARE,
    fetcher: fake.fetcher,
    now: () => time,
  });
  assert.equal(await realtime.lookup(query), null);
  const seoul = realtime.diagnostics.find((source) => source.provider === 'seoul-bus')!;
  assert.equal(seoul.status, 'quota');
  assert.equal(seoul.reason, 'quota');
  assert.equal(seoul.resetsAt, at('2026-11-02T00:00:00'));
  assert.equal(realtime.quotaUntil('seoul-bus'), at('2026-11-02T00:00:00'));
  // Spent keys are not asked again today.
  const before = fake.calls.length;
  assert.equal(await realtime.lookup(query, 'guidance'), null);
  assert.equal(fake.calls.length, before);

  const segment = (id: string, mode: BaseSegment['mode'], extra: Partial<BaseSegment> = {}) =>
    ({
      id,
      mode,
      title: id,
      instructions: '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
      ...extra,
    }) as BaseSegment;
  const [route] = labelBusQuotaWaits([
    {
      segments: [
        segment('walk', 'walk'),
        segment('wait-bus', 'wait'),
        segment('bus', 'bus'),
        segment('wait-subway', 'wait'),
        segment('subway', 'subway'),
      ],
    },
  ]);
  assert.deepEqual(
    route.segments.map((value) => value.instructions),
    [
      '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
      BUS_QUOTA_WAIT_COPY,
      '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
      '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
      '평균 배차 간격으로 계산한 예상 대기 시간이에요.',
    ],
  );
});

test('nearby stops, route search and guidance share one arrival request per stop and 30 s', async () => {
  let time = at('2026-11-02T08:30:00');
  const fake = topis();
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    fetcher: fake.fetcher,
    now: () => time,
  });
  const nearby = new NearbyTransitService({ realtime, now: () => time });
  await Promise.all([
    realtime.lookup(query),
    realtime.busSheet(query),
    realtime.lookup(query, 'guidance'),
    nearby.snapshot(point),
  ]);
  assert.equal(fake.count('getStationByUid'), 1);
  assert.equal(fake.count('getStationByPos'), 1);
  time += 29_000;
  await nearby.snapshot(point);
  await realtime.lookup(query, 'guidance');
  assert.equal(fake.count('getStationByUid'), 1);
  time += 2_000;
  await realtime.lookup(query, 'guidance');
  assert.equal(fake.count('getStationByUid'), 2);
});

test('a guided wait polled every 30 s for 8 minutes costs 16 arrival calls, not 24', async () => {
  let time = at('2026-11-02T08:30:00');
  const fake = topis();
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    fetcher: fake.fetcher,
    now: () => time,
  });
  for (let elapsed = 0; elapsed < 8 * 60_000; elapsed += 30_000) {
    time += 30_000;
    await realtime.lookup(query, 'guidance');
  }
  assert.equal(fake.count('getStationByUid'), 16);
  assert.equal(fake.count('getStationByPos'), 1);
});

test('the daily budget stops browsing at 80 %, search at 95 % and keeps the rest for guidance', async () => {
  const time = at('2026-11-02T08:30:00');
  const pool = new ServiceKeyPool([PRIMARY], { now: () => time, dailyLimit: 20 });
  let sent = 0;
  const call = (purpose: 'browse' | 'search' | 'guidance') =>
    pool.call('getStationByUid', purpose, async () => {
      sent += 1;
      return sent;
    });
  const spend = async (purpose: 'browse' | 'search' | 'guidance') => {
    let made = 0;
    while (
      await call(purpose).then(
        () => true,
        () => false,
      )
    )
      made += 1;
    return made;
  };
  assert.equal(await spend('browse'), 16);
  assert.equal(await spend('search'), 3);
  assert.equal(await spend('guidance'), 1);
  assert.equal(pool.closedUntil('getStationByUid'), at('2026-11-03T00:00:00'));
  assert.deepEqual(pool.usage().calls, { 'primary:getStationByUid': 20 });
});

test('nearby stops say the bus quota is spent instead of blaming the key', async () => {
  const time = at('2026-11-01T23:25:00');
  const fake = topis((_, operation) => operation === 'getStationByUid');
  const nearby = new NearbyTransitService({
    dataGoKrServiceKey: PRIMARY,
    fetcher: fake.fetcher,
    now: () => time,
  });
  const first = await nearby.snapshot(point);
  assert.equal(first.bus.status, 'error');
  assert.match(first.bus.message, /한도/);
  const before = fake.calls.length;
  const second = await nearby.snapshot(point);
  assert.match(second.bus.message, /한도/);
  assert.equal(fake.calls.length, before);
});

test('a Seoul subway key with spent daily traffic (ERROR-337) hands over to the spare', async () => {
  const used: string[] = [];
  const feed = new SeoulSubwayFeed(new ServiceKeyPool([PRIMARY, SPARE]), {
    fetcher: (async (input: URL | string) => {
      const key = decodeURIComponent(new URL(String(input)).pathname.split('/')[3]);
      used.push(key === PRIMARY ? 'primary' : 'spare');
      return key === PRIMARY
        ? json({ errorMessage: { code: 'ERROR-337' } })
        : json({ errorMessage: { code: 'INFO-000' }, realtimeArrivalList: [] });
    }) as typeof fetch,
  });
  assert.deepEqual(await feed.stationRows('합정', at('2026-11-02T08:30:00')), []);
  assert.deepEqual(used, ['primary', 'spare']);
});
