import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parsePublicBusModel } from '../../../src/common/engine/intelligence/public-bus-model';
import { parseSpatialBusCheckpoint } from '../../../src/common/engine/intelligence/spatial-bus-model';
import { parseRailGateCheckpoint } from '../../../src/common/engine/intelligence/rail-gate-model';
import { parseSpatialBicycleCheckpoint } from '../../../src/common/engine/intelligence/spatial-bicycle-ride';
import { MeasuredBicycleRides } from '../../../src/common/engine/realtime/bicycle-ride-times';
import { MODEL_KEYS, Store, type ModelKey } from './store';
import { holidayCalendarSlice, holidayReviewProblems, type KoreanHolidayCalendar } from '../../../src/common/engine/intelligence/korean-holidays';
import { calendarEndOf, MAX_MODEL_AGE_MS, servingCalendarLastDate } from './calendar-span';
import { DAY, kstIso, kstStamp, sha256File, sha256Text, writeAtomic, writeJsonAtomic } from './util';

export const MANIFEST_SCHEMA = 'jigak-model-manifest-v1' as const;
export const HISTORY_LIMIT = 3;
/** The normal life of a weekly model; MAX_MODEL_AGE_MS is the most the manifest may extend it to (counted from the day it was trained). */
export const MODEL_LIFE_MS = 7 * DAY, REVALIDATION_LOG_LIMIT = 5;
export { MAX_MODEL_AGE_MS };
/** What cut an expiry short: the holiday calendar inside the model file (no day type, so no prediction, after it) or the 28-day age cap. */
export type ExpiryLimit = 'calendar-end' | 'max-model-age';
export interface HistoryEntry { version: string; path: string; sha256: string; bytes: number; trainedAt: number | null; expiresAt: number | null; evaluationDate: string | null; promotedAt: number; retiredAt: number }
/** One re-validation of the model in service: same bytes, a later expiresAt, and the numbers that justified it. */
export interface Revalidation {
  at: number; runId: string; evaluationDate: string; previousExpiresAt: number | null; expiresAt: number; candidate: string; evidence: Record<string, unknown>;
  /** Set when now + 7 days was cut; calendarLastDate is the last day the file's holiday calendar names. */
  clippedBy?: ExpiryLimit | null; calendarLastDate?: string | null;
  /** Set when the file's holiday slice was re-cut from the reviewed calendar to allow this extension (the model itself is unchanged). */
  calendarExtended?: CalendarExtension;
}
/** The served file was replaced by the same model with a longer holiday slice: which bytes it came from and how far the slice now reaches. */
export interface CalendarExtension { fromSha256: string; fromPath: string; previousLastDate: string; lastDate: string; addedHolidays: string[] }
export interface ManifestModel {
  version: string; path: string; sha256: string; bytes: number; trainedAt: number | null; expiresAt: number | null;
  evaluationDate: string | null; promotedAt: number; runId: string; gates: Record<string, unknown>; history: HistoryEntry[];
  /** Present only after a re-validation: when, how many in a row since the promotion, and the latest few. */
  revalidatedAt?: number; revalidationCount?: number; revalidations?: Revalidation[];
  /** An expiry carried in from elsewhere (a bundle's re-validation) that was cut to what the file allows. */
  expiryClippedBy?: ExpiryLimit;
}
export interface CalendarEntry { path: string; sha256: string; reviewAfter: string; verifiedAt: string; source: 'kasi-spcde-api' | 'unofficial-cross-check' | 'carried' }
export interface Manifest {
  schema: typeof MANIFEST_SCHEMA; generation: number; updatedAt: string; runId: string;
  models: Partial<Record<ModelKey, ManifestModel>>; calendars: Record<string, CalendarEntry>;
}
export interface ParsedModel { version: string; trainedAt: number | null; expiresAt: number | null; evaluationDate: string | null }

