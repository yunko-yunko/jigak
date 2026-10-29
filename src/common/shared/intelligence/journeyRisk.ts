import { z } from 'zod';
import type { Route } from '../domain/types.js';

const positive = z.number().finite().positive().max(86400);

export const journeyRiskSchema = z
  .object({
    modelVersion: z.literal('eta-journey-v1'),
    policy: z.literal('rank-only-conservative-envelope'),
    target: z.literal('navigation-start-to-confirmed-arrival'),
    evaluatedAt: z.number().int().positive(),
    sourceDurationSeconds: z
      .object({
        min: z.number().finite().nonnegative(),
        max: z.number().finite().nonnegative(),
      })
      .strict()
      .refine((v) => v.min <= v.max),
    lowerSeconds: positive,
    medianSeconds: positive,
    upperSeconds: positive,
    extraUpperSeconds: z.number().int().min(0).max(86400),
  })
  .strict()
  .refine(
    (v) =>
      v.lowerSeconds <= v.medianSeconds &&
      v.medianSeconds <= v.upperSeconds &&
      v.extraUpperSeconds === Math.max(0, Math.ceil(v.upperSeconds - v.sourceDurationSeconds.max)),
  );

export type JourneyRiskMetadata = z.infer<typeof journeyRiskSchema>;

export type JourneyRiskPrediction = Pick<
  JourneyRiskMetadata,
  'modelVersion' | 'policy' | 'lowerSeconds' | 'medianSeconds' | 'upperSeconds'
>;

/** The aggregate uncertainty is not a physical step or a delayed boarding prediction. */
export function journeyRiskSeconds(route: Route): number {
  const risk = route.journeyEta;

  if (!risk) {
    return 0;
  }

  const parsed = journeyRiskSchema.safeParse(risk);

  return parsed.success &&
    risk.evaluatedAt === route.provenance.receivedAt &&
    risk.sourceDurationSeconds.min === route.durationSeconds.min &&
    risk.sourceDurationSeconds.max === route.durationSeconds.max
    ? risk.extraUpperSeconds
    : 0;
}

export function applyJourneyRisk(
  route: Route,
  prediction: JourneyRiskPrediction | null,
  evaluatedAt: number,
): Route {
  const { journeyEta: _old, ...source } = route;

  if (
    !prediction ||
    route.provenance.mode !== 'live' ||
    evaluatedAt !== route.provenance.receivedAt
  ) {
    return source;
  }

  const parsed = journeyRiskSchema.safeParse({
    ...prediction,
    target: 'navigation-start-to-confirmed-arrival',
    evaluatedAt,
    sourceDurationSeconds: {
      ...source.durationSeconds,
    },
    extraUpperSeconds: Math.max(0, Math.ceil(prediction.upperSeconds - source.durationSeconds.max)),
  });

  return parsed.success
    ? {
        ...source,
        journeyEta: parsed.data,
      }
    : source;
}
