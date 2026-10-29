// Preserved regression cases from perception-map/mvp/tests/subwayFreshness.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSubwayRows,
  selectSubwayArrivals,
  type SubwayArrivalRow,
} from '../src/common/engine/realtime/seoulSubway.js';

// 2026-10-15 13:12:00 KST. Seoul recptnDt is the row's generation time.
const NOW = Date.UTC(2026, 9, 15, 4, 12);

const kst = (timestamp: number) =>
  new Date(timestamp + 9 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

const raw = (overrides: Record<string, unknown> = {}) => ({
  subwayId: '1001',
  trainLineNm: '소요산행 - 종각방면',
  bstatnNm: '소요산',
  barvlDt: '180',
  arvlCd: '99',
  arvlMsg2: '3분 후',
  arvlMsg3: '서울',
  recptnDt: kst(NOW - 30_000),
  btrainSttus: '일반',
  btrainNo: '0142',
  lstcarAt: '0',
  ...overrides,
});

function parse(rows: Record<string, unknown>[], receivedAt = NOW): SubwayArrivalRow[] {
  const result = parseSubwayRows(
    {
      errorMessage: {
        code: 'INFO-000',
      },
      realtimeArrivalList: rows,
    },
    receivedAt,
  );

  assert.ok(Array.isArray(result));

  return result;
}

const select = (rows: SubwayArrivalRow[], now = NOW) =>
  selectSubwayArrivals(rows, ['1호선'], ['종각', '종로3가'], now);

test('old matching trains do not age an independently fresh valid arrival', () => {
  const rows = parse([
    raw({
      btrainNo: 'old-past',
      recptnDt: kst(NOW - 132_000),
      barvlDt: '30',
    }),
    raw({
      btrainNo: 'old-future',
      recptnDt: kst(NOW - 132_000),
      barvlDt: '600',
    }),
    raw({
      btrainNo: 'fresh',
    }),
  ]);
  const selected = select(rows);

  assert.ok(selected);
  assert.equal(selected.observedAt, NOW - 30_000);
  assert.deepEqual(
    selected.predictions.map((prediction) => prediction.arrivesAt),
    [NOW + 150_000],
  );
});

test('each selected row keeps the same 120-second source-age boundary', () => {
  const rows = parse([
    raw({
      btrainNo: 'at-boundary',
      recptnDt: kst(NOW - 120_000),
      barvlDt: '600',
    }),
    raw({
      btrainNo: 'expired',
      recptnDt: kst(NOW - 121_000),
      barvlDt: '600',
    }),
  ]);

  assert.deepEqual(
    select(rows)?.predictions.map((prediction) => prediction.arrivesAt),
    [NOW + 480_000],
  );
  assert.equal(select(rows, NOW + 1_000), null, 'no new receipt can refresh either old source row');
});

test('unknown countdowns never turn status codes, station counts or vague phrases into observed seconds', () => {
  for (const message of [
    '전역 출발',
    '전역 진입',
    '전역 도착',
    '[2]번째 전역 (서울)',
    '곧 도착',
    '서울 진입',
    '시청 도착',
    '3분 후',
  ]) {
    for (const countdown of ['0', '', undefined, '-1', 'invalid']) {
      const rows = parse([
        raw({
          barvlDt: countdown,
          arvlCd: message === '시청 도착' ? '1' : '5',
          arvlMsg2: message,
        }),
      ]);

      assert.deepEqual(rows, [], `${message} is not a quantified future boarding observation`);
    }
  }
});

test('official countdowns are positive whole seconds within one day', () => {
  for (const seconds of ['1', '86400']) {
    const rows = parse([
      raw({
        barvlDt: seconds,
      }),
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].arrivesAt, NOW - 30_000 + Number(seconds) * 1000);
  }

  for (const seconds of ['86401', '1.5', 1.5, Number.MAX_VALUE, Infinity, '-1', '0']) {
    assert.deepEqual(
      parse([
        raw({
          barvlDt: seconds,
        }),
      ]),
      [],
      String(seconds),
    );
  }
});

test('a malformed response clock cannot authenticate source timestamps', () => {
  for (const receivedAt of [NaN, Infinity, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse([raw()], receivedAt));
  }
});

test('missing, malformed and impossible source dates cannot borrow the response receipt', () => {
  for (const source of [
    undefined,
    '',
    'unknown',
    '2026-02-31 13:11:30',
    '2026-13-15 13:11:30',
    '2026-10-15 24:11:30',
    '2026-10-15 13:60:30',
    '2026-10-15 13:11:60',
    '2026-10-15 13:11:30 trailing',
    '2026-10-15T13:11:30Z',
  ]) {
    assert.deepEqual(
      parse([
        raw({
          recptnDt: source,
        }),
      ]),
      [],
      String(source),
    );
  }
});

test('small permitted source clock skew remains explicit instead of being clamped to receipt time', () => {
  const rows = parse([
    raw({
      recptnDt: kst(NOW + 30_000),
    }),
    raw({
      btrainNo: 'too-future',
      recptnDt: kst(NOW + 31_000),
    }),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].observedAt, NOW + 30_000);
  assert.equal(rows[0].arrivesAt, NOW + 210_000);
  assert.equal(select(rows)?.observedAt, NOW + 30_000);
});

test('cached rows preserve their original absolute countdown and expire by their original source time', () => {
  const rows = parse([raw()]);

  assert.equal(select(rows)?.predictions[0].arrivesAt, NOW + 150_000);
  assert.equal(select(rows, NOW + 60_000)?.predictions[0].arrivesAt, NOW + 150_000);
  assert.equal(select(rows, NOW + 91_000), null);
});

test('an elapsed arrival cannot become an immediate new train or proof of ended service', () => {
  const rows = parse([
    raw({
      recptnDt: kst(NOW - 31_000),
      barvlDt: '30',
    }),
  ]);

  assert.equal(select(rows), null);
});

test('direction requires the actual immediately following route station, not any later stop', () => {
  const rows = parse([
    raw(),
    raw({
      btrainNo: 'opposite',
      trainLineNm: '인천행 - 서울방면',
    }),
    raw({
      btrainNo: 'later-only',
      trainLineNm: '소요산행 - 종로3가방면',
    }),
  ]);

  assert.equal(select(rows)?.predictions.length, 1);
  assert.equal(selectSubwayArrivals(rows, ['1호선'], ['서울', '종각'], NOW)?.predictions.length, 1);
  assert.equal(selectSubwayArrivals(rows, ['1호선'], [], NOW), null);
});

test('express and limited-stop trains remain unavailable to a route without verified stop-pattern evidence', () => {
  const rows = parse([
    raw(),
    ...['급행', '특급', '직통', 'ITX'].map((status, index) =>
      raw({
        btrainNo: `limited-${index}`,
        btrainSttus: status,
      }),
    ),
  ]);

  assert.equal(rows.length, 5, 'source rows may still describe these trains for a station display');
  assert.equal(
    select(rows)?.predictions.length,
    1,
    'a normal route cannot inherit an unverified faster service',
  );
});

test('same-direction short-turn trains cannot supply the wait for a journey beyond their terminus', () => {
  const rows = parse([
    raw({
      subwayId: '1004',
      btrainNo: 'short-turn',
      trainLineNm: '사당행 - 숙대입구방면',
      bstatnNm: '사당',
      barvlDt: '60',
    }),
    raw({
      subwayId: '1004',
      btrainNo: 'through',
      trainLineNm: '오이도행 - 숙대입구방면',
      bstatnNm: '오이도',
      barvlDt: '300',
    }),
  ]);
  const remaining = ['숙대입구', '삼각지', '사당역', '남태령', '정부과천청사'];
  const through = selectSubwayArrivals(rows, ['4호선'], remaining, NOW);

  assert.deepEqual(
    through?.predictions.map((train) => [train.destination, train.arrivesAt]),
    [['오이도행', NOW + 270_000]],
  );
  assert.equal(
    selectSubwayArrivals(rows.slice(0, 1), ['4호선'], remaining, NOW),
    null,
    'an extra transfer and wait cannot be silently omitted when only a short-turn train is observed',
  );
  assert.equal(
    selectSubwayArrivals(rows.slice(0, 1), ['4호선'], remaining.slice(0, 3), NOW)?.predictions[0]
      .destination,
    '사당행',
    'alighting at the actual terminus remains a valid journey',
  );
});

test('a train update supersedes an earlier prediction for the same train before arrival sorting', () => {
  const rows = parse([
    raw({
      recptnDt: kst(NOW - 90_000),
      barvlDt: '120',
    }),
    raw({
      recptnDt: kst(NOW - 10_000),
      barvlDt: '300',
    }),
  ]);

  assert.deepEqual(
    select(rows)?.predictions.map((prediction) => prediction.arrivesAt),
    [NOW + 290_000],
  );
  assert.equal(select(rows)?.observedAt, NOW - 10_000);
});

test('the latest departed or unquantified train update revokes an older positive prediction', () => {
  for (const update of [
    {
      arvlCd: '2',
      barvlDt: '0',
    },
    {
      arvlCd: '99',
      barvlDt: '0',
    },
  ]) {
    const rows = parse([
      raw({
        recptnDt: kst(NOW - 90_000),
        barvlDt: '600',
      }),
      raw({
        recptnDt: kst(NOW - 10_000),
        ...update,
      }),
    ]);

    assert.equal(select(rows), null);
  }
});

test('a malformed timestamp cannot silently expose an older prediction for the same train and direction', () => {
  assert.equal(
    select(
      parse([
        raw(),
        raw({
          recptnDt: 'unknown',
        }),
      ]),
    ),
    null,
  );
});

test('an unspecified train service kind cannot silently become a normal service observation', () => {
  assert.equal(
    select(
      parse([
        raw({
          btrainSttus: '',
        }),
      ]),
    ),
    null,
  );
});

test('empty or unquantified matching rows are unknown service rather than a no-service result', () => {
  assert.equal(select(parse([])), null);
  assert.equal(
    select(
      parse([
        raw({
          barvlDt: '0',
          arvlMsg2: '운행중',
        }),
      ]),
    ),
    null,
  );
});
