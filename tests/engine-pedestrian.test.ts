// Preserved regression cases from perception-map/mvp/tests/pedestrian.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PedestrianRouter } from '../src/common/engine/connectivity/pedestrian.js';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import type { RouteEndpoints } from '../src/common/engine/kakao.js';
import { withPedestrianRouting } from '../src/common/engine/connectivity/provider.js';
import {
  routeQueryIsReusable,
  withRouteQueryReuse,
} from '../src/common/engine/connectivity/query-reuse.js';
import { SearchProfiler, profileRouteProvider } from '../src/common/engine/search-performance.js';
import { enrichTransitRoutes } from '../src/common/engine/transit-enrichment.js';
import type { BaseRoute } from '../src/common/shared/domain/types.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';

const NOW = Date.UTC(2026, 9, 15, 6);

const request: RouteEndpoints = {
  origin: {
    id: 'origin',
    name: '서울역',
    address: '',
    latitude: 37.5547,
    longitude: 126.9707,
  },
  destination: {
    id: 'destination',
    name: '서울시청',
    address: '',
    latitude: 37.5663,
    longitude: 126.9779,
  },
};

const START = [126.9707, 37.5548],
  MIDDLE = [126.974, 37.56],
  END = [126.9779, 37.5662];

const fixture = () => ({
  code: 'Ok',
  data_version: '2026-10-14T00:00:00Z',
  waypoints: [
    {
      distance: 10,
      location: [...START],
      name: '',
    },
    {
      distance: 10,
      location: [...END],
      name: '',
    },
  ],
  routes: [
    {
      distance: 1500.2,
      duration: 1234.4,
      geometry: {
        type: 'LineString',
        coordinates: [[...START], [...MIDDLE], [...END]],
      },
      legs: [
        {
          distance: 1500.2,
          duration: 1234.4,
          steps: [
            {
              mode: 'walking',
              name: '서울역광장',
              distance: 700,
              duration: 700,
              geometry: {
                type: 'LineString',
                coordinates: [[...START], [...MIDDLE]],
              },
              maneuver: {
                type: 'depart',
                location: [...START],
              },
            },
            {
              mode: 'walking',
              name: '세종대로',
              distance: 800.2,
              duration: 534.4,
              geometry: {
                type: 'LineString',
                coordinates: [[...MIDDLE], [...END]],
              },
              maneuver: {
                type: 'turn',
                modifier: 'left',
                location: [...MIDDLE],
              },
            },
            {
              mode: 'walking',
              name: '',
              distance: 0,
              duration: 0,
              geometry: {
                type: 'LineString',
                coordinates: [[...END], [...END]],
              },
              maneuver: {
                type: 'arrive',
                location: [...END],
              },
            },
          ],
        },
      ],
    },
  ],
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });

const ownEndpoint = 'https://foot.my-service.co.kr/route/v1/foot';

const noDelay = async () => {};

const code = (expected: ApiError['code']) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return {
    promise,
    resolve,
  };
};

const alternativesFixture = () => {
  const payload = fixture();

  for (const { duration, midpoint } of [
    {
      duration: 1000,
      midpoint: [126.975, 37.5595],
    },
    {
      duration: 1100,
      midpoint: [126.9745, 37.561],
    },
  ]) {
    const alternative = structuredClone(payload.routes[0]);

    alternative.duration = duration;
    alternative.legs[0].duration = duration;
    alternative.geometry.coordinates[1] = midpoint;
    alternative.legs[0].steps[0].duration = duration / 2;
    alternative.legs[0].steps[0].geometry.coordinates[1] = midpoint;
    alternative.legs[0].steps[1].duration = duration / 2;
    alternative.legs[0].steps[1].geometry.coordinates[0] = midpoint;
    alternative.legs[0].steps[1].maneuver.location = midpoint;

    payload.routes.push(alternative);
  }

  return payload;
};

