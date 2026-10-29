import type { ParkingAccess, Place } from '../../shared/domain/types.js';
import type { NearbyPlace } from '../kakao.js';
import {
  FeedError,
  fetchFeedJson,
  finiteNumber,
  parseKstDateTime,
  text,
  type FeedOptions,
} from './http.js';
import { metersBetween } from './names.js';

export interface PublicParking extends NearbyPlace {
  parkingAccess: ParkingAccess;
}

export interface ParkingLookup {
  readonly configured: boolean;
  nearest(near: Place, radiusMeters: number, arrivalAt: number): Promise<PublicParking | null>;
  /** Recheck a previously fetched lot's schedule at a recomposed journey arrival, without I/O. */
  at?(near: Place, arrivalAt: number): PublicParking | null;
}

type Row = Record<string, unknown>;

const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row))
    : [];

const FRESH_OCCUPANCY_MS = 5 * 60_000;
const SNAPSHOT_MS = 30_000;

const DISTRICTS = new Set([
  '강남',
  '강동',
  '강북',
  '강서',
  '관악',
  '광진',
  '구로',
  '금천',
  '노원',
  '도봉',
  '동대문',
  '동작',
  '마포',
  '서대문',
  '서초',
  '성동',
  '성북',
  '송파',
  '양천',
  '영등포',
  '용산',
  '은평',
  '종로',
  '중',
  '중랑',
]);

