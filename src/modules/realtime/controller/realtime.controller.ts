import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { RealtimeApplicationService } from '../service/realtime.service.js';

@Controller()
export class RealtimeController {
  constructor(
    @Inject(RealtimeApplicationService) private readonly realtime: RealtimeApplicationService,
  ) {}

  @Get('realtime/mobility')
  mobility(@Query() query: unknown) {
    return this.realtime.mobility(query);
  }

  @Get('realtime/transit/nearby')
  nearby(@Query() query: unknown) {
    return this.realtime.nearby(query);
  }

  @Get('realtime/conditions')
  conditions(@Query() query: unknown) {
    return this.realtime.conditions(query);
  }

  @Post('realtime/arrivals')
  @HttpCode(200)
  arrivals(@Body() body: unknown) {
    return this.realtime.arrivals(body);
  }

  @Post('traffic/route')
  @HttpCode(200)
  traffic(@Body() body: unknown) {
    return this.realtime.traffic(body);
  }
}
