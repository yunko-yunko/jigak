import { DataSource, MoreThan } from 'typeorm';
import { ApiRateWindowEntity } from '../src/common/database/entities/api-rate-window.entity.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/common/database/database.service.js';
import { RuntimeRepository } from '../src/common/providers/runtime.repository.js';
import { configureApplication } from '../src/common/http/configure-app.js';
import { executeRouteSearch } from '../src/modules/routing/domain/route-search.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';
import { ApiError } from '../src/common/engine/errors.js';
import { normalizeWalk, type RouteProvider } from '../src/common/engine/kakao.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import type { SharedScooterSimulation } from '../src/common/engine/simulation/shared-scooter-sim.js';
import { SimulatedVehicleFeed } from '../src/common/engine/simulation/simulated-vehicle-feed.js';
import {
  WEATHER_CACHE_MS,
  WEATHER_RECEIPT_MAX_AGE_MS,
  WeatherFeed,
} from '../src/common/engine/realtime/weather.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
import type {
  BaseRoute,
  BaseSegment,
  BoardingRealtime,
  Place,
} from '../src/common/shared/domain/types.js';
import type { PublicBusRuntime } from '../src/common/engine/intelligence/public-bus-timing.js';
import type { JourneyLearningFeatures } from '../src/common/shared/intelligence/journeyLearning.js';
import type { EtaLearningFeatures } from '../src/common/shared/intelligence/learning.js';
import type { WeatherSnapshot } from '../src/common/shared/intelligence/types.js';
import { LearningService } from '../src/modules/learning/service/learning.service.js';
import { parseRoute } from '../src/modules/routing/dto/routing.dto.js';
import { validateEnvironment } from '../src/common/config/environment.js';
import { createTestDatabase } from './helpers/auth-database.js';

const origin = {
  id: 'origin',
  name: '출발',
  address: '서울',
  latitude: 37.55,
  longitude: 126.97,
};

const destination = {
  id: 'destination',
  name: '도착',
  address: '서울',
  latitude: 37.56,
  longitude: 126.98,
};

const walkFixture = {
  status: 'OK',
  route: {
    properties: {
      totalDistance: 900,
      totalTime: 720,
    },
    legs: [
      {
        properties: {
          distance: 900,
          time: 720,
        },
        steps: [
          {
            properties: {
              distance: 900,
              time: 720,
              guidance: '도착까지 이동',
              x: 126.97,
              y: 37.55,
            },
            path: {
              points: [
                [126.97, 37.55],
                [126.98, 37.56],
              ],
            },
          },
        ],
      },
    ],
  },
};

function input(now = Date.now()) {
  return {
    origin,
    destination,
    now,
    deadline: now + 1800000,
    preferences: {
      walkingOnly: true,
      allowRunning: false,
      allowBicycle: false,
      maxRunningMeters: 500,
      maxBicycleMeters: 3000,
      runningPace: 'easy',
      preparationSeconds: 120,
      bicycleReady: false,
    },
  };
}

/** A simulator whose window is or is not ready; nothing else about it is read here. */
function simulationStub() {
  const state = { ready: false, gate: true };
  const stub = {
    fleet: 4000,
    fleets: { scooter: 3000, ebike: 1000 },
    modelVersion: 'model-test',
    vehicleTypes: ['kick-scooter', 'e-bike'],
    storeConfigured: false,
    get readyGate() {
      return state.gate;
    },
    isReady: () => state.ready,
    readiness: () => ({
      ready: state.ready,
      serviceDay: '2026-11-01',
      status: state.ready ? 'ready' : 'building',
      source: state.ready ? 'store' : null,
      startedAt: 1,
      elapsedMs: 5,
    }),
    nearby: () => [],
  } as unknown as SharedScooterSimulation;
  return Object.assign(state, { stub });
}

function runtime(): RoutingOptions {
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [destination],
    walking: async (endpoints, budget) => budget.run(() => normalizeWalk(walkFixture, endpoints)),
    transit: async () => [],
  };

  return {
    provider,
    realtime: new RealtimeService({}),
    nearbyTransit: new NearbyTransitService({
      provider,
    }),
    traffic: new RoadTrafficService({}),
    mobility: new MobilityFeeds({}),
    weather: new WeatherFeed(),
    parking: new SeoulParkingFeed(),
    intermediateTransitHubs: 0,
  };
}