test('a faster second pedestrian alternative reaches journey comparison and survives shared lookups and cache reuse at one HTTP cost', async () => {
  const response = deferred<void>();
  let calls = 0,
    now = NOW;
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => now,
    fetcher: async (input) => {
      calls++;

      const alternatives = Number(new URL(String(input)).searchParams.get('alternatives'));
      const payload = alternativesFixture();

      // The external source only returns the requested alternatives.
      if (alternatives < 1 || !Number.isFinite(alternatives)) {
        payload.routes = payload.routes.slice(0, 1);
      } else if (!Number.isInteger(alternatives) || alternatives > 2) {
        throw new Error('request exceeds the bounded three-route comparison');
      } else {
        payload.routes = payload.routes.slice(0, alternatives + 1);
      }

      await response.promise;

      return reply(payload);
    },
  });
  const firstBudget = new CallBudget(1),
    sharedBudget = new CallBudget(1);
  const first = router.walking(request, firstBudget),
    shared = router.walking(request, sharedBudget);

  response.resolve();

  const [routes, sharedRoutes] = await Promise.all([first, shared]);

  const planned = planJourneyGraph(
    {
      ...request,
      now: NOW,
      deadline: NOW + 3600_000,
      preferences: {
        ...DEFAULT_PREFERENCES,
        allowRunning: false,
        preparationSeconds: 0,
      },
    },
    routes,
    {
      receivedAt: NOW,
      maxResults: 1,
    },
  );

  assert.deepEqual(
    planned.routes[0]?.durationSeconds,
    {
      min: 1000,
      max: 1023,
    },
    'source recommendation order must not suppress a faster valid foot path',
  );
  assert.deepEqual(
    planned.routes[0].segments[0].polyline,
    alternativesFixture().routes[1].geometry.coordinates.map(([longitude, latitude]) => ({
      longitude,
      latitude,
    })),
  );
  assert.deepEqual(
    routes.map((route) => route.durationSeconds),
    [
      {
        min: 1235,
        max: 1258,
      },
      {
        min: 1000,
        max: 1023,
      },
      {
        min: 1100,
        max: 1123,
      },
    ],
    'all three valid source paths remain available to downstream comparisons',
  );
  assert.equal(
    new Set(routes.map((route) => route.id)).size,
    3,
    'different alternatives must not overwrite each other in consumers keyed by route ID',
  );
  assert.deepEqual(sharedRoutes, routes);

  routes[1].segments[0].polyline![1].latitude = 0;
  routes[1].segments[0].routingSource!.receivedAt = 0;

  assert.equal(
    sharedRoutes[1].segments[0].polyline![1].latitude,
    37.5595,
    'coalesced callers own independent route data',
  );

  now += 120_000;

  const cacheBudget = new CallBudget(1);

  const cached = await router.walking(
    {
      origin: {
        ...request.origin,
        name: '현재 위치',
      },
      destination: {
        ...request.destination,
        name: '약속 장소',
      },
    },
    cacheBudget,
  );

  assert.deepEqual(
    cached.map((route) => route.id),
    sharedRoutes.map((route) => route.id),
  );

  for (const route of cached) {
    assert.equal(route.segments[0].start.name, '현재 위치');
    assert.equal(route.segments[0].end.name, '약속 장소');
    assert.equal(route.segments[0].routingSource?.receivedAt, NOW);
    assert.equal(route.segments[0].routingSource?.provider, 'osrm-foot');
  }

  assert.equal(cached[1].segments[0].polyline![1].latitude, 37.5595);
  assert.equal(calls, 1);
  assert.equal(firstBudget.used, 1);
  assert.equal(sharedBudget.used, 0);
  assert.equal(cacheBudget.used, 0);
});

test('a malformed or disconnected pedestrian alternative cannot poison its valid sibling or be repaired into a fabricated route', async () => {
  let validId: string | undefined;

  for (const corruption of ['unsupported-mode', 'step-gap', 'endpoint-drift'] as const) {
    for (const invalidFirst of [true, false]) {
      const payload = alternativesFixture(),
        broken = payload.routes[0],
        valid = payload.routes[1];

      if (corruption === 'unsupported-mode') {
        broken.legs[0].steps[0].mode = 'driving';
      }

      if (corruption === 'step-gap') {
        broken.legs[0].steps[1].geometry.coordinates[0][1] += 0.000004;
      }

      if (corruption === 'endpoint-drift') {
        broken.geometry.coordinates[0][1] += 0.00001;
      }

      payload.routes = invalidFirst
        ? [broken, valid, structuredClone(valid)]
        : [valid, broken, structuredClone(valid)];

      const router = new PedestrianRouter({
        endpoint: ownEndpoint,
        now: () => NOW,
        fetcher: async () => reply(payload),
      });

      const routes = await router.walking(request, new CallBudget(1));

      validId ??= routes[0].id;

      assert.equal(
        routes[0].id,
        validId,
        'a valid alternative retains its identity when invalid siblings change or move',
      );
      assert.deepEqual(
        routes.map((route) => route.durationSeconds),
        [
          {
            min: 1000,
            max: 1023,
          },
        ],
        `${corruption}, invalid first: ${invalidFirst}; duplicates cannot occupy additional candidate slots`,
      );
      assert.deepEqual(
        routes[0].segments[0].polyline,
        valid.geometry.coordinates.map(([longitude, latitude]) => ({
          longitude,
          latitude,
        })),
      );

      payload.routes = [broken];

      await assert.rejects(
        new PedestrianRouter({
          endpoint: ownEndpoint,
          now: () => NOW,
          fetcher: async () => reply(payload),
        }).walking(request, new CallBudget(1)),
        code('PROVIDER_RESPONSE'),
      );
    }
  }
});

