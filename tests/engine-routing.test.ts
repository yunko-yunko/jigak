// Preserved regression cases from perception-map/mvp/tests/routing.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PREFERENCES,
  PLACES,
  PlanningError,
  planBaseRoutes,
  replanRemainingRoute,
  replanRoutes,
  refreshRemainingRoute,
  searchRoutes,
  type BaseRoute,
  type MobilityPreferences,
  type PlanningRequest,
  type Provenance,
} from '../src/common/shared/domain/index.js';

const NOW = Date.parse('2026-10-02T00:00:00Z');
const MINUTE = 60_000;

function request(
  originId = 'seoul-station',
  destinationId = 'city-hall',
  overrides: Partial<MobilityPreferences> = {},
): PlanningRequest {
  return {
    originId,
    destinationId,
    now: NOW,
    deadline: NOW + 30 * MINUTE,
    preferences: { ...DEFAULT_PREFERENCES, ...overrides },
  };
}

test('running and bicycle are opt-in; default search returns distinct real candidates from the fixture only', () => {
  const result = searchRoutes(request());
  assert.ok(result.routes.length >= 1 && result.routes.length <= 3);
  assert.equal(new Set(result.routes.map((route) => route.id)).size, result.routes.length);
  assert.ok(result.routes.every((route) => route.runningMeters === 0 && route.bicycleMeters === 0));
  assert.equal(result.provenance.mode, 'demo');
  assert.equal(result.provenance.isRealtime, false);
  assert.ok(result.routes.every((route) => route.risks.some((risk) => risk.code === 'demo-data')));
});

test('a faster access that catches the same vehicle is pruned instead of promoted', () => {
  const result = searchRoutes(
    request('seoul-station', 'city-hall', { allowRunning: true, maxRunningMeters: 500 }),
  );
  assert.ok(result.routes.some((route) => route.id === 'same-train:walk:walk'));
  assert.ok(!result.routes.some((route) => route.id === 'same-train:run:walk'));
  assert.ok(!result.routes.some((route) => route.id === 'same-train:run:run'));
  assert.equal(result.routes[0].runningMeters, 0);
  assert.ok(result.routes[0].reasons.some((reason) => reason.includes('걸어도 탈 수')));
});

test('last-mile running candidate explains its actual burden instead of inheriting a walking-only reason', () => {
  const result = searchRoutes(
    request('seoul-station', 'city-hall', { allowRunning: true, maxRunningMeters: 500 }),
  );
  const route = result.routes.find((candidate) => candidate.runningMeters === 140)!;
  assert.ok(route);
  assert.ok(route.reasons[0].includes('하차 후 야외 140m 달리기'));
  assert.ok(!route.reasons.some((reason) => reason.includes('달리기 없이')));
  assert.ok(
    route.reasons.some((reason) => reason.includes('늦은 예상 도착은 기준 경로보다 빨라지지')),
  );
  const combined = searchRoutes(
    request('hongik-univ', 'yonsei', { allowRunning: true, maxRunningMeters: 700 }),
  );
  const both = combined.routes.find((candidate) => candidate.runningMeters === 600)!;
  assert.ok(both.reasons[0].includes('총 600m'));
  assert.ok(!both.reasons.some((reason) => reason.includes('달리기 없이')));
  const bikeAndRun = searchRoutes(
    request('seongsu', 'konkuk', {
      allowRunning: true,
      allowBicycle: true,
      bicycleReady: true,
      maxRunningMeters: 500,
    }),
  );
  const bikeRunningCandidates = bikeAndRun.routes.filter(
    (candidate) => candidate.bicycleMeters > 0 && candidate.runningMeters > 0,
  );
  assert.ok(bikeRunningCandidates.length > 0);
  for (const candidate of bikeRunningCandidates) {
    assert.ok(candidate.reasons[0].includes('하차 후 야외 220m 달리기'));
    assert.ok(!candidate.reasons.some((reason) => reason.includes('달리기 없이')));
  }
});

test('borderline boarding includes missed-vehicle fallback in the latest arrival', () => {
  const result = searchRoutes(
    request('hongik-univ', 'yonsei', { allowRunning: true, maxRunningMeters: 500 }),
  );
  const running = result.routes.find((route) => route.runningMeters === 420)!;
  assert.ok(running);
  const vehicle = running.segments.find((segment) => segment.mode === 'bus')!;
  assert.equal(vehicle.connection?.status, 'borderline');
  assert.equal(vehicle.connection?.departureAt, NOW + 330_000);
  assert.equal(vehicle.connection?.fallbackDepartureAt, NOW + 990_000);
  assert.equal(running.arrivalTime.latest, NOW + (990 + 900 + 210) * 1000);
  assert.equal(vehicle.connection?.fallbackArrivalAt, running.arrivalTime.latest);
  assert.equal(running.status, 'uncertain');
  assert.ok(running.risks.some((risk) => risk.code === 'borderline-boarding'));
});

