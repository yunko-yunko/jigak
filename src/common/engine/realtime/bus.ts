import type { ArrivalPrediction } from '../../shared/domain/types.js';
import {
  asArray,
  decodeServiceKey,
  fetchFeedJson,
  FeedError,
  finiteNumber,
  text,
  type FeedOptions,
} from './http.js';
import { busRouteKey, metersBetween, parseArrivalPhrase, stopNamesMatch } from './names.js';

export interface BusStopCandidate {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** TAGO needs the city code alongside the node id. */
  cityCode?: string;
}

export interface BusArrivalRow {
  route: string;
  arrivesAt: number | null;
  stopsAway: number | null;
  message: string;
  ended: boolean;
  lastService: boolean;
  nextStop?: string;
}

export interface BusFeed {
  readonly provider: 'seoul-bus' | 'tago-bus';
  readonly configured: boolean;
  nearbyStops(point: { latitude: number; longitude: number }): Promise<BusStopCandidate[]>;
  arrivals(stop: BusStopCandidate, receivedAt: number): Promise<BusArrivalRow[]>;
}

function platformNumbers(name: string): string[] {
  return [
    ...name.matchAll(
      /(?:제\s*)?(\d+)\s*번?\s*(?:승강장|플랫폼|타는\s*곳)|(?:승강장|플랫폼)\s*(?:제\s*)?(\d+)\s*번?/g,
    ),
  ].map((match) => String(Number(match[1] ?? match[2])));
}

function boardingNamesMatch(candidate: string, requested: string): boolean {
  if (!stopNamesMatch(candidate, requested)) {
    return false;
  }

  const expected = platformNumbers(requested),
    actual = platformNumbers(candidate);

  // Parenthetical labels cannot be discarded when they identify a platform.
  return (
    !expected.length ||
    (expected.length === actual.length &&
      expected.every((number, index) => number === actual[index]))
  );
}

/** Only a matching boarding stop within provider-rounding distance is reusable. */
export function chooseBusStops(
  candidates: BusStopCandidate[],
  stopName: string,
  point: {
    latitude: number;
    longitude: number;
  },
  maxMeters = 25,
): BusStopCandidate[] {
  return candidates
    .map((candidate) => ({
      candidate,
      distance: metersBetween(point, candidate),
    }))
    .filter(
      (item) =>
        Number.isFinite(item.distance) &&
        item.distance <= Math.min(maxMeters, 25) &&
        boardingNamesMatch(item.candidate.name, stopName),
    )
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2)
    .map((item) => item.candidate);
}

/** Filter one stop's arrivals to the step's listed routes. Null when none of the routes stop here. */
export function selectBusArrivals(
  rows: BusArrivalRow[],
  lines: string[],
  nextStop: string | undefined,
  now: number,
): {
  predictions: ArrivalPrediction[];
  ended: boolean;
} | null {
  const wanted = new Map(lines.map((line) => [busRouteKey(line), line]));
  const matching = rows.filter((row) => wanted.has(busRouteKey(row.route)));

  if (!matching.length) {
    return null;
  }

  // Seoul rows name the following stop; a mismatch means the opposite side of the road.
  const directional = nextStop
    ? matching.filter((row) => !!row.nextStop && stopNamesMatch(row.nextStop, nextStop))
    : matching;

  if (!directional.length) {
    return null;
  }

  const predictions = directional
    .filter(
      (
        row,
      ): row is BusArrivalRow & {
        arrivesAt: number;
      } => row.arrivesAt !== null && !row.ended && row.arrivesAt >= now,
    )
    .sort((a, b) => a.arrivesAt - b.arrivesAt)
    .slice(0, 6)
    .map((row) => ({
      line: wanted.get(busRouteKey(row.route)) ?? row.route,
      arrivesAt: row.arrivesAt,
      stopsAway: row.stopsAway ?? undefined,
      message: row.message,
      lastService: row.lastService || undefined,
    }));

  return {
    predictions,
    ended: directional.every((row) => row.ended),
  };
}

const MAX_BUS_COUNTDOWN_SECONDS = 86_400;

