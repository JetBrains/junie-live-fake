import pg from 'pg';
import { config } from './config.js';

const pool = new pg.Pool({
  connectionString: config.db.url,
  max: 4,
  // The JIP shared Postgres requires TLS but presents a cert this container has no
  // CA for, which is the same posture attendee itself uses (dj_database_url with
  // ssl_require and no CA bundle).
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
