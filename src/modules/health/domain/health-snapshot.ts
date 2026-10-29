import { serviceCalendarStatus } from '../../../common/engine/realtime/service-calendar.js';
import { withPedestrianRouting } from '../../../common/engine/connectivity/provider.js';
import type { RoutingOptions } from '../../routing/domain/routing-options.js';

export function healthSnapshot(options: RoutingOptions) {
  const clock = options.now ?? Date.now;
  const baseProvider = options.provider!;
  const provider = withPedestrianRouting(baseProvider, options.pedestrian);
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
      bicycleRouting: baseProvider.configured && !!provider.bicycle,
      scooterRouting: baseProvider.configured && !!provider.scooter && !!options.scooterPolicy,
      weather: weather.configured,
      publicParking: parking.configured,
    },
    models: {
      publicBus: options.publicBus?.status() ?? {
        version: 'public-bus-duration-v2',
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
    },
    operatingData: {
      serviceCalendar: serviceCalendarStatus(clock()),
    },
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
