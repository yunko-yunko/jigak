import type {
  BaseRoute,
  BaseSegment,
  ScheduleCheck,
  SubwayTimetable,
} from '../../shared/domain/types.js';
import { fetchFeedJson, FeedError, type FeedOptions } from './http.js';
import { stationBaseName, subwayLineId, subwayLineName } from './names.js';
import { koreanServiceDay } from './service-calendar.js';
import { HEADWAY_HORIZON_MS, timetableHeadwayEvidence } from './headway-evidence.js';
import type { HeadwayEvidence } from '../../shared/domain/types.js';

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

/** Departures at the boarding station that call at the next station within 30 minutes: every train of the travel
 * direction, wherever it ends. Enough for a boarding's wait; a ride's own table still needs the alighting station. */
export function connectNextRows(
  tables: Row[][],
  date: string,
  line: string,
  stationCodes: string[],
  day: string,
  direction: '1' | '2',
): number[] {
  if (
    tables.length !== 2 ||
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
  const next = new Map<string, Row[]>();

  for (const row of tables[1]) {
    next.set(identity(row), [...(next.get(identity(row)) ?? []), row]);
  }

  return tables[0].flatMap((row) => {
    const departureAt = timetableTime(row.LEFTTIME, date);

    if (departureAt === null || !text(row.TRAIN_NO)) {
      return [];
    }

    const calls = (next.get(identity(row)) ?? [])
      .map((value) => timetableTime(value.ARRIVETIME, date))
      .filter(
        (value): value is number =>
          value !== null && value > departureAt && value - departureAt < 30 * 60000,
      );

    return calls.length === 1 ? [departureAt] : [];
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
    // Station tables are cached for six hours and shared by every ride through them, so most searches spend far less.
    let remaining = Math.max(0, Math.min(40, this.options.maxQueries ?? 30));
    // Service-date clocks can be frozen for replay or adjusted by NTP. Query time limits use elapsed time.
    const monotonic = this.options.monotonic ?? (() => performance.now()),
      deadline = monotonic() + 6000;
    const serviceDay = this.options.calendar ?? koreanServiceDay;
    const checkedAt = this.now(),
      date = subwayServiceDate(at),
      calendar = serviceDay(date, checkedAt);
    const lookups = new Map<
      string,
      Promise<{ timetable?: SubwayTimetable; scheduleCheck: ScheduleCheck }>
    >();
    const check = (reason: ScheduleCheck['reason']): { scheduleCheck: ScheduleCheck } => ({
      scheduleCheck: { provider: 'seoul-metro-timetable', checkedAt, status: 'unverified', reason },
    });
    /** A cached table, a newly started request that spent one query, or 'budget' when none may be started. */
    const start = (
      key: string,
      service: string,
      args: string[],
      ttl: number,
    ): Promise<Row[]> | 'budget' => {
      const cached = this.cache.get(key);
      if (cached && cached.expires > this.now()) return cached.value;
      if (remaining <= 0 || monotonic() >= deadline) return 'budget';
      remaining--;
      if (this.cache.size > 128)
        for (const key of this.cache.keys()) {
          this.cache.delete(key);
          if (this.cache.size <= 96) break;
        }
      const value = this.rows(service, args);
      this.cache.set(key, { expires: this.now() + ttl, value });
      value.catch(() => {
        if (this.cache.get(key)?.value === value) this.cache.delete(key);
      });
      return value;
    };
    const load = async (
      key: string,
      service: string,
      args: string[],
      ttl: number,
    ): Promise<Row[]> => {
      const value = start(key, service, args, ttl);
      if (value === 'budget') throw new Error('budget');
      return value;
    };
    const failed = (error: unknown) =>
      check(
        error instanceof Error && error.message === 'budget'
          ? 'budget'
          : error instanceof FeedError && error.reason === 'format'
            ? 'incomplete'
            : 'unavailable',
      );
    /** Checks that need no table; null when the ride needs the station tables. */
    const precheck = (segment: BaseSegment) => {
      if (!this.configured) return check('unconfigured');
      if (!calendar) return check('calendar-unverified');
      if (date !== subwayServiceDate(checkedAt)) return check('unsupported');
      if (this.blockedUntil > this.now()) return check('unavailable');
      const stops = segment.transit?.stops,
        lines = segment.transit?.lines ?? [];
      const ids = [...new Set(lines.map(subwayLineId).filter(Boolean))];
      const id = ids[0],
        line = id ? subwayLineName(id) : null;
      // OA-101 answers only for lines 1-9 (공항철도, 수인분당선 return INFO-200). Other lines (GTX-A, 경의중앙선, 공항철도,
      // 수인분당선, 신분당선, 경춘선, 우이신설선, 서해선, 신림선, ...) have no published-table source here: their boarding
      // waits stay on the time-of-day rule, and only a listed 막차 in the live arrivals ends their continuation.
      if (!stops || stops.length < 2 || ids.length !== 1 || !line || !/^[1-9]호선$/.test(line))
        return check('unsupported');
      return null;
    };
    const dayTag = (dayType: 'weekday' | 'saturday' | 'holiday') =>
      ({ weekday: '1', saturday: '2', holiday: '3' })[dayType];
    const ride = (segment: BaseSegment, master: Row[]) => {
      const stops = segment.transit!.stops!,
        line = subwayLineName(
          [...new Set((segment.transit!.lines ?? []).map(subwayLineId).filter(Boolean))][0]!,
        )!;
      const selected = [stops[0], stops[1], stops.at(-1)!].map((name) =>
        master.filter(
          (row) =>
            normalizedLine(row.LINE_NUM) === line &&
            stationBaseName(text(row.STATION_NM)) === stationBaseName(name),
        ),
      );
      if (selected.some((rows) => rows.length !== 1)) return null;
      return {
        stops,
        line,
        codes: selected.map((rows) => text(rows[0].STATION_CD)),
        tag: dayTag(calendar!.dayType),
      };
    };
    // A station table depends on the day type alone; the service date in the key only ages it out with the day.
    const tableKey = (code: string, tag: string, direction: '1' | '2', day = date) =>
      `${day}:${code}:${tag}:${direction}`;
    const fresh = (key: string) => {
      const cached = this.cache.get(key);
      return !!cached && cached.expires > this.now();
    };
    /** Whether every table of these stations in both directions is cached or can still be started. */
    const affordable = (codes: string[], tag: string, day = date) => {
      const missing = new Set(
        (['1', '2'] as const)
          .flatMap((direction) => codes.map((code) => tableKey(code, tag, direction, day)))
          .filter((key) => !fresh(key)),
      ).size;
      return missing === 0 || (missing <= remaining && monotonic() < deadline);
    };
    const publish = (
      plan: NonNullable<ReturnType<typeof ride>>,
      departures: SubwayTimetable['departures'],
      receivedAt: number,
    ) => {
      if (!departures.length) return check('incomplete');
      const validFrom = Date.parse(`${date}T05:00:00+09:00`);
      return {
        timetable: {
          provider: 'seoul-metro-timetable' as const,
          serviceDate: date,
          dayType: calendar!.dayType,
          calendarSource: calendar!.source,
          receivedAt,
          validFrom,
          validUntil: validFrom + DAY,
          line: plan.line,
          boardingStation: plan.stops[0],
          nextStation: plan.stops[1],
          alightingStation: plan.stops.at(-1)!,
          complete: true as const,
          departures: departures.sort((a, b) => a.departureAt - b.departureAt),
        },
        scheduleCheck: {
          provider: 'seoul-metro-timetable' as const,
          checkedAt,
          status: 'published' as const,
        },
      };
    };
    const lookup = async (segment: BaseSegment) => {
      const early = precheck(segment);
      if (early) return early;
      try {
        const master = await load('stations', 'SearchSTNBySubwayLineInfo', [], DAY);
        const plan = ride(segment, master);
        if (!plan) return check('unsupported');
        // Sequential directions bound peak requests; three distinct station tables share in-flight cache entries.
        const departures: SubwayTimetable['departures'] = [];
        let receivedAt = this.now();
        for (const direction of ['1', '2'] as const) {
          const tables = await Promise.all(
            plan.codes.map((code) =>
              load(
                tableKey(code, plan.tag, direction),
                'SearchSTNTimeTableByIDService',
                [code, plan.tag, direction],
                6 * 3600000,
              ),
            ),
          );
          departures.push(
            ...connectTimetableRows(tables, date, plan.line, plan.codes, plan.tag, direction),
          );
          // Retain the oldest table fetch, not the cache read time.
          receivedAt = Math.min(
            receivedAt,
            ...plan.codes.map(
              (code) => this.cache.get(tableKey(code, plan.tag, direction))!.expires - 6 * 3600000,
            ),
          );
        }
        return publish(plan, departures, receivedAt);
      } catch (error) {
        return failed(error);
      }
    };
    // Each unique ride in current route order.
    const rides = new Map<string, BaseSegment>();
    for (const route of routes)
      for (const segment of route.segments)
        if (segment.mode === 'subway' && !rides.has(JSON.stringify(segment.transit)))
          rides.set(JSON.stringify(segment.transit), segment);
    const waiting = [...rides].filter(([key, segment]) => {
      const early = precheck(segment);
      if (early) lookups.set(key, Promise.resolve(early));
      return !early;
    });
    let master: Row[] | null = null;
    if (waiting.length)
      try {
        master = await load('stations', 'SearchSTNBySubwayLineInfo', [], DAY);
      } catch (error) {
        // The first ride has failed on the station list; each later ride retries it in turn, as before.
        lookups.set(waiting[0][0], Promise.resolve(failed(error)));
        for (const [key, segment] of waiting.slice(1)) {
          const value = lookup(segment);
          lookups.set(key, value);
          await value;
        }
      }
    if (master) {
      // Start every table at once. The query cap is still spent ride by ride in route order; a ride starts its tables
      // only when all of them fit, so no query goes to a ride that cannot finish.
      for (const [key, segment] of waiting) {
        const plan = ride(segment, master);
        if (!plan) {
          lookups.set(key, Promise.resolve(check('unsupported')));
          continue;
        }
        if (!affordable(plan.codes, plan.tag)) {
          // The ride's own table no longer fits. Its boarding wait needs only the boarding and next station tables, so
          // the queries left go there rather than to a ride that cannot finish (read below from the cache).
          if (affordable(plan.codes.slice(0, 2), plan.tag)) {
            for (const direction of ['1', '2'] as const)
              for (const code of plan.codes.slice(0, 2))
                start(
                  tableKey(code, plan.tag, direction),
                  'SearchSTNTimeTableByIDService',
                  [code, plan.tag, direction],
                  6 * 3600000,
                );
          }
          lookups.set(key, Promise.resolve(check('budget')));
          continue;
        }
        const directions: (Promise<Row[]> | 'budget')[][] = [];
        for (const direction of ['1', '2'] as const) {
          const started = plan.codes.map((code) =>
            start(
              tableKey(code, plan.tag, direction),
              'SearchSTNTimeTableByIDService',
              [code, plan.tag, direction],
              6 * 3600000,
            ),
          );
          directions.push(started);
          if (started.includes('budget')) break;
        }
        lookups.set(
          key,
          (async () => {
            try {
              const departures: SubwayTimetable['departures'] = [];
              let receivedAt = this.now();
              for (const [index, direction] of (['1', '2'] as const).entries()) {
                const started = directions[index];
                const tables = await Promise.all(
                  started.map((value) =>
                    value === 'budget' ? Promise.reject(new Error('budget')) : value,
                  ),
                );
                departures.push(
                  ...connectTimetableRows(tables, date, plan.line, plan.codes, plan.tag, direction),
                );
                receivedAt = Math.min(
                  receivedAt,
                  ...plan.codes.map(
                    (code) =>
                      this.cache.get(tableKey(code, plan.tag, direction))!.expires - 6 * 3600000,
                  ),
                );
              }
              return publish(plan, departures, receivedAt);
            } catch (error) {
              return failed(error);
            }
          })(),
        );
      }
    }
    // Wait evidence belongs to the boarding station and direction, shared by rides that alight at different stations.
    // It needs only the boarding and next station tables, which a ride's own lookup has usually cached already. A ride
    // that could not afford its own table may have started them above for this evidence instead.
    /** The boarding direction's departures at the boarding station on service day `day` (day type `tag`). */
    const boardingDepartureRows = async (
      plan: NonNullable<ReturnType<typeof ride>>,
      codes: string[],
      day: string,
      tag: string,
    ) => {
      const departures: number[] = [];
      // The current day's tables serve another day of the same type: no query for a weekday followed by a weekday.
      const keyDay = tag === plan.tag ? date : day;

      for (const direction of ['1', '2'] as const) {
        const tables = await Promise.all(
          codes.map((code) =>
            load(
              tableKey(code, tag, direction, keyDay),
              'SearchSTNTimeTableByIDService',
              [code, tag, direction],
              6 * 3600000,
            ),
          ),
        );
        departures.push(...connectNextRows(tables, day, plan.line, codes, tag, direction));
      }

      return departures;
    };
    /** When the horizon runs past this service day (searches from 23:00 to 05:00), the next day's first trains: without
     * them a rider past the last train, or before 05:00, would find no train at all instead of the first one. */
    const followingDay = async (
      plan: NonNullable<ReturnType<typeof ride>>,
      codes: string[],
      validUntil: number,
    ) => {
      if (validUntil >= Math.floor(checkedAt) + HEADWAY_HORIZON_MS) {
        return undefined;
      }

      const day = subwayServiceDate(validUntil),
        type = serviceDay(day, checkedAt)?.dayType;

      if (!type) {
        return undefined;
      }

      const tag = dayTag(type);

      if (!affordable(codes, tag, tag === plan.tag ? date : day)) {
        return undefined;
      }

      try {
        return {
          departures: await boardingDepartureRows(plan, codes, day, tag),
          validUntil: validUntil + DAY,
        };
      } catch {
        return undefined;
      }
    };
    const evidence = new Map<string, Promise<HeadwayEvidence | null>>();
    const boardingKey = (segment: BaseSegment) =>
      JSON.stringify([
        segment.transit?.lines,
        segment.transit?.stops?.[0],
        segment.transit?.stops?.[1],
      ]);

    for (const [key, segment] of rides) {
      const boarding = boardingKey(segment);

      if (evidence.has(boarding)) {
        continue;
      }

      evidence.set(
        boarding,
        (async () => {
          const result = await lookups.get(key)!;

          if (
            result.scheduleCheck.reason &&
            result.scheduleCheck.reason !== 'budget' &&
            result.scheduleCheck.reason !== 'incomplete'
          ) {
            return null;
          }

          try {
            if (!master || !calendar) {
              return null;
            }

            const plan = ride(segment, master);

            if (!plan) {
              return null;
            }

            const codes = plan.codes.slice(0, 2);
            // Never start half of the four tables the wait needs.
            if (!affordable(codes, plan.tag)) throw new Error('budget');

            const departures = await boardingDepartureRows(plan, codes, date, plan.tag);
            // Every own-day table this search can afford was started in the ride loop above, so the next day's tables
            // only spend queries no own-day wait could have used.
            const validFrom = Date.parse(`${date}T05:00:00+09:00`);

            return timetableHeadwayEvidence(
              departures,
              validFrom,
              validFrom + DAY,
              Math.floor(checkedAt),
              undefined,
              await followingDay(plan, codes, validFrom + DAY),
            );
          } catch {
            const table = result.timetable;

            return table
              ? timetableHeadwayEvidence(
                  table.departures.map((row) => row.departureAt),
                  table.validFrom,
                  table.validUntil,
                  Math.floor(checkedAt),
                )
              : null;
          }
        })(),
      );
    }

    return Promise.all(
      routes.map(async (route) => ({
        ...route,
        segments: await Promise.all(
          route.segments.map(async (segment) => {
            if (segment.mode !== 'subway') {
              return segment;
            }

            const { headwayEvidence: _previous, ...rest } = segment;
            const headwayEvidence = await (evidence.get(boardingKey(segment)) ??
              Promise.resolve(null));

            return {
              ...rest,
              timetable: undefined,
              scheduledConnection: undefined,
              ...(await lookups.get(JSON.stringify(segment.transit))!),
              ...(headwayEvidence ? { headwayEvidence } : {}),
            };
          }),
        ),
      })),
    );
  }
}
