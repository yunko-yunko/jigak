// Preserved regression cases from perception-map/mvp/tests/intelligenceWeather.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicBusTrainingObservations } from './fixtures/engine-publicBusTraining.js';
import { rankRouteIntelligence } from '../src/common/engine/intelligence/arrival.js';
import { journeyFeaturesForRoute } from '../src/common/engine/intelligence/journey-features.js';
import {
  applyContextualEtaTiming,
  learningFeaturesForRoute,
  learningFeaturesForSegment,
} from '../src/common/engine/intelligence/learning-features.js';
import {
  applyPlanningTimingAdjustments,
  localWeatherIsFresh,
} from '../src/common/engine/intelligence/planningTiming.js';
import { trainPublicBusModel } from '../src/common/engine/intelligence/public-bus-model.js';
import {
  PublicBusModelService,
  publicBusWeatherInput,
} from '../src/common/engine/intelligence/public-bus-service.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { FeedError } from '../src/common/engine/realtime/http.js';
import {
  kmaGrid,
  kmaObservationBase,
  parseKmaWeather,
  WEATHER_CACHE_MS,
  WEATHER_RECEIPT_MAX_AGE_MS,
  WeatherFeed,
} from '../src/common/engine/realtime/weather.js';
import { DEFAULT_PREFERENCES, planBaseRoutes } from '../src/common/shared/domain/index.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Place,
  Route,
} from '../src/common/shared/domain/types.js';
import type { EtaLearningFeatures } from '../src/common/shared/intelligence/learning.js';
import type { WeatherSnapshot } from '../src/common/shared/intelligence/types.js';

const SEOUL = {
  latitude: 37.5665,
  longitude: 126.978,
};

const NOW = Date.UTC(2026, 9, 12, 7, 45);

const origin: Place = {
  id: 'origin',
  name: '출발',
  address: '',
  ...SEOUL,
};

const rainyReceipt = (receivedAt: number): WeatherSnapshot => ({
  source: 'kma-ultra-short',
  status: 'live',
  ...SEOUL,
  grid: {
    x: 60,
    y: 127,
  },
  temperatureC: 18,
  precipitationMm: 2,
  precipitationType: 1,
  windMetersPerSecond: 2,
  observedAt: NOW - 30 * 60_000,
  receivedAt,
  message: '',
});

const segment = (
  id: string,
  mode: BaseSegment['mode'],
  seconds: number,
  distanceMeters: number,
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '',
  start: origin,
  end: origin,
  distanceMeters,
  durationSeconds: {
    min: seconds,
    max: seconds,
  },
  runAllowed: false,
});

const route = (segments: BaseSegment[]): BaseRoute => ({
  id: 'r',
  title: 'r',
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((n, s) => n + s.distanceMeters, 0),
  durationSeconds: segments.reduce(
    (n, s) => ({
      min: n.min + s.durationSeconds.min,
      max: n.max + s.durationSeconds.max,
    }),
    {
      min: 0,
      max: 0,
    },
  ),
});

const request: BasePlanningRequest = {
  origin,
  destination: origin,
  now: NOW,
  deadline: NOW + 3_600_000,
  preferences: DEFAULT_PREFERENCES,
};

const precipitation = (features: readonly (EtaLearningFeatures | null)[]) =>
  features.map((feature) => feature?.precipitationMm ?? null);

const weatherFields = (feature: EtaLearningFeatures | null) => [
  feature?.precipitationMm ?? null,
  feature?.temperatureC ?? null,
  feature?.windMetersPerSecond ?? null,
];

