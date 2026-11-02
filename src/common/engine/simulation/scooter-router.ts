import type { BaseRoute, BaseSegment } from '../../shared/domain/types.js';
import type { CallBudget } from '../call-budget.js';
import { PUSH_INSTRUCTION, pushedAlong } from '../connectivity/pedestrian.js';
import type { RouteEndpoints, RouteProvider } from '../kakao.js';
import { metersBetween } from '../realtime/names.js';

/** Builds scooter rides on top of whatever bicycle router the search already composed. */
export interface ScooterRouting {
  scooter(
    bicycle: NonNullable<RouteProvider['bicycle']>,
    request: RouteEndpoints,
    budget: CallBudget,
  ): Promise<BaseRoute[]>;
}
/** Builds dockless e-bike rides on the same bicycle router. */
export interface EbikeRouting {
  ebike(
    bicycle: NonNullable<RouteProvider['bicycle']>,
    request: RouteEndpoints,
    budget: CallBudget,
  ): Promise<BaseRoute[]>;
}

interface RideProfile {
  mode: 'scooter' | 'ebike';
  noun: string;
  /** What the ride does, then what to watch for; a walked stretch is told between the two. */
  instructions: readonly [string, string];
  fastMetersPerSecond: number;
  slowMetersPerSecond: number;
}
/** A PAS e-bike's motor stops assisting at 25 km/h (research §1); no ride is timed faster. */
const ASSIST_CUTOFF_KMH = 25;
/** The fastest a ride of each kind is timed (km/h), the top of the cruise ranges below. */
export const SCOOTER_TOP_KMH = 20;
export const EBIKE_TOP_KMH = Math.min(21, ASSIST_CUTOFF_KMH);
/**
 * Moving speed between signals. Shared kick-scooters cruise 14–20 km/h (가정값; the 20 km/h top
 * is below the 25 km/h legal cap). Seoul shared-scooter trips average 10.3 km/h with every stop
 * and the unlock included (R §3); the slow end plus the upper signal waits stays near that.
 */
const SCOOTER_RIDE: RideProfile = {
  mode: 'scooter',
  noun: '킥보드',
  instructions: ['자전거 경로를 따라 킥보드로 이동해요.', '교차로와 현장 통행 제한을 확인하세요.'],
  fastMetersPerSecond: SCOOTER_TOP_KMH / 3.6,
  slowMetersPerSecond: 14 / 3.6,
};
/**
 * Assisted cruise 17–21 km/h (가정값) around the 17 km/h observed for pedelecs (R §3,
 * Schleinitz 2017), never past the assist cut-off; with the signal waits a short urban ride
 * comes to about 15 km/h typical and 11–14 km/h at the slow end (Austin dockless e-bikes
 * 10.8–12.4 km/h with every stop, R §3).
 */
const EBIKE_RIDE: RideProfile = {
  mode: 'ebike',
  noun: '전기자전거',
  instructions: [
    '자전거 경로를 따라 전기자전거로 이동해요.',
    '보도로 달리지 말고 교차로를 확인하세요.',
  ],
  fastMetersPerSecond: EBIKE_TOP_KMH / 3.6,
  slowMetersPerSecond: 17 / 3.6,
};
/** A walked stretch this long or longer is told in the ride's instructions, as on a 따릉이 ride. */
const PUSH_NOTE_METERS = 10;
/** The vehicle is walked between the requested point and the network, a metre a second. */
const WALKED_METERS_PER_SECOND = 1;

/**
 * Seconds lost at one signalled intersection counted on the way (가정값): 3–12 s, typically 7.5.
 * A random arrival on the red of a 150 s cycle that is red half the time waits 19 s on average,
 * but the count (every A008P intersection within 20 m) also holds crossings passed on the main
 * green and T-junction sides that never stop the rider. Applied to both dockless kinds alike.
 */
export const SIGNAL_DELAY_SECONDS = { lower: 3, upper: 12 } as const;
/**
 * Signalled intersections per ridden km when the city's list is not loaded: 3.9, counted within
 * 20 m of the local OSRM bicycle routes of 13 test trips (21.6 km, A008P list, 2026-11-01).
 */
export const SIGNALS_PER_KM = 3.9;
/** An intersection this close to the ridden path is passed through. */
const SIGNAL_REACH_METERS = 20;
/** The path is sampled this often when intersections are looked up along it. */
const SIGNAL_SAMPLE_METERS = 10;

type Point = { latitude: number; longitude: number };
/** Signalled intersections near points, without waiting; null while the list is not loaded. */
export interface IntersectionLookup {
  loadedNear(point: Point, radiusMeters: number): readonly { id: string }[] | null;
}
/** Signalled intersections a ridden path passes, or null when the list is not loaded. */
export function signalsAlong(
  path: readonly Point[],
  intersections: IntersectionLookup | undefined,
): number | null {
  return signalsOn([path], intersections);
}

/** Distinct signalled intersections the ridden pieces pass; null when none or no list is loaded. */
function signalsOn(
  pieces: readonly (readonly Point[])[],
  intersections: IntersectionLookup | undefined,
): number | null {
  if (!intersections) return null;
  const seen = new Set<string>();
  let sampled = false;
  for (const path of pieces) {
    if (path.length < 2) continue;
    sampled = true;
    for (let index = 1; index < path.length; index++) {
      const from = path[index - 1],
        to = path[index];
      const steps = Math.max(1, Math.ceil(metersBetween(from, to) / SIGNAL_SAMPLE_METERS));
      for (let step = index === 1 ? 0 : 1; step <= steps; step++) {
        const found = intersections.loadedNear(
          {
            latitude: from.latitude + ((to.latitude - from.latitude) * step) / steps,
            longitude: from.longitude + ((to.longitude - from.longitude) * step) / steps,
          },
          SIGNAL_REACH_METERS,
        );
        if (!found) return null;
        for (const item of found) seen.add(item.id);
      }
    }
  }
  return sampled ? seen.size : null;
}

