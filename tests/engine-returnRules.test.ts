// The no-return rule table, door points and the legal return spot (docs §20, CONTRACT3 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { bundledDemand } from '../src/common/engine/simulation/demand.js';
import { parseDoorPoints } from '../src/common/engine/simulation/door-points.js';
import { computeModelVersion } from '../src/common/engine/simulation/model-version.js';
import {
  bundledParkingRules,
  metersApart,
  ParkingRules,
  parseParkingRules,
  Placement,
} from '../src/common/engine/simulation/parking-rules.js';
import { Stream } from '../src/common/engine/simulation/keyed-random.js';
import {
  bundledReturnRules,
  RETURN,
  ReturnRules,
  scanReturnRules,
} from '../src/common/engine/simulation/return-rules.js';
import { VTYPE } from '../src/common/engine/simulation/sim-codes.js';

/** 숙대입구역 area: real 따릉이 docks lie within the 700 m service area. */
const BASE = { latitude: 37.5446, longitude: 126.9721 };
const COS = Math.cos((37.55 * Math.PI) / 180);
const at = (north: number, east: number): [number, number] => [
  BASE.latitude + north / 111_195,
  BASE.longitude + east / (111_195 * COS),
];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The builder's codec: zig-zag integers in 5-bit groups, least significant first. */
const pack = (values: number[]) =>
  values
    .map((value) => {
      let z = value >= 0 ? value * 2 : -value * 2 - 1,
        text = '';
      for (;;) {
        const group = z % 32;
        z = Math.floor(z / 32);
        if (z) text += ALPHABET[group | 32];
        else return text + ALPHABET[group];
      }
    })
    .join('');

/** One layer of features, each a list of rings of [north, east] metres from BASE. */
function layer(kind: 'line' | 'polygon' | 'point', features: [number, number][][][], r?: number[]) {
  const xy: number[] = [],
    len: number[] = [],
    hole: number[] = [];
  let firstLat = 0,
    firstLon = 0;
  for (const rings of features)
    rings.forEach((ring, index) => {
      let previous: [number, number] | null = null;
      for (const point of ring) {
        const [lat, lon] = at(...point).map((value) => Math.round(value * 1e6));
        if (!previous) {
          xy.push(lat - firstLat, lon - firstLon);
          firstLat = lat;
          firstLon = lon;
        } else xy.push(lat - previous[0], lon - previous[1]);
        previous = [lat, lon];
      }
      len.push(ring.length);
      hole.push(index ? 1 : 0);
    });
  return {
    kind,
    q: 6,
    n: features.length,
    xy: pack(xy),
    ...(kind === 'point' ? {} : { len: pack(len) }),
    ...(r ? { r: pack(r) } : {}),
    ...(hole.some(Boolean) ? { hole: pack(hole) } : {}),
  };
}

