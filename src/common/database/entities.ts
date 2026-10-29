import { authEntities } from '../../modules/auth/repository/entities/index.js';
import { learningEntities } from '../../modules/learning/repository/entities/index.js';
import { ApiRateWindowEntity } from './entities/api-rate-window.entity.js';
import { OrmLockEntity } from './entities/orm-lock.entity.js';
import {
  LegacySchemaMigrationEntity,
  TypeOrmMigrationHistoryEntity,
} from './entities/migration-history.entity.js';

export const ALL_ENTITIES = [
  ...authEntities,
  ...learningEntities,
  ApiRateWindowEntity,
  OrmLockEntity,
  LegacySchemaMigrationEntity,
  TypeOrmMigrationHistoryEntity,
];
