// School building entrances as door points (§20.1, quality FIXPLAN B2, 2026-11-02): no shared
// vehicle stands at a door inside 초·중·고 grounds, so riders and crews use the school's gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOOR_CATEGORY_NAMES,
  DOOR_FLAG,
  bundledDoorPoints,
  parseDoorPoints,
} from '../src/common/engine/simulation/door-points.js';

const KINDS = ['residential', 'school', 'university'];
const CATEGORY = Object.fromEntries(DOOR_CATEGORY_NAMES.map((name, index) => [name, index]));
/** A door `north` metres up the 126.97° meridian. */
const door = (north: number, area: number, cat: string, w: number, flags = 0) => ({
  lat: 37.55 + north / 111_195,
  lon: 126.97,
  area,
  cat: CATEGORY[cat],
  w,
  flags,
});
function file(doors: ReturnType<typeof door>[], areaKinds: number[]) {
  return {
    version: 'shared-mobility-door-points-v1',
    builtAt: 1,
    meta: { kinds: KINDS },
    areas: { lat: areaKinds.map(() => 37.55), kind: areaKinds },
    points: {
      lat: doors.map((item) => item.lat),
      lon: doors.map((item) => item.lon),
      cat: doors.map((item) => item.cat),
      area: doors.map((item) => item.area),
      w: doors.map((item) => item.w),
      flags: doors.map((item) => item.flags),
    },
  };
}

test('a school entrance folds into the nearest open gate of its school, which takes its weight', () => {
  const doors = parseDoorPoints(
    file(
      [
        door(0, 0, 'entrance', 300),
        door(100, 0, 'gate', 10),
        door(40, 0, 'gate', 10, DOOR_FLAG.RESTRICTED),
        door(-150, 0, 'exit', 20),
        door(500, 1, 'entrance', 50),
      ],
      [1, 0],
    ),
  );
  assert.equal(doors.meta.points, 4);
  assert.equal(doors.meta.foldedSchoolEntrances, 1);
  assert.deepEqual(
    [...doors.category].map((value) => DOOR_CATEGORY_NAMES[value]),
    ['gate', 'gate', 'exit', 'entrance'],
    'the residential entrance stays',
  );
  assert.deepEqual([...doors.weight], [310, 10, 20, 50], 'the gate 100 m away, not the closed one');
});

test('a school with no gate folds its entrance into an edge point, or drops it', () => {
  const edge = parseDoorPoints(
    file([door(0, 0, 'entrance', 300), door(60, 0, 'inferred', 5)], [1]),
  );
  assert.deepEqual([...edge.weight], [305]);
  assert.equal(DOOR_CATEGORY_NAMES[edge.category[0]], 'inferred');
  const none = parseDoorPoints(
    file([door(0, 0, 'entrance', 300), door(200, 1, 'entrance', 40)], [1, 0]),
  );
  assert.equal(none.meta.points, 1);
  assert.equal(none.meta.foldedSchoolEntrances, 1);
  assert.deepEqual([...none.weight], [40]);
});

test('university entrances stay, and a file without area kinds is read as it is', () => {
  const university = parseDoorPoints(
    file([door(0, 0, 'entrance', 300), door(100, 0, 'gate', 10)], [2]),
  );
  assert.equal(university.meta.points, 2);
  assert.equal(university.meta.foldedSchoolEntrances, 0);
  const plain = file([door(0, 0, 'entrance', 300), door(100, 0, 'gate', 10)], [1]);
  delete (plain as { meta?: unknown }).meta;
  assert.equal(parseDoorPoints(plain).meta.points, 2);
});

test('no door point of the bundled file stands at a school building entrance', () => {
  const doors = bundledDoorPoints();
  assert.ok(doors.meta.foldedSchoolEntrances > 200, `${doors.meta.foldedSchoolEntrances} folded`);
  // 선린인터넷고's two building entrances are gone; its exit 109 m away (shared with 선린중) stays.
  const near = (latitude: number, longitude: number, meters: number) =>
    [...Array(doors.meta.points).keys()].filter(
      (index) =>
        Math.hypot(
          (doors.points[index * 2] - latitude) * 111_195,
          (doors.points[index * 2 + 1] - longitude) * 88_100,
        ) <= meters,
    );
  assert.deepEqual(near(37.54268, 126.96705, 40), []);
  assert.equal(near(37.541933, 126.966253, 1).length, 2);
});
