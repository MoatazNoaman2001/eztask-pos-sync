// Applies pending migrations, then exits. Run once by the `migrate` compose service
// before any API instance starts, so two instances never migrate at the same time (docs/risk.md C1).
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  runMigrations(databaseUrl)
    .then(() => console.log('Migrations applied'))
    .catch((error: unknown) => {
      console.error('Migration failed', error);
      process.exit(1);
    });
}
