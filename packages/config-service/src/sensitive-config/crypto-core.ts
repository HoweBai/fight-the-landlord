import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 空间中立的密文原语（规格 §2.3/⚙️6）——**纯原语：零 env 访问、零缓存、零业务文案**。
 * pay/notify 两个薄绑定（`pay-channel/pay-channel.crypto.ts` / `notify-channel/notify-channel.crypto.ts`）
 * 各自注入主钥（env 解析 + 进程内缓存）并把本模块的**错误判别类**映射为各自逐字文案——
 * 本模块自身的抛错文案只用于排障，**不得**作为面向用户/接口的文案来源。
 *
 * 算法/格式逐字 = 支付片 §2.3：AES-256-GCM；每值 12B 随机 IV（`randomBytes(12)`）；
 * AAD = UTF-8 键名；tag 16B；输出 `'v1:' + base64(iv ‖ ciphertext ‖ tag)`；
 * 指纹 = `sha256(canonical)` hex 小写取前 12 位。
 *
 * 错误面（两个判别类，绑定层据此分流文案）：
 *  - `CryptoFormatError`：前缀/结构/长度/规范 base64 任一不符；
 *  - `CryptoDecryptError`：GCM 认证失败（AAD 不符/主钥不符/字节被篡改，**不区分**——防探测）。
 *
 * 零新依赖，只用 `node:crypto`（同 `admin/admin-password.ts` 模块形态：零原生编译链）。
 */

const ENC_PREFIX = 'v1:';
const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** 密文体最小结构长度：iv(12) + tag(16)；ciphertext 段可为 0 字节（明文为空串时）。 */
const MIN_BODY_BYTES = IV_BYTES + TAG_BYTES;
const FINGERPRINT_CHARS = 12;

/** 密文格式非法（前缀/结构/长度/规范 base64 任一不符）——绑定层映射为各自「格式非法」文案。 */
export class CryptoFormatError extends Error {
  constructor() {
    super('密文格式非法');
    this.name = 'CryptoFormatError';
  }
}

/** 密文解密失败（GCM 认证失败；AAD/主钥不符或数据损坏，不区分——防探测）——绑定层映射为「解密失败」文案。 */
export class CryptoDecryptError extends Error {
  constructor() {
    super('密文解密失败');
    this.name = 'CryptoDecryptError';
  }
}

/**
 * 解析主钥（§2.3）：base64 解码后**必须恰 32 字节**，否则 `null`（视同未设/非法）。
 * 缺失（含空串——⚙️5「空串 = 未设」口径）/ 解码失败 / 长度非 32 ⇒ 一律 `null`。
 * **无缓存**：缓存是绑定层的职责（两个绑定各自缓存同一把钥——§2.3）。
 */
export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null; // 缺失 / 空串（⚙️5：空串 = 未设）
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    return null; // 防御性（string 入参下 Node 的 base64 解码实际不抛，长度守卫兜底）
  }
  if (decoded.length !== KEY_BYTES) return null;
  return decoded;
}

/**
 * 加密（§2.3 逐字）：`'v1:' + base64(iv ‖ ciphertext ‖ tag)`；`key` 由调用方保证
 * （绑定层已过 `parseKey`/缓存）。**不读 env、不碰缓存。**
 */
export function encryptWithKey(key: Buffer, name: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8')); // AAD = UTF-8 键名
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // GCM ⇒ 恒 16B
  return ENC_PREFIX + Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

/**
 * 解密（§2.3 逐字）：前缀/结构/长度/规范 base64 不符 ⇒ `CryptoFormatError`；
 * GCM 认证失败（AAD 不符/主钥不符/字节被篡改）⇒ `CryptoDecryptError`。
 * **一律抛**（响亮，不静默丢行）；两类判别供绑定层映射为各自逐字文案。
 */
export function decryptWithKey(key: Buffer, name: string, enc: string): string {
  if (typeof enc !== 'string' || !enc.startsWith(ENC_PREFIX)) throw new CryptoFormatError();
  const body = enc.slice(ENC_PREFIX.length);
  const raw = Buffer.from(body, 'base64');
  // 规范形态比对：Node base64 解码对非法字符宽容（跳字/夹字仍出字节）⇒ 重编码必须逐字还原
  if (raw.length === 0 || raw.toString('base64') !== body) throw new CryptoFormatError();
  if (raw.length < MIN_BODY_BYTES) throw new CryptoFormatError();
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // AAD 不符 / 主钥不符 / 字节被篡改 —— GCM 认证失败统一归此（不区分，防探测；皆响亮抛）
    throw new CryptoDecryptError();
  }
}

/** 指纹（§2.3）：`sha256(canonical)` hex 小写前 12 位（识别用，不可逆推）。 */
export function fingerprintOf(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, FINGERPRINT_CHARS);
}
