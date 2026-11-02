import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { dataFile } from './calendar.js';
import type { Fleets } from './sim-engine.js';
import { WINDOW_COLUMNS, windowColumn, type WindowData, type WindowMeta } from './sim-window.js';

/**
 * Computed windows kept on disk (§22): a restart, a deploy or a new instance reads the day's
 * window in about 0.1 s instead of simulating it again. A file is used only when its key, its
 * inputs, every column's sha-256 and the zstd checksum all match; anything else is a miss.
 */
export const WINDOW_FORMAT = 1;

const MAGIC = 'JGSW';
const SUFFIX = '.simwin.zst';
const HOUR_MS = 3_600_000;
/** Files of this many days around today are kept; GCS lifecycle deletes the rest after 7 days. */
const KEEP_FILES = 12;

/** Simulator files that only read a window: their bytes never change one. */
const CONSUMERS = new Set([
  'scooter-policy',
  'scooter-router',
  'simulated-vehicle-feed',
  'window-store',
]);
/** Every data file the simulator reads (`dataFile`); the model version names only some of them. */
export const WINDOW_DATA_FILES: readonly string[] = [
  'shared-mobility-demand-v1.json',
  'seoul-pm-parking-rules-v1.json',
  'shared-mobility-door-points-v1.json',
  'shared-mobility-return-rules-v1.json',
  'shared-mobility-foot-weights-osm-v1.json',
  'korea-holidays-2026.json',
  'korea-holidays-2027.json',
];

const HERE = fileURLToPath(new URL('.', import.meta.url));
let codeHash: string | null = null;

/**
 * sha-256 of the simulator's own code and data, so any edit to them misses the store: every
 * `simulation/*.ts` (tsx) or `*.js` (dist) but the consumers, `realtime/seoulAreas`, and the data
 * files. Computed once per process for this directory; tests pass a copy.
 */
export function simulationCodeHash(directory = HERE): string {
  if (codeHash && directory === HERE) return codeHash;
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const hash = createHash('sha256');
  const add = (name: string, path: string) => {
    hash.update(name);
    hash.update('\0');
    hash.update(existsSync(path) ? readFileSync(path) : 'missing');
    hash.update('\0');
  };
  for (const name of readdirSync(directory).sort())
    if (
      name.endsWith(extension) &&
      !name.endsWith('.d.ts') &&
      !CONSUMERS.has(name.slice(0, -extension.length))
    )
      add(name, join(directory, name));
  add(`seoulAreas${extension}`, join(directory, '..', 'realtime', `seoulAreas${extension}`));
  for (const name of WINDOW_DATA_FILES) add(name, dataFile(name));
  const value = hash.digest('hex');
  if (directory === HERE) codeHash = value;
  return value;
}

/** Everything a stored window must have been computed from. */
export interface WindowKeyInputs {
  format: typeof WINDOW_FORMAT;
  modelVersion: string;
  code: string;
  fleets: Fleets;
  seed: string;
  date: string;
  startsAt: number;
  endsAt: number;
}

/** The inputs in a fixed key order, so two equal inputs serialise to the same text. */
const canonical = (inputs: WindowKeyInputs) =>
  JSON.stringify({
    format: inputs.format,
    modelVersion: inputs.modelVersion,
    code: inputs.code,
    fleets: { scooter: inputs.fleets.scooter, ebike: inputs.fleets.ebike },
    seed: inputs.seed,
    date: inputs.date,
    startsAt: inputs.startsAt,
    endsAt: inputs.endsAt,
  });

/** The first 16 hex digits of the inputs' sha-256: the file name part that tells windows apart. */
export function windowKey(inputs: WindowKeyInputs): string {
  return createHash('sha256').update(canonical(inputs)).digest('hex').slice(0, 16);
}

/** A stored window that does not match what was asked; the store treats it as a miss. */
export class WindowStoreReject extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WindowStoreReject';
  }
}

interface ColumnHeader {
  path: string;
  type: 'Float64Array' | 'Int32Array' | 'Uint8Array';
  length: number;
  /** Byte offset from the start of the column area. */
  offset: number;
}
interface WindowFileHeader {
  format: number;
  key: string;
  inputs: WindowKeyInputs;
  meta: WindowMeta;
  columns: ColumnHeader[];
  columnSha: string;
  builtMs: number;
  createdAt: number;
  node: string;
}

