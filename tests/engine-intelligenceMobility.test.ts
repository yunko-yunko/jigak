// Preserved regression cases from perception-map/mvp/tests/intelligenceMobility.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GbfsVehicleFeed } from '../src/common/engine/intelligence/gbfs.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';

const NOW = Date.UTC(2026, 9, 12, 6);

const SEOUL = {
  latitude: 37.5665,
  longitude: 126.978,
};

const response = (value: unknown) => new Response(JSON.stringify(value));

const bike = (id: string, count: number, longitude = SEOUL.longitude) => ({
  stationId: id,
  stationName: `001. ${id}`,
  stationLatitude: String(SEOUL.latitude),
  stationLongitude: String(longitude),
  parkingBikeTotCnt: String(count),
  rackTotCnt: '10',
});

test('map inventory includes empty stations, distinguishes station count from device coordinates, and uses query radius', async () => {
  const feed = new MobilityFeeds({
    seoulBikeKey: 'key',
    now: () => NOW,
    fetcher: (async (input: URL) => {
      const first = String(input).includes('/bikeList/1/');

      return response(
        first
          ? {
              rentBikeStatus: {
                list_total_count: 3,
                RESULT: {
                  CODE: 'INFO-000',
                },
                row: [bike('empty', 0), bike('stock', 3, 126.98), bike('far', 7, 126.99)],
              },
            }
          : {
              CODE: 'INFO-200',
            },
      );
    }) as typeof fetch,
  });

  const snapshot = await feed.snapshot(SEOUL, 1_500);

  assert.equal(snapshot.markers.length, 3, 'radius must not have a hidden hard-coded 1km crop');
  assert.ok(
    snapshot.markers.every((marker) => marker.entity === 'station' && marker.kind === 'bicycle'),
  );
  assert.equal(snapshot.markers.find((marker) => marker.sourceId === 'stock')?.availableCount, 3);
  assert.equal(snapshot.markers.find((marker) => marker.sourceId === 'empty')?.available, false);
  assert.equal(
    snapshot.markers[0].observedAt,
    null,
    'receipt is never mislabeled source observation',
  );
  assert.equal(snapshot.markers[0].receivedAt, NOW);
  assert.equal(snapshot.markers[0].freshness, 'unknown');
  assert.equal(snapshot.completeCoverage, false);
  assert.equal(
    snapshot.sources.find((source) => source.source === 'tago-pm')?.status,
    'unconfigured',
  );
  assert.equal((await feed.bikes.nearest(SEOUL, 1_500, 'bike'))?.receivedAt, NOW);
  await assert.rejects(() => feed.snapshot(SEOUL, 50_000), RangeError);
});

test('TAGO map exposes individual reported devices without turning low batteries into usable vehicles', async () => {
  const point = {
    latitude: 36.3255,
    longitude: 127.3483,
  };
  const feed = new MobilityFeeds({
    tagoPmServiceKey: 'key',
    now: () => NOW,
    fetcher: (async (input: URL) => {
      const providers = String(input).includes('GetPMProvider');

      return response({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            totalCount: providers ? 1 : 2,
            items: {
              item: providers
                ? {
                    citycode: '12',
                    cityname: '세종',
                    providername: 'ALPACA',
                  }
                : [
                    {
                      vehicleid: 'actual-1',
                      latitude: point.latitude,
                      longitude: point.longitude,
                      battery: '80',
                    },
                    {
                      vehicleid: 'actual-2',
                      latitude: point.latitude,
                      longitude: point.longitude + 0.001,
                      battery: '8',
                    },
                  ],
            },
          },
        },
      });
    }) as typeof fetch,
  });

  const snapshot = await feed.snapshot(point, 1_000);

  assert.deepEqual(
    snapshot.markers.map((marker) => [marker.sourceId, marker.entity, marker.available]),
    [
      ['actual-1', 'vehicle', true],
      ['actual-2', 'vehicle', false],
    ],
  );
  assert.ok(
    snapshot.markers.every(
      (marker) => marker.observedAt === null && marker.returnPolicy === 'unverified',
    ),
  );
});