const boundedCountdown = (seconds: number | null) =>
  seconds !== null &&
  Number.isInteger(seconds) &&
  seconds >= 0 &&
  seconds <= MAX_BUS_COUNTDOWN_SECONDS
    ? seconds
    : null;

/** A proximity phrase gives no measured countdown; never turn it into seconds. */
function explicitCountdown(message: string): number | null {
  const value = message.match(
    /(\d+)\s*시간(?:\s*(\d+)\s*분)?(?:\s*(\d+)\s*초)?|(\d+)\s*분(?:\s*(\d+)\s*초)?|(\d+)\s*초/,
  );

  if (!value || /[-−+.]\s*$/.test(message.slice(0, value.index))) {
    return null;
  }

  return boundedCountdown(
    value[1] !== undefined
      ? Number(value[1]) * 3600 + Number(value[2] ?? 0) * 60 + Number(value[3] ?? 0)
      : value[4] !== undefined
        ? Number(value[4]) * 60 + Number(value[5] ?? 0)
        : Number(value[6]),
  );
}

function busRow(
  route: string,
  message: string,
  receivedAt: number,
  nextStop?: string,
  fallbackSeconds?: number | null,
): BusArrivalRow | null {
  if (!route) {
    return null;
  }

  const ended = /운행\s*종료|운행종료|막차\s*끊김/.test(message);
  const waiting = /출발\s*대기|회차\s*대기|차고지/.test(message);
  const phrase = parseArrivalPhrase(message);
  const seconds =
    ended || waiting
      ? null
      : fallbackSeconds === undefined
        ? explicitCountdown(message)
        : boundedCountdown(fallbackSeconds);

  return {
    route,
    arrivesAt: seconds === null ? null : receivedAt + seconds * 1_000,
    stopsAway: phrase.stopsAway,
    message: message.replace(/\s+/g, ' ').trim(),
    ended,
    lastService: /막차/.test(message),
    nextStop,
  };
}

interface SeoulEnvelope {
  msgHeader?: {
    headerCd?: unknown;
  };
  msgBody?: {
    itemList?: unknown;
  };
}

function seoulItems(payload: unknown): Record<string, unknown>[] {
  const envelope = payload as SeoulEnvelope;
  const code = text(envelope?.msgHeader?.headerCd);

  if (code === '4') {
    return [];
  }

  // Portal permission/registration/expiry/IP failures are distinct from a
  // temporary request limit; callers must not blame a valid key for quota.
  if (['7', '8', '20', '30', '31', '32'].includes(code)) {
    throw new FeedError('auth');
  }

  if (code === '22' || code === '23') {
    throw new FeedError('status');
  }

  if (code !== '0') {
    throw new FeedError('format');
  }

  return asArray<Record<string, unknown>>(envelope.msgBody?.itemList);
}

/** Seoul TOPIS bus arrival service (ws.bus.go.kr), keyed by a data.go.kr service key. */
export class SeoulBusFeed implements BusFeed {
  readonly provider = 'seoul-bus' as const;
  private readonly key: string;

  constructor(
    key: string | undefined,
    private readonly options: FeedOptions = {},
  ) {
    this.key = decodeServiceKey(key);
  }

  get configured() {
    return !!this.key;
  }

  private url(path: string, params: Record<string, string>): URL {
    if (!this.key) {
      throw new FeedError('auth');
    }

    const url = new URL(`http://ws.bus.go.kr/api/rest/stationinfo/${path}`);

    url.searchParams.set('serviceKey', this.key);

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }

    url.searchParams.set('resultType', 'json');

    return url;
  }

  async nearbyStops(point: { latitude: number; longitude: number }): Promise<BusStopCandidate[]> {
    const items = seoulItems(
      await fetchFeedJson(
        this.url('getStationByPos', {
          tmX: String(point.longitude),
          tmY: String(point.latitude),
          radius: '200',
        }),
        this.options,
      ),
    );

    return items.flatMap((item) => {
      const id = text(item.arsId),
        name = text(item.stationNm),
        latitude = finiteNumber(item.gpsY),
        longitude = finiteNumber(item.gpsX);

      return id && id !== '0' && name && latitude !== null && longitude !== null
        ? [
            {
              id,
              name,
              latitude,
              longitude,
            },
          ]
        : [];
    });
  }

  async arrivals(stop: BusStopCandidate, receivedAt: number): Promise<BusArrivalRow[]> {
    const items = seoulItems(
      await fetchFeedJson(
        this.url('getStationByUid', {
          arsId: stop.id,
        }),
        this.options,
      ),
    );

    return items.flatMap((item) => {
      const route = text(item.rtNm),
        nextStop = text(item.nxtStn) || undefined;

      return [
        busRow(route, text(item.arrmsg1), receivedAt, nextStop),
        busRow(route, text(item.arrmsg2), receivedAt, nextStop),
      ].filter((row): row is BusArrivalRow => !!row);
    });
  }
}

