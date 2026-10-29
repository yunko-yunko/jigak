import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  writePrivateFile,
  openPrivateFile,
  protectPrivateDirectorySync,
} from '../private-files.js';
import {
  parsePublicBusModel,
  type PublicBusEvaluation,
  type PublicBusModel,
} from './public-bus-model.js';

const sha256 = (contents: string) => createHash('sha256').update(contents).digest('hex');

const inside = (root: string, path: string) => {
  const child = relative(root, path);

  return !!child && !child.startsWith('..') && !isAbsolute(child);
};

// These dates have already been inspected by the recorded production/spatial experiments.
// A newly downloaded copy of the same source is not a new independent evaluation.
export const PREVIOUSLY_EVALUATED_BUS_DATES = ['2026-10-11', '2026-10-12'] as const;

export type BusRefreshPlan = {
  ready: boolean;
  reasons: string[];
  evaluation: 'reused' | 'forward';
  activeModelSha256: string;
  candidateModelSha256: string | null;
  candidateReportSha256: string;
  previousTestDate: string;
  candidateTestDate: string | null;
  previousExpiresAt: number;
  candidateExpiresAt: number | null;
};

export function publicBusCandidateDoesNotRegress(
  incumbent: PublicBusEvaluation | undefined,
  candidate: PublicBusEvaluation | undefined,
) {
  return (
    !!incumbent &&
    !!candidate &&
    incumbent.rows === candidate.rows &&
    incumbent.rows >= 200 &&
    incumbent.unsupported === 0 &&
    candidate.unsupported === 0 &&
    incumbent.modelMaeSeconds !== null &&
    candidate.modelMaeSeconds !== null &&
    candidate.modelMaeSeconds <= incumbent.modelMaeSeconds &&
    candidate.robustUpperCoverage >= incumbent.robustUpperCoverage &&
    candidate.robustIntervalCoverage >= incumbent.robustIntervalCoverage
  );
}

export function planPublicBusRefresh(
  reportText: string,
  activeText: string,
  now: number,
  evaluatedDates: readonly string[] = PREVIOUSLY_EVALUATED_BUS_DATES,
): BusRefreshPlan {
  const active = parsePublicBusModel(activeText, now, {
      allowExpired: true,
    }),
    report = JSON.parse(reportText);
  const testDate =
    report?.split?.test?.dates?.length === 1 ? (report.split.test.dates[0] as string) : null;
  const previousTestDate = active.validation.testDates[0],
    reasons: string[] = [];
  const reused = !testDate || testDate <= previousTestDate || evaluatedDates.includes(testDate);

  if (reused) {
    reasons.push('evaluation-day-already-used-or-not-forward');
  }

  let model: PublicBusModel | undefined;

  if (report.qualityPassed !== true || report.status !== 'production-candidate' || !report.model) {
    reasons.push('candidate-quality-failed');
  } else {
    try {
      model = parsePublicBusModel(JSON.stringify(report.model), now);
    } catch {
      reasons.push('invalid-or-expired-candidate');
    }
  }

  if (model) {
    if (
      model.trainedAt <= active.trainedAt ||
      model.validation.trainThrough <= active.validation.trainThrough ||
      model.split.test.latestObservedAt! <= active.split.test.latestObservedAt!
    ) {
      reasons.push('training-evidence-did-not-advance');
    }

    if (
      testDate !== model.validation.testDates[0] ||
      JSON.stringify(report.split) !== JSON.stringify(model.split)
    ) {
      reasons.push('report-model-split-mismatch');
    }

    const priorArchives = new Map(
      active.validation.sourceArchives.map((archive) => [archive.sourceDate, archive.sha256]),
    );

    if (
      model.validation.sourceArchives.some(
        (archive) =>
          priorArchives.has(archive.sourceDate) &&
          priorArchives.get(archive.sourceDate) !== archive.sha256,
      )
    ) {
      reasons.push('historical-source-content-changed');
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    evaluation: reused ? 'reused' : 'forward',
    activeModelSha256: sha256(activeText),
    candidateModelSha256: model ? sha256(JSON.stringify(model) + '\n') : null,
    candidateReportSha256: sha256(reportText),
    previousTestDate,
    candidateTestDate: testDate,
    previousExpiresAt: active.expiresAt,
    candidateExpiresAt: model?.expiresAt ?? null,
  };
}

export async function checkedPrivatePath(root: string, path: string, existing = true) {
  const actualRoot = await realpath(root),
    target = resolve(path),
    parent = await realpath(dirname(target));

  if (!inside(resolve(root), target) || (parent !== actualRoot && !inside(actualRoot, parent))) {
    throw new Error('outside-private-data');
  }

  const actual = existing ? await realpath(target) : resolve(parent, basename(target));

  if (!inside(actualRoot, actual) || (existing && (await stat(actual)).isDirectory())) {
    throw new Error('outside-private-data');
  }

  return actual;
}

/** First report wins an evaluation day. Replaying identical bytes is allowed; tuning against it is not. */
export async function registerPublicBusEvaluation(
  root: string,
  testDate: string,
  reportSha256: string,
  now: number,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate) || !/^[a-f0-9]{64}$/.test(reportSha256)) {
    throw new Error('invalid-evaluation-receipt');
  }

  const journal = resolve(root, 'public-bus-refresh-evaluations');

  await mkdir(journal, {
    recursive: true,
  });

  protectPrivateDirectorySync(journal);

  const path = resolve(journal, `${testDate}.json`);

  try {
    await writePrivateFile(
      path,
      JSON.stringify({
        version: 1,
        testDate,
        reportSha256,
        firstInspectedAt: now,
      }) + '\n',
    );

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }

    const actual = await checkedPrivatePath(root, path);

    if ((await stat(actual)).size > 2048) {
      throw new Error('invalid-evaluation-receipt');
    }

    const receipt = JSON.parse(await readFile(actual, 'utf8'));

    if (
      receipt.version !== 1 ||
      receipt.testDate !== testDate ||
      !/^[a-f0-9]{64}$/.test(receipt.reportSha256)
    ) {
      throw new Error('invalid-evaluation-receipt');
    }

    return receipt.reportSha256 === reportSha256;
  }
}

