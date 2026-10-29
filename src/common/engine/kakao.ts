import { z } from 'zod';
import type {
  BaseRoute,
  BaseSegment,
  Maneuver,
  Place,
  TrafficLevel,
  TrafficSpan,
} from '../shared/domain/index.js';
import { ApiError } from './errors.js';
import { CallBudget } from './call-budget.js';
import { requestSupplierText } from './supplier-http.js';
import { stationBaseName } from './realtime/names.js';

const stationName = (name: string) => `${stationBaseName(name)}역`;

/** Korean particle 으로/로 by the final sound: "9호선으로", "공항철도로", "1호선으로". */
export function withRo(word: string): string {
  const last = word.trim().at(-1) ?? '';
  const code = last.charCodeAt(0) - 0xac00;

  if (code >= 0 && code < 11172) {
    const final = code % 28;

    return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
  }

  return `${word}${/[036]$/.test(last) ? '으로' : '로'}`;
}

const walkDistance = (meters: number) =>
  meters >= 1_000
    ? `${(meters / 1_000).toFixed(1)}km`
    : `${Math.max(10, Math.round(meters / 10) * 10)}m`;

const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);

const path = z.object({
  points: z.array(coordinate).max(100_000),
});
const seconds = z.number().int().min(0).max(604_800);
const meters = z.number().int().min(0).max(1_000_000);

const routeTotals = z.object({
  totalDistance: meters,
  totalTime: seconds,
});

const walkStep = z.object({
  properties: z.object({
    distance: meters,
    time: seconds,
    guidance: z.string().max(2_000),
    x: z.number().finite().min(-180).max(180),
    y: z.number().finite().min(-90).max(90),
  }),
  path,
});

const walkResponse = z.object({
  status: z.string(),
  route: z
    .object({
      properties: routeTotals.extend({
        landingUrl: z.string().optional(),
      }),
      legs: z
        .array(
          z.object({
            properties: z.object({
              distance: meters,
              time: seconds,
            }),
            steps: z.array(walkStep).max(2_000),
          }),
        )
        .max(6),
    })
    .optional(),
});

const transitStep = z.object({
  properties: z.object({
    guidance: z.string().max(2_000),
    type: z.enum(['WALKING', 'BUS', 'SUBWAY']),
    distance: meters,
    time: seconds,
    stops: z
      .array(
        z.object({
          name: z.string().max(300),
        }),
      )
      .optional(),
    vehicles: z
      .array(
        z.object({
          name: z.string().max(300),
          type: z.string().max(100),
        }),
      )
      .optional(),
  }),
  path,
});

const transitResponse = z.object({
  status: z.string(),
  properties: z
    .object({
      landingURL: z.string().optional(),
    })
    .optional(),
  routes: z
    .array(
      z.object({
        properties: routeTotals.extend({
          type: z.enum(['BUS', 'SUBWAY', 'BUS_AND_SUBWAY']),
          transfers: z.number().int().min(0).max(30),
          fare: z
            .object({
              value: z.number().min(0).optional(),
              min: z.number().min(0).optional(),
              max: z.number().min(0).optional(),
            })
            .optional(),
        }),
        steps: z.array(transitStep).max(100),
      }),
    )
    .max(100)
    .optional(),
});

const placesResponse = z.object({
  documents: z
    .array(
      z.object({
        id: z.string(),
        place_name: z.string(),
        address_name: z.string(),
        road_address_name: z.string().optional(),
        x: z.string(),
        y: z.string(),
      }),
    )
    .max(15),
});

const nearbyResponse = z.object({
  documents: z
    .array(
      z.object({
        id: z.string(),
        place_name: z.string(),
        category_name: z.string().max(300),
        address_name: z.string(),
        road_address_name: z.string().optional(),
        x: z.string(),
        y: z.string(),
        distance: z.string().optional(),
      }),
    )
    .max(15),
});

