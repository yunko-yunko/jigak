// Preserved regression cases from perception-map/mvp/tests/journeyGraphOptimality.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { applyContextualEtaTiming } from '../src/common/engine/intelligence/learning-features.js';
import {
  estimateBaseTimeline,
  type RoutingObjective,
} from '../src/common/shared/domain/estimatedTiming.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Place,
} from '../src/common/shared/domain/types.js';

const NOW = Date.UTC(2026, 9, 16, 5);

const place = (index: number): Place => ({
  id: `p${index}`,
  name: `p${index}`,
  address: '검증한 환승 지점',
  latitude: 37.5 + index / 100,
  longitude: 127,
});

const points = Array.from(
  {
    length: 30,
  },
  (_, index) => place(index),
);

const request = (destination = points[5], preferences = {}): BasePlanningRequest => ({
  origin: points[0],
  destination,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: {
    ...DEFAULT_PREFERENCES,
    allowRunning: true,
    allowBicycle: true,
    bicycleReady: true,
    maxRunningMeters: 700,
    maxBicycleMeters: 1_000,
    ...preferences,
  },
});

function leg(
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment {
  return {
    id,
    mode,
    title: id,
    instructions: '공급원에서 확인한 구간',
    start,
    end,
    distanceMeters: start === end ? 0 : 300,
    durationSeconds: {
      min: seconds,
      max: seconds,
    },
    runAllowed: mode === 'run',
    ...(start === end
      ? {}
      : {
          polyline: [start, end],
        }),
    ...extra,
  };
}

function route(id: string, segments: BaseSegment[]): BaseRoute {
  return {
    id,
    title: id,
    segments,
    transfers: 0,
    distanceMeters: segments.reduce((total, segment) => total + segment.distanceMeters, 0),
    durationSeconds: segments.reduce(
      (total, segment) => ({
        min: total.min + segment.durationSeconds.min,
        max: total.max + segment.durationSeconds.max,
      }),
      {
        min: 0,
        max: 0,
      },
    ),
  };
}

// The oracle enumerates logical journeys independently of graph compilation,
// pruning, ranking and timeline helpers. It includes every hire/return and taxi
// pickup, absolute vehicle departures, uncertainty and cumulative rider limits.
interface Edge {
  id: string;
  from: number;
  to: number;
  mode: 'walk' | 'run' | 'bicycle' | 'taxi' | 'bus';
  min: number;
  max: number;
  meters: number;
  departures?: number[];
}

interface Outcome {
  min: number;
  max: number;
  estimated: number;
  score: number;
  path: Edge[];
}

const penalty = (modes: string[]) => (modes.includes('run') && modes.includes('taxi') ? 90 : 0);

function enumerate(
  edges: Edge[],
  input: BasePlanningRequest,
  correction: boolean,
  objective: RoutingObjective = 'conservative-arrival',
): Outcome[] {
  const results: Outcome[] = [];

  function visit(
    node: number,
    min: number,
    max: number,
    estimated: number,
    running: number,
    cycling: number,
    path: Edge[],
  ) {
    if (node === 5) {
      results.push({
        min,
        max,
        estimated,
        score:
          (objective === 'estimated-arrival' ? estimated : max) +
          (correction ? penalty(path.map((edge) => edge.mode)) : 0),
        path,
      });

      return;
    }

    for (const edge of edges.filter((edge) => edge.from === node)) {
      const nextRunning = running + (edge.mode === 'run' ? edge.meters : 0),
        nextCycling = cycling + (edge.mode === 'bicycle' ? edge.meters : 0);

      if (
        nextRunning > input.preferences.maxRunningMeters ||
        nextCycling > input.preferences.maxBicycleMeters
      ) {
        continue;
      }

      let first = min,
        last = max,
        point = estimated;

      if (edge.departures) {
        const firstDeparture = edge.departures.find((second) => second >= min + 30),
          lastDeparture = edge.departures.find((second) => second >= max + 30);

        if (firstDeparture === undefined || lastDeparture === undefined) {
          continue;
        }

        first = firstDeparture;
        last = lastDeparture;
        point = edge.departures.find((second) => second >= estimated + 30)!;
      }

      const overhead = edge.mode === 'bicycle' ? 35 : edge.mode === 'taxi' ? 45 : 0;

      visit(
        edge.to,
        first + edge.min + overhead,
        last + edge.max + overhead,
        point + (edge.min + edge.max) / 2 + overhead,
        nextRunning,
        nextCycling,
        [...path, edge],
      );
    }
  }

  visit(0, 0, 0, 0, 0, 0, []);

  return results.sort((a, b) => a.score - b.score || a.min - b.min);
}

function supply(edge: Edge): BaseRoute {
  const from = points[edge.from],
    to = points[edge.to];
  const ride = leg(edge.id, edge.mode, from, to, edge.min, {
    distanceMeters: edge.meters,
    durationSeconds: {
      min: edge.min,
      max: edge.max,
    },
    ...(edge.mode === 'bicycle'
      ? {
          routingProfile: 'bicycle' as const,
        }
      : {}),
    ...(edge.departures
      ? {
          realtime: {
            provider: 'seoul-bus' as const,
            status: 'live' as const,
            stopName: from.name,
            observedAt: NOW,
            receivedAt: NOW,
            predictions: edge.departures.map((second, index) => ({
              line: edge.id,
              message: '확인한 도착편',
              arrivesAt: NOW + second * 1_000,
              lastService: index === edge.departures!.length - 1,
            })),
          },
        }
      : {}),
  });

  return route(
    edge.id,
    edge.mode === 'bicycle'
      ? [
          leg(`${edge.id}-hire`, 'hire', from, from, 20),
          ride,
          leg(`${edge.id}-return`, 'return', to, to, 15),
        ]
      : edge.mode === 'taxi'
        ? [leg(`${edge.id}-pickup`, 'wait', from, from, 45), ride]
        : [ride],
  );
}

test('exact and production searches match independent exhaustive door-to-door enumeration with departures, uncertain access and resource budgets', () => {
  const usedModes = new Set<string>();
  let feasibleJourneys = 0;

  for (let seed = 1; seed <= 32; seed++) {
    let randomState = seed;

    const random = (bound: number) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;

      return randomState % bound;
    };

    const edges: Edge[] = [];

    for (let from = 0; from < 5; from++) {
      for (let to = from + 1; to <= 5; to++) {
        const count = 1 + random(2);

        for (let alternative = 0; alternative < count; alternative++) {
          const mode = (['walk', 'run', 'bicycle', 'taxi', 'bus'] as const)[random(5)],
            min = 30 + random(150);

          edges.push({
            id: `s${seed}-${from}-${to}-${alternative}`,
            from,
            to,
            mode,
            min,
            max: min + random(70),
            meters: 100 + random(500),
            ...(mode === 'bus'
              ? {
                  departures: [90, 180, 300, 480, 720, 1_080, 1_800],
                }
              : {}),
          });
        }
      }
    }

    const input = request(points[5], {
      maxRunningMeters: 250 + random(500),
      maxBicycleMeters: 400 + random(800),
    });
    const correction = seed % 2 === 0,
      expected = enumerate(edges, input, correction);

    feasibleJourneys += expected.length;

    for (const edge of expected[0].path) {
      usedModes.add(edge.mode);
    }

    for (const searchMode of ['exact', 'bounded'] as const) {
      const actual = planJourneyGraph(input, edges.map(supply), {
        receivedAt: NOW,
        searchMode,
        maxResults: 1,
        ...(correction
          ? {
              scoreCompleteRoute: (candidate: BaseRoute) =>
                candidate.durationSeconds.max +
                penalty(candidate.segments.map((segment) => segment.mode)),
            }
          : {}),
      });

      assert.deepEqual(
        actual.routes[0]?.durationSeconds,
        {
          min: expected[0].min,
          max: expected[0].max,
        },
        `seed ${seed}, ${searchMode}`,
      );
      assert.equal(
        actual.diagnostics.bestObjectiveSeconds,
        expected[0].score,
        `whole-journey objective, seed ${seed}`,
      );
      assert.equal(actual.diagnostics.optimalityProven, true);
      assert.equal(actual.diagnostics.optimalityGapSeconds, 0);

      const planned = planBaseRoutes(input, actual.routes, {
        mode: 'live',
        provider: 'fixture',
        label: '조회 구간',
        sourceTimestamp: null,
        receivedAt: NOW,
        isRealtime: false,
      });

      assert.deepEqual(
        planned.routes[0]?.arrivalTime,
        {
          earliest: NOW + expected[0].min * 1_000,
          latest: NOW + expected[0].max * 1_000,
        },
        'the domain must preserve composed physical arrival',
      );
    }
  }

  assert.ok(
    feasibleJourneys > 500,
    'the exhaustive oracle must compare branching complete journeys',
  );
  assert.ok(usedModes.size >= 4, 'the optimum matrix must exercise actual mode competition');
});

