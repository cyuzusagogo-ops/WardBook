// Loads demo hospitals, staff and fake patients for trying WardBook out.
// Refuses to run when NODE_ENV=production or when the database already has patients.
import pg from 'pg';
import { required } from './config.js';
import { seedDemo, DEMO_TOTP_SECRET } from './demo-data.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to load demo data with NODE_ENV=production.');
  process.exit(1);
}
const url = required('OWNER_DATABASE_URL');
const check = new pg.Client({ connectionString: url });
await check.connect();
const n = (await check.query('SELECT count(*)::int AS n FROM patients')).rows[0].n;
await check.end();
if (n > 0) {
  console.error('This database already has patients. Demo data goes only into an empty database.');
  process.exit(1);
}
const password = 'demo-pass-2026';
const ids = await seedDemo(url, { password });
console.log(`\nSign in at http://localhost:${process.env.PORT || 3000} with any of:`);
for (const u of Object.values(ids.users)) console.log(`  ${u.email}`);
console.log(`Password for all demo accounts: ${password}`);
console.log(`Two-step code: add secret ${DEMO_TOTP_SECRET} to an authenticator app,`);
console.log(`or run: node scripts/totp-code.js ${DEMO_TOTP_SECRET}`);
