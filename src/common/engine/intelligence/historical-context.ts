import { z } from 'zod';
import {
  calendarWeekday,
  holidayAsSunday,
  reviewedKoreanHolidays,
  weekTypeOf,
  type KoreanHolidayCalendar,
  type SeoulWeekday,
} from './korean-holidays.js';

const HOUR = 3_600_000;
const MAX_WEATHER_AGE = 3 * HOUR;
const stamp = z.number().int().positive().max(8_640_000_000_000_000);
const finiteNullable = (minimum: number, maximum: number) =>
  z.number().finite().min(minimum).max(maximum).nullable();
export const historicalWeatherObservationSchema = z
  .object({
    source: z.literal('noaa-ghcnh'),
    stationId: z.literal('KSI0000RKSL'),
    observedAt: stamp,
    temperatureC: finiteNullable(-80, 65),
    windMetersPerSecond: finiteNullable(0, 100),
    precipitationMm: finiteNullable(0, 1000),
    precipitationTrace: z.boolean(),
  })
  .strict();
export type HistoricalWeatherObservation = z.infer<typeof historicalWeatherObservationSchema>;
export interface HistoricalWeatherContext extends HistoricalWeatherObservation {
  ageSeconds: number;
  retrospective: true;
  /** The archive does not contain the original observation publication/receipt timestamps. */
  availability: 'historical-publication-unknown';
}

const weekTypeSchema = z.enum(['weekday', 'saturday', 'sunday']);
const roadCellSchema = z
  .object({
    weekType: weekTypeSchema,
    hour: z.number().int().min(0).max(23),
    speedKmh: z.number().finite().positive().max(160),
    sampleCount: z.number().int().positive().max(100_000_000),
    missingCount: z.number().int().min(0).max(100_000_000),
  })
  .strict();
export const roadPriorArchiveSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('topis-monthly'),
    referenceMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    publishedAt: stamp,
    spatialScope: z.literal('seoul-citywide'),
    aggregation: z.literal('distance-weighted-harmonic'),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    cells: z.array(roadCellSchema).min(1).max(72),
  })
  .strict()
  .superRefine((archive, context) => {
    const [year, month] = archive.referenceMonth.split('-').map(Number);
    const periodEnded = Date.UTC(year, month, 1, -9);
    if (year < 2000 || year > 2100 || archive.publishedAt < periodEnded)
      context.addIssue({ code: 'custom', message: 'archive-publication-before-period-ended' });
    const keys = new Set<string>();
    for (const cell of archive.cells) {
      const key = `${cell.weekType}:${cell.hour}`;
      if (keys.has(key)) context.addIssue({ code: 'custom', message: 'duplicate-prior-cell' });
      keys.add(key);
    }
  });
export type RoadPriorArchive = z.infer<typeof roadPriorArchiveSchema>;
export const roadPriorBundleSchema = z
  .object({
    version: z.literal('topis-road-priors-v1'),
    archives: z.array(roadPriorArchiveSchema).min(1).max(24),
  })
  .strict();
export interface PublishedRoadPrior {
  source: 'topis-monthly';
  publishedAt: number;
  referenceMonth: string;
  spatialScope: 'seoul-citywide';
  weekType: 'weekday' | 'saturday' | 'sunday';
  hour: number;
  speedKmh: number;
  sampleCount: number;
  missingCount: number;
}

/** A bounded PSV reader: quoted delimiters and escaped quotes remain data, never code. */
function parsePsv(text: string): string[][] {
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('weather-size');
  const result: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += character;
    } else if (character === '"' && field === '' && !closed) quoted = true;
    else if (character === '|' || character === '\n' || character === '\r') {
      row.push(field);
      field = '';
      closed = false;
      if (character !== '|') {
        if (row.some((value) => value.trim())) result.push(row);
        row = [];
        if (character === '\r' && text[index + 1] === '\n') index++;
      }
    } else {
      if (closed) throw new Error('weather-quoting');
      field += character;
    }
    if (field.length > 100_000 || row.length > 400 || result.length > 100_000)
      throw new Error('weather-size');
  }
  if (quoted) throw new Error('weather-quoting');
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) result.push(row);
  }
  return result;
}

