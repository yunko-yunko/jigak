import { readFileSync } from 'node:fs';
import { ASSUMPTIONS } from './assumptions.js';
import { dataFile, type DayType } from './calendar.js';
import {
  bundledFootWeights,
  footDock,
  footDocks,
  footLayerAt,
  type FootWeights,
} from './foot-traffic.js';

/** The bundled 따릉이-derived demand file (mvp/scripts/build-shared-mobility-demand.py). */
interface DemandFile {
  version: string;
  days: Record<DayType, number>;
  docks: [number, number][];
  rent: Record<DayType, number[][]>;
  ret: Record<DayType, number[][]>;
  od: [number, number, number][];
  loopShare: number;
}

/**
 * Tables derived once from the demand file. 따릉이 usage only shapes where and when riders
 * appear; the number of riders comes from arrivals per vehicle (§5.2).
 */
export interface Demand {
  count: number;
  /** Dock coordinates, lat/lon interleaved. */
  docks: Float64Array;
  /** Rentals and returns per dock-hour per day, indexed dock * 24 + KST hour. */
  rent: Record<DayType, Float64Array>;
  ret: Record<DayType, Float64Array>;
  dailyRentals: Record<DayType, number>;
  /** Cumulative template placement weights per day type. */
  placement: Record<DayType, Float64Array>;
  /** Origin → destination pairs as CSR: odStart[origin]..odStart[origin + 1]. */
  odStart: Int32Array;
  odTo: Int32Array;
  /** Cumulative trips within each origin's slice. */
  odCumulative: Float64Array;
  /** Share of an origin's non-loop rides that the bundled pair table explains. */
  odShare: Float64Array;
  loopShare: number;
  /** Rentals plus returns over the mean dock-hour, clipped (§7.1), indexed dock * 24 + hour. */
  busy: Record<DayType, Float32Array>;
  busyMax: Float32Array;
  /** The busiest 10% of docks by daily volume (§6.1 designated spots, §6.3 station guess). */
  top: Uint8Array;
}

