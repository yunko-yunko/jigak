// Preserved regression cases from perception-map/mvp/tests/busAuthentication.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseBusStops,
  SeoulBusFeed,
  selectBusArrivals,
  TagoBusFeed,
} from '../src/common/engine/realtime/bus.js';
import { FeedError } from '../src/common/engine/realtime/http.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';

const point = {
  latitude: 37.55807339,
  longitude: 126.97364719,
};

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
    },
  });

const reason = (expected: FeedError['reason']) => (error: unknown) =>
  error instanceof FeedError && error.reason === expected;

test('Seoul bus permission and expired-key codes remain authentication failures', async () => {
  // Official portal codes 20/31 describe access approval and key expiry. Treating
  // these as malformed data would hide the external prerequisite from callers.
  for (const code of ['20', '30', '31', '32']) {
    const feed = new SeoulBusFeed('fixture-service-key', {
      fetcher: async () =>
        reply({
          msgHeader: {
            headerCd: code,
          },
          msgBody: {},
        }),
    });

    await assert.rejects(feed.nearbyStops(point), reason('auth'), code);
  }
});

test('qualitative Seoul bus proximity never becomes a fabricated live countdown', async () => {
  const feed = new SeoulBusFeed('fixture-service-key', {
    fetcher: async () =>
      reply({
        msgHeader: {
          headerCd: '0',
        },
        msgBody: {
          itemList: [
            {
              rtNm: '402',
              arrmsg1: '곧 도착',
              arrmsg2: '도착임박',
              nxtStn: '다음 정류소',
            },
            {
              rtNm: '405',
              arrmsg1: '출발 대기',
              arrmsg2: '운행 종료',
              nxtStn: '다음 정류소',
            },
            {
              rtNm: '406',
              arrmsg1: '3분12초후[2번째 전]',
              arrmsg2: '0초 후',
              nxtStn: '다음 정류소',
            },
            {
              rtNm: '407',
              arrmsg1: '-5분 후',
              arrmsg2: '999999분 후',
              nxtStn: '다음 정류소',
            },
          ],
        },
      }),
  });

  const rows = await feed.arrivals(
    {
      id: '02001',
      name: 'fixture',
      ...point,
    },
    1_800_000_000_000,
  );

  assert.deepEqual(
    rows.slice(0, 4).map((row) => ({
      arrivesAt: row.arrivesAt,
      ended: row.ended,
    })),
    [
      {
        arrivesAt: null,
        ended: false,
      },
      {
        arrivesAt: null,
        ended: false,
      },
      {
        arrivesAt: null,
        ended: false,
      },
      {
        arrivesAt: null,
        ended: true,
      },
    ],
  );
  assert.deepEqual(
    rows.slice(4).map((row) => row.arrivesAt),
    [1_800_000_192_000, 1_800_000_000_000, null, null],
  );
});

test('TAGO uses only a bounded integer source countdown, preserving seconds instead of the rounded display phrase', async () => {
  const feed = new TagoBusFeed('fixture-service-key', {
    fetcher: async () =>
      reply({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            items: {
              item: [245, 0, -1, 1.5, 86_401, null].map((arrtime) => ({
                routeno: '401',
                arrtime,
                arrprevstationcnt: 3,
              })),
            },
          },
        },
      }),
  });

  const rows = await feed.arrivals(
    {
      id: 'TAGO123',
      cityCode: '25',
      name: 'fixture',
      ...point,
    },
    1_800_000_000_000,
  );

  assert.deepEqual(
    rows.map((row) => row.arrivesAt),
    [1_800_000_245_000, 1_800_000_000_000, null, null, null, null],
  );
  assert.ok(
    rows.every((row) => row.ended === false),
    'unknown or malformed estimates cannot assert that service ended',
  );
});

test('an elapsed bus estimate does not become an immediate live arrival or prove service ended', async () => {
  const feed = new TagoBusFeed('fixture-service-key', {
    fetcher: async () =>
      reply({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            items: {
              item: {
                routeno: '401',
                arrtime: 30,
                arrprevstationcnt: 1,
              },
            },
          },
        },
      }),
  });

  const rows = await feed.arrivals(
    {
      id: 'TAGO123',
      cityCode: '25',
      name: 'fixture',
      ...point,
    },
    1_800_000_000_000,
  );

  assert.deepEqual(selectBusArrivals(rows, ['401'], undefined, 1_800_000_035_000), {
    predictions: [],
    ended: false,
  });
});

