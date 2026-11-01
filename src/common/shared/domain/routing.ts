import {
  scheduledArrivalAt,
  scheduledDepartures,
  timetableIsFresh,
  timetableMatchesSegment,
} from './subwayTimetable.js';
import { estimateBaseTimeline, type RoutingObjective } from './estimatedTiming.js';
import { compareRouteEffort, routeEffort } from './routeEffort.js';
import { REALTIME_BOARDING_BUFFER_SECONDS } from './waitEstimates.js';
import { listedDepartures, liveDepartureRange, unlistedWaitRange } from './liveBoarding.js';
import { recommendableVehicles, validLiveVehicles } from './vehicleConstraints.js';
import { withWalkingOnly } from './mobilityPreferences.js';
import { DEMO_TEMPLATES, PLACES, type DemoTemplate } from './fixtures.js';
import {
  PlanningError,
  type BasePlanningRequest,
  type BaseRoute,
  type BaseSegment,
  type Connection,
  type DurationRange,
  type MobilityPreferences,
  type Place,
  type PlanningRequest,
  type PlanningPurpose,
  type PlanningResult,
  type Provenance,
  type ReplanReason,
  type Risk,
  type Route,
  type Segment,
  type TimeRange,
} from './types.js';

const SECOND = 1000;
const BOARDING_PREPARATION_SECONDS = 30;

export function searchPlaces(query: string): Place[] {
  const text = query.trim().toLocaleLowerCase();

  return PLACES.filter(
    (place) => !text || `${place.name} ${place.address}`.toLocaleLowerCase().includes(text),
  );
}

export function validatePreferences(preferences: MobilityPreferences): void {
  if (
    !preferences ||
    typeof preferences.allowRunning !== 'boolean' ||
    typeof preferences.allowBicycle !== 'boolean' ||
    typeof preferences.bicycleReady !== 'boolean' ||
    (preferences.walkingOnly !== undefined && typeof preferences.walkingOnly !== 'boolean') ||
    [
      preferences.allowTaxi,
      preferences.allowScooter,
      preferences.allowEbike,
      preferences.hasScooterLicense,
      preferences.hasCar,
    ].some((value) => value !== undefined && typeof value !== 'boolean')
  ) {
    throw new PlanningError('INVALID_INPUT', '이동수단 사용 조건을 확인해 주세요.');
  }

  for (const [value, upper, label] of [
    [preferences.maxRunningMeters, 5000, '총 달리기 거리'],
    [preferences.maxBicycleMeters, 10000, '총 자전거 거리'],
    [preferences.preparationSeconds, 3600, '도착 준비 여유'],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > upper) {
      throw new PlanningError('INVALID_INPUT', `${label} 입력이 허용 범위를 벗어났어요.`);
    }
  }

  if (preferences.runningPace !== 'easy' && preferences.runningPace !== 'steady') {
    throw new PlanningError('INVALID_INPUT', '달리기 페이스를 확인해 주세요.');
  }
}

function validateTime(
  request: {
    now: number;
    deadline: number;
    preferences: MobilityPreferences;
  },
  allowElapsedDeadline = false,
  deadlineValidationTime = request.now,
): void {
  validatePreferences(request.preferences);

  if (!Number.isFinite(request.now) || !Number.isFinite(request.deadline)) {
    throw new PlanningError('INVALID_INPUT', '현재 시각과 도착 마감 시각을 확인해 주세요.');
  }

  if (!Number.isFinite(deadlineValidationTime) || deadlineValidationTime > request.now) {
    throw new PlanningError('INVALID_INPUT', '경로 요청의 수락 시각을 확인해 주세요.');
  }

  if (!allowElapsedDeadline && request.deadline <= request.now) {
    throw new PlanningError(
      'INVALID_INPUT',
      '도착 마감이 지났어요. 원래 마감을 유지하려면 긴급 길찾기를 선택해 주세요.',
    );
  }

  if (Math.abs(request.deadline - deadlineValidationTime) > 48 * 60 * 60 * SECOND) {
    throw new PlanningError(
      'INVALID_INPUT',
      'MVP에서는 현재와 48시간 이내인 도착 마감으로 검색해 주세요.',
    );
  }
}

function acceptsElapsedDeadline(purpose?: PlanningPurpose): boolean {
  if (
    purpose !== undefined &&
    purpose !== 'search' &&
    purpose !== 'urgent' &&
    purpose !== 'replan'
  ) {
    throw new PlanningError('INVALID_INPUT', '경로 검색 방식을 확인해 주세요.');
  }

  return purpose === 'urgent' || purpose === 'replan';
}

function resolveTemplate(request: PlanningRequest): DemoTemplate {
  const template = DEMO_TEMPLATES.find(
    (candidate) =>
      candidate.originId === request.originId && candidate.destinationId === request.destinationId,
  );

  if (!template) {
    throw new PlanningError(
      'UNSUPPORTED_PAIR',
      '이 출발지와 목적지 조합의 경로는 아직 없어요. 세 가지 시연 구간 중 하나를 선택해 주세요.',
    );
  }

  return template;
}

function demoProvenance(anchorAt: number, receivedAt: number): Provenance {
  return {
    mode: 'demo',
    provider: '지각지도 가정 시나리오',
    label: '가정한 시연 데이터',
    sourceTimestamp: anchorAt,
    receivedAt,
    isRealtime: false,
  };
}

function point(template: DemoTemplate, id: string, name: string, fraction: number): Place {
  const origin = PLACES.find((place) => place.id === template.originId)!;
  const destination = PLACES.find((place) => place.id === template.destinationId)!;

  return {
    id: `${template.id}:${id}`,
    name,
    address: '실제 위치·경로가 검증되지 않은 시연 지점',
    latitude: origin.latitude + (destination.latitude - origin.latitude) * fraction,
    longitude: origin.longitude + (destination.longitude - origin.longitude) * fraction,
    note: '화면 흐름 설명용 가정 좌표. 실제 길안내에 사용하지 마세요.',
  };
}

function footDuration(
  meters: number,
  walking: DurationRange,
  running: boolean,
  pace: MobilityPreferences['runningPace'],
): DurationRange {
  if (!running) {
    return walking;
  }

  // Design values only: include a residual stop/crossing allowance, no pace accuracy claim.
  const secondsPerMeter =
    pace === 'easy'
      ? {
          min: 0.43,
          max: 0.65,
        }
      : {
          min: 0.36,
          max: 0.52,
        };

  return {
    min: Math.min(walking.min, Math.ceil(meters * secondsPerMeter.min + 45)),
    max: Math.min(walking.max, Math.ceil(meters * secondsPerMeter.max + 75)),
  };
}

function baseSegment(
  id: string,
  mode: BaseSegment['mode'],
  title: string,
  start: Place,
  end: Place,
  distanceMeters: number,
  durationSeconds: DurationRange,
  instructions: string,
  runAllowed = false,
): BaseSegment {
  return {
    id,
    mode,
    title,
    start,
    end,
    distanceMeters,
    durationSeconds,
    instructions,
    runAllowed,
  };
}

