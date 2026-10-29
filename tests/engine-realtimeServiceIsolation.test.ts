// Preserved regression cases from perception-map/mvp/tests/realtimeServiceIsolation.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeService } from '../src/common/engine/realtime/service.js';

const NOW = Date.UTC(2026, 9, 15, 3, 0, 0);

const json = (body: unknown) => new Response(JSON.stringify(body));

const query = {
  mode: 'bus' as const,
  stop: '서울역버스환승센터',
  lines: ['402'],
  nextStops: ['숭례문'],
  latitude: 37.5555,
  longitude: 126.9726,
};

const stops = {
  response: {
    header: {
      resultCode: '00',
    },
    body: {
      items: {
        item: {
          nodeid: 'SEOUL1001',
          nodenm: '서울역버스환승센터',
          citycode: '11',
          gpslati: 37.5555,
          gpslong: 126.9726,
        },
      },
    },
  },
};

const arrivals = {
  response: {
    header: {
      resultCode: '00',
    },
    body: {
      items: {
        item: {
          routeno: '402',
          arrtime: 180,
          arrprevstationcnt: 2,
        },
      },
    },
  },
};

test('one rejected bus supplier does not suppress the other supplier or retry a blocked key on every search', async () => {
  let seoulCalls = 0;
  const service = new RealtimeService({
    dataGoKrServiceKey: 'fixture',
    now: () => NOW,
    fetcher: async (input) => {
      const url = new URL(String(input));

      if (url.hostname === 'ws.bus.go.kr') {
        seoulCalls += 1;

        return new Response('', {
          status: 401,
        });
      }

      return json(url.pathname.includes('getCrdntPrxmtSttnList') ? stops : arrivals);
    },
  });
  // Supplier isolation alone: a real journey additionally requires a verified next-stop direction.
  const undirected = {
    ...query,
    nextStops: [],
  };

  const first = await service.lookup(undirected);

  assert.equal(first?.provider, 'tago-bus');
  assert.equal(first?.predictions[0].arrivesAt, NOW + 180_000);
  assert.equal((await service.lookup(undirected))?.provider, 'tago-bus');
  assert.equal(seoulCalls, 1);
});

test('cached bus observations retain original receipt as well as the absolute prediction', async () => {
  let time = NOW;
  const service = new RealtimeService({
    dataGoKrServiceKey: 'fixture',
    now: () => time,
    fetcher: async (input) =>
      json(
        String(input).includes('getStationByPos')
          ? {
              msgHeader: {
                headerCd: '0',
              },
              msgBody: {
                itemList: {
                  arsId: '02001',
                  stationNm: query.stop,
                  gpsX: query.longitude,
                  gpsY: query.latitude,
                },
              },
            }
          : {
              msgHeader: {
                headerCd: '0',
              },
              msgBody: {
                itemList: {
                  rtNm: '402',
                  arrmsg1: '3분 후',
                  arrmsg2: '운행종료',
                  nxtStn: '숭례문',
                },
              },
            },
      ),
  });

  const first = await service.lookup(query);

  time += 10_000;

  const cached = await service.lookup(query);

  assert.equal(first?.receivedAt, NOW);
  assert.equal(cached?.receivedAt, NOW, 'a cache lookup is not a new external receipt');
  assert.equal(cached?.predictions[0].arrivesAt, NOW + 180_000);
});

test('cached subway rows retain the receipt of the source response', async () => {
  let time = NOW;
  const service = new RealtimeService({
    seoulOpenApiKey: 'fixture',
    now: () => time,
    fetcher: async () =>
      json({
        errorMessage: {
          code: 'INFO-000',
        },
        realtimeArrivalList: [
          {
            subwayId: '1001',
            trainLineNm: '소요산행 - 시청방면',
            bstatnNm: '소요산',
            barvlDt: '180',
            recptnDt: '2026-10-15 12:00:00',
            arvlCd: '99',
            btrainNo: '1234',
            btrainSttus: '일반',
          },
        ],
      }),
  });
  const subway = {
    ...query,
    mode: 'subway' as const,
    stop: '서울역',
    lines: ['1호선'],
    nextStops: ['시청'],
  };

  assert.equal((await service.lookup(subway))?.receivedAt, NOW);

  time += 10_000;

  const cached = await service.lookup(subway);

  assert.equal(cached?.receivedAt, NOW);
  assert.equal(cached?.predictions[0].arrivesAt, NOW + 180_000);
});

test('all bus suppliers and TAGO operations consume the shared public-data key despite legacy options', async () => {
  const used: {
    host: string;
    path: string;
    keys: string[];
  }[] = [];
  const options = {
    dataGoKrServiceKey: ' shared%2Bkey%2Fwith%3Dreserved ',
    seoulBusServiceKey: 'old-seoul-key',
    tagoBusServiceKey: 'old-tago-key',
    tagoBusStationServiceKey: 'old-station-key',
    tagoBusArrivalServiceKey: 'old-arrival-key',
    now: () => NOW,
    fetcher: async (input: URL | RequestInfo) => {
      const url = new URL(String(input));

      used.push({
        host: url.hostname,
        path: url.pathname,
        keys: url.searchParams.getAll('serviceKey'),
      });

      if (url.hostname === 'ws.bus.go.kr') {
        return new Response('', {
          status: 401,
        });
      }

      return json(url.pathname.includes('getCrdntPrxmtSttnList') ? stops : arrivals);
    },
  };
  const service = new RealtimeService(options);

  assert.equal(
    (
      await service.lookup({
        ...query,
        nextStops: [],
      })
    )?.provider,
    'tago-bus',
  );
  assert.deepEqual(used, [
    {
      host: 'ws.bus.go.kr',
      path: '/api/rest/stationinfo/getStationByPos',
      keys: ['shared+key/with=reserved'],
    },
    {
      host: 'apis.data.go.kr',
      path: '/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList',
      keys: ['shared+key/with=reserved'],
    },
    {
      host: 'apis.data.go.kr',
      path: '/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',
      keys: ['shared+key/with=reserved'],
    },
  ]);
});

test('legacy realtime bus credentials cannot configure a missing shared public-data key', async () => {
  let requests = 0;
  const options = {
    dataGoKrServiceKey: ' \t ',
    seoulBusServiceKey: 'old-seoul-key',
    tagoBusServiceKey: 'old-tago-key',
    tagoBusStationServiceKey: 'old-station-key',
    tagoBusArrivalServiceKey: 'old-arrival-key',
    now: () => NOW,
    fetcher: async () => {
      requests += 1;

      return json({});
    },
  };
  const service = new RealtimeService(options);

  assert.deepEqual(service.capabilities, {
    subway: false,
    bus: false,
  });
  assert.equal(await service.lookup(query), null);
  assert.equal(requests, 0);
});
