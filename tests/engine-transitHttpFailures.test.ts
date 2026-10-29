// Preserved regression cases from perception-map/mvp/tests/transitHttpFailures.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedError, fetchFeedJson } from '../src/common/engine/realtime/http.js';

test('a rejected credential releases the response body and never exposes the request key', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const url = new URL('https://feed.example/?serviceKey=private-fixture');

  await assert.rejects(
    fetchFeedJson(url, {
      fetcher: async () =>
        new Response(body, {
          status: 401,
        }),
    }),
    (error) => {
      assert.ok(error instanceof FeedError);
      assert.equal(error.reason, 'auth');
      assert.equal(error.message.includes('private-fixture'), false);

      return true;
    },
  );
  assert.equal(cancelled, true);
});
