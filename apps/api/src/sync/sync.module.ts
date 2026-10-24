import { Module } from '@nestjs/common';
import { PosSyncRepository } from './repositories/pos-sync.repository';

// Owns the pos_sync outbox. The sync worker that delivers it to the POS lands here next.
@Module({
  providers: [PosSyncRepository],
  exports: [PosSyncRepository],
})
export class SyncModule {}
