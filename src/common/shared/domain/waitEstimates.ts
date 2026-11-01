import type { BaseSegment, HeadwayWindow } from './types.js';

export const REALTIME_BOARDING_BUFFER_SECONDS = { bus: 30, subway: 60 } as const;
/** Platform to train for a published timetable departure. The station entry segment (seoul-station-access-v1) is
 * fitted against the same timetable, so it already holds the whole gate-to-boarding time. Live predictions keep their
 * own buffer: they are actual times, not timetable times. */
export const TIMETABLE_BOARDING_BUFFER_SECONDS = 0;
const DAY = 86_400_000,
  KST = 9 * 3_600_000;
/** KST minutes after midnight between which no subway train runs (after the last trains, before the first ones). It is the
 * approximate service day, used only where a boarding has neither a timetable nor dated evidence: there the rider waits for
 * the first trains instead of being given a daytime headway at 04:00. A published timetable always overrides it. */
const SUBWAY_CLOSED_FROM = 60,
  SUBWAY_FIRST_TRAIN = 330;
/** KST minutes at which the time-of-day rule below changes value. */
const RULE_CHANGE_MINUTES = [360, 420, 570, 1050, 1200, 1320];
/** A subway boarding's rule also changes where the trains stop for the night and where the first ones start. */
const SUBWAY_RULE_CHANGE_MINUTES = [SUBWAY_CLOSED_FROM, SUBWAY_FIRST_TRAIN, ...RULE_CHANGE_MINUTES];
const minutesKst = (now: number) => {
  const kst = new Date(now + 9 * 3_600_000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
};

const evidenceWindows = (segment: BaseSegment): HeadwayWindow[] | undefined =>
  (segment.mode === 'bus' || segment.mode === 'subway') && segment.headwayEvidence?.windows.length
    ? segment.headwayEvidence.windows
    : undefined;
const runs = (
  window: HeadwayWindow,
): window is HeadwayWindow & { waitSeconds: number; headwaySeconds: number } =>
  window.waitSeconds !== null && window.headwaySeconds !== null;

/** What the boarding's dated headway evidence says at `at`: the covering window's wait and spacing while its lines
 * run; before a later running window, the whole seconds until it plus that window's own wait and spacing (the first
 * vehicle's stop time is only known to the window); 'ended' when no later window runs; null when no window covers
 * `at`, so the rule applies. */
export function evidenceHeadway(
  segment: BaseSegment,
  at: number,
): { waitSeconds: number; headwaySeconds: number } | 'ended' | null {
  const windows = evidenceWindows(segment);
  if (!windows || !Number.isFinite(at)) return null;
  const index = windows.findIndex((window) => at >= window.from && at < window.to);
  if (index < 0) return null;
  const window = windows[index];
  if (runs(window))
    return { waitSeconds: window.waitSeconds, headwaySeconds: window.headwaySeconds };
  const next = windows.slice(index + 1).find(runs);
  if (!next) return 'ended';
  const gap = Math.ceil((next.from - at) / 1000);
  return { waitSeconds: gap + next.waitSeconds, headwaySeconds: gap + next.headwaySeconds };
}

/** Dated evidence covers `at` and no vehicle of the boarding's lines runs at or after it. */
export const headwayServiceEnded = (segment: BaseSegment, at: number) =>
  evidenceHeadway(segment, at) === 'ended';

/** Dated evidence has a running window that starts at or after `at`: on a subway boarding past the end of a published
 * table's own service day, the next day's first trains. */
export const headwayRunsFrom = (segment: BaseSegment, at: number) =>
  !!evidenceWindows(segment)?.some((window) => runs(window) && window.from >= at);

/** The clocks [from, to) at which `headwayServiceEnded` holds: from the end of the last running window (or the start of
 * evidence where nothing runs) to the end of the evidence. Null when the evidence ends on a running window. */
export function headwayEndedTail(segment: BaseSegment): { from: number; to: number } | null {
  const windows = evidenceWindows(segment);
  if (!windows) return null;
  let last = windows.length - 1;
  while (last >= 0 && !runs(windows[last])) last--;
  const from = last < 0 ? windows[0].from : windows[last].to,
    to = windows.at(-1)!.to;
  return from < to ? { from, to } : null;
}

/** Heuristic headway allowance, not an observed departure or a trained mean. */
function ruleWaitSeconds(segment: BaseSegment, now: number): number {
  const minutes = minutesKst(now);
  const peak = (minutes >= 420 && minutes < 570) || (minutes >= 1050 && minutes < 1200);
  const late = minutes >= 1320 || minutes < 360;
  if (segment.mode === 'subway') {
    if (minutes >= SUBWAY_CLOSED_FROM && minutes < SUBWAY_FIRST_TRAIN) {
      const sinceMidnight = (((now + KST) % DAY) + DAY) % DAY;
      return Math.ceil((SUBWAY_FIRST_TRAIN * 60_000 - sinceMidnight) / 1000) + 300;
    }
    return peak ? 120 : late ? 300 : 210;
  }
  return Math.max(
    120,
    Math.round((peak ? 300 : late ? 480 : 360) / Math.max(1, segment.transit?.lines.length ?? 1)),
  );
}

/** Expected wait for the next unlisted vehicle: the boarding's dated headway evidence where a window covers `now`
 * and a vehicle still runs, otherwise the time-of-day rule. */
export function expectedWaitSeconds(segment: BaseSegment, now: number): number {
  const evidence = evidenceHeadway(segment, now);
  return evidence && evidence !== 'ended' ? evidence.waitSeconds : ruleWaitSeconds(segment, now);
}

/** Clocks in [from, to] at which `expectedWaitSeconds` can change value or slope: the rule's daily changes outside the
 * evidence span and every evidence window edge. Between two of them the wait is constant inside a running window and
 * never rises before a running window. */
export function waitChangeTimes(segment: BaseSegment, from: number, to: number): number[] {
  const times: number[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return times;
  const windows = evidenceWindows(segment);
  const start = windows ? windows[0].from : Infinity,
    end = windows ? windows.at(-1)!.to : -Infinity;
  for (let day = Math.floor((from + KST) / DAY) * DAY - KST; day <= to; day += DAY)
    for (const minute of segment.mode === 'subway' ? SUBWAY_RULE_CHANGE_MINUTES : RULE_CHANGE_MINUTES) {
      const time = day + minute * 60_000;
      if (time >= from && time <= to && (time < start || time >= end)) times.push(time);
    }
  for (const window of windows ?? [])
    for (const time of [window.from, window.to])
      if (time >= from && time <= to && !times.includes(time)) times.push(time);
  return times;
}

/** Dispatch allowance evaluated at pickup time; no vehicle reservation is implied. */
export function taxiPickupSeconds(now: number): number {
  const minutes = minutesKst(now);
  if ((minutes >= 450 && minutes < 570) || (minutes >= 1050 && minutes < 1170)) return 420;
  if (minutes >= 1350 || minutes < 90) return 540;
  return 300;
}
