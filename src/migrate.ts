import { readdirSync, readFileSync } from 'node:fs';
import type { Db } from './db.ts';

const migrationsDir = new URL('../migrations/', import.meta.url);

// Applies numbered .sql files in order, once each. Returns the names it applied.
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).map(row => row.name));
  const files = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(new URL(name, migrationsDir), 'utf8');
    await db.transaction(async tx => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    applied.push(name);
  }
  return applied;
}
