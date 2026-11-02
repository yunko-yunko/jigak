import type { MobilityPreferences, SegmentMode } from '../../shared/domain/index.js';
import {
  RENTAL_MODES,
  type RentalAvailability,
  type RentalAvailabilityEntry,
  type RentalMode,
} from '../../shared/intelligence/rentalAvailability.js';

export interface RentalAvailabilityInput {
  preferences: MobilityPreferences;
  /** Returned candidate routes, including candidates excluded by unrelated timing/risk rules. */
  routes: readonly {
    segments: readonly {
      mode: SegmentMode;
    }[];
  }[];
  capabilities: {
    bicycleFeed: boolean;
    scooterFeed: boolean;
    ebikeFeed: boolean;
    bicycleRouter: boolean;
    scooterRouter: boolean;
    ebikeRouter: boolean;
    scooterRentalPolicy: boolean;
    ebikeRentalPolicy: boolean;
  };
  diagnostics?: {
    failures?: readonly {
      mode: string;
      code: string;
    }[];
    limitReached?: boolean;
    budgetSkipped?: number;
    candidateLimitSkipped?: number;
    /** Per rental kind: candidates, devices and calls left out for that kind. When given it replaces the aggregate
     * limit, budget and candidate signals, so one kind's omitted devices never mark another kind search-limited. */
    candidateLimitSkippedByMode?: Partial<Record<RentalMode, number>>;
    /** Per rental kind: rentals to the destination refused because no legal return spot lies
     * within a walk of it. */
    returnBlockedByMode?: Partial<Record<RentalMode, number>>;
  };
  /** Mode-specific missing inventory evidence; aggregate rental failure counts cannot identify it. */
  unavailableSupply?: readonly RentalMode[];
}

/** Dockless kinds need an operator policy; 따릉이 is a docked station hire with its own proof. */
const DOCKLESS: ReadonlySet<RentalMode> = new Set(['scooter', 'ebike']);

/** Explain this search's evidence without treating configured credentials as a live integration. */
export function rentalAvailabilityForSearch(input: RentalAvailabilityInput): RentalAvailability {
  const { preferences, capabilities, diagnostics } = input;

  const feed = {
    bicycle: capabilities.bicycleFeed,
    ebike: capabilities.ebikeFeed,
    scooter: capabilities.scooterFeed,
  };
  const router = {
    bicycle: capabilities.bicycleRouter,
    ebike: capabilities.ebikeRouter,
    scooter: capabilities.scooterRouter,
  };
  const policy = {
    ebike: capabilities.ebikeRentalPolicy,
    scooter: capabilities.scooterRentalPolicy,
  };
  const allowed = {
    bicycle: preferences.allowBicycle,
    ebike: preferences.allowEbike !== false,
    scooter: preferences.allowScooter !== false,
  };

  const entry = (mode: RentalMode): RentalAvailabilityEntry => {
    if (preferences.walkingOnly) {
      return {
        status: 'excluded',
        reason: 'walking-only',
      };
    }

    if (!allowed[mode]) {
      return {
        status: 'excluded',
        reason: 'disabled',
      };
    }

    // Kick-scooters need a 원동기장치자전거 licence; only an explicit false withholds them.
    if (mode === 'scooter' && preferences.hasScooterLicense === false) {
      return {
        status: 'not-found',
        reason: 'license-unconfirmed',
      };
    }

    if (mode === 'bicycle' && !preferences.bicycleReady) {
      return {
        status: 'excluded',
        reason: 'bicycle-not-ready',
      };
    }

    if (!router[mode]) {
      return {
        status: 'unavailable',
        reason: 'unconfigured-router',
      };
    }

    if (DOCKLESS.has(mode) && !policy[mode as 'ebike' | 'scooter']) {
      return {
        status: 'unavailable',
        reason: 'unconfigured-rental-policy',
      };
    }

    if (!feed[mode]) {
      return {
        status: 'unavailable',
        reason: 'unconfigured-feed',
      };
    }

    if (input.routes.some((route) => route.segments.some((segment) => segment.mode === mode))) {
      return {
        status: 'included',
        reason: null,
      };
    }

    if (
      diagnostics?.failures?.some(
        (failure) => failure.mode === mode && failure.code !== 'NO_ROUTES',
      )
    ) {
      return {
        status: 'unavailable',
        reason: 'provider-failure',
      };
    }

    if (
      diagnostics?.candidateLimitSkippedByMode
        ? (diagnostics.candidateLimitSkippedByMode[mode] ?? 0) > 0
        : diagnostics?.limitReached ||
          (diagnostics?.budgetSkipped ?? 0) > 0 ||
          (diagnostics?.candidateLimitSkipped ?? 0) > 0
    ) {
      return {
        status: 'not-found',
        reason: 'search-limited',
      };
    }

    // Every ride of this kind would have to end where it may not be parked, or too far to walk on.
    if ((diagnostics?.returnBlockedByMode?.[mode] ?? 0) > 0) {
      return {
        status: 'not-found',
        reason: 'no-legal-return',
      };
    }

    if (input.unavailableSupply?.includes(mode)) {
      return {
        status: 'unavailable',
        reason: 'supply-unavailable',
      };
    }

    return {
      status: 'not-found',
      reason: 'no-route',
    };
  };

  return Object.fromEntries(RENTAL_MODES.map((mode) => [mode, entry(mode)])) as RentalAvailability;
}
