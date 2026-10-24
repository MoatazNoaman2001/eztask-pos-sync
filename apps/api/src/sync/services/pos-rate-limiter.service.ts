import { Inject, Injectable } from '@nestjs/common';
import { API_CONFIG, ApiConfig } from '../../config/api.config';
import { RateLimitRepository, TokenResult } from '../repositories/rate-limit.repository';

/**
 * Every POS call takes a token first: create, lookup and cancel alike (CLAUDE.md rule 5).
 * Our limit (default 4 / 10 s) sits below the POS's 5 / 10 s to absorb network jitter.
 */
@Injectable()
export class PosRateLimiter {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly repository: RateLimitRepository,
  ) {}

  tryAcquire(restaurantId: string): Promise<TokenResult> {
    return this.repository.tryAcquire(restaurantId, this.config.rateLimitMaxRequests, this.config.rateLimitWindowMs);
  }
}