const TRANSIT_NOW = Date.UTC(2026, 9, 14, 2);

const transitOrigin: Place = {
  id: 'optimization-origin',
  name: '출발',
  address: '서울',
  latitude: 37.566,
  longitude: 126.978,
};

const transitStop: Place = {
  ...transitOrigin,
  id: 'optimization-stop',
  name: '승차 정류장',
  latitude: 37.567,
};

const transitDestination: Place = {
  ...transitOrigin,
  id: 'optimization-destination',
  name: '도착',
  latitude: 37.58,
};

const transitPreferences = {
  allowRunning: false,
  allowBicycle: false,
  bicycleReady: false,
  allowScooter: false,
  allowTaxi: false,
  maxRunningMeters: 0,
  maxBicycleMeters: 0,
  runningPace: 'easy',
  preparationSeconds: 0,
};

function providerSegment(
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  distanceMeters: number,
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '공급원 경로 fixture',
    start,
    end,
    distanceMeters,
    durationSeconds: {
      min: seconds,
      max: seconds,
    },
    runAllowed: false,
    polyline: [start, end],
  };
}

function providerRoute(id: string, segments: BaseSegment[]): BaseRoute {
  return {
    id,
    title: id,
    segments,
    transfers: 0,
    distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    durationSeconds: segments.reduce(
      (sum, segment) => ({
        min: sum.min + segment.durationSeconds.min,
        max: sum.max + segment.durationSeconds.max,
      }),
      {
        min: 0,
        max: 0,
      },
    ),
  };
}

class FixtureArrivals extends RealtimeService {
  override get capabilities() {
    return {
      bus: true,
      subway: false,
    };
  }

  override async lookup(): Promise<BoardingRealtime> {
    return {
      provider: 'seoul-bus',
      stopName: transitStop.name,
      status: 'live',
      observedAt: TRANSIT_NOW,
      receivedAt: TRANSIT_NOW,
      predictions: [135, 500].map((seconds) => ({
        line: '402',
        arrivesAt: TRANSIT_NOW + seconds * 1000,
        message: '정류장 도착 예측 fixture',
      })),
    };
  }
}

class FixtureWeather extends WeatherFeed {
  constructor(private readonly receiptAge: number) {
    super();
  }

  override get configured() {
    return true;
  }

  override async conditions(): Promise<WeatherSnapshot> {
    return {
      source: 'kma-ultra-short',
      status: 'live',
      latitude: transitOrigin.latitude,
      longitude: transitOrigin.longitude,
      grid: {
        x: 60,
        y: 127,
      },
      temperatureC: 20,
      precipitationMm: 2,
      precipitationType: 1,
      windMetersPerSecond: 2,
      observedAt: TRANSIT_NOW - 30 * 60_000,
      receivedAt: TRANSIT_NOW - this.receiptAge,
      message: '기상 fixture',
    };
  }
}

