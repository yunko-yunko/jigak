import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../common/database/database.service.js';
import { ApiRateWindowEntity } from '../../../common/database/entities/api-rate-window.entity.js';
import { mapByteWindowKey, ngiiByteBudget } from '../domain/map-archive.js';

/** `window` (its expiry) lets a refund find the window it was charged to. */
export type ByteCharge =
  { allowed: true; window: number } | { allowed: false; retryAfterSeconds: number };

/**
 * Bytes of the NGII archive each client IP has read in the current window, in the same PostgreSQL
 * table as the request limits so every instance shares one count. `count` holds bytes here, under
 * a key of its own; expired rows go with the request limiter's housekeeping.
 */
@Injectable()
export class MapByteBudgetRepository {
  /** Read at startup, so a bad value stops the server instead of a request. */
  readonly budget = ngiiByteBudget();

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Adds `bytes` to the IP's window, or refuses without adding when they would pass the budget. A
   * refused read is never cut short: PMTiles trusts the length it asked for.
   */
  async charge(ip: string, bytes: number, now = Date.now()): Promise<ByteCharge> {
    const key = mapByteWindowKey(ip);

    return this.database.transaction(async (manager) => {
      await this.database.lock(manager, `api-rate:${key}`);

      const windows = manager.getRepository(ApiRateWindowEntity);
      const saved = await windows.findOneBy({ key });
      const live = saved !== null && saved.expiresAt > now;
      const used = live ? saved.count : 0;
      const expiresAt = live ? saved.expiresAt : now + this.budget.windowMs;

      if (used + bytes > this.budget.bytes) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
        };
      }

      await windows.save({ key, count: used + bytes, expiresAt });

      return { allowed: true, window: expiresAt };
    });
  }

  /**
   * Gives back bytes charged for a read that then failed (503), so only bytes actually sent count.
   * Only into the window they were charged to: a window that has since ended is left alone.
   */
  async refund(ip: string, bytes: number, window: number): Promise<void> {
    const key = mapByteWindowKey(ip);

    await this.database.transaction(async (manager) => {
      await this.database.lock(manager, `api-rate:${key}`);

      const windows = manager.getRepository(ApiRateWindowEntity);
      const saved = await windows.findOneBy({ key });
      if (saved === null || saved.expiresAt !== window) return;

      await windows.save({ key, count: Math.max(0, saved.count - bytes), expiresAt: window });
    });
  }
}