const square = (south: number, north: number, west: number, east: number) => [
  [
    [south, west],
    [south, east],
    [north, east],
    [north, west],
  ] as [number, number][],
];
const BOTH = ['kick-scooter', 'e-bike'];
const FILE = {
  version: 'shared-mobility-return-rules-v1',
  builtAt: 1,
  meta: {
    codec: { alphabet: ALPHABET },
    rules: [
      { id: 'R02', effect: 'no-return', appliesTo: BOTH, layers: ['roadway'], bufferM: 0 },
      {
        id: 'R05',
        effect: 'no-return',
        appliesTo: BOTH,
        layers: [],
        official: ['busStops'],
        radiusM: 10,
      },
      { id: 'R18', effect: 'discouraged', appliesTo: BOTH, layers: ['corner'], radiusM: 5 },
      {
        id: 'R24',
        effect: 'no-return',
        appliesTo: BOTH,
        layers: ['apartment'],
        bufferM: 0,
        exceptNearDoors: true,
      },
      { id: 'R26', effect: 'no-return', appliesTo: ['kick-scooter'], layers: ['park'], bufferM: 0 },
      { id: 'R27', effect: 'discouraged', appliesTo: ['e-bike'], layers: ['park'], bufferM: 0 },
      { id: 'R99', effect: 'unknown-effect', appliesTo: BOTH, layers: ['roadway'], radiusM: 50 },
    ],
  },
  layers: {
    // A street along BASE, 8 m wide (half-width 40 dm).
    roadway: layer(
      'line',
      [
        [
          [
            [0, -200],
            [0, 200],
          ],
        ],
      ],
      [40],
    ),
    corner: layer('point', [[[[20, 50]]]]),
    apartment: layer('polygon', [square(30, 80, -40, 40)]),
    park: layer('polygon', [square(-110, -30, -60, 60)]),
  },
};
const rules = new ParkingRules(
  parseParkingRules({
    version: 'seoul-pm-parking-rules-v1',
    builtAt: 1,
    busStops: [at(10, -150)],
    subwayExits: [at(500, 500)],
    crosswalks: [at(-500, -500)],
  }),
  bundledDemand(),
  {
    returns: new ReturnRules(FILE),
    doors: parseDoorPoints({
      version: 'shared-mobility-door-points-v1',
      builtAt: 1,
      areas: { lat: [0] },
      points: { lat: [at(30, 0)[0]], lon: [at(30, 0)[1]], cat: [1], w: [100], flags: [0] },
    }),
  },
);
const effect = (type: number, north: number, east: number) =>
  rules.returnEffect(type, ...at(north, east));
const ruleId = () => rules.returns.rules[rules.returnRule]?.id;

test('the rule table decides each spot per vehicle type: roadway, corner, complex, park', () => {
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    assert.equal(effect(type, 0, 0), RETURN.NO_RETURN);
    assert.equal(ruleId(), 'R02');
    assert.equal(effect(type, 3.9, 0), RETURN.NO_RETURN, 'inside the half-width');
    assert.equal(effect(type, 6, 0), RETURN.CLEAN, 'the kerb beyond it');
    assert.equal(effect(type, 22, 50), RETURN.DISCOURAGED, 'an intersection corner');
    assert.equal(ruleId(), 'R18');
    assert.equal(effect(type, 60, 0), RETURN.NO_RETURN, 'inside an apartment complex');
    assert.equal(ruleId(), 'R24');
    assert.equal(effect(type, 35, 0), RETURN.CLEAN, 'by the complex gate');
  }
  assert.equal(effect(VTYPE.SCOOTER, -50, 0), RETURN.NO_RETURN, 'a city park, for a scooter');
  assert.equal(effect(VTYPE.EBIKE, -50, 0), RETURN.DISCOURAGED, 'a city park, for an e-bike');
  // An effect the table does not know (R99) is ignored, not guessed.
  assert.equal(effect(VTYPE.EBIKE, 20, 0), RETURN.CLEAN);
});

test('official layers use the table radii: a bus stop forbids 10 m', () => {
  assert.equal(effect(VTYPE.EBIKE, 10, -142), RETURN.NO_RETURN);
  assert.equal(ruleId(), 'R05');
  assert.equal(effect(VTYPE.EBIKE, 10, -138), RETURN.CLEAN);
});

test('the legal spot leaves a no-return zone by the shortest way and keeps a clean point', () => {
  const out = new Placement();
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    rules.legalSpot(type, ...at(0, 0), out);
    const moved = metersApart(...at(0, 0), out.latitude, out.longitude);
    assert.ok(moved > 4 && moved <= 6, `off the carriageway by ${moved} m`);
    assert.notEqual(rules.returnEffect(type, out.latitude, out.longitude), RETURN.NO_RETURN);
    assert.equal(out.dockFallback, false);
    rules.legalSpot(type, ...at(6, 120), out);
    assert.ok(metersApart(...at(6, 120), out.latitude, out.longitude) < 0.2, 'stays put');
  }
});