const drivingResponse = z.object({
  routes: z
    .array(
      z.object({
        result_code: z.number().int(),
        summary: z
          .object({
            distance: meters,
            duration: seconds,
            fare: z
              .object({
                taxi: z.number().min(0).optional(),
                toll: z.number().min(0).optional(),
              })
              .optional(),
          })
          .optional(),
        sections: z
          .array(
            z.object({
              roads: z
                .array(
                  z.object({
                    vertexes: z.array(z.number().finite()).max(400_000),
                    traffic_state: z.number().int().optional(),
                    distance: z.number().min(0).optional(),
                  }),
                )
                .max(10_000),
              guides: z
                .array(
                  z.object({
                    x: z.number().finite().min(-180).max(180),
                    y: z.number().finite().min(-90).max(90),
                    type: z.number().int(),
                    guidance: z.string().max(500),
                  }),
                )
                .max(10_000),
            }),
          )
          .max(30)
          .optional(),
      }),
    )
    .min(1),
});

const addressResponse = z.object({
  documents: z
    .array(
      z.object({
        road_address: z
          .object({
            address_name: z.string(),
            building_name: z.string().optional(),
            road_name: z.string().optional(),
            main_building_no: z.string().optional(),
            sub_building_no: z.string().optional(),
          })
          .nullable()
          .optional(),
        address: z
          .object({
            address_name: z.string(),
            region_3depth_name: z.string().optional(),
            main_address_no: z.string().optional(),
            sub_address_no: z.string().optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .max(10),
});

export interface ReverseGeocode {
  name: string;
  address: string;
}

/** Short human label for a coordinate: "한강대로 405" or "봉래동2가 122-11". */
export function normalizeAddress(input: unknown): ReverseGeocode | null {
  const document = readPayload(addressResponse, input).documents[0];

  if (!document) {
    return null;
  }

  const road = document.road_address,
    lot = document.address;
  const roadName =
    road?.road_name && road.main_building_no
      ? `${road.road_name} ${road.main_building_no}${road.sub_building_no ? `-${road.sub_building_no}` : ''}`
      : '';
  const lotName =
    lot?.region_3depth_name && lot.main_address_no
      ? `${lot.region_3depth_name} ${lot.main_address_no}${lot.sub_address_no ? `-${lot.sub_address_no}` : ''}`
      : '';
  const address = road?.address_name || lot?.address_name || '';
  const name = roadName || lotName || address;

  return name
    ? {
        name,
        address,
      }
    : null;
}

export interface PlaceSearch {
  q: string;
  latitude?: number;
  longitude?: number;
}

export interface RouteEndpoints {
  origin: Place;
  destination: Place;
}

/** A road route for a taxi or the rider's own car. */
export interface DrivingLeg {
  distanceMeters: number;
  durationSeconds: number;
  polyline: {
    latitude: number;
    longitude: number;
  }[];
  maneuvers: Maneuver[];
  taxiFareWon?: number;
  tollWon?: number;
  /** Live congestion per road, as vertex ranges of `polyline`. */
  traffic: TrafficSpan[];
}

/** Kakao Mobility traffic_state: 1 정체, 2 지체, 3 서행, 4 원활, 6 사고·통제, 0 정보 없음. */
const TRAFFIC_LEVELS: Record<number, TrafficLevel> = {
  1: 'jam',
  2: 'delay',
  3: 'slow',
  4: 'free',
  6: 'blocked',
};

export interface NearbyQuery {
  keyword: string;
  latitude: number;
  longitude: number;
  radius: number;
}

export interface NearbyPlace extends Place {
  category: string;
  distanceMeters: number;
}

export interface RouteProvider {
  configured: boolean;
  searchPlaces(query: PlaceSearch): Promise<Place[]>;
  walking(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]>;
  transit(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]>;
  /** Dedicated bicycle network; pedestrian geometry is never a fallback. */
  bicycle?(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]>;
  /** Dedicated PM routing with operator parking/eligibility rules, when a provider supports it. */
  scooter?(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]>;
  reverseGeocode?(point: { latitude: number; longitude: number }): Promise<ReverseGeocode | null>;
  /** Live-traffic road route (Kakao Mobility); absent providers simply skip road modes. */
  driving?(request: RouteEndpoints, budget: CallBudget): Promise<DrivingLeg>;
  /** Keyword places nearest a point, e.g. public parking lots or bike stations. */
  nearby?(query: NearbyQuery): Promise<NearbyPlace[]>;
  /** Read-only hint for a validated, fresh source result requiring no new HTTP.
   * The actual provider and CallBudget still enforce each attempted request.
   */
  queryIsReusable?(
    mode: 'walking' | 'transit' | 'bicycle' | 'scooter' | 'driving',
    request: RouteEndpoints,
    budget: CallBudget,
  ): boolean;
}

export interface KakaoOptions {
  key?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function responseProblem(): ApiError {
  return new ApiError(
    'PROVIDER_RESPONSE',
    '카카오 응답을 안전하게 해석할 수 없어 해당 경로를 제외했어요.',
  );
}

function readPayload<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw responseProblem();
  }

  return parsed.data;
}

function assertRouteStatus(status: string): void {
  if (status === 'OK') {
    return;
  }

  const noRoutes = [
    'STARTNODES_NULL',
    'ENDNODES_NULL',
    'EQUAL_POINTS',
    'NO_RESULTS',
    'SAME_POINT',
    'START_LINK_NOT_FOUND',
    'END_LINK_NOT_FOUND',
    'TOO_FAR_AWAY',
    'ROUTE_RESULT_NOT_FOUND',
  ];

  if (noRoutes.includes(status)) {
    throw new ApiError(
      'NO_ROUTES',
      '이 지점 사이에서 제공되는 경로를 찾지 못했어요. 출발지나 목적지를 바꿔 주세요.',
      404,
    );
  }

  throw new ApiError(
    'PROVIDER_RESPONSE',
    '카카오가 유효한 경로를 반환하지 않았어요. 입력 지점을 확인해 주세요.',
  );
}

function safeLandingUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);

    return url.protocol === 'https:' && url.hostname === 'map.kakao.com'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function endpointPlace(id: string, name: string, point: [number, number]): Place {
  // Coordinates come from the provider path. A stop name is not a public station ID.
  return {
    id,
    name,
    address: '',
    latitude: point[1],
    longitude: point[0],
  };
}

type ProviderStep = {
  properties: {
    distance: number;
    time: number;
    guidance: string;
    type?: 'WALKING' | 'BUS' | 'SUBWAY';
    x?: number;
    y?: number;
    stops?: {
      name: string;
    }[];
    vehicles?: {
      name: string;
      type: string;
    }[];
  };
  path: {
    points: [number, number][];
  };
};

function joinedPoints(steps: ProviderStep[]): [number, number][] {
  const points: [number, number][] = [];

  for (const step of steps) {
    for (const point of step.path.points) {
      const last = points[points.length - 1];

      if (!last || last[0] !== point[0] || last[1] !== point[1]) {
        points.push(point);
      }
    }
  }

  return points;
}

/** Strip the stop-name echo Kakao prefixes onto transit walking guidance ("사당사당역 환승"). */
function cleanGuidance(guidance: string, stopNames: string[]): string {
  let value = guidance.replace(/\s+/g, ' ').trim();

  for (const name of stopNames) {
    if (name && value.startsWith(name) && value.length > name.length) {
      value = value.slice(name.length).trim();
    }
  }

  return value;
}

export function busLabel(lines: string[]): string {
  return `${lines.join(' · ')}${lines.every((line) => /^[\dA-Za-z-]+$/.test(line)) ? '번' : ''} 버스`;
}

function walkSegment(
  steps: ProviderStep[],
  id: string,
  startName: string,
  endName: string,
  transfer: {
    from?: string;
    to?: string;
    station?: string;
  } | null,
): BaseSegment {
  const points = joinedPoints(steps);

  if (!points.length) {
    throw responseProblem();
  }

  const distance = steps.reduce((sum, step) => sum + step.properties.distance, 0);

  if (points.length < 2 && distance > 0) {
    throw responseProblem();
  }

  const time = steps.reduce((sum, step) => sum + step.properties.time, 0);

  const maneuvers = steps.flatMap((step) => {
    const instruction = cleanGuidance(step.properties.guidance, [startName, endName]);
    const latitude = step.properties.y ?? step.path.points[0]?.[1],
      longitude = step.properties.x ?? step.path.points[0]?.[0];

    return instruction && Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [
          {
            latitude,
            longitude,
            instruction,
            distanceMeters: step.properties.distance,
          },
        ]
      : [];
  });

  const sameStation = transfer?.station && startName === endName;

  return {
    id,
    mode: 'walk',
    title: sameStation ? `${transfer!.station} 환승` : `${endName}까지 걷기`,
    instructions:
      sameStation && transfer?.to
        ? `${transfer.from ? `${transfer.from}에서 ` : ''}${withRo(transfer.to)} 갈아타요.`
        : `${walkDistance(distance)} 걸어요.`,
    distanceMeters: distance,
    durationSeconds: {
      min: time,
      max: time,
    },
    start: endpointPlace(`${id}-start`, startName, points[0]),
    end: endpointPlace(`${id}-end`, endName, points[points.length - 1]),
    // API walk geometry has not yet been reviewed for running suitability.
    runAllowed: false,
    polyline: points.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    })),
    maneuvers:
      maneuvers.length > 1 || (maneuvers.length === 1 && !sameStation) ? maneuvers : undefined,
  };
}

