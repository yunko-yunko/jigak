import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { createTestDatabase } from './helpers/auth-database.js';
import { LearningRepository } from '../src/modules/learning/repository/learning.repository.js';
import { LearningService } from '../src/modules/learning/service/learning.service.js';
import { LearningController } from '../src/modules/learning/controller/learning.controller.js';
import {
  EtaModelEntity,
  EtaObservationEntity,
} from '../src/modules/learning/repository/entities/index.js';
import { ApiExceptionFilter } from '../src/common/http/api-exception.filter.js';
import { trainContextualEta } from '../src/common/engine/intelligence/contextual-training.js';
import {
  ETA_LEARNING_CONSENT_VERSION,
  type EtaLearningFeatures,
  type EtaLearningObservation,
} from '../src/common/shared/intelligence/learning.js';
import {
  JOURNEY_MODES,
  type JourneyLearningFeatures,
} from '../src/common/shared/intelligence/journeyLearning.js';

const NOW = Date.UTC(2026, 9, 29, 3);
function feature(startedAt = NOW): EtaLearningFeatures {
  return {
    mode: 'walk',
    predictedSeconds: 300,
    distanceMeters: 500,
    startedAt,
    precipitationMm: null,
    temperatureC: null,
    windMetersPerSecond: null,
    congestionLevel: 'unknown',
    roadDelaySeconds: 0,
    precedingWaitSeconds: 0,
    transferIndex: 0,
    liveWait: false,
  };
}

function whole(startedAt = NOW): JourneyLearningFeatures {
  return {
    version: 1,
    startedAt,
    predictedSeconds: 300,
    distanceMeters: 1200,
    modeSeconds: Object.fromEntries(
      JOURNEY_MODES.map((mode) => [mode, mode === 'walk' ? 100 : mode === 'subway' ? 200 : 0]),
    ) as JourneyLearningFeatures['modeSeconds'],
    modeSequence: ['walk', 'subway'],
    transfers: 0,
    vehicleLegs: 1,
    precipitationMm: null,
    temperatureC: null,
    windMetersPerSecond: null,
    roadDelaySeconds: 0,
    legModelProfile: 'fixture-stack',
  };
}

function body(ticket: string, start = NOW) {
  return {
    ticket,
    consentVersion: ETA_LEARNING_CONSENT_VERSION,
    samples: [
      {
        segmentIndex: 0,
        startedAt: start + 1000,
        endedAt: start + 391000,
        evidence: 'user-confirmed',
      },
    ],
  };
}

async function fixture() {
  const db = await createTestDatabase(),
    store = new LearningRepository(db.database);

  await store.initialize();

  const service = new LearningService(store);

  await service.onModuleInit();

  return {
    ...db,
    store,
    service,
  };
}

async function seedSegments(h: Awaited<ReturnType<typeof fixture>>, count = 80) {
  const rows: EtaLearningObservation[] = [];

  for (let index = 0; index < count; index++) {
    const tripId = randomUUID(),
      startedAt = NOW - 30 * 86_400_000 + index * 6 * 3_600_000;

    rows.push({
      version: 1,
      id: `${tripId}:0`,
      tripId,
      source: 'recorded-trip',
      features: feature(startedAt),
      actualSeconds: 390,
      observedAt: startedAt + 390000,
      evidence: 'user-confirmed',
    });
  }

  await h.database.transaction(async (client) => {
    await client.getRepository(EtaObservationEntity).insert(
      rows.map((row) => ({
        id: row.id,
        tripId: row.tripId,
        observedAt: row.observedAt,
        payload: row,
      })),
    );
  });

  return rows;
}

test('Cloud SQL replicas share signed receipts, deduplicate measurements and revoke future uploads', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const second = new LearningRepository(h.database);

    await second.initialize();

    const ticket = h.store.issueTicket([feature()]);

    clock += 400000;

    const first = await second.submit(body(ticket));

    assert.equal(first.accepted, 1);
    assert.equal((await h.store.submit(body(ticket))).duplicates, 1);
    assert.equal((await h.store.observations())[0].actualSeconds, 390);
    assert.equal(
      /latitude|longitude|address|userId|account|stationName/.test(
        JSON.stringify(await h.store.observations()),
      ),
      false,
    );
    assert.equal(await h.store.erase(first.deletionToken), 1);
    await assert.rejects(second.submit(body(ticket)));
    assert.equal((await h.store.counts()).recordedSegments, 0);
  } finally {
    await h.close();
  }
});

