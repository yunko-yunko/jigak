import { EntitySchema } from 'typeorm';
import { bigintNumberTransformer } from '../transformers.js';

export interface LegacySchemaMigration {
  version: string;
  checksum: string;
  appliedAt: Date;
}

/** Read-only mapping used to adopt a database installed by the original release. */
export const LegacySchemaMigrationEntity = new EntitySchema<LegacySchemaMigration>({
  name: 'LegacySchemaMigration',
  tableName: 'schema_migrations',
  synchronize: false,
  columns: {
    version: { type: 'text', primary: true },
    checksum: { type: 'text' },
    appliedAt: { name: 'applied_at', type: 'timestamptz', default: () => 'now()' },
  },
});

export interface TypeOrmMigrationHistory {
  id: number;
  timestamp: number;
  name: string;
}

/** TypeORM's MigrationExecutor owns this table; this schema only reads its history. */
export const TypeOrmMigrationHistoryEntity = new EntitySchema<TypeOrmMigrationHistory>({
  name: 'TypeOrmMigrationHistory',
  tableName: 'typeorm_migrations',
  synchronize: false,
  columns: {
    id: { type: 'integer', primary: true, generated: 'increment' },
    timestamp: { type: 'bigint', transformer: bigintNumberTransformer },
    name: { type: 'varchar' },
  },
});
