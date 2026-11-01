import { readFileSync } from 'node:fs';
import { ApiError } from '../../../common/errors.js';
import { PLACES } from '../../../common/shared/domain/fixtures.js';
import {
  PLACE_SEARCH_CENTER,
  type PlaceHit,
  type PlaceSearch,
} from '../../../common/engine/kakao.js';

/** Built by jigak-backend/scripts/build-place-stations.mjs; the legacy server keeps a byte-identical copy. */
const STATION_FILE = new URL('../data/place-stations-v1.json', import.meta.url);

export type PlaceSource = 'kakao' | 'station-catalogue' | 'local-catalogue';

export interface CatalogueStation {
  name: string;
  aliases: string[];
  lines: string[];
  latitude: number;
  longitude: number;
}

interface IndexedStation extends CatalogueStation {
  id: string;
  key: string;
  jamo: number[];
}

interface Point {
  latitude: number;
  longitude: number;
}

/** Stations a query names, in the order the result list uses them. */
export interface StationMatch {
  /** Name or short-form match: these lead the list. */
  exact: IndexedStation[];
  /** Second name in the source's brackets ("갈월" for 숙대입구): placed after Kakao's first result. */
  related: IndexedStation[];
  /** Name prefix (at most five candidates) and one-jamo typos: after Kakao's results. */
  prefix: IndexedStation[];
  typo: IndexedStation[];
  /** Short forms are sent to Kakao as the full station name ("고터" → "고속터미널역"). */
  kakaoQuery?: string;
  /** The query without a trailing 역: a non-station Kakao first row with exactly this name stays first. */
  placeName?: string;
}

/** Short forms people type for stations. Names that already match a station are left out. */
const STATION_ALIASES: Readonly<Record<string, string>> = {
  고터: '고속터미널',
  남터: '남부터미널',
  동역사: '동대문역사문화공원',
  dmc: '디지털미디어시티',
  디엠씨: '디지털미디어시티',
  가디: '가산디지털단지',
  구디: '구로디지털단지',
  성대입구: '성신여대입구',
  건대: '건대입구',
  홍대: '홍대입구',
  숙대: '숙대입구',
  총신대: '총신대입구',
  // Renamed 자양 in 2024; the source table still says 뚝섬유원지.
  자양: '뚝섬유원지',
};
/** Short forms that also name a university or a neighbourhood: Kakao gets them as typed so 홍익대학교 stays findable. */
const SHARED_SHORT_FORMS = new Set(['홍대', '건대', '숙대', '총신대', '자양']);

const JAMO_TAIL = /[ㄱ-ㆎᄀ-ᇿ]+$/u;
/** "2호선 강남역", "공항철도 김포공항역", "GTX 수서역": a leading line name is not part of the station. */
const LINE_WORD = /^(?:\S*(?:호선|선|철도)|ktx|srt|gtx(?:-?a)?)$/i;
/** Stop-name queries Kakao has no document for: "종로3가 정류장", "신논현역 버스정류장", "명동 앞". */
const STOP_SUFFIX = /\s*(?:(?:버스)?정류[장소]|\s앞)$/;
const RETRY_CODES = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']);
const FALLBACK_CODES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_LIMIT',
  'LIVE_NOT_CONFIGURED',
]);
/** One retry only when the first attempt failed fast enough to keep the picker responsive (가정값). */
const RETRY_DELAY_MS = 300;
const RETRY_WITHIN_MS = 3_000;
const PREFIX_CANDIDATES = 5;
const TAIL_ROWS = 15;
/** Two documents for one place: same name within this distance. */
const SAME_PLACE_METERS = 150;
/** Kakao lists each line of a station at its own platform; the catalogue point is their mean. */
const SAME_STATION_METERS = 1_500;
const CACHE_ENTRIES = 1_000;
const CACHE_HIT_MS = 10 * 60_000;
const CACHE_EMPTY_MS = 60_000;

/** NFC, single spaces, and no half-typed jamo at the end ("강남ㅇ" → "강남"). */
export function placeQueryText(query: string): string {
  return query.normalize('NFC').replace(/\s+/g, ' ').trim().replace(JAMO_TAIL, '').trim();
}

/** Matching key: no spaces, lower case, no leading line name, no trailing 역 (or its typos 녁·엮·엿·억). */
export function stationKey(text: string): string {
  const words = placeQueryText(text).toLowerCase().split(' ');
  if (words.length > 1 && LINE_WORD.test(words[0])) words.shift();
  return words
    .join('')
    .replace(/^(?:\d+호선|ktx|gtx-?a?)/, '')
    .replace(/(?:역|녁|엮|엿|억)$/, '')
    .replace(JAMO_TAIL, '');
}

