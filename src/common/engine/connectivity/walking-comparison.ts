import { MAX_NETWORK_SNAP_METERS, type BaseRoute, type Place } from '../../shared/domain/types.js';
import type { RouteEndpoints } from '../kakao.js';
import { metersBetween } from '../realtime/names.js';

type Point = Pick<Place, 'latitude' | 'longitude'>;
const validPoint = (point: Point | undefined): point is Point =>
  !!point &&
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;
const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;

export interface MeasuredWalkingRoute {
  route: BaseRoute;
  start: Place;
  end: Place;
  distanceMeters: number;
  seconds: number;
}

/** Inspect source geometry as returned. Never add a connector or move a path. */
export function measureWalkingRoute(route: BaseRoute): MeasuredWalkingRoute | null {
  if (
    !route.segments.length ||
    !finiteNonnegative(route.distanceMeters) ||
    route.distanceMeters === 0 ||
    !finiteNonnegative(route.durationSeconds.min) ||
    !finiteNonnegative(route.durationSeconds.max) ||
    route.durationSeconds.min > route.durationSeconds.max
  )
    return null;
  let first: Place | undefined, last: Place | undefined, previous: Place | undefined;
  let distance = 0,
    minimumSeconds = 0,
    maximumSeconds = 0;
  for (const segment of route.segments) {
    if (
      !validPoint(segment.start) ||
      !validPoint(segment.end) ||
      !finiteNonnegative(segment.distanceMeters) ||
      !finiteNonnegative(segment.durationSeconds.min) ||
      !finiteNonnegative(segment.durationSeconds.max) ||
      segment.durationSeconds.min > segment.durationSeconds.max ||
      segment.traffic?.some((span) => span.level === 'blocked') ||
      (previous && metersBetween(previous, segment.start) > 1)
    )
      return null;
    if (segment.mode === 'wait') {
      if (
        segment.distanceMeters !== 0 ||
        metersBetween(segment.start, segment.end) > 1 ||
        segment.timingRule !== undefined
      )
        return null;
    } else if (segment.mode === 'walk') {
      const path = segment.polyline;
      if (
        !Array.isArray(path) ||
        path.length < 2 ||
        !path.every(validPoint) ||
        metersBetween(segment.start, path[0]) > 1 ||
        metersBetween(segment.end, path.at(-1)!) > 1
      )
        return null;
      const physicalMeters = path
        .slice(1)
        .reduce((sum, point, index) => sum + metersBetween(path[index], point), 0);
      if (
        (physicalMeters < 1 && segment.distanceMeters > 0) ||
        segment.distanceMeters + Math.min(50, Math.max(5, path.length * 0.2)) < physicalMeters
      )
        return null;
      first ??= { ...segment.start, ...path[0] };
      last = { ...segment.end, ...path.at(-1)! };
      distance += segment.distanceMeters;
    } else return null;
    minimumSeconds += segment.durationSeconds.min;
    maximumSeconds += segment.durationSeconds.max;
    previous = segment.end;
  }
  if (
    !first ||
    !last ||
    distance <= 0 ||
    route.distanceMeters + 1 < distance ||
    route.durationSeconds.min + 1 < minimumSeconds ||
    route.durationSeconds.max + 1 < maximumSeconds
  )
    return null;
  return {
    route,
    start: first,
    end: last,
    distanceMeters: route.distanceMeters,
    seconds: Math.ceil((route.durationSeconds.min + route.durationSeconds.max) / 2),
  };
}

/** A POI inside a station or campus can sit this far from the nearest walkable link. */
export const MAX_CONNECTOR_METERS = MAX_NETWORK_SNAP_METERS;

/**
 * Join a network route to the requested points with a short straight connector, the way map
 * apps draw the stretch from a building's map point to the street. The network time stays the
 * lower bound; the connector at 1 m/s widens only the upper bound, since the rider may already
 * be at the exit. Other routes pass through unchanged for the planner's own geometry checks.
 */
export function connectWalkingEndpoints(
  routes: readonly BaseRoute[],
  request: RouteEndpoints,
): BaseRoute[] {
  return routes.map((route) => {
    const measured = measureWalkingRoute(route);
    if (!measured) return route;
    const startGap = metersBetween(request.origin, measured.start),
      endGap = metersBetween(measured.end, request.destination);
    if (
      startGap > MAX_CONNECTOR_METERS ||
      endGap > MAX_CONNECTOR_METERS ||
      (startGap < 1 && endGap < 1)
    )
      return route;
    const first = route.segments.findIndex((segment) => segment.mode === 'walk'),
      last = route.segments.findLastIndex((segment) => segment.mode === 'walk');
    const origin = { latitude: request.origin.latitude, longitude: request.origin.longitude };
    const destination = {
      latitude: request.destination.latitude,
      longitude: request.destination.longitude,
    };
    const startSeconds = startGap < 1 ? 0 : Math.ceil(startGap),
      endSeconds = endGap < 1 ? 0 : Math.ceil(endGap);
    const segments = route.segments.map((segment, index) => {
      const copy = {
        ...segment,
        start: { ...segment.start },
        end: { ...segment.end },
        durationSeconds: { ...segment.durationSeconds },
        polyline: segment.polyline && [...segment.polyline],
      };
      if (index < first) (Object.assign(copy.start, origin), Object.assign(copy.end, origin));
      if (index > last)
        (Object.assign(copy.start, destination), Object.assign(copy.end, destination));
      if (index === first && startSeconds) {
        Object.assign(copy.start, origin);
        copy.polyline = [origin, ...copy.polyline!];
        copy.distanceMeters += Math.round(startGap);
        copy.durationSeconds.max += startSeconds;
      }
      if (index === last && endSeconds) {
        Object.assign(copy.end, destination);
        copy.polyline = [...copy.polyline!, destination];
        copy.distanceMeters += Math.round(endGap);
        copy.durationSeconds.max += endSeconds;
      }
      return copy;
    });
    return {
      ...route,
      segments,
      distanceMeters:
        route.distanceMeters +
        (startSeconds ? Math.round(startGap) : 0) +
        (endSeconds ? Math.round(endGap) : 0),
      durationSeconds: {
        min: route.durationSeconds.min,
        max: route.durationSeconds.max + startSeconds + endSeconds,
      },
    };
  });
}
