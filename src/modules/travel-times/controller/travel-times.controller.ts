import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { TravelTimesService } from '../service/travel-times.service.js';

@Controller('travel-times')
export class TravelTimesController {
  constructor(@Inject(TravelTimesService) private readonly times: TravelTimesService) {}

  @Post()
  @HttpCode(200)
  estimate(@Body() body: unknown) {
    return this.times.estimate(body);
  }
}
