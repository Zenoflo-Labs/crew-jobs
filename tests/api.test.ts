import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';
import { seedIfEmpty } from '../src/seed.ts';

const PASSWORD = 'test-password';
const BRIGHT_OWNER = 'owner@brightplumbing.example';
const BRIGHT_STAFF = 'staff@brightplumbing.example';
const GREEN_OWNER = 'owner@greenlawn.example';

let db: Db;
let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  db = await openDb({});
  await migrate(db);
  await seedIfEmpty(db, PASSWORD);
  const app = createApp({ db, config: loadConfig({}), log: line => logs.push(line), limits: { loginPerIp: 1000, exportsPerUser: 5 } });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await db.close();
});

async function call(method: string, path: string, options: { cookie?: string; body?: unknown; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined || options.raw !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, headers: response.headers, text, json: type.includes('json') ? JSON.parse(text) : undefined };
}

async function signIn(email: string, password = PASSWORD): Promise<string> {
  const response = await call('POST', '/api/login', { body: { email, password } });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}

// Ids of Green Lawn Care's first job and invoice, for the other-tenant checks.
async function greenIds() {
  const [job] = await db.query("SELECT j.id FROM jobs j JOIN tenants t ON t.id = j.tenant_id WHERE t.name = 'Green Lawn Care' ORDER BY j.id LIMIT 1");
  const [invoice] = await db.query("SELECT i.id FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE t.name = 'Green Lawn Care' ORDER BY i.id LIMIT 1");
  return { jobId: job.id as number, invoiceId: invoice.id as number };
}

function expectDenied(response: Awaited<ReturnType<typeof call>>, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(Object.keys(response.json).sort()).toEqual(['error', 'request_id']);
  expect(response.json.error).toBe(error);
}

describe('app shell and health', () => {
  it('serves the app shell with the environment name in the header', async () => {
    const response = await call('GET', '/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<span class="env" id="env">LOCAL</span>');
  });

  it('reports status, version and database health', async () => {
    const response = await call('GET', '/health');
    expect(response.json).toEqual({ status: 'ok', version: 'dev', db: 'ok' });
  });

  it('answers unknown API paths with a JSON 404', async () => {
    expectDenied(await call('GET', '/api/nothing-here'), 404, 'not_found');
  });
});

describe('sign in and out', () => {
  it('signs in with an HttpOnly, SameSite=Lax session cookie', async () => {
    const response = await call('POST', '/api/login', { body: { email: BRIGHT_OWNER, password: PASSWORD } });
    expect(response.json).toEqual({ email: BRIGHT_OWNER, role: 'owner', tenant: 'Bright Plumbing' });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    expectDenied(await call('POST', '/api/login', { body: { email: BRIGHT_OWNER, password: 'wrong' } }), 401, 'wrong_email_or_password');
    expectDenied(await call('POST', '/api/login', { body: { email: 'nobody@nowhere.example', password: PASSWORD } }), 401, 'wrong_email_or_password');
  });

  it('refuses a login without an email and password', async () => {
    expectDenied(await call('POST', '/api/login', { body: {} }), 400, 'email_and_password_required');
  });

  it('stores only a hash of the session token', async () => {
    const token = (await signIn(BRIGHT_OWNER)).split('=')[1];
    const rows = await db.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token]);
    expect(rows).toHaveLength(0);
  });

  it('signs out, and the old cookie stops working', async () => {
    const cookie = await signIn(BRIGHT_OWNER);
    expect((await call('POST', '/api/logout', { cookie })).status).toBe(204);
    expectDenied(await call('GET', '/api/me', { cookie }), 401, 'signed_out');
  });

  it('refuses sign out when signed out', async () => {
    expectDenied(await call('POST', '/api/logout'), 401, 'signed_out');
  });

  it('returns the signed-in user, and 401 when signed out', async () => {
    const cookie = await signIn(BRIGHT_STAFF);
    expect((await call('GET', '/api/me', { cookie })).json).toEqual({ email: BRIGHT_STAFF, role: 'staff', tenant: 'Bright Plumbing' });
    expectDenied(await call('GET', '/api/me'), 401, 'signed_out');
  });
});