test('the captured Seoul response preserves all 39 source path points despite its 0.37-meter waypoint and maneuver discrepancy', async () => {
  // Captured 2026-10-16 from the FOSSGIS public foot endpoint for fixed public
  // stations. Only unused hints/intersections are removed from the fixture.
  const payload = JSON.parse(
    readFileSync(
      new URL('./fixtures/engine-osrm-foot-gangnam-seolleung.json', import.meta.url),
      'utf8',
    ),
  );
  const endpoints = {
    origin: {
      id: 'public-gangnam',
      name: '강남역',
      address: '',
      latitude: 37.49795,
      longitude: 127.027636,
    },
    destination: {
      id: 'public-seolleung',
      name: '선릉역',
      address: '',
      latitude: 37.504488,
      longitude: 127.048957,
    },
  };
  const budget = new CallBudget(1);

  const [route] = await new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    fetcher: async () => reply(payload),
  }).walking(endpoints, budget);

  assert.deepEqual(
    route.segments[0].polyline,
    payload.routes[0].geometry.coordinates.map(([longitude, latitude]: number[]) => ({
      longitude,
      latitude,
    })),
    'no synthetic connector or replacement geometry is introduced',
  );
  assert.deepEqual(
    route.durationSeconds,
    {
      min: 1660,
      max: 1672,
    },
    '1659.7 s source duration plus the independently measured 12 s snap allowance',
  );
  assert.equal(route.distanceMeters, 2075);
  assert.deepEqual(
    [route.segments[0].start.longitude, route.segments[0].start.latitude],
    payload.routes[0].geometry.coordinates[0],
  );
  assert.notDeepEqual(
    payload.waypoints[0].location,
    payload.routes[0].geometry.coordinates[0],
    'this fixture protects the observed strict-equality failure',
  );
  assert.equal(route.segments[0].maneuvers?.length, 7);
  assert.equal(budget.used, 1);
});

test('source-position tolerance cannot admit a disconnected step, over-one-meter drift, or geometry beyond the existing snap limit', async () => {
  for (const kind of ['waypoint', 'maneuver', 'step-join', 'actual-snap'] as const) {
    const payload = fixture();
    let endpoints = request;

    if (kind === 'waypoint') {
      payload.waypoints[0].location[1] += 0.00001;
    } // 1.11 m

    if (kind === 'maneuver') {
      payload.routes[0].legs[0].steps[0].maneuver.location[1] += 0.00001;
    }

    if (kind === 'step-join') {
      payload.routes[0].legs[0].steps[1].geometry.coordinates[0][1] += 0.000004;
    } // Even 0.44 m cannot join disconnected paths.

    if (kind === 'actual-snap') {
      payload.waypoints[0].location[1] -= 0.000008;
      payload.waypoints[0].distance = 0;
      endpoints = {
        ...request,
        origin: {
          ...request.origin,
          latitude: START[1] - ((75.1 / 6_371_000) * 180) / Math.PI,
        },
      };
    }

    await assert.rejects(
      new PedestrianRouter({
        endpoint: ownEndpoint,
        now: () => NOW,
        fetcher: async () => reply(payload),
      }).walking(endpoints, new CallBudget()),
      code(kind === 'actual-snap' ? 'NO_ROUTES' : 'PROVIDER_RESPONSE'),
    );
  }
});

