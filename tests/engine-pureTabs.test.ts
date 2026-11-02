// A results tab shows its own mode (quality INTEGRATION-QUALITY, 11-02 defects 2 and 3): the response keeps the best pure
// route of every mode that can make the trip, a short bus is compared with the walk that was really fetched, and the
// walks of the short bus stretches are fetched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { shortHopWalks, MAX_HOP_WALKS } from '../src/common/engine/short-hop-walks.js';
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
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '서울 중구',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
// Points on one street, 300 m apart.
const O = point('출발', 0),
  A = point('가', 300),
  B = point('나', 600),
  D = point('도착', 900);
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
  instructions: '실제 조회 구간',
  start,
  end,
  distanceMeters: start === end ? 0 : Math.round(Math.abs(end.latitude - start.latitude) * 111195),
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  ...(start !== end ? { polyline: [start, end] } : {}),
  ...extra,
});
const source = (id: string, segments: BaseSegment[], fareWon?: number): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((n, s) => n + s.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (n, s) => ({ min: n.min + s.durationSeconds.min, max: n.max + s.durationSeconds.max }),
    { min: 0, max: 0 },
  ),
  fareWon,
});
const request = (overrides = {}) => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3600000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowBicycle: true,
    bicycleReady: true,
    allowEbike: true,
    maxBicycleMeters: 3000,
    ...overrides,
  },
});
const modes = (route: { segments: readonly { mode: string }[] }) => route.segments.map((segment) => segment.mode);
const vehicles = (route: { segments: readonly { mode: string }[] }) =>
  modes(route).filter((mode) => ['subway', 'bus', 'bicycle', 'ebike', 'scooter', 'taxi', 'car'].includes(mode));
const lease = (id: string, start: Place, end: Place, rideSeconds: number) =>
  source(id, [
    leg(`${id}-hire`, 'hire', start, start, 30, {
      rentalValidity: {
        verifiedAt: NOW,
        validUntil: NOW + 3600000,
        vehicleId: id,
        provider: 'test-operator',
      },
    }),
    leg(`${id}-ride`, 'ebike', start, end, rideSeconds, { routingProfile: 'ebike' }),
    leg(`${id}-return`, 'return', end, end, 20),
  ]);
const taxiLeg = (id: string, start: Place, end: Place, seconds: number) =>
  source(id, [
    leg(`${id}-pickup`, 'wait', start, start, 40),
    leg(`${id}-taxi`, 'taxi', start, end, seconds, { costWon: 5000 }),
  ]);
const busLeg = (id: string, start: Place, end: Place, wait: number, seconds: number) =>
  source(
    id,
    [leg(`${id}-wait`, 'wait', start, start, wait), leg(`${id}-ride`, 'bus', start, end, seconds)],
    1500,
  );
const trainLeg = (id: string, start: Place, end: Place, wait: number, seconds: number) =>
  source(
    id,
    [leg(`${id}-wait`, 'wait', start, start, wait), leg(`${id}-ride`, 'subway', start, end, seconds)],
    1500,
  );
const walkLeg = (id: string, start: Place, end: Place, seconds: number) =>
  source(id, [leg(id, 'walk', start, end, seconds)]);
const plan = (sources: BaseRoute[], options: Parameters<typeof planJourneyGraph>[2]) =>
  planJourneyGraph(request(), sources, options);

test('a pure search keeps the best route that rides one vehicle only, whatever faster mixtures exist', () => {
  // An e-bike to the middle and a taxi on is fastest; the e-bike all the way is slower; so is the subway.
  const sources = [
    walkLeg('walk-all', O, D, 1500),
    lease('first', O, A, 40),
    taxiLeg('then-taxi', A, D, 60),
    lease('whole', O, D, 400),
    busLeg('bus-a', O, B, 60, 60),
    trainLeg('train-b', B, D, 60, 60),
    trainLeg('train-all', O, D, 300, 200),
    busLeg('bus-all', O, D, 400, 300),
  ];
  const main = plan(sources, { receivedAt: NOW, maxResults: 1 });
  assert.deepEqual(vehicles(main.routes[0]), ['ebike', 'taxi']);

  const ebike = plan(sources, { receivedAt: NOW, maxResults: 1, pureMode: 'ebike' });
  assert.equal(ebike.routes.length, 1);
  assert.deepEqual(vehicles(ebike.routes[0]), ['ebike']);
  assert.deepEqual(ebike.routes[0].durationSeconds, { min: 450, max: 450 });

  // The subway tab is the train only: the bus then train is faster, and is not what the tab shows.
  const subway = plan(sources, { receivedAt: NOW, maxResults: 1, pureMode: 'subway' });
  assert.equal(subway.routes.length, 1);
  assert.deepEqual(vehicles(subway.routes[0]), ['subway']);
  const mixed = plan(sources, { receivedAt: NOW, maxResults: 1, requiredMode: 'subway' });
  assert.deepEqual(vehicles(mixed.routes[0]), ['bus', 'subway']);

  const bus = plan(sources, { receivedAt: NOW, maxResults: 1, pureMode: 'bus' });
  assert.deepEqual(vehicles(bus.routes[0]), ['bus']);
});

