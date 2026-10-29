import { z } from 'zod';
import { pointQuerySchema } from '../../routing/dto/routing.dto.js';
export {
  pointQuerySchema,
  arrivalsSchema,
  routeLegsSchema,
} from '../../routing/dto/routing.dto.js';

export const mobilityQuerySchema = pointQuerySchema.extend({
  radius: z.coerce.number().finite().min(100).max(5000).default(1200),
});
