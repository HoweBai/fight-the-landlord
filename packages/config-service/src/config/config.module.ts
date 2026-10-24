import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformConfig } from './platform-config.entity';
import { PlatformConfigService } from './platform-config.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminController } from './admin.controller';
import { ClientConfigController } from './client-config.controller';
import { ConfigRpcController } from '../rpc/config.rpc.controller';
import { AdminModule } from '../admin/admin.module';
import { PayChannelController } from '../pay-channel/pay-channel.controller';
import { PayChannelService } from '../pay-channel/pay-channel.service';
import { NotifyChannelController } from '../notify-channel/notify-channel.controller';
import { NotifyChannelService } from '../notify-channel/notify-channel.service';
import { AdChannelController } from '../ad-channel/ad-channel.controller';
import { AdChannelService } from '../ad-channel/ad-channel.service';

/**
 * config-service 的配置面装配（片⑦ T3）。
 *
 * ⚠️ 三个控制器是**三条不同的边**（规格 §2.1 的三出口）：
 *  - `ClientConfigController` —— 玩家面 REST 子集（`GET /api/config`，经网关验签）；
 *  - `AdminController` —— 管理面（`/api/admin/*`，网关注入 `X-Admin` 后可达）；
 *  - `ConfigRpcController` —— 服务间 TCP RPC（`config.snapshot`；只在 `connectMicroservice`
 *    之后可达，见 `main.ts`）。
 *
 * 🔴 `controllers:` 里**必须**列 `ConfigRpcController`：J21 门禁（`robot-availability-wiring.gate.test.ts`）
 * 的两半之一就是「承载 `@MessagePattern` 的类被某个 `*.module.ts` 注册」—— 只写装饰器不注册，
 * 运行时同样是 `NO_MESSAGE_HANDLER` + 消费侧 fail-open。
 *
 * ③ T3 起 `imports` 追加 `AdminModule`：登录处理器（§2.3 七步处理序）需要落地登录事件行，
 * 消费它导出的 `LoginEventsService`（AuthService 的 DataSource 是全局提供，无需导入）。
 *
 * 支付配置管理化 T5 起另注册 `PayChannelController`（管理面 `/api/admin/pay-channel*`——渠道凭据
 * 第二键空间）与 `PayChannelService`（providers；T6 的 RPC 接收侧将在**同一模块内**消费它，
 * 单一注册点）。
 *
 * 通知通道管理化 T6 起再注册 `NotifyChannelController`（管理面 `/api/admin/notify-channel*`——
 * 通知凭据第三键空间）与 `NotifyChannelService`（providers；T7 的 RPC 接收侧将在**同一模块内**
 * 消费它，单一注册点——同 pay 族先例）。metrics（⚙️17 gauges）无需 provider：模块加载即自注册，
 * 刷新入口 `refreshNotifyGauges()` 由 service 直接调用（T5 已接线）。
 *
 * 广告片 T7 起再注册 `AdChannelController`（管理面 `/api/admin/ad-channel*`——广告回调密钥
 * 第四键空间；T6 只落了四件套源码，注册按冻结计划归 T7）与 `AdChannelService`（providers；
 * 本提交的 RPC 接收侧在**同一模块内**消费它，单一注册点——同 pay/notify 族先例）。⚠️ 本注册是
 * 「管理面三端点 + `config.adChannel.get` 接收侧」真可达的另一半：不注册 ⇒ 运行时 404 /
 * `NO_MESSAGE_HANDLER`（J21 两半之一，见 `config.rpc.controller.ts` 类头注）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformConfig]), AdminModule],
  controllers: [
    AdminController,
    ClientConfigController,
    ConfigRpcController,
    PayChannelController,
    NotifyChannelController,
    AdChannelController,
  ],
  providers: [
    PlatformConfigService,
    AdminAuthService,
    PayChannelService,
    NotifyChannelService,
    AdChannelService,
  ],
  exports: [PlatformConfigService],
})
export class ConfigModule {}
