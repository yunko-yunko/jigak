import { readFileSync } from 'node:fs';
import { dataFile } from './calendar.js';
import { VEHICLE_TYPE_NAMES } from './sim-codes.js';

/**
 * §20.2 the no-return rule table (shared-mobility-return-rules-v1, mvp/scripts/
 * build-shared-mobility-return-rules.py): roadways, crosswalks, buildings, schools, parks and the
 * other places where a shared kick-scooter or e-bike may not, or should not, be left. The file's
 * `meta.rules` drives everything here, so adding a layer or a rule is a data change.
 */
export const RETURN_RULES_VERSION = 'shared-mobility-return-rules-v1';

/** What a rule set says about one spot for one vehicle type. */
export const RETURN = { CLEAN: 0, DISCOURAGED: 1, NO_RETURN: 2 } as const;
/** `effectAt` bit: inside a zone that allows a return only next to a door (R22, R24). */
export const DOOR_ZONE = 4;
/** `effectAt` bit: inside a zone that allows a return only at its spots (R21), not at one. */
export const SPOT_ZONE = 8;

/** The official point layers of seoul-pm-parking-rules-v1 a rule may name (§6.3). */
export const OFFICIAL_LAYERS = ['busStops', 'subwayExits', 'crosswalks'] as const;

const EFFECTS = ['no-return', 'discouraged', 'no-return-outside-spots'] as const;
type Effect = (typeof EFFECTS)[number];

/** One row of the rule table, as the file states it. */
export interface ReturnRule {
  id: string;
  name: string;
  effect: Effect;
  /** VTYPE codes the rule binds. */
  types: number[];
  layers: string[];
  official: string[];
  /** Absolute radius around a feature, or null. */
  radiusM: number | null;
  /** Metres beyond a feature's own half-width, or null. */
  bufferM: number | null;
  exceptNearDoors: boolean;
  spots: string | null;
  ridingBanned: boolean;
  evidence: string;
}

export interface ReturnRulesMeta {
  version: string | null;
  builtAt: number | null;
  rules: number;
  layers: number;
  features: number;
  vertices: number;
  /** True when the file was missing or malformed: only the official buffers apply. */
  fallback: boolean;
}

/** Same box as the parking grids (parking-rules.ts); features outside it are dropped. */
const BOUNDS = { south: 37.4, north: 37.72, west: 126.74, east: 127.22 } as const;
const METERS_PER_DEGREE = 111_195;
const COS_LATITUDE = Math.cos((37.55 * Math.PI) / 180);
/** Grid cell (가정값): about 100–200 items per cell in central Seoul. */
const CELL_METERS = 56;
const NONE = -1;

const bytesOf = (packed: unknown): Uint8Array =>
  typeof packed === 'string'
    ? Buffer.from(packed, 'latin1')
    : packed instanceof Uint8Array
      ? packed
      : new Uint8Array(0);

/** Reads packed integers one at a time, so the 3 million coordinates need no transient array. */
class PackedReader {
  readonly count: number;
  private index = 0;
  private readonly bytes: Uint8Array;

  constructor(
    packed: unknown,
    private readonly alphabet: Int8Array,
  ) {
    this.bytes = bytesOf(packed);
    let count = 0;
    for (let index = 0; index < this.bytes.length; index++)
      if (!(alphabet[this.bytes[index] & 127] & 32)) count++;
    this.count = count;
  }

  next(): number {
    let z = 0,
      scale = 1;
    for (;;) {
      const group = this.alphabet[this.bytes[this.index++] & 127];
      if (group < 0) throw new Error('return-rules-bad-character');
      z += (group & 31) * scale;
      if (!(group & 32)) return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      scale *= 32;
    }
  }
}

/** Zig-zag integers in 5-bit groups, least significant first, one alphabet character each. */
function unpack(packed: unknown, alphabet: Int8Array): Int32Array {
  const bytes = bytesOf(packed);
  let count = 0;
  for (let index = 0; index < bytes.length; index++)
    if (!(alphabet[bytes[index] & 127] & 32)) count++;
  const out = new Int32Array(count);
  let z = 0,
    scale = 1,
    slot = 0;
  for (let index = 0; index < bytes.length; index++) {
    const group = alphabet[bytes[index] & 127];
    if (group < 0) throw new Error('return-rules-bad-character');
    z += (group & 31) * scale;
    if (group & 32) scale *= 32;
    else {
      out[slot++] = z % 2 === 0 ? z / 2 : -(z + 1) / 2;
      z = 0;
      scale = 1;
    }
  }
  return out;
}

