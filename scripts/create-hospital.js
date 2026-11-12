// Platform operator: register a hospital (tenant).
// Usage: npm run create-hospital -- "Hospital name"
import pg from 'pg';
import { required } from './config.js';

const name = process.argv.slice(2).join(' ').trim();
if (!name) { console.error('Usage: npm run create-hospital -- "Hospital name"'); process.exit(1); }
const db = new pg.Client({ connectionString: required('OWNER_DATABASE_URL') });
await db.connect();
const { rows } = await db.query('INSERT INTO hospitals (name) VALUES ($1) RETURNING id', [name]);
await db.end();
console.log(`Created "${name}"\nHospital id: ${rows[0].id}\nNext: npm run create-admin -- ${rows[0].id} admin@example.org "Full Name"`);
