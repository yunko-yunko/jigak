export interface Place {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  note?: string;
}

export interface DurationRange {
  min: number;
  max: number;
}

export interface TimeRange {
  earliest: number;
  latest: number;
}

export interface MobilityPreferences {
  /** Exclude running, bicycles and every vehicle route; omitted keeps legacy behavior. */
  walkingOnly?: boolean;
  allowRunning: boolean;
  allowBicycle: boolean;
  maxRunningMeters: number;
  maxBicycleMeters: number;
  runningPace: 'easy' | 'steady';
  preparationSeconds: number;
  bicycleReady: boolean;
  /** Taxi legs (door to door, or first/last mile around transit); omitted means allowed. */
  allowTaxi?: boolean;
  /** Shared e-scooters for first/last mile; omitted means allowed. */
  allowScooter?: boolean;
  /** The rider has their own car: it may start the trip and is left at a public parking lot. */
  hasCar?: boolean;
  /** User-confirmed parking position of their own car; ownership never implies it is at the origin. */
  carLocation?: Place;
}

export type PlanningPurpose = 'search' | 'urgent' | 'replan';

export interface PlanningRequest {
  originId: string;
  destinationId: string;
  deadline: number;
  now: number;
  preferences: MobilityPreferences;
  /** Urgent search retains an already elapsed deadline instead of moving it forward. */
  purpose?: PlanningPurpose;
  /** Keep the first search's anchor when refreshing. Demo timetables do not move with now. */
  scheduleAnchorAt?: number;
  /** Departures at or before this time are unavailable after a missed-vehicle report. */
  missedDepartureAt?: number;
  /** The rider set no arrival time; `deadline` is only a planning horizon and margins are not shown. */
  flexibleDeadline?: boolean;
}

export interface BasePlanningRequest {
  origin: Place;
  destination: Place;
  deadline: number;
  now: number;
  preferences: MobilityPreferences;
  purpose?: PlanningPurpose;
}

export interface Provenance {
  mode: 'demo' | 'live';
  provider: string;
  label: string;
  /** Provider generation time, or the demo scenario anchor. Null means not supplied. */
  sourceTimestamp: number | null;
  receivedAt: number;
  isRealtime: boolean;
}

export type SegmentMode =
  | 'walk'
  | 'run'
  | 'entry'
  | 'wait'
  | 'bus'
  | 'subway'
  | 'hire'
  | 'bicycle'
  | 'return'
  | 'taxi'
  | 'car'
  | 'scooter';

export interface Connection {
  departureAt: number;
  fallbackDepartureAt?: number;
  fallbackArrivalAt?: number;
  status: 'comfortable' | 'borderline' | 'missed';
  boardingMarginSeconds: number;
  explanation: string;
}

export interface ScheduledConnection extends Connection {
  trainNo: string;
  trainArrivalAt: number;
  latestTrainNo: string;
  latestTrainArrivalAt: number;
}

/** Provider line and stop names for one bus/subway step; boarding stop first. */
export interface TransitDetails {
  lines: string[];
  stops: string[];
  vehicleTypes?: string[];
}

export interface ArrivalPrediction {
  line: string;
  /** Predicted arrival at the boarding stop, epoch milliseconds. */
  arrivesAt: number;
  destination?: string;
  stopsAway?: number;
  /** Short provider message such as "3분 12초 후 [2번째 전]". */
  message: string;
  express?: boolean;
  lastService?: boolean;
}

/** Live arrival predictions for one boarding stop, already filtered to the step's lines and direction. */
export interface BoardingRealtime {
  provider: 'seoul-subway' | 'seoul-bus' | 'tago-bus';
  stopName: string;
  status: 'live' | 'no-service';
  /** Provider observation time when supplied, otherwise the server receipt time. */
  observedAt: number;
  receivedAt: number;
  predictions: ArrivalPrediction[];
}

/** Published train pattern for the currently queried service day, not a live arrival or reservation. */
export interface SubwayTimetable {
  provider: 'seoul-metro-timetable';
  serviceDate: string;
  dayType: 'weekday' | 'saturday' | 'holiday';
  receivedAt: number;
  validFrom: number;
  validUntil: number;
  calendarSource: string;
  line: string;
  boardingStation: string;
  nextStation: string;
  alightingStation: string;
  /** Both directions and all rows were fetched; only trains calling at all three stations remain. */
  complete: true;
  departures: {
    departureAt: number;
    arrivalAt: number;
    trainNo: string;
    direction: '1' | '2';
    destination: string;
  }[];
}