test('a pure search invents nothing: a mode no fetched path rides has no route', () => {
  const sources = [walkLeg('walk-all', O, D, 1500), lease('whole', O, D, 400), taxiLeg('taxi', O, D, 200)];
  for (const mode of ['subway', 'bus', 'scooter', 'bicycle'] as const)
    assert.equal(
      plan(sources, { receivedAt: NOW, maxResults: 1, pureMode: mode }).routes.length,
      0,
      mode,
    );
  // The taxi tab is the taxi alone, and the e-bike tab never borrows a taxi.
  assert.deepEqual(
    vehicles(plan(sources, { receivedAt: NOW, maxResults: 1, pureMode: 'taxi' }).routes[0]),
    ['taxi'],
  );
});

test('a pure search leaves the other searches as they were', () => {
  const sources = [walkLeg('walk-all', O, D, 1500), lease('whole', O, D, 400), taxiLeg('taxi', O, D, 200)];
  const plain = plan(sources, { receivedAt: NOW, maxResults: 6 });
  const again = plan(sources, { receivedAt: NOW, maxResults: 6, pureMode: undefined });
  assert.deepEqual(
    again.routes.map((route) => route.id),
    plain.routes.map((route) => route.id),
  );
  assert.equal(plain.diagnostics.excludedEdgeReasons['other-vehicle'], undefined);
  const pure = plan(sources, { receivedAt: NOW, maxResults: 6, pureMode: 'ebike' });
  assert.ok((pure.diagnostics.excludedEdgeReasons['other-vehicle'] ?? 0) > 0);
});

// ---- A short bus is compared with the walk that was fetched ----
test('a short bus is kept when the fetched walk of its stretch is long, and dropped when it is short', () => {
  const hop = () =>
    busLeg('hop', O, A, 120, 60);
  const rest = walkLeg('rest', A, D, 440);
  const stretch = (seconds: number) => walkLeg('stretch', O, A, seconds);
  const search = (stretchSeconds: number) =>
    plan([walkLeg('walk-all', O, D, 2000), hop(), rest, stretch(stretchSeconds)], {
      receivedAt: NOW,
      maxResults: 6,
    });
  // The 300 m stretch walks in 260 s on a straight street: the 180 s bus saves under two minutes.
  const near = search(260);
  assert.equal(near.routes.some((route) => modes(route).includes('bus')), false);
  assert.ok(near.diagnostics.shortRides > 0);
  // The same stretch around a rail line is a 900 s walk in the fetched network: the bus saves twelve minutes and stays.
  const far = search(900);
  assert.equal(far.diagnostics.shortRides, 0);
  assert.deepEqual(modes(far.routes[0]), ['wait', 'bus', 'walk']);
  // Several walks of the stretch: the fastest is the one compared.
  const both = plan(
    [walkLeg('walk-all', O, D, 2000), hop(), rest, stretch(900), walkLeg('quick', O, A, 250)],
    { receivedAt: NOW, maxResults: 6 },
  );
  assert.equal(both.routes.some((route) => modes(route).includes('bus')), false);
});

// ---- The walks of the short bus stretches are fetched ----
const walkingRoute = (from: Place, to: Place, seconds: number): BaseRoute =>
  source('provider-walk', [
    leg('provider-walk-leg', 'walk', from, to, seconds, {
      routingSource: { provider: 'osrm', profile: 'foot' } as never,
    }),
  ]);
