import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { EtaLearningFeatures } from '../../../common/shared/intelligence/learning.js';
import {
  isIndependentJourneyReferenceProfile,
  journeyFeaturesSchema,
  type JourneyLearningFeatures,
} from '../../../common/shared/intelligence/journeyLearning.js';
import {
  CONTEXTUAL_MODEL_MAX_AGE_MS,
  parseContextualEtaModel,
  prepareContextualEtaPredictor,
  usableContextualEtaModel,
  type ContextualEtaModel,
} from '../../../common/engine/intelligence/contextual-model.js';
import { trainContextualEta } from '../../../common/engine/intelligence/contextual-training.js';
import {
  parseJourneyEtaModel,
  prepareJourneyEtaPredictor,
  trainJourneyEta,
  type JourneyEtaModel,
} from '../../../common/engine/intelligence/journey-model.js';
import { deletionSchema } from '../domain/learning-receipt.js';
import { LearningRepository } from '../repository/learning.repository.js';

@Injectable()
export class LearningService implements OnModuleInit {
  private model?: ContextualEtaModel;
  private contextualPredictor: ReturnType<typeof prepareContextualEtaPredictor> = null;
  private journeyModel?: JourneyEtaModel;
  private journeyPredictor: ReturnType<typeof prepareJourneyEtaPredictor> = null;
  private reasons = ['insufficient-independent-trips'];
  private journeyReasons = ['insufficient-independent-journeys'];
  private lastSeenJourneyProfile?: string;
  private revision = -1;
  private shadowLegCandidate?: {
    trainedAt: number;
    sampleCount: number;
    validatedModes: string[];
  };

  constructor(@Inject(LearningRepository) readonly store: LearningRepository) {}

  async onModuleInit() {
    await this.store.initialize();
    await this.refresh();
  }

  close() {
    /* The shared DatabaseService owns the TypeORM DataSource. */
  }

  /** Check a small shared revision before each search; only fetch checkpoints when it changes. */
  async refresh() {
    if ((await this.store.modelRevision()) <= this.revision) {
      return;
    }

    const state = await this.store.state();

    if (Number(state.revision) <= this.revision) {
      return;
    }

    this.revision = Number(state.revision);
    this.reasons = [...state.reasons];
    this.journeyReasons = [...state.journey_reasons];
    this.shadowLegCandidate = state.shadow_leg_candidate ?? undefined;
    this.model = undefined;
    this.contextualPredictor = null;
    this.journeyModel = undefined;
    this.journeyPredictor = null;

    if (state.contextual) {
      try {
        this.model = parseContextualEtaModel(JSON.stringify(state.contextual), Date.now());
        this.contextualPredictor = prepareContextualEtaPredictor(this.model, Date.now());
      } catch {
        this.reasons = ['invalid-or-expired-model'];
      }
    }

    if (state.journey) {
      try {
        this.journeyModel = parseJourneyEtaModel(JSON.stringify(state.journey), Date.now());
        this.journeyPredictor = prepareJourneyEtaPredictor(this.journeyModel, Date.now());
      } catch {
        this.journeyReasons = ['invalid-or-expired-model'];
      }
    }
  }

  predict(features: EtaLearningFeatures) {
    return this.contextualPredictor?.(features, Date.now()) ?? null;
  }

  predictJourney(features: JourneyLearningFeatures) {
    if (journeyFeaturesSchema.safeParse(features).success) {
      this.lastSeenJourneyProfile = features.legModelProfile;
    }

    return this.journeyPredictor?.(features, Date.now()) ?? null;
  }

  private async currentCohort(explicitProfile?: string, client?: EntityManager) {
    const rows = await this.store.journeys(client),
      groups = rows.length;
    const profile =
      explicitProfile ?? this.lastSeenJourneyProfile ?? rows.at(-1)?.features.legModelProfile;

    return {
      groups,
      profile,
      selected: profile ? rows.filter((row) => row.features.legModelProfile === profile).length : 0,
      referenceIndependent:
        rows.length > 0 &&
        rows.every(
          (row) =>
            journeyFeaturesSchema.safeParse(row.features).success &&
            isIndependentJourneyReferenceProfile(row.features.legModelProfile),
        ),
    };
  }

