import { readFileSync } from 'node:fs';
import { SEOUL_TRAFFIC_AREAS } from '../realtime/seoulAreas.js';
import { ASSUMPTIONS } from './assumptions.js';
import { dataFile } from './calendar.js';
import type { Demand } from './demand.js';
import {
  bundledDoorPoints,
  DOOR_CATEGORY_NAMES,
  DOOR_FLAG,
  type DoorPointSet,
} from './door-points.js';
import { bundledFootWeights, footWeekdayAt, type FootWeights } from './foot-traffic.js';
import type { Stream } from './keyed-random.js';
import {
  bundledReturnRules,
  DOOR_ZONE,
  RETURN,
  SPOT_ZONE,
  type ReturnRules,
} from './return-rules.js';
import { CATEGORY, LAYER, VEHICLE_TYPE_NAMES, type VehicleTypeName } from './sim-codes.js';

/** Equirectangular metres around Seoul; good to well under a metre at these distances. */
export const METERS_PER_DEGREE = 111_195;
export const COS_LATITUDE = Math.cos((37.55 * Math.PI) / 180);
export const metersApart = (lat1: number, lon1: number, lat2: number, lon2: number) =>
  Math.hypot((lat2 - lat1) * METERS_PER_DEGREE, (lon2 - lon1) * METERS_PER_DEGREE * COS_LATITUDE);
/** Six decimals, the precision vehicle positions are kept at (about 0.1 m). */
const round6 = (degrees: number) => Math.round(degrees * 1e6) / 1e6;
/** A building entrance never opens a school or complex for a return (§20.3). */
const ENTRANCE = DOOR_CATEGORY_NAMES.indexOf('entrance');
/** Moves (lat, lon) by metres north and east. */
export const offsetLatitude = (meters: number) => meters / METERS_PER_DEGREE;
export const offsetLongitude = (meters: number) => meters / (METERS_PER_DEGREE * COS_LATITUDE);

/** The grids cover Seoul with a margin; points outside (out-of-area returns) have no cell. */
const BOUNDS = { south: 37.4, north: 37.72, west: 126.74, east: 127.22 } as const;

/**
 * 서초구 (§19 e-bike removal zones), [latitude, longitude] clockwise from the 동작대교 bank. The
 * repository carries no 자치구 boundary file, so this is a hand-traced outline (가정값, about
 * 300–500 m off at worst): 한강 to the north, 강남대로 and 양재천 to 강남구 on the east, 내곡동
 * and 청계산 to 성남·과천 in the south, 남태령 and 사당역 to 관악·동작 in the west.
 */
export const SEOCHO_OUTLINE: readonly (readonly [number, number])[] = [
  [37.5035, 126.98],
  [37.512, 126.995],
  [37.522, 127.005],
  [37.5285, 127.016],
  [37.5165, 127.0205],
  [37.504, 127.0245],
  [37.498, 127.0275],
  [37.4845, 127.0345],
  [37.48, 127.046],
  [37.476, 127.064],
  [37.47, 127.085],
  [37.456, 127.1],
  [37.44, 127.09],
  [37.428, 127.056],
  [37.44, 127.035],
  [37.456, 127.012],
  [37.462, 126.99],
  [37.476, 126.9815],
  [37.49, 126.981],
];
const SEOCHO_BOX = SEOCHO_OUTLINE.reduce(
  ([south, west, north, east], [lat, lon]) => [
    Math.min(south, lat),
    Math.min(west, lon),
    Math.max(north, lat),
    Math.max(east, lon),
  ],
  [Infinity, Infinity, -Infinity, -Infinity],
);

/** Is the point inside 서초구 (ray casting on `SEOCHO_OUTLINE`)? */
export function inSeocho(latitude: number, longitude: number): boolean {
  const [south, west, north, east] = SEOCHO_BOX;
  if (latitude < south || latitude > north || longitude < west || longitude > east) return false;
  let inside = false;
  for (
    let index = 0, previous = SEOCHO_OUTLINE.length - 1;
    index < SEOCHO_OUTLINE.length;
    previous = index++
  ) {
    const [latA, lonA] = SEOCHO_OUTLINE[index],
      [latB, lonB] = SEOCHO_OUTLINE[previous];
    if (
      latA > latitude !== latB > latitude &&
      longitude < ((lonB - lonA) * (latitude - latA)) / (latB - latA) + lonA
    )
      inside = !inside;
  }
  return inside;
}

export const PARKING_RULES_VERSION = 'seoul-pm-parking-rules-v1';

export interface GeometryMeta {
  version: string | null;
  builtAt: number | null;
  busStops: number;
  subwayExits: number;
  subwayKind: 'exits' | 'centroids';
  crosswalks: number;
  fallback: boolean;
}

/** The three official layers of seoul-pm-parking-rules-v1.json, lat/lon interleaved. */
export interface ParkingGeometry {
  meta: GeometryMeta;
  busStops: Float64Array;
  subwayExits: Float64Array;
  crosswalks: Float64Array;
}

const emptyLayers = (version: string | null = null, builtAt: number | null = null) => ({
  meta: {
    version,
    builtAt,
    busStops: 0,
    subwayExits: 0,
    subwayKind: 'exits' as const,
    crosswalks: 0,
    fallback: true,
  },
  busStops: new Float64Array(0),
  subwayExits: new Float64Array(0),
  crosswalks: new Float64Array(0),
});

/**
 * Reads the parking-rule file. It is optional: a missing or malformed file leaves every layer
 * empty and the categories it would decide fall back to probabilities (§6.3).
 */
export function parseParkingRules(raw: unknown): ParkingGeometry {
  const file = raw as {
    version?: unknown;
    builtAt?: unknown;
    meta?: { sources?: { layer?: unknown; notes?: unknown }[] };
    busStops?: unknown;
    subwayExits?: unknown;
    crosswalks?: unknown;
  };
  if (!file || typeof file !== 'object' || file.version !== PARKING_RULES_VERSION)
    return emptyLayers();
  const layer = (rows: unknown): Float64Array | null => {
    if (!Array.isArray(rows)) return null;
    const values = new Float64Array(rows.length * 2);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index] as unknown;
      if (
        !Array.isArray(row) ||
        !Number.isFinite(row[0]) ||
        !Number.isFinite(row[1]) ||
        row[0] < BOUNDS.south ||
        row[0] > BOUNDS.north ||
        row[1] < BOUNDS.west ||
        row[1] > BOUNDS.east
      )
        return null;
      values[index * 2] = row[0];
      values[index * 2 + 1] = row[1];
    }
    return values;
  };
  const busStops = layer(file.busStops),
    subwayExits = layer(file.subwayExits),
    crosswalks = layer(file.crosswalks);
  const builtAt = Number.isFinite(file.builtAt) ? (file.builtAt as number) : null;
  if (!busStops || !subwayExits || !crosswalks) return emptyLayers(PARKING_RULES_VERSION, builtAt);
  // The build script names T-DATA station centroids in the notes when exits were unavailable.
  const subwayNotes = (file.meta?.sources ?? []).find(
    (source) => source?.layer === 'subwayExits',
  )?.notes;
  const centroids = typeof subwayNotes === 'string' && subwayNotes.includes('station centroids');
  return {
    meta: {
      version: PARKING_RULES_VERSION,
      builtAt,
      busStops: busStops.length / 2,
      subwayExits: subwayExits.length / 2,
      subwayKind: centroids ? 'centroids' : 'exits',
      crosswalks: crosswalks.length / 2,
      fallback: !busStops.length || !subwayExits.length || !crosswalks.length,
    },
    busStops,
    subwayExits,
    crosswalks,
  };
}

let bundledGeometry: ParkingGeometry | null = null;

export function bundledParkingRules(): ParkingGeometry {
  if (!bundledGeometry) {
    try {
      bundledGeometry = parseParkingRules(
        JSON.parse(readFileSync(dataFile('seoul-pm-parking-rules-v1.json'), 'utf8')),
      );
    } catch {
      bundledGeometry = emptyLayers();
    }
  }
  return bundledGeometry;
}

