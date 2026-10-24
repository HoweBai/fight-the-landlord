import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { toPosixPath } from './helpers/repo-path';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const PKGS = ['api-gateway', 'user-service', 'room-service', 'game-service', 'robot-service', 'config-service', 'currency-service', 'payment-service', 'shared'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * A7（R143/R150）的机械闸：`packages/{pkg}/src/` 下**每一处出站调用**所在文件都必须带超时。
 *
 * ⚠️ R150（这条是**判据能否成立**的关键）：**不能**只按字面 `fetch(` 找。
 * `room-service/src/gateway/game.client.ts` 走的是**注入式**
 * `this.fetchImpl(\`${baseUrl}${path}\`, init)`（`fetchImpl?: typeof fetch`，
 * 单测靠注入替身）—— 它**不含** `fetch(` 字面量。计划初稿把「`fetchers` 必须包含
 * 那个文件」写成正对照 ⇒ **永远为假**，闸会在自己的正对照上红。最常见的错误
 * 「修法」是把正对照删掉 —— 那会把判别力一起删掉。
 *
 * 因此探测正则同时匹配裸 `fetch(` 与注入式 `…fetchImpl(`；`typeof fetch` 不带括号，
 * 不会被命中（已在真实源码上逐一验证：三个目标 MATCH；`match.service.ts`
 * 与 `bot.player.ts` 不 MATCH，无误伤）。
 *
 * ⚠️ **同族教训第二次发作（A7④ / R209 / 切片 11）**：本片把 `game.client.ts` 从
 * 「注入 `fetchImpl`」改成「注入 `HttpService` + `timeout:`」⇒ 它**必然**从
 * `fetchSources()` 里消失。**判据不能跟着实现形态走**（那是 R150 的同一课）：
 *  - 判据 A 仍然只管「**走 fetch** 的文件必须有超时」；
 *  - **新增判据 A′** 覆盖「不再走 fetch、但仍是出站」的文件（列表见 `INJECTED_OUTBOUND`）；
 *  - 正对照（判据 B）只列**仍走 fetch** 的文件 —— 把 `game.client.ts` 留在里面等于
 *    让闸钉住一个**已经不该存在**的形态。
 *
 * ⚠️ **同族教训第三次发作（N20/P4 Task 3 / R225）**：本片把 `room-service` 的全部
 * 服务间调用从 HTTP 换成 **TCP RPC**（`ClientProxy.send()` +
 * `timeout()`）⇒ `game.client.ts` **也**从 `INJECTED_OUTBOUND` 里消失。
 * 注意方向：`INJECTED_OUTBOUND` 是「**仍是 HTTP 出站**但不再走 fetch」的清单，
 * 换成 RPC 之后它**根本不在本闸的管辖范围**里了。
 *  ⇒ **判据 A′ 现在是空清单**（不是「忘了填」）：本仓已无「注入式 HTTP 客户端」形态。
 *  这里**保留**这条判据与空清单，理由是下一个 HTTP 出站文件加进来时
 *  `INJECTED_OUTBOUND` 会重新有内容，而 RPC 出站由
 *  `packages/room-service/test/no-internal-http.gate.test.ts` 的**正向**判据覆盖
 *  （「四个调用点都真的在用 `RPC_PATTERNS.*`」+「都不得再做内部 HTTP 出站」）。
 */
const callsFetch = (src: string): boolean => /(^|[^\w.])fetch\s*\(|fetchImpl\s*\(/m.test(src);

const fetchSources = (): string[] =>
  PKGS.flatMap((pkg) => walk(join(REPO, 'packages', pkg, 'src')))
    .filter((f) => callsFetch(readFileSync(f, 'utf-8')))
    .map((f) => toPosixPath(f.slice(REPO.length)))
    .sort();

/**
 * 超时标记的两种形态（**判据比形态更长寿**）：
 *  - 裸 `fetch` ⇒ `AbortSignal.timeout(...)` 或 `signal:`
 *  - 注入式 HTTP 客户端（`HttpService`）⇒ `timeout:` 配置项
 */
const hasTimeoutMarker = (src: string): boolean =>
  src.includes('AbortSignal') || src.includes('signal:') || /\btimeout\s*:/.test(src);

const hasTimeout = (rel: string): boolean => hasTimeoutMarker(readFileSync(join(REPO, rel), 'utf-8'));

/**
 * A7④（R209）之后**不再走 fetch**、但仍是对外 **HTTP** 调用的文件：
 * 传输换成注入的 `HttpService`，超时由 `timeout:` 承担。
 *
 * ⚠️ **N20/P4 Task 3 之后本清单为空**（R225 同族的**第三次**发作）：
 * `packages/room-service/src/gateway/game.client.ts` 已从 `HttpService` 换成
 * `ClientProxy.send()`，因此它不再是「HTTP 出站文件」——
 * 保留它在清单里会让闸钉住一个**已经不该存在**的形态（正是 R150 的教训）。
 * RPC 出站由 `packages/room-service/test/no-internal-http.gate.test.ts` 覆盖。
 *
 * ⚠️ **空清单不是「忘了填」**：判据 A′ 的循环体在空清单下恒真，
 * 但那**不是**空测 —— 同 describe 里的「判据 B′」是探针的判别力自证，
 * 且下面有一条**显式**判据钉住「这两个文件**不再**出现在 `fetchSources()` 里」。
 */
const INJECTED_OUTBOUND: readonly string[] = [];

/**
 * 已迁到 **TCP RPC** 的出站文件（N20/P4 Task 3）。
 *
 * ⚠️ 它们**不该**出现在 `fetchSources()`（无 `fetch`），也**不该**出现在
 * `INJECTED_OUTBOUND`（无 `HttpService`）—— 这是本闸对「一次全切」的负向判据。
 */
const MIGRATED_TO_RPC = [
  'packages/room-service/src/gateway/game.client.ts',
  'packages/room-service/src/gateway/robot.client.ts',
  'packages/room-service/src/match/match.service.ts',
  'packages/game-service/src/game/robot.client.ts',
] as const;

describe('A7：出站调用必须带超时（R143 / R150 / R209）', () => {
  it('判据 A（机械闸）：每一处 **fetch** 出站调用所在的源文件都出现超时标记', () => {
    const offenders = fetchSources().filter((rel) => !hasTimeout(rel));
    expect(offenders).toEqual([]);
  });

  it('判据 A′（A7④）：改用**注入式 HTTP 客户端**的出站文件同样必须带超时标记（`timeout:`）', () => {
    // ⚠️ N20/P4 Task 3：本清单已**空**（`game.client.ts` 换成了 `ClientProxy.send()`）
    // —— 空清单下这个循环恒真，因此**判别力必须来自别处**，见下面两条：
    //  ① 「判据 B′」是探针自身的正/负对照；
    //  ② 「判据 C」显式钉住这四个文件**不在** `fetchSources()` 里（一次全切的负向判据）。
    for (const rel of INJECTED_OUTBOUND) {
      expect(hasTimeout(rel), `${rel} 缺超时标记（注入式客户端的超时必须写成 timeout:）`).toBe(true);
    }
  });

  /**
   * 判据 C（N20/P4 Task 3 / R225）：四个「已迁到 TCP RPC」的出站文件
   * **不得**再出现在 `fetchSources()` 里，也**不得**再出现在 `INJECTED_OUTBOUND` 里。
   *
   * 这是「一次全切（R218）」在**源码层**的负向判据：只要有人把 HTTP 路径加回来，
   * 本判据或 `packages/room-service/test/no-internal-http.gate.test.ts` 就会红。
   */
  it('判据 C（N20/P4）：已迁到 TCP RPC 的四个出站文件都不再是 HTTP 出站', () => {
    const found = fetchSources();
    for (const rel of MIGRATED_TO_RPC) {
      expect(found, `${rel} 又走 fetch 了（一次全切被破坏）`).not.toContain(rel);
      expect(
        INJECTED_OUTBOUND as readonly string[],
        `${rel} 不该留在 INJECTED_OUTBOUND（它已不是 HTTP 出站）`,
      ).not.toContain(rel);
    }
  });

  it('判据 B（正对照）：**仍走 fetch** 的出站调用都被扫到，且各自都带超时标记', () => {
    const found = fetchSources();
    // 正对照：证明探针**看得见**这个模式（否则判据 A 的空数组可能只是探针瞎了 —— R115 教训）。
    // ⚠️ 这里**只列仍走 fetch 的文件**：`game.client.ts` 已由 A7④ 改为注入式 HttpService，
    // 它由判据 A′ 覆盖；把它列在这里会让闸钉住一个已不该存在的形态。
    for (const required of [
      'packages/api-gateway/src/gateway/proxy.gateway.ts',
      'packages/robot-service/src/robot/douzero.client.ts',
      // 支付片 T6（波 2 评审订正）：AlipayClient 含 `fetchImpl(` 字面量且带 `signal: AbortSignal.timeout`
      // ⇒ 列入正对照，「client.ts 被抓扫且带超时」此后由本闸机械断言（不再靠探针日志自证）。
      'packages/payment-service/src/channel/alipay/client.ts',
    ]) {
      expect(found, `${required} 没被探针扫到（正则失效？）`).toContain(required);
      expect(hasTimeout(required), `${required} 缺超时标记`).toBe(true);
    }
    expect(
      found,
      'game.client.ts 不该再被 callsFetch 命中（A7④ 之后它走注入式 HttpService）',
    ).not.toContain('packages/room-service/src/gateway/game.client.ts');
  });
  it('判据 B′（探针的判别力）：`fetchImpl(` 会被命中、`typeof fetch` 不会；超时标记的两种形态同样要有正/负对照', () => {
    expect(callsFetch('const r = this.fetchImpl(`${this.baseUrl}${path}`, init);')).toBe(true);
    expect(callsFetch('const r = await fetch(url, opts);')).toBe(true);
    expect(callsFetch('  fetchImpl?: typeof fetch;\n')).toBe(false);
    expect(callsFetch('const f: typeof fetch = globalThis.fetch;')).toBe(false);

    // hasTimeoutMarker 的判别力（R150/R193③：新判据必须自带正/负对照）
    expect(hasTimeoutMarker('signal: AbortSignal.timeout(5000),')).toBe(true);
    expect(hasTimeoutMarker('{ headers, timeout: 3000 }')).toBe(true);
    expect(hasTimeoutMarker('const r = await fetch(url);')).toBe(false);
    expect(hasTimeoutMarker('// timeout 未设置')).toBe(false);
  });
});