test('erasing an unsubmitted receipt prevents late replay across instances', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const ticket = h.store.issueTicket([feature()]);

    clock += 400000;

    assert.deepEqual(
      await h.service.erase({
        ticket,
      }),
      {
        deleted: 0,
        modelInvalidated: false,
      },
    );
    await assert.rejects(h.store.submit(body(ticket)));
    assert.equal((await h.store.observations()).length, 0);
  } finally {
    await h.close();
  }
});

test('tampering, missing consent, future clocks and overlapping split submissions cannot write rows', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const ticket = h.store.issueTicket([feature(), feature()]);

    clock += 900000;

    const valid = body(ticket);

    await assert.rejects(
      h.store.submit({
        ...valid,
        ticket: `${ticket.slice(0, -8)}AAAAAAAA`,
      }),
    );
    await assert.rejects(
      h.store.submit({
        ticket,
        samples: valid.samples,
      }),
    );
    await assert.rejects(
      h.store.submit({
        ...valid,
        samples: [
          {
            ...valid.samples[0],
            endedAt: clock + 4000,
          },
        ],
      }),
    );
    assert.equal((await h.store.counts()).recordedSegments, 0);
    assert.equal((await h.store.submit(valid)).accepted, 1);
    await assert.rejects(
      h.store.submit({
        ...valid,
        samples: [
          {
            ...valid.samples[0],
            segmentIndex: 1,
          },
        ],
      }),
    );
    await assert.rejects(
      h.store.submit({
        ...valid,
        samples: [
          {
            ...valid.samples[0],
            endedAt: NOW + 390000,
          },
        ],
      }),
    );
    assert.equal(
      (
        await h.store.submit({
          ...valid,
          samples: [
            {
              ...valid.samples[0],
              segmentIndex: 1,
              startedAt: NOW + 391000,
              endedAt: NOW + 781000,
            },
          ],
        })
      ).accepted,
      1,
    );

    clock += 25 * 3600000;

    await assert.rejects(h.store.submit(valid));
  } finally {
    await h.close();
  }
});

test('whole journeys include gaps, require expanded consent and delete atomically with segment rows', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const ticket = h.store.issueTicket([null, null], {
      features: whole(),
      pathIdentity: 'private-coordinate-identity',
    });

    clock += 400000;

    const complete = {
      ticket,
      consentVersion: ETA_LEARNING_CONSENT_VERSION,
      samples: [
        {
          segmentIndex: 0,
          startedAt: NOW,
          endedAt: NOW + 120000,
          evidence: 'user-confirmed',
        },
        {
          segmentIndex: 1,
          startedAt: NOW + 150000,
          endedAt: NOW + 360000,
          evidence: 'user-confirmed',
        },
      ],
      journey: {
        startedAt: NOW,
        endedAt: NOW + 360000,
        evidence: 'user-confirmed',
      },
    };

    await assert.rejects(
      h.store.submit({
        ...complete,
        consentVersion: 'eta-learning-v1',
      }),
    );
    await assert.rejects(
      h.store.submit({
        ...complete,
        samples: complete.samples.slice(0, 1),
      }),
    );
    assert.equal((await h.store.journeys()).length, 0);

    const accepted = await h.service.submit(complete);

    assert.equal(accepted.accepted, 0);
    assert.equal(accepted.journeyAccepted, 1);
    assert.equal((await h.store.submit(complete)).journeyDuplicates, 1);

    const rows = await h.store.journeys();

    assert.equal(rows[0].actualSeconds, 360);
    assert.match(rows[0].pathGroup, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(rows).includes('private-coordinate-identity'), false);
    assert.deepEqual(
      await h.service.erase({
        deletionToken: accepted.deletionToken,
      }),
      {
        deleted: 1,
        modelInvalidated: true,
      },
    );
    assert.equal((await h.store.journeyCounts()).recordedJourneys, 0);
  } finally {
    await h.close();
  }
});

