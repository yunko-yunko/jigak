import { PYTHON_COMMAND } from '../scripts/python-runtime';
import { assertPrivateFile } from './helpers/private-files';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/prepare-public-bus-multiday.py');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'public-bus-multiday-'));
  mkdirSync(join(directory, 'data'), { recursive: true });
  const make = (day: string, name = day, sameVehicle = true, routeConflict = false, separateRuns = false, crossBoundary = false, routeTable = true) => {
    const path = join(directory, 'data', `TAIMS_${name}.zip`);
    const made = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `import csv,io,zipfile,sys
path,day,same,conflict,separate,boundary,route=sys.argv[1:]
def csvtext(headers,rows):
 f=io.StringIO(newline='');w=csv.writer(f);w.writerow(headers);w.writerows(rows);return f.getvalue().encode('utf-8-sig')
with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as z:
 if route=='true':z.writestr('VW_KSCC_DO_CARD.csv',csvtext(['ROUTE_ID','ROUTE_NUM'],[['public-route','7016']]+([['public-route','7017']] if conflict=='true' else [])))
 z.writestr('VW_KSCC_DH_CARD.csv',csvtext(['ROUTE_ID','BSST_ID','BSST_ORDER','BSST_SUM_DISTANCE','BSST_LAT','BSST_LON'],[['public-route','public-start','2','1000','12658.2000','3732.4000'],['public-route','public-mid','3','2000','12658.8000','3732.7000'],['public-route','public-end','5','4000','12659.4000','3733.0000']]))
 headers=['TRCR_ID','SERIAL_NUM','TRNS_MNS_CD','ROUTE_ID','VHCL_ID','TRIP_DEPR_DTM','RIDE_DTM','ALGH_DTM','RIDE_BSST_ID','ALGH_BSST_ID','STDR_DE']
 rows=[['secret-card-'+str(i),str(i),'115','public-route','secret-shared-vehicle' if same=='true' else 'secret-vehicle-'+day,day+('08'+str(i*10).zfill(2)+'00' if separate=='true' else '080000'),day+'083000',day+'084000','public-start','public-end',day] for i in range(3)]
 if boundary=='true':
  for row in rows:
   row[5]='20261010033000';row[6]='20261010035500' if day=='20261009' else '20261010040500';row[7]='20261010041000' if day=='20261009' else '20261010042000'
 z.writestr('VW_KSCC_DX_CARD.csv',csvtext(headers,rows))`, path, day, String(sameVehicle), String(routeConflict), String(separateRuns), String(crossBoundary), String(routeTable)], { encoding: 'utf8' });
    assert.equal(made.status, 0, 'create synthetic source fixture'); return path;
  };
  const output = join(directory, 'data', 'multiday.jsonl');
  const run = (inputs: string[], extra: string[] = []) => spawnSync(PYTHON_COMMAND, ['-X', 'utf8', script, '--inputs', ...inputs, '--output', output, '--execute', ...extra], { cwd: directory, encoding: 'utf8' });
  return { directory, make, output, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('multiday preparation preserves public path context and groups the same private vehicle across independent days', () => {
  const f = fixture();
  try {
    const result = f.run([f.make('20261009'), f.make('20261010')]); assert.equal(result.status, 0, result.stdout + result.stderr);
    const text = readFileSync(f.output, 'utf8'); const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.equal(new Set(rows.map(row => row.vehicleGroup)).size, 1); assert.equal(new Set(rows.map(row => row.groupId)).size, 2);
    assert.deepEqual(rows.map(row => row.sourceDate), ['2026-10-09', '2026-10-10']);
    for (const row of rows) {
      assert.equal(row.version, 2); assert.equal(row.routeId, 'public-route'); assert.equal(row.routeNumber, '7016');
      assert.equal(row.fromStopId, 'public-start'); assert.equal(row.toStopId, 'public-end'); assert.equal(row.fromOrder, 2); assert.equal(row.toOrder, 5);
      assert.equal(row.fromLatitude, 37.54); assert.equal(row.fromLongitude, 126.97);
      assert.equal(row.pathStopCoordinates.length, 3); assert.match(row.sourceArchiveSha256, /^[a-f0-9]{64}$/);
    }
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.archives.length, 2); assert.equal(manifest.outputRows, 2); assert.equal(manifest.maxGroupsPerSourceDate, 10_000);
    assert.equal(manifest.privateIdentifiersPersisted, false); assert.equal(manifest.runtimeModelActivated, false);
    assert.doesNotMatch(text + JSON.stringify(manifest) + result.stdout + result.stderr, /secret-|TRCR_ID|VHCL_ID/);
    assertPrivateFile(f.output);
  } finally { f.cleanup(); }
});

