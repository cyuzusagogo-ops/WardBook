import 'dotenv/config';
import { createPool } from './db.js';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const dbUser = new URL(process.env.DATABASE_URL).username;
if (dbUser !== 'wardbook_app') {
  console.error(`DATABASE_URL connects as "${dbUser}". It must use the wardbook_app role: owners and superusers bypass the access rules.`);
  process.exit(1);
}

const pool = createPool(process.env.DATABASE_URL);
const app = createApp(pool, {
  idleMinutes: Number(process.env.IDLE_MINUTES || 15),
  trustProxy: process.env.TRUST_PROXY === '1',
});
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`WardBook listening on http://localhost:${port}`));
