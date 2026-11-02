import { createHash } from 'node:crypto';
import type { PublicBusModelObservation } from '../../../src/common/engine/intelligence/public-bus-model';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function publicBusTrainingObservations(serviceWindowStart = '2026-09-28'): PublicBusModelObservation[] {
  const rows: PublicBusModelObservation[] = [];
  for (let day = 0; day < 14; day++) {
    const date = new Date(Date.parse(`${serviceWindowStart}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10);
    for (let index = 0; index < 1500; index++) {
      const startedAt = Date.parse(`${date}T04:00:00+09:00`) + Math.floor(index / 3) * 120_000;
      const hour = new Date(startedAt + 9 * 3600_000).getUTCHours();
      const distanceMeters = 2000 + (index % 8) * 1000;
      const actualSeconds = 60 * (distanceMeters / 1000) ** 2;
      const suffix = `${day}-${index}`;
      rows.push({ version: 2, id: `bus_obs_${hash(suffix)}`, groupId: `bus_run_${hash(suffix)}`, vehicleGroup: `bus_vehicle_${hash(String(index))}`,
        odGroup: `bus_od_${hash(day >= 13 && index % 2 ? `future-${index}` : String(index % 100))}`, source: 'seoul-tdata-card', sourceDate: date,
        sourceArchiveSha256: hash(date), target: 'bus-tag-elapsed', startedAt, observedAt: startedAt + actualSeconds * 1000, actualSeconds,
        uncertaintySeconds: 60, distanceMeters, transportCode: '115', routeId: String(index % 20), routeNumber: String(100 + index % 20),
        fromStopId: 'from', toStopId: 'to', fromOrder: 1, toOrder: 5, fromLatitude: 37.5, fromLongitude: 127, toLatitude: 37.53, toLongitude: 127.01,
        pathStopCoordinates: [{ latitude: 37.5, longitude: 127 }, { latitude: 37.53, longitude: 127.01 }], weather: null, roadPrior: null });
    }
  }
  return rows;
}
