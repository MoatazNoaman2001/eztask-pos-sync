import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [OrdersModule],
  controllers: [HealthController],
})
export class AppModule {}
