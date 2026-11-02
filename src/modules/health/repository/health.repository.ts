import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
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

  /**
   * 503 until the database is migrated and, with the demo simulator on, until today's window is
   * ready (§22), so a startup probe keeps traffic away from an instance that would answer without
   * it. MOBILITY_SIMULATION_READY_GATE=false waits for the database only.
   */
  async ready() {
    const ready = await this.database.getRepository(EtaLearningStateEntity).existsBy({ id: 1 });

    if (!ready) {
      throw new ServiceUnavailableException({ status: 'starting', database: 'migration-required' });
    }

    const simulation = this.runtime.options.scooterSimulation;
    const now = (this.runtime.options.now ?? Date.now)();
    if (simulation?.readyGate && !simulation.isReady(now)) {
      throw new ServiceUnavailableException({
        status: 'starting',
        database: 'ready',
        simulation: simulation.readiness(now),
      });
    }

    if (!simulation) {
      return { status: 'ok', database: 'ready', simulation: { enabled: false } };
    }
    const { ready: simulationReady, serviceDay, source } = simulation.readiness(now);
    return {
      status: 'ok',
      database: 'ready',
      simulation: { enabled: true, ready: simulationReady, serviceDay, source },
    };
  }
}
