import { Worker, type ResourceLimits } from 'node:worker_threads';
import type { Provenance } from '../../shared/domain/types.js';
import { ASSUMPTIONS } from './assumptions.js';
import { HOUR, serviceDayOf } from './calendar.js';
import { bundledDemand, parseDemand, type Demand } from './demand.js';
import { vehicleIdOf, vehicleIndexOf } from './event-log.js';
import { computeModelVersion } from './model-version.js';
import {
  bundledParkingRules,
  parseParkingRules,
  ParkingRules,
  type ParkingGeometry,
} from './parking-rules.js';
import { VEHICLE_TYPE_NAMES, VTYPE, type VehicleTypeName } from './sim-codes.js';
import type { Fleets } from './sim-engine.js';
import {
  buildWindowSync,
  fleetByTypeOf,
  SimWindow,
  SIMULATION_NOTICE,
  type EventQuery,
  type SimulatedVehicle,
  type WindowData,
  type WindowRequest,
} from './sim-window.js';
import {
  encodeWindow,
  simulationCodeHash,
  WINDOW_FORMAT,
  WindowStore,
  type WindowKeyInputs,
} from './window-store.js';

/**
 * Demo shared kick-scooters and PAS e-bikes (§1, §19). Seoul publishes no feed for either, so this
 * server can simulate a whole fictional operator running both: riders shaped by real 따릉이
 * usage, street parking and its violations, complaints and towing, faults, batteries, and crews
 * that swap, collect, repair and redeploy. Nothing here is a real operator, vehicle, rental, fine or tow, and every output is
 * labelled 시연용 가상 데이터.
 *
 * Every answer is a pure function of (seed, fleet, model version, time). A served day comes from
 * a 72–120-hour window simulated from a fixed steady-state template (§11), computed in a worker
 * thread; until it is ready the simulator answers "not ready" and routes go without it.
 */
export const SIMULATION_PROVIDER = 'jigak-sim';
/** One fictional operator for both types; each type keeps its own label (§19). */
export const SIMULATION_LABEL = '시연용 가상 킥보드';
export const SIMULATION_EBIKE_LABEL = '시연용 가상 전기자전거';
export const SIMULATION_LABELS: Readonly<Record<VehicleTypeName, string>> = {
  'kick-scooter': SIMULATION_LABEL,
  'e-bike': SIMULATION_EBIKE_LABEL,
};
export { SIMULATION_NOTICE };
export const SIMULATION_SYSTEM_NAME = '지각지도 시연용 가상 킥보드 (실제 운영사 아님)';

/** The nouns of the simulated types, e.g. "킥보드·전기자전거". */
export function simulatedNouns(fleets: Fleets): string {
  return [fleets.scooter > 0 ? '킥보드' : '', fleets.ebike > 0 ? '전기자전거' : '']
    .filter(Boolean)
    .join('·');
}

/** The GBFS system name for these fleets; a scooter-only run keeps its old name. */
export function simulationSystemName(fleets: Fleets): string {
  return `지각지도 시연용 가상 ${simulatedNouns(fleets)} (실제 운영사 아님)`;
}

/** Below this a vehicle is not rentable (§3.2). */
export const LOW_BATTERY_PERCENT = ASSUMPTIONS.battery.lowPercent;
/** Scooter bounds (a scooter-only run), e-bike bounds, and the cap on both together (§12, §19). */
export const MIN_FLEET = ASSUMPTIONS.fleet.min,
  MAX_FLEET = ASSUMPTIONS.fleet.max,
  MIN_EBIKE_FLEET = ASSUMPTIONS.fleet.ebikeMin,
  MAX_EBIKE_FLEET = ASSUMPTIONS.fleet.ebikeMax,
  CLOUD_RUN_MAX_FLEET = ASSUMPTIONS.fleet.cloudRunMax;

export { serviceDayOf, parseDemand, parseParkingRules, vehicleIdOf };
export type { SimulatedVehicle, EventQuery, Fleets };

