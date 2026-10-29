import { Inject, Injectable } from '@nestjs/common';
import { PlacesRepository } from '../repository/places.repository.js';
import { placeSearchResult } from '../domain/place-search.js';
import { placeQuerySchema, pointQuerySchema } from '../dto/places.dto.js';
import { parseDto } from '../../../common/dto/parse.js';

@Injectable()
export class PlacesService {
  constructor(@Inject(PlacesRepository) private readonly places: PlacesRepository) {}

  async search(query: unknown) {
    const input = parseDto(placeQuerySchema, query);

    return placeSearchResult(
      await this.places.search(input),
      input.latitude !== undefined,
      Date.now(),
    );
  }

  async reverse(query: unknown) {
    const point = parseDto(pointQuerySchema, query);

    return {
      place: await this.places.reverse(point),
      generatedAt: Date.now(),
    };
  }
}
