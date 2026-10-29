import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PlacesService } from '../service/places.service.js';

@Controller('places')
export class PlacesController {
  constructor(@Inject(PlacesService) private readonly places: PlacesService) {}

  @Get()
  search(@Query() query: unknown) {
    return this.places.search(query);
  }

  @Get('reverse')
  reverse(@Query() query: unknown) {
    return this.places.reverse(query);
  }
}
