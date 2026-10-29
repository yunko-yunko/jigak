import type { SegmentMode } from '../../shared/domain/types.js';

/** Recorded trips only. No positions, account identifiers or hypothetical trips belong here. */
export interface EtaObservation {
  mode: SegmentMode;
  predictedSeconds: number;
  actualSeconds: number;
  observedAt: number;
}

export interface EtaCalibration {
  version: 'eta-residual-v1';
  trainedAt: number;
  sampleCount: number;
  modes: Partial<
    Record<
      SegmentMode,
      {
        sampleCount: number;
        medianResidualSeconds: number;
        upperResidualSeconds: number;
        evaluation: {
          heldOutCount: number;
          baselineMaeSeconds: number;
          calibratedMaeSeconds: number;
        };
      }
    >
  >;
  evaluation: {
    heldOutCount: number;
    baselineMaeSeconds: number | null;
    calibratedMaeSeconds: number | null;
  };
}

const MODES = new Set<SegmentMode>([
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

const quantile = (values: number[], fraction: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};

const average = (values: number[]) =>
  values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;

export function validObservation(value: EtaObservation, now: number): boolean {
  return (
    MODES.has(value.mode) &&
    Number.isFinite(value.predictedSeconds) &&
    value.predictedSeconds > 0 &&
    value.predictedSeconds <= 86_400 &&
    Number.isFinite(value.actualSeconds) &&
    value.actualSeconds > 0 &&
    value.actualSeconds <= 86_400 &&
    Number.isFinite(value.observedAt) &&
    value.observedAt > 0 &&
    value.observedAt <= now &&
    now - value.observedAt <= 90 * 86_400_000
  );
}

/** Median residual model with a chronological holdout; refuse to call tiny samples trained. */
export function trainEtaCalibration(
  observations: readonly EtaObservation[],
  now = Date.now(),
): EtaCalibration {
  const clean = observations
    .filter((observation) => validObservation(observation, now))
    .sort((a, b) => a.observedAt - b.observedAt);
  const holdoutStart = Math.floor(clean.length * 0.8);
  const train = clean.slice(0, holdoutStart),
    heldOut = clean.slice(holdoutStart);
  const modes: EtaCalibration['modes'] = {};

  for (const mode of MODES) {
    const rows = train.filter((row) => row.mode === mode);
    const validationRows = heldOut.filter((row) => row.mode === mode);

    if (rows.length < 30 || validationRows.length < 5) {
      continue;
    }

    const residuals = rows.map((row) => row.actualSeconds - row.predictedSeconds);
    const medianResidualSeconds = Math.round(quantile(residuals, 0.5));
    const baselineMaeSeconds = average(
      validationRows.map((row) => Math.abs(row.actualSeconds - row.predictedSeconds)),
    )!;
    const calibratedMaeSeconds = average(
      validationRows.map((row) =>
        Math.abs(row.actualSeconds - row.predictedSeconds - medianResidualSeconds),
      ),
    )!;

    // An improving walk calibration must not conceal a worsening or untested bus calibration.
    if (calibratedMaeSeconds >= baselineMaeSeconds) {
      continue;
    }

    modes[mode] = {
      sampleCount: rows.length,
      medianResidualSeconds,
      upperResidualSeconds: Math.max(0, Math.round(quantile(residuals, 0.9))),
      evaluation: {
        heldOutCount: validationRows.length,
        baselineMaeSeconds,
        calibratedMaeSeconds,
      },
    };
  }

  const evaluationRows = heldOut.filter((row) => modes[row.mode]);

  return {
    version: 'eta-residual-v1',
    trainedAt: now,
    sampleCount: train.filter((row) => modes[row.mode]).length,
    modes,
    evaluation: {
      heldOutCount: evaluationRows.length,
      baselineMaeSeconds: average(
        evaluationRows.map((row) => Math.abs(row.actualSeconds - row.predictedSeconds)),
      ),
      calibratedMaeSeconds: average(
        evaluationRows.map((row) =>
          Math.abs(
            row.actualSeconds - row.predictedSeconds - modes[row.mode]!.medianResidualSeconds,
          ),
        ),
      ),
    },
  };
}

/** Use only models that improved error on unseen, later observations. */
export function usableCalibration(
  model: EtaCalibration | undefined,
  now: number,
): model is EtaCalibration {
  const count = (value: number, minimum: number) =>
    Number.isInteger(value) && value >= minimum && value <= 100_000;

  const seconds = (value: number | null, minimum = 0) =>
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 86_400;

  const evaluation = (value: EtaCalibration['evaluation'] | undefined) =>
    !!value &&
    count(value.heldOutCount, 5) &&
    seconds(value.baselineMaeSeconds) &&
    seconds(value.calibratedMaeSeconds) &&
    value.calibratedMaeSeconds! < value.baselineMaeSeconds!;

  if (
    !model ||
    model.version !== 'eta-residual-v1' ||
    !Number.isFinite(now) ||
    !Number.isInteger(model.trainedAt) ||
    model.trainedAt <= 0 ||
    model.trainedAt > now ||
    now - model.trainedAt > 30 * 86_400_000 ||
    !count(model.sampleCount, 30) ||
    !evaluation(model.evaluation) ||
    !model.modes ||
    typeof model.modes !== 'object'
  ) {
    return false;
  }

  const modes = Object.entries(model.modes);

  if (
    !modes.length ||
    modes.some(
      ([mode, value]) =>
        !MODES.has(mode as SegmentMode) ||
        !value ||
        !count(value.sampleCount, 30) ||
        !seconds(value.medianResidualSeconds, -86_400) ||
        !seconds(value.upperResidualSeconds) ||
        !evaluation(value.evaluation),
    )
  ) {
    return false;
  }

  return (
    modes.reduce((sum, [, mode]) => sum + mode.sampleCount, 0) === model.sampleCount &&
    modes.reduce((sum, [, mode]) => sum + mode.evaluation.heldOutCount, 0) ===
      model.evaluation.heldOutCount
  );
}