const budget = () => new CallBudget(10);
function walker(unmetered: boolean, seconds = 600, fail = false) {
  const asked: string[] = [];
  const provider = {
    configured: true,
    searchPlaces: async () => [],
    unmetered: { walking: unmetered },
    walking: async ({ origin, destination }: { origin: Place; destination: Place }) => {
      asked.push(`${origin.id}>${destination.id}`);
      if (fail) throw new Error('down');
      return [walkingRoute(origin, destination, seconds)];
    },
  } as unknown as RouteProvider;
  return { provider, asked };
}
const hopBus = (id: string, from: Place, to: Place) => source(id, [leg(`${id}-ride`, 'bus', from, to, 90)]);

test('the walks of bus stretches up to 1 km are asked once each, as walking alternatives', async () => {
  const { provider, asked } = walker(true);
  const walks = await shortHopWalks(
    [
      hopBus('short', O, A),
      hopBus('again', O, A),
      hopBus('long', O, point('far', 1500)),
      source('train', [leg('train-ride', 'subway', A, B, 90)]),
    ],
    { provider, budget: budget(), now: NOW },
  );
  assert.deepEqual(asked, ['출발>가']);
  assert.equal(walks.length, 1);
  assert.equal(walks[0].segments.length, 1);
  assert.equal(walks[0].segments[0].mode, 'walk');
  assert.equal(walks[0].segments[0].start.id, O.id);
  assert.equal(walks[0].segments[0].end.id, A.id);
  assert.equal(walks[0].durationSeconds.max, 600);
});

test('no walk is asked for on a metered pedestrian network, and a failed lookup leaves the ride in place', async () => {
  const metered = walker(false);
  assert.deepEqual(await shortHopWalks([hopBus('short', O, A)], { provider: metered.provider, budget: budget(), now: NOW }), []);
  assert.deepEqual(metered.asked, []);
  const down = walker(true, 600, true);
  assert.deepEqual(await shortHopWalks([hopBus('short', O, A)], { provider: down.provider, budget: budget(), now: NOW }), []);
  assert.deepEqual(down.asked, ['출발>가']);
});

test('at most MAX_HOP_WALKS stretches are asked for', async () => {
  const { provider, asked } = walker(true);
  const routes = Array.from({ length: MAX_HOP_WALKS + 6 }, (_, index) =>
    hopBus(`hop-${index}`, point(`s${index}`, index * 20), point(`e${index}`, index * 20 + 400)),
  );
  await shortHopWalks(routes, { provider, budget: budget(), now: NOW });
  assert.equal(asked.length, MAX_HOP_WALKS);
});

// ---- The response ----
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '확인한 경로',
  receivedAt: NOW,
  sourceTimestamp: null,
  isRealtime: false,
};
const stop = (index: number) => point(`정류장${index}`, 20 + index);
const GATE_O = point('역', 1500);
const GATE_D = point('도착역', 4500);
const FAR = point('먼도착', 4600);

test('a full results list keeps the pure subway when faster mixtures with a subway fill it', () => {
  // Fourteen bus-then-subway routes beat the train alone; a taxi to the station and the train alone are slower still.
  const mixed = (index: number) =>
    source(`mixed-${index}`, [
      leg(`mixed-${index}-walk`, 'walk', point('o', 0), stop(index), 30),
      leg(`mixed-${index}-wait`, 'wait', stop(index), stop(index), 60),
      leg(`mixed-${index}-bus`, 'bus', stop(index), GATE_O, 100 + 5 * index, {
        transit: { lines: [`70${index}`], stops: ['가', '나'] },
      }),
      leg(`mixed-${index}-train`, 'subway', GATE_O, GATE_D, 300, {
        transit: { lines: ['2호선'], stops: ['가', '나'] },
      }),
      leg(`mixed-${index}-walk-b`, 'walk', GATE_D, FAR, 120),
    ]);
  const pure = source('pure-subway', [
    leg('pure-walk', 'walk', point('o', 0), GATE_O, 1200),
    leg('pure-train', 'subway', GATE_O, GATE_D, 300, {
      transit: { lines: ['2호선'], stops: ['가', '나'] },
    }),
    leg('pure-walk-b', 'walk', GATE_D, FAR, 120),
  ]);
  const candidates = [...Array.from({ length: 14 }, (_, index) => mixed(index)), pure];
  const planned = planBaseRoutes(
    { ...request(), origin: point('o', 0), destination: FAR },
    candidates,
    provenance,
    { objective: 'estimated-arrival', deadlineValidationTime: NOW, maxRoutes: 12 },
  ).routes;
  assert.equal(planned.length, 12);
  assert.ok(
    planned.some((route) => vehicles(route).length === 1 && vehicles(route)[0] === 'subway'),
    'the subway tab has a route that rides only the subway',
  );
  assert.ok(planned.some((route) => route.id === 'mixed-0'), 'the fastest route stays');
});

