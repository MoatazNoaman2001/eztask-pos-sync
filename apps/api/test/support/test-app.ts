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

/** The real API (real Postgres, real modules) wired exactly as in production. */
export async function createTestApp(): Promise<TestApp> {
  process.env.DATABASE_URL = testDatabaseUrl();
  // These tests never reach the POS; the URL just has to be valid.
  process.env.POS_BASE_URL = 'http://pos.invalid';

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
