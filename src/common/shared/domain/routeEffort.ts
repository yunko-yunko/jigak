import type { BaseRoute } from './types.js';

/** Existing effort policy, shared by graph and final rankings only after arrival ties. */
export function routeEffort(route: Pick<BaseRoute, 'segments' | 'transfers'>): number {
  return (
    route.segments.reduce(
      (total, segment) =>
        total +
        (segment.mode === 'run' ? segment.distanceMeters : segment.mode === 'hire' ? 1000 : 0),
      0,
    ) +
    route.transfers * 500
  );
}

export function compareRouteEffort(
  left: Pick<BaseRoute, 'segments' | 'transfers'>,
  right: Pick<BaseRoute, 'segments' | 'transfers'>,
): number {
  return routeEffort(left) - routeEffort(right);
}
