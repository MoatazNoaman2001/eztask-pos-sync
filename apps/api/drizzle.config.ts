import { defineConfig } from 'drizzle-kit';

// Used only by `yarn db:generate` (drizzle-kit generate). Migrations are applied by src/db/migrate.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
