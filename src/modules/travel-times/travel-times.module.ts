import { Module } from '@nestjs/common';
import { TravelTimesController } from './controller/travel-times.controller.js';
import { TravelTimesService } from './service/travel-times.service.js';
import { TravelTimesRepository } from './repository/travel-times.repository.js';

@Module({
  controllers: [TravelTimesController],
  providers: [TravelTimesService, TravelTimesRepository],
})
export class TravelTimesModule {}
