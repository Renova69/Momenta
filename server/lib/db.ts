import { Pool, QueryResultRow } from 'pg';
import { CONFIG } from './config';

/**
 * Connection pool.
 *
 * Sized for an upload burst: a wedding's guests all shoot the first dance at
 * once, and at 20 connections that burst exhausted the pool and requests began
 * failing with "timeout exceeded when trying to connect" — a 500 for the guest.
 * Raise DB_POOL_MAX further if you run several receptions on one instance, but
 * keep it under the server's own `max_connections`.
 */
export const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '40', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
});

pool.on('error', (err) => {
  console.error('[Postgres Pool] Unexpected error on idle client:', err);
});

export type QueryParam = string | number | boolean | null | Date | string[] | number[];

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: QueryParam[]
) {
  const start = Date.now();
  try {
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    if (process.env.DEBUG_SQL) {
      console.log(`[SQL Query] (${duration}ms) ${text}`, params);
    }
    return res;
  } catch (err) {
    console.error(`[SQL Error] in query: ${text}`, err);
    throw err;
  }
}
