import 'reflect-metadata';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { DataSource, MoreThan } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/common/database/database.service.js';
import { ApiRateWindowEntity } from '../src/common/database/entities/api-rate-window.entity.js';
import { RuntimeRepository } from '../src/common/providers/runtime.repository.js';
import { configureApplication } from '../src/common/http/configure-app.js';
import { validateEnvironment } from '../src/common/config/environment.js';
import { normalizeWalk, type RouteProvider } from '../src/common/engine/kakao.js';
import { RealtimeService } from '../src/common/engine/realtime/service.js';
import { NearbyTransitService } from '../src/common/engine/realtime/nearby-transit.js';
import { RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { WeatherFeed } from '../src/common/engine/realtime/weather.js';
import { SeoulParkingFeed } from '../src/common/engine/realtime/parking.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';
import { MAX_RANGE_BYTES, parseByteRange } from '../src/modules/maps/domain/byte-range.js';
import {
  DEFAULT_NGII_BYTE_BUDGET_MIB,
  DEFAULT_NGII_BYTE_WINDOW_MINUTES,
  MAP_ARCHIVE_REQUESTS_PER_MINUTE,
  mapByteBudgetSubject,
  mapByteWindowKey,
  NGII_BYTE_BUDGET_ENV,
  NGII_BYTE_WINDOW_ENV,
  NGII_PATH_ENV,
  ngiiByteBudget,
  ngiiMapStatus,
} from '../src/modules/maps/domain/map-archive.js';
import { MapByteBudgetRepository } from '../src/modules/maps/repository/map-byte-budget.repository.js';
import { MapsService } from '../src/modules/maps/service/maps.service.js';
import type { MapArchiveRepository } from '../src/modules/maps/repository/map-archive.repository.js';
import { createTestDatabase } from './helpers/auth-database.js';

const ROUTE = 'maps/seoul-ngii-v1.pmtiles';
const APP_ORIGIN = 'http://localhost:8081';
const MIB = 1024 * 1024;
const BUDGET = DEFAULT_NGII_BYTE_BUDGET_MIB * MIB;
const WINDOW_MS = DEFAULT_NGII_BYTE_WINDOW_MINUTES * 60_000;

// ---- A small PMTiles v3 archive: header, uncompressed root directory, three tiles ----

function varint(value: number, out: number[]) {
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

function directory(entries: { tileId: number; offset: number; length: number }[]) {
  const out: number[] = [];
  varint(entries.length, out);
  let last = 0;
  for (const entry of entries) {
    varint(entry.tileId - last, out);
    last = entry.tileId;
  }
  for (const _ of entries) varint(1, out);
  for (const entry of entries) varint(entry.length, out);
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    varint(
      previous && previous.offset + previous.length === entry.offset ? 0 : entry.offset + 1,
      out,
    );
  });
  return Buffer.from(out);
}

/** Tiles 0 and 1 are small; tile 2 is larger than one response may be. */
function buildArchive() {
  const tiles = [
    Buffer.from('tile-zero'),
    Buffer.from('tile-one-is-a-bit-longer'),
    Buffer.alloc(MAX_RANGE_BYTES + 4096, 7),
  ];
  let offset = 0;
  const entries = tiles.map((tile, tileId) => {
    const entry = { tileId, offset, length: tile.length };
    offset += tile.length;
    return entry;
  });
  const root = directory(entries);
  const metadata = Buffer.from('{"name":"test"}');
  const dataOffset = 16384;
  const data = Buffer.concat(tiles);
  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header[7] = 3;
  const fields = [
    127, // root directory offset
    root.length,
    dataOffset + data.length, // metadata offset
    metadata.length,
    dataOffset + data.length + metadata.length, // leaf directories offset
    0,
    dataOffset,
    data.length,
    tiles.length,
    tiles.length,
    tiles.length,
  ];
  fields.forEach((value, index) => header.writeBigUInt64LE(BigInt(value), 8 + index * 8));
  header[96] = 1; // clustered
  header[97] = 1; // internal compression: none
  header[98] = 1; // tile compression: none
  header[99] = 1; // vector tiles
  header[100] = 14;
  header[101] = 16;
  const padding = Buffer.alloc(dataOffset - 127 - root.length);
  return { file: Buffer.concat([header, root, padding, data, metadata]), tiles, entries };
}

