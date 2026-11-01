import type { BaseSegment } from '../../shared/domain/types.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import { localWeatherIsFresh } from './planningTiming.js';
import {
  parsePublicBusModel,
  predictPublicBusDuration,
  publicBusRoadLookup,
  PUBLIC_BUS_MODEL_VERSION,
  PUBLIC_BUS_SCOPE_BOUNDS,
  type PublicBusModel,
  type PublicBusPredictionInput,
} from './public-bus-model.js';
import { HOLIDAY_AS_SUNDAY } from './korean-holidays.js';
import {
  candidateReasons,
  ModelFileLoader,
  provenanceFields,
  type LoadedModel,
  type ModelPathSource,
} from './model-manifest.js';
import type { PublicBusEstimate, PublicBusRuntime } from './public-bus-timing.js';

export function publicBusWeatherInput(
  weather: WeatherSnapshot | null,
  segment: BaseSegment,
  startedAt: number,
  requestNow: number,
): PublicBusPredictionInput['weather'] {
  if (
    !localWeatherIsFresh(weather, { origin: segment.start, now: requestNow }) ||
    weather.observedAt === null ||
    weather.observedAt > startedAt ||
    startedAt - weather.observedAt > 3 * 3_600_000
  )
    return null;
  return {
    observedAt: weather.observedAt,
    ageSeconds: Math.floor((startedAt - weather.observedAt) / 1000),
    temperatureC: weather.temperatureC,
    windMetersPerSecond: weather.windMetersPerSecond,
    precipitationMm: weather.precipitationMm,
    precipitationTrace: false,
  };
}

/** Local validated checkpoint only; no credentials, source rows, or user journeys enter status. */
export class PublicBusModelService implements PublicBusRuntime {
  private model?: PublicBusModel;
  private lookupRoad?: ReturnType<typeof publicBusRoadLookup>;
  private reason = 'missing-checkpoint';
  private checkedAt = 0;
  private loaded: LoadedModel<PublicBusModel> = {
    reason: 'missing-checkpoint',
    provenance: null,
    candidate: null,
  };
  private readonly loader: ModelFileLoader<PublicBusModel>;
  private counters = {
    attempts: 0,
    applied: 0,
    inactive: 0,
    outsideScope: 0,
    unsupportedContext: 0,
  };
  private readonly now: () => number;
  constructor(private readonly options: { modelPath: ModelPathSource; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.loader = new ModelFileLoader({
      source: options.modelPath,
      maxBytes: 1_048_576,
      parse: (text, now) => parsePublicBusModel(text, now, { allowExpired: true }),
      invalidReason: 'invalid-or-expired-checkpoint',
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
    if (this.loaded.model !== this.model) {
      this.model = this.loaded.model;
      // v2 keeps its calendar-weekday cells; v3 reads holidays as Sunday, exactly as it was trained.
      this.lookupRoad = this.model ? publicBusRoadLookup(this.model) : undefined;
    }
    this.reason = this.loaded.reason;
  }
  predictSegment(
    segment: BaseSegment,
    startedAt: number,
    requestNow: number,
    weather: WeatherSnapshot | null,
  ): PublicBusEstimate | null {
    this.reload();
    if (segment.mode !== 'bus') return null;
    this.counters.attempts++;
    if (!this.model || requestNow < this.model.trainedAt || requestNow >= this.model.expiresAt) {
      this.counters.inactive++;
      return null;
    }
    const bounds = PUBLIC_BUS_SCOPE_BOUNDS;
    const seoul = (point: BaseSegment['start']) =>
      point.latitude >= bounds.south &&
      point.latitude <= bounds.north &&
      point.longitude >= bounds.west &&
      point.longitude <= bounds.east;
    if (!seoul(segment.start) || !seoul(segment.end)) {
      this.counters.outsideScope++;
      return null;
    }
    const input: PublicBusPredictionInput = {
      distanceMeters: segment.distanceMeters,
      startedAt: Math.ceil(startedAt),
      weather: publicBusWeatherInput(weather, segment, Math.ceil(startedAt), requestNow),
      roadPrior: this.lookupRoad!(Math.ceil(startedAt)),
    };
    const estimate = predictPublicBusDuration(this.model, input, requestNow);
    if (estimate) this.counters.applied++;
    else this.counters.unsupportedContext++;
    return estimate
      ? {
          modelVersion: estimate.modelVersion,
          target: estimate.target,
          lowerSeconds: estimate.lowerSeconds,
          medianSeconds: estimate.medianSeconds,
          upperSeconds: estimate.upperSeconds,
        }
      : null;
  }
  status() {
    this.reload();
    const now = this.now(),
      active = !!this.model && this.model.trainedAt <= now && this.model.expiresAt > now;
    const dayRule = this.model
      ? this.model.calendar
        ? HOLIDAY_AS_SUNDAY
        : 'calendar-weekday'
      : null;
    return {
      version: this.model?.version ?? PUBLIC_BUS_MODEL_VERSION,
      target: 'bus-tag-elapsed',
      active,
      usage: 'conservative-bus-envelope',
      scope: 'seoul-bus-ride-supported-contexts',
      dayRule,
      trainedAt: this.model?.trainedAt ?? null,
      expiresAt: this.model?.expiresAt ?? null,
      ...provenanceFields(this.loaded),
      operations: {
        remainingSeconds: this.model
          ? Math.max(0, Math.floor((this.model.expiresAt - now) / 1000))
          : null,
        refreshDue: !active || this.model!.expiresAt - now <= 48 * 3_600_000,
        lastEvaluatedServiceDate: this.model?.validation.testDates[0] ?? null,
        counters: { ...this.counters },
        counterScope: 'process-lifetime-segment-prediction-attempts',
        fallback: 'provider-duration-when-inactive-or-unsupported',
      },
      sampleCount: active
        ? Object.values(this.model!.split).reduce((sum, split) => sum + split.rows, 0)
        : 0,
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
            split: this.model!.split,
            evaluation: this.model!.evaluation,
            validation: this.model!.validation,
            scopeDefinition: this.model!.scope,
            roadPriorMonths: this.model!.roadPriorArchives.map((prior) => prior.referenceMonth),
            holidays: this.model!.calendar?.holidays ?? null,
          }
        : {}),
      limitations: [
        'public-bus-tags-not-app-recorded-trips',
        'retrospective-weather-publication-unknown',
        'historical-road-prior-not-current-traffic',
        'provider-eta-never-shortened',
        'unsupported-context-falls-back',
        ...(dayRule === HOLIDAY_AS_SUNDAY
          ? ['holiday-designated-after-training-read-as-weekday']
          : []),
      ],
    };
  }
}
