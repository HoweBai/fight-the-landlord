import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
import { GatewayController } from './gateway/gateway.controller';
import { ProxyGateway } from './gateway/proxy.gateway';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { JwtMiddleware } from './auth/jwt.middleware';
import { AdminAuthMiddleware } from './auth/admin.middleware';
import { AgentAuthMiddleware } from './auth/agent.middleware';
import { ClientGateMiddleware } from './auth/client-gate.middleware';
import { ClientGateService } from './auth/client-gate.service';
import { SessionGuard } from './auth/session.guard';
import { HttpRateLimitMiddleware } from './http/http-rate-limit.middleware';
import { RedisProviderModule } from './redis.provider.module';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `ConfigCacheService`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { API_GATEWAY_CONFIG_RPC, ConfigClient, configClientOptions } from './config/config.client';
import { ConfigCacheService } from './config/config-cache.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
      signOptions: { expiresIn: '7d' },
    }),
    // R30 / R284：`REDIS` 在 api-gateway 里**自己一份**（不跨包 import user-service 的代码）。
    // 连接选项（`maxRetriesPerRequest: 1` + `enableOfflineQueue: false`）逐字保留，
    // 见 `redis.provider.module.ts` 的注释。
    RedisProviderModule,
    // 客户端接入片 T5：网关的 `config.snapshot` 出站边（`client.appEnabled/h5Enabled`
    // 的唯一通道 —— 两键不在 `/api/config` 的客户端子集里；设计 §四）。
    ClientsModule.register([{ name: API_GATEWAY_CONFIG_RPC, ...configClientOptions() }]),
  ],
  controllers: [GatewayController, HealthController],
  providers: [
    ProxyGateway,
    SessionGuard,
    HealthService,
    {
      provide: ConfigClient,
      // ⚠️ **必须 `useFactory`**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒ 启动即崩；
      // 单测直接 `new ConfigClient(fake)` 全绿也照样崩 —— 只有容器门禁能抓到）。
      useFactory: (p: ClientProxy) => new ConfigClient(p),
      inject: [API_GATEWAY_CONFIG_RPC],
    },
    ConfigCacheService,
    ClientGateService,
    // ⚠️ 登记（T5）：网关**无容器门禁测**（`container-assembly.gate.test.ts` 只扫 `controllers:`）
    // ⇒ 本模块三条 provider 的装配形态（useFactory + 值导入）靠部署期真栈验证
    // （T9 的容器实读 + 真栈片）；单测/lint 全绿**不代表**容器起得来（DI 陷阱同族）。
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 顺序**不可交换**（R141 + 片⑦ D6② + 客户端接入片 T5，顺序即契约）：
    //  ⓪ `ClientGateMiddleware` 最先：端闸（自报头判定、不依赖身份）；⛔ 它不读也未验任何
    //     身份头 —— 插最前不改变 ①②③ 的相对序与验真纪律；
    //  ① `JwtMiddleware` 先跑：剥掉客户端自带的身份头（R146）、验玩家令牌；对 `/api/admin/*`
    //     整段跳过玩家验签（D6①）；
    //  ② `AdminAuthMiddleware` 第二：剥伪造 `X-Admin` → 验管理令牌（aud=ftl-admin）→
    //     注入 `X-Admin: 1` + `req.adminTokenFp`（D6②）；
    //  ③ `HttpRateLimitMiddleware` 最后：此时 `x-user-id` / `x-admin` / `adminTokenFp`
    //     才都是**验真产物**（T10 的两个 admin 桶按它们取键）。
    // 任何一步提前 ⇒ 限流桶可被客户端自带的头投毒（R141 的形态），或 admin 桶读到未验真的值。
    //
    // ⚠️ M0.1 T2 修复轮（Nest 11 / Express 5，2026-10-03）：注册形态从旧写法
    // `forRoutes('*')` 迁到 `forRoutes('{/*splat}')`。原因与证据：
    //   - Express 5（path-to-regexp v8）不再支持无名 `*` 通配（Nest v10→v11 迁移指南）；
    //     Nest 11 会为 `'*'` 产出 `[prefix + '$', prefix + '/*']` 两条路径，其中
    //     `prefix + '$'`（覆盖**裸前缀 `/api`** 的那条）在 Express 5 下 `$` 被当**字面量**、
    //     匹配任何请求都失败 ⇒ 旧写法**静默**丢掉裸 `/api` 的验签覆盖（判据 A′ 目击）。
    //   - `{/*splat}` 是 v8 的「零或多」形态（path-to-regexp README：`/files{/*path}`）：
    //     全局前缀展开为 `/api{/*splat}`（Nest 的 `addLeadingSlash` 对 `{/...}` 有特判，
    //     直接拼接）—— 可选组 = `/api` 前缀**本身** + 其下全部子树，恢复 Nest 10 的同一覆盖。
    //   - ⚠️ 迁移指南示例 `forRoutes('{*splat}')` 会展开成 `/api/{*splat}`（斜杠在组外）⇒
    //     **漏掉裸 `/api`**（实测 404 + mw=0）；`'{/*splat}'` 才能命中 —— 该行为由
    //     `test/no-route-outside-api.gate.test.ts` 判据 A′ 钉住。
    consumer.apply(ClientGateMiddleware, JwtMiddleware, AdminAuthMiddleware, AgentAuthMiddleware, HttpRateLimitMiddleware).forRoutes('{/*splat}');
  }
}
