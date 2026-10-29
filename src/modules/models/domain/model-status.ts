export const unconfiguredBus = () => ({
  version: 'public-bus-duration-v2',
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
