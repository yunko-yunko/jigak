// Regression cases from mvp/tests/journeyGraphCapAndTwins.test.ts (the app-client validation case lives there; here the
// same response is re-timed with the shared code the app client uses).
import assert from 'node:assert/strict';
import test from 'node:test';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { rankRouteIntelligence } from '../src/common/engine/intelligence/arrival.js';
import { insertStationAccess } from '../src/common/engine/transit-enrichment.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { rideKey } from '../src/common/engine/ride-identity.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import { estimateBaseTimeline } from '../src/common/shared/domain/estimatedTiming.js';
import { evaluateBaseTimeline } from '../src/common/shared/domain/routing.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Place,
} from '../src/common/shared/domain/types.js';

const NOON = Date.parse('2026-10-16T12:00:00+09:00');
const place = (name: string, latitude: number, longitude = 126.97): Place => ({
  id: name,
  name,
  address: '',
  latitude,
  longitude,
});
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  start: Place,
  end: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: id,
  start,
  end,
  distanceMeters: start === end ? 0 : 300,
  runAllowed: false,
  durationSeconds: { min: seconds, max: seconds },
  ...(start === end ? {} : { polyline: [start, end] }),
  ...extra,
});
const ride = (
  id: string,
  start: Place,
  end: Place,
  seconds: number,
  line: string,
  extra: Partial<BaseSegment> = {},
) =>
  leg(id, 'subway', start, end, seconds, {
    lineName: line,
    transit: { lines: [line], stops: [start.name, end.name] },
    ...extra,
  });
const route = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, part) => sum + part.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (sum, part) => ({
      min: sum.min + part.durationSeconds.min,
      max: sum.max + part.durationSeconds.max,
    }),
    { min: 0, max: 0 },
  ),
});
const uses = (candidate: { segments: readonly { id: string }[] }, id: string) =>
  candidate.segments.some((segment) => segment.id.endsWith(id));

// ---- Arc cap and station gates (final-judge B1) ----
// 서울역 → 1호선 → 종로3가, an in-station change to 3호선 (no gates), 3호선 → 안국, then a 900 s walk. A 240 s walk from 종로3가's
// street point (a bridge) leaves the 1호선 at the change station, which the rider reaches from the paid area only through the
// exit gate arc that compile() adds after the source arcs.
const O = place('출발', 37.55),
  S = place('서울역', 37.555),
  X = place('종로3가', 37.57),
  X2 = place('종로3가', 37.5701),
  Y = place('안국', 37.6),
  D = place('도착', 37.572, 126.98);
const gateRequest: BasePlanningRequest = {
  origin: O,
  destination: D,
  now: NOON,
  deadline: NOON + 7_200_000,
  preferences: { ...DEFAULT_PREFERENCES, allowRunning: false, preparationSeconds: 0 },
};
const gated = () =>
  route(
    'A',
    insertStationAccess(
      [
        leg('a-walk', 'walk', O, S, 60),
        leg('a-w0', 'wait', S, S, 60),
        ride('a-r1', S, X, 300, '1호선'),
        leg('a-transfer', 'walk', X, X2, 90),
        leg('a-w1', 'wait', X2, X2, 120),
        ride('a-r2', X2, Y, 600, '3호선'),
        leg('a-egress', 'walk', Y, D, 900),
      ],
      'a',
      NOON,
    ),
  );
const bridge = () => route('bridge', [leg('b-walk', 'walk', X, D, 240)]);
/** Walks from the origin to places no source leaves: no journey can use them. */
const deadEnds = (count: number) =>
  Array.from({ length: count }, (_, k) =>
    route(`dead-${k}`, [
      leg(`dead-${k}`, 'walk', O, place(`p${k}`, 37.5 - k * 0.0001, 126.9), 600 + k),
    ]),
  );
/** Slower complete walks to the destination: real alternatives with finite lower bounds of 2000 s and more. */
const slowWalks = (count: number) =>
  Array.from({ length: count }, (_, k) =>
    route(`slow-${k}`, [leg(`slow-${k}`, 'walk', O, D, 2000 + k)]),
  );
