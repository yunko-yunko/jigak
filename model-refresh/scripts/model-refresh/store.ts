import { open, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { writeJsonAtomic } from './util';

/** Health keys; the same names the backend uses under /api/health models.* */
export const MODEL_KEYS = ['publicBus', 'spatialBus', 'railGate', 'bicycleRide', 'bicycleRideTimes'] as const;
export type ModelKey = typeof MODEL_KEYS[number];
/** Fixed names that older service revisions read through ETA_*_PATH. */
export const LEGACY_NAMES: Record<ModelKey, string> = {
  publicBus: 'public-bus-operational.json', spatialBus: 'spatial-bus-operational.json', railGate: 'rail-gate-operational.json',
  bicycleRide: 'spatial-bicycle-operational.json', bicycleRideTimes: 'bicycle-ride-times-202606.json',
};
/** Evaluation-day journals the trainers and the public bus refresh keep. Each day may be inspected once. */
export const JOURNALS = {
  publicBus: 'public-bus-refresh-evaluations', spatialBus: 'spatial-bus-evaluations.json',
  railGate: 'rail-gate-evaluations.json', bicycleRide: 'spatial-bicycle-evaluations.json',
} as const;

/** Every path the pipeline touches, relative to one store root (a local folder or the gcsfuse mount of the bucket). */
export class Store {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  path(...parts: string[]) { return resolve(this.root, ...parts); }
  rel(path: string) { const child = relative(this.root, path); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('outside-store'); return child.split('\\').join('/'); }
  get manifest() { return this.path('manifest.json'); }
  get status() { return this.path('refresh-status.json'); }
  get lock() { return this.path('locks', 'refresh.lock'); }
  get journals() { return this.path('journals'); }
  get calendars() { return this.path('calendars'); }
  get taims() { return this.path('raw', 'taims'); }
  get taimsIndex() { return this.path('raw', 'taims', 'index.json'); }
  get context() { return this.path('raw', 'context'); }
  /** Fixed training inputs (road priors, station coordinates). Outside raw/, whose objects the bucket deletes after 21 days. */
  get static() { return this.path('static'); }
  get seed() { return this.path('seed'); }
  runDir(runId: string) { return this.path('runs', runId); }
  candidateDir(key: string, evalDate: string) { return this.path('candidates', key, evalDate); }
  legacy(key: ModelKey) { return this.path('legacy', LEGACY_NAMES[key]); }
}

export interface LockBody { runId: string; startedAt: number; heartbeatAt: number; pid: number }
export const LOCK_STALE_MS = 30 * 60_000, HEARTBEAT_MS = 5 * 60_000;

/**
 * Exclusive create of locks/refresh.lock. A lock whose heartbeat stopped for 30 minutes belongs to a dead
 * execution and may be taken over; otherwise the caller exits 0 with skipped-locked.
 */
export async function acquireLock(store: Store, runId: string, now = Date.now()): Promise<{ acquired: true; tookOverFrom?: string } | { acquired: false; holder: LockBody | null }> {
  await mkdir(dirname(store.lock), { recursive: true });
  const body: LockBody = { runId, startedAt: now, heartbeatAt: now, pid: process.pid };
  const create = async () => { const file = await open(store.lock, 'wx'); try { await file.writeFile(JSON.stringify(body) + '\n'); } finally { await file.close(); } };
  try { await create(); return { acquired: true }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  let holder: LockBody | null = null;
  try { holder = JSON.parse(await readFile(store.lock, 'utf8')); } catch { holder = null; }
  const beat = holder?.heartbeatAt ?? (await stat(store.lock).catch(() => null))?.mtimeMs ?? now;
  if (now - beat <= LOCK_STALE_MS) return { acquired: false, holder };
  await rm(store.lock, { force: true });
  try { await create(); return { acquired: true, tookOverFrom: holder?.runId ?? 'unreadable' }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { acquired: false, holder }; throw error; }
}

export async function heartbeat(store: Store, runId: string, now = Date.now()): Promise<boolean> {
  let current: LockBody;
  try { current = JSON.parse(await readFile(store.lock, 'utf8')); } catch { return false; }
  if (current.runId !== runId) return false;
  await writeJsonAtomic(store.lock, { ...current, heartbeatAt: now }, runId);
  return true;
}

export async function releaseLock(store: Store, runId: string): Promise<void> {
  if (!existsSync(store.lock)) return;
  try { const current = JSON.parse(await readFile(store.lock, 'utf8')) as LockBody; if (current.runId !== runId) return; } catch { return; }
  await rm(store.lock, { force: true });
}
