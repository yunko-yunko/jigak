import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { In, LessThan, type EntityManager } from 'typeorm';
import { DatabaseService } from '../../../common/database/database.service.js';
import type {
  EtaLearningFeatures,
  EtaLearningObservation,
  EtaLearningSubmissionResult,
} from '../../../common/shared/intelligence/learning.js';
import type {
  JourneyLearningFeatures,
  JourneyLearningObservation,
} from '../../../common/shared/intelligence/journeyLearning.js';
import { DAY, LearningReceipt, invalidLearning } from '../domain/learning-receipt.js';
import {
  EtaErasedReceiptEntity,
  EtaJourneyEntity,
  EtaLearningStateEntity,
  EtaMetadataEntity,
  EtaModelEntity,
  EtaObservationEntity,
  type EtaLearningState,
} from './entities/index.js';

export interface LearningState extends EtaLearningState {
  contextual: unknown | null;
  journey: unknown | null;
}

@Injectable()
export class LearningRepository implements OnModuleInit {
  private receipts?: LearningReceipt;
  private initializing?: Promise<void>;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  onModuleInit() {
    return this.initialize();
  }

  initialize() {
    return (this.initializing ??= (async () => {
      const metadata = this.database.getRepository(EtaMetadataEntity);

      await metadata
        .createQueryBuilder()
        .insert()
        .values({
          name: 'receipt-secret',
          value: randomBytes(32).toString('hex'),
        })
        .orIgnore()
        .execute();

      await this.database
        .getRepository(EtaLearningStateEntity)
        .createQueryBuilder()
        .insert()
        .values({
          id: 1,
        })
        .orIgnore()
        .execute();

      const value = (await metadata.findOneBy({ name: 'receipt-secret' }))?.value;

      if (!value || !/^[a-f0-9]{64}$/.test(value)) {
        throw invalidLearning();
      }

      this.receipts = new LearningReceipt(Buffer.from(value, 'hex'));
    })());
  }

  private get receiptDomain() {
    if (!this.receipts) {
      throw new Error('learning-repository-not-initialized');
    }

    return this.receipts;
  }

