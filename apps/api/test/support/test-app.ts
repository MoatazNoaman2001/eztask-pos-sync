import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { Server } from 'node:http';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/configure-app';
import { Database, DB } from '../../src/db/db.tokens';
import { testDatabaseUrl } from './test-database';

export interface TestApp {
  app: INestApplication;
  server: Server;
  db: Database;
  close(): Promise<void>;
}

/**
 * The real API (real Postgres, real modules) wired exactly as in production.
 * The worker loop is off: tests that need it drive it by hand with SyncWorker.processDue().
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, {
    DATABASE_URL: testDatabaseUrl(),
    POS_BASE_URL: 'http://pos.invalid', // overridden by tests that talk to a POS
    SYNC_WORKER_ENABLED: 'false',
    ...env,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  // Listen once on a random port: supertest then reuses it instead of starting a server per request.
  await app.listen(0);

  return {
    app,
    server: app.getHttpServer() as Server,
    db: app.get<Database>(DB),
    close: () => app.close(),
  };
}

export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE checks, pos_sync, pos_rate_limit, pos_request_log RESTART IDENTITY CASCADE`);
}
