import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CryptoDecryptError,
  CryptoFormatError,
  decryptWithKey,
  encryptWithKey,
  fingerprintOf,
  parseKey,
} from '../src/sensitive-config/crypto-core';
import {
  decrypt as payDecrypt,
  encrypt as payEncrypt,
  fingerprintOf as payFingerprintOf,
  parseMasterKey as payParseMasterKey,
} from '../src/pay-channel/pay-channel.crypto';
import {
  decrypt as notifyDecrypt,
  encrypt as notifyEncrypt,
  fingerprintOf as notifyFingerprintOf,
  parseMasterKey as notifyParseMasterKey,
} from '../src/notify-channel/notify-channel.crypto';

/**
 * crypto 泛化单测（T3；规格 §2.3/⚙️6/§2.9）——四段：
 *  ① `crypto-core` 纯原语：零 env 访问、零缓存；往返/AAD 绑定/前缀与截断/garbled/规范 base64
 *     比对/指纹向量——照 `pay-channel.crypto.test.ts` 全格，另钉**错误判别类**
 *     （`CryptoFormatError`/`CryptoDecryptError`——绑定层按类映射文案，判别错了即文案错）；
 *  ② `notify-channel.crypto` 薄绑定：env `PAY_CONFIG_ENC_KEY` + 进程内缓存 + §2.9 逐字文案；
 *  ③ 跨绑定同构：pay/notify 复用同设施（同主钥同格式，密文可互换）；
 *  ④ pay 薄绑定零变化钉（T3 首验收面）：导出面/文案逐字/缓存语义——§5.1.2「pay 侧全量回归」
 *     之外的**逐字文案补强**（既有 pay 测试对两条内层文案只做泛抛断言，逐字面原为空白）。
 *
 * ⚠️ 缓存语义 ⇒ 需要「无缓存新进程」的用例走 `vi.resetModules()` + 动态 import 取**新实例**
 * （静态实例一旦成功解析即持缓存——这正是规格行为）；凡用静态实例的用例都显式设 env，
 * 防前序 fresh 用例改 env 造成顺序依赖。
 */

/** ⚙️13 dev 常量：base64(32B ASCII) = base64('ftl-dev-pay-enc-key-0123456789ab')（复用既有供给链）。 */
const DEV_KEY_B64 = 'ZnRsLWRldi1wYXktZW5jLWtleS0wMTIzNDU2Nzg5YWI=';

const ORIGINAL_ENV = process.env.PAY_CONFIG_ENC_KEY;

beforeAll(() => {
  process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
});
afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = ORIGINAL_ENV;
});

/** §2.9 逐字文案断言助手：捕获同步抛错的 message（不抛 ⇒ 测试红）。 */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return (err as Error).message;
  }
  throw new Error('预期抛错，实际未抛');
}

