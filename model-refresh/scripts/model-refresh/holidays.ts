import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseKoreanHolidayFiles } from '../../../src/common/engine/intelligence/korean-holidays';
import type { CalendarEntry, Manifest } from './manifest';
import type { Store } from './store';
import { DAY, errorMessage, kstDate, kstIso, sha256Text, writeAtomic, type Logger } from './util';

export const KASI_ENDPOINT = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
export const GOOGLE_KOREA_ICAL = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
export const OFFICIAL_REVIEW_DAYS = 60, CROSS_CHECK_REVIEW_DAYS = 30, CROSS_CHECK_HORIZON_DAYS = 90, CALENDAR_ALERT_DAYS = 7;
/** Renew only when the deadline is this close, so three runs a day do not mint a new calendar file each time. */
export const RENEW_OFFICIAL_DAYS = 45, RENEW_CROSS_CHECK_DAYS = 20;

export interface HolidayFile {
  year: number; verifiedAt: string; reviewAfter: string; source: string; holidays: string[];
  provenance?: unknown[];
  /** Added by the automatic refresh. officialBasis survives unofficial extensions so they never chain off themselves. */
  refresh?: { method: CalendarEntry['source']; checkedAt: string; officialBasis: { source: string; verifiedAt: string }; crossCheck?: { url: string; window: [string, string]; matched: number; weekendOnlyInOfficial: string[] } };
  [key: string]: unknown;
}
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

