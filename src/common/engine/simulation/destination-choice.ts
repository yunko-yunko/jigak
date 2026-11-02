import { ASSUMPTIONS } from './assumptions.js';
import { inHourBand, type DayType } from './calendar.js';
import type { Demand } from './demand.js';
import { metersApart } from './parking-rules.js';

/**
 * §22.10 where riders off the pair table end their trip: a ring at the drawn trip distance
 * around the origin dock, a dock in it by attraction × daily balance (a doubly constrained
 * gravity model with the distance kept as the trip-length draw). Built once per window, no
 * random draws.
 */
export interface DestinationChoice {
  /** Neighbours of each dock within `ringMaxMeters`, nearest first, as CSR: start[dock]..start[dock + 1]. */
  start: Int32Array;
  near: Int32Array;
  meters: Float32Array;
  /** Weight of a dock as a trip end at each hour (dock * 24 + hour): attraction × balance. */
  weight: Record<DayType, Float64Array>;
  /** The pair table's cumulative trips per origin (as `Demand.odCumulative`), each target × its balance. */
  odCumulative: Record<DayType, Float64Array>;
  /** The daily balancing factor of each dock. */
  balance: Record<DayType, Float64Array>;
  /** Expected Σ|arrivals − departures| / Σ departures over docks: [no balance, balanced]. */
  imbalance: Record<DayType, readonly [number, number]>;
}

const DAYS = ['weekday', 'weekend'] as const;

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7): deterministic and enough for distance quantiles. */
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Equal-probability trip distances (km) of the day's rider mix: each type's clipped log-normal
 * (§5.1) weighted by its share of the non-loop riders over the day's departures.
 */
export function ringQuantilesKm(
  departuresByHour: ArrayLike<number>,
  day: DayType,
  loopShare: number,
  count = ASSUMPTIONS.demand.ringQuantiles,
): number[] {
  const types = ASSUMPTIONS.riderTypes,
    sigma = ASSUMPTIONS.riderDistanceSigma;
  const share = new Float64Array(types.length);
  for (let hour = 0; hour < 24; hour++) {
    const band = ASSUMPTIONS.riderMix[day].find(([first, last]) => inHourBand(hour, first, last));
    const mix = band ? band[2] : [0.25, 0.25, 0.25, 0.25];
    for (let type = 0; type < types.length; type++)
      share[type] += mix[type] * departuresByHour[hour];
  }
  let total = 0;
  for (let type = 0; type < types.length; type++)
    total += share[type] *= 1 - Math.min(1, loopShare * types[type].loopFactor);
  const cdf = (km: number) => {
    let sum = 0;
    for (let type = 0; type < types.length; type++) {
      const spec = types[type];
      const below =
        km < spec.rangeKm[0]
          ? 0
          : km >= spec.rangeKm[1]
            ? 1
            : 0.5 * (1 + erf(Math.log(km / spec.medianKm) / (sigma * Math.SQRT2)));
      sum += share[type] * below;
    }
    return total > 0 ? sum / total : 0;
  };
  const low = Math.min(...types.map((type) => type.rangeKm[0])),
    high = Math.max(...types.map((type) => type.rangeKm[1]));
  return Array.from({ length: count }, (_, index) => {
    const p = (index + 0.5) / count;
    let a = low,
      b = high;
    for (let step = 0; step < 50; step++) {
      const middle = (a + b) / 2;
      if (cdf(middle) < p) a = middle;
      else b = middle;
    }
    return (a + b) / 2;
  });
}

function lowerBound(values: Float32Array, from: number, to: number, x: number) {
  let low = from,
    high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < x) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The ring of neighbours around `dock` at `meters` (half width `ringHalfWidth` of it, widened
 * `ringWiden`× up to `ringWidenings` times while empty) into out[0..1] as a CSR range; false
 * when every ring is empty.
 */
export function ringRange(
  choice: Pick<DestinationChoice, 'start' | 'meters'>,
  dock: number,
  meters: number,
  widening: number,
  out: Int32Array,
): boolean {
  const { ringHalfWidth, ringWiden } = ASSUMPTIONS.demand;
  const from = choice.start[dock],
    to = choice.start[dock + 1];
  const width = ringHalfWidth * Math.pow(ringWiden, widening);
  out[0] = lowerBound(choice.meters, from, to, meters * (1 - width));
  out[1] = lowerBound(choice.meters, out[0], to, meters * (1 + width));
  return out[1] > out[0];
}

/** Neighbour lists depend only on the dock table: one per table. */
const neighbourCache = new WeakMap<
  Demand,
  { maxMeters: number; start: Int32Array; near: Int32Array; meters: Float32Array }