test('bus boarding candidates require the actual name, matching platform and a tightly bounded coordinate connection', () => {
  const name = '서울역버스환승센터(5번승강장)(중)';
  const candidates = [
    {
      id: 'correct',
      name,
      ...point,
      latitude: point.latitude + 0.0001,
    },
    {
      id: 'unrelated',
      name: '완전히 다른 정류장',
      ...point,
    },
    {
      id: 'wrong-platform',
      name: '서울역버스환승센터(4번승강장)(중)',
      ...point,
    },
    {
      id: 'missing-platform',
      name: '서울역버스환승센터',
      ...point,
    },
    {
      id: 'distant',
      name,
      ...point,
      latitude: point.latitude + 0.0003,
    },
  ];

  assert.deepEqual(
    chooseBusStops(candidates, name, point).map((stop) => stop.id),
    ['correct'],
  );
  assert.deepEqual(
    chooseBusStops(candidates, name, point, 150).map((stop) => stop.id),
    ['correct'],
    'a caller cannot bypass the 25m connection limit',
  );
});

test('a known route next stop requires positive matching source direction evidence for a live bus wait', () => {
  const row = {
    route: '402',
    arrivesAt: 1_800_000_180_000,
    stopsAway: 1,
    message: '3분 후',
    ended: false,
    lastService: false,
  };

  assert.equal(
    selectBusArrivals([row], ['402'], '숭례문', 1_800_000_000_000),
    null,
    'a missing TAGO or Seoul direction is unknown',
  );
  assert.equal(
    selectBusArrivals(
      [
        {
          ...row,
          nextStop: '서울역',
        },
      ],
      ['402'],
      '숭례문',
      1_800_000_000_000,
    ),
    null,
  );
  assert.equal(
    selectBusArrivals(
      [
        {
          ...row,
          nextStop: '숭례문',
        },
      ],
      ['402'],
      '숭례문',
      1_800_000_000_000,
    )?.predictions.length,
    1,
  );
  assert.equal(
    selectBusArrivals([row], ['402'], undefined, 1_800_000_000_000)?.predictions.length,
    1,
    'unfiltered source listing may retain arrivals without claiming a route direction',
  );
});

test('an explicit hours component is not silently discarded from a bus countdown', async () => {
  const feed = new SeoulBusFeed('fixture-service-key', {
    fetcher: async () =>
      reply({
        msgHeader: {
          headerCd: '0',
        },
        msgBody: {
          itemList: {
            rtNm: '402',
            arrmsg1: '1시간 3분 12초 후',
            arrmsg2: '1.5분 후',
          },
        },
      }),
  });

  const rows = await feed.arrivals(
    {
      id: '02001',
      name: 'fixture',
      ...point,
    },
    1_800_000_000_000,
  );

  assert.deepEqual(
    rows.map((row) => row.arrivesAt),
    [1_800_003_792_000, null],
  );
});

test('bus quota and per-second limit codes do not falsely report an invalid credential', async () => {
  for (const code of ['22', '23']) {
    const seoul = new SeoulBusFeed('fixture-service-key', {
      fetcher: async () =>
        reply({
          msgHeader: {
            headerCd: code,
          },
          msgBody: {},
        }),
    });
    const tago = new TagoBusFeed('fixture-service-key', {
      fetcher: async () =>
        reply({
          response: {
            header: {
              resultCode: code,
            },
            body: {},
          },
        }),
    });

    // 22 is the spent daily quota (until 00:00 KST); 23 the per-second limit, which passes in a moment.
    const expected = code === '22' ? 'quota' : 'status';
    await assert.rejects(seoul.nearbyStops(point), reason(expected), `Seoul ${code}`);
    await assert.rejects(tago.nearbyStops(point), reason(expected), `TAGO ${code}`);
  }
});

test('encoded and decoded credentials reach the bus API as exactly one query value', async () => {
  const key = 'fixture+key/with=reserved';

  for (const supplied of [` ${key} `, ` ${encodeURIComponent(key)} `]) {
    for (const Feed of [SeoulBusFeed, TagoBusFeed]) {
      const feed = new Feed(supplied, {
        fetcher: async (value) => {
          const url = new URL(String(value));

          assert.deepEqual(url.searchParams.getAll('serviceKey'), [key]);

          return reply(
            url.hostname === 'ws.bus.go.kr'
              ? {
                  msgHeader: {
                    headerCd: '0',
                  },
                  msgBody: {
                    itemList: [],
                  },
                }
              : {
                  response: {
                    header: {
                      resultCode: '00',
                    },
                    body: {
                      items: '',
                    },
                  },
                },
          );
        },
      });

      assert.deepEqual(await feed.nearbyStops(point), []);
    }
  }
});

