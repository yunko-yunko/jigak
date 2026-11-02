// Regression cases from mvp/tests/scooterDeviceSelection.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CallBudget } from '../src/common/engine/call-budget.js';
import { MobilityFeeds } from '../src/common/engine/realtime/mobility.js';
import { metersBetween } from '../src/common/engine/realtime/names.js';
import {
  scooterConnection,
  type ScooterConnectionContext,
} from '../src/common/engine/scooter-bridge.js';
import {
  buildMixedModeBridges,
  type BridgeGenerationDiagnostics,
} from '../src/common/engine/mixed-mode-bridges.js';
import {
  DEFAULT_PREFERENCES,
  type BaseRoute,
  type BaseSegment,
  type DurationRange,
  type Place,
} from '../src/common/shared/domain/index.js';

const NOW = Date.UTC(2026, 9, 28, 3);
const point = (id: string, meters: number): Place => ({
  id,
  name: id,
  address: '',
  latitude: 37.55 + meters / 111195,
  longitude: 126.97,
});
const origin = point('origin', 0),
  destination = point('destination', 2000);
const fixed = (seconds: number): DurationRange => ({ min: seconds, max: seconds });
interface Device {
  id: string;
  meters: number;
  access: DurationRange;
  ride: DurationRange;
  egress: DurationRange;
  hireSeconds: number;
  returnSeconds: number;
}

function fixture(devices: Device[], limit = 10) {
  const pickups = new Map(devices.map((device) => [device.id, point(device.id, device.meters)]));
  const drops = new Map(
    devices.map((device, index) => [device.id, point(`drop-${device.id}`, 1900 + index * 20)]),
  );
  const calls: { mode: 'walk' | 'scooter'; vehicleId: string }[] = [];
  const mobility = new MobilityFeeds({
    now: () => NOW,
    gbfs: [
      {
        provider: 'fixture-operator',
        vehicleStatusUrl: 'https://operator.example/vehicle_status.json',
        kind: 'kick-scooter',
      },
    ],
    fetcher: async () =>
      new Response(
        JSON.stringify({
          last_updated: NOW / 1000,
          data: {
            vehicles: devices.map((device) => ({
              vehicle_id: device.id,
              lat: pickups.get(device.id)!.latitude,
              lon: pickups.get(device.id)!.longitude,
              current_fuel_percent: 0.8,
              is_disabled: false,
              is_reserved: false,
              last_reported: NOW / 1000,
            })),
          },
        }),
      ),
  });
  const routed = (
    mode: 'walk' | 'scooter',
    start: Place,
    end: Place,
    duration: DurationRange,
  ): BaseRoute => {
    const segment: BaseSegment = {
      id: mode,
      mode,
      title: mode,
      instructions: '통제된 공급원 경로',
      start,
      end,
      distanceMeters: metersBetween(start, end),
      durationSeconds: duration,
      polyline: [start, end],
      runAllowed: false,
      ...(mode === 'scooter' ? { routingProfile: 'scooter' as const } : {}),
    };
    return {
      id: mode,
      title: mode,
      segments: [segment],
      durationSeconds: duration,
      distanceMeters: segment.distanceMeters,
      transfers: 0,
    };
  };
  const context: ScooterConnectionContext = {
    now: NOW,
    budget: new CallBudget(limit),
    mobility,
    provider: {
      configured: true,
      searchPlaces: async () => [],
      transit: async () => [],
      scooter: async (request, budget) =>
        budget.run(() => {
          const device = devices.find((value) => request.origin.id.endsWith(`:${value.id}`))!;
          calls.push({ mode: 'scooter', vehicleId: device.id });
          return [routed('scooter', request.origin, request.destination, device.ride)];
        }),
      walking: async (request, budget) =>
        budget.run(() => {
          const access = request.origin.id === origin.id;
          const device = devices.find((value) =>
            access
              ? request.destination.id.endsWith(`:${value.id}`)
              : drops.get(value.id)!.id === request.origin.id,
          )!;
          calls.push({ mode: 'walk', vehicleId: device.id });
          return [
            routed(
              'walk',
              request.origin,
              request.destination,
              access ? device.access : device.egress,
            ),
          ];
        }),
    },
    scooterPolicy: {
      verify: async ({ vehicle }) => {
        const device = devices.find((value) => value.id === vehicle.id)!;
        return {
          vehicleId: device.id,
          provider: vehicle.provider,
          dropoff: drops.get(device.id)!,
          verifiedAt: NOW,
          validUntil: NOW + 3_600_000,
          pickupAllowed: true,
          returnAllowed: true,
          eligibilityAllowed: true,
          hireSeconds: device.hireSeconds,
          returnSeconds: device.returnSeconds,
          unlockFeeWon: 1000,
          perMinuteWon: 100,
          returnFeeWon: 0,
        };
      },
    },
  };
  return { context, calls };
}

