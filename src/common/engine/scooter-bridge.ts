import type { BaseRoute, BaseSegment, MobilityPreferences, Place } from '../shared/domain/index.js';
import { ApiError } from './errors.js';
import type { MultimodalContext } from './multimodal.js';
import type { SharedScooter } from './realtime/mobility.js';
import { metersBetween } from './realtime/names.js';
import { acquisitionTiming } from './acquisition-priority.js';

export interface ScooterVehicle extends SharedScooter {
  source: 'tago-pm' | 'gbfs';
}

/** Supplied by an authorized operator adapter, never inferred from a vehicle dot. */
export interface ScooterRentalPermission {
  vehicleId: string;
  provider: string;
  dropoff: Place;
  verifiedAt: number;
  validUntil: number;
  pickupAllowed: boolean;
  returnAllowed: boolean;
  eligibilityAllowed: boolean;
  hireSeconds: number;
  returnSeconds: number;
  unlockFeeWon: number;
  /** Operator-confirmed whole-minute ride tariff; adapters with other tariffs must quote separately. */
  perMinuteWon: number;
  returnFeeWon: number;
}

export interface ScooterConnectionContext extends MultimodalContext {
  scooterPolicy?: {
    verify(input: {
      vehicle: ScooterVehicle;
      origin: Place;
      destination: Place;
      now: number;
    }): Promise<ScooterRentalPermission | null>;
  };
}

const SEARCH_METERS = 150;
const MAX_EGRESS_METERS = 500;
const MAX_RIDE_METERS = 6000;
const MAX_AGE_MS = 120_000;

const validPoint = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180;

const at = (
  left: Pick<Place, 'latitude' | 'longitude'>,
  right: Pick<Place, 'latitude' | 'longitude'>,
) =>
  Math.abs(left.latitude - right.latitude) < 0.000001 &&
  Math.abs(left.longitude - right.longitude) < 0.000001;

const recent = (stamp: number | null | undefined, now: number) =>
  typeof stamp === 'number' &&
  Number.isFinite(stamp) &&
  stamp > 0 &&
  stamp <= now + 30_000 &&
  now - stamp <= MAX_AGE_MS;

const nonnegative = (number: number) => Number.isSafeInteger(number) && number >= 0;

const sum = (segments: BaseSegment[], edge: 'min' | 'max') =>
  segments.reduce((total, segment) => total + segment.durationSeconds[edge], 0);

function usableVehicle(vehicle: ScooterVehicle, from: Place, now: number): boolean {
  return (
    !!vehicle.id &&
    !!vehicle.provider &&
    validPoint(vehicle) &&
    metersBetween(from, vehicle) <= SEARCH_METERS &&
    vehicle.battery !== null &&
    Number.isFinite(vehicle.battery) &&
    vehicle.battery >= 20 &&
    vehicle.battery <= 100 &&
    recent(vehicle.receivedAt, now) &&
    recent(vehicle.observedAt, now)
  );
}

/** Geometry is validated before outer anchors are normalized to the actual requested points. */
function routed(
  route: BaseRoute | undefined,
  mode: 'walk' | 'scooter',
  from: Place,
  to: Place,
): BaseSegment[] | null {
  if (!route?.segments.length || !route.segments.some((segment) => segment.mode === mode)) {
    return null;
  }

  const segments = route.segments;

  if (
    segments.some((segment, index) => {
      if (
        !validPoint(segment.start) ||
        !validPoint(segment.end) ||
        !Number.isFinite(segment.distanceMeters) ||
        segment.distanceMeters < 0 ||
        !Number.isFinite(segment.durationSeconds.min) ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.min < 0 ||
        segment.durationSeconds.max < segment.durationSeconds.min ||
        segment.traffic?.some((span) => span.level === 'blocked') ||
        (index > 0 && !at(segments[index - 1].end, segment.start))
      ) {
        return true;
      }

      if (segment.mode === 'wait') {
        return (
          segment.distanceMeters !== 0 ||
          !at(segment.start, segment.end) ||
          segment.timingRule !== undefined
        );
      }

      if (segment.mode !== mode || (mode === 'scooter' && segment.routingProfile !== 'scooter')) {
        return true;
      }

      const path = segment.polyline;

      return (
        !path ||
        path.length < 2 ||
        !path.every(validPoint) ||
        metersBetween(path[0], segment.start) > 75 ||
        metersBetween(path.at(-1)!, segment.end) > 75
      );
    })
  ) {
    return null;
  }

  const first = segments[0],
    last = segments.at(-1)!;

  if (metersBetween(first.start, from) > 75 || metersBetween(last.end, to) > 75) {
    return null;
  }

  const firstMoving = segments.find((segment) => segment.mode === mode)!,
    lastMoving = segments.filter((segment) => segment.mode === mode).at(-1)!;

  if (
    metersBetween(firstMoving.polyline![0], from) > 75 ||
    metersBetween(lastMoving.polyline!.at(-1)!, to) > 75
  ) {
    return null;
  }

  return segments.map((segment, index) => ({
    ...segment,
    start: index === 0 ? from : segment.start,
    end: index === segments.length - 1 ? to : segment.end,
  }));
}

