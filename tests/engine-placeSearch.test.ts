// Place search: nationwide Kakao keyword search, the station list, retries and fallbacks (CONTRACT-SEARCH, 2026-11-01).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/common/engine/errors.js';
import {
  KakaoProvider,
  normalizePlaces,
  type PlaceHit,
  type PlaceSearch,
} from '../src/common/engine/kakao.js';
import {
  PlaceFinder,
  PlaceSearchCache,
  bundledStations,
  placeQueryText,
  stationKey,
} from '../src/modules/places/domain/place-search.js';

const catalogue = bundledStations();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const doc = (
  id: string,
  name: string,
  x: number,
  y: number,
  extra: Record<string, string> = {},
) => ({
  id,
  place_name: name,
  address_name: '서울 어딘가',
  x: String(x),
  y: String(y),
  ...extra,
});
const hit = (
  id: string,
  name: string,
  latitude: number,
  longitude: number,
  kind?: PlaceHit['kind'],
) => ({
  id,
  name,
  address: '서울',
  latitude,
  longitude,
  ...(kind ? { kind } : {}),
});
const failing =
  (code: ApiError['code'], status = 502) =>
  async () => {
    throw new ApiError(code, '카카오 실패', status);
  };
const finder = (search: (query: PlaceSearch) => Promise<readonly PlaceHit[]>) =>
  new PlaceFinder({ search, catalogue, wait: async () => {} });

test('the bundled station list loads with merged transfer stations and both 양평 stations', () => {
  assert.ok(catalogue.size > 600);
  const yangpyeong = catalogue.match('양평', { latitude: 37.5256, longitude: 126.8861 }).exact;
  assert.equal(yangpyeong.length, 2);
  assert.deepEqual(yangpyeong[0].lines, ['5호선']);
  assert.deepEqual(catalogue.match('서울역', { latitude: 37.5, longitude: 127 }).exact[0].lines, [
    '1호선',
    '4호선',
    '경의중앙선',
    '공항철도1호선',
    'GTX-A',
  ]);
});

test('query text drops a half-typed jamo and the key drops line names, 역 and its typos', () => {
  assert.equal(placeQueryText(' 강남ㅇ '), '강남');
  assert.equal(placeQueryText('숙대입ㄱ'), '숙대입');
  assert.equal(stationKey('2호선 강남역'), '강남');
  assert.equal(stationKey('신분당선 강남역'), '강남');
  assert.equal(stationKey('GTX 수서역'), '수서');
  assert.equal(stationKey('강남녁'), '강남');
  assert.equal(stationKey('숙대입구엮'), '숙대입구');
  assert.equal(stationKey('DMC'), 'dmc');
});

test('stations match by name, short form, bracket name, prefix and a one-jamo typo', () => {
  const center = { latitude: 37.5666, longitude: 126.9784 };
  assert.equal(catalogue.match('인천시청역', center).exact[0].name, '인천시청');
  const goter = catalogue.match('고터', center);
  assert.equal(goter.exact[0].name, '고속터미널');
  assert.equal(goter.kakaoQuery, '고속터미널역');
  assert.equal(catalogue.match('갈월', center).related[0].name, '숙대입구');
  assert.deepEqual(
    catalogue.match('숙대입', center).prefix.map((station) => station.name),
    ['숙대입구'],
  );
  assert.equal(catalogue.match('삼섬역', center).typo[0].name, '삼성');
  assert.equal(catalogue.match('홍대잎구역', center).typo[0].name, '홍대입구');
  assert.equal(catalogue.match('강넘역', center).typo[0].name, '강남');
  assert.equal(catalogue.match('스타벅스', center).exact.length, 0);
});

