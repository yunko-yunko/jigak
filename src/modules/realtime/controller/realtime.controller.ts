import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { encodeRouteResponse } from '../../../common/engine/route-response.js';
import { RealtimeApplicationService } from '../service/realtime.service.js';

@Controller()
export class RealtimeController {
  constructor(
    @Inject(RealtimeApplicationService) private readonly realtime: RealtimeApplicationService,
  ) {}

  /** Up to 2,500 markers (about 1 MB of JSON), so the answer is gzipped like a route search. */
  @Get('realtime/mobility')
  async mobility(@Req() request: Request, @Res() response: Response) {
    const snapshot = await this.realtime.mobility(request.query);
    const encoded = await encodeRouteResponse(
      snapshot,
      !!request.get('Accept-Encoding') && request.acceptsEncodings('gzip', 'identity') === 'gzip',
    );
    response.vary('Accept-Encoding').type('application/json');
    if (encoded.encoding) response.setHeader('Content-Encoding', encoded.encoding);
    response.status(200).send(encoded.body);
  }

  @Get('realtime/subway/line')
  subwayLine(@Query() query: unknown) {
    return this.realtime.subwayLine(query);
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