async function walk(
  context: ScooterConnectionContext,
  from: Place,
  to: Place,
  maxSeconds = Infinity,
): Promise<BaseSegment[] | null> {
  if (metersBetween(from, to) < 1) {
    return [];
  }

  const alternatives = await context.provider.walking(
    {
      origin: from,
      destination: to,
    },
    context.budget,
  );

  const candidates = alternatives.flatMap((route) => {
    const segments = routed(route, 'walk', from, to);

    if (
      !segments ||
      segments.reduce((total, segment) => total + segment.distanceMeters, 0) > MAX_EGRESS_METERS
    ) {
      return [];
    }

    return [
      {
        route,
        segments,
        cost: acquisitionTiming(
          {
            ...route,
            segments,
          },
          context.now,
          context.acquisitionObjective,
        ).total,
        id: route.id,
      },
    ];
  });

  if (candidates.length > 1) {
    context.onWalkingAlternatives?.(
      candidates.map(({ route, segments }) => ({
        ...route,
        segments,
        durationSeconds: {
          min: sum(segments, 'min'),
          max: sum(segments, 'max'),
        },
        distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
      })),
    );
  }

  return (
    candidates
      .filter((candidate) => sum(candidate.segments, 'max') <= maxSeconds)
      .sort(
        (a, b) =>
          a.cost - b.cost ||
          sum(a.segments, 'max') - sum(b.segments, 'max') ||
          a.id.localeCompare(b.id),
      )[0]?.segments ?? null
  );
}

function permitted(
  permission: ScooterRentalPermission | null,
  vehicle: ScooterVehicle,
  to: Place,
  now: number,
): permission is ScooterRentalPermission {
  return (
    !!permission &&
    permission.vehicleId === vehicle.id &&
    permission.provider === vehicle.provider &&
    permission.pickupAllowed === true &&
    permission.returnAllowed === true &&
    permission.eligibilityAllowed === true &&
    recent(permission.verifiedAt, now) &&
    Number.isFinite(permission.validUntil) &&
    permission.validUntil >= now &&
    validPoint(permission.dropoff) &&
    metersBetween(permission.dropoff, to) <= MAX_EGRESS_METERS &&
    [
      permission.hireSeconds,
      permission.returnSeconds,
      permission.unlockFeeWon,
      permission.perMinuteWon,
      permission.returnFeeWon,
    ].every(nonnegative)
  );
}

/**
 * A rental arc between exact graph anchors. No PM adapter or permission evidence means
 * no arc. Existing TAGO/GBFS vehicle dots never imply eligibility or legal return zones.
 */