test('Kakao documents are checked one by one, stations carry their line and the capital region comes first', () => {
  const places = normalizePlaces({
    documents: [
      doc('1', '부산역 1호선', 129.04, 35.11, {
        category_group_code: 'SW8',
        category_group_name: '지하철역',
      }),
      doc('2', '강남역 신분당선', 127.028, 37.4979, {
        category_group_code: 'SW8',
        category_group_name: '지하철역',
      }),
      { id: '3', place_name: '', address_name: 'x', x: '127', y: '37.5' },
      doc('4', '좌표 없음', Number.NaN, 37.5),
      doc('5', '스타벅스 강남점', 127.03, 37.5, {
        category_name: '음식점 > 카페 > 커피전문점 > 스타벅스',
      }),
    ],
  });
  assert.deepEqual(
    places.map((place) => [place.id, place.kind, place.category, place.lines]),
    [
      ['kakao-2', 'station', '지하철역', ['신분당선']],
      ['kakao-5', 'place', '스타벅스', undefined],
      ['kakao-1', 'station', '지하철역', ['1호선']],
    ],
  );
  assert.throws(
    () => normalizePlaces({ documents: [doc('x', 'x', Number.NaN, 37.5)] }),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_RESPONSE',
  );
  assert.throws(() => normalizePlaces({ places: [] }), ApiError);
  assert.deepEqual(normalizePlaces({ documents: [] }), []);
});

test('Kakao search is nationwide with no radius or Seoul box, and an address with no keyword hit asks the address API once', async () => {
  const urls: URL[] = [];
  const provider = new KakaoProvider({
    key: 'private-example-key',
    fetcher: async (url) => {
      const parsed = new URL(String(url));
      urls.push(parsed);
      return parsed.pathname.endsWith('address.json')
        ? json({
            documents: [
              {
                address_name: '서울 용산구 청파동2가 52',
                x: '126.9686',
                y: '37.5447',
                address: { address_name: '서울 용산구 청파동2가 52' },
                road_address: { address_name: '서울 용산구 청파로 100' },
              },
            ],
          })
        : json({ documents: [] });
    },
  });
  assert.deepEqual(await provider.searchPlaces({ q: '스타벅스' }), []);
  assert.equal(urls[0].searchParams.get('size'), '15');
  assert.equal(urls[0].searchParams.get('x'), '126.9784');
  assert.equal(urls[0].searchParams.get('y'), '37.5666');
  assert.equal(urls[0].searchParams.has('radius'), false);
  assert.equal(urls[0].searchParams.has('rect'), false);
  await provider.searchPlaces({ q: '판교역', latitude: 37.6553, longitude: 127.0613 });
  assert.equal(urls[1].searchParams.get('x'), '127.0613');
  assert.equal(urls[1].searchParams.has('radius'), false);
  const address = await provider.searchPlaces({ q: '청파동2가 52' });
  assert.equal(urls.length, 4);
  assert.equal(urls[3].pathname, '/v2/local/search/address.json');
  assert.deepEqual(
    address.map((place) => [place.name, place.address, place.kind]),
    [['서울 용산구 청파로 100', '서울 용산구 청파동2가 52', 'address']],
  );
});

test('an exact station leads the list, using Kakao station documents when they are there', async () => {
  const kakao = [
    hit('kakao-a', '서초구청', 37.4837, 127.0324),
    hit('kakao-b', '서초역 2호선', 37.4919, 127.0076, 'station'),
  ];
  const withDocument = await finder(async () => kakao).find({ q: '서초' });
  assert.deepEqual(
    withDocument.places.map((place) => place.id),
    ['kakao-b', 'kakao-a'],
  );
  const withoutDocument = await finder(async () => kakao.slice(0, 1)).find({ q: '화곡' });
  assert.equal(withoutDocument.places[0].id, 'station-화곡-0');
  assert.equal(withoutDocument.places[0].name, '화곡역');
  assert.equal(withoutDocument.places[0].kind, 'station');
  assert.equal(withoutDocument.places[0].address, '5호선 · 역 대표 위치');
  assert.equal(withoutDocument.scope, '서울시청 기준 · 전국');
});

