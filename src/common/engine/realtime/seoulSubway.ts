import type { ArrivalPrediction } from '../../shared/domain/types.js';
import { asArray, fetchFeedJson, FeedError, finiteNumber, text, type FeedOptions } from './http.js';
import { ServiceKeyPool } from './key-pool.js';
import { parseArrivalPhrase, stationBaseName, subwayLineId, subwayLineName } from './names.js';

/** One normalized train approaching a station, before line/direction filtering. */
export interface SubwayArrivalRow {
  lineId: string;
  /** "XX방면": the next station the train will serve after this one. */
  towards: string;
  terminus: string;
  arrivesAt: number;
  observedAt: number;
  stopsAway: number | null;
  message: string;
  express: boolean;
  lastService: boolean;
  trainNo: string;
}

interface RawRow {
  subwayId?: unknown;
  trainLineNm?: unknown;
  bstatnNm?: unknown;
  barvlDt?: unknown;
  arvlMsg2?: unknown;
  arvlMsg3?: unknown;
  arvlCd?: unknown;
  recptnDt?: unknown;
  btrainSttus?: unknown;
  lstcarAt?: unknown;
  btrainNo?: unknown;
}

const DEPARTED_CODES = new Set(['2']);
const MAX_SOURCE_AGE_MS = 120_000;
const SOURCE_CLOCK_SKEW_MS = 30_000;

function countdownSeconds(value: unknown): number | null {
  const seconds = finiteNumber(value);

  return seconds !== null && Number.isInteger(seconds) && seconds > 0 && seconds <= 86_400
    ? seconds
    : null;
}

/** The official recptnDt is a KST source clock, never a response receipt. */
function sourceTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number),
    second = Number(match[6] ?? 0);
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

  return local - 9 * 3_600_000;
}

export function parseSubwayRows(
  payload: unknown,
  receivedAt: number,
): SubwayArrivalRow[] | 'not-found' {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt <= 0
  ) {
    throw new FeedError('format');
  }

  const record = payload as {
    realtimeArrivalList?: unknown;
    errorMessage?: {
      code?: unknown;
    };
    code?: unknown;
    status?: unknown;
  };

  const code = text(record.errorMessage?.code ?? record.code);

  if (code === 'INFO-200') {
    return 'not-found';
  }

  if (code === 'INFO-100') {
    throw new FeedError('auth');
  }

  // ERROR-337: the key's daily traffic is spent until 00:00 KST.
  if (code === 'ERROR-337') {
    throw new FeedError('quota');
  }

  if (code && !code.startsWith('INFO-000')) {
    throw new FeedError('format');
  }

  const rows: SubwayArrivalRow[] = [];

  type Candidate = {
    raw: RawRow;
    lineId: string;
    towards: string;
    observedAt: number | null;
  };

  const trains = new Map<string, Candidate[]>();

  for (const [index, raw] of asArray<RawRow>(record.realtimeArrivalList).entries()) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }

    const lineId = text(raw.subwayId);

    if (!lineId) {
      continue;
    }

    const towards =
      text(raw.trainLineNm)
        .match(/-\s*(.+?)방면/)?.[1]
        ?.trim() ?? '';
    const timestamp = sourceTimestamp(raw.recptnDt);
    const observedAt =
      timestamp !== null && timestamp > 0 && timestamp <= receivedAt + SOURCE_CLOCK_SKEW_MS
        ? timestamp
        : null;
    const trainNo = text(raw.btrainNo),
      identity = trainNo
        ? `${lineId}:${trainNo}:${stationBaseName(towards)}`
        : `unidentified:${index}`;
    const group = trains.get(identity) ?? [];

    group.push({
      raw,
      lineId,
      towards,
      observedAt,
    });
    trains.set(identity, group);
  }

  const candidates: Candidate[] = [];

  for (const group of trains.values()) {
    // A newer departure/unknown countdown revokes an older positive prediction.
    // With an invalid source clock, its order cannot safely be established.
    if (group.some((candidate) => candidate.observedAt === null)) {
      continue;
    }

    const newest = Math.max(...group.map((candidate) => candidate.observedAt!));
    const latest = group.filter((candidate) => candidate.observedAt === newest);

    if (
      latest.some(
        ({ raw }) =>
          DEPARTED_CODES.has(text(raw.arvlCd)) ||
          countdownSeconds(raw.barvlDt) === null ||
          !(text(raw.btrainSttus) === '일반' || /급행|특급|직통|ITX/i.test(text(raw.btrainSttus))),
      )
    ) {
      continue;
    }

    candidates.push(...latest);
  }

  for (const { raw, lineId, towards, observedAt: stamp } of candidates) {
    const observedAt = stamp!,
      cd = text(raw.arvlCd);
    const message = text(raw.arvlMsg2);
    const countdown = countdownSeconds(raw.barvlDt);
    const phrase = parseArrivalPhrase(message);

    // Zero often means unavailable. Status/station-count heuristics do not prove
    // a quantified future train and must not become an actual wait observation.
    if (countdown === null || countdown <= 0) {
      continue;
    }

    const arrivesAt = observedAt + countdown * 1_000;

    if (!Number.isFinite(arrivesAt) || arrivesAt > Number.MAX_SAFE_INTEGER) {
      continue;
    }

    const stopsAway =
      phrase.stopsAway ?? (['3', '4', '5'].includes(cd) ? 1 : ['0', '1'].includes(cd) ? 0 : null);
    const status = text(raw.btrainSttus);

    rows.push({
      lineId,
      towards: towards.trim(),
      terminus: text(raw.bstatnNm),
      arrivesAt,
      observedAt,
      stopsAway,
      message: message || text(raw.arvlMsg3),
      express: /급행|특급|직통|ITX/i.test(status),
      lastService: text(raw.lstcarAt) === '1',
      trainNo: text(raw.btrainNo),
    });
  }

  return rows;
}

