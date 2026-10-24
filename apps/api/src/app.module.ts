import { Module } from '@nestjs/common';
import { ChecksModule } from './checks/checks.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { HealthController } from './health.controller';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [ConfigModule, DatabaseModule, ChecksModule, SyncModule],
  controllers: [HealthController],
})
export class AppModule {}
