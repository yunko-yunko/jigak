import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * Production models are not files at fixed paths: the refresh job writes immutable model files
 * into a bucket and switches the one `manifest.json` that points at them. The service mounts that
 * bucket read-only and follows the pointer. This module owns the pointer's schema, the checks a
 * newly pointed-at file must pass before it replaces the model in use, and the health summary of
 * the refresh job. Without MODEL_MANIFEST_PATH nothing here is used and the ETA_*_PATH files work
 * exactly as before.
 */

export const MODEL_MANIFEST_SCHEMA = 'jigak-model-manifest-v1' as const;
export const MODEL_KEYS = [
  'publicBus',
  'spatialBus',
  'railGate',
  'bicycleRide',
  'bicycleRideTimes',
] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/**
 * A model's file says it lives 7 days. The refresh job may extend that through the manifest ("revalidated": the model in
 * service was measured again on a fresh evaluation day and still passes the absolute gates) without rewriting the file. The
 * extension is capped: a manifest never keeps a model alive more than this long after it was trained.
 */
export const MANIFEST_MAX_MODEL_AGE_MS = 28 * DAY;

/** Late service a request may still board: the promoters keep the calendar through seoulDate(expiresAt + 4 h). */
export const LATE_SERVICE_MS = 4 * HOUR;

/**
 * The latest expiry the holiday calendar inside a checkpoint allows: a request then may board up to LATE_SERVICE_MS later and
 * must still find its day type, so 4 h before KST midnight after the calendar's last date. A file whose own life keeps less
 * margin (the bicycle model ends at that midnight) keeps its own life. null: the model has no calendar.
 */
export function calendarEndOf(model: unknown): number | null {
  const value = model as { expiresAt?: unknown; calendar?: { lastDate?: unknown } } | null;
  const lastDate = value?.calendar?.lastDate;
  if (typeof lastDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) return null;
  const midnight = Date.parse(`${lastDate}T00:00:00+09:00`) + DAY;
  const own = typeof value?.expiresAt === 'number' ? value.expiresAt : -Infinity;
  return Number.isFinite(midnight)
    ? Math.max(Math.min(own, midnight), midnight - LATE_SERVICE_MS)
    : null;
}

/** A model whose life ends within this long and whose refresh keeps failing is a degraded service. */
export const MODEL_ALARM_WINDOW_MS = 48 * HOUR;
/** The last refresh run is stale when it finished longer ago than this (three runs a day). */
export const REFRESH_STALE_AFTER_MS = 26 * HOUR;
/** 7-day models open their refresh window this long before expiry; the bicycle model follows its holiday review. */
export const REFRESH_OPENS_BEFORE_EXPIRY_MS: Record<ModelKey, number> = {
  publicBus: 120 * HOUR,
  spatialBus: 120 * HOUR,
  railGate: 120 * HOUR,
  bicycleRide: 10 * DAY,
  bicycleRideTimes: 0,
};
/** The refresh job's Cloud Scheduler slots, KST (30 5,9,13 * * *). MODEL_REFRESH_SCHEDULE_KST overrides. */
export const DEFAULT_REFRESH_SCHEDULE_KST = '05:30,09:30,13:30';

export class ManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManifestError';
  }
}

const sha256Field = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.union([z.number().finite(), z.string().min(1)]);
const historyEntry = z
  .object({
    version: z.string().min(1),
    path: z.string().min(1).nullish(),
    sha256: sha256Field.nullish(),
    trainedAt: timestamp.nullish(),
    expiresAt: timestamp.nullish(),
    promotedAt: timestamp.nullish(),
    retiredAt: timestamp.nullish(),
  })
  .passthrough();
const modelEntry = z
  .object({
    version: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Field,
    bytes: z.number().int().nonnegative().nullish(),
    trainedAt: timestamp.nullish(),
    expiresAt: timestamp.nullish(),
    evaluationDate: z.string().nullish(),
    promotedAt: timestamp.nullish(),
    revalidatedAt: timestamp.nullish(),
    gates: z.unknown().optional(),
    history: z.array(historyEntry).max(32).optional(),
  })
  .passthrough();
const calendarEntry = z
  .object({
    path: z.string().min(1),
    sha256: sha256Field,
    reviewAfter: z.string().nullish(),
    source: z.string().nullish(),
    verifiedAt: z.string().nullish(),
  })
  .passthrough();
