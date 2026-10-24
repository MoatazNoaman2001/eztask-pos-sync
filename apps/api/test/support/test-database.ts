import path from 'node:path';

/**
 * Integration tests use their own database, `<your db>_test`, on the same server as DATABASE_URL.
 * It is dropped and re-created on every run, so tests never touch development data.
 */
export function testDatabaseUrl(): string {
  loadDotEnv();
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error('DATABASE_URL is not set. Run `yarn setup`, start Postgres (`docker compose up -d postgres`), retry.');
  }
  const url = new URL(base);
  url.pathname = `/${databaseName(base)}_test`;
  return url.toString();
}

export function databaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.slice(1);
}

// Locally the values live in the repo's .env; in CI they come from the environment.
function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.resolve(__dirname, '../../../../.env'));
  } catch {
    // No .env file: rely on the environment.
  }
}
