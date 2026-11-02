import { PYTHON_COMMAND } from '../scripts/python-runtime';
import { assertPrivateFile } from './helpers/private-files';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = resolve('scripts/prepare-public-bus.py');
const sourceDate = '20261010';
const columns = ['TRCR_ID', 'RIDE_DTM', 'SERIAL_NUM', 'TRNC_ID', 'TRNS_MNS_CD', 'TRTR_FCNT', 'ROUTE_ID', 'TRCM_ID', 'VHCL_ID', 'USER_DVS_CD', 'TRIP_DEPR_DTM', 'RIDE_BSST_ID', 'ALGH_DTM', 'ALGH_BSST_ID', 'PSNG_NUM', 'RIDE_AMT', 'ALGH_AMT', 'TRIP_DEPR_DTM_H', 'RIDE_DTM_H', 'ALGH_DTM_H', 'TRCR_DVS_CD', 'STDR_DE'];
const stopColumns = ['ROUTE_ID', 'BSST_ID', 'BSST_NM', 'BSST_ORDER', 'BSST_SUM_DISTANCE'];
const baseRow: Record<string, string> = {
  TRCR_ID: 'fixture-private-card-a', RIDE_DTM: '20261010083000', SERIAL_NUM: '1', TRNC_ID: 'fixture-transfer',
  TRNS_MNS_CD: '115', ROUTE_ID: 'fixture-public-route', VHCL_ID: 'fixture-private-vehicle-a', TRIP_DEPR_DTM: '20261010080017',
  RIDE_BSST_ID: 'fixture-public-stop-a', ALGH_DTM: '20261010084000', ALGH_BSST_ID: 'fixture-public-stop-b', STDR_DE: sourceDate,
};
const baseStops = [
  ['fixture-public-route', 'fixture-public-stop-a', '가상 출발 정류장', '2', '1000'],
  ['fixture-public-route', 'fixture-public-stop-b', '가상 도착 정류장', '5', '4000'],
];

function fixture(rows: Record<string, string>[], stops = baseStops) {
  const directory = mkdtempSync(join(tmpdir(), 'public-bus-preparation-'));
  mkdirSync(join(directory, 'data', 'public-source'), { recursive: true });
  const input = join(directory, 'data', 'public-source', 'TAIMS_20261014.zip');
  const output = join(directory, 'data', 'prepared.jsonl');
  const made = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `import csv,io,json,zipfile,sys
data=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,headers,rows in data:
  f=io.StringIO(newline='');w=csv.writer(f);w.writerow(headers);w.writerows(rows);z.writestr(name,f.getvalue().encode('utf-8-sig'))
`, input], { input: JSON.stringify([
    ['VW_KSCC_DH_CARD.csv', stopColumns, stops],
    ['VW_KSCC_DX_CARD.csv', columns, rows.map(row => columns.map(key => row[key] ?? ''))],
  ]), encoding: 'utf8' });
  assert.equal(made.status, 0, 'test fixture ZIP creation');
  const run = (args: string[] = ['--execute'], target = output) => spawnSync(PYTHON_COMMAND, ['-X', 'utf8', script, '--input', input, '--output', target, ...args], { cwd: directory, encoding: 'utf8' });
  return { directory, input, output, run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('public bus preparation writes one anonymous physical-run record and honest minute label metadata', () => {
  const f = fixture([{ ...baseRow }, { ...baseRow, TRCR_ID: 'fixture-private-card-b', SERIAL_NUM: '2' },
    { ...baseRow, VHCL_ID: 'fixture-private-vehicle-b', RIDE_DTM: '20261011013000', ALGH_DTM: '20261011014000', TRIP_DEPR_DTM: '20261011010000' }]);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    const text = readFileSync(f.output, 'utf8'); const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map(row => row.groupId)).size, 2);
    for (const row of rows) {
      assert.equal(row.version, 1); assert.equal(row.target, 'bus-tag-elapsed'); assert.equal(row.source, 'seoul-tdata-card');
      assert.equal(row.sourceDate, '2026-10-10'); assert.equal(row.uncertaintySeconds, 60); assert.equal(row.actualSeconds, 600);
      assert.equal(row.distanceMeters, 3000); assert.equal(row.transportCode, '115');
      assert.equal(row.observedAt - row.startedAt, row.actualSeconds * 1000);
      for (const key of ['id', 'groupId', 'odGroup']) assert.match(row[key], /^[A-Za-z0-9_-]{1,128}$/);
    }
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.outputRows, 2); assert.equal(manifest.timestampPrecision, 'minute');
    assert.deepEqual(manifest.sourceDates, ['2026-10-10']); assert.equal(manifest.fileDateMatchesSourceDates, false);
    assert.equal(manifest.sourceSha256, createHash('sha256').update(readFileSync(f.input)).digest('hex'));
    assertPrivateFile(f.output); assertPrivateFile(f.output + '.manifest.json');
    assert.doesNotMatch(text + JSON.stringify(manifest) + result.stdout + result.stderr, /fixture-private|fixture-transfer|fixture-public-route|fixture-public-stop|TRCR_ID|VHCL_ID/);
  } finally { f.cleanup(); }
});

