import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PayChannelKey } from '@fight-the-landlord/protocol';
import {
  validateAndNormalize,
  type PayChannelValidation,
} from '../src/pay-channel/pay-channel.validators';
import { fingerprintOf } from '../src/pay-channel/pay-channel.crypto';

/**
 * 六键校验/规范化单测（规格 §2.4 校验矩阵**逐格** + §2.3 canonical 口径 + §2.9 理由纪律）。
 *
 * 关键判据（§5.1.1）：
 *  - PEM 原文 与 base64(PEM) **两态同一输入 ⇒ canonical 与指纹完全相同**（含首尾空白归一）；
 *  - 坏 PEM / 空串 / 超长（URL 512、密钥 8192 canonical）/ 坏 URL / 非数字 PID ⇒ 400 理由；
 *  - **理由文本不含输入值**：喂含标记串 `ZZMARKERZZ` 的坏值 ⇒ 断言 reason 无该串（§2.9）。
 *
 * 密钥素材 = 切片内现生成（`generateKeyPairSync`，RSA-2048；超长用例单测内生成
 * RSA-8192——实测 canonical 8524 > 8192）。
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** 期望通过：返回 canonical。 */
function expectOk(result: PayChannelValidation): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`期望通过，实际拒绝：${result.reason}`);
  return result.canonical;
}

/**
 * 期望拒绝：断言 ok=false、reason 非空、**不含任何输入值片段**（标记串恒不在 reason 中；
 * §2.9——400 message 会回显到管理页/日志，值可能含密钥材料）。
 */
function expectReject(result: PayChannelValidation, ...requiredFragments: string[]): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`期望拒绝，实际通过：${result.canonical}`);
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.reason).not.toContain('ZZMARKERZZ');
  for (const fragment of requiredFragments) expect(result.reason).toContain(fragment);
  return result.reason;
}

const ALL_KEYS: readonly PayChannelKey[] = [
  'pay.channel.gatewayUrl',
  'pay.channel.appId',
  'pay.channel.privateKey',
  'pay.channel.publicKey',
  'pay.channel.sellerId',
  'pay.channel.publicBaseUrl',
];

