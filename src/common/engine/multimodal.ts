import { taxiPickupSeconds } from '../shared/domain/waitEstimates.js';
import type {
  BaseRoute,
  BaseSegment,
  MobilityPreferences,
  ParkingAccess,
  Place,
  Risk,
} from '../shared/domain/index.js';
import { ApiError } from './errors.js';
import type { CallBudget } from './call-budget.js';
import type { DrivingLeg, NearbyPlace, RouteEndpoints, RouteProvider } from './kakao.js';
import { type BikeStation, type MobilityFeeds, type SharedScooter } from './realtime/mobility.js';
import type { ParkingLookup } from './realtime/parking.js';
import { metersBetween, stationBaseName } from './realtime/names.js';
import { hasBicycleAvailabilityEvidence } from '../shared/domain/vehicleConstraints.js';
import { routeQueryIsReusable } from './connectivity/query-reuse.js';
import {
  estimatedSegmentSeconds,
  type RoutingObjective,
} from '../shared/domain/estimatedTiming.js';
import { acquisitionTiming, contextualAcquisitionTimings } from './acquisition-priority.js';

/**
 * Cross-mode candidates around the provider's walking and transit routes. Every candidate is
 * timed leg by leg and handed to the same planner, which ranks them all by arrival:
 * - running the walks to and from stops (can catch an earlier vehicle),
 * - shared e-scooters for long first/last walks: the parked scooter where operators report
 *   positions, and nothing where they report that none is near,
 * - taxi door to door, or taxi for the first or last part of a transit route,
 * - the rider's own car, walking to the saved car position and parking at a public lot,
 *   either near the destination or at a subway station to continue by transit,
 * - 따릉이 door to door or for a long first/last walk, hiring where bikes are in stock now.
 * Road legs use Kakao Mobility traffic routes. Bicycle/PM candidates require their own
 * routing adapters and actual pickup access. A pedestrian route never becomes a ride.
 */

export interface MultimodalRequest extends RouteEndpoints {
  preferences: MobilityPreferences;
}

export interface MultimodalContext {
  provider: RouteProvider;
  budget: CallBudget;
  now: number;
  acquisitionObjective?: RoutingObjective;
  /** Keep valid siblings in the graph: walking time alone cannot dominate a runnable path. */ onWalkingAlternatives?: (
    routes: BaseRoute[],
  ) => void;
  /** Live scooter positions and 따릉이 stock. */ mobility?: MobilityFeeds;
  parking?: ParkingLookup;
  /** API orchestration reserves calls for primary modes before optional transit connections. */ candidateScope?:
    'primary' | 'connections';
}

const PARKING_SECONDS = 180;

const SCOOTER = {
  speed: 4.2,
  unlock: 60,
  minMeters: 500,
  maxMeters: 6_000,
  reachMeters: 150,
};

const BIKE = {
  speed: 3.6,
  hire: 90,
  return: 60,
  searchRadius: 500,
  minMeters: 600,
  reachMeters: 220,
};

const RUN_SPEED = {
  easy: 2.6,
  steady: 3.1,
} as const;

/** Running a short walk saves seconds, not minutes; such variants only add noise. */
const MIN_RUN_METERS = 150;

/** Rough city driving for choosing which taxi splices are worth a routing call. */
const ESTIMATE_DRIVE_SPEED = 6.5;
const ESTIMATE_DETOUR = 1.35;
const MIN_SAVING_SECONDS = 120;
const MAX_SPLICES = 3;

const isVehicle = (segment: BaseSegment) => segment.mode === 'bus' || segment.mode === 'subway';

const isFootWalk = (segment: BaseSegment) =>
  segment.mode === 'walk' && segment.distanceMeters > 0 && (segment.polyline?.length ?? 0) >= 2;

const seconds = (segments: BaseSegment[], edge: 'min' | 'max' = 'min') =>
  segments.reduce((sum, segment) => sum + segment.durationSeconds[edge], 0);

const km = (meters: number) => `${(meters / 1_000).toFixed(1)}km`;

const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;

export { taxiPickupSeconds } from '../shared/domain/waitEstimates.js';

export function totals(route: Omit<BaseRoute, 'durationSeconds' | 'distanceMeters'>): BaseRoute {
  return {
    ...route,
    durationSeconds: {
      min: seconds(route.segments, 'min'),
      max: seconds(route.segments, 'max'),
    },
    distanceMeters: route.segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
  };
}

function vehicleLabel(segment: BaseSegment): string {
  if (segment.mode === 'subway') {
    return segment.transit?.lines[0] ?? segment.lineName ?? '지하철';
  }

  if (segment.mode === 'bus') {
    return `${segment.transit?.lines[0] ?? segment.lineName ?? ''}번`.replace(/^번$/, '버스');
  }

  return (
    {
      taxi: '택시',
      car: '자가용',
      scooter: '킥보드',
      bicycle: '따릉이',
      run: '달리기',
    }[segment.mode as 'taxi'] ?? ''
  );
}

/** "택시 → 2호선", "자가용 → 4호선 → 2호선" from the moving legs. */
export function multimodalTitle(segments: BaseSegment[]): string {
  const labels: string[] = [];

  for (const segment of segments) {
    if (!['bus', 'subway', 'taxi', 'car', 'scooter', 'bicycle'].includes(segment.mode)) {
      continue;
    }

    const label = vehicleLabel(segment);

    if (label && labels[labels.length - 1] !== label) {
      labels.push(label);
    }
  }

  return labels.join(' → ') || '걸어서 가기';
}

export function waitSegment(
  id: string,
  title: string,
  instructions: string,
  durationSeconds: number,
  at: Place,
): BaseSegment {
  return {
    id,
    mode: 'wait',
    title,
    instructions,
    distanceMeters: 0,
    durationSeconds: {
      min: durationSeconds,
      max: durationSeconds,
    },
    start: at,
    end: at,
    runAllowed: false,
  };
}

/** "정체 0.9km · 서행 2.2km" for the congested parts of a road leg. */
export function congestionSummary(leg: Pick<DrivingLeg, 'polyline' | 'traffic'>): string {
  const meters: Partial<Record<string, number>> = {};

  for (const span of leg.traffic) {
    let length = 0;

    for (let index = span.from + 1; index <= span.to; index += 1) {
      length += metersBetween(leg.polyline[index - 1], leg.polyline[index]);
    }

    meters[span.level] = (meters[span.level] ?? 0) + length;
  }

  return (
    [
      ['jam', '정체'],
      ['delay', '지체'],
      ['slow', '서행'],
    ] as const
  )
    .filter(([level]) => (meters[level] ?? 0) >= 200)
    .map(([level, label]) => `${label} ${km(meters[level]!)}`)
    .join(' · ');
}

