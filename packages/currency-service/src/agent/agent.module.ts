import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
import { ConfigModule } from '../config/config.module';
import { AgentSettingsService } from './agent-settings.service';
import { AgentQuotaService } from './agent-quota.service';
import { AgentQuotaMaturityService } from './agent-quota-maturity.service';
import { AgentLedgerService } from './agent-ledger.service';
import { AgentGapService } from './agent-gap.service';
import { AgentInviteService } from './agent-invite.service';
import { AgentBindingsService } from './agent-bindings.service';
import { AgentAccountsService } from './agent-accounts.service';
import { AgentSettlementService } from './agent-settlement.service';
import { AgentAdjustmentService } from './agent-adjustment.service';
import { AgentAuthService } from './agent-auth.service';
import { AgentGuard } from './agent.guard';
import { AgentPortalService } from './agent-portal.service';
import { AgentPortalController } from './agent-portal.controller';
import { AgentBindRpcController } from './agent-bind.rpc.controller';
import {
  AGENT_USER_RPC_PROXY,
  AgentUserClient,
  agentUserClientOptions,
} from './agent-user.client';

/**
 * 代理分润域（spec §4/§8/§9）。
 *
 * 装配纪律（仓内 DI 陷阱）：`ApplyService` 在 `RpcModule`，本模块由 `RpcModule` imports；
 * `AgentLedgerService` 必须在本模块 **exports**，否则真容器解析 `ApplyService` 构造参数时
 * 看不到它（单测 `new` 全绿、启动即崩）。
 *
 * `ConfigModule` 提供 `ConfigCacheService`（`agent.inviteEnabled` 读侧，任务 6 消费）。
 * 本模块**不得** imports `RpcModule`（会成环；钩子不需要 ApplyService）。
 */
@Module({
  imports: [
    ConfigModule,
    // currency → user 的只读边（昵称/单玩家 profile）。与 config 边各自一条 TCP。
    ClientsModule.register([{ name: AGENT_USER_RPC_PROXY, ...agentUserClientOptions() }]),
  ],
  controllers: [AgentBindRpcController, AgentPortalController],
  providers: [
    AgentSettingsService,
    AgentQuotaService,
    AgentQuotaMaturityService,
    AgentGapService,
    AgentInviteService,
    AgentBindingsService,
    AgentAccountsService,
    AgentSettlementService,
    AgentAdjustmentService,
    AgentAuthService,
    AgentPortalService,
    AgentGuard,
    AgentLedgerService,
    {
      provide: AgentUserClient,
      // ⚠️ 必须 useFactory（R216：useClass 看不见带默认值的普通对象参数 ⇒ 启动即崩）。
      useFactory: (p: ClientProxy) => new AgentUserClient(p),
      inject: [AGENT_USER_RPC_PROXY],
    },
  ],
  exports: [
    AgentSettingsService,
    AgentQuotaService,
    AgentLedgerService,
    AgentInviteService,
    AgentBindingsService,
    AgentAccountsService,
    AgentSettlementService,
    AgentAdjustmentService,
    AgentUserClient,
  ],
})
export class AgentModule {}