function transitRuntime(
  weather: WeatherFeed,
  tickets = new Map<string, readonly (EtaLearningFeatures | null)[]>(),
  journeys = new Map<string, JourneyLearningFeatures>(),
  extras: {
    rideSeconds?: number;
    publicBus?: PublicBusRuntime;
    learning?: Record<string, unknown>;
  } = {},
): RoutingOptions {
  const now = () => TRANSIT_NOW;
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [transitDestination],
    walking: async (endpoints, budget) =>
      budget.run(async () => [
        providerRoute('provider-walk', [
          providerSegment(
            'walk-direct',
            'walk',
            endpoints.origin,
            endpoints.destination,
            900,
            1600,
          ),
        ]),
      ]),
    transit: async (_endpoints, budget) =>
      budget.run(async () => [
        providerRoute('provider-transit', [
          providerSegment('access', 'walk', transitOrigin, transitStop, 100, 111),
          {
            ...providerSegment(
              'ride',
              'bus',
              transitStop,
              transitDestination,
              extras.rideSeconds ?? 100,
              1450,
            ),
            lineName: '402',
            transit: {
              lines: ['402'],
              stops: [transitStop.name, transitDestination.name],
              vehicleTypes: ['간선'],
            },
          },
        ]),
      ]),
    driving: async () => {
      throw new ApiError('NO_ROUTES', '이 테스트는 도로 후보를 요청하지 않습니다.', 404);
    },
  };

  return {
    provider,
    realtime: new FixtureArrivals({ now }),
    nearbyTransit: new NearbyTransitService({ provider, now }),
    traffic: new RoadTrafficService({ now }),
    mobility: new MobilityFeeds({ now }),
    weather,
    parking: new SeoulParkingFeed(undefined, { now }),
    intermediateTransitHubs: 0,
    now,
    publicBus: extras.publicBus,
    learning: {
      refresh: async () => {},
      status: async () => ({
        model: { active: false },
        hgb: { active: false },
        journey: { model: { active: false } },
      }),
      predict: () => null,
      predictJourney: () => null,
      store: {
        issueTicket: (
          segments: readonly (EtaLearningFeatures | null)[],
          journey?: { features: JourneyLearningFeatures },
        ) => {
          const ticket = `fixture-learning-ticket-${String(tickets.size).padStart(16, '0')}`;

          tickets.set(ticket, segments);

          if (journey) {
            journeys.set(ticket, journey.features);
          }

          return ticket;
        },
      },
      ...extras.learning,
    } as unknown as LearningService,
  };
}

