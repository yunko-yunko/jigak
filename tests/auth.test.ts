import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { DatabaseService } from '../src/common/database/database.service.js';
import { ApiRateWindowEntity } from '../src/common/database/entities/api-rate-window.entity.js';
import { configureApplication } from '../src/common/http/configure-app.js';
import { RateLimitService } from '../src/common/http/rate-limit.service.js';
import { ApiError } from '../src/common/errors.js';
import { AuthController } from '../src/modules/auth/controller/auth.controller.js';
import { AUTH_OPTIONS, type AuthOptions } from '../src/modules/auth/domain/auth.options.js';
import { randomToken, sha256 } from '../src/modules/auth/domain/security.js';
import {
  CONSENT_VERSION,
  OUTDATED_CONSENT_MESSAGE,
  type OAuthAdapter,
  type SocialIdentity,
} from '../src/modules/auth/domain/types.js';
import { AuthRepository } from '../src/modules/auth/repository/auth.repository.js';
import {
  AccountDataEntity,
  AuthRateWindowEntity,
  OAuthStateEntity,
  SessionEntity,
  SocialIdentityEntity,
  SupportTicketEntity,
  UserEntity,
} from '../src/modules/auth/repository/entities/index.js';
import { AuthService, SESSION_COOKIE } from '../src/modules/auth/service/auth.service.js';
import { createTestDatabase } from './helpers/auth-database.js';

const config = {
  publicBaseUrl: 'https://api.example.test',
  webReturnUrl: 'https://app.example.test/',
  encryptionKey: Buffer.alloc(32, 9).toString('base64'),
};

const identity: SocialIdentity = {
  provider: 'google',
  subject: 'google-user-123',
  name: '준서',
  email: 'junseo@example.test',
  emailVerified: true,
  grant: {
    accessToken: 'private-provider-access',
    refreshToken: 'private-provider-refresh',
  },
};

const consent = {
  termsVersion: CONSENT_VERSION,
  privacyVersion: CONSENT_VERSION,
  marketingConsent: false,
};

const preferences = {
  allowRunning: false,
  allowBicycle: false,
  maxRunningMeters: 500,
  maxBicycleMeters: 2_000,
  runningPace: 'easy',
  preparationSeconds: 120,
  bicycleReady: false,
};

let now = Date.now();
let db: Awaited<ReturnType<typeof createTestDatabase>>;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  now = Date.now();

  await db.database.transaction(async (manager) => {
    await manager.getRepository(UserEntity).deleteAll();
    await manager.getRepository(OAuthStateEntity).deleteAll();
    await manager.getRepository(SupportTicketEntity).deleteAll();
    await manager.getRepository(AuthRateWindowEntity).deleteAll();
    await manager.getRepository(ApiRateWindowEntity).deleteAll();
  });
});

after(async () => {
  await db.close();
});

function request(body?: unknown, headers: Record<string, string> = {}, ip = '127.0.0.1') {
  return {
    body,
    ip,
    socket: {
      remoteAddress: ip,
    },
    get: (name: string) =>
      Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1],
  } as unknown as Request;
}

function response() {
  const cookies: {
    name: string;
    value?: string;
    options: any;
    cleared: boolean;
  }[] = [];
  const headers: Record<string, string | number> = {};

  return {
    cookies,
    headers,
    response: {
      cookie(name: string, value: string, options: any) {
        cookies.push({
          name,
          value,
          options,
          cleared: false,
        });
      },

      clearCookie(name: string, options: any) {
        cookies.push({
          name,
          options,
          cleared: true,
        });
      },

      setHeader(name: string, value: string | number) {
        headers[name] = value;
      },
    } as unknown as Response,
  };
}

function adapter(overrides: Partial<OAuthAdapter> = {}): OAuthAdapter {
  return {
    id: 'google',
    name: 'Google',
    configured: true,
    authorizationUrl: (state) => `https://accounts.example.test/authorize?state=${state}`,
    identity: async () => identity,
    revoke: async () => {},
    ...overrides,
  };
}

function application(options: Partial<AuthOptions> = {}) {
  const settings = {
    config,
    adapters: [adapter()],
    now: () => now,
    ...options,
  };
  const repository = new AuthRepository(db.database, settings);
  const service = new AuthService(repository, settings);

  return {
    repository,
    service,
  };
}