/** A dense grid of point indices (CSR) over the Seoul bounds. */
export class PointGrid {
  readonly cellLatitude: number;
  readonly cellLongitude: number;
  readonly rows: number;
  readonly cols: number;
  readonly start: Int32Array;
  readonly items: Int32Array;

  constructor(
    readonly points: Float64Array,
    readonly cellMeters: number,
  ) {
    this.cellLatitude = offsetLatitude(cellMeters);
    this.cellLongitude = offsetLongitude(cellMeters);
    this.rows = Math.ceil((BOUNDS.north - BOUNDS.south) / this.cellLatitude);
    this.cols = Math.ceil((BOUNDS.east - BOUNDS.west) / this.cellLongitude);
    const count = points.length / 2;
    const cells = new Int32Array(count);
    this.start = new Int32Array(this.rows * this.cols + 1);
    for (let index = 0; index < count; index++) {
      const cell = this.cell(points[index * 2], points[index * 2 + 1]);
      cells[index] = cell;
      if (cell >= 0) this.start[cell + 1]++;
    }
    for (let cell = 0; cell < this.rows * this.cols; cell++)
      this.start[cell + 1] += this.start[cell];
    this.items = new Int32Array(this.start[this.rows * this.cols]);
    const cursor = this.start.slice(0, this.rows * this.cols);
    for (let index = 0; index < count; index++)
      if (cells[index] >= 0) this.items[cursor[cells[index]]++] = index;
  }

  row(latitude: number) {
    return Math.floor((latitude - BOUNDS.south) / this.cellLatitude);
  }

  col(longitude: number) {
    return Math.floor((longitude - BOUNDS.west) / this.cellLongitude);
  }

  /** Cell index, or -1 outside the bounds. */
  cell(latitude: number, longitude: number) {
    const row = this.row(latitude),
      col = this.col(longitude);
    return row < 0 || col < 0 || row >= this.rows || col >= this.cols ? -1 : row * this.cols + col;
  }

  /**
   * Nearest point within `maxMeters`, or -1; `distance` holds its metres. Rings grow outward and
   * stop once no unseen cell can hold anything closer.
   */
  distance = Infinity;
  nearest(latitude: number, longitude: number, maxMeters: number): number {
    const rings = Math.ceil(maxMeters / this.cellMeters);
    const row = this.row(latitude),
      col = this.col(longitude);
    let best = -1,
      bestMeters = maxMeters;
    const visit = (r: number, c: number) => {
      if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return;
      const cell = r * this.cols + c;
      for (let slot = this.start[cell]; slot < this.start[cell + 1]; slot++) {
        const index = this.items[slot];
        const meters = metersApart(
          latitude,
          longitude,
          this.points[index * 2],
          this.points[index * 2 + 1],
        );
        if (meters < bestMeters || (meters === bestMeters && best >= 0 && index < best)) {
          best = index;
          bestMeters = meters;
        }
      }
    };
    for (let ring = 0; ring <= rings; ring++) {
      // Everything on ring `ring` or beyond lies at least (ring - 1) cells away.
      if (best >= 0 && bestMeters <= (ring - 1) * this.cellMeters) break;
      if (ring === 0) {
        visit(row, col);
        continue;
      }
      for (let c = col - ring; c <= col + ring; c++) {
        visit(row - ring, c);
        visit(row + ring, c);
      }
      for (let r = row - ring + 1; r <= row + ring - 1; r++) {
        visit(r, col - ring);
        visit(r, col + ring);
      }
    }
    this.distance = best < 0 ? Infinity : bestMeters;
    return best;
  }
}

/** Results of one neighbourhood scan: the nearest feature and its distance per layer. */
export class NearScan {
  readonly index = new Int32Array(4);
  readonly meters = new Float64Array(4);
}

/** Where a decision put the vehicle, reused across calls to avoid allocations. */
export class Placement {
  latitude = 0;
  longitude = 0;
  category: number = CATEGORY.PROPER;
  geometry = false;
  dockFallback = false;
  designated = false;
  /** The spot breaks a discouraged rule (§20.3): allowed, with higher complaint odds. */
  discouraged = false;
  /** Nothing allowed was found, not even by the nearest docks: the spot is still no-return. */
  noReturn = false;
}

/** The rule table and door points ParkingRules reads besides the official layers (§20). */
export interface PlacementLayers {
  returns?: ReturnRules;
  doors?: DoorPointSet;
  /** §22 foot-traffic weights (null: the service area is the dock buffer alone). */
  foot?: FootWeights | null;
}

/**
 * Parking geometry and the §6 rules that use it: land snapping, the immediate-tow buffers, where
 * a compliant rider parks, which violation a non-compliant rider commits, and proper spots for
 * crews. Pure functions of the geometry, the docks and the given stream.
 */
export class ParkingRules {
  readonly meta: GeometryMeta;
  /** Docks, bus stops, subway exits and crosswalks in one 50 m grid; tags hold each layer. */
  private readonly grid: PointGrid;
  private readonly tags: Uint8Array;
  private readonly layerOffset = new Int32Array(5);
  private readonly docks: PointGrid;
  /** Docks near which a busy station probably lacks exit data (§6.3). */
  private readonly stationGuess: Uint8Array;
  private readonly boxes: Float64Array;
  private readonly scan = new NearScan();
  private readonly hasLayer: boolean[];
  readonly returns: ReturnRules;
  readonly doors: DoorPointSet;
  private readonly doorGrid: PointGrid;
  /** Door points within reach of each dock (CSR) and their cumulative weights (§20.1). */
  private readonly doorStart: Int32Array;
  private readonly doorItems: Int32Array;
  private readonly doorCumulative: Float64Array;
  /** Per vehicle type: the spots of a spot-only zone (용산구 R21), or null. */
  private readonly spotGrids: (PointGrid | null)[];
  /**
   * Per (door, type): the legal spot, computed once; state 0 unknown, else bit 1 known, 2
   * discouraged, 4 dock fallback, 8 no-return.
   */
  private readonly doorSpots: Float64Array;
  private readonly doorSpotState: Uint8Array;
  /** Per (door, type): does it open a school or complex (`gateOpen`); 0 unknown, 1 yes, 2 no. */
  private readonly gateState: Uint8Array;
  /** Scratch lists of point indices for the gate test, the walks and the dock fallback. */
  private readonly gateNear: number[] = [];
  private readonly walkNear: number[] = [];
  private readonly fallbackDocks: number[] = [];
  /** §22 foot-traffic weights: busy 250 m cells belong to the service area. */
  readonly foot: FootWeights | null;
  /** Scratch placement for the full-spot fallback of `walkTo` and `legalFallback`. */
  private readonly firstFull = new Placement();
  /** The rule (index into `returns.rules`) behind the last `returnEffect`, or -1. */
  returnRule = -1;

