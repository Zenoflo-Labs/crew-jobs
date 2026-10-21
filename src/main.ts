import './node-check.ts';
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { migrate } from './migrate.ts';
import { seedIfEmpty } from './seed.ts';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`Crew Jobs cannot start: ${(error as Error).message}`);
  process.exit(1);
}

const label = config.env.toUpperCase();

// Claim the port before opening the database, so a second copy never touches
// a database folder the first copy is using.
const server = createServer();
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Crew Jobs cannot start: port ${config.port} is already in use. Is Crew Jobs already running in another window?`);
  } else {
    console.error(`Crew Jobs cannot start: ${error.message}`);
  }
  process.exit(1);
});
await new Promise<void>(resolve => server.listen(config.port, config.host, resolve));

console.log(config.databaseUrl ? 'Connecting to Postgres...' : `Opening the local database in ${config.dataDir} (the first start takes a few seconds)...`);
const db = await openDb({ databaseUrl: config.databaseUrl, dataDir: config.databaseUrl ? undefined : config.dataDir });
const applied = await migrate(db);
console.log(applied.length > 0 ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Database is up to date.');
if (await seedIfEmpty(db, config.seedPassword)) console.log('Seeded made-up test data (see README for the test accounts).');

server.on('request', createApp({ db, config }));

// Register the stop handlers before printing the running line. Until a
// listener exists, Ctrl + C uses the system default and kills the process
// at once, skipping the clean shutdown.
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await db.close();
  console.log('Crew Jobs stopped.');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(`Crew Jobs is running at http://localhost:${config.port} (${label})`);
console.log('Press Ctrl + C to stop.');