/**
 * The fleets a server runs: each enabled type within its bounds, at least MIN_FLEET and at most
 * MAX_FLEET in all (fewer than 3,000 leave most riders without a vehicle, §12). Throws RangeError.
 */
export function validateFleets(fleets: Fleets): Fleets {
  const { scooter, ebike } = fleets;
  const within = (count: number, min: number, max: number) =>
    Number.isInteger(count) && (count === 0 || (count >= min && count <= max));
  if (
    !within(scooter, MIN_FLEET, MAX_FLEET) ||
    !within(ebike, MIN_EBIKE_FLEET, MAX_EBIKE_FLEET) ||
    scooter + ebike < MIN_FLEET ||
    scooter + ebike > MAX_FLEET
  )
    throw new RangeError(
      `Simulation fleets must be scooters 0 or ${MIN_FLEET}..${MAX_FLEET}, e-bikes 0 or ${MIN_EBIKE_FLEET}..${MAX_EBIKE_FLEET}, ${MIN_FLEET}..${MAX_FLEET} in all`,
    );
  return { scooter, ebike };
}

/**
 * Fleets cut to `cap` vehicles in all (Cloud Run, §12): both types shrink in proportion, each
 * enabled type keeping its minimum. Unchanged when already within the cap.
 */
export function capFleets(fleets: Fleets, cap: number): Fleets {
  const total = fleets.scooter + fleets.ebike;
  if (total <= cap) return fleets;
  if (!fleets.ebike) return { scooter: cap, ebike: 0 };
  if (!fleets.scooter) return { scooter: 0, ebike: cap };
  const scooter = Math.min(
    cap - MIN_EBIKE_FLEET,
    Math.max(MIN_FLEET, Math.round((fleets.scooter * cap) / total)),
  );
  return { scooter, ebike: cap - scooter };
}

export interface SharedScooterSimulationOptions {
  /** Scooters of a scooter-only run; ignored when `fleets` is given. */
  fleet?: number;
  /** Vehicles per type (§19); defaults to `fleet` scooters and no e-bikes. */
  fleets?: Fleets;
  seed?: string;
  /** Parsed demand tables; defaults to the bundled 따릉이-derived file. */
  demand?: Demand;
  /** Parking geometry; defaults to the bundled seoul-pm-parking-rules-v1.json. */
  geometry?: ParkingGeometry;
  /**
   * 'worker' (the default) computes windows in a worker thread and never blocks a request.
   * 'inline' computes them synchronously on first read; tests and scripts only.
   */
  builder?: 'worker' | 'inline';
  /** Windows kept in memory; the current and the next day by default (§11.5). */
  cacheSize?: number;
  /** Diagnostics sink (no secrets are ever logged). */
  log?: (message: string) => void;
  /**
   * Directory of stored windows (§22, MOBILITY_SIMULATION_WINDOW_DIR): a day computed once is read
   * back in about 0.1 s after a restart or on a new instance. Empty or absent: no store.
   */
  windowDirectory?: string;
  /**
   * Whether `/api/health/ready` waits for today's window (MOBILITY_SIMULATION_READY_GATE, default
   * true). False lets an instance take traffic while the simulator is still computing.
   */
  readyGate?: boolean;
}

/** Where today's window stands, for health checks and the readiness gate (§22). */
export interface SimulationReadiness {
  ready: boolean;
  serviceDay: string;
  status: 'idle' | 'building' | 'ready' | 'failed';
  /** Where the window came from: read from the store, or simulated here. */
  source: 'store' | 'build' | null;
  /** Epoch ms when the window was asked for. */
  startedAt: number | null;
  /** Milliseconds so far while building; what it took once ready. */
  elapsedMs: number | null;
}

interface WindowEntry {
  date: string;
  status: 'building' | 'ready' | 'failed';
  view: SimWindow | null;
  promise: Promise<SimWindow>;
  failedAt: number;
  builtMs: number;
  source: 'store' | 'build' | null;
  startedAt: number;
}

/** What the worker hands back: the window, where it came from, and a file to store after a build. */
interface WorkerResult {
  data: WindowData;
  source: 'store' | 'build';
  file?: Uint8Array;
  logs?: string[];
}

