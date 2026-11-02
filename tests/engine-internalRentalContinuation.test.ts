// Regression cases from mvp/tests/internalRentalContinuation.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { ApiError } from '../src/common/engine/errors.js';
import {
  buildMixedModeBridges,
  type BridgeGenerationDiagnostics,
} from '../src/common/engine/mixed-mode-bridges.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import type { RouteEndpoints, RouteProvider } from '../src/common/engine/kakao.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';

const now = Date.UTC(2026, 9, 28, 3);
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '',
  latitude: 37.55,
  longitude: 126.97 + meters / 88_000,
});
const origin = point('origin', 0),
  firstPlatform = point('first-platform', 10_000),
  secondPlatform = point('second-platform', 11_000);
const hire = point('actual-hire', 10_020),
  drop = point('actual-drop', 10_980),
  destination = point('destination', 21_000);
const preferences = {
  ...DEFAULT_PREFERENCES,
  preparationSeconds: 0,
  allowRunning: false,
  allowBicycle: true,
  bicycleReady: true,
  maxBicycleMeters: 1_500,
  allowScooter: false,
  allowTaxi: false,
};
const request = { origin, destination, preferences, now, deadline: now + 3_600_000 };
function leg(
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '통제된 실제 연결 fixture',
    start,
    end,
    distanceMeters: start === end ? 0 : metersBetween(start, end),
    durationSeconds: { min: seconds, max: seconds },
    runAllowed: false,
    ...(start === end ? {} : { polyline: [start, end] }),
    ...(mode === 'subway'
      ? { lineName: '1호선', transit: { lines: ['1호선'], stops: [start.name, end.name] } }
      : {}),
    ...(mode === 'walk'
      ? {
          routingSource: {
            mode: 'live' as const,
            provider: 'osrm-foot',
            label: '실제 보행망 fixture',
            receivedAt: now,
            sourceTimestamp: null,
            isRealtime: false,
          },
          networkSnap: { startMeters: 0, endMeters: 0, allowanceSeconds: 0 },
        }
      : {}),
  };
}
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (sum, segment) => ({
      min: sum.min + segment.durationSeconds.min,
      max: sum.max + segment.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});
const original = route('original', [
  leg('first-wait', 'wait', origin, origin, 30),
  leg('first-train', 'subway', origin, firstPlatform, 300),
  leg('middle-wait', 'wait', firstPlatform, firstPlatform, 30),
  leg('slow-middle-train', 'subway', firstPlatform, secondPlatform, 1_800),
  leg('last-wait', 'wait', secondPlatform, secondPlatform, 30),
  leg('last-train', 'subway', secondPlatform, destination, 300),
]);
type Failure =
  | 'empty-prefix'
  | 'empty-suffix'
  | 'mismatched-prefix'
  | 'mismatched-suffix'
  | 'unverified-prefix'
  | 'unverified-suffix'
  | 'failed-suffix';
async function acquire(
  options: { limit?: number; failure?: Failure; cachedPrefix?: boolean } = {},
) {
  const budget = new CallBudget(options.limit ?? 3),
    transitCalls: RouteEndpoints[] = [],
    protectedRemaining: number[] = [];
  let bicycleCalls = 0,
    diagnostics!: BridgeGenerationDiagnostics;
  const mobility = new MobilityFeeds({
    seoulBikeKey: 'fixture',
    now: () => now,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          rentBikeStatus: {
            list_total_count: 2,
            RESULT: { CODE: 'INFO-000' },
            row: [hire, drop].map((station, index) => ({
              stationId: `internal-${index}`,
              stationName: station.name,
              stationLatitude: station.latitude,
              stationLongitude: station.longitude,
              parkingBikeTotCnt: 5,
              rackTotCnt: 10,
            })),
          },
        }),
      ),
  });
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    transit: async () => [],
    walking: async () => {
      throw new Error('a platform must not be treated as a rental endpoint');
    },
    bicycle: async (endpoints, shared) =>
      shared.run(() => {
        bicycleCalls++;
        assert.equal(endpoints.origin.id, 'ddareungi-internal-0');
        assert.equal(endpoints.destination.id, 'ddareungi-internal-1');
        return [
          route('actual-bicycle', [
            {
              ...leg('actual-bicycle', 'bicycle', endpoints.origin, endpoints.destination, 100),
              routingProfile: 'bicycle',
            },
          ]),
        ];
      }),
  };
  const isPrefix = (endpoints: RouteEndpoints) => endpoints.origin.id === origin.id;
  const bridges = await buildMixedModeBridges(request, [original], {
    provider,
    mobility,
    budget,
    now,
    acquisitionObjective: 'estimated-arrival',
    queryCallCost: (mode, endpoints) =>
      mode === 'transit' && options.cachedPrefix && isPrefix(endpoints) ? 0 : 1,
    connectTransit: async (endpoints) => {
      const work = () => {
        transitCalls.push(endpoints);
        protectedRemaining.push(budget.remaining);
        const prefix = isPrefix(endpoints),
          side = prefix ? 'prefix' : 'suffix';
        if (options.failure === `empty-${side}`) return [];
        if (options.failure === 'failed-suffix' && !prefix)
          throw new ApiError('NO_ROUTES', 'fixture missing suffix', 404);
        const walk = prefix
          ? leg('platform-to-hire', 'walk', firstPlatform, endpoints.destination, 20)
          : leg('drop-to-platform', 'walk', endpoints.origin, secondPlatform, 20);
        if (options.failure === `mismatched-${side}`) {
          if (prefix) walk.end = point('unrelated-hire', 12_000);
          else walk.start = point('unrelated-drop', 9_000);
        }
        if (options.failure === `unverified-${side}`) {
          delete walk.polyline;
          delete walk.routingSource;
          delete walk.networkSnap;
        }
        return [
          prefix
            ? route('fresh-prefix', [
                leg('fresh-first-wait', 'wait', origin, origin, 30),
                leg('fresh-first-train', 'subway', origin, firstPlatform, 300),
                walk,
              ])
            : route('fresh-suffix', [
                walk,
                leg('fresh-last-wait', 'wait', secondPlatform, secondPlatform, 30),
                leg('fresh-last-train', 'subway', secondPlatform, destination, 300),
              ]),
        ];
      };
      return options.cachedPrefix && isPrefix(endpoints) ? work() : budget.run(work);
    },
    onDiagnostics: (value) => {
      diagnostics = value;
    },
  });
  return { bridges, budget, transitCalls, protectedRemaining, bicycleCalls, diagnostics };
}

