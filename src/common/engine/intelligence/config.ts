import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { GbfsFeedConfiguration } from './gbfs.js';
import { usableCalibration, type EtaCalibration } from './calibration.js';

const officialFeedUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value),
        host = url.hostname.toLowerCase();

      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        host !== 'localhost' &&
        !host.endsWith('.localhost') &&
        !host.endsWith('.local') &&
        !host.endsWith('.internal') &&
        !host.startsWith('[') &&
        !/^\d+\.\d+\.\d+\.\d+$/.test(host)
      );
    } catch {
      return false;
    }
  });

const schema = z
  .array(
    z
      .object({
        provider: z.string().trim().min(1).max(80),
        vehicleStatusUrl: officialFeedUrl,
        vehicleTypesUrl: officialFeedUrl.optional(),
        kind: z.enum(['bicycle', 'e-bicycle', 'kick-scooter', 'motor-scooter']).optional(),
      })
      .strict(),
  )
  .max(20);

/** Server environment only. Do not accept caller-supplied feed URLs in HTTP endpoints. */
export function parseGbfsConfiguration(raw: string | undefined): GbfsFeedConfiguration[] {
  if (!raw?.trim()) {
    return [];
  }

  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    // JSON/Zod errors can echo input. Keep credentials and endpoints out of logs.
    throw new Error('MOBILITY_GBFS_FEEDS: GBFS 운영사 공개 HTTPS 피드 설정이 유효하지 않습니다.');
  }
}

const modeSchema = z.enum([
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
]);

const calibrationSchema = z
  .object({
    version: z.literal('eta-residual-v1'),
    trainedAt: z.number().int().positive(),
    sampleCount: z.number().int().min(30).max(100_000),
    modes: z.partialRecord(
      modeSchema,
      z
        .object({
          sampleCount: z.number().int().min(30).max(100_000),
          medianResidualSeconds: z.number().int().min(-86_400).max(86_400),
          upperResidualSeconds: z.number().int().min(0).max(86_400),
          evaluation: z
            .object({
              heldOutCount: z.number().int().min(5).max(100_000),
              baselineMaeSeconds: z.number().int().min(0).max(86_400),
              calibratedMaeSeconds: z.number().int().min(0).max(86_400),
            })
            .strict(),
        })
        .strict(),
    ),
    evaluation: z
      .object({
        heldOutCount: z.number().int().min(5).max(100_000),
        baselineMaeSeconds: z.number().int().min(0).max(86_400),
        calibratedMaeSeconds: z.number().int().min(0).max(86_400),
      })
      .strict(),
  })
  .strict();

export function parseEtaCalibration(raw: string, now = Date.now()): EtaCalibration {
  try {
    const model = calibrationSchema.parse(JSON.parse(raw));

    if (!usableCalibration(model, now)) {
      throw new Error('unusable');
    }

    if (
      !Object.values(model.modes).length ||
      Object.values(model.modes).reduce((sum, mode) => sum + mode.sampleCount, 0) !==
        model.sampleCount
    ) {
      throw new Error('invalid sample accounting');
    }

    return model;
  } catch {
    throw new Error('ETA_MODEL_PATH: 실측 검증을 통과한 최근 ETA 모델 파일이 아닙니다.');
  }
}

/** Optional server startup configuration. A bad configured model fails explicitly. */
export function loadEtaCalibrationSync(
  path: string | undefined,
  now = Date.now(),
): EtaCalibration | undefined {
  if (!path?.trim()) {
    return undefined;
  }

  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error('ETA_MODEL_PATH: ETA 모델 파일을 읽지 못했습니다.');
  }

  return parseEtaCalibration(raw, now);
}