/** 取 notify 绑定的**全新模块实例**（无主钥缓存），并把 env 置为给定值（undefined = 删除 = 缺失）。 */
async function freshNotify(envValue: string | undefined) {
  vi.resetModules();
  if (envValue === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = envValue;
  return import('../src/notify-channel/notify-channel.crypto');
}

/** 同上，pay 绑定（零变化钉用）。 */
async function freshPay(envValue: string | undefined) {
  vi.resetModules();
  if (envValue === undefined) delete process.env.PAY_CONFIG_ENC_KEY;
  else process.env.PAY_CONFIG_ENC_KEY = envValue;
  return import('../src/pay-channel/pay-channel.crypto');
}

describe('crypto-core —— 纯原语（规格 §2.3；零 env/零缓存）', () => {
  it('parseKey：缺失/空串/短/长/坏 base64 ⇒ 全 null；合法 32B ⇒ Buffer（⚙️13 常量逐字）', () => {
    expect(parseKey(undefined)).toBeNull();
    expect(parseKey('')).toBeNull();
    expect(parseKey(Buffer.alloc(31).toString('base64'))).toBeNull(); // 短 1 字节
    expect(parseKey(Buffer.alloc(33).toString('base64'))).toBeNull(); // 长 1 字节
    expect(parseKey('@@@!!!')).toBeNull(); // 乱码（解出 0 字节）
    expect(parseKey('not-base64')).toBeNull(); // 宽容解码也非 32B

    const key = parseKey(DEV_KEY_B64);
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    expect(key!.equals(Buffer.from(DEV_KEY_B64, 'base64'))).toBe(true);
    expect(key!.toString('utf8')).toBe('ftl-dev-pay-enc-key-0123456789ab'); // ⚙️13 常量内容自证
  });

  it('零 env 访问 + 零缓存：env 设着合法主钥时 parseKey(undefined) 仍 null（不回退读 env）；两次解析各自新实例', () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64; // 若 core 偷读 env，下面第一行即暴露
    expect(parseKey(undefined)).toBeNull(); // 不回退读 env
    expect(parseKey('@@@!!!')).toBeNull();
    expect(parseKey(DEV_KEY_B64)).not.toBe(parseKey(DEV_KEY_B64)); // 无模块级缓存（每次新 Buffer，内容相等）
    expect(parseKey(DEV_KEY_B64)!.equals(parseKey(DEV_KEY_B64)!)).toBe(true);
  });

  it('往返 + 形状：v1: 前缀；12B IV + ct + 16B tag；IV 随机（两次密文不同）；UTF-8 明文；空明文边界（恰 28B）', () => {
    const key = parseKey(DEV_KEY_B64)!;
    const plain = '通知通道 canonical · 中文往返 😀';
    const enc1 = encryptWithKey(key, 'notify.smtp.pass', plain);
    const enc2 = encryptWithKey(key, 'notify.smtp.pass', plain);

    expect(enc1.startsWith('v1:')).toBe(true);
    expect(enc1).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(enc1.slice(3), 'base64')).toHaveLength(12 + Buffer.byteLength(plain, 'utf8') + 16);
    expect(enc2).not.toBe(enc1); // 每次 12B 随机 IV（randomBytes(12)）
    expect(decryptWithKey(key, 'notify.smtp.pass', enc1)).toBe(plain);
    expect(decryptWithKey(key, 'notify.smtp.pass', enc2)).toBe(plain);

    // 空明文：ct 段 0 字节、raw 恰 28B（= 最小结构长度边界）⇒ 仍往返（MIN_BODY_BYTES 正边界）
    const encEmpty = encryptWithKey(key, 'notify.email.to', '');
    expect(Buffer.from(encEmpty.slice(3), 'base64')).toHaveLength(28);
    expect(decryptWithKey(key, 'notify.email.to', encEmpty)).toBe('');
  });

  it('AAD 绑定：encryptWithKey(键名 A) 后用 decryptWithKey(键名 B) ⇒ CryptoDecryptError；同键名正对照可解', () => {
    const key = parseKey(DEV_KEY_B64)!;
    const enc = encryptWithKey(key, 'notify.smtp.pass', 'aad-probe-plaintext');
    expect(decryptWithKey(key, 'notify.smtp.pass', enc)).toBe('aad-probe-plaintext'); // 正对照
    expect(() => decryptWithKey(key, 'notify.smtp.user', enc)).toThrow(CryptoDecryptError); // AAD = UTF-8 键名
  });

  it('前缀错/空串/空体/截断/garbled/夹杂质/非字符串 ⇒ 判别类恰为 CryptoFormatError（规范 base64 比对）', () => {
    const key = parseKey(DEV_KEY_B64)!;
    const name = 'notify.webhook.feishuUrl';
    const enc = encryptWithKey(key, name, 'format-probe');
    const body = enc.slice(3);
    expect(() => decryptWithKey(key, name, '')).toThrow(CryptoFormatError); // 空串
    expect(() => decryptWithKey(key, name, 'v2:' + body)).toThrow(CryptoFormatError); // 前缀错
    expect(() => decryptWithKey(key, name, 'v1:')).toThrow(CryptoFormatError); // 空体
    expect(() => decryptWithKey(key, name, enc.slice(0, 20))).toThrow(CryptoFormatError); // 截断（长度不足）
    expect(() => decryptWithKey(key, name, enc.slice(0, 28))).toThrow(CryptoFormatError); // 截断（非规范 base64 长度）
    // 尾部截断 8 字符：恰剩 48 字符规范 base64（解出 36B ≥ 28B）⇒ **结构校验通过**、走 GCM ⇒ 认证失败
    // （与提核前逐字同语义——旧测试只做泛抛断言，此边界此前不可见）
    expect(() => decryptWithKey(key, name, enc.slice(0, enc.length - 8))).toThrow(CryptoDecryptError);
    // 夹杂质：Node base64 解码宽容（跳过非法字符仍出原字节）⇒ 规范形态比对把它归入格式非法
    expect(() => decryptWithKey(key, name, 'v1:' + body.slice(0, 10) + '!!' + body.slice(10))).toThrow(
      CryptoFormatError,
    );
    expect(() => decryptWithKey(key, name, 'v1:@@@@!!')).toThrow(CryptoFormatError); // 非 base64 乱码
    expect(() => decryptWithKey(key, name, 42 as unknown as string)).toThrow(CryptoFormatError); // 非字符串守卫

    // garbled（篡改一字符）：结构仍合法 ⇒ 走 GCM 认证失败（判别类与格式错分界）
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
    expect(() => decryptWithKey(key, name, 'v1:' + flipped)).toThrow(CryptoDecryptError);
  });

  it('错主钥（另一把 32B）：解旧密文 ⇒ CryptoDecryptError；同一把钥自加密往返正对照', () => {
    const key = parseKey(DEV_KEY_B64)!;
    const other = Buffer.alloc(32, 0x42);
    const enc = encryptWithKey(key, 'notify.smtp.pass', 'wrong-key-probe');
    expect(() => decryptWithKey(other, 'notify.smtp.pass', enc)).toThrow(CryptoDecryptError); // 主钥不符 ⇒ GCM 认证失败
    // 正对照：失败源自「主钥不符」而非入参损坏——同一把钥自加密可往返
    expect(decryptWithKey(other, 'notify.smtp.pass', encryptWithKey(other, 'notify.smtp.pass', 'wrong-key-probe'))).toBe(
      'wrong-key-probe',
    );
  });

  it('fingerprintOf = sha256 hex 小写前 12 位（钉已知向量 + 稳定性 + 区分性）', () => {
    expect(fingerprintOf('abc')).toBe('ba7816bf8f01'); // sha256('abc') = ba7816bf8f01cfea…
    expect(fingerprintOf('abc')).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprintOf('abc')).toBe(fingerprintOf('abc'));
    expect(fingerprintOf('abd')).not.toBe(fingerprintOf('abc'));
  });
});

