import { createWriteStream, existsSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Store } from './store';
import { addDays, errorMessage, readJson, sha256File, writeJsonAtomic, type Logger } from './util';

export const TDATA_CATALOG = 'https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006';
export const TDATA_ORIGIN = 'https://t-data.seoul.go.kr';
export const MAX_ARCHIVE_BYTES = 768 * 1024 ** 2;
export const TAG_MEMBER = 'VW_KSCC_DX_CARD.csv', STOP_MEMBER = 'VW_KSCC_DH_CARD.csv', ROUTE_MEMBER = 'VW_KSCC_DO_CARD.csv', STATION_MEMBER = 'VW_KSCC_DV_CARD.csv';
/** The archive name is the publication date; rows are the service day four days earlier (checked on STDR_DE during preparation). */
export const PUBLICATION_LAG_DAYS = 4;
export const RETAIN_SERVICE_DAYS = 18;
/**
 * Version of the member rule below. An archive refused for its members records the rule that refused it, so a newer rule
 * checks it again instead of skipping it until T-DATA republishes a different size.
 * 2 (11-06): the station table became optional; TAIMS_20261106 (service day 11-02) arrived with DO but without DV.
 */
export const MEMBER_RULE = 2;
const HEADERS = { 'User-Agent': 'Jigakjido-model-refresh/1.0', Referer: TDATA_CATALOG };

export interface CatalogEntry { name: string; id: string; url: string; publicationDate: string; serviceDate: string }
export interface TaimsIndexEntry {
  name: string; id: string; url: string; serviceDate: string; serviceDateRule: 'publication-minus-4';
  bytes: number; sha256: string; zipOk: boolean; hasRouteTable: boolean; members: string[]; downloadedAt: string; lastHeadBytes?: number; source?: 'download' | 'linked';
  /** Whether the archive carries the subway station table (DV). Absent on entries written before rule 2, which required it. */
  hasStationTable?: boolean;
  /** The member rule an archive was checked (or refused) under; absent means rule 1. */
  memberRule?: number;
}
export interface TaimsIndex { version: 'jigak-taims-index-v1'; updatedAt: string; archives: Record<string, TaimsIndexEntry> }

/** Ids are never computed: recent steps were +8…+18 and an unrelated old archive sits between two days. */
export function parseCatalog(html: string): CatalogEntry[] {
  const found = [...html.matchAll(/<option\s+value="(\d+)">\s*(TAIMS_(\d{4})(\d{2})(\d{2})\.zip)\s*<\/option>/g)];
  const names = new Set(found.map(match => match[2]));
  if (!found.length || names.size !== found.length) throw new Error('missing-or-ambiguous-official-catalog');
  return found.map(([, id, name, year, month, day]) => {
    const publicationDate = `${year}-${month}-${day}`;
    return { name, id, url: `${TDATA_ORIGIN}/dataprovide/download.do?id=${id}`, publicationDate, serviceDate: addDays(publicationDate, -PUBLICATION_LAG_DAYS) };
  }).sort((left, right) => left.serviceDate.localeCompare(right.serviceDate));
}

export async function fetchCatalog(fetchImpl: typeof fetch = fetch): Promise<CatalogEntry[]> {
  const response = await fetchImpl(TDATA_CATALOG, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200 || !response.url.startsWith(TDATA_ORIGIN + '/')) throw new Error(`catalog-http-${response.status}`);
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error('catalog-size-bound');
  return parseCatalog(text);
}

