const DAY = 86_400_000;
export const ORIGINAL_PUBLIC_BUS_WINDOW_START = '2026-09-28';

/** Keep the frozen 11/2/1 whole-service-day protocol while advancing its dates. */
export function publicBusTrainingWindow(start = ORIGINAL_PUBLIC_BUS_WINDOW_START) {
  const parsed = Date.parse(`${start}T00:00:00Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== start
  ) {
    throw new Error('invalid-service-window');
  }

  const dates = Array.from(
    {
      length: 14,
    },
    (_, index) => new Date(parsed + index * DAY).toISOString().slice(0, 10),
  );

  return {
    dates,
    trainThrough: dates[10],
    calibrationDates: [dates[11], dates[12]] as [string, string],
    testDates: [dates[13]] as [string],
    calibrationStart: Date.parse(`${dates[11]}T04:00:00+09:00`),
    testStart: Date.parse(`${dates[13]}T04:00:00+09:00`),
    endExclusive: Date.parse(`${dates[13]}T04:00:00+09:00`) + DAY,
  };
}
