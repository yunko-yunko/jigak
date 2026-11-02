import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { monorepoRoot, repositorySources } from '../scripts/model-refresh/init';
import { STATIC_CONTEXT, STATIC_SHA256, stageStaticInputs, type RunContext } from '../scripts/model-refresh/pipelines';
import { Store } from '../scripts/model-refresh/store';
import { createLogger } from '../scripts/model-refresh/util';

// Tests run with model-refresh/ as the working directory (npm --prefix model-refresh test).
const calendars = resolve('..', 'src', 'common', 'engine', 'realtime', 'data');
const temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'model-refresh-layout-')));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** What a child step sees: the API's korean-holidays.ts after holiday-env.ts ran with this JIGAK_HOLIDAY_DIR. */
function childCalendar(directory: string | undefined) {
  const code = "import('./scripts/holiday-env.ts').then(() => import('../src/common/engine/intelligence/korean-holidays.ts')).then(m => { const c = m.reviewedKoreanHolidays(); console.log(JSON.stringify({ firstDate: c.firstDate, lastDate: c.lastDate, origin: m.koreanHolidayOrigin().origin })); })";
  const env = { ...process.env }; delete env.JIGAK_HOLIDAY_DIR; if (directory !== undefined) env.JIGAK_HOLIDAY_DIR = directory;
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', code], { encoding: 'utf8', env, timeout: 30_000 });
}