export interface ScheduleCheck {
  provider: 'seoul-metro-timetable';
  checkedAt: number;
  status: 'published' | 'unverified';
  reason?:
    | 'unconfigured'
    | 'unsupported'
    | 'calendar-unverified'
    | 'unavailable'
    | 'incomplete'
    | 'budget';
}

/** Live road congestion over polyline vertices [from, to] of a car or taxi leg. */
export type TrafficLevel = 'free' | 'slow' | 'delay' | 'jam' | 'blocked' | 'unknown';

export interface TrafficSpan {
  from: number;
  to: number;
  level: TrafficLevel;
}

/** One road link with its live speed; `path` runs in the direction of travel as [longitude, latitude]. */
export interface RoadTrafficLink {
  id: string;
  name: string;
  level: Exclude<TrafficLevel, 'unknown'>;
  speedKmh: number;
  path: [number, number][];
}

/** An accident, roadwork, rally or closure reported on the road network. */
export interface RoadIncident {
  id: string;
  kind: string;
  detail: string;
  latitude: number;
  longitude: number;
  startedAt: number | null;
  clearsAt: number | null;
}

/** Live congestion laid over the road legs of a route being followed, keyed by segment id. */
export interface RouteLiveTraffic {
  legs: Record<
    string,
    {
      spans: TrafficSpan[];
      delaySeconds: number;
    }
  >;
  incidents: RoadIncident[];
  observedAt: number | null;
}

/** One provider turn-by-turn instruction; the point is where the instruction begins. */
export interface Maneuver {
  latitude: number;
  longitude: number;
  instruction: string;
  distanceMeters: number;
}

export interface ParkingAccess {
  publicAccess: true;
  provider: string;
  operating: 'open' | 'closed' | 'unknown';
  occupancy: 'available' | 'full' | 'unknown';
  fee: 'free' | 'paid' | 'unknown';
  verifiedAt: number | null;
  occupancyObservedAt?: number | null;
  availableSpaces?: number | null;
  /** Known base price and its time unit. Full stay price depends on the actual parking duration. */
  baseFeeWon?: number;
  baseMinutes?: number;
}

export interface BaseSegment {
  id: string;
  mode: SegmentMode;
  title: string;
  instructions: string;
  distanceMeters: number;
  durationSeconds: DurationRange;
  start: Place;
  end: Place;
  /** Set only for a reviewed outdoor path, never for an unknown station interior. */
  runAllowed: boolean;
  polyline?: {
    latitude: number;
    longitude: number;
  }[];
  lineName?: string;
  direction?: string;
  walkingDurationSeconds?: DurationRange;
  transit?: TransitDetails;
  realtime?: BoardingRealtime;
  timetable?: SubwayTimetable;
  scheduleCheck?: ScheduleCheck;
  /** A published timetable connection stays distinct from observed vehicle predictions. */
  scheduledConnection?: ScheduledConnection;
  maneuvers?: Maneuver[];
  /** Expected fare of this leg alone (taxi), in won. */
  costWon?: number;
  traffic?: TrafficSpan[];
  /** Seconds of `durationSeconds` added for congestion on this leg's roads when the route was planned. */
  roadDelaySeconds?: number;
  /** Explicit uncertainty already included once in durationSeconds.max, before connection selection. */
  planningBuffer?: {
    weatherSeconds: number;
    calibrationSeconds: number;
  };
  /** Context model replaces weather/legacy timing once; source duration remains auditable. */
  etaPrediction?: {
    modelVersion: 'eta-context-v2';
    evaluatedAt: number;
    sourceDurationSeconds: DurationRange;
    /** Saved source allowances retain their risk-only meaning when prediction is refused. */
    sourcePlanningBuffer?: {
      weatherSeconds: number;
      calibrationSeconds: number;
    };
    features: import('../intelligence/learning.js').EtaLearningFeatures;
    medianSeconds: number;
    lowerSeconds: number;
    upperSeconds: number;
  };
  /** Separately validated public bus tags; preserves the provider baseline and live-road allowance. */
  publicEtaPrediction?: {
    modelVersion: 'public-bus-duration-v2';
    target: 'bus-tag-elapsed';
    policy: 'conservative-envelope';
    evaluatedAt: number;
    boardingAt: number;
    sourceDurationSeconds: DurationRange;
    lowerSeconds: number;
    medianSeconds: number;
    upperSeconds: number;
  };
  /** Source of this leg's routed geometry/time, independent of a vehicle arrival observation. */
  routingSource?: Provenance;
  /** Provider-reported offsets between requested points and its pedestrian network. No fabricated geometry. */
  networkSnap?: {
    startMeters: number;
    endMeters: number;
    allowanceSeconds: number;
  };
  /** Required for live own-car legs: the drive ends at a generally accessible car park. */
  parkingAccess?: ParkingAccess;
  /** The provider explicitly routed this riding network; never inferred from a walking path. */
  routingProfile?: 'bicycle' | 'scooter';
  /** Operator permission bound to the specific device and checked through its planned return. */
  rentalValidity?: {
    verifiedAt: number;
    validUntil: number;
    vehicleId: string;
    provider: string;
  };
  /** Seoul's current station query, not a reservation or an operator unlock permission. Recheck before pickup. */
  bicycleAvailability?: {
    source: 'seoul-bike';
    hireStationId: string;
    returnStationId: string;
    availableBikes: number;
    receivedAt: number;
    observedAt: number | null;
    returnPolicy: 'designated-station';
  };
  /** The app's original average headway allowance, before a graph recalculates this wait. */
  expectedWaitBasisSeconds?: number;
  /** Included headway envelope across uncertain station access; remove it before re-evaluation. */
  expectedWaitBasisRangeSeconds?: DurationRange;
  /** Internal server handoff: already evaluated against this graph path's arrival at the stop. */
  plannedConnection?: Connection;
  /** Internal server rule evaluated at the actual downstream pickup time. */
  timingRule?: 'taxi-dispatch';
}

