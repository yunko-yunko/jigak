import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiError } from '../../../common/engine/errors.js';
import type { DeleteLearningDto, SubmitLearningDto } from '../dto/learning.dto.js';
import { LearningService } from '../service/learning.service.js';

@Controller('learning')
export class LearningController {
  constructor(@Inject(LearningService) private readonly learning: LearningService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return this.learning.status();
  }

  @Post('observations')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async submit(@Body() body: SubmitLearningDto) {
    try {
      return await this.learning.submit(body);
    } catch {
      throw new ApiError(
        'INVALID_INPUT',
        '학습 기록의 동의·완료 시각·유효한 수집 정보를 확인해 주세요.',
        400,
      );
    }
  }

  @Delete('observations')
  @Header('Cache-Control', 'no-store')
  async erase(@Body() body: DeleteLearningDto) {
    try {
      return await this.learning.erase(body);
    } catch {
      throw new ApiError('INVALID_INPUT', '학습 기록을 삭제할 수집 정보를 확인해 주세요.', 400);
    }
  }
}