function vehicleSegment(step: ProviderStep, id: string): BaseSegment {
  const points = step.path.points;

  if (!points.length || (points.length < 2 && step.properties.distance > 0)) {
    throw responseProblem();
  }

  const mode = step.properties.type === 'BUS' ? 'bus' : 'subway';
  const stops = (step.properties.stops ?? []).map((stop) => stop.name.trim()).filter(Boolean);
  const vehicles = step.properties.vehicles ?? [];

  // Vehicle[] lists every service that serves this step; the rider takes whichever comes first.
  const lines = [...new Set(vehicles.map((vehicle) => vehicle.name.trim()).filter(Boolean))];
  const vehicleTypes = [...new Set(vehicles.map((vehicle) => vehicle.type.trim()).filter(Boolean))];
  const first = stops[0] ?? '승차 지점',
    last = stops[stops.length - 1] ?? '하차 지점';
  const towards = stops[1] ? stationBaseName(stops[1]) : undefined;
  const count = Math.max(1, stops.length - 1);
  const label =
    mode === 'bus' ? busLabel(lines.length ? lines : ['버스']) : lines.join(' · ') || '지하철';
  const instructions =
    mode === 'bus'
      ? `${first}에서 ${lines.length > 1 ? `${lines.join(', ')} 중 먼저 오는 버스를` : `${label}를`} 타고 ${last}에서 내려요. (${count}개 정류장)`
      : `${stationName(first)}에서 ${label}${towards ? ` ${towards} 방면` : ''} 열차를 타고 ${stationName(last)}에서 내려요. (${count}개 역)`;

  return {
    id,
    mode,
    title: mode === 'bus' ? label : `${label}${towards ? ` · ${towards} 방면` : ''}`,
    instructions,
    distanceMeters: step.properties.distance,
    durationSeconds: {
      min: step.properties.time,
      max: step.properties.time,
    },
    start: endpointPlace(`${id}-start`, first, points[0]),
    end: endpointPlace(`${id}-end`, last, points[points.length - 1]),
    runAllowed: false,
    polyline: points.map(([longitude, latitude]) => ({
      latitude,
      longitude,
    })),
    lineName: lines.length ? lines.join(' / ') : undefined,
    direction: stops.length >= 2 ? `${first} → ${last}` : undefined,
    transit: {
      lines,
      stops,
      vehicleTypes: vehicleTypes.length ? vehicleTypes : undefined,
    },
  };
}

