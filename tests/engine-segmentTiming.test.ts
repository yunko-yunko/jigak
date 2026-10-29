// Preserved regression cases from perception-map/mvp/tests/segmentTiming.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Route, Segment, SegmentMode } from '../src/common/shared/domain/types.js';
import { describeRouteTiming } from '../src/common/engine/intelligence/segmentTiming.js';

const NOW = Date.UTC(2026, 9, 12, 6);

const point = {
  id: 'p',
  name: '교차점',
  address: '',
  latitude: 37.5665,
  longitude: 126.978,
};

const provenance = {
  mode: 'live' as const,
  provider: 'fixture',
  label: '경로 공급원',
  sourceTimestamp: null,
  receivedAt: NOW,
  isRealtime: false,
};

const segment = (id: string, mode: SegmentMode, seconds: number): Segment => ({
  id,
  mode,
  title: id,
  instructions: '',
  start: point,
  end: point,
  distanceMeters: mode === 'wait' || mode === 'hire' || mode === 'return' ? 0 : 500,
  durationSeconds: {
    min: seconds,
    max: seconds,
  },
  runAllowed: false,
  timeRange: {
    earliest: NOW + seconds * 1000,
    latest: NOW + seconds * 1000,
  },
  provenance,
});

const route = (segments: Segment[]): Route => {
  const total = segments.reduce((sum, value) => sum + value.durationSeconds.max, 0);

  return {
    id: 'mixed',
    title: '복합 경로',
    origin: point,
    destination: point,
    segments,
    provenance,
    durationSeconds: {
      min: total,
      max: total,
    },
    arrivalTime: {
      earliest: NOW + total * 1000,
      latest: NOW + total * 1000,
    },
    readyTime: {
      earliest: NOW + total * 1000,
      latest: NOW + total * 1000,
    },
    marginSeconds: {
      min: 0,
      max: 0,
    },
    runningMeters: 0,
    bicycleMeters: 500,
    bicycleRentals: 1,
    transfers: 1,
    risks: [],
    reasons: [],
    recommended: false,
    status: 'uncertain',
  };
};

test('pedestrian-network source and its included endpoint allowance are visible without another ETA addition', () => {
  const walking = segment('network-walk', 'walk', 100);

  walking.durationSeconds.max = 150;
  walking.routingSource = {
    ...provenance,
    provider: 'osrm-foot',
    label: 'OpenStreetMap 보행망',
  };
  walking.provenance = walking.routingSource;
  walking.networkSnap = {
    startMeters: 20,
    endMeters: 30,
    allowanceSeconds: 50,
  };

  const candidate = route([walking]);

  candidate.durationSeconds.min = 100;

  const summary = describeRouteTiming(candidate, 0, NOW)!;

  assert.deepEqual(summary.totalSeconds, {
    min: 100,
    max: 150,
  });
  assert.match(summary.components[0].sourceLabel, /OpenStreetMap.*50초/);
  assert.ok(summary.notes.some((note) => /20m.*30m.*50초/.test(note)));
  assert.equal(summary.components[0].basis, 'provider-estimate');
});

test('timing explains mixed-mode access, rental, dispatch, riding and preparation without adding them twice', () => {
  const candidate = route([
    segment('access', 'walk', 50),
    segment('hire', 'hire', 60),
    segment('bike', 'bicycle', 180),
    segment('return', 'return', 30),
    segment('taxi-pickup', 'wait', 120),
    segment('taxi', 'taxi', 300),
  ]);
  const summary = describeRouteTiming(candidate, 90, NOW)!;

  assert.deepEqual(
    summary.components.map((value) => value.kind),
    ['access', 'hire', 'ride', 'return', 'dispatch', 'ride', 'preparation'],
  );
  assert.equal(
    summary.components.find((value) => value.kind === 'dispatch')?.basis,
    'rule-estimate',
  );
  assert.deepEqual(summary.totalSeconds, {
    min: 830,
    max: 830,
  });
  assert.equal(
    summary.components.reduce((sum, value) => sum + value.seconds.max, 0),
    830,
  );
  assert.ok(summary.unavailableFactors.includes('live-signal'));
  assert.ok(summary.notes.some((note) => /배차.*추정/.test(note)));
});

test('live boarding proves only the wait basis; bus ride, stops and road-delay adjustment stay labeled estimates', () => {
  const waiting = segment('live-wait', 'wait', 120);

  waiting.connection = {
    departureAt: NOW + 120_000,
    status: 'comfortable',
    boardingMarginSeconds: 90,
    explanation: '공급원 도착예정',
  };
  waiting.provenance = {
    ...provenance,
    provider: 'tago-bus',
    label: '실시간 도착 정보',
    sourceTimestamp: NOW - 10_000,
    isRealtime: true,
  };

  const bus = segment('bus', 'bus', 720);

  bus.roadDelaySeconds = 120;
  bus.provenance = waiting.provenance;

  const summary = describeRouteTiming(route([waiting, bus]), 0, NOW)!;

  assert.equal(summary.components[0].basis, 'live-arrival');
  assert.equal(summary.components[0].observedAt, NOW - 10_000);
  assert.equal(
    summary.components[1].basis,
    'provider-estimate',
    'a boarding arrival feed does not measure the remaining ride',
  );
  assert.equal(summary.components[1].includedRoadDelaySeconds, 120);
  assert.equal(
    summary.totalSeconds.max,
    840,
    'the 120-second road adjustment is already in riding time',
  );
  assert.ok(summary.unavailableFactors.includes('bus-stop-dwell'));
  assert.ok(summary.notes.some((note) => /정류장.*별도.*측정/.test(note)));
  assert.ok(summary.notes.some((note) => /도로.*추정/.test(note)));
});

test('old or future boarding timestamps do not describe waiting as a live measurement', () => {
  for (const [sourceTimestamp, receivedAt] of [
    [NOW - 121_000, NOW],
    [NOW + 31_000, NOW],
    [null, NOW],
    [NOW, NOW - 121_000],
    [NOW, NOW + 31_000],
  ]) {
    const waiting = segment('wait', 'wait', 120);

    waiting.connection = {
      departureAt: NOW + 120_000,
      status: 'comfortable',
      boardingMarginSeconds: 90,
      explanation: '',
    };
    waiting.provenance = {
      ...provenance,
      sourceTimestamp,
      receivedAt: receivedAt!,
      isRealtime: true,
    };

    assert.equal(
      describeRouteTiming(route([waiting, segment('subway', 'subway', 300)]), 0, NOW)!.components[0]
        .basis,
      'rule-estimate',
    );
  }
});

test('parking remains a separate estimated action and invalid durations cannot receive a plausible timing summary', () => {
  const candidate = route([
    segment('car', 'car', 300),
    segment('car-park', 'wait', 180),
    segment('egress', 'walk', 60),
  ]);

  assert.equal(describeRouteTiming(candidate, 0, NOW)!.components[1].kind, 'parking');

  candidate.segments[0].durationSeconds.max = NaN;

  assert.equal(describeRouteTiming(candidate, 0, NOW), null);
});