  constructor(
    readonly geometry: ParkingGeometry,
    readonly demand: Demand,
    tables: PlacementLayers = {},
  ) {
    this.meta = geometry.meta;
    const layers = [demand.docks, geometry.busStops, geometry.subwayExits, geometry.crosswalks];
    const total = layers.reduce((sum, layer) => sum + layer.length, 0);
    const points = new Float64Array(total);
    this.tags = new Uint8Array(total / 2);
    let offset = 0;
    layers.forEach((layer, tag) => {
      this.layerOffset[tag] = offset / 2;
      points.set(layer, offset);
      this.tags.fill(tag, offset / 2, (offset + layer.length) / 2);
      offset += layer.length;
    });
    this.layerOffset[4] = total / 2;
    this.hasLayer = layers.map((layer) => layer.length > 0);
    this.grid = new PointGrid(points, ASSUMPTIONS.parking.landCellMeters);
    this.docks = new PointGrid(demand.docks, 250);
    this.stationGuess = new Uint8Array(demand.count);
    const guessMeters = ASSUMPTIONS.parking.weights.stationGuessDockMeters;
    for (let dock = 0; dock < demand.count; dock++) {
      if (!demand.top[dock] || !this.hasLayer[LAYER.EXIT]) continue;
      this.nearScan(demand.docks[dock * 2], demand.docks[dock * 2 + 1], guessMeters);
      if (this.scan.index[LAYER.EXIT] < 0) this.stationGuess[dock] = 1;
    }
    const codes = new Set<string>(ASSUMPTIONS.parkBoxes);
    const boxes = SEOUL_TRAFFIC_AREAS.filter(([code]) => codes.has(code));
    this.boxes = new Float64Array(boxes.length * 4);
    boxes.forEach(([, , west, south, east, north], index) =>
      this.boxes.set([south, west, north, east], index * 4),
    );

    this.returns = tables.returns ?? bundledReturnRules();
    this.doors = tables.doors ?? bundledDoorPoints();
    this.foot = tables.foot === undefined ? bundledFootWeights() : tables.foot;
    this.doorGrid = new PointGrid(this.doors.points, 50);
    const { dockMeters, weightPower, weightCap, decayMeters } = ASSUMPTIONS.doors;
    // §21 a door belongs to its nearest dock inside the service area: riders who return there
    // live or work by that dock. A dock with no door of its own draws from the doors in reach,
    // their pull fading with distance.
    const ownDoorsOf: number[][] = Array.from({ length: demand.count }, () => []);
    for (let door = 0; door < this.doors.meta.points; door++) {
      const dock = this.docks.nearest(
        this.doors.points[door * 2],
        this.doors.points[door * 2 + 1],
        ASSUMPTIONS.serviceArea.dockBufferMeters,
      );
      if (dock >= 0) ownDoorsOf[dock].push(door);
    }
    const counts = new Int32Array(demand.count + 1);
    const items: number[] = [],
      weights: number[] = [];
    const near: number[] = [];
    for (let dock = 0; dock < demand.count; dock++) {
      const own = ownDoorsOf[dock].length > 0;
      if (own) {
        near.length = 0;
        near.push(...ownDoorsOf[dock]);
      } else
        this.pointsNear(
          this.doorGrid,
          demand.docks[dock * 2],
          demand.docks[dock * 2 + 1],
          dockMeters,
          near,
        );
      let running = 0;
      for (const door of near) {
        const meters = metersApart(
          demand.docks[dock * 2],
          demand.docks[dock * 2 + 1],
          this.doors.points[door * 2],
          this.doors.points[door * 2 + 1],
        );
        running +=
          Math.pow(Math.min(this.doors.weight[door], weightCap), weightPower) *
          (own ? 1 : Math.exp(-meters / decayMeters));
        items.push(door);
        weights.push(running);
      }
      counts[dock + 1] = counts[dock] + near.length;
    }
    this.doorStart = counts;
    this.doorItems = Int32Array.from(items);
    this.doorCumulative = Float64Array.from(weights);
    this.spotGrids = VEHICLE_TYPE_NAMES.map((_, type) => {
      const layer = this.returns.spotLayerOf(type);
      return layer ? new PointGrid(this.returns.pointsOf(layer), 250) : null;
    });
    this.doorSpots = new Float64Array(this.doors.meta.points * VEHICLE_TYPE_NAMES.length * 2);
    this.doorSpotState = new Uint8Array(this.doors.meta.points * VEHICLE_TYPE_NAMES.length);
    this.gateState = new Uint8Array(this.doors.meta.points * VEHICLE_TYPE_NAMES.length);
  }

