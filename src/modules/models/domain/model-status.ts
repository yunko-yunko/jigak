import { PUBLIC_BUS_MODEL_VERSION } from '../../../common/engine/intelligence/public-bus-model.js';

export const unconfiguredBus = () => ({
  version: PUBLIC_BUS_MODEL_VERSION,
  active: false,
  reasons: ['unconfigured'],
});

export const unconfiguredBicycle = () => ({
  version: 'seoul-bicycle-spatial-v1',
  available: false,
  active: false,
  deployment: 'shadow',
  reasons: ['unconfigured'],
});
