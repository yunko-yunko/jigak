import type { SegmentMode } from '../domain/types.js';
import { z } from 'zod';

export const etaLearningFeaturesSchema = z
  .object({
    mode: z.enum([
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
    ]),
    predictedSeconds: z.number().finite().positive().max(86_400),
    distanceMeters: z.number().finite().nonnegative().max(500_000),
    startedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    precipitationMm: z.number().finite().min(0).max(1000).nullable(),
    temperatureC: z.number().finite().min(-80).max(70).nullable(),
    windMetersPerSecond: z.number().finite().min(0).max(150).nullable(),
    congestionLevel: z.enum(['unknown', 'free', 'slow', 'delay', 'jam']),
    roadDelaySeconds: z.number().finite().nonnegative().max(86_400),
    precedingWaitSeconds: z.number().finite().nonnegative().max(86_400),
    transferIndex: z.number().int().min(0).max(100),
    liveWait: z.boolean(),
  })
  .strict();

/** No coordinates, place names, account identifiers or raw sensor streams. */
export interface EtaLearningFeatures {
  /** E-bike legs have no learned model: the trained mode enums stay as they were, so no feature exists for them. */
  mode: Exclude<SegmentMode, 'ebike'>;
  predictedSeconds: number;
  distanceMeters: number;
  startedAt: number;
  precipitationMm: number | null;
  temperatureC: number | null;
  windMetersPerSecond: number | null;
  congestionLevel: 'unknown' | 'free' | 'slow' | 'delay' | 'jam';
  roadDelaySeconds: number;
  precedingWaitSeconds: number;
  transferIndex: number;
  liveWait: boolean;
}

export interface EtaLearningObservation {
  version: 1;
  id: string;
  tripId: string;
  source: 'recorded-trip' | 'observed-arrival';
  features: EtaLearningFeatures;
  actualSeconds: number;
  observedAt: number;
  evidence: 'user-confirmed' | 'sensor-confirmed' | 'provider-arrival';
}

/**
 * Each widening of what is recorded needs fresh, explicit opt-in under its own text: v2 added whole start-to-arrival
 * timing, v3 stage times the device judged (a tap only where the rider moved on by hand).
 */
export const ETA_LEARNING_CONSENT_VERSION = 'eta-learning-v3' as const;

/** Opt-ins given under an older text. A submission under one is refused whole, never relabelled as current. */
export const OUTDATED_ETA_LEARNING_CONSENT_VERSIONS = ['eta-learning-v1', 'eta-learning-v2'] as const;

export const hasOutdatedEtaLearningConsent = (body: unknown): boolean =>
  !!body &&
  typeof body === 'object' &&
  (OUTDATED_ETA_LEARNING_CONSENT_VERSIONS as readonly unknown[]).includes(
    (body as { consentVersion?: unknown }).consentVersion,
  );

export interface EtaCapturedSample {
  segmentIndex: number;
  startedAt: number;
  endedAt: number;
  evidence: 'user-confirmed' | 'sensor-confirmed';
}

export interface EtaLearningSubmission {
  ticket: string;
  consentVersion: typeof ETA_LEARNING_CONSENT_VERSION;
  samples: EtaCapturedSample[];
  journey?: import('./journeyLearning.js').JourneyCapturedSample;
}

export interface EtaLearningSubmissionResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  deletionToken: string;
  journeyAccepted?: number;
  journeyDuplicates?: number;
}