test('running limit applies to all outdoor running segments, and interiors never run', () => {
  const result = searchRoutes(
    request('hongik-univ', 'yonsei', { allowRunning: true, maxRunningMeters: 500 }),
  );
  assert.ok(result.routes.every((route) => route.runningMeters <= 500));
  assert.ok(!result.routes.some((route) => route.id === 'tight-bus:run:run'));
  const unrestricted = searchRoutes(
    request('hongik-univ', 'yonsei', { allowRunning: true, maxRunningMeters: 700 }),
  );
  assert.ok(
    unrestricted.routes.some(
      (route) => route.id === 'tight-bus:run:run' && route.runningMeters === 600,
    ),
  );
  for (const route of result.routes) {
    assert.equal(
      route.runningMeters,
      route.segments
        .filter((segment) => segment.mode === 'run')
        .reduce((total, segment) => total + segment.distanceMeters, 0),
    );
    assert.ok(
      route.segments
        .filter((segment) => segment.mode === 'run')
        .every((segment) => segment.runAllowed),
    );
  }
  const limited = searchRoutes(
    request('seoul-station', 'city-hall', { allowRunning: true, maxRunningMeters: 50 }),
  );
  assert.ok(limited.routes.every((route) => route.runningMeters === 0));
  const station = searchRoutes(
    request('seoul-station', 'city-hall', { allowRunning: true, maxRunningMeters: 1000 }),
  );
  assert.ok(
    station.routes
      .flatMap((route) => route.segments)
      .filter((segment) => segment.mode === 'entry')
      .every((segment) => segment.runAllowed === false),
  );
});

test('preparation changes deadline margin, not physical arrival', () => {
  const zero = searchRoutes(request('seoul-station', 'city-hall', { preparationSeconds: 0 }))
    .routes[0];
  const prepared = searchRoutes(request('seoul-station', 'city-hall', { preparationSeconds: 300 }))
    .routes[0];
  assert.deepEqual(prepared.arrivalTime, zero.arrivalTime);
  assert.equal(prepared.readyTime.latest - prepared.arrivalTime.latest, 300_000);
  assert.equal(prepared.marginSeconds.min, zero.marginSeconds.min - 300);
});

test('refresh retains sampled timetable anchor and recalculates elapsed-time boarding', () => {
  const initial = request();
  const original = searchRoutes(initial);
  const refreshed = searchRoutes({
    ...initial,
    now: NOW + 10 * MINUTE,
    scheduleAnchorAt: original.scheduleAnchorAt,
    deadline: NOW + 60 * MINUTE,
  });
  const vehicle = refreshed.routes
    .find((route) => route.segments.some((segment) => segment.mode === 'subway'))!
    .segments.find((segment) => segment.mode === 'subway')!;
  assert.equal(refreshed.scheduleAnchorAt, NOW);
  assert.equal(vehicle.connection?.departureAt, NOW + 960_000);
  assert.equal(vehicle.connection?.fallbackDepartureAt, NOW + 1560_000);
  assert.equal(refreshed.generatedAt, NOW + 10 * MINUTE);
  assert.equal(refreshed.provenance.sourceTimestamp, NOW);
});

test('missed vehicle skips its sampled departure rather than reusing stale advice', () => {
  const input = request();
  const initial = searchRoutes(input).routes[0];
  const result = replanRoutes(input, 'missed-vehicle', NOW + MINUTE, initial);
  const nextVehicle = result.routes
    .find((route) => route.segments.some((segment) => segment.mode === 'subway'))!
    .segments.find((segment) => segment.mode === 'subway')!;
  assert.equal(nextVehicle.connection?.departureAt, NOW + 960_000);
  assert.ok(result.notice.includes('출발지 기준'));
});

test('bike connector requires user readiness, respects total limit, and includes exactly one hire and return', () => {
  const input = request('seongsu', 'konkuk', {
    allowBicycle: true,
    bicycleReady: true,
    maxBicycleMeters: 2000,
  });
  const bicycle = searchRoutes(input).routes.find((route) => route.bicycleMeters > 0)!;
  assert.ok(bicycle);
  assert.equal(bicycle.bicycleRentals, 1);
  assert.equal(bicycle.bicycleMeters, 1100);
  assert.equal(bicycle.segments.filter((segment) => segment.mode === 'hire').length, 1);
  assert.equal(bicycle.segments.filter((segment) => segment.mode === 'return').length, 1);
  assert.ok(bicycle.segments.some((segment) => segment.mode === 'entry'));
  const entry = bicycle.segments.find((segment) => segment.mode === 'entry')!;
  // Approach, hire 30 s, ride, return 30 s, then the station entry.
  assert.equal(entry.timeRange.latest - NOW, (120 + 30 + 330 + 30 + 150) * 1000);
  assert.ok(
    !searchRoutes({
      ...input,
      preferences: { ...input.preferences, bicycleReady: false },
    }).routes.some((route) => route.bicycleMeters),
  );
  assert.ok(
    !searchRoutes({
      ...input,
      preferences: { ...input.preferences, maxBicycleMeters: 1000 },
    }).routes.some((route) => route.bicycleMeters),
  );
});

