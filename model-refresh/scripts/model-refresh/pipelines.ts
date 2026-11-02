import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { promote, readManifest, revalidate, type Manifest } from './manifest';
import { compareRailGate, compareSpatialBus, writeRailGatePredictions, writeSpatialBusPredictions, type IncumbentComparison, type IncumbentGate } from './incumbent';
import { childEnv, copyTree, listFiles, runLogged, stageFile, type StepResult, type StepRunner } from './process';
import { planRouteTables, publicBusReproducible, trainingWindow } from './schedule';
import { JOURNALS, Store, type ModelKey } from './store';
import type { TaimsIndex, TaimsIndexEntry } from './taims';
import { DAY, errorMessage, kstDate, readJson, sha256File, sha256Text, writeAtomic, writeJsonAtomic, type Logger } from './util';

export type RouteTablePolicy = 'strict' | 'nearest-consistent';
export interface RunContext {
  store: Store; runId: string; now: () => number; mode: 'local' | 'cloud'; plan: boolean; log: Logger;
  projectDir: string; workDir: string; holidayDir: string; python: string; routeTablePolicy: RouteTablePolicy;
  runner: StepRunner; env: NodeJS.ProcessEnv; workers: number;
}
/** 'revalidated': the candidate did not replace the model in service, which passed every group of the promotion gate again on the fresh day and had its expiry extended. */
export type MemberOutcome = { status: 'promoted' | 'revalidated' | 'closed' | 'failed' | 'blocked' | 'skipped'; reason: string; details?: Record<string, unknown> };
export interface AttemptRecord {
  version: 'jigak-refresh-attempt-v1'; group: 'bus'; evaluationDate: string; inputsSha256: string; startedAt: number; updatedAt: number; runIds: string[];
  status: 'open' | 'closed' | 'finished'; members: Partial<Record<ModelKey, MemberOutcome>>;
  /** Runs that ended in an unexpected error (a crash, not a data or gate refusal); the day is closed after MAX_ATTEMPT_ERRORS. */
  errors?: number;
  /**
   * Runs that started work on this day, saved before any step runs. A run killed mid-way (OOM, SIGKILL, job timeout) never
   * reaches the error count; once this many runs left the day open, the day is closed instead of being picked again forever.
   */
  runs?: number;
}
interface StageRecord { name: string; inputsSha256: string; outputs: Record<string, string>; result: unknown; finishedAt: number; runId: string }

const ROAD_PRIORS = 'topis-road-priors-2026-08-09.json', STATIONS = 'spatial-transit-stations.csv';
export const STATIC_CONTEXT = { roadPriors: ROAD_PRIORS, stations: STATIONS };
/** The only bytes accepted for each fixed input (model-refresh/data-static/README.md). */
export const STATIC_SHA256: Record<string, string> = {
  [ROAD_PRIORS]: 'c54092af7b945ef8f9a59c19652c5b359933bc79f5fa0e928f5f3caff4b6ddd2',
  [STATIONS]: 'f6a1eb4282660041ce791ef9391848f320a3b8f7ea7ffbd4365372ea6e5b1608',
};
/** The committed copies, next to the scripts (and in the job image). */
export const staticInputDir = (projectDir: string) => resolve(projectDir, 'data-static');
const MIN_ROWS_PER_DAY = 3_000, MIN_RAIL_ROWS_PER_DAY = 2_000;
const MINUTE = 60_000, MAX_ATTEMPT_ERRORS = 3;
/** A member in one of these states is not run again when an open attempt is resumed. */
const SETTLED: string[] = ['promoted', 'revalidated', 'closed'];

const data = (ctx: RunContext, ...parts: string[]) => resolve(ctx.workDir, 'data', ...parts);
const journalDir = (ctx: RunContext) => resolve(ctx.workDir, 'journals');
function scriptEnv(ctx: RunContext) {
  return childEnv(ctx.env, { JIGAK_DATA_ROOT: data(ctx), JIGAK_EVALUATION_JOURNAL_DIR: journalDir(ctx), JIGAK_HOLIDAY_DIR: ctx.holidayDir });
}
const node = (ctx: RunContext, name: string, script: string, args: string[], timeoutMs = 30 * MINUTE) =>
  runLogged(ctx.runner, { name, command: process.execPath, args: ['--import', 'tsx', resolve(ctx.projectDir, 'scripts', script), ...args], cwd: ctx.projectDir, env: scriptEnv(ctx), timeoutMs }, ctx.log);
// Python runs from the work folder: the preparation scripts record cache paths relative to the working directory.
const python = (ctx: RunContext, name: string, script: string, args: string[], timeoutMs = 90 * MINUTE) =>
  runLogged(ctx.runner, { name, command: ctx.python, args: ['-X', 'utf8', resolve(ctx.projectDir, 'scripts', script), ...args], cwd: ctx.workDir, env: scriptEnv(ctx), timeoutMs }, ctx.log);
const failure = (step: string, result: StepResult) => {
  const json = result.json as { error?: unknown; reason?: unknown } | null;
  return `${step}:${String(json?.error ?? `exit-${result.code}`).slice(0, 80)}${typeof json?.reason === 'string' ? `:${json.reason.slice(0, 160)}` : ''}`;
};
/** A trainer says 'refused' for a rule of its protocol (final for this day) and 'crash' for anything else (retried). No JSON at all is a crash. */
const refusedByRule = (result: StepResult) => (result.json as { kind?: unknown } | null)?.kind === 'refused';