test('dedicated foot routing preserves actual geometry and exposes included snap uncertainty with its actual source', async () => {
  let sentUrl: URL | undefined, sentInit: RequestInit | undefined;
  const router = new PedestrianRouter({
    now: () => NOW,
    throttle: noDelay,
    fetcher: async (url, init) => {
      sentUrl = new URL(String(url));
      sentInit = init;

      return reply(fixture());
    },
  });
  const budget = new CallBudget();

  const [route] = await router.walking(request, budget);

  assert.equal(router.configured, true);
  assert.equal(sentUrl?.origin, 'https://routing.openstreetmap.de');
  assert.match(sentUrl!.pathname, /^\/routed-foot\/route\/v1\/foot\//);
  assert.deepEqual(
    sentUrl!.pathname
      .split('/')
      .at(-1)!
      .split(';')
      .map((coordinate) => coordinate.split(',').map(Number)),
    [
      [126.9707, 37.5547],
      [126.9779, 37.5663],
    ],
    'the service receives longitude then latitude for both selected endpoints',
  );
  assert.equal(sentUrl?.searchParams.get('geometries'), 'geojson');
  assert.equal(sentUrl?.searchParams.get('overview'), 'full');
  assert.equal(sentUrl?.searchParams.get('steps'), 'true');
  assert.equal(sentUrl?.searchParams.get('radiuses'), '75;75');
  assert.equal(sentInit?.redirect, 'error');
  assert.match(new Headers(sentInit?.headers).get('User-Agent')!, /Jigakjido/);
  assert.equal(new Headers(sentInit?.headers).has('Authorization'), false);
  assert.equal(budget.used, 1);
  assert.deepEqual(
    route.durationSeconds,
    {
      min: 1235,
      max: 1258,
    },
    'the two ≈11.12 m network snaps add one 23-second planning allowance only to the slow bound',
  );
  assert.equal(route.distanceMeters, 1501);
  assert.deepEqual(route.segments[0].polyline, [
    {
      longitude: START[0],
      latitude: START[1],
    },
    {
      longitude: MIDDLE[0],
      latitude: MIDDLE[1],
    },
    {
      longitude: END[0],
      latitude: END[1],
    },
  ]);
  assert.equal(route.segments[0].start.latitude, START[1]);
  assert.equal(route.segments[0].end.latitude, END[1]);
  assert.equal(route.segments[0].runAllowed, false);
  assert.equal(route.segments[0].networkSnap?.allowanceSeconds, 23);
  assert.match(route.segments[0].routingSource!.label, /FOSSGIS/);

  const { label: _label, ...source } = route.segments[0].routingSource!;

  assert.deepEqual(source, {
    mode: 'live',
    provider: 'osrm-foot',
    sourceTimestamp: Date.UTC(2026, 9, 14),
    receivedAt: NOW,
    isRealtime: false,
  });
  assert.ok(
    route.segments[0].maneuvers?.some(
      (maneuver) => maneuver.latitude === MIDDLE[1] && /왼쪽/.test(maneuver.instruction),
    ),
  );
});

test('unsupported modes, malformed WGS84 and disconnected or invented geometry cannot create a walking recommendation', async () => {
  const mutate: ((body: ReturnType<typeof fixture>) => void)[] = [
    (body) => {
      body.routes[0].legs[0].steps[0].mode = 'driving';
    },
    (body) => {
      body.routes[0].legs[0].steps[0].mode = 'cycling';
    },
    (body) => {
      body.routes[0].geometry.coordinates[0][1] = 91;
    },
    (body) => {
      body.waypoints[0].location[0] = 181;
    },
    (body) => {
      body.routes[0].legs[0].steps[1].geometry.coordinates[0][0] += 0.001;
    },
    (body) => {
      body.routes[0].geometry.coordinates.splice(1, 1);
    },
    (body) => {
      body.routes[0].legs[0].steps[0].geometry.coordinates = [[...START], [...START]];
    },
    (body) => {
      body.routes[0].legs[0].steps[0].maneuver.location = [...END];
    },
    (body) => {
      body.routes[0].duration = Infinity;
    },
    (body) => {
      body.routes[0].duration = 0;
    },
    (body) => {
      body.routes[0].duration = 1;
    },
    (body) => {
      body.routes[0].distance = 1;
    },
  ];

  for (const mutation of mutate) {
    const payload = fixture();

    mutation(payload);

    const budget = new CallBudget();

    await assert.rejects(
      new PedestrianRouter({
        endpoint: ownEndpoint,
        now: () => NOW,
        fetcher: async () => reply(payload),
      }).walking(request, budget),
      code('PROVIDER_RESPONSE'),
    );
    assert.equal(budget.used, 1);
  }
});

test('both reported and independently measured endpoint gaps enforce the existing 75-meter limit', async () => {
  for (const kind of ['reported', 'measured'] as const) {
    const payload = fixture();

    if (kind === 'reported') {
      payload.waypoints[0].distance = 76;
    } else {
      const moved = [START[0], 37.5555];

      payload.waypoints[0].distance = 0;
      payload.waypoints[0].location = moved;
      payload.routes[0].geometry.coordinates[0] = moved;
      payload.routes[0].legs[0].steps[0].geometry.coordinates[0] = moved;
      payload.routes[0].legs[0].steps[0].maneuver.location = moved;
    }

    await assert.rejects(
      new PedestrianRouter({
        endpoint: ownEndpoint,
        now: () => NOW,
        fetcher: async () => reply(payload),
      }).walking(request, new CallBudget()),
      code('NO_ROUTES'),
    );
  }
});

test('consistent provider totals cannot erase the physical distance of their complete walking geometry', async () => {
  const payload = fixture();

  payload.routes[0].distance = 0.1;
  payload.routes[0].duration = 0.1;
  payload.routes[0].legs[0].distance = 0.1;
  payload.routes[0].legs[0].duration = 0.1;

  for (const step of payload.routes[0].legs[0].steps) {
    step.distance = 0;
    step.duration = 0;
  }

  payload.routes[0].legs[0].steps[0].distance = 0.1;
  payload.routes[0].legs[0].steps[0].duration = 0.1;

  const budget = new CallBudget();

  await assert.rejects(
    new PedestrianRouter({
      endpoint: ownEndpoint,
      now: () => NOW,
      fetcher: async () => reply(payload),
    }).walking(request, budget),
    code('PROVIDER_RESPONSE'),
  );
  assert.equal(budget.used, 1);
});

test('small distance rounding is accepted without inventing additional walking time or geometry', async () => {
  const payload = fixture();

  // Independently measured fixture geometry is approximately 1417.623 m.
  payload.routes[0].distance = 1417.6;
  payload.routes[0].legs[0].distance = 1417.6;
  payload.routes[0].legs[0].steps[0].distance = 647.4;
  payload.routes[0].legs[0].steps[1].distance = 770.2;

  const [route] = await new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    fetcher: async () => reply(payload),
  }).walking(request, new CallBudget());

  assert.equal(route.distanceMeters, 1418);
  assert.deepEqual(route.durationSeconds, {
    min: 1235,
    max: 1258,
  });
  assert.equal(route.segments[0].polyline!.length, 3);
});

