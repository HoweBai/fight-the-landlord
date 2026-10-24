import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decrypt,
  encrypt,
  fingerprintOf,
  parseMasterKey,
} from '../src/pay-channel/pay-channel.crypto';

/**
 * 加密/主钥/指纹单测（规格 §2.3 逐字；§5.1.2）。
 *
 *  - 主钥 `PAY_CONFIG_ENC_KEY`：base64 解码恰 32B；缺失/短/长/坏 base64 ⇒ null（视同未设）；
 *    首次解析成功后**进程内缓存**（env 进程期不变）；
 *  - 加密：往返 · `v1:`+base64(iv‖ct‖tag) 形状 · 12B IV 随机 · UTF-8；
 *  - AAD 绑定：`encrypt('pay.channel.privateKey',…)` 后用 `decrypt('pay.channel.appId',…)` **必抛**；
 *  - 前缀错/截断/garbled/夹杂质 ⇒ 抛；主钥未设 / 错主钥 ⇒ 抛（响亮，不静默）；
 *  - 指纹：sha256 hex 小写前 12 位（钉已知向量）。
 *
 * ⚠️ 缓存语义 ⇒ 需要「无缓存新进程」的用例走 `vi.resetModules()` + 动态 import 取**新实例**
 * （本文件的静态实例在主钥用例后即持有缓存——这正是规格行为）。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';

const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/** 取一个**全新模块实例**（无主钥缓存），并把 env 置为给定值（undefined = 删除 = 缺失）。 */
async function freshCrypto(envValue: string | undefined) {
  vi.resetModules();
  if (envValue === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = envValue;
  return import('../src/pay-channel/pay-channel.crypto');
}

describe('pay-channel.crypto —— 主钥解析（规格 §2.3）', () => {
  it('缺失/空串/短/长/坏 base64 ⇒ 全 null（视同未设）；合法 32B ⇒ Buffer（⚙️13 常量逐字）', () => {
    expect(parseMasterKey(undefined)).toBeNull();
    expect(parseMasterKey('')).toBeNull();
    expect(parseMasterKey(Buffer.alloc(31).toString('base64'))).toBeNull(); // 短 1 字节
    expect(parseMasterKey(Buffer.alloc(33).toString('base64'))).toBeNull(); // 长 1 字节
    expect(parseMasterKey('@@@!!!')).toBeNull(); // 乱码（解出 0 字节）
    expect(parseMasterKey('not-base64')).toBeNull(); // 宽容解码也非 32B

    const key = parseMasterKey(DEV_KEY_B64);
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    expect(key!.equals(Buffer.from(DEV_KEY_B64, 'base64'))).toBe(true);
    expect(key!.toString('utf8')).toBe('ftl-dev-pay-enc-key-0123456789ab'); // ⚙️13 常量内容自证
  });

  it('首次解析成功后缓存：后续调用（含坏 raw/undefined）返回同一 Buffer（缓存命中先于参数解析）', () => {
    const cached = parseMasterKey(DEV_KEY_B64);
    expect(cached).not.toBeNull();
    expect(parseMasterKey(undefined)).toBe(cached); // 已成功 ⇒ 缓存即进程主钥（env 进程期不变）
    expect(parseMasterKey('@@@')).toBe(cached);
    expect(parseMasterKey(Buffer.alloc(32, 9).toString('base64'))).toBe(cached);
  });
});

describe('pay-channel.crypto —— 加解密（规格 §2.3）', () => {
  it('往返 + 形状：v1: 前缀；12B IV + ct + 16B tag；IV 随机（两次密文不同）；UTF-8 明文', () => {
    const plain = '应用私钥 canonical · 中文往返 😀';
    const enc1 = encrypt('pay.channel.privateKey', plain);
    const enc2 = encrypt('pay.channel.privateKey', plain);

    expect(enc1.startsWith('v1:')).toBe(true);
    expect(enc1).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(enc1.slice(3), 'base64')).toHaveLength(12 + Buffer.byteLength(plain, 'utf8') + 16);
    expect(enc2).not.toBe(enc1); // 每次 12B 随机 IV（randomBytes(12)）
    expect(decrypt('pay.channel.privateKey', enc1)).toBe(plain);
    expect(decrypt('pay.channel.privateKey', enc2)).toBe(plain);
  });

  it('AAD 绑定：encrypt(键名 A) 后用 decrypt(键名 B) 必抛；同键名正对照可解', () => {
    const enc = encrypt('pay.channel.privateKey', 'aad-probe-plaintext');
    expect(decrypt('pay.channel.privateKey', enc)).toBe('aad-probe-plaintext'); // 正对照
    expect(() => decrypt('pay.channel.appId', enc)).toThrow(); // AAD = UTF-8 键名，不符 ⇒ GCM 认证失败
  });

  it('前缀错/空体/截断/garbled/夹杂质 ⇒ 一律抛（响亮，不静默）', () => {
    const enc = encrypt('pay.channel.gatewayUrl', 'format-probe');
    const body = enc.slice(3);
    expect(() => decrypt('pay.channel.gatewayUrl', '')).toThrow();
    expect(() => decrypt('pay.channel.gatewayUrl', 'v2:' + body)).toThrow(); // 前缀错
    expect(() => decrypt('pay.channel.gatewayUrl', 'v1:')).toThrow(); // 空体
    expect(() => decrypt('pay.channel.gatewayUrl', enc.slice(0, 20))).toThrow(); // 截断（长度不足）
    expect(() => decrypt('pay.channel.gatewayUrl', enc.slice(0, enc.length - 8))).toThrow(); // 截断（tag 被切）
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
    expect(() => decrypt('pay.channel.gatewayUrl', 'v1:' + flipped)).toThrow(); // garbled（篡改一字符）
    // 夹杂质：Node base64 解码宽容（跳过非法字符仍出原字节）⇒ 规范形态比对把它归入格式非法
    expect(() => decrypt('pay.channel.gatewayUrl', 'v1:' + body.slice(0, 10) + '!!' + body.slice(10))).toThrow();
    expect(() => decrypt('pay.channel.gatewayUrl', 'v1:@@@@!!')).toThrow(); // 非 base64 乱码
  });

  it('主钥未设（空串/缺失，新实例无缓存）⇒ encrypt 与 decrypt 一律抛（fail-closed）', async () => {
    for (const envValue of ['', undefined]) {
      const m = await freshCrypto(envValue);
      expect(() => m.encrypt('pay.channel.privateKey', 'x')).toThrow(/未启用/);
      expect(() => m.decrypt('pay.channel.privateKey', 'v1:AAAA')).toThrow(/未启用/);
    }
  });

  it('错主钥（另一把 32B，新实例）⇒ 解旧密文抛；同实例自加密往返正对照', async () => {
    const enc = encrypt('pay.channel.privateKey', 'wrong-key-probe'); // 静态实例（dev 主钥）
    const m = await freshCrypto(Buffer.alloc(32, 0x42).toString('base64'));
    expect(() => m.decrypt('pay.channel.privateKey', enc)).toThrow(); // 主钥不符 ⇒ GCM 认证失败抛
    // 正对照：失败源自「主钥不符」而非实例损坏——同一新实例自加密可往返
    expect(m.decrypt('pay.channel.privateKey', m.encrypt('pay.channel.privateKey', 'wrong-key-probe'))).toBe(
      'wrong-key-probe',
    );
  });
});

describe('pay-channel.crypto —— 指纹（规格 §2.3）', () => {
  it('fingerprintOf = sha256 hex 小写前 12 位（钉已知向量 + 稳定性 + 区分性）', () => {
    expect(fingerprintOf('abc')).toBe('ba7816bf8f01'); // sha256('abc') = ba7816bf8f01cfea…
    expect(fingerprintOf('abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'));
    expect(fingerprintOf('abd')).not.toBe(fingerprintOf('abc'));
  });
});
