import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { KakaoProvider } from '../engine/kakao.js';
import { BicycleRouter, PedestrianRouter } from '../engine/connectivity/pedestrian.js';
import { RealtimeService } from '../engine/realtime/service.js';
import { NearbyTransitService } from '../engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../engine/realtime/seoulTraffic.js';
import { MobilityFeeds } from '../engine/realtime/mobility.js';
import { MeasuredBicycleRides } from '../engine/realtime/bicycle-ride-times.js';
import { SpatialBicycleRideService } from '../engine/intelligence/spatial-bicycle-ride.js';
import { SeoulIntersections, TrafficSignalFeed } from '../engine/realtime/trafficSignals.js';
import { SubwayLineService } from '../engine/realtime/subwayLine.js';
import { TravelTimeService } from '../engine/intelligence/travel-time-service.js';
import { WeatherFeed } from '../engine/realtime/weather.js';
import { SeoulParkingFeed } from '../engine/realtime/parking.js';
import { SeoulTimetableService } from '../engine/realtime/subwayTimetable.js';
import {
  busQuotaConfigFromEnvironment,
  publicDataConfigFromEnvironment,
} from '../engine/realtime/config.js';
import { loadEtaCalibrationSync, parseGbfsConfiguration } from '../engine/intelligence/config.js';
import { PublicBusModelService } from '../engine/intelligence/public-bus-service.js';
import {
  defaultRefreshStatusPath,
  ManifestWatcher,
  ModelRefreshMonitor,
} from '../engine/intelligence/model-manifest.js';
import { usePublishedKoreanHolidays } from '../engine/intelligence/korean-holidays.js';
import { usePublishedServiceCalendars } from '../engine/realtime/service-calendar.js';
import {
  BusEnvelopeRuntime,
  SpatialBusModelService,
} from '../engine/intelligence/spatial-bus-service.js';
import { SpatialBicycleShadowService } from '../engine/intelligence/spatial-bicycle-service.js';
import { RailGateModelService } from '../engine/intelligence/rail-gate-service.js';
import { LearningService } from '../../modules/learning/service/learning.service.js';
import type { RoutingOptions } from '../../modules/routing/domain/routing-options.js';
import { validateEnvironment } from '../config/environment.js';
import {
  capFleets,
  CLOUD_RUN_MAX_FLEET,
  SharedScooterSimulation,
} from '../engine/simulation/shared-scooter-sim.js';
import { SimulatedVehicleFeed } from '../engine/simulation/simulated-vehicle-feed.js';
import { SimulatedScooterPolicy } from '../engine/simulation/scooter-policy.js';
import { docklessRouting } from '../engine/simulation/scooter-router.js';

/** Repository of supplier adapters: a single cache and call budget policy per worker. */
@Injectable()
export class RuntimeRepository {
  readonly options: Required<
    Pick<
      RoutingOptions,
      | 'provider'
      | 'pedestrian'
      | 'realtime'
      | 'nearbyTransit'
      | 'traffic'
      | 'mobility'
      | 'weather'
      | 'parking'
    >
  > &
    RoutingOptions;

