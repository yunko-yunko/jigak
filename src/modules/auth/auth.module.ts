import { Module } from '@nestjs/common';
import { AuthController } from './controller/auth.controller.js';
import { AuthRepository } from './repository/auth.repository.js';
import { AuthService } from './service/auth.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthRepository, AuthService],
  exports: [AuthRepository, AuthService],
})
export class AuthModule {}