test('missing invalid or future map-version timestamps remain explicitly unknown', async () => {
  for (const version of [undefined, 'invalid', '2026-02-31T00:00:00Z', '2026-10-16T00:00:00Z']) {
    const payload = fixture();

    if (version === undefined) {
      delete (payload as Partial<typeof payload>).data_version;
    } else {
      payload.data_version = version;
    }

    const [route] = await new PedestrianRouter({
      endpoint: ownEndpoint,
      now: () => NOW,
      fetcher: async () => reply(payload),
    }).walking(request, new CallBudget());

    assert.equal(route.segments[0].routingSource?.sourceTimestamp, null);
    assert.equal(route.segments[0].routingSource?.isRealtime, false);
  }
});

test('cache hits preserve observation receipt time and return immutable caller-specific labels without spending a call', async () => {
  let now = NOW,
    calls = 0;
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => now,
    fetcher: async () => {
      calls++;

      return reply(fixture());
    },
  });

  const firstBudget = new CallBudget(),
    [first] = await router.walking(request, firstBudget);

  assert.match(first.segments[0].routingSource!.label, /OSRM/);
  assert.doesNotMatch(
    first.segments[0].routingSource!.label,
    /FOSSGIS/,
    'a separately hosted service must not be credited as a FOSSGIS request',
  );

  first.segments[0].polyline![0].latitude = 0;
  now += 120_000;

  const secondBudget = new CallBudget(),
    [second] = await router.walking(
      {
        origin: {
          ...request.origin,
          name: '현재 위치',
        },
        destination: {
          ...request.destination,
          name: '약속 장소',
        },
      },
      secondBudget,
    );

  assert.equal(calls, 1);
  assert.equal(firstBudget.used, 1);
  assert.equal(secondBudget.used, 0);
  assert.equal(second.segments[0].polyline![0].latitude, START[1]);
  assert.equal(second.segments[0].start.name, '현재 위치');
  assert.equal(second.segments[0].end.name, '약속 장소');
  assert.equal(second.segments[0].routingSource?.receivedAt, NOW);

  now = NOW + 300_001;

  const thirdBudget = new CallBudget(),
    [third] = await router.walking(request, thirdBudget);

  assert.equal(calls, 2);
  assert.equal(thirdBudget.used, 1);
  assert.equal(third.segments[0].routingSource?.receivedAt, now);
});

test('in-flight identical coordinate lookups share the actual HTTP attempt and its original source receipt', async () => {
  const response = deferred<Response>();
  let calls = 0;
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    fetcher: async () => {
      calls++;

      return response.promise;
    },
  });
  const firstBudget = new CallBudget(),
    secondBudget = new CallBudget();
  const first = router.walking(request, firstBudget),
    second = router.walking(request, secondBudget);

  response.resolve(reply(fixture()));

  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstBudget.used, 1);
  assert.equal(secondBudget.used, 0);
  assert.deepEqual(a, b);
});

test('a fresh pedestrian source cache completes transit access in a new profiled search with no call slots, but expiry does not invent a connection', async () => {
  // A source cache hit previously looked like a new call to the acquisition
  // budget gates, so a verified access path was discarded at maxAccessCalls=0.
  let calls = 0,
    now = NOW;
  const foot = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => now,
    fetcher: async () => {
      calls++;

      return reply(fixture());
    },
  });

  await foot.walking(request, new CallBudget());

  const destination = {
    ...request.destination,
    id: 'last-stop',
    name: '다음 정류장',
    latitude: request.destination.latitude + 0.01,
  };
  const train: BaseRoute = {
    id: 'train',
    title: '2호선',
    transfers: 0,
    distanceMeters: 1200,
    durationSeconds: {
      min: 300,
      max: 300,
    },
    segments: [
      {
        id: 'ride',
        mode: 'subway',
        title: '2호선',
        instructions: '다음 역까지 이동',
        start: request.destination,
        end: destination,
        distanceMeters: 1200,
        durationSeconds: {
          min: 300,
          max: 300,
        },
        runAllowed: false,
        polyline: [request.destination, destination],
        transit: {
          lines: ['2호선'],
          stops: [request.destination.name, destination.name],
        },
      },
    ],
  };
  const source = withPedestrianRouting(
    {
      configured: false,
      searchPlaces: async () => [],
      transit: async () => [],
      walking: async () => {
        throw new Error('unexpected fallback');
      },
    },
    foot,
  );
  const budget = new CallBudget(1);

  await budget.run(() => null);

  const freshSearch = () => withRouteQueryReuse(profileRouteProvider(source, new SearchProfiler()));

  const renamedOrigin = {
    ...request.origin,
    name: '현재 위치',
  };

  const [result] = await enrichTransitRoutes(
    [train],
    {
      origin: renamedOrigin,
      destination,
    },
    {
      provider: freshSearch(),
      budget,
      maxAccessCalls: 0,
      now,
    },
  );

  const access = result.segments[0];

  assert.deepEqual(access.durationSeconds, {
    min: 1235,
    max: 1258,
  });
  assert.deepEqual(
    access.polyline,
    [START, MIDDLE, END].map(([longitude, latitude]) => ({
      longitude,
      latitude,
    })),
  );
  assert.equal(access.start.name, '현재 위치');
  assert.equal(
    access.routingSource?.receivedAt,
    NOW,
    'reading the source cache never refreshes its observation time',
  );
  assert.equal(calls, 1);
  assert.equal(
    budget.used,
    1,
    'the new search retains its exhausted budget and spends no hidden request',
  );

  now += 300_001;

  const [expired] = await enrichTransitRoutes(
    [train],
    {
      origin: renamedOrigin,
      destination,
    },
    {
      provider: freshSearch(),
      budget,
      maxAccessCalls: 0,
      now,
    },
  );

  assert.equal(expired.segments[0].routingSource, undefined);
  assert.equal(
    expired.segments[0].polyline,
    undefined,
    'expired geometry must not pass the graph connection gate',
  );
  assert.equal(calls, 1);
});

