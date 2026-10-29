// Preserved regression cases from perception-map/mvp/tests/roadTraffic.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRoadConditions,
  busRoadDelaySeconds,
  LinkIndex,
  trafficAlongPath,
} from '../src/common/engine/realtime/routeTraffic.js';
import { enrichRouteConditions } from '../src/common/engine/realtime/route-conditions.js';
import { parseCityData, RoadTrafficService } from '../src/common/engine/realtime/seoulTraffic.js';
import { SEOUL_TRAFFIC_AREAS } from '../src/common/engine/realtime/seoulAreas.js';
import type {
  BaseRoute,
  BaseSegment,
  Place,
  RoadTrafficLink,
  Route,
} from '../src/common/shared/domain/index.js';

// 2026-10-12 15:00 KST
const NOW = Date.UTC(2026, 9, 12, 6);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
    },
  });

// Shape copied from a live citydata response for 강남역 (POI014); values shortened.
const cityData = (links: Record<string, unknown>[], incidents: Record<string, unknown>[] = []) => ({
  RESULT: {
    'RESULT.CODE': 'INFO-000',
    'RESULT.MESSAGE': '정상 처리되었습니다.',
  },
  CITYDATA: {
    AREA_NM: '강남역',
    AREA_CD: 'POI014',
    ROAD_TRAFFIC_STTS: {
      AVG_ROAD_DATA: {
        ROAD_TRAFFIC_IDX: '정체',
        ROAD_TRAFFIC_SPD: 14,
        ROAD_TRAFFIC_TIME: '2026-10-12 14:55',
      },
      ROAD_TRAFFIC_STTS: links,
    },
    ACDNT_CNTRL_STTS: incidents,
  },
});

const yeoksam = {
  LINK_ID: '1220020700',
  ROAD_NM: '역삼로',
  START_ND_XY: '127.0338334350395542_37.4941595999640853',
  END_ND_XY: '127.0335095296028811_37.4940618362868818',
  DIST: '31.0',
  SPD: 18.5,
  IDX: '서행',
  XYLIST: '127.0335095296028811_37.4940618362868818|127.0338334350395542_37.4941595999640853',
};

// A 620 m stretch of 강남대로 inside the 강남역 area: northbound jammed, southbound flowing.
const area = SEOUL_TRAFFIC_AREAS.find((entry) => entry[0] === 'POI014')!;
const lng = (area[2] + area[4]) / 2,
  south = (area[3] + area[5]) / 2 - 0.0028;

const road = Array.from(
  {
    length: 15,
  },
  (_, index) =>
    [Math.round(lng * 1e5) / 1e5, Math.round((south + index * 0.0004) * 1e5) / 1e5] as [
      number,
      number,
    ],
);

const xy = (points: [number, number][]) => points.map((point) => point.join('_')).join('|');

const northbound = {
  LINK_ID: 'N1',
  ROAD_NM: '강남대로',
  START_ND_XY: road[0].join('_'),
  END_ND_XY: road[14].join('_'),
  SPD: 6,
  IDX: '정체',
  XYLIST: xy(road),
};

const southbound = {
  LINK_ID: 'S1',
  ROAD_NM: '강남대로',
  START_ND_XY: road[14].join('_'),
  END_ND_XY: road[0].join('_'),
  SPD: 38,
  IDX: '원활',
  XYLIST: xy(road),
};

const roadwork = {
  ACDNT_OCCR_DT: '2026-06-03 21:00',
  EXP_CLR_DT: '2026-11-02 07:00',
  ACDNT_TYPE: '공사',
  ACDNT_DTYPE: '도로보수',
  ACDNT_INFO: '강남대로 보행환경 개선공사(차로축소| 보도확장)',
  ACDNT_X: road[7][0],
  ACDNT_Y: road[7][1],
};

const sideStreetCrash = {
  ...roadwork,
  ACDNT_TYPE: '사고',
  ACDNT_DTYPE: '추돌',
  ACDNT_INFO: '이면도로 추돌',
  ACDNT_X: road[7][0] + 0.004,
  ACDNT_Y: road[7][1],
};