export function roadSegment(
  id: string,
  mode: 'taxi' | 'car',
  from: Place,
  to: Place,
  leg: DrivingLeg,
): BaseSegment {
  const fare =
    mode === 'taxi' && leg.taxiFareWon ? leg.taxiFareWon + (leg.tollWon ?? 0) : undefined;
  const congestion = congestionSummary(leg);

  return {
    id,
    mode,
    start: from,
    end: to,
    runAllowed: false,
    title: mode === 'taxi' ? `택시로 ${to.name}까지` : `${to.name}까지 운전`,
    instructions: `${km(leg.distanceMeters)} · ${congestion || '대체로 원활'}${fare ? ` · 예상 ${won(fare)}` : ''}`,
    distanceMeters: leg.distanceMeters,
    durationSeconds: {
      min: leg.durationSeconds,
      max: leg.durationSeconds,
    },
    polyline: leg.polyline,
    maneuvers: leg.maneuvers.length ? leg.maneuvers : undefined,
    traffic: leg.traffic.length ? leg.traffic : undefined,
    ...(fare !== undefined
      ? {
          costWon: fare,
        }
      : {}),
  };
}

function combinedPlanningBuffer(segments: readonly BaseSegment[]): BaseSegment['planningBuffer'] {
  if (!segments.some((segment) => segment.planningBuffer)) {
    return undefined;
  }

  return segments.reduce(
    (buffer, segment) => ({
      weatherSeconds: buffer.weatherSeconds + (segment.planningBuffer?.weatherSeconds ?? 0),
      calibrationSeconds:
        buffer.calibrationSeconds + (segment.planningBuffer?.calibrationSeconds ?? 0),
    }),
    {
      weatherSeconds: 0,
      calibrationSeconds: 0,
    },
  );
}

function stationAnchorNote(route: BaseRoute, point: Place, segmentId: string): Risk[] {
  const touchesSubway = route.segments.some(
    (segment) =>
      segment.mode === 'subway' &&
      (metersBetween(vehiclePoint(segment, 'start'), point) < 1 ||
        metersBetween(vehiclePoint(segment, 'end'), point) < 1),
  );

  return touchesSubway
    ? [
        {
          code: 'unverified-duration-range',
          severity: 'warning',
          segmentId,
          title: '역 내부 보행 연결 미확인',
          description:
            '지하철 경로의 역 좌표를 연결점으로 사용했지만 실제 지상 출입구·개찰구·승강장 사이의 경로와 소요는 확인되지 않았어요. 기존에 제공된 진입 시간은 유지하며 내부 보행이 확인되기 전에는 빠른 조합으로 추천하지 않아요.',
        },
      ]
    : [];
}

function asRun(segment: BaseSegment, pace: number): BaseSegment {
  const duration = Math.ceil(segment.distanceMeters / pace);
  const preservedBuffer =
    (segment.planningBuffer?.weatherSeconds ?? 0) +
    (segment.planningBuffer?.calibrationSeconds ?? 0);

  return {
    ...segment,
    id: `${segment.id}:run`,
    mode: 'run',
    title: segment.title.replace(/걷기$/, '달리기'),
    instructions: `${Math.round(segment.distanceMeters)}m를 가볍게 달려요. 신호와 보행자를 먼저 살펴요.`,
    durationSeconds: {
      min: duration,
      max: duration + preservedBuffer,
    },
    walkingDurationSeconds: segment.durationSeconds,
  };
}

/**
 * The scooter reported at the start of a walk. `null`: positions are reported here and none is
 * parked within reach, so no scooter leg. `undefined`: nobody reports positions here, so the
 * rider finds one in the operator's app.
 */
export type ScooterLookup = (segment: BaseSegment) => SharedScooter | null | undefined;

/** 따릉이 stations to hire at the start of a walk and return at its end, both checked live. */
export type BikeLookup = (segment: BaseSegment) => {
  hire: BikeStation;
  drop: BikeStation;
} | null;

export const taxiNote: Risk = {
  code: 'vehicle-availability',
  severity: 'info',
  title: '택시 배차 시간은 예상치',
  description: '시간대별 평균 배차 대기를 더했어요. 호출 앱에서 실제 배차를 확인하세요.',
};

const parkingNote = (
  lot: NearbyPlace & {
    parkingAccess?: ParkingAccess;
  },
): Risk => {
  const access = lot.parkingAccess;
  const operation =
    access?.operating === 'open'
      ? '예상 도착 시 운영시간 안에 있어요.'
      : '공휴일을 포함한 예상 도착 시 운영시간은 미확인이에요.';
  const spaces =
    access?.occupancy === 'available'
      ? `조회 당시 ${access.availableSpaces ?? ''}면 여유가 있어요.`
      : '현재 여유면은 미확인이에요.';

  const fee =
    access?.fee === 'free'
      ? '제공된 일반 요금표는 무료예요.'
      : access?.fee === 'paid'
        ? Number.isFinite(access.baseFeeWon) &&
          Number.isFinite(access.baseMinutes) &&
          access.baseMinutes! > 0
          ? `기본요금 ${access.baseFeeWon}원 / ${access.baseMinutes}분. 체류시간·추가요금·할인에 따른 총 주차요금은 미확인이에요.`
          : '유료 주차장이며 체류시간에 따른 총 주차요금은 미확인이에요.'
        : '주차요금은 미확인이에요.';

  return {
    code: 'parking',
    severity:
      access?.operating === 'open' && access.occupancy === 'available' && access.fee !== 'unknown'
        ? 'info'
        : 'warning',
    title: `${lot.name}에 주차`,
    description: `일반 이용 가능한 공영주차장 분류를 확인했어요. ${operation} ${spaces} ${fee} 도착 시 주차 가능 면수와 현장 운영 조건을 다시 확인하세요.`,
  };
};

/** A walk long enough that a scooter saves real time, and short enough to ride. */
const scooterWorthy = (segment: BaseSegment) =>
  isFootWalk(segment) &&
  segment.distanceMeters >= SCOOTER.minMeters &&
  segment.distanceMeters <= SCOOTER.maxMeters;

/** A walk long enough to be worth hiring a bike for. */
const bikeWorthy = (segment: BaseSegment, preferences: MobilityPreferences) =>
  isFootWalk(segment) &&
  segment.distanceMeters >= BIKE.minMeters &&
  segment.distanceMeters <= preferences.maxBicycleMeters;

/**
 * Running changes a walking pace only. Ride modes require separate provider calls below.
 */
