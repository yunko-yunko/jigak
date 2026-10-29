import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  ETA_LEARNING_CONSENT_VERSION,
  etaLearningFeaturesSchema,
  type EtaLearningFeatures,
} from '../../../common/shared/intelligence/learning.js';
import {
  journeyFeaturesSchema,
  journeySubmissionSchema,
  type JourneyLearningFeatures,
} from '../../../common/shared/intelligence/journeyLearning.js';

export const DAY = 86_400_000;
const stamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const receiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    issuedAt: stamp,
    expiresAt: stamp,
    segments: z.array(etaLearningFeaturesSchema.nullable()).min(1).max(100),
    journey: z
      .object({
        features: journeyFeaturesSchema,
        pathGroup: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export const submissionSchema = z
  .object({
    ticket: z.string().min(40).max(100_000),
    consentVersion: z.enum(['eta-learning-v1', ETA_LEARNING_CONSENT_VERSION]),
    samples: z
      .array(
        z
          .object({
            segmentIndex: z.number().int().min(0).max(99),
            startedAt: stamp,
            endedAt: stamp,
            evidence: z.enum(['user-confirmed', 'sensor-confirmed']),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    journey: journeySubmissionSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.journey === undefined || value.consentVersion === ETA_LEARNING_CONSENT_VERSION,
    'whole-journey-requires-current-consent',
  );

export const deletionSchema = z.union([
  z
    .object({
      ticket: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      deletionToken: z.string().max(200),
    })
    .strict(),
]);

export const invalidLearning = () => new Error('학습 기록의 동의·서명·완료 시각을 확인해 주세요.');

export type Receipt = z.infer<typeof receiptSchema>;

export type Submission = z.infer<typeof submissionSchema>;

/** Shared Cloud SQL secret authenticates the server baseline across Cloud Run replicas. */
export class LearningReceipt {
  constructor(
    private readonly secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length !== 32) {
      throw invalidLearning();
    }
  }

  private mac(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private equal(a: string, b: string) {
    const x = Buffer.from(a),
      y = Buffer.from(b);

    return x.length === y.length && timingSafeEqual(x, y);
  }

  deletionToken(id: string) {
    return `${id}.${this.mac(`delete:${id}`)}`;
  }

  issueTicket(
    segments: readonly (EtaLearningFeatures | null)[],
    journey?: {
      features: JourneyLearningFeatures;
      pathIdentity: string;
    },
  ): string {
    const issuedAt = this.now();
    const pathGroup = journey
      ? createHmac('sha256', this.secret)
          .update(`journey-path:${journey.pathIdentity}`)
          .digest('hex')
      : undefined;
    const receipt = receiptSchema.parse({
      version: 1,
      id: randomUUID(),
      issuedAt,
      expiresAt: issuedAt + DAY,
      segments,
      ...(journey
        ? {
            journey: {
              features: journey.features,
              pathGroup,
            },
          }
        : {}),
    });

    if (
      journey &&
      (journey.features.modeSequence.length !== segments.length ||
        segments.some(
          (segment, index) => segment && segment.mode !== journey.features.modeSequence[index],
        ))
    ) {
      throw invalidLearning();
    }

    const encoded = Buffer.from(JSON.stringify(receipt)).toString('base64url');

    return `${encoded}.${this.mac(encoded)}`;
  }

  receipt(ticket: string): Receipt {
    if (typeof ticket !== 'string' || ticket.length > 100_000) {
      throw invalidLearning();
    }

    const pieces = ticket.split('.');

    if (pieces.length !== 2 || !this.equal(pieces[1], this.mac(pieces[0]))) {
      throw invalidLearning();
    }

    let decoded: unknown;

    try {
      decoded = JSON.parse(Buffer.from(pieces[0], 'base64url').toString());
    } catch {
      throw invalidLearning();
    }

    const parsed = receiptSchema.safeParse(decoded);

    if (!parsed.success) {
      throw invalidLearning();
    }

    return parsed.data;
  }

  deletionId(token: string): string {
    if (typeof token !== 'string' || token.length > 200) {
      throw invalidLearning();
    }

    const [id, mac, extra] = token.split('.');

    if (
      extra !== undefined ||
      !z.string().uuid().safeParse(id).success ||
      !mac ||
      !this.equal(mac, this.mac(`delete:${id}`))
    ) {
      throw invalidLearning();
    }

    return id;
  }

  validateSubmission(body: unknown) {
    const input = submissionSchema.safeParse(body);

    if (!input.success) {
      throw invalidLearning();
    }

    const receipt = this.receipt(input.data.ticket),
      now = this.now();

    if (
      receipt.issuedAt > now + 3000 ||
      receipt.expiresAt < now ||
      receipt.expiresAt - receipt.issuedAt !== DAY
    ) {
      throw invalidLearning();
    }

    const ordered = [...input.data.samples].sort((a, b) => a.segmentIndex - b.segmentIndex);
    let previousEnd = 0,
      previousIndex = -1;

    for (const sample of ordered) {
      if (
        sample.segmentIndex >= receipt.segments.length ||
        sample.segmentIndex === previousIndex ||
        sample.startedAt < receipt.issuedAt - 3000 ||
        sample.endedAt > now + 3000 ||
        sample.endedAt <= sample.startedAt ||
        sample.endedAt - sample.startedAt > 4 * 3600_000 ||
        sample.startedAt < previousEnd
      ) {
        throw invalidLearning();
      }

      previousEnd = sample.endedAt;
      previousIndex = sample.segmentIndex;
    }

    const whole = input.data.journey;

    if (
      whole &&
      (!receipt.journey ||
        ordered.length !== receipt.segments.length ||
        ordered.some((sample, index) => sample.segmentIndex !== index) ||
        whole.startedAt - receipt.issuedAt > 120_000 ||
        Math.abs(whole.startedAt - receipt.journey.features.startedAt) > 120_000 ||
        whole.startedAt < receipt.issuedAt - 3000 ||
        whole.startedAt > ordered[0].startedAt ||
        whole.endedAt !== ordered.at(-1)!.endedAt ||
        whole.endedAt > now + 3000 ||
        whole.endedAt <= whole.startedAt ||
        whole.endedAt - whole.startedAt > 4 * 3600_000 ||
        (whole.endedAt - whole.startedAt) / 1000 <
          Math.max(5, receipt.journey.features.predictedSeconds * 0.1) ||
        (whole.endedAt - whole.startedAt) / 1000 > receipt.journey.features.predictedSeconds * 8)
    ) {
      throw invalidLearning();
    }

    return {
      receipt,
      ordered,
      whole,
    };
  }
}
