import type { ZodType } from 'zod';
import { ApiError } from '../errors.js';

export function parseDto<T>(
  schema: ZodType<T>,
  value: unknown,
  message = '입력을 확인해 주세요.',
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError('INVALID_INPUT', message, 400);
  }

  return result.data;
}
