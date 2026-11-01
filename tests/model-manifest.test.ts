import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  calendarEndOf,
  DEFAULT_REFRESH_SCHEDULE_KST,
  LATE_SERVICE_MS,
  ManifestError,
  ManifestWatcher,
  ModelRefreshMonitor,
  nextScheduledSlot,
  parseManifest,
  sha256Hex,
  type CalendarFile,
} from '../src/common/engine/intelligence/model-manifest.js';
import {
  BusEnvelopeRuntime,
  SpatialBusModelService,
} from '../src/common/engine/intelligence/spatial-bus-service.js';
import {
  SPATIAL_BUS_FEATURE_NAMES,
  SPATIAL_BUS_GROUPS,
} from '../src/common/engine/intelligence/spatial-bus-model.js';
import {
  koreanHolidayOrigin,
  reviewedKoreanHolidays,
  usePublishedKoreanHolidays,
} from '../src/common/engine/intelligence/korean-holidays.js';
import {
  koreanServiceDay,
  serviceCalendarStatus,
  usePublishedServiceCalendars,
} from '../src/common/engine/realtime/service-calendar.js';
import { modelRefreshSummary } from '../src/modules/health/domain/model-refresh.js';
import { validateEnvironment } from '../src/common/config/environment.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';

const HOUR = 3_600_000;
const kst = (day: string, hour = 12) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00+09:00`);

// ---- fixtures: tiny but valid spatial bus checkpoints, one per "training run" -------------------
const leaf = (value: number) => ({
  initial: value,
  trees: [[{ value: 0, feature: 0, threshold: 0, left: 0, right: 0, leaf: true }]],
});
const N = SPATIAL_BUS_FEATURE_NAMES.length;
function checkpoint(trainedAt: number, upper = 500) {
  return {
    version: 'seoul-bus-spatial-v3',
    deployment: 'production',
    target: 'bus-tag-elapsed',
    trainedAt,
    expiresAt: trainedAt + 7 * 24 * HOUR,
    trainingThrough: '2026-10-10',
    lastEvaluatedServiceDate: '2026-10-16',
    featureNames: [...SPATIAL_BUS_FEATURE_NAMES],
    models: { mean: leaf(400), lower: leaf(300), median: leaf(380), upper: leaf(upper) },
    featureQuantization: 'nearest-1e-10-ties-to-positive',
    calendar: {
      rule: 'korean-public-holiday-as-sunday',
      firstDate: '2026-09-28',
      lastDate: '2026-11-30',
      holidays: ['2026-10-03', '2026-10-05', '2026-10-09'],
    },
    conformal: SPATIAL_BUS_GROUPS.map((group) => ({ group, logLower: 0, logUpper: 0 })),
    labelUncertaintySeconds: 60,
    domain: { minimum: Array(N).fill(-1000), maximum: Array(N).fill(1000) },
    evaluation: {},
    source: { experiment: 'unit', protocolSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64) },
    meanInterpretation: 'conditional tag-elapsed mean, not validated route ETA',
    limitations: ['unit'],
  };
}

function holidayFile(year: number, reviewAfter: string, holidays: string[]) {
  return JSON.stringify({
    year,
    verifiedAt: `${year - 1}-12-01T00:00:00+09:00`,
    reviewAfter,
    source: 'https://example.test/holidays',
    holidays,
  });
}

class Store {
  readonly dir = mkdtempSync(join(tmpdir(), 'model-manifest-'));
  private tick = 0;
  put(relative: string, text: string) {
    const path = join(this.dir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return { path: relative, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
  }
  manifest(generation: number, models: Record<string, unknown>, calendars: unknown = {}) {
    const path = join(this.dir, 'manifest.json');
    writeFileSync(
      path,
      JSON.stringify({
        schema: 'jigak-model-manifest-v1',
        generation,
        updatedAt: '2026-11-02T05:40:00+09:00',
        runId: `run-${generation}`,
        models,
        calendars,
      }),
    );
    // Same-size rewrites must still look changed to the watcher, as a bucket object update does.
    const at = new Date(Date.now() + ++this.tick * 2000);
    utimesSync(path, at, at);
  }
  entry(file: ReturnType<Store['put']>, trainedAt: number, extra: Record<string, unknown> = {}) {
    return {
      version: 'seoul-bus-spatial-v3',
      ...file,
      trainedAt,
      expiresAt: trainedAt + 7 * 24 * HOUR,
      promotedAt: trainedAt + HOUR,
      ...extra,
    };
  }
  writeText(relative: string, text: string) {
    writeFileSync(join(this.dir, relative), text);
  }
  get manifestPath() {
    return join(this.dir, 'manifest.json');
  }
  clean() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const trained1 = kst('2026-10-31', 1);
const trained2 = kst('2026-11-02', 5);

test('parseManifest resolves paths under the manifest folder and refuses anything else', () => {
  const base = '/srv/bucket';
  const sha = 'c'.repeat(64);
  const text = (path: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      schema: 'jigak-model-manifest-v1',
      generation: 4,
      models: { spatialBus: { version: 'v', path, sha256: sha, ...extra } },
      calendars: { '2026': { path: 'calendars/a.json', sha256: sha, source: 'kasi-spcde-api' } },
    });
  const parsed = parseManifest(
    text('models/spatialBus/v3/x.json', {
      trainedAt: '2026-10-31T00:40:00+09:00',
      evaluationDate: null,
      bytes: null,
      gates: { passed: true },
      history: [{ version: 'old', evaluationDate: null, trainedAt: null }],
    }),
    base,
  );
  assert.equal(parsed.generation, 4);
  assert.equal(parsed.models.get('spatialBus')!.path, resolve(base, 'models/spatialBus/v3/x.json'));
  assert.equal(parsed.models.get('spatialBus')!.trainedAt, kst('2026-10-31', 0) + 40 * 60_000);
  assert.equal(parsed.models.get('spatialBus')!.previousVersion, 'old');
  assert.equal(parsed.calendars.get(2026)!.source, 'kasi-spcde-api');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'models/../../x.json', '.'])
    assert.throws(
      () => parseManifest(text(bad), base),
      (error) => {
        assert.ok(error instanceof ManifestError);
        assert.equal(error.code, 'manifest-path-invalid');
        return true;
      },
    );
  assert.throws(() => parseManifest('{not json', base), /manifest-not-json/);
  assert.throws(
    () => parseManifest(JSON.stringify({ schema: 'other', generation: 1, models: {} }), base),
    /manifest-schema-invalid/,
  );
  assert.throws(
    () =>
      parseManifest(
        JSON.stringify({
          schema: 'jigak-model-manifest-v1',
          generation: 1,
          models: { a: { version: 'v', path: 'a', sha256: 'short' } },
        }),
        base,
      ),
    /manifest-schema-invalid/,
  );
});

test('generation 1 loads, a wrong-hash generation 2 keeps it, a good generation 3 replaces it within one poll', () => {
  const store = new Store();
  try {
    let now = kst('2026-11-02', 8);
    const first = store.put(
      'models/spatialBus/v3/20261031T0040-aaaaaaaaaaaa.json',
      JSON.stringify(checkpoint(trained1, 500)),
    );
    store.manifest(1, { spatialBus: store.entry(first, trained1) });
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
    });
    const service = new SpatialBusModelService({
      modelPath: watcher.source('spatialBus'),
      now: () => now,
    });
    let status = service.status();
    assert.equal(status.active, true);
    assert.equal(status.origin, 'manifest');
    assert.equal(status.manifestGeneration, 1);
    assert.equal(status.sha256, first.sha256);
    assert.equal(status.trainedAt, trained1);
    assert.equal(status.expiresAt, trained1 + 7 * 24 * HOUR);
    assert.equal(status.previousVersion, null);
    assert.deepEqual(status.reasons, []);

    // Generation 2 points at a file whose bytes are not the promoted ones.
    const second = store.put(
      'models/spatialBus/v3/20261103T0540-bbbbbbbbbbbb.json',
      JSON.stringify(checkpoint(trained2, 777)),
    );
    store.manifest(2, {
      spatialBus: store.entry({ ...second, sha256: '0'.repeat(64) }, trained2, {
        history: [{ version: 'seoul-bus-spatial-v3' }],
      }),
    });
    now += 61_000;
    status = service.status();
    assert.equal(status.active, true, 'the old model keeps serving');
    assert.equal(status.manifestGeneration, 1);
    assert.equal(status.sha256, first.sha256);
    assert.deepEqual(status.reasons, ['manifest-sha-mismatch']);
    now += 61_000;
    assert.deepEqual(
      service.status().reasons,
      ['manifest-sha-mismatch'],
      'asked again, still refused',
    );

    // Generation 3 is the right file: it must serve within one poll, not after the 30 s throttle.
    store.manifest(3, {
      spatialBus: store.entry(second, trained2, { history: [{ version: 'seoul-bus-spatial-v3' }] }),
    });
    now += 6_000; // inside the services' 30 s throttle: a changed hash must not wait for it
    status = service.status();
    assert.equal(status.manifestGeneration, 3);
    assert.equal(status.sha256, second.sha256);
    assert.equal(status.previousVersion, 'seoul-bus-spatial-v3');
    assert.equal(status.promotedAt, trained2 + HOUR);
    assert.equal(status.trainedAt, trained2);
    assert.deepEqual(status.reasons, []);
  } finally {
    store.clean();
  }
});

test('a promoted file that does not parse, is missing or is oversize never replaces the model in use', () => {
  const store = new Store();
  try {
    let now = kst('2026-11-02', 8);
    const first = store.put('models/a.json', JSON.stringify(checkpoint(trained1)));
    store.manifest(1, { spatialBus: store.entry(first, trained1) });
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
    });
    const service = new SpatialBusModelService({
      modelPath: watcher.source('spatialBus'),
      now: () => now,
    });
    assert.equal(service.status().active, true);

    const garbage = store.put('models/b.json', '{"version":"seoul-bus-spatial-v3"}');
    store.manifest(2, { spatialBus: store.entry(garbage, trained2) });
    now += 6000;
    let status = service.status();
    assert.equal(status.active, true);
    assert.equal(status.manifestGeneration, 1);
    assert.deepEqual(status.reasons, ['manifest-candidate-invalid']);

    store.manifest(3, {
      spatialBus: store.entry(
        { path: 'models/not-there-yet.json', sha256: 'd'.repeat(64), bytes: 1 },
        trained2,
      ),
    });
    now += 6000;
    status = service.status();
    assert.equal(status.manifestGeneration, 1);
    assert.deepEqual(status.reasons, ['manifest-candidate-missing']);

    // Rolling back to the loaded file clears the refusal.
    store.manifest(4, { spatialBus: store.entry(first, trained1) });
    now += 6000;
    status = service.status();
    assert.deepEqual(status.reasons, []);
    assert.equal(status.manifestGeneration, 1, 'same file, so the loaded one stays');
  } finally {
    store.clean();
  }
});

test('with no model yet, a bad manifest file leaves the service inactive with the reason', () => {
  const store = new Store();
  try {
    const now = kst('2026-11-02', 8);
    const bad = store.put('models/x.json', JSON.stringify(checkpoint(trained1)));
    store.manifest(1, {
      spatialBus: store.entry({ ...bad, sha256: 'e'.repeat(64) }, trained1),
    });
    const watcher = new ManifestWatcher({ manifestPath: store.manifestPath, now: () => now });
    const service = new SpatialBusModelService({
      modelPath: watcher.source('spatialBus'),
      now: () => now,
    });
    const status = service.status();
    assert.equal(status.active, false);
    assert.deepEqual(status.reasons, ['inactive-checkpoint', 'manifest-sha-mismatch'].slice(1));
    assert.equal(status.origin, null);
  } finally {
    store.clean();
  }
});

test('an unreadable or older manifest never replaces the good one', () => {
  const store = new Store();
  try {
    let now = kst('2026-11-02', 8);
    const first = store.put('models/a.json', JSON.stringify(checkpoint(trained1)));
    store.manifest(5, { spatialBus: store.entry(first, trained1) });
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
    });
    assert.equal(watcher.generation, 5);
    store.writeText('manifest.json', '{"half written');
    now += 6000;
    watcher.poll();
    assert.equal(watcher.generation, 5);
    assert.equal(watcher.lastError, 'manifest-not-json');
    store.manifest(4, { spatialBus: store.entry(first, trained1) });
    now += 6000;
    watcher.poll();
    assert.equal(watcher.generation, 5, 'a stale object read must not move the pointer back');
    assert.equal(watcher.lastError, 'manifest-generation-regressed');
    store.manifest(6, { spatialBus: store.entry(first, trained1) });
    now += 6000;
    watcher.poll();
    assert.equal(watcher.generation, 6);
    assert.equal(watcher.lastError, null);
  } finally {
    store.clean();
  }
});

test('an env path keeps the old behaviour and reports its provenance as env', () => {
  const store = new Store();
  try {
    const now = kst('2026-11-02', 8);
    const first = store.put('model.json', JSON.stringify(checkpoint(trained1)));
    const service = new SpatialBusModelService({
      modelPath: join(store.dir, first.path),
      now: () => now,
    });
    const status = service.status();
    assert.equal(status.active, true);
    assert.equal(status.origin, 'env');
    assert.equal(status.manifestGeneration, null);
    assert.equal(status.sha256, first.sha256);
    const missing = new SpatialBusModelService({ modelPath: join(store.dir, 'nope.json') });
    assert.deepEqual(missing.status().reasons, ['missing-checkpoint']);
    const broken = store.put('broken.json', '[]');
    const invalid = new SpatialBusModelService({ modelPath: join(store.dir, broken.path) });
    assert.deepEqual(invalid.status().reasons, ['invalid-checkpoint']);
  } finally {
    store.clean();
  }
});

test('the schedule helper finds the next Cloud Scheduler slot in KST', () => {
  assert.equal(DEFAULT_REFRESH_SCHEDULE_KST, '05:30,09:30,13:30');
  const at = (day: string, time: string) => Date.parse(`${day}T${time}:00+09:00`);
  assert.equal(nextScheduledSlot(at('2026-11-02', '00:20')), at('2026-11-02', '05:30'));
  assert.equal(nextScheduledSlot(at('2026-11-02', '05:30')), at('2026-11-02', '09:30'));
  assert.equal(nextScheduledSlot(at('2026-11-02', '13:31')), at('2026-11-03', '05:30'));
  assert.equal(nextScheduledSlot(at('2026-11-02', '08:00'), '06:00'), at('2026-11-03', '06:00'));
  assert.equal(
    nextScheduledSlot(at('2026-11-02', '08:00'), 'garbage'),
    at('2026-11-02', '09:30'),
    'a bad schedule falls back to the default',
  );
});

function monitorFixture(options: {
  now: () => number;
  generation?: number;
  trainedAt: number;
  status?: unknown;
  expiresAt?: number;
}) {
  const store = new Store();
  const file = store.put('models/a.json', JSON.stringify(checkpoint(options.trainedAt)));
  store.manifest(options.generation ?? 7, {
    spatialBus: store.entry(file, options.trainedAt, {
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    }),
  });
  if (options.status) store.writeText('refresh-status.json', JSON.stringify(options.status));
  const watcher = new ManifestWatcher({ manifestPath: store.manifestPath, now: options.now });
  const service = new SpatialBusModelService({
    modelPath: watcher.source('spatialBus'),
    now: options.now,
  });
  const monitor = new ModelRefreshMonitor({
    watcher,
    statusPath: join(store.dir, 'refresh-status.json'),
    now: options.now,
  });
  const routing = {
    publicBus: new BusEnvelopeRuntime(service, undefined),
    modelRefresh: monitor,
  } as unknown as RoutingOptions;
  return { store, watcher, routing };
}

test('health: ok after a fresh run, stale when the last run is over 26 hours old, per-model schedule fields', () => {
  const now = kst('2026-11-02', 10);
  const fixture = monitorFixture({
    now: () => now,
    trainedAt: trained1,
    status: {
      runId: 'r1',
      finishedAt: now - 3 * HOUR,
      outcome: 'noop',
      models: {
        spatialBus: {
          refreshOpensAt: kst('2026-11-02', 1),
          nextAttemptAt: kst('2026-11-03', 5) + 30 * 60_000,
          consecutiveFailures: 2,
          lastFailureReason: 'blocked:route_table_neighbors_unavailable',
          lastAttempt: {
            evaluationDate: '2026-10-28',
            outcome: 'revalidated',
            reason: 'gate:worse-than-incumbent',
            at: now - 3 * HOUR,
            details: { expiresAt: now + 7 * 24 * HOUR },
          },
        },
      },
    },
  });
  try {
    let summary = modelRefreshSummary(fixture.routing);
    assert.equal(summary.status, 'ok');
    assert.equal(summary.manifest.generation, 7);
    assert.equal(summary.lastRun!.runId, 'r1');
    assert.equal(summary.lastRun!.outcome, 'noop');
    assert.equal(summary.nextScheduledAt, kst('2026-11-02', 13) + 30 * 60_000);
    const model = summary.models.spatialBus;
    assert.equal(model.consecutiveFailures, 2);
    assert.equal(model.lastFailureReason, 'blocked:route_table_neighbors_unavailable');
    assert.equal(model.refreshOpensAt, kst('2026-11-02', 1));
    assert.equal(model.nextAttemptAt, kst('2026-11-03', 5) + 30 * 60_000);
    assert.equal(model.expiresAt, trained1 + 7 * 24 * HOUR);
    assert.equal(model.active, true);
    assert.deepEqual(model.lastAttempt, {
      outcome: 'revalidated',
      reason: 'gate:worse-than-incumbent',
      evaluationDate: '2026-10-28',
      at: now - 3 * HOUR,
    });

    // 27 hours later with no new report: stale, not degraded (still > 48 h of model life).
    fixture.store.writeText(
      'refresh-status.json',
      JSON.stringify({ runId: 'r1', finishedAt: now - 27 * HOUR, outcome: 'noop', models: {} }),
    );
    const later = monitorFixture({
      now: () => now,
      trainedAt: trained1,
      status: { runId: 'r1', finishedAt: now - 27 * HOUR, outcome: 'noop' },
    });
    try {
      summary = modelRefreshSummary(later.routing);
      assert.equal(summary.status, 'stale');
      assert.ok(summary.reasons.includes('last-run-older-than-26h'));
      assert.equal(
        summary.models.spatialBus.refreshOpensAt,
        trained1 + 7 * 24 * HOUR - 120 * HOUR,
        'without a report the window opens 120 h before expiry',
      );
    } finally {
      later.store.clean();
    }
  } finally {
    fixture.store.clean();
  }
});

test('health: degraded when a model expired, or expires within 48 hours while its refresh keeps failing', () => {
  const expiresAt = kst('2026-11-07', 0) + 40 * 60_000;
  // 40 hours left and two failed attempts: degraded.
  let now = expiresAt - 40 * HOUR;
  let fixture = monitorFixture({
    now: () => now,
    trainedAt: expiresAt - 7 * 24 * HOUR,
    status: {
      runId: 'r',
      finishedAt: now - HOUR,
      outcome: 'partial',
      models: { spatialBus: { consecutiveFailures: 2, lastFailureReason: 'blocked:x' } },
    },
  });
  try {
    const summary = modelRefreshSummary(fixture.routing);
    assert.equal(summary.status, 'degraded');
    assert.deepEqual(summary.reasons, ['spatialBus-refresh-failing-near-expiry']);
  } finally {
    fixture.store.clean();
  }
  // 40 hours left but no failure recorded: still ok.
  fixture = monitorFixture({
    now: () => now,
    trainedAt: expiresAt - 7 * 24 * HOUR,
    status: { runId: 'r', finishedAt: now - HOUR, outcome: 'noop', models: {} },
  });
  try {
    assert.equal(modelRefreshSummary(fixture.routing).status, 'ok');
  } finally {
    fixture.store.clean();
  }
  // Past expiry: degraded, and the service answers inactive so routing uses the provider's time.
  now = expiresAt + HOUR;
  fixture = monitorFixture({
    now: () => now,
    trainedAt: expiresAt - 7 * 24 * HOUR,
    status: { runId: 'r', finishedAt: now - HOUR, outcome: 'alert', models: {} },
  });
  try {
    const summary = modelRefreshSummary(fixture.routing);
    assert.equal(summary.status, 'degraded');
    assert.ok(summary.reasons.includes('spatialBus-expired'));
    const bus = fixture.routing.publicBus!.status() as {
      spatial: { active: boolean; reasons: string[] };
    };
    assert.equal(bus.spatial.active, false);
    assert.deepEqual(bus.spatial.reasons, ['expired-checkpoint']);
  } finally {
    fixture.store.clean();
  }
});

test('health: unconfigured without a manifest, degraded when the manifest was never readable', () => {
  const monitor = new ModelRefreshMonitor({ watcher: null });
  assert.equal(monitor.summarize({}).status, 'unconfigured');
  assert.equal(
    modelRefreshSummary({} as unknown as RoutingOptions).status,
    'unconfigured',
    'no monitor at all reads as unconfigured',
  );
  const store = new Store();
  try {
    const watcher = new ManifestWatcher({ manifestPath: join(store.dir, 'manifest.json') });
    const summary = new ModelRefreshMonitor({ watcher }).summarize({});
    assert.equal(summary.status, 'degraded');
    assert.ok(summary.reasons.includes('manifest-missing'));
  } finally {
    store.clean();
  }
});

test('manifest holiday files are verified, applied together, and replaced when the manifest changes', () => {
  const store = new Store();
  const applied: CalendarFile[][] = [];
  try {
    let now = kst('2026-11-02', 8);
    const first = store.put('models/a.json', JSON.stringify(checkpoint(trained1)));
    const y2026 = store.put(
      'calendars/korea-holidays-2026-aaaa.json',
      holidayFile(2026, '2026-12-17T00:00:00+09:00', ['2026-12-25']),
    );
    const y2027 = store.put(
      'calendars/korea-holidays-2027-bbbb.json',
      holidayFile(2027, '2027-12-17T00:00:00+09:00', ['2027-01-01']),
    );
    store.manifest(
      1,
      { spatialBus: store.entry(first, trained1) },
      {
        '2026': { ...y2026, reviewAfter: '2026-12-17', source: 'kasi-spcde-api' },
        '2027': { ...y2027, reviewAfter: '2027-12-17', source: 'carried' },
      },
    );
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
      onCalendars: (files, previous) => {
        usePublishedKoreanHolidays(files);
        try {
          usePublishedServiceCalendars(files);
        } catch (error) {
          usePublishedKoreanHolidays(previous);
          throw error;
        }
        applied.push(files);
      },
    });
    assert.equal(applied.length, 1);
    assert.equal(koreanHolidayOrigin().origin, 'manifest');
    assert.deepEqual(
      reviewedKoreanHolidays().reviews.map((review) => review.reviewAfter),
      [Date.parse('2026-12-17T00:00:00+09:00'), Date.parse('2027-12-17T00:00:00+09:00')],
    );
    const status = serviceCalendarStatus(now);
    assert.equal(status.origin, 'manifest');
    assert.equal(status.provenance, 'kasi-spcde-api');
    assert.equal(status.reviewAfter, Date.parse('2026-12-17T00:00:00+09:00'));
    assert.equal(status.usable, true);
    assert.equal(koreanServiceDay('2027-01-01', kst('2026-12-30'))?.dayType, 'holiday');
    assert.equal(koreanServiceDay('2026-12-25', now)?.dayType, 'holiday');
    assert.equal(koreanServiceDay('2028-01-03', now), null, 'no file for that year');

    // A calendar whose bytes differ from the manifest's hash is refused and the set in use stays.
    const bad2026 = store.put(
      'calendars/korea-holidays-2026-cccc.json',
      holidayFile(2026, '2027-01-17T00:00:00+09:00', []),
    );
    store.manifest(
      2,
      { spatialBus: store.entry(first, trained1) },
      {
        '2026': { ...bad2026, sha256: '1'.repeat(64) },
        '2027': { ...y2027 },
      },
    );
    now += 6000;
    watcher.poll();
    assert.equal(applied.length, 1);
    assert.equal(watcher.lastError, 'manifest-calendar-invalid');
    assert.equal(serviceCalendarStatus(now).reviewAfter, Date.parse('2026-12-17T00:00:00+09:00'));

    // The corrected set is applied on the next poll.
    store.manifest(
      3,
      { spatialBus: store.entry(first, trained1) },
      { '2026': { ...bad2026, source: 'unofficial-cross-check' }, '2027': { ...y2027 } },
    );
    now += 6000;
    watcher.poll();
    assert.equal(applied.length, 2);
    assert.equal(watcher.lastError, null);
    assert.equal(serviceCalendarStatus(now).reviewAfter, Date.parse('2027-01-17T00:00:00+09:00'));
    assert.equal(serviceCalendarStatus(now).provenance, 'unofficial-cross-check');

    const summary = new ModelRefreshMonitor({ watcher, now: () => now }).summarize({});
    assert.deepEqual(summary.calendars['2026'], {
      source: 'unofficial-cross-check',
      reviewAfter: null,
    });
  } finally {
    usePublishedKoreanHolidays([]);
    usePublishedServiceCalendars([]);
    store.clean();
  }
  assert.equal(koreanHolidayOrigin().origin, 'bundled');
  assert.equal(serviceCalendarStatus(kst('2026-11-02')).origin, 'bundled');
});

test('MODEL_MANIFEST_* settings are optional and validated', () => {
  const base = { DB_PASSWORD: 'x' } as NodeJS.ProcessEnv;
  const empty = validateEnvironment(base);
  assert.equal(empty.MODEL_MANIFEST_PATH, undefined);
  assert.equal(empty.MODEL_MANIFEST_POLL_SECONDS, 60);
  assert.equal(empty.MODEL_REFRESH_SCHEDULE_KST, DEFAULT_REFRESH_SCHEDULE_KST);
  const blank = validateEnvironment({
    ...base,
    MODEL_MANIFEST_PATH: '',
    MODEL_MANIFEST_POLL_SECONDS: '',
    MODEL_REFRESH_SCHEDULE_KST: '',
  });
  assert.equal(blank.MODEL_MANIFEST_PATH, undefined);
  assert.equal(blank.MODEL_MANIFEST_POLL_SECONDS, 60);
  const set = validateEnvironment({
    ...base,
    MODEL_MANIFEST_PATH: '/models/manifest.json',
    MODEL_MANIFEST_POLL_SECONDS: '30',
    MODEL_REFRESH_STATUS_PATH: '/models/refresh-status.json',
    MODEL_REFRESH_SCHEDULE_KST: '06:00,18:30',
  });
  assert.equal(set.MODEL_MANIFEST_PATH, '/models/manifest.json');
  assert.equal(set.MODEL_MANIFEST_POLL_SECONDS, 30);
  assert.equal(set.MODEL_REFRESH_SCHEDULE_KST, '06:00,18:30');
  assert.throws(() => validateEnvironment({ ...base, MODEL_MANIFEST_POLL_SECONDS: '0' }));
  assert.throws(() => validateEnvironment({ ...base, MODEL_REFRESH_SCHEDULE_KST: '25:99' }));
});

test('a re-validated manifest entry extends the expiry of the loaded file without a new file, within one poll and never past 28 days of age', () => {
  const store = new Store();
  try {
    // 11/07 00:40 is the file's own end of life; the refresh job re-validates the same bytes on 11/05 and says 11/12.
    let now = kst('2026-11-06', 12);
    const file = store.put(
      'models/spatialBus/v3/20261031T0040-aaaaaaaaaaaa.json',
      JSON.stringify(checkpoint(trained1, 500)),
    );
    store.manifest(1, { spatialBus: store.entry(file, trained1) });
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
    });
    const service = new SpatialBusModelService({
      modelPath: watcher.source('spatialBus'),
      now: () => now,
    });
    const ownEnd = trained1 + 7 * 24 * HOUR;
    let status = service.status();
    assert.equal(status.active, true);
    assert.equal(status.expiresAt, ownEnd);
    assert.equal(status.expirySource, 'file');
    assert.equal(status.revalidatedAt, null);

    // Same model after its own expiry and no re-validation: inactive, as before.
    now = ownEnd + HOUR;
    assert.equal(service.status().active, false);
    assert.deepEqual(service.status().reasons, ['expired-checkpoint']);

    // The job writes generation 2: same path and sha256, later expiresAt.
    now = ownEnd - 20 * HOUR;
    const extended = ownEnd + 5 * 24 * HOUR;
    store.manifest(2, {
      spatialBus: store.entry(file, trained1, { expiresAt: extended, revalidatedAt: now }),
    });
    now += 6000;
    status = service.status();
    assert.equal(status.manifestGeneration, 2, 'the generation that extended it is shown');
    assert.equal(status.sha256, file.sha256, 'the file is the same');
    assert.equal(status.expiresAt, extended);
    assert.equal(status.expirySource, 'manifest');
    assert.equal(status.revalidatedAt, now - 6000);
    assert.deepEqual(status.reasons, []);

    // Past the file's own end the model keeps serving, and a request at that time is answered.
    now = ownEnd + 2 * HOUR;
    status = service.status();
    assert.equal(status.active, true);
    assert.equal((status.operations as { remainingSeconds: number }).remainingSeconds, Math.floor((extended - now) / 1000));
    assert.equal((status.operations as { refreshDue: boolean }).refreshDue, false);
    // The extended life ends where the manifest says.
    now = extended + HOUR;
    assert.equal(service.status().active, false);

    // A manifest that asks for more than 28 days after training is cut to 28 days.
    now = ownEnd + 3 * HOUR;
    store.manifest(3, {
      spatialBus: store.entry(file, trained1, { expiresAt: trained1 + 60 * 24 * HOUR, revalidatedAt: now }),
    });
    now += 6000;
    assert.equal(service.status().expiresAt, trained1 + 28 * 24 * HOUR);

    // Rolling the entry back to the plain one returns to the file's own expiry.
    store.manifest(4, { spatialBus: store.entry(file, trained1) });
    now += 6000;
    status = service.status();
    assert.equal(status.expiresAt, ownEnd);
    assert.equal(status.expirySource, 'file');
    assert.equal(status.active, false);
    assert.equal(status.revalidatedAt, null);
  } finally {
    store.clean();
  }
});

test('the expiry in force is the earliest of the manifest, 28 days of age and the end of the holiday calendar inside the file', () => {
  const store = new Store();
  try {
    // The 10-31 file: own life to 11/07 01:00, calendar through 11/07, so nothing is predicted from 11/08 00:00 KST. A request
    // may board up to 4 h after it is made, so the last request the calendar covers is 11/07 20:00.
    const withCalendar = (lastDate: string) => {
      const value = checkpoint(trained1, 500);
      return { ...value, calendar: { ...value.calendar, lastDate } };
    };
    const calendarEnd = kst('2026-11-07', 20);
    const file = store.put(
      'models/spatialBus/v3/a.json',
      JSON.stringify(withCalendar('2026-11-07')),
    );
    // What the Windows store wrote: a re-validation to 11/09 03:22, past the calendar.
    store.manifest(1, {
      spatialBus: store.entry(file, trained1, {
        expiresAt: kst('2026-11-09', 3) + 22 * 60_000,
        revalidatedAt: kst('2026-11-02', 3),
      }),
    });
    let now = kst('2026-11-06', 12);
    const watcher = new ManifestWatcher({
      manifestPath: store.manifestPath,
      pollSeconds: 5,
      now: () => now,
    });
    const service = new SpatialBusModelService({
      modelPath: watcher.source('spatialBus'),
      now: () => now,
    });
    let status = service.status();
    assert.equal(status.expiresAt, calendarEnd, 'cut to the calendar end, not 11/09');
    assert.equal(status.expirySource, 'calendar');
    assert.equal(status.active, true);
    now = calendarEnd - 30 * 60_000;
    assert.equal(service.status().active, true);
    // From the calendar end the model predicts nothing, and health says so instead of "serving".
    now = calendarEnd + 30 * 60_000;
    status = service.status();
    assert.equal(status.active, false);
    assert.deepEqual(status.reasons, ['expired-checkpoint']);
    const summary = new ModelRefreshMonitor({ watcher, now: () => now }).summarize({
      spatialBus: { expiresAt: status.expiresAt, active: status.active },
    });
    assert.equal(summary.status, 'degraded');
    assert.ok(summary.reasons.includes('spatialBus-expired'));

    // A manifest that ends earlier than the calendar wins.
    now = kst('2026-11-06', 12);
    store.manifest(2, {
      spatialBus: store.entry(file, trained1, {
        expiresAt: kst('2026-11-07', 12),
        revalidatedAt: now,
      }),
    });
    now += 6000;
    status = service.status();
    assert.deepEqual([status.expiresAt, status.expirySource], [kst('2026-11-07', 12), 'manifest']);

    // With a calendar past 28 days of age, the age cap wins.
    const long = store.put(
      'models/spatialBus/v3/b.json',
      JSON.stringify(withCalendar('2026-12-31')),
    );
    store.manifest(3, {
      spatialBus: store.entry(long, trained1, {
        expiresAt: trained1 + 60 * 24 * HOUR,
        revalidatedAt: now,
      }),
    });
    now += 6000;
    status = service.status();
    assert.deepEqual(
      [status.expiresAt, status.expirySource],
      [trained1 + 28 * 24 * HOUR, 'manifest'],
    );

    // An env file whose own expiry outlives its calendar is cut the same way.
    const shortCalendar = store.put('env.json', JSON.stringify(withCalendar('2026-11-05')));
    const env = new SpatialBusModelService({
      modelPath: join(store.dir, shortCalendar.path),
      now: () => kst('2026-11-06', 1),
    });
    const envStatus = env.status();
    assert.deepEqual(
      [envStatus.expiresAt, envStatus.expirySource, envStatus.active],
      [kst('2026-11-06', 0), 'calendar', false],
    );
  } finally {
    store.clean();
  }
});

test("the calendar cap leaves the 4 h of late boardings the promoters keep, and never shortens a file's own life", () => {
  const at = (expiresAt: number, lastDate: string) =>
    calendarEndOf({ expiresAt, calendar: { lastDate } });
  // Spatial bus / rail gate: calendar through seoulDate(expiresAt + 4 h), so an extension stops at 20:00 and boards by 24:00.
  const busCap = at(kst('2026-11-07', 0) + 40 * 60_000, '2026-11-07')!;
  assert.equal(busCap, kst('2026-11-07', 20));
  assert.equal(busCap + LATE_SERVICE_MS, kst('2026-11-08', 0));
  // The bicycle file ends at the midnight after its calendar (no late margin): it keeps that life.
  assert.equal(at(kst('2026-11-15', 0), '2026-11-14'), kst('2026-11-15', 0));
  // A file that says more than its own calendar is cut at that midnight; no calendar, no cap.
  assert.equal(at(kst('2026-11-09', 0), '2026-11-07'), kst('2026-11-08', 0));
  assert.equal(calendarEndOf({ expiresAt: 1 }), null);
});
