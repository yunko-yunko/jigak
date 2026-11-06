// Prints names and safe example values only; never reads or prints .env secrets.
const required = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  DB_HOST: '/cloudsql/PROJECT_ID:asia-northeast3:INSTANCE_ID',
  DB_PORT: '5432',
  DB_NAME: 'jigakmap',
  DB_USER: 'jigakmap',
  DB_PASSWORD: '<Cloud Run environment variable or Secret Manager: DB password>',
  DB_POOL_MAX: '5',
  DB_SSL: 'false',
  TRUST_PROXY_HOPS: '1',
  AUTH_PUBLIC_BASE_URL: 'https://api.example.com',
  AUTH_WEB_RETURN_URL: 'https://app.example.com/',
  CORS_ORIGINS: 'https://app.example.com',
  AUTH_TOKEN_ENCRYPTION_KEY: '<32 random bytes in Base64; keep the same key across deployments>',
};

console.log(
  '# Cloud Run runtime variables (replace placeholders in the console; Secret Manager is optional)',
);

for (const [key, value] of Object.entries(required)) {
  console.log(`${key}=${value}`);
}

console.log(
  '# Cloud Run supplies PORT=8080 through --port=8080; do not set PORT with --set-env-vars.',
);

console.log(
  '# GitHub deployment: connect the repository in Cloud Run, select Dockerfile, and add the Cloud SQL connection. Startup runs locked TypeORM migrations automatically.',
);

console.log(
  '# The DB user needs schema creation/alteration privileges. Native-only apps can explicitly set CORS_ORIGINS to an empty string.',
);

console.log(
  '# Optional live routing: KAKAO_REST_API_KEY, KAKAO_REST_API_KEY_SUB (optional spare secret; legacy KAKAO_REST_API_KEY_FALLBACK is used only when SUB is empty); data/feeds: DATA_GO_KR_SERVICE_KEY, DATA_GO_KR_SERVICE_KEY_FALLBACK (optional spare secret), DATA_GO_KR_DAILY_LIMIT (bus calls per operation and key, default 1000), SEOUL_OPEN_API_KEY, SEOUL_OPEN_API_KEY_FALLBACK (optional spare secret), SEOUL_BIKE_API_KEY, SEOUL_CITY_DATA_API_KEY, SEOUL_PARKING_API_KEY, TRAFFIC_SIGNAL_API_KEY, MOBILITY_GBFS_FEEDS; demo scooter/e-bike simulator (simulated data, not an operator): MOBILITY_SIMULATION=scooter|ebike|scooter,ebike (needs --cpu 2 --memory 2Gi), MOBILITY_SIMULATION_FLEET (default 14933), MOBILITY_SIMULATION_EBIKE_FLEET (default 52605), MOBILITY_SIMULATION_WINDOW_DIR (/sim-windows on a Cloud Storage volume in asia-northeast3; empty = off), MOBILITY_SIMULATION_READY_GATE (default true), MOBILITY_FOOT_WEIGHTS_PATH (absolute path of other foot-traffic weights, e.g. the NGII-based file on a Seoul-region volume; empty = the shipped OSM file), min-instances 1 and startup probe /api/health/ready when simulating, MOBILITY_SIMULATION_SEED; bicycle network: BICYCLE_ROUTING_ENABLED, BICYCLE_OSRM_URL; time comparison: OPENAI_API_KEY, OPENAI_MODEL.',
);

console.log(
  '# Automatic model refresh (docs/MODEL-REFRESH.md): MODEL_MANIFEST_PATH=/models/manifest.json with cloud-run.ps1 -ModelBucket (read-only Cloud Storage volume in asia-northeast3); MODEL_MANIFEST_POLL_SECONDS (default 60), MODEL_REFRESH_STATUS_PATH (default: next to the manifest), MODEL_REFRESH_SCHEDULE_KST (default 05:30,09:30,13:30). With it set, the ETA_*_PATH variables below are only the fallback for models the manifest does not list.',
);

console.log(
  '# NGII 1:1,000 map: MAP_NGII_PMTILES_PATH=/maps/seoul-ngii-v1.pmtiles with cloud-run.ps1 -MapBucket (private read-only Cloud Storage volume in asia-northeast3; never public, another region or a CDN). The API serves it by single byte ranges at /api/maps/seoul-ngii-v1.pmtiles; the app build sets EXPO_PUBLIC_MAP_NGII_TILES_URL=https://<API>/api/maps/seoul-ngii-v1.pmtiles. Empty = the route answers 404 and the app has no NGII layer.',
);

console.log(
  '# Optional read-only models: ETA_PUBLIC_BUS_MODEL_PATH, ETA_SPATIAL_BUS_MODEL_PATH, ETA_RAIL_GATE_MODEL_PATH, BICYCLE_RIDE_TIMES_PATH, ETA_SPATIAL_BICYCLE_MODEL_PATH, ETA_HGB_MODEL_PATH, ETA_MODEL_PATH, ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY.',
);

console.log(
  '# Optional login: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, KAKAO_LOGIN_REST_API_KEY, KAKAO_LOGIN_CLIENT_SECRET, KAKAO_LOGIN_OIDC, APPLE_SERVICE_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY.',
);
