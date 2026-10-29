import { Controller, Get, Inject } from '@nestjs/common';
import { ModelsService } from '../service/models.service.js';

@Controller('models')
export class ModelsController {
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get('public-bus')
  bus() {
    return this.models.bus();
  }

  @Get('public-bicycle')
  bicycle() {
    return this.models.bicycle();
  }
}