/** One layer of the file; packed columns are strings, or byte ranges of the file (§20.4). */
interface RawLayer {
  kind?: unknown;
  q?: unknown;
  n?: unknown;
  xy?: unknown;
  len?: unknown;
  r?: unknown;
  f?: unknown;
  hole?: unknown;
}

/**
 * Decoded and indexed rule geometry. Coordinates are metres east and north of the grid's
 * south-west corner (Float32, well under a centimetre here); one CSR grid holds every segment,
 * polygon and point, registered in each cell its reach can touch, so a query reads one cell.
 */
export class ReturnRules {
  readonly meta: ReturnRulesMeta;
  readonly rules: readonly ReturnRule[];
  readonly layerNames: readonly string[];
  /** The rule that decided the last `effectAt` (index into `rules`), or -1. */
  lastRule = NONE;

  // Per (type, layer): radii in metres (-1 none), buffers beyond the half-width (-Infinity none).
  private readonly noAbs: Float32Array;
  private readonly noBuf: Float32Array;
  private readonly discAbs: Float32Array;
  private readonly discBuf: Float32Array;
  private readonly noRule: Int16Array;
  private readonly discRule: Int16Array;
  /** Polygon effect per (type, layer): 0 none, 1 no-return, 2 discouraged, 3 door zone, 4 spot zone. */
  private readonly polyMode: Uint8Array;
  private readonly polyRule: Int16Array;
  private readonly spotRadius: Float32Array;
  private readonly rideBan: Float32Array;
  /** Per (type, layer): does any no-return or discouraged radius apply to its lines? */
  private readonly lineRuled: Uint8Array;
  /** Official layers per (type, OFFICIAL_LAYERS index). */
  readonly officialNo: Float32Array;
  readonly officialDisc: Float32Array;
  readonly officialNoRule: Int16Array;
  readonly officialDiscRule: Int16Array;
  /** Largest official radius any type uses (the scan distance). */
  readonly officialReach: number;

