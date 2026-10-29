import type {
  BaseRoute,
  BaseSegment,
  ScheduleCheck,
  SubwayTimetable,
} from '../../shared/domain/types.js';
import { fetchFeedJson, FeedError, type FeedOptions } from './http.js';
import { stationBaseName, subwayLineId, subwayLineName } from './names.js';
import { koreanServiceDay } from './service-calendar.js';

export interface TimetableOptions extends FeedOptions {
  key?: string;
  now?: () => number;
  monotonic?: () => number;
  maxQueries?: number;
  calendar?: typeof koreanServiceDay;
}

type Row = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const DAY = 86400000,
  KST = 9 * 3600000;

export function subwayServiceDate(at: number): string {
  return new Date(at + KST - 5 * 3600000).toISOString().slice(0, 10);
}

export function timetableTime(value: unknown, date: string): number | null {
  const match = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(text(value));

  if (!match || Number(match[1]) > 28 || text(value) === '00:00:00') {
    return null;
  }

  let hour = Number(match[1]);

  if (hour < 5) {
    hour += 24;
  }

  return (
    Date.parse(`${date}T00:00:00+09:00`) +
    (hour * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000
  );
}

const normalizedLine = (value: unknown) => text(value).replace(/^0/, '');

/** Join actual train calls, never station-code order or a terminal-name substring. */
export function connectTimetableRows(
  tables: Row[][],
  date: string,
  line: string,
  stationCodes: string[],
  day: string,
  direction: '1' | '2',
): SubwayTimetable['departures'] {
  if (
    tables.length !== 3 ||
    tables.some((rows, index) =>
      rows.some(
        (row) =>
          text(row.STATION_CD) !== stationCodes[index] ||
          normalizedLine(row.LINE_NUM) !== line ||
          text(row.WEEK_TAG) !== day ||
          text(row.INOUT_TAG) !== direction,
      ),
    )
  ) {
    throw new FeedError('format');
  }

  const identity = (row: Row) =>
    [row.TRAIN_NO, row.ORIGINSTATION, row.DESTSTATION, row.EXPRESS_YN, row.BRANCH_LINE]
      .map(text)
      .join('|');

  const next = new Map<string, Row[]>(),
    end = new Map<string, Row[]>();

  for (const [map, rows] of [
    [next, tables[1]],
    [end, tables[2]],
  ] as const) {
    for (const row of rows) {
      map.set(identity(row), [...(map.get(identity(row)) ?? []), row]);
    }
  }

  return tables[0].flatMap((row) => {
    const departureAt = timetableTime(row.LEFTTIME, date),
      key = identity(row);

    if (departureAt === null || !text(row.TRAIN_NO)) {
      return [];
    }

    const nextCalls = (next.get(key) ?? [])
      .map((value) => timetableTime(value.ARRIVETIME, date))
      .filter(
        (value): value is number =>
          value !== null && value > departureAt && value - departureAt < 30 * 60000,
      );
    const arrivals = (end.get(key) ?? [])
      .map((value) => timetableTime(value.ARRIVETIME, date))
      .filter(
        (value): value is number =>
          value !== null && value > departureAt && value - departureAt <= 4 * 3600000,
      );

    // Duplicate runs with the same number may be valid, but ambiguity must not create a false connection.
    const matches = arrivals.filter((arrival) => nextCalls.some((nextAt) => nextAt <= arrival));

    return nextCalls.length === 1 && matches.length === 1
      ? [
          {
            departureAt,
            arrivalAt: matches[0],
            trainNo: text(row.TRAIN_NO),
            direction,
            destination: text(row.SUBWAYENAME),
          },
        ]
      : [];
  });
}

export class SeoulTimetableService {
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    {
      expires: number;
      value: Promise<Row[]>;
    }
  >();
  private blockedUntil = 0;

  constructor(private readonly options: TimetableOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return !!this.options.key?.trim();
  }

  private async rows(service: string, args: string[]): Promise<Row[]> {
    const url = new URL(
      `http://openapi.seoul.go.kr:8088/${[this.options.key!.trim(), 'json', service, '1', '1000', ...args].map(encodeURIComponent).join('/')}`,
    );

    const payload = (await fetchFeedJson(url, {
      ...this.options,
      timeoutMs: this.options.timeoutMs ?? 2500,
    })) as Record<string, any>;

    const data = payload?.[service],
      code = data?.RESULT?.CODE ?? payload?.RESULT?.CODE;

    if (code === 'INFO-100') {
      this.blockedUntil = this.now() + 600000;

      throw new FeedError('auth');
    }

    if (
      code !== 'INFO-000' ||
      !Array.isArray(data?.row) ||
      data.row.length === 0 ||
      !Number.isInteger(data.list_total_count) ||
      data.list_total_count !== data.row.length
    ) {
      throw new FeedError('format');
    }

    return data.row;
  }

  /** One search has its own strict upstream request cap; cache hits do not spend it. */
  async enrich(routes: BaseRoute[], at = this.now()): Promise<BaseRoute[]> {
    let remaining = Math.max(0, Math.min(20, this.options.maxQueries ?? 14));

    // Service-date clocks can be frozen for replay or adjusted by NTP. Query time limits use elapsed time.
    const monotonic = this.options.monotonic ?? (() => performance.now()),
      deadline = monotonic() + 6000;
    const checkedAt = this.now(),
      date = subwayServiceDate(at),
      calendar = (this.options.calendar ?? koreanServiceDay)(date, checkedAt);

    const lookups = new Map<
      string,
      Promise<{
        timetable?: SubwayTimetable;
        scheduleCheck: ScheduleCheck;
      }>
    >();

    const check = (
      reason: ScheduleCheck['reason'],
    ): {
      scheduleCheck: ScheduleCheck;
    } => ({
      scheduleCheck: {
        provider: 'seoul-metro-timetable',
        checkedAt,
        status: 'unverified',
        reason,
      },
    });

    const load = async (
      key: string,
      service: string,
      args: string[],
      ttl: number,
    ): Promise<Row[]> => {
      const cached = this.cache.get(key);

      if (cached && cached.expires > this.now()) {
        return cached.value;
      }

      if (remaining <= 0 || monotonic() >= deadline) {
        throw new Error('budget');
      }

      remaining--;

      if (this.cache.size > 128) {
        for (const key of this.cache.keys()) {
          this.cache.delete(key);

          if (this.cache.size <= 96) {
            break;
          }
        }
      }

      const value = this.rows(service, args);

      this.cache.set(key, {
        expires: this.now() + ttl,
        value,
      });
      value.catch(() => {
        if (this.cache.get(key)?.value === value) {
          this.cache.delete(key);
        }
      });

      return value;
    };

    const lookup = async (segment: BaseSegment) => {
      if (!this.configured) {
        return check('unconfigured');
      }

      if (!calendar) {
        return check('calendar-unverified');
      }

      if (date !== subwayServiceDate(checkedAt)) {
        return check('unsupported');
      }

      if (this.blockedUntil > this.now()) {
        return check('unavailable');
      }

      const stops = segment.transit?.stops,
        lines = segment.transit?.lines ?? [];
      const ids = [...new Set(lines.map(subwayLineId).filter(Boolean))];
      const id = ids[0],
        line = id ? subwayLineName(id) : null;

      if (!stops || stops.length < 2 || ids.length !== 1 || !line || !/^[1-9]호선$/.test(line)) {
        return check('unsupported');
      }

      try {
        const master = await load('stations', 'SearchSTNBySubwayLineInfo', [], DAY);

        const selected = [stops[0], stops[1], stops.at(-1)!].map((name) =>
          master.filter(
            (row) =>
              normalizedLine(row.LINE_NUM) === line &&
              stationBaseName(text(row.STATION_NM)) === stationBaseName(name),
          ),
        );

        if (selected.some((rows) => rows.length !== 1)) {
          return check('unsupported');
        }

        const codes = selected.map((rows) => text(rows[0].STATION_CD));
        const tag = {
          weekday: '1',
          saturday: '2',
          holiday: '3',
        }[calendar.dayType];

        // Sequential directions bound peak requests; three distinct station tables share in-flight cache entries.
        const departures: SubwayTimetable['departures'] = [];
        let receivedAt = this.now();

        for (const direction of ['1', '2'] as const) {
          const tables = await Promise.all(
            codes.map((code) =>
              load(
                `${date}:${code}:${tag}:${direction}`,
                'SearchSTNTimeTableByIDService',
                [code, tag, direction],
                6 * 3600000,
              ),
            ),
          );

          departures.push(...connectTimetableRows(tables, date, line, codes, tag, direction));

          // Retain the oldest table fetch, not the cache read time.
          receivedAt = Math.min(
            receivedAt,
            ...codes.map(
              (code) =>
                this.cache.get(`${date}:${code}:${tag}:${direction}`)!.expires - 6 * 3600000,
            ),
          );
        }

        if (!departures.length) {
          return check('incomplete');
        }

        const validFrom = Date.parse(`${date}T05:00:00+09:00`);

        return {
          timetable: {
            provider: 'seoul-metro-timetable' as const,
            serviceDate: date,
            dayType: calendar.dayType,
            calendarSource: calendar.source,
            receivedAt,
            validFrom,
            validUntil: validFrom + DAY,
            line,
            boardingStation: stops[0],
            nextStation: stops[1],
            alightingStation: stops.at(-1)!,
            complete: true as const,
            departures: departures.sort((a, b) => a.departureAt - b.departureAt),
          },
          scheduleCheck: {
            provider: 'seoul-metro-timetable' as const,
            checkedAt,
            status: 'published' as const,
          },
        };
      } catch (error) {
        return check(
          error instanceof Error && error.message === 'budget'
            ? 'budget'
            : error instanceof FeedError && error.reason === 'format'
              ? 'incomplete'
              : 'unavailable',
        );
      }
    };

    // Prefer each unique ride in current route order; avoid unbounded parallel table fan-out.
    for (const route of routes) {
      for (const segment of route.segments) {
        if (segment.mode === 'subway') {
          const key = JSON.stringify(segment.transit);

          if (!lookups.has(key)) {
            const value = lookup(segment);

            lookups.set(key, value);

            await value;
          }
        }
      }
    }

    return Promise.all(
      routes.map(async (route) => ({
        ...route,
        segments: await Promise.all(
          route.segments.map(async (segment) =>
            segment.mode === 'subway'
              ? {
                  ...segment,
                  timetable: undefined,
                  scheduledConnection: undefined,
                  ...(await lookups.get(JSON.stringify(segment.transit))!),
                }
              : segment,
          ),
        ),
      })),
    );
  }
}
