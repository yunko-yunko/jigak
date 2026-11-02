import './holiday-env';
import { createHash } from 'node:crypto';
import { copyFile, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { holidayCalendarSlice, holidayReviewProblems, reviewedKoreanHolidays } from '../../src/common/engine/intelligence/korean-holidays';
import { parseRailGateCheckpoint, predictRailGate, railGateFeatures, RAIL_GATE_GROUPS, RAIL_GATE_VERSION } from '../../src/common/engine/intelligence/rail-gate-model';
import { writePrivateFile } from '../../src/common/engine/private-files';
import { servingCalendarLastDate } from './model-refresh/calendar-span';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
const within = (base: string, target: string) => { const child = relative(base, target); return !!child && !child.startsWith('..') && !isAbsolute(child); };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
interface ParityCase { input: { originName: string; destinationName: string; origin: [number, number]; destination: [number, number]; startedAt: number }; features: number[]; lowerSeconds: number; upperSeconds: number }

/**
 * Turns a passed subway gate experiment into the served checkpoint. Trees, encodings and calibration are copied
 * as evaluated; only the 7-day serving window and the reviewed holiday slice through its longest possible life are added.
 */
export async function promoteRailGate(args: string[], options: { now?: number } = {}) {
  if (args.length !== 4 || args[0] !== '--experiment' || args[2] !== '--output') throw new Error('usage');
  const now = options.now ?? Date.now(), directory = await realpath(resolve(project, args[1])), output = resolve(project, args[3]);
  const actualRoot = await realpath(root), parent = await realpath(dirname(output));
  if (!within(actualRoot, directory) || parent !== actualRoot && !within(actualRoot, parent) || !output.endsWith('.json')) throw new Error('path');
  const read = (name: string) => readFile(resolve(directory, name), 'utf8');
  const [protocolText, modelText, reportText, parityText] = await Promise.all(['protocol.json', 'model.json', 'report.json', 'parity.json'].map(read));
  const protocol = JSON.parse(protocolText), candidate = JSON.parse(modelText), report = JSON.parse(reportText), parity = JSON.parse(parityText) as { cases: ParityCase[] };
  if (candidate.version !== RAIL_GATE_VERSION || report.version !== RAIL_GATE_VERSION || !['final', 'refresh'].includes(protocol.phase)) throw new Error('not-a-final-rail-gate-experiment');
  if (report.qualityPassed !== true || report.qualityFailedGroups?.length) throw new Error('quality-gate-not-passed');
  if (report.reproducibility?.modelSha256 !== sha(modelText)) throw new Error('model-changed-after-evaluation');
  const expiresAt = candidate.trainedAt + 7 * DAY;
  if (!(now >= candidate.trainedAt && now < expiresAt)) throw new Error('outside-serving-window');
  // The slice reaches trainedAt + 28 days (as far as reviewed years go) so a manifest re-validation can extend a model that still predicts.
  const holidays = reviewedKoreanHolidays(), lastDate = servingCalendarLastDate(holidays, protocol.first, candidate.trainedAt, expiresAt, now);
  if (holidayReviewProblems(holidays, protocol.first, lastDate, now).length) throw new Error('holiday-calendar-review');
  const calendar = holidayCalendarSlice(holidays, protocol.first, lastDate);
  if (!calendar) throw new Error('holiday-calendar-range');
  if (JSON.stringify(calendar.holidays.filter(day => day <= protocol.evaluation.at(-1))) !== JSON.stringify(candidate.calendar.holidays)) throw new Error('holiday-calendar-changed-since-training');
  const evaluations = report.evaluations as Record<string, unknown>;
  const checkpoint = {
    version: RAIL_GATE_VERSION, deployment: 'production' as const, target: 'rail-gate-elapsed' as const, trainedAt: candidate.trainedAt, expiresAt,
    trainingThrough: candidate.trainingThrough, lastEvaluatedServiceDate: protocol.evaluation.at(-1), featureNames: candidate.featureNames,
    featureQuantizationDecimals: 6, models: candidate.models, secondsPerMeter: candidate.secondsPerMeter, priorRows: candidate.priorRows, encodings: candidate.encodings,
    calendar: { rule: calendar.rule, firstDate: calendar.firstDate, lastDate: calendar.lastDate, holidays: calendar.holidays },
    conformal: RAIL_GATE_GROUPS.map(group => { const entry = candidate.conformal.find((value: { group: string }) => value.group === group); if (!entry) throw new Error('calibration-group'); return entry; }),
    labelUncertaintySeconds: 60, domain: candidate.domain,
    evaluation: Object.fromEntries(Object.entries(evaluations).filter(([name]) => ['all', 'seenOd', 'unseenOd'].includes(name) || name.startsWith('day:'))),
    source: { experiment: basename(directory), protocolSha256: report.reproducibility.protocolSha256, modelSha256: report.reproducibility.modelSha256 },
    limitations: candidate.limitations,
  };
  const text = JSON.stringify(checkpoint) + '\n', parsed = parseRailGateCheckpoint(text);
  // Python sklearn <-> portable TypeScript on evaluation-day rows, from features through the final interval.
  let featureError = 0, intervalError = 0, compared = 0, unknownStation = 0;
  for (const row of parity.cases) {
    const input = { originName: row.input.originName, destinationName: row.input.destinationName, startedAt: row.input.startedAt,
      origin: { latitude: row.input.origin[0], longitude: row.input.origin[1] }, destination: { latitude: row.input.destination[0], longitude: row.input.destination[1] } };
    if (!parsed.lookup.origins.has(input.originName) || !parsed.lookup.destinations.has(input.destinationName)) { unknownStation++; continue; }
    const features = railGateFeatures(parsed, input), envelope = predictRailGate(parsed, input);
    if (!features || !envelope) throw new Error('parity-case-rejected');
    features.forEach((value, i) => { featureError = Math.max(featureError, Math.abs(value - row.features[i])); });
    intervalError = Math.max(intervalError, Math.abs(envelope.lowerSeconds - row.lowerSeconds), Math.abs(envelope.upperSeconds - row.upperSeconds));
    compared++;
  }
  if (compared < 100 || unknownStation > parity.cases.length * .02 || featureError > 1e-8 || intervalError > 1e-6) throw new Error(`python-typescript-parity-failed:${compared}:${unknownStation}:${featureError}:${intervalError}`);
  if (existsSync(output)) await copyFile(output, resolve(dirname(output), `rail-gate-backup-${now}.json`));
  const temporary = `${output}.${process.pid}.tmp`;
  try { await writePrivateFile(temporary, text); await rename(temporary, output); } finally { await rm(temporary, { force: true }); }
  return { version: RAIL_GATE_VERSION, output: relative(project, output), bytes: (await stat(output)).size, trainedAt: new Date(parsed.trainedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(), parityCases: compared, unknownStationCases: unknownStation, maximumFeatureError: featureError, maximumIntervalErrorSeconds: intervalError,
    stations: parsed.lookup.origins.size, stationPairs: parsed.lookup.pairs.size, holidays: parsed.calendar.holidays };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  promoteRailGate(process.argv.slice(2)).then(result => console.info(JSON.stringify(result)), (error) => {
    console.error(`지하철 개찰 모델을 운영 파일로 만들지 못했습니다: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exitCode = 1;
  });
}