test('Nest HTTP API preserves routes, strict DTOs, fallback diagnostics, body limits and CORS with PostgreSQL', async (t) => {
  const db = await createTestDatabase();

  const options = runtime();

  const module = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(DataSource)
    .useValue(db.dataSource)
    .overrideProvider(DatabaseService)
    .useValue(db.database)
    .overrideProvider(RuntimeRepository)
    .useValue({
      options,
    })
    .compile();

  options.learning = module.get(LearningService);

  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });

  configureApplication(app, {
    DB_PASSWORD: 'test',
    AUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  });

  await app.listen(0, '127.0.0.1');

  const url = await app.getUrl();

  const get = (path: string) => fetch(url + '/api/' + path);

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + '/api/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  try {
    await t.test(
      'health, readiness, models, places and missing supplier data are truthful',
      async () => {
        const health = await (await get('health')).json();

        assert.equal(health.mode, 'live-ready');
        assert.equal(health.liveVerified, false);
        assert.equal(health.capabilities.realtime, false);
        assert.equal((await get('health/live')).status, 200);
        assert.equal((await get('health/ready')).status, 200);
        assert.equal((await (await get('models/public-bus')).json()).active, false);
        assert.equal((await (await get('models/public-bicycle')).json()).active, false);
        assert.deepEqual((await (await get('places?q=도착 지점')).json()).places, [destination]);
        assert.deepEqual(
          (await (await get('places?q=시청')).json()).places
            .slice(0, 2)
            .map((place: { id: string }) => place.id),
          ['station-시청-0', 'destination'],
        );
        assert.equal((await get('places/reverse?latitude=37.55&longitude=126.97')).status, 503);
        assert.equal((await get('places?q=x&latitude=37')).status, 400);

        for (const endpoint of [
          'realtime/mobility',
          'realtime/transit/nearby',
          'realtime/conditions',
        ]) {
          assert.equal((await get(endpoint + '?latitude=37.55&longitude=126.97')).status, 200);
        }

        assert.equal(
          (
            await post('realtime/arrivals', {
              boardings: [
                {
                  mode: 'bus',
                  stop: '서울역',
                  lines: ['701'],
                  nextStops: [],
                  latitude: 37.55,
                  longitude: 126.97,
                },
              ],
            })
          ).status,
          200,
        );
        assert.equal(
          (
            await post('traffic/route', {
              legs: [
                {
                  id: 'leg',
                  mode: 'bus',
                  path: [
                    [126.97, 37.55],
                    [126.98, 37.56],
                  ],
                  distanceMeters: 900,
                  baseSeconds: 720,
                },
              ],
            })
          ).status,
          200,
        );
      },
    );
    await t.test(
      'both search aliases return door-to-door routes and signed learning receipts',
      async () => {
        for (const endpoint of ['routes', 'routes/search']) {
          const response = await post(endpoint, input());

          assert.equal(response.status, 200);
          assert.ok(response.headers.get('server-timing'));
          assert.equal(response.headers.get('cache-control'), 'no-store');

          const body = await response.json();

          assert.equal(body.routes.length, 1);
          assert.equal(body.routes[0].origin.id, origin.id);
          assert.equal(body.providerCalls, 1);
          assert.ok(body.routes[0].learningTicket);
          assert.ok(body.routes[0].segments.every((s: any) => ['walk', 'wait'].includes(s.mode)));
        }
      },
    );
    await t.test(
      'elapsed replan deadline is retained and strict/time invalid inputs fail',
      async () => {
        const now = Date.now();

        const replan = await post('routes/search', {
          ...input(now),
          deadline: now - 60000,
          purpose: 'replan',
        });

        assert.equal(replan.status, 200);
        assert.equal((await replan.json()).allLate, true);

        for (const value of [
          {
            ...input(),
            unknown: true,
          },
          {
            ...input(),
            deadline: Date.now() - 60000,
          },
          {
            ...input(),
            now: Date.now() - 300000,
          },
          {
            ...input(),
            destination: origin,
          },
        ]) {
          assert.equal((await post('routes/search', value)).status, 400);
        }
      },
    );
    await t.test(
      'JSON/form parsing, errors and browser origin protection use the same Nest pipeline',
      async () => {
        assert.equal(
          (
            await post('routes', input(), {
              Origin: 'https://evil.example',
            })
          ).status,
          403,
        );

        const allowed = await fetch(url + '/api/health', {
          headers: {
            Origin: 'http://localhost:8081',
          },
        });

        assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:8081');

        const malformed = await fetch(url + '/api/routes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{',
        });

        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).error.code, 'INVALID_INPUT');
        assert.equal(
          (
            await post('auth/exchange', {
              padding: 'x'.repeat(17000),
            })
          ).status,
          413,
        );

        const absent = await get('missing');

        assert.equal(absent.status, 404);
        assert.equal((await absent.json()).error.code, 'INVALID_INPUT');

        const apple = await fetch(url + '/api/auth/apple/callback', {
          method: 'POST',
          headers: {
            Origin: 'https://appleid.apple.com',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'state=invalid&code=invalid',
          redirect: 'manual',
        });

        assert.notEqual(apple.status, 403);
        assert.equal(apple.headers.get('access-control-allow-origin'), null);
      },
    );
    await t.test(
      'learning routes have one /api prefix and reject unsigned observations',
      async () => {
        assert.equal((await get('learning/status')).status, 200);
        assert.equal(
          (
            await post('learning/observations', {
              ticket: 'bad',
            })
          ).status,
          400,
        );

        const result = await fetch(url + '/api/learning/observations', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            deletionToken: 'bad',
          }),
        });

        assert.equal(result.status, 400);
      },
    );
    await t.test(
      'readiness waits for the simulator window and says what is still starting (§22)',
      async () => {
        const simulation = simulationStub();
        options.scooterSimulation = simulation.stub;
        try {
          const waiting = await get('health/ready');
          assert.equal(waiting.status, 503);
          const body = await waiting.json();
          assert.equal(body.status, 'starting');
          assert.equal(body.simulation.ready, false);
          assert.equal(body.simulation.status, 'building');
          const health = await (await get('health')).json();
          assert.equal(health.simulation.status, 'building');
          assert.equal(health.simulation.source, null);
          assert.equal(health.simulation.windowStore, 'off');
          assert.equal(health.simulation.serviceDay, '2026-11-01');
          simulation.ready = true;
          const open = await get('health/ready');
          assert.equal(open.status, 200);
          assert.deepEqual((await open.json()).simulation, {
            enabled: true,
            ready: true,
            serviceDay: '2026-11-01',
            source: 'store',
          });
          simulation.ready = false;
          simulation.gate = false;
          assert.equal((await get('health/ready')).status, 200, 'the gate can be turned off');
        } finally {
          delete options.scooterSimulation;
        }
        assert.deepEqual((await (await get('health/ready')).json()).simulation, {
          enabled: false,
        });
      },
    );
    await t.test('PostgreSQL throttle shares route aliases and returns Retry-After', async () => {
      await db.database
        .getRepository(ApiRateWindowEntity)
        .update({ count: MoreThan(1) }, { count: 30 });

      const response = await post('routes/search', input());

      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
    });
    await t.test(
      'place search allows 600 requests a minute and reverse geocoding 120',
      async () => {
        await db.database.getRepository(ApiRateWindowEntity).clear();

        for (let index = 0; index < 61; index++) {
          assert.equal((await get('places?q=도착 지점')).status, 200);
        }
        for (let index = 0; index < 120; index++) {
          assert.equal((await get('places/reverse?latitude=37.55&longitude=126.97')).status, 503);
        }
        assert.equal((await get('places/reverse?latitude=37.55&longitude=126.97')).status, 429);
        // Routes ignore case, so the throttle must too.
        assert.equal((await get('Places/Reverse?latitude=37.55&longitude=126.97')).status, 429);
      },
    );
  } finally {
    await app.close();

    await db.close();
  }
});

