// Preserved regression cases from perception-map/mvp/tests/publicDataConfiguration.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDataConfigFromEnvironment } from '../src/common/engine/realtime/config.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import { SharedScooterFeed } from '../src/common/engine/realtime/mobility.js';

const point = {
  latitude: 37.2664,
  longitude: 126.9995,
};

const now = Date.UTC(2026, 9, 15, 8, 0);

const environment = {
  TAGO_BUS_STATION_SERVICE_KEY: 'station-only-fixture',
  TAGO_BUS_ARRIVAL_SERVICE_KEY: 'arrival-only-fixture',
  TAGO_BUS_SERVICE_KEY: 'legacy-tago-fixture',
  SEOUL_BUS_SERVICE_KEY: 'legacy-seoul-fixture',
  KMA_SERVICE_KEY: 'legacy-weather-fixture',
  TAGO_PM_SERVICE_KEY: 'legacy-pm-fixture',
  DATA_GO_KR_SERVICE_KEY: 'common-fixture',
};

function transport(used: string[]) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const station = url.pathname.endsWith('/getCrdntPrxmtSttnList');

    assert.equal(url.searchParams.get('serviceKey'), 'common-fixture');

    used.push(station ? 'station' : 'arrival');

    return new Response(
      JSON.stringify({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            items: {
              item: station
                ? {
                    nodeid: 'fixture-stop',
                    nodenm: '수원역',
                    citycode: '31010',
                    gpslati: point.latitude,
                    gpslong: point.longitude,
                  }
                : {
                    routeno: 'fixture-line',
                    arrtime: 180,
                    arrprevstationcnt: 2,
                  },
            },
          },
        },
      }),
    );
  };
}

test('the common environment key reaches both TAGO operations in route arrivals', async () => {
  const used: string[] = [];
  const service = new RealtimeService({
    ...publicDataConfigFromEnvironment(environment),
    fetcher: transport(used),
    now: () => now,
  });

  const result = await service.lookup({
    mode: 'bus',
    stop: '수원역',
    lines: ['fixture-line'],
    nextStops: [],
    ...point,
  });

  assert.equal(result?.provider, 'tago-bus');
  assert.equal(result?.predictions[0].arrivesAt, now + 180_000);
  assert.deepEqual(used, ['station', 'arrival']);
});

test('the common environment key reaches both TAGO operations in the nearby transit panel', async () => {
  const used: string[] = [];
  const service = new NearbyTransitService({
    ...publicDataConfigFromEnvironment(environment),
    fetcher: transport(used),
    now: () => now,
  });

  const result = await service.snapshot(point);

  assert.equal(result.bus.status, 'available');
  assert.equal(result.bus.stops[0].arrivals[0].arrivesAt, now + 180_000);
  assert.deepEqual(used, ['station', 'arrival']);
});

test('the public data configuration exposes exactly one key and ignores retired aliases', () => {
  assert.deepEqual(
    publicDataConfigFromEnvironment({
      ...environment,
      DATA_GO_KR_SERVICE_KEY: ' common-fixture ',
    }),
    {
      dataGoKrServiceKey: 'common-fixture',
    },
  );
});

test('retired aliases cannot silently configure services when the common key is missing or blank', () => {
  for (const key of [undefined, '', ' \t ']) {
    assert.deepEqual(
      publicDataConfigFromEnvironment({
        ...environment,
        DATA_GO_KR_SERVICE_KEY: key,
      }),
      {
        dataGoKrServiceKey: undefined,
      },
    );
  }
});

test('weather and shared mobility use the same common configuration as buses', async () => {
  const key = publicDataConfigFromEnvironment(environment).dataGoKrServiceKey;
  const used: string[] = [];

  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));

    assert.equal(url.searchParams.get('serviceKey'), 'common-fixture');

    const weather = url.pathname.endsWith('/getUltraSrtNcst');

    used.push(weather ? 'weather' : 'mobility');

    return new Response(
      JSON.stringify({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            items: {
              item: weather
                ? [
                    ['T1H', '19'],
                    ['PTY', '0'],
                    ['RN1', '0'],
                    ['WSD', '2'],
                  ].map(([category, obsrValue]) => ({
                    category,
                    obsrValue,
                    nx: 60,
                    ny: 127,
                    baseDate: url.searchParams.get('base_date'),
                    baseTime: url.searchParams.get('base_time'),
                  }))
                : [],
              totalCount: 0,
            },
          },
        },
      }),
    );
  };

  assert.equal(
    (
      await new WeatherFeed(key, {
        fetcher,
        now: () => now,
      }).conditions({
        latitude: 37.5665,
        longitude: 126.978,
      })
    ).status,
    'live',
  );
  assert.deepEqual(
    await new SharedScooterFeed(key, {
      fetcher,
      now: () => now,
    }).near(point, 200),
    {
      covered: false,
      scooter: null,
    },
  );
  assert.deepEqual(used, ['weather', 'mobility']);
});
