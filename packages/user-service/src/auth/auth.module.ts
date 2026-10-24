import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { ConfigCacheModule } from '../config/config-cache.module';
import { CurrencyModule } from '../currency/currency.module';
import { DeviceBindingsModule } from '../risk/device-bindings.module';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { JwtStrategy } from './jwt.strategy';
import { AuthController } from '../users/users.controller';

@Module({
  imports: [
    UsersModule,
    // 货币片 T6（规格 §2.7）：`AuthService.register` 的两条新依赖 ——
    //  `ConfigCacheModule` exports `ConfigCacheService`（`signupGrant()` 第 11 键 getter；
    //   `AppModule` 也 import 本模块，Nest 按模块实例去重 ⇒ 与清理循环共享**同一个**快照缓存）；
    //  `CurrencyModule` exports `CurrencyClient`（`currency.apply` 写边）。
    // ⚠️ 二者都必须**在这里** import：provider 只能注入「本模块 + 已 import 模块 exports」的
    // 东西 —— 少一处 ⇒ 容器装配 `AuthService` 启动即崩（单测直接 new、看不见；R216/R217 同族）。
    ConfigCacheModule,
    CurrencyModule,
    // 设备绑定片：`AuthService` 的登录/注册/refresh 设备闸（exports DeviceBindingsService；
    // AppModule 也 import 同一模块供管理面解绑 ⇒ Nest 去重，单例）。
    DeviceBindingsModule,
    // 有效期由 `TokenService.sign()` 逐次指定（access 2h / refresh 7d），
    // 因此这里**不再**设置 `signOptions.expiresIn`（§5.1）。
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, JwtStrategy],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
