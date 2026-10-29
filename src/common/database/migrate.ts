import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { MigrationExecutor, type QueryRunner } from 'typeorm';
import { DatabaseService } from './database.service.js';
import { createDataSource } from './data-source.js';
import {
  LegacySchemaMigrationEntity,
  TypeOrmMigrationHistoryEntity,
} from './entities/migration-history.entity.js';
import { INITIAL_APPLICATION_TABLES } from './migrations/1793232000000-initial-orm-schema.js';

/** The original migration remains an immutable compatibility receipt, never an execution path. */
export async function legacySchemaChecksum() {
  const sources = [
    new URL('./schema.sql', import.meta.url),
    new URL('../../modules/auth/repository/schema.sql', import.meta.url),
    new URL('../../modules/learning/repository/schema.sql', import.meta.url),
  ];
  const sql = (await Promise.all(sources.map((url) => readFile(url, 'utf8')))).join('\n');

  return createHash('sha256').update(sql).digest('hex');
}

async function verifyExistingDatabase(runner: QueryRunner) {
  if (await runner.hasTable('schema_migrations')) {
    const legacy = await runner.manager
      .getRepository(LegacySchemaMigrationEntity)
      .findOneBy({ version: '001-initial' });

    if (!legacy || legacy.checksum !== (await legacySchemaChecksum())) {
      throw new Error(
        'Applied legacy migration checksum changed; verify the existing database before adoption.',
      );
    }

    for (const table of INITIAL_APPLICATION_TABLES.filter((table) => table.name !== 'orm_locks')) {
      if (!(await runner.hasTable(table.name))) {
        throw new Error('The legacy database is incomplete; migration was not applied.');
      }
    }

    return;
  }

  if (
    (await runner.hasTable('typeorm_migrations')) &&
    (await runner.manager
      .getRepository(TypeOrmMigrationHistoryEntity)
      .existsBy({ name: 'InitialOrmSchema1793232000000' }))
  ) {
    return;
  }

  for (const name of ['users', 'eta_metadata', 'api_rate_windows']) {
    if (await runner.hasTable(name)) {
      throw new Error(
        'An existing database without verified migration history cannot be adopted automatically.',
      );
    }
  }
}

export async function runMigrations(database: DatabaseService) {
  const runner = database.dataSource.createQueryRunner();

  try {
    await runner.connect();
    await runner.startTransaction();

    // The catalog is present before any application table. Take the original
    // PostgreSQL transaction lock through TypeORM before inspecting migration history.
    await runner.manager
      .createQueryBuilder()
      .select('pg_advisory_xact_lock(:migrationLock)', 'migration_lock')
      .from('pg_catalog.pg_database', 'migration_database')
      .where('migration_database.datname = current_database()')
      .setParameter('migrationLock', 842901)
      .getRawOne();

    await verifyExistingDatabase(runner);

    const executor = new MigrationExecutor(database.dataSource, runner);
    executor.transaction = 'all';

    const applied = await executor.executePendingMigrations();

    await runner.commitTransaction();

    return applied;
  } catch (error) {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }

    throw error;
  } finally {
    await runner.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataSource = createDataSource();

  try {
    await dataSource.initialize();
    await runMigrations(new DatabaseService(dataSource));

    console.info('TypeORM database migration complete.');
  } catch {
    console.error(
      'TypeORM migration failed. Check configuration, permissions and migration history.',
    );
    process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}
