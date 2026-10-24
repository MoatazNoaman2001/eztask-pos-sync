import { Module } from '@nestjs/common';
import { PosModule } from '../pos/pos.module';
import { PosSyncRepository } from './repositories/pos-sync.repository';
import { RateLimitRepository } from './repositories/rate-limit.repository';
import { PosRateLimiter } from './services/pos-rate-limiter.service';
import { SyncProcessor } from './services/sync-processor.service';
import { SyncWorker } from './sync.worker';

// Owns the pos_sync outbox and the worker that delivers it to the POS.
@Module({
  imports: [PosModule],
  providers: [PosSyncRepository, RateLimitRepository, PosRateLimiter, SyncProcessor, SyncWorker],
  exports: [PosSyncRepository],
})
export class SyncModule {}