/** The same parsers the API uses (src/common/engine): what the job promotes is read by the very code that serves it. */
export function parseModelText(key: ModelKey, text: string, now = Date.now()): ParsedModel {
  switch (key) {
    case 'publicBus': { const model = parsePublicBusModel(text, now, { allowExpired: true }); return { version: model.version, trainedAt: model.trainedAt, expiresAt: model.expiresAt, evaluationDate: model.validation.testDates.at(-1) ?? null }; }
    case 'spatialBus': { const model = parseSpatialBusCheckpoint(text); return { version: model.version, trainedAt: model.trainedAt, expiresAt: model.expiresAt, evaluationDate: (JSON.parse(text).lastEvaluatedServiceDate as string) ?? null }; }
    case 'railGate': { const model = parseRailGateCheckpoint(text); return { version: model.version, trainedAt: model.trainedAt, expiresAt: model.expiresAt, evaluationDate: (JSON.parse(text).lastEvaluatedServiceDate as string) ?? null }; }
    case 'bicycleRide': { const model = parseSpatialBicycleCheckpoint(text); return { version: model.version, trainedAt: model.trainedAt, expiresAt: model.expiresAt, evaluationDate: model.lastEvaluatedServiceDate }; }
    case 'bicycleRideTimes': { const parsed = JSON.parse(text); MeasuredBicycleRides.fromData(parsed); if (parsed.version !== 'ddareungi-dock-pair-v1') throw new Error('invalid-ride-times'); return { version: parsed.version, trainedAt: null, expiresAt: null, evaluationDate: null }; }
  }
}

export function validateManifest(value: unknown): Manifest {
  const manifest = value as Manifest;
  if (!manifest || manifest.schema !== MANIFEST_SCHEMA || !Number.isSafeInteger(manifest.generation) || manifest.generation < 1
    || typeof manifest.models !== 'object' || typeof manifest.calendars !== 'object') throw new Error('manifest-schema');
  for (const [key, entry] of Object.entries(manifest.models)) {
    if (!(MODEL_KEYS as readonly string[]).includes(key) || !entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.path !== 'string'
      || entry.path.startsWith('/') || entry.path.includes('..') || !Array.isArray(entry.history)) throw new Error(`manifest-model:${key}`);
  }
  for (const [year, entry] of Object.entries(manifest.calendars)) if (!/^\d{4}$/.test(year) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.path.includes('..')) throw new Error(`manifest-calendar:${year}`);
  return manifest;
}

export async function readManifest(store: Store): Promise<Manifest | null> {
  if (!existsSync(store.manifest)) return null;
  return validateManifest(JSON.parse(await readFile(store.manifest, 'utf8')));
}

/** tmp + rename of the one pointer object. Generation rises by exactly one per write. */
export async function writeManifest(store: Store, previous: Manifest | null, next: Omit<Manifest, 'schema' | 'generation' | 'updatedAt'>, now = Date.now()): Promise<Manifest> {
  const current = await readManifest(store);
  if ((current?.generation ?? 0) !== (previous?.generation ?? 0)) throw new Error('manifest-changed-concurrently');
  const manifest: Manifest = { schema: MANIFEST_SCHEMA, generation: (previous?.generation ?? 0) + 1, updatedAt: kstIso(now), runId: next.runId, models: next.models, calendars: next.calendars };
  validateManifest(manifest);
  await writeJsonAtomic(store.manifest, manifest, next.runId);
  return manifest;
}

/** Immutable, content-addressed model object. Re-reads and re-hashes what landed in the store. */
export async function storeModelObject(store: Store, key: ModelKey, text: string, runId: string, now = Date.now()) {
  const parsed = parseModelText(key, text, now), sha256 = sha256Text(text);
  const rel = `models/${key}/${parsed.version}/${kstStamp(parsed.trainedAt ?? now)}-${sha256.slice(0, 12)}.json`, target = store.path(rel);
  if (!existsSync(target) || await sha256File(target) !== sha256) await writeAtomic(target, text, runId);
  const written = await readFile(target, 'utf8');
  if (sha256Text(written) !== sha256) throw new Error('stored-model-sha-mismatch');
  parseModelText(key, written, now);
  return { rel, sha256, bytes: Buffer.byteLength(text), parsed };
}