describe('支付渠道六键校验/规范化（规格 §2.4 矩阵逐格）', () => {
  it('统一前置：全键先 trim；空串/纯空白 ⇒ 拒（理由「值不得为空」）', () => {
    for (const key of ALL_KEYS) {
      expect(validateAndNormalize(key, ''), key).toEqual({ ok: false, reason: '值不得为空' });
      expect(validateAndNormalize(key, '   \t \n '), key).toEqual({ ok: false, reason: '值不得为空' });
    }
  });

  it('gatewayUrl：http/https 合法 ⇒ canonical = 去尾斜杠后的原文（其余逐字、大小写不折叠）', () => {
    const cases: Array<[string, string]> = [
      ['https://openapi.alipay.com/gateway.do', 'https://openapi.alipay.com/gateway.do'],
      ['http://ftl-alipay-stub:8801', 'http://ftl-alipay-stub:8801'],
      ['https://example.com/', 'https://example.com'], // 尾斜杠剥掉（读侧同规：orders.service.ts:484）
      ['https://example.com//', 'https://example.com'], // 连续尾斜杠全剥
      ['  https://example.com:8443/pay///  ', 'https://example.com:8443/pay'], // 先 trim 再剥尾斜杠
      ['HTTP://EXAMPLE.com/A', 'HTTP://EXAMPLE.com/A'], // canonical 是「原文」——不低改协议/主机大小写
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize('pay.channel.gatewayUrl', raw)), raw).toBe(canonical);
    }
  });

  it('gatewayUrl / publicBaseUrl：坏 URL / 非 http(s) 协议 / 缺主机 ⇒ 拒', () => {
    const bad = [
      'not-a-url',
      'ftp://example.com',
      'javascript:alert(1)',
      'mailto:a@b.c',
      'https://', // 特殊协议缺主机 ⇒ 解析失败
      '//example.com/', // 协议相对 ⇒ 无 base 解析失败
      'ZZMARKERZZ://host/', // 可解析但协议非 http(s)
    ];
    for (const key of ['pay.channel.gatewayUrl', 'pay.channel.publicBaseUrl'] as const) {
      for (const raw of bad) expectReject(validateAndNormalize(key, raw));
    }
  });

  it('URL 两键：canonical 长度 ≤512（边界 512 过 / 513 拒；理由带上限、不含值）', () => {
    const prefix = 'https://e.co/'; // 13 字符
    const atLimit = prefix + 'a'.repeat(512 - prefix.length); // canonical 恰 512
    const overLimit = prefix + 'a'.repeat(513 - prefix.length); // canonical 513
    for (const key of ['pay.channel.gatewayUrl', 'pay.channel.publicBaseUrl'] as const) {
      expect(expectOk(validateAndNormalize(key, atLimit)).length).toBe(512);
      expectReject(validateAndNormalize(key, overLimit), '512');
    }
  });

  it('appId / sellerId：8-32 位纯数字 ⇒ canonical 原文；7/33 位、非数字 ⇒ 拒', () => {
    const good = ['12345678', '9021000000000000', '2088721087500000', '1'.repeat(32)];
    const bad = [
      '1'.repeat(7), // 短一位
      '1'.repeat(33), // 长一位（上限 32）
      '1234567a', // 含字母
      '9123 4567', // 内含空格
      '+12345678',
      '-12345678',
      '１２３４５６７８', // 全角数字非 [0-9]
      'ZZMARKERZZ',
    ];
    for (const key of ['pay.channel.appId', 'pay.channel.sellerId'] as const) {
      for (const raw of good) expect(expectOk(validateAndNormalize(key, raw))).toBe(raw);
      for (const raw of bad) expectReject(validateAndNormalize(key, raw));
      // trim 后判（§2.4：全键先 trim）——canonical = trim 后的原文
      expect(expectOk(validateAndNormalize(key, '  9021000000000000\n'))).toBe('9021000000000000');
    }
  });

  it('privateKey：PEM 原文与 base64(PEM) 两态 ⇒ canonical 与指纹完全相同（§5.1 判据）', () => {
    const pemState = expectOk(validateAndNormalize('pay.channel.privateKey', PRIVATE_PEM));
    const b64State = expectOk(
      validateAndNormalize('pay.channel.privateKey', Buffer.from(PRIVATE_PEM, 'utf8').toString('base64')),
    );
    const paddedState = expectOk(validateAndNormalize('pay.channel.privateKey', `\n  ${PRIVATE_PEM}  \n`));

    // canonical 公式逐字 = base64(pem.trim() + '\n')
    const expected = Buffer.from(PRIVATE_PEM.trim() + '\n', 'utf8').toString('base64');
    expect(pemState).toBe(expected);
    expect(b64State).toBe(expected);
    expect(paddedState).toBe(expected);
    // 两态同一输入 ⇒ 指纹完全相同
    expect(fingerprintOf(b64State)).toBe(fingerprintOf(pemState));
    expect(fingerprintOf(pemState)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('publicKey：同两态规则（canonical 与指纹完全一致）', () => {
    const pemState = expectOk(validateAndNormalize('pay.channel.publicKey', PUBLIC_PEM));
    const b64State = expectOk(
      validateAndNormalize('pay.channel.publicKey', Buffer.from(PUBLIC_PEM, 'utf8').toString('base64')),
    );
    expect(b64State).toBe(pemState);
    expect(pemState).toBe(Buffer.from(PUBLIC_PEM.trim() + '\n', 'utf8').toString('base64'));
    expect(fingerprintOf(b64State)).toBe(fingerprintOf(pemState));
  });

  it('密钥两键：坏 PEM / base64 解出非 PEM / 公钥进私钥位 ⇒ 拒（理由不含值）', () => {
    const notPemB64 = Buffer.from('definitely not a pem at all', 'utf8').toString('base64');
    expectReject(
      validateAndNormalize('pay.channel.privateKey', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'),
    );
    expectReject(validateAndNormalize('pay.channel.privateKey', notPemB64));
    expectReject(validateAndNormalize('pay.channel.privateKey', PUBLIC_PEM)); // createPrivateKey 解不了公钥
    expectReject(validateAndNormalize('pay.channel.publicKey', notPemB64));
    expectReject(
      validateAndNormalize('pay.channel.publicKey', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'),
    );
    expectReject(
      validateAndNormalize('pay.channel.publicKey', Buffer.from('not a pem', 'utf8').toString('base64')),
    );
  });

  it('密钥两键：canonical 超 8192 ⇒ 拒（RSA-8192 实测 canonical=8524；先证夹具确超限）', () => {
    const big = generateKeyPairSync('rsa', { modulusLength: 8192 });
    const bigPem = big.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const bigCanonical = Buffer.from(bigPem.trim() + '\n', 'utf8').toString('base64');
    expect(bigCanonical.length).toBeGreaterThan(8192); // 夹具自证：确在超限支路
    expectReject(validateAndNormalize('pay.channel.privateKey', bigPem), '8192');
    expectReject(validateAndNormalize('pay.channel.privateKey', bigCanonical), '8192'); // base64 态同拒
  }, 120_000);

  it('理由文案不含输入值（§2.9）：六键坏值（含标记串）⇒ reason 无任何输入片段', () => {
    const marked: Array<[PayChannelKey, string]> = [
      ['pay.channel.gatewayUrl', 'ZZMARKERZZ'],
      ['pay.channel.gatewayUrl', 'ZZMARKERZZ://host/'],
      ['pay.channel.gatewayUrl', 'https://e.co/' + 'ZZMARKERZZ' + 'a'.repeat(600)], // 超长支路
      ['pay.channel.publicBaseUrl', 'ZZMARKERZZ'],
      ['pay.channel.appId', 'ZZMARKERZZ'],
      ['pay.channel.sellerId', '20887210' + 'ZZMARKERZZ'],
      ['pay.channel.privateKey', 'ZZMARKERZZ'],
      ['pay.channel.privateKey', '-----BEGIN PRIVATE KEY-----\nZZMARKERZZ\n-----END PRIVATE KEY-----'],
      ['pay.channel.publicKey', 'ZZMARKERZZ'],
    ];
    for (const [key, raw] of marked) {
      const reason = expectReject(validateAndNormalize(key, raw)); // expectReject 内含 not.toContain(标记)
      expect(reason).not.toContain(raw); // 更强：整条输入也不在理由里
    }
    // 超长支路的分支证明：理由指向「512 上限」而非解析失败
    expectReject(
      validateAndNormalize('pay.channel.gatewayUrl', 'https://e.co/' + 'ZZMARKERZZ' + 'a'.repeat(600)),
      '512',
    );
  });

  it('幂等：对 canonical 再校验 ⇒ 同 canonical（URL 剥后稳定 / 密钥 base64 态稳定）', () => {
    const url1 = expectOk(validateAndNormalize('pay.channel.gatewayUrl', 'https://example.com///'));
    expect(expectOk(validateAndNormalize('pay.channel.gatewayUrl', url1))).toBe(url1);

    const key1 = expectOk(validateAndNormalize('pay.channel.privateKey', PRIVATE_PEM));
    expect(expectOk(validateAndNormalize('pay.channel.privateKey', key1))).toBe(key1);

    const pid1 = expectOk(validateAndNormalize('pay.channel.sellerId', ' 2088721087500000 '));
    expect(expectOk(validateAndNormalize('pay.channel.sellerId', pid1))).toBe(pid1);
  });
});

/**
 * 第三种输入形态：**控制台直出的裸 base64(DER)**（2026-10-07 现场修——支付宝控制台
 * 「复制支付宝公钥」按钮给的就是这个：只有 base64 字母表、无 `-----BEGIN` 头尾，解码出来是
 * 二进制 DER ⇒ 原实现（只认 PEM 原文 / base64(PEM)）会拒，非运维用户照着后台复制必然踩中）。
 */
describe('第三种输入形态：裸 base64(DER)（控制台「复制」直出）', () => {
  const PUBLIC_SPKI_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const PRIVATE_PKCS8_B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  it('公钥裸 base64(DER,SPKI) ⇒ 接受；canonical 还原为带标准头尾的可解析 PEM', () => {
    const canonical = expectOk(validateAndNormalize('pay.channel.publicKey', PUBLIC_SPKI_B64));
    const pemBack = Buffer.from(canonical, 'base64').toString('utf8');
    expect(pemBack).toContain('-----BEGIN PUBLIC KEY-----');
    expect(() => createPublicKey(pemBack)).not.toThrow();
  });

  it('私钥裸 base64(DER,PKCS#8) ⇒ 接受且可解析', () => {
    const canonical = expectOk(validateAndNormalize('pay.channel.privateKey', PRIVATE_PKCS8_B64));
    const pemBack = Buffer.from(canonical, 'base64').toString('utf8');
    expect(pemBack).toContain('-----BEGIN PRIVATE KEY-----');
    expect(() => createPrivateKey(pemBack)).not.toThrow();
  });

  it('PKCS#1 双形态（RSA PUBLIC KEY / RSA PRIVATE KEY 包裹兜底）⇒ 接受', () => {
    const pub1 = publicKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
    const priv1 = privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
    expect(() => createPublicKey(Buffer.from(expectOk(validateAndNormalize('pay.channel.publicKey', pub1)), 'base64').toString('utf8'))).not.toThrow();
    expect(() => createPrivateKey(Buffer.from(expectOk(validateAndNormalize('pay.channel.privateKey', priv1)), 'base64').toString('utf8'))).not.toThrow();
  });

  it('折行 / 夹空白的裸 base64（复制样带换行）⇒ 接受', () => {
    const folded = PUBLIC_SPKI_B64.replace(/(.{64})/g, '$1\n');
    expectOk(validateAndNormalize('pay.channel.publicKey', folded));
  });

  it('烂串仍拒（fail-closed 不变；reason 不含输入值）', () => {
    expectReject(validateAndNormalize('pay.channel.publicKey', 'ZZMARKERZZ-not-a-key'), '可解析的 PEM');
  });
});