test('bike unavailability replans from confirmed hire location with walking fallback, not original origin', () => {
  const input = request('seongsu', 'konkuk', { allowBicycle: true, bicycleReady: true });
  const bicycle = searchRoutes(input).routes.find((route) => route.bicycleMeters > 0)!;
  const index = bicycle.segments.findIndex((segment) => segment.mode === 'hire');
  const result = replanRemainingRoute(input, bicycle, index, 'no-bicycle', NOW + 2 * MINUTE);
  const route = result.routes[0];
  assert.equal(route.origin.id, bicycle.segments[index].start.id);
  assert.notEqual(route.origin.id, input.originId);
  assert.equal(route.bicycleMeters, 0);
  assert.equal(route.bicycleRentals, 0);
  assert.equal(route.segments[0].mode, 'walk');
  assert.equal(route.segments[0].distanceMeters, 1100);
  assert.ok(route.reasons[0].includes('완료를 확인한'));
});

test('remaining replan does not invent movement from inside transit or a held bicycle', () => {
  const input = request('seongsu', 'konkuk', { allowBicycle: true, bicycleReady: true });
  const route = searchRoutes(input).routes.find((candidate) => candidate.bicycleMeters > 0)!;
  for (const mode of ['subway', 'bicycle', 'return']) {
    const index = route.segments.findIndex((segment) => segment.mode === mode);
    assert.throws(
      () => replanRemainingRoute(input, route, index, 'walking-only', NOW + MINUTE),
      (error: unknown) => error instanceof PlanningError && error.code === 'ACTIVE_VEHICLE',
    );
  }
});

test('walking-only replan restores remaining run segment walking time and current endpoint', () => {
  const input = request('seoul-station', 'city-hall', {
    allowRunning: true,
    maxRunningMeters: 500,
  });
  const route = searchRoutes(input).routes.find((candidate) => candidate.runningMeters > 0)!;
  const index = route.segments.findIndex((segment) => segment.mode === 'run');
  const result = replanRemainingRoute(input, route, index, 'walking-only', NOW + 13 * MINUTE);
  assert.equal(result.routes[0].runningMeters, 0);
  assert.equal(result.routes[0].origin.id, route.segments[index].start.id);
  assert.deepEqual(
    result.routes[0].segments[0].durationSeconds,
    route.segments[index].walkingDurationSeconds,
  );
  assert.ok(
    result.routes[0].segments.every(
      (segment) => segment.mode === 'walk' || segment.mode === 'entry',
    ),
  );
});