/** A failed window is retried after this long, so a broken build does not spin. */
const RETRY_MS = 60_000;

/**
 * Heap limits of the window worker (§11.5, §12). A build is transient work; its old space grows
 * with the fleet (scooters and e-bikes together), so the cap does too, and a runaway build fails
 * the window instead of the instance. The cap is at least twice the measured used-heap peak: 133
 * MB at the real fleet (67,538) under a 367 MB cap (docs/2026-11-01-scooter-simulation.md §21.7).
 */
export function workerResourceLimits(fleet: number) {
  return {
    maxOldGenerationSizeMb: Math.ceil(96 + fleet / 250),
    maxYoungGenerationSizeMb: 32,
  };
}

/**
 * Compiled builds run sim-worker.js. Under tsx the worker registers tsx itself before importing the .ts source:
 * an inherited `--import tsx` does not map `./x.js` to `./x.ts` inside a worker on Windows.
 */
function createSimWorker(resourceLimits: ResourceLimits): Worker {
  if (!import.meta.url.endsWith('.ts'))
    return new Worker(new URL('./sim-worker.js', import.meta.url), { resourceLimits });
  const tsx = import.meta.resolve('tsx/esm/api');
  const entry = new URL('./sim-worker.ts', import.meta.url).href;
  const source = `import(${JSON.stringify(tsx)}).then(({ register }) => { register(); return import(${JSON.stringify(entry)}); });`;
  return new Worker(source, { eval: true, resourceLimits });
}

/** One worker thread computing windows in order (§11.5). */
class WindowWorker {
  private worker: Worker | null = null;
  constructor(private readonly fleet: number) {}
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }
  >();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = createSimWorker(workerResourceLimits(this.fleet));
    worker.on('message', (message: Partial<WorkerResult> & { id: number; error?: string }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.data)
        request.resolve({
          data: message.data,
          source: message.source ?? 'build',
          file: message.file,
          logs: message.logs,
        });
      else request.reject(new Error(message.error ?? 'Simulation window failed'));
      // Windows are computed twice a day; an idle worker gives its memory back.
      if (!this.pending.size) {
        if (this.worker === worker) this.worker = null;
        void worker.terminate();
      }
    });
    worker.on('error', (error: unknown) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null;
      if (this.pending.size && this.worker === null)
        this.fail(new Error(`Simulation worker exited (${code})`));
    });
    this.worker = worker;
    return worker;
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.worker = null;
  }

  build(
    request: WindowRequest,
    store?: { directory: string; inputs: WindowKeyInputs },
  ): Promise<WorkerResult> {
    const worker = this.ensure();
    const id = this.nextId++;
    // Kept alive while a window is being computed, so a waiting test or script does not exit.
    worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(store ? { id, request, store } : { id, request });
    });
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

export class SharedScooterSimulation {
  /** Vehicles of both types. */
  readonly fleet: number;
  readonly fleets: Fleets;
  readonly seed: string;
  readonly modelVersion: string;
  private readonly builder: 'worker' | 'inline';
  private readonly cacheSize: number;
  private readonly log: (message: string) => void;
  private readonly demand: Demand;
  private readonly geometry: ParkingGeometry;
  private rules: ParkingRules | null = null;
  private readonly windows = new Map<string, WindowEntry>();
  private readonly worker: WindowWorker;
  private readonly store: WindowStore | null;
  private readonly writes = new Set<Promise<void>>();
  private evicted = false;
  /** Whether `/api/health/ready` waits for today's window. */
  readonly readyGate: boolean;