describe('notify-channel.crypto —— 薄绑定（env PAY_CONFIG_ENC_KEY + 缓存 + §2.9 逐字文案）', () => {
  it('往返（env 主钥）；格式非法/解密失败/回读 = §2.9 逐字文案；AAD 绑定同此', () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    const name = 'notify.smtp.pass';
    const plain = '通知通道密钥往返 😀';
    const enc = notifyEncrypt(name, plain);
    expect(notifyDecrypt(name, enc)).toBe(plain);

    const body = enc.slice(3);
    expect(messageOf(() => notifyDecrypt(name, 'v2:' + body))).toBe('通知配置密文格式非法（v1）'); // 前缀错
    expect(messageOf(() => notifyDecrypt(name, 'v1:' + body.slice(0, 10) + '!!' + body.slice(10)))).toBe(
      '通知配置密文格式非法（v1）', // 夹杂质 ⇒ 规范 base64 比对
    );
    expect(messageOf(() => notifyDecrypt(name, 'v1:'))).toBe('通知配置密文格式非法（v1）'); // 空体
    expect(messageOf(() => notifyDecrypt('notify.webhook.feishuUrl', enc))).toBe(
      '通知配置密文解密失败（主钥不符或数据损坏）', // AAD（键名）不符
    );
    const flipped = body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
    expect(messageOf(() => notifyDecrypt(name, 'v1:' + flipped))).toBe('通知配置密文解密失败（主钥不符或数据损坏）'); // 篡改
  });

  it('主钥未设（空串/缺失，新实例无缓存）⇒ encrypt 与 decrypt 皆 `通知通道密钥存储未启用（缺主钥）`（fail-closed）', async () => {
    for (const envValue of ['', undefined]) {
      const m = await freshNotify(envValue);
      expect(messageOf(() => m.encrypt('notify.smtp.pass', 'x'))).toBe('通知通道密钥存储未启用（缺主钥）');
      expect(messageOf(() => m.decrypt('notify.smtp.pass', 'v1:AAAA'))).toBe('通知通道密钥存储未启用（缺主钥）');
    }
  });

  it('缓存语义：首次解析成功后 parseMasterKey（含坏 raw/undefined）返回同一 Buffer（缓存命中先于参数解析）', () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    const cached = notifyParseMasterKey(DEV_KEY_B64);
    expect(cached).not.toBeNull();
    expect(notifyParseMasterKey(undefined)).toBe(cached); // 已成功 ⇒ 缓存即进程主钥（env 进程期不变）
    expect(notifyParseMasterKey('@@@')).toBe(cached);
  });

  it('错主钥（另一把 32B，新实例）⇒ 解旧密文 `通知配置密文解密失败（主钥不符或数据损坏）`；同实例自加密往返正对照', async () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    const enc = notifyEncrypt('notify.smtp.pass', 'wrong-key-probe'); // 静态实例（dev 主钥）
    const m = await freshNotify(Buffer.alloc(32, 0x42).toString('base64'));
    expect(messageOf(() => m.decrypt('notify.smtp.pass', enc))).toBe('通知配置密文解密失败（主钥不符或数据损坏）');
    // 正对照：失败源自「主钥不符」而非实例损坏——同一新实例自加密可往返
    expect(m.decrypt('notify.smtp.pass', m.encrypt('notify.smtp.pass', 'wrong-key-probe'))).toBe('wrong-key-probe');
  });
});

