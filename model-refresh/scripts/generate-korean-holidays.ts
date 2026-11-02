/**
 * holidays:refresh — this year's and next year's korea-holidays-YYYY.json into the model store.
 * Official source: KASI 특일 정보 getRestDeInfo (DATA_GO_KR_SERVICE_KEY, needs the data.go.kr 활용신청).
 * Without it, an officially sourced file is extended 30 days only when the Google Korean holiday calendar agrees.
 *   npm run holidays:refresh -- --store DIR [--plan] [--sync-repo-calendars]
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from './models-refresh';

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(['holidays', ...process.argv.slice(2)]).then(code => { process.exitCode = code; }, error => {
    process.stdout.write(JSON.stringify({ severity: 'ERROR', event: 'holidays-refresh-crashed', reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }) + '\n');
    process.exitCode = 1;
  });
}