/** Keep fresh normal-service trains that do not terminate before the planned alighting stop. */
export function selectSubwayArrivals(
  rows: SubwayArrivalRow[],
  lines: string[],
  nextStops: string[],
  now: number,
): {
  predictions: ArrivalPrediction[];
  observedAt: number;
} | null {
  const lineIds = new Set(lines.map(subwayLineId).filter((id): id is string => !!id));
  const remainingStops = nextStops.map(stationBaseName);
  const next = remainingStops[0] ?? '';

  if (!lineIds.size || !next || !Number.isFinite(now)) {
    return null;
  }

  const matching = rows.filter(
    (row) =>
      lineIds.has(row.lineId) &&
      !row.express &&
      row.towards &&
      stationBaseName(row.towards) === next &&
      // A matching direction alone does not prove through service. A known short
      // turn cannot carry this passenger beyond its terminus. Unknown branches
      // still require a topology source; station-name order is not such a source.
      !remainingStops.slice(0, -1).includes(stationBaseName(row.terminus)) &&
      Number.isFinite(row.observedAt) &&
      row.observedAt > 0 &&
      row.observedAt <= now + SOURCE_CLOCK_SKEW_MS &&
      now - row.observedAt <= MAX_SOURCE_AGE_MS &&
      Number.isFinite(row.arrivesAt) &&
      row.arrivesAt >= now,
  );

  const latest = new Map<string, SubwayArrivalRow>();

  for (const row of matching) {
    const key = row.trainNo
      ? `${row.lineId}:${row.trainNo}`
      : `${row.lineId}:${row.towards}:${row.arrivesAt}`;
    const previous = latest.get(key);

    if (
      !previous ||
      row.observedAt > previous.observedAt ||
      (row.observedAt === previous.observedAt && row.arrivesAt > previous.arrivesAt)
    ) {
      latest.set(key, row);
    }
  }

  const selected = [...latest.values()].sort((a, b) => a.arrivesAt - b.arrivesAt).slice(0, 4);

  if (!selected.length) {
    return null;
  } // No prediction is not evidence that service ended.

  const predictions = selected.map((row) => ({
    line: subwayLineName(row.lineId) ?? lines[0],
    arrivesAt: row.arrivesAt,
    destination: row.terminus ? `${row.terminus}행` : undefined,
    stopsAway: row.stopsAway ?? undefined,
    message: row.message,
    express: row.express || undefined,
    lastService: row.lastService || undefined,
  }));

  return {
    predictions,
    observedAt: Math.min(...selected.map((row) => row.observedAt)),
  };
}

export class SeoulSubwayFeed {
  private readonly keys: ServiceKeyPool;

  /** A spare key (SEOUL_OPEN_API_KEY_FALLBACK) takes over once the first key's daily traffic is spent. */
  constructor(
    key: string | ServiceKeyPool,
    private readonly options: FeedOptions = {},
  ) {
    this.keys = key instanceof ServiceKeyPool ? key : new ServiceKeyPool([key]);
  }

  get configured() {
    return this.keys.configured;
  }

  /** Tries the plain station name first, then the provider's full name with its parenthetical. */
  async stationRows(stationName: string, now: number): Promise<SubwayArrivalRow[]> {
    const candidates = [
      ...new Set([stationBaseName(stationName), stationName.replace(/\s+/g, '')].filter(Boolean)),
    ];

    for (const candidate of candidates) {
      const rows = await this.keys.call('realtimeStationArrival', 'guidance', async (key) =>
        parseSubwayRows(
          await fetchFeedJson(
            new URL(
              `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(key)}/json/realtimeStationArrival/0/60/${encodeURIComponent(candidate)}`,
            ),
            this.options,
          ),
          now,
        ),
      );

      if (rows !== 'not-found') {
        return rows;
      }
    }

    return [];
  }
}
