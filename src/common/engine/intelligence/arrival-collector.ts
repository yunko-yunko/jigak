import { randomUUID } from 'node:crypto';
import type {
  EtaLearningFeatures,
  EtaLearningObservation,
} from '../../shared/intelligence/learning.js';
import type { WeatherSnapshot } from '../../shared/intelligence/types.js';
import { FeedError, finiteNumber, text } from '../realtime/http.js';
import { stationBaseName, subwayLineName } from '../realtime/names.js';

const MAX_SOURCE_AGE_MS = 120_000;
const MAX_WINDOW_MS = 300_000;
const MAX_VISITS = 512;
const PREDICTION_CODES = new Set(['0', '3', '4', '5', '99']);
const DIRECTIONS = new Set(['상행', '하행', '내선', '외선']);

/** Weather lookup locations only. None of these fields enter a stored observation. */
export const ARRIVAL_COLLECTION_STATIONS = {
  서울: {
    latitude: 37.5547,
    longitude: 126.9707,
  },
  강남: {
    latitude: 37.4981,
    longitude: 127.0276,
  },
  시청: {
    latitude: 37.5657,
    longitude: 126.977,
  },
} as const;

export type ArrivalCollectionStation = keyof typeof ARRIVAL_COLLECTION_STATIONS;

interface SourceEvent {
  identity: string;
  observedAt: number | null;
  status: 'prediction' | 'arrived' | 'departed' | 'unknown';
  countdown: number | null;
}

interface Visit {
  stamp: number;
  signature: string;
  terminal: boolean;
  groupId?: string;
  first?: {
    tripId: string;
    features: EtaLearningFeatures;
  };
}

export interface ArrivalCollectionInput {
  station: string;
  payload: unknown;
  receivedAt: number;
  weather?: WeatherSnapshot | null;
}

export interface ArrivalPredictionContext {
  version: 1;
  id: string;
  kind: 'unlabeled-context';
  source: 'arrival-prediction';
  features: EtaLearningFeatures;
}

/** Unlike the routing feed, collection accepts no future source clock, even within skew tolerance. */
function sourceClock(value: unknown, receivedAt: number): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);

  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute, second),
    date = new Date(local);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  const stamp = local - 9 * 3_600_000;

  return stamp > 0 && stamp <= receivedAt && receivedAt - stamp <= MAX_SOURCE_AGE_MS ? stamp : null;
}

function events({ payload, station, receivedAt }: ArrivalCollectionInput): SourceEvent[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt <= 0
  ) {
    throw new FeedError('format');
  }

  const record = payload as {
    errorMessage?: {
      code?: unknown;
    };
    code?: unknown;
    realtimeArrivalList?: unknown;
  };

  const code = text(record.errorMessage?.code ?? record.code);

  if (code === 'INFO-200') {
    return [];
  }

  if (code === 'INFO-100' || code === 'ERROR-337') {
    throw new FeedError('auth');
  }

  if (
    code !== 'INFO-000' ||
    !Array.isArray(record.realtimeArrivalList) ||
    record.realtimeArrivalList.length > 60
  ) {
    throw new FeedError('format');
  }

  const grouped = new Map<string, SourceEvent[]>();

  for (const raw of record.realtimeArrivalList) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const row = raw as Record<string, unknown>;
    const name = stationBaseName(text(row.statnNm)),
      line = text(row.subwayId),
      train = text(row.btrainNo);
    const direction = text(row.updnLine),
      towards = stationBaseName(
        text(row.trainLineNm)
          .match(/-\s*(.+?)방면\s*$/)?.[1]
          ?.trim() ?? '',
      );

    if (
      name !== stationBaseName(station) ||
      !subwayLineName(line) ||
      !/^[a-zA-Z0-9-]{1,24}$/.test(train) ||
      !DIRECTIONS.has(direction) ||
      !towards
    ) {
      continue;
    }

    const identity = JSON.stringify([name, line, train, direction, towards]);
    const observedAt = sourceClock(row.recptnDt, receivedAt),
      value = finiteNumber(row.barvlDt),
      phase = text(row.arvlCd);
    const countdown =
      value !== null && Number.isSafeInteger(value) && value > 0 && value <= 86_400 ? value : null;

    const status: SourceEvent['status'] =
      text(row.btrainSttus) !== '일반'
        ? 'unknown'
        : phase === '1'
          ? 'arrived'
          : phase === '2'
            ? 'departed'
            : PREDICTION_CODES.has(phase) && countdown !== null
              ? 'prediction'
              : 'unknown';

    const rows = grouped.get(identity) ?? [];

    rows.push({
      identity,
      observedAt,
      countdown: status === 'prediction' ? countdown : null,
      status,
    });
    grouped.set(identity, rows);
  }

  return [...grouped].map(([identity, rows]) => {
    // An invalid competing timestamp makes the order unknowable; never retain its older prediction.
    if (rows.some((row) => row.observedAt === null)) {
      return {
        identity,
        observedAt: null,
        status: 'unknown' as const,
        countdown: null,
      };
    }

    const latest = Math.max(...rows.map((row) => row.observedAt!)),
      newest = rows.filter((row) => row.observedAt === latest);
    const signatures = new Set(newest.map((row) => `${row.status}:${row.countdown}`));

    return signatures.size === 1
      ? newest[0]
      : {
          identity,
          observedAt: latest,
          status: 'unknown' as const,
          countdown: null,
        };
  });
}