const manifestSchema = z
  .object({
    schema: z.literal(MODEL_MANIFEST_SCHEMA),
    generation: z.number().int().min(1),
    updatedAt: z.string().nullish(),
    runId: z.string().nullish(),
    models: z.record(z.string(), modelEntry),
    calendars: z.record(z.string().regex(/^\d{4}$/), calendarEntry).default({}),
  })
  .passthrough();

/** Milliseconds from a number or an ISO string; null when it is neither. */
export function toMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface ManifestModel {
  key: string;
  version: string;
  /** Absolute path under the manifest's folder. */
  path: string;
  sha256: string;
  bytes: number | null;
  trainedAt: number | null;
  expiresAt: number | null;
  promotedAt: number | null;
  /** Set when the refresh job extended the expiry of this very file after measuring it on a newer day. */
  revalidatedAt: number | null;
  evaluationDate: string | null;
  previousVersion: string | null;
}
export interface ManifestCalendar {
  year: number;
  path: string;
  sha256: string;
  reviewAfter: string | null;
  source: string | null;
  verifiedAt: string | null;
}
export interface ParsedManifest {
  generation: number;
  updatedAt: string | null;
  runId: string | null;
  models: Map<string, ManifestModel>;
  calendars: Map<number, ManifestCalendar>;
}

/** A manifest path is relative to the manifest's folder and never leaves it. */
function insideBase(baseDir: string, value: string): string {
  if (isAbsolute(value) || value.includes('\0')) throw new ManifestError('manifest-path-invalid');
  const base = resolve(baseDir),
    target = resolve(base, value),
    rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..'))
    throw new ManifestError('manifest-path-invalid');
  return target;
}

/** Schema check and path resolution. Does not touch the model files; the loader hashes those when it reads them. */
export function parseManifest(text: string, baseDir: string): ParsedManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ManifestError('manifest-not-json');
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) throw new ManifestError('manifest-schema-invalid');
  const manifest = result.data;
  const models = new Map<string, ManifestModel>();
  for (const [key, entry] of Object.entries(manifest.models)) {
    models.set(key, {
      key,
      version: entry.version,
      path: insideBase(baseDir, entry.path),
      sha256: entry.sha256,
      bytes: entry.bytes ?? null,
      trainedAt: toMs(entry.trainedAt),
      expiresAt: toMs(entry.expiresAt),
      promotedAt: toMs(entry.promotedAt),
      revalidatedAt: toMs(entry.revalidatedAt),
      evaluationDate: entry.evaluationDate ?? null,
      previousVersion: entry.history?.[0]?.version ?? null,
    });
  }
  const calendars = new Map<number, ManifestCalendar>();
  for (const [year, entry] of Object.entries(manifest.calendars)) {
    calendars.set(Number(year), {
      year: Number(year),
      path: insideBase(baseDir, entry.path),
      sha256: entry.sha256,
      reviewAfter: entry.reviewAfter ?? null,
      source: entry.source ?? null,
      verifiedAt: entry.verifiedAt ?? null,
    });
  }
  return {
    generation: manifest.generation,
    updatedAt: manifest.updatedAt ?? null,
    runId: manifest.runId ?? null,
    models,
    calendars,
  };
}

// ---------------------------------------------------------------------------------------------
// What the model services read instead of a fixed path

/** Where a model file is and, when a manifest points at it, what it must hash to. */
export interface ModelFileRef {
  path: string;
  /** Present only for manifest files; a mismatch means the file is not the one that was promoted. */
  sha256?: string;
  manifest?: Pick<ManifestModel, 'version' | 'promotedAt' | 'previousVersion' | 'revalidatedAt'> & {
    generation: number;
  };
  /** The manifest's expiry for this file (epoch ms); it replaces the one inside the model file. */
  expiresAt?: number | null;
}
export type ModelPathSource = string | (() => ModelFileRef | null);

export interface ModelProvenance {
  source: 'manifest' | 'env';
  sha256: string;
  manifestGeneration: number | null;
  promotedAt: number | null;
  previousVersion: string | null;
  /**
   * 'manifest' when the manifest's expiresAt (possibly a revalidation) is the one in force; 'calendar' when the file's holiday
   * calendar ends before what the manifest or the file says, so the model stops there.
   */
  expirySource: 'manifest' | 'file' | 'calendar';
  revalidatedAt: number | null;
}
export interface LoadedModel<T> {
  model?: T;
  /** Why there is no model; empty while one is loaded. */
  reason: string;
  provenance: ProvenanceOrNull;
  /** A newer manifest file that was refused while the loaded model stays in use. */
  candidate:
    'manifest-sha-mismatch' | 'manifest-candidate-invalid' | 'manifest-candidate-missing' | null;
}
type ProvenanceOrNull = ModelProvenance | null;

