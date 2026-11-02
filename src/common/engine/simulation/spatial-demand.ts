import { ASSUMPTIONS } from './assumptions.js';
import type { DayType } from './calendar.js';
import type { Demand } from './demand.js';
import { buildDestinationChoice, type DestinationChoice } from './destination-choice.js';
import {
  bundledFootWeights,
  FOOT_LAYERS,
  footCellCenter,
  footCells,
  footDock,
  footDocks,
  footLayerAt,
  type FootWeights,
} from './foot-traffic.js';
import type { Fleets } from './sim-engine.js';

/** Where and when riders want a vehicle (§5.2), built once per window from the demand table. */
export interface SpatialDemand {
  /** Arrivals per vehicle scale, per day type (§5.2): the sum over vehicle types. */
  scale: Record<DayType, number>;
  /** Each type's share of the arrivals per day type, [scooter, e-bike]. */
  arrivalShare: Record<DayType, readonly number[]>;
  /** Expected rentals per 500 m cell and hour (season applied when read). */
  cellDemand: Record<DayType, Float32Array>;
  /** The busiest dock of each 500 m cell, where crews drop vehicles (-1 none). */
  cellDock: Int32Array;
  /** Per vehicle type, riders per hour at each dock (dock * 24 + hour) before season; null = global share. */
  dockRate: Record<DayType, Float32Array>[] | null;
  /** E-bike share of the riders at each dock and hour (dock * 24 + hour); null = `arrivalShare`. */
  ebikeShare: Record<DayType, Float32Array> | null;
  /** Weight of each dock as a trip end (dock * 24 + hour); null = the demand table's returns. */
  returnWeight: Record<DayType, Float32Array> | null;
  /** Per vehicle type, expected rentals per 500 m cell and hour before season; null = `cellDemand` by share. */
  cellDemandOf: Record<DayType, Float32Array>[] | null;
  /** Per foot-traffic layer, each engine cell's share of the placement target (sums to 1); null = demand only. */
  footTarget: Float32Array[] | null;
  /**
   * The scooter's `footTarget` (§22): the 구 shares (`foot.scooterGuShare`) first, then w^γ inside
   * each 구 (a cell's 구 is its nearest dock's); null without the file.
   */
  scooterFootTarget: Float32Array[] | null;
  /** Per foot-traffic layer, each engine cell's mean 250 m weight (layer * cells + cell); null without the file. */
  footCell: Float32Array | null;
  /** §22.10 where riders off the pair table end their trips: ring gravity with a daily balance. */
  destinations: DestinationChoice;
}

const DAYS = ['weekday', 'weekend'] as const;
const SCOOTER = 0,
  EBIKE = 1;

/**
 * §22 riders per hour of one type before season, per day type: `ridersPerDay × typeShare` over
 * the 따릉이 day total, scaled down linearly when the type's fleet is below the real one (a test
 * fleet keeps the real demand per vehicle) and never up above it.
 */
function typeScales(demand: Demand, fleets: Fleets): Record<DayType, number[]> {
  const { ridersPerDay, typeShare } = ASSUMPTIONS.demand;
  const counts = [fleets.scooter, fleets.ebike],
    defaults = [ASSUMPTIONS.fleet.scooterDefault, ASSUMPTIONS.fleet.ebikeDefault];
  const of = (day: DayType) =>
    counts.map(
      (count, type) =>
        (ridersPerDay[day] * typeShare[day][type] * Math.min(1, count / defaults[type])) /
        demand.dailyRentals[day],
    );
  return { weekday: of('weekday'), weekend: of('weekend') };
}

/**
 * Builds the per-window demand map on the engine's 500 m cell grid (§5.2, §22): riders per dock
 * and hour by type, blended from the 따릉이 table and the foot mass the dock serves; the scooter's
 * riders shared over the 자치구 first. Without the foot file, the 따릉이 table alone.
 */
