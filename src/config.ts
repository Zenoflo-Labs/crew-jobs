export type AppEnv = 'local' | 'staging' | 'production';

export interface Config {
  env: AppEnv;
  port: number;
  host: string;
  databaseUrl: string | undefined;
  dataDir: string;
  seedPassword: string;
  version: string;
}

// Every secret comes from an environment variable. Local use needs none.
export function loadConfig(vars: NodeJS.ProcessEnv = process.env): Config {
  const env = (vars.APP_ENV || 'local') as AppEnv;
  if (!['local', 'staging', 'production'].includes(env)) {
    throw new Error(`APP_ENV must be local, staging or production, not "${env}"`);
  }
  const missing = env === 'local' ? [] : ['DATABASE_URL', 'SEED_PASSWORD'].filter(name => !vars[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s) for ${env}: ${missing.join(', ')}`);
  }
  return {
    env,
    port: Number(vars.PORT || 3000),
    host: env === 'local' ? '127.0.0.1' : '0.0.0.0',
    databaseUrl: vars.DATABASE_URL || undefined,
    dataDir: vars.DATA_DIR || './data',
    seedPassword: vars.SEED_PASSWORD || 'test-password',
    version: vars.COMMIT_SHA || 'dev',
  };
}
