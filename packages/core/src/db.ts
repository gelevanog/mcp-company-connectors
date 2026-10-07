import pg from 'pg';

// Numbers come back as numbers, timestamps as ISO strings, dates as YYYY-MM-DD: JSON-friendly tool results.
pg.types.setTypeParser(1700, (value) => Number.parseFloat(value)); // numeric
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10)); // int8
pg.types.setTypeParser(1184, (value) => new Date(value).toISOString()); // timestamptz
pg.types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString()); // timestamp
pg.types.setTypeParser(1082, (value) => value); // date

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

export const DEFAULT_DATABASE_URL = 'postgresql://switchboard:switchboard@127.0.0.1:55480/switchboard';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createPool(url = databaseUrl(), max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max, application_name: 'switchboard' });
  pool.on('error', (error) => {
    console.error(`[db] idle client error: ${error.message}`);
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryRows<T extends object>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T extends object>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(db, sql, params);
  return rows[0];
}
