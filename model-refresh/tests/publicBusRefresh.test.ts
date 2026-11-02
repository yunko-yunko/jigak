import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { publicBusTrainingObservations } from './fixtures/publicBusTraining';
import { parsePublicBusModel, trainPublicBusModel } from '../../src/common/engine/intelligence/public-bus-model';
import { checkedPrivatePath, planPublicBusRefresh, publicBusArtifactHash, publicBusCandidateDoesNotRegress, replacePublicBusCheckpoint, rollbackPublicBusCheckpoint,
  registerPublicBusEvaluation, verifyPublicBusSourceArchives } from '../../src/common/engine/intelligence/public-bus-refresh';
import { PublicBusModelService } from '../../src/common/engine/intelligence/public-bus-service';
import type { BaseSegment } from '../../src/common/shared/domain/types';
import { runPublicBusModelCli } from '../scripts/train-public-bus-model';

const NOW = Date.parse('2026-10-16T10:00:00Z'), DAY = 86_400_000;
const initial = trainPublicBusModel(publicBusTrainingObservations(), { now: NOW - DAY });
const forward = trainPublicBusModel(publicBusTrainingObservations('2026-09-30'), { now: NOW, serviceWindowStart: '2026-09-30' });
const contents = (value: typeof initial) => JSON.stringify(value.model) + '\n';

test('forward whole-day training preserves the 11/2/1 split and cannot renew expiry with reused evaluation', () => {
  assert.equal(forward.qualityPassed, true, JSON.stringify(forward.reasons));
  assert.deepEqual(forward.model!.validation.testDates, ['2026-10-13']);
  assert.ok(forward.split.train.latestObservedAt! < forward.split.calibration.earliestStartedAt!);
  assert.ok(forward.split.calibration.latestObservedAt! < forward.split.test.earliestStartedAt!);
  assert.ok(parsePublicBusModel(contents(forward), NOW));
  assert.equal(planPublicBusRefresh(JSON.stringify(forward), contents(initial), NOW).ready, true);
  const renewed = structuredClone(initial); renewed.trainedAt = NOW; renewed.model!.trainedAt = NOW; renewed.model!.expiresAt += DAY;
  const refused = planPublicBusRefresh(JSON.stringify(renewed), contents(initial), NOW);
  assert.equal(refused.ready, false); assert.equal(refused.evaluation, 'reused');
  assert.equal(planPublicBusRefresh(JSON.stringify(forward), contents(initial), NOW, ['2026-10-13']).ready, false);
  const malformed = structuredClone(forward.model!); malformed.validation.calibrationDates[0] = malformed.validation.testDates[0];
  assert.throws(() => parsePublicBusModel(JSON.stringify(malformed), NOW));
  const future = trainPublicBusModel([], { now: NOW, serviceWindowStart: '2026-10-04' });
  assert.deepEqual(future.reasons, ['incomplete-service-window']);
  const evaluation = initial.model!.evaluation;
  assert.equal(publicBusCandidateDoesNotRegress(evaluation, { ...evaluation, modelMaeSeconds: evaluation.modelMaeSeconds! + 1 }), false);
  assert.equal(publicBusCandidateDoesNotRegress(evaluation, { ...evaluation, modelMaeSeconds: 0, robustUpperCoverage: evaluation.robustUpperCoverage - 0.01 }), false);
  assert.equal(publicBusCandidateDoesNotRegress(evaluation, { ...evaluation, unsupported: 1 }), false);
  assert.equal(publicBusCandidateDoesNotRegress(evaluation, evaluation), true);
});

