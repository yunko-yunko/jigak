import { Inject, Injectable } from '@nestjs/common';
import { ModelsRepository } from '../repository/models.repository.js';

@Injectable()
export class ModelsService {
  constructor(@Inject(ModelsRepository) private readonly models: ModelsRepository) {}

  bus() {
    return this.models.bus();
  }

  all() {
    return this.models.all();
  }

  refresh() {
    return this.models.refresh();
  }

  bicycle() {
    return this.models.bicycle();
  }
}
