import { Inject, Injectable } from '@nestjs/common';
import { POS_CONFIG, PosConfig } from '../config/pos.config';

/**
 * The only place randomness and waiting happen. Tests replace this whole service
 * with a stub, so every failure mode can be triggered on purpose and instantly.
 */
@Injectable()
export class ChaosService {
  constructor(@Inject(POS_CONFIG) private readonly config: PosConfig) {}

  shouldFail(): boolean {
    return Math.random() < this.config.failRate;
  }

  shouldHangAfterCreate(): boolean {
    return Math.random() < this.config.timeoutAfterCreateRate;
  }

  async maybeBeSlow(): Promise<void> {
    if (Math.random() >= this.config.slowRate) return;
    const { slowMinMs, slowMaxMs } = this.config;
    await sleep(slowMinMs + Math.random() * (slowMaxMs - slowMinMs));
  }

  async hangAfterCreate(): Promise<void> {
    await sleep(this.config.hangAfterCreateMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
