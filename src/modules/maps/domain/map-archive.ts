import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { isAbsolute } from 'node:path';
import { EnvironmentConfigurationError } from '../../../common/config/environment.js';

/**
 * The NGII 1:1,000 archive (국토지리정보원 수치지형도, Seoul). It may not leave Korea and is never
 * put in a public bucket or on a CDN: the app reads it only through this server, one byte range at
 * a time. The OSM detail tiles (korea-detail-v1) are not served here.
 */
export const NGII_ARCHIVE_FILE = 'seoul-ngii-v1.pmtiles';
export const NGII_ARCHIVE_ROUTE = `/api/maps/${NGII_ARCHIVE_FILE}`;
export const NGII_PATH_ENV = 'MAP_NGII_PMTILES_PATH';

/** Requests per client IP a minute. A panning map asks for one range per tile (z14–16 only). */
export const MAP_ARCHIVE_REQUESTS_PER_MINUTE = 600;

export const NGII_BYTE_BUDGET_ENV = 'MAP_NGII_BYTE_BUDGET_MIB';
export const NGII_BYTE_WINDOW_ENV = 'MAP_NGII_BYTE_WINDOW_MINUTES';
/**
 * Bytes one client IP may read per window. seoul-ngii-v1 is 127.7 MiB, so the whole file takes at
 * least three windows (over 20 minutes); ten minutes of normal map use reads 2–5 MB. A phone network or a venue's
 * Wi-Fi puts many people behind one IP, which is why the budget is far above one person's use.
 */
export const DEFAULT_NGII_BYTE_BUDGET_MIB = 60;
export const DEFAULT_NGII_BYTE_WINDOW_MINUTES = 10;
const MIB = 1024 * 1024;

export interface MapByteBudget {
  bytes: number;
  windowMs: number;
}

/**
 * The byte budget from the environment; blank means the default. Bytes live in the integer `count`
 * of api_rate_windows and never pass the budget, so 1024 MiB keeps them well inside int4.
 */
export function ngiiByteBudget(env: NodeJS.ProcessEnv = process.env): MapByteBudget {
  const read = (name: string, fallback: number, max: number, unit: string) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1 || value > max) {
      throw new EnvironmentConfigurationError(
        `${name}: 1–${max} 사이의 정수(${unit})여야 합니다.`,
        [name],
      );
    }
    return value;
  };

  return {
    bytes: read(NGII_BYTE_BUDGET_ENV, DEFAULT_NGII_BYTE_BUDGET_MIB, 1024, 'MiB') * MIB,
    windowMs: read(NGII_BYTE_WINDOW_ENV, DEFAULT_NGII_BYTE_WINDOW_MINUTES, 1440, '분') * 60_000,
  };
}

/**
 * Who one byte budget belongs to. A phone or a home gets a whole IPv6 /64 and may pick any address
 * in it, so IPv6 counts per /64; IPv4 (also written ::ffff:a.b.c.d) counts per address.
 */
export function mapByteBudgetSubject(ip: string) {
  const address = ip.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return address;

  // Expand "::" so the first four groups are the /64. An embedded IPv4 tail sits past them.
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = address.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16).toString(16) : '0'))
    .join(':')}::/64`;
}

/** The api_rate_windows key of one IP's byte window; request-count keys hash "/api/…:ip" instead. */
export function mapByteWindowKey(ip: string) {
  return createHash('sha256')
    .update(`map-bytes:${NGII_ARCHIVE_FILE}:${mapByteBudgetSubject(ip)}`)
    .digest('hex');
}

/** A PMTiles v3 header is 127 bytes; anything shorter is not an archive. */
export const PMTILES_HEADER_BYTES = 127;

/** The configured archive path, or undefined when unset. Startup validation requires it absolute. */
export function ngiiArchivePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env[NGII_PATH_ENV]?.trim();
  return path && isAbsolute(path) ? path : undefined;
}

/** How long health trusts the last look at the archive (seconds-scale; health is polled). */
const STATUS_TTL_MS = 30_000;
let lastStatus: { path: string; at: number; available: boolean } | undefined;

/** Tile reads already stat the file; they keep health's answer fresh so health rarely touches it. */
export function rememberNgiiAvailability(path: string, available: boolean, now = Date.now()) {
  lastStatus = { path, at: now, available };
}

/**
 * For /api/health: whether the archive is set and readable, never where it is. The file may sit on
 * a Cloud Storage volume, so a synchronous stat runs at most once per STATUS_TTL_MS.
 */
export function ngiiMapStatus(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const path = ngiiArchivePath(env);
  if (!path) return { configured: false, available: false };
  if (lastStatus?.path === path && now - lastStatus.at < STATUS_TTL_MS) {
    return { configured: true, available: lastStatus.available };
  }
  let available = false;
  try {
    const stat = statSync(path);
    available = stat.isFile() && stat.size >= PMTILES_HEADER_BYTES;
  } catch {
    available = false;
  }
  rememberNgiiAvailability(path, available, now);
  return { configured: true, available };
}

/** Matches the routing table's case-insensitive paths, so "/api/MAPS/…" is the same route. */
export function isMapArchivePath(path: string) {
  return path.replace(/\/$/, '').toLowerCase() === NGII_ARCHIVE_ROUTE;
}

/**
 * The app's map frame has an opaque origin and sends `Origin: null`: a sandboxed srcdoc iframe on
 * web, an HTML-string WebView on native. It has no origin CORS_ORIGINS could list, so its tile reads
 * are allowed on this route only. This opens nothing a client without an Origin (curl) cannot
 * already read: no credentials are allowed, and the range cap and byte budget apply to every caller.
 */
export const OPAQUE_ORIGIN = 'null';

/**
 * CORS headers for the archive route, or null for an origin that is neither in CORS_ORIGINS nor the
 * map frame. No credentials: the archive needs none. Range is the one request header PMTiles sends.
 */
export function mapArchiveCorsHeaders(
  origin: string,
  allowed: ReadonlySet<string>,
): Record<string, string> | null {
  if (origin !== OPAQUE_ORIGIN && !allowed.has(origin)) return null;

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,If-Match',
    'Access-Control-Expose-Headers': 'Content-Range,Content-Length,ETag,Accept-Ranges,Retry-After',
    'Access-Control-Max-Age': '600',
  };
}
