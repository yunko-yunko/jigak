import { z } from 'zod';
import { EVENT_TYPES, VEHICLE_TYPE_NAMES } from '../../../common/engine/simulation/sim-codes.js';

/** Optional area filter; a radius alone or half a point is rejected. */
export const vehicleStatusQuerySchema = z
  .object({
    lat: z.coerce.number().finite().min(-90).max(90).optional(),
    lon: z.coerce.number().finite().min(-180).max(180).optional(),
    radius: z.coerce.number().finite().min(50).max(5000).optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.lat === undefined) === (query.lon === undefined) &&
      (query.radius === undefined || query.lat !== undefined),
  );

const eventTypes = new Set<string>(EVENT_TYPES);
const vehicleTypes = new Set<string>(VEHICLE_TYPE_NAMES);

/**
 * §15.2 event log query. `since` is exclusive; `cursor` continues after an event id instead and
 * cannot be combined with it. `types` is a comma list of §14 types and `vehicleTypes` one of
 * `kick-scooter`, `e-bike` (§19); unknown names are rejected.
 */
export const eventsQuerySchema = z
  .object({
    since: z.coerce.number().int().min(0).max(8.64e15).optional(),
    cursor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}:\d{6,9}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    types: z
      .string()
      .max(2_000)
      .transform((value) => value.split(',').map((type) => type.trim()))
      .refine((types) => types.length > 0 && types.every((type) => eventTypes.has(type)))
      .optional(),
    vehicleTypes: z
      .string()
      .max(100)
      .transform((value) => value.split(',').map((type) => type.trim()))
      .refine((types) => types.length > 0 && types.every((type) => vehicleTypes.has(type)))
      .optional(),
    lat: z.coerce.number().finite().min(-90).max(90).optional(),
    lon: z.coerce.number().finite().min(-180).max(180).optional(),
    radius: z.coerce.number().int().min(1).max(5000).optional(),
  })
  .strict()
  .refine(
    (query) =>
      (query.lat === undefined) === (query.lon === undefined) &&
      (query.radius === undefined || query.lat !== undefined) &&
      !(query.since !== undefined && query.cursor !== undefined),
  );
