import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  EnvironmentConfigurationError,
  validateEnvironment,
} from '../src/common/config/environment.js';
import { startupFailure } from '../src/common/startup-diagnostics.js';

const production = {
  NODE_ENV: 'production',
  DB_PASSWORD: 'test-database-password',
  AUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  AUTH_PUBLIC_BASE_URL: 'https://api.example.test',
  AUTH_WEB_RETURN_URL: 'https://api.example.test/',
  CORS_ORIGINS: '',
};

test('native-only production accepts an explicitly empty CORS origin list', () => {
  const config = validateEnvironment(production);

  assert.deepEqual(config.origins, []);
  assert.equal(config.AUTH_PUBLIC_BASE_URL, production.AUTH_PUBLIC_BASE_URL);
});

test('invalid deployment settings identify fields without logging their values', () => {
  const cases = [
    { field: 'AUTH_TOKEN_ENCRYPTION_KEY', value: 'private-invalid-key' },
    { field: 'CORS_ORIGINS', value: 'https://app.example.test/' },
    { field: 'CORS_ORIGINS', value: 'https://user:private-url-secret@app.example.test' },
    { field: 'CORS_ORIGINS', value: undefined },
    { field: 'AUTH_PUBLIC_BASE_URL', value: '' },
    { field: 'AUTH_WEB_RETURN_URL', value: 'http://localhost:8081/' },
    { field: 'DB_PASSWORD', value: undefined },
  ];

  for (const { field, value } of cases) {
    assert.throws(
      () => validateEnvironment({ ...production, [field]: value }),
      (error: unknown) => {
        assert.ok(error instanceof EnvironmentConfigurationError);

        const diagnostic = startupFailure(error, 'configuration');

        assert.deepEqual(diagnostic.fields, [field]);
        assert.equal(diagnostic.severity, 'ERROR');
        assert.doesNotMatch(JSON.stringify(diagnostic), /private-invalid-key|private-url-secret/);

        return true;
      },
    );
  }
});

test('database diagnostics retain actionable codes without driver messages or query parameters', () => {
  for (const code of ['28P01', '3D000', '42501', '42P01', 'ECONNREFUSED']) {
    const error = Object.assign(new Error('private-query-error'), {
      query: 'private-query',
      parameters: ['private-token'],
      driverError: { code, message: 'private-database-password' },
    });
    const diagnostic = startupFailure(error, 'application-initialization');

    assert.equal(diagnostic.code, code);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-/);

    if (code === '42P01') {
      assert.match(diagnostic.message, /시작 마이그레이션/);
    }
  }
});

test('unknown startup failures never log arbitrary error content', () => {
  const errors = [
    new Error('postgres://user:private-password@private-host/database'),
    { code: 'private-code', message: 'private-message', stack: 'private-stack' },
    { code: '__proto__' },
    null,
    'private-string',
  ];

  for (const error of errors) {
    const diagnostic = startupFailure(error, 'dependency-initialization');

    assert.equal(diagnostic.event, 'startup-failed');
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-|__proto__/);
    assert.equal(diagnostic.code, undefined);
  }

  assert.equal(startupFailure({ code: 'ETIMEDOUT' }, 'listen').code, 'ETIMEDOUT');
});

test('compiled API and migration entrypoints report configuration errors and exit with code 1', async (t) => {
  const entrypoints = ['main.js', 'common/database/migrate.js'];

  for (const entrypoint of entrypoints) {
    const path = fileURLToPath(new URL('../dist/' + entrypoint, import.meta.url));

    try {
      await access(path);
    } catch {
      t.skip('npm run build must precede compiled startup verification');

      return;
    }

    for (const field of ['AUTH_TOKEN_ENCRYPTION_KEY', 'CORS_ORIGINS']) {
      const child = spawnSync(process.execPath, [path], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ...production,
          [field]: field === 'CORS_ORIGINS' ? 'https://app.example.test/' : 'private-invalid-key',
        },
      });

      assert.ifError(child.error);
      assert.equal(child.status, 1);

      const diagnostic = JSON.parse(child.stderr.trim());

      assert.equal(diagnostic.event, 'startup-failed');
      assert.deepEqual(diagnostic.fields, [field]);
      assert.doesNotMatch(
        child.stderr + child.stdout,
        /private-invalid-key|test-database-password/,
      );
    }
  }
});
