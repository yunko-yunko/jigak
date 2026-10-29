import type { INestApplication } from '@nestjs/common';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { validateEnvironment } from '../config/environment.js';
import { ApiExceptionFilter } from './api-exception.filter.js';
import { RateLimitService } from './rate-limit.service.js';
import { ApiError } from '../errors.js';

/** Also used by HTTP integration tests; Nest is created with bodyParser:false. */
export function configureApplication(app: INestApplication, env: NodeJS.ProcessEnv = process.env) {
  const config = validateEnvironment(env);
  const server = app.getHttpAdapter().getInstance();

  server.disable('x-powered-by');
  server.set('trust proxy', config.TRUST_PROXY_HOPS || false);

  const allowed = new Set([...config.origins, new URL(config.AUTH_WEB_RETURN_URL).origin]);

  app.use((request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const origin = request.get('origin');
    const appleForm =
      request.method === 'POST' &&
      /^\/api\/auth\/apple\/callback\/?$/.test(request.path) &&
      request.is('application/x-www-form-urlencoded');
    if (origin && !appleForm) {
      if (!allowed.has(origin)) {
        next(
          new ApiError(
            'INVALID_INPUT',
            '이 브라우저 주소는 CORS_ORIGINS 설정에 추가해야 해요.',
            403,
          ),
        );

        return;
      }

      response.setHeader('Access-Control-Allow-Origin', origin);
      response.vary('Origin');
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
    }

    if (request.method === 'OPTIONS') {
      response.status(204).end();

      return;
    }

    next();
  });

  const limiter = app.get(RateLimitService, {
    strict: false,
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    void limiter.consume(request, response, next);
  });

  app.use(
    '/api/traffic/route',
    express.json({
      limit: '600kb',
    }),
  );
  app.use(
    '/api/learning',
    express.json({
      limit: '200kb',
    }),
  );
  app.use(
    '/api/auth',
    express.urlencoded({
      extended: false,
      limit: '12kb',
    }),
  );
  app.use(
    express.json({
      limit: '16kb',
    }),
  );

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());

  return config;
}
