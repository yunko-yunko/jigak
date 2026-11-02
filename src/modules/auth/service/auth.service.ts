import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import { AUTH_OPTIONS, type AuthOptions } from '../domain/auth.options.js';
import { createOAuthAdapters, socialConfigFromEnvironment } from '../domain/oauth.js';
import { randomToken, safeEqual, safeWebUrl } from '../domain/security.js';
import {
  CONSENT_VERSION,
  OUTDATED_CONSENT_MESSAGE,
  SOCIAL_PROVIDERS,
  type AuthPlatform,
  type OAuthAdapter,
} from '../domain/types.js';
import {
  callbackSchema,
  consentSchema,
  deleteAccountSchema,
  exchangeSchema,
  nameSchema,
  outdatedConsentSchema,
  parse,
  preferenceSchema,
  startSchema,
  supportSchema,
  tokenSchema,
  tripsSchema,
} from '../dto/auth.dto.js';
import { AuthRepository } from '../repository/auth.repository.js';

export const SESSION_COOKIE = 'jigakjido_session';
const providerSchema = z.enum(SOCIAL_PROVIDERS);

/** Account application operations; domain OAuth adapters never depend on Nest or HTTP routing. */
@Injectable()
export class AuthService {
  readonly webOrigin: string;
  readonly cookieOptions: CookieOptions;
  private readonly adapters: OAuthAdapter[];
  private readonly webReturn: URL;
  private readonly allowedOrigins: Set<string>;
  private readonly clock: () => number;
  private readonly rateLimit: number;

  constructor(
    @Inject(AuthRepository) readonly repository: AuthRepository,
    @Optional() @Inject(AUTH_OPTIONS) options?: AuthOptions,
  ) {
    const config = options?.config ?? socialConfigFromEnvironment();

    this.clock = options?.now ?? Date.now;
    this.adapters =
      options?.adapters ??
      createOAuthAdapters({
        config,
        now: this.clock,
        fetcher: options?.fetcher,
        keys: options?.keys,
      });

    this.webReturn = safeWebUrl(config.webReturnUrl, 'AUTH_WEB_RETURN_URL');
    this.webOrigin = this.webReturn.origin;

    const origins =
      options?.corsOrigins ??
      process.env.CORS_ORIGINS?.split(',')
        .map((value) => value.trim())
        .filter(Boolean) ??
      [];
    this.allowedOrigins = new Set([...origins, this.webOrigin]);

    this.cookieOptions = {
      path: '/api',
      httpOnly: true,
      secure: options?.cookieSecure ?? this.webReturn.protocol === 'https:',
      sameSite: 'lax',
    };
    this.rateLimit = options?.rateLimit ?? 60;
  }

  async limit(request: Request, response: Response) {
    // Only Express's configured proxy policy resolves IP; arbitrary forwarding headers are ignored here.
    const window = await this.repository.consumeRateLimit(
      request.ip ?? request.socket.remoteAddress ?? 'native',
    );

    if (window.count > this.rateLimit) {
      response.setHeader('Retry-After', window.retryAfterSeconds);

      throw new ApiError(
        'TOO_MANY_REQUESTS',
        '로그인 요청이 많아요. 잠시 후 다시 시도해 주세요.',
        429,
      );
    }
  }

  providers() {
    return {
      providers: SOCIAL_PROVIDERS.map((id) => {
        const provider = this.adapters.find((value) => value.id === id);

        return {
          id,
          name: provider?.name || id,
          available: Boolean(provider?.configured),
          reason: provider?.configured ? null : '소셜 로그인을 준비 중이에요.',
        };
      }),
      termsVersion: CONSENT_VERSION,
      privacyVersion: CONSENT_VERSION,
    };
  }

  private providerFor(value: unknown) {
    const id = parse(providerSchema, value);
    const adapter = this.adapters.find((provider) => provider.id === id);

    if (!adapter?.configured) {
      throw new ApiError(
        'SOCIAL_NOT_CONFIGURED',
        '소셜 로그인을 준비 중이에요. 지금은 비회원으로 이용할 수 있어요.',
        503,
      );
    }

    return adapter;
  }

