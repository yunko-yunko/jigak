import { Controller, Get, Inject, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
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

  /** 200 when ready; 503 with what is still starting (no paths or bucket names) otherwise. */
  @Get('ready')
  async ready(@Res() response: Response) {
    try {
      response.status(200).json(await this.health.ready());
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      response.status(503).json(error.getResponse());
    }
  }
}