const planned = (id: string, seconds: number, mode: BaseSegment['mode'] = 'walk'): Route => {
  const provenance = {
    mode: 'live' as const,
    provider: 'verified-test-provider',
    label: '공급원',
    sourceTimestamp: NOW,
    receivedAt: NOW,
    isRealtime: true,
  };
  const destination: Place = {
    ...origin,
    id: 'destination',
    name: '도착',
    latitude: 37.57,
    longitude: 126.99,
  };
  const at = {
    earliest: NOW + seconds * 1000,
    latest: NOW + seconds * 1000,
  };

  return {
    id,
    title: id,
    origin,
    destination,
    durationSeconds: {
      min: seconds,
      max: seconds,
    },
    arrivalTime: at,
    readyTime: at,
    marginSeconds: {
      min: 3_600 - seconds,
      max: 3_600 - seconds,
    },
    runningMeters: 0,
    bicycleMeters: 0,
    bicycleRentals: 0,
    transfers: 0,
    risks: [],
    reasons: [],
    status: 'on-time',
    provenance,
    recommended: false,
    segments: [
      {
        ...segment(`${id}-leg`, mode, seconds, 1_000),
        end: destination,
        polyline: [origin, destination],
        timeRange: at,
        provenance,
      },
    ],
  };
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  response: {
    header: {
      resultCode: '00',
    },
    body: {
      items: {
        item: [
          ['T1H', '18.2'],
          ['PTY', '1'],
          ['RN1', '1.5'],
          ['WSD', '3.1'],
        ].map(([category, obsrValue]) => ({
          category,
          obsrValue,
          baseDate: '20261012',
          baseTime: '1600',
          nx: 60,
          ny: 127,
          ...overrides,
        })),
      },
    },
  },
});

test('KMA 5km projection and previous available hour handle KST midnight', () => {
  assert.deepEqual(kmaGrid(SEOUL), {
    x: 60,
    y: 127,
  });
  assert.deepEqual(kmaObservationBase(NOW), {
    date: '20261012',
    time: '1600',
  });
  assert.deepEqual(kmaObservationBase(Date.UTC(2026, 9, 11, 15, 10)), {
    date: '20261011',
    time: '2300',
  });
  assert.throws(
    () =>
      kmaGrid({
        latitude: 0,
        longitude: 0,
      }),
    RangeError,
  );
});

test('weather is source-timestamped and stale/future/wrong-grid data cannot become live', () => {
  const live = parseKmaWeather(payload(), SEOUL, NOW);

  assert.equal(live.status, 'live');
  assert.equal(live.precipitationMm, 1.5);
  assert.equal(live.observedAt, Date.UTC(2026, 9, 12, 7));
  assert.equal(live.receivedAt, NOW);
  assert.equal(parseKmaWeather(payload(), SEOUL, NOW + 2 * 3_600_000).status, 'stale');
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '1800',
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          nx: 59,
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        {
          response: {
            header: {
              resultCode: '30',
            },
          },
        },
        SEOUL,
        NOW,
      ),
    (error: unknown) => error instanceof FeedError && error.reason === 'auth',
  );
});

test('weather feed caches by grid, retries failure later, and never fabricates missing conditions', async () => {
  let calls = 0,
    clock = NOW;
  const fetcher = (async (input: URL) => {
    calls++;

    const url = new URL(String(input));

    assert.equal(url.searchParams.get('serviceKey'), 'decoded+key=');
    assert.equal(url.searchParams.get('base_time'), '1600');

    return new Response(JSON.stringify(payload()));
  }) as typeof fetch;
  const feed = new WeatherFeed('decoded%2Bkey%3D', {
    fetcher,
    now: () => clock,
  });

  await feed.conditions(SEOUL);
  await feed.conditions({
    latitude: SEOUL.latitude + 0.0001,
    longitude: SEOUL.longitude,
  });

  assert.equal(calls, 1);

  clock += 11 * 60_000;

  await feed.conditions(SEOUL);

  assert.equal(calls, 2);

  const absent = await new WeatherFeed(undefined, {
    fetcher,
  }).conditions(SEOUL);

  assert.equal(absent.status, 'unconfigured');
  assert.equal(absent.windMetersPerSecond, null);

  let failedCalls = 0;
  const broken = new WeatherFeed('bad', {
    now: () => clock,
    fetcher: (async () => {
      failedCalls++;

      return new Response('SERVICE_KEY_IS_NOT_REGISTERED_ERROR', {
        status: 403,
      });
    }) as typeof fetch,
  });

  clock = NOW;

  assert.equal((await broken.conditions(SEOUL)).status, 'unavailable');

  clock = NOW + 29_999;

  await broken.conditions(SEOUL);

  assert.equal(failedCalls, 1);
  assert.equal(broken.lastFailure, 'auth');

  clock = NOW + 30_000;

  await broken.conditions(SEOUL);

  assert.equal(failedCalls, 2, 'a failed lookup is retried 30 seconds later');
});