  async start(provider: string, query: unknown) {
    const adapter = this.providerFor(provider),
      input = parse(startSchema, query),
      state = randomToken();

    const transaction = {
      provider: adapter.id,
      platform: input.platform,
      challenge: input.challenge,
      nonce: randomToken(),
      verifier: randomToken(),
      expiresAt: this.clock() + 5 * 60_000,
    };
    const url = adapter.authorizationUrl(state, transaction);

    await this.repository.putOAuthState(state, transaction);

    return url;
  }

  private callbackUrl(platform: AuthPlatform, key: 'auth_ticket' | 'auth_error', value: string) {
    const url = platform === 'native' ? new URL('jigakjido://auth') : new URL(this.webReturn.href);
    url.searchParams.set(key, value);

    return url.href;
  }

  async callback(provider: string, body: unknown) {
    let platform: AuthPlatform | undefined;

    try {
      const adapter = this.providerFor(provider),
        input = parse(callbackSchema, body);

      const transaction = await this.repository.consumeOAuthState(input.state, adapter.id);
      platform = transaction.platform;

      if (input.error || !input.code) {
        throw new ApiError('SOCIAL_CANCELLED', '소셜 로그인이 취소됐어요.', 400);
      }

      let appleUser: unknown;

      if (adapter.id === 'apple' && input.user) {
        try {
          appleUser = JSON.parse(input.user);
        } catch {
          /* A display name never authenticates an account. */
        }
      }

      const identity = await adapter.identity(input.code, transaction, appleUser);

      if (identity.provider !== adapter.id) {
        throw new ApiError('SOCIAL_AUTH_FAILED', '로그인 제공사를 확인하지 못했어요.', 401);
      }

      const { user, newUser } = await this.repository.socialAccount(identity);
      const ticket = await this.repository.issueTicket(
        user.id,
        transaction.challenge,
        transaction.platform,
        newUser,
      );

      return this.callbackUrl(transaction.platform, 'auth_ticket', ticket);
    } catch (error) {
      if (!platform) {
        throw error;
      }

      return this.callbackUrl(
        platform,
        'auth_error',
        error instanceof ApiError ? error.code : 'SOCIAL_AUTH_FAILED',
      );
    }
  }

  private deviceLabel(request: Request) {
    const agent = request.get('user-agent') || '';

    return /iPhone|iPad/i.test(agent)
      ? 'iPhone · iPad'
      : /Android/i.test(agent)
        ? 'Android'
        : /Mozilla|Chrome|Safari|Firefox/i.test(agent)
          ? '웹 브라우저'
          : '앱';
  }

  private cookieToken(request: Request) {
    for (const part of (request.get('cookie') || '').split(';')) {
      const [name, ...value] = part.trim().split('=');

      if (name === SESSION_COOKIE) {
        return value.join('=');
      }
    }

    return undefined;
  }

  async exchange(request: Request, response: Response) {
    const input = parse(exchangeSchema, request.body);

    const result = await this.repository.exchangeTicket(
      input.ticket,
      input.verifier,
      this.deviceLabel(request),
      Boolean(request.get('origin') && this.allowedOrigins.has(request.get('origin')!)),
    );

    const body = {
      user: result.user,
      expiresAt: result.expiresAt,
      newUser: result.newUser,
      needsConsent: result.needsConsent,
    };

    if (result.platform === 'web') {
      response.cookie(SESSION_COOKIE, result.token, {
        ...this.cookieOptions,
        maxAge: result.expiresAt - this.clock(),
      });

      return {
        ...body,
        csrfToken: result.csrfToken,
      };
    }

    return {
      ...body,
      token: result.token,
    };
  }

  async authenticate(request: Request, mutation = false, allowPending = false) {
    const authorization = request.get('authorization');
    const token = authorization
      ? parse(
          z.string().regex(/^Bearer [A-Za-z0-9_-]{43}$/),
          authorization,
          '다시 로그인해 주세요.',
        ).slice(7)
      : this.cookieToken(request);

    if (!token || !tokenSchema.safeParse(token).success) {
      throw new ApiError('AUTH_REQUIRED', '로그인 후 이용할 수 있어요.', 401);
    }

    const session = await this.repository.session(token),
      user = await this.repository.user(session.userId),
      source = authorization ? 'bearer' : 'cookie';

    if (source === 'cookie' && mutation) {
      const origin = request.get('origin'),
        csrf = request.get('x-csrf-token');

      if (
        !origin ||
        !this.allowedOrigins.has(origin) ||
        !csrf ||
        !safeEqual(csrf, session.csrfToken)
      ) {
        throw new ApiError(
          'AUTH_CSRF',
          '요청을 확인하지 못했어요. 화면을 새로 열고 다시 시도해 주세요.',
          403,
        );
      }
    }

    if (!allowPending && user.needsConsent) {
      throw new ApiError('CONSENT_REQUIRED', '필수 약관에 동의한 뒤 이용할 수 있어요.', 403);
    }

    return {
      session,
      user,
      source,
    };
  }

