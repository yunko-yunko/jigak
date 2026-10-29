// Prints names and safe example values only; never reads or prints .env secrets.
const required = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  DB_HOST: '/cloudsql/PROJECT_ID:asia-northeast3:INSTANCE_ID',
  DB_PORT: '5432',
  DB_NAME: 'jigakmap',
  DB_USER: 'jigakmap',
  DB_PASSWORD: '<Secret Manager: DB password>',
  DB_POOL_MAX: '5',
  DB_SSL: 'false',
  TRUST_PROXY_HOPS: '0',
  AUTH_PUBLIC_BASE_URL: 'https://api.example.com',
  AUTH_WEB_RETURN_URL: 'https://app.example.com/',
  CORS_ORIGINS: 'https://app.example.com',
  AUTH_TOKEN_ENCRYPTION_KEY: '<Secret Manager: 32 random bytes in Base64>',
};

console.log('# Cloud Run runtime variables (replace placeholders; secrets via --set-secrets)');

for (const [key, value] of Object.entries(required)) {
  console.log(`${key}=${value}`);
}

console.log(
  '# Cloud Run supplies PORT=8080 through --port=8080; do not set PORT with --set-env-vars.',
);

console.log(
  '# Deployment inputs: PROJECT_ID, REGION, SERVICE_NAME, IMAGE_URI, INSTANCE_CONNECTION_NAME, SERVICE_ACCOUNT.',
);

console.log(
  '# Optional live routing: KAKAO_REST_API_KEY; data/feeds: DATA_GO_KR_SERVICE_KEY, SEOUL_OPEN_API_KEY, SEOUL_BIKE_API_KEY, SEOUL_CITY_DATA_API_KEY, SEOUL_PARKING_API_KEY, MOBILITY_GBFS_FEEDS.',
);

console.log(
  '# Optional login: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, KAKAO_LOGIN_REST_API_KEY, KAKAO_LOGIN_CLIENT_SECRET, KAKAO_LOGIN_OIDC, APPLE_SERVICE_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY.',
);
