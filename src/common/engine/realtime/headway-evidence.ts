import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HeadwayEvidence, HeadwayWindow, SubwayTimetable } from '../../shared/domain/types.js';
import { busRouteKey } from './names.js';
import { koreanServiceDay } from './service-calendar.js';
import { withoutHomeCity, type BusSheetFacts } from './bus.js';

const MINUTE = 60_000,
  DAY = 86_400_000,
  KST = 9 * 3_600_000,
  GRID = 30 * MINUTE;
/** Evidence covers the search clock to six hours on; later clocks fall back to the rule. */
export const HEADWAY_HORIZON_MS = 6 * 3_600_000;
const MAX_WINDOWS = 48,
  MAX_WAIT_SECONDS = 7_200,
  MAX_HEADWAY_SECONDS = 14_400,
  MIN_WAIT_SECONDS = 60;
/** Median ratio of the random-arrival wait to half the mean spacing across 596 T-DATA routes (09-17 h, Friday). */
const TERM_WAIT_FACTOR = 1.1;
/** Without a T-DATA stop offset, how long after the first origin departure the first bus may still be on its way. */
const FIRST_ARRIVAL_UNCERTAIN_MS = 90 * MINUTE;
/** The earliest first departures of Seoul day buses (KST minutes). */
const SERVICE_START_MINUTES = 240;
/** Card tags hold almost no origin departures 01:30-04:30 KST, so an absence there is not evidence of no service. */
const TAG_GAP = [90, 270] as const;
/** From 22:00 (the rule's late band) a day line that a sheet reports finished does not run again before the next
 * service day starts at 04:00. */
const LATE_EVENING_MINUTES = 1320;
/** Earlier in the day a finished line without published first and last departures may be a peak-only line that runs
 * again later the same day: the report holds for one stop-grid band, then the line is unclassified again. */
const ENDED_REPORT_MS = 30 * MINUTE;

type DayType = 'weekday' | 'saturday' | 'holiday';
/** [running clock intervals [from, to) in KST minutes, first band, waits (s), spacings (s)] */
type DispatchDay = [number[][], number, number[], number[]];
interface DispatchRoute {
  n: string;
  d: Partial<Record<DayType, DispatchDay>>;
  o: Record<string, number>;
}
interface DispatchTable {
  version: 1;
  reviewAfter: string;
  bandMinutes: number;
  routes: Record<string, DispatchRoute>;
}

let dispatch: DispatchTable | null = null;
try {
  const parsed = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('./data/bus-headways-202610.json', import.meta.url)),
      'utf8',
    ),
  ) as DispatchTable;
  if (
    parsed?.version === 1 &&
    parsed.bandMinutes === 30 &&
    parsed.routes &&
    typeof parsed.routes === 'object'
  )
    dispatch = parsed;
} catch {
  /* Without the reviewed table, buses keep the stop sheet and the rule. */
}

/** The T-DATA dispatch table, usable until its review date. Tests may replace it. */
export function dispatchTable(now: number): DispatchTable | null {
  return dispatch && now < Date.parse(dispatch.reviewAfter) ? dispatch : null;
}
export function setDispatchTableForTest(table: DispatchTable | null) {
  dispatch = table;
}

const kstMidnight = (at: number) => Math.floor((at + KST) / DAY) * DAY - KST;
const kstDate = (at: number) => new Date(at + KST).toISOString().slice(0, 10);
const clockMinutes = (at: number) => (at - kstMidnight(at)) / MINUTE;
const gridStart = (at: number) => Math.floor((at + KST) / GRID) * GRID - KST;

type LineState =
  | { kind: 'running'; wait: number; headway: number; basis: HeadwayEvidence['basis'] }
  | { kind: 'not-running' }
  | { kind: 'unknown' };
interface LineModel {
  name: string;
  routeId?: string;
  reason: string;
  state(at: number): LineState;
  /** Clocks in [from, to] where `state` can change. */
  edges(from: number, to: number): number[];
}

const NIGHT = /\(심야\)|^N\d+|^심야A|^이음/i;
/** Service restrictions that Kakao exposes only in a line's name: the hours (wide, from T-DATA observation) and the
 * day types. Null when the name restricts nothing of that kind or the calendar cannot tell the day type.
 *
 * The day type is the operating day's, not the calendar date's: service after midnight belongs to the previous day
 * until that day's service ends. A night line's day runs to 05:00, the end of its hours; a 새벽A line's day starts with
 * its first departures at 03:30; every other line's day starts at 04:00 (`SERVICE_START_MINUTES`). So a (평일) line
 * still runs at 00:30 after a Friday and does not run at 00:30 after a Sunday. */
