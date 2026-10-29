import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from '../service/auth.service.js';

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('auth/providers')
  providers() {
    return this.auth.providers();
  }

  @Get('auth/:provider/start')
  async start(
    @Param('provider') provider: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.auth.limit(request, response);

    const url = await this.auth.start(provider, request.query);

    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(302, url);
  }

  @Get('auth/:provider/callback')
  async callbackGet(
    @Param('provider') provider: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.auth.limit(request, response);

    const url = await this.auth.callback(provider, request.query);

    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(303, url);
  }

  @Post('auth/:provider/callback')
  async callbackPost(
    @Param('provider') provider: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.auth.limit(request, response);

    const url = await this.auth.callback(provider, request.body);

    response.setHeader('Referrer-Policy', 'no-referrer');
    response.redirect(303, url);
  }

  @Post('auth/exchange')
  @HttpCode(200)
  async exchange(
    @Req() request: Request,
    @Res({
      passthrough: true,
    })
    response: Response,
  ) {
    await this.auth.limit(request, response);

    return this.auth.exchange(request, response);
  }

  @Get('auth/me')
  me(@Req() request: Request) {
    return this.auth.me(request);
  }

  @Patch('auth/me')
  updateName(@Req() request: Request) {
    return this.auth.updateName(request);
  }

  @Post('auth/consents')
  @HttpCode(200)
  consents(@Req() request: Request) {
    return this.auth.consents(request);
  }

  @Get('auth/sessions')
  sessions(@Req() request: Request) {
    return this.auth.sessions(request);
  }

  @Delete('auth/sessions/:id')
  revokeSession(
    @Req() request: Request,
    @Res({
      passthrough: true,
    })
    response: Response,
    @Param('id') id: string,
  ) {
    return this.auth.revokeSession(request, response, id);
  }

  @Post('auth/logout')
  @HttpCode(200)
  logout(
    @Req() request: Request,
    @Res({
      passthrough: true,
    })
    response: Response,
  ) {
    return this.auth.logout(request, response);
  }

  @Delete('auth/account')
  async deleteAccount(
    @Req() request: Request,
    @Res({
      passthrough: true,
    })
    response: Response,
  ) {
    await this.auth.limit(request, response);

    return this.auth.deleteAccount(request, response);
  }

  @Get('account/preferences')
  preferences(@Req() request: Request) {
    return this.auth.preferences(request);
  }

  @Patch('account/preferences')
  savePreferences(@Req() request: Request) {
    return this.auth.savePreferences(request);
  }

  @Get('account/trips')
  trips(@Req() request: Request) {
    return this.auth.trips(request);
  }

  @Put('account/trips')
  saveTrips(@Req() request: Request) {
    return this.auth.saveTrips(request);
  }

  @Post('support')
  async support(
    @Req() request: Request,
    @Res({
      passthrough: true,
    })
    response: Response,
  ) {
    await this.auth.limit(request, response);

    return this.auth.support(request);
  }
}
