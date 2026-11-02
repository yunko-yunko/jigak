import { Injectable } from '@nestjs/common';
import { open, stat } from 'node:fs/promises';
import {
  ngiiArchivePath,
  PMTILES_HEADER_BYTES,
  rememberNgiiAvailability,
} from '../domain/map-archive.js';

export interface ArchiveFile {
  size: number;
  /** Strong, from size and modification time: PMTiles drops weak tags and compares this one. */
  etag: string;
}

/** The archive on a local disk or a read-only bucket volume. Only the one configured file is read. */
@Injectable()
export class MapArchiveRepository {
  private readonly path = ngiiArchivePath();

  get configured() {
    return this.path !== undefined;
  }

  /** null when the file is missing or not a regular file (a volume not mounted yet). */
  async describe(): Promise<ArchiveFile | null> {
    if (!this.path) return null;
    try {
      const file = await stat(this.path);
      const available = file.isFile() && file.size >= PMTILES_HEADER_BYTES;
      rememberNgiiAvailability(this.path, available);
      if (!file.isFile()) return null;
      return {
        size: file.size,
        etag: `"${file.size.toString(36)}-${Math.floor(file.mtimeMs).toString(36)}"`,
      };
    } catch {
      rememberNgiiAvailability(this.path, false);
      return null;
    }
  }

  /** Bytes start..end inclusive; the range was checked against the size first. */
  async read(start: number, end: number): Promise<Buffer> {
    const handle = await open(this.path!, 'r');
    try {
      const buffer = Buffer.alloc(end - start + 1);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          start + filled,
        );
        if (bytesRead === 0) throw new Error('map archive ended before the requested range');
        filled += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }
}