test('a short form searches Kakao by the full name and typos follow Kakao only when Kakao found no station', async () => {
  const queries: string[] = [];
  const goter = await finder(async (query) => {
    queries.push(query.q);
    return [];
  }).find({ q: '고터' });
  assert.deepEqual(queries, ['고속터미널역']);
  assert.equal(goter.places[0].name, '고속터미널역');
  const typo = await finder(async () => [hit('kakao-x', '삼섬식당', 37.5, 127)]).find({
    q: '삼섬역',
  });
  assert.deepEqual(
    typo.places.map((place) => place.id),
    ['kakao-x', 'station-삼성-0'],
  );
});

test("a half-typed name with one possible station puts it after Kakao's first row", async () => {
  const kakao = [
    hit('kakao-1', '잠실새마을금고 본점', 37.5115, 127.0832),
    hit('kakao-2', '잠실새마을전통시장', 37.5113, 127.0846),
    hit('kakao-3', '잠실새마을금고 잠실새내역지점', 37.5116, 127.0859),
  ];
  const result = await finder(async () => kakao).find({ q: '잠실새ㄴ' });
  assert.deepEqual(
    result.places.slice(0, 2).map((place) => place.id),
    ['kakao-1', 'station-잠실새내-0'],
  );
});

test('a stop query with no matching document searches once more without the suffix', async () => {
  const queries: string[] = [];
  const result = await finder(async (query) => {
    queries.push(query.q);
    return query.q === '종로3가'
      ? [hit('kakao-s', '종로3가역 1호선', 37.5704, 126.992, 'station')]
      : [];
  }).find({ q: '종로3가 정류장' });
  assert.deepEqual(queries, ['종로3가 정류장', '종로3가']);
  assert.equal(result.places[0].id, 'kakao-s');
  const first = [hit('kakao-f', '세종로 분식', 37.5717, 126.9768)];
  const kept = await finder(async (query) => {
    if (query.q === '광화문') throw new ApiError('PROVIDER_LIMIT', '한도', 429);
    return first;
  }).find({ q: '광화문 정류장' });
  assert.equal(kept.provenance.provider, 'kakao');
  assert.ok(kept.places.some((place) => place.id === 'kakao-f'));
});

test('a place a station is named after keeps its first row, and shared short forms reach Kakao as typed', async () => {
  const palace = { ...hit('kakao-p', '경복궁', 37.5796, 126.977), category: '관광명소' };
  const station = hit('kakao-s', '경복궁역 3호선', 37.5757, 126.9735, 'station');
  const named = await finder(async () => [palace, station]).find({ q: '경복궁' });
  assert.deepEqual(
    named.places.slice(0, 2).map((place) => place.id),
    ['kakao-p', 'kakao-s'],
  );
  const typedStation = await finder(async () => [palace, station]).find({ q: '경복궁역' });
  assert.equal(typedStation.places[0].id, 'kakao-s');
  const shop = { ...hit('kakao-c', '개화', 37.5786, 126.7976), category: '음식점' };
  const notNamed = await finder(async () => [shop]).find({ q: '개화' });
  assert.equal(notNamed.places[0].id, 'station-개화-0');
  const queries: string[] = [];
  const hongdae = await finder(async (query) => {
    queries.push(query.q);
    return [{ ...hit('kakao-u', '홍익대학교 서울캠퍼스', 37.5509, 126.9255), category: '학교' }];
  }).find({ q: '홍대' });
  assert.deepEqual(queries, ['홍대']);
  assert.deepEqual(
    hongdae.places.slice(0, 2).map((place) => place.id),
    ['station-홍대입구-0', 'kakao-u'],
  );
});