>();

function neighbours(demand: Demand) {
  const maxMeters = ASSUMPTIONS.demand.ringMaxMeters;
  const cached = neighbourCache.get(demand);
  if (cached && cached.maxMeters === maxMeters) return cached;
  const count = demand.count,
    docks = demand.docks;
  // Sorted by (rounded distance, dock) through one numeric key per pair: 1/8 m steps, the dock
  // id in the low digits, so ties keep a fixed order.
  const radix = 1 << Math.max(1, Math.ceil(Math.log2(count + 1)));
  const keys = new Float64Array(count);
  const start = new Int32Array(count + 1);
  const lists: Float64Array[] = new Array(count);
  for (let origin = 0; origin < count; origin++) {
    const lat = docks[origin * 2],
      lon = docks[origin * 2 + 1];
    let size = 0;
    for (let dock = 0; dock < count; dock++) {
      if (dock === origin) continue;
      const meters = metersApart(lat, lon, docks[dock * 2], docks[dock * 2 + 1]);
      if (meters <= maxMeters) keys[size++] = Math.round(meters * 8) * radix + dock;
    }
    lists[origin] = keys.slice(0, size).sort();
    start[origin + 1] = start[origin] + size;
  }
  const near = new Int32Array(start[count]),
    meters = new Float32Array(start[count]);
  for (let origin = 0; origin < count; origin++) {
    const list = lists[origin],
      base = start[origin];
    for (let index = 0; index < list.length; index++) {
      const dock = list[index] % radix;
      near[base + index] = dock;
      meters[base + index] = (list[index] - dock) / radix / 8;
    }
  }
  const built = { maxMeters, start, near, meters };
  neighbourCache.set(demand, built);
  return built;
}

