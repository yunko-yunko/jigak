import { requestSupplierText } from '../supplier-http.js';

/** Shared JSON fetch for public transit feeds. Errors never carry keys, URLs or bodies. */
export class FeedError extends Error {
  constructor(readonly reason: 'timeout' | 'network' | 'status' | 'format' | 'auth' | 'quota') {
    super(`transit feed ${reason}`);
    this.name = 'FeedError';
  }
}

export interface FeedOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** data.go.kr's spent daily request limit (HTTP 401 "서비스 요청제한 횟수 초과 에러", XML code 22), not the per-second
 * limit (code 23), which passes in a moment. */
export const dailyQuotaSpent = (body: string) =>
  /요청\s*제한\s*(?:횟수\s*)?(?:을\s*)?초과|LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS/.test(
    body,
  ) && !/초당|PER_SECOND/.test(body);

const KST_MS = 9 * 3_600_000,
  DAY_MS = 86_400_000;
/** The next 00:00 in Korea, when data.go.kr and the Seoul open data portal reset daily quotas. */
export const nextKstMidnight = (at: number) =>
  Math.floor((at + KST_MS) / DAY_MS) * DAY_MS - KST_MS + DAY_MS;

export async function fetchFeedJson(
  url: URL,
  { fetcher = fetch, timeoutMs = 4_000 }: FeedOptions = {},
): Promise<unknown> {
  // A spent quota and an unregistered key are both 401; only the body tells them apart.
  let rejected = false;
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
        rejected = response.status === 401 || response.status === 403;
        if (!response.ok && !rejected) {
          throw new FeedError('status');
        }
      },
      timeoutMs,
      timeoutError: () => new FeedError('timeout'),
      responseError: () => new FeedError('format'),
    });

    if (rejected) {
      throw new FeedError(dailyQuotaSpent(text) ? 'quota' : 'auth');
    }

    // data.go.kr reports key problems as XML even when JSON was requested.
    if (/^\s*</.test(text)) {
      throw new FeedError(
        dailyQuotaSpent(text)
          ? 'quota'
          : /SERVICE_KEY|SERVICE KEY|인증/.test(text)
            ? 'auth'
            : 'format',
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new FeedError('format');
    }
  } catch (error) {
    // A rejected key whose body could not be read stays a key problem.
    if (rejected && !(error instanceof FeedError && error.reason === 'quota')) {
      throw new FeedError('auth');
    }

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