/** Verify downloaded bytes, not just a manifest's claimed hashes. No raw rows are emitted. */
export async function verifyPublicBusSourceArchives(
  model: PublicBusModel,
  manifests: readonly string[],
  root: string,
) {
  const acquired = new Map<
    string,
    {
      path: string;
      bytes: number;
    }
  >();

  for (const path of manifests) {
    const actual = await checkedPrivatePath(root, path);

    if ((await stat(actual)).size > 2 * 1024 ** 2) {
      throw new Error('manifest-size');
    }

    const manifest = JSON.parse(await readFile(actual, 'utf8'));

    if (
      manifest.version !== 'tdata-public-bus-acquisition-v1' ||
      !Array.isArray(manifest.archives) ||
      manifest.sourcePage !==
        'https://t-data.seoul.go.kr/dataprovide/trafficdataviewfile.do?data_id=20006' ||
      manifest.archiveCount !== manifest.archives.length ||
      manifest.archives.length < 1 ||
      manifest.archives.length > 14
    ) {
      throw new Error('invalid-acquisition-manifest');
    }

    for (const archive of manifest.archives) {
      if (
        !/^[a-f0-9]{64}$/.test(archive.sha256) ||
        !Number.isSafeInteger(archive.bytes) ||
        archive.bytes <= 0 ||
        archive.bytes > 768 * 1024 ** 2 ||
        typeof archive.path !== 'string' ||
        typeof archive.url !== 'string' ||
        !/^https:\/\/t-data\.seoul\.go\.kr\/dataprovide\/download\.do\?id=\d+$/.test(archive.url)
      ) {
        throw new Error('invalid-source-receipt');
      }

      acquired.set(archive.sha256, {
        path: resolve(dirname(root), archive.path),
        bytes: archive.bytes,
      });
    }
  }

  let checkedBytes = 0;

  for (const archive of model.validation.sourceArchives) {
    const receipt = acquired.get(archive.sha256);

    if (!receipt) {
      throw new Error('missing-source-receipt');
    }

    const actual = await checkedPrivatePath(root, receipt.path);

    if ((await stat(actual)).size !== receipt.bytes) {
      throw new Error('source-size-mismatch');
    }

    const digest = createHash('sha256');

    for await (const chunk of createReadStream(actual)) {
      digest.update(chunk);
    }

    if (digest.digest('hex') !== archive.sha256) {
      throw new Error('source-hash-mismatch');
    }

    checkedBytes += receipt.bytes;
  }

  return {
    checkedArchives: model.validation.sourceArchives.length,
    checkedBytes,
  };
}