function demoSteps(
  template: DemoTemplate,
  preferences: MobilityPreferences,
  accessRunning: boolean,
  finalRunning: boolean,
  bicycle: boolean,
): BaseSegment[] {
  const origin = PLACES.find((place) => place.id === template.originId)!;
  const destination = PLACES.find((place) => place.id === template.destinationId)!;
  const entrance = point(
    template,
    'entrance',
    template.mode === 'subway' ? '시연 역 입구' : '시연 정류장',
    0.2,
  );
  const boarding = point(
    template,
    'boarding',
    template.mode === 'subway' ? '시연 승강장' : '시연 승차 지점',
    0.23,
  );
  const alighting = point(template, 'alighting', '시연 하차 지점', 0.85);
  const steps: BaseSegment[] = [];

  if (bicycle && template.bicycle) {
    const bike = template.bicycle;
    const hirePoint = point(template, 'hire', '시연 대여 지점', 0.04);
    const returnPoint = point(template, 'return', '시연 반납 지점', 0.2);

    steps.push(
      baseSegment(
        `${template.id}:bike-approach`,
        'walk',
        '대여 지점까지 걷기',
        origin,
        hirePoint,
        bike.approachMeters,
        bike.approachSeconds,
        '가정한 대여 지점까지 이동해요.',
        true,
      ),
      baseSegment(
        `${template.id}:hire`,
        'hire',
        '자전거 대여 준비',
        hirePoint,
        hirePoint,
        0,
        bike.hireSeconds,
        '이용권·앱 준비와 자전거 상태를 직접 확인해요. 예약된 자전거가 아니에요.',
      ),
      baseSegment(
        `${template.id}:bicycle`,
        'bicycle',
        '자전거로 접근',
        hirePoint,
        returnPoint,
        bike.meters,
        bike.rideSeconds,
        '가정한 자전거 구간이에요. 실제 주행 경로는 검증되지 않았어요.',
      ),
      baseSegment(
        `${template.id}:return`,
        'return',
        '자전거 반납 확인',
        returnPoint,
        returnPoint,
        0,
        bike.returnSeconds,
        '반납 완료를 직접 확인한 뒤 역으로 이동해요.',
      ),
      baseSegment(
        `${template.id}:entry`,
        'entry',
        '역 진입 · 승강장 이동',
        returnPoint,
        boarding,
        template.entryMeters,
        bike.entrySeconds,
        '역 내부는 걷기만 계산해요.',
      ),
    );
  } else {
    const access = baseSegment(
      `${template.id}:access`,
      accessRunning ? 'run' : 'walk',
      accessRunning ? '승차 지점까지 가볍게 달리기' : '승차 지점까지 걷기',
      origin,
      entrance,
      template.accessMeters,
      footDuration(
        template.accessMeters,
        template.accessSeconds,
        accessRunning,
        preferences.runningPace,
      ),
      '가정한 야외 접근 구간이에요. 신호와 이동 규칙을 지켜요.',
      true,
    );

    access.walkingDurationSeconds = template.accessSeconds;

    steps.push(access);

    if (template.entrySeconds.max > 0) {
      steps.push(
        baseSegment(
          `${template.id}:entry`,
          'entry',
          '역 진입 · 승강장 이동',
          entrance,
          boarding,
          template.entryMeters,
          template.entrySeconds,
          '역 내부·계단은 달리기에서 제외하고 걸어요.',
        ),
      );
    }
  }

  const vehicle = baseSegment(
    `${template.id}:vehicle`,
    template.mode,
    template.mode === 'subway' ? '시연 지하철 A' : '시연 버스 A',
    boarding,
    alighting,
    template.rideMeters,
    template.rideSeconds,
    '실제 노선·시간표가 아닌 연결 계산용 가정 차량이에요.',
  );

  vehicle.lineName = template.mode === 'subway' ? '가정 노선 A' : '가정 버스 A';
  vehicle.direction = '시연 목적지 방향';

  steps.push(vehicle);

  const final = baseSegment(
    `${template.id}:final`,
    finalRunning ? 'run' : 'walk',
    finalRunning ? '목적지까지 가볍게 달리기' : '목적지까지 걷기',
    alighting,
    destination,
    template.finalMeters,
    footDuration(
      template.finalMeters,
      template.finalSeconds,
      finalRunning,
      preferences.runningPace,
    ),
    '건물 입구와 내부 이동은 확인되지 않았어요. 준비 여유를 더해 판단해요.',
    true,
  );

  final.walkingDurationSeconds = template.finalSeconds;

  steps.push(final);

  return steps;
}

function calculateDemoSegments(
  steps: BaseSegment[],
  template: DemoTemplate,
  now: number,
  anchor: number,
  provenance: Provenance,
  missedDepartureAt?: number,
  activeSegmentId?: string,
): Segment[] {
  const segments: Segment[] = [];
  let clock: TimeRange = {
    earliest: now,
    latest: now,
  };

  for (const step of steps) {
    if (step.mode === 'wait') {
      continue;
    }

    if ((step.mode === 'bus' || step.mode === 'subway') && step.id !== activeSegmentId) {
      const schedule = template.departureOffsetsSeconds
        .map((offset) => anchor + offset * SECOND)
        .filter((departure) => missedDepartureAt === undefined || departure > missedDepartureAt);
      const earliestDeparture = schedule.find(
        (departure) => departure >= clock.earliest + BOARDING_PREPARATION_SECONDS * SECOND,
      );
      const latestDeparture = schedule.find(
        (departure) => departure >= clock.latest + BOARDING_PREPARATION_SECONDS * SECOND,
      );

      if (earliestDeparture === undefined || latestDeparture === undefined) {
        throw new PlanningError(
          'NO_DEMO_SERVICE',
          '남아 있는 가정 시간표로는 승차를 계산할 수 없어요. 시연 구간을 새로 검색해 주세요.',
        );
      }

      const borderline = earliestDeparture !== latestDeparture;
      const nextDeparture = schedule.find((departure) => departure > earliestDeparture);
      const connection: Connection = {
        departureAt: earliestDeparture,
        fallbackDepartureAt: borderline ? latestDeparture : nextDeparture,
        status: borderline ? 'borderline' : 'comfortable',
        boardingMarginSeconds:
          Math.floor((earliestDeparture - clock.latest) / SECOND) - BOARDING_PREPARATION_SECONDS,
        explanation: borderline
          ? '접근 시간의 느린 경우에는 첫 편을 놓쳐요. 다음 가정 차량 도착을 늦은 예상에 포함했어요.'
          : '느린 접근 시간과 30초 승차 준비를 포함해도 가정 차량에 연결돼요.',
      };
      const wait: Segment = {
        ...baseSegment(
          `${step.id}:wait`,
          'wait',
          borderline ? '승차가 촉박함 · 다음 편 확인' : '승차 대기',
          step.start,
          step.start,
          0,
          {
            min: Math.max(0, (earliestDeparture - clock.latest) / SECOND),
            max: Math.max(0, (latestDeparture - clock.earliest) / SECOND),
          },
          connection.explanation,
        ),
        timeRange: {
          earliest: earliestDeparture,
          latest: latestDeparture,
        },
        provenance,
        connection,
      };

      segments.push(wait);

      clock = {
        earliest: earliestDeparture + step.durationSeconds.min * SECOND,
        latest: latestDeparture + step.durationSeconds.max * SECOND,
      };

      segments.push({
        ...step,
        timeRange: {
          ...clock,
        },
        provenance,
        connection,
      });
    } else {
      clock = {
        earliest: clock.earliest + step.durationSeconds.min * SECOND,
        latest: clock.latest + step.durationSeconds.max * SECOND,
      };

      segments.push({
        ...step,
        timeRange: {
          ...clock,
        },
        provenance,
      });
    }
  }

  const last = segments[segments.length - 1];

  if (last) {
    for (const segment of segments) {
      if (segment.connection?.status === 'borderline') {
        segment.connection.fallbackArrivalAt = last.timeRange.latest;
      }
    }
  }

  return segments;
}

function finishRoute(
  id: string,
  title: string,
  segments: Segment[],
  request: {
    now: number;
    deadline: number;
    preferences: MobilityPreferences;
  },
  provenance: Provenance,
  risks: Risk[],
  reasons: string[],
): Route {
  const arrivalTime = segments[segments.length - 1]?.timeRange ?? {
    earliest: request.now,
    latest: request.now,
  };
  const preparation = request.preferences.preparationSeconds * SECOND;
  const readyTime = {
    earliest: arrivalTime.earliest + preparation,
    latest: arrivalTime.latest + preparation,
  };
  const route: Route = {
    id,
    title,
    segments,
    origin: segments[0].start,
    destination: segments[segments.length - 1].end,
    arrivalTime: {
      ...arrivalTime,
    },
    readyTime,
    durationSeconds: {
      min: (arrivalTime.earliest - request.now) / SECOND,
      max: (arrivalTime.latest - request.now) / SECOND,
    },
    marginSeconds: {
      min: Math.floor((request.deadline - readyTime.latest) / SECOND),
      max: Math.floor((request.deadline - readyTime.earliest) / SECOND),
    },
    runningMeters: segments
      .filter((segment) => segment.mode === 'run')
      .reduce((total, segment) => total + segment.distanceMeters, 0),
    bicycleMeters: segments
      .filter((segment) => segment.mode === 'bicycle')
      .reduce((total, segment) => total + segment.distanceMeters, 0),
    bicycleRentals: segments.filter(
      (segment, index) =>
        segment.mode === 'hire' &&
        segments.slice(index + 1).find((next) => next.mode !== 'wait')?.mode === 'bicycle',
    ).length,
    transfers: Math.max(
      0,
      segments.filter((segment) => segment.mode === 'bus' || segment.mode === 'subway').length - 1,
    ),
    risks,
    reasons,
    status:
      readyTime.latest <= request.deadline
        ? 'on-time'
        : readyTime.earliest <= request.deadline
          ? 'uncertain'
          : 'late',
    provenance,
    recommended: false,
  };

  return route;
}

function demoRisks(segments: Segment[], bicycle: boolean): Risk[] {
  const risks: Risk[] = [
    {
      code: 'demo-data',
      severity: 'info',
      title: '가정한 시연 데이터',
      description:
        '거리·시간·차량·대여소는 기능 설명용 가정이에요. 실제 길안내·운행·재고 정보가 아니에요.',
    },
    {
      code: 'destination-entry',
      severity: 'info',
      title: '목적지 입구 확인 필요',
      description:
        '건물 입구와 내부 이동은 검증되지 않았어요. 설정한 준비 여유를 도착 판단에 더했어요.',
    },
  ];
  const boarding = segments.find(
    (segment) =>
      (segment.mode === 'bus' || segment.mode === 'subway') &&
      segment.connection?.status === 'borderline',
  );

  if (boarding) {
    risks.push({
      code: 'borderline-boarding',
      severity: 'warning',
      title: '승차가 촉박함',
      description: '첫 편을 놓친 경우의 다음 가정 차량을 도착 범위의 늦은 값에 포함했어요.',
      segmentId: boarding.id,
    });
  }

  if (bicycle) {
    risks.push({
      code: 'bicycle-stock',
      severity: 'warning',
      title: '실제 자전거 재고 미확인',
      description:
        '시연에서는 3대가 있다고 가정해요. 대여를 예약하거나 실제 재고를 확인한 결과가 아니에요. 자전거가 없으면 걷기로 다시 계산해요.',
    });
  }

  return risks;
}