test('another search cannot budget an unfinished pedestrian lookup as free when its fallback could require HTTP', async () => {
  const pendingResponse = deferred<Response>();
  let calls = 0;
  const foot = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    fetcher: async () => pendingResponse.promise,
  });
  const provider = withPedestrianRouting(
    {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      walking: (_request, budget) =>
        budget.run(() => {
          calls++;

          return [];
        }),
    },
    foot,
  );
  const ownerBudget = new CallBudget(2),
    owner = provider.walking(request, ownerBudget);
  const other = withRouteQueryReuse(provider),
    otherBudget = new CallBudget(1);

  assert.equal(routeQueryIsReusable(other, 'walking', request, otherBudget), false);

  pendingResponse.resolve(
    reply({
      code: 'NoRoute',
    }),
  );

  assert.deepEqual(await owner, []);
  assert.equal(ownerBudget.used, 2);
  assert.equal(calls, 1);
  assert.equal(
    routeQueryIsReusable(other, 'walking', request, otherBudget),
    false,
    'the failure is not a fresh completed walking route',
  );
});

test('the bounded cache evicts old coordinate entries instead of retaining an unbounded location history', async () => {
  let calls = 0;
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    now: () => NOW,
    fetcher: async () => {
      calls++;

      return reply(fixture());
    },
  });

  for (let index = 0; index < 65; index++) {
    await router.walking(
      {
        ...request,
        origin: {
          ...request.origin,
          latitude: request.origin.latitude + index * 0.0000001,
        },
      },
      new CallBudget(),
    );
  }

  await router.walking(request, new CallBudget());

  assert.equal(calls, 66, 'the first of 65 unique entries has left the 64-entry cache');
});

test('every failed actual attempt spends its shared budget and never retries beyond the search limit', async () => {
  let calls = 0;
  const budget = new CallBudget(1);
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    fetcher: async () => {
      calls++;

      return reply({
        code: 'NoRoute',
      });
    },
  });

  await assert.rejects(router.walking(request, budget), code('NO_ROUTES'));
  await assert.rejects(router.walking(request, budget), code('CALL_BUDGET_EXCEEDED'));
  assert.equal(calls, 1);
  assert.equal(budget.used, 1);
});

test('network and response-body waits time out even when an injected transport ignores cancellation', async () => {
  for (const stage of ['headers', 'body'] as const) {
    const late = deferred<Response>();
    const hangingBody = new Response(
      new ReadableStream<Uint8Array>({
        start() {},
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );
    const budget = new CallBudget();
    const router = new PedestrianRouter({
      endpoint: ownEndpoint,
      timeoutMs: 10,
      fetcher: async () => (stage === 'headers' ? late.promise : hangingBody),
    });

    await assert.rejects(router.walking(request, budget), code('PROVIDER_TIMEOUT'));
    assert.equal(budget.used, 1);

    late.resolve(reply(fixture()));
  }
});

test('a response arriving after an ignored transport abort still releases its unread body', async () => {
  const late = deferred<Response>();
  let cancellations = 0;
  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    timeoutMs: 10,
    fetcher: async () => late.promise,
  });

  await assert.rejects(router.walking(request, new CallBudget()), code('PROVIDER_TIMEOUT'));

  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  late.resolve(response);

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(cancellations, 1);
});

test('redirects, non-JSON responses and oversized streams never become routing data or leak provider bodies', async () => {
  for (const response of [
    new Response('private-provider-text', {
      status: 302,
      headers: {
        Location: 'https://other.example/',
      },
    }),
    new Response('private-provider-text', {
      headers: {
        'Content-Type': 'text/html',
      },
    }),
    new Response('x'.repeat(2_000_001), {
      headers: {
        'Content-Type': 'application/json',
      },
    }),
    new Response('{}', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2000001',
      },
    }),
  ]) {
    const router = new PedestrianRouter({
      endpoint: ownEndpoint,
      fetcher: async () => response,
    });

    await assert.rejects(
      router.walking(request, new CallBudget()),
      (error) => error instanceof ApiError && !error.message.includes('private-provider-text'),
    );
  }
});