test('older context is cleared and retention prunes observations after 90 days', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const ticket = h.store.issueTicket([
      {
        ...feature(),
        precipitationMm: 2,
        congestionLevel: 'slow',
      },
    ]);

    clock += 1100000;

    await h.store.submit({
      ...body(ticket),
      samples: [
        {
          ...body(ticket).samples[0],
          startedAt: NOW + 600000,
          endedAt: NOW + 990000,
        },
      ],
    });

    const row = (await h.store.observations())[0];

    assert.equal(row.features.precipitationMm, null);
    assert.equal(row.features.congestionLevel, 'unknown');

    clock += 91 * 86_400_000;

    assert.equal((await h.store.counts()).recordedSegments, 0);
  } finally {
    await h.close();
  }
});

test('ORM coverage counts independent trips and Seoul service days while preserving bigint timestamps', async (t) => {
  t.mock.method(Date, 'now', () => NOW);

  const h = await fixture();

  try {
    const firstTrip = randomUUID();
    const secondTrip = randomUUID();
    const beforeMidnight = Date.UTC(2026, 9, 28, 14, 59);
    const afterMidnight = Date.UTC(2026, 9, 28, 15, 1);
    const samples = [
      { tripId: firstTrip, index: 0, startedAt: beforeMidnight, mode: 'walk' as const },
      { tripId: firstTrip, index: 1, startedAt: afterMidnight, mode: 'walk' as const },
      { tripId: secondTrip, index: 0, startedAt: afterMidnight, mode: 'subway' as const },
    ];

    await h.database.getRepository(EtaObservationEntity).insert(
      samples.map((sample) => {
        const payload: EtaLearningObservation = {
          version: 1,
          id: `${sample.tripId}:${sample.index}`,
          tripId: sample.tripId,
          source: 'recorded-trip',
          features: { ...feature(sample.startedAt), mode: sample.mode },
          actualSeconds: 90,
          observedAt: sample.startedAt + 90_000,
          evidence: 'user-confirmed',
        };

        return {
          id: payload.id,
          tripId: payload.tripId,
          observedAt: payload.observedAt,
          payload,
        };
      }),
    );

    assert.deepEqual(await h.store.counts(), {
      recordedSegments: 3,
      recordedTrips: 2,
    });
    assert.deepEqual(await h.store.trainingCoverage(), {
      byMode: {
        walk: { segments: 2, tripGroups: 1 },
        subway: { segments: 1, tripGroups: 1 },
      },
      serviceDays: 2,
    });

    const persisted = await h.database.getRepository(EtaObservationEntity).findOneByOrFail({
      id: `${firstTrip}:0`,
    });

    assert.equal(persisted.observedAt, beforeMidnight + 90_000);
    assert.equal(typeof persisted.observedAt, 'number');
  } finally {
    await h.close();
  }
});

test('validated models persist through service restart and erasure invalidates all replicas before the next search', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    const rows = await seedSegments(h),
      trained = trainContextualEta(rows, NOW);

    assert.ok(trained.model, trained.reasons.join(','));

    const report = await h.service.retrain();

    assert.equal(report?.activated, true);
    assert.ok(h.service.predict(feature()));

    const other = new LearningService(new LearningRepository(h.database));

    await other.onModuleInit();

    assert.ok(other.predict(feature()));
    assert.equal((await other.status()).model.active, true);

    await h.database.getRepository(EtaModelEntity).insert({
      kind: 'journey',
      payload: {},
      updatedAt: NOW,
    });

    const ticket = h.store.issueTicket([feature()]);

    clock += 400000;

    const completed = await h.service.submit(body(ticket));

    assert.deepEqual(
      await h.service.erase({
        deletionToken: completed.deletionToken,
      }),
      {
        deleted: 1,
        modelInvalidated: true,
      },
    );
    assert.equal(await h.database.getRepository(EtaModelEntity).count(), 0);

    await other.refresh();

    assert.equal(other.predict(feature()), null);
    assert.ok((await other.status()).model.reasons.includes('data-erased-retraining-required'));
  } finally {
    await h.close();
  }
});

