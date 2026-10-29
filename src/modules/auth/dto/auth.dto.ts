import { z } from 'zod';
import { ApiError } from '../../../common/errors.js';
import { CONSENT_VERSION } from '../domain/types.js';

export const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const startSchema = z
  .object({
    platform: z.enum(['web', 'native']),
    challenge: challengeSchema,
  })
  .strict();

export const callbackSchema = z
  .object({
    state: tokenSchema,
    code: z.string().min(1).max(4_096).optional(),
    error: z.string().max(100).optional(),
    error_description: z.string().max(500).optional(),
    user: z.string().max(4_096).optional(),
  })
  .passthrough();

export const exchangeSchema = z
  .object({
    ticket: tokenSchema,
    verifier: verifierSchema,
  })
  .strict();

export const consentSchema = z
  .object({
    termsVersion: z.literal(CONSENT_VERSION),
    privacyVersion: z.literal(CONSENT_VERSION),
    marketingConsent: z.boolean(),
  })
  .strict();

export const nameSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
  })
  .strict();

export const preferenceSchema = z
  .object({
    walkingOnly: z.boolean().optional(),
    allowRunning: z.boolean(),
    allowBicycle: z.boolean(),
    maxRunningMeters: z.number().int().min(0).max(5_000),
    maxBicycleMeters: z.number().int().min(0).max(10_000),
    runningPace: z.enum(['easy', 'steady']),
    preparationSeconds: z.number().int().min(0).max(3_600),
    bicycleReady: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.walkingOnly || !value.allowRunning || value.maxRunningMeters > 0,
    '달리기 거리를 설정해 주세요.',
  )
  .refine(
    (value) => value.walkingOnly || !value.allowBicycle || value.maxBicycleMeters > 0,
    '자전거 거리를 설정해 주세요.',
  );

export const placeSchema = z
  .object({
    id: z.string().min(1).max(300),
    name: z.string().min(1).max(300),
    address: z.string().max(500),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    note: z.string().max(140).optional(),
  })
  .strict();

export const tripSchema = z
  .object({
    id: z.string().min(1).max(300),
    origin: placeSchema,
    destination: placeSchema,
    mode: z.enum(['demo', 'live']),
    savedAt: z.number().int().nonnegative(),
  })
  .strict();

export const tripsSchema = z
  .object({
    savedTrips: z.array(tripSchema).max(10),
    recentTrips: z.array(tripSchema).max(5),
  })
  .strict();

export const supportSchema = z
  .object({
    category: z.enum(['route', 'account', 'bug', 'suggestion', 'other']),
    message: z.string().trim().min(10).max(2_000),
    email: z.email().max(254).optional(),
  })
  .strict();

export const deleteAccountSchema = z
  .object({
    confirmation: z.literal('탈퇴'),
  })
  .strict();

export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message = '입력 내용을 확인해 주세요.',
): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new ApiError('INVALID_INPUT', message, 400);
  }

  return result.data;
}
