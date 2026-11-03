import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../../../common/errors.js';
import { isLegalKind, LEGAL_PAGE_CSP, legalPage } from '../domain/legal-page.js';

@Controller('legal')
export class LegalController {
  /** /api/legal/terms, privacy, location, licenses: public HTML for consent screens that need a URL. */
  @Get(':kind')
  page(@Param('kind') kind: string, @Res() response: Response) {
    if (!isLegalKind(kind)) throw new ApiError('INVALID_INPUT', '없는 문서예요.', 404);

    response.setHeader('Content-Security-Policy', LEGAL_PAGE_CSP);
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.type('html').send(legalPage(kind));
  }
}