test('walking-only takes precedence over old running/bicycle flags in every demo scenario and preserves overdue urgency', () => {
  for (const [originId, destinationId] of [
    ['seoul-station', 'city-hall'],
    ['hongik-univ', 'yonsei'],
    ['seongsu', 'konkuk'],
  ]) {
    const input = {
      ...request(originId, destinationId, {
        walkingOnly: true,
        allowRunning: true,
        allowBicycle: true,
        bicycleReady: true,
      }),
      purpose: 'urgent' as const,
      deadline: NOW - MINUTE,
    };
    const result = searchRoutes(input);
    assert.equal(result.routes.length, 1);
    assert.ok(result.routes[0].segments.every((segment) => segment.mode === 'walk'));
    assert.equal(result.routes[0].runningMeters, 0);
    assert.equal(result.routes[0].bicycleMeters, 0);
    assert.equal(result.allLate, true);
    assert.equal(
      result.routes[0].readyTime.latest - result.routes[0].arrivalTime.latest,
      input.preferences.preparationSeconds * 1_000,
    );
  }
  const legacy = request();
  delete legacy.preferences.walkingOnly;
  assert.ok(
    searchRoutes(legacy).routes.some((route) =>
      route.segments.some((segment) => segment.mode === 'subway'),
    ),
  );
  assert.throws(
    () => searchRoutes(request('seoul-station', 'city-hall', { walkingOnly: 'yes' as never })),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
});

test('walking-only remaining replan excludes future vehicles from a confirmed intermediate point and stays excluded after refresh', () => {
  const input = request('seongsu', 'konkuk', { allowBicycle: true, bicycleReady: true });
  const original = searchRoutes(input).routes.find((route) => route.bicycleMeters > 0)!;
  const index = original.segments.findIndex((segment) => segment.mode === 'hire');
  const replacement = replanRemainingRoute(input, original, index, 'walking-only', NOW + MINUTE)
    .routes[0];
  assert.equal(replacement.origin.id, original.segments[index].start.id);
  assert.equal(replacement.destination.id, original.destination.id);
  assert.ok(
    replacement.segments.every((segment) => segment.mode === 'walk' || segment.mode === 'entry'),
  );
  assert.ok(replacement.reasons.some((reason) => reason.includes('실제 도보 경로가 아니')));
  const persisted = { ...input, preferences: { ...input.preferences, walkingOnly: true } };
  assert.ok(
    refreshRemainingRoute(persisted, replacement, 0, NOW + 2 * MINUTE).routes[0].segments.every(
      (segment) => segment.mode === 'walk' || segment.mode === 'entry',
    ),
  );
  const boardedIndex = original.segments.findIndex((segment) => segment.mode === 'subway');
  assert.throws(
    () => refreshRemainingRoute(persisted, original, boardedIndex, NOW + 2 * MINUTE),
    (error: unknown) => error instanceof PlanningError && error.code === 'ACTIVE_VEHICLE',
  );
});

test('walking-only filters every nonwalking live mode but keeps genuine walking totals including unallocated provider time', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const modes = ['walk', 'run', 'bus', 'subway', 'hire', 'bicycle', 'return'] as const;
  const bases: BaseRoute[] = modes.map((mode) => ({
    id: mode,
    title: mode,
    distanceMeters: 100,
    durationSeconds: { min: 100, max: 100 },
    transfers: 0,
    segments: [
      {
        id: `${mode}-step`,
        mode,
        title: mode,
        instructions: '',
        distanceMeters: 100,
        durationSeconds: { min: 100, max: 100 },
        start: origin,
        end: destination,
        runAllowed: false,
      },
    ],
  }));
  bases[0] = {
    ...bases[0],
    durationSeconds: { min: 130, max: 130 },
    segments: [
      ...bases[0].segments,
      {
        id: 'provider-overhead',
        mode: 'wait',
        title: '공급원 추가 소요',
        instructions: '',
        distanceMeters: 0,
        durationSeconds: { min: 30, max: 30 },
        start: destination,
        end: destination,
        runAllowed: false,
      },
    ],
  };
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test',
    label: '예상값',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const input = {
    origin,
    destination,
    now: NOW,
    deadline: NOW - MINUTE,
    preferences: {
      ...DEFAULT_PREFERENCES,
      walkingOnly: true,
      allowRunning: true,
      allowBicycle: true,
      bicycleReady: true,
    },
    purpose: 'urgent' as const,
  };
  const result = planBaseRoutes(input, bases, provenance);
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ['walk'],
  );
  assert.equal(result.routes[0].durationSeconds.max, 130);
  assert.equal(
    result.routes[0].readyTime.latest,
    NOW + (130 + input.preferences.preparationSeconds) * 1_000,
  );
  assert.equal(result.allLate, true);
  assert.deepEqual(
    planBaseRoutes(input, bases.slice(1), provenance).routes,
    [],
    'missing walking geometry never becomes a fabricated walking fallback',
  );
});

test('live alternatives preserve the selected place identity and note while keeping each provider endpoint geometry', () => {
  const origin = { ...PLACES[0], id: 'selected-origin', name: '선택한 출발지', note: '광장 입구' };
  const destination = {
    ...PLACES[1],
    id: 'selected-destination',
    name: '선택한 목적지',
    note: '별관 출입문',
  };
  const bases: BaseRoute[] = (['walk', 'bus'] as const).map((mode, index) => {
    const durationSeconds = { min: 100 + index * 100, max: 100 + index * 100 };
    const start = {
      ...origin,
      id: `${mode}-provider-start`,
      name: '공급원 시작',
      latitude: origin.latitude + 0.0001,
    };
    const end = {
      ...destination,
      id: `${mode}-provider-end`,
      name: '공급원 종료',
      longitude: destination.longitude + 0.0001 * (index + 1),
    };
    return {
      id: mode,
      title: mode,
      distanceMeters: 100,
      durationSeconds,
      transfers: 0,
      segments: [
        {
          id: `${mode}-segment`,
          mode,
          title: mode,
          instructions: '',
          distanceMeters: 100,
          durationSeconds,
          start,
          end,
          runAllowed: false,
          polyline: [
            { latitude: start.latitude, longitude: start.longitude },
            { latitude: end.latitude, longitude: end.longitude },
          ],
        },
      ],
    };
  });
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test',
    label: '예상값',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const input = {
    origin,
    destination,
    now: NOW,
    deadline: NOW + 30 * MINUTE,
    preferences: DEFAULT_PREFERENCES,
  };
  const result = planBaseRoutes(input, bases, provenance);
  assert.equal(result.routes.length, 2);
  for (const route of result.routes) {
    const supplied = bases.find((base) => base.id === route.id)!;
    assert.deepEqual(route.origin, origin);
    assert.deepEqual(route.destination, destination);
    assert.notEqual(route.origin, origin);
    assert.notEqual(route.destination, destination);
    assert.deepEqual(route.segments[0].start, supplied.segments[0].start);
    assert.deepEqual(route.segments[0].end, supplied.segments[0].end);
    assert.deepEqual(route.segments[0].polyline, supplied.segments[0].polyline);
    assert.notEqual(route.destination.id, route.segments[0].end.id);
  }
  const refreshed = planBaseRoutes(
    {
      ...input,
      origin: { ...origin, id: 'new-current-location' },
      destination: result.routes[0].destination,
      now: NOW + MINUTE,
      purpose: 'replan',
    },
    bases,
    { ...provenance, receivedAt: NOW + MINUTE },
  );
  assert.ok(
    refreshed.routes.every((route) => route.destination.id === result.routes[0].destination.id),
  );
  assert.equal(destination.note, '별관 출입문');
});

