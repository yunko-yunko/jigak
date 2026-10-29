import { EntitySchema } from 'typeorm';
import { bigintNumberTransformer } from '../../../../common/database/transformers.js';
import type { AuthPlatform, SocialProviderId } from '../../domain/types.js';

export interface UserRecord {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: number;
  termsVersion: string | null;
  privacyVersion: string | null;
  marketingConsent: boolean;
  acceptedAt: number | null;
}

export interface SocialIdentityRecord {
  provider: SocialProviderId;
  subject: string;
  userId: string;
  encryptedGrant: string | null;
}

export interface SessionRecord {
  id: string;
  tokenHash: string;
  userId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  csrfToken: string;
  insertionOrder: number;
}

export interface OAuthStateRecord {
  stateHash: string;
  provider: SocialProviderId;
  encryptedData: string;
  expiresAt: number;
}

export interface AuthTicketRecord {
  ticketHash: string;
  userId: string;
  challenge: string;
  platform: AuthPlatform;
  newUser: boolean;
  expiresAt: number;
}

export interface AccountDataRecord {
  userId: string;
  preferences: unknown;
  trips: unknown;
}

export interface SupportTicketRecord {
  id: string;
  userId: string | null;
  category: string;
  message: string;
  email: string | null;
  createdAt: number;
  status: string;
}

export interface AuthRateWindowRecord {
  clientHash: string;
  resetAt: number;
  requestCount: number;
}

/** Persistence records are kept separate from the account domain's public models. */
export const UserEntity = new EntitySchema<UserRecord>({
  name: 'AuthUser',
  tableName: 'users',
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'users_pkey' },
    name: { type: 'text' },
    email: { type: 'text', nullable: true },
    emailVerified: { name: 'email_verified', type: 'boolean', default: false },
    createdAt: { name: 'created_at', type: 'bigint', transformer: bigintNumberTransformer },
    termsVersion: { name: 'terms_version', type: 'text', nullable: true },
    privacyVersion: { name: 'privacy_version', type: 'text', nullable: true },
    marketingConsent: { name: 'marketing_consent', type: 'boolean', default: false },
    acceptedAt: {
      name: 'accepted_at',
      type: 'bigint',
      nullable: true,
      transformer: bigintNumberTransformer,
    },
  },
});

export const SocialIdentityEntity = new EntitySchema<SocialIdentityRecord>({
  name: 'AuthSocialIdentity',
  tableName: 'social_identities',
  columns: {
    provider: { type: 'text', primary: true, primaryKeyConstraintName: 'social_identities_pkey' },
    subject: { type: 'text', primary: true, primaryKeyConstraintName: 'social_identities_pkey' },
    userId: { name: 'user_id', type: 'uuid' },
    encryptedGrant: { name: 'encrypted_grant', type: 'text', nullable: true },
  },
  checks: [
    {
      name: 'social_identities_provider_check',
      expression: "\"provider\" IN ('kakao','google','apple')",
    },
  ],
  foreignKeys: [
    {
      name: 'social_identities_user_id_fkey',
      target: 'AuthUser',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    },
  ],
});

export const SessionEntity = new EntitySchema<SessionRecord>({
  name: 'AuthSession',
  tableName: 'sessions',
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'sessions_pkey' },
    tokenHash: { name: 'token_hash', type: 'text' },
    userId: { name: 'user_id', type: 'uuid' },
    label: { type: 'text' },
    createdAt: { name: 'created_at', type: 'bigint', transformer: bigintNumberTransformer },
    lastSeenAt: { name: 'last_seen_at', type: 'bigint', transformer: bigintNumberTransformer },
    expiresAt: { name: 'expires_at', type: 'bigint', transformer: bigintNumberTransformer },
    csrfToken: { name: 'csrf_token', type: 'text' },
    insertionOrder: {
      name: 'insertion_order',
      type: 'bigint',
      // The immutable baseline defines this generated counter as PostgreSQL IDENTITY.
      generated: 'increment',
      transformer: bigintNumberTransformer,
    },
  },
  uniques: [{ name: 'sessions_token_hash_key', columns: ['tokenHash'] }],
  indices: [
    { name: 'sessions_user', columns: ['userId'] },
    { name: 'sessions_expiry', columns: ['expiresAt'] },
  ],
  foreignKeys: [
    {
      name: 'sessions_user_id_fkey',
      target: 'AuthUser',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    },
  ],
});

