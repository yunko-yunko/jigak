import type { BasePlanningRequest, Route } from '../../shared/domain/types.js';
import type {
  ArrivalAssessment,
  ArrivalExplanation,
  ArrivalIntelligence,
  MobilitySnapshot,
  WeatherSnapshot,
} from '../../shared/intelligence/types.js';
import { metersBetween } from '../realtime/names.js';
import { usableCalibration, type EtaCalibration } from './calibration.js';
import { describeRouteTiming } from './segmentTiming.js';
import { localWeatherIsFresh, validPlanningBuffer } from './planningTiming.js';
import {
  hasBicycleAvailabilityEvidence,
  validLiveVehicles,
} from '../../shared/domain/vehicleConstraints.js';
import { journeyRiskSeconds } from '../../shared/intelligence/journeyRisk.js';
import {
  estimateBaseTimeline,
  type RoutingObjective,
} from '../../shared/domain/estimatedTiming.js';
import { compareRouteEffort } from '../../shared/domain/routeEffort.js';

export interface ArrivalIntelligenceContext {
  objective?: RoutingObjective;
  weather?: WeatherSnapshot | null;
  mobility?: MobilitySnapshot;
  calibration?: EtaCalibration;
  /** Additional evidence checks from route generators; a reason excludes that candidate. */
  exclusions?: ReadonlyMap<string, string[]>;
}

/**
 * Explainable, deterministic arrival decision model. It never invents streets, vehicles,
 * availability or arrival probabilities. ETA bounds remain labeled planning estimates.
 */
