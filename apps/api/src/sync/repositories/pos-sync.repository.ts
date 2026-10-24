import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte, or, SQL, sql } from 'drizzle-orm';
import { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { Database, DB } from '../../db/db.tokens';
import { Check, CheckItem, checks, posSync, PosSync } from '../../db/schema';
import { DbExecutor } from '../../db/transaction';

export type PosSyncWithLease = PosSync & { leased: boolean };

export interface OrderPayload {
  restaurantId: string;
  items: CheckItem[];
  total: number;
}

/**
 * Data access for the pos_sync outbox.
 *
 * Column ownership (docs/sync-state-machine.md#column-ownership-hard-rule):
 * - HTTP side (/pay, /cancel, /retry) owns `desired`, and wakes rows via status + next_attempt_at.
 * - Worker side owns pos_state, pos_order_id, attempts, last_error, lease_*.
 * Every worker write is guarded by `lease_owner = me`, so a worker that lost its lease can't
 * overwrite newer state. Status writes are also guarded by the `desired` the worker acted on,
 * so a cancel that lands mid-step is never overwritten (docs/risk.md A5).
 */
@Injectable()
export class PosSyncRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  // ---------- HTTP side ----------

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

  // ---------- Worker side ----------

  /**
   * Claims up to `limit` due rows for `owner`. FOR UPDATE SKIP LOCKED means two instances
   * claiming at the same moment never get the same row; the lease means a killed instance's
   * rows become claimable again once it expires.
   */
  async claimDue(owner: string, leaseMs: number, limit: number): Promise<PosSync[]> {
    const due = this.db
      .select({ checkId: posSync.checkId })
      .from(posSync)
      .where(
        and(
          inArray(posSync.status, ['pending', 'retrying']),
          lte(posSync.nextAttemptAt, sql`now()`),
          or(isNull(posSync.leaseUntil), lt(posSync.leaseUntil, sql`now()`)),
        ),
      )
      .orderBy(asc(posSync.nextAttemptAt))
      .limit(limit)
      .for('update', { skipLocked: true });

    return this.db
      .update(posSync)
      .set({ leaseOwner: owner, leaseUntil: msFromNow(leaseMs) })
      .where(inArray(posSync.checkId, due))
      .returning();
  }

  /** Extends our lease before each step and returns the fresh row (including a changed `desired`). */
  async renewLease(checkId: string, owner: string, leaseMs: number): Promise<PosSync | undefined> {
    const [row] = await this.db
      .update(posSync)
      .set({ leaseUntil: msFromNow(leaseMs) })
      .where(ownedBy(checkId, owner))
      .returning();
    return row;
  }

  async findOrderPayload(checkId: string): Promise<OrderPayload | undefined> {
    const [row] = await this.db
      .select({ restaurantId: checks.restaurantId, items: checks.items, total: checks.total })
      .from(checks)
      .where(eq(checks.id, checkId));
    return row;
  }

  /** Records what we now know the POS holds. Must be committed before acting on it. */
  recordPosState(checkId: string, owner: string, posState: PosSync['posState'], posOrderId?: string): Promise<boolean> {
    return this.write(ownedBy(checkId, owner), {
      posState,
      ...(posOrderId !== undefined && { posOrderId }),
    });
  }

  markSynced(checkId: string, owner: string, desired: PosSync['desired']): Promise<boolean> {
    return this.write(ownedFor(checkId, owner, desired), { status: 'synced', lastError: null, ...releaseLease });
  }

  /** Temporary failure: count it and back off. */
  scheduleRetry(
    checkId: string,
    owner: string,
    desired: PosSync['desired'],
    retry: { attempts: number; delayMs: number; error: string },
  ): Promise<boolean> {
    return this.write(ownedFor(checkId, owner, desired), {
      status: 'retrying',
      attempts: retry.attempts,
      lastError: retry.error,
      nextAttemptAt: msFromNow(retry.delayMs),
      ...releaseLease,
    });
  }

  /** Out of rate-limit budget: come back later. Not a failure, so attempts and status stay. */
  postpone(checkId: string, owner: string, desired: PosSync['desired'], delayMs: number): Promise<boolean> {
    return this.write(ownedFor(checkId, owner, desired), { nextAttemptAt: msFromNow(delayMs), ...releaseLease });
  }

  /** Permanent rejection: stop retrying until someone calls /sync/retry. */
  markFailed(checkId: string, owner: string, desired: PosSync['desired'], error: string): Promise<boolean> {
    return this.write(ownedFor(checkId, owner, desired), { status: 'failed', lastError: error, ...releaseLease });
  }

  /** Hand the row back, due immediately (used when a claim ran out of steps). */
  releaseNow(checkId: string, owner: string): Promise<boolean> {
    return this.write(ownedBy(checkId, owner), { nextAttemptAt: sql`now()`, ...releaseLease });
  }

  private async write(where: SQL | undefined, values: PgUpdateSetSource<typeof posSync>): Promise<boolean> {
    const rows = await this.db
      .update(posSync)
      .set({ ...values, updatedAt: sql`now()` })
      .where(where)
      .returning({ checkId: posSync.checkId });
    return rows.length > 0;
  }
}

const releaseLease = { leaseOwner: null, leaseUntil: null };

function msFromNow(ms: number): SQL {
  return sql`now() + (${ms}::int * interval '1 millisecond')`;
}

function ownedBy(checkId: string, owner: string): SQL | undefined {
  return and(eq(posSync.checkId, checkId), eq(posSync.leaseOwner, owner));
}

function ownedFor(checkId: string, owner: string, desired: PosSync['desired']): SQL | undefined {
  return and(ownedBy(checkId, owner), eq(posSync.desired, desired));
}
