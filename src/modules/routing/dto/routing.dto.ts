import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import {
  validatePreferences,
  type BasePlanningRequest,
} from '../../../common/shared/domain/index.js';

export const placeSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    name: z.string().trim().min(1).max(300),
    address: z.string().max(500),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    note: z.string().max(1_000).optional(),
  })
  .strict();
export const preferencesSchema = z
  .object({
    walkingOnly: z.boolean().optional(),
    allowRunning: z.boolean(),
    allowBicycle: z.boolean(),
    maxRunningMeters: z.number().int().min(0).max(5_000),
    maxBicycleMeters: z.number().int().min(0).max(10_000),
    runningPace: z.enum(['easy', 'steady']),
    preparationSeconds: z.number().int().min(0).max(3_600),
    bicycleReady: z.boolean(),
    allowTaxi: z.boolean().optional(),
    allowScooter: z.boolean().optional(),
    hasCar: z.boolean().optional(),
    carLocation: placeSchema.optional(),
  })
  .strict();

export const routeSchema = z
  .object({
    origin: placeSchema,
    destination: placeSchema,
    deadline: z.number().int().positive(),
    now: z.number().int().positive(),
    preferences: preferencesSchema,
    purpose: z.enum(['search', 'urgent', 'replan']).optional(),
  })
  .strict();
export const querySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    latitude: z.coerce.number().finite().min(-90).max(90).optional(),
    longitude: z.coerce.number().finite().min(-180).max(180).optional(),
  })
  .strict()
  .refine(
    (value) => (value.latitude === undefined) === (value.longitude === undefined),
    'latitude와 longitude를 함께 입력해 주세요.',
  );

export const pointQuerySchema = z
  .object({
    latitude: z.coerce.number().finite().min(-90).max(90),
    longitude: z.coerce.number().finite().min(-180).max(180),
  })
  .strict();
export const boardingSchema = z
  .object({
    mode: z.enum(['bus', 'subway']),
    stop: z.string().trim().min(1).max(300),
    lines: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
    nextStops: z.array(z.string().trim().min(1).max(300)).max(200),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();
export const arrivalsSchema = z
  .object({
    boardings: z.array(boardingSchema).min(1).max(4),
  })
  .strict();
export const coordinatePair = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export const routeLegsSchema = z
  .object({
    legs: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(300),
            mode: z.enum(['bus', 'taxi', 'car']),
            path: z.array(coordinatePair).min(2).max(6_000),
            distanceMeters: z.number().finite().min(0).max(500_000),
            baseSeconds: z.number().finite().min(0).max(86_400),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export function parseRoute(body: unknown, now: number): BasePlanningRequest {
  const parsed = routeSchema.safeParse(body);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'request')),
    ].slice(0, 6);
    throw new ApiError('INVALID_INPUT', `입력을 확인해 주세요: ${fields.join(', ')}.`, 400);
  }

  const request = parsed.data;
  const windowMs = 48 * 60 * 60 * 1_000;
  const acceptsElapsed = request.purpose === 'urgent' || request.purpose === 'replan';
  if (acceptsElapsed && Math.abs(request.deadline - now) > windowMs) {
    throw new ApiError(
      'INVALID_INPUT',
      '긴급 길찾기와 재탐색의 마감은 현재 시각을 기준으로 지난 48시간부터 앞으로 48시간 안이어야 해요.',
      400,
    );
  }
  if (!acceptsElapsed && (request.deadline <= now || request.deadline > now + windowMs)) {
    throw new ApiError(
      'INVALID_INPUT',
      request.deadline <= now
        ? '도착 마감이 지났어요. 원래 마감을 유지하려면 긴급 길찾기로 조회해 주세요.'
        : '도착 마감은 현재보다 늦고 48시간 이내여야 해요.',
      400,
    );
  }
  if (Math.abs(request.now - now) > 120_000) {
    throw new ApiError(
      'INVALID_INPUT',
      '기기의 현재 시각이 서버와 달라요. 기기 시각을 확인하고 다시 검색해 주세요.',
      400,
    );
  }
  if (
    request.origin.latitude === request.destination.latitude &&
    request.origin.longitude === request.destination.longitude
  ) {
    throw new ApiError(
      'INVALID_INPUT',
      '출발지와 목적지가 같아요. 다른 지점을 선택해 주세요.',
      400,
    );
  }
  if (
    !request.preferences.walkingOnly &&
    request.preferences.allowRunning &&
    request.preferences.maxRunningMeters === 0
  ) {
    throw new ApiError(
      'INVALID_INPUT',
      '달리기를 허용하려면 최대 달리기 거리를 입력해 주세요.',
      400,
    );
  }
  if (
    !request.preferences.walkingOnly &&
    request.preferences.allowBicycle &&
    request.preferences.maxBicycleMeters === 0
  ) {
    throw new ApiError(
      'INVALID_INPUT',
      '자전거를 허용하려면 최대 자전거 거리를 입력해 주세요.',
      400,
    );
  }

  validatePreferences(request.preferences);

  return request;
}
