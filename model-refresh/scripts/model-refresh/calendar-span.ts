import { holidayReviewProblems, seoulDate, type KoreanHolidayCalendar } from '../../../src/common/engine/intelligence/korean-holidays';

const HOUR = 3_600_000, DAY = 86_400_000;
/** The most the manifest may extend a model to, counted from the day it was trained. */
export const MAX_MODEL_AGE_MS = 28 * DAY;
/** Late service a request may still board: the promoters keep the calendar through seoulDate(expiresAt + 4 h). */
export const LATE_SERVICE_MS = 4 * HOUR;

/**
 * Last date of the holiday slice a weekly checkpoint carries: through the last boarding the manifest may ever extend it to
 * (trainedAt + 28 days, + 4 h of late service), as far as reviewed years reach. A year that is missing or past its review is
 * left out of the extension; the model's own 7-day life is never shortened (the promoter refuses that range as before).
 */
export function servingCalendarLastDate(holidays: KoreanHolidayCalendar, firstDate: string, trainedAt: number, expiresAt: number, now: number): string {
  const required = seoulDate(expiresAt + LATE_SERVICE_MS);
  let last = seoulDate(trainedAt + MAX_MODEL_AGE_MS + LATE_SERVICE_MS);
  while (last > required && (last > holidays.lastDate || holidayReviewProblems(holidays, firstDate, last, now).length)) last = `${Number(last.slice(0, 4)) - 1}-12-31`;
  return last > required ? last : required;
}

/**
 * The latest expiry the holiday calendar inside a checkpoint allows: a request then may board up to LATE_SERVICE_MS later and
 * must still find its day type, so 4 h before KST midnight after the calendar's last date. A file whose own life keeps less
 * margin (the bicycle model ends at that midnight) keeps its own life. null without a calendar.
 */
export function calendarEndOf(model: unknown): { lastDate: string; endsAt: number } | null {
  const value = model as { expiresAt?: unknown; calendar?: { lastDate?: unknown } } | null, lastDate = value?.calendar?.lastDate;
  if (typeof lastDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) return null;
  const midnight = Date.parse(`${lastDate}T00:00:00+09:00`) + DAY, own = typeof value?.expiresAt === 'number' ? value.expiresAt : -Infinity;
  return Number.isFinite(midnight) ? { lastDate, endsAt: Math.max(Math.min(own, midnight), midnight - LATE_SERVICE_MS) } : null;
}
