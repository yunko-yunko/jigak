// Stored simulator windows and the readiness of a day's window (docs/2026-11-01-scooter-simulation.md §22).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { serviceDayOf } from '../src/common/engine/simulation/calendar.js';
import { SharedScooterSimulation } from '../src/common/engine/simulation/shared-scooter-sim.js';
import {
  WINDOW_COLUMNS,
  windowColumn,
  type WindowData,
} from '../src/common/engine/simulation/sim-window.js';
import { VTYPE } from '../src/common/engine/simulation/sim-codes.js';
import {
  decodeWindow,
  encodeWindow,
  simulationCodeHash,
  WINDOW_FORMAT,
  WindowStore,
  WindowStoreReject,
  windowKey,
  type WindowKeyInputs,
} from '../src/common/engine/simulation/window-store.js';

const SIM = join(dirname(fileURLToPath(import.meta.url)), '../src/common/engine/simulation');
const NOON = Date.parse('2026-11-04T12:00:00+09:00');
const FLEETS = { scooter: 3000, ebike: 1000 };
const GANGNAM = { latitude: 37.4979, longitude: 127.0276 };
const directory = mkdtempSync(join(tmpdir(), 'jigak-sim-windows-'));
test.after(() => rmSync(directory, { recursive: true, force: true }));

