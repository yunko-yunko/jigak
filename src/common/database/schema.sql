CREATE TABLE IF NOT EXISTS api_rate_windows (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS api_rate_expiry ON api_rate_windows(expires_at);
