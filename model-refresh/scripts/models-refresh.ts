/**
 * Automatic refresh of the operational models. The same entrypoint runs in the Cloud Run Job (store = the bucket
 * mounted at /models-store) and on a developer machine (store = any folder).
 *
 *   models-refresh.ts [refresh] --store DIR [--plan] [--only k,..] [--max-download-bytes N] [--run-id ID] [--mode local|cloud] [--keep-work-dir] [--repo-root DIR]
 *   models-refresh.ts init      --store DIR [--from-bundle DIR] [--link-taims DIR..] [--force] [--repo-root DIR]
 *   models-refresh.ts bundle    --out DIR [--store DIR] [--repo-root DIR]   (--store: carry that store's re-validated expiry extensions along)
 *
 * The code lives in jigak-backend/model-refresh (the backend-only repository carries it). bundle, and init without --from-bundle,
 * read the untracked operational files and journals of the monorepo (cloud-models/, mvp/data/): --repo-root or JIGAK_MONOREPO_ROOT,
 * else two levels above model-refresh/. refresh and holidays --sync-repo-calendars use the same root, when present, for the
 * monorepo's mvp/data/mobility-python and mvp/server/realtime/data.
 *   models-refresh.ts rollback  --store DIR --model KEY [--to VERSION|SHA12] [--execute]
 *   models-refresh.ts verify    --store DIR
 *   models-refresh.ts holidays  --store DIR [--plan] [--sync-repo-calendars] [--repo-root DIR]
 *
 * Exit codes: 0 promoted/noop/skipped-locked, 3 partial failure, 2 alert (a model within 48 h or expired, or the
 * holiday calendar about to lapse), 1 crash.
 */
import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refreshHolidayCalendars, holidayFileText, type FetchLike } from './model-refresh/holidays';
import { bundleSources, buildBundle, initStore, monorepoRoot, repositorySources } from './model-refresh/init';
import { readManifest, rollback, verifyManifest, writeManifest } from './model-refresh/manifest';
import { runIdNow, runRefresh } from './model-refresh/run';
import { PYTHON_COMMAND } from './python-runtime';
import { acquireLock, MODEL_KEYS, releaseLock, Store, type ModelKey } from './model-refresh/store';
import { createLogger, errorMessage } from './model-refresh/util';

const project = fileURLToPath(new URL('../', import.meta.url));
/** The calendars shipped with the API (src/common/engine/realtime/data), next to this folder in both repositories. */
const repoCalendars = resolve(project, '..', 'src', 'common', 'engine', 'realtime', 'data');
const SUBCOMMANDS = ['refresh', 'init', 'bundle', 'rollback', 'verify', 'holidays'] as const;
type Subcommand = typeof SUBCOMMANDS[number];

