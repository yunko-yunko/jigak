import type { Route, Segment } from '../../shared/domain/types.js';
import { evaluateBaseTimeline } from '../../shared/domain/routing.js';
import type {
  RouteTimingSummary,
  TimingBasis,
  TimingComponent,
  TimingComponentKind,
} from '../../shared/intelligence/timing.js';
import { validPlanningBuffer } from './planningTiming.js';

export type { RouteTimingSummary } from '../../shared/intelligence/timing.js';

function componentKind(
  segment: Segment,
  previous: Segment | undefined,
  next: Segment | undefined,
): TimingComponentKind {
  if (segment.mode === 'walk' || segment.mode === 'run') {
    return 'access';
  }

  if (segment.mode === 'hire' || segment.mode === 'return') {
    return segment.mode;
  }

  if (segment.mode === 'entry') {
    return next?.mode === 'subway' || next?.mode === 'wait' ? 'platform' : 'access';
  }

  if (segment.mode !== 'wait') {
    return 'ride';
  }

  if (segment.id.includes('scooter-unlock')) {
    return 'hire';
  }

  if (previous?.mode === 'car' && next?.mode !== 'car') {
    return 'parking';
  }

  if (next?.mode === 'taxi') {
    return 'dispatch';
  }

  return 'wait';
}