const busPath = road.map(([longitude, latitude]) => ({
  latitude,
  longitude,
}));

const links = (...rows: Record<string, unknown>[]): RoadTrafficLink[] =>
  parseCityData(cityData(rows)).links;

test('city data links are oriented along travel, mapped to congestion levels, and bad rows are dropped', () => {
  const parsed = parseCityData(
    cityData(
      [
        yeoksam,
        northbound,
        {
          ...northbound,
          LINK_ID: 'no-level',
          IDX: '정보없음',
        },
        {
          ...northbound,
          LINK_ID: 'one-point',
          XYLIST: road[0].join('_'),
        },
        {
          ...northbound,
          LINK_ID: 'abroad',
          XYLIST: '2.35_48.85|2.36_48.86',
        },
      ],
      [
        roadwork,
        {
          ...roadwork,
          ACDNT_X: 'x',
        },
      ],
    ),
  );

  assert.deepEqual(
    parsed.links.map((link) => [link.id, link.level, link.speedKmh]),
    [
      ['1220020700', 'slow', 19],
      ['N1', 'jam', 6],
    ],
  );
  // XYLIST listed 역삼로 end-first; the path must start at its start node so each direction is told apart.
  assert.deepEqual(parsed.links[0].path, [
    [127.03383, 37.49416],
    [127.03351, 37.49406],
  ]);
  assert.deepEqual(
    parseCityData(cityData([southbound])).links[0].path[0],
    road[14],
    'the southbound link runs north to south',
  );
  assert.equal(parsed.observedAt, Date.UTC(2026, 9, 12, 5, 55));
  assert.deepEqual(
    parsed.incidents.map((incident) => [incident.kind, incident.detail]),
    [['공사 · 도로보수', '강남대로 보행환경 개선공사(차로축소, 보도확장)']],
  );
  assert.throws(
    () =>
      parseCityData({
        'RESULT.CODE': 'ERROR-500',
        'RESULT.MESSAGE': '서버 오류입니다.',
      }),
    /status/,
  );
  assert.throws(
    () =>
      parseCityData({
        RESULT: {
          'RESULT.CODE': 'INFO-100',
        },
      }),
    /auth/,
  );
});

test('a route is matched to the carriageway it travels on, and short unreported gaps are bridged', () => {
  const index = new LinkIndex(links(northbound, southbound));
  const north = trafficAlongPath(busPath, index);

  assert.deepEqual(
    north.spans,
    [
      {
        from: 0,
        to: 14,
        level: 'jam',
      },
    ],
    'the whole northbound path lies on the jammed link',
  );
  assert.ok(Math.abs(north.matchedMeters - north.totalMeters) < 1 && north.totalMeters > 600);
  assert.deepEqual(
    trafficAlongPath([...busPath].reverse(), index).spans,
    [
      {
        from: 0,
        to: 14,
        level: 'free',
      },
    ],
    'the opposite direction reads the other carriageway',
  );

  const sideways = busPath.map((point) => ({
    ...point,
    longitude: point.longitude + 0.0006,
  }));

  assert.equal(
    trafficAlongPath(sideways, index).spans.length,
    0,
    'a parallel street 50 m away is not this road',
  );

  // Links for the first and last third only: the junction gap between them is longer than a bridge.
  const partial = new LinkIndex(
    links(
      {
        ...northbound,
        LINK_ID: 'A',
        XYLIST: xy(road.slice(0, 6)),
        END_ND_XY: road[5].join('_'),
      },
      {
        ...northbound,
        LINK_ID: 'B',
        XYLIST: xy(road.slice(9)),
        START_ND_XY: road[9].join('_'),
      },
    ),
  );

  assert.deepEqual(trafficAlongPath(busPath, partial).spans, [
    {
      from: 0,
      to: 5,
      level: 'jam',
    },
    {
      from: 9,
      to: 14,
      level: 'jam',
    },
  ]);

  // One link stops 33 m short of the junction and the next starts 33 m after it: a single unmatched 44 m edge.
  const stop: [number, number] = [road[6][0], Math.round((road[6][1] - 0.0001) * 1e5) / 1e5],
    restart: [number, number] = [road[7][0], Math.round((road[7][1] + 0.0001) * 1e5) / 1e5];
  const joined = new LinkIndex(
    links(
      {
        ...northbound,
        LINK_ID: 'A',
        XYLIST: xy([...road.slice(0, 6), stop]),
        END_ND_XY: stop.join('_'),
      },
      {
        ...northbound,
        LINK_ID: 'B',
        XYLIST: xy([restart, ...road.slice(8)]),
        START_ND_XY: restart.join('_'),
      },
    ),
  );

  assert.deepEqual(
    trafficAlongPath(busPath, joined).spans,
    [
      {
        from: 0,
        to: 14,
        level: 'jam',
      },
    ],
    'a short gap at a link join takes the congestion before it',
  );
});