test('a discouraged spot is avoided only when an allowed one is within 30 m', () => {
  const out = new Placement();
  // 20 m inside the park: the edge is 20 m away, closer than the 30 m penalty.
  rules.legalSpot(VTYPE.EBIKE, ...at(-50, 0), out);
  assert.equal(out.discouraged, false);
  assert.ok(metersApart(...at(-50, 0), out.latitude, out.longitude) <= 21.5);
  // In the park's middle, 40 m from any edge: the e-bike stays, discouraged.
  rules.legalSpot(VTYPE.EBIKE, ...at(-70, 0), out);
  assert.equal(out.discouraged, true);
  assert.ok(metersApart(...at(-70, 0), out.latitude, out.longitude) < 0.2);
  // A scooter may not stay in the park at all.
  rules.legalSpot(VTYPE.SCOOTER, ...at(-70, 0), out);
  assert.equal(rules.returnEffect(VTYPE.SCOOTER, out.latitude, out.longitude), RETURN.CLEAN);
  assert.ok(metersApart(...at(-70, 0), out.latitude, out.longitude) >= 39);
});

test('crews keep their reach: a legal spot farther than the limit leaves the vehicle marked', () => {
  const out = new Placement();
  // An e-bike 20 m inside the park (discouraged): the clean edge is beyond 10 m, so it stays.
  rules.properSpotNear(...at(-50, 0), 10, new Stream().reseed(1), out, 0, VTYPE.EBIKE);
  assert.equal(out.dockFallback, true);
  assert.equal(out.noReturn, false);
  assert.ok(metersApart(...at(-50, 0), out.latitude, out.longitude) < 0.01);
  rules.properSpotNear(...at(0, 0), 10, new Stream().reseed(1), out, 0, VTYPE.SCOOTER);
  assert.equal(out.dockFallback, false);
  assert.equal(rules.returnEffect(VTYPE.SCOOTER, out.latitude, out.longitude), RETURN.CLEAN);
});

test('a vehicle on a no-return spot is carried to the legal spot however far', () => {
  const out = new Placement();
  // A scooter 25 m inside a city park (R26): beyond the 10 m reach, but it may not stay.
  rules.properSpotNear(...at(-55, 0), 10, new Stream().reseed(1), out, 0, VTYPE.SCOOTER);
  assert.equal(out.dockFallback, false);
  assert.equal(rules.returnEffect(VTYPE.SCOOTER, out.latitude, out.longitude), RETURN.CLEAN);
  assert.ok(metersApart(...at(-55, 0), out.latitude, out.longitude) > 10);
});

test('door points come from the dock reach, and a door spot is the legal spot of the door', () => {
  const dock = rules.nearestDock(...at(30, 0), 400);
  assert.ok(dock >= 0, 'a 따릉이 dock within 400 m of the fixture door');
  assert.equal(rules.doorNear(dock, new Stream().reseed(7)), 0);
  const cached = rules.doorSpot(VTYPE.EBIKE, 0, new Placement());
  const direct = rules.legalSpot(VTYPE.EBIKE, ...at(30, 0), new Placement());
  assert.deepEqual([cached.latitude, cached.longitude], [direct.latitude, direct.longitude]);
  const again = rules.doorSpot(VTYPE.EBIKE, 0, new Placement());
  assert.deepEqual([again.latitude, again.longitude], [direct.latitude, direct.longitude]);
});

test('the shared return point is null outside the service area', () => {
  assert.equal(rules.legalReturnSpot('e-bike', 37.71, 127.21), null);
  const spot = rules.legalReturnSpot('kick-scooter', ...at(0, 0));
  assert.ok(spot && rules.returnEffect(VTYPE.SCOOTER, spot.latitude, spot.longitude) === 0);
});

test('a missing or malformed rule file leaves no drawn rule', () => {
  for (const raw of [null, { version: 'other' }, { ...FILE, meta: { rules: [] } }]) {
    const empty = new ReturnRules(raw);
    assert.equal(empty.meta.fallback, true);
    assert.equal(empty.effectAt(VTYPE.SCOOTER, ...at(0, 0)), RETURN.CLEAN);
  }
});

