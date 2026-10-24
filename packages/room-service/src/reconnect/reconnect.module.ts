import { Module } from '@nestjs/common';
import { ReconnectService } from './reconnect.service';

import { RedisProviderModule } from '../redis.provider.module';

@Module({
  imports: [RedisProviderModule],
  providers: [ReconnectService],
  exports: [ReconnectService],
})
export class ReconnectModule {}
