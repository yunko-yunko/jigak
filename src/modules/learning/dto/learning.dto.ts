import type { EtaLearningSubmission } from '../../../common/shared/intelligence/learning.js';

/** Runtime validation uses strict versioned Zod schemas in the learning domain. */
export type SubmitLearningDto = Omit<EtaLearningSubmission, 'consentVersion'> & {
  consentVersion: 'eta-learning-v1' | 'eta-learning-v2';
};

export type DeleteLearningDto =
  | {
      ticket: string;
    }
  | {
      deletionToken: string;
    };