/** Hangul syllables as initial, medial and final jamo so "삼섬" is one edit from "삼성". */
function jamo(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0) - 0xac00;
    if (code >= 0 && code < 11_172) {
      out.push(0x1100 + Math.floor(code / 588), 0x1161 + Math.floor((code % 588) / 28));
      if (code % 28) out.push(0x11a7 + (code % 28));
    } else out.push(char.codePointAt(0) ?? 0);
  }
  return out;
}

function withinOneEdit(a: readonly number[], b: readonly number[]): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function meters(a: Point, b: Point): number {
  const radians = Math.PI / 180;
  const x =
    (b.longitude - a.longitude) * radians * Math.cos(((a.latitude + b.latitude) / 2) * radians);
  return 6_371_000 * Math.hypot(x, (b.latitude - a.latitude) * radians);
}

const flat = (text: string) => text.normalize('NFC').replace(/\s/g, '').toLowerCase();
const displayName = (name: string) => (name.endsWith('역') ? name : `${name}역`);

/** Capital-region subway and rail stations with their names, bracket names, lines and a mean point. */
export class StationCatalogue {
  private readonly stations: readonly IndexedStation[];
  private readonly byKey = new Map<string, IndexedStation[]>();
  private readonly byAlias = new Map<string, IndexedStation[]>();

  constructor(stations: readonly CatalogueStation[]) {
    const seen = new Map<string, number>();
    this.stations = stations.map((station) => {
      const count = seen.get(station.name) ?? 0;
      seen.set(station.name, count + 1);
      const key = stationKey(station.name);
      return { ...station, id: `station-${station.name}-${count}`, key, jamo: jamo(key) };
    });
    for (const station of this.stations) {
      this.byKey.set(station.key, [...(this.byKey.get(station.key) ?? []), station]);
      for (const alias of station.aliases) {
        const key = stationKey(alias);
        if (key) this.byAlias.set(key, [...(this.byAlias.get(key) ?? []), station]);
      }
    }
  }

  get size() {
    return this.stations.length;
  }

  match(text: string, center: Point): StationMatch {
    const key = stationKey(text);
    const near = (a: IndexedStation, b: IndexedStation) => meters(center, a) - meters(center, b);
    if (!key) return { exact: [], related: [], prefix: [], typo: [] };
    const canonical = STATION_ALIASES[key];
    const exact = [...(this.byKey.get(canonical ? stationKey(canonical) : key) ?? [])].sort(near);
    const related = exact.length ? [] : [...(this.byAlias.get(key) ?? [])].sort(near);
    const known = new Set([...exact, ...related]);
    const prefixed = this.stations.filter(
      (station) => !known.has(station) && station.key.startsWith(key),
    );
    const prefix =
      [...key].length >= 2 && prefixed.length <= PREFIX_CANDIDATES ? prefixed.sort(near) : [];
    const typed = jamo(key);
    const typo =
      exact.length || related.length || [...key].length < 2
        ? []
        : this.stations
            .filter(
              (station) =>
                !known.has(station) &&
                !prefix.includes(station) &&
                withinOneEdit(typed, station.jamo),
            )
            .sort(near);
    return {
      exact,
      related,
      prefix,
      typo,
      ...(canonical && exact.length && !SHARED_SHORT_FORMS.has(key)
        ? { kakaoQuery: displayName(exact[0].name) }
        : {}),
      // "경복궁", "보라매병원": the place Kakao names exactly may be what was meant, not the station.
      ...(/역$/.test(placeQueryText(text)) ? {} : { placeName: flat(placeQueryText(text)) }),
    };
  }
}

/** The bundled station list; a missing or malformed file leaves search to Kakao alone. */
export function bundledStations(): StationCatalogue {
  try {
    const data: unknown = JSON.parse(readFileSync(STATION_FILE, 'utf8'));
    const stations =
      data && typeof data === 'object' && 'stations' in data && Array.isArray(data.stations)
        ? (data.stations as unknown[]).filter(
            (station): station is CatalogueStation =>
              !!station &&
              typeof station === 'object' &&
              typeof (station as CatalogueStation).name === 'string' &&
              Array.isArray((station as CatalogueStation).aliases) &&
              Array.isArray((station as CatalogueStation).lines) &&
              Number.isFinite((station as CatalogueStation).latitude) &&
              Number.isFinite((station as CatalogueStation).longitude),
          )
        : [];
    return new StationCatalogue(stations);
  } catch {
    return new StationCatalogue([]);
  }
}

