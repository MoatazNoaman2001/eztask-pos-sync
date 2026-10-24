import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { API_CONFIG, ApiConfig } from '../config/api.config';
import { Database, DB, PG_POOL } from './db.tokens';
import * as schema from './schema';
import { TransactionRunner } from './transaction';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => new Pool({ connectionString: config.databaseUrl }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
    TransactionRunner,
  ],
  exports: [DB, TransactionRunner],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Close connections on SIGTERM so Postgres doesn't keep dead sessions around.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
