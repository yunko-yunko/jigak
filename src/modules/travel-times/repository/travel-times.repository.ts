import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { withPedestrianRouting } from '../../../common/engine/connectivity/provider.js';
import { TimeComparisonService } from '../../../common/engine/intelligence/time-comparison-service.js';
import type { TravelTimeRequest } from '../../../common/shared/intelligence/travelTime.js';

@Injectable()
export class TravelTimesRepository {
  private readonly comparison: TimeComparisonService | null;

  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {
    const options = runtime.options,
      baseProvider = options.provider;

    this.comparison = options.travelTimes
      ? new TimeComparisonService({
          estimates: options.travelTimes,
          provider: baseProvider.configured
            ? baseProvider
            : withPedestrianRouting(baseProvider, options.pedestrian, {
                cycling: options.cycling,
              }),
          realtime: options.realtime,
        })
      : null;
  }

  get configured() {
    return !!this.comparison;
  }

  estimate(input: TravelTimeRequest) {
    return this.comparison!.estimate(input);
  }
}
