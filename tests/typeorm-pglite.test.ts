import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DataSource, EntitySchema } from 'typeorm';
import { createPGliteDriver } from './helpers/typeorm-pglite.js';

interface Counter {
  id: number;
  value: number;
}

const counter = new EntitySchema<Counter>({
  name: 'PGliteTransportCounter',
  tableName: 'pglite_transport_counter',
  columns: {
    id: {
      type: Number,
      primary: true,
    },
    value: {
      type: 'bigint',
      transformer: {
        to: (value: number) => value,
        from: (value: string) => Number(value),
      },
    },
  },
});

test('TypeORM PostgreSQL test transport preserves results, rollback and concurrent transactions', async () => {
  const engine = new PGlite();

  await engine.waitReady;

  const dataSource = new DataSource({
    type: 'postgres',
    database: 'template1',
    driver: createPGliteDriver(engine),
    entities: [counter],
    synchronize: true,
    installExtensions: false,
  });

  try {
    await dataSource.initialize();

    const repository = dataSource.getRepository(counter);

    await repository.insert({ id: 1, value: 1_729_000_000_000 });

    assert.deepEqual(await repository.findOneByOrFail({ id: 1 }), {
      id: 1,
      value: 1_729_000_000_000,
    });

    await assert.rejects(
      dataSource.transaction(async (manager) => {
        await manager.getRepository(counter).update({ id: 1 }, { value: 99 });

        throw new Error('Rollback fixture');
      }),
      /Rollback fixture/,
    );

    assert.equal((await repository.findOneByOrFail({ id: 1 })).value, 1_729_000_000_000);

    await Promise.all(
      Array.from({ length: 3 }, () =>
        dataSource.transaction(async (manager) => {
          const transactionalRepository = manager.getRepository(counter);
          const row = await transactionalRepository.findOneOrFail({
            where: { id: 1 },
            lock: { mode: 'pessimistic_write' },
          });

          await transactionalRepository.update({ id: row.id }, { value: row.value + 1 });
        }),
      ),
    );

    assert.equal((await repository.findOneByOrFail({ id: 1 })).value, 1_729_000_000_003);
    assert.equal((await repository.delete({ id: 1 })).affected, 1);
    assert.equal(await repository.count(), 0);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }

    await engine.close();
  }
});
