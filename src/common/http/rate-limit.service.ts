import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { DatabaseService } from '../database/database.service.js';
import { ApiError } from '../errors.js';
import { LessThan } from 'typeorm';
import { ApiRateWindowEntity } from '../database/entities/api-rate-window.entity.js';

@Injectable()
export class RateLimitService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async consume(request: Request, response: Response, next: NextFunction) {
    // Routes match without regard to case, so "/api/Places" must count as "/api/places".
    const path = request.path.replace(/\/$/, '').toLowerCase();
    const isSearch = /^\/api\/routes(?:\/search)?$/.test(path);
    const isLearning = path.startsWith('/api/learning/');
    const isPublic = /^\/api\/(?:places(?:\/reverse)?|realtime\/.+|traffic\/route|sim\/.+)$/.test(
      path,
    );
    // Each travel-time comparison may call GPT and several suppliers.
    const isTravelTime = path === '/api/travel-times';
    if ((!isSearch && !isLearning && !isPublic && !isTravelTime) || request.method === 'OPTIONS') {
      next();

      return;
    }

    const scope = isSearch ? 'route-search' : isLearning ? 'learning' : path;
    const key = createHash('sha256')
      .update(`${scope}:${request.ip ?? 'unknown'}`)
      .digest('hex');
    const now = Date.now(),
      expiresAt = now + 60_000;
    // Typing in the place picker sends a request every pause, and a venue's phones share one address; the server
    // caches place answers, so a typing burst rarely reaches Kakao (가정값).
    const limit = isSearch
      ? 30
      : isTravelTime
        ? 10
        : path === '/api/places'
          ? 600
          : path === '/api/places/reverse'
            ? 120
            : 60;

    try {
      const window = await this.database.transaction(async (manager) => {
        await this.database.lock(manager, `api-rate:${key}`);

        const windows = manager.getRepository(ApiRateWindowEntity);
        const saved = await windows.findOneBy({ key });
        const current =
          saved && saved.expiresAt > now
            ? { ...saved, count: saved.count + 1 }
            : { key, count: 1, expiresAt };

        return windows.save(current);
      });

      if (window.count > limit) {
        response.setHeader('Retry-After', Math.max(1, Math.ceil((window.expiresAt - now) / 1000)));
        throw new ApiError(
          'TOO_MANY_REQUESTS',
          '짧은 시간에 요청이 많아요. 잠시 후 다시 시도해 주세요.',
          429,
        );
      }

      // Bounded housekeeping across instances; failures are surfaced as normal DB errors.
      if (Math.random() < 0.01) {
        await this.database.getRepository(ApiRateWindowEntity).delete({ expiresAt: LessThan(now) });
      }

      next();
    } catch (error) {
      next(error);
    }
  }
}
