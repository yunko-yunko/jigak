import type { BaseSegment, MobilityPreferences, Place, Route } from './types.js';

const samePosition = (
  a: {
    latitude: number;
    longitude: number;
  },
  b: {
    latitude: number;
    longitude: number;
  },
) => Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;

const freshTimestamp = (stamp: unknown, now: number) =>
  typeof stamp === 'number' &&
  Number.isSafeInteger(stamp) &&
  stamp > 0 &&
  stamp <= now + 30_000 &&
  now - stamp <= 120_000;

const nonemptyId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim();

/** Validate query evidence against the actual connected rental, independently of user-facing notes. */
export function hasBicycleAvailabilityEvidence(
  segments: readonly BaseSegment[],
  planningNow: number,
): boolean {
  if (
    !Number.isFinite(planningNow) ||
    segments.some((segment) => segment.bicycleAvailability !== undefined && segment.mode !== 'hire')
  ) {
    return false;
  }

  let rental: {
    hire: BaseSegment;
    end: Place;
    firstRide?: BaseSegment;
    lastRide?: BaseSegment;
    bicycle: boolean;
  } | null = null;
  let latest = planningNow;

  for (const segment of segments) {
    const timeline =
      'timeRange' in segment
        ? (segment.timeRange as {
            latest: number;
          })
        : undefined;

    latest =
      timeline?.latest ??
      (segment.mode === 'wait' && segment.plannedConnection
        ? segment.plannedConnection.status === 'borderline'
          ? (segment.plannedConnection.fallbackDepartureAt ?? segment.plannedConnection.departureAt)
          : segment.plannedConnection.departureAt
        : latest + segment.durationSeconds.max * 1000);

    if (segment.mode === 'hire') {
      if (rental || !samePosition(segment.start, segment.end) || segment.distanceMeters !== 0) {
        return false;
      }

      rental = {
        hire: segment,
        end: segment.end,
        bicycle: false,
      };
    } else if (rental) {
      if (!samePosition(rental.end, segment.start)) {
        return false;
      }

      if (segment.mode === 'bicycle') {
        if (
          segment.routingProfile !== 'bicycle' ||
          (segment.distanceMeters > 0 && (segment.polyline?.length ?? 0) < 2)
        ) {
          return false;
        }

        rental.bicycle = true;
        rental.firstRide ??= segment;
        rental.lastRide = segment;
      } else if (segment.mode === 'return') {
        const { hire, firstRide, lastRide } = rental,
          proof = hire.bicycleAvailability;

        if (rental.bicycle || proof !== undefined) {
          if (
            !rental.bicycle ||
            !samePosition(segment.start, segment.end) ||
            segment.distanceMeters !== 0
          ) {
            return false;
          }

          const seoul =
            [
              hire.start.id,
              hire.end.id,
              firstRide!.start.id,
              lastRide!.end.id,
              segment.start.id,
              segment.end.id,
            ].some((id) => id.startsWith('ddareungi-')) ||
            ['seoul-bike', '따릉이'].includes(hire.rentalValidity?.provider ?? '');

          if (seoul || proof !== undefined) {
            if (
              !proof ||
              proof.source !== 'seoul-bike' ||
              proof.returnPolicy !== 'designated-station' ||
              !nonemptyId(proof.hireStationId) ||
              !nonemptyId(proof.returnStationId) ||
              proof.hireStationId === proof.returnStationId ||
              !Number.isSafeInteger(proof.availableBikes) ||
              proof.availableBikes < 1 ||
              !freshTimestamp(proof.receivedAt, planningNow) ||
              (proof.observedAt !== null && !freshTimestamp(proof.observedAt, planningNow)) ||
              [hire.start.id, hire.end.id, firstRide!.start.id].some(
                (id) => id !== `ddareungi-${proof.hireStationId}`,
              ) ||
              [lastRide!.end.id, segment.start.id, segment.end.id].some(
                (id) => id !== `ddareungi-${proof.returnStationId}`,
              )
            ) {
              return false;
            }
          } else {
            const permission = hire.rentalValidity;

            if (
              !permission ||
              !freshTimestamp(permission.verifiedAt, planningNow) ||
              !nonemptyId(permission.vehicleId) ||
              !nonemptyId(permission.provider) ||
              !Number.isSafeInteger(permission.validUntil) ||
              permission.validUntil < permission.verifiedAt ||
              !Number.isFinite(latest) ||
              latest > permission.validUntil
            ) {
              return false;
            }
          }
        }

        rental = null;
        continue;
      } else if (
        segment.mode !== 'scooter' &&
        segment.mode !== 'ebike' &&
        (segment.mode !== 'wait' ||
          segment.distanceMeters !== 0 ||
          !samePosition(segment.start, segment.end))
      ) {
        return false;
      } else if (
        (segment.mode === 'scooter' || segment.mode === 'ebike') &&
        (rental.bicycle || rental.hire.bicycleAvailability !== undefined)
      ) {
        return false;
      }

      rental.end = segment.end;
    } else if (segment.mode === 'bicycle') {
      return false;
    }
  }

  return rental === null;
}