function clockMinute(value: unknown): number | null {
  const raw = text(value).padStart(4, '0');

  if (!/^\d{4}$/.test(raw)) {
    return null;
  }

  const hour = Number(raw.slice(0, 2)),
    minute = Number(raw.slice(2));

  if (hour === 24 && minute === 0) {
    return 1440;
  }

  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function openAt(start: unknown, end: unknown, minute: number): boolean | null {
  const from = clockMinute(start),
    to = clockMinute(end);

  // Missing/0000-0000 does not prove that the lot is open 24 hours.
  if (from === null || to === null || from === to) {
    return null;
  }

  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

function operation(row: Row, arrivalAt: number): ParkingAccess['operating'] {
  const date = new Date(arrivalAt + 9 * 3_600_000),
    day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const holiday = openAt(
    row.LHLDY_BGNG ?? row.LHLDY_OPER_BGNG_TM,
    row.LHLDY ?? row.LHLDY_OPER_END_TM,
    minute,
  );
  const regular =
    day === 0
      ? holiday
      : day === 6
        ? openAt(row.WE_OPER_BGNG_TM, row.WE_OPER_END_TM, minute)
        : openAt(row.WD_OPER_BGNG_TM, row.WD_OPER_END_TM, minute);

  // Without a holiday calendar, accept open only when both relevant schedules allow arrival.
  if (regular === true && holiday === true) {
    return 'open';
  }

  if (regular === false && holiday === false) {
    return 'closed';
  }

  return 'unknown';
}

function fee(row: Row, current: Row | undefined, arrivalAt: number): ParkingAccess['fee'] {
  const day = new Date(arrivalAt + 9 * 3_600_000).getUTCDay();
  const regular = text(day === 6 ? row.SAT_CHGD_FREE_NM : row.CHGD_FREE_NM || current?.PAY_YN_NM);
  const holiday = text(row.LHLDY_NM || row.LHLDY_CHGD_FREE_SE_NAME || regular);

  const parse = (value: string): ParkingAccess['fee'] =>
    value === '무료' ? 'free' : value === '유료' ? 'paid' : 'unknown';

  const everyday = parse(regular),
    holidays = parse(holiday);

  return everyday === holidays ? everyday : 'unknown';
}

/** Official GetParkInfo coordinates/access + GetParkingInfo current counts, joined by PKLT_CD. */
export function normalizeParkingLots(
  detailInput: unknown,
  currentInput: unknown,
  receivedAt: number,
  arrivalAt: number,
): PublicParking[] {
  const currentByCode = new Map(rows(currentInput).map((row) => [text(row.PKLT_CD), row]));
  const lots = new Map<string, PublicParking>();

  for (const row of rows(detailInput)) {
    const code = text(row.PKLT_CD),
      name = text(row.PKLT_NM),
      operator = text(row.OPER_SE_NM);
    const latitude = finiteNumber(row.LAT),
      longitude = finiteNumber(row.LOT);

    // A resident/permit/bus/motorcycle-only lot cannot be a general passenger-car endpoint.
    if (
      !code ||
      !name ||
      !/시간제/.test(operator) ||
      /거주자|전용|정기권|부설/.test(`${operator} ${name}`) ||
      latitude === null ||
      longitude === null ||
      latitude < 37.35 ||
      latitude > 37.8 ||
      longitude < 126.7 ||
      longitude > 127.3
    ) {
      continue;
    }

    const current = currentByCode.get(code),
      observedAt = parseKstDateTime(current?.NOW_PRK_VHCL_UPDT_TM);
    const capacity = finiteNumber(current?.TPKCT ?? row.TPKCT),
      occupied = finiteNumber(current?.NOW_PRK_VHCL_CNT);
    const reports = ['1', 'Y', '유'].includes(text(current?.PRK_STTS_YN));
    const fresh =
      reports &&
      observedAt !== null &&
      observedAt <= receivedAt + 30_000 &&
      receivedAt - observedAt <= FRESH_OCCUPANCY_MS;

    const available =
      fresh &&
      capacity !== null &&
      Number.isInteger(capacity) &&
      capacity > 0 &&
      occupied !== null &&
      Number.isInteger(occupied) &&
      occupied >= 0 &&
      occupied <= capacity
        ? capacity - occupied
        : null;

    const operating = operation(row, arrivalAt);

    if (operating === 'closed' || available === 0) {
      continue;
    }

    const baseFee = finiteNumber(row.PRK_CRG ?? current?.BSC_PRK_CRG),
      baseMinutes = finiteNumber(row.PRK_HM ?? current?.BSC_PRK_HR);

    lots.set(code, {
      id: `seoul-parking-${code}`,
      name,
      address: text(row.ADDR),
      latitude,
      longitude,
      category: '서울시 공영 시간제 주차장',
      distanceMeters: 0,
      parkingAccess: {
        publicAccess: true,
        provider: 'seoul-parking',
        operating,
        occupancy: available !== null ? 'available' : 'unknown',
        fee: fee(row, current, arrivalAt),
        verifiedAt: receivedAt,
        occupancyObservedAt: observedAt,
        availableSpaces: available,
        ...(baseFee !== null && baseFee >= 0
          ? {
              baseFeeWon: baseFee,
            }
          : {}),
        ...(baseMinutes !== null && baseMinutes > 0
          ? {
              baseMinutes,
            }
          : {}),
      },
    });
  }

  return [...lots.values()];
}

/** Server-only Seoul feed. An absent key or provider failure never yields invented parking. */
export class SeoulParkingFeed implements ParkingLookup {
  readonly configured: boolean;
  lastFailure: FeedError['reason'] | null = null;
  private readonly key: string;
  private readonly options: FeedOptions;
  private readonly now: () => number;
  private snapshots = new Map<
    string,
    {
      at: number;
      details: Row[];
      current: Row[];
    }
  >();
  private inflight = new Map<
    string,
    Promise<{
      at: number;
      details: Row[];
      current: Row[];
    }>
  >();
  private retryAfter = 0;

  constructor(
    key?: string,
    options: FeedOptions & {
      now?: () => number;
    } = {},
  ) {
    this.key = key?.trim() ?? '';
    this.configured = !!this.key;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private async page(service: 'GetParkInfo' | 'GetParkingInfo', start: number, district: string) {
    const suffix = district
      ? `/${encodeURIComponent(service === 'GetParkingInfo' ? `${district}구` : district)}`
      : '';

    const body = (await fetchFeedJson(
      new URL(
        `http://openapi.seoul.go.kr:8088/${encodeURIComponent(this.key)}/json/${service}/${start}/${start + 999}${suffix}`,
      ),
      this.options,
    )) as Record<string, unknown>;

    const data = body?.[service] as
      | {
          RESULT?: {
            CODE?: string;
          };
          row?: unknown;
          list_total_count?: unknown;
        }
      | undefined;

    const code =
      data?.RESULT?.CODE ??
      (
        body?.RESULT as
          | {
              CODE?: string;
            }
          | undefined
      )?.CODE ??
      text(body?.CODE);

    if (code === 'INFO-200') {
      return {
        total: 0,
        rows: [] as Row[],
      };
    }

    if (code === 'INFO-100' || code === 'ERROR-100') {
      throw new FeedError('auth');
    }

    if (code !== 'INFO-000' || !data) {
      throw new FeedError('format');
    }

    const total = finiteNumber(data.list_total_count);

    if (total === null || !Number.isInteger(total) || total < 0 || total > 20_000) {
      throw new FeedError('format');
    }

    return {
      total,
      rows: rows(data.row),
    };
  }

  private async all(service: 'GetParkInfo' | 'GetParkingInfo', district: string): Promise<Row[]> {
    const first = await this.page(service, 1, district);

    const rest = await Promise.all(
      Array.from(
        {
          length: Math.max(0, Math.ceil(first.total / 1000) - 1),
        },
        (_, index) => this.page(service, (index + 1) * 1000 + 1, district),
      ),
    );

    return [first, ...rest].flatMap((page) => page.rows);
  }

  private snapshot(district: string) {
    const existing = this.snapshots.get(district);

    if (existing && this.now() - existing.at <= SNAPSHOT_MS) {
      return Promise.resolve(existing);
    }

    const pending = this.inflight.get(district);

    if (pending) {
      return pending;
    }

    const next = Promise.all([
      this.all('GetParkInfo', district),
      this.all('GetParkingInfo', district),
    ])
      .then(([details, current]) => {
        const snapshot = {
          at: this.now(),
          details,
          current,
        };

        this.snapshots.set(district, snapshot);
        this.lastFailure = null;

        return snapshot;
      })
      .finally(() => this.inflight.delete(district));

    this.inflight.set(district, next);

    return next;
  }

  async nearest(
    near: Place,
    radiusMeters: number,
    arrivalAt: number,
  ): Promise<PublicParking | null> {
    if (!this.configured || this.now() < this.retryAfter) {
      return null;
    }

    const districtName = near.address.match(/(?:^|\s)([가-힣]+)구(?:\s|$)/)?.[1] ?? '';
    const district = DISTRICTS.has(districtName) ? districtName : '';

    try {
      const snapshot = await this.snapshot(district);

      return (
        normalizeParkingLots(snapshot.details, snapshot.current, snapshot.at, arrivalAt)
          .map((lot) => ({
            ...lot,
            distanceMeters: metersBetween(near, lot),
          }))
          .filter((lot) => lot.distanceMeters <= radiusMeters)
          .sort(
            (a, b) =>
              Number(
                b.parkingAccess.operating === 'open' && b.parkingAccess.occupancy === 'available',
              ) -
                Number(
                  a.parkingAccess.operating === 'open' && a.parkingAccess.occupancy === 'available',
                ) || a.distanceMeters - b.distanceMeters,
          )[0] ?? null
      );
    } catch (error) {
      this.lastFailure = error instanceof FeedError ? error.reason : 'format';
      this.retryAfter = this.now() + 60_000;

      return null;
    }
  }

  at(near: Place, arrivalAt: number): PublicParking | null {
    if (!this.configured || !Number.isFinite(arrivalAt)) {
      return null;
    }

    const time = this.now();

    for (const snapshot of [...this.snapshots.values()].sort((a, b) => b.at - a.at)) {
      if (snapshot.at > time + 30_000 || time - snapshot.at > SNAPSHOT_MS) {
        continue;
      }

      const lot = normalizeParkingLots(
        snapshot.details,
        snapshot.current,
        snapshot.at,
        arrivalAt,
      ).find((candidate) => candidate.id === near.id && metersBetween(candidate, near) <= 5);

      if (lot) {
        return lot;
      }
    }

    return null;
  }
}