test('multiday preparation refuses duplicate source SHA or actual source day before counting repeated runs', () => {
  for (const exact of [true, false]) {
    const f = fixture();
    try {
      const first = f.make('20261009'); const second = exact ? join(f.directory, 'data', 'duplicate.zip') : f.make('20261009', '20261010', false);
      if (exact) copyFileSync(first, second);
      const result = f.run([first, second]); assert.notEqual(result.status, 0); assert.equal(existsSync(f.output), false);
      assert.match(result.stdout + result.stderr, exact ? /duplicate_archive_sha/ : /duplicate_source_date/); assert.doesNotMatch(result.stdout + result.stderr, /secret-/);
    } finally { f.cleanup(); }
  }
});

test('multiday preparation excludes nonexact ambiguous public route numbers and requires execute', () => {
  const f = fixture();
  try {
    const input = f.make('20261009', '20261009', true, true);
    const dry = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', script, '--inputs', input, '--output', f.output], { cwd: f.directory, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.equal(existsSync(f.output), false);
    const result = f.run([input]); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(f.output, 'utf8'), '');
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.archives[0].excluded.ambiguousRouteNumber, 3);
  } finally { f.cleanup(); }
});

test('multiday preparation samples physical runs with the same precommitted per-date cap', () => {
  const f = fixture();
  try {
    const result = f.run([f.make('20261009', '20261009', true, false, true), f.make('20261010', '20261010', true, false, true)], ['--max-groups-per-date', '1']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = readFileSync(f.output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.sourceDate), ['2026-10-09', '2026-10-10']);
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.maxGroupsPerSourceDate, 1);
    assert.deepEqual(manifest.archives.map((archive: { eligiblePhysicalRunsBeforeSampling: number }) => archive.eligiblePhysicalRunsBeforeSampling), [3, 3]);
  } finally { f.cleanup(); }
});

test('multiday preparation purges every observation of physical runs crossing the 04:00 service-date boundary', () => {
  const f = fixture();
  try {
    const result = f.run([f.make('20261009', '20261009', true, false, false, true), f.make('20261010', '20261010', true, false, false, true)]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(f.output, 'utf8'), '');
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.outputRowsBeforeCrossDatePurge, 2); assert.equal(manifest.crossDateDuplicatePhysicalRuns, 1);
    assert.equal(manifest.crossDateDuplicateObservationsPurged, 2); assert.equal(manifest.outputRows, 0);
    assert.deepEqual(manifest.crossDatePurgedCountsBySourceDate, { '2026-10-09': 1, '2026-10-10': 1 });
    assert.equal(manifest.batchCacheFiles.length, 2);
    for (const cache of manifest.batchCacheFiles) {
      assertPrivateFile(join(f.directory, cache.recordsPath));
    }
  } finally { f.cleanup(); }
});

