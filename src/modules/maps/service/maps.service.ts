import { Inject, Injectable } from '@nestjs/common';
import { MapArchiveRepository } from '../repository/map-archive.repository.js';
import { MapByteBudgetRepository } from '../repository/map-byte-budget.repository.js';
import { MAX_RANGE_BYTES, parseByteRange } from '../domain/byte-range.js';

export type MapArchiveErrorCode =
  | 'MAP_NOT_CONFIGURED'
  | 'MAP_UNAVAILABLE'
  | 'RANGE_REQUIRED'
  | 'RANGE_INVALID'
  | 'RANGE_TOO_LARGE'
  | 'RANGE_NOT_SATISFIABLE'
  | 'TOO_MANY_REQUESTS';

export interface MapArchiveReply {
  status: number;
  headers: Record<string, string>;
  /** Bytes for a GET 206; absent for HEAD and errors. */
  body?: Buffer;
  error?: { code: MapArchiveErrorCode; message: string };
}

/** Short and private: browsers may keep tiles a while, shared caches and CDNs may not. */
const CACHE_CONTROL = 'private, max-age=300';

const failure = (
  status: number,
  code: MapArchiveErrorCode,
  message: string,
  headers: Record<string, string> = {},
): MapArchiveReply => ({ status, headers, error: { code, message } });

@Injectable()
export class MapsService {
  constructor(
    @Inject(MapArchiveRepository) private readonly archive: MapArchiveRepository,
    @Inject(MapByteBudgetRepository) private readonly budget: MapByteBudgetRepository,
  ) {}

  /**
   * One byte range of the NGII archive. GET needs exactly one range of at most 512 KiB: no request
   * returns the whole file. HEAD without a range returns the size only, no bytes. Bytes a GET returns
   * count against the client IP's byte budget; HEAD, refused ranges and failed reads cost nothing.
   */
  async ngii(
    method: string,
    rangeHeader: string | undefined,
    ip: string,
  ): Promise<MapArchiveReply> {
    if (!this.archive.configured) {
      return failure(404, 'MAP_NOT_CONFIGURED', '이 서버에는 NGII 지도가 설정되지 않았어요.');
    }
    const file = await this.archive.describe();
    if (!file) {
      return failure(
        503,
        'MAP_UNAVAILABLE',
        '지도 파일을 읽지 못했어요. 잠시 후 다시 시도해 주세요.',
      );
    }

    const common = {
      'Accept-Ranges': 'bytes',
      ETag: file.etag,
      'Cache-Control': CACHE_CONTROL,
    };
    const head = method === 'HEAD';
    const range = parseByteRange(rangeHeader, file.size);

    switch (range.kind) {
      case 'missing':
        if (head) {
          return {
            status: 200,
            headers: {
              ...common,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(file.size),
            },
          };
        }
        return failure(400, 'RANGE_REQUIRED', '지도 파일은 Range 요청으로만 읽을 수 있어요.');
      case 'invalid':
        return failure(400, 'RANGE_INVALID', 'Range 형식이 올바르지 않아요.');
      case 'multiple':
        return failure(400, 'RANGE_INVALID', 'Range는 한 구간만 보낼 수 있어요.');
      case 'too-large':
        return failure(
          400,
          'RANGE_TOO_LARGE',
          `한 번에 ${MAX_RANGE_BYTES / 1024} KiB까지만 읽을 수 있어요.`,
        );
      case 'unsatisfiable':
        // PMTiles reads the real size from `bytes */size` when its first read misses. Like every other
        // error this stays no-store and carries no ETag: it is not a piece of the file.
        return failure(416, 'RANGE_NOT_SATISFIABLE', '요청한 범위가 파일 크기를 넘어요.', {
          'Content-Range': `bytes */${file.size}`,
        });
    }

    const headers = {
      ...common,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
    };
    if (head) return { status: 206, headers };

    const length = range.end - range.start + 1;
    const charge = await this.budget.charge(ip, length);
    if (!charge.allowed) {
      return failure(
        429,
        'TOO_MANY_REQUESTS',
        '지도를 짧은 시간에 많이 받았어요. 잠시 후 다시 시도해 주세요.',
        { 'Retry-After': String(charge.retryAfterSeconds) },
      );
    }

    try {
      return { status: 206, headers, body: await this.archive.read(range.start, range.end) };
    } catch {
      // Nothing was sent, so nothing counts. Charging first keeps two parallel reads from both
      // passing the line; the refund undoes it.
      await this.budget.refund(ip, length, charge.window).catch(() => undefined);
      return failure(
        503,
        'MAP_UNAVAILABLE',
        '지도 파일을 읽지 못했어요. 잠시 후 다시 시도해 주세요.',
      );
    }
  }
}
