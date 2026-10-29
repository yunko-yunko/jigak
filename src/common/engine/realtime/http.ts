import { requestSupplierText } from '../supplier-http.js';

/** Shared JSON fetch for public transit feeds. Errors never carry keys, URLs or bodies. */
export class FeedError extends Error {
  constructor(readonly reason: 'timeout' | 'network' | 'status' | 'format' | 'auth') {
    super(`transit feed ${reason}`);
    this.name = 'FeedError';
  }
}

export interface FeedOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchFeedJson(
  url: URL,
  { fetcher = fetch, timeoutMs = 4_000 }: FeedOptions = {},
): Promise<unknown> {
  try {
    const text = await requestSupplierText({
      request: (signal) =>
        fetcher(url, {
          headers: {
            Accept: 'application/json',
          },
          signal,
        }),
      validateResponse(response) {
        if (!response.ok) {
          throw new FeedError(
            response.status === 401 || response.status === 403 ? 'auth' : 'status',
          );
        }
      },
      timeoutMs,
      timeoutError: () => new FeedError('timeout'),
      responseError: () => new FeedError('format'),
    });

    // data.go.kr reports key problems as XML even when JSON was requested.
    if (/^\s*</.test(text)) {
      throw new FeedError(/SERVICE_KEY|SERVICE KEY|인증/.test(text) ? 'auth' : 'format');
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new FeedError('format');
    }
  } catch (error) {
    if (error instanceof FeedError) {
      throw error;
    }

    throw new FeedError('network');
  }
}

/** data.go.kr issues an already-encoded and a decoded key; accept either. */
export function decodeServiceKey(key: string | undefined): string {
  const trimmed = key?.trim() ?? '';

  if (!trimmed.includes('%')) {
    return trimmed;
  }

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

/** "2026-10-12 08:47:35" (seconds optional) in Korea Standard Time to epoch milliseconds. */
export function parseKstDateTime(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);

  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = match[6] ? Number(match[6]) : 0;
  const stamp = Date.UTC(year, month - 1, day, hour - 9, minute, second);

  return Number.isFinite(stamp) ? stamp : null;
}

/** Arrays in data.go.kr JSON collapse to an object for one item and "" for none. */
export function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (value && typeof value === 'object') {
    return [value as T];
  }

  return [];
}

export function text(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : '';
}

export function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;

  return Number.isFinite(parsed) ? parsed : null;
}