const ARRAYS = { Float64Array, Int32Array, Uint8Array } as const;
const align8 = (value: number) => Math.ceil(value / 8) * 8;
const bytesOf = (view: ArrayBufferView) =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

function columnSha(columns: readonly { path: string; bytes: Uint8Array }[]) {
  const hash = createHash('sha256');
  for (const column of columns) {
    hash.update(column.path);
    hash.update('\0');
    hash.update(column.bytes);
  }
  return hash.digest('hex');
}

/**
 * A window as one zstd frame (level 3, with its checksum): "JGSW", u32 format, u32 header length,
 * the header JSON, then each column 8-byte aligned. Call before the columns are transferred.
 * `createdAt` is diagnostics only; this file reads no clock (the model stays a pure function).
 */
export function encodeWindow(
  data: WindowData,
  inputs: WindowKeyInputs,
  builtMs: number,
  createdAt = 0,
) {
  const columns: ColumnHeader[] = [];
  const parts: { path: string; bytes: Uint8Array }[] = [];
  let offset = 0;
  for (const path of WINDOW_COLUMNS) {
    const view = windowColumn(data, path);
    const type = view.constructor.name as ColumnHeader['type'];
    if (!(type in ARRAYS)) throw new TypeError(`window column ${path} is a ${type}`);
    const bytes = bytesOf(view);
    columns.push({ path, type, length: bytes.byteLength / ARRAYS[type].BYTES_PER_ELEMENT, offset });
    parts.push({ path, bytes });
    offset = align8(offset + bytes.byteLength);
  }
  const header: WindowFileHeader = {
    format: WINDOW_FORMAT,
    key: windowKey(inputs),
    inputs: JSON.parse(canonical(inputs)) as WindowKeyInputs,
    meta: data.meta,
    columns,
    columnSha: columnSha(parts),
    builtMs,
    createdAt,
    node: process.versions.node,
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const start = align8(12 + head.byteLength);
  const raw = new Uint8Array(start + offset);
  raw.set(Buffer.from(MAGIC, 'latin1'), 0);
  const words = new DataView(raw.buffer);
  words.setUint32(4, WINDOW_FORMAT, true);
  words.setUint32(8, head.byteLength, true);
  raw.set(head, 12);
  parts.forEach((part, index) => raw.set(part.bytes, start + columns[index].offset));
  return new Uint8Array(
    zstdCompressSync(raw, {
      params: {
        [constants.ZSTD_c_compressionLevel]: 3,
        [constants.ZSTD_c_checksumFlag]: 1,
      },
    }),
  );
}

/** The window in a stored file, checked against `inputs`; throws WindowStoreReject on any mismatch. */
export function decodeWindow(bytes: Uint8Array, inputs: WindowKeyInputs): WindowData {
  let raw: Uint8Array;
  try {
    raw = zstdDecompressSync(bytes);
  } catch {
    throw new WindowStoreReject('checksum');
  }
  // Columns are viewed in place only on a buffer of their own that starts 8-byte aligned.
  if (raw.byteOffset !== 0 || raw.buffer.byteLength !== raw.byteLength) raw = new Uint8Array(raw);
  if (raw.byteLength < 12 || Buffer.from(raw.subarray(0, 4)).toString('latin1') !== MAGIC)
    throw new WindowStoreReject('magic');
  const words = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (words.getUint32(4, true) !== WINDOW_FORMAT) throw new WindowStoreReject('format');
  const headLength = words.getUint32(8, true);
  if (12 + headLength > raw.byteLength) throw new WindowStoreReject('header');
  let header: WindowFileHeader;
  try {
    header = JSON.parse(
      Buffer.from(raw.buffer, raw.byteOffset + 12, headLength).toString('utf8'),
    ) as WindowFileHeader;
  } catch {
    throw new WindowStoreReject('header');
  }
  if (header.key !== windowKey(inputs) || canonical(header.inputs) !== canonical(inputs))
    throw new WindowStoreReject('key');
  const meta = header.meta;
  if (
    meta.date !== inputs.date ||
    meta.startsAt !== inputs.startsAt ||
    meta.endsAt !== inputs.endsAt ||
    meta.seed !== inputs.seed ||
    meta.modelVersion !== inputs.modelVersion ||
    meta.fleets?.scooter !== inputs.fleets.scooter ||
    meta.fleets?.ebike !== inputs.fleets.ebike
  )
    throw new WindowStoreReject('meta');
  const paths = header.columns.map((column) => column.path);
  if (paths.length !== WINDOW_COLUMNS.length || paths.some((path, i) => path !== WINDOW_COLUMNS[i]))
    throw new WindowStoreReject('columns');
  const start = align8(12 + headLength);
  const parts = header.columns.map((column) => {
    const Type = ARRAYS[column.type];
    const at = start + column.offset;
    if (
      !Type ||
      !Number.isInteger(column.length) ||
      column.length < 0 ||
      at % Type.BYTES_PER_ELEMENT !== 0 ||
      at + column.length * Type.BYTES_PER_ELEMENT > raw.byteLength
    )
      throw new WindowStoreReject('bounds');
    const view = new Type(raw.buffer as ArrayBuffer, raw.byteOffset + at, column.length);
    return { path: column.path, view, bytes: bytesOf(view) };
  });
  if (columnSha(parts) !== header.columnSha) throw new WindowStoreReject('sha');
  const data: Record<string, unknown> = { meta, events: {} };
  for (const { path, view } of parts) {
    const keys = path.split('.');
    let target = data;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys[keys.length - 1]] = view;
  }
  return data as unknown as WindowData;
}