function nameRule(
  name: string,
  at: number,
  now: number,
): { hours: boolean | null; day: boolean | null } {
  const minutes = clockMinutes(at);
  const within = (from: number, to: number) =>
    from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  const key = name.normalize('NFC').replace(/\s+/g, '');
  const night = NIGHT.test(key),
    dawn = /^새벽A/.test(key);
  const hours = night
    ? within(1380, 300)
    : dawn
      ? within(210, 360)
      : /\(출근\)/.test(key)
        ? within(330, 600)
        : /\(퇴근\)/.test(key)
          ? within(960, 1260)
          : null;
  const days = /\((출근|퇴근|평일)\)/.test(key)
    ? ['weekday']
    : /\(공휴일제외\)/.test(key)
      ? ['weekday', 'saturday']
      : /\(주말\)/.test(key)
        ? ['saturday', 'holiday']
        : null;
  const dayStarts = night ? 300 : dawn ? 210 : SERVICE_START_MINUTES;
  const dayType = days
    ? koreanServiceDay(kstDate(at - dayStarts * MINUTE), now)?.dayType
    : undefined;
  return { hours, day: days && dayType ? days.includes(dayType) : null };
}
const nameRuleEdges = (from: number, to: number) =>
  dailyEdges(from, to, [0, 210, SERVICE_START_MINUTES, 300, 330, 360, 600, 960, 1260, 1380]);
function dailyEdges(from: number, to: number, minutes: readonly number[], offset = 0): number[] {
  const edges: number[] = [];
  for (let day = kstMidnight(from - offset) - DAY; day <= to - offset + DAY; day += DAY)
    for (const minute of minutes) {
      const edge = day + minute * MINUTE + offset;
      if (edge >= from && edge <= to) edges.push(edge);
    }
  return edges;
}