test('a bus is delayed only where cars move slower than its own planned pace', () => {
  const jam = trafficAlongPath(busPath, new LinkIndex(links(northbound)));
  // 620 m planned in 150 s (about 15 km/h); cars crawl at 6 km/h, so they need about 220 s more.
  const delay = busRoadDelaySeconds(
    {
      distanceMeters: 620,
      baseSeconds: 150,
    },
    jam,
  );

  assert.equal(
    delay,
    90,
    "half of the cars' extra time, capped at 60% of the leg and rounded to 30 s",
  );
  assert.equal(
    busRoadDelaySeconds(
      {
        distanceMeters: 620,
        baseSeconds: 150,
      },
      trafficAlongPath(
        busPath,
        new LinkIndex(
          links({
            ...northbound,
            SPD: 38,
            IDX: '원활',
          }),
        ),
      ),
    ),
    0,
    'flowing roads give no time back',
  );

  const longPath = [
    ...busPath,
    ...Array.from(
      {
        length: 70,
      },
      (_, index) => ({
        latitude: busPath[14].latitude + (index + 1) * 0.0004,
        longitude: busPath[14].longitude,
      }),
    ),
  ];
  const mostlyUnknown = trafficAlongPath(longPath, new LinkIndex(links(northbound)));

  assert.ok(mostlyUnknown.matchedMeters < mostlyUnknown.totalMeters * 0.25);
  assert.equal(
    busRoadDelaySeconds(
      {
        distanceMeters: 3_700,
        baseSeconds: 900,
      },
      mostlyUnknown,
    ),
    0,
    'one jammed block of a long leg is too little to re-time it',
  );
  assert.equal(
    busRoadDelaySeconds(
      {
        distanceMeters: 0,
        baseSeconds: 0,
      },
      jam,
    ),
    0,
  );
});

const place = (
  id: string,
  at: {
    latitude: number;
    longitude: number;
  },
): Place => ({
  id,
  name: id,
  address: '',
  ...at,
});

const leg = (
  id: string,
  mode: BaseSegment['mode'],
  seconds: number,
  polyline = busPath,
): BaseSegment => ({
  id,
  mode,
  title: id,
  instructions: '',
  distanceMeters: 620,
  durationSeconds: {
    min: seconds,
    max: seconds,
  },
  start: place('a', busPath[0]),
  end: place('b', busPath[14]),
  runAllowed: false,
  polyline,
});

const baseRoute = (id: string, segments: BaseSegment[]): BaseRoute => ({
  id,
  title: id,
  segments,
  transfers: 0,
  durationSeconds: {
    min: segments.reduce((sum, item) => sum + item.durationSeconds.min, 0),
    max: segments.reduce((sum, item) => sum + item.durationSeconds.max, 0),
  },
  distanceMeters: 620,
});

