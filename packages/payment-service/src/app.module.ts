import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminPayController } from './admin/admin-pay.controller';
import { CashierController } from './cashier/cashier.controller';
import { AlipayClient } from './channel/alipay/client';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { ConfigModule } from './config/config.module';
import { paymentDatabaseOptions } from './database.config';
import { UserLockService } from './locks/user-lock.service';
import { NotifyController, NotifyRateLimiter } from './notify/notify.controller';
import { NotifyService } from './notify/notify.service';
import { OrdersController } from './orders/orders.controller';
import { OrdersService } from './orders/orders.service';
import { RefundController } from './refund/refund.controller';
import { RefundService } from './refund/refund.service';
import { RedisModule } from './redis/redis.module';
// ⚠️ **值导入**（DI 陷阱纪律）：`CurrencyRpcClient` 的 provide/useFactory 与 token 都是运行期身份。
import { CurrencyRpcClient, PAYMENT_CURRENCY_RPC_PROXY, currencyClientOptions } from './rpc/currency.client';
import { ScanService } from './scan/scan.service';
import { WalletController } from './wallet/wallet.controller';
import { WithdrawController } from './withdraw/withdraw.controller';
import { WithdrawService } from './withdraw/withdraw.service';

/**
 * payment-service 的装配（T2 骨架；克隆自 currency-service 的同名文件）。
 *
 * ⚠️ **模块注册纪律**（T6 教训）：后续任务新增的控制器/接收器/自调度服务
 * （T7 的 OrdersController、T8 的 NotifyController、T15 的 ScanService 等）**必须**在这里
 * 或其子模块注册 —— 未注册 = 单测全绿而**真容器 404 / 永不执行**。
 * ✅ T2 已按此落地：`HealthController`（就绪/存活两面）+ `ConfigModule`（本服务首条出站
 * RPC 边 = `config.snapshot` 缓存；⚙️2）在下面的 `controllers`/`imports` 里 ——
 * 未注册 = 真容器解析不到 `ConfigCacheService`（单测传替身，看不见）；`boot.test.ts` 的
 * 注册面断言把这两处钉住。
 *
 * ⚠️ **值导入**（不是 `import type`）：DI 需要类的运行期身份，`import type` 会在容器
 * 启动时崩（本仓既有陷阱 `di-type-import-trap`）。
 */
@Module({
  imports: [
    // 选项集中在 `database.config.ts`（与 TypeORM CLI 的 `data-source.ts` **共用同一份**）——
    // `synchronize: false` + `migrations` + `migrationsRun: true` + 独立的 `migrations_payment`
    // （⚙️1：与 user/config/currency 共库 ⇒ 迁移表必须第四份独立）。
    TypeOrmModule.forRoot(paymentDatabaseOptions()),
    // T2：配置缓存模块（`config.snapshot` 一条出站边的 `ClientsModule` 装配 +
    // 单例 `ConfigCacheService`）—— T5/T6 起的键级消费面经本导入消费它。
    ConfigModule,
    // 提交 3：reauth 票据消费——withdraw.controller 需 Redis 原子消费 `DEL reauth:{uid}:{ticket}`。
    RedisModule,
    // T9：currency 出站边（`currency.apply` / `currency.get` / `currency.withdrawable.get`
    // 三条调用 —— 设计 §2.4 的**唯一写边**封装）。ClientsModule **就地**注册 TCP 客户端
    // （照 ConfigModule 的成例；本服务不新增 npm 依赖），类实例由 useFactory 包装（R216）。
    ClientsModule.register([{ name: PAYMENT_CURRENCY_RPC_PROXY, ...currencyClientOptions() }]),
  ],
  controllers: [
    HealthController,
    OrdersController,
    // wap.pay 桥接页（GET /pay/cashier/:orderNo；edge 直连公开面，HMAC token 自守）——
    // 未注册 = 客户端充值跳转 404（逻辑复用 OrdersService，无新 provider）。
    CashierController,
    NotifyController,
    WithdrawController,
    RefundController,
    // T12：管理面八端点（§2.4.2；授权在网关 policy P-p1..P-p7，本服务侧 = XAdminGuard）——
    // 未注册 = 单测全绿而**真容器 404**（管理面整体断路）。
    AdminPayController,
    // T13：玩家钱包读面（`GET /api/pay/wallet/summary`；§2.4.1 #5）——未注册 = 单测全绿而
    // **真容器 404**（钱包页数据源整体断路）。
    WalletController,
  ],
  // §2.4：健康检查复用 TypeORM 的 `DataSource`（由上面的 imports 提供），**不新建连接**。
  providers: [
    HealthService,
    // T6：渠道层（`AlipayClient` —— T7 起的订单链直接注入本 provider）。
    // 构造参 `fetchImpl` 是 `@Optional()` + 默认值（照 robot `douzero.health.ts` 先例）⇒
    // 容器无需为它准备任何 token；注册面由 `test/sign.test.ts` ⑦ 钉住（未注册 = 单测全绿
    // 而真容器解析不到）。**值导入**（`import` 非 `import type` —— DI 要运行期身份，`di-type-import-trap`）。
    AlipayClient,
    // T7：订单链（下单/查询/补单/过期；注册面由 `test/orders-state.test.ts` ⑨ 钉住）。
    OrdersService,
    // T8：回调链（验签唯一信任入口 + 边缘单桶；注册面由 `test/notify.test.ts` ⑨ 钉住）——
    // 未注册 = 单测全绿而**真容器 404**（edge 直连形态没有网关层可依赖，缺注册 = 通道整体断路）。
    NotifyService,
    NotifyRateLimiter,
    // T9：资金动作底座 —— currency 出站边（useFactory 包装：`useClass` 看不见带默认值的
    // 普通对象参数 ⇒ 启动即崩；单测直接 `new CurrencyRpcClient(fake)` 全绿也照样崩 —— R216）。
    {
      provide: CurrencyRpcClient,
      useFactory: (proxy: ClientProxy) => new CurrencyRpcClient(proxy),
      inject: [PAYMENT_CURRENCY_RPC_PROXY],
    },
    // T9：资金锁（`payment_user_locks` 行锁；T10 提现/退款链消费）。纯 DB 组件——无出站面。
    UserLockService,
    // T9：扫描骨架 + 循环③入账重试（⏱ `pay.scanIntervalMs` 配置键自重排；T10 已挂 ④⑤，T11 已挂 ⑥⑦）。
    // 未注册 = 单测全绿而真容器**永不扫描**（paid 卡住无人入账——最贵的一类缺注册）。
    ScanService,
    // T10：提现链（申请冻结/claim/超时回滚；注册面由 `test/withdraw-state.test.ts` ⑯ 钉住）——
    // 未注册 = 单测全绿而**真容器 404**（玩家申请通道整体断路）。
    WithdrawService,
    // T11：退款链（申请即冻结/审=渠道动作/驳回回滚；注册面由 `test/refund-state.test.ts` ⑬ 钉住）——
    // 未注册 = 单测全绿而**真容器 404**（玩家退款申请通道整体断路）。
    RefundService,
  ],
})
export class AppModule {}