function pathSegments(
  steps: ProviderStep[],
  prefix: string,
  request: RouteEndpoints,
): BaseSegment[] {
  if (!steps.length) {
    throw responseProblem();
  }

  const segments: BaseSegment[] = [];

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    if (step.properties.type === 'BUS' || step.properties.type === 'SUBWAY') {
      segments.push(vehicleSegment(step, `${prefix}-step-${index}`));
      continue;
    }

    // Consecutive provider walking steps become one walk with turn-by-turn maneuvers.
    let end = index;

    while (
      end + 1 < steps.length &&
      steps[end + 1].properties.type !== 'BUS' &&
      steps[end + 1].properties.type !== 'SUBWAY'
    ) {
      end += 1;
    }

    const run = steps.slice(index, end + 1);
    const previous = steps[index - 1],
      next = steps[end + 1];
    const previousStops = previous?.properties.stops ?? [],
      nextStops = next?.properties.stops ?? [];
    const startName =
      index === 0
        ? request.origin.name
        : (previousStops[previousStops.length - 1]?.name ??
          run[0].properties.stops?.[0]?.name ??
          '하차 지점');
    const nextStop = nextStops[0]?.name;

    const endName =
      end === steps.length - 1
        ? request.destination.name
        : nextStop
          ? next.properties.type === 'SUBWAY' && nextStop !== startName
            ? stationName(nextStop)
            : nextStop
          : (run[run.length - 1].properties.stops?.at(-1)?.name ?? '승차 지점');

    const transfer =
      previous && next
        ? {
            station:
              startName === endName
                ? previous.properties.type === 'SUBWAY'
                  ? stationName(startName)
                  : startName
                : undefined,
            from: previous.properties.vehicles?.[0]?.name,
            to: next.properties.vehicles?.[0]?.name,
          }
        : null;

    segments.push(walkSegment(run, `${prefix}-step-${index}`, startName, endName, transfer));
    index = end;
  }

  return segments;
}

