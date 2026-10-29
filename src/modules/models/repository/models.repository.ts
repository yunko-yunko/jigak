import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { unconfiguredBus, unconfiguredBicycle } from '../domain/model-status.js';

@Injectable()
export class ModelsRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  bus() {
    return this.runtime.options.publicBus?.status() ?? unconfiguredBus();
  }

  bicycle() {
    return this.runtime.options.publicBicycleShadow?.status() ?? unconfiguredBicycle();
  }
}