test('route engine supports gzip encoding and deadline boundary invariants', async () => {
  const options = runtime(),
    now = Date.now();

  const result = await executeRouteSearch(input(now), options, true);

  assert.ok(result);

  const raw =
    result.encoded.encoding === 'gzip' ? gunzipSync(result.encoded.body) : result.encoded.body;
  const body = JSON.parse(raw.toString());

  assert.equal(body.routes.length, 1);
  assert.throws(() =>
    parseRoute(
      {
        ...input(now),
        deadline: now + 49 * 3600000,
      },
      now,
    ),
  );
  assert.throws(() =>
    parseRoute(
      {
        ...input(now),
        purpose: 'urgent',
        deadline: now - 49 * 3600000,
      },
      now,
    ),
  );
  assert.equal(
    parseRoute(
      {
        ...input(now),
        purpose: 'urgent',
        deadline: now - 60000,
      },
      now,
    ).purpose,
    'urgent',
  );
});

test('while the simulator computes its window a search says its kinds are being placed (startup-spec §1.3)', async () => {
  const simulation = simulationStub();
  const options = runtime();
  const none = async () => [];
  options.mobility = new MobilityFeeds({
    vehicleFeeds: [new SimulatedVehicleFeed(simulation.stub)],
  });
  options.scooterSimulation = simulation.stub;
  options.provider = { ...options.provider!, scooter: none, ebike: none };
  const policy = { modelVersion: 'model-test', verify: async () => null };
  options.scooterPolicy = policy as unknown as RoutingOptions['scooterPolicy'];
  options.ebikePolicy = policy as unknown as RoutingOptions['ebikePolicy'];
  const search = async () => {
    const now = Date.now();
    const request = input(now);
    const result = await executeRouteSearch(
      { ...request, preferences: { ...request.preferences, walkingOnly: false, allowEbike: true } }, // the current app names it; without it the request reads as an app older than the e-bike tab
      options,
      false,
    );
    return JSON.parse(result!.encoded.body.toString());
  };
  const waiting = await search();
  for (const mode of ['scooter', 'ebike'])
    assert.deepEqual(waiting.rentalAvailability[mode], {
      status: 'unavailable',
      reason: 'supply-unavailable',
    });
  assert.match(
    waiting.notice,
    /시연용 가상 킥보드·전기자전거 위치를 계산하는 중이라 이번 결과에는 넣지 않았어요\./,
  );
  simulation.ready = true;
  const ready = await search();
  for (const mode of ['scooter', 'ebike'])
    assert.notEqual(ready.rentalAvailability[mode].reason, 'supply-unavailable');
  assert.doesNotMatch(ready.notice ?? '', /계산하는 중/);
});