const BEST = 901; // 60 walk + 10 entry + 60 wait + 300 train + exit gate + 240 bridge

// Failure: gate arcs were added after every source arc under the same cap, so a full cap cut them all and the bridge at the
// change station was unreachable from the train (2282 s through 안국 instead of 901 s).
test("a bounded search whose arc cap is full still leaves the train through the change station's gate to the bridge", () => {
  for (const filler of [0, 505, 520, 1500]) {
    const graph = planJourneyGraph(gateRequest, [gated(), bridge(), ...deadEnds(filler)], {
      receivedAt: NOON,
      objective: 'estimated-arrival',
      maxResults: 4,
      maxEdges: 512,
    });
    assert.equal(graph.diagnostics.bestObjectiveSeconds, BEST, `${filler} dead-end arcs`);
    assert.ok(uses(graph.routes[0], 'b-walk'), 'the fastest journey takes the bridge');
    const exit = graph.routes[0].segments.findIndex((segment) => segment.id.endsWith('b-walk')) - 1;
    assert.equal(
      graph.routes[0].segments[exit].mode,
      'entry',
      "the bridge starts past the change station's exit gate",
    );
    // Cut arcs lead nowhere, so they bound nothing: the result stays certified.
    assert.deepEqual(graph.diagnostics.limitsReached, []);
    assert.equal(graph.diagnostics.optimalityProven, true);
  }
});

// Failure: arcs were kept in fetch order, so cross-mode bridges (fetched last) were the first to be cut.
test('when the arc cap binds it cuts the slowest arcs, never a later-listed bridge, and certifies the cut honestly', () => {
  for (const order of ['slow first', 'bridge first'] as const) {
    const sources =
      order === 'slow first'
        ? [...slowWalks(600), gated(), bridge()]
        : [bridge(), gated(), ...slowWalks(600)];
    const graph = planJourneyGraph(gateRequest, sources, {
      receivedAt: NOON,
      objective: 'estimated-arrival',
      maxResults: 1,
      maxEdges: 512,
    });
    assert.equal(graph.diagnostics.bestObjectiveSeconds, BEST, order);
    assert.ok(uses(graph.routes[0], 'b-walk'));
    assert.ok(graph.diagnostics.limitsReached.includes('edges'), 'slow walks were cut');
    assert.ok(graph.diagnostics.edges > 512, 'gate arcs do not count toward the cap');
    // The 512 kept arcs include the gated journey's arcs and the fastest slow walks; the slowest kept walk bounds the cut.
    assert.ok(
      graph.diagnostics.unexploredLowerBoundSeconds! >= 2000 &&
        graph.diagnostics.unexploredLowerBoundSeconds! < 2600,
    );
    assert.equal(graph.diagnostics.optimalityProven, true);
  }
  const exact = planJourneyGraph(gateRequest, [...slowWalks(600), gated(), bridge()], {
    receivedAt: NOON,
    objective: 'estimated-arrival',
    maxResults: 1,
    searchMode: 'exact',
  });
  assert.equal(exact.diagnostics.bestObjectiveSeconds, BEST);
});

// ---- Same-ride detour twin (2026-10-31 A/B, 강남역→잠실역) ----
// The live result walked origin → a bus stop (115 s) → back to the station (196 s) and waited 172 s, while the direct 45 s walk
// waits 442 s for the same train. Both arrive together, so every arrival and effort key tied and the route-id hash chose.
const G = place('강남역', 37.49795, 127.02762),
  GS = place('강남', 37.498085, 127.028),
  STOP = place('강남역1번출구.역삼세무서', 37.498283, 127.029237);
const J = place('잠실', 37.513313, 127.100229),
  JD = place('잠실역', 37.5133, 127.1001),
  BUS_END = place('잠실역.롯데월드', 37.512508, 127.098031);
const foot = (id: string, start: Place, end: Place, seconds: number) =>
  leg(id, 'walk', start, end, seconds, { distanceMeters: Math.round(metersBetween(start, end)) });
