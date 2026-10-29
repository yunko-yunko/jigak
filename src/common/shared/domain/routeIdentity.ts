import type { Place, Provenance, Route } from './types.js';

const point = (value: Pick<Place, 'id' | 'latitude' | 'longitude'>) => [
  value.id,
  value.latitude,
  value.longitude,
];

const source = (value: Provenance) => [
  value.mode,
  value.provider,
  value.label,
  value.sourceTimestamp,
  value.receivedAt,
  value.isRealtime,
];

/** Provider IDs are reused across queries. Compare the actual guidance geometry and timing. */
export function routeGuidanceSignature(route: Route): string {
  return JSON.stringify([
    route.id,
    point(route.origin),
    point(route.destination),
    source(route.provenance),
    [route.arrivalTime.earliest, route.arrivalTime.latest],
    [route.readyTime.earliest, route.readyTime.latest],
    [route.durationSeconds.min, route.durationSeconds.max],
    route.risks.map((risk) => [
      risk.code,
      risk.severity,
      risk.segmentId,
      risk.title,
      risk.description,
    ]),
    route.journeyEta ?? null,
    route.segments.map((segment) => [
      segment.id,
      segment.mode,
      segment.title,
      segment.instructions,
      point(segment.start),
      point(segment.end),
      segment.distanceMeters,
      [segment.durationSeconds.min, segment.durationSeconds.max],
      segment.walkingDurationSeconds
        ? [segment.walkingDurationSeconds.min, segment.walkingDurationSeconds.max]
        : null,
      segment.polyline?.map((coordinate) => [coordinate.latitude, coordinate.longitude]) ?? null,
      source(segment.provenance),
      segment.routingSource ? source(segment.routingSource) : null,
      segment.networkSnap ?? null,
      [segment.timeRange.earliest, segment.timeRange.latest],
      segment.connection
        ? [
            segment.connection.departureAt,
            segment.connection.fallbackDepartureAt,
            segment.connection.fallbackArrivalAt,
            segment.connection.status,
            segment.connection.boardingMarginSeconds,
          ]
        : null,
      segment.runAllowed,
      segment.lineName,
      segment.direction,
      segment.publicEtaPrediction ?? null,
      segment.timetable ?? null,
      segment.scheduledConnection ?? null,
    ]),
  ]);
}
