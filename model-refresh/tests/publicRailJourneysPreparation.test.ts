import { PYTHON_COMMAND } from '../scripts/python-runtime';
import { assertPrivateFile } from './helpers/private-files';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = resolve('scripts/prepare-public-rail-journeys.py');
const columns = ['TRCR_ID', 'RIDE_DTM', 'SERIAL_NUM', 'TRNC_ID', 'TRNS_MNS_CD', 'TRTR_FCNT', 'ROUTE_ID', 'VHCL_ID', 'TRIP_DEPR_DTM', 'RIDE_BSST_ID', 'ALGH_DTM', 'ALGH_BSST_ID', 'STDR_DE'];
const cards = Array.from({ length: 3000 }, (_, index) => `fixture-private-card-${index}`)
  .filter(card => createHash('sha256').update(`rail-journey-card-selection-v1|${card}`).digest()[0] % 64 === 0);
const rail = { TRCR_ID: cards[0], RIDE_DTM: '20261010083000', SERIAL_NUM: '1', TRNC_ID: 'fixture-private-transfer', TRNS_MNS_CD: '201', TRTR_FCNT: '0', ROUTE_ID: '', RIDE_BSST_ID: '0150', ALGH_DTM: '20261010084000', ALGH_BSST_ID: '0151', STDR_DE: '20261010' };
const bus = { ...rail, RIDE_DTM: '20261010084200', ALGH_DTM: '20261010085200', SERIAL_NUM: '2', TRNS_MNS_CD: '115', TRTR_FCNT: '1', ROUTE_ID: 'public-route', RIDE_BSST_ID: 'public-stop-a', ALGH_BSST_ID: 'public-stop-b' };

