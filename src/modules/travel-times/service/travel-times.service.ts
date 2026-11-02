import { Inject, Injectable } from '@nestjs/common';
import { parseDto } from '../../../common/dto/parse.js';
import { ApiError } from '../../../common/errors.js';
import { TravelTimesRepository } from '../repository/travel-times.repository.js';
import { travelTimeRequestSchema } from '../dto/travel-times.dto.js';

@Injectable()
export class TravelTimesService {
  constructor(@Inject(TravelTimesRepository) private readonly times: TravelTimesRepository) {}

  estimate(body: unknown) {
    const input = parseDto(
      travelTimeRequestSchema,
      body,
      '이동 거리와 시간 계산 조건을 확인해 주세요. 지원 거리는 30m~100km예요.',
    );
    if (!this.times.configured) {
      throw new ApiError('LIVE_NOT_CONFIGURED', '시간 계산 기능이 설정되지 않았어요.', 503);
    }

    return this.times.estimate(input);
  }
}
