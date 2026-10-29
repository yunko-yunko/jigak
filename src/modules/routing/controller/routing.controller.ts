import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RoutingService } from '../service/routing.service.js';

@Controller('routes')
export class RoutingController {
  constructor(@Inject(RoutingService) private readonly routing: RoutingService) {}

  @Post(['', 'search'])
  async search(@Req() request: Request, @Res() response: Response) {
    let disconnected = false;

    response.once('close', () => {
      if (!response.writableFinished) {
        disconnected = true;
      }
    });

    const result = await this.routing.search(
      request.body,
      !!request.get('Accept-Encoding') && request.acceptsEncodings('gzip', 'identity') === 'gzip',
      () => disconnected,
    );
    if (!result || disconnected) {
      return;
    }

    response.vary('Accept-Encoding').type('application/json');

    if (result.encoded.encoding) {
      response.setHeader('Content-Encoding', result.encoded.encoding);
    }

    response.setHeader('Server-Timing', result.serverTiming);

    response.status(200).send(result.encoded.body);
  }
}
