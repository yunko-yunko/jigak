import { Inject, Injectable } from '@nestjs/common';
import { parseDto } from '../../../common/dto/parse.js';
import { ApiError } from '../../../common/errors.js';
import type {
  EventTypeName,
  VehicleTypeName,
} from '../../../common/engine/simulation/sim-codes.js';
import { SimulationRepository } from '../repository/simulation.repository.js';
import { eventsQuerySchema, vehicleStatusQuerySchema } from '../dto/simulation.dto.js';
import {
  gbfsDiscovery,
  gbfsDiscoveryBase,
  gbfsSystemInformation,
  gbfsVehicleStatusBody,
  gbfsVehicleTypes,
} from '../domain/gbfs-feed.js';

/**
 * Read-only views of the demo kick-scooter and e-bike simulator (시연용 가상 데이터), never a
 * real operator.
 */
@Injectable()
export class SimulationService {
  constructor(@Inject(SimulationRepository) private readonly repository: SimulationRepository) {}

  private enabled() {
    const simulation = this.repository.simulation;

    if (!simulation) {
      throw new ApiError('NO_ROUTES', '시연용 가상 킥보드·전기자전거가 꺼져 있어요.', 404);
    }

    return simulation;
  }

  status() {
    return this.enabled().status(this.repository.now());
  }

  events(query: unknown) {
    const simulation = this.enabled();
    const input = parseDto(eventsQuerySchema, query, '사건 조회 조건을 확인해 주세요.');

    return simulation.events(
      {
        since: input.since,
        cursor: input.cursor,
        limit: input.limit,
        types: input.types as EventTypeName[] | undefined,
        vehicleTypes: input.vehicleTypes as VehicleTypeName[] | undefined,
        latitude: input.lat,
        longitude: input.lon,
        radius: input.radius,
      },
      this.repository.now(),
    );
  }

  crews() {
    return this.enabled().crews(this.repository.now());
  }

  discovery(requestOrigin: string, requestPath: string) {
    this.enabled();

    return gbfsDiscovery(
      gbfsDiscoveryBase(requestOrigin, requestPath, this.repository.publicBaseUrl),
      this.repository.now(),
    );
  }

  systemInformation() {
    const simulation = this.enabled();

    return gbfsSystemInformation(this.repository.now(), simulation);
  }

  vehicleTypes() {
    return gbfsVehicleTypes(this.repository.now(), this.enabled());
  }

  vehicleStatus(query: unknown) {
    const simulation = this.enabled();
    const input = parseDto(vehicleStatusQuerySchema, query, '위치와 반경을 확인해 주세요.');

    return gbfsVehicleStatusBody(
      simulation,
      this.repository.now(),
      input.lat === undefined || input.lon === undefined
        ? undefined
        : { latitude: input.lat, longitude: input.lon, radius: input.radius ?? 1000 },
    );
  }
}
