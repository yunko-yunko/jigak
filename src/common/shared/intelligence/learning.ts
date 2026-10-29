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
  mode: SegmentMode;
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

/** Whole start-to-arrival timing requires fresh, explicit consent to the expanded scope. */
export const ETA_LEARNING_CONSENT_VERSION = 'eta-learning-v2' as const;

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
