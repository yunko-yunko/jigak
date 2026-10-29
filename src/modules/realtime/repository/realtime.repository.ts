import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { routeTraffic } from '../../../common/engine/realtime/routeTraffic.js';
import { arrivalsSchema, routeLegsSchema } from '../dto/realtime.dto.js';
import { arrivalSnapshot } from '../domain/arrival-snapshot.js';

type Point = {
  latitude: number;
  longitude: number;
};

@Injectable()
export class RealtimeRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  mobility(point: Point, radius: number) {
    return this.runtime.options.mobility.snapshot(point, radius);
  }

  nearby(point: Point) {
    return this.runtime.options.nearbyTransit.snapshot(point);
  }

  conditions(point: Point) {
    return this.runtime.options.weather.conditions(point);
  }

  async arrivals(input: z.infer<typeof arrivalsSchema>) {
    const r = this.runtime.options.realtime;

    return arrivalSnapshot(
      await Promise.all(input.boardings.map((b) => r.lookup(b))),
      r.capabilities,
      r.diagnostics,
      Date.now(),
    );
  }

  traffic(input: z.infer<typeof routeLegsSchema>) {
    return routeTraffic(input.legs, this.runtime.options.traffic, Date.now());
  }
}
