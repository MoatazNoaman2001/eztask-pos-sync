import { Module } from '@nestjs/common';
import { PosClient } from './pos.client';

@Module({
  providers: [PosClient],
  exports: [PosClient],
})
export class PosModule {}
