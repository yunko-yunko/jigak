// Preserved regression cases from perception-map/mvp/tests/journeyGraphRequiredReachability.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import { hasBicycleAvailabilityEvidence } from '../src/common/shared/domain/vehicleConstraints.js';
import type { BaseRoute, BaseSegment, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.UTC(2026, 9, 16, 4, 27);

const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '통제된 연결 fixture',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});

const O = point('origin', 0),
  V = point('ddareungi-return', 300),
  M = point('ddareungi-hire', 600),
  D = point('destination', 900),
  X = point('disconnected', 1200);

function leg(
  id: string,
  mode: BaseSegment['mode'],
  from: Place,
  to: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '실제 조회 경계 fixture',
    start: from,
    end: to,
    distanceMeters: from === to ? 0 : 300,
    durationSeconds: {
      min: seconds,
      max: seconds,
    },
    runAllowed: false,
    ...(from !== to
      ? {
          polyline: [from, to],
        }
      : {}),
    ...extra,
  };
}

function source(id: string, segments: BaseSegment[]): BaseRoute {
  return {
    id,
    title: id,
    segments,
    transfers: 0,
    distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    durationSeconds: {
      min: segments.reduce((sum, segment) => sum + segment.durationSeconds.min, 0),
      max: segments.reduce((sum, segment) => sum + segment.durationSeconds.max, 0),
    },
  };
}

function rental(from = M, to = V, stock = true): BaseRoute {
  return source('bike', [
    leg(
      'hire',
      'hire',
      from,
      from,
      10,
      stock
        ? {
            bicycleAvailability: {
              source: 'seoul-bike',
              hireStationId: 'hire',
              returnStationId: 'return',
              availableBikes: 5,
              receivedAt: NOW,
              observedAt: null,
              returnPolicy: 'designated-station',
            },
          }
        : {
            rentalValidity: {
              verifiedAt: NOW,
              validUntil: NOW + 3_600_000,
              vehicleId: 'fixture-bike',
              provider: 'fixture',
            },
          },
    ),
    leg('ride', 'bicycle', from, to, 50, {
      routingProfile: 'bicycle',
    }),
    leg('return', 'return', to, to, 10),
  ]);
}

const request = () => ({
  origin: O,
  destination: D,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowRunning: false,
    allowBicycle: true,
    bicycleReady: true,
    maxBicycleMeters: 3000,
  },
});

const saturatedPrefixes = () =>
  Array.from(
    {
      length: 12,
    },
    (_, index) =>
      source(`prefix-${index}`, [
        leg(`bus-${index}`, 'bus', O, V, 10 + index, {
          lineName: `fixture-${index}`,
        }),
        leg('common-walk', 'walk', V, M, 10),
      ]),
  );

const viablePrefix = () => source('unvisited-prefix', [leg('unvisited-prefix', 'walk', O, M, 500)]);

const tail = () => source('tail', [leg('tail', 'walk', V, D, 60)]);

test('twelve structurally blocked prefixes cannot evict the only complete stock-backed bicycle history', () => {
  for (const sources of [
    [...saturatedPrefixes(), viablePrefix(), rental(), tail()],
    [viablePrefix(), ...saturatedPrefixes(), rental(), tail()],
  ]) {
    const result = planJourneyGraph(request(), sources, {
      receivedAt: NOW,
      maxResults: 1,
      requiredMode: 'bicycle',
    });

    assert.equal(result.routes.length, 1);
    assert.deepEqual(result.routes[0].durationSeconds, {
      min: 630,
      max: 630,
    });
    assert.equal(result.routes[0].segments[0].start.id, O.id);
    assert.equal(result.routes[0].segments[0].end.id, M.id);
    assert.equal(hasBicycleAvailabilityEvidence(result.routes[0].segments, NOW), true);
    assert.equal(
      result.diagnostics.limitReached,
      false,
      'impossible histories should not consume the bounded frontier',
    );
  }
});

