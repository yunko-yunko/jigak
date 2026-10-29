import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BaseRoute, BaseSegment, Place, Risk } from '../../shared/domain/index.js';
import { metersBetween, stationBaseName, subwayLineId } from '../realtime/names.js';

interface TransferReference {
  station: string;
  fromLine: string;
  toLine: string;
  distanceMeters: number;
  durationSeconds: number;
}

const CATALOG_URL = 'https://www.data.go.kr/data/15044419/fileData.do';
const SNAPSHOT_HASH = '434216e2c26fa7149ae7566badfa9938f87e83f28deb542aab68e1b10a9dc822';
const NOTE_TITLE = '공식 환승 참고시간';

// Only tolerates provider coordinate rounding, not a fabricated bridge between paths.
const JOIN_TOLERANCE_METERS = 5;

/** The downloadable file contains mm:ss even though the catalog calls its field seconds. */
export function parseTransferDuration(value: string): number | null {
  const match = /^([0-9]{2}):([0-5][0-9])$/.exec(value);

  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function lineKey(line: string): string | null {
  const numericLine = /^[1-9]$/.test(line) ? `${line}호선` : line;
  const known = subwayLineId(numericLine);

  if (known) {
    return known;
  }

  const key = line.normalize('NFC').replace(/\s+/g, '');

  if (key === '신림선' || key === '김포골드라인') {
    return key;
  }

  // "국철" does not identify a specific service and is deliberately not aliased.
  return null;
}

function referenceKey(station: string, fromLine: string, toLine: string): string | null {
  const from = lineKey(fromLine),
    to = lineKey(toLine),
    stop = stationBaseName(station);

  return stop && from && to && from !== to ? `${stop}:${from}:${to}` : null;
}

function loadReferences(): Map<string, TransferReference> {
  try {
    const raw = readFileSync(new URL('./data/seoul-metro-transfers.csv', import.meta.url));

    if (createHash('sha256').update(raw).digest('hex') !== SNAPSHOT_HASH) {
      return new Map();
    }

    const [header, ...rows] = new TextDecoder('euc-kr').decode(raw).trimEnd().split(/\r?\n/);

    if (header !== '연번,호선,환승역명,환승노선,환승거리,환승소요시간' || rows.length !== 145) {
      return new Map();
    }

    const references = new Map<string, TransferReference>();
    const duplicates = new Set<string>();

    for (const row of rows) {
      const fields = row.split(',');

      if (fields.length !== 6) {
        return new Map();
      }

      const [, fromLine, station, toLine, distance, time] = fields;
      const durationSeconds = parseTransferDuration(time);

      if (!/^[0-9]+$/.test(distance) || durationSeconds === null) {
        return new Map();
      }

      const key = referenceKey(station, fromLine, toLine);

      if (!key) {
        continue;
      }

      if (references.has(key)) {
        duplicates.add(key);
        continue;
      }

      references.set(key, {
        station,
        fromLine: `${fromLine}호선`,
        toLine,
        distanceMeters: Number(distance),
        durationSeconds,
      });
    }

    for (const key of duplicates) {
      references.delete(key);
    }

    return references;
  } catch {
    // A missing or corrupt static file must not produce a false official claim.
    return new Map();
  }
}

const REFERENCES = loadReferences();

/** Direction matters: an absent reverse row is not synthesized from a forward row. */
export function findStationTransferReference(
  station: string,
  fromLine: string,
  toLine: string,
): Readonly<TransferReference> | null {
  const key = referenceKey(station, fromLine, toLine);

  return key ? (REFERENCES.get(key) ?? null) : null;
}

function validPoint(point: { latitude: number; longitude: number }): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
  );
}

function bufferSeconds(segment: BaseSegment): number | null {
  const buffer = segment.planningBuffer;
  const components = buffer ? [buffer.weatherSeconds, buffer.calibrationSeconds] : [0];

  if (components.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return null;
  }

  const total = components.reduce((sum, value) => sum + value, 0);
  const { min, max } = segment.durationSeconds;

  return Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 0 && max >= min + total
    ? total
    : null;
}

function samePoint(left: Place, right: Place): boolean {
  return (
    validPoint(left) && validPoint(right) && metersBetween(left, right) <= JOIN_TOLERANCE_METERS
  );
}

