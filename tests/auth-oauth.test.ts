import assert from 'node:assert/strict';
import test from 'node:test';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import {
  createOAuthAdapters,
  socialConfigFromEnvironment,
} from '../src/modules/auth/domain/oauth.js';
import { randomToken, sha256 } from '../src/modules/auth/domain/security.js';
import type { OAuthState } from '../src/modules/auth/domain/types.js';
import { ApiError } from '../src/common/errors.js';

const now = Date.now();

const state: OAuthState = {
  provider: 'google',
  platform: 'native',
  challenge: sha256(randomToken()),
  nonce: randomToken(),
  verifier: randomToken(),
  expiresAt: now + 5 * 60_000,
};

const config = {
  publicBaseUrl: 'https://api.example.test',
  webReturnUrl: 'https://app.example.test/',
  encryptionKey: Buffer.alloc(32, 1).toString('base64'),
  google: {
    clientId: 'client-id',
    clientSecret: 'private-google-secret',
  },
  kakao: {
    clientId: 'login-rest-key',
    clientSecret: 'private-kakao-secret',
  },
};

test('provider authorization pins callback and state; Google and Kakao use provider PKCE independently of the client verifier', () => {
  const adapters = createOAuthAdapters({
    config,
    now: () => now,
  });
  const url = new URL(adapters[1].authorizationUrl('state-value', state));

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://api.example.test/api/auth/google/callback',
  );
  assert.equal(url.searchParams.get('nonce'), state.nonce);
  assert.equal(url.searchParams.get('code_challenge'), sha256(state.verifier));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.href.includes('private-google-secret'), false);
  assert.equal(
    new URL(
      adapters[0].authorizationUrl('s', {
        ...state,
        provider: 'kakao',
      }),
    ).searchParams.get('code_challenge_method'),
    'S256',
  );
  assert.equal(adapters[2].configured, false);
});

test('Google verifies actual JWT signature, issuer, audience, nonce and time; bad tokens cannot become identities', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');

  async function token(claims: Record<string, unknown> = {}) {
    return new SignJWT({
      nonce: state.nonce,
      name: '준서',
      email: 'junseo@example.test',
      email_verified: true,
      ...claims,
    })
      .setProtectedHeader({
        alg: 'RS256',
      })
      .setIssuer(String(claims.iss ?? 'https://accounts.google.com'))
      .setAudience(String(claims.aud ?? 'client-id'))
      .setSubject('verified-google-user')
      .setIssuedAt(Math.floor(now / 1_000))
      .setExpirationTime(Number(claims.exp ?? Math.floor(now / 1_000) + 300))
      .sign(privateKey);
  }

  let idToken = await token();

  let lastBody = new URLSearchParams();
  const adapter = createOAuthAdapters({
    config,
    now: () => now,
    keys: {
      google: async () => publicKey,
    },
    fetcher: async (_url, init) => {
      lastBody = new URLSearchParams(String(init?.body));

      return new Response(
        JSON.stringify({
          id_token: idToken,
          access_token: 'provider-access',
          refresh_token: 'provider-refresh',
          expires_in: 3_600,
        }),
      );
    },
  })[1];

  const identity = await adapter.identity('auth-code', state);

  assert.equal(identity.subject, 'verified-google-user');
  assert.equal(identity.emailVerified, true);
  assert.equal(lastBody.get('code_verifier'), state.verifier);
  assert.equal(lastBody.get('client_secret'), 'private-google-secret');

  for (const claims of [
    {
      nonce: 'wrong-nonce',
    },
    {
      iss: 'https://evil.example',
    },
    {
      aud: 'wrong-client',
    },
    {
      exp: Math.floor(now / 1_000) - 300,
    },
    {
      azp: 'other-client',
    },
  ]) {
    idToken = await token(claims);

    await assert.rejects(
      adapter.identity('code', state),
      (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AUTH_FAILED',
    );
  }

  const otherKeys = await generateKeyPair('RS256');

  idToken = await new SignJWT({
    nonce: state.nonce,
  })
    .setProtectedHeader({
      alg: 'RS256',
    })
    .setIssuer('https://accounts.google.com')
    .setAudience('client-id')
    .setSubject('attacker')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(otherKeys.privateKey);

  await assert.rejects(
    adapter.identity('code', state),
    (error: unknown) => error instanceof ApiError && error.code === 'SOCIAL_AUTH_FAILED',
  );
});

