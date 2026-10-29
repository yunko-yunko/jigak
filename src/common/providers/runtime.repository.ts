import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { KakaoProvider } from '../engine/kakao.js';
import { PedestrianRouter } from '../engine/connectivity/pedestrian.js';
import { RealtimeService } from '../engine/realtime/service.js';
import { NearbyTransitService } from '../engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../engine/realtime/seoulTraffic.js';
import { MobilityFeeds } from '../engine/realtime/mobility.js';
import { WeatherFeed } from '../engine/realtime/weather.js';
import { SeoulParkingFeed } from '../engine/realtime/parking.js';
import { SeoulTimetableService } from '../engine/realtime/subwayTimetable.js';
import { publicDataConfigFromEnvironment } from '../engine/realtime/config.js';
import { loadEtaCalibrationSync, parseGbfsConfiguration } from '../engine/intelligence/config.js';
import { PublicBusModelService } from '../engine/intelligence/public-bus-service.js';
import { SpatialBicycleShadowService } from '../engine/intelligence/spatial-bicycle-service.js';
import { LearningService } from '../../modules/learning/service/learning.service.js';
import type { RoutingOptions } from '../../modules/routing/domain/routing-options.js';
import { validateEnvironment } from '../config/environment.js';

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

    const provider = new KakaoProvider({
      key: env.KAKAO_REST_API_KEY,
    });
    const pedestrian = new PedestrianRouter({
      enabled: config.PEDESTRIAN_ROUTING_ENABLED === 'true',
      endpoint: env.PEDESTRIAN_OSRM_URL || undefined,
      userAgent: env.PEDESTRIAN_USER_AGENT || undefined,
    });
    const shadow = env.ETA_PUBLIC_BICYCLE_SHADOW_DIRECTORY;

    this.options = {
      provider,
      pedestrian,
      realtime: new RealtimeService({
        seoulOpenApiKey: env.SEOUL_OPEN_API_KEY,
        dataGoKrServiceKey,
      }),
      nearbyTransit: new NearbyTransitService({
        provider,
        seoulOpenApiKey: env.SEOUL_OPEN_API_KEY,
        dataGoKrServiceKey,
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
      }),
      weather: new WeatherFeed(dataGoKrServiceKey),
      parking: new SeoulParkingFeed(env.SEOUL_PARKING_API_KEY || general || env.SEOUL_OPEN_API_KEY),
      learning,
      publicBus: env.ETA_PUBLIC_BUS_MODEL_PATH
        ? new PublicBusModelService({
            modelPath: env.ETA_PUBLIC_BUS_MODEL_PATH,
          })
        : undefined,
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
