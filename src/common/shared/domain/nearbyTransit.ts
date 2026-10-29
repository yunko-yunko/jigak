/** Live provider data for the map's nearby public-transport panel. */
export const NEARBY_TRANSIT_FRESH_MS = 90_000;

export interface NearbyTransitPoint {
  latitude: number;
  longitude: number;
}

export type NearbyTransitStatus =
  'available' | 'empty' | 'partial' | 'unconfigured' | 'error' | 'uncovered';

export interface NearbyTransitArrival {
  line: string;
  arrivesAt: number | null;
  stopsAway: number | null;
  message: string;
  destination?: string;
  lastService?: boolean;
  ended: boolean;
}

export interface NearbyTransitStop extends NearbyTransitPoint {
  id: string;
  name: string;
  address: string;
  /** Straight-line distance; not a measured walking route or walking ETA. */
  distanceMeters: number;
  status: 'available' | 'empty' | 'unconfigured' | 'error' | 'stale';
  /** Original feed observation/query anchor, retained through cache hits. */
  observedAt: number | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  arrivals: NearbyTransitArrival[];
}

export interface NearbyTransitGroup<T extends NearbyTransitStop = NearbyTransitStop> {
  status: NearbyTransitStatus;
  source: 'seoul-bus' | 'tago-bus' | 'seoul-subway';
  radiusMeters: number;
  observedAt: number | null;
  message: string;
  stops: T[];
}

export interface NearbyTransitSnapshot {
  mode: 'live';
  generatedAt: number;
  center: NearbyTransitPoint;
  bus: NearbyTransitGroup;
  subway: NearbyTransitGroup;
}
