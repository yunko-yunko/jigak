// Preserved regression cases from perception-map/mvp/tests/publicBusTiming.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPublicBusSegment,
  applyPublicBusTiming,
  type PublicBusPredictor,
} from '../src/common/engine/intelligence/public-bus-timing.js';
import {
  applyContextualEtaSegment,
  learningFeaturesForSegment,
} from '../src/common/engine/intelligence/learning-features.js';
import { planJourneyGraph } from '../src/common/engine/journey-graph.js';
import { DEFAULT_PREFERENCES } from '../src/common/shared/domain/index.js';
import type { BaseSegment, BaseRoute, Place } from '../src/common/shared/domain/types.js';

const NOW = Date.parse('2026-10-15T02:00:00Z');

const a: Place = {
  id: 'a',
  name: 'a',
  address: '',
  latitude: 37.55,
  longitude: 126.97,
};

const b: Place = {
  ...a,
  id: 'b',
  name: 'b',
  latitude: 37.56,
};

const c: Place = {
  ...a,
  id: 'c',
  name: 'c',
  latitude: 37.57,
};

const bus: BaseSegment = {
  id: 'bus',
  mode: 'bus',
  title: '버스',
  instructions: '',
  distanceMeters: 2000,
  durationSeconds: {
    min: 300,
    max: 400,
  },
  start: a,
  end: b,
  runAllowed: false,
  polyline: [a, b],
  roadDelaySeconds: 100,
};

const predict: PublicBusPredictor = () => ({
  modelVersion: 'public-bus-duration-v2',
  target: 'bus-tag-elapsed',
  lowerSeconds: 200,
  medianSeconds: 500,
  upperSeconds: 700,
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

const request = {
  origin: a,
  destination: b,
  now: NOW,
  deadline: NOW + 3600000,
  preferences: DEFAULT_PREFERENCES,
};

test('public bus estimate preserves provider lower bound and existing road allowance without double addition', () => {
  const corrected = applyPublicBusSegment(bus, NOW, NOW, predict);

  assert.deepEqual(corrected.durationSeconds, {
    min: 300,
    max: 700,
  });
  assert.equal(corrected.roadDelaySeconds, 100);
  assert.deepEqual(corrected.publicEtaPrediction?.sourceDurationSeconds, bus.durationSeconds);
  assert.deepEqual(applyPublicBusSegment(corrected, NOW, NOW, predict), corrected);
  assert.deepEqual(
    applyPublicBusSegment(corrected, NOW + 10000, NOW, () => null),
    bus,
  );
});

test('public bus estimates never alter other modes or shorten a provider upper bound', () => {
  for (const mode of [
    'walk',
    'wait',
    'taxi',
    'car',
    'subway',
    'bicycle',
    'scooter',
    'entry',
    'hire',
    'return',
  ] as const) {
    assert.equal(
      applyPublicBusSegment(
        {
          ...bus,
          mode,
        },
        NOW,
        NOW,
        predict,
      ).publicEtaPrediction,
      undefined,
    );
  }

  const slow = {
    ...bus,
    durationSeconds: {
      min: 800,
      max: 900,
    },
  };

  assert.deepEqual(
    applyPublicBusSegment(slow, NOW, NOW, predict).durationSeconds,
    slow.durationSeconds,
  );

  const corrected = applyPublicBusSegment(bus, NOW, NOW, predict);
  const features = learningFeaturesForSegment(
    corrected,
    {
      startedAt: NOW,
      precedingWaitSeconds: 0,
      vehicleCount: 0,
    },
    null,
  )!;

  assert.equal(features.predictedSeconds, 350, 'rider residual labels retain provider baseline');
});

test('public bus graph inference uses composed boarding time and rejects unsupported new contexts', () => {
  const walk = {
    ...bus,
    id: 'walk',
    mode: 'walk' as const,
    distanceMeters: 500,
    start: a,
    end: c,
    polyline: [a, c],
    durationSeconds: {
      min: 120,
      max: 120,
    },
    roadDelaySeconds: undefined,
  };
  const ride = {
    ...bus,
    start: c,
    end: b,
    polyline: [c, b],
  };
  const partial = applyPublicBusTiming(
    [
      {
        ...route([ride]),
        id: 'ride-source',
      },
    ],
    request,
    predict,
  );
  const clocks: number[] = [];
  const graph = planJourneyGraph(request, [route([walk]), ...partial], {
    receivedAt: NOW,
    publicBusEta: {
      predict: (_segment, startedAt) => {
        clocks.push(startedAt);

        return startedAt === NOW ? predict(bus, startedAt, NOW) : null;
      },
    },
  });

  assert.ok(clocks.includes(NOW + 480000));
  assert.equal(graph.routes[0]?.durationSeconds.max, 880);
  assert.equal(graph.routes[0]?.segments.at(-1)?.publicEtaPrediction, undefined);
});

test('invalid and excessively distant estimates fall back', () => {
  for (const values of [
    {
      lowerSeconds: -1,
      medianSeconds: 50,
      upperSeconds: 60,
    },
    {
      lowerSeconds: 100,
      medianSeconds: 50,
      upperSeconds: 60,
    },
    {
      lowerSeconds: 1,
      medianSeconds: 50,
      upperSeconds: Infinity,
    },
  ]) {
    assert.equal(
      applyPublicBusSegment(bus, NOW, NOW, () => ({
        ...predict(bus, NOW, NOW)!,
        ...values,
      })).publicEtaPrediction,
      undefined,
    );
  }

  assert.equal(
    applyPublicBusSegment(bus, NOW + 4 * 3600000, NOW, predict).publicEtaPrediction,
    undefined,
  );
  assert.equal(applyPublicBusSegment(bus, NOW - 1, NOW, predict).publicEtaPrediction, undefined);
});

test('a later rider model replaces the public envelope and restores the genuine provider baseline on refusal', () => {
  const publicEstimate = applyPublicBusSegment(bus, NOW, NOW, predict);
  const feature = learningFeaturesForSegment(
    publicEstimate,
    {
      startedAt: NOW,
      precedingWaitSeconds: 0,
      vehicleCount: 0,
    },
    null,
  )!;
  const riderEstimate = applyContextualEtaSegment(publicEstimate, feature, NOW, () => ({
    lowerSeconds: 250,
    medianSeconds: 300,
    upperSeconds: 450,
    modelVersion: 'eta-context-v2',
  }));

  assert.equal(riderEstimate.publicEtaPrediction, undefined);
  assert.deepEqual(riderEstimate.etaPrediction?.sourceDurationSeconds, bus.durationSeconds);
  assert.deepEqual(
    applyContextualEtaSegment(riderEstimate, feature, NOW, () => null).durationSeconds,
    bus.durationSeconds,
  );
});
