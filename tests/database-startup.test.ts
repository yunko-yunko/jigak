import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/common/database/database.service.js';
import { initializeDatabase } from '../src/common/database/initialize-database.js';
import { TypeOrmMigrationHistoryEntity } from '../src/common/database/entities/migration-history.entity.js';
import { UserEntity } from '../src/modules/auth/repository/entities/index.js';
import { configureApplication } from '../src/common/http/configure-app.js';
import { createTestDatabase } from './helpers/auth-database.js';

test('Nest starts against an empty database, serves readiness and preserves data on restart', async () => {
  const fixture = await createTestDatabase([]);
  const id = randomUUID();

  let app: INestApplication | undefined;

  try {
    for (const boot of [0, 1]) {
      const module = await Test.createTestingModule({ imports: [AppModule] })
        // Override connection options only: the production DataSource factory must still execute.
        .overrideProvider('TypeOrmModuleOptions')
        .useValue({ ...fixture.dataSource.options, retryAttempts: 1 })
        .compile();

      app = module.createNestApplication({ bodyParser: false, logger: false });

      configureApplication(app, { DB_PASSWORD: 'test' });

      await app.listen(0, '127.0.0.1');

      const url = await app.getUrl();
      const ready = await fetch(url + '/api/health/ready');
      const database = module.get(DatabaseService);

      assert.equal(ready.status, 200);
      // Readiness also reports the shared-mobility simulator, which is off unless MOBILITY_SIMULATION is set.
      assert.deepEqual(await ready.json(), {
        status: 'ok',
        database: 'ready',
        simulation: { enabled: false },
      });
      assert.equal(await database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);

      if (boot === 0) {
        await database.getRepository(UserEntity).insert({
          id,
          name: '재시작 후 보존',
          createdAt: Date.now(),
        });
      } else {
        assert.equal(
          (await database.getRepository(UserEntity).findOneByOrFail({ id })).name,
          '재시작 후 보존',
        );
      }

      await app.close();

      app = undefined;
    }
  } finally {
    await app?.close();
    await fixture.close();
  }
});

test('a failed startup migration rolls back the schema, closes the connection and permits a clean retry', async () => {
  const fixture = await createTestDatabase([]);

  class FailDuringStartup1793232000001 implements MigrationInterface {
    name = 'FailDuringStartup1793232000001';

    async up(_runner: QueryRunner) {
      throw new Error('intentional-startup-migration-failure');
    }

    async down() {}
  }

  try {
    fixture.dataSource.migrations.push(new FailDuringStartup1793232000001());

    await assert.rejects(
      initializeDatabase(fixture.dataSource),
      /intentional-startup-migration-failure/,
    );

    assert.equal(fixture.dataSource.isInitialized, false);

    // Reinitialization reloads the registered migrations without the injected failing class.
    await initializeDatabase(fixture.dataSource);

    assert.equal(fixture.dataSource.isInitialized, true);
    assert.equal(await fixture.database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);
    assert.equal(await fixture.dataSource.showMigrations(), false);
  } finally {
    await fixture.close();
  }
});
