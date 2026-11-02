// Regression cases from mvp/tests/subwayLine.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLinePaths, SubwayLineService } from '../src/common/engine/realtime/subwayLine.js';
import { subwayLineViewSchema } from '../src/common/shared/domain/subwayLine.js';

const names = (paths: { name: string }[][]) =>
  paths.map((path) => path.map((station) => station.name).join(' '));
const row = (code: string, name: string) => ({ code, name });

test('station codes give every terminus-to-terminus path, starting past an extension of the first station', () => {
  // 1호선 in miniature: 소요산(100) extends to 연천(100-2); 구로(102) branches to the P series.
  const paths = buildLinePaths([
    row('100', '소요산'),
    row('100-1', '전곡'),
    row('100-2', '연천'),
    row('101', '서울역'),
    row('102', '구로'),
    row('103', '구일'),
    row('104', '인천'),
    row('P103', '가산디지털단지'),
    row('P104', '금천구청'),
    row('P104-1', '광명'),
    row('P105', '석수'),
  ]);
  assert.deepEqual(
    names(paths),
    [
      '연천 전곡 소요산 서울역 구로 구일 인천',
      '연천 전곡 소요산 서울역 구로 가산디지털단지 금천구청 광명',
      '연천 전곡 소요산 서울역 구로 가산디지털단지 금천구청 석수',
    ],
    'leaves follow station code order',
  );
});

test('a circular line is one loop plus each branch from its junction', () => {
  const paths = buildLinePaths(
    [
      row('201', '시청'),
      row('202', '을지로입구'),
      row('203', '성수'),
      row('203-1', '용답'),
      row('203-2', '신설동'),
      row('204', '강남'),
      row('205', '홍대입구'),
    ],
    true,
  );
  assert.deepEqual(names(paths), ['시청 을지로입구 성수 강남 홍대입구', '성수 용답 신설동']);
});

test('inserted codes sort between their neighbours and named junctions join sections codes cannot', () => {
  assert.deepEqual(
    names(
      buildLinePaths([
        row('A01', '서울역'),
        row('A04', '디지털미디어시티'),
        row('A042', '마곡나루'),
        row('A05', '김포공항'),
      ]),
    ),
    ['서울역 디지털미디어시티 마곡나루 김포공항'],
  );
  const gyeongui = buildLinePaths(
    [
      row('K110', '용산'),
      row('K111', '이촌'),
      row('K312', '공덕'),
      row('K313', '서강대'),
      row('K826', '효창공원앞'),
    ],
    false,
    {
      add: [
        ['공덕', '효창공원앞'],
        ['효창공원앞', '용산'],
      ],
    },
  );
  assert.deepEqual(names(gyeongui), ['이촌 용산 효창공원앞 공덕 서강대']);
});

test('live positions land on the path with their direction and the chosen station gets its arrivals', async () => {
  const now = Date.UTC(2026, 9, 28, 5, 30);
  const kst = (offsetSeconds: number) =>
    new Date(now + 9 * 3_600_000 + offsetSeconds * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
  const master = [
    ['132', '시청'],
    ['133', '서울역'],
    ['134', '남영'],
    ['135', '용산'],
  ]
    .map(([code, name]) => ({ LINE_NUM: '01호선', FR_CODE: code, STATION_NM: name }))
    .concat([{ LINE_NUM: '02호선', FR_CODE: '201', STATION_NM: '시청' }]);
  const positions = [
    {
      statnNm: '서울',
      trainNo: '0661',
      updnLine: '1',
      statnTnm: '용산',
      trainSttus: '2',
      directAt: '0',
      lstcarAt: '0',
      recptnDt: kst(-5),
    },
    {
      statnNm: '서울',
      trainNo: '0661',
      updnLine: '1',
      statnTnm: '용산',
      trainSttus: '1',
      directAt: '0',
      lstcarAt: '0',
      recptnDt: kst(-40),
    },
    {
      statnNm: '남영',
      trainNo: '1924',
      updnLine: '0',
      statnTnm: '시청',
      trainSttus: '0',
      directAt: '1',
      lstcarAt: '0',
      recptnDt: kst(-3),
    },
  ];
  const arrivals = [
    {
      subwayId: '1001',
      trainLineNm: '시청행 - 시청방면',
      bstatnNm: '시청',
      barvlDt: '0',
      arvlCd: '99',
      arvlMsg2: '[2]번째 전역 (남영)',
      recptnDt: kst(-3),
      btrainSttus: '급행',
      btrainNo: '1924',
    },
    {
      subwayId: '1001',
      trainLineNm: '용산행 - 남영방면',
      bstatnNm: '용산',
      barvlDt: '90',
      arvlCd: '3',
      arvlMsg2: '전역 출발',
      recptnDt: kst(-3),
      btrainSttus: '일반',
      btrainNo: '0700',
    },
  ];
  const service = new SubwayLineService({
    seoulKey: 'seoul',
    realtimeKey: 'realtime',
    now: () => now,
    fetcher: async (input) => {
      const url = String(input);
      const body = url.includes('SearchSTNBySubwayLineInfo')
        ? { SearchSTNBySubwayLineInfo: { row: master } }
        : url.includes('realtimePosition')
          ? { realtimePositionList: positions, errorMessage: { code: 'INFO-000' } }
          : { realtimeArrivalList: arrivals };
      return new Response(JSON.stringify(body), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const view = await service.view('수도권 1호선', '서울역');
  assert.ok(view && subwayLineViewSchema.safeParse(view).success);
  const path = view.paths[0];
  assert.deepEqual(
    path.stations.map((station) => station.name),
    ['시청', '서울역', '남영', '용산'],
  );
  assert.deepEqual(path.stations[0].transfers, ['2']);
  assert.deepEqual(view.selected, { path: 0, station: 1 });
  const trains = Object.fromEntries(path.trains.map((train) => [train.trainNo, train]));
  assert.equal(path.trains.length, 2, 'a repeated older report of the same train is dropped');
  assert.equal(trains['0661'].forward, true, 'heading for 용산, past 서울역');
  assert.equal(trains['0661'].position, 1.4, 'just departed 서울역 toward 남영');
  assert.equal(trains['1924'].forward, false);
  assert.equal(trains['1924'].express, true);
  assert.equal(trains['1924'].position, 2.3, 'approaching 남영 from 용산');
  // A countdown is used when given; otherwise two minutes a stop, marked as an estimate.
  assert.deepEqual(
    view.arrivals.map((arrival) => [
      arrival.forward,
      arrival.terminal,
      arrival.estimated,
      Math.round((arrival.arrivesAt - now) / 1000),
    ]),
    [
      [true, '용산', false, 87],
      [false, '시청', true, 237],
    ],
  );
});