describe('jobs', () => {
  it('lists only the tenant\'s jobs, with invoice_id for owners only', async () => {
    const owner = await call('GET', '/api/jobs', { cookie: await signIn(BRIGHT_OWNER) });
    const staff = await call('GET', '/api/jobs', { cookie: await signIn(BRIGHT_STAFF) });
    expect(owner.json.jobs.length).toBeGreaterThanOrEqual(6);
    expect(owner.json.jobs.every((job: any) => job.customer_name && 'invoice_id' in job)).toBe(true);
    expect(staff.json.jobs.some((job: any) => 'invoice_id' in job)).toBe(false);
    const { jobId } = await greenIds();
    expect(owner.json.jobs.some((job: any) => job.id === jobId)).toBe(false);
    expect(staff.text).not.toContain('amount');
  });

  it('refuses the job list when signed out', async () => {
    expectDenied(await call('GET', '/api/jobs'), 401, 'signed_out');
  });

  it('lets staff create a job in their own tenant', async () => {
    const cookie = await signIn(BRIGHT_STAFF);
    const response = await call('POST', '/api/jobs', { cookie, body: { customer_name: ' TEST Kim Lee ', address: '1 Test St', scheduled_for: '2026-11-10' } });
    expect(response.status).toBe(201);
    expect(response.json.job).toMatchObject({ customer_name: 'TEST Kim Lee', status: 'scheduled', scheduled_for: '2026-11-10' });
    const [row] = await db.query('SELECT t.name FROM jobs j JOIN tenants t ON t.id = j.tenant_id WHERE j.id = $1', [response.json.job.id]);
    expect(row.name).toBe('Bright Plumbing');
  });

  it.each([
    [{ customer_name: 'TEST A', address: '1 Test St', scheduled_for: '2026-11-10', tenant_id: 2 }, 'tenant_id', 'not_allowed'],
    [{ customer_name: '', address: '1 Test St', scheduled_for: '2026-11-10' }, 'customer_name', 'length_1_to_100'],
    [{ customer_name: 'TEST A', address: '1 Test St', scheduled_for: '2026-02-30' }, 'scheduled_for', 'not_a_real_date'],
    [{ customer_name: 'TEST A', address: '1 Test St', scheduled_for: '2026-11-10', status: 'paid' }, 'status', 'unknown_status'],
    [{ customer_name: 'TEST A', address: 7, scheduled_for: '2026-11-10' }, 'address', 'must_be_text'],
    [{ customer_name: 'TEST A', address: '1 Test St', scheduled_for: '2026-11-10', assigned_user_id: '2' }, 'assigned_user_id', 'must_be_whole_number_or_null'],
  ])('validates every field on the server: %o', async (body, field, reason) => {
    const response = await call('POST', '/api/jobs', { cookie: await signIn(BRIGHT_OWNER), body });
    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: 'invalid', field, reason });
  });

  it('refuses to assign a job to another tenant\'s user', async () => {
    const [green] = await db.query('SELECT id FROM users WHERE email = $1', [GREEN_OWNER]);
    const body = { customer_name: 'TEST A', address: '1 Test St', scheduled_for: '2026-11-10', assigned_user_id: green.id };
    const response = await call('POST', '/api/jobs', { cookie: await signIn(BRIGHT_OWNER), body });
    expect(response.json).toMatchObject({ error: 'invalid', field: 'assigned_user_id', reason: 'no_such_user' });
  });

  it('refuses job creation when signed out', async () => {
    expectDenied(await call('POST', '/api/jobs', { body: { customer_name: 'TEST A' } }), 401, 'signed_out');
  });

  it('shows one job, hiding invoice_id from staff', async () => {
    const owner = await call('GET', '/api/jobs/1', { cookie: await signIn(BRIGHT_OWNER) });
    const staff = await call('GET', '/api/jobs/1', { cookie: await signIn(BRIGHT_STAFF) });
    expect(owner.json.job).toMatchObject({ id: 1, invoice_id: 1 });
    expect(staff.json.job.id).toBe(1);
    expect('invoice_id' in staff.json.job).toBe(false);
  });

  it('answers 404 for another tenant\'s job, a made-up id, or a non-number', async () => {
    const cookie = await signIn(BRIGHT_OWNER);
    const { jobId } = await greenIds();
    expectDenied(await call('GET', `/api/jobs/${jobId}`, { cookie }), 404, 'not_found');
    expectDenied(await call('GET', '/api/jobs/999999', { cookie }), 404, 'not_found');
    expectDenied(await call('GET', '/api/jobs/1abc', { cookie }), 404, 'not_found');
  });

  it('refuses one job when signed out', async () => {
    expectDenied(await call('GET', '/api/jobs/1'), 401, 'signed_out');
  });

  it('updates a job in the same tenant', async () => {
    const response = await call('PATCH', '/api/jobs/4', { cookie: await signIn(BRIGHT_STAFF), body: { status: 'in_progress' } });
    expect(response.status).toBe(200);
    expect(response.json.job).toMatchObject({ id: 4, status: 'in_progress' });
  });

  it('refuses to update another tenant\'s job, and leaves it unchanged', async () => {
    const { jobId } = await greenIds();
    const [before] = await db.query('SELECT status FROM jobs WHERE id = $1', [jobId]);
    expectDenied(await call('PATCH', `/api/jobs/${jobId}`, { cookie: await signIn(BRIGHT_OWNER), body: { status: 'scheduled' } }), 404, 'not_found');
    const [after] = await db.query('SELECT status FROM jobs WHERE id = $1', [jobId]);
    expect(after.status).toBe(before.status);
  });

  it('refuses an update with nothing to change, or when signed out', async () => {
    const response = await call('PATCH', '/api/jobs/4', { cookie: await signIn(BRIGHT_OWNER), body: {} });
    expect(response.json).toMatchObject({ error: 'invalid', field: 'body', reason: 'nothing_to_change' });
    expectDenied(await call('PATCH', '/api/jobs/4', { body: { status: 'done' } }), 401, 'signed_out');
  });
});

