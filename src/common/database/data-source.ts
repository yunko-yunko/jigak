import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { databaseConfiguration } from '../config/environment.js';
import { ALL_ENTITIES } from './entities.js';
import { TYPEORM_MIGRATIONS } from './migrations/index.js';

export function createDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const { user, host, port, database, password, ssl, max, ...extra } = databaseConfiguration(env);

  return {
    type: 'postgres',
    host,
    port,
    database,
    password,
    ssl,
    username: user,
    poolSize: max,
    extra,
    entities: ALL_ENTITIES,
    migrations: TYPEORM_MIGRATIONS,
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'all',
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    logging: false,
    invalidWhereValuesBehavior: { null: 'throw', undefined: 'throw' },
  };
}

export function createDataSource(env: NodeJS.ProcessEnv = process.env) {
  return new DataSource(createDataSourceOptions(env));
}