/** The health fields every model status carries, whether it came from a manifest or an env path. */
export function provenanceFields(state: Pick<LoadedModel<unknown>, 'provenance' | 'candidate'>) {
  const p = state.provenance;
  return {
    // Not "source": a model status already carries its training source under that name.
    origin: p?.source ?? null,
    sha256: p?.sha256 ?? null,
    manifestGeneration: p?.manifestGeneration ?? null,
    promotedAt: p?.promotedAt ?? null,
    previousVersion: p?.previousVersion ?? null,
    expirySource: p?.expirySource ?? null,
    revalidatedAt: p?.revalidatedAt ?? null,
  };
}
/** The reasons to append when a refused candidate sits next to a model that is still in use. */
export const candidateReasons = (state: Pick<LoadedModel<unknown>, 'candidate'>) =>
  state.candidate ? [state.candidate] : [];

export const modelRef = (source: ModelPathSource): ModelFileRef | null =>
  typeof source === 'string' ? { path: source } : source();

/**
 * Reads one served model file and keeps the previous model when a newly pointed-at file is wrong.
 * An env path keeps today's behaviour exactly: a missing file is "missing-checkpoint", a broken or
 * oversize one clears the model. A manifest file is hashed first; a hash mismatch, a file that does
 * not parse, or a file that is not there yet leaves the old model serving and names the reason.
 */
export class ModelFileLoader<T extends { trainedAt: number; expiresAt: number }> {
  private model?: T;
  /** The model as parsed from the file; `model` is this with the manifest's expiry applied. */
  private parsedModel?: T;
  private appliedExpiry: number | null = null;
  private reason = 'missing-checkpoint';
  private provenance: ProvenanceOrNull = null;
  private candidate: LoadedModel<T>['candidate'] = null;
  private loadedKey = '';
  private refusedKey = '';

  constructor(
    private readonly options: {
      source: ModelPathSource;
      maxBytes: number;
      parse: (text: string, now: number) => T;
      /** Reason reported for a legacy file that is oversize or does not parse. */
      invalidReason?: string;
    },
  ) {}

  /** File and expected hash: a new hash for the same path is a new candidate. */
  private prefixOf(ref: ModelFileRef) {
    return `${ref.path}|${ref.sha256 ?? ''}|`;
  }

  private keyOf(ref: ModelFileRef, mtimeMs: number) {
    return `${this.prefixOf(ref)}${mtimeMs}`;
  }

  /** True when the manifest now points at a file other than the one loaded, so the 30 s throttle must not delay the switch. */
  pending(): boolean {
    const ref = modelRef(this.options.source);
    if (!ref || ref.sha256 === undefined) return false;
    // A refused candidate the manifest has moved back from must clear without waiting for the throttle.
    if (this.loadedKey.startsWith(this.prefixOf(ref)))
      return this.candidate !== null || this.expiryFor(ref).at !== this.appliedExpiry;
    return !this.refusedKey.startsWith(this.prefixOf(ref));
  }

  /**
   * The expiry in force: for a manifest file the manifest's own value, never later than MANIFEST_MAX_MODEL_AGE_MS after the
   * model was trained; for any file never past the end of the holiday calendar it carries. at null: keep what the file says.
   */
  private expiryFor(ref: ModelFileRef): {
    at: number | null;
    source: ModelProvenance['expirySource'];
  } {
    const model = this.parsedModel;
    if (!model) return { at: null, source: 'file' };
    const declared =
      ref.sha256 !== undefined &&
      typeof ref.expiresAt === 'number' &&
      Number.isFinite(ref.expiresAt)
        ? Math.min(ref.expiresAt, model.trainedAt + MANIFEST_MAX_MODEL_AGE_MS)
        : model.expiresAt;
    const calendarEnd = calendarEndOf(model);
    const effective = calendarEnd === null ? declared : Math.min(declared, calendarEnd);
    if (effective === model.expiresAt) return { at: null, source: 'file' };
    return { at: effective, source: effective < declared ? 'calendar' : 'manifest' };
  }