/** Explain the already-counted route time; no guessed red-light or per-stop seconds are added. */
export function describeRouteTiming(
  route: Route,
  preparationSeconds: number,
  now: number,
): RouteTimingSummary | null {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(preparationSeconds) ||
    preparationSeconds < 0 ||
    preparationSeconds > 3600
  ) {
    return null;
  }

  if (
    route.segments.some(
      (segment) =>
        !Number.isFinite(segment.durationSeconds.min) ||
        !Number.isFinite(segment.durationSeconds.max) ||
        segment.durationSeconds.min < 0 ||
        segment.durationSeconds.max < segment.durationSeconds.min ||
        !validPlanningBuffer(segment),
    )
  ) {
    return null;
  }

  const duration = route.segments.reduce(
    (total, segment) => ({
      min: total.min + segment.durationSeconds.min,
      max: total.max + segment.durationSeconds.max,
    }),
    {
      min: 0,
      max: 0,
    },
  );

  const same = (left: number, right: number) => Math.abs(left - right) < 0.000001;

  if (
    !Number.isFinite(route.durationSeconds.min) ||
    !Number.isFinite(route.durationSeconds.max) ||
    route.durationSeconds.min < 0 ||
    route.durationSeconds.max < route.durationSeconds.min
  ) {
    return null;
  }

  const correlated =
    !same(duration.min, route.durationSeconds.min) ||
    !same(duration.max, route.durationSeconds.max);

  if (correlated) {
    const timeline = evaluateBaseTimeline(route.segments, now);
    const end = timeline?.at(-1);

    if (
      !end ||
      !same((end.earliest - now) / 1000, route.durationSeconds.min) ||
      !same((end.latest - now) / 1000, route.durationSeconds.max) ||
      timeline!.some(
        (range, index) =>
          range.earliest !== route.segments[index].timeRange.earliest ||
          range.latest !== route.segments[index].timeRange.latest,
      )
    ) {
      return null;
    }
  }

  const notes: string[] = [];

  if (correlated) {
    notes.push(
      '접근이 빨라지면 같은 차량을 기다리는 시간이 길어져 두 범위가 함께 변합니다. 구간별 최솟값·최댓값을 따로 더하지 않고 확인한 절대 승차 시각으로 전체 소요를 계산했습니다.',
    );
  }

  const components: TimingComponent[] = route.segments.map((segment, index) => {
    const kind = componentKind(segment, route.segments[index - 1], route.segments[index + 1]);
    const sourceTime = segment.provenance.sourceTimestamp;
    const receivedAt = segment.provenance.receivedAt;

    const freshArrival =
      kind === 'wait' &&
      !!segment.connection &&
      segment.provenance.isRealtime &&
      sourceTime !== null &&
      Number.isFinite(sourceTime) &&
      sourceTime <= now + 30_000 &&
      now - sourceTime <= 120_000 &&
      Number.isFinite(receivedAt) &&
      receivedAt <= now + 30_000 &&
      now - receivedAt <= 120_000;

    const estimatedAction = ['wait', 'platform', 'dispatch', 'hire', 'return', 'parking'].includes(
      kind,
    );

    const basis: TimingBasis =
      segment.provenance.mode === 'demo'
        ? 'demo'
        : freshArrival
          ? 'live-arrival'
          : segment.etaPrediction || segment.publicEtaPrediction || segment.railEtaPrediction
            ? 'learned-estimate'
            : estimatedAction && !segment.id.endsWith('-provider-extra')
              ? 'rule-estimate'
              : 'provider-estimate';

    const roadDelay = segment.roadDelaySeconds;

    const includedRoadDelaySeconds =
      roadDelay !== undefined &&
      Number.isFinite(roadDelay) &&
      roadDelay > 0 &&
      roadDelay <= segment.durationSeconds.max
        ? roadDelay
        : undefined;

    const planningSeconds =
      (segment.planningBuffer?.weatherSeconds ?? 0) +
      (segment.planningBuffer?.calibrationSeconds ?? 0);

    const sourceLabel =
      basis === 'live-arrival'
        ? '공급원의 도착예정'
        : basis === 'learned-estimate'
          ? segment.publicEtaPrediction
            ? '서울 교통카드 운행 기록 학습 · 공급원 예상의 늦은 범위 보정'
            : segment.railEtaPrediction
              ? '서울 교통카드 지하철 개찰 기록 학습 · 역 안 이동을 포함한 늦은 범위 보정'
              : '완료 이동으로 학습한 문맥 ETA · 실시간 측정값 아님'
          : basis === 'rule-estimate'
            ? '앱의 예상 여유'
            : basis === 'demo'
              ? '시연 가정'
              : `${segment.routingSource?.label ?? '경로 공급원'}의 예상 소요${segment.networkSnap?.allowanceSeconds ? ` · 보행망 접점 여유 ${segment.networkSnap.allowanceSeconds}초 포함` : ''}`;

    return {
      segmentId: segment.id,
      kind,
      seconds: {
        ...segment.durationSeconds,
      },
      basis,
      label: segment.title,
      sourceLabel: planningSeconds
        ? `${sourceLabel} · 계획 여유 ${planningSeconds}초 포함`
        : sourceLabel,
      observedAt: freshArrival ? sourceTime : null,
      ...(includedRoadDelaySeconds === undefined
        ? {}
        : {
            includedRoadDelaySeconds,
          }),
    };
  });

  if (preparationSeconds > 0) {
    components.push({
      segmentId: `${route.id}:preparation`,
      kind: 'preparation',
      seconds: {
        min: preparationSeconds,
        max: preparationSeconds,
      },
      basis: 'rule-estimate',
      label: '도착 후 준비',
      sourceLabel: '사용자가 설정한 준비 여유',
      observedAt: null,
    });
  }

  const snapped = route.segments.filter(
    (segment) =>
      segment.networkSnap &&
      (segment.networkSnap.startMeters > 0 || segment.networkSnap.endMeters > 0),
  );

  if (snapped.length) {
    notes.push(
      `${snapped
        .slice(0, 3)
        .map(
          (segment) =>
            `${segment.title}: 출발 ${Math.round(segment.networkSnap!.startMeters)}m·끝 ${Math.round(segment.networkSnap!.endMeters)}m의 보행망 좌표 차이에 ${segment.networkSnap!.allowanceSeconds}초 여유`,
        )
        .join(
          '; ',
        )}${snapped.length > 3 ? ` 외 ${snapped.length - 3}개 구간` : ''}. 1m/s의 보수적 접점 예상으로 늦은 소요에 이미 포함했으며 실제 실내 이동·신호·시설 운영을 관측한 값은 아닙니다. 공급원의 경로선과 입력 위치를 구분해 확인해 주세요.`,
    );
  }

  const unavailableFactors: RouteTimingSummary['unavailableFactors'] = [];

  if (
    route.segments.some(
      (segment) =>
        ['walk', 'run', 'bicycle', 'scooter', 'ebike', 'bus', 'car', 'taxi'].includes(
          segment.mode,
        ) && segment.distanceMeters > 0,
    )
  ) {
    unavailableFactors.push('live-signal');
    notes.push(
      '교차로별 현재 신호와 통과 시점의 신호 대기는 확인되지 않았습니다. 공급원 예상 소요에 신호 대기를 임의로 더하지 않습니다.',
    );
  }

  if (route.segments.some((segment) => segment.mode === 'bus')) {
    unavailableFactors.push('bus-stop-dwell');
    notes.push(
      '버스 주행은 공급원 예상 소요를 사용합니다. 정류장별 승하차 정차 시간을 별도로 측정한 값은 없습니다.',
    );
  }

  if (components.some((component) => component.includedRoadDelaySeconds)) {
    notes.push(
      '도로 속도로 계산한 버스 지연은 추정 보정이며 표시된 주행 시간에 이미 포함되어 있습니다. 별도 소요로 더하지 않습니다.',
    );
  }

  const included = route.segments.reduce(
    (sum, segment) => ({
      weather: sum.weather + (segment.planningBuffer?.weatherSeconds ?? 0),
      calibration: sum.calibration + (segment.planningBuffer?.calibrationSeconds ?? 0),
    }),
    {
      weather: 0,
      calibration: 0,
    },
  );

  if (included.weather) {
    notes.push(
      `강수에 따른 계획 여유 ${included.weather}초는 해당 야외 구간의 늦은 예상에 이미 포함되었습니다. 이후 승차 연결을 다시 계산했으며 전체 소요에 따로 더하지 않습니다.`,
    );
  }

  if (included.calibration) {
    notes.push(
      `실측 검증으로 보정한 계획 여유 ${included.calibration}초는 해당 구간의 늦은 예상에 이미 포함되었습니다. 실시간 측정값이나 도착 확률을 의미하지 않습니다.`,
    );
  }

  if (components.some((component) => component.kind === 'dispatch')) {
    notes.push('택시 호출·배차 대기는 추정치이며 실제 배정 차량의 도착예정이 아닙니다.');
  }

  if (components.some((component) => component.basis === 'live-arrival')) {
    notes.push(
      '실시간 대기는 정류소 도착예정을 기준으로 연결한 값입니다. 실제 출발시각이나 정차시간을 보장하지 않습니다.',
    );
  }

  if (route.segments.some((segment) => segment.etaPrediction)) {
    notes.push(
      '완료 이동의 날씨·시간대·도로·대기 문맥으로 학습한 ETA를 사용합니다. 관측된 차량 도착예정을 덮어쓰지 않으며 도착 확률을 보장하지 않습니다.',
    );
  }

  if (route.segments.some((segment) => segment.railEtaPrediction)) {
    notes.push(
      '서울 교통카드의 지하철 개찰 기록(승차 개찰부터 하차 개찰까지)으로 학습한 범위로 지하철 구간의 늦은 범위만 넓혔습니다. 역 안 이동과 놓친 열차를 포함하며, 예상 도착시각과 공급원 소요는 바꾸지 않습니다.',
    );
  }

  if (route.segments.some((segment) => segment.publicEtaPrediction)) {
    notes.push(
      '서울 교통카드의 실제 버스 승하차 기록으로 학습한 소요 범위를 비교했습니다. 공개된 과거 도로 통계와 기상 관측을 사용한 모델이며, 현재 도로 보정과 공급원 예상 소요를 줄이지 않습니다. 차량 대기·정차·신호를 각각 실시간 측정한 결과는 아닙니다.',
    );
  }

  return {
    routeId: route.id,
    totalSeconds: {
      min: route.durationSeconds.min + preparationSeconds,
      max: route.durationSeconds.max + preparationSeconds,
    },
    components,
    unavailableFactors,
    notes,
  };
}
