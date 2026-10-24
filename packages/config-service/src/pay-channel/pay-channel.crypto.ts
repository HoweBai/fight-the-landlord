import {
  CryptoDecryptError,
  CryptoFormatError,
  decryptWithKey,
  encryptWithKey,
  fingerprintOf as fingerprintOfCore,
  parseKey,
} from '../sensitive-config/crypto-core';

/**
 * 渠道密文存储的**薄绑定**（T3 提核：规格 §2.3 逐字；⚙️6）——算法/格式全在
 * `sensitive-config/crypto-core.ts`（纯原语、零 env）；本文件只承担三件支付侧职责：
 *  1. **主钥供给**：`process.env.PAY_CONFIG_ENC_KEY` 解析（core `parseKey`）+ **进程内首次
 *     解析成功后缓存**（§2.3；env 进程期不变 ⇒ 缓存即终值；失败不缓存——重复返回 null 无害）；
 *  2. **逐字文案**：把 core 的错误判别类映射为本模块**既有文案（提核前后逐字不变）**——
 *     `渠道密钥存储未启用（缺主钥）` / `渠道配置密文格式非法（v1）` / `渠道配置密文解密失败（主钥不符或数据损坏）`；
 *  3. **导出面零变化**：`parseMasterKey` · `encrypt` · `decrypt` · `fingerprintOf`——调用方
 *     （`pay-channel.service.ts`、T5/T6）与提核前逐字同构；事务/审计/落库在 service 层。
 *
 * 行为口径（与提核前逐字一致）：
 *  - 主钥缺失（含空串——⚙️5「空串 = 未设」口径）/ 解码失败 / 长度非 32 ⇒ 视同未设（`null`）；
 *  - 主钥为 `null` ⇒ `encrypt`/`decrypt` **抛**（调用方 T5/T6 转 503 / RPC `ok:false`，⚙️18——
 *    「存储不可用」语义）；
 *  - 解密任何失败（前缀/结构/长度/乱码/夹杂质/错键名/错主钥）⇒ **抛**（响亮；**不静默丢行**）；
 *  - **缓存命中先于参数解析**：`parseMasterKey` 首次成功后，此后任何调用（含坏 raw/undefined）
 *    直接返回缓存的同一 Buffer——这是规格明文行为，非缺陷。
 */

/** 抛错文案（不含任何值/密文片段；缺主钥文案与 ⚙️18 的 503 message 同字，调用方可直接透传）。 */
const MASTER_KEY_MISSING = '渠道密钥存储未启用（缺主钥）';
const BODY_FORMAT = '渠道配置密文格式非法（v1）';
const BODY_DECRYPT_FAILED = '渠道配置密文解密失败（主钥不符或数据损坏）';

/** 首次解析成功的主钥缓存（§2.3「进程内首次解析成功后缓存」；`null` = 尚未成功解析过）。 */
let cachedMasterKey: Buffer | null = null;

/**
 * 解析主钥（§2.3 逐字；提核前语义逐字保留）。
 *
 * - `raw` 缺失/空串/解码非 32 字节 ⇒ `null`（= 视同未设）；
 * - **首次成功后缓存**：此后任何调用直接返回缓存的同一 Buffer（缓存命中先于参数解析）；
 * - 失败**不**缓存（未设态每次重新判定，行为恒等 `null`）。
 */
export function parseMasterKey(raw: string | undefined): Buffer | null {
  if (cachedMasterKey) return cachedMasterKey;
  const key = parseKey(raw);
  if (key) cachedMasterKey = key;
  return key;
}

/** 进程主钥（= env 解析 + 缓存）。encrypt/decrypt 的唯一取钥点。 */
function masterKey(): Buffer | null {
  return parseMasterKey(process.env.PAY_CONFIG_ENC_KEY);
}

/**
 * 加密（§2.3 逐字）：`'v1:' + base64(iv ‖ ciphertext ‖ tag)`；主钥缺 ⇒ 抛（调用方转 503）。
 */
export function encrypt(name: string, plaintext: string): string {
  const key = masterKey();
  if (!key) throw new Error(MASTER_KEY_MISSING);
  return encryptWithKey(key, name, plaintext);
}

/**
 * 解密（§2.3 逐字）：任何失败（前缀/结构/长度/乱码/错键名/错主钥/主钥缺）⇒ **抛**（响亮）；
 * core 的两个错误判别类分别映射回提核前的逐字文案。
 */
export function decrypt(name: string, enc: string): string {
  const key = masterKey();
  if (!key) throw new Error(MASTER_KEY_MISSING);
  try {
    return decryptWithKey(key, name, enc);
  } catch (err) {
    if (err instanceof CryptoFormatError) throw new Error(BODY_FORMAT);
    if (err instanceof CryptoDecryptError) throw new Error(BODY_DECRYPT_FAILED);
    throw err; // 防御性：core 只抛两个判别类；未知错误原样透传（不吞）
  }
}

/** 指纹（§2.3）：`sha256(canonical)` hex 小写前 12 位（识别用，不可逆推）。 */
export function fingerprintOf(canonical: string): string {
  return fingerprintOfCore(canonical);
}