export async function headBytes(url: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const response = await fetchImpl(url, { method: 'HEAD', headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  const bytes = Number(response.headers.get('content-length') ?? 0);
  if (response.status !== 200 || !response.url.startsWith(TDATA_ORIGIN + '/')) throw new Error(`head-http-${response.status}`);
  if (!(bytes > 0 && bytes <= MAX_ARCHIVE_BYTES)) throw new Error('archive-size-bound');
  return bytes;
}

/**
 * Central directory of a zip, read from the end of the file only. A truncated transfer (T-DATA once served 48.5% of
 * TAIMS_20261021 without an error) has no end-of-central-directory record and fails here.
 */
export async function zipMembers(path: string): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size, tailLength = Math.min(size, 65_557), tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let at = tailLength - 22; at >= 0; at--) if (tail.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
    if (eocd < 0) throw new Error('zip-end-record-missing');
    let entries = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50) throw new Error('zip64-locator-missing');
      const recordOffset = Number(tail.readBigUInt64LE(locator + 8)), record = Buffer.alloc(56);
      await handle.read(record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64-record-missing');
      entries = Number(record.readBigUInt64LE(32)); cdSize = Number(record.readBigUInt64LE(40)); cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size || cdSize > 16 * 1024 * 1024 || entries > 10_000) throw new Error('zip-central-directory-bound');
    const directory = Buffer.alloc(cdSize);
    await handle.read(directory, 0, cdSize, cdOffset);
    const names: string[] = [];
    for (let at = 0, index = 0; index < entries; index++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error('zip-central-directory-corrupt');
      const nameLength = directory.readUInt16LE(at + 28), extra = directory.readUInt16LE(at + 30), comment = directory.readUInt16LE(at + 32);
      names.push(directory.toString('utf8', at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extra + comment;
    }
    return names;
  } finally { await handle.close(); }
}

/**
 * The day's tags (DX) and stops (DH) are required. The route table (DO) and the subway station table (DV) are reference tables
 * that T-DATA publishes on some days only (TAIMS_20261105 carried DV without DO, TAIMS_20261106 DO without DV); a day without
 * one borrows it from a nearby day during preparation. Each may appear at most once.
 */
export function inspectMembers(members: string[]) {
  const count = (name: string) => members.filter(member => member === name).length;
  return {
    usable: count(TAG_MEMBER) === 1 && count(STOP_MEMBER) === 1 && count(ROUTE_MEMBER) <= 1 && count(STATION_MEMBER) <= 1,
    hasRouteTable: count(ROUTE_MEMBER) === 1, hasStationTable: count(STATION_MEMBER) === 1,
  };
}

/** Archives indexed under rule 1 had to carry the station table, so a missing flag means it is there. */
export const hasStationTable = (entry: Pick<TaimsIndexEntry, 'hasStationTable'>) => entry.hasStationTable !== false;

export async function readTaimsIndex(store: Store): Promise<TaimsIndex> {
  return await readJson<TaimsIndex>(store.taimsIndex) ?? { version: 'jigak-taims-index-v1', updatedAt: new Date(0).toISOString(), archives: {} };
}
export const writeTaimsIndex = (store: Store, index: TaimsIndex, runId: string) => writeJsonAtomic(store.taimsIndex, { ...index, updatedAt: new Date().toISOString() }, runId);

/** One archive at a time: download to .partial, check length and central directory, then rename into place. */
export async function downloadArchive(store: Store, entry: CatalogEntry, expectedBytes: number, options: { fetchImpl?: typeof fetch; attempts?: number; backoffMs?: number; log?: Logger } = {}): Promise<TaimsIndexEntry> {
  const fetchImpl = options.fetchImpl ?? fetch, attempts = options.attempts ?? 4, backoff = options.backoffMs ?? 30_000;
  await mkdir(store.taims, { recursive: true });
  const destination = resolve(store.taims, entry.name), partial = `${destination}.partial`;
  for (let attempt = 1; ; attempt++) {
    await rm(partial, { force: true });
    try {
      const response = await fetchImpl(entry.url, { headers: HEADERS, signal: AbortSignal.timeout(30 * 60_000) });
      if (response.status !== 200 || !response.body || !response.url.startsWith(TDATA_ORIGIN + '/')) throw new Error(`download-http-${response.status}`);
      let received = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        received += chunk.byteLength; if (received > expectedBytes || received > MAX_ARCHIVE_BYTES) throw new Error('download-size-bound'); controller.enqueue(chunk);
      } });
      await pipeline(Readable.fromWeb(response.body.pipeThrough(counter) as never), createWriteStream(partial, { flags: 'wx' }));
      if (received !== expectedBytes) throw new Error('truncated-download');
      const members = await zipMembers(partial), check = inspectMembers(members);
      if (!check.usable) throw new Error('invalid-official-archive-members');
      const sha256 = await sha256File(partial);
      await rename(partial, destination);
      return { name: entry.name, id: entry.id, url: entry.url, serviceDate: entry.serviceDate, serviceDateRule: 'publication-minus-4', bytes: expectedBytes, sha256,
        zipOk: true, hasRouteTable: check.hasRouteTable, hasStationTable: check.hasStationTable, members, downloadedAt: new Date().toISOString(), lastHeadBytes: expectedBytes,
        source: 'download', memberRule: MEMBER_RULE };
    } catch (error) {
      await rm(partial, { force: true });
      const message = errorMessage(error);
      // A truncated server copy stays truncated within a run; the next run re-checks Content-Length and tries again.
      if (attempt >= attempts || !/truncated|ECONNRESET|socket|fetch failed|terminated|timeout|download-http-5/.test(message)) throw new Error(message);
      options.log?.('WARNING', 'taims-download-retry', { archive: entry.name, attempt: attempt + 1, reason: message });
      await new Promise(done => setTimeout(done, backoff * attempt));
    }
  }
}

