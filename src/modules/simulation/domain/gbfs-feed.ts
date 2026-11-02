import { ASSUMPTIONS, VEHICLE_TYPES } from '../../../common/engine/simulation/assumptions.js';
import type { VehicleTypeName } from '../../../common/engine/simulation/sim-codes.js';
import {
  SIMULATION_LABEL,
  SIMULATION_LABELS,
  SIMULATION_NOTICE,
  SIMULATION_PROVIDER,
  simulatedNouns,
  simulationSystemName,
  type SharedScooterSimulation,
} from '../../../common/engine/simulation/shared-scooter-sim.js';

/** GBFS v3.0-shaped documents for the demo simulator. It is not a real operator's feed. */
const VERSION = '3.0';
/** GBFS vehicle types (§15.4, §19); our GBFS reader maps electric_assist bicycles to e-bicycle. */
const VEHICLE_TYPE_DOCUMENTS: Readonly<Record<VehicleTypeName, Record<string, unknown>>> = {
  'kick-scooter': {
    vehicle_type_id: 'sim-kick-scooter',
    form_factor: 'scooter_standing',
    propulsion_type: 'electric',
    max_range_meters: ASSUMPTIONS.battery.maxRangeMeters,
    name: localized(SIMULATION_LABEL),
  },
  'e-bike': {
    vehicle_type_id: 'sim-e-bike',
    form_factor: 'bicycle',
    propulsion_type: 'electric_assist',
    max_permitted_speed: ASSUMPTIONS.ebike.maxKmh,
    max_range_meters: VEHICLE_TYPES[1].battery.maxRangeMeters,
    wheel_count: 2,
    name: localized(SIMULATION_LABELS['e-bike']),
  },
};
const VEHICLE_TYPE_ID: Readonly<Record<VehicleTypeName, string>> = {
  'kick-scooter': 'sim-kick-scooter',
  'e-bike': 'sim-e-bike',
};
/**
 * One response never exceeds this many bytes. GBFS has no paging, so the full feed lists every
 * street vehicle (about 250 bytes each: some 14 MB for the real Seoul fleet) and is cut only past
 * this size, each type by the same share. `total` and `truncated` in the envelope say so (§15.4).
 */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Bodies kept for the current minute: the whole feed and the areas asked in it (§15.4). */
const MAX_CACHED_BODIES = 8;

function localized(text: string) {
  return [{ text, language: 'ko' }];
}
const envelope = <T>(now: number, data: T, extra: Record<string, unknown> = {}) => ({
  last_updated: new Date(now).toISOString(),
  ttl: 0,
  version: VERSION,
  ...extra,
  data,
});

/**
 * Where the feeds are listed: the configured public HTTPS address when there is one, since TLS
 * ends at the proxy in front of the server, else the address this request came in on.
 */
export function gbfsDiscoveryBase(
  requestOrigin: string,
  requestPath: string,
  publicBaseUrl?: string,
): string {
  let origin = requestOrigin;
  try {
    const configured = new URL(publicBaseUrl ?? '');
    if (configured.protocol === 'https:') origin = configured.origin;
  } catch {
    /* No usable public address; the request's own origin stands. */
  }
  return `${origin}${requestPath.split('?')[0].replace(/\/gbfs\.json$/, '')}`;
}

export function gbfsDiscovery(baseUrl: string, now: number) {
  return envelope(now, {
    feeds: ['system_information', 'vehicle_types', 'vehicle_status'].map((name) => ({
      name,
      url: `${baseUrl}/${name}.json`,
    })),
  });
}

export function gbfsSystemInformation(now: number, simulation: SharedScooterSimulation) {
  const nouns = simulatedNouns(simulation.fleets);
  const modelVersion = simulation.modelVersion;
  return envelope(now, {
    system_id: SIMULATION_PROVIDER,
    languages: ['ko'],
    name: localized(simulationSystemName(simulation.fleets)),
    short_name: localized(`시연용 가상 ${nouns}`),
    operator: localized('지각지도 시연용 시뮬레이터'),
    description: localized(
      `${SIMULATION_NOTICE}. 따릉이 이용 패턴으로 움직이는 가상 ${nouns}이며 실제 운영사·기기·대여·견인·범칙금이 아닙니다.`,
    ),
    opening_hours: '24/7',
    timezone: 'Asia/Seoul',
    model_version: modelVersion,
  });
}

