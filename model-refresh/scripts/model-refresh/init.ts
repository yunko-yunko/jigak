import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calendarFileName } from './holidays';
import { effectiveExpiry, expiryCeiling, readManifest, storeModelObject, writeManifest, type Manifest, type ManifestModel, type Revalidation } from './manifest';
import { stageFile } from './process';
import { JOURNALS, LEGACY_NAMES, MODEL_KEYS, Store, type ModelKey } from './store';
import { linkExistingArchives, readTaimsIndex, writeTaimsIndex } from './taims';
import { sha256Text, writeAtomic, writeJsonAtomic } from './util';
import { referencePath, STATIC_CONTEXT, STATIC_SHA256, staticInputDir } from './pipelines';
import { MAX_MODEL_AGE_MS } from './manifest';

/**
 * Where the first generation comes from. A bundle folder (uploaded to the bucket for the cloud) has the same names.
 * `references`: incumbent references (references/<model>/<sha256>.json in a bundle, or a flat folder of <sha256>.json).
 */
export interface InitSources { operational: string; journals: string; calendars: string; bicycleSeed: string; roadPriors: string; stations: string; references?: string }

/**
 * The monorepo root (the folder with cloud-models/ and mvp/data/), which holds the operational files and journals that are
 * never committed: --repo-root, else JIGAK_MONOREPO_ROOT, else two levels above model-refresh/ when an mvp/ folder is there.
 * A clone of the backend-only repository has none; bundle and init without --from-bundle then stop with this message.
 */
export function monorepoRoot(projectDir: string, explicit?: string): string {
  const candidate = explicit ?? process.env.JIGAK_MONOREPO_ROOT ?? resolve(projectDir, '..', '..');
  if (existsSync(resolve(candidate, 'mvp')) || existsSync(resolve(candidate, 'cloud-models'))) return resolve(candidate);
  throw new Error('monorepo-missing: bundle (and init without --from-bundle) read cloud-models/ and mvp/data/ of the monorepo; run them there or pass --repo-root DIR (JIGAK_MONOREPO_ROOT)');
}
/** Development sources: the monorepo's untracked operational files, journals and seed; calendars and fixed inputs from this repository. */
export function repositorySources(projectDir: string, repoRoot = monorepoRoot(projectDir)): InitSources {
  const data = resolve(repoRoot, 'mvp', 'data');
  return { operational: resolve(repoRoot, 'cloud-models'), journals: data, calendars: resolve(projectDir, '..', 'src', 'common', 'engine', 'realtime', 'data'),
    bicycleSeed: resolve(data, 'spatial-bicycle-v2-final'), roadPriors: resolve(staticInputDir(projectDir), STATIC_CONTEXT.roadPriors),
    stations: resolve(staticInputDir(projectDir), STATIC_CONTEXT.stations), references: resolve(data, 'model-references') };
}
export function bundleSources(bundle: string): InitSources {
  return { operational: resolve(bundle, 'operational'), journals: resolve(bundle, 'journals'), calendars: resolve(bundle, 'calendars'), bicycleSeed: resolve(bundle, 'seed', 'spatial-bicycle-v2-final'),
    roadPriors: resolve(bundle, 'context', STATIC_CONTEXT.roadPriors), stations: resolve(bundle, 'context', STATIC_CONTEXT.stations), references: resolve(bundle, 'references') };
}

