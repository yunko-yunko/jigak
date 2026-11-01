import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASSUMPTIONS } from './assumptions.js';

export const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000,
  KST = 9 * HOUR,
  SERVICE_DAY_START = ASSUMPTIONS.clock.serviceDayStartHour * HOUR;

export type DayType = 'weekday' | 'weekend';

export const dataFile = (name: string) =>
  fileURLToPath(new URL(`../realtime/data/${name}`, import.meta.url));

let holidays: Set<string> | null = null;

function loadHolidays(): Set<string> {
  const dates = new Set<string>();
  for (const year of [2026, 2027]) {
    try {
      const calendar = JSON.parse(
        readFileSync(dataFile(`korea-holidays-${year}.json`), 'utf8'),
      ) as { holidays?: unknown };
      if (Array.isArray(calendar.holidays))
        for (const date of calendar.holidays) if (typeof date === 'string') dates.add(date);
    } catch {
      /* A missing calendar year only means its holidays count as ordinary days. */
    }
  }
  return dates;
}

/** Days since 1970-01-01 of the KST calendar date containing `time`. */
export const kstDateIndex = (time: number) => Math.floor((time + KST) / DAY);

export const dateOfIndex = (index: number) => new Date(index * DAY).toISOString().slice(0, 10);

interface DateFacts {
  dayType: DayType;
  month: number;
  winter: boolean;
}
/** Facts per KST date, computed once: hot paths ask for them millions of times. */
const facts = new Map<number, DateFacts>();

function dateFacts(index: number): DateFacts {
  let found = facts.get(index);
  if (!found) {
    // 1970-01-01 was a Thursday.
    const weekday = (((index + 4) % 7) + 7) % 7;
    holidays ??= loadHolidays();
    const month = new Date(index * DAY).getUTCMonth() + 1;
    found = {
      dayType:
        weekday === 0 || weekday === 6 || holidays.has(dateOfIndex(index)) ? 'weekend' : 'weekday',
      month,
      winter: (ASSUMPTIONS.battery.winterMonths as readonly number[]).includes(month),
    };
    facts.set(index, found);
  }
  return found;
}

/** Weekends and Korean public holidays share the weekend tables. */
export const dayTypeOfIndex = (index: number): DayType => dateFacts(index).dayType;

/**
 * The demand tables are filed by calendar date, so 00–03 after a Friday rides like Saturday:
 * the day type of an instant is its KST calendar date's.
 */
export const dayTypeAt = (time: number) => dateFacts(kstDateIndex(time)).dayType;

/** KST clock hour 0..23. */
export const kstHour = (time: number) => Math.floor(((((time + KST) % DAY) + DAY) % DAY) / HOUR);

/** Absolute KST hour number, a key for hourly arrivals. */
export const absoluteHour = (time: number) => Math.floor((time + KST) / HOUR);

/** KST calendar month 1..12. */
export const monthAt = (time: number) => dateFacts(kstDateIndex(time)).month;

export const isWinter = (time: number) => dateFacts(kstDateIndex(time)).winter;

/** KST midnight of the calendar date with this index. */
export const midnightOfIndex = (index: number) => index * DAY - KST;

/** Is `hour` inside the band [first, last], where a band like 22–04 wraps midnight. */
export const inHourBand = (hour: number, first: number, last: number) =>
  first <= last ? hour >= first && hour <= last : hour >= first || hour <= last;

export interface ServiceDay {
  date: string;
  startsAt: number;
  endsAt: number;
  dayType: DayType;
}

/** The KST service day containing `time`; it starts at 04:00 KST and lasts exactly 24 hours. */
export function serviceDayOf(time: number): ServiceDay {
  if (!Number.isFinite(time)) throw new RangeError('Invalid simulation time');
  const index = Math.floor((time + KST - SERVICE_DAY_START) / DAY);
  const startsAt = index * DAY - KST + SERVICE_DAY_START;
  return {
    date: dateOfIndex(index),
    startsAt,
    endsAt: startsAt + DAY,
    dayType: dayTypeOfIndex(index),
  };
}