/** One line at a Seoul stop: stop sheet first, then the T-DATA table, then name rules; unknown otherwise. */
export function busLineModel(
  name: string,
  sheet: (BusSheetFacts & { ended?: boolean }) | undefined,
  now: number,
): LineModel {
  const table = dispatchTable(now);
  const route = sheet?.routeId ? table?.routes[sheet.routeId] : undefined;
  const offsetMinutes = route && sheet?.stopId ? route.o[sheet.stopId] : undefined;
  const offset = (offsetMinutes ?? 0) * MINUTE;
  const dayType = (at: number): DayType | null =>
    koreanServiceDay(kstDate(at), now)?.dayType ?? null;
  // T-DATA: whether the route runs at origin clock `origin`, and the band value of a stop grid cell.
  const tdataRuns = (origin: number): boolean | null => {
    if (!route || offsetMinutes === undefined) return null;
    const type = dayType(origin);
    if (!type) return null;
    const minutes = clockMinutes(origin);
    const runs = !!route.d[type]?.[0].some(([low, high]) => minutes >= low && minutes < high);
    return runs || (minutes >= TAG_GAP[0] && minutes < TAG_GAP[1]) ? runs || null : false;
  };
  const tdataValue = (at: number): { wait: number; headway: number } | null => {
    if (!route || offsetMinutes === undefined) return null;
    const middle = gridStart(at) + GRID / 2 - offset,
      type = dayType(middle),
      day = type ? route.d[type] : undefined;
    if (!day) return null;
    const index = Math.floor(clockMinutes(middle) / 30) - day[1];
    const wait = day[2][index],
      headway = day[3][index];
    return wait > 0 && headway > 0 ? { wait, headway } : null;
  };
  // Stop sheet: published first and last origin departures, shifted by the stop's T-DATA offset when known.
  const first = sheet?.firstMinute,
    last = sheet?.lastMinute;
  const span =
    first !== undefined && last !== undefined
      ? { first, last: last > first ? last : last + 1440 }
      : null;
  const sheetRuns = (at: number): boolean | null => {
    if (!span) return null;
    for (let day = kstMidnight(at - offset) - DAY; day <= at; day += DAY) {
      const start = day + span.first * MINUTE + offset,
        end = day + span.last * MINUTE + offset;
      // Without the stop's offset the first bus reaches it some time after the first origin departure.
      if (offsetMinutes === undefined && at >= start && at < start + FIRST_ARRIVAL_UNCERTAIN_MS)
        return null;
      if (at >= start && at < end) return true;
      // Past the last origin departure the bus still reaches a stop further on; without the offset that is unknown.
      if (offsetMinutes === undefined && at >= end && at < end + 3 * 3_600_000 && at < start + DAY)
        return null;
    }
    return false;
  };
  // A sheet that reports the line finished now: not running until `endedUntil`, then classified as if no report had
  // come (sheet span, T-DATA, name), which is unknown when nothing else is known. With a published first departure the
  // report holds until it. Without one, it holds to the next service day (04:00) when the report comes late in the
  // evening or overnight, and otherwise only for `ENDED_REPORT_MS`: a day-time report says nothing about the evening.
  const endedUntil = ((): number | null => {
    if (!sheet?.ended) return null;
    if (span) {
      for (let day = kstMidnight(now - offset) - DAY; ; day += DAY) {
        const start = day + span.first * MINUTE + offset;
        if (start > now) return start;
      }
    }
    const minutes = clockMinutes(now);
    if (minutes >= SERVICE_START_MINUTES && minutes < LATE_EVENING_MINUTES)
      return now + ENDED_REPORT_MS;
    for (let day = kstMidnight(now) - DAY; ; day += DAY) {
      const start = day + SERVICE_START_MINUTES * MINUTE;
      if (start > now) return start;
    }
  })();
  const term = sheet?.termMinutes;
  const reasons: string[] = [];
  if (sheet) reasons.push('topis-sheet');
  if (route && offsetMinutes !== undefined) reasons.push('tdata');
  return {
    name,
    routeId: sheet?.routeId,
    reason: reasons.join('+') || 'name-rule',
    state(at) {
      const value = (): LineState => {
        const band = tdataValue(at);
        return band
          ? { kind: 'running', ...band, basis: 'tdata-dispatch' }
          : term
            ? termState(term)
            : { kind: 'unknown' };
      };
      if (endedUntil !== null && at < endedUntil) return { kind: 'not-running' };
      const type = dayType(at - offset),
        tdataKnown = !!route && offsetMinutes !== undefined && !!type;
      const named = nameRule(name, at, now);
      // Day types: T-DATA saw the route on this day type or not; without it, the name's day restriction.
      if (tdataKnown ? !route!.d[type!] : named.day === false) return { kind: 'not-running' };
      // Hours: the sheet's published span, then the T-DATA running intervals, then the name's assumed hours.
      const runs = sheetRuns(at) ?? tdataRuns(at - offset) ?? named.hours;
      if (runs === null) return { kind: 'unknown' };
      return runs ? value() : { kind: 'not-running' };
    },
    edges(from, to) {
      const edges = [...nameRuleEdges(from, to)];
      if (span)
        edges.push(
          ...dailyEdges(
            from,
            to,
            [
              span.first,
              span.first + FIRST_ARRIVAL_UNCERTAIN_MS / MINUTE,
              span.last,
              span.last + 180,
            ].map((minute) => minute % 1440),
            offset,
          ),
        );
      if (endedUntil !== null && endedUntil >= from && endedUntil <= to) edges.push(endedUntil);
      if (route && offsetMinutes !== undefined) {
        const minutes = new Set<number>([0, ...TAG_GAP]);
        for (const day of Object.values(route.d))
          for (const [low, high] of day![0]) {
            minutes.add(low);
            minutes.add(high % 1440);
          }
        edges.push(...dailyEdges(from, to, [...minutes], offset));
      }
      return edges;
    },
  };
}
const termState = (term: number): LineState => ({
  kind: 'running',
  wait: Math.round(term * TERM_WAIT_FACTOR * 30),
  headway: Math.round(term * TERM_WAIT_FACTOR * 60),
  basis: 'topis-term',
});

const BASIS_ORDER: HeadwayEvidence['basis'][] = [
  'published-timetable',
  'tdata-dispatch',
  'operator-headway',
  'topis-term',
  'rule',
];
const RULE_MINUTES = [360, 420, 570, 1050, 1200, 1320];
/** The bus rule wait for `count` listed lines: the same figures as the shared rule. */
function busRuleWait(at: number, count: number): number {
  const minutes = Math.floor(clockMinutes(at));
  const peak = (minutes >= 420 && minutes < 570) || (minutes >= 1050 && minutes < 1200);
  const late = minutes >= 1320 || minutes < 360;
  return Math.max(120, Math.round((peak ? 300 : late ? 480 : 360) / Math.max(1, count)));
}

/** Expected wait of a rider reaching the stop at a random clock when every line runs as an independent periodic stream
 * whose own random-arrival wait is Wᵢ: each line is a period Hᵢ = 2Wᵢ at a uniform random phase, so the rider waits
 * longer than t for all of them with probability Π(1 − t/Hᵢ)⁺ and E[wait] = ∫₀^min Hᵢ Π(1 − t/Hᵢ) dt. One line gives
 * back Wᵢ exactly. Seoul dispatch is near periodic (T-DATA W/H ≈ 0.52), so the Poisson merge 1/Σ(1/Wᵢ) would be
 * 35-80 s short for two to five lines at 10-20 minute spacing. The integrand is a polynomial of degree n; composite
 * Simpson on 256 panels is exact to well under a second for any n here. */
