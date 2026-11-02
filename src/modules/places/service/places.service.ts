import { Inject, Injectable } from '@nestjs/common';
import { PlacesRepository } from '../repository/places.repository.js';
import { PlaceFinder } from '../domain/place-search.js';
import { placeQuerySchema, pointQuerySchema } from '../dto/places.dto.js';
import { parseDto } from '../../../common/dto/parse.js';

@Injectable()
export class PlacesService {
  private readonly finder: PlaceFinder;

  constructor(@Inject(PlacesRepository) private readonly places: PlacesRepository) {
    this.finder = new PlaceFinder({ search: (query) => this.places.search(query) });
  }

  async search(query: unknown) {
    const input = parseDto(placeQuerySchema, query);
    if (this.places.usesLocalCatalogue) {
      return this.finder.local(input);
    }

    return this.finder.find(input);
  }

  async reverse(query: unknown) {
    const point = parseDto(pointQuerySchema, query);

    return {
      place: await this.places.reverse(point),
      generatedAt: Date.now(),
    };
  }
}
