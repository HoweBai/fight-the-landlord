/**
 * **C14b：真链序的机械判据（客户端接入片 T5）** —— `app.module.ts` 的注册序列文本断言。
 *
 * 为什么必须有这一条（规格 ⚠️ r1 重要 3）：单测手搭 `configure()`（各测试**自家**的
 * apply 链）测的是「探针链上的行为」，**测不到生产链的真序**——`app.module.ts` 的
 * `consumer.apply(…)` 是**唯一**的生产注册点，而「顺序即契约」在此前只有注释在守。
 * 本闸读**源码文本**、断言 `ClientGateMiddleware` 先于 `JwtMiddleware` 出现于同一
 * `apply` 链，并钉住注册形态（`'{/*splat}'` 收尾——Nest 11/Express 5 的覆盖形态，
 * 见 `app.module.ts` 的迁移注记；旧写法 `'*'` 会静默丢掉裸 `/api` 的中间件覆盖）。
 *
 * ⛔ 不 import AppModule（会把 Nest 装配拖进单测）；本闸只读文本 + 纯字符串解析。
 * 行为面（闸真的先跑——10008 ≠ 10002/10005）在 `client-gate.middleware.test.ts` 的
 * 真链序探针组；真栈面在 T8（slice-26）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@fight-the-landlord/test-utils';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const APP_MODULE = join(REPO, 'packages', 'api-gateway', 'src', 'app.module.ts');

/** 生产链的**预期序**（逐字 = 规格 §5.1 + app.module.ts「顺序即契约」注释）。 */
const EXPECTED_ORDER = ['ClientGateMiddleware', 'JwtMiddleware', 'AdminAuthMiddleware', 'HttpRateLimitMiddleware'];

export interface ApplyChain {
  /** `consumer.apply(...)` 里的中间件类名（按出现序）。 */
  middlewares: string[];
  /** `.forRoutes(...)` 的路由形态（含引号内逐字）。 */
  route: string;
}

/**
 * 从模块源码文本里解析**唯一的** `consumer.apply(...).forRoutes('…');` 语句。
 *
 * 判别力约定（⛔ 不要顺手放宽）：
 *  - `apply` 里**只解析顶层逗号**：中间件类名形态（裸标识符）下与 `split(',')` 等价，
 *    但一旦有人写 `apply(...someList)` 展开，顶层逗号切分不会把 `...someList` 错切成
 *    多枚名字而**静默造绿**——解析不出四个预期名时本闸照样红。
 *  - 找不到语句 / 找到多条 ⇒ 抛错（响亮失败，不静默变绿）。
 */
export function parseApplyChain(source: string): ApplyChain {
  const code = stripComments(source);
  const statements = code.match(/consumer\.apply\([\s\S]*?;\s*/g) ?? [];
  if (statements.length !== 1) {
    throw new Error(`期望恰好一条 consumer.apply(...) 语句，实际 ${statements.length} 条`);
  }
  const statement = statements[0]!;
  const m = /consumer\.apply\(([^)]*)\)\s*\.forRoutes\(\s*'([^']*)'\s*\)/.exec(statement);
  if (!m) throw new Error('consumer.apply(...) 的形态解析失败（apply/forRoutes 不匹配）');
  const middlewares = m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { middlewares, route: m[2]! };
}

/** 不变式本体：返回违规定位（空数组 = 通过）。 */
export function orderViolations(chain: ApplyChain): string[] {
  const violations: string[] = [];
  const positions = EXPECTED_ORDER.map((name) => ({ name, at: chain.middlewares.indexOf(name) }));

  for (const { name, at } of positions) {
    if (at === -1) violations.push(`链里缺 ${name}`);
  }
  if (violations.length > 0) return violations;

  for (let i = 1; i < positions.length; i += 1) {
    const prev = positions[i - 1]!;
    const curr = positions[i]!;
    if (prev.at >= curr.at) {
      violations.push(`${prev.name} 必须在 ${curr.name} 之前（实际 ${prev.at} >= ${curr.at}）`);
    }
  }
  if (chain.middlewares[0] !== EXPECTED_ORDER[0]) {
    violations.push(`第 0 步必须最先（实际首枚 = ${chain.middlewares[0] ?? '(空)'}）`);
  }
  if (chain.route !== '{/*splat}') {
    violations.push(`forRoutes 形态必须是 '{/*splat}'（实际 '${chain.route}'）`);
  }
  return violations;
}

describe('C14b 真链序机械闸：app.module.ts 的中间件注册序列', () => {
  it('apply 链 = [ClientGateMiddleware → JwtMiddleware → AdminAuthMiddleware → HttpRateLimitMiddleware] 且以 {/*splat} 收尾（逐字）', () => {
    const chain = parseApplyChain(readFileSync(APP_MODULE, 'utf-8'));

    // ① 逐字序（含第 0 步最先）与注册形态 —— 违规输出定位串，红时直接指认漂移处。
    expect(orderViolations(chain)).toEqual([]);
    // ② 链上无多余成员（本断言不是装饰：多插一枚中间件意味着「顺序即契约」注释未同步，
    //    消费方（限流桶/身份头纪律）需要重新评估）。
    expect(chain.middlewares).toEqual(EXPECTED_ORDER);
  });

  it('探针判别力自证：换序 / 旧形态 / 缺员 / 多链**都必须**被判出来（防恒绿）', () => {
    const good = `consumer.apply(ClientGateMiddleware, JwtMiddleware, AdminAuthMiddleware, HttpRateLimitMiddleware).forRoutes('{/*splat}');`;

    // ① 正对照：好形态零违规（否则下面的判红可能只是「闸恒红」）。
    expect(orderViolations(parseApplyChain(good))).toEqual([]);

    // ② 换序（本片要防的原始缺陷形态：ClientGate 插到 Jwt 之后 ⇒ 闸永不先跑）
    const swapped = good.replace(
      'ClientGateMiddleware, JwtMiddleware',
      'JwtMiddleware, ClientGateMiddleware',
    );
    expect(orderViolations(parseApplyChain(swapped)).length).toBeGreaterThan(0);

    // ③ 缺员（有人把 ClientGate 从链上摘掉）
    const missing = good.replace('ClientGateMiddleware, ', '');
    expect(orderViolations(parseApplyChain(missing))).toEqual(
      expect.arrayContaining([expect.stringContaining('缺 ClientGateMiddleware')]),
    );

    // ④ 旧注册形态（Nest 10 的 `'*'` —— Express 5 下静默丢覆盖，app.module.ts 的迁移注记）
    const oldForm = good.replace("'{/*splat}'", "'*'");
    expect(orderViolations(parseApplyChain(oldForm))).toEqual(
      expect.arrayContaining([expect.stringContaining("'{/*splat}'")]),
    );

    // ⑤ 解析器纪律：多条 apply 链 / 找不到链 ⇒ 响亮抛错（不静默变绿）
    expect(() => parseApplyChain(`${good}\n${good}`)).toThrow();
    expect(() => parseApplyChain('// consumer.apply 只在注释里')).toThrow();
    // 注释里的写法不作数（stripComments：本仓注释习惯就常引用真实语句）——
    // 剥注释后只剩真实的单成员链（若注释被计入 ⇒ 会因「两条链」而抛）。
    const withCommentedChain = `/* ${good} */\nconsumer.apply(JwtMiddleware).forRoutes('{/*splat}');`;
    expect(parseApplyChain(withCommentedChain).middlewares).toEqual(['JwtMiddleware']);
  });
});
