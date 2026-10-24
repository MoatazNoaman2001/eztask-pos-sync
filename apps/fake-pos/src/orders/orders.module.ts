import { Module } from '@nestjs/common';
import { ChaosService } from '../chaos/chaos.service';
import { loadPosConfig, POS_CONFIG, PosConfig } from '../config/pos.config';
import { SlidingWindowLimiter } from '../rate-limit/sliding-window.limiter';
import { DebugController } from './debug.controller';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersStore } from './orders.store';

@Module({
  controllers: [OrdersController, DebugController],
  providers: [
    OrdersService,
    OrdersStore,
    ChaosService,
    { provide: POS_CONFIG, useFactory: () => loadPosConfig() },
    {
      provide: SlidingWindowLimiter,
      inject: [POS_CONFIG],
      useFactory: (config: PosConfig) =>
        new SlidingWindowLimiter(config.rateLimitMaxRequests, config.rateLimitWindowMs),
    },
  ],
})
export class OrdersModule {}