test('a full results list keeps the pure e-bike when faster e-bike mixtures fill every slot', () => {
  // Fourteen e-bike-then-bus routes share one family and beat the e-bike alone, so the tab rule that is satisfied by any
  // route using the vehicle would leave the e-bike tab to a bus with a ride before it.
  const o = point('o', 0);
  const mixed = (index: number) =>
    source(`ebus-${index}`, [
      leg(`ebus-${index}-hire`, 'hire', o, o, 30, {
        rentalValidity: { verifiedAt: NOW, validUntil: NOW + 3600000, vehicleId: `e${index}`, provider: 'test-operator' },
      }),
      leg(`ebus-${index}-ride`, 'ebike', o, stop(index), 60, { routingProfile: 'ebike' }),
      leg(`ebus-${index}-return`, 'return', stop(index), stop(index), 20),
      leg(`ebus-${index}-wait`, 'wait', stop(index), stop(index), 30),
      leg(`ebus-${index}-bus`, 'bus', stop(index), FAR, 100 + 5 * index, {
        transit: { lines: [`70${index}`], stops: ['가', '나'] },
      }),
    ]);
  const wholeRide = lease('ebike-all', o, FAR, 700);
  const candidates = [...Array.from({ length: 14 }, (_, index) => mixed(index)), wholeRide];
  const planned = planBaseRoutes(
    { ...request(), origin: o, destination: FAR },
    candidates,
    provenance,
    { objective: 'estimated-arrival', deadlineValidationTime: NOW, maxRoutes: 12 },
  ).routes;
  assert.ok(planned.some((route) => route.id === 'ebus-0'), 'the fastest route stays');
  assert.ok(
    planned.some((route) => vehicles(route).length === 1 && vehicles(route)[0] === 'ebike'),
    `the e-bike tab has its own route: ${planned.map((route) => vehicles(route).join('+')).join(' | ')}`,
  );
});

/** The real route search over controlled provider itineraries. */
async function searchResponse(sources: () => BaseRoute[]) {
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
  const OD = { origin: point('o', 0), destination: FAR };
  const result = await executeRouteSearch(
    {
      ...OD,
      now: NOW,
      deadline: NOW + 3_600_000,
      preferences: {
        ...DEFAULT_PREFERENCES,
        allowRunning: false,
        preparationSeconds: 0,
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

test('through the route search, the subway tab has a route that rides only the subway', async () => {
  const mixed = (index: number) =>
    source(`mixed-${index}`, [
      leg(`mixed-${index}-walk`, 'walk', point('o', 0), stop(index), 30),
      leg(`mixed-${index}-wait`, 'wait', stop(index), stop(index), 60),
      leg(`mixed-${index}-bus`, 'bus', stop(index), GATE_O, 100 + 5 * index, {
        lineName: `70${index}`,
        transit: { lines: [`70${index}`], stops: [`정류장${index}`, '역'] },
      }),
      leg(`mixed-${index}-train`, 'subway', GATE_O, GATE_D, 300, {
        lineName: '2호선',
        transit: { lines: ['2호선'], stops: ['역', '도착역'] },
      }),
      leg(`mixed-${index}-walk-b`, 'walk', GATE_D, FAR, 120),
    ]);
  const pure = source('pure-subway', [
    leg('pure-walk', 'walk', point('o', 0), GATE_O, 1200),
    leg('pure-train', 'subway', GATE_O, GATE_D, 300, {
      lineName: '2호선',
      transit: { lines: ['2호선'], stops: ['역', '도착역'] },
    }),
    leg('pure-walk-b', 'walk', GATE_D, FAR, 120),
  ]);
  const body = await searchResponse(() => [
    ...Array.from({ length: 14 }, (_, index) => mixed(index)),
    pure,
  ]);
  const own = body.routes.filter(
    (route) => vehicles(route).length > 0 && vehicles(route).every((mode) => mode === 'subway'),
  );
  assert.ok(own.length > 0, `routes: ${body.routes.map((route) => vehicles(route).join('+')).join(' | ')}`);
  assert.ok(
    body.routes.some((route) => vehicles(route).join('+') === 'bus+subway'),
    'the faster mixtures are still listed',
  );
  assert.equal(metersBetween(own[0].segments[0].start, point('o', 0)) < 5, true);
});
