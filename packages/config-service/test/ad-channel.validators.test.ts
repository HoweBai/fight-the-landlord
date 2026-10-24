import { describe, expect, it } from 'vitest';
import type { AdChannelKey } from '@fight-the-landlord/protocol';
import {
  validateAndNormalize,
  type AdChannelValidation,
} from '../src/ad-channel/ad-channel.validators';
import { fingerprintOf } from '../src/ad-channel/ad-channel.crypto';

/**
 * 单键（`ad.callbackSecret`）校验/规范化单测——照 pay/notify 校验测试的**框**（expectOk/expectReject
 * 纪律 + 标记串自证）克隆，矩阵按本键空间实际形态裁剪。
 *
 * **键材料形态规则（v1.4 T0 回填后定稿）**：本组钉的是最终规则「**trim 后非空字符串、≤512**」
 * （canonical = trim 原文）。官方文档未给 `ad.callbackSecret` 字符集/长度契约 ⇒ **有意不收窄**
 * （不强制 hex/等长——真实平台密钥是不透明字符串，收严会在开通日 400 阻断配置）；
 * 本规则即定稿，断言就是最终形态。
 *
 * 关键判据：
 *  - 统一前置：先 trim；空串/纯空白 ⇒ 拒「值不得为空」；
 *  - 长度上限：≤512 过（边界 512）/ 513 拒（理由带上限）；
 *  - **理由文本不含输入值**：喂含标记串 `ZZMARKERZZ` 的坏值 ⇒ 断言 reason 无该串；
 *  - 非字符串（运行时防御）⇒「值必须是字符串」；未知键（运行时形态）⇒「未知键」。
 */

const KEY: AdChannelKey = 'ad.callbackSecret';

/** 期望通过：返回 canonical。 */
function expectOk(result: AdChannelValidation): string {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`期望通过，实际拒绝：${result.reason}`);
  return result.canonical;
}

/**
 * 期望拒绝：断言 ok=false、reason 非空、**不含任何输入值片段**（标记串恒不在 reason 中；
 * 克隆先例 §2.9——400 message 会回显到管理页/日志，值可能含密钥材料）。
 */
function expectReject(result: AdChannelValidation, ...requiredFragments: string[]): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`期望拒绝，实际通过：${result.canonical}`);
  expect(result.reason.length).toBeGreaterThan(0);
  expect(result.reason).not.toContain('ZZMARKERZZ');
  for (const fragment of requiredFragments) expect(result.reason).toContain(fragment);
  return result.reason;
}

describe('广告回调密钥单键校验/规范化（v1.4 定稿规则：trim 后非空字符串、≤512）', () => {
  it('统一前置：先 trim；空串/纯空白 ⇒ 拒（理由「值不得为空」）', () => {
    expect(validateAndNormalize(KEY, '')).toEqual({ ok: false, reason: '值不得为空' });
    expect(validateAndNormalize(KEY, '   \t \n ')).toEqual({ ok: false, reason: '值不得为空' });
  });

  it('合法：任意非空字符串（含大小写/连字符/空格内形）⇒ canonical = trim 原文（唯一变换；不收窄字符集）', () => {
    const cases: Array<[string, string]> = [
      ['abc123', 'abc123'],
      ['A1b2C3d4E5f6', 'A1b2C3d4E5f6'],
      ['  uniad-callback-secret-001  ', 'uniad-callback-secret-001'], // 先 trim 后判
      ['  \nKEY-with-inner space and-stuff-1234567890 \t ', 'KEY-with-inner space and-stuff-1234567890'],
    ];
    for (const [raw, canonical] of cases) {
      expect(expectOk(validateAndNormalize(KEY, raw)), raw).toBe(canonical);
    }
  });

  it('长度上限 512（canonical）：边界 512 过 / 513 拒（理由带上限、不含值）', () => {
    const atLimit = 'a'.repeat(512);
    const overLimit = 'a'.repeat(513);
    expect(expectOk(validateAndNormalize(KEY, atLimit)).length).toBe(512);
    expectReject(validateAndNormalize(KEY, overLimit), '512');
    // trim 后判：513 且首尾有空白 ⇒ canonical 恰 512 ⇒ 过（先 trim 再量）
    expect(expectOk(validateAndNormalize(KEY, ` ${atLimit} `)).length).toBe(512);
  });

  it('非字符串（运行时防御支）⇒ 拒「值必须是字符串」（类型调用面不可达）', () => {
    expect(validateAndNormalize(KEY, 123 as unknown as string)).toEqual({
      ok: false,
      reason: '值必须是字符串',
    });
    expect(validateAndNormalize(KEY, null as unknown as string)).toEqual({
      ok: false,
      reason: '值必须是字符串',
    });
  });

  it('未知键（运行时形态）⇒ 拒「未知键」（default 兜底；controller 注册表另拦同字）', () => {
    expect(validateAndNormalize('ad.nope' as AdChannelKey, 'anything')).toEqual({
      ok: false,
      reason: '未知键',
    });
  });

  it('理由文案不含输入值（克隆先例 §2.9）：坏值（含标记串）⇒ reason 无任何输入片段', () => {
    const marked: string[] = [
      'ZZMARKERZZ' + 'a'.repeat(600), // 超长支路（标记在输入里）
      ` ${'ZZMARKERZZ'}`.repeat(70), // trim 后仍超 512
    ];
    for (const raw of marked) {
      const reason = expectReject(validateAndNormalize(KEY, raw)); // expectReject 内含 not.toContain(标记)
      expect(reason).not.toContain(raw); // 更强：整条输入也不在理由里
    }
    // 超长支路的分支证明：理由指向「512 上限」而非其它分支
    expectReject(validateAndNormalize(KEY, 'ZZMARKERZZ' + 'a'.repeat(600)), '512');
  });

  it('幂等：对 canonical 再校验 ⇒ 同 canonical（trim 稳定）', () => {
    const canonical = expectOk(validateAndNormalize(KEY, '  uniad-callback-secret-001  '));
    expect(expectOk(validateAndNormalize(KEY, canonical))).toBe(canonical);
    expect(fingerprintOf(canonical)).toMatch(/^[0-9a-f]{12}$/);
  });
});
