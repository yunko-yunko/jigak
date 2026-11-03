import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import { LegalModule } from '../src/modules/legal/legal.module.js';
import { ApiExceptionFilter } from '../src/common/http/api-exception.filter.js';
import { legalDocuments, POLICY_VERSION } from '../src/modules/legal/domain/legal-content.js';

test('the legal pages serve the consent text as public HTML and refuse unknown documents', async () => {
  const module = await Test.createTestingModule({ imports: [LegalModule] }).compile();
  const app = module.createNestApplication({ logger: false });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.listen(0, '127.0.0.1');

  try {
    const url = await app.getUrl();

    for (const kind of ['terms', 'privacy'] as const) {
      const response = await fetch(`${url}/api/legal/${kind}`);
      const html = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html; charset=utf-8/);
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.ok(html.includes(`<title>${legalDocuments[kind].title} · 지각지도</title>`));
      assert.ok(html.includes(`시행일 ${POLICY_VERSION}`));
      // Every section reaches the page; quotes in the text are escaped, not dropped.
      for (const section of legalDocuments[kind].sections) {
        assert.ok(html.includes(section.title.replace(/'/g, '&#39;')), section.title);
      }
    }

    assert.ok(
      (await (await fetch(`${url}/api/legal/terms`)).text()).includes(
        '&#39;시연용 가상 데이터&#39;',
      ),
    );

    const missing = await fetch(`${url}/api/legal/marketing`);

    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'INVALID_INPUT');
  } finally {
    await app.close();
  }
});
