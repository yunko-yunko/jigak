import { ASSUMPTIONS } from './assumptions.js';
import {
  HOUR,
  MINUTE,
  dayTypeAt,
  inHourBand,
  kstDateIndex,
  kstHour,
  midnightOfIndex,
} from './calendar.js';
import { PURPOSE, Stream } from './keyed-random.js';
import { inSeocho } from './parking-rules.js';
import {
  CATEGORY,
  CATEGORY_NAMES,
  EV,
  FAULT,
  FIELD,
  FLAG,
  IMMEDIATE_TOW,
  IMMEDIATE_TOW_BY_TYPE,
  OP,
  REGIME,
  RESOLUTION,
  STAGE,
  VTYPE,
} from './sim-codes.js';
import type { Engine } from './sim-engine.js';
import { K } from './sim-kinds.js';

const SOURCE = { citizen: 0, district: 1, gyeonggi: 2 } as const;
const RES = Object.fromEntries(RESOLUTION.map((name, index) => [name, index])) as Record<
  (typeof RESOLUTION)[number],
  number
>;
const HAZARD = { FALL: 0, GPS: 1, THEFT: 2, VANDAL: 3, COMPLAINT: 4, DISTRICT: 5 } as const;

interface TowJob {
  vehicle: number;
  segment: number;
  region: number;
  /** 0 queued, 1 started, 2 done, 3 cancelled. */
  status: number;
}

interface Truck {
  region: number;
  latitude: number;
  longitude: number;
  busyUntil: number;
  job: number;
}

/** 서초구's removal zones as a category table (§19). */
const DISTRICT_ZONE = CATEGORY_NAMES.map((name) =>
  (ASSUMPTIONS.ebike.towing.district.categories as readonly string[]).includes(name),
);
const NO_TOW = IMMEDIATE_TOW_BY_TYPE[VTYPE.EBIKE];

/**
 * Street hazards of a parked vehicle and the district's enforcement (§3.5, §7): falls, GPS loss,
 * battery theft, vandalism, citizen complaints, district patrols, towing and impound lots.
 *
 * Each vehicle type has its own regime (§19). Scooters follow Seoul's PM towing. E-bikes are
 * bicycles that ordinance does not cover: a complaint notifies the operator, who must re-park
 * by a deadline, and 서초구 removes them from its five zones itself (no fee; the operator fetches
 * them from the lot). With the pending 2027 ordinance switched on, e-bikes are towed like
 * scooters at its fees.
 */
export class Enforcement {
  private readonly stream = new Stream();
  private readonly maxRates = new Float64Array(6);
  readonly jobs: TowJob[] = [];
  private readonly queues: number[][];
  private readonly heads: number[];
  readonly trucks: Truck[] = [];
  /** Per vehicle: was its tow at a rider's own immediate-tow violation (§7.2 cost pass-through). */
  readonly passThrough: Uint8Array;
  /** Per vehicle: the REGIME of its open complaint, kept until the lot releases it. */
  readonly regime: Uint8Array;

  constructor(private readonly e: Engine) {
    const lots = ASSUMPTIONS.lots;
    this.queues = lots.map(() => []);
    this.heads = lots.map(() => 0);
    // Trucks follow the vehicles Seoul tows: the scooters, and e-bikes only under the ordinance.
    const towed = e.fleets.scooter + (e.ordinance2027 ? e.fleets.ebike : 0);
    const perRegion = Math.max(1, Math.round((towed / 6_000) * ASSUMPTIONS.towing.trucksPer6000));
    lots.forEach((lot, region) => {
      for (let index = 0; index < perRegion; index++)
        this.trucks.push({
          region,
          latitude: lot.latitude,
          longitude: lot.longitude,
          busyUntil: 0,
          job: -1,
        });
    });
    this.passThrough = new Uint8Array(e.fleet);
    this.regime = new Uint8Array(e.fleet);
  }