/** Journals live in the store; scripts see a copy in the work folder that is written back after every stage (single writer under the lock). */
export async function pullJournals(ctx: RunContext) {
  await mkdir(journalDir(ctx), { recursive: true });
  for (const path of await listFiles(ctx.store.journals)) await stageFile(path, resolve(journalDir(ctx), relative(ctx.store.journals, path)));
}
export async function pushJournals(ctx: RunContext) {
  for (const path of await listFiles(journalDir(ctx))) {
    if (/\.tmp$|\.lock$/.test(path)) continue;
    const target = resolve(ctx.store.journals, relative(journalDir(ctx), path)), text = await readFile(path);
    if (existsSync(target) && sha256Text(await readFile(target)) === sha256Text(text)) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.tmp-${ctx.runId}`, text); await rename(`${target}.tmp-${ctx.runId}`, target);
  }
}
/** Evaluation days whose attempt is still open: a member crashed and may be retried, which the used-day rule must not forbid. */
export async function openAttemptDates(store: Store): Promise<Set<string>> {
  const directory = store.path('candidates', 'bus'), dates = new Set<string>();
  if (!existsSync(directory)) return dates;
  for (const date of await readdir(directory)) { const attempt = await readJson<AttemptRecord>(resolve(directory, date, 'attempt.json')); if (attempt?.status === 'open') dates.add(date); }
  return dates;
}
export async function usedEvaluationDates(store: Store): Promise<Record<'publicBus' | 'spatialBus' | 'railGate', Set<string>>> {
  const keys = async (name: string) => new Set(Object.keys(await readJson<Record<string, string>>(resolve(store.journals, name)) ?? {}));
  const publicDir = resolve(store.journals, JOURNALS.publicBus);
  const publicDates = existsSync(publicDir) ? (await readdir(publicDir)).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).map(name => name.slice(0, 10)) : [];
  return { publicBus: new Set(['2026-10-11', '2026-10-12', ...publicDates]), spatialBus: await keys(JOURNALS.spatialBus), railGate: await keys(JOURNALS.railGate) };
}

/** Stage memo in the store: same inputs and intact outputs → the stage is not run again (a finished training is never repeated). */
async function stage<T>(ctx: RunContext, candidate: string, name: string, inputsSha256: string, outputs: string[], run: () => Promise<T>): Promise<T> {
  const recordPath = resolve(candidate, `stage-${name}.json`), record = await readJson<StageRecord>(recordPath);
  if (record && record.inputsSha256 === inputsSha256) {
    let intact = true;
    for (const output of outputs) { const stored = resolve(candidate, 'outputs', basename(output)); if (!existsSync(stored) || await sha256File(stored) !== record.outputs[basename(output)]) { intact = false; break; } }
    if (intact) {
      for (const output of outputs) if (!existsSync(output)) await stageFile(resolve(candidate, 'outputs', basename(output)), output);
      ctx.log('INFO', 'stage-reused', { stage: name });
      return record.result as T;
    }
  }
  const result = await run(), digests: Record<string, string> = {};
  for (const output of outputs) { const stored = resolve(candidate, 'outputs', basename(output)); await stageFile(output, stored); digests[basename(output)] = await sha256File(stored); }
  await writeJsonAtomic(recordPath, { name, inputsSha256, outputs: digests, result, finishedAt: ctx.now(), runId: ctx.runId } satisfies StageRecord, ctx.runId);
  return result;
}

/**
 * Store static/ first (init writes it there), then raw/context/ (where an older init wrote it; the bucket deletes raw/ after
 * 21 days), then the committed copy in data-static/. Only a file with the expected sha256 is used; another one is skipped and logged.
 */
export async function stageStaticInputs(ctx: RunContext) {
  for (const name of [ROAD_PRIORS, STATIONS]) {
    let source: string | undefined;
    for (const candidate of [resolve(ctx.store.static, name), resolve(ctx.store.context, name), resolve(staticInputDir(ctx.projectDir), name)]) {
      if (!existsSync(candidate)) continue;
      const sha256 = await sha256File(candidate);
      if (sha256 === STATIC_SHA256[name]) { source = candidate; break; }
      ctx.log('WARNING', 'static-input-mismatch', { name, path: candidate, sha256, expected: STATIC_SHA256[name] });
    }
    if (!source) throw new Error(`static-input-missing:${name}`);
    await stageFile(source, data(ctx, 'context', name));
  }
}

async function fetchWeather(ctx: RunContext, year: string, target: string, fetchImpl: typeof fetch) {
  const url = `https://www.ncei.noaa.gov/oa/global-historical-climatology-network/hourly/access/by-year/${year}/psv/GHCNh_KSI0000RKSL_${year}.psv`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (response.status !== 200) throw new Error(`weather-http-${response.status}`);
  const text = await response.text();
  if (text.length > 16 * 1024 * 1024 || !text.startsWith('STATION|')) throw new Error('weather-format');
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, text);
  await stageFile(target, resolve(ctx.store.context, `ghcnh-KSI0000RKSL-${year}-${kstDate(ctx.now())}.psv`));
  return { url, bytes: text.length, sha256: sha256Text(text) };
}

