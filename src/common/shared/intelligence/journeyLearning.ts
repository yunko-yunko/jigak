import { z } from 'zod';

export const JOURNEY_MODES = [
  'walk',
  'run',
  'entry',
  'wait',
  'bus',
  'subway',
  'hire',
  'bicycle',
  'return',
  'taxi',
  'car',
  'scooter',
] as const;

const stamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().finite().nonnegative().max(86_400);

const modeSecondsSchema = z
  .object({
    walk: seconds,
    run: seconds,
    entry: seconds,
    wait: seconds,
    bus: seconds,
    subway: seconds,
    hire: seconds,
    bicycle: seconds,
    return: seconds,
    taxi: seconds,
    car: seconds,
    scooter: seconds,
  })
  .strict();

const publishedLegSchema = z
  .object({
    segmentIndex: z.number().int().min(1).max(99),
    receivedAt: stamp,
    departureAt: stamp,
    latestDepartureAt: stamp,
    arrivalAt: stamp,
    latestArrivalAt: stamp,
  })
  .strict();

/** Query-time plans are audit evidence, never completed-trip labels or direct model inputs. */
const planningEvidenceSchema = z
  .object({
    version: z.literal(2),
    basis: z.literal('published-schedule-source-reference'),
    queriedAt: stamp,
    publishedLegs: z.array(publishedLegSchema).min(1).max(50),
  })
  .strict();

export function isIndependentJourneyReferenceProfile(profile: string): boolean {
  return /^journey-source-reference-v[12]:[a-f0-9]{64}$/.test(profile);
}

/** A server-signed snapshot of the delivered timeline. No location or identity is a feature. */
export const journeyFeaturesSchema = z
  .object({
    version: z.literal(1),
    startedAt: stamp,
    predictedSeconds: seconds.positive(),
    distanceMeters: z.number().finite().min(0).max(500_000),
    modeSeconds: modeSecondsSchema,
    modeSequence: z.array(z.enum(JOURNEY_MODES)).min(1).max(100),
    transfers: z.number().int().min(0).max(99),
    vehicleLegs: z.number().int().min(0).max(100),
    precipitationMm: z.number().finite().min(0).max(300).nullable(),
    temperatureC: z.number().finite().min(-50).max(60).nullable(),
    windMetersPerSecond: z.number().finite().min(0).max(75).nullable(),
    roadDelaySeconds: seconds,
    legModelProfile: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/),
    planningEvidence: planningEvidenceSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Math.abs(
        Object.values(value.modeSeconds).reduce((sum, part) => sum + part, 0) -
          value.predictedSeconds,
      ) <= Math.max(0.000001, Math.min(2, value.predictedSeconds * 0.001)),
    'The whole timeline and its mode composition must describe the same baseline.',
  )
  .superRefine((value, ctx) => {
    const evidence = value.planningEvidence,
      version2 = /^journey-source-reference-v2:[a-f0-9]{64}$/.test(value.legModelProfile);

    if (
      version2 !== !!evidence ||
      (evidence &&
        (Math.abs(evidence.queriedAt - value.startedAt) > 120_000 ||
          evidence.publishedLegs.some(
            (leg, index, legs) =>
              value.modeSequence[leg.segmentIndex] !== 'subway' ||
              value.modeSequence[leg.segmentIndex - 1] !== 'wait' ||
              (index > 0 && leg.segmentIndex <= legs[index - 1].segmentIndex) ||
              leg.receivedAt > evidence.queriedAt + 3000 ||
              evidence.queriedAt - leg.receivedAt > 6 * 3_600_000 ||
              leg.departureAt < evidence.queriedAt ||
              leg.latestDepartureAt < leg.departureAt ||
              leg.arrivalAt <= leg.departureAt ||
              leg.latestArrivalAt <= leg.latestDepartureAt ||
              leg.latestArrivalAt < leg.arrivalAt,
          )))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Versioned published plans must remain distinct from completed journey evidence.',
      });
    }
  });

export type JourneyLearningFeatures = z.infer<typeof journeyFeaturesSchema>;

/** Stages guidance may pass without seeing their end: outdoor foot stages and the gate passages of a station. */
const PASSABLE_MODES: readonly string[] = ['walk', 'run', 'entry'];
/**
 * A whole journey may leave a stage unlabelled only when guidance passed it without seeing its end, or when such a pass
 * moved the rider into it (its start was not seen either). Every other stage carries its label.
 */
export function journeyLabelsCoverRoute(
  modeSequence: readonly string[],
  labelled: ReadonlySet<number>,
): boolean {
  return modeSequence.every(
    (mode, index) =>
      labelled.has(index) ||
      PASSABLE_MODES.includes(mode) ||
      (index > 0 && !labelled.has(index - 1) && PASSABLE_MODES.includes(modeSequence[index - 1])),
  );
}

/** Elapsed start-to-final-confirmation includes every wait and transition, including uncategorized gaps. */
export const journeySubmissionSchema = z
  .object({
    startedAt: stamp,
    endedAt: stamp,
    evidence: z.literal('user-confirmed'),
  })
  .strict();

export type JourneyCapturedSample = z.infer<typeof journeySubmissionSchema>;

export const journeyObservationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1).max(128),
    tripId: z.string().min(1).max(128),
    pathGroup: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.literal('recorded-journey'),
    features: journeyFeaturesSchema,
    actualSeconds: seconds.positive(),
    observedAt: stamp,
    evidence: z.literal('user-confirmed'),
  })
  .strict();

export type JourneyLearningObservation = z.infer<typeof journeyObservationSchema>;