test('route search keeps the rain access buffer and the ticket weather for every receipt the feed can still serve, and drops older ones', async () => {
  for (const [age, rainy] of [
    [0, true],
    [WEATHER_CACHE_MS, true],
    [WEATHER_RECEIPT_MAX_AGE_MS, true],
    [WEATHER_RECEIPT_MAX_AGE_MS + 1_000, false],
  ] as const) {
    const tickets = new Map<string, readonly (EtaLearningFeatures | null)[]>();
    const journeys = new Map<string, JourneyLearningFeatures>();
    const result = await executeRouteSearch(
      {
        origin: transitOrigin,
        destination: transitDestination,
        now: TRANSIT_NOW,
        deadline: TRANSIT_NOW + 200_000,
        preferences: transitPreferences,
      },
      transitRuntime(new FixtureWeather(age), tickets, journeys),
    );

    assert.ok(result);

    const body = JSON.parse(result.encoded.body.toString());
    const transit = body.routes.find((route: any) =>
      route.segments.some((s: any) => s.mode === 'bus'),
    );

    assert.ok(transit);
    assert.equal(
      transit.segments.find((s: any) => s.mode === 'walk').planningBuffer?.weatherSeconds ?? 0,
      rainy ? 15 : 0,
      `receipt age ${age}`,
    );
    assert.equal(
      transit.readyTime.latest,
      TRANSIT_NOW + (rainy ? 600_000 : 235_000),
      `receipt age ${age}`,
    );
    assert.deepEqual(
      tickets
        .get(transit.learningTicket)
        ?.map(
          (stage) =>
            stage && [stage.mode, (stage.startedAt - TRANSIT_NOW) / 1000, stage.precipitationMm],
        ),
      rainy
        ? [
            ['walk', 0, 2],
            ['wait', 115, 2],
            ['bus', 500, null],
          ]
        : [
            ['walk', 0, null],
            ['wait', 100, null],
            ['bus', 135, null],
          ],
      `ticket, receipt age ${age}`,
    );

    const journey = journeys.get(transit.learningTicket);

    assert.deepEqual(
      journey && [journey.precipitationMm, journey.temperatureC, journey.windMetersPerSecond],
      rainy ? [2, 20, 2] : [null, null, null],
      `whole-journey ticket, receipt age ${age}`,
    );

    if (rainy) {
      assert.deepEqual(
        body.intelligence.weather,
        await new FixtureWeather(age).conditions(),
        `ranking weather, receipt age ${age}`,
      );
      assert.deepEqual(
        body.intelligence.assessments
          .find((item: any) => item.routeId === transit.id)
          ?.explanations.find((item: any) => item.code === 'weather'),
        {
          code: 'weather',
          severity: 'caution',
          seconds: 15,
          text: '관측된 강수에 따른 야외 구간의 15% 계획 여유를 승차 연결 계산 전에 포함했습니다. 검증된 속도 예측값은 아닙니다.',
        },
        `ranking weather explanation, receipt age ${age}`,
      );
    }
  }
});

test('route search hands the public bus model only the search clock and that search weather receipt, for a fresh and a stale receipt', async () => {
  for (const age of [0, WEATHER_RECEIPT_MAX_AGE_MS + 1_000]) {
    const calls: [number, number | null][] = [];
    const publicBus: PublicBusRuntime = {
      status: () => ({ active: true, version: 'public-bus-duration-v2' }),
      predictSegment: (_segment, _startedAt, requestNow, weather) => {
        calls.push([requestNow - TRANSIT_NOW, weather ? weather.receivedAt - TRANSIT_NOW : null]);

        return null;
      },
    };
    const result = await executeRouteSearch(
      {
        origin: transitOrigin,
        destination: transitDestination,
        now: TRANSIT_NOW,
        deadline: TRANSIT_NOW + 200_000,
        preferences: transitPreferences,
      },
      transitRuntime(new FixtureWeather(age), undefined, undefined, {
        rideSeconds: 300,
        publicBus,
      }),
    );

    assert.ok(result);
    assert.ok(calls.length > 0, `the bus model is asked, receipt age ${age}`);
    assert.deepEqual(
      [...new Set(calls.map((call) => JSON.stringify(call)))],
      [JSON.stringify([0, -age])],
      `bus model clock and receipt, receipt age ${age}`,
    );
  }
});