test('the byte scanner reads the bundled file exactly as JSON.parse does', async () => {
  const { readFileSync } = await import('node:fs');
  const { dataFile } = await import('../src/common/engine/simulation/calendar.js');
  const bytes = readFileSync(dataFile('shared-mobility-return-rules-v1.json'));
  const scanned = new ReturnRules(scanReturnRules(bytes));
  const parsed = new ReturnRules(JSON.parse(bytes.toString()));
  assert.deepEqual(scanned.meta, parsed.meta);
  assert.equal(scanned.meta.fallback, false);
  for (let index = 0; index < 2_000; index++) {
    const latitude = 37.5 + (index % 50) * 0.0003,
      longitude = 126.95 + Math.floor(index / 50) * 0.0004;
    assert.equal(
      scanned.effectAt(index % 2, latitude, longitude),
      parsed.effectAt(index % 2, latitude, longitude),
    );
  }
});

const real = new ParkingRules(bundledParkingRules(), bundledDemand());

test('bundled rules: a compliant return near real doors never lands in a no-return zone', () => {
  assert.equal(real.returns, bundledReturnRules());
  assert.ok(real.doors.meta.points > 20_000 && real.returns.meta.rules >= 28);
  const out = new Placement();
  let fallbacks = 0;
  for (let door = 0; door < real.doors.meta.points; door += 97)
    for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
      real.legalSpot(type, real.doorLatitude(door), real.doorLongitude(door), out);
      // Dock fallbacks count too: they search for an allowed spot by the docks (§20.3).
      if (out.dockFallback) fallbacks++;
      assert.equal(out.noReturn, false, `door ${door} type ${type}`);
      assert.notEqual(
        real.returnEffect(type, out.latitude, out.longitude),
        RETURN.NO_RETURN,
        `door ${door} type ${type}`,
      );
    }
  assert.ok(fallbacks <= 6, `${fallbacks} dock fallbacks`);
  // 선린인터넷고 main entrance lies inside the school (R22): an e-bike parks just outside it.
  const seollin = real.legalReturnSpot('e-bike', 37.542673, 126.967039)!;
  assert.ok(metersApart(37.542673, 126.967039, seollin.latitude, seollin.longitude) <= 50);
  assert.equal(real.returns.inDoorZone(VTYPE.EBIKE, seollin.latitude, seollin.longitude), false);
});

test('bundled rules: deep inside a complex the return is by its edge, not inside', () => {
  // 대치동부센트레빌: no mapped gate, six inferred edge points; the middle is 100 m from them.
  for (const type of ['kick-scooter', 'e-bike'] as const) {
    const code = type === 'e-bike' ? VTYPE.EBIKE : VTYPE.SCOOTER;
    const spot = real.legalReturnSpot(type, 37.492796, 127.055776)!;
    assert.ok(spot, type);
    assert.equal(spot.dockFallback, false);
    assert.notEqual(real.returnEffect(code, spot.latitude, spot.longitude), RETURN.NO_RETURN);
    assert.ok(metersApart(37.492796, 127.055776, spot.latitude, spot.longitude) < 150);
  }
});

test('bundled rules: by 숙대입구 a kick-scooter rides on to a designated zone that is usable', () => {
  // 용산구 R21: the nearest drawn spot sits inside the subway-exit buffer; the next one is used.
  const spot = real.legalReturnSpot('kick-scooter', 37.5446, 126.9721)!;
  assert.ok(spot && !spot.dockFallback);
  assert.equal(real.returnEffect(VTYPE.SCOOTER, spot.latitude, spot.longitude), RETURN.CLEAN);
  assert.ok(metersApart(37.5446, 126.9721, spot.latitude, spot.longitude) <= 400);
});

