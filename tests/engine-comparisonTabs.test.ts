// Every results tab with a feasible route keeps its best one, however many faster routes use other modes.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';
import { executeRouteSearch } from '../src/modules/routing/domain/route-search.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';

const NOW = Date.UTC(2026, 10, 1, 3);
const place = (id: string, latitude: number, longitude: number): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const O = place('홍대입구', 37.5572, 126.9245),
  D = place('상수', 37.5478, 126.9227);
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '통제된 공급원 경로',
  start,
  end,
  distanceMeters: Math.round(metersBetween(start, end)),
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  ...(start === end ? {} : { polyline: [start, end] }),
  ...extra,
});
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, part) => sum + part.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (sum, part) => ({
      min: sum.min + part.durationSeconds.min,
      max: sum.max + part.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});
const stop = (index: number) => place(`정류장${index}`, 37.5565 - index * 0.00001, 126.9244);
const alight = (index: number) => place(`하차${index}`, 37.5482 + index * 0.00001, 126.9228);
/** A bus ride on its own line; the index makes it a little slower than the one before. */
const bus = (index: number, seconds = 420) =>
  route(`bus-${index}`, [
    leg(`bus-${index}-walk-a`, 'walk', O, stop(index), 60),
    leg(`bus-${index}-ride`, 'bus', stop(index), alight(index), seconds + index, {
      lineName: `70${10 + index}`,
      transit: { lines: [`70${10 + index}`], stops: [stop(index).name, alight(index).name] },
    }),
    leg(`bus-${index}-walk-b`, 'walk', alight(index), D, 60),
  ]);
const GATE_O = place('홍대입구역', 37.5571, 126.9244),
  GATE_D = place('합정역', 37.5495, 126.9139);
const subway = route('subway', [
  leg('subway-walk-a', 'walk', O, GATE_O, 90),
  leg('subway-ride', 'subway', GATE_O, GATE_D, 300, {
    lineName: '2호선',
    transit: { lines: ['2호선'], stops: ['홍대입구', '합정'] },
  }),
  leg('subway-walk-b', 'walk', GATE_D, D, 900),
]);
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '확인한 경로',
  receivedAt: NOW,
  sourceTimestamp: null,
  isRealtime: false,
};
const request = {
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
};
const hasMode = (candidate: { segments: readonly { mode: string }[] }, mode: string) =>
  candidate.segments.some((segment) => segment.mode === mode);

const taxi = (id: string, seconds: number, tail: BaseSegment[] = []) =>
  route(id, [leg(`${id}-taxi`, 'taxi', O, tail.length ? GATE_O : D, seconds), ...tail]);
const taxiSubway = taxi('taxi-subway', 120, [
  leg('taxi-subway-ride', 'subway', GATE_O, GATE_D, 300, {
    lineName: '2호선',
    transit: { lines: ['2호선'], stops: ['홍대입구', '합정'] },
  }),
  leg('taxi-subway-walk', 'walk', GATE_D, D, 900),
]);

test('a full results list keeps the subway tab: its best route replaces the slowest route no tab needs', () => {
  // Two faster taxis fill the taxi family's diverse share and eighteen faster buses fill the rest;
  // the only subway ride (a taxi to the station) is the slowest route of all.
  const candidates = [
    taxi('taxi-a', 200),
    taxi('taxi-b', 210),
    ...Array.from({ length: 18 }, (_, index) => bus(index, 300 + 10 * index)),
    taxiSubway,
  ];
  const planned = planBaseRoutes(request, candidates, provenance, {
    objective: 'estimated-arrival',
    deadlineValidationTime: NOW,
    maxRoutes: 18,
  }).routes;
  assert.equal(planned.length, 18);
  assert.ok(
    planned.some((candidate) => hasMode(candidate, 'subway')),
    'the subway tab keeps a route',
  );
  assert.ok(
    planned.some((candidate) => candidate.id === 'taxi-a'),
    'the fastest route stays',
  );
  assert.ok(
    planned.some((candidate) => candidate.id === 'bus-0'),
    'the fastest bus stays',
  );
  assert.ok(!planned.some((candidate) => candidate.id === 'bus-17'), 'the slowest bus made room');
});

test('the tab reservation never applies to the short three-route lists', () => {
  const planned = planBaseRoutes(
    request,
    [...Array.from({ length: 5 }, (_, index) => bus(index, 300 + 10 * index)), subway],
    provenance,
    { objective: 'estimated-arrival', deadlineValidationTime: NOW, maxRoutes: 3 },
  ).routes;
  assert.equal(planned.length, 3);
  assert.ok(!planned.some((candidate) => candidate.id === 'subway'));
});

/** The real route search over controlled provider itineraries, as the journey graph composes them. */
async function search(sources: () => BaseRoute[]) {
  const now = () => NOW;
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    nearby: async () => [],
    walking: async () => [],
    transit: async (_endpoints, budget) => budget.run(() => sources()),
  };
  const options: RoutingOptions = {
    provider,
    realtime: new RealtimeService({}),
    nearbyTransit: new NearbyTransitService({ provider, now }),
    traffic: new RoadTrafficService({ now }),
    mobility: new MobilityFeeds({ now }),
    weather: new WeatherFeed(),
    parking: new SeoulParkingFeed(undefined, { now }),
    intermediateTransitHubs: 2,
    now,
  };
  const result = await executeRouteSearch(
    {
      ...request,
      preferences: {
        ...request.preferences,
        allowBicycle: false,
        bicycleReady: false,
        allowScooter: false,
        allowEbike: false,
        allowTaxi: false,
      },
    },
    options,
  );
  assert.ok(result);
  return JSON.parse(result.encoded.body.toString()) as { routes: BaseRoute[] };
}

test('through the route search, twelve faster bus routes no longer leave the subway tab empty', async () => {
  // Each bus clearly beats walking its 0.9 km (a ride that saves under two minutes is no hop worth its wait).
  const body = await search(() => [
    ...Array.from({ length: 14 }, (_, index) => bus(index, 150 + 10 * index)),
    subway,
  ]);
  assert.ok(body.routes.filter((candidate) => hasMode(candidate, 'bus')).length >= 12);
  assert.ok(
    body.routes.some((candidate) => hasMode(candidate, 'subway')),
    'the subway tab has its route',
  );
  assert.ok(
    body.routes.some((candidate) => candidate.segments.some((part) => part.id.includes('bus-0'))),
  );
});
