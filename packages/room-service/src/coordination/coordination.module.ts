import { Global, Module } from '@nestjs/common';
import { ConnectionRegistry } from './connection-registry.service';
import { FinalizationGuard } from './finalization-guard.service';
import { LeaderLease } from './leader-lease.service';

/**
 * 多副本协调件（spec 2026-10-27 D12/D13）。
 * `@Global`：WsGateway 用属性注入（不改变 13 个构造参数的 wiring 门禁），
 * 各定时循环服务也直接注入同一个单例。
 */
@Global()
@Module({
  providers: [ConnectionRegistry, LeaderLease, FinalizationGuard],
  exports: [ConnectionRegistry, LeaderLease, FinalizationGuard],
})
export class CoordinationModule {}