const REFERENCE_VERSION = 'jigak-incumbent-reference-v1';
interface ReferenceFile { model: ModelKey; sha256: string; path: string }
/** Every incumbent reference under `directory` (flat or per model): named by the checkpoint sha256 it describes, for a known model. */
export async function referenceFiles(directory: string | undefined): Promise<ReferenceFile[]> {
  if (!directory || !existsSync(directory)) return [];
  const found: ReferenceFile[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      const match = /^([0-9a-f]{64})\.json$/.exec(entry.name);
      if (!match) continue;
      let body: { version?: unknown; model?: unknown; checkpointSha256?: unknown };
      try { body = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      if (body.version === REFERENCE_VERSION && body.checkpointSha256 === match[1] && (MODEL_KEYS as readonly unknown[]).includes(body.model))
        found.push({ model: body.model as ModelKey, sha256: match[1], path });
    }
  };
  await walk(directory);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
/** References of exactly these bytes (model key -> sha256), first one wins. */
const referencesFor = (files: ReferenceFile[], served: Partial<Record<ModelKey, string>>) => {
  const chosen = new Map<string, ReferenceFile>();
  for (const file of files) if (served[file.model] === file.sha256 && !chosen.has(`${file.model}/${file.sha256}`)) chosen.set(`${file.model}/${file.sha256}`, file);
  return [...chosen.values()];
};
const BICYCLE_SEED_FILES = ['protocol.json', 'model.json', 'report.json', 'parity.json'];
/** Next to the operational files in a bundle: expiry extensions (re-validations) of exactly those files, from the store that measured them. */
export const REVALIDATIONS_FILE = 'revalidations.json';
type RevalidationOverlay = Partial<Record<ModelKey, { sha256: string; expiresAt: number; revalidatedAt: number; revalidationCount: number; revalidations: Revalidation[] }>>;

/** The re-validations of the manifest in `store`, for the bundle. Only entries that carry one; an expiry past the file's holiday calendar is cut to it. */
export async function revalidationOverlay(store: Store): Promise<RevalidationOverlay> {
  const manifest = await readManifest(store), overlay: RevalidationOverlay = {};
  for (const [key, entry] of Object.entries(manifest?.models ?? {}) as [ModelKey, ManifestModel][])
    if (entry.revalidatedAt && entry.expiresAt) overlay[key] = { sha256: entry.sha256, expiresAt: (await effectiveExpiry(store, entry))!, revalidatedAt: entry.revalidatedAt, revalidationCount: entry.revalidationCount ?? 1, revalidations: entry.revalidations ?? [] };
  return overlay;
}

/** Collect everything the store needs into one folder: `gcloud storage cp -r <out> gs://BUCKET/bootstrap` and run init in the Job. */
export async function buildBundle(sources: InitSources, out: string, options: { store?: Store } = {}) {
  const copied: string[] = [];
  if (options.store) {
    const overlay = await revalidationOverlay(options.store);
    if (Object.keys(overlay).length) { await writeJsonAtomic(resolve(out, 'operational', REVALIDATIONS_FILE), overlay); copied.push(`operational/${REVALIDATIONS_FILE}`); }
  }
  for (const key of MODEL_KEYS) { const source = resolve(sources.operational, LEGACY_NAMES[key]); if (existsSync(source)) { await stageFile(source, resolve(out, 'operational', LEGACY_NAMES[key])); copied.push(`operational/${LEGACY_NAMES[key]}`); } }
  // With --store the evaluation days that store already used travel along: a re-validation consumed its evaluation day, and a store started from this bundle must not inspect it again.
  const journals = options.store ? options.store.journals : sources.journals;
  for (const name of [JOURNALS.spatialBus, JOURNALS.railGate, JOURNALS.bicycleRide]) if (existsSync(resolve(journals, name))) { await stageFile(resolve(journals, name), resolve(out, 'journals', name)); copied.push(`journals/${name}`); }
  const publicJournal = resolve(journals, JOURNALS.publicBus);
  if (existsSync(publicJournal)) for (const name of await readdir(publicJournal)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) { await stageFile(resolve(publicJournal, name), resolve(out, 'journals', JOURNALS.publicBus, name)); copied.push(`journals/${JOURNALS.publicBus}/${name}`); }
  for (const name of (await readdir(sources.calendars)).filter(name => /^korea-holidays-\d{4}\.json$/.test(name))) { await stageFile(resolve(sources.calendars, name), resolve(out, 'calendars', name)); copied.push(`calendars/${name}`); }
  for (const name of BICYCLE_SEED_FILES) { await stageFile(resolve(sources.bicycleSeed, name), resolve(out, 'seed', 'spatial-bicycle-v2-final', name)); copied.push(`seed/spatial-bicycle-v2-final/${name}`); }
  await stageFile(sources.roadPriors, resolve(out, 'context', STATIC_CONTEXT.roadPriors)); await stageFile(sources.stations, resolve(out, 'context', STATIC_CONTEXT.stations));
  copied.push(`context/${STATIC_CONTEXT.roadPriors}`, `context/${STATIC_CONTEXT.stations}`);
  // Incumbent references of the bundled operational bytes, so the first cloud generation can be re-validated at once.
  // With --store that store's references come first (they describe what it serves); the source folder fills the rest.
  const served: Partial<Record<ModelKey, string>> = {};
  for (const key of MODEL_KEYS) { const path = resolve(out, 'operational', LEGACY_NAMES[key]); if (existsSync(path)) served[key] = sha256Text(await readFile(path)); }
  const references = referencesFor([...await referenceFiles(options.store?.path('references')), ...await referenceFiles(sources.references)], served);
  for (const file of references) { await stageFile(file.path, resolve(out, 'references', file.model, `${file.sha256}.json`)); copied.push(`references/${file.model}/${file.sha256}.json`); }
  const missingReferences = (['spatialBus', 'railGate'] as ModelKey[]).filter(key => served[key] && !references.some(file => file.model === key));
  return { out, files: copied.length, copied, missingReferences };
}

/** Generation 1 from the current operational files; journals, calendars, the 따릉이 seed and the static context come along. */
export async function initStore(store: Store, sources: InitSources, options: { runId: string; now?: number; force?: boolean; linkTaims?: string[] }) {
  const now = options.now ?? Date.now(), previous = await readManifest(store);
  if (previous && !options.force) throw new Error('store-already-initialized');
  const models: Manifest['models'] = {}, skipped: string[] = [], extended: string[] = [];
  const overlay = (existsSync(resolve(sources.operational, REVALIDATIONS_FILE)) ? JSON.parse(await readFile(resolve(sources.operational, REVALIDATIONS_FILE), 'utf8')) : {}) as RevalidationOverlay;
  for (const key of MODEL_KEYS) {
    const source = resolve(sources.operational, LEGACY_NAMES[key]);
    if (!existsSync(source)) { skipped.push(key); continue; }
    const text = await readFile(source, 'utf8'), object = await storeModelObject(store, key, text, options.runId, now);
    models[key] = { version: object.parsed.version, path: object.rel, sha256: object.sha256, bytes: object.bytes, trainedAt: object.parsed.trainedAt, expiresAt: object.parsed.expiresAt,
      evaluationDate: object.parsed.evaluationDate, promotedAt: now, runId: options.runId, gates: { source: 'init', from: LEGACY_NAMES[key] }, history: [] } satisfies ManifestModel;
    // A re-validation measured in another store applies to these very bytes only, and only while it is still a valid extension (<= 28 days of age, later than the file's own end).
    // It is cut at the end of the holiday calendar inside the file: a bundle made before that rule may say more than the model can serve.
    const extension = overlay[key];
    if (extension && extension.sha256 === object.sha256 && object.parsed.trainedAt !== null && extension.expiresAt <= object.parsed.trainedAt + MAX_MODEL_AGE_MS) {
      const ceiling = expiryCeiling(object.parsed.trainedAt, text), expiresAt = Math.min(extension.expiresAt, ceiling.at);
      if (expiresAt > (object.parsed.expiresAt ?? 0)) {
        Object.assign(models[key]!, { expiresAt, revalidatedAt: extension.revalidatedAt, revalidationCount: extension.revalidationCount, revalidations: extension.revalidations.slice(0, 5),
          ...(expiresAt < extension.expiresAt && ceiling.by ? { expiryClippedBy: ceiling.by } : {}) }); extended.push(key);
      }
    }
  }
  const calendars: Manifest['calendars'] = {};
  for (const name of (await readdir(sources.calendars)).filter(name => /^korea-holidays-\d{4}\.json$/.test(name)).sort()) {
    const text = await readFile(resolve(sources.calendars, name), 'utf8'), file = JSON.parse(text), path = calendarFileName(file.year, text);
    await writeAtomic(store.path(path), text, options.runId);
    calendars[file.year] = { path, sha256: sha256Text(text), reviewAfter: file.reviewAfter, verifiedAt: file.verifiedAt, source: file.refresh?.method ?? 'carried' };
  }
  const journals: string[] = [];
  for (const name of [JOURNALS.spatialBus, JOURNALS.railGate, JOURNALS.bicycleRide]) if (existsSync(resolve(sources.journals, name)) && !existsSync(resolve(store.journals, name))) { await stageFile(resolve(sources.journals, name), resolve(store.journals, name)); journals.push(name); }
  const publicJournal = resolve(sources.journals, JOURNALS.publicBus);
  if (existsSync(publicJournal)) for (const name of await readdir(publicJournal)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name) && !existsSync(resolve(store.journals, JOURNALS.publicBus, name))) { await stageFile(resolve(publicJournal, name), resolve(store.journals, JOURNALS.publicBus, name)); journals.push(`${JOURNALS.publicBus}/${name}`); }
  for (const name of BICYCLE_SEED_FILES) if (existsSync(resolve(sources.bicycleSeed, name))) await stageFile(resolve(sources.bicycleSeed, name), resolve(store.seed, 'spatial-bicycle-v2-final', name));
  // Fixed inputs go to static/ (raw/ is deleted after 21 days), only with the expected bytes; the runner falls back to the committed copy anyway.
  const staticInputs: Record<string, 'written' | 'mismatch' | 'missing'> = {};
  for (const [source, name] of [[sources.roadPriors, STATIC_CONTEXT.roadPriors], [sources.stations, STATIC_CONTEXT.stations]]) {
    if (!existsSync(source)) { staticInputs[name] = 'missing'; continue; }
    if (sha256Text(await readFile(source)) !== STATIC_SHA256[name]) { staticInputs[name] = 'mismatch'; continue; }
    await stageFile(source, resolve(store.static, name)); staticInputs[name] = 'written';
  }
  // Incumbent references of the installed bytes: the store can re-validate its models from its first run.
  const installed = Object.fromEntries((Object.entries(models) as [ModelKey, ManifestModel][]).map(([key, entry]) => [key, entry.sha256])) as Partial<Record<ModelKey, string>>;
  const references: string[] = [];
  for (const file of referencesFor(await referenceFiles(sources.references), installed)) {
    const target = referencePath(store, file.model, file.sha256);
    if (!existsSync(target)) await stageFile(file.path, target);
    references.push(`${file.model}/${file.sha256}`);
  }
  const manifest = await writeManifest(store, previous, { runId: options.runId, models, calendars }, now);
  for (const [key, entry] of Object.entries(models) as [ModelKey, ManifestModel][]) await writeAtomic(store.legacy(key), await readFile(store.path(entry.path)), options.runId);
  let linked = 0;
  if (options.linkTaims?.length) {
    const index = await readTaimsIndex(store);
    for (const entry of await linkExistingArchives(store, options.linkTaims, null)) { index.archives[entry.name] = entry; linked++; }
    await writeTaimsIndex(store, index, options.runId);
  }
  return { generation: manifest.generation, models: Object.fromEntries(Object.entries(models).map(([key, entry]) => [key, { version: entry!.version, expiresAt: entry!.expiresAt, path: entry!.path }])),
    calendars: Object.keys(calendars), journals, skipped, revalidated: extended, linkedArchives: linked, staticInputs, references };
}