export async function scooterConnection(
  context: ScooterConnectionContext,
  preferences: MobilityPreferences,
  from: Place,
  to: Place,
  prefix: string,
): Promise<BaseSegment[] | null> {
  if (
    preferences.walkingOnly ||
    preferences.allowScooter === false ||
    !context.provider.scooter ||
    !context.mobility ||
    !context.scooterPolicy ||
    !validPoint(from) ||
    !validPoint(to) ||
    context.budget.remaining < 1
  ) {
    return null;
  }

  const mobility = context.mobility;

  const [tago, ...gbfs] = await Promise.all([
    mobility.scooters.nearest(from, SEARCH_METERS).catch(() => null),
    ...mobility.gbfs.slice(0, 20).map((feed) => feed.nearby(from, SEARCH_METERS).catch(() => [])),
  ]);

  const candidates: ScooterVehicle[] = [
    ...(tago
      ? [
          {
            ...tago,
            source: 'tago-pm' as const,
          },
        ]
      : []),
    ...gbfs
      .flat()
      .filter(
        (marker) =>
          marker.kind === 'kick-scooter' &&
          marker.entity === 'vehicle' &&
          marker.available &&
          marker.freshness === 'fresh',
      )
      .map((marker) => ({
        id: marker.sourceId,
        provider: marker.provider,
        latitude: marker.latitude,
        longitude: marker.longitude,
        battery: marker.batteryPercent,
        distanceMeters: marker.distanceMeters,
        observedAt: marker.observedAt,
        receivedAt: marker.receivedAt,
        source: 'gbfs' as const,
      })),
  ]
    .filter((vehicle) => usableVehicle(vehicle, from, context.now))
    .sort((left, right) => metersBetween(from, left) - metersBetween(from, right));

  const seen = new Set<string>();

  for (const vehicle of candidates.slice(0, 20)) {
    const key = `${vehicle.source}:${vehicle.provider}:${vehicle.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const permission = await context.scooterPolicy
      .verify({
        vehicle,
        origin: from,
        destination: to,
        now: context.now,
      })
      .catch(() => null);

    if (!permitted(permission, vehicle, to, context.now)) {
      continue;
    }

    const pickup: Place = {
      id: `${vehicle.source}:${vehicle.provider}:${vehicle.id}`,
      name: `${vehicle.provider} 킥보드`,
      address: '',
      latitude: vehicle.latitude,
      longitude: vehicle.longitude,
    };

    const dropoff = permission.dropoff;
    const requiredCalls =
      1 + (metersBetween(from, pickup) >= 1 ? 1 : 0) + (metersBetween(dropoff, to) >= 1 ? 1 : 0);

    if (context.budget.remaining < requiredCalls) {
      return null;
    }

    try {
      const ride = routed(
        (
          await context.provider.scooter(
            {
              origin: pickup,
              destination: dropoff,
            },
            context.budget,
          )
        )[0],
        'scooter',
        pickup,
        dropoff,
      );

      if (
        !ride ||
        ride.reduce((total, segment) => total + segment.distanceMeters, 0) > MAX_RIDE_METERS
      ) {
        continue;
      }

      const accessLimit =
        (permission.validUntil - context.now) / 1000 -
        permission.hireSeconds -
        sum(ride, 'max') -
        permission.returnSeconds;

      const [access, egress] = await Promise.all([
        walk(context, from, pickup, accessLimit),
        walk(context, dropoff, to),
      ]);

      if (!access || !egress) {
        continue;
      }

      const returnAt =
        context.now +
        (sum(access, 'max') +
          permission.hireSeconds +
          sum(ride, 'max') +
          permission.returnSeconds) *
          1000;

      if (permission.validUntil < returnAt) {
        continue;
      }

      const rideCost = Math.ceil(sum(ride, 'max') / 60) * permission.perMinuteWon;

      if (!Number.isSafeInteger(rideCost)) {
        continue;
      }

      const renumber = (segments: BaseSegment[], phase: string) =>
        segments.map((segment, index) => ({
          ...segment,
          id: `${prefix}-${phase}-${index}`,
          runAllowed: false,
          costWon: phase === 'ride' && index === 0 ? rideCost : undefined,
        }));

      return [
        ...renumber(access, 'access'),
        {
          id: `${prefix}-hire`,
          mode: 'hire',
          title: `${pickup.name} 대여`,
          instructions:
            '운영사에서 이용 자격과 대여 허용을 확인한 기기예요. 앱에서 잠금 해제를 완료해 주세요.',
          distanceMeters: 0,
          durationSeconds: {
            min: permission.hireSeconds,
            max: permission.hireSeconds,
          },
          start: pickup,
          end: pickup,
          runAllowed: false,
          costWon: permission.unlockFeeWon,
          rentalValidity: {
            verifiedAt: permission.verifiedAt,
            validUntil: permission.validUntil,
            vehicleId: vehicle.id,
            provider: vehicle.provider,
          },
        },
        ...renumber(ride, 'ride'),
        {
          id: `${prefix}-return`,
          mode: 'return',
          title: `${dropoff.name}에 반납`,
          instructions:
            '운영사가 확인한 반납 위치예요. 안전하게 주차하고 앱에서 반납 완료를 확인해 주세요.',
          distanceMeters: 0,
          durationSeconds: {
            min: permission.returnSeconds,
            max: permission.returnSeconds,
          },
          start: dropoff,
          end: dropoff,
          runAllowed: false,
          costWon: permission.returnFeeWon,
        },
        ...renumber(egress, 'egress'),
      ];
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
    }
  }

  return null;
}
