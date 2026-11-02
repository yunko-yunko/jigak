/**
 * The most one response returns: twice the largest tile in seoul-ngii-v1 (245 KiB at z14). The
 * PMTiles client reads 16 KiB for the header and root directory, then one exact range per tile or
 * leaf directory, so every read it makes fits.
 */
export const MAX_RANGE_BYTES = 512 * 1024;

/** `end` is inclusive, as in Content-Range. */
export type ByteRange =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'multiple' }
  | { kind: 'too-large' }
  | { kind: 'unsatisfiable' };

const SPEC = /^(\d{0,15})-(\d{0,15})$/;

/**
 * One `bytes=` range of a file of `size` bytes (RFC 9110 §14). Closed and suffix ranges are served
 * exactly or refused when longer than `max` (a shorter answer would corrupt a PMTiles read, which
 * trusts the length it asked for). An open range (`bytes=N-`) asks for the rest of the file and
 * gets at most `max` bytes. A closed range past the end is cut at the end, as the RFC allows.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
  max = MAX_RANGE_BYTES,
): ByteRange {
  if (header === undefined || !header.trim()) return { kind: 'missing' };

  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!match) return { kind: 'invalid' };
  const specs = match[1]!.split(',').filter((spec) => spec.trim());
  if (specs.length > 1) return { kind: 'multiple' };
  const spec = SPEC.exec((specs[0] ?? '').replace(/\s+/g, ''));
  if (!spec || (!spec[1] && !spec[2])) return { kind: 'invalid' };

  if (!spec[1]) {
    const suffix = Number(spec[2]);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    if (Math.min(suffix, size) > max) return { kind: 'too-large' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(spec[1]);
  if (spec[2] && Number(spec[2]) < start) return { kind: 'invalid' };
  if (start >= size) return { kind: 'unsatisfiable' };
  if (!spec[2]) return { kind: 'range', start, end: Math.min(size - 1, start + max - 1) };

  const end = Math.min(size - 1, Number(spec[2]));
  if (end - start + 1 > max) return { kind: 'too-large' };
  return { kind: 'range', start, end };
}