  constructor(options: SharedScooterSimulationOptions = {}) {
    if (options.fleets) this.fleets = validateFleets(options.fleets);
    else {
      const fleet = options.fleet ?? ASSUMPTIONS.fleet.default;
      if (!Number.isInteger(fleet) || fleet < MIN_FLEET || fleet > MAX_FLEET)
        throw new RangeError(`Simulation fleet must be ${MIN_FLEET}..${MAX_FLEET}`);
      this.fleets = { scooter: fleet, ebike: 0 };
    }
    this.fleet = this.fleets.scooter + this.fleets.ebike;
    this.worker = new WindowWorker(this.fleet);
    this.seed = options.seed?.trim() || 'jigak';
    // A missing or malformed demand file fails at startup, not inside a search.
    this.demand = options.demand ?? bundledDemand();
    this.geometry = options.geometry ?? bundledParkingRules();
    this.builder = options.builder ?? 'worker';
    // Custom tables cannot reach the worker, which reads the bundled files.
    if (this.builder === 'worker' && (options.demand || options.geometry))
      throw new TypeError('Custom simulation tables need the inline builder');
    this.cacheSize = Math.max(1, options.cacheSize ?? 2);
    this.log = options.log ?? (() => undefined);
    this.modelVersion = computeModelVersion({
      demand: this.demand,
      geometry: this.geometry.meta,
    });
    // Custom tables are not what the key describes, so they never use the store.
    const directory = options.windowDirectory?.trim();
    this.store =
      directory && !options.demand && !options.geometry
        ? new WindowStore(directory, this.log)
        : null;
    this.readyGate = options.readyGate ?? true;
  }

  /** Whether computed windows are kept on disk (§22). */
  get storeConfigured(): boolean {
    return this.store !== null;
  }