export function rankRouteIntelligence(
  routes: readonly Route[],
  request: BasePlanningRequest,
  context: ArrivalIntelligenceContext = {},
): ArrivalIntelligence {
  const objective = context.objective ?? 'conservative-arrival';
  const legacyCalibrated = usableCalibration(context.calibration, request.now);
  const learnedSegments = routes.reduce(
    (sum, route) => sum + route.segments.filter((segment) => !!segment.etaPrediction).length,
    0,
  );
  const calibrated =
    legacyCalibrated || learnedSegments > 0 || routes.some((route) => !!route.journeyEta);
  const weather = context.weather ?? null;

  // Old observations and conditions far from the origin never masquerade as local live weather.
  const liveWeather = localWeatherIsFresh(weather, request);

  const assessments: ArrivalAssessment[] = routes
    .map((route): ArrivalAssessment => {
      const explanations: ArrivalExplanation[] = [];
      let eligible = route.provenance.mode === 'live',
        buffer = 0,
        confidence: ArrivalAssessment['confidence'] = 'high';
      const prepared = route.segments.some((segment) => segment.planningBuffer !== undefined);

      const included = route.segments.reduce(
        (sum, segment) =>
          validPlanningBuffer(segment)
            ? {
                weather: sum.weather + (segment.planningBuffer?.weatherSeconds ?? 0),
                calibration: sum.calibration + (segment.planningBuffer?.calibrationSeconds ?? 0),
              }
            : sum,
        {
          weather: 0,
          calibration: 0,
        },
      );

      const exclude = (code: ArrivalExplanation['code'], reason: string) => {
        eligible = false;
        explanations.push({
          code,
          severity: 'excluded',
          text: reason,
        });
      };

      if (route.provenance.mode !== 'live') {
        exclude('source', '가정한 시연 경로는 실시간 도착 추천에서 제외합니다.');
      }

      if (route.provenance.sourceTimestamp === null) {
        confidence = 'limited';
        explanations.push({
          code: 'source',
          severity: 'caution',
          text: '공급원의 경로 생성 시각이 없어 이동 시간은 현재 조회한 예상치로 판단합니다.',
        });
      }

      if (route.risks.some((risk) => risk.code === 'unverified-schedule')) {
        confidence = 'limited';
        explanations.push({
          code: 'transfer',
          severity: 'caution',
          text: '일부 승차 대기는 평균 배차 간격에 따른 추정치이며 실제 후속 차량·출발 시각을 확인한 결과가 아닙니다. 승차 전에 다시 조회해야 합니다.',
        });
      }

      const invalidDuration =
        !Number.isFinite(route.readyTime.earliest) ||
        !Number.isFinite(route.readyTime.latest) ||
        route.readyTime.earliest > route.readyTime.latest ||
        route.segments.some(
          (segment) =>
            !Number.isFinite(segment.durationSeconds.min) ||
            !Number.isFinite(segment.durationSeconds.max) ||
            segment.durationSeconds.min < 0 ||
            segment.durationSeconds.max < segment.durationSeconds.min ||
            !validPlanningBuffer(segment),
        );

      if (invalidDuration) {
        exclude('source', '이동 시간 범위가 유효하지 않습니다.');
      }

      for (const reason of context.exclusions?.get(route.id) ?? []) {
        exclude('geometry', reason);
      }

      if (
        route.risks.some(
          (risk) =>
            risk.code === 'unverified-duration-range' && risk.title === '역 내부 보행 연결 미확인',
        )
      ) {
        exclude(
          'geometry',
          '승강장과 역 밖 이동수단 사이의 실제 보행 연결이 확인되지 않은 조합입니다.',
        );
      }

      for (const segment of route.segments) {
        if (
          ['walk', 'run'].includes(segment.mode) &&
          segment.distanceMeters > 0 &&
          (segment.polyline?.length ?? 0) < 2
        ) {
          exclude(
            'geometry',
            `${segment.title}: 실제 보행 경로를 확인하지 못해 이동 시간은 거리 기반 추정치입니다.`,
          );
        }

        if (
          ['bicycle', 'scooter', 'car', 'taxi'].includes(segment.mode) &&
          segment.distanceMeters > 0 &&
          (segment.polyline?.length ?? 0) < 2
        ) {
          exclude('geometry', `${segment.title}: 검증한 주행 경로가 없습니다.`);
        }

        if (
          (segment.mode === 'bicycle' || segment.mode === 'scooter') &&
          (!('routingProfile' in segment) || segment.routingProfile !== segment.mode)
        ) {
          exclude('geometry', `${segment.title}: 해당 이동수단의 전용 경로가 확인되지 않았습니다.`);
        }

        if (segment.mode === 'car') {
          const car = request.preferences.carLocation;

          if (!request.preferences.hasCar || !car || metersBetween(segment.start, car) > 35) {
            exclude(
              'availability',
              '운전 구간의 출발점이 사용자가 저장한 실제 자동차 위치와 일치하지 않습니다.',
            );
          }

          const parking = segment.parkingAccess;

          if (
            !parking?.publicAccess ||
            parking.operating !== 'open' ||
            parking.occupancy !== 'available' ||
            parking.fee === 'unknown' ||
            parking.verifiedAt === null ||
            parking.verifiedAt > request.now + 30_000 ||
            request.now - parking.verifiedAt > 120_000 ||
            parking.occupancyObservedAt === undefined ||
            parking.occupancyObservedAt === null ||
            request.now - parking.occupancyObservedAt > 300_000 ||
            parking.occupancyObservedAt > request.now + 30_000 ||
            (parking.availableSpaces ?? 0) < 1
          ) {
            exclude(
              'parking',
              '도착 주차장의 일반 이용 가능 여부·운영시간·최근 잔여 면수·요금이 모두 확인되어야 자동차 경로를 추천합니다.',
            );
          }
        }

        if (segment.traffic?.some((span) => span.level === 'blocked')) {
          exclude('geometry', `${segment.title}: 통제된 도로가 포함되어 있습니다.`);
        }

        if (segment.connection?.status === 'missed' && !segment.connection.fallbackDepartureAt) {
          exclude('transfer', '탑승 가능한 후속편을 확인하지 못했습니다.');
        }

        if (segment.connection?.status === 'borderline') {
          confidence = 'limited';
          explanations.push({
            code: 'transfer',
            severity: 'caution',
            text: '촉박한 환승은 다음 편의 도착 범위까지 함께 판단합니다.',
          });
        }
      }

      const modes = new Set(route.segments.map((segment) => segment.mode));

      if (modes.has('bicycle')) {
        if (
          !validLiveVehicles(route.segments, request.preferences, request.origin, request.now) ||
          !hasBicycleAvailabilityEvidence(route.segments, request.now)
        ) {
          exclude(
            'availability',
            '자전거 이용 설정 또는 실제 대여·반납 구간에 연결된 최근 재고·이용 근거를 확인하지 못했습니다.',
          );
        } else if (route.segments.some((segment) => segment.bicycleAvailability)) {
          confidence = 'limited';
          explanations.push({
            code: 'availability',
            severity: 'caution',
            text: '서울시 조회 당시 재고와 지정 대여소 반납 정책을 반영한 예상입니다. 자전거 예약이나 대여·반납 성공을 보장하지 않으므로 대여 직전에 재고·이용권·현장 운영을 다시 확인하세요.',
          });

          if (route.segments.some((segment) => segment.bicycleAvailability?.observedAt === null)) {
            explanations.push({
              code: 'source',
              severity: 'caution',
              text: '따릉이 재고의 수신 시각은 확인했지만 원본 측정시각은 제공되지 않습니다.',
            });
          }
        }
      }

      if (
        modes.has('scooter') &&
        route.risks.some(
          (risk) =>
            risk.code === 'vehicle-availability' &&
            /미확인|공개되지|앱에서 찾아|위치는 앱/.test(`${risk.title} ${risk.description}`),
        )
      ) {
        exclude('availability', '실제 대여 기기 위치가 확인되지 않은 킥보드 경로입니다.');
      }

      if (
        modes.has('bicycle') &&
        route.risks.some(
          (risk) =>
            risk.code === 'bicycle-stock' &&
            (risk.severity === 'warning' ||
              /대수 미확인|수는 확인하지|재고 미확인/.test(`${risk.title} ${risk.description}`)),
        )
      ) {
        exclude(
          'availability',
          '대여소의 최근 재고와 대여·반납 이용 조건이 모두 확인되지 않았습니다.',
        );
      }

      if (context.mobility) {
        for (const [index, segment] of route.segments.entries()) {
          if (segment.mode !== 'hire' && !segment.id.includes('scooter-unlock')) {
            continue;
          }

          const later = route.segments.slice(index + 1);
          const leaseEnd = later.findIndex(
            (part) => part.mode === 'return' || part.mode === 'hire',
          );
          const rentalMode = segment.id.includes('scooter-unlock')
            ? 'scooter'
            : later
                .slice(0, leaseEnd < 0 ? later.length : leaseEnd)
                .find((part) => part.mode === 'bicycle' || part.mode === 'scooter')?.mode;
          const permission = segment.rentalValidity;
          const seoulStationId =
            rentalMode === 'bicycle' && segment.start.id.startsWith('ddareungi-')
              ? segment.start.id.slice('ddareungi-'.length)
              : null;

          const marker = context.mobility.markers.find((item) => {
            const kindMatches =
              rentalMode === 'scooter'
                ? item.kind === 'kick-scooter'
                : rentalMode === 'bicycle' &&
                  (item.kind === 'bicycle' || item.kind === 'e-bicycle');

            if (!kindMatches || metersBetween(item, segment.start) > 35) {
              return false;
            }

            if (
              seoulStationId &&
              (item.source !== 'seoul-bike' || item.sourceId !== seoulStationId)
            ) {
              return false;
            }

            return (
              !permission ||
              (item.sourceId === permission.vehicleId &&
                (item.provider === permission.provider || item.id === segment.start.id))
            );
          });

          if (
            marker &&
            (!marker.available ||
              marker.freshness === 'stale' ||
              request.now - marker.receivedAt > 120_000)
          ) {
            exclude('availability', `${marker.name}: 재고가 없거나 위치 정보가 오래되었습니다.`);
          }

          if (marker?.freshness === 'unknown') {
            confidence = 'limited';
            explanations.push({
              code: 'source',
              severity: 'caution',
              text: `${marker.name}: 조회 시각은 확인했지만 원본 측정시각은 제공되지 않습니다.`,
            });
          }
        }
      }

      const hasOutdoor = route.segments.some(
        (segment) =>
          ['walk', 'run', 'bicycle', 'scooter'].includes(segment.mode) &&
          segment.distanceMeters > 0,
      );

      if (liveWeather && hasOutdoor) {
        const rain = (weather!.precipitationMm ?? 0) > 0 || (weather!.precipitationType ?? 0) > 0;
        const strongWind = (weather!.windMetersPerSecond ?? 0) >= 8;
        const icy = (weather!.temperatureC ?? 20) <= 0 && rain;

        if (
          (modes.has('scooter') || modes.has('bicycle')) &&
          (icy || strongWind || (weather!.precipitationMm ?? 0) >= 5)
        ) {
          exclude(
            'weather',
            '강한 바람·강수 또는 결빙 가능성이 있어 노출된 이륜 이동은 추천에서 제외합니다.',
          );
        }

        if (rain) {
          const exposedSeconds = route.segments
            .filter((segment) => ['walk', 'run', 'bicycle', 'scooter'].includes(segment.mode))
            .reduce((sum, segment) => sum + segment.durationSeconds.max, 0);
          const addition = prepared ? included.weather : Math.ceil(exposedSeconds * 0.15);

          if (!prepared) {
            buffer += addition;
          }

          if (addition) {
            explanations.push({
              code: 'weather',
              severity: 'caution',
              text: prepared
                ? '관측된 강수에 따른 야외 구간의 15% 계획 여유를 승차 연결 계산 전에 포함했습니다. 검증된 속도 예측값은 아닙니다.'
                : '관측된 강수로 야외 구간에 15% 여유를 더했습니다. 검증된 속도 예측값은 아닙니다.',
              seconds: addition,
            });
          }
        }
      } else if (hasOutdoor) {
        confidence = 'limited';
        explanations.push({
          code: 'weather',
          severity: 'caution',
          text: '현재 출발지의 기상 관측을 확인하지 못해 날씨 보정은 적용하지 않았습니다.',
        });
      }

      if (modes.has('taxi')) {
        confidence = 'limited';
        explanations.push({
          code: 'availability',
          severity: 'caution',
          text: '택시 배차 대기는 추정치이며 실제 차량 배정은 보장되지 않습니다.',
        });
      }

      if (modes.has('car') && route.risks.some((risk) => risk.code === 'parking')) {
        confidence = 'limited';
        explanations.push({
          code: 'parking',
          severity: 'caution',
          text: '주차장 운영 조건과 잔여 면수는 도착 전 다시 확인해야 합니다.',
        });
      }

      if (legacyCalibrated) {
        const addition = prepared
          ? included.calibration
          : route.segments.reduce(
              (sum, segment) =>
                sum + (context.calibration!.modes[segment.mode]?.upperResidualSeconds ?? 0),
              0,
            );

        if (addition) {
          if (!prepared) {
            buffer += addition;
          }

          explanations.push({
            code: 'calibration',
            severity: 'info',
            text: prepared
              ? '실제 기록으로 학습하고 이후 기록에서 검증한 계획 여유를 각 구간과 승차 연결에 이미 포함했습니다.'
              : '실제 이동 기록으로 학습하고 이후 기록에서 검증한 추가 여유를 반영했습니다.',
            seconds: addition,
          });
        }
      }

      if (!prepared && buffer > 0 && (modes.has('bus') || modes.has('subway'))) {
        confidence = 'limited';
        explanations.push({
          code: 'transfer',
          severity: 'caution',
          text: '이 이전 형식의 경로는 마지막 예상에만 추가 여유를 적용했습니다. 변경된 접근 시간으로 차량 연결을 다시 확인한 결과가 아니므로 승차 전에 경로를 다시 조회해야 합니다.',
        });
      }

      const earliest = invalidDuration ? request.now : route.readyTime.earliest;
      const wholeRisk = journeyRiskSeconds(route);

      if (wholeRisk) {
        explanations.push({
          code: 'calibration',
          severity: 'info',
          text: '완료한 전체 여정으로 검증한 상한 보정을 한 번 반영했어요. 구간별 상한을 더해 얻은 신뢰구간은 아니며 실제 환승 시각은 유지합니다.',
          seconds: wholeRisk,
        });
      }

      const latest = invalidDuration
        ? request.now
        : route.readyTime.latest + (buffer + wholeRisk) * 1_000;
      const conservativeSeconds = Math.max(0, Math.ceil((latest - request.now) / 1_000));
      const latenessSeconds = Math.max(0, Math.ceil((latest - request.deadline) / 1_000));
      const estimate = estimateBaseTimeline(route.segments, request.now);
      const estimatedReadyAt = estimate
        ? estimate.arrivalAt + request.preferences.preparationSeconds * 1000
        : undefined;
      const estimatedSeconds =
        estimatedReadyAt === undefined ? undefined : (estimatedReadyAt - request.now) / 1000;

      if (objective === 'estimated-arrival' && estimatedSeconds === undefined) {
        exclude('transfer', '예상 도착 시각에 탑승 가능한 연결편을 확인하지 못했어요.');
      }

      const score = eligible
        ? objective === 'estimated-arrival'
          ? estimatedSeconds!
          : conservativeSeconds
        : Number.MAX_SAFE_INTEGER;

      explanations.unshift({
        code: 'arrival',
        severity: latenessSeconds ? 'caution' : 'info',
        text: latenessSeconds
          ? `보수적으로 판단하면 마감보다 ${Math.ceil(latenessSeconds / 60)}분 늦을 수 있습니다.`
          : '도착 준비 시간과 확인 가능한 여유를 포함해 마감 안에 도착하는 범위입니다.',
      });

      if (route.fareWon !== undefined) {
        explanations.push({
          code: 'cost',
          severity: 'info',
          text: `표시된 비용 ${Math.round(route.fareWon).toLocaleString('ko-KR')}원은 공급원의 예상치이며 미확인 대여·주차 요금은 포함되지 않을 수 있습니다.`,
        });
      }

      if (objective === 'estimated-arrival' && estimatedSeconds !== undefined) {
        explanations.unshift({
          code: 'arrival',
          severity: 'info',
          text: `예상 소요 ${Math.ceil(estimatedSeconds / 60)}분을 기준으로 비교해요. 시간 범위의 중간값·검증된 구간 예측과 탑승 가능한 연결편을 사용하며 지연 여유는 별도로 표시해요.`,
          seconds: estimatedSeconds,
        });
      }

      return {
        routeId: route.id,
        eligible,
        confidence: eligible ? confidence : 'unavailable',
        predictedReadyAt: {
          earliest,
          latest,
        },
        estimatedSeconds,
        estimatedReadyAt,
        conservativeSeconds,
        latenessSeconds,
        extraBufferSeconds: included.weather + included.calibration + buffer + wholeRisk,
        score,
        explanations,
        timing:
          describeRouteTiming(route, request.preferences.preparationSeconds, request.now) ??
          undefined,
      };
    })
    .sort((a, b) => {
      if (a.eligible !== b.eligible) {
        return a.eligible ? -1 : 1;
      }

      const time =
        (objective === 'estimated-arrival' ? a.score - b.score : 0) ||
        a.predictedReadyAt.latest - b.predictedReadyAt.latest ||
        a.predictedReadyAt.earliest - b.predictedReadyAt.earliest;

      if (time) {
        return time;
      }

      const left = routes.find((route) => route.id === a.routeId)!,
        right = routes.find((route) => route.id === b.routeId)!;

      return (
        compareRouteEffort(left, right) ||
        left.transfers - right.transfers ||
        (left.fareWon ?? Number.MAX_SAFE_INTEGER) - (right.fareWon ?? Number.MAX_SAFE_INTEGER) ||
        a.routeId.localeCompare(b.routeId)
      );
    });

  return {
    objective,
    model: 'arrival-risk-v1',
    modelType: 'explainable-rules',
    calibrated,
    generatedAt: request.now,
    recommendationId: assessments.find((assessment) => assessment.eligible)?.routeId ?? null,
    assessments,
    weather,
    notice: learnedSegments
      ? `실제 완료 이동으로 학습하고 이후 이동에서 평가한 문맥 ETA를 ${learnedSegments}개 구간에 반영했습니다. 도착 확률을 보장하지 않습니다.`
      : calibrated
        ? '실제 기록으로 검증한 보정과 설명 가능한 판단 모델을 사용합니다. 도착 확률을 보장하지 않습니다.'
        : '교통·대여·기상 근거를 비교하는 설명 가능한 판단 모델입니다. 학습 자료가 충분하고 이후 기록에서 개선된 ETA 모델만 적용합니다.',
  };
}