const preferences = { ...DEFAULT_PREFERENCES, allowScooter: true };
const near: Device = {
  id: 'near',
  meters: 20,
  access: fixed(600),
  ride: fixed(600),
  egress: fixed(50),
  hireSeconds: 60,
  returnSeconds: 30,
};
// Durations are what a rider could do: the router skips a device whose best case (a brisk walk to
// it and the top riding speed from it) cannot beat the best rental already routed.
const farther: Device = {
  id: 'farther',
  meters: 100,
  access: fixed(80),
  ride: fixed(400),
  egress: fixed(40),
  hireSeconds: 60,
  returnSeconds: 30,
};
const selectedVehicle = (segments: BaseSegment[] | null) =>
  segments?.find((segment) => segment.mode === 'hire')?.rentalValidity?.vehicleId;

test('a farther permitted scooter wins when its routed access, unlock, ride, return and egress arrive sooner', async () => {
  const { context } = fixture([near, farther]);
  const segments = await scooterConnection(
    context,
    preferences,
    origin,
    destination,
    'device-choice',
  );
  assert.equal(
    selectedVehicle(segments),
    'farther',
    'the nearest device takes 1340s while the farther one takes 610s',
  );
  assert.deepEqual(
    segments!.map((segment) => segment.mode),
    ['walk', 'hire', 'scooter', 'return', 'walk'],
  );
  assert.equal(
    segments!.reduce((sum, segment) => sum + segment.durationSeconds.max, 0),
    610,
  );
  assert.equal(context.budget.used, 6);
});

test('device choice follows the selected arrival objective rather than the smallest upper bound in every search', async () => {
  const uncertain: Device = {
    ...near,
    access: fixed(20),
    ride: { min: 100, max: 700 },
    egress: fixed(20),
    hireSeconds: 30,
    returnSeconds: 30,
  };
  const certain: Device = {
    ...farther,
    access: fixed(20),
    ride: fixed(450),
    egress: fixed(20),
    hireSeconds: 30,
    returnSeconds: 30,
  };
  for (const [objective, expected] of [
    ['estimated-arrival', 'near'],
    ['conservative-arrival', 'farther'],
  ] as const) {
    const { context } = fixture([uncertain, certain]);
    context.acquisitionObjective = objective;
    const segments = await scooterConnection(context, preferences, origin, destination, objective);
    assert.equal(
      selectedVehicle(segments),
      expected,
      'estimated totals are 500/550s; upper-bound totals are 800/550s',
    );
  }
});

test('a completed device remains available when the shared budget cannot complete the next comparison', async () => {
  const { context, calls } = fixture([near, farther], 3);
  let skipped = 0;
  context.onScooterBudgetLimited = () => {
    skipped++;
  };
  const segments = await scooterConnection(context, preferences, origin, destination, 'limited');
  assert.equal(selectedVehicle(segments), 'near');
  assert.equal(context.budget.used, 3);
  assert.equal(
    calls.some((call) => call.vehicleId === 'farther'),
    false,
  );
  assert.equal(skipped, 1, 'the unqueried permitted device is a budget omission');
});

// Three distinct pickup spots are compared (contract D2); a fourth would need another budget.
const third: Device = {
  ...farther,
  id: 'third',
  meters: 120,
  access: fixed(90),
  ride: fixed(380),
  egress: fixed(30),
};
const fourth: Device = {
  ...farther,
  id: 'fourth',
  meters: 140,
  access: fixed(100),
  ride: fixed(360),
  egress: fixed(30),
};

test('device comparison stops after three complete feasible rentals within the shared call cap', async () => {
  const { context, calls } = fixture([near, farther, third, fourth], 12);
  const segments = await scooterConnection(context, preferences, origin, destination, 'bounded');
  assert.equal(selectedVehicle(segments), 'third');
  assert.equal(
    calls.some((call) => call.vehicleId === 'fourth'),
    false,
    'a fourth device requires another explicitly budgeted comparison',
  );
  assert.equal(context.budget.used, 9);
});

test('omitted scooter devices keep bridge acquisition incomplete even when the fetched graph can be solved', async () => {
  const { context } = fixture([near, farther, third, fourth], 12);
  let diagnostics!: BridgeGenerationDiagnostics;
  await buildMixedModeBridges({ origin, destination, preferences }, [], {
    ...context,
    onDiagnostics: (value) => {
      diagnostics = value;
    },
  });
  assert.equal(diagnostics.limitReached, true);
  assert.ok(
    diagnostics.candidateLimitSkipped >= 1,
    'a discovered fourth device is an omitted candidate',
  );
});
