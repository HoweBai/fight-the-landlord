// packages/protocol/src/fixtures/legacy-validator.gate.test.ts
//
// Task 0.1：冻结副本不得悄悄改成“新实现”。
// 只做源码扫描，不 import 被测文件——避免测试通过就证明副本仍是旧的。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// protocol 的 tsconfig 是 CommonJS，测试也在 `src/**` 里受 tsc 检查 ⇒ 不能用 `import.meta`。
// vitest 以包目录为 cwd（`pnpm -C packages/protocol exec vitest`）。
const source = readFileSync(resolve(process.cwd(), 'src/fixtures/legacy-validator.ts'), 'utf8');

describe('legacy-validator 冻结闸', () => {
  it('不得 import 新校验器', () => {
    expect(source).not.toMatch(/from\s+['"][^'"]*validate['"]/);
    expect(source).not.toMatch(/validateOutbound\s*\(/);
  });

  it('不得 import 新禁键表', () => {
    expect(source).not.toMatch(/FORBIDDEN_OUTBOUND_KEYS/);
  });

  it('必须保留旧禁键清单（证明这是旧口径）', () => {
    for (const key of ['actionLog', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed', 'deviceId']) {
      expect(source).toContain(`'${key}'`);
    }
  });
});