test('ranking uses conservative latest arrival and all-late results are explicit', () => {
  const result = searchRoutes(
    request('hongik-univ', 'yonsei', { allowRunning: true, maxRunningMeters: 700 }),
  );
  for (let index = 1; index < result.routes.length; index++)
    assert.ok(result.routes[index - 1].readyTime.latest <= result.routes[index].readyTime.latest);
  const late = searchRoutes({ ...request(), deadline: NOW + MINUTE });
  assert.equal(late.allLate, true);
  assert.ok(late.routes.every((route) => route.marginSeconds.max < 0 && route.status === 'late'));
  assert.ok(!JSON.stringify(result).includes('probability'));
});

test('unsupported or reversed pairs and invalid input are errors, never invented routes', () => {
  assert.throws(
    () => searchRoutes(request('city-hall', 'seoul-station')),
    (error: unknown) => error instanceof PlanningError && error.code === 'UNSUPPORTED_PAIR',
  );
  assert.throws(
    () => searchRoutes({ ...request(), deadline: NOW - MINUTE }),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => searchRoutes(request('seoul-station', 'city-hall', { maxRunningMeters: -1 })),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
});

test('expired sampled timetable does not fabricate next headway, preserving whole-walk fallback', () => {
  const result = searchRoutes({
    ...request(),
    now: NOW + 80 * MINUTE,
    deadline: NOW + 120 * MINUTE,
    scheduleAnchorAt: NOW,
  });
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].title, '걷기만 이용');
  assert.ok(result.routes[0].segments.every((segment) => segment.mode === 'walk'));
});

test('an active journey can recalculate lateness after its deadline has passed', () => {
  const input = { ...request(), deadline: NOW + 10 * MINUTE };
  const initial = searchRoutes(input);
  const route = initial.routes.find((candidate) =>
    candidate.segments.some((segment) => segment.mode === 'subway'),
  )!;
  const finalIndex = route.segments.findIndex((segment) => segment.id.endsWith(':final'));
  const remaining = replanRemainingRoute(
    input,
    route,
    finalIndex,
    'walking-only',
    NOW + 12 * MINUTE,
  );
  assert.equal(remaining.allLate, true);
  assert.ok(remaining.routes[0].marginSeconds.max < 0);
  const refreshed = searchRoutes({
    ...input,
    purpose: 'replan',
    now: NOW + 12 * MINUTE,
    scheduleAnchorAt: initial.scheduleAnchorAt,
  });
  assert.equal(refreshed.allLate, true);
});

test('neutral resume refresh preserves current boarded vehicle and conservatively counts full remaining step', () => {
  const input = request();
  const route = searchRoutes(input).routes.find((candidate) =>
    candidate.segments.some((segment) => segment.mode === 'subway'),
  )!;
  const index = route.segments.findIndex((segment) => segment.mode === 'subway');
  const now = NOW + 9 * MINUTE;
  const result = refreshRemainingRoute(input, route, index, now);
  const refreshed = result.routes[0];
  assert.equal(refreshed.origin.id, route.segments[index].start.id);
  assert.equal(refreshed.segments[0].mode, 'subway');
  assert.equal(
    refreshed.segments[0].timeRange.latest,
    now + route.segments[index].durationSeconds.max * 1000,
  );
  assert.equal(refreshed.segments[0].connection, undefined);
  assert.ok(
    !refreshed.segments.some((segment) => segment.mode === 'wait' || segment.mode === 'hire'),
  );
  assert.ok(refreshed.reasons.some((reason) => reason.includes('전체 단계 시간이 남아')));
});