export function footVariants(
  routes: BaseRoute[],
  preferences: MobilityPreferences,
  scooterAt?: ScooterLookup,
  bikeAt?: BikeLookup,
): BaseRoute[] {
  if (preferences.walkingOnly) {
    return [];
  }

  const variants: BaseRoute[] = [];

  for (const source of routes) {
    const walkingOnly = !source.segments.some(isVehicle);

    // An unclassified provider allowance may include signals or access delays. Faster
    // movement is not evidence that those seconds disappear.
    const route = source;
    const walks = route.segments.flatMap((segment, index) => (isFootWalk(segment) ? [index] : []));

    if (!walks.length) {
      continue;
    }

    if (preferences.allowRunning) {
      const pace = RUN_SPEED[preferences.runningPace];
      const runnable = walks.filter(
        (index) =>
          route.segments[index].runAllowed &&
          route.segments[index].distanceMeters >= MIN_RUN_METERS,
      );

      if (!runnable.length) {
        continue;
      }

      // Individual reviewed middle walks also become graph edges. The graph can then
      // select the useful combination while enforcing the cumulative running cap.
      const sets = walkingOnly ? [runnable] : [...runnable.map((index) => [index]), runnable];
      const seen = new Set<string>();

      for (const set of sets) {
        const unique = [...new Set(set)];
        const key = unique.join(',');

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);

        if (
          unique.reduce((sum, index) => sum + route.segments[index].distanceMeters, 0) >
          preferences.maxRunningMeters
        ) {
          continue;
        }

        const segments = route.segments.map((segment, index) =>
          unique.includes(index) ? asRun(segment, pace) : segment,
        );

        variants.push(
          totals({
            ...route,
            id: `${route.id}:run-${key}`,
            title: walkingOnly ? '달려서 가기' : `${route.title} · 달리기`,
            segments,
          }),
        );
      }
    }
  }

  return variants;
}

async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) {
      return null;
    }

    throw error;
  }
}

const validPoint = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;

const samePoint = (
  left: Pick<Place, 'latitude' | 'longitude'>,
  right: Pick<Place, 'latitude' | 'longitude'>,
) =>
  Math.abs(left.latitude - right.latitude) < 0.000001 &&
  Math.abs(left.longitude - right.longitude) < 0.000001;

/** Merge only a continuous provider foot route; retain every included source second. */
export function mergeWalkingRoute(
  route: BaseRoute | undefined,
  id: string,
  from: Place,
  to: Place,
  title: string,
): BaseSegment | null {
  if (!route?.segments.length || !validPoint(from) || !validPoint(to)) {
    return null;
  }

  const segments = route.segments,
    walks = segments.filter((segment) => segment.mode === 'walk');

  if (
    !walks.length ||
    segments.some(
      (segment, index) =>
        !validPoint(segment.start) ||
        !validPoint(segment.end) ||
        !Number.isFinite(segment.distanceMeters) ||
        segment.distanceMeters < 0 ||
        !Number.isFinite(segment.durationSeconds.min) ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.min < 0 ||
        segment.durationSeconds.max < segment.durationSeconds.min ||
        (index > 0 && !samePoint(segments[index - 1].end, segment.start)) ||
        segment.traffic?.some((span) => span.level === 'blocked') ||
        (segment.mode !== 'walk' && segment.mode !== 'wait') ||
        (segment.mode === 'wait' &&
          (segment.distanceMeters !== 0 ||
            !samePoint(segment.start, segment.end) ||
            segment.timingRule !== undefined)) ||
        (segment.mode === 'walk' &&
          (!segment.polyline ||
            segment.polyline.length < 2 ||
            !segment.polyline.every(validPoint) ||
            metersBetween(segment.polyline[0], segment.start) > 75 ||
            metersBetween(segment.polyline.at(-1)!, segment.end) > 75)),
    )
  ) {
    return null;
  }

  if (
    metersBetween(segments[0].start, from) > 75 ||
    metersBetween(segments.at(-1)!.end, to) > 75 ||
    metersBetween(walks[0].polyline![0], from) > 75 ||
    metersBetween(walks.at(-1)!.polyline!.at(-1)!, to) > 75 ||
    walks.some(
      (segment, index) =>
        index > 0 && metersBetween(walks[index - 1].polyline!.at(-1)!, segment.polyline![0]) > 1,
    )
  ) {
    return null;
  }

  const points = walks.flatMap((segment) => segment.polyline!);
  const distance = walks.reduce((sum, segment) => sum + segment.distanceMeters, 0);

  if (
    metersBetween(from, to) >= 1 &&
    (distance <= 0 || !points.some((point) => metersBetween(points[0], point) >= 1))
  ) {
    return null;
  }

  const source = walks.find((segment) => segment.routingSource)?.routingSource;

  if (
    source &&
    walks.some(
      (segment) =>
        segment.routingSource && JSON.stringify(segment.routingSource) !== JSON.stringify(source),
    )
  ) {
    return null;
  }

  const snaps = walks.filter((segment) => segment.networkSnap);
  const maneuvers = walks.flatMap((segment) => segment.maneuvers ?? []);

  return {
    ...walks[0],
    id,
    title,
    start: from,
    end: to,
    instructions: `${Math.round(distance)}m 걸어요.`,
    distanceMeters: distance,
    durationSeconds: {
      min: seconds(segments, 'min'),
      max: seconds(segments, 'max'),
    },
    planningBuffer: combinedPlanningBuffer(segments),
    runAllowed: segments.every((segment) => segment.mode === 'walk' && segment.runAllowed),
    polyline: points,
    maneuvers: maneuvers.length ? maneuvers : undefined,
    ...(source
      ? {
          routingSource: source,
        }
      : {}),
    ...(snaps.length
      ? {
          networkSnap: {
            startMeters: walks[0].networkSnap?.startMeters ?? 0,
            endMeters: walks.at(-1)!.networkSnap?.endMeters ?? 0,
            allowanceSeconds: snaps.reduce(
              (sum, segment) => sum + segment.networkSnap!.allowanceSeconds,
              0,
            ),
          },
        }
      : {}),
  };
}

/** Single-access consumers still compare every returned foot alternative after validation. */
export function bestWalkingSegment(
  routes: readonly BaseRoute[],
  id: string,
  from: Place,
  to: Place,
  title: string,
  now: number,
  objective: RoutingObjective = 'estimated-arrival',
  onAlternatives?: MultimodalContext['onWalkingAlternatives'],
): BaseSegment | null {
  const candidates = routes.flatMap((route) => {
    const segment = mergeWalkingRoute(route, id, from, to, title);

    if (!segment) {
      return [];
    }

    const cost =
      objective === 'conservative-arrival'
        ? segment.durationSeconds.max
        : estimatedSegmentSeconds(segment, now);

    return cost !== null && Number.isFinite(cost)
      ? [
          {
            segment,
            cost,
            sourceId: route.id,
            route,
          },
        ]
      : [];
  });

  // This representative is for assembling one source itinerary, not a claim
  // that other distance/permission choices cannot yield an earlier full journey.
  if (candidates.length > 1) {
    onAlternatives?.(
      candidates.map(({ segment, route }) =>
        totals({
          ...route,
          segments: [segment],
          notes: route.notes?.map((note) =>
            note.segmentId
              ? {
                  ...note,
                  segmentId: segment.id,
                }
              : note,
          ),
        }),
      ),
    );
  }

  return (
    candidates.sort(
      (a, b) =>
        a.cost - b.cost ||
        a.segment.durationSeconds.max - b.segment.durationSeconds.max ||
        a.segment.distanceMeters - b.segment.distanceMeters ||
        a.sourceId.localeCompare(b.sourceId),
    )[0]?.segment ?? null
  );
}

