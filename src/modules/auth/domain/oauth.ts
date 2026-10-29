import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import { safeEqual, safeWebUrl, sha256 } from './security.js';
import type { OAuthAdapter, OAuthState, SocialIdentity, SocialProviderId } from './types.js';

export interface SocialConfig {
  publicBaseUrl: string;
  webReturnUrl: string;
  encryptionKey?: string;
  google?: {
    clientId: string;
    clientSecret: string;
  };
  kakao?: {
    clientId: string;
    clientSecret: string;
    oidc?: boolean;
  };
  apple?: {
    clientId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
  };
}

export interface OAuthOptions {
  config: SocialConfig;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Test-only injectable key resolver; default always uses each provider's pinned HTTPS JWKS. */
  keys?: Partial<Record<SocialProviderId, JWTVerifyGetKey>>;
}

const names = {
  kakao: '카카오',
  google: 'Google',
  apple: 'Apple',
};

const authEndpoints = {
  kakao: 'https://kauth.kakao.com/oauth/authorize',
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  apple: 'https://appleid.apple.com/auth/authorize',
};

const tokenEndpoints = {
  kakao: 'https://kauth.kakao.com/oauth/token',
  google: 'https://oauth2.googleapis.com/token',
  apple: 'https://appleid.apple.com/auth/token',
};

const remoteKeys: Record<SocialProviderId, JWTVerifyGetKey> = {
  google: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    timeoutDuration: 8_000,
  }),
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
    timeoutDuration: 8_000,
  }),
  kakao: createRemoteJWKSet(new URL('https://kauth.kakao.com/.well-known/jwks.json'), {
    timeoutDuration: 8_000,
  }),
};

const tokenSchema = z
  .object({
    access_token: z.string().min(1).max(16_000).optional(),
    refresh_token: z.string().min(1).max(16_000).optional(),
    id_token: z.string().min(1).max(24_000).optional(),
    expires_in: z.number().positive().optional(),
  })
  .passthrough();

const nameValue = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 40)
    : '';

const emailValue = (value: unknown) =>
  typeof value === 'string' && z.email().safeParse(value).success
    ? value.toLowerCase().slice(0, 254)
    : null;

const verifiedValue = (value: unknown) => value === true || value === 'true';

export function socialConfigFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): SocialConfig {
  const publicBaseUrl = safeWebUrl(
    env.AUTH_PUBLIC_BASE_URL || 'http://localhost:8080',
    'AUTH_PUBLIC_BASE_URL',
  ).href.replace(/\/$/, '');
  const webReturnUrl = safeWebUrl(
    env.AUTH_WEB_RETURN_URL || 'http://localhost:8081/',
    'AUTH_WEB_RETURN_URL',
  ).href;
  const encryptionKey = env.AUTH_TOKEN_ENCRYPTION_KEY;

  return {
    publicBaseUrl,
    webReturnUrl,
    encryptionKey,
    google:
      env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          }
        : undefined,
    // Map search credentials alone never enable login. Login must be configured independently.
    kakao:
      env.KAKAO_LOGIN_REST_API_KEY && env.KAKAO_LOGIN_CLIENT_SECRET
        ? {
            clientId: env.KAKAO_LOGIN_REST_API_KEY,
            clientSecret: env.KAKAO_LOGIN_CLIENT_SECRET,
            oidc: env.KAKAO_LOGIN_OIDC === 'true',
          }
        : undefined,
    apple:
      env.APPLE_SERVICE_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY
        ? {
            clientId: env.APPLE_SERVICE_ID,
            teamId: env.APPLE_TEAM_ID,
            keyId: env.APPLE_KEY_ID,
            privateKey: env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          }
        : undefined,
  };
}

