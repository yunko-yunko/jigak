// Builds the station list that place search uses for exact names, aliases, prefixes and typos.
// Source: mvp/data/spatial-transit-stations-20261029/stations.csv (UTF-8 with BOM; one row per station and line,
// transfer-station coordinates). Writes the same bytes to the NestJS backend and to the legacy server copy.
// Run from jigak-backend: node scripts/build-place-stations.mjs
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ROOT, 'mvp', 'data', 'spatial-transit-stations-20261029', 'stations.csv');
const VERSION = 'place-stations-v1';
const OUTPUTS = [
  join(ROOT, 'jigak-backend', 'src', 'modules', 'places', 'data', `${VERSION}.json`),
  join(ROOT, 'mvp', 'server', 'places', `${VERSION}.json`),
];
/** Same name within this distance is one station; farther apart they stay separate (양평 5호선 vs 중앙선). */
const MERGE_METERS = 1_000;
/** Line names the app's subwayLineColor reads. */
const LINE_NAMES = {
  경부선: '1호선',
  경원선: '1호선',
  경인선: '1호선',
  장항선: '1호선',
  안산선: '4호선',
  과천선: '4호선',
  진접선: '4호선',
  일산선: '3호선',
  중앙선: '경의중앙선',
  분당선: '수인분당선',
  수인선: '수인분당선',
  별내선: '8호선',
  '수도권 광역급행철도': 'GTX-A',
};

const meters = (a, b) => {
  const radians = Math.PI / 180;
  const x =
    (b.longitude - a.longitude) * radians * Math.cos(((a.latitude + b.latitude) / 2) * radians);
  return 6_371_000 * Math.hypot(x, (b.latitude - a.latitude) * radians);
};
const lineName = (raw) => {
  const line = raw.trim().replace(/\((?:연장\d*|인천)\)$/, '');
  return LINE_NAMES[line] ?? line;
};
const lineOrder = (a, b) => {
  const left = /^(\d+)호선$/.exec(a),
    right = /^(\d+)호선$/.exec(b);
  if (left && right) return Number(left[1]) - Number(right[1]);
  if (left || right) return left ? -1 : 1;
  return a.localeCompare(b, 'ko');
};

const text = readFileSync(SOURCE, 'utf8').replace(/^﻿/, '');
const [header, ...lines] = text.split(/\r?\n/).filter((line) => line.trim());
const columns = header.split(',');
const at = (name) => {
  const index = columns.indexOf(name);
  if (index < 0) throw new Error(`missing-column:${name}`);
  return index;
};
const NAME = at('역한글명칭'),
  LINE = at('호선명칭'),
  X = at('환승역X좌표'),
  Y = at('환승역Y좌표');

const rows = [];
for (const line of lines) {
  const cells = line.split(',');
  const raw = cells[NAME].trim();
  const longitude = Number(cells[X]),
    latitude = Number(cells[Y]);
  if (!raw || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  const paren = /^(.+?)\((.+)\)$/.exec(raw);
  const name = (paren ? paren[1] : raw).trim();
  rows.push({
    name,
    // "서울역" and the GTX-A "서울" are one name.
    key: name.length > 2 ? name.replace(/역$/, '') : name,
    aliases: paren ? [paren[2].trim()] : [],
    line: lineName(cells[LINE]),
    latitude,
    longitude,
  });
}

const clusters = [];
for (const row of rows) {
  const cluster = clusters.find(
    (candidate) => candidate.key === row.key && meters(candidate.center, row) <= MERGE_METERS,
  );
  if (cluster) {
    cluster.rows.push(row);
    const count = cluster.rows.length;
    cluster.center = {
      latitude: cluster.rows.reduce((sum, item) => sum + item.latitude, 0) / count,
      longitude: cluster.rows.reduce((sum, item) => sum + item.longitude, 0) / count,
    };
  } else clusters.push({ key: row.key, rows: [row], center: { ...row } });
}

const stations = clusters
  .map((cluster) => {
    const names = new Map();
    for (const row of cluster.rows) names.set(row.name, (names.get(row.name) ?? 0) + 1);
    const name = [...names].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    return {
      name,
      aliases: [...new Set(cluster.rows.flatMap((row) => row.aliases))].sort(),
      lines: [...new Set(cluster.rows.map((row) => row.line))].sort(lineOrder),
      latitude: Number(cluster.center.latitude.toFixed(6)),
      longitude: Number(cluster.center.longitude.toFixed(6)),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.latitude - b.latitude);

if (stations.length < 500) throw new Error(`too-few-stations:${stations.length}`);
const result = {
  version: VERSION,
  source: {
    name: '수도권 도시철도 역 좌표 (spatial-transit-stations-20261029/stations.csv)',
    rows: rows.length,
    builtAt: Math.floor(statSync(SOURCE).mtimeMs),
  },
  stations,
};
const bytes = JSON.stringify(result) + '\n';
for (const output of OUTPUTS) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(`${output}.tmp`, bytes);
  renameSync(`${output}.tmp`, output);
}
console.log(
  JSON.stringify({
    rows: rows.length,
    stations: stations.length,
    split: stations
      .filter(
        (station, index, all) => all.findIndex((other) => other.name === station.name) !== index,
      )
      .map((station) => station.name),
    bytes: Buffer.byteLength(bytes),
  }),
);