  /** Does Seoul tow this vehicle: a scooter, or an e-bike under the 2027 ordinance? */
  towedType(vehicle: number): boolean {
    return this.e.vType[vehicle] === VTYPE.SCOOTER || this.e.ordinance2027;
  }

  /** Categories towed right after a complaint, for this vehicle's type and the rules in force. */
  towTable(vehicle: number): readonly boolean[] {
    return this.towedType(vehicle) ? IMMEDIATE_TOW : NO_TOW;
  }

  /** An e-bike Seoul does not tow, standing in one of 서초구's removal zones. */
  districtZone(vehicle: number, category: number): boolean {
    const e = this.e;
    return (
      !this.towedType(vehicle) &&
      DISTRICT_ZONE[category] &&
      inSeocho(e.lat[vehicle], e.lon[vehicle])
    );
  }

  /** Tow and storage fees owed at release (§8): the ordinance caps storage, 서초구 charges none. */
  releaseFees(vehicle: number, minutes: number): [tow: number, storage: number] {
    const money = ASSUMPTIONS.money,
      ordinance = ASSUMPTIONS.ebike.towing.ordinance2027;
    switch (this.regime[vehicle]) {
      case REGIME.DISTRICT:
        return [0, 0];
      case REGIME.ORDINANCE:
        return [
          ordinance.towFeeWon,
          Math.min(
            ordinance.storageCapWon,
            ordinance.storageWonPer30Minutes * Math.ceil(minutes / 30),
          ),
        ];
      default:
        return [money.towFeeWon, money.storageWonPer30Minutes * Math.ceil(minutes / 30)];
    }
  }

  /** The lot region of a point: the nearest fictional lot (자치구 대신 권역, §7.2). */
  region(latitude: number, longitude: number): number {
    let best = 0,
      bestMeters = Infinity;
    ASSUMPTIONS.lots.forEach((lot, index) => {
      const meters = this.e.meters(latitude, longitude, lot.latitude, lot.longitude);
      if (meters < bestMeters) {
        best = index;
        bestMeters = meters;
      }
    });
    return best;
  }

  /** A fallen vehicle on a proper spot is enforced as a sidewalk obstruction (§7.1). */
  effectiveCategory(vehicle: number): number {
    const e = this.e;
    const category = e.category[vehicle];
    return category === CATEGORY.PROPER && e.has(vehicle, FLAG.FALLEN)
      ? CATEGORY.SIDEWALK
      : category;
  }

  violating(vehicle: number): boolean {
    const e = this.e;
    return (
      FIELD[e.op[vehicle]] === 1 &&
      e.op[vehicle] !== OP.OUT_OF_AREA &&
      this.effectiveCategory(vehicle) !== CATEGORY.PROPER
    );
  }

  private busy(vehicle: number, time: number) {
    const e = this.e;
    const dock = e.segDock[vehicle];
    return dock < 0
      ? ASSUMPTIONS.complaints.busyDefault
      : e.demand.busy[dayTypeAt(time)][dock * 24 + kstHour(time)];
  }

  private hourFactor(hour: number) {
    for (const [first, last, factor] of ASSUMPTIONS.complaints.hourFactors)
      if (hour >= first && hour <= last) return factor;
    return 1;
  }

