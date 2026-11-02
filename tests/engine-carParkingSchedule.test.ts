// Regression cases from mvp/tests/carParkingSchedule.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PREFERENCES,
  planBaseRoutes,
  type BaseRoute,
  type Place,
} from '../src/common/shared/domain/index.js';
import { CallBudget } from '../src/common/engine/call-budget.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { multimodalRoutes } from '../src/common/engine/multimodal.js';
import {
  SeoulParkingFeed,
  type ParkingLookup,
  type PublicParking,
} from '../src/common/engine/realtime/parking.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';

const NOW = Date.parse('2026-10-12T00:59:00Z'); // Monday 09:59 KST, one minute before opening.
const OPENS = NOW + 60_000;
const O: Place = {
  id: 'car',
  name: '저장한 차량',
  address: '서울 용산구',
  latitude: 37.55,
  longitude: 126.97,
};
const D: Place = { ...O, id: 'destination', name: '목적지', latitude: 37.552 };
const preferences = {
  ...DEFAULT_PREFERENCES,
  hasCar: true,
  carLocation: O,
  allowTaxi: false,
  allowBicycle: false,
  allowScooter: false,
};
const detail = {
  PKLT_CD: 'future-opening',
  PKLT_NM: '10시 공영주차장',
  ADDR: '서울 용산구',
  OPER_SE_NM: '시간제 주차장',
  LAT: 37.5519,
  LOT: 126.97,
  WD_OPER_BGNG_TM: '1000',
  WD_OPER_END_TM: '1800',
  WE_OPER_BGNG_TM: '1000',
  WE_OPER_END_TM: '1800',
  LHLDY_BGNG: '1000',
  LHLDY: '1800',
  CHGD_FREE_NM: '유료',
};
const current = {
  PKLT_CD: 'future-opening',
  PRK_STTS_YN: '1',
  TPKCT: 10,
  NOW_PRK_VHCL_CNT: 3,
  NOW_PRK_VHCL_UPDT_TM: '2026-10-12 09:58:00',
};
function feed(occupied = 3, reports = '1') {
  return new SeoulParkingFeed('test-key', {
    now: () => NOW,
    fetcher: async (url) => {
      const service = String(url).includes('/GetParkingInfo/') ? 'GetParkingInfo' : 'GetParkInfo';
      return new Response(
        JSON.stringify({
          [service]: {
            list_total_count: 1,
            RESULT: { CODE: 'INFO-000' },
            row:
              service === 'GetParkInfo'
                ? [detail]
                : [{ ...current, NOW_PRK_VHCL_CNT: occupied, PRK_STTS_YN: reports }],
          },
        }),
      );
    },
  });
}
function provider(driveSeconds: number): RouteProvider {
  return {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    driving: async (input, budget) =>
      budget.run(() => ({
        distanceMeters: 300,
        durationSeconds: driveSeconds,
        polyline: [input.origin, input.destination],
        maneuvers: [],
        traffic: [],
      })),
    walking: async (input, budget) =>
      budget.run(() => [
        {
          id: 'egress',
          title: '실제 보행',
          transfers: 0,
          distanceMeters: 20,
          durationSeconds: { min: 30, max: 30 },
          segments: [
            {
              id: 'egress',
              mode: 'walk',
              title: '목적지까지 걷기',
              instructions: '실제 보행',
              start: input.origin,
              end: input.destination,
              distanceMeters: 20,
              durationSeconds: { min: 30, max: 30 },
              runAllowed: false,
              polyline: [input.origin, input.destination],
            },
          ],
        },
      ]),
  };
}
const cars = (routes: BaseRoute[]) =>
  routes.filter((route) => route.segments.some((segment) => segment.mode === 'car'));

test('car planning retains a currently closed official lot that opens before the actual driving arrival', async () => {
  const parking = feed();
  assert.equal(
    await parking.nearest(D, 500, NOW),
    null,
    'current nearest must still exclude a closed lot',
  );
  const routes = await multimodalRoutes(
    { origin: O, destination: D, preferences },
    { walking: [], transit: [] },
    {
      provider: provider(180),
      parking,
      budget: new CallBudget(2),
      now: NOW,
    },
  );
  const [candidate] = cars(routes);
  assert.ok(
    candidate,
    '09:59 lookup must not lose the lot opening at 10:00 when actual arrival is 10:02',
  );
  assert.equal(
    candidate.segments.find((segment) => segment.mode === 'car')?.parkingAccess?.operating,
    'open',
  );
  const result = planJourneyGraph(
    { origin: O, destination: D, preferences, now: NOW, deadline: NOW + 3600000 },
    routes,
    { receivedAt: NOW, objective: 'estimated-arrival' },
  );
  assert.equal(
    result.routes[0].segments.find((segment) => segment.mode === 'car')?.end.id,
    'seoul-parking-future-opening',
  );
});

test('opening during the parking action cannot validate a car arriving before opening', async () => {
  const candidate: PublicParking = {
    ...D,
    id: 'schedule-lot',
    name: '10시 주차장',
    category: '공영주차장',
    distanceMeters: 0,
    parkingAccess: {
      publicAccess: true,
      provider: 'seoul-parking',
      operating: 'closed',
      occupancy: 'available',
      fee: 'paid',
      verifiedAt: NOW,
      occupancyObservedAt: NOW,
      availableSpaces: 7,
    },
  };
  const parking: ParkingLookup = {
    configured: true,
    candidates: async () => [candidate],
    nearest: async () => candidate,
    at: (_near, arrivalAt) =>
      arrivalAt < OPENS
        ? null
        : { ...candidate, parkingAccess: { ...candidate.parkingAccess, operating: 'open' } },
  };
  const routes = await multimodalRoutes(
    { origin: O, destination: D, preferences },
    { walking: [], transit: [] },
    {
      provider: provider(30),
      parking,
      budget: new CallBudget(2),
      now: NOW,
    },
  );
  assert.equal(
    cars(routes).length,
    0,
    'arrival 09:59:30 is closed even though completing a 3-minute parking action would be after opening',
  );
});

test('still-closed arrival and full official parking remain unavailable during future-opening acquisition', async () => {
  for (const [parking, driveSeconds] of [
    [feed(), 30],
    [feed(10), 180],
  ] as const) {
    const routes = await multimodalRoutes(
      { origin: O, destination: D, preferences },
      { walking: [], transit: [] },
      {
        provider: provider(driveSeconds),
        parking,
        budget: new CallBudget(2),
        now: NOW,
      },
    );
    assert.equal(cars(routes).length, 0);
  }
});

test('future schedule opening does not upgrade unknown occupancy to a confirmed recommendation', async () => {
  const routes = await multimodalRoutes(
    { origin: O, destination: D, preferences },
    { walking: [], transit: [] },
    {
      provider: provider(180),
      parking: feed(3, '0'),
      budget: new CallBudget(2),
      now: NOW,
    },
  );
  assert.equal(
    cars(routes).length,
    1,
    'keep an explicitly conditional comparison when opening is known but spaces are not',
  );
  const result = planBaseRoutes(
    { origin: O, destination: D, preferences, now: NOW, deadline: NOW + 3600000 },
    routes,
    {
      mode: 'live',
      provider: 'fixture',
      label: '실제 공급원 형식',
      sourceTimestamp: null,
      receivedAt: NOW,
      isRealtime: false,
    },
  );
  const [candidate] = result.routes;
  assert.equal(
    candidate.segments.find((segment) => segment.mode === 'car')?.parkingAccess?.occupancy,
    'unknown',
  );
  assert.equal(candidate.recommended, false);
});
