import 'dotenv/config';
import pg from 'pg';
import * as OTPAuth from 'otpauth';
import { setupDatabase, migrate, withDb } from '../scripts/migrate-lib.js';
import { seedDemo, DEMO_TOTP_SECRET } from '../scripts/demo-data.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';

export const PASSWORD = 'test-pass-2026';
const TEST_DB = process.env.TEST_DB_NAME || 'wardbook_test';

// Fresh database per test run: roles, schema, demo data, and the app on a free port.
export async function startTestEnv() {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL || process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('Set ADMIN_DATABASE_URL (a superuser connection) to run the tests.');
  const ownerPassword = process.env.DB_OWNER_PASSWORD || 'test-owner';
  const appPassword = process.env.DB_APP_PASSWORD || 'test-app';
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
  await setupDatabase({ adminUrl, dbName: TEST_DB, ownerPassword, appPassword }, () => {});
  const ownerUrl = withUser(withDb(adminUrl, TEST_DB), 'wardbook_owner', ownerPassword);
  const appUrl = withUser(withDb(adminUrl, TEST_DB), 'wardbook_app', appPassword);
  await migrate(ownerUrl, () => {});
  const ids = await seedDemo(ownerUrl, { password: PASSWORD, log: () => {} });

  const pool = createPool(appUrl);
  const app = createApp(pool, { idleMinutes: 15 });
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();

  const sessions = new Map();
  const env = {
    ids, base, pool, owner, appUrl,
    // Signs a demo user in through the real flow: password, then a valid two-step code.
    async login(key, { hospital = 'A' } = {}) {
      const c = client(base);
      const r1 = await c.post('/api/auth/login', { email: ids.users[key].email, password: PASSWORD });
      if (r1.status !== 200) throw new Error(`login ${key}: ${r1.status} ${JSON.stringify(r1.body)}`);
      const r2 = await c.post('/api/auth/two-step/verify', { code: nextCode(key) });
      if (r2.status !== 200) throw new Error(`two-step ${key}: ${r2.status} ${JSON.stringify(r2.body)}`);
      if (r2.body.stage === 'choose_hospital') {
        await c.post('/api/auth/hospital', { hospitalId: hospital === 'A' ? ids.hospitalA : ids.hospitalB });
      }
      return c;
    },
    async as(key) {
      if (!sessions.has(key)) sessions.set(key, await env.login(key));
      return sessions.get(key);
    },
    async close() {
      await owner.end();
      await pool.end();
      await new Promise(r => server.close(r));
    },
  };
  return env;
}

// Each account's two-step step counter only moves forward, so repeated sign-ins of the same
// demo user use successive time steps.
const lastStep = new Map();
export function nextCode(key) {
  const now = Math.floor(Date.now() / 30000);
  const step = Math.max(now - 1, (lastStep.get(key) ?? now - 2) + 1);
  if (step > now + 1) throw new Error(`no unused two-step code left for ${key} in this 30 s window`);
  lastStep.set(key, step);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(DEMO_TOTP_SECRET), algorithm: 'SHA1', digits: 6, period: 30 });
  return totp.generate({ timestamp: step * 30000 + 1000 });
}

function withUser(url, user, password) {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-wardbook': '1', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    get: p => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: p => call('DELETE', p),
    get cookie() { return cookie; },
  };
}

// Runs SQL as the application role with a chosen identity, to prove the database itself refuses.
export async function asAppRole(appUrl, { userId, hospitalId }, sql, params = []) {
  const c = new pg.Client({ connectionString: appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.hospital_id', $2, true)", [userId || '', hospitalId || '']);
    const r = await c.query(sql, params);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
