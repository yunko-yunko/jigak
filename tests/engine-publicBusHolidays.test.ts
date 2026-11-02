// Regression cases from mvp/tests/publicBusHolidays.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicBusTrainingObservations as observations } from './fixtures/engine-publicBusTraining.js';
import {
  parsePublicBusModel,
  predictPublicBusDuration,
  publicBusRoadLookup,
  publicBusWeekday,
  trainPublicBusModel,
} from '../src/common/engine/intelligence/public-bus-model.js';
import {
  joinPublicBusContexts,
  lookupPublishedRoadPrior,
  type RoadPriorArchive,
} from '../src/common/engine/intelligence/historical-context.js';
import {
  HOLIDAY_AS_SUNDAY,
  holidayAsSunday,
  holidayReviewProblems,
  parseKoreanHolidayFiles,
  reviewedKoreanHolidays,
} from '../src/common/engine/intelligence/korean-holidays.js';
import { planPublicBusRefresh } from '../src/common/engine/intelligence/public-bus-refresh.js';

const NOW = Date.parse('2026-10-15T00:00:00Z'),
  DAY = 86_400_000;
const at = (local: string) => Date.parse(`${local}+09:00`);
const file = (year: number, holidays: string[]) =>
  JSON.stringify({
    year,
    verifiedAt: `${year - 1}-10-01T00:00:00+09:00`,
    reviewAfter: `${year}-12-31T00:00:00+09:00`,
    source: 'https://example.invalid/holidays',
    holidays,
  });
const archive: RoadPriorArchive = {
  version: 1,
  source: 'topis-monthly',
  referenceMonth: '2026-09',
  publishedAt: at('2026-10-01T09:14:16'),
  spatialScope: 'seoul-citywide',
  aggregation: 'distance-weighted-harmonic',
  sourceArchiveSha256: 'a'.repeat(64),
  cells: (['weekday', 'saturday', 'sunday'] as const).flatMap((weekType, day) =>
    Array.from({ length: 24 }, (_, hour) => ({
      weekType,
      hour,
      speedKmh: 20 + day + hour / 10,
      sampleCount: 100,
      missingCount: 5,
    })),
  ),
};
const ride = (startedAt: number) => ({
  distanceMeters: 4000,
  startedAt,
  weather: null,
  roadPrior: null,
});

test('reviewed holiday files load as consecutive years and stop training once their review lapses', () => {
  const calendar = reviewedKoreanHolidays();
  assert.equal(calendar.firstDate, '2026-01-01');
  assert.equal(calendar.lastDate, '2027-12-31');
  for (const day of ['2026-10-03', '2026-10-05', '2026-10-09', '2027-02-09', '2027-05-13'])
    assert.ok(calendar.holidays.includes(day), day);
  assert.ok(!calendar.holidays.includes('2026-10-16'));
  assert.deepEqual(
    holidayReviewProblems(calendar, '2026-10-18', '2026-11-07', at('2026-10-29T15:00:00')),
    [],
  );
  assert.deepEqual(
    holidayReviewProblems(calendar, '2026-11-01', '2026-11-21', at('2026-11-15T00:00:00')),
    ['holiday-calendar-review-expired:2026'],
  );
  assert.deepEqual(
    holidayReviewProblems(calendar, '2026-12-20', '2027-01-09', at('2026-10-20T00:00:00')),
    ['holiday-calendar-not-yet-verified:2027'],
  );
  assert.deepEqual(
    holidayReviewProblems(calendar, '2027-12-20', '2028-01-09', at('2026-11-01T00:00:00')),
    ['holiday-calendar-missing:2028'],
  );
  // A missing year must never read as a year without holidays.
  assert.throws(
    () => parseKoreanHolidayFiles([file(2026, ['2026-01-01']), file(2028, ['2028-01-01'])]),
    /holiday-calendar/,
  );
  assert.throws(
    () => parseKoreanHolidayFiles([file(2026, ['2026-03-01', '2026-01-01'])]),
    /holiday-calendar/,
  );
  assert.throws(() => parseKoreanHolidayFiles([file(2026, ['2027-01-01'])]), /holiday-calendar/);
});

test('public and substitute holidays read as Sunday on the KST calendar day, and days outside the slice are unknown', () => {
  const weekday = holidayAsSunday({
    firstDate: '2026-10-01',
    lastDate: '2026-10-31',
    holidays: ['2026-10-05', '2026-10-09'],
  });
  assert.equal(weekday(at('2026-10-05T08:00:00')), 0);
  assert.equal(weekday(at('2026-10-06T08:00:00')), 2);
  assert.equal(weekday(at('2026-10-09T00:00:00')), 0);
  assert.equal(weekday(at('2026-10-08T23:59:00')), 4);
  assert.equal(weekday(at('2026-10-10T08:00:00')), 6);
  assert.equal(weekday(at('2026-11-01T08:00:00')), null);
});