test('the recovered history keeps the subsequent observed boarding clock and ordinary domain validation', () => {
  const liveTail = source('observed-tail', [
    leg('observed-bus', 'bus', V, D, 60, {
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: V.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [
          {
            line: '100',
            message: '통제된 예측',
            arrivesAt: NOW + 700_000,
          },
        ],
      },
    }),
  ]);
  const result = planJourneyGraph(
    request(),
    [...saturatedPrefixes(), viablePrefix(), rental(), liveTail],
    {
      receivedAt: NOW,
      maxResults: 1,
      requiredMode: 'bicycle',
    },
  );

  assert.deepEqual(result.routes[0]?.durationSeconds, {
    min: 760,
    max: 760,
  });

  const route = planBaseRoutes(request(), result.routes, {
    mode: 'live',
    provider: 'fixture',
    label: '조회 fixture',
    sourceTimestamp: null,
    receivedAt: NOW,
    isRealtime: false,
  }).routes[0];

  assert.deepEqual(route?.arrivalTime, {
    earliest: NOW + 760_000,
    latest: NOW + 760_000,
  });
  assert.equal(
    route.segments.find((segment) => segment.mode === 'bus')?.connection?.departureAt,
    NOW + 700_000,
  );
});

test('a required arc in an unreachable component cannot turn an ordinary path into a mode comparison', () => {
  const sources = [
    source('ordinary', [leg('ordinary', 'walk', O, D, 100)]),
    rental(X, V, false),
    tail(),
  ];
  const result = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    requiredMode: 'bicycle',
  });

  assert.equal(result.routes.length, 0);
  assert.equal(
    result.diagnostics.expanded,
    0,
    'no compiled directed path contains the requested mode',
  );
  assert.equal(result.diagnostics.limitReached, false);
});

test('reverse-facing required arcs never count as a directed path to the destination', () => {
  const sources = [
    source('access', [leg('access', 'walk', O, M, 100)]),
    rental(V, M, false),
    source('finish', [leg('finish', 'walk', M, D, 100)]),
  ];
  const result = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    requiredMode: 'bicycle',
  });

  assert.equal(result.routes.length, 0);
  assert.equal(result.diagnostics.expanded, 0);
});

test('a required arc beyond the destination cannot be used after a completed ordinary journey', () => {
  const result = planJourneyGraph(
    request(),
    [
      source('finish', [leg('finish', 'walk', O, D, 100)]),
      rental(D, X, false),
      source('back', [leg('back', 'walk', X, D, 100)]),
    ],
    {
      receivedAt: NOW,
      requiredMode: 'bicycle',
    },
  );

  assert.equal(result.routes.length, 0);
  assert.equal(result.diagnostics.expanded, 0);
});

test('the current visited node can depart through the required mode and need not encounter that mode twice', () => {
  const result = planJourneyGraph(request(), [rental(O, V, false), tail()], {
    receivedAt: NOW,
    requiredMode: 'bicycle',
  });

  assert.deepEqual(result.routes[0]?.durationSeconds, {
    min: 130,
    max: 130,
  });
  assert.equal(result.routes[0].segments.filter((segment) => segment.mode === 'bicycle').length, 1);
});

test('relaxing future visited nodes may retain an impossible structural cycle but cannot invent a complete route', () => {
  const sources = [
    source('access', [leg('access', 'walk', O, M, 100)]),
    rental(),
    source('back', [leg('back', 'walk', V, M, 100)]),
    source('finish', [leg('finish', 'walk', M, D, 100)]),
  ];
  const result = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    requiredMode: 'bicycle',
  });

  assert.equal(result.routes.length, 0);
  assert.ok(
    result.diagnostics.expanded > 0,
    'the safe structural over-approximation may admit a cycle that the actual visited gate rejects',
  );
});

test('structural reachability never replaces stock, permission, preference or geometry gates', () => {
  for (const failure of ['stock', 'permission', 'preference', 'geometry'] as const) {
    const lease = rental(),
      input = request();

    if (failure === 'stock') {
      lease.segments[0].bicycleAvailability!.availableBikes = 0;
    }

    if (failure === 'permission') {
      delete lease.segments[0].bicycleAvailability;

      lease.segments[0].rentalValidity = {
        verifiedAt: NOW,
        validUntil: NOW + 1_000,
        vehicleId: 'expired-on-return',
        provider: 'fixture',
      };
    }

    if (failure === 'preference') {
      input.preferences.allowBicycle = false;
    }

    if (failure === 'geometry') {
      lease.segments[1].polyline = undefined;
    }

    const result = planJourneyGraph(input, [viablePrefix(), lease, tail()], {
      receivedAt: NOW,
      requiredMode: 'bicycle',
    });

    assert.equal(result.routes.length, 0, failure);
  }
});

test('ordinary searches retain their complete routes when no required mode is requested', () => {
  const result = planJourneyGraph(
    request(),
    [source('ordinary', [leg('ordinary', 'walk', O, D, 100)])],
    {
      receivedAt: NOW,
    },
  );

  assert.deepEqual(result.routes[0]?.durationSeconds, {
    min: 100,
    max: 100,
  });
});
