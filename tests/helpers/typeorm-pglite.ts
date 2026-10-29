import { PGlite, type Results } from '@electric-sql/pglite';
import { EventEmitter } from 'node:events';

interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  command: string;
  oid: number;
  fields: Results['fields'];
}

type QueryCallback = (error: Error | null, result?: PgResult) => void;
type Release = (error?: Error) => void;
type ConnectCallback = (error: Error | null, client?: PGliteClient, release?: Release) => void;

/**
 * TypeORM's actual PostgreSQL driver talks to an embedded PostgreSQL instance.
 * Only the pg transport is adapted; SQL, constraints, transactions, and ORM
 * metadata use the same PostgreSQL execution path as the production database.
 */
export function createPGliteDriver(engine: PGlite) {
  return {
    Pool: class extends EventEmitter {
      private available = Promise.resolve();
      private closed = false;

      constructor(_options: unknown) {
        super();
      }

      connect(): Promise<PGliteClient>;
      connect(callback: ConnectCallback): void;
      connect(callback?: ConnectCallback): Promise<PGliteClient> | void {
        const connection = this.acquire();

        if (callback) {
          void connection.then(
            (client) => callback(null, client, client.release),
            (error: Error) => callback(error),
          );

          return;
        }

        return connection;
      }

      private async acquire(): Promise<PGliteClient> {
        if (this.closed) {
          throw new Error('The test PostgreSQL pool has ended.');
        }

        const previous = this.available;

        let unlock!: () => void;

        this.available = new Promise<void>((resolve) => {
          unlock = resolve;
        });

        await previous;

        return new PGliteClient(engine, unlock);
      }

      async query(sql: string, parameters: unknown[] = []): Promise<PgResult> {
        const client = await this.acquire();

        try {
          return await client.query(sql, parameters);
        } finally {
          client.release();
        }
      }

      end(): Promise<void>;
      end(callback: (error?: Error) => void): void;
      end(callback?: (error?: Error) => void): Promise<void> | void {
        this.closed = true;

        if (callback) {
          void this.available.then(() => callback());

          return;
        }

        return this.available;
      }
    },
  };
}

class PGliteClient extends EventEmitter {
  private released = false;

  constructor(
    private readonly engine: PGlite,
    private readonly unlock: () => void,
  ) {
    super();
  }

  readonly release = (_error?: Error): void => {
    if (!this.released) {
      this.released = true;
      this.unlock();
    }
  };

  query(sql: string, parameters?: unknown[]): Promise<PgResult>;
  query(sql: string, callback: QueryCallback): void;
  query(sql: string, parameters: unknown[], callback: QueryCallback): void;
  query(
    sql: string,
    parametersOrCallback: unknown[] | QueryCallback = [],
    callback?: QueryCallback,
  ): Promise<PgResult> | void {
    const parameters = Array.isArray(parametersOrCallback) ? parametersOrCallback : [];
    const resultCallback =
      typeof parametersOrCallback === 'function' ? parametersOrCallback : callback;
    const result = this.execute(sql, parameters);

    if (resultCallback) {
      void result.then(
        (value) => resultCallback(null, value),
        (error: Error) => resultCallback(error),
      );

      return;
    }

    return result;
  }

  private async execute(sql: string, parameters: unknown[]): Promise<PgResult> {
    // pg's simple-query protocol accepts SQL batches when no values are bound.
    const result =
      parameters.length === 0
        ? (await this.engine.exec(sql)).at(-1)
        : await this.engine.query(sql, parameters);
    const command = sql.trim().split(/\s+/)[0]!.toUpperCase();
    const fields = result?.fields ?? [];
    const rows = (result?.rows ?? []) as Record<string, unknown>[];

    // node-postgres returns int8 as text by default; match that boundary so
    // EntitySchema bigint transformers are exercised in tests as in Cloud SQL.
    for (const field of fields) {
      if (field.dataTypeID === 20) {
        for (const row of rows) {
          if (row[field.name] !== null && row[field.name] !== undefined) {
            row[field.name] = String(row[field.name]);
          }
        }
      }
    }

    return {
      rows,
      rowCount: command === 'SELECT' ? rows.length : (result?.affectedRows ?? rows.length),
      command,
      oid: 0,
      fields,
    };
  }
}
