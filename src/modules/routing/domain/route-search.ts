import { SeoulTimetableService } from '../../../common/engine/realtime/subwayTimetable.js';
import type { RoutingObjective } from '../../../common/shared/domain/estimatedTiming.js';
import { randomUUID } from 'node:crypto';
import {
  planBaseRoutes,
  PlanningError,
  validatePreferences,
  type BaseRoute,
  type BaseSegment,
  type BasePlanningRequest,
  type Place,
} from '../../../common/shared/domain/index.js';
import { ApiError, safeApiError } from '../../../common/engine/errors.js';
import {
  KakaoProvider,
  type RouteEndpoints,
  type RouteProvider,
} from '../../../common/engine/kakao.js';
import {
  CallBudget,
  MAX_ROUTE_CALLS,
  MAX_COMPOSITE_ROUTE_CALLS,
} from '../../../common/engine/call-budget.js';
import { footVariants } from '../../../common/engine/multimodal.js';
import {
  buildMixedModeBridges,
  type BridgeGenerationDiagnostics,
} from '../../../common/engine/mixed-mode-bridges.js';
import { discoverIntermediateTransit } from '../../../common/engine/intermediate-transit.js';
import {
  DEFAULT_MAX_JOURNEY_SECONDS,
  planJourneyGraph,
} from '../../../common/engine/journey-graph.js';
import type { ScooterConnectionContext } from '../../../common/engine/scooter-bridge.js';
import { metersBetween } from '../../../common/engine/realtime/names.js';
import { RealtimeService } from '../../../common/engine/realtime/service.js';
import { NearbyTransitService } from '../../../common/engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../../../common/engine/realtime/seoulTraffic.js';
import { routeTraffic } from '../../../common/engine/realtime/routeTraffic.js';
import { enrichRouteConditions } from '../../../common/engine/realtime/route-conditions.js';
import { MobilityFeeds } from '../../../common/engine/realtime/mobility.js';
import { WeatherFeed } from '../../../common/engine/realtime/weather.js';
import { SeoulParkingFeed, type ParkingLookup } from '../../../common/engine/realtime/parking.js';
import { rankRouteIntelligence } from '../../../common/engine/intelligence/arrival.js';
import { applyPlanningTimingAdjustments } from '../../../common/engine/intelligence/planningTiming.js';
import { withPedestrianRouting } from '../../../common/engine/connectivity/provider.js';
import {
  withRouteQueryReuse,
  routeQueryIsReusable,
} from '../../../common/engine/connectivity/query-reuse.js';
import { applyStationTransferReferences } from '../../../common/engine/connectivity/station-transfers.js';
import type { EtaCalibration } from '../../../common/engine/intelligence/calibration.js';
import { enrichTransitRoutes } from '../../../common/engine/transit-enrichment.js';
import {
  applyPublicBusTiming,
  type PublicBusRuntime,
} from '../../../common/engine/intelligence/public-bus-timing.js';
import { journeyPathIdentity } from '../../../common/engine/intelligence/journey-features.js';
import { journeyReferenceFeaturesForRoute } from '../../../common/engine/intelligence/journey-reference.js';
import { rentalAvailabilityForSearch } from '../../../common/engine/intelligence/rental-availability.js';
import type { SpatialBicycleShadowService } from '../../../common/engine/intelligence/spatial-bicycle-service.js';
import {
  applyJourneyRisk,
  journeyRiskSeconds,
} from '../../../common/shared/intelligence/journeyRisk.js';
import type { JourneyLearningFeatures } from '../../../common/shared/intelligence/journeyLearning.js';
import {
  applyContextualEtaTiming,
  learningFeaturesForRoute,
} from '../../../common/engine/intelligence/learning-features.js';
import {
  SearchProfiler,
  profileRouteProvider,
  type SearchPerformance,
} from '../../../common/engine/search-performance.js';
import { serviceCalendarStatus } from '../../../common/engine/realtime/service-calendar.js';
import { encodeRouteResponse } from '../../../common/engine/route-response.js';
import { acquisitionTiming } from '../../../common/engine/acquisition-priority.js';

