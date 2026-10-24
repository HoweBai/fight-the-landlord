import { createHash, timingSafeEqual } from 'node:crypto';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  ErrCode,
  RPC_PATTERNS,
  type ConfigAdChannelGetRequest,
  type ConfigAdChannelGetResponse,
  type ConfigNotifyChannelGetRequest,
  type ConfigNotifyChannelGetResponse,
  type ConfigPayChannelGetRequest,
  type ConfigPayChannelGetResponse,
  type ConfigSnapshotRequest,
  type ConfigSnapshotResponse,
  type RpcResult,
} from '@fight-the-landlord/protocol';
import { configSnapshotPayload, PlatformConfigService } from '../config/platform-config.service';
import {
  PayChannelService,
  PayChannelStorageDisabledError,
} from '../pay-channel/pay-channel.service';
import {
  NotifyChannelService,
  NotifyChannelStorageDisabledError,
} from '../notify-channel/notify-channel.service';
import {
  AdChannelService,
  AdChannelStorageDisabledError,
} from '../ad-channel/ad-channel.service';

/**
 * 各服务 → config-service 的**四条** RPC 接收侧：`config.snapshot`（规格 §2.3 / R220）、
 * 支付配置管理化片的 `config.payChannel.get`（支付片 §2.5 / ⚙️4；T6）、通知通道管理化片的
 * `config.notifyChannel.get`（通知片 §2.5 / ⚙️4；T7）与广告片的 `config.adChannel.get`
 * （广告规格 §2.3 / ⚙️4；T7）。
 *
 * 🔴 **J21 的接收侧**：本类的四条 `@MessagePattern(RPC_PATTERNS.…)` 是
 * `robot-availability-wiring.gate.test.ts` 全包扫描要找的接收侧（承载类还必须被某个
 * `*.module.ts` 的 `controllers:` 注册 —— 见 `config.module.ts`；两半缺一 ⇒ 运行时
 * `NO_MESSAGE_HANDLER` + room 侧 fail-open）。支付片 T1 先落 `RPC_PATTERNS.configPayChannelGet`
 * 常量、T6 补上其接收侧；通知片 T1 先落 `RPC_PATTERNS.configNotifyChannelGet` 常量、T7
 * （前序提交）补上这半边 ⇒ **J21 窗口闭合**（窗口期 = 常量在场而接收侧缺席的例红）；
 * 广告片 `RPC_PATTERNS.configAdChannelGet` 与接收侧**同笔**（本提交；计划 v1.2 把常量自 T4
 * 移入 T7 的题中之义）⇒ **无窗口期**。
 *
 * ⚠️ **四条 handler 的信封（`RpcResult`）是客户端契约的一部分**：T6 的
 * `ConfigClient.snapshot()` 逐字保留既有 `!res?.ok` 分支并 `return res.data`
 * （spec D1 行 + 计划 T6 Step 3）—— 裸返回 `{config,version}` 会让每个消费方把成功响应当
 * 「失败」（`res.ok` 为 undefined）。规格 §2.3 的 `{config, version}` / §2.5 的 `{values}`
 * 都是信封**内层 `data`** 的形状。
 *
 * ⚠️ **不重试**由调用方管（§4.3 的重试表不含这四条 pattern）：`config.snapshot` 的 3s 超时
 * 在客户端侧、`config.payChannel.get` 的 1000ms 桥在 payment 侧 T8、`config.notifyChannel.get`
 * 的 3000ms 超时 + 30s 轮询在 relay/renderer 消费端（⚙️8；两消费方非 Nest 服务、无 trace 基建）、
 * `config.adChannel.get` 的「现拉 + lastGood」在 currency-service 回调链（§2.3；T14 消费）。
 */
@Controller()
export class ConfigRpcController {
  constructor(
    private readonly config: PlatformConfigService,
    // ⚠️ **值导入**（DI 陷阱纪律）：`PayChannelService` 是同一 `ConfigModule` 的 provider
    // （T5 已注册；消费方 = 本类 T6），Nest 按运行期类身份解析 `design:paramtypes` ⇒
    // `import type` 会启动即崩。
    private readonly payChannel: PayChannelService,
    // 同纪律：`NotifyChannelService` 是同一 `ConfigModule` 的 provider（T5 已注册；
    // 消费方 = 本类 T7）。`import type` 会启动即崩。
    private readonly notifyChannel: NotifyChannelService,
    // 同纪律：`AdChannelService` 是同一 `ConfigModule` 的 provider（注册 = 本提交的
    // `config.module.ts`，controllers/providers 各 +1；消费方 = 本类 T7）。`import type` 会启动即崩。
    private readonly adChannel: AdChannelService,
  ) {}