/** A complex 300 m across with a gate, an access=no gate and an entrance in its middle. */
const COMPLEX_FILE = {
  ...FILE,
  layers: { ...FILE.layers, apartment: layer('polygon', [square(30, 330, -150, 150)]) },
};
const complex = new ParkingRules(
  parseParkingRules({
    version: 'seoul-pm-parking-rules-v1',
    builtAt: 1,
    busStops: [at(10, -150)],
    subwayExits: [at(500, 500)],
    crosswalks: [at(-500, -500)],
  }),
  bundledDemand(),
  {
    returns: new ReturnRules(COMPLEX_FILE),
    doors: parseDoorPoints({
      version: 'shared-mobility-door-points-v1',
      builtAt: 1,
      areas: { lat: [0] },
      points: {
        lat: [at(30, 0)[0], at(330, 100)[0], at(180, 0)[0]],
        lon: [at(30, 0)[1], at(330, 100)[1], at(180, 0)[1]],
        cat: [1, 1, 0],
        w: [100, 100, 100],
        flags: [0, 2, 0],
      },
    }),
  },
);

test('inside a complex only an open gate allows a return, not an entrance or access=no', () => {
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    assert.equal(complex.gateOpen(type, 0), true, 'the south gate on the edge');
    assert.equal(complex.gateOpen(type, 1), false, 'the access=no gate');
    assert.equal(complex.gateOpen(type, 2), false, 'the building entrance');
    assert.equal(complex.returnEffect(type, ...at(35, 0)), RETURN.CLEAN, 'by the gate');
    assert.equal(complex.returnEffect(type, ...at(182, 0)), RETURN.NO_RETURN, 'by the entrance');
    assert.equal(complex.returnEffect(type, ...at(325, 100)), RETURN.NO_RETURN, 'by access=no');
  }
});

test('a building entrance inside a complex is pushed out by the nearest open gate', () => {
  const out = new Placement();
  for (const type of [VTYPE.SCOOTER, VTYPE.EBIKE]) {
    complex.doorSpot(type, 2, out);
    assert.equal(out.dockFallback, false);
    assert.notEqual(complex.returnEffect(type, out.latitude, out.longitude), RETURN.NO_RETURN);
    assert.ok(metersApart(...at(30, 0), out.latitude, out.longitude) <= 20, 'by the south gate');
  }
});

test('bundled rules: 한강공원 bars kick-scooters but only discourages e-bikes (R25 scooter, R27 e-bike)', async () => {
  const { readFileSync } = await import('node:fs');
  const { dataFile } = await import('../src/common/engine/simulation/calendar.js');
  const file = JSON.parse(
    readFileSync(dataFile('shared-mobility-return-rules-v1.json')).toString(),
  );
  const rule = (id: string) => file.meta.rules.find((entry: { id: string }) => entry.id === id);
  assert.deepEqual(rule('R25').appliesTo, ['kick-scooter']);
  assert.equal(rule('R25').effect, 'no-return');
  assert.deepEqual(rule('R27').appliesTo, ['e-bike']);
  assert.ok(rule('R27').layers.includes('hangang'));
  // Inside 반포한강공원, clear of roads and buildings; no-return outranks discouraged, so R25 must not name e-bikes.
  const rules = bundledReturnRules();
  for (const [latitude, longitude] of [
    [37.5052, 126.9815],
    [37.5052, 126.982],
  ]) {
    assert.equal(rules.effectAt(VTYPE.SCOOTER, latitude, longitude), RETURN.NO_RETURN);
    assert.equal(rules.effectAt(VTYPE.EBIKE, latitude, longitude), RETURN.DISCOURAGED);
  }
});

test('the model version names the rule table and door points', () => {
  const inputs = { demand: bundledDemand(), geometry: bundledParkingRules().meta };
  const base = computeModelVersion(inputs);
  assert.notEqual(computeModelVersion({ ...inputs, tables: ['other', 'tables'] }), base);
  assert.equal(computeModelVersion(inputs), base);
});
