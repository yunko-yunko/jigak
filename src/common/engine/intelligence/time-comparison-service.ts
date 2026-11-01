import type { BaseRoute, BaseSegment, Place } from '../../shared/domain/types.js';
import { boardingObservationIsFresh } from '../../shared/journey/realtimeFreshness.js';
import {
  REALTIME_BOARDING_BUFFER_SECONDS,
  taxiPickupSeconds,
} from '../../shared/domain/waitEstimates.js';
import {
  travelTimeRequestSchema,
  travelTimeResponseSchema,
  TIME_MODES,
  TIME_ASSUMPTIONS,
  type BoardingEstimate,
  type TimeDetail,
  type TimeMode,
  type TravelTimeRequest,
  type TravelTimeResponse,
} from '../../shared/intelligence/travelTime.js';
import type { RouteProvider, RouteEndpoints, DrivingLeg } from '../kakao.js';
import { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import { metersBetween } from '../realtime/names.js';
import type { RealtimeService } from '../realtime/service.js';
import { applyServiceHours, enrichTransitRoutes } from '../transit-enrichment.js';
import { isNightOnlyLine } from '../realtime/names.js';
import type { TravelTimeService } from './travel-time-service.js';

const vehicle = (s?: BaseSegment) => s?.mode === 'bus' || s?.mode === 'subway';
const duration = (s: BaseSegment) => (s.durationSeconds.min + s.durationSeconds.max) / 2;
const MAX_LOOKAHEAD_SECONDS = 15 * 60;

/** Reserve direct alternatives as well as fast transfers; a night bus must not hide a daytime bus. */
export function comparisonTransitCandidates(routes: BaseRoute[], now: number): BaseRoute[] {
  const sorted = applyServiceHours(routes, now).sort(
    (a, b) => a.durationSeconds.min - b.durationSeconds.min,
  );
  const chosen = new Set<BaseRoute>();
  const pure = (r: BaseRoute, mode: 'bus' | 'subway') =>
    r.segments.some((s) => s.mode === mode) &&
    r.segments.filter(vehicle).every((s) => s.mode === mode);
  const add = (r: BaseRoute | undefined) => {
    if (r) chosen.add(r);
  };
  add(sorted.find((r) => pure(r, 'subway')));
  add(sorted.find((r) => pure(r, 'bus')));
  add(
    sorted.find(
      (r) =>
        pure(r, 'bus') &&
        r.segments
          .filter(vehicle)
          .every((s) => s.transit?.lines.some((line) => !isNightOnlyLine(line))),
    ),
  );
  for (const mode of ['bus', 'subway'] as const)
    add(sorted.find((r) => r.segments.find(vehicle)?.mode === mode && !pure(r, mode)));
  for (const r of sorted) {
    if (chosen.size >= 6) break;
    chosen.add(r);
  }
  return [...chosen];
}

/** Recompute the clock from the origin. Live waiting REPLACES an estimated wait, never adds to it. */
export function evaluateTransitComparison(route: BaseRoute, now: number) {
  let clock = now,
    entered = false,
    blocked = false;
  const boardings: BoardingEstimate[] = [];
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i],
      next = route.segments[i + 1];
    // A station exit follows the ride; only an entry before the boarding covers the platform.
    if (segment.mode === 'entry' && !vehicle(route.segments[i - 1])) entered = true;
    if (segment.mode !== 'wait' || !vehicle(next)) {
      clock += duration(segment) * 1000;
      if (vehicle(segment)) entered = false;
      continue;
    }
    const mode = next.mode as 'bus' | 'subway';
    // Exterior walking does not include the platform. Keep a visible conservative entry assumption.
    if (mode === 'subway' && !entered) clock += 120_000;
    const accessSeconds = Math.ceil((clock - now) / 1000);
    const live = next.realtime;
    const fresh = boardingObservationIsFresh(live, now);
    const future = accessSeconds > MAX_LOOKAHEAD_SECONDS;
    const predictions =
      fresh && live.status === 'live' && !future
        ? live.predictions
            .filter(
              (p) =>
                !p.express &&
                Number.isFinite(p.arrivesAt) &&
                p.arrivesAt > now &&
                p.arrivesAt <= now + 2 * 3_600_000,
            )
            .sort((a, b) => a.arrivesAt - b.arrivesAt)
        : [];
    const selected = predictions.find(
      (p) => p.arrivesAt >= clock + REALTIME_BOARDING_BUFFER_SECONDS[mode] * 1000,
    );
    const status: BoardingEstimate['status'] = future
      ? 'future'
      : live && !fresh
        ? 'stale'
        : fresh && live.status === 'no-service'
          ? 'no-service'
          : selected
            ? 'live'
            : predictions.length
              ? 'missed'
              : 'unavailable';
    if (status === 'no-service' || status === 'missed') blocked = true;
    boardings.push({
      mode,
      stopName: live?.stopName || next.transit?.stops[0] || next.start.name,
      line: selected?.line || next.transit?.lines.join(' / ') || next.lineName || '',
      direction: selected?.destination || next.direction || '',
      status,
      source: live?.provider ?? null,
      observedAt: live?.observedAt ?? null,
      checkedAt: now,
      nextArrivalAt: predictions[0]?.arrivesAt ?? null,
      nextLine: predictions[0]?.line ?? null,
      nextDirection: predictions[0]?.destination ?? null,
      selectedArrivalAt: selected?.arrivesAt ?? null,
      accessSeconds,
      waitSeconds: selected ? Math.ceil((selected.arrivesAt - clock) / 1000) : null,
      included: !!selected,
    });
    clock = selected ? selected.arrivesAt : clock + duration(segment) * 1000;
  }
  return {
    seconds: Math.max(1, Math.ceil((clock - now) / 1000)),
    boardings,
    eligible: !blocked && boardings.length > 0 && boardings[0].included,
    liveCount: boardings.filter((b) => b.included).length,
  };
}

