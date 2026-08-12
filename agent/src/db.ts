import pg from 'pg';
import { config } from './config.js';

/**
 * The JIP connection string ends in `?sslmode=require`, and pg now treats that as an
 * alias for `verify-full`, which overrides any `ssl` option passed here and fails
 * against the shared Postgres' private CA ("unable to verify the first certificate").
 * Strip it and state the intent explicitly. This matches attendee's own posture:
 * dj_database_url with ssl_require, i.e. libpq semantics — encrypt, do not verify.
 */
function connectionString(): string {
  const u = new URL(config.db.url);
  u.searchParams.delete('sslmode');
  return u.toString();
}

const pool = new pg.Pool({
  connectionString: connectionString(),
  max: 4,
  ssl: { rejectUnauthorized: false },
});

const schema = config.db.schema;

/**
 * Creates the schema and tables on boot. Deliberately not a migration framework:
 * this lives inside the attendee database, and anything cleverer risks colliding
 * with Django's migration state.
 */
export async function initSchema(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.sessions (
      id           BIGSERIAL PRIMARY KEY,
      bot_id       TEXT        NOT NULL,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at     TIMESTAMPTZ,
      end_reason   TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.turns (
      id          BIGSERIAL PRIMARY KEY,
      session_id  BIGINT      NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
      role        TEXT        NOT NULL CHECK (role IN ('user', 'agent')),
      text        TEXT        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS turns_session_id_idx ON ${schema}.turns (session_id)
  `);
}

export async function openSession(botId: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ${schema}.sessions (bot_id) VALUES ($1) RETURNING id`,
    [botId],
  );
  return Number(r.rows[0]!.id);
}

export async function closeSession(sessionId: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE ${schema}.sessions SET ended_at = now(), end_reason = $2 WHERE id = $1`,
    [sessionId, reason],
  );
}

export async function recordTurn(
  sessionId: number,
  role: 'user' | 'agent',
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  await pool.query(
    `INSERT INTO ${schema}.turns (session_id, role, text) VALUES ($1, $2, $3)`,
    [sessionId, role, trimmed],
  );
}

export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function shutdown(): Promise<void> {
  await pool.end();
}
