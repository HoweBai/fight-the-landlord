import { Module } from '@nestjs/common';
import { RoomsModule } from './rooms/rooms.module';
import { WsModule } from './gateway/ws.module';
import { MatchModule } from './match/match.module';
import { ReconnectModule } from './reconnect/reconnect.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RedisProviderModule } from './redis.provider.module';
import { ConfigCacheModule } from './config/config-cache.module';
// ② 金币场 T4（模块注册纪律）：货币边（`currency.get`/`currency.apply`）装配进应用图 ——
// `WsModule` 是本片第一个消费方（`handleMatch` 门槛）；T5/T6 的结算/机器人资金面
// 也从这个模块出口（providers 由 T5/T6 依次追加）。
import { CurrencyModule } from './currency/currency.module';
import { CoordinationModule } from './coordination/coordination.module';

@Module({
  // 片⑦ T6：配置快照缓存（design D2）挂在这里 ⇒ 进程内**恰好一份**（启动即拉 + 订阅 +
  // 安全网）。T7 的 RoomsModule / MatchModule 也会 import 它 —— Nest 按模块实例去重，
  // 拿到的都是同一个 `ConfigCacheService` 单例，不会出现「两份缓存各自漂移」。
  imports: [
    RedisProviderModule,
    ConfigCacheModule,
    CoordinationModule,
    RoomsModule,
    WsModule,
    MatchModule,
    ReconnectModule,
    CurrencyModule,
  ],
  controllers: [HealthController],
  // §2.4 / R267：健康检查复用 `RedisProviderModule` 的 `Redis`（**不新建连接**）。
  providers: [HealthService],
})
export class AppModule {}