type SourceResult = {
  walking: BaseRoute[];
  transit: BaseRoute[];
  bicycle: BaseRoute[];
  driving: DrivingLeg | null;
};
type Cached = { until: number; value: Promise<unknown> };
const range = (seconds: number) => ({
  seconds: Math.round(seconds),
  minSeconds: Math.max(1, Math.floor(seconds * 0.8)),
  maxSeconds: Math.ceil(seconds * 1.35),
});

/** Route geometry has a short cache; arrivals and comparison clocks are re-evaluated on every request. */
export class TimeComparisonService {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<TravelTimeResponse>>();
  constructor(
    private readonly options: {
      estimates: Pick<TravelTimeService, 'estimate'>;
      provider: RouteProvider;
      realtime: RealtimeService;
      now?: () => number;
    },
  ) {}
  private now = () => this.options.now?.() ?? Date.now();

  estimate(body: TravelTimeRequest): Promise<TravelTimeResponse> {
    const input = travelTimeRequestSchema.parse(body);
    if (input.journey) {
      const distance = metersBetween(input.journey.origin, input.journey.destination);
      if (Math.abs(distance - input.distanceMeters) > Math.max(5, distance * 0.02))
        throw new ApiError('INVALID_INPUT', '출발·도착 좌표와 이동 거리가 맞지 않아요.', 400);
    }
    const key = JSON.stringify(input),
      hit = this.pending.get(key);
    if (hit) return hit;
    // Existing GPT service caps paid calls; cap geometry and public-feed fan-out too.
    const value = this.calculate(input, this.pending.size < 2);
    this.pending.set(key, value);
    void value
      .finally(() => {
        if (this.pending.get(key) === value) this.pending.delete(key);
      })
      .catch(() => {});
    return value;
  }