export async function walkBetween(
  context: MultimodalContext,
  id: string,
  from: Place,
  to: Place,
  title: string,
): Promise<BaseSegment> {
  const straight = metersBetween(from, to);

  if (straight < 1) {
    return {
      id,
      mode: 'walk',
      title,
      instructions: '같은 위치예요.',
      distanceMeters: 0,
      durationSeconds: {
        min: 0,
        max: 0,
      },
      start: from,
      end: to,
      runAllowed: false,
    };
  }

  const route = await context.provider.walking(
    {
      origin: from,
      destination: to,
    },
    context.budget,
  );

  const merged = bestWalkingSegment(
    route,
    id,
    from,
    to,
    title,
    context.now,
    context.acquisitionObjective,
    context.onWalkingAlternatives,
  );

  if (!merged) {
    throw new ApiError('NO_ROUTES', '차량까지 걷는 실제 연결 경로가 없어 후보를 제외했어요.', 404);
  }

  return merged;
}

/** A road snap is a real pickup/dropoff anchor, never an invisible walk from the pin. */
export async function taxiConnection(
  context: MultimodalContext,
  from: Place,
  to: Place,
  prefix: string,
  onBudgetLimited?: () => void,
): Promise<BaseSegment[] | null> {
  if (!context.provider.driving) {
    return null;
  }

  if (
    context.budget.remaining < 1 &&
    !routeQueryIsReusable(
      context.provider,
      'driving',
      {
        origin: from,
        destination: to,
      },
      context.budget,
    )
  ) {
    onBudgetLimited?.();

    return null;
  }

  const leg = await context.provider.driving(
    {
      origin: from,
      destination: to,
    },
    context.budget,
  );

  if (
    !Number.isFinite(leg.durationSeconds) ||
    leg.durationSeconds < 0 ||
    !Number.isFinite(leg.distanceMeters) ||
    leg.distanceMeters <= 0 ||
    leg.polyline.length < 2 ||
    !leg.polyline.every(validPoint) ||
    !leg.polyline.some((point) => metersBetween(leg.polyline[0], point) >= 1) ||
    leg.traffic.some((span) => span.level === 'blocked')
  ) {
    return null;
  }

  const first = leg.polyline[0],
    last = leg.polyline.at(-1)!;

  const pickup: Place =
    metersBetween(from, first) < 1
      ? from
      : {
          id: `${prefix}-pickup`,
          name: `${from.name} 부근 택시 승차 연결점`,
          address: '',
          ...first,
        };

  const dropoff: Place =
    metersBetween(to, last) < 1
      ? to
      : {
          id: `${prefix}-dropoff`,
          name: `${to.name} 부근 택시 하차 연결점`,
          address: '',
          ...last,
        };

  const needed =
    Number(
      metersBetween(from, pickup) >= 1 &&
        !routeQueryIsReusable(
          context.provider,
          'walking',
          {
            origin: from,
            destination: pickup,
          },
          context.budget,
        ),
    ) +
    Number(
      metersBetween(dropoff, to) >= 1 &&
        !routeQueryIsReusable(
          context.provider,
          'walking',
          {
            origin: dropoff,
            destination: to,
          },
          context.budget,
        ),
    );

  if (context.budget.remaining < needed) {
    onBudgetLimited?.();

    return null;
  }

  const curbWalks = [
    walkBetween(context, `${prefix}-access`, from, pickup, '택시 승차 연결점까지 걷기'),
    walkBetween(context, `${prefix}-egress`, dropoff, to, `${to.name}까지 걷기`),
  ] as const;

  // Preserve the first provider error, but keep the budget reservation until
  // queued walks and their fallbacks have also finished.
  const outcome = Promise.all(curbWalks).then(
    (segments) => ({
      segments,
    }),
    (error) => ({
      error,
    }),
  );

  await Promise.allSettled(curbWalks);

  const result = await outcome;

  if ('error' in result) {
    throw result.error;
  }

  const [access, egress] = result.segments;

  return [
    ...(access.distanceMeters > 0 ? [access] : []),
    {
      ...waitSegment(
        `${prefix}-dispatch`,
        '택시 호출·탑승',
        '현장에서 정차·승차 가능한 위치를 확인하고 택시 앱에서 호출하세요. 실제 배차는 별도로 확인해요.',
        taxiPickupSeconds(context.now + access.durationSeconds.max * 1000),
        pickup,
      ),
      timingRule: 'taxi-dispatch' as const,
    },
    roadSegment(`${prefix}-ride`, 'taxi', pickup, dropoff, leg),
    ...(egress.distanceMeters > 0 ? [egress] : []),
  ];
}

export const vehiclePoint = (segment: BaseSegment, edge: 'start' | 'end'): Place => {
  const point =
    edge === 'start' ? segment.polyline?.[0] : segment.polyline?.[segment.polyline.length - 1];
  const place = segment[edge];

  return {
    ...place,
    name: segment.mode === 'subway' ? `${stationBaseName(place.name)}역` : place.name,
    latitude: point?.latitude ?? place.latitude,
    longitude: point?.longitude ?? place.longitude,
  };
};

interface Splice {
  route: BaseRoute;
  kind: 'first' | 'last';
  cut: number;
  point: Place;
  saving: number;
  /** Query order only; fetched road legs determine the actual ETA. */ journeyPriority: number;
}

/** Inspect every supplied source before the paid-query cap. Prefer a faster whole
 * journey, rather than the largest saving on an otherwise slow itinerary.
 */
export function taxiSplices(
  transit: BaseRoute[],
  request: RouteEndpoints,
  now: number,
  options: {
    objective?: RoutingObjective;
    acceptPoint?: (point: Place) => boolean;
  } = {},
): Splice[] {
  const pickup = taxiPickupSeconds(now);

  const estimate = (from: Place, to: Place) =>
    pickup + (metersBetween(from, to) * ESTIMATE_DETOUR) / ESTIMATE_DRIVE_SPEED;

  const candidates: Splice[] = [];
  const timings = contextualAcquisitionTimings(
    request,
    transit,
    now,
    options.objective ?? 'estimated-arrival',
  );

  for (const route of transit) {
    const timing = timings.get(route)!;
    const vehicles = route.segments.flatMap((segment, index) =>
      isVehicle(segment) ? [index] : [],
    );

    vehicles.forEach((index, order) => {
      // First mile: a taxi to this boarding replaces everything before its wait.
      let cut = index;

      while (cut > 0 && ['wait', 'entry'].includes(route.segments[cut - 1].mode)) {
        cut -= 1;
      }

      const before =
        timing.prefix + timing.segments.slice(0, cut).reduce((sum, value) => sum + value, 0);
      const boarding = vehiclePoint(route.segments[index], 'start');
      const firstCost = estimate(request.origin, boarding);

      if (order > 0 || before >= 600) {
        candidates.push({
          route,
          kind: 'first',
          cut,
          point: boarding,
          saving: before - firstCost,
          journeyPriority:
            firstCost +
            timing.segments.slice(cut).reduce((sum, value) => sum + value, 0) +
            timing.suffix,
        });
      }

      // Last mile: a taxi from this alighting replaces everything after it.
      const after =
        timing.suffix + timing.segments.slice(index + 1).reduce((sum, value) => sum + value, 0);
      const alighting = vehiclePoint(route.segments[index], 'end');
      const lastCost = estimate(alighting, request.destination);

      if (order < vehicles.length - 1 || after >= 600) {
        candidates.push({
          route,
          kind: 'last',
          cut: index + 1,
          point: alighting,
          saving: after - lastCost,
          journeyPriority:
            timing.prefix +
            timing.segments.slice(0, index + 1).reduce((sum, value) => sum + value, 0) +
            lastCost,
        });
      }
    });
  }

  const chosen: Splice[] = [];

  for (const option of candidates
    .filter(
      (value) =>
        value.saving >= MIN_SAVING_SECONDS &&
        (!options.acceptPoint || options.acceptPoint(value.point)),
    )
    .sort((a, b) => a.journeyPriority - b.journeyPriority || b.saving - a.saving)) {
    if (
      chosen.some(
        (value) => value.kind === option.kind && metersBetween(value.point, option.point) < 150,
      )
    ) {
      continue;
    }

    chosen.push(option);

    if (chosen.length >= MAX_SPLICES) {
      break;
    }
  }

  return chosen;
}