/** Hard feasibility gate used on both sides of the network boundary. */
export function validLiveVehicles(
  segments: readonly BaseSegment[],
  preferences: MobilityPreferences,
  origin?: Place,
  timingNow?: number,
): boolean {
  if (preferences.allowTaxi === false && segments.some((segment) => segment.mode === 'taxi')) {
    return false;
  }

  if (
    (preferences.allowScooter === false || preferences.hasScooterLicense === false) &&
    segments.some((segment) => segment.mode === 'scooter')
  ) {
    return false;
  }

  if (preferences.allowEbike === false && segments.some((segment) => segment.mode === 'ebike')) {
    return false;
  }

  if (
    segments.some(
      (segment) => segment.mode === 'run' && (!preferences.allowRunning || !segment.runAllowed),
    )
  ) {
    return false;
  }

  const bicycles = segments.filter((segment) => segment.mode === 'bicycle');

  if (
    bicycles.length &&
    (!preferences.allowBicycle ||
      !preferences.bicycleReady ||
      bicycles.reduce((sum, segment) => sum + segment.distanceMeters, 0) >
        preferences.maxBicycleMeters)
  ) {
    return false;
  }

  if (
    segments.some((segment) => segment.bicycleAvailability !== undefined) &&
    !hasBicycleAvailabilityEvidence(
      segments,
      timingNow ??
        Math.max(
          ...segments.flatMap((segment) =>
            segment.bicycleAvailability ? [segment.bicycleAvailability.receivedAt] : [],
          ),
        ),
    )
  ) {
    return false;
  }

  const hasHires = segments.some((segment) => segment.mode === 'hire');
  let rental: {
    mode: 'bicycle' | 'scooter' | 'ebike' | null;
    end: Place;
    permission: BaseSegment['rentalValidity'];
  } | null = null;
  let latest = timingNow;

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];

    if (
      (segment.mode === 'bicycle' || segment.mode === 'scooter' || segment.mode === 'ebike') &&
      (segment.routingProfile !== segment.mode ||
        (segment.distanceMeters > 0 && (segment.polyline?.length ?? 0) < 2))
    ) {
      return false;
    }

    if (latest !== undefined) {
      const timeline =
        'timeRange' in segment
          ? (segment.timeRange as {
              latest: number;
            })
          : undefined;

      latest =
        timeline?.latest ??
        (segment.mode === 'wait' && segment.plannedConnection
          ? segment.plannedConnection.status === 'borderline'
            ? (segment.plannedConnection.fallbackDepartureAt ??
              segment.plannedConnection.departureAt)
            : segment.plannedConnection.departureAt
          : latest + segment.durationSeconds.max * 1000);
    }

    if (segment.mode === 'hire') {
      const previous = segments[index - 1];

      if (
        rental ||
        !samePosition(segment.start, segment.end) ||
        segment.distanceMeters !== 0 ||
        (previous && !samePosition(previous.end, segment.start)) ||
        (!previous && origin && !samePosition(origin, segment.start))
      ) {
        return false;
      }

      const permission = segment.rentalValidity;

      if (
        permission &&
        (!Number.isFinite(permission.verifiedAt) ||
          !Number.isFinite(permission.validUntil) ||
          permission.validUntil < permission.verifiedAt ||
          typeof permission.vehicleId !== 'string' ||
          !permission.vehicleId.trim() ||
          typeof permission.provider !== 'string' ||
          !permission.provider.trim() ||
          (timingNow !== undefined &&
            (permission.verifiedAt > timingNow + 30000 ||
              timingNow - permission.verifiedAt > 120000)))
      ) {
        return false;
      }

      rental = {
        mode: null,
        end: segment.end,
        permission,
      };
    } else if (rental) {
      if (!samePosition(rental.end, segment.start)) {
        return false;
      }

      if (segment.mode === 'bicycle' || segment.mode === 'scooter' || segment.mode === 'ebike') {
        if (rental.mode && rental.mode !== segment.mode) {
          return false;
        }

        rental.mode = segment.mode;
      } else if (segment.mode === 'return') {
        if (
          !rental.mode ||
          !samePosition(segment.start, segment.end) ||
          segment.distanceMeters !== 0 ||
          (rental.permission &&
            latest !== undefined &&
            (!Number.isFinite(latest) || latest > rental.permission.validUntil))
        ) {
          return false;
        }

        rental = null;
        continue;
      } else if (
        segment.mode !== 'wait' ||
        !samePosition(segment.start, segment.end) ||
        segment.distanceMeters !== 0
      ) {
        return false;
      }

      rental.end = segment.end;
    } else if (
      hasHires &&
      (segment.mode === 'return' ||
        segment.mode === 'bicycle' ||
        segment.mode === 'scooter' ||
        segment.mode === 'ebike')
    ) {
      return false;
    }
  }

  if (rental) {
    return false;
  }

  const cars = segments.filter((segment) => segment.mode === 'car');

  if (!cars.length) {
    return true;
  }

  if (cars.length > 1 || !preferences.hasCar || !preferences.carLocation) {
    return false;
  }

  const car = cars[0],
    index = segments.indexOf(car),
    access = segments[index - 1];

  if (
    !samePosition(car.start, preferences.carLocation) ||
    !car.parkingAccess?.publicAccess ||
    car.parkingAccess.operating === 'closed' ||
    car.parkingAccess.occupancy === 'full'
  ) {
    return false;
  }

  // A preceding step has to actually reach the stored car, rather than teleporting its pickup.
  if (
    (access && !samePosition(access.end, car.start)) ||
    (!access && origin && !samePosition(origin, car.start))
  ) {
    return false;
  }

  const after = segments[index + 1];

  if (
    !after ||
    after.mode !== 'wait' ||
    !samePosition(after.start, car.end) ||
    !samePosition(after.end, car.end)
  ) {
    return false;
  }

  return (car.polyline?.length ?? 0) >= 2;
}

/** Unknown public parking remains comparable, but cannot become the recommended action. */
export function recommendableVehicles(
  route: Pick<Route, 'segments' | 'risks' | 'provenance'>,
): boolean {
  if (route.provenance.mode !== 'live') {
    return true;
  }

  if (
    route.segments.some((segment) => segment.mode === 'bicycle') &&
    !hasBicycleAvailabilityEvidence(route.segments, route.provenance.receivedAt)
  ) {
    return false;
  }

  if (
    route.risks.some(
      (risk) =>
        risk.severity === 'warning' &&
        ['vehicle-availability', 'bicycle-stock', 'parking'].includes(risk.code),
    )
  ) {
    return false;
  }

  return route.segments.every(
    (segment) =>
      segment.mode !== 'car' ||
      (segment.parkingAccess?.operating === 'open' &&
        segment.parkingAccess.occupancy === 'available' &&
        segment.parkingAccess.fee !== 'unknown' &&
        segment.parkingAccess.verifiedAt !== null),
  );
}
