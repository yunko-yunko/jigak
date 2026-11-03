import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { LegalModule } from '../src/modules/legal/legal.module.js';
import { ApiExceptionFilter } from '../src/common/http/api-exception.filter.js';
import { serveSite } from '../src/common/http/site.js';

test('the website is served at / next to the API without shadowing /api', async () => {
  const module = await Test.createTestingModule({ imports: [LegalModule] }).compile();
  const app = module.createNestApplication({ logger: false });

  serveSite(app);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');

  try {
    const url = await app.getUrl();

    const home = await fetch(`${url}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(home.headers.get('cache-control'), 'no-cache');
    assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.ok((await home.text()).includes('지각지도'));

    // Extensionless legal links resolve to the generated pages.
    const terms = await fetch(`${url}/legal/terms`);
    assert.equal(terms.status, 200);
    assert.ok((await terms.text()).includes('이용약관'));

    const style = await fetch(`${url}/styles.css`);
    assert.equal(style.status, 200);
    assert.equal(style.headers.get('cache-control'), 'public, max-age=3600');

    // The API keeps its own routes and JSON errors.
    const api = await fetch(`${url}/api/legal/terms`);
    assert.equal(api.status, 200);
    assert.match(api.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal((await fetch(`${url}/api/legal/marketing`)).status, 404);

    assert.equal((await fetch(`${url}/build-legal.mjs`)).status, 404);
    assert.equal((await fetch(`${url}/nothing-here`)).status, 404);
  } finally {
    await app.close();
  }
});