test('checkpoint replacement preserves exact rollback bytes and rejects stale writers, corrupt backups and expired rollback', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'bus-refresh-')), activePath = resolve(root, 'active.json');
  const oldText = contents(initial), newText = contents(forward);
  try {
    await writeFile(activePath, oldText);
    const receipt = await replacePublicBusCheckpoint({ root, activePath, expectedSha256: publicBusArtifactHash(oldText), contents: newText, now: NOW });
    assert.equal(await readFile(activePath, 'utf8'), newText);
    await assert.rejects(replacePublicBusCheckpoint({ root, activePath, expectedSha256: publicBusArtifactHash(oldText), contents: oldText, now: NOW }), /active-model-changed/);
    const receiptPath = resolve(root, receipt.receiptPath), backupPath = resolve(root, receipt.backup);
    await writeFile(backupPath, 'corrupted');
    await assert.rejects(rollbackPublicBusCheckpoint({ root, activePath, receiptPath, now: NOW }), /rollback-backup-hash-mismatch/);
    assert.equal(await readFile(activePath, 'utf8'), newText);
    await writeFile(backupPath, oldText);
    await assert.rejects(rollbackPublicBusCheckpoint({ root, activePath, receiptPath, now: initial.model!.expiresAt }), /invalid-public-bus-model/);
    assert.equal(await readFile(activePath, 'utf8'), newText);
    await rollbackPublicBusCheckpoint({ root, activePath, receiptPath, now: NOW });
    assert.equal(await readFile(activePath, 'utf8'), oldText);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('private path check accepts a symlinked root and still refuses writes that escape through a symlink', async () => {
  const base = await realpath(await mkdtemp(resolve(tmpdir(), 'bus-root-link-'))), real = resolve(base, 'real'), outside = resolve(base, 'outside'), link = resolve(base, 'link');
  try {
    await mkdir(real); await mkdir(outside);
    await writeFile(resolve(real, 'a.json'), '{}'); await writeFile(resolve(outside, 'secret.json'), '{}');
    // Windows needs a privilege for symlinks; a junction is the unprivileged directory link realpath follows.
    const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(real, link, dirLink);
    await symlink(outside, resolve(real, 'escape'), dirLink);
    const fileLinked = await symlink(resolve(outside, 'secret.json'), resolve(real, 'leak.json')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (process.platform === 'win32' && error.code === 'EPERM') return false;
      throw error;
    });
    const realFile = resolve(real, 'a.json');
    assert.equal(await checkedPrivatePath(link, resolve(link, 'a.json')), realFile);
    assert.equal(await checkedPrivatePath(link, realFile), realFile);
    assert.equal(await checkedPrivatePath(link, resolve(link, 'new.json'), false), resolve(real, 'new.json'));
    await assert.rejects(checkedPrivatePath(link, resolve(outside, 'secret.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, 'escape', 'secret.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, 'escape', 'new.json'), false), /outside-private-data/);
    if (fileLinked) await assert.rejects(checkedPrivatePath(link, resolve(link, 'leak.json')), /outside-private-data/);
    await assert.rejects(checkedPrivatePath(link, resolve(link, '..', 'outside', 'secret.json')), /outside-private-data/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('evaluation journal permits exact reproduction but prevents competing reports from reusing a viewed test day', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'bus-evaluation-'));
  try {
    const first = publicBusArtifactHash('frozen report'), changed = publicBusArtifactHash('tuned report');
    assert.equal(await registerPublicBusEvaluation(root, '2026-10-13', first, NOW), true);
    assert.equal(await registerPublicBusEvaluation(root, '2026-10-13', first, NOW + 1), true);
    assert.equal(await registerPublicBusEvaluation(root, '2026-10-13', changed, NOW + 2), false);
    assert.equal(await registerPublicBusEvaluation(root, '2026-10-14', changed, NOW + 2), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('training CLI binds the first evaluation before exposing metrics and refuses a second report on that day', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'bus-training-ledger-'));
  const input = resolve(root, 'input.jsonl'), priors = resolve(root, 'priors.json'), output = resolve(root, 'report.json'), second = resolve(root, 'second.json');
  const printed: unknown[] = []; context.mock.method(console, 'info', (value: unknown) => printed.push(value));
  try {
    await writeFile(input, publicBusTrainingObservations('2026-09-30').map(row => JSON.stringify(row)).join('\n') + '\n');
    // A later-publication prior cannot enter any of these past observations.
    await writeFile(priors, JSON.stringify({ version: 'topis-road-priors-v1', archives: [{ version: 1, source: 'topis-monthly',
      referenceMonth: '2026-10', publishedAt: Date.parse('2026-11-01T00:00:00Z'), spatialScope: 'seoul-citywide',
      aggregation: 'distance-weighted-harmonic', sourceArchiveSha256: 'a'.repeat(64),
      cells: [{ weekType: 'weekday', hour: 10, speedKmh: 20, sampleCount: 1, missingCount: 0 }] }] }));
    const args = ['--input', input, '--road-priors', priors, '--output', output, '--service-window-start', '2026-09-30'];
    await runPublicBusModelCli(args, { now: NOW, dataRoot: root });
    const report = await readFile(output, 'utf8'), receipt = JSON.parse(await readFile(resolve(root, 'public-bus-refresh-evaluations/2026-10-13.json'), 'utf8'));
    assert.equal(receipt.reportSha256, publicBusArtifactHash(report)); assert.equal(JSON.parse(report).qualityPassed, true);
    assert.equal(printed.length, 1);
    await assert.rejects(runPublicBusModelCli([...args.slice(0, 5), second, ...args.slice(6)], { now: NOW + 1000, dataRoot: root }), /evaluation-day-already-inspected/);
    assert.equal(printed.length, 1, 'a second evaluation must not be exposed for cherry-picking');
    await assert.rejects(readFile(second), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('acquisition manifest hashes are checked against every actual source archive, including equal-size corruption', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'bus-source-')), model = structuredClone(forward.model!);
  try {
    const archives = [];
    for (const [index, archive] of model.validation.sourceArchives.entries()) {
      const path = resolve(root, `${index}.zip`), text = `fixture archive ${index}`;
      await writeFile(path, text); archive.sha256 = publicBusArtifactHash(text);
      archives.push({ path, sha256: archive.sha256, bytes: Buffer.byteLength(text), url: `https://t-data.seoul.go.kr/dataprovide/download.do?id=${index}` });
    }
    const manifestPath = resolve(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({ version: 'tdata-public-bus-acquisition-v1', archives, archiveCount: archives.length,
      sourcePage: 'https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006' }));
    const proof = await verifyPublicBusSourceArchives(model, [manifestPath], root);
    assert.equal(proof.checkedArchives, 14);
    await writeFile(archives[3].path, 'corrupt archive 3');
    await assert.rejects(verifyPublicBusSourceArchives(model, [manifestPath], root), /source-hash-mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime expiry switches to provider fallback while preserving maintenance deadlines and usage denominators', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'bus-expiry-')), modelPath = resolve(root, 'model.json');
  let clock = NOW - DAY;
  try {
    await writeFile(modelPath, contents(initial));
    const service = new PublicBusModelService({ modelPath, now: () => clock });
    const row = publicBusTrainingObservations().at(-1)!;
    const place = { id: 's', name: '', address: '', latitude: 37.5, longitude: 127 };
    const bus: BaseSegment = { id: 'b', mode: 'bus', title: '', instructions: '', start: place, end: place,
      distanceMeters: row.distanceMeters, durationSeconds: { min: 300, max: 300 }, runAllowed: false };
    assert.ok(service.predictSegment(bus, row.startedAt, clock, null));
    clock = initial.model!.expiresAt;
    assert.equal(service.predictSegment(bus, clock, clock, null), null);
    const status = service.status();
    assert.equal(status.active, false); assert.equal(status.expiresAt, initial.model!.expiresAt);
    assert.equal(status.operations.refreshDue, true); assert.equal(status.operations.remainingSeconds, 0);
    assert.deepEqual(status.operations.counters, { attempts: 2, applied: 1, inactive: 1, outsideScope: 0, unsupportedContext: 0 });
    assert.deepEqual(status.reasons, ['expired-checkpoint']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
