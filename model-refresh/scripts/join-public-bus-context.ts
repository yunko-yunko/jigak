import './holiday-env';
import { openPrivateFile } from '../../src/common/engine/private-files';
import { link, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { joinPublicBusContexts, normalizeGhcnhPsv, roadPriorBundleSchema } from '../../src/common/engine/intelligence/historical-context';
import { HOLIDAY_AS_SUNDAY, reviewedKoreanHolidays } from '../../src/common/engine/intelligence/korean-holidays';

// JIGAK_DATA_ROOT: the automatic refresh's model store (local folder or the bucket mount); otherwise data/ under the working directory.
// Relative arguments are read from the working directory too: mvp when run through mvp's npm scripts (mvp/data as before), model-refresh here.
const project = process.cwd(), root = resolve(process.env.JIGAK_DATA_ROOT || resolve(project, 'data'));
const within = (base: string, path: string) => { const child = relative(base, path); return !!child && !child.startsWith('..') && !isAbsolute(child); };
async function inputFile(path: string, maximum: number, actualRoot: string): Promise<string> {
  const actual = await realpath(path);
  if (!within(actualRoot, actual)) throw new Error('path');
  const info = await stat(actual);
  if (!info.isFile() || info.size > maximum) throw new Error('size');
  const text = await readFile(actual, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new Error('size');
  return text;
}

/** Offline-only, deterministic join. It never reads credentials or changes an active model. */
export async function runPublicBusContextCli(args: string[]): Promise<void> {
  if (args.length !== 9 || args[0] !== '--input' || args[2] !== '--weather' || args[4] !== '--road-priors' || args[6] !== '--output' || args[8] !== '--execute') throw new Error('usage');
  const [input, weatherPath, priorPath, output] = [args[1], args[3], args[5], args[7]].map(path => resolve(project, path));
  if (![input, weatherPath, priorPath, output].every(path => within(root, path)) || !input.endsWith('.jsonl') || !output.endsWith('.jsonl')) throw new Error('path');
  const actualRoot = await realpath(root), actualParent = await realpath(dirname(output));
  if (actualParent !== actualRoot && !within(actualRoot, actualParent)) throw new Error('path');
  const [source, weatherText, priorText] = await Promise.all([
    inputFile(input, 512 * 1024 * 1024, actualRoot), inputFile(weatherPath, 16 * 1024 * 1024, actualRoot), inputFile(priorPath, 2 * 1024 * 1024, actualRoot),
  ]);
  const lines = source.split(/\r?\n/).filter(line => line.trim());
  if (!lines.length || lines.length > 500_000) throw new Error('rows');
  const rows = lines.map(line => JSON.parse(line)) as { version: number; startedAt: number }[];
  const bundle = roadPriorBundleSchema.parse(JSON.parse(priorText));
  const holidays = reviewedKoreanHolidays(), joined = joinPublicBusContexts(rows, normalizeGhcnhPsv(weatherText), bundle.archives, holidays);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = { version: 'public-bus-context-join-v2', policy: {
    weather: 'latest-usable-UTC-observation-at-or-before-start-within-3h; no-zero-imputation; original-publication-unknown',
    road: 'latest-published-complete-prior-month; weekday-saturday-sunday-KST-hour-with-public-and-substitute-holidays-as-sunday; citywide-distance-weighted-harmonic',
    weatherIsRetrospective: true, roadIsHistoricalPrior: true, fixedBeforeEvaluation: true,
  }, holidayCalendar: { rule: HOLIDAY_AS_SUNDAY, files: holidays.reviews.map(({ year, sha256 }) => ({ year, sha256 })) },
    sourceSha256: digest(source), weatherSha256: digest(weatherText), roadPriorSha256: digest(priorText), counts: joined.counts,
    roadArchives: bundle.archives.map(({ cells: _cells, ...metadata }) => metadata) };
  const destination = resolve(actualParent, basename(output)), manifestDestination = `${destination}.manifest.json`;
  const temporary = resolve(actualParent, `.context-join-${randomUUID()}.tmp`), temporaryManifest = `${temporary}.manifest`;
  const created: string[] = [];
  try {
    const file = await openPrivateFile(temporary);
    try { for (const row of joined.rows) await file.write(`${JSON.stringify(row)}\n`); await file.sync(); }
    finally { await file.close(); }
    const receipt = await openPrivateFile(temporaryManifest);
    try { await receipt.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await receipt.sync(); }
    finally { await receipt.close(); }
    // Atomic links refuse existing files and symlinks. Roll back only files created by this call.
    await link(temporaryManifest, manifestDestination); created.push(manifestDestination);
    await link(temporary, destination); created.push(destination);
  } catch (error) {
    for (const path of created) await rm(path, { force: true });
    throw error;
  } finally { await rm(temporary, { force: true }); await rm(temporaryManifest, { force: true }); }
  console.info(JSON.stringify({ version: manifest.version, counts: joined.counts, output: relative(project, destination),
    weatherAvailability: 'historical-publication-unknown', roadScope: 'seoul-citywide' }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void runPublicBusContextCli(process.argv.slice(2)).catch(() => {
  console.error('과거 문맥 조인을 완료하지 못했습니다. data/ 안의 입력과 새 출력, --input --weather --road-priors --output --execute 인자를 확인해 주세요. 입력 행과 오류 원문은 출력하지 않습니다.');
  process.exitCode = 1;
});
