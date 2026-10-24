import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { SlidingWindowLimiter } from '../rate-limit/sliding-window.limiter';
import { PosOrder } from './order.types';
import { OrdersStore } from './orders.store';

// Test-only endpoints. They skip the rate limit and the failure modes,
// so tests can always see the true state of the POS.
@Controller('debug')
export class DebugController {
  constructor(
    private readonly store: OrdersStore,
    private readonly limiter: SlidingWindowLimiter,
  ) {}

  @Get('orders')
  allOrders(): PosOrder[] {
    return this.store.all();
  }

  // Lets each chaos run start from an empty POS without restarting the container.
  @Post('reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  reset(): void {
    this.store.clear();
    this.limiter.reset();
  }
}
