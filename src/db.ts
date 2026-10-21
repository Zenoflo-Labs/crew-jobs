import { PGlite, types } from '@electric-sql/pglite';
import pg from 'pg';

export type Row = Record<string, any>;
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// One type setup for both engines (D4 rule 2): dates stay 'YYYY-MM-DD' text,
// and counts and sums become plain numbers.
pg.types.setTypeParser(1082, (value: string) => value);
pg.types.setTypeParser(20, (value: string) => Number(value));
const pgliteParsers = { [types.DATE]: (value: string) => value, [types.INT8]: (value: string) => Number(value) };

// Local: PGlite in a folder (or in memory for tests). Hosted: Postgres 18 via DATABASE_URL.
export async function openDb(options: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  if (options.databaseUrl) {
    return postgres(options.databaseUrl);
  }
  // No folder means an in-memory database (tests). The options object must be
  // the only argument then, or PGlite ignores the type setup.
  const db = options.dataDir
    ? new PGlite(options.dataDir, { parsers: pgliteParsers })
    : new PGlite({ parsers: pgliteParsers });
  await db.waitReady;
  return {
    query: async (sql, params = []) => (await db.query<any>(sql, params)).rows,
    exec: async sql => { await db.exec(sql); },
    transaction: fn => db.transaction(tx => fn({
      query: async (sql, params = []) => (await tx.query<any>(sql, params)).rows,
      exec: async sql => { await tx.exec(sql); },
    })),
    close: () => db.close(),
  };
}

function postgres(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    exec: async sql => { await pool.query(sql); },
    transaction: async fn => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (sql, params = []) => (await client.query(sql, params)).rows,
          exec: async sql => { await client.query(sql); },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
