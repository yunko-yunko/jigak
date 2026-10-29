import type {
  BaseRoute,
  BaseSegment,
  RoadIncident,
  RoadTrafficLink,
  TrafficSpan,
} from '../../shared/domain/types.js';
import { metersBetween } from './names.js';
import type { RoadTrafficService } from './seoulTraffic.js';

type Point = {
  latitude: number;
  longitude: number;
};

/** How a path lies on the reported road links: congestion per stretch and the time cars need on it now. */
export interface PathTraffic {
  /** Congestion over path vertices [from, to]; stretches with no reported road are left out. */
  spans: TrafficSpan[];
  /** Matched stretches in travel order, for timing. */
  pieces: {
    meters: number;
    speedKmh: number;
  }[];
  matchedMeters: number;
  totalMeters: number;
}

const CELL = 0.0006;

/** A path point belongs to a link running the same way within this distance. */
const MATCH_METERS = 22;
const MATCH_DEGREES = 40;

/** Unreported gaps this short (junctions, link joins) take the congestion of the road before them. */
const BRIDGE_METERS = 70;

const bearingOf = (ax: number, ay: number, bx: number, by: number) =>
  (Math.atan2((bx - ax) * Math.cos((ay * Math.PI) / 180), by - ay) * 180) / Math.PI;

const turn = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

interface Piece {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  bearing: number;
  link: RoadTrafficLink;
}

/** Road links bucketed on a ~60 m grid, so each path point checks only the links beside it. */
export class LinkIndex {
  private readonly cells = new Map<string, Piece[]>();
  readonly size: number;

  constructor(links: RoadTrafficLink[]) {
    this.size = links.length;

    for (const link of links) {
      for (let index = 1; index < link.path.length; index += 1) {
        const [ax, ay] = link.path[index - 1],
          [bx, by] = link.path[index];

        const piece: Piece = {
          ax,
          ay,
          bx,
          by,
          bearing: bearingOf(ax, ay, bx, by),
          link,
        };

        const x0 = Math.floor(Math.min(ax, bx) / CELL),
          x1 = Math.floor(Math.max(ax, bx) / CELL),
          y0 = Math.floor(Math.min(ay, by) / CELL),
          y1 = Math.floor(Math.max(ay, by) / CELL);

        // A link piece longer than a few cells is rare; cap the fill so bad rows cannot flood the grid.
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
          continue;
        }

        for (let x = x0; x <= x1; x += 1) {
          for (let y = y0; y <= y1; y += 1) {
            const key = `${x}:${y}`,
              bucket = this.cells.get(key);

            if (bucket) {
              bucket.push(piece);
            } else {
              this.cells.set(key, [piece]);
            }
          }
        }
      }
    }
  }

  /** The link under a point heading `bearing`; the opposite carriageway never matches. */
  match(longitude: number, latitude: number, bearing: number): RoadTrafficLink | null {
    const cx = Math.floor(longitude / CELL),
      cy = Math.floor(latitude / CELL);
    const scaleX = 111_320 * Math.cos((latitude * Math.PI) / 180),
      scaleY = 110_540;
    let best: RoadTrafficLink | null = null,
      bestDistance = MATCH_METERS;

    for (let x = cx - 1; x <= cx + 1; x += 1) {
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        for (const piece of this.cells.get(`${x}:${y}`) ?? []) {
          if (turn(piece.bearing, bearing) > MATCH_DEGREES) {
            continue;
          }

          const ax = (piece.ax - longitude) * scaleX,
            ay = (piece.ay - latitude) * scaleY,
            bx = (piece.bx - longitude) * scaleX,
            by = (piece.by - latitude) * scaleY;
          const dx = bx - ax,
            dy = by - ay,
            length = dx * dx + dy * dy;
          const along = length > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
          const distance = Math.hypot(ax + dx * along, ay + dy * along);

          if (distance < bestDistance) {
            bestDistance = distance;
            best = piece.link;
          }
        }
      }
    }

    return best;
  }
}

