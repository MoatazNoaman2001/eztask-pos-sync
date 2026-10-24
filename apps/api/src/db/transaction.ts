import { Inject, Injectable } from '@nestjs/common';
import { Database, DB } from './db.tokens';

/** The handle Drizzle passes into a transaction callback. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Repositories accept either: the plain client, or a transaction they should join. */
export type DbExecutor = Database | DbTransaction;

/**
 * Lets services draw a transaction boundary without touching the Drizzle client
 * (CLAUDE.md rule 14). Repositories run their queries on the `tx` they are given.
 */
@Injectable()
export class TransactionRunner {
  constructor(@Inject(DB) private readonly db: Database) {}

  run<T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}