/** NOAA DATE and component fields are UTC, while the bus source timestamps are KST epoch values. */
export function normalizeGhcnhPsv(text: string): HistoricalWeatherObservation[] {
  const [columns, ...raw] = parsePsv(text);
  const required = [
    'STATION',
    'DATE',
    'LATITUDE',
    'LONGITUDE',
    'temperature',
    'temperature_Quality_Code',
    'wind_speed',
    'wind_speed_Quality_Code',
    'precipitation',
    'precipitation_Quality_Code',
    'precipitation_Measurement_Code',
  ];
  if (
    !columns ||
    new Set(columns).size !== columns.length ||
    !required.every((key) => columns.includes(key))
  )
    throw new Error('weather-columns');
  const positions = new Map(columns.map((name, index) => [name, index]));
  const result: HistoricalWeatherObservation[] = [],
    seen = new Set<number>();
  for (const values of raw) {
    if (values.length !== columns.length) throw new Error('weather-columns');
    const get = (key: string) => values[positions.get(key)!]?.trim() ?? '';
    const date = get('DATE');
    if (
      get('STATION') !== 'KSI0000RKSL' ||
      Number(get('LATITUDE')) !== 37.5667 ||
      Number(get('LONGITUDE')) !== 126.9667 ||
      !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(date)
    )
      throw new Error('weather-station-or-date');
    const observedAt = Date.parse(`${date}Z`);
    if (
      !Number.isFinite(observedAt) ||
      new Date(observedAt).toISOString().slice(0, 19) !== date ||
      seen.has(observedAt)
    )
      throw new Error('weather-ambiguous-date');
    seen.add(observedAt);
    const numeric = (key: string, minimum: number, maximum: number): number | null => {
      const value = get(key);
      // Empty quality means no GHCNh QC failure. Any flag is conservatively excluded.
      if (!value || get(`${key}_Quality_Code`) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
        return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
    };
    result.push({
      source: 'noaa-ghcnh',
      stationId: 'KSI0000RKSL',
      observedAt,
      temperatureC: numeric('temperature', -80, 65),
      windMetersPerSecond: numeric('wind_speed', 0, 100),
      precipitationMm: numeric('precipitation', 0, 1000),
      precipitationTrace:
        get('precipitation_Measurement_Code') === 'T' && !get('precipitation_Quality_Code'),
    });
  }
  return result.sort((left, right) => left.observedAt - right.observedAt);
}

/** No interpolation, backfill from future hours, or inference that blank precipitation means dry. */
export function lookupHistoricalWeather(
  rows: readonly HistoricalWeatherObservation[],
  startedAt: number,
): HistoricalWeatherContext | null {
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || rows.length > 100_000) return null;
  let low = 0,
    high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (rows[middle].observedAt <= startedAt) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index--) {
    const row = rows[index],
      age = startedAt - row.observedAt;
    if (age > MAX_WEATHER_AGE) break;
    const parsed = historicalWeatherObservationSchema.safeParse(row);
    if (!parsed.success || age < 0) continue;
    if (
      row.temperatureC === null &&
      row.windMetersPerSecond === null &&
      row.precipitationMm === null &&
      !row.precipitationTrace
    )
      continue;
    return {
      ...parsed.data,
      ageSeconds: age / 1000,
      retrospective: true,
      availability: 'historical-publication-unknown',
    };
  }
  return null;
}

/** Validate and copy the frozen archives once; each lookup still checks publication and service time.
 * The day rule picks the weekday/saturday/sunday cell. The default is the calendar weekday, not a holiday flag. */
