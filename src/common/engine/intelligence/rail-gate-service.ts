import type { BasePlanningRequest, BaseRoute, BaseSegment } from '../../shared/domain/types.js';
import {
  parseRailGateCheckpoint,
  predictRailGate,
  RAIL_GATE_VERSION,
  type RailGateCheckpoint,
  type RailGateInput,
  type RailGatePrediction,
} from './rail-gate-model.js';
import {
  candidateReasons,
  ModelFileLoader,
  provenanceFields,
  type LoadedModel,
  type ModelPathSource,
} from './model-manifest.js';

export interface RailGateEstimate extends RailGatePrediction {
  modelVersion: typeof RAIL_GATE_VERSION;
  target: 'rail-gate-elapsed';
}
export type RailGatePredictor = (
  input: RailGateInput,
  requestNow: number,
) => RailGateEstimate | null;
export interface RailGateRuntime {
  predictRun: RailGatePredictor;
  status(): unknown;
}

/** A walk longer than this between two subway legs is treated as leaving the paid area. */
const TRANSFER_WALK_METERS = 400;

/** Reads the served subway gate-to-gate checkpoint; reloads when the file changes. */
export class RailGateModelService implements RailGateRuntime {
  private model?: RailGateCheckpoint;
  private reason = 'missing-checkpoint';
  private checkedAt = 0;
  private loaded: LoadedModel<RailGateCheckpoint> = {
    reason: 'missing-checkpoint',
    provenance: null,
    candidate: null,
  };
  private readonly loader: ModelFileLoader<RailGateCheckpoint>;
  private counters = { attempts: 0, applied: 0, inactive: 0, unsupported: 0 };
  private readonly now: () => number;
  constructor(private readonly options: { modelPath: ModelPathSource; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.loader = new ModelFileLoader({
      source: options.modelPath,
      maxBytes: 48 * 1024 * 1024,
      parse: (text) => parseRailGateCheckpoint(text),
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
  readonly predictRun: RailGatePredictor = (input, requestNow) => {
    this.reload();
    this.counters.attempts++;
    if (!this.model || requestNow < this.model.trainedAt || requestNow >= this.model.expiresAt) {
      this.counters.inactive++;
      return null;
    }
    const prediction = predictRailGate(this.model, input);
    if (!prediction) {
      this.counters.unsupported++;
      return null;
    }
    this.counters.applied++;
    return { modelVersion: RAIL_GATE_VERSION, target: 'rail-gate-elapsed', ...prediction };
  };
  status() {
    this.reload();
    const now = this.now(),
      active = !!this.model && this.model.trainedAt <= now && this.model.expiresAt > now;
    return {
      version: RAIL_GATE_VERSION,
      target: 'rail-gate-elapsed',
      active,
      usage: 'conservative-subway-run-envelope',
      dayRule: this.model?.calendar.rule ?? null,
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
        fallback: 'provider-and-timetable-duration',
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
            stations: this.model!.lookup.origins.size,
            stationPairs: this.model!.lookup.pairs.size,
            source: this.model!.source,
          }
        : {}),
      limitations: this.model?.limitations ?? [],
    };
  }
}

/** Undo a previous envelope so repeated passes never compound it. */
export function restoreRailGateSource<T extends BaseSegment>(segment: T): T {
  if (!segment.railEtaPrediction) return segment;
  const { railEtaPrediction, ...source } = segment;
  return { ...source, durationSeconds: { ...railEtaPrediction.sourceDurationSeconds } } as T;
}

const departureOf = (segment: BaseSegment) => {
  const connection = segment.mode === 'wait' ? segment.plannedConnection : undefined;
  return connection
    ? connection.status === 'borderline'
      ? (connection.fallbackDepartureAt ?? connection.departureAt)
      : connection.departureAt
    : undefined;
};

/** Latest start of each segment, holding planned departures as the bus envelope does. */
function startsOf(segments: readonly BaseSegment[], now: number): number[] {
  const starts: number[] = [];
  let cursor = now;
  for (const segment of segments) {
    starts.push(cursor);
    const departure = departureOf(segment);
    cursor =
      departure !== undefined && departure >= cursor
        ? departure
        : cursor + segment.durationSeconds.max * 1000;
  }
  return starts;
}

/**
 * Subway run = station entry, boarding wait, subway legs and in-station transfers up to the exit after the last
 * alighting. T-DATA gate tags time exactly that span. The run's slower bound grows to the
 * model's upper bound when that is later; the faster bound, the estimate and every other leg stay as planned.
 */
export function applyRailGateEnvelope(
  routes: readonly BaseRoute[],
  request: Pick<BasePlanningRequest, 'now'>,
  predict: RailGatePredictor,
): BaseRoute[] {
  return routes.map((route) => {
    const segments = route.segments.map(restoreRailGateSource);
    const restored = segments.reduce(
      (sum, segment, i) =>
        sum + segment.durationSeconds.max - route.segments[i].durationSeconds.max,
      0,
    );
    let starts = startsOf(segments, request.now),
      added = 0;
    for (let first = 0; first < segments.length; first++) {
      if (segments[first].mode !== 'subway') continue;
      let last = first;
      for (let next = first + 1; next < segments.length;) {
        let k = next;
        while (
          k < segments.length &&
          (segments[k].mode === 'wait' ||
            segments[k].mode === 'entry' ||
            (segments[k].mode === 'walk' && segments[k].distanceMeters <= TRANSFER_WALK_METERS))
        )
          k++;
        if (k < segments.length && segments[k].mode === 'subway') {
          last = k;
          next = k + 1;
        } else break;
      }
      // Gate to gate: from the station entry (and the boarding wait after it) to the exit after the last alighting.
      let start = first;
      while (
        start > 0 &&
        (segments[start - 1].mode === 'wait' ||
          (segments[start - 1].mode === 'entry' && segments[start - 2]?.mode !== 'subway'))
      )
        start--;
      // A chosen exit's street passage lies outside the gates: the tags start after it and stop before it.
      const passage = (segment: BaseSegment) =>
        segment.stationExit
          ? Math.max(0, segment.durationSeconds.max - segment.stationExit.platformSeconds)
          : 0;
      const end = segments[last + 1]?.mode === 'entry' ? last + 1 : last,
        enteredAt = Math.ceil(starts[start] + passage(segments[start]) * 1000);
      const plannedSpan =
        (starts[end] - starts[start]) / 1000 +
        segments[end].durationSeconds.max -
        passage(segments[start]) -
        passage(segments[end]);
      const origin = segments[first].start,
        destination = segments[last].end;
      first = last;
      // A later timed boarding was chosen from the unwidened arrival; widening here would invalidate it.
      if (
        segments
          .slice(last + 1)
          .some((segment) => segment.scheduledConnection || segment.plannedConnection)
      )
        continue;
      if (
        !Number.isFinite(enteredAt) ||
        enteredAt < request.now ||
        enteredAt - request.now > 3 * 3_600_000 ||
        !Number.isFinite(plannedSpan)
      )
        continue;
      const estimate = predict(
        {
          originName: origin.name,
          destinationName: destination.name,
          origin,
          destination,
          startedAt: enteredAt,
        },
        request.now,
      );
      if (
        !estimate ||
        estimate.modelVersion !== RAIL_GATE_VERSION ||
        estimate.target !== 'rail-gate-elapsed' ||
        ![estimate.lowerSeconds, estimate.medianSeconds, estimate.upperSeconds].every(
          (value) => Number.isFinite(value) && value > 0 && value <= 86_400,
        ) ||
        estimate.lowerSeconds > estimate.upperSeconds
      )
        continue;
      const extra = Math.ceil(estimate.upperSeconds - plannedSpan);
      if (extra <= 0) continue;
      const segment = segments[last];
      segments[last] = {
        ...segment,
        durationSeconds: {
          min: segment.durationSeconds.min,
          max: segment.durationSeconds.max + extra,
        },
        railEtaPrediction: {
          modelVersion: estimate.modelVersion,
          target: estimate.target,
          policy: 'conservative-envelope',
          evaluatedAt: request.now,
          enteredAt,
          originName: origin.name,
          destinationName: destination.name,
          plannedSpanSeconds: Math.round(plannedSpan),
          lowerSeconds: estimate.lowerSeconds,
          medianSeconds: Math.min(
            estimate.upperSeconds,
            Math.max(estimate.lowerSeconds, estimate.medianSeconds),
          ),
          upperSeconds: estimate.upperSeconds,
          sourceDurationSeconds: { ...segment.durationSeconds },
        },
      };
      added += extra;
      starts = startsOf(segments, request.now);
    }
    if (!added && !restored) return route;
    return {
      ...route,
      segments,
      durationSeconds: {
        min: route.durationSeconds.min,
        max: route.durationSeconds.max + restored + added,
      },
    };
  });
}
