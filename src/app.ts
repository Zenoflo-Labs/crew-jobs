import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadUser, sessionToken } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { DEFAULT_LIMITS, fail, Invalid, RateLimiter, type Ctx, type Limits } from './http.ts';
import { routes } from './routes.ts';

export interface AppOptions {
  db: Db;
  config: Config;
  log?: (line: string) => void;
  limits?: Limits;
}

export function createApp({ db, config, log = line => console.log(line), limits = DEFAULT_LIMITS }: AppOptions) {
  const app = express();
  const limiter = new RateLimiter();
  app.disable('x-powered-by');

  // One JSON log line per request. Never passwords, tokens, cookies, names or addresses.
  app.use((req, res, next) => {
    const started = performance.now();
    res.locals.requestId = randomUUID().slice(0, 8);
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.on('finish', () => log(JSON.stringify({
      time: new Date().toISOString(),
      level: res.statusCode >= 500 ? 'error' : 'info',
      request_id: res.locals.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
      tenant_id: res.locals.user?.tenant_id ?? null,
      user_id: res.locals.user?.id ?? null,
    })));
    next();
  });

  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { index: false }));

  for (const route of routes) {
    app[route.method](route.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = route.who === 'anyone' ? undefined : await loadUser(db, sessionToken(req));
        res.locals.user = user;
        if (route.who !== 'anyone' && !user) return fail(res, 401, 'signed_out');
        if (route.who === 'owner' && user!.role !== 'owner') return fail(res, 403, 'owner_only');
        const ctx: Ctx = { db, config, user, limiter, limits };
        await route.handler(req, res, ctx);
      } catch (error) {
        next(error);
      }
    });
  }

  app.use('/api', (_req, res) => fail(res, 404, 'not_found'));

  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof Invalid) return fail(res, 400, 'invalid', { field: error.field, reason: error.reason });
    if (error?.type === 'entity.too.large') return fail(res, 413, 'body_too_large');
    if (error?.type === 'entity.parse.failed') return fail(res, 400, 'bad_json');
    log(JSON.stringify({ time: new Date().toISOString(), level: 'error', request_id: res.locals.requestId, message: String(error?.message ?? error) }));
    fail(res, 500, 'server_error');
  });

  return app;
}
