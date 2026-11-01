import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { ebikeConnection, scooterConnection } from '../src/common/engine/scooter-bridge.js';
import {
  capFleets,
  CLOUD_RUN_MAX_FLEET,
  LOW_BATTERY_PERCENT,
  SharedScooterSimulation,
  SIMULATION_PROVIDER,
  serviceDayOf,
  validateFleets,
} from '../src/common/engine/simulation/shared-scooter-sim.js';
import { SimulatedVehicleFeed } from '../src/common/engine/simulation/simulated-vehicle-feed.js';
import { SimulatedScooterPolicy } from '../src/common/engine/simulation/scooter-policy.js';
import {
  ebikeRouting,
  scooterRouting,
  scooterRoutesFromBicycle,
  SIGNAL_DELAY_SECONDS,
  SIGNALS_PER_KM,
} from '../src/common/engine/simulation/scooter-router.js';
import { EVENT_TYPES } from '../src/common/engine/simulation/sim-codes.js';
import {
  FOOT_WEIGHTS_FILE,
  footWeightsIdentity,
} from '../src/common/engine/simulation/foot-traffic.js';
import { withPedestrianRouting } from '../src/common/engine/connectivity/provider.js';
import type { RouteProvider } from '../src/common/engine/kakao.js';
import {
  simulationTypes,
  unknownSimulationTypes,
  validateEnvironment,
} from '../src/common/config/environment.js';
import { healthSnapshot } from '../src/modules/health/domain/health-snapshot.js';
import type { RoutingOptions } from '../src/modules/routing/domain/routing-options.js';
import { RuntimeRepository } from '../src/common/providers/runtime.repository.js';
import { RateLimitService } from '../src/common/http/rate-limit.service.js';
import type { DatabaseService } from '../src/common/database/database.service.js';
import { SimulationController } from '../src/modules/simulation/controller/simulation.controller.js';
import { SimulationService } from '../src/modules/simulation/service/simulation.service.js';
import { SimulationRepository } from '../src/modules/simulation/repository/simulation.repository.js';
import { ApiExceptionFilter } from '../src/common/http/api-exception.filter.js';
import { gbfsDiscoveryBase } from '../src/modules/simulation/domain/gbfs-feed.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type Place,
} from '../src/common/shared/domain/index.js';
import { validLiveVehicles } from '../src/common/shared/domain/vehicleConstraints.js';

// Tuesday 3 November 2026 and Saturday 7 November 2026, KST.
const WEEKDAY_NOON = Date.parse('2026-11-03T12:00:00+09:00');
const WEEKEND_NOON = Date.parse('2026-11-07T12:00:00+09:00');
// Tests keep the measured 6,000-scooter fleet; the default is Seoul's real fleet (§21).
const simulation = new SharedScooterSimulation({ builder: 'inline', cacheSize: 4, fleet: 6_000 });
const GANGNAM = { latitude: 37.4979, longitude: 127.0276 };

test('service days start at 04:00 KST and count Korean holidays as weekend days', () => {
  const day = serviceDayOf(Date.parse('2026-11-04T03:59:59+09:00'));
  assert.equal(day.date, '2026-11-03');
  assert.equal(day.startsAt, Date.parse('2026-11-03T04:00:00+09:00'));
  assert.equal(day.endsAt - day.startsAt, 86_400_000);
  assert.equal(serviceDayOf(WEEKDAY_NOON).dayType, 'weekday');
  assert.equal(serviceDayOf(WEEKEND_NOON).dayType, 'weekend');
  // 3 June 2026 (local election day) was a Wednesday holiday.
  assert.equal(serviceDayOf(Date.parse('2026-06-03T12:00:00+09:00')).dayType, 'weekend');
  assert.throws(() => serviceDayOf(Number.NaN), RangeError);
});

test('vehicles move and rides accumulate through the day', () => {
  const morning = Date.parse('2026-11-03T08:00:00+09:00'),
    later = morning + 3_600_000;
  const before = simulation.vehicles(morning),
    after = simulation.vehicles(later);
  const moved = before.filter(
    (vehicle, index) =>
      vehicle.latitude !== after[index].latitude || vehicle.longitude !== after[index].longitude,
  ).length;
  assert.ok(moved > 500, `${moved} vehicles moved during the 08:00 peak`);
  const first = simulation.status(morning),
    second = simulation.status(later);
  assert.ok(first.ready && second.ready);
  assert.ok(second.ridesToday > first.ridesToday);
  assert.equal(second.ridesInProgress, second.inUse);
  assert.equal(second.lowBattery, second.states['low-battery'] + second.states['battery-dead']);
});

test('hours 00–03 follow their own calendar date: Friday night rides like a weekend', () => {
  const lateRides = (date: string) => {
    const day = serviceDayOf(Date.parse(`${date}T12:00:00+09:00`));
    const events = simulation.window(day.startsAt)!.data.events;
    const rent = EVENT_TYPES.indexOf('rent');
    let count = 0;
    for (let index = 0; index < events.t.length; index++)
      if (events.type[index] === rent && events.t[index] >= day.endsAt - 4 * 3_600_000) count++;
    return count;
  };
  // Thursday's night is a weekday's; Friday's belongs to Saturday, a weekend date. §22 hour
  // weights lift weekday nights too (00–03: 5.7% of a weekday, 9.2% of a weekend day).
  assert.ok(lateRides('2026-11-06') > lateRides('2026-11-05') * 1.1);
});

test('no pile of rentable vehicles: two at most share a metre, twelve at most a 15 m spot (§22, D6)', () => {
  for (const hhmm of ['19:30', '23:00']) {
    const time = Date.parse(`2026-11-03T${hhmm}:00+09:00`);
    const parked = simulation.vehicles(time).filter((vehicle) => vehicle.rentable);
    // Vehicles bucketed on a 15 m grid; neighbours are in the nine buckets around.
    const cell = (value: number, size: number) => Math.floor(value / size);
    const buckets = new Map<string, typeof parked>();
    const keyOf = (row: number, col: number) => `${row}:${col}`;
    const rowOf = (latitude: number) => cell(latitude * 111_195, 15);
    const colOf = (longitude: number) => cell(longitude * 111_195 * 0.7928, 15);
    for (const vehicle of parked) {
      const key = keyOf(rowOf(vehicle.latitude), colOf(vehicle.longitude));
      buckets.set(key, [...(buckets.get(key) ?? []), vehicle]);
    }
    let same = 0,
      within15 = 0;
    for (const vehicle of parked) {
      let one = 0,
        fifteen = 0;
      const row = rowOf(vehicle.latitude),
        col = colOf(vehicle.longitude);
      for (let r = row - 1; r <= row + 1; r++)
        for (let c = col - 1; c <= col + 1; c++)
          for (const other of buckets.get(keyOf(r, c)) ?? []) {
            const meters = metersBetween(vehicle, other);
            if (meters <= 1) one++;
            if (meters <= 15) fifteen++;
          }
      same = Math.max(same, one);
      within15 = Math.max(within15, fifteen);
    }
    assert.ok(same <= 2, `${same} rentable vehicles within 1 m at ${hhmm}`);
    assert.ok(within15 <= 12, `${within15} rentable vehicles within 15 m at ${hhmm}`);
  }
});

const destinationFrom = (from: { latitude: number; longitude: number }, north = 0.01): Place => ({
  id: 'destination',
  name: '도착',
  address: '',
  latitude: from.latitude + north,
  longitude: from.longitude,
});

