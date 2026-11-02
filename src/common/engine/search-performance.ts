import type { RouteProvider } from './kakao.js';
import type { ApiErrorCode } from './errors.js';

export type SearchStage =
  | 'initial-routes'
  | 'access'
  | 'intermediate'
  | 'bridges'
  | 'timetable'
  | 'traffic'
  | 'signals'
  | 'weather'
  | 'inventory'
  | 'planning'
  | 'encoding'
  | 'query-walking'
  | 'query-transit'
  | 'query-driving'
  | 'query-bicycle'
  | 'query-scooter'
  | 'query-ebike'
  | 'query-nearby';
export interface SearchPerformance {
  version: 1;
  outcome: 'ok' | 'error' | 'disconnected';
  errorCode: ApiErrorCode | null;
  totalMs: number;
  routeCalls: number;
  stages: Partial<
    Record<
      SearchStage,
      { count: number; failed: number; unfinished: number; elapsedMs: number; longestMs: number }
    >
  >;
}
interface Span {
  stage: SearchStage;
  start: number;
  end?: number;
  failed: boolean;
}
const millis = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000;

/** Numeric, request-local telemetry. Never retains endpoints, bodies, IDs, URLs or exception messages.
 * Stage times can overlap (and query spans are nested); they must not be added into a wall-clock total.
 */
export class SearchProfiler {
  private readonly began: number;
  private readonly spans: Span[] = [];
  constructor(private readonly monotonic: () => number = () => performance.now()) {
    this.began = monotonic();
  }
  start(stage: SearchStage) {
    const span: Span = { stage, start: this.monotonic(), failed: false };
    this.spans.push(span);
    return (failed = false) => {
      if (span.end === undefined) {
        span.end = this.monotonic();
        span.failed = failed;
      }
    };
  }
  async measure<T>(stage: SearchStage, task: () => Promise<T>): Promise<T> {
    const stop = this.start(stage);
    try {
      const value = await task();
      stop();
      return value;
    } catch (error) {
      stop(true);
      throw error;
    }
  }
  snapshot(
    outcome: SearchPerformance['outcome'],
    routeCalls: number,
    errorCode: ApiErrorCode | null = null,
  ): SearchPerformance {
    const end = this.monotonic(),
      stages: SearchPerformance['stages'] = {};
    for (const span of this.spans) {
      const value = (stages[span.stage] ??= {
        count: 0,
        failed: 0,
        unfinished: 0,
        elapsedMs: 0,
        longestMs: 0,
      });
      const elapsed = Math.max(0, (span.end ?? end) - span.start);
      value.count++;
      value.failed += Number(span.failed);
      value.unfinished += Number(span.end === undefined);
      value.elapsedMs += elapsed;
      value.longestMs = Math.max(value.longestMs, elapsed);
    }
    for (const value of Object.values(stages)) {
      value.elapsedMs = millis(value.elapsedMs);
      value.longestMs = millis(value.longestMs);
    }
    return {
      version: 1,
      outcome,
      errorCode,
      totalMs: millis(end - this.began),
      routeCalls,
      stages,
    };
  }
  header(routeCalls: number): string {
    const sample = this.snapshot('ok', routeCalls);
    return [
      `search;dur=${sample.totalMs}`,
      ...Object.entries(sample.stages).map(([name, value]) => `${name};dur=${value.elapsedMs}`),
    ].join(', ');
  }
}

/** Insert inside request reuse: a reused result is not reported as another supplier query. */
export function profileRouteProvider(
  provider: RouteProvider,
  profiler: SearchProfiler,
): RouteProvider {
  const measured = new Set([
    'walking',
    'transit',
    'driving',
    'bicycle',
    'scooter',
    'ebike',
    'nearby',
  ]);
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string' || !measured.has(property)) return value.bind(target);
      return (...args: unknown[]) =>
        profiler.measure(`query-${property}` as SearchStage, () => value.apply(target, args));
    },
  });
}