test('route search gives contextual inference the search weather its learning ticket carries, and none once the receipt is too old', async () => {
  for (const age of [0, WEATHER_RECEIPT_MAX_AGE_MS + 1_000]) {
    const tickets = new Map<string, readonly (EtaLearningFeatures | null)[]>();
    const searchStage: EtaLearningFeatures[] = [];
    const result = await executeRouteSearch(
      {
        origin: transitOrigin,
        destination: transitDestination,
        now: TRANSIT_NOW,
        deadline: TRANSIT_NOW + 200_000,
        preferences: transitPreferences,
      },
      transitRuntime(new FixtureWeather(age), tickets, undefined, {
        rideSeconds: 300,
        learning: {
          status: async () => ({
            model: { active: true },
            hgb: { active: false },
            journey: { model: { active: false } },
          }),
          predict: (features: EtaLearningFeatures) => {
            if (features.startedAt === TRANSIT_NOW) {
              searchStage.push(features);
            }

            return null;
          },
        },
      }),
    );

    assert.ok(result);

    assert.ok(searchStage.length > 0, `the contextual model is asked, receipt age ${age}`);
    assert.deepEqual(
      [...new Set(searchStage.map((features) => features.precipitationMm))],
      [age === 0 ? 2 : null],
      `inferred rain at the search time, receipt age ${age}`,
    );

    const ticketStages = [...tickets.values()]
      .flat()
      .filter((stage): stage is EtaLearningFeatures => stage !== null);

    for (const features of searchStage) {
      const ticketed = ticketStages.filter(
        (stage) => stage.mode === features.mode && stage.startedAt === features.startedAt,
      );

      assert.ok(
        ticketed.length > 0,
        `a learning ticket carries the ${features.mode} stage starting at the search, receipt age ${age}`,
      );

      for (const stage of ticketed) {
        assert.deepEqual(
          [features.precipitationMm, features.temperatureC, features.windMetersPerSecond],
          [stage.precipitationMm, stage.temperatureC, stage.windMetersPerSecond],
          `inference and ticket weather of the ${features.mode} stage, receipt age ${age}`,
        );
      }
    }
  }
});

test('production configuration rejects missing encryption key and insecure web origins', () => {
  const base = {
    NODE_ENV: 'production',
    DB_PASSWORD: 'test',
    AUTH_PUBLIC_BASE_URL: 'https://api.example.com',
    AUTH_WEB_RETURN_URL: 'https://web.example.com/',
    CORS_ORIGINS: 'https://web.example.com',
    AUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };

  assert.equal(validateEnvironment(base).DB_POOL_MAX, 5);
  assert.throws(() =>
    validateEnvironment({
      ...base,
      AUTH_TOKEN_ENCRYPTION_KEY: '',
    }),
  );
  assert.throws(() =>
    validateEnvironment({
      ...base,
      CORS_ORIGINS: 'http://web.example.com',
    }),
  );
});

test('a failing Kakao transit call degrades that mode only; the search fails only when no base route is left', async () => {
  const now = Date.now(),
    options = runtime(),
    down = () =>
      Promise.reject(
        new ApiError(
          'PROVIDER_UNAVAILABLE',
          '카카오 지도 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
        ),
      ),
    search = { ...input(now), preferences: { ...input(now).preferences, walkingOnly: false } };
  options.provider!.transit = down;

  const partial = await executeRouteSearch(search, options, false);

  assert.ok(partial);
  const body = JSON.parse(partial.encoded.body.toString());
  assert.equal(body.routes.length, 1, 'the walking route is still offered');
  assert.deepEqual(
    body.failures.map((failure: { provider: string; code: string }) => [
      failure.provider,
      failure.code,
    ]),
    [['kakao-publictraffic', 'PROVIDER_UNAVAILABLE']],
  );
  assert.match(body.notice, /일부 경로 조회가 실패했어요/);

  options.provider!.walking = down;
  await assert.rejects(
    executeRouteSearch(search, options, false),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_UNAVAILABLE',
  );
});
