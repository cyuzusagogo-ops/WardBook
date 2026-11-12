// One-time setup: creates roles + database, then applies migrations.
// Usage: npm run db:setup   (reads ADMIN_DATABASE_URL, DB_NAME, DB_OWNER_PASSWORD, DB_APP_PASSWORD)
import { required } from './config.js';
import { setupDatabase, migrate, withDb } from './migrate-lib.js';

const adminUrl = required('ADMIN_DATABASE_URL');
const dbName = process.env.DB_NAME || 'wardbook';
const ownerPassword = required('DB_OWNER_PASSWORD');
await setupDatabase({ adminUrl, dbName, ownerPassword, appPassword: required('DB_APP_PASSWORD') });
const owner = new URL(withDb(adminUrl, dbName));
owner.username = 'wardbook_owner';
owner.password = ownerPassword;
await migrate(owner.toString());
console.log('Database ready.');