test('the policy permits a rentable simulated vehicle and refuses riding, hidden, out-of-range or foreign ones', async () => {
  const policy = new SimulatedScooterPolicy(simulation);
  const vehicles = simulation.vehicles(WEEKDAY_NOON);
  const parkedFor = (id: string) => (simulation.parkedUntil(id, WEEKDAY_NOON) ?? 0) - WEEKDAY_NOON;
  const parked = vehicles.find(
    (vehicle) => vehicle.rentable && vehicle.battery >= 60 && parkedFor(vehicle.id) > 600_000,
  )!;
  // Taken again sooner than a hire and a return take (75 s for a scooter).
  const leaving = vehicles.find((vehicle) => vehicle.rentable && parkedFor(vehicle.id) < 60_000)!;
  const riding = vehicles.find((vehicle) => vehicle.state === 'in-use')!;
  const weak = vehicles.find((vehicle) => vehicle.rentable && vehicle.battery < 25)!;
  const unrentable = vehicles.find((vehicle) => vehicle.field && !vehicle.rentable)!;
  const ask = (id: string, provider = SIMULATION_PROVIDER, destination = destinationFrom(parked)) =>
    policy.verify({
      vehicle: {
        id,
        provider,
        latitude: parked.latitude,
        longitude: parked.longitude,
        battery: 80,
        distanceMeters: 0,
        source: 'gbfs',
      },
      origin: destination,
      destination,
      now: WEEKDAY_NOON,
    });
  const permission = await ask(parked.id);
  assert.equal(permission?.provider, 'jigak-sim');
  assert.equal(permission?.verifiedAt, WEEKDAY_NOON);
  assert.equal(permission?.provenance?.simulated, true);
  assert.equal(permission?.provenance?.label, '시연용 가상 킥보드');
  assert.equal(permission?.provenance?.modelVersion, simulation.modelVersion);
  assert.equal(policy.modelVersion, simulation.modelVersion);
  // Nothing is reserved: the permission ends at the vehicle's next simulated change.
  assert.equal(
    permission?.validUntil,
    Math.min(WEEKDAY_NOON + 3_600_000, simulation.parkedUntil(parked.id, WEEKDAY_NOON)!),
  );
  assert.equal(await ask(riding.id), null);
  assert.equal(await ask(unrentable.id), null, `${unrentable.state} is not rentable`);
  assert.equal(await ask(leaving.id), null, 'a rider takes it before a rental could start');
  assert.equal(await ask('JS99999'), null);
  assert.equal(await ask(parked.id, 'GBIKE'), null, 'real operators are never answered');
  // The charge must cover the ride: straight line × 1.3 × 1.1.
  const far = destinationFrom(weak, (weak.rangeMeters / 111_195) * 0.9);
  assert.equal(await ask(weak.id, SIMULATION_PROVIDER, far), null, 'out of range');
});

test('a permitted vehicle stays where it is until the permission ends, never past 04:00', async () => {
  const policy = new SimulatedScooterPolicy(simulation);
  for (const now of [
    Date.parse('2026-11-03T08:00:00+09:00'),
    Date.parse('2026-11-03T18:10:00+09:00'),
    Date.parse('2026-11-04T03:30:00+09:00'),
  ]) {
    const parked = simulation
      .vehicles(now)
      .filter((vehicle) => vehicle.rentable)
      .slice(0, 300);
    let permitted = 0;
    for (const vehicle of parked) {
      const permission = await policy.verify({
        vehicle: { ...vehicle, provider: SIMULATION_PROVIDER, distanceMeters: 0, source: 'gbfs' },
        origin: { ...vehicle, id: 'o', name: 'o', address: '' },
        destination: { ...vehicle, id: 'd', name: 'd', address: '' },
        now,
      });
      if (!permission) continue;
      permitted++;
      // It outlasts the unlock and the return (30 s + 30 s, user rule 2026-11-01).
      assert.ok(
        permission.validUntil - now >= (permission.hireSeconds + permission.returnSeconds) * 1000,
      );
      assert.ok(permission.validUntil <= serviceDayOf(now).endsAt, 'never past 04:00');
      const later = simulation.vehicle(vehicle.id, permission.validUntil - 1)!;
      assert.ok(later.rentable, `${vehicle.id} is taken before its permission ends`);
      assert.deepEqual([later.latitude, later.longitude], [vehicle.latitude, vehicle.longitude]);
    }
    assert.ok(permitted > 200, `${permitted} of ${parked.length} permitted`);
  }
});

test('rentable vehicles always carry a usable battery', () => {
  for (const time of [
    Date.parse('2026-11-04T03:59:59+09:00'),
    Date.parse('2026-11-08T03:59:59+09:00'),
  ])
    for (const vehicle of simulation.vehicles(time))
      if (vehicle.rentable) assert.ok(vehicle.battery >= LOW_BATTERY_PERCENT, vehicle.id);
});

test('the next window is computed from 05:00 KST, not by the first request after 04:00', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = Date.parse('2026-11-04T04:30:00+09:00');
  const asked: string[] = [];
  const stub = Object.create(SharedScooterSimulation.prototype) as SharedScooterSimulation;
  stub.ensure = async (time: number) => {
    asked.push(serviceDayOf(time).date);
    return null as never;
  };
  const stop = stub.start(() => now);
  assert.deepEqual(asked, ['2026-11-04'], 'today right away');
  now += 29 * 60_000;
  t.mock.timers.tick(29 * 60_000);
  assert.deepEqual(asked, ['2026-11-04']);
  now += 60_000;
  t.mock.timers.tick(60_000);
  assert.deepEqual(asked, ['2026-11-04', '2026-11-05'], 'tomorrow from 05:00');
  now += 86_400_000;
  t.mock.timers.tick(86_400_000);
  assert.deepEqual(asked, ['2026-11-04', '2026-11-05', '2026-11-06']);
  stop();
});

const bicycleRoute = (request: { origin: Place; destination: Place }): BaseRoute => {
  const distanceMeters = Math.round(metersBetween(request.origin, request.destination));
  return {
    id: 'osrm-bike-fixture',
    title: '자전거망으로 이동',
    distanceMeters,
    durationSeconds: { min: 999, max: 999 },
    transfers: 0,
    landingUrl: 'https://map.kakao.com/bicycle',
    segments: [
      {
        id: 'osrm-bike-fixture-bicycle',
        mode: 'bicycle',
        routingProfile: 'bicycle',
        title: '자전거',
        instructions: '자전거',
        distanceMeters,
        durationSeconds: { min: 999, max: 999 },
        start: request.origin,
        end: request.destination,
        runAllowed: false,
        polyline: [request.origin, request.destination],
        routingSource: {
          mode: 'live',
          provider: 'osrm-bike',
          label: 'OpenStreetMap',
          sourceTimestamp: null,
          receivedAt: WEEKDAY_NOON,
          isRealtime: false,
        },
      },
    ],
  };
};

test('the scooter router re-times a bicycle ride at 14–20 km/h plus signal waits', async () => {
  const origin: Place = { id: 'a', name: 'A', address: '', ...GANGNAM };
  const destination: Place = {
    id: 'b',
    name: '역삼',
    address: '',
    latitude: GANGNAM.latitude + 0.018,
    longitude: GANGNAM.longitude,
  };
  const [route] = await scooterRouting.scooter(
    async (request) => [bicycleRoute(request)],
    { origin, destination },
    new CallBudget(2),
  );
  const meters = route.segments[0].distanceMeters;
  assert.equal(route.segments.length, 1);
  assert.equal(route.segments[0].mode, 'scooter');
  // No intersection list: the measured signals per km wait 5–20 s each.
  const signals = (meters / 1000) * SIGNALS_PER_KM;
  assert.deepEqual(route.segments[0].durationSeconds, {
    min: Math.ceil(meters / (20 / 3.6) + signals * SIGNAL_DELAY_SECONDS.lower),
    max: Math.ceil(meters / (14 / 3.6) + signals * SIGNAL_DELAY_SECONDS.upper),
  });
  assert.equal(route.landingUrl, undefined);
  const walked = bicycleRoute({ origin, destination });
  walked.segments[0] = { ...walked.segments[0], mode: 'walk' };
  assert.deepEqual(scooterRoutesFromBicycle([walked], { origin, destination }), []);
});