  /** All acceptance, erasure and training share one lock, including across Cloud Run instances. */
  exclusive<T>(task: (client: EntityManager) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await this.database.lock(client, 'eta-learning');

      return task(client);
    });
  }

  issueTicket(
    segments: readonly (EtaLearningFeatures | null)[],
    journey?: {
      features: JourneyLearningFeatures;
      pathIdentity: string;
    },
  ) {
    return this.receiptDomain.issueTicket(segments, journey);
  }

  async submit(body: unknown): Promise<EtaLearningSubmissionResult> {
    const { receipt, ordered, whole } = this.receiptDomain.validateSubmission(body);

    return this.exclusive(async (client) => {
      await this.cleanup(client);

      if (await client.getRepository(EtaErasedReceiptEntity).existsBy({ id: receipt.id })) {
        throw invalidLearning();
      }

      const observations = client.getRepository(EtaObservationEntity);
      const journeys = client.getRepository(EtaJourneyEntity);
      const existing = (await observations.findBy({ tripId: receipt.id })).map(
        (row) => row.payload,
      );
      const oldJourney = (await journeys.findOneBy({ tripId: receipt.id }))?.payload;

      const timeline = [...existing];
      let accepted = 0,
        duplicates = 0,
        rejected = 0,
        journeyAccepted = 0,
        journeyDuplicates = 0;

      if (whole && oldJourney) {
        if (
          oldJourney.features.startedAt !== whole.startedAt ||
          oldJourney.observedAt !== whole.endedAt
        ) {
          throw invalidLearning();
        }

        journeyDuplicates = 1;
      }

      for (const sample of ordered) {
        const id = `${receipt.id}:${sample.segmentIndex}`,
          prior = existing.find((row) => row.id === id);

        if (prior) {
          if (
            prior.features.startedAt !== sample.startedAt ||
            prior.observedAt !== sample.endedAt ||
            prior.evidence !== sample.evidence
          ) {
            throw invalidLearning();
          }

          duplicates++;
          continue;
        }

        for (const recorded of timeline) {
          const index = Number(recorded.id.slice(receipt.id.length + 1));

          if (
            (index < sample.segmentIndex && recorded.observedAt > sample.startedAt) ||
            (index > sample.segmentIndex && sample.endedAt > recorded.features.startedAt)
          ) {
            throw invalidLearning();
          }
        }

        const snapshot = receipt.segments[sample.segmentIndex],
          actualSeconds = (sample.endedAt - sample.startedAt) / 1000;

        if (
          !snapshot ||
          actualSeconds < 5 ||
          actualSeconds > snapshot.predictedSeconds * 8 ||
          actualSeconds < snapshot.predictedSeconds * 0.1
        ) {
          rejected++;
          continue;
        }

        const contextIsOld =
          Math.abs(sample.startedAt - snapshot.startedAt) > 120_000 ||
          sample.startedAt - receipt.issuedAt > 120_000;
        const features: EtaLearningFeatures = {
          ...snapshot,
          startedAt: sample.startedAt,
          ...(contextIsOld
            ? {
                precipitationMm: null,
                temperatureC: null,
                windMetersPerSecond: null,
                congestionLevel: 'unknown' as const,
                roadDelaySeconds: 0,
              }
            : {}),
        };

        const row: EtaLearningObservation = {
          version: 1,
          id,
          tripId: receipt.id,
          source: 'recorded-trip',
          features,
          actualSeconds,
          observedAt: sample.endedAt,
          evidence: sample.evidence,
        };

        // The shared transaction lock makes the preceding duplicate check authoritative.
        await observations.insert({
          id: row.id,
          tripId: row.tripId,
          observedAt: row.observedAt,
          payload: row,
        });

        accepted++;
        timeline.push(row);
      }

      if (whole && !oldJourney && receipt.journey) {
        const snapshot = receipt.journey.features,
          contextIsOld =
            Math.abs(whole.startedAt - snapshot.startedAt) > 120_000 ||
            whole.startedAt - receipt.issuedAt > 120_000;

        const row: JourneyLearningObservation = {
          version: 1,
          id: `${receipt.id}:journey`,
          tripId: receipt.id,
          pathGroup: receipt.journey.pathGroup,
          source: 'recorded-journey',
          features: {
            ...snapshot,
            startedAt: whole.startedAt,
            ...(contextIsOld
              ? {
                  precipitationMm: null,
                  temperatureC: null,
                  windMetersPerSecond: null,
                  roadDelaySeconds: 0,
                }
              : {}),
          },
          actualSeconds: (whole.endedAt - whole.startedAt) / 1000,
          observedAt: whole.endedAt,
          evidence: 'user-confirmed',
        };

        await journeys.insert({
          id: row.id,
          tripId: row.tripId,
          observedAt: row.observedAt,
          payload: row,
        });

        journeyAccepted = 1;
      }

      return {
        accepted,
        duplicates,
        rejected,
        deletionToken: this.receiptDomain.deletionToken(receipt.id),
        ...(whole
          ? {
              journeyAccepted,
              journeyDuplicates,
            }
          : {}),
      };
    });
  }

  erase(token: string) {
    return this.eraseId(this.receiptDomain.deletionId(token));
  }

  eraseTicket(ticket: string) {
    return this.eraseId(this.receiptDomain.receipt(ticket).id);
  }

  private eraseId(id: string) {
    return this.exclusive(async (client) => {
      await client.getRepository(EtaErasedReceiptEntity).upsert(
        {
          id,
          expiresAt: Date.now() + DAY,
        },
        ['id'],
      );

      const observations = await client.getRepository(EtaObservationEntity).delete({ tripId: id });
      const journeys = await client.getRepository(EtaJourneyEntity).delete({ tripId: id });
      const deleted = (observations.affected ?? 0) + (journeys.affected ?? 0);

      if (deleted > 0) {
        await client.getRepository(EtaModelEntity).delete({ kind: In(['contextual', 'journey']) });
        await client.getRepository(EtaLearningStateEntity).update(1, {
          revision: () => 'revision + 1',
          last_attempt_trips: 0,
          last_attempt_journeys: 0,
          reasons: ['data-erased-retraining-required'],
          journey_reasons: ['data-erased-retraining-required'],
          shadow_leg_candidate: null,
        });
      }

      return deleted;
    });
  }

  async observations(client?: EntityManager): Promise<EtaLearningObservation[]> {
    await this.cleanup(client);

    return (
      await (client ?? this.database.manager).getRepository(EtaObservationEntity).find({
        select: { payload: true },
        order: { observedAt: 'ASC', id: 'ASC' },
        take: 50_000,
      })
    ).map((row) => row.payload);
  }

  async journeys(client?: EntityManager): Promise<JourneyLearningObservation[]> {
    await this.cleanup(client);

    return (
      await (client ?? this.database.manager).getRepository(EtaJourneyEntity).find({
        select: { payload: true },
        order: { observedAt: 'ASC', id: 'ASC' },
        take: 10_000,
      })
    ).map((row) => row.payload);
  }

  async counts(client?: EntityManager) {
    await this.cleanup(client);

    const row = await (client ?? this.database.manager)
      .getRepository(EtaObservationEntity)
      .createQueryBuilder('observation')
      .select('COUNT(*)', 'segments')
      .addSelect('COUNT(DISTINCT observation.tripId)', 'trips')
      .getRawOne<{ segments: string; trips: string }>();

    return {
      recordedSegments: Number(row?.segments ?? 0),
      recordedTrips: Number(row?.trips ?? 0),
    };
  }

  async journeyCounts(client?: EntityManager) {
    await this.cleanup(client);

    const row = await (client ?? this.database.manager)
      .getRepository(EtaJourneyEntity)
      .createQueryBuilder('journey')
      .select('COUNT(*)', 'journeys')
      .addSelect('COUNT(DISTINCT journey.tripId)', 'groups')
      .getRawOne<{ journeys: string; groups: string }>();

    return {
      recordedJourneys: Number(row?.journeys ?? 0),
      completeJourneyGroups: Number(row?.groups ?? 0),
    };
  }

  async trainingCoverage(client?: EntityManager) {
    await this.cleanup(client);

    const observations = (client ?? this.database.manager).getRepository(EtaObservationEntity);
    const mode = "observation.payload -> 'features' ->> 'mode'";
    const rows = await observations
      .createQueryBuilder('observation')
      .select(mode, 'mode')
      .addSelect('COUNT(*)', 'segments')
      .addSelect('COUNT(DISTINCT observation.tripId)', 'tripGroups')
      .groupBy(mode)
      .getRawMany<{
        mode: EtaLearningFeatures['mode'];
        segments: string;
        tripGroups: string;
      }>();

    const day = await observations
      .createQueryBuilder('observation')
      .select(
        `COUNT(DISTINCT to_char(to_timestamp((observation.payload -> 'features' ->> 'startedAt')::numeric / 1000)
          AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'))`,
        'days',
      )
      .getRawOne<{ days: string }>();

    return {
      byMode: Object.fromEntries(
        rows.map((row) => [
          row.mode,
          {
            segments: Number(row.segments),
            tripGroups: Number(row.tripGroups),
          },
        ]),
      ),
      serviceDays: Number(day?.days ?? 0),
    };
  }

  async state(client?: EntityManager): Promise<LearningState> {
    const manager = client ?? this.database.manager;
    const { entities, raw } = await manager
      .getRepository(EtaLearningStateEntity)
      .createQueryBuilder('state')
      .leftJoin(EtaModelEntity.options.name, 'contextual', 'contextual.kind = :contextualKind', {
        contextualKind: 'contextual',
      })
      .leftJoin(EtaModelEntity.options.name, 'journey', 'journey.kind = :journeyKind', {
        journeyKind: 'journey',
      })
      .addSelect('contextual.payload', 'contextual_payload')
      .addSelect('journey.payload', 'journey_payload')
      .where('state.id = :id', { id: 1 })
      .getRawAndEntities<{ contextual_payload: unknown; journey_payload: unknown }>();

    const state = entities[0];

    if (!state) {
      throw new Error('Learning state is not initialized.');
    }

    return {
      ...state,
      contextual: raw[0]?.contextual_payload ?? null,
      journey: raw[0]?.journey_payload ?? null,
    };
  }

  async modelRevision(): Promise<number> {
    const state = await this.database.getRepository(EtaLearningStateEntity).findOneOrFail({
      select: { revision: true },
      where: { id: 1 },
    });

    return state.revision;
  }

  async saveModel(kind: 'contextual' | 'journey', payload: unknown, client: EntityManager) {
    await client.getRepository(EtaModelEntity).save({
      kind,
      payload,
      updatedAt: Date.now(),
    });

    await client.getRepository(EtaLearningStateEntity).increment({ id: 1 }, 'revision', 1);
  }

  async updateTraining(
    kind: 'contextual' | 'journey',
    attempts: number,
    reasons: string[],
    shadow: LearningState['shadow_leg_candidate'],
    client: EntityManager,
  ) {
    if (kind === 'contextual') {
      await client.getRepository(EtaLearningStateEntity).update(1, {
        last_attempt_trips: attempts,
        reasons,
        shadow_leg_candidate: shadow,
        revision: () => 'revision + 1',
      });
    } else {
      await client.getRepository(EtaLearningStateEntity).update(1, {
        last_attempt_journeys: attempts,
        journey_reasons: reasons,
        revision: () => 'revision + 1',
      });
    }
  }

  async cleanup(client?: EntityManager) {
    const now = Date.now();
    const manager = client ?? this.database.manager;
    const observations = manager.getRepository(EtaObservationEntity);
    const journeys = manager.getRepository(EtaJourneyEntity);

    await manager.getRepository(EtaErasedReceiptEntity).delete({ expiresAt: LessThan(now) });
    await observations.delete({ observedAt: LessThan(now - 90 * DAY) });
    await journeys.delete({ observedAt: LessThan(now - 90 * DAY) });

    const excessObservations = observations
      .createQueryBuilder('observation')
      .select('observation.id')
      .orderBy('observation.observedAt', 'DESC')
      .addOrderBy('observation.id', 'DESC')
      .offset(50_000);

    await observations
      .createQueryBuilder()
      .delete()
      .where(`id IN (${excessObservations.getQuery()})`)
      .execute();

    const excessJourneys = journeys
      .createQueryBuilder('journey')
      .select('journey.id')
      .orderBy('journey.observedAt', 'DESC')
      .addOrderBy('journey.id', 'DESC')
      .offset(10_000);

    await journeys
      .createQueryBuilder()
      .delete()
      .where(`id IN (${excessJourneys.getQuery()})`)
      .execute();
  }
}