function weatherContext(
  weather: WeatherSnapshot | null | undefined,
  startedAt: number,
  receivedAt: number,
): Pick<EtaLearningFeatures, 'precipitationMm' | 'temperatureC' | 'windMetersPerSecond'> {
  const missing = {
    precipitationMm: null,
    temperatureC: null,
    windMetersPerSecond: null,
  };

  if (
    !weather ||
    weather.status !== 'live' ||
    weather.observedAt === null ||
    !Number.isSafeInteger(weather.observedAt) ||
    weather.observedAt > startedAt ||
    startedAt - weather.observedAt > 100 * 60_000 ||
    !Number.isSafeInteger(weather.receivedAt) ||
    weather.receivedAt > receivedAt ||
    weather.receivedAt < weather.observedAt
  ) {
    return missing;
  }

  const bounded = (value: number | null, lower: number, upper: number) =>
    value !== null && Number.isFinite(value) && value >= lower && value <= upper ? value : null;

  return {
    precipitationMm: bounded(weather.precipitationMm, 0, 1000),
    temperatureC: bounded(weather.temperatureC, -80, 70),
    windMetersPerSecond: bounded(weather.windMetersPerSecond, 0, 150),
  };
}

/**
 * Ephemeral train identity matching, one original prediction and at most one label per visit.
 * Labels describe provider arrival prediction error, never rider waiting/transfer/ride duration.
 * No names, coordinates, line/direction or train identifiers leave this class.
 */
export class ArrivalObservationCollector {
  private readonly visits = new Map<string, Visit>();
  private readonly firstContexts: ArrivalPredictionContext[] = [];

  predictionContexts(): ArrivalPredictionContext[] {
    return this.firstContexts.map((context) => ({
      ...context,
      features: {
        ...context.features,
      },
    }));
  }

  ingest(input: ArrivalCollectionInput): EtaLearningObservation[] {
    const observations: EtaLearningObservation[] = [];

    for (const event of events(input)) {
      const previous = this.visits.get(event.identity);

      if (event.observedAt === null) {
        if (previous && !previous.terminal) {
          delete previous.first;
        }

        continue;
      }

      if (previous?.terminal || (previous && event.observedAt < previous.stamp)) {
        continue;
      }

      const signature = `${event.status}:${event.countdown}`;

      if (previous && event.observedAt === previous.stamp) {
        if (signature !== previous.signature) {
          delete previous.first;
          previous.signature = 'unknown:null';

          if (event.status === 'arrived' || event.status === 'departed') {
            previous.terminal = true;
          }
        }

        continue;
      }

      if (!previous && this.visits.size >= MAX_VISITS) {
        continue;
      }

      const visit: Visit = previous ?? {
        stamp: event.observedAt,
        signature,
        terminal: false,
      };

      visit.stamp = event.observedAt;
      visit.signature = signature;

      if (event.status === 'prediction') {
        if (!visit.first) {
          const features: EtaLearningFeatures = {
            mode: 'wait',
            predictedSeconds: event.countdown!,
            distanceMeters: 0,
            startedAt: event.observedAt,
            ...weatherContext(input.weather, event.observedAt, input.receivedAt),
            congestionLevel: 'unknown',
            roadDelaySeconds: 0,
            precedingWaitSeconds: 0,
            transferIndex: 0,
            liveWait: true,
          };

          if (!visit.groupId) {
            visit.groupId = randomUUID();
            this.firstContexts.push({
              version: 1,
              id: visit.groupId,
              kind: 'unlabeled-context',
              source: 'arrival-prediction',
              features: {
                ...features,
              },
            });
          }

          visit.first = {
            tripId: visit.groupId,
            features,
          };
        }
      } else if (event.status === 'arrived') {
        const first = visit.first,
          actualSeconds = first ? (event.observedAt - first.features.startedAt) / 1000 : 0;

        if (first && actualSeconds > 0 && actualSeconds <= MAX_WINDOW_MS / 1000) {
          observations.push({
            version: 1,
            id: randomUUID(),
            tripId: first.tripId,
            source: 'observed-arrival',
            features: {
              ...first.features,
            },
            actualSeconds,
            observedAt: event.observedAt,
            evidence: 'provider-arrival',
          });
        }

        visit.terminal = true;
        delete visit.first;
      } else {
        delete visit.first;

        if (event.status === 'departed') {
          visit.terminal = true;
        }
      }

      this.visits.set(event.identity, visit);
    }

    return observations;
  }
}

