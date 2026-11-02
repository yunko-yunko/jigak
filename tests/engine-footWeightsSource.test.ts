// Which foot-traffic weights the simulator reads (§22.2): the shipped OSM file, or another file of
// the same schema named by MOBILITY_FOOT_WEIGHTS_PATH (the NGII-based one, kept out of git).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EnvironmentConfigurationError,
  validateEnvironment,
} from '../src/common/config/environment.js';
import { dataFile } from '../src/common/engine/simulation/calendar.js';
import {
  bundledFootWeights,
  FOOT_WEIGHTS_ENV,
  FOOT_WEIGHTS_FILE,
  footWeightsIdentity,
  footWeightsPath,
  readFootWeights,
} from '../src/common/engine/simulation/foot-traffic.js';

const shipped = dataFile(FOOT_WEIGHTS_FILE);
const baseEnv = { DB_PASSWORD: 'test-password' };

test('without the variable the shipped OSM weights are read and named by their bytes', () => {
  assert.deepEqual(footWeightsPath({}), { path: shipped, chosen: false });
  assert.deepEqual(footWeightsPath({ [FOOT_WEIGHTS_ENV]: '  ' }), { path: shipped, chosen: false });
  const bytes = readFileSync(shipped);
  assert.equal(
    footWeightsIdentity(),
    createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  );
  assert.ok(bundledFootWeights());
});

test('the shipped weights are built from open data only', () => {
  const meta = JSON.parse(readFileSync(shipped, 'utf8')).meta;
  assert.equal(meta.version, 'foot-weights-v1');
  assert.equal(meta.dataset, 'foot-weights-osm-v1');
  assert.doesNotMatch(JSON.stringify(meta.sources), /NGII|국토지리정보원|수치지형도/);
});

test('a named weights file must be an absolute path to a readable file of the same schema', () => {
  assert.throws(() => footWeightsPath({ [FOOT_WEIGHTS_ENV]: 'data/foot.json' }), TypeError);
  const directory = mkdtempSync(join(tmpdir(), 'jigak-foot-'));
  try {
    const copy = join(directory, 'foot.json');
    writeFileSync(copy, readFileSync(shipped));
    assert.deepEqual(footWeightsPath({ [FOOT_WEIGHTS_ENV]: copy }), { path: copy, chosen: true });
    assert.equal(readFootWeights(copy).identity, footWeightsIdentity());
    assert.equal(
      validateEnvironment({ ...baseEnv, [FOOT_WEIGHTS_ENV]: copy }).MOBILITY_FOOT_WEIGHTS_PATH,
      copy,
    );

    const broken = join(directory, 'broken.json');
    writeFileSync(broken, JSON.stringify({ meta: { version: 'other' }, cells: [] }));
    assert.throws(() => readFootWeights(broken), TypeError);
    for (const value of [broken, join(directory, 'missing.json'), 'relative/foot.json'])
      assert.throws(
        () => validateEnvironment({ ...baseEnv, [FOOT_WEIGHTS_ENV]: value }),
        (error: unknown) =>
          error instanceof EnvironmentConfigurationError && error.fields.includes(FOOT_WEIGHTS_ENV),
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
