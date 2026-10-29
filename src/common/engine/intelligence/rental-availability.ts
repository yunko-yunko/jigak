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
    bicycleRouter: boolean;
    scooterRouter: boolean;
    scooterRentalPolicy: boolean;
  };
  diagnostics?: {
    failures?: readonly {
      mode: string;
      code: string;
    }[];
    limitReached?: boolean;
    budgetSkipped?: number;
    candidateLimitSkipped?: number;
  };
  /** Mode-specific missing inventory evidence; aggregate rental failure counts cannot identify it. */
  unavailableSupply?: readonly RentalMode[];
}

/** Explain this search's evidence without treating configured credentials as a live integration. */
export function rentalAvailabilityForSearch(input: RentalAvailabilityInput): RentalAvailability {
  const { preferences, capabilities, diagnostics } = input;

  const entry = (mode: RentalMode): RentalAvailabilityEntry => {
    if (preferences.walkingOnly) {
      return {
        status: 'excluded',
        reason: 'walking-only',
      };
    }

    if (mode === 'bicycle' ? !preferences.allowBicycle : preferences.allowScooter === false) {
      return {
        status: 'excluded',
        reason: 'disabled',
      };
    }

    if (mode === 'bicycle' && !preferences.bicycleReady) {
      return {
        status: 'excluded',
        reason: 'bicycle-not-ready',
      };
    }

    if (!(mode === 'bicycle' ? capabilities.bicycleRouter : capabilities.scooterRouter)) {
      return {
        status: 'unavailable',
        reason: 'unconfigured-router',
      };
    }

    if (mode === 'scooter' && !capabilities.scooterRentalPolicy) {
      return {
        status: 'unavailable',
        reason: 'unconfigured-rental-policy',
      };
    }

    if (!(mode === 'bicycle' ? capabilities.bicycleFeed : capabilities.scooterFeed)) {
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
      diagnostics?.limitReached ||
      (diagnostics?.budgetSkipped ?? 0) > 0 ||
      (diagnostics?.candidateLimitSkipped ?? 0) > 0
    ) {
      return {
        status: 'not-found',
        reason: 'search-limited',
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