// ---- What the PMTiles client does with the bytes it reads ----

interface Header {
  rootOffset: number;
  rootLength: number;
  metadataOffset: number;
  metadataLength: number;
  leafOffset: number;
  dataOffset: number;
  internalCompression: number;
}

function parseHeader(bytes: Buffer): Header {
  assert.equal(bytes.subarray(0, 7).toString('ascii'), 'PMTiles');
  assert.equal(bytes[7], 3);
  const field = (index: number) => Number(bytes.readBigUInt64LE(8 + index * 8));
  return {
    rootOffset: field(0),
    rootLength: field(1),
    metadataOffset: field(2),
    metadataLength: field(3),
    leafOffset: field(4),
    dataOffset: field(6),
    internalCompression: bytes[97]!,
  };
}

function parseDirectory(raw: Buffer, compression: number) {
  const bytes = compression === 2 ? gunzipSync(raw) : raw;
  let position = 0;
  const read = () => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = bytes[position++]!;
      value += (byte & 0x7f) * shift;
      if (byte < 0x80) return value;
      shift *= 128;
    }
  };
  const count = read();
  const entries = Array.from({ length: count }, () => ({
    tileId: 0,
    runLength: 0,
    length: 0,
    offset: 0,
  }));
  let last = 0;
  for (const entry of entries) entry.tileId = last += read();
  for (const entry of entries) entry.runLength = read();
  for (const entry of entries) entry.length = read();
  entries.forEach((entry, index) => {
    const value = read();
    const previous = entries[index - 1];
    entry.offset = value === 0 && previous ? previous.offset + previous.length : value - 1;
  });
  return entries;
}

// ---- The app with the real HTTP pipeline (CORS, rate limit, filter) ----

function runtime(): RoutingOptions {
  const provider: RouteProvider = {
    configured: true,
    searchPlaces: async () => [],
    walking: async (endpoints, budget) =>
      budget.run(() =>
        normalizeWalk(
          { status: 'OK', route: { properties: { totalDistance: 1, totalTime: 1 }, legs: [] } },
          endpoints,
        ),
      ),
    transit: async () => [],
  };
  return {
    provider,
    realtime: new RealtimeService({}),
    nearbyTransit: new NearbyTransitService({ provider }),
    traffic: new RoadTrafficService({}),
    mobility: new MobilityFeeds({}),
    weather: new WeatherFeed(),
    parking: new SeoulParkingFeed(),
    intermediateTransitHubs: 0,
  };
}

