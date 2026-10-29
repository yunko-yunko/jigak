import { Inject, Injectable } from '@nestjs/common';
import { parseDto } from '../../../common/dto/parse.js';
import { RealtimeRepository } from '../repository/realtime.repository.js';
import {
  pointQuerySchema,
  mobilityQuerySchema,
  arrivalsSchema,
  routeLegsSchema,
} from '../dto/realtime.dto.js';

@Injectable()
export class RealtimeApplicationService {
  constructor(@Inject(RealtimeRepository) private readonly realtime: RealtimeRepository) {}

  mobility(query: unknown) {
    const input = parseDto(mobilityQuerySchema, query);

    return this.realtime.mobility(input, input.radius);
  }

  nearby(query: unknown) {
    return this.realtime.nearby(parseDto(pointQuerySchema, query));
  }

  conditions(query: unknown) {
    return this.realtime.conditions(parseDto(pointQuerySchema, query));
  }

  arrivals(body: unknown) {
    return this.realtime.arrivals(parseDto(arrivalsSchema, body));
  }

  traffic(body: unknown) {
    return this.realtime.traffic(parseDto(routeLegsSchema, body));
  }
}