export function mergedPeriodicWait(waits: readonly number[]): number {
  if (!waits.length) return NaN;
  if (waits.length === 1) return waits[0];
  const periods = waits.map((wait) => 2 * wait),
    end = Math.min(...periods),
    panels = 256,
    step = end / panels;
  const survival = (t: number) =>
    periods.reduce((product, period) => product * Math.max(0, 1 - t / period), 1);
  let sum = survival(0) + survival(end);
  for (let index = 1; index < panels; index++) sum += (index % 2 ? 4 : 2) * survival(index * step);
  return (sum * step) / 3;
}

/** Merge line states into windows over [from, from + horizon). Running lines combine as independent periodic streams
 * (`mergedPeriodicWait`); their mean spacing is 1 / Σ 1/Hᵢ, the merged vehicle rate. A window where only unclassified
 * lines may run keeps the rule for those lines alone. Null when no line was classified anywhere, so the rule applies
 * unchanged. Every value is a whole second, so the app reads exactly what the server planned with. */
export function mergeLineWindows(
  lines: LineModel[],
  from: number,
  now: number,
  horizon = HEADWAY_HORIZON_MS,
): HeadwayEvidence | null {
  if (!lines.length || !Number.isSafeInteger(from)) return null;
  const to = from + horizon;
  const cuts = new Set<number>([from, to]);
  for (let grid = gridStart(from) + GRID; grid < to; grid += GRID) cuts.add(grid);
  for (const edge of dailyEdges(from, to, RULE_MINUTES)) cuts.add(edge);
  for (const line of lines)
    for (const edge of line.edges(from, to))
      if (edge > from && edge < to) cuts.add(Math.round(edge));
  const points = [...cuts].sort((a, b) => a - b);
  const windows: HeadwayWindow[] = [];
  const bases = new Set<HeadwayEvidence['basis']>();
  let classified = false;
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index],
      end = points[index + 1];
    const states = lines.map((line) => line.state(start));
    const running = states.flatMap((state) =>
      state.kind === 'running' &&
      state.wait <= MAX_WAIT_SECONDS &&
      state.headway <= MAX_HEADWAY_SECONDS
        ? [state]
        : [],
    );
    if (states.some((state) => state.kind !== 'unknown')) classified = true;
    let waitSeconds: number | null, headwaySeconds: number | null;
    if (running.length) {
      waitSeconds = Math.max(
        MIN_WAIT_SECONDS,
        Math.round(mergedPeriodicWait(running.map((state) => state.wait))),
      );
      headwaySeconds = Math.max(
        1,
        Math.round(1 / running.reduce((sum, state) => sum + 1 / state.headway, 0)),
      );
      for (const state of running) bases.add(state.basis);
    } else if (states.every((state) => state.kind === 'not-running')) {
      waitSeconds = headwaySeconds = null;
    } else {
      waitSeconds = busRuleWait(
        start,
        states.filter((state) => state.kind !== 'not-running').length,
      );
      headwaySeconds = 2 * waitSeconds;
      bases.add('rule');
    }
    const previous = windows.at(-1);
    if (
      previous &&
      previous.waitSeconds === waitSeconds &&
      previous.headwaySeconds === headwaySeconds
    )
      previous.to = end;
    else windows.push({ from: start, to: end, waitSeconds, headwaySeconds });
  }
  if (!classified || !windows.length) return null;
  // A cut-off horizon must not read as "no later service": drop trailing idle windows of a truncated list.
  if (windows.length > MAX_WINDOWS) {
    windows.length = MAX_WINDOWS;
    while (windows.length && windows.at(-1)!.waitSeconds === null) windows.pop();
    if (!windows.length) return null;
  }
  const basis = BASIS_ORDER.find((value) => bases.has(value)) ?? 'rule';
  return {
    version: 1,
    basis,
    derivedAt: now,
    windows,
    lines: lines.slice(0, 30).map((line) => {
      const state = line.state(from);
      return {
        name: line.name.slice(0, 128),
        ...(line.routeId ? { routeId: line.routeId.slice(0, 32) } : {}),
        status: state.kind,
        reason: line.reason.slice(0, 64),
      };
    }),
  };
}