test('a receipt the feed serves at the end of its cache stays current through the search that reads it', async () => {
  let calls = 0,
    clock = NOW;
  const feed = new WeatherFeed('key', {
    now: () => clock,
    fetcher: (async () => {
      calls++;

      return new Response(JSON.stringify(payload()));
    }) as typeof fetch,
  });
  const bus: BaseSegment = {
    id: 'bus',
    mode: 'bus',
    title: '버스',
    instructions: '',
    start: origin,
    end: origin,
    distanceMeters: 1000,
    durationSeconds: { min: 300, max: 300 },
    runAllowed: false,
  };
  const first = await feed.conditions(SEOUL);

  for (const age of [150_000, 300_000, WEATHER_CACHE_MS - 1]) {
    clock = NOW + age;

    const cached = await feed.conditions(SEOUL);

    assert.equal(cached.receivedAt, first.receivedAt, 'served from the cache, not fetched again');

    for (const judgedAt of [clock, clock + 60_000]) {
      assert.equal(
        localWeatherIsFresh(cached, { origin, now: judgedAt }),
        true,
        `served at ${age}, judged ${judgedAt - clock} later`,
      );
      assert.notEqual(publicBusWeatherInput(cached, bus, judgedAt, judgedAt), null);
    }
  }

  assert.equal(calls, 1);

  clock = NOW + WEATHER_CACHE_MS;

  const refreshed = await feed.conditions(SEOUL);

  assert.equal(calls, 2);
  assert.equal(refreshed.receivedAt, clock);
  assert.deepEqual([WEATHER_CACHE_MS, WEATHER_RECEIPT_MAX_AGE_MS], [600_000, 660_000]);
  assert.equal(
    localWeatherIsFresh(first, { origin, now: first.receivedAt + WEATHER_RECEIPT_MAX_AGE_MS }),
    true,
  );
  assert.equal(
    localWeatherIsFresh(first, { origin, now: first.receivedAt + WEATHER_RECEIPT_MAX_AGE_MS + 1 }),
    false,
  );
});

test('rain from the last cached receipt keeps its planning time; an older receipt adds none', () => {
  for (const [age, seconds] of [
    [3 * 60_000, 15],
    [WEATHER_CACHE_MS, 15],
    [WEATHER_RECEIPT_MAX_AGE_MS, 15],
    [WEATHER_RECEIPT_MAX_AGE_MS + 1_000, 0],
  ]) {
    const [candidate] = applyPlanningTimingAdjustments(
      [route([segment('walk', 'walk', 100, 100)])],
      request,
      {
        weather: rainyReceipt(NOW - age),
      },
    );

    assert.equal(
      candidate.segments[0].planningBuffer?.weatherSeconds,
      seconds,
      `receipt age ${age}`,
    );
  }

  const bus = segment('bus', 'bus', 300, 1000);

  assert.notEqual(publicBusWeatherInput(rainyReceipt(NOW - 9 * 60_000), bus, NOW, NOW), null);
  assert.notEqual(
    publicBusWeatherInput(rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS), bus, NOW, NOW),
    null,
  );
  assert.notEqual(
    publicBusWeatherInput(
      rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS),
      bus,
      NOW + 30 * 60_000,
      NOW,
    ),
    null,
    'freshness is judged at the search, not at boarding',
  );
  assert.equal(
    publicBusWeatherInput(rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS - 1_000), bus, NOW, NOW),
    null,
  );
});

