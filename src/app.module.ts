import { Module } from '@nestjs/common';
import { DatabaseModule } from './common/database/database.module.js';
import { RuntimeModule } from './common/providers/runtime.module.js';
import { RateLimitService } from './common/http/rate-limit.service.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { LearningModule } from './modules/learning/learning.module.js';
import { RoutingModule } from './modules/routing/routing.module.js';
import { PlacesModule } from './modules/places/places.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ModelsModule } from './modules/models/models.module.js';
import { TravelTimesModule } from './modules/travel-times/travel-times.module.js';
import { SimulationModule } from './modules/simulation/simulation.module.js';
import { MapsModule } from './modules/maps/maps.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    LearningModule,
    RuntimeModule,
    RoutingModule,
    PlacesModule,
    RealtimeModule,
    HealthModule,
    ModelsModule,
    TravelTimesModule,
    SimulationModule,
    MapsModule,
  ],
  providers: [RateLimitService],
})
export class AppModule {}