async function nearestPublicParking(
  context: MultimodalContext,
  near: Place,
  radius: number,
): Promise<
  | (NearbyPlace & {
      parkingAccess: ParkingAccess;
    })
  | null
> {
  if (context.parking?.configured) {
    return context.parking.nearest(near, radius, context.now);
  }

  if (!context.provider.nearby) {
    return null;
  }

  const lots = await attempt(() =>
    context.provider.nearby!({
      keyword: '공영주차장',
      latitude: near.latitude,
      longitude: near.longitude,
      radius,
    }),
  );

  // Only lots Kakao classifies as public parking: anyone may park there for a fee or free.
  const lot = lots
    ?.filter(
      (lot) =>
        /공영주차장/.test(lot.category) &&
        !/거주자|전용|부설|정기권/.test(`${lot.category} ${lot.name}`) &&
        metersBetween(near, lot) <= radius,
    )
    .sort((a, b) => metersBetween(near, a) - metersBetween(near, b))[0];

  return lot
    ? {
        ...lot,
        parkingAccess: {
          publicAccess: true,
          provider: 'kakao-local',
          operating: 'unknown',
          occupancy: 'unknown',
          fee: 'unknown',
          verifiedAt: null,
        },
      }
    : null;
}

const isFreshLookup = (
  value: {
    receivedAt?: number;
    observedAt?: number | null;
  },
  now: number,
) =>
  value.receivedAt !== undefined &&
  Number.isFinite(value.receivedAt) &&
  value.receivedAt <= now + 30_000 &&
  now - value.receivedAt <= 120_000 &&
  (value.observedAt == null ||
    (value.observedAt <= now + 30_000 && now - value.observedAt <= 120_000));

const stationPlace = (station: BikeStation): Place => ({
  id: `ddareungi-${station.id}`,
  name: station.name,
  address: '',
  latitude: station.latitude,
  longitude: station.longitude,
});

const lotPlace = (lot: NearbyPlace): Place => ({
  id: lot.id,
  name: lot.name,
  address: lot.address,
  latitude: lot.latitude,
  longitude: lot.longitude,
});

export const bicycleNote: Risk = {
  code: 'bicycle-stock',
  severity: 'warning',
  title: '따릉이 대여·반납 조건 미확인',
  description:
    '서울시 조회 재고로 대여소를 비교했지만 원본 관측 시각과 반납 가능 여부는 제공되지 않아요. 이용 조건이 확인되기 전에는 가장 빠른 이동 조합으로 추천하지 않아요.',
};

/** Normal designated-station return does not require a vacant rack; pickup stock is still a query, not a reservation. */
export function bicycleNotes(segments: readonly BaseSegment[], now: number): Risk[] {
  return segments.some((segment) => segment.bicycleAvailability) &&
    hasBicycleAvailabilityEvidence(segments, now)
    ? [
        {
          code: 'bicycle-stock',
          severity: 'info',
          title: '서울시 조회 재고와 대여소 반납 정책',
          description:
            '조회 당시 자전거가 있는 대여소와 지정 반납 대여소로 비교했어요. 거치대가 차도 대여소 가까이에 보행을 방해하지 않게 세워 반납할 수 있어요. 예약·대여·반납 성공을 보장하지 않으며 대여 직전에 재고·이용권·현장 운영을 다시 확인하고, 반납 완료 알림을 확인하세요. 원본 측정시각이 없는 조회는 제한된 신뢰도의 예상이에요.',
        },
      ]
    : [bicycleNote];
}

export interface BicycleStationPair {
  hire: BikeStation;
  drop: BikeStation;
}

/**
 * A measured access detour can justify looking beyond the three initial pairs.
 * Read the existing inventory cache, without a Cartesian product or route calls.
 * Geometry orders inspection only; it never supplies a duration or pruning bound.
 */
export async function bicycleAccessStationCandidates(
  context: Pick<MultimodalContext, 'mobility' | 'now'>,
  point: Place,
  pickup: boolean,
): Promise<BikeStation[]> {
  if (!context.mobility?.bikes.configured || typeof context.mobility.bikes.nearby !== 'function') {
    return [];
  }

  const seen = new Set<string>();

  return (await context.mobility.bikes.nearby(point, BIKE.searchRadius).catch(() => []))
    .filter((station) => {
      const distance = metersBetween(point, station);

      if (
        seen.has(station.id) ||
        !isFreshLookup(station, context.now) ||
        (pickup && !(station.bikes > 0)) ||
        !Number.isFinite(distance) ||
        distance > BIKE.searchRadius
      ) {
        return false;
      }

      seen.add(station.id);

      return true;
    })
    .sort(
      (left, right) =>
        metersBetween(point, left) - metersBetween(point, right) || left.id.localeCompare(right.id),
    );
}

/** Only request-local, already routed walks can be reused when completing a probe. */
export interface BicycleWalkingConnections {
  access?: BaseSegment;
  egress?: BaseSegment;
}

