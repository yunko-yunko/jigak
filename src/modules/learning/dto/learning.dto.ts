import type {
  EtaLearningSubmission,
  OUTDATED_ETA_LEARNING_CONSENT_VERSIONS,
} from '../../../common/shared/intelligence/learning.js';

/** Runtime validation uses strict versioned Zod schemas in the learning domain. */
export type SubmitLearningDto = Omit<EtaLearningSubmission, 'consentVersion'> & {
  /** Older versions arrive from old app builds and are refused with CONSENT_REQUIRED. */
  consentVersion: EtaLearningSubmission['consentVersion'] | (typeof OUTDATED_ETA_LEARNING_CONSENT_VERSIONS)[number];
};

export type DeleteLearningDto =
  | {
      ticket: string;
    }
  | {
      deletionToken: string;
    };
