/**
 * `robot/config.ts` 的**纯函数**语义（片⑦ E1 后的保留面）。
 *
 * ─── 片⑦ E6 显式登记（判据减少）──────────────────────────────────────────
 * 旧 `parseRuleFallback`（env 字符串 `'true'`/`'false'` ⇒ boolean，其余 ⇒ 抛）的
 * **4 组用例随 E1「env 解析退役」删除**。语义继受 = **C5**：`robot.ruleFallback` 的
 * 严格 true/false 校验移到 config-service 的 `parseConfigValue`（非法 ⇒ 400 且**不落库**，
 * 由 `packages/config-service/test/config.validation.test.ts` 承接）；
 * robot 侧的新定义点是 `config-cache.service.ts` 的 `ruleFallback()`（形状非法 ⇒ 默认 true，
 * 断言在 `config-cache.test.ts` 的「形状非法」组）。
 *
 * ─── 保留面 ─────────────────────────────────────────────────────────────
 * `DEFAULT_SKILL_DISTRIBUTION`（= 种子）与 `parseSkillDistribution` 纯函数 ——
 * `'15,35,50'` 的**归一化语义逐字保留**（规格 §2.2：`'15,35,50'` 合法 ⇒ 0.15/0.35/0.5）。
 */
import { describe, expect, it } from 'vitest';
import { parseSkillDistribution } from '../src/robot/config';

describe('parseSkillDistribution（片② D3；片⑦ E1 后 = 默认串的解析器）', () => {
  it('未设 ⇒ 用户裁决 10 的默认比例（显式 undefined 与省略参数同义）', () => {
    const expected = [
      ['beginner', 0.15], ['intermediate', 0.35], ['advanced', 0.5],
    ];
    expect(parseSkillDistribution(undefined)).toEqual(expected);
    expect(parseSkillDistribution()).toEqual(expected);
  });
  it('可配 + 归一化（15,35,50 ≡ 0.15,0.35,0.5）', () => {
    const a = parseSkillDistribution('beginner=15,intermediate=35,advanced=50');
    expect(a.map(([k, w]) => [k, Number(w.toFixed(6))])).toEqual([
      ['beginner', 0.15], ['intermediate', 0.35], ['advanced', 0.5],
    ]);
  });
  it('缺档 ⇒ 抛', () => {
    expect(() => parseSkillDistribution('beginner=0.5,intermediate=0.5')).toThrow();
  });
  it('档位名不认识 ⇒ 抛（明确到 unknown level）', () => {
    expect(() => parseSkillDistribution('expert=1,beginner=1,intermediate=1,advanced=1'))
      .toThrow(/unknown level/);
  });
  it('重复一档 ⇒ 抛（三档齐全但 beginner 出现两次）', () => {
    expect(() => parseSkillDistribution('beginner=0.5,beginner=0.5,intermediate=0.3,advanced=0.2'))
      .toThrow(/duplicate/);
  });
  it('负数 / 全 0 / 非数字 ⇒ 抛', () => {
    expect(() => parseSkillDistribution('beginner=-1,intermediate=1,advanced=1')).toThrow();
    expect(() => parseSkillDistribution('beginner=0,intermediate=0,advanced=0')).toThrow();
    expect(() => parseSkillDistribution('beginner=abc,intermediate=1,advanced=1')).toThrow();
  });
  it('空串 ⇒ 抛（docker run -e VAR= 的真·空值形态）', () => {
    expect(() => parseSkillDistribution('')).toThrow();
  });
});
