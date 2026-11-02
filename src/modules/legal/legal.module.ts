import { Module } from '@nestjs/common';
import { LegalController } from './controller/legal.controller.js';

@Module({
  controllers: [LegalController],
})
export class LegalModule {}
