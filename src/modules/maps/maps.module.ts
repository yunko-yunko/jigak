import { Module } from '@nestjs/common';
import { MapsController } from './controller/maps.controller.js';
import { MapsService } from './service/maps.service.js';
import { MapArchiveRepository } from './repository/map-archive.repository.js';
import { MapByteBudgetRepository } from './repository/map-byte-budget.repository.js';

@Module({
  controllers: [MapsController],
  providers: [MapsService, MapArchiveRepository, MapByteBudgetRepository],
})
export class MapsModule {}
