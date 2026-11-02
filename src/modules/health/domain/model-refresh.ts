import type {
  ModelKey,
  ModelRefreshSummary,
} from '../../../common/engine/intelligence/model-manifest.js';
import type { RoutingOptions } from '../../routing/domain/routing-options.js';

interface Life {
  expiresAt: number | null;
  active: boolean;
}
const life = (status: unknown): Life | undefined => {
  const value = status as { expiresAt?: unknown; active?: unknown } | undefined;
  if (!value || typeof value !== 'object') return undefined;
  return {
    expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : null,
    active: value.active === true,
  };
};

/** Statuses of the models the refresh job keeps alive, as the services report them. */
export function servedModelStatuses(options: RoutingOptions) {
  const bus = options.publicBus?.status() as
    (Record<string, unknown> & { spatial?: unknown }) | undefined;
  return {
    publicBus: bus,
    spatialBus: bus?.spatial,
    railGate: options.railGate?.status(),
    bicycleRide: options.mobility?.bikeModel?.status(),
  };
}

/** Health summary of the refresh job; "unconfigured" when no manifest is followed. */
export function modelRefreshSummary(options: RoutingOptions): ModelRefreshSummary {
  const served = servedModelStatuses(options);
  const lives: Partial<Record<ModelKey, Life>> = {};
  for (const key of ['publicBus', 'spatialBus', 'railGate', 'bicycleRide'] as const) {
    const value = life(served[key]);
    if (value) lives[key] = value;
  }
  return (
    options.modelRefresh?.summarize(lives) ?? {
      status: 'unconfigured',
      reasons: ['model-manifest-not-configured'],
      manifest: { generation: null, updatedAt: null, runId: null, error: null },
      lastRun: null,
      nextScheduledAt: null,
      models: {},
      calendars: {},
    }
  );
}