const parseName = (name: string) => {
  const match = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{16})\.simwin\.zst$/.exec(name);
  return match ? { date: match[1], key: match[2] } : null;
};
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / (24 * HOUR_MS);

/**
 * One directory of stored windows, `${date}_${key}.simwin.zst`. The worker reads; the main thread
 * writes (a worker is terminated as soon as it is idle, which would cut an async write short).
 */
export class WindowStore {
  constructor(
    readonly directory: string,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  fileOf(inputs: WindowKeyInputs): string {
    return join(this.directory, `${inputs.date}_${windowKey(inputs)}${SUFFIX}`);
  }

  /** The stored window for `inputs`; null when missing or rejected (a rejected file is deleted). */
  readSync(inputs: WindowKeyInputs): WindowData | null {
    const file = this.fileOf(inputs);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(file);
    } catch {
      return null;
    }
    try {
      return decodeWindow(bytes, inputs);
    } catch (error) {
      const reason = error instanceof WindowStoreReject ? error.message : 'unreadable';
      this.log(`simulation window ${inputs.date} store file rejected (${reason})`);
      try {
        unlinkSync(file);
      } catch {
        /* Another instance may have removed or replaced it already. */
      }
      return null;
    }
  }

  /** Writes a temporary file and renames it, so a reader sees a whole file or none. */
  async write(inputs: WindowKeyInputs, bytes: Uint8Array): Promise<void> {
    mkdirSync(this.directory, { recursive: true });
    const file = this.fileOf(inputs);
    const temporary = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      await fsp.writeFile(temporary, bytes);
      await fsp.rename(temporary, file);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Deletes files of days before yesterday or after the day after tomorrow, another key of a day
   * once it is a day older than that day's newest file (old and new revisions run side by side
   * during a deploy), temporary files after 10 minutes, and the oldest days past 12 files.
   */
  async evict(today: string, now: number): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.directory);
    } catch {
      return;
    }
    const remove = (name: string) =>
      fsp.rm(join(this.directory, name), { force: true }).catch(() => undefined);
    const kept: { name: string; date: string; mtime: number }[] = [];
    for (const name of names) {
      const stat = await fsp.stat(join(this.directory, name)).catch(() => null);
      if (!stat?.isFile()) continue;
      if (name.includes(`${SUFFIX}.tmp-`)) {
        if (now - stat.mtimeMs > 10 * 60_000) await remove(name);
        continue;
      }
      const parsed = parseName(name);
      if (!parsed) continue;
      const offset = dayNumber(parsed.date) - dayNumber(today);
      if (offset < -1 || offset > 2) await remove(name);
      else kept.push({ name, date: parsed.date, mtime: stat.mtimeMs });
    }
    const newest = new Map<string, number>();
    for (const file of kept)
      newest.set(file.date, Math.max(newest.get(file.date) ?? 0, file.mtime));
    const left = [];
    for (const file of kept)
      if (file.mtime < newest.get(file.date)! && now - file.mtime > 24 * HOUR_MS)
        await remove(file.name);
      else left.push(file);
    left.sort((a, b) => a.date.localeCompare(b.date) || a.mtime - b.mtime);
    for (const file of left.slice(0, Math.max(0, left.length - KEEP_FILES)))
      await remove(file.name);
  }
}