  private async journeyStatus() {
    let active = false;

    const cohort = await this.currentCohort(),
      profileMatches =
        !this.journeyModel ||
        !cohort.profile ||
        this.journeyModel.legModelProfile === cohort.profile;

    if (this.journeyModel) {
      try {
        parseJourneyEtaModel(JSON.stringify(this.journeyModel), Date.now());
        active = profileMatches;
      } catch {
        this.journeyModel = undefined;
        this.journeyPredictor = null;
        this.journeyReasons = ['invalid-or-expired-model'];
      }
    }

    return {
      labelSource: 'recorded-journey' as const,
      ...(await this.store.journeyCounts()),
      rankingEvidence: 'observed-selected-journey-only' as const,
      cohortPolicy: {
        policy: 'stable-leg-baseline-during-whole-collection' as const,
        segmentPromotion:
          cohort.groups && !cohort.referenceIndependent
            ? ('shadow-only' as const)
            : ('validated-auto' as const),
        reason: cohort.referenceIndependent
          ? 'source-reference-independent-of-leg-generation'
          : cohort.groups
            ? 'whole-journey-cohort-preserves-baseline-generation'
            : null,
        referenceIndependent: cohort.referenceIndependent,
        currentProfileKnown: !!cohort.profile,
        currentProfileJourneys: cohort.selected,
        excludedOtherProfiles: cohort.groups - cohort.selected,
        profileMatchesOperationalModel: this.journeyModel ? profileMatches : null,
        activeLegExpiresAt:
          this.model && usableContextualEtaModel(this.model, Date.now())
            ? this.model.trainedAt + CONTEXTUAL_MODEL_MAX_AGE_MS
            : null,
        expiryExtended: false as const,
        automaticBaselineRebase: false as const,
        shadowLegCandidate: this.shadowLegCandidate
          ? {
              ...this.shadowLegCandidate,
              saved: false as const,
            }
          : null,
      },
      requiredCoverage: {
        independentJourneys: 50,
        trainPerCombination: 30,
        calibrationPerCombination: 10,
        testPerCombination: 10,
        serviceDays: {
          train: 7,
          calibration: 2,
          test: 2,
        },
        unseenPathTestPerCombination: 10,
        intervalCoverage: 0.8,
        upperCoverage: 0.9,
        maximumRelativeWidth: 1.5,
        thresholdsGuaranteeActivation: false,
      },
      model: {
        version: 'eta-journey-v1' as const,
        active,
        trainedAt: active ? this.journeyModel!.trainedAt : null,
        sampleCount: active
          ? Object.values(this.journeyModel!.splits).reduce(
              (sum, split) => sum + split.observations,
              0,
            )
          : 0,
        reasons: active
          ? []
          : !profileMatches
            ? ['baseline-profile-mismatch']
            : [...this.journeyReasons],
        activeCombinations: active ? Object.keys(this.journeyModel!.combinations) : [],
        ...(active
          ? {
              evaluations: Object.fromEntries(
                Object.entries(this.journeyModel!.combinations).map(([combination, scope]) => [
                  combination,
                  {
                    all: scope.evaluation,
                    unseenPaths: scope.unseenPaths,
                  },
                ]),
              ),
            }
          : {}),
      },
    };
  }

  async status() {
    await this.refresh();

    const active = !!this.model && usableContextualEtaModel(this.model, Date.now());

    return {
      collectionAvailable: true,
      ...(await this.store.counts()),
      retentionDays: 90,
      journey: await this.journeyStatus(),
      trainingReadiness: {
        labelSource: 'recorded-trip' as const,
        requiredGroups: {
          total: 50,
          trainPerMode: 30,
          calibrationPerMode: 10,
          testPerMode: 10,
        },
        ...(await this.store.trainingCoverage()),
        thresholdsGuaranteeActivation: false,
        grouping: 'server-issued-trip-receipt' as const,
        activeModes: active ? Object.keys(this.model!.modes) : [],
      },
      model: {
        version: 'eta-context-v2' as const,
        active,
        trainedAt: active ? this.model!.trainedAt : null,
        sampleCount: active
          ? Object.values(this.model!.splits).reduce((sum, split) => sum + split.observations, 0)
          : 0,
        reasons: active
          ? []
          : [...new Set([...(this.model ? ['invalid-or-expired-model'] : []), ...this.reasons])],
        ...(active
          ? {
              evaluation: Object.fromEntries(
                Object.entries(this.model!.modes).map(([mode, data]) => [mode, data.evaluation]),
              ),
            }
          : {}),
      },
    };
  }

