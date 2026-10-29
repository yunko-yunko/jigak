import { EntitySchema } from 'typeorm';

export interface OrmLock {
  key: string;
}

export const OrmLockEntity = new EntitySchema<OrmLock>({
  name: 'OrmLock',
  tableName: 'orm_locks',
  columns: {
    key: { type: 'text', primary: true, primaryKeyConstraintName: 'orm_locks_pkey' },
  },
});
