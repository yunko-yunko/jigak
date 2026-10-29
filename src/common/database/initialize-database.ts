import type { DataSource } from 'typeorm';
import { DatabaseService } from './database.service.js';
import { runMigrations } from './migrate.js';

/** Finish locked, transactional migrations before Nest exposes the shared connection. */
export async function initializeDatabase(dataSource: DataSource) {
  try {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }

    const applied = await runMigrations(new DatabaseService(dataSource));

    console.info(
      JSON.stringify({
        severity: 'INFO',
        event: 'database-migrations-complete',
        message: 'TypeORM database migration complete.',
        appliedCount: applied.length,
      }),
    );

    return dataSource;
  } catch (error) {
    if (dataSource.isInitialized) {
      await dataSource.destroy().catch(() => {
        console.error('마이그레이션 실패 후 DB 연결 종료 중 오류가 발생했습니다.');
      });
    }

    throw error;
  }
}
