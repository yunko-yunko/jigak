import { Inject, Injectable } from '@nestjs/common';
import { parseDto } from '../../../common/dto/parse.js';
import { ApiError } from '../../../common/errors.js';
import { RealtimeRepository } from '../repository/realtime.repository.js';
import {
  pointQuerySchema,
  mobilityQuerySchema,
  arrivalsSchema,
  routeLegsSchema,
  subwayLineQuerySchema,
} from '../dto/realtime.dto.js';

@Injectable()
export class RealtimeApplicationService {
  constructor(@Inject(RealtimeRepository) private readonly realtime: RealtimeRepository) {}

  mobility(query: unknown) {
    const input = parseDto(mobilityQuerySchema, query);

    return this.realtime.mobility(input, input.radius, { limit: input.limit, kinds: input.kinds });
  }

  async subwayLine(query: unknown) {
    const input = parseDto(subwayLineQuerySchema, query, '노선과 역 이름을 확인해 주세요.');
    if (!this.realtime.subwayLinesConfigured) {
      throw new ApiError('LIVE_NOT_CONFIGURED', '실시간 열차 위치를 사용할 수 없어요.', 503);
    }

    let view: Awaited<ReturnType<RealtimeRepository['subwayLine']>>;

    try {
      view = await this.realtime.subwayLine(input.line, input.station);
    } catch (error) {
      throw error instanceof ApiError
        ? error
        : new ApiError(
            'PROVIDER_UNAVAILABLE',
            '실시간 열차 위치를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
          );
    }
    if (!view) {
      throw new ApiError('NO_ROUTES', '이 노선의 실시간 열차 위치는 제공되지 않아요.', 404);
    }

    return view;
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
