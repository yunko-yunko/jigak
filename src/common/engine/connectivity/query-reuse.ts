import type { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import type { RouteEndpoints, RouteProvider } from '../kakao.js';
import type { Place } from '../../shared/domain/types.js';

export type RouteQueryMode = 'walking' | 'transit' | 'bicycle' | 'scooter' | 'ebike' | 'driving';

type SearchQueries = WeakMap<CallBudget, Map<string, Promise<unknown>>>;
const providerQueries = new WeakMap<RouteProvider, SearchQueries>();

// RouteEndpoints has no routing options beyond these two Places. Planning-only
// request fields must not split the same endpoint query. Keep every Place field:
// equal coordinates with different identities can produce different labels.
const placeIdentity = (place: Place) => [
  place.id,
  place.name,
  place.address,
  place.latitude,
  place.longitude,
  place.note,
];
const queryKey = (mode: RouteQueryMode, request: RouteEndpoints) =>
  JSON.stringify([mode, placeIdentity(request.origin), placeIdentity(request.destination)]);

/**
 * Share one source query per mode, endpoint identity and search budget. Pending,
 * successful queries and provider failures stay remembered for that search.
 * Budget refusals are transient: a reservation may release calls later. A new
 * budget always starts fresh, including live transit/traffic and failed attempts.
 *
 * Only the source provider spends the budget, since its cache/fallback/retry may
 * perform zero or multiple HTTP calls. Snapshot its result once, then deep-clone
 * for every consumer so graph assembly cannot mutate another candidate.
 */
export function withRouteQueryReuse(base: RouteProvider): RouteProvider {
  const searches: SearchQueries = new WeakMap();
  const reuse =
    <T>(
      mode: RouteQueryMode,
      method: (request: RouteEndpoints, budget: CallBudget) => Promise<T>,
    ) =>
    (request: RouteEndpoints, budget: CallBudget): Promise<T> => {
      let queries = searches.get(budget);
      if (!queries) {
        queries = new Map();
        searches.set(budget, queries);
      }
      const key = queryKey(mode, request);
      let pending = queries.get(key) as Promise<T> | undefined;
      if (!pending) {
        // Register before calling the source, including a synchronous failure.
        let resolve!: (result: T) => void, reject!: (error: unknown) => void;
        pending = new Promise<T>((done, fail) => {
          resolve = done;
          reject = fail;
        });
        queries.set(key, pending);
        const entry = pending;
        void entry.catch((error) => {
          // Keep pending consumers together, even after a synchronous refusal.
          // A delayed failure must never remove a newer query for this key.
          if (
            error instanceof ApiError &&
            error.code === 'CALL_BUDGET_EXCEEDED' &&
            queries.get(key) === entry
          )
            queries.delete(key);
        });
        try {
          // Start now: providers reserve actual HTTP attempts synchronously.
          Promise.resolve(method.call(base, request, budget))
            .then((result) => structuredClone(result))
            .then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      }
      return pending.then((result) => structuredClone(result));
    };
  // Station searches carry no budget; this provider belongs to one search, so identical keyword searches share one answer.
  const places = new Map<string, ReturnType<NonNullable<RouteProvider['nearby']>>>();
  const nearby =
    base.nearby &&
    ((query: Parameters<NonNullable<RouteProvider['nearby']>>[0]) => {
      const key = JSON.stringify(query);
      let pending = places.get(key) as ReturnType<NonNullable<RouteProvider['nearby']>> | undefined;
      if (!pending) {
        try {
          pending = base.nearby!.call(base, query);
        } catch (error) {
          pending = Promise.reject(error);
        }
        places.set(key, pending);
      }
      return pending;
    });
  const provider: RouteProvider = {
    configured: base.configured,
    searchPlaces: base.searchPlaces.bind(base),
    walking: reuse('walking', base.walking),
    transit: reuse('transit', base.transit),
    queryIsReusable: (mode, request, budget) =>
      searches.get(budget)?.has(queryKey(mode, request)) === true ||
      base.queryIsReusable?.(mode, request, budget) === true,
    ...(base.unmetered ? { unmetered: base.unmetered } : {}),
    ...(base.reverseGeocode ? { reverseGeocode: base.reverseGeocode.bind(base) } : {}),
    ...(nearby ? { nearby } : {}),
    ...(base.travelTable ? { travelTable: base.travelTable.bind(base) } : {}),
    ...(base.bicycle ? { bicycle: reuse('bicycle', base.bicycle) } : {}),
    ...(base.scooter ? { scooter: reuse('scooter', base.scooter) } : {}),
    ...(base.ebike ? { ebike: reuse('ebike', base.ebike) } : {}),
    ...(base.driving ? { driving: reuse('driving', base.driving) } : {}),
  };
  providerQueries.set(provider, searches);
  return provider;
}

/** True while this mode runs on a self-hosted network: it spends neither the search's call budget nor any supplier quota. */
export function routeQueryIsFree(provider: RouteProvider, mode: RouteQueryMode): boolean {
  return mode === 'walking'
    ? provider.unmetered?.walking === true
    : mode === 'bicycle'
      ? provider.unmetered?.bicycle === true
      : false;
}

/** A read-only hint: a remembered answer (a failure too) already exists for this search, or the supplier's cache holds it. */
export function routeQueryIsCached(
  provider: RouteProvider,
  mode: RouteQueryMode,
  request: RouteEndpoints,
  budget: CallBudget,
): boolean {
  return (
    providerQueries.get(provider)?.get(budget)?.has(queryKey(mode, request)) === true ||
    provider.queryIsReusable?.(mode, request, budget) === true
  );
}

/** A read-only reservation hint: the query needs no call from the budget, because its answer is remembered or because its
 * network is self-hosted. A free query is still bounded by its router's own timeout and concurrency cap. */
export function routeQueryIsReusable(
  provider: RouteProvider,
  mode: RouteQueryMode,
  request: RouteEndpoints,
  budget: CallBudget,
): boolean {
  return routeQueryIsFree(provider, mode) || routeQueryIsCached(provider, mode, request, budget);
}