import type { LearningService as EtaLearningService } from '../../learning/service/learning.service.js';

import type { RoutingOptions } from './routing-options.js';
import { parseRoute } from '../dto/routing.dto.js';

export async function executeRouteSearch(
  body: unknown,
  options: RoutingOptions,
  gzip = false,
  isDisconnected: () => boolean = () => false,
) {
  const clock = options.now ?? Date.now;
  const baseProvider = options.provider!;
  const provider = withPedestrianRouting(baseProvider, options.pedestrian);
  const { realtime, nearbyTransit, traffic, mobility, weather, parking } =
    options as Required<RoutingOptions>;
  const intermediateHubs =
    options.acquisitionAudit?.intermediateTransitHubs ?? options.intermediateTransitHubs ?? 0;

  await options.learning?.refresh();

  const profiler = new SearchProfiler();
  let searchBudget: CallBudget | undefined;
  let outcome: SearchPerformance['outcome'] = 'error';
  let errorCode: SearchPerformance['errorCode'] = null;

  try {
    const acceptedAt = clock();
    const input = parseRoute(body, acceptedAt);
    const objective = options.routingObjective ?? 'estimated-arrival';
    const walkingAlternatives: BaseRoute[] = [];

    const onWalkingAlternatives = (routes: BaseRoute[]) => {
      for (const source of routes) {
        const id = `acquired-foot-alternative-${walkingAlternatives.length}`;
        const ids = new Map(
          source.segments.map((segment, index) => [
            segment.id,
            `${id}-${index}${segment.id.endsWith('-provider-extra') ? '-provider-extra' : ''}`,
          ]),
        );

        walkingAlternatives.push({
          ...source,
          id,
          segments: source.segments.map((segment) => ({
            ...segment,
            id: ids.get(segment.id)!,
          })),
          notes: source.notes?.map((note) =>
            note.segmentId
              ? {
                  ...note,
                  segmentId: ids.get(note.segmentId) ?? note.segmentId,
                }
              : note,
          ),
        });
      }
    };

    const searchProvider = withRouteQueryReuse(profileRouteProvider(provider, profiler));
    if (!searchProvider.configured) {
      throw new ApiError(
        'LIVE_NOT_CONFIGURED',
        '실제 경로 조회 설정이 준비되지 않았어요. 서버의 카카오 REST API 키와 호출 권한을 확인한 뒤 다시 조회해 주세요.',
        503,
      );
    }

    // Baseline requests, later candidate requests and retries receive this same budget.
    const canCompareRental =
      !input.preferences.walkingOnly &&
      baseProvider.configured &&
      ((input.preferences.allowBicycle &&
        input.preferences.bicycleReady &&
        input.preferences.maxBicycleMeters > 0 &&
        mobility.bikes.configured &&
        typeof searchProvider.bicycle === 'function') ||
        (input.preferences.allowScooter !== false &&
          mobility.capabilities.sharedScooter &&
          typeof searchProvider.scooter === 'function' &&
          !!options.scooterPolicy));

    // Complete a rental and its newly fetched transit access without displacing
    // the ordinary road comparison. All attempts and fallbacks share this cap.
    const budget = new CallBudget(
      options.routeCallLimit ?? (canCompareRental ? MAX_COMPOSITE_ROUTE_CALLS : MAX_ROUTE_CALLS),
    );

    searchBudget = budget;

    // Attach rejection handlers immediately while independent route queries run.
    const contextPromise = Promise.allSettled([
      profiler.measure('weather', () => weather.conditions(input.origin)),
      profiler.measure('inventory', () => mobility.snapshot(input.origin, 1200)),
    ] as const);
    const calls = [searchProvider.walking(input, budget)];

    if (!input.preferences.walkingOnly && baseProvider.configured) {
      calls.push(searchProvider.transit(input, budget));
    }

    const outcomes = await profiler.measure('initial-routes', () => Promise.allSettled(calls));

    if (isDisconnected()) {
      return;
    }

    const bases: BaseRoute[] = [];
    const failures: {
      provider: string;
      code: string;
      message: string;
    }[] = [];

    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        bases.push(...outcome.value);
      } else {
        const error = safeApiError(outcome.reason);

        failures.push({
          provider: index === 0 ? 'pedestrian-routing' : 'kakao-publictraffic',
          code: error.code,
          message: error.message,
        });
      }
    });

    if (!bases.length) {
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      const errors = rejected.map((outcome) => safeApiError(outcome.reason));

      // An account or network problem is more actionable than a concurrent empty route.
      throw (
        errors.find((error) => error.code !== 'NO_ROUTES') ??
        errors[0] ??
        new ApiError('NO_ROUTES', '이 지점 사이의 경로를 찾지 못했어요.', 404)
      );
    }

    // Query real transfer anchors first, reserving calls for bridges between modes.
    const walkingBases = bases.filter(
      (route) =>
        !route.segments.some((segment) => segment.mode === 'bus' || segment.mode === 'subway'),
    );
    const transitBases = bases.filter((route) => !walkingBases.includes(route));
    const multimodal =
      options.pedestrian?.configured === true ||
      typeof searchProvider.driving === 'function' ||
      typeof searchProvider.bicycle === 'function' ||
      typeof searchProvider.scooter === 'function' ||
      (intermediateHubs > 0 && typeof searchProvider.nearby === 'function');

    // Keep one promising rental anchor first. When source itineraries include
    // both bus and rail, also verify a missing mode before refining rentals;
    // homogeneous sources retain the two-access reservation for a full ride.
    const transitSources = applyStationTransferReferences(transitBases);
    const accessModeCoverage =
      canCompareRental &&
      transitSources.some((route) => route.segments.some((segment) => segment.mode === 'bus')) &&
      transitSources.some((route) => route.segments.some((segment) => segment.mode === 'subway'));
    const accessCache: NonNullable<Parameters<typeof enrichTransitRoutes>[2]['accessCache']> =
      new Map();
    let accessLimited = false;

    const onAccessLimited = () => {
      accessLimited = true;
    };

    const accessPriority = (route: BaseRoute) => {
      const physical = route.segments.filter(
        (segment) => !(segment.mode === 'wait' && segment.id.endsWith('-provider-extra')),
      );
      const first = physical[0],
        last = physical.at(-1);
      const timing = acquisitionTiming(route, acceptedAt, objective);
      const gaps = route.segments.flatMap((segment, index) =>
        segment.mode === 'walk'
          ? [
              {
                meters: segment.distanceMeters,
                seconds: timing.segments[index],
              },
            ]
          : [],
      );

      for (const [from, to, needed] of [
        [input.origin, first?.polyline?.[0] ?? first?.start, first?.mode !== 'walk'],
        [last?.polyline?.at(-1) ?? last?.end, input.destination, last?.mode !== 'walk'],
      ] as const) {
        if (needed && from && to) {
          const meters = metersBetween(from, to) * 1.25;

          gaps.push({
            meters,
            seconds: meters / 1.2,
          });
        }
      }

      const reach = Math.max(
        input.preferences.allowBicycle && input.preferences.bicycleReady
          ? input.preferences.maxBicycleMeters
          : 0,
        input.preferences.allowScooter !== false && options.scooterPolicy ? 6000 : 0,
      );

      // Only a fetch-order bound: no hypothetical bicycle speed enters the actual ETA.
      const potentialSaving = gaps
        .filter((gap) => (gap.meters >= 600 || gap.seconds >= 600) && gap.meters <= reach)
        .reduce((sum, gap) => sum + Math.max(0, gap.seconds - gap.meters / 3.6 - 150), 0);

      return timing.total - potentialSaving;
    };

    let enrichedTransit = transitBases.length
      ? await profiler.measure('access', () =>
          enrichTransitRoutes(transitSources, input, {
            provider: searchProvider,
            budget,
            realtime,
            accessCache,
            onAccessLimited,
            onWalkingAlternatives,
            acquisitionObjective: objective,
            ...(canCompareRental
              ? {
                  accessPriority,
                  accessModeCoverage,
                }
              : {}),
            now: clock(),
            ...(multimodal
              ? {
                  maxAccessCalls: canCompareRental
                    ? accessModeCoverage
                      ? 4
                      : 2
                    : options.pedestrian?.configured
                      ? 4
                      : 2,
                }
              : {}),
          }),
        )
      : [];

    const connectTransit = async (endpoints: RouteEndpoints) => {
      const candidates = applyStationTransferReferences(
        await searchProvider.transit(endpoints, budget),
      );

      return enrichTransitRoutes(candidates, endpoints, {
        provider: searchProvider,
        budget,
        realtime,
        accessCache,
        onAccessLimited,
        onWalkingAlternatives,
        acquisitionObjective: objective,
        now: clock(),
        maxAccessCalls: 2,
      });
    };

    const intermediate =
      !input.preferences.walkingOnly && intermediateHubs > 0 && searchProvider.nearby
        ? await profiler.measure('intermediate', () =>
            budget.withReservedCalls(canCompareRental ? 8 : 4, () =>
              discoverIntermediateTransit(input, transitSources, {
                provider: searchProvider,
                budget,
                maxHubs: intermediateHubs,
                maxRouteCalls: options.acquisitionAudit?.intermediateTransitMaxRouteCalls ?? 12,
                connectTransit,
                now: acceptedAt,
                acquisitionObjective: objective,
                queryCallCost: (endpoints) =>
                  routeQueryIsReusable(searchProvider, 'transit', endpoints, budget) ? 0 : 1,
              }),
            ),
          )
        : null;

    const intermediateRoutes = intermediate?.routes ?? [];
    let bridgeSearch: BridgeGenerationDiagnostics | undefined;

    const bridges = multimodal
      ? await profiler.measure('bridges', () =>
          buildMixedModeBridges(input, [...enrichedTransit, ...intermediateRoutes], {
            provider: searchProvider,
            budget,
            now: clock(),
            mobility,
            parking,
            scooterPolicy: options.scooterPolicy,
            onWalkingAlternatives,
            acquisitionObjective: objective,
            queryCallCost: (mode, endpoints) =>
              routeQueryIsReusable(searchProvider, mode, endpoints, budget) ? 0 : 1,
            ...(baseProvider.configured
              ? {
                  connectTransit,
                }
              : {}),
            onRentalsComplete: async () => {
              if (canCompareRental && transitSources.length) {
                enrichedTransit = await enrichTransitRoutes(transitSources, input, {
                  provider: searchProvider,
                  budget,
                  realtime,
                  accessCache,
                  onAccessLimited,
                  onWalkingAlternatives,
                  acquisitionObjective: objective,
                  now: clock(),
                  maxAccessCalls: 2,
                });
              }
            },
            onDiagnostics: (diagnostics) => {
              bridgeSearch = diagnostics;
            },
          }),
        )
      : [];

    // Missing access paths remain visibly estimated. They never create a turn-by-turn path.
    for (const route of enrichedTransit) {
      if (
        route.segments.some(
          (segment) =>
            segment.mode === 'walk' &&
            segment.distanceMeters > 0 &&
            (segment.polyline?.length ?? 0) < 2,
        )
      ) {
        route.notes = [
          ...(route.notes ?? []),
          {
            code: 'unverified-duration-range',
            severity: 'warning',
            title: '일부 도보 경로 미확인',
            description:
              '정류장까지의 도보 시간을 거리로 추정했어요. 실제 보행 경로를 확인하기 전에는 추천하지 않아요.',
          },
        ];
      }
    }

    const useGraph = multimodal || walkingAlternatives.length > 0;
    const foot = footVariants(
      [
        ...walkingBases,
        ...enrichedTransit,
        ...intermediateRoutes,
        ...bridges,
        ...walkingAlternatives,
      ],
      input.preferences,
    );

    // Bus legs are re-timed on the roads as they are now, before anything is ranked.
    const roadInputs = [
      ...walkingBases,
      ...enrichedTransit,
      ...intermediateRoutes,
      ...foot,
      ...bridges,
      ...walkingAlternatives,
    ];

    const roadAdjusted = await enrichRouteConditions(
      roadInputs,
      clock(),
      traffic,
      options.timetable,
      profiler,
    );
    const [weatherResult, mobilityResult] = await contextPromise;

    if (weatherResult.status === 'rejected') {
      throw weatherResult.reason;
    }
    if (mobilityResult.status === 'rejected') {
      throw mobilityResult.reason;
    }

    const conditions = weatherResult.value,
      rentalSnapshot = mobilityResult.value;
    const receivedAt = clock();
    if (input.purpose !== 'replan' && input.purpose !== 'urgent' && input.deadline <= receivedAt) {
      throw new ApiError(
        'INVALID_INPUT',
        '조회 중 도착 마감 시각이 지났어요. 원래 마감을 유지하려면 긴급 길찾기로 다시 조회해 주세요.',
        400,
      );
    }

    // Access uncertainty can change the vehicle caught, so include it before every graph search.
    const planningInput = {
      ...input,
      now: receivedAt,
    };
    const stopPlanning = profiler.start('planning');
    const provenance = {
      mode: 'live' as const,
      provider: options.pedestrian?.configured ? ('multimodal' as const) : ('kakao' as const),
      label: options.pedestrian?.configured ? '복합 경로 공급원' : '카카오 경로',
      sourceTimestamp: null,
      receivedAt,
      isRealtime: false,
    };

    const connectionExclusions = (routes: ReturnType<typeof planBaseRoutes>['routes']) =>
      new Map(
        routes.flatMap((route) => {
          const start = route.segments[0]?.start,
            end = route.segments.at(-1)?.end;
          const missing =
            !start ||
            !end ||
            metersBetween(start, input.origin) > 75 ||
            metersBetween(end, input.destination) > 75 ||
            route.segments.some(
              (segment, index) =>
                index > 0 && metersBetween(route.segments[index - 1].end, segment.start) > 75,
            ) ||
            route.risks.some((risk) => risk.title === '출발·환승 연결 미확인');

          return missing
            ? [
                [
                  route.id,
                  [
                    '출발·도착 또는 환승의 실제 보행 연결이 확인되지 않아 빠른 조합 추천에서 제외했어요.',
                  ],
                ] as [string, string[]],
              ]
            : [];
        }),
      );

    const learningState = await options.learning?.status();

    const graphOptions = {
      receivedAt,
      objective,
      ...(parking.configured && parking.at
        ? {
            parkingAt: (lot: Place, arrivalAt: number) =>
              parking.at!(lot, arrivalAt)?.parkingAccess ?? null,
          }
        : {}),
      ...(learningState?.model.active
        ? {
            contextualEta: {
              weather: conditions,
              predict: (features: Parameters<EtaLearningService['predict']>[0]) =>
                options.learning!.predict(features),
            },
          }
        : {}),
      ...(options.publicBus
        ? {
            publicBusEta: {
              predict: (segment: BaseSegment, startedAt: number, requestNow: number) =>
                options.publicBus!.predictSegment(segment, startedAt, requestNow, conditions),
            },
          }
        : {}),
      ...(objective === 'conservative-arrival' && learningState?.journey.model.active
        ? {
            scoreCompleteRoute: (base: BaseRoute) => {
              const route = planBaseRoutes(planningInput, [base], provenance, {
                objective,
                deadlineValidationTime: acceptedAt,
                maxRoutes: 1,
              }).routes[0];
              if (!route) {
                return base.durationSeconds.max;
              }

              const features = journeyReferenceFeaturesForRoute(
                route,
                receivedAt,
                conditions,
                options.calibration ?? null,
              );

              return (
                route.durationSeconds.max +
                journeyRiskSeconds(
                  applyJourneyRisk(
                    route,
                    features ? options.learning!.predictJourney(features) : null,
                    receivedAt,
                  ),
                )
              );
            },
          }
        : {}),
      acceptRoute: (base: BaseRoute) => {
        const comparison = planBaseRoutes(planningInput, [base], provenance, {
          objective,
          deadlineValidationTime: acceptedAt,
          maxRoutes: 1,
        });

        return rankRouteIntelligence(comparison.routes, planningInput, {
          objective,
          weather: conditions,
          mobility: rentalSnapshot,
          calibration: options.calibration,
          exclusions: connectionExclusions(comparison.routes),
        }).assessments.some((assessment) => assessment.eligible);
      },
    };
    const adjusted = applyPlanningTimingAdjustments(roadAdjusted, planningInput, {
      weather: conditions,
      calibration: options.calibration,
    });
    const contextual = options.learning
      ? applyContextualEtaTiming(adjusted, planningInput, conditions, (features) =>
          options.learning!.predict(features),
        )
      : adjusted;

    bases.splice(
      0,
      bases.length,
      ...(options.publicBus
        ? applyPublicBusTiming(contextual, planningInput, (segment, startedAt, requestNow) =>
            options.publicBus!.predictSegment(segment, startedAt, requestNow, conditions),
          )
        : contextual),
    );

    const graph = planJourneyGraph(planningInput, bases, {
      ...graphOptions,
      maxResults: 12,
    });

    options.observeGraphSearch?.({
      request: planningInput,
      bases,
      options: {
        ...graphOptions,
        maxResults: 12,
      },
      result: graph,
    });

    // Unknown parking or rental evidence must not fill every slot before feasibility ranking.
    const footGraph = useGraph
      ? planJourneyGraph(
          {
            ...planningInput,
            preferences: {
              ...input.preferences,
              walkingOnly: true,
            },
          },
          bases,
          {
            ...graphOptions,
            maxResults: 1,
          },
        )
      : null;
    const transitGraph = useGraph
      ? planJourneyGraph(
          planningInput,
          bases.filter((route) =>
            route.segments.every((segment) =>
              ['walk', 'run', 'entry', 'wait', 'bus', 'subway'].includes(segment.mode),
            ),
          ),
          {
            ...graphOptions,
            maxResults: 2,
          },
        )
      : null;

    // Main results stay ordered by total time. Separately retain a feasible rental
    // comparison when twelve faster choices use other modes, using the same fetched graph.
    const bicycleGraph =
      canCompareRental &&
      input.preferences.allowBicycle &&
      input.preferences.bicycleReady &&
      bases.some((route) => route.segments.some((segment) => segment.mode === 'bicycle'))
        ? planJourneyGraph(planningInput, bases, {
            ...graphOptions,
            maxResults: 1,
            requiredMode: 'bicycle',
          })
        : null;
    const scooterGraph =
      input.preferences.allowScooter !== false &&
      !!provider.scooter &&
      !!options.scooterPolicy &&
      bases.some((route) => route.segments.some((segment) => segment.mode === 'scooter'))
        ? planJourneyGraph(planningInput, bases, {
            ...graphOptions,
            maxResults: 1,
            requiredMode: 'scooter',
          })
        : null;
    const rentalCandidates = [
      ...(bicycleGraph?.routes.filter(
        (route) =>
          route.segments.some((segment) => segment.mode === 'bicycle') &&
          graphOptions.acceptRoute(route),
      ) ?? []),
      ...(scooterGraph?.routes.filter(
        (route) =>
          route.segments.some((segment) => segment.mode === 'scooter') &&
          graphOptions.acceptRoute(route),
      ) ?? []),
    ];

    const graphCandidates = [
      ...new Map(
        [
          ...graph.routes,
          ...(footGraph?.routes ?? []),
          ...(transitGraph?.routes ?? []),
          ...rentalCandidates,
        ].map((route) => [route.id, route]),
      ).values(),
    ];

    // Partial bridges are graph edges, never falsely presented as door-to-door routes.
    const baselineIds = new Set([...walkingBases, ...enrichedTransit].map((route) => route.id));
    const fallback = bases.filter(
      (route) =>
        baselineIds.has(route.id) &&
        (!options.pedestrian?.configured ||
          route.durationSeconds.max <= DEFAULT_MAX_JOURNEY_SECONDS),
    );
    if (
      options.pedestrian?.configured &&
      !graphCandidates.length &&
      !fallback.length &&
      baselineIds.size
    ) {
      throw new ApiError(
        'NO_ROUTES',
        '현재 조합 탐색은 이동 예상 4시간 이내의 경로를 비교해요. 더 가까운 출발·도착 지점을 선택해 주세요.',
        404,
      );
    }

    const candidates = useGraph ? (graphCandidates.length ? graphCandidates : fallback) : bases;

    if (useGraph && !graphCandidates.length) {
      for (const route of candidates) {
        route.notes = [
          ...(route.notes ?? []),
          {
            code: 'unverified-duration-range',
            severity: 'warning',
            title: '출발·환승 연결 미확인',
            description:
              '공급원 경로는 조회했지만 출발·도착 위치 또는 환승 지점의 보행 연결을 확인하지 못했어요. 연결이 확인되기 전에는 빠른 조합으로 추천하지 않아요.',
          },
        ];
      }
    }

    const result = planBaseRoutes(planningInput, candidates, provenance, {
      objective,
      deadlineValidationTime: acceptedAt,
      maxRoutes: useGraph ? 18 : 3,
    });
    if (!result.routes.length) {
      throw new ApiError(
        'NO_ROUTES',
        input.preferences.walkingOnly
          ? '이 지점 사이에 걷기만으로 이용할 수 있는 경로를 찾지 못했어요.'
          : '설정한 이동 조건에 맞는 경로를 찾지 못했어요.',
        404,
      );
    }

    const wholeFeatures = new Map<string, JourneyLearningFeatures>();

    if (options.learning) {
      result.routes = result.routes.map((route) => {
        const features = journeyReferenceFeaturesForRoute(
          route,
          receivedAt,
          conditions,
          options.calibration ?? null,
        );
        if (features) {
          wholeFeatures.set(route.id, features);
        }

        return applyJourneyRisk(
          route,
          features ? options.learning!.predictJourney(features) : null,
          receivedAt,
        );
      });
    }

    const exclusions = connectionExclusions(result.routes);
    const intelligence = rankRouteIntelligence(
      result.routes,
      {
        ...input,
        now: receivedAt,
      },
      {
        objective,
        weather: conditions,
        mobility: rentalSnapshot,
        calibration: options.calibration,
        exclusions,
      },
    );

    result.routes.forEach((route) => {
      route.recommended = route.id === intelligence.recommendationId;

      const assessment = intelligence.assessments.find((value) => value.routeId === route.id);
      if (assessment) {
        route.reasons = [
          ...assessment.explanations
            .filter((value) => value.code !== 'source')
            .slice(0, 3)
            .map((value) => value.text),
          ...route.reasons,
        ].slice(0, 8);
      }
    });

    result.allLate =
      intelligence.assessments.length > 0 &&
      intelligence.assessments.every(
        (assessment) => assessment.predictedReadyAt.earliest > input.deadline,
      );

    const rank = new Map(intelligence.assessments.map((value, index) => [value.routeId, index]));

    result.routes.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));

    if (options.learning) {
      for (const route of result.routes) {
        const whole = wholeFeatures.get(route.id);

        route.learningTicket = options.learning.store.issueTicket(
          learningFeaturesForRoute(route, receivedAt, conditions),
          whole
            ? {
                features: whole,
                pathIdentity: journeyPathIdentity(route),
              }
            : undefined,
        );

        if (whole) {
          route.learningWholeJourney = true;
        }
      }
    }

    const acquisitionIncomplete =
      accessLimited ||
      !!intermediate?.diagnostics.limitReached ||
      !!intermediate?.diagnostics.providerFailures ||
      !!intermediate?.diagnostics.unverifiedConnections ||
      !!bridgeSearch?.limitReached ||
      !!bridgeSearch?.providerFailures ||
      failures.length > 0;
    const searchLimited =
      acquisitionIncomplete ||
      [graph, footGraph, transitGraph, bicycleGraph, scooterGraph].some(
        (search) => search?.diagnostics.limitReached,
      );
    const eligibleObjectives = intelligence.assessments
      .filter((assessment) => assessment.eligible)
      .map((assessment) =>
        Math.max(
          0,
          (objective === 'estimated-arrival'
            ? assessment.estimatedSeconds!
            : assessment.conservativeSeconds) - input.preferences.preparationSeconds,
        ),
      );
    const bestObjectiveSeconds = eligibleObjectives.length ? Math.min(...eligibleObjectives) : null;
    const unexploredLowerBoundSeconds = acquisitionIncomplete
      ? 0
      : graph.diagnostics.unexploredLowerBoundSeconds;
    const optimalityProven =
      bestObjectiveSeconds !== null &&
      !acquisitionIncomplete &&
      graph.diagnostics.termination !== 'stale-input' &&
      (unexploredLowerBoundSeconds === null || bestObjectiveSeconds <= unexploredLowerBoundSeconds);

    stopPlanning();

    if (isDisconnected()) {
      return;
    }

    const payload = {
      ...result,
      intelligence,
      rentalAvailability: rentalAvailabilityForSearch({
        preferences: input.preferences,
        routes: result.routes,
        capabilities: {
          bicycleFeed: mobility.capabilities.sharedBicycle,
          scooterFeed: mobility.capabilities.sharedScooter,
          bicycleRouter: !!provider.bicycle,
          scooterRouter: !!provider.scooter,
          scooterRentalPolicy: !!options.scooterPolicy,
        },
        diagnostics: bridgeSearch,
      }),
      search: {
        ...graph.diagnostics,
        accessLimited,
        acquisitionComplete: !acquisitionIncomplete,
        fetchedGraphOptimalityProven: graph.diagnostics.optimalityProven,
        fetchedGraphBestObjectiveSeconds: graph.diagnostics.bestObjectiveSeconds,
        bestObjectiveSeconds,
        optimalityProven,
        unexploredLowerBoundSeconds,
        optimalityGapSeconds:
          bestObjectiveSeconds === null
            ? null
            : unexploredLowerBoundSeconds === null
              ? 0
              : Math.max(0, bestObjectiveSeconds - unexploredLowerBoundSeconds),
        complete: !searchLimited && graph.diagnostics.complete,
        limitReached: searchLimited,
        ...(intermediate
          ? {
              intermediate: intermediate.diagnostics,
            }
          : {}),
        ...(bridgeSearch
          ? {
              bridges: bridgeSearch,
            }
          : {}),
      },
      notice: [
        result.notice,
        searchLimited ? '탐색 한도에 도달했어요. 확인한 후보 안에서 빠른 조합을 추천합니다.' : '',
        bridgeSearch?.providerFailures
          ? '일부 이동수단의 연결 경로를 공급원에서 확인하지 못했어요. 해당 조합은 추천에 포함하지 않았어요.'
          : '',
        intermediate?.diagnostics.providerFailures ||
        intermediate?.diagnostics.unverifiedConnections
          ? '일부 중간역 연결을 확인하지 못했어요. 확인된 구간만 조합했어요.'
          : '',
        failures.length
          ? `일부 경로 조회가 실패했어요: ${failures.map((failure) => failure.message).join(' ')}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      requestId: randomUUID(),
      providerCalls: budget.used,
      routeCallBudget: {
        limit: budget.limit,
        used: budget.used,
        remaining: budget.remaining,
      },
      failures,
    };

    const encoded = await profiler.measure('encoding', () => encodeRouteResponse(payload, gzip));

    if (isDisconnected()) {
      return;
    }

    outcome = 'ok';

    return {
      encoded,
      serverTiming: profiler.header(budget.used),
    };
  } catch (error) {
    errorCode = error instanceof PlanningError ? 'INVALID_INPUT' : safeApiError(error).code;
    throw error;
  } finally {
    const sample = profiler.snapshot(
      isDisconnected() ? 'disconnected' : outcome,
      searchBudget?.used ?? 0,
      errorCode,
    );

    // An operator's metrics sink must never turn a usable route into a failed request.
    try {
      void Promise.resolve(options.observeSearchPerformance?.(sample)).catch(() => {});
    } catch {
      /* Metrics failure is isolated from routing. */
    }
  }
}