test('bus feeds reject a missing shared key before making a request', async () => {
  for (const Feed of [SeoulBusFeed, TagoBusFeed]) {
    for (const supplied of [undefined, '', ' \t ']) {
      let requests = 0;
      const feed = new Feed(supplied, {
        fetcher: async () => {
          requests += 1;

          return reply({});
        },
      });

      assert.equal(feed.configured, false);
      await assert.rejects(feed.nearbyStops(point), reason('auth'));
      await assert.rejects(
        feed.arrivals(
          {
            id: 'fixture',
            cityCode: '26',
            name: 'fixture',
            ...point,
          },
          1_800_000_000_000,
        ),
        reason('auth'),
      );
      assert.equal(requests, 0, 'an empty credential cannot reach either API operation');
    }
  }
});

test('nearby Seoul and TAGO station and arrival requests use the shared public-data key despite legacy options', async () => {
  const now = 1_800_000_000_000;

  for (const center of [
    point,
    {
      latitude: 35.17,
      longitude: 129.07,
    },
  ]) {
    const requests: URL[] = [];
    const options = {
      dataGoKrServiceKey: ' shared%2Bkey%2Fwith%3Dreserved ',
      seoulBusServiceKey: 'old-seoul-key',
      tagoBusServiceKey: 'old-tago-key',
      tagoBusStationServiceKey: 'old-station-key',
      tagoBusArrivalServiceKey: 'old-arrival-key',
      now: () => now,
      fetcher: async (value: URL | RequestInfo) => {
        const url = new URL(String(value));

        requests.push(url);

        if (url.hostname === 'ws.bus.go.kr') {
          return reply({
            msgHeader: {
              headerCd: '0',
            },
            msgBody: {
              itemList: url.pathname.endsWith('getStationByPos')
                ? {
                    arsId: '02001',
                    stationNm: 'fixture',
                    gpsX: center.longitude,
                    gpsY: center.latitude,
                  }
                : {
                    rtNm: '402',
                    arrmsg1: '3분 후',
                    arrmsg2: '운행종료',
                  },
            },
          });
        }

        return reply({
          response: {
            header: {
              resultCode: '00',
            },
            body: {
              items: {
                item: url.pathname.endsWith('getCrdntPrxmtSttnList')
                  ? {
                      nodeid: 'fixture',
                      nodenm: 'fixture',
                      citycode: '26',
                      gpslati: center.latitude,
                      gpslong: center.longitude,
                    }
                  : {
                      routeno: '402',
                      arrtime: 180,
                      arrprevstationcnt: 2,
                    },
              },
            },
          },
        });
      },
    };

    const snapshot = await new NearbyTransitService(options).snapshot(center);

    assert.equal(snapshot.bus.status, 'available');
    assert.equal(snapshot.bus.stops[0]?.arrivals[0]?.arrivesAt, now + 180_000);
    assert.equal(requests.length, 2, 'station discovery and arrivals must both use the credential');
    assert.deepEqual(
      requests.map((url) => url.searchParams.getAll('serviceKey')),
      [['shared+key/with=reserved'], ['shared+key/with=reserved']],
    );
  }
});

test('legacy nearby bus credentials cannot configure a missing shared public-data key', async () => {
  let requests = 0;
  const options = {
    dataGoKrServiceKey: ' \t ',
    seoulBusServiceKey: 'old-seoul-key',
    tagoBusServiceKey: 'old-tago-key',
    tagoBusStationServiceKey: 'old-station-key',
    tagoBusArrivalServiceKey: 'old-arrival-key',
    fetcher: async () => {
      requests += 1;

      return reply({});
    },
  };
  const service = new NearbyTransitService(options);

  for (const center of [
    point,
    {
      latitude: 35.17,
      longitude: 129.07,
    },
  ]) {
    assert.equal((await service.snapshot(center)).bus.status, 'unconfigured');
  }

  assert.equal(requests, 0);
});

