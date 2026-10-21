// Fails when the app outgrows the size budget in the spec. That failing is a feature:
// a learner should be able to read all of Crew Jobs by the end of Part 4.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET = { tables: 5, routes: 15, lines: 2000 };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const tables = files('migrations')
  .filter(path => path.endsWith('.sql'))
  .reduce((count, path) => count + (readFileSync(path, 'utf8').match(/CREATE TABLE/gi) ?? []).length, 0);
const routes = (readFileSync('src/routes.ts', 'utf8').match(/^\s*\{ method: '/gm) ?? []).length;
const lines = [...files('src'), ...files('public')]
  .filter(path => !/\.test\.ts$/.test(path))
  .reduce((count, path) => count + readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').length, 0);

const results = [
  ['Database tables', tables, BUDGET.tables],
  ['Routes', routes, BUDGET.routes],
  ['App code lines (src and public)', lines, BUDGET.lines],
] as const;

let over = false;
for (const [name, used, limit] of results) {
  const ok = used <= limit;
  over ||= !ok;
  console.log(`${ok ? 'OK  ' : 'OVER'} ${name}: ${used} of ${limit}`);
}
if (over) {
  console.error('Size budget exceeded. Shrink the change, or make the case for a bigger budget in a decision, not a quiet edit.');
  process.exit(1);
}
