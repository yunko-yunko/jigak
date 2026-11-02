import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';

@Injectable()
export class SimulationRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  /** Null unless the server enabled MOBILITY_SIMULATION (scooter, ebike or both). */
  get simulation() {
    return this.runtime.options.scooterSimulation ?? null;
  }

  /** The API's public address (HTTPS in production); TLS ends at the proxy in front of it. */
  get publicBaseUrl(): string | undefined {
    return process.env.AUTH_PUBLIC_BASE_URL || undefined;
  }

  now() {
    return (this.runtime.options.now ?? Date.now)();
  }
}
