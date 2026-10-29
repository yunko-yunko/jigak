import type { OAuthOptions, SocialConfig } from './oauth.js';
import type { OAuthAdapter } from './types.js';

/** Optional explicit integrations, also used by isolated authentication tests. */
export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');

export interface AuthOptions {
  config?: SocialConfig;
  adapters?: OAuthAdapter[];
  fetcher?: typeof fetch;
  keys?: OAuthOptions['keys'];
  rateLimit?: number;
  cookieSecure?: boolean;
  now?: () => number;
  corsOrigins?: string[];
}
