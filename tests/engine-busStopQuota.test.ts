// Seoul bus quotas are per operation (FIXPLAN D4 R5, 2026-11-02): a spent stop list (getStationByPos) makes the
// source spent for health and wait copy, never sends the Seoul boarding to TAGO, and keeps stops already listed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeService, type BoardingQuery } from '../src/common/engine/realtime/service.js';
import { withinBusStopAllowance } from '../src/common/engine/transit-enrichment.js';

const PRIMARY = 'primary-secret-aaaa1111';
const SPARE = 'spare-secret-bbbb2222';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// The portal's own quota 401 body, read on 2026-11-01 (busquota/U-BUS.md §0).
const SPENT_401 = {
  error: 'Unauthorized',
  message: '유효하지 않은 서비스키입니다: 서비스 요청제한 횟수 초과 에러',
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

/** ws.bus.go.kr and the TAGO stop list behind one fetcher; `spent(operation)` answers the quota 401 on both keys. */
function feeds(spent: (operation: string) => boolean) {
  const calls: string[] = [];
  const fetcher = (async (input: URL | string) => {
    const operation = new URL(String(input)).pathname.split('/').at(-1)!;
    calls.push(operation);
    if (spent(operation)) return json(SPENT_401, 401);
    if (operation === 'getStationByPos')
      return json({
        msgHeader: { headerCd: '0' },
        msgBody: {
          itemList: [
            { arsId: '14001', stationNm: '합정역', gpsX: point.longitude, gpsY: point.latitude },
          ],
        },
      });
    if (operation === 'getStationByUid')
      return json({
        msgHeader: { headerCd: '0' },
        msgBody: {
          itemList: [{ rtNm: '7612', nxtStn: '홍대입구역', arrmsg1: '4분12초후[2번째 전]' }],
        },
      });
    return json({ response: { header: { resultCode: '00' }, body: { items: '' } } });
  }) as typeof fetch;
  return { calls, fetcher };
}

test('a spent Seoul stop list makes the source spent, and the boarding is not sent to TAGO', async () => {
  const time = at('2026-11-01T23:25:00');
  const fake = feeds((operation) => operation === 'getStationByPos');
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    dataGoKrServiceKeyFallback: SPARE,
    fetcher: fake.fetcher,
    now: () => time,
  });
  assert.equal(await realtime.lookup(query), null);
  assert.deepEqual(fake.calls, ['getStationByPos', 'getStationByPos']);
  assert.equal(realtime.quotaUntil('seoul-bus'), at('2026-11-02T00:00:00'));
  const seoul = realtime.diagnostics.find((source) => source.provider === 'seoul-bus')!;
  assert.equal(seoul.status, 'quota');
  assert.equal(seoul.resetsAt, at('2026-11-02T00:00:00'));
  // Spent keys are not asked again today, and TAGO is not asked for a Seoul stop either.
  assert.equal(await realtime.lookup(query), null);
  assert.equal(fake.calls.length, 2);
});

test('with only the stop list spent, a stop listed earlier still gets its live arrivals', async () => {
  let time = at('2026-11-01T23:20:00');
  let posSpent = false;
  const fake = feeds((operation) => posSpent && operation === 'getStationByPos');
  const realtime = new RealtimeService({
    dataGoKrServiceKey: PRIMARY,
    fetcher: fake.fetcher,
    now: () => time,
  });
  assert.equal((await realtime.lookup(query))?.status, 'live');
  posSpent = true;
  // A fresh stop elsewhere spends the stop list's last call of the day.
  assert.equal(await realtime.lookup({ ...query, latitude: 37.56, longitude: 126.92 }), null);
  assert.notEqual(realtime.quotaUntil('seoul-bus'), null);
  assert.equal(realtime.busBlocked('seoul-bus'), null);
  // Past the 30 s arrival cache but inside the 10-minute stop cache: one sheet call, no stop list, no TAGO.
  time += 60_000;
  const before = fake.calls.length;
  assert.equal((await realtime.lookup(query))?.status, 'live');
  assert.deepEqual(fake.calls.slice(before), ['getStationByUid']);
  assert.ok(!fake.calls.some((operation) => operation.startsWith('getCrdnt')));
});

test('one search observes at most its allowance of distinct bus stops, highest priority first; rail passes', () => {
  const boarding = (stop: string, lines: string[], mode: BoardingQuery['mode'] = 'bus') =>
    [`${mode}:${stop}:${lines.join(',')}`, { ...query, mode, stop, lines }] as const;
  const allowance = { observed: new Set<string>(), max: 2 };
  const first = withinBusStopAllowance(
    new Map([
      boarding('합정역', ['7612']),
      boarding('합정역', ['271']),
      boarding('홍대입구역', ['7016']),
      boarding('합정', ['2호선'], 'subway'),
      boarding('망원역', ['9711']),
    ]),
    allowance,
  );
  assert.deepEqual(
    [...first.values()].map((value) => `${value.stop} ${value.lines[0]}`),
    ['합정역 7612', '합정역 271', '홍대입구역 7016', '합정 2호선'],
  );
  // A later pass of the same search: a stop it already observed is free, a new one is not.
  const later = withinBusStopAllowance(
    new Map([boarding('망원역', ['9711']), boarding('합정역', ['7612'])]),
    allowance,
  );
  assert.deepEqual(
    [...later.values()].map((value) => value.stop),
    ['합정역'],
  );
  assert.equal(withinBusStopAllowance(later, undefined).size, 1);
});