function stationPlace(station: IndexedStation): PlaceHit {
  return {
    id: station.id,
    name: displayName(station.name),
    address: `${station.lines.join('·')} · 역 대표 위치`,
    latitude: station.latitude,
    longitude: station.longitude,
    kind: 'station',
    category: '지하철역',
    lines: [...station.lines],
  };
}

const isStation = (hit: PlaceHit) => hit.kind === 'station';
/** Places a station is named after (경복궁, 보라매병원, 올림픽공원); a shop called "개화" is not one. */
const namesake = (hit: PlaceHit) =>
  !isStation(hit) &&
  /관광명소|문화시설|공공기관|병원|학교|공원|산$|궁$|^문$/.test(hit.category ?? '');
const sameStation = (hit: PlaceHit, station: IndexedStation) =>
  isStation(hit) &&
  stationKey(hit.name.split(' ')[0]) === station.key &&
  meters(hit, station) <= SAME_STATION_METERS;

/** Exact stations first (Kakao's own station documents when present), then Kakao, then prefix and typo stations. */
export function mergePlaceHits(
  hits: readonly PlaceHit[],
  match: StationMatch,
  center?: Point,
): PlaceHit[] {
  const used = new Set<PlaceHit>();
  const rows = (stations: readonly IndexedStation[]) =>
    stations.flatMap((station) => {
      const own = hits.filter((hit) => !used.has(hit) && sameStation(hit, station));
      for (const hit of own) used.add(hit);
      return own.length ? own : [stationPlace(station)];
    });
  // "잠실새" names one station only; when Kakao's first rows are no station, it joins the related rows.
  const promote =
    !match.exact.length && match.prefix.length === 1 && !hits.slice(0, 3).some(isStation);
  const lead = rows(match.exact);
  const related = rows(promote ? [...match.related, ...match.prefix] : match.related);
  const rest = hits.filter((hit) => !used.has(hit));
  const named =
    rest[0] === hits[0] &&
    !!rest[0] &&
    namesake(rest[0]) &&
    [rest[0].name, rest[0].name.split(' ').at(-1) ?? ''].some(
      (name) => flat(name) === match.placeName,
    );
  const tail = [...(promote ? [] : match.prefix), ...(hits.some(isStation) ? [] : match.typo)]
    .filter((station) => !hits.some((hit) => sameStation(hit, station)))
    .slice(0, TAIL_ROWS)
    .map(stationPlace);
  const ordered = named
    ? [...rest.slice(0, 1), ...lead, ...related, ...rest.slice(1), ...tail]
    : [...lead, ...rest.slice(0, 1), ...related, ...rest.slice(1), ...tail];
  const places: PlaceHit[] = [];
  for (const place of ordered) {
    const duplicate = places.some(
      (other) =>
        other.id === place.id ||
        (flat(other.name) === flat(place.name) && meters(other, place) <= SAME_PLACE_METERS),
    );
    if (!duplicate) places.push(place);
  }
  return center
    ? places.map((place) => ({ ...place, distanceMeters: Math.round(meters(center, place)) }))
    : places;
}

const LABELS: Readonly<Record<PlaceSource, string>> = {
  kakao: '카카오 장소 검색',
  'station-catalogue': '역 목록',
  'local-catalogue': '등록 장소와 역 목록',
};

export function placeSearchResult(
  places: PlaceHit[],
  source: PlaceSource,
  hasCenter: boolean,
  now: number,
) {
  return {
    places,
    generatedAt: now,
    provenance: {
      mode: 'live',
      provider: source,
      label: LABELS[source],
      sourceTimestamp: null,
      receivedAt: now,
      isRealtime: false,
    },
    scope:
      source === 'station-catalogue'
        ? '카카오 검색을 쓸 수 없어 역만 찾았어요'
        : source === 'local-catalogue'
          ? '장소 검색 키 미설정: 등록 장소와 수도권 역만 검색 가능'
          : hasCenter
            ? '수도권 우선 · 전국'
            : '서울시청 기준 · 전국',
  };
}

