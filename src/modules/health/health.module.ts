import { Module } from '@nestjs/common';
import { HealthController } from './controller/health.controller.js';
import { HealthService } from './service/health.service.js';
import { HealthRepository } from './repository/health.repository.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService, HealthRepository],
})
export class HealthModule {}
