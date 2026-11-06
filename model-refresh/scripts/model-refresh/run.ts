import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { effectiveExpiry, readManifest, writeManifest, type Manifest } from './manifest';
import { materializeCalendars, refreshHolidayCalendars, type FetchLike, type HolidayRefreshResult } from './holidays';
import { attemptBicycle, attemptBusGroup, bicycleDue, openAttemptDates, pullJournals, retryCalendarExtension, usedEvaluationDates, type AttemptRecord, type MemberOutcome, type RunContext } from './pipelines';
import { chooseEvaluationDate, nextScheduledAt, planRouteTables, publicBusReproducible, SCHEDULE, trainingWindow, weeklyTiming, ALERT_REMAINING_HOURS, BICYCLE_RENEW_DAYS } from './schedule';
import { acquireLock, heartbeat, HEARTBEAT_MS, MODEL_KEYS, releaseLock, Store, type ModelKey } from './store';
import { downloadArchive, fetchCatalog, headBytes, pruneArchives, readTaimsIndex, writeTaimsIndex, MEMBER_RULE, RETAIN_SERVICE_DAYS, type CatalogEntry, type TaimsIndex } from './taims';
import { createLogger, DAY, errorMessage, HOUR, kstIso, readJson, writeAtomic, writeJsonAtomic, type Logger } from './util';
import type { StepRunner } from './process';

export const STATUS_SCHEMA = 'jigak-refresh-status-v1' as const;
const WEEKLY: ModelKey[] = ['publicBus', 'spatialBus', 'railGate'];
export interface ModelStatus {
  version: string | null; expiresAt: number | null; refreshOpensAt: number | null; nextAttemptAt: number | null; consecutiveFailures: number;
  lastFailureReason: string | null; lastPromotedAt: number | null; lastAttemptAt: number | null; state: 'ok' | 'due' | 'blocked' | 'failed' | 'expired' | 'skipped';
  lastAttempt: { evaluationDate: string | null; outcome: string; reason: string; at: number; runId: string; details?: Record<string, unknown> } | null;
}
export interface RefreshStatus {
  schema: typeof STATUS_SCHEMA; updatedAt: string; runId: string; startedAt: number; finishedAt: number; outcome: RunOutcome; exitCode: number; mode: 'local' | 'cloud'; schedule: { cron: string; timeZone: string }; nextScheduledAt: number;
  lastRun: { runId: string; startedAt: number; finishedAt: number; outcome: RunOutcome; exitCode: number };
  lastSuccessfulRunAt: number | null; models: Partial<Record<ModelKey | 'hgb' | 'contextual' | 'journey', ModelStatus>>;
  calendars: Record<string, { reviewAfter: string; source: string }>; alerts: string[]; notices: string[];
}
export type RunOutcome = 'promoted' | 'revalidated' | 'noop' | 'partial' | 'alert' | 'skipped-locked' | 'crash' | 'plan';
export const exitCodeOf = (outcome: RunOutcome) => outcome === 'crash' ? 1 : outcome === 'alert' ? 2 : outcome === 'partial' ? 3 : 0;
export interface RefreshOptions {
  storeRoot: string; runId?: string; plan?: boolean; only?: ModelKey[]; mode?: 'local' | 'cloud'; maxDownloadBytes?: number; now?: () => number;
  projectDir: string; workBase: string; python?: string; routeTablePolicy?: 'strict' | 'nearest-consistent'; workers?: number;
  fetchImpl?: typeof fetch; runner?: StepRunner; log?: Logger; env?: NodeJS.ProcessEnv; serviceKey?: string; skipDownloads?: boolean; skipHolidays?: boolean;
  /** Debugging: leave the run's work folder (prepared rows, trainer output) in place instead of deleting it. */
  keepWorkDir?: boolean;
}
export interface RefreshReport {
  runId: string; mode: 'local' | 'cloud'; plan: boolean; outcome: RunOutcome; exitCode: number; startedAt: number; finishedAt: number;
  holidays: HolidayRefreshResult | null; taims: { latestPublished: string | null; downloaded: string[]; downloadBytes: number; plannedDownloads: { name: string; bytes: number }[]; problems: string[]; pruned: string[] };
  models: Record<string, { due: boolean; action: string; outcome?: MemberOutcome; details?: Record<string, unknown> }>;
  busGroup: { evaluationDate: string | null; reason?: string; considered?: unknown; attempt?: AttemptRecord | null; routeTables?: unknown } | null;
  alerts: string[]; notices: string[]; generationBefore: number; generationAfter: number;
}

