import { SeoulTimetableService } from '../../../common/engine/realtime/subwayTimetable.js';
import type { RailGateRuntime } from '../../../common/engine/intelligence/rail-gate-service.js';
import type { RoutingObjective } from '../../../common/shared/domain/estimatedTiming.js';
import type {
  EbikeRouting,
  ScooterRouting,
} from '../../../common/engine/simulation/scooter-router.js';
import type { SharedScooterSimulation } from '../../../common/engine/simulation/shared-scooter-sim.js';
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
import {
  withPedestrianRouting,
  type BicycleRouting,
} from '../../../common/engine/connectivity/provider.js';
import type { SignalTiming } from '../../../common/engine/realtime/trafficSignals.js';
import type { SubwayLineService } from '../../../common/engine/realtime/subwayLine.js';
import type { TravelTimeService } from '../../../common/engine/intelligence/travel-time-service.js';
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
import type { ModelRefreshMonitor } from '../../../common/engine/intelligence/model-manifest.js';

export interface RoutingOptions {
  routingObjective?: RoutingObjective;
  /** In-process audit hook. No route snapshots or configuration are exposed over HTTP. */
  observeGraphSearch?: (snapshot: {
    request: BasePlanningRequest;
    bases: BaseRoute[];
    options: import('../../../common/engine/journey-graph.js').JourneyGraphOptions;
    result: import('../../../common/engine/journey-graph.js').JourneyGraphResult;
  }) => void;
  /** Numeric in-process telemetry; never includes request coordinates or supplier content. */
  observeSearchPerformance?: (sample: SearchPerformance) => void | Promise<void>;
  provider?: RouteProvider;
  /** Explicitly configured pedestrian-network provider; all modes still share one call budget. */
  pedestrian?: {
    configured: boolean;
    walking: RouteProvider['walking'];
  };
  /** OpenStreetMap bicycle network for rides between docks, asked before Kakao's quota-limited bicycle routing. */
  cycling?: BicycleRouting;
  /** Live bus/subway arrivals; omitted or unconfigured keeps provider estimates only. */
  realtime?: RealtimeService;
  timetable?: SeoulTimetableService;
  /** Nearby verified stop/station positions plus provider arrival observations. */
  nearbyTransit?: NearbyTransitService;
  /** Live road speeds read along routes; unconfigured leaves provider times untouched. */
  traffic?: RoadTrafficService;
  /** Live pedestrian signal phases at Seoul intersections, timed onto each route's first walk. */
  signals?: SignalTiming;
  /** Live train positions along a subway line. */
  subwayLines?: SubwayLineService;
  /** Live shared-scooter positions and public-bike stock; unconfigured offers neither unverified. */
  mobility?: MobilityFeeds;
  weather?: WeatherFeed;
  parking?: ParkingLookup;
  scooterPolicy?: ScooterConnectionContext['scooterPolicy'];
  /** Scooter rides re-timed from the bicycle network; set only while a scooter source is simulated. */
  scooterRouting?: ScooterRouting;
  /** Permissions for dockless e-bikes (`verify` is asked with `mode: 'ebike'`); absent means no e-bike rentals. */
  ebikePolicy?: ScooterConnectionContext['ebikePolicy'];
  /** E-bike rides re-timed from the bicycle network; set only while an e-bike source is simulated. */
  ebikeRouting?: EbikeRouting;
  /** Demo kick-scooter simulator (MOBILITY_SIMULATION=scooter); absent means fully off. */
  scooterSimulation?: SharedScooterSimulation;
  calibration?: EtaCalibration;
  learning?: EtaLearningService;
  travelTimes?: TravelTimeService;
  publicBus?: PublicBusRuntime;
  /** Subway gate-to-gate envelope; widens only the slower bound of a subway run. */
  railGate?: RailGateRuntime;
  publicBicycleShadow?: SpatialBicycleShadowService;
  /** Follows the refresh job's manifest and report; health shows its summary. Absent means no manifest. */
  modelRefresh?: ModelRefreshMonitor;
  key?: string;
  corsOrigins?: string[];
  now?: () => number;
  /** Request limiter is per process; external provider quotas still apply separately. */
  rateLimit?: number;
  /** Extra supplier queries at verified intermediate stations, bounded to two hubs. */
  intermediateTransitHubs?: number;
  /** Offline/reference audits only. This is never accepted from the public request body. */
  acquisitionAudit?: {
    intermediateTransitHubs: number;
    intermediateTransitMaxRouteCalls: number;
  };
  /** Operator-controlled total for every route request, retry and refinement. */
  routeCallLimit?: number;
}