test('a slower walking prefix survives faster running prefixes that exhaust the only feasible continuation resource', () => {
  const input = request(points[5], {
    maxRunningMeters: 150,
  });
  const fast = Array.from(
    {
      length: 16,
    },
    (_, index) =>
      route(`quick-${index}`, [
        leg(`quick-${index}`, 'run', points[0], points[1], 10 + index, {
          distanceMeters: 100,
        }),
      ]),
  );
  const viable = route('preserve-running', [
    leg('preserve-running', 'walk', points[0], points[1], 80),
  ]);
  const tail = route('last-run', [
    leg('last-run', 'run', points[1], points[5], 20, {
      distanceMeters: 120,
    }),
  ]);

  for (const sources of [
    [...fast, viable, tail],
    [tail, viable, ...fast.reverse()],
  ]) {
    const result = planJourneyGraph(input, sources, {
      receivedAt: NOW,
      maxResults: 1,
      maxLabelsPerState: 1,
    });

    assert.equal(result.routes[0]?.durationSeconds.max, 100);
    assert.deepEqual(
      result.routes[0].segments.map((segment) => segment.mode),
      ['walk', 'run'],
    );
    assert.equal(result.diagnostics.optimalityProven, true);
  }
});

test('equal-time prefixes with distinct final eligibility evidence cannot evict the only accepted complete journey', () => {
  const prefixes = Array.from(
    {
      length: 14,
    },
    (_, index) =>
      route(`access-${index}`, [
        leg(`access-${index}`, 'walk', points[0], points[1], 50, {
          routingSource: {
            mode: 'live',
            provider: index === 13 ? 'accepted-provider' : `other-${index}`,
            label: '확인한 경로',
            sourceTimestamp: null,
            receivedAt: NOW,
            isRealtime: false,
          },
        }),
      ]),
  );
  const tail = route('tail', [leg('tail', 'walk', points[1], points[5], 50)]);
  const result = planJourneyGraph(request(), [...prefixes, tail], {
    receivedAt: NOW,
    maxResults: 1,
    maxLabelsPerState: 1,
    acceptRoute: (candidate) =>
      candidate.segments[0].routingSource?.provider === 'accepted-provider',
  });

  assert.equal(result.routes[0]?.durationSeconds.max, 100);
  assert.equal(result.routes[0]?.segments[0].routingSource?.provider, 'accepted-provider');
  assert.equal(result.diagnostics.optimalityProven, true);
});

