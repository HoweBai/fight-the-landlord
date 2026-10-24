import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RecordRpcController } from './rpc/record.rpc.controller';
import { UserNicknamesRpcController } from './rpc/user-nicknames.rpc.controller';
import { RecordsController } from './records/records.controller';
import { RecordsService } from './records/records.service';
import { RecordsCleanupService } from './records/records-cleanup.service';
import { DeviceReportRpcController } from './risk/device-report.rpc.controller';
import { DevicesService } from './risk/devices.service';
import { DevicesCleanupService } from './risk/devices-cleanup.service';
import { ReviewsService } from './risk/reviews.service';
import { ScanService } from './risk/scan.service';
import { AdminRiskController } from './risk/admin-risk.controller';
import { AdminRiskService } from './risk/admin-risk.service';
import { DeviceBindingsModule } from './risk/device-bindings.module';
import { ConfigCacheModule } from './config/config-cache.module';
import { PlayersModule } from './players/players.module';
import { CurrencyModule } from './currency/currency.module';
import { userDatabaseOptions } from './database.config';

@Module({
  imports: [
    // E7（§10.3）：选项集中在 `database.config.ts`（与 TypeORM CLI 的 `data-source.ts`
    // **共用同一份**）—— `synchronize: false` + `migrations` + `migrationsRun: true`（R248）。
    TypeOrmModule.forRoot(userDatabaseOptions()),
    UsersModule,
    AuthModule,
    RedisModule,
    // 记录片 T7（设计 D5）：本服务的**第一条配置消费链** —— `config.snapshot` 快照缓存
    // （启动退避拉取 + `config:changed` 订阅 + 60s 安全网）；exports `ConfigCacheService`
    // 供下面的 `RecordsCleanupService` 注入（同一单例）。
    ConfigCacheModule,
    // 货币片 T6（规格 §2.7 / US1）：本服务的**第二条出站 RPC 边**（`currency.apply`，
    // 注册赠送）—— 装配在 `src/currency/currency.module.ts`。消费方 `AuthService` 在
    // `AuthModule`（那里也 import 本模块取注入面）；Nest 按**模块类实例**去重 ⇒ 两边
    // import 到的是同一模块、同一对 `ClientsModule` proxy / `CurrencyClient` 单例。
    // 在此登记 = 集中注册面（T6 教训同族：装配不在模块图里，单测全绿而真容器才炸）。
    CurrencyModule,
    // 设备绑定片：绑定服务（MySQL 真相 + Redis 写透缓存）的装配模块——`AuthModule` 也 import
    // 它（登录闸），本模块消费其 exports 供 `AdminRiskController` 的解绑端点。
    DeviceBindingsModule,
    // 玩家管理页（2026-10-22）：列表/最近对局读面；控制器与 provider 在模块内注册。
    PlayersModule,
  ],
  /**
   * ⚠️ 记录片 D7 / **J21 的第二半**：`RecordRpcController` 必须在这里的 `controllers:`
   * 注册 —— 装饰器写在**未被模块绑定**的类里，运行时同样 `NO_MESSAGE_HANDLER`
   * （`robot-availability-wiring.gate.test.ts` 全包扫描会红；两半缺一 ⇒ room 侧
   * `record.write` 直投即失败）。RPC 接收侧的依赖（`DataSource`）来自上面
   * `TypeOrmModule.forRoot` 的全局 provider，不新建连接。
   *
   * ⚠️ 记录片 T6：`RecordsController`（`GET /api/records/mine`）**同样必须**在此注册 ——
   * 未注册时单测（直接 new 控制器）全绿而真容器 404（「路由要真容器才看得见」与 J21 同族）。
   * `RecordsService` 的依赖 `DataSource` 同样来自 `TypeOrmModule.forRoot`，不新建连接。
   *
   * ⚠️ 风控片 T6：`AdminRiskController`（`/api/admin/risk/*` 四端点）同族必须在场——
   * 未注册 ⇒ 单测全绿而真容器 404。
   */
  controllers: [
    HealthController,
    RecordRpcController,
    UserNicknamesRpcController,
    RecordsController,
    DeviceReportRpcController,
    AdminRiskController,
  ],
  // §2.4 / R267：健康检查复用本服务的 `REDIS`（`RedisModule`，`@Global`）与
  // TypeORM 的 `DataSource` —— 二者都由上面的 `imports` 提供，**不新建连接**。
  //
  // ⚠️ 记录片 T7：`RecordsCleanupService` 必须**注册在模块里**才会跑 `onModuleInit` ——
  // 未注册时单测（直接 new + 手动调）全绿而真容器**永不清理**（与 T6「路由要真容器才
  // 看得见」同族的「生命周期钩子要真容器才会被调」）。依赖 = `DataSource`（`forRoot` 全局）
  // + `ConfigCacheService`（上面的 `ConfigCacheModule` 导出）。
  //
  // ⚠️ 风控片 T4：`DeviceReportRpcController` 同样必须在此注册（J21 的第二半 ——
  // 装饰器写在未被模块绑定的类里，运行时同样 `NO_MESSAGE_HANDLER`）；`DevicesService`
  // 是它的注入依赖，`DevicesCleanupService` 同理必须有模块注册才会跑 `onModuleInit`
  // （不注册 ⇒ 单测全绿而真容器**永不清理设备行**）。三者依赖的 `DataSource` 来自
  // 上面 `TypeOrmModule.forRoot` 的全局 provider，`ConfigCacheService` 由 `ConfigCacheModule` 导出。
  //
  // ⚠️ 风控片 T5：`ScanService` 同样必须注册才会跑 `onModuleInit`（= 定时扫描循环的
  // 起跑点；不注册 ⇒ 单测全绿而真容器**永不扫描**——与 T4 清理行同族的「生命周期钩子要
  // 真容器才会被调」）；`ReviewsService` 是它的注入依赖（也是 T6 管理动作的复用面）。
  // 两者依赖：`DataSource`（`forRoot` 全局）+ `REDIS`（`RedisModule`，`@Global`）+
  // `ConfigCacheService`（上面的 `ConfigCacheModule` 导出）。
  //
  // ⚠️ 风控片 T6：`AdminRiskService` 是 `AdminRiskController` 的读面注入依赖（写面动作
  // 走 `ReviewsService.applyAdminAction`——队列状态机单一真源，不另起动作服务）。
  providers: [
    HealthService,
    RecordsService,
    RecordsCleanupService,
    DevicesService,
    DevicesCleanupService,
    ReviewsService,
    ScanService,
    AdminRiskService,
  ],
})
export class AppModule {}