function acquisitionManifest(ctx: RunContext, entries: TaimsIndexEntry[]) {
  return { version: 'tdata-public-bus-acquisition-v1', sourcePage: 'https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006',
    catalogSha256: 'refresh-index', retrievedAt: new Date(ctx.now()).toISOString(), license: 'CC BY; Seoul T-DATA and T-money', archiveCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), archiveDateMeaning: 'publication-name-only; service dates must be read from source rows',
    archives: entries.map(entry => ({ name: entry.name, url: /download\.do\?id=\d+$/.test(entry.url) && entry.id !== 'unknown' ? entry.url : 'https://t-data.seoul.go.kr/dataprovide/download.do?id=0',
      bytes: entry.bytes, sha256: entry.sha256, path: `data/taims/${entry.name}` })) };
}

async function readAttempt(path: string) { return readJson<AttemptRecord>(path); }
async function saveAttempt(ctx: RunContext, path: string, record: AttemptRecord) { record.updatedAt = ctx.now(); await writeJsonAtomic(path, record, ctx.runId); }

/**
 * One evaluation day for publicBus, spatialBus and railGate (they share the TAIMS window and the public bus report is the
 * spatial model's reference). Preparation and row checks run before any trainer writes the evaluation day.
 */
export async function attemptBusGroup(ctx: RunContext, options: { evaluationDate: string; index: TaimsIndex; members: ModelKey[]; fetchImpl: typeof fetch }): Promise<AttemptRecord> {
  const { evaluationDate: E, index } = options, store = ctx.store, window = trainingWindow(E);
  const candidate = store.candidateDir('bus', E), attemptPath = resolve(candidate, 'attempt.json');
  const byDate = new Map(Object.values(index.archives).filter(entry => entry.zipOk).map(entry => [entry.serviceDate, entry]));
  const entries = window.dates.map(date => byDate.get(date)).filter((entry): entry is TaimsIndexEntry => !!entry);
  const routes = planRouteTables(index, window.dates, ctx.routeTablePolicy);
  const references = routes.references.map(date => byDate.get(date)!).filter(Boolean);
  const inputsSha256 = sha256Text(JSON.stringify({ archives: entries.map(entry => entry.sha256), references: references.map(entry => entry.sha256), policy: ctx.routeTablePolicy, window }));
  const record: AttemptRecord = await readAttempt(attemptPath) ?? { version: 'jigak-refresh-attempt-v1', group: 'bus', evaluationDate: E, inputsSha256, startedAt: ctx.now(), updatedAt: ctx.now(), runIds: [], status: 'open', members: {} };
  if (record.status !== 'open') return record;
  if (record.inputsSha256 !== inputsSha256) { record.status = 'closed'; for (const key of options.members) record.members[key] ??= { status: 'closed', reason: 'inputs-changed-after-start' }; await saveAttempt(ctx, attemptPath, record); return record; }
  record.runIds = [...new Set([...record.runIds, ctx.runId])];
  const pending = options.members.filter(key => !SETTLED.includes(record.members[key]?.status ?? ''));
  // Blocked by the data itself (before any evaluation day is written): the same archives would block again, so the day is closed.
  const finishAll = async (status: MemberOutcome['status'], reason: string, details?: Record<string, unknown>) => { for (const key of pending) record.members[key] = { status, reason, details }; if (status !== 'failed') record.status = 'closed'; };
  // A crash is retried on the next run (same inputs, stages already done are reused) a bounded number of times, then the day is closed.
  const countCrash = () => {
    record.errors = (record.errors ?? 0) + 1;
    if (record.errors < MAX_ATTEMPT_ERRORS) return;
    for (const key of pending) { const member = record.members[key]; if (member?.status === 'failed') record.members[key] = { status: 'closed', reason: `retries-exhausted:${member.reason}`.slice(0, 240) }; }
    record.status = 'closed';
  };
  if (entries.length !== window.dates.length || !routes.ok) { await finishAll('blocked', routes.ok ? 'window-incomplete' : routes.reason!); await saveAttempt(ctx, attemptPath, record); return record; }
  // Every earlier run left the day open: at least one of them never finished (a crash closes the day itself at the same count).
  if ((record.runs ?? 0) >= MAX_ATTEMPT_ERRORS) {
    for (const key of pending) record.members[key] = { status: 'closed', reason: `retries-exhausted:unfinished-run${record.members[key]?.reason ? `:${record.members[key]!.reason}` : ''}`.slice(0, 240) };
    record.status = 'closed'; ctx.log('WARNING', 'bus-group-closed-unfinished', { evaluationDate: E, runs: record.runs, errors: record.errors ?? 0 });
    await saveAttempt(ctx, attemptPath, record); return record;
  }
  record.runs = (record.runs ?? 0) + 1;
  await saveAttempt(ctx, attemptPath, record);
  const zipPaths: string[] = [];
  try {
    for (const entry of [...entries, ...references]) { const target = data(ctx, 'taims', entry.name); await stageFile(resolve(store.taims, entry.name), target); if (entries.includes(entry)) zipPaths.push(target); }
    const referencePaths = references.map(entry => data(ctx, 'taims', entry.name));
    await stageStaticInputs(ctx);
    const work = data(ctx, 'bus', E); await mkdir(work, { recursive: true });
    const busJsonl = resolve(work, 'bus.jsonl'), contextJsonl = resolve(work, 'bus-context.jsonl'), weather = resolve(work, 'weather.psv');
    const priors = data(ctx, 'context', ROAD_PRIORS), stations = data(ctx, 'context', STATIONS);

    // 1. Bus rows (no evaluation day is touched).
    const prepared = await stage(ctx, candidate, 'prepare-bus', inputsSha256, [busJsonl, `${busJsonl}.manifest.json`], async () => {
      await rm(busJsonl, { force: true }); await rm(`${busJsonl}.manifest.json`, { force: true });
      const policy = ctx.routeTablePolicy === 'nearest-consistent' ? ['--route-table-policy', 'nearest-consistent', ...(referencePaths.length ? ['--route-table-references', ...referencePaths] : [])] : ['--borrow-route-numbers'];
      const result = await python(ctx, 'prepare-bus', 'prepare-public-bus-multiday.py', ['--inputs', ...zipPaths, '--output', busJsonl, ...policy, '--workers', String(ctx.workers), '--execute']);
      for (const name of await readdir(work)) if (name.startsWith('.public-bus-batch-')) await rm(resolve(work, name), { recursive: true, force: true });
      if (result.code !== 0) throw Object.assign(new Error(failure('prepare-bus', result)), { blocking: /route_table|required_members|archive_size|source_date|duplicate/.test(String(result.json?.error)) });
      const manifest = JSON.parse(await readFile(`${busJsonl}.manifest.json`, 'utf8'));
      const perDay = Object.fromEntries((manifest.archives as { sourceDates: string[]; outputRows: number }[]).map(archive => [archive.sourceDates[0], archive.outputRows]));
      return { outputRows: manifest.outputRows as number, perDay, routeNumberFallbacks: manifest.routeNumberFallbacks };
    });
    const thin = window.dates.filter(date => (prepared.perDay[date] ?? 0) < MIN_ROWS_PER_DAY);
    if (thin.length) { await finishAll('blocked', `rows-below-floor:${thin.join(',')}`); return record; }

    // 2. Weather is re-read every attempt (NOAA lags about two days); road priors stay the frozen 8-9월 table.
    const firstYear = window.first.slice(0, 4), lastYear = E.slice(0, 4);
    if (firstYear !== lastYear) { await finishAll('blocked', 'weather-year-boundary-not-supported'); return record; }
    await stage(ctx, candidate, 'weather', inputsSha256, [weather], () => fetchWeather(ctx, lastYear, weather, options.fetchImpl));
    await stage(ctx, candidate, 'join', inputsSha256, [contextJsonl, `${contextJsonl}.manifest.json`], async () => {
      await rm(contextJsonl, { force: true }); await rm(`${contextJsonl}.manifest.json`, { force: true });
      const result = await node(ctx, 'join-context', 'join-public-bus-context.ts', ['--input', busJsonl, '--weather', weather, '--road-priors', priors, '--output', contextJsonl, '--execute']);
      if (result.code !== 0) throw new Error(failure('join-context', result));
      return result.json;
    });
    const sources = resolve(work, 'acquisition-manifest.json');
    await writeFile(sources, JSON.stringify(acquisitionManifest(ctx, entries), null, 2) + '\n');

    // 3. Public bus report: writes the evaluation day to the public bus journal.
    const report = resolve(work, 'public-bus-report.json');
    const reportResult = await stage(ctx, candidate, 'train-public-bus', inputsSha256, [report], async () => {
      const result = await node(ctx, 'train-public-bus', 'train-public-bus-model.ts', ['--input', contextJsonl, '--road-priors', priors, '--output', report, '--service-window-start', window.publicBusWindowStart], 30 * MINUTE)
        .finally(() => pushJournals(ctx));
      if (result.code !== 0 || !existsSync(report)) throw new Error(failure('train-public-bus', result));
      return { status: result.json?.status, qualityPassed: result.json?.qualityPassed, evaluations: (result.json?.evaluations as Record<string, unknown> | undefined)?.all ?? null };
    }).catch(error => ({ error: errorMessage(error) }));
    if ('error' in reportResult) {
      // The trainer registers the evaluation day only once its report exists. Registered without a report: nobody can finish this day.
      if ((await usedEvaluationDates(store)).publicBus.has(E)) { await finishAll('closed', reportResult.error); record.status = 'closed'; return record; }
      await finishAll('failed', reportResult.error); countCrash(); return record;
    }

    // 4. Members, each gated against its incumbent; any failure closes only that member for this day.
    const manifest = await readManifest(store);
    const incumbentText = async (key: ModelKey) => { const entry = manifest?.models[key]; return entry ? readFile(store.path(entry.path), 'utf8') : null; };
    if (pending.includes('publicBus')) record.members.publicBus = await publicBusMember(ctx, { candidate, work, contextJsonl, priors, report, sources, incumbent: await incumbentText('publicBus'), E, inputsSha256 });
    if (pending.includes('spatialBus')) record.members.spatialBus = await spatialBusMember(ctx, { candidate, work, contextJsonl, report, window, incumbent: await incumbentText('spatialBus'), publicBusIncumbent: await incumbentText('publicBus'), E, inputsSha256 });
    if (pending.includes('railGate')) record.members.railGate = await railGateMember(ctx, { candidate, work, zipPaths, referencePaths, stations, window, incumbent: await incumbentText('railGate'), E, inputsSha256 });
    record.status = 'finished';
    if (pending.some(key => record.members[key]?.status === 'failed')) { record.status = 'open'; countCrash(); }
    return record;
  } catch (error) {
    const reason = errorMessage(error), blocking = (error as { blocking?: boolean }).blocking === true;
    ctx.log('ERROR', 'bus-group-failed', { evaluationDate: E, reason, blocking });
    record.errors = (record.errors ?? 0) + (blocking ? 0 : 1);
    for (const key of pending) if (!SETTLED.includes(record.members[key]?.status ?? '')) record.members[key] = { status: blocking ? 'blocked' : 'failed', reason };
    if (blocking || record.errors >= MAX_ATTEMPT_ERRORS) record.status = 'closed';
    return record;
  } finally {
    await pushJournals(ctx).catch(() => undefined);
    await saveAttempt(ctx, attemptPath, record);
  }
}

