// Regression cases from mvp/tests/localRoutingCoverage.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { BicycleRouter, PedestrianRouter } from '../src/common/engine/connectivity/pedestrian.js';
import { withPedestrianRouting } from '../src/common/engine/connectivity/provider.js';
import {
  routeQueryIsCached,
  routeQueryIsFree,
  routeQueryIsReusable,
  withRouteQueryReuse,
} from '../src/common/engine/connectivity/query-reuse.js';
import { ApiError } from '../src/common/engine/errors.js';
import type { RouteEndpoints, RouteProvider } from '../src/common/engine/kakao.js';
import {
  buildMixedModeBridges,
  inspectedRentalPairs,
  rentalLimitDiagnostics,
  rentalSlotAvailable,
  type BridgeGenerationDiagnostics,
} from '../src/common/engine/mixed-mode-bridges.js';
import { rentalAvailabilityForSearch } from '../src/common/engine/intelligence/rental-availability.js';
import { groundedStationPoints } from '../src/common/engine/multimodal.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { enrichTransitRoutes } from '../src/common/engine/transit-enrichment.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';

const NOW = Date.UTC(2026, 9, 31, 1);
const pin = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '로컬 보행망 fixture',
  latitude: 37.55 + meters / 111_195,
  longitude: 126.97,
});
const O = pin('origin', 0),
  D = pin('destination', 9_000);
const live = {
  mode: 'live' as const,
  provider: 'osrm-foot',
  label: '보행망 fixture',
  receivedAt: NOW,
  sourceTimestamp: null,
  isRealtime: false,
};
function leg(
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '공급원 경로',
    start,
    end,
    distanceMeters: start === end ? 0 : Math.round(metersBetween(start, end)),
    durationSeconds: { min: seconds, max: seconds },
    runAllowed: false,
    ...(start === end ? {} : { polyline: [start, end] }),
    ...extra,
  };
}
const grounded = (id: string, start: Place, end: Place, seconds: number) =>
  leg(id, 'walk', start, end, seconds, {
    routingSource: live,
    networkSnap: { startMeters: 0, endMeters: 0, allowanceSeconds: 0 },
  });
const subway = (id: string, start: Place, end: Place, seconds: number) =>
  leg(id, 'subway', start, end, seconds, {
    lineName: '2호선',
    transit: { lines: ['2호선'], stops: [start.name, end.name] },
  });
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, part) => sum + part.distanceMeters, 0),
  durationSeconds: {
    min: segments.reduce((sum, part) => sum + part.durationSeconds.min, 0),
    max: segments.reduce((sum, part) => sum + part.durationSeconds.max, 0),
  },
});

// ---------------------------------------------------------------------------------------------------------------------------
// The self-hosted OSRM router: free, bounded, and out of the way when it is silent.

const START = [126.9707, 37.5548],
  END = [126.9779, 37.5662];
const osrm = () => ({
  code: 'Ok',
  data_version: '2026-10-14T00:00:00Z',
  waypoints: [
    { distance: 10, location: [...START], name: '' },
    { distance: 10, location: [...END], name: '' },
  ],
  routes: [
    {
      distance: 1500,
      duration: 1200,
      geometry: { type: 'LineString', coordinates: [START, END] },
      legs: [
        {
          steps: [
            {
              mode: 'walking',
              name: '길',
              distance: 1500,
              duration: 1200,
              geometry: { type: 'LineString', coordinates: [START, END] },
              maneuver: { type: 'depart', location: START },
            },
            {
              mode: 'walking',
              name: '',
              distance: 0,
              duration: 0,
              geometry: { type: 'LineString', coordinates: [END, END] },
              maneuver: { type: 'arrive', location: END },
            },
          ],
        },
      ],
    },
  ],
});
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ownEndpoint = 'http://127.0.0.1:5001/route/v1/foot';
const walkRequest = (index: number): RouteEndpoints => ({
  origin: {
    id: `o${index}`,
    name: `출발${index}`,
    address: '',
    latitude: 37.5547 + index * 0.00001,
    longitude: 126.9707,
  },
  destination: {
    id: `d${index}`,
    name: `도착${index}`,
    address: '',
    latitude: 37.5663,
    longitude: 126.9779,
  },
});
const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

test('a self-hosted walk costs no budget and is not refused by a spent or closed budget', async () => {
  const own = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    metered: false,
    fetcher: async () => reply(osrm()),
  });
  const hosted = withPedestrianRouting(
    {
      configured: false,
      searchPlaces: async () => [],
      walking: async () => {
        throw new Error('unused');
      },
      transit: async () => [],
    },
    own,
  );
  assert.equal(hosted.unmetered?.walking, true);
  const shared = withRouteQueryReuse(hosted);
  assert.equal(shared.unmetered?.walking, true, 'the per-search wrapper keeps the flag');
  const spent = new CallBudget(1);
  await spent.run(() => undefined);
  assert.equal(spent.remaining, 0);
  const closed = new CallBudget(5);
  closed.closeAfter(0);
  for (const [index, budget] of [spent, closed].entries()) {
    assert.equal(routeQueryIsFree(shared, 'walking'), true);
    assert.equal(routeQueryIsReusable(shared, 'walking', walkRequest(index), budget), true);
    assert.equal(
      routeQueryIsCached(shared, 'walking', walkRequest(index), budget),
      false,
      'free is not the same as remembered',
    );
    assert.equal((await shared.walking(walkRequest(index), budget))[0].durationSeconds.min, 1200);
    assert.equal(
      routeQueryIsCached(shared, 'walking', walkRequest(index), budget),
      true,
      'and an answered query is remembered',
    );
  }
  assert.equal(routeQueryIsFree(shared, 'transit'), false);
  assert.equal(routeQueryIsFree(shared, 'bicycle'), false, 'no bicycle network was configured');
  assert.equal(spent.used, 1);
  const metered = withPedestrianRouting(
    {
      configured: false,
      searchPlaces: async () => [],
      walking: async () => {
        throw new Error('unused');
      },
      transit: async () => [],
    },
    new PedestrianRouter({
      endpoint: ownEndpoint,
      now: () => NOW,
      metered: true,
      fetcher: async () => reply(osrm()),
    }),
  );
  assert.equal(metered.unmetered?.walking, false);
  assert.equal(routeQueryIsReusable(metered, 'walking', walkRequest(0), new CallBudget(5)), false);
});