function withinPreferences(route: Route, preferences: MobilityPreferences): boolean {
  return (
    (!preferences.walkingOnly ||
      (route.segments.some((segment) => segment.mode === 'walk' || segment.mode === 'entry') &&
        route.segments.every(
          (segment) =>
            segment.mode === 'walk' ||
            segment.mode === 'entry' ||
            (segment.mode === 'wait' && segment.distanceMeters === 0 && !segment.connection),
        ))) &&
    (!route.runningMeters || preferences.allowRunning) &&
    route.runningMeters <= preferences.maxRunningMeters &&
    (!route.bicycleMeters || (preferences.allowBicycle && preferences.bicycleReady)) &&
    route.bicycleMeters <= preferences.maxBicycleMeters &&
    (preferences.allowTaxi !== false ||
      !route.segments.some((segment) => segment.mode === 'taxi')) &&
    ((preferences.allowScooter !== false && preferences.hasScooterLicense !== false) ||
      !route.segments.some((segment) => segment.mode === 'scooter')) &&
    (preferences.allowEbike !== false ||
      !route.segments.some((segment) => segment.mode === 'ebike')) &&
    (preferences.hasCar === true || !route.segments.some((segment) => segment.mode === 'car')) &&
    (route.provenance.mode !== 'live' ||
      validLiveVehicles(
        route.segments,
        preferences,
        route.origin,
        route.arrivalTime.earliest - route.durationSeconds.min * SECOND,
      ))
  );
}

const PUBLIC_TRANSPORT_MODES = ['walk', 'run', 'entry', 'wait', 'bus', 'subway'];
/** Vehicle modes with their own results tab, as the app compares them; an all-foot route is the walking tab. */
export const TAB_MODES = ['subway', 'bus', 'bicycle', 'ebike', 'scooter', 'taxi', 'car'] as const;
export type TabMode = (typeof TAB_MODES)[number];

/** The results tab whose vehicle is the only one a route rides (walking, gates and waits are free): the tab shows that
 * mode's own minutes. A route with two vehicles, or none, is pure for no tab. */
function pureTabsOf(route: Route): string[] {
  const own = TAB_MODES.filter((mode) => route.segments.some((segment) => segment.mode === mode));
  return own.length === 1 ? own : [];
}

/** The results tabs a route is listed under. */
function tabsOf(route: Route): string[] {
  return [
    ...TAB_MODES.filter((mode) => route.segments.some((segment) => segment.mode === mode)),
    ...(route.segments.every((segment) => ['walk', 'run', 'entry', 'wait'].includes(segment.mode))
      ? ['walk']
      : []),
  ];
}

function family(route: Route): string {
  const modes = new Set(route.segments.map((segment) => segment.mode));

  return modes.has('car')
    ? 'car'
    : modes.has('taxi')
      ? 'taxi'
      : modes.has('scooter')
        ? 'scooter'
        : modes.has('ebike')
          ? 'ebike'
          : modes.has('bicycle')
            ? 'bike'
            : modes.has('bus') && modes.has('subway')
              ? 'transit-mixed'
              : modes.has('bus')
                ? 'bus'
                : modes.has('subway')
                  ? 'subway'
                  : 'foot';
}

/** Fastest first, but at most two per mode family so taxi variants cannot crowd out a car or subway. */
function diverse(routes: Route[], limit: number): Route[] {
  const counts = new Map<string, number>();
  const picked: Route[] = [];

  for (const route of routes) {
    const key = family(route);

    if ((counts.get(key) ?? 0) >= 2) {
      continue;
    }

    counts.set(key, (counts.get(key) ?? 0) + 1);

    picked.push(route);

    if (picked.length === limit) {
      return picked;
    }
  }

  for (const route of routes) {
    if (picked.length < limit && !picked.includes(route)) {
      picked.push(route);
    }
  }

  return picked.sort((a, b) => routes.indexOf(a) - routes.indexOf(b));
}

function selectRoutes(
  routes: Route[],
  preserveWalkingFallback = false,
  limit = 3,
  objective: RoutingObjective = 'conservative-arrival',
  now = 0,
): Route[] {
  const point = new Map(
    routes.map((route) => [
      route.id,
      estimateBaseTimeline(route.segments, now)?.arrivalAt ?? Infinity,
    ]),
  );

  const compareTime = (a: Route, b: Route) =>
    (objective === 'estimated-arrival' ? point.get(a.id)! - point.get(b.id)! : 0) ||
    a.readyTime.latest - b.readyTime.latest;

  const compare = (a: Route, b: Route) =>
    compareTime(a, b) ||
    compareRouteEffort(a, b) ||
    a.risks.filter((risk) => risk.severity === 'warning').length -
      b.risks.filter((risk) => risk.severity === 'warning').length ||
    a.id.localeCompare(b.id);

  // Remove pointless same-outcome effort; never claim that faster access saved total time.
  // A route that depends on finding a vehicle (a taxi, a scooter nobody has located) is a
  // different bargain, so it never removes a bike or a run the rider can count on.
  const useful = routes.filter(
    (route) =>
      !routes.some(
        (other) =>
          other.id !== route.id &&
          // Expanded live results compare transport choices even when one is slower.
          // A time/effort comparison alone cannot price fares, comfort or vehicle access.
          !(limit > 3 && route.provenance.mode === 'live' && family(other) !== family(route)) &&
          !other.risks.some((risk) => risk.code === 'vehicle-availability') &&
          (objective !== 'estimated-arrival' || point.get(other.id)! <= point.get(route.id)!) &&
          other.readyTime.earliest <= route.readyTime.earliest &&
          other.readyTime.latest <= route.readyTime.latest &&
          other.runningMeters <= route.runningMeters &&
          other.segments.filter((segment) => segment.mode === 'hire').length <=
            route.segments.filter((segment) => segment.mode === 'hire').length &&
          other.transfers <= route.transfers &&
          (other.runningMeters < route.runningMeters ||
            other.segments.filter((segment) => segment.mode === 'hire').length <
              route.segments.filter((segment) => segment.mode === 'hire').length),
      ),
  );

  useful.sort(compare);

  const selected = limit > 3 ? diverse(useful, limit) : useful.slice(0, limit);
  const pinned = new Set(useful.slice(0, 1));

  if (limit > 3) {
    // With taxis and cars competing, keep the fastest bus/subway-only option visible.
    const transitOnly = useful.find(
      (route) =>
        route.segments.some((segment) => segment.mode === 'bus' || segment.mode === 'subway') &&
        route.segments.every((segment) => PUBLIC_TRANSPORT_MODES.includes(segment.mode)),
    );

    if (transitOnly && !selected.includes(transitOnly)) {
      selected[selected.length - 1] = transitOnly;
    }
    if (transitOnly) pinned.add(transitOnly);
  }

  // Keep the minimum physical-effort option available if faster combinations occupy all slots.
  const leastEffort = [...useful].sort(
    (a, b) => routeEffort(a) - routeEffort(b) || compareTime(a, b),
  )[0];

  if (selected.length > 1 && leastEffort && !selected.includes(leastEffort)) {
    selected[limit > 3 ? Math.max(1, selected.length - 2) : selected.length - 1] = leastEffort;
  }
  if (leastEffort) pinned.add(leastEffort);

  if (preserveWalkingFallback) {
    // A provider walking route needs no vehicle connection. Do not synthesize one
    // from transit access geometry when the walking request failed.
    const walking = useful.find(
      (route) =>
        route.segments.some((segment) => segment.mode === 'walk') &&
        route.segments.every(
          (segment) =>
            segment.mode === 'walk' || segment.mode === 'entry' || segment.mode === 'wait',
        ),
    );

    if (selected.length > 1 && walking && !selected.includes(walking)) {
      selected[selected.length - 1] = walking;
    }
    if (walking) pinned.add(walking);
  }

  if (limit > 3) {
    // Every results tab with a route keeps its fastest one. It replaces the slowest listed route
    // that no other tab depends on; the fastest route and the picks above are never replaced.
    const tabs = new Map(useful.map((route) => [route, tabsOf(route)]));
    const listed = (tab: string) => selected.filter((route) => tabs.get(route)!.includes(tab));
    for (const tab of [...TAB_MODES, 'walk']) {
      const best = useful.find((route) => tabs.get(route)!.includes(tab));
      if (!best || listed(tab).length) continue;
      const replaced = [...selected]
        .sort(compare)
        .reverse()
        .find(
          (route) =>
            !pinned.has(route) && tabs.get(route)!.every((other) => listed(other).length > 1),
        );
      if (!replaced) continue;
      selected[selected.indexOf(replaced)] = best;
      pinned.add(best);
    }
    // A tab also keeps its fastest pure route when only mixtures with that vehicle are listed: its minutes are the
    // mode's own, not a taxi's with a few bike minutes before it. It replaces a listed route no tab depends on.
    const pure = new Map(useful.map((route) => [route, pureTabsOf(route)]));
    const listedPure = (tab: string) => selected.filter((route) => pure.get(route)!.includes(tab));
    for (const tab of TAB_MODES) {
      const best = useful.find((route) => pure.get(route)!.includes(tab));
      if (!best || listedPure(tab).length) continue;
      const replaced = [...selected]
        .sort(compare)
        .reverse()
        .find(
          (route) =>
            !pinned.has(route) &&
            tabs.get(route)!.every((other) => listed(other).length > 1) &&
            pure.get(route)!.every((other) => listedPure(other).length > 1),
        );
      if (!replaced) continue;
      selected[selected.indexOf(replaced)] = best;
      pinned.add(best);
    }
  }

  selected.sort(compare);

  const recommended = selected.find(recommendableVehicles);

  selected.forEach((route) => {
    route.recommended = route === recommended;
  });

  return selected;
}

