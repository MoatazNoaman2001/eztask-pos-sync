import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SlidingWindowLimiter } from '../../rate-limit/sliding-window.limiter';
import { PosOrder } from '../types/pos-order';
import { OrdersRepository } from '../repositories/orders.repository';

// Test-only endpoints. They skip the rate limit and the failure modes,
// so tests can always see the true state of the POS.
@Controller('debug')
export class DebugController {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly limiter: SlidingWindowLimiter,
  ) {}

  @Get('orders')
  allOrders(): PosOrder[] {
    return this.repository.all();
  }

  // Lets each chaos run start from an empty POS without restarting the container.
  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  reset(): void {
    this.repository.clear();
    this.limiter.reset();
  }
}