  /** Hazard rate per hour of one component now. */
  private rate(vehicle: number, component: number, time: number): number {
    const e = this.e;
    const op = e.op[vehicle];
    const hour = kstHour(time);
    const fallen = e.has(vehicle, FLAG.FALLEN);
    const category = e.category[vehicle];
    switch (component) {
      case HAZARD.FALL:
        if (fallen) return 0;
        return (
          ASSUMPTIONS.falls.perHour *
          (inHourBand(hour, 22, 3) ? ASSUMPTIONS.falls.nightFactor : 1) *
          (category === CATEGORY.SIDEWALK || category === CATEGORY.ROADWAY
            ? ASSUMPTIONS.falls.obstructionFactor
            : 1)
        );
      case HAZARD.GPS:
        return (
          ASSUMPTIONS.parkedHazards.gpsLostPerHour *
          (hour < 5 ? ASSUMPTIONS.parkedHazards.nightFactor : 1)
        );
      case HAZARD.THEFT:
        if ((op !== OP.AVAILABLE && op !== OP.LOW_BATTERY) || e.has(vehicle, FLAG.BATTERY_MISSING))
          return 0;
        return (
          ASSUMPTIONS.parkedHazards.batteryTheftPerHour *
          (hour < 5 ? ASSUMPTIONS.parkedHazards.nightFactor : 1) *
          e.spec(vehicle).battery.theftFactor
        );
      case HAZARD.VANDAL:
        return (
          ASSUMPTIONS.parkedHazards.vandalismPerHour *
          (e.rules.inParkBox(e.lat[vehicle], e.lon[vehicle])
            ? ASSUMPTIONS.parkedHazards.vandalismParkFactor
            : 1)
        );
      case HAZARD.COMPLAINT: {
        if (op === OP.OUT_OF_AREA)
          return e.has(vehicle, FLAG.OUT_OF_AREA_COMPLAINED)
            ? 0
            : ASSUMPTIONS.serviceArea.gyeonggiComplaintsPerHour;
        const effective = this.effectiveCategory(vehicle);
        const base =
          ASSUMPTIONS.complaints.perHour[CATEGORY_KEYS[effective]] *
          (effective === CATEGORY.PROPER && e.has(vehicle, FLAG.DISCOURAGED)
            ? ASSUMPTIONS.returns.discouragedComplaintFactor
            : 1);
        return (
          base *
          (fallen ? ASSUMPTIONS.complaints.fallenFactor : 1) *
          this.busy(vehicle, time) *
          this.hourFactor(hour)
        );
      }
      default: {
        if (!this.towedType(vehicle)) {
          // 서초구's own sweep of its removal zones (§19).
          const district = ASSUMPTIONS.ebike.towing.district;
          return op !== OP.OUT_OF_AREA &&
            e.stage[vehicle] === STAGE.NONE &&
            hour >= district.hours[0] &&
            hour < district.hours[1] &&
            this.districtZone(vehicle, category)
            ? district.patrolPerHour
            : 0;
        }
        const [from, to] = ASSUMPTIONS.complaints.districtHours;
        return op !== OP.OUT_OF_AREA &&
          IMMEDIATE_TOW[category] &&
          e.stage[vehicle] === STAGE.NONE &&
          hour >= from &&
          hour < to
          ? ASSUMPTIONS.complaints.districtPatrolPerHour
          : 0;
      }
    }
  }

  /** Upper bounds of each component's rate while the segment keeps its category and fall state. */
  private bounds(vehicle: number): Float64Array {
    const e = this.e,
      max = this.maxRates;
    const category = e.category[vehicle];
    const fallen = e.has(vehicle, FLAG.FALLEN);
    max[HAZARD.FALL] = fallen
      ? 0
      : ASSUMPTIONS.falls.perHour *
        ASSUMPTIONS.falls.nightFactor *
        (category === CATEGORY.SIDEWALK || category === CATEGORY.ROADWAY
          ? ASSUMPTIONS.falls.obstructionFactor
          : 1);
    max[HAZARD.GPS] =
      ASSUMPTIONS.parkedHazards.gpsLostPerHour * ASSUMPTIONS.parkedHazards.nightFactor;
    max[HAZARD.THEFT] =
      ASSUMPTIONS.parkedHazards.batteryTheftPerHour *
      ASSUMPTIONS.parkedHazards.nightFactor *
      e.spec(vehicle).battery.theftFactor;
    max[HAZARD.VANDAL] =
      ASSUMPTIONS.parkedHazards.vandalismPerHour *
      (e.rules.inParkBox(e.lat[vehicle], e.lon[vehicle])
        ? ASSUMPTIONS.parkedHazards.vandalismParkFactor
        : 1);
    if (e.op[vehicle] === OP.OUT_OF_AREA) {
      max[HAZARD.COMPLAINT] = ASSUMPTIONS.serviceArea.gyeonggiComplaintsPerHour;
      max[HAZARD.DISTRICT] = 0;
    } else {
      const effective = this.effectiveCategory(vehicle);
      const dock = e.segDock[vehicle];
      const busy = dock < 0 ? ASSUMPTIONS.complaints.busyDefault : e.demand.busyMax[dock];
      max[HAZARD.COMPLAINT] =
        ASSUMPTIONS.complaints.perHour[CATEGORY_KEYS[effective]] *
        (fallen ? ASSUMPTIONS.complaints.fallenFactor : 1) *
        busy *
        MAX_HOUR_FACTOR;
      max[HAZARD.DISTRICT] = !this.towedType(vehicle)
        ? this.districtZone(vehicle, category)
          ? ASSUMPTIONS.ebike.towing.district.patrolPerHour
          : 0
        : IMMEDIATE_TOW[category]
          ? ASSUMPTIONS.complaints.districtPatrolPerHour
          : 0;
    }
    return max;
  }