function makeResult(
  routes: Route[],
  now: number,
  anchor: number,
  provenance: Provenance,
  notice: string,
  purpose?: PlanningPurpose,
  limit = 3,
  objective: RoutingObjective = 'conservative-arrival',
): PlanningResult {
  const preserveWalking =
    provenance.mode === 'live' && (purpose === 'urgent' || purpose === 'replan');

  return {
    routes: selectRoutes(routes, preserveWalking, limit, objective, now),
    generatedAt: now,
    scheduleAnchorAt: anchor,
    provenance,
    allLate: routes.length > 0 && routes.every((route) => route.status === 'late'),
    notice,
  };
}

export function searchRoutes(request: PlanningRequest): PlanningResult {
  validateTime(request, acceptsElapsedDeadline(request.purpose));

  const template = resolveTemplate(request);
  const anchor = request.scheduleAnchorAt ?? request.now;

  if (!Number.isFinite(anchor) || anchor > request.now) {
    throw new PlanningError('INVALID_INPUT', '시연 기준 시각이 현재보다 뒤에 있어요.');
  }

  const provenance = demoProvenance(anchor, request.now);
  const preferences = request.preferences;
  const variants: {
    accessRunning: boolean;
    finalRunning: boolean;
    bicycle: boolean;
  }[] = preferences.walkingOnly
    ? []
    : [
        {
          accessRunning: false,
          finalRunning: false,
          bicycle: false,
        },
      ];

  if (!preferences.walkingOnly && preferences.allowRunning) {
    variants.push(
      {
        accessRunning: true,
        finalRunning: false,
        bicycle: false,
      },
      {
        accessRunning: false,
        finalRunning: true,
        bicycle: false,
      },
      {
        accessRunning: true,
        finalRunning: true,
        bicycle: false,
      },
    );
  }

  if (
    !preferences.walkingOnly &&
    preferences.allowBicycle &&
    preferences.bicycleReady &&
    template.bicycle
  ) {
    variants.push({
      accessRunning: false,
      finalRunning: false,
      bicycle: true,
    });

    if (preferences.allowRunning) {
      variants.push({
        accessRunning: false,
        finalRunning: true,
        bicycle: true,
      });
    }
  }

  const routes: Route[] = [];

  for (const variant of variants) {
    try {
      const steps = demoSteps(
        template,
        preferences,
        variant.accessRunning,
        variant.finalRunning,
        variant.bicycle,
      );
      const segments = calculateDemoSegments(
        steps,
        template,
        request.now,
        anchor,
        provenance,
        request.missedDepartureAt,
      );
      const id = `${template.id}:${variant.bicycle ? 'bike' : variant.accessRunning ? 'run' : 'walk'}:${variant.finalRunning ? 'run' : 'walk'}`;
      const reasons = variant.bicycle
        ? [
            `자전거 ${template.bicycle!.meters}m와 대여·반납·역 진입, 후속 가정 차량을 모두 포함했어요.${variant.finalRunning ? ` 하차 후 야외 ${template.finalMeters}m 달리기도 포함해요.` : ''}`,
          ]
        : variant.accessRunning && variant.finalRunning
          ? [
              `승차 전·하차 후 야외 구간에서 총 ${template.accessMeters + template.finalMeters}m를 달리는 가정 후보예요. 시간표 연결을 다시 계산했어요.`,
            ]
          : variant.accessRunning
            ? [
                `승차 전 야외 ${template.accessMeters}m 달리기를 포함하고 가정 시간표 연결을 다시 계산했어요.`,
              ]
            : variant.finalRunning
              ? [
                  `하차 후 야외 ${template.finalMeters}m 달리기를 포함한 경로예요. 승차 전 접근은 걸어요.`,
                ]
              : ['달리기 없이 이동하는 기준 경로예요.'];
      const route = finishRoute(
        id,
        variant.bicycle
          ? '자전거 + 지하철'
          : variant.accessRunning || variant.finalRunning
            ? '가벼운 달리기 + 대중교통'
            : '걷기 + 대중교통',
        segments,
        request,
        provenance,
        demoRisks(segments, variant.bicycle),
        reasons,
      );

      if (withinPreferences(route, preferences)) {
        routes.push(route);
      }
    } catch (error) {
      if (!(error instanceof PlanningError) || error.code !== 'NO_DEMO_SERVICE') {
        throw error;
      }
    }
  }

  const origin = PLACES.find((place) => place.id === template.originId)!;
  const destination = PLACES.find((place) => place.id === template.destinationId)!;
  const walkingStep = baseSegment(
    `${template.id}:all-walk`,
    'walk',
    '목적지까지 걷기',
    origin,
    destination,
    template.walkingMeters,
    template.walkingSeconds,
    '전체 도보 시간도 기능 비교를 위한 가정이에요.',
    true,
  );
  const walkingSegments = calculateDemoSegments(
    [walkingStep],
    template,
    request.now,
    anchor,
    provenance,
  );

  routes.push(
    finishRoute(
      `${template.id}:all-walk`,
      '걷기만 이용',
      walkingSegments,
      request,
      provenance,
      demoRisks(walkingSegments, false),
      ['승차와 대여가 필요 없는 기준 경로예요.'],
    ),
  );

  const baseline = routes.find((route) => route.id === `${template.id}:walk:walk`);

  if (baseline && preferences.allowRunning) {
    const runningAccess = routes.find((route) => route.id === `${template.id}:run:walk`);

    if (
      runningAccess &&
      runningAccess.arrivalTime.latest === baseline.arrivalTime.latest &&
      runningAccess.arrivalTime.earliest === baseline.arrivalTime.earliest
    ) {
      baseline.reasons.push(
        '이번 가정 차량은 걸어도 탈 수 있어요. 접근 구간을 달려도 도착이 같아요.',
      );
    }

    for (const route of routes) {
      if (route.runningMeters === 0) {
        continue;
      }

      const savedLatestSeconds = Math.floor(
        (baseline.arrivalTime.latest - route.arrivalTime.latest) / SECOND,
      );

      route.reasons.push(
        savedLatestSeconds > 0
          ? `걷기와 대중교통 기준 경로보다 늦은 예상 도착이 ${savedLatestSeconds}초 빨라지는 가정이에요.`
          : '달리기를 포함해도 늦은 예상 도착은 기준 경로보다 빨라지지 않아요.',
      );
    }
  }

  const overdueNotice =
    request.purpose === 'urgent' && request.deadline <= request.now
      ? '원래 약속 시간이 지나, 지금 출발했을 때 얼마나 늦는지 비교했어요. '
      : '';

  return makeResult(
    routes,
    request.now,
    anchor,
    provenance,
    `${overdueNotice}체험용 예시 경로예요. 실제 운행 정보가 아니에요.`,
  );
}

export function replanRoutes(
  request: PlanningRequest,
  reason: ReplanReason,
  now: number,
  selectedRoute?: Route,
): PlanningResult {
  const previous = selectedRoute ?? searchRoutes(request).routes[0];
  const departure = previous?.segments.find((segment) => segment.connection)?.connection
    ?.departureAt;
  const preferences =
    reason === 'walking-only'
      ? withWalkingOnly(request.preferences, true)
      : {
          ...request.preferences,
        };

  if (reason === 'no-bicycle') {
    preferences.allowBicycle = false;
  }

  const result = searchRoutes({
    ...request,
    now,
    preferences,
    purpose: 'replan',
    scheduleAnchorAt: request.scheduleAnchorAt ?? request.now,
    missedDepartureAt:
      reason === 'missed-vehicle'
        ? Math.max(now, departure ?? now, request.missedDepartureAt ?? 0)
        : request.missedDepartureAt,
  });

  result.notice =
    '출발지 기준으로 조건과 경과 시간을 다시 계산한 시연 결과예요. 실제 현재 위치에서 길을 다시 찾은 결과가 아니에요.';

  return result;
}

