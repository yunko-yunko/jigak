// Door-to-door timing of shared rentals (user rule 2026-11-01): hire 30 s + return 30 s, realistic ride
// speeds, and a few metres between a return spot and its destination walked as a step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PedestrianRouter } from '../src/common/engine/connectivity/pedestrian.js';
import { CallBudget } from '../src/common/engine/call-budget.js';
import type { RouteEndpoints } from '../src/common/engine/kakao.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import { VEHICLE_TYPES } from '../src/common/engine/simulation/assumptions.js';
import {
  ebikeRoutesFromBicycle,
  scooterRoutesFromBicycle,
} from '../src/common/engine/simulation/scooter-router.js';
import { DEMO_TEMPLATES } from '../src/common/shared/domain/fixtures.js';
import type { BaseRoute } from '../src/common/shared/domain/types.js';

const NOW = Date.UTC(2026, 10, 1, 13, 45);
const place = (id: string, latitude: number, longitude: number) => ({
  id,
  name: id,
  address: '',
  latitude,
  longitude,
});
type Coordinate = [number, number];
const at = ([longitude, latitude]: Coordinate) => ({ latitude, longitude });
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** An OSRM foot answer along `path` ([longitude, latitude]), at 1.38 m/s. */
function osrm(path: Coordinate[], snapped: [number, number]) {
  const legs = path.slice(1).map((to, index) => {
    const from = path[index];
    const distance = Math.ceil(metersBetween(at(from), at(to)) * 10) / 10;
    return { from, to, distance, duration: Math.ceil((distance / 1.38) * 10) / 10 };
  });
  const distance = legs.reduce((sum, leg) => sum + leg.distance, 0);
  const duration = legs.reduce((sum, leg) => sum + leg.duration, 0);
  return {
    code: 'Ok',
    data_version: '2026-10-14T00:00:00Z',
    waypoints: [
      { distance: snapped[0], location: path[0], name: '' },
      { distance: snapped[1], location: path.at(-1), name: '' },
    ],
    routes: [
      {
        distance,
        duration,
        geometry: { type: 'LineString', coordinates: path },
        legs: [
          {
            distance,
            duration,
            steps: [
              ...legs.map((leg, index) => ({
                mode: 'walking',
                name: '한강대로',
                distance: leg.distance,
                duration: leg.duration,
                geometry: { type: 'LineString', coordinates: [leg.from, leg.to] },
                maneuver: { type: index ? 'turn' : 'depart', location: leg.from },
              })),
              {
                mode: 'walking',
                name: '',
                distance: 0,
                duration: 0,
                geometry: { type: 'LineString', coordinates: [path.at(-1), path.at(-1)] },
                maneuver: { type: 'arrive', location: path.at(-1) },
              },
            ],
          },
        ],
      },
    ],
  };
}
const router = (body: unknown) =>
  new PedestrianRouter({
    now: () => NOW,
    throttle: async () => {},
    fetcher: async () => reply(body),
  });

// 숙대입구역 4호선: the e-bike return spot is 3 m from the station point, yet the foot network put the two
// on the two parallel sidewalks of 한강대로 and walked 37 m up one and back down the other (live, 2026-11-01).
const RETURN_SPOT = place('반납 지점', 37.544592, 126.972152);
const STATION = place('숙대입구역 4호선', 37.5445952, 126.9721181);

test('a return spot a few metres from the destination is walked as a step, not a U-turn along both sidewalks', async () => {
  const request: RouteEndpoints = { origin: RETURN_SPOT, destination: STATION };
  const uTurn = osrm(
    [
      [126.972209, 37.544602],
      [126.972124, 37.544908],
      [126.97206, 37.544595],
    ],
    [5.1, 5.1],
  );
  const [walk, ...rest] = await router(uTurn).walking(request, new CallBudget());
  const straight = metersBetween(RETURN_SPOT, STATION);
  assert.ok(straight < 4, `the two points are ${straight.toFixed(1)} m apart`);
  assert.equal(rest.length, 0);
  assert.equal(walk.segments.length, 1);
  const [segment] = walk.segments;
  assert.equal(segment.mode, 'walk');
  assert.equal(segment.distanceMeters, Math.ceil(straight));
  assert.deepEqual(segment.durationSeconds, { min: Math.ceil(straight), max: Math.ceil(straight) });
  assert.deepEqual(walk.durationSeconds, segment.durationSeconds);
  assert.deepEqual(segment.polyline, [
    at([RETURN_SPOT.longitude, RETURN_SPOT.latitude]),
    at([STATION.longitude, STATION.latitude]),
  ]);
  assert.deepEqual(segment.networkSnap, { startMeters: 0, endMeters: 0, allowanceSeconds: 0 });
  assert.equal(segment.maneuvers, undefined, 'the U-turn maneuvers are not kept');
  assert.equal(segment.start.name, RETURN_SPOT.name);
  assert.equal(segment.end.name, STATION.name);
});

