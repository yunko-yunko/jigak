import { z } from 'zod';

const stamp = z.number().int().positive();

export const subwayLineViewSchema = z.object({
  line: z.string().min(1).max(40),
  lineId: z.string().min(1).max(10),
  generatedAt: stamp,
  /** Newest train report; trains move every few seconds, so the view says when it was true. */
  observedAt: stamp.nullable(),
  paths: z
    .array(
      z.object({
        label: z.string().max(80),
        circular: z.boolean(),
        stations: z
          .array(
            z.object({
              name: z.string().min(1).max(60),
              code: z.string().max(20),
              transfers: z.array(z.string().max(20)).max(12),
            }),
          )
          .min(1)
          .max(160),
        trains: z
          .array(
            z.object({
              trainNo: z.string().max(20),
              terminal: z.string().max(60),
              express: z.boolean(),
              last: z.boolean(),
              status: z.enum(['previous', 'approach', 'arrive', 'depart']),
              station: z.string().max(60),
              /** Station index along the path, fractional between stations. */
              position: z.number().finite().min(0),
              /** Running in the path's station order (first → last). */
              forward: z.boolean(),
            }),
          )
          .max(400),
      }),
    )
    .min(1)
    .max(12),
  selected: z
    .object({ path: z.number().int().min(0), station: z.number().int().min(0) })
    .nullable(),
  arrivals: z
    .array(
      z.object({
        forward: z.boolean(),
        terminal: z.string().max(60),
        arrivesAt: stamp,
        message: z.string().max(200),
        express: z.boolean(),
        stopsAway: z.number().int().min(0).max(100).nullable(),
        /** No countdown from the operator: the time is two minutes a stop. */
        estimated: z.boolean(),
      }),
    )
    .max(40),
});

export type SubwayLineView = z.infer<typeof subwayLineViewSchema>;
export type SubwayLinePath = SubwayLineView['paths'][number];
export type SubwayLineTrain = SubwayLinePath['trains'][number];
export type SubwayLineArrival = SubwayLineView['arrivals'][number];