test('a self-hosted bicycle network is free too, and only while it answers', async () => {
  const fetcher = async () => {
    throw new TypeError('connection refused');
  };
  const cycling = new BicycleRouter({
    endpoint: 'http://127.0.0.1:5002/route/v1/bike',
    now: () => NOW,
    metered: false,
    fetcher,
  });
  const provider = withPedestrianRouting(
    {
      configured: false,
      searchPlaces: async () => [],
      walking: async () => [],
      transit: async () => [],
    },
    undefined,
    { cycling },
  );
  assert.equal(routeQueryIsFree(provider, 'bicycle'), true);
  assert.equal(routeQueryIsFree(provider, 'walking'), false);
  const budget = new CallBudget(5);
  for (let attempt = 0; attempt < 3; attempt++)
    await assert.rejects(
      cycling.bicycle(walkRequest(attempt), budget),
      code('PROVIDER_UNAVAILABLE'),
    );
  assert.equal(
    routeQueryIsFree(provider, 'bicycle'),
    false,
    'a server that failed three times in a row is skipped, not trusted as free',
  );
});

test('a self-hosted server open to a whole search is never asked for more than eight walks at once', async () => {
  let open = 0,
    peak = 0,
    calls = 0;
  const own = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    metered: false,
    fetcher: async () => {
      calls++;
      open++;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open--;
      return reply(osrm());
    },
  });
  const budget = new CallBudget(1);
  await budget.run(() => undefined);
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) => own.walking(walkRequest(index), budget)),
  );
  assert.equal(results.length, 40);
  assert.equal(calls, 40);
  assert.ok(peak <= 8, `peak ${peak}`);
  assert.ok(peak >= 2, 'the cap is a bound, not serialisation');
});

test('a stalled self-hosted server fails fast per request and is then skipped instead of queueing every walk behind its timeout', async () => {
  let calls = 0;
  const own = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    metered: false,
    timeoutMs: 20,
    fetcher: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls++;
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
  });
  const budget = new CallBudget(5);
  const started = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => own.walking(walkRequest(index), budget)),
  );
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.ok(calls <= 8 + 3, `calls ${calls}`);
  assert.ok(
    performance.now() - started < 1_000,
    'twelve stalled walks do not cost twelve timeouts in sequence',
  );
  assert.equal(own.unmetered, false);
  const before = calls;
  await assert.rejects(own.walking(walkRequest(99), budget), code('PROVIDER_UNAVAILABLE'));
  assert.equal(calls, before, 'while it is skipped no request is sent');
});

test('"no route" and refused queries do not mark a working self-hosted server as down', async () => {
  const own = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    metered: false,
    fetcher: async () =>
      reply({ code: 'NoSegment', message: 'Could not find a matching segment' }, 400),
  });
  const budget = new CallBudget(5);
  for (let attempt = 0; attempt < 6; attempt++)
    await assert.rejects(
      own.walking(walkRequest(attempt), budget),
      (error: unknown) => error instanceof ApiError,
    );
  assert.equal(own.unmetered, true);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Access walks while walking is free.

const board = (index: number) => pin(`board-${index}`, 100 + index * 150),
  alight = (index: number) => pin(`alight-${index}`, 8_900 - index * 150);
const railSources = Array.from({ length: 4 }, (_, index) =>
  route(`rail-${index}`, [subway(`rail-${index}`, board(index), alight(index), 600 + index * 10)]),
);
const footProvider = (calls: string[], free: boolean): RouteProvider => ({
  configured: true,
  searchPlaces: async () => [],
  transit: async () => [],
  ...(free ? { unmetered: { walking: true } } : {}),
  walking: async (endpoints) => {
    calls.push(`${endpoints.origin.id}>${endpoints.destination.id}`);
    return [
      route('foot', [
        leg('foot', 'walk', endpoints.origin, endpoints.destination, 100, {
          routingSource: live,
          networkSnap: { startMeters: 0, endMeters: 0, allowanceSeconds: 0 },
        }),
      ]),
    ];
  },
});

test('access walks on a free network are routed past a spent budget up to their own larger cap', async () => {
  const spent = new CallBudget(1);
  await spent.run(() => undefined);
  const calls: string[] = [],
    reasons: string[] = [];
  const enriched = await enrichTransitRoutes(
    railSources,
    { origin: O, destination: D },
    {
      provider: footProvider(calls, true),
      budget: spent,
      now: NOW,
      maxAccessCalls: 0,
      maxUnmeteredAccessCalls: 8,
      onAccessLimited: (reason) => reasons.push(reason),
    },
  );
  assert.equal(calls.length, 8, 'four boardings and four alightings');
  assert.deepEqual(reasons, []);
  for (const result of enriched) {
    const walks = result.segments.filter((part) => part.mode === 'walk');
    assert.equal(walks.length, 2);
    assert.ok(
      walks.every((part) => part.routingSource?.provider === 'osrm-foot'),
      'every access walk is a routed one, not a distance estimate',
    );
  }
  assert.equal(spent.used, 1);
});

test('the free-network access cap reports itself, and a metered network keeps its old cap and budget guard', async () => {
  const reasons: string[] = [],
    calls: string[] = [];
  const capped = await enrichTransitRoutes(
    railSources,
    { origin: O, destination: D },
    {
      provider: footProvider(calls, true),
      budget: new CallBudget(5),
      now: NOW,
      maxAccessCalls: 8,
      maxUnmeteredAccessCalls: 3,
      onAccessLimited: (reason) => reasons.push(reason),
    },
  );
  assert.equal(calls.length, 3);
  assert.ok(reasons.length > 0 && reasons.every((reason) => reason === 'access-cap'));
  assert.ok(
    capped.some((result) =>
      result.segments.some((part) => part.mode === 'walk' && !part.routingSource),
    ),
    'what the cap leaves out stays an estimate',
  );
  const meteredCalls: string[] = [],
    meteredReasons: string[] = [];
  const spent = new CallBudget(1);
  await spent.run(() => undefined);
  await enrichTransitRoutes(
    railSources,
    { origin: O, destination: D },
    {
      provider: footProvider(meteredCalls, false),
      budget: spent,
      now: NOW,
      maxAccessCalls: 8,
      maxUnmeteredAccessCalls: 8,
      onAccessLimited: (reason) => meteredReasons.push(reason),
    },
  );
  assert.equal(meteredCalls.length, 0);
  assert.ok(meteredReasons.every((reason) => reason === 'route-budget'));
});