  private applyExpiry(ref: ModelFileRef, firstLoad = false) {
    const { at: expiry, source } = this.expiryFor(ref);
    if (!this.parsedModel) return;
    const revalidatedAt = ref.manifest?.revalidatedAt ?? null;
    // Same file, different manifest entry (an extension, or a rollback to the extended entry): show the generation that did it.
    const entryChanged =
      firstLoad || expiry !== this.appliedExpiry || revalidatedAt !== this.provenance?.revalidatedAt;
    this.appliedExpiry = expiry;
    this.model = expiry === null ? this.parsedModel : { ...this.parsedModel, expiresAt: expiry };
    if (this.provenance)
      this.provenance = {
        ...this.provenance,
        ...(entryChanged && ref.manifest
          ? {
              manifestGeneration: ref.manifest.generation,
              promotedAt: ref.manifest.promotedAt,
              previousVersion: ref.manifest.previousVersion,
            }
          : {}),
        expirySource: source,
        revalidatedAt,
      };
  }

  state(): LoadedModel<T> {
    return {
      model: this.model,
      reason: this.model ? '' : this.reason,
      provenance: this.provenance,
      candidate: this.candidate,
    };
  }

  read(now: number): LoadedModel<T> {
    const ref = modelRef(this.options.source);
    if (!ref) {
      this.clear('manifest-entry-missing');
      return this.state();
    }
    const fromManifest = ref.sha256 !== undefined;
    const refuse = (reason: NonNullable<LoadedModel<T>['candidate']>, key: string) => {
      if (this.model) {
        this.candidate = reason;
        this.refusedKey = key;
      } else {
        this.clear(reason);
        this.refusedKey = key;
      }
    };
    try {
      if (!existsSync(ref.path)) {
        if (fromManifest && this.model) {
          this.candidate = 'manifest-candidate-missing';
          this.refusedKey = `${this.prefixOf(ref)}missing`;
        } else this.clear('missing-checkpoint');
        return this.state();
      }
      const info = statSync(ref.path);
      if (!info.isFile() || info.size > this.options.maxBytes)
        throw new Error('invalid-checkpoint');
      const key = this.keyOf(ref, info.mtimeMs);
      if (key === this.loadedKey) {
        this.candidate = null;
        // Same file, new expiry: a revalidation changes the manifest only.
        this.applyExpiry(ref);
        return this.state();
      }
      if (fromManifest && key === this.refusedKey) return this.state();
      const bytes = readFileSync(ref.path);
      const digest = sha256Hex(bytes);
      if (fromManifest && digest !== ref.sha256) {
        refuse('manifest-sha-mismatch', key);
        return this.state();
      }
      let parsed: T;
      try {
        parsed = this.options.parse(bytes.toString('utf8'), now);
      } catch {
        if (!fromManifest) throw new Error('invalid-checkpoint');
        refuse('manifest-candidate-invalid', key);
        return this.state();
      }
      this.parsedModel = parsed;
      this.model = parsed;
      this.loadedKey = key;
      this.refusedKey = '';
      this.candidate = null;
      this.reason = '';
      this.provenance = {
        source: fromManifest ? 'manifest' : 'env',
        sha256: digest,
        manifestGeneration: ref.manifest?.generation ?? null,
        promotedAt: ref.manifest?.promotedAt ?? null,
        previousVersion: ref.manifest?.previousVersion ?? null,
        expirySource: 'file',
        revalidatedAt: null,
      };
      this.applyExpiry(ref, true);
    } catch {
      if (fromManifest) refuse('manifest-candidate-invalid', `${this.prefixOf(ref)}unreadable`);
      else this.clear(this.options.invalidReason ?? 'invalid-checkpoint');
    }
    return this.state();
  }