/** The simulated types this server runs. */
export function gbfsVehicleTypes(now: number, simulation: SharedScooterSimulation) {
  return envelope(now, {
    vehicle_types: simulation.vehicleTypes.map((type) => VEHICLE_TYPE_DOCUMENTS[type]),
  });
}

interface Listed {
  type: VehicleTypeName;
  json: string;
}
/** Bodies of the minute they were built in, per simulation, so the 14 MB feed is built once a minute. */
const bodies = new WeakMap<
  SharedScooterSimulation,
  { minute: number; byArea: Map<string, string> }
>();

/** Each type cut to the same share of its vehicles, in the order given, until the body fits. */
function fitToBytes(listed: Listed[], budget: number): Listed[] {
  const bytes = listed.reduce((total, { json }) => total + json.length + 1, 0);
  if (bytes <= budget) return listed;
  const share = budget / bytes;
  const taken = new Map<VehicleTypeName, number>();
  const quota = new Map<VehicleTypeName, number>();
  for (const { type } of listed) quota.set(type, (quota.get(type) ?? 0) + 1);
  for (const [type, count] of quota) quota.set(type, Math.floor(count * share));
  return listed.filter(({ type }) => {
    const count = taken.get(type) ?? 0;
    taken.set(type, count + 1);
    return count < quota.get(type)!;
  });
}

/**
 * Street vehicles at `now` (§15.4) as the serialized GBFS document: rentable ones, reserved ones
 * and those that cannot be rented (low or dead battery, broken, outside the service area).
 * Riding, crew, depot, lot and GPS-lost vehicles are left out, as GBFS requires. With a point,
 * nearest first. A ready answer is kept for the minute it was built in.
 */
export function gbfsVehicleStatusBody(
  simulation: SharedScooterSimulation,
  now: number,
  area?: { latitude: number; longitude: number; radius: number },
): string {
  const minute = Math.floor(now / 60_000);
  const key = area ? `${area.latitude},${area.longitude},${area.radius}` : '';
  let kept = bodies.get(simulation);
  if (kept?.minute !== minute) {
    kept = { minute, byArea: new Map() };
    bodies.set(simulation, kept);
  }
  const cached = kept.byArea.get(key);
  if (cached !== undefined) return cached;
  const { ready, vehicles } = simulation.fieldVehicles(now, area);
  const listed = fitToBytes(
    vehicles.map((vehicle) => ({
      type: vehicle.type,
      json: JSON.stringify({
        vehicle_id: vehicle.id,
        lat: vehicle.latitude,
        lon: vehicle.longitude,
        is_reserved: vehicle.state === 'reserved',
        is_disabled: vehicle.state !== 'available' && vehicle.state !== 'reserved',
        vehicle_type_id: VEHICLE_TYPE_ID[vehicle.type],
        current_fuel_percent: vehicle.battery / 100,
        current_range_meters: vehicle.rangeMeters,
        last_reported: new Date(vehicle.lastReported).toISOString(),
      }),
    })),
    MAX_BODY_BYTES,
  );
  const head = JSON.stringify(
    envelope(
      now,
      { vehicles: [] },
      {
        ready,
        model_version: simulation.modelVersion,
        total: vehicles.length,
        truncated: listed.length < vehicles.length,
      },
    ),
  );
  // The empty list closes the document: `]}}`.
  const body = `${head.slice(0, -3)}${listed.map(({ json }) => json).join(',')}]}}`;
  if (ready) {
    if (kept.byArea.size >= MAX_CACHED_BODIES) kept.byArea.delete(kept.byArea.keys().next().value!);
    kept.byArea.set(key, body);
  }
  return body;
}