export const OAuthStateEntity = new EntitySchema<OAuthStateRecord>({
  name: 'AuthOAuthState',
  tableName: 'oauth_states',
  columns: {
    stateHash: {
      name: 'state_hash',
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'oauth_states_pkey',
    },
    provider: { type: 'text' },
    encryptedData: { name: 'encrypted_data', type: 'text' },
    expiresAt: { name: 'expires_at', type: 'bigint', transformer: bigintNumberTransformer },
  },
});

export const AuthTicketEntity = new EntitySchema<AuthTicketRecord>({
  name: 'AuthTicket',
  tableName: 'auth_tickets',
  columns: {
    ticketHash: {
      name: 'ticket_hash',
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'auth_tickets_pkey',
    },
    userId: { name: 'user_id', type: 'uuid' },
    challenge: { type: 'text' },
    platform: { type: 'text' },
    newUser: { name: 'new_user', type: 'boolean' },
    expiresAt: { name: 'expires_at', type: 'bigint', transformer: bigintNumberTransformer },
  },
  checks: [{ name: 'auth_tickets_platform_check', expression: "\"platform\" IN ('web','native')" }],
  foreignKeys: [
    {
      name: 'auth_tickets_user_id_fkey',
      target: 'AuthUser',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    },
  ],
});

export const AccountDataEntity = new EntitySchema<AccountDataRecord>({
  name: 'AuthAccountData',
  tableName: 'account_data',
  columns: {
    userId: {
      name: 'user_id',
      type: 'uuid',
      primary: true,
      primaryKeyConstraintName: 'account_data_pkey',
    },
    preferences: { type: 'jsonb', nullable: true },
    trips: { type: 'jsonb', nullable: true },
  },
  foreignKeys: [
    {
      name: 'account_data_user_id_fkey',
      target: 'AuthUser',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    },
  ],
});

export const SupportTicketEntity = new EntitySchema<SupportTicketRecord>({
  name: 'AuthSupportTicket',
  tableName: 'support_tickets',
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'support_tickets_pkey' },
    userId: { name: 'user_id', type: 'uuid', nullable: true },
    category: { type: 'text' },
    message: { type: 'text' },
    email: { type: 'text', nullable: true },
    createdAt: { name: 'created_at', type: 'bigint', transformer: bigintNumberTransformer },
    status: { type: 'text', default: 'received' },
  },
  indices: [{ name: 'support_tickets_time', columns: ['createdAt'] }],
  foreignKeys: [
    {
      name: 'support_tickets_user_id_fkey',
      target: 'AuthUser',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE',
    },
  ],
});

export const AuthRateWindowEntity = new EntitySchema<AuthRateWindowRecord>({
  name: 'AuthRateWindow',
  tableName: 'auth_rate_windows',
  columns: {
    clientHash: {
      name: 'client_hash',
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'auth_rate_windows_pkey',
    },
    resetAt: { name: 'reset_at', type: 'bigint', transformer: bigintNumberTransformer },
    requestCount: { name: 'request_count', type: 'integer' },
  },
  indices: [{ name: 'auth_rate_windows_expiry', columns: ['resetAt'] }],
});

export const authEntities = [
  UserEntity,
  SocialIdentityEntity,
  SessionEntity,
  OAuthStateEntity,
  AuthTicketEntity,
  AccountDataEntity,
  SupportTicketEntity,
  AuthRateWindowEntity,
];
