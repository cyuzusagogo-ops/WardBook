// Platform operator: create a hospital's first admin. The admin then adds all other staff
// from the Staff page. Prints a one-time temporary password; the admin must change it and
// set up two-step sign-in at first login.
// Usage: npm run create-admin -- <hospital-id> <email> "Full Name"
import pg from 'pg';
import { required } from './config.js';
import { hashPassword, tempPassword } from '../src/auth.js';

const [hospitalId, emailArg, ...nameParts] = process.argv.slice(2);
const email = String(emailArg || '').toLowerCase();
const fullName = nameParts.join(' ').trim();
if (!hospitalId || !email || !fullName) {
  console.error('Usage: npm run create-admin -- <hospital-id> <email> "Full Name"');
  process.exit(1);
}
const db = new pg.Client({ connectionString: required('OWNER_DATABASE_URL') });
await db.connect();
try {
  await db.query('BEGIN');
  const h = (await db.query('SELECT name FROM hospitals WHERE id = $1', [hospitalId])).rows[0];
  if (!h) throw new Error('No hospital with that id. Run create-hospital first.');
  let user = (await db.query('SELECT id FROM auth.users WHERE email = $1', [email])).rows[0];
  let pw = null;
  if (!user) {
    pw = tempPassword();
    user = (await db.query('INSERT INTO auth.users (email, full_name, password_hash) VALUES ($1,$2,$3) RETURNING id',
      [email, fullName, await hashPassword(pw)])).rows[0];
  }
  await db.query(`INSERT INTO memberships (user_id, hospital_id, role) VALUES ($1,$2,'hospital_admin')
                  ON CONFLICT (user_id, hospital_id) DO UPDATE SET role = 'hospital_admin', active = true`, [user.id, hospitalId]);
  await db.query(`INSERT INTO audit_log (hospital_id, action, entity, entity_id, detail)
                  VALUES ($1, 'insert', 'memberships', $2, '{"by":"platform operator"}')`, [hospitalId, user.id]);
  await db.query('COMMIT');
  console.log(`${fullName} <${email}> is now hospital admin of ${h.name}.`);
  console.log(pw ? `Temporary password (shown once): ${pw}` : 'Existing account: keeps its current password.');
} catch (e) {
  await db.query('ROLLBACK');
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
