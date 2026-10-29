import { Table, type MigrationInterface, type QueryRunner, type TableColumnOptions } from 'typeorm';

// This snapshot is immutable. Future entity changes require a new migration.
const column = (
  name: string,
  type: string,
  options: Partial<TableColumnOptions> = {},
): TableColumnOptions => ({ name, type, ...options });
const primary = (name: string, type = 'text') => column(name, type, { isPrimary: true });
const nullable = (name: string, type = 'text') => column(name, type, { isNullable: true });
const number = (name: string, value?: number) =>
  column(name, 'bigint', value === undefined ? {} : { default: String(value) });

export const INITIAL_APPLICATION_TABLES = [
  new Table({
    name: 'users',
    columns: [
      primary('id', 'uuid'),
      column('name', 'text'),
      nullable('email'),
      column('email_verified', 'boolean', { default: false }),
      number('created_at'),
      nullable('terms_version'),
      nullable('privacy_version'),
      column('marketing_consent', 'boolean', { default: false }),
      nullable('accepted_at', 'bigint'),
    ],
  }),
  new Table({
    name: 'social_identities',
    columns: [
      primary('provider'),
      primary('subject'),
      column('user_id', 'uuid'),
      nullable('encrypted_grant'),
    ],
    foreignKeys: [
      {
        name: 'social_identities_user_id_fkey',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
    checks: [
      {
        name: 'social_identities_provider_check',
        expression: "provider IN ('kakao','google','apple')",
      },
    ],
  }),
  new Table({
    name: 'sessions',
    columns: [
      primary('id', 'uuid'),
      column('token_hash', 'text'),
      column('user_id', 'uuid'),
      column('label', 'text'),
      number('created_at'),
      number('last_seen_at'),
      number('expires_at'),
      column('csrf_token', 'text'),
      column('insertion_order', 'bigint', {
        isGenerated: true,
        generationStrategy: 'identity',
        generatedIdentity: 'ALWAYS',
      }),
    ],
    uniques: [{ name: 'sessions_token_hash_key', columnNames: ['token_hash'] }],
    indices: [
      { name: 'sessions_user', columnNames: ['user_id'] },
      { name: 'sessions_expiry', columnNames: ['expires_at'] },
    ],
    foreignKeys: [
      {
        name: 'sessions_user_id_fkey',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
  }),
  new Table({
    name: 'oauth_states',
    columns: [
      primary('state_hash'),
      column('provider', 'text'),
      column('encrypted_data', 'text'),
      number('expires_at'),
    ],
  }),
  new Table({
    name: 'auth_tickets',
    columns: [
      primary('ticket_hash'),
      column('user_id', 'uuid'),
      column('challenge', 'text'),
      column('platform', 'text'),
      column('new_user', 'boolean'),
      number('expires_at'),
    ],
    foreignKeys: [
      {
        name: 'auth_tickets_user_id_fkey',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
    checks: [{ name: 'auth_tickets_platform_check', expression: "platform IN ('web','native')" }],
  }),
  new Table({
    name: 'account_data',
    columns: [
      primary('user_id', 'uuid'),
      nullable('preferences', 'jsonb'),
      nullable('trips', 'jsonb'),
    ],
    foreignKeys: [
      {
        name: 'account_data_user_id_fkey',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
  }),
  new Table({
    name: 'support_tickets',
    columns: [
      primary('id', 'uuid'),
      nullable('user_id', 'uuid'),
      column('category', 'text'),
      column('message', 'text'),
      nullable('email'),
      number('created_at'),
      column('status', 'text', { default: "'received'" }),
    ],
    indices: [{ name: 'support_tickets_time', columnNames: ['created_at'] }],
    foreignKeys: [
      {
        name: 'support_tickets_user_id_fkey',
        columnNames: ['user_id'],
        referencedTableName: 'users',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
  }),
  new Table({
    name: 'auth_rate_windows',
    columns: [primary('client_hash'), number('reset_at'), column('request_count', 'integer')],
    indices: [{ name: 'auth_rate_windows_expiry', columnNames: ['reset_at'] }],
  }),
  new Table({ name: 'eta_metadata', columns: [primary('name'), column('value', 'text')] }),
  new Table({
    name: 'eta_observations',
    columns: [
      primary('id'),
      column('trip_id', 'uuid'),
      number('observed_at'),
      column('payload', 'jsonb'),
    ],
    indices: [
      { name: 'eta_observations_time', columnNames: ['observed_at'] },
      { name: 'eta_observations_trip', columnNames: ['trip_id'] },
    ],
  }),
  new Table({
    name: 'eta_journeys',
    columns: [
      primary('id'),
      column('trip_id', 'uuid'),
      number('observed_at'),
      column('payload', 'jsonb'),
    ],
    uniques: [{ name: 'eta_journeys_trip_id_key', columnNames: ['trip_id'] }],
    indices: [{ name: 'eta_journeys_time', columnNames: ['observed_at'] }],
  }),
  new Table({
    name: 'eta_erased_receipts',
    columns: [primary('id', 'uuid'), number('expires_at')],
  }),
  new Table({
    name: 'eta_learning_state',
    columns: [
      primary('id', 'integer'),
      number('revision', 0),
      column('last_attempt_trips', 'integer', { default: '0' }),
      column('last_attempt_journeys', 'integer', { default: '0' }),
      column('reasons', 'jsonb', { default: '\'["insufficient-independent-trips"]\'::jsonb' }),
      column('journey_reasons', 'jsonb', {
        default: '\'["insufficient-independent-journeys"]\'::jsonb',
      }),
      nullable('shadow_leg_candidate', 'jsonb'),
    ],
    checks: [{ name: 'eta_learning_state_id_check', expression: 'id = 1' }],
  }),
  new Table({
    name: 'eta_models',
    columns: [primary('kind'), column('payload', 'jsonb'), number('updated_at')],
  }),
  new Table({
    name: 'api_rate_windows',
    columns: [primary('key'), column('count', 'integer'), number('expires_at')],
    indices: [{ name: 'api_rate_expiry', columnNames: ['expires_at'] }],
  }),
  new Table({ name: 'orm_locks', columns: [primary('key')] }),
].map((table) => {
  for (const column of table.primaryColumns) {
    column.primaryKeyConstraintName = `${table.name}_pkey`;
  }

  return table;
});

export class InitialOrmSchema1793232000000 implements MigrationInterface {
  name = 'InitialOrmSchema1793232000000';

  async up(queryRunner: QueryRunner) {
    for (const table of INITIAL_APPLICATION_TABLES) {
      await queryRunner.createTable(table.clone(), true);
    }

    await queryRunner.manager
      .createQueryBuilder()
      .insert()
      .into('eta_learning_state')
      .values({ id: 1 })
      .orIgnore()
      .execute();
  }

  async down(): Promise<void> {
    throw new Error(
      'Initial schema adoption cannot be reverted automatically. Create a forward migration.',
    );
  }
}
