import { spawn } from 'node:child_process';
import { copyFile, cp, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage, redact, type Logger } from './util';

export interface StepRequest { name: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
export interface StepResult { code: number; stdout: string; stderr: string; ms: number; json: Record<string, unknown> | null }
export type StepRunner = (request: StepRequest) => Promise<StepResult>;
const TAIL = 64 * 1024;

/** Last JSON object a script printed (the scripts print one summary line, or {"error":...} on stderr). */
export function lastJson(text: string): Record<string, unknown> | null {
  for (const line of text.trim().split(/\r?\n/).reverse()) { const value = line.trim(); if (value.startsWith('{')) { try { return JSON.parse(value); } catch { /* keep looking */ } } }
  return null;
}

export const spawnRunner: StepRunner = request => new Promise(done => {
  const started = Date.now(), child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-TAIL); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-TAIL); });
  const timer = setTimeout(() => child.kill('SIGTERM'), request.timeoutMs);
  child.on('error', error => { clearTimeout(timer); done({ code: 127, stdout, stderr: errorMessage(error), ms: Date.now() - started, json: null }); });
  child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr, ms: Date.now() - started, json: (code ? lastJson(stderr) : null) ?? lastJson(stdout) ?? lastJson(stderr) }); });
});

/** Children never see the data.go.kr keys; trainers and preparation need no network. */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) if (!/SERVICE_KEY|API_KEY|SECRET|TOKEN|PASSWORD/i.test(key)) env[key] = value;
  return { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', ...extra } as unknown as NodeJS.ProcessEnv;
}

export async function runLogged(runner: StepRunner, request: StepRequest, log: Logger, fields: Record<string, unknown> = {}): Promise<StepResult> {
  log('INFO', 'step-start', { step: request.name, ...fields });
  const result = await runner(request);
  const text = result.json ? redact(JSON.stringify(result.json)) : null;
  const summary = text === null ? null : text.length <= 4000 ? JSON.parse(text) : { truncated: true, keys: Object.keys(result.json!).slice(0, 40) };
  log(result.code === 0 ? 'INFO' : 'WARNING', 'step-end', { step: request.name, code: result.code, ms: result.ms, result: summary, ...(result.code ? { stderr: redact(result.stderr).slice(-600) } : {}), ...fields });
  return result;
}

/** Same filesystem: hard link (no extra space). Across filesystems (bucket mount → memory disk): copy. */
export async function stageFile(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  if (existsSync(target)) { const [a, b] = await Promise.all([stat(source), stat(target)]); if (a.size === b.size) return; await rm(target, { force: true }); }
  try { await link(source, target); } catch { await copyFile(source, target); }
}
export async function copyTree(source: string, target: string) { await mkdir(dirname(target), { recursive: true }); await cp(source, target, { recursive: true, force: true }); }
export async function listFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) found.push(...await listFiles(path)); else found.push(path);
  }
  return found;
}