test('a child step reads the calendars of JIGAK_HOLIDAY_DIR, not the files shipped with the API', () => {
  const root = temporary();
  try {
    const only2026 = join(root, 'only-2026'), empty = join(root, 'empty');
    mkdirSync(only2026); mkdirSync(empty);
    copyFileSync(join(calendars, 'korea-holidays-2026.json'), join(only2026, 'korea-holidays-2026.json'));
    const fromFolder = childCalendar(only2026);
    assert.equal(fromFolder.status, 0, fromFolder.stderr);
    assert.deepEqual(JSON.parse(fromFolder.stdout), { firstDate: '2026-01-01', lastDate: '2026-12-31', origin: 'manifest' });
    const shipped = childCalendar(undefined);
    assert.equal(shipped.status, 0, shipped.stderr);
    assert.deepEqual(JSON.parse(shipped.stdout), { firstDate: '2026-01-01', lastDate: '2027-12-31', origin: 'bundled' });
    const missing = childCalendar(empty);
    assert.notEqual(missing.status, 0, 'a set but empty folder must not fall back to the shipped files');
    assert.match(missing.stderr, /holiday-calendar-missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every TypeScript step the runner starts registers JIGAK_HOLIDAY_DIR before anything else', () => {
  for (const script of ['join-public-bus-context', 'train-public-bus-model', 'refresh-public-bus-model', 'verify-public-bus-reproduction', 'promote-spatial-bus', 'promote-rail-gate', 'promote-spatial-bicycle'])
    assert.equal(readFileSync(resolve('scripts', `${script}.ts`), 'utf8').split('\n')[0], "import './holiday-env';", script);
  // Every TS step pipelines.ts names is in that list (a new step must import holiday-env.ts too).
  const pipelines = readFileSync(resolve('scripts', 'model-refresh', 'pipelines.ts'), 'utf8');
  const named = [...pipelines.matchAll(/node\(ctx, '[^']+', '([^']+)\.ts'/g)].map(match => match[1]);
  assert.ok(named.length >= 6);
  for (const script of named) assert.equal(readFileSync(resolve('scripts', `${script}.ts`), 'utf8').split('\n')[0], "import './holiday-env';", script);
});

test('the committed fixed inputs have the bytes the runner accepts', () => {
  for (const name of [STATIC_CONTEXT.roadPriors, STATIC_CONTEXT.stations]) assert.equal(sha256(resolve('data-static', name)), STATIC_SHA256[name], name);
});

test('fixed inputs come from store static/, then raw/context/, then the committed copy, and only with the expected bytes', async () => {
  const root = temporary(), lines: string[] = [];
  try {
    const store = new Store(join(root, 'store')), work = join(root, 'work'); mkdirSync(work);
    const ctx = { store, workDir: work, projectDir: resolve('.'), log: createLogger('layout', line => lines.push(line)) } as unknown as RunContext;
    const staged = (name: string) => join(work, 'data', 'context', name);
    // Empty store: the committed copies (the job image carries them too).
    await stageStaticInputs(ctx);
    for (const name of [STATIC_CONTEXT.roadPriors, STATIC_CONTEXT.stations]) assert.equal(sha256(staged(name)), STATIC_SHA256[name]);
    // Wrong bytes in static/ are skipped with a warning; the right bytes in raw/context are used.
    mkdirSync(store.static, { recursive: true }); mkdirSync(store.context, { recursive: true });
    writeFileSync(join(store.static, STATIC_CONTEXT.stations), 'not the stations');
    copyFileSync(resolve('data-static', STATIC_CONTEXT.stations), join(store.context, STATIC_CONTEXT.stations));
    rmSync(join(work, 'data'), { recursive: true, force: true });
    await stageStaticInputs(ctx);
    assert.equal(sha256(staged(STATIC_CONTEXT.stations)), STATIC_SHA256[STATIC_CONTEXT.stations]);
    assert.ok(lines.some(line => line.includes('static-input-mismatch') && line.includes(join(store.static, STATIC_CONTEXT.stations))), lines.join('\n'));
    // Without the committed copy and with only wrong bytes in the store, the run stops instead of training on them.
    const bare = { ...ctx, projectDir: join(root, 'no-copy') } as RunContext;
    rmSync(join(store.context, STATIC_CONTEXT.stations));
    copyFileSync(resolve('data-static', STATIC_CONTEXT.roadPriors), join(store.static, STATIC_CONTEXT.roadPriors));
    await assert.rejects(stageStaticInputs(bare), /static-input-missing:spatial-transit-stations\.csv/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundle sources need the monorepo; a backend-only clone gets a clear error', () => {
  const root = temporary();
  try {
    const project = join(root, 'jigak-backend', 'model-refresh'); mkdirSync(project, { recursive: true });
    const saved = process.env.JIGAK_MONOREPO_ROOT; delete process.env.JIGAK_MONOREPO_ROOT;
    try {
      assert.throws(() => monorepoRoot(project), /monorepo-missing/);
      mkdirSync(join(root, 'mvp'));
      const sources = repositorySources(project, monorepoRoot(project));
      assert.equal(sources.operational, join(root, 'cloud-models'));
      assert.equal(sources.references, join(root, 'mvp', 'data', 'model-references'));
      assert.equal(sources.calendars, join(root, 'jigak-backend', 'src', 'common', 'engine', 'realtime', 'data'));
      assert.equal(sources.stations, join(project, 'data-static', STATIC_CONTEXT.stations));
      assert.equal(monorepoRoot(project, join(root)), root, '--repo-root wins');
    } finally { if (saved !== undefined) process.env.JIGAK_MONOREPO_ROOT = saved; }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the job installs the same zod and tsx as the API lock, and the API image never gets the job', () => {
  const versions = (lock: string) => { const packages = JSON.parse(readFileSync(lock, 'utf8')).packages; return { zod: packages['node_modules/zod']?.version, tsx: packages['node_modules/tsx']?.version }; };
  assert.deepEqual(versions(resolve('package-lock.json')), versions(resolve('..', 'package-lock.json')));
  const job = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.deepEqual(Object.keys(job.dependencies).sort(), ['tsx', 'zod']);
  // The API image copies a fixed list (no model-refresh/, no Python); tsx stays a dev dependency of the API.
  const apiDockerfile = readFileSync(resolve('..', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(apiDockerfile, /model-refresh|python/i);
  assert.equal(JSON.parse(readFileSync(resolve('..', 'package.json'), 'utf8')).dependencies.tsx, undefined);
  // The job image copies the committed fixed inputs and no mvp/ path.
  const jobDockerfile = readFileSync(resolve('Dockerfile'), 'utf8');
  assert.match(jobDockerfile, /COPY model-refresh\/data-static /);
  assert.doesNotMatch(jobDockerfile, /\bmvp\//);
  assert.ok(existsSync(resolve('scripts', 'requirements-spatial-eta.txt')));
});