test('actual remaining-network bounds recover the fastest composed route under a tight expansion budget', () => {
  const traps = Array.from(
    {
      length: 15,
    },
    (_, index) => [
      route(`trap-head-${index}`, [
        leg(`trap-head-${index}`, 'walk', points[0], points[index + 6], 1),
      ]),
      route(`trap-tail-${index}`, [
        leg(`trap-tail-${index}`, 'walk', points[index + 6], points[5], 900),
      ]),
    ],
  ).flat();
  const winner = [
    route('winner-head', [leg('winner-head', 'walk', points[0], points[1], 10)]),
    route('winner-tail', [leg('winner-tail', 'walk', points[1], points[5], 10)]),
  ];
  const result = planJourneyGraph(request(), [...traps, ...winner], {
    receivedAt: NOW,
    maxResults: 1,
    maxExpansions: 3,
  });

  assert.equal(result.routes[0]?.durationSeconds.max, 20);
  assert.equal(
    result.diagnostics.expanded,
    3,
    'origin, winning transfer, destination fit the actual production budget',
  );
  assert.equal(result.diagnostics.optimalityProven, true);
  assert.ok(result.diagnostics.unexploredLowerBoundSeconds! > 20);
  assert.equal(result.diagnostics.limitReached, false);
});

test('a truncated graph cannot certify a slower route, while exact mode ignores computational caps and finds the omitted connection', () => {
  const sources = [
    route('direct', [leg('direct', 'walk', points[0], points[5], 500)]),
    route('head', [leg('head', 'walk', points[0], points[1], 100)]),
    route('tail', [leg('tail', 'walk', points[1], points[5], 100)]),
  ];
  const bounded = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    maxResults: 1,
    maxEdges: 2,
  });

  assert.equal(bounded.routes[0]?.durationSeconds.max, 500);
  assert.equal(bounded.diagnostics.optimalityProven, false);
  assert.equal(bounded.diagnostics.unexploredLowerBoundSeconds, 0);
  assert.equal(bounded.diagnostics.optimalityGapSeconds, 500);

  const exact = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    searchMode: 'exact',
    maxResults: 1,
    maxEdges: 2,
    maxExpansions: 1,
    maxLabelsPerState: 1,
  });

  assert.equal(exact.routes[0]?.durationSeconds.max, 200);
  assert.equal(exact.diagnostics.optimalityProven, true);
});

