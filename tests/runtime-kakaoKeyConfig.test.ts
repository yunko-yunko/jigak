import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeRepository } from '../src/common/providers/runtime.repository.js';
import type { LearningService } from '../src/modules/learning/service/learning.service.js';

const PRIMARY = 'primary-test-key';
const SUB = 'sub-test-key';
const LEGACY = 'legacy-test-key';

for (const { name, env, spare } of [
  {
    name: 'SUB supplies the spare key',
    env: { KAKAO_REST_API_KEY_SUB: SUB },
    spare: SUB,
  },
  {
    name: 'trimmed SUB takes precedence over the legacy FALLBACK variable',
    env: { KAKAO_REST_API_KEY_SUB: `  ${SUB}  `, KAKAO_REST_API_KEY_FALLBACK: LEGACY },
    spare: SUB,
  },
  {
    name: 'legacy FALLBACK remains supported when SUB is absent',
    env: { KAKAO_REST_API_KEY_FALLBACK: LEGACY },
    spare: LEGACY,
  },
  {
    name: 'blank SUB preserves the legacy FALLBACK key',
    env: { KAKAO_REST_API_KEY_SUB: '   ', KAKAO_REST_API_KEY_FALLBACK: LEGACY },
    spare: LEGACY,
  },
]) {
  test(`runtime Kakao configuration: ${name}`, async (t) => {
    const originalEnv = process.env;
    process.env = { NODE_ENV: 'test', DB_PASSWORD: 'test', KAKAO_REST_API_KEY: PRIMARY, ...env };
    t.after(() => {
      process.env = originalEnv;
    });
    t.mock.method(console, 'warn', () => undefined);

    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
      assert.equal(new URL(String(input)).pathname, '/v2/local/search/keyword.json');
      const authorization = new Headers(init?.headers).get('Authorization')!;
      calls.push(authorization);
      return authorization === `KakaoAK ${PRIMARY}`
        ? new Response('', { status: 429 })
        : Response.json({ documents: [] });
    });

    const { provider } = new RuntimeRepository({} as LearningService).options;
    assert.deepEqual(await provider.searchPlaces({ q: '서울역' }), []);
    assert.deepEqual(await provider.searchPlaces({ q: '강남역' }), []);
    assert.deepEqual(calls, [`KakaoAK ${PRIMARY}`, `KakaoAK ${spare}`, `KakaoAK ${spare}`]);
  });
}
