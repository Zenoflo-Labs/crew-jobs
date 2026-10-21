import type { Response } from 'express';
import type { SessionUser } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';

export interface Ctx {
  db: Db;
  config: Config;
  user: SessionUser | undefined;
  limiter: RateLimiter;
  limits: Limits;
}

// Requests allowed per minute.
export interface Limits {
  loginPerIp: number;
  exportsPerUser: number;
}
export const DEFAULT_LIMITS: Limits = { loginPerIp: 10, exportsPerUser: 5 };

// Every JSON error looks like { error, request_id }. A denied response never
// includes any field of the thing that was denied.
export function fail(res: Response, status: number, error: string, extra: Record<string, string> = {}): void {
  res.status(status).json({ error, ...extra, request_id: res.locals.requestId });
}

export class Invalid extends Error {
  constructor(public field: string, public reason: string) {
    super(`${field}: ${reason}`);
  }
}

// Fixed-window limits kept in memory. Enough for one server process.
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  }
}
