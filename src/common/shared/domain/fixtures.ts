import type { DurationRange, MobilityPreferences, Place } from './types.js';

export const DEFAULT_PREFERENCES: MobilityPreferences = {
  walkingOnly: false,
  allowRunning: false,
  allowBicycle: false,
  maxRunningMeters: 500,
  maxBicycleMeters: 2000,
  runningPace: 'easy',
  preparationSeconds: 120,
  bicycleReady: false,
};

/** Names locate the scenario; every distance, path and time below is illustrative. */
export const PLACES: Place[] = [
  {
    id: 'seoul-station',
    name: '서울역 광장',
    address: '서울 중구 · 시연 출발지',
    latitude: 37.5559,
    longitude: 126.9723,
    note: '실제 입구와 길안내는 검증되지 않은 시연 지점',
  },
  {
    id: 'city-hall',
    name: '시청 앞',
    address: '서울 중구 · 시연 목적지',
    latitude: 37.5663,
    longitude: 126.9779,
    note: '건물 내부 이동을 포함하지 않은 시연 지점',
  },
  {
    id: 'hongik-univ',
    name: '홍대입구역',
    address: '서울 마포구 · 시연 출발지',
    latitude: 37.5572,
    longitude: 126.9245,
    note: '출입구와 보행 경로 미검증',
  },
  {
    id: 'yonsei',
    name: '연세대 정문',
    address: '서울 서대문구 · 시연 목적지',
    latitude: 37.5619,
    longitude: 126.9368,
    note: '강의실 도착은 별도 준비 여유 필요',
  },
  {
    id: 'seongsu',
    name: '성수역',
    address: '서울 성동구 · 시연 출발지',
    latitude: 37.5446,
    longitude: 127.0559,
    note: '대여소와 진입 경로 미검증',
  },
  {
    id: 'konkuk',
    name: '건국대 정문',
    address: '서울 광진구 · 시연 목적지',
    latitude: 37.5408,
    longitude: 127.0733,
    note: '실제 출입구와 캠퍼스 내부 이동 미검증',
  },
];

export interface DemoScenario {
  id: string;
  name: string;
  originId: string;
  destinationId: string;
  description: string;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'same-train',
    name: '걸어도 같은 열차',
    originId: 'seoul-station',
    destinationId: 'city-hall',
    description: '접근만 빨라져도 같은 차량을 타면 도착은 같아지는 가정 사례',
  },
  {
    id: 'tight-bus',
    name: '승차가 촉박한 버스',
    originId: 'hongik-univ',
    destinationId: 'yonsei',
    description: '달리기 시간 범위와 차량 시각이 겹치면 다음 편 도착까지 포함하는 가정 사례',
  },
  {
    id: 'bicycle-link',
    name: '자전거와 지하철 연결',
    originId: 'seongsu',
    destinationId: 'konkuk',
    description: '대여·반납·역 진입을 모두 계산하는 가정 사례',
  },
];

export interface DemoTemplate {
  id: string;
  originId: string;
  destinationId: string;
  mode: 'bus' | 'subway';
  accessMeters: number;
  accessSeconds: DurationRange;
  entrySeconds: DurationRange;
  entryMeters: number;
  departureOffsetsSeconds: number[];
  rideSeconds: DurationRange;
  rideMeters: number;
  finalMeters: number;
  finalSeconds: DurationRange;
  walkingSeconds: DurationRange;
  walkingMeters: number;
  bicycle?: {
    approachMeters: number;
    approachSeconds: DurationRange;
    hireSeconds: DurationRange;
    meters: number;
    rideSeconds: DurationRange;
    returnSeconds: DurationRange;
    entrySeconds: DurationRange;
    stockAtAnchor: number;
    fallbackWalkingSeconds: DurationRange;
  };
}

/** A finite sampled timetable, not a real timetable or a generated headway. */
export const DEMO_TEMPLATES: DemoTemplate[] = [
  {
    id: 'same-train',
    originId: 'seoul-station',
    destinationId: 'city-hall',
    mode: 'subway',
    accessMeters: 300,
    accessSeconds: { min: 210, max: 270 },
    entryMeters: 110,
    entrySeconds: { min: 90, max: 120 },
    departureOffsetsSeconds: [480, 960, 1560, 2400, 3360, 4200],
    rideSeconds: { min: 180, max: 210 },
    rideMeters: 1600,
    finalMeters: 140,
    finalSeconds: { min: 110, max: 150 },
    walkingSeconds: { min: 1140, max: 1440 },
    walkingMeters: 1500,
  },
  {
    id: 'tight-bus',
    originId: 'hongik-univ',
    destinationId: 'yonsei',
    mode: 'bus',
    accessMeters: 420,
    accessSeconds: { min: 420, max: 480 },
    entryMeters: 0,
    entrySeconds: { min: 0, max: 0 },
    departureOffsetsSeconds: [330, 990, 1710, 2400, 3300, 4260],
    rideSeconds: { min: 840, max: 900 },
    rideMeters: 2300,
    finalMeters: 180,
    finalSeconds: { min: 150, max: 210 },
    walkingSeconds: { min: 1800, max: 2220 },
    walkingMeters: 2350,
  },
  {
    id: 'bicycle-link',
    originId: 'seongsu',
    destinationId: 'konkuk',
    mode: 'subway',
    accessMeters: 1050,
    accessSeconds: { min: 780, max: 960 },
    entryMeters: 150,
    entrySeconds: { min: 120, max: 180 },
    departureOffsetsSeconds: [960, 1380, 2040, 2880, 3660, 4500],
    rideSeconds: { min: 240, max: 300 },
    rideMeters: 1450,
    finalMeters: 220,
    finalSeconds: { min: 180, max: 240 },
    walkingSeconds: { min: 2100, max: 2580 },
    walkingMeters: 2700,
    bicycle: {
      approachMeters: 120,
      approachSeconds: { min: 90, max: 120 },
      hireSeconds: { min: 30, max: 30 },
      meters: 1100,
      rideSeconds: { min: 240, max: 330 },
      returnSeconds: { min: 30, max: 30 },
      entrySeconds: { min: 90, max: 150 },
      stockAtAnchor: 3,
      fallbackWalkingSeconds: { min: 840, max: 1020 },
    },
  },
];
