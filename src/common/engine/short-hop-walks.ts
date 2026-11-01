import type { BaseRoute, Place } from '../shared/domain/types.js';
import { routeQueryIsFree } from './connectivity/query-reuse.js';
import { SHORT_HOP_METERS } from './journey-graph.js';
import { mergeWalkingRoute, totals, type MultimodalContext } from './multimodal.js';
import { metersBetween } from './realtime/names.js';

/** Walks asked for at most this many short bus stretches in one search. */
export const MAX_HOP_WALKS = 24;

/**
 * The walk of every short bus ride, so the journey graph can compare the ride with walking the same stretch
 * (MIN_RIDE_SAVING_SECONDS). The graph only prices a walk it was given: a stretch no source walked keeps its ride, so
 * without these a one-stop bus survives in nearly every itinerary. Asked only on a self-hosted pedestrian network, where
 * a lookup spends neither the call budget nor a supplier's quota; a failed lookup simply leaves that ride in place.
 */
export async function shortHopWalks(
  routes: readonly BaseRoute[],
  context: MultimodalContext,
): Promise<BaseRoute[]> {
  if (!routeQueryIsFree(context.provider, 'walking')) return [];
  const hops = new Map<string, { from: Place; to: Place }>();
  for (const route of routes)
    for (const segment of route.segments) {
      const straight = metersBetween(segment.start, segment.end);
      if (segment.mode !== 'bus' || straight < 1 || straight > SHORT_HOP_METERS) continue;
      const pair = `${segment.start.latitude.toFixed(6)},${segment.start.longitude.toFixed(6)}>${segment.end.latitude.toFixed(6)},${segment.end.longitude.toFixed(6)}`;
      if (!hops.has(pair)) hops.set(pair, { from: segment.start, to: segment.end });
    }
  const found = await Promise.all(
    [...hops.values()].slice(0, MAX_HOP_WALKS).map(async ({ from, to }, index) => {
      try {
        const walks = await context.provider.walking(
          { origin: from, destination: to },
          context.budget,
        );
        return walks.flatMap((route, alternative) => {
          const segment = mergeWalkingRoute(
            route,
            `hop-walk-${index}-${alternative}`,
            from,
            to,
            '걸어서 이동',
          );
          return segment
            ? [
                totals({
                  ...route,
                  id: segment.id,
                  segments: [segment],
                  notes: route.notes?.map((note) =>
                    note.segmentId ? { ...note, segmentId: segment.id } : note,
                  ),
                }),
              ]
            : [];
        });
      } catch {
        return [];
      }
    }),
  );
  return found.flat();
}