function service(
  calls: string[] = [],
  rows: Record<string, unknown>[] = [northbound, southbound],
  incidents: Record<string, unknown>[] = [roadwork, sideStreetCrash],
  clock = () => NOW,
) {
  return new RoadTrafficService({
    seoulCityDataKey: 'secret-key',
    now: clock,
    fetcher: (async (input: URL) => {
      calls.push(String(input).split('/').pop()!);

      return json(cityData(rows, incidents));
    }) as typeof fetch,
  });
}

test('bus legs are re-timed on live roads before ranking; other legs and uncovered routes are untouched', async () => {
  const calls: string[] = [];
  const bus = leg('bus-1', 'bus', 150),
    walk = leg('walk-1', 'walk', 500),
    subway = leg('subway-1', 'subway', 170);
  const routes = [
    baseRoute('by-bus', [walk, bus]),
    baseRoute('by-subway', [walk, subway]),
    baseRoute('bus-again', [bus]),
  ];

  const timed = await applyRoadConditions(routes, service(calls));

  assert.ok(calls.includes('POI014'), 'the area the bus passes through is read');

  const timedBus = timed[0].segments[1];

  assert.deepEqual(
    [timedBus.roadDelaySeconds, timedBus.durationSeconds.max, timedBus.traffic],
    [
      90,
      240,
      [
        {
          from: 0,
          to: 14,
          level: 'jam',
        },
      ],
    ],
  );
  assert.equal(timed[0].durationSeconds.max, 740, 'the route total includes the delay');
  assert.equal(timed[2].segments[0], timedBus, 'a leg shared by several candidates is judged once');
  assert.equal(timed[1], routes[1], 'a subway route is not re-timed by road speeds');
  assert.ok(
    timed[1].durationSeconds.max < timed[0].durationSeconds.max,
    'the jammed bus now loses to the subway it used to beat',
  );
  assert.equal(bus.durationSeconds.max, 150, 'provider data is never mutated');

  const jeju = busPath.map((point) => ({
    latitude: point.latitude - 4,
    longitude: point.longitude,
  }));
  const before = calls.length;
  const far = [baseRoute('jeju', [leg('bus-j', 'bus', 150, jeju)])];

  assert.equal(
    (await applyRoadConditions(far, service(calls)))[0],
    far[0],
    'no reported roads: provider time stands',
  );
  assert.equal(calls.length, before, 'and no area is requested');
  assert.equal(
    (
      await applyRoadConditions(
        routes,
        new RoadTrafficService({
          now: () => NOW,
        }),
      )
    )[0],
    routes[0],
    'without a key nothing changes',
  );
});

// Regression protected: concurrent timetable/road lookups must not lose road delay, mix repeated IDs,
// or serialize the independent upstream requests while waiting for each other's result.
test(
  'parallel schedule and road enrichment starts both feeds and preserves sequential timing evidence',
  {
    timeout: 3000,
  },
  async () => {
    const routes = [
      baseRoute('mixed-a', [leg('repeated-id', 'bus', 150), leg('repeated-id', 'subway', 170)]),
      baseRoute('mixed-b', [leg('repeated-id', 'subway', 300), leg('repeated-id', 'bus', 180)]),
    ];
    const original = structuredClone(routes);

    const scheduled = (inputs: BaseRoute[]) =>
      inputs.map((route) => ({
        ...route,
        segments: route.segments.map((segment) =>
          segment.mode === 'subway'
            ? {
                ...segment,
                timetable: undefined,
                scheduledConnection: undefined,
                scheduleCheck: {
                  provider: 'seoul-metro-timetable' as const,
                  checkedAt: NOW,
                  status: 'unverified' as const,
                  reason: 'unsupported' as const,
                },
              }
            : segment,
        ),
      }));

    let roadsStarted!: () => void, timetableStarted!: () => void;
    const roadGate = new Promise<void>((resolve) => {
      roadsStarted = resolve;
    });
    const timetableGate = new Promise<void>((resolve) => {
      timetableStarted = resolve;
    });
    const roads = new RoadTrafficService({
      seoulCityDataKey: 'fixture',
      now: () => NOW,
      fetcher: (async () => {
        roadsStarted();

        await timetableGate;

        return json(cityData([northbound, southbound]));
      }) as typeof fetch,
    });
    const timetables = {
      enrich: async (inputs: BaseRoute[]) => {
        timetableStarted();

        await roadGate;

        return scheduled(inputs);
      },
    };

    const actual = await enrichRouteConditions(routes, NOW, roads, timetables);

    const sequential = await applyRoadConditions(scheduled(routes), service());

    assert.deepEqual(
      actual,
      sequential,
      'concurrency preserves every schedule, road delay and total',
    );
    assert.equal(actual[0].segments[0].roadDelaySeconds, 90);
    assert.equal(
      actual[1].segments[0].durationSeconds.max,
      300,
      'repeated IDs do not attach a different leg',
    );
    assert.equal(actual[0].segments[1].scheduleCheck?.reason, 'unsupported');
    assert.deepEqual(routes, original, 'enrichment does not mutate reusable supplier inputs');
  },
);

