import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Calendar {
  year: number;
  verifiedAt: string;
  reviewAfter: string;
  source: string;
  holidays: string[];
}

let shipped: Calendar | null = null;

try {
  shipped = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('./data/korea-holidays-2026.json', import.meta.url)),
      'utf8',
    ),
  );
} catch {
  /* Missing reviewed data never becomes an assumed weekday. */
}

/** Calendars the refresh job published, by year. While present they replace the shipped file. */
let published = new Map<number, { calendar: Calendar; source: string | null }>();

/** Takes the verified holiday files of the model manifest (see ManifestWatcher), or none to go back to the shipped file. */
export function usePublishedServiceCalendars(
  files: readonly { year: number; text: string; source?: string | null }[],
): void {
  const next = new Map<number, { calendar: Calendar; source: string | null }>();
  for (const file of files) {
    const parsed = JSON.parse(file.text) as Calendar;
    if (parsed?.year !== file.year) throw new Error('service-calendar-year');
    next.set(file.year, { calendar: parsed, source: file.source ?? null });
  }
  published = next;
}

/** The calendar for a service year (null: the KST year of now, else the newest one, which then reads as expired). */
function calendarFor(
  year: number | null,
  now: number,
): { calendar: Calendar | null; origin: string; source: string | null } {
  if (published.size) {
    const wanted = year ?? Number(new Date(now + 9 * 3_600_000).toISOString().slice(0, 4));
    const entry =
      published.get(wanted) ??
      (year === null ? [...published.entries()].sort((a, b) => b[0] - a[0])[0]?.[1] : undefined);
    return { calendar: entry?.calendar ?? null, origin: 'manifest', source: entry?.source ?? null };
  }
  return { calendar: shipped, origin: 'bundled', source: null };
}

/** Operator-visible review deadline; this does not extend or certify the source data. */
export function serviceCalendarStatus(now: number) {
  const { calendar, origin, source } = calendarFor(null, now);
  const verifiedAt = Date.parse(calendar?.verifiedAt ?? ''),
    reviewAfter = Date.parse(calendar?.reviewAfter ?? '');

  const valid =
    !!calendar &&
    Number.isInteger(calendar.year) &&
    !!calendar.source &&
    Array.isArray(calendar.holidays) &&
    [now, verifiedAt, reviewAfter].every(Number.isFinite) &&
    reviewAfter > verifiedAt;

  const usable = valid && now >= verifiedAt && now < reviewAfter;

  return {
    year: valid ? calendar!.year : null,
    verifiedAt: valid ? verifiedAt : null,
    reviewAfter: valid ? reviewAfter : null,
    usable,
    reviewDue: !usable || reviewAfter - now <= 7 * 86_400_000,
    remainingSeconds: valid ? Math.max(0, Math.floor((reviewAfter - now) / 1000)) : null,
    reason: !valid
      ? 'invalid-calendar'
      : now < verifiedAt
        ? 'not-yet-verified'
        : now >= reviewAfter
          ? 'review-expired'
          : 'reviewed',
    scope: 'reviewed-korean-service-day-calendar',
    origin,
    provenance: source,
    fallback: 'published-timetable-unverified-when-calendar-unusable',
  };
}

export function koreanServiceDay(
  serviceDate: string,
  now: number,
): {
  dayType: 'weekday' | 'saturday' | 'holiday';
  source: string;
  verifiedAt: number;
} | null {
  const calendar = calendarFor(
    /^\d{4}/.test(serviceDate) ? Number(serviceDate.slice(0, 4)) : null,
    now,
  ).calendar;
  const verifiedAt = Date.parse(calendar?.verifiedAt ?? ''),
    reviewAfter = Date.parse(calendar?.reviewAfter ?? '');

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
    !calendar ||
    Number(serviceDate.slice(0, 4)) !== calendar.year ||
    ![now, verifiedAt, reviewAfter].every(Number.isFinite) ||
    reviewAfter <= verifiedAt ||
    now < verifiedAt ||
    now >= reviewAfter ||
    !calendar.source ||
    !Array.isArray(calendar.holidays)
  ) {
    return null;
  }

  const parsed = new Date(`${serviceDate}T00:00:00Z`);

  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  if (parsed.toISOString().slice(0, 10) !== serviceDate) {
    return null;
  }

  return {
    dayType:
      calendar.holidays.includes(serviceDate) || parsed.getUTCDay() === 0
        ? 'holiday'
        : parsed.getUTCDay() === 6
          ? 'saturday'
          : 'weekday',
    source: calendar.source,
    verifiedAt,
  };
}
