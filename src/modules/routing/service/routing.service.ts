import { Inject, Injectable } from '@nestjs/common';
import { RouteRepository } from '../repository/route.repository.js';

@Injectable()
export class RoutingService {
  constructor(@Inject(RouteRepository) private readonly routes: RouteRepository) {}

  search(body: unknown, gzip: boolean, disconnected: () => boolean) {
    return this.routes.search(body, gzip, disconnected);
  }
}
