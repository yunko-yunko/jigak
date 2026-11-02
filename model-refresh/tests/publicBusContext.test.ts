import { assertPrivateFile } from './helpers/private-files';
import { PYTHON_COMMAND } from '../scripts/python-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  normalizeGhcnhPsv, lookupHistoricalWeather, lookupPublishedRoadPrior, preparePublishedRoadPriorLookup, joinPublicBusContexts,
  type RoadPriorArchive,
} from '../../src/common/engine/intelligence/historical-context';

const stamp = (text: string) => Date.parse(text);
const header = ['STATION', 'DATE', 'LATITUDE', 'LONGITUDE', 'temperature', 'temperature_Quality_Code', 'wind_speed', 'wind_speed_Quality_Code', 'precipitation', 'precipitation_Quality_Code', 'precipitation_Measurement_Code'];
const psv = (...rows: string[][]) => [header, ...rows].map(row => row.join('|')).join('\n');
const weatherRow = (at: string, temperature = '20.5', wind = '2.3', rain = '') => ['KSI0000RKSL', at, '37.5667', '126.9667', temperature, '', wind, '', rain, '', ''];
function archive(month = '2026-09', publishedAt = stamp('2026-10-01T09:14:16+09:00')): RoadPriorArchive {
  return { version: 1, source: 'topis-monthly', referenceMonth: month, publishedAt,
    spatialScope: 'seoul-citywide', aggregation: 'distance-weighted-harmonic', sourceArchiveSha256: 'a'.repeat(64),
    cells: ['weekday', 'saturday', 'sunday'].flatMap((weekType, day) => Array.from({ length: 24 }, (_, hour) => ({
      weekType: weekType as 'weekday' | 'saturday' | 'sunday', hour, speedKmh: 20 + day + hour / 10, sampleCount: 100, missingCount: 5,
    }))),
  };
}

