import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'crew-jobs-'));
const port = String(3100 + Math.floor(Math.random() * 800));
const started: ChildProcess[] = [];
// On Windows a script can't send another program a real Ctrl + C: kill('SIGINT')
// force-stops it instead. A real Ctrl + C typed in a Windows terminal does reach
// the app, so the clean-stop check runs everywhere except Windows CI.
const canSendCtrlC = process.platform !== 'win32';

function start(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: root,
    env: { ...process.env, PORT: port, DATA_DIR: dataDir, ...env },
  });
  started.push(child);
  let output = '';
  child.stdout!.on('data', chunk => (output += chunk));
  child.stderr!.on('data', chunk => (output += chunk));
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  const waitFor = async (text: string) => {
    for (let i = 0; i < 300 && !output.includes(text); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
    return output;
  };
  return { child, exited, waitFor, output: () => output };
}

// Stops a copy between tests: Ctrl + C where a script can send it, otherwise a plain kill.
async function stopApp(app: ReturnType<typeof start>) {
  app.child.kill(canSendCtrlC ? 'SIGINT' : undefined);
  await app.exited;
}

afterAll(() => {
  for (const child of started) child.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
});

describe('npm start (Chapter 10 contract)', () => {
  it('seeds, prints the running line, and refuses a second copy on the same port', async () => {
    const first = start();
    const output = await first.waitFor('Crew Jobs is running');
    expect(output).toContain('Seeded made-up test data');
    expect(output).toContain(`Crew Jobs is running at http://localhost:${port} (LOCAL)`);

    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(page).toContain('>LOCAL<');

    const second = start();
    expect(await second.exited).toBe(1);
    expect(second.output()).toContain(`port ${port} is already in use`);
    expect(second.output()).not.toContain('Opening the local database');
    await stopApp(first);
  });

  it('keeps data between starts and does not seed twice', async () => {
    const again = start();
    const output = await again.waitFor('Crew Jobs is running');
    expect(output).toContain('Database is up to date.');
    expect(output).not.toContain('Seeded');
    await stopApp(again);
  });

  it.runIf(canSendCtrlC)('stops cleanly on Ctrl + C (not on Windows CI: a script cannot send Ctrl + C there)', async () => {
    const app = start();
    await app.waitFor('Crew Jobs is running');
    app.child.kill('SIGINT');
    expect(await app.exited).toBe(0);
    expect(app.output()).toContain('Crew Jobs stopped.');
  });

  it('refuses to start outside local without its required variables', async () => {
    const staging = start({ APP_ENV: 'staging', DATABASE_URL: '', SEED_PASSWORD: '' });
    expect(await staging.exited).toBe(1);
    expect(staging.output()).toContain('Missing required environment variable(s) for staging: DATABASE_URL, SEED_PASSWORD');
  });
});

describe('config', () => {
  it('needs nothing for local use', () => {
    expect(loadConfig({})).toMatchObject({ env: 'local', port: 3000, host: '127.0.0.1', databaseUrl: undefined });
  });

  it('rejects an unknown environment name', () => {
    expect(() => loadConfig({ APP_ENV: 'prod' })).toThrow('APP_ENV must be local, staging or production');
  });
});