test('the public bus service judges a weather receipt at the search, also for a boarding half an hour later', () => {
  const directory = mkdtempSync(join(tmpdir(), 'public-bus-weather-')),
    modelPath = join(directory, 'model.json');

  try {
    const report = trainPublicBusModel(publicBusTrainingObservations(), { now: NOW });

    assert.equal(report.qualityPassed, true, JSON.stringify(report.reasons));
    writeFileSync(modelPath, JSON.stringify(report.model), { mode: 0o600 });

    const service = new PublicBusModelService({ modelPath, now: () => NOW });
    const bus: BaseSegment = {
      ...segment('bus', 'bus', 960, 4_000),
      end: { ...origin, id: 'alighting', name: '하차', latitude: SEOUL.latitude + 0.03 },
    };
    const boarding = NOW + 30 * 60_000;

    assert.ok(
      service.predictSegment(bus, boarding, NOW, null),
      'the checkpoint learned rides without weather',
    );
    assert.equal(
      service.predictSegment(bus, boarding, NOW, rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS)),
      null,
      'a receipt current at the search reaches the checkpoint, which abstains on weather it never learned',
    );
    assert.ok(
      service.predictSegment(
        bus,
        boarding,
        NOW,
        rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS - 1_000),
      ),
      'an older receipt never reaches it',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stale distant or invalid weather adds no fabricated planning time', () => {
  for (const [label, receipt] of [
    ['stale', { ...rainyReceipt(NOW), status: 'stale' }],
    ['observed 101 minutes ago', { ...rainyReceipt(NOW), observedAt: NOW - 101 * 60_000 }],
    ['distant', { ...rainyReceipt(NOW), latitude: 35.2, longitude: 129.1 }],
    ['unknown observation time', { ...rainyReceipt(NOW), observedAt: NaN }],
    ['received 61 seconds ahead', rainyReceipt(NOW + 61_000)],
    ['observed 61 seconds ahead', { ...rainyReceipt(NOW), observedAt: NOW + 61_000 }],
    [
      'observed 100 minutes and 1 ms ago',
      { ...rainyReceipt(NOW), observedAt: NOW - 100 * 60_000 - 1 },
    ],
  ] as const) {
    const [candidate] = applyPlanningTimingAdjustments(
      [route([segment('walk', 'walk', 100, 100)])],
      request,
      {
        weather: receipt,
      },
    );

    assert.equal(candidate.segments[0].planningBuffer?.weatherSeconds, 0, label);
  }
});

test('weather at the edge of each clock limit still adds its rain planning time', () => {
  for (const [label, receipt] of [
    ['received 60 seconds ahead', rainyReceipt(NOW + 60_000)],
    ['observed 60 seconds ahead', { ...rainyReceipt(NOW), observedAt: NOW + 60_000 }],
    ['observed exactly 100 minutes ago', { ...rainyReceipt(NOW), observedAt: NOW - 100 * 60_000 }],
  ] as const) {
    const [candidate] = applyPlanningTimingAdjustments(
      [route([segment('walk', 'walk', 100, 100)])],
      request,
      {
        weather: receipt,
      },
    );

    assert.equal(localWeatherIsFresh(receipt, request), true, label);
    assert.equal(candidate.segments[0].planningBuffer?.weatherSeconds, 15, label);
  }
});

test('live rain changes the conservative comparison, stale or distant weather has no fabricated impact', () => {
  const walk = planned('walk', 900);
  const result = rankRouteIntelligence([walk, planned('subway', 950, 'subway')], request, {
    weather: rainyReceipt(NOW),
  });
  const extraBuffer = (weather: WeatherSnapshot) =>
    rankRouteIntelligence([walk], request, { weather }).assessments[0].extraBufferSeconds;

  assert.equal(result.recommendationId, 'subway');
  assert.equal(result.assessments.find((item) => item.routeId === 'walk')?.extraBufferSeconds, 135);
  assert.equal(extraBuffer({ ...rainyReceipt(NOW), status: 'stale' }), 0);
  assert.equal(extraBuffer({ ...rainyReceipt(NOW), latitude: 35.2, longitude: 129.1 }), 0);
});

