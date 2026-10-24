import { Body, Controller, Delete, Get, Headers, Param, Put, UseGuards } from '@nestjs/common';
import { ErrCode, AD_CHANNEL_KEYS, type AdChannelKey } from '@fight-the-landlord/protocol';
import { httpException } from '../http/errors';
import { ADMIN_ACTOR_HEADER, requireActor } from '../admin/admin-accounts.service';
import { XAdminGuard } from '../config/admin.controller';
import {
  AdChannelService,
  AdChannelStorageDisabledError,
  AdChannelValidationError,
  type AdChannelStatusItem,
} from './ad-channel.service';

/** ② 非字符串 value 的 400 文案（防御分支）——与 validators 的同条件文案逐字一致（见类头注）。 */
const VALUE_NOT_STRING_MESSAGE = '值必须是字符串';
/** ③ 未知键的 400 文案——与 validators 的 default 分支同字（见类头注）。 */
const UNKNOWN_KEY_MESSAGE = '未知键';

/** 键注册表查询（⚙️1 单一真源 `AD_CHANNEL_KEYS`；类型谓词即收窄点）。 */
function isAdChannelKey(key: string): key is AdChannelKey {
  return (AD_CHANNEL_KEYS as readonly string[]).includes(key);
}

/**
 * 广告回调密钥的管理三端点（广告规格 §2.3 克隆先例：`pay-channel.controller.ts:55-130`
 * 形态**逐字**——`@Controller('admin')` + 三端点路径 `admin/ad-channel`（**GET 无后缀**）；T6）。
 *
 * 守卫 = 与 `config/admin.controller.ts` 同族：`@Controller('admin')` + `@UseGuards(XAdminGuard)`
 * （fail-closed 只认 `X-Admin: 1`；**授权矩阵不在服务侧**——网关 policy P-a1/P-a2 的 super_admin
 * 面另在 T8）。`X-Admin-Actor`（写面身份）由网关注入；本层 `requireActor` 缺失/非法 ⇒ 401。
 * 本 controller 保持薄：校验/加密/事务三段序/审计全在 `AdChannelService`（错误信封只写一份）。
 *
 * ─── 端点契约 ─────────────────────────────────────────────────────────────────
 *  - `GET /api/admin/ad-channel` ⇒ `{code:OK, data:{keys:[<单项，⚙️1 序>]}}`（项形状由
 *    `status()` 保证：本空间全密键 ⇒ `value` 恒 null——掩码写/P8 掩码读；读面无 actor 要求）；
 *  - `PUT /api/admin/ad-channel/:key` body `{value?:unknown}` ⇒
 *    `{code:OK, data:{saved:true, fingerprint, updatedAt}}`；
 *  - `DELETE /api/admin/ad-channel/:key` ⇒ `{code:OK, data:{saved:true}}`（行不存在也 200——幂等）。
 *
 * ─── 错误序（顺序即契约；三序各有判别性专测，401→400→503）────────────────────
 *  - **401 先于一切（序①）**：PUT/DELETE 的 `requireActor` 在形状/白名单/校验/库操作**之前**
 *    ——未知键/非字符串 value 配缺 actor 时观测到的是 401（fail-closed 不回退）；
 *  - **400 先于 503**：`set()` 内部先 `validateAndNormalize` 后主钥检查 ⇒ 以 503 为判据的
 *    探针/测试 PUT 必须用**合法值**（非法值观测到的是 400）；
 *  - **503 文案逐字**：主钥缺时 `AdChannelStorageDisabledError.message` 即
 *    `广告回调密钥存储未启用（缺主钥）`，直接透传作 503 message（解密失败路径透传的 crypto
 *    文案同样不含任何值——`AdChannelStorageDisabledError` 的既有口径）。
 *
 * ─── 形状防御与键白名单 ──────────────────────────────────────────────────────
 *  - `body?.value` 非 string（`{}` / 数字 / 对象 / 缺省）⇒ 400「值必须是字符串」——TS 签名
 *    `unknown` 的运行时防御分支；文案与 `ad-channel.validators.ts` 的同条件**逐字一致**
 *    （口径单一：谁先拒都同字）；
 *  - 键注册表 = `AD_CHANNEL_KEYS`（⚙️1 单一真源）；非注册键 ⇒ 400「未知键」（与 validators 的
 *    default 分支同字——「未知键 400 的白名单在 controller 注册表」，两层同一拒绝在 wire 上
 *    不可区分）。
 *  两条 message 均为常量、**不含输入值**（400 会回显到管理页/日志）。
 */
