import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
// 台账 N46：注释剥离器的**唯一真源**（收敛前本文件是 8 份私有副本之一）。
import { stripComments } from '@fight-the-landlord/test-utils';
import { toPosixPath } from './helpers/repo-path';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * 允许出现 `console.*` **调用**的文件（相对仓库根）：
 *  - 八个 Nest 服务的启动入口（sink 的落点；fail-closed 报错发生在 `overrideLogger` 之前）。
 *    ⚠️ config-service 是片⑦ 后补的服务、currency-service 是货币片 T1 新服务、
 *    payment-service 是支付片 T2 新服务——原名单漏了前者，货币片 T1 与支付片 T2 先后补入
 *    （判据只增不减）。
 *  - `shared` 的指标监听（监控片 R2）：**进程级 fail-loud 通道**——监听失败（如端口占用）
 *    即诊断即退出，输出是结构化单行 JSON（只有端口号与错误消息，**无任何请求数据**），
 *    与各 `main.ts` 的 fail-closed 同类；shared 里没有 Nest Logger 可用（结构类型、零依赖）。
 *  - 范围外登记：`alert-relay`（非 Nest、无脱敏器链路）**刻意不入本闸**——它的日志纪律
 *    由自身的哨兵用例钉（「URL/secret 永不进日志」，C8）；本闸的判据「绕过 Logger」对
 *    一个没有 Logger 的服务不成立。
 */
const ALLOWED = new Set([
  'packages/api-gateway/src/main.ts',
  'packages/user-service/src/main.ts',
  'packages/room-service/src/main.ts',
  'packages/game-service/src/main.ts',
  'packages/robot-service/src/main.ts',
  'packages/config-service/src/main.ts',
  'packages/currency-service/src/main.ts',
  'packages/payment-service/src/main.ts',
  'packages/shared/src/metrics/metrics-listener.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * 剥注释：**唯一真源** = `@fight-the-landlord/test-utils`（台账 N46 收敛）。**这一步是必需的**，不是宽容：
 *
 * 本闸的判据是「有没有一条日志**绕过** Logger」，而注释里的 `console.` 只是一个词
 * （例如 `shared/src/logging/redacting-logger.ts` 的用法示例、以及各服务里
 * 「不得用裸 `console.error`」的告诫本身）。按**原始文本**匹配会把它们一起打红，
 * 于是唯一能让人变绿的做法是**删掉告诫与文档** —— 那是把判别力换成注释洁净度，方向反了。
 *
 * 真源是「够用」档的守卫语义（URL 里的 `//` 不误剥；字符串里的非 `:` `//` 会误剥，
 * 已知边界见其 JSDoc）；最坏情况是**漏报一个字符串里紧跟非 `:` `//` 的 console 调用**，
 * 代价远小于上面那条。
 */
function callsConsole(src: string): boolean {
  return stripComments(src).includes('console.');
}

/**
 * S7（R142）的**机械闸**：所有服务日志必须走 Nest 的 `Logger`
 * （`main.ts` 已 `Logger.overrideLogger(createRedactingLogger(...))`）⇒ 必然经过脱敏器。
 *
 * 为什么必须有这条源码闸（而不是只靠单测）：把 `Logger.overrideLogger` 那一行删掉，
 * **没有任何单测会变红** —— 它只保证「有脱敏器可用」，不保证「有人在用」。
 * 这条闸把「有人绕过 Logger 直接写 console」变成可观测的失败。
 *
 * 界限明确写在 `ALLOWED` 里：`main.ts` **允许** console 调用（它是 sink 的落点，
 * 而且 fail-closed 的报错发生在 `overrideLogger` 之前）。
 */
describe('S7：`console.*` 只许出现在服务启动入口（R142 的机械闸）', () => {
  it('packages/*/src 下没有其他裸 console 调用（有 ⇒ 那条日志绕过了脱敏器）', () => {
    const scanned = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service', 'shared']
      .flatMap((pkg) => walk(join(REPO, 'packages', pkg, 'src')));

    const offenders = scanned
      .filter((f) => callsConsole(readFileSync(f, 'utf-8')))
      .map((f) => toPosixPath(f.slice(REPO.length)))
      .filter((rel) => !ALLOWED.has(rel));

    // 正对照：先证明扫描真的读到了文件（否则空数组会让本用例恒绿）。
    expect(scanned.length).toBeGreaterThan(20);
    // 正对照②：证明**去除注释后**仍然看得见真调用 —— 八个 `main.ts` 都必须命中。
    for (const rel of ALLOWED) {
      expect(callsConsole(readFileSync(join(REPO, rel), 'utf-8')), rel).toBe(true);
    }
    expect(offenders).toEqual([]);
  });
});
