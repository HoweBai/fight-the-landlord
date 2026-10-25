import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RedisModule } from './redis/redis.module';
import { RpcModule } from './rpc/rpc.module';
import { ConfigModule } from './config/config.module';
import { WalletController } from './wallet/wallet.controller';
import { AdminWalletController } from './admin/admin-wallet.controller';
import { AdminFinanceController } from './admin/admin-finance.controller';
import { FinanceQueryService } from './admin/finance-query.service';
import { ReverseService } from './admin/reverse.service';
import { ReconcileService } from './reconcile/reconcile.service';
import { WithdrawableService } from './currency/withdrawable.service';
import { WithdrawableRpcController } from './rpc/withdrawable.rpc.controller';
import { AgentModule } from './agent/agent.module';
// 广告片 T11：回调入口 + 限流桶（**值导入** —— DI 需要类的运行期身份；`import type` 会容器崩）。
import { AdRateLimiter } from './ads/ad-rate-limiter';
import { AdsController } from './ads/ads.controller';
// 广告片 T12：claim 双键服务（**值导入** —— 同上；T14/T15 注入消费）。
import { ClaimService } from './ads/claim.service';
// 广告片 T14：回调业务链三件（**值导入** —— 同上；验签器 ctor 需 ClaimService 令牌，
// AdCallbackService ctor 需验签器/ClaimService/ConfigCacheService/GetService/ApplyService/DataSource）。
import { AdCallbackService } from './ads/ad-callback.service';
import { AdChannelConfigService, AD_CHANNEL_RPC_PROXY } from './ads/ad-channel.config.service';
import { DefaultRewardedCallbackVerifier } from './ads/ads-verifier';
// 记牌器收费片：购买/状态玩家 REST（**值导入** —— DI 需要运行期身份）。
import { CardCounterController } from './card-counter/card-counter.controller';
import { CardCounterService } from './card-counter/card-counter.service';
// ⚠️ **值导入** `configClientOptions`（纯函数——`ClientsModule.register` 的传输选项；与
// ConfigModule 的快照边**同源同值**，两处消费除 `name` 外逐字相同）。
import { configClientOptions } from './config/config.client';
import { currencyDatabaseOptions } from './database.config';

/**
 * currency-service 的装配（T1 骨架；克隆自 config-service 的同名文件）。
 *
 * ⚠️ **模块注册纪律**（T6 教训）：后续任务新增的控制器/接收器/自调度服务
 * （T4 的 RPC 接收控制器、T5 的 HTTP 双面、T8 的 reconcile）**必须**在这里或其子模块
 * 注册 —— 未注册 = 单测全绿而**真容器 404 / 永不执行**。
 * ✅ T4 已按此落地：`RpcModule`（`currency.apply` / `currency.get` 接收侧）在下面的
 * `imports` 里 —— J21 门禁的另一半（承载类被 `*.module.ts` 注册）由它满足。
 * ✅ T5 已按此落地：`WalletController`（玩家余额）+ `AdminWalletController`（管理双端点）
 * 在下面的 `controllers` 里 —— 并落入单测的注册面断言（`Reflect.getMetadata('controllers', …)`）。
 * ✅ T8 已按此落地：`ReconcileService`（自调度对账循环）在下面的 `providers` 里 ——
 * 未注册 = `onModuleInit` **永不执行**（真容器里循环不存在、指标全缺，而单测仍全绿）。
 * ✅ ② 金币场 T8 已按此落地：`ConfigModule`（本服务**首条出站 RPC 边** = `config.snapshot`
 * 缓存；`WalletController.relief` 消费其 `ConfigCacheService`）在下面的 `imports` 里 ——
 * 未注册 = 真容器解析 `WalletController` 的注入时启动即崩（单测传替身，看不见）。
 * ✅ ③ T6 已按此落地：`AdminFinanceController`（财务读口五端点：ops/detail/summary + 两 CSV）
 * + `FinanceQueryService`（三 SQL 收口）在下面的 `controllers`/`providers` 里 —— 与
 * `AdminWalletController` **同前缀异控制器**（路径无交集：ops/summary vs adjust/accounts）；
 * 路由全登记由单测的注册面断言盯住（真容器 404 教训）。
 * ✅ ③ T7 已按此落地：`ReverseService`（冲正两 SQL 收口）在下面的 `providers` 里 ——
 * 未注册 = 真容器解析 `AdminFinanceController` 的新依赖时启动即崩（单测传替身，看不见）。
 * ✅ 支付片 T4 已按此落地：`WithdrawableRpcController`（`currency.withdrawable.get` 接收侧，
 * 只读）+ `WithdrawableService`（cap = 可离场额度公式的**唯一实现点**）在下面的
 * `controllers`/`providers` 里 —— 未注册 = J21 ② 红 / 真容器 `NO_MESSAGE_HANDLER`
 * （单测传替身，看不见）。服务消费 `RpcModule` **导出**的 `GetService`（balance 同源读），
 * 不另造余额读法。
 * ✅ 广告片 T12 已按此落地：`ClaimService`（claim 双键 NX+条件删）在下面的 `providers` 里
 * —— 未注册 = T14/T15 真容器解析注入时启动即崩（单测直接 `new`，看不见）。
 *
 * ⚠️ **值导入**（不是 `import type`）：DI 需要类的运行期身份，`import type` 会在容器
 * 启动时崩（本仓既有陷阱 `di-type-import-trap`）。
 */