  /** Points of `grid` within `meters`, in grid order, written into `out`. */
  private pointsNear(
    grid: PointGrid,
    latitude: number,
    longitude: number,
    meters: number,
    out: number[],
  ): number[] {
    out.length = 0;
    const rings = Math.ceil(meters / grid.cellMeters);
    const row = grid.row(latitude),
      col = grid.col(longitude);
    for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
      for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
        const cell = r * grid.cols + c;
        for (let slot = grid.start[cell]; slot < grid.start[cell + 1]; slot++) {
          const item = grid.items[slot];
          if (
            metersApart(latitude, longitude, grid.points[item * 2], grid.points[item * 2 + 1]) <=
            meters
          )
            out.push(item);
        }
      }
    return out;
  }

  /** Docks with at least one door point in reach; the rest fall back to dock jitter (§20.1). */
  get docksWithDoors() {
    let count = 0;
    for (let dock = 0; dock < this.demand.count; dock++)
      if (this.doorStart[dock + 1] > this.doorStart[dock]) count++;
    return count;
  }

  /** A door point near `dock`, drawn by weight; -1 when none is in reach (§20.1). */
  doorNear(dock: number, stream: Stream): number {
    const from = this.doorStart[dock],
      to = this.doorStart[dock + 1];
    return to > from ? this.doorItems[stream.weightedSegment(this.doorCumulative, from, to)] : -1;
  }

  /**
   * `doorNear` with a cap (§21, 가정값 `doors.cap`): a door already holding `cap` rentable vehicles
   * (`load`, Engine.doorLoad) is drawn again, up to `capRedraws` times, keeping the least loaded.
   * §22: a door `crowded` calls full (its 15 m holding `doors.pileCap`) counts as holding `cap`;
   * still full after the redraws, the next door of the dock's list with room.
   */
  doorNearCapped(
    dock: number,
    stream: Stream,
    load: Int32Array,
    crowded?: (door: number) => boolean,
  ): number {
    const cap = ASSUMPTIONS.doors.cap,
      capRedraws = ASSUMPTIONS.doors.capRedraws;
    const loadOf = (door: number) =>
      load[door] < cap && crowded && crowded(door) ? cap : load[door];
    let door = this.doorNear(dock, stream);
    let doorLoad = door >= 0 ? loadOf(door) : 0;
    for (let redraw = 0; door >= 0 && doorLoad >= cap && redraw < capRedraws; redraw++) {
      const other = this.doorNear(dock, stream);
      const otherLoad = loadOf(other);
      if (otherLoad < doorLoad) {
        door = other;
        doorLoad = otherLoad;
      }
    }
    if (door >= 0 && doorLoad >= cap) {
      const from = this.doorStart[dock],
        to = this.doorStart[dock + 1];
      let slot = from;
      while (this.doorItems[slot] !== door) slot++;
      for (let step = 1; step < to - from; step++) {
        const next = this.doorItems[from + ((slot - from + step) % (to - from))];
        if (loadOf(next) < cap) return next;
      }
    }
    return door;
  }

  doorLatitude(door: number) {
    return this.doors.points[door * 2];
  }

  doorLongitude(door: number) {
    return this.doors.points[door * 2 + 1];
  }

  /** Is a designated spot of a spot-only zone (R21) within `meters`? */
  nearSpot(latitude: number, longitude: number, meters: number): boolean {
    return this.spotGrids.some((grid) => !!grid && grid.nearest(latitude, longitude, meters) >= 0);
  }

  /**
   * §22.9 the nearest designated spot (a 용산 zone point) within `meters`, written into `out` as
   * [latitude, longitude]; false when there is none.
   */
  spotPointNear(latitude: number, longitude: number, meters: number, out: number[]): boolean {
    for (const grid of this.spotGrids) {
      if (!grid) continue;
      const index = grid.nearest(latitude, longitude, meters);
      if (index < 0) continue;
      out[0] = grid.points[index * 2];
      out[1] = grid.points[index * 2 + 1];
      return true;
    }
    return false;
  }

  /** Is a door point within `meters` of the spot? */
  nearDoor(latitude: number, longitude: number, meters: number): boolean {
    return this.doorGrid.nearest(latitude, longitude, meters) >= 0;
  }

  /**
   * §20.3 does door `door` let VTYPE `type` park just inside a school or complex (R22, R24): a
   * gate, exit, station side or edge point with the zone's outside within `doorGraceMeters`.
   * Building entrances and gates marked access=no never do. Cached per (door, type).
   */
  gateOpen(type: number, door: number): boolean {
    const slot = door * VEHICLE_TYPE_NAMES.length + type;
    if (!this.gateState[slot]) {
      let open = false;
      if (
        this.doors.category[door] !== ENTRANCE &&
        !(this.doors.flags[door] & DOOR_FLAG.RESTRICTED)
      ) {
        const latitude = this.doorLatitude(door),
          longitude = this.doorLongitude(door);
        const grace = ASSUMPTIONS.returns.doorGraceMeters;
        open = !this.returns.inDoorZone(type, latitude, longitude);
        // Two rings of eight probes: an edge point sees the outside within the grace distance.
        for (let probe = 0; probe < 16 && !open; probe++) {
          const meters = probe < 8 ? grace / 2 : grace,
            angle = ((probe % 8) * Math.PI) / 4;
          open = !this.returns.inDoorZone(
            type,
            latitude + offsetLatitude(meters * Math.sin(angle)),
            longitude + offsetLongitude(meters * Math.cos(angle)),
          );
        }
      }
      this.gateState[slot] = open ? 1 : 2;
    }
    return this.gateState[slot] === 1;
  }

  /** Is a door that opens a school or complex for VTYPE `type` (`gateOpen`) within `meters`? */
  nearGate(type: number, latitude: number, longitude: number, meters: number): boolean {
    const near = this.pointsNear(this.doorGrid, latitude, longitude, meters, this.gateNear);
    for (const door of near) if (this.gateOpen(type, door)) return true;
    return false;
  }

  /**
   * §20.3 what the rule table says about a spot for VTYPE `type`: RETURN.CLEAN, DISCOURAGED or
   * NO_RETURN. The official layers (bus stops, subway exits, crosswalks) use the table's radii;
   * inside a school or complex only a spot by a door is allowed. `returnRule` names the rule.
   */
  returnEffect(type: number, latitude: number, longitude: number): number {
    const returns = this.returns;
    let effect: number = RETURN.CLEAN,
      rule = -1;
    if (returns.officialReach > 0) {
      const scan = this.nearScan(latitude, longitude, returns.officialReach);
      for (let official = 0; official < 3; official++) {
        const layer = official + 1;
        if (scan.index[layer] < 0) continue;
        if (layer === LAYER.EXIT && this.meta.subwayKind === 'centroids') continue;
        const slot = type * 3 + official;
        if (scan.meters[layer] <= returns.officialNo[slot]) {
          this.returnRule = returns.officialNoRule[slot];
          return RETURN.NO_RETURN;
        }
        if (scan.meters[layer] <= returns.officialDisc[slot]) {
          effect = RETURN.DISCOURAGED;
          rule = returns.officialDiscRule[slot];
        }
      }
    }
    let drawn = returns.effectAt(type, latitude, longitude);
    if (drawn & SPOT_ZONE) {
      // A spot-only zone (용산구 R21) binds within a walk of one of its five official zones (§22);
      // beyond that walk, most of the district, the zone merely discourages.
      const spots = this.spotGrids[type];
      if (spots && spots.nearest(latitude, longitude, ASSUMPTIONS.returns.spotSearchMeters) >= 0) {
        this.returnRule = returns.lastRule;
        return RETURN.NO_RETURN;
      }
      drawn = (drawn & ~SPOT_ZONE) | RETURN.DISCOURAGED;
    }
    if (
      drawn === RETURN.NO_RETURN ||
      (drawn & DOOR_ZONE &&
        !this.nearGate(type, latitude, longitude, ASSUMPTIONS.returns.doorGraceMeters))
    ) {
      this.returnRule = returns.lastRule;
      return RETURN.NO_RETURN;
    }
    if (drawn & RETURN.DISCOURAGED && rule < 0) rule = returns.lastRule;
    this.returnRule = rule;
    return effect | (drawn & RETURN.DISCOURAGED);
  }

  /** Rings around a point for the closest allowed spot; false when none is in reach. */
  private searchSpot(type: number, latitude: number, longitude: number, out: Placement): boolean {
    const { ringMeters, rings, bearings, discouragedPenaltyMeters } = ASSUMPTIONS.returns;
    // Spots are judged where they will be stored: positions keep six decimals (Engine.moveTo),
    // and a spot found right at a buffer's edge must not slip back over it.
    const startLat = round6(latitude),
      startLon = round6(longitude);
    const first = this.returnEffect(type, startLat, startLon);
    out.latitude = startLat;
    out.longitude = startLon;
    out.discouraged = first === RETURN.DISCOURAGED;
    if (first === RETURN.CLEAN) return true;
    let best = first === RETURN.DISCOURAGED ? discouragedPenaltyMeters : Infinity;
    // A bearing fixed by the point, so the search is a pure function of it.
    const bearing = ((Math.abs(Math.round(latitude * 1e6)) % 360) * Math.PI) / 180;
    for (let ring = 1; ring <= rings; ring++) {
      const meters = ring * ringMeters;
      if (meters >= best) break;
      for (let turn = 0; turn < bearings; turn++) {
        const angle = bearing + ((turn + (ring % 2) * 0.5) * 2 * Math.PI) / bearings;
        const lat = round6(latitude + offsetLatitude(meters * Math.sin(angle))),
          lon = round6(longitude + offsetLongitude(meters * Math.cos(angle)));
        const effect = this.returnEffect(type, lat, lon);
        if (effect === RETURN.NO_RETURN) continue;
        const score = meters + (effect === RETURN.DISCOURAGED ? discouragedPenaltyMeters : 0);
        if (score >= best) continue;
        best = score;
        out.latitude = lat;
        out.longitude = lon;
        out.discouraged = effect === RETURN.DISCOURAGED;
        // Nothing later on this ring can beat a clean spot on it.
        if (effect === RETURN.CLEAN) break;
      }
    }
    return best < Infinity;
  }

  /**
   * §20.3 where a compliant rider of VTYPE `type` leaves the vehicle near a point: the point when
   * no rule forbids or discourages it, else the closest allowed spot (a discouraged one counts
   * `discouragedPenaltyMeters` more). In a spot-only zone (용산구 R21) the search moves to the
   * nearest designated spots, and deep inside a school or complex to its nearest open gates; with
   * nothing allowed in reach, the dock fallback (`legalFallback`). A pure function of the point
   * unless `full` is given (§22): then a designated spot, gate or dock spot for which it answers
   * true is passed over for the next one, and kept only when all of them are full. Writes into
   * `out`.
   */
  legalSpot(
    type: number,
    latitude: number,
    longitude: number,
    out: Placement,
    full?: (latitude: number, longitude: number) => boolean,
  ): Placement {
    out.category = CATEGORY.PROPER;
    out.geometry = false;
    out.dockFallback = false;
    out.designated = false;
    out.noReturn = false;
    if (this.searchSpot(type, latitude, longitude, out)) return out;
    const spots = this.spotGrids[type];
    const { spotRideMeters, spotSearchMeters } = ASSUMPTIONS.returns;
    if (spots && this.walkTo(type, spots, latitude, longitude, spotRideMeters, false, out, full))
      return out;
    if (
      this.returns.inDoorZone(type, latitude, longitude) &&
      this.walkTo(type, this.doorGrid, latitude, longitude, spotSearchMeters, true, out, full)
    )
      return out;
    out.discouraged = false;
    return this.legalFallback(type, latitude, longitude, out, full);
  }

  /** Copies a placement (the first full spot kept by `walkTo` and `legalFallback`). */
  private static copy(from: Placement, to: Placement) {
    to.latitude = from.latitude;
    to.longitude = from.longitude;
    to.category = from.category;
    to.geometry = from.geometry;
    to.dockFallback = from.dockFallback;
    to.designated = from.designated;
    to.discouraged = from.discouraged;
    to.noReturn = from.noReturn;
  }

  /**
   * Moves from a point to the points of `grid` within `reach`, nearest first (ties by index), and
   * searches by up to `walkTries` of them; with `gates`, only doors that open a school or complex
   * for `type`. False when none of them has an allowed spot. With `full`, an allowed spot it calls
   * full is passed over; the first of them is kept when every allowed one is full (§22).
   */
  private walkTo(
    type: number,
    grid: PointGrid,
    latitude: number,
    longitude: number,
    reach: number,
    gates: boolean,
    out: Placement,
    full?: (latitude: number, longitude: number) => boolean,
  ): boolean {
    const walkTries = ASSUMPTIONS.returns.walkTries;
    const near = this.pointsNear(grid, latitude, longitude, reach, this.walkNear);
    if (gates) {
      let kept = 0;
      for (const door of near) if (this.gateOpen(type, door)) near[kept++] = door;
      near.length = kept;
    }
    let lastMeters = -1,
      lastItem = -1,
      kept = false;
    for (let attempt = 0; attempt < walkTries; attempt++) {
      let best = -1,
        bestMeters = Infinity;
      for (const item of near) {
        const meters = metersApart(
          latitude,
          longitude,
          grid.points[item * 2],
          grid.points[item * 2 + 1],
        );
        // Only points after the last one tried, in (metres, index) order.
        if (meters < lastMeters || (meters === lastMeters && item <= lastItem)) continue;
        if (meters < bestMeters || (meters === bestMeters && item < best)) {
          best = item;
          bestMeters = meters;
        }
      }
      if (best < 0) break;
      lastMeters = bestMeters;
      lastItem = best;
      if (this.searchSpot(type, grid.points[best * 2], grid.points[best * 2 + 1], out)) {
        if (!full || !full(out.latitude, out.longitude)) return true;
        if (!kept) ParkingRules.copy(out, this.firstFull);
        kept = true;
      }
    }
    if (kept) ParkingRules.copy(this.firstFull, out);
    return kept;
  }

  /**
   * §20.3 the dock fallback for VTYPE `type`: the closest allowed spot by the dock + 10 m point of
   * the nearest docks, up to `walkTries` of them within `spotSearchMeters` beyond the nearest. With
   * none, the nearest dock's point, marked `noReturn` (`legalReturnSpot` then answers null).
   */
  private legalFallback(
    type: number,
    latitude: number,
    longitude: number,
    out: Placement,
    full?: (latitude: number, longitude: number) => boolean,
  ) {
    const { spotSearchMeters, walkTries } = ASSUMPTIONS.returns;
    out.dockFallback = true;
    out.category = CATEGORY.PROPER;
    const first = this.docks.nearest(latitude, longitude, 20_000);
    let kept = false;
    if (first >= 0) {
      const near = this.docksNear(
        latitude,
        longitude,
        this.docks.distance + spotSearchMeters,
        this.fallbackDocks,
      );
      let lastMeters = -1,
        lastDock = -1;
      for (let attempt = 0; attempt < walkTries; attempt++) {
        let best = -1,
          bestMeters = Infinity;
        for (const dock of near) {
          const meters = metersApart(
            latitude,
            longitude,
            this.demand.docks[dock * 2],
            this.demand.docks[dock * 2 + 1],
          );
          if (meters < lastMeters || (meters === lastMeters && dock <= lastDock)) continue;
          if (meters < bestMeters || (meters === bestMeters && dock < best)) {
            best = dock;
            bestMeters = meters;
          }
        }
        if (best < 0) break;
        lastMeters = bestMeters;
        lastDock = best;
        this.besideDock(best, latitude, longitude, out);
        if (this.searchSpot(type, out.latitude, out.longitude, out)) {
          if (!full || !full(out.latitude, out.longitude)) return out;
          if (!kept) ParkingRules.copy(out, this.firstFull);
          kept = true;
        }
      }
      // §22 every allowed dock spot was full: the first of them, as before `full` existed.
      if (kept) {
        ParkingRules.copy(this.firstFull, out);
        return out;
      }
      this.besideDock(first, latitude, longitude, out);
    } else {
      out.latitude = latitude;
      out.longitude = longitude;
    }
    out.discouraged = false;
    out.noReturn = this.returnEffect(type, out.latitude, out.longitude) === RETURN.NO_RETURN;
    return out;
  }

  /** The rule that forbids a spot for VTYPE `type`, or -1 (diagnostics and the spot zone). */
  returnRuleAt(type: number, latitude: number, longitude: number): number {
    return this.returnEffect(type, latitude, longitude) === RETURN.CLEAN ? -1 : this.returnRule;
  }

  /**
   * §21 a door's spot in `out` moved `meters` aside toward `angle` (가정값 `doors.spreadMeters`):
   * vehicles left at one door stand side by side instead of on one point. A moved spot must be
   * clean for VTYPE `type` (or discouraged when the door's spot already was) and in the service
   * area. §22 (startup-spec §6.2): with `crowd` (vehicles crowding a point; 0 = free), a crowded
   * spot is passed over, then rings `returns.ringMeters` apart up to 15 m with 8 bearings,
   * and with nothing free the least crowded legal spot found; the door's own spot only when no
   * moved one is legal.
   */
  spreadSpot(
    type: number,
    meters: number,
    angle: number,
    load: number,
    out: Placement,
    crowd?: (latitude: number, longitude: number) => number,
  ): Placement {
    // Never to a worse spot than the door's own; a no-return spot (nothing allowed in reach)
    // still spreads, over spots no better than itself.
    const noReturn = out.noReturn,
      allowDiscouraged = out.discouraged || noReturn;
    const fromLat = out.latitude,
      fromLon = out.longitude;
    let bestLat = fromLat,
      bestLon = fromLon,
      bestCrowd = Infinity,
      bestDiscouraged = out.discouraged;
    // True when the candidate is free and taken; a legal crowded one may become the best.
    const take = (latitude: number, longitude: number) => {
      const effect = this.returnEffect(type, latitude, longitude);
      if (
        !(
          effect === RETURN.CLEAN ||
          (allowDiscouraged && effect === RETURN.DISCOURAGED) ||
          (noReturn && effect === RETURN.NO_RETURN)
        ) ||
        !this.inServiceArea(latitude, longitude)
      )
        return false;
      const crowded = crowd ? crowd(latitude, longitude) : 0;
      if (crowded < bestCrowd) {
        bestLat = latitude;
        bestLon = longitude;
        bestCrowd = crowded;
        bestDiscouraged = effect === RETURN.DISCOURAGED;
      }
      return crowded < 1;
    };
    // A busy spot spreads its vehicles over an area that grows with their number; where the
    // rules allow only a narrow strip (a gate, a dock's edge), closer in.
    let reach = meters * Math.sqrt(1 + load / ASSUMPTIONS.doors.cap);
    let free = false;
    for (let turn = 0; turn < 4 && !free; turn++, reach = Math.max(meters, reach / 2)) {
      const bearing = angle + turn * 2.1;
      free = take(
        round6(fromLat + offsetLatitude(reach * Math.sin(bearing))),
        round6(fromLon + offsetLongitude(reach * Math.cos(bearing))),
      );
    }
    // Out to the widest spread (15 m), not 6 m: a 용산 zone (§22) is 15 m around its geocoded
    // point and holds few clean points within 6 m of it.
    const step = ASSUMPTIONS.returns.ringMeters,
      last = ASSUMPTIONS.doors.spreadMeters[1];
    for (let ring = step; ring <= last + 1e-9 && !free; ring += step)
      for (let bearing = 0; bearing < 8 && !free; bearing++) {
        const turn = angle + (bearing * Math.PI) / 4;
        free = take(
          round6(fromLat + offsetLatitude(ring * Math.sin(turn))),
          round6(fromLon + offsetLongitude(ring * Math.cos(turn))),
        );
      }
    // §22.9 nothing free within 15 m: on along the kerb, coarser rings out to `spreadFarMeters`.
    if (crowd && !free) {
      const { farRingMeters, spreadFarMeters } = ASSUMPTIONS.doors;
      for (
        let ring = last + farRingMeters;
        ring <= spreadFarMeters + 1e-9 && !free;
        ring += farRingMeters
      )
        for (let bearing = 0; bearing < 8 && !free; bearing++) {
          const turn = angle + (bearing * Math.PI) / 4;
          free = take(
            round6(fromLat + offsetLatitude(ring * Math.sin(turn))),
            round6(fromLon + offsetLongitude(ring * Math.cos(turn))),
          );
        }
    }
    if (bestCrowd < Infinity) {
      out.latitude = bestLat;
      out.longitude = bestLon;
      out.discouraged = bestDiscouraged;
    }
    return out;
  }

  /**
   * §22.9 a vehicle left off the rules (a violation) where `crowd` says the spot is crowded moves
   * on along the street, rings `doors.farRingMeters` apart out to `doors.spreadFarMeters` from
   * `angle`, to the first point in the service area that is not crowded. Unchanged when none is
   * free. True when it ends on a free point. §22.10 a category tied to a place (`geometry`: a bus
   * stop, exit or crosswalk) follows the new point: the buffer it is inside there, else the
   * pavement (`sidewalk-obstruction`). A drawn behaviour (pavement, roadway, tactile, private,
   * restricted) moves with the rider and stays.
   */
  clearOfPile(
    angle: number,
    out: Placement,
    crowd: (latitude: number, longitude: number) => number,
  ): boolean {
    if (crowd(out.latitude, out.longitude) < 1) return true;
    const { farRingMeters, spreadFarMeters } = ASSUMPTIONS.doors;
    const fromLat = out.latitude,
      fromLon = out.longitude;
    for (let ring = farRingMeters; ring <= spreadFarMeters + 1e-9; ring += farRingMeters)
      for (let bearing = 0; bearing < 8; bearing++) {
        const turn = angle + (bearing * Math.PI) / 4;
        const latitude = round6(fromLat + offsetLatitude(ring * Math.sin(turn))),
          longitude = round6(fromLon + offsetLongitude(ring * Math.cos(turn)));
        if (
          !this.inServiceArea(latitude, longitude) ||
          !this.onLand(latitude, longitude) ||
          crowd(latitude, longitude) >= 1
        )
          continue;
        out.latitude = latitude;
        out.longitude = longitude;
        if (out.geometry) {
          const layer = this.immediateHit(latitude, longitude);
          out.category = layer > 0 ? PLACED_CATEGORY[layer] : CATEGORY.SIDEWALK;
          out.geometry = layer > 0;
        }
        return true;
      }
    return false;
  }

  /** `legalSpot` at a door point, cached per (door, type): riders and crews reuse doors. */
  doorSpot(type: number, door: number, out: Placement): Placement {
    const slot = door * VEHICLE_TYPE_NAMES.length + type;
    const state = this.doorSpotState[slot];
    if (!state) {
      this.legalSpot(type, this.doorLatitude(door), this.doorLongitude(door), out);
      this.doorSpots[slot * 2] = out.latitude;
      this.doorSpots[slot * 2 + 1] = out.longitude;
      this.doorSpotState[slot] =
        1 | (out.discouraged ? 2 : 0) | (out.dockFallback ? 4 : 0) | (out.noReturn ? 8 : 0);
      return out;
    }
    out.category = CATEGORY.PROPER;
    out.geometry = false;
    out.designated = false;
    out.latitude = this.doorSpots[slot * 2];
    out.longitude = this.doorSpots[slot * 2 + 1];
    out.discouraged = (state & 2) > 0;
    out.dockFallback = (state & 4) > 0;
    out.noReturn = (state & 8) > 0;
    return out;
  }

  /**
   * The return point for a rented `type` near a place, shared by routing and the simulator
   * (§20.3, §15.5): `legalSpot` for that type, or null outside the service area (R01) and when
   * not even the dock fallback found an allowed spot.
   */
  legalReturnSpot(
    type: VehicleTypeName,
    latitude: number,
    longitude: number,
    out = new Placement(),
  ): Placement | null {
    this.legalSpot(VEHICLE_TYPE_NAMES.indexOf(type), latitude, longitude, out);
    return !out.noReturn && this.inServiceArea(out.latitude, out.longitude) ? out : null;
  }

  get parkBoxCount() {
    return this.boxes.length / 4;
  }

  /** Coordinates of a feature of a layer. */
  featureLatitude(layer: number, index: number) {
    return this.grid.points[(this.layerOffset[layer] + index) * 2];
  }

  featureLongitude(layer: number, index: number) {
    return this.grid.points[(this.layerOffset[layer] + index) * 2 + 1];
  }

  /** Fills the nearest feature per layer within `meters` (index -1 when none). */
  nearScan(latitude: number, longitude: number, meters: number): NearScan {
    const scan = this.scan,
      grid = this.grid;
    scan.index.fill(-1);
    scan.meters.fill(Infinity);
    const rings = Math.ceil(meters / grid.cellMeters);
    const row = grid.row(latitude),
      col = grid.col(longitude);
    for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
      for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
        const cell = r * grid.cols + c;
        for (let slot = grid.start[cell]; slot < grid.start[cell + 1]; slot++) {
          const item = grid.items[slot];
          const distance = metersApart(
            latitude,
            longitude,
            grid.points[item * 2],
            grid.points[item * 2 + 1],
          );
          if (distance > meters) continue;
          const tag = this.tags[item];
          if (distance < scan.meters[tag]) {
            scan.meters[tag] = distance;
            scan.index[tag] = item - this.layerOffset[tag];
          }
        }
      }
    return scan;
  }

  /** Is the point on the land proxy: a 50 m cell holding any dock, stop, exit or crosswalk. */
  onLand(latitude: number, longitude: number): boolean {
    const cell = this.grid.cell(latitude, longitude);
    return cell >= 0 && this.grid.start[cell + 1] > this.grid.start[cell];
  }

  nearestDock(latitude: number, longitude: number, maxMeters: number): number {
    return this.docks.nearest(latitude, longitude, maxMeters);
  }

  get lastDockMeters() {
    return this.docks.distance;
  }

  /** Docks within `meters` of the point, in grid order, written into `out`. */
  docksNear(latitude: number, longitude: number, meters: number, out: number[]): number[] {
    out.length = 0;
    const grid = this.docks;
    const rings = Math.ceil(meters / grid.cellMeters);
    const row = grid.row(latitude),
      col = grid.col(longitude);
    for (let r = Math.max(0, row - rings); r <= Math.min(grid.rows - 1, row + rings); r++)
      for (let c = Math.max(0, col - rings); c <= Math.min(grid.cols - 1, col + rings); c++) {
        const cell = r * grid.cols + c;
        for (let slot = grid.start[cell]; slot < grid.start[cell + 1]; slot++) {
          const dock = grid.items[slot];
          if (
            metersApart(
              latitude,
              longitude,
              this.demand.docks[dock * 2],
              this.demand.docks[dock * 2 + 1],
            ) <= meters
          )
            out.push(dock);
        }
      }
    return out;
  }

  /**
   * §5.7 within `serviceArea.dockBufferMeters` of a dock, or (§22) on land in a 250 m foot-traffic
   * cell at or above `foot.cellMin`, outside the park boxes.
   */
  inServiceArea(latitude: number, longitude: number): boolean {
    if (this.docks.nearest(latitude, longitude, ASSUMPTIONS.serviceArea.dockBufferMeters) >= 0)
      return true;
    return (
      !!this.foot &&
      footWeekdayAt(this.foot, latitude, longitude) >= ASSUMPTIONS.foot.cellMin &&
      this.onLand(latitude, longitude) &&
      !this.inParkBox(latitude, longitude)
    );
  }

  inParkBox(latitude: number, longitude: number): boolean {
    for (let index = 0; index < this.boxes.length; index += 4)
      if (
        latitude >= this.boxes[index] &&
        longitude >= this.boxes[index + 1] &&
        latitude <= this.boxes[index + 2] &&
        longitude <= this.boxes[index + 3]
      )
        return true;
    return false;
  }

  /**
   * §6.5 land snap: a point off the land proxy moves next to the nearest feature within 300 m,
   * else onto the nearest dock. Writes into `out`.
   */
  snap(latitude: number, longitude: number, stream: Stream, out: Placement): Placement {
    out.latitude = latitude;
    out.longitude = longitude;
    if (this.onLand(latitude, longitude)) return out;
    const nearest = this.grid.nearest(latitude, longitude, ASSUMPTIONS.parking.landSnapRingMeters);
    if (nearest >= 0) {
      const featureLatitude = this.grid.points[nearest * 2],
        featureLongitude = this.grid.points[nearest * 2 + 1];
      const [low, high] = ASSUMPTIONS.parking.landSnapMeters;
      for (let attempt = 0; attempt < 4; attempt++) {
        const meters = stream.between(low, high),
          angle = stream.next() * 2 * Math.PI;
        const lat = featureLatitude + offsetLatitude(meters * Math.sin(angle)),
          lon = featureLongitude + offsetLongitude(meters * Math.cos(angle));
        if (this.onLand(lat, lon)) {
          out.latitude = lat;
          out.longitude = lon;
          return out;
        }
      }
      out.latitude = featureLatitude;
      out.longitude = featureLongitude;
      return out;
    }
    const dock = this.docks.nearest(latitude, longitude, 20_000);
    if (dock >= 0) {
      out.latitude = this.demand.docks[dock * 2];
      out.longitude = this.demand.docks[dock * 2 + 1];
    }
    return out;
  }

  /**
   * The immediate-tow buffer the point is inside (§6.1): LAYER.BUS within 10 m, LAYER.EXIT within
   * 5 m (exit data only), LAYER.CROSSWALK within 3 m (§20.3); 0 when outside all. The feature
   * index is in `hitIndex`.
   */
  hitIndex = -1;
  immediateHit(latitude: number, longitude: number): number {
    const buffers = ASSUMPTIONS.parking.bufferMeters;
    const scan = this.nearScan(latitude, longitude, buffers.crosswalk);
    let best = 0,
      bestRatio = Infinity;
    const consider = (layer: number, buffer: number) => {
      if (scan.index[layer] >= 0 && scan.meters[layer] <= buffer) {
        const ratio = scan.meters[layer] / buffer;
        if (ratio < bestRatio) {
          bestRatio = ratio;
          best = layer;
          this.hitIndex = scan.index[layer];
        }
      }
    };
    consider(LAYER.BUS, buffers.busStop);
    if (this.meta.subwayKind === 'exits') consider(LAYER.EXIT, buffers.subwayExit);
    consider(LAYER.CROSSWALK, buffers.crosswalk);
    return best;
  }

  /**
   * The operator's own no-parking geofences (§6.4): bus stops and subway exits. A crosswalk is
   * one representative point here, too coarse for a geofence, so it is left to complaints.
   */
  geofenceHit(latitude: number, longitude: number): boolean {
    const buffers = ASSUMPTIONS.parking.bufferMeters;
    const scan = this.nearScan(latitude, longitude, buffers.busStop);
    return (
      (scan.index[LAYER.BUS] >= 0 && scan.meters[LAYER.BUS] <= buffers.busStop) ||
      (this.meta.subwayKind === 'exits' &&
        scan.index[LAYER.EXIT] >= 0 &&
        scan.meters[LAYER.EXIT] <= buffers.subwayExit)
    );
  }

  bufferOf(layer: number) {
    const buffers = ASSUMPTIONS.parking.bufferMeters;
    return layer === LAYER.BUS
      ? buffers.busStop
      : layer === LAYER.EXIT
        ? buffers.subwayExit
        : buffers.crosswalk;
  }

  /**
   * §6.2-2 a compliant rider parks at the point, pushed out of any immediate-tow buffer toward
   * the nearest dock (the sidewalk proxy), at most three times; then the dock fallback.
   */
  compliantSpot(latitude: number, longitude: number, out: Placement): Placement {
    const parking = ASSUMPTIONS.parking;
    out.category = CATEGORY.PROPER;
    out.geometry = false;
    out.dockFallback = false;
    out.designated = false;
    out.discouraged = false;
    out.noReturn = false;
    let lat = latitude,
      lon = longitude;
    for (let attempt = 0; attempt <= parking.pushTries; attempt++) {
      const layer = this.immediateHit(lat, lon);
      if (!layer) {
        out.latitude = lat;
        out.longitude = lon;
        return out;
      }
      if (attempt === parking.pushTries) break;
      const featureLat = this.featureLatitude(layer, this.hitIndex),
        featureLon = this.featureLongitude(layer, this.hitIndex);
      const dock = this.docks.nearest(featureLat, featureLon, 5_000);
      let dy = 0,
        dx = 0;
      if (dock >= 0) {
        dy = (this.demand.docks[dock * 2] - featureLat) * METERS_PER_DEGREE;
        dx = (this.demand.docks[dock * 2 + 1] - featureLon) * METERS_PER_DEGREE * COS_LATITUDE;
      }
      if (Math.hypot(dy, dx) < 1) {
        dy = (lat - featureLat) * METERS_PER_DEGREE;
        dx = (lon - featureLon) * METERS_PER_DEGREE * COS_LATITUDE;
      }
      const norm = Math.hypot(dy, dx) || 1;
      const push = this.bufferOf(layer) + parking.pushExtraMeters;
      lat = featureLat + offsetLatitude((dy / norm) * push);
      lon = featureLon + offsetLongitude((dx / norm) * push);
    }
    // Dense crosswalks can defeat the pushes: look around for a clean spot first.
    const bearing = ((Math.abs(Math.round(latitude * 1e6)) % 360) * Math.PI) / 180;
    for (let step = 1; step <= 5; step++) {
      const meters = (parking.searchMeters * step) / 5;
      for (let turn = 0; turn < 8; turn++) {
        const angle = bearing + (turn * Math.PI) / 4;
        const ringLat = latitude + offsetLatitude(meters * Math.sin(angle)),
          ringLon = longitude + offsetLongitude(meters * Math.cos(angle));
        if (!this.immediateHit(ringLat, ringLon) && this.onLand(ringLat, ringLon)) {
          out.latitude = ringLat;
          out.longitude = ringLon;
          return out;
        }
      }
    }
    return this.dockFallback(latitude, longitude, out);
  }

  /** Nearest dock + 10 m toward the point, marked dock-fallback. */
  dockFallback(latitude: number, longitude: number, out: Placement): Placement {
    const dock = this.docks.nearest(latitude, longitude, 20_000);
    out.dockFallback = true;
    out.category = CATEGORY.PROPER;
    if (dock < 0) {
      out.latitude = latitude;
      out.longitude = longitude;
      return out;
    }
    return this.besideDock(dock, latitude, longitude, out);
  }

  /** `dockFallbackMeters` from a dock toward the point, written into `out`. */
  private besideDock(dock: number, latitude: number, longitude: number, out: Placement) {
    const dockLat = this.demand.docks[dock * 2],
      dockLon = this.demand.docks[dock * 2 + 1];
    const dy = (latitude - dockLat) * METERS_PER_DEGREE,
      dx = (longitude - dockLon) * METERS_PER_DEGREE * COS_LATITUDE;
    const norm = Math.hypot(dy, dx);
    const meters = ASSUMPTIONS.parking.dockFallbackMeters;
    out.latitude = dockLat + (norm > 0 ? offsetLatitude((dy / norm) * meters) : 0);
    out.longitude = dockLon + (norm > 0 ? offsetLongitude((dx / norm) * meters) : 0);
    return out;
  }

  /**
   * A proper spot within `maxMeters` for a crew or a re-parking rider: rings of candidate points
   * from a random bearing, the closest outside every immediate-tow buffer. When none fits, the
   * vehicle stays and is marked dock-fallback (the tests exempt those, §16.3). With a vehicle
   * `type`, the legal spot of the rule table instead.
   */
  properSpotNear(
    latitude: number,
    longitude: number,
    maxMeters: number,
    stream: Stream,
    out: Placement,
    nudgeMeters = 0,
    type = -1,
  ): Placement {
    // A crew that knows the vehicle type parks it where the rule table allows (§20.3), within
    // `maxMeters`; farther than that it stays and is marked dock-fallback, as below, unless it
    // stands on a no-return spot: that one is carried to the legal spot however far.
    if (type >= 0) {
      this.legalSpot(type, latitude, longitude, out);
      if (metersApart(latitude, longitude, out.latitude, out.longitude) <= maxMeters) return out;
      const stuck = this.returnEffect(type, latitude, longitude) === RETURN.NO_RETURN;
      if (stuck && !out.noReturn) return out;
      out.latitude = latitude;
      out.longitude = longitude;
      out.discouraged = false;
      out.dockFallback = true;
      out.noReturn = stuck;
      return out;
    }
    out.category = CATEGORY.PROPER;
    out.geometry = false;
    out.dockFallback = false;
    out.designated = false;
    out.discouraged = false;
    out.noReturn = false;
    if (!this.immediateHit(latitude, longitude) && this.onLand(latitude, longitude)) {
      // A crew re-parking a vehicle that broke no mapped rule still lifts it off the carriageway or
      // doorway onto the kerb: a few metres, and never into a zone it was not in before.
      const meters = nudgeMeters * (0.25 + 0.75 * stream.next()),
        angle = stream.next() * 2 * Math.PI;
      const lat = latitude + offsetLatitude(meters * Math.sin(angle)),
        lon = longitude + offsetLongitude(meters * Math.cos(angle));
      const nudged = meters > 0 && !this.immediateHit(lat, lon) && this.onLand(lat, lon);
      out.latitude = nudged ? lat : latitude;
      out.longitude = nudged ? lon : longitude;
      return out;
    }
    const bearing = stream.next() * 2 * Math.PI;
    for (let step = 1; step <= 5; step++) {
      const meters = (maxMeters * step) / 5;
      for (let turn = 0; turn < 8; turn++) {
        const angle = bearing + (turn * Math.PI) / 4;
        const lat = latitude + offsetLatitude(meters * Math.sin(angle)),
          lon = longitude + offsetLongitude(meters * Math.cos(angle));
        if (!this.immediateHit(lat, lon) && this.onLand(lat, lon)) {
          out.latitude = lat;
          out.longitude = lon;
          return out;
        }
      }
    }
    out.latitude = latitude;
    out.longitude = longitude;
    out.dockFallback = true;
    return out;
  }

  /** §6.1 designated spot: a compliant return within 30 m of a busy dock, 30% of the time. */
  nearTopDock(latitude: number, longitude: number): boolean {
    const dock = this.docks.nearest(
      latitude,
      longitude,
      ASSUMPTIONS.parking.designated.withinMeters,
    );
    return dock >= 0 && this.demand.top[dock] === 1;
  }

  /**
   * §6.2-3 the violation a non-compliant rider commits near the intended point. Geometric
   * categories move the vehicle into that feature's buffer; the others stay at the point.
   * `allowRestricted` is false after the app has refused a return once.
   */
  violation(
    latitude: number,
    longitude: number,
    stream: Stream,
    allowRestricted: boolean,
    out: Placement,
  ): Placement {
    const parking = ASSUMPTIONS.parking,
      weights = parking.weights,
      fallback = parking.fallbackWeights;
    const centroids = this.meta.subwayKind === 'centroids';
    const scan = this.nearScan(
      latitude,
      longitude,
      Math.max(parking.searchMeters, centroids ? parking.centroids.searchMeters : 0),
    );
    const near = (layer: number, meters: number) =>
      scan.index[layer] >= 0 && scan.meters[layer] <= meters;
    const busIndex = near(LAYER.BUS, parking.searchMeters) ? scan.index[LAYER.BUS] : -1;
    const exitIndex = near(
      LAYER.EXIT,
      centroids ? parking.centroids.searchMeters : parking.searchMeters,
    )
      ? scan.index[LAYER.EXIT]
      : -1;
    const crossIndex = near(LAYER.CROSSWALK, parking.searchMeters)
      ? scan.index[LAYER.CROSSWALK]
      : -1;
    const tactileNear =
      near(LAYER.EXIT, weights.tactileNearMeters) ||
      near(LAYER.CROSSWALK, weights.tactileNearMeters);
    const dock = this.docks.nearest(latitude, longitude, 1_000);
    const guess = dock >= 0 && this.stationGuess[dock] === 1;

    // Weighted choice over geometric and probabilistic categories.
    const w = WEIGHTS;
    w[0] = this.hasLayer[LAYER.BUS] && busIndex >= 0 ? weights.busStop : 0; // bus stop (geometry)
    w[1] = (this.hasLayer[LAYER.BUS] ? 0 : fallback.busStop) + weights.taxi; // bus/taxi (probability)
    w[2] = this.hasLayer[LAYER.EXIT] && exitIndex >= 0 ? weights.subwayExit : 0; // exit (geometry)
    w[3] =
      (this.hasLayer[LAYER.EXIT] ? 0 : fallback.subwayExit) + (guess ? weights.stationGuess : 0);
    w[4] = this.hasLayer[LAYER.CROSSWALK] && crossIndex >= 0 ? weights.crosswalk : 0;
    w[5] = this.hasLayer[LAYER.CROSSWALK] ? 0 : fallback.crosswalk;
    w[6] = weights.sidewalk;
    w[7] = weights.roadway;
    w[8] = tactileNear ? weights.tactileNear : weights.tactile;
    w[9] = weights.private;
    w[10] = allowRestricted
      ? weights.restricted *
        (this.inParkBox(latitude, longitude) ? weights.restrictedInBox : weights.restrictedOutBox)
      : 0;
    let total = 0;
    for (let index = 0; index < w.length; index++) total += w[index];
    let target = stream.next() * total,
      pick = w.length - 1;
    for (let index = 0; index < w.length; index++) {
      if (target < w[index]) {
        pick = index;
        break;
      }
      target -= w[index];
    }

    out.dockFallback = false;
    out.designated = false;
    out.discouraged = false;
    const place = (layer: number, index: number, buffer: number) => {
      const meters = stream.next() * buffer * parking.geometricPlacementShare,
        angle = stream.next() * 2 * Math.PI;
      out.latitude = this.featureLatitude(layer, index) + offsetLatitude(meters * Math.sin(angle));
      out.longitude =
        this.featureLongitude(layer, index) + offsetLongitude(meters * Math.cos(angle));
      out.geometry = true;
    };
    const stay = () => {
      const [low, high] = parking.jitterMeters;
      const meters = stream.between(low, high),
        angle = stream.next() * 2 * Math.PI;
      out.latitude = latitude + offsetLatitude(meters * Math.sin(angle));
      out.longitude = longitude + offsetLongitude(meters * Math.cos(angle));
      out.geometry = false;
    };
    switch (pick) {
      case 0:
        place(LAYER.BUS, busIndex, parking.bufferMeters.busStop);
        out.category = CATEGORY.BUS_TAXI;
        break;
      case 1:
        stay();
        out.category = CATEGORY.BUS_TAXI;
        break;
      case 2:
        if (centroids) {
          // Only a centroid: the rider is somewhere around the station, in front of an exit 30%.
          place(LAYER.EXIT, exitIndex, parking.centroids.searchMeters);
          out.category = stream.chance(parking.centroids.immediateShare)
            ? CATEGORY.SUBWAY_EXIT
            : CATEGORY.SIDEWALK;
        } else {
          place(LAYER.EXIT, exitIndex, parking.bufferMeters.subwayExit);
          out.category = CATEGORY.SUBWAY_EXIT;
        }
        break;
      case 3:
        stay();
        out.category = CATEGORY.SUBWAY_EXIT;
        break;
      case 4:
        place(LAYER.CROSSWALK, crossIndex, parking.bufferMeters.crosswalk);
        out.category = CATEGORY.CROSSWALK;
        break;
      case 5:
        stay();
        out.category = CATEGORY.CROSSWALK;
        break;
      case 6:
        stay();
        out.category = CATEGORY.SIDEWALK;
        break;
      case 7:
        stay();
        out.category = CATEGORY.ROADWAY;
        break;
      case 8:
        stay();
        out.category = CATEGORY.TACTILE;
        break;
      case 9:
        stay();
        out.category = CATEGORY.PRIVATE;
        break;
      default:
        stay();
        out.category = CATEGORY.RESTRICTED;
    }
    return out;
  }
}

const WEIGHTS = new Float64Array(11);
/** The category of a point inside a layer's immediate-tow buffer (§6.1), by LAYER. */
const PLACED_CATEGORY: readonly number[] = [
  CATEGORY.NONE,
  CATEGORY.BUS_TAXI,
  CATEGORY.SUBWAY_EXIT,
  CATEGORY.CROSSWALK,
];
