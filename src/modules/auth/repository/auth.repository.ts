import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  type EntityManager,
  type QueryDeepPartialEntity,
} from 'typeorm';
import { DatabaseService } from '../../../common/database/database.service.js';
import { ApiError } from '../../../common/errors.js';
import { AUTH_OPTIONS, type AuthOptions } from '../domain/auth.options.js';
import { createCipher, randomToken, safeEqual, sha256 } from '../domain/security.js';
import {
  CONSENT_VERSION,
  type AccountUser,
  type AuthSession,
  type OAuthState,
  type SocialIdentity,
  type SocialProviderId,
} from '../domain/types.js';
import {
  AccountDataEntity,
  AuthRateWindowEntity,
  AuthTicketEntity,
  OAuthStateEntity,
  SessionEntity,
  SocialIdentityEntity,
  SupportTicketEntity,
  UserEntity,
  type AccountDataRecord,
} from './entities/index.js';

const DAY_MS = 24 * 60 * 60_000;

/** TypeORM persistence for the account aggregate and single-use login capabilities. */
@Injectable()
export class AuthRepository {
  private readonly cipher: ReturnType<typeof createCipher>;
  private readonly clock: () => number;

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Optional() @Inject(AUTH_OPTIONS) options?: AuthOptions,
  ) {
    this.clock = options?.now ?? Date.now;
    this.cipher = createCipher(
      options?.config?.encryptionKey ?? process.env.AUTH_TOKEN_ENCRYPTION_KEY,
    );
  }

  async cleanup() {
    const now = this.clock();

    await this.db.transaction(async (manager) => {
      await manager.delete(SessionEntity, { expiresAt: LessThanOrEqual(now) });
      await manager.delete(OAuthStateEntity, { expiresAt: LessThanOrEqual(now) });
      await manager.delete(AuthTicketEntity, { expiresAt: LessThanOrEqual(now) });
      await manager.delete(UserEntity, {
        acceptedAt: IsNull(),
        createdAt: LessThan(now - DAY_MS),
      });
      await manager.delete(SupportTicketEntity, { createdAt: LessThan(now - 90 * DAY_MS) });
      await manager.delete(AuthRateWindowEntity, { resetAt: LessThanOrEqual(now) });
    });
  }

  async consumeRateLimit(clientAddress: string) {
    const now = this.clock();

    const clientHash = sha256(clientAddress);

    return this.db.transaction(async (manager) => {
      // Lock the logical key even when its rate window has not been created yet.
      await this.db.lock(manager, `auth-rate:${clientHash}`);

      const repository = manager.getRepository(AuthRateWindowEntity);
      const existing = await repository.findOneBy({ clientHash });
      const expired = !existing || existing.resetAt <= now;
      const window = repository.create({
        clientHash,
        resetAt: expired ? now + 15 * 60_000 : existing.resetAt,
        requestCount: expired ? 1 : existing.requestCount + 1,
      });

      await repository.save(window);

      return {
        count: window.requestCount,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)),
      };
    });
  }

  async putOAuthState(state: string, data: OAuthState) {
    await this.cleanup();
    await this.db.getRepository(OAuthStateEntity).insert({
      stateHash: sha256(state),
      provider: data.provider,
      encryptedData: this.cipher.encrypt(data),
      expiresAt: data.expiresAt,
    });
  }

  async consumeOAuthState(state: string, provider: SocialProviderId): Promise<OAuthState> {
    const stateHash = sha256(state);

    // A row lock makes consumption atomic across Cloud Run instances.
    const row = await this.db.transaction(async (manager) => {
      const repository = manager.getRepository(OAuthStateEntity);
      const existing = await repository.findOne({
        where: { stateHash, provider },
        lock: { mode: 'pessimistic_write' },
      });

      if (existing) {
        await repository.delete({ stateHash });
      }

      return existing;
    });

    if (!row || row.expiresAt <= this.clock()) {
      throw new ApiError('AUTH_FLOW_EXPIRED', '로그인 요청이 만료됐어요. 다시 시작해 주세요.', 400);
    }

    return this.cipher.decrypt<OAuthState>(row.encryptedData);
  }

  async socialAccount(identity: SocialIdentity) {
    return this.db.transaction(async (manager) => {
      // Serialize first login for a provider subject without merging equal emails.
      await this.db.lock(manager, `social:${identity.provider}:${identity.subject}`);

      const identities = manager.getRepository(SocialIdentityEntity);
      const existing = await identities.findOneBy({
        provider: identity.provider,
        subject: identity.subject,
      });
      const newUser = !existing;
      const userId = existing?.userId ?? randomUUID();

      if (newUser) {
        await manager.insert(UserEntity, {
          id: userId,
          name: identity.name,
          email: identity.email,
          emailVerified: identity.emailVerified,
          createdAt: this.clock(),
        });
        await identities.insert({
          provider: identity.provider,
          subject: identity.subject,
          userId,
          encryptedGrant: identity.grant ? this.cipher.encrypt(identity.grant) : null,
        });
      } else if (identity.grant) {
        await identities.update(
          { provider: identity.provider, subject: identity.subject },
          { encryptedGrant: this.cipher.encrypt(identity.grant) },
        );
      }

      return {
        user: await this.user(userId, manager),
        newUser,
      };
    });
  }

  async user(userId: string, manager: EntityManager = this.db.manager): Promise<AccountUser> {
    const row = await manager.getRepository(UserEntity).findOneBy({ id: userId });

    if (!row) {
      throw new ApiError('AUTH_REQUIRED', '다시 로그인해 주세요.', 401);
    }

    const providers = await manager.getRepository(SocialIdentityEntity).find({
      select: { provider: true },
      where: { userId },
      order: { provider: 'ASC' },
    });

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      createdAt: row.createdAt,
      needsConsent: row.termsVersion !== CONSENT_VERSION || row.privacyVersion !== CONSENT_VERSION,
      providers: providers.map((value) => value.provider),
      consents: {
        termsVersion: row.termsVersion,
        privacyVersion: row.privacyVersion,
        marketingConsent: row.marketingConsent,
        acceptedAt: row.acceptedAt,
      },
    };
  }

  async issueTicket(
    userId: string,
    challenge: string,
    platform: 'web' | 'native',
    newUser: boolean,
  ) {
    const ticket = randomToken();

    await this.db.getRepository(AuthTicketEntity).insert({
      ticketHash: sha256(ticket),
      userId,
      challenge,
      platform,
      newUser,
      expiresAt: this.clock() + 120_000,
    });

    return ticket;
  }

  async exchangeTicket(ticket: string, verifier: string, label: string, webOriginAllowed = false) {
    return this.db.transaction(async (manager) => {
      const ticketHash = sha256(ticket);
      const tickets = manager.getRepository(AuthTicketEntity);
      const row = await tickets.findOne({
        where: { ticketHash },
        lock: { mode: 'pessimistic_write' },
      });

      if (!row || row.expiresAt <= this.clock() || !safeEqual(row.challenge, sha256(verifier))) {
        throw new ApiError(
          'AUTH_FLOW_EXPIRED',
          '로그인 연결을 확인하지 못했어요. 다시 시작해 주세요.',
          400,
        );
      }

      if (row.platform === 'web' && !webOriginAllowed) {
        throw new ApiError('AUTH_CSRF', '로그인 요청 주소를 확인하지 못했어요.', 403);
      }

      await tickets.delete({ ticketHash });

      const result = await this.issueSession(row.userId, label, manager);

      return {
        ...result,
        platform: row.platform,
        newUser: row.newUser,
        needsConsent: result.user.needsConsent,
      };
    });
  }

  private async issueSession(userId: string, label: string, manager: EntityManager) {
    // A user lock keeps the 20-session cap correct across simultaneous ticket exchanges.
    await manager.getRepository(UserEntity).findOne({
      where: { id: userId },
      lock: { mode: 'pessimistic_write' },
    });

    const token = randomToken(),
      csrfToken = randomToken(),
      id = randomUUID(),
      now = this.clock();
    const expiresAt = now + 7 * DAY_MS;

    const sessions = manager.getRepository(SessionEntity);

    await sessions.insert({
      id,
      tokenHash: sha256(token),
      userId,
      label,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      csrfToken,
    });

    const excess = await sessions.find({
      select: { id: true },
      where: { userId },
      order: { createdAt: 'DESC', insertionOrder: 'DESC' },
      skip: 20,
    });

    if (excess.length) {
      await sessions.delete({ userId, id: In(excess.map((session) => session.id)) });
    }

    return {
      user: await this.user(userId, manager),
      token,
      csrfToken,
      sessionId: id,
      expiresAt,
    };
  }

  async session(token: string): Promise<AuthSession> {
    const sessions = this.db.getRepository(SessionEntity);
    const row = await sessions.findOneBy({
      tokenHash: sha256(token),
      expiresAt: MoreThan(this.clock()),
    });

    if (!row) {
      throw new ApiError('AUTH_REQUIRED', '로그인이 만료됐어요. 다시 로그인해 주세요.', 401);
    }

    if (this.clock() - row.lastSeenAt > 60_000) {
      await sessions.update({ id: row.id }, { lastSeenAt: this.clock() });
    }

    return {
      id: row.id,
      userId: row.userId,
      label: row.label,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      csrfToken: row.csrfToken,
    };
  }

  async acceptConsents(userId: string, marketingConsent: boolean) {
    await this.db.getRepository(UserEntity).update(
      { id: userId },
      {
        termsVersion: CONSENT_VERSION,
        privacyVersion: CONSENT_VERSION,
        marketingConsent,
        acceptedAt: this.clock(),
      },
    );

    return this.user(userId);
  }

  async updateName(userId: string, name: string) {
    await this.db.getRepository(UserEntity).update({ id: userId }, { name });

    return this.user(userId);
  }

  async sessions(userId: string, currentId: string) {
    const sessions = await this.db.getRepository(SessionEntity).find({
      select: { id: true, label: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      where: { userId, expiresAt: MoreThan(this.clock()) },
      order: { createdAt: 'DESC', insertionOrder: 'DESC' },
    });

    return sessions.map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      current: row.id === currentId,
    }));
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.db.getRepository(SessionEntity).delete({ userId, id: sessionId });
  }

  async identities(userId: string): Promise<SocialIdentity[]> {
    const user = await this.user(userId);
    const identities = await this.db.getRepository(SocialIdentityEntity).findBy({ userId });

    return identities.map((row) => ({
      provider: row.provider,
      subject: row.subject,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      grant: row.encryptedGrant
        ? this.cipher.decrypt<SocialIdentity['grant']>(row.encryptedGrant)
        : undefined,
    }));
  }

  async deleteAccount(userId: string) {
    await this.db.getRepository(UserEntity).delete({ id: userId });
  }

  async preferences(userId: string): Promise<unknown> {
    const data = await this.db.getRepository(AccountDataEntity).findOneBy({ userId });

    return data?.preferences ?? null;
  }

  async savePreferences(userId: string, value: unknown) {
    // TypeORM's deep-partial type cannot represent arbitrary JSON; jsonb serializes the value.
    const data = { userId, preferences: value } as QueryDeepPartialEntity<AccountDataRecord>;

    await this.db.getRepository(AccountDataEntity).upsert(data, ['userId']);
  }

  async trips(userId: string): Promise<unknown> {
    const data = await this.db.getRepository(AccountDataEntity).findOneBy({ userId });

    return (
      data?.trips ?? {
        savedTrips: [],
        recentTrips: [],
      }
    );
  }

  async saveTrips(userId: string, value: unknown) {
    const data = { userId, trips: value } as QueryDeepPartialEntity<AccountDataRecord>;

    await this.db.getRepository(AccountDataEntity).upsert(data, ['userId']);
  }

  async supportTicket(userId: string | null, category: string, message: string, email?: string) {
    await this.cleanup();

    const id = randomUUID(),
      createdAt = this.clock();

    await this.db.getRepository(SupportTicketEntity).insert({
      id,
      userId,
      category,
      message,
      email: email ?? null,
      createdAt,
    });

    return {
      id,
      createdAt,
      status: 'received' as const,
    };
  }
}
