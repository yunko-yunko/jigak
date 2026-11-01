/**
 * Keyed random numbers (common random numbers, §11.3). A draw is not taken from one long stream
 * but from a short stream named by what it is for: (purpose, a, b, c, d) as 32-bit integers.
 * The same rider, vehicle or task therefore gets the same numbers in every window that
 * simulates it, and no strings are built on hot paths.
 */
export const PURPOSE = {
  ARRIVALS: 1,
  RIDER: 2,
  ATTEMPT: 3,
  WEAR: 4,
  PARK: 5,
  TOW: 6,
  TASK: 7,
  GPS: 8,
  INIT: 9,
  CHOICE: 10,
  HIDE: 11,
  MISSING: 12,
  DEPOT: 13,
  FEED: 14,
} as const;

/**
 * Rider sub-streams, so a redrawn destination never shifts the parking or police draws. The
 * vehicle-type draws (PREFERENCE, ASSIST) are new streams, so a scooter-only run draws exactly
 * what it drew before e-bikes existed.
 */
export const RIDER_STREAM = {
  TRIP: 0,
  PARKING: 1,
  CONDUCT: 2,
  SPEED: 3,
  REFUSED: 4,
  /** Early-end jitter and snapping at the ride's end. */
  SPARE: 5,
  /** Which vehicle type the rider wants. */
  PREFERENCE: 6,
  /** Pedalling speed after an e-bike's assist cut-off. */
  ASSIST: 7,
  /** §22 where a return goes when every legal spot in reach is full (illegal overflow). */
  OVERFLOW: 8,
} as const;

/** murmur3 finalizer: a full-avalanche 32-bit mix. */
export function fmix32(value: number): number {
  let hash = value | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** xmur3 of a text, used once per simulation for its (seed, fleet). */
export function hashText(text: string): number {
  let hash = 1779033703 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^= hash >>> 16) >>> 0;
}

/** A 32-bit stream seed for the key tuple; every argument must be an integer. */
export function keyOf(seed: number, purpose: number, a = 0, b = 0, c = 0, d = 0): number {
  let hash = fmix32(seed ^ Math.imul(purpose, 0x9e3779b1));
  hash = fmix32(hash ^ Math.imul(a | 0, 0x85ebca6b));
  hash = fmix32((hash + Math.imul(b | 0, 0xc2b2ae35)) | 0);
  hash = fmix32(hash ^ Math.imul(c | 0, 0x27d4eb2f));
  hash = fmix32((hash + Math.imul(d | 0, 0x165667b1)) | 0);
  return hash;
}

/** One uniform draw for a key, for single yes/no decisions. */
export function keyedUniform(seed: number, purpose: number, a = 0, b = 0, c = 0, d = 0): number {
  return new Stream().reseed(keyOf(seed, purpose, a, b, c, d)).next();
}

/** mulberry32 generator. Its whole state is one 32-bit integer, so a stream can be parked. */
export class Stream {
  state = 0;

  reseed(key: number): this {
    this.state = key | 0;
    return this;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let value = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Standard normal by Box-Muller; the first draw is kept away from zero. */
  normal(): number {
    const first = 1 - this.next(),
      second = this.next();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }

  /** Exponential with the given rate (events per unit). */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** Erlang (gamma with integer shape) with the given mean. */
  erlang(shape: number, mean: number): number {
    let total = 0;
    for (let index = 0; index < shape; index++) total += this.exponential(shape / mean);
    return total;
  }

  /** Poisson count by Knuth's product method; rates stay far below where it loses precision. */
  poisson(rate: number): number {
    if (rate <= 0) return 0;
    if (rate > 60) return Math.max(0, Math.round(rate + Math.sqrt(rate) * this.normal()));
    const limit = Math.exp(-rate);
    let product = this.next(),
      count = 0;
    while (product > limit) {
      count++;
      product *= this.next();
    }
    return count;
  }

  /**
   * Index into a segment [from, to) of an array holding several cumulative tables back to back,
   * each restarting from zero (riders' type mix per hour, 따릉이 pairs per origin). Unlike
   * `weighted`, the segment's own last value is its total.
   */
  weightedSegment(cumulative: ArrayLike<number>, from: number, to: number): number {
    const target = this.next() * cumulative[to - 1];
    let low = from,
      high = to - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cumulative[middle] > target) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /** Index into one cumulative weight array (a single running total over the whole array). */
  weighted(cumulative: ArrayLike<number>, from = 0, to = cumulative.length): number {
    const base = from > 0 ? cumulative[from - 1] : 0;
    const target = base + this.next() * (cumulative[to - 1] - base);
    let low = from,
      high = to - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (cumulative[middle] > target) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}