  private cached<T>(key: string, ttl: number, run: () => Promise<T>): Promise<T> {
    const now = this.now(),
      hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value as Promise<T>;
    this.cache.delete(key);
    while (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    const entry = { until: now + ttl, value: Promise.resolve().then(run) };
    this.cache.set(key, entry);
    void entry.value.catch(() => {
      if (this.cache.get(key) === entry) this.cache.delete(key);
    });
    return entry.value;
  }

  private async sources(endpoints: RouteEndpoints, budget: CallBudget): Promise<SourceResult> {
    const provider = this.options.provider;
    const key = JSON.stringify([
      endpoints.origin.latitude,
      endpoints.origin.longitude,
      endpoints.destination.latitude,
      endpoints.destination.longitude,
    ]);
    const [walking, transit, bicycle, driving] = await Promise.all([
      this.cached(`walk:${key}`, 120_000, () => provider.walking(endpoints, budget)).catch(
        () => [] as BaseRoute[],
      ),
      this.cached(`transit:${key}`, 120_000, () => provider.transit(endpoints, budget)).catch(
        () => [] as BaseRoute[],
      ),
      provider.bicycle
        ? this.cached(`bicycle:${key}`, 120_000, () => provider.bicycle!(endpoints, budget)).catch(
            () => [] as BaseRoute[],
          )
        : [],
      provider.driving
        ? this.cached(`drive:${key}`, 30_000, () => provider.driving!(endpoints, budget)).catch(
            () => null,
          )
        : null,
    ]);
    const chosen = comparisonTransitCandidates(transit, this.now());
    // Share endpoint walks across refreshes while keeping realtime observations outside this cache.
    const accessProvider: RouteProvider = {
      ...provider,
      configured: provider.configured,
      searchPlaces: provider.searchPlaces.bind(provider),
      transit: provider.transit.bind(provider),
      walking: (pair, calls) =>
        this.cached(
          `access:${JSON.stringify([pair.origin.latitude, pair.origin.longitude, pair.destination.latitude, pair.destination.longitude])}`,
          120_000,
          () => provider.walking(pair, calls),
        ),
    };
    const enriched = await enrichTransitRoutes([...chosen], endpoints, {
      provider: accessProvider,
      budget,
      realtime: this.options.realtime,
      now: this.now(),
      maxAccessCalls: 4,
      accessModeCoverage: true,
    }).catch(() => [] as BaseRoute[]);
    return { walking, transit: enriched, bicycle, driving };
  }

  private async calculate(
    input: TravelTimeRequest,
    canFetch: boolean,
  ): Promise<TravelTimeResponse> {
    // Do not let coordinates, place names or preferences reach the language model or its cache key.
    const numeric = {
      distanceMeters: input.distanceMeters,
      runningPace: input.runningPace,
      preparationSeconds: input.preparationSeconds,
    };
    const baselinePromise = this.options.estimates.estimate(numeric);
    if (!input.journey) return baselinePromise;
    const place = (point: { latitude: number; longitude: number }, id: string): Place => ({
      ...point,
      id,
      name: id === 'origin' ? '출발지' : '도착지',
      address: '',
    });
    const endpoints = {
      origin: place(input.journey.origin, 'origin'),
      destination: place(input.journey.destination, 'destination'),
    };
    const sourcesPromise =
      canFetch && this.options.provider.configured
        ? this.sources(endpoints, new CallBudget(10))
        : Promise.resolve({ walking: [], transit: [], bicycle: [], driving: null } as SourceResult);
    const [baseline, sources] = await Promise.all([baselinePromise, sourcesPromise]);
    const now = this.now();
    const estimates = baseline.estimates.map((e) => ({ ...e }));
    const details: TimeDetail[] = TIME_MODES.map((mode) => ({
      mode,
      basis: baseline.source,
      eligible: mode !== 'bus' && mode !== 'subway',
      note: TIME_ASSUMPTIONS[mode],
      routeTitle: '',
      distanceMeters: input.distanceMeters,
      boardings: [],
    }));
    const detail = (mode: TimeMode) => details.find((d) => d.mode === mode)!;
    const set = (
      mode: TimeMode,
      seconds: number,
      distance: number,
      title: string,
      note: string,
    ) => {
      Object.assign(
        estimates.find((e) => e.mode === mode)!,
        range(seconds),
      );
      Object.assign(detail(mode), {
        basis: 'route-estimate',
        distanceMeters: distance,
        routeTitle: title,
        note,
      });
    };
    const walk = [...sources.walking].sort(
      (a, b) => a.durationSeconds.min - b.durationSeconds.min,
    )[0];
    if (walk) {
      set(
        'walk',
        (walk.durationSeconds.min + walk.durationSeconds.max) / 2,
        walk.distanceMeters,
        '도보 경로',
        '실제 보행 경로의 예상 시간 · 신호·현장 통행 상황에 따라 달라져요.',
      );
      const overhead = walk.segments
        .filter((s) => s.mode !== 'walk')
        .reduce((sum, s) => sum + duration(s), 0);
      set(
        'run',
        walk.distanceMeters / ((input.runningPace === 'steady' ? 9 : 7) / 3.6) + overhead,
        walk.distanceMeters,
        '보행 경로를 이용한 달리기 추정',
        '거리와 설정한 페이스로 추정 · 계단·횡단보도에서는 걷고 현장 통행 제한을 확인하세요.',
      );
    }
    const bike = [...sources.bicycle].sort(
      (a, b) => a.durationSeconds.min - b.durationSeconds.min,
    )[0];
    if (bike)
      set(
        'bicycle',
        (bike.durationSeconds.min + bike.durationSeconds.max) / 2,
        bike.distanceMeters,
        '자전거 경로',
        '자전거 경로의 예상 시간 · 따릉이 대여소까지의 이동은 길찾기에서 함께 계산해요.',
      );
    if (sources.driving)
      set(
        'taxi',
        sources.driving.durationSeconds + taxiPickupSeconds(now),
        sources.driving.distanceMeters,
        '도로 교통 반영 택시 경로',
        `도로 소요시간 + 배차 대기 약 ${Math.ceil(taxiPickupSeconds(now) / 60)}분 가정 · 실제 배차를 보장하지 않아요.`,
      );
    const transit = sources.transit.map((route) => ({
      route,
      result: evaluateTransitComparison(route, now),
    }));
    for (const mode of ['bus', 'subway'] as const) {
      // Keep each card's first boarding aligned with its label; mixed routes remain clearly named.
      const candidates = transit
        .filter((t) => t.route.segments.find(vehicle)?.mode === mode)
        .sort(
          (a, b) =>
            Number(b.result.eligible) - Number(a.result.eligible) ||
            a.result.seconds - b.result.seconds,
        );
      const winner = candidates[0],
        d = detail(mode);
      if (!winner) {
        d.note =
          '목적지까지의 경로·실시간 승차 정보를 확인하지 못했어요. 아래 값은 거리 추정이며 최단 수단 추천에서 제외했어요.';
        continue;
      }
      const { result, route } = winner;
      set(
        mode,
        result.seconds,
        route.distanceMeters,
        route.title,
        `${result.liveCount ? '확인된 차량의 대기 시간 반영' : '실시간 대기 미반영'} · 접근·환승·하차 후 이동 포함. 역내 이동은 별도 안내가 없으면 2분 가정.` +
          (result.boardings.some((b) => !b.included)
            ? ' 확인되지 않은 환승 대기는 추정값이에요.'
            : '') +
          (!result.eligible ? ' 첫 승차를 확인하지 못해 최단 수단 추천에서 제외했어요.' : ''),
      );
      Object.assign(d, {
        eligible: result.eligible,
        basis: result.liveCount ? 'live-transit' : 'route-estimate',
        boardings: result.boardings,
      });
    }
    const preferences = input.journey.preferences;
    for (const d of details) {
      let excluded = '';
      if (preferences?.walkingOnly && d.mode !== 'walk') excluded = '걷기만 비교 설정';
      else if (
        preferences &&
        d.mode === 'run' &&
        (!preferences.allowRunning || d.distanceMeters > preferences.maxRunningMeters)
      )
        excluded = '달리기 허용 또는 거리 상한 설정';
      else if (
        preferences &&
        d.mode === 'bicycle' &&
        (!preferences.allowBicycle ||
          !preferences.bicycleReady ||
          d.distanceMeters > preferences.maxBicycleMeters)
      )
        excluded = '자전거 준비·허용 또는 거리 상한 설정';
      else if (preferences && d.mode === 'taxi' && !preferences.allowTaxi)
        excluded = '택시 제외 설정';
      if (excluded) {
        d.eligible = false;
        d.note += ` ${excluded}으로 추천에서 제외했어요.`;
      }
    }
    const recommendedMode =
      [...estimates].filter((e) => detail(e.mode).eligible).sort((a, b) => a.seconds - b.seconds)[0]
        ?.mode ?? null;
    return travelTimeResponseSchema.parse({
      ...baseline,
      estimates,
      generatedAt: now,
      expiresAt: now + 60_000,
      comparison: { details, recommendedMode, refreshAfter: now + 30_000 },
      notice:
        '경로·실시간 승차 대기를 우선 반영하고 없는 자료는 추정으로 구분했어요. 비교한 후보의 예상 최단이며, 실제 배차·승차·따릉이 이용과 정시 도착은 보장하지 않아요.',
    });
  }
}
