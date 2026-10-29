export type TimingComponentKind =
  | 'access'
  | 'ride'
  | 'wait'
  | 'platform'
  | 'dispatch'
  | 'hire'
  | 'return'
  | 'parking'
  | 'preparation';

export type TimingBasis =
  'provider-estimate' | 'live-arrival' | 'rule-estimate' | 'learned-estimate' | 'demo';

export interface TimingComponent {
  segmentId: string;
  kind: TimingComponentKind;
  seconds: {
    min: number;
    max: number;
  };
  basis: TimingBasis;
  label: string;
  sourceLabel: string;
  observedAt: number | null;
  /** Informational part of seconds, never an additional duration to sum. */
  includedRoadDelaySeconds?: number;
}

export interface RouteTimingSummary {
  routeId: string;
  /** Authoritative route chronology plus preparation; correlated component bounds do not independently sum. */
  totalSeconds: {
    min: number;
    max: number;
  };
  components: TimingComponent[];
  unavailableFactors: ('live-signal' | 'bus-stop-dwell')[];
  notes: string[];
}
