import type { BaseRoute, Place } from '../../shared/domain/types.js';
import type { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import type { RouteEndpoints, RouteProvider, TravelTable } from '../kakao.js';
import { metersBetween } from '../realtime/names.js';
import type { EbikeRouting, ScooterRouting } from '../simulation/scooter-router.js';
import { routerOutage } from './pedestrian.js';
import {
  MAX_CONNECTOR_METERS,
  connectWalkingEndpoints,
  measureWalkingRoute,
} from './walking-comparison.js';

type TableLookup = (
  sources: readonly Place[],
  destinations: readonly Place[],
  budget: CallBudget,
) => Promise<TravelTable>;
export interface PedestrianRouting {
  configured: boolean;
  /** True while a self-hosted server answers walks without spending the search's call budget. */ readonly unmetered?: boolean;
  walking: RouteProvider['walking'];
  walkingIsCached?(request: Parameters<RouteProvider['walking']>[0]): boolean;
  walkingTable?: TableLookup;
}
export interface BicycleRouting {
  configured: boolean;
  /** True while a self-hosted server answers rides without spending the search's call budget. */ readonly unmetered?: boolean;
  bicycle: NonNullable<RouteProvider['bicycle']>;
  bicycleIsCached?(request: RouteEndpoints): boolean;
  bicycleTable?: TableLookup;
}

/** A walk this much longer than the straight line is checked on the second network. */
const DETOUR_RATIO = 1.6;
const DETOUR_EXTRA_METERS = 200;

/** True when no walk reaches both requested points, or the shortest one is a clear detour. */
function detoured(routes: readonly BaseRoute[], request: RouteEndpoints): boolean {
  const lengths = routes.flatMap((route) => {
    const measured = measureWalkingRoute(route);
    if (!measured) return [];
    const gaps =
      metersBetween(request.origin, measured.start) +
      metersBetween(measured.end, request.destination);
    return metersBetween(request.origin, measured.start) <= MAX_CONNECTOR_METERS &&
      metersBetween(measured.end, request.destination) <= MAX_CONNECTOR_METERS
      ? [measured.distanceMeters + gaps]
      : [];
  });
  if (!lengths.length) return true;
  const shortest = Math.min(...lengths),
    straight = metersBetween(request.origin, request.destination);
  return shortest > straight * DETOUR_RATIO && shortest - straight > DETOUR_EXTRA_METERS;
}

/**
 * The OpenStreetMap foot network answers every walk; it has no daily quota and walks asked
 * for together share one request. Kakao's Korean pedestrian network, whose walk quota is
 * small, is asked only when OSRM fails or detours. A POI inside a large building (서울역)
 * can sit up to 150 m from Kakao's nearest link; that stretch is kept as a short connector.
 * Every connected answer goes to the planner, which keeps the fastest. `secondOpinion` lets
 * a search stop asking Kakao once its transit walks are known.
 *
 * Rides between bike docks likewise use the OpenStreetMap bicycle network first. Kakao's
 * bicycle routing shares the small walk quota, so it is asked only when that network is down,
 * never when it answered that no ride connects the two points.
 */
export function withPedestrianRouting(
  base: RouteProvider,
  pedestrian?: PedestrianRouting,
  options: {
    secondOpinion?: () => boolean;
    /** While the foot network is self-hosted, only this many walks ask Kakao for a second opinion. */ secondOpinionLookups?: number;
    cycling?: BicycleRouting;
    /** Scooter rides built on the bicycle network below; without it the base provider's scooter routing, if any. */
    scooter?: ScooterRouting;
    /** Dockless e-bike rides built on the same bicycle network; absent means no e-bike rides. */
    ebike?: EbikeRouting;
  } = {},
): RouteProvider {
  let secondOpinions = 0;
  const cycling = options.cycling?.configured ? options.cycling : undefined;
  if (!base.configured && !pedestrian?.configured && !cycling) return base;
  const primaryNetwork = pedestrian?.configured ? pedestrian : undefined;
  const kakaoBicycle = base.configured && base.bicycle ? base.bicycle.bind(base) : undefined;
  const bicycle = !cycling
    ? base.bicycle?.bind(base)
    : async (
        request: RouteEndpoints,
        budget: Parameters<NonNullable<RouteProvider['bicycle']>>[1],
      ) => {
        try {
          return await cycling.bicycle(request, budget);
        } catch (failure) {
          // Kakao's small quota is spent only when the network gave no answer; its "no route" stands.
          if (
            !(failure instanceof ApiError) ||
            !routerOutage(failure) ||
            !kakaoBicycle ||
            budget.remaining === 0
          )
            throw failure;
          try {
            return await kakaoBicycle(request, budget);
          } catch (error) {
            throw error instanceof ApiError && error.code === 'PROVIDER_LIMIT' ? failure : error;
          }
        }
      };
  const scooterRouting = options.scooter;
  const scooter =
    scooterRouting && bicycle
      ? (request: RouteEndpoints, budget: Parameters<NonNullable<RouteProvider['scooter']>>[1]) =>
          scooterRouting.scooter(bicycle, request, budget)
      : base.scooter?.bind(base);
  const ebikeRouting = options.ebike;
  const ebike =
    ebikeRouting && bicycle
      ? (request: RouteEndpoints, budget: Parameters<NonNullable<RouteProvider['ebike']>>[1]) =>
          ebikeRouting.ebike(bicycle, request, budget)
      : base.ebike?.bind(base);
  const kakaoWalk = async (
    request: RouteEndpoints,
    budget: Parameters<RouteProvider['walking']>[1],
  ) => connectWalkingEndpoints(await base.walking(request, budget), request);
  return {
    configured: base.configured || !!primaryNetwork,
    searchPlaces: base.searchPlaces.bind(base),
    walking: async (request, budget) => {
      if (!primaryNetwork) return kakaoWalk(request, budget);
      let primary: BaseRoute[] | undefined, failure: unknown;
      try {
        primary = await primaryNetwork.walking(request, budget);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        failure = error;
      }
      // Only a detoured walk uses up one of the few second opinions; straight walks and failed lookups do not count.
      const detouredWalk = !!primary && detoured(primary, request);
      const asking =
        options.secondOpinion?.() !== false &&
        !(
          detouredWalk &&
          primaryNetwork.unmetered === true &&
          options.secondOpinionLookups !== undefined &&
          ++secondOpinions > options.secondOpinionLookups
        );
      const settled = !!primary && (!detouredWalk || !asking);
      if (!base.configured || settled || budget.remaining === 0) {
        if (primary) return primary;
        throw failure;
      }
      try {
        return [...(primary ?? []), ...(await kakaoWalk(request, budget))];
      } catch (error) {
        if (primary && error instanceof ApiError) return primary;
        throw failure instanceof ApiError &&
          error instanceof ApiError &&
          error.code === 'PROVIDER_LIMIT'
          ? failure
          : error;
      }
    },
    transit: base.transit.bind(base),
    // A cached OSRM walk needs no request unless it detours, which a cache hit cannot tell yet.
    queryIsReusable: (mode, request, budget) =>
      mode === 'walking'
        ? primaryNetwork?.walkingIsCached?.(request) === true
        : (mode === 'bicycle' ||
              (mode === 'scooter' && scooterRouting && bicycle) ||
              (mode === 'ebike' && ebikeRouting && bicycle)) &&
            cycling
          ? cycling.bicycleIsCached?.(request) === true
          : base.queryIsReusable?.(mode, request, budget) === true,
    ...(primaryNetwork?.unmetered !== undefined || cycling?.unmetered !== undefined
      ? {
          unmetered: {
            get walking() {
              return primaryNetwork?.unmetered === true;
            },
            get bicycle() {
              return cycling?.unmetered === true;
            },
          },
        }
      : {}),
    ...(base.reverseGeocode ? { reverseGeocode: base.reverseGeocode.bind(base) } : {}),
    ...(primaryNetwork?.walkingTable || cycling?.bicycleTable
      ? {
          travelTable: (
            mode: 'walking' | 'bicycle',
            sources: readonly Place[],
            destinations: readonly Place[],
            budget: CallBudget,
          ) => {
            const lookup =
              mode === 'walking'
                ? primaryNetwork?.walkingTable?.bind(primaryNetwork)
                : cycling?.bicycleTable?.bind(cycling);
            return lookup
              ? lookup(sources, destinations, budget)
              : Promise.reject(
                  new ApiError(
                    'LIVE_NOT_CONFIGURED',
                    '이동 시간표를 제공하는 경로 서버가 없어요.',
                    503,
                  ),
                );
          },
        }
      : {}),
    ...(bicycle ? { bicycle } : {}),
    ...(scooter ? { scooter } : {}),
    ...(ebike ? { ebike } : {}),
    ...(base.driving ? { driving: base.driving.bind(base) } : {}),
    ...(base.nearby ? { nearby: base.nearby.bind(base) } : {}),
  };
}