  private readonly lineX: Float32Array;
  private readonly lineY: Float32Array;
  private readonly lineOf: Int32Array;
  private readonly lineLayer: Uint8Array;
  private readonly lineR: Float32Array;
  /** Polygon vertices in half metres from the polygon's anchor (its first vertex), Int16. */
  private readonly polyX: Int16Array;
  private readonly polyY: Int16Array;
  private readonly anchorX: Float32Array;
  private readonly anchorY: Float32Array;
  private readonly ringStart: Int32Array;
  private readonly polyRings: Int32Array;
  private readonly polyLayer: Uint8Array;
  private readonly pointX: Float32Array;
  private readonly pointY: Float32Array;
  private readonly pointLayer: Uint8Array;
  private readonly pointR: Float32Array;
  private readonly segEnd: number;
  private readonly polyEnd: number;
  private readonly rows: number;
  private readonly cols: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(raw: unknown) {
    const file = raw as {
      version?: unknown;
      builtAt?: unknown;
      meta?: { rules?: unknown; codec?: { alphabet?: unknown } };
      layers?: Record<string, RawLayer>;
    };
    const valid =
      !!file &&
      typeof file === 'object' &&
      file.version === RETURN_RULES_VERSION &&
      Array.isArray(file.meta?.rules) &&
      typeof file.meta?.codec?.alphabet === 'string' &&
      !!file.layers &&
      typeof file.layers === 'object';
    const layers = valid ? file.layers! : {};
    this.layerNames = Object.keys(layers);
    this.rules = valid ? parseRules(file.meta!.rules as unknown[]) : [];
    const layerCount = this.layerNames.length,
      types = VEHICLE_TYPE_NAMES.length,
      size = types * Math.max(1, layerCount);
    this.noAbs = new Float32Array(size).fill(NONE);
    this.noBuf = new Float32Array(size).fill(-Infinity);
    this.discAbs = new Float32Array(size).fill(NONE);
    this.discBuf = new Float32Array(size).fill(-Infinity);
    this.noRule = new Int16Array(size).fill(NONE);
    this.discRule = new Int16Array(size).fill(NONE);
    this.polyMode = new Uint8Array(size);
    this.polyRule = new Int16Array(size).fill(NONE);
    this.spotRadius = new Float32Array(size).fill(NONE);
    this.rideBan = new Float32Array(size).fill(NONE);
    this.officialNo = new Float32Array(types * OFFICIAL_LAYERS.length).fill(NONE);
    this.officialDisc = new Float32Array(types * OFFICIAL_LAYERS.length).fill(NONE);
    this.officialNoRule = new Int16Array(types * OFFICIAL_LAYERS.length).fill(NONE);
    this.officialDiscRule = new Int16Array(types * OFFICIAL_LAYERS.length).fill(NONE);
    const kinds = this.layerNames.map((name) => layers[name]?.kind);
    this.rules.forEach((rule, index) => this.applyRule(rule, index, kinds));
    this.lineRuled = new Uint8Array(size);
    for (let slot = 0; slot < size; slot++)
      this.lineRuled[slot] =
        this.noAbs[slot] >= 0 ||
        this.discAbs[slot] >= 0 ||
        this.noBuf[slot] > -Infinity ||
        this.discBuf[slot] > -Infinity
          ? 1
          : 0;
    let reach = 0;
    for (let slot = 0; slot < this.officialNo.length; slot++)
      reach = Math.max(reach, this.officialNo[slot], this.officialDisc[slot]);
    this.officialReach = reach;

    // Ring lengths first, to size the typed arrays once; each layer's coordinates are then
    // unpacked one layer at a time, so the transient integers stay small.
    const alphabet = new Int8Array(128).fill(-1);
    const letters = valid ? (file.meta!.codec!.alphabet as string) : '';
    for (let index = 0; index < letters.length; index++)
      alphabet[letters.charCodeAt(index) & 127] = index;
    const decoded = this.layerNames.map((name) => {
      const layer = layers[name]!;
      const n = Number(layer.n);
      const q = Number(layer.q);
      const len = layer.kind === 'point' ? null : unpack(layer.len, alphabet);
      const vertices = len ? len.reduce((sum, value) => sum + value, 0) : n;
      if (!Number.isInteger(n) || !Number.isInteger(q)) throw new Error('return-rules-bad-layer');
      return { kind: layer.kind, n, scale: 10 ** -q, len, vertices, name };
    });
    let lineVertices = 0,
      lineFeatures = 0,
      polyVertices = 0,
      polyRingCount = 0,
      polyFeatures = 0,
      points = 0;
    for (const layer of decoded)
      if (layer.kind === 'line') {
        lineVertices += layer.vertices;
        lineFeatures += layer.n;
      } else if (layer.kind === 'polygon') {
        polyVertices += layer.vertices;
        polyRingCount += layer.len!.length;
        polyFeatures += layer.n;
      } else points += layer.n;
    this.lineX = new Float32Array(lineVertices);
    this.lineY = new Float32Array(lineVertices);
    this.lineOf = new Int32Array(lineVertices);
    this.lineLayer = new Uint8Array(lineFeatures);
    this.lineR = new Float32Array(lineFeatures);
    this.polyX = new Int16Array(polyVertices);
    this.polyY = new Int16Array(polyVertices);
    this.anchorX = new Float32Array(polyFeatures);
    this.anchorY = new Float32Array(polyFeatures);
    // Half metres keep ±16 km around the anchor; a larger polygon would be clipped (none in v1).
    const half = (meters: number) => Math.max(-32_767, Math.min(32_767, Math.round(meters * 2)));
    this.ringStart = new Int32Array(polyRingCount + 1);
    this.polyRings = new Int32Array(polyFeatures + 1);
    this.polyLayer = new Uint8Array(polyFeatures);
    this.pointX = new Float32Array(points);
    this.pointY = new Float32Array(points);
    this.pointLayer = new Uint8Array(points);
    this.pointR = new Float32Array(points);
    // A ring's first vertex is relative to the previous ring's first vertex, the rest to the
    // vertex before; integers are 10^-q degrees.
    let line = 0,
      lineVertex = 0,
      poly = 0,
      ring = 0,
      polyVertex = 0,
      point = 0;
    decoded.forEach((layer, layerIndex) => {
      const { len, scale } = layer;
      const raw = layers[layer.name]!;
      const xy = new PackedReader(raw.xy, alphabet),
        r = unpack(raw.r, alphabet),
        hole = unpack(raw.hole, alphabet);
      if (xy.count !== layer.vertices * 2) throw new Error('return-rules-bad-layer');
      const toX = (lon: number) => (lon * scale - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE;
      const toY = (lat: number) => (lat * scale - BOUNDS.south) * METERS_PER_DEGREE;
      let firstLat = 0,
        firstLon = 0,
        feature = -1;
      if (layer.kind === 'point') {
        for (let index = 0; index < layer.n; index++) {
          firstLat += xy.next();
          firstLon += xy.next();
          this.pointX[point] = toX(firstLon);
          this.pointY[point] = toY(firstLat);
          this.pointLayer[point] = layerIndex;
          this.pointR[point] = (r[index] ?? 0) / 10;
          point++;
        }
        return;
      }
      for (let ringIndex = 0; ringIndex < len!.length; ringIndex++) {
        const isHole = hole[ringIndex] === 1 && feature >= 0;
        if (!isHole) feature++;
        let lat = (firstLat += xy.next()),
          lon = (firstLon += xy.next());
        const count = len![ringIndex];
        if (layer.kind === 'line') {
          for (let vertex = 0; vertex < count; vertex++) {
            if (vertex) {
              lat += xy.next();
              lon += xy.next();
            }
            this.lineX[lineVertex] = toX(lon);
            this.lineY[lineVertex] = toY(lat);
            // A vertex starts a segment only when another vertex of its ring follows.
            this.lineOf[lineVertex] = vertex < count - 1 ? line + feature : NONE;
            lineVertex++;
          }
          continue;
        }
        if (!isHole) {
          this.polyRings[poly + feature] = ring;
          this.polyLayer[poly + feature] = layerIndex;
          this.anchorX[poly + feature] = toX(lon);
          this.anchorY[poly + feature] = toY(lat);
        }
        const anchorX = this.anchorX[poly + feature],
          anchorY = this.anchorY[poly + feature];
        this.ringStart[ring++] = polyVertex;
        for (let vertex = 0; vertex < count; vertex++) {
          if (vertex) {
            lat += xy.next();
            lon += xy.next();
          }
          this.polyX[polyVertex] = half(toX(lon) - anchorX);
          this.polyY[polyVertex] = half(toY(lat) - anchorY);
          polyVertex++;
        }
      }
      if (layer.kind === 'line') {
        for (let index = 0; index < layer.n; index++) {
          this.lineLayer[line + index] = layerIndex;
          this.lineR[line + index] = (r[index] ?? 0) / 10;
        }
        line += layer.n;
      } else poly += layer.n;
    });
    this.ringStart[ring] = polyVertex;
    this.polyRings[poly] = ring;
    this.segEnd = lineVertices;
    this.polyEnd = lineVertices + polyFeatures;

    this.rows = Math.ceil(((BOUNDS.north - BOUNDS.south) * METERS_PER_DEGREE) / CELL_METERS);
    this.cols = Math.ceil(
      ((BOUNDS.east - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE) / CELL_METERS,
    );
    this.start = new Int32Array(this.rows * this.cols + 1);
    this.forEachCell((cell) => this.start[cell + 1]++);
    for (let cell = 0; cell < this.rows * this.cols; cell++)
      this.start[cell + 1] += this.start[cell];
    this.items = new Int32Array(this.start[this.rows * this.cols]);
    const cursor = this.start.slice(0, this.rows * this.cols);
    this.forEachCell((cell, item) => (this.items[cursor[cell]++] = item));
    this.meta = {
      version: valid ? RETURN_RULES_VERSION : null,
      builtAt: valid && Number.isFinite(file.builtAt) ? (file.builtAt as number) : null,
      rules: this.rules.length,
      layers: layerCount,
      features: lineFeatures + polyFeatures + points,
      vertices: lineVertices + polyVertices + points,
      fallback: !valid,
    };
  }

  /** Records one rule's radii on its layers, per vehicle type it binds. */
  private applyRule(rule: ReturnRule, index: number, kinds: unknown[]) {
    const layerCount = this.layerNames.length;
    for (const type of rule.types) {
      for (const official of rule.official) {
        const slot = type * OFFICIAL_LAYERS.length + OFFICIAL_LAYERS.indexOf(official as never);
        if (slot < type * OFFICIAL_LAYERS.length) continue;
        // An official point has no width: a buffer counts from the point itself.
        const radius = Math.max(rule.radiusM ?? NONE, rule.bufferM ?? NONE);
        if (rule.effect === 'discouraged') {
          if (radius > this.officialDisc[slot]) {
            this.officialDisc[slot] = radius;
            this.officialDiscRule[slot] = index;
          }
        } else if (radius > this.officialNo[slot]) {
          this.officialNo[slot] = radius;
          this.officialNoRule[slot] = index;
        }
      }
      if (rule.spots) {
        const spotLayer = this.layerNames.indexOf(rule.spots);
        if (spotLayer >= 0)
          this.spotRadius[type * layerCount + spotLayer] = Math.max(
            this.spotRadius[type * layerCount + spotLayer],
            rule.radiusM ?? 0,
          );
      }
      for (const name of rule.layers) {
        const layer = this.layerNames.indexOf(name);
        if (layer < 0) continue;
        const slot = type * layerCount + layer;
        if (rule.ridingBanned) this.rideBan[slot] = Math.max(this.rideBan[slot], rule.radiusM ?? 0);
        if (kinds[layer] === 'polygon') {
          // Polygons rule their inside only; every polygon buffer in v1 is 0.
          const mode =
            rule.effect === 'no-return-outside-spots'
              ? 4
              : rule.effect === 'discouraged'
                ? 2
                : rule.exceptNearDoors
                  ? 3
                  : 1;
          // The strictest effect wins: no-return over a door zone over a spot zone over discouraged.
          const rank = [0, 4, 1, 3, 2];
          if (rank[mode] > rank[this.polyMode[slot]]) {
            this.polyMode[slot] = mode;
            this.polyRule[slot] = index;
          }
          continue;
        }
        const discouraged = rule.effect === 'discouraged';
        const abs = discouraged ? this.discAbs : this.noAbs,
          buf = discouraged ? this.discBuf : this.noBuf,
          owner = discouraged ? this.discRule : this.noRule;
        if (rule.radiusM !== null && rule.radiusM > abs[slot]) {
          abs[slot] = rule.radiusM;
          owner[slot] = index;
        }
        if (rule.bufferM !== null && rule.bufferM > buf[slot]) {
          buf[slot] = rule.bufferM;
          if (owner[slot] < 0 || rule.radiusM === null) owner[slot] = index;
        }
      }
    }
  }

  /** The farthest any rule reaches from a feature of `layer` with half-width `r`. */
  private reach(layer: number, r: number) {
    let reach = 0;
    const layerCount = this.layerNames.length;
    for (let type = 0; type < VEHICLE_TYPE_NAMES.length; type++) {
      const slot = type * layerCount + layer;
      reach = Math.max(
        reach,
        this.noAbs[slot],
        this.discAbs[slot],
        r + this.noBuf[slot],
        r + this.discBuf[slot],
        this.spotRadius[slot],
        this.rideBan[slot],
      );
    }
    return reach;
  }

  /** Calls `visit(cell, item)` for every cell each feature's reach overlaps. */
  private forEachCell(visit: (cell: number, item: number) => void) {
    const box = (item: number, x0: number, y0: number, x1: number, y1: number, pad: number) => {
      if (pad < 0) return;
      const c0 = Math.max(0, Math.floor((x0 - pad) / CELL_METERS)),
        c1 = Math.min(this.cols - 1, Math.floor((x1 + pad) / CELL_METERS)),
        r0 = Math.max(0, Math.floor((y0 - pad) / CELL_METERS)),
        r1 = Math.min(this.rows - 1, Math.floor((y1 + pad) / CELL_METERS));
      for (let row = r0; row <= r1; row++)
        for (let col = c0; col <= c1; col++) visit(row * this.cols + col, item);
    };
    const lineReach = new Float32Array(this.lineLayer.length);
    for (let feature = 0; feature < lineReach.length; feature++)
      lineReach[feature] = this.reach(this.lineLayer[feature], this.lineR[feature]);
    for (let vertex = 0; vertex < this.segEnd; vertex++) {
      const feature = this.lineOf[vertex];
      if (feature < 0 || !(lineReach[feature] > 0)) continue;
      const x0 = this.lineX[vertex],
        y0 = this.lineY[vertex],
        x1 = this.lineX[vertex + 1],
        y1 = this.lineY[vertex + 1];
      box(
        vertex,
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.max(x0, x1),
        Math.max(y0, y1),
        lineReach[feature],
      );
    }
    const layerCount = this.layerNames.length;
    for (let poly = 0; poly < this.polyLayer.length; poly++) {
      let used = false;
      for (let type = 0; type < VEHICLE_TYPE_NAMES.length; type++)
        if (this.polyMode[type * layerCount + this.polyLayer[poly]]) used = true;
      if (!used) continue;
      const from = this.ringStart[this.polyRings[poly]],
        to = this.ringStart[this.polyRings[poly] + 1];
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let vertex = from; vertex < to; vertex++) {
        x0 = Math.min(x0, this.polyX[vertex]);
        x1 = Math.max(x1, this.polyX[vertex]);
        y0 = Math.min(y0, this.polyY[vertex]);
        y1 = Math.max(y1, this.polyY[vertex]);
      }
      const ax = this.anchorX[poly],
        ay = this.anchorY[poly];
      box(this.segEnd + poly, ax + x0 / 2, ay + y0 / 2, ax + x1 / 2, ay + y1 / 2, 0);
    }
    for (let point = 0; point < this.pointLayer.length; point++) {
      const reach = this.reach(this.pointLayer[point], this.pointR[point]);
      if (!(reach > 0)) continue;
      const x = this.pointX[point],
        y = this.pointY[point];
      box(this.polyEnd + point, x, y, x, y, reach);
    }
  }

  /** Even-odd test over every ring of a polygon feature (holes included). */
  private inside(poly: number, worldX: number, worldY: number): boolean {
    const x = (worldX - this.anchorX[poly]) * 2,
      y = (worldY - this.anchorY[poly]) * 2;
    let inside = false;
    for (let ring = this.polyRings[poly]; ring < this.polyRings[poly + 1]; ring++) {
      const from = this.ringStart[ring],
        to = this.ringStart[ring + 1];
      for (let index = from, previous = to - 1; index < to; previous = index++) {
        const yA = this.polyY[index],
          yB = this.polyY[previous];
        if (
          yA > y !== yB > y &&
          x <
            ((this.polyX[previous] - this.polyX[index]) * (y - yA)) / (yB - yA) + this.polyX[index]
        )
          inside = !inside;
      }
    }
    return inside;
  }

  private cellAt(latitude: number, longitude: number) {
    const row = Math.floor(((latitude - BOUNDS.south) * METERS_PER_DEGREE) / CELL_METERS),
      col = Math.floor(
        ((longitude - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE) / CELL_METERS,
      );
    return row < 0 || col < 0 || row >= this.rows || col >= this.cols
      ? NONE
      : row * this.cols + col;
  }

  /** Distance from (x, y) to the segment starting at line vertex `vertex`. */
  private segmentMeters(vertex: number, x: number, y: number) {
    const x0 = this.lineX[vertex],
      y0 = this.lineY[vertex];
    const dx = this.lineX[vertex + 1] - x0,
      dy = this.lineY[vertex + 1] - y0;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / length)) : 0;
    return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
  }