export interface ArrivalCollectionOptions {
  stations?: readonly string[];
  polls?: number;
  intervalMs?: number;
  maxDurationMs?: number;
  maxCalls?: number;
}

export interface ArrivalCollectionConfiguration {
  stations: ArrivalCollectionStation[];
  polls: number;
  intervalMs: number;
  maxDurationMs: number;
  maxCalls: number;
}

export function arrivalCollectionConfiguration(
  options: ArrivalCollectionOptions = {},
): ArrivalCollectionConfiguration {
  const stations = options.stations ? [...options.stations] : ['서울'];
  const polls = options.polls ?? 4,
    intervalMs = options.intervalMs ?? 20_000,
    maxDurationMs = options.maxDurationMs ?? MAX_WINDOW_MS,
    maxCalls = options.maxCalls ?? polls * stations.length;

  if (
    !stations.length ||
    stations.length > 3 ||
    new Set(stations).size !== stations.length ||
    stations.some((station) => !Object.hasOwn(ARRIVAL_COLLECTION_STATIONS, station)) ||
    !Number.isSafeInteger(polls) ||
    polls < 1 ||
    polls > 16 ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 20_000 ||
    intervalMs > MAX_WINDOW_MS ||
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs < 20_000 ||
    maxDurationMs > MAX_WINDOW_MS ||
    !Number.isSafeInteger(maxCalls) ||
    maxCalls < 1 ||
    maxCalls > 48
  ) {
    throw new Error(
      '수집 설정을 확인해 주세요: 지정 역 최대 3곳, 20초 이상 간격, 최대 16회·5분·48건입니다.',
    );
  }

  return {
    stations: stations as ArrivalCollectionStation[],
    polls,
    intervalMs,
    maxDurationMs,
    maxCalls,
  };
}

export interface ArrivalCollectionDependencies {
  readStation: (station: ArrivalCollectionStation) => Promise<{
    payload: unknown;
    receivedAt: number;
  }>;
  readWeather?: (station: ArrivalCollectionStation) => Promise<WeatherSnapshot | null>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ArrivalCollectionReport {
  polls: number;
  calls: number;
  weatherCalls: number;
  rejectedPolls: number;
  failures: Partial<Record<FeedError['reason'], number>>;
  observations: EtaLearningObservation[];
  contexts: ArrivalPredictionContext[];
}

/** No implicit retries. Weather is sampled at most once per selected station during this bounded run. */
export async function collectPublicArrivals(
  options: ArrivalCollectionOptions,
  dependencies: ArrivalCollectionDependencies,
): Promise<ArrivalCollectionReport> {
  const config = arrivalCollectionConfiguration(options),
    now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const endAt = now() + config.maxDurationMs,
    collector = new ArrivalObservationCollector(),
    weather = new Map<ArrivalCollectionStation, WeatherSnapshot | null>();

  const report: ArrivalCollectionReport = {
    polls: 0,
    calls: 0,
    weatherCalls: 0,
    rejectedPolls: 0,
    failures: {},
    observations: [],
    contexts: [],
  };

  let previousStart: number | undefined;

  for (let poll = 0; poll < config.polls && report.calls < config.maxCalls; poll++) {
    if (previousStart !== undefined) {
      await sleep(Math.max(0, previousStart + config.intervalMs - now()));
    }

    if (now() >= endAt) {
      break;
    }

    previousStart = now();
    report.polls++;

    for (const station of config.stations) {
      if (now() >= endAt || report.calls >= config.maxCalls) {
        break;
      }

      if (dependencies.readWeather && !weather.has(station)) {
        report.weatherCalls++;

        try {
          weather.set(station, await dependencies.readWeather(station));
        } catch {
          weather.set(station, null);
        }
      }

      if (now() >= endAt) {
        break;
      }

      report.calls++;

      try {
        const read = await dependencies.readStation(station);

        report.observations.push(
          ...collector.ingest({
            station,
            ...read,
            weather: weather.get(station),
          }),
        );
      } catch (error) {
        report.rejectedPolls++;

        const reason = error instanceof FeedError ? error.reason : 'network';

        report.failures[reason] = (report.failures[reason] ?? 0) + 1;
      }
    }
  }

  report.contexts = collector.predictionContexts();

  return report;
}
