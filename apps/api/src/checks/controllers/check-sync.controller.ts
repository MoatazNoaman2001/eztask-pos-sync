import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { SyncView } from '../../sync/types/sync-view';
import { CheckSyncService } from '../services/check-sync.service';

@Controller('checks/:id/sync')
export class CheckSyncController {
  constructor(private readonly checkSync: CheckSyncService) {}

  @Get()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SyncView> {
    return this.checkSync.getSync(id);
  }

  // 202: the retry is scheduled, not done. Watch GET /checks/:id/sync for the outcome.
  @Post('retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<SyncView> {
    return this.checkSync.retry(id);
  }
}