/** getRestDeInfo: public and substitute holidays, including designated temporary holidays and election days. */
export async function fetchKasiHolidays(year: number, key: string | undefined, fetchImpl: FetchLike): Promise<{ ok: true; holidays: string[]; responseSha256: string } | { ok: false; reason: string }> {
  if (!key) return { ok: false, reason: 'kasi-key-missing' };
  const encoded = key.includes('%') ? key : encodeURIComponent(key);
  try {
    const response = await fetchImpl(`${KASI_ENDPOINT}?solYear=${year}&numOfRows=100&_type=json&ServiceKey=${encoded}`, { signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (response.status !== 200) return { ok: false, reason: `kasi-http-${response.status}${/SERVICE_KEY_IS_NOT_REGISTERED/.test(text) ? '-key-not-registered' : ''}` };
    const body = JSON.parse(text);
    if (body?.response?.header?.resultCode !== '00') return { ok: false, reason: `kasi-result-${String(body?.response?.header?.resultCode ?? 'unknown').slice(0, 8)}` };
    const raw = body.response.body?.items?.item, items = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { locdate: number | string; isHoliday: string }[];
    const holidays = [...new Set(items.filter(item => item.isHoliday === 'Y').map(item => String(item.locdate)).filter(day => /^\d{8}$/.test(day))
      .map(day => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`))].filter(day => day.startsWith(`${year}-`)).sort();
    // A year always has New Year's Day, Seollal and Chuseok; an empty list is a broken response, not a holiday-free year.
    if (holidays.length < 10) return { ok: false, reason: 'kasi-too-few-holidays' };
    return { ok: true, holidays, responseSha256: sha256Text(text) };
  } catch (error) { return { ok: false, reason: `kasi-request-failed:${errorMessage(error).slice(0, 60)}` }; }
}

/** Public holidays only (DESCRIPTION 공휴일); memorial days (기념일) such as 어버이날 are excluded. */
export function parseKoreanHolidayIcal(text: string): string[] {
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  const days = new Set<string>();
  for (const event of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const date = /DTSTART;VALUE=DATE:(\d{8})/.exec(event)?.[1], description = /\nDESCRIPTION:([^\n]*)/.exec(event)?.[1] ?? '';
    if (date && description.startsWith('공휴일')) days.add(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
  }
  return [...days].sort();
}

const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/**
 * Every past day of the year and the next 90 days must agree. The one tolerated difference is a weekend day that the
 * official file has and the unofficial calendar lacks (Google drops 2027-02-06, the Saturday before 설날).
 */
export function crossCheckHolidays(official: readonly string[], unofficial: readonly string[], year: number, now: number) {
  const from = `${year}-01-01`, horizon = kstDate(now + CROSS_CHECK_HORIZON_DAYS * DAY), to = horizon < `${year}-12-31` ? horizon : `${year}-12-31`;
  const inside = (day: string) => day >= from && day <= to;
  const ours = new Set(official.filter(inside)), theirs = new Set(unofficial.filter(inside));
  const onlyOfficial = [...ours].filter(day => !theirs.has(day)), onlyUnofficial = [...theirs].filter(day => !ours.has(day));
  const weekendOnlyInOfficial = onlyOfficial.filter(day => [0, 6].includes(weekday(day)));
  const blocking = [...onlyOfficial.filter(day => !weekendOnlyInOfficial.includes(day)), ...onlyUnofficial].sort();
  // A future year with no day inside the horizon has nothing to disagree about yet; each extension is only 30 days.
  return { matched: blocking.length === 0, window: [from, to] as [string, string], compared: ours.size, weekendOnlyInOfficial, blocking };
}

export const calendarFileName = (year: number, text: string) => `calendars/korea-holidays-${year}-${sha256Text(text).slice(0, 12)}.json`;
export const holidayFileText = (file: HolidayFile) => JSON.stringify(file, null, 2) + '\n';
const officialBasisOf = (file: HolidayFile) => file.refresh?.officialBasis ?? (file.refresh?.method === 'unofficial-cross-check' ? null : { source: file.source, verifiedAt: file.verifiedAt });

export async function readCalendarFiles(store: Store, manifest: Manifest | null, fallbackDir?: string): Promise<Map<number, { file: HolidayFile; text: string; entry?: CalendarEntry }>> {
  const files = new Map<number, { file: HolidayFile; text: string; entry?: CalendarEntry }>();
  for (const [year, entry] of Object.entries(manifest?.calendars ?? {})) {
    const text = await readFile(store.path(entry.path), 'utf8');
    if (sha256Text(text) !== entry.sha256) throw new Error(`calendar-sha-mismatch:${year}`);
    files.set(Number(year), { file: JSON.parse(text), text, entry });
  }
  if (!files.size && fallbackDir) for (const year of [2026, 2027, 2028]) {
    const path = `${fallbackDir}/korea-holidays-${year}.json`;
    if (existsSync(path)) { const text = await readFile(path, 'utf8'); files.set(year, { file: JSON.parse(text), text }); }
  }
  return files;
}

export interface HolidayRefreshResult {
  calendars: Manifest['calendars']; changed: boolean; written: string[];
  years: Record<string, { action: 'kasi-api' | 'cross-check-extended' | 'unchanged' | 'cross-check-failed' | 'missing'; reviewAfter: string | null; source: string; reason?: string; blocking?: string[]; weekendOnlyInOfficial?: string[] }>;
  alerts: string[]; notices: string[];
}

/**
 * Current and next year. Official API first; without it, an existing officially sourced file may be extended 30 days
 * when the unofficial Google calendar agrees. Nothing is ever extended on a mismatch.
 */
export async function refreshHolidayCalendars(store: Store, manifest: Manifest | null, options: {
  now: number; fetchImpl: FetchLike; key?: string; plan?: boolean; log?: Logger; runId: string; fallbackDir?: string;
}): Promise<HolidayRefreshResult> {
  const { now } = options, thisYear = Number(kstDate(now).slice(0, 4)), years = [thisYear, thisYear + 1];
  const existing = await readCalendarFiles(store, manifest, options.fallbackDir);
  const calendars: Manifest['calendars'] = { ...manifest?.calendars };
  const result: HolidayRefreshResult = { calendars, changed: false, written: [], years: {}, alerts: [], notices: [] };
  let ical: string[] | null | undefined;
  const loadIcal = async () => {
    if (ical !== undefined) return ical;
    try { const response = await options.fetchImpl(GOOGLE_KOREA_ICAL, { signal: AbortSignal.timeout(30_000) }); ical = response.status === 200 ? parseKoreanHolidayIcal(await response.text()) : null; }
    catch { ical = null; }
    return ical;
  };
  // Older years still referenced by training windows keep their entries.
  for (const [year, value] of existing) if (!calendars[year] && value.entry) calendars[year] = value.entry;
  const stage = async (year: number, file: HolidayFile, source: CalendarEntry['source']) => {
    const text = holidayFileText(file); parseKoreanHolidayFiles([text]);
    const path = calendarFileName(year, text);
    if (!options.plan) { if (!existsSync(store.path(path))) await writeAtomic(store.path(path), text, options.runId); result.written.push(path); }
    calendars[year] = { path, sha256: sha256Text(text), reviewAfter: file.reviewAfter, verifiedAt: file.verifiedAt, source };
    result.changed = true;
  };
  for (const year of years) {
    const current = existing.get(year);
    // Carried files from the repository enter the store unchanged first.
    if (current && !current.entry) await stage(year, current.file, current.file.refresh?.method ?? 'carried');
    const kasi = await fetchKasiHolidays(year, options.key, options.fetchImpl);
    const remainingDays = current ? (Date.parse(current.file.reviewAfter) - now) / DAY : -1;
    if (kasi.ok) {
      const previous = current?.file.holidays ?? null, listChanged = !!previous && JSON.stringify(previous) !== JSON.stringify(kasi.holidays);
      if (listChanged) result.notices.push(`holiday-list-changed:${year}`);
      if (!listChanged && current?.file.refresh?.method === 'kasi-spcde-api' && remainingDays >= RENEW_OFFICIAL_DAYS) {
        result.years[year] = { action: 'unchanged', reviewAfter: current.file.reviewAfter, source: 'kasi-spcde-api' }; continue;
      }
      const file: HolidayFile = { year, verifiedAt: kstIso(now), reviewAfter: kstIso(now + OFFICIAL_REVIEW_DAYS * DAY), source: KASI_ENDPOINT, holidays: kasi.holidays,
        provenance: [{ title: '한국천문연구원 특일 정보 getRestDeInfo', retrievedAt: kstIso(now), responseSha256: kasi.responseSha256 }],
        refresh: { method: 'kasi-spcde-api', checkedAt: kstIso(now), officialBasis: { source: KASI_ENDPOINT, verifiedAt: kstIso(now) } } };
      await stage(year, file, 'kasi-spcde-api');
      result.years[year] = { action: 'kasi-api', reviewAfter: file.reviewAfter, source: 'kasi-spcde-api' };
      continue;
    }
    options.log?.('NOTICE', 'holidays-official-unavailable', { year, reason: kasi.reason });
    if (current && remainingDays >= RENEW_CROSS_CHECK_DAYS) { result.years[year] = { action: 'unchanged', reviewAfter: current.file.reviewAfter, source: calendars[year]?.source ?? 'carried', reason: kasi.reason }; continue; }
    if (!current) {
      result.years[year] = { action: 'missing', reviewAfter: null, source: 'none', reason: kasi.reason };
      // The next year's file must exist before windows reach it; warn from 12/01.
      if (year > thisYear && kstDate(now) >= `${thisYear}-12-01`) result.alerts.push(`holiday-calendar-missing:${year}`);
      continue;
    }
    const basis = officialBasisOf(current.file), reviewAfter = Date.parse(current.file.reviewAfter);
    const unofficial = basis ? await loadIcal() : null;
    const check = unofficial ? crossCheckHolidays(current.file.holidays, unofficial, year, now) : null;
    const extended = now + CROSS_CHECK_REVIEW_DAYS * DAY;
    if (basis && check?.matched && extended > reviewAfter) {
      const file: HolidayFile = { ...current.file, reviewAfter: kstIso(extended),
        refresh: { method: 'unofficial-cross-check', checkedAt: kstIso(now), officialBasis: basis,
          crossCheck: { url: GOOGLE_KOREA_ICAL, window: check.window, matched: check.compared, weekendOnlyInOfficial: check.weekendOnlyInOfficial } } };
      await stage(year, file, 'unofficial-cross-check');
      result.years[year] = { action: 'cross-check-extended', reviewAfter: file.reviewAfter, source: 'unofficial-cross-check', reason: kasi.reason, weekendOnlyInOfficial: check.weekendOnlyInOfficial };
      continue;
    }
    const reason = !basis ? 'no-official-basis' : !unofficial ? 'unofficial-calendar-unavailable' : !check!.matched ? 'cross-check-mismatch' : 'not-yet-needed';
    result.years[year] = { action: reason === 'not-yet-needed' ? 'unchanged' : 'cross-check-failed', reviewAfter: current.file.reviewAfter,
      source: calendars[year]?.source ?? 'carried', reason: reason === 'not-yet-needed' ? kasi.reason : reason, blocking: check?.blocking };
    if (reason !== 'not-yet-needed' && reviewAfter - now < CALENDAR_ALERT_DAYS * DAY) result.alerts.push(`holiday-calendar-review-expiring:${year}:${reason}`);
    else if (reason !== 'not-yet-needed') result.notices.push(`holiday-calendar-not-extended:${year}:${reason}`);
  }
  return result;
}

/** Materialise the manifest calendars as korea-holidays-YYYY.json for JIGAK_HOLIDAY_DIR and the trainers' --holidays. */
export async function materializeCalendars(store: Store, calendars: Manifest['calendars'], directory: string): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [year, entry] of Object.entries(calendars)) {
    const text = await readFile(store.path(entry.path), 'utf8');
    if (sha256Text(text) !== entry.sha256) throw new Error(`calendar-sha-mismatch:${year}`);
    paths[year] = `${directory}/korea-holidays-${year}.json`;
    await writeAtomic(paths[year], text);
  }
  return paths;
}