/** Recent Kakao answers by query and a roughly 1 km center cell; one request in flight per key. */
export class PlaceSearchCache {
  private readonly entries = new Map<string, { hits: PlaceHit[]; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<PlaceHit[]>>();

  constructor(private readonly now: () => number = Date.now) {}

  static key(query: string, center?: Point) {
    return `${flat(query)}|${center ? `${center.latitude.toFixed(2)},${center.longitude.toFixed(2)}` : 'none'}`;
  }

  get(key: string, load: () => Promise<PlaceHit[]>): Promise<PlaceHit[]> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return Promise.resolve(entry.hits);
    }
    if (entry) this.entries.delete(key);
    const running = this.pending.get(key);
    if (running) return running;
    const request = load().then(
      (hits) => {
        this.pending.delete(key);
        this.entries.set(key, {
          hits,
          expiresAt: this.now() + (hits.length ? CACHE_HIT_MS : CACHE_EMPTY_MS),
        });
        while (this.entries.size > CACHE_ENTRIES) {
          this.entries.delete(this.entries.keys().next().value as string);
        }
        return hits;
      },
      (error: unknown) => {
        this.pending.delete(key);
        throw error;
      },
    );
    this.pending.set(key, request);
    return request;
  }
}

export interface PlaceFinderOptions {
  search(query: PlaceSearch): Promise<readonly PlaceHit[]>;
  catalogue?: StationCatalogue;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

let bundled: StationCatalogue | undefined;

/** Kakao keyword search joined with the station list, one retry, and a station-only answer when Kakao is out. */
export class PlaceFinder {
  private readonly catalogue: StationCatalogue;
  private readonly cache: PlaceSearchCache;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: PlaceFinderOptions) {
    this.catalogue = options.catalogue ?? (bundled ??= bundledStations());
    this.now = options.now ?? Date.now;
    this.wait =
      options.wait ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
    this.cache = new PlaceSearchCache(this.now);
  }

  async find(input: PlaceSearch) {
    const center =
      input.latitude !== undefined && input.longitude !== undefined
        ? { latitude: input.latitude, longitude: input.longitude }
        : undefined;
    const text = placeQueryText(input.q);
    if (!text) return placeSearchResult([], 'kakao', !!center, this.now());
    const stem = text.replace(STOP_SUFFIX, '').trim() || text;
    const match = this.catalogue.match(stem, center ?? PLACE_SEARCH_CENTER);
    const query = match.kakaoQuery ?? text;
    let hits: readonly PlaceHit[];
    try {
      hits = await this.cache.get(PlaceSearchCache.key(text, center), async () => {
        const found = await this.attempt({ ...input, q: query });
        if (stem === text || found.some((hit) => flat(hit.name).includes(flat(stem)))) {
          return [...found];
        }
        // The first answer stands when the second query fails.
        const again = await this.attempt({ ...input, q: stem }).catch(() => found);
        return [...(again.length ? again : found)];
      });
    } catch (error) {
      if (!(error instanceof ApiError) || !FALLBACK_CODES.has(error.code)) throw error;
      const places = mergePlaceHits([], match, center);
      if (places.length) {
        return placeSearchResult(places, 'station-catalogue', !!center, this.now());
      }
      // 503, not 429: the app reads 429 as its own crowding and would say to retry shortly.
      if (error.code === 'PROVIDER_LIMIT') {
        throw new ApiError(
          'PROVIDER_LIMIT',
          '오늘 장소 검색 한도를 다 썼어요. 역 이름으로는 계속 찾을 수 있어요.',
          503,
        );
      }
      throw error;
    }
    return placeSearchResult(mergePlaceHits(hits, match, center), 'kakao', !!center, this.now());
  }

  /** Without a place-search key: the app's registered places and the station list. */
  local(input: PlaceSearch) {
    const text = placeQueryText(input.q);
    const needle = flat(text);
    const registered: PlaceHit[] = needle
      ? PLACES.filter((place) => flat(`${place.name}${place.address}`).includes(needle)).map(
          (place) => ({
            ...place,
            id: `time-place-${place.id}`,
            address: `${place.address.split(' · ')[0]} · 시간 비교용 등록 장소`,
            note: '등록된 참고 위치입니다. 실제 출입구·경로는 별도 확인이 필요합니다.',
          }),
        )
      : [];
    const center =
      input.latitude !== undefined && input.longitude !== undefined
        ? { latitude: input.latitude, longitude: input.longitude }
        : undefined;
    const stations = text
      ? mergePlaceHits([], this.catalogue.match(text, center ?? PLACE_SEARCH_CENTER), center)
      : [];
    return placeSearchResult([...registered, ...stations], 'local-catalogue', !!center, this.now());
  }

  private async attempt(query: PlaceSearch): Promise<readonly PlaceHit[]> {
    const started = this.now();
    try {
      return await this.options.search(query);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !RETRY_CODES.has(error.code) ||
        this.now() - started > RETRY_WITHIN_MS
      ) {
        throw error;
      }
      await this.wait(RETRY_DELAY_MS);
      return this.options.search(query);
    }
  }
}