  async me(request: Request) {
    const { session, user, source } = await this.authenticate(request, false, true);

    return {
      user,
      expiresAt: session.expiresAt,
      ...(source === 'cookie'
        ? {
            csrfToken: session.csrfToken,
          }
        : {}),
    };
  }

  async updateName(request: Request) {
    const { session } = await this.authenticate(request, true),
      input = parse(nameSchema, request.body, '이름은 1~40자로 입력해 주세요.');

    return {
      user: await this.repository.updateName(session.userId, input.name),
    };
  }

  async consents(request: Request) {
    const { session } = await this.authenticate(request, true, true);

    if (outdatedConsentSchema.safeParse(request.body).success) {
      throw new ApiError('CONSENT_REQUIRED', OUTDATED_CONSENT_MESSAGE, 403);
    }

    const input = parse(consentSchema, request.body, '필수 이용약관과 개인정보 동의를 확인해 주세요.');

    return {
      user: await this.repository.acceptConsents(session.userId, input.marketingConsent),
    };
  }

  async sessions(request: Request) {
    const { session } = await this.authenticate(request);

    return {
      sessions: await this.repository.sessions(session.userId, session.id),
    };
  }

  async revokeSession(request: Request, response: Response, sessionId: string) {
    const { session } = await this.authenticate(request, true),
      id = parse(z.uuid(), sessionId);

    await this.repository.revokeSession(session.userId, id);

    if (session.id === id) {
      response.clearCookie(SESSION_COOKIE, this.cookieOptions);
    }

    return {
      ok: true,
    };
  }

  async logout(request: Request, response: Response) {
    const { session } = await this.authenticate(request, true, true);

    await this.repository.revokeSession(session.userId, session.id);

    response.clearCookie(SESSION_COOKIE, this.cookieOptions);

    return {
      ok: true,
    };
  }

  async deleteAccount(request: Request, response: Response) {
    const { session } = await this.authenticate(request, true, true);

    parse(deleteAccountSchema, request.body, '탈퇴 확인 문구를 입력해 주세요.');

    if (this.clock() - session.createdAt > 10 * 60_000) {
      throw new ApiError('AUTH_REAUTH_REQUIRED', '계정을 삭제하려면 다시 로그인해 주세요.', 403);
    }

    for (const identity of await this.repository.identities(session.userId)) {
      await this.providerFor(identity.provider).revoke(identity);
    }

    await this.repository.deleteAccount(session.userId);

    response.clearCookie(SESSION_COOKIE, this.cookieOptions);

    return {
      ok: true,
    };
  }

  async preferences(request: Request) {
    const { session } = await this.authenticate(request);

    return {
      preferences: await this.repository.preferences(session.userId),
    };
  }

  async savePreferences(request: Request) {
    const { session } = await this.authenticate(request, true),
      input = parse(preferenceSchema, request.body);

    await this.repository.savePreferences(session.userId, input);

    return {
      preferences: input,
    };
  }

  async trips(request: Request) {
    const { session } = await this.authenticate(request);

    return this.repository.trips(session.userId);
  }

  async saveTrips(request: Request) {
    const { session } = await this.authenticate(request, true),
      input = parse(tripsSchema, request.body);

    await this.repository.saveTrips(session.userId, input);

    return input;
  }

  async support(request: Request) {
    const input = parse(
      supportSchema,
      request.body,
      '문의 종류와 10~2,000자의 내용을 확인해 주세요.',
    );

    const hasAuth = Boolean(request.get('authorization') || this.cookieToken(request));
    const userId = hasAuth ? (await this.authenticate(request, true, true)).session.userId : null;

    return {
      ...(await this.repository.supportTicket(userId, input.category, input.message, input.email)),
      notice:
        '문의가 이 서버에 접수됐어요. 자동 메일 발송과 고객센터 답변 서비스는 아직 연결되지 않았어요.',
    };
  }
}