function physicalWalk(segment: BaseSegment, station: string): boolean {
  const points = segment.polyline;

  return (
    segment.mode === 'walk' &&
    stationBaseName(segment.start.name) === station &&
    stationBaseName(segment.end.name) === station &&
    !!points &&
    points.length >= 2 &&
    points.every(validPoint) &&
    points.some(
      (point) => point.latitude !== points[0].latitude || point.longitude !== points[0].longitude,
    ) &&
    validPoint(segment.start) &&
    validPoint(segment.end) &&
    metersBetween(points[0], segment.start) <= JOIN_TOLERANCE_METERS &&
    metersBetween(points.at(-1)!, segment.end) <= JOIN_TOLERANCE_METERS &&
    bufferSeconds(segment) !== null
  );
}

function singleLine(segment: BaseSegment): string | null {
  return segment.mode === 'subway' && segment.transit?.lines.length === 1
    ? segment.transit.lines[0]
    : null;
}

function referenceNote(reference: TransferReference, segmentId: string): Risk {
  return {
    code: 'unverified-duration-range',
    severity: 'info',
    title: NOTE_TITLE,
    segmentId,
    description: `${reference.station} ${reference.fromLine} → ${reference.toLine}: 공식 환승거리 ${reference.distanceMeters}m·참고시간 ${reference.durationSeconds}초를 늦은 도착 예상에 반영했어요. 평균 보행속도 1.2m/s로 계산한 정적 참고값이며 개인 실측속도나 실시간 혼잡도·시설 상태가 아니에요. 원본 파일 기준 2025-12-31(카탈로그 표시 2026-08-31, 날짜 불일치). 서울교통공사: ${CATALOG_URL}`,
  };
}

/**
 * Apply before live connection materialization / graph search. A reference is an
 * upper-range supplement to an existing continuous provider walk, never another
 * additive transfer leg or invented station interior geometry. Unclassified
 * provider allowances remain unclassified and are not treated as walking time.
 */
export function applyStationTransferReferences(routes: readonly BaseRoute[]): BaseRoute[] {
  return routes.map((route) => {
    if (
      route.timingEvaluatedAt !== undefined ||
      route.segments.some((segment) => segment.plannedConnection)
    ) {
      return route;
    }

    const segments = [...route.segments],
      notes = [...(route.notes ?? [])];
    let changed = false;

    for (let index = 0; index < segments.length - 2; index += 1) {
      const previous = segments[index],
        fromLine = singleLine(previous);

      if (!fromLine || !previous.transit?.stops.length) {
        continue;
      }

      let nextIndex = index + 1;

      while (segments[nextIndex]?.mode === 'walk') {
        nextIndex += 1;
      }

      if (nextIndex === index + 1) {
        continue;
      }

      const next = segments[nextIndex];

      if (!next) {
        continue;
      }

      const toLine = singleLine(next);
      const station = stationBaseName(previous.end.name);

      if (
        !toLine ||
        !next.transit?.stops.length ||
        station !== stationBaseName(next.start.name) ||
        station !== stationBaseName(previous.transit.stops.at(-1)!) ||
        station !== stationBaseName(next.transit.stops[0])
      ) {
        continue;
      }

      const reference = findStationTransferReference(station, fromLine, toLine);

      if (!reference) {
        continue;
      }

      const walks = segments.slice(index + 1, nextIndex);

      if (!walks.every((walk) => physicalWalk(walk, station))) {
        continue;
      }

      if (
        ![previous, ...walks].every((segment, offset) =>
          samePoint(segment.end, [...walks, next][offset].start),
        )
      ) {
        continue;
      }

      const currentUpper = walks.reduce((sum, walk) => sum + walk.durationSeconds.max, 0);
      const includedBuffers = walks.reduce((sum, walk) => sum + bufferSeconds(walk)!, 0);
      const shortfall = Math.max(0, reference.durationSeconds + includedBuffers - currentUpper);
      const lastWalkIndex = nextIndex - 1;
      const walk = segments[lastWalkIndex];

      if (shortfall) {
        segments[lastWalkIndex] = {
          ...walk,
          durationSeconds: {
            ...walk.durationSeconds,
            max: walk.durationSeconds.max + shortfall,
          },
        };
      }

      if (!notes.some((note) => note.title === NOTE_TITLE && note.segmentId === walk.id)) {
        notes.push(referenceNote(reference, walk.id));
      }

      changed = true;
      index = nextIndex - 1;
    }

    return changed
      ? {
          ...route,
          segments,
          notes,
          durationSeconds: segments.reduce(
            (sum, segment) => ({
              min: sum.min + segment.durationSeconds.min,
              max: sum.max + segment.durationSeconds.max,
            }),
            {
              min: 0,
              max: 0,
            },
          ),
        }
      : route;
  });
}