function remainingRoute(
  request: PlanningRequest,
  route: Route,
  segmentIndex: number,
  reason: ReplanReason | undefined,
  now: number,
  allowActive = false,
): PlanningResult {
  validateTime(
    {
      ...request,
      now,
    },
    true,
  );

  if (
    !Number.isInteger(segmentIndex) ||
    segmentIndex < 0 ||
    segmentIndex >= route.segments.length
  ) {
    throw new PlanningError('INVALID_INPUT', '현재 이동 단계를 확인해 주세요.');
  }

  const current = route.segments[segmentIndex];
  const currentActive = ['bus', 'subway', 'bicycle', 'return'].includes(current.mode);

  if (
    currentActive &&
    (!allowActive || reason === 'walking-only' || request.preferences.walkingOnly)
  ) {
    throw new PlanningError(
      'ACTIVE_VEHICLE',
      '먼저 하차 또는 자전거 반납을 확인해 주세요. 이동 중인 차량이나 자전거에서 새 접근 경로를 추천하지 않아요.',
    );
  }

  if (route.provenance.mode !== 'demo') {
    throw new PlanningError(
      'NO_DEMO_SERVICE',
      '실제 경로의 현재 위치 재탐색은 연결된 공급원에서 다시 조회해야 해요.',
    );
  }

  const template = resolveTemplate(request);
  const preferences =
    reason === 'walking-only'
      ? withWalkingOnly(request.preferences, true)
      : {
          ...request.preferences,
        };

  if (reason === 'no-bicycle') {
    preferences.allowBicycle = false;
  }

  let remaining: BaseSegment[] = route.segments
    .slice(segmentIndex)
    .filter((segment) => segment.mode !== 'wait')
    .map((segment) => {
      // Timings and connection decisions are recomputed, not copied from the previous result.
      const {
        timeRange: _timeRange,
        connection: _connection,
        provenance: _provenance,
        ...base
      } = segment;

      return {
        ...base,
        durationSeconds: {
          ...segment.durationSeconds,
        },
      };
    });

  if (preferences.walkingOnly || !preferences.allowRunning) {
    remaining = remaining.map((segment) =>
      segment.mode === 'run'
        ? {
            ...segment,
            mode: 'walk',
            title: '남은 구간 걷기',
            durationSeconds: segment.walkingDurationSeconds ?? segment.durationSeconds,
          }
        : segment,
    );
  }

  const hireIndex = remaining.findIndex((segment) => segment.mode === 'hire');

  if (!preferences.walkingOnly && !preferences.allowBicycle && hireIndex >= 0 && template.bicycle) {
    const returnIndex = remaining.findIndex((segment) => segment.mode === 'return');
    const hire = remaining[hireIndex];
    const returnStep = remaining[returnIndex];
    const fallback = baseSegment(
      `${template.id}:bike-walk-fallback`,
      'walk',
      '자전거 없이 승차 지점까지 걷기',
      hire.start,
      returnStep.end,
      template.bicycle.meters,
      template.bicycle.fallbackWalkingSeconds,
      '대여 지점에서 반납 지점까지 걷는 가정 대안을 계산했어요.',
      true,
    );

    remaining.splice(hireIndex, returnIndex - hireIndex + 1, fallback);
  }

  let walkingAssumption = false;

  if (preferences.walkingOnly) {
    const excludedIndex = remaining.findIndex(
      (segment) => segment.mode !== 'walk' && segment.mode !== 'entry',
    );

    if (excludedIndex >= 0) {
      const start = remaining[excludedIndex].start;
      const destination = route.destination;
      // The demo has no reviewed walking network from an intermediate point.
      // Preserve known foot segments, then use its full walking scenario as a
      // conservative explicit assumption instead of drawing a transit shortcut.
      const fallback = baseSegment(
        `${template.id}:remaining-all-walk`,
        'walk',
        '목적지까지 도보 가정 대안',
        start,
        destination,
        template.walkingMeters,
        {
          ...template.walkingSeconds,
        },
        '남은 지점의 실제 도보 경로가 없어서 전체 도보 시연 시간·거리를 보수적으로 적용한 가정이에요.',
        false,
      );

      remaining.splice(excludedIndex, remaining.length - excludedIndex, fallback);

      walkingAssumption = true;
    }
  }

  const previousConnection = route.segments
    .slice(segmentIndex)
    .find((segment) => segment.connection)?.connection;
  const missedDepartureAt =
    reason === 'missed-vehicle'
      ? Math.max(now, previousConnection?.departureAt ?? now, request.missedDepartureAt ?? 0)
      : request.missedDepartureAt;
  const anchor = request.scheduleAnchorAt ?? request.now;
  const provenance = demoProvenance(anchor, now);
  const segments = calculateDemoSegments(
    remaining,
    template,
    now,
    anchor,
    provenance,
    missedDepartureAt,
    currentActive && allowActive ? current.id : undefined,
  );

  if (!segments.length) {
    throw new PlanningError('NO_DEMO_SERVICE', '남은 이동 단계가 없어요.');
  }

  const reasons = ['완료를 확인한 단계는 제외하고 현재 단계 시작 지점에서 남은 구간을 계산했어요.'];

  if (walkingAssumption) {
    reasons.push(
      '대중교통·대여 구간을 모두 제외했어요. 중간 지점의 실제 도보망은 없어 목적지까지는 전체 도보 시연 값을 보수적으로 더했어요. 실제 도보 경로가 아니에요.',
    );
  }

  if (currentActive && allowActive) {
    reasons.push(
      '현재 단계의 진행량은 확인되지 않아 전체 단계 시간이 남아 있다고 보수적으로 계산했어요. 실제 하차·반납은 직접 확인해 주세요.',
    );
  }

  const candidate = finishRoute(
    `${route.id}:remaining:${segmentIndex}:${reason ?? 'refresh'}:${now}`,
    '남은 구간 다시 계산',
    segments,
    {
      ...request,
      now,
      preferences,
    },
    provenance,
    demoRisks(
      segments,
      segments.some((segment) => segment.mode === 'bicycle'),
    ),
    reasons,
  );

  if (!withinPreferences(candidate, preferences)) {
    throw new PlanningError('INVALID_INPUT', '남은 경로가 이동 조건을 벗어났어요.');
  }

  return makeResult(
    [candidate],
    now,
    anchor,
    provenance,
    '사용자가 확인한 현재 단계 시작 지점 기준의 가정 경로예요. GPS로 현재 위치나 실제 승차를 확인한 결과가 아니에요.',
  );
}

export function replanRemainingRoute(
  request: PlanningRequest,
  route: Route,
  segmentIndex: number,
  reason: ReplanReason,
  now: number,
): PlanningResult {
  return remainingRoute(request, route, segmentIndex, reason, now);
}

/** Resume/foreground refresh preserves the confirmed current mode and never repeats completed steps. */
export function refreshRemainingRoute(
  request: PlanningRequest,
  route: Route,
  segmentIndex: number,
  now: number,
): PlanningResult {
  return remainingRoute(request, route, segmentIndex, undefined, now, true);
}

const isVehicleSegment = (segment: BaseSegment) =>
  segment.mode === 'bus' || segment.mode === 'subway';

const isProviderAllowance = (segment: BaseSegment) =>
  segment.mode === 'wait' && segment.id.endsWith('-provider-extra');

/** Average-headway wait placed before a vehicle by the server when no live arrival was known. */
const isExpectedWait = (segment: BaseSegment | undefined) =>
  !!segment && segment.mode === 'wait' && segment.id.endsWith('-expected-wait');

/** Walk from the street or bus-stop sign onto the vehicle: platform access for subway, kerb for bus. */
export { REALTIME_BOARDING_BUFFER_SECONDS } from './waitEstimates.js';

/** First predicted vehicle the rider can still reach, for the fastest and slowest access. */
export function catchableDepartures(
  segment: BaseSegment,
  reachStop: TimeRange,
): {
  earliest: number;
  latest: number;
  fallback?: number;
} | null {
  const live = segment.realtime;

  if (!live || live.status !== 'live' || !live.predictions.length || !isVehicleSegment(segment)) {
    return null;
  }

  const buffer = REALTIME_BOARDING_BUFFER_SECONDS[segment.mode as 'bus' | 'subway'] * SECOND;
  const departures = live.predictions
    .map((prediction) => prediction.arrivesAt)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const earliest = departures.find((departure) => departure >= reachStop.earliest + buffer);
  const latest = departures.find((departure) => departure >= reachStop.latest + buffer);

  if (earliest === undefined || latest === undefined) {
    return null;
  }

  return {
    earliest,
    latest,
    fallback: departures.find((departure) => departure > latest),
  };
}

