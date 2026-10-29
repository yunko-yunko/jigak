import {
  scheduledArrivalAt,
  publishedServiceEnded,
  scheduledDepartures,
  timetableIsFresh,
  timetableMatchesSegment,
} from '../shared/domain/subwayTimetable.js';
import type {
  BasePlanningRequest,
  BaseRoute,
  BaseSegment,
  Connection,
  ParkingAccess,
  Place,
  Risk,
} from '../shared/domain/types.js';
import {
  boardingWaitRange,
  evaluateBaseTimeline,
  REALTIME_BOARDING_BUFFER_SECONDS,
} from '../shared/domain/routing.js';
import { validLiveVehicles } from '../shared/domain/vehicleConstraints.js';
import { metersBetween, stationBaseName } from './realtime/names.js';
import { expectedWaitSeconds } from './transit-enrichment.js';
import { taxiPickupSeconds } from './multimodal.js';
import type { WeatherSnapshot } from '../shared/intelligence/types.js';
import {
  applyContextualEtaSegment,
  learningFeaturesForSegment,
  type ContextualPredictor,
} from './intelligence/learning-features.js';
import { localWeatherIsFresh } from './intelligence/planningTiming.js';
import {
  applyPublicBusSegment,
  restorePublicBusSource,
  type PublicBusPredictor,
} from './intelligence/public-bus-timing.js';
import {
  estimateBaseTimeline,
  estimatedSegmentSeconds,
  type RoutingObjective,
} from '../shared/domain/estimatedTiming.js';
import { compareRouteEffort } from '../shared/domain/routeEffort.js';
import { MinPriorityQueue } from './min-priority-queue.js';

export interface JourneyGraphOptions {
  receivedAt: number;
  objective?: RoutingObjective;
  /** Exact is for small-network validation; it removes computation caps, not user constraints. */ searchMode?:
    'bounded' | 'exact';
  maxExpansions?: number;
  maxResults?: number;
  maxEdges?: number;
  maxLabelsPerState?: number;
  maxLegs?: number;
  maxJourneySeconds?: number;
  /** Reserve a comparison candidate from already fetched rental paths without changing their costs. */ requiredMode?:
    'bicycle' | 'scooter';
  parkingAt?: (lot: Place, arrivalAt: number) => ParkingAccess | null;
  contextualEta?: {
    weather: WeatherSnapshot | null;
    predict: ContextualPredictor;
  };
  publicBusEta?: {
    predict: PublicBusPredictor;
  };
  acceptRoute?: (route: BaseRoute) => boolean;
  /** Nonnegative correction to the selected objective, never a change of physical chronology. */ scoreCompleteRoute?: (
    route: BaseRoute,
  ) => number;
}

export type JourneyGraphLimit =
  'edges' | 'expansions' | 'labels' | 'legs' | 'duration' | 'comparison-results';

export interface JourneyGraphDiagnostics {
  scope: 'bounded-fetched-network';
  searchMode: 'bounded' | 'exact';
  objective: RoutingObjective;
  pathDomain: 'no-repeated-transfer-node';
  nodes: number;
  edges: number;
  expanded: number;
  excludedEdges: number;
  complete: boolean;
  limitReached: boolean;
  termination: 'exhausted' | 'result-bound' | 'expansion-limit' | 'stale-input';
  limitsReached: JourneyGraphLimit[];
  omittedLabels: number;
  /** All bounds use the selected objective's elapsed seconds, plus any nonnegative complete-route correction. */
  bestObjectiveSeconds: number | null;
  unexploredLowerBoundSeconds: number | null;
  optimalityGapSeconds: number | null;
  optimalityProven: boolean;
}

export interface JourneyGraphResult {
  routes: BaseRoute[];
  diagnostics: JourneyGraphDiagnostics;
}

export const DEFAULT_MAX_JOURNEY_SECONDS = 4 * 60 * 60;

interface Arc {
  id: string;
  from: string;
  to: string;
  segments: BaseSegment[];
  notes: Risk[];
  resource: 'rental' | 'car' | null;
}

interface Label {
  node: string;
  min: number;
  max: number;
  estimated: number;
  segments: BaseSegment[];
  arcs: string[];
  visited: Set<string>;
  rentals: number;
  carUsed: boolean;
  requiredModeUsed: boolean;
  bicycleMeters: number;
  runningMeters: number;
  precedingWaitSeconds: number;
  vehicleCount: number;
  notes: Risk[];
  discarded?: boolean;
}

