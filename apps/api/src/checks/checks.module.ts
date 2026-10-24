import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { CheckSyncController } from './controllers/check-sync.controller';
import { ChecksController } from './controllers/checks.controller';
import { ChecksRepository } from './repositories/checks.repository';
import { CheckSyncService } from './services/check-sync.service';
import { ChecksService } from './services/checks.service';

@Module({
  imports: [SyncModule],
  controllers: [ChecksController, CheckSyncController],
  providers: [ChecksService, CheckSyncService, ChecksRepository],
})
export class ChecksModule {}