test('the arrival ranking and the whole-journey features keep rain from every receipt the feed can still serve, and none from an older one', () => {
  const walk = planned('walk', 900);

  for (const [age, rainy] of [
    [0, true],
    [WEATHER_CACHE_MS, true],
    [WEATHER_RECEIPT_MAX_AGE_MS, true],
    [WEATHER_RECEIPT_MAX_AGE_MS + 1, false],
  ] as const) {
    const receipt = rainyReceipt(NOW - age);
    const journey = journeyFeaturesForRoute(walk, NOW, receipt, 'fixture-stack');

    assert.equal(
      rankRouteIntelligence([walk], request, { weather: receipt }).assessments[0]
        .extraBufferSeconds,
      rainy ? 135 : 0,
      `arrival ranking, receipt age ${age}`,
    );
    assert.ok(journey, `whole-journey features, receipt age ${age}`);
    assert.deepEqual(
      [journey.precipitationMm, journey.temperatureC, journey.windMetersPerSecond],
      rainy ? [2, 18, 2] : [null, null, null],
      `whole-journey features, receipt age ${age}`,
    );
  }
});

test('search weather describes only stages that start within two minutes of the search, whatever the receipt age', () => {
  const stages = route([
    segment('walk', 'walk', 90, 120),
    segment('wait', 'wait', 30, 0),
    segment('bus', 'bus', 180, 2000),
    segment('walk2', 'walk', 60, 80),
  ]);
  const late = route([
    segment('walk', 'walk', 90, 120),
    segment('wait', 'wait', 31, 0),
    segment('bus', 'bus', 180, 2000),
  ]);
  const inferred = (candidate: BaseRoute, receipt: WeatherSnapshot) => {
    const seen: EtaLearningFeatures[] = [];

    applyContextualEtaTiming([candidate], request, receipt, (features) => {
      seen.push(features);

      return null;
    });

    return seen;
  };

  for (const age of [0, 300_000, WEATHER_CACHE_MS, WEATHER_RECEIPT_MAX_AGE_MS]) {
    const receipt = rainyReceipt(NOW - age);

    assert.deepEqual(
      precipitation(learningFeaturesForRoute(stages, NOW, receipt)),
      [2, 2, 2, null],
      `ticket, receipt age ${age}`,
    );
    assert.deepEqual(
      precipitation(learningFeaturesForRoute(late, NOW, receipt)),
      [2, 2, null],
      `ticket after the horizon, receipt age ${age}`,
    );
    assert.deepEqual(
      precipitation(inferred(stages, receipt)),
      [2, 2, 2, null],
      `inference, receipt age ${age}`,
    );
    assert.deepEqual(
      precipitation(inferred(late, receipt)),
      [2, 2, null],
      `inference after the horizon, receipt age ${age}`,
    );
  }

  const old = rainyReceipt(NOW - WEATHER_RECEIPT_MAX_AGE_MS - 1_000);

  assert.deepEqual(
    precipitation(learningFeaturesForRoute(stages, NOW, old)),
    [null, null, null, null],
    'ticket, old receipt',
  );
  assert.deepEqual(
    precipitation(inferred(stages, old)),
    [null, null, null, null],
    'inference, old receipt',
  );

  const rainAt = (startedAt: number) =>
    learningFeaturesForSegment(
      segment('bus', 'bus', 180, 2000),
      { startedAt, precedingWaitSeconds: 0, vehicleCount: 0, requestNow: NOW },
      rainyReceipt(NOW),
    )?.precipitationMm ?? null;

  assert.equal(rainAt(NOW + 120_000), 2);
  assert.equal(rainAt(NOW + 120_001), null);

  const everyField = [
    [2, 18, 2],
    [2, 18, 2],
    [2, 18, 2],
    [null, null, null],
  ];

  assert.deepEqual(
    learningFeaturesForRoute(stages, NOW, rainyReceipt(NOW)).map(weatherFields),
    everyField,
    'ticket, every weather field',
  );
  assert.deepEqual(
    inferred(stages, rainyReceipt(NOW)).map(weatherFields),
    everyField,
    'inference, every weather field',
  );
});

