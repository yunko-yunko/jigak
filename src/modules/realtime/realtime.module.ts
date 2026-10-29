import { Module } from '@nestjs/common';
import { RealtimeController } from './controller/realtime.controller.js';
import { RealtimeApplicationService } from './service/realtime.service.js';
import { RealtimeRepository } from './repository/realtime.repository.js';

@Module({
  controllers: [RealtimeController],
  providers: [RealtimeApplicationService, RealtimeRepository],
})
export class RealtimeModule {}
