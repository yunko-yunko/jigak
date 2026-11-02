/**
 * JIGAK_HOLIDAY_DIR: the folder of korea-holidays-YYYY.json the automatic refresh hands to every child step (the store's
 * calendars of this run). The API's korean-holidays.ts reads only the files shipped next to it, so each child TS script
 * imports this module first and registers the folder through usePublishedKoreanHolidays, the same switch the API uses
 * for manifest calendars. Without the variable nothing changes (the shipped 2026/2027 files).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usePublishedKoreanHolidays } from '../../src/common/engine/intelligence/korean-holidays';

export const HOLIDAY_FILE = /^korea-holidays-\d{4}\.json$/;

/** Registers the calendars of `directory`; a set but empty folder is an error, as it was in the mvp copy of korean-holidays.ts. */
export function useHolidayDirectory(directory: string | undefined) {
  if (!directory) return [];
  const names = readdirSync(directory).filter(name => HOLIDAY_FILE.test(name)).sort();
  if (!names.length) throw new Error(`holiday-calendar-missing: no korea-holidays-YYYY.json in JIGAK_HOLIDAY_DIR (${directory})`);
  const files = names.map(name => {
    const text = readFileSync(join(directory, name), 'utf8'), file = JSON.parse(text) as { year: number; source?: string; reviewAfter?: string };
    return { year: file.year, text, source: file.source ?? null, reviewAfter: file.reviewAfter ?? null };
  });
  usePublishedKoreanHolidays(files);
  return files.map(file => file.year);
}

useHolidayDirectory(process.env.JIGAK_HOLIDAY_DIR);
