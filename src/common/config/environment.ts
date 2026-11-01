import { z } from 'zod';
import { ASSUMPTIONS } from '../engine/simulation/assumptions.js';
import {
  FOOT_WEIGHTS_ENV,
  footWeightsPath,
  readFootWeights,
} from '../engine/simulation/foot-traffic.js';
import { DEFAULT_REFRESH_SCHEDULE_KST } from '../engine/intelligence/model-manifest.js';

const FLEET = ASSUMPTIONS.fleet;
const integer = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
/** An empty value, as deployment env files write unset options, means the default. */
const blankIsDefault = <T extends z.ZodType>(type: T) =>
  z.preprocess((value) => (typeof value === 'string' && !value.trim() ? undefined : value), type);

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
  ROUTE_CALL_LIMIT: integer(1, 96, 72),
  TRUST_PROXY_HOPS: integer(0, 5, 0),
  CORS_ORIGINS: z.string().default('http://localhost:8081,http://127.0.0.1:8081'),
  AUTH_PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  AUTH_WEB_RETURN_URL: z.string().url().default('http://localhost:8081/'),
  AUTH_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  PEDESTRIAN_ROUTING_ENABLED: z.enum(['true', 'false']).default('true'),
  BICYCLE_ROUTING_ENABLED: z.enum(['true', 'false']).default('true'),
  ROUTE_METRICS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Demo simulator: a comma list of 'scooter' and 'ebike' (alias 'e-bike'); other names turn
  // nothing on and are reported once at startup.
  MOBILITY_SIMULATION: z.string().optional(),
  // Seoul's registered fleet by default: 14,933 scooters, alone or next to 52,605 e-bikes (§12,
  // §19.2, §21). Blank is the default.
  MOBILITY_SIMULATION_FLEET: blankIsDefault(
    z.coerce.number().int().min(FLEET.min).max(FLEET.max).optional(),
  ),
  MOBILITY_SIMULATION_EBIKE_FLEET: blankIsDefault(
    integer(FLEET.ebikeMin, FLEET.ebikeMax, FLEET.ebikeDefault),
  ),
  MOBILITY_SIMULATION_SEED: blankIsDefault(z.string().trim().min(1).max(64).default('jigak')),
  // Directory of computed simulator windows (§22): a restart or a new instance reads the day back
  // instead of simulating it. Relative to the working directory; blank keeps no store.
  MOBILITY_SIMULATION_WINDOW_DIR: blankIsDefault(z.string().trim().max(512).optional()),
  // Whether /api/health/ready waits for today's simulator window; 'false' waits for the database only.
  MOBILITY_SIMULATION_READY_GATE: blankIsDefault(z.enum(['true', 'false']).default('true')),
  // Another foot-traffic weights file (§22) of the shipped schema, as an absolute path: the
  // NGII-based weights, which stay out of git. Blank reads the shipped OSM file.
  MOBILITY_FOOT_WEIGHTS_PATH: blankIsDefault(z.string().trim().max(1024).optional()),
  // Model manifest written by the refresh job (docs/MODEL-REFRESH.md). Set, it replaces the fixed
  // ETA_*_PATH model files; blank keeps those paths exactly as before.
  MODEL_MANIFEST_PATH: blankIsDefault(z.string().trim().max(1024).optional()),
  MODEL_MANIFEST_POLL_SECONDS: blankIsDefault(integer(1, 3600, 60)),
  // The job's report; blank means refresh-status.json next to the manifest.
  MODEL_REFRESH_STATUS_PATH: blankIsDefault(z.string().trim().max(1024).optional()),
  // The Cloud Scheduler slots in KST as HH:MM list, used only to tell health when the next run is due.
  MODEL_REFRESH_SCHEDULE_KST: blankIsDefault(
    z
      .string()
      .trim()
      .regex(/^([01]?\d|2[0-3]):[0-5]\d(,([01]?\d|2[0-3]):[0-5]\d)*$/)
      .default(DEFAULT_REFRESH_SCHEDULE_KST),
  ),
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

  const simulated = simulationTypes(config.MOBILITY_SIMULATION);
  const scooterFleet =
    config.MOBILITY_SIMULATION_FLEET ?? (simulated.ebike ? FLEET.scooterDefault : FLEET.default);
  const simulationFleets =
    simulated.scooter || simulated.ebike
      ? {
          scooter: simulated.scooter ? scooterFleet : 0,
          ebike: simulated.ebike ? config.MOBILITY_SIMULATION_EBIKE_FLEET : 0,
        }
      : null;
  if (simulationFleets && simulationFleets.scooter + simulationFleets.ebike > FLEET.max) {
    throw new EnvironmentConfigurationError(
      `MOBILITY_SIMULATION_FLEET, MOBILITY_SIMULATION_EBIKE_FLEET: 합계는 ${FLEET.max}대 이하여야 합니다.`,
      ['MOBILITY_SIMULATION_FLEET', 'MOBILITY_SIMULATION_EBIKE_FLEET'],
    );
  }
  if (simulationFleets && simulationFleets.scooter + simulationFleets.ebike < FLEET.min) {
    throw new EnvironmentConfigurationError(
      `MOBILITY_SIMULATION_EBIKE_FLEET: 전기자전거만 켤 때는 ${FLEET.min}대 이상이어야 합니다.`,
      ['MOBILITY_SIMULATION_EBIKE_FLEET'],
    );
  }
  // A named weights file must load now, not when the first window is simulated.
  if (config.MOBILITY_FOOT_WEIGHTS_PATH) {
    try {
      readFootWeights(
        footWeightsPath({ [FOOT_WEIGHTS_ENV]: config.MOBILITY_FOOT_WEIGHTS_PATH }).path,
      );
    } catch {
      throw new EnvironmentConfigurationError(
        'MOBILITY_FOOT_WEIGHTS_PATH: 읽을 수 있는 유동인구 가중치 파일의 절대 경로여야 합니다.',
        ['MOBILITY_FOOT_WEIGHTS_PATH'],
      );
    }
  }

  return {
    ...config,
    MOBILITY_SIMULATION_FLEET: scooterFleet,
    origins,
    scooterSimulation: simulated.scooter,
    /** MOBILITY_SIMULATION names that are neither type, for a startup warning. */
    simulationUnknownTypes: unknownSimulationTypes(config.MOBILITY_SIMULATION),
    ebikeSimulation: simulated.ebike,
    /** Vehicles per simulated type; null while the simulator is off. */
    simulationFleets,
  };
}

const SIMULATION_TYPE_NAMES = new Set(['scooter', 'ebike', 'e-bike']);

/** The names in a MOBILITY_SIMULATION value that are not a simulated type, as written. */
export function unknownSimulationTypes(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name && !SIMULATION_TYPE_NAMES.has(name.toLowerCase())),
    ),
  ];
}

/**
 * The simulated vehicle types in a MOBILITY_SIMULATION value: a comma list of `scooter` and
 * `ebike` (or `e-bike`), case and spaces ignored. Unknown names turn nothing on.
 */
export function simulationTypes(value: string | undefined): { scooter: boolean; ebike: boolean } {
  const names = new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  return { scooter: names.has('scooter'), ebike: names.has('ebike') || names.has('e-bike') };
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