const columnsSha = (data: WindowData) => {
  const hash = createHash('sha256');
  for (const path of WINDOW_COLUMNS) {
    const view = windowColumn(data, path);
    hash.update(path).update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return hash.digest('hex');
};
const answers = (simulation: SharedScooterSimulation) =>
  JSON.stringify([
    simulation.status(NOON),
    simulation.nearby(GANGNAM, 800, NOON),
    simulation.events({ limit: 200, since: NOON - 3_600_000 }, NOON),
    simulation.crews(NOON),
  ]);
const inputsOf = (simulation: SharedScooterSimulation): WindowKeyInputs => {
  const day = serviceDayOf(NOON);
  return {
    format: WINDOW_FORMAT,
    modelVersion: simulation.modelVersion,
    code: simulationCodeHash(),
    fleets: FLEETS,
    seed: simulation.seed,
    date: day.date,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
  };
};

// One computed window, shared by the tests below (about 2 s).
const first = new SharedScooterSimulation({
  builder: 'inline',
  fleets: FLEETS,
  windowDirectory: directory,
});
assert.equal(first.readiness(NOON).status, 'idle');
test.before(async () => {
  await first.ensure(NOON);
  await first.storeIdle();
});

test('a computed window is stored and read back identical in every column and answer', async () => {
  assert.equal(first.readiness(NOON).source, 'build');
  assert.equal(first.storeConfigured, true);
  const file = new WindowStore(directory).fileOf(inputsOf(first));
  assert.ok(existsSync(file), 'the window file is written');
  const second = new SharedScooterSimulation({
    builder: 'inline',
    fleets: FLEETS,
    windowDirectory: directory,
  });
  await second.ensure(NOON);
  const readiness = second.readiness(NOON);
  assert.equal(readiness.source, 'store');
  assert.equal(readiness.status, 'ready');
  assert.equal(columnsSha(second.window(NOON)!.data), columnsSha(first.window(NOON)!.data));
  assert.equal(answers(second), answers(first));
});

test('a file with one changed byte is rejected and deleted', () => {
  const inputs = inputsOf(first);
  const store = new WindowStore(directory);
  const original = readFileSync(store.fileOf(inputs));
  const broken = Buffer.from(original);
  broken[Math.floor(broken.length / 2)] ^= 0xff;
  writeFileSync(store.fileOf(inputs), broken);
  const logs: string[] = [];
  assert.equal(new WindowStore(directory, (line) => logs.push(line)).readSync(inputs), null);
  assert.equal(existsSync(store.fileOf(inputs)), false);
  assert.match(logs[0], /rejected/);
  writeFileSync(store.fileOf(inputs), original);
  assert.ok(new WindowStore(directory).readSync(inputs));
});

test('a file written for other inputs is rejected even with intact columns', () => {
  const inputs = inputsOf(first);
  const raw = Buffer.from(zstdDecompressSync(encodeWindow(first.window(NOON)!.data, inputs, 1)));
  const length = raw.readUInt32LE(8);
  const header = raw.subarray(12, 12 + length).toString('utf8');
  // Same length, so every column keeps its offset and its sha.
  const forged = header.replace('"seed":"jigak"', '"seed":"jigaq"');
  assert.notEqual(forged, header);
  raw.write(forged, 12, 'utf8');
  assert.throws(
    () => decodeWindow(zstdCompressSync(raw), inputs),
    (error: unknown) => error instanceof WindowStoreReject && error.message === 'key',
  );
  assert.throws(
    () => decodeWindow(encodeWindow(first.window(NOON)!.data, inputs, 1), { ...inputs, seed: 'x' }),
    WindowStoreReject,
  );
  assert.notEqual(windowKey(inputs), windowKey({ ...inputs, fleets: { scooter: 3000, ebike: 0 } }));
});

test('WINDOW_COLUMNS names every typed column of a window and nothing else', () => {
  const found: string[] = [];
  const walk = (value: Record<string, unknown>, path: string) => {
    for (const [key, item] of Object.entries(value))
      if (ArrayBuffer.isView(item)) found.push(path + key);
      else if (item && typeof item === 'object' && key !== 'meta')
        walk(item as Record<string, unknown>, `${path}${key}.`);
  };
  walk(first.window(NOON)!.data as unknown as Record<string, unknown>, '');
  assert.deepEqual([...found].sort(), [...WINDOW_COLUMNS].sort());
});

test('the code hash ignores files that only read a window and follows the simulator and its data', () => {
  const copy = mkdtempSync(join(tmpdir(), 'jigak-sim-code-'));
  try {
    const simulation = join(copy, 'simulation');
    cpSync(SIM, simulation, { recursive: true });
    cpSync(join(SIM, '../realtime/seoulAreas.ts'), join(copy, 'realtime/seoulAreas.ts'));
    const base = simulationCodeHash(simulation);
    writeFileSync(
      join(simulation, 'scooter-router.ts'),
      readFileSync(join(simulation, 'scooter-router.ts'), 'utf8') + '\n// consumer\n',
    );
    assert.equal(simulationCodeHash(simulation), base, 'a consumer edit keeps the key');
    writeFileSync(
      join(simulation, 'riders.ts'),
      readFileSync(join(simulation, 'riders.ts'), 'utf8') + '\n// model\n',
    );
    assert.notEqual(simulationCodeHash(simulation), base, 'a model edit changes the key');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  // Every data file the simulator names is part of the hash.
  for (const name of readdirSync(SIM).filter((file) => file.endsWith('.ts'))) {
    const text = readFileSync(join(SIM, name), 'utf8');
    for (const [, file] of text.matchAll(/dataFile\('([^']+)'\)/g))
      assert.ok(
        readFileSync(join(SIM, 'window-store.ts'), 'utf8').includes(`'${file}'`),
        `${file} (read by ${name}) is in WINDOW_DATA_FILES`,
      );
  }
});

test('eviction keeps yesterday to the day after tomorrow, the newest key of a day and 12 files', async () => {
  const evict = mkdtempSync(join(tmpdir(), 'jigak-sim-evict-'));
  try {
    const now = Date.parse('2026-11-04T12:00:00Z');
    const put = (name: string, ageHours: number) => {
      writeFileSync(join(evict, name), 'x');
      const at = new Date(now - ageHours * 3_600_000);
      utimesSync(join(evict, name), at, at);
    };
    const key = (n: number) => n.toString(16).padStart(16, '0');
    put(`2026-11-02_${key(1)}.simwin.zst`, 1); // before yesterday
    put(`2026-11-03_${key(2)}.simwin.zst`, 1);
    put(`2026-11-04_${key(3)}.simwin.zst`, 1);
    put(`2026-11-04_${key(4)}.simwin.zst`, 30); // an older revision of today, past a day
    put(`2026-11-04_${key(5)}.simwin.zst`, 5); // an older revision, still within a day
    put(`2026-11-06_${key(6)}.simwin.zst`, 1);
    put(`2026-11-07_${key(7)}.simwin.zst`, 1); // past the day after tomorrow
    put(`2026-11-04_${key(8)}.simwin.zst.tmp-1-abcdef12`, 1); // an abandoned write
    put(`2026-11-04_${key(9)}.simwin.zst.tmp-1-abcdef13`, 0.05); // a write in progress
    put('notes.txt', 100);
    await new WindowStore(evict).evict('2026-11-04', now);
    assert.deepEqual(readdirSync(evict).sort(), [
      `2026-11-03_${key(2)}.simwin.zst`,
      `2026-11-04_${key(3)}.simwin.zst`,
      `2026-11-04_${key(5)}.simwin.zst`,
      `2026-11-04_${key(9)}.simwin.zst.tmp-1-abcdef13`,
      `2026-11-06_${key(6)}.simwin.zst`,
      'notes.txt',
    ]);
    for (let n = 0; n < 14; n++) put(`2026-11-05_${key(100 + n)}.simwin.zst`, 0.5 + n / 100);
    await new WindowStore(evict).evict('2026-11-04', now);
    const kept = readdirSync(evict).filter((name) => name.endsWith('.simwin.zst'));
    assert.equal(kept.length, 12);
    assert.ok(!kept.some((name) => name.startsWith('2026-11-03')), 'the oldest day goes first');
  } finally {
    rmSync(evict, { recursive: true, force: true });
  }
});

test('the worker reads a stored day back and is ready within a second', async () => {
  const worker = mkdtempSync(join(tmpdir(), 'jigak-sim-worker-'));
  try {
    const built = new SharedScooterSimulation({ fleets: FLEETS, windowDirectory: worker });
    assert.equal(built.readiness(NOON).status, 'idle');
    const pending = built.ensure(NOON);
    assert.equal(built.readiness(NOON).status, 'building');
    assert.equal(built.isReady(NOON), false);
    await pending;
    await built.storeIdle();
    await built.close();
    assert.equal(built.readiness(NOON).source, 'build');
    assert.equal(readdirSync(worker).filter((name) => name.endsWith('.simwin.zst')).length, 1);
    const restarted = new SharedScooterSimulation({ fleets: FLEETS, windowDirectory: worker });
    const started = performance.now();
    await restarted.ensure(NOON);
    const elapsed = performance.now() - started;
    await restarted.close();
    assert.equal(restarted.readiness(NOON).source, 'store');
    assert.ok(elapsed < 1000, `${Math.round(elapsed)} ms`);
    assert.equal(answers(restarted), answers(built));
  } finally {
    rmSync(worker, { recursive: true, force: true });
  }
});

test('the window counts each type in reach before the per-type cut, as a full scan does', () => {
  const window = first.window(NOON)!;
  const totals: number[] = [];
  const cut = window.nearby(GANGNAM, 1500, NOON, 'rentable', { perType: 5, totals });
  const all = window.nearby(GANGNAM, 1500, NOON, 'rentable', { scan: true });
  assert.ok(cut.length <= 10);
  assert.deepEqual(totals, [
    all.filter((vehicle) => vehicle.type === 'kick-scooter').length,
    all.filter((vehicle) => vehicle.type === 'e-bike').length,
  ]);
  assert.ok(totals[VTYPE.SCOOTER] + totals[VTYPE.EBIKE] > 10);
});