const stubProvider = (configured: boolean): RouteProvider => ({
  configured,
  searchPlaces: async () => [],
  transit: async () => [],
  walking: async () => [],
  bicycle: async (request) => [bicycleRoute(request)],
});

test('health reports scooter routing only while the simulator is on', () => {
  const base = {
    provider: stubProvider(true),
    mobility: new MobilityFeeds(),
    realtime: { capabilities: { subway: false, bus: false }, diagnostics: [] },
    traffic: { configured: false },
    weather: { configured: false },
    parking: { configured: false },
    now: () => WEEKDAY_NOON,
  } as unknown as RoutingOptions;
  assert.equal(healthSnapshot(base).capabilities.scooterRouting, false);
  const enabled = {
    ...base,
    mobility: new MobilityFeeds({ vehicleFeeds: [new SimulatedVehicleFeed(simulation)] }),
    scooterSimulation: simulation,
    scooterPolicy: new SimulatedScooterPolicy(simulation),
    scooterRouting,
  } as RoutingOptions;
  const health = healthSnapshot(enabled).capabilities;
  assert.equal(health.scooterRouting, true);
  assert.equal(health.sharedScooter, true);
  assert.equal(health.sharedBicycle, false, 'simulated scooters are not public bicycles');
});

test('markers are rentable, visible simulated vehicles only, labelled as simulated', async () => {
  const mobility = new MobilityFeeds({
    vehicleFeeds: [new SimulatedVehicleFeed(simulation, { now: () => WEEKDAY_NOON })],
    now: () => WEEKDAY_NOON,
  });
  const snapshot = await mobility.snapshot(GANGNAM, 1_500);
  assert.ok(snapshot.markers.length > 5);
  for (const marker of snapshot.markers) {
    assert.equal(marker.simulated, true);
    assert.equal(marker.available, true);
    assert.equal(marker.provider, '시연용 가상 킥보드');
    assert.match(marker.id, /^gbfs:jigak-sim:JS\d{5}$/);
    const vehicle = simulation.vehicle(marker.sourceId, WEEKDAY_NOON)!;
    assert.equal(vehicle.rentable, true, `${vehicle.id} is ${vehicle.state}`);
    assert.equal(vehicle.hidden, false);
  }
  // Street vehicles that cannot be rented never become markers.
  const field = simulation.nearby(GANGNAM, 1_500, WEEKDAY_NOON, 'field');
  assert.ok(field.length > snapshot.markers.length);
  const [status] = snapshot.sources.filter((source) => source.source === 'gbfs');
  assert.match(status.message, /시연용 가상 데이터/);
});

test('a scooter rental on a simulated vehicle carries simulated provenance and the model version', async () => {
  const vehicle = simulation
    .nearby(GANGNAM, 1_500, WEEKDAY_NOON)
    .find(
      (candidate) =>
        candidate.battery >= 40 &&
        (simulation.parkedUntil(candidate.id, WEEKDAY_NOON) ?? 0) > WEEKDAY_NOON + 1_800_000,
    )!;
  const from: Place = {
    id: 'origin',
    name: '출발',
    address: '',
    latitude: vehicle.latitude + 60 / 111_195,
    longitude: vehicle.longitude,
  };
  const to: Place = destinationFrom(vehicle, 0.02);
  const straight = (origin: Place, destination: Place): BaseRoute => {
    const distanceMeters = Math.round(metersBetween(origin, destination));
    const seconds = Math.ceil(distanceMeters / 1.2);
    return {
      id: 'walk',
      title: 'walk',
      distanceMeters,
      durationSeconds: { min: seconds, max: seconds },
      transfers: 0,
      segments: [
        {
          id: 'walk',
          mode: 'walk',
          title: 'walk',
          instructions: 'walk',
          distanceMeters,
          durationSeconds: { min: seconds, max: seconds },
          start: origin,
          end: destination,
          runAllowed: false,
          polyline: [origin, destination],
        },
      ],
    };
  };
  const provider = withPedestrianRouting(
    {
      ...stubProvider(true),
      walking: async (request, budget) =>
        budget.run(() => [straight(request.origin, request.destination)]),
      bicycle: async (request, budget) => budget.run(() => [bicycleRoute(request)]),
    },
    undefined,
    { scooter: scooterRouting },
  );
  const context = (
    policy:
      SimulatedScooterPolicy | { modelVersion: string; verify: SimulatedScooterPolicy['verify'] },
  ) => ({
    now: WEEKDAY_NOON,
    budget: new CallBudget(10),
    provider,
    mobility: new MobilityFeeds({
      vehicleFeeds: [new SimulatedVehicleFeed(simulation, { now: () => WEEKDAY_NOON })],
      now: () => WEEKDAY_NOON,
    }),
    scooterPolicy: policy,
  });
  const policy = new SimulatedScooterPolicy(simulation);
  const preferences = { ...DEFAULT_PREFERENCES, allowScooter: true };
  const segments = await scooterConnection(context(policy), preferences, from, to, 'sim');
  assert.ok(segments, 'a simulated scooter near the origin is rentable');
  const rental = segments.filter((segment) => ['hire', 'scooter', 'return'].includes(segment.mode));
  assert.deepEqual(
    rental.map((segment) => segment.mode),
    ['hire', 'scooter', 'return'],
  );
  for (const segment of rental) {
    assert.equal(segment.routingSource?.provider, 'jigak-sim');
    assert.equal(segment.routingSource?.simulated, true);
    assert.equal(segment.routingSource?.modelVersion, simulation.modelVersion);
  }
  assert.equal(rental[0].title, '시연용 가상 킥보드 대여');
  assert.equal(rental[0].costWon, 1000);
  assert.ok(validLiveVehicles(segments, preferences, from, WEEKDAY_NOON));
  // A permission computed by another model version is never used (§11.1).
  const stale = {
    modelVersion: 'another-rev',
    verify: (input: Parameters<SimulatedScooterPolicy['verify']>[0]) => policy.verify(input),
  };
  assert.equal(await scooterConnection(context(stale), preferences, from, to, 'sim'), null);
});

test('MOBILITY_SIMULATION=scooter alone keeps the scooter-only simulator and its defaults', () => {
  const env = (extra: NodeJS.ProcessEnv) => validateEnvironment({ DB_PASSWORD: 'test', ...extra });
  assert.equal(env({}).scooterSimulation, false);
  assert.equal(env({ MOBILITY_SIMULATION: 'bike' }).scooterSimulation, false);
  const enabled = env({
    MOBILITY_SIMULATION: 'scooter',
    MOBILITY_SIMULATION_FLEET: '',
    MOBILITY_SIMULATION_SEED: '',
  });
  assert.equal(enabled.scooterSimulation, true);
  // Seoul's registered kick-scooters (2025, §21).
  assert.equal(enabled.MOBILITY_SIMULATION_FLEET, 14_933);
  assert.equal(enabled.MOBILITY_SIMULATION_SEED, 'jigak');
  assert.throws(() => env({ MOBILITY_SIMULATION_FLEET: '2000' }), 'too few to reach most riders');
  assert.throws(() => env({ MOBILITY_SIMULATION_FLEET: '80000' }));
  assert.throws(() => new SharedScooterSimulation({ fleet: 2_000 }), RangeError);
});

