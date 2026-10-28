import { describe, expect, it } from 'vitest';
import { extractJsLiteral } from '../src/extract-js-literal';

describe('extractJsLiteral', () => {
  it('提取嵌套字面量，忽略字符串与注释里的括号/引号', () => {
    const src = `
const OTHER = { a: 1 };
const TARGET = {
  // it's a 'line' comment with { braces } and a quote
  /* block 'comment' with } and "quotes" */
  a: { b: 'x}y', c: "q{z", d: \`t{w\` },
  e: true,
};
const AFTER = 1;
`;
    expect(extractJsLiteral(src, 'TARGET')).toEqual({
      a: { b: 'x}y', c: 'q{z', d: 't{w' },
      e: true,
    });
  });

  it('找不到 const ⇒ 抛错（绝不静默）', () => {
    expect(() => extractJsLiteral('const A = {};', 'MISSING')).toThrow(/未找到/);
  });

  it('括号不平衡 ⇒ 抛错', () => {
    expect(() => extractJsLiteral('const A = { a: 1;', 'A')).toThrow(/不平衡/);
  });

  it('处理转义引号', () => {
    const src = String.raw`const A = { s: 'it\'s ok' };`;
    expect(extractJsLiteral(src, 'A')).toEqual({ s: "it's ok" });
  });
});