test('neutral refresh keeps held bicycle or unconfirmed return state without another rental', () => {
  const input = request('seongsu', 'konkuk', { allowBicycle: true, bicycleReady: true });
  const route = searchRoutes(input).routes.find((candidate) => candidate.bicycleMeters > 0)!;
  for (const mode of ['bicycle', 'return'] as const) {
    const index = route.segments.findIndex((segment) => segment.mode === mode);
    const result = refreshRemainingRoute(input, route, index, NOW + 5 * MINUTE);
    assert.equal(result.routes[0].segments[0].mode, mode);
    assert.equal(result.routes[0].bicycleRentals, 0);
    assert.ok(!result.routes[0].segments.some((segment) => segment.mode === 'hire'));
    assert.ok(!result.routes[0].segments.some((segment) => segment.mode === 'run'));
  }
});

test('live provider estimate never gets a fictitious schedule or improvement from running access', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const base: BaseRoute = {
    id: 'live-transit',
    title: '공급원 기준 경로',
    distanceMeters: 2000,
    durationSeconds: { min: 300, max: 300 },
    transfers: 0,
    segments: [
      {
        id: 'live-walk',
        mode: 'walk',
        title: '접근',
        instructions: '',
        distanceMeters: 200,
        durationSeconds: { min: 100, max: 100 },
        start: origin,
        end: origin,
        runAllowed: false,
      },
      {
        id: 'live-bus',
        mode: 'bus',
        title: '버스',
        instructions: '',
        distanceMeters: 1800,
        durationSeconds: { min: 200, max: 200 },
        start: origin,
        end: destination,
        runAllowed: false,
      },
    ],
  };
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test-provider',
    label: '공급원 조회 결과',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const result = planBaseRoutes(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW + 30 * MINUTE,
      preferences: { ...DEFAULT_PREFERENCES, allowRunning: true },
    },
    [base],
    provenance,
  );
  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].arrivalTime.latest, NOW + 300_000);
  assert.equal(result.routes[0].runningMeters, 0);
  // Without live vehicle data the route is on time only with a five-minute cushion.
  assert.equal(result.routes[0].status, 'on-time');
  assert.equal(
    planBaseRoutes(
      {
        origin,
        destination,
        now: NOW,
        deadline: NOW + 9 * MINUTE,
        preferences: DEFAULT_PREFERENCES,
      },
      [base],
      provenance,
    ).routes[0].status,
    'uncertain',
  );
  assert.ok(
    result.routes[0].risks.some(
      (risk) => risk.code === 'unverified-schedule' && risk.severity === 'warning',
    ),
  );
  assert.ok(result.routes[0].segments.every((segment) => segment.connection === undefined));
  const malformed = planBaseRoutes(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW + 30 * MINUTE,
      preferences: DEFAULT_PREFERENCES,
    },
    [{ ...base, durationSeconds: { min: 200, max: 200 } }],
    provenance,
  );
  assert.equal(malformed.routes.length, 0);
  assert.throws(
    () =>
      planBaseRoutes(
        { origin, destination, now: NOW, deadline: NOW - MINUTE, preferences: DEFAULT_PREFERENCES },
        [base],
        provenance,
      ),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
  const overdue = planBaseRoutes(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW - MINUTE,
      preferences: DEFAULT_PREFERENCES,
      purpose: 'replan',
    },
    [base],
    provenance,
  );
  assert.equal(overdue.allLate, true);
  assert.ok(overdue.routes[0].marginSeconds.max < 0);
  assert.throws(
    () =>
      planBaseRoutes(
        {
          origin,
          destination,
          now: NOW,
          deadline: NOW - 49 * 60 * MINUTE,
          preferences: DEFAULT_PREFERENCES,
          purpose: 'replan',
        },
        [base],
        provenance,
      ),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
});

test('urgent initial search preserves an elapsed deadline and compares the same routes starting now', () => {
  const input: PlanningRequest = { ...request(), purpose: 'urgent', deadline: NOW - 5 * MINUTE };
  const baseline = searchRoutes(request());
  const urgent = searchRoutes(input);
  assert.equal(input.deadline, NOW - 5 * MINUTE);
  assert.equal(urgent.generatedAt, NOW);
  assert.equal(urgent.allLate, true);
  assert.match(urgent.notice, /원래 약속 시간/);
  assert.deepEqual(
    urgent.routes.map((route) => route.arrivalTime),
    baseline.routes.map((route) => route.arrivalTime),
  );
  for (const route of urgent.routes) {
    assert.equal(route.status, 'late');
    assert.equal(
      route.marginSeconds.min,
      Math.floor((input.deadline - route.readyTime.latest) / 1000),
    );
    assert.equal(
      route.marginSeconds.max,
      Math.floor((input.deadline - route.readyTime.earliest) / 1000),
    );
    assert.ok(route.marginSeconds.max < -300);
  }
});

test("urgent Korean midnight search keeps yesterday's deadline as an absolute timestamp", () => {
  const now = Date.parse('2026-10-02T15:04:00Z'); // 10/3 00:04 KST.
  const deadline = Date.parse('2026-10-02T14:59:00Z'); // 10/2 23:59 KST.
  const result = searchRoutes({ ...request(), purpose: 'urgent', now, deadline });
  assert.equal(result.generatedAt, now);
  assert.equal(result.allLate, true);
  assert.ok(
    result.routes.every((route) => route.status === 'late' && route.marginSeconds.max < -300),
  );
  assert.equal(
    result.routes[0].readyTime.earliest + result.routes[0].marginSeconds.max * 1000,
    deadline,
  );
});

