import { Module } from '@nestjs/common';
import { ChaosService } from '../chaos/chaos.service';
import { loadPosConfig, POS_CONFIG, PosConfig } from '../config/pos.config';
import { SlidingWindowLimiter } from '../rate-limit/sliding-window.limiter';
import { DebugController } from './controllers/debug.controller';
import { OrdersController } from './controllers/orders.controller';
import { OrdersService } from './services/orders.service';
import { OrdersRepository } from './repositories/orders.repository';

@Module({
  controllers: [OrdersController, DebugController],
  providers: [
    OrdersService,
    OrdersRepository,
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
