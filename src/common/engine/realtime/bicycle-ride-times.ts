import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

export const BICYCLE_RIDE_TIMES_VERSION = 'ddareungi-dock-pair-v1';
/** Fewer trips than this say more about one rider than about the pair. */
export const MIN_MEASURED_TRIPS = 8;

/** `pairs["ST-946>ST-438"] = [trips, p25, median, p75]` in seconds, unlock to lock. */
export interface BicycleRideTimesFile {
  version: typeof BICYCLE_RIDE_TIMES_VERSION;
  source: 'seoul-ddareungi-rental';
  minTrips: number;
  firstRentalAt: number;
  lastRentalAt: number;
  rentals: number;
  pairs: Record<string, [number, number, number, number]>;
}

export interface MeasuredRide {
  trips: number;
  lowerSeconds: number;
  medianSeconds: number;
  upperSeconds: number;
  firstRentalAt: number;
  lastRentalAt: number;
}

const fileSchema = z.object({
  version: z.literal(BICYCLE_RIDE_TIMES_VERSION),
  source: z.literal('seoul-ddareungi-rental'),
  minTrips: z.number().int().min(1),
  firstRentalAt: z.number().finite(),
  lastRentalAt: z.number().finite(),
  rentals: z.number().int().min(0),
  pairs: z.record(
    z.string().regex(/^[^>]+>[^>]+$/),
    z.tuple([
      z.number().int().min(1),
      z.number().positive(),
      z.number().positive(),
      z.number().positive(),
    ]),
  ),
});

/** Leisure loops stretch the upper quartile; past this the slow tail is a stop, not the ride. */
const MAX_UPPER_RATIO = 1.6;

/**
 * Dock-to-dock ride times measured on Seoul's own rentals. A network router guesses from road
 * classes and can push a bike through a station concourse; riders who made the trip did not.
 */
export class MeasuredBicycleRides {
  private constructor(private readonly file: BicycleRideTimesFile) {}

  static fromFile(path: string | undefined): MeasuredBicycleRides | null {
    if (!path || !existsSync(path)) return null;
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) throw new Error(`따릉이 실측 이동시간 파일 형식이 맞지 않아요: ${path}`);
    return new MeasuredBicycleRides(parsed.data as BicycleRideTimesFile);
  }

  static fromData(file: BicycleRideTimesFile): MeasuredBicycleRides {
    return new MeasuredBicycleRides(file);
  }

  get pairCount(): number {
    return Object.keys(this.file.pairs).length;
  }

  /** Station ids as the live feed and the rental records both write them, e.g. `ST-946`. */
  ride(hireStationId: string, returnStationId: string): MeasuredRide | null {
    const entry = this.file.pairs[`${hireStationId}>${returnStationId}`];
    if (!entry || entry[0] < this.file.minTrips) return null;
    const [trips, lower, median, upper] = entry;
    return {
      trips,
      lowerSeconds: lower,
      medianSeconds: median,
      upperSeconds: Math.min(upper, Math.round(median * MAX_UPPER_RATIO)),
      firstRentalAt: this.file.firstRentalAt,
      lastRentalAt: this.file.lastRentalAt,
    };
  }
}
