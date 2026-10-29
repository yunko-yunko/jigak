import type { BaseRoute, Place } from '../shared/domain/index.js';
import { estimateBaseTimeline, type RoutingObjective } from '../shared/domain/estimatedTiming.js';

/** Acquisition follows the same clock as recommendation. These values only
 * order provider queries: they never prune a path or become a new routed ETA.
 * A whole timeline may fail while its fragments remain usable, so preserve
 * source upper bounds as fallback ordering evidence in that case.
 */
export function acquisitionTiming(
  route: BaseRoute,
  now: number,
  objective: RoutingObjective = 'estimated-arrival',
): {
  total: number;
  segments: number[];
} {
  const timeline =
    objective === 'estimated-arrival' ? estimateBaseTimeline(route.segments, now) : null;
  const segments =
    timeline?.components.map((component) => component.seconds) ??
    route.segments.map((segment) => segment.durationSeconds.max);

  return {
    total: segments.reduce((sum, value) => sum + value, 0),
    segments,
  };
}

/** Query-order context for fragments: an absent half of a journey never costs zero.
 * This uses only supplied endpoint connections, not invented travel or graph edges.
 */
export function contextualAcquisitionTimings(
  request: {
    origin: Place;
    destination: Place;
  },
  routes: readonly BaseRoute[],
  now: number,
  objective: RoutingObjective,
) {
  const pointKey = (point: Place) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

  const raw = new Map(routes.map((route) => [route, acquisitionTiming(route, now, objective)]));

  const edges = routes.flatMap((route) => {
    const start = route.segments[0]?.start,
      end = route.segments.at(-1)?.end,
      cost = raw.get(route)!.total;

    return start && end && Number.isFinite(cost) && cost >= 0
      ? [
          {
            from: pointKey(start),
            to: pointKey(end),
            cost,
          },
        ]
      : [];
  });

  const distances = (start: Place, reverse: boolean) => {
    const distance = new Map([[pointKey(start), 0]]),
      visited = new Set<string>();

    while (true) {
      let node: string | undefined,
        best = Infinity;

      for (const [candidate, value] of distance) {
        if (!visited.has(candidate) && value < best) {
          node = candidate;
          best = value;
        }
      }

      if (node === undefined) {
        return distance;
      }

      visited.add(node);

      for (const edge of edges) {
        const from = reverse ? edge.to : edge.from,
          to = reverse ? edge.from : edge.to;

        if (from === node && best + edge.cost < (distance.get(to) ?? Infinity)) {
          distance.set(to, best + edge.cost);
        }
      }
    }
  };

  const before = distances(request.origin, false),
    after = distances(request.destination, true);

  return new Map(
    routes.map((route) => {
      const timing = raw.get(route)!,
        first = route.segments[0]?.start,
        last = route.segments.at(-1)?.end;
      const prefix = first ? (before.get(pointKey(first)) ?? Infinity) : Infinity;
      const suffix = last ? (after.get(pointKey(last)) ?? Infinity) : Infinity;

      return [
        route,
        {
          ...timing,
          total: prefix + timing.total + suffix,
          prefix,
          suffix,
        },
      ];
    }),
  );
}
