// Regression cases from mvp/tests/hgbTraining.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseHgbModel, predictHgb } from '../src/common/engine/intelligence/hgb-model.js';
import type { EtaLearningFeatures } from '../src/common/shared/intelligence/learning.js';

const python =
  process.env.PYTHON ||
  resolve('data/hgb-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const run = promisify(execFile);
test(
  'offline HGB trains on synthetic test-only records, verifies portable predictions and preserves checkpoint on refusal',
  { skip: !existsSync(python), timeout: 120000 },
  async () => {
    // Never copy these constructed labels or output to data/contextual-hgb.json.
    const directory = await mkdtemp(resolve('data/.hgb-test-')),
      input = join(directory, 'records.jsonl'),
      output = join(directory, 'test-only.json');
    const now = Date.now();
    const rows = Array.from({ length: 700 }, (_, group) => {
      const startedAt = now - 50 * 86400000 + group * 3600000,
        rain = group % 10;
      const features: EtaLearningFeatures = {
        mode: 'walk',
        predictedSeconds: 300 + (group % 7) * 30,
        distanceMeters: 400 + (group % 7) * 40,
        startedAt,
        precipitationMm: rain,
        temperatureC: 15,
        windMetersPerSecond: 1,
        congestionLevel: 'unknown',
        roadDelaySeconds: 0,
        precedingWaitSeconds: 0,
        transferIndex: 0,
        liveWait: false,
      };
      const actualSeconds = Math.round(
        features.predictedSeconds *
          (rain >= 3 && rain <= 6 ? 1.8 : 1.08) *
          Math.exp(((group % 3) - 1) * 0.015),
      );
      return {
        version: 1,
        id: `test-${group}`,
        tripId: `test-trip-${group}`,
        source: 'recorded-trip',
        features,
        actualSeconds,
        observedAt: startedAt + actualSeconds * 1000,
        evidence: 'user-confirmed',
      };
    });
    try {
      await writeFile(input, rows.map((row) => JSON.stringify(row)).join('\n'), { mode: 0o600 });
      const args = ['--import', 'tsx', 'scripts/train-contextual-hgb.ts', input, output];
      const result = await run(process.execPath, args, {
        env: { ...process.env, PYTHON: python },
        timeout: 100000,
        maxBuffer: 200000,
      });
      assert.match(result.stdout, /"trained":true/);
      const before = await readFile(output, 'utf8'),
        model = parseHgbModel(before);
      assert.equal(Object.keys(model.modes).length, 1);
      assert.ok(model.modes.walk!.evaluation.modelMae < model.modes.walk!.evaluation.ridgeMae);
      assert.ok(predictHgb(model, { ...rows[680].features, startedAt: Date.now() }, Date.now()));
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
      await writeFile(
        input,
        rows
          .slice(0, 10)
          .map((row) => JSON.stringify(row))
          .join('\n'),
      );
      await assert.rejects(
        run(process.execPath, args, { env: { ...process.env, PYTHON: python } }),
      );
      assert.equal(await readFile(output, 'utf8'), before);
      await writeFile(
        input,
        rows.map((row, i) => JSON.stringify(i === 0 ? { ...row, source: 'demo' } : row)).join('\n'),
      );
      await assert.rejects(
        run(process.execPath, args, { env: { ...process.env, PYTHON: python } }),
      );
      assert.equal(await readFile(output, 'utf8'), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