export function createOAuthAdapters(options: OAuthOptions): OAuthAdapter[] {
  const { config } = options;

  safeWebUrl(config.publicBaseUrl, 'AUTH_PUBLIC_BASE_URL');
  safeWebUrl(config.webReturnUrl, 'AUTH_WEB_RETURN_URL');

  const fetcher = options.fetcher ?? fetch;
  const clock = options.now ?? Date.now;
  const providerKeys = {
    ...remoteKeys,
    ...options.keys,
  };

  async function request(url: string, init: RequestInit) {
    let response: Response;

    try {
      response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(
        'SOCIAL_UNAVAILABLE',
        '로그인 제공사에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.',
        502,
      );
    }

    if (!response.ok) {
      throw new ApiError(
        'SOCIAL_AUTH_FAILED',
        '소셜 로그인을 확인하지 못했어요. 다시 로그인해 주세요.',
        502,
      );
    }

    return response;
  }

  async function requestJson(url: string, init: RequestInit) {
    const response = await request(url, init);

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ApiError(
        'SOCIAL_AUTH_FAILED',
        '로그인 응답을 확인하지 못했어요. 다시 시작해 주세요.',
        502,
      );
    }
  }

  async function appleSecret() {
    if (!config.apple) {
      throw new ApiError('SOCIAL_NOT_CONFIGURED', 'Apple 로그인을 준비 중이에요.', 503);
    }

    const key = await importPKCS8(config.apple.privateKey, 'ES256');

    return new SignJWT({})
      .setProtectedHeader({
        alg: 'ES256',
        kid: config.apple.keyId,
      })
      .setIssuer(config.apple.teamId)
      .setSubject(config.apple.clientId)
      .setAudience('https://appleid.apple.com')
      .setIssuedAt(Math.floor(clock() / 1_000))
      .setExpirationTime(Math.floor(clock() / 1_000) + 300)
      .sign(key);
  }

  async function verifyIdentity(
    idToken: string | undefined,
    provider: SocialProviderId,
    nonce: string,
    clientId: string,
  ) {
    if (!idToken) {
      throw new ApiError(
        'SOCIAL_AUTH_FAILED',
        '로그인 인증 정보가 없어요. 다시 시작해 주세요.',
        502,
      );
    }

    const issuer =
      provider === 'google'
        ? ['https://accounts.google.com', 'accounts.google.com']
        : provider === 'apple'
          ? 'https://appleid.apple.com'
          : 'https://kauth.kakao.com';

    try {
      const { payload } = await jwtVerify(idToken, providerKeys[provider], {
        issuer,
        audience: clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        currentDate: new Date(clock()),
        clockTolerance: 5,
        maxTokenAge: '10m',
      });

      if (
        !payload.sub ||
        payload.sub.length > 300 ||
        typeof payload.nonce !== 'string' ||
        !safeEqual(payload.nonce, nonce)
      ) {
        throw new Error('Invalid OIDC nonce or subject.');
      }

      if (provider === 'google' && payload.azp !== undefined && payload.azp !== clientId) {
        throw new Error('Unexpected authorized party.');
      }

      return payload;
    } catch {
      throw new ApiError(
        'SOCIAL_AUTH_FAILED',
        '로그인 인증이 유효하지 않아요. 다시 시작해 주세요.',
        401,
      );
    }
  }

  return (['kakao', 'google', 'apple'] as const).map((id) => {
    const settings = config[id];
    const clientId = settings?.clientId ?? '';
    const redirectUri = `${config.publicBaseUrl}/api/auth/${id}/callback`;

    // Apple requires a public HTTPS return URL registered with its Services ID.
    const configured = Boolean(
      settings && config.encryptionKey && (id !== 'apple' || redirectUri.startsWith('https://')),
    );

    const ensure = () => {
      if (!configured) {
        throw new ApiError(
          'SOCIAL_NOT_CONFIGURED',
          `${names[id]} 로그인을 준비 중이에요. 지금은 비회원으로 이용할 수 있어요.`,
          503,
        );
      }
    };

    return {
      id,
      name: names[id],
      configured,

      authorizationUrl(state, transaction) {
        ensure();

        const url = new URL(authEndpoints[id]);
        url.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          state,
          nonce: transaction.nonce,
        }).toString();

        if (id === 'google' || id === 'kakao') {
          url.searchParams.set('code_challenge', sha256(transaction.verifier));
          url.searchParams.set('code_challenge_method', 'S256');
        }

        if (id === 'google') {
          url.searchParams.set('scope', 'openid email profile');
          url.searchParams.set('prompt', 'select_account');
        }

        if (id === 'apple') {
          url.searchParams.set('scope', 'name email');
          url.searchParams.set('response_mode', 'form_post');
        }

        if (id === 'kakao' && config.kakao?.oidc) {
          url.searchParams.set('scope', 'openid');
        }

        return url.href;
      },

      async identity(code, transaction, appleUser) {
        ensure();

        const parameters = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: redirectUri,
          code,
        });

        if (id === 'google') {
          parameters.set('client_secret', config.google!.clientSecret);
          parameters.set('code_verifier', transaction.verifier);
        }

        if (id === 'kakao') {
          parameters.set('client_secret', config.kakao!.clientSecret);
          parameters.set('code_verifier', transaction.verifier);
        }

        if (id === 'apple') {
          parameters.set('client_secret', await appleSecret());
        }

        const parsed = tokenSchema.safeParse(
          await requestJson(tokenEndpoints[id], {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: parameters,
          }),
        );

        if (!parsed.success) {
          throw new ApiError('SOCIAL_AUTH_FAILED', '로그인 토큰 응답을 확인하지 못했어요.', 502);
        }

        const tokens = parsed.data;
        const grant: SocialIdentity['grant'] = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in ? clock() + tokens.expires_in * 1_000 : undefined,
        };

        if (id === 'kakao') {
          if (!tokens.access_token) {
            throw new ApiError('SOCIAL_AUTH_FAILED', '카카오 인증 정보를 확인하지 못했어요.', 502);
          }

          const data = await requestJson('https://kapi.kakao.com/v2/user/me', {
            headers: {
              Authorization: `Bearer ${tokens.access_token}`,
            },
          });
          const user = z
            .object({
              id: z.union([z.number().int().positive().safe(), z.string().regex(/^\d+$/)]),
              kakao_account: z
                .object({
                  email: z.string().optional(),
                  is_email_verified: z.boolean().optional(),
                  is_email_valid: z.boolean().optional(),
                  profile: z
                    .object({
                      nickname: z.string().optional(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .passthrough()
            .safeParse(data);

          if (!user.success) {
            throw new ApiError('SOCIAL_AUTH_FAILED', '카카오 계정 정보를 확인하지 못했어요.', 502);
          }

          if (config.kakao?.oidc) {
            const claims = await verifyIdentity(tokens.id_token, id, transaction.nonce, clientId);

            if (claims.sub !== String(user.data.id)) {
              throw new ApiError(
                'SOCIAL_AUTH_FAILED',
                '카카오 계정 인증 정보가 일치하지 않아요.',
                401,
              );
            }
          }

          const account = user.data.kakao_account;
          const email = account?.is_email_valid ? emailValue(account.email) : null;

          return {
            provider: id,
            subject: String(user.data.id),
            name: nameValue(account?.profile?.nickname) || '사용자',
            email,
            emailVerified: Boolean(email && account?.is_email_verified),
            grant,
          };
        }

        const claims = await verifyIdentity(tokens.id_token, id, transaction.nonce, clientId);
        let name = nameValue(claims.name);

        if (id === 'apple' && appleUser && typeof appleUser === 'object' && 'name' in appleUser) {
          const first = (
            appleUser as {
              name?: {
                firstName?: unknown;
                lastName?: unknown;
              };
            }
          ).name;
          name = nameValue(
            [nameValue(first?.lastName), nameValue(first?.firstName)].filter(Boolean).join(' '),
          );
        }

        const email = emailValue(claims.email);

        return {
          provider: id,
          subject: claims.sub!,
          name: name || '사용자',
          email,
          emailVerified: Boolean(email && verifiedValue(claims.email_verified)),
          grant,
        };
      },

      async revoke(identity) {
        ensure();

        const grant = identity.grant;

        if (!grant?.accessToken && !grant?.refreshToken) {
          throw new ApiError(
            'SOCIAL_AUTH_FAILED',
            '계정 연결을 해제하려면 다시 로그인해 주세요.',
            409,
          );
        }

        if (id === 'google') {
          await request('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              token: grant.refreshToken || grant.accessToken!,
            }),
          });
        } else if (id === 'apple') {
          await request('https://appleid.apple.com/auth/revoke', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: await appleSecret(),
              token: grant.refreshToken || grant.accessToken!,
              token_type_hint: grant.refreshToken ? 'refresh_token' : 'access_token',
            }),
          });
        } else {
          let accessToken = grant.accessToken;

          if ((!accessToken || (grant.expiresAt ?? 0) <= clock()) && grant.refreshToken) {
            const refreshed = tokenSchema.safeParse(
              await requestJson(tokenEndpoints.kakao, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  grant_type: 'refresh_token',
                  client_id: clientId,
                  client_secret: config.kakao!.clientSecret,
                  refresh_token: grant.refreshToken,
                }),
              }),
            );

            if (!refreshed.success || !refreshed.data.access_token) {
              throw new ApiError(
                'SOCIAL_AUTH_FAILED',
                '카카오 연결을 해제하려면 다시 로그인해 주세요.',
                409,
              );
            }

            accessToken = refreshed.data.access_token;
          }

          await request('https://kapi.kakao.com/v1/user/unlink', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });
        }
      },
    } satisfies OAuthAdapter;
  });
}