@Controller('admin')
@UseGuards(XAdminGuard)
export class AdChannelController {
  constructor(private readonly adChannel: AdChannelService) {}

  @Get('ad-channel')
  async getStatus(): Promise<{ code: ErrCode; data: { keys: AdChannelStatusItem[] } }> {
    try {
      return { code: ErrCode.OK, data: { keys: await this.adChannel.status() } };
    } catch (err) {
      this.rethrowMapped(err);
    }
  }

  @Put('ad-channel/:key')
  async putValue(
    @Param('key') key: string,
    @Body() body: { value?: unknown },
    @Headers(ADMIN_ACTOR_HEADER) actor?: string,
  ): Promise<{ code: ErrCode; data: { saved: true; fingerprint: string; updatedAt: number } }> {
    // ① 身份 fail-closed（序①）：缺失/非法 ⇒ 401「管理身份缺失」，先于一切。
    const by = requireActor(actor);

    // ② 形状防御：非 string ⇒ 400。message 为常量、不含值（对象形态也不得把内容漏进回显）。
    const value = body?.value;
    if (typeof value !== 'string') throw httpException(ErrCode.BAD_PARAM, VALUE_NOT_STRING_MESSAGE);

    // ③ 键白名单：非注册键 ⇒ 400「未知键」；查表即收窄 ⇒ `set()` 的 `AdChannelKey` 签名由此满足。
    if (!isAdChannelKey(key)) throw httpException(ErrCode.BAD_PARAM, UNKNOWN_KEY_MESSAGE);

    // ④ 校验（400）→ 主钥（503）→ 事务三段序——全在 service 层；此处只翻错误信封。
    try {
      const result = await this.adChannel.set(key, value, by);
      return {
        code: ErrCode.OK,
        data: { saved: true, fingerprint: result.fingerprint, updatedAt: result.updatedAt },
      };
    } catch (err) {
      this.rethrowMapped(err);
    }
  }

  @Delete('ad-channel/:key')
  async deleteKey(
    @Param('key') key: string,
    @Headers(ADMIN_ACTOR_HEADER) actor?: string,
  ): Promise<{ code: ErrCode; data: { saved: true } }> {
    const by = requireActor(actor); // ① 401 先行（同上）
    if (!isAdChannelKey(key)) throw httpException(ErrCode.BAD_PARAM, UNKNOWN_KEY_MESSAGE); // ② 未知键 400

    try {
      // `existed` 故意不消费：行不存在也 200（幂等），响应恒 `{saved:true}`。
      await this.adChannel.clear(key, by);
      return { code: ErrCode.OK, data: { saved: true } };
    } catch (err) {
      this.rethrowMapped(err);
    }
  }

  /**
   * 领域错误 → HTTP 信封（本文件的**唯一映射点**）：
   *  - `AdChannelValidationError` ⇒ 400（message = `err.reason`——理由为常量、不含输入值）；
   *  - `AdChannelStorageDisabledError` ⇒ 503（主钥缺时 `err.message` 即逐字文案；
   *    解密失败透传的 crypto 文案同不含值）；
   *  - 其余错误原样抛（500 响亮——失败不静默、不吞）。
   */
  private rethrowMapped(err: unknown): never {
    if (err instanceof AdChannelValidationError) {
      throw httpException(ErrCode.BAD_PARAM, err.reason);
    }
    if (err instanceof AdChannelStorageDisabledError) {
      throw httpException(ErrCode.UPSTREAM_UNAVAILABLE, err.message);
    }
    throw err;
  }
}