test('a timeout is retried once, and a Kakao failure falls back to stations or keeps the original error', async () => {
  let calls = 0;
  const retried = await finder(async () => {
    if (++calls === 1) throw new ApiError('PROVIDER_TIMEOUT', '늦음', 504);
    return [hit('kakao-1', '스타벅스', 37.5, 127)];
  }).find({ q: '스타벅스' });
  assert.equal(calls, 2);
  assert.equal(retried.places[0].id, 'kakao-1');

  for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_LIMIT', 'LIVE_NOT_CONFIGURED'] as const) {
    for (const q of ['강남역', '고터']) {
      const result = await finder(failing(code)).find({ q });
      assert.equal(result.provenance.provider, 'station-catalogue');
      assert.equal(result.scope, '카카오 검색을 쓸 수 없어 역만 찾았어요');
      assert.equal(result.places[0].name, q === '고터' ? '고속터미널역' : '강남역');
    }
  }
  await assert.rejects(
    finder(failing('PROVIDER_LIMIT', 429)).find({ q: '스타벅스' }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 503 &&
      error.message === '오늘 장소 검색 한도를 다 썼어요. 역 이름으로는 계속 찾을 수 있어요.',
  );
  await assert.rejects(
    finder(failing('PROVIDER_AUTH', 503)).find({ q: '강남역' }),
    (error: unknown) => error instanceof ApiError && error.code === 'PROVIDER_AUTH',
  );
});

test('real Kakao 429, spent quota and timeout responses all leave station search working', async () => {
  const responses: Record<string, typeof fetch> = {
    limit: async () => json({ message: 'limit' }, 429),
    quota: async () => json({ code: -10, msg: 'quota' }, 400),
    timeout: (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('a', 'AbortError')),
        ),
      ),
  };
  for (const fetcher of Object.values(responses)) {
    const provider = new KakaoProvider({ key: 'private-example-key', fetcher, timeoutMs: 5 });
    const places = new PlaceFinder({
      search: (query) => provider.searchPlaces(query),
      catalogue,
      wait: async () => {},
    });
    assert.equal((await places.find({ q: '강남역' })).places[0].name, '강남역');
    assert.equal((await places.find({ q: '고터' })).places[0].name, '고속터미널역');
    await assert.rejects(places.find({ q: '스타벅스' }), ApiError);
  }
});

test('answers are cached by query and center cell, shared while in flight, and an empty query asks nothing', async () => {
  let calls = 0;
  let now = 1_000_000;
  const places = new PlaceFinder({
    search: async () => {
      calls++;
      return [hit('kakao-1', '스타벅스', 37.5, 127)];
    },
    catalogue,
    now: () => now,
  });
  await Promise.all([places.find({ q: '스타벅스' }), places.find({ q: ' 스타벅스ㅇ' })]);
  assert.equal(calls, 1);
  await places.find({ q: '스타벅스', latitude: 37.4979, longitude: 127.0276 });
  await places.find({ q: '스타벅스', latitude: 37.4981, longitude: 127.0279 });
  assert.equal(calls, 2);
  now += 11 * 60_000;
  await places.find({ q: '스타벅스' });
  assert.equal(calls, 3);
  assert.deepEqual((await places.find({ q: 'ㄱ' })).places, []);
  assert.equal(calls, 3);
  assert.equal(PlaceSearchCache.key('Star Bucks', undefined), 'starbucks|none');
});

test('with a center every row carries its distance, and duplicates within 150 m collapse', async () => {
  const result = await finder(async () => [
    hit('kakao-1', '스타벅스 강남점', 37.4979, 127.0276),
    hit('kakao-2', '스타벅스 강남점', 37.498, 127.0277),
  ]).find({ q: '스타벅스', latitude: 37.4979, longitude: 127.0276 });
  assert.deepEqual(
    result.places.map((place) => [place.id, place.distanceMeters]),
    [['kakao-1', 0]],
  );
  assert.equal(result.scope, '수도권 우선 · 전국');
});

test('without a place-search key the registered places and the station list still answer', () => {
  const result = finder(async () => []).local({ q: '인천시청' });
  assert.equal(result.provenance.provider, 'local-catalogue');
  assert.equal(result.places[0].name, '인천시청역');
});