// ---------------------------------------------------------------------------------------------------------------------------
// Transfer walks and taxi splices at station ends.

interface Log {
  kind: string;
  from: Place;
  to: Place;
  at: number;
}
const fixtureProvider = (
  log: Log[],
  options: { free?: boolean; taxiDelay?: number; bikeDelay?: number } = {},
): RouteProvider => {
  const record = (kind: string, from: Place, to: Place) =>
    log.push({ kind, from, to, at: performance.now() });
  return {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    ...(options.free ? { unmetered: { walking: true, bicycle: true } } : {}),
    walking: async (request, budget) => {
      record('walk', request.origin, request.destination);
      return [
        route('walk', [
          grounded(
            'walk',
            request.origin,
            request.destination,
            request.origin.id === O.id && request.destination.id === D.id ? 20_000 : 60,
          ),
        ]),
      ];
    },
    bicycle: async (request, budget) => {
      await new Promise((resolve) => setTimeout(resolve, options.bikeDelay ?? 0));
      record('bicycle-done', request.origin, request.destination);
      return [
        route('bike', [
          {
            ...leg('bike', 'bicycle', request.origin, request.destination, 300),
            routingProfile: 'bicycle' as const,
          },
        ]),
      ];
    },
    driving: async (request, budget) => {
      await new Promise((resolve) => setTimeout(resolve, options.taxiDelay ?? 0));
      record('taxi', request.origin, request.destination);
      const start = { latitude: request.origin.latitude, longitude: request.origin.longitude },
        end = { latitude: request.destination.latitude, longitude: request.destination.longitude };
      return {
        distanceMeters: metersBetween(request.origin, request.destination),
        durationSeconds: 300,
        polyline: [start, end],
        maneuvers: [],
        traffic: [],
        taxiFareWon: 8_000,
      };
    },
  };
};
const preferences = {
  ...DEFAULT_PREFERENCES,
  allowBicycle: false,
  bicycleReady: false,
  allowScooter: false,
  allowTaxi: true,
  allowRunning: false,
  preparationSeconds: 0,
};

test('a transfer walk between stops closer than 150 m is looked up only while walking is free', async () => {
  const alightStop = pin('bus-alight', 3_000),
    boardStop = pin('other-bus-board', 3_080);
  const sources = [
    route('bus-one', [leg('bus-one', 'bus', O, alightStop, 600)]),
    route('bus-two', [leg('bus-two', 'bus', boardStop, D, 600)]),
  ];
  const walks = async (free: boolean) => {
    const log: Log[] = [];
    await buildMixedModeBridges(
      { origin: O, destination: D, preferences: { ...preferences, allowTaxi: false } },
      sources,
      { provider: fixtureProvider(log, { free }), budget: new CallBudget(), now: NOW },
    );
    return log.filter(
      (entry) =>
        entry.kind === 'walk' && entry.from.id === alightStop.id && entry.to.id === boardStop.id,
    ).length;
  };
  assert.equal(await walks(true), 1);
  assert.equal(await walks(false), 0, 'a call-metered network keeps the 150 m floor');
});

test('twelve transfer walks are looked up on a free network, two on a metered one', async () => {
  const stops = Array.from({ length: 8 }, (_, index) => ({
    alight: pin(`alight-stop-${index}`, 2_000 + index * 40),
    board: pin(`board-stop-${index}`, 2_700 + index * 40),
  }));
  const sources = stops.map(({ alight: out, board: into }, index) =>
    route(`pair-${index}`, [
      leg(`in-${index}`, 'bus', O, out, 300 + index),
      leg(`out-${index}`, 'bus', into, D, 300 + index),
    ]),
  );
  const walks = async (free: boolean) => {
    const log: Log[] = [];
    const diagnostics: BridgeGenerationDiagnostics[] = [];
    await buildMixedModeBridges(
      { origin: O, destination: D, preferences: { ...preferences, allowTaxi: false } },
      sources,
      {
        provider: fixtureProvider(log, { free }),
        budget: new CallBudget(),
        now: NOW,
        onDiagnostics: (value) => diagnostics.push(value),
      },
    );
    return log.filter(
      (entry) =>
        entry.kind === 'walk' &&
        entry.from.id.startsWith('alight-stop') &&
        entry.to.id.startsWith('board-stop'),
    ).length;
  };
  const free = await walks(true),
    metered = await walks(false);
  assert.ok(free > 2 && free <= 12, `free ${free}`);
  assert.equal(metered, 2);
});

test('the station end of a verified access or egress walk is a place a taxi or a walk may start from or end at', () => {
  const station = pin('station', 2_500),
    exit = pin('exit', 8_000);
  const verified = route('verified', [
    grounded('access', O, station, 1_800),
    leg('wait', 'wait', station, station, 120),
    subway('ride', station, exit, 900),
    grounded('egress', exit, D, 600),
  ]);
  const bare = route('bare', [
    leg('access', 'walk', O, station, 1_800),
    subway('ride', station, exit, 900),
    leg('egress', 'walk', exit, D, 600),
  ]);
  const stale = route('stale', [
    grounded('access', O, station, 1_800),
    subway('ride', station, exit, 900),
  ]);
  stale.segments[0] = {
    ...stale.segments[0],
    routingSource: { ...live, receivedAt: NOW - 600_000 },
  };
  const interior = route('interior', [
    grounded('access', O, station, 1_800),
    subway('ride', station, exit, 900),
  ]);
  interior.notes = [
    {
      code: 'unverified-duration-range',
      severity: 'warning',
      title: '역 내부 보행 연결 미확인',
      description: '미확인',
      segmentId: 'access',
    },
  ];
  const ids = (routes: BaseRoute[]) => groundedStationPoints(routes, NOW).map((point) => point.id);
  assert.deepEqual(ids([verified]), ['station', 'exit']);
  assert.deepEqual(
    ids([bare]),
    [],
    'a bare platform coordinate is still no evidence of a street-level entrance',
  );
  assert.deepEqual(ids([stale]), [], 'a walk older than two minutes proves nothing');
  assert.deepEqual(ids([interior]), [], 'an unverified station interior is not a street anchor');
});