test('areas are cached between searches, and a failed area does not block the rest', async () => {
  const calls: string[] = [];
  let clock = NOW;
  const roads = new RoadTrafficService({
    seoulCityDataKey: 'key',
    now: () => clock,
    fetcher: (async (input: URL) => {
      const code = String(input).split('/').pop()!;

      calls.push(code);

      return code === 'POI014'
        ? json(cityData([northbound]))
        : json({
            'RESULT.CODE': 'ERROR-500',
            'RESULT.MESSAGE': '서버 오류입니다.',
          });
    }) as typeof fetch,
  });

  const first = await roads.along([busPath]);

  assert.deepEqual(
    first.links.map((link) => link.id),
    ['N1'],
  );

  const read = calls.length;

  await roads.along([busPath]);

  assert.equal(
    calls.length,
    read,
    'a second search inside the cache window spends no provider calls',
  );

  clock += 121_000;

  await roads.along([busPath]);

  assert.ok(calls.length > read, 'expired areas are read again so conditions stay current');
});

test('old, unknown and future road observations cannot masquerade as current speeds', async () => {
  for (const timestamp of ['2026-10-12 14:49', '', '2026-10-12 15:02']) {
    const payload = cityData([northbound]);

    payload.CITYDATA.ROAD_TRAFFIC_STTS.AVG_ROAD_DATA.ROAD_TRAFFIC_TIME = timestamp;

    const roads = new RoadTrafficService({
      seoulCityDataKey: 'key',
      now: () => NOW,
      fetcher: (async () => json(payload)) as typeof fetch,
    });

    const result = await roads.along([busPath]);

    assert.deepEqual(result.links, []);
    assert.equal(result.observedAt, null);
  }
});

test('merged current areas retain the oldest included source timestamp', async () => {
  let calls = 0;
  const roads = new RoadTrafficService({
    seoulCityDataKey: 'key',
    maxAreas: 2,
    now: () => NOW,
    fetcher: (async () => {
      const index = calls++;
      const payload = cityData([
        {
          ...northbound,
          LINK_ID: `area-${index}`,
        },
      ]);

      payload.CITYDATA.ROAD_TRAFFIC_STTS.AVG_ROAD_DATA.ROAD_TRAFFIC_TIME =
        index === 0 ? '2026-10-12 14:54' : '2026-10-12 14:59';

      return json(payload);
    }) as typeof fetch,
  });
  const paths = SEOUL_TRAFFIC_AREAS.slice(0, 2).map(([, , west, south, east, north]) => [
    {
      latitude: (south + north) / 2,
      longitude: (west + east) / 2,
    },
  ]);

  const result = await roads.along(paths);

  assert.equal(calls, 2);
  assert.equal(result.links.length, 2);
  assert.equal(
    result.observedAt,
    NOW - 6 * 60_000,
    'a 1-minute observation cannot re-label a 6-minute observation as 1 minute old',
  );
});