async function simulationApp(options: Partial<RoutingOptions>) {
  const module = await Test.createTestingModule({
    controllers: [SimulationController],
    providers: [
      SimulationService,
      SimulationRepository,
      { provide: RuntimeRepository, useValue: { options } },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');
  return { app, url: (await app.getUrl()) + '/api/sim' };
}

const ROUTES = [
  '/status',
  '/events',
  '/crews',
  '/gbfs/gbfs.json',
  '/gbfs/system_information.json',
  '/gbfs/vehicle_types.json',
  '/gbfs/vehicle_status.json',
];

test('the simulator API answers 404 on every route while off', async () => {
  const { app, url } = await simulationApp({});
  try {
    for (const path of ROUTES) {
      const response = await fetch(url + path);
      assert.equal(response.status, 404, path);
      assert.equal(
        (await response.json()).error.message,
        '시연용 가상 킥보드·전기자전거가 꺼져 있어요.',
      );
    }
  } finally {
    await app.close();
  }
});

test('the simulator API serves status, GBFS v3.0 feeds with vehicle state, events and crews', async () => {
  const { app, url } = await simulationApp({
    scooterSimulation: simulation,
    now: () => WEEKDAY_NOON,
  });
  try {
    for (const path of ROUTES) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
    }
    const status = await (await fetch(url + '/status')).json();
    assert.deepEqual(status, simulation.status(WEEKDAY_NOON));
    assert.equal(status.notice, '시연용 가상 데이터');
    assert.equal(status.ready, true);
    assert.equal(status.modelVersion, simulation.modelVersion);
    assert.equal(
      Object.values(status.states as Record<string, number>).reduce((a, b) => a + b, 0),
      simulation.fleet,
    );
    assert.equal(status.rentable, status.states.available - status.parking.hiddenAvailable);
    assert.ok(status.today.rides > 0 && status.crews.onShift.van > 0);
    assert.equal(status.geometry.subwayExits, 2014);

    const system = await (await fetch(url + '/gbfs/system_information.json')).json();
    assert.equal(system.data.name[0].text, '지각지도 시연용 가상 킥보드 (실제 운영사 아님)');
    assert.equal(system.data.model_version, simulation.modelVersion);
    const types = await (await fetch(url + '/gbfs/vehicle_types.json')).json();
    assert.equal(types.data.vehicle_types[0].max_range_meters, 30_000);

    const all = await (await fetch(url + '/gbfs/vehicle_status.json')).json();
    assert.equal(all.ready, true);
    // The full feed lists every street vehicle (§15.4): GBFS has no paging.
    const s = status.states;
    const street =
      status.rentable +
      s.reserved +
      s['low-battery'] +
      s['battery-dead'] +
      s.broken +
      s['out-of-area'];
    assert.equal(all.data.vehicles.length, street);
    assert.equal(all.total, street);
    assert.equal(all.truncated, false);
    assert.ok(street > 2_000);
    const near = await (
      await fetch(
        `${url}/gbfs/vehicle_status.json?lat=${GANGNAM.latitude}&lon=${GANGNAM.longitude}&radius=1500`,
      )
    ).json();
    assert.ok(near.data.vehicles.length > 0);
    const seen = new Set<string>();
    for (const listed of near.data.vehicles) {
      assert.ok(metersBetween(GANGNAM, { latitude: listed.lat, longitude: listed.lon }) <= 1_501);
      const vehicle = simulation.vehicle(listed.vehicle_id, WEEKDAY_NOON)!;
      seen.add(vehicle.state);
      assert.ok(vehicle.field, `${vehicle.state} is listed`);
      assert.equal(listed.is_reserved, vehicle.state === 'reserved');
      assert.equal(listed.is_disabled, !['available', 'reserved'].includes(vehicle.state));
      assert.equal(listed.current_fuel_percent, vehicle.battery / 100);
      assert.equal(listed.current_range_meters, vehicle.rangeMeters);
      const reported = Date.parse(listed.last_reported);
      assert.ok(reported <= WEEKDAY_NOON && reported >= WEEKDAY_NOON - 150_000);
    }
    assert.ok(seen.has('available'));
    assert.equal((await fetch(`${url}/gbfs/vehicle_status.json?radius=500`)).status, 400);

    const crews = await (await fetch(url + '/crews')).json();
    assert.equal(crews.notice, '시연용 가상 데이터');
    assert.equal(crews.depots.length, 5);
    assert.equal(crews.lots.length, 4);
    for (const crew of crews.crews) {
      assert.equal(crew.simulated, true);
      assert.match(crew.id, /^(VAN|SWAP|PATROL)-[A-E]-\d{2}$/);
      if (crew.state === 'off')
        assert.equal(crew.latitude, undefined, 'off-shift crews have no position');
      else assert.ok(Number.isFinite(crew.latitude));
      if (crew.type === 'van' && crew.state !== 'off') assert.ok(crew.load <= crew.capacity);
      if (crew.type === 'swap' && crew.state !== 'off')
        assert.ok(crew.batteries.charged + crew.batteries.depleted <= crew.batteries.slots);
    }
    assert.ok(crews.crews.some((crew: { state: string }) => crew.state === 'travelling'));
  } finally {
    await app.close();
  }
});

test('events: validated queries, time order, exclusive since, gap-free cursors and the seam flag', async () => {
  const now = Date.parse('2026-11-03T09:00:00+09:00');
  const day = serviceDayOf(now);
  const { app, url } = await simulationApp({ scooterSimulation: simulation, now: () => now });
  try {
    for (const bad of [
      'limit=0',
      'limit=501',
      'types=rent,teleport',
      'lat=37.5',
      'radius=100',
      `since=1&cursor=${day.date}:000001`,
      'cursor=nope',
      'extra=1',
    ])
      assert.equal((await fetch(`${url}/events?${bad}`)).status, 400, bad);

    const first = await (await fetch(`${url}/events?limit=500`)).json();
    assert.equal(first.notice, '시연용 가상 데이터');
    assert.equal(first.events.length, 500);
    let previous = -Infinity;
    for (const event of first.events) {
      assert.ok(event.at >= previous && event.at > day.startsAt - 1 && event.at <= now);
      assert.ok(EVENT_TYPES.includes(event.type));
      assert.equal(event.simulated, true);
      previous = event.at;
    }
    // Paging with cursors neither skips nor repeats.
    const paged = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query: string = cursor ? `cursor=${cursor}&limit=100` : 'limit=100';
      const body = await (await fetch(`${url}/events?${query}`)).json();
      paged.push(...body.events);
      cursor = body.next;
    }
    assert.deepEqual(
      paged.map((event) => event.id),
      first.events.map((event: { id: string }) => event.id),
    );
    // `since` is exclusive.
    const since = first.events[10].at;
    const after = await (await fetch(`${url}/events?since=${since}&limit=5`)).json();
    assert.ok(after.events.every((event: { at: number }) => event.at > since));
    // A filter that matches nothing still moves the cursor forward.
    const rare = await (await fetch(`${url}/events?types=commission&limit=1`)).json();
    if (rare.events.length === 0) assert.equal(rare.next, null);
    const filtered = await (
      await fetch(
        `${url}/events?types=rent,ride-end&lat=${GANGNAM.latitude}&lon=${GANGNAM.longitude}&radius=800&limit=50`,
      )
    ).json();
    for (const event of filtered.events) {
      assert.ok(['rent', 'ride-end'].includes(event.type));
      assert.ok(metersBetween(GANGNAM, event) <= 801);
    }
    if (filtered.next) {
      const next = await (
        await fetch(`${url}/events?types=rent,ride-end&cursor=${filtered.next}&limit=1`)
      ).json();
      assert.ok(
        next.events.every((event: { at: number }) => event.at >= filtered.events.at(-1).at),
      );
    }
    // Money events say who pays whom.
    const fares = await (await fetch(`${url}/events?types=ride-end&limit=3`)).json();
    for (const event of fares.events) {
      assert.equal(event.amountWon, event.detail.fareWon);
      assert.deepEqual(event.ledger, { payer: 'rider', payee: 'operator', item: 'fare' });
    }
    // Before the window's start there is a seam: those events belong to the previous window.
    const seam = await (
      await fetch(`${url}/events?since=${day.startsAt - 3_600_000}&limit=1`)
    ).json();
    assert.equal(seam.seam, true);
    assert.equal(seam.windowStartsAt, day.startsAt);
    const lost = await (await fetch(`${url}/events?types=lost-demand&limit=5`)).json();
    for (const event of lost.events) {
      assert.equal(event.vehicleId, undefined);
      assert.ok(
        ['none-in-reach', 'no-range', 'not-found', 'unlock-gave-up'].includes(event.detail.reason),
      );
    }
  } finally {
    await app.close();
  }
});

test('while the window is still computed: status says not ready, the rest is empty, the policy declines', async () => {
  const fresh = new SharedScooterSimulation({ fleet: 6_000 });
  const now = Date.parse('2026-11-10T12:00:00+09:00');
  try {
    const status = fresh.status(now);
    assert.equal(status.ready, false);
    assert.equal(status.notice, '시연용 가상 데이터');
    assert.equal(status.modelVersion, simulation.modelVersion);
    assert.deepEqual(fresh.vehicles(now), []);
    assert.deepEqual(fresh.nearby(GANGNAM, 1_000, now), []);
    assert.equal(fresh.events({ limit: 10 }, now).events.length, 0);
    assert.deepEqual(fresh.crews(now).crews, []);
    assert.deepEqual(fresh.fieldVehicles(now), { ready: false, vehicles: [] });
    const permission = await new SimulatedScooterPolicy(fresh).verify({
      vehicle: {
        id: 'JS00001',
        provider: SIMULATION_PROVIDER,
        latitude: 37.5,
        longitude: 127,
        battery: 90,
        distanceMeters: 0,
        source: 'gbfs',
      },
      origin: destinationFrom(GANGNAM),
      destination: destinationFrom(GANGNAM),
      now,
    });
    assert.equal(permission, null);
    await fresh.ensure(now);
    assert.equal(fresh.status(now).ready, true);
  } finally {
    await fresh.close();
  }
});

test('the public request limit covers every simulator route', async () => {
  let consulted = 0;
  const database = {
    transaction: async () => {
      consulted++;
      return { count: 1, expiresAt: Date.now() + 60_000 };
    },
    getRepository: () => ({ delete: async () => undefined }),
  } as unknown as DatabaseService;
  const limiter = new RateLimitService(database);
  for (const path of [
    '/api/sim/status',
    '/api/sim/events',
    '/api/sim/crews',
    '/api/sim/gbfs/vehicle_status.json',
  ]) {
    let passed = false;
    await limiter.consume(
      { path, method: 'GET', ip: '127.0.0.1' } as Request,
      { setHeader: () => undefined } as unknown as Response,
      (() => (passed = true)) as NextFunction,
    );
    assert.ok(passed, path);
  }
  assert.equal(consulted, 4, 'each simulator route is counted');
});

test('GBFS discovery lists HTTPS feed URLs behind a TLS-terminating proxy', () => {
  const path = '/api/sim/gbfs/gbfs.json?x=1';
  assert.equal(
    gbfsDiscoveryBase('http://jigak-abc.a.run.app', path, 'https://api.jigak.example'),
    'https://api.jigak.example/api/sim/gbfs',
  );
  assert.equal(
    gbfsDiscoveryBase('http://127.0.0.1:8788', path, 'http://localhost:8080'),
    'http://127.0.0.1:8788/api/sim/gbfs',
    'a local plain-HTTP address is not a public base',
  );
});

// ---- Kick-scooters and shared e-bikes in one simulator (§19) ----

const MIXED = { scooter: 4_000, ebike: 8_000 };
const mixed = new SharedScooterSimulation({ builder: 'inline', cacheSize: 2, fleets: MIXED });
const YONGSAN = { latitude: 37.5428, longitude: 126.9672 };

test('MOBILITY_SIMULATION is a comma list of scooter and ebike with per-type fleets', () => {
  const env = (extra: NodeJS.ProcessEnv) => validateEnvironment({ DB_PASSWORD: 'test', ...extra });
  assert.deepEqual(simulationTypes(' Scooter , E-BIKE '), { scooter: true, ebike: true });
  assert.deepEqual(simulationTypes('ebike'), { scooter: false, ebike: true });
  assert.deepEqual(simulationTypes('bike,kick'), { scooter: false, ebike: false });
  // Unknown names are reported (once, at startup) and turn nothing on.
  assert.deepEqual(unknownSimulationTypes(' Scooter , E-BIKE '), []);
  assert.deepEqual(unknownSimulationTypes('scooter, Bike,bike,,kick'), ['Bike', 'bike', 'kick']);
  assert.deepEqual(env({ MOBILITY_SIMULATION: 'scooter,bike' }).simulationUnknownTypes, ['bike']);
  assert.deepEqual(env({ MOBILITY_SIMULATION: 'scooter,bike' }).simulationFleets, {
    scooter: 14_933,
    ebike: 0,
  });
  assert.deepEqual(env({}).simulationUnknownTypes, []);
  assert.equal(env({}).simulationFleets, null);
  assert.equal(env({ MOBILITY_SIMULATION: 'bike' }).simulationFleets, null);
  assert.deepEqual(env({ MOBILITY_SIMULATION: 'scooter' }).simulationFleets, {
    scooter: 14_933,
    ebike: 0,
  });
  const both = env({
    MOBILITY_SIMULATION: 'scooter,ebike',
    MOBILITY_SIMULATION_FLEET: '',
    MOBILITY_SIMULATION_EBIKE_FLEET: '',
  });
  // Mixed defaults: Seoul's registered fleet, 14,933 + 52,605 (§19.2, §21).
  assert.deepEqual(both.simulationFleets, { scooter: 14_933, ebike: 52_605 });
  assert.equal(both.scooterSimulation && both.ebikeSimulation, true);
  assert.deepEqual(
    env({ MOBILITY_SIMULATION: 'e-bike', MOBILITY_SIMULATION_EBIKE_FLEET: '5000' })
      .simulationFleets,
    { scooter: 0, ebike: 5000 },
  );
  assert.deepEqual(
    env({ MOBILITY_SIMULATION: 'ebike,scooter', MOBILITY_SIMULATION_FLEET: '3000' })
      .simulationFleets,
    { scooter: 3000, ebike: 52_605 },
  );
  assert.throws(() => env({ MOBILITY_SIMULATION_EBIKE_FLEET: '500' }));
  assert.throws(
    () => env({ MOBILITY_SIMULATION: 'ebike', MOBILITY_SIMULATION_EBIKE_FLEET: '2000' }),
    'e-bikes alone need the same 3,000 floor',
  );
  assert.throws(
    () =>
      env({
        MOBILITY_SIMULATION: 'scooter,ebike',
        MOBILITY_SIMULATION_FLEET: '20000',
        MOBILITY_SIMULATION_EBIKE_FLEET: '60000',
      }),
    /합계는 72000대 이하여야 합니다/,
  );
  assert.throws(() => env({ MOBILITY_SIMULATION_EBIKE_FLEET: '60001' }));
  assert.throws(() => validateFleets({ scooter: 2_000, ebike: 8_000 }), RangeError);
  assert.throws(() => validateFleets({ scooter: 0, ebike: 2_000 }), RangeError);
  assert.throws(() => new SharedScooterSimulation({ fleets: { scooter: 4_000, ebike: 500 } }));
  // Cloud Run caps both types together and keeps each type's minimum.
  assert.deepEqual(capFleets(MIXED, 12_000), MIXED);
  // The real-size default (14,933 + 52,605, §21) runs whole on Cloud Run; nothing is cut.
  assert.equal(CLOUD_RUN_MAX_FLEET, 72_000);
  assert.deepEqual(capFleets({ scooter: 14_933, ebike: 52_605 }, CLOUD_RUN_MAX_FLEET), {
    scooter: 14_933,
    ebike: 52_605,
  });
  assert.deepEqual(capFleets({ scooter: 6_000, ebike: 24_000 }, 24_000), {
    scooter: 4_800,
    ebike: 19_200,
  });
  assert.deepEqual(capFleets({ scooter: 6_000, ebike: 12_000 }, 12_000), {
    scooter: 4_000,
    ebike: 8_000,
  });
  assert.deepEqual(capFleets({ scooter: 29_000, ebike: 1_000 }, 12_000), {
    scooter: 11_000,
    ebike: 1_000,
  });
  assert.deepEqual(capFleets({ scooter: 20_000, ebike: 0 }, 12_000), { scooter: 12_000, ebike: 0 });
});

test('mixed status: totals stay, byType adds up to them, e-bikes report their own day', () => {
  const status = mixed.status(WEEKDAY_NOON);
  assert.ok(status.ready);
  assert.equal(status.fleet, 12_000);
  assert.deepEqual(status.fleetByType, { 'kick-scooter': 4_000, 'e-bike': 8_000 });
  const types = Object.values(status.byType);
  assert.equal(types.length, 2);
  const sum = (pick: (type: (typeof types)[number]) => number) =>
    types.reduce((total, type) => total + pick(type), 0);
  assert.equal(status.byType['kick-scooter']!.fleet, 4_000);
  assert.equal(status.byType['e-bike']!.fleet, 8_000);
  assert.equal(
    sum((type) => type.rentable),
    status.rentable,
  );
  assert.equal(
    sum((type) => type.inUse),
    status.inUse,
  );
  assert.equal(
    sum((type) => type.parking.improper),
    status.parking.improper,
  );
  for (const state of Object.keys(status.states) as (keyof typeof status.states)[])
    assert.equal(
      sum((type) => type.states[state]),
      status.states[state],
      state,
    );
  for (const key of ['rides', 'swaps', 'collections', 'complaints', 'tows'] as const)
    assert.equal(
      sum((type) => type.today[key]),
      status.today[key],
      key,
    );
  assert.equal(
    sum((type) => type.today.fines.sumWon),
    status.today.fines.sumWon,
  );
  assert.equal(
    sum((type) => type.today.money.rideRevenue),
    status.today.money.rideRevenue,
  );
  assert.equal(
    sum((type) => type.today.faults.total),
    status.today.faults.total,
  );
  // Lost demand: per type, the riders who wanted only that type; the rest wanted either.
  const lost = status.today.lostDemand as { total: number; byWanted?: Record<string, number> };
  assert.equal(
    lost.byWanted!['kick-scooter'] + lost.byWanted!['e-bike'] + lost.byWanted!.either,
    lost.total,
  );
  assert.equal(status.byType['e-bike']!.lostDemandToday, lost.byWanted!['e-bike']);
  // E-bike riders are never fined for a helmet, a licence or a second rider (§19, R §1).
  const ebike = status.byType['e-bike']!.today as Record<string, unknown> & {
    fines: { byKind: Record<string, number> };
    faults: { byType: Record<string, number> };
  };
  for (const kind of ['helmet', 'unlicensed', 'two-riders'])
    assert.equal(ebike.fines.byKind[kind], 0, kind);
  assert.ok(typeof ebike.assistCutoffs === 'number' && typeof ebike.operatorNotices === 'number');
  assert.ok(
    'chain-drivetrain' in ebike.faults.byType && !('throttle-motor' in ebike.faults.byType),
  );
  assert.equal(
    status.today.faults.byType['chain-drivetrain'],
    ebike.faults.byType['chain-drivetrain'],
  );
  // A scooter-only simulator keeps its old status and lists one type.
  const scooters = simulation.status(WEEKDAY_NOON);
  assert.ok(scooters.ready);
  assert.deepEqual(Object.keys(scooters.byType), ['kick-scooter']);
  assert.equal(scooters.byType['kick-scooter']!.today.rides, scooters.today.rides);
  assert.equal('byWanted' in scooters.today.lostDemand, false);
  assert.equal('assistCutoffs' in scooters.today, false);
});

test('mixed crews and depots show per-type loads within their unit capacities', () => {
  const crews = mixed.crews(Date.parse('2026-11-03T15:00:00+09:00'));
  assert.ok(crews.ready);
  let vans = 0;
  for (const crew of crews.crews as Record<string, any>[]) {
    if (crew.state === 'off') continue;
    if (crew.type === 'van') {
      vans++;
      assert.equal(crew.loadByType['kick-scooter'] + crew.loadByType['e-bike'], crew.load);
      assert.equal(crew.loadUnits, crew.loadByType['kick-scooter'] + 2 * crew.loadByType['e-bike']);
      assert.ok(crew.loadUnits <= crew.capacity, `${crew.id} carries ${crew.loadUnits} places`);
    }
    if (crew.type === 'swap') {
      const { byType, charged, depleted, slotUnits, slots } = crew.batteries;
      assert.equal(byType['kick-scooter'].charged + byType['e-bike'].charged, charged);
      assert.equal(byType['kick-scooter'].depleted + byType['e-bike'].depleted, depleted);
      assert.ok(slotUnits <= slots, `${crew.id} uses ${slotUnits} of ${slots} slots`);
    }
  }
  assert.ok(vans > 0);
  for (const depot of crews.depots as Record<string, any>[]) {
    for (const key of ['ready', 'charging', 'repair', 'chargedBatteries', 'waitingBatteries'])
      assert.equal(
        depot.byType['kick-scooter'][key] + depot.byType['e-bike'][key],
        depot[key],
        `${depot.id} ${key}`,
      );
    assert.ok(depot.storedUnits >= depot.ready + depot.charging + depot.repair);
  }
});

test('mixed markers carry both kinds with their own labels; capabilities and health see e-bikes', async () => {
  const feed = new SimulatedVehicleFeed(mixed, { now: () => WEEKDAY_NOON });
  assert.deepEqual(feed.kinds, ['kick-scooter', 'e-bicycle']);
  assert.deepEqual(new SimulatedVehicleFeed(simulation).kinds, ['kick-scooter']);
  const mobility = new MobilityFeeds({ vehicleFeeds: [feed], now: () => WEEKDAY_NOON });
  const snapshot = await mobility.snapshot(YONGSAN, 1_000);
  const kinds = new Set(snapshot.markers.map((marker) => marker.kind));
  assert.ok(kinds.has('kick-scooter') && kinds.has('e-bicycle'), [...kinds].join());
  for (const marker of snapshot.markers) {
    const vehicle = mixed.vehicle(marker.sourceId, WEEKDAY_NOON)!;
    assert.equal(vehicle.rentable, true);
    if (marker.kind === 'e-bicycle') {
      assert.match(marker.id, /^gbfs:jigak-sim:JB\d{5}$/);
      assert.equal(vehicle.type, 'e-bike');
      assert.equal(marker.provider, '시연용 가상 전기자전거');
    } else {
      assert.match(marker.id, /^gbfs:jigak-sim:JS\d{5}$/);
      assert.equal(vehicle.type, 'kick-scooter');
      assert.equal(marker.provider, '시연용 가상 킥보드');
    }
  }
  assert.match(
    snapshot.sources.find((source) => source.source === 'gbfs')!.message,
    /가상 킥보드·전기자전거/,
  );
  assert.deepEqual(mobility.capabilities, {
    sharedScooter: true,
    sharedBicycle: false,
    sharedEbike: true,
  });
  const policy = new SimulatedScooterPolicy(mixed);
  const health = healthSnapshot({
    provider: stubProvider(true),
    mobility,
    realtime: { capabilities: { subway: false, bus: false }, diagnostics: [] },
    traffic: { configured: false },
    weather: { configured: false },
    parking: { configured: false },
    now: () => WEEKDAY_NOON,
    scooterSimulation: mixed,
    scooterPolicy: policy,
    scooterRouting,
    ebikePolicy: policy,
    ebikeRouting,
  } as unknown as RoutingOptions);
  assert.equal(health.capabilities.ebikeRouting, true);
  assert.equal(health.capabilities.sharedEbike, true);
  const { startedAt, elapsedMs, ...readiness } = health.simulation as {
    startedAt?: unknown;
    elapsedMs?: unknown;
  };
  assert.ok(typeof startedAt === 'number' && typeof elapsedMs === 'number' && elapsedMs >= 0);
  assert.deepEqual(readiness, {
    enabled: true,
    ready: true,
    serviceDay: '2026-11-03',
    status: 'ready',
    source: 'build',
    windowStore: 'off',
    fleet: 12_000,
    fleetByType: { 'kick-scooter': 4_000, 'e-bike': 8_000 },
    modelVersion: mixed.modelVersion,
    footWeights: { file: FOOT_WEIGHTS_FILE, source: 'shipped', identity: footWeightsIdentity() },
  });
});

test('the policy rents an e-bike only as an e-bike, at 30 s + 30 s and the e-bike tariff', async () => {
  const policy = new SimulatedScooterPolicy(mixed);
  const parked = (type: string, now: number) =>
    mixed
      .nearby(YONGSAN, 3_000, now)
      .find(
        (vehicle) =>
          vehicle.type === type &&
          vehicle.battery >= 60 &&
          (mixed.parkedUntil(vehicle.id, now) ?? 0) > now + 600_000,
      )!;
  const ask = (
    vehicle: { id: string; latitude: number; longitude: number },
    now: number,
    mode?: 'scooter' | 'ebike',
    kind?: 'kick-scooter' | 'e-bicycle',
  ) =>
    policy.verify({
      vehicle: {
        id: vehicle.id,
        provider: SIMULATION_PROVIDER,
        latitude: vehicle.latitude,
        longitude: vehicle.longitude,
        battery: 80,
        distanceMeters: 0,
        source: 'gbfs',
        ...(kind ? { kind } : {}),
      },
      origin: destinationFrom(vehicle, 0),
      destination: destinationFrom(vehicle, 0.01),
      now,
      ...(mode ? { mode } : {}),
    });
  const ebike = parked('e-bike', WEEKDAY_NOON),
    scooter = parked('kick-scooter', WEEKDAY_NOON);
  const permission = await ask(ebike, WEEKDAY_NOON, 'ebike', 'e-bicycle');
  assert.ok(permission, 'a parked e-bike is rentable as an e-bike');
  assert.match(permission.vehicleId, /^JB\d{5}$/);
  assert.equal(permission.hireSeconds, 30);
  assert.equal(permission.returnSeconds, 30, 'unlock + park: one minute a rental');
  assert.equal(permission.unlockFeeWon, 600, 'day unlock (R §4)');
  assert.equal(permission.perMinuteWon, 160);
  assert.equal(permission.provenance?.label, '시연용 가상 전기자전거');
  assert.equal(permission.provenance?.simulated, true);
  // The wrong rental kind or marker kind is refused either way.
  assert.equal(await ask(ebike, WEEKDAY_NOON), null, 'an old scooter-only caller');
  assert.equal(await ask(ebike, WEEKDAY_NOON, 'scooter', 'kick-scooter'), null);
  assert.equal(await ask(ebike, WEEKDAY_NOON, 'ebike', 'kick-scooter'), null);
  assert.equal(await ask(scooter, WEEKDAY_NOON, 'ebike', 'e-bicycle'), null);
  assert.equal(await ask(scooter, WEEKDAY_NOON, 'scooter', 'e-bicycle'), null);
  const rented = await ask(scooter, WEEKDAY_NOON, 'scooter', 'kick-scooter');
  assert.equal(rented?.provenance?.label, '시연용 가상 킥보드');
  assert.deepEqual(
    [rented?.hireSeconds, rented?.returnSeconds, rented?.unlockFeeWon],
    [30, 30, 1000],
  );
  // After midnight the e-bike unlock is the night fare.
  const night = Date.parse('2026-11-04T01:00:00+09:00');
  const late = parked('e-bike', night);
  assert.equal((await ask(late, night, 'ebike'))?.unlockFeeWon, 1_000);
});

test('an e-bike rental on a simulated vehicle rides the bicycle network with its own label', async () => {
  const vehicle = mixed
    .nearby(YONGSAN, 1_500, WEEKDAY_NOON)
    .find(
      (candidate) =>
        candidate.type === 'e-bike' &&
        candidate.battery >= 40 &&
        (mixed.parkedUntil(candidate.id, WEEKDAY_NOON) ?? 0) > WEEKDAY_NOON + 1_800_000,
    )!;
  const from: Place = {
    id: 'origin',
    name: '출발',
    address: '',
    latitude: vehicle.latitude + 30 / 111_195,
    longitude: vehicle.longitude,
  };
  const to = destinationFrom(vehicle, 0.02);
  const walk = (origin: Place, destination: Place): BaseRoute => {
    const distanceMeters = Math.round(metersBetween(origin, destination));
    const seconds = Math.ceil(distanceMeters / 1.2);
    return {
      id: 'walk',
      title: 'walk',
      distanceMeters,
      durationSeconds: { min: seconds, max: seconds },
      transfers: 0,
      segments: [
        {
          id: 'walk',
          mode: 'walk',
          title: 'walk',
          instructions: 'walk',
          distanceMeters,
          durationSeconds: { min: seconds, max: seconds },
          start: origin,
          end: destination,
          runAllowed: false,
          polyline: [origin, destination],
        },
      ],
    };
  };
  const provider = withPedestrianRouting(
    {
      ...stubProvider(true),
      walking: async (request, budget) =>
        budget.run(() => [walk(request.origin, request.destination)]),
      bicycle: async (request, budget) => budget.run(() => [bicycleRoute(request)]),
    },
    undefined,
    { scooter: scooterRouting, ebike: ebikeRouting },
  );
  const policy = new SimulatedScooterPolicy(mixed);
  const segments = await ebikeConnection(
    {
      now: WEEKDAY_NOON,
      budget: new CallBudget(10),
      provider,
      mobility: new MobilityFeeds({
        vehicleFeeds: [new SimulatedVehicleFeed(mixed, { now: () => WEEKDAY_NOON })],
        now: () => WEEKDAY_NOON,
      }),
      scooterPolicy: policy,
      ebikePolicy: policy,
    },
    { ...DEFAULT_PREFERENCES, allowEbike: true },
    from,
    to,
    'sim-ebike',
  );
  assert.ok(segments, 'a simulated e-bike near the origin is rentable');
  const rental = segments.filter((segment) => ['hire', 'ebike', 'return'].includes(segment.mode));
  assert.deepEqual(
    rental.map((segment) => segment.mode),
    ['hire', 'ebike', 'return'],
  );
  assert.match(rental[0].rentalValidity!.vehicleId, /^JB\d{5}$/);
  assert.equal(rental[0].title, '시연용 가상 전기자전거 대여');
  assert.equal(rental[0].durationSeconds.max, 30);
  assert.equal(rental[2].durationSeconds.max, 30);
  for (const segment of rental) {
    assert.equal(segment.routingSource?.simulated, true);
    assert.equal(segment.routingSource?.modelVersion, mixed.modelVersion);
  }
  // The fixture's network is labelled "OpenStreetMap"; the ride keeps it after its own label.
  assert.equal(rental[1].routingSource!.label, '시연용 가상 전기자전거 · OpenStreetMap');
});

test('mixed GBFS feeds list both vehicle types and every street vehicle with its type', async () => {
  const { app, url } = await simulationApp({ scooterSimulation: mixed, now: () => WEEKDAY_NOON });
  try {
    const system = await (await fetch(url + '/gbfs/system_information.json')).json();
    assert.equal(
      system.data.name[0].text,
      '지각지도 시연용 가상 킥보드·전기자전거 (실제 운영사 아님)',
    );
    const types = await (await fetch(url + '/gbfs/vehicle_types.json')).json();
    assert.deepEqual(
      types.data.vehicle_types.map((type: { vehicle_type_id: string }) => type.vehicle_type_id),
      ['sim-kick-scooter', 'sim-e-bike'],
    );
    const ebike = types.data.vehicle_types[1];
    assert.equal(ebike.form_factor, 'bicycle');
    assert.equal(ebike.propulsion_type, 'electric_assist');
    assert.equal(ebike.max_permitted_speed, 25);
    assert.equal(ebike.max_range_meters, 45_000);
    assert.equal(ebike.name[0].text, '시연용 가상 전기자전거');
    const scooterOnly = await simulationApp({
      scooterSimulation: simulation,
      now: () => WEEKDAY_NOON,
    });
    try {
      const only = await (await fetch(scooterOnly.url + '/gbfs/vehicle_types.json')).json();
      assert.deepEqual(
        only.data.vehicle_types.map((type: { vehicle_type_id: string }) => type.vehicle_type_id),
        ['sim-kick-scooter'],
      );
    } finally {
      await scooterOnly.app.close();
    }

    const status = mixed.status(WEEKDAY_NOON);
    assert.ok(status.ready);
    const all = await (await fetch(url + '/gbfs/vehicle_status.json')).json();
    const byType = { 'sim-kick-scooter': 0, 'sim-e-bike': 0 } as Record<string, number>;
    for (const listed of all.data.vehicles) byType[listed.vehicle_type_id]++;
    const street = (type: 'kick-scooter' | 'e-bike') => {
      const own = status.byType[type]!;
      const s = own.states;
      return (
        own.rentable +
        s.reserved +
        s['low-battery'] +
        s['battery-dead'] +
        s.broken +
        s['out-of-area']
      );
    };
    assert.equal(byType['sim-kick-scooter'], street('kick-scooter'));
    assert.equal(byType['sim-e-bike'], street('e-bike'));
    assert.equal(all.total, all.data.vehicles.length);
    assert.equal(all.truncated, false);
    const near = await (
      await fetch(
        `${url}/gbfs/vehicle_status.json?lat=${YONGSAN.latitude}&lon=${YONGSAN.longitude}&radius=1000`,
      )
    ).json();
    for (const listed of near.data.vehicles) {
      const vehicle = mixed.vehicle(listed.vehicle_id, WEEKDAY_NOON)!;
      assert.equal(
        listed.vehicle_type_id,
        vehicle.type === 'e-bike' ? 'sim-e-bike' : 'sim-kick-scooter',
      );
      assert.equal(listed.current_range_meters, vehicle.rangeMeters);
      const reported = Date.parse(listed.last_reported);
      assert.ok(reported <= WEEKDAY_NOON && reported >= WEEKDAY_NOON - 150_000);
    }
    assert.ok(
      near.data.vehicles.some((listed: { vehicle_id: string }) =>
        listed.vehicle_id.startsWith('JB'),
      ),
    );
  } finally {
    await app.close();
  }
});

test('mixed events carry vehicleType and filter by it; lost demand says what the rider wanted', async () => {
  const now = Date.parse('2026-11-03T09:00:00+09:00');
  const { app, url } = await simulationApp({ scooterSimulation: mixed, now: () => now });
  try {
    for (const bad of ['vehicleTypes=bike', 'vehicleTypes=', 'vehicleTypes=e-bike,scooter'])
      assert.equal((await fetch(`${url}/events?${bad}`)).status, 400, bad);
    const all = await (await fetch(`${url}/events?limit=500`)).json();
    const seen = new Set<string>();
    for (const event of all.events) {
      if (event.vehicleId === undefined) {
        assert.equal(event.vehicleType, undefined);
        continue;
      }
      seen.add(event.vehicleType);
      assert.equal(event.vehicleType, event.vehicleId.startsWith('JB') ? 'e-bike' : 'kick-scooter');
    }
    assert.deepEqual([...seen].sort(), ['e-bike', 'kick-scooter']);
    const ebikes = await (await fetch(`${url}/events?vehicleTypes=e-bike&limit=500`)).json();
    assert.ok(ebikes.events.length > 0);
    for (const event of ebikes.events) {
      if (event.type === 'lost-demand') {
        assert.ok(['e-bike', 'either'].includes(event.detail.wanted), event.detail.wanted);
        continue;
      }
      assert.equal(event.vehicleType, 'e-bike', event.type);
    }
    const lost = await (
      await fetch(`${url}/events?types=lost-demand&vehicleTypes=kick-scooter&limit=200`)
    ).json();
    for (const event of lost.events)
      assert.ok(['kick-scooter', 'either'].includes(event.detail.wanted), event.detail.wanted);
    // A scooter-only simulator still names its vehicles' type.
    const { app: only, url: onlyUrl } = await simulationApp({
      scooterSimulation: simulation,
      now: () => now,
    });
    try {
      const rides = await (await fetch(`${onlyUrl}/events?types=rent&limit=5`)).json();
      for (const event of rides.events) assert.equal(event.vehicleType, 'kick-scooter');
      const none = await (await fetch(`${onlyUrl}/events?vehicleTypes=e-bike&limit=5`)).json();
      assert.deepEqual(none.events, []);
    } finally {
      await only.close();
    }
  } finally {
    await app.close();
  }
});

test('a mixed simulator before its window is ready: not ready, both fleets named, nothing rentable', async () => {
  const fresh = new SharedScooterSimulation({ fleets: MIXED });
  const now = Date.parse('2026-11-10T12:00:00+09:00');
  try {
    const status = fresh.status(now);
    assert.equal(status.ready, false);
    assert.equal(status.fleet, 12_000);
    assert.deepEqual(status.fleetByType, { 'kick-scooter': 4_000, 'e-bike': 8_000 });
    assert.equal(fresh.vehicle('JB00001', now), null);
    assert.deepEqual(
      await new SimulatedVehicleFeed(fresh, { now: () => now }).nearby(YONGSAN, 500),
      [],
    );
    const permission = await new SimulatedScooterPolicy(fresh).verify({
      vehicle: {
        id: 'JB00001',
        provider: SIMULATION_PROVIDER,
        latitude: 37.5,
        longitude: 127,
        battery: 90,
        distanceMeters: 0,
        source: 'gbfs',
        kind: 'e-bicycle',
      },
      origin: destinationFrom(GANGNAM),
      destination: destinationFrom(GANGNAM),
      now,
      mode: 'ebike',
    });
    assert.equal(permission, null);
    assert.deepEqual(fresh.events({ limit: 5, vehicleTypes: ['e-bike'] }, now).events, []);
    // Ids are numbered per type; out-of-fleet ids are unknown.
    await fresh.ensure(now);
    assert.equal(fresh.vehicle('JB08000', now)?.type, 'e-bike');
    assert.equal(fresh.vehicle('JS04000', now)?.type, 'kick-scooter');
    assert.equal(fresh.vehicle('JB08001', now), null);
    assert.equal(fresh.vehicle('JS04001', now), null);
  } finally {
    await fresh.close();
  }
});