function preserveTotalTime(segments: BaseSegment[], total: number, prefix: string): BaseSegment[] {
  const totalSteps = segments.reduce((sum, segment) => sum + segment.durationSeconds.min, 0);

  if (totalSteps > total) {
    throw responseProblem();
  }

  if (totalSteps >= total) {
    return segments;
  }

  return [
    ...segments,
    {
      id: `${prefix}-provider-extra`,
      mode: 'wait',
      title: '승차·환승 대기',
      instructions:
        '카카오 전체 소요 시간에 포함된 대기·이동 여유예요. 상세 구분은 제공되지 않았어요.',
      distanceMeters: 0,
      durationSeconds: {
        min: total - totalSteps,
        max: total - totalSteps,
      },
      start: segments[segments.length - 1].end,
      end: segments[segments.length - 1].end,
      runAllowed: false,
    },
  ];
}

export function normalizeWalk(input: unknown, request: RouteEndpoints): BaseRoute[] {
  const payload = readPayload(walkResponse, input);

  assertRouteStatus(payload.status);

  if (!payload.route) {
    throw responseProblem();
  }

  const route = payload.route;
  const id = 'kakao-walk';
  const steps = route.legs.flatMap((leg) => leg.steps);

  if (!steps.length) {
    throw responseProblem();
  }

  const segments = [
    walkSegment(steps, `${id}-step-0`, request.origin.name, request.destination.name, null),
  ];

  return [
    {
      id,
      title: '걸어서 가기',
      durationSeconds: {
        min: route.properties.totalTime,
        max: route.properties.totalTime,
      },
      distanceMeters: route.properties.totalDistance,
      transfers: 0,
      segments: preserveTotalTime(segments, route.properties.totalTime, id),
      landingUrl: safeLandingUrl(route.properties.landingUrl),
    },
  ];
}