test('NOAA normalization preserves actual units, UTC and unknown precipitation', () => {
  const rows = normalizeGhcnhPsv(psv(weatherRow('2026-10-01T01:00:00')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observedAt, stamp('2026-10-01T01:00:00Z'));
  assert.equal(rows[0].temperatureC, 20.5);
  assert.equal(rows[0].windMetersPerSecond, 2.3);
  assert.equal(rows[0].precipitationMm, null);
  assert.equal(rows[0].precipitationTrace, false);
});

test('normalization rejects wrong station, coordinate, dates and ambiguous duplicate timestamps', () => {
  const badRows = [
    [...weatherRow('2026-10-01T01:00:00')].map((value, index) => index === 0 ? 'another-station' : value),
    [...weatherRow('2026-10-01T01:00:00')].map((value, index) => index === 2 ? '35' : value),
    weatherRow('2026-02-30T01:00:00'), weatherRow('2026-10-01T25:00:00'),
  ];
  for (const row of badRows) assert.throws(() => normalizeGhcnhPsv(psv(row)));
  assert.throws(() => normalizeGhcnhPsv(psv(weatherRow('2026-10-01T01:00:00'), weatherRow('2026-10-01T01:00:00'))));
});

test('flagged, blank, nonfinite and invalid weather remain null; trace is distinct from a measured zero', () => {
  const first = weatherRow('2026-10-01T01:00:00', '20.5', 'Infinity', '0.0'); first[5] = 'c'; first[10] = 'T';
  const second = weatherRow('2026-10-01T02:00:00', '19', '-1', '-0.5');
  const rows = normalizeGhcnhPsv(psv(first, second));
  assert.equal(rows[0].temperatureC, null);
  assert.equal(rows[0].windMetersPerSecond, null);
  assert.equal(rows[0].precipitationMm, 0);
  assert.equal(rows[0].precipitationTrace, true);
  assert.equal(rows[1].precipitationMm, null);
  assert.equal(rows[1].windMetersPerSecond, null);
});

test('historical weather uses only the latest usable preceding observation within three hours', () => {
  const rows = normalizeGhcnhPsv(psv(weatherRow('2026-10-01T00:00:00'), weatherRow('2026-10-01T02:00:00', '21')));
  const context = lookupHistoricalWeather(rows, stamp('2026-10-01T01:00:00Z'))!;
  assert.equal(context.observedAt, stamp('2026-10-01T00:00:00Z'));
  assert.equal(context.ageSeconds, 3600);
  assert.equal(context.retrospective, true);
  assert.equal(context.availability, 'historical-publication-unknown');
  assert.equal(lookupHistoricalWeather(rows, stamp('2026-09-30T23:59:59Z')), null);
  assert.equal(lookupHistoricalWeather(rows, stamp('2026-10-01T05:00:01Z')), null);
  assert.equal(lookupHistoricalWeather(rows, NaN), null);
});

test('published road prior selection respects actual publication, prior month, KST hour and weekend class', () => {
  const august = archive('2026-08', stamp('2026-09-01T09:00:00+09:00')), september = archive();
  const before = lookupPublishedRoadPrior([august, september], stamp('2026-10-01T09:14:15+09:00'))!;
  assert.equal(before.referenceMonth, '2026-08');
  const after = lookupPublishedRoadPrior([august, september], stamp('2026-10-01T09:14:16+09:00'))!;
  assert.equal(after.referenceMonth, '2026-09');
  assert.equal(after.hour, 9);
  assert.equal(after.weekType, 'weekday');
  assert.equal(after.spatialScope, 'seoul-citywide');
  const saturday = lookupPublishedRoadPrior([august, september], stamp('2026-10-03T00:10:00+09:00'))!;
  assert.equal(saturday.hour, 0); assert.equal(saturday.weekType, 'saturday');
  assert.equal(lookupPublishedRoadPrior([august], stamp('2026-08-30T10:00:00+09:00')), null);
});

test('invalid or duplicate prior cells and unphysical speeds cannot enter a join', () => {
  const bad: unknown[] = [
    { ...archive(), referenceMonth: '2026-19' },
    { ...archive(), publishedAt: stamp('2026-09-01T00:00:00Z') },
    { ...archive(), aggregation: 'invented-traffic' },
    { ...archive(), cells: [...archive().cells, archive().cells[0]] },
    { ...archive(), cells: archive().cells.map((cell, index) => index ? cell : { ...cell, speedKmh: 0 }) },
  ];
  for (const value of bad) assert.throws(() => lookupPublishedRoadPrior([value as RoadPriorArchive], stamp('2026-10-03T00:10:00+09:00')));
});

// Reusing an index must neither leak a newer publication nor retain mutable archive/result objects.
test('prepared road lookup keeps publication boundaries and all calendar buckets while detaching caller mutation', () => {
  const priors = [archive('2026-08', stamp('2026-09-01T09:00:00+09:00')), archive()], prepared = preparePublishedRoadPriorLookup(priors);
  for (let hour = 0; hour < 24 * 10; hour++) {
    const at = stamp('2026-09-28T00:00:00+09:00') + hour * 3_600_000;
    assert.deepEqual(prepared(at), lookupPublishedRoadPrior(priors, at));
  }
  const published = priors[1].publishedAt;
  assert.equal(prepared(published - 1)?.referenceMonth, '2026-08');
  assert.equal(prepared(published)?.referenceMonth, '2026-09');
  const expected = prepared(published)!;
  priors[1].publishedAt += 30 * 86_400_000; priors[1].cells.forEach(cell => { cell.speedKmh = 150; });
  const modifiedResult = prepared(published)!; modifiedResult.speedKmh = 1;
  assert.deepEqual(prepared(published), expected);
  assert.equal(prepared(NaN), null);
  assert.throws(() => preparePublishedRoadPriorLookup([archive(), archive()]));
});

test('joining preserves source metadata, does not mutate input, and reports missing context separately', () => {
  const rows = [{ version: 2, id: 'test_a', startedAt: stamp('2026-10-01T10:30:00+09:00'), routeId: 'public-route' },
    { version: 2, id: 'test_b', startedAt: stamp('2026-09-01T08:00:00+09:00') }];
  const weather = normalizeGhcnhPsv(psv(weatherRow('2026-10-01T01:00:00')));
  const joined = joinPublicBusContexts(rows, weather, [archive()]);
  assert.equal(joined.rows[0].routeId, rows[0].routeId);
  assert.equal(joined.rows[0].weather?.temperatureC, 20.5);
  assert.equal(joined.rows[0].roadPrior?.referenceMonth, '2026-09');
  assert.equal(joined.rows[1].weather, null); assert.equal(joined.rows[1].roadPrior, null);
  assert.deepEqual(joined.counts, { input: 2, weather: 1, roadPrior: 1, missingWeather: 1, missingRoadPrior: 1 });
  assert.equal('weather' in rows[0], false);
  assert.throws(() => joinPublicBusContexts([{ ...rows[0], weather: {} }], weather, [archive()]));
});

test('context join CLI is private, deterministic, confined to ignored data and never overwrites', async () => {
  const folder = await mkdtemp(resolve('data/.context-test-'));
  const input = resolve(folder, 'input.jsonl'), weather = resolve(folder, 'weather.psv'), priors = resolve(folder, 'priors.json');
  const output = resolve(folder, 'joined.jsonl'), again = resolve(folder, 'again.jsonl');
  const row = { version: 2, id: 'synthetic_test_only', startedAt: stamp('2026-10-01T10:30:00+09:00') };
  const run = (target: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/join-public-bus-context.ts', '--input', input, '--weather', weather, '--road-priors', priors, '--output', target, '--execute'], { encoding: 'utf8', timeout: 20_000 });
  try {
    await writeFile(input, JSON.stringify(row) + '\n', { mode: 0o600 });
    await writeFile(weather, psv(weatherRow('2026-10-01T01:00:00')), { mode: 0o600 });
    await writeFile(priors, JSON.stringify({ version: 'topis-road-priors-v1', archives: [archive()] }), { mode: 0o600 });
    const first = run(output); assert.equal(first.status, 0, first.stderr);
    assertPrivateFile(output);
    assert.equal(first.stdout.includes('synthetic_test_only'), false);
    assert.equal(run(again).status, 0);
    assert.equal(await readFile(output, 'utf8'), await readFile(again, 'utf8'));
    assert.notEqual(run(output).status, 0);
    const existing = await readFile(output, 'utf8');
    const alias = resolve(folder, 'symlink.jsonl');
    // Windows file symlinks require a machine privilege; a hardlink exercises
    // the same existing-alias overwrite failure without changing that policy.
    if (process.platform === 'win32') await (await import('node:fs/promises')).link(output, alias);
    else await symlink(output, alias);
    assert.notEqual(run(alias).status, 0);
    assert.equal(await readFile(output, 'utf8'), existing);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