async function publicBusMember(ctx: RunContext, a: { candidate: string; work: string; contextJsonl: string; priors: string; report: string; sources: string; incumbent: string | null; E: string; inputsSha256: string }): Promise<MemberOutcome> {
  if (!a.incumbent) return { status: 'blocked', reason: 'no-incumbent-to-compare' };
  if (!publicBusReproducible(a.E, ctx.now())) return { status: 'closed', reason: 'evaluation-day-older-than-7-days' };
  const directory = resolve(a.work, 'publicBus'); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
  const active = resolve(directory, 'active.json'); await writeFile(active, a.incumbent);
  // refresh-public-bus-model replaces --active in place after every check; here --active is a staging copy, never the served file.
  const result = await node(ctx, 'refresh-public-bus', 'refresh-public-bus-model.ts', ['--input', a.contextJsonl, '--road-priors', a.priors, '--report', a.report, '--active', active, '--source-manifests', a.sources, '--execute'], 30 * MINUTE)
    .finally(() => pushJournals(ctx));
  const json = result.json as { status?: string; reasons?: string[]; comparison?: unknown } | null;
  if (result.code !== 0 || json?.status !== 'activated') return { status: 'closed', reason: `gate:${(json?.reasons ?? [failure('refresh-public-bus', result)]).join('+')}`, details: { comparison: json?.comparison ?? null } };
  return promoteMember(ctx, 'publicBus', await readFile(active, 'utf8'), a.E, { publicBusRefresh: 'verified', comparison: json.comparison });
}