/** Dev only: hard-link archives already on this machine (for example under mvp/data of the monorepo) instead of downloading them again. */
export async function linkExistingArchives(store: Store, directories: string[], catalog: CatalogEntry[] | null, log?: Logger): Promise<TaimsIndexEntry[]> {
  const byName = new Map((catalog ?? []).map(entry => [entry.name, entry])), linked: TaimsIndexEntry[] = [];
  await mkdir(store.taims, { recursive: true });
  const seen = new Set<string>();
  const walk = async (directory: string): Promise<string[]> => {
    const found: string[] = [];
    for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) found.push(...await walk(path));
      else if (/^TAIMS_\d{8}\.zip$/.test(item.name)) found.push(path);
    }
    return found;
  };
  for (const directory of directories) for (const path of (await walk(directory)).sort()) {
    const name = basename(path); if (seen.has(name)) continue;
    let members: string[];
    try { members = await zipMembers(path); } catch { log?.('WARNING', 'taims-link-skipped', { archive: name, reason: 'zip-unreadable' }); continue; }
    const check = inspectMembers(members); if (!check.usable) continue;
    const target = resolve(store.taims, name);
    if (!existsSync(target)) await link(path, target);
    seen.add(name);
    const publication = `${name.slice(6, 10)}-${name.slice(10, 12)}-${name.slice(12, 14)}`, catalogEntry = byName.get(name);
    linked.push({ name, id: catalogEntry?.id ?? 'unknown', url: catalogEntry?.url ?? `${TDATA_ORIGIN}/dataprovide/download.do?id=0`, serviceDate: addDays(publication, -PUBLICATION_LAG_DAYS),
      serviceDateRule: 'publication-minus-4', bytes: (await stat(target)).size, sha256: await sha256File(target), zipOk: true, hasRouteTable: check.hasRouteTable,
      hasStationTable: check.hasStationTable, members, downloadedAt: new Date().toISOString(), source: 'linked', memberRule: MEMBER_RULE });
  }
  return linked;
}

/** Keep the newest 18 service days (about 10 GB); older archives and their index rows go. */
export async function pruneArchives(store: Store, index: TaimsIndex, keep = RETAIN_SERVICE_DAYS): Promise<string[]> {
  const ordered = Object.values(index.archives).sort((left, right) => right.serviceDate.localeCompare(left.serviceDate));
  const removed: string[] = [];
  for (const entry of ordered.slice(keep)) { await rm(resolve(store.taims, entry.name), { force: true }); delete index.archives[entry.name]; removed.push(entry.name); }
  return removed;
}
