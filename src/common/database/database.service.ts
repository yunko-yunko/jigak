import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, type EntityManager, type EntityTarget, type ObjectLiteral } from 'typeorm';
import { OrmLockEntity } from './entities/orm-lock.entity.js';

@Injectable()
export class DatabaseService {
  constructor(@InjectDataSource() readonly dataSource: DataSource) {}

  get manager() {
    return this.dataSource.manager;
  }

  getRepository<T extends ObjectLiteral>(target: EntityTarget<T>) {
    return this.dataSource.getRepository(target);
  }

  transaction<T>(task: (manager: EntityManager) => Promise<T>) {
    return this.dataSource.transaction(task);
  }

  /** Bounded lock buckets coordinate multi-instance operations without handwritten SQL. */
  async lock(manager: EntityManager, resource: string) {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('A transaction is required for database locking.');
    }

    const bucket = createHash('sha256').update(resource).digest().readUInt16BE(0) % 1024;
    const key = `lock:${bucket}`;
    const locks = manager.getRepository(OrmLockEntity);

    await locks.createQueryBuilder().insert().values({ key }).orIgnore().execute();

    await locks.findOneOrFail({
      where: { key },
      lock: { mode: 'pessimistic_write' },
    });
  }
}
