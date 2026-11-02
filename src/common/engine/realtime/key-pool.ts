import { FeedError, nextKstMidnight } from './http.js';

/** Who is asking. Live guidance may spend a key's last calls of the day; browsing nearby stops gives up first. */
export type CallPurpose = 'guidance' | 'search' | 'browse';

/** Share of one operation's daily calls on one key that each purpose may spend (가정값). Guidance may use them all. */
const PURPOSE_SHARE: Readonly<Record<CallPurpose, number>> = {
  browse: 0.8,
  search: 0.95,
  guidance: 1,
};

/** data.go.kr development accounts allow 1,000 calls a day for each operation of a service. */
export const DATA_GO_KR_DAILY_LIMIT = 1_000;

export type KeySlotName = 'primary' | 'fallback';

export interface KeyPoolOptions {
  now?: () => number;
  /** Calls per operation, key and Korean day before the pool stops asking; 0 never stops. Default 0. */
  dailyLimit?: number;
}

export interface KeyPoolUsage {
  fallbackConfigured: boolean;
  dailyLimit: number;
  /** Calls this process sent today, by `${slot}:${operation}`. Other processes sharing a key are not counted. */
  calls: Record<string, number>;
  /** Slot and operation pairs the supplier closed for the day, with the time they reopen. */
  closedUntil: Record<string, number>;
}

/**
 * The service keys of one portal, primary first. Quotas are per key and operation: once a key's daily calls on an
 * operation are spent (the supplier says so, or this process has counted the limit), that operation moves on to the
 * next key until 00:00 KST. Any other error is the real answer. Keys never leave this object.
 */
export class ServiceKeyPool {
  private readonly slots: readonly { name: KeySlotName; key: string }[];
  private readonly now: () => number;
  readonly dailyLimit: number;
  private dayEndsAt = 0;
  private readonly calls = new Map<string, number>();
  private readonly closed = new Map<string, number>();

  constructor(keys: readonly (string | undefined)[], options: KeyPoolOptions = {}) {
    const primary = keys[0]?.trim() ?? '',
      spare = keys[1]?.trim() ?? '';
    this.slots = [
      ...(primary ? [{ name: 'primary' as const, key: primary }] : []),
      ...(spare && spare !== primary ? [{ name: 'fallback' as const, key: spare }] : []),
    ];
    this.now = options.now ?? Date.now;
    this.dailyLimit = Math.max(0, Math.floor(options.dailyLimit ?? 0));
  }

  get configured() {
    return this.slots.length > 0;
  }

  /** A new Korean day forgets yesterday's counts and closures. */
  private roll(time: number) {
    if (time < this.dayEndsAt) return;
    this.dayEndsAt = nextKstMidnight(time);
    this.calls.clear();
    this.closed.clear();
  }

  private open(id: string, purpose: CallPurpose, time: number) {
    if ((this.closed.get(id) ?? 0) > time) return false;
    return (
      !this.dailyLimit ||
      (this.calls.get(id) ?? 0) < Math.floor(this.dailyLimit * PURPOSE_SHARE[purpose])
    );
  }

  /** When every key is closed to this operation and purpose, the time the first one reopens; otherwise null. */
  closedUntil(operation: string, purpose: CallPurpose = 'guidance'): number | null {
    const time = this.now();
    this.roll(time);
    if (
      !this.slots.length ||
      this.slots.some((slot) => this.open(`${slot.name}:${operation}`, purpose, time))
    )
      return null;
    return this.dayEndsAt;
  }

  /** Runs one supplier call on the first key still open to it, moving to the next key only on a spent quota. */
  async call<T>(
    operation: string,
    purpose: CallPurpose,
    run: (key: string) => Promise<T>,
  ): Promise<T> {
    if (!this.slots.length) throw new FeedError('auth');
    let failure: FeedError | undefined;
    for (const slot of this.slots) {
      const time = this.now();
      this.roll(time);
      const id = `${slot.name}:${operation}`;
      if (!this.open(id, purpose, time)) {
        failure ??= new FeedError('quota');
        continue;
      }
      this.calls.set(id, (this.calls.get(id) ?? 0) + 1);
      try {
        return await run(slot.key);
      } catch (error) {
        if (!(error instanceof FeedError) || error.reason !== 'quota') throw error;
        this.closed.set(id, nextKstMidnight(this.now()));
        failure = error;
      }
    }
    throw failure ?? new FeedError('quota');
  }

  usage(): KeyPoolUsage {
    this.roll(this.now());
    return {
      fallbackConfigured: this.slots.some((slot) => slot.name === 'fallback'),
      dailyLimit: this.dailyLimit,
      calls: Object.fromEntries(this.calls),
      closedUntil: Object.fromEntries(this.closed),
    };
  }
}
