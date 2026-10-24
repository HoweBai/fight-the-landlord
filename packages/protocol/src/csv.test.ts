import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell } from './csv';

/**
 * ③ 财务后台 + RBAC + 审计 T1：`csv.ts`（CSV 单元格算法**单一真源**，规格 §0.3 ⚙️7 + §2.11）单测。
 *
 * 判别式逐字（§2.11）：
 *  1. `null` / `undefined` ⇒ `''`；其余 `String(v)`；
 *  2. **非 NUMERIC** 且首字符 ∈ {`=` `+` `-` `@` `\t` `\r`} ⇒ 前置 `'`（公式注入消毒；合法数字豁免）；
 *  3. 含 `"` / `,` / CR / LF ⇒ 整格双引号包裹 + 内部 `"` 双写（RFC4180）。
 *
 * 行尾 `\r\n` 与表头中文、`Content-Disposition` 文件名是**各列表面**的事（T4/T6 消费本件），
 * 本件只钉「首字节 BOM」与「单元格」两个共享值。
 */

describe('CSV_BOM（§2.11：首字节 BOM）', () => {
  it("=== '\\uFEFF'（U+FEFF 恰好一个字符）", () => {
    expect(CSV_BOM).toBe('\uFEFF');
    expect(CSV_BOM).toHaveLength(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('csvCell（§2.11 ⚙️7 逐字）', () => {
  it('null / undefined ⇒ 空串', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('表驱动：消毒只在「非 NUMERIC 且危险首字符」时发生；转义按 RFC4180', () => {
    // [输入, 期望, 备注]
    const cases: Array<[unknown, string, string]> = [
      // ── 原样面 ──────────────────────────────────────────────────────────
      ['abc', 'abc', '纯文本原样'],
      [123, '123', '数字类型 ⇒ String(v)'],
      [0, '0', '数字 0'],
      [true, 'true', '布尔 String(v)'],
      ['a=b', 'a=b', '= 不在首位 ⇒ 不消毒'],
      ['a+b', 'a+b', '+ 不在首位 ⇒ 不消毒'],
      [' a', ' a', '空格起头不在消毒字符集 ⇒ 原样'],
      ['  123', '  123', '带前导空格的数字既非 NUMERIC 也不危险 ⇒ 原样'],
      ['12.', '12.', 'NUMERIC 要求小数点后至少一位 ⇒ 不匹配，但首字符不危险 ⇒ 原样'],
      // ── NUMERIC 豁免面（合法数字不加前导 '）──────────────────────────────
      ['-12.5', '-12.5', '负小数字符串 = NUMERIC ⇒ 豁免'],
      [-12.5, '-12.5', '负小数 number 同判'],
      ['-0', '-0', '负零 = NUMERIC ⇒ 豁免'],
      ['007', '007', '前导零数字仍属 NUMERIC ⇒ 豁免'],
      ['12.5', '12.5', '正小数'],
      // ── 公式注入消毒面（非 NUMERIC 的危险首字符）────────────────────────
      ['=cmd()', "'=cmd()", '= 起 ⇒ 前置单引号'],
      ['+1', "'+1", '+1 不是 NUMERIC（NUMERIC 不吃 +）⇒ 消毒'],
      ['-abc', "'-abc", '- 起但非数字 ⇒ 消毒（与 -12.5 分支互锁）'],
      ['@SUM(A1)', "'@SUM(A1)", '@ 起 ⇒ 消毒'],
      ['\t=cmd', "'\t=cmd", '制表起 ⇒ 消毒'],
      ['=a', "'=a", '短形态'],
      // ── RFC4180 引用/转义面 ──────────────────────────────────────────────
      ['a,b', '"a,b"', '逗号 ⇒ 包裹'],
      ['1,2', '"1,2"', '带逗号的数字串 ⇒ 先按「非 NUMERIC」判（不消毒），再包裹'],
      ['a"b', '"a""b"', '内部引号 ⇒ 包裹 + 双写'],
      ['a\nb', '"a\nb"', 'LF ⇒ 包裹'],
      ['a\r\nb', '"a\r\nb"', 'CRLF ⇒ 包裹'],
      ['\r=cmd', `"'\r=cmd"`, 'CR 起 ⇒ 先消毒再加引号；又因含 CR ⇒ 再包裹（复合）'],
      ['=a,"b"', `"'=a,""b"""`, '复合：先消毒再加引号，再包裹 + 内部引号双写'],
    ];
    for (const [input, expected, note] of cases) {
      expect(csvCell(input), `${JSON.stringify(input)}（${note}）`).toBe(expected);
    }
  });

  it('消毒与转义是**两步**、次序固定（先加 \' 再包裹）：=1 与 "=1" 的期望不同', () => {
    // 含引号的危险串：先消毒 ⇒ `'=1"`，再包裹 + 双写 ⇒ `"'=1"""` 形态
    expect(csvCell('=1"')).toBe(`"'=1"""`);
    // 对照：同样内容不带 = ⇒ 不消毒，只有包裹
    expect(csvCell('1"')).toBe(`"1"""`);
  });
});
