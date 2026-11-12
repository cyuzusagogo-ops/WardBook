import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

// Applies db/migrations/*.sql in name order, each once, each in its own transaction.
export async function migrate(ownerUrl, log = console.log) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${e.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

// Creates the two database roles and the database. Needs a superuser connection once.
export async function setupDatabase({ adminUrl, dbName, ownerPassword, appPassword }, log = console.log) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const lit = s => `'${String(s).replace(/'/g, "''")}'`;
  const ident = s => `"${String(s).replace(/"/g, '""')}"`;
  try {
    for (const [role, pw, extra] of [
      ['wardbook_owner', ownerPassword, 'NOSUPERUSER NOCREATEROLE NOBYPASSRLS'],
      ['wardbook_app', appPassword, 'NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOINHERIT'],
    ]) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
      await admin.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD ${lit(pw)} ${extra}`);
      log(`${exists ? 'updated' : 'created'} role ${role}`);
    }
    const dbExists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount > 0;
    if (!dbExists) {
      await admin.query(`CREATE DATABASE ${ident(dbName)} OWNER wardbook_owner`);
      log(`created database ${dbName}`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${ident(dbName)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(dbName)} TO wardbook_app`);
  } finally {
    await admin.end();
  }
  const db = new pg.Client({ connectionString: withDb(adminUrl, dbName) });
  await db.connect();
  try {
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await db.query('ALTER SCHEMA public OWNER TO wardbook_owner');
  } finally {
    await db.end();
  }
}

export function withDb(url, dbName) {
  const u = new URL(url);
  u.pathname = '/' + dbName;
  return u.toString();
}
