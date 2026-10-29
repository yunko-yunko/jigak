import { EntitySchema } from 'typeorm';
import { bigintNumberTransformer } from '../transformers.js';

export interface ApiRateWindow {
  key: string;
  count: number;
  expiresAt: number;
}

export const ApiRateWindowEntity = new EntitySchema<ApiRateWindow>({
  name: 'ApiRateWindow',
  tableName: 'api_rate_windows',
  columns: {
    key: { type: 'text', primary: true, primaryKeyConstraintName: 'api_rate_windows_pkey' },
    count: { type: 'integer' },
    expiresAt: { name: 'expires_at', type: 'bigint', transformer: bigintNumberTransformer },
  },
  indices: [{ name: 'api_rate_expiry', columns: ['expiresAt'] }],
});
