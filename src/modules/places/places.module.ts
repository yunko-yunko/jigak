import { Module } from '@nestjs/common';
import { PlacesController } from './controller/places.controller.js';
import { PlacesService } from './service/places.service.js';
import { PlacesRepository } from './repository/places.repository.js';

@Module({
  controllers: [PlacesController],
  providers: [PlacesService, PlacesRepository],
})
export class PlacesModule {}