/** Bicycle has the documented walking response shape, but uses its own network and ETA. */
export function normalizeBicycle(input: unknown, request: RouteEndpoints): BaseRoute[] {
  return normalizeWalk(input, request).map((route) => ({
    ...route,
    id: 'kakao-bicycle',
    title: '자전거도로 우선',
    segments: route.segments.map((segment) =>
      segment.mode === 'walk'
        ? {
            ...segment,
            id: segment.id.replace('kakao-walk', 'kakao-bicycle'),
            mode: 'bicycle' as const,
            routingProfile: 'bicycle' as const,
            start: request.origin,
            end: request.destination,
            title: `${request.destination.name}까지 자전거`,
            instructions: `${walkDistance(segment.distanceMeters)} 자전거 경로로 이동해요. 교차로와 현장 통행 제한을 확인하세요.`,
          }
        : {
            ...segment,
            id: segment.id.replace('kakao-walk', 'kakao-bicycle'),
            start: request.destination,
            end: request.destination,
            title: '자전거 경로 추가 소요',
            instructions:
              '공급원의 전체 자전거 예상 시간에 포함된 추가 소요예요. 상세 구분은 제공되지 않았어요.',
          },
    ),
  }));
}

export function normalizeTransit(input: unknown, request: RouteEndpoints): BaseRoute[] {
  const payload = readPayload(transitResponse, input);

  assertRouteStatus(payload.status);

  if (!payload.routes?.length) {
    throw new ApiError('NO_ROUTES', '이 지점 사이의 대중교통 경로가 없어요.', 404);
  }

  const valid: BaseRoute[] = [];

  for (let index = 0; index < payload.routes.length; index += 1) {
    const route = payload.routes[index];
    const id = `kakao-transit-${index}`;

    try {
      const segments = pathSegments(route.steps, id, request);
      const vehicles = segments.filter(
        (segment) => segment.mode === 'bus' || segment.mode === 'subway',
      );

      valid.push({
        id,
        title:
          vehicles
            .map((segment) =>
              segment.mode === 'bus'
                ? busLabel(segment.transit?.lines.slice(0, 2) ?? [])
                : (segment.transit?.lines[0] ?? '지하철'),
            )
            .join(' → ') || (route.properties.type === 'BUS' ? '버스' : '지하철'),
        durationSeconds: {
          min: route.properties.totalTime,
          max: route.properties.totalTime,
        },
        distanceMeters: route.properties.totalDistance,
        transfers: route.properties.transfers,
        fareWon: route.properties.fare?.value ?? route.properties.fare?.max,
        segments: preserveTotalTime(segments, route.properties.totalTime, id),
        landingUrl: safeLandingUrl(payload.properties?.landingURL),
      });
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      // A malformed alternative must not turn into a fabricated path.
    }
  }

  if (!valid.length) {
    throw responseProblem();
  }

  return valid;
}

export function normalizePlaces(input: unknown): Place[] {
  const payload = readPayload(placesResponse, input);

  const places = payload.documents.map((document) => ({
    id: `kakao-${document.id}`,
    name: document.place_name,
    address: document.road_address_name || document.address_name,
    longitude: Number(document.x),
    latitude: Number(document.y),
  }));

  if (
    places.some(
      (place) =>
        !Number.isFinite(place.longitude) ||
        !Number.isFinite(place.latitude) ||
        Math.abs(place.longitude) > 180 ||
        Math.abs(place.latitude) > 90,
    )
  ) {
    throw responseProblem();
  }

  return places;
}

export function normalizeNearby(input: unknown): NearbyPlace[] {
  const payload = readPayload(nearbyResponse, input);

  return payload.documents
    .map((document) => ({
      id: `kakao-${document.id}`,
      name: document.place_name,
      address: document.road_address_name || document.address_name,
      longitude: Number(document.x),
      latitude: Number(document.y),
      category: document.category_name,
      distanceMeters: Number(document.distance ?? NaN),
    }))
    .filter(
      (place) =>
        Number.isFinite(place.longitude) &&
        Number.isFinite(place.latitude) &&
        Math.abs(place.longitude) <= 180 &&
        Math.abs(place.latitude) <= 90,
    );
}