test('unconsumed redirect, throttling, failure and invalid-content responses cancel their bodies', async () => {
  for (const kind of [
    'redirect',
    'redirected',
    'limit',
    'failure',
    'content-type',
    'content-length',
  ] as const) {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    });
    const response = new Response(stream, {
      status: kind === 'redirect' ? 302 : kind === 'limit' ? 429 : kind === 'failure' ? 503 : 200,
      headers: {
        'Content-Type': kind === 'content-type' ? 'text/html' : 'application/json',
        ...(kind === 'content-length'
          ? {
              'Content-Length': '2000001',
            }
          : {}),
      },
    });

    if (kind === 'redirected') {
      Object.defineProperty(response, 'redirected', {
        value: true,
      });
    }

    const router = new PedestrianRouter({
      endpoint: ownEndpoint,
      fetcher: async () => response,
    });

    await assert.rejects(
      router.walking(request, new CallBudget()),
      code(
        kind === 'limit'
          ? 'PROVIDER_LIMIT'
          : kind === 'failure'
            ? 'PROVIDER_UNAVAILABLE'
            : 'PROVIDER_RESPONSE',
      ),
    );
    assert.equal(cancellations, 1, `${kind} must release its unread response stream`);
    assert.equal(response.bodyUsed, true);
  }
});

test('public FOSSGIS HTTP starts are globally limited across separate router instances', async () => {
  const starts: number[] = [];

  const fetcher: typeof fetch = async () => {
    starts.push(Date.now());

    return reply(fixture());
  };

  const a = new PedestrianRouter({
      fetcher,
      timeoutMs: 4_000,
    }),
    b = new PedestrianRouter({
      fetcher,
      timeoutMs: 4_000,
    });

  await Promise.all([a.walking(request, new CallBudget()), b.walking(request, new CallBudget())]);

  assert.equal(starts.length, 2);
  assert.ok(
    starts[1] - starts[0] >= 990,
    'concurrent searches cannot each independently consume one public request per second',
  );
});

test('a slow public response permits one rate-spaced overlap but never a third active request and releases slots after errors', async () => {
  const first = deferred<Response>(),
    second = deferred<Response>(),
    secondStarted = deferred<void>();
  const starts: number[] = [];
  let active = 0,
    peak = 0;

  const fetcher: typeof fetch = async () => {
    starts.push(performance.now());

    active++;
    peak = Math.max(peak, active);

    const index = starts.length;

    try {
      if (index === 1) {
        return await first.promise;
      }

      if (index === 2) {
        secondStarted.resolve();

        return await second.promise;
      }

      return reply(fixture());
    } finally {
      active--;
    }
  };

  const routers = Array.from(
    {
      length: 3,
    },
    () =>
      new PedestrianRouter({
        fetcher,
        now: () => NOW,
        timeoutMs: 7_000,
      }),
  );
  const budgets = routers.map(() => new CallBudget(1));
  const pending = routers.map((router, index) => router.walking(request, budgets[index]));
  const result = Promise.allSettled(pending);
  const watchdog = setTimeout(() => {
    first.resolve(
      reply({
        code: 'NoRoute',
      }),
    );

    second.resolve(reply(fixture()));
  }, 5_000);

  try {
    await secondStarted.promise;

    assert.equal(
      active,
      2,
      'the next permitted request starts before the first slow response completes',
    );
    assert.equal(starts.length, 2);

    await new Promise<void>((resolve) => setTimeout(resolve, 1_050));

    assert.equal(
      starts.length,
      2,
      'the global two-request cap still holds after another start interval passes',
    );

    first.resolve(
      reply({
        code: 'NoRoute',
      }),
    );

    second.resolve(reply(fixture()));

    const outcomes = await result;

    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ['rejected', 'fulfilled', 'fulfilled'],
    );
    assert.equal(peak, 2);
    assert.ok(
      starts.slice(1).every((value, index) => value - starts[index] >= 990),
      'every HTTP start remains at least one second apart across all routers',
    );
    assert.ok(budgets.every((budget) => budget.used === 1));
  } finally {
    clearTimeout(watchdog);

    first.resolve(
      reply({
        code: 'NoRoute',
      }),
    );

    second.resolve(reply(fixture()));

    await result;
  }
});

test('a trailing-dot public FQDN keeps the same canonical endpoint, source and shared rate limit', async () => {
  const starts: number[] = [],
    urls: URL[] = [];

  const fetcher: typeof fetch = async (input) => {
    starts.push(Date.now());

    urls.push(new URL(String(input)));

    return reply(fixture());
  };

  const options = {
    endpoint: 'https://routing.openstreetmap.de./routed-foot/route/v1/foot',
    fetcher,
    timeoutMs: 4_000,
  };
  const a = new PedestrianRouter(options),
    b = new PedestrianRouter(options);

  const routes = await Promise.all([
    a.walking(request, new CallBudget()),
    b.walking(request, new CallBudget()),
  ]);

  assert.ok(
    starts[1] - starts[0] >= 990,
    'an equivalent public FQDN cannot bypass the module-wide request interval',
  );
  assert.ok(urls.every((url) => url.hostname === 'routing.openstreetmap.de'));
  assert.ok(routes.every(([route]) => /FOSSGIS/.test(route.segments[0].routingSource!.label)));

  for (const endpoint of [
    'http://routing.openstreetmap.de./routed-foot/route/v1/foot',
    'https://routing.openstreetmap.de./different-profile/route/v1/foot',
  ]) {
    assert.throws(
      () =>
        new PedestrianRouter({
          endpoint,
        }),
      code('INVALID_INPUT'),
    );
  }
});

