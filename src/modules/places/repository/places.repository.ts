import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { ApiError } from '../../../common/errors.js';

@Injectable()
export class PlacesRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  search(query: { q: string; latitude?: number; longitude?: number }) {
    return this.runtime.options.provider.searchPlaces(query);
  }

  async reverse(point: { latitude: number; longitude: number }) {
    const provider = this.runtime.options.provider;
    if (!provider.configured || !provider.reverseGeocode) {
      throw new ApiError('LIVE_NOT_CONFIGURED', '주소 변환을 사용할 수 없어요.', 503);
    }

    return provider.reverseGeocode(point);
  }
}