/** Kakao Mobility car route: road geometry, turn guidance and the live-traffic duration. */
export function normalizeDriving(input: unknown): DrivingLeg {
  const payload = readPayload(drivingResponse, input);
  const route = payload.routes[0];

  if (route.result_code !== 0 || !route.summary || !route.sections?.length) {
    throw new ApiError('NO_ROUTES', '이 지점 사이의 자동차 경로를 찾지 못했어요.', 404);
  }

  const polyline: {
    latitude: number;
    longitude: number;
  }[] = [];
  const maneuvers: Maneuver[] = [];
  const traffic: TrafficSpan[] = [];

  for (const section of route.sections) {
    for (const road of section.roads) {
      if (road.vertexes.length % 2) {
        throw responseProblem();
      }

      const from = Math.max(0, polyline.length - 1);

      for (let index = 0; index < road.vertexes.length; index += 2) {
        const longitude = road.vertexes[index],
          latitude = road.vertexes[index + 1];

        if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
          throw responseProblem();
        }

        const last = polyline[polyline.length - 1];

        if (!last || last.latitude !== latitude || last.longitude !== longitude) {
          polyline.push({
            latitude,
            longitude,
          });
        }
      }

      const to = polyline.length - 1,
        level = TRAFFIC_LEVELS[road.traffic_state ?? 0] ?? 'unknown';

      if (to <= from) {
        continue;
      }

      const previous = traffic[traffic.length - 1];

      if (previous && previous.level === level && previous.to === from) {
        previous.to = to;
      } else {
        traffic.push({
          from,
          to,
          level,
        });
      }
    }

    // Type 100 is the departure marker; every other guide is an action at its point.
    for (const guide of section.guides) {
      if (guide.type !== 100 && guide.guidance.trim()) {
        maneuvers.push({
          latitude: guide.y,
          longitude: guide.x,
          instruction: guide.guidance.trim(),
          distanceMeters: 0,
        });
      }
    }
  }

  if (polyline.length < 2) {
    throw responseProblem();
  }

  return {
    distanceMeters: route.summary.distance,
    durationSeconds: route.summary.duration,
    polyline,
    maneuvers,
    taxiFareWon: route.summary.fare?.taxi,
    tollWon: route.summary.fare?.toll,
    traffic,
  };
}