describe('invoices', () => {
  it('shows an invoice to its own owner', async () => {
    const response = await call('GET', '/api/invoices/1', { cookie: await signIn(BRIGHT_OWNER) });
    expect(response.json.invoice).toEqual({ id: 1, job_id: 1, amount_cents: 18500, status: 'sent', issued_on: '2026-10-05', due_on: '2026-10-19' });
  });

  it('answers 401 when signed out, 403 for staff, 404 for another tenant', async () => {
    const { invoiceId } = await greenIds();
    expectDenied(await call('GET', '/api/invoices/1'), 401, 'signed_out');
    expectDenied(await call('GET', '/api/invoices/1', { cookie: await signIn(BRIGHT_STAFF) }), 403, 'owner_only');
    expectDenied(await call('GET', `/api/invoices/${invoiceId}`, { cookie: await signIn(BRIGHT_OWNER) }), 404, 'not_found');
  });
});

describe('CSV export', () => {
  it('exports the owner\'s own jobs with invoice totals', async () => {
    const response = await call('GET', '/api/export/jobs.csv', { cookie: await signIn(BRIGHT_OWNER) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const lines = response.text.trim().split('\r\n');
    expect(lines[0]).toBe('job_id,customer_name,status,scheduled_for,invoice_total');
    expect(lines[1]).toBe('1,TEST Ada Lane,done,2026-10-05,185.00');
    expect(response.text).not.toContain('Gus Rivera');
  });

  it('stops spreadsheet formulas and quotes commas', async () => {
    const cookie = await signIn(GREEN_OWNER);
    await call('POST', '/api/jobs', { cookie, body: { customer_name: '=HYPERLINK("x")', address: '1 Test St', scheduled_for: '2026-11-10' } });
    await call('POST', '/api/jobs', { cookie, body: { customer_name: 'TEST Lee, Kim', address: '1 Test St', scheduled_for: '2026-11-10' } });
    const response = await call('GET', '/api/export/jobs.csv', { cookie });
    expect(response.text).toContain('"\'=HYPERLINK(""x"")"');
    expect(response.text).toContain('"TEST Lee, Kim"');
  });

  it('refuses staff and signed-out users', async () => {
    expectDenied(await call('GET', '/api/export/jobs.csv'), 401, 'signed_out');
    expectDenied(await call('GET', '/api/export/jobs.csv', { cookie: await signIn(BRIGHT_STAFF) }), 403, 'owner_only');
  });
});

describe('staff', () => {
  it('lists only the owner\'s own team', async () => {
    const response = await call('GET', '/api/staff', { cookie: await signIn(BRIGHT_OWNER) });
    const emails = response.json.staff.map((user: any) => user.email);
    expect(emails).toContain(BRIGHT_STAFF);
    expect(emails).not.toContain(GREEN_OWNER);
    expect(response.text).not.toContain('password');
  });

  it('refuses the staff list to staff and signed-out users', async () => {
    expectDenied(await call('GET', '/api/staff'), 401, 'signed_out');
    expectDenied(await call('GET', '/api/staff', { cookie: await signIn(BRIGHT_STAFF) }), 403, 'owner_only');
  });

  it('adds staff with a one-time password that works once shown', async () => {
    const response = await call('POST', '/api/staff', { cookie: await signIn(BRIGHT_OWNER), body: { email: 'New.Hire@BrightPlumbing.example' } });
    expect(response.status).toBe(201);
    expect(response.json.staff).toMatchObject({ email: 'new.hire@brightplumbing.example', role: 'staff' });
    await signIn('new.hire@brightplumbing.example', response.json.one_time_password);
  });

  it('refuses a taken email, a bad email, staff and signed-out users', async () => {
    const cookie = await signIn(BRIGHT_OWNER);
    expectDenied(await call('POST', '/api/staff', { cookie, body: { email: GREEN_OWNER } }), 409, 'email_taken');
    expect((await call('POST', '/api/staff', { cookie, body: { email: 'not-an-email' } })).json).toMatchObject({ field: 'email', reason: 'not_an_email' });
    expectDenied(await call('POST', '/api/staff', { cookie: await signIn(BRIGHT_STAFF), body: { email: 'x@y.example' } }), 403, 'owner_only');
    expectDenied(await call('POST', '/api/staff', { body: { email: 'x@y.example' } }), 401, 'signed_out');
  });

  it('removes staff: disables them and deletes their sessions', async () => {
    const owner = await signIn(BRIGHT_OWNER);
    const added = await call('POST', '/api/staff', { cookie: owner, body: { email: 'leaver@brightplumbing.example' } });
    const leaver = await signIn('leaver@brightplumbing.example', added.json.one_time_password);
    expect((await call('DELETE', `/api/staff/${added.json.staff.id}`, { cookie: owner })).status).toBe(204);
    expectDenied(await call('GET', '/api/jobs', { cookie: leaver }), 401, 'signed_out');
    expect(await db.query('SELECT 1 FROM sessions WHERE user_id = $1', [added.json.staff.id])).toHaveLength(0);
    const login = await call('POST', '/api/login', { body: { email: 'leaver@brightplumbing.example', password: added.json.one_time_password } });
    expect(login.status).toBe(401);
  });

  it('refuses to remove an owner, another tenant\'s staff, or when not the owner', async () => {
    const [ownerRow] = await db.query('SELECT id FROM users WHERE email = $1', [BRIGHT_OWNER]);
    const [greenStaff] = await db.query("SELECT id FROM users WHERE email = 'staff@greenlawn.example'");
    const cookie = await signIn(BRIGHT_OWNER);
    expectDenied(await call('DELETE', `/api/staff/${ownerRow.id}`, { cookie }), 404, 'not_found');
    expectDenied(await call('DELETE', `/api/staff/${greenStaff.id}`, { cookie }), 404, 'not_found');
    expectDenied(await call('DELETE', `/api/staff/${greenStaff.id}`, { cookie: await signIn(BRIGHT_STAFF) }), 403, 'owner_only');
    expectDenied(await call('DELETE', `/api/staff/${greenStaff.id}`), 401, 'signed_out');
    const [still] = await db.query('SELECT disabled_at FROM users WHERE id = $1', [greenStaff.id]);
    expect(still.disabled_at).toBeNull();
  });
});

describe('limits and logs', () => {
  it('refuses a request body over 10 KB', async () => {
    const response = await call('POST', '/api/login', { raw: JSON.stringify({ email: 'x'.repeat(11_000), password: 'x' }) });
    expectDenied(response, 413, 'body_too_large');
  });

  it('refuses broken JSON', async () => {
    expectDenied(await call('POST', '/api/login', { raw: '{"email":' }), 400, 'bad_json');
  });

  it('rate-limits the CSV export', async () => {
    const cookie = await signIn(GREEN_OWNER);
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await call('GET', '/api/export/jobs.csv', { cookie })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('writes one JSON log line per request, without secrets or customer details', () => {
    expect(logs.length).toBeGreaterThan(20);
    const line = JSON.parse(logs[0]);
    expect(Object.keys(line).sort()).toEqual(['duration_ms', 'level', 'method', 'path', 'request_id', 'status', 'tenant_id', 'time', 'user_id']);
    const all = logs.join('\n');
    for (const secret of [PASSWORD, 'sid=', 'TEST Ada Lane', 'Example Street', 'one_time_password']) {
      expect(all).not.toContain(secret);
    }
  });

  it('rate-limits login attempts with the default limit of 10 a minute', async () => {
    const strict = createApp({ db, config: loadConfig({}), log: () => {} }).listen(0);
    await new Promise(resolve => strict.once('listening', resolve));
    const url = `http://127.0.0.1:${(strict.address() as AddressInfo).port}/api/login`;
    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: BRIGHT_OWNER, password: 'wrong' }) });
      statuses.push(response.status);
    }
    strict.close();
    expect(statuses.slice(0, 10).every(status => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
