import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService } from '../service/health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  snapshot() {
    return this.health.snapshot();
  }

  @Get('live')
  live() {
    return {
      status: 'ok',
    };
  }

  @Get('ready')
  ready() {
    return this.health.ready();
  }
}