  @MessagePattern(RPC_PATTERNS.configSnapshot)
  async snapshot(@Payload() _req: ConfigSnapshotRequest): Promise<RpcResult<ConfigSnapshotResponse>> {
    try {
      // 与 `GET /api/admin/config` 共用同一组装（`configSnapshotPayload`）：每键
      // {value, version} + 全局 version = MAX(每键)。
      return { ok: true, data: configSnapshotPayload(await this.config.list()) };
    } catch (e) {
      // R220：业务错误**不抛** —— Nest 的 `RpcException` 到客户端只剩字符串 message，
      // 5 位数字码会丢；调用方（T6 的缓存）按码分流/兜底。
      return {
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 支付渠道凭据的**专用拉取通道**（规格 §2.5 逐字 / ⚙️4 = `config.payChannel.get`）——
   * 渠道六键**不进广播快照**（`config.snapshot` 响应无 `pay.channel` 子串，§5.2 ⑤），
   * 只经本通道下发；payment 侧每渠道调用**现拉**（成功 = 整图替换其缓存，失败 = 回落
   * 上次成功值；T8 消费）。
   *
   * 服务端序（§2.5）：
   *  ① 令牌校验（**常数时间**）：`timingSafeEqual(sha256(provided), sha256(expected))`
   *     —— 先做 sha256 ⇒ 两侧恒 32B，短/长/空形态不会让 `timingSafeEqual` 因长度不等抛异常
   *     （全部落入「不匹配」分支；比对耗时与令牌内容无关）。env `PAY_CHANNEL_PULL_TOKEN`
   *     未设（空串 = 未设，⚙️5「`||` 不用 `??`」）⇒ **一律拒**（正确字符串也不放行，fail-closed）。
   *     🔴 **码位填充登记**：§2.5① 只写「拒」未钉码 —— 此处填 `ErrCode.UNAUTHENTICATED`
   *     （10002）+ 文案「拉取令牌不匹配」（**不含任何令牌内容**；G2：消息面不得出现令牌/值）。
   *  ② 主钥未设 / 解密失败（`PayChannelService.pull()` 统一抛 `PayChannelStorageDisabledError`）
   *     ⇒ `{ok:false, code:10007, message:'渠道密钥存储未启用'}`（§2.5② **逐字**；注意**不带**
   *     ⚙️18 管理面 503 的「（缺主钥）」后缀，两处文案是不同的钉子）。
   *  ③ 成功 ⇒ `{ok:true, data:{values}}` —— `values` 仅含**已配置**键（缺键不补）；密钥类值 =
   *     canonical base64(PEM)（= 旧 env 格式，读侧零改）。
   *
   * **失败一律不抛**（R220，同 `snapshot`）：Nest 的 `RpcException` 过客户端只剩字符串
   * message，5 位码会丢；其余异常兜底照本类既有口径（`{ok:false, 10007, e.message}`）。
   */
  @MessagePattern(RPC_PATTERNS.configPayChannelGet)
  async payChannelGet(
    @Payload() req: ConfigPayChannelGetRequest,
  ): Promise<RpcResult<ConfigPayChannelGetResponse>> {
    if (!this.pullTokenMatches(req?.pullToken, 'PAY_CHANNEL_PULL_TOKEN')) {
      return { ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' };
    }
    try {
      return { ok: true, data: { values: await this.payChannel.pull() } };
    } catch (e) {
      if (e instanceof PayChannelStorageDisabledError) {
        // §2.5② 逐字文案（不含底层原因——解密失败细节不出站）。
        return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: '渠道密钥存储未启用' };
      }
      // R220 兜底口径（与 `snapshot` 的 catch 同型）：业务错误不抛，码要跨过 RPC 边界。
      return {
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 通知凭据的**专用拉取通道**（通知规格 §2.5 逐字 / ⚙️4 = `config.notifyChannel.get`）——
   * 九键**不进广播快照**（`config.snapshot` 响应无 `notify.` 子串，§5.2 ②），只经本通道
   * 下发；消费端（alert-relay / am-renderer）30s 轮询**现拉**（成功 = 整图替换其缓存，
   * 失败 = 保持 last-good，⚙️9；T12/T13 消费）。
   *
   * 服务端序（§2.5，照 `payChannelGet` 逐字）：
   *  ① 令牌校验（**常数时间**，共用 `pullTokenMatches`）：env `NOTIFY_CHANNEL_PULL_TOKEN`
   *     未设（空串 = 未设，⚙️5）⇒ **一律拒**（fail-closed）⇒ 不匹配
   *     `{ok:false, code:10002, message:'拉取令牌不匹配'}`（消息面**不含**任何令牌/值）。
   *  ② 主钥未设 / 解密失败（`NotifyChannelService.pull()` 统一抛
   *     `NotifyChannelStorageDisabledError`）⇒ `{ok:false, code:10007, message:'通知通道密钥存储未启用'}`
   *     （§2.5② **逐字**；注意**不带** §2.9 管理面 503 的「（缺主钥）」后缀——两处钉子分开）。
   *  ③ 成功 ⇒ `{ok:true, data:{values}}` —— `values` 仅含**已配置**键（缺键不补）；
   *     值 = 存储 canonical（URL 逐字保真）。
   *
   * **失败一律不抛**（R220，同 `snapshot`/`payChannelGet`）：Nest 的 `RpcException` 过
   * 客户端只剩字符串 message，5 位码会丢；其余异常兜底照本类既有口径。
   */
  @MessagePattern(RPC_PATTERNS.configNotifyChannelGet)
  async notifyChannelGet(
    @Payload() req: ConfigNotifyChannelGetRequest,
  ): Promise<RpcResult<ConfigNotifyChannelGetResponse>> {
    if (!this.pullTokenMatches(req?.pullToken, 'NOTIFY_CHANNEL_PULL_TOKEN')) {
      return { ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' };
    }
    try {
      return { ok: true, data: { values: await this.notifyChannel.pull() } };
    } catch (e) {
      if (e instanceof NotifyChannelStorageDisabledError) {
        // §2.5② 逐字文案（**无**「（缺主钥）」后缀——管理面 503 是另一颗钉子，§2.9）。
        return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: '通知通道密钥存储未启用' };
      }
      // R220 兜底口径（与 `snapshot` 的 catch 同型）：业务错误不抛，码要跨过 RPC 边界。
      return {
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 广告回调凭据的**专用拉取通道**（广告规格 §2.3 逐字 / ⚙️4 = `config.adChannel.get`）——
   * 单键（`ad.callbackSecret`）**不进广播快照**（`config.snapshot` 响应无 `ad.callback`
   * 子串，§2.3），只经本通道下发；消费侧（currency-service 回调链）**现拉 + lastGood**
   * （成功 = 整图替换其缓存，失败 = 保持 last-good；无 lastGood ⇒ 回调 5xx，§2.3；T14 消费）。
   *
   * 服务端序（§2.3，照 `payChannelGet`/`notifyChannelGet` 逐字）：
   *  ① 令牌校验（**常数时间**，共用 `pullTokenMatches`）：env `AD_CHANNEL_PULL_TOKEN`
   *     未设（空串 = 未设，⚙️5）⇒ **一律拒**（fail-closed）⇒ 不匹配
   *     `{ok:false, code:10002, message:'拉取令牌不匹配'}`（消息面**不含**任何令牌/值）。
   *  ② 主钥未设 / 解密失败（`AdChannelService.pull()` 统一抛
   *     `AdChannelStorageDisabledError`）⇒ `{ok:false, code:10007, message:'广告回调密钥存储未启用'}`
   *     （§2.3 逐字；注意**不带**管理面 503 的「（缺主钥）」后缀——两处钉子分开）。
   *  ③ 成功 ⇒ `{ok:true, data:{values}}` —— `values` 仅含**已配置**键（缺键不补）；
   *     值 = 存储 canonical（消费侧读面零改）。
   *
   * **失败一律不抛**（R220，同 `snapshot`/`payChannelGet`/`notifyChannelGet`）：Nest 的
   * `RpcException` 过客户端只剩字符串 message，5 位码会丢；其余异常兜底照本类既有口径。
   */
  @MessagePattern(RPC_PATTERNS.configAdChannelGet)
  async adChannelGet(
    @Payload() req: ConfigAdChannelGetRequest,
  ): Promise<RpcResult<ConfigAdChannelGetResponse>> {
    if (!this.pullTokenMatches(req?.pullToken, 'AD_CHANNEL_PULL_TOKEN')) {
      return { ok: false, code: ErrCode.UNAUTHENTICATED, message: '拉取令牌不匹配' };
    }
    try {
      return { ok: true, data: { values: await this.adChannel.pull() } };
    } catch (e) {
      if (e instanceof AdChannelStorageDisabledError) {
        // §2.3 逐字文案（**无**「（缺主钥）」后缀——管理面 503 是另一颗钉子，§2.3 管理面）。
        return { ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE, message: '广告回调密钥存储未启用' };
      }
      // R220 兜底口径（与 `snapshot` 的 catch 同型）：业务错误不抛，码要跨过 RPC 边界。
      return {
        ok: false,
        code: ErrCode.UPSTREAM_UNAVAILABLE,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 拉取令牌的常数时间比对（三条专用通道共用；支付片 §2.5① / 通知规格 §2.5① / 广告规格 §2.3①）。
   * `provided` 收 `unknown`：RPC 载荷是**线上数据**，缺字段/坏形状按空串处理 ⇒ 一律落入
   * 「不匹配」（不抛、不外泄形状错误细节）。
   */
  private pullTokenMatches(
    provided: unknown,
    envName: 'PAY_CHANNEL_PULL_TOKEN' | 'NOTIFY_CHANNEL_PULL_TOKEN' | 'AD_CHANNEL_PULL_TOKEN',
  ): boolean {
    // ⚙️5：空串 = 未设（`||` 不用 `??`）——未设 ⇒ 拒一切拉取（组合脚本/生产 .env 故缺即暗态）。
    const expected = process.env[envName] || '';
    if (expected === '') return false;
    // sha256 两侧定长 ⇒ timingSafeEqual 恒可调用且时长与内容无关（不做长度分支——那会漏时序）。
    const a = createHash('sha256')
      .update(typeof provided === 'string' ? provided : '', 'utf8')
      .digest();
    const b = createHash('sha256').update(expected, 'utf8').digest();
    return timingSafeEqual(a, b);
  }
}