/** Marginal waiting bounds. Access and waiting are correlated; never add these to derive boarding time. */
export function boardingWaitRange(segment: BaseSegment, reach: TimeRange): DurationRange | null {
  if (!catchableDepartures(segment, reach)) {
    return null;
  }

  const buffer = REALTIME_BOARDING_BUFFER_SECONDS[segment.mode as 'bus' | 'subway'] * SECOND;
  const departures = [
    ...new Set(
      segment
        .realtime!.predictions.map((prediction) => prediction.arrivesAt)
        .filter(Number.isFinite),
    ),
  ].sort((a, b) => a - b);
  let min = Infinity,
    max = -Infinity;

  for (let index = 0; index < departures.length; index++) {
    const departure = departures[index],
      previous = departures[index - 1];
    const left = Math.max(reach.earliest, previous === undefined ? -Infinity : previous - buffer);
    const right = Math.min(reach.latest, departure - buffer);

    // At the previous vehicle's exact boarding boundary that vehicle is still catchable.
    if (left > right || (left === right && previous !== undefined && left === previous - buffer)) {
      continue;
    }

    min = Math.min(min, (departure - right) / SECOND);
    max = Math.max(max, (departure - left) / SECOND);
  }

  return Number.isFinite(min) && Number.isFinite(max)
    ? {
        min: Math.ceil(min),
        max: Math.ceil(max),
      }
    : null;
}

export const LIVE_HEADWAY_FALLBACK_EXPLANATION =
  '도착 예정 차량 기준이에요. 이 차를 놓치면 다음 차량까지 평균 배차 간격으로 계산했어요.';
export const LIVE_TIMETABLE_FALLBACK_EXPLANATION =
  '도착 예정 차량 기준이에요. 이 차를 놓치면 공개 시간표의 다음 열차로 계산했어요.';
export const LIVE_MISSED_HEADWAY_EXPLANATION =
  '실시간 도착 예정 차량은 정류장에 닿기 전에 지나가요. 다음 차량까지 평균 배차 간격으로 계산했어요.';
export const LIVE_MISSED_TIMETABLE_EXPLANATION =
  '실시간 도착 예정 차량은 정류장에 닿기 전에 지나가요. 공개 시간표의 다음 열차로 계산했어요.';
export const LIVE_LAST_SERVICE_EXPLANATION =
  '도착 예정 차량 기준이에요. 조금 늦으면 막차를 놓쳐 이 경로로 갈 수 없어요.';

export const LIVE_MISSED_HEADWAY_RISK: Risk = {
  code: 'unverified-schedule',
  severity: 'warning',
  title: '다음 차량은 평균 배차로 계산',
  description: '실시간 도착 정보에 아직 나오지 않은 다음 차량은 평균 배차 간격으로 계산했어요.',
};
export const LIVE_MISSED_TIMETABLE_RISK: Risk = {
  code: 'unverified-schedule',
  severity: 'info',
  title: '공개 시간표 적용',
  description:
    '실시간 도착 정보에 아직 나오지 않은 다음 열차는 공개 시간표로 계산했어요. 실시간 지연이나 결행은 반영되지 않을 수 있어요.',
};
export const LAST_SERVICE_RISK: Risk = {
  code: 'borderline-boarding',
  severity: 'warning',
  title: '막차를 놓칠 수 있어요',
  description: '예상보다 늦게 정류장에 닿으면 막차가 떠나 이 경로로는 갈 수 없어요.',
};

/** One live boarding decision: the boarding clock range, the wait segment's range and the connection. */
export interface LiveBoardingSelection {
  departure: TimeRange;
  wait: DurationRange;
  connection: Omit<Connection, 'explanation' | 'fallbackArrivalAt'>;
  /** The slower access clock misses every listed vehicle and continues on the shared continuation. */
  headwayFallback: boolean;
  /** The earliest access clock still catches a listed vehicle. False: every clock misses the list and both bounds
   * board the shared continuation, exactly as a slower bound would. */
  boardsListed: boolean;
  /** How the slower bound was continued past the list. */
  continuation?: 'published-departure' | 'wait-rule';
  /** The slower access clock misses the last vehicle; its bound stays on that vehicle and the route carries the risk. */
  missesLastService: boolean;
}

export const liveBoardingExplanation = (selected: LiveBoardingSelection, listed: string) =>
  selected.missesLastService
    ? LIVE_LAST_SERVICE_EXPLANATION
    : !selected.boardsListed
      ? selected.continuation === 'published-departure'
        ? LIVE_MISSED_TIMETABLE_EXPLANATION
        : LIVE_MISSED_HEADWAY_EXPLANATION
      : !selected.headwayFallback
        ? listed
        : selected.continuation === 'published-departure'
          ? LIVE_TIMETABLE_FALLBACK_EXPLANATION
          : LIVE_HEADWAY_FALLBACK_EXPLANATION;

/** Choose the listed vehicle on the earliest access clock. When only the slower clock misses every listed
 * vehicle, keep that vehicle and bound the slower side by the shared continuation (published timetable or headway
 * rule); when nothing runs after the list, the slower side stays on the last vehicle. When even the earliest clock
 * misses the list, both bounds board the same continuation, never earlier than one headway after the last listed
 * vehicle, so a slower access can never be given an earlier bus. Shared by the graph, the planner and the app's
 * re-validation so all three derive identical values. */
export function selectLiveBoarding(
  segment: BaseSegment,
  reach: TimeRange,
  now: number,
): LiveBoardingSelection | null {
  const live = segment.realtime;
  if (!live || live.status !== 'live' || !live.predictions.length || !isVehicleSegment(segment))
    return null;
  const range = liveDepartureRange(segment, live, reach, now);
  if (!range) return null;
  const bufferSeconds = REALTIME_BOARDING_BUFFER_SECONDS[segment.mode as 'bus' | 'subway'],
    buffer = bufferSeconds * SECOND;
  const departures = listedDepartures(live),
    { earliest } = range.departure;
  const boardingMarginSeconds = Math.floor((earliest - reach.latest) / SECOND) - bufferSeconds;
  if (!range.earliestListed) {
    // Every access clock misses the list: the same continuation (bounded by the last listed vehicle) for both sides.
    const wait = unlistedWaitRange(segment, live, reach.earliest, reach.latest, now, true);
    if (!wait) return null;
    const latest = range.departure.latest;
    return {
      departure: { earliest, latest },
      wait,
      headwayFallback: true,
      boardsListed: false,
      continuation: range.continuation,
      missesLastService: false,
      connection: {
        departureAt: earliest,
        ...(latest === earliest ? {} : { fallbackDepartureAt: latest }),
        status: latest === earliest ? 'comfortable' : 'borderline',
        boardingMarginSeconds,
      },
    };
  }
  if (range.latestListed) {
    const latest = range.departure.latest,
      borderline = earliest !== latest,
      fallbackDepartureAt = borderline
        ? latest
        : departures.find((departure) => departure > latest);
    return {
      departure: { earliest, latest },
      wait: boardingWaitRange(segment, reach)!,
      headwayFallback: false,
      boardsListed: true,
      missesLastService: false,
      connection: {
        departureAt: earliest,
        ...(fallbackDepartureAt === undefined ? {} : { fallbackDepartureAt }),
        status: borderline ? 'borderline' : 'comfortable',
        boardingMarginSeconds,
      },
    };
  }
  // Access clocks up to the last listed vehicle's boarding boundary still catch a listed vehicle.
  const lastBoarding = departures.at(-1)! - buffer;
  const listed = boardingWaitRange(segment, { earliest: reach.earliest, latest: lastBoarding });
  if (!listed) return null;
  if (range.missesLastService) {
    const last = range.departure.latest;
    return {
      departure: { earliest, latest: last },
      wait: listed,
      headwayFallback: false,
      boardsListed: true,
      missesLastService: true,
      connection: {
        departureAt: earliest,
        ...(last === earliest ? {} : { fallbackDepartureAt: last }),
        status: 'borderline',
        boardingMarginSeconds,
      },
    };
  }
  const unlisted = unlistedWaitRange(segment, live, lastBoarding, reach.latest, now);
  if (!unlisted) return null;
  const fallbackDepartureAt = range.departure.latest;
  return {
    departure: { earliest, latest: fallbackDepartureAt },
    wait: { min: Math.min(listed.min, unlisted.min), max: Math.max(listed.max, unlisted.max) },
    headwayFallback: true,
    boardsListed: true,
    continuation: range.continuation,
    missesLastService: false,
    connection: {
      departureAt: earliest,
      fallbackDepartureAt,
      status: 'borderline',
      boardingMarginSeconds,
    },
  };
}

const samePosition = (a: Place, b: Place) =>
  Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 0.000001;

const freshBoarding = (value: number, now: number) =>
  Number.isFinite(value) && value <= now + 30000 && now - value <= 120000;

const connectionMatches = (a: Connection, b: Connection) =>
  a.departureAt === b.departureAt &&
  a.fallbackDepartureAt === b.fallbackDepartureAt &&
  a.status === b.status &&
  a.boardingMarginSeconds === b.boardingMarginSeconds;

