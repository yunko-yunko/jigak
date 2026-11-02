import { existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { z } from 'zod';
import type { EtaLearningFeatures } from '../../shared/intelligence/learning.js';
import {
  CONTEXTUAL_FEATURE_NAMES,
  CONTEXTUAL_MODES,
  contextualFeatureVector,
} from './contextual-model.js';

export const HGB_VERSION = 'eta-hgb-v1' as const;
const DAY = 86_400_000,
  N = CONTEXTUAL_FEATURE_NAMES.length;
const finite = z.number().finite(),
  stamp = finite.int().positive();
const vector = z.array(finite).length(N);
const node = z
  .object({
    value: finite,
    feature: finite
      .int()
      .min(0)
      .max(N - 1),
    threshold: finite,
    left: finite.int().nonnegative(),
    right: finite.int().nonnegative(),
    leaf: z.boolean(),
  })
  .strict();
const ensemble = z
  .object({ initial: finite, trees: z.array(z.array(node).min(1).max(31)).min(1).max(150) })
  .strict();
const split = z
  .object({
    groups: finite.int().nonnegative(),
    rows: finite.int().nonnegative(),
    start: stamp,
    end: stamp,
  })
  .strict();
const evaluation = z
  .object({
    baselineMae: finite.nonnegative(),
    ridgeMae: finite.nonnegative(),
    modelMae: finite.nonnegative(),
    intervalCoverage: finite.min(0).max(1),
    upperCoverage: finite.min(0).max(1),
    relativeWidth: finite.nonnegative(),
  })
  .strict();
const mode = z
  .object({
    models: z.object({ lower: ensemble, median: ensemble, upper: ensemble }).strict(),
    domain: z.object({ minimum: vector, maximum: vector }).strict(),
    logRadius: finite.min(0).max(Math.log(2)),
    splits: z.object({ train: split, calibration: split, test: split }).strict(),
    evaluation,
  })
  .strict();
const schema = z
  .object({
    version: z.literal(HGB_VERSION),
    algorithm: z.literal('HistGradientBoostingRegressor'),
    target: z.literal('log-actual-over-predicted'),
    labelSource: z.literal('recorded-trip'),
    trainedAt: stamp,
    expiresAt: stamp,
    featureNames: z.array(z.string()).length(N),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    modes: z.partialRecord(z.enum(CONTEXTUAL_MODES), mode),
  })
  .strict();
export type HgbModel = z.infer<typeof schema>;
export type HgbMode = NonNullable<HgbModel['modes'][keyof HgbModel['modes']]>;

export function hgbDomainContains(raw: readonly number[], domain: HgbMode['domain']): boolean {
  if (raw.length !== N || !raw.every(Number.isFinite)) return false;
  return raw.every((value, i) => {
    const binary = /^(mode:|congestion:)|Missing$|^liveWait$/.test(CONTEXTUAL_FEATURE_NAMES[i]);
    const tolerance = binary ? 0 : Math.max(0.05, (domain.maximum[i] - domain.minimum[i]) * 0.15);
    return value >= domain.minimum[i] - tolerance && value <= domain.maximum[i] + tolerance;
  });
}
export function hgbRaw(model: HgbMode['models']['median'], raw: readonly number[]): number {
  let result = model.initial;
  for (const tree of model.trees) {
    let index = 0;
    while (!tree[index].leaf) {
      const n = tree[index];
      index = raw[n.feature] <= n.threshold ? n.left : n.right;
    }
    result += tree[index].value;
  }
  return result;
}
export function parseHgbModel(text: string, now = Date.now()): HgbModel {
  if (!Number.isFinite(now)) throw new Error('invalid-hgb-clock');
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('hgb-model-too-large');
  const model = schema.parse(JSON.parse(text));
  if (
    model.trainedAt > now ||
    model.expiresAt <= now ||
    model.expiresAt <= model.trainedAt ||
    model.expiresAt > model.trainedAt + 30 * DAY ||
    model.featureNames.some((name, i) => name !== CONTEXTUAL_FEATURE_NAMES[i]) ||
    !Object.keys(model.modes).length
  )
    throw new Error('invalid-hgb-model');
  for (const [name, value] of Object.entries(model.modes)) {
    const { train, calibration, test } = value.splits,
      e = value.evaluation;
    if (
      train.groups < 200 ||
      calibration.groups < 50 ||
      test.groups < 50 ||
      train.end > calibration.start ||
      calibration.end > test.start ||
      train.start < model.trainedAt - 90 * DAY ||
      test.end > model.trainedAt ||
      Object.values(value.splits).some((s) => s.rows < s.groups || s.start > s.end) ||
      !(
        e.modelMae < e.baselineMae &&
        e.modelMae < e.ridgeMae &&
        e.intervalCoverage >= 0.8 &&
        e.upperCoverage >= 0.9 &&
        e.relativeWidth <= 1.5
      ) ||
      value.domain.minimum.some((min, i) => min > value.domain.maximum[i]) ||
      CONTEXTUAL_MODES.some(
        (m, i) =>
          value.domain.minimum[i] !== Number(m === name) ||
          value.domain.maximum[i] !== Number(m === name),
      )
    )
      throw new Error('hgb-quality-gate-failed');
    for (const model of Object.values(value.models))
      for (const tree of model.trees) {
        const parents = Array<number>(tree.length).fill(0);
        tree.forEach((n, i) => {
          if (n.leaf) return;
          if (
            n.left <= i ||
            n.right <= i ||
            n.left >= tree.length ||
            n.right >= tree.length ||
            n.left === n.right
          )
            throw new Error('invalid-hgb-tree');
          parents[n.left]++;
          parents[n.right]++;
        });
        if (parents[0] || parents.slice(1).some((n) => n !== 1))
          throw new Error('disconnected-hgb-tree');
      }
  }
  return model;
}
export function predictHgb(model: HgbModel, features: EtaLearningFeatures, now: number) {
  if (!Number.isFinite(now) || now < model.trainedAt || now >= model.expiresAt) return null;
  const raw = contextualFeatureVector(features),
    selected = model.modes[features.mode];
  if (!raw || !selected || !hgbDomainContains(raw, selected.domain)) return null;
  const logs = Object.fromEntries(
    Object.entries(selected.models).map(([key, m]) => [key, hgbRaw(m, raw)]),
  );
  const median = features.predictedSeconds * Math.exp(logs.median);
  const lower =
    features.predictedSeconds * Math.exp(Math.min(logs.lower, logs.median) - selected.logRadius);
  const upper =
    features.predictedSeconds * Math.exp(Math.max(logs.upper, logs.median) + selected.logRadius);
  if (![lower, median, upper].every((n) => Number.isFinite(n) && n >= 1 && n <= 86_400))
    return null;
  return {
    modelVersion: HGB_VERSION,
    lowerSeconds: Math.floor(lower),
    medianSeconds: Math.ceil(median),
    upperSeconds: Math.ceil(upper),
  };
}

/** Load once per server start, so a file replacement cannot change a live collection cohort. */
export class HgbEtaService {
  private model?: HgbModel;
  private reason = 'missing-checkpoint';
  constructor(
    private readonly path?: string,
    private readonly now = Date.now,
  ) {
    try {
      if (path && existsSync(path)) {
        if (!statSync(path).isFile() || statSync(path).size > 16 * 1024 * 1024)
          throw new Error('size');
        this.model = parseHgbModel(readFileSync(path, 'utf8'), now());
        this.reason = '';
      }
    } catch {
      this.reason = 'invalid-or-expired-checkpoint';
    }
  }
  predict(features: EtaLearningFeatures) {
    return this.model ? predictHgb(this.model, features, this.now()) : null;
  }
  status() {
    const active =
      !!this.model && this.now() >= this.model.trainedAt && this.now() < this.model.expiresAt;
    return {
      version: HGB_VERSION,
      active,
      trainedAt: active ? this.model!.trainedAt : null,
      sampleCount: active
        ? Object.values(this.model!.modes).reduce(
            (n, m) => n + Object.values(m.splits).reduce((s, p) => s + p.rows, 0),
            0,
          )
        : 0,
      activeModes: active ? Object.keys(this.model!.modes) : [],
      reasons: active ? [] : [this.reason || 'expired-checkpoint'],
    };
  }
  erase() {
    this.model = undefined;
    this.reason = 'data-erased-retraining-required';
    if (this.path) rmSync(this.path, { force: true });
  }
}