export interface Segment extends BaseSegment {
  timeRange: TimeRange;
  provenance: Provenance;
  connection?: Connection;
}

export interface Risk {
  code:
    | 'demo-data'
    | 'borderline-boarding'
    | 'bicycle-stock'
    | 'destination-entry'
    | 'unverified-schedule'
    | 'missing-source-time'
    | 'unverified-duration-range'
    | 'vehicle-availability'
    | 'parking';
  severity: 'info' | 'warning';
  title: string;
  description: string;
  segmentId?: string;
}

export interface Route {
  id: string;
  title: string;
  segments: Segment[];
  origin: Place;
  destination: Place;
  arrivalTime: TimeRange;
  /** Arrival including the user's destination preparation buffer. */
  readyTime: TimeRange;
  durationSeconds: DurationRange;
  marginSeconds: DurationRange;
  runningMeters: number;
  bicycleMeters: number;
  bicycleRentals: number;
  transfers: number;
  fareWon?: number;
  risks: Risk[];
  reasons: string[];
  status: 'on-time' | 'uncertain' | 'late';
  provenance: Provenance;
  recommended: boolean;
  landingUrl?: string;
  /** Signed coordinate-free baseline receipt; no observations are stored until consented submission. */
  learningTicket?: string;
  learningWholeJourney?: true;
  /** Full-journey risk remains separate from physical leg clocks and observed connections. */
  journeyEta?: import('../intelligence/journeyRisk.js').JourneyRiskMetadata;
}

export interface BaseRoute {
  id: string;
  title: string;
  durationSeconds: DurationRange;
  distanceMeters: number;
  transfers: number;
  fareWon?: number;
  segments: BaseSegment[];
  landingUrl?: string;
  /** Candidate-specific caveats, e.g. scooter availability or parking fees. */
  notes?: Risk[];
  /** Internal graph timing anchor; consume only when it equals the planner's trusted now. */
  timingEvaluatedAt?: number;
}

export interface PlanningResult {
  routes: Route[];
  generatedAt: number;
  scheduleAnchorAt: number;
  provenance: Provenance;
  allLate: boolean;
  notice: string;
  intelligence?: import('../intelligence/types.js').ArrivalIntelligence;
  rentalAvailability?: import('../intelligence/rentalAvailability.js').RentalAvailability;
}

export type SearchResult = PlanningResult;

export type ReplanReason = 'missed-vehicle' | 'no-bicycle' | 'walking-only';

export class PlanningError extends Error {
  constructor(
    public readonly code:
      'INVALID_INPUT' | 'UNSUPPORTED_PAIR' | 'NO_DEMO_SERVICE' | 'ACTIVE_VEHICLE',
    message: string,
  ) {
    super(message);

    this.name = 'PlanningError';
  }
}