test('the production leg cap reports an unresolved cheaper continuation and exact validation can follow the full supplied journey', () => {
  const sources = Array.from(
    {
      length: 25,
    },
    (_, index) =>
      route(`link-${index}`, [leg(`link-${index}`, 'walk', points[index], points[index + 1], 10)]),
  );

  sources.push(route('direct', [leg('direct', 'walk', points[0], points[25], 1_000)]));

  const bounded = planJourneyGraph(request(points[25]), sources, {
    receivedAt: NOW,
    maxResults: 1,
  });

  assert.equal(bounded.routes[0]?.durationSeconds.max, 1_000);
  assert.equal(bounded.diagnostics.optimalityProven, false);
  assert.equal(bounded.diagnostics.unexploredLowerBoundSeconds, 250);
  assert.equal(bounded.diagnostics.optimalityGapSeconds, 750);

  const exact = planJourneyGraph(request(points[25]), sources, {
    receivedAt: NOW,
    maxResults: 1,
    searchMode: 'exact',
  });

  assert.equal(exact.routes[0]?.durationSeconds.max, 250);
  assert.equal(exact.diagnostics.optimalityProven, true);
});

test('source-duration lower bounds are disabled when a downstream context prediction can shorten travel', () => {
  const sources = [
    route('direct', [leg('direct', 'walk', points[0], points[5], 300)]),
    route('head', [leg('head', 'walk', points[0], points[1], 10)]),
    route('predicted-tail', [leg('predicted-tail', 'walk', points[1], points[5], 1_000)]),
  ];
  const result = planJourneyGraph(request(), sources, {
    receivedAt: NOW,
    maxResults: 1,
    contextualEta: {
      weather: null,
      predict: (features) =>
        features.predictedSeconds === 1_000
          ? {
              medianSeconds: 20,
              lowerSeconds: 20,
              upperSeconds: 20,
              modelVersion: 'eta-context-v2',
            }
          : null,
    },
  });

  assert.equal(result.routes[0]?.durationSeconds.max, 30);
  assert.equal(result.diagnostics.optimalityProven, true);
});

