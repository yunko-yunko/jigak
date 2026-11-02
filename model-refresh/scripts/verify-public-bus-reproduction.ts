import './holiday-env';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { roadPriorBundleSchema } from '../../src/common/engine/intelligence/historical-context';
import { parsePublicBusModel, predictPublicBusDuration, PUBLIC_BUS_SCOPE_BOUNDS, trainPublicBusModel, type PublicBusModelObservation, type PublicBusPredictionInput } from '../../src/common/engine/intelligence/public-bus-model';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
const within = (parent: string, path: string) => { const child = relative(parent, path); return !!child && !child.startsWith('..') && !isAbsolute(child); };
async function input(path: string, maximum: number): Promise<string> {
  const actualRoot = await realpath(root), actual = await realpath(resolve(project, path));
  if (!within(actualRoot, actual)) throw new Error('path');
  const info = await stat(actual);
  if (!info.isFile() || info.size > maximum) throw new Error('size');
  const text = await readFile(actual, 'utf8');
  if (Buffer.byteLength(text) > maximum) throw new Error('size');
  return text;
}

/** Reproduce a frozen fit and its serialized runtime predictions. Emits aggregate evidence only. */
export async function verifyPublicBusReproduction(args: string[]) {
  if (args.length !== 6 || args[0] !== '--input' || args[2] !== '--road-priors' || args[4] !== '--report') throw new Error('usage');
  const [source, priorText, reportText] = await Promise.all([input(args[1], 384 * 1024 ** 2), input(args[3], 2 * 1024 ** 2), input(args[5], 2 * 1024 ** 2)]);
  const lines = source.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > 140_000) throw new Error('rows');
  const rows = lines.map(line => JSON.parse(line)) as PublicBusModelObservation[], report = JSON.parse(reportText);
  if (!report.qualityPassed || report.status !== 'production-candidate' || !report.model) throw new Error('failed-quality');
  const priors = roadPriorBundleSchema.parse(JSON.parse(priorText));
  // The artifact's recorded training clock makes a later offline audit repeatable;
  // activation separately checks the real current clock and expiration.
  // A v3 fit replays its own frozen holiday slice, so a later edit of the reviewed files cannot change the audit.
  const calendar = report.model.calendar, holidays = calendar ? { firstDate: calendar.firstDate, lastDate: calendar.lastDate, holidays: calendar.holidays, reviews: [] } : undefined;
  const reproduced = trainPublicBusModel(rows, { now: report.trainedAt, roadPriorArchives: priors.archives, serviceWindowStart: report.model.validation.sourceDates[0], version: report.version, holidays });
  assert.deepEqual(reproduced, report, 'frozen-training-report-mismatch');
  const model = parsePublicBusModel(JSON.stringify(report.model), report.trainedAt), bounds = PUBLIC_BUS_SCOPE_BOUNDS;
  const inScope = (latitude: number, longitude: number) => latitude >= bounds.south && latitude <= bounds.north && longitude >= bounds.west && longitude <= bounds.east;
  const testDates = new Set<string>(model.validation.testDates);
  const heldOut = rows.filter(row => testDates.has(row.sourceDate) && inScope(row.fromLatitude, row.fromLongitude) && inScope(row.toLatitude, row.toLongitude));
  assert.equal(heldOut.length, report.evaluations.all.rows, 'held-out-population-mismatch');
  let error = 0, baselineError = 0, covered = 0, upperCovered = 0, relativeWidth = 0, relativeFloorAdjustment = 0;
  const runtimeInput = (row: PublicBusModelObservation): PublicBusPredictionInput => ({
    distanceMeters: row.distanceMeters, startedAt: row.startedAt, roadPrior: row.roadPrior,
    weather: row.weather ? {
      observedAt: row.weather.observedAt, ageSeconds: row.weather.ageSeconds,
      temperatureC: row.weather.temperatureC, windMetersPerSecond: row.weather.windMetersPerSecond,
      precipitationMm: row.weather.precipitationMm, precipitationTrace: row.weather.precipitationTrace,
    } : null,
  });
  for (const row of heldOut) {
    const prediction = predictPublicBusDuration(model, runtimeInput(row), report.trainedAt);
    assert.ok(prediction, 'runtime-refused-supported-held-out-context');
    error += Math.abs(prediction.medianSeconds - row.actualSeconds);
    baselineError += Math.abs(row.distanceMeters * model.baselineSecondsPerMeter - row.actualSeconds);
    covered += Number(prediction.lowerSeconds <= row.actualSeconds - 60 && prediction.upperSeconds >= row.actualSeconds + 60);
    upperCovered += Number(prediction.upperSeconds >= row.actualSeconds + 60);
    relativeWidth += (prediction.upperSeconds - prediction.lowerSeconds) / row.actualSeconds;
    // Runtime has a one-second minimum lower bound; offline evaluation permits zero.
    const floorAdjustment = prediction.lowerSeconds - Math.max(0, prediction.medianSeconds * Math.exp(-model.logRadius) - 60);
    assert.ok(floorAdjustment >= 0 && floorAdjustment <= 1, 'unexpected-runtime-interval-adjustment');
    relativeFloorAdjustment += floorAdjustment / row.actualSeconds;
  }
  const replay = { modelMaeSeconds: error / heldOut.length, baselineMaeSeconds: baselineError / heldOut.length,
    robustIntervalCoverage: covered / heldOut.length, robustUpperCoverage: upperCovered / heldOut.length, meanRelativeWidth: relativeWidth / heldOut.length };
  for (const [metric, value] of Object.entries(replay)) {
    const referenceValue = metric === 'meanRelativeWidth' ? value + relativeFloorAdjustment / heldOut.length : value;
    assert.ok(Math.abs(referenceValue - report.evaluations.all[metric]) < 1e-9, `runtime-${metric}-mismatch`);
  }
  const example = runtimeInput(heldOut[0]);
  assert.equal(predictPublicBusDuration(model, example, model.expiresAt), null, 'expired-model-accepted');
  assert.equal(predictPublicBusDuration(model, { ...example, distanceMeters: 50_001 }, report.trainedAt), null, 'unsupported-distance-accepted');
  if (example.weather) assert.equal(predictPublicBusDuration(model, { ...example, weather: { ...example.weather, observedAt: example.startedAt + 1000, ageSeconds: 0 } }, report.trainedAt), null, 'future-weather-accepted');
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  return { version: 'public-bus-reproduction-verification-v1', verified: true, frozenTrainingClock: report.trainedAt,
    exactFitReproduced: true, serializedRuntimeRows: heldOut.length, replay, runtimeLowerFloorSeconds: 1,
    relativeWidthFloorAdjustment: relativeFloorAdjustment / heldOut.length,
    expiryRejected: true, unsupportedDistanceRejected: true, futureWeatherRejected: !!example.weather,
    sourceSha256: digest(source), roadPriorSha256: digest(priorText), reportSha256: digest(reportText),
    baselineMeaning: 'training-median-seconds-per-meter; not-contemporaneous-provider-ETA',
    rawPreparationReproducibility: 'ephemeral grouping changes vehicle holdout across new preparations; exact fit is tied to this frozen sanitized dataset' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void verifyPublicBusReproduction(process.argv.slice(2)).then(result => console.info(JSON.stringify(result))).catch(() => {
  console.error('버스 모델 재현 검증에 실패했습니다. 입력, 도로 사전자료와 통과 보고서의 조합을 확인해 주세요. 원본 행과 오류 원문은 출력하지 않습니다.');
  process.exitCode = 1;
});
