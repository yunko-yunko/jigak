// Regression cases from mvp/tests/rentalCarReservation.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { buildMixedModeBridges } from '../src/common/engine/mixed-mode-bridges.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import type { PublicParking } from '../src/common/engine/realtime/parking.js';

const NOW = Date.UTC(2026, 9, 28, 3);
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 용산구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
const origin = point('origin', 0),
  destination = point('destination', 2000);
const drop = point('operator-return', 1900);

function route(mode: 'walk' | 'scooter', start: Place, end: Place, seconds: number): BaseRoute {
  const segment: BaseSegment = {
    id: mode,
    mode,
    title: mode,
    instructions: '확인된 공급원 경로',
    start,
    end,
    distanceMeters: metersBetween(start, end),
    durationSeconds: { min: seconds, max: seconds },
    runAllowed: false,
    polyline: [start, end],
    ...(mode === 'scooter' ? { routingProfile: 'scooter' as const } : {}),
  };
  return {
    id: mode,
    title: mode,
    segments: [segment],
    durationSeconds: segment.durationSeconds,
    distanceMeters: segment.distanceMeters,
    transfers: 0,
  };
}

test('a second scooter comparison cannot consume the calls reserved for a complete saved-car journey', async () => {
  const budget = new CallBudget(7);
  const calls: ('walking' | 'scooter' | 'driving')[] = [];
  const mobility = new MobilityFeeds({
    now: () => NOW,
    gbfs: [
      {
        provider: 'operator',
        vehicleStatusUrl: 'https://operator.example/vehicles.json',
        kind: 'kick-scooter',
      },
    ],
    fetcher: async () =>
      new Response(
        JSON.stringify({
          last_updated: NOW / 1000,
          data: {
            vehicles: [20, 100].map((meters, index) => ({
              vehicle_id: `device-${index}`,
              lat: point('', meters).latitude,
              lon: origin.longitude,
              current_fuel_percent: 0.8,
              is_disabled: false,
              is_reserved: false,
              last_reported: NOW / 1000,
            })),
          },
        }),
      ),
  });
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (input, sharedBudget) =>
      sharedBudget.run(() => {
        calls.push('walking');
        return [route('walk', input.origin, input.destination, 20)];
      }),
    scooter: async (input, sharedBudget) =>
      sharedBudget.run(() => {
        calls.push('scooter');
        return [route('scooter', input.origin, input.destination, 800)];
      }),
    driving: async (input, sharedBudget) =>
      sharedBudget.run(() => {
        calls.push('driving');
        return {
          distanceMeters: 2000,
          durationSeconds: 100,
          polyline: [input.origin, input.destination],
          maneuvers: [],
          traffic: [],
        };
      }),
  };
  const lot: PublicParking = {
    ...point('public-lot', 1950),
    category: '공영 시간제 주차장',
    distanceMeters: 50,
    parkingAccess: {
      publicAccess: true,
      provider: 'seoul-parking',
      operating: 'open',
      occupancy: 'available',
      fee: 'paid',
      verifiedAt: NOW,
    },
  };
  const routes = await buildMixedModeBridges(
    {
      origin,
      destination,
      preferences: {
        ...DEFAULT_PREFERENCES,
        hasCar: true,
        carLocation: origin,
        allowTaxi: false,
        allowBicycle: false,
        allowScooter: true,
      },
    },
    [],
    {
      provider,
      budget,
      now: NOW,
      mobility,
      parking: {
        configured: true,
        candidates: async () => [lot],
        nearest: async () => lot,
        at: () => lot,
      },
      scooterPolicy: {
        verify: async ({ vehicle }) => ({
          vehicleId: vehicle.id,
          provider: vehicle.provider,
          dropoff: drop,
          verifiedAt: NOW,
          validUntil: NOW + 3_600_000,
          pickupAllowed: true,
          returnAllowed: true,
          eligibilityAllowed: true,
          hireSeconds: 60,
          returnSeconds: 30,
          unlockFeeWon: 1000,
          perMinuteWon: 100,
          returnFeeWon: 0,
        }),
      },
    },
  );
  const car = routes.find((candidate) =>
    candidate.segments.some((segment) => segment.mode === 'car'),
  );
  assert.ok(
    car,
    'finish the saved-car drive, parking and actual egress before spending its reservation on another scooter',
  );
  assert.deepEqual(
    car.segments.map((segment) => segment.mode),
    ['car', 'wait', 'walk'],
  );
  assert.equal(car.segments.at(-1)?.end.id, destination.id);
  assert.equal(
    calls.filter((mode) => mode === 'scooter').length,
    1,
    'only the first complete rental fits outside the saved-car reservation',
  );
  assert.equal(calls.filter((mode) => mode === 'driving').length, 1);
  assert.equal(
    calls.filter((mode) => mode === 'walking').length,
    3,
    'two scooter walks and one parking egress are fully routed',
  );
  assert.equal(budget.used, 5);
});

