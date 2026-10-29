import { Global, Module } from '@nestjs/common';
import { LearningModule } from '../../modules/learning/learning.module.js';
import { RuntimeRepository } from './runtime.repository.js';

@Global()
@Module({
  imports: [LearningModule],
  providers: [RuntimeRepository],
  exports: [RuntimeRepository],
})
export class RuntimeModule {}
