import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_CONFIG, ApiConfig } from '../config/api.config';
import { PosSyncRepository } from './repositories/pos-sync.repository';
import { SyncProcessor } from './services/sync-processor.service';

/**
 * Polling loop that runs inside every API instance (docs/architecture.md#where-the-worker-lives).
 * Nothing here is held in memory between polls: retries are rows with a future next_attempt_at,
 * so killing an instance loses no work.
 */
@Injectable()
export class SyncWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SyncWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: PosSyncRepository,
    private readonly processor: SyncProcessor,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.syncWorkerEnabled) return;
    this.running = true;
    this.loop = this.run();
    this.logger.log(`sync worker started as ${this.config.instanceId}`);
  }

  // On SIGTERM: stop claiming, let in-flight rows finish. If we're killed instead,
  // the leases expire and another instance picks the rows up.
  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Claims one batch of due rows and processes it. Public so tests can drive the worker by hand. */
  async processDue(owner: string = this.config.instanceId): Promise<number> {
    const rows = await this.repository.claimDue(owner, this.config.syncLeaseMs, this.config.syncBatchSize);

    // Rows run in parallel; the rate limiter serialises rows of the same restaurant.
    await Promise.all(
      rows.map((row) =>
        this.processor.process(row.checkId, owner).catch((error: unknown) => {
          // The row keeps its lease until expiry, then gets picked up again.
          this.logger.error(`sync of check ${row.checkId} crashed`, error instanceof Error ? error.stack : error);
        }),
      ),
    );
    return rows.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.processDue();
      } catch (error) {
        this.logger.error('sync poll failed', error instanceof Error ? error.stack : error);
      }
      // A full batch suggests more work is waiting: poll again straight away.
      if (claimed < this.config.syncBatchSize) await sleep(this.config.syncPollIntervalMs);
    }
  }
}
