import { Module } from '@nestjs/common';
import { RedisProviderModule } from '../redis.provider.module';
import { RpcClientsModule } from './rpc-clients.module';
import { RecordOutboxService } from './record-outbox.service';

/**
 * C1：记录补偿队列的装配单元。
 *
 * - `RpcClientsModule` 提供 `RecordClient`（`record.write`）；
 * - `RedisProviderModule` 提供 Redis；
 * - 两处消费方（`WsGateway` 写前入箱、`SettleSweeper` 重投）都 import 本模块，
 *   Nest 的模块单例保证拿到**同一个** `RecordOutboxService`。
 */
@Module({
  imports: [RedisProviderModule, RpcClientsModule],
  providers: [RecordOutboxService],
  exports: [RecordOutboxService],
})
export class RecordOutboxModule {}
