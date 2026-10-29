import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { executeRouteSearch } from '../domain/route-search.js';

@Injectable()
export class RouteRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  search(body: unknown, gzip: boolean, disconnected: () => boolean) {
    return executeRouteSearch(body, this.runtime.options, gzip, disconnected);
  }
}
