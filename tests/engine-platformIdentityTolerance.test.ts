// Regression cases from mvp/tests/platformIdentityTolerance.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeService, type BoardingQuery } from '../src/common/engine/realtime/service.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';

const now = Date.UTC(2026, 9, 28, 3);
const point = { latitude: 37.55491338, longitude: 126.97224974 };
const query: BoardingQuery = {
  mode: 'bus',
  stop: '서울역버스환승센터(3번승강장)',
  lines: ['1711', '7016'],
  nextStops: ['갈월동'],
  ...point,
};
// Bounded official TOPIS probe on 2026-10-28: getStationByPos returned these
// public coordinates. Stop 02003 was 25.9m from the Kakao platform-3 anchor;
// getStationByUid(02003) contained both routes with nxtStn=갈월동.
// This fixture replays that source shape without keys or external requests.
const officialStops = [
  {
    arsId: '02003',
    stationNm: '서울역버스환승센터',
    gpsY: '37.5551460158',
    gpsX: '126.9722570849',
  },
  {
    arsId: '02004',
    stationNm: '서울역버스환승센터',
    gpsY: '37.5554029828',
    gpsX: '126.9725924801',
  },
  { arsId: '02005', stationNm: '서울역버스환승센터', gpsY: '37.555388989', gpsX: '126.9727238221' },
];
type Stop = (typeof officialStops)[number];
const arrivals = [
  { rtNm: '1711', nxtStn: '갈월동', arrmsg1: '곧 도착', arrmsg2: '7분후[2번째 전]' },
  { rtNm: '7016', nxtStn: '갈월동', arrmsg1: '곧 도착', arrmsg2: '12분후[3번째 전]' },
];
function service(stops: Stop[], rows = arrivals) {
  const requestedIds: string[] = [];
  const realtime = new RealtimeService({
    dataGoKrServiceKey: 'fixture',
    now: () => now,
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'apis.data.go.kr')
        return new Response(
          JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: '' } } }),
        );
      assert.equal(url.hostname, 'ws.bus.go.kr');
      if (url.pathname.endsWith('getStationByPos'))
        return new Response(
          JSON.stringify({ msgHeader: { headerCd: '0' }, msgBody: { itemList: stops } }),
        );
      assert.ok(url.pathname.endsWith('getStationByUid'));
      requestedIds.push(url.searchParams.get('arsId')!);
      return new Response(
        JSON.stringify({ msgHeader: { headerCd: '0' }, msgBody: { itemList: rows } }),
      );
    },
  });
  return { realtime, requestedIds };
}
function nearby(id: string, northMeters: number): Stop {
  return {
    arsId: id,
    stationNm: '서울역버스환승센터',
    gpsY: String(point.latitude + northMeters / 111_195),
    gpsX: String(point.longitude),
  };
}

test('actual platform 3 uses unique line and next-stop evidence across the observed 25.9m unlabeled coordinate offset', async () => {
  const observed = metersBetween(point, {
    latitude: Number(officialStops[0].gpsY),
    longitude: Number(officialStops[0].gpsX),
  });
  assert.ok(observed > 25 && observed < 27);
  const { realtime, requestedIds } = service(officialStops);
  const result = await realtime.lookup(query);
  assert.equal(result?.provider, 'seoul-bus');
  assert.equal(result?.status, 'live');
  assert.deepEqual(
    result?.predictions.map((prediction) => [prediction.line, prediction.arrivesAt]),
    [
      ['1711', now + 420_000],
      ['7016', now + 720_000],
    ],
  );
  assert.deepEqual(
    requestedIds,
    ['02003'],
    'the 62m and 67m platforms must remain outside this identity tolerance',
  );
});

test('competing unlabeled platforms with the same line and next-stop evidence remain ambiguous', async () => {
  const { realtime } = service([officialStops[0], nearby('competing-platform', 11)]);
  assert.equal(await realtime.lookup(query), null);
});

for (const wrong of ['next-stop', 'route'] as const) {
  test(`an unlabeled candidate cannot bypass the ${wrong} identity check`, async () => {
    const rows = arrivals.map((row) => ({
      ...row,
      ...(wrong === 'next-stop' ? { nxtStn: '숭례문.서울역4번출구' } : { rtNm: '9999' }),
    }));
    assert.equal(await service([officialStops[0]], rows).realtime.lookup(query), null);
  });
}

test('the extra tolerance does not relax ordinary or explicitly labeled strict stop matching', async () => {
  assert.equal(
    await service([officialStops[0]]).realtime.lookup({ ...query, stop: '서울역버스환승센터' }),
    null,
  );
  const labeled = { ...officialStops[0], stationNm: query.stop };
  assert.equal(await service([labeled]).realtime.lookup(query), null);
});

test('a matching line and direction cannot justify an 83m platform snap', async () => {
  assert.equal(await service([nearby('far-platform', 83)]).realtime.lookup(query), null);
});

test('three nearby unlabeled platforms are never hidden behind the two-candidate lookup cap', async () => {
  const { realtime, requestedIds } = service([
    officialStops[0],
    nearby('second-platform', 11),
    nearby('third-platform', -11),
  ]);
  assert.equal(await realtime.lookup(query), null);
  assert.equal(requestedIds.length, 0);
});
