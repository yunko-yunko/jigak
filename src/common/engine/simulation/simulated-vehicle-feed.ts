import type { MobilityKind, MobilityMarker } from '../../shared/intelligence/types.js';
import {
  MAX_MARKERS_PER_GROUP,
  type VehicleFeed,
  type VehicleFeedQuery,
} from '../realtime/mobility.js';
import { VEHICLE_TYPE_NAMES, type VehicleTypeName } from './sim-codes.js';
import {
  SIMULATION_LABELS,
  SIMULATION_NOTICE,
  SIMULATION_PROVIDER,
  simulatedNouns,
  type SharedScooterSimulation,
} from './shared-scooter-sim.js';

/**
 * Bounds one read per vehicle type, nearest first, so a dense fleet of one type cannot crowd the
 * other out: the map's per-kind limit unless the caller asks for another (the router reads 600).
 */
const MAX_MARKERS_PER_TYPE = MAX_MARKERS_PER_GROUP;

/** The map kind of each simulated type (§19). */
export const MARKER_KIND: Readonly<Record<VehicleTypeName, MobilityKind>> = {
  'kick-scooter': 'kick-scooter',
  'e-bike': 'e-bicycle',
};

/**
 * The simulator read like an operator's GBFS feed. Only rentable, visible vehicles become
 * markers (§15.5); every marker says it is simulated and which type it is. While the day's window
 * is still being computed there are none, and routes are found without the simulator.
 */
export class SimulatedVehicleFeed implements VehicleFeed {
  readonly provider: string;
  readonly lastFailure = null;
  readonly simulated = true;
  /** Only the enabled types: this is what makes routing offer e-bikes at all. */
  readonly kinds: readonly MobilityKind[];
  readonly notice: string;
  private readonly now: () => number;

  constructor(
    private readonly simulation: SharedScooterSimulation,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    const types = simulation.vehicleTypes;
    const nouns = simulatedNouns(simulation.fleets);
    this.kinds = types.map((type) => MARKER_KIND[type]);
    this.provider = `시연용 가상 ${nouns}`;
    this.notice = `${SIMULATION_NOTICE} · 따릉이 이용 패턴으로 움직이는 가상 ${nouns}예요. 실제 운영사 기기가 아니에요.`;
  }

  /** True while the day's window is still being computed (§22): the map says so instead of "none". */
  get pending(): boolean {
    return !this.simulation.isReady(this.now());
  }

  async nearby(
    point: { latitude: number; longitude: number },
    radiusMeters: number,
    options: VehicleFeedQuery = {},
  ): Promise<MobilityMarker[]> {
    const now = this.now();
    const limit = options.perKind ?? MAX_MARKERS_PER_TYPE;
    const taken: Partial<Record<VehicleTypeName, number>> = {};
    const counts: number[] = [];
    const vehicles = this.simulation.nearby(
      point,
      radiusMeters,
      now,
      'rentable',
      options.totals ? { perType: limit, totals: counts } : { perType: limit },
    );
    if (options.totals)
      VEHICLE_TYPE_NAMES.forEach((type, index) => {
        const kind = MARKER_KIND[type];
        if (this.kinds.includes(kind)) options.totals![kind] = counts[index] ?? 0;
      });
    return vehicles
      .filter((vehicle) => {
        if (options.kind && MARKER_KIND[vehicle.type] !== options.kind) return false;
        const count = taken[vehicle.type] ?? 0;
        taken[vehicle.type] = count + 1;
        return count < limit;
      })
      .map((vehicle) => ({
        id: `gbfs:${SIMULATION_PROVIDER}:${vehicle.id}`,
        sourceId: vehicle.id,
        provider: SIMULATION_LABELS[vehicle.type],
        name: SIMULATION_LABELS[vehicle.type],
        kind: MARKER_KIND[vehicle.type],
        entity: 'vehicle' as const,
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        distanceMeters: Math.round(vehicle.distanceMeters),
        available: true,
        availableCount: 1,
        batteryPercent: vehicle.battery,
        observedAt: now,
        receivedAt: now,
        freshness: 'fresh' as const,
        source: 'gbfs' as const,
        returnPolicy: 'unverified' as const,
        simulated: true as const,
      }));
  }
}
