import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  parseSpatialBicycleModel,
  predictSpatialBicycleShadow,
  type SpatialBicycleInput,
  type SpatialBicycleModel,
} from './spatial-bicycle-model.js';

const finite = z.number().finite(),
  count = finite.int().min(0);

const evaluationSchema = z
  .object({
    rows: count,
    supported: count,
    unsupported: count,
    baselineMaeSeconds: finite.min(0),
    ridgeMaeSeconds: finite.min(0),
    modelMaeSeconds: finite.min(0).nullable(),
    supportedModelMaeSeconds: finite.min(0).nullable(),
    intervalCoverage: finite.min(0).max(1),
    upperCoverage: finite.min(0).max(1),
    meanRelativeWidth: finite.min(0).nullable(),
  })
  .strict();

const splitSchema = z
  .object({
    rows: count,
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
    bicycles: count,
  })
  .strict();

const reportSchema = z
  .object({
    version: z.literal('seoul-bicycle-spatial-v1'),
    deployment: z.literal('shadow'),
    productionEligible: z.literal(false),
    qualityPassed: z.boolean(),
    qualityFailedGroups: z.array(z.string()),
    counts: z
      .object({
        input: count,
        sourceFiles: count,
      })
      .passthrough(),
    split: z
      .object({
        train: splitSchema,
        calibration: splitSchema,
        test: splitSchema,
      })
      .passthrough(),
    evaluations: z
      .object({
        all: evaluationSchema,
        unseenOd: evaluationSchema.nullable(),
        seenOd: evaluationSchema.nullable(),
        heldOutBicycle: evaluationSchema.nullable(),
        dayParts: z.record(z.string(), evaluationSchema.nullable()),
        days: z.record(z.string(), evaluationSchema.nullable()),
      })
      .strict(),
    reproducibility: z
      .object({
        protocolSha256: z.string().regex(/^[a-f0-9]{64}$/),
        modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .passthrough(),
    limitations: z.array(z.string()),
  })
  .passthrough();

type Report = z.infer<typeof reportSchema>;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const good = (e: z.infer<typeof evaluationSchema> | null) =>
  !!e &&
  e.rows >= 100 &&
  e.unsupported === 0 &&
  e.modelMaeSeconds !== null &&
  e.modelMaeSeconds < Math.min(e.baselineMaeSeconds, e.ridgeMaeSeconds) &&
  e.intervalCoverage >= 0.8 &&
  e.upperCoverage >= 0.9 &&
  e.meanRelativeWidth !== null &&
  e.meanRelativeWidth <= 1.5;

/** Read-only research loader. Availability never means routing or promotion. */
export class SpatialBicycleShadowService {
  private model?: SpatialBicycleModel;
  private report?: Report;
  private reason = 'missing-shadow-artifacts';
  private checkedAt = -Infinity;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      modelPath: string;
      reportPath: string;
      protocolPath?: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.reload();
  }

  private reload() {
    const now = this.now();

    if (now >= this.checkedAt && now - this.checkedAt < 30000) {
      return;
    }

    this.checkedAt = now;

    try {
      const paths = [
        this.options.modelPath,
        this.options.reportPath,
        this.options.protocolPath ?? resolve(dirname(this.options.reportPath), 'protocol.json'),
      ];

      if (paths.some((path) => !existsSync(path))) {
        this.model = undefined;
        this.report = undefined;
        this.reason = 'missing-shadow-artifacts';

        return;
      }

      const texts = paths.map((path, i) => {
        const info = statSync(path);

        if (!info.isFile() || info.size > (i === 0 ? 16 : 2) * 1024 * 1024) {
          throw new Error('artifact-bound');
        }

        return readFileSync(path, 'utf8');
      });

      const model = parseSpatialBicycleModel(texts[0]),
        report = reportSchema.parse(JSON.parse(texts[1])),
        protocol = JSON.parse(texts[2]);

      if (
        digest(texts[0]) !== report.reproducibility.modelSha256 ||
        digest(texts[2]) !== report.reproducibility.protocolSha256 ||
        protocol.version !== model.version ||
        protocol.deployment !== 'shadow' ||
        protocol.productionEligible !== false ||
        !Array.isArray(protocol.inputs) ||
        JSON.stringify(protocol.inputs.map((input: { sha256?: string }) => input.sha256)) !==
          JSON.stringify(model.inputSha256) ||
        report.split.test.rows !== report.evaluations.all.rows ||
        model.trainedAt > now
      ) {
        throw new Error('artifact-provenance-mismatch');
      }

      const groups = {
        all: report.evaluations.all,
        unseenOd: report.evaluations.unseenOd,
        seenOd: report.evaluations.seenOd,
        heldOutBicycle: report.evaluations.heldOutBicycle,
        ...Object.fromEntries(
          Object.entries(report.evaluations.dayParts).map(([key, value]) => [
            `dayPart:${key}`,
            value,
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(report.evaluations.days).map(([key, value]) => [`day:${key}`, value]),
        ),
      };

      if (
        Object.values(groups).some(
          (value) => value && value.supported + value.unsupported !== value.rows,
        )
      ) {
        throw new Error('invalid-evaluation-denominator');
      }

      const failed = Object.entries(groups)
        .filter(([, value]) => !good(value))
        .map(([key]) => key)
        .sort();

      if (
        report.qualityPassed !== (failed.length === 0) ||
        JSON.stringify(failed) !== JSON.stringify([...report.qualityFailedGroups].sort())
      ) {
        throw new Error('invalid-quality-claim');
      }

      this.model = model;
      this.report = report;
      this.reason = '';
    } catch {
      this.model = undefined;
      this.report = undefined;
      this.reason = 'invalid-or-mismatched-shadow-artifacts';
    }
  }

  predict(input: SpatialBicycleInput) {
    this.reload();

    return this.model ? predictSpatialBicycleShadow(this.model, input) : null;
  }

  status() {
    this.reload();

    return {
      version: 'seoul-bicycle-spatial-v1',
      target: 'bicycle-rental-elapsed',
      available: !!this.model,
      active: false,
      deployment: 'shadow',
      productionEligible: false,
      qualityPassed: this.report?.qualityPassed ?? false,
      sampleCount: this.report?.counts.input ?? 0,
      trainedAt: this.model?.trainedAt ?? null,
      trainingThrough: this.model?.trainingThrough ?? null,
      reasons: this.model
        ? [
            ...(this.report!.qualityPassed ? [] : ['held-out-quality-gate-failed']),
            'rental-target-not-validated-for-routing',
            'offline-shadow-only',
          ]
        : [this.reason],
      ...(this.report
        ? {
            split: this.report.split,
            evaluations: this.report.evaluations,
            qualityFailedGroups: this.report.qualityFailedGroups,
          }
        : {}),
      limitations: this.model?.limitations ?? [
        'rental-return-includes-stops',
        'offline-shadow-only',
      ],
    };
  }
}