test('Kakao calls user/me on the server, preserves a stable provider identity and does not mark a missing email as verified', async () => {
  const calls: {
    url: string;
    headers: Headers;
  }[] = [];
  const adapter = createOAuthAdapters({
    config,
    now: () => now,
    fetcher: async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
      });

      return new Response(
        JSON.stringify(
          String(url).includes('/token')
            ? {
                access_token: 'private-access',
                refresh_token: 'private-refresh',
                expires_in: 3_600,
              }
            : {
                id: 123456,
                kakao_account: {
                  profile: {
                    nickname: '준서',
                  },
                },
              },
        ),
      );
    },
  })[0];

  const identity = await adapter.identity('code', {
    ...state,
    provider: 'kakao',
  });

  assert.equal(identity.subject, '123456');
  assert.equal(identity.email, null);
  assert.equal(identity.emailVerified, false);
  assert.equal(calls[1].url, 'https://kapi.kakao.com/v2/user/me');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer private-access');

  await adapter.revoke(identity);

  assert.equal(calls.at(-1)?.url, 'https://kapi.kakao.com/v1/user/unlink');
});

test('Apple creates an ES256 client secret and validates the RS256 identity token before using the optional first-login name', async () => {
  const clientKeys = await generateKeyPair('ES256', {
    extractable: true,
  });

  const identityKeys = await generateKeyPair('RS256');

  const appleConfig = {
    ...config,
    apple: {
      clientId: 'apple-service-id',
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKey: await exportPKCS8(clientKeys.privateKey),
    },
  };

  const idToken = await new SignJWT({
    nonce: state.nonce,
    email: 'relay@privaterelay.appleid.com',
    email_verified: 'true',
  })
    .setProtectedHeader({
      alg: 'RS256',
    })
    .setIssuer('https://appleid.apple.com')
    .setAudience('apple-service-id')
    .setSubject('apple-subject')
    .setIssuedAt(Math.floor(now / 1_000))
    .setExpirationTime(Math.floor(now / 1_000) + 300)
    .sign(identityKeys.privateKey);

  let clientSecret = '';
  const adapter = createOAuthAdapters({
    config: appleConfig,
    now: () => now,
    keys: {
      apple: async () => identityKeys.publicKey,
    },
    fetcher: async (_url, init) => {
      clientSecret = new URLSearchParams(String(init?.body)).get('client_secret')!;

      return new Response(
        JSON.stringify({
          id_token: idToken,
          refresh_token: 'private-apple-refresh',
        }),
      );
    },
  })[2];
  const auth = new URL(
    adapter.authorizationUrl('state', {
      ...state,
      provider: 'apple',
    }),
  );

  assert.equal(auth.searchParams.get('response_mode'), 'form_post');
  assert.equal(auth.searchParams.get('code_challenge'), null);

  const identity = await adapter.identity(
    'code',
    {
      ...state,
      provider: 'apple',
    },
    {
      name: {
        lastName: '윤',
        firstName: '준서',
      },
      email: 'attacker@example.test',
    },
  );

  assert.equal(identity.subject, 'apple-subject');
  assert.equal(identity.name, '윤 준서');
  assert.equal(identity.email, 'relay@privaterelay.appleid.com');

  const claims = await jwtVerify(clientSecret, clientKeys.publicKey, {
    algorithms: ['ES256'],
    issuer: 'TEAMID1234',
    audience: 'https://appleid.apple.com',
    currentDate: new Date(now),
  });

  assert.equal(claims.payload.sub, 'apple-service-id');
  assert.equal(claims.protectedHeader.kid, 'KEYID12345');
});

test('provider failures do not leak remote responses, tokens, client secrets or arbitrary callback addresses', async () => {
  const adapter = createOAuthAdapters({
    config,
    fetcher: async () =>
      new Response('private-google-secret raw-provider-body', {
        status: 401,
      }),
  })[1];

  await assert.rejects(
    adapter.identity('code', state),
    (error: unknown) =>
      error instanceof ApiError &&
      !error.message.includes('private-google-secret') &&
      !error.message.includes('raw-provider-body'),
  );
  assert.throws(() =>
    socialConfigFromEnvironment({
      AUTH_WEB_RETURN_URL: 'https://evil.example/?redirect=foo',
    }),
  );
  assert.throws(() =>
    socialConfigFromEnvironment({
      AUTH_PUBLIC_BASE_URL: 'http://public.example',
    }),
  );

  const configOnlyMapKey = socialConfigFromEnvironment({
    KAKAO_REST_API_KEY: 'map-only',
  });

  assert.equal(configOnlyMapKey.kakao, undefined);
});