test('a short walk the network routes directly, and a longer one that detours, keep the network route', async () => {
  const direct = osrm(
    [
      [126.972152, 37.544592],
      [126.9721181, 37.5445952],
    ],
    [0, 0],
  );
  const [kept] = await router(direct).walking(
    { origin: RETURN_SPOT, destination: STATION },
    new CallBudget(),
  );
  assert.doesNotMatch(kept.id, /-step$/);
  // 40 m apart across a road: the detour to a crossing is real, so it is not shortened.
  const across = place('길 건너', 37.544592 + 40 / 111_195, 126.972152);
  const crossing = osrm(
    [
      [126.972152, 37.544592],
      [126.97275, 37.544592],
      [126.97275, across.latitude],
      [126.972152, across.latitude],
    ],
    [0, 0],
  );
  const [detour] = await router(crossing).walking(
    { origin: RETURN_SPOT, destination: across },
    new CallBudget(),
  );
  assert.doesNotMatch(detour.id, /-step$/);
  assert.ok(detour.distanceMeters > 100);
});

test('every shared rental takes one minute to hire and return: 30 s each for scooters and e-bikes', () => {
  for (const type of VEHICLE_TYPES) {
    assert.deepEqual(type.policy, { hireSeconds: 30, returnSeconds: 30 }, type.name);
  }
  const bicycles = DEMO_TEMPLATES.flatMap((template) =>
    template.bicycle ? [template.bicycle] : [],
  );
  assert.ok(bicycles.length);
  for (const bicycle of bicycles) {
    assert.deepEqual(bicycle.hireSeconds, { min: 30, max: 30 });
    assert.deepEqual(bicycle.returnSeconds, { min: 30, max: 30 });
  }
});

/** A bicycle-network route of `meters` straight north, as the bicycle router returns it. */
function bicycleRoute(meters: number): BaseRoute {
  const start = place('start', 37.5427559, 126.9671853);
  const end = place('end', start.latitude + meters / 111_195, start.longitude);
  return {
    id: 'osrm-bike',
    title: '자전거망으로 이동',
    distanceMeters: meters,
    durationSeconds: { min: 0, max: 0 },
    transfers: 0,
    provenance: {
      mode: 'live',
      provider: 'osrm',
      label: 'OSRM',
      sourceTimestamp: null,
      receivedAt: NOW,
      isRealtime: false,
    },
    segments: [
      {
        id: 'osrm-bike-bicycle',
        mode: 'bicycle',
        title: 'end까지 자전거',
        instructions: '',
        distanceMeters: meters,
        durationSeconds: { min: 0, max: 0 },
        start,
        end,
        runAllowed: false,
        polyline: [at([start.longitude, start.latitude]), at([end.longitude, end.latitude])],
      },
    ],
  } as BaseRoute;
}
const fiveSignals = {
  loadedNear: () => ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
};

test('선린→숙대 by e-bike: 713 m past five signals rides in about 3 minutes, at most 4', () => {
  const route = bicycleRoute(713);
  const request = { origin: route.segments[0].start, destination: route.segments[0].end };
  const [ride] = ebikeRoutesFromBicycle([route], request, fiveSignals);
  const { min, max } = ride.segments[0].durationSeconds;
  const typical = (min + max) / 2;
  assert.ok(max <= 240, `upper bound ${max} s must not exceed 4 minutes`);
  assert.ok(typical >= 150 && typical <= 200, `typical ${typical} s`);
  // Typical speed with the signal waits: 13–17 km/h, a short urban PAS ride.
  const kmh = 713 / typical / (1000 / 3600);
  assert.ok(kmh >= 13 && kmh <= 17, `typical ${kmh.toFixed(1)} km/h`);
  // Door to door with a device at the gate: ride plus one minute of hire and return, about 4 minutes.
  assert.ok(typical + 60 <= 4.5 * 60);
});

test('a kick-scooter on the same ride is a little slower than an e-bike, both well under a walk', () => {
  const route = bicycleRoute(713);
  const request = { origin: route.segments[0].start, destination: route.segments[0].end };
  const [ebike] = ebikeRoutesFromBicycle([route], request, fiveSignals);
  const [scooter] = scooterRoutesFromBicycle([route], request, fiveSignals);
  const middle = (r: BaseRoute) => (r.durationSeconds.min + r.durationSeconds.max) / 2;
  assert.ok(middle(scooter) > middle(ebike));
  assert.ok(scooter.durationSeconds.max <= 4.5 * 60);
  assert.ok(middle(scooter) < 713 / 1.38 / 2);
});
