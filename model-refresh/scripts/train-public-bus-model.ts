import './holiday-env';
import { openPrivateFile } from '../../src/common/engine/private-files';
import { link, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trainPublicBusModel } from '../../src/common/engine/intelligence/public-bus-model';
import { publicBusTrainingWindow } from '../../src/common/engine/intelligence/public-bus-window';
import { holidayReviewProblems, reviewedKoreanHolidays, seoulDate } from '../../src/common/engine/intelligence/korean-holidays';
import { publicBusArtifactHash, registerPublicBusEvaluation } from '../../src/common/engine/intelligence/public-bus-refresh';
import { roadPriorBundleSchema } from '../../src/common/engine/intelligence/historical-context';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
const within = (base: string, target: string) => { const child = relative(base, target); return !!child && !child.startsWith('..') && !isAbsolute(child); };
async function privateInput(path: string, maximum: number, actualRoot: string): Promise<string> {
  const actual = await realpath(path); if (!within(actualRoot, actual)) throw new Error('path');
  const info = await stat(actual); if (!info.isFile() || info.size > maximum) throw new Error('size');
  const value = await readFile(actual, 'utf8'); if (Buffer.byteLength(value) > maximum) throw new Error('size'); return value;
}
/** Explicit offline fit. Writes a reviewable report, never replaces an existing production artifact. */
export async function runPublicBusModelCli(args: string[], options: { now?: number; dataRoot?: string } = {}): Promise<void> {
  if (![6, 8].includes(args.length) || args.length === 8 && args[6] !== '--service-window-start' || args[0] !== '--input' || args[2] !== '--road-priors' || args[4] !== '--output') throw new Error('usage');
  const [input, priors, output] = [args[1], args[3], args[5]].map(value => resolve(project, value));
  const storageRoot = resolve(options.dataRoot ?? root);
  if (![input, priors, output].every(value => within(storageRoot, value)) || !input.endsWith('.jsonl') || !output.endsWith('.json')) throw new Error('path');
  const actualRoot = await realpath(storageRoot), actualParent = await realpath(dirname(output));
  if (actualParent !== actualRoot && !within(actualRoot, actualParent)) throw new Error('path');
  const [text, priorText] = await Promise.all([privateInput(input, 384 * 1024 * 1024, actualRoot), privateInput(priors, 2 * 1024 * 1024, actualRoot)]);
  const lines = text.split(/\r?\n/).filter(line => line.trim()); if (!lines.length || lines.length > 140_000) throw new Error('rows');
  const bundle = roadPriorBundleSchema.parse(JSON.parse(priorText)), now = options.now ?? Date.now(), holidays = reviewedKoreanHolidays();
  // Before any metric exists: training rows and the next 7 days need a calendar reviewed for temporary holidays.
  const window = (() => { try { return publicBusTrainingWindow(args[7]); } catch { return null; } })();
  if (window && holidayReviewProblems(holidays, window.dates[0], seoulDate(now + 7 * 86_400_000 + 4 * 3_600_000), now).length) throw new Error('holiday-calendar-review');
  const report = trainPublicBusModel(lines.map(line => JSON.parse(line)), { now, roadPriorArchives: bundle.archives, serviceWindowStart: args[7], holidays });
  const contents = JSON.stringify(report, null, 2) + '\n';
  // Claim the evaluation before exposing any report or metric. A second fit may not
  // quietly tune on the same test day and register only its better result at refresh.
  if (report.split.test.dates.length === 1 && !await registerPublicBusEvaluation(process.env.JIGAK_EVALUATION_JOURNAL_DIR || actualRoot, report.split.test.dates[0], publicBusArtifactHash(contents), report.trainedAt)) {
    throw new Error('evaluation-day-already-inspected-for-another-candidate');
  }
  const destination = resolve(actualParent, basename(output)), temporary = resolve(actualParent, `.public-bus-model-${randomUUID()}.tmp`), file = await openPrivateFile(temporary);
  try {
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await link(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  console.info(JSON.stringify({ version: report.version, status: report.status, qualityPassed: report.qualityPassed, counts: report.counts, contextCounts: report.contextCounts, evaluations: report.evaluations, reasons: report.reasons, holidays: report.model?.calendar?.holidays ?? null, output: relative(project, destination) }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void runPublicBusModelCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error && error.message === 'evaluation-day-already-inspected-for-another-candidate'
    ? '이미 평가한 날짜의 다른 학습 보고서는 저장하거나 갱신에 사용할 수 없습니다. 기존 보고서는 재현 검증 명령으로 확인하고, 새 후보에는 아직 평가하지 않은 이후 운행일을 사용해 주세요.'
    : error instanceof Error && error.message === 'holiday-calendar-review'
    ? '공휴일 달력(src/common/engine/realtime/data/korea-holidays-연도.json 또는 JIGAK_HOLIDAY_DIR)이 학습 기간과 앞으로 7일의 연도를 검토 기한 안에 담고 있지 않아 학습하지 않았습니다. 우주항공청 월력요항과 임시공휴일·선거일 지정을 다시 확인해 holidays와 verifiedAt·reviewAfter를 고친 뒤 실행해 주세요. 평가일은 기록되지 않았습니다.'
    : '공개 버스 모델 학습을 완료하지 못했습니다. data/ 안의 --input <자료.jsonl> --road-priors <사전자료.json> --output <새파일.json> 경로와 --service-window-start를 확인해 주세요. 입력 행과 오류 원문은 출력하지 않습니다.');
  process.exitCode = 1;
});