test('the journey graph gives search weather only to stages that start within two minutes of the search', () => {
  const stop: Place = { ...origin, id: 'stop', name: '경유', latitude: SEOUL.latitude + 0.001 };
  const destination: Place = {
    ...origin,
    id: 'destination',
    name: '도착',
    latitude: SEOUL.latitude + 0.002,
  };
  const walk = (id: string, start: Place, end: Place, seconds: number): BaseRoute => ({
    ...route([{ ...segment(id, 'walk', seconds, 100), start, end, polyline: [start, end] }]),
    id,
  });
  const weatherByStart = (firstSeconds: number, age: number) => {
    const seen = new Map<number, (number | null)[]>();

    planJourneyGraph(
      { ...request, destination },
      [walk('first', origin, stop, firstSeconds), walk('second', stop, destination, 60)],
      {
        receivedAt: NOW,
        contextualEta: {
          weather: rainyReceipt(NOW - age),
          predict: (features) => {
            seen.set(features.startedAt - NOW, weatherFields(features));

            return null;
          },
        },
      },
    );

    return seen;
  };

  for (const age of [0, WEATHER_CACHE_MS, WEATHER_RECEIPT_MAX_AGE_MS]) {
    assert.deepEqual(
      weatherByStart(120, age),
      new Map([
        [0, [2, 18, 2]],
        [120_000, [2, 18, 2]],
      ]),
      `receipt age ${age}`,
    );
    assert.deepEqual(
      weatherByStart(121, age),
      new Map([
        [0, [2, 18, 2]],
        [121_000, [null, null, null]],
      ]),
      `stage after the horizon, receipt age ${age}`,
    );
  }

  assert.deepEqual(
    weatherByStart(120, WEATHER_RECEIPT_MAX_AGE_MS + 1_000),
    new Map([
      [0, [null, null, null]],
      [120_000, [null, null, null]],
    ]),
  );
});

test('the journey graph dates search weather by the conservative clock its learning ticket uses, also when it plans on point estimates', () => {
  const stop: Place = { ...origin, id: 'stop', name: '경유', latitude: SEOUL.latitude + 0.001 };
  const destination: Place = {
    ...origin,
    id: 'destination',
    name: '도착',
    latitude: SEOUL.latitude + 0.002,
  };
  const walk = (id: string, start: Place, end: Place, seconds: number): BaseRoute => ({
    ...route([{ ...segment(id, 'walk', seconds, 100), start, end, polyline: [start, end] }]),
    id,
  });
  const searched = { ...request, destination };
  const receipt = rainyReceipt(NOW);

  for (const [firstSeconds, conservativeStart, secondWeather] of [
    [110, 127_000, [null, null, null]],
    [105, 121_000, [null, null, null]],
    [104, 120_000, [2, 18, 2]],
  ] as const) {
    for (const [objective, secondStart] of [
      ['estimated-arrival', firstSeconds * 1000],
      ['conservative-arrival', conservativeStart],
    ] as const) {
      const label = `${objective}, first walk ${firstSeconds} s`;
      const seen = new Map<number, (number | null)[]>();
      const [composed] = planJourneyGraph(
        searched,
        applyPlanningTimingAdjustments(
          [walk('first', origin, stop, firstSeconds), walk('second', stop, destination, 60)],
          searched,
          { weather: receipt },
        ),
        {
          receivedAt: NOW,
          objective,
          contextualEta: {
            weather: receipt,
            predict: (features) => {
              seen.set(features.startedAt - NOW, weatherFields(features));

              return null;
            },
          },
        },
      ).routes;
      const ticket = learningFeaturesForRoute(composed, NOW, receipt);

      assert.deepEqual(
        seen,
        new Map([
          [0, [2, 18, 2]],
          [secondStart, secondWeather],
        ]),
        `${label} inference`,
      );
      assert.deepEqual(
        ticket.map((feature) => feature && feature.startedAt - NOW),
        [0, conservativeStart],
        `${label} ticket clock`,
      );
      assert.deepEqual(
        ticket.map(weatherFields),
        [seen.get(0), seen.get(secondStart)],
        `${label}: inference and the learning ticket carry the same weather`,
      );
    }
  }
});

