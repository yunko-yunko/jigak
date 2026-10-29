import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';
import { legacySchemaChecksum, runMigrations } from '../src/common/database/migrate.js';
import {
  LegacySchemaMigrationEntity,
  TypeOrmMigrationHistoryEntity,
} from '../src/common/database/entities/migration-history.entity.js';
import {
  UserEntity,
  SessionEntity,
  AccountDataEntity,
} from '../src/modules/auth/repository/entities/index.js';
import {
  EtaLearningStateEntity,
  EtaMetadataEntity,
  EtaModelEntity,
} from '../src/modules/learning/repository/entities/index.js';
import { INITIAL_APPLICATION_TABLES } from '../src/common/database/migrations/1793232000000-initial-orm-schema.js';
import { createTestDatabase } from './helpers/auth-database.js';

type Fixture = Awaited<ReturnType<typeof createTestDatabase>>;

test('concurrent TypeORM migration jobs record the initial migration only once', async () => {
  const fixture = await createTestDatabase([]);

  try {
    const applied = await Promise.all([
      runMigrations(fixture.database),
      runMigrations(fixture.database),
    ]);

    assert.equal(applied.flat().length, 1);
    assert.equal(await fixture.database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);
    assert.equal(await fixture.dataSource.showMigrations(), false);
  } finally {
    await fixture.close();
  }
});

async function installLegacyDatabase(fixture: Fixture, checksum?: string) {
  // Reproduce the actual pre-TypeORM release; application code never executes these archives.
  const sources = [
    'common/database/schema.sql',
    'modules/auth/repository/schema.sql',
    'modules/learning/repository/schema.sql',
  ];
  const sql = (
    await Promise.all(
      sources.map((path) => readFile(new URL('../src/' + path, import.meta.url), 'utf8')),
    )
  ).join('\n');

  await fixture.engine.exec(sql);

  const runner = fixture.dataSource.createQueryRunner();

  try {
    await runner.createTable(
      Table.create(
        fixture.dataSource.getMetadata(LegacySchemaMigrationEntity),
        fixture.dataSource.driver,
      ),
    );
  } finally {
    await runner.release();
  }

  await fixture.database
    .getRepository(LegacySchemaMigrationEntity)
    .insert({ version: '001-initial', checksum: checksum ?? (await legacySchemaChecksum()) });
}

test('TypeORM migrations create an empty database and preserve data on repeated runs', async () => {
  const fixture = await createTestDatabase([]);

  try {
    const applied = await runMigrations(fixture.database);
    assert.equal(applied.length, 1);

    const runner = fixture.dataSource.createQueryRunner();

    try {
      for (const table of INITIAL_APPLICATION_TABLES) {
        assert.equal(await runner.hasTable(table.name), true, `missing table: ${table.name}`);
      }
      assert.equal(await runner.hasTable('typeorm_migrations'), true);
      assert.equal(await runner.hasTable('schema_migrations'), false);
    } finally {
      await runner.release();
    }

    const id = randomUUID();
    await fixture.database
      .getRepository(UserEntity)
      .insert({ id, name: '보존 사용자', createdAt: Date.now() });
    await fixture.database.getRepository(EtaLearningStateEntity).update({ id: 1 }, { revision: 7 });

    assert.deepEqual(await runMigrations(fixture.database), []);
    assert.equal(
      (await fixture.database.getRepository(UserEntity).findOneByOrFail({ id })).name,
      '보존 사용자',
    );
    assert.equal(
      (await fixture.database.getRepository(EtaLearningStateEntity).findOneByOrFail({ id: 1 }))
        .revision,
      7,
    );
    assert.equal(await fixture.database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);
    assert.equal(await fixture.dataSource.showMigrations(), false);
  } finally {
    await fixture.close();
  }
});