  /**
   * What the drawn layers say about a spot for VTYPE `type`: RETURN.CLEAN, DISCOURAGED or
   * NO_RETURN, plus DOOR_ZONE when the spot is inside a school or complex (R22, R24) that the
   * caller allows only next to a door. The official point layers, the service area and the doors
   * are the caller's (ParkingRules); `lastRule` names the deciding rule. SPOT_ZONE marks a spot
   * in a spot-only zone (R21) away from its spots; the caller decides how far that binds.
   */
  effectAt(type: number, latitude: number, longitude: number): number {
    this.lastRule = NONE;
    const cell = this.cellAt(latitude, longitude);
    if (cell < 0) return RETURN.CLEAN;
    const x = (longitude - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE,
      y = (latitude - BOUNDS.south) * METERS_PER_DEGREE;
    const base = type * this.layerNames.length;
    let effect: number = RETURN.CLEAN,
      discouragedBy = NONE,
      doorZoneBy = NONE,
      spotZoneBy = NONE,
      atSpot = false;
    for (let slot = this.start[cell]; slot < this.start[cell + 1]; slot++) {
      const item = this.items[slot];
      let meters: number, slotOf: number, width: number;
      if (item < this.segEnd) {
        const feature = this.lineOf[item];
        slotOf = base + this.lineLayer[feature];
        width = this.lineR[feature];
        if (!this.lineRuled[slotOf]) continue;
        meters = this.segmentMeters(item, x, y);
      } else if (item < this.polyEnd) {
        const poly = item - this.segEnd;
        slotOf = base + this.polyLayer[poly];
        const mode = this.polyMode[slotOf];
        if (!mode || !this.inside(poly, x, y)) continue;
        if (mode === 1) {
          this.lastRule = this.polyRule[slotOf];
          return RETURN.NO_RETURN;
        }
        if (mode === 2) {
          if (discouragedBy < 0) discouragedBy = this.polyRule[slotOf];
          effect = RETURN.DISCOURAGED;
        } else if (mode === 3) doorZoneBy = this.polyRule[slotOf];
        else spotZoneBy = this.polyRule[slotOf];
        continue;
      } else {
        const point = item - this.polyEnd;
        slotOf = base + this.pointLayer[point];
        width = this.pointR[point];
        meters = Math.hypot(x - this.pointX[point], y - this.pointY[point]);
        if (this.spotRadius[slotOf] >= 0 && meters <= Math.max(this.spotRadius[slotOf], width))
          atSpot = true;
      }
      if (meters <= Math.max(this.noAbs[slotOf], width + this.noBuf[slotOf])) {
        this.lastRule = this.noRule[slotOf];
        return RETURN.NO_RETURN;
      }
      if (meters <= Math.max(this.discAbs[slotOf], width + this.discBuf[slotOf])) {
        if (discouragedBy < 0) discouragedBy = this.discRule[slotOf];
        effect = RETURN.DISCOURAGED;
      }
    }
    this.lastRule =
      spotZoneBy >= 0 && !atSpot ? spotZoneBy : doorZoneBy >= 0 ? doorZoneBy : discouragedBy;
    return (
      effect | (doorZoneBy >= 0 ? DOOR_ZONE : 0) | (spotZoneBy >= 0 && !atSpot ? SPOT_ZONE : 0)
    );
  }

  /** Is the spot on a street where VTYPE `type` may not even be ridden (R28)? */
  ridingBanned(type: number, latitude: number, longitude: number): boolean {
    const cell = this.cellAt(latitude, longitude);
    if (cell < 0) return false;
    const x = (longitude - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE,
      y = (latitude - BOUNDS.south) * METERS_PER_DEGREE;
    const base = type * this.layerNames.length;
    for (let slot = this.start[cell]; slot < this.start[cell + 1]; slot++) {
      const item = this.items[slot];
      if (item >= this.segEnd) continue;
      const ban = this.rideBan[base + this.lineLayer[this.lineOf[item]]];
      if (ban >= 0 && this.segmentMeters(item, x, y) <= ban) return true;
    }
    return false;
  }

  /**
   * Is the spot inside a school or complex (R22, R24) of VTYPE `type`? Only the zone polygons
   * count, so a roadway inside the zone does not hide it (the gate test in ParkingRules).
   */
  inDoorZone(type: number, latitude: number, longitude: number): boolean {
    const cell = this.cellAt(latitude, longitude);
    if (cell < 0) return false;
    const x = (longitude - BOUNDS.west) * METERS_PER_DEGREE * COS_LATITUDE,
      y = (latitude - BOUNDS.south) * METERS_PER_DEGREE;
    const base = type * this.layerNames.length;
    for (let slot = this.start[cell]; slot < this.start[cell + 1]; slot++) {
      const item = this.items[slot];
      if (item < this.segEnd || item >= this.polyEnd) continue;
      const poly = item - this.segEnd;
      if (this.polyMode[base + this.polyLayer[poly]] === 3 && this.inside(poly, x, y)) return true;
    }
    return false;
  }

  /** Points of a point layer, lat/lon interleaved (for a nearest-spot search). */
  pointsOf(name: string): Float64Array {
    const layer = this.layerNames.indexOf(name);
    const picked: number[] = [];
    for (let point = 0; point < this.pointLayer.length; point++)
      if (this.pointLayer[point] === layer)
        picked.push(
          BOUNDS.south + this.pointY[point] / METERS_PER_DEGREE,
          BOUNDS.west + this.pointX[point] / (METERS_PER_DEGREE * COS_LATITUDE),
        );
    return Float64Array.from(picked);
  }

  /** The spot layer a no-return-outside-spots rule of VTYPE `type` names, or null. */
  spotLayerOf(type: number): string | null {
    return this.rules.find((rule) => rule.spots && rule.types.includes(type))?.spots ?? null;
  }
}

/** Rule rows with a known effect; anything else in the file is ignored. */
function parseRules(rows: unknown[]): ReturnRule[] {
  const names = VEHICLE_TYPE_NAMES as readonly string[];
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const metres = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const rules: ReturnRule[] = [];
  for (const row of rows) {
    const rule = row as Record<string, unknown>;
    if (!rule || typeof rule.id !== 'string' || !EFFECTS.includes(rule.effect as Effect)) continue;
    rules.push({
      id: rule.id,
      name: typeof rule.name === 'string' ? rule.name : rule.id,
      effect: rule.effect as Effect,
      types: strings(rule.appliesTo)
        .map((name) => names.indexOf(name))
        .filter((type) => type >= 0),
      layers: strings(rule.layers),
      official: strings(rule.official),
      radiusM: metres(rule.radiusM),
      bufferM: metres(rule.bufferM),
      exceptNearDoors: rule.exceptNearDoors === true,
      spots: typeof rule.spots === 'string' ? rule.spots : null,
      ridingBanned: rule.ridingBanned === true,
      evidence: typeof rule.evidence === 'string' ? rule.evidence : '',
    });
  }
  return rules;
}

/**
 * Reads the rule file without turning its 5 MB of packed columns into JavaScript strings: the
 * head (version, builtAt, meta) goes through JSON.parse, and each layer's flat object is scanned
 * from the bytes, its packed columns kept as byte ranges (§20.4, worker memory). Throws on any
 * shape the builder does not write, and the caller falls back to JSON.parse.
 */
export function scanReturnRules(bytes: Uint8Array): unknown {
  const text = (from: number, to: number) => Buffer.from(bytes.subarray(from, to)).toString();
  const marker = Buffer.from(',"layers":{');
  const at = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf(marker);
  if (at < 0) throw new Error('return-rules-no-layers');
  const head = JSON.parse(`${text(0, at)}}`) as Record<string, unknown>;
  const QUOTE = 34,
    COLON = 58,
    COMMA = 44,
    OPEN = 123,
    CLOSE = 125;
  let index = at + marker.length;
  const expect = (code: number) => {
    if (bytes[index++] !== code) throw new Error('return-rules-unexpected');
  };
  const string = () => {
    expect(QUOTE);
    const from = index;
    while (bytes[index] !== QUOTE) {
      if (bytes[index] === 92 || index >= bytes.length) throw new Error('return-rules-escape');
      index++;
    }
    return [from, index++] as const;
  };
  const layers: Record<string, RawLayer> = {};
  while (bytes[index] !== CLOSE) {
    const [nameFrom, nameTo] = string();
    expect(COLON);
    expect(OPEN);
    const layer: Record<string, unknown> = {};
    while (bytes[index] !== CLOSE) {
      const [keyFrom, keyTo] = string();
      expect(COLON);
      if (bytes[index] === QUOTE) {
        const [from, to] = string();
        layer[text(keyFrom, keyTo)] = to - from > 64 ? bytes.subarray(from, to) : text(from, to);
      } else {
        const from = index;
        while (bytes[index] !== COMMA && bytes[index] !== CLOSE) index++;
        layer[text(keyFrom, keyTo)] = Number(text(from, index));
      }
      if (bytes[index] === COMMA) index++;
    }
    index++;
    layers[text(nameFrom, nameTo)] = layer;
    if (bytes[index] === COMMA) index++;
  }
  return { ...head, layers };
}

let bundledRules: ReturnRules | null = null;

/** The bundled rule table; a missing or malformed file leaves only the official buffers (§20.3). */
export function bundledReturnRules(): ReturnRules {
  if (!bundledRules) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = readFileSync(dataFile('shared-mobility-return-rules-v1.json'));
      bundledRules = new ReturnRules(scanReturnRules(bytes));
    } catch {
      try {
        bundledRules = new ReturnRules(bytes ? JSON.parse(Buffer.from(bytes).toString()) : null);
      } catch {
        bundledRules = new ReturnRules(null);
      }
    }
  }
  return bundledRules;
}
