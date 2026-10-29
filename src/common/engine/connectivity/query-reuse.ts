import type { CallBudget } from '../call-budget.js';
import { ApiError } from '../errors.js';
import type { RouteEndpoints, RouteProvider } from '../kakao.js';
import type { Place } from '../../shared/domain/types.js';

export type RouteQueryMode = 'walking' | 'transit' | 'bicycle' | 'scooter' | 'driving';

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
          ) {
            queries.delete(key);
          }
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

  const provider: RouteProvider = {
    configured: base.configured,
    searchPlaces: base.searchPlaces.bind(base),
    walking: reuse('walking', base.walking),
    transit: reuse('transit', base.transit),
    queryIsReusable: (mode, request, budget) =>
      searches.get(budget)?.has(queryKey(mode, request)) === true ||
      base.queryIsReusable?.(mode, request, budget) === true,
    ...(base.reverseGeocode
      ? {
          reverseGeocode: base.reverseGeocode.bind(base),
        }
      : {}),
    ...(base.nearby
      ? {
          nearby: base.nearby.bind(base),
        }
      : {}),
    ...(base.bicycle
      ? {
          bicycle: reuse('bicycle', base.bicycle),
        }
      : {}),
    ...(base.scooter
      ? {
          scooter: reuse('scooter', base.scooter),
        }
      : {}),
    ...(base.driving
      ? {
          driving: reuse('driving', base.driving),
        }
      : {}),
  };

  providerQueries.set(provider, searches);

  return provider;
}

/** A read-only reservation hint: remembered failures also need no new HTTP call. */
export function routeQueryIsReusable(
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