/** Lays a route path over live road links, edge by edge. */
export function trafficAlongPath(path: Point[], index: LinkIndex): PathTraffic {
  const edges: ({
    level: RoadTrafficLink['level'];
    speedKmh: number;
  } | null)[] = [];
  const lengths: number[] = [];
  let totalMeters = 0;

  for (let position = 1; position < path.length; position += 1) {
    const a = path[position - 1],
      b = path[position];
    const meters = metersBetween(a, b);

    lengths.push(meters);
    totalMeters += meters;

    if (meters < 0.5) {
      edges.push(null);
      continue;
    }

    const bearing = bearingOf(a.longitude, a.latitude, b.longitude, b.latitude);
    let hit: RoadTrafficLink | null = null;

    // Long straight edges are probed at more than their midpoint.
    for (const share of meters > 90 ? [0.5, 0.25, 0.75] : [0.5]) {
      hit = index.match(
        a.longitude + (b.longitude - a.longitude) * share,
        a.latitude + (b.latitude - a.latitude) * share,
        bearing,
      );

      if (hit) {
        break;
      }
    }

    edges.push(
      hit
        ? {
            level: hit.level,
            speedKmh: hit.speedKmh,
          }
        : null,
    );
  }

  for (let position = 0; position < edges.length; position += 1) {
    if (edges[position] || position === 0 || !edges[position - 1]) {
      continue;
    }

    let end = position,
      gap = 0;

    while (end < edges.length && !edges[end]) {
      gap += lengths[end];
      end += 1;
    }

    if (end < edges.length && gap <= BRIDGE_METERS) {
      for (let fill = position; fill < end; fill += 1) {
        edges[fill] = edges[position - 1];
      }
    }

    position = end - 1;
  }

  const spans: TrafficSpan[] = [],
    pieces: PathTraffic['pieces'] = [];
  let matchedMeters = 0,
    previous = -2;

  edges.forEach((edge, position) => {
    if (!edge) {
      return;
    }

    matchedMeters += lengths[position];

    const contiguous = previous === position - 1;
    const span = spans[spans.length - 1],
      piece = pieces[pieces.length - 1];

    if (contiguous && span.level === edge.level) {
      span.to = position + 1;
    } else {
      spans.push({
        from: position,
        to: position + 1,
        level: edge.level,
      });
    }

    if (contiguous && piece.speedKmh === edge.speedKmh) {
      piece.meters += lengths[position];
    } else {
      pieces.push({
        meters: lengths[position],
        speedKmh: edge.speedKmh,
      });
    }

    previous = position;
  });

  return {
    spans,
    pieces,
    matchedMeters,
    totalMeters,
  };
}

/** Median bus lanes carry a bus past part of a jam; this share of the cars' extra time reaches the bus. */
const BUS_SHARE_OF_CAR_DELAY = 0.5;

/**
 * Extra riding time a bus leg needs on the roads as they are now. Where cars move slower than the
 * leg's own planned average (stops included), the bus cannot keep its plan either; faster roads
 * give nothing back. Zero when too little of the leg has reported roads to judge.
 */
export function busRoadDelaySeconds(
  leg: {
    distanceMeters: number;
    baseSeconds: number;
  },
  traffic: PathTraffic,
): number {
  if (
    leg.distanceMeters <= 0 ||
    leg.baseSeconds <= 0 ||
    traffic.matchedMeters < 300 ||
    traffic.matchedMeters < traffic.totalMeters * 0.25
  ) {
    return 0;
  }

  const plannedSpeed = leg.distanceMeters / leg.baseSeconds;
  let excess = 0;

  for (const piece of traffic.pieces) {
    excess += Math.max(
      0,
      piece.meters / (Math.max(piece.speedKmh, 3) / 3.6) - piece.meters / plannedSpeed,
    );
  }

  const delay = Math.min(
    Math.round((excess * BUS_SHARE_OF_CAR_DELAY) / 30) * 30,
    Math.round((leg.baseSeconds * 0.6) / 30) * 30,
  );

  return delay >= 60 ? delay : 0;
}

const isBusLeg = (segment: BaseSegment) =>
  segment.mode === 'bus' && (segment.polyline?.length ?? 0) >= 2;