  private clear(reason: string) {
    this.model = undefined;
    this.parsedModel = undefined;
    this.appliedExpiry = null;
    this.provenance = null;
    this.candidate = null;
    this.loadedKey = '';
    this.refusedKey = '';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------
// The manifest watcher

export interface CalendarFile {
  year: number;
  text: string;
  source: string | null;
  reviewAfter: string | null;
}

export interface ManifestWatcherOptions {
  manifestPath: string;
  pollSeconds?: number;
  now?: () => number;
  /** Called with the verified holiday files whenever the manifest's set changes. Throw to refuse them. */
  onCalendars?: (files: CalendarFile[], previous: CalendarFile[]) => void;
  /** Env paths to fall back on when the manifest has no entry for a key. */
  fallbackPaths?: Partial<Record<ModelKey, string | undefined>>;
}

/** Follows manifest.json: re-reads it when its mtime or size changes, never replaces a good manifest with a bad one. */
export class ManifestWatcher {
  private manifest: ParsedManifest | null = null;
  private fingerprint = '';
  private checkedAt = -Infinity;
  private error: string | null = null;
  private calendarSet = '';
  private calendarFiles: CalendarFile[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly pollMs: number;
  readonly baseDir: string;

  constructor(private readonly options: ManifestWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.pollMs = Math.max(1, options.pollSeconds ?? 60) * 1000;
    this.baseDir = dirname(resolve(options.manifestPath));
    this.poll();
  }

  /** Polls on a timer so calendars and idle instances follow the bucket too; the timer never keeps the process alive. */
  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), this.pollMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Cheap enough to call on every read: re-checks at most once per poll interval. */
  ensureFresh() {
    const now = this.now();
    if (now >= this.checkedAt && now - this.checkedAt < this.pollMs) return;
    this.poll();
  }

  poll() {
    this.checkedAt = this.now();
    try {
      const path = resolve(this.options.manifestPath);
      if (!existsSync(path)) throw new ManifestError('manifest-missing');
      const info = statSync(path);
      if (!info.isFile() || info.size > 1_048_576)
        throw new ManifestError('manifest-schema-invalid');
      const fingerprint = `${info.mtimeMs}|${info.size}`;
      if (fingerprint === this.fingerprint && this.manifest) {
        this.error = null;
        return;
      }
      const next = parseManifest(readFileSync(path, 'utf8'), this.baseDir);
      if (this.manifest && next.generation < this.manifest.generation)
        throw new ManifestError('manifest-generation-regressed');
      this.fingerprint = fingerprint;
      this.manifest = next;
      this.error = null;
    } catch (caught) {
      // A bad or unreachable manifest never removes a good one: models in use keep serving.
      this.error = caught instanceof ManifestError ? caught.code : 'manifest-unreadable';
    }
    this.applyCalendars();
  }

  private applyCalendars() {
    const manifest = this.manifest;
    if (!manifest || !this.options.onCalendars) return;
    const signature = [...manifest.calendars.values()]
      .map((entry) => `${entry.year}:${entry.sha256}`)
      .sort()
      .join(',');
    if (signature === this.calendarSet) return;
    if (!manifest.calendars.size) {
      this.calendarSet = signature;
      return;
    }
    try {
      const files: CalendarFile[] = [];
      for (const entry of [...manifest.calendars.values()].sort((a, b) => a.year - b.year)) {
        const text = readFileSync(entry.path, 'utf8');
        if (sha256Hex(text) !== entry.sha256)
          throw new ManifestError('manifest-calendar-sha-mismatch');
        files.push({
          year: entry.year,
          text,
          source: entry.source,
          reviewAfter: entry.reviewAfter,
        });
      }
      this.options.onCalendars(files, this.calendarFiles);
      this.calendarFiles = files;
      this.calendarSet = signature;
      if (this.error === 'manifest-calendar-invalid') this.error = null;
    } catch {
      // Keep the calendars already in use (or the ones shipped in the image).
      this.calendarSet = '';
      this.error ??= 'manifest-calendar-invalid';
    }
  }

  get generation(): number | null {
    return this.manifest?.generation ?? null;
  }

  /** The newest error since the last good read; the manifest in use is unaffected. */
  get lastError(): string | null {
    return this.error;
  }

  get current(): ParsedManifest | null {
    this.ensureFresh();
    return this.manifest;
  }

  appliedCalendars(): CalendarFile[] {
    return this.calendarFiles;
  }

  /** What a model service reads in place of a fixed path. null: nothing configured for this key. */
  ref(key: ModelKey): ModelFileRef | null {
    const manifest = this.current;
    const entry = manifest?.models.get(key);
    if (manifest && entry)
      return {
        path: entry.path,
        sha256: entry.sha256,
        expiresAt: entry.expiresAt,
        manifest: {
          generation: manifest.generation,
          version: entry.version,
          promotedAt: entry.promotedAt,
          previousVersion: entry.previousVersion,
          revalidatedAt: entry.revalidatedAt,
        },
      };
    const fallback = this.options.fallbackPaths?.[key];
    return fallback ? { path: fallback } : null;
  }

  source(key: ModelKey): () => ModelFileRef | null {
    return () => this.ref(key);
  }

  /** The verified path of a file that is read once at startup (the measured bicycle table). */
  verifiedPath(key: ModelKey): string | null {
    const ref = this.ref(key);
    if (!ref) return null;
    if (ref.sha256 === undefined) return ref.path;
    try {
      return sha256Hex(readFileSync(ref.path)) === ref.sha256 ? ref.path : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The refresh job's own report (refresh-status.json) and the health summary built from it

const modelRunSchema = z
  .object({
    refreshOpensAt: timestamp.optional(),
    nextAttemptAt: timestamp.optional(),
    consecutiveFailures: z.number().int().min(0).optional(),
    lastFailureReason: z.string().nullable().optional(),
    lastAttemptAt: timestamp.optional(),
    state: z.string().optional(),
    lastAttempt: z
      .object({
        evaluationDate: z.string().nullish(),
        outcome: z.string().optional(),
        reason: z.string().optional(),
        at: timestamp.optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
const refreshStatusSchema = z
  .object({
    runId: z.string().optional(),
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    outcome: z.string().optional(),
    nextScheduledAt: timestamp.optional(),
    models: z.record(z.string(), modelRunSchema).default({}),
  })
  .passthrough();

export interface ModelRefreshModelState {
  expiresAt: number | null;
  active: boolean;
  remainingSeconds: number | null;
  refreshOpensAt: number | null;
  nextAttemptAt: number | null;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  /** What the last attempt ended in: promoted, revalidated (the model in service was kept and its expiry extended), closed, failed ... */
  lastAttempt: { outcome: string | null; reason: string | null; evaluationDate: string | null; at: number | null } | null;
}
export type ModelRefreshStatus = 'ok' | 'stale' | 'degraded' | 'unconfigured';
export interface ModelRefreshSummary {
  status: ModelRefreshStatus;
  reasons: string[];
  manifest: {
    generation: number | null;
    updatedAt: string | null;
    runId: string | null;
    error: string | null;
  };
  lastRun: { runId: string | null; finishedAt: number | null; outcome: string | null } | null;
  nextScheduledAt: number | null;
  models: Record<string, ModelRefreshModelState>;
  calendars: Record<string, { source: string | null; reviewAfter: string | null }>;
}

/** The next slot of an "HH:MM,HH:MM" KST schedule strictly after `after`. */
export function nextScheduledSlot(after: number, schedule = DEFAULT_REFRESH_SCHEDULE_KST): number {
  const slots = schedule
    .split(',')
    .map((part) => /^(\d{1,2}):(\d{2})$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]) * 60 + Number(m[2]))
    .filter((minutes) => minutes < 24 * 60)
    .sort((a, b) => a - b);
  if (!slots.length) return nextScheduledSlot(after, DEFAULT_REFRESH_SCHEDULE_KST);
  const kstDayStart = Math.floor((after + 9 * HOUR) / DAY) * DAY - 9 * HOUR;
  for (let day = 0; day < 3; day++)
    for (const minutes of slots) {
      const at = kstDayStart + day * DAY + minutes * 60_000;
      if (at > after) return at;
    }
  return after + DAY;
}

export class ModelRefreshMonitor {
  private cached: {
    fingerprint: string;
    value: z.infer<typeof refreshStatusSchema> | null;
  } | null = null;
  private checkedAt = -Infinity;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      watcher: ManifestWatcher | null;
      statusPath?: string;
      schedule?: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  private readStatus(): z.infer<typeof refreshStatusSchema> | null {
    const path = this.options.statusPath;
    if (!path) return null;
    const now = this.now();
    if (this.cached && now >= this.checkedAt && now - this.checkedAt < 10_000)
      return this.cached.value;
    this.checkedAt = now;
    try {
      if (!existsSync(path)) {
        this.cached = { fingerprint: '', value: null };
        return null;
      }
      const info = statSync(path);
      const fingerprint = `${info.mtimeMs}|${info.size}`;
      if (this.cached?.fingerprint === fingerprint) return this.cached.value;
      if (info.size > 1_048_576) throw new Error('refresh-status-too-large');
      const parsed = refreshStatusSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      this.cached = { fingerprint, value: parsed.success ? parsed.data : null };
    } catch {
      // Keep the last good report; an unreadable one is shown as missing only if there never was one.
      this.cached ??= { fingerprint: '', value: null };
    }
    return this.cached.value;
  }

  summarize(
    models: Partial<Record<ModelKey, { expiresAt: number | null; active: boolean }>>,
  ): ModelRefreshSummary {
    const watcher = this.options.watcher;
    const now = this.now();
    if (!watcher) {
      return {
        status: 'unconfigured',
        reasons: ['model-manifest-not-configured'],
        manifest: { generation: null, updatedAt: null, runId: null, error: null },
        lastRun: null,
        nextScheduledAt: null,
        models: {},
        calendars: {},
      };
    }
    const manifest = watcher.current;
    const report = this.readStatus();
    const reasons: string[] = [];
    const finishedAt = toMs(report?.finishedAt);
    const nextSlot = nextScheduledSlot(now, this.options.schedule);
    const reported = toMs(report?.nextScheduledAt);
    const nextScheduledAt = reported !== null && reported > now ? reported : nextSlot;
    const states: Record<string, ModelRefreshModelState> = {};
    let degraded = false;
    for (const key of MODEL_KEYS) {
      if (key === 'bicycleRideTimes') continue;
      const live = models[key];
      const expiresAt = live?.expiresAt ?? manifest?.models.get(key)?.expiresAt ?? null;
      const run = report?.models[key];
      const opensAt =
        toMs(run?.refreshOpensAt) ??
        (expiresAt === null ? null : expiresAt - REFRESH_OPENS_BEFORE_EXPIRY_MS[key]);
      const failures = run?.consecutiveFailures ?? 0;
      const remainingMs = expiresAt === null ? null : expiresAt - now;
      const active = live?.active ?? (remainingMs !== null && remainingMs > 0);
      states[key] = {
        expiresAt,
        active,
        remainingSeconds: remainingMs === null ? null : Math.max(0, Math.floor(remainingMs / 1000)),
        refreshOpensAt: opensAt,
        nextAttemptAt:
          toMs(run?.nextAttemptAt) ??
          (opensAt === null
            ? null
            : nextScheduledSlot(Math.max(now, opensAt) - 1, this.options.schedule)),
        consecutiveFailures: failures,
        lastFailureReason: run?.lastFailureReason ?? null,
        lastAttempt: run?.lastAttempt
          ? {
              outcome: run.lastAttempt.outcome ?? null,
              reason: run.lastAttempt.reason ?? null,
              evaluationDate: run.lastAttempt.evaluationDate ?? null,
              at: toMs(run.lastAttempt.at),
            }
          : null,
      };
      if (live && manifest?.models.has(key)) {
        if (remainingMs !== null && remainingMs <= 0) {
          degraded = true;
          reasons.push(`${key}-expired`);
        } else if (!live.active) {
          degraded = true;
          reasons.push(`${key}-inactive`);
        } else if (remainingMs !== null && remainingMs < MODEL_ALARM_WINDOW_MS && failures > 0) {
          degraded = true;
          reasons.push(`${key}-refresh-failing-near-expiry`);
        }
      }
    }
    if (!manifest) {
      degraded = true;
      reasons.push(watcher.lastError ?? 'manifest-unavailable');
    } else if (watcher.lastError) reasons.push(watcher.lastError);
    let stale = false;
    if (!report) {
      stale = true;
      reasons.push('refresh-status-missing');
    } else if (finishedAt === null || now - finishedAt > REFRESH_STALE_AFTER_MS) {
      stale = true;
      reasons.push('last-run-older-than-26h');
    }
    const calendars: ModelRefreshSummary['calendars'] = {};
    for (const [year, entry] of manifest?.calendars ?? [])
      calendars[String(year)] = { source: entry.source, reviewAfter: entry.reviewAfter };
    return {
      status: degraded ? 'degraded' : stale ? 'stale' : 'ok',
      reasons,
      manifest: {
        generation: manifest?.generation ?? null,
        updatedAt: manifest?.updatedAt ?? null,
        runId: manifest?.runId ?? null,
        error: watcher.lastError,
      },
      lastRun: report
        ? {
            runId: report.runId ?? null,
            finishedAt,
            outcome: report.outcome ?? null,
          }
        : null,
      nextScheduledAt,
      models: states,
      calendars,
    };
  }
}

/** Default report location: next to the manifest. */
export const defaultRefreshStatusPath = (manifestPath: string) =>
  join(dirname(resolve(manifestPath)), 'refresh-status.json');