test('equal initial predictions preserve different source baselines when the downstream time-dependent model changes their order', () => {
  // These are the same supplied physical connection with different provider
  // baselines. At query time the context model ties them; at the actual transfer
  // time they differ. An independent enumeration uses the original baselines.
  const edges = [
    {
      from: 0,
      to: 1,
      mode: 'walk' as const,
      baseline: 100,
      meters: 300,
    },
    {
      from: 0,
      to: 1,
      mode: 'run' as const,
      baseline: 20,
      meters: 100,
    },
    {
      from: 1,
      to: 5,
      mode: 'walk' as const,
      baseline: 200,
      meters: 300,
    },
    {
      from: 1,
      to: 5,
      mode: 'walk' as const,
      baseline: 400,
      meters: 300,
    },
    {
      from: 0,
      to: 5,
      mode: 'walk' as const,
      baseline: 300,
      meters: 1_000,
    },
  ];

  const seconds = (baseline: number, entered: number) =>
    baseline === 200
      ? entered >= 90
        ? 300
        : 100
      : baseline === 400
        ? entered >= 90
          ? 50
          : 100
        : baseline;

  const outcomes: {
    seconds: number;
    baseline: number[];
  }[] = [];

  const visit = (node: number, elapsed: number, usedRunning: number, baseline: number[]) => {
    if (node === 5) {
      outcomes.push({
        seconds: elapsed,
        baseline,
      });

      return;
    }

    for (const edge of edges.filter((edge) => edge.from === node)) {
      const running = usedRunning + (edge.mode === 'run' ? edge.meters : 0);

      if (running > 50) {
        continue;
      }

      visit(edge.to, elapsed + seconds(edge.baseline, elapsed), running, [
        ...baseline,
        edge.baseline,
      ]);
    }
  };

  visit(0, 0, 0, []);

  outcomes.sort((a, b) => a.seconds - b.seconds);

  assert.equal(outcomes[0].seconds, 150);

  const input = request(points[5], {
    maxRunningMeters: 50,
  });

  const predict = (
    features: Parameters<
      NonNullable<Parameters<typeof planJourneyGraph>[2]['contextualEta']>['predict']
    >[0],
  ) => {
    const value = seconds(features.predictedSeconds, (features.startedAt - NOW) / 1_000);

    return {
      lowerSeconds: value,
      medianSeconds: value,
      upperSeconds: value,
      modelVersion: 'eta-context-v2' as const,
    };
  };

  const raw = edges.map((edge, index) =>
    route(`source-${index}`, [
      leg(`source-${index}`, edge.mode, points[edge.from], points[edge.to], edge.baseline, {
        distanceMeters: edge.meters,
      }),
    ]),
  );
  const initiallyPredicted = applyContextualEtaTiming(raw, input, null, predict);

  assert.deepEqual(
    initiallyPredicted[2].segments[0].durationSeconds,
    initiallyPredicted[3].segments[0].durationSeconds,
  );

  for (const sources of [initiallyPredicted, [...initiallyPredicted].reverse()]) {
    for (const searchMode of ['bounded', 'exact'] as const) {
      const actual = planJourneyGraph(input, sources, {
        receivedAt: NOW,
        searchMode,
        maxResults: 1,
        contextualEta: {
          weather: null,
          predict,
        },
      });

      assert.equal(
        actual.diagnostics.bestObjectiveSeconds,
        outcomes[0].seconds,
        'deduplication must retain distinct inputs to a future prediction',
      );
      assert.equal(actual.diagnostics.optimalityProven, true);

      const planned = planBaseRoutes(input, actual.routes, {
        mode: 'live',
        provider: 'fixture',
        label: '시간별 공급원 모델 fixture',
        sourceTimestamp: null,
        receivedAt: NOW,
        isRealtime: false,
      });

      assert.equal(planned.routes[0]?.arrivalTime.latest, NOW + outcomes[0].seconds * 1_000);
    }
  }
});

