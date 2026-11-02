import './holiday-env';
import { createHash } from 'node:crypto';
import { copyFile, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holidayAsSunday, holidayCalendarSlice, holidayReviewProblems, reviewedKoreanHolidays, seoulDate } from '../../src/common/engine/intelligence/korean-holidays';
import { parseSpatialBicycleCheckpoint, predictSpatialBicycleRide, spatialBicycleRideFeatures, SPATIAL_BICYCLE_GROUPS, SPATIAL_BICYCLE_V2, type SpatialBicycleRideInput } from '../../src/common/engine/intelligence/spatial-bicycle-ride';
import { writePrivateFile } from '../../src/common/engine/private-files';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
const within = (base: string, target: string) => { const child = relative(base, target); return !!child && !child.startsWith('..') && !isAbsolute(child); };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Turns a passed spatial bicycle v2 experiment into the served checkpoint. Trees and calibration are
 * copied as evaluated. The day-type rule needs a reviewed holiday calendar, so the checkpoint serves
 * until the 2026 calendar's review deadline; re-review the calendar and promote again after it.
 */
export async function promoteSpatialBicycle(args: string[], options: { now?: number } = {}) {
  if (args.length !== 4 || args[0] !== '--experiment' || args[2] !== '--output') throw new Error('usage');
  const now = options.now ?? Date.now(), directory = await realpath(resolve(project, args[1])), output = resolve(project, args[3]);
  const actualRoot = await realpath(root), parent = await realpath(dirname(output));
  if (!within(actualRoot, directory) || parent !== actualRoot && !within(actualRoot, parent) || !output.endsWith('.json')) throw new Error('path');
  const read = (name: string) => readFile(resolve(directory, name), 'utf8');
  const [protocolText, modelText, reportText, parityText] = await Promise.all(['protocol.json', 'model.json', 'report.json', 'parity.json'].map(read));
  const protocol = JSON.parse(protocolText), candidate = JSON.parse(modelText), report = JSON.parse(reportText), parity = JSON.parse(parityText);
  if (candidate.version !== SPATIAL_BICYCLE_V2 || report.version !== SPATIAL_BICYCLE_V2 || protocol.phase !== 'final') throw new Error('not-a-final-v2-experiment');
  if (report.qualityPassed !== true || report.qualityFailedGroups?.length) throw new Error('quality-gate-not-passed');
  if (report.reproducibility?.modelSha256 !== sha(modelText)) throw new Error('model-changed-after-evaluation');
  const holidays = reviewedKoreanHolidays(), review = holidays.reviews.find(entry => entry.year === Number(seoulDate(now).slice(0, 4)));
  if (!review) throw new Error('holiday-calendar-missing');
  const expiresAt = review.reviewAfter, lastDate = seoulDate(expiresAt - 1);
  if (!(now >= candidate.trainedAt && now < expiresAt)) throw new Error('outside-serving-window');
  if (holidayReviewProblems(holidays, protocol.first, lastDate, now).length) throw new Error('holiday-calendar-review');
  const calendar = holidayCalendarSlice(holidays, protocol.first, lastDate);
  if (!calendar) throw new Error('holiday-calendar-range');
  // The served slice must agree with what the trainer read for every trained and evaluated day.
  const trained = calendar.holidays.filter(day => day <= protocol.evaluation.at(-1));
  if (JSON.stringify(trained) !== JSON.stringify(candidate.calendar.holidays)) throw new Error('holiday-calendar-changed-since-training');
  const evaluations = report.evaluations as Record<string, unknown>;
  const checkpoint = {
    version: SPATIAL_BICYCLE_V2, deployment: 'production' as const, target: 'bicycle-direct-ride-elapsed' as const, region: 'seoul' as const,
    trainedAt: candidate.trainedAt, expiresAt, trainingThrough: candidate.trainingThrough, lastEvaluatedServiceDate: protocol.evaluation.at(-1), sourceMonth: candidate.sourceMonth,
    featureNames: candidate.featureNames, models: candidate.models, featureQuantization: candidate.featureQuantization,
    calendar: { rule: calendar.rule, firstDate: calendar.firstDate, lastDate: calendar.lastDate, holidays: calendar.holidays },
    conformal: SPATIAL_BICYCLE_GROUPS.map(group => { const entry = candidate.conformal.find((value: { group: string }) => value.group === group); if (!entry) throw new Error('calibration-group'); return entry; }),
    labelUncertaintySeconds: 1, domain: candidate.domain, targetDefinition: candidate.targetDefinition,
    evaluation: Object.fromEntries(Object.entries(evaluations).filter(([name]) => ['all', 'unseenOd', 'seenOd'].includes(name) || name.startsWith('day:'))),
    source: { experiment: basename(directory), protocolSha256: report.reproducibility.protocolSha256, modelSha256: report.reproducibility.modelSha256 },
    limitations: candidate.limitations,
  };
  const text = JSON.stringify(checkpoint) + '\n', parsed = parseSpatialBicycleCheckpoint(text);
  // Python sklearn ↔ portable TypeScript on evaluation-day rides, from features through the served quartiles and band.
  const weekdayOf = holidayAsSunday(parsed.calendar);
  let featureError = 0, secondsError = 0;
  for (const row of parity.cases as { input: SpatialBicycleRideInput; features: number[]; lowerSeconds: number; upperSeconds: number; q25Seconds: number; q75Seconds: number; predictions: { median: number } }[]) {
    const features = spatialBicycleRideFeatures(row.input, weekdayOf), estimate = predictSpatialBicycleRide(parsed, row.input);
    if (!features || !estimate) throw new Error('parity-case-rejected');
    features.forEach((value, i) => { featureError = Math.max(featureError, Math.abs(value - row.features[i])); });
    secondsError = Math.max(secondsError, Math.abs(estimate.bandLowerSeconds - row.lowerSeconds), Math.abs(estimate.bandUpperSeconds - row.upperSeconds),
      Math.abs(estimate.lowerSeconds - row.q25Seconds), Math.abs(estimate.upperSeconds - row.q75Seconds), Math.abs(estimate.medianSeconds - Math.max(1, Math.min(10800, row.predictions.median))));
  }
  if ((parity.cases as unknown[]).length < 100 || featureError > 1e-8 || secondsError > 1e-6) throw new Error('python-typescript-parity-failed');
  if (existsSync(output)) await copyFile(output, resolve(dirname(output), `spatial-bicycle-backup-${now}.json`));
  const temporary = `${output}.${process.pid}.tmp`;
  try { await writePrivateFile(temporary, text); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
  return { version: SPATIAL_BICYCLE_V2, output: relative(project, output), bytes: (await stat(output)).size, trainedAt: new Date(parsed.trainedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(), parityCases: (parity.cases as unknown[]).length, maximumFeatureError: featureError, maximumSecondsError: secondsError,
    holidays: parsed.calendar.holidays };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  promoteSpatialBicycle(process.argv.slice(2)).then(result => console.info(JSON.stringify(result)), (error) => {
    console.error(`따릉이 공간 모델을 운영 파일로 만들지 못했습니다: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
