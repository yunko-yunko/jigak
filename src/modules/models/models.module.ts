import { Module } from '@nestjs/common';
import { ModelsController } from './controller/models.controller.js';
import { ModelsService } from './service/models.service.js';
import { ModelsRepository } from './repository/models.repository.js';

@Module({
  controllers: [ModelsController],
  providers: [ModelsService, ModelsRepository],
})
export class ModelsModule {}
