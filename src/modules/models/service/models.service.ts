import { Inject, Injectable } from '@nestjs/common';
import { ModelsRepository } from '../repository/models.repository.js';

@Injectable()
export class ModelsService {
  constructor(@Inject(ModelsRepository) private readonly models: ModelsRepository) {}

  bus() {
    return this.models.bus();
  }

  bicycle() {
    return this.models.bicycle();
  }
}
