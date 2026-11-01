import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HOUR = 3_600_000;
/** Reviewed files in server/realtime/data. The subway timetable reads its own 2026 file through service-calendar.ts. */
export const KOREAN_HOLIDAY_YEARS = [2026, 2027] as const;
export const HOLIDAY_AS_SUNDAY = 'korean-public-holiday-as-sunday' as const;
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const reviewedFileSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    verifiedAt: z.string(),
    reviewAfter: z.string(),
    source: z.string().url(),
    holidays: z.array(isoDay).max(40),
  })
  .passthrough();
export interface KoreanHolidayCalendar {
  firstDate: string;
  lastDate: string;
  holidays: string[];
  reviews: { year: number; verifiedAt: number; reviewAfter: number; sha256: string }[];
}
/** What a v3 bus checkpoint carries: the holidays from its first training day through its last servable boarding. */
export interface HolidayCalendarSlice {
  rule: typeof HOLIDAY_AS_SUNDAY;
  firstDate: string;
  lastDate: string;
  holidays: string[];
}
type DayRange = Pick<HolidayCalendarSlice, 'firstDate' | 'lastDate' | 'holidays'>;

/** Consecutive years only, so a gap can never read as a year without holidays. */
export function parseKoreanHolidayFiles(texts: readonly string[]): KoreanHolidayCalendar {
  const files = texts
    .map((text) => ({
      file: reviewedFileSchema.parse(JSON.parse(text)),
      sha256: createHash('sha256').update(text).digest('hex'),
    }))
    .sort((left, right) => left.file.year - right.file.year);
  if (
    !files.length ||
    files.some(
      ({ file }, index) =>
        (index && file.year !== files[index - 1].file.year + 1) ||
        !(Date.parse(file.verifiedAt) < Date.parse(file.reviewAfter)) ||
        file.holidays.some(
          (day, at) => !day.startsWith(`${file.year}-`) || (at && day <= file.holidays[at - 1]),
        ),
    )
  )
    throw new Error('holiday-calendar');
  return {
    firstDate: `${files[0].file.year}-01-01`,
    lastDate: `${files.at(-1)!.file.year}-12-31`,
    holidays: files.flatMap(({ file }) => file.holidays),
    reviews: files.map(({ file, sha256 }) => ({
      year: file.year,
      verifiedAt: Date.parse(file.verifiedAt),
      reviewAfter: Date.parse(file.reviewAfter),
      sha256,
    })),
  };
}

let reviewed: KoreanHolidayCalendar | undefined;
/** Files the refresh job published (manifest calendars); they replace the ones shipped in the image. */
let published: KoreanHolidayCalendar | undefined;
let publishedSource: { year: number; source: string | null; reviewAfter: string | null }[] = [];

/**
 * Switches to holiday files from the model manifest, or back to the shipped ones with an empty list.
 * Invalid files throw and change nothing. Every cached day decision derives from
 * reviewedKoreanHolidays(), so replacing it here is all that "re-reading" needs.
 */
export function usePublishedKoreanHolidays(
  files: readonly {
    year: number;
    text: string;
    source?: string | null;
    reviewAfter?: string | null;
  }[],
): void {
  if (!files.length) {
    published = undefined;
    publishedSource = [];
    return;
  }
  published = parseKoreanHolidayFiles(files.map((file) => file.text));
  publishedSource = files.map((file) => ({
    year: file.year,
    source: file.source ?? null,
    reviewAfter: file.reviewAfter ?? null,
  }));
}

/** Where the holiday files in use come from, for health. */
export function koreanHolidayOrigin() {
  return published
    ? { origin: 'manifest' as const, years: publishedSource }
    : { origin: 'bundled' as const, years: [] };
}

export function reviewedKoreanHolidays(): KoreanHolidayCalendar {
  if (published) return published;
  return (reviewed ??= parseKoreanHolidayFiles(
    KOREAN_HOLIDAY_YEARS.map((year) =>
      readFileSync(
        fileURLToPath(new URL(`../realtime/data/korea-holidays-${year}.json`, import.meta.url)),
        'utf8',
      ),
    ),
  ));
}

/** Same deadline as the timetable calendar: after reviewAfter a newly designated temporary holiday may be missing. */
export function holidayReviewProblems(
  calendar: KoreanHolidayCalendar,
  firstDate: string,
  lastDate: string,
  now: number,
): string[] {
  const problems: string[] = [];
  for (let year = Number(firstDate.slice(0, 4)); year <= Number(lastDate.slice(0, 4)); year++) {
    const review = calendar.reviews.find((value) => value.year === year);
    if (!review) problems.push(`holiday-calendar-missing:${year}`);
    else if (!(now >= review.verifiedAt))
      problems.push(`holiday-calendar-not-yet-verified:${year}`);
    else if (now >= review.reviewAfter) problems.push(`holiday-calendar-review-expired:${year}`);
  }
  return problems;
}

export function holidayCalendarSlice(
  calendar: KoreanHolidayCalendar,
  firstDate: string,
  lastDate: string,
): HolidayCalendarSlice | null {
  if (firstDate > lastDate || firstDate < calendar.firstDate || lastDate > calendar.lastDate)
    return null;
  return {
    rule: HOLIDAY_AS_SUNDAY,
    firstDate,
    lastDate,
    holidays: calendar.holidays.filter((day) => day >= firstDate && day <= lastDate),
  };
}

/** KST calendar date, the same day boundary as the TOPIS hourly cells (not the 04:00 card service day). */
export const seoulDate = (at: number) => new Date(at + 9 * HOUR).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday. null means the day type is unknown and nothing may be predicted or joined. */
export type SeoulWeekday = (at: number) => number | null;
export const calendarWeekday: SeoulWeekday = (at) => {
  const day = new Date(at + 9 * HOUR).getUTCDay();
  return Number.isNaN(day) ? null : day;
};
/** Named public and substitute holidays run like Sundays: lighter roads and the Sunday/holiday bus timetable. */
export function holidayAsSunday(range: DayRange): SeoulWeekday {
  return (at) => {
    const day = calendarWeekday(at);
    if (day === null) return null;
    const date = seoulDate(at);
    return date < range.firstDate || date > range.lastDate
      ? null
      : range.holidays.includes(date)
        ? 0
        : day;
  };
}
export const weekTypeOf = (weekday: number) =>
  weekday === 0
    ? ('sunday' as const)
    : weekday === 6
      ? ('saturday' as const)
      : ('weekday' as const);