async function spatialBusMember(ctx: RunContext, a: { candidate: string; work: string; contextJsonl: string; report: string; window: ReturnType<typeof trainingWindow>; incumbent: string | null; publicBusIncumbent: string | null; E: string; inputsSha256: string }): Promise<MemberOutcome> {
  const experiment = resolve(a.work, 'spatialBus-experiment'), stored = resolve(a.candidate, 'spatialBus-experiment');
  // The spatial gate needs an old public bus model to beat. When the same-window public bus candidate was refused its report carries no
  // model; the public bus model in service stands in for it (the protocol records which one was used).
  const extra: string[] = [];
  let publicBus = a.report;
  if (!(await readJson<{ model?: unknown }>(a.report))?.model) {
    if (!a.publicBusIncumbent) return { status: 'closed', reason: 'gate:no-public-bus-reference' };
    const served = resolve(a.work, 'public-bus-served.json'); await writeFile(served, a.publicBusIncumbent); extra.push('--fallback-reference', served); publicBus = served;
  }
  const trained = await trainOnce(ctx, a.candidate, 'train-spatial-bus', a.inputsSha256, experiment, stored, () => python(ctx, 'train-spatial-bus', 'train-spatial-bus-v3.py',
    ['--phase', 'refresh', '--window', a.window.spatialBusWindow, '--input', a.contextJsonl, '--reference-report', a.report, ...extra, '--output-directory', experiment, '--execute']));
  const keep = (outcome: MemberOutcome, comparison: IncumbentComparison | null) => keepIncumbent(ctx, 'spatialBus', a.incumbent, a.E, outcome, comparison,
    () => incumbentGate(ctx, 'spatialBus', a.incumbent!, a.E, a.work, ['--input', a.contextJsonl, '--public-bus', publicBus], output => writeSpatialBusPredictions(a.incumbent!, a.contextJsonl, a.E, output)));
  if (trained) return trained.reason === 'gate:quality-failed' ? keep(trained, null) : trained;
  const output = resolve(a.work, 'spatialBus', 'checkpoint.json'); await rm(dirname(output), { recursive: true, force: true }); await mkdir(dirname(output), { recursive: true });
  const promoted = await node(ctx, 'promote-spatial-bus', 'promote-spatial-bus.ts', ['--experiment', experiment, '--output', output]);
  if (promoted.code !== 0 || !existsSync(output)) return { status: 'closed', reason: `gate:${failure('promote-spatial-bus', promoted)}` };
  const text = await readFile(output, 'utf8'), comparison = await compareSpatialBus(text, a.incumbent, a.contextJsonl, a.E);
  ctx.log('INFO', 'incumbent-comparison', { model: 'spatialBus', ...comparison });
  if (!comparison.passed) return keep({ status: 'closed', reason: `gate:${comparison.reason}`, details: { comparison } }, comparison);
  return withReference(ctx, 'spatialBus', text, ['--input', a.contextJsonl, '--window', a.window.spatialBusWindow], await promoteMember(ctx, 'spatialBus', text, a.E, { quality: 'passed', parity: promoted.json, incumbent: comparison }));
}