test('urgent accepts only the inclusive 48h window and a schedule anchor never relaxes normal search', () => {
  const window = 48 * 60 * MINUTE;
  for (const deadline of [NOW - window, NOW, NOW + window]) {
    const result = searchRoutes({ ...request(), purpose: 'urgent', deadline });
    assert.ok(result.routes.length > 0);
  }
  for (const deadline of [NOW - window - 1, NOW + window + 1]) {
    assert.throws(
      () => searchRoutes({ ...request(), purpose: 'urgent', deadline }),
      (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
    );
  }
  for (const purpose of [undefined, 'search'] as const) {
    assert.throws(
      () => searchRoutes({ ...request(), purpose, deadline: NOW - MINUTE, scheduleAnchorAt: NOW }),
      (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
    );
  }
  assert.equal(
    searchRoutes({ ...request(), purpose: 'replan', deadline: NOW - MINUTE, scheduleAnchorAt: NOW })
      .allLate,
    true,
  );
  assert.throws(
    () => searchRoutes({ ...request(), purpose: 'invalid' as never }),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
});

test('urgent live planning preserves provider durations without invented running gains or connections', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const base: BaseRoute = {
    id: 'urgent-provider-transit',
    title: '공급원 경로',
    distanceMeters: 2000,
    durationSeconds: { min: 300, max: 300 },
    transfers: 0,
    segments: [
      {
        id: 'approach',
        mode: 'walk',
        title: '접근',
        instructions: '',
        distanceMeters: 200,
        durationSeconds: { min: 100, max: 100 },
        start: origin,
        end: origin,
        runAllowed: false,
      },
      {
        id: 'vehicle',
        mode: 'bus',
        title: '버스',
        instructions: '',
        distanceMeters: 1800,
        durationSeconds: { min: 200, max: 200 },
        start: origin,
        end: destination,
        runAllowed: false,
      },
    ],
  };
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test-provider',
    label: '공급원 예상값',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const result = planBaseRoutes(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW - MINUTE,
      preferences: {
        ...DEFAULT_PREFERENCES,
        allowRunning: true,
        allowBicycle: true,
        bicycleReady: true,
      },
      purpose: 'urgent',
    },
    [base],
    provenance,
  );
  assert.equal(result.allLate, true);
  assert.equal(result.routes.length, 1);
  const route = result.routes[0];
  assert.equal(route.arrivalTime.latest, NOW + 300_000);
  assert.deepEqual(route.durationSeconds, base.durationSeconds);
  assert.equal(route.runningMeters, 0);
  assert.equal(route.bicycleMeters, 0);
  assert.ok(route.segments.every((segment) => segment.connection === undefined));
  assert.ok(route.risks.some((risk) => risk.code === 'unverified-schedule'));
  assert.equal(route.marginSeconds.min, Math.floor((NOW - MINUTE - route.readyTime.latest) / 1000));
});

test('trusted acceptance time affects the 48h boundary only and never rewinds ETA or permits normal overdue search', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const base: BaseRoute = {
    id: 'walk',
    title: '도보',
    distanceMeters: 100,
    durationSeconds: { min: 100, max: 100 },
    transfers: 0,
    segments: [
      {
        id: 'step',
        mode: 'walk',
        title: '도보',
        instructions: '',
        distanceMeters: 100,
        durationSeconds: { min: 100, max: 100 },
        start: origin,
        end: destination,
        runAllowed: false,
      },
    ],
  };
  const receivedAt = NOW + 3_000;
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test',
    label: '예상값',
    sourceTimestamp: null,
    receivedAt,
    isRealtime: false,
  };
  const input = {
    origin,
    destination,
    now: receivedAt,
    deadline: NOW - 48 * 60 * MINUTE,
    preferences: DEFAULT_PREFERENCES,
    purpose: 'urgent' as const,
  };
  const result = planBaseRoutes(input, [base], provenance, { deadlineValidationTime: NOW });
  assert.equal(result.generatedAt, receivedAt);
  assert.equal(result.routes[0].arrivalTime.latest, receivedAt + 100_000);
  assert.equal(result.allLate, true);
  assert.throws(
    () => planBaseRoutes(input, [base], provenance),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () =>
      planBaseRoutes({ ...input, purpose: 'search', deadline: NOW + 1_000 }, [base], provenance, {
        deadlineValidationTime: NOW,
      }),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => planBaseRoutes(input, [base], provenance, { deadlineValidationTime: receivedAt + 1 }),
    (error: unknown) => error instanceof PlanningError && error.code === 'INVALID_INPUT',
  );
});

