import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { RoomsReaperTask } from './rooms.reaper';
import { RedisProviderModule } from '../redis.provider.module';
import { ConfigCacheModule } from '../config/config-cache.module';

@Module({
  imports: [
    RedisProviderModule,
    HttpModule,
    // 片⑦ T7：`RoomsService`（建房时的底分校验）/ `RoomsReaperTask`（回收周期）/
    // `RoomsController`（好友房开关三面）都注入 `ConfigCacheService` ⇒ 从这里拿**同一个**
    // 进程内单例（`ConfigCacheModule` 自己不 import 任何业务模块，依赖方向仍单向 ⇒ 不成环）。
    // ⚠️ T7 之前本模块 import 的是 `RpcClientsModule`（那时 RoomsService 直接注入
    // `ConfigClient`）—— 现在吃配置的入口统一收敛到 `ConfigCacheModule`，它再往下 import
    // `RpcClientsModule` 拿传输层（缓存为空窗口内的即时拉取走那条边）。
    ConfigCacheModule,
  ],
  controllers: [RoomsController],
  // N31/R523：回收任务与 robot 的 `RobotReclaimTask` 同形（`OnModuleInit` 起循环、关停即清）。
  providers: [RoomsService, RoomsReaperTask],
  exports: [RoomsService],
})
export class RoomsModule {}
