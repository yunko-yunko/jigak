import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { DatabaseService } from '../../../common/database/database.service.js';
import { healthSnapshot } from '../domain/health-snapshot.js';
import { EtaLearningStateEntity } from '../../learning/repository/entities/index.js';

@Injectable()
export class HealthRepository {
  constructor(
    @Inject(RuntimeRepository) private readonly runtime: RuntimeRepository,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  snapshot() {
    return healthSnapshot(this.runtime.options);
  }

  async ready() {
    const ready = await this.database.getRepository(EtaLearningStateEntity).existsBy({ id: 1 });

    if (!ready) {
      throw new Error('Database migration is required.');
    }

    return {
      status: 'ok',
      database: 'ready',
    };
  }
}
