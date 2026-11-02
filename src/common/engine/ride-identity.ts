import type { BaseSegment } from '../shared/domain/types.js';
import { estimateBaseTimeline, type RoutingObjective } from '../shared/domain/estimatedTiming.js';
import { evaluateBaseTimeline } from '../shared/domain/routing.js';
import { busRouteKey, metersBetween, stationBaseName, subwayLineId } from './realtime/names.js';

/**
 * Ride identity: one boarding of one service in one direction is one ride, however many
 * itinerary fragments (or alight-and-board pairs at the same station) it was assembled from.
 */
export type RideSegment = Pick<BaseSegment, 'mode' | 'start' | 'end'> &
  Partial<Pick<BaseSegment, 'lineName' | 'transit' | 'polyline'>>;

export const RIDE_MODES: readonly BaseSegment['mode'][] = [
  'bus',
  'subway',
  'taxi',
  'car',
  'bicycle',
  'scooter',
  'ebike',
];
const isRide = (segment: RideSegment) => RIDE_MODES.includes(segment.mode);

/** Boundary stations of a continued ride sit at one physical place; the stop names carry the identity. */
const SAME_STATION_METERS = 500;
/** Without stop lists only the shared fragment boundary can identify the station. */
const SAME_BOUNDARY_METERS = 50;

/**
 * Branch-only stations of the lines that fork. Stations not listed (the trunk, the junction itself) belong to every service.
 * `through` lines send trunk trains onto one branch, so trunk plus one branch is a single ride while two different
 * branches are a change of trains (5호선 at 강동). Shuttle branches run apart from the trunk (2호선 성수지선 and 신정지선):
 * a ride that includes a shuttle station is a different train from the main ring.
 */
const BRANCHES: Record<string, { through: boolean; groups: Record<string, readonly string[]> }> = {
  '1002': {
    through: false,
    groups: {
      seongsu: ['용답', '신답', '용두'],
      sinjeong: ['도림천', '양천구청', '신정네거리', '까치산'],
    },
  },
  '1005': {
    through: true,
    groups: {
      machon: ['둔촌동', '올림픽공원', '방이', '오금', '개롱', '거여', '마천'],
      hanam: [
        '길동',
        '굽은다리',
        '명일',
        '고덕',
        '상일동',
        '강일',
        '미사',
        '하남풍산',
        '하남시청',
        '하남검단산',
      ],
    },
  },
};

function lineNames(segment: RideSegment): string[] {
  const named = segment.transit?.lines.length
    ? segment.transit.lines
    : segment.lineName
      ? [segment.lineName]
      : [];
  return named
    .flatMap((name) => name.split(' / '))
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Stable service identifiers: the feed's line id for rail, the route key for buses. Empty when the data names no line. */
function lineKeys(segment: RideSegment): Set<string> {
  const keys = new Set<string>();
  for (const name of lineNames(segment)) {
    if (segment.mode === 'subway')
      keys.add(`subway:${subwayLineId(name) ?? name.replace(/\s+/g, '')}`);
    else if (segment.mode === 'bus') keys.add(`bus:${busRouteKey(name)}`);
  }
  return keys;
}

type Service = 'express' | 'local' | 'any';
/** The provider lists every service of the stretch it considered; only a single class pins the ridden train. */
function serviceClass(segment: RideSegment): Service {
  const types = segment.transit?.vehicleTypes ?? [];
  const express = types.some((type) => /급행|특급|직통|express/i.test(type));
  const local = types.some((type) => !/급행|특급|직통|express/i.test(type));
  return express && !local ? 'express' : local && !express ? 'local' : 'any';
}

/** Branches a ride covers, keyed by line; the segment's own end stations count when the stop list is short. */
function branchesOf(segment: RideSegment): Map<string, Set<string>> {
  const stops = new Set(
    [...(segment.transit?.stops ?? []), segment.start.name, segment.end.name].map((stop) =>
      stationBaseName(stop),
    ),
  );
  const found = new Map<string, Set<string>>();
  for (const key of lineKeys(segment)) {
    const line = BRANCHES[key.replace('subway:', '')];
    if (!line) continue;
    const names = Object.entries(line.groups)
      .filter(([, stations]) => stations.some((station) => stops.has(station)))
      .map(([name]) => name);
    if (names.length) found.set(key, new Set(names));
  }
  return found;
}

/** The same train serves both rides? Through lines tolerate a trunk ride beside one branch ride; shuttles do not. */
function sameBranchService(first: RideSegment, second: RideSegment): boolean {
  const left = branchesOf(first),
    right = branchesOf(second);
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key) ?? new Set<string>(),
      b = right.get(key) ?? new Set<string>();
    const union = new Set([...a, ...b]);
    if (
      BRANCHES[key.replace('subway:', '')].through
        ? union.size > 1
        : a.size !== b.size || [...a].some((name) => !b.has(name))
    )
      return false;
  }
  return true;
}

function sameBoundary(first: RideSegment, second: RideSegment): boolean {
  const left = first.transit?.stops.at(-1),
    right = second.transit?.stops[0];
  if (left && right)
    return (
      stationBaseName(left) === stationBaseName(right) &&
      metersBetween(first.end, second.start) <= SAME_STATION_METERS
    );
  return metersBetween(first.end, second.start) <= SAME_BOUNDARY_METERS;
}

