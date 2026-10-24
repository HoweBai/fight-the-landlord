import type { AdChannelKey } from '@fight-the-landlord/protocol';

/**
 * 广告回调密钥单键（`ad.callbackSecret`）的校验/规范化（广告规格 §2.3 克隆先例）——
 * 入口形态照 `notify-channel.validators.ts:140-166` 裁剪（本键空间恰 1 键，无 URL hint 面）。
 *
 * 统一前置（照先例）：全键先 `trim()`；trim 后空串 ⇒ 拒（400，理由 `值不得为空`）。
 * **canonical 规则 = trim 原文**（唯一变换；通知片口径——凭据值逐字保真，与支付片「剥尾斜杠」
 * 有意不同规）。
 *
 * 键材料形态规则（v1.4 T0 回填后定稿）：**「trim 后非空字符串、长度 ≤512」即最终规则**
 * ——`ad.callbackSecret` 是平台后台配置的**不透明密钥**（官方文档未给字符集/长度契约；
 * 验签算法 v1.4 已落 = `sha256(secret:trans_id)`，但 secret 本体对服务端只是逐字消费的字符串）。
 * 故**有意不收窄字符集**（不强制 hex/等长）：真实平台密钥若含预期外字符，收严会在开通日
 * 直接 400 阻断配置；非空 + 上限是唯一可证的必要约束。
 *
 * ⚠️ **理由文案不含输入值**（先例纪律）：`reason` 只讲「哪里不合规」（可含上限数字），
 * 绝不内嵌 `raw` 的任何片段——400 message 会原样回显到管理页/日志，值可能含密钥材料。
 *
 * 返回联合类型 = 先例逐字：`{ok:true, canonical} | {ok:false, reason}`。
 */

export type AdChannelValidation = { ok: true; canonical: string } | { ok: false; reason: string };

/** 键材料长度上限（最终规则：不透明密钥的唯一可证必要约束——官方无字符集/长度契约，不收窄）。 */
const MATERIAL_MAX_LEN = 512;

/* ⚠️ 下列 reason 全部为**常量**：不含 raw 的任何片段。 */
const EMPTY_REASON = '值不得为空';
const MATERIAL_LEN_REASON = `长度超过上限 ${MATERIAL_MAX_LEN}`;

function reject(reason: string): AdChannelValidation {
  return { ok: false, reason };
}

/**
 * 键材料共规（v1.4 T0 回填后定稿）：非空已由入口预检保证，此处只量 canonical 长度；
 * canonical = trim 原文。官方未给密钥字符集契约 ⇒ 不做形态收窄（见文件头说明）。
 */
function validateMaterial(trimmed: string): AdChannelValidation {
  if (trimmed.length > MATERIAL_MAX_LEN) return reject(MATERIAL_LEN_REASON);
  return { ok: true, canonical: trimmed };
}

/**
 * 单键校验/规范化入口（照 `notify-channel.validators.ts:140-166` 入口形态）。**纯函数、不触库**
 * （400 先于一切库操作——校验先于一切纪律）。
 */
export function validateAndNormalize(key: AdChannelKey, raw: string): AdChannelValidation {
  if (typeof raw !== 'string') return reject('值必须是字符串'); // 防御支（照先例同形）；类型调用面不可达
  const trimmed = raw.trim(); // 全键先 trim
  if (trimmed.length === 0) return reject(EMPTY_REASON);

  switch (key) {
    case 'ad.callbackSecret':
      return validateMaterial(trimmed);
    default:
      // 类型上不可达（AdChannelKey 为单字面量）；未知键 400 的白名单在 controller 注册表（T6）
      return reject('未知键');
  }
}