  /**
   * Draws the next hazard candidate of the vehicle's parking segment from its parked stream
   * (§11.3: thinning at the maximum rate). Rescheduling after an in-place change continues the
   * same stream, so the draws stay keyed by the segment.
   */
  scheduleHazard(vehicle: number, time: number) {
    const e = this.e;
    const version = ++e.hazardVersion[vehicle];
    if (!FIELD[e.op[vehicle]]) return;
    const max = this.bounds(vehicle);
    let total = 0;
    for (let index = 0; index < max.length; index++) total += max[index];
    if (total <= 0) return;
    const stream = this.stream;
    stream.state = e.parkState[vehicle];
    const next = time + Math.max(1, Math.floor(stream.exponential(total) * HOUR));
    e.parkState[vehicle] = stream.state;
    e.schedule(next, K.HAZARD, vehicle, version);
  }

  hazard(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.hazardVersion[vehicle] !== version || !FIELD[e.op[vehicle]]) return;
    const max = this.bounds(vehicle);
    let total = 0;
    for (let index = 0; index < max.length; index++) total += max[index];
    const stream = this.stream;
    stream.state = e.parkState[vehicle];
    let pick = stream.next() * total;
    const accept = stream.next(),
      detail = stream.next();
    e.parkState[vehicle] = stream.state;
    let component = max.length - 1;
    for (let index = 0; index < max.length; index++) {
      if (pick < max[index]) {
        component = index;
        break;
      }
      pick -= max[index];
    }
    const bound = max[component];
    const happens = bound > 0 && accept * bound < this.rate(vehicle, component, time);
    if (happens) this.apply(vehicle, component, detail, time);
    if (FIELD[e.op[vehicle]] && e.hazardVersion[vehicle] === version)
      this.scheduleHazard(vehicle, time);
  }

  private apply(vehicle: number, component: number, detail: number, time: number) {
    const e = this.e;
    switch (component) {
      case HAZARD.FALL: {
        // P2: knocked over. 12% damage the frame; the tilt sensor calls a patrol (§3.6).
        const damaged = detail < ASSUMPTIONS.falls.damagedShare;
        e.setFlag(vehicle, FLAG.FALLEN, true);
        if (damaged && !e.latent[vehicle]) e.latent[vehicle] = FAULT.FRAME;
        e.record(vehicle, time);
        e.log(time, EV.fall, vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, damaged ? 1 : 0);
        this.scheduleHazard(vehicle, time);
        e.ops.vehicleChanged(vehicle, time);
        return;
      }
      case HAZARD.GPS:
        e.ops.goMissing(vehicle, time, 0);
        return;
      case HAZARD.THEFT: {
        // T28: the swappable pack is taken; the vehicle is dead where it stands.
        e.commitBattery(vehicle, time);
        e.setBattery(vehicle, 0, time);
        e.setFlag(vehicle, FLAG.BATTERY_MISSING, true);
        e.setOp(vehicle, OP.BATTERY_DEAD, time);
        e.record(vehicle, time);
        e.log(time, EV['battery-theft'], vehicle, -1, e.lat[vehicle], e.lon[vehicle]);
        e.log(time, EV['battery-dead'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, 0);
        e.ops.vehicleChanged(vehicle, time);
        return;
      }
      case HAZARD.VANDAL:
        e.ops.writeOff(vehicle, time, 3);
        return;
      case HAZARD.COMPLAINT:
        this.complain(
          vehicle,
          time,
          e.op[vehicle] === OP.OUT_OF_AREA ? SOURCE.gyeonggi : SOURCE.citizen,
        );
        return;
      default:
        this.complain(vehicle, time, SOURCE.district);
    }
  }

  /** §7.1 a complaint (or a district patrol finding) about a parked vehicle. */
  complain(vehicle: number, time: number, source: number) {
    const e = this.e;
    if (e.op[vehicle] === OP.OUT_OF_AREA) {
      // No Seoul towing outside the service area; the pickup is only raised (§5.7).
      if (e.has(vehicle, FLAG.OUT_OF_AREA_COMPLAINED)) return;
      e.setFlag(vehicle, FLAG.OUT_OF_AREA_COMPLAINED, true);
      e.log(
        time,
        EV.complaint,
        vehicle,
        -1,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        CATEGORY.PROPER,
        1,
        source,
      );
      e.ops.vehicleChanged(vehicle, time);
      return;
    }
    const effective = this.effectiveCategory(vehicle);
    if (e.stage[vehicle] !== STAGE.NONE) {
      e.complaints[vehicle]++;
      e.log(
        time,
        EV.complaint,
        vehicle,
        -1,
        e.lat[vehicle],
        e.lon[vehicle],
        0,
        effective,
        e.complaints[vehicle],
        source,
      );
      return;
    }
    e.stage[vehicle] = STAGE.REPORTED;
    e.firstComplaintAt[vehicle] = time;
    e.complaints[vehicle] = 1;
    e.log(time, EV.complaint, vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, effective, 1, source);
    if (!this.towedType(vehicle)) this.regime[vehicle] = REGIME.OPERATOR;
    const towing = ASSUMPTIONS.towing;
    const segment = e.segVersion[vehicle];
    const delay = e.keyed(PURPOSE.TOW, vehicle, Math.floor(time / MINUTE));
    const minutes = Math.min(
      towing.delayMinutes.max,
      Math.max(
        towing.delayMinutes.min,
        delay.erlang(towing.delayMinutes.shape, towing.delayMinutes.mean),
      ),
    );
    if (effective === CATEGORY.PROPER) {
      // Nothing wrong on the spot: the district dismisses it after checking.
      e.schedule(time + Math.round(minutes * MINUTE), K.DISMISS, vehicle, segment);
    } else if (!this.towedType(vehicle)) this.notifyOperator(vehicle, effective, segment, time);
    else if (
      IMMEDIATE_TOW[effective] &&
      ASSUMPTIONS.towing.regionFactor[this.region(e.lat[vehicle], e.lon[vehicle])] > 0
    ) {
      e.towReadyAt[vehicle] = time + Math.round(minutes * MINUTE);
      e.schedule(e.towReadyAt[vehicle], K.TOW_READY, vehicle, segment);
    } else if (ASSUMPTIONS.towing.regionFactor[this.region(e.lat[vehicle], e.lon[vehicle])] > 0) {
      e.graceUntil[vehicle] = time + towing.graceMinutes * MINUTE;
      e.schedule(e.graceUntil[vehicle], K.GRACE_END, vehicle, segment);
    }
    if (this.towedType(vehicle))
      this.regime[vehicle] = e.vType[vehicle] === VTYPE.SCOOTER ? REGIME.PM : REGIME.ORDINANCE;
    e.record(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
  }

  /**
   * §19 an e-bike complaint goes to the operator with a deadline to re-park: 서초구's removal
   * 1–3 hours away in its zones, the operator's own deadline elsewhere (no tow follows).
   */
  private notifyOperator(vehicle: number, category: number, segment: number, time: number) {
    const e = this.e,
      towing = ASSUMPTIONS.ebike.towing;
    let minutes: number;
    if (this.districtZone(vehicle, category)) {
      this.regime[vehicle] = REGIME.DISTRICT;
      const [low, high] = towing.district.removalHours;
      const hours = e.keyed(PURPOSE.TOW, vehicle, Math.floor(time / MINUTE), 2).between(low, high);
      e.towReadyAt[vehicle] = e.graceUntil[vehicle] = time + Math.round(hours * HOUR);
      e.schedule(e.towReadyAt[vehicle], K.TOW_READY, vehicle, segment);
      minutes = Math.round(hours * 60);
    } else {
      this.regime[vehicle] = REGIME.OPERATOR;
      e.graceUntil[vehicle] = time + towing.operatorReparkMinutes * MINUTE;
      e.schedule(e.graceUntil[vehicle], K.GRACE_END, vehicle, segment);
      minutes = towing.operatorReparkMinutes;
    }
    e.log(
      time,
      EV['operator-notice'],
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      category,
      minutes,
      this.regime[vehicle],
    );
  }

  /** E2 for immediate-tow categories: the administrative delay is over (서초구: the removal). */
  towReady(vehicle: number, segment: number, time: number) {
    const e = this.e;
    if (e.segVersion[vehicle] !== segment || e.stage[vehicle] !== STAGE.REPORTED) return;
    if (!this.violating(vehicle)) return;
    if (this.regime[vehicle] === REGIME.DISTRICT) this.districtRemove(vehicle, segment, time);
    else if (this.towedType(vehicle)) this.dispatch(vehicle, time);
  }

  /** E2 for the other categories: the operator's grace period is over. */
  graceEnd(vehicle: number, segment: number, time: number) {
    const e = this.e;
    if (e.segVersion[vehicle] !== segment || e.stage[vehicle] !== STAGE.REPORTED) return;
    if (!this.violating(vehicle)) return;
    // An e-bike's re-park deadline has passed: no tow follows; the patrol job stays open.
    if (!this.towedType(vehicle)) e.ops.vehicleChanged(vehicle, time);
    else this.dispatch(vehicle, time);
  }

  /**
   * §19 서초구's crew lifts the e-bike off its zone, inside its working hours, and takes it to
   * the region's lot; nothing is charged and the operator's van fetches it (T12, T13).
   */
  private districtRemove(vehicle: number, segment: number, time: number) {
    const e = this.e,
      district = ASSUMPTIONS.ebike.towing.district;
    const hour = kstHour(time);
    if (hour < district.hours[0] || hour >= district.hours[1]) {
      let next = midnightOfIndex(kstDateIndex(time)) + district.hours[0] * HOUR;
      if (next <= time) next += 24 * HOUR;
      e.towReadyAt[vehicle] = e.graceUntil[vehicle] = next;
      e.schedule(next, K.TOW_READY, vehicle, segment);
      e.ops.vehicleChanged(vehicle, time);
      return;
    }
    const category = this.effectiveCategory(vehicle);
    const region = this.region(e.lat[vehicle], e.lon[vehicle]);
    e.towedCategory[vehicle] = category;
    this.passThrough[vehicle] = 0;
    e.lot[vehicle] = region;
    e.log(
      time,
      EV['district-removal'],
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      category,
      region,
    );
    e.leaveField(vehicle, time, RES.removed);
    if (e.holder[vehicle] >= 0) e.holder[vehicle] = -1;
    e.setOp(vehicle, OP.TOWING, time);
    e.record(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
    const [low, high] = ASSUMPTIONS.towing.toLotMinutes;
    const transit = e.keyed(PURPOSE.TOW, vehicle, Math.floor(time / MINUTE), 1).between(low, high);
    e.schedule(time + Math.round(transit * MINUTE), K.IMPOUND_ARRIVE, vehicle, e.version[vehicle]);
  }

  dismiss(vehicle: number, segment: number, time: number) {
    const e = this.e;
    if (e.segVersion[vehicle] !== segment || e.stage[vehicle] !== STAGE.REPORTED) return;
    if (this.effectiveCategory(vehicle) !== CATEGORY.PROPER) return;
    this.resolve(vehicle, time, RES.dismissed);
    e.record(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
  }

  private dispatch(vehicle: number, time: number) {
    const e = this.e;
    const region = this.region(e.lat[vehicle], e.lon[vehicle]);
    e.stage[vehicle] = STAGE.TOW_DISPATCHED;
    const job = this.jobs.length;
    this.jobs.push({ vehicle, segment: e.segVersion[vehicle], region, status: 0 });
    e.towJob[vehicle] = job;
    this.queues[region].push(job);
    e.log(
      time,
      EV.tow,
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      this.effectiveCategory(vehicle),
      0,
      region,
    );
    e.record(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
    this.serve(region, time);
  }

  towHours(time: number) {
    const [from, to] = ASSUMPTIONS.towing.hours;
    const hour = kstHour(time);
    return hour >= from && hour < to;
  }

  /** The end of today's towing hours. */
  private towingEnds(time: number) {
    return midnightOfIndex(kstDateIndex(time)) + ASSUMPTIONS.towing.hours[1] * HOUR;
  }

  serveAll(time: number) {
    for (let region = 0; region < this.queues.length; region++) this.serve(region, time);
  }

  /** Sends free trucks of the region to the oldest queued jobs, inside towing hours. */
  serve(region: number, time: number) {
    if (!this.towHours(time)) return;
    const e = this.e,
      queue = this.queues[region];
    for (let truckIndex = 0; truckIndex < this.trucks.length; truckIndex++) {
      const truck = this.trucks[truckIndex];
      if (truck.region !== region || truck.busyUntil > time) continue;
      while (this.heads[region] < queue.length) {
        const jobIndex = queue[this.heads[region]];
        const job = this.jobs[jobIndex];
        if (job.status !== 0) {
          this.heads[region]++;
          continue;
        }
        const vehicle = job.vehicle;
        const travel = e.ops.travelMs(
          0,
          truck.latitude,
          truck.longitude,
          e.lat[vehicle],
          e.lon[vehicle],
          time,
        );
        const finish = time + travel + ASSUMPTIONS.towing.loadMinutes * MINUTE;
        if (finish > this.towingEnds(time)) return;
        this.heads[region]++;
        job.status = 1;
        truck.busyUntil = finish;
        truck.job = jobIndex;
        e.towReadyAt[vehicle] = finish;
        e.schedule(finish, K.TOW_PICKUP, truckIndex);
        break;
      }
    }
  }

  /** T12: the truck has loaded the vehicle if it is still standing in violation. */
  towPickup(truckIndex: number, time: number) {
    const e = this.e,
      truck = this.trucks[truckIndex];
    const job = this.jobs[truck.job];
    truck.job = -1;
    if (job && job.status === 1) {
      const vehicle = job.vehicle;
      truck.latitude = e.lat[vehicle];
      truck.longitude = e.lon[vehicle];
      if (
        e.segVersion[vehicle] === job.segment &&
        FIELD[e.op[vehicle]] &&
        e.stage[vehicle] === STAGE.TOW_DISPATCHED &&
        this.violating(vehicle)
      ) {
        job.status = 2;
        const category = this.effectiveCategory(vehicle);
        e.towedCategory[vehicle] = category;
        this.passThrough[vehicle] =
          this.towTable(vehicle)[category] && e.has(vehicle, FLAG.RIDER_PLACED) ? 1 : 0;
        e.lot[vehicle] = job.region;
        e.log(
          time,
          EV.tow,
          vehicle,
          -1,
          e.lat[vehicle],
          e.lon[vehicle],
          0,
          category,
          1,
          job.region,
        );
        e.towJob[vehicle] = -1;
        e.leaveField(vehicle, time, RES.towed);
        if (e.holder[vehicle] >= 0) e.holder[vehicle] = -1;
        e.setOp(vehicle, OP.TOWING, time);
        e.record(vehicle, time);
        e.ops.vehicleChanged(vehicle, time);
        const [low, high] = ASSUMPTIONS.towing.toLotMinutes;
        const transit = e
          .keyed(PURPOSE.TOW, vehicle, Math.floor(time / MINUTE), 1)
          .between(low, high);
        e.schedule(
          time + Math.round(transit * MINUTE),
          K.IMPOUND_ARRIVE,
          vehicle,
          e.version[vehicle],
        );
      } else job.status = 3;
    }
    this.serve(truck.region, time);
  }

  /** T13: at the lot; storage fees run until a van releases it. */
  impoundArrive(vehicle: number, version: number, time: number) {
    const e = this.e;
    if (e.version[vehicle] !== version || e.op[vehicle] !== OP.TOWING) return;
    const lot = ASSUMPTIONS.lots[e.lot[vehicle]];
    e.moveTo(vehicle, lot.latitude, lot.longitude);
    e.setOp(vehicle, OP.IMPOUNDED, time);
    e.impoundedAt[vehicle] = time;
    e.record(vehicle, time);
    e.ops.impounded(vehicle, time);
    e.ops.vehicleChanged(vehicle, time);
  }

  /**
   * E3: the complaint is settled by a rental, a re-park, a tow, a dismissal or the vehicle
   * leaving. A queued tow becomes `tow-cancelled`.
   */
  resolve(vehicle: number, time: number, resolution: number) {
    const e = this.e;
    if (e.stage[vehicle] === STAGE.NONE) return;
    if (e.stage[vehicle] === STAGE.TOW_DISPATCHED && resolution !== RES.towed) {
      const job = e.towJob[vehicle];
      if (job >= 0 && this.jobs[job].status <= 1) this.jobs[job].status = 3;
      e.log(time, EV['tow-cancelled'], vehicle, -1, e.lat[vehicle], e.lon[vehicle], 0, resolution);
    }
    e.log(
      time,
      EV['complaint-resolved'],
      vehicle,
      -1,
      e.lat[vehicle],
      e.lon[vehicle],
      0,
      this.effectiveCategory(vehicle),
      e.complaints[vehicle],
      resolution,
    );
    e.stage[vehicle] = STAGE.NONE;
    e.complaints[vehicle] = 0;
    e.towJob[vehicle] = -1;
  }

  /** Daily 07:00 start of towing. */
  scheduleTowHours(from: number, to: number) {
    const e = this.e;
    for (let index = kstDateIndex(from); midnightOfIndex(index) < to; index++) {
      const at = midnightOfIndex(index) + ASSUMPTIONS.towing.hours[0] * HOUR;
      if (at >= from && at < to) e.schedule(at, K.TOW_HOURS);
    }
  }

  /** Lot hours (§7.3): the window a van must arrive and finish in. */
  lotHours(time: number): [number, number] {
    const day = dayTypeAt(time);
    const [open, close] = ASSUMPTIONS.lotHours[day];
    const midnight = midnightOfIndex(kstDateIndex(time));
    return [midnight + open * HOUR, midnight + close * HOUR];
  }
}

const CATEGORY_KEYS = CATEGORY_NAMES;

const MAX_HOUR_FACTOR = Math.max(
  ...ASSUMPTIONS.complaints.hourFactors.map(([, , factor]) => factor),
);

export { SOURCE as COMPLAINT_SOURCES };