@Module({
  imports: [
    // 选项集中在 `database.config.ts`（与 TypeORM CLI 的 `data-source.ts` **共用同一份**）——
    // `synchronize: false` + `migrations` + `migrationsRun: true` + 独立的 `migrations_currency`
    // （⚙️9：与 user/config 共库 ⇒ 迁移表必须第三份独立）。
    TypeOrmModule.forRoot(currencyDatabaseOptions()),
    // T3：余额缓存的 `REDIS` provider（@Global）—— `HealthService` 与 apply 的写穿
    // 共同消费它（R267：健康检查复用**已有**连接，不新建）。
    RedisModule,
    // T4：RPC 接收面（两条 @MessagePattern；`CurrencyRpcController` 在其 `controllers:`）。
    // T5：HTTP 双面的两个控制器经本导入消费 `RpcModule` **导出**的 `ApplyService`/`GetService`
    // （不另造服务实例）。
    RpcModule,
    // ② 金币场 T8：配置缓存模块（`config.snapshot` 一条出站边的 `ClientsModule` 装配 +
    // 单例 `ConfigCacheService`）—— `WalletController.relief` 经本导入消费它。
    ConfigModule,
    // 代理分润（2026-10-26）：域模块（settings/quota/ledger；由 RpcModule 复用以供
    // ApplyService 注入 AgentLedgerService）。本处直接 imports 让未来的 agent 控制器/
    // 自调度服务在 AppModule 图内可见（Nest 同模块去重，不产生第二份实例）。
    AgentModule,
    // 广告片 T14：**第二条出站边**（第四键空间拉取通道 `config.adChannel.get`）的
    // ClientsModule 装配——`AdChannelConfigService` 经 `AD_CHANNEL_RPC_PROXY` 直发
    // （与该边在 ConfigModule 的快照代理**各自一条 TCP 连接**：两条边 timeout 语义不同，
    // 快照 3s / 本边 1000ms；形态出处与差异登记见 `ads/ad-channel.config.service.ts` 文件头）。
    ClientsModule.register([{ name: AD_CHANNEL_RPC_PROXY, ...configClientOptions() }]),
  ],
  controllers: [
    HealthController,
    WalletController,
    AdminWalletController,
    AdminFinanceController,
    // 支付片 T4：`currency.withdrawable.get` 接收侧（J21 ②：承载类必须被某 *.module.ts 的
    // controllers: 注册 —— 本类注册在 AppModule；服务面在下方 providers）。
    WithdrawableRpcController,
    // 广告片 T11：回调入口（`@All('ad/notify/:provider')` 防护链骨架；三件套接线在 main.ts）
    // —— 未注册 = 单测全绿而**真容器 404**（edge 直连形态没有网关层可依赖，缺注册 = 通道断路）。
    AdsController,
    // 记牌器收费片：购买/状态（玩家 REST；网关默认验签后注入 X-User-Id）。
    CardCounterController,
  ],
  // §2.4：健康检查复用 TypeORM 的 `DataSource`（由上面的 imports 提供），**不新建连接**。
  // T8：对账自调度循环（setTimeout 自重排 + 关停闸；`onModuleInit` 在此注册后才会被调用）。
  // ③ T6：`FinanceQueryService` 的 `DataSource` 同源（TypeOrmModule.forRoot 的全局 provider）。
  // ③ T7：`ReverseService` 同源（冲正两 SQL；controller 消费）。
  // 支付片 T4：`WithdrawableService`（cap 公式唯一实现点；`GetService` 经 RpcModule 导出注入）。
  // 广告片 T11：`AdRateLimiter`（回调防护 ④ 边缘单桶；`AdsController` 构造注入）—— 未注册 =
  // 真容器解析注入时启动即崩（单测传替身，看不见；注册面由两份测试钉住）。
  // 广告片 T12：`ClaimService`（claim 双键 NX+条件删；T14 回调链 / T15 GET 裁决注入）——
  // 未注册 = 真容器解析下游注入时启动即崩（同 T11 教训；注册面由 claim.service.test.ts 钉住）。
  // 广告片 T14：回调业务链三件 —— `DefaultRewardedCallbackVerifier`（T13；ctor 需 ClaimService
  // 令牌，本模块 providers 可见）· `AdCallbackService`（链序/落序/计数，ctor 六依赖全部在
  // 本模块可见面内）· `AdChannelConfigService`（第四键空间消费侧；ctor 经
  // `AD_CHANNEL_RPC_PROXY` 取上面的 ClientsModule 代理）—— 未注册 = 真容器解析
  // `AdsController` 注入（AdCallbackService）时启动即崩（单测传替身，看不见；
  // 注册面由 ad-callback.test.ts 钉住）。
  providers: [
    HealthService,
    ReconcileService,
    FinanceQueryService,
    ReverseService,
    WithdrawableService,
    AdRateLimiter,
    ClaimService,
    DefaultRewardedCallbackVerifier,
    AdCallbackService,
    AdChannelConfigService,
    // 记牌器收费片：购买/状态（注入 ApplyService/DataSource/ConfigCacheService）。
    CardCounterService,
  ],
})
export class AppModule {}