async function railGateMember(ctx: RunContext, a: { candidate: string; work: string; zipPaths: string[]; referencePaths: string[]; stations: string; window: ReturnType<typeof trainingWindow>; incumbent: string | null; E: string; inputsSha256: string }): Promise<MemberOutcome> {
  const railJsonl = resolve(a.work, 'rail.jsonl'), chains = resolve(a.work, 'chains.jsonl');
  const prepared = await stage(ctx, a.candidate, 'prepare-rail', a.inputsSha256, [railJsonl, `${railJsonl}.manifest.json`], async () => {
    for (const path of [railJsonl, chains, `${railJsonl}.manifest.json`, `${chains}.manifest.json`]) await rm(path, { force: true });
    const policy = ctx.routeTablePolicy === 'nearest-consistent' ? ['--route-table-policy', 'nearest-consistent', ...a.referencePaths.flatMap(path => ['--route-table-reference', path])] : [];
    const result = await python(ctx, 'prepare-rail', 'prepare-public-rail-journeys.py', [...a.zipPaths.flatMap(path => ['--input', path]), '--rail-output', railJsonl, '--journey-output', chains, ...policy, '--workers', '2', '--execute']);
    if (result.code !== 0) throw new Error(failure('prepare-rail', result));
    const manifest = JSON.parse(await readFile(`${railJsonl}.manifest.json`, 'utf8'));
    const perDay = Object.fromEntries((manifest.archives as { sourceDate: string; counts?: Record<string, number>; railRows?: number }[]).map(archive => [archive.sourceDate, archive.railRows ?? archive.counts?.railRows ?? null]));
    await rm(chains, { force: true });
    return { railRows: manifest.railRows as number, perDay, routeNumberFallbacks: manifest.routeNumberFallbacks ?? [] };
  }).catch(error => ({ error: errorMessage(error) }));
  if ('error' in prepared) return { status: 'failed', reason: prepared.error };
  if (prepared.railRows < MIN_RAIL_ROWS_PER_DAY * a.window.dates.length / 2) return { status: 'blocked', reason: `rail-rows-below-floor:${prepared.railRows}` };
  const experiment = resolve(a.work, 'railGate-experiment'), stored = resolve(a.candidate, 'railGate-experiment');
  const trained = await trainOnce(ctx, a.candidate, 'train-rail-gate', a.inputsSha256, experiment, stored, () => python(ctx, 'train-rail-gate', 'train-rail-gate.py',
    ['--phase', 'refresh', '--window', a.window.railGateWindow, '--input', railJsonl, '--stations', a.stations, '--output-directory', experiment, '--lower-coverage', '.92', '--upper-coverage', '.93', '--execute']));
  const keep = (outcome: MemberOutcome, comparison: IncumbentComparison | null) => keepIncumbent(ctx, 'railGate', a.incumbent, a.E, outcome, comparison,
    () => incumbentGate(ctx, 'railGate', a.incumbent!, a.E, a.work, ['--input', railJsonl, '--stations', a.stations], output => writeRailGatePredictions(a.incumbent!, railJsonl, a.stations, a.E, output)));
  if (trained) return trained.reason === 'gate:quality-failed' ? keep(trained, null) : trained;
  const output = resolve(a.work, 'railGate', 'checkpoint.json'); await rm(dirname(output), { recursive: true, force: true }); await mkdir(dirname(output), { recursive: true });
  const promoted = await node(ctx, 'promote-rail-gate', 'promote-rail-gate.ts', ['--experiment', experiment, '--output', output]);
  if (promoted.code !== 0 || !existsSync(output)) return { status: 'closed', reason: `gate:${failure('promote-rail-gate', promoted)}` };
  const text = await readFile(output, 'utf8'), comparison = await compareRailGate(text, a.incumbent, railJsonl, a.stations, a.E);
  ctx.log('INFO', 'incumbent-comparison', { model: 'railGate', ...comparison });
  if (!comparison.passed) return keep({ status: 'closed', reason: `gate:${comparison.reason}`, details: { comparison } }, comparison);
  return withReference(ctx, 'railGate', text, ['--input', railJsonl, '--stations', a.stations, '--window', a.window.railGateWindow], await promoteMember(ctx, 'railGate', text, a.E, { quality: 'passed', parity: promoted.json, incumbent: comparison }));
}

/**
 * The trainers write the evaluation day before fitting. A finished experiment is copied to the store and reused;
 * a crash mid-fit reruns the identical protocol (the trainer's journal accepts the same protocol hash only).
 */