/** Fixed-name copy for service revisions that still read ETA_*_PATH. Written after the manifest switch. */
async function copyLegacy(store: Store, key: ModelKey, rel: string, runId: string) {
  await writeAtomic(store.legacy(key), await readFile(store.path(rel)), runId);
}

const asHistory = (entry: ManifestModel, retiredAt: number): HistoryEntry => ({ version: entry.version, path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
  trainedAt: entry.trainedAt, expiresAt: entry.expiresAt, evaluationDate: entry.evaluationDate, promotedAt: entry.promotedAt, retiredAt });

/**
 * Promotion: candidate object written and verified → parsed with the server parser → manifest tmp → rename → legacy copy.
 * An expired or not-yet-valid candidate is refused; the previous model stays in the manifest until this succeeds.
 */
export async function promote(store: Store, key: ModelKey, text: string, options: { runId: string; now?: number; gates?: Record<string, unknown>; evaluationDate?: string | null; calendars?: Manifest['calendars'] }) {
  const now = options.now ?? Date.now(), previous = await readManifest(store);
  const object = await storeModelObject(store, key, text, options.runId, now);
  const { parsed } = object;
  if (parsed.expiresAt !== null && parsed.expiresAt <= now) throw new Error('candidate-expired');
  if (parsed.trainedAt !== null && parsed.trainedAt > now) throw new Error('candidate-from-the-future');
  const incumbent = previous?.models[key];
  if (incumbent?.sha256 === object.sha256) return { manifest: previous!, changed: false as const, object };
  const history = incumbent ? [asHistory(incumbent, now), ...incumbent.history.filter(entry => entry.sha256 !== object.sha256)].slice(0, HISTORY_LIMIT) : [];
  const entry: ManifestModel = { version: parsed.version, path: object.rel, sha256: object.sha256, bytes: object.bytes, trainedAt: parsed.trainedAt, expiresAt: parsed.expiresAt,
    evaluationDate: options.evaluationDate ?? parsed.evaluationDate, promotedAt: now, runId: options.runId, gates: options.gates ?? {}, history };
  const manifest = await writeManifest(store, previous, { runId: options.runId, models: { ...previous?.models, [key]: entry }, calendars: options.calendars ?? previous?.calendars ?? {} }, now);
  await copyLegacy(store, key, object.rel, options.runId);
  return { manifest, changed: true as const, object };
}

/**
 * The latest expiry the manifest may give these bytes: 28 days after training, and never past the holiday calendar the file
 * carries, less the 4 h of late boardings a request must still cover (outside it the model has no day type and predicts nothing,
 * so a later expiry would only make health claim it serves).
 */
export function expiryCeiling(trainedAt: number | null, text: string): { at: number; by: ExpiryLimit | null; calendarLastDate: string | null } {
  const age = trainedAt === null ? Infinity : trainedAt + MAX_MODEL_AGE_MS, calendar = calendarEndOf(JSON.parse(text));
  if (calendar && calendar.endsAt <= age) return { at: calendar.endsAt, by: 'calendar-end', calendarLastDate: calendar.lastDate };
  return { at: age, by: age === Infinity ? null : 'max-model-age', calendarLastDate: calendar?.lastDate ?? null };
}

/** The expiry in force for a manifest entry: an older manifest (or a bundle) may say more than its file allows, never less. */
export async function effectiveExpiry(store: Store, entry: ManifestModel | undefined): Promise<number | null> {
  if (!entry || entry.expiresAt === null) return entry?.expiresAt ?? null;
  try { return Math.min(entry.expiresAt, expiryCeiling(entry.trainedAt, await readFile(store.path(entry.path), 'utf8')).at); } catch { return entry.expiresAt; }
}

