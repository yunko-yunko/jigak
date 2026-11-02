import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PYTHON_COMMAND } from '../scripts/python-runtime';
import { SPATIAL_BICYCLE_FEATURE_NAMES } from '../../src/common/engine/intelligence/spatial-bicycle-model';
import { SPATIAL_BICYCLE_GROUPS } from '../../src/common/engine/intelligence/spatial-bicycle-ride';
import { crossCheckHolidays, parseKoreanHolidayIcal, refreshHolidayCalendars, type FetchLike } from '../scripts/model-refresh/holidays';
import { compare, writeSpatialBusPredictions, type IncumbentComparison, type IncumbentGate } from '../scripts/model-refresh/incumbent';
import { buildBundle, bundleSources, initStore } from '../scripts/model-refresh/init';
import { effectiveExpiry, promote, readManifest, revalidate, rollback, verifyManifest, writeManifest } from '../scripts/model-refresh/manifest';
import { attemptBusGroup, bicycleDue, incumbentGate, keepIncumbent, openAttemptDates, referencePath, withReference, type AttemptRecord, type MemberOutcome, type RunContext } from '../scripts/model-refresh/pipelines';
import { calendarEndOf, LATE_SERVICE_MS, MAX_MODEL_AGE_MS, servingCalendarLastDate } from '../scripts/model-refresh/calendar-span';
import { holidayAsSunday, parseKoreanHolidayFiles, seoulDate } from '../../src/common/engine/intelligence/korean-holidays';
import { parseSpatialBusCheckpoint, predictSpatialBusEnvelope, spatialBusFeatures, SPATIAL_BUS_FEATURE_NAMES, SPATIAL_BUS_GROUPS, SPATIAL_BUS_V3, type SpatialBusInput } from '../../src/common/engine/intelligence/spatial-bus-model';
import { createHash } from 'node:crypto';
import { spawnRunner, type StepRequest, type StepResult } from '../scripts/model-refresh/process';
import { chooseEvaluationDate, nextScheduledAt, planRouteTables, publicBusReproducible, trainingWindow, weeklyTiming } from '../scripts/model-refresh/schedule';
import { acquireLock, heartbeat, releaseLock, Store, LOCK_STALE_MS } from '../scripts/model-refresh/store';
import { downloadArchive, inspectMembers, parseCatalog, pruneArchives, TDATA_CATALOG, TDATA_ORIGIN, zipMembers, type TaimsIndex, type TaimsIndexEntry } from '../scripts/model-refresh/taims';
import { retain, runRefresh } from '../scripts/model-refresh/run';
import { addDays, createLogger } from '../scripts/model-refresh/util';

const kst = (text: string) => Date.parse(`${text}+09:00`);
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'model-refresh-')));
const quiet = () => createLogger('test', () => undefined);
const leaf = (value: number) => ({ initial: value, trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]] });
function bicycleCheckpoint(trainedAt: number, expiresAt: number, marker = 0, calendarLastDate = '2026-11-14') {
  const N = SPATIAL_BICYCLE_FEATURE_NAMES.length;
  return JSON.stringify({ version: 'seoul-bicycle-spatial-v2', deployment: 'production', target: 'bicycle-direct-ride-elapsed', region: 'seoul', trainedAt, expiresAt,
    trainingThrough: '2026-06-19', lastEvaluatedServiceDate: '2026-06-30', sourceMonth: '2026-06', featureNames: [...SPATIAL_BICYCLE_FEATURE_NAMES],
    models: { lower: leaf(300 + marker), q25: leaf(420), median: leaf(480), q75: leaf(560), upper: leaf(800) }, featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: { rule: 'korean-public-holiday-as-sunday', firstDate: '2026-06-01', lastDate: calendarLastDate, holidays: ['2026-06-03'] },
    conformal: SPATIAL_BICYCLE_GROUPS.map(group => ({ group, logLower: 0, logUpper: 0 })), labelUncertaintySeconds: 1,
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) }, targetDefinition: {}, evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) }, limitations: ['june-2026-rentals-only'] }) + '\n';
}
const archive = (serviceDate: string, hasRouteTable = true): TaimsIndexEntry => {
  const publication = addDays(serviceDate, 4).replace(/-/g, '');
  return { name: `TAIMS_${publication}.zip`, id: '1', url: 'https://t-data.seoul.go.kr/dataprovide/download.do?id=1', serviceDate, serviceDateRule: 'publication-minus-4',
    bytes: 10, sha256: serviceDate.replace(/-/g, '').padEnd(64, '0'), zipOk: true, hasRouteTable, members: [], downloadedAt: '' };
};
const indexOf = (entries: TaimsIndexEntry[]): TaimsIndex => ({ version: 'jigak-taims-index-v1', updatedAt: '', archives: Object.fromEntries(entries.map(entry => [entry.name, entry])) });
const days = (from: string, to: string) => { const list: string[] = []; for (let day = from; day <= to; day = addDays(day, 1)) list.push(day); return list; };

