import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { DataSource } from 'typeorm';
import { createDataSourceOptions } from '../../src/common/database/data-source.js';
import { DatabaseService } from '../../src/common/database/database.service.js';
import { runMigrations } from '../../src/common/database/migrate.js';
import { createPGliteDriver } from './typeorm-pglite.js';

/**
 * Run the production TypeORM entities and migrations against embedded PostgreSQL.
 * Passing [] intentionally leaves an empty database for migration-specific tests.
 */
export async function createTestDatabase(schemaPaths?: URL[]) {
  // Nest's async database options factory still validates configuration when its
  // DataSource provider is overridden by this real PostgreSQL test connection.
  process.env.DB_PASSWORD ||= 'test';

  const options = createDataSourceOptions({ ...process.env, DB_PASSWORD: 'test' });

  if (options.type !== 'postgres') {
    throw new Error('The PostgreSQL test fixture requires the PostgreSQL TypeORM driver.');
  }

  const engine = new PGlite();

  await engine.waitReady;

  const dataSource = new DataSource({
    ...options,
    database: 'template1',
    driver: createPGliteDriver(engine),
  });

  try {
    await dataSource.initialize();

    const database = new DatabaseService(dataSource);

    if (schemaPaths === undefined || schemaPaths.length > 0) {
      await runMigrations(database);
    }

    return {
      database,
      dataSource,
      engine,

      async close() {
        if (dataSource.isInitialized) {
          await dataSource.destroy();
        }

        await engine.close();
      },
    };
  } catch (error) {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }

    await engine.close();

    throw error;
  }
}