/**
 * Re-validation: the model in service lost to (or was not beaten by) a candidate on a fresh evaluation day, and on that day it
 * passes the absolute gates by itself. Its file is not touched (sha256 stays); the manifest entry gets expiresAt = now + 7 days,
 * never later than 28 days after the model was trained nor past the holiday calendar inside the file (the record says which cut it).
 * A new generation is written, so the service sees it like any promotion.
 */
export async function revalidate(store: Store, key: ModelKey, options: { runId: string; now?: number; evaluationDate: string; sha256: string; candidate: string; evidence: Record<string, unknown> }) {
  const now = options.now ?? Date.now(), previous = await readManifest(store), current = previous?.models[key];
  if (!previous || !current) throw new Error('no-active-model');
  if (current.sha256 !== options.sha256) throw new Error('revalidation-model-changed');
  const text = await readFile(store.path(current.path), 'utf8');
  if (sha256Text(text) !== current.sha256) throw new Error('revalidation-sha-mismatch');
  parseModelText(key, text, now);
  const ceiling = expiryCeiling(current.trainedAt, text), requested = now + MODEL_LIFE_MS, expiresAt = Math.min(requested, ceiling.at);
  const clippedBy = expiresAt < requested ? ceiling.by : null;
  if (current.expiresAt !== null && expiresAt <= current.expiresAt) throw new Error(`revalidation-limit-reached${clippedBy ? `:${clippedBy}` : ''}`);
  const record: Revalidation = { at: now, runId: options.runId, evaluationDate: options.evaluationDate, previousExpiresAt: current.expiresAt, expiresAt, candidate: options.candidate, evidence: options.evidence,
    clippedBy, calendarLastDate: ceiling.calendarLastDate };
  const entry: ManifestModel = { ...current, expiresAt, revalidatedAt: now, revalidationCount: (current.revalidationCount ?? 0) + 1,
    revalidations: [record, ...(current.revalidations ?? [])].slice(0, REVALIDATION_LOG_LIMIT) };
  const manifest = await writeManifest(store, previous, { runId: options.runId, models: { ...previous.models, [key]: entry }, calendars: previous.calendars }, now);
  return { manifest, entry, record };
}

/**
 * The same model file with only its holiday slice re-cut from the reviewed calendar, through the longest life the manifest may
 * give it (calendar-span's servingCalendarLastDate, as the promoters cut it). A model whose slice was cut short at promotion
 * because the next weeks were not yet reviewed can then be re-validated once they are. Everything but calendar.lastDate and
 * calendar.holidays stays as it was; the days the old slice already covered must name exactly the same holidays, otherwise
 * the model's day types would change under it and this refuses. null when the reviewed calendar reaches no further.
 */
export function extendModelCalendar(text: string, holidays: KoreanHolidayCalendar, options: { trainedAt: number | null; expiresAt: number | null; now: number }) {
  const model = JSON.parse(text) as Record<string, unknown> & { calendar?: { rule?: unknown; firstDate?: unknown; lastDate?: unknown; holidays?: unknown } };
  const calendar = model.calendar;
  if (!calendar || typeof calendar.firstDate !== 'string' || typeof calendar.lastDate !== 'string' || !Array.isArray(calendar.holidays) || options.trainedAt === null) return null;
  const servedUntil = Math.max(options.expiresAt ?? -Infinity, typeof model.expiresAt === 'number' ? model.expiresAt : -Infinity);
  if (!Number.isFinite(servedUntil)) return null;
  const lastDate = servingCalendarLastDate(holidays, calendar.firstDate, options.trainedAt, servedUntil, options.now);
  if (lastDate <= calendar.lastDate || holidayReviewProblems(holidays, calendar.firstDate, lastDate, options.now).length) return null;
  const slice = holidayCalendarSlice(holidays, calendar.firstDate, lastDate);
  if (!slice || slice.rule !== calendar.rule) return null;
  const previousLastDate = calendar.lastDate, covered = slice.holidays.filter(day => day <= previousLastDate);
  if (JSON.stringify(covered) !== JSON.stringify(calendar.holidays)) throw new Error('holiday-calendar-changed-since-promotion');
  const extended = { ...model, calendar: { ...calendar, lastDate, holidays: slice.holidays } };
  return { text: JSON.stringify(extended) + (text.endsWith('\n') ? '\n' : ''), previousLastDate, lastDate, addedHolidays: slice.holidays.filter(day => day > previousLastDate) };
}