test('a taxi to a station with a verified access walk is looked up, and to a bare platform coordinate it is not', async () => {
  const station = pin('station', 2_500),
    exit = pin('exit', 8_000);
  const taxiTargets = async (access: BaseSegment) => {
    const log: Log[] = [];
    const source = route('rail', [
      access,
      leg('wait', 'wait', station, station, 120),
      subway('ride', station, exit, 900),
      leg('egress', 'walk', exit, D, 300),
    ]);
    const bridges = await buildMixedModeBridges(
      { origin: O, destination: D, preferences },
      [source],
      { provider: fixtureProvider(log), budget: new CallBudget(), now: NOW },
    );
    return {
      taxis: log.filter((entry) => entry.kind === 'taxi' && entry.to.id === station.id),
      bridges,
    };
  };
  const verified = await taxiTargets(grounded('access', O, station, 1_800));
  assert.equal(verified.taxis.length, 1);
  const splice = verified.bridges.find((candidate) => candidate.id.startsWith('graph-taxi-splice'));
  assert.ok(splice?.segments.some((part) => part.mode === 'taxi'));
  assert.equal(
    splice!.segments.at(-1)!.end.id,
    station.id,
    'the taxi leg ends where the rail boarding begins',
  );
  const bare = await taxiTargets(leg('access', 'walk', O, station, 1_800));
  assert.equal(bare.taxis.length, 0);
});

