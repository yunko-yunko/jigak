import { Controller, Get, Inject } from '@nestjs/common';
import { ModelsService } from '../service/models.service.js';

@Controller('models')
export class ModelsController {
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get('public-bus')
  bus() {
    return this.models.bus();
  }

  /** Every served model plus the refresh job's state (manifest, last run, next run, retries). */
  @Get()
  all() {
    return this.models.all();
  }

  @Get('refresh')
  refresh() {
    return this.models.refresh();
  }

  @Get('public-bicycle')
  bicycle() {
    return this.models.bicycle();
  }
}
