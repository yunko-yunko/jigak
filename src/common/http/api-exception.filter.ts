import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, safeApiError } from '../errors.js';
import { PlanningError } from '../shared/domain/types.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent || response.destroyed) {
      return;
    }

    let safe: ApiError;

    if (error instanceof PlanningError) {
      safe = new ApiError('INVALID_INPUT', error.message, 400);
    } else if (error instanceof SyntaxError && 'body' in error) {
      safe = new ApiError('INVALID_INPUT', '요청 본문이 올바른 JSON 형식이 아니에요.', 400);
    } else if (
      typeof error === 'object' &&
      error &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      safe = new ApiError('INVALID_INPUT', '요청 본문이 너무 커요.', 413);
    } else if (error instanceof HttpException) {
      safe = new ApiError(
        error.getStatus() === 429 ? 'TOO_MANY_REQUESTS' : 'INVALID_INPUT',
        error.getStatus() === 404
          ? '이 API 경로는 제공되지 않아요.'
          : '입력과 요청 방식을 확인해 주세요.',
        error.getStatus(),
      );
    } else {
      safe = safeApiError(error);
    }

    response.status(safe.status).json({
      error: {
        code: safe.code,
        message: safe.message,
      },
    });
  }
}
