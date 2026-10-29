import { Module } from '@nestjs/common';
import { RoutingController } from './controller/routing.controller.js';
import { RoutingService } from './service/routing.service.js';
import { RouteRepository } from './repository/route.repository.js';

@Module({
  controllers: [RoutingController],
  providers: [RoutingService, RouteRepository],
})
export class RoutingModule {}
