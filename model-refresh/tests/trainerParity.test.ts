import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PYTHON_COMMAND } from '../scripts/python-runtime';
import { holidayAsSunday } from '../../src/common/engine/intelligence/korean-holidays';
import { spatialBusFeatures, type SpatialBusInput } from '../../src/common/engine/intelligence/spatial-bus-model';
import { parseRailGateCheckpoint, railGateFeatures, RAIL_GATE_FEATURE_NAMES, RAIL_GATE_GROUPS } from '../../src/common/engine/intelligence/rail-gate-model';

// The Python trainers here must build exactly the features the API serves with (src/common/engine). The same checks against
// mvp/server stay in mvp/tests/spatialBusV3.test.ts and mvp/tests/railGate.test.ts.

const kst = (day: string, hour: number, minute = 20) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`);
const HOLIDAYS = ['2026-10-03', '2026-10-05', '2026-10-09'];
const leaf = (value: number) => ({ initial: value, trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]] });
const N = RAIL_GATE_FEATURE_NAMES.length;
function checkpoint(trainedAt: number, encodings = { pairs: [['서울역', '숙대입구(서울시교육청)', Math.log(420), 21]], origins: [['서울역', .12, 900]], destinations: [['숙대입구(서울시교육청)', .2, 300]] }, overrides: Record<string, unknown> = {}) {
  return { version: 'seoul-rail-gate-v1', deployment: 'production', target: 'rail-gate-elapsed', trainedAt, expiresAt: trainedAt + 7 * 86_400_000,
    trainingThrough: '2026-10-06', lastEvaluatedServiceDate: '2026-10-16', featureNames: [...RAIL_GATE_FEATURE_NAMES], featureQuantizationDecimals: 6,
    models: { lower: leaf(240), median: leaf(420), upper: leaf(700) }, secondsPerMeter: .4, priorRows: 5, encodings,
    calendar: { rule: 'korean-public-holiday-as-sunday', firstDate: '2026-09-28', lastDate: '2026-11-06', holidays: HOLIDAYS },
    conformal: RAIL_GATE_GROUPS.map(group => ({ group, logLower: 0, logUpper: group === 'weekday:evening' ? Math.log(1.1) : 0 })),
    labelUncertaintySeconds: 60, domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) }, evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) }, limitations: ['unit'], ...overrides };
}
const SEOUL = { latitude: 37.5547, longitude: 126.9707 }, SOOKDAE = { latitude: 37.5448, longitude: 126.9723 };

const busKst = (day: string, hour: number) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:20:00+09:00`);
const input = (startedAt: number): SpatialBusInput => ({ startedAt, distanceMeters: 1553, stopCount: 3,
  originLatitude: 37.5551, originLongitude: 126.9727, destinationLatitude: 37.5437, destinationLongitude: 126.9719 });

test('spatial bus v3: the trainer reads reviewed holidays as Sunday exactly like the served features', () => {
  const holidays = ['2026-10-03', '2026-10-05', '2026-10-09'];
  const inputs = ['2026-10-05', '2026-10-06', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].flatMap(day => [0, 7, 13, 18, 22].map(hour => input(busKst(day, hour))));
  const code = 'import json,runpy,sys; m=runpy.run_path(sys.argv[1]); h=set(sys.argv[2].split(",")); print(json.dumps([m["features"](x,h) for x in json.load(sys.stdin)],allow_nan=False))';
  const result = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', code, resolve('scripts/train-spatial-bus-v3.py'), holidays.join(',')], { encoding: 'utf8', input: JSON.stringify(inputs), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const weekdayOf = holidayAsSunday({ firstDate: '2026-09-28', lastDate: '2026-11-06', holidays });
  assert.deepEqual(JSON.parse(JSON.stringify(inputs.map(value => spatialBusFeatures(value, weekdayOf)))), JSON.parse(result.stdout));
  // 10/05 (substitute holiday, Monday) is a weekend row; 10/06 is an ordinary Tuesday.
  assert.equal(spatialBusFeatures(input(busKst('2026-10-05', 8)), weekdayOf)!.at(-1), 1);
  assert.equal(spatialBusFeatures(input(busKst('2026-10-06', 8)), weekdayOf)!.at(-1), 0);
});

test('rail gate: served features equal the trainer, including holidays read as Sunday and shrunken encodings', () => {
  const values = { pair: [6.0, 6.1, 5.9, 6.3], origin: [.1, .3, .05], destination: [.2, -.1] };
  const inputs = ['2026-10-05', '2026-10-06', '2026-10-09', '2026-10-30'].flatMap(day => [5, 8, 13, 18, 23].map(hour => kst(day, hour, 37)));
  const code = `import json,runpy,sys
m=runpy.run_path(sys.argv[1]); h=set(sys.argv[2].split(',')); v=json.loads(sys.argv[3]); E=m['Encoder']; out=[]
for t in json.load(sys.stdin):
    b=m['base_features']((37.5547,126.9707),(37.5448,126.9723),t,h)
    s=__import__('math').log(max(50.0,__import__('math').expm1(b[0]))*0.4)
    out.append(m['quantize'](b+[*E.summary(v['pair'],s),*E.summary(v['origin'],0.0),*E.summary(v['destination'],0.0)]))
print(json.dumps({'features':out,'medians':{k:m['statistics_median'](x) for k,x in v.items()}}))`;
  const result = spawnSync(PYTHON_COMMAND, ['-X', 'utf8', '-c', code, resolve('scripts/train-rail-gate.py'), HOLIDAYS.join(','), JSON.stringify(values)], { encoding: 'utf8', input: JSON.stringify(inputs), timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(result.stdout) as { features: number[][]; medians: Record<string, number> };
  const model = parseRailGateCheckpoint(JSON.stringify(checkpoint(kst('2026-10-29', 18), { pairs: [['서울역', '숙대입구(서울시교육청)', expected.medians.pair, 4]],
    origins: [['서울역', expected.medians.origin, 3]], destinations: [['숙대입구(서울시교육청)', expected.medians.destination, 2]] })));
  const actual = inputs.map(startedAt => railGateFeatures(model, { originName: '서울역', destinationName: '숙대입구(서울시교육청)', origin: SEOUL, destination: SOOKDAE, startedAt }));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected.features);
  assert.equal(actual[0]![11], 1, '10/05 substitute holiday is a weekend row');
  assert.equal(actual[5]![11], 0, '10/06 is an ordinary Tuesday');
});
