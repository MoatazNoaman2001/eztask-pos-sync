import { ConflictException, Injectable } from '@nestjs/common';
import { PosSyncRepository, PosSyncWithLease } from '../../sync/repositories/pos-sync.repository';
import { SyncView } from '../../sync/types/sync-view';
import { ChecksService } from './checks.service';

/** Backs GET /checks/:id/sync and POST /checks/:id/sync/retry. */
@Injectable()
export class CheckSyncService {
  constructor(
    private readonly checks: ChecksService,
    private readonly posSync: PosSyncRepository,
  ) {}

  async getSync(checkId: string): Promise<SyncView> {
    await this.checks.findById(checkId); // 404 for an unknown check

    const row = await this.posSync.findByCheckId(checkId);
    return row ? toView(row) : notRequired(checkId);
  }

  async retry(checkId: string): Promise<SyncView> {
    await this.checks.findById(checkId);

    // Only a stopped sync can be retried. Anything else is already being retried automatically.
    if (!(await this.posSync.retryFailed(checkId))) {
      throw new ConflictException(`Sync for check ${checkId} is not stopped (status must be "failed")`);
    }
    return this.getSync(checkId);
  }
}

function toView(row: PosSyncWithLease): SyncView {
  // A live lease on a row with work left means a worker is on it right now.
  const inProgress = row.leased && (row.status === 'pending' || row.status === 'retrying');
  return {
    checkId: row.checkId,
    status: inProgress ? 'in_progress' : row.status,
    desired: row.desired,
    posState: row.posState,
    posOrderId: row.posOrderId,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  };
}

// The check was never paid: nothing has to reach the POS.
function notRequired(checkId: string): SyncView {
  return {
    checkId,
    status: 'not_required',
    desired: null,
    posState: null,
    posOrderId: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };
}