/**
 * Reads the roads under every bus leg before the routes are ranked: congested stretches are
 * recorded on the leg and its riding time grows by the delay they cause, so a jammed bus route
 * loses its place to a subway, a walk or a different road.
 */
export async function applyRoadConditions(
  routes: BaseRoute[],
  traffic: RoadTrafficService,
): Promise<BaseRoute[]> {
  if (!traffic.configured) {
    return routes;
  }

  const legs = [...new Set(routes.flatMap((route) => route.segments.filter(isBusLeg)))];

  if (!legs.length) {
    return routes;
  }

  const { links } = await traffic.along(legs.map((leg) => leg.polyline!));

  if (!links.length) {
    return routes;
  }

  const index = new LinkIndex(links);
  const updated = new Map<BaseSegment, BaseSegment>();

  for (const leg of legs) {
    const read = trafficAlongPath(leg.polyline!, index);

    if (!read.spans.length) {
      continue;
    }

    const delay = busRoadDelaySeconds(
      {
        distanceMeters: leg.distanceMeters,
        baseSeconds: leg.durationSeconds.max,
      },
      read,
    );

    updated.set(leg, {
      ...leg,
      traffic: read.spans,
      ...(delay
        ? {
            roadDelaySeconds: delay,
            durationSeconds: {
              min: leg.durationSeconds.min + delay,
              max: leg.durationSeconds.max + delay,
            },
          }
        : {}),
    });
  }

  if (!updated.size) {
    return routes;
  }

  return routes.map((route) => {
    if (!route.segments.some((segment) => updated.has(segment))) {
      return route;
    }

    const segments = route.segments.map((segment) => updated.get(segment) ?? segment);

    return {
      ...route,
      segments,
      durationSeconds: segments.reduce(
        (sum, segment) => ({
          min: sum.min + segment.durationSeconds.min,
          max: sum.max + segment.durationSeconds.max,
        }),
        {
          min: 0,
          max: 0,
        },
      ),
    };
  });
}

export interface RouteLegQuery {
  id: string;
  mode: 'bus' | 'taxi' | 'car';
  path: [number, number][];
  distanceMeters: number;
  baseSeconds: number;
}

export interface RouteLegTraffic {
  id: string;
  spans: TrafficSpan[];
  delaySeconds: number;
}

export interface RouteTrafficResult {
  legs: RouteLegTraffic[];
  incidents: RoadIncident[];
  observedAt: number | null;
  receivedAt: number;
}

/** Incidents this close to the path are on the rider's road, not a street away. */
const INCIDENT_METERS = 60;

/** Road conditions along the remaining legs of a route being followed, for its line, ETA and warnings. */
export async function routeTraffic(
  legs: RouteLegQuery[],
  traffic: RoadTrafficService,
  now: number,
): Promise<RouteTrafficResult> {
  const paths = legs.map((leg) =>
    leg.path.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    })),
  );

  const { links, incidents, observedAt } = await traffic.along(paths);

  const index = new LinkIndex(links);

  const result = legs.map((leg, position) => {
    const read = trafficAlongPath(paths[position], index);

    return {
      id: leg.id,
      spans: read.spans,
      delaySeconds: leg.mode === 'bus' ? busRoadDelaySeconds(leg, read) : 0,
    };
  });

  const near = incidents.filter((incident) =>
    paths.some((path) =>
      path.some((point, position) => {
        if (
          Math.abs(point.latitude - incident.latitude) > 0.003 ||
          Math.abs(point.longitude - incident.longitude) > 0.004
        ) {
          return false;
        }

        if (metersBetween(point, incident) <= INCIDENT_METERS) {
          return true;
        }

        const next = path[position + 1];

        return (
          !!next &&
          metersBetween(
            {
              latitude: (point.latitude + next.latitude) / 2,
              longitude: (point.longitude + next.longitude) / 2,
            },
            incident,
          ) <= INCIDENT_METERS
        );
      }),
    ),
  );

  return {
    legs: result,
    incidents: near,
    observedAt,
    receivedAt: now,
  };
}