/** Seconds a gate-to-gate subway envelope added after the leg's own (timetable) ride; never negative. */
const railEnvelopeSeconds = (segment: BaseSegment) =>
  segment.railEtaPrediction
    ? segment.durationSeconds.max - segment.railEtaPrediction.sourceDurationSeconds.max
    : 0;

/** Validate an internal graph handoff and derive its chronology from actual observed boardings. */
export function evaluateBaseTimeline(
  segments: readonly BaseSegment[],
  now: number,
  initial: TimeRange = {
    earliest: now,
    latest: now,
  },
): TimeRange[] | null {
  let clock = {
    ...initial,
  };
  const timeline: TimeRange[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index],
      connection = segment.plannedConnection;

    if (
      !Number.isFinite(segment.durationSeconds.min) ||
      !Number.isFinite(segment.durationSeconds.max) ||
      segment.durationSeconds.min < 0 ||
      segment.durationSeconds.max < segment.durationSeconds.min
    ) {
      return null;
    }

    const buffer = segment.planningBuffer;

    if (
      buffer &&
      (!Number.isInteger(buffer.weatherSeconds) ||
        !Number.isInteger(buffer.calibrationSeconds) ||
        buffer.weatherSeconds < 0 ||
        buffer.calibrationSeconds < 0 ||
        buffer.weatherSeconds + buffer.calibrationSeconds >
          segment.durationSeconds.max - segment.durationSeconds.min + 0.000001)
    ) {
      return null;
    }

    if (railEnvelopeSeconds(segment) < 0) {
      return null;
    }

    if (segment.scheduledConnection) {
      const scheduled = segment.scheduledConnection;

      if (
        segment.realtime ||
        segment.plannedConnection ||
        !timetableIsFresh(segment.timetable, now)
      ) {
        return null;
      }

      if (segment.mode === 'wait') {
        const vehicle = segments[index + 1],
          selected = vehicle && scheduledDepartures(vehicle, clock, now);

        if (
          !vehicle?.scheduledConnection ||
          !selected ||
          !connectionMatches(scheduled, vehicle.scheduledConnection) ||
          !connectionMatches(scheduled, selected.connection) ||
          !samePosition(segment.start, segment.end) ||
          !samePosition(segment.end, vehicle.start) ||
          segment.distanceMeters !== 0 ||
          JSON.stringify(segment.timetable) !== JSON.stringify(vehicle.timetable) ||
          ['trainNo', 'trainArrivalAt', 'latestTrainNo', 'latestTrainArrivalAt'].some(
            (key) =>
              scheduled[key as keyof typeof scheduled] !==
                selected.connection[key as keyof typeof selected.connection] ||
              scheduled[key as keyof typeof scheduled] !==
                vehicle.scheduledConnection![key as keyof typeof scheduled],
          ) ||
          !sameNumber(segment.durationSeconds.min, selected.wait.min) ||
          !sameNumber(segment.durationSeconds.max, selected.wait.max) ||
          !sameNumber(vehicle.durationSeconds.min, selected.ride.min) ||
          !sameNumber(vehicle.durationSeconds.max - railEnvelopeSeconds(vehicle), selected.ride.max)
        ) {
          return null;
        }

        clock = selected.departure;
      } else {
        const wait = segments[index - 1];

        if (
          !timetableMatchesSegment(segment.timetable, segment) ||
          wait?.mode !== 'wait' ||
          !wait.scheduledConnection ||
          !connectionMatches(scheduled, wait.scheduledConnection)
        ) {
          return null;
        }

        const early = scheduledArrivalAt(segment.timetable, clock.earliest),
          late = scheduledArrivalAt(segment.timetable, clock.latest);

        if (early === null || late === null) {
          return null;
        }

        // The timetable fixes the train; a subway envelope only delays the latest exit after it.
        clock = {
          earliest: early,
          latest: late + railEnvelopeSeconds(segment) * SECOND,
        };
      }
    } else if (connection) {
      const live = segment.realtime;

      if (
        !live ||
        live.status !== 'live' ||
        !freshBoarding(live.receivedAt, now) ||
        !freshBoarding(live.observedAt, now)
      ) {
        return null;
      }

      if (segment.mode === 'wait') {
        const vehicle = segments[index + 1];

        if (
          !vehicle ||
          !isVehicleSegment(vehicle) ||
          !vehicle.plannedConnection ||
          !connectionMatches(connection, vehicle.plannedConnection) ||
          !samePosition(segment.start, segment.end) ||
          !samePosition(segment.end, vehicle.start) ||
          segment.distanceMeters !== 0 ||
          JSON.stringify(live) !== JSON.stringify(vehicle.realtime)
        ) {
          return null;
        }

        const selected = selectLiveBoarding(vehicle, clock, now);

        if (!selected) {
          return null;
        }

        const expected = selected.connection;

        if (
          connection.departureAt !== expected.departureAt ||
          connection.status !== expected.status ||
          connection.fallbackDepartureAt !== expected.fallbackDepartureAt ||
          connection.boardingMarginSeconds !== expected.boardingMarginSeconds ||
          !sameNumber(segment.durationSeconds.min, selected.wait.min) ||
          !sameNumber(segment.durationSeconds.max, selected.wait.max)
        ) {
          return null;
        }

        clock = { ...selected.departure };
      } else {
        const wait = segments[index - 1];

        if (
          !isVehicleSegment(segment) ||
          !wait?.plannedConnection ||
          wait.mode !== 'wait' ||
          !connectionMatches(connection, wait.plannedConnection)
        ) {
          return null;
        }

        clock = {
          earliest: clock.earliest + segment.durationSeconds.min * SECOND,
          latest: clock.latest + segment.durationSeconds.max * SECOND,
        };
      }
    } else {
      if (isVehicleSegment(segment) && segment.realtime) {
        return null;
      }

      clock = {
        earliest: clock.earliest + segment.durationSeconds.min * SECOND,
        latest: clock.latest + segment.durationSeconds.max * SECOND,
      };
    }

    if (
      !Number.isFinite(clock.earliest) ||
      !Number.isFinite(clock.latest) ||
      clock.latest < clock.earliest
    ) {
      return null;
    }

    timeline.push({
      ...clock,
    });
  }

  return timeline;
}

