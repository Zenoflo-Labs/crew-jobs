import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import type { Queryable } from './db.ts';

const scryptAsync = promisify(scrypt) as (password: string, salt: string, length: number) => Promise<Buffer>;

export interface SessionUser {
  id: number;
  tenant_id: number;
  role: 'owner' | 'staff';
  email: string;
  tenant: string;
}

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 7;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt, 32);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, expected] = stored.split('$');
  const actual = await scryptAsync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

// The database keeps only a hash of each session token, never the token itself.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(db: Queryable, userId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [userId, hashToken(token)],
  );
  return token;
}

export function sessionToken(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return undefined;
}

export async function loadUser(db: Queryable, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token) return undefined;
  const rows = await db.query<SessionUser>(
    `SELECT u.id, u.tenant_id, u.role, u.email, t.name AS tenant
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  return rows[0];
}

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}