async function trainOnce(ctx: RunContext, candidate: string, name: string, inputsSha256: string, experiment: string, stored: string, run: () => Promise<StepResult>): Promise<MemberOutcome | null> {
  const done = await readJson<StageRecord>(resolve(candidate, `stage-${name}.json`));
  if (done?.inputsSha256 === inputsSha256 && existsSync(resolve(stored, 'model.json'))) {
    if (!existsSync(experiment)) await copyTree(stored, experiment);
    ctx.log('INFO', 'stage-reused', { stage: name });
    return (done.result as { quality?: string })?.quality === 'failed' ? { status: 'closed', reason: 'gate:quality-failed' } : null;
  }
  await rm(experiment, { recursive: true, force: true });
  const result = await run().finally(() => pushJournals(ctx));
  const report = await readJson<{ qualityPassed?: boolean; qualityFailedGroups?: string[] }>(resolve(experiment, 'report.json'));
  // No report: either a rule of the protocol refused (final) or the script crashed (a code or environment error, retried, never a closed day).
  if (result.code !== 0 && !report) return { status: refusedByRule(result) ? 'closed' : 'failed', reason: failure(name, result) };
  await rm(stored, { recursive: true, force: true }); await copyTree(experiment, stored);
  const quality = report?.qualityPassed === true ? 'passed' : 'failed';
  await writeJsonAtomic(resolve(candidate, `stage-${name}.json`), { name, inputsSha256, outputs: {}, result: { quality, failedGroups: report?.qualityFailedGroups?.slice(0, 20) ?? [] }, finishedAt: ctx.now(), runId: ctx.runId }, ctx.runId);
  return quality === 'failed' ? { status: 'closed', reason: 'gate:quality-failed', details: { failedGroups: report?.qualityFailedGroups?.slice(0, 20) } } : null;
}

/** What the gate needs later and the checkpoint does not carry (OD groups seen in training, the subway ridge), keyed by the served bytes. */
export const referencePath = (store: Store, key: ModelKey, sha256: string) => store.path('references', key, `${sha256}.json`);
const GATE_SCRIPT = 'model-refresh/incumbent-gate.py';

/**
 * Right after a promotion: rebuild the training split of that model from the same inputs and keep its reference in the store.
 * A failure here never undoes the promotion; that model just cannot be re-validated later (the outcome says so).
 */
export async function withReference(ctx: RunContext, key: 'spatialBus' | 'railGate', text: string, args: string[], outcome: MemberOutcome): Promise<MemberOutcome> {
  if (outcome.status !== 'promoted') return outcome;
  const sha256 = sha256Text(text), target = referencePath(ctx.store, key, sha256);
  let reference = 'kept';
  if (!existsSync(target)) {
    const directory = resolve(ctx.workDir, 'references', key); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
    const checkpoint = resolve(directory, 'checkpoint.json'), output = resolve(directory, 'reference.json'); await writeFile(checkpoint, text);
    const result = await python(ctx, `${key}-reference`, GATE_SCRIPT, ['reference', '--model', key, '--checkpoint', checkpoint, ...args, '--output', output], 30 * MINUTE);
    if (result.code === 0 && existsSync(output)) { await writeAtomic(target, await readFile(output), ctx.runId); reference = 'written'; }
    else { reference = failure(`${key}-reference`, result); ctx.log('WARNING', 'incumbent-reference-missing', { model: key, sha256, reason: reference }); }
  }
  return { ...outcome, details: { ...outcome.details, reference } };
}

/** The model in service alone on the fresh day: served predictions for every row, scored by the trainers' promotion gate. */
export async function incumbentGate(ctx: RunContext, key: 'spatialBus' | 'railGate', incumbentText: string, evaluationDate: string, work: string, args: string[],
  predict: (output: string) => Promise<{ rows: number; predicted: number }>): Promise<IncumbentGate> {
  const reference = referencePath(ctx.store, key, sha256Text(incumbentText)), refused = (reason: string): IncumbentGate => ({ passed: false, failed: [reason], rows: 0, evaluationDate });
  if (!existsSync(reference)) return refused('reference-missing');
  const directory = resolve(work, `${key}-incumbent-gate`); await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true });
  const checkpoint = resolve(directory, 'checkpoint.json'), predictions = resolve(directory, 'predictions.jsonl'), output = resolve(directory, 'gate.json'), copy = resolve(directory, 'reference.json');
  await writeFile(checkpoint, incumbentText); await stageFile(reference, copy);
  if ((await predict(predictions)).rows === 0) return refused('no-rows-on-evaluation-day');
  const result = await python(ctx, `${key}-incumbent-gate`, GATE_SCRIPT, ['gate', '--model', key, '--checkpoint', checkpoint, '--reference', copy, ...args,
    '--predictions', predictions, '--evaluation-date', evaluationDate, '--output', output], 30 * MINUTE);
  const body = result.code === 0 ? await readJson<{ passed?: boolean; failedGroups?: string[]; rows?: number; evaluations?: IncumbentGate['evaluations'] }>(output) : null;
  if (!body || !Array.isArray(body.failedGroups)) return refused(`gate-not-run:${failure(`${key}-incumbent-gate`, result)}`);
  return { passed: body.passed === true && body.failedGroups.length === 0, failed: body.failedGroups, rows: body.rows ?? 0, evaluationDate, evaluations: body.evaluations };
}

/**
 * The candidate did not replace the model in service. If that model, measured alone on this fresh evaluation day, still passes every
 * group of the promotion gate, its expiry is extended through the manifest (the file and its sha256 stay) so the service does not fall
 * back to provider times while a better model is still being waited for. Otherwise the candidate's closed outcome stands, with the
 * failing groups in its details.
 */
