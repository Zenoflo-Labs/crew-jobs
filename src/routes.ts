import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import { cookieOptions, createSession, hashPassword, hashToken, sessionToken, SESSION_COOKIE, verifyPassword } from './auth.ts';
import { fail, type Ctx } from './http.ts';
import { idParam, jobInput, staffEmail } from './validate.ts';

type Who = 'anyone' | 'signed-in' | 'owner';
export interface Route {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  who: Who;
  handler: (req: Request, res: Response, ctx: Ctx) => Promise<void>;
}

const JOB_COLUMNS = 'j.id, j.customer_name, j.address, j.description, j.status, j.scheduled_for, j.assigned_user_id';
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
// Used when an email doesn't exist, so a wrong email takes as long as a wrong password.
const dummyHash = await hashPassword(randomBytes(8).toString('hex'));

// The single route list. The size budget allows 15; one stays spare for the capstone.
export const routes: Route[] = [
  { method: 'get', path: '/', who: 'anyone', handler: async (_req, res, { config }) => {
    res.type('html').send(indexHtml.replaceAll('{{ENV_LABEL}}', config.env.toUpperCase()).replaceAll('{{ENV}}', config.env));
  } },

  { method: 'get', path: '/health', who: 'anyone', handler: async (_req, res, { db, config }) => {
    const ok = await db.query('SELECT 1').then(() => true, () => false);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', version: config.version, db: ok ? 'ok' : 'error' });
  } },

  { method: 'post', path: '/api/login', who: 'anyone', handler: async (req, res, { db, config, limiter, limits }) => {
    if (!limiter.allow(`login:${req.ip}`, limits.loginPerIp, 60_000)) return fail(res, 429, 'too_many_attempts');
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') return fail(res, 400, 'email_and_password_required');
    const [user] = await db.query(
      `SELECT u.id, u.email, u.role, u.password_hash, t.name AS tenant
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = $1 AND u.disabled_at IS NULL`,
      [email.trim().toLowerCase()],
    );
    const valid = await verifyPassword(password, user?.password_hash ?? dummyHash);
    if (!user || !valid) return fail(res, 401, 'wrong_email_or_password');
    const token = await createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, cookieOptions(config.env !== 'local'));
    res.json({ email: user.email, role: user.role, tenant: user.tenant });
  } },

  { method: 'post', path: '/api/logout', who: 'signed-in', handler: async (req, res, { db }) => {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(sessionToken(req) ?? '')]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  } },

  { method: 'get', path: '/api/me', who: 'signed-in', handler: async (_req, res, { user }) => {
    res.json({ email: user!.email, role: user!.role, tenant: user!.tenant });
  } },

  { method: 'get', path: '/api/jobs', who: 'signed-in', handler: async (_req, res, { db, user }) => {
    const owner = user!.role === 'owner';
    const jobs = await db.query(
      `SELECT ${JOB_COLUMNS}${owner ? ', i.id AS invoice_id' : ''}
         FROM jobs j
         LEFT JOIN invoices i ON i.job_id = j.id AND i.tenant_id = j.tenant_id
        WHERE j.tenant_id = $1
        ORDER BY j.scheduled_for, j.id`,
      [user!.tenant_id],
    );
    res.json({ jobs });
  } },

  { method: 'post', path: '/api/jobs', who: 'signed-in', handler: async (req, res, { db, user }) => {
    const input = await jobInput(db, user!.tenant_id, req.body, true);
    const [job] = await db.query(
      `INSERT INTO jobs AS j (tenant_id, customer_name, address, description, status, scheduled_for, assigned_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${JOB_COLUMNS}`,
      [user!.tenant_id, input.customer_name, input.address, input.description ?? '', input.status ?? 'scheduled',
        input.scheduled_for, input.assigned_user_id ?? null],
    );
    res.status(201).json({ job });
  } },

  { method: 'get', path: '/api/jobs/:id', who: 'signed-in', handler: async (req, res, { db, user }) => {
    const owner = user!.role === 'owner';
    const [job] = await db.query(
      `SELECT ${JOB_COLUMNS}${owner ? ', i.id AS invoice_id' : ''}
         FROM jobs j
         LEFT JOIN invoices i ON i.job_id = j.id AND i.tenant_id = j.tenant_id
        WHERE j.id = $1 AND j.tenant_id = $2`,
      [idParam(req.params.id) ?? 0, user!.tenant_id],
    );
    if (!job) return fail(res, 404, 'not_found');
    res.json({ job });
  } },

  { method: 'patch', path: '/api/jobs/:id', who: 'signed-in', handler: async (req, res, { db, user }) => {
    const id = idParam(req.params.id);
    const [exists] = await db.query('SELECT 1 FROM jobs WHERE id = $1 AND tenant_id = $2', [id ?? 0, user!.tenant_id]);
    if (!exists) return fail(res, 404, 'not_found');
    const input = await jobInput(db, user!.tenant_id, req.body, false);
    const fields = Object.keys(input);
    const sets = fields.map((field, index) => `${field} = $${index + 3}`).join(', ');
    const [job] = await db.query(
      `UPDATE jobs j SET ${sets}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING ${JOB_COLUMNS}`,
      [id, user!.tenant_id, ...fields.map(field => input[field as keyof typeof input])],
    );
    res.json({ job });
  } },

  { method: 'get', path: '/api/invoices/:id', who: 'owner', handler: async (req, res, { db, user }) => {
    const [invoice] = await db.query(
      `SELECT id, job_id, amount_cents, status, issued_on, due_on
         FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [idParam(req.params.id) ?? 0, user!.tenant_id],
    );
    if (!invoice) return fail(res, 404, 'not_found');
    res.json({ invoice });
  } },

  { method: 'get', path: '/api/export/jobs.csv', who: 'owner', handler: async (_req, res, { db, user, limiter, limits }) => {
    if (!limiter.allow(`export:${user!.id}`, limits.exportsPerUser, 60_000)) return fail(res, 429, 'too_many_exports');
    const rows = await db.query(
      `SELECT j.id, j.customer_name, j.status, j.scheduled_for, i.amount_cents
         FROM jobs j
         LEFT JOIN invoices i ON i.job_id = j.id AND i.tenant_id = j.tenant_id
        WHERE j.tenant_id = $1
        ORDER BY j.id`,
      [user!.tenant_id],
    );
    const lines = [['job_id', 'customer_name', 'status', 'scheduled_for', 'invoice_total'].join(',')];
    for (const row of rows) {
      const total = row.amount_cents === null ? '' : (row.amount_cents / 100).toFixed(2);
      lines.push([row.id, row.customer_name, row.status, row.scheduled_for, total].map(csvCell).join(','));
    }
    res.type('text/csv').attachment('jobs.csv').send(lines.join('\r\n') + '\r\n');
  } },

  { method: 'get', path: '/api/staff', who: 'owner', handler: async (_req, res, { db, user }) => {
    const staff = await db.query(
      'SELECT id, email, role, created_at, disabled_at FROM users WHERE tenant_id = $1 ORDER BY id',
      [user!.tenant_id],
    );
    res.json({ staff });
  } },

  { method: 'post', path: '/api/staff', who: 'owner', handler: async (req, res, { db, user }) => {
    const email = staffEmail(req.body);
    const [taken] = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (taken) return fail(res, 409, 'email_taken');
    // Shown once in this response, never stored or logged in plain text.
    const password = randomBytes(9).toString('base64url');
    const [staff] = await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'staff')
       RETURNING id, email, role, created_at, disabled_at`,
      [user!.tenant_id, email, await hashPassword(password)],
    );
    res.status(201).json({ staff, one_time_password: password });
  } },

  { method: 'delete', path: '/api/staff/:id', who: 'owner', handler: async (req, res, { db, user }) => {
    const removed = await db.transaction(async tx => {
      const rows = await tx.query(
        `UPDATE users SET disabled_at = now()
          WHERE id = $1 AND tenant_id = $2 AND role = 'staff' AND disabled_at IS NULL RETURNING id`,
        [idParam(req.params.id) ?? 0, user!.tenant_id],
      );
      if (rows.length > 0) await tx.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
      return rows.length > 0;
    });
    if (!removed) return fail(res, 404, 'not_found');
    res.status(204).end();
  } },
];

// Quotes cells that need it, and stops spreadsheet apps treating text as a formula.
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
