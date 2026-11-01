import { serviceCalendarStatus } from '../../../common/engine/realtime/service-calendar.js';
import { withPedestrianRouting } from '../../../common/engine/connectivity/provider.js';
import type { RoutingOptions } from '../../routing/domain/routing-options.js';
import { PUBLIC_BUS_MODEL_VERSION } from '../../../common/engine/intelligence/public-bus-model.js';
import { fleetByTypeOf } from '../../../common/engine/simulation/sim-window.js';
import { footWeightsStatus } from '../../../common/engine/simulation/foot-traffic.js';
import { koreanHolidayOrigin } from '../../../common/engine/intelligence/korean-holidays.js';
import { modelRefreshSummary } from './model-refresh.js';

export function healthSnapshot(options: RoutingOptions) {
  const clock = options.now ?? Date.now;
  const baseProvider = options.provider!;
  const provider = withPedestrianRouting(baseProvider, options.pedestrian, {
    cycling: options.cycling,
    scooter: options.scooterRouting,
    ebike: options.ebikeRouting,
  });
  const { realtime, traffic, mobility, weather, parking } = options as Required<RoutingOptions>;

  return {
    status: 'ok',
    mode: provider.configured ? 'live-ready' : 'demo-only',
    capabilities: {
      places: baseProvider.configured,
      walking: provider.configured,
      transit: baseProvider.configured,
      realtime: realtime.capabilities.subway || realtime.capabilities.bus,
      realtimeSubway: realtime.capabilities.subway,
      realtimeBus: realtime.capabilities.bus,
      reverseGeocode: baseProvider.configured && !!provider.reverseGeocode,
      roadTraffic: traffic.configured,
      sharedBicycle: mobility.capabilities.sharedBicycle,
      sharedScooter: mobility.capabilities.sharedScooter,
      sharedEbike: mobility.capabilities.sharedEbike,
      bicycleRouting: baseProvider.configured && !!provider.bicycle,
      scooterRouting: baseProvider.configured && !!provider.scooter && !!options.scooterPolicy,
      ebikeRouting: baseProvider.configured && !!provider.ebike && !!options.ebikePolicy,
      weather: weather.configured,
      publicParking: parking.configured,
    },
    models: {
      hgb: options.learning?.hgb.status() ?? {
        version: 'eta-hgb-v1',
        active: false,
        reasons: ['unconfigured'],
      },
      travelTimes: options.travelTimes?.status() ?? {
        configured: false,
      },
      publicBus: options.publicBus?.status() ?? {
        version: PUBLIC_BUS_MODEL_VERSION,
        active: false,
        reasons: ['unconfigured'],
      },
      publicBicycle: options.publicBicycleShadow?.status() ?? {
        version: 'seoul-bicycle-spatial-v1',
        available: false,
        active: false,
        deployment: 'shadow',
        reasons: ['unconfigured'],
      },
      railGate: options.railGate?.status() ?? {
        version: 'seoul-rail-gate-v1',
        active: false,
        reasons: ['unconfigured'],
      },
      bicycleRide: mobility.bikeModel?.status() ?? {
        version: 'seoul-bicycle-spatial-v2',
        active: false,
        reasons: ['unconfigured'],
      },
    },
    // The refresh job's state: manifest generation, last run, next run and each model's retry state.
    modelRefresh: modelRefreshSummary(options),
    operatingData: {
      serviceCalendar: serviceCalendarStatus(clock()),
      holidayFiles: koreanHolidayOrigin(),
    },
    // The demo simulator (시연용 가상 데이터): which types run and where today's window stands
    // (building, read from the window store or computed here, §22).
    simulation: options.scooterSimulation
      ? {
          enabled: true,
          ...options.scooterSimulation.readiness(clock()),
          fleet: options.scooterSimulation.fleet,
          fleetByType: fleetByTypeOf(options.scooterSimulation.fleets),
          modelVersion: options.scooterSimulation.modelVersion,
          footWeights: footWeightsStatus(),
          windowStore: options.scooterSimulation.storeConfigured ? 'configured' : 'off',
        }
      : { enabled: false },
    // Key presence is configuration, not evidence of an authenticated successful call.
    liveVerified: false,
    realtimeSources: realtime.diagnostics,
    generatedAt: clock(),
    notice: baseProvider.configured
      ? '인증 키가 설정됐어요. 실제 호출 성공과 경로 품질은 각 조회에서 확인해요.'
      : options.pedestrian?.configured
        ? '보행망 경로를 조회할 수 있어요. 장소·대중교통 등 다른 공급원의 설정은 별도로 필요해요.'
        : '인증 키가 없어 실제 장소·경로 검색이 비활성화됐어요. 앱의 시연 모드는 별도로 이용할 수 있어요.',
  };
}