test('a bus alighting can walk to a station whose access walk is verified, and not to a bare platform coordinate', async () => {
  const station = pin('station', 6_000),
    exit = pin('exit', 8_800),
    alightStop = pin('bus-alight', 5_500),
    farAway = pin('far-origin', 4_000);
  const walksTo = async (access: BaseSegment) => {
    const log: Log[] = [];
    const sources = [
      route('bus', [leg('bus', 'bus', O, alightStop, 600)]),
      route('rail', [
        access,
        leg('wait', 'wait', station, station, 120),
        subway('ride', station, exit, 900),
        leg('egress', 'walk', exit, D, 300),
      ]),
    ];
    await buildMixedModeBridges(
      { origin: O, destination: D, preferences: { ...preferences, allowTaxi: false } },
      sources,
      { provider: fixtureProvider(log, { free: true }), budget: new CallBudget(), now: NOW },
    );
    return log.filter(
      (entry) =>
        entry.kind === 'walk' && entry.from.id === alightStop.id && entry.to.id === station.id,
    ).length;
  };
  assert.equal(await walksTo(grounded('access', farAway, station, 400)), 1);
  assert.equal(await walksTo(leg('access', 'walk', farAway, station, 400)), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Skipped taxis are reported; splices and transfers no longer wait for the rentals.

const stationFeed = (points: Place[]) =>
  new MobilityFeeds({
    seoulBikeKey: 'fixture',
    now: () => NOW,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          rentBikeStatus: {
            list_total_count: points.length,
            RESULT: { CODE: 'INFO-000' },
            row: points.map((point, index) => ({
              stationId: `ST-${index}`,
              stationName: point.name,
              stationLatitude: String(point.latitude),
              stationLongitude: String(point.longitude),
              parkingBikeTotCnt: '5',
              rackTotCnt: '10',
            })),
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });

test('a taxi that never starts is reported with the reason, closed window or spent budget', async () => {
  const request = { origin: O, destination: D, preferences };
  for (const reason of ['window', 'budget'] as const) {
    const budget = new CallBudget(3),
      diagnostics: BridgeGenerationDiagnostics[] = [],
      log: Log[] = [];
    if (reason === 'window') budget.closeAfter(0);
    else while (budget.remaining) await budget.run(() => undefined);
    await buildMixedModeBridges(request, [], {
      provider: fixtureProvider(log),
      budget,
      now: NOW,
      onDiagnostics: (value) => diagnostics.push(value),
    });
    const result = diagnostics.at(-1)!;
    assert.equal(log.filter((entry) => entry.kind === 'taxi').length, 0);
    assert.equal(result.taxiSkippedWindow, reason === 'window' ? 1 : 0, reason);
    assert.equal(result.taxiSkippedBudget, reason === 'budget' ? 1 : 0, reason);
    assert.equal(result.limitReached, true, 'a missing taxi option means the search was limited');
  }
  const open: BridgeGenerationDiagnostics[] = [];
  await buildMixedModeBridges(request, [], {
    provider: fixtureProvider([]),
    budget: new CallBudget(),
    now: NOW,
    onDiagnostics: (value) => open.push(value),
  });
  assert.equal(open.at(-1)!.taxiSkippedWindow + open.at(-1)!.taxiSkippedBudget, 0);
  assert.equal(open.at(-1)!.limitReached, false);
});

test('splice taxis and transfer walks start while the rentals are still being routed', async () => {
  const station = pin('station', 2_500),
    exit = pin('exit', 8_000);
  const source = route('rail', [
    grounded('access', O, station, 1_800),
    leg('wait', 'wait', station, station, 120),
    subway('ride', station, exit, 900),
    leg('egress', 'walk', exit, D, 300),
  ]);
  const log: Log[] = [];
  const bridges = await buildMixedModeBridges(
    {
      origin: O,
      destination: D,
      preferences: {
        ...preferences,
        allowBicycle: true,
        bicycleReady: true,
        maxBicycleMeters: 10_000,
      },
    },
    [source],
    {
      provider: fixtureProvider(log, { free: true, taxiDelay: 5, bikeDelay: 150 }),
      budget: new CallBudget(),
      now: NOW,
      mobility: stationFeed([O, D]),
    },
  );
  const spliceAt = log.findIndex((entry) => entry.kind === 'taxi' && entry.to.id === station.id);
  const rentalDoneAt = log.findIndex((entry) => entry.kind === 'bicycle-done');
  assert.ok(spliceAt >= 0 && rentalDoneAt >= 0, JSON.stringify(log.map((entry) => entry.kind)));
  assert.ok(
    spliceAt < rentalDoneAt,
    'the splice lookup was sent before the first rental ride came back',
  );
  assert.ok(bridges.some((candidate) => candidate.id.startsWith('graph-taxi-splice')));
  assert.ok(
    bridges.some((candidate) => candidate.segments.some((part) => part.mode === 'bicycle')),
  );
});

test('a window that closes during slow rentals no longer drops the splice taxi', async () => {
  const station = pin('station', 2_500),
    exit = pin('exit', 8_000);
  const source = route('rail', [
    grounded('access', O, station, 1_800),
    leg('wait', 'wait', station, station, 120),
    subway('ride', station, exit, 900),
    leg('egress', 'walk', exit, D, 300),
  ]);
  const budget = new CallBudget(),
    diagnostics: BridgeGenerationDiagnostics[] = [];
  budget.closeAfter(120);
  const bridges = await buildMixedModeBridges(
    {
      origin: O,
      destination: D,
      preferences: {
        ...preferences,
        allowBicycle: true,
        bicycleReady: true,
        maxBicycleMeters: 10_000,
      },
    },
    [source],
    {
      provider: fixtureProvider([], { free: true, taxiDelay: 5, bikeDelay: 250 }),
      budget,
      now: NOW,
      mobility: stationFeed([O, D]),
      onDiagnostics: (value) => diagnostics.push(value),
    },
  );
  assert.ok(
    bridges.some((candidate) => candidate.id.startsWith('graph-taxi-splice')),
    'started before the window closed',
  );
  assert.equal(diagnostics.at(-1)!.taxiSkippedWindow, 0);
});

test('a road account the supplier rejects is refused once, not once per splice', async () => {
  const log: Log[] = [];
  const provider = fixtureProvider(log, { free: true });
  provider.driving = async () => {
    log.push({ kind: 'taxi', from: O, to: D, at: performance.now() });
    throw new ApiError('PROVIDER_FORBIDDEN', '통제된 택시 권한 오류', 403);
  };
  const station = pin('station', 2_500),
    exit = pin('exit', 8_000);
  const source = route('rail', [
    grounded('access', O, station, 1_800),
    subway('ride', station, exit, 900),
    grounded('egress', exit, D, 600),
  ]);
  await buildMixedModeBridges({ origin: O, destination: D, preferences }, [source], {
    provider,
    budget: new CallBudget(),
    now: NOW,
  });
  assert.equal(log.filter((entry) => entry.kind === 'taxi').length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review fixes: a free network's limits, quota exposure and what the availability statement may read.

test('the self-hosted foot router keeps its 3 s timeout, and a metered public one its 12 s', () => {
  const timeout = (metered: boolean) =>
    (
      new PedestrianRouter({
        endpoint: ownEndpoint,
        now: () => NOW,
        metered,
        fetcher: async () => reply(osrm()),
      }) as unknown as { timeoutMs: number }
    ).timeoutMs;
  assert.equal(timeout(false), 3_000);
  assert.equal(timeout(true), 12_000);
});

test('while walking is free only the first twenty walks may ask Kakao for a second opinion', async () => {
  const far: [number, number] = [126.9743, 37.5775];
  const at = ([longitude, latitude]: number[]) => ({ latitude, longitude });
  const length = Math.round(metersBetween(at(START), at(far)) + metersBetween(at(far), at(END)));
  const detoured = () => ({
    ...osrm(),
    routes: [
      {
        ...osrm().routes[0],
        distance: length,
        duration: Math.round(length * 0.8),
        geometry: { type: 'LineString', coordinates: [START, far, END] },
        legs: [
          {
            steps: [
              {
                mode: 'walking',
                name: '길',
                distance: length,
                duration: Math.round(length * 0.8),
                geometry: { type: 'LineString', coordinates: [START, far, END] },
                maneuver: { type: 'depart', location: START },
              },
              {
                mode: 'walking',
                name: '',
                distance: 0,
                duration: 0,
                geometry: { type: 'LineString', coordinates: [END, END] },
                maneuver: { type: 'arrive', location: END },
              },
            ],
          },
        ],
      },
    ],
  });
  const askedKakao = async (metered: boolean, limit: number | undefined) => {
    let kakao = 0;
    const own = new PedestrianRouter({
      endpoint: ownEndpoint,
      now: () => NOW,
      metered,
      fetcher: async () => reply(detoured()),
    });
    const provider = withPedestrianRouting(
      {
        configured: true,
        searchPlaces: async () => [],
        transit: async () => [],
        walking: async (request) => {
          kakao++;
          return [route('kakao', [grounded('kakao', request.origin, request.destination, 900)])];
        },
      },
      own,
      {
        secondOpinion: () => true,
        ...(limit === undefined ? {} : { secondOpinionLookups: limit }),
      },
    );
    const budget = new CallBudget(72);
    await Promise.all(
      Array.from({ length: 30 }, (_, index) => provider.walking(walkRequest(index), budget)),
    );
    return kakao;
  };
  assert.equal(
    await askedKakao(false, 20),
    20,
    'the 48-walk access stage may not turn into 48 Kakao calls',
  );
  assert.equal(
    await askedKakao(false, undefined),
    30,
    'without the limit every detoured walk asks',
  );
  assert.ok(
    (await askedKakao(true, 20)) > 20,
    'a metered network is bounded by the budget and its old cap, not by this count',
  );
});

test('two platforms of one station are not joined by a street walk, two different stations are', async () => {
  const place = (id: string, name: string, meters: number): Place => ({ ...pin(id, meters), name });
  const ask = async (secondName: string) => {
    const alight = place('alight-platform', '시청', 4_000),
      board = place('board-platform', secondName, 4_100);
    const origin = O,
      destination = D;
    const near = pin('near-stop', 700),
      farOut = pin('far-out', 8_000);
    const one = route('line-one', [
      grounded('access-one', origin, near, 400),
      subway('ride-one', near, alight, 400),
      grounded('egress-one', alight, destination, 1_800),
    ]);
    const two = route('line-two', [
      grounded('access-two', origin, board, 1_800),
      subway('ride-two', board, farOut, 400),
      grounded('egress-two', farOut, destination, 300),
    ]);
    const log: Log[] = [];
    await buildMixedModeBridges(
      { origin, destination, preferences: { ...preferences, allowTaxi: false } },
      [one, two],
      { provider: fixtureProvider(log, { free: true }), budget: new CallBudget(), now: NOW },
    );
    return log.filter(
      (entry) => entry.kind === 'walk' && entry.from.id === alight.id && entry.to.id === board.id,
    ).length;
  };
  assert.equal(await ask('광화문역 1호선'), 1, 'another station is a real transfer by street');
  assert.equal(
    await ask('시청역 1호선'),
    0,
    'the same station is joined by its own transfer, not by an outdoor walk',
  );
  assert.equal(await ask('시청'), 0);
});

type Pair = Parameters<typeof rentalSlotAvailable>[2];
const rentalPair = (index: number, continuation?: 'first' | 'last' | 'both'): Pair => ({
  from: pin(`from-${index}`, 100 + index),
  to: pin(`to-${index}`, 1_000 + index),
  priority: 0,
  ...(continuation ? { continuation } : {}),
});

test('a full set of plain rentals leaves the transit continuations their own slots', () => {
  const plain = new Set(
    Array.from(
      { length: 8 },
      (_, index) =>
        `${pin(`from-${index}`, 100 + index).latitude.toFixed(6)},${pin(`from-${index}`, 100 + index).longitude.toFixed(6)}>${pin(`to-${index}`, 1_000 + index).latitude.toFixed(6)},${pin(`to-${index}`, 1_000 + index).longitude.toFixed(6)}`,
    ),
  );
  const none = new Set<string>();
  assert.equal(
    rentalSlotAvailable(plain, none, rentalPair(20)),
    false,
    'a ninth plain rental is still refused',
  );
  assert.equal(
    rentalSlotAvailable(plain, none, rentalPair(21, 'last')),
    true,
    'a continuation is not',
  );
  const filled = new Set(Array.from({ length: 4 }, (_, index) => `c${index}`));
  assert.equal(
    rentalSlotAvailable(new Set([...plain, ...filled]), filled, rentalPair(22, 'first')),
    false,
    'continuations are bounded too',
  );
  assert.equal(
    rentalSlotAvailable(new Set([...plain, ...filled]), filled, rentalPair(3)),
    true,
    'a plain pair already connected may connect again from other docks',
  );
});

test('plain rentals ranked before them cannot push every continuation past the inspection limit', () => {
  const ranked = [
    ...Array.from({ length: 40 }, (_, index) => rentalPair(index)),
    ...Array.from({ length: 5 }, (_, index) =>
      rentalPair(100 + index, index % 2 ? 'first' : 'last'),
    ),
  ];
  const inspected = inspectedRentalPairs(ranked, 'bicycle');
  assert.equal(inspected.length, 32);
  assert.equal(inspected.filter((pair) => pair.continuation).length, 4);
  assert.deepEqual(
    inspected.slice(0, 5).map((pair) => pair.from.id),
    ['from-0', 'from-1', 'from-2', 'from-3', 'from-4'],
    'the best plain pairs keep their rank',
  );
  const mixed = [
    ...Array.from({ length: 10 }, (_, index) => rentalPair(index)),
    rentalPair(50, 'both'),
    ...Array.from({ length: 30 }, (_, index) => rentalPair(60 + index)),
    rentalPair(200, 'last'),
    rentalPair(201, 'first'),
  ];
  const second = inspectedRentalPairs(mixed, 'bicycle');
  assert.equal(second.length, 32);
  assert.equal(
    second.filter((pair) => pair.continuation).length,
    3,
    'one was already inside, two more are added',
  );
  assert.deepEqual(
    inspectedRentalPairs(ranked.slice(0, 20), 'bicycle').map((pair) => pair.from.id),
    ranked.slice(0, 20).map((pair) => pair.from.id),
    'a short list is untouched',
  );
});

test('a taxi that was skipped does not turn "no rental route" into "search limited" for 따릉이', () => {
  const diagnostics: BridgeGenerationDiagnostics = {
    rentalCandidates: 4,
    rentalAttempts: 4,
    rentalConnections: 0,
    accessProbes: 0,
    accessImprovements: 0,
    accessProbeLimitReached: false,
    unavailableRentals: 4,
    providerFailures: 0,
    failures: [],
    budgetSkipped: 0,
    taxiSkippedBudget: 2,
    taxiSkippedWindow: 1,
    candidateLimitSkipped: 0,
    walkingPairChecks: 0,
    walkingCandidatePeak: 0,
    rentalLimitedByMode: { bicycle: 0, scooter: 0, ebike: 0 },
    returnBlockedByMode: { bicycle: 0, scooter: 0, ebike: 0 },
    limitReached: true,
  };
  const input = (value: BridgeGenerationDiagnostics) =>
    rentalAvailabilityForSearch({
      preferences: { ...DEFAULT_PREFERENCES, allowBicycle: true, bicycleReady: true },
      routes: [{ segments: [{ mode: 'walk' }] }],
      capabilities: {
        bicycleFeed: true,
        scooterFeed: false,
        ebikeFeed: false,
        bicycleRouter: true,
        scooterRouter: false,
        ebikeRouter: false,
        scooterRentalPolicy: false,
        ebikeRentalPolicy: false,
      },
      diagnostics: value,
    });
  assert.equal(
    input(diagnostics).bicycle.reason,
    'search-limited',
    'what the raw flag used to say',
  );
  assert.equal(input(rentalLimitDiagnostics(diagnostics)).bicycle.reason, 'no-route');
  const limited = (bicycle: number, scooter: number) =>
    rentalLimitDiagnostics({
      ...diagnostics,
      candidateLimitSkipped: bicycle + scooter,
      rentalLimitedByMode: { bicycle, scooter, ebike: 0 },
    });
  assert.equal(
    input(limited(3, 0)).bicycle.reason,
    'search-limited',
    'a rental that was really cut short still says so',
  );
  assert.equal(
    input(limited(0, 3)).bicycle.reason,
    'no-route',
    'omitted scooter devices say nothing about 따릉이',
  );
  assert.equal(
    input(rentalLimitDiagnostics({ ...diagnostics, accessProbeLimitReached: true })).bicycle.reason,
    'search-limited',
    'unprobed docks are the 따릉이 search cut short',
  );
});

// ---------------------------------------------------------------------------------------------------------------------------
// Second opinions only for detours, and the rental slots, inspection list and reservations wired through a whole search.

const detouredWalk = (request: RouteEndpoints, seconds = 500): BaseRoute[] => {
  const middle = {
    latitude: (request.origin.latitude + request.destination.latitude) / 2,
    longitude: (request.origin.longitude + request.destination.longitude) / 2 + 0.03,
  };
  const path = [request.origin, middle, request.destination].map((point) => ({
    latitude: point.latitude,
    longitude: point.longitude,
  }));
  const meters = Math.round(metersBetween(path[0], path[1]) + metersBetween(path[1], path[2]));
  const segment: BaseSegment = {
    ...grounded('foot', request.origin, request.destination, seconds),
    distanceMeters: meters,
    polyline: path,
  };
  return [
    {
      id: 'foot',
      title: 'foot',
      segments: [segment],
      transfers: 0,
      distanceMeters: meters,
      durationSeconds: { min: seconds, max: seconds },
    },
  ];
};

test('straight walks and failed lookups do not use up the second opinions that detours may ask for', async () => {
  const asked = async (shape: (index: number) => 'straight' | 'detour' | 'fail') => {
    let kakao = 0,
      own = 0;
    const pedestrian = {
      configured: true,
      unmetered: true as const,
      walking: async (request: RouteEndpoints) => {
        const kind = shape(own++);
        if (kind === 'fail')
          throw new ApiError('PROVIDER_UNAVAILABLE', '보행망 서버가 응답하지 않아요.', 503);
        return kind === 'detour'
          ? detouredWalk(request)
          : [route('foot', [grounded('foot', request.origin, request.destination, 900)])];
      },
    };
    const provider = withPedestrianRouting(
      {
        configured: true,
        searchPlaces: async () => [],
        transit: async () => [],
        walking: async (request) => {
          kakao++;
          return [route('kakao', [grounded('kakao', request.origin, request.destination, 900)])];
        },
      },
      pedestrian,
      { secondOpinion: () => true, secondOpinionLookups: 20 },
    );
    const budget = new CallBudget(72);
    for (let index = 0; index < 50; index++)
      await provider.walking(walkRequest(index), budget).catch(() => undefined);
    return kakao;
  };
  assert.equal(
    await asked((index) => (index < 30 ? 'straight' : 'detour')),
    20,
    'thirty straight walks first, then only twenty of the twenty detours may ask',
  );
  assert.equal(
    await asked((index) => (index < 25 ? 'fail' : 'detour')),
    25 + 20,
    'failed lookups fall back to Kakao without using the detour allowance',
  );
  assert.equal(await asked((index) => (index % 2 ? 'detour' : 'straight')), 20);
});

const spot = (id: string, north: number, east = 0): Place => ({
  id,
  name: id,
  address: '로컬 보행망 fixture',
  latitude: 37.55 + north / 111_195,
  longitude: 126.97 + east / 88_000,
});
const bicyclePreferences = {
  ...DEFAULT_PREFERENCES,
  preparationSeconds: 0,
  allowRunning: false,
  allowBicycle: true,
  bicycleReady: true,
  maxBicycleMeters: 3_000,
  allowTaxi: false,
  allowScooter: false,
};
/** A subway source that rides to a platform 1-2 km up the road and on to the destination: its first leg invites a bicycle plus a fresh transit query. */
const continuationSource = (index: number, platform: Place) =>
  route(`continuation-${index}`, [
    leg(`w1-${index}`, 'wait', O, O, 300),
    subway(`s1-${index}`, O, platform, 900),
    leg(`w2-${index}`, 'wait', platform, platform, 200),
    subway(`s2-${index}`, platform, D, 600),
  ]);
const continuationQueries =
  (platforms: Place[], asked: RouteEndpoints[]) =>
  async (endpoints: RouteEndpoints): Promise<BaseRoute[]> => {
    asked.push(endpoints);
    const near = platforms.reduce((best, platform) =>
      metersBetween(platform, endpoints.origin) < metersBetween(best, endpoints.origin)
        ? platform
        : best,
    );
    return [
      route('continuation', [
        grounded('back', endpoints.origin, near, 20),
        leg('next-wait', 'wait', near, near, 210),
        subway('next-subway', near, endpoints.destination, 600),
      ]),
    ];
  };
const distinctOrigins = (asked: RouteEndpoints[]) =>
  new Set(asked.map((endpoints) => endpoints.origin.id)).size;

test('a search asks for at most four transit continuations per mode, however many places invite one', async () => {
  const platforms = Array.from({ length: 9 }, (_, index) =>
    spot(`platform-${index}`, 1_000 + index * 150, index * 40),
  );
  const docks = [
    spot('hire', 20),
    ...platforms.map((platform, index) => spot(`drop-${index}`, 1_020 + index * 150, index * 40)),
  ];
  const budget = new CallBudget(72),
    asked: RouteEndpoints[] = [],
    diagnostics: BridgeGenerationDiagnostics[] = [];
  await buildMixedModeBridges(
    { origin: O, destination: D, preferences: bicyclePreferences },
    platforms.map((platform, index) => continuationSource(index, platform)),
    {
      provider: fixtureProvider([]),
      budget,
      now: NOW,
      mobility: stationFeed(docks),
      onDiagnostics: (value) => diagnostics.push(value),
      connectTransit: (endpoints) =>
        budget.run(() => continuationQueries(platforms, asked)(endpoints)),
    },
  );
  assert.equal(
    distinctOrigins(asked),
    4,
    [...new Set(asked.map((endpoints) => endpoints.origin.id))].join(),
  );
  assert.ok(diagnostics.at(-1)!.candidateLimitSkipped >= 1, 'the places left out are reported');
});

test('transit continuations ranked behind a full inspection list of plain rentals are still asked for', async () => {
  const ends = Array.from({ length: 34 }, (_, index) =>
    spot(
      `walk-end-${index}`,
      1_200 + Math.floor(index / 10) * 150 + index * 7,
      800 + (index % 10) * 120,
    ),
  );
  const plain = ends.map((end, index) =>
    route(`plain-${index}`, [
      grounded(`walk-${index}`, O, end, 900),
      subway(`ride-${index}`, end, D, 600),
    ]),
  );
  const platforms = [spot('platform-a', 1_500, -700), spot('platform-b', 1_650, -740)];
  const docks = [
    spot('hire', 20),
    ...platforms.map((platform, index) =>
      spot(`drop-${index}`, 1_520 + index * 150, -700 - index * 40),
    ),
  ];
  const budget = new CallBudget(96),
    asked: RouteEndpoints[] = [],
    diagnostics: BridgeGenerationDiagnostics[] = [];
  await buildMixedModeBridges(
    { origin: O, destination: D, preferences: bicyclePreferences },
    [...plain, ...platforms.map((platform, index) => continuationSource(index, platform))],
    {
      provider: fixtureProvider([]),
      budget,
      now: NOW,
      mobility: stationFeed(docks),
      onDiagnostics: (value) => diagnostics.push(value),
      connectTransit: (endpoints) =>
        budget.run(() => continuationQueries(platforms, asked)(endpoints)),
    },
  );
  assert.equal(
    diagnostics.at(-1)!.rentalCandidates,
    36,
    '34 plain walk gaps and 2 continuation places',
  );
  assert.equal(distinctOrigins(asked), 2, 'both continuations took one of the 32 inspected places');
});

test('the first transit continuations keep the calls they need when early taxis and transfer walks could take them', async () => {
  // Along a west-east road: the trip, a station with a verified access walk (taxi and transfer targets), and four places that invite a bicycle plus a fresh transit query.
  const road = (id: string, east: number, north = 0): Place => ({
    id,
    name: id,
    address: '',
    latitude: Number((37.55 + north / 111_195).toFixed(8)),
    longitude: Number((126.97 + east / 88_000).toFixed(8)),
  });
  const from = road('origin', 0),
    to = road('destination', 11_000),
    station = road('station', 1_500),
    exit = road('exit', 9_000);
  const platforms = Array.from({ length: 4 }, (_, index) =>
    road(`platform-${index}`, 1_000 + index * 150, -400 - index * 40),
  );
  const stationSource = route('station-source', [
    grounded('access', from, station, 1_100),
    leg('wait', 'wait', station, station, 200),
    subway('ride', station, exit, 900),
    grounded('egress', exit, to, 500),
  ]);
  const sources = [
    stationSource,
    ...platforms.map((platform, index) =>
      route(`continuation-${index}`, [
        leg(`w1-${index}`, 'wait', from, from, 300),
        subway(`s1-${index}`, from, platform, 900),
        leg(`w2-${index}`, 'wait', platform, platform, 200),
        subway(`s2-${index}`, platform, to, 600),
      ]),
    ),
  ];
  const docks = [
    road('hire', 20),
    road('drop-station', 1_520),
    ...platforms.map((platform, index) =>
      road(`drop-${index}`, 1_020 + index * 150, -400 - index * 40),
    ),
  ];
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async (request, budget) =>
      budget.run(() => [
        route('foot', [grounded('foot', request.origin, request.destination, 20)]),
      ]),
    bicycle: async (request, budget) =>
      budget.run(() => [
        route('bike', [
          {
            ...leg('bike', 'bicycle', request.origin, request.destination, 100),
            routingProfile: 'bicycle' as const,
          },
        ]),
      ]),
    driving: async (request, budget) =>
      budget.run(() => ({
        distanceMeters: metersBetween(request.origin, request.destination),
        durationSeconds: 300,
        polyline: [request.origin, request.destination],
        maneuvers: [],
        traffic: [],
        taxiFareWon: 8_000,
      })),
  };
  const asked: RouteEndpoints[] = [],
    budget = new CallBudget(14);
  await buildMixedModeBridges(
    { origin: from, destination: to, preferences: { ...bicyclePreferences, allowTaxi: true } },
    sources,
    {
      provider,
      budget,
      now: NOW,
      mobility: stationFeed(docks),
      connectTransit: (endpoints) =>
        budget.run(() => continuationQueries(platforms, asked)(endpoints)),
    },
  );
  assert.ok(
    distinctOrigins(asked) >= 3,
    `only ${distinctOrigins(asked)} continuation queries fitted in 14 calls`,
  );
});

test('every kind trades its last inspected places for one-sided continuations; only a bicycle keeps two-sided ones', () => {
  const ranked = [
    ...Array.from({ length: 40 }, (_, index) => rentalPair(index)),
    rentalPair(100, 'first'),
    rentalPair(101, 'last'),
    rentalPair(102, 'both'),
  ];
  const scooter = inspectedRentalPairs(ranked, 'scooter');
  assert.equal(scooter.length, 32);
  assert.deepEqual(
    scooter.filter((pair) => pair.continuation).map((pair) => pair.continuation),
    ['first', 'last'],
  );
  const bicycle = inspectedRentalPairs(ranked, 'bicycle');
  assert.equal(bicycle.length, 32);
  assert.equal(bicycle.filter((pair) => pair.continuation).length, 3);
});

test('two-sided pairs take no dockless inspection place, so plain rentals keep theirs', () => {
  const ranked = [
    ...Array.from({ length: 3 }, (_, index) => rentalPair(200 + index, 'both')),
    rentalPair(300, 'first'),
    ...Array.from({ length: 28 }, (_, index) => rentalPair(index)),
    rentalPair(301, 'first'),
    rentalPair(302, 'last'),
    rentalPair(303, 'first'),
    ...Array.from({ length: 10 }, (_, index) => rentalPair(40 + index)),
  ];
  const ebike = inspectedRentalPairs(ranked, 'ebike');
  assert.equal(ebike.length, 32);
  assert.ok(ebike.every((pair) => pair.continuation !== 'both'));
  assert.equal(ebike.filter((pair) => !pair.continuation).length, 28);
  assert.equal(ebike.filter((pair) => pair.continuation).length, 4);
  assert.equal(
    inspectedRentalPairs(ranked, 'bicycle').filter((pair) => pair.continuation === 'both').length,
    3,
  );
});