test('urgent and replan preserve a genuine whole-walk fallback when faster transit fills all three slots', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const route = (id: string, mode: 'walk' | 'bus' | 'subway', seconds: number): BaseRoute => ({
    id,
    title: id,
    distanceMeters: 1000,
    durationSeconds: { min: seconds, max: seconds },
    transfers: 0,
    segments: [
      {
        id: `${id}-step`,
        mode,
        title: id,
        instructions: '',
        distanceMeters: 1000,
        durationSeconds: { min: seconds, max: seconds },
        start: origin,
        end: destination,
        runAllowed: false,
        polyline: [origin, destination],
      },
    ],
  });
  const bases = [
    route('walk-slower', 'walk', 900),
    route('bus-3', 'bus', 400),
    route('subway-fastest', 'subway', 200),
    route('bus-2', 'bus', 300),
    route('whole-walk', 'walk', 800),
  ];
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test',
    label: '공급원 예상값',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const input = {
    origin,
    destination,
    now: NOW,
    deadline: NOW - MINUTE,
    preferences: DEFAULT_PREFERENCES,
  };
  for (const purpose of ['urgent', 'replan'] as const) {
    const result = planBaseRoutes({ ...input, purpose }, bases, provenance);
    assert.deepEqual(
      result.routes.map((candidate) => candidate.id),
      ['subway-fastest', 'bus-2', 'whole-walk'],
    );
    assert.equal(result.routes.length, 3);
    assert.deepEqual(
      result.routes.map((candidate) => candidate.recommended),
      [true, false, false],
    );
    assert.equal(result.routes[2].durationSeconds.max, 800);
    assert.equal(result.routes[2].arrivalTime.latest, NOW + 800_000);
    assert.equal(result.allLate, true);
    assert.ok(
      result.routes[0].risks.some(
        (risk) => risk.code === 'unverified-schedule' && /첫차·막차/.test(risk.description),
      ),
    );
    assert.ok(
      result.routes.every((candidate) =>
        candidate.segments.every((segment) => segment.connection === undefined),
      ),
    );
  }
  const normal = planBaseRoutes(
    { ...input, deadline: NOW + 30 * MINUTE, purpose: 'search' },
    bases,
    provenance,
  );
  assert.deepEqual(
    normal.routes.map((candidate) => candidate.id),
    ['subway-fastest', 'bus-2', 'bus-3'],
  );
  const noWalk = planBaseRoutes(
    { ...input, purpose: 'urgent' },
    bases.filter((candidate) => candidate.segments[0].mode !== 'walk'),
    provenance,
  );
  assert.equal(noWalk.routes.length, 3);
  assert.ok(
    noWalk.routes.every((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'bus' || segment.mode === 'subway'),
    ),
  );
  assert.ok(!noWalk.routes.some((candidate) => candidate.title.includes('도보')));
});

test('a fastest walking option stays first and its provider overhead does not disqualify the fallback', () => {
  const origin = PLACES[0],
    destination = PLACES[1];
  const bases: BaseRoute[] = [
    {
      id: 'walk',
      title: '공급원 도보',
      distanceMeters: 1000,
      durationSeconds: { min: 200, max: 200 },
      transfers: 0,
      segments: [
        {
          id: 'walking',
          mode: 'walk',
          title: '도보',
          instructions: '',
          distanceMeters: 1000,
          durationSeconds: { min: 180, max: 180 },
          start: origin,
          end: destination,
          runAllowed: false,
        },
        {
          id: 'overhead',
          mode: 'wait',
          title: '공급원 추가 소요',
          instructions: '',
          distanceMeters: 0,
          durationSeconds: { min: 20, max: 20 },
          start: destination,
          end: destination,
          runAllowed: false,
        },
      ],
    },
  ];
  for (let index = 0; index < 4; index += 1) {
    const durationSeconds = { min: 300 + index * 100, max: 300 + index * 100 };
    bases.push({
      id: `bus-${index}`,
      title: '버스',
      distanceMeters: 1000,
      durationSeconds,
      transfers: 0,
      segments: [
        {
          id: `bus-step-${index}`,
          mode: 'bus',
          title: '버스',
          instructions: '',
          distanceMeters: 1000,
          durationSeconds,
          start: origin,
          end: destination,
          runAllowed: false,
        },
      ],
    });
  }
  const provenance: Provenance = {
    mode: 'live',
    provider: 'test',
    label: '예상값',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  };
  const result = planBaseRoutes(
    {
      origin,
      destination,
      now: NOW,
      deadline: NOW - MINUTE,
      preferences: DEFAULT_PREFERENCES,
      purpose: 'urgent',
    },
    bases,
    provenance,
  );
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ['walk', 'bus-0', 'bus-1'],
  );
  assert.equal(result.routes[0].recommended, true);
});
