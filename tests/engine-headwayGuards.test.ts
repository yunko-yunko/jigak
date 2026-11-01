// Engine cases from mvp/tests/headwayGuards.test.ts (the departure-cutoff case, app-only, lives there).
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import { transferBridgePairs } from '../src/common/engine/mixed-mode-bridges.js';
import { busHeadwayEvidence } from '../src/common/engine/realtime/headway-evidence.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  RealtimeService,
  type BoardingQuery,
  type RealtimeService as RealtimeServiceType,
} from '../src/common/engine/realtime/service.js';
import { enrichTransitRoutes } from '../src/common/engine/transit-enrichment.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type Place,
} from '../src/common/shared/domain/index.js';

const KST = 9 * 3_600_000;
/** Wednesday 2026-10-28 08:47:40 KST: a reviewed weekday. */
const NOW = Date.UTC(2026, 9, 27, 23, 47, 40);
const kst = (hours: number, minutes = 0) => Date.UTC(2026, 9, 28, hours, minutes) - KST;
const place = (id: string, latitude: number, longitude = 126.97): Place => ({
  id,
  name: id,
  address: '서울',
  latitude,
  longitude,
});
const leg = (
  id: string,
  mode: BaseSegment['mode'],
  from: Place,
  to: Place,
  seconds: number,
  extra: Partial<BaseSegment> = {},
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: id,
  start: from,
  end: to,
  distanceMeters: from === to ? 0 : Math.round(metersBetween(from, to)),
  durationSeconds: { min: seconds, max: seconds },
  runAllowed: false,
  ...(from === to ? {} : { polyline: [from, to] }),
  ...extra,
});
const base = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  distanceMeters: segments.reduce((sum, value) => sum + value.distanceMeters, 0),
  durationSeconds: {
    min: segments.reduce((sum, value) => sum + value.durationSeconds.min, 0),
    max: segments.reduce((sum, value) => sum + value.durationSeconds.max, 0),
  },
});
const noWalks: RouteProvider = {
  configured: true,
  searchPlaces: async () => [],
  walking: async () => {
    throw new Error('no walk');
  },
  transit: async () => [],
};

// A stop sheet that has not answered in time must still leave what the line names establish.
test('a boarding whose stop sheet is late keeps the name-rule evidence', async () => {
  const at = kst(23, 39),
    origin = place('출발', 37.55),
    stop = place('승차', 37.551),
    destination = place('도착', 37.58);
  const route = base('late', [
    leg('access', 'walk', origin, stop, 90),
    leg('ride', 'bus', stop, destination, 600, {
      transit: { lines: ['8101(출근)', '7016'], stops: ['승차', '다음', '도착'] },
    }),
  ]);
  const realtime = {
    lookup: async () => null,
    busSheet: () => new Promise<null>(() => {}),
  } as unknown as RealtimeServiceType;
  const [enriched] = await enrichTransitRoutes(
    [route],
    { origin, destination },
    {
      provider: noWalks,
      budget: new CallBudget(),
      realtime,
      now: at,
      maxAccessCalls: 0,
      realtimeWaitMs: 20,
    },
  );
  const ride = enriched.segments.find((segment) => segment.mode === 'bus')!;
  assert.deepEqual(ride.headwayEvidence, busHeadwayEvidence(['8101(출근)', '7016'], null, at));
  assert.equal(
    ride.headwayEvidence?.lines?.find((line) => line.name === '8101(출근)')?.status,
    'not-running',
  );
  // 8101(출근) does not run at 23:39: the rule for 7016 alone, not for both listed lines.
  assert.equal(
    enriched.segments.find((segment) => segment.mode === 'wait')!.durationSeconds.min,
    480,
  );
});

// The arrival lookup and the stop sheet of one boarding run as one feed pass: one failure, one record per feed.
test('a concurrent lookup and stop sheet of one boarding record each failing feed once', async () => {
  const service = new RealtimeService({
    dataGoKrServiceKey: 'key',
    now: () => NOW,
    fetcher: async () => new Response('nope', { status: 500 }),
  });
  const records: string[] = [];
  const internal = service as unknown as { record: (provider: string, error?: unknown) => void };
  const record = internal.record.bind(service);
  internal.record = (provider, error) => {
    records.push(`${provider}:${error === undefined ? 'ok' : 'failed'}`);
    record(provider, error);
  };
  const boarding: BoardingQuery = {
    mode: 'bus',
    stop: '충정로역(중)',
    lines: ['271'],
    nextStops: ['서대문역사거리(중)'],
    latitude: 37.56118056,
    longitude: 126.96359447,
  };
  const [live, sheet] = await Promise.all([service.lookup(boarding), service.busSheet(boarding)]);
  assert.equal(live, null);
  assert.equal(sheet, null);
  assert.deepEqual(records, ['seoul-bus:failed', 'tago-bus:failed']);
  // A later pass is a new pass.
  await service.busSheet(boarding);
  assert.equal(records.length, 4);
});

// ---- Station access: a bridge at a subway alighting starts after that station's exit. ----
test('a bridge from a subway alighting counts the station exit on the ride side, not the bridge side', () => {
  const origin = place('출발', 37.55),
    boarding = place('서울역', 37.56),
    alighting = place('종로3가', 37.59),
    destination = place('도착', 37.6);
  const exitSeconds = 150,
    egressSeconds = 900,
    accessSeconds = 600,
    entrySeconds = 20,
    waitSeconds = 120,
    rideSeconds = 700;
  const source = base('rail', [
    leg('access', 'walk', origin, boarding, accessSeconds),
    leg('a-entry-0', 'entry', boarding, boarding, entrySeconds),
    leg('a-wait-0-expected-wait', 'wait', boarding, boarding, waitSeconds, {
      expectedWaitBasisSeconds: waitSeconds,
    }),
    leg('ride', 'subway', boarding, alighting, rideSeconds, {
      lineName: '1호선',
      transit: { lines: ['1호선'], stops: ['서울역', '시청', '종로3가'] },
    }),
    leg('a-exit-0', 'entry', alighting, alighting, exitSeconds),
    leg('egress', 'walk', alighting, destination, egressSeconds),
  ]);
  const request = {
    origin,
    destination,
    preferences: { ...DEFAULT_PREFERENCES, allowScooter: true },
  };
  const pairs = transferBridgePairs(request, [source], NOW);
  const stationName = (value: Place) => value.name === '종로3가역';
  const out = pairs.find((pair) => stationName(pair.from) && pair.to.id === destination.id)!;
  const into = pairs.find((pair) => pair.from.id === origin.id && stationName(pair.to))!;
  assert.ok(out && into, 'both halves at the alighting station are explored');
  const last = metersBetween(alighting, destination),
    first = metersBetween(origin, alighting);
  // Leaving the station is part of the ride: the bridge from the street replaces only the egress walk.
  assert.equal(out.possibleSaving, egressSeconds - (last / 3.6 + 150));
  assert.equal(
    into.possibleSaving,
    accessSeconds + entrySeconds + waitSeconds + rideSeconds + exitSeconds - (first / 3.6 + 150),
  );
});