test('adopting the original SQL release preserves account, receipt secret, JSON and model data', async () => {
  const fixture = await createTestDatabase([]);

  try {
    await installLegacyDatabase(fixture);

    const id = randomUUID(),
      sessionId = randomUUID(),
      now = Date.now();
    await fixture.database
      .getRepository(UserEntity)
      .insert({ id, name: '기존 사용자', createdAt: now });
    await fixture.database.getRepository(AccountDataEntity).save({
      userId: id,
      preferences: { walkingOnly: true },
      trips: { savedTrips: [], recentTrips: [] },
    });
    await fixture.database
      .getRepository(EtaMetadataEntity)
      .insert({ name: 'receipt-secret', value: 'a'.repeat(64) });
    await fixture.database
      .getRepository(EtaModelEntity)
      .save({ kind: 'contextual', payload: { preserved: true }, updatedAt: now });
    const legacyBefore = await fixture.database
      .getRepository(LegacySchemaMigrationEntity)
      .findOneByOrFail({ version: '001-initial' });

    await runMigrations(fixture.database);

    assert.equal(
      (await fixture.database.getRepository(UserEntity).findOneByOrFail({ id })).name,
      '기존 사용자',
    );
    assert.deepEqual(
      (await fixture.database.getRepository(AccountDataEntity).findOneByOrFail({ userId: id }))
        .preferences,
      { walkingOnly: true },
    );
    assert.equal(
      (
        await fixture.database
          .getRepository(EtaMetadataEntity)
          .findOneByOrFail({ name: 'receipt-secret' })
      ).value,
      'a'.repeat(64),
    );
    assert.deepEqual(
      (await fixture.database.getRepository(EtaModelEntity).findOneByOrFail({ kind: 'contextual' }))
        .payload,
      { preserved: true },
    );
    assert.deepEqual(
      await fixture.database
        .getRepository(LegacySchemaMigrationEntity)
        .findOneByOrFail({ version: '001-initial' }),
      legacyBefore,
    );

    // Existing ALWAYS IDENTITY columns must accept ORM inserts without supplying insertion_order.
    await fixture.database.getRepository(SessionEntity).insert({
      id: sessionId,
      userId: id,
      tokenHash: 'test-token-hash',
      csrfToken: 'test-csrf',
      label: '기존 스키마',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60_000,
    });
    assert.equal(
      (await fixture.database.getRepository(SessionEntity).findOneByOrFail({ id: sessionId }))
        .insertionOrder,
      1,
    );

    assert.deepEqual(await runMigrations(fixture.database), []);
    assert.equal(await fixture.database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);
  } finally {
    await fixture.close();
  }
});

test('legacy checksum mismatch and unmanaged partial databases fail before mutation', async () => {
  const fixture = await createTestDatabase([]);

  try {
    await installLegacyDatabase(fixture, 'changed-deployed-checksum');
    const id = randomUUID();
    await fixture.database
      .getRepository(UserEntity)
      .insert({ id, name: '유지', createdAt: Date.now() });

    await assert.rejects(runMigrations(fixture.database), /checksum changed/);
    assert.equal(await fixture.database.getRepository(UserEntity).countBy({ id }), 1);

    const runner = fixture.dataSource.createQueryRunner();
    try {
      assert.equal(await runner.hasTable('typeorm_migrations'), false);
      assert.equal(await runner.hasTable('orm_locks'), false);
    } finally {
      await runner.release();
    }
  } finally {
    await fixture.close();
  }

  const partial = await createTestDatabase([]);
  const runner = partial.dataSource.createQueryRunner();

  try {
    await runner.createTable(
      INITIAL_APPLICATION_TABLES.find((table) => table.name === 'users')!.clone(),
    );
    await runner.release();

    await assert.rejects(runMigrations(partial.database), /without verified migration history/);

    const inspection = partial.dataSource.createQueryRunner();

    try {
      assert.equal(await inspection.hasTable('typeorm_migrations'), false);
    } finally {
      await inspection.release();
    }
  } finally {
    if (!runner.isReleased) {
      await runner.release();
    }

    await partial.close();
  }
});

test('a failed TypeORM migration rolls back DDL and does not advance migration history', async () => {
  const fixture = await createTestDatabase();

  class FailAfterOrmSchema1793232000001 implements MigrationInterface {
    name = 'FailAfterOrmSchema1793232000001';
    async up(runner: QueryRunner) {
      await runner.createTable(
        new Table({
          name: 'failed_migration_scratch',
          columns: [{ name: 'id', type: 'integer', isPrimary: true }],
        }),
      );
      throw new Error('intentional-migration-failure');
    }
    async down() {}
  }

  try {
    fixture.dataSource.migrations.push(new FailAfterOrmSchema1793232000001());
    await assert.rejects(runMigrations(fixture.database), /intentional-migration-failure/);

    const runner = fixture.dataSource.createQueryRunner();
    try {
      assert.equal(await runner.hasTable('failed_migration_scratch'), false);
    } finally {
      await runner.release();
    }

    assert.equal(await fixture.database.getRepository(TypeOrmMigrationHistoryEntity).count(), 1);
  } finally {
    await fixture.close();
  }
});

const runtimeAssets = [
  'common/database/schema.sql',
  'modules/auth/repository/schema.sql',
  'modules/learning/repository/schema.sql',
  'common/engine/connectivity/data/seoul-metro-transfers.csv',
  'common/engine/connectivity/data/seoul-metro-transfers.metadata.json',
  'common/engine/realtime/data/korea-holidays-2026.json',
];

test('compiled deployment includes TypeORM migrations and immutable reference assets', async (t) => {
  try {
    await access(new URL('../dist/main.js', import.meta.url));
  } catch {
    t.skip('npm run build must precede deployment asset verification');
    return;
  }

  await access(
    new URL(
      '../dist/common/database/migrations/1793232000000-initial-orm-schema.js',
      import.meta.url,
    ),
  );

  for (const path of runtimeAssets) {
    assert.deepEqual(
      await readFile(new URL('../dist/' + path, import.meta.url)),
      await readFile(new URL('../src/' + path, import.meta.url)),
      `deployed asset differs: ${path}`,
    );
  }
});
