/** What GET /checks/:id/sync returns. `in_progress` and `not_required` are derived, never stored. */
export type SyncViewStatus = 'not_required' | 'pending' | 'in_progress' | 'retrying' | 'failed' | 'synced';

export interface SyncView {
  checkId: string;
  status: SyncViewStatus;
  desired: 'present' | 'absent' | null;
  posState: 'none' | 'unknown' | 'created' | 'cancelled' | null;
  posOrderId: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
}
