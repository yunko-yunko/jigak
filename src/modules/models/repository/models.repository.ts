import { Inject, Injectable } from '@nestjs/common';
import { RuntimeRepository } from '../../../common/providers/runtime.repository.js';
import { unconfiguredBus, unconfiguredBicycle } from '../domain/model-status.js';
import { modelRefreshSummary, servedModelStatuses } from '../../health/domain/model-refresh.js';

@Injectable()
export class ModelsRepository {
  constructor(@Inject(RuntimeRepository) private readonly runtime: RuntimeRepository) {}

  bus() {
    return this.runtime.options.publicBus?.status() ?? unconfiguredBus();
  }

  all() {
    const options = this.runtime.options;
    return { ...servedModelStatuses(options), modelRefresh: modelRefreshSummary(options) };
  }

  refresh() {
    return modelRefreshSummary(this.runtime.options);
  }

  bicycle() {
    return this.runtime.options.publicBicycleShadow?.status() ?? unconfiguredBicycle();
  }
}
