import { z } from 'zod';

export const TIME_MODES = ['walk', 'run', 'bicycle', 'bus', 'subway', 'taxi'] as const;
export type TimeMode = (typeof TIME_MODES)[number];
export const TIME_LABELS: Record<TimeMode, string> = {
  walk: '걷기',
  run: '달리기',
  bicycle: '자전거',
  bus: '버스',
  subway: '지하철',
  taxi: '택시',
};
const pointSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();
export const timePreferencesSchema = z
  .object({
    walkingOnly: z.boolean(),
    allowRunning: z.boolean(),
    allowBicycle: z.boolean(),
    bicycleReady: z.boolean(),
    allowTaxi: z.boolean(),
    maxRunningMeters: z.number().finite().min(0).max(100_000),
    maxBicycleMeters: z.number().finite().min(0).max(100_000),
  })
  .strict();
export const travelTimeRequestSchema = z
  .object({
    distanceMeters: z.number().finite().min(30).max(100_000),
    runningPace: z.enum(['easy', 'steady']),
    preparationSeconds: z.number().int().min(0).max(3600),
    // Coordinates are used by routing/transit suppliers only, never sent to GPT.
    journey: z
      .object({
        origin: pointSchema,
        destination: pointSchema,
        preferences: timePreferencesSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TravelTimeRequest = z.infer<typeof travelTimeRequestSchema>;
export const timeEstimateSchema = z
  .object({
    mode: z.enum(TIME_MODES),
    seconds: z.number().int().min(1).max(172800),
    minSeconds: z.number().int().min(1).max(172800),
    maxSeconds: z.number().int().min(1).max(172800),
  })
  .strict()
  .refine(
    (v) => v.minSeconds <= v.seconds && v.seconds <= v.maxSeconds && v.minSeconds < v.maxSeconds,
  );
export const timeEstimatesSchema = z
  .array(timeEstimateSchema)
  .length(6)
  .refine((values) =>
    TIME_MODES.every((mode) => values.filter((value) => value.mode === mode).length === 1),
  );
export const boardingEstimateSchema = z
  .object({
    mode: z.enum(['bus', 'subway']),
    stopName: z.string().max(300),
    line: z.string().max(500),
    direction: z.string().max(500),
    status: z.enum(['live', 'unavailable', 'missed', 'stale', 'future', 'no-service']),
    source: z.enum(['seoul-subway', 'seoul-bus', 'tago-bus']).nullable(),
    observedAt: z.number().int().positive().nullable(),
    checkedAt: z.number().int().positive(),
    nextArrivalAt: z.number().int().positive().nullable(),
    selectedArrivalAt: z.number().int().positive().nullable(),
    nextLine: z.string().max(500).nullable().optional(),
    nextDirection: z.string().max(500).nullable().optional(),
    accessSeconds: z.number().int().nonnegative(),
    waitSeconds: z.number().int().nonnegative().nullable(),
    included: z.boolean(),
  })
  .strict();
export const timeDetailSchema = z
  .object({
    mode: z.enum(TIME_MODES),
    basis: z.enum(['live-transit', 'route-estimate', 'gpt', 'distance-rule']),
    eligible: z.boolean(),
    note: z.string().max(1500),
    routeTitle: z.string().max(1000),
    distanceMeters: z.number().finite().nonnegative(),
    boardings: z.array(boardingEstimateSchema).max(12),
  })
  .strict();
export type TimeDetail = z.infer<typeof timeDetailSchema>;
export type BoardingEstimate = z.infer<typeof boardingEstimateSchema>;
export const travelTimeResponseSchema = z
  .object({
    source: z.enum(['gpt', 'distance-rule']),
    generatedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    distanceMeters: z.number().finite().min(30).max(100_000),
    preparationSeconds: z.number().int().min(0).max(3600),
    estimates: timeEstimatesSchema,
    notice: z.string().max(1000),
    fallbackReason: z
      .enum(['not-configured', 'provider-error', 'invalid-response', 'timeout', 'busy'])
      .nullable(),
    comparison: z
      .object({
        details: z
          .array(timeDetailSchema)
          .length(6)
          .refine((values) =>
            TIME_MODES.every((mode) => values.filter((value) => value.mode === mode).length === 1),
          ),
        recommendedMode: z.enum(TIME_MODES).nullable(),
        refreshAfter: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.expiresAt > v.generatedAt && v.expiresAt <= v.generatedAt + 300_000);
export type TravelTimeResponse = z.infer<typeof travelTimeResponseSchema>;

/** These are explicit distance scenarios, not observed routes, stock or departures. */
export const TIME_ASSUMPTIONS: Record<TimeMode, string> = {
  walk: '보행 우회와 횡단 대기를 가정한 시간',
  run: '설정한 달리기 속도와 횡단 대기를 가정한 시간',
  bicycle: '자전거 이동 시간',
  bus: '정류장 접근·대기 약 10분 포함 · 노선 미확인',
  subway: '역 접근·대기 약 12분 포함 · 노선 미확인',
  taxi: '승차 대기 약 5분 포함 · 배차·교통량 미확인',
};

export function travelTimeScenarios(input: TravelTimeRequest) {
  const speed: Record<TimeMode, number> = {
    walk: 4.5,
    run: input.runningPace === 'steady' ? 9 : 7,
    bicycle: 14,
    bus: 18,
    subway: 30,
    taxi: 25,
  };
  const detour: Record<TimeMode, number> = {
    walk: 1.25,
    run: 1.25,
    bicycle: 1.3,
    bus: 1.5,
    subway: 1.35,
    taxi: 1.4,
  };
  const extra: Record<TimeMode, number> = {
    walk: 0,
    run: 0,
    bicycle: 0,
    bus: 600,
    subway: 720,
    taxi: 300,
  };
  return TIME_MODES.map((mode) => ({
    mode,
    assumedDistanceMeters: Math.round(input.distanceMeters * detour[mode]),
    assumedSpeedKmh: speed[mode],
    assumedAccessWaitSeconds: extra[mode],
    baselineSeconds: Math.round(
      (input.distanceMeters * detour[mode]) / (speed[mode] / 3.6) + extra[mode],
    ),
  }));
}