test('nearby authentication blocking stays isolated to the rejected bus supplier', async () => {
  const tagoPoint = {
    latitude: 35.17,
    longitude: 129.07,
  };

  for (const [rejectedPoint, healthyPoint, rejectedHost] of [
    [point, tagoPoint, 'ws.bus.go.kr'],
    [tagoPoint, point, 'apis.data.go.kr'],
  ] as const) {
    const requests: string[] = [];
    const service = new NearbyTransitService({
      dataGoKrServiceKey: 'shared-key',
      now: () => 1_800_000_000_000,
      fetcher: async (value) => {
        const url = new URL(String(value));

        requests.push(url.hostname);

        if (url.hostname === rejectedHost) {
          return new Response('', {
            status: 401,
          });
        }

        return reply(
          url.hostname === 'ws.bus.go.kr'
            ? {
                msgHeader: {
                  headerCd: '0',
                },
                msgBody: {
                  itemList: [],
                },
              }
            : {
                response: {
                  header: {
                    resultCode: '00',
                  },
                  body: {
                    items: '',
                  },
                },
              },
        );
      },
    });

    assert.equal((await service.snapshot(rejectedPoint)).bus.status, 'error');
    assert.equal((await service.snapshot(healthyPoint)).bus.status, 'empty');
    assert.equal((await service.snapshot(rejectedPoint)).bus.status, 'error');
    assert.equal(
      requests.filter((host) => host === rejectedHost).length,
      1,
      'a blocked supplier is not retried immediately',
    );
    assert.equal(
      requests.filter((host) => host !== rejectedHost).length,
      1,
      'another supplier still performs its own request',
    );
  }
});

test('a slow nearby bus response cannot present an already elapsed prediction as a current arrival', async () => {
  let now = 1_800_000_000_000;
  const service = new NearbyTransitService({
    dataGoKrServiceKey: 'fixture-key',
    now: () => now,
    fetcher: async (value) => {
      const url = new URL(String(value));

      if (url.pathname.endsWith('getStationByPos')) {
        return reply({
          msgHeader: {
            headerCd: '0',
          },
          msgBody: {
            itemList: {
              arsId: '02001',
              stationNm: 'fixture',
              gpsX: point.longitude,
              gpsY: point.latitude,
            },
          },
        });
      }

      now += 35_000;

      return reply({
        msgHeader: {
          headerCd: '0',
        },
        msgBody: {
          itemList: {
            rtNm: '402',
            arrmsg1: '30초 후',
            arrmsg2: '',
          },
        },
      });
    },
  });

  const stop = (await service.snapshot(point)).bus.stops[0];

  assert.deepEqual(
    stop.arrivals.filter((row) => row.arrivesAt !== null),
    [],
  );
  assert.equal(stop.observedAt, 1_800_000_000_000);
  assert.ok(stop.arrivals.every((row) => row.ended === false));
});

const NOW = Date.UTC(2026, 9, 15, 4, 12);

const kst = (timestamp: number) =>
  new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

const train = (observedAt: number, trainNo: string) => ({
  subwayId: '1001',
  trainLineNm: '소요산행 - 시청방면',
  bstatnNm: '소요산',
  barvlDt: '600',
  arvlMsg2: '10분 후',
  arvlCd: '99',
  recptnDt: kst(observedAt),
  btrainSttus: '일반',
  btrainNo: trainNo,
});

const nearbySubway = (rows: Record<string, unknown>[]) =>
  new NearbyTransitService({
    now: () => NOW,
    seoulOpenApiKey: 'fixture-subway-key',
    provider: {
      configured: true,
      nearby: async () => [
        {
          id: 'seoul',
          name: '서울역 1호선',
          address: '',
          ...point,
          category: '교통,수송 > 지하철,전철 > 수도권1호선',
          distanceMeters: 0,
        },
      ],
    },
    fetcher: async () =>
      reply({
        errorMessage: {
          code: 'INFO-000',
        },
        realtimeArrivalList: rows,
      }),
  });

test('nearby subway uses fresh source rows without aging them by an unrelated old train', async () => {
  const snapshot = await nearbySubway([
    train(NOW - 91_000, 'old'),
    train(NOW - 30_000, 'fresh'),
  ]).snapshot(point);

  const stop = snapshot.subway.stops[0];

  assert.equal(stop.freshness, 'fresh');
  assert.equal(stop.observedAt, NOW - 30_000);
  assert.deepEqual(
    stop.arrivals.map((row) => row.arrivesAt),
    [NOW + 570_000],
  );
});

test('nearby subway retains all-old source timestamps and does not relabel an empty feed as freshly observed service', async () => {
  const old = (await nearbySubway([train(NOW - 121_000, 'old')]).snapshot(point)).subway.stops[0];

  assert.equal(old.status, 'stale');
  assert.equal(old.observedAt, NOW - 121_000);

  const empty = (await nearbySubway([]).snapshot(point)).subway.stops[0];

  assert.equal(empty.observedAt, null);
  assert.equal(empty.freshness, 'unknown');
  assert.deepEqual(empty.arrivals, []);
});