test('public bus preparation rejects ambiguous stop occurrences, backwards legs, invalid tags and unlisted modes', () => {
  const stops = [...baseStops, ['fixture-public-route', 'ambiguous', '가상 중복 정류장', '1', '0'], ['fixture-public-route', 'ambiguous', '가상 중복 정류장', '8', '8000'], [...baseStops[0]]];
  const f = fixture([
    { ...baseRow }, { ...baseRow, SERIAL_NUM: '2', RIDE_BSST_ID: 'ambiguous' },
    { ...baseRow, SERIAL_NUM: '3', RIDE_BSST_ID: 'fixture-public-stop-b', ALGH_BSST_ID: 'fixture-public-stop-a' },
    { ...baseRow, SERIAL_NUM: '4', TRNS_MNS_CD: '201' }, { ...baseRow, SERIAL_NUM: '5', TRNS_MNS_CD: '190' },
    { ...baseRow, SERIAL_NUM: '6', ALGH_DTM: '20261010083100' }, { ...baseRow, SERIAL_NUM: '7', ALGH_DTM: '' },
    { ...baseRow, SERIAL_NUM: '8', RIDE_DTM: '20261010083017' }, { ...baseRow, SERIAL_NUM: '9', TRIP_DEPR_DTM: '20261010090000' },
  ], stops);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = readFileSync(f.output, 'utf8').trim().split('\n').map(line => JSON.parse(line)); assert.equal(rows.length, 1);
    const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
    assert.equal(manifest.excluded.ambiguousStop, 1); assert.equal(manifest.excluded.invalidStopOrder, 1);
    assert.equal(manifest.excluded.unsupportedTransport, 2); assert.equal(manifest.excluded.durationOutsideBounds, 1);
    assert.equal(manifest.excluded.invalidTimestamp, 1); assert.equal(manifest.excluded.nonMinuteTimestamp, 1);
    assert.equal(manifest.excluded.departureAfterBoarding, 1); assert.equal(manifest.exactDuplicateMetadataRows, 1);
  } finally { f.cleanup(); }
});

test('public bus preparation chooses a fixed passenger hash independently of elapsed time and CSV order', () => {
  const first = { ...baseRow, TRCR_ID: 'fixture-private-card-one', SERIAL_NUM: '1', ALGH_DTM: '20261010083500' };
  const second = { ...baseRow, TRCR_ID: 'fixture-private-card-two', SERIAL_NUM: '2', ALGH_DTM: '20261010085000' };
  const priority = (r: Record<string, string>) => createHash('sha256').update('selection-v1|' + r.TRCR_ID + '|' + r.SERIAL_NUM).digest('hex');
  const selectedSeconds = priority(first) < priority(second) ? 300 : 1200;
  for (const rows of [[first, second], [second, first]]) {
    const f = fixture(rows);
    try { const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(readFileSync(f.output, 'utf8').trim()).actualSeconds, selectedSeconds); }
    finally { f.cleanup(); }
  }
});

test('public bus preparation clears an earlier passenger conflict when a lower fixed hash wins', () => {
  const candidates = [
    { ...baseRow, TRCR_ID: 'fixture-private-card-one', SERIAL_NUM: '1' },
    { ...baseRow, TRCR_ID: 'fixture-private-card-two', SERIAL_NUM: '2' },
  ];
  const priority = (r: Record<string, string>) => createHash('sha256').update('selection-v1|' + r.TRCR_ID + '|' + r.SERIAL_NUM).digest('hex');
  candidates.sort((a, b) => priority(a).localeCompare(priority(b)));
  const lower = candidates[0], higher = candidates[1];
  const higherConflict = { ...higher, ALGH_DTM: '20261010085000' };
  const normalized: unknown[] = [];
  for (const rows of [[higher, higherConflict, lower], [lower, higher, higherConflict]]) {
    const f = fixture(rows);
    try {
      const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
      const prepared = readFileSync(f.output, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(prepared.length, 1);
      assert.equal(new Set(prepared.map(row => row.groupId)).size, 1);
      const { id: _id, groupId: _groupId, ...features } = prepared[0]; normalized.push(features);
      const manifest = JSON.parse(readFileSync(f.output + '.manifest.json', 'utf8'));
      assert.equal(manifest.conflictingSelectionGroups, 0); assert.equal(manifest.outputRows, 1);
    } finally { f.cleanup(); }
  }
  assert.deepEqual(normalized[0], normalized[1]);
});

test('public bus preparation requires execute, refuses non-data output and refuses overwriting artifacts', () => {
  const f = fixture([{ ...baseRow }]);
  try {
    const dryRun = f.run([]); assert.equal(dryRun.status, 0, dryRun.stdout + dryRun.stderr); assert.equal(existsSync(f.output), false);
    const outside = f.run(['--execute'], join(f.directory, 'outside.jsonl')); assert.notEqual(outside.status, 0); assert.equal(existsSync(join(f.directory, 'outside.jsonl')), false);
    const first = f.run(); assert.equal(first.status, 0, first.stdout + first.stderr); const original = readFileSync(f.output);
    const again = f.run(); assert.notEqual(again.status, 0); assert.deepEqual(readFileSync(f.output), original);
  } finally { f.cleanup(); }
});