/** Resolve inventory anchors before reserving the complete ride/access/egress routing cost. */
export async function resolveBicycleStationPair(
  context: Pick<MultimodalContext, 'mobility' | 'now'>,
  from: Place,
  to: Place,
  pair?: BicycleStationPair,
): Promise<BicycleStationPair | null> {
  if (!context.mobility?.bikes.configured) {
    return null;
  }

  const inReach = (point: Place, station: BikeStation) => {
    const distance = metersBetween(point, station);

    return Number.isFinite(distance) && distance <= BIKE.searchRadius;
  };

  let [hireStation, dropStation] = pair
    ? [pair.hire, pair.drop]
    : await Promise.all([
        context.mobility.bikes.nearest(from, BIKE.searchRadius, 'bike').catch(() => null),
        context.mobility.bikes.nearest(to, BIKE.searchRadius, 'return').catch(() => null),
      ]);

  // The same closest station at both endpoints does not rule out a useful second station.
  // Inspect a bounded set from the cached inventory, then route exactly one distinct pair.
  if (
    hireStation &&
    dropStation &&
    hireStation.id === dropStation.id &&
    typeof context.mobility.bikes.nearby === 'function'
  ) {
    const [hires, drops] = await Promise.all([
      context.mobility.bikes.nearby(from, BIKE.searchRadius).catch(() => []),
      context.mobility.bikes.nearby(to, BIKE.searchRadius).catch(() => []),
    ]);

    const options = hires
      .filter(
        (station) =>
          station.bikes > 0 && isFreshLookup(station, context.now) && inReach(from, station),
      )
      .slice(0, 8)
      .flatMap((hire) =>
        drops
          .filter(
            (drop) => drop.id !== hire.id && isFreshLookup(drop, context.now) && inReach(to, drop),
          )
          .slice(0, 8)
          .map((drop) => ({
            hire,
            drop,
            accessMeters: metersBetween(from, hire) + metersBetween(to, drop),
          })),
      );

    const distinct = options.sort(
      (left, right) =>
        left.accessMeters - right.accessMeters ||
        left.hire.id.localeCompare(right.hire.id) ||
        left.drop.id.localeCompare(right.drop.id),
    )[0];

    if (distinct) {
      hireStation = distinct.hire;
      dropStation = distinct.drop;
    }
  }

  if (
    !hireStation ||
    !dropStation ||
    hireStation.id === dropStation.id ||
    hireStation.bikes <= 0 ||
    !isFreshLookup(hireStation, context.now) ||
    !isFreshLookup(dropStation, context.now) ||
    !inReach(from, hireStation) ||
    !inReach(to, dropStation)
  ) {
    return null;
  }

  return {
    hire: hireStation,
    drop: dropStation,
  };
}

/** Inventory-only exploration order. These straight-line bounds never supply a route ETA. */
export async function resolveBicycleStationPairs(
  context: Pick<MultimodalContext, 'mobility' | 'now'>,
  from: Place,
  to: Place,
  limit = 3,
): Promise<BicycleStationPair[]> {
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(3, Math.trunc(limit))) : 0;

  if (!maximum || !context.mobility?.bikes.configured) {
    return [];
  }

  const first = await resolveBicycleStationPair(context, from, to);

  const pairs = first ? [first] : [];

  if (pairs.length >= maximum || typeof context.mobility.bikes.nearby !== 'function') {
    return pairs;
  }

  const [nearFrom, nearTo] = await Promise.all([
    context.mobility.bikes.nearby(from, BIKE.searchRadius).catch(() => []),
    context.mobility.bikes.nearby(to, BIKE.searchRadius).catch(() => []),
  ]);

  const eligible = (stations: BikeStation[], point: Place, pickup: boolean) => {
    const seen = new Set<string>();

    return stations
      .filter((station) => {
        const distance = metersBetween(point, station);

        if (
          seen.has(station.id) ||
          !isFreshLookup(station, context.now) ||
          (pickup && !(station.bikes > 0)) ||
          !Number.isFinite(distance) ||
          distance > BIKE.searchRadius
        ) {
          return false;
        }

        seen.add(station.id);

        return true;
      })
      .sort((left, right) => metersBetween(point, left) - metersBetween(point, right))
      .slice(0, 8);
  };

  const costBound = ({ hire, drop }: BicycleStationPair) =>
    metersBetween(from, hire) / 1.2 +
    BIKE.hire +
    metersBetween(hire, drop) / BIKE.speed +
    BIKE.return +
    metersBetween(drop, to) / 1.2;

  const drops = eligible(nearTo, to, false);

  const alternatives = eligible(nearFrom, from, true)
    .flatMap((hire) =>
      drops
        .filter((drop) => drop.id !== hire.id)
        .map((drop) => ({
          hire,
          drop,
        })),
    )
    .sort(
      (left, right) =>
        costBound(left) - costBound(right) ||
        left.hire.id.localeCompare(right.hire.id) ||
        left.drop.id.localeCompare(right.drop.id),
    );

  const key = (pair: BicycleStationPair) => JSON.stringify([pair.hire.id, pair.drop.id]);

  const seen = new Set(pairs.map(key));

  for (const pair of alternatives) {
    if (seen.has(key(pair))) {
      continue;
    }

    seen.add(key(pair));
    pairs.push(pair);

    if (pairs.length >= maximum) {
      break;
    }
  }

  // Preserve the nearest seed and cheapest second comparison. A third slot
  // also checks another return, whose real walking access may be much shorter.
  if (maximum === 3 && pairs.length === 3 && pairs[0].drop.id === pairs[1].drop.id) {
    const differentReturn = alternatives.find((pair) => pair.drop.id !== pairs[0].drop.id);

    if (differentReturn) {
      pairs[2] = differentReturn;
    }
  }

  // A station building or railway can make the nearest geometric pickup a
  // long walk. Keep another stocked pickup as well as the return comparison;
  // three variants of one inaccessible pickup provide no access coverage.
  if (
    maximum === 3 &&
    pairs.length === 3 &&
    pairs.every((pair) => pair.hire.id === pairs[0].hire.id)
  ) {
    const nextPickup = eligible(nearFrom, from, true).find((hire) => hire.id !== pairs[0].hire.id);
    const differentPickup =
      nextPickup && alternatives.find((pair) => pair.hire.id === nextPickup.id);

    if (differentPickup) {
      pairs[2] = differentPickup;
    }
  }

  return pairs;
}

