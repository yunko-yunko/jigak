import './holiday-env';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePublicBusCheckpoint, parsePublicBusModel } from '../../src/common/engine/intelligence/public-bus-model';
import { checkedPrivatePath, planPublicBusRefresh, publicBusArtifactHash, publicBusCandidateDoesNotRegress, registerPublicBusEvaluation,
  replacePublicBusCheckpoint, verifyPublicBusSourceArchives } from '../../src/common/engine/intelligence/public-bus-refresh';
import { verifyPublicBusReproduction } from './verify-public-bus-reproduction';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
/** Dry run verifies an exact candidate and records evaluation exposure, but never replaces the operational model. */
export async function refreshPublicBusModel(args: string[], now = Date.now()) {
  const execute = args.at(-1) === '--execute', values = execute ? args.slice(0, -1) : args;
  if (values.length !== 10 || values[0] !== '--input' || values[2] !== '--road-priors' || values[4] !== '--report'
    || values[6] !== '--active' || values[8] !== '--source-manifests') throw new Error('usage');
  const [inputPath, priorsPath, reportPath, activePath] = [values[1], values[3], values[5], values[7]].map(path => resolve(project, path));
  const boundedRead = async (path: string) => { const actual = await checkedPrivatePath(root, path); if ((await stat(actual)).size > 2 * 1024 ** 2) throw new Error('artifact-size'); return readFile(actual, 'utf8'); };
  const [reportText, activeText] = await Promise.all([boundedRead(reportPath), boundedRead(activePath)]);
  const candidateHash = publicBusArtifactHash(reportText);
  const plan = planPublicBusRefresh(reportText, activeText, now);
  // First inspection of any new test day is permanently tied to this report's bytes.
  if (plan.candidateTestDate && /^\d{4}-\d{2}-\d{2}$/.test(plan.candidateTestDate)) {
    if (!await registerPublicBusEvaluation(process.env.JIGAK_EVALUATION_JOURNAL_DIR || root, plan.candidateTestDate, candidateHash, now)) {
      plan.ready = false; plan.evaluation = 'reused';
      plan.reasons.push('evaluation-day-already-inspected-for-another-candidate');
    }
  }
  if (!plan.ready) return { ...plan, executed: false, status: 'refused', checkedAt: now };
  const reproduction = await verifyPublicBusReproduction(['--input', inputPath, '--road-priors', priorsPath, '--report', reportPath]);
  const model = parsePublicBusModel(JSON.stringify(JSON.parse(reportText).model), now), contents = JSON.stringify(model) + '\n';
  const actualInput = await checkedPrivatePath(root, inputPath);
  if ((await stat(actualInput)).size > 384 * 1024 ** 2) throw new Error('input-size');
  const text = await readFile(actualInput, 'utf8');
  if (publicBusArtifactHash(text) !== reproduction.sourceSha256) throw new Error('input-changed-during-verification');
  const testRows = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).filter(row => model.validation.testDates.includes(row.sourceDate));
  const incumbent = evaluatePublicBusCheckpoint(parsePublicBusModel(activeText, now, { allowExpired: true }), testRows);
  const candidate = evaluatePublicBusCheckpoint(model, testRows);
  if (!publicBusCandidateDoesNotRegress(incumbent, candidate)) {
    return { ...plan, ready: false, status: 'refused', executed: false, reasons: ['incumbent-comparison-regressed-or-unsupported'], comparison: { incumbent, candidate } };
  }
  const sources = await verifyPublicBusSourceArchives(model, values[9].split(',').map(path => resolve(project, path)), root);
  if (publicBusArtifactHash(await boundedRead(reportPath)) !== candidateHash || publicBusArtifactHash(await boundedRead(activePath)) !== plan.activeModelSha256) throw new Error('artifact-changed-during-verification');
  const proof = { ...plan, checkedAt: now, reproduction, sources, comparison: { incumbent, candidate }, status: execute ? 'activated' : 'verified-candidate', executed: execute };
  if (!execute) return proof;
  const replacement = await replacePublicBusCheckpoint({ root, activePath, expectedSha256: plan.activeModelSha256, contents, now });
  return { ...proof, replacement };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void refreshPublicBusModel(process.argv.slice(2))
  .then(result => { console.info(JSON.stringify(result)); if (!result.ready) process.exitCode = 2; })
  .catch(() => { console.error('버스 모델 갱신 검증을 완료하지 못했습니다. 운영 모델은 검증·원본 해시 확인·전진 평가를 통과한 경우에만 교체됩니다. 경로와 실행 기록을 확인해 주세요. 원본 행과 오류 원문은 출력하지 않습니다.'); process.exitCode = 1; });