async function startApp(archivePath: string | undefined) {
  if (archivePath) process.env[NGII_PATH_ENV] = archivePath;
  else delete process.env[NGII_PATH_ENV];

  const db = await createTestDatabase();
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DataSource)
    .useValue(db.dataSource)
    .overrideProvider(DatabaseService)
    .useValue(db.database)
    .overrideProvider(RuntimeRepository)
    .useValue({ options: runtime() })
    .compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  configureApplication(app, {
    DB_PASSWORD: 'test',
    AUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  return {
    db,
    request: (path: string, init: RequestInit = {}) => fetch(`${url}/api/${path}`, init),
    range: (path: string, range: string, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/${path}`, { headers: { Range: range, ...headers } }),
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('byte ranges: one range, capped, past-the-end cut, everything else refused', () => {
  const size = 2_000_000;
  assert.deepEqual(parseByteRange('bytes=0-16383', size), { kind: 'range', start: 0, end: 16383 });
  assert.deepEqual(parseByteRange('Bytes = 10 - 19', size), { kind: 'range', start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=0-16383', 100), { kind: 'range', start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=100-', size), {
    kind: 'range',
    start: 100,
    end: 100 + MAX_RANGE_BYTES - 1,
  });
  assert.deepEqual(parseByteRange('bytes=-10', size), {
    kind: 'range',
    start: size - 10,
    end: size - 1,
  });
  assert.deepEqual(parseByteRange(`bytes=0-${MAX_RANGE_BYTES - 1}`, size).kind, 'range');
  assert.equal(parseByteRange(`bytes=0-${MAX_RANGE_BYTES}`, size).kind, 'too-large');
  assert.equal(parseByteRange(`bytes=-${MAX_RANGE_BYTES + 1}`, size).kind, 'too-large');
  assert.equal(parseByteRange(undefined, size).kind, 'missing');
  assert.equal(parseByteRange('  ', size).kind, 'missing');
  assert.equal(parseByteRange('bytes=0-1,4-5', size).kind, 'multiple');
  for (const header of ['bytes=5-1', 'bytes=-', 'items=0-1', 'bytes=a-b', 'bytes=0-1-2']) {
    assert.equal(parseByteRange(header, size).kind, 'invalid', header);
  }
  assert.equal(parseByteRange(`bytes=${size}-`, size).kind, 'unsatisfiable');
  assert.equal(parseByteRange('bytes=-0', size).kind, 'unsatisfiable');
});

test('MAP_NGII_PMTILES_PATH must be absolute; blank turns the map off', () => {
  assert.throws(
    () => validateEnvironment({ DB_PASSWORD: 'x', MAP_NGII_PMTILES_PATH: 'maps/seoul.pmtiles' }),
    /MAP_NGII_PMTILES_PATH/,
  );
  assert.equal(
    validateEnvironment({ DB_PASSWORD: 'x', MAP_NGII_PMTILES_PATH: ' ' }).MAP_NGII_PMTILES_PATH,
    undefined,
  );
  assert.equal(
    validateEnvironment({ DB_PASSWORD: 'x', MAP_NGII_PMTILES_PATH: '/maps/seoul-ngii-v1.pmtiles' })
      .MAP_NGII_PMTILES_PATH,
    '/maps/seoul-ngii-v1.pmtiles',
  );
});

test('the byte budget is 60 MiB per 10 minutes unless the environment says otherwise', () => {
  assert.equal(DEFAULT_NGII_BYTE_BUDGET_MIB, 60);
  assert.equal(DEFAULT_NGII_BYTE_WINDOW_MINUTES, 10);
  assert.deepEqual(ngiiByteBudget({}), { bytes: 60 * MIB, windowMs: 600_000 });
  assert.deepEqual(
    ngiiByteBudget({ [NGII_BYTE_BUDGET_ENV]: ' ', [NGII_BYTE_WINDOW_ENV]: '' }),
    ngiiByteBudget({}),
  );
  assert.deepEqual(ngiiByteBudget({ [NGII_BYTE_BUDGET_ENV]: '48', [NGII_BYTE_WINDOW_ENV]: '30' }), {
    bytes: 48 * MIB,
    windowMs: 1_800_000,
  });
  for (const value of ['0', '-1', '1.5', '1025', 'lots', '1e2']) {
    assert.throws(
      () => ngiiByteBudget({ [NGII_BYTE_BUDGET_ENV]: value }),
      /MAP_NGII_BYTE_BUDGET_MIB/,
    );
  }
  for (const value of ['0', '1441', '2.5']) {
    assert.throws(
      () => ngiiByteBudget({ [NGII_BYTE_WINDOW_ENV]: value }),
      /MAP_NGII_BYTE_WINDOW_MINUTES/,
    );
  }
  // seoul-ngii-v1 (133,894,110 bytes) does not fit in one window.
  assert.ok(133_894_110 > BUDGET);
});

test('the byte budget is shared in PostgreSQL, per IP, and resets after its window', async (t) => {
  delete process.env[NGII_BYTE_BUDGET_ENV];
  delete process.env[NGII_BYTE_WINDOW_ENV];
  const db = await createTestDatabase();
  const budget = new MapByteBudgetRepository(db.database);
  const windows = db.database.getRepository(ApiRateWindowEntity);
  const start = 5_000_000;
  const used = async (ip: string) =>
    (await windows.findOneBy({ key: mapByteWindowKey(ip) }))?.count;

  try {
    await t.test('normal use: hundreds of tile reads stay far inside it', async () => {
      for (let tile = 0; tile < 300; tile += 1) {
        assert.deepEqual(await budget.charge('10.0.0.1', 64 * 1024, start + tile * 1000), {
          allowed: true,
          window: start + WINDOW_MS,
        });
      }
      assert.equal(await used('10.0.0.1'), 300 * 64 * 1024);
      await windows.clear();
    });

    await t.test('60 MiB passes; the 61st MiB inside the window is refused', async () => {
      // 120 reads of 512 KiB, the most one response may hold, fill the budget exactly.
      for (let read = 0; read < BUDGET / (512 * 1024); read += 1) {
        assert.equal((await budget.charge('10.0.0.2', 512 * 1024, start + read)).allowed, true);
      }
      assert.equal(await used('10.0.0.2'), BUDGET);

      const refused = await budget.charge('10.0.0.2', MIB, start + 60_000);
      assert.deepEqual(refused, { allowed: false, retryAfterSeconds: 540 });
      assert.equal((await budget.charge('10.0.0.2', 1, start + WINDOW_MS - 1)).allowed, false);
      // A refused read adds nothing and does not stretch the window.
      const row = await windows.findOneBy({ key: mapByteWindowKey('10.0.0.2') });
      assert.deepEqual(
        { count: row?.count, expiresAt: row?.expiresAt },
        {
          count: BUDGET,
          expiresAt: start + WINDOW_MS,
        },
      );
    });

    await t.test(
      'a read that would cross the line is refused whole, a smaller one still fits',
      async () => {
        await windows.update({ key: mapByteWindowKey('10.0.0.2') }, { count: BUDGET - 1000 });
        assert.equal((await budget.charge('10.0.0.2', 1001, start + 1000)).allowed, false);
        assert.equal((await budget.charge('10.0.0.2', 1000, start + 1000)).allowed, true);
        assert.equal(await used('10.0.0.2'), BUDGET);
      },
    );

    await t.test('another IP has its own budget', async () => {
      assert.equal((await budget.charge('10.0.0.3', 512 * 1024, start + 2000)).allowed, true);
      assert.equal(await used('10.0.0.3'), 512 * 1024);
    });

    await t.test('after the window the IP starts a new one', async () => {
      const fresh = start + WINDOW_MS;
      assert.equal((await budget.charge('10.0.0.2', 512 * 1024, fresh)).allowed, true);
      const row = await windows.findOneBy({ key: mapByteWindowKey('10.0.0.2') });
      assert.deepEqual(
        { count: row?.count, expiresAt: row?.expiresAt },
        {
          count: 512 * 1024,
          expiresAt: fresh + WINDOW_MS,
        },
      );
    });
  } finally {
    await db.close();
  }
});

test('the repository takes its budget and window from the environment at startup', async (t) => {
  const db = await createTestDatabase();
  const windows = db.database.getRepository(ApiRateWindowEntity);
  try {
    await t.test('1 MiB per 2 minutes: 1 MiB passes, one byte more is refused', async () => {
      process.env[NGII_BYTE_BUDGET_ENV] = '1';
      process.env[NGII_BYTE_WINDOW_ENV] = '2';
      const budget = new MapByteBudgetRepository(db.database);
      delete process.env[NGII_BYTE_BUDGET_ENV];
      delete process.env[NGII_BYTE_WINDOW_ENV];

      assert.deepEqual(budget.budget, { bytes: MIB, windowMs: 120_000 });
      assert.equal((await budget.charge('10.1.0.1', MIB - 1, 1_000)).allowed, true);
      assert.equal((await budget.charge('10.1.0.1', 1, 1_000)).allowed, true);
      assert.deepEqual(await budget.charge('10.1.0.1', 1, 1_000), {
        allowed: false,
        retryAfterSeconds: 120,
      });
      // The value was read once: changing the environment later does not move it.
      assert.deepEqual(budget.budget, { bytes: MIB, windowMs: 120_000 });
      await windows.clear();
    });

    await t.test('a bad value stops the repository, and so the server, from starting', async () => {
      for (const [name, value] of [
        [NGII_BYTE_BUDGET_ENV, '0'],
        [NGII_BYTE_BUDGET_ENV, 'many'],
        [NGII_BYTE_WINDOW_ENV, '1441'],
      ] as const) {
        process.env[name] = value;
        try {
          assert.throws(() => new MapByteBudgetRepository(db.database), new RegExp(name));
          await assert.rejects(
            Test.createTestingModule({ imports: [AppModule] })
              .overrideProvider(DataSource)
              .useValue(db.dataSource)
              .overrideProvider(DatabaseService)
              .useValue(db.database)
              .overrideProvider(RuntimeRepository)
              .useValue({ options: runtime() })
              .compile(),
            new RegExp(name),
          );
        } finally {
          delete process.env[name];
        }
      }
    });
  } finally {
    await db.close();
  }
});

test('IPv6 counts per /64; IPv4, also written ::ffff:a.b.c.d, per address', () => {
  assert.equal(mapByteBudgetSubject('203.0.113.7'), '203.0.113.7');
  assert.equal(mapByteBudgetSubject('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(mapByteBudgetSubject('2001:db8:12:34:aaaa::1'), '2001:db8:12:34::/64');
  assert.equal(mapByteBudgetSubject('2001:0DB8:0012:0034:ffff:1:2:3'), '2001:db8:12:34::/64');
  assert.equal(mapByteBudgetSubject('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(mapByteBudgetSubject('fe80::1%en0'), 'fe80:0:0:0::/64');
  assert.equal(mapByteBudgetSubject('::1'), '0:0:0:0::/64');
  assert.equal(mapByteBudgetSubject('unknown'), 'unknown');

  // Another address in the same /64 is the same budget; the next /64 is not.
  assert.equal(mapByteWindowKey('2001:db8:12:34::1'), mapByteWindowKey('2001:db8:12:34:9:8:7:6'));
  assert.notEqual(mapByteWindowKey('2001:db8:12:34::1'), mapByteWindowKey('2001:db8:12:35::1'));
  assert.equal(mapByteWindowKey('::ffff:10.0.0.1'), mapByteWindowKey('10.0.0.1'));
  assert.notEqual(mapByteWindowKey('10.0.0.1'), mapByteWindowKey('10.0.0.2'));
});

test('a read that fails after its charge gives the bytes back; only sent bytes count', async (t) => {
  delete process.env[NGII_BYTE_BUDGET_ENV];
  delete process.env[NGII_BYTE_WINDOW_ENV];
  const db = await createTestDatabase();
  const budget = new MapByteBudgetRepository(db.database);
  const windows = db.database.getRepository(ApiRateWindowEntity);
  const used = async (ip: string) =>
    (await windows.findOneBy({ key: mapByteWindowKey(ip) }))?.count;
  let failRead = true;
  const archive = {
    configured: true,
    describe: async () => ({ size: 2 * MIB, etag: '"x"' }),
    read: async (start: number, end: number) => {
      if (failRead) throw new Error('volume went away');
      return Buffer.alloc(end - start + 1);
    },
  } as unknown as MapArchiveRepository;
  const service = new MapsService(archive, budget);

  try {
    await t.test('a 503 from the read itself costs nothing', async () => {
      assert.equal((await service.ngii('GET', 'bytes=0-16383', '10.2.0.1')).status, 503);
      assert.equal((await used('10.2.0.1')) ?? 0, 0);

      failRead = false;
      assert.equal((await service.ngii('GET', 'bytes=0-16383', '10.2.0.1')).status, 206);
      failRead = true;
      const failed = await service.ngii('GET', 'bytes=0-1023', '10.2.0.1');
      assert.equal(failed.status, 503);
      assert.equal(failed.error?.code, 'MAP_UNAVAILABLE');
      assert.equal(await used('10.2.0.1'), 16384);
    });

    await t.test('a refund never reaches into a newer window', async () => {
      const start = 9_000_000;
      const first = await budget.charge('10.2.0.2', 1000, start);
      assert.equal(first.allowed, true);
      const next = await budget.charge('10.2.0.2', 300, start + WINDOW_MS);
      assert.deepEqual(next, { allowed: true, window: start + 2 * WINDOW_MS });

      await budget.refund('10.2.0.2', 1000, first.allowed ? first.window : 0);
      assert.equal(await used('10.2.0.2'), 300);
      await budget.refund('10.2.0.2', 300, start + 2 * WINDOW_MS);
      assert.equal(await used('10.2.0.2'), 0);
    });
  } finally {
    await db.close();
  }
});

test('health looks at the archive file at most once per 30 seconds', () => {
  const folder = mkdtempSync(join(tmpdir(), 'jigak-ngii-status-'));
  const path = join(folder, 'seoul-ngii-v1.pmtiles');
  const env = { [NGII_PATH_ENV]: path };
  try {
    writeFileSync(path, buildArchive().file);
    assert.deepEqual(ngiiMapStatus(env, 1_000_000), { configured: true, available: true });
    rmSync(path);
    // Within the window the last answer stands; after it the file is looked at again.
    assert.equal(ngiiMapStatus(env, 1_029_000).available, true);
    assert.equal(ngiiMapStatus(env, 1_031_000).available, false);
    assert.deepEqual(ngiiMapStatus({}, 1_031_000), { configured: false, available: false });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the NGII archive is served by single byte ranges only, through the app server', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'jigak-ngii-'));
  const archivePath = join(folder, 'seoul-ngii-v1.pmtiles');
  const { file, tiles, entries } = buildArchive();
  writeFileSync(archivePath, file);
  const app = await startApp(archivePath);

  try {
    await t.test(
      '206 with the exact bytes, Content-Range, a strong ETag and private cache',
      async () => {
        const response = await app.range(ROUTE, 'bytes=0-15');
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('content-range'), `bytes 0-15/${file.length}`);
        assert.equal(response.headers.get('content-length'), '16');
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('cache-control'), 'private, max-age=300');
        assert.match(response.headers.get('etag') ?? '', /^"[0-9a-z]+-[0-9a-z]+"$/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.subarray(0, 16));

        const again = await app.range(ROUTE, 'bytes=100-199');
        assert.equal(again.headers.get('etag'), response.headers.get('etag'));
        assert.deepEqual(Buffer.from(await again.arrayBuffer()), file.subarray(100, 200));
      },
    );

    await t.test(
      'a PMTiles read through the endpoint parses and finds every small tile',
      async () => {
        // The client's first read: 16 KiB holding the header and the root directory.
        const first = Buffer.from(await (await app.range(ROUTE, 'bytes=0-16383')).arrayBuffer());
        assert.equal(first.length, 16384);
        const header = parseHeader(first);
        const root = parseDirectory(
          first.subarray(header.rootOffset, header.rootOffset + header.rootLength),
          header.internalCompression,
        );
        assert.deepEqual(
          root.map(({ tileId, offset, length }) => ({ tileId, offset, length })),
          entries,
        );
        for (const entry of root.slice(0, 2)) {
          const start = header.dataOffset + entry.offset;
          const tile = await app.range(ROUTE, `bytes=${start}-${start + entry.length - 1}`);
          assert.equal(tile.status, 206);
          assert.deepEqual(Buffer.from(await tile.arrayBuffer()), tiles[entry.tileId]);
        }
      },
    );

    await t.test('no Range on GET is 400 RANGE_REQUIRED, never the whole file', async () => {
      const response = await app.request(ROUTE);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'RANGE_REQUIRED');
    });

    await t.test('a closed range over 512 KiB is refused; an open one is capped', async () => {
      const big = entries[2]!;
      const start = 16384 + big.offset;
      const refused = await app.range(ROUTE, `bytes=${start}-${start + big.length - 1}`);
      assert.equal(refused.status, 400);
      assert.equal((await refused.json()).error.code, 'RANGE_TOO_LARGE');

      const open = await app.range(ROUTE, `bytes=${start}-`);
      assert.equal(open.status, 206);
      assert.equal(
        open.headers.get('content-range'),
        `bytes ${start}-${start + MAX_RANGE_BYTES - 1}/${file.length}`,
      );
      assert.equal((await open.arrayBuffer()).byteLength, MAX_RANGE_BYTES);
    });

    await t.test(
      'multiple ranges are refused; a range past the end is 416 with the size',
      async () => {
        const multiple = await app.range(ROUTE, 'bytes=0-1,10-11');
        assert.equal(multiple.status, 400);
        assert.equal((await multiple.json()).error.code, 'RANGE_INVALID');

        const past = await app.range(ROUTE, `bytes=${file.length}-${file.length + 10}`);
        assert.equal(past.status, 416);
        assert.equal(past.headers.get('content-range'), `bytes */${file.length}`);
        // An error is not a piece of the file: not cached, and no strong file ETag (Express may add
        // its weak body tag to the JSON, which PMTiles ignores).
        assert.doesNotMatch(past.headers.get('etag') ?? '', /^"/);
        assert.equal(past.headers.get('cache-control'), 'no-store');
        assert.equal((await past.json()).error.code, 'RANGE_NOT_SATISFIABLE');
      },
    );

    await t.test('HEAD answers headers only: size without a range, 206 with one', async () => {
      const plain = await app.request(ROUTE, { method: 'HEAD' });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('content-length'), String(file.length));
      assert.equal(plain.headers.get('accept-ranges'), 'bytes');
      assert.equal((await plain.arrayBuffer()).byteLength, 0);

      const ranged = await app.request(ROUTE, { method: 'HEAD', headers: { Range: 'bytes=0-9' } });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${file.length}`);
      assert.equal((await ranged.arrayBuffer()).byteLength, 0);
    });

    await t.test(
      'CORS: app origins and the map frame (Origin: null) only, no credentials',
      async () => {
        const allowed = await app.range(ROUTE, 'bytes=0-15', { Origin: APP_ORIGIN });
        assert.equal(allowed.status, 206);
        assert.equal(allowed.headers.get('access-control-allow-origin'), APP_ORIGIN);
        assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
        assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /Content-Range/);
        assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /ETag/);
        assert.match(allowed.headers.get('vary') ?? '', /Origin/);

        const frame = await app.range(ROUTE, 'bytes=0-15', { Origin: 'null' });
        assert.equal(frame.status, 206);
        assert.equal(frame.headers.get('access-control-allow-origin'), 'null');

        const preflight = await app.request(ROUTE, {
          method: 'OPTIONS',
          headers: {
            Origin: 'null',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'range',
          },
        });
        assert.equal(preflight.status, 204);
        assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Range/);

        const foreign = await app.range(ROUTE, 'bytes=0-15', { Origin: 'https://evil.example' });
        assert.equal(foreign.status, 403);
        assert.equal(foreign.headers.get('access-control-allow-origin'), null);

        // The opaque origin opens this route only.
        assert.equal((await app.request('health', { headers: { Origin: 'null' } })).status, 403);
      },
    );

    await t.test(
      'health says the map is set and readable without disclosing the path',
      async () => {
        const response = await app.request('health');
        const text = await response.text();
        assert.deepEqual(JSON.parse(text).maps, { ngii: { configured: true, available: true } });
        assert.equal(text.includes(folder), false);
      },
    );

    await t.test('the shared PostgreSQL throttle counts archive reads per IP', async () => {
      await app.range(ROUTE, 'bytes=0-0');
      const windows = app.db.database.getRepository(ApiRateWindowEntity);
      await windows.update({ count: MoreThan(0) }, { count: MAP_ARCHIVE_REQUESTS_PER_MINUTE });
      const limited = await app.range(ROUTE, 'bytes=0-0');
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
      // Routes ignore case, so the throttle must too.
      assert.equal((await app.range('MAPS/Seoul-NGII-v1.pmtiles', 'bytes=0-0')).status, 429);
      await windows.clear();
    });

    await t.test(
      'only bytes a GET returns count: HEAD, 400 and 416 cost nothing; past the budget is 429',
      async () => {
        const windows = app.db.database.getRepository(ApiRateWindowEntity);
        await windows.clear();
        const key = mapByteWindowKey('127.0.0.1');
        const bytesUsed = async () => (await windows.findOneBy({ key }))?.count ?? 0;

        await app.request(ROUTE, { method: 'HEAD' });
        await app.request(ROUTE, { method: 'HEAD', headers: { Range: 'bytes=0-16383' } });
        await app.request(ROUTE);
        await app.range(ROUTE, 'bytes=0-1,10-11');
        await app.range(ROUTE, 'bytes=a-b');
        await app.range(ROUTE, `bytes=0-${MAX_RANGE_BYTES}`);
        await app.range(ROUTE, `bytes=${file.length}-`);
        assert.equal(await bytesUsed(), 0);

        assert.equal((await app.range(ROUTE, 'bytes=0-16383')).status, 206);
        assert.equal(await bytesUsed(), 16384);

        await windows.update({ key }, { count: BUDGET - 10 });
        const over = await app.range(ROUTE, 'bytes=0-15', { Origin: 'null' });
        assert.equal(over.status, 429);
        const retryAfter = Number(over.headers.get('retry-after'));
        assert.ok(retryAfter > 0 && retryAfter <= DEFAULT_NGII_BYTE_WINDOW_MINUTES * 60);
        assert.match(over.headers.get('access-control-expose-headers') ?? '', /Retry-After/);
        assert.equal(over.headers.get('access-control-allow-origin'), 'null');
        assert.equal(over.headers.get('cache-control'), 'no-store');
        assert.deepEqual((await over.json()).error, {
          code: 'TOO_MANY_REQUESTS',
          message: '지도를 짧은 시간에 많이 받았어요. 잠시 후 다시 시도해 주세요.',
        });
        // What still fits is served, and HEAD keeps answering.
        assert.equal((await app.range(ROUTE, 'bytes=0-9')).status, 206);
        assert.equal(await bytesUsed(), BUDGET);
        assert.equal((await app.request(ROUTE, { method: 'HEAD' })).status, 200);
        await windows.clear();
      },
    );

    await t.test('a missing file is 503 and health says it is not available', async () => {
      rmSync(archivePath);
      const response = await app.range(ROUTE, 'bytes=0-15');
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, 'MAP_UNAVAILABLE');
      assert.deepEqual((await (await app.request('health')).json()).maps, {
        ngii: { configured: true, available: false },
      });
    });
  } finally {
    await app.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('without MAP_NGII_PMTILES_PATH the route is 404 MAP_NOT_CONFIGURED', async () => {
  const app = await startApp(undefined);
  try {
    const response = await app.range(ROUTE, 'bytes=0-15');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'MAP_NOT_CONFIGURED');
    assert.deepEqual((await (await app.request('health')).json()).maps, {
      ngii: { configured: false, available: false },
    });
  } finally {
    await app.close();
  }
});

