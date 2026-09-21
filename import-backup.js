import fs from 'node:fs';
import pg from 'pg';
const { Pool } = pg;
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-backup.js /path/to/boqbee-backup.json'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const state = JSON.parse(fs.readFileSync(file,'utf8'));
delete state.users;
delete state.currentUserId;
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const {rows} = await client.query('SELECT version FROM app_state WHERE id=1 FOR UPDATE');
  const version = Number(rows[0]?.version || 0) + 1;
  await client.query('INSERT INTO state_backups(version,state) SELECT version,state FROM app_state WHERE id=1');
  await client.query('UPDATE app_state SET state=$1,version=$2,updated_at=now() WHERE id=1',[JSON.stringify(state),version]);
  await client.query('COMMIT');
  console.log(`Imported state as version ${version}. User accounts were intentionally not imported.`);
} catch (e) {
  await client.query('ROLLBACK'); console.error(e); process.exitCode=1;
} finally { client.release(); await pool.end(); }