interface TagoEnvelope {
  response?: {
    header?: {
      resultCode?: unknown;
    };
    body?: {
      items?:
        | {
            item?: unknown;
          }
        | string;
    };
  };
}

function tagoItems(payload: unknown): Record<string, unknown>[] {
  const response = (payload as TagoEnvelope)?.response;
  const code = text(response?.header?.resultCode);

  if (code === '30' || code === '31' || code === '32' || code === '20') {
    throw new FeedError('auth');
  }

  if (code === '22' || code === '23') {
    throw new FeedError('status');
  }

  if (code !== '00') {
    throw new FeedError('format');
  }

  const items = response?.body?.items;

  return typeof items === 'object' && items ? asArray<Record<string, unknown>>(items.item) : [];
}

/** National TAGO feeds (국토교통부 버스정류소·도착정보) for cities outside the Seoul TOPIS service. */
export class TagoBusFeed implements BusFeed {
  readonly provider = 'tago-bus' as const;
  private readonly key: string;

  constructor(
    key: string | undefined,
    private readonly options: FeedOptions = {},
  ) {
    this.key = decodeServiceKey(key);
  }

  get configured() {
    return !!this.key;
  }

  private url(service: string, operation: string, params: Record<string, string>): URL {
    if (!this.key) {
      throw new FeedError('auth');
    }

    const url = new URL(`https://apis.data.go.kr/1613000/${service}/${operation}`);

    url.searchParams.set('serviceKey', this.key);

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }

    url.searchParams.set('_type', 'json');

    return url;
  }

  async nearbyStops(point: { latitude: number; longitude: number }): Promise<BusStopCandidate[]> {
    const items = tagoItems(
      await fetchFeedJson(
        this.url('BusSttnInfoInqireService', 'getCrdntPrxmtSttnList', {
          gpsLati: String(point.latitude),
          gpsLong: String(point.longitude),
          numOfRows: '20',
          pageNo: '1',
        }),
        this.options,
      ),
    );

    return items.flatMap((item) => {
      const id = text(item.nodeid),
        name = text(item.nodenm),
        cityCode = text(item.citycode),
        latitude = finiteNumber(item.gpslati),
        longitude = finiteNumber(item.gpslong);

      return id && name && cityCode && latitude !== null && longitude !== null
        ? [
            {
              id,
              name,
              cityCode,
              latitude,
              longitude,
            },
          ]
        : [];
    });
  }

  async arrivals(stop: BusStopCandidate, receivedAt: number): Promise<BusArrivalRow[]> {
    if (!stop.cityCode) {
      return [];
    }

    const items = tagoItems(
      await fetchFeedJson(
        this.url('ArvlInfoInqireService', 'getSttnAcctoArvlPrearngeInfoList', {
          cityCode: stop.cityCode,
          nodeId: stop.id,
          numOfRows: '100',
          pageNo: '1',
        }),
        this.options,
      ),
    );

    return items.flatMap((item) => {
      const seconds = boundedCountdown(finiteNumber(item.arrtime));
      const stops = finiteNumber(item.arrprevstationcnt);
      const minutes = seconds === null ? null : Math.max(0, Math.round(seconds / 60));
      const message =
        minutes === null
          ? ''
          : `${minutes ? `${minutes}분 후` : '곧 도착'}${stops !== null ? ` [${stops}번째 전]` : ''}`;
      const row = busRow(text(item.routeno), message, receivedAt, undefined, seconds);

      return row
        ? [
            {
              ...row,
              stopsAway: stops ?? row.stopsAway,
            },
          ]
        : [];
    });
  }
}