async function ticket(service: AuthService, platform: 'web' | 'native' = 'native') {
  const verifier = randomToken();

  const started = new URL(
    await service.start('google', {
      platform,
      challenge: sha256(verifier),
    }),
  );

  const state = started.searchParams.get('state')!;

  const callback = new URL(
    await service.callback('google', {
      state,
      code: 'auth-code',
    }),
  );

  assert.equal(callback.searchParams.has('token'), false);

  const value = callback.searchParams.get('auth_ticket');

  assert.ok(value);

  return {
    ticket: value,
    verifier,
    state,
  };
}

async function login(service: AuthService, consented = true) {
  const input = await ticket(service);

  const output = await service.exchange(
    request({
      ticket: input.ticket,
      verifier: input.verifier,
    }),
    response().response,
  );

  assert.ok('token' in output);

  const token = output.token;

  if (consented) {
    await service.consents(
      request(consent, {
        Authorization: `Bearer ${token}`,
      }),
    );
  }

  return {
    token,
    output,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

test('TypeORM state and tickets are one-use across repository instances and encrypted at rest', async () => {
  const first = application(),
    second = application();

  const input = await ticket(first.service);

  const states = await db.database.getRepository(OAuthStateEntity).find();

  assert.equal(states.length, 0);
  await assert.rejects(
    second.service.callback('google', {
      state: input.state,
      code: 'again',
    }),
    code('AUTH_FLOW_EXPIRED'),
  );
  await assert.rejects(
    second.service.exchange(
      request({
        ticket: input.ticket,
        verifier: randomToken(),
      }),
      response().response,
    ),
    code('AUTH_FLOW_EXPIRED'),
  );

  const result = await second.service.exchange(
    request({
      ticket: input.ticket,
      verifier: input.verifier,
    }),
    response().response,
  );

  assert.ok('token' in result);
  await assert.rejects(
    first.service.exchange(
      request({
        ticket: input.ticket,
        verifier: input.verifier,
      }),
      response().response,
    ),
    code('AUTH_FLOW_EXPIRED'),
  );

  const grants = await db.database.getRepository(SocialIdentityEntity).find();

  assert.equal(JSON.stringify(grants).includes('private-provider-access'), false);

  const tokens = await db.database.getRepository(SessionEntity).find();

  assert.notEqual(tokens[0]!.tokenHash, result.token);
  assert.equal(
    (await first.repository.identities(result.user.id))[0]!.grant?.refreshToken,
    'private-provider-refresh',
  );
});

test('consent gate permits pending me and explicit consent while protecting account changes', async () => {
  const { service } = application(),
    { token, output, headers } = await login(service, false);

  assert.equal(output.newUser, true);
  assert.equal((await service.me(request(undefined, headers))).user.needsConsent, true);
  await assert.rejects(service.preferences(request(undefined, headers)), code('CONSENT_REQUIRED'));
  await assert.rejects(
    service.updateName(
      request(
        {
          name: '새 이름',
        },
        headers,
      ),
    ),
    code('CONSENT_REQUIRED'),
  );
  await assert.rejects(
    service.consents(
      request(
        {
          ...consent,
          termsVersion: 'old',
        },
        headers,
      ),
    ),
    code('INVALID_INPUT'),
  );

  const accepted = await service.consents(request(consent, headers));

  assert.equal(accepted.user.needsConsent, false);
  assert.equal(accepted.user.consents.marketingConsent, false);
  assert.equal(
    (
      await service.updateName(
        request(
          {
            name: ' 새 이름 ',
          },
          headers,
        ),
      )
    ).user.name,
    '새 이름',
  );
  await assert.rejects(
    service.updateName(
      request(
        {
          name: '\u0000',
        },
        headers,
      ),
    ),
    code('INVALID_INPUT'),
  );
  assert.ok(token);
});

test('an account that agreed to an older policy version is asked again and keeps its data and optional choice', async () => {
  assert.equal(CONSENT_VERSION, '2026-11-02');

  const { repository, service } = application(),
    { headers } = await login(service, false);

  await service.consents(request({ ...consent, marketingConsent: true }, headers));

  const { id } = (await service.me(request(undefined, headers))).user;

  // The account as the 10-02 text left it, old enough for the unconsented-account sweep to look at it.
  await db.database
    .getRepository(UserEntity)
    .update({ id }, { termsVersion: '2026-10-02', privacyVersion: '2026-10-02', createdAt: 0 });
  await repository.cleanup();

  const pending = (await service.me(request(undefined, headers))).user;

  assert.equal(pending.needsConsent, true);
  assert.equal(pending.consents.termsVersion, '2026-10-02');
  assert.equal(pending.consents.marketingConsent, true);
  assert.ok(pending.consents.acceptedAt);
  await assert.rejects(service.preferences(request(undefined, headers)), code('CONSENT_REQUIRED'));
  // An old app build still agrees to 10-02: it is told to update, in words it shows as they are, and nothing is recorded.
  assert.equal(OUTDATED_CONSENT_MESSAGE, '약관이 바뀌었어요. 앱을 업데이트한 뒤 다시 동의해 주세요.');
  for (const outdated of [
    { termsVersion: '2026-10-02', privacyVersion: '2026-10-02', marketingConsent: false },
    { termsVersion: CONSENT_VERSION, privacyVersion: '2026-10-02', marketingConsent: false },
  ]) {
    await assert.rejects(
      service.consents(request(outdated, headers)),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'CONSENT_REQUIRED' &&
        error.status === 403 &&
        error.message === OUTDATED_CONSENT_MESSAGE,
    );
  }
  // A malformed body, or a version newer than the server's, stays an ordinary 400.
  for (const malformed of [
    { termsVersion: '2026-10-02', privacyVersion: '2026-10-02' },
    { termsVersion: '2026-10-02', privacyVersion: '2026-10-02', marketingConsent: 'yes' },
    { termsVersion: '2026-10-02', privacyVersion: '2026-10-02', marketingConsent: true, extra: 1 },
    { termsVersion: 'old', privacyVersion: 'old', marketingConsent: true },
    { termsVersion: '2099-01-01', privacyVersion: '2026-10-02', marketingConsent: true },
  ]) {
    await assert.rejects(service.consents(request(malformed, headers)), code('INVALID_INPUT'));
  }

  const stillPending = (await service.me(request(undefined, headers))).user;

  assert.equal(stillPending.needsConsent, true);
  assert.equal(stillPending.consents.termsVersion, '2026-10-02');
  assert.equal(stillPending.consents.marketingConsent, true);

  const renewed = await service.consents(request({ ...consent, marketingConsent: true }, headers));

  assert.equal(renewed.user.needsConsent, false);
  assert.equal(renewed.user.consents.termsVersion, CONSENT_VERSION);
  assert.equal(renewed.user.consents.privacyVersion, CONSENT_VERSION);
  assert.equal(renewed.user.consents.marketingConsent, true);
  await service.preferences(request(undefined, headers));
});

test('an account asked to agree again can still delete itself without agreeing', async () => {
  const { service } = application(),
    { headers } = await login(service);
  const { id } = (await service.me(request(undefined, headers))).user;

  await db.database
    .getRepository(UserEntity)
    .update({ id }, { termsVersion: '2026-10-02', privacyVersion: '2026-10-02' });
  assert.equal((await service.me(request(undefined, headers))).user.needsConsent, true);
  await service.deleteAccount(request({ confirmation: '탈퇴' }, headers), response().response);
  await assert.rejects(service.me(request(undefined, headers)), code('AUTH_REQUIRED'));
});

test('web exchange pins origin and hides bearer; cookie mutations require origin and CSRF', async () => {
  const { service } = application(),
    input = await ticket(service, 'web');

  const body = {
    ticket: input.ticket,
    verifier: input.verifier,
  };

  await assert.rejects(service.exchange(request(body), response().response), code('AUTH_CSRF'));

  const reply = response();

  const output = await service.exchange(
    request(body, {
      Origin: 'https://app.example.test',
    }),
    reply.response,
  );

  assert.equal('token' in output, false);
  assert.ok('csrfToken' in output);

  const cookie = reply.cookies[0]!;

  assert.deepEqual(cookie.options, {
    path: '/api',
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 7 * 86_400_000,
  });
  assert.equal(cookie.name, SESSION_COOKIE);

  const headers = {
    Cookie: `${cookie.name}=${cookie.value}`,
    Origin: 'https://app.example.test',
  };

  await assert.rejects(service.consents(request(consent, headers)), code('AUTH_CSRF'));

  const valid = {
    ...headers,
    'X-CSRF-Token': output.csrfToken,
  };

  await service.consents(request(consent, valid));

  await assert.rejects(
    service.logout(
      request(
        {},
        {
          ...valid,
          Origin: 'https://evil.example',
        },
      ),
      reply.response,
    ),
    code('AUTH_CSRF'),
  );

  const me = await service.me(request(undefined, headers));

  assert.equal('csrfToken' in me && me.csrfToken, output.csrfToken);

  await service.logout(request({}, valid), reply.response);

  assert.equal(reply.cookies.at(-1)!.cleared, true);
  await assert.rejects(service.me(request(undefined, headers)), code('AUTH_REQUIRED'));
});

test('OAuth callback pins provider and callback URL, and cancellation consumes the state', async () => {
  const { service } = application({
    adapters: [
      adapter(),
      adapter({
        id: 'kakao',
      }),
    ],
  });

  await assert.rejects(
    service.start('google', {
      platform: 'native',
      challenge: sha256(randomToken()),
      returnUrl: 'https://evil.example',
    }),
    code('INVALID_INPUT'),
  );

  const start = new URL(
    await service.start('google', {
      platform: 'native',
      challenge: sha256(randomToken()),
    }),
  );

  const state = start.searchParams.get('state')!;

  await assert.rejects(
    service.callback('kakao', {
      state,
      code: 'code',
    }),
    code('AUTH_FLOW_EXPIRED'),
  );
  assert.equal(
    await service.callback('google', {
      state,
      error: 'denied',
      error_description: 'private-text',
    }),
    'jigakjido://auth?auth_error=SOCIAL_CANCELLED',
  );
  await assert.rejects(
    service.callback('google', {
      state,
      code: 'code',
    }),
    code('AUTH_FLOW_EXPIRED'),
  );
  assert.equal(
    application({
      adapters: [],
    })
      .service.providers()
      .providers.every((value) => !value.available),
    true,
  );
});

test('PostgreSQL preferences and trips persist across services without leaking between equal-email accounts', async () => {
  const first = application(),
    loginOne = await login(first.service);

  const place = {
    id: 'a',
    name: '서울역',
    address: '서울',
    latitude: 37.55,
    longitude: 126.97,
  };
  const trips = {
    savedTrips: [
      {
        id: 'trip-1',
        origin: place,
        destination: {
          ...place,
          id: 'b',
        },
        mode: 'live',
        savedAt: now,
      },
    ],
    recentTrips: [],
  };

  await first.service.savePreferences(request(preferences, loginOne.headers));
  await first.service.saveTrips(request(trips, loginOne.headers));

  const restarted = application();

  assert.deepEqual(await restarted.service.preferences(request(undefined, loginOne.headers)), {
    preferences,
  });
  assert.deepEqual(await restarted.service.trips(request(undefined, loginOne.headers)), trips);
  await assert.rejects(
    restarted.service.savePreferences(
      request(
        {
          ...preferences,
          extra: true,
        },
        loginOne.headers,
      ),
    ),
    code('INVALID_INPUT'),
  );

  const second = application({
    adapters: [
      adapter({
        identity: async () => ({
          ...identity,
          subject: 'different-person',
        }),
      }),
    ],
  });

  const loginTwo = await login(second.service);

  assert.notEqual(loginTwo.output.user.id, loginOne.output.user.id);
  assert.equal(
    (await second.service.preferences(request(undefined, loginTwo.headers))).preferences,
    null,
  );
});

test('session cap and owner scoped revocation remove old sessions and never expose hashes', async () => {
  const { repository, service } = application(),
    first = await login(service);

  for (let index = 0; index < 20; index++) {
    now += 1;

    const verifier = randomToken(),
      issued = await repository.issueTicket(
        first.output.user.id,
        sha256(verifier),
        'native',
        false,
      );

    await repository.exchangeTicket(issued, verifier, '앱');
  }

  await assert.rejects(service.me(request(undefined, first.headers)), code('AUTH_REQUIRED'));

  const latest = await login(service),
    listing = await service.sessions(request(undefined, latest.headers));

  assert.equal(listing.sessions.length, 20);
  assert.equal(listing.sessions.filter((value) => value.current).length, 1);
  assert.equal(/csrf|token_hash/.test(JSON.stringify(listing)), false);

  const current = listing.sessions.find((value) => value.current)!;

  await service.revokeSession(request(undefined, latest.headers), response().response, current.id);

  await assert.rejects(service.me(request(undefined, latest.headers)), code('AUTH_REQUIRED'));
});

test('concurrent ticket exchanges keep single use and the session cap when timestamps tie', async () => {
  const first = application();
  const second = application();
  const { user } = await first.repository.socialAccount(identity);
  const verifier = randomToken();
  const sharedTicket = await first.repository.issueTicket(
    user.id,
    sha256(verifier),
    'native',
    true,
  );

  const shared = await Promise.allSettled([
    first.repository.exchangeTicket(sharedTicket, verifier, 'first'),
    second.repository.exchangeTicket(sharedTicket, verifier, 'second'),
  ]);

  assert.equal(shared.filter((result) => result.status === 'fulfilled').length, 1);

  const rejected = shared.find((result) => result.status === 'rejected');

  assert.ok(rejected && code('AUTH_FLOW_EXPIRED')(rejected.reason));

  const inputs = await Promise.all(
    Array.from({ length: 24 }, async () => {
      const verifier = randomToken();
      const ticket = await first.repository.issueTicket(user.id, sha256(verifier), 'native', false);

      return { ticket, verifier };
    }),
  );

  const sessions = await Promise.all(
    inputs.map((input, index) =>
      (index % 2 ? first : second).repository.exchangeTicket(
        input.ticket,
        input.verifier,
        `device-${index}`,
      ),
    ),
  );
  const listing = await first.repository.sessions(user.id, sessions.at(-1)!.sessionId);

  assert.equal(listing.length, 20);
  assert.equal(new Set(listing.map((session) => session.id)).size, 20);
  assert.equal(new Set(listing.map((session) => session.createdAt)).size, 1);
  assert.equal(await db.database.getRepository(SessionEntity).countBy({ userId: user.id }), 20);
});

test('concurrent account data upserts preserve both preferences and trips', async () => {
  const { repository } = application();
  const { user } = await repository.socialAccount(identity);
  const trips = { savedTrips: [{ id: 'saved' }], recentTrips: [] };

  await Promise.all([
    repository.savePreferences(user.id, preferences),
    repository.saveTrips(user.id, trips),
  ]);

  assert.deepEqual(await repository.preferences(user.id), preferences);
  assert.deepEqual(await repository.trips(user.id), trips);

  await Promise.all([
    repository.savePreferences(user.id, { ...preferences, preparationSeconds: 300 }),
    repository.saveTrips(user.id, { ...trips, recentTrips: [{ id: 'recent' }] }),
  ]);

  assert.deepEqual(await repository.preferences(user.id), {
    ...preferences,
    preparationSeconds: 300,
  });
  assert.deepEqual(await repository.trips(user.id), {
    ...trips,
    recentTrips: [{ id: 'recent' }],
  });
});

test('account deletion waits for provider revocation and cascades data only after success', async () => {
  let reject = true;
  const { service } = application({
    adapters: [
      adapter({
        revoke: async () => {
          if (reject) {
            throw new ApiError('SOCIAL_UNAVAILABLE', '연결 실패', 502);
          }
        },
      }),
    ],
  });

  const session = await login(service);

  await service.savePreferences(request(preferences, session.headers));

  await assert.rejects(
    service.deleteAccount(
      request(
        {
          confirmation: '탈퇴',
        },
        session.headers,
      ),
      response().response,
    ),
    code('SOCIAL_UNAVAILABLE'),
  );
  assert.ok((await service.me(request(undefined, session.headers))).user);

  reject = false;

  await service.deleteAccount(
    request(
      {
        confirmation: '탈퇴',
      },
      session.headers,
    ),
    response().response,
  );

  await assert.rejects(service.me(request(undefined, session.headers)), code('AUTH_REQUIRED'));
  assert.equal(await db.database.getRepository(AccountDataEntity).count(), 0);
  assert.equal((await login(service)).output.newUser, true);
});

test('expiry and recent-login requirement use server time', async () => {
  const { service } = application(),
    session = await login(service);

  now += 11 * 60_000;

  await assert.rejects(
    service.deleteAccount(
      request(
        {
          confirmation: '탈퇴',
        },
        session.headers,
      ),
      response().response,
    ),
    code('AUTH_REAUTH_REQUIRED'),
  );

  const input = await ticket(service);

  now += 121_000;

  await assert.rejects(
    service.exchange(
      request({
        ticket: input.ticket,
        verifier: input.verifier,
      }),
      response().response,
    ),
    code('AUTH_FLOW_EXPIRED'),
  );

  now += 8 * 86_400_000;

  await assert.rejects(service.me(request(undefined, session.headers)), code('AUTH_REQUIRED'));
});

test('Cloud Run instances share TypeORM auth throttling and support persists honest received status', async () => {
  const first = application({
      rateLimit: 2,
    }),
    second = application({
      rateLimit: 2,
    });

  await first.service.limit(request(), response().response);

  await second.service.limit(request(), response().response);

  const limited = response();

  await assert.rejects(first.service.limit(request(), limited.response), code('TOO_MANY_REQUESTS'));
  assert.ok(Number(limited.headers['Retry-After']) > 0);

  now += 15 * 60_000;

  await second.service.limit(request(), response().response);

  await assert.rejects(
    first.service.support(
      request({
        category: 'bug',
        message: '짧음',
      }),
    ),
    code('INVALID_INPUT'),
  );

  const result = await second.service.support(
    request({
      category: 'route',
      message: '이 경로의 환승 위치를 확인해 주세요.',
      email: 'reply@example.test',
    }),
  );

  assert.equal(result.status, 'received');
  assert.match(result.notice, /아직 연결되지/);
  assert.equal(await db.database.getRepository(SupportTicketEntity).countBy({ id: result.id }), 1);
});

test('Nest HTTP controllers preserve Apple form callback, safe errors, cookie CSRF and support status', async () => {
  const settings: AuthOptions = {
    config,
    now: () => now,
    adapters: [
      adapter({
        id: 'apple',
        identity: async () => ({
          ...identity,
          provider: 'apple',
        }),
      }),
    ],
  };

  const module = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      AuthService,
      AuthRepository,
      RateLimitService,
      {
        provide: DatabaseService,
        useValue: db.database,
      },
      {
        provide: AUTH_OPTIONS,
        useValue: settings,
      },
    ],
  }).compile();

  const app = module.createNestApplication({
    bodyParser: false,
    logger: false,
  });

  configureApplication(app, {
    DB_PASSWORD: 'test-only',
    CORS_ORIGINS: 'https://app.example.test',
    AUTH_PUBLIC_BASE_URL: config.publicBaseUrl,
    AUTH_WEB_RETURN_URL: config.webReturnUrl,
    AUTH_TOKEN_ENCRYPTION_KEY: config.encryptionKey,
  });

  await app.listen(0, '127.0.0.1');

  const origin = await app.getUrl();

  const json = (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${origin}/api${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
            }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    assert.equal((await json('/auth/providers')).status, 200);

    const verifier = randomToken();

    const start = await json(`/auth/apple/start?platform=web&challenge=${sha256(verifier)}`);

    assert.equal(start.status, 302);

    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;

    const callback = await fetch(`${origin}/api/auth/apple/callback`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Origin: 'https://appleid.apple.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        state,
        code: 'apple-code',
      }),
    });

    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('access-control-allow-origin'), null);

    const value = new URL(callback.headers.get('location')!).searchParams.get('auth_ticket');

    assert.ok(value);

    const exchange = await json(
      '/auth/exchange',
      'POST',
      {
        ticket: value,
        verifier,
      },
      {
        Origin: 'https://app.example.test',
      },
    );

    assert.equal(exchange.status, 200);

    const output = (await exchange.json()) as {
      csrfToken: string;
      token?: string;
    };

    assert.equal(output.token, undefined);

    const cookie = exchange.headers.get('set-cookie')!;

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);

    const headers = {
      Origin: 'https://app.example.test',
      Cookie: cookie.split(';')[0]!,
    };

    assert.equal((await json('/auth/consents', 'POST', consent, headers)).status, 403);

    const csrfHeaders = {
      ...headers,
      'X-CSRF-Token': output.csrfToken,
    };

    const outdated = await json(
      '/auth/consents',
      'POST',
      { termsVersion: '2026-10-02', privacyVersion: '2026-10-02', marketingConsent: false },
      csrfHeaders,
    );

    assert.equal(outdated.status, 403);
    assert.deepEqual(((await outdated.json()) as { error: { code: string; message: string } }).error, {
      code: 'CONSENT_REQUIRED',
      message: OUTDATED_CONSENT_MESSAGE,
    });
    assert.equal((await json('/auth/consents', 'POST', consent, csrfHeaders)).status, 200);

    const support = await json(
      '/support',
      'POST',
      {
        category: 'bug',
        message: '실제 문의를 접수하고 확인해 주세요.',
      },
      csrfHeaders,
    );

    assert.equal(support.status, 201);

    const denial = await json('/auth/me', 'GET', undefined, {
      Origin: 'https://evil.example',
    });

    assert.equal(denial.status, 403);
    assert.equal(((await denial.json()) as any).error.code, 'INVALID_INPUT');

    const malformed = await fetch(`${origin}/api/auth/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: '{',
    });

    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error.code, 'INVALID_INPUT');
    assert.equal((await json('/auth/logout', 'POST', {}, csrfHeaders)).status, 200);
    assert.equal((await json('/auth/me', 'GET', undefined, headers)).status, 401);
  } finally {
    await app.close();
  }
});