test('a headway decrease inside uncertain station access cannot make the conservative route faster than a feasible earlier-arrival scenario', () => {
  const departure = Date.parse('2026-10-16T08:29:00Z'); // 17:29 KST, peak starts one minute later.
  const input = {
    ...request(),
    now: departure,
    deadline: departure + 3_600_000,
  };
  const access = route('uncertain-access', [
    leg('access', 'walk', points[0], points[1], 5, {
      durationSeconds: {
        min: 5,
        max: 65,
      },
    }),
  ]);
  const ride = leg('rail', 'subway', points[1], points[5], 60);
  const direct = route('direct', [leg('direct', 'walk', points[0], points[5], 300)]);
  // Enumerate independently across the policy discontinuity, not just the two
  // access endpoints. The 59.5-second access finishes later than the 65-second one.
  const arrivals = Array.from(
    {
      length: 121,
    },
    (_, index) => 5 + index / 2,
  ).map((accessSeconds) => accessSeconds + (accessSeconds < 60 ? 210 : 120) + 60);

  assert.equal(Math.max(...arrivals), 329.5);

  for (const suppliedWait of [false, true]) {
    const transit = route('subway', [
      ...(suppliedWait
        ? [
            leg('rail-expected-wait', 'wait', points[1], points[1], 210, {
              expectedWaitBasisSeconds: 210,
            }),
          ]
        : []),
      ride,
    ]);
    const graph = planJourneyGraph(input, [access, transit, direct], {
      receivedAt: departure,
      searchMode: 'exact',
      maxResults: 3,
    });
    const viaRail = graph.routes.find((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'subway'),
    );

    assert.ok(viaRail);
    assert.ok(
      viaRail.durationSeconds.max >= Math.max(...arrivals),
      'the upper envelope must cover arrivals before and after the headway change',
    );
    assert.equal(
      graph.routes[0].durationSeconds.max,
      300,
      'a falsely shortened headway must not displace the faster conservative direct route',
    );

    const replayed = planJourneyGraph(input, graph.routes, {
      receivedAt: departure,
      searchMode: 'exact',
      maxResults: 3,
    });
    const replayedRail = replayed.routes.find((candidate) =>
      candidate.segments.some((segment) => segment.mode === 'subway'),
    );

    assert.ok(replayedRail);
    assert.deepEqual(
      replayedRail.durationSeconds,
      viaRail.durationSeconds,
      're-evaluation must not accumulate an already included time-dependent wait envelope',
    );
  }
});