export function buildSpatialDemand(
  demand: Demand,
  fleets: Fleets,
  grid: { cells: number; cell(lat: number, lon: number): number },
  foot: FootWeights | null = bundledFootWeights(),
): SpatialDemand {
  const count = demand.count,
    cells = grid.cells;
  const parts = typeScales(demand, fleets);
  // A scooter-only run has no e-bike riders.
  const total = (values: number[]) => (fleets.ebike > 0 ? values[0] + values[1] : values[0]);
  const scale = { weekday: total(parts.weekday), weekend: total(parts.weekend) };
  const arrivalShare = {
    weekday: parts.weekday.map((part) => (scale.weekday > 0 ? part / scale.weekday : 0)),
    weekend: parts.weekend.map((part) => (scale.weekend > 0 ? part / scale.weekend : 0)),
  };

  const blend = ASSUMPTIONS.foot.blend;
  const guShares = ASSUMPTIONS.foot.scooterGuShare as Readonly<Record<string, number>>;
  const mass = foot && foot.guOfDock.length === count ? footDocks(foot, demand.docks) : null;
  const guOf = mass ? foot!.guOfDock : null;
  const guCount = foot ? foot.gu.length : 0;
  const guShare = foot ? foot.gu.map((name) => guShares[name] ?? 0) : [];

  const newTable = () => ({
    weekday: new Float32Array(count * 24),
    weekend: new Float32Array(count * 24),
  });
  const dockRate = [newTable(), newTable()];
  const returnWeight = newTable();
  const ebikeShare = newTable();
  const footOf = new Float64Array(count),
    guRent = new Float64Array(guCount),
    guFoot = new Float64Array(guCount),
    guRet = new Float64Array(guCount);
  for (const day of DAYS) {
    const rent = demand.rent[day],
      ret = demand.ret[day],
      weights = ASSUMPTIONS.demand.hourWeights[day];
    // Hour weights reshape the 따릉이 day without changing its total (R-DEMAND §3.2).
    let weighted = 0;
    for (let dock = 0; dock < count; dock++)
      for (let hour = 0; hour < 24; hour++) weighted += rent[dock * 24 + hour] * weights[hour];
    const norm = weighted > 0 ? demand.dailyRentals[day] / weighted : 0;
    const [scooterScale, ebikeScale] = parts[day];
    const share = arrivalShare[day];
    for (let hour = 0; hour < 24; hour++) {
      const hourWeight = weights[hour] * norm;
      let rentSum = 0,
        retSum = 0,
        footSum = 0;
      guRent.fill(0);
      guFoot.fill(0);
      guRet.fill(0);
      const layers = footLayerAt(day, hour);
      for (let dock = 0; dock < count; dock++) {
        const slot = dock * 24 + hour;
        const value = mass ? footDock(mass, dock, layers) : 0;
        footOf[dock] = value;
        rentSum += rent[slot] * hourWeight;
        retSum += ret[slot];
        footSum += value;
        const gu = guOf ? guOf[dock] : -1;
        if (gu >= 0) {
          guRent[gu] += rent[slot] * hourWeight;
          guFoot[gu] += value;
          guRet[gu] += ret[slot];
        }
      }
      for (let dock = 0; dock < count; dock++) {
        const slot = dock * 24 + hour;
        const rentHere = rent[slot] * hourWeight,
          footShare = footSum > 0 ? footOf[dock] / footSum : 0;
        // E-bikes: (1 − b) of the 따릉이 riders stay, b go where the foot mass is (U-FOOT §4.2).
        const ebikeB = footSum > 0 ? blend[EBIKE] : 0;
        const ebike = ((1 - ebikeB) * rentHere + ebikeB * rentSum * footShare) * ebikeScale;
        const ebikeEnd = (1 - ebikeB) * ret[slot] + ebikeB * retSum * footShare;
        // Scooters: the 구 total first (R-DEMAND §4.2), then the docks of the 구 by the same blend;
        // the 구 weight and the foot weight are never multiplied (U-FOOT §4.4).
        const gu = guOf ? guOf[dock] : -1;
        let scooter = rentHere * scooterScale,
          scooterEnd = ret[slot];
        if (gu >= 0) {
          const scooterB = guFoot[gu] > 0 ? (guRent[gu] > 0 ? blend[SCOOTER] : 1) : 0;
          const rentShare = guRent[gu] > 0 ? rentHere / guRent[gu] : 0,
            footInGu = guFoot[gu] > 0 ? footOf[dock] / guFoot[gu] : 0,
            retShare = guRet[gu] > 0 ? ret[slot] / guRet[gu] : 0;
          const scooterEndB = guFoot[gu] > 0 ? (guRet[gu] > 0 ? blend[SCOOTER] : 1) : 0;
          scooter =
            rentSum *
            scooterScale *
            guShare[gu] *
            ((1 - scooterB) * rentShare + scooterB * footInGu);
          scooterEnd =
            retSum * guShare[gu] * ((1 - scooterEndB) * retShare + scooterEndB * footInGu);
        }
        dockRate[SCOOTER][day][slot] = scooter;
        dockRate[EBIKE][day][slot] = ebike;
        ebikeShare[day][slot] = scooter + ebike > 0 ? ebike / (scooter + ebike) : share[EBIKE];
        returnWeight[day][slot] = share[SCOOTER] * scooterEnd + share[EBIKE] * ebikeEnd;
      }
    }
  }

  const cellDemand = {
    weekday: new Float32Array(cells * 24),
    weekend: new Float32Array(cells * 24),
  };
  const cellDemandOf = [0, 1].map(() => ({
    weekday: new Float32Array(cells * 24),
    weekend: new Float32Array(cells * 24),
  }));
  const cellDock = new Int32Array(cells).fill(-1);
  const best = new Float64Array(cells);
  for (let dock = 0; dock < count; dock++) {
    const cell = grid.cell(demand.docks[dock * 2], demand.docks[dock * 2 + 1]);
    if (cell < 0) continue;
    let volume = 0;
    for (const day of DAYS)
      for (let hour = 0; hour < 24; hour++)
        for (let type = 0; type < 2; type++) {
          const rate = dockRate[type][day][dock * 24 + hour];
          cellDemandOf[type][day][cell * 24 + hour] += rate;
          cellDemand[day][cell * 24 + hour] += rate;
          volume += rate;
        }
    if (volume > best[cell] || cellDock[cell] < 0) {
      best[cell] = volume;
      cellDock[cell] = dock;
    }
  }

  // §22 crews aim part of each type's street fleet at the foot hot spots: w^γ over the cells.
  let footTarget: Float32Array[] | null = null,
    scooterFootTarget: Float32Array[] | null = null,
    footCell: Float32Array | null = null;
  if (foot) {
    footCell = footCells(foot, grid);
    const powered = (gamma: number) =>
      FOOT_LAYERS.map((_, layer) => {
        const target = new Float32Array(cells);
        let sum = 0;
        for (let cell = 0; cell < cells; cell++) {
          const weight = footCell![layer * cells + cell];
          if (weight > 0) sum += target[cell] = Math.pow(weight, gamma);
        }
        if (sum > 0) for (let cell = 0; cell < cells; cell++) target[cell] /= sum;
        return target;
      });
    footTarget = powered(ASSUMPTIONS.foot.targetGamma);
    // §22.9 scooters gather at the busiest blocks of their 구 more than e-bikes (가정값).
    const scooterBase = powered(ASSUMPTIONS.foot.scooterTargetGamma);
    // A cell's 구 is that of the dock nearest its centre (U-FOOT §4.4: 구 totals, then w inside).
    if (guOf) {
      const cellGu = new Int16Array(cells).fill(-1);
      const dockOfCell = new Int32Array(cells).fill(-1);
      const best = new Float64Array(cells).fill(Infinity);
      const centre = new Float64Array(cells * 2).fill(NaN);
      for (const listed of foot.listed) {
        const [latitude, longitude] = footCellCenter(foot, listed);
        const cell = grid.cell(latitude, longitude);
        if (cell >= 0 && Number.isNaN(centre[cell * 2])) {
          centre[cell * 2] = latitude;
          centre[cell * 2 + 1] = longitude;
        }
      }
      for (let cell = 0; cell < cells; cell++) {
        if (Number.isNaN(centre[cell * 2])) continue;
        for (let dock = 0; dock < count; dock++) {
          const dy = demand.docks[dock * 2] - centre[cell * 2],
            dx = (demand.docks[dock * 2 + 1] - centre[cell * 2 + 1]) * 0.79;
          const d = dy * dy + dx * dx;
          if (d < best[cell]) {
            best[cell] = d;
            dockOfCell[cell] = dock;
          }
        }
        if (dockOfCell[cell] >= 0) cellGu[cell] = guOf[dockOfCell[cell]];
      }
      const guBlend = ASSUMPTIONS.foot.scooterGuTargetShare;
      scooterFootTarget = scooterBase.map((target) => {
        const guSum = new Float64Array(guCount);
        for (let cell = 0; cell < cells; cell++)
          if (cellGu[cell] >= 0) guSum[cellGu[cell]] += target[cell];
        const scooter = new Float32Array(cells);
        for (let cell = 0; cell < cells; cell++) {
          const gu = cellGu[cell];
          const inGu = gu >= 0 && guSum[gu] > 0 ? (guShare[gu] * target[cell]) / guSum[gu] : 0;
          scooter[cell] = guBlend * inGu + (1 - guBlend) * target[cell];
        }
        return scooter;
      });
    }
  }

  return {
    scale,
    arrivalShare,
    cellDemand,
    cellDock,
    dockRate,
    ebikeShare,
    returnWeight,
    cellDemandOf,
    footTarget,
    scooterFootTarget,
    footCell,
    destinations: buildDestinationChoice(demand, dockRate, returnWeight),
  };
}