test("inside a live boarding arc the journey graph dates search weather by the stage's own conservative start, as its learning ticket does", () => {
  const stop: Place = { ...origin, id: 'stop', name: '정류장', latitude: SEOUL.latitude + 0.001 };
  const destination: Place = {
    ...origin,
    id: 'destination',
    name: '도착',
    latitude: SEOUL.latitude + 0.01,
  };
  const searched = { ...request, destination };
  const receipt = rainyReceipt(NOW);
  const transit = route([
    { ...segment('access', 'walk', 70, 100), end: stop, polyline: [origin, stop] },
    {
      ...segment('ride', 'bus', 300, 1_500),
      start: stop,
      end: destination,
      polyline: [stop, destination],
      realtime: {
        provider: 'seoul-bus',
        status: 'live',
        stopName: stop.name,
        observedAt: NOW,
        receivedAt: NOW,
        predictions: [110, 500].map((seconds) => ({
          line: '402',
          message: '도착 예측',
          arrivesAt: NOW + seconds * 1000,
        })),
      },
    },
  ]);
  const seen = new Map<BaseSegment['mode'], [number, (number | null)[]]>();
  const [composed] = planJourneyGraph(
    searched,
    applyPlanningTimingAdjustments([transit], searched, { weather: receipt }),
    {
      receivedAt: NOW,
      objective: 'estimated-arrival',
      contextualEta: {
        weather: receipt,
        predict: (features) => {
          seen.set(features.mode, [features.startedAt - NOW, weatherFields(features)]);

          return null;
        },
      },
    },
  ).routes;
  const [planned] = planBaseRoutes(
    searched,
    [composed],
    {
      mode: 'live',
      provider: 'verified-test-provider',
      label: '공급원',
      sourceTimestamp: NOW,
      receivedAt: NOW,
      isRealtime: true,
    },
    { objective: 'estimated-arrival' },
  ).routes;
  const ticket = learningFeaturesForRoute(planned, NOW, receipt);

  assert.deepEqual(
    seen,
    new Map<BaseSegment['mode'], [number, (number | null)[]]>([
      ['walk', [0, [2, 18, 2]]],
      ['bus', [110_000, [null, null, null]]],
    ]),
    'the 11 s rain margin misses the 110 s bus on the conservative clock, so the bus boards at 500 s there',
  );
  assert.deepEqual(
    ticket.map((feature) => feature && [feature.mode, feature.startedAt - NOW]),
    [
      ['walk', 0],
      ['wait', 81_000],
      ['bus', 500_000],
    ],
    'ticket clock',
  );
  assert.deepEqual(
    weatherFields(ticket[2]),
    seen.get('bus')?.[1],
    'inference and the learning ticket carry the same bus weather',
  );
});