/**
 * Re-validation when the only limit was the holiday slice inside the file (revalidation-limit-reached:calendar-end): the slice
 * is re-cut from the reviewed calendar (extendModelCalendar), the new bytes are stored and parsed by the server parser like any
 * promotion, and the manifest entry points at them with the extended expiry. Trees, calibration and every other field are
 * byte-for-byte the model that just passed the gate again; history is untouched (this is not a new model).
 */
export async function revalidateWithExtendedCalendar(store: Store, key: ModelKey, options: { runId: string; now?: number; evaluationDate: string; sha256: string; candidate: string; evidence: Record<string, unknown>; holidays: KoreanHolidayCalendar }) {
  const now = options.now ?? Date.now(), previous = await readManifest(store), current = previous?.models[key];
  if (!previous || !current) throw new Error('no-active-model');
  if (current.sha256 !== options.sha256) throw new Error('revalidation-model-changed');
  const text = await readFile(store.path(current.path), 'utf8');
  if (sha256Text(text) !== current.sha256) throw new Error('revalidation-sha-mismatch');
  const before = parseModelText(key, text, now);
  const extension = extendModelCalendar(text, options.holidays, { trainedAt: current.trainedAt, expiresAt: current.expiresAt, now });
  if (!extension) throw new Error('revalidation-limit-reached:calendar-end:reviewed-calendar-not-longer');
  const strip = (value: string) => { const { calendar: _calendar, ...rest } = JSON.parse(value) as Record<string, unknown>; return JSON.stringify(rest); };
  if (strip(extension.text) !== strip(text)) throw new Error('calendar-extension-changed-model');
  const object = await storeModelObject(store, key, extension.text, options.runId, now);
  if (object.parsed.version !== before.version || object.parsed.trainedAt !== before.trainedAt) throw new Error('calendar-extension-changed-model');
  const ceiling = expiryCeiling(current.trainedAt, extension.text), requested = now + MODEL_LIFE_MS, expiresAt = Math.min(requested, ceiling.at);
  const clippedBy = expiresAt < requested ? ceiling.by : null;
  if (current.expiresAt !== null && expiresAt <= current.expiresAt) throw new Error(`revalidation-limit-reached${clippedBy ? `:${clippedBy}` : ''}`);
  const calendarExtended: CalendarExtension = { fromSha256: current.sha256, fromPath: current.path, previousLastDate: extension.previousLastDate, lastDate: extension.lastDate, addedHolidays: extension.addedHolidays };
  const record: Revalidation = { at: now, runId: options.runId, evaluationDate: options.evaluationDate, previousExpiresAt: current.expiresAt, expiresAt, candidate: options.candidate, evidence: options.evidence,
    clippedBy, calendarLastDate: ceiling.calendarLastDate, calendarExtended };
  const entry: ManifestModel = { ...current, path: object.rel, sha256: object.sha256, bytes: object.bytes, expiresAt, revalidatedAt: now, revalidationCount: (current.revalidationCount ?? 0) + 1,
    revalidations: [record, ...(current.revalidations ?? [])].slice(0, REVALIDATION_LOG_LIMIT) };
  const manifest = await writeManifest(store, previous, { runId: options.runId, models: { ...previous.models, [key]: entry }, calendars: previous.calendars }, now);
  await copyLegacy(store, key, object.rel, options.runId);
  return { manifest, entry, record };
}

