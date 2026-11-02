import { z } from 'zod';
import { pointQuerySchema } from '../../routing/dto/routing.dto.js';
export {
  pointQuerySchema,
  arrivalsSchema,
  routeLegsSchema,
} from '../../routing/dto/routing.dto.js';

export const subwayLineQuerySchema = z
  .object({
    line: z.string().trim().min(1).max(30),
    station: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

const MOBILITY_KINDS = ['bicycle', 'e-bicycle', 'kick-scooter', 'motor-scooter'] as const;

export const mobilityQuerySchema = pointQuerySchema.extend({
  radius: z.coerce.number().finite().min(100).max(5000).default(1200),
  /** Markers in all; 1,000 when omitted (what older apps accept). */
  limit: z.coerce.number().int().min(1).max(2500).optional(),
  /** Comma-separated kinds, e.g. `e-bicycle,kick-scooter`; every kind when omitted. */
  kinds: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((value) => [...new Set(value.split(',').map((kind) => kind.trim()))])
    .pipe(z.array(z.enum(MOBILITY_KINDS)).min(1).max(MOBILITY_KINDS.length))
    .optional(),
});
