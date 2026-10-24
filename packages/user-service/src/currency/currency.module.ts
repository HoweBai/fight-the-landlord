// packages/user-service/src/currency/currency.module.ts
import { Module } from '@nestjs/common';
import { ClientsModule, type ClientProxy } from '@nestjs/microservices';
// ⚠️ **值导入**（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器解析 `CurrencyClient`
// 的构造参数时只见 undefined、启动即崩（只有真容器会报，单测与 tsc 都看不见）。
import { CurrencyClient, USER_CURRENCY_RPC_PROXY, currencyClientOptions } from './currency.client';

/**
 * user-service 的**货币写边装配**（货币片 T6 / 规格 §2.7；形态照 `config-cache.module.ts`
 * 与 room 侧 `gateway/rpc-clients.module.ts` —— 「客户端装配各归其边」）。
 *
 * - **自带 `ClientsModule.register`**：本模块装配 `currency.apply`（注册赠送）这一条边的
 *   `ClientProxy`（token = `USER_CURRENCY_RPC_PROXY`）；另一条出站边（`config.snapshot`）
 *   在 `config/config-cache.module.ts` 就地装配 —— 两条边的**两 token 故意的坑**同款：
 *   内部 token 与包装类 token（`CurrencyClient`）**必须不同名**（同名 ⇒ `useFactory`
 *   与 `ClientsModule` 抢同一个 `name`，解析到哪一个取决于注册顺序）；
 * - **`useFactory` 不是可选项**（R216：`useClass` 看不见带默认值的普通对象参数 ⇒
 *   容器启动即崩；单测直接 `new CurrencyClient(fake)` 全绿也照样崩）；
 * - **exports `CurrencyClient`**：消费方（`AuthService`，在 `AuthModule`）注入的是
 *   **同一个单例** —— Nest 按模块实例去重，`AppModule` 与本模块的消费方拿到的是同一对。
 */
@Module({
  imports: [ClientsModule.register([{ name: USER_CURRENCY_RPC_PROXY, ...currencyClientOptions() }])],
  providers: [
    {
      provide: CurrencyClient,
      useFactory: (p: ClientProxy) => new CurrencyClient(p),
      inject: [USER_CURRENCY_RPC_PROXY],
    },
  ],
  exports: [CurrencyClient],
})
export class CurrencyModule {}