describe('跨绑定同构（§2.3：pay/notify 同设施同格式）', () => {
  it('pay 加密 ⇄ notify 解密（双向）：同一 env 主钥、同一 v1 格式，密文可跨绑定互换', async () => {
    vi.resetModules();
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    const pay = await import('../src/pay-channel/pay-channel.crypto');
    const notify = await import('../src/notify-channel/notify-channel.crypto');
    const name = 'notify.smtp.pass';

    const fromPay = pay.encrypt(name, 'pay→notify 往返 😀');
    expect(fromPay.startsWith('v1:')).toBe(true);
    expect(notify.decrypt(name, fromPay)).toBe('pay→notify 往返 😀'); // notify 解 pay 密文

    const fromNotify = notify.encrypt(name, 'notify→pay 往返');
    expect(pay.decrypt(name, fromNotify)).toBe('notify→pay 往返'); // pay 解 notify 密文
  });

  it('fingerprintOf 同构：notify/pay 指纹函数逐字同值（且 = §2.3 已知向量）', () => {
    expect(notifyFingerprintOf('abc')).toBe(payFingerprintOf('abc'));
    expect(notifyFingerprintOf('abc')).toBe('ba7816bf8f01');
  });
});

describe('pay 薄绑定 —— 零变化钉（T3 首验收：导出面/文案逐字/缓存语义）', () => {
  it('导出面恰四函数；两条内层文案逐字（既有 pay 测试未钉的逐字面，此处补强）', () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    expect(typeof payParseMasterKey).toBe('function');
    expect(typeof payEncrypt).toBe('function');
    expect(typeof payDecrypt).toBe('function');
    expect(typeof payFingerprintOf).toBe('function');

    const enc = payEncrypt('pay.channel.privateKey', 'wording-nail');
    expect(payDecrypt('pay.channel.privateKey', enc)).toBe('wording-nail'); // 正对照
    expect(messageOf(() => payDecrypt('pay.channel.privateKey', 'v2:' + enc.slice(3)))).toBe(
      '渠道配置密文格式非法（v1）',
    );
    expect(messageOf(() => payDecrypt('pay.channel.appId', enc))).toBe('渠道配置密文解密失败（主钥不符或数据损坏）'); // AAD 不符
  });

  it('缓存语义 + 缺主钥文案 `渠道密钥存储未启用（缺主钥）` 逐字（新实例；encrypt/decrypt 同文案）', async () => {
    process.env.PAY_CONFIG_ENC_KEY = DEV_KEY_B64;
    const cached = payParseMasterKey(DEV_KEY_B64);
    expect(cached).not.toBeNull();
    expect(payParseMasterKey(undefined)).toBe(cached); // 缓存命中先于参数解析
    expect(payParseMasterKey('@@@')).toBe(cached);

    for (const envValue of ['', undefined]) {
      const m = await freshPay(envValue);
      expect(messageOf(() => m.encrypt('pay.channel.privateKey', 'x'))).toBe('渠道密钥存储未启用（缺主钥）');
      expect(messageOf(() => m.decrypt('pay.channel.privateKey', 'v1:AAAA'))).toBe('渠道密钥存储未启用（缺主钥）');
    }
  });
});
