import { z } from 'zod';
import {
  trainEtaCalibration,
  usableCalibration,
  validObservation,
  type EtaCalibration,
} from './calibration.js';

const observation = z
  .object({
    observationId: z.string().min(1).max(128),
    source: z.literal('recorded-trip'),
    completed: z.literal(true),
    mode: z.enum([
      'walk',
      'run',
      'entry',
      'wait',
      'bus',
      'subway',
      'hire',
      'bicycle',
      'return',
      'taxi',
      'car',
      'scooter',
    ]),
    predictedSeconds: z.number().finite().positive().max(86_400),
    actualSeconds: z.number().finite().positive().max(86_400),
    observedAt: z.number().int().positive(),
  })
  .strict();

/** Build a model from actual completed segment observations, never route previews or demo trips. */
export function trainRecordedEtaJsonl(jsonl: string, now = Date.now()): EtaCalibration {
  const lines = jsonl.split(/\r?\n/).filter((line) => line.trim());

  if (lines.length > 100_000) {
    throw new Error('한 번에 100,000건 이하의 실측 기록을 사용해 주세요.');
  }

  const seen = new Set<string>();

  const rows = lines.map((line, index) => {
    let raw: unknown;

    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${index + 1}행 JSON이 유효하지 않습니다.`);
    }

    const result = observation.safeParse(raw);

    if (!result.success) {
      throw new Error(`${index + 1}행은 완료된 실측 이동 기록 형식이 아닙니다.`);
    }

    const row = result.data;

    if (seen.has(row.observationId)) {
      throw new Error(`${index + 1}행에 중복 실측 기록이 있습니다.`);
    }

    seen.add(row.observationId);

    if (!validObservation(row, now)) {
      throw new Error(
        `${index + 1}행의 실측 시간 또는 측정일이 유효하지 않습니다. 최근 90일의 완료 기록이 필요합니다.`,
      );
    }

    return row;
  });

  const sorted = [...rows].sort((a, b) => a.observedAt - b.observedAt),
    split = Math.floor(sorted.length * 0.8);
  const trainingCounts = new Map<string, number>(),
    validationCounts = new Map<string, number>();

  sorted.forEach((row, index) => {
    const counts = index < split ? trainingCounts : validationCounts;

    counts.set(row.mode, (counts.get(row.mode) ?? 0) + 1);
  });

  const sufficient = [...trainingCounts].some(
    ([mode, count]) => count >= 30 && (validationCounts.get(mode) ?? 0) >= 5,
  );

  if (!sufficient) {
    throw new Error(
      '충분한 실측 기록이 없습니다. 동일 이동수단의 학습 기록 30건과 이후 검증 기록 5건 이상이 필요합니다.',
    );
  }

  const model = trainEtaCalibration(rows, now);

  if (!usableCalibration(model, now)) {
    throw new Error('이후 실측 기록에서 오차 개선이 확인되지 않아 보정 모델을 저장하지 않습니다.');
  }

  return model;
}
