import { EntitySchema } from 'typeorm';
import { bigintNumberTransformer } from '../../../../common/database/transformers.js';
import type { EtaLearningObservation } from '../../../../common/shared/intelligence/learning.js';
import type { JourneyLearningObservation } from '../../../../common/shared/intelligence/journeyLearning.js';

export interface EtaMetadata {
  name: string;
  value: string;
}

export interface EtaObservation {
  id: string;
  tripId: string;
  observedAt: number;
  payload: EtaLearningObservation;
}

export interface EtaJourney {
  id: string;
  tripId: string;
  observedAt: number;
  payload: JourneyLearningObservation;
}

export interface EtaErasedReceipt {
  id: string;
  expiresAt: number;
}

export interface EtaLearningState {
  id: number;
  revision: number;
  last_attempt_trips: number;
  last_attempt_journeys: number;
  reasons: string[];
  journey_reasons: string[];
  shadow_leg_candidate: {
    trainedAt: number;
    sampleCount: number;
    validatedModes: string[];
  } | null;
}

export interface EtaModel {
  kind: string;
  payload: unknown;
  updatedAt: number;
}

export const EtaMetadataEntity = new EntitySchema<EtaMetadata>({
  name: 'EtaMetadata',
  tableName: 'eta_metadata',
  columns: {
    name: {
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'eta_metadata_pkey',
    },
    value: {
      type: 'text',
    },
  },
});

export const EtaObservationEntity = new EntitySchema<EtaObservation>({
  name: 'EtaObservation',
  tableName: 'eta_observations',
  columns: {
    id: {
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'eta_observations_pkey',
    },
    tripId: {
      name: 'trip_id',
      type: 'uuid',
    },
    observedAt: {
      name: 'observed_at',
      type: 'bigint',
      transformer: bigintNumberTransformer,
    },
    payload: {
      type: 'jsonb',
    },
  },
  indices: [
    {
      name: 'eta_observations_time',
      columns: ['observedAt'],
    },
    {
      name: 'eta_observations_trip',
      columns: ['tripId'],
    },
  ],
});

export const EtaJourneyEntity = new EntitySchema<EtaJourney>({
  name: 'EtaJourney',
  tableName: 'eta_journeys',
  columns: {
    id: {
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'eta_journeys_pkey',
    },
    tripId: {
      name: 'trip_id',
      type: 'uuid',
    },
    observedAt: {
      name: 'observed_at',
      type: 'bigint',
      transformer: bigintNumberTransformer,
    },
    payload: {
      type: 'jsonb',
    },
  },
  uniques: [
    {
      name: 'eta_journeys_trip_id_key',
      columns: ['tripId'],
    },
  ],
  indices: [
    {
      name: 'eta_journeys_time',
      columns: ['observedAt'],
    },
  ],
});

export const EtaErasedReceiptEntity = new EntitySchema<EtaErasedReceipt>({
  name: 'EtaErasedReceipt',
  tableName: 'eta_erased_receipts',
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      primaryKeyConstraintName: 'eta_erased_receipts_pkey',
    },
    expiresAt: {
      name: 'expires_at',
      type: 'bigint',
      transformer: bigintNumberTransformer,
    },
  },
});

export const EtaLearningStateEntity = new EntitySchema<EtaLearningState>({
  name: 'EtaLearningState',
  tableName: 'eta_learning_state',
  columns: {
    id: {
      type: 'integer',
      primary: true,
      primaryKeyConstraintName: 'eta_learning_state_pkey',
    },
    revision: {
      type: 'bigint',
      default: 0,
      transformer: bigintNumberTransformer,
    },
    last_attempt_trips: {
      type: 'integer',
      default: 0,
    },
    last_attempt_journeys: {
      type: 'integer',
      default: 0,
    },
    reasons: {
      type: 'jsonb',
      default: () => `'["insufficient-independent-trips"]'::jsonb`,
    },
    journey_reasons: {
      type: 'jsonb',
      default: () => `'["insufficient-independent-journeys"]'::jsonb`,
    },
    shadow_leg_candidate: {
      type: 'jsonb',
      nullable: true,
    },
  },
  checks: [
    {
      name: 'eta_learning_state_id_check',
      expression: 'id = 1',
    },
  ],
});

export const EtaModelEntity = new EntitySchema<EtaModel>({
  name: 'EtaModel',
  tableName: 'eta_models',
  columns: {
    kind: {
      type: 'text',
      primary: true,
      primaryKeyConstraintName: 'eta_models_pkey',
    },
    payload: {
      type: 'jsonb',
    },
    updatedAt: {
      name: 'updated_at',
      type: 'bigint',
      transformer: bigintNumberTransformer,
    },
  },
});

export const learningEntities = [
  EtaMetadataEntity,
  EtaObservationEntity,
  EtaJourneyEntity,
  EtaErasedReceiptEntity,
  EtaLearningStateEntity,
  EtaModelEntity,
];
