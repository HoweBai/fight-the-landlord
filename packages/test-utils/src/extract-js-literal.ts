/**
 * 从 JS/TS 源码文本里提取 `const <name> = { … };` 的**纯字面量**并求值。
 *
 * 扫描器感知：单/双/反引号字符串（含转义）、`//` 行注释、`/* *\/` 块注释。
 * **不感知正则字面量**（`/…/`）——被测字面量里不应出现正则；写入新用例时注意。
 * 纪律：找不到 / 括号不平衡 ⇒ 抛错，绝不静默返回 undefined（门禁提取失败必须是响亮的红）。
 */
export function extractJsLiteral(source: string, constName: string): unknown {
  const marker = `const ${constName} =`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`未找到 ${marker}`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`${marker} 后没有对象字面量`);
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(open, i + 1);
        return new Function(`"use strict"; return (${literal});`)();
      }
    }
  }
  throw new Error(`${marker} 的对象字面量不平衡`);
}
