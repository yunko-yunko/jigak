import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const HOUR = 3_600_000, DAY = 86_400_000, KST_OFFSET = 9 * HOUR;
export const sha256Text = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
/** KST calendar date (YYYY-MM-DD) of an instant. */
export const kstDate = (at: number) => new Date(at + KST_OFFSET).toISOString().slice(0, 10);
/** ISO string with the +09:00 offset, the form the manifest and status use. */
export const kstIso = (at: number) => new Date(at + KST_OFFSET).toISOString().replace('Z', '+09:00');
/** 20261103T0541 in KST, used in immutable model file names. */
export const kstStamp = (at: number) => new Date(at + KST_OFFSET).toISOString().slice(0, 16).replace(/[-:]/g, '');
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
/** Start of a card service day: 04:00 KST. */
export const serviceDayStart = (date: string) => Date.parse(`${date}T04:00:00+09:00`);

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Write to a sibling temporary name, then rename. On a local disk the rename is atomic; on a
 * Cloud Storage FUSE mount the final object is uploaded in one write, so readers see the old or the new object.
 */
export async function writeAtomic(path: string, contents: string | Buffer, tag = `${process.pid}`): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${tag}`;
  try { await writeFile(temporary, contents); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export const writeJsonAtomic = (path: string, value: unknown, tag?: string) => writeAtomic(path, JSON.stringify(value, null, 2) + '\n', tag);

export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'ALERT';
export interface Logger { (severity: Severity, event: string, fields?: Record<string, unknown>): void; lines: Record<string, unknown>[] }
/** One JSON object per line on stdout; Cloud Logging parses severity and jsonPayload from it. Never pass keys or .env values. */
export function createLogger(runId: string, sink: (line: string) => void = line => process.stdout.write(line + '\n')): Logger {
  const lines: Record<string, unknown>[] = [];
  const log = ((severity: Severity, event: string, fields: Record<string, unknown> = {}) => {
    const entry = { severity, event, runId, time: new Date().toISOString(), ...fields };
    lines.push(entry); sink(JSON.stringify(entry));
  }) as Logger;
  log.lines = lines;
  return log;
}

/** Redact anything that looks like a data.go.kr key from a message before it is logged. */
export function redact(text: string, secrets: readonly (string | undefined)[] = [process.env.DATA_GO_KR_SERVICE_KEY, process.env.DATA_GO_KR_SERVICE_KEY_FALLBACK]): string {
  let value = text;
  for (const secret of secrets) if (secret) { value = value.split(secret).join('<key>').split(encodeURIComponent(secret)).join('<key>'); }
  return value.replace(/serviceKey=[^&\s]+/gi, 'serviceKey=<key>');
}
export const errorMessage = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