const twinPreferences = {
  ...DEFAULT_PREFERENCES,
  allowRunning: false,
  allowBicycle: false,
  bicycleReady: false,
  allowScooter: false,
  allowTaxi: false,
  preparationSeconds: 0,
};
const twinRequest: BasePlanningRequest = {
  origin: G,
  destination: JD,
  now: NOON,
  deadline: NOON + 7_200_000,
  preferences: twinPreferences,
};
const train = () =>
  ride('line-2', GS, J, 720, '2호선', {
    realtime: {
      provider: 'seoul-subway',
      status: 'live',
      stopName: '강남',
      observedAt: NOON - 30_000,
      receivedAt: NOON,
      predictions: [{ line: '2호선', arrivesAt: NOON + 483_000, message: '8분 3초 후' }],
    },
  });
const twinSources = () => [
  // The provider's own subway itinerary with its direct access walk.
  route('kakao-transit-0', [
    foot('direct-access', G, GS, 45),
    leg('kakao-transit-0-expected-wait', 'wait', GS, GS, 60),
    train(),
    foot('egress', J, JD, 12),
  ]),
  // A bus itinerary whose access walk ends at the stop, and an itinerary that walks from that stop to the station.
  route('kakao-transit-1', [
    foot('stop-access', G, STOP, 115),
    leg('kakao-transit-1-expected-wait', 'wait', STOP, STOP, 60),
    leg('bus', 'bus', STOP, BUS_END, 1500, {
      lineName: '341',
      transit: { lines: ['341'], stops: [STOP.name, BUS_END.name] },
    }),
    foot('bus-egress', BUS_END, JD, 90),
  ]),
  route('kakao-transit-3', [
    foot('stop-to-station', STOP, GS, 196),
    leg('kakao-transit-3-expected-wait', 'wait', GS, GS, 60),
    train(),
    foot('egress-3', J, JD, 12),
  ]),
];
const reachesPlatform = (candidate: BaseRoute) =>
  candidate.segments.findIndex((segment) => segment.mode === 'subway');

test('of two variants of the same train with equal arrival, the direct walk wins over a walk to a stop and back', () => {
  for (const objective of ['estimated-arrival', 'conservative-arrival'] as const)
    for (const reverse of [false, true]) {
      const sources = reverse ? twinSources().reverse() : twinSources();
      const all = planJourneyGraph(twinRequest, sources, {
        receivedAt: NOON,
        objective,
        maxResults: 6,
        distinctRides: false,
      });
      const twins = all.routes.filter((candidate) =>
        candidate.segments.some((segment) => segment.mode === 'subway'),
      );
      assert.equal(twins.length, 2, 'the direct and the detour variant both complete');
      assert.deepEqual(
        twins[0].durationSeconds,
        twins[1].durationSeconds,
        'they board the same train',
      );
      assert.equal(
        estimateBaseTimeline(twins[0].segments, NOON)!.arrivalAt,
        estimateBaseTimeline(twins[1].segments, NOON)!.arrivalAt,
      );
      assert.equal(rideKey(twins[0].segments), rideKey(twins[1].segments));
      assert.ok(
        uses(twins[0], 'direct-access') && !uses(twins[0], 'stop-access'),
        `${objective}${reverse ? ', reversed' : ''}: direct variant first`,
      );
      const distinct = planJourneyGraph(twinRequest, sources, {
        receivedAt: NOON,
        objective,
        maxResults: 6,
      });
      const kept = distinct.routes.filter((candidate) =>
        candidate.segments.some((segment) => segment.mode === 'subway'),
      );
      assert.equal(kept.length, 1);
      assert.ok(uses(kept[0], 'direct-access'), 'the one card per ride is the direct walk');
      assert.equal(distinct.diagnostics.duplicateRideResults, 1);
      assert.ok(
        reachesPlatform(kept[0]) < reachesPlatform(twins[1]),
        'it reaches the platform in fewer steps',
      );
    }
});