test('a v3 checkpoint freezes its holiday slice and predicts a weekday holiday exactly like a Sunday', () => {
  const report = trainPublicBusModel(observations(), { now: NOW });
  assert.equal(report.qualityPassed, true, JSON.stringify(report.reasons));
  assert.equal(report.model!.version, 'public-bus-duration-v3');
  // First training day through the last servable boarding (expiry + 4h, KST).
  assert.deepEqual(report.model!.calendar, {
    rule: HOLIDAY_AS_SUNDAY,
    firstDate: '2026-09-28',
    lastDate: '2026-10-22',
    holidays: ['2026-10-03', '2026-10-05', '2026-10-09'],
  });
  const model = parsePublicBusModel(JSON.stringify(report.model), NOW);
  const holiday = predictPublicBusDuration(model, ride(at('2026-10-09T08:00:00')), NOW);
  const sunday = predictPublicBusDuration(model, ride(at('2026-10-11T08:00:00')), NOW);
  const friday = predictPublicBusDuration(
    model,
    ride(at('2026-10-16T08:00:00')),
    at('2026-10-16T08:00:00'),
  );
  assert.ok(holiday && sunday && friday);
  assert.equal(holiday.modelVersion, 'public-bus-duration-v3');
  assert.equal(holiday.medianSeconds, sunday.medianSeconds);
  assert.equal(holiday.upperSeconds, sunday.upperSeconds);
  assert.notEqual(holiday.medianSeconds, friday.medianSeconds);
  const calendar = report.model!.calendar!,
    { calendar: _, ...withoutCalendar } = report.model!;
  for (const broken of [
    withoutCalendar,
    { ...report.model, calendar: { ...calendar, lastDate: '2026-10-23' } },
    { ...report.model, calendar: { ...calendar, holidays: ['2026-10-09', '2026-10-05'] } },
    { ...report.model, calendar: { ...calendar, holidays: ['2026-09-01'] } },
    { ...report.model, version: 'public-bus-duration-v2' },
  ])
    assert.throws(() => parsePublicBusModel(JSON.stringify(broken), NOW));
});

test('v2 checkpoints stay readable and keep calendar weekdays until they expire', () => {
  const report = trainPublicBusModel(observations(), {
    now: NOW,
    version: 'public-bus-duration-v2',
  });
  assert.equal(report.qualityPassed, true, JSON.stringify(report.reasons));
  assert.equal(report.model!.calendar, undefined);
  const model = parsePublicBusModel(JSON.stringify(report.model), NOW);
  assert.equal(publicBusWeekday(model)(at('2026-10-09T08:00:00')), 5);
  assert.equal(
    predictPublicBusDuration(model, ride(at('2026-10-09T08:00:00')), NOW)?.modelVersion,
    'public-bus-duration-v2',
  );
  const operational = fileURLToPath(
    new URL('../data/public-bus-operational.json', import.meta.url),
  );
  if (existsSync(operational)) {
    const text = readFileSync(operational, 'utf8');
    assert.ok(parsePublicBusModel(text, JSON.parse(text).trainedAt, { allowExpired: true }));
  }
});

test('training refuses a holiday calendar that does not cover the window and its 7 servable days', () => {
  const report = trainPublicBusModel(observations(), {
    now: NOW,
    holidays: parseKoreanHolidayFiles([file(2027, ['2027-01-01'])]),
  });
  assert.equal(report.qualityPassed, false);
  assert.equal(report.model, undefined);
  assert.deepEqual(report.reasons, ['holiday-calendar-does-not-cover-window']);
});

test('context join and v3 runtime read a weekday holiday from the Sunday road cell while v2 keeps the weekday cell', () => {
  const hangul = at('2026-10-09T08:00:00');
  assert.equal(lookupPublishedRoadPrior([archive], hangul)?.weekType, 'weekday');
  assert.equal(
    lookupPublishedRoadPrior([archive], hangul, holidayAsSunday(reviewedKoreanHolidays()))
      ?.weekType,
    'sunday',
  );
  const joined = joinPublicBusContexts(
    [
      { version: 2, startedAt: hangul },
      { version: 2, startedAt: at('2026-10-08T08:00:00') },
    ],
    [],
    [archive],
  );
  assert.deepEqual(
    joined.rows.map((row) => row.roadPrior?.weekType),
    ['sunday', 'weekday'],
  );
  assert.throws(
    () =>
      joinPublicBusContexts([{ version: 2, startedAt: at('2028-01-03T08:00:00') }], [], [archive]),
    /join-holiday-calendar/,
  );
  const slice = {
    rule: HOLIDAY_AS_SUNDAY,
    firstDate: '2026-10-01',
    lastDate: '2026-10-31',
    holidays: ['2026-10-09'],
  };
  assert.equal(publicBusRoadLookup({ roadPriorArchives: [archive] })(hangul)?.weekType, 'weekday');
  assert.equal(
    publicBusRoadLookup({ roadPriorArchives: [archive], calendar: slice })(hangul)?.weekType,
    'sunday',
  );
});

test('refresh can replace a v2 incumbent with a v3 candidate but never promotes a new calendar-weekday candidate', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const incumbent =
    JSON.stringify(
      trainPublicBusModel(observations(), { now: now - DAY, version: 'public-bus-duration-v2' })
        .model,
    ) + '\n';
  const v3 = trainPublicBusModel(observations('2026-09-30'), {
    now,
    serviceWindowStart: '2026-09-30',
  });
  const v2 = trainPublicBusModel(observations('2026-09-30'), {
    now,
    serviceWindowStart: '2026-09-30',
    version: 'public-bus-duration-v2',
  });
  assert.equal(planPublicBusRefresh(JSON.stringify(v3), incumbent, now).ready, true);
  const refused = planPublicBusRefresh(JSON.stringify(v2), incumbent, now);
  assert.equal(refused.ready, false);
  assert.ok(
    refused.reasons.includes('candidate-day-rule-retired'),
    JSON.stringify(refused.reasons),
  );
});
