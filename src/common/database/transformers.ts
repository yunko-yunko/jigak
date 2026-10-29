import type { ValueTransformer } from 'typeorm';

/** Application timestamps/counts are bounded to JavaScript's safe integer range. */
export const bigintNumberTransformer: ValueTransformer = {
  to(value: number | null | undefined) {
    if (value === null || value === undefined) {
      return value;
    }

    if (!Number.isSafeInteger(value)) {
      throw new RangeError('Database bigint exceeds the safe integer range.');
    }

    return value;
  },

  from(value: string | number | null) {
    if (value === null) {
      return null;
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number)) {
      throw new RangeError('Database bigint exceeds the safe integer range.');
    }

    return number;
  },
};
