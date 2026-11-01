import type { BaseSegment } from '../../shared/domain/types.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import {
  parseSpatialBusCheckpoint,
  predictSpatialBusEnvelope,
  SPATIAL_BUS_V3,
  type SpatialBusCheckpoint,
} from './spatial-bus-model.js';
import type { PublicBusEstimate, PublicBusRuntime } from './public-bus-timing.js';
import {
  candidateReasons,
  ModelFileLoader,
  provenanceFields,
  type LoadedModel,
  type ModelPathSource,
} from './model-manifest.js';

/** Reads the served spatial bus checkpoint; a bus leg needs Kakao's stop list for the stop count. */
export class SpatialBusModelService {
  private model?: SpatialBusCheckpoint;
  private reason = 'missing-checkpoint';
  private checkedAt = 0;
  private loaded: LoadedModel<SpatialBusCheckpoint> = {
    reason: 'missing-checkpoint',
    provenance: null,
    candidate: null,
  };
  private readonly loader: ModelFileLoader<SpatialBusCheckpoint>;
  private counters = {
    attempts: 0,
    applied: 0,
    inactive: 0,
    missingStops: 0,
    unsupportedContext: 0,
  };
  private readonly now: () => number;
  constructor(private readonly options: { modelPath: ModelPathSource; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.loader = new ModelFileLoader({
      source: options.modelPath,
      maxBytes: 32 * 1024 * 1024,
      parse: (text) => parseSpatialBusCheckpoint(text),
    });
    this.reload();
  }
  private reload() {
    const now = this.now();
    if (
      this.checkedAt &&
      now - this.checkedAt >= 0 &&
      now - this.checkedAt < 30_000 &&
      !this.loader.pending()
    )
      return;
    this.checkedAt = now;
    this.loaded = this.loader.read(now);
    this.model = this.loaded.model;
    this.reason = this.loaded.reason;
  }
  predictSegment(
    segment: BaseSegment,
    startedAt: number,
    requestNow: number,
  ): PublicBusEstimate | null {
    this.reload();
    if (segment.mode !== 'bus') return null;
    this.counters.attempts++;
    if (!this.model || requestNow < this.model.trainedAt || requestNow >= this.model.expiresAt) {
      this.counters.inactive++;
      return null;
    }
    const stops = segment.transit?.stops;
    if (!stops || stops.length < 2) {
      this.counters.missingStops++;
      return null;
    }
    const estimate = predictSpatialBusEnvelope(this.model, {
      startedAt: Math.ceil(startedAt),
      distanceMeters: segment.distanceMeters,
      stopCount: stops.length - 1,
      originLatitude: segment.start.latitude,
      originLongitude: segment.start.longitude,
      destinationLatitude: segment.end.latitude,
      destinationLongitude: segment.end.longitude,
    });
    if (!estimate) {
      this.counters.unsupportedContext++;
      return null;
    }
    this.counters.applied++;
    const medianSeconds = Math.min(
      estimate.upperSeconds,
      Math.max(estimate.lowerSeconds, estimate.medianSeconds),
    );
    return {
      modelVersion: SPATIAL_BUS_V3,
      target: 'bus-tag-elapsed',
      lowerSeconds: estimate.lowerSeconds,
      medianSeconds,
      upperSeconds: estimate.upperSeconds,
    };
  }
  status() {
    this.reload();
    const now = this.now(),
      active = !!this.model && this.model.trainedAt <= now && this.model.expiresAt > now;
    return {
      version: SPATIAL_BUS_V3,
      target: 'bus-tag-elapsed',
      active,
      usage: 'conservative-bus-envelope',
      dayRule: this.model ? this.model.calendar.rule : null,
      trainedAt: this.model?.trainedAt ?? null,
      expiresAt: this.model?.expiresAt ?? null,
      ...provenanceFields(this.loaded),
      operations: {
        remainingSeconds: this.model
          ? Math.max(0, Math.floor((this.model.expiresAt - now) / 1000))
          : null,
        refreshDue: !active || this.model!.expiresAt - now <= 48 * 3_600_000,
        lastEvaluatedServiceDate: this.model?.lastEvaluatedServiceDate ?? null,
        counters: { ...this.counters },
        fallback: 'public-bus-model-then-provider-duration',
      },
      reasons: [
        ...(active
          ? []
          : [
              this.model && this.model.expiresAt <= now
                ? 'expired-checkpoint'
                : this.reason || 'inactive-checkpoint',
            ]),
        ...candidateReasons(this.loaded),
      ],
      ...(active
        ? {
            evaluation: this.model!.evaluation,
            holidays: this.model!.calendar.holidays,
            source: this.model!.source,
          }
        : {}),
      limitations: this.model?.limitations ?? [],
    };
  }
}

/** Spatial model first (stop count, stops' positions, day part); the citywide public bus model covers the rest. */
export class BusEnvelopeRuntime implements PublicBusRuntime {
  constructor(
    private readonly spatial: SpatialBusModelService | undefined,
    private readonly publicBus: PublicBusRuntime | undefined,
  ) {}
  predictSegment(
    segment: BaseSegment,
    startedAt: number,
    requestNow: number,
    weather: WeatherSnapshot | null,
  ): PublicBusEstimate | null {
    return (
      this.spatial?.predictSegment(segment, startedAt, requestNow) ??
      this.publicBus?.predictSegment(segment, startedAt, requestNow, weather) ??
      null
    );
  }
  status() {
    const base = this.publicBus?.status() as Record<string, unknown> | undefined;
    return {
      ...(base ?? { active: false, reasons: ['unconfigured'] }),
      spatial: this.spatial?.status() ?? {
        version: SPATIAL_BUS_V3,
        active: false,
        reasons: ['unconfigured'],
      },
    };
  }
}