test('whole-journey collection keeps a newly trained segment candidate shadow without moving the baseline', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  try {
    await seedSegments(h);

    assert.equal((await h.service.retrain())?.activated, true);

    const baseline = (
      await h.database.getRepository(EtaModelEntity).findOneByOrFail({ kind: 'contextual' })
    ).payload as NonNullable<ReturnType<typeof trainContextualEta>['model']>;

    const ticket = h.store.issueTicket([null, null], {
      features: whole(),
      pathIdentity: 'fixture-path',
    });

    clock += 400000;

    await h.store.submit({
      ticket,
      consentVersion: ETA_LEARNING_CONSENT_VERSION,
      samples: [
        {
          segmentIndex: 0,
          startedAt: NOW,
          endedAt: NOW + 120000,
          evidence: 'user-confirmed',
        },
        {
          segmentIndex: 1,
          startedAt: NOW + 120000,
          endedAt: NOW + 360000,
          evidence: 'user-confirmed',
        },
      ],
      journey: {
        startedAt: NOW,
        endedAt: NOW + 360000,
        evidence: 'user-confirmed',
      },
    });

    const report = await h.service.retrain();

    assert.ok(report?.model);
    assert.equal(report.deployment, 'shadow');
    assert.equal(report.activated, false);
    assert.deepEqual(
      (await h.database.getRepository(EtaModelEntity).findOneByOrFail({ kind: 'contextual' }))
        .payload,
      baseline,
    );

    const restarted = new LearningService(new LearningRepository(h.database));

    await restarted.onModuleInit();

    const status = await restarted.status();

    assert.equal(status.journey.cohortPolicy.segmentPromotion, 'shadow-only');
    assert.equal(status.model.trainedAt, baseline.trainedAt);

    clock = baseline.trainedAt + 31 * 86_400_000;

    assert.equal((await restarted.status()).model.active, false);
  } finally {
    await h.close();
  }
});

test('Nest learning HTTP endpoints preserve paths, success status, consent errors and response privacy', async (t) => {
  let clock = NOW;

  t.mock.method(Date, 'now', () => clock);

  const h = await fixture();

  const module = await Test.createTestingModule({
    controllers: [LearningController],
    providers: [
      {
        provide: LearningService,
        useValue: h.service,
      },
    ],
  }).compile();

  const app = module.createNestApplication({
    logger: false,
  });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());

  try {
    await app.listen(0, '127.0.0.1');

    const base = await app.getUrl();

    const ticket = h.store.issueTicket([feature()]);

    clock += 400000;

    const send = async (value: unknown, method = 'POST') => {
      try {
        return await fetch(`${base}/api/learning/observations`, {
          method,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(value),
        });
      } catch (error) {
        throw new Error(
          `HTTP test request failed: ${String(
            (
              error as Error & {
                cause?: unknown;
              }
            ).cause,
          )}`,
        );
      }
    };

    const bad = await send({
      ticket,
      samples: body(ticket).samples,
    });

    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_INPUT');

    const response = await send(body(ticket));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).accepted, 1);

    const status = await fetch(`${base}/api/learning/status`);

    assert.equal(status.status, 200);

    const payload = await status.json();

    assert.equal(payload.recordedTrips, 1);
    assert.equal(
      /receipt-secret|latitude|longitude|ticket|pathGroup|tripId/.test(JSON.stringify(payload)),
      false,
    );

    const erased = await send(
      {
        ticket,
      },
      'DELETE',
    );

    assert.equal(erased.status, 200);
    assert.deepEqual(await erased.json(), {
      deleted: 1,
      modelInvalidated: true,
    });
    assert.equal((await send(body(ticket))).status, 400);
  } finally {
    await app.close();

    await h.close();
  }
});