test('authorized GBFS v3 mixes actual bicycle and scooter positions, rejects reserved and stale rentals', async () => {
  const feed = new GbfsVehicleFeed(
    {
      provider: 'Official operator',
      vehicleStatusUrl: 'https://operator.example/vehicle_status.json',
      vehicleTypesUrl: 'https://operator.example/vehicle_types.json',
    },
    {
      now: () => NOW,
      fetcher: (async (input: URL) =>
        response(
          String(input).includes('vehicle_types')
            ? {
                data: {
                  vehicle_types: [
                    {
                      vehicle_type_id: 'bike',
                      form_factor: 'bicycle',
                      propulsion_type: 'electric_assist',
                    },
                    {
                      vehicle_type_id: 'kick',
                      form_factor: 'scooter_standing',
                      propulsion_type: 'electric',
                    },
                  ],
                },
              }
            : {
                last_updated: new Date(NOW).toISOString(),
                data: {
                  vehicles: [
                    {
                      vehicle_id: 'b',
                      vehicle_type_id: 'bike',
                      lat: SEOUL.latitude,
                      lon: SEOUL.longitude,
                      last_reported: new Date(NOW - 60_000).toISOString(),
                      current_fuel_percent: 0.7,
                      is_reserved: false,
                      is_disabled: false,
                    },
                    {
                      vehicle_id: 's',
                      vehicle_type_id: 'kick',
                      lat: SEOUL.latitude,
                      lon: SEOUL.longitude,
                      last_reported: new Date(NOW - 600_000).toISOString(),
                      is_reserved: false,
                    },
                    {
                      vehicle_id: 'reserved',
                      vehicle_type_id: 'kick',
                      lat: SEOUL.latitude,
                      lon: SEOUL.longitude,
                      is_reserved: true,
                    },
                    {
                      vehicle_id: 'no-type',
                      lat: SEOUL.latitude,
                      lon: SEOUL.longitude,
                    },
                  ],
                },
              },
        )) as typeof fetch,
    },
  );

  const markers = await feed.nearby(SEOUL, 300);

  assert.equal(markers.length, 2);
  assert.deepEqual(
    markers.map((marker) => [marker.sourceId, marker.kind, marker.available, marker.freshness]),
    [
      ['b', 'e-bicycle', true, 'fresh'],
      ['s', 'kick-scooter', false, 'stale'],
    ],
  );
  assert.equal(markers[0].batteryPercent, 70);
  assert.throws(
    () =>
      new GbfsVehicleFeed({
        provider: 'bad',
        vehicleStatusUrl: 'http://localhost/feed.json',
      }),
    TypeError,
  );
});

test('GBFS legacy feeds never guess a vehicle kind or turn missing source times into live availability', async () => {
  const fetcher = (async () =>
    response({
      data: {
        bikes: [
          {
            bike_id: 'legacy',
            lat: SEOUL.latitude,
            lon: SEOUL.longitude,
            is_reserved: 0,
            is_disabled: 0,
          },
        ],
      },
    })) as typeof fetch;

  assert.equal(
    (
      await new GbfsVehicleFeed(
        {
          provider: 'operator',
          vehicleStatusUrl: 'https://operator.example/free_bike_status.json',
        },
        {
          fetcher,
          now: () => NOW,
        },
      ).nearby(SEOUL, 100)
    ).length,
    0,
  );

  const [marker] = await new GbfsVehicleFeed(
    {
      provider: 'operator',
      vehicleStatusUrl: 'https://operator.example/free_bike_status.json',
      kind: 'bicycle',
    },
    {
      fetcher,
      now: () => NOW,
    },
  ).nearby(SEOUL, 100);

  assert.equal(marker.freshness, 'unknown');
  assert.equal(marker.available, false);
});

test('GBFS electric stock cannot turn missing or impossible fuel fractions into usable vehicles', async () => {
  const feed = new GbfsVehicleFeed(
    {
      provider: 'operator',
      vehicleStatusUrl: 'https://operator.example/vehicle_status.json',
      kind: 'kick-scooter',
    },
    {
      now: () => NOW,
      fetcher: (async () =>
        response({
          last_updated: NOW / 1000,
          data: {
            vehicles: [
              {
                vehicle_id: 'missing',
                lat: SEOUL.latitude,
                lon: SEOUL.longitude,
              },
              {
                vehicle_id: 'overflow',
                lat: SEOUL.latitude,
                lon: SEOUL.longitude,
                current_fuel_percent: 1.7,
              },
              {
                vehicle_id: 'negative',
                lat: SEOUL.latitude,
                lon: SEOUL.longitude,
                current_fuel_percent: -0.1,
              },
              {
                vehicle_id: 'charged',
                lat: SEOUL.latitude,
                lon: SEOUL.longitude,
                current_fuel_percent: 0.7,
              },
            ],
          },
        })) as typeof fetch,
    },
  );

  const markers = await feed.nearby(SEOUL, 100);

  assert.deepEqual(
    markers.map((marker) => [marker.sourceId, marker.batteryPercent, marker.available]),
    [
      ['missing', null, false],
      ['overflow', null, false],
      ['negative', null, false],
      ['charged', 70, true],
    ],
  );
});

