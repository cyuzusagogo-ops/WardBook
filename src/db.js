import pg from 'pg';

// The pool connects as wardbook_app, which is subject to row-level security.
export function createPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE || 10) });
  pool.on('error', err => console.error('database pool error', err.message));
  return pool;
}

// Runs fn inside a transaction whose settings identify the person and hospital.
// Every policy in the database reads these two settings; nothing else grants access.
export async function withContext(pool, { userId, hospitalId }, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.hospital_id', $2, true)",
      [userId || '', hospitalId || '']
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
