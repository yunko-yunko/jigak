import type { MobilityKind, MobilityMarker } from '../../shared/intelligence/types.js';
import {
  asArray,
  FeedError,
  fetchFeedJson,
  finiteNumber,
  text,
  type FeedOptions,
} from '../realtime/http.js';
import { metersBetween } from '../realtime/names.js';

export interface GbfsFeedConfiguration {
  provider: string;
  /** Direct v2 free_bike_status or v3 vehicle_status URL from an authorized operator. */
  vehicleStatusUrl: string;
  /** Required if the feed contains mixed/unspecified vehicle types. */
  vehicleTypesUrl?: string;
  /** Explicit operator-documented fallback; never infer kind from a brand name. */
  kind?: MobilityKind;
}

const KINDS: Record<string, MobilityKind> = {
  bicycle: 'bicycle',
  cargo_bicycle: 'bicycle',
  scooter_standing: 'kick-scooter',
  scooter_seated: 'motor-scooter',
  moped: 'motor-scooter',
};

const stamp = (value: unknown): number | null => {
  const number = finiteNumber(value);

  if (number !== null && number > 0) {
    return number < 1e12 ? number * 1_000 : number;
  }

  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;

  return Number.isFinite(parsed) ? parsed : null;
};

const truthy = (value: unknown) => value === true || value === 1;

function officialUrl(value: string): URL {
  const url = new URL(value);

  // URLs are trusted server configuration, never request input. Still reject local targets.
  const host = url.hostname.toLowerCase();

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.startsWith('[') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  ) {
    throw new TypeError('GBFS requires an authorized public HTTPS hostname');
  }

  return url;
}

/** GBFS v2/v3 only. No scraping of operator apps or guessed device positions. */
export class GbfsVehicleFeed {
  readonly provider: string;
  private readonly url: URL;
  private readonly typesUrl: URL | null;
  private readonly now: () => number;
  private cache: {
    until: number;
    value: Promise<MobilityMarker[]>;
  } | null = null;
  lastFailure: FeedError['reason'] | null = null;

  constructor(
    private readonly configuration: GbfsFeedConfiguration,
    private readonly options: FeedOptions & {
      now?: () => number;
    } = {},
  ) {
    this.provider = configuration.provider.trim().slice(0, 80);

    if (!this.provider) {
      throw new TypeError('GBFS provider is required');
    }

    this.url = officialUrl(configuration.vehicleStatusUrl);
    this.typesUrl = configuration.vehicleTypesUrl
      ? officialUrl(configuration.vehicleTypesUrl)
      : null;
    this.now = options.now ?? Date.now;
  }

  private inventory(): Promise<MobilityMarker[]> {
    if (this.cache && this.cache.until > this.now()) {
      return this.cache.value;
    }

    const value = Promise.all([
      fetchFeedJson(this.url, this.options),
      this.typesUrl ? fetchFeedJson(this.typesUrl, this.options) : null,
    ])
      .then(([raw, typesRaw]) => {
        if (!raw || typeof raw !== 'object') {
          throw new FeedError('format');
        }

        const payload = raw as {
          last_updated?: unknown;
          data?: {
            vehicles?: unknown;
            bikes?: unknown;
          };
        };

        if (
          !payload.data ||
          (!Array.isArray(payload.data.vehicles) && !Array.isArray(payload.data.bikes))
        ) {
          throw new FeedError('format');
        }

        const typePayload = typesRaw as {
          data?: {
            vehicle_types?: unknown;
          };
        } | null;
        const kinds = new Map<string, MobilityKind>();

        for (const row of asArray<Record<string, unknown>>(typePayload?.data?.vehicle_types)) {
          const form = text(row.form_factor),
            power = text(row.propulsion_type);
          const kind = form === 'bicycle' && power !== 'human' ? 'e-bicycle' : KINDS[form];

          if (kind) {
            kinds.set(text(row.vehicle_type_id), kind);
          }
        }

        const receivedAt = this.now();

        const markers = asArray<Record<string, unknown>>(
          payload.data.vehicles ?? payload.data.bikes,
        ).flatMap((row) => {
          const id = text(row.vehicle_id ?? row.bike_id),
            latitude = finiteNumber(row.lat),
            longitude = finiteNumber(row.lon);
          const kind = kinds.get(text(row.vehicle_type_id)) ?? this.configuration.kind;

          if (
            !id ||
            !kind ||
            latitude === null ||
            longitude === null ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180 ||
            truthy(row.is_reserved) ||
            truthy(row.is_disabled)
          ) {
            return [];
          }

          const observedAt = stamp(row.last_reported) ?? stamp(payload.last_updated);
          const freshness =
            observedAt === null
              ? ('unknown' as const)
              : receivedAt - observedAt > 300_000 || observedAt > receivedAt + 60_000
                ? ('stale' as const)
                : ('fresh' as const);
          const fraction = finiteNumber(row.current_fuel_percent);
          const batteryPercent =
            fraction !== null && fraction >= 0 && fraction <= 1 ? Math.round(fraction * 100) : null;
          const available =
            freshness === 'fresh' &&
            (kind === 'bicycle' || (batteryPercent !== null && batteryPercent >= 20));

          return [
            {
              id: `gbfs:${this.provider}:${id}`,
              sourceId: id,
              provider: this.provider,
              name: this.provider,
              kind,
              entity: 'vehicle' as const,
              latitude,
              longitude,
              distanceMeters: 0,
              available,
              availableCount: available ? 1 : 0,
              batteryPercent,
              observedAt,
              receivedAt,
              freshness,
              source: 'gbfs' as const,
              returnPolicy: 'unverified' as const,
            },
          ];
        });

        this.lastFailure = null;

        return markers;
      })
      .catch((error) => {
        this.lastFailure = error instanceof FeedError ? error.reason : 'network';

        if (this.cache?.value === value) {
          this.cache.until = this.now() + 30_000;
        }

        return [];
      });

    this.cache = {
      until: this.now() + 30_000,
      value,
    };

    return value;
  }

  async nearby(
    point: {
      latitude: number;
      longitude: number;
    },
    radiusMeters: number,
  ): Promise<MobilityMarker[]> {
    const rows = await this.inventory();

    const now = this.now();

    return rows.flatMap((row) => {
      const distanceMeters = metersBetween(point, row);
      const stale = row.observedAt !== null && now - row.observedAt > 300_000;

      return distanceMeters <= radiusMeters
        ? [
            {
              ...row,
              distanceMeters: Math.round(distanceMeters),
              ...(stale
                ? {
                    freshness: 'stale' as const,
                    available: false,
                    availableCount: 0,
                  }
                : {}),
            },
          ]
        : [];
    });
  }
}