test('the journey graph withholds search weather from a stage a fraction of a second past two minutes on the conservative clock and keeps it at exactly two minutes, as its learning ticket does', () => {
  const stop: Place = { ...origin, id: 'stop', name: '정류장', latitude: SEOUL.latitude + 0.001 };
  const alighting: Place = {
    ...origin,
    id: 'alighting',
    name: '하차',
    latitude: SEOUL.latitude + 0.008,
  };
  const destination: Place = {
    ...origin,
    id: 'destination',
    name: '도착',
    latitude: SEOUL.latitude + 0.0085,
  };
  const searched = { ...request, destination };
  const receipt = rainyReceipt(NOW);

  for (const [feedLag, departures, inferredAt, ticketedAt, egressWeather] of [
    [999, [51, 61], [50_001, 110_001], [60_001, 120_001], [null, null, null]],
    [563, [51, 61], [50_437, 110_437], [60_437, 120_437], [null, null, null]],
    [0, [51, 60], [51_000, 111_000], [60_000, 120_000], [2, 18, 2]],
  ] as const) {
    const answeredAt = NOW - feedLag;
    const transit = route([
      { ...segment('access', 'walk', 20, 100), end: stop, polyline: [origin, stop] },
      {
        ...segment('ride', 'bus', 60, 800),
        start: stop,
        end: alighting,
        polyline: [stop, alighting],
        realtime: {
          provider: 'seoul-bus',
          status: 'live',
          stopName: stop.name,
          observedAt: answeredAt,
          receivedAt: answeredAt,
          predictions: departures.map((seconds) => ({
            line: '402',
            message: '도착 예측',
            arrivesAt: answeredAt + seconds * 1000,
          })),
        },
      },
      {
        ...segment('egress', 'walk', 30, 50),
        start: alighting,
        end: destination,
        polyline: [alighting, destination],
      },
    ]);
    const seen: [BaseSegment['mode'], number, (number | null)[]][] = [];
    const [composed] = planJourneyGraph(
      searched,
      applyPlanningTimingAdjustments([transit], searched, { weather: receipt }),
      {
        receivedAt: NOW,
        objective: 'estimated-arrival',
        contextualEta: {
          weather: receipt,
          predict: (features) => {
            seen.push([features.mode, features.startedAt - NOW, weatherFields(features)]);

            return null;
          },
        },
      },
    ).routes;
    const [planned] = planBaseRoutes(
      searched,
      [composed],
      {
        mode: 'live',
        provider: 'verified-test-provider',
        label: '공급원',
        sourceTimestamp: NOW,
        receivedAt: NOW,
        isRealtime: true,
      },
      { objective: 'estimated-arrival' },
    ).routes;
    const ticket = learningFeaturesForRoute(planned, NOW, receipt);
    const label = `bus feed answered ${feedLag} ms before the search`;

    assert.deepEqual(
      seen,
      [
        ['walk', 0, [2, 18, 2]],
        ['bus', inferredAt[0], [2, 18, 2]],
        ['walk', inferredAt[1], egressWeather],
      ],
      `${label}: inference`,
    );
    assert.deepEqual(
      ticket.map((feature) => feature && [feature.mode, feature.startedAt - NOW]),
      [
        ['walk', 0],
        ['wait', 23_000],
        ['bus', ticketedAt[0]],
        ['walk', ticketedAt[1]],
      ],
      `${label}: ticket clock`,
    );
    assert.deepEqual(
      weatherFields(ticket[3]),
      seen[2]?.[2],
      `${label}: inference and the learning ticket carry the same egress weather`,
    );
  }
});

test('unsupported coordinates return unavailable weather without rejecting an optional route dependency', async () => {
  let calls = 0;
  const feed = new WeatherFeed('configured', {
    now: () => NOW,
    fetcher: (async () => {
      calls++;

      throw new Error('must not query');
    }) as typeof fetch,
  });

  for (const point of [
    {
      latitude: 35.68,
      longitude: 139.76,
    },
    {
      latitude: 0,
      longitude: 0,
    },
  ]) {
    const result = await feed.conditions(point);

    assert.equal(result.status, 'unavailable');
    assert.equal(result.grid, null);
    assert.equal(result.observedAt, null);
    assert.equal(result.temperatureC, null);
    assert.match(result.message, /지원 지역/);
  }

  assert.equal(calls, 0);
});

test('weather rejects impossible values before they can invalidate an otherwise usable route response', () => {
  for (const [category, value] of [
    ['T1H', '-81'],
    ['T1H', '71'],
    ['RN1', '-1'],
    ['RN1', '1e308'],
    ['WSD', '-1'],
    ['WSD', '151'],
    ['PTY', '1.5'],
  ]) {
    const data = payload();

    data.response.body.items.item.find((row) => row.category === category)!.obsrValue = value;

    assert.throws(() => parseKmaWeather(data, SEOUL, NOW), FeedError, `${category}=${value}`);
  }
});

test('weather does not normalize impossible source calendar dates or hour overflow into live observations', () => {
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '1560',
        }),
        SEOUL,
        NOW,
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseTime: '2400',
        }),
        SEOUL,
        Date.UTC(2026, 9, 12, 16),
      ),
    FeedError,
  );
  assert.throws(
    () =>
      parseKmaWeather(
        payload({
          baseDate: '20260230',
        }),
        SEOUL,
        Date.UTC(2026, 2, 2, 8),
      ),
    FeedError,
  );
});
