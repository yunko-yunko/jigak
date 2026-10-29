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
import { normalizeWalk, type RouteProvider } from '../src/common/engine/kakao.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
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
        assert.deepEqual((await (await get('places?q=시청')).json()).places, [destination]);
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
    await t.test('PostgreSQL throttle shares route aliases and returns Retry-After', async () => {
      await db.database
        .getRepository(ApiRateWindowEntity)
        .update({ count: MoreThan(1) }, { count: 30 });

      const response = await post('routes/search', input());

      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('retry-after')) > 0);
    });
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