const key = (point: Pick<Place, 'latitude' | 'longitude'>) =>
  `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;

const at = (a: Place, b: Place) =>
  Math.abs(a.latitude - b.latitude) < 0.000001 && Math.abs(a.longitude - b.longitude) < 0.000001;

const transit = (segment: BaseSegment) => segment.mode === 'bus' || segment.mode === 'subway';

const moving = (segment: BaseSegment) =>
  ['walk', 'run', 'bus', 'subway', 'bicycle', 'scooter', 'car', 'taxi'].includes(segment.mode);

const number = (value: number, fallback: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max ? value : fallback;

const fresh = (value: number, now: number) =>
  Number.isFinite(value) && value <= now + 30000 && now - value <= 120000;

const warning = (code: Risk['code'], title: string, description: string): Risk => ({
  code,
  severity: 'warning',
  title,
  description,
});

const distinctNotes = (notes: Risk[]) => [
  ...new Map(notes.map((note) => [JSON.stringify(note), note])).values(),
];

const segmentSignature = (segment: BaseSegment) => ({
  mode: segment.mode,
  start: key(segment.start),
  end: key(segment.end),
  distance: segment.distanceMeters,
  duration: segment.durationSeconds,
  line: segment.lineName,
  direction: segment.direction,
  transit: segment.transit,
  realtime: segment.realtime,
  profile: segment.routingProfile,
  parking: segment.parkingAccess,
  rental: segment.rentalValidity,
  bicycleAvailability: segment.bicycleAvailability,
  expectedWaitBasisSeconds: segment.expectedWaitBasisSeconds,
  expectedWaitBasisRangeSeconds: segment.expectedWaitBasisRangeSeconds,
  cost: segment.costWon,
  traffic: segment.traffic,
  roadDelay: segment.roadDelaySeconds,
  planningBuffer: segment.planningBuffer,
  routingSource: segment.routingSource,
  networkSnap: segment.networkSnap,
  runAllowed: segment.runAllowed,
  walkingDuration: segment.walkingDurationSeconds,
  polyline: segment.polyline?.map(key),
  timingRule: segment.timingRule,
  // Equal current estimates do not imply equal estimates after a different
  // access path: re-evaluation consumes the original baseline and features.
  etaPrediction: segment.etaPrediction,
  publicEtaPrediction: segment.publicEtaPrediction,
  plannedConnection: segment.plannedConnection,
  timetable: segment.timetable,
  scheduledConnection: segment.scheduledConnection,
});

const pathSignature = (segments: readonly BaseSegment[]) =>
  JSON.stringify(segments.map(segmentSignature));

const evidenceSignature = (label: Label) =>
  JSON.stringify({
    notes: distinctNotes(label.notes),
    vehicles: label.segments
      .filter((segment) =>
        ['bus', 'subway', 'bicycle', 'scooter', 'taxi', 'car'].includes(segment.mode),
      )
      .map(segmentSignature),
  });

/** Histories with different clocks, remaining resources or forbidden future nodes are not interchangeable. */
const continuationState = (label: Label) =>
  JSON.stringify([
    label.node,
    label.min,
    label.max,
    label.estimated,
    label.rentals,
    label.carUsed,
    label.requiredModeUsed,
    label.bicycleMeters,
    label.runningMeters,
    label.precedingWaitSeconds,
    label.vehicleCount,
    label.segments.length,
    [...label.visited].sort(),
  ]);

const usableGeometry = (segment: BaseSegment) =>
  !moving(segment) ||
  segment.distanceMeters === 0 ||
  (!!segment.polyline &&
    segment.polyline.length >= 2 &&
    segment.polyline.every(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180,
    ) &&
    metersBetween(segment.polyline[0], segment.start) <= 75 &&
    metersBetween(segment.polyline.at(-1)!, segment.end) <= 75);

function notesForArc(source: BaseRoute, segments: readonly BaseSegment[]): Risk[] {
  const ids = new Set(segments.map((segment) => segment.id));

  const missingFoot = (segment: BaseSegment) =>
    ['walk', 'run'].includes(segment.mode) &&
    segment.distanceMeters > 0 &&
    (segment.polyline?.length ?? 0) < 2;

  const omittedSourceFoot = source.segments.some(missingFoot) && !segments.some(missingFoot);

  return (source.notes ?? []).filter((note) => {
    if (note.segmentId && !ids.has(note.segmentId)) {
      return false;
    }

    // This server-generated warning describes an estimated access/egress edge, not
    // the other verified fragments reused from the same original itinerary.
    return !(
      omittedSourceFoot &&
      note.code === 'unverified-duration-range' &&
      note.title === '일부 도보 경로 미확인'
    );
  });
}

/** Provider road snapping is tolerated only at the requested journey's outer foot boundaries. */
function alignOuterFootBoundaries(source: BaseRoute, request: BasePlanningRequest): BaseRoute {
  const segments = source.segments.map((segment) => ({
    ...segment,
  }));
  const first = segments[0];

  if (
    first &&
    (first.mode === 'walk' || first.mode === 'run') &&
    metersBetween(first.start, request.origin) <= 75
  ) {
    first.start = request.origin;
  }

  let lastIndex = segments.length - 1;
  const allowance = segments[lastIndex];

  if (allowance?.mode === 'wait' && allowance.id.endsWith('-provider-extra')) {
    lastIndex--;
  }

  const last = segments[lastIndex];

  if (
    last &&
    (last.mode === 'walk' || last.mode === 'run') &&
    metersBetween(last.end, request.destination) <= 75
  ) {
    const previousEnd = last.end;

    last.end = request.destination;

    if (
      allowance !== last &&
      allowance?.mode === 'wait' &&
      at(allowance.start, previousEnd) &&
      at(allowance.end, previousEnd)
    ) {
      allowance.start = request.destination;
      allowance.end = request.destination;
    }
  }

  return {
    ...source,
    segments,
  };
}

/** A provider's explicitly adjacent transit/walk transfer can have a few metres of rounding. */
function alignDeclaredFootTransfers(source: BaseRoute): BaseRoute {
  const segments = source.segments;

  for (let index = 0; index < segments.length; index++) {
    const foot = segments[index];

    if (foot.mode !== 'walk' && foot.mode !== 'run') {
      continue;
    }

    const previous = segments[index - 1];
    let nextIndex = index + 1;

    while (
      segments[nextIndex] &&
      ['entry', 'wait'].includes(segments[nextIndex].mode) &&
      segments[nextIndex].distanceMeters === 0 &&
      at(segments[nextIndex].start, segments[nextIndex].end)
    ) {
      nextIndex++;
    }

    const next = segments[nextIndex];
    const transfer = !!previous && transit(previous) && !!next && transit(next);
    const startTolerance =
      transfer &&
      previous.mode === 'subway' &&
      stationBaseName(previous.end.name) === stationBaseName(foot.start.name)
        ? 35
        : 5;
    const endTolerance =
      transfer &&
      next.mode === 'subway' &&
      stationBaseName(foot.end.name) === stationBaseName(next.start.name)
        ? 35
        : 5;

    if (
      previous &&
      transit(previous) &&
      metersBetween(previous.end, foot.start) <= startTolerance
    ) {
      foot.start = previous.end;
    }

    if (
      next &&
      transit(next) &&
      metersBetween(foot.end, next.start) <= endTolerance &&
      segments.slice(index + 1, nextIndex).every((segment) => at(segment.start, next.start))
    ) {
      foot.end = next.start;
    }
  }

  return source;
}

/** These policy functions are constant between their declared daily clock boundaries. */
function dailyRuleRange(
  earliest: number,
  latest: number,
  changes: readonly number[],
  rule: (at: number) => number,
) {
  const times = [earliest, latest],
    day = 86400000,
    kstOffset = 9 * 3600000;

  for (
    let start = Math.floor((earliest + kstOffset) / day) * day - kstOffset;
    start <= latest;
    start += day
  ) {
    for (const minute of changes) {
      const change = start + minute * 60000;

      if (change >= earliest && change <= latest) {
        times.push(change);
      }
    }
  }

  const seconds = times.map(rule);

  return {
    min: Math.min(...seconds),
    max: Math.max(...seconds),
  };
}

const dispatchRange = (earliest: number, latest: number) =>
  dailyRuleRange(earliest, latest, [90, 450, 570, 1050, 1170, 1350], taxiPickupSeconds);

const headwayRange = (vehicle: BaseSegment, earliest: number, latest: number) =>
  dailyRuleRange(earliest, latest, [360, 420, 570, 1050, 1200, 1320], (at) =>
    expectedWaitSeconds(vehicle, at),
  );

/** Exact transfer anchors only: nearby roads, station interiors and stops are never implicit links. */
function compile(sources: readonly BaseRoute[], request: BasePlanningRequest, cap: number) {
  const arcs: Arc[] = [];
  const seen = new Set<string>();
  let excluded = 0,
    truncated = false;

  function add(source: BaseRoute, start: number, end: number, resource: Arc['resource'] = null) {
    const segments = source.segments.slice(start, end + 1).map((segment) => ({
      ...segment,
      durationSeconds: {
        ...segment.durationSeconds,
      },
    }));

    if (
      !segments.length ||
      segments.some(
        (segment) =>
          !usableGeometry(segment) ||
          !Number.isFinite(segment.distanceMeters) ||
          segment.distanceMeters < 0 ||
          !Number.isFinite(segment.durationSeconds.min) ||
          !Number.isFinite(segment.durationSeconds.max) ||
          segment.durationSeconds.min < 0 ||
          segment.durationSeconds.max < segment.durationSeconds.min ||
          segment.traffic?.some((span) => span.level === 'blocked'),
      ) ||
      segments.some((segment, index) => index > 0 && !at(segments[index - 1].end, segment.start))
    ) {
      excluded++;

      return;
    }

    if (
      segments.some(
        (segment) =>
          (segment.mode === 'bicycle' || segment.mode === 'scooter') &&
          (segment.routingProfile !== segment.mode || resource !== 'rental'),
      )
    ) {
      excluded++;

      return;
    }

    if (
      resource === 'rental' &&
      new Set(
        segments
          .filter((segment) => segment.mode === 'bicycle' || segment.mode === 'scooter')
          .map((segment) => segment.mode),
      ).size !== 1
    ) {
      excluded++;

      return;
    }

    const taxiIndex = segments.findIndex((segment) => segment.mode === 'taxi');

    if (
      taxiIndex >= 0 &&
      !segments
        .slice(0, taxiIndex)
        .some(
          (segment) =>
            segment.mode === 'wait' &&
            at(segment.start, segments[taxiIndex].start) &&
            at(segment.end, segments[taxiIndex].start),
        )
    ) {
      excluded++;

      return;
    }

    if (
      segments.some(
        (segment) =>
          segment.mode === 'run' && (!segment.runAllowed || !request.preferences.allowRunning),
      )
    ) {
      excluded++;

      return;
    }

    if (resource === 'car') {
      const car = segments.find((segment) => segment.mode === 'car')!,
        parking = segments.at(-1)!;

      if (
        !request.preferences.hasCar ||
        !request.preferences.carLocation ||
        !at(car.start, request.preferences.carLocation) ||
        !car.parkingAccess?.publicAccess ||
        car.parkingAccess.operating === 'closed' ||
        car.parkingAccess.occupancy === 'full' ||
        parking.mode !== 'wait' ||
        !at(parking.start, car.end) ||
        !at(parking.end, car.end)
      ) {
        excluded++;

        return;
      }
    }

    const notes = notesForArc(source, segments);
    const signature = `${resource ?? 'none'}:${pathSignature(segments)}:${JSON.stringify(notes)}`;

    if (seen.has(signature)) {
      return;
    }

    seen.add(signature);

    if (arcs.length >= cap) {
      truncated = true;

      return;
    }

    arcs.push({
      id: `${source.id}:${start}-${end}`,
      from: key(segments[0].start),
      to: key(segments.at(-1)!.end),
      segments,
      resource,
      notes,
    });
  }

  for (const input of sources) {
    const source = alignDeclaredFootTransfers(alignOuterFootBoundaries(input, request));

    for (let i = 0; i < source.segments.length; i++) {
      const segment = source.segments[i];

      if (segment.mode === 'hire') {
        let end = i + 1;

        while (
          end < source.segments.length &&
          ['bicycle', 'scooter', 'wait'].includes(source.segments[end].mode)
        ) {
          end++;
        }

        const body = source.segments.slice(i + 1, end);

        if (
          source.segments[end]?.mode === 'return' &&
          body.some((segment) => segment.mode === 'bicycle' || segment.mode === 'scooter')
        ) {
          add(source, i, end, 'rental');
          i = end;
        } else {
          excluded++;
        }
      } else if (segment.mode === 'car') {
        if (source.segments[i + 1]?.mode === 'wait') {
          add(source, i, i + 1, 'car');
          i++;
        } else {
          excluded++;
        }
      } else if (segment.mode === 'walk' || segment.mode === 'run') {
        const extra = source.segments[i + 1];

        if (extra?.mode === 'wait' && extra.id.endsWith('-provider-extra')) {
          add(source, i, i + 1);
          i++;
        } else {
          add(source, i, i);
        }
      } else if (segment.mode === 'entry' || segment.mode === 'wait') {
        let end = i;

        while (
          end < source.segments.length &&
          ['entry', 'wait'].includes(source.segments[end].mode)
        ) {
          end++;
        }

        if (
          source.segments[end] &&
          (transit(source.segments[end]) || source.segments[end].mode === 'taxi')
        ) {
          if (
            source.segments[end + 1]?.mode === 'wait' &&
            source.segments[end + 1].id.endsWith('-provider-extra')
          ) {
            end++;
          }

          add(source, i, end);
          i = end;
        }
      } else if (transit(segment) || segment.mode === 'taxi') {
        const extra = source.segments[i + 1];

        if (extra?.mode === 'wait' && extra.id.endsWith('-provider-extra')) {
          add(source, i, i + 1);
          i++;
        } else {
          add(source, i, i);
        }
      } else {
        excluded++;
      }
    }
  }

  return {
    arcs,
    excluded,
    truncated,
  };
}

function evaluate(
  arc: Arc,
  label: Label,
  request: BasePlanningRequest,
  options: JourneyGraphOptions,
): {
  segments: BaseSegment[];
  min: number;
  max: number;
  estimated: number;
  notes: Risk[];
  precedingWaitSeconds: number;
  vehicleCount: number;
} | null {
  const source = arc.segments.map((segment) => ({
    ...segment,
    durationSeconds: {
      ...segment.durationSeconds,
    },
  }));
  const vehicle = source.find(transit),
    notes = [...arc.notes],
    parts: BaseSegment[] = [];
  let min = label.min,
    max = label.max,
    estimated = label.estimated,
    precedingWaitSeconds = label.precedingWaitSeconds,
    vehicleCount = label.vehicleCount;
  const estimateObjective = options.objective === 'estimated-arrival';
  const weather = localWeatherIsFresh(options.contextualEta?.weather, request)
    ? options.contextualEta!.weather
    : null;

  function append(input: BaseSegment, nextVehicle?: BaseSegment) {
    let segment = restorePublicBusSource(input);

    if (
      segment.mode === 'wait' &&
      segment.timingRule === 'taxi-dispatch' &&
      source.some((part) => part.mode === 'taxi')
    ) {
      const dispatch = dispatchRange(request.now + min * 1000, request.now + max * 1000);
      const includedBuffer =
        (segment.planningBuffer?.weatherSeconds ?? 0) +
        (segment.planningBuffer?.calibrationSeconds ?? 0);

      segment = {
        ...segment,
        durationSeconds: {
          min: dispatch.min,
          max: dispatch.max + includedBuffer,
        },
      };
    } else if (
      segment.mode === 'wait' &&
      !segment.realtime &&
      !segment.plannedConnection &&
      !segment.scheduledConnection &&
      nextVehicle &&
      segment.id.endsWith('-expected-wait')
    ) {
      const baseline = segment.etaPrediction?.sourceDurationSeconds ?? segment.durationSeconds;
      const inferred = expectedWaitSeconds(nextVehicle, request.now);
      const basis =
        segment.expectedWaitBasisSeconds ?? (baseline.min >= inferred ? inferred : undefined);

      const previousRange =
        segment.expectedWaitBasisRangeSeconds ??
        (basis === undefined
          ? undefined
          : {
              min: basis,
              max: basis,
            });

      if (
        previousRange &&
        Number.isFinite(previousRange.min) &&
        Number.isFinite(previousRange.max) &&
        previousRange.min > 0 &&
        previousRange.max >= previousRange.min &&
        baseline.min >= previousRange.min &&
        baseline.max >= previousRange.max
      ) {
        const seconds = expectedWaitSeconds(nextVehicle, request.now + max * 1000);
        const range = headwayRange(nextVehicle, request.now + min * 1000, request.now + max * 1000);

        if (range.min !== previousRange.min || range.max !== previousRange.max) {
          const { etaPrediction, ...rest } = segment;

          // The restored source range already includes its original safety margin.
          // Restore that metadata too, or the point clock and next model input would
          // reinterpret the margin as physical waiting after this headway change.
          segment = {
            ...rest,
            ...(etaPrediction
              ? {
                  planningBuffer: {
                    ...(etaPrediction.sourcePlanningBuffer ?? {
                      weatherSeconds: 0,
                      calibrationSeconds: 0,
                    }),
                  },
                }
              : {}),
            durationSeconds: {
              min: baseline.min - previousRange.min + range.min,
              max: baseline.max - previousRange.max + range.max,
            },
            expectedWaitBasisSeconds: seconds,
            expectedWaitBasisRangeSeconds: range,
          };
        } else if (
          segment.expectedWaitBasisSeconds === undefined ||
          segment.expectedWaitBasisRangeSeconds === undefined
        ) {
          segment = {
            ...segment,
            expectedWaitBasisSeconds: seconds,
            expectedWaitBasisRangeSeconds: range,
          };
        }
      }
    }

    if (options.contextualEta && !segment.scheduledConnection) {
      const feature = learningFeaturesForSegment(
        segment,
        {
          startedAt: request.now + (estimateObjective ? estimated : max) * 1000,
          precedingWaitSeconds,
          vehicleCount,
        },
        weather,
      );

      segment = applyContextualEtaSegment(
        segment,
        feature,
        request.now,
        options.contextualEta.predict,
      );
    }

    if (options.publicBusEta) {
      segment = applyPublicBusSegment(
        segment,
        request.now + (estimateObjective ? estimated : max) * 1000,
        request.now,
        options.publicBusEta.predict,
      );
    }

    const previous = max,
      connection =
        segment.mode === 'wait'
          ? (segment.plannedConnection ?? segment.scheduledConnection)
          : undefined;
    const estimatedDuration =
      connection && nextVehicle
        ? estimateBaseTimeline([segment, nextVehicle], request.now, request.now + estimated * 1000)
            ?.components[0]?.seconds
        : estimatedSegmentSeconds(segment, request.now + estimated * 1000, nextVehicle);
    const previousEstimate = estimated;

    estimated += estimatedDuration ?? NaN;

    if (connection) {
      min = (connection.departureAt - request.now) / 1000;
      max =
        ((connection.status === 'borderline'
          ? connection.fallbackDepartureAt!
          : connection.departureAt) -
          request.now) /
        1000;
    } else if (segment.mode === 'subway' && segment.scheduledConnection && segment.timetable) {
      const early = scheduledArrivalAt(segment.timetable, request.now + min * 1000),
        late = scheduledArrivalAt(segment.timetable, request.now + max * 1000);

      min = early === null ? NaN : (early - request.now) / 1000;
      max = late === null ? NaN : (late - request.now) / 1000;
    } else {
      min += segment.durationSeconds.min;
      max += segment.durationSeconds.max;
    }

    if (segment.mode === 'wait') {
      precedingWaitSeconds += estimateObjective ? estimated - previousEstimate : max - previous;
    } else if (['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter'].includes(segment.mode)) {
      vehicleCount++;
      precedingWaitSeconds = 0;
    }

    parts.push(segment);
  }

  if (vehicle) {
    const index = source.findIndex(transit),
      prefix = source.slice(0, index);
    let live = vehicle.realtime;

    // Boarding waits belong to the old access clock. Replace both averages and
    // explicit departure bindings before selecting a train for this history;
    // only a fixed stop/platform delay remains physical access.
    const usableTable =
      timetableIsFresh(vehicle.timetable, request.now) &&
      timetableMatchesSegment(vehicle.timetable, vehicle);

    if (
      live &&
      usableTable &&
      (!fresh(live.receivedAt, request.now) || !fresh(live.observedAt, request.now))
    ) {
      live = undefined;
    }

    const access =
      live || usableTable
        ? prefix.filter(
            (segment) =>
              segment.mode !== 'wait' ||
              (!segment.id.endsWith('-expected-wait') &&
                !segment.plannedConnection &&
                !segment.scheduledConnection),
          )
        : prefix;

    for (const segment of access) {
      append(segment, live || usableTable ? undefined : vehicle);
    }

    const reachMin = request.now + min * 1000,
      reachMax = request.now + max * 1000;

    const appendPublished = () => {
      const selected = scheduledDepartures(
        vehicle,
        {
          earliest: reachMin,
          latest: reachMax,
        },
        request.now,
      );

      if (!selected) {
        return false;
      }

      const scheduledVehicle = {
        ...vehicle,
        realtime: undefined,
        plannedConnection: undefined,
        scheduledConnection: selected.connection,
        durationSeconds: selected.ride,
        etaPrediction: undefined,
        planningBuffer: {
          weatherSeconds: 0,
          calibrationSeconds: 0,
        },
      };

      append(
        {
          id: `${arc.id}-timetable-wait`,
          mode: 'wait',
          title: '공개 시간표에 맞춰 대기',
          instructions: selected.connection.explanation,
          start: vehicle.start,
          end: vehicle.start,
          distanceMeters: 0,
          durationSeconds: selected.wait,
          planningBuffer: {
            weatherSeconds: 0,
            calibrationSeconds: 0,
          },
          runAllowed: false,
          timetable: vehicle.timetable,
          scheduledConnection: selected.connection,
        },
        scheduledVehicle,
      );

      for (let next = index; next < source.length; next++) {
        append(next === index ? scheduledVehicle : source[next]);
      }

      notes.push({
        code: 'unverified-schedule',
        severity: 'info',
        title: '공개 시간표 적용',
        description:
          '해당 운행일의 공개 시간표에서 방향·후속역·하차역 정차를 확인했어요. 실시간 지연이나 결행은 반영되지 않을 수 있어요.',
      });

      return true;
    };

    if (live) {
      if (
        live.status !== 'live' ||
        !fresh(live.receivedAt, request.now) ||
        !fresh(live.observedAt, request.now)
      ) {
        return null;
      }

      const buffer = REALTIME_BOARDING_BUFFER_SECONDS[vehicle.mode as 'bus' | 'subway'] * 1000;
      const predictions = live.predictions
        .map((prediction) => prediction.arrivesAt)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const earliest = predictions.find((time) => time >= reachMin + buffer),
        latest = predictions.find((time) => time >= reachMax + buffer);

      if (earliest === undefined || latest === undefined) {
        if (
          reachMin - request.now < 600000 ||
          !predictions.length ||
          predictions.at(-1)! >= reachMin ||
          live.predictions.some((prediction) => prediction.lastService)
        ) {
          return null;
        }

        if (
          publishedServiceEnded(
            vehicle,
            {
              earliest: reachMin,
              latest: reachMax,
            },
            request.now,
          )
        ) {
          return null;
        }

        if (!appendPublished()) {
          const seconds = expectedWaitSeconds(vehicle, reachMax);

          append(
            {
              id: `${arc.id}-future-expected-wait`,
              mode: 'wait',
              title: '미래 환승 · 평균 배차 추정',
              instructions:
                '현재 공개된 도착 예측은 이 정류장에 도착하기 전에 끝나요. 이후의 차량은 특정하지 않고 평균 배차 대기를 추정했어요. 운행 여부는 도착 전에 다시 확인해 주세요.',
              start: vehicle.start,
              end: vehicle.start,
              distanceMeters: 0,
              durationSeconds: {
                min: seconds,
                max: seconds,
              },
              expectedWaitBasisSeconds: seconds,
              runAllowed: false,
            },
            vehicle,
          );

          for (const segment of source.slice(index)) {
            const {
              realtime: _realtime,
              plannedConnection: _connection,
              scheduledConnection: _scheduled,
              ...estimate
            } = segment;

            append(estimate);
          }

          notes.push(
            warning(
              'unverified-schedule',
              '미래 환승의 배차 대기 추정',
              '현재 도착 예측 범위를 벗어난 먼 환승은 평균 배차 대기를 적용했어요. 실제 후속 차량·출발 시각이나 운행을 확인한 결과가 아니며, 첫차·막차와 다음 편을 다시 확인해야 해요.',
            ),
          );
        }
      } else {
        const waitDuration = boardingWaitRange(vehicle, {
          earliest: reachMin,
          latest: reachMax,
        })!;

        const connection: Connection = {
          departureAt: earliest,
          ...(predictions.find((time) => time > latest) !== undefined
            ? {
                fallbackDepartureAt: predictions.find((time) => time > latest),
              }
            : {}),
          status: earliest === latest ? 'comfortable' : 'borderline',
          boardingMarginSeconds: Math.floor((earliest - reachMax - buffer) / 1000),
          explanation:
            '현재 정류장 도착 예측과 앞 구간의 소요를 함께 계산했어요. 실제 정차·출발 시각은 달라질 수 있어요.',
        };

        if (connection.status === 'borderline') {
          connection.fallbackDepartureAt = latest;
        }

        const liveVehicle = {
          ...vehicle,
          plannedConnection: connection,
          scheduledConnection: undefined,
        };

        append(
          {
            id: `${arc.id}-graph-expected-wait`,
            mode: 'wait',
            title: '정류장 도착 예측에 맞춰 대기',
            instructions: connection.explanation,
            start: vehicle.start,
            end: vehicle.start,
            distanceMeters: 0,
            durationSeconds: waitDuration,
            planningBuffer: {
              weatherSeconds: 0,
              calibrationSeconds: 0,
            },
            runAllowed: false,
            realtime: live,
            plannedConnection: connection,
          },
          liveVehicle,
        );

        for (let next = index; next < source.length; next++) {
          append(next === index ? liveVehicle : source[next]);
        }
      }
    } else {
      if (
        publishedServiceEnded(
          vehicle,
          {
            earliest: reachMin,
            latest: reachMax,
          },
          request.now,
        )
      ) {
        return null;
      }

      if (!appendPublished()) {
        if (usableTable || !prefix.some((segment) => segment.mode === 'wait')) {
          const seconds = expectedWaitSeconds(vehicle, reachMax);

          append(
            {
              id: `${arc.id}-graph-expected-wait`,
              mode: 'wait',
              title: '평균 배차 대기 추정',
              instructions:
                '실시간 도착편이 없어 평균 배차 대기를 사용해요. 첫차·막차와 실제 탑승 가능 여부를 확인해 주세요.',
              start: vehicle.start,
              end: vehicle.start,
              distanceMeters: 0,
              durationSeconds: {
                min: seconds,
                max: seconds,
              },
              expectedWaitBasisSeconds: seconds,
              runAllowed: false,
            },
            vehicle,
          );
        }

        for (const segment of source.slice(index)) {
          append(segment);
        }

        notes.push(
          warning(
            'unverified-schedule',
            '일부 탑승 시각은 추정',
            '실시간 정류장 도착 정보가 없는 구간은 기존 경로의 평균 대기 시간을 적용했어요. 첫차·막차와 다음 차량을 확인해야 해요.',
          ),
        );
      }
    }
  } else {
    for (const segment of source) {
      append(segment);
    }
  }

  if (arc.resource === 'rental') {
    const permission = parts.find((segment) => segment.mode === 'hire')?.rentalValidity;

    if (
      permission &&
      (!fresh(permission.verifiedAt, request.now) ||
        !Number.isFinite(permission.validUntil) ||
        permission.validUntil < permission.verifiedAt ||
        !permission.vehicleId ||
        !permission.provider ||
        request.now + max * 1000 > permission.validUntil)
    ) {
      return null;
    }
  }

  if (arc.resource === 'car' && options.parkingAt) {
    const car = parts.find((segment) => segment.mode === 'car')!,
      parking = options.parkingAt(car.end, request.now + max * 1000);

    if (!parking?.publicAccess || parking.operating === 'closed' || parking.occupancy === 'full') {
      return null;
    }

    car.parkingAccess = parking;
  }

  const timeline = evaluateBaseTimeline(parts, request.now, {
    earliest: request.now + label.min * 1000,
    latest: request.now + label.max * 1000,
  });
  const arrival = timeline?.at(-1);

  if (!arrival) {
    return null;
  }

  const point = estimateBaseTimeline(parts, request.now, request.now + label.estimated * 1000);

  if (estimateObjective && (!point || !Number.isFinite(estimated))) {
    return null;
  }

  return {
    segments: parts,
    min: (arrival.earliest - request.now) / 1000,
    max: (arrival.latest - request.now) / 1000,
    estimated: point
      ? (point.arrivalAt - request.now) / 1000
      : (arrival.latest - request.now) / 1000,
    notes,
    precedingWaitSeconds,
    vehicleCount,
  };
}

const hash = (value: string) => {
  let n = 2166136261;

  for (const character of value) {
    n = Math.imul(n ^ character.charCodeAt(0), 16777619);
  }

  return (n >>> 0).toString(36);
};

function materialize(label: Label, request: BasePlanningRequest): BaseRoute {
  const segments = label.segments.map((segment, index) => ({
    ...segment,
    id: `graph-${index}-${segment.id}`,
  }));
  const segmentIds = new Map(
    label.segments.map((segment, index) => [segment.id, segments[index].id]),
  );

  const notes = label.notes.map((note) =>
    note.segmentId
      ? {
          ...note,
          segmentId: segmentIds.get(note.segmentId) ?? note.segmentId,
        }
      : note,
  );

  const vehicles = segments.filter((segment) =>
    ['bus', 'subway', 'taxi', 'car', 'bicycle', 'scooter'].includes(segment.mode),
  );

  const names = vehicles.map((segment) =>
    segment.mode === 'bus'
      ? (segment.lineName ?? segment.transit?.lines[0] ?? '버스')
      : segment.mode === 'subway'
        ? (segment.lineName ?? segment.transit?.lines[0] ?? '지하철')
        : {
            taxi: '택시',
            car: '자가용',
            bicycle: '따릉이',
            scooter: '킥보드',
          }[segment.mode as 'taxi'],
  );

  const costsKnown =
    vehicles.length > 0 &&
    vehicles.every((segment) => segment.mode === 'taxi' && Number.isFinite(segment.costWon));

  return {
    id: `graph-${hash(pathSignature(segments))}`,
    title: names.filter((value, index) => value !== names[index - 1]).join(' → ') || '도보',
    segments,
    durationSeconds: {
      min: label.min,
      max: label.max,
    },
    distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    transfers: Math.max(0, vehicles.length - 1),
    ...(costsKnown
      ? {
          fareWon: vehicles.reduce((sum, segment) => sum + segment.costWon!, 0),
        }
      : {}),
    timingEvaluatedAt: request.now,
    notes: distinctNotes([
      ...notes,
      {
        code: 'missing-source-time',
        severity: 'info',
        title: '조회한 이동망에서 조합 탐색',
        description:
          '실제로 조회한 경로와 같은 환승 지점만 연결해 탐색했어요. 서울 전체의 모든 경로를 조회한 결과는 아니에요. 공개되지 않은 신호·차량 정차 시간은 별도 실시간 관측값으로 가정하지 않았어요.',
      },
    ]),
  };
}

/** An admissible remainder from fetched segments only. Replaceable waits cost zero in this bound.
 * A context model can shorten any segment, so its safe bound is zero rather than the provider's estimate.
 */
function remainingLowerBounds(
  arcs: readonly Arc[],
  destination: string,
  options: JourneyGraphOptions,
): Map<string, number> {
  const incoming = new Map<
    string,
    {
      from: string;
      seconds: number;
    }[]
  >();

  for (const arc of arcs) {
    const seconds = options.contextualEta
      ? 0
      : arc.segments.reduce(
          (sum, segment) =>
            sum +
            (segment.mode === 'wait' || (segment.mode === 'subway' && segment.timetable)
              ? 0
              : restorePublicBusSource(segment).durationSeconds.min),
          0,
        );

    incoming.set(arc.to, [
      ...(incoming.get(arc.to) ?? []),
      {
        from: arc.from,
        seconds,
      },
    ]);
  }

  const bounds = new Map([[destination, 0]]),
    pending = [
      {
        node: destination,
        seconds: 0,
      },
    ];

  while (pending.length) {
    pending.sort((a, b) => b.seconds - a.seconds);

    const current = pending.pop()!;

    if (current.seconds !== bounds.get(current.node)) {
      continue;
    }

    for (const edge of incoming.get(current.node) ?? []) {
      const seconds = current.seconds + edge.seconds;

      if (seconds >= (bounds.get(edge.from) ?? Infinity)) {
        continue;
      }

      bounds.set(edge.from, seconds);
      pending.push({
        node: edge.from,
        seconds,
      });
    }
  }

  return bounds;
}

/** Time-dependent resource-constrained label search over fetched paths, with no invented network edges. */
export function planJourneyGraph(
  request: BasePlanningRequest,
  sources: readonly BaseRoute[],
  options: JourneyGraphOptions,
): JourneyGraphResult {
  const exact = options.searchMode === 'exact',
    objective = options.objective ?? 'conservative-arrival';

  const elapsed = (label: Label) =>
    objective === 'estimated-arrival' ? label.estimated : label.max;

  const routeElapsed = (route: BaseRoute) =>
    objective === 'estimated-arrival'
      ? ((estimateBaseTimeline(route.segments, request.now)?.arrivalAt ?? Infinity) - request.now) /
        1000
      : route.durationSeconds.max;

  const diagnostics: JourneyGraphDiagnostics = {
    scope: 'bounded-fetched-network',
    searchMode: exact ? 'exact' : 'bounded',
    objective,
    pathDomain: 'no-repeated-transfer-node',
    nodes: 0,
    edges: 0,
    expanded: 0,
    excludedEdges: 0,
    complete: true,
    limitReached: false,
    termination: 'exhausted',
    limitsReached: [],
    omittedLabels: 0,
    bestObjectiveSeconds: null,
    unexploredLowerBoundSeconds: null,
    optimalityGapSeconds: null,
    optimalityProven: false,
  };

  if (!fresh(options.receivedAt, request.now)) {
    diagnostics.complete = false;
    diagnostics.termination = 'stale-input';

    return {
      routes: [],
      diagnostics,
    };
  }

  const maxEdges = exact ? Infinity : number(options.maxEdges ?? 512, 512, 1, 2000),
    maxExpansions = exact ? Infinity : number(options.maxExpansions ?? 2500, 2500, 1, 20000),
    maxResults = number(options.maxResults ?? 6, 6, 1, 18),
    maxLabels = exact ? Infinity : number(options.maxLabelsPerState ?? 12, 12, 1, 100),
    maxLegs =
      exact && options.maxLegs === undefined ? Infinity : number(options.maxLegs ?? 24, 24, 1, 100),
    horizon =
      exact && options.maxJourneySeconds === undefined
        ? Infinity
        : number(
            options.maxJourneySeconds ?? DEFAULT_MAX_JOURNEY_SECONDS,
            DEFAULT_MAX_JOURNEY_SECONDS,
            1,
            86400,
          );

  const limits = new Set<JourneyGraphLimit>();
  let omittedLowerBound = Infinity;
  const { arcs, excluded, truncated } = compile(sources, request, maxEdges);

  diagnostics.edges = arcs.length;
  diagnostics.excludedEdges = excluded;

  if (truncated) {
    limits.add('edges');
    omittedLowerBound = 0;
  }

  const outgoing = new Map<string, Arc[]>(),
    incoming = new Map<string, string[]>(),
    nodes = new Set<string>();

  for (const arc of arcs) {
    nodes.add(arc.from);
    nodes.add(arc.to);
    outgoing.set(arc.from, [...(outgoing.get(arc.from) ?? []), arc]);
    incoming.set(arc.to, [...(incoming.get(arc.to) ?? []), arc.from]);
  }

  diagnostics.nodes = nodes.size;

  const origin = key(request.origin),
    destination = key(request.destination);
  const remaining = remainingLowerBounds(arcs, destination, options);

  const lowerBound = (label: Label) => elapsed(label) + (remaining.get(label.node) ?? Infinity);

  const omit = (label: Label, reason: JourneyGraphLimit) => {
    limits.add(reason);
    diagnostics.omittedLabels++;
    omittedLowerBound = Math.min(omittedLowerBound, lowerBound(label));
  };

  // A missing directed path in the compiled network is conclusive. No geographic
  // distance, assumed speed or time estimate is used to discard a branch.
  const reachesDestination = new Set([destination]),
    reverseQueue = [destination];

  for (let index = 0; index < reverseQueue.length; index++) {
    for (const from of incoming.get(reverseQueue[index]) ?? []) {
      if (!reachesDestination.has(from)) {
        reachesDestination.add(from);
        reverseQueue.push(from);
      }
    }
  }

  const requiredMode = options.requiredMode;

  const canReachRequiredMode = (start: string, visited: ReadonlySet<string>): boolean => {
    if (!requiredMode) {
      return true;
    }

    if (start === destination || !reachesDestination.has(start)) {
      return false;
    }

    // Ignore time, eligibility and future visited nodes here. This is an
    // over-approximation over actual directed arcs: only a missing structural
    // completion may discard a history before it occupies the bounded frontier.
    const pending = [
        {
          node: start,
          used: false,
        },
      ],
      seen = new Set([`${start}|0`]);

    for (let index = 0; index < pending.length; index++) {
      const current = pending[index];

      for (const arc of outgoing.get(current.node) ?? []) {
        if (visited.has(arc.to) || !reachesDestination.has(arc.to)) {
          continue;
        }

        const used = current.used || arc.segments.some((segment) => segment.mode === requiredMode);

        if (arc.to === destination) {
          if (used) {
            return true;
          }

          continue;
        }

        const state = `${arc.to}|${Number(used)}`;

        if (!seen.has(state)) {
          seen.add(state);
          pending.push({
            node: arc.to,
            used,
          });
        }
      }
    }

    return false;
  };

  const initial: Label = {
    node: origin,
    min: 0,
    max: 0,
    estimated: 0,
    segments: [],
    arcs: [],
    visited: new Set([origin]),
    rentals: 0,
    carUsed: false,
    requiredModeUsed: false,
    bicycleMeters: 0,
    runningMeters: 0,
    precedingWaitSeconds: 0,
    vehicleCount: 0,
    notes: [],
  };

  const frontier = new Map<string, Label[]>();
  const routes: BaseRoute[] = [];
  const completedPaths = new Set<string>();
  const accepted = new Set<BaseRoute>();
  let completed = 0;
  const scores = new Map<BaseRoute, number>();

  // Keep complete-arrival ties open through the bound check below. Access speed
  // and queue heuristics cannot decide which equal-arrival itinerary fills top-k.
  const compareRoutes = (a: BaseRoute, b: BaseRoute) =>
    Number(accepted.has(b)) - Number(accepted.has(a)) ||
    (scores.get(a) ?? routeElapsed(a)) - (scores.get(b) ?? routeElapsed(b)) ||
    a.durationSeconds.max - b.durationSeconds.max ||
    a.durationSeconds.min - b.durationSeconds.min ||
    compareRouteEffort(a, b) ||
    a.id.localeCompare(b.id);

  const priority = (a: Label, b: Label) =>
    lowerBound(a) - lowerBound(b) ||
    elapsed(a) - elapsed(b) ||
    a.max - b.max ||
    a.min - b.min ||
    a.notes.filter((note) => note.severity === 'warning').length -
      b.notes.filter((note) => note.severity === 'warning').length ||
    a.bicycleMeters - b.bicycleMeters ||
    a.runningMeters - b.runningMeters ||
    a.segments.length - b.segments.length;

  // Stable ties preserve the prior sort's expansion order, including when a
  // computation budget ends before every equal-arrival alternative is examined.
  const queue = new MinPriorityQueue<Label>(priority);

  if (canReachRequiredMode(origin, initial.visited)) {
    queue.push(initial);
  }

  const resultBound = () =>
    accepted.size < maxResults
      ? Infinity
      : (scores.get(
          routes.filter((route) => accepted.has(route)).sort(compareRoutes)[maxResults - 1],
        ) ?? Infinity);

  while (queue.size && diagnostics.expanded < maxExpansions) {
    const label = queue.peek()!;

    if (label.discarded) {
      queue.pop();
      continue;
    }

    // The complete-route correction is nonnegative. Physical elapsed time is
    // therefore a lower bound, while every actual boarding still uses its clock.
    if (lowerBound(label) > resultBound()) {
      diagnostics.termination = 'result-bound';
      break;
    }

    queue.pop();
    diagnostics.expanded++;

    if (label.node === destination && label.segments.length) {
      // Other modes neither fill the reserved slot nor count as omitted rental alternatives.
      if (options.requiredMode && !label.requiredModeUsed) {
        continue;
      }

      const signature = pathSignature(label.segments);

      if (
        !completedPaths.has(signature) &&
        validLiveVehicles(label.segments, request.preferences, request.origin, request.now)
      ) {
        completedPaths.add(signature);
        completed++;

        const route = materialize(label, request),
          usable = !options.acceptRoute || options.acceptRoute(route);

        if (usable) {
          const predicted = options.scoreCompleteRoute?.(route);
          const baseline = elapsed(label);

          scores.set(
            route,
            Number.isFinite(predicted) && predicted! >= baseline ? predicted! : baseline,
          );
          accepted.add(route);
          routes.push(route);

          if (accepted.size > maxResults) {
            const worst = routes
              .filter((candidate) => accepted.has(candidate))
              .sort(compareRoutes)
              .at(-1)!;

            accepted.delete(worst);
            routes.splice(routes.indexOf(worst), 1);
            scores.delete(worst);
          }
        } else if (routes.filter((candidate) => !accepted.has(candidate)).length < maxResults) {
          routes.push(route);
        }
      }

      continue;
    }

    for (const arc of outgoing.get(label.node) ?? []) {
      if (
        !reachesDestination.has(arc.to) ||
        label.visited.has(arc.to) ||
        arc.from === arc.to ||
        (arc.resource === 'car' && label.carUsed)
      ) {
        continue;
      }

      if (
        request.preferences.walkingOnly &&
        arc.segments.some((segment) => !['walk', 'entry', 'wait'].includes(segment.mode))
      ) {
        continue;
      }

      if (
        arc.segments.some(
          (segment) =>
            (segment.mode === 'taxi' && request.preferences.allowTaxi === false) ||
            (segment.mode === 'scooter' && request.preferences.allowScooter === false) ||
            (segment.mode === 'bicycle' &&
              (!request.preferences.allowBicycle || !request.preferences.bicycleReady)),
        )
      ) {
        continue;
      }

      const evaluated = evaluate(arc, label, request, options);

      if (!evaluated) {
        continue;
      }

      const next: Label = {
        ...label,
        node: arc.to,
        min: evaluated.min,
        max: evaluated.max,
        estimated: evaluated.estimated,
        precedingWaitSeconds: evaluated.precedingWaitSeconds,
        vehicleCount: evaluated.vehicleCount,
        segments: [...label.segments, ...evaluated.segments],
        arcs: [...label.arcs, arc.id],
        visited: new Set([...label.visited, arc.to]),
        rentals: label.rentals + Number(arc.resource === 'rental'),
        carUsed: label.carUsed || arc.resource === 'car',
        requiredModeUsed:
          label.requiredModeUsed ||
          (!!options.requiredMode &&
            arc.segments.some((segment) => segment.mode === options.requiredMode)),
        bicycleMeters:
          label.bicycleMeters +
          arc.segments
            .filter((segment) => segment.mode === 'bicycle')
            .reduce((n, s) => n + s.distanceMeters, 0),
        runningMeters:
          label.runningMeters +
          arc.segments
            .filter((segment) => segment.mode === 'run')
            .reduce((n, s) => n + s.distanceMeters, 0),
        notes: [...label.notes, ...evaluated.notes],
      };

      if (
        next.bicycleMeters > request.preferences.maxBicycleMeters ||
        next.runningMeters > request.preferences.maxRunningMeters
      ) {
        continue;
      }

      if (next.max > horizon) {
        omit(next, 'duration');
        continue;
      }

      if (next.segments.length > maxLegs) {
        omit(next, 'legs');
        continue;
      }

      if (!next.requiredModeUsed && !canReachRequiredMode(next.node, next.visited)) {
        continue;
      }

      // Completed itineraries retain their distinct line/permission/price evidence for final ranking.
      if (next.node === destination) {
        queue.push(next);
        continue;
      }

      // A faster prefix can use up a resource or reach a different departure window.
      // Apply the per-state cap only to interchangeable continuation states. The
      // global expansion cap still bounds production work across distinct states.
      const state = `${continuationState(next)}|${evidenceSignature(next)}${options.scoreCompleteRoute || options.acceptRoute ? `|${pathSignature(next.segments)}` : ''}`;
      const previous = frontier.get(state) ?? [];

      const dominates = (a: Label, b: Label) =>
        a.min === b.min &&
        a.max === b.max &&
        a.estimated === b.estimated &&
        a.precedingWaitSeconds === b.precedingWaitSeconds &&
        a.vehicleCount === b.vehicleCount &&
        a.bicycleMeters <= b.bicycleMeters &&
        a.runningMeters <= b.runningMeters &&
        a.segments.length <= b.segments.length &&
        [...a.visited].every((node) => b.visited.has(node)) &&
        evidenceSignature(a) === evidenceSignature(b) &&
        (!(exact || options.scoreCompleteRoute || options.acceptRoute) ||
          pathSignature(a.segments) === pathSignature(b.segments));

      if (next.node !== destination && previous.some((old) => dominates(old, next))) {
        continue;
      }

      const kept = previous.filter((old) => !dominates(next, old));

      for (const old of previous) {
        if (!kept.includes(old)) {
          old.discarded = true;
        }
      }

      if (kept.length >= maxLabels) {
        kept.sort(priority);

        const worst = kept.at(-1)!;

        if (priority(next, worst) >= 0) {
          omit(next, 'labels');
          continue;
        }

        omit(worst, 'labels');
        worst.discarded = true;
        kept.pop();
      }

      kept.push(next);
      frontier.set(state, kept);
      queue.push(next);
    }
  }

  // The primary priority is the admissible lower bound. Remove stale roots so
  // neither a discarded history nor a full frontier scan changes the certificate.
  while (queue.peek()?.discarded) {
    queue.pop();
  }

  const pending = queue.peek(),
    pendingLowerBound = pending ? lowerBound(pending) : Infinity;

  if (pendingLowerBound < Infinity && diagnostics.expanded >= maxExpansions) {
    if (pendingLowerBound > resultBound()) {
      diagnostics.termination = 'result-bound';
    } else {
      limits.add('expansions');
      diagnostics.termination = 'expansion-limit';
    }
  }

  if (!options.scoreCompleteRoute && options.acceptRoute && completed > maxResults) {
    limits.add('comparison-results');
  }

  diagnostics.limitsReached = [...limits];
  diagnostics.limitReached = limits.size > 0;
  diagnostics.complete = !diagnostics.limitReached;

  const best = routes.filter((route) => accepted.has(route)).sort(compareRoutes)[0];

  diagnostics.bestObjectiveSeconds = best ? scores.get(best)! : null;

  const unexplored = Math.min(omittedLowerBound, pendingLowerBound);

  diagnostics.unexploredLowerBoundSeconds = Number.isFinite(unexplored) ? unexplored : null;
  diagnostics.optimalityGapSeconds = best ? Math.max(0, scores.get(best)! - unexplored) : null;
  diagnostics.optimalityProven = best ? unexplored >= scores.get(best)! : unexplored === Infinity;

  return {
    routes: routes.sort(compareRoutes).slice(0, maxResults),
    diagnostics,
  };
}
