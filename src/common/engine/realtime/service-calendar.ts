import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Calendar {
  year: number;
  verifiedAt: string;
  reviewAfter: string;
  source: string;
  holidays: string[];
}

let calendar: Calendar | null = null;

try {
  calendar = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('./data/korea-holidays-2026.json', import.meta.url)),
      'utf8',
    ),
  );
} catch {
  /* Missing reviewed data never becomes an assumed weekday. */
}

/** Operator-visible review deadline; this does not extend or certify the source data. */
export function serviceCalendarStatus(now: number) {
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