  async retrain(onlyIfReady = false) {
    const result = await this.store.exclusive(async (client) => {
      const counts = await this.store.counts(client),
        state = await this.store.state(client);

      if (
        onlyIfReady &&
        (counts.recordedTrips < 50 || counts.recordedTrips < state.last_attempt_trips + 10)
      ) {
        return undefined;
      }

      const report = trainContextualEta(await this.store.observations(client), Date.now());

      if (!report.model) {
        await this.store.updateTraining(
          'contextual',
          counts.recordedTrips,
          report.reasons,
          state.shadow_leg_candidate,
          client,
        );

        return {
          ...report,
          deployment: 'not-trained' as const,
          activated: false,
        };
      }

      const verified = parseContextualEtaModel(JSON.stringify(report.model), Date.now()),
        cohort = await this.currentCohort(undefined, client);

      if (cohort.groups > 0 && !cohort.referenceIndependent) {
        const candidate = {
          trainedAt: verified.trainedAt,
          sampleCount: Object.values(verified.splits).reduce(
            (sum, split) => sum + split.observations,
            0,
          ),
          validatedModes: Object.keys(verified.modes),
        };

        await this.store.updateTraining(
          'contextual',
          counts.recordedTrips,
          ['whole-journey-cohort-baseline-held'],
          candidate,
          client,
        );

        return {
          ...report,
          deployment: 'shadow' as const,
          activated: false,
        };
      }

      await this.store.saveModel('contextual', verified, client);
      await this.store.updateTraining('contextual', counts.recordedTrips, [], null, client);

      return {
        ...report,
        deployment: 'active' as const,
        activated: true,
      };
    });

    await this.refresh();

    return result;
  }

  async retrainJourney(currentProfile?: string, onlyIfReady = false) {
    if (currentProfile !== undefined) {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(currentProfile)) {
        throw new Error('invalid-baseline-profile');
      }

      this.lastSeenJourneyProfile = currentProfile;
    }

    const result = await this.store.exclusive(async (client) => {
      const counts = await this.store.journeyCounts(client),
        state = await this.store.state(client);

      if (
        onlyIfReady &&
        (counts.completeJourneyGroups < 50 ||
          counts.completeJourneyGroups < state.last_attempt_journeys + 10)
      ) {
        return undefined;
      }

      const rows = await this.store.journeys(client),
        profile =
          currentProfile ?? this.lastSeenJourneyProfile ?? rows.at(-1)?.features.legModelProfile;
      const selected = profile
        ? rows.filter((row) => row.features.legModelProfile === profile)
        : [];

      const report = {
        ...trainJourneyEta(selected, Date.now()),
        cohort: {
          selected: selected.length,
          excludedOtherProfiles: rows.length - selected.length,
          profileKnown: !!profile,
        },
      };

      if (!report.model) {
        await this.store.updateTraining(
          'journey',
          counts.completeJourneyGroups,
          report.reasons,
          null,
          client,
        );

        return report;
      }

      await this.store.saveModel(
        'journey',
        parseJourneyEtaModel(JSON.stringify(report.model), Date.now()),
        client,
      );
      await this.store.updateTraining('journey', counts.completeJourneyGroups, [], null, client);

      return report;
    });

    await this.refresh();

    return result;
  }

  async submit(body: unknown) {
    const result = await this.store.submit(body);

    // Failed training must never change a successfully accepted journey submission.
    if (result.accepted) {
      try {
        await this.retrain(true);
      } catch {
        this.reasons = ['training-failed'];
      }
    }

    if (result.journeyAccepted) {
      try {
        await this.retrainJourney(undefined, true);
      } catch {
        this.journeyReasons = ['training-failed'];
      }
    }

    return result;
  }

  async erase(body: unknown) {
    const parsed = deletionSchema.safeParse(body);

    if (!parsed.success) {
      throw new Error('invalid-deletion-capability');
    }

    const deleted =
      'ticket' in parsed.data
        ? await this.store.eraseTicket(parsed.data.ticket)
        : await this.store.erase(parsed.data.deletionToken);

    if (deleted > 0) {
      this.lastSeenJourneyProfile = undefined;
    }

    await this.refresh();

    return {
      deleted,
      modelInvalidated: deleted > 0,
    };
  }
}