// The real archive stays out of git (NGII data may not leave Korea); this runs where it exists.
const shipped = new URL('../../mvp/data/map/seoul-ngii-v1.pmtiles', import.meta.url);

test(
  'every read PMTiles makes on seoul-ngii-v1 fits one response',
  { skip: !existsSync(shipped) },
  async () => {
    const app = await startApp(shipped.pathname);
    try {
      const first = Buffer.from(await (await app.range(ROUTE, 'bytes=0-16383')).arrayBuffer());
      const header = parseHeader(first);
      assert.ok(header.rootOffset + header.rootLength <= 16384);
      const root = parseDirectory(
        first.subarray(header.rootOffset, header.rootOffset + header.rootLength),
        header.internalCompression,
      );
      // Leaf directories are read whole too.
      const file = readFileSync(shipped);
      const all = root.flatMap((entry) =>
        entry.runLength === 0
          ? parseDirectory(
              file.subarray(
                header.leafOffset + entry.offset,
                header.leafOffset + entry.offset + entry.length,
              ),
              header.internalCompression,
            )
          : [entry],
      );
      for (const entry of root.filter((leaf) => leaf.runLength === 0)) {
        assert.ok(entry.length <= MAX_RANGE_BYTES);
      }
      assert.ok(header.metadataLength <= MAX_RANGE_BYTES);
      const largest = all.reduce((a, b) => (b.length > a.length ? b : a));
      assert.ok(largest.length <= MAX_RANGE_BYTES, `largest tile ${largest.length} bytes`);

      const start = header.dataOffset + largest.offset;
      const tile = await app.range(ROUTE, `bytes=${start}-${start + largest.length - 1}`);
      assert.equal(tile.status, 206);
      assert.deepEqual(
        Buffer.from(await tile.arrayBuffer()),
        file.subarray(start, start + largest.length),
      );
    } finally {
      await app.close();
    }
  },
);
