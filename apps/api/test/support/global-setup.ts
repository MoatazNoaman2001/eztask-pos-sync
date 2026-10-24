import { Client } from 'pg';
import { runMigrations } from '../../src/db/migrate';
import { databaseName, testDatabaseUrl } from './test-database';

// Runs once before all integration tests: a fresh, fully migrated test database.
export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = databaseName(url);

  // CREATE/DROP DATABASE can't run inside the database itself, so connect to the default one.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  await runMigrations(url);
}
