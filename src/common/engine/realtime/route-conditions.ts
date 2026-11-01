import type { BaseRoute } from '../../shared/domain/types.js';
import type { SearchProfiler } from '../search-performance.js';
import type { SeoulTimetableService } from './subwayTimetable.js';
import type { RoadTrafficService } from './seoulTraffic.js';
import { applyRoadConditions } from './routeTraffic.js';

/** Railway schedules and bus-road speeds do not depend on each other. Fetch them concurrently,
 * then attach schedule evidence by route/segment position (IDs can repeat across source routes).
 * Road duration/geometry and all supplier seconds remain those of the road-enriched result.
 */
export async function enrichRouteConditions(
  routes: BaseRoute[],
  at: number,
  traffic: RoadTrafficService,
  timetable?: Pick<SeoulTimetableService, 'enrich'>,
  profiler?: SearchProfiler,
): Promise<BaseRoute[]> {
  const timed = <T>(name: 'timetable' | 'traffic', task: () => Promise<T>) =>
    profiler ? profiler.measure(name, task) : task();

  const [scheduled, roads] = await Promise.all([
    timetable ? timed('timetable', () => timetable.enrich(routes, at)) : Promise.resolve(routes),
    timed('traffic', () => applyRoadConditions(routes, traffic)),
  ]);

  if (!timetable) {
    return roads;
  }

  if (scheduled.length !== roads.length) {
    throw new Error('Schedule enrichment changed route identities');
  }

  return roads.map((route, index) => {
    const plan = scheduled[index];

    if (plan.id !== route.id || plan.segments.length !== route.segments.length) {
      throw new Error('Schedule enrichment changed route identities');
    }

    return {
      ...route,
      segments: route.segments.map((segment, position) => {
        const schedule = plan.segments[position];

        if (schedule.id !== segment.id || schedule.mode !== segment.mode) {
          throw new Error('Schedule enrichment changed segment identities');
        }

        return segment.mode === 'subway'
          ? {
              ...segment,
              timetable: schedule.timetable,
              scheduledConnection: schedule.scheduledConnection,
              scheduleCheck: schedule.scheduleCheck,
              ...(schedule.headwayEvidence ? { headwayEvidence: schedule.headwayEvidence } : {}),
            }
          : segment;
      }),
    };
  });
}
