import {
  CryptoDecryptError,
  CryptoFormatError,
  decryptWithKey,
  encryptWithKey,
  fingerprintOf as fingerprintOfCore,
  parseKey,
} from '../sensitive-config/crypto-core';

/**
 * 通知通道密文存储的**薄绑定**（规格 §2.3/§2.9/⚙️6）——与
 * `pay-channel/pay-channel.crypto.ts` 同构，且**复用同一主钥** `PAY_CONFIG_ENC_KEY`（已裁 Q2-A）：
 * 算法/格式全在 `sensitive-config/crypto-core.ts`（纯原语、零 env）；本文件只承担三件通知侧职责：
 *  1. **主钥供给**：`process.env.PAY_CONFIG_ENC_KEY` 解析（core `parseKey`）+ **进程内首次解析
 *     成功后缓存**（§2.3；两绑定各自缓存同一把钥——同 env 同值，无行为差）；
 *  2. **§2.9 逐字文案**：`通知通道密钥存储未启用（缺主钥）`（503 message 同字，调用方可直接透传）/
 *     `通知配置密文格式非法（v1）` / `通知配置密文解密失败（主钥不符或数据损坏）`；
 *  3. 导出面照 pay 薄绑定：`parseMasterKey` · `encrypt` · `decrypt` · `fingerprintOf`——事务/审计/
 *     落库在 `notify-channel.service.ts` 层。
 *
 * 行为口径（照 pay 薄绑定逐字同构）：
 *  - 主钥缺失（含空串——⚙️5「空串 = 未设」口径）/ 解码失败 / 长度非 32 ⇒ 视同未设（`null`）；
 *  - 主钥为 `null` ⇒ `encrypt`/`decrypt` **抛**（调用方转 503 / RPC `ok:false`——§2.5② 的
 *    `通知通道密钥存储未启用` 另行组文案，见服务层）；
 *  - 解密任何失败（前缀/结构/长度/乱码/夹杂质/错键名/错主钥）⇒ **抛**（响亮；**不静默丢行**）；
 *  - **缓存命中先于参数解析**：`parseMasterKey` 首次成功后，此后任何调用（含坏 raw/undefined）
 *    直接返回缓存的同一 Buffer（规格明文行为，非缺陷）。
 */

/** 抛错文案（§2.9 逐字；不含任何值/密文片段）。 */
const MASTER_KEY_MISSING = '通知通道密钥存储未启用（缺主钥）';
const BODY_FORMAT = '通知配置密文格式非法（v1）';
const BODY_DECRYPT_FAILED = '通知配置密文解密失败（主钥不符或数据损坏）';

/** 首次解析成功的主钥缓存（§2.3「进程内首次解析成功后缓存」；`null` = 尚未成功解析过）。 */
let cachedMasterKey: Buffer | null = null;

/**
 * 解析主钥（§2.3 逐字；与 pay 薄绑定同构）。
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
 * core 的两个错误判别类分别映射为 §2.9 逐字文案。
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