/** Upstream estimates remain estimates. Missing schedules never become invented connections. */
export function planBaseRoutes(
  request: BasePlanningRequest,
  baseRoutes: BaseRoute[],
  provenance: Provenance,
  options: {
    /** Trusted server acceptance clock, never a client field. Only the 48h range uses this; ETA uses request.now. */ deadlineValidationTime?: number;
    /** How many ranked routes to return; multimodal searches show more. */ maxRoutes?: number;
    objective?: RoutingObjective;
  } = {},
): PlanningResult {
  validateTime(request, acceptsElapsedDeadline(request.purpose), options.deadlineValidationTime);

  const routes: Route[] = [];

  for (const base of baseRoutes) {
    if (base.timingEvaluatedAt !== undefined && base.timingEvaluatedAt !== request.now) {
      continue;
    }

    if (
      !base.segments.length ||
      !Number.isFinite(base.durationSeconds.min) ||
      !Number.isFinite(base.durationSeconds.max) ||
      base.durationSeconds.min < 0 ||
      base.durationSeconds.max < base.durationSeconds.min
    ) {
      continue;
    }

    if (
      base.segments.some(
        (segment) =>
          !Number.isFinite(segment.durationSeconds.min) ||
          !Number.isFinite(segment.durationSeconds.max) ||
          segment.durationSeconds.min < 0 ||
          segment.durationSeconds.max < segment.durationSeconds.min ||
          !Number.isFinite(segment.distanceMeters) ||
          segment.distanceMeters < 0,
      )
    ) {
      continue;
    }

    const evaluatedTimeline =
      base.timingEvaluatedAt === request.now
        ? evaluateBaseTimeline(base.segments, request.now)
        : null;

    if (base.timingEvaluatedAt === request.now) {
      const arrival = evaluatedTimeline?.at(-1);

      if (
        !arrival ||
        !sameNumber((arrival.earliest - request.now) / SECOND, base.durationSeconds.min) ||
        !sameNumber((arrival.latest - request.now) / SECOND, base.durationSeconds.max)
      ) {
        continue;
      }
    } else {
      const sum = base.segments.reduce(
        (total, segment) => ({
          min: total.min + segment.durationSeconds.min,
          max: total.max + segment.durationSeconds.max,
        }),
        {
          min: 0,
          max: 0,
        },
      );

      if (sum.min !== base.durationSeconds.min || sum.max !== base.durationSeconds.max) {
        continue;
      }
    }

    // Only explicitly identified average waits can be replaced by live boardings.
    // Unclassified provider overhead retains both bounds at its supplied position.
    const ordered = base.segments;

    let clock: TimeRange = {
      earliest: request.now,
      latest: request.now,
    };
    const segments: Segment[] = [];
    let realtimeProvenance: Provenance | null = null;
    let usedLiveBoardings = 0;
    let missesLastService = false;
    let continuedPastList: LiveBoardingSelection['continuation'] | null = null;

    ordered.forEach((segment, index) => {
      if (base.timingEvaluatedAt !== request.now && isExpectedWait(segment)) {
        const next = ordered[index + 1],
          live = next?.realtime;

        if (
          next &&
          live &&
          freshBoarding(live.receivedAt, request.now) &&
          freshBoarding(live.observedAt, request.now) &&
          selectLiveBoarding(next, clock, request.now)
        ) {
          return;
        }
      }

      if (
        base.timingEvaluatedAt === request.now &&
        segment.scheduledConnection &&
        segment.timetable
      ) {
        const scheduledConnection = {
          ...segment.scheduledConnection,
        };

        clock = {
          ...evaluatedTimeline![index],
        };

        segments.push({
          ...segment,
          scheduledConnection,
          timeRange: {
            ...clock,
          },
          connection: scheduledConnection,
          provenance: segment.routingSource ?? {
            ...provenance,
            provider: '서울교통공사 공개 시간표',
            label: '공개 시간표 · 실시간 아님',
            sourceTimestamp: null,
            receivedAt: segment.timetable.receivedAt,
            isRealtime: false,
          },
        });

        return;
      }

      if (base.timingEvaluatedAt === request.now && segment.plannedConnection && segment.realtime) {
        const live = segment.realtime;
        // Graph candidates share prefix evidence. Final fallback arrival belongs
        // to this route's suffix and must never mutate another candidate.
        const plannedConnection = {
          ...segment.plannedConnection,
        };

        realtimeProvenance = {
          ...provenance,
          provider: live.provider,
          label: '실시간 도착 정보',
          sourceTimestamp: live.observedAt,
          isRealtime: true,
        };
        clock = {
          ...evaluatedTimeline![index],
        };

        segments.push({
          ...segment,
          plannedConnection,
          timeRange: {
            ...clock,
          },
          provenance: realtimeProvenance,
          connection: plannedConnection,
        });

        if (isVehicleSegment(segment)) {
          usedLiveBoardings++;
        }

        return;
      }

      const live =
        base.timingEvaluatedAt !== request.now && isVehicleSegment(segment)
          ? segment.realtime
          : undefined;
      const selected =
        live &&
        freshBoarding(live.receivedAt, request.now) &&
        freshBoarding(live.observedAt, request.now)
          ? selectLiveBoarding(segment, clock, request.now)
          : null;

      if (live && selected) {
        realtimeProvenance = {
          ...provenance,
          provider: live.provider,
          label: '실시간 도착 정보',
          sourceTimestamp: live.observedAt,
          isRealtime: true,
        };

        const wait = selected.wait;
        const departure = { ...selected.departure };
        const connection: Connection = {
          ...selected.connection,
          explanation: liveBoardingExplanation(
            selected,
            selected.connection.status === 'borderline'
              ? '조금 늦으면 다음 차를 타게 돼요. 늦은 예상에 다음 차를 반영했어요.'
              : '실시간 도착 정보 기준으로 탈 수 있는 차량이에요.',
          ),
        };
        if (selected.missesLastService) missesLastService = true;
        if (!selected.boardsListed && continuedPastList !== 'wait-rule')
          continuedPastList = selected.continuation ?? 'wait-rule';
        const prediction = live.predictions.find((value) => value.arrivesAt === departure.earliest);

        segments.push({
          id: `${segment.id}:wait`,
          mode: 'wait',
          title: `${prediction?.line ?? segment.lineName ?? ''} 기다리기`.trim(),
          instructions: connection.explanation,
          distanceMeters: 0,
          start: segment.start,
          end: segment.start,
          runAllowed: false,
          durationSeconds: wait,
          planningBuffer: {
            weatherSeconds: 0,
            calibrationSeconds: 0,
          },
          realtime: live,
          plannedConnection: connection,
          timeRange: {
            ...departure,
          },
          provenance: realtimeProvenance,
          connection,
        });

        clock = {
          earliest: departure.earliest + segment.durationSeconds.min * SECOND,
          latest: departure.latest + segment.durationSeconds.max * SECOND,
        };

        segments.push({
          ...segment,
          plannedConnection: connection,
          timeRange: {
            ...clock,
          },
          provenance: realtimeProvenance,
          connection,
        });

        usedLiveBoardings++;

        return;
      }

      clock = {
        earliest: clock.earliest + segment.durationSeconds.min * SECOND,
        latest: clock.latest + segment.durationSeconds.max * SECOND,
      };

      segments.push({
        ...segment,
        timeRange: {
          ...clock,
        },
        provenance: segment.routingSource ?? provenance,
      });
    });

    if (usedLiveBoardings) {
      const last = segments[segments.length - 1];

      for (const segment of segments) {
        if (
          segment.connection?.status === 'borderline' &&
          segment.connection.fallbackDepartureAt !== undefined
        ) {
          segment.connection.fallbackArrivalAt = last.timeRange.latest;
        }
      }
    }
    // A slower access that misses the last vehicle has no arrival on this route. Keep the route only when the point
    // estimate still boards that vehicle and routes are ranked on it; a conservative ranking would trust a missed bound.
    if (
      missesLastService &&
      (options.objective !== 'estimated-arrival' || !estimateBaseTimeline(segments, request.now))
    )
      continue;

    const transit = segments.some(isVehicleSegment);
    const vehicles = segments.filter(isVehicleSegment);
    const allLive =
      transit && vehicles.every((segment) => segment.provenance.isRealtime && !!segment.connection);
    const routeProvenance: Provenance =
      allLive && realtimeProvenance ? realtimeProvenance : provenance;
    const risks: Risk[] = [
      {
        code: 'destination-entry',
        severity: 'info',
        title: '목적지 입구 확인',
        description: '도착 지점과 실제 건물 입구가 다를 수 있어요. 준비 시간을 함께 계산했어요.',
      },
      ...(base.notes ?? []),
    ];
    if (missesLastService) risks.push(LAST_SERVICE_RISK);
    // A vehicle no feed has listed yet is not observed: the boarding stays on the shared continuation, and the route
    // says so (urgency then never presents it as a verified real-time boarding).
    if (continuedPastList)
      risks.push(
        continuedPastList === 'published-departure'
          ? LIVE_MISSED_TIMETABLE_RISK
          : LIVE_MISSED_HEADWAY_RISK,
      );
    const allTimed =
      transit &&
      vehicles.every(
        (segment) =>
          segment.scheduledConnection || (segment.provenance.isRealtime && segment.connection),
      );

    if (transit && !allLive && !allTimed) {
      risks.push(
        usedLiveBoardings
          ? {
              code: 'unverified-schedule',
              severity: 'info',
              title: '일부 차량은 예상 대기 시간',
              description:
                '받은 실시간 도착 정보는 연결 시각에 반영했고, 정보가 없는 차량은 공급원의 예상 대기 시간을 사용했어요.',
            }
          : {
              code: 'unverified-schedule',
              severity: 'warning',
              title: '실시간 도착 정보 없음',
              description:
                '차량 도착 정보를 받지 못해 평균 대기 시간으로 계산했어요. 첫차·막차 시간을 확인해 주세요.',
            },
      );
    }

    const candidate = finishRoute(base.id, base.title, segments, request, routeProvenance, risks, [
      usedLiveBoardings
        ? '실시간 도착 정보와 걷는 시간, 도착 후 준비 시간을 모두 반영했어요.'
        : '걷는 시간과 이동 시간, 도착 후 준비 시간을 반영했어요.',
    ]);

    // Provider step endpoints identify its geometry, not the user's selected
    // places. Keep the request's canonical destination across alternatives and
    // future replans without changing any supplied segment coordinates.
    candidate.origin = {
      ...request.origin,
    };
    candidate.destination = {
      ...request.destination,
    };
    candidate.transfers = base.transfers;
    candidate.fareWon = base.fareWon;
    candidate.landingUrl = base.landingUrl;

    // Without live vehicle data a small margin is not a promise.
    if (
      candidate.status === 'on-time' &&
      transit &&
      !allLive &&
      candidate.marginSeconds.min < 5 * 60
    ) {
      candidate.status = 'uncertain';
    }

    if (candidate.status === 'on-time' && candidate.marginSeconds.min < 60) {
      candidate.status = 'uncertain';
    }

    if (withinPreferences(candidate, request.preferences)) {
      routes.push(candidate);
    }
  }

  const overdueNotice =
    request.purpose === 'urgent' && request.deadline <= request.now
      ? '원래 약속 시간이 지나, 지금 출발했을 때 얼마나 늦는지 비교했어요.'
      : '';
  const realtime = routes.some((route) =>
    route.segments.some((segment) => segment.provenance.isRealtime),
  );

  return makeResult(
    routes,
    request.now,
    request.now,
    provenance,
    overdueNotice || (realtime ? '실시간 도착 정보를 반영했어요.' : ''),
    request.purpose,
    options.maxRoutes,
    options.objective,
  );
}
