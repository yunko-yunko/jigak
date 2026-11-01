import type { RouteTimingSummary } from './timing.js';

/** Data contracts shared by the API and map. A station is never an individual bicycle. */
export type MobilityKind = 'bicycle' | 'e-bicycle' | 'kick-scooter' | 'motor-scooter';

export type DataFreshness = 'fresh' | 'stale' | 'unknown';

export interface MobilityMarker {
  id: string;
  sourceId: string;
  provider: string;
  kind: MobilityKind;
  entity: 'station' | 'vehicle';
  name: string;
  latitude: number;
  longitude: number;
  distanceMeters: number;
  available: boolean;
  availableCount: number;
  batteryPercent: number | null;
  /** Timestamp from the operator; null when the source does not provide one. */
  observedAt: number | null;
  /** Server retrieval time, explicitly distinct from operator observation time. */
  receivedAt: number;
  freshness: DataFreshness;
  source: 'seoul-bike' | 'tago-pm' | 'gbfs';
  /** For GBFS this records whether endpoint geofencing/return rules were verified. */
  returnPolicy: 'station' | 'unverified';
  /** Set when the server's demo simulator, not a real operator, produced this marker. */
  simulated?: true;
}

export interface MobilitySourceStatus {
  source: MobilityMarker['source'];
  configured: boolean;
  status: 'available' | 'empty' | 'uncovered' | 'unconfigured' | 'error';
  message: string;
}

export interface MobilitySnapshot {
  markers: MobilityMarker[];
  sources: MobilitySourceStatus[];
  generatedAt: number;
  radiusMeters: number;
  /** False means these markers do not cover every local operator or vehicle. */
  completeCoverage: false;
  /** How many of each kind are in the radius before the marker cap; absent from older servers. */
  totals?: Partial<Record<MobilityKind, number>>;
}

export interface WeatherSnapshot {
  source: 'kma-ultra-short';
  status: 'live' | 'stale' | 'unavailable' | 'unconfigured';
  latitude: number;
  longitude: number;
  /** Null outside the supported Korean observation grid. */
  grid: {
    x: number;
    y: number;
  } | null;
  temperatureC: number | null;
  precipitationMm: number | null;
  precipitationType: number | null;
  windMetersPerSecond: number | null;
  observedAt: number | null;
  receivedAt: number;
  message: string;
}

export interface ArrivalExplanation {
  code:
    | 'arrival'
    | 'weather'
    | 'transfer'
    | 'availability'
    | 'geometry'
    | 'parking'
    | 'source'
    | 'calibration'
    | 'cost';
  severity: 'info' | 'caution' | 'excluded';
  text: string;
  seconds?: number;
}

export interface ArrivalAssessment {
  routeId: string;
  eligible: boolean;
  confidence: 'high' | 'limited' | 'unavailable';
  predictedReadyAt: {
    earliest: number;
    latest: number;
  };
  /** A conservative planning bound, not a statistically calibrated probability. */
  conservativeSeconds: number;
  /** Point ETA from sequential departures. This is not a calibrated expectation. */
  estimatedSeconds?: number;
  estimatedReadyAt?: number;
  latenessSeconds: number;
  extraBufferSeconds: number;
  score: number;
  explanations: ArrivalExplanation[];
  timing?: RouteTimingSummary;
}

export interface ArrivalIntelligence {
  objective?: import('../domain/estimatedTiming.js').RoutingObjective;
  model: 'arrival-risk-v1';
  modelType: 'explainable-rules';
  /** True only when a persisted calibration has enough real observations. */
  calibrated: boolean;
  generatedAt: number;
  recommendationId: string | null;
  assessments: ArrivalAssessment[];
  weather: WeatherSnapshot | null;
  notice: string;
}
