CREATE TABLE IF NOT EXISTS eta_metadata (
  name text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS eta_observations (
  id text PRIMARY KEY,
  trip_id uuid NOT NULL,
  observed_at bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS eta_observations_time ON eta_observations(observed_at);
CREATE INDEX IF NOT EXISTS eta_observations_trip ON eta_observations(trip_id);
CREATE TABLE IF NOT EXISTS eta_journeys (
  id text PRIMARY KEY,
  trip_id uuid NOT NULL UNIQUE,
  observed_at bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS eta_journeys_time ON eta_journeys(observed_at);
CREATE TABLE IF NOT EXISTS eta_erased_receipts (
  id uuid PRIMARY KEY,
  expires_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS eta_learning_state (
  id integer PRIMARY KEY CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 0,
  last_attempt_trips integer NOT NULL DEFAULT 0,
  last_attempt_journeys integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '["insufficient-independent-trips"]'::jsonb,
  journey_reasons jsonb NOT NULL DEFAULT '["insufficient-independent-journeys"]'::jsonb,
  shadow_leg_candidate jsonb
);
INSERT INTO eta_learning_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS eta_models (
  kind text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at bigint NOT NULL
);
