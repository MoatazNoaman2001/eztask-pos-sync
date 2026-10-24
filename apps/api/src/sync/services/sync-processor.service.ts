import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_CONFIG, ApiConfig } from '../../config/api.config';
import { PosSync } from '../../db/schema';
import { PosClient } from '../../pos/pos.client';
import { PosResult } from '../../pos/pos.types';
import { backoffMs } from '../domain/backoff';
import { nextAction } from '../domain/next-action';
import { PosSyncRepository } from '../repositories/pos-sync.repository';
import { PosRateLimiter } from './pos-rate-limiter.service';

// A claim does at most this many POS calls (e.g. lookup → create) before handing the row back.
const MAX_STEPS_PER_CLAIM = 4;

type StepEnd = 'continue' | 'stop';

/**
 * Drives one claimed pos_sync row towards `desired`, one POS call per step:
 *   renew lease (re-reads desired) → decide → take a rate-limit token → call the POS → record.
 *
 * Crash safety: before sending a create we commit pos_state = 'unknown'. If this process dies
 * anywhere after that, the next worker sees 'unknown' and looks the order up instead of
 * creating it again (CLAUDE.md rule 3).
 */
@Injectable()
export class SyncProcessor {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: PosSyncRepository,
    private readonly limiter: PosRateLimiter,
    private readonly pos: PosClient,
  ) {}

  async process(checkId: string, owner: string): Promise<void> {
    for (let step = 0; step < MAX_STEPS_PER_CLAIM; step++) {
      // Also our "is it still ours?" check: no row means another worker took over.
      const row = await this.repository.renewLease(checkId, owner, this.config.syncLeaseMs);
      if (!row) return;

      if ((await this.step(row, owner)) === 'stop') return;
    }
    await this.repository.releaseNow(checkId, owner);
  }

  private async step(row: PosSync, owner: string): Promise<StepEnd> {
    const action = nextAction(row.desired, row.posState);

    // A false return from a guarded write means `desired` changed under us (a cancel landed):
    // keep going, and the next step re-reads the row and decides again.
    if (action === 'done') {
      return (await this.repository.markSynced(row.checkId, owner, row.desired)) ? 'stop' : 'continue';
    }

    const token = await this.limiter.tryAcquire(row.restaurantId);
    if (!token.acquired) {
      return (await this.repository.postpone(row.checkId, owner, row.desired, token.retryInMs)) ? 'stop' : 'continue';
    }

    switch (action) {
      case 'create':
        return this.create(row, owner);
      case 'lookup':
        return this.lookup(row, owner);
      case 'cancel':
        return this.cancel(row, owner);
    }
  }

  private async create(row: PosSync, owner: string): Promise<StepEnd> {
    const payload = await this.repository.findOrderPayload(row.checkId);
    if (!payload) throw new Error(`Check ${row.checkId} has a sync row but no check`);

    // Committed before the request leaves: from here on, every path leads to a lookup.
    if (!(await this.repository.recordPosState(row.checkId, owner, 'unknown'))) return 'stop';

    const result = await this.pos.createOrder({ externalRef: row.checkId, ...payload });

    if (result.kind === 'ok') {
      this.logger.log(`created POS order ${result.value.posOrderId} for check ${row.checkId}`);
      await this.repository.recordPosState(row.checkId, owner, 'created', result.value.posOrderId);
      return 'continue';
    }
    // 429 and 4xx answers mean the POS refused before creating anything.
    if (result.kind === 'rate_limited' || result.kind === 'rejected') {
      await this.repository.recordPosState(row.checkId, owner, 'none');
    }
    // 5xx and timeouts leave 'unknown': the next attempt looks it up first.
    return this.handleFailure(row, owner, result);
  }

  private async lookup(row: PosSync, owner: string): Promise<StepEnd> {
    const result = await this.pos.findOrders(row.checkId, row.restaurantId);
    if (result.kind !== 'ok') return this.handleFailure(row, owner, result);

    const open = result.value.filter((order) => order.status === 'open');
    if (open.length > 1) {
      // Should never happen with this design. Log loudly; the chaos test would catch it too.
      this.logger.error(`check ${row.checkId} has ${open.length} open POS orders`);
    }

    const [found] = open;
    if (found) {
      this.logger.log(`lookup found POS order ${found.posOrderId} for check ${row.checkId}`);
      await this.repository.recordPosState(row.checkId, owner, 'created', found.posOrderId);
    } else {
      await this.repository.recordPosState(row.checkId, owner, 'none');
    }
    return 'continue';
  }

  private async cancel(row: PosSync, owner: string): Promise<StepEnd> {
    if (!row.posOrderId) {
      // We think it exists but don't know its id: find it first.
      await this.repository.recordPosState(row.checkId, owner, 'unknown');
      return 'continue';
    }

    // Cancelling twice is harmless, so a timed-out cancel can simply be retried.
    const result = await this.pos.cancelOrder(row.posOrderId);
    if (result.kind !== 'ok') return this.handleFailure(row, owner, result);

    this.logger.log(`cancelled POS order ${row.posOrderId} for check ${row.checkId}`);
    await this.repository.recordPosState(row.checkId, owner, 'cancelled');
    return 'continue';
  }

  private async handleFailure(
    row: PosSync,
    owner: string,
    result: Exclude<PosResult<unknown>, { kind: 'ok' }>,
  ): Promise<StepEnd> {
    let written: boolean;
    switch (result.kind) {
      case 'rate_limited':
        // Our limiter should prevent this; if it happens anyway, wait out the POS window.
        written = await this.repository.postpone(row.checkId, owner, row.desired, this.config.rateLimitWindowMs);
        break;
      case 'rejected':
        this.logger.warn(`POS rejected check ${row.checkId}: ${result.message}`);
        written = await this.repository.markFailed(row.checkId, owner, row.desired, result.message);
        break;
      case 'failed': {
        const attempts = row.attempts + 1;
        this.logger.warn(`attempt ${attempts} for check ${row.checkId} failed: ${result.message}`);
        written = await this.repository.scheduleRetry(row.checkId, owner, row.desired, {
          attempts,
          delayMs: backoffMs(attempts),
          error: result.message,
        });
        break;
      }
    }
    return written ? 'stop' : 'continue';
  }
}