for (const side of ['first', 'last'] as const) {
  test(`a ${side} rental transit continuation preserves both reserved parking comparisons`, async () => {
    const middle = point('middle-platform', 1000);
    const stations = side === 'first' ? [origin, middle] : [middle, destination];
    const budget = new CallBudget(6);
    const transitRemaining: number[] = [];
    let bicycleCalls = 0,
      drivingCalls = 0,
      enrichmentCalls = 0;
    const transitLeg = (id: string, start: Place, end: Place, seconds: number): BaseSegment => ({
      ...route('walk', start, end, seconds).segments[0],
      id,
      mode: 'subway',
      lineName: '1호선',
    });
    const originalSegments = [
      transitLeg('first-train', origin, middle, side === 'first' ? 1800 : 400),
      transitLeg('last-train', middle, destination, side === 'last' ? 1800 : 400),
    ];
    const original: BaseRoute = {
      id: 'original',
      title: 'original',
      segments: originalSegments,
      transfers: 1,
      durationSeconds: { min: 2200, max: 2200 },
      distanceMeters: 2000,
    };
    const mobility = new MobilityFeeds({
      seoulBikeKey: 'fixture',
      now: () => NOW,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            rentBikeStatus: {
              list_total_count: 2,
              RESULT: { CODE: 'INFO-000' },
              row: stations.map((station, index) => ({
                stationId: `station-${index}`,
                stationName: station.name,
                stationLatitude: station.latitude,
                stationLongitude: station.longitude,
                parkingBikeTotCnt: 5,
                rackTotCnt: 10,
              })),
            },
          }),
        ),
    });
    const provider: RouteProvider = {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      walking: async (input, sharedBudget) =>
        sharedBudget.run(() => [route('walk', input.origin, input.destination, 20)]),
      bicycle: async (input, sharedBudget) =>
        sharedBudget.run(() => {
          bicycleCalls++;
          const source = route('scooter', input.origin, input.destination, 100);
          return [
            {
              ...source,
              segments: source.segments.map((segment) => ({
                ...segment,
                mode: 'bicycle' as const,
                routingProfile: 'bicycle' as const,
              })),
            },
          ];
        }),
      driving: async (input, sharedBudget) =>
        sharedBudget.run(() => {
          drivingCalls++;
          return {
            distanceMeters: 2000,
            durationSeconds: 100,
            polyline: [input.origin, input.destination],
            maneuvers: [],
            traffic: [],
          };
        }),
    };
    const lots: PublicParking[] = [1950, 1900].map((meters, index) => ({
      ...point(`lot-${index}`, meters),
      category: '공영 시간제 주차장',
      distanceMeters: 2000 - meters,
      parkingAccess: {
        publicAccess: true,
        provider: 'seoul-parking',
        operating: 'open',
        occupancy: 'available',
        fee: 'paid',
        verifiedAt: NOW,
      },
    }));
    const routes = await buildMixedModeBridges(
      {
        origin,
        destination,
        preferences: {
          ...DEFAULT_PREFERENCES,
          hasCar: true,
          carLocation: origin,
          allowTaxi: false,
          allowScooter: false,
          allowBicycle: true,
          bicycleReady: true,
          maxBicycleMeters: 1500,
        },
      },
      [original],
      {
        provider,
        budget,
        now: NOW,
        mobility,
        parking: {
          configured: true,
          candidates: async () => lots,
          nearest: async () => lots[0],
          at: (near) => lots.find((lot) => lot.id === near.id) ?? null,
        },
        connectTransit: async (endpoints) => {
          transitRemaining.push(budget.remaining);
          await budget.run(() => undefined);
          // Production connectTransit may enrich both access walks after its transit
          // query. Enrichment must stop when only saved-car calls remain.
          for (let index = 0; index < 2 && budget.remaining > 0; index++)
            await budget.run(() => {
              enrichmentCalls++;
            });
          const segment = transitLeg(
            'queried-continuation',
            endpoints.origin,
            endpoints.destination,
            300,
          );
          return [
            {
              id: 'queried-continuation',
              title: 'queried-continuation',
              segments: [segment],
              transfers: 0,
              durationSeconds: segment.durationSeconds,
              distanceMeters: segment.distanceMeters,
            },
          ];
        },
      },
    );
    assert.equal(bicycleCalls, 1);
    const cars = routes.filter((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'car'),
    );
    assert.equal(
      cars.length,
      2,
      'transit access refinement must not consume the second complete saved-car comparison',
    );
    assert.deepEqual(
      transitRemaining,
      [1],
      'only the continuation query fits outside the four reserved car calls',
    );
    assert.equal(enrichmentCalls, 0);
    assert.equal(drivingCalls, 2);
    assert.equal(budget.used, 6);
    assert.ok(cars.every((candidate) => candidate.segments.at(-1)?.end.id === destination.id));
  });
}