test('a day published without its route table borrows only route numbers both neighbor days agree on, and records it', () => {
  const f = fixture();
  try {
    const inputs = [f.make('20261009'), f.make('20261010', '20261010', true, false, false, false, false), f.make('20261011')];
    const refused = f.run(inputs);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /route_table_missing/); assert.equal(existsSync(f.output), false);
    const result = f.run(inputs, ['--borrow-route-numbers']); assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = readFileSync(f.output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => [row.sourceDate, row.routeNumber]), [['2026-10-09', '7016'], ['2026-10-10', '7016'], ['2026-10-11', '7016']]);
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.routeNumberFallbacks.length, 1);
    const [fallback] = manifest.routeNumberFallbacks;
    assert.equal(fallback.sourceDate, '2026-10-10'); assert.equal(fallback.missingMember, 'VW_KSCC_DO_CARD.csv');
    assert.deepEqual(fallback.neighbors.map((neighbor: { sourceDate: string }) => neighbor.sourceDate), ['2026-10-09', '2026-10-11']);
    assert.equal(fallback.agreedRoutes, 1); assert.equal(fallback.disagreedRoutes, 0);
    assert.deepEqual(manifest.archives.map((archive: { routeNumberSource: string }) => archive.routeNumberSource), ['archive', 'neighbor-service-days', 'archive']);
  } finally { f.cleanup(); }
});

test('borrowed route numbers leave out routes the neighbor days disagree on', () => {
  const f = fixture();
  try {
    const result = f.run([f.make('20261009'), f.make('20261010', '20261010', true, false, false, false, false),
      f.make('20261011', '20261011', true, true)], ['--borrow-route-numbers']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(readFileSync(f.output, 'utf8').trim().split('\n').map(line => JSON.parse(line).sourceDate), ['2026-10-09']);
    const [fallback] = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8')).routeNumberFallbacks;
    assert.equal(fallback.agreedRoutes, 0); assert.equal(fallback.disagreedRoutes, 1);
  } finally { f.cleanup(); }
});

test('a day without its route table is refused when a neighbor day is not in the batch', () => {
  const f = fixture();
  try {
    const result = f.run([f.make('20261010', '20261010', true, false, false, false, false), f.make('20261011')], ['--borrow-route-numbers']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /route_table_neighbors_unavailable/);
  } finally { f.cleanup(); }
});

test('pure prepared-batch merge refuses mixed sessions, changed cache bytes and incomplete batch indexes', () => {
  for (const kind of ['session', 'hash', 'incomplete']) {
    const f = fixture();
    try {
      const result = f.run([f.make('20261009'), f.make('20261010')]); assert.equal(result.status, 0, result.stdout + result.stderr);
      const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
      const cache = manifest.batchCacheFiles[0];
      const index = join(f.directory, dirname(cache.recordsPath), 'batch-index.json');
      if (kind === 'session') {
        const cacheManifest = join(f.directory, cache.manifestPath);
        const content = JSON.parse(readFileSync(cacheManifest, 'utf8')); content.batchSessionId = 'a'.repeat(32); writeFileSync(cacheManifest, JSON.stringify(content));
      } else if (kind === 'hash') {
        const cachePath = join(f.directory, cache.recordsPath); writeFileSync(cachePath, readFileSync(cachePath, 'utf8') + '\n');
      } else {
        const content = JSON.parse(readFileSync(index, 'utf8')); content.allDatesComplete = false; writeFileSync(index, JSON.stringify(content));
      }
      const merged = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('fixture_driver',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
try:module.merge_prepared_batches(json.loads(Path(sys.argv[2]).read_text()),module.preparation.data_path(sys.argv[3]))
except module.preparation.PreparationError as error:print(str(error));raise SystemExit(1)`, script, index, join(f.directory, 'data', 'retry.jsonl')], { cwd: f.directory, encoding: 'utf8' });
      assert.notEqual(merged.status, 0);
      assert.match(merged.stdout + merged.stderr, new RegExp(kind === 'session' ? 'mixed_batch_sessions' : kind === 'hash' ? 'batch_cache_hash_mismatch' : 'incomplete_batch_cache'));
      assert.doesNotMatch(merged.stdout + merged.stderr, /secret-/);
    } finally { f.cleanup(); }
  }
});

test('DDmm public stop coordinates reject malformed minute components', () => {
  const checked = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `import importlib.util,sys
spec=importlib.util.spec_from_file_location('fixture_preparer',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert module.coordinate({'BSST_LAT':'12667.2000','BSST_LON':'3732.4000'}) is None
assert module.coordinate({'BSST_LAT':'12658.2000','BSST_LON':'3732.4000'}) == (37.54,126.97)`, resolve('scripts/prepare-public-bus.py')], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
});
