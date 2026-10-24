import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Database, DB } from '../../db/db.tokens';
import { Check, posSync, PosSync } from '../../db/schema';
import { DbExecutor } from '../../db/transaction';

export type PosSyncWithLease = PosSync & { leased: boolean };

/**
 * Data access for the pos_sync outbox.
 *
 * The methods here are the HTTP side's writes. Column ownership (docs/sync-state-machine.md):
 * the HTTP side owns `desired`; the worker owns pos_state, pos_order_id, attempts, lease_*.
 * So these methods never touch worker columns, except the manual retry resetting `attempts`.
 */
@Injectable()
export class PosSyncRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Called by /pay inside its transaction: the outbox row is written with the payment, or not at all. */
  async createForPaidCheck(check: Check, tx: DbExecutor = this.db): Promise<void> {
    await tx.insert(posSync).values({
      checkId: check.id,
      restaurantId: check.restaurantId,
      desired: 'present',
    });
  }

  /**
   * Called by /cancel inside its transaction. Flips what we want and wakes the row;
   * the worker decides whether the POS needs a cancel, a lookup, or nothing.
   */
  async requestCancellation(checkId: string, tx: DbExecutor = this.db): Promise<void> {
    await tx
      .update(posSync)
      .set({ desired: 'absent', status: 'pending', nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(posSync.checkId, checkId));
  }

  /** Only a stopped (`failed`) sync can be retried. Returns false if there was nothing to retry. */
  async retryFailed(checkId: string, tx: DbExecutor = this.db): Promise<boolean> {
    const rows = await tx
      .update(posSync)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(posSync.checkId, checkId), eq(posSync.status, 'failed')))
      .returning({ checkId: posSync.checkId });
    return rows.length > 0;
  }

  async findByCheckId(checkId: string, tx: DbExecutor = this.db): Promise<PosSyncWithLease | undefined> {
    const [row] = await tx
      .select({
        row: posSync,
        // Compared in Postgres so instance clocks never matter (CLAUDE.md rule 6).
        leased: sql<boolean>`coalesce(${posSync.leaseUntil} > now(), false)`,
      })
      .from(posSync)
      .where(eq(posSync.checkId, checkId));
    return row ? { ...row.row, leased: row.leased } : undefined;
  }
}
