import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MapsService } from '../service/maps.service.js';
import { NGII_ARCHIVE_FILE } from '../domain/map-archive.js';

@Controller('maps')
export class MapsController {
  constructor(@Inject(MapsService) private readonly maps: MapsService) {}

  /** GET and HEAD (Express answers HEAD with the GET route). CORS is set in configure-app. */
  @Get(NGII_ARCHIVE_FILE)
  async ngii(@Req() request: Request, @Res() response: Response) {
    // request.ip follows TRUST_PROXY_HOPS, as the request limiter's does.
    const reply = await this.maps.ngii(
      request.method,
      request.get('range'),
      request.ip ?? 'unknown',
    );

    response.status(reply.status);
    for (const [name, value] of Object.entries(reply.headers)) response.setHeader(name, value);
    if (reply.error) {
      response.json({ error: reply.error });
    } else if (reply.body) {
      response.end(reply.body);
    } else {
      response.end();
    }
  }
}
