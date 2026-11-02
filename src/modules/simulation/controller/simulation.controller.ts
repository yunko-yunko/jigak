import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SimulationService } from '../service/simulation.service.js';

@Controller('sim')
export class SimulationController {
  constructor(@Inject(SimulationService) private readonly simulation: SimulationService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return this.simulation.status();
  }

  @Get('events')
  @Header('Cache-Control', 'no-store')
  events(@Query() query: unknown) {
    return this.simulation.events(query);
  }

  @Get('crews')
  @Header('Cache-Control', 'no-store')
  crews() {
    return this.simulation.crews();
  }

  @Get('gbfs/gbfs.json')
  @Header('Cache-Control', 'no-store')
  discovery(@Req() request: Request) {
    return this.simulation.discovery(
      `${request.protocol}://${request.get('host')}`,
      request.originalUrl,
    );
  }

  @Get('gbfs/system_information.json')
  @Header('Cache-Control', 'no-store')
  systemInformation() {
    return this.simulation.systemInformation();
  }

  @Get('gbfs/vehicle_types.json')
  @Header('Cache-Control', 'no-store')
  vehicleTypes() {
    return this.simulation.vehicleTypes();
  }

  // The document is serialized once a minute and sent as it is.
  @Get('gbfs/vehicle_status.json')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  vehicleStatus(@Query() query: unknown) {
    return this.simulation.vehicleStatus(query);
  }
}