/** True when the second fragment travels back along the stops the first one just covered. */
function reverses(first: RideSegment, second: RideSegment): boolean {
  const before = first.transit?.stops.at(-2),
    after = second.transit?.stops[1];
  if (before && after) return stationBaseName(before) === stationBaseName(after);
  const approach = first.polyline,
    departure = second.polyline;
  if (approach && departure && approach.length >= 2 && departure.length >= 2) {
    const scale = Math.cos((first.end.latitude * Math.PI) / 180);
    const a = approach.at(-2)!,
      b = approach.at(-1)!,
      c = departure[0],
      d = departure[1];
    const dot =
      (b.longitude - a.longitude) * scale * (d.longitude - c.longitude) * scale +
      (b.latitude - a.latitude) * (d.latitude - c.latitude);
    return dot < 0;
  }
  return false;
}

/**
 * Two consecutive vehicle segments are one ride when the same service continues through their shared station
 * in the same direction. Evidence must come from the segments (line ids, stop order, vehicle classes,
 * branches); with no named line they are never merged. Express/local changes and branch changes stay rides.
 */
export function continuesRide(first: RideSegment, second: RideSegment): boolean {
  if (first.mode !== second.mode || (first.mode !== 'subway' && first.mode !== 'bus')) return false;
  const left = lineKeys(first),
    right = lineKeys(second);
  if (!left.size || ![...left].some((key) => right.has(key))) return false;
  // A bus stop lists every route that calls there: 143/401 then 401/406 is the first-bus strategy, not one bus, unless the same routes carry on.
  if (
    first.mode === 'bus' &&
    (left.size !== right.size || [...left].some((key) => !right.has(key)))
  )
    return false;
  if (!sameBoundary(first, second) || reverses(first, second)) return false;
  if (first.mode === 'subway') {
    const a = serviceClass(first),
      b = serviceClass(second);
    if (a !== 'any' && b !== 'any' && a !== b) return false;
    if (!sameBranchService(first, second)) return false;
  }
  return true;
}

/** Vehicle segments of a route in boarding order, with continuations folded into one ride each. */
export function rideGroups<T extends RideSegment>(segments: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const segment of segments) {
    if (!isRide(segment)) continue;
    const group = groups.at(-1);
    if (group && continuesRide(group.at(-1)!, segment)) group.push(segment);
    else groups.push([segment]);
  }
  return groups;
}

/** Identity of the vehicles a route boards; walk/run variants of the same rides share it. With no vehicle a run is its
 * own route, so the pure walk (the walk tab and its "walking is faster" comparison) is never folded into it. */
export function rideKey(segments: readonly RideSegment[]): string {
  return (
    rideGroups(segments)
      .map((group) => {
        const first = group[0],
          last = group.at(-1)!;
        return `${first.mode}:${first.transit?.lines.join('/') ?? ''}:${first.start.name}>${last.end.name}`;
      })
      .join('|') || (segments.some((segment) => segment.mode === 'run') ? 'run' : 'walk')
  );
}

/**
 * Clock at which a route reaches each of its boardings, in boarding order: the start of the waits right before the first
 * segment of every ride (the platform or stop, past any gates), on the objective's clock (the point estimate, or the
 * latest clock for the conservative objective). Infinity where that clock has no value.
 */
function boardingReach(
  segments: readonly BaseSegment[],
  now: number,
  objective: RoutingObjective,
): number[] {
  let starts: readonly number[] | undefined;
  if (objective === 'estimated-arrival')
    starts = estimateBaseTimeline(segments, now)?.components.map(
      (component) => component.startedAt,
    );
  else {
    const timeline = evaluateBaseTimeline(segments, now);
    starts = timeline ? [now, ...timeline.slice(0, -1).map((range) => range.latest)] : undefined;
  }
  return rideGroups(segments).map((group) => {
    let first = segments.indexOf(group[0]);
    while (first > 0 && segments[first - 1].mode === 'wait') first--;
    return starts?.[first] ?? Infinity;
  });
}
const footMeters = (segments: readonly BaseSegment[]) =>
  segments.reduce(
    (sum, segment) =>
      sum + (segment.mode === 'walk' || segment.mode === 'run' ? segment.distanceMeters : 0),
    0,
  );

/**
 * Tie-break for routes whose arrival and effort already tie, above all variants of one ride: the one that reaches its
 * boardings sooner (compared boarding by boarding) goes first, then the one that walks less. A walk to a stop and back
 * to the same train therefore never beats the direct walk. A total order (lexicographic), so it is safe inside a sort.
 */
export function boardingAccessComparator(now: number, objective: RoutingObjective) {
  const cache = new Map<readonly BaseSegment[], { reach: number[]; foot: number }>();
  const measure = (segments: readonly BaseSegment[]) => {
    let value = cache.get(segments);
    if (!value) {
      value = { reach: boardingReach(segments, now, objective), foot: footMeters(segments) };
      cache.set(segments, value);
    }
    return value;
  };
  return (
    left: { segments: readonly BaseSegment[] },
    right: { segments: readonly BaseSegment[] },
  ): number => {
    const a = measure(left.segments),
      b = measure(right.segments);
    for (let index = 0; index < Math.min(a.reach.length, b.reach.length); index++) {
      if (a.reach[index] !== b.reach[index]) return a.reach[index] < b.reach[index] ? -1 : 1;
    }
    return a.reach.length - b.reach.length || a.foot - b.foot;
  };
}

/** The last ride-mode segment of a fragment, and the first, for boundary checks between fragments. */
export const lastRideSegment = <T extends RideSegment>(segments: readonly T[]): T | undefined =>
  segments.findLast(isRide);
export const firstRideSegment = <T extends RideSegment>(segments: readonly T[]): T | undefined =>
  segments.find(isRide);
