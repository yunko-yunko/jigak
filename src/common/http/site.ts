import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';

/** site/ sits at the package root: three levels up from src/common/http and from dist/common/http. */
export const SITE_DIR = fileURLToPath(new URL('../../../site/', import.meta.url));

// The landing and legal pages load Pretendard from jsDelivr; the legal tabs have one inline script.
export const SITE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  'font-src https://cdn.jsdelivr.net',
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Serves the static website at / (index.html, /legal/terms, ...). /api stays with Nest. */
export function serveSite(app: INestApplication, directory = SITE_DIR) {
  if (!existsSync(directory)) return;

  const files = express.static(directory, {
    extensions: ['html'],
    fallthrough: true,
    redirect: false,
    setHeaders(response, path) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.setHeader('Content-Security-Policy', SITE_CSP);
      // HTML revalidates so a deploy shows at once; styles and scripts carry ?v= and images rarely change.
      response.setHeader(
        'Cache-Control',
        path.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
      );
    },
  });

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.path === '/api' || request.path.startsWith('/api/')) return next();
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    // build-legal.mjs is a source file, not a page.
    if (request.path.endsWith('.mjs')) return next();

    files(request, response, next);
  });
}
