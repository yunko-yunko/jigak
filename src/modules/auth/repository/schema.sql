CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT, email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL, terms_version TEXT, privacy_version TEXT,
  marketing_consent BOOLEAN NOT NULL DEFAULT FALSE, accepted_at BIGINT
);
CREATE TABLE IF NOT EXISTS social_identities (
  provider TEXT NOT NULL CHECK (provider IN ('kakao','google','apple')),
  subject TEXT NOT NULL, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_grant TEXT, PRIMARY KEY (provider,subject)
);
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL, csrf_token TEXT NOT NULL,
  insertion_order BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, encrypted_data TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_tickets (
  ticket_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('web','native')),
  new_user BOOLEAN NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_data (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferences JSONB, trips JSONB
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL, message TEXT NOT NULL, email TEXT, created_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
);
CREATE INDEX IF NOT EXISTS support_tickets_time ON support_tickets(created_at);
CREATE TABLE IF NOT EXISTS auth_rate_windows (
  client_hash TEXT PRIMARY KEY, reset_at BIGINT NOT NULL, request_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_windows_expiry ON auth_rate_windows(reset_at);