  /** Resolves once every store write started so far has finished (tests and scripts). */
  async storeIdle(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes]);
  }

  private keyInputs(request: WindowRequest): WindowKeyInputs {
    return {
      format: WINDOW_FORMAT,
      modelVersion: request.modelVersion,
      code: simulationCodeHash(),
      fleets: { ...this.fleets },
      seed: request.seed,
      date: request.date,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
    };
  }

  /** Writes a built window to the store off the request path, then trims the directory around its day. */
  private keep(inputs: WindowKeyInputs, file: Uint8Array) {
    if (!this.store) return;
    const store = this.store;
    const write = store
      .write(inputs, file)
      .then(() => store.evict(inputs.date, Date.now()))
      .catch((error: Error) =>
        this.log(`simulation window ${inputs.date} store write failed: ${error.name}`),
      )
      .finally(() => this.writes.delete(write));
    this.writes.add(write);
  }

  get geometryMeta() {
    return this.geometry.meta;
  }

  /** Vehicle type names this simulator runs, in VTYPE order. */
  get vehicleTypes(): VehicleTypeName[] {
    return VEHICLE_TYPE_NAMES.filter(
      (_, type) => (type === VTYPE.SCOOTER ? this.fleets.scooter : this.fleets.ebike) > 0,
    );
  }

  private request(time: number): WindowRequest {
    const day = serviceDayOf(time);
    return {
      date: day.date,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
      seed: this.seed,
      fleet: this.fleet,
      fleets: { ...this.fleets },
      modelVersion: this.modelVersion,
    };
  }

  /** Keeps the newest windows; the one being read is never evicted. */
  private trim(keep: string) {
    while (this.windows.size > this.cacheSize) {
      const oldest = [...this.windows.keys()].find((date) => date !== keep);
      if (!oldest) break;
      this.windows.delete(oldest);
    }
  }

  private touch(entry: WindowEntry) {
    this.windows.delete(entry.date);
    this.windows.set(entry.date, entry);
  }

  /** Computes the window serving `time` (once); resolves when it is ready. */
  ensure(time: number): Promise<SimWindow> {
    const request = this.request(time);
    const existing = this.windows.get(request.date);
    if (existing && (existing.status !== 'failed' || Date.now() - existing.failedAt < RETRY_MS))
      return existing.promise;
    const entry: WindowEntry = {
      date: request.date,
      status: 'building',
      view: null,
      promise: Promise.resolve(null as unknown as SimWindow),
      failedAt: 0,
      builtMs: 0,
      source: null,
      startedAt: Date.now(),
    };
    const started = performance.now();
    const inputs = this.store ? this.keyInputs(request) : null;
    const settle = ({ data, source, file, logs }: WorkerResult) => {
      for (const line of logs ?? []) this.log(line);
      entry.view = new SimWindow(data);
      entry.status = 'ready';
      entry.source = source;
      entry.builtMs = Math.round(performance.now() - started);
      this.log(
        `simulation window ${request.date} ready in ${entry.builtMs} ms (${source === 'store' ? 'stored' : 'computed'})`,
      );
      if (inputs && file) this.keep(inputs, file);
      else if (this.store && !this.evicted)
        void this.store.evict(request.date, Date.now()).catch(() => undefined);
      this.evicted = true;
      return entry.view;
    };
    if (this.builder === 'inline') {
      const stored = inputs ? this.store!.readSync(inputs) : null;
      if (stored) settle({ data: stored, source: 'store' });
      else {
        this.rules ??= new ParkingRules(this.geometry, this.demand);
        const begun = performance.now();
        const data = buildWindowSync(request, this.demand, this.rules);
        const file = inputs
          ? encodeWindow(data, inputs, Math.round(performance.now() - begun), Date.now())
          : undefined;
        settle({ data, source: 'build', file });
      }
      entry.promise = Promise.resolve(entry.view!);
    } else {
      const store = inputs ? { directory: this.store!.directory, inputs } : undefined;
      entry.promise = this.worker.build(request, store).then(settle, (error: Error) => {
        entry.status = 'failed';
        entry.failedAt = Date.now();
        this.log(`simulation window ${request.date} failed: ${error.message}`);
        throw error;
      });
      // A failure is reported through status; nobody else needs to observe this promise.
      entry.promise.catch(() => undefined);
    }
    this.windows.set(request.date, entry);
    this.trim(request.date);
    return entry.promise;
  }

  /**
   * The ready window for `time`, or null while it is computed (the build starts if needed). In
   * inline mode the window is built right here.
   */
  window(time: number): SimWindow | null {
    const date = serviceDayOf(time).date;
    let entry = this.windows.get(date);
    if (!entry || (entry.status === 'failed' && Date.now() - entry.failedAt >= RETRY_MS)) {
      void this.ensure(time).catch(() => undefined);
      entry = this.windows.get(date);
    }
    if (entry?.status !== 'ready' || !entry.view) return null;
    this.touch(entry);
    return entry.view;
  }

  isReady(time: number) {
    return this.windows.get(serviceDayOf(time).date)?.status === 'ready';
  }

  /** Where the window serving `time` stands (§22); 'idle' until something asks for it. */
  readiness(time: number): SimulationReadiness {
    const serviceDay = serviceDayOf(time).date;
    const entry = this.windows.get(serviceDay);
    if (!entry)
      return {
        ready: false,
        serviceDay,
        status: 'idle',
        source: null,
        startedAt: null,
        elapsedMs: null,
      };
    return {
      ready: entry.status === 'ready',
      serviceDay,
      status: entry.status,
      source: entry.source,
      startedAt: entry.startedAt,
      elapsedMs:
        entry.status === 'ready'
          ? entry.builtMs
          : entry.status === 'building'
            ? Math.max(0, Date.now() - entry.startedAt)
            : null,
    };
  }

  /** Milliseconds the window serving `time` took to compute, for diagnostics. */
  builtMs(time: number) {
    return this.windows.get(serviceDayOf(time).date)?.builtMs ?? null;
  }

  /**
   * Computes today's window now and each next day's from 05:00 KST (§11.5), off any request.
   * Returns a stop function.
   */
  start(clock: () => number = Date.now): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    void this.ensure(clock()).catch(() => undefined);
    const arm = () => {
      if (stopped) return;
      const now = clock();
      const today = serviceDayOf(now);
      // From an hour after today's start, the next day's window is computed in the background.
      const at = today.startsAt + HOUR;
      timer = setTimeout(
        () => {
          void this.ensure(today.endsAt).catch(() => undefined);
          // Re-armed for tomorrow once today's 05:00 has passed.
          timer = setTimeout(arm, Math.max(1, today.endsAt - clock()));
          timer.unref?.();
        },
        Math.max(0, at - now),
      );
      timer.unref?.();
    };
    arm();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  async close() {
    await this.worker.close();
  }

  /** The index of a JS##### or JB##### id; -1 when malformed or not in this fleet. */
  private index(id: string): number {
    return vehicleIndexOf(id, this.fleets.scooter, this.fleets.ebike);
  }

  /** Every vehicle at `time`; empty while the window is not ready. */
  vehicles(time: number): SimulatedVehicle[] {
    const view = this.window(time);
    return view ? Array.from({ length: this.fleet }, (_, index) => view.vehicle(index, time)) : [];
  }

  vehicle(id: string, time: number): SimulatedVehicle | null {
    const index = this.index(id);
    const view = index >= 0 ? this.window(time) : null;
    return view ? view.vehicle(index, time) : null;
  }

  /**
   * When a vehicle rentable at `time` stops being rentable on its spot (§15.5); null when it is
   * not rentable now, unknown, or the window is not ready.
   */
  parkedUntil(id: string, time: number): number | null {
    const index = this.index(id);
    const view = index >= 0 ? this.window(time) : null;
    if (!view || !view.rentableAt(index, time)) return null;
    return view.parkedUntil(index, time);
  }

  /**
   * Rentable (default) or street vehicles within `radiusMeters`, nearest first; `perType` keeps
   * the nearest that many of each type, and `totals` receives each type's count before that cut.
   */
  nearby(
    point: { latitude: number; longitude: number },
    radiusMeters: number,
    time: number,
    which: 'rentable' | 'field' = 'rentable',
    options: { scan?: boolean; perType?: number; totals?: number[] } = {},
  ): (SimulatedVehicle & { distanceMeters: number })[] {
    return this.window(time)?.nearby(point, radiusMeters, time, which, options) ?? [];
  }

  /** Street vehicles for GBFS vehicle_status (§15.4), with each one's last report time. */
  fieldVehicles(
    time: number,
    area?: { latitude: number; longitude: number; radius: number },
  ): { ready: boolean; vehicles: (SimulatedVehicle & { lastReported: number })[] } {
    const view = this.window(time);
    if (!view) return { ready: false, vehicles: [] };
    const list = area ? view.nearby(area, area.radius, time, 'field') : view.fieldVehicles(time);
    return {
      ready: true,
      vehicles: list.map((vehicle) => ({
        ...vehicle,
        lastReported: view.lastReported(this.index(vehicle.id), time),
      })),
    };
  }

  private notReady(time: number) {
    return {
      enabled: true as const,
      ready: false as const,
      fleet: this.fleet,
      fleetByType: fleetByTypeOf(this.fleets),
      modelVersion: this.modelVersion,
      serviceDay: serviceDayOf(time).date,
      generatedAt: time,
      notice: SIMULATION_NOTICE,
    };
  }

  status(time: number) {
    const view = this.window(time);
    if (!view) return this.notReady(time);
    return { enabled: true as const, ...view.status(time) };
  }

  events(query: EventQuery, now: number) {
    const view = this.window(now);
    if (!view)
      return {
        ...this.notReady(now),
        seam: false,
        windowStartsAt: serviceDayOf(now).startsAt,
        events: [],
        next: null,
        truncated: false,
      };
    return { ready: true as const, ...view.events(query, now) };
  }

  crews(time: number) {
    const view = this.window(time);
    if (!view) return { ...this.notReady(time), shifts: [], depots: [], lots: [], crews: [] };
    return { ready: true as const, ...view.crews(time) };
  }
}

/** Provenance carried by every segment built on a simulated vehicle (§1, §15.5, §19). */
export function simulationProvenance(
  now: number,
  modelVersion?: string,
  label: string = SIMULATION_LABEL,
): Provenance {
  return {
    mode: 'live',
    provider: SIMULATION_PROVIDER,
    label,
    sourceTimestamp: now,
    receivedAt: now,
    isRealtime: false,
    simulated: true,
    ...(modelVersion ? { modelVersion } : {}),
  };
}