export async function keepIncumbent(ctx: RunContext, key: ModelKey, incumbentText: string | null, evaluationDate: string, lost: MemberOutcome, comparison: IncumbentComparison | null,
  measure: () => Promise<IncumbentGate>): Promise<MemberOutcome> {
  if (!incumbentText) return lost;
  try {
    const gate = await measure(), evidence = { candidateLost: lost.reason, comparison: summarize(comparison), incumbentGate: gate };
    if (!gate.passed) {
      ctx.log('WARNING', 'incumbent-not-revalidated', { model: key, evaluationDate, failed: gate.failed });
      return { ...lost, details: { ...lost.details, ...evidence, comparison: comparison ?? undefined } };
    }
    const result = await revalidate(ctx.store, key, { runId: ctx.runId, now: ctx.now(), evaluationDate, sha256: sha256Text(incumbentText), candidate: lost.reason, evidence });
    const { clippedBy = null, calendarLastDate = null } = result.record;
    ctx.log('NOTICE', 'model-revalidated', { model: key, version: result.entry.version, sha256: result.entry.sha256, previousExpiresAt: result.record.previousExpiresAt, expiresAt: result.entry.expiresAt, clippedBy, calendarLastDate,
      generation: result.manifest.generation, evaluationDate, candidateLost: lost.reason });
    return { status: 'revalidated', reason: lost.reason, details: { sha256: result.entry.sha256, previousExpiresAt: result.record.previousExpiresAt, expiresAt: result.entry.expiresAt, clippedBy, calendarLastDate,
      generation: result.manifest.generation, revalidationCount: result.entry.revalidationCount, evaluationDate, incumbentGate: gate, comparison: summarize(comparison) } };
  } catch (error) {
    ctx.log('WARNING', 'incumbent-revalidation-refused', { model: key, evaluationDate, reason: errorMessage(error) });
    return { ...lost, reason: `${lost.reason}+revalidation-refused:${errorMessage(error)}`.slice(0, 240) };
  }
}
const summarize = (comparison: IncumbentComparison | null) => comparison ? { reason: comparison.reason, commonRows: comparison.commonRows, candidate: comparison.candidate, incumbent: comparison.incumbent } : null;

async function promoteMember(ctx: RunContext, key: ModelKey, text: string, evaluationDate: string | null, gates: Record<string, unknown>): Promise<MemberOutcome> {
  try {
    const result = await promote(ctx.store, key, text, { runId: ctx.runId, now: ctx.now(), evaluationDate, gates: { passed: true, ...gates } });
    ctx.log('NOTICE', 'model-promoted', { model: key, version: result.object.parsed.version, sha256: result.object.sha256, expiresAt: result.object.parsed.expiresAt, generation: result.manifest.generation, changed: result.changed });
    return { status: 'promoted', reason: result.changed ? 'promoted' : 'already-active', details: { sha256: result.object.sha256, expiresAt: result.object.parsed.expiresAt, generation: result.manifest.generation } };
  } catch (error) { return { status: 'failed', reason: `promote:${errorMessage(error)}` }; }
}

/** 따릉이: no new monthly data since 2026-06; its expiry follows the holiday calendar, so it is re-promoted from the seed experiment. */
export function bicycleDue(manifest: Manifest | null, now: number, forced: boolean) {
  const entry = manifest?.models.bicycleRide, year = kstDate(now).slice(0, 4), calendar = manifest?.calendars[year];
  const reviewAfter = calendar ? Date.parse(calendar.reviewAfter) : null, expiresAt = entry?.expiresAt ?? null;
  const remainingDays = expiresAt === null ? null : (expiresAt - now) / DAY;
  if (!calendar || reviewAfter === null) return { due: false, reason: 'holiday-calendar-missing', reviewAfter: null, expiresAt, remainingDays };
  if (expiresAt !== null && reviewAfter <= expiresAt) return { due: false, reason: 'calendar-not-extended', reviewAfter, expiresAt, remainingDays };
  if (!forced && remainingDays !== null && remainingDays >= 10) return { due: false, reason: 'not-yet-due', reviewAfter, expiresAt, remainingDays };
  return { due: true, reason: forced ? 'requested' : 'calendar-extended', reviewAfter, expiresAt, remainingDays };
}

export async function attemptBicycle(ctx: RunContext): Promise<MemberOutcome> {
  const seed = resolve(ctx.store.seed, 'spatial-bicycle-v2-final');
  if (!existsSync(resolve(seed, 'model.json'))) return { status: 'blocked', reason: 'bicycle-seed-missing' };
  const experiment = data(ctx, 'bicycle', 'spatial-bicycle-v2-final');
  for (const name of ['protocol.json', 'model.json', 'report.json', 'parity.json']) await stageFile(resolve(seed, name), resolve(experiment, name));
  const output = data(ctx, 'bicycle', 'checkpoint', 'spatial-bicycle-operational.json');
  await rm(dirname(output), { recursive: true, force: true }); await mkdir(dirname(output), { recursive: true });
  const result = await node(ctx, 'promote-spatial-bicycle', 'promote-spatial-bicycle.ts', ['--experiment', experiment, '--output', output]);
  if (result.code !== 0 || !existsSync(output)) return { status: 'failed', reason: failure('promote-spatial-bicycle', result) };
  return promoteMember(ctx, 'bicycleRide', await readFile(output, 'utf8'), null, { reason: 'holiday-calendar-extended', parity: result.json, retrained: false });
}
