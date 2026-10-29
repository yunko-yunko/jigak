import { gzip, constants } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);
const MIN_COMPRESSION_BYTES = 16 * 1024;

/** Lossless transport only: all geometry, evidence and ETA values remain in the JSON. */
export async function encodeRouteResponse(value: unknown, acceptsGzip: boolean) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');

  if (acceptsGzip && body.byteLength >= MIN_COMPRESSION_BYTES) {
    try {
      // zlib runs asynchronously; low compression effort avoids delaying route delivery.
      const compressed = await compress(body, {
        level: constants.Z_BEST_SPEED,
      });

      if (compressed.byteLength < body.byteLength) {
        return {
          body: compressed,
          encoding: 'gzip' as const,
        };
      }
    } catch {
      /* Compression failure cannot discard a valid route response. */
    }
  }

  return {
    body,
    encoding: null,
  };
}