export class KakaoProvider implements RouteProvider {
  readonly configured: boolean;
  private readonly key: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KakaoOptions = {}) {
    this.key = options.key?.trim() ?? '';
    this.configured = Boolean(this.key);
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  private async get(
    pathname: string,
    params: Record<string, string>,
    budget?: CallBudget,
    host = 'https://dapi.kakao.com',
  ): Promise<unknown> {
    if (!this.configured) {
      throw new ApiError(
        'LIVE_NOT_CONFIGURED',
        '서버에 카카오 REST API 키가 설정되지 않았어요. 시연 모드에서 앱 흐름을 확인하거나 서버 키를 설정해 주세요.',
        503,
      );
    }

    const url = new URL(pathname, host);

    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }

    try {
      const text = await requestSupplierText({
        request: (signal) => {
          const execute = () =>
            this.fetcher(url, {
              headers: {
                Authorization: `KakaoAK ${this.key}`,
                Accept: 'application/json',
              },
              signal,
            });

          return budget ? budget.run(execute) : execute();
        },
        validateResponse(response) {
          if (response.status === 401) {
            throw new ApiError(
              'PROVIDER_AUTH',
              '카카오 인증 설정을 확인해야 해요. 서버의 REST API 키를 점검해 주세요.',
              503,
            );
          }

          if (response.status === 403) {
            throw new ApiError(
              'PROVIDER_FORBIDDEN',
              '카카오맵 API 사용 권한을 확인해야 해요. 앱의 지도 활성화 설정을 점검해 주세요.',
              503,
            );
          }

          if (response.status === 429) {
            throw new ApiError(
              'PROVIDER_LIMIT',
              '카카오 API 호출 한도에 도달했어요. 잠시 후 다시 검색해 주세요.',
              429,
            );
          }

          if (!response.ok) {
            throw new ApiError(
              'PROVIDER_UNAVAILABLE',
              '카카오 지도 서버가 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
            );
          }

          if (!response.headers.get('content-type')?.includes('application/json')) {
            throw responseProblem();
          }
        },
        timeoutMs: this.timeoutMs,
        timeoutError: () =>
          new ApiError(
            'PROVIDER_TIMEOUT',
            '카카오 지도 응답이 늦어 조회를 중단했어요. 다시 시도해 주세요.',
            504,
          ),
        responseError: responseProblem,
      });

      try {
        return JSON.parse(text);
      } catch {
        throw responseProblem();
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '카카오 지도에 연결하지 못했어요. 네트워크 상태를 확인해 주세요.',
      );
    }
  }

  async searchPlaces(query: PlaceSearch): Promise<Place[]> {
    const params: Record<string, string> = {
      query: query.q,
      size: '10',
      page: '1',
    };

    if (query.latitude !== undefined && query.longitude !== undefined) {
      params.x = String(query.longitude);
      params.y = String(query.latitude);
      params.radius = '20000';
    } else {
      // The current keyword API documents an explicit search region. Initial pilot: Seoul.
      params.rect = '126.734,37.413,127.269,37.715';
    }

    return normalizePlaces(await this.get('/v2/local/search/keyword.json', params));
  }

  async reverseGeocode(point: {
    latitude: number;
    longitude: number;
  }): Promise<ReverseGeocode | null> {
    return normalizeAddress(
      await this.get('/v2/local/geo/coord2address.json', {
        x: String(point.longitude),
        y: String(point.latitude),
      }),
    );
  }

  private routeParams(request: RouteEndpoints): Record<string, string> {
    return {
      start_x: String(request.origin.longitude),
      start_y: String(request.origin.latitude),
      end_x: String(request.destination.longitude),
      end_y: String(request.destination.latitude),
      s_name: request.origin.name,
      e_name: request.destination.name,
      input_coord: 'WGS84',
      output_coord: 'WGS84',
    };
  }

  async walking(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    return normalizeWalk(
      await this.get(
        '/v2/routing/walk',
        {
          ...this.routeParams(request),
          route_mode: 'BROAD_FIRST',
        },
        budget,
      ),
      request,
    );
  }

  async bicycle(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    return normalizeBicycle(
      await this.get(
        '/v2/routing/bicycle',
        {
          ...this.routeParams(request),
          route_mode: 'BIKE_ONLY',
        },
        budget,
      ),
      request,
    );
  }

  async transit(request: RouteEndpoints, budget: CallBudget): Promise<BaseRoute[]> {
    return normalizeTransit(
      await this.get('/v2/routing/publictraffic', this.routeParams(request), budget),
      request,
    );
  }

  async driving(request: RouteEndpoints, budget: CallBudget): Promise<DrivingLeg> {
    return normalizeDriving(
      await this.get(
        '/v1/directions',
        {
          origin: `${request.origin.longitude},${request.origin.latitude}`,
          destination: `${request.destination.longitude},${request.destination.latitude}`,
          priority: 'TIME',
          summary: 'false',
        },
        budget,
        'https://apis-navi.kakaomobility.com',
      ),
    );
  }

  async nearby(query: NearbyQuery): Promise<NearbyPlace[]> {
    return normalizeNearby(
      await this.get('/v2/local/search/keyword.json', {
        query: query.keyword,
        x: String(query.longitude),
        y: String(query.latitude),
        radius: String(Math.max(50, Math.min(20_000, Math.round(query.radius)))),
        sort: 'distance',
        size: '10',
      }),
    );
  }
}