/** Kakao line names against TOPIS rtNm: drop any service-restriction label and a TOPIS home-city suffix, e.g.
 * "8101(출근)" → "8101", "1000고양" → "1000". */
export const sheetLineKey = (name: string) =>
  busRouteKey(withoutHomeCity(name.replace(/\([^)]*\)/g, '')));

/** Headway evidence of one bus boarding from its stop sheet rows (already filtered to the boarding direction). */
export function busHeadwayEvidence(
  lines: string[],
  sheet: Map<string, BusSheetFacts & { ended?: boolean }> | null,
  now: number,
): HeadwayEvidence | null {
  if (!lines.length) return null;
  const models = lines.map((line) => busLineModel(line, sheet?.get(sheetLineKey(line)), now));
  // Windows start on the 30-minute grid at or before the search clock, so the planner's own clock is always covered.
  return mergeLineWindows(models, gridStart(Math.floor(now)), now);
}

/** Headway evidence of a subway boarding from one direction's published departures at the boarding station. The
 * windows give the exact random-arrival wait for each piece; after the last train of the service day nothing runs.
 * `following` is the next service day's departures (its day starts where this one ends, at `validUntil`): between the
 * last train and its first train the windows are idle, so a rider there waits for that first train, and the evidence
 * runs on to the horizon. Without it the evidence ends with this service day. */
export function timetableHeadwayEvidence(
  departures: number[],
  validFrom: number,
  validUntil: number,
  now: number,
  horizon = HEADWAY_HORIZON_MS,
  following?: { departures: number[]; validUntil: number },
): HeadwayEvidence | null {
  const ordered = (values: number[]) =>
    [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
  const own = ordered(departures);
  if (!own.length || !Number.isSafeInteger(now) || now < validFrom || now >= validUntil)
    return null;
  const next =
    following && following.validUntil > validUntil
      ? ordered(following.departures).filter((at) => at >= validUntil && at < following.validUntil)
      : [];
  // Each service day runs from its first to its last departure; a later day's trains never fill an earlier day's gap.
  const days = next.length ? [own, next] : [own],
    sorted = days.flat();
  const from = Math.max(validFrom, gridStart(now)),
    to = Math.min(next.length ? following!.validUntil : validUntil, now + horizon);
  const cuts = new Set<number>([from, to]);
  for (let grid = gridStart(from) + GRID; grid < to; grid += GRID) cuts.add(grid);
  for (const day of days)
    for (const edge of [day[0], day.at(-1)!]) if (edge > from && edge < to) cuts.add(edge);
  const points = [...cuts].sort((a, b) => a - b),
    windows: HeadwayWindow[] = [];
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index],
      end = points[index + 1];
    let waitSeconds: number | null = null,
      headwaySeconds: number | null = null;
    if (days.some((day) => start >= day[0] && start < day.at(-1)!)) {
      // ∫ (next departure − t) dt over [start, end), every rider boarding inside the service day.
      let area = 0,
        clock = start,
        count = 0;
      for (const departure of sorted) {
        if (departure < clock) continue;
        if (departure >= end) {
          area += ((departure - clock + (departure - end)) / 2) * (end - clock);
          clock = end;
          break;
        }
        area += (departure - clock) ** 2 / 2;
        clock = departure;
        count++;
      }
      if (clock >= end) {
        waitSeconds = Math.max(1, Math.round(area / (end - start) / 1000));
        headwaySeconds = Math.max(
          1,
          Math.round(count ? (end - start) / count / 1000 : 2 * waitSeconds),
        );
        if (waitSeconds > MAX_WAIT_SECONDS || headwaySeconds > MAX_HEADWAY_SECONDS)
          return windows.length ? finish() : null;
      }
    }
    const previous = windows.at(-1);
    if (
      previous &&
      previous.waitSeconds === waitSeconds &&
      previous.headwaySeconds === headwaySeconds
    )
      previous.to = end;
    else windows.push({ from: start, to: end, waitSeconds, headwaySeconds });
  }
  return finish();
  function finish(): HeadwayEvidence | null {
    // Past the last train nothing runs until the service day ends; a window list cut short says nothing about later.
    if (windows.length > MAX_WINDOWS) {
      windows.length = MAX_WINDOWS;
      while (windows.length && windows.at(-1)!.waitSeconds === null) windows.pop();
    }
    return windows.length
      ? { version: 1, basis: 'published-timetable', derivedAt: now, windows }
      : null;
  }
}

/** Departures of the boarding direction in a published table, for evidence when the full ride table is incomplete. */
export const boardingDepartures = (table: Pick<SubwayTimetable, 'departures'>) =>
  table.departures.map((row) => row.departureAt);
