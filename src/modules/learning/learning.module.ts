import { Module } from '@nestjs/common';
import { LearningController } from './controller/learning.controller.js';
import { LearningRepository } from './repository/learning.repository.js';
import { LearningService } from './service/learning.service.js';

@Module({
  controllers: [LearningController],
  providers: [LearningRepository, LearningService],
  exports: [LearningService, LearningRepository],
})
export class LearningModule {}