test('an internal train section can be replaced by a complete rental between two real transit continuations', async () => {
  const result = await acquire();
  assert.equal(result.transitCalls.length, 2);
  assert.deepEqual(result.transitCalls[0].origin, origin);
  assert.equal(result.transitCalls[0].destination.id, 'ddareungi-internal-0');
  assert.equal(result.transitCalls[0].destination.longitude, hire.longitude);
  assert.equal(result.transitCalls[1].origin.id, 'ddareungi-internal-1');
  assert.equal(result.transitCalls[1].origin.longitude, drop.longitude);
  assert.deepEqual(result.transitCalls[1].destination, destination);
  // Both halves start together, each taking its slot before either is enriched.
  assert.deepEqual(
    result.protectedRemaining,
    [1, 0],
    'the prefix cannot spend the final suffix query slot',
  );
  assert.equal(result.budget.used, 3);
  assert.equal(result.diagnostics.rentalConnections, 1);
  const graph = planJourneyGraph(request, [original, ...result.bridges], {
    receivedAt: now,
    objective: 'estimated-arrival',
    maxResults: 1,
  });
  const winner = graph.routes[0];
  assert.deepEqual(
    winner.segments
      .filter((segment) => ['subway', 'bicycle'].includes(segment.mode))
      .map((segment) => segment.mode),
    ['subway', 'bicycle', 'subway'],
  );
  assert.deepEqual(
    winner.durationSeconds,
    { min: 860, max: 860 },
    'both trains, both station walks, riding and the one minute of hire and return contribute',
  );
  assert.equal(
    winner.segments.find((segment) => segment.mode === 'hire')?.start.id,
    'ddareungi-internal-0',
  );
  assert.equal(
    winner.segments.find((segment) => segment.mode === 'return')?.end.id,
    'ddareungi-internal-1',
  );
});

for (const failure of [
  'empty-prefix',
  'empty-suffix',
  'mismatched-prefix',
  'mismatched-suffix',
  'unverified-prefix',
  'unverified-suffix',
  'failed-suffix',
] as const) {
  test(`${failure} never publishes a partial internal rental as a connected journey`, async () => {
    const result = await acquire({ failure });
    assert.ok(
      result.transitCalls.length > 0,
      'the missing side must be discovered through an actual continuation lookup',
    );
    assert.equal(
      result.bridges.length,
      0,
      'stage both transit sides before publishing their rental fragments',
    );
    assert.equal(result.diagnostics.rentalConnections, 0);
    assert.ok(result.diagnostics.unavailableRentals > 0);
    assert.ok(result.budget.used <= result.budget.limit);
    const graph = planJourneyGraph(request, [original, ...result.bridges], {
      receivedAt: now,
      requiredMode: 'bicycle',
    });
    assert.equal(graph.routes.length, 0);
  });
}

test('a scarce budget refuses an internal rental before paying for an incomplete ride', async () => {
  const result = await acquire({ limit: 2 });
  assert.equal(result.bicycleCalls, 0);
  assert.equal(result.transitCalls.length, 0);
  assert.equal(result.bridges.length, 0);
  assert.equal(result.budget.used, 0);
  assert.ok(result.diagnostics.budgetSkipped > 0);
  assert.equal(result.diagnostics.limitReached, true);
});

test('a reused prefix saves its query slot without bypassing the two-sided endpoint checks', async () => {
  const result = await acquire({ limit: 2, cachedPrefix: true });
  assert.equal(result.transitCalls.length, 2);
  assert.equal(result.bicycleCalls, 1);
  assert.equal(result.budget.used, 2);
  assert.equal(result.diagnostics.rentalConnections, 1);
});
