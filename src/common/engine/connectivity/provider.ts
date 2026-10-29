import type { RouteProvider } from '../kakao.js';

export interface PedestrianRouting {
  configured: boolean;
  walking: RouteProvider['walking'];
  walkingIsCached?(request: Parameters<RouteProvider['walking']>[0]): boolean;
}

/** Preserve the owning instance of every adapter, with one shared per-search budget. */
export function withPedestrianRouting(
  base: RouteProvider,
  pedestrian?: PedestrianRouting,
): RouteProvider {
  if (!pedestrian?.configured) {
    return base;
  }

  return {
    configured: base.configured || pedestrian.configured,
    searchPlaces: base.searchPlaces.bind(base),
    walking: async (request, budget) => {
      try {
        return await pedestrian.walking(request, budget);
      } catch (error) {
        if (!base.configured || budget.remaining === 0) {
          throw error;
        }

        // The regular graph geometry gates still apply to a fallback response.
        return base.walking(request, budget);
      }
    },
    transit: base.transit.bind(base),
    queryIsReusable: (mode, request, budget) =>
      mode === 'walking'
        ? pedestrian.walkingIsCached?.(request) === true
        : base.queryIsReusable?.(mode, request, budget) === true,
    ...(base.reverseGeocode
      ? {
          reverseGeocode: base.reverseGeocode.bind(base),
        }
      : {}),
    ...(base.bicycle
      ? {
          bicycle: base.bicycle.bind(base),
        }
      : {}),
    ...(base.scooter
      ? {
          scooter: base.scooter.bind(base),
        }
      : {}),
    ...(base.driving
      ? {
          driving: base.driving.bind(base),
        }
      : {}),
    ...(base.nearby
      ? {
          nearby: base.nearby.bind(base),
        }
      : {}),
  };
}