function fixture(batches: Record<string, string>[][], options: { withoutStationTable?: number[] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'public-rail-journeys-'));
  mkdirSync(join(directory, 'data', 'public-source'), { recursive: true });
  const inputs = batches.map((rows, index) => {
    const input = join(directory, 'data', 'public-source', `archive-${index}.zip`);
    const stationTable = options.withoutStationTable?.includes(index) ? [] : [['VW_KSCC_DV_CARD.csv', ['OUT_STN_NUM', 'STN_KR_NM', 'USE_YN'], [['0150', '서울역', 'Y'], ['0151', '시청', 'Y']]]];
    const made = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', `import csv,io,json,zipfile,sys
data=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for name,headers,rows in data:
  f=io.StringIO(newline='');w=csv.writer(f);w.writerow(headers);w.writerows(rows);z.writestr(name,f.getvalue().encode('utf-8-sig'))
`, input], { input: JSON.stringify([
      ...stationTable,
      ['VW_KSCC_DH_CARD.csv', ['ROUTE_ID', 'BSST_ID', 'BSST_NM', 'BSST_ORDER', 'BSST_SUM_DISTANCE'], [['public-route', 'public-stop-a', '시청앞', '2', '1000'], ['public-route', 'public-stop-b', '광화문', '5', '4000']]],
      ['VW_KSCC_DO_CARD.csv', ['ROUTE_ID', 'ROUTE_NUM'], [['public-route', '701']]],
      ['VW_KSCC_DX_CARD.csv', columns, rows.map(row => columns.map(key => row[key] ?? ''))],
    ]), encoding: 'utf8' });
    assert.equal(made.status, 0); return input;
  });
  const railOutput = join(directory, 'data', 'rail.jsonl'), journeyOutput = join(directory, 'data', 'chains.jsonl');
  const run = (args = ['--execute']) => spawnSync(PYTHON_COMMAND, ['-X', 'utf8', script, ...inputs.flatMap(input => ['--input', input]), '--rail-output', railOutput, '--journey-output', journeyOutput, '--workers', '1', ...args], { cwd: directory, encoding: 'utf8' });
  const rows = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, inputs, railOutput, journeyOutput, run, rows, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('public rail preparation keeps gate and complete transfer-chain targets separate with private common grouping', () => {
  const f = fixture([[rail, bus]]);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    const gates = f.rows(f.railOutput), chains = f.rows(f.journeyOutput);
    assert.equal(gates.length, 1); assert.equal(chains.length, 1);
    assert.equal(gates[0].target, 'rail-gate-elapsed'); assert.equal(chains[0].target, 'transit-chain-elapsed');
    assert.equal(gates[0].actualSeconds, 600); assert.equal(chains[0].actualSeconds, 1320);
    assert.equal(gates[0].uncertaintySeconds, 60); assert.equal(chains[0].uncertaintySeconds, 60);
    assert.deepEqual(chains[0].modeSequence, ['subway', 'bus']); assert.equal(chains[0].transferCount, 1);
    assert.equal(chains[0].transferGapSeconds, 120); assert.equal(chains[0].originName, '서울역');
    assert.equal(chains[0].destinationName, '광화문'); assert.equal(chains[0].destinationStationId, null);
    assert.equal(gates[0].cardGroup, chains[0].cardGroup); assert.equal(gates[0].journeyGroup, chains[0].groupId);
    for (const path of [f.railOutput, f.journeyOutput, f.railOutput + '.manifest.json']) assertPrivateFile(path);
    assert.doesNotMatch(readFileSync(f.railOutput, 'utf8') + readFileSync(f.journeyOutput, 'utf8') + result.stdout + result.stderr, /fixture-private|TRCR_ID|TRNC_ID|VHCL_ID/);
  } finally { f.cleanup(); }
});

test('public chains refuse missing first transfer, conflicting counters, unsupported modes and overlapping tags', () => {
  const invalid = [
    [{ ...rail, TRTR_FCNT: '1' }, { ...bus, TRTR_FCNT: '2' }],
    [rail, bus, { ...bus, SERIAL_NUM: '3', ALGH_DTM: '20261010085500' }],
    [rail, { ...bus, TRNS_MNS_CD: '999' }],
    [rail, { ...bus, RIDE_DTM: '20261010083900' }],
    [rail, { ...bus, RIDE_DTM: '20261010084217' }],
    [rail, { ...bus, RIDE_BSST_ID: 'unknown-stop' }],
  ];
  for (const rows of invalid) {
    const f = fixture([rows]);
    try { const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(f.rows(f.journeyOutput).length, 0); }
    finally { f.cleanup(); }
  }
});

test('rail bursts collapse duplicate riders independently of elapsed target while retaining zero-minute transfer gaps', () => {
  const f = fixture([[rail, { ...bus, RIDE_DTM: rail.ALGH_DTM }, { ...rail, TRCR_ID: cards[1], SERIAL_NUM: '3', ALGH_DTM: '20261010084500' }, { ...bus, TRCR_ID: cards[1], SERIAL_NUM: '4', RIDE_DTM: '20261010084600' }]]);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.rows(f.railOutput).length, 1); assert.equal(f.rows(f.journeyOutput).length, 2);
    assert.equal(f.rows(f.journeyOutput).some(row => row.transferGapSeconds === 0), true);
    const manifest = JSON.parse(readFileSync(f.railOutput + '.manifest.json', 'utf8'));
    assert.equal(manifest.railBurstDuplicatesCollapsed, 1); assert.equal(manifest.railBurstIsPhysicalVehicle, false);
  } finally { f.cleanup(); }
});

test('burst passenger selection stays fixed when elapsed targets are swapped and CSV order is reversed', () => {
  const outcomes: number[] = [];
  for (const reversed of [false, true]) {
    const first = { ...rail, ALGH_DTM: reversed ? '20261010084500' : '20261010084000' };
    const second = { ...rail, TRCR_ID: cards[1], SERIAL_NUM: '3', ALGH_DTM: reversed ? '20261010084000' : '20261010084500' };
    const f = fixture([reversed ? [second, first] : [first, second]]);
    try {
      const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
      const gates = f.rows(f.railOutput); assert.equal(gates.length, 1); outcomes.push(gates[0].actualSeconds);
    } finally { f.cleanup(); }
  }
  assert.deepEqual([...outcomes].sort((a, b) => a - b), [600, 900], 'neither choosing the fastest target nor choosing CSV first is allowed');
});

test('common card grouping spans dates while chronology and duplicate source-date guards remain strict', () => {
  const nextRail = { ...rail, RIDE_DTM: '20261011083000', ALGH_DTM: '20261011084000', STDR_DE: '20261011' };
  const nextBus = { ...bus, RIDE_DTM: '20261011084200', ALGH_DTM: '20261011085200', STDR_DE: '20261011' };
  const f = fixture([[rail, bus], [nextRail, nextBus]]);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = f.rows(f.journeyOutput); assert.equal(rows.length, 2); assert.equal(rows[0].cardGroup, rows[1].cardGroup);
    assert.notEqual(rows[0].groupId, rows[1].groupId); assert.deepEqual(rows.map(row => row.sourceDate), ['2026-10-10', '2026-10-11']);
  } finally { f.cleanup(); }
  const duplicate = fixture([[rail, bus], [{ ...rail, SERIAL_NUM: '5' }, bus]]);
  try { assert.notEqual(duplicate.run().status, 0); assert.equal(existsSync(duplicate.railOutput), false); }
  finally { duplicate.cleanup(); }
});

test('preparation requires explicit execution and refuses overwriting private artifacts', () => {
  const f = fixture([[rail, bus]]);
  try {
    assert.equal(f.run([]).status, 0); assert.equal(existsSync(f.railOutput), false);
    assert.equal(f.run().status, 0); const before = readFileSync(f.railOutput);
    assert.notEqual(f.run().status, 0); assert.deepEqual(readFileSync(f.railOutput), before);
  } finally { f.cleanup(); }
});

test('chains split across the 04:00 source boundary are refused rather than treating a partial prefix as the full journey', () => {
  const earlyRail = { ...rail, RIDE_DTM: '20261011033000', ALGH_DTM: '20261011034000' };
  const earlyBus = { ...bus, RIDE_DTM: '20261011034200', ALGH_DTM: '20261011035200' };
  const continuation = { ...rail, RIDE_DTM: '20261011040500', ALGH_DTM: '20261011041500', TRTR_FCNT: '2', STDR_DE: '20261011' };
  const f = fixture([[earlyRail, earlyBus], [continuation]]);
  try {
    const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.rows(f.journeyOutput).length, 0);
    const manifest = JSON.parse(readFileSync(f.railOutput + '.manifest.json', 'utf8'));
    assert.equal(manifest.crossDateSplitChainRowsPurged, 1);
    assert.equal(f.rows(f.railOutput).length, 2, 'separate genuine gate elapsed labels remain valid');
  } finally { f.cleanup(); }
});

test('a day published without the station table borrows the nearest one under the nearest-consistent policy, and says so', () => {
  // TAIMS_20261106 (service day 11-02) arrived without VW_KSCC_DV_CARD.csv; the day before carried it.
  const nextRail = { ...rail, RIDE_DTM: '20261011083000', ALGH_DTM: '20261011084000', STDR_DE: '20261011' };
  const nextBus = { ...bus, RIDE_DTM: '20261011084200', ALGH_DTM: '20261011085200', STDR_DE: '20261011' };
  const f = fixture([[rail, bus], [nextRail, nextBus]], { withoutStationTable: [1] });
  try {
    const strict = f.run(); assert.notEqual(strict.status, 0); assert.match(strict.stderr, /required_members_missing_or_duplicate/);
    assert.equal(existsSync(f.railOutput), false, 'without the policy nothing is borrowed or written');
    const result = f.run(['--route-table-policy', 'nearest-consistent', '--execute']); assert.equal(result.status, 0, result.stdout + result.stderr);
    const gates = f.rows(f.railOutput);
    assert.deepEqual(gates.map(row => [row.sourceDate, row.originName, row.destinationName]), [['2026-10-10', '서울역', '시청'], ['2026-10-11', '서울역', '시청']]);
    const manifest = JSON.parse(readFileSync(f.railOutput + '.manifest.json', 'utf8'));
    assert.equal(manifest.stationTableFallbacks.length, 1);
    assert.deepEqual([manifest.stationTableFallbacks[0].sourceDate, manifest.stationTableFallbacks[0].missingMember, manifest.stationTableFallbacks[0].borrowedFrom.sourceDate],
      ['2026-10-11', 'VW_KSCC_DV_CARD.csv', '2026-10-10']);
  } finally { f.cleanup(); }
  const none = fixture([[rail, bus]], { withoutStationTable: [0] });
  try {
    const result = none.run(['--route-table-policy', 'nearest-consistent', '--execute']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /station_table_unavailable/); assert.equal(existsSync(none.railOutput), false);
  } finally { none.cleanup(); }
});
