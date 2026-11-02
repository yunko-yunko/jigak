import type { TaimsIndex } from './taims';
import { addDays, DAY, HOUR, kstDate, serviceDayStart } from './util';

/** Cloud Scheduler: 05:30, 09:30 and 13:30 Asia/Seoul. T-DATA publishes at an unknown time of the morning. */
export const SCHEDULE = { cron: '30 5,9,13 * * *', timeZone: 'Asia/Seoul', hoursKst: [5, 9, 13], minute: 30 } as const;
export const WEEKLY_MODEL_OPENS_HOURS = 120;
export const ALERT_REMAINING_HOURS = 48;
export const BICYCLE_RENEW_DAYS = 10;
export const WINDOW_DAYS = 14;
export const BORROW_LOOKBACK_DAYS = 7;
export const ROUTE_TABLE_HISTORY = 3;

export function nextScheduledAt(now: number, schedule: { hoursKst: readonly number[]; minute: number } = SCHEDULE): number {
  const today = kstDate(now);
  for (const offset of [0, 1]) {
    const day = addDays(today, offset);
    for (const hour of schedule.hoursKst) {
      const at = Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}:00+09:00`);
      if (at > now) return at;
    }
  }
  throw new Error('schedule');
}
export const nextScheduledAfter = (at: number, now: number) => nextScheduledAt(Math.max(at, now) - 1);
export const refreshOpensAt = (expiresAt: number) => expiresAt - WEEKLY_MODEL_OPENS_HOURS * HOUR;

/** The 14 service days ending on the evaluation day, and the trainer window strings derived from them. */
export function trainingWindow(evaluationDate: string) {
  const first = addDays(evaluationDate, -(WINDOW_DAYS - 1));
  const dates = Array.from({ length: WINDOW_DAYS }, (_, index) => addDays(first, index));
  // Same shape as the 10-31 refresh: tune +3 days, train +3, six calibration days (always both weekday and weekend), one evaluation day.
  const tune = addDays(evaluationDate, -10), train = addDays(evaluationDate, -7), calibration = addDays(evaluationDate, -1);
  return {
    evaluationDate, first, dates, publicBusWindowStart: first,
    spatialBusWindow: [first, tune, train, calibration, evaluationDate].join(':'),
    railGateWindow: [first, tune, train, calibration, evaluationDate].join(','),
  };
}

export interface RouteTablePlan { ok: boolean; reason?: string; fallbacks: { date: string; borrowedFrom: string; checkedAgainst: string[]; nextDay: string | null }[]; references: string[] }
/**
 * Index-only preflight of the nearest-consistent policy: every window day without a route table needs a table from the
 * nearest earlier day within 7 days, and that table plus the two tables before it must exist to be compared.
 * The comparison of the tables themselves happens in preparation, before any evaluation day is written.
 */
export function planRouteTables(index: TaimsIndex, dates: string[], policy: 'strict' | 'nearest-consistent'): RouteTablePlan {
  const byDate = new Map(Object.values(index.archives).filter(entry => entry.zipOk).map(entry => [entry.serviceDate, entry]));
  const withTable = [...byDate.values()].filter(entry => entry.hasRouteTable).map(entry => entry.serviceDate).sort();
  const fallbacks: RouteTablePlan['fallbacks'] = [], references = new Set<string>();
  for (const date of dates) {
    if (byDate.get(date)?.hasRouteTable) continue;
    if (policy === 'strict') {
      const neighbours = [addDays(date, -1), addDays(date, 1)];
      if (!neighbours.every(day => dates.includes(day) && byDate.get(day)?.hasRouteTable)) return { ok: false, reason: `route-table-neighbors-unavailable:${date}`, fallbacks, references: [] };
      fallbacks.push({ date, borrowedFrom: neighbours[0], checkedAgainst: [neighbours[1]], nextDay: neighbours[1] });
      continue;
    }
    const earlier = withTable.filter(day => day < date && day >= addDays(date, -BORROW_LOOKBACK_DAYS));
    const borrowedFrom = earlier.at(-1);
    if (!borrowedFrom) return { ok: false, reason: `route-table-unavailable:${date}`, fallbacks, references: [] };
    const history = withTable.filter(day => day < borrowedFrom && day >= addDays(borrowedFrom, -WINDOW_DAYS)).slice(-(ROUTE_TABLE_HISTORY - 1));
    if (history.length < ROUTE_TABLE_HISTORY - 1) return { ok: false, reason: `route-table-history-insufficient:${date}`, fallbacks, references: [] };
    const next = withTable.find(day => day > date && day <= addDays(date, BORROW_LOOKBACK_DAYS) && dates.includes(day)) ?? null;
    for (const day of [borrowedFrom, ...history]) if (!dates.includes(day)) references.add(day);
    fallbacks.push({ date, borrowedFrom, checkedAgainst: history, nextDay: next });
  }
  return { ok: true, fallbacks, references: [...references].sort() };
}

export interface EvaluationChoice { evaluationDate: string | null; reason?: string; considered: { date: string; reason: string }[] }
/**
 * Newest service day whose full 14-day window is on hand, that is after the incumbents' evaluation days, unused in every
 * journal and not closed by an earlier failed gate. Nothing is written by this choice.
 */
export function chooseEvaluationDate(options: {
  index: TaimsIndex; now: number; incumbentDates: (string | null)[]; usedDates: Set<string>; closedDates: Set<string>;
  /** Days whose attempt is still open (a member crashed): already "used" by that very attempt, and exactly the ones to resume. */
  resumableDates?: Set<string>;
  policy: 'strict' | 'nearest-consistent'; latestPublished?: string | null;
}): EvaluationChoice {
  const available = new Set(Object.values(options.index.archives).filter(entry => entry.zipOk).map(entry => entry.serviceDate));
  const latest = [...available, options.latestPublished ?? ''].filter(Boolean).sort().at(-1);
  const considered: EvaluationChoice['considered'] = [];
  if (!latest) return { evaluationDate: null, reason: 'no-archives', considered };
  const floor = options.incumbentDates.filter((value): value is string => !!value).sort().at(-1) ?? '0000-00-00';
  for (let date = latest; date > floor && considered.length < 10; date = addDays(date, -1)) {
    if (options.closedDates.has(date)) { considered.push({ date, reason: 'closed' }); continue; }
    if (options.usedDates.has(date) && !options.resumableDates?.has(date)) { considered.push({ date, reason: 'evaluation-day-already-used' }); continue; }
    const window = trainingWindow(date), missing = window.dates.filter(day => !available.has(day));
    if (missing.length) { considered.push({ date, reason: `window-incomplete:${missing.length}` }); continue; }
    const tables = planRouteTables(options.index, window.dates, options.policy);
    if (!tables.ok) { considered.push({ date, reason: tables.reason! }); continue; }
    return { evaluationDate: date, considered };
  }
  return { evaluationDate: null, reason: considered.length ? considered[0].reason : `no-day-after-${floor}`, considered };
}

/** Reproduction replays held-out rides through the runtime, which refuses departures older than 7 days. */
export const publicBusReproducible = (evaluationDate: string, at: number) => at - serviceDayStart(evaluationDate) < 7 * DAY - HOUR;

export interface ModelTiming { key: string; expiresAt: number | null; refreshOpensAt: number | null; due: boolean; remainingHours: number | null; expired: boolean; atRisk: boolean }
export function weeklyTiming(key: string, expiresAt: number | null | undefined, now: number): ModelTiming {
  if (!expiresAt) return { key, expiresAt: null, refreshOpensAt: null, due: true, remainingHours: null, expired: true, atRisk: true };
  const opens = refreshOpensAt(expiresAt), remaining = (expiresAt - now) / HOUR;
  return { key, expiresAt, refreshOpensAt: opens, due: now >= opens, remainingHours: Math.round(remaining * 10) / 10, expired: remaining <= 0, atRisk: remaining < ALERT_REMAINING_HOURS };
}