export function parseArgs(argv: string[]) {
  const flags: Record<string, string | true | string[]> = {}, positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const name = value.slice(2), next = argv[i + 1];
    if (name === 'link-taims') { const list: string[] = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) list.push(argv[++i]); flags[name] = list; continue; }
    if (next === undefined || next.startsWith('--')) flags[name] = true; else { flags[name] = next; i++; }
  }
  const command = (positional.find(value => (SUBCOMMANDS as readonly string[]).includes(value)) ?? 'refresh') as Subcommand;
  return { command, flags };
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
/** Where an mvp/ folder may be: --repo-root, else JIGAK_MONOREPO_ROOT, else two levels above model-refresh/ (same order as monorepoRoot, but optional). */
const repoRootGuess = (explicit?: string) => resolve(explicit ?? process.env.JIGAK_MONOREPO_ROOT ?? resolve(project, '..', '..'));
function defaultPython(repoRoot?: string) {
  if (process.env.PYTHON) return process.env.PYTHON;
  // The project's virtual environment: data/mobility-python here, or the monorepo's mvp/data/mobility-python.
  const roots = [resolve(project, 'data'), resolve(repoRootGuess(repoRoot), 'mvp', 'data')];
  const local = roots.map(root => process.platform === 'win32' ? resolve(root, 'mobility-python', 'Scripts', 'python.exe') : resolve(root, 'mobility-python', 'bin', 'python')).find(path => existsSync(path));
  // Windows' python3 is often the Store alias stub; python-runtime.ts picks 'python' there.
  return local ?? PYTHON_COMMAND;
}

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const runId = text(flags['run-id']) ?? runIdNow(), log = createLogger(runId);
  const storeRoot = text(flags.store) ?? process.env.MODEL_REFRESH_STORE;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  if (command === 'bundle') {
    const out = text(flags.out); if (!out) throw new Error('usage: bundle --out DIR');
    const bundleStore = text(flags.store) ? new Store(await realpath(text(flags.store)!)) : undefined;
    print({ event: 'model-store-bundle', ...await buildBundle(repositorySources(project, monorepoRoot(project, text(flags['repo-root']))), resolve(out), { store: bundleStore }) }); return 0;
  }
  if (!storeRoot) throw new Error('usage: --store DIR (or MODEL_REFRESH_STORE)');
  await mkdir(storeRoot, { recursive: true });
  const store = new Store(await realpath(storeRoot));
  if (command === 'init') {
    const sources = text(flags['from-bundle']) ? bundleSources(resolve(text(flags['from-bundle'])!)) : repositorySources(project, monorepoRoot(project, text(flags['repo-root'])));
    const result = await initStore(store, sources, { runId, force: flags.force === true, linkTaims: Array.isArray(flags['link-taims']) ? flags['link-taims'].map(path => resolve(path)) : undefined });
    log('NOTICE', 'model-store-initialized', result); return 0;
  }
  if (command === 'verify') {
    const result = await verifyManifest(store); process.stdout.write(result.sha256sums);
    log(result.ok ? 'NOTICE' : 'ERROR', 'model-manifest-verified', { ok: result.ok, generation: result.generation, problems: result.problems, models: result.models }); return result.ok ? 0 : 1;
  }
  if (command === 'rollback') {
    const model = text(flags.model) as ModelKey | undefined;
    if (!model || !(MODEL_KEYS as readonly string[]).includes(model)) throw new Error(`usage: rollback --model ${MODEL_KEYS.join('|')}`);
    const execute = flags.execute === true;
    if (!execute) { log('NOTICE', 'model-rollback-plan', await rollback(store, model, { runId, to: text(flags.to), execute: false })); return 0; }
    const lock = await acquireLock(store, runId); if (!lock.acquired) { log('WARNING', 'model-rollback-locked', { holder: lock.holder?.runId ?? null }); return 3; }
    try { log('NOTICE', 'model-rolled-back', await rollback(store, model, { runId, to: text(flags.to), execute: true })); return 0; }
    finally { await releaseLock(store, runId); }
  }
  if (command === 'holidays') {
    const plan = flags.plan === true;
    const lock = plan ? null : await acquireLock(store, runId);
    if (lock && !lock.acquired) { log('WARNING', 'holidays-locked', { holder: lock.holder?.runId ?? null }); return 0; }
    try {
      const manifest = await readManifest(store);
      const result = await refreshHolidayCalendars(store, manifest, { now: Date.now(), fetchImpl: fetch as FetchLike, key: process.env.DATA_GO_KR_SERVICE_KEY, plan, log, runId,
        fallbackDir: repoCalendars });
      let generation = manifest?.generation ?? 0;
      if (!plan && result.changed) {
        if (!manifest) throw new Error('manifest-missing: run init first');
        generation = (await writeManifest(store, manifest, { runId, models: manifest.models, calendars: result.calendars })).generation;
        if (flags['sync-repo-calendars'] === true) await syncRepoCalendars(store, result.calendars, text(flags['repo-root']));
      }
      log(result.alerts.length ? 'ALERT' : 'NOTICE', 'holidays-refreshed', { plan, generation, years: result.years, written: result.written, alerts: result.alerts, notices: result.notices });
      return result.alerts.length ? 2 : 0;
    } finally { if (lock?.acquired) await releaseLock(store, runId); }
  }
  const only = text(flags.only)?.split(',').map(value => value.trim()).filter(Boolean) as ModelKey[] | undefined;
  if (only?.some(key => !(MODEL_KEYS as readonly string[]).includes(key))) throw new Error(`--only takes ${MODEL_KEYS.join(',')}`);
  const mode = (text(flags.mode) ?? process.env.MODEL_REFRESH_MODE ?? 'local') as 'local' | 'cloud';
  const report = await runRefresh({ storeRoot: store.root, runId, plan: flags.plan === true, only, mode, log, projectDir: project,
    workBase: text(flags['work-dir']) ?? process.env.MODEL_REFRESH_WORK_DIR ?? resolve(tmpdir(), 'jigak-refresh'),
    maxDownloadBytes: text(flags['max-download-bytes']) ? Number(flags['max-download-bytes']) : undefined, python: defaultPython(text(flags['repo-root'])),
    routeTablePolicy: (text(flags['route-table-policy']) ?? process.env.MODEL_REFRESH_ROUTE_TABLE_POLICY ?? 'nearest-consistent') as 'strict' | 'nearest-consistent',
    serviceKey: process.env.DATA_GO_KR_SERVICE_KEY, skipDownloads: flags['no-download'] === true, keepWorkDir: flags['keep-work-dir'] === true || process.env.MODEL_REFRESH_KEEP_WORK === '1',
    workers: Number(text(flags.workers) ?? process.env.MODEL_REFRESH_WORKERS) || undefined });
  if (report.plan) print({ event: 'model-refresh-plan', models: report.models, busGroup: report.busGroup, taims: report.taims, holidays: report.holidays?.years ?? null, alerts: report.alerts, notices: report.notices });
  return report.exitCode;
}

/** Same bytes into the repository copies (jigak-backend, and mvp/server when the monorepo is there), only when asked. */
async function syncRepoCalendars(store: Store, calendars: Record<string, { path: string }>, repoRoot?: string) {
  const { readFile } = await import('node:fs/promises');
  for (const [year, entry] of Object.entries(calendars)) {
    const contents = await readFile(store.path(entry.path), 'utf8'); holidayFileText(JSON.parse(contents));
    for (const directory of [repoCalendars, resolve(repoRootGuess(repoRoot), 'mvp', 'server', 'realtime', 'data')])
      if (existsSync(directory)) await writeFile(resolve(directory, `korea-holidays-${year}.json`), contents);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    process.stdout.write(JSON.stringify({ severity: 'ERROR', event: 'model-refresh-crashed', reason: errorMessage(error) }) + '\n');
    process.exitCode = 1;
  });
}