  constructor(@Inject(LearningService) learning: LearningService) {
    const env = process.env,
      config = validateEnvironment(env);
    const { dataGoKrServiceKey } = publicDataConfigFromEnvironment(env);
    const general = env.SEOUL_CITY_DATA_API_KEY || env.SEOUL_BIKE_API_KEY;

    // The refresh job publishes models and holiday files into a bucket and switches one manifest.
    // With MODEL_MANIFEST_PATH set the services follow it (no restart); without it every model
    // keeps its fixed ETA_*_PATH file. A path in ETA_*_PATH is still the fallback for a key the
    // manifest does not list.
    const manifest = config.MODEL_MANIFEST_PATH
      ? new ManifestWatcher({
          manifestPath: config.MODEL_MANIFEST_PATH,
          pollSeconds: config.MODEL_MANIFEST_POLL_SECONDS,
          fallbackPaths: {
            publicBus: env.ETA_PUBLIC_BUS_MODEL_PATH || undefined,
            spatialBus: env.ETA_SPATIAL_BUS_MODEL_PATH || undefined,
            railGate: env.ETA_RAIL_GATE_MODEL_PATH || undefined,
            bicycleRide: env.ETA_SPATIAL_BICYCLE_MODEL_PATH || undefined,
            bicycleRideTimes: env.BICYCLE_RIDE_TIMES_PATH || undefined,
          },
          onCalendars: (files, previous) => {
            usePublishedKoreanHolidays(files);
            try {
              usePublishedServiceCalendars(files);
            } catch (error) {
              usePublishedKoreanHolidays(previous);
              throw error;
            }
          },
        }).start()
      : null;
    const modelSource = (
      key: Parameters<ManifestWatcher['source']>[0],
      path: string | undefined,
    ) => (manifest ? manifest.source(key) : path || undefined);

    const provider = new KakaoProvider({
      key: env.KAKAO_REST_API_KEY,
      // Keep existing deployments working while preferring the current spare-key variable.
      fallbackKey: env.KAKAO_REST_API_KEY_SUB?.trim() || env.KAKAO_REST_API_KEY_FALLBACK,
    });
    // Batching only shares the public server's one-request-a-second slot, and its calls are what the
    // search budget protects. A self-hosted server answers at once and has no quota to spend.
    const pedestrian = new PedestrianRouter({
      enabled: config.PEDESTRIAN_ROUTING_ENABLED === 'true',
      endpoint: env.PEDESTRIAN_OSRM_URL || undefined,
      userAgent: env.PEDESTRIAN_USER_AGENT || undefined,
      batchWindowMs: env.PEDESTRIAN_OSRM_URL ? 0 : 150,
      metered: !env.PEDESTRIAN_OSRM_URL,
    });
    const cycling = new BicycleRouter({
      enabled: config.BICYCLE_ROUTING_ENABLED === 'true',
      endpoint: env.BICYCLE_OSRM_URL || undefined,
      userAgent: env.PEDESTRIAN_USER_AGENT || undefined,
      batchWindowMs: env.BICYCLE_OSRM_URL ? 0 : 150,
      metered: !env.BICYCLE_OSRM_URL,
    });
    const shadow = env.ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY;
    // Crosswalk timing: intersection positions from Seoul open data, live phases from T-DATA.
    const signals = {
      intersections: new SeoulIntersections({
        key: general,
      }),
      signals: new TrafficSignalFeed({
        key: env.TRAFFIC_SIGNAL_API_KEY,
      }),
    };

    // Demo scooters and e-bikes (시연용 가상 데이터) exist only when the server operator turns
    // them on. On Cloud Run a window must fit next to the routing models, so both types together
    // are capped (§12, §19).
    // A misspelt type turns nothing on; say so once instead of failing startup.
    if (config.simulationUnknownTypes.length) {
      console.warn(
        `MOBILITY_SIMULATION: unknown type ${config.simulationUnknownTypes.join(', ')} ignored (use scooter, ebike).`,
      );
    }
    const requestedFleets = config.simulationFleets;
    const fleets =
      requestedFleets && process.env.K_SERVICE
        ? capFleets(requestedFleets, CLOUD_RUN_MAX_FLEET)
        : requestedFleets;
    if (
      requestedFleets &&
      fleets &&
      fleets.scooter + fleets.ebike < requestedFleets.scooter + requestedFleets.ebike
    ) {
      console.warn(
        `Simulation fleets ${requestedFleets.scooter}+${requestedFleets.ebike} are above the Cloud Run cap; simulating ${fleets.scooter}+${fleets.ebike}.`,
      );
    }
    const simulation = fleets
      ? new SharedScooterSimulation({
          fleets,
          seed: config.MOBILITY_SIMULATION_SEED,
          log: (message) => console.info(message),
          windowDirectory: config.MOBILITY_SIMULATION_WINDOW_DIR,
          readyGate: config.MOBILITY_SIMULATION_READY_GATE === 'true',
        })
      : null;
    const simulationPolicy = simulation ? new SimulatedScooterPolicy(simulation) : null;
    // Scooter and e-bike rides wait at the signalled intersections on their path (A008P list).
    const simulatedRouting = docklessRouting(
      signals.intersections.configured ? signals.intersections : undefined,
    );

    // Today's window is read from the window store or computed in a worker right away, and each
    // next day's from 05:00 KST, so no request waits for one; until then /api/health/ready answers
    // 503 and routes say the simulated vehicles are still being placed.
    simulation?.start();

    if (signals.signals.configured && signals.intersections.configured) {
      void signals.intersections
        .near(
          {
            latitude: 37.5665,
            longitude: 126.978,
          },
          1,
        )
        .catch(() => {});
    }

    const realtime = new RealtimeService({
      seoulOpenApiKey: env.SEOUL_OPEN_API_KEY,
      seoulOpenApiKeyFallback: env.SEOUL_OPEN_API_KEY_FALLBACK,
      dataGoKrServiceKey,
      ...busQuotaConfigFromEnvironment(env),
    });

    this.options = {
      provider,
      pedestrian,
      cycling,
      signals,
      subwayLines: new SubwayLineService({
        seoulKey: general,
        realtimeKey: env.SEOUL_OPEN_API_KEY,
      }),
      travelTimes: new TravelTimeService({
        apiKey: env.OPENAI_API_KEY,
        model: env.OPENAI_MODEL,
      }),
      realtime,
      // Nearby stops read bus arrivals through the same caches and daily key budget as search and guidance.
      nearbyTransit: new NearbyTransitService({
        provider,
        realtime,
        seoulOpenApiKey: env.SEOUL_OPEN_API_KEY,
        seoulOpenApiKeyFallback: env.SEOUL_OPEN_API_KEY_FALLBACK,
      }),
      timetable: new SeoulTimetableService({
        key: general || env.SEOUL_OPEN_API_KEY,
      }),
      traffic: new RoadTrafficService({
        seoulCityDataKey: general,
      }),
      mobility: new MobilityFeeds({
        tagoPmServiceKey: dataGoKrServiceKey,
        seoulBikeKey: env.SEOUL_BIKE_API_KEY || general,
        gbfs: parseGbfsConfiguration(env.MOBILITY_GBFS_FEEDS),
        vehicleFeeds: simulation ? [new SimulatedVehicleFeed(simulation)] : [],
        // Measured dock-to-dock ride times; an empty path keeps the routing supplier's bicycle time.
        bikeRides: MeasuredBicycleRides.fromFile(
          (manifest ? manifest.verifiedPath('bicycleRideTimes') : env.BICYCLE_RIDE_TIMES_PATH) ||
            undefined,
        ),
        // Learned ride time for dock pairs the measured table lacks; an empty path keeps the router's time.
        bikeModel: modelSource('bicycleRide', env.ETA_SPATIAL_BICYCLE_MODEL_PATH)
          ? new SpatialBicycleRideService({
              modelPath: modelSource('bicycleRide', env.ETA_SPATIAL_BICYCLE_MODEL_PATH)!,
            })
          : null,
      }),
      // One policy answers both kinds; it refuses a vehicle of the other type (§19).
      ...(simulation ? { scooterSimulation: simulation } : {}),
      ...(simulationPolicy && simulation!.fleets.scooter > 0
        ? { scooterPolicy: simulationPolicy, scooterRouting: simulatedRouting }
        : {}),
      ...(simulationPolicy && simulation!.fleets.ebike > 0
        ? { ebikePolicy: simulationPolicy, ebikeRouting: simulatedRouting }
        : {}),
      weather: new WeatherFeed(dataGoKrServiceKey),
      parking: new SeoulParkingFeed(env.SEOUL_PARKING_API_KEY || general || env.SEOUL_OPEN_API_KEY),
      learning,
      // Spatial stop-count model first; the citywide public bus model covers legs it cannot read.
      publicBus:
        manifest || env.ETA_SPATIAL_BUS_MODEL_PATH || env.ETA_PUBLIC_BUS_MODEL_PATH
          ? new BusEnvelopeRuntime(
              modelSource('spatialBus', env.ETA_SPATIAL_BUS_MODEL_PATH)
                ? new SpatialBusModelService({
                    modelPath: modelSource('spatialBus', env.ETA_SPATIAL_BUS_MODEL_PATH)!,
                  })
                : undefined,
              modelSource('publicBus', env.ETA_PUBLIC_BUS_MODEL_PATH)
                ? new PublicBusModelService({
                    modelPath: modelSource('publicBus', env.ETA_PUBLIC_BUS_MODEL_PATH)!,
                  })
                : undefined,
            )
          : undefined,
      railGate: modelSource('railGate', env.ETA_RAIL_GATE_MODEL_PATH)
        ? new RailGateModelService({
            modelPath: modelSource('railGate', env.ETA_RAIL_GATE_MODEL_PATH)!,
          })
        : undefined,
      modelRefresh: new ModelRefreshMonitor({
        watcher: manifest,
        statusPath:
          config.MODEL_REFRESH_STATUS_PATH ??
          (config.MODEL_MANIFEST_PATH
            ? defaultRefreshStatusPath(config.MODEL_MANIFEST_PATH)
            : undefined),
        schedule: config.MODEL_REFRESH_SCHEDULE_KST,
      }),
      publicBicycleShadow: shadow
        ? new SpatialBicycleShadowService({
            modelPath: resolve(shadow, 'model.json'),
            reportPath: resolve(shadow, 'report.json'),
          })
        : undefined,
      intermediateTransitHubs: config.ROUTE_INTERMEDIATE_HUBS,
      routeCallLimit: config.ROUTE_CALL_LIMIT,
      calibration: loadEtaCalibrationSync(env.ETA_MODEL_PATH),
      ...(config.ROUTE_METRICS_ENABLED === 'true'
        ? {
            observeSearchPerformance: (sample) =>
              console.info(
                JSON.stringify({
                  event: 'route-performance',
                  ...sample,
                }),
              ),
          }
        : {}),
    };
  }
}