export function parseDemand(raw: unknown, foot: FootWeights | null = bundledFootWeights()): Demand {
  const file = raw as DemandFile;
  const count = Array.isArray(file?.docks) ? file.docks.length : 0;
  const table = (rows: unknown) =>
    Array.isArray(rows) &&
    rows.length === count &&
    rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 24 &&
        row.every((value) => Number.isFinite(value) && value >= 0),
    );
  if (
    file?.version !== 'seoul-shared-demand-v1' ||
    count < 10 ||
    !file.docks.every(
      (dock) =>
        Array.isArray(dock) &&
        Number.isFinite(dock[0]) &&
        Number.isFinite(dock[1]) &&
        Math.abs(dock[0]) <= 90 &&
        Math.abs(dock[1]) <= 180,
    ) ||
    !(['weekday', 'weekend'] as const).every(
      (day) => table(file.rent?.[day]) && table(file.ret?.[day]) && Number(file.days?.[day]) > 0,
    ) ||
    !Array.isArray(file.od) ||
    !(file.loopShare >= 0 && file.loopShare < 1)
  )
    throw new TypeError('Invalid shared mobility demand file');

  const docks = new Float64Array(count * 2);
  file.docks.forEach(([latitude, longitude], index) => {
    docks[index * 2] = latitude;
    docks[index * 2 + 1] = longitude;
  });
  const flatten = (rows: number[][]) => {
    const values = new Float64Array(count * 24);
    rows.forEach((row, dock) =>
      row.forEach((value, hour) => (values[dock * 24 + hour] = value / 10)),
    );
    return values;
  };
  const rent = { weekday: flatten(file.rent.weekday), weekend: flatten(file.rent.weekend) };
  const ret = { weekday: flatten(file.ret.weekday), weekend: flatten(file.ret.weekend) };
  const sum = (values: Float64Array) => values.reduce((total, value) => total + value, 0);
  const dailyRentals = { weekday: sum(rent.weekday), weekend: sum(rent.weekend) };

  const [firstHour, lastHour] = ASSUMPTIONS.demand.placementHours;
  const placement = {} as Record<DayType, Float64Array>;
  const busy = {} as Record<DayType, Float32Array>;
  const busyMax = new Float32Array(count);
  const [busyLow, busyHigh] = ASSUMPTIONS.complaints.busyClip;
  // §22 the template leans on foot traffic as the crews' targets do (`foot.targetBlend`).
  const mass = foot ? footDocks(foot, docks) : null;
  for (const day of ['weekday', 'weekend'] as const) {
    const floor = (dailyRentals[day] / count / 24) * ASSUMPTIONS.demand.placementFloorShare;
    const early = new Float64Array(count),
      people = new Float64Array(count);
    let earlyTotal = 0,
      peopleTotal = 0;
    for (let dock = 0; dock < count; dock++) {
      for (let hour = firstHour; hour <= lastHour; hour++)
        early[dock] += rent[day][dock * 24 + hour];
      early[dock] += floor;
      earlyTotal += early[dock];
      if (mass)
        for (let hour = firstHour; hour <= lastHour; hour++)
          people[dock] += footDock(mass, dock, footLayerAt(day, hour));
      peopleTotal += people[dock];
    }
    const blend = peopleTotal > 0 ? ASSUMPTIONS.foot.targetBlend : 0;
    const cumulative = new Float64Array(count);
    let total = 0;
    for (let dock = 0; dock < count; dock++)
      cumulative[dock] = total +=
        (1 - blend) * (early[dock] / earlyTotal) +
        (blend > 0 ? (blend * people[dock]) / peopleTotal : 0);
    placement[day] = cumulative;
    const mean = (dailyRentals[day] + sum(ret[day])) / (count * 24);
    const values = new Float32Array(count * 24);
    for (let index = 0; index < count * 24; index++) {
      const ratio = mean > 0 ? (rent[day][index] + ret[day][index]) / mean : 1;
      values[index] = Math.min(busyHigh, Math.max(busyLow, ratio));
      const dock = Math.floor(index / 24);
      if (values[index] > busyMax[dock]) busyMax[dock] = values[index];
    }
    busy[day] = values;
  }

  // Pair table as CSR, keeping only valid pairs in file order.
  const perOrigin = new Int32Array(count + 1);
  const valid = file.od.filter((pair) => {
    const [from, to, trips] = pair;
    const ok =
      Number.isInteger(from) &&
      Number.isInteger(to) &&
      from >= 0 &&
      to >= 0 &&
      from < count &&
      to < count &&
      from !== to &&
      trips > 0;
    if (ok) perOrigin[from + 1]++;
    return ok;
  });
  for (let index = 0; index < count; index++) perOrigin[index + 1] += perOrigin[index];
  const odTo = new Int32Array(valid.length),
    odCumulative = new Float64Array(valid.length);
  const cursor = perOrigin.slice(0, count);
  for (const [from, to, trips] of valid) {
    const slot = cursor[from]++;
    odTo[slot] = to;
    odCumulative[slot] = (slot > perOrigin[from] ? odCumulative[slot - 1] : 0) + trips;
  }
  const odShare = new Float64Array(count);
  for (let origin = 0; origin < count; origin++) {
    const from = perOrigin[origin],
      to = perOrigin[origin + 1];
    if (from === to) continue;
    let monthly = 0;
    for (let hour = 0; hour < 24; hour++)
      monthly +=
        rent.weekday[origin * 24 + hour] * file.days.weekday +
        rent.weekend[origin * 24 + hour] * file.days.weekend;
    odShare[origin] =
      monthly > 0 ? Math.min(1, odCumulative[to - 1] / (monthly * (1 - file.loopShare))) : 1;
  }

  const volume = new Float64Array(count);
  for (let dock = 0; dock < count; dock++)
    for (let hour = 0; hour < 24; hour++)
      volume[dock] += rent.weekday[dock * 24 + hour] + ret.weekday[dock * 24 + hour];
  const ranked = Array.from({ length: count }, (_, index) => index).sort(
    (left, right) => volume[right] - volume[left] || left - right,
  );
  const top = new Uint8Array(count);
  const topCount = Math.max(1, Math.round(count * ASSUMPTIONS.parking.designated.topDockShare));
  for (let index = 0; index < topCount; index++) top[ranked[index]] = 1;

  return {
    count,
    docks,
    rent,
    ret,
    dailyRentals,
    placement,
    odStart: perOrigin,
    odTo,
    odCumulative,
    odShare,
    loopShare: file.loopShare,
    busy,
    busyMax,
    top,
  };
}

let bundled: Demand | null = null;

/** The bundled demand; a missing or malformed file throws, so startup fails loudly. */
export function bundledDemand(): Demand {
  bundled ??= parseDemand(
    JSON.parse(readFileSync(dataFile('shared-mobility-demand-v1.json'), 'utf8')),
  );
  return bundled;
}
