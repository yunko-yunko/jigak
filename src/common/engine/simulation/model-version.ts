import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { ASSUMPTIONS, SIM_MODEL_REVISION } from './assumptions.js';
import { dataFile } from './calendar.js';
import type { Demand } from './demand.js';
import { footWeightsIdentity } from './foot-traffic.js';
import type { GeometryMeta } from './parking-rules.js';

/**
 * Identity of a bundled table by its bytes, hashed in 64 KB chunks: the rule table and door
 * points (§20) are too large to decode on the main thread just to name them. 'missing' when the
 * file cannot be read.
 */
export function tableIdentity(name: string): string {
  let handle = -1;
  try {
    handle = openSync(dataFile(name), 'r');
    const hash = createHash('sha256'),
      chunk = Buffer.alloc(65_536);
    for (let read = readSync(handle, chunk); read > 0; read = readSync(handle, chunk))
      hash.update(chunk.subarray(0, read));
    return hash.digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  } finally {
    if (handle >= 0) closeSync(handle);
  }
}

/**
 * §11.1 model version: the assumption table, the model code revision, the Node major.minor
 * (Math.exp/log may differ between releases) and the identity of the bundled tables. Instances
 * with the same version compute the same windows; permissions of another version are refused.
 */
export function computeModelVersion(
  inputs: { demand: Demand; geometry: GeometryMeta; tables?: readonly string[] },
  assumptions: unknown = ASSUMPTIONS,
  revision = SIM_MODEL_REVISION,
  node = process.versions.node.split('.').slice(0, 2).join('.'),
): string {
  const { demand, geometry } = inputs;
  // The rule table, door points and foot-traffic weights shape every placement (§20, §22), so
  // their identity counts too; the weights by the file actually read (MOBILITY_FOOT_WEIGHTS_PATH).
  const placement = inputs.tables ?? [
    tableIdentity('shared-mobility-return-rules-v1.json'),
    tableIdentity('shared-mobility-door-points-v1.json'),
    footWeightsIdentity(),
  ];
  const tables = [
    demand.count,
    demand.odTo.length,
    demand.loopShare,
    Math.round(demand.dailyRentals.weekday),
    Math.round(demand.dailyRentals.weekend),
    geometry.version,
    geometry.builtAt,
    geometry.busStops,
    geometry.subwayExits,
    geometry.crosswalks,
    geometry.subwayKind,
    ...placement,
  ];
  return createHash('sha256')
    .update(JSON.stringify(assumptions))
    .update('|')
    .update(revision)
    .update('|')
    .update(node)
    .update('|')
    .update(JSON.stringify(tables))
    .digest('hex')
    .slice(0, 12);
}