export async function bicycleConnection(
  context: MultimodalContext,
  preferences: MobilityPreferences,
  from: Place,
  to: Place,
  prefix: string,
  pair?: BicycleStationPair,
  walks: BicycleWalkingConnections = {},
): Promise<BaseSegment[] | null> {
  if (!context.provider.bicycle) {
    return null;
  }

  const stations = await resolveBicycleStationPair(context, from, to, pair);

  if (!stations) {
    return null;
  }

  const { hire: hireStation, drop: dropStation } = stations;
  const hire = stationPlace(hireStation),
    drop = stationPlace(dropStation);

  const ride = (
    await context.provider.bicycle(
      {
        origin: hire,
        destination: drop,
      },
      context.budget,
    )
  )[0];

  if (
    !ride ||
    ride.distanceMeters > preferences.maxBicycleMeters ||
    !ride.segments.some((segment) => segment.mode === 'bicycle') ||
    ride.segments.some(
      (segment) =>
        !['bicycle', 'wait'].includes(segment.mode) ||
        (segment.mode === 'bicycle' &&
          (segment.routingProfile !== 'bicycle' || (segment.polyline?.length ?? 0) < 2)),
    )
  ) {
    return null;
  }

  const first = ride.segments.find((segment) => segment.mode === 'bicycle')!,
    last = ride.segments.filter((segment) => segment.mode === 'bicycle').at(-1)!;

  if (
    metersBetween(first.polyline![0], hire) > 75 ||
    metersBetween(last.polyline!.at(-1)!, drop) > 75
  ) {
    return null;
  }

  const accessWalk = (part: 'access' | 'egress', start: Place, end: Place, title: string) => {
    const prepared = walks[part];

    if (!prepared) {
      return walkBetween(context, `${prefix}-${part}`, start, end, title);
    }

    if (
      metersBetween(start, end) < 1 &&
      prepared.distanceMeters === 0 &&
      prepared.durationSeconds.min === 0 &&
      prepared.durationSeconds.max === 0 &&
      samePoint(prepared.start, start) &&
      samePoint(prepared.end, end)
    ) {
      return walkBetween(context, `${prefix}-${part}`, start, end, title);
    }

    // A different station, direction, or origin must never reuse a probe. Keep
    // the same route validation used for a fresh provider response.
    const merged =
      samePoint(prepared.start, start) && samePoint(prepared.end, end)
        ? mergeWalkingRoute(
            totals({
              id: prepared.id,
              title,
              transfers: 0,
              segments: [prepared],
            }),
            `${prefix}-${part}`,
            start,
            end,
            title,
          )
        : null;

    if (!merged) {
      throw new ApiError('NO_ROUTES', '확인한 보행 경로의 연결점이 달라 후보를 제외했어요.', 404);
    }

    return Promise.resolve(merged);
  };

  const [access, egress] = await Promise.all([
    accessWalk('access', from, hire, `${hire.name}까지 걷기`),
    accessWalk('egress', drop, to, `${to.name}까지 걷기`),
  ]);

  const segments: BaseSegment[] = [
    ...(access.distanceMeters > 0 ? [access] : []),
    {
      id: `${prefix}-hire`,
      mode: 'hire',
      title: `${hire.name}에서 대여`,
      instructions: `조회 시 ${hireStation.bikes}대 빌릴 수 있어요. 대여 직전에 재고·이용권·현장 운영을 다시 확인하고 따릉이 앱으로 대여해요.`,
      distanceMeters: 0,
      durationSeconds: {
        min: BIKE.hire,
        max: BIKE.hire,
      },
      start: hire,
      end: hire,
      runAllowed: false,
      bicycleAvailability: {
        source: 'seoul-bike',
        hireStationId: hireStation.id,
        returnStationId: dropStation.id,
        availableBikes: hireStation.bikes,
        receivedAt: hireStation.receivedAt!,
        observedAt: hireStation.observedAt ?? null,
        returnPolicy: 'designated-station',
      },
    },
    ...ride.segments.map((segment) => ({
      ...segment,
      id: `${prefix}-${segment.id}`,
    })),
    {
      id: `${prefix}-return`,
      mode: 'return',
      title: `${drop.name}에 반납`,
      instructions: '거치대에 반납하고 앱의 반납 완료를 확인해요.',
      distanceMeters: 0,
      durationSeconds: {
        min: BIKE.return,
        max: BIKE.return,
      },
      start: drop,
      end: drop,
      runAllowed: false,
    },
    ...(egress.distanceMeters > 0 ? [egress] : []),
  ];

  return hasBicycleAvailabilityEvidence(segments, context.now) ? segments : null;
}