/** FNV-1a over the float bits: tells two windows' inputs apart for the cache. */
function fingerprint(arrays: readonly Float32Array[], extra: string) {
  let hash = 0x811c9dc5;
  for (const array of arrays) {
    const bits = new Uint32Array(array.buffer, array.byteOffset, array.length);
    for (let index = 0; index < bits.length; index++)
      hash = Math.imul(hash ^ bits[index], 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}|${extra}`;
}

const choiceCache = new WeakMap<Demand, Map<string, DestinationChoice>>();

/**
 * §22.10 builds the destination choice of a window: per day type, the attraction of each dock
 * as a trip end (`returnWeight` + `returnWeightFloor`) and a daily balancing factor B solved so
 * that, summed over the day, each dock receives about the riders it sends (the pair-table
 * branch included, its targets weighted by B too): B ← clip(B × (departures / arrivals)^b).
 */
export function buildDestinationChoice(
  demand: Demand,
  dockRate: readonly Record<DayType, Float32Array>[],
  returnWeight: Record<DayType, Float32Array>,
): DestinationChoice {
  const settings = ASSUMPTIONS.demand;
  const key = fingerprint(
    [
      ...dockRate.flatMap((rate) => [rate.weekday, rate.weekend]),
      returnWeight.weekday,
      returnWeight.weekend,
    ],
    JSON.stringify([
      settings.returnWeightFloor,
      settings.ringHalfWidth,
      settings.ringWiden,
      settings.ringWidenings,
      settings.ringQuantiles,
      settings.ringMaxMeters,
      settings.balanceIterations,
      settings.balanceExponent,
      settings.balanceClip,
      ASSUMPTIONS.riderTypes,
      ASSUMPTIONS.riderMix,
      ASSUMPTIONS.riderDistanceSigma,
    ]),
  );
  let cache = choiceCache.get(demand);
  const cached = cache?.get(key);
  if (cached) return cached;

  const { start, near, meters } = neighbours(demand);
  const count = demand.count;
  const { odStart, odTo, odCumulative, odShare } = demand;
  const [minBalance, maxBalance] = settings.balanceClip;
  const weight = {} as Record<DayType, Float64Array>,
    odWeighted = {} as Record<DayType, Float64Array>,
    balanceOf = {} as Record<DayType, Float64Array>,
    imbalance = {} as Record<DayType, readonly [number, number]>;
  const range = new Int32Array(2);
  for (const day of DAYS) {
    const returns = returnWeight[day];
    // Departures per dock over the day (season cancels) and the city's per hour.
    const departures = new Float64Array(count),
      byHour = new Float64Array(24);
    for (let dock = 0; dock < count; dock++)
      for (let hour = 0; hour < 24; hour++) {
        let rate = 0;
        for (const table of dockRate) rate += table[day][dock * 24 + hour];
        departures[dock] += rate;
        byHour[hour] += rate;
      }
    // A dock's attraction over the day, each hour by the city's departures then.
    const attraction = new Float64Array(count);
    for (let dock = 0; dock < count; dock++)
      for (let hour = 0; hour < 24; hour++)
        attraction[dock] += (returns[dock * 24 + hour] + settings.returnWeightFloor) * byHour[hour];
    const quantiles = ringQuantilesKm(byHour, day, demand.loopShare);
    // Each origin's ring at each distance quantile, widened as the riders' draw widens.
    const rings = new Int32Array(count * quantiles.length * 2).fill(-1);
    for (let origin = 0; origin < count; origin++)
      for (let q = 0; q < quantiles.length; q++)
        for (let widening = 0; widening < settings.ringWidenings; widening++)
          if (ringRange({ start, meters }, origin, quantiles[q] * 1000, widening, range)) {
            rings[(origin * quantiles.length + q) * 2] = range[0];
            rings[(origin * quantiles.length + q) * 2 + 1] = range[1];
            break;
          }
    const balance = new Float64Array(count).fill(1);
    const inflow = new Float64Array(count);
    let departed = 0;
    for (let dock = 0; dock < count; dock++) departed += departures[dock];
    const spread = () => {
      inflow.fill(0);
      for (let origin = 0; origin < count; origin++) {
        const out = departures[origin];
        if (out <= 0) continue;
        const from = odStart[origin],
          to = odStart[origin + 1];
        const pair = to > from ? Math.min(1, odShare[origin]) : 0;
        if (pair > 0) {
          let total = 0;
          for (let slot = from; slot < to; slot++)
            total +=
              (odCumulative[slot] - (slot > from ? odCumulative[slot - 1] : 0)) *
              balance[odTo[slot]];
          if (total > 0)
            for (let slot = from; slot < to; slot++)
              inflow[odTo[slot]] +=
                (out *
                  pair *
                  (odCumulative[slot] - (slot > from ? odCumulative[slot - 1] : 0)) *
                  balance[odTo[slot]]) /
                total;
        }
        const share = ((1 - pair) * out) / quantiles.length;
        for (let q = 0; q < quantiles.length; q++) {
          const lo = rings[(origin * quantiles.length + q) * 2],
            hi = rings[(origin * quantiles.length + q) * 2 + 1];
          if (lo < 0) continue;
          let total = 0;
          for (let k = lo; k < hi; k++) total += attraction[near[k]] * balance[near[k]];
          if (total <= 0) continue;
          for (let k = lo; k < hi; k++)
            inflow[near[k]] += (share * attraction[near[k]] * balance[near[k]]) / total;
        }
      }
      let gap = 0;
      for (let dock = 0; dock < count; dock++) gap += Math.abs(inflow[dock] - departures[dock]);
      return departed > 0 ? gap / departed : 0;
    };
    const before = spread();
    for (let iteration = 0; iteration < settings.balanceIterations; iteration++) {
      if (iteration > 0) spread();
      for (let dock = 0; dock < count; dock++)
        if (inflow[dock] > 0 && departures[dock] > 0)
          balance[dock] = Math.min(
            maxBalance,
            Math.max(
              minBalance,
              balance[dock] * Math.pow(departures[dock] / inflow[dock], settings.balanceExponent),
            ),
          );
    }
    imbalance[day] = [before, spread()];
    balanceOf[day] = balance;
    const table = new Float64Array(count * 24);
    for (let dock = 0; dock < count; dock++)
      for (let hour = 0; hour < 24; hour++)
        table[dock * 24 + hour] =
          (returns[dock * 24 + hour] + settings.returnWeightFloor) * balance[dock];
    weight[day] = table;
    const cumulative = new Float64Array(odCumulative.length);
    for (let origin = 0; origin < count; origin++) {
      let running = 0;
      for (let slot = odStart[origin]; slot < odStart[origin + 1]; slot++) {
        running +=
          (odCumulative[slot] - (slot > odStart[origin] ? odCumulative[slot - 1] : 0)) *
          balance[odTo[slot]];
        cumulative[slot] = running;
      }
    }
    odWeighted[day] = cumulative;
  }
  const built: DestinationChoice = {
    start,
    near,
    meters,
    weight,
    odCumulative: odWeighted,
    balance: balanceOf,
    imbalance,
  };
  if (!cache) choiceCache.set(demand, (cache = new Map()));
  // A few fleets per table (tests build several); the oldest goes first.
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(key, built);
  return built;
}
