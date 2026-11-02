export const CONSENT_VERSION = '2026-11-02';
/** An app build that still sends an earlier version cannot show the new text, so it is told to update rather than to tick again. */
export const OUTDATED_CONSENT_MESSAGE = '약관이 바뀌었어요. 앱을 업데이트한 뒤 다시 동의해 주세요.';
export const SOCIAL_PROVIDERS = ['kakao', 'google', 'apple'] as const;

export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

export type AuthPlatform = 'web' | 'native';

export interface AccountUser {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: number;
  needsConsent: boolean;
  providers: SocialProviderId[];
  consents: {
    termsVersion: string | null;
    privacyVersion: string | null;
    marketingConsent: boolean;
    acceptedAt: number | null;
  };
}

export interface SocialIdentity {
  provider: SocialProviderId;
  subject: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  /** Used only for provider revocation. Encrypted before persistence, never returned. */
  grant?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export interface OAuthState {
  provider: SocialProviderId;
  platform: AuthPlatform;
  challenge: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export interface OAuthAdapter {
  id: SocialProviderId;
  name: string;
  configured: boolean;
  authorizationUrl(state: string, transaction: OAuthState): string;
  identity(code: string, transaction: OAuthState, appleUser?: unknown): Promise<SocialIdentity>;
  revoke(identity: SocialIdentity): Promise<void>;
}

export interface AuthSession {
  id: string;
  userId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  csrfToken: string;
}