/** Rollback is a new generation that points at a history entry. Never to an expired version. */
export async function rollback(store: Store, key: ModelKey, options: { runId: string; to?: string; now?: number; execute?: boolean }) {
  const now = options.now ?? Date.now(), previous = await readManifest(store);
  const current = previous?.models[key];
  if (!previous || !current) throw new Error('no-active-model');
  const target = options.to ? current.history.find(entry => entry.version === options.to || entry.sha256.startsWith(options.to!) || entry.path.endsWith(`${options.to}.json`)) : current.history[0];
  if (!target) throw new Error('rollback-target-not-in-history');
  if (target.expiresAt !== null && target.expiresAt <= now) throw new Error('rollback-target-expired');
  const text = await readFile(store.path(target.path), 'utf8');
  if (sha256Text(text) !== target.sha256) throw new Error('rollback-target-sha-mismatch');
  parseModelText(key, text, now);
  const plan = { key, from: { version: current.version, sha256: current.sha256 }, to: { version: target.version, sha256: target.sha256, expiresAt: target.expiresAt }, generation: previous.generation + 1 };
  if (!options.execute) return { executed: false, plan };
  const history = [asHistory(current, now), ...current.history.filter(entry => entry.sha256 !== target.sha256 && entry.sha256 !== current.sha256)].slice(0, HISTORY_LIMIT);
  const entry: ManifestModel = { version: target.version, path: target.path, sha256: target.sha256, bytes: target.bytes, trainedAt: target.trainedAt, expiresAt: target.expiresAt,
    evaluationDate: target.evaluationDate, promotedAt: now, runId: options.runId, gates: { rollback: true, rolledBackFrom: current.sha256 }, history };
  const manifest = await writeManifest(store, previous, { runId: options.runId, models: { ...previous.models, [key]: entry }, calendars: previous.calendars }, now);
  await copyLegacy(store, key, target.path, options.runId);
  return { executed: true, plan, generation: manifest.generation };
}

/** sha + parse of every object the manifest points at; prints SHA256SUMS lines for the legacy names. */
export async function verifyManifest(store: Store, now = Date.now()) {
  const manifest = await readManifest(store);
  if (!manifest) throw new Error('manifest-missing');
  const problems: string[] = [], sums: string[] = [], models: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(manifest.models) as [ModelKey, ManifestModel][]) {
    const path = store.path(entry.path);
    if (!existsSync(path)) { problems.push(`${key}:missing`); continue; }
    const text = await readFile(path, 'utf8'), sha = sha256Text(text);
    if (sha !== entry.sha256) problems.push(`${key}:sha-mismatch`);
    try { parseModelText(key, text, now); } catch { problems.push(`${key}:parse-failed`); }
    if ((await stat(path)).size !== entry.bytes) problems.push(`${key}:size-mismatch`);
    // The expiry in force: an entry that says more than its file's holiday calendar allows is shown cut (the server cuts it the same way).
    let effective = entry.expiresAt;
    try { if (effective !== null) effective = Math.min(effective, expiryCeiling(entry.trainedAt, text).at); } catch { /* parse-failed above */ }
    const expired = effective !== null && effective <= now;
    models[key] = { version: entry.version, sha256: sha, expiresAt: entry.expiresAt, effectiveExpiresAt: effective, expired, remainingHours: effective === null ? null : Math.round((effective - now) / 36e5) };
    sums.push(`${sha}  ${entry.path}`);
  }
  for (const [year, entry] of Object.entries(manifest.calendars)) {
    const path = store.path(entry.path);
    if (!existsSync(path) || await sha256File(path) !== entry.sha256) problems.push(`calendar-${year}:sha-mismatch`);
    else sums.push(`${entry.sha256}  ${entry.path}`);
  }
  return { ok: problems.length === 0, generation: manifest.generation, problems, models, sha256sums: sums.join('\n') + '\n' };
}
