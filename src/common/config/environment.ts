import { z } from 'zod';

const integer = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** Messages and fields contain configuration names only, never their secret values. */
export class EnvironmentConfigurationError extends Error {
  constructor(
    message: string,
    readonly fields: readonly string[],
  ) {
    super(message);

    this.name = 'EnvironmentConfigurationError';
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(1, 65535, 8080),
  HOST: z.string().default('0.0.0.0'),
  DB_HOST: z.string().min(1).default('127.0.0.1'),
  DB_PORT: integer(1, 65535, 5432),
  DB_NAME: z.string().min(1).default('jigakmap'),
  DB_USER: z.string().min(1).default('jigakmap'),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MAX: integer(1, 50, 5),
  DB_SSL: z.enum(['true', 'false']).default('false'),
  ROUTE_INTERMEDIATE_HUBS: integer(0, 2, 2),
  ROUTE_CALL_LIMIT: integer(1, 32, 28),
  TRUST_PROXY_HOPS: integer(0, 5, 0),
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://127.0.0.1:8081'),
  AUTH_PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  AUTH_WEB_RETURN_URL: z.string().url().default('http://localhost:8081/'),
  AUTH_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  PEDESTRIAN_ROUTING_ENABLED: z.enum(['true', 'false']).default('true'),
  ROUTE_METRICS_ENABLED: z.enum(['true', 'false']).default('false'),
});

export function validateEnvironment(env: NodeJS.ProcessEnv) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];

    throw new EnvironmentConfigurationError(`환경변수 설정 오류: ${fields.join(', ')}`, fields);
  }

  const config = result.data;
  const origins = config.CORS_ORIGINS.split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  for (const origin of origins) {
    let url: URL;

    try {
      url = new URL(origin);
    } catch {
      throw new EnvironmentConfigurationError('CORS_ORIGINS: 정확한 HTTP(S) origin이 필요합니다.', [
        'CORS_ORIGINS',
      ]);
    }

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    ) {
      throw new EnvironmentConfigurationError('CORS_ORIGINS: 정확한 HTTP(S) origin이 필요합니다.', [
        'CORS_ORIGINS',
      ]);
    }
  }

  if (
    config.AUTH_TOKEN_ENCRYPTION_KEY &&
    Buffer.from(config.AUTH_TOKEN_ENCRYPTION_KEY, 'base64').length !== 32
  ) {
    throw new EnvironmentConfigurationError(
      'AUTH_TOKEN_ENCRYPTION_KEY: Base64 32바이트 키가 필요합니다.',
      ['AUTH_TOKEN_ENCRYPTION_KEY'],
    );
  }
  if (config.NODE_ENV === 'production') {
    if (!config.AUTH_TOKEN_ENCRYPTION_KEY) {
      throw new EnvironmentConfigurationError('AUTH_TOKEN_ENCRYPTION_KEY: 운영에서는 필수입니다.', [
        'AUTH_TOKEN_ENCRYPTION_KEY',
      ]);
    }
    for (const field of ['AUTH_PUBLIC_BASE_URL', 'AUTH_WEB_RETURN_URL'] as const) {
      if (new URL(config[field]).protocol !== 'https:') {
        throw new EnvironmentConfigurationError(`${field}: 운영에서는 HTTPS여야 합니다.`, [field]);
      }
    }

    if (origins.some((origin) => new URL(origin).protocol !== 'https:')) {
      throw new EnvironmentConfigurationError('운영 CORS_ORIGINS는 HTTPS여야 합니다.', [
        'CORS_ORIGINS',
      ]);
    }
  }

  return {
    ...config,
    origins,
  };
}

export function databaseConfiguration(env: NodeJS.ProcessEnv) {
  const config = validateEnvironment(env);

  return {
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    max: config.DB_POOL_MAX,
    ssl:
      config.DB_SSL === 'true'
        ? {
            rejectUnauthorized: true,
          }
        : false,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    application_name: 'jigak-map',
  };
}