const DEFAULT_DOWNLOAD = { local: 3 * 1024 ** 3, cloud: 10 * 1024 ** 3 };
export const runIdNow = (now = Date.now()) => `${kstIso(now).slice(0, 16).replace(/[-:]/g, '')}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * One refresh: lock → sync → holidays → discover/acquire → due → per-model attempts → report/status → retention → unlock.
 * --plan reads (catalog GET, HEAD) and writes nothing to the store.
 */
export async function runRefresh(options: RefreshOptions): Promise<RefreshReport> {
  const now = options.now ?? Date.now, startedAt = now(), runId = options.runId ?? runIdNow(startedAt), mode = options.mode ?? 'local', plan = !!options.plan;
  const log = options.log ?? createLogger(runId), fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(options.storeRoot, { recursive: true });
  const store = new Store(await realpath(options.storeRoot));
  const report: RefreshReport = { runId, mode, plan, outcome: 'noop', exitCode: 0, startedAt, finishedAt: startedAt, holidays: null,
    taims: { latestPublished: null, downloaded: [], downloadBytes: 0, plannedDownloads: [], problems: [], pruned: [] }, models: {}, busGroup: null, alerts: [], notices: [], generationBefore: 0, generationAfter: 0 };
  let locked = false, beat: NodeJS.Timeout | undefined;
  const workDir = resolve(options.workBase, runId);
  try {
    if (!plan) {
      const lock = await acquireLock(store, runId, startedAt);
      if (!lock.acquired) { report.outcome = 'skipped-locked'; log('NOTICE', 'model-refresh-skipped-locked', { holder: lock.holder?.runId ?? null }); return finish(report, now, log); }
      locked = true; if (lock.tookOverFrom) log('WARNING', 'lock-taken-over', { from: lock.tookOverFrom });
      beat = setInterval(() => { void heartbeat(store, runId).catch(() => undefined); }, HEARTBEAT_MS); beat.unref();
    }
    let manifest = await readManifest(store);
    if (!manifest) throw new Error('manifest-missing: run models:store:init first');
    report.generationBefore = manifest.generation;
    await mkdir(workDir, { recursive: true });
    const ctx: RunContext = { store, runId, now, mode, plan, log, projectDir: options.projectDir, workDir: await realpath(workDir), holidayDir: resolve(await realpath(workDir), 'holidays'),
      python: options.python ?? process.env.PYTHON ?? 'python3', routeTablePolicy: options.routeTablePolicy ?? 'nearest-consistent', runner: options.runner ?? (await import('./process')).spawnRunner,
      env: options.env ?? process.env, workers: options.workers ?? (mode === 'cloud' ? 2 : 4) };
    const wants = (key: ModelKey) => !options.only || options.only.includes(key);

    // Holidays first: every trainer and promoter checks the calendar review deadline.
    if (!options.skipHolidays) {
      report.holidays = await refreshHolidayCalendars(store, manifest, { now: now(), fetchImpl: fetchImpl as FetchLike, key: options.serviceKey, plan, log, runId });
      report.alerts.push(...report.holidays.alerts); report.notices.push(...report.holidays.notices);
      if (report.holidays.changed && !plan) manifest = await writeManifest(store, manifest, { runId, models: manifest.models, calendars: report.holidays.calendars }, now());
    }
    const calendars = report.holidays?.calendars ?? manifest.calendars;
    if (!plan) await materializeCalendars(store, calendars, ctx.holidayDir);

    // 따릉이: re-promotion only, no download.
    if (wants('bicycleRide')) {
      const due = bicycleDue({ ...manifest, calendars }, now(), !!options.only?.includes('bicycleRide'));
      report.models.bicycleRide = { due: due.due, action: due.due ? (plan ? 'would-repromote' : 'repromote') : `skip:${due.reason}`, details: due };
      if (due.due && !plan) report.models.bicycleRide.outcome = await attemptBicycle(ctx);
    }

    // Weekly models: TAIMS discovery and acquisition, then one evaluation day for the group.
    const weekly = WEEKLY.filter(wants);
    // The expiry in force, not only what the manifest says: an entry extended past its file's holiday calendar ends with the calendar.
    const timings = Object.fromEntries(await Promise.all(WEEKLY.map(async key => [key, weeklyTiming(key, await effectiveExpiry(store, manifest!.models[key]), now())] as const)));
    const groupDue = weekly.some(key => timings[key].due);
    for (const key of weekly) report.models[key] = { due: timings[key].due, action: timings[key].due ? 'pending' : 'skip:not-yet-due', details: { ...timings[key] } };
    if (groupDue) {
      const index = await readTaimsIndex(store);
      const catalog = options.skipDownloads ? null : await fetchCatalog(fetchImpl).catch(error => { report.taims.problems.push(`catalog:${errorMessage(error)}`); return null; });
      if (catalog) await acquire(ctx, report, index, catalog, options.maxDownloadBytes ?? DEFAULT_DOWNLOAD[mode], fetchImpl);
      const used = await usedEvaluationDates(store), closed = await closedDates(store), resumable = await openAttemptDates(store);
      const members = weekly.filter(key => timings[key].due || !!manifest!.models[key]);
      const usedForGroup = new Set([...used.spatialBus, ...used.railGate, ...used.publicBus]);
      // The newest day not yet used by any group member; members whose day already advanced past it are left out by the trainers' journals.
      const choice = chooseEvaluationDate({ index, now: now(), incumbentDates: members.map(key => manifest!.models[key]?.evaluationDate ?? null).filter(Boolean).sort().slice(0, 1),
        usedDates: usedForGroup, closedDates: closed, resumableDates: resumable, policy: ctx.routeTablePolicy, latestPublished: report.taims.latestPublished });
      report.busGroup = { evaluationDate: choice.evaluationDate, reason: choice.reason, considered: choice.considered };
      if (choice.evaluationDate) {
        const E = choice.evaluationDate;
        report.busGroup.routeTables = planRouteTables(index, trainingWindow(E).dates, ctx.routeTablePolicy);
        // A member whose incumbent already evaluated on E or later gains nothing from this day.
        const advancing = members.filter(key => (manifest!.models[key]?.evaluationDate ?? '') < E);
        for (const key of members) report.models[key].action = !advancing.includes(key) ? `skip:incumbent-evaluated-${manifest!.models[key]?.evaluationDate}` : plan ? `would-train:${E}` : `train:${E}`;
        if (advancing.includes('publicBus') && !publicBusReproducible(E, now())) report.notices.push(`publicBus-evaluation-day-too-old:${E}`);
        if (!plan) {
          await pullJournals(ctx);
          const attempt = await attemptBusGroup(ctx, { evaluationDate: E, index, members: advancing, fetchImpl });
          report.busGroup.attempt = attempt;
          for (const key of members) if (attempt.members[key]) report.models[key].outcome = attempt.members[key];
        }
      } else for (const key of weekly) if (timings[key].due) report.models[key].action = `blocked:${choice.reason}`;
      if (!plan) { report.taims.pruned = await pruneArchives(store, index, RETAIN_SERVICE_DAYS); await writeTaimsIndex(store, index, runId); }
    }
    // An extension an earlier day earned but the holiday slice in the file refused: finish it now that the calendar reaches further.
    if (!plan) for (const key of ['railGate', 'spatialBus'] as const) {
      // Not after this run's own verdict on a new day (retryCalendarExtension also reads the attempt this run just saved).
      if (!wants(key) || ['promoted', 'revalidated', 'closed'].includes(report.models[key]?.outcome?.status ?? '')) continue;
      const retried = await retryCalendarExtension(ctx, key);
      if (retried) report.models[key] = { ...(report.models[key] ?? { due: true, action: 'calendar-extension' }), outcome: retried };
    }
    for (const key of ['hgb', 'contextual', 'journey']) report.models[key] = { due: false, action: 'skipped:no-data', details: { note: key === 'hgb' ? 'no trip records' : 'retrained inside the server when consented trips arrive' } };

    // Alerts: a weekly model within 48 h (or expired) that this run did not refresh.
    const after = await readManifest(store) ?? manifest;
    for (const key of [...WEEKLY, 'bicycleRide'] as ModelKey[]) {
      const expiresAt = await effectiveExpiry(store, after.models[key]); if (!expiresAt) continue;
      const remaining = (expiresAt - now()) / HOUR, promoted = ['promoted', 'revalidated'].includes(report.models[key]?.outcome?.status ?? '');
      if (remaining <= 0) report.alerts.push(`model-expired:${key}`);
      else if (remaining < ALERT_REMAINING_HOURS && !promoted) report.alerts.push(`model-expiring-without-refresh:${key}:${Math.floor(remaining)}h`);
    }
    report.generationAfter = after.generation;
    const outcomes = Object.values(report.models).map(model => model.outcome?.status).filter(Boolean);
    report.outcome = plan ? 'plan' : report.alerts.length ? 'alert' : outcomes.some(status => status === 'failed' || status === 'closed' || status === 'blocked') ? 'partial'
      : outcomes.includes('promoted') ? 'promoted' : outcomes.includes('revalidated') ? 'revalidated' : after.generation > report.generationBefore ? 'promoted' : 'noop';
    if (!plan) { await writeStatus(store, report, after, now()); await retain(store, after, now(), log); }
    return finish(report, now, log);
  } catch (error) {
    report.outcome = 'crash'; report.alerts.push(`crash:${errorMessage(error)}`);
    log('ERROR', 'model-refresh-crashed', { reason: errorMessage(error) });
    if (locked) await writeStatus(store, report, await readManifest(store).catch(() => null), now()).catch(() => undefined);
    return finish(report, now, log);
  } finally {
    if (beat) clearInterval(beat);
    if (locked) await releaseLock(store, runId).catch(() => undefined);
    if (options.keepWorkDir) log('NOTICE', 'work-dir-kept', { path: workDir }); else await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function finish(report: RefreshReport, now: () => number, log: Logger): RefreshReport {
  report.finishedAt = now();
  report.exitCode = exitCodeOf(report.outcome);
  if (report.outcome === 'alert') log('ALERT', 'model-refresh-alert', { alerts: report.alerts });
  log(report.exitCode === 0 ? 'NOTICE' : 'WARNING', 'model-refresh-finished', { outcome: report.outcome, exitCode: report.exitCode, ms: report.finishedAt - report.startedAt,
    generationBefore: report.generationBefore, generationAfter: report.generationAfter });
  return report;
}

async function closedDates(store: Store): Promise<Set<string>> {
  const directory = store.path('candidates', 'bus'), dates = new Set<string>();
  if (!existsSync(directory)) return dates;
  for (const date of await readdir(directory)) {
    const attempt = await readJson<AttemptRecord>(resolve(directory, date, 'attempt.json'));
    if (attempt && attempt.status !== 'open') dates.add(date);
  }
  return dates;
}

/** Missing days of the last 18 service days, newest first, under the per-run byte cap. Changed Content-Length → download again. */
async function acquire(ctx: RunContext, report: RefreshReport, index: TaimsIndex, catalog: CatalogEntry[], cap: number, fetchImpl: typeof fetch) {
  const recent = catalog.slice(-RETAIN_SERVICE_DAYS).reverse();
  report.taims.latestPublished = recent[0]?.serviceDate ?? null;
  // Recheck the six newest receipted archives: T-DATA has replaced a truncated file with a complete one under the same name.
  for (const entry of recent.slice(0, 6)) {
    const known = index.archives[entry.name]; if (!known) continue;
    try { const bytes = await headBytes(entry.url, fetchImpl); known.lastHeadBytes = bytes; if (bytes !== known.bytes) { report.notices.push(`taims-size-changed:${entry.name}`); if (!ctx.plan) delete index.archives[entry.name]; } }
    catch (error) { report.taims.problems.push(`head:${entry.name}:${errorMessage(error)}`); }
  }
  let budget = cap;
  for (const entry of recent) {
    if (index.archives[entry.name]?.zipOk) continue;
    let bytes: number;
    try { bytes = await headBytes(entry.url, fetchImpl); } catch (error) { report.taims.problems.push(`head:${entry.name}:${errorMessage(error)}`); continue; }
    // An archive refused for its members is not fetched again until T-DATA publishes a different size, unless an older member
    // rule refused it: TAIMS_20261106 was refused under rule 1 for lacking the station table that rule 2 no longer requires.
    const refused = index.archives[entry.name];
    if (refused?.zipOk === false && refused.lastHeadBytes === bytes && (refused.memberRule ?? 1) === MEMBER_RULE) continue;
    if (bytes > budget) { report.notices.push(`download-cap-reached:${entry.name}`); break; }
    budget -= bytes; report.taims.plannedDownloads.push({ name: entry.name, bytes });
    if (ctx.plan) continue;
    try {
      const downloaded = await downloadArchive(ctx.store, entry, bytes, { fetchImpl, log: ctx.log });
      index.archives[entry.name] = downloaded; report.taims.downloaded.push(entry.name); report.taims.downloadBytes += bytes;
      await writeTaimsIndex(ctx.store, index, ctx.runId);
      ctx.log('INFO', 'taims-downloaded', { archive: entry.name, bytes, hasRouteTable: downloaded.hasRouteTable, hasStationTable: downloaded.hasStationTable, serviceDate: downloaded.serviceDate });
    } catch (error) {
      const reason = errorMessage(error);
      report.taims.problems.push(`download:${entry.name}:${reason}`); ctx.log('WARNING', 'taims-download-failed', { archive: entry.name, reason });
      if (/invalid-official-archive-members|zip-/.test(reason)) {
        index.archives[entry.name] = { name: entry.name, id: entry.id, url: entry.url, serviceDate: entry.serviceDate, serviceDateRule: 'publication-minus-4', bytes, sha256: '', zipOk: false, hasRouteTable: false, hasStationTable: false, members: [], downloadedAt: new Date().toISOString(), lastHeadBytes: bytes, source: 'download', memberRule: MEMBER_RULE };
        await writeTaimsIndex(ctx.store, index, ctx.runId);
      }
    }
  }
}

/**
 * refresh-status.json: what the server shows under modelRefresh. Times are epoch milliseconds.
 * consecutiveFailures counts runs in which a due model was not refreshed (blocked, failed or still waiting); 0 after a
 * promotion or while the model is not due. The server marks health degraded when < 48 h remain and this is > 0.
 */
export async function writeStatus(store: Store, report: RefreshReport, manifest: Manifest | null, now: number) {
  const previous = await readJson<RefreshStatus>(store.status);
  const nextRun = nextScheduledAt(now), models: RefreshStatus['models'] = {};
  for (const key of MODEL_KEYS) {
    const entry = manifest?.models[key], before = previous?.models[key], result = report.models[key], expiresAt = await effectiveExpiry(store, entry);
    if (key === 'bicycleRideTimes') { models[key] = { version: entry?.version ?? null, expiresAt: null, refreshOpensAt: null, nextAttemptAt: null, consecutiveFailures: 0, lastFailureReason: null, lastPromotedAt: entry?.promotedAt ?? null, lastAttemptAt: null, state: 'ok', lastAttempt: null }; continue; }
    const weekly = WEEKLY.includes(key), opens = weekly ? weeklyTiming(key, expiresAt, now).refreshOpensAt : expiresAt ? expiresAt - BICYCLE_RENEW_DAYS * DAY : null;
    const expired = !entry || !!expiresAt && expiresAt <= now, due = expired || opens !== null && now >= opens;
    const outcome = result?.outcome, promoted = outcome?.status === 'promoted' || outcome?.status === 'revalidated';
    const waitingReason = !outcome && result?.action?.startsWith('blocked:') ? result.action : due && !outcome && result ? `waiting:${result.action}` : null;
    const notRefreshed = due && !promoted && !!result;
    const consecutiveFailures = promoted || !due ? 0 : notRefreshed ? (before?.consecutiveFailures ?? 0) + 1 : before?.consecutiveFailures ?? 0;
    const state: ModelStatus['state'] = expired ? 'expired' : promoted ? 'ok' : outcome ? (outcome.status === 'blocked' ? 'blocked' : outcome.status === 'skipped' ? 'skipped' : 'failed')
      : waitingReason?.startsWith('blocked:') ? 'blocked' : due ? 'due' : 'ok';
    const lastAttempt = outcome ? { evaluationDate: weekly ? (outcome.details?.retriedFromAttempt as string | undefined) ?? report.busGroup?.evaluationDate ?? null : null, outcome: outcome.status, reason: outcome.reason, at: now, runId: report.runId,
      // The numbers behind a re-validation are what the health page shows for "why is this model still in service".
      ...(outcome.status === 'revalidated' && outcome.details ? { details: outcome.details } : {}) } : before?.lastAttempt ?? null;
    models[key] = { version: entry?.version ?? null, expiresAt, refreshOpensAt: opens,
      nextAttemptAt: opens !== null && opens > now ? nextScheduledAt(opens - 1) : nextRun, consecutiveFailures,
      lastFailureReason: promoted || !due ? null : outcome ? `${outcome.status}:${outcome.reason}` : waitingReason ?? before?.lastFailureReason ?? null,
      lastPromotedAt: entry?.promotedAt ?? null, lastAttemptAt: lastAttempt?.at ?? null, state, lastAttempt };
  }
  for (const key of ['hgb', 'contextual', 'journey'] as const) models[key] = { version: null, expiresAt: null, refreshOpensAt: null, nextAttemptAt: null, consecutiveFailures: 0, lastFailureReason: 'no-data', lastPromotedAt: null, lastAttemptAt: null, state: 'skipped', lastAttempt: null };
  const exitCode = exitCodeOf(report.outcome);
  const status: RefreshStatus = { schema: STATUS_SCHEMA, updatedAt: kstIso(now), runId: report.runId, startedAt: report.startedAt, finishedAt: now, outcome: report.outcome, exitCode,
    mode: report.mode, schedule: { cron: SCHEDULE.cron, timeZone: SCHEDULE.timeZone }, nextScheduledAt: nextRun,
    lastRun: { runId: report.runId, startedAt: report.startedAt, finishedAt: now, outcome: report.outcome, exitCode },
    lastSuccessfulRunAt: ['promoted', 'revalidated', 'noop', 'partial'].includes(report.outcome) ? now : previous?.lastSuccessfulRunAt ?? null, models,
    calendars: Object.fromEntries(Object.entries(manifest?.calendars ?? {}).map(([year, entry]) => [year, { reviewAfter: entry.reviewAfter, source: entry.source }])),
    alerts: report.alerts, notices: report.notices };
  // Absent rather than null: the server's reader takes these as optional numbers.
  const timestamps = new Set(['refreshOpensAt', 'nextAttemptAt', 'lastAttemptAt', 'lastPromotedAt', 'lastSuccessfulRunAt', 'expiresAt']);
  await writeAtomic(store.status, JSON.stringify(status, (key, value) => timestamps.has(key) && value === null ? undefined : value, 2) + '\n', report.runId);
  await writeJsonAtomic(resolve(store.runDir(report.runId), 'report.json'), { ...report, finishedAt: now }, report.runId);
  return status;
}

/** runs 60 days; candidates 21 days; model objects not in manifest/history beyond the newest 4 per key; references of bytes no longer in manifest/history. */
export async function retain(store: Store, manifest: Manifest, now: number, log: Logger) {
  const removed: string[] = [];
  const sweep = async (directory: string, days: number) => {
    if (!existsSync(directory)) return;
    for (const name of await readdir(directory)) { const path = resolve(directory, name); if ((await stat(path)).mtimeMs < now - days * DAY) { await rm(path, { recursive: true, force: true }); removed.push(path); } }
  };
  await sweep(store.path('runs'), 60);
  for (const group of existsSync(store.path('candidates')) ? await readdir(store.path('candidates')) : []) await sweep(store.path('candidates', group), 21);
  const keep = new Set(Object.values(manifest.models).flatMap(entry => [entry!.path, ...entry!.history.map(item => item.path)]));
  for (const key of MODEL_KEYS) {
    const root = store.path('models', key); if (!existsSync(root)) continue;
    const files: { path: string; mtime: number }[] = [];
    for (const version of await readdir(root)) for (const name of await readdir(resolve(root, version))) { const path = resolve(root, version, name); files.push({ path, mtime: (await stat(path)).mtimeMs }); }
    files.sort((left, right) => right.mtime - left.mtime);
    for (const file of files.slice(4)) if (!keep.has(store.rel(file.path))) { await rm(file.path, { force: true }); removed.push(file.path); }
  }
  // Re-validation references only matter for bytes the manifest can still serve (the model or a rollback target).
  const served = new Set(Object.values(manifest.models).flatMap(entry => [entry!.sha256, ...entry!.history.map(item => item.sha256)]));
  for (const key of MODEL_KEYS) {
    const root = store.path('references', key); if (!existsSync(root)) continue;
    for (const name of await readdir(root)) if (!served.has(name.replace(/\.json$/, ''))) { await rm(resolve(root, name), { force: true }); removed.push(resolve(root, name)); }
  }
  if (removed.length) log('INFO', 'retention', { removed: removed.length });
}

