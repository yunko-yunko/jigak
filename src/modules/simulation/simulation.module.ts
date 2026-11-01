import { Module } from '@nestjs/common';
import { SimulationController } from './controller/simulation.controller.js';
import { SimulationService } from './service/simulation.service.js';
import { SimulationRepository } from './repository/simulation.repository.js';

/** Demo kick-scooter simulator views; every route answers 404 while the simulator is off. */
@Module({
  controllers: [SimulationController],
  providers: [SimulationService, SimulationRepository],
})
export class SimulationModule {}