test('estimated arrival follows a real catchable vehicle and chooses the independent resource-constrained optimum instead of the safest upper bound', () => {
  const edges: Edge[] = [
    {
      id: 'walk-access',
      from: 0,
      to: 1,
      mode: 'walk',
      min: 10,
      max: 110,
      meters: 300,
    },
    {
      id: 'run-access',
      from: 0,
      to: 1,
      mode: 'run',
      min: 20,
      max: 20,
      meters: 100,
    },
    {
      id: 'bus',
      from: 1,
      to: 3,
      mode: 'bus',
      min: 80,
      max: 80,
      meters: 1_000,
      departures: [90, 180, 360],
    },
    {
      id: 'last-run',
      from: 3,
      to: 5,
      mode: 'run',
      min: 50,
      max: 50,
      meters: 150,
    },
    {
      id: 'last-walk',
      from: 3,
      to: 5,
      mode: 'walk',
      min: 100,
      max: 100,
      meters: 150,
    },
    {
      id: 'rental',
      from: 0,
      to: 2,
      mode: 'bicycle',
      min: 10,
      max: 200,
      meters: 400,
    },
    {
      id: 'rental-egress',
      from: 2,
      to: 3,
      mode: 'walk',
      min: 80,
      max: 80,
      meters: 300,
    },
    {
      id: 'direct',
      from: 0,
      to: 5,
      mode: 'walk',
      min: 250,
      max: 250,
      meters: 1_500,
    },
  ];
  const input = request(points[5], {
    maxRunningMeters: 150,
    maxBicycleMeters: 500,
  });

  for (const objective of ['conservative-arrival', 'estimated-arrival'] as const) {
    const expected = enumerate(edges, input, false, objective)[0];

    assert.equal(expected.score, objective === 'estimated-arrival' ? 220 : 250);

    for (const searchMode of ['bounded', 'exact'] as const) {
      const actual = planJourneyGraph(input, edges.map(supply), {
        receivedAt: NOW,
        objective,
        searchMode,
        maxResults: 1,
      });

      assert.equal(actual.diagnostics.objective, objective);
      assert.equal(actual.diagnostics.bestObjectiveSeconds, expected.score);
      assert.equal(actual.diagnostics.optimalityProven, true);
      assert.deepEqual(actual.routes[0].durationSeconds, {
        min: expected.min,
        max: expected.max,
      });
      assert.equal(
        estimateBaseTimeline(actual.routes[0].segments, NOW)?.arrivalAt,
        NOW + expected.estimated * 1_000,
      );

      if (objective === 'estimated-arrival') {
        assert.equal(
          actual.routes[0].durationSeconds.max,
          310,
          'the later conservative vehicle remains visible as risk, without controlling the selected objective',
        );
        assert.equal(
          estimateBaseTimeline(actual.routes[0].segments, NOW)?.components.find(
            (component) => component.basis === 'live-departure',
          )?.arrivalAt,
          NOW + 90_000,
        );
        assert.equal(
          actual.routes[0].segments
            .filter((segment) => segment.mode === 'run')
            .reduce((sum, segment) => sum + segment.distanceMeters, 0),
          150,
        );
      }
    }
  }
});

test('the expected objective re-evaluates downstream model features at estimated arrival and keeps complete-route correction in the same units', () => {
  const sources = [
    route('access', [
      leg('access', 'walk', points[0], points[1], 0, {
        durationSeconds: {
          min: 0,
          max: 200,
        },
      }),
    ]),
    route('modeled-tail', [leg('modeled-tail', 'walk', points[1], points[5], 1_000)]),
    route('direct', [leg('direct', 'walk', points[0], points[5], 150)]),
  ];
  const input = request();

  const predict = (
    features: Parameters<
      NonNullable<Parameters<typeof planJourneyGraph>[2]['contextualEta']>['predict']
    >[0],
  ) => {
    if (features.predictedSeconds !== 1_000) {
      return null;
    }

    const median = features.startedAt === NOW + 100_000 ? 20 : 200;

    return {
      lowerSeconds: median / 2,
      medianSeconds: median,
      upperSeconds: median * 2,
      modelVersion: 'eta-context-v2' as const,
    };
  };

  const options = {
    receivedAt: NOW,
    maxResults: 1,
    contextualEta: {
      weather: null,
      predict,
    },
  };
  const conservative = planJourneyGraph(input, sources, options);

  assert.equal(conservative.diagnostics.bestObjectiveSeconds, 150);

  const estimated = planJourneyGraph(input, sources, {
    ...options,
    objective: 'estimated-arrival',
  });

  assert.equal(estimated.diagnostics.bestObjectiveSeconds, 120);
  assert.equal(estimated.routes[0].segments[1].etaPrediction?.features.startedAt, NOW + 100_000);
  assert.equal(estimateBaseTimeline(estimated.routes[0].segments, NOW)?.arrivalAt, NOW + 120_000);

  const corrected = planJourneyGraph(input, sources, {
    ...options,
    objective: 'estimated-arrival',
    scoreCompleteRoute: (candidate) =>
      (estimateBaseTimeline(candidate.segments, NOW)!.arrivalAt - NOW) / 1000 +
      (candidate.segments.length > 1 ? 100 : 0),
  });

  assert.equal(
    corrected.diagnostics.bestObjectiveSeconds,
    150,
    'a nonnegative complete-route correction is compared to estimated seconds, not the upper envelope',
  );
});
