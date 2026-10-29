import { Inject, Injectable } from '@nestjs/common';
import { HealthRepository } from '../repository/health.repository.js';

@Injectable()
export class HealthService {
  constructor(@Inject(HealthRepository) private readonly health: HealthRepository) {}

  snapshot() {
    return this.health.snapshot();
  }

  ready() {
    return this.health.ready();
  }
}