/**
 * A ride's seconds: moving at the profile's speeds plus the waits at signalled intersections,
 * counted on the path from the city's list or, before it loads, from the measured density.
 * Where the bicycle network has the rider walk the vehicle (a footway, steps, a closed aisle),
 * that stretch takes the network's walking seconds and meets no signal wait.
 */
function rideSeconds(
  segment: BaseSegment,
  profile: RideProfile,
  intersections?: IntersectionLookup,
) {
  const pushed = pushedAlong(segment);
  const pushedMeters = Math.min(pushed?.meters ?? 0, segment.distanceMeters),
    riddenMeters = segment.distanceMeters - pushedMeters,
    pushedSeconds = pushed?.seconds ?? 0;
  const signals =
    (pushed
      ? signalsOn(pushed.ridden, intersections)
      : signalsAlong(segment.polyline ?? [], intersections)) ??
    (riddenMeters / 1000) * SIGNALS_PER_KM;
  return {
    min:
      riddenMeters / profile.fastMetersPerSecond +
      pushedSeconds +
      signals * SIGNAL_DELAY_SECONDS.lower,
    max:
      riddenMeters / profile.slowMetersPerSecond +
      pushedSeconds +
      signals * SIGNAL_DELAY_SECONDS.upper,
  };
}

/**
 * Re-times bicycle-network rides at the vehicle's speed. A route with any other moving mode is
 * dropped; zero-distance provider extras belong to the bicycle ETA and are dropped with it.
 * The ride keeps the bicycle segment's routing source, so its label still names the network.
 */
function routesFromBicycle(
  routes: readonly BaseRoute[],
  request: RouteEndpoints,
  profile: RideProfile,
  intersections?: IntersectionLookup,
): BaseRoute[] {
  return routes.flatMap((route) => {
    if (
      route.segments.some(
        (segment) =>
          segment.mode !== 'bicycle' && !(segment.distanceMeters === 0 && segment.mode !== 'walk'),
      )
    )
      return [];
    const segments = route.segments.flatMap((segment): BaseSegment[] => {
      if (segment.mode !== 'bicycle') return [];
      const path = segment.polyline;
      const walked =
        path && path.length
          ? metersBetween(segment.start, path[0]) + metersBetween(path.at(-1)!, segment.end)
          : 0;
      const walkSeconds = walked / WALKED_METERS_PER_SECOND;
      const ride = rideSeconds(segment, profile, intersections);
      const pushedMeters = pushedAlong(segment)?.meters ?? 0;
      const [moving, caution] = profile.instructions;
      return [
        {
          ...segment,
          id: `${segment.id}-${profile.mode}`,
          mode: profile.mode,
          routingProfile: profile.mode,
          title: `${request.destination.name}까지 ${profile.noun}`,
          instructions:
            pushedMeters >= PUSH_NOTE_METERS
              ? `${moving} 약 ${Math.round(pushedMeters)}m는 끌고 걸어요. ${caution}`
              : `${moving} ${caution}`,
          // The network's step says to get off the bike; the rider is on this kind instead.
          ...(segment.maneuvers && pushedMeters > 0
            ? {
                maneuvers: segment.maneuvers.map((maneuver) => ({
                  ...maneuver,
                  instruction: maneuver.instruction.replace(
                    PUSH_INSTRUCTION,
                    `${profile.noun}에서 내려 끌고 걸어요.`,
                  ),
                })),
              }
            : {}),
          durationSeconds: {
            min: Math.ceil(ride.min + walkSeconds),
            max: Math.ceil(ride.max + walkSeconds),
          },
        },
      ];
    });
    if (!segments.length) return [];
    // A supplier's bicycle landing page would open bicycle directions, not this ride.
    const { landingUrl: _bicycleLanding, ...ride } = route;
    return [
      {
        ...ride,
        id: `${route.id}-${profile.mode}`,
        title: `${profile.noun}로 이동`,
        segments,
        distanceMeters: segments.reduce((total, segment) => total + segment.distanceMeters, 0),
        durationSeconds: {
          min: segments.reduce((total, segment) => total + segment.durationSeconds.min, 0),
          max: segments.reduce((total, segment) => total + segment.durationSeconds.max, 0),
        },
      },
    ];
  });
}

export function scooterRoutesFromBicycle(
  routes: readonly BaseRoute[],
  request: RouteEndpoints,
  intersections?: IntersectionLookup,
): BaseRoute[] {
  return routesFromBicycle(routes, request, SCOOTER_RIDE, intersections);
}

/** E-bike rides at 17–21 km/h on the bicycle network plus signal waits, walked connectors at 1 m/s. */
export function ebikeRoutesFromBicycle(
  routes: readonly BaseRoute[],
  request: RouteEndpoints,
  intersections?: IntersectionLookup,
): BaseRoute[] {
  return routesFromBicycle(routes, request, EBIKE_RIDE, intersections);
}

/** Both dockless kinds, timed at the signalled intersections `intersections` lists when given. */
export function docklessRouting(intersections?: IntersectionLookup): ScooterRouting & EbikeRouting {
  return {
    async scooter(bicycle, request, budget) {
      return scooterRoutesFromBicycle(await bicycle(request, budget), request, intersections);
    },
    async ebike(bicycle, request, budget) {
      return ebikeRoutesFromBicycle(await bicycle(request, budget), request, intersections);
    },
  };
}

export const scooterRouting: ScooterRouting = docklessRouting();

export const ebikeRouting: EbikeRouting = docklessRouting();
