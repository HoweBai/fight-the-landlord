/**
 * 判据 4 的**源码机械闸**：八个服务 `main.ts` 里传给 `createRedactingLogger` 的
 * `service` 名必须**逐字等于**各自 `package.json` 的 `name` **去掉 npm scope 后的末段**（短名）。
 *
 * ⚠️ 名单曾长期停在 5 个（config-service 缺席 = 闸失明）；货币片 T1 钉正为 7 个
 * （config/currency 补入 —— 判据只增不减）；支付片 T2 补入 payment-service（第 8 个）。
 *
 * 为什么必须有这条闸：`service` 字段是**正则从源码里抓**出来的（各服务 `main.ts`
 * 里的单引号字面量）—— 没有闸的话，`package.json` 改名（或服务改名）后
 * 日志里的 `service` 会**静默漂移**，而**没有任何单测会变红**（单测不 import
 * `main.ts`：它在模块顶层 `bootstrap()`，不可作为测试目标）。
 * 这条闸把「改名没同步」变成可机械判的失败。
 *
 * ⚠️ 抓取用的正则 `service:\s*'([^']+)'` 依赖**单引号字面量**的写法
 * （双引号/模板串/变量都会让它抓不到 ⇒ 闸变空测）。写法纪律写在各服务 `main.ts`
 * 的注释里（与 `no-raw-console.test.ts` 同处 —— 都是日志面的源码闸）。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), '..', '..');
const SERVICES = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service'] as const;

const pkgName = (svc: string): string =>
  (JSON.parse(readFileSync(join(ROOT, 'packages', svc, 'package.json'), 'utf-8')) as { name: string }).name;

/** package.json 的 name 形如 `@fight-the-landlord/room-service`；日志里的 `service` 取**短名**
 *（R1102 的 `service` 字段口径 + 规格 §2 的记录示例 + 运维可读性；npm scope 是注册表产物、
 * 不是服务身份 —— 控制者 2026-09-23 裁决）。
 * ⚠️ 闸的意图仍是"防改名漂移"：服务改名 ⇒ 短名跟着变 ⇒ 这条照样红。 */
const shortName = (svc: string): string => pkgName(svc).split('/').pop()!;

describe('§A（判据 4）：每个服务的日志 service 名必须与 package.json 的 name 末段（短名）一致', () => {
  for (const svc of SERVICES) {
    it(`${svc}：main.ts 里传的 service 名 === package.json 的 name 去 scope 后的末段`, () => {
      const main = readFileSync(join(ROOT, 'packages', svc, 'src', 'main.ts'), 'utf-8');
      const m = /service:\s*'([^']+)'/.exec(main);
      expect(m, `${svc}/src/main.ts 里找不到 createRedactingLogger(..., { service: '…' })`).not.toBeNull();
      expect(m![1]).toBe(shortName(svc));
    });
  }
});