export function preparePublishedRoadPriorLookup(
  archives: readonly RoadPriorArchive[],
  weekday: SeoulWeekday = calendarWeekday,
): (startedAt: number) => PublishedRoadPrior | null {
  if (archives.length > 24) throw new Error('road-archive-count');
  const seen = new Set<string>();
  const prepared = archives
    .map((value) => {
      const archive = roadPriorArchiveSchema.parse(value);
      if (seen.has(archive.referenceMonth)) throw new Error('duplicate-road-month');
      seen.add(archive.referenceMonth);
      return {
        archive,
        cells: new Map(archive.cells.map((cell) => [`${cell.weekType}:${cell.hour}`, cell])),
      };
    })
    .sort((left, right) => right.archive.referenceMonth.localeCompare(left.archive.referenceMonth));
  return (startedAt) => {
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
    const day = weekday(startedAt);
    if (day === null) return null;
    const local = new Date(startedAt + 9 * HOUR),
      month = local.toISOString().slice(0, 7),
      hour = local.getUTCHours(),
      weekType = weekTypeOf(day);
    for (const { archive, cells } of prepared) {
      if (archive.publishedAt > startedAt || archive.referenceMonth >= month) continue;
      const cell = cells.get(`${weekType}:${hour}`);
      if (!cell) continue;
      return {
        source: archive.source,
        publishedAt: archive.publishedAt,
        referenceMonth: archive.referenceMonth,
        spatialScope: archive.spatialScope,
        ...cell,
      };
    }
    return null;
  };
}

/** The same frozen monthly cells must be used during offline joining and runtime prediction. */
export function lookupPublishedRoadPrior(
  archives: readonly RoadPriorArchive[],
  startedAt: number,
  weekday: SeoulWeekday = calendarWeekday,
): PublishedRoadPrior | null {
  return preparePublishedRoadPriorLookup(archives, weekday)(startedAt);
}

export interface PublicBusContextCounts {
  input: number;
  weather: number;
  roadPrior: number;
  missingWeather: number;
  missingRoadPrior: number;
}
/** Road cells follow the v3 bus rule: reviewed public and substitute holidays read the Sunday cell. */
export function joinPublicBusContexts<T extends { version: number; startedAt: number }>(
  rows: readonly T[],
  weather: readonly HistoricalWeatherObservation[],
  priors: readonly RoadPriorArchive[],
  holidays: KoreanHolidayCalendar = reviewedKoreanHolidays(),
): {
  rows: (T & { weather: HistoricalWeatherContext | null; roadPrior: PublishedRoadPrior | null })[];
  counts: PublicBusContextCounts;
} {
  if (rows.length > 500_000 || weather.length > 100_000) throw new Error('join-size');
  for (let index = 0; index < weather.length; index++) {
    historicalWeatherObservationSchema.parse(weather[index]);
    if (index && weather[index - 1].observedAt >= weather[index].observedAt)
      throw new Error('weather-order');
  }
  const weekday = holidayAsSunday(holidays),
    lookupRoad = preparePublishedRoadPriorLookup(priors, weekday);
  const counts: PublicBusContextCounts = {
    input: rows.length,
    weather: 0,
    roadPrior: 0,
    missingWeather: 0,
    missingRoadPrior: 0,
  };
  const joined = rows.map((row) => {
    if (
      !row ||
      row.version !== 2 ||
      !Number.isSafeInteger(row.startedAt) ||
      row.startedAt <= 0 ||
      'weather' in row ||
      'roadPrior' in row
    )
      throw new Error('join-source-row');
    // A year without a reviewed calendar is refused rather than silently read as calendar weekdays.
    if (weekday(row.startedAt) === null) throw new Error('join-holiday-calendar');
    const joinedWeather = lookupHistoricalWeather(weather, row.startedAt),
      roadPrior = lookupRoad(row.startedAt);
    counts[joinedWeather ? 'weather' : 'missingWeather']++;
    counts[roadPrior ? 'roadPrior' : 'missingRoadPrior']++;
    return { ...row, weather: joinedWeather, roadPrior };
  });
  return { rows: joined, counts };
}