test('refresh lock: one holder, a stopped heartbeat is taken over after 30 minutes, release only by the holder', async () => {
  const store = new Store(temporary()), now = kst('2026-11-02T05:30:00');
  try {
    assert.deepEqual(await acquireLock(store, 'run-a', now), { acquired: true });
    const second = await acquireLock(store, 'run-b', now + 60_000);
    assert.equal(second.acquired, false);
    assert.equal(await heartbeat(store, 'run-b', now), false, 'only the holder beats');
    assert.equal(await heartbeat(store, 'run-a', now + 10 * 60_000), true);
    assert.equal((await acquireLock(store, 'run-b', now + 10 * 60_000 + LOCK_STALE_MS - 1)).acquired, false, 'a live heartbeat keeps the lock');
    const taken = await acquireLock(store, 'run-c', now + 10 * 60_000 + LOCK_STALE_MS + 1);
    assert.deepEqual(taken, { acquired: true, tookOverFrom: 'run-a' });
    await releaseLock(store, 'run-a'); assert.ok(existsSync(store.lock), 'a stale holder cannot remove the new lock');
    await releaseLock(store, 'run-c'); assert.ok(!existsSync(store.lock));
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test('promotion writes an immutable object, switches the manifest by one generation, keeps history and refuses expired candidates and rollbacks', async () => {
  const store = new Store(temporary()), trained = kst('2026-10-29T18:17:00'), now = kst('2026-11-02T05:30:00');
  try {
    const first = bicycleCheckpoint(trained, kst('2026-11-15T00:00:00'));
    const one = await promote(store, 'bicycleRide', first, { runId: 'r1', now });
    assert.equal(one.manifest.generation, 1); assert.equal(one.changed, true);
    assert.match(one.object.rel, /^models\/bicycleRide\/seoul-bicycle-spatial-v2\/20261029T1817-[a-f0-9]{12}\.json$/);
    assert.equal(readFileSync(store.legacy('bicycleRide'), 'utf8'), first, 'legacy fixed name follows the manifest');
    assert.equal((await promote(store, 'bicycleRide', first, { runId: 'r1b', now })).changed, false, 'same bytes are not a new generation');
    const second = bicycleCheckpoint(trained, kst('2026-12-02T00:46:00'), 1);
    const two = await promote(store, 'bicycleRide', second, { runId: 'r2', now: now + 1000, gates: { reason: 'calendar' } });
    assert.equal(two.manifest.generation, 2);
    assert.equal(two.manifest.models.bicycleRide!.history[0].expiresAt, kst('2026-11-15T00:00:00'));
    await assert.rejects(promote(store, 'bicycleRide', bicycleCheckpoint(trained, now - 1, 2), { runId: 'r3', now }), /candidate-expired/);
    assert.equal((await readManifest(store))!.generation, 2, 'a refused candidate leaves the manifest alone');
    const planned = await rollback(store, 'bicycleRide', { runId: 'r4', now: now + 2000 });
    assert.equal(planned.executed, false); assert.equal((await readManifest(store))!.generation, 2);
    const done = await rollback(store, 'bicycleRide', { runId: 'r4', now: now + 2000, execute: true });
    assert.equal(done.generation, 3);
    assert.equal((await readManifest(store))!.models.bicycleRide!.expiresAt, kst('2026-11-15T00:00:00'));
    assert.equal(readFileSync(store.legacy('bicycleRide'), 'utf8'), first);
    await assert.rejects(rollback(store, 'bicycleRide', { runId: 'r5', now: kst('2026-12-03T00:00:00'), execute: true, to: two.object.sha256.slice(0, 12) }), /rollback-target-expired/, 'never back to an expired version');
    assert.equal((await verifyManifest(store, now)).ok, true);
    writeFileSync(store.path((await readManifest(store))!.models.bicycleRide!.path), '{}');
    assert.deepEqual((await verifyManifest(store, now)).problems.sort(), ['bicycleRide:parse-failed', 'bicycleRide:sha-mismatch', 'bicycleRide:size-mismatch']);
    await assert.rejects(writeManifest(store, null, { runId: 'stale', models: {}, calendars: {} }), /manifest-changed-concurrently/);
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test('due windows and evaluation day for the 11/05 and 11/07 expiries, with the 10/27-10/28 route-table gap', () => {
  const now = kst('2026-11-02T05:30:00');
  const publicBus = weeklyTiming('publicBus', kst('2026-11-05T12:51:00'), now), spatial = weeklyTiming('spatialBus', kst('2026-11-07T00:40:00'), now);
  assert.equal(publicBus.due, true); assert.equal(publicBus.atRisk, false);
  assert.equal(spatial.due, true, 'opens 120 h before 11/07 00:40, i.e. 11/02 00:40');
  assert.equal(weeklyTiming('spatialBus', kst('2026-11-07T00:40:00'), kst('2026-11-02T00:39:00')).due, false);
  assert.equal(weeklyTiming('publicBus', kst('2026-11-05T12:51:00'), kst('2026-11-03T13:00:00')).atRisk, true);
  assert.equal(nextScheduledAt(kst('2026-11-02T05:30:00')), kst('2026-11-02T09:30:00'));
  assert.equal(nextScheduledAt(kst('2026-11-02T14:00:00')), kst('2026-11-03T05:30:00'));
  const window = trainingWindow('2026-10-28');
  assert.equal(window.first, '2026-10-15');
  assert.equal(window.spatialBusWindow, '2026-10-15:2026-10-18:2026-10-21:2026-10-27:2026-10-28');
  assert.equal(window.railGateWindow, '2026-10-15,2026-10-18,2026-10-21,2026-10-27,2026-10-28');
  assert.equal(publicBusReproducible('2026-10-28', kst('2026-11-04T02:59:00')), true);
  assert.equal(publicBusReproducible('2026-10-28', kst('2026-11-04T03:30:00')), false, 'runtime refuses rides older than 7 days');
  const index = indexOf(days('2026-10-02', '2026-10-28').map(day => archive(day, !['2026-10-13', '2026-10-27', '2026-10-28'].includes(day))));
  // Union of the three journals on 11/02: public bus 10-11/12/16/25, spatial 10-11/16/25, rail 10-12/14/15/16/22-25.
  const used = new Set(['2026-10-11', '2026-10-12', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
  const nearest = chooseEvaluationDate({ index, now, incumbentDates: ['2026-10-16'], usedDates: used, closedDates: new Set(), policy: 'nearest-consistent' });
  assert.equal(nearest.evaluationDate, '2026-10-28');
  const tables = planRouteTables(index, window.dates, 'nearest-consistent');
  assert.deepEqual(tables.fallbacks.map(entry => [entry.date, entry.borrowedFrom, entry.checkedAgainst.join('+')]), [['2026-10-27', '2026-10-26', '2026-10-24+2026-10-25'], ['2026-10-28', '2026-10-26', '2026-10-24+2026-10-25']]);
  // Strict (old --borrow-route-numbers): 10/26-10/28 are blocked; the only window left ends 10/21, older than the spatial and rail incumbents (10/25).
  const strict = chooseEvaluationDate({ index, now, incumbentDates: ['2026-10-16'], usedDates: used, closedDates: new Set(), policy: 'strict' });
  assert.equal(strict.evaluationDate, '2026-10-21');
  assert.deepEqual(strict.considered.slice(0, 3).map(entry => entry.reason), ['route-table-neighbors-unavailable:2026-10-27', 'route-table-neighbors-unavailable:2026-10-27', 'route-table-neighbors-unavailable:2026-10-13']);
  assert.equal(chooseEvaluationDate({ index, now, incumbentDates: ['2026-10-25'], usedDates: used, closedDates: new Set(), policy: 'strict' }).evaluationDate, null);
  const closed = chooseEvaluationDate({ index, now, incumbentDates: ['2026-10-16'], usedDates: used, closedDates: new Set(['2026-10-28']), policy: 'nearest-consistent' });
  assert.equal(closed.evaluationDate, '2026-10-27', 'a closed day is never retried; the next newest is used');
  // A window that starts on a day without a table borrows from before the window and lists it as a reference.
  const early = planRouteTables(index, trainingWindow('2026-10-26').dates, 'nearest-consistent');
  assert.deepEqual([early.ok, early.references], [true, ['2026-10-10', '2026-10-11', '2026-10-12']]);
  const gap = indexOf(days('2026-10-02', '2026-10-28').map(day => archive(day, day < '2026-10-18')));
  assert.equal(planRouteTables(gap, window.dates, 'nearest-consistent').reason, 'route-table-unavailable:2026-10-25', 'more than 7 days without a table is refused');
});

test('T-DATA catalog ids are read, never computed; archive retention keeps the newest 18 service days', async () => {
  const html = '<option value="16013">TAIMS_20261031.zip</option>\n<option value="15803">TAIMS_20260331.zip</option><option value="16031">TAIMS_20261101.zip</option>';
  const catalog = parseCatalog(html);
  assert.deepEqual(catalog.map(entry => [entry.serviceDate, entry.id]), [['2026-03-27', '15803'], ['2026-10-27', '16013'], ['2026-10-28', '16031']]);
  assert.throws(() => parseCatalog(html + '<option value="1">TAIMS_20261101.zip</option>'), /ambiguous/);
  const store = new Store(temporary());
  try {
    const index = indexOf(days('2026-10-01', '2026-10-28').map(day => archive(day)));
    const removed = await pruneArchives(store, index);
    assert.equal(Object.keys(index.archives).length, 18); assert.equal(removed.length, 10);
    assert.equal(Object.values(index.archives).map(entry => entry.serviceDate).sort()[0], '2026-10-11');
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test('zip central directory check: members and route table are read from the end; a truncated archive is refused', async () => {
  const directory = temporary();
  try {
    const made = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1] + '/full.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for name in ['VW_KSCC_DV_CARD.csv', 'VW_KSCC_DH_CARD.csv', 'VW_KSCC_DX_CARD.csv']: z.writestr(name, 'A,B\\n1,2\\n' * 2000)
data = open(sys.argv[1] + '/full.zip', 'rb').read(); open(sys.argv[1] + '/cut.zip', 'wb').write(data[: len(data) // 2])
`, directory], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const members = await zipMembers(join(directory, 'full.zip'));
    assert.deepEqual(members.sort(), ['VW_KSCC_DH_CARD.csv', 'VW_KSCC_DV_CARD.csv', 'VW_KSCC_DX_CARD.csv']);
    assert.deepEqual(inspectMembers(members), { usable: true, hasRouteTable: false });
    await assert.rejects(zipMembers(join(directory, 'cut.zip')), /zip-end-record-missing/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('preparation borrows the nearest earlier route table only when it agrees with the two before it', () => {
  const directory = temporary();
  try {
    const result = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `
import importlib.util, json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1]); sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('prep', root / 'prepare-public-bus.py'); prep = importlib.util.module_from_spec(spec); spec.loader.exec_module(prep)
out = pathlib.Path(sys.argv[2])
def make(day, routes):
    path = out / (day + '.zip')
    with zipfile.ZipFile(path, 'w') as z:
        if routes is not None: z.writestr('VW_KSCC_DO_CARD.csv', 'ROUTE_ID,ROUTE_NUM\\n' + ''.join(f'{r},{n}\\n' for r, n in routes.items()))
    return {'sourceDate': day, 'path': path, 'sha256': day, 'hasRouteTable': routes is not None}
base = {'R1': '100', 'R2': '200', 'R3': '300'}
items = [make('2026-10-24', base), make('2026-10-25', base), make('2026-10-26', base), make('2026-10-27', None), make('2026-10-28', None)]
fallbacks = prep.nearest_consistent_route_numbers(items)
report = {'borrowed': [f['borrowedFrom']['sourceDate'] for f in fallbacks], 'checked': [len(f['checkedAgainst']) for f in fallbacks], 'agreed': [f['agreedRoutes'] for f in fallbacks]}
later = [make('2026-10-20', base), make('2026-10-21', base), make('2026-10-22', base), make('2026-10-23', None), make('2026-10-29', {'R1': '100', 'R2': '999'})]
report['laterAgreed'] = prep.nearest_consistent_route_numbers(later)[0]['agreedRoutes']
errors = []
for case in ([make('2026-10-10', base), make('2026-10-11', {'R1': '101'}), make('2026-10-12', base), make('2026-10-13', None)], [make('2026-10-01', base), make('2026-10-02', None)], [make('2026-09-01', base), make('2026-09-02', base), make('2026-09-03', base), make('2026-09-11', None)]):
    try: prep.nearest_consistent_route_numbers(case); errors.append('accepted')
    except prep.PreparationError as error: errors.append(str(error))
report['errors'] = errors
print(json.dumps(report))
`, resolve('scripts'), directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { borrowed: ['2026-10-26', '2026-10-26'], checked: [2, 2], agreed: [3, 3], laterAgreed: 1,
      errors: ['route_table_history_inconsistent', 'route_table_history_insufficient', 'route_table_unavailable'] });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const ICAL = (dates: [string, string][]) => ['BEGIN:VCALENDAR', ...dates.flatMap(([day, kind]) => ['BEGIN:VEVENT', `DTSTART;VALUE=DATE:${day.replace(/-/g, '')}`,
  `DESCRIPTION:${kind}`, 'SUMMARY:x', 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

test('holiday cross-check: public holidays only, the Saturday 설날 eve gap is tolerated, any weekday difference blocks', () => {
  const parsed = parseKoreanHolidayIcal(ICAL([['2026-12-25', '공휴일'], ['2026-12-24', '기념일\\n기념일을 숨기려면'], ['2027-02-07', '공휴일']]));
  assert.deepEqual(parsed, ['2026-12-25', '2027-02-07']);
  const now = kst('2026-11-10T05:30:00');
  assert.equal(crossCheckHolidays(['2027-01-01', '2027-02-06', '2027-02-07'], ['2027-01-01', '2027-02-07'], 2027, now).matched, true);
  assert.deepEqual(crossCheckHolidays(['2027-01-01', '2027-02-06', '2027-02-07'], ['2027-01-01', '2027-02-07'], 2027, now).weekendOnlyInOfficial, ['2027-02-06']);
  assert.deepEqual(crossCheckHolidays(['2026-10-09', '2026-12-25'], ['2026-10-09', '2026-12-25', '2026-12-31'], 2026, now).blocking, ['2026-12-31']);
  assert.deepEqual(crossCheckHolidays(['2026-10-09', '2026-12-25'], ['2026-12-25'], 2026, now).blocking, ['2026-10-09'], 'past days of the year are compared too');
});

test('holiday refresh: official API first; without it only a matching unofficial check extends an officially sourced file by 30 days', async () => {
  const store = new Store(temporary()), now = kst('2026-11-02T05:30:00');
  const calendarDir = join(store.root, 'repo'); mkdirSync(calendarDir);
  const file = (year: number, holidays: string[], reviewAfter: string) => JSON.stringify({ year, verifiedAt: '2026-10-16T00:00:00+09:00', reviewAfter, source: 'https://www.kasa.go.kr/x', holidays }, null, 2) + '\n';
  writeFileSync(join(calendarDir, 'korea-holidays-2026.json'), file(2026, ['2026-10-09', '2026-12-25'], '2026-11-15T00:00:00+09:00'));
  writeFileSync(join(calendarDir, 'korea-holidays-2027.json'), file(2027, ['2027-01-01'], '2026-11-28T00:00:00+09:00'));
  const ical = ICAL([['2026-10-09', '공휴일'], ['2026-12-25', '공휴일'], ['2027-01-01', '공휴일']]);
  const fetcher = (kasi: 'forbidden' | 'ok', calendar = ical): FetchLike => async url => url.includes('apis.data.go.kr')
    ? kasi === 'ok' ? { status: 200, text: async () => JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: Array.from({ length: 12 }, (_, i) => ({ locdate: Number(`${url.includes('2027') ? 2027 : 2026}${String(i + 1).padStart(2, '0')}01`), isHoliday: 'Y' })) } } } }) }
      : { status: 403, text: async () => 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' }
    : { status: 200, text: async () => calendar };
  try {
    const extended = await refreshHolidayCalendars(store, null, { now, fetchImpl: fetcher('forbidden'), key: 'k', runId: 't', fallbackDir: calendarDir });
    assert.equal(extended.years[2026].action, 'cross-check-extended');
    assert.equal(Date.parse(extended.years[2026].reviewAfter!), now + 30 * 86_400_000);
    assert.equal(extended.years[2027].action, 'unchanged', '26 days left: not renewed yet');
    const written = JSON.parse(readFileSync(store.path(extended.calendars[2026].path), 'utf8'));
    assert.equal(written.source, 'https://www.kasa.go.kr/x', 'the file keeps its official URL'); assert.equal(written.refresh.method, 'unofficial-cross-check');
    const mismatch = await refreshHolidayCalendars(store, null, { now: kst('2026-11-10T05:30:00'), fetchImpl: fetcher('forbidden', ICAL([['2026-10-09', '공휴일']])), key: 'k', runId: 't2', fallbackDir: calendarDir });
    assert.equal(mismatch.years[2026].action, 'cross-check-failed'); assert.deepEqual(mismatch.alerts, ['holiday-calendar-review-expiring:2026:cross-check-mismatch']);
    const official = await refreshHolidayCalendars(store, null, { now, fetchImpl: fetcher('ok'), key: 'k', runId: 't3', fallbackDir: calendarDir });
    assert.equal(official.years[2026].action, 'kasi-api'); assert.equal(official.calendars[2026].source, 'kasi-spcde-api');
    assert.equal(Date.parse(official.years[2026].reviewAfter!), now + 60 * 86_400_000);
    // A file that was itself only extended unofficially is never the basis of another unofficial extension.
    const chained = JSON.parse(readFileSync(store.path(extended.calendars[2026].path), 'utf8'));
    assert.equal(chained.refresh.officialBasis.source, 'https://www.kasa.go.kr/x');
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test('bicycle re-promotion is due only when the calendar was extended past the model, 10 days ahead or on request', () => {
  const now = kst('2026-11-02T05:30:00'), manifest = (expiresAt: number, reviewAfter: string) => ({ schema: 'jigak-model-manifest-v1' as const, generation: 1, updatedAt: '', runId: '',
    models: { bicycleRide: { version: 'v', path: 'p', sha256: 'a'.repeat(64), bytes: 1, trainedAt: 1, expiresAt, evaluationDate: null, promotedAt: 1, runId: '', gates: {}, history: [] } },
    calendars: { 2026: { path: 'c', sha256: 'b'.repeat(64), reviewAfter, verifiedAt: '', source: 'carried' as const } } });
  assert.equal(bicycleDue(manifest(kst('2026-11-15T00:00:00'), '2026-11-15T00:00:00+09:00'), now, true).reason, 'calendar-not-extended');
  assert.equal(bicycleDue(manifest(kst('2026-11-15T00:00:00'), '2026-12-02T00:00:00+09:00'), now, false).reason, 'not-yet-due');
  assert.equal(bicycleDue(manifest(kst('2026-11-15T00:00:00'), '2026-12-02T00:00:00+09:00'), kst('2026-11-06T00:00:00'), false).due, true);
  assert.equal(bicycleDue(manifest(kst('2026-11-15T00:00:00'), '2026-12-02T00:00:00+09:00'), now, true).due, true);
});

test('an attempt resumes from its stage records: a crash after training never trains again, and the evaluation day stays with the attempt', async () => {
  const root = temporary(), store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(store.root, { recursive: true }); mkdirSync(work);
  const E = '2026-10-28', dates = trainingWindow(E).dates;
  const index = indexOf(dates.map(day => archive(day, true)));
  mkdirSync(store.taims, { recursive: true }); mkdirSync(store.context, { recursive: true });
  for (const entry of Object.values(index.archives)) writeFileSync(join(store.taims, entry.name), 'zip');
  writeFileSync(join(store.context, 'topis-road-priors-2026-08-09.json'), '{}'); writeFileSync(join(store.context, 'spatial-transit-stations.csv'), 'x');
  const calls: Record<string, number> = {};
  let crashOnPromote = true;
  const runner = async (request: StepRequest): Promise<StepResult> => {
    calls[request.name] = (calls[request.name] ?? 0) + 1;
    const arg = (flag: string) => request.args[request.args.indexOf(flag) + 1];
    const ok = (json: Record<string, unknown> = {}): StepResult => ({ code: 0, stdout: JSON.stringify(json), stderr: '', ms: 1, json });
    if (request.name === 'prepare-bus') {
      writeFileSync(arg('--output'), '{}\n');
      writeFileSync(`${arg('--output')}.manifest.json`, JSON.stringify({ outputRows: 14 * 9000, routeNumberFallbacks: [], archives: dates.map(day => ({ sourceDates: [day], outputRows: 9000 })) }));
      return ok();
    }
    if (request.name === 'join-context') { writeFileSync(arg('--output'), '{}\n'); writeFileSync(`${arg('--output')}.manifest.json`, '{}'); return ok(); }
    if (request.name === 'train-public-bus') {
      assert.ok(request.env.JIGAK_EVALUATION_JOURNAL_DIR && request.env.JIGAK_DATA_ROOT && request.env.JIGAK_HOLIDAY_DIR);
      assert.equal(request.env.DATA_GO_KR_SERVICE_KEY, undefined, 'children never see the key');
      mkdirSync(join(request.env.JIGAK_EVALUATION_JOURNAL_DIR!, 'public-bus-refresh-evaluations'), { recursive: true });
      writeFileSync(join(request.env.JIGAK_EVALUATION_JOURNAL_DIR!, 'public-bus-refresh-evaluations', `${E}.json`), '{"version":1}');
      writeFileSync(arg('--output'), '{"status":"production-candidate","model":{}}'); return ok({ status: 'production-candidate', qualityPassed: true });
    }
    if (request.name === 'train-spatial-bus') {
      const directory = arg('--output-directory'); mkdirSync(directory, { recursive: true });
      for (const name of ['protocol.json', 'model.json', 'parity.json']) writeFileSync(join(directory, name), '{}');
      writeFileSync(join(directory, 'report.json'), '{"qualityPassed":true}'); return ok();
    }
    if (request.name === 'promote-spatial-bus') { if (crashOnPromote) throw new Error('worker lost'); return { code: 1, stdout: '', stderr: '{"error":"python-typescript-parity-failed"}', ms: 1, json: { error: 'python-typescript-parity-failed' } }; }
    throw new Error(`unexpected ${request.name}`);
  };
  const weather = (async () => ({ status: 200, text: async () => 'STATION|DATE\n' })) as unknown as typeof fetch;
  const context = (runId: string): RunContext => ({ store, runId, now: () => kst('2026-11-02T05:30:00'), mode: 'local', plan: false, log: quiet(), projectDir: resolve('.'),
    workDir: join(work, runId), holidayDir: join(work, runId, 'holidays'), python: 'python3', routeTablePolicy: 'nearest-consistent', runner, env: { ...process.env, DATA_GO_KR_SERVICE_KEY: 'secret' }, workers: 1 });
  try {
    mkdirSync(join(work, 'one')); mkdirSync(join(work, 'two'));
    const first = await attemptBusGroup(context('one'), { evaluationDate: E, index, members: ['spatialBus'], fetchImpl: weather });
    assert.equal(first.status, 'open'); assert.equal(first.members.spatialBus!.status, 'failed');
    assert.ok(existsSync(join(store.journals, 'public-bus-refresh-evaluations', `${E}.json`)), 'journal written back to the store even when the run fails');
    crashOnPromote = false;
    const second = await attemptBusGroup(context('two'), { evaluationDate: E, index, members: ['spatialBus'], fetchImpl: weather });
    assert.deepEqual(calls, { 'prepare-bus': 1, 'join-context': 1, 'train-public-bus': 1, 'train-spatial-bus': 1, 'promote-spatial-bus': 2 });
    assert.equal(second.members.spatialBus!.status, 'closed'); assert.match(second.members.spatialBus!.reason, /parity-failed/);
    assert.equal(second.status, 'finished');
    const third = await attemptBusGroup(context('three'), { evaluationDate: E, index, members: ['spatialBus'], fetchImpl: weather });
    assert.equal(third.status, 'finished'); assert.equal(calls['promote-spatial-bus'], 2, 'a finished attempt is not repeated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- crash vs refusal, re-validation of the model in service ------------------------------------------------------------

function runTrainer(script: string, args: string[], root: string, journal: string) {
  const result = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', resolve('scripts', script), ...args], { encoding: 'utf8', cwd: root,
    env: { ...process.env, JIGAK_DATA_ROOT: root, JIGAK_EVALUATION_JOURNAL_DIR: journal, JIGAK_HOLIDAY_DIR: resolve('..', 'src', 'common', 'engine', 'realtime', 'data') } });
  const line = result.stderr.trim().split(/\r?\n/).filter(value => value.startsWith('{')).at(-1);
  return { status: result.status, error: line ? JSON.parse(line) as { error: string; kind: string; reason: string } : null, stderr: result.stderr };
}

test('trainers name what failed: a rule says "refused", anything else is a "crash" with its key; neither claims the evaluation day', () => {
  const root = temporary(), journal = join(root, 'journal');
  try {
    writeFileSync(join(root, 'bus.jsonl'), ''); writeFileSync(join(root, 'report.json'), '{"status":"refused","qualityPassed":false}'); writeFileSync(join(root, 'served.json'), '{}');
    const window = '2026-10-15:2026-10-18:2026-10-21:2026-10-27:2026-10-28';
    const base = ['--phase', 'refresh', '--window', window, '--input', 'bus.jsonl', '--reference-report', 'report.json', '--execute'];
    // The 11-02 failure: a refused public bus report has no model. Without a stand-in the trainer refuses by name ...
    const refused = runTrainer('train-spatial-bus-v3.py', [...base, '--output-directory', 'out-a'], root, journal);
    assert.equal(refused.status, 1);
    assert.deepEqual(refused.error, { error: 'spatial_bus_v3_training_refused', kind: 'refused', reason: 'reference_report_has_no_model' });
    // ... and a failure that is not a rule says which key was missing (it used to print only "KeyError").
    const crashed = runTrainer('train-spatial-bus-v3.py', [...base, '--fallback-reference', 'served.json', '--output-directory', 'out-b'], root, journal);
    assert.equal(crashed.error!.kind, 'crash'); assert.equal(crashed.error!.reason, "KeyError: 'version'");
    assert.ok(!existsSync(join(journal, 'spatial-bus-evaluations.json')), 'a crash before any fit leaves the evaluation day unused');
    writeFileSync(join(root, 'stations.csv'), 'a,b\n1,2\n');
    const rail = runTrainer('train-rail-gate.py', ['--phase', 'refresh', '--window', window.replace(/:/g, ','), '--input', 'bus.jsonl', '--stations', 'stations.csv', '--output-directory', 'out-c', '--execute'], root, journal);
    assert.equal(rail.error!.kind, 'crash'); assert.match(rail.error!.reason, /^KeyError: /);
    assert.ok(!existsSync(join(journal, 'rail-gate-evaluations.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const DAY_MS = 86_400_000;
const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex');
const pyEnv = () => ({ ...process.env, JIGAK_HOLIDAY_DIR: resolve('..', 'src', 'common', 'engine', 'realtime', 'data') });

/**
 * One fresh weekday (10/28) of 1,000 bus rides: 200 in each day part, half on OD groups the model trained on. Actual 360..900 s;
 * the served envelope is the constant 300..960 s around a 600 s mean, so every group passes unless a conformal group narrows it.
 * `outside` daytime rides start north of the trained origin latitudes (37.6): the server answers nothing for them.
 */
function spatialBusDay(root: string, overnightLogUpper = 0, outside = 0) {
  const E = '2026-10-28', N = SPATIAL_BUS_FEATURE_NAMES.length, trainedAt = kst('2026-10-26T00:40:00');
  const starts: Record<number, number> = { 0: kst(`${E}T04:00:00`), 1: kst(`${E}T06:00:00`), 2: kst(`${E}T10:00:00`), 3: kst(`${E}T17:00:00`), 4: kst(`${E}T21:00:00`) };
  const rows = Array.from({ length: 1000 }, (_, i) => {
    const part = Math.floor(i / 200), actual = 360 + (i % 10) * 60, startedAt = starts[part] + (i % 120) * 60_000, north = i >= 400 && i < 400 + outside;
    return { version: 2, id: `ride-${i}`, groupId: `run-${i}`, vehicleGroup: 'vehicle-1', odGroup: `${Math.floor(i / 10) % 2 ? 'trained' : 'new'}-${i % 37}`, sourceArchiveSha256: 'a'.repeat(64),
      source: 'seoul-tdata-card', target: 'bus-tag-elapsed', uncertaintySeconds: 60, sourceDate: E, startedAt, observedAt: startedAt + actual * 1000, actualSeconds: actual,
      distanceMeters: 2000, fromOrder: 1, toOrder: 6, fromLatitude: north ? 37.65 : 37.55, fromLongitude: 126.98, toLatitude: north ? 37.66 : 37.56, toLongitude: 126.99 };
  });
  const context = join(root, 'bus-context.jsonl'); writeFileSync(context, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  // The old public bus model the trainer would compare with: a constant 3,000 s and a 0.05 s/m distance baseline, both far worse.
  const publicBus = join(root, 'public-bus.json');
  writeFileSync(publicBus, JSON.stringify({ version: 'public-bus-duration-v3', baselineSecondsPerMeter: 0.05, coefficients: [Math.log(3000), ...Array(16).fill(0)],
    normalization: { centers: Array(16).fill(0), scales: Array(16).fill(1000) }, domain: { minimum: Array(16).fill(-1e6), maximum: Array(16).fill(1e6) } }));
  const checkpoint = JSON.stringify({ version: SPATIAL_BUS_V3, deployment: 'production', target: 'bus-tag-elapsed', trainedAt, expiresAt: trainedAt + 7 * DAY_MS,
    trainingThrough: '2026-10-19', lastEvaluatedServiceDate: '2026-10-25', featureNames: [...SPATIAL_BUS_FEATURE_NAMES],
    models: { mean: leaf(600), lower: leaf(300), median: leaf(600), upper: leaf(960) }, featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: { rule: 'korean-public-holiday-as-sunday', firstDate: '2026-10-12', lastDate: '2026-11-02', holidays: [] },
    conformal: SPATIAL_BUS_GROUPS.map(group => ({ group, logLower: 0, logUpper: group === 'weekday:overnight' ? overnightLogUpper : 0 })), labelUncertaintySeconds: 60,
    domain: { minimum: Array(N).fill(-1000), maximum: Array.from({ length: N }, (_, i) => i === 3 ? 37.6 : 1000) }, evaluation: {}, source: { experiment: 'unit', protocolSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64) },
    meanInterpretation: 'conditional tag-elapsed mean, not validated route ETA', limitations: ['unit'] }) + '\n';
  const trainOd = [...new Set(rows.map(row => row.odGroup).filter(od => od.startsWith('trained')))].sort();
  return { E, context, publicBus, checkpoint, trainedAt, reference: (text: string) => JSON.stringify({ version: 'jigak-incumbent-reference-v1', model: 'spatialBus', checkpointSha256: sha256Of(text), trainRows: 5000, trainOd }) };
}

test('a candidate more than 2% worse than the model in service loses to it; without a candidate there is nothing to compare', () => {
  const spread = (index: number) => 300 + (index % 20) * 40;
  const pairs = Array.from({ length: 400 }, (_, index) => ({ actual: spread(index), incumbent: { point: spread(index) + 20, lower: spread(index) - 120, upper: spread(index) + 150 } }));
  const worse = compare('2026-10-28', pairs.map(pair => ({ ...pair, candidate: { ...pair.incumbent, point: pair.incumbent.point + 90 } })));
  assert.deepEqual([worse.comparable, worse.passed, worse.reason], [true, false, 'worse-than-incumbent']);
  assert.equal(compare('2026-10-28', pairs.map(pair => ({ ...pair, candidate: { ...pair.incumbent } }))).passed, true);
  assert.equal(compare('2026-10-28', pairs.map(pair => ({ ...pair, candidate: null }))).comparable, false, 'without a candidate there is no comparison, only the incumbent alone');
});

test('re-validation runs the promotion gate per group: a whole day that passes does not hide one day part that fails', async () => {
  const root = temporary(), store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(store.root, { recursive: true }); mkdirSync(work);
  const now = kst('2026-11-01T05:30:00'), lost: MemberOutcome = { status: 'closed', reason: 'gate:quality-failed', details: { failedGroups: ['dayPart:overnight'] } };
  const ctx = { store, runId: 'run-g', now: () => now, mode: 'local', plan: false, log: quiet(), projectDir: resolve('.'), workDir: work, holidayDir: resolve('..', 'src', 'common', 'engine', 'realtime', 'data'),
    python: PYTHON_COMMAND, routeTablePolicy: 'nearest-consistent', runner: spawnRunner, env: { ...process.env }, workers: 1 } as RunContext;
  try {
    // The served upper bound of weekday nights is cut to 0.8x: 4 of 10 night rides end above it. The day as a whole still covers 92%.
    const narrow = spatialBusDay(root, Math.log(0.8));
    await promote(store, 'spatialBus', narrow.checkpoint, { runId: 'p1', now: narrow.trainedAt + 60_000 });
    const measure = (day: ReturnType<typeof spatialBusDay>) => () => incumbentGate(ctx, 'spatialBus', day.checkpoint, day.E, work, ['--input', day.context, '--public-bus', day.publicBus],
      output => writeSpatialBusPredictions(day.checkpoint, day.context, day.E, output));
    // Without the reference written at its promotion, the model cannot be checked per OD group: not extended.
    const unchecked = await keepIncumbent(ctx, 'spatialBus', narrow.checkpoint, narrow.E, lost, null, measure(narrow));
    assert.equal(unchecked.status, 'closed'); assert.deepEqual((unchecked.details as { incumbentGate: IncumbentGate }).incumbentGate.failed, ['reference-missing']);
    mkdirSync(join(store.root, 'references', 'spatialBus'), { recursive: true });
    writeFileSync(referencePath(store, 'spatialBus', sha256Of(narrow.checkpoint)), narrow.reference(narrow.checkpoint));
    const closed = await keepIncumbent(ctx, 'spatialBus', narrow.checkpoint, narrow.E, lost, null, measure(narrow));
    const gate = (closed.details as { incumbentGate: IncumbentGate }).incumbentGate;
    assert.equal(closed.status, 'closed'); assert.equal(closed.reason, 'gate:quality-failed');
    assert.deepEqual(gate.failed, ['dayPart:overnight'], 'only the night group fails');
    assert.equal(gate.rows, 1000);
    assert.deepEqual([gate.evaluations!.all!.robustUpperCoverage, gate.evaluations!['dayPart:overnight']!.robustUpperCoverage], [0.92, 0.6]);
    assert.equal((closed.details as { failedGroups: string[] }).failedGroups[0], 'dayPart:overnight', 'the candidate\'s own failure stays next to it');
    assert.equal((await readManifest(store))!.generation, 1, 'the manifest is untouched');

    // The same day with every group inside the gate: extended by 7 days, cut at the end of the file's calendar as before.
    const good = spatialBusDay(root);
    await promote(store, 'spatialBus', good.checkpoint, { runId: 'p2', now: good.trainedAt + 120_000 });
    writeFileSync(referencePath(store, 'spatialBus', sha256Of(good.checkpoint)), good.reference(good.checkpoint));
    const kept = await keepIncumbent(ctx, 'spatialBus', good.checkpoint, good.E, lost, null, measure(good));
    assert.equal(kept.status, 'revalidated');
    const details = kept.details as { expiresAt: number; clippedBy: string; calendarLastDate: string; incumbentGate: IncumbentGate };
    assert.deepEqual(details.incumbentGate.failed, []);
    assert.deepEqual(Object.keys(details.incumbentGate.evaluations!), ['all', 'newOd', 'seenOd', 'dayPart:overnight', 'dayPart:morning', 'dayPart:daytime', 'dayPart:evening', 'dayPart:night', `day:${good.E}`]);
    assert.deepEqual([details.expiresAt, details.clippedBy, details.calendarLastDate], [kst('2026-11-02T20:00:00'), 'calendar-end', '2026-11-02'], 'now + 7 days is cut to the calendar end');
    const entry = (await readManifest(store))!.models.spatialBus!;
    assert.equal(entry.expiresAt, kst('2026-11-02T20:00:00')); assert.deepEqual((entry.revalidations![0].evidence.incumbentGate as IncumbentGate).failed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-validation: rides the served model leaves unanswered fail their groups as in the trainer; a gate that cannot run extends nothing', async () => {
  const root = temporary(), store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(store.root, { recursive: true }); mkdirSync(work);
  const now = kst('2026-11-01T05:30:00'), lost: MemberOutcome = { status: 'closed', reason: 'gate:quality-failed' };
  const ctx = { store, runId: 'run-u', now: () => now, mode: 'local', plan: false, log: quiet(), projectDir: resolve('.'), workDir: work, holidayDir: resolve('..', 'src', 'common', 'engine', 'realtime', 'data'),
    python: PYTHON_COMMAND, routeTablePolicy: 'nearest-consistent', runner: spawnRunner, env: { ...process.env }, workers: 1 } as RunContext;
  try {
    // 5 daytime rides outside the trained domain: the server serves nothing for them, and the trainer allows no unsupported row.
    const day = spatialBusDay(root, 0, 5);
    await promote(store, 'spatialBus', day.checkpoint, { runId: 'p1', now: day.trainedAt + 60_000 });
    mkdirSync(join(store.root, 'references', 'spatialBus'), { recursive: true });
    writeFileSync(referencePath(store, 'spatialBus', sha256Of(day.checkpoint)), day.reference(day.checkpoint));
    const measure = (publicBus: string) => () => incumbentGate(ctx, 'spatialBus', day.checkpoint, day.E, work, ['--input', day.context, '--public-bus', publicBus],
      output => writeSpatialBusPredictions(day.checkpoint, day.context, day.E, output));
    const closed = await keepIncumbent(ctx, 'spatialBus', day.checkpoint, day.E, lost, null, measure(day.publicBus));
    const gate = (closed.details as { incumbentGate: IncumbentGate }).incumbentGate;
    assert.equal(closed.status, 'closed');
    assert.deepEqual(gate.failed, ['all', 'newOd', 'dayPart:daytime', `day:${day.E}`]);
    assert.deepEqual([gate.evaluations!.all!.unsupported, gate.evaluations!.seenOd!.unsupported, gate.evaluations!['dayPart:morning']!.unsupported], [5, 0, 0]);
    // The gate refuses its inputs (an old public bus model it cannot read): it did not run, so nothing is extended.
    const broken = join(root, 'public-bus-broken.json'); writeFileSync(broken, JSON.stringify({ version: 'public-bus-duration-v1' }));
    const refused = await keepIncumbent(ctx, 'spatialBus', day.checkpoint, day.E, lost, null, measure(broken));
    const refusedGate = (refused.details as { incumbentGate: IncumbentGate }).incumbentGate;
    assert.equal(refused.status, 'closed'); assert.equal(refusedGate.rows, 0);
    assert.deepEqual(refusedGate.failed, ['gate-not-run:spatialBus-incumbent-gate:incumbent_gate_refused:public_bus_reference_contract']);
    assert.equal((await readManifest(store))!.generation, 1, 'the manifest is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a promotion writes the reference under the served bytes; a failed reference keeps the promotion; retention keeps only references the manifest can serve', async () => {
  const root = temporary(), store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(store.root, { recursive: true }); mkdirSync(work);
  const calls: StepRequest[] = []; let answer: 'write' | 'refuse' = 'write';
  const runner = async (request: StepRequest): Promise<StepResult> => {
    calls.push(request);
    if (answer === 'refuse') return { code: 1, stdout: '', stderr: '', ms: 1, json: { error: 'incumbent_gate_refused', kind: 'refused', reason: 'training_rows_do_not_match_checkpoint' } };
    const output = request.args[request.args.indexOf('--output') + 1], checkpoint = request.args[request.args.indexOf('--checkpoint') + 1];
    writeFileSync(output, JSON.stringify({ checkpointSha256: sha256Of(readFileSync(checkpoint, 'utf8')) }));
    return { code: 0, stdout: '{}', stderr: '', ms: 1, json: {} };
  };
  const ctx = { store, runId: 'run-r', now: () => kst('2026-11-02T05:30:00'), mode: 'local', plan: false, log: quiet(), projectDir: resolve('.'), workDir: work,
    holidayDir: resolve('..', 'src', 'common', 'engine', 'realtime', 'data'), python: 'python3', routeTablePolicy: 'nearest-consistent', runner, env: { ...process.env }, workers: 1 } as RunContext;
  const promoted = (sha256: string): MemberOutcome => ({ status: 'promoted', reason: 'promoted', details: { sha256 } });
  try {
    const first = spatialBusDay(root).checkpoint, second = spatialBusDay(root, Math.log(0.8)).checkpoint, args = ['--input', 'context.jsonl', '--window', 'w'];
    const written = await withReference(ctx, 'spatialBus', first, args, promoted(sha256Of(first)));
    assert.deepEqual([written.status, (written.details as { reference: string }).reference], ['promoted', 'written']);
    const stored = referencePath(store, 'spatialBus', sha256Of(first));
    assert.equal(JSON.parse(readFileSync(stored, 'utf8')).checkpointSha256, sha256Of(first), 'the file is named by the sha256 of the very bytes served');
    assert.deepEqual([calls[0].name, calls[0].args.slice(2, 6)], ['spatialBus-reference', [resolve('scripts', 'model-refresh', 'incumbent-gate.py'), 'reference', '--model', 'spatialBus']]);
    // The same bytes again: kept, not rebuilt. A closed outcome writes nothing.
    assert.equal(((await withReference(ctx, 'spatialBus', first, args, promoted(sha256Of(first)))).details as { reference: string }).reference, 'kept');
    assert.equal((await withReference(ctx, 'spatialBus', second, args, { status: 'closed', reason: 'gate:quality-failed' })).details, undefined);
    assert.equal(calls.length, 1);
    // The rebuilt rows do not match the checkpoint: the promotion stands, the model just cannot be re-validated later.
    answer = 'refuse';
    const missing = await withReference(ctx, 'spatialBus', second, args, promoted(sha256Of(second)));
    assert.deepEqual([missing.status, (missing.details as { reference: string }).reference], ['promoted', 'spatialBus-reference:incumbent_gate_refused:training_rows_do_not_match_checkpoint']);
    assert.equal(existsSync(referencePath(store, 'spatialBus', sha256Of(second))), false);

    // Retention: the model in service and its rollback target keep their references, anything else goes.
    const trained = kst('2026-10-29T18:17:00'), old = bicycleCheckpoint(trained, trained + 7 * DAY_MS), current = bicycleCheckpoint(trained + DAY_MS, trained + 8 * DAY_MS, 1);
    await promote(store, 'bicycleRide', old, { runId: 'p1', now: trained + 60_000 });
    const manifest = (await promote(store, 'bicycleRide', current, { runId: 'p2', now: trained + DAY_MS + 60_000 })).manifest;
    for (const text of [old, current, 'gone']) { const path = referencePath(store, 'bicycleRide', sha256Of(text)); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '{}'); }
    await retain(store, manifest, kst('2026-11-02T05:30:00'), quiet());
    assert.deepEqual([old, current, 'gone'].map(text => existsSync(referencePath(store, 'bicycleRide', sha256Of(text)))), [true, true, false]);
    assert.equal(existsSync(stored), false, 'no spatial bus model is in the manifest here, so its reference goes too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function runGate(args: string[], cwd: string) {
  const result = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', resolve('scripts', 'model-refresh', 'incumbent-gate.py'), ...args], { encoding: 'utf8', cwd, env: pyEnv() });
  const line = (result.status ? result.stderr : result.stdout).trim().split(/\r?\n/).filter(value => value.startsWith('{')).at(-1);
  return { status: result.status, json: line ? JSON.parse(line) : null, stderr: result.stderr };
}

test('subway gate: the trainer\'s groups, baselines and support rule, and a station the model never saw is left to the provider', () => {
  const root = temporary(), E = '2026-10-28', token = (value: string) => sha256Of(value);
  try {
    writeFileSync(join(root, 'stations.csv'), '외구간_역_수,역한글명칭,환승역Y좌표,환승역X좌표\n0001,가역,37.50,127.00\n0002,나역,37.52,127.02\n0003,다역,37.54,127.04\n0004,라역,37.56,127.06\n0005,마역,37.58,127.08\n');
    const starts = [kst(`${E}T04:00:00`), kst(`${E}T06:00:00`), kst(`${E}T10:00:00`), kst(`${E}T17:00:00`), kst(`${E}T21:00:00`)];
    const rows = Array.from({ length: 1001 }, (_, i) => {
      // 가→나 was in training (its pair median is a baseline); 다→라 was not; 마 is a station with coordinates but no encoding.
      const unseen = Math.floor(i / 10) % 2 === 1, last = i === 1000, actual = 360 + (i % 10) * 60, startedAt = starts[Math.floor((i % 1000) / 200)] + (i % 120) * 60_000;
      const [o, d, oi, di] = last ? ['마', '가', '0005', '0001'] : unseen ? ['다', '라', '0003', '0004'] : ['가', '나', '0001', '0002'];
      return { version: 1, id: token(`id${i}`), groupId: token(`g${i}`), journeyGroup: token(`j${i}`), cardGroup: token(`c${i}`), sourceArchiveSha256: token('a'), source: 'seoul-tdata-rail',
        target: 'rail-gate-elapsed', sourceDate: E, startedAt, observedAt: startedAt + actual * 1000, actualSeconds: actual, uncertaintySeconds: 60, originName: o, destinationName: d,
        originStationId: oi, destinationStationId: di, modeSequence: ['subway'] };
    });
    writeFileSync(join(root, 'rail.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const checkpoint = JSON.stringify({ secondsPerMeter: 0.5, domain: { minimum: Array(18).fill(-1000), maximum: Array(18).fill(1000) },
      encodings: { pairs: [['가', '나', Math.log(600), 50]], origins: [['가', 0, 10], ['다', 0, 10]], destinations: [['나', 0, 10], ['라', 0, 10], ['가', 0, 10]] } });
    writeFileSync(join(root, 'checkpoint.json'), checkpoint);
    writeFileSync(join(root, 'reference.json'), JSON.stringify({ version: 'jigak-incumbent-reference-v1', model: 'railGate', checkpointSha256: sha256Of(checkpoint), trainRows: 9000,
      ridge: { columns: [0, 7, 8, 9, 10, 11], center: Array(6).fill(0), scale: Array(6).fill(1), coefficient: [Math.log(3), 0, 0, 0, 0, 0, 0] } }));
    // Served answers: 10 s off with a 200 s band, except 8 of every 50 rides between stations it never paired, whose upper bound is too low.
    const predictions = (failing: (i: number) => boolean) => rows.map((row, i) => JSON.stringify({ id: row.id, incumbent: i === 1000 ? null
      : { median: row.actualSeconds + 10, lower: row.actualSeconds - 100, upper: row.actualSeconds + (failing(i) ? 30 : 100) } })).join('\n') + '\n';
    const gate = (name: string, failing: (i: number) => boolean) => {
      writeFileSync(join(root, `${name}.jsonl`), predictions(failing));
      const result = runGate(['gate', '--model', 'railGate', '--checkpoint', 'checkpoint.json', '--reference', 'reference.json', '--input', 'rail.jsonl', '--stations', 'stations.csv',
        '--predictions', `${name}.jsonl`, '--evaluation-date', E, '--output', `${name}-gate.json`], root);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(root, `${name}-gate.json`), 'utf8'));
    };
    const passing = gate('passing', () => false);
    assert.deepEqual([passing.passed, passing.failedGroups, passing.rows, passing.unseenStation], [true, [], 1000, 1]);
    assert.deepEqual(Object.keys(passing.evaluations), ['all', 'seenOd', 'unseenOd', 'dayPart:overnight', 'dayPart:morning', 'dayPart:daytime', 'dayPart:evening', 'dayPart:night', `day:${E}`]);
    assert.equal(passing.evaluations.unseenOd.pairElseDistanceMaeSeconds, passing.evaluations.unseenOd.distanceMaeSeconds, 'an unseen pair falls back to the distance baseline');
    assert.ok(passing.evaluations.all.ridgeMaeSeconds > passing.evaluations.all.distanceMaeSeconds, 'ridge = 3 x distance baseline, from the reference');
    // Rows left to the provider are capped at max(10, 0.1% of the day): 10 such rows still pass, 301 fail the day by that name alone.
    const newStations = (extra: number) => {
      const added = Array.from({ length: extra }, (_, k) => ({ ...rows[1000], id: token(`new-station-${k}`), groupId: token(`ng${k}`) }));
      writeFileSync(join(root, `rail-${extra}.jsonl`), [...rows, ...added].map(row => JSON.stringify(row)).join('\n') + '\n');
      writeFileSync(join(root, `new-${extra}.jsonl`), predictions(() => false) + added.map(row => JSON.stringify({ id: row.id, incumbent: null })).join('\n') + '\n');
      const result = runGate(['gate', '--model', 'railGate', '--checkpoint', 'checkpoint.json', '--reference', 'reference.json', '--input', `rail-${extra}.jsonl`, '--stations', 'stations.csv',
        '--predictions', `new-${extra}.jsonl`, '--evaluation-date', E, '--output', `new-${extra}-gate.json`], root);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(root, `new-${extra}-gate.json`), 'utf8'));
    };
    const few = newStations(9), many = newStations(300);
    assert.deepEqual([few.passed, few.failedGroups, few.unseenStation, few.unseenStationLimit], [true, [], 10, 10]);
    assert.deepEqual([many.passed, many.failedGroups, many.unseenStation, many.rows], [false, ['unseenStation'], 301, 1000]);
    const unseenWeak = gate('unseen-weak', i => Math.floor(i / 10) % 2 === 1 && i % 100 >= 10 && i % 100 < 18);
    assert.deepEqual([unseenWeak.passed, unseenWeak.failedGroups], [false, ['unseenOd']]);
    assert.deepEqual([unseenWeak.evaluations.all.robustUpperCoverage, unseenWeak.evaluations.unseenOd.robustUpperCoverage], [0.92, 0.84]);
    // A row the server leaves unanswered for any other reason is unsupported, and the trainer allows none.
    writeFileSync(join(root, 'gap.jsonl'), predictions(() => false).replace(`{"id":"${rows[5].id}","incumbent":{`, `{"id":"${rows[5].id}","incumbent":null,"x":{`));
    const gap = runGate(['gate', '--model', 'railGate', '--checkpoint', 'checkpoint.json', '--reference', 'reference.json', '--input', 'rail.jsonl', '--stations', 'stations.csv',
      '--predictions', 'gap.jsonl', '--evaluation-date', E, '--output', 'gap-gate.json'], root);
    assert.deepEqual(gap.json.failedGroups, ['all', 'seenOd', 'dayPart:overnight', `day:${E}`]);
    // Fewer than 100 rides in a group fails that group, as in the trainer: 80 per day part here.
    writeFileSync(join(root, 'rail.jsonl'), rows.filter((_, i) => i % 200 < 80).map(row => JSON.stringify(row)).join('\n') + '\n');
    const thin = runGate(['gate', '--model', 'railGate', '--checkpoint', 'checkpoint.json', '--reference', 'reference.json', '--input', 'rail.jsonl', '--stations', 'stations.csv',
      '--predictions', 'passing.jsonl', '--evaluation-date', E, '--output', 'thin-gate.json'], root);
    assert.deepEqual(thin.json.failedGroups, ['dayPart:overnight', 'dayPart:morning', 'dayPart:daytime', 'dayPart:evening', 'dayPart:night']);
    // A reference written for other bytes is refused by name.
    writeFileSync(join(root, 'checkpoint.json'), checkpoint + ' ');
    const stale = runGate(['gate', '--model', 'railGate', '--checkpoint', 'checkpoint.json', '--reference', 'reference.json', '--input', 'rail.jsonl', '--stations', 'stations.csv',
      '--predictions', 'passing.jsonl', '--evaluation-date', E, '--output', 'stale-gate.json'], root);
    assert.deepEqual([stale.status, stale.json.kind, stale.json.reason], [1, 'refused', 'reference_not_for_this_checkpoint']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a reference is written only for the very training rows of the checkpoint (its feature domain must match exactly)', () => {
  const root = temporary();
  try {
    const day = spatialBusDay(root), window = '2026-10-14:2026-10-17:2026-10-20:2026-10-26:2026-10-27';
    // Training rows: the same rides, moved to the training days (10/14-10/20).
    const rows = readFileSync(day.context, 'utf8').trim().split('\n').map(line => JSON.parse(line)).map((row, i) => {
      const date = `2026-10-${String(14 + (i % 7)).padStart(2, '0')}`, shift = Date.parse(`${date}T00:00:00Z`) - Date.parse('2026-10-28T00:00:00Z');
      return { ...row, id: `t-${i}`, groupId: `tg-${i}`, vehicleGroup: `veh-${i % 50}`, sourceDate: date, startedAt: row.startedAt + shift, observedAt: row.observedAt + shift };
    });
    writeFileSync(join(root, 'train.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const make = (domain: { minimum: number[]; maximum: number[] }, name: string) => {
      writeFileSync(join(root, `${name}.json`), JSON.stringify({ domain }));
      return runGate(['reference', '--model', 'spatialBus', '--checkpoint', `${name}.json`, '--window', window, '--input', 'train.jsonl', '--output', `${name}-reference.json`], root);
    };
    const N = SPATIAL_BUS_FEATURE_NAMES.length;
    assert.deepEqual(make({ minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) }, 'wrong').json.reason, 'training_rows_do_not_match_checkpoint');
    // The trainer's own domain: min/max of the features of the training rows (held-out vehicles and rides past 04:00 after 10/20 excluded).
    const probe = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `
import importlib.util, json, sys
import numpy as np
spec = importlib.util.spec_from_file_location('t', sys.argv[1]); t = importlib.util.module_from_spec(spec); spec.loader.exec_module(t)
phase = t.refresh_window(sys.argv[3]); holidays, _ = t.shared.holiday_calendars(None, t.HOLIDAY_FILE, phase['first'], phase['evaluation'][-1])
rows = [json.loads(line) for line in open(sys.argv[2], encoding='utf-8')]
x = np.asarray([t.validate(r, holidays) for r in rows]); day = np.asarray([r['sourceDate'] for r in rows]); ended = np.asarray([r['observedAt'] for r in rows])
train = t.training_mask(day, ended, np.asarray([t.held_out(r['vehicleGroup']) for r in rows]), phase)
print(json.dumps({'minimum': x[train].min(axis=0).tolist(), 'maximum': x[train].max(axis=0).tolist(), 'od': sorted({rows[i]['odGroup'] for i in np.flatnonzero(train)})}))
`, resolve('scripts', 'train-spatial-bus-v3.py'), join(root, 'train.jsonl'), window], { encoding: 'utf8', env: pyEnv() });
    assert.equal(probe.status, 0, probe.stderr);
    const expected = JSON.parse(probe.stdout);
    const made = make({ minimum: expected.minimum, maximum: expected.maximum }, 'right');
    assert.equal(made.status, 0, made.stderr);
    const reference = JSON.parse(readFileSync(join(root, 'right-reference.json'), 'utf8'));
    assert.deepEqual([reference.version, reference.model, reference.checkpointSha256, reference.trainOd], ['jigak-incumbent-reference-v1', 'spatialBus', sha256Of(readFileSync(join(root, 'right.json'), 'utf8')), expected.od]);
    assert.ok(reference.trainRows > 0 && reference.trainRows < rows.length, 'held-out vehicles are not training rows');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('re-validation extends the manifest expiry without touching the model file, keeps the 28-day ceiling, and rollback keeps the extension', async () => {
  const store = new Store(temporary()), trained = kst('2026-10-29T18:17:00'), now = kst('2026-11-02T05:30:00');
  try {
    // The file's holiday calendar reaches past trainedAt + 28 days, so only the age cap limits the extensions here.
    const first = bicycleCheckpoint(trained, trained + 7 * DAY_MS, 0, '2026-12-31');
    const promoted = await promote(store, 'bicycleRide', first, { runId: 'p1', now: trained + 60_000, evaluationDate: '2026-10-21' });
    const shaBefore = promoted.object.sha256;
    await assert.rejects(revalidate(store, 'bicycleRide', { runId: 'x', now, evaluationDate: '2026-10-28', sha256: 'f'.repeat(64), candidate: 'c', evidence: {} }), /revalidation-model-changed/);
    const done = await revalidate(store, 'bicycleRide', { runId: 'r1', now, evaluationDate: '2026-10-28', sha256: shaBefore, candidate: 'gate:worse-than-incumbent', evidence: { mae: 262 } });
    assert.equal(done.manifest.generation, 2);
    const entry = (await readManifest(store))!.models.bicycleRide!;
    assert.equal(entry.sha256, shaBefore, 'the model bytes do not change'); assert.equal(entry.path, promoted.object.rel);
    assert.equal(entry.expiresAt, now + 7 * DAY_MS, 'evaluation run time + the normal life');
    assert.equal(entry.revalidatedAt, now); assert.equal(entry.revalidationCount, 1);
    assert.deepEqual([entry.revalidations![0].previousExpiresAt, entry.revalidations![0].evaluationDate, entry.revalidations![0].candidate, entry.revalidations![0].evidence], [trained + 7 * DAY_MS, '2026-10-28', 'gate:worse-than-incumbent', { mae: 262 }]);
    assert.equal(readFileSync(store.path(entry.path), 'utf8'), first, 'file on disk is the same text');
    assert.equal((await verifyManifest(store, now)).ok, true);
    // Further extensions; the one that would pass trainedAt + 28 days is cut to it, and a later one that adds nothing is refused.
    const later = await revalidate(store, 'bicycleRide', { runId: 'r2', now: now + 6 * DAY_MS, evaluationDate: '2026-11-03', sha256: shaBefore, candidate: 'c', evidence: {} });
    assert.equal(later.entry.revalidationCount, 2); assert.equal(later.entry.expiresAt, now + 13 * DAY_MS);
    const third = await revalidate(store, 'bicycleRide', { runId: 'r3', now: now + 12 * DAY_MS, evaluationDate: '2026-11-09', sha256: shaBefore, candidate: 'c', evidence: {} });
    assert.equal(third.entry.expiresAt, now + 19 * DAY_MS);
    const fourth = await revalidate(store, 'bicycleRide', { runId: 'r4', now: now + 18 * DAY_MS, evaluationDate: '2026-11-15', sha256: shaBefore, candidate: 'c', evidence: {} });
    assert.equal(fourth.entry.expiresAt, trained + 28 * DAY_MS, 'capped at 28 days after training'); assert.equal(fourth.entry.revalidationCount, 4);
    await assert.rejects(revalidate(store, 'bicycleRide', { runId: 'r5', now: now + 23 * DAY_MS, evaluationDate: '2026-11-20', sha256: shaBefore, candidate: 'c', evidence: {} }), /revalidation-limit-reached/);
    assert.equal((await readManifest(store))!.models.bicycleRide!.revalidations!.length, 4);
    // A promotion replaces the entry: the counter starts again and the revalidated old model sits in history with its extended expiry.
    const next = bicycleCheckpoint(now + 7 * DAY_MS, now + 14 * DAY_MS, 3);
    const promotedAgain = await promote(store, 'bicycleRide', next, { runId: 'p2', now: now + 7 * DAY_MS + 60_000, evaluationDate: '2026-11-04' });
    const current = promotedAgain.manifest.models.bicycleRide!;
    assert.equal(current.revalidationCount, undefined); assert.equal(current.history[0].sha256, shaBefore); assert.equal(current.history[0].expiresAt, trained + 28 * DAY_MS);
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

const incumbentComparison = (overrides: Partial<IncumbentComparison> = {}): IncumbentComparison => ({ comparable: true, passed: false, reason: 'worse-than-incumbent', evaluationDate: '2026-10-28', commonRows: 9994,
  candidate: { rows: 9994, maeSeconds: 284.3, intervalCoverage: 0.8446, upperCoverage: 0.9216 }, incumbent: { rows: 9994, maeSeconds: 262.4, intervalCoverage: 0.8406, upperCoverage: 0.9179 }, ...overrides });
const gateResult = (overrides: Partial<IncumbentGate> = {}): IncumbentGate => ({ passed: true, failed: [], rows: 9994, evaluationDate: '2026-10-28',
  evaluations: { all: { rows: 9994, unsupported: 0, robustIntervalCoverage: 0.8406, robustUpperCoverage: 0.9179, meanRelativeWidth: 0.63 } }, ...overrides });

test('a candidate that loses to the model in service re-validates it only when that model passes every group of the gate, and is closed otherwise', async () => {
  const root = temporary(), store = new Store(join(root, 'store')), trained = kst('2026-10-29T18:17:00'), now = kst('2026-11-02T09:30:00');
  mkdirSync(store.root, { recursive: true });
  let clock = now;
  const ctx = { store, runId: 'run-x', now: () => clock, log: quiet() } as unknown as RunContext;
  const lost: MemberOutcome = { status: 'closed', reason: 'gate:worse-than-incumbent' };
  try {
    const text = bicycleCheckpoint(trained, trained + 7 * DAY_MS);
    await promote(store, 'bicycleRide', text, { runId: 'p1', now: trained + 60_000 });
    const measure = async () => gateResult();
    // One group of the gate fails: nothing changes, and the failing groups are recorded with the comparison.
    const closed = await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-28', lost, incumbentComparison(), async () => gateResult({ passed: false, failed: ['dayPart:morning', 'newOd'] }));
    const closedDetails = closed.details as { incumbentGate: IncumbentGate; comparison: IncumbentComparison };
    assert.equal(closed.status, 'closed'); assert.deepEqual(closedDetails.incumbentGate.failed, ['dayPart:morning', 'newOd']); assert.equal(closedDetails.comparison.reason, 'worse-than-incumbent');
    assert.equal((await readManifest(store))!.generation, 1);
    // It passes: outcome revalidated, one new generation, the sha256 is the same.
    const kept = await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-28', lost, incumbentComparison(), measure);
    assert.equal(kept.status, 'revalidated'); assert.equal(kept.reason, 'gate:worse-than-incumbent');
    const details = kept.details as { expiresAt: number; previousExpiresAt: number; generation: number; comparison: { candidate: { maeSeconds: number }; incumbent: { maeSeconds: number } } };
    assert.deepEqual([details.expiresAt, details.previousExpiresAt, details.generation], [now + 7 * DAY_MS, trained + 7 * DAY_MS, 2]);
    assert.deepEqual([details.comparison.candidate.maeSeconds, details.comparison.incumbent.maeSeconds], [284.3, 262.4]);
    // A candidate that failed its own quality gate has no comparison: the model in service is measured alone.
    let measured = 0; clock = now + 3 * DAY_MS;
    const alone = await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-29', { status: 'closed', reason: 'gate:quality-failed' }, null, async () => { measured++; return gateResult(); });
    assert.equal(measured, 1); assert.equal(alone.status, 'revalidated');
    // The gate could not run (no reference for these bytes, or it crashed): the closed outcome stands.
    assert.equal((await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-30', lost, null, async () => gateResult({ passed: false, failed: ['reference-missing'], rows: 0, evaluations: undefined }))).status, 'closed');
    const crashed = await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-30', lost, null, async () => { throw new Error('gate exploded'); });
    assert.equal(crashed.status, 'closed'); assert.match(crashed.reason, /revalidation-refused:gate exploded/);
    // A ceiling reached or a changed model refuses and says so in the reason.
    const refused = await keepIncumbent(ctx, 'bicycleRide', bicycleCheckpoint(trained, trained + 7 * DAY_MS, 9), '2026-10-31', lost, incumbentComparison(), measure);
    assert.equal(refused.status, 'closed'); assert.match(refused.reason, /revalidation-refused:revalidation-model-changed/);
    // Nothing in the store is served from a model that no longer matches: verify still passes.
    assert.equal((await verifyManifest(store, now)).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function busHarness(trainSpatial: (call: number) => StepResult) {
  const root = temporary(), store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(store.root, { recursive: true }); mkdirSync(work);
  const E = '2026-10-28', dates = trainingWindow(E).dates, index = indexOf(dates.map(day => archive(day, true)));
  mkdirSync(store.taims, { recursive: true }); mkdirSync(store.context, { recursive: true });
  for (const entry of Object.values(index.archives)) writeFileSync(join(store.taims, entry.name), 'zip');
  writeFileSync(join(store.context, 'topis-road-priors-2026-08-09.json'), '{}'); writeFileSync(join(store.context, 'spatial-transit-stations.csv'), 'x');
  const calls: Record<string, number> = {}, seen: string[][] = [];
  const ok = (json: Record<string, unknown> = {}): StepResult => ({ code: 0, stdout: JSON.stringify(json), stderr: '', ms: 1, json });
  const runner = async (request: StepRequest): Promise<StepResult> => {
    calls[request.name] = (calls[request.name] ?? 0) + 1;
    const arg = (flag: string) => request.args[request.args.indexOf(flag) + 1];
    if (request.name === 'prepare-bus') {
      writeFileSync(arg('--output'), '{}\n');
      writeFileSync(`${arg('--output')}.manifest.json`, JSON.stringify({ outputRows: 14 * 9000, routeNumberFallbacks: [], archives: dates.map(day => ({ sourceDates: [day], outputRows: 9000 })) })); return ok();
    }
    if (request.name === 'join-context') { writeFileSync(arg('--output'), '{}\n'); writeFileSync(`${arg('--output')}.manifest.json`, '{}'); return ok(); }
    if (request.name === 'train-public-bus') {
      mkdirSync(join(request.env.JIGAK_EVALUATION_JOURNAL_DIR!, 'public-bus-refresh-evaluations'), { recursive: true });
      writeFileSync(join(request.env.JIGAK_EVALUATION_JOURNAL_DIR!, 'public-bus-refresh-evaluations', `${E}.json`), '{"version":1}');
      writeFileSync(arg('--output'), '{"status":"refused","qualityPassed":false}'); return ok({ status: 'refused', qualityPassed: false });
    }
    if (request.name === 'train-spatial-bus') { seen.push(request.args); const result = trainSpatial(calls[request.name]); if (result.code === 0) { const directory = arg('--output-directory'); mkdirSync(directory, { recursive: true }); for (const name of ['protocol.json', 'model.json', 'parity.json']) writeFileSync(join(directory, name), '{}'); writeFileSync(join(directory, 'report.json'), '{"qualityPassed":false,"qualityFailedGroups":["dayPart:morning"]}'); } return result; }
    throw new Error(`unexpected ${request.name}`);
  };
  const weather = (async () => ({ status: 200, text: async () => 'STATION|DATE\n' })) as unknown as typeof fetch;
  const context = (runId: string): RunContext => { mkdirSync(join(work, runId), { recursive: true }); return { store, runId, now: () => kst('2026-11-02T05:30:00'), mode: 'local', plan: false, log: quiet(), projectDir: resolve('.'),
    workDir: join(work, runId), holidayDir: join(work, runId, 'holidays'), python: 'python3', routeTablePolicy: 'nearest-consistent', runner, env: { ...process.env }, workers: 1 }; };
  return { root, store, E, index, calls, seen, context, weather };
}
const crash = (reason: string): StepResult => ({ code: 1, stdout: '', stderr: '', ms: 1, json: { error: 'spatial_bus_v3_training_refused', kind: 'crash', reason } });

test('a trainer crash is retried with the finished stages reused and closes the day only after three; a refusal closes it at once', async () => {
  const h = busHarness(() => crash("KeyError: 'model'"));
  try {
    // The public bus candidate was refused (no model in its report) and the store has no public bus model to stand in for it.
    const first = await attemptBusGroup(h.context('one'), { evaluationDate: h.E, index: h.index, members: ['spatialBus'], fetchImpl: h.weather });
    assert.equal(first.status, 'finished'); assert.equal(first.members.spatialBus!.status, 'closed');
    assert.equal(first.members.spatialBus!.reason, 'gate:no-public-bus-reference');
  } finally { rmSync(h.root, { recursive: true, force: true }); }

  const retry = busHarness(() => crash("KeyError: 'model'"));
  try {
    await promote(retry.store, 'bicycleRide', bicycleCheckpoint(kst('2026-10-29T18:17:00'), kst('2026-11-05T18:17:00')), { runId: 'p', now: kst('2026-10-29T18:18:00') });
    const manifest = (await readManifest(retry.store))!;
    // Borrow the bicycle entry as the "public bus incumbent": only its presence matters to the stand-in, the trainer is a mock.
    await writeManifest(retry.store, manifest, { runId: 'p', models: { ...manifest.models, publicBus: manifest.models.bicycleRide! }, calendars: {} });
    const runs: string[] = [];
    for (const name of ['one', 'two', 'three', 'four']) {
      const record = await attemptBusGroup(retry.context(name), { evaluationDate: retry.E, index: retry.index, members: ['spatialBus'], fetchImpl: retry.weather });
      runs.push(`${record.status}:${record.members.spatialBus!.status}:${record.errors}`);
    }
    assert.deepEqual(runs, ['open:failed:1', 'open:failed:2', 'closed:closed:3', 'closed:closed:3'], 'two retries, then closed with the reason; a closed day is not run again');
    assert.match((await readAttemptFile(retry.store, retry.E)).members.spatialBus!.reason, /^retries-exhausted:train-spatial-bus:spatial_bus_v3_training_refused:KeyError: 'model'/);
    assert.deepEqual(retry.calls, { 'prepare-bus': 1, 'join-context': 1, 'train-public-bus': 1, 'train-spatial-bus': 3 }, 'preparation and the public bus report are done once');
    assert.ok(retry.seen[0].includes('--fallback-reference'), 'the refused public bus report is replaced by the served model');
    // An open attempt is the one day that may be chosen again although the public bus journal has it.
    const choose = (resumable: string[]) => chooseEvaluationDate({ index: retry.index, now: kst('2026-11-02T09:30:00'), incumbentDates: ['2026-10-16'], usedDates: new Set(['2026-10-28']), closedDates: new Set(), resumableDates: new Set(resumable), policy: 'nearest-consistent' }).evaluationDate;
    assert.equal(choose([]), null); assert.equal(choose(['2026-10-28']), '2026-10-28');
  } finally { rmSync(retry.root, { recursive: true, force: true }); }

  const refusal = busHarness(() => ({ code: 1, stdout: '', stderr: '', ms: 1, json: { error: 'spatial_bus_v3_training_refused', kind: 'refused', reason: 'insufficient_rows' } }));
  try {
    await promote(refusal.store, 'bicycleRide', bicycleCheckpoint(kst('2026-10-29T18:17:00'), kst('2026-11-05T18:17:00')), { runId: 'p', now: kst('2026-10-29T18:18:00') });
    const manifest = (await readManifest(refusal.store))!;
    await writeManifest(refusal.store, manifest, { runId: 'p', models: { ...manifest.models, publicBus: manifest.models.bicycleRide! }, calendars: {} });
    const record = await attemptBusGroup(refusal.context('one'), { evaluationDate: refusal.E, index: refusal.index, members: ['spatialBus'], fetchImpl: refusal.weather });
    assert.deepEqual([record.status, record.members.spatialBus!.status], ['finished', 'closed']);
    assert.match(record.members.spatialBus!.reason, /insufficient_rows/);
  } finally { rmSync(refusal.root, { recursive: true, force: true }); }
});

async function readAttemptFile(store: Store, date: string) { return JSON.parse(readFileSync(store.path('candidates', 'bus', date, 'attempt.json'), 'utf8')) as AttemptRecord; }

test('a bundle carries the store\'s re-validation of exactly the same bytes, and init applies it only while it is a valid extension', async () => {
  const root = temporary(), trained = kst('2026-10-29T18:17:00'), now = kst('2026-11-02T09:30:00');
  try {
    const measured = new Store(join(root, 'measured')), text = bicycleCheckpoint(trained, trained + 7 * DAY_MS);
    const promoted = await promote(measured, 'bicycleRide', text, { runId: 'p1', now: trained + 60_000 });
    await revalidate(measured, 'bicycleRide', { runId: 'r1', now, evaluationDate: '2026-10-28', sha256: promoted.object.sha256, candidate: 'gate:worse-than-incumbent', evidence: {} });
    const operational = join(root, 'src', 'operational'), calendars = join(root, 'src', 'calendars'), out = join(root, 'bundle');
    mkdirSync(operational, { recursive: true }); mkdirSync(calendars, { recursive: true });
    writeFileSync(join(operational, 'spatial-bicycle-operational.json'), text); writeFileSync(join(calendars, 'korea-holidays-2026.json'), readFileSync(resolve('..', 'src', 'common', 'engine', 'realtime', 'data', 'korea-holidays-2026.json')));
    const sources = { operational, journals: join(root, 'src', 'journals'), calendars, bicycleSeed: join(root, 'src', 'seed'), roadPriors: join(root, 'src', 'priors.json'), stations: join(root, 'src', 'stations.csv') };
    writeFileSync(sources.roadPriors, '{}'); writeFileSync(sources.stations, 'x'); mkdirSync(sources.bicycleSeed);
    for (const name of ['protocol.json', 'model.json', 'report.json', 'parity.json']) writeFileSync(join(sources.bicycleSeed, name), '{}');
    const bundled = await buildBundle(sources, out, { store: measured });
    assert.ok(bundled.copied.includes('operational/revalidations.json'));
    const fromBundle = bundleSources(out);
    const fresh = new Store(join(root, 'fresh'));
    const result = await initStore(fresh, fromBundle, { runId: 'i1', now });
    assert.deepEqual(result.revalidated, ['bicycleRide']);
    const entry = (await readManifest(fresh))!.models.bicycleRide!;
    assert.equal(entry.expiresAt, now + 7 * DAY_MS); assert.equal(entry.revalidationCount, 1); assert.equal(entry.sha256, promoted.object.sha256);
    // Other bytes under the same name: the extension does not apply.
    writeFileSync(join(out, 'operational', 'spatial-bicycle-operational.json'), bicycleCheckpoint(trained, trained + 7 * DAY_MS, 5));
    const other = new Store(join(root, 'other'));
    assert.deepEqual((await initStore(other, fromBundle, { runId: 'i2', now })).revalidated, []);
    assert.equal((await readManifest(other))!.models.bicycleRide!.expiresAt, trained + 7 * DAY_MS);
    assert.equal((await verifyManifest(fresh, now)).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a full disk during a download leaves no .partial file and no retry loop, and the run still reports and releases its lock; a crash also releases it', async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module'), { Writable } = await import('node:stream');
  const fs = createRequire(resolve('package.json'))('node:fs') as typeof import('node:fs');
  const root = temporary(), store = new Store(join(root, 'store')), original = fs.createWriteStream;
  const entry = { name: 'TAIMS_20261101.zip', id: '16031', url: `${TDATA_ORIGIN}/dataprovide/download.do?id=16031`, publicationDate: '2026-11-01', serviceDate: '2026-10-28' };
  const body = () => new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(5000)); controller.close(); } });
  let gets = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(TDATA_CATALOG)) return { status: 200, url, text: async () => `<option value="${entry.id}">${entry.name}</option>` };
    if (init?.method === 'HEAD') return { status: 200, url, headers: new Headers({ 'content-length': '50000' }) };
    gets++; return { status: 200, url: `${TDATA_ORIGIN}/dataprovide/download.do?id=${entry.id}`, body: body() };
  }) as unknown as typeof fetch;
  // The device fills up after the first kilobyte: the write fails the way a real one does (ENOSPC) and the half file is on disk.
  (fs as { createWriteStream: unknown }).createWriteStream = (path: string) => new Writable({ write(chunk, _encoding, done) {
    fs.appendFileSync(path, chunk.subarray(0, 1024));
    done(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -28, syscall: 'write' }));
  } });
  syncBuiltinESMExports();
  try {
    mkdirSync(store.root, { recursive: true });
    await assert.rejects(downloadArchive(store, entry, 50000, { fetchImpl, backoffMs: 1 }), /ENOSPC/);
    assert.equal(gets, 1, 'a full disk is not retried');
    assert.deepEqual(readdirSync(store.taims), [], 'no .partial and no archive left behind');
    // The whole run: the failed download is reported, the run is not a crash, the lock is gone and the status file was written.
    await promote(store, 'bicycleRide', bicycleCheckpoint(kst('2026-10-29T18:17:00'), kst('2026-11-09T18:17:00')), { runId: 'p', now: kst('2026-10-29T18:18:00') });
    const report = await runRefresh({ storeRoot: store.root, projectDir: resolve('.'), workBase: join(root, 'work'), now: () => kst('2026-11-02T09:30:00'), fetchImpl, skipHolidays: true,
      runner: async () => { throw new Error('no trainer may start without a window'); }, python: 'python', log: quiet() });
    assert.notEqual(report.outcome, 'crash'); assert.equal(report.exitCode, 0);
    assert.match(report.taims.problems.join('\n'), /download:TAIMS_20261101\.zip:ENOSPC/); assert.deepEqual(report.taims.downloaded, []);
    assert.ok(!existsSync(store.lock), 'lock released'); assert.ok(existsSync(store.status), 'status written'); assert.deepEqual(readdirSync(store.taims).filter(name => name.endsWith('.partial')), []);
    assert.ok(!existsSync(join(root, 'work', report.runId)), 'work folder removed');
    // A crash (no manifest) takes the same road out.
    const empty = new Store(join(root, 'empty')); mkdirSync(empty.root, { recursive: true });
    const crashed = await runRefresh({ storeRoot: empty.root, projectDir: resolve('.'), workBase: join(root, 'work'), fetchImpl, skipHolidays: true, log: quiet() });
    assert.deepEqual([crashed.outcome, crashed.exitCode], ['crash', 1]); assert.match(crashed.alerts.join(), /manifest-missing/); assert.ok(!existsSync(empty.lock));
  } finally { (fs as { createWriteStream: unknown }).createWriteStream = original; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test('re-validation never outlives the holiday calendar inside the model file, and says what cut it', async () => {
  // As the 10-31 spatial bus and rail gate files: own life to 11/07 00:40, calendar through 11/07, nothing predicted from 11/08.
  // A request at the expiry may board up to 4 h later, so the last one the calendar covers is 11/07 20:00.
  const root = temporary(), store = new Store(join(root, 'store')), trained = kst('2026-10-31T00:40:00'), now = kst('2026-11-02T03:22:00');
  mkdirSync(store.root, { recursive: true });
  const ctx = { store, runId: 'run-c', now: () => now, log: quiet() } as unknown as RunContext;
  try {
    const text = bicycleCheckpoint(trained, trained + 7 * DAY_MS, 0, '2026-11-07'), calendarEnd = kst('2026-11-07T20:00:00');
    const promoted = await promote(store, 'bicycleRide', text, { runId: 'p1', now: trained + 60_000 });
    const kept = await keepIncumbent(ctx, 'bicycleRide', text, '2026-10-29', { status: 'closed', reason: 'gate:worse-than-incumbent' }, incumbentComparison(), async () => gateResult());
    assert.equal(kept.status, 'revalidated');
    const details = kept.details as { expiresAt: number; clippedBy: string; calendarLastDate: string };
    assert.deepEqual([details.expiresAt, details.clippedBy, details.calendarLastDate], [calendarEnd, 'calendar-end', '2026-11-07'], 'now + 7 days (11/09) is cut to the calendar end');
    const entry = (await readManifest(store))!.models.bicycleRide!;
    assert.equal(entry.expiresAt, calendarEnd); assert.equal(entry.revalidations![0].clippedBy, 'calendar-end');
    // A later passing day adds nothing: refused, with the reason.
    await assert.rejects(revalidate(store, 'bicycleRide', { runId: 'r2', now: now + DAY_MS, evaluationDate: '2026-10-30', sha256: promoted.object.sha256, candidate: 'c', evidence: {} }), /revalidation-limit-reached:calendar-end/);
    // An entry written before this rule (the Windows store said 11/09 03:22) is read at the calendar end by the runner too.
    const manifest = (await readManifest(store))!;
    await writeManifest(store, manifest, { runId: 'old', models: { ...manifest.models, bicycleRide: { ...entry, expiresAt: kst('2026-11-09T03:22:00') } }, calendars: manifest.calendars });
    const old = (await readManifest(store))!.models.bicycleRide!;
    assert.equal(await effectiveExpiry(store, old), calendarEnd);
    assert.equal(weeklyTiming('spatialBus', await effectiveExpiry(store, old), kst('2026-11-07T01:00:00')).atRisk, true);
    const verified = (await verifyManifest(store, kst('2026-11-08T01:00:00'))).models.bicycleRide as { effectiveExpiresAt: number; expired: boolean };
    assert.deepEqual([verified.effectiveExpiresAt, verified.expired], [calendarEnd, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init cuts a bundled re-validation at the calendar end of the very file it extends', async () => {
  const root = temporary(), trained = kst('2026-10-31T00:40:00'), now = kst('2026-11-02T09:30:00');
  try {
    const text = bicycleCheckpoint(trained, trained + 7 * DAY_MS, 0, '2026-11-07'), sha256 = createHash('sha256').update(text).digest('hex');
    const operational = join(root, 'operational'), calendars = join(root, 'calendars');
    mkdirSync(operational, { recursive: true }); mkdirSync(calendars, { recursive: true });
    writeFileSync(join(operational, 'spatial-bicycle-operational.json'), text);
    writeFileSync(join(calendars, 'korea-holidays-2026.json'), readFileSync(resolve('..', 'src', 'common', 'engine', 'realtime', 'data', 'korea-holidays-2026.json')));
    // What the Windows bundle carries: an extension to 11/09 03:22, past the file's calendar.
    writeFileSync(join(operational, 'revalidations.json'), JSON.stringify({ bicycleRide: { sha256, expiresAt: kst('2026-11-09T03:22:00'), revalidatedAt: kst('2026-11-02T03:22:00'), revalidationCount: 1, revalidations: [] } }));
    const sources = { operational, journals: join(root, 'journals'), calendars, bicycleSeed: join(root, 'seed'), roadPriors: join(root, 'priors.json'), stations: join(root, 'stations.csv') };
    const store = new Store(join(root, 'store'));
    assert.deepEqual((await initStore(store, sources, { runId: 'i1', now })).revalidated, ['bicycleRide']);
    const entry = (await readManifest(store))!.models.bicycleRide!;
    assert.deepEqual([entry.expiresAt, entry.expiryClippedBy, entry.revalidationCount], [kst('2026-11-07T20:00:00'), 'calendar-end', 1]);
    // A bundle rebuilt from a store whose manifest still says 11/09 carries the cut value.
    const manifest = (await readManifest(store))!;
    await writeManifest(store, manifest, { runId: 'old', models: { ...manifest.models, bicycleRide: { ...entry, expiresAt: kst('2026-11-09T03:22:00') } }, calendars: manifest.calendars });
    writeFileSync(sources.roadPriors, '{}'); writeFileSync(sources.stations, 'x'); mkdirSync(sources.bicycleSeed);
    for (const name of ['protocol.json', 'model.json', 'report.json', 'parity.json']) writeFileSync(join(sources.bicycleSeed, name), '{}');
    await buildBundle(sources, join(root, 'bundle'), { store });
    assert.equal(JSON.parse(readFileSync(join(root, 'bundle', 'operational', 'revalidations.json'), 'utf8')).bicycleRide.expiresAt, kst('2026-11-07T20:00:00'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundle and init carry the incumbent references of exactly the bundled bytes, so the first generation can be re-validated', async () => {
  const root = temporary(), trained = kst('2026-10-29T18:17:00'), now = kst('2026-11-02T09:30:00');
  try {
    const text = bicycleCheckpoint(trained, trained + 7 * DAY_MS), sha256 = sha256Of(text), stale = sha256Of('older bytes');
    const operational = join(root, 'src', 'operational'), calendars = join(root, 'src', 'calendars'), references = join(root, 'src', 'model-references');
    for (const directory of [operational, calendars, references]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(operational, 'spatial-bicycle-operational.json'), text);
    writeFileSync(join(calendars, 'korea-holidays-2026.json'), readFileSync(resolve('..', 'src', 'common', 'engine', 'realtime', 'data', 'korea-holidays-2026.json')));
    const reference = (model: string, checkpointSha256: string) => JSON.stringify({ version: 'jigak-incumbent-reference-v1', model, checkpointSha256 });
    // The development folder is flat (mvp/data/model-references/<sha256>.json): the bytes in the bundle, older bytes, a wrong name, another model's bytes.
    writeFileSync(join(references, `${sha256}.json`), reference('bicycleRide', sha256));
    writeFileSync(join(references, `${stale}.json`), reference('bicycleRide', stale));
    writeFileSync(join(references, `${'0'.repeat(64)}.json`), reference('bicycleRide', sha256));
    writeFileSync(join(references, `${sha256Of('bus')}.json`), reference('spatialBus', sha256Of('bus')));
    const sources = { operational, journals: join(root, 'src', 'journals'), calendars, bicycleSeed: join(root, 'src', 'seed'), roadPriors: resolve('data-static', 'topis-road-priors-2026-08-09.json'),
      stations: resolve('data-static', 'spatial-transit-stations.csv'), references };
    mkdirSync(sources.bicycleSeed); for (const name of ['protocol.json', 'model.json', 'report.json', 'parity.json']) writeFileSync(join(sources.bicycleSeed, name), '{}');
    const out = join(root, 'bundle'), bundled = await buildBundle(sources, out);
    assert.deepEqual(bundled.copied.filter(path => path.startsWith('references/')), [`references/bicycleRide/${sha256}.json`]);
    assert.deepEqual(bundled.missingReferences, []);

    const store = new Store(join(root, 'store')), result = await initStore(store, bundleSources(out), { runId: 'i1', now });
    assert.deepEqual(result.references, [`bicycleRide/${sha256}`]);
    assert.equal(readFileSync(referencePath(store, 'bicycleRide', sha256), 'utf8'), reference('bicycleRide', sha256), 'stored where the incumbent gate looks for it');
    assert.equal(existsSync(referencePath(store, 'bicycleRide', stale)), false);
    // The fixed inputs land outside raw/ (deleted by the bucket after 21 days), only with the expected bytes.
    assert.deepEqual(result.staticInputs, { 'topis-road-priors-2026-08-09.json': 'written', 'spatial-transit-stations.csv': 'written' });
    assert.ok(existsSync(join(store.static, 'spatial-transit-stations.csv')));
    assert.equal(existsSync(join(store.context, 'spatial-transit-stations.csv')), false);

    // A bundle from a store carries the references that store keeps for the bytes it bundles.
    const again = await buildBundle({ ...sources, references: join(root, 'none') }, join(root, 'bundle-2'), { store });
    assert.ok(again.copied.includes(`references/bicycleRide/${sha256}.json`));
    // Static inputs with other bytes are not written; the runner then uses the committed copy.
    writeFileSync(join(root, 'priors.json'), '{}');
    const other = new Store(join(root, 'other'));
    assert.equal((await initStore(other, { ...sources, roadPriors: join(root, 'priors.json') }, { runId: 'i2', now })).staticInputs['topis-road-priors-2026-08-09.json'], 'mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a run killed during training (no error recorded) is counted before it starts, and the day closes after three such runs', async () => {
  let snapshot = '';
  const h = busHarness(() => { snapshot = readFileSync(h.store.path('candidates', 'bus', h.E, 'attempt.json'), 'utf8'); return crash('SIGKILL'); });
  try {
    await promote(h.store, 'bicycleRide', bicycleCheckpoint(kst('2026-10-29T18:17:00'), kst('2026-11-05T18:17:00')), { runId: 'p', now: kst('2026-10-29T18:18:00') });
    const manifest = (await readManifest(h.store))!;
    await writeManifest(h.store, manifest, { runId: 'p', models: { ...manifest.models, publicBus: manifest.models.bicycleRide! }, calendars: {} });
    const seen: string[] = [];
    for (const name of ['one', 'two', 'three']) {
      await attemptBusGroup(h.context(name), { evaluationDate: h.E, index: h.index, members: ['spatialBus'], fetchImpl: h.weather });
      // The container died inside the trainer: what is on disk is the record as saved before the step began.
      const saved = JSON.parse(snapshot) as AttemptRecord;
      seen.push(`${saved.status}:${saved.runs}:${saved.errors ?? 0}`);
      writeFileSync(h.store.path('candidates', 'bus', h.E, 'attempt.json'), snapshot);
    }
    assert.deepEqual(seen, ['open:1:0', 'open:2:0', 'open:3:0'], 'each run is on disk before training starts');
    assert.ok((await openAttemptDates(h.store)).has(h.E));
    const fourth = await attemptBusGroup(h.context('four'), { evaluationDate: h.E, index: h.index, members: ['spatialBus'], fetchImpl: h.weather });
    assert.equal(fourth.status, 'closed'); assert.equal(fourth.members.spatialBus!.status, 'closed');
    assert.match(fourth.members.spatialBus!.reason, /^retries-exhausted:unfinished-run/);
    assert.equal(h.calls['train-spatial-bus'], 3, 'the fourth run does not train again');
    assert.equal((await readAttemptFile(h.store, h.E)).status, 'closed');
    assert.ok(!(await openAttemptDates(h.store)).has(h.E), 'a closed day is no longer resumable, so the next choice moves on');
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

test('the served holiday slice reaches trainedAt + 28 days where reviewed years cover it, and never less than the model\'s own life', () => {
  const file = (year: number, reviewAfter: string, holidays: string[]) => JSON.stringify({ year, verifiedAt: '2026-10-01T00:00:00+09:00', reviewAfter, source: 'https://example.test/h', holidays });
  const y2026 = file(2026, '2027-02-01T00:00:00+09:00', ['2026-10-03', '2026-12-25']), now = kst('2026-11-02T09:00:00');
  const only2026 = parseKoreanHolidayFiles([y2026]);
  assert.equal(servingCalendarLastDate(only2026, '2026-10-17', kst('2026-10-31T00:40:00'), kst('2026-11-07T00:40:00'), now), '2026-11-28');
  // 28 days reach into 2027: without a 2027 file, or with one past its review, the slice stops at 12-31.
  const december = kst('2026-12-20T00:40:00');
  assert.equal(servingCalendarLastDate(only2026, '2026-12-06', december, december + 7 * DAY_MS, now), '2026-12-31');
  const stale2027 = parseKoreanHolidayFiles([y2026, file(2027, '2026-11-01T00:00:00+09:00', ['2027-01-01'])]);
  assert.equal(servingCalendarLastDate(stale2027, '2026-12-06', december, december + 7 * DAY_MS, now), '2026-12-31');
  const fresh2027 = parseKoreanHolidayFiles([y2026, file(2027, '2027-02-01T00:00:00+09:00', ['2027-01-01'])]);
  assert.equal(servingCalendarLastDate(fresh2027, '2026-12-06', december, december + 7 * DAY_MS, now), '2027-01-17');
  // The model's own 7 days are never cut; the promoter then refuses that range as before.
  const late = kst('2026-12-28T00:40:00');
  assert.equal(servingCalendarLastDate(only2026, '2026-12-14', late, late + 7 * DAY_MS, now), '2027-01-04');
});

test('the calendar cap leaves the 4 h of late boardings the promoters keep, and never shortens a file\'s own life', () => {
  const at = (expiresAt: number, lastDate: string) => calendarEndOf({ expiresAt, calendar: { lastDate } })!.endsAt;
  // Spatial bus / rail gate (calendar through seoulDate(expiresAt + 4 h)): an extension stops at 20:00, and a request then boards by 24:00.
  const busCap = at(kst('2026-11-07T00:40:00'), '2026-11-07');
  assert.equal(busCap, kst('2026-11-07T20:00:00'));
  assert.equal(seoulDate(busCap - 1 + LATE_SERVICE_MS), '2026-11-07');
  // A freshly promoted file: the 28-day cap ends before its calendar cap, so age (not the calendar) is what cuts it.
  const trained = kst('2026-10-31T00:40:00');
  assert.ok(at(trained + 7 * DAY_MS, seoulDate(trained + MAX_MODEL_AGE_MS + LATE_SERVICE_MS)) > trained + MAX_MODEL_AGE_MS);
  // The bicycle file ends at the midnight after its calendar (no late margin): it keeps that life.
  assert.equal(at(kst('2026-11-15T00:00:00'), '2026-11-14'), kst('2026-11-15T00:00:00'));
  // A file that says more than its own calendar is cut at that midnight; no calendar, no cap.
  assert.equal(at(kst('2026-11-09T00:00:00'), '2026-11-07'), kst('2026-11-08T00:00:00'));
  assert.equal(calendarEndOf({ expiresAt: 1 }), null);
});

test('spatial bus promotion embeds the reviewed calendar through trainedAt + 28 days', async () => {
  const root = temporary(), experiment = join(root, 'spatial-bus-refresh'), output = join(root, 'checkpoint', 'spatial-bus-operational.json');
  mkdirSync(experiment, { recursive: true }); mkdirSync(join(root, 'checkpoint'));
  const trainedAt = kst('2026-10-31T00:40:46'), now = kst('2026-11-02T09:00:00'), N = SPATIAL_BUS_FEATURE_NAMES.length;
  const candidate = { version: SPATIAL_BUS_V3, trainedAt, trainingThrough: '2026-10-23', featureNames: [...SPATIAL_BUS_FEATURE_NAMES],
    models: { mean: leaf(400), lower: leaf(300), median: leaf(380), upper: leaf(500) }, featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: { holidays: [] }, conformal: SPATIAL_BUS_GROUPS.map(group => ({ group, logLower: 0, logUpper: 0 })),
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) }, meanInterpretation: 'conditional tag-elapsed mean, not validated route ETA', limitations: ['unit'] };
  const modelText = JSON.stringify(candidate);
  // Parity cases from the TypeScript side itself: this test is about the calendar, not about sklearn.
  const reference = parseSpatialBusCheckpoint(JSON.stringify({ ...candidate, deployment: 'production', target: 'bus-tag-elapsed', expiresAt: trainedAt + 7 * DAY_MS, lastEvaluatedServiceDate: '2026-10-30',
    calendar: { rule: 'korean-public-holiday-as-sunday', firstDate: '2026-10-17', lastDate: '2026-11-30', holidays: [] }, labelUncertaintySeconds: 60, evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'c'.repeat(64), modelSha256: 'd'.repeat(64) } }));
  const cases = Array.from({ length: 120 }, (_, i) => {
    const input: SpatialBusInput = { startedAt: kst('2026-10-30T05:00:00') + i * 8 * 60_000, distanceMeters: 1500 + i * 10, stopCount: 2 + (i % 5), originLatitude: 37.55, originLongitude: 126.97, destinationLatitude: 37.54, destinationLongitude: 126.98 };
    const envelope = predictSpatialBusEnvelope(reference, input)!;
    return { input, features: spatialBusFeatures(input, holidayAsSunday(reference.calendar)), lowerSeconds: envelope.lowerSeconds, upperSeconds: envelope.upperSeconds };
  });
  writeFileSync(join(experiment, 'protocol.json'), JSON.stringify({ phase: 'refresh', first: '2026-10-17', evaluation: ['2026-10-30'] }));
  writeFileSync(join(experiment, 'model.json'), modelText);
  writeFileSync(join(experiment, 'report.json'), JSON.stringify({ version: SPATIAL_BUS_V3, qualityPassed: true, qualityFailedGroups: [], evaluations: { all: {} },
    reproducibility: { modelSha256: createHash('sha256').update(modelText).digest('hex'), protocolSha256: 'c'.repeat(64) } }));
  writeFileSync(join(experiment, 'parity.json'), JSON.stringify({ cases }));
  const previous = process.env.JIGAK_DATA_ROOT;
  process.env.JIGAK_DATA_ROOT = root;
  try {
    const { promoteSpatialBus } = await import('../scripts/promote-spatial-bus');
    const result = await promoteSpatialBus(['--experiment', experiment, '--output', output], { now });
    const served = parseSpatialBusCheckpoint(readFileSync(output, 'utf8'));
    assert.equal(served.expiresAt, trainedAt + 7 * DAY_MS, 'the file still lives 7 days');
    assert.deepEqual([served.calendar.firstDate, served.calendar.lastDate], ['2026-10-17', '2026-11-28'], 'trainedAt + 28 days, not the old 11/07');
    assert.equal(result.parityCases, 120);
    // So a re-validation on 11/06 can genuinely reach 11/13: the model still predicts on 11/12.
    assert.ok(predictSpatialBusEnvelope(served, { ...cases[0].input, startedAt: kst('2026-11-12T08:00:00') }));
  } finally {
    if (previous === undefined) delete process.env.JIGAK_DATA_ROOT; else process.env.JIGAK_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