test('dense real inventory keeps nearest devices within the client limit and explains truncation', async () => {
  const feed = new MobilityFeeds({
    now: () => NOW,
    gbfs: [
      {
        provider: 'operator',
        vehicleStatusUrl: 'https://operator.example/vehicle_status.json',
        kind: 'bicycle',
      },
    ],
    fetcher: (async () =>
      response({
        last_updated: NOW / 1000,
        data: {
          vehicles: Array.from(
            {
              length: 1002,
            },
            (_, index) => ({
              vehicle_id: `real-${index}`,
              lat: SEOUL.latitude,
              lon: SEOUL.longitude + index * 0.000001,
            }),
          ),
        },
      })) as typeof fetch,
  });

  const snapshot = await feed.snapshot(SEOUL, 1200);

  assert.equal(snapshot.markers.length, 1000, 'an app that asks no limit gets at most 1,000');
  assert.equal(snapshot.markers[0].sourceId, 'real-0');
  assert.equal(snapshot.markers.at(-1)?.sourceId, 'real-999');
  assert.deepEqual(snapshot.totals, { bicycle: 1002 });
  assert.match(
    snapshot.sources.find((source) => source.source === 'gbfs')!.message,
    /반경 안 총 1,002대 중 가까운 1,000대만 지도에 보여요\./,
  );
});

test('TAGO source recovers from fleet errors and distinguishes a known empty area from unsupported coverage', async () => {
  let clock = NOW,
    fail = false,
    emptied = false;
  const point = {
    latitude: 36.3255,
    longitude: 127.3483,
  };
  const feed = new MobilityFeeds({
    tagoPmServiceKey: 'key',
    now: () => clock,
    fetcher: (async (input: URL) => {
      if (String(input).includes('GetPMProvider')) {
        return response({
          response: {
            header: {
              resultCode: '00',
            },
            body: {
              totalCount: 1,
              items: {
                item: {
                  citycode: '12',
                  cityname: '세종',
                  providername: 'ALPACA',
                },
              },
            },
          },
        });
      }

      if (fail) {
        return new Response('', {
          status: 503,
        });
      }

      return response({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            totalCount: emptied ? 0 : 1,
            items: {
              item: emptied
                ? []
                : {
                    vehicleid: 'live',
                    latitude: point.latitude,
                    longitude: point.longitude,
                    battery: '80',
                  },
            },
          },
        },
      });
    }) as typeof fetch,
  });

  await feed.snapshot(point);

  clock += 60_000;
  fail = true;

  assert.equal((await feed.snapshot(point)).sources[1].status, 'error');

  clock += 60_000;
  fail = false;
  emptied = true;

  assert.equal((await feed.snapshot(point)).sources[1].status, 'empty');
  assert.equal(feed.scooters.lastFailure, null);
  assert.equal((await feed.snapshot(SEOUL)).sources[1].status, 'uncovered');
});

test('impossible TAGO battery values and zero-location devices cannot be presented as usable rentals', async () => {
  const point = {
    latitude: 36.3255,
    longitude: 127.3483,
  };
  const feed = new MobilityFeeds({
    tagoPmServiceKey: 'key',
    now: () => NOW,
    fetcher: (async (input: URL) =>
      response({
        response: {
          header: {
            resultCode: '00',
          },
          body: {
            totalCount: 1,
            items: {
              item: String(input).includes('GetPMProvider')
                ? {
                    citycode: '12',
                    cityname: '세종',
                    providername: 'ALPACA',
                  }
                : [
                    {
                      vehicleid: 'bad-battery',
                      latitude: point.latitude,
                      longitude: point.longitude,
                      battery: 170,
                    },
                    {
                      vehicleid: 'zero-location',
                      latitude: 0,
                      longitude: 0,
                      battery: 80,
                    },
                  ],
            },
          },
        },
      })) as typeof fetch,
  });

  const [marker] = (await feed.snapshot(point)).markers;

  assert.equal(marker.available, false);
  assert.equal(marker.batteryPercent, null);
  assert.equal(
    (
      await feed.scooters.nearby(
        {
          latitude: 0,
          longitude: 0,
        },
        1_000,
      )
    ).length,
    0,
  );
});