test('final ranking prefers the variant that reaches the boarding sooner and walks less when arrivals tie', () => {
  const all = planJourneyGraph(twinRequest, twinSources(), {
    receivedAt: NOON,
    objective: 'estimated-arrival',
    maxResults: 6,
    distinctRides: false,
  });
  const planned = planBaseRoutes(twinRequest, all.routes, provenance, {
    objective: 'estimated-arrival',
    maxRoutes: 18,
  }).routes;
  for (const order of [planned, [...planned].reverse()]) {
    const intelligence = rankRouteIntelligence(order, twinRequest, {
      objective: 'estimated-arrival',
    });
    const first = order.find((candidate) => candidate.id === intelligence.recommendationId)!;
    assert.ok(uses(first, 'direct-access') && !uses(first, 'stop-access'));
  }
});

// ---- The response app.ts builds, re-timed as the app client does ----
const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '확인한 경로',
  receivedAt: NOON,
  sourceTimestamp: null,
  isRealtime: false,
};
/** The response app.ts builds from graph candidates: domain plan, arrival intelligence, rank order, one card per ride. */
function respond(request: BasePlanningRequest, candidates: BaseRoute[]) {
  const result = planBaseRoutes(request, candidates, provenance, {
    objective: 'estimated-arrival',
    deadlineValidationTime: request.now,
    maxRoutes: 18,
  });
  const intelligence = rankRouteIntelligence(result.routes, request, {
    objective: 'estimated-arrival',
  });
  for (const candidate of result.routes)
    candidate.recommended = candidate.id === intelligence.recommendationId;
  const rank = new Map(intelligence.assessments.map((value, index) => [value.routeId, index]));
  result.routes.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const rides = new Set<string>();
  result.routes = result.routes.filter((candidate) => {
    const ride = rideKey(candidate.segments);
    if (rides.has(ride)) return false;
    rides.add(ride);
    return true;
  });
  intelligence.assessments = intelligence.assessments.filter((assessment) =>
    result.routes.some((candidate) => candidate.id === assessment.routeId),
  );
  return { ...result, intelligence };
}
/** What the app client recomputes from the response (routeApiClient validateLiveResult): every segment clock, the
 * arrival, each assessment's estimate, and that the recommendation has the least estimate. */
function recompute(payload: ReturnType<typeof respond>) {
  for (const candidate of payload.routes) {
    const timed = candidate.segments.map((segment) => {
      const planned =
        segment.plannedConnection ??
        (segment.provenance.isRealtime && segment.realtime ? segment.connection : undefined);
      if (planned) return { ...segment, plannedConnection: planned };
      const { realtime: _unused, ...unanchored } = segment;
      return unanchored;
    });
    const clocks = evaluateBaseTimeline(timed, payload.generatedAt);
    assert.ok(clocks);
    clocks.forEach((clock, index) => assert.deepEqual(clock, candidate.segments[index].timeRange));
    assert.deepEqual(clocks.at(-1), candidate.arrivalTime);
    const assessment = payload.intelligence.assessments.find(
      (value) => value.routeId === candidate.id,
    )!;
    const estimate = estimateBaseTimeline(candidate.segments, payload.generatedAt);
    assert.equal(assessment.estimatedReadyAt, estimate?.arrivalAt);
  }
  const eligible = payload.intelligence.assessments.filter((value) => value.eligible);
  const recommended = eligible.find(
    (value) => value.routeId === payload.intelligence.recommendationId,
  )!;
  assert.ok(recommended && eligible.every((value) => value.score >= recommended.score));
  return payload.routes.find((candidate) => candidate.id === recommended.routeId)!;
}

test("the response built from the planner's gate-bridge and direct-twin results re-times exactly with the shared code", () => {
  for (const [request, sources] of [
    [gateRequest, [...slowWalks(600), gated(), bridge()]],
    [twinRequest, twinSources()],
  ] as const) {
    const graph = planJourneyGraph(request, sources, {
      receivedAt: request.now,
      objective: 'estimated-arrival',
      maxResults: 12,
      maxEdges: 512,
    });
    const winner = recompute(respond(request, graph.routes));
    assert.equal(
      estimateBaseTimeline(winner.segments, request.now)!.arrivalAt,
      request.now + graph.diagnostics.bestObjectiveSeconds! * 1000,
      "the recommendation is the planner's minimum",
    );
    if (request === gateRequest) assert.ok(uses(winner, 'b-walk'));
    else assert.ok(uses(winner, 'direct-access') && !uses(winner, 'stop-access'));
  }
});