export async function multimodalRoutes(
  request: MultimodalRequest,
  bases: {
    walking: BaseRoute[];
    transit: BaseRoute[];
  },
  context: MultimodalContext,
): Promise<BaseRoute[]> {
  const preferences = request.preferences;

  if (preferences.walkingOnly) {
    return [];
  }

  const routes: BaseRoute[] = footVariants([...bases.walking, ...bases.transit], preferences);
  const driving = context.provider.driving?.bind(context.provider);
  const far = metersBetween(request.origin, request.destination) >= 700;
  const jobs: (() => Promise<BaseRoute | null>)[] = [];

  const primary = context.candidateScope !== 'connections',
    connections = context.candidateScope !== 'primary';
  const taxiAvailable = !!driving && far && preferences.allowTaxi !== false;
  const taxi = primary && taxiAvailable;
  const carLocation = preferences.carLocation;
  const carAvailable =
    !!driving &&
    preferences.hasCar === true &&
    !!carLocation &&
    metersBetween(carLocation, request.destination) >= 100;
  const car = primary && carAvailable;
  const bike =
    !!preferences.allowBicycle &&
    preferences.bicycleReady &&
    !!context.mobility?.bikes.configured &&
    !!context.provider.bicycle;
  const transitTimings = new Map(
    bases.transit.map((route) => [
      route,
      acquisitionTiming(route, context.now, context.acquisitionObjective).total,
    ]),
  );
  const fastestTransit = [...bases.transit].sort(
    (a, b) => transitTimings.get(a)! - transitTimings.get(b)!,
  )[0];

  const parkRide =
    connections && carAvailable && fastestTransit
      ? taxiSplices([fastestTransit], request, context.now, {
          objective: context.acquisitionObjective,
        }).find(
          (value) =>
            value.kind === 'first' &&
            fastestTransit.segments.slice(value.cut).find(isVehicle)?.mode === 'subway',
        )
      : undefined;

  // Place lookups first (no routing budget), so routing calls go out in priority order below.
  const [destinationLot, stationLot, bikeFrom, bikeTo] = await Promise.all([
    car
      ? nearestPublicParking(context, request.destination, 1_500).then(
          (lot) => lot ?? nearestPublicParking(context, request.destination, 3_000),
        )
      : null,
    parkRide ? nearestPublicParking(context, parkRide.point, 700) : null,
    primary && bike
      ? context.mobility!.bikes.nearest(request.origin, BIKE.searchRadius, 'bike').catch(() => null)
      : null,
    primary && bike
      ? context
          .mobility!.bikes.nearest(request.destination, BIKE.searchRadius, 'return')
          .catch(() => null)
      : null,
  ]);

  if (taxi) {
    jobs.push(() =>
      attempt(async () => {
        const segments = await taxiConnection(context, request.origin, request.destination, 'taxi');

        return segments
          ? totals({
              id: 'mm-taxi',
              title: '택시',
              transfers: 0,
              fareWon: segments.find((segment) => segment.mode === 'taxi')?.costWon,
              segments,
              notes: [taxiNote],
            })
          : null;
      }),
    );
  }

  let carAccessPromise: Promise<BaseSegment | null> | undefined;

  const carAccess = () =>
    (carAccessPromise ??= carAvailable
      ? attempt(() =>
          walkBetween(
            context,
            'car-access',
            request.origin,
            carLocation!,
            `${carLocation!.name}에 있는 내 차까지 걷기`,
          ),
        )
      : Promise.resolve(null));

  // Walk to the saved car, then drive to a public lot and walk the rest.
  if (car && destinationLot) {
    jobs.push(() =>
      attempt(async () => {
        const parking = lotPlace(destinationLot);

        const access = await carAccess();

        if (!access) {
          return null;
        }

        const [leg, walk] = await Promise.all([
          driving!(
            {
              origin: carLocation!,
              destination: parking,
            },
            context.budget,
          ),
          walkBetween(
            context,
            'car-walk',
            parking,
            request.destination,
            `${request.destination.name}까지 걷기`,
          ),
        ]);

        const verifiedLot = context.parking?.configured
          ? await context.parking.nearest(
              destinationLot,
              5,
              context.now +
                (access.durationSeconds.max + leg.durationSeconds + PARKING_SECONDS) * 1000,
            )
          : destinationLot;

        if (!verifiedLot || verifiedLot.id !== destinationLot.id) {
          return null;
        }

        const segments = [
          ...(access.distanceMeters > 0 ? [access] : []),
          {
            ...roadSegment('car-drive', 'car', carLocation!, parking, leg),
            parkingAccess: verifiedLot.parkingAccess,
          },
          waitSegment(
            'car-park',
            `${destinationLot.name}에 주차`,
            '공영주차장에 차를 세워요.',
            PARKING_SECONDS,
            parking,
          ),
          ...(walk.distanceMeters > 0 ? [walk] : []),
        ];

        return totals({
          id: 'mm-car',
          title: '자가용',
          transfers: 0,
          fareWon: leg.tollWon || undefined,
          segments,
          notes: [parkingNote(verifiedLot)],
        });
      }),
    );
  }

  if (bikeFrom && bikeTo) {
    jobs.push(() =>
      attempt(async () => {
        const segments = await bicycleConnection(
          context,
          preferences,
          request.origin,
          request.destination,
          'bike',
          {
            hire: bikeFrom,
            drop: bikeTo,
          },
        );

        return segments
          ? totals({
              id: 'mm-bike',
              title: '따릉이',
              transfers: 0,
              segments,
              notes: bicycleNotes(segments, context.now),
            })
          : null;
      }),
    );
  }

  // Only outdoor access before the first vehicle or egress after the last vehicle is replaced.
  // Unknown station interiors and transfer walks never become cycling shortcuts.
  if (connections && bike) {
    const options = bases.transit
      .flatMap((route) => {
        const first = route.segments.findIndex(isVehicle),
          last = route.segments.findLastIndex(isVehicle);

        return route.segments.flatMap((segment, index) =>
          (index < first || index > last) && bikeWorthy(segment, preferences)
            ? [
                {
                  route,
                  segment,
                  index,
                },
              ]
            : [],
        );
      })
      .sort((a, b) => b.segment.durationSeconds.min - a.segment.durationSeconds.min)
      .slice(0, 2);

    for (const { route, segment, index } of options) {
      jobs.push(() =>
        attempt(async () => {
          const start = {
              ...segment.start,
              ...(segment.polyline?.[0] ?? {}),
            },
            end = {
              ...segment.end,
              ...(segment.polyline?.at(-1) ?? {}),
            };

          const connection = await bicycleConnection(
            context,
            preferences,
            start,
            end,
            `${route.id}-bike-${index}`,
          );

          if (!connection) {
            return null;
          }

          const segments = route.segments.flatMap((original, position) =>
            position === index ? connection : [original],
          );
          const hire = connection.find((part) => part.mode === 'hire')!;

          return totals({
            ...route,
            id: `${route.id}:bike-${index}`,
            title: multimodalTitle(segments),
            segments,
            notes: [
              ...(route.notes ?? []),
              ...bicycleNotes(connection, context.now),
              ...stationAnchorNote(route, start, hire.id),
              ...stationAnchorNote(route, end, hire.id),
            ],
          });
        }),
      );
    }
  }

  // Park and ride: drive to a public lot at a subway station and continue by train.
  if (parkRide && stationLot && fastestTransit) {
    jobs.push(() =>
      attempt(async () => {
        const parking = lotPlace(stationLot);

        const access = await carAccess();

        if (!access) {
          return null;
        }

        const [leg, walk] = await Promise.all([
          driving!(
            {
              origin: carLocation!,
              destination: parking,
            },
            context.budget,
          ),
          walkBetween(
            context,
            `${fastestTransit.id}-park-walk`,
            parking,
            parkRide.point,
            `${parkRide.point.name}까지 걷기`,
          ),
        ]);

        const verifiedLot = context.parking?.configured
          ? await context.parking.nearest(
              stationLot,
              5,
              context.now +
                (access.durationSeconds.max + leg.durationSeconds + PARKING_SECONDS) * 1000,
            )
          : stationLot;

        if (!verifiedLot || verifiedLot.id !== stationLot.id) {
          return null;
        }

        const segments = [
          ...(access.distanceMeters > 0
            ? [
                {
                  ...access,
                  id: `${fastestTransit.id}-car-access`,
                },
              ]
            : []),
          {
            ...roadSegment(`${fastestTransit.id}-car`, 'car', carLocation!, parking, leg),
            parkingAccess: verifiedLot.parkingAccess,
          },
          waitSegment(
            `${fastestTransit.id}-park`,
            `${stationLot.name}에 주차`,
            '공영주차장에 차를 세우고 역으로 가요.',
            PARKING_SECONDS,
            parking,
          ),
          ...(walk.distanceMeters > 0 ? [walk] : []),
          ...fastestTransit.segments.slice(parkRide.cut),
        ];

        const transfers = Math.max(0, segments.filter(isVehicle).length - 1);

        return totals({
          id: `${fastestTransit.id}:park-ride`,
          title: multimodalTitle(segments),
          transfers,
          fareWon: fastestTransit.fareWon,
          segments,
          notes: [
            parkingNote(verifiedLot),
            ...stationAnchorNote(
              fastestTransit,
              parkRide.point,
              segments.find((part) => part.mode === 'car')!.id,
            ),
          ],
        });
      }),
    );
  }

  if (connections && taxiAvailable) {
    for (const splice of taxiSplices(bases.transit, request, context.now, {
      objective: context.acquisitionObjective,
    })) {
      jobs.push(() =>
        attempt(async () => {
          const { route, kind, cut, point } = splice;

          const ride = await taxiConnection(
            context,
            kind === 'first' ? request.origin : point,
            kind === 'first' ? point : request.destination,
            `${route.id}-taxi-${kind}-${cut}`,
          );

          if (!ride) {
            return null;
          }

          const segments =
            kind === 'first'
              ? [...ride, ...route.segments.slice(cut)]
              : [...route.segments.slice(0, cut), ...ride];
          const transfers = Math.max(0, segments.filter(isVehicle).length - 1);
          const taxi = ride.find((segment) => segment.mode === 'taxi')!;

          return totals({
            id: `${route.id}:taxi-${kind}-${cut}`,
            title: multimodalTitle(segments),
            transfers,
            fareWon: (route.fareWon ?? 0) + (taxi.costWon ?? 0) || undefined,
            segments,
            notes: [...(route.notes ?? []), taxiNote, ...stationAnchorNote(route, point, taxi.id)],
          });
        }),
      );
    }
  }

  for (const job of jobs) {
    if (context.budget.remaining === 0) {
      break;
    }

    const route = await job();

    if (route) {
      routes.push(route);
    }
  }

  return routes;
}