test('queued public work respects its own timeout and spends nothing until its HTTP actually starts', async () => {
  const held = deferred<Response>(),
    entered = deferred<void>();
  let secondCalls = 0;
  const first = new PedestrianRouter({
    throttle: noDelay,
    timeoutMs: 500,
    fetcher: async () => {
      entered.resolve();

      return held.promise;
    },
  });
  const inProgress = first.walking(request, new CallBudget());

  await entered.promise;

  const secondBudget = new CallBudget();
  const second = new PedestrianRouter({
    timeoutMs: 10,
    fetcher: async () => {
      secondCalls++;

      return reply(fixture());
    },
  });

  await assert.rejects(second.walking(request, secondBudget), code('PROVIDER_TIMEOUT'));
  assert.equal(secondCalls, 0);
  assert.equal(secondBudget.used, 0);

  held.resolve(reply(fixture()));

  await inProgress;
});

test('consumer timeouts do not release physical public slots until ignored-abort transports and late bodies settle', async () => {
  const late = [deferred<Response>(), deferred<Response>()];
  let recoveredCalls = 0,
    physicalActive = 0,
    peak = 0;
  const stuck = late.map(
    (response) =>
      new PedestrianRouter({
        throttle: noDelay,
        timeoutMs: 20,
        fetcher: async () => {
          physicalActive++;
          peak = Math.max(peak, physicalActive);

          try {
            return await response.promise;
          } finally {
            physicalActive--;
          }
        },
      }),
  );
  const failures = stuck.map((router) => router.walking(request, new CallBudget()));
  const settled = Promise.allSettled(failures);
  const canceledBody = deferred<void>(),
    bodyCancelStarted = deferred<void>();

  const fetcher: typeof fetch = async () => {
    recoveredCalls++;
    physicalActive++;
    peak = Math.max(peak, physicalActive);
    physicalActive--;

    return reply(fixture());
  };

  try {
    for (const result of await settled) {
      assert.ok(result.status === 'rejected' && code('PROVIDER_TIMEOUT')(result.reason));
    }

    const refusedBudget = new CallBudget(1);

    await assert.rejects(
      new PedestrianRouter({
        throttle: noDelay,
        timeoutMs: 20,
        fetcher,
      }).walking(request, refusedBudget),
      code('PROVIDER_TIMEOUT'),
    );
    assert.equal(recoveredCalls, 0);
    assert.equal(
      refusedBudget.used,
      0,
      'two still-pending real fetches block a third HTTP attempt after caller deadlines',
    );

    late[0].resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelStarted.resolve();

            return canceledBody.promise;
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    await bodyCancelStarted.promise;

    const recovery = new PedestrianRouter({
      throttle: noDelay,
      timeoutMs: 1_000,
      now: () => NOW,
      fetcher,
    });
    const recovered = recovery.walking(request, new CallBudget(1));

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      recoveredCalls,
      0,
      'a late response body must finish cancellation before the slot is freed',
    );

    canceledBody.resolve();

    assert.equal((await recovered)[0].durationSeconds.min, 1235);
    assert.equal(recoveredCalls, 1);
    assert.equal(peak, 2);
  } finally {
    canceledBody.resolve();

    late[0].resolve(reply(fixture()));

    late[1].resolve(reply(fixture()));

    await settled;
  }
});

test('disabled adapters and invalid coordinates cannot call the service; custom endpoints must keep the foot profile', async () => {
  let calls = 0;
  const budget = new CallBudget();
  const disabled = new PedestrianRouter({
    enabled: false,
    fetcher: async () => {
      calls++;

      return reply(fixture());
    },
  });

  assert.equal(disabled.configured, false);
  await assert.rejects(disabled.walking(request, budget), code('LIVE_NOT_CONFIGURED'));

  const router = new PedestrianRouter({
    endpoint: ownEndpoint,
    fetcher: async () => {
      calls++;

      return reply(fixture());
    },
  });

  await assert.rejects(
    router.walking(
      {
        ...request,
        origin: {
          ...request.origin,
          latitude: NaN,
        },
      },
      budget,
    ),
    code('INVALID_INPUT'),
  );

  for (const endpoint of [
    'https://routing.openstreetmap.de/routed-car/route/v1/driving',
    'https://user:password@foot.example/route/v1/foot',
    'https://foot.example/route/v1/foot?secret=private',
  ]) {
    assert.throws(
      () =>
        new PedestrianRouter({
          endpoint,
        }),
      (error) =>
        error instanceof Error &&
        !error.message.includes('password') &&
        !error.message.includes('private'),
    );
  }

  assert.equal(calls, 0);
  assert.equal(budget.used, 0);
});
