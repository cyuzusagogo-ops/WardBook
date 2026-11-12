import { required } from './config.js';
import { migrate } from './migrate-lib.js';
await migrate(required('OWNER_DATABASE_URL'));
console.log('Migrations up to date.');