type ReplaceReceipt = {
  version: 'public-bus-replacement-v1';
  at: number;
  beforeSha256: string;
  afterSha256: string;
  backup: string;
};

/** Same-directory rename keeps readers on a complete old or new checkpoint; failed writes keep the old model. */
export async function replacePublicBusCheckpoint(options: {
  root: string;
  activePath: string;
  expectedSha256: string;
  contents: string;
  now: number;
}) {
  const destination = await checkedPrivatePath(options.root, options.activePath),
    parent = dirname(destination);

  const lock = `${destination}.refresh.lock`,
    handle = await openPrivateFile(lock);

  const transaction = randomUUID(),
    temporary = resolve(parent, `.public-bus-${transaction}.tmp`);
  const backup = resolve(parent, `public-bus-backup-${transaction}.json`),
    receiptPath = resolve(parent, `public-bus-replacement-${transaction}.json`);

  try {
    const previous = await readFile(destination, 'utf8');

    if (sha256(previous) !== options.expectedSha256) {
      throw new Error('active-model-changed');
    }

    parsePublicBusModel(options.contents, options.now);

    await writePrivateFile(backup, previous);
    await writePrivateFile(temporary, options.contents);

    const receipt: ReplaceReceipt = {
      version: 'public-bus-replacement-v1',
      at: options.now,
      beforeSha256: sha256(previous),
      afterSha256: sha256(options.contents),
      backup: basename(backup),
    };

    // Receipt and backup are durable before activation, including recovery after a process crash.
    await writePrivateFile(receiptPath, JSON.stringify(receipt) + '\n');

    if (sha256(await readFile(destination, 'utf8')) !== options.expectedSha256) {
      throw new Error('active-model-changed');
    }

    await rename(temporary, destination);

    return {
      ...receipt,
      receiptPath: relative(options.root, receiptPath),
    };
  } finally {
    await handle.close();

    await rm(lock, {
      force: true,
    });
    await rm(temporary, {
      force: true,
    });
  }
}

/** Rollback preserves the earlier expiry. It cannot revive an expired model or undo an unrelated later deployment. */
export async function rollbackPublicBusCheckpoint(options: {
  root: string;
  activePath: string;
  receiptPath: string;
  now: number;
}) {
  const receiptPath = await checkedPrivatePath(options.root, options.receiptPath);

  if ((await stat(receiptPath)).size > 2048) {
    throw new Error('invalid-rollback-receipt');
  }

  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as ReplaceReceipt;

  if (
    receipt.version !== 'public-bus-replacement-v1' ||
    !/^[a-f0-9]{64}$/.test(receipt.beforeSha256) ||
    !/^[a-f0-9]{64}$/.test(receipt.afterSha256) ||
    basename(receipt.backup) !== receipt.backup
  ) {
    throw new Error('invalid-rollback-receipt');
  }

  const backup = await checkedPrivatePath(
    options.root,
    resolve(dirname(receiptPath), receipt.backup),
  );

  if ((await stat(backup)).size > 1_048_576) {
    throw new Error('invalid-rollback-backup');
  }

  const contents = await readFile(backup, 'utf8');

  if (sha256(contents) !== receipt.beforeSha256) {
    throw new Error('rollback-backup-hash-mismatch');
  }

  return replacePublicBusCheckpoint({
    root: options.root,
    activePath: options.activePath,
    expectedSha256: receipt.afterSha256,
    contents,
    now: options.now,
  });
}

export { sha256 as publicBusArtifactHash };
