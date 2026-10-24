# 片②「机器人 AI 全量化」实施计划（v3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让机器人的出牌决策 100% 走 DouZero（三档难度 = 三个模型、比例可配），把 DouZero 服务的并发缺陷修掉、把模型装配改成可缺可报，并让「匹配不到玩家」这条提示真正到达玩家。

**Architecture:** 难度在 robot-service 的 `acquire` 新绑定分支上抽（抽到的档位映射成模型名随请求下发）；DouZero 侧用 `ThreadingHTTPServer` + backlog=128 并同时加载三档 × 三位置共 9 个 ONNX；room-service 在「需要机器人」的那一支加一道可用性门禁（开关关掉时，DouZero 不可用 ⇒ 第 30s 直接告诉玩家无匹配）。

**Tech Stack:** TypeScript / NestJS（robot / room / game / protocol）· uni-app + Vue3（client）· Python 3.14 + onnxruntime（douzero）· vitest · Nest TCP RPC · docker compose。

## 0. 修订对账（v2 相对 v1）

> 第一轮两路审查（可执行性 · 完整性与一致性）的总判都是**「不能开始实现」**。根因：v1 的测试片段里**编造了一批不存在的夹具**（`makeService`/`clock.advance`/`drainMatchEvents`/`toResult`/`sink.lines`/`askDouZeroRaw`/`now`/`baseReq`/`jsonResponse`/`readAll`/`source`/`sectionOf`…）—— 这正是「描述了代码、但没去核真实代码」的形态。

| # | v1 的问题 | 级别 | v2 的处置 |
|---|---|---|---|
| p1 | 🔴 **T3 的实现与自己带来的测试互斥**：`idle ?? this.createBot(this.roll())` 短路 ⇒ 复用池里实例时**不重抽**，而 J5 那条测试要求它重抽 ⇒ 必红，且最省事的「修法」是改弱测试 ⇒ **静默丢掉 D2** | P0 | 改成「先 `const roll = this.roll()`，再 `idle ? {...idle, …roll} : this.createBot(roll)`」；测试用该文件真实的 `now`/`createFakeRedis`/`asRedis` |
| p2 | 🔴 **T4B 的 fetch 注不进去**（构造只有 `clock`，`probe` 打全局 fetch）+ **`getRobotConfig()` 记忆化把六态锁死** | P0 | 构造改为 `(fetchImpl = fetch, clock = Date.now)` 双双可注入；`config.ts` 加 `resetRobotConfigForTests()`；六条用例全部改成**可执行**的（含 `jsonResponse` 助手与超时态） |
| p3 | 🔴 **T6 五条新测试全按不存在的夹具写**（真形态：`beforeEach` 五参构造 + `rpc.on(pattern, () => of({ok,data}))` + `service.setClock` + 读 `redis.publish.mock.calls`）；J27 是**空 `it()`**（恒绿） | P0 | 五条全部按真实夹具重写；J27 给出真用例体；`availability()` 片段改 `lastValueFrom`/`this.proxy`；`failMatch` 保持 `MatchMode` |
| p4 | 🔴 **T9 的签名与 `run.ts` 契约相反**（应为 `(): Promise<Checks>` + 片内 `new Checks()`）；夹具引用「见 Task 5 Step 5」（子 agent **看不到**别的任务） | P0 | 签名照 slice-12；`FIXTURE`/`askRaw` 写进片内；J32 补「无网 ⇒ `checks.skip`」（**不许把没验写成 ok**）；补 slice-11 idem 的 `skillLevel` 断言 |
| p5 | 🔴 **T10 的 J18 在时点上必红**（design.md 要到 T11 才改）+ protocol **没有 `test/` 目录** + 四个助手不存在 + 扫源码会把**注释里**的 `@MessagePattern` 算进去 | P1 | J18 改为「T10 只写闸记红 → T11 → 复核转绿」；闸文件挪到 `packages/protocol/src/`；写明「助手自造 + 先剥注释」 |
| p6 | 🔴 **T12 Step 2 的 `run.js full` 不是合法用例**（只认 `CASES` 的键）；**缺规格 §6 的部署与回滚**（本片唯一 CI 补不回来的环节）；探针命令缺 Windows 三坑参数；缺「如实登记未验项」 | P1 | Step 2 改 `--list` 循环；新增 Step 5（部署/回滚，含「回滚只能拉旧 tag」的例外）与 Step 6（如实登记）；Step 3 补 `--no-server`/`CHROME_BIN`/`--cdp-port` |
| p7 | 轻/中：T1 漏 `robot.test.ts:58`（tsc 红）且 `git add` 也漏；T2 的 `Logger` import 与 `main.ts:4` 重复（TS2300）；T4 的 `baseReq()`（真名 `request()`）与 mock 形参（TS2493）与内联 ctx 的 `model`；T5 缺 `time`/`shutil`/`ThreadingHTTPServer` 三处 import 且 `docker exec -w /app` 在 Git Bash 下**实测必失败**；T7 的 `sink.lines`（真名 `records`）与不存在的 `accepted`；T8 的 `clearNotice` 落错文件 + 既有的重复订阅 + `serverMessage` 少第三参；T11 与 T10 成环 | P1/P2 | 逐条改：见各任务正文；T5 的容器命令全部加 `MSYS_NO_PATHCONV=1` |
| p8 | 🔴 **T8 会改变 5 个既有 TOAST 码的玩家可见文案**（10001/10006/10007/13001/13006 从调试串换成文案表的句子），而规格 §9 S2 只写了「只加 MATCH_TIMEOUT 一行」⇒ R4 要求的「列全」没做到、且无判据 | P1 | T8 开头**列全那 5 个码与改前/改后**，J15 的断言扩成「推送 10007 ⇒ 文本 = `服务暂时不可用，请稍后重试`」（把这条行为变更钉住） |

### v3 相对 v2（第三轮终核）

> 终核总判：**可以开始实现**，但 T6 要先补三处。p1–p8 里 6 行逐字落地、p2/p7 各一处只算隐含修。

| # | v2 的问题 | 级别 | v3 的处置 |
|---|---|---|---|
| q1 | 🔴 **T6 J20 用了 `addToQueue('u2','random',30)`** —— `30` 不是档位表里的档（15/80/480/1200）⇒ setup 就被 `BAD_PARAM` 拒 ⇒ **红因错** | P1 | 改 `80` |
| q2 | 🔴 **T6 J27 的构造出不来「两轮重叠且都判 failMatch」**：`NEVER` + 真实的 `timeout(2000)` ⇒ 两轮最终都拿 fail-open `true` ⇒ failMatch 从不触发 ⇒ `toHaveLength(1)` 必红 | P1 | 改成**自己控制的 `Subject`**：第一轮的问询挂在它上面、第二轮立即答 false ⇒ 先由第二轮判失败，再放行第一轮 ⇒ 幂等过滤必须挡住第二条 |
| q3 | 🔴 **T6 的实现片段把 `const round` 写在 `for` 里** ⇒ 每桶各一个 ⇒ **与自己的 J20 相反**（又是「实现与自己的测试互斥、最省事的修法是改弱测试」那一族） | P1 | 提到 `for` **之上** |
| q4 | T4 只列了一处内联 ctx：`douzero.client.test.ts` 的 `:43-52`（第一条用例）也少 `model` ⇒ lint 红 | P2 | 两处一起列 |
| q5 | T8 的 RED 命令 `test match-timeout` 指向已不存在的文件名 ⇒ **永远红**（跑 `No test files found`） | P2 | 改 `test auth-ui-wiring`（过滤的是文件路径） |
| q6 | **J7 与 J23 在 T6 正文里没有落点**（对照表把它们记在 T6）；T7 的 Files 行仍写 `:627-631`，与它自己的正文相反 | P2 | J7 补一条用例；J23 的 60s 路径补一行断言（改既有用例）；T7 的 Files 行订正 |
| q7 | T2 的 import 片段与 `main.ts:4` 重复（TS2300）—— p7 声称已修，实际只算隐含修 | P2 | 订正为「只加 `import { getRobotConfig } …`」 |

---

## Global Constraints

- **提交纪律**：每次改动一个 commit，结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`（CLAUDE.md）。
- **测试纪律**：每个改动都要写/更新测试，交付前该改动相关的测试与验证必须全过（CLAUDE.md）。
- **分支**：`feat/ai-rollout`（已存在）。
- **判据只增不减**；`tools/conformance/baselines.json` 只由 **CI 运行**回填，**不得用本机读数**。
- **`RobotDecideRequest`/`PlayerView` 的可见信息边界（§9.5）不动**；`FORBIDDEN_OUTBOUND_KEYS` 不动。
- **涉 douzero 的性能类断言一律容器内 vantage**（宿主视角看不出 backlog 缺陷，实测见设计层 §2.3）。
- **默认值（逐字）**：`ROBOT_RULE_FALLBACK=true` · `ROBOT_SKILL_DISTRIBUTION=beginner=0.15,intermediate=0.35,advanced=0.5` · 模型名 `sl`/`douzero_WP`/`douzero_ADP` · 位置名 `landlord`/`landlord_down`/`landlord_up` · RPC 超时 `2s` · 探测超时 `1s` · 缓存 `5s` · 下载单文件 `30s`/总预算 `60s`。
- **参考文档**：设计层 `docs/superpowers/specs/2026-10-01-ai-rollout-design.md`（v10）· 规格层 `…-spec.md`（v4）。**遇到与真实代码冲突 ⇒ 停下报协调者，不自行改设计**。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `packages/protocol/src/robot.ts` | 服务间机器人契约（新增 availability 两型；删 `errorRate`） |
| `packages/protocol/src/rpc.ts` | `RPC_PATTERNS`（加第 9 个） |
| `packages/robot-service/src/robot/config.ts` | **新**：两个 env 的解析（惰性 + 记忆化） |
| `packages/robot-service/src/robot/models.ts` | **新**：`skillLevel → 模型名` 映射 |
| `packages/robot-service/src/robot/douzero.health.ts` | **新**：`/health` 探测 + 缓存 ⇒ `{canProvide, reason?}` |
| `packages/robot-service/src/robot/douzero.client.ts` | 出站 HTTP（加必填 `model`；非 200 先读 body） |
| `packages/robot-service/src/robot/bot.player.ts` | 决策链（三分支全走 DouZero） |
| `packages/robot-service/src/robot/robot.pool.ts` | 池与难度抽取（`createBot(roll)` + `acquire` 抽） |
| `packages/robot-service/src/robot/robot.service.ts` | RPC 转发 + 决策日志（加 `model=`） |
| `packages/room-service/src/match/match.service.ts` | 门禁 + `failMatch` 幂等 + 中文文案 |
| `packages/room-service/src/gateway/robot.client.ts` | `availability()`（2s、不重试） |
| `packages/game-service/src/game/game.service.ts` | 第三条决策路径的两条日志 |
| `apps/client/src/net/action-copy.ts` | 12007 文案 + `actionCopyFor` |
| `apps/client/src/net/session.ts` | notice 的 code/source + 推送路径消费 |
| `apps/client/src/pages/game/game.vue` | 重新匹配时清匹配失败 notice |
| `douzero/server.py` | 9 模型 / `model` 字段 / `/health` 形状 / 线程 / 下载 / 400-503 |
| `douzero/Dockerfile` | runtime 段 `test -f` 九路径 |
| `douzero/models/<model>/<position>.onnx` | 模型入库（布局迁移 + 新增 6 个） |

## 执行顺序与依赖

```
T1（protocol 契约）
 ├─→ T2（配置解析）─→ T3（难度抽取）─→ T4（决策全 DouZero）─→ T4B（可用性探测/RPC）
 ├─→ T5（douzero 服务）                        │
 └─→ T6（room 门禁）←───────────────────────────┘（要 T1 的 pattern/类型）
T7（game 日志）· T8（客户端）—— 与上面无强依赖，可并行
T9（conformance）需 T2/T4B/T5/T6 全部落地
T10（机械闸）需 T4/T4B/T5 落地（它扫源码与 Dockerfile）
T11（文档）需 T5（模型布局定稿）与 T4B（env 名定稿）
T12（全量验收）最后
```

**并行建议**：T7、T8 可与 T2–T6 任意点并行；T5（douzero）与 T2–T4（robot-service）互不冲突，可并行派两个子 agent。

## 判据 → 任务对照（防漏）

| 判据 | 落点 |
|---|---|
| J1 J2 | T4 |
| J3 J4 | T2 |
| J5 J5b J5c J24 | T3 |
| J6 J7 J8 J9 J20 J23 J27 J28 | T6（J28 另在 T10 加源码级断言） |
| J10 J22 | T4B（J22 的**真栈那半**在 T9） |
| J11 J12 J13 J26 J32 J33 | T9 |
| J14 J15 J16 | T8 |
| J17 | 既有 slice-11 第 4 组（T12 复跑） |
| J18 J19 J21 J29 J30 J31 | T10 |
| J25 | T7 |

---

## Task 1: protocol 契约（availability 两型 + 第 9 个 pattern + 删 errorRate）

**Files:**
- Modify: `packages/protocol/src/rpc.ts`
- Modify: `packages/protocol/src/robot.ts`
- Test: `packages/protocol/src/messages.test.ts`、`packages/protocol/src/robot.test.ts`

**Interfaces:**
- Produces: `RPC_PATTERNS.robotAvailability = 'robot.availability'`；`RobotAvailabilityRequest { meta?: RpcMeta }`；`RobotAvailabilityResponse { canProvide: boolean; reason?: 'douzero-unreachable' | 'models-incomplete' }`；`BotPersonality` **只剩** `thinkingSpeed`。

- [ ] **Step 1: 写失败测试** —— `packages/protocol/src/messages.test.ts` 里把「八个 pattern 名逐字不变」改成九键：

```ts
it('§4.2 的九个 pattern 名逐字不变（片② 加了第九条 `robot.availability`）', () => {
  expect(RPC_PATTERNS).toEqual({
    gameStart: 'game.start',
    gameView: 'game.view',
    gameSnapshot: 'game.snapshot',
    gameAction: 'game.action',
    robotAcquire: 'robot.acquire',
    robotRelease: 'robot.release',
    robotDecide: 'robot.decide',
    baseScoreLevels: 'config.baseScoreLevels',
    robotAvailability: 'robot.availability',
  });
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/protocol test` ⇒ FAIL（`robotAvailability` 不存在）

- [ ] **Step 3: 实现** —— `rpc.ts` 的 `RPC_PATTERNS` 加末条：

```ts
  /** §4.2：机器人可用性门禁（room → robot，片②）。 */
  robotAvailability: 'robot.availability',
```

`robot.ts` 加两型（放在 `RobotAcquireRequest` 附近）：

```ts
/** `robot.availability`（room → robot，片② D5）：**不带业务字段** —— 答案只取决于开关 + DouZero 现状。 */
export interface RobotAvailabilityRequest {
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**）。 */
  meta?: RpcMeta;
}

/**
 * `robot.availability` 的响应（片② D5）。
 * `canProvide=false` 的两个原因：DouZero 不可达 / 三档模型不齐备。
 * ⚠️ 调用方（room-service）**只认 `false`**：RPC 失败、超时、字段缺失一律按「能给」处理（fail-open）。
 */
export interface RobotAvailabilityResponse {
  canProvide: boolean;
  reason?: 'douzero-unreachable' | 'models-incomplete';
}
```

删 `BotPersonality.errorRate`（`:24-25` 两行）并把接口注释改成「难度分级靠 skillLevel→模型（§9.3），思考延迟靠 `thinkingSpeed`」；🔴 **同时改夹具** `packages/protocol/src/robot.test.ts:58`（`personality: { thinkingSpeed: 400, errorRate: 0 }` ⇒ 去掉 `errorRate`）—— 不改就是 **tsc 红**（对象字面量多属性）。`RobotDecideResponse.source` 的注释（`:120-121`）改为：

```ts
 * `source` 如实标注**决策来源**（不是难度档位）：`'douzero'`（调 DouZero 成功）
 * 或 `'rule'`（DouZero 抛错/超时/给出不在手里的牌之后的**降级**，§9.3）。
```

- [ ] **Step 4: 跑测试确认绿** —— 同上命令 ⇒ PASS；再 `pnpm --filter @fight-the-landlord/protocol run lint`（`tsc --noEmit`）⇒ 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/rpc.ts packages/protocol/src/robot.ts packages/protocol/src/messages.test.ts packages/protocol/src/robot.test.ts
git commit -m "feat(protocol): 加 robot.availability 契约与第 9 个 pattern；删 BotPersonality.errorRate"
```

---

## Task 2: robot-service 配置解析（两个 env）

**Files:**
- Create: `packages/robot-service/src/robot/config.ts`
- Create: `packages/robot-service/test/robot.config.test.ts`
- Modify: `packages/robot-service/src/main.ts`
- Modify: `docker-compose.yml`（robot-service 段）

**Interfaces:**
- Produces: `parseSkillDistribution(raw: string | undefined): ReadonlyArray<readonly [SkillLevel, number]>` · `parseRuleFallback(raw: string | undefined): boolean` · `getRobotConfig(): { skillDistribution: ReadonlyArray<readonly [SkillLevel, number]>; ruleFallback: boolean }`（**惰性 + 记忆化**）
- Consumes: Task 1 的 `SkillLevel`

- [ ] **Step 1: 写失败测试** —— `packages/robot-service/test/robot.config.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { parseSkillDistribution, parseRuleFallback } from '../src/robot/config';

describe('parseSkillDistribution（片② D3）', () => {
  it('未设 ⇒ 用户裁决 10 的默认比例', () => {
    expect(parseSkillDistribution(undefined)).toEqual([
      ['beginner', 0.15], ['intermediate', 0.35], ['advanced', 0.5],
    ]);
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
  it('重复一档 ⇒ 抛', () => {
    expect(() => parseSkillDistribution('beginner=0.5,beginner=0.5,advanced=1')).toThrow();
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

describe('parseRuleFallback（片② D4）', () => {
  it('未设 ⇒ true（规则兜底是默认世界）', () => expect(parseRuleFallback(undefined)).toBe(true));
  it("'true'/'false' 各归各位", () => {
    expect(parseRuleFallback('true')).toBe(true);
    expect(parseRuleFallback('false')).toBe(false);
  });
  it("其它值（含 'FALSE'/'0'/空串）⇒ 抛", () => {
    for (const bad of ['FALSE', '0', '', 'yes']) expect(() => parseRuleFallback(bad)).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/robot-service test robot.config` ⇒ FAIL（模块不存在）

- [ ] **Step 3: 实现** —— `src/robot/config.ts`（**只导出函数**；模块求值不读 env、不抛）：

```ts
import type { SkillLevel } from '@fight-the-landlord/protocol';

const LEVELS: readonly SkillLevel[] = ['beginner', 'intermediate', 'advanced'];

/** 片② D3 的默认比例（用户裁决 10）。 */
const DEFAULT_SKILL_DISTRIBUTION = 'beginner=0.15,intermediate=0.35,advanced=0.5';

export function parseSkillDistribution(
  raw: string | undefined,
): ReadonlyArray<readonly [SkillLevel, number]> {
  const text = raw ?? DEFAULT_SKILL_DISTRIBUTION;
  if (text.trim() === '') throw new Error('ROBOT_SKILL_DISTRIBUTION is empty');
  const out = new Map<SkillLevel, number>();
  for (const part of text.split(',')) {
    const [name, weightText] = part.split('=');
    const level = LEVELS.find((l) => l === name?.trim());
    if (!level) throw new Error(`ROBOT_SKILL_DISTRIBUTION: unknown level "${name ?? part}"`);
    if (out.has(level)) throw new Error(`ROBOT_SKILL_DISTRIBUTION: duplicate level "${level}"`);
    const weight = Number(weightText);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`ROBOT_SKILL_DISTRIBUTION: bad weight for "${level}"`);
    }
    out.set(level, weight);
  }
  for (const level of LEVELS) {
    if (!out.has(level)) throw new Error(`ROBOT_SKILL_DISTRIBUTION: missing level "${level}"`);
  }
  const total = [...out.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('ROBOT_SKILL_DISTRIBUTION: all weights are zero');
  return LEVELS.map((l) => [l, out.get(l)! / total] as const);
}

export function parseRuleFallback(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`ROBOT_RULE_FALLBACK must be "true" or "false", got "${raw}"`);
}

interface RobotConfig {
  skillDistribution: ReadonlyArray<readonly [SkillLevel, number]>;
  ruleFallback: boolean;
}

let cached: RobotConfig | undefined;

/** 惰性 + 记忆化：模块求值期**不**读 env（否则非法值会在 import 期抛裸栈，早于 main 的干净退出）。 */
export function getRobotConfig(): RobotConfig {
  cached ??= {
    skillDistribution: parseSkillDistribution(process.env.ROBOT_SKILL_DISTRIBUTION),
    ruleFallback: parseRuleFallback(process.env.ROBOT_RULE_FALLBACK),
  };
  return cached;
}

/** **仅测试用**：清掉记忆化（否则同文件里改 env 之后再取，拿到的还是第一次的缓存）。 */
export function resetRobotConfigForTests(): void {
  cached = undefined;
}
```

`src/main.ts`：加 import（⚠️ `main.ts:4` **已经**有 `import { Logger, ValidationPipe } from '@nestjs/common'` ⇒ **不要**重复写一行 `import { Logger } …`，那是 TS2300）与**建容器之前**的预检（放在 `Logger.overrideLogger(...)` 之后、`NestFactory.create` 之前）：

```ts
import { getRobotConfig } from './robot/config';
// …
  try {
    getRobotConfig();
  } catch (error) {
    new Logger('Bootstrap').error(`Invalid robot config: ${(error as Error).message}`);
    process.exit(1);
  }
```

`docker-compose.yml` 的 robot-service `environment:` 段（现有 4 条之后）加：

```yaml
      # 片② D3/D4：难度比例与规则引擎开关（默认值 = 用户裁决 10 与「规则兜底是默认世界」）
      - ROBOT_SKILL_DISTRIBUTION=${ROBOT_SKILL_DISTRIBUTION:-beginner=0.15,intermediate=0.35,advanced=0.5}
      - ROBOT_RULE_FALLBACK=${ROBOT_RULE_FALLBACK:-true}
```

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/robot-service test robot.config` ⇒ PASS；`pnpm --filter @fight-the-landlord/robot-service run lint` ⇒ 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/robot-service/src/robot/config.ts packages/robot-service/test/robot.config.test.ts packages/robot-service/src/main.ts docker-compose.yml
git commit -m "feat(robot-service): 两个 env 的解析（惰性记忆化 + fail-closed 启动预检）"
```

---

## Task 3: 难度抽取搬到 acquire 的新绑定分支（+ 删 errorRate）

**Files:**
- Modify: `packages/robot-service/src/robot/robot.pool.ts`
- Modify: `packages/robot-service/test/robot.pool.test.ts`（:67 / :384-398 必翻）
- Modify: 四处 room-service fixture（`match.service.test.ts:212`、`robot.client.test.ts:127`、`rooms.autostart.test.ts:222`、`rooms.start.test.ts:37`）

**Interfaces:**
- Consumes: Task 2 的 `getRobotConfig()`；Task 1 的 `BotPersonality`（只剩 `thinkingSpeed`）
- Produces: `createBot(roll: { skillLevel: SkillLevel; thinkingSpeed: number }): BotInstance`（**私有**签名变更）；`acquire` 的**新绑定**分支每座位消费 **2** 个随机数

- [ ] **Step 1: 写失败测试** —— 在 `robot.pool.test.ts` 的 `describe` 内加两条（**用该文件已有的 `redis`/`pool`/`now` 夹具**，`beforeEach` 已建好 `pool = new RobotPool(asRedis(redis), () => now)`）：

```ts
it('片② D2/J5c：每新绑定恰好抽 2 个随机数，幂等命中 0 个', async () => {
  let draws = 0;
  pool.random = () => { draws += 1; return 0.1; };

  await pool.acquire('R1', [1]);
  expect(draws).toBe(2);          // skillLevel + thinkingSpeed
  await pool.acquire('R1', [1]);  // 幂等命中 ⇒ 不再抽
  expect(draws).toBe(2);
});

it('片② D2/J5：release 后再 acquire ⇒ 难度重抽并写回（不是实例固定）', async () => {
  const seq = [0.1, 0.1, 0.9, 0.9];   // 前两次 ⇒ beginner（0.1 < 0.15）；后两次 ⇒ advanced（0.9 ≥ 0.5）
  pool.random = () => seq.shift()!;

  const [a] = await pool.acquire('R1', [1]);
  await pool.release([a.botId]);
  const [b] = await pool.acquire('R2', [1]);

  expect(a.skillLevel).toBe('beginner');
  expect(b.skillLevel).toBe('advanced');
  expect((await pool.get(b.botId))?.skillLevel).toBe('advanced');   // 写回要落盘
});
```

并把既有「难度分布与思考延迟按 §9.3 三档取值」那条（`:384-398`）改成新默认（`random=0.6` 现在落 **advanced**：累计 0.15/0.5/1.0），删掉 `:388/:395` 的 `errorRate` 断言；`robot.pool.test.ts:67` 的 `expect(bot.personality.errorRate)` 整行删。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/robot-service test robot.pool` ⇒ FAIL（Δ=4 / `errorRate` 类型报错）

- [ ] **Step 3: 实现** —— `robot.pool.ts`：

```ts
// 删掉 ERROR_RATE 常量（:47-52），并 import 配置：
import { getRobotConfig } from './config';

/** 新建机器人：值**必须**由调用方抽好（`acquire` 的新绑定分支负责抽）。 */
private createBot(roll: { skillLevel: SkillLevel; thinkingSpeed: number }): BotInstance {
  const hex = uuidv4().replace(/-/g, '');
  return {
    botId: `bot-${hex.substring(0, 8)}`,
    displayId: `p_${hex.substring(8, 16)}`,
    skillLevel: roll.skillLevel,
    personality: { thinkingSpeed: roll.thinkingSpeed },
    roomCode: null,
    seat: null,
    gamesPlayed: 0,
  };
}

/** 抽一次：skillLevel（可配比例）+ 按该档区间的 thinkingSpeed。**只在新建绑定时调用**。 */
private roll(): { skillLevel: SkillLevel; thinkingSpeed: number } {
  const skillLevel = this.pickSkillLevel();
  const [min, max] = THINKING_SPEED[skillLevel];
  return { skillLevel, thinkingSpeed: Math.floor(this.random() * (max - min)) + min };
}
```

`acquire` 的**新建绑定**分支（`findBound` 命中那条 `continue` 在它**之前**，不受影响）：

```ts
        const idle = await this.takeIdle();
        // 🔴 抽要在「复用 or 新建」之前 —— 池里捞回来的实例带着**上一局**的难度（D2）
        const roll = this.roll();
        const fresh: BotInstance = idle
          ? { ...idle, skillLevel: roll.skillLevel, personality: { thinkingSpeed: roll.thinkingSpeed } }
          : this.createBot(roll);
        const assigned: BotInstance = { ...fresh, roomCode, seat, idleSince: undefined };
```

`pickSkillLevel`：

```ts
/** §9.3 的难度分布（可配，见 config.ts）。 */
private pickSkillLevel(): SkillLevel {
  const roll = this.random();
  const dist = getRobotConfig().skillDistribution;
  let cumulative = 0;
  let last: SkillLevel = dist[dist.length - 1][0];
  for (const [level, weight] of dist) {
    cumulative += weight;
    last = level;
    if (roll < cumulative) return level;
  }
  return last;   // 兜底 = 最后一档（**不是** 'beginner'：浮点残差不许静默塞给某一档）
}
```

四处 room-service fixture：`personality: { thinkingSpeed: 900, errorRate: 0.15 }` ⇒ `personality: { thinkingSpeed: 900 }`（`match.service.test.ts:212`、`robot.client.test.ts:127`、`rooms.autostart.test.ts:222`、`rooms.start.test.ts:37`）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/robot-service test robot.pool` ⇒ PASS；`pnpm --filter @fight-the-landlord/room-service test` ⇒ PASS

- [ ] **Step 5: 提交**

```bash
git add -A packages/robot-service packages/room-service
git commit -m "feat(robot-service): 难度在 acquire 的新绑定分支抽取（createBot 不再抽随机）；删 ERROR_RATE/errorRate"
```

---

## Task 4: 出牌决策 100% DouZero（三分支 + model 字段）

**Files:**
- Create: `packages/robot-service/src/robot/models.ts`
- Modify: `packages/robot-service/src/robot/bot.player.ts`
- Modify: `packages/robot-service/src/robot/douzero.client.ts`
- Modify: `packages/robot-service/src/robot/robot.service.ts`（决策日志加 `model=`）
- Modify: `packages/robot-service/test/robot.decide.test.ts`（:134-160 必翻）
- Modify: `packages/robot-service/test/bot.player.test.ts`（:194 替身改抛错）
- Modify: `packages/robot-service/test/douzero.client.test.ts`（`model` 必填 + `text()` 替身 + 看门狗键清单）

**Interfaces:**
- Consumes: Task 1 的 `SkillLevel`；Task 3 的池
- Produces: `MODEL_BY_SKILL: Record<SkillLevel, DouZeroModel>` · `DouZeroModel = 'sl' | 'douzero_WP' | 'douzero_ADP'` · `DouZeroContext.model: DouZeroModel`（必填）· `DouZeroRequestBody.model: string`（必填）

- [ ] **Step 1: 写失败测试** —— 三处（**用各文件已有的夹具**）：

① `robot.decide.test.ts`：把「beginner ⇒ 规则引擎」组（`:134-160`）翻成下面两条（该文件的入口是 `request(over)`，**不是** `baseReq()`）：

```ts
it('片② D1/J1：beginner 也走 DouZero，且带 model=sl', async () => {
  const client = { getMove: vi.fn(async (_ctx: unknown) => [5]) };   // ⚠️ 形参不能省：`mock.calls[0][0]` 才不报 TS2493
  const player = new BotPlayer(client as unknown as DouZeroClient);

  const res = await player.decide(request({ skillLevel: 'beginner' }));

  expect(client.getMove).toHaveBeenCalledTimes(1);
  expect((client.getMove.mock.calls[0][0] as { model: string }).model).toBe('sl');
  expect(res).toEqual({ kind: 'play', cards: [5], source: 'douzero' });
});

it('片② D1/J1：advanced 带 model=douzero_ADP；intermediate 带 douzero_WP', async () => {
  for (const [level, model] of [['intermediate', 'douzero_WP'], ['advanced', 'douzero_ADP']] as const) {
    const client = { getMove: vi.fn(async (_ctx: unknown) => [5]) };
    const player = new BotPlayer(client as unknown as DouZeroClient);
    await player.decide(request({ skillLevel: level }));
    expect((client.getMove.mock.calls[0][0] as { model: string }).model).toBe(model);
  }
});
```

② `bot.player.test.ts:194` 的替身 `async () => []` 改成 `async () => { throw new Error('boom'); }`（否则「DouZero 失败 ⇒ WARN ⇒ 回退」那条永远走不到；⚠️ **只改档位是没用的**）。

③ `douzero.client.test.ts`：

- `ctx()` 助手（`:13-23`）加 `model: 'douzero_WP' as const`；
- 🔴 **两处内联 ctx 都要补** `model`（`DouZeroContext.model` 变必填后，内联字面量少属性是 lint 红 —— robot-service 的 lint 含 `tsc --noEmit -p tsconfig.test.json`，`test/**` 在内）：
  - 第一条用例的 `:43-52`（**v3 补记：v2 只列了下一处**）；
  - `:120-141` 的 `it('throws on API error')`，并给替身补 `text`：

```ts
  it('throws on API error', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('boom'),        // 片② D7：非 200 要先读 body 再抛
    });
    global.fetch = mockFetch as any;
    const client = new DouZeroClient();
    await expect(client.getMove({ /* …同上内联 ctx + model… */ })).rejects.toThrow('DouZero HTTP 500');
  });
```

- `:103-115` 的契约键清单（那个 `for (const key of [...])`）**加 `'model'`**。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/robot-service test` ⇒ FAIL

- [ ] **Step 3: 实现** ——

`src/robot/models.ts`（新）：

```ts
import type { SkillLevel } from '@fight-the-landlord/protocol';

/** douzero 侧的模型目录名（逐字，见 `douzero/models/<model>/`）。 */
export type DouZeroModel = 'sl' | 'douzero_WP' | 'douzero_ADP';

/** §9.3 三档 = 三个模型（片② D2，用户裁决 5）。 */
export const MODEL_BY_SKILL: Record<SkillLevel, DouZeroModel> = {
  beginner: 'sl',
  intermediate: 'douzero_WP',
  advanced: 'douzero_ADP',
};
```

`douzero.client.ts`：`DouZeroContext` 加 `model: DouZeroModel`；`DouZeroRequestBody` 加 `model: string`；`getMove` 的 body 里 `model: context.model`；导出 `DOUZERO_URL`；非 200 先读 body：

```ts
export const DOUZERO_URL = process.env.DOUZERO_URL ?? 'http://localhost:2021';
// …
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`DouZero HTTP ${response.status}: ${response.statusText} ${detail}`.trim());
      }
```

`bot.player.ts` 的 `decidePlay`：

```ts
    private async decidePlay(req: RobotDecideRequest): Promise<RobotDecideResponse> {
      try {
        const cards = await this.douzeroClient.getMove(this.buildDouZeroContext(req));
        if (cards.length === 0) return { kind: 'pass', source: 'douzero' };   // 明确 pass，不降级
        if (this.isPlausible(cards, req.view)) return { kind: 'play', cards, source: 'douzero' };
        this.logger.warn(`DouZero returned cards not in hand for bot ${req.botId}; falling back to rule engine`);
      } catch (error) {
        this.logger.warn(`DouZero failed for bot ${req.botId}; falling back to rule engine: ${(error as Error).message}`);
      }
      return this.ruleDecide(req);
    }
```

`buildDouZeroContext` 里加 `model: MODEL_BY_SKILL[req.skillLevel]`。

`robot.service.ts` 的决策日志加 `model=`：

```ts
      const model = MODEL_BY_SKILL[req.skillLevel];
      this.logger.log(`Bot ${req.botId} decided ${decision.kind} (source=${decision.source}, model=${model}, …)`);
```

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/robot-service test` ⇒ PASS；`run lint` ⇒ 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/robot-service
git commit -m "feat(robot-service): 出牌 100% 走 DouZero（三分支 + 必填 model）；决策日志带 model="
```

---

## Task 4B: robot-service 可用性探测与 RPC（A6/A7/A8）

**Files:**
- Create: `packages/robot-service/src/robot/douzero.health.ts`
- Create: `packages/robot-service/test/douzero.health.test.ts`
- Modify: `packages/robot-service/src/robot/robot.service.ts`（加 `availability()`，**只转发**）
- Modify: `packages/robot-service/src/rpc/robot.rpc.controller.ts`（加 `@MessagePattern`）
- Modify: `packages/robot-service/src/robot/robot.module.ts`（注册新 provider，**值导入**）
- Modify: `packages/robot-service/test/robot.rpc.test.ts`（加一条 handler 用例）
- Modify: `packages/robot-service/test/robot.decide.test.ts:206`（`new RobotService` 补第 3 参）

**Interfaces:**
- Consumes: Task 1 的 `RPC_PATTERNS.robotAvailability` / `RobotAvailabilityResponse`；Task 2 的 `getRobotConfig()`；Task 4 的 `DOUZERO_URL`
- Produces: `DouZeroHealth.canProvide(): Promise<RobotAvailabilityResponse>`（**永不抛**）

- [ ] **Step 1: 写失败测试** —— `douzero.health.test.ts`（**六个可执行用例**；⚠️ 两条前提：① fetch 与时钟都要**注入**（`DouZeroHealth` 的构造签名见 Step 3）；② 每个用例前后要 `resetRobotConfigForTests()`，否则 `getRobotConfig()` 的记忆化会把第一次的 env 锁死）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DouZeroHealth } from '../src/robot/douzero.health';
import { resetRobotConfigForTests } from '../src/robot/config';

const FULL = { sl: ['landlord', 'landlord_down', 'landlord_up'],
               douzero_WP: ['landlord', 'landlord_down', 'landlord_up'],
               douzero_ADP: ['landlord', 'landlord_down', 'landlord_up'] };

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: () => Promise.resolve(body) }) as unknown as Response;

let now: number;
const mk = (impl: (url: string, init?: RequestInit) => Promise<Response>) =>
  new DouZeroHealth(impl as unknown as typeof fetch, () => now);

beforeEach(() => { now = 1_700_000_000_000; delete process.env.ROBOT_RULE_FALLBACK; });
afterEach(() => { resetRobotConfigForTests(); delete process.env.ROBOT_RULE_FALLBACK; });

it('开关 ON ⇒ 恒 true 且不探测', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'true';
  resetRobotConfigForTests();
  const impl = vi.fn();
  expect(await mk(impl as never).canProvide()).toEqual({ canProvide: true });
  expect(impl).not.toHaveBeenCalled();
});

it('200 + 三档齐备 ⇒ true', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false'; resetRobotConfigForTests();
  const h = mk(async () => jsonResponse({ status: 'ok', models: FULL, missing: [] }));
  expect(await h.canProvide()).toEqual({ canProvide: true });
});

it('200 + 缺一档 / 某档位置不全 ⇒ false/models-incomplete', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false'; resetRobotConfigForTests();
  for (const models of [
    { sl: FULL.sl, douzero_WP: FULL.douzero_WP },                                    // 缺 ADP
    { ...FULL, douzero_ADP: ['landlord', 'landlord_down'] },                          // 少一个位置
  ]) {
    resetRobotConfigForTests();
    const h = mk(async () => jsonResponse({ status: 'ok', models }));
    expect(await h.canProvide()).toEqual({ canProvide: false, reason: 'models-incomplete' });
  }
});

it('非 200 / 连接被拒 ⇒ false/douzero-unreachable', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false'; resetRobotConfigForTests();
  expect(await mk(async () => jsonResponse({}, 503)).canProvide())
    .toEqual({ canProvide: false, reason: 'douzero-unreachable' });
  resetRobotConfigForTests();
  expect(await mk(async () => { throw new TypeError('fetch failed'); }).canProvide())
    .toEqual({ canProvide: false, reason: 'douzero-unreachable' });
});

it('超时 ⇒ false/douzero-unreachable', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false'; resetRobotConfigForTests();
  // 注入的 fetch 永不 resolve，但把「超时」做成 reject（真实实现用 AbortSignal.timeout）
  const h = mk(async () => { throw new DOMException('The operation was aborted.', 'TimeoutError'); });
  expect(await h.canProvide()).toEqual({ canProvide: false, reason: 'douzero-unreachable' });
});

it('models 缺失 / 非普通对象（含数组、null）⇒ true（fail-open）', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false';
  for (const body of [{ status: 'ok', agents: [] }, { status: 'ok', models: [] }, { status: 'ok', models: null }]) {
    resetRobotConfigForTests();
    const h = mk(async () => jsonResponse(body));
    expect(await h.canProvide()).toEqual({ canProvide: true });
  }
});

it('5s 内只探一次（缓存）', async () => {
  process.env.ROBOT_RULE_FALLBACK = 'false'; resetRobotConfigForTests();
  const impl = vi.fn(async () => jsonResponse({ status: 'ok', models: FULL }));
  const h = mk(impl);
  await h.canProvide();
  now += 4_000;
  await h.canProvide();
  expect(impl).toHaveBeenCalledTimes(1);       // 命中缓存
  now += 2_000;                                 // 累计 6s > 5s
  await h.canProvide();
  expect(impl).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/robot-service test douzero.health` ⇒ FAIL

- [ ] **Step 3: 实现** —— `src/robot/douzero.health.ts`：

```ts
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { RobotAvailabilityResponse } from '@fight-the-landlord/protocol';
import { DOUZERO_URL } from './douzero.client';
import { getRobotConfig } from './config';

const PROBE_TIMEOUT_MS = 1000;
const CACHE_TTL_MS = 5000;
const POSITIONS = ['landlord', 'landlord_down', 'landlord_up'] as const;
const MODELS = ['sl', 'douzero_WP', 'douzero_ADP'] as const;

/** 片② D5：DouZero 可用性门禁（只在开关关掉时才真的去探）。 */
@Injectable()
export class DouZeroHealth {
  private readonly logger = new Logger(DouZeroHealth.name);
  private cached?: { at: number; value: RobotAvailabilityResponse };

  /** fetch 与时钟都可注入（**仅测试**；生产走全局 `fetch` 与 `Date.now`）。 */
  constructor(
    @Optional() private readonly fetchImpl: typeof fetch = fetch,
    @Optional() private readonly clock: () => number = () => Date.now(),
  ) {}

  async canProvide(): Promise<RobotAvailabilityResponse> {
    if (getRobotConfig().ruleFallback) return { canProvide: true };      // 开关 ON：不探测
    const now = this.clock();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) return this.cached.value;
    const value = await this.probe();
    this.cached = { at: now, value };
    return value;
  }

  private async probe(): Promise<RobotAvailabilityResponse> {
    try {
      const res = await this.fetchImpl(`${DOUZERO_URL}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return this.unreachable(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const models = (body as { models?: unknown })?.models;
      if (typeof models !== 'object' || models === null || Array.isArray(models)) {
        this.logger.warn('douzero /health has no parsable `models`; treating it as available');
        return { canProvide: true };                                      // fail-open
      }
      const table = models as Record<string, unknown>;
      const incomplete = MODELS.filter((m) => {
        const positions = table[m];
        return !Array.isArray(positions) || !POSITIONS.every((p) => (positions as unknown[]).includes(p));
      });
      if (incomplete.length > 0) {
        this.logger.warn(`douzero models incomplete: ${incomplete.join(',')}`);
        return { canProvide: false, reason: 'models-incomplete' };
      }
      return { canProvide: true };
    } catch (error) {
      return this.unreachable((error as Error).message);                  // 含超时与连接被拒
    }
  }

  private unreachable(detail: string): RobotAvailabilityResponse {
    this.logger.warn(`DouZero unreachable: ${detail}`);
    return { canProvide: false, reason: 'douzero-unreachable' };
  }
}
```

`robot.service.ts` 只加转发（构造 +1 参 —— ⚠️ **值导入**）：

```ts
  constructor(
    private readonly bot: BotPlayer,
    private readonly pool: RobotPool,
    private readonly health: DouZeroHealth,           // 片② D5
  ) { super(); }

  availability(): Promise<RobotAvailabilityResponse> {
    return this.health.canProvide();
  }
```

`robot.rpc.controller.ts` 加：

```ts
  @MessagePattern(RPC_PATTERNS.robotAvailability)
  availability(@Payload() dto: RobotAvailabilityRequest) {
    return toResult(() => this.robotService.availability(), dto?.meta);
  }
```

`robot.module.ts`：`providers` 加 `DouZeroHealth`（值导入）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/robot-service test` ⇒ PASS；`run lint` ⇒ 0 error（⚠️ `robot.decide.test.ts:206` 的 `new RobotService(bot, fakePool)` 要补第 3 参 stub，否则编译红）

- [ ] **Step 5: 提交**

```bash
git add packages/robot-service
git commit -m "feat(robot-service): DouZero 可用性探测（六态 + 5s 缓存）与 robot.availability RPC"
```

---

## Task 5: DouZero 服务（9 模型 / model 字段 / 线程 / 下载 / 400-503）

**Files:**
- Modify: `douzero/server.py`
- Modify: `douzero/Dockerfile`
- Modify: `douzero/README.md`、`douzero/.gitignore`
- Create: `douzero/models/SOURCES.md`
- Move: `douzero/models/*.onnx` → `douzero/models/<model>/<position>.onnx`；新增 6 个（从 HF 下）

**Interfaces:**
- Produces: `POST /decide_play { …, model?: 'sl'|'douzero_WP'|'douzero_ADP' }`（缺省 `douzero_WP`；未知 ⇒ **400**；已知未加载 ⇒ **503**）；`GET /health ⇒ {status:'ok', models:{…}, missing:[…], agents:[…]}`（恒 200）

- [ ] **Step 1: 搬运与取证（先做，后面测试要用）**

```bash
# ① 现有 3 个文件搬到 WP 子目录
mkdir -p douzero/models/douzero_WP
git mv douzero/models/landlord.onnx douzero/models/douzero_WP/landlord.onnx
git mv douzero/models/landlord_down.onnx douzero/models/douzero_WP/landlord_down.onnx
git mv douzero/models/landlord_up.onnx douzero/models/douzero_WP/landlord_up.onnx
# ② 另六件从容器内下（宿主 DNS 对 HF 不通）
docker exec ftl-douzero python -c "
import os, urllib.request
for m in ('sl','douzero_ADP'):
    os.makedirs(f'/tmp/{m}', exist_ok=True)
    for p in ('landlord','landlord_down','landlord_up'):
        u=f'https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx/{m}/{p}.onnx'
        urllib.request.urlretrieve(u, f'/tmp/{m}/{p}.onnx')
"
docker cp ftl-douzero:/tmp/sl douzero/models/sl
docker cp ftl-douzero:/tmp/douzero_ADP douzero/models/douzero_ADP
# ③ 记录 sha256（写进 SOURCES.md）
shasum -a 256 douzero/models/*/*.onnx
```

- [ ] **Step 2: 写失败测试（脚本化探针）** —— 用现成的探针目录跑三条（**容器内 vantage**）。⚠️ **Windows/Git Bash 必须带 `MSYS_NO_PATHCONV=1`**：否则 `-w /app` 会被转成 `E:/Softwares/Git/app`，docker 实测报 `Cwd must be an absolute path`（本片实测过）：

```bash
# 期望：现状（未改的 server.py）返回 200 且无 models 键 ⇒ 这三条必红
 MSYS_NO_PATHCONV=1 docker exec -i -w /app ftl-douzero python - <<'PY'
import json, urllib.request
h = json.load(urllib.request.urlopen('http://localhost:2021/health'))
assert 'models' in h, h                      # J26 的前置
assert h['models'].keys() == {'sl','douzero_WP','douzero_ADP'}, h
PY
```

- [ ] **Step 3: 实现 `server.py`** —— 关键片段：

```python
MODELS = ["sl", "douzero_WP", "douzero_ADP"]
POSITIONS = ["landlord", "landlord_down", "landlord_up"]
DEFAULT_MODEL = "douzero_WP"
HF_BASE = "https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx"
SINGLE_TIMEOUT_S, TOTAL_DOWNLOAD_BUDGET_S = 30, 60

sessions: dict[str, dict[str, ort.InferenceSession]] = {m: {} for m in MODELS}
missing: list[str] = []
loaded_agents: list[str] = []


def download_model(model: str, deadline: float) -> None:
    """缺文件才下；先写同目录 .tmp 再 rename；失败一律吞掉（只读挂载/断网都不许抛）。"""
    for pos in POSITIONS:
        path = os.path.join(MODEL_DIR, model, f"{pos}.onnx")
        if os.path.exists(path):
            continue
        tmp = f"{path}.tmp"
        url = f"{HF_BASE}/{model}/{pos}.onnx"
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            if time.monotonic() > deadline:
                print(f"  Download budget exhausted, skipping {model}/{pos}")
                return
            with urllib.request.urlopen(url, timeout=SINGLE_TIMEOUT_S) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(tmp, path)
            print(f"  Downloaded {model}/{pos}.onnx")
        except Exception as e:                      # noqa: BLE001 —— 只读挂载/断网都必须继续启动
            print(f"  Download failed for {model}/{pos}: {e}")
            try:
                os.remove(tmp)
            except OSError:
                pass


def load_sessions() -> None:
    for model in MODELS:
        ok = 0
        for pos in POSITIONS:
            path = os.path.join(MODEL_DIR, model, f"{pos}.onnx")
            if not os.path.exists(path):
                print(f"  Missing  {model}/{pos}")
                continue
            try:
                sessions[model][pos] = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
                ok += 1
                print(f"  Loaded   {model}/{pos}")
            except Exception as e:                  # noqa: BLE001 —— 损坏只报告，不删
                print(f"  FAILED   {model}/{pos}: {e}")
        if ok == len(POSITIONS):
            loaded_agents.append(model)
        else:
            missing.append(model)
```

`/health`：

```python
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "models": {m: sorted(sessions[m].keys()) for m in MODELS if sessions[m]},
                "missing": missing,
                "agents": sorted(loaded_agents),
            })
        else:
            self.send_error(404)
```

`/decide_play` 读 `model`：

```python
            model = body.get("model", DEFAULT_MODEL)
            if model not in MODELS:
                self._json(400, {"action": [], "error": f"unknown model {model}"})
                return
            if not sessions[model]:
                self._json(503, {"action": [], "error": f"model {model} not loaded"})
                return
```

`_act(position, infoset)` 改成 `_act(model, position, infoset)`（`sessions[model][position].run(...)`）。

启动段：

```python
if __name__ == "__main__":
    deadline = time.monotonic() + TOTAL_DOWNLOAD_BUDGET_S
    for m in MODELS:
        download_model(m, deadline)
    load_sessions()
    print(f"\nDouZero service listening on port {PORT} (models: {loaded_agents}, missing: {missing})")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.request_queue_size = 128
    server.serve_forever()
```

- [ ] **Step 4: 实现 `Dockerfile` / README / .gitignore**（⚠️ python 片段要用到 `time` / `shutil` / `ThreadingHTTPServer`，而 `server.py:9-14` 只 import 了 `os/json/traceback/urllib.request/Counter/HTTPServer/BaseHTTPRequestHandler` ⇒ **先补三处 import**：`import time`、`import shutil`、`from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler`）

`Dockerfile` 的 **runtime 段**（`COPY --from=builder /app/models /app/models` 之后）加：

```dockerfile
# 片② D7 层 1：出货文件系统必须九个模型齐备（COPY 是目录拷贝，缺文件不报错）
RUN test -f /app/models/sl/landlord.onnx \
 && test -f /app/models/sl/landlord_down.onnx \
 && test -f /app/models/sl/landlord_up.onnx \
 && test -f /app/models/douzero_WP/landlord.onnx \
 && test -f /app/models/douzero_WP/landlord_down.onnx \
 && test -f /app/models/douzero_WP/landlord_up.onnx \
 && test -f /app/models/douzero_ADP/landlord.onnx \
 && test -f /app/models/douzero_ADP/landlord_down.onnx \
 && test -f /app/models/douzero_ADP/landlord_up.onnx
```

`douzero/.gitignore`（新）：`__pycache__/`、`*.pyc`；并 `git rm -r --cached douzero/src/__pycache__`。
`README.md` 同步五项：模型目录布局、`HF_BASE` 模板与九个 URL、`/decide_play` 的 `model` 字段（缺省 WP）、`/health` 新形状、并发形态（线程 + backlog 128）+ SIGTERM 语义。
`models/SOURCES.md`（新）：九个 URL + 各自 sha256。

- [ ] **Step 5: 重建镜像并复跑探针**

```bash
docker compose build douzero && docker compose up -d --force-recreate douzero
 MSYS_NO_PATHCONV=1 docker exec -i -w /app ftl-douzero python - <<'PY'
import json, urllib.request
h = json.load(urllib.request.urlopen('http://localhost:2021/health'))
assert h['models'].keys() == {'sl','douzero_WP','douzero_ADP'} and h['missing'] == [], h
def decide(model=None, **over):
    body = {"position":"landlord_up","hand":[3,4,5],"bottom_cards":[],"last_move":[5],
            "last_move_position":"landlord","num_cards_left":{"landlord":5,"landlord_down":5,"landlord_up":3},
            "played_cards_landlord":[],"played_cards_landlord_down":[],"played_cards_landlord_up":[],
            "card_play_action_seq":[],"must_play":True, **over}
    if model: body["model"] = model
    req = urllib.request.Request('http://localhost:2021/decide_play',
                                 data=json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req))['action']
assert decide('sl') == [4] and decide() == [3] and decide('douzero_WP') == [3] and decide('douzero_ADP') == [5]
print('J26/J33 判别局面 OK')
PY
```

- [ ] **Step 6: 提交**

```bash
git add douzero
git commit -m "feat(douzero): 三档模型装配（9 ONNX）+ model 字段 + /health 清单 + 线程/backlog + 有界下载"
```

---

## Task 6: room-service 可用性门禁

**Files:**
- Modify: `packages/room-service/src/match/match.service.ts`
- Modify: `packages/room-service/src/gateway/robot.client.ts`
- Modify: `packages/room-service/test/match.service.test.ts`（四处构造点 + 新用例）
- Modify: `packages/room-service/test/message.router.test.ts:998`

**Interfaces:**
- Consumes: Task 1 的 `RPC_PATTERNS.robotAvailability` / `RobotAvailabilityResponse`
- Produces: `RobotClient.availability(): Promise<boolean>`（**永不 undefined**，fail-open ⇒ `true`）；`MatchService` 构造参数 **+1**（`robot: RobotClient`）

- [ ] **Step 1: 写失败测试** —— `match.service.test.ts` 加五条（**用该文件 `beforeEach` 已建好的 `service`/`rpc`/`redis`/`roomsService`**；RPC 替身的应答必须是 **rxjs Observable**：`rpc.on(pattern, () => of({ ok: true, data: {…} }))`）：

```ts
it('片② D5/J6：开关关 + 不可用 ⇒ 第 30s 只判窗口已到点的人，且**不建房**', async () => {
  const T0 = 1_700_000_000_000;
  rpc.on(RPC_PATTERNS.robotAvailability, () =>
    of({ ok: true, data: { canProvide: false, reason: 'douzero-unreachable' } }));

  service.setClock(() => T0);
  await service.addToQueue('u1', 'random', 15);
  service.setClock(() => T0 + 31_000);
  await service.addToQueue('u2', 'random', 15);      // u2 只等了 0 秒
  service.setClock(() => T0 + 31_500);

  await service.scanOnce();

  expect(roomsService.createGameRoom).not.toHaveBeenCalled();            // 负例：判完必须 return
  const published = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
    .find(([channel]) => channel === 'match:events');
  const event = JSON.parse(published![1] as string);
  expect(event).toMatchObject({ event: 'match.timeout', playerIds: ['u1'] });   // **只有 u1**
  expect(event.message).toBe('当前无匹配的玩家');
  expect(event.code).toBe(12007);
  expect(redis._zsets.get('match:queue:random:15:global')?.has('u2')).toBe(true);  // u2 留队
});

it('片② D5/J9：人够 3 个时门禁**根本不参与**', async () => {
  const T0 = 1_700_000_000_000;
  const availability = vi.fn(() => of({ ok: true, data: { canProvide: false } }));
  rpc.on(RPC_PATTERNS.robotAvailability, availability);
  service.setClock(() => T0);
  for (const u of ['u1', 'u2', 'u3']) await service.addToQueue(u, 'random', 15);
  service.setClock(() => T0 + 31_000);

  await service.scanOnce();

  expect(availability).not.toHaveBeenCalled();
  expect(roomsService.createGameRoom).toHaveBeenCalled();
});

it('片② D5/J8：探测抛错（未知 pattern）⇒ fail-open，照常补位', async () => {
  const T0 = 1_700_000_000_000;
  rpc.on(RPC_PATTERNS.robotAvailability, () => throwError(() => new Error('no message handler')));
  service.setClock(() => T0);
  await service.addToQueue('u1', 'random', 15);
  service.setClock(() => T0 + 31_000);

  await service.scanOnce();

  expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(1);
});

it('片② D5/J20：一轮多个桶只问一次', async () => {
  const T0 = 1_700_000_000_000;
  let calls = 0;
  rpc.on(RPC_PATTERNS.robotAvailability, () => { calls += 1; return of({ ok: true, data: { canProvide: true } }); });
  service.setClock(() => T0);
  await service.addToQueue('u1', 'random', 15);
  await service.addToQueue('u2', 'random', 80);        // ⚠️ 80 是档位表里的一档（15/80/480/1200）；写 30 会在 setup 就被 BAD_PARAM 拒掉
  service.setClock(() => T0 + 31_000);

  await service.scanOnce();

  expect(calls).toBe(1);
});

it('片② D5/J7：OFF + **可用** ⇒ 照常补位（同一替身先 false 后 true ⇒ 只有第二次补位）', async () => {
  const T0 = 1_700_000_000_000;
  let answer = false;
  rpc.on(RPC_PATTERNS.robotAvailability, () => of({ ok: true, data: { canProvide: answer } }));
  service.setClock(() => T0);
  await service.addToQueue('u1', 'random', 15);
  service.setClock(() => T0 + 31_000);
  await service.scanOnce();
  expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire)).toHaveLength(0);   // 不可用 ⇒ 不补

  answer = true;                                                        // DouZero 回来了
  await service.addToQueue('u2', 'random', 80);
  service.setClock(() => T0 + 61_000);
  await service.scanOnce();
  expect(rpc.payloadsOf(RPC_PATTERNS.robotAcquire).length).toBeGreaterThan(0);
});

it('片② D5/J27：failMatch 幂等（重叠轮里同一票不发第二条 12007）', async () => {
  const T0 = 1_700_000_000_000;
  // 🔴 构造：第一轮的问询**挂住**（用自己控制的 Subject），第二轮立即答 false ⇒ 第二轮先判失败；
  //    再放行第一轮 ⇒ 它也会试着判同一票 ⇒ 幂等过滤必须挡住第二条。
  const gate = new Subject<unknown>();
  let call = 0;
  rpc.on(RPC_PATTERNS.robotAvailability, () =>
    (call++ === 0 ? gate : of({ ok: true, data: { canProvide: false } })));
  service.setClock(() => T0);
  await service.addToQueue('u1', 'random', 15);
  service.setClock(() => T0 + 31_000);

  const roundA = service.scanOnce();                 // 挂在 gate 上
  await service.scanOnce();                          // 第二轮：判 u1、发事件
  gate.next({ ok: true, data: { canProvide: false } });
  gate.complete();
  await roundA;                                      // 第一轮恢复 ⇒ 想再判一次

  const events = (redis.publish as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([channel]) => channel === 'match:events')
    .map(([, payload]) => JSON.parse(payload as string));
  expect(events).toHaveLength(1);                    // 只发一条
  expect(events[0].playerIds).toEqual(['u1']);
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/room-service test match.service` ⇒ FAIL

- [ ] **Step 3: 实现** —— `robot.client.ts`（⚠️ 该文件现有的是 `lastValueFrom(this.proxy.send(...))` 形态 —— **照抄现有方法改**，别用 `firstValueFrom`/`this.client`）：

```ts
/** 片② D11：availability 的 RPC 超时（**2s**，必须 > 探测的 1s）。 */
export const ROBOT_AVAILABILITY_TIMEOUT_MS = 2000;

  /** 片② D5：可用性门禁。**永不 reject**、永不 undefined —— 问不到一律 `true`（fail-open）。 */
  async availability(): Promise<boolean> {
    try {
      const res = await lastValueFrom(
        this.proxy
          .send<RpcResult<RobotAvailabilityResponse>>(RPC_PATTERNS.robotAvailability, { ...metaFromTrace() })
          .pipe(timeout(ROBOT_AVAILABILITY_TIMEOUT_MS)),
      );
      const canProvide = res?.ok ? res.data?.canProvide : undefined;
      if (canProvide === undefined) {
        this.logger.warn('robot.availability gave no usable answer; treating DouZero as available');
        return true;
      }
      return canProvide;
    } catch (error) {
      this.logger.warn(`robot.availability failed (${String(error)}); treating DouZero as available`);
      return true;
    }
  }
```

`match.service.ts`：

```ts
  constructor(
    private readonly redis: Redis,
    private readonly roomsService: RoomsService,
    private readonly roomStart: RoomStartService,
    private readonly config: ConfigClient,
    private readonly robot: RobotClient,          // 片② D5：新增（DI 用**值导入**）
  ) { super(); }
```
`scanAndMatchInner`：

```ts
    // 🔴 `round` 必须建在 for **之上**（建在 for 里 ⇒ 每桶一个 ⇒ 每桶各问一次，与 J20 直接相反）
    const round: { can?: boolean } = {};
    for (const key of await this.listQueueKeys()) {
      // …
      await this.processQueue(queue.mode, queue.baseScore, queue.region, round);
    }
```
`processQueue(..., round: { can?: boolean })` 在 `:427` 早退之后插入：

```ts
    if (alive.length < 3) {
      round.can ??= await this.robot.availability();      // 每轮至多问一次
      if (round.can === false) {
        const expired = alive.filter((q) => now - q.enteredAt >= BOT_FILL_WAIT_MS);
        if (expired.length > 0) {
          await this.failMatch(expired.map((q) => q.playerId), mode, baseScore, region, '当前无匹配的玩家');
        }
        return;                                            // 🔴 必须 return（J6 负例）
      }
    }
```
`failMatch` 改序：

```ts
  private async failMatch(
    playerIds: string[],
    mode: MatchMode,          // ← 保持现有的 MatchMode（别放宽成 string）
    baseScore: number,
    region: string,
    message: string,
  ): Promise<void> {
    const queueKey = matchQueueKey(mode, baseScore, region);
    const notified: string[] = [];
    for (const playerId of playerIds) {
      const removed = await this.redis.zrem(queueKey, playerId);
      if (removed > 0) notified.push(playerId);            // 只发真的被移除的
      await this.redis.del(matchMetaKey(playerId));
    }
    if (notified.length === 0) return;
    try {
      await this.redis.publish(MATCH_EVENTS_CHANNEL, JSON.stringify({
        event: 'match.timeout', playerIds: notified, code: ErrCode.MATCH_TIMEOUT, message,
      }));
    } catch (err) { this.logger.error(`Failed to publish match.timeout: ${String(err)}`); }
    this.logger.warn(`Match timed out for ${notified.length} player(s) in ${mode}/${baseScore}/${region}`);
  }
```
并把既有 60s 调用点的文案改中文：`':419'` 的 `'Match timed out: no table could be formed'` ⇒ `'当前无匹配的玩家'`。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/room-service test` ⇒ PASS（**含既有 14 处越窗用例**：`makeFakeProxy` 默认回 `{ok:true,data:{}}` ⇒ `canProvide === undefined` ⇒ fail-open ⇒ 行为不变）

🔴 **J23 的第二半要顺手改既有用例**：`match.service.test.ts:792-808`（60s 路径）现在断 `event`/`playerIds`/`code`，**没断 message** ⇒ 给那条加一行：

```ts
      expect(event.message).toBe('当前无匹配的玩家');   // 片② D8：60s 与门禁两条路径的文案必须同一句
```

- [ ] **Step 5: 提交**

```bash
git add packages/room-service
git commit -m "feat(room-service): 可用性门禁（每轮一次/只判窗口到点者/fail-open）+ failMatch 幂等 + 中文文案"
```

---

## Task 7: game-service 第三条决策路径的日志

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`（`:613-614` 加标记；`:646-647` 那条**既有** reject warn 补标记。⚠️ **不要去动 `:627-631`** —— `decided === null` 时那一支恒不执行）
- Test: `packages/game-service/test/game.robot.test.ts`

**Interfaces:** 无对外签名变化（纯日志）。

- [ ] **Step 1: 写失败测试** —— 在 `game.robot.test.ts` 加（⚠️ 抓日志用 `createCapturingSink()` ⇒ `const { sink, records } = …`，断言走 **`records`** 的 `.msg`；`sink.lines` **不存在**）：

```ts
it('片② D10/J25：robot.decide 失败时日志带 fallback=game-service-rule', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink));
  service.robotClient = { decide: async () => null } as never;      // 既有范式：game.robot.test.ts:163

  // …推进到机器人回合（照本文件既有用例的假计时器手法）…

  expect(records.some((r) => r.msg.includes('fallback=game-service-rule')
    && r.msg.includes('reason=decide-failed'))).toBe(true);
});

it('片② D10/J25：动作被规则拒时那条既有 warn 带上 reason=action-rejected', async () => {
  const { sink, records } = createCapturingSink();
  Logger.overrideLogger(createRedactingLogger(sink));
  // …造一个「DouZero 回了牌但 game-service 判非法」的回合…

  expect(records.some((r) => r.msg.includes('Robot action rejected')
    && r.msg.includes('reason=action-rejected'))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/game-service test game.robot` ⇒ FAIL

- [ ] **Step 3: 实现** —— `:613-614` 改成（⚠️ 别写 `…`：真实那行是 `:38-40` 的 `Bot ${req.botId} decided …` **另一处**，这里是 game-service）：

```ts
      if (!decided) {
        this.logger.warn(
          `robot.decide failed for ${roomCode} seat ${seat}; using the rule engine ` +
            '(fallback=game-service-rule reason=decide-failed)',
        );
      }
```
`:646-647` 那条**已经存在**的「Robot action rejected…」warn **不新增**，只把它的文案补上标记（🔴 **v4 订正**：**必须保留**既有的 `: ${String(err)}` 尾缀 —— `commitRobotDecision` 的 catch 把错误吞了，这条 warn 是**全系统唯一**落该错误详情的地方；把标记**追加**在尾缀之后）：

```ts
        this.logger.warn(
          `Robot action rejected for ${roomCode} (${playerId}, ${decision.kind}): ${String(err)} ` +
            '(fallback=game-service-rule reason=action-rejected)',
        );
```
（⚠️ **不要**去动 `:627-631`：`decided === null` 时 `first` 与 `fallback` 是同参纯函数 ⇒ 那一支恒不执行；也**不要**试图往日志里带 `source/model` —— `model` 从不进响应。）

- [ ] **Step 4: 跑测试确认绿** —— 同上 ⇒ PASS

- [ ] **Step 5: 提交**

```bash
git add packages/game-service
git commit -m "feat(game-service): 第三条决策路径的两条日志（decide 失败 / 动作被拒）"
```

---

## Task 8: 客户端把「当前无匹配的玩家」显示出来

**Files:**
- Modify: `apps/client/src/net/action-copy.ts`
- Modify: `apps/client/src/net/session.ts`
- Modify: `apps/client/src/composables/useGameSession.ts`（`clearNotice` 的**唯一**落点：`notice` 是那边的 `Ref`）
- Modify: `apps/client/src/pages/game/game.vue`
- Test: `apps/client/test/auth-ui-wiring.test.ts`（**在既有用例旁边加**）

**Interfaces:**
- Produces: `actionCopyFor(code: number): string | null`；`SessionNotice { level; text; code?: number; source?: 'action' | 'transport' }`；`useGameSession()` 的 handle 加 `clearNotice(): void`

🔴 **本任务会改变 5 个既有 TOAST 码的玩家可见文案**（设计层 R4 要求「列全」，此处列全）：

| 码 | 现在（会话 toast） | 改后 |
|---|---|---|
| 10001 BAD_PARAM | `[10001] toast — …` | `请检查操作内容` |
| 10006 RATE_LIMITED | 同上形 | `操作太频繁，请稍后再试` |
| 10007 UPSTREAM_UNAVAILABLE | 同上形 | `服务暂时不可用，请稍后重试` |
| 13001 ILLEGAL_ACTION | 同上形 | `服务端判定这手牌不合法，换一手再试` |
| 13006 INVALID_CARDS | 同上形 | `选中的牌无法组成合法牌型（服务端判定）` |

⇒ 这是**有意的改进**（把调试串换成玩家文案），并且**要有判据**（见 Step 1 的第三条）。

- [ ] **Step 1: 写失败测试** —— 在 `apps/client/test/auth-ui-wiring.test.ts` 里**照既有 `:361-378` 的形态**加（那里的挂载器是 `mountGameWithSocket()`，推送是 `socket.push(serverMessage(type, payload, version))` —— **`version` 是必填第三参**）：

```ts
it('片② D8/J14：推送 12007 ⇒ 等待页显示「当前无匹配的玩家」', async () => {
  const { wrapper, socket } = await mountGameWithSocket();
  socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
  await nextTick();
  expect(wrapper.find('.game__notice').text()).toBe('当前无匹配的玩家');
});

it('片② D8/J15：推送 10004（BACK_TO_LOBBY 类）不得导航；10007 仍产 notice', async () => {
  const { wrapper, socket } = await mountGameWithSocket();
  socket.push(serverMessage('system.error', { code: 10004, message: 'token expired' }, 0));
  await nextTick();
  expect(wrapper.find('.game__notice').exists()).toBe(false);        // 导航类不从推送路径消费
  socket.push(serverMessage('system.error', { code: 10007, message: 'upstream down' }, 0));
  await nextTick();
  expect(wrapper.find('.game__notice').text()).toBe('服务暂时不可用，请稍后重试');   // ← 5 码文案的判据
});

it('片② D8/J16：重新匹配清掉匹配失败 notice，连接不可用仍在', async () => {
  const { wrapper, socket, session } = await mountGameWithSocket();
  socket.push(serverMessage('system.error', { code: 12007, message: 'Match timed out' }, 0));
  await nextTick();
  expect(wrapper.find('.game__notice').exists()).toBe(true);
  session.clearNotice();                                              // 等价于玩家再点「开始游戏」
  await nextTick();
  expect(wrapper.find('.game__notice').exists()).toBe(false);
  // 连接不可用那条**不受** clearNotice 影响（它带 source:'transport'）
  session.notice.value = { level: 'error', text: '连接不可用', source: 'transport' };
  session.clearNotice();
  expect(session.notice.value?.text).toBe('连接不可用');
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/client test auth-ui-wiring`（⚠️ 过滤的是**文件路径**：新用例在 `auth-ui-wiring.test.ts` 里，写 `match-timeout` 会 `No test files found` ⇒ **永远红**）⇒ FAIL

- [ ] **Step 3: 实现** —— `action-copy.ts`：

```ts
  [ErrCode.MATCH_TIMEOUT]: '当前无匹配的玩家',
// …
/** 取一条**玩家可见**文案；表里没有 ⇒ `null`（调用方自己决定兜底）。 */
export function actionCopyFor(code: number): string | null {
  return ACTION_ERROR_COPY[code] ?? null;
}
```

`session.ts`：`notice()` 回调**加第三参**（现在是两参 `notice(level, text)`，`:91`）：

```ts
  const notice = (level: SessionNotice['level'], text: string, extra?: { code?: number; source?: SessionNotice['source'] }) =>
    options.onNotice?.({ level, text, ...extra });
// …
    onConnectUnavailable: () => notice('error', CONNECT_UNAVAILABLE_TEXT, { source: 'transport' }),
// …
  // 🔴 推送路径：**只**消费「表里处置 = TOAST」或**未登记**的码（导航类不从这里走）。
  // ⚠️ 这一段与 `:127-137` 的 `options.applyEvent` **并存**（后者给 store 用），不是替换它。
  client.on('system.error', (msg) => {
    const payload = (msg as Extract<ServerMessage, { type: 'system.error' }>).payload;
    const known = Object.prototype.hasOwnProperty.call(CLIENT_ACTION, payload.code);
    if (known && CLIENT_ACTION[payload.code as ErrCode] !== ClientAction.TOAST) return;
    client.reportErrorCode(payload.code, payload.message);
  });
// …toast 处理器：
      toast: (report) => {
        notice('error', actionCopyFor(report.code) ?? describeAction(report), {
          code: report.code, source: 'action',
        });
      },
```

`useGameSession.ts`（**`clearNotice` 的唯一落点** —— `notice` 是这里的 `Ref`，`session.ts` 只有写回调）：

```ts
  /** 片② D8：只清「ACTION 来源」的那条 notice（连接不可用那条带 source:'transport'，不受影响）。 */
  const clearNotice = () => {
    if (notice.value?.source === 'action') notice.value = null;
  };
// …并在 return 的 handle 里带上 clearNotice（`:269` 那一处）
```

`game.vue` 的 `match()` 开头：

```ts
    const session = getGameSession();
    session.clearNotice();      // 玩家主动重开匹配 ⇒ 清掉上一次的失败提示
```

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/client test` ⇒ PASS（既有断言都是 `toMatchObject`/字段访问，加可选字段不破坏）

- [ ] **Step 5: 提交**

```bash
git add apps/client
git commit -m "feat(client): 推送 12007 走 CLIENT_ACTION 表并显示「当前无匹配的玩家」；notice 带 code/source"
```

---

## Task 9: conformance（新片 slice-13 + slice-11 扩展 + 登记）

**Files:**
- Create: `tools/conformance/src/slices/slice-13-ai-rollout.ts`
- Modify: `tools/conformance/src/slices/slice-11-robot-system.ts`（`runDouZeroContract` 加 J26/J33）
- Modify: `tools/conformance/src/run.ts`（import + CASES）

**Interfaces:**
- Consumes: Task 5 的 `/health` 与 `model` 字段；Task 6 的 `robot.availability`

- [ ] **Step 1: 写片** —— 入口签名**照抄 slice-12**（`run.ts` 的契约是 `run: () => Promise<{passed; skipped?}>`，而片内自己 `new Checks()`）：

```ts
import { Checks, info, step } from '../lib/assert';      // ← 同 slice-12:36

export async function runSlice13(): Promise<Checks> {
  const checks = new Checks();
  // …六组（下面逐组给断言；所有容器命令都要 MSYS_NO_PATHCONV=1，见 T5 Step 2 的实测）

  // 组① J11 并发（**容器内 vantage**）：
  //   docker exec -i ftl-douzero python - <<'PY' … 同一进程内先量串行基线（10 次取 p50）+ 20 路并发 …
  //   断言：20/20 成功、0 连接重置、p50_conc ≤ 60 × p50_serial
  //   ⚠️ 复现命令与读数写进 docs/superpowers/plans/ 的留档（**不放** .superpowers/ —— 那里被 gitignore）
  checks.that(ok === 20 && resets === 0, 'J11：20 路并发全成功且 0 连接重置');
  checks.that(p50Conc <= 60 * p50Serial, `J11：并发/串行比值 ${(p50Conc / p50Serial).toFixed(1)}× ≤ 60`);

  // 组② J12：未知 model ⇒ 400；正对照 'douzero_WP' ⇒ 200
  //   （片内自带夹具与 raw 请求助手 —— slice-11 的 `askDouZero` 是**本地函数**且只回 action，
  //     这里要 status ⇒ 写一个返回 { status, body } 的 `askRaw(body)`）
  checks.eq((await askRaw({ ...FIXTURE, model: 'nope' })).status, 400, 'J12：未知 model ⇒ 400');
  checks.eq((await askRaw({ ...FIXTURE, model: 'douzero_WP' })).status, 200, 'J12 正对照：已知 model ⇒ 200');

  // 组③ J13：只读挂载空目录 ⇒ 容器仍 Running、/health 报 missing、该档 503、
  //   Dockerfile 的 HEALTHCHECK 原命令退出码 0（等待要有上界）
  // 组④ J32：宿主预拷 8 个、只缺 1 个 ⇒ 补下 + 加载 + /health 齐备（可写挂载）
  //   ⚠️ **需要网**：容器连不上 HF 时**必须** `checks.skip('J32：容器无外网，未验')`，
  //      绝不许把「没验」写成 ok（lib/assert.ts:57-66 的纪律逐字如此）
  // 组⑤ J22：ON 那半打**常驻**栈的 ROBOT_RPC ⇒ canProvide:true；
  //   OFF 那半起一只一次性容器（-e ROBOT_RULE_FALLBACK=false -e DOUZERO_URL=http://127.0.0.1:9
  //   -e RPC_PORT=3199 + 显式发布 3199，⚠️ docker compose run 不发布端口）⇒ canProvide:false
  //   带「3199 未被占用」前提断言 + 后置残留断言
  // 组⑥ J4 的 conformance 那半：非法 env ⇒ 退出码 = 1 **且 stderr 含 logger.error 那行**
  //   （Node 未捕获异常的退出码**也是 1** ⇒ 只看退出码分不出干净退出与裸栈）
  return checks;
}
```

（`FIXTURE` 与 `askRaw` 都**写在片内**：前者就是判别局面那个 body，后者用 `fetch` 打 `${DOUZERO_URL}`（`lib/http.ts:140` 已有该常量），返回 `{ status, body }`。）

- [ ] **Step 2: 跑片确认红/绿** —— `pnpm --filter @fight-the-landlord/conformance build && node tools/conformance/dist/run.js slice-13-ai-rollout`（**先重建容器**）

- [ ] **Step 3: 扩 slice-11（两处）**

① `runDouZeroContract`（`:1163-1198`）在 `:1192` 之后插 J26（`/health` 三档齐备、**每档恰好 `landlord`/`landlord_down`/`landlord_up` 三个名字**）与 J33（不带 `model` ≡ `douzero_WP`，用判别局面 `sl=[4] / WP=[3] / ADP=[5]`）。

② `runIdempotentAcquire`（`:929-1084`，现有断言在 `:1006-1008`）**补一条 `skillLevel` 断言**（规格 §4.1 要求；它是 J5c 的旁证，判别力≈60%，主判据在 T3）：

```ts
  checks.eq(bot2.skillLevel, bot1.skillLevel, '幂等命中 ⇒ 难度不变（片② D2）');
```

- [ ] **Step 4: 登记** —— `run.ts` 的 import 区加 `import { runSlice13 } from './slices/slice-13-ai-rollout';`，`CASES` 加 `'slice-13-ai-rollout': { title: '机器人 AI 全量化（并发/模型契约/缺模型）', run: runSlice13 },`。

- [ ] **Step 5: 提交**

```bash
git add tools/conformance
git commit -m "test(conformance): 新片 slice-13（并发/模型契约/缺模型）+ slice-11 扩 /health 清单与默认档等价"
```

---

## Task 10: 机械闸（源码级 + 文档级）

**Files:**
- Create: `packages/protocol/src/robot-availability-wiring.gate.test.ts`（J21 —— ⚠️ 放 **`src/`**：protocol **没有 `test/` 目录**，它的测试与源码同目录，`lint` 是裸 `tsc --noEmit`（include `src/**/*`））
- Create: `packages/robot-service/test/no-switch-in-decision.gate.test.ts`（J29）
- Create: `packages/room-service/test/no-gate-outside-match.gate.test.ts`（J30）
- Create: `packages/shared/test/design-md-ai-rollout.gate.test.ts`（J18①②③）
- Create: `packages/shared/test/douzero-dockerfile.gate.test.ts`（J31）
- Modify: `packages/room-service/test/no-internal-http.gate.test.ts`（J19 的三件事）

**Interfaces:** 无（纯判据）

⚠️ **所有闸都要自己造助手**（`readAll`/`matchMessagePatterns`/`source`/`sectionOf` **都不存在**）：照 `packages/room-service/test/no-internal-http.gate.test.ts:42-58` 的 `findRepoRoot()`（向上找锚点、找不到抛错）与 `packages/shared/test/no-legacy-message-names.gate.test.ts` 的读文件范式写。**扫源码前必须先剥注释**（本仓成例：`stripComments`）—— 否则 `game.controller.ts:58/141/157`、`robot.controller.ts:10`、`game.service.ts:259`、`protocol/src/rpc.ts:5/36/38` 等**注释里的** `@MessagePattern` 会被误算。

🔴 **顺序**：J18 的三条闸在 T11 完成前**必然红**（`docs/design.md` 还没改）⇒ 本任务的 J18 **只写闸、记红**，T11 做完后**复核转绿**（两者是环，执行者按「写闸 → T11 → 复核」的顺序做，别在 T10 里越权改文档）。

- [ ] **Step 1–4: 逐个写闸并在真代码上跑绿**（每条都要**先喂一个违规样本确认会红**）：

```ts
// J21：每个 RPC_PATTERNS 都有接收侧 @MessagePattern，且承载类被某模块 controllers: 提及
const PATTERNS = Object.keys(RPC_PATTERNS);
const declared = new Set(readAll('packages/*/src/**/*.ts').flatMap(matchMessagePatterns));
expect(declared).toEqual(new Set(PATTERNS));
// + 扫 *.module.ts 的 controllers: [...] 收集类名，断言每个承载 @MessagePattern 的类都在其中
```

```ts
// J29：决策侧不得读开关
expect(source('packages/robot-service/src/robot/bot.player.ts')).not.toMatch(/ROBOT_RULE_FALLBACK|getRobotConfig/);
```

```ts
// J30：好友房/自动开局的补位链不得读门禁
for (const f of ['packages/room-service/src/rooms/rooms.start.ts', 'packages/room-service/src/rooms/rooms.autostart.ts']) {
  expect(source(f)).not.toMatch(/availability/);
}
```

```ts
// J18：design.md 的 §9.3 切片内 errorRate 零命中；两个新 env 出现在 §2.3；三个模型字面量在 §9.3
const slice = sectionOf(designMd, '### 9.3', /^### |^## /);
expect(slice).not.toMatch(/errorRate/);
expect(slice).toMatch(/sl/); expect(slice).toMatch(/douzero_WP/); expect(slice).toMatch(/douzero_ADP/);
const env = sectionOf(designMd, '### 2.3', /^### |^## /);
for (const name of ['ROBOT_RULE_FALLBACK', 'ROBOT_SKILL_DISTRIBUTION', 'ROBOT_RECLAIM_INTERVAL_MS']) {
  expect(env).toContain(name);
}
```

```ts
// J31：Dockerfile 的 test -f 在最后一 stage 的 COPY --from=builder /app/models 之后
const stages = dockerfile.split(/^FROM /m);
const last = stages[stages.length - 1];
expect(last).toMatch(/COPY --from=builder \/app\/models/);
expect(last.indexOf('test -f /app/models/sl/landlord.onnx')).toBeGreaterThan(last.indexOf('COPY --from=builder /app/models'));
```

```ts
// J28：RPC 超时 2s 必须 > 探测超时 1s（v7 那个 P0 值的机械守卫）
const rpc = source('packages/room-service/src/gateway/robot.client.ts');
const probe = source('packages/robot-service/src/robot/douzero.health.ts');
const num = (s: string, re: RegExp) => Number(re.exec(s)![1]);
expect(num(rpc, /ROBOT_AVAILABILITY_TIMEOUT_MS = (\d+)/)).toBeGreaterThan(num(probe, /PROBE_TIMEOUT_MS = (\d+)/));
```

- [ ] **Step 5: 提交**

```bash
git add packages
git commit -m "test: 五条机械闸（J18/J21/J29/J30/J31）+ J19 的三件事"
```

**J19 的三件事（写在 `no-internal-http.gate.test.ts` 里）**：

1. `RPC_USAGE`（`:64-65` 那个 8 选 1 正则）**加 `robotAvailability`** —— 并配**负对照**：`expect(RPC_USAGE.test("send('robot.availability', …)")).toBe(false)`（⚠️ 只加名字不配负对照＝无效补丁，该闸是「每文件至少一处 pattern 用法」的正向判据）。
2. 两张文件清单（`RPC_CLIENTS` `:74-80` / `ROOM_CALL_SITES` `:86-91`）**核对即可、无需增行**：新 `availability()` 落在既有 `gateway/robot.client.ts`（已在两张清单内）⇒ 加一条断言把这个事实钉住（若将来有人把它挪到新文件，闸应红）。
3. `RPC_PATTERNS` 恰好 9 键由 T1 的 `messages.test.ts` 覆盖（本任务不重复）。

---

## Task 11: 文档（design.md 20 行 + 交接勘误 + 手册）

**Files:**
- Modify: `docs/design.md`（按下面这 **20 行**逐条；它们是设计层 §6 表体 21 行里**指向 `docs/design.md`** 的那些）
- Modify: `docs/superpowers/plans/2026-09-30-ai-rollout-handoff.md`（§3.1 **原地勘误**：265ms / 3.8 决策每秒 / ~18 三个数全不成立，指向设计层 §2）
- Modify: `docs/ops/first-deploy.md`（两个新 env；「开关 OFF 的后果」：DouZero 不可用时玩家会在第 30s 收到 12007）

**T11 的 20 行清单（逐条勾）**：

| # | 节 | 改什么 |
|---|---|---|
| 1 | §9.3 三档表 | 三档 = 三个模型；删 `errorRate` 列 |
| 2 | §2.3 环境变量表 | + `ROBOT_RULE_FALLBACK`、`ROBOT_SKILL_DISTRIBUTION` |
| 3 | §4.2 末尾 | 「八个」⇒ 九个 pattern |
| 4 | §3.4 BotInstance | 「七字段」**仍是 7**（`errorRate` 是 `personality` 子字段）⇒ 只改行号与 `personality` 形状 |
| 5 | §4.3 降级表 | 补「受开关约束的只有补位」；`douzero` 行补 `model` 选择 |
| 6 | §8.4 回退顺序 | 补「开关 OFF + DouZero 不可用 ⇒ 第 30s 直接走 ③」 |
| 7 | §8.5 | 补可用性门禁与 fail-open |
| 8 | §9.6 填充 | 补「难度在 `acquire` 的**新绑定**上抽取」 |
| 9 | §2.1 douzero 行 | 补「9 个 ONNX（3 档 × 3 位置）」 |
| 10 | §11 错误码 | 表不动；附近注一句「玩家可见文案在客户端文案表」 |
| 11 | 🔴 §9.3 默认比例数值 | `0.5/0.35/0.15` ⇒ **`0.15/0.35/0.5`**；删「硬编码」与「后续由游戏配置下发」 |
| 12 | 🔴 §9.3 的 `[已实现]` 注记行 | 清掉那 **1 处** `errorRate` + 同步行号（**否则 J18① 必红**） |
| 13 | 🔴 §9.3 表格内容 | 表里必须出现 `sl`/`douzero_WP`/`douzero_ADP`（**否则 J18③ 必红**） |
| 14 | §4.3「其它五行」 | 新增 availability 行后是**六行** |
| 15 | 附录 A.1 第 8a 行 | 订正「双轨」（A.1 无历史快照免责块） |
| 16 | §4.1 robot→douzero 行 | 补 `GET /health` 探测（1s，失败视为不可用） |
| 17 | §9.3 标题 | 去掉「（双轨）」 |
| 18 | §8.2 成局流程 | 补门禁判定与「不能给 ⇒ 判失败 12007」 |
| 19 | §14.3 | 订正「机器人双轨 AI」 |
| 20 | §2.3 | 补 `ROBOT_RECLAIM_INTERVAL_MS`（独立文档欠账） |

- [ ] **Step 1–3**: 逐行改（每改一行跑一次 J18 的闸确认没把切片弄红）；交接文档的勘误段写明三个数（265ms / 3.8 决策每秒 / ~18）全不成立并指向设计层 §2。
- [ ] **Step 4: 提交**

```bash
git add docs
git commit -m "docs: 片② 对 design.md 的 20 行修订 + 交接 §3.1 勘误 + 部署手册补两个 env"
```

---

## Task 12: 全量验收与收口

- [ ] **Step 1: 门禁** —— `pnpm run ci`（六阶段）⇒ exit 0
- [ ] **Step 2: conformance（18 片）** —— **先重建容器**（`docker compose build douzero && docker compose up -d --force-recreate douzero`），再**逐片**跑（`run.js full` 不是合法用例 —— 只认 `CASES` 的键）：

```bash
pnpm --filter @fight-the-landlord/conformance build
for c in $(node tools/conformance/dist/run.js --list); do node tools/conformance/dist/run.js "$c" || fail=1; done
```
- [ ] **Step 3: 真浏览器探针**（与 conformance 不同时跑）—— ⚠️ Windows 上必须绕三处坑（memory 已记）：

```bash
CHROME_BIN="<本机 chrome 路径>" node scripts/browser-e2e.mjs --scenario full --no-server --cdp-port 18800
```
- [ ] **Step 4: 基线闸** —— 确认 `slice-13` 在 `baselines.json` 里**由 CI 回填**（本机跳过 14 条断言）
- [ ] **Step 5: 部署与回滚（规格 §6，**上线环节，CI 补不回来**）** —— ① 7 镜像 pull/up；② **douzero 先起**（game/robot 的 `depends_on: service_healthy` 会等它）；③ 起完立即验 `/health` 三档齐备；④ **回滚只能用「拉旧 tag 的镜像」**，不得用当前检出重建旧 tag（新 `server.py` + 新布局配旧 tag 会自己骗自己）
- [ ] **Step 6: 如实登记未验项** —— 至少：`新 robot-service + 旧 douzero` 组合（CI 无旧镜像，**只能靠推理**）、R7（`sl` 强度未实测）、R8（门禁失败不累积 attempts）、R6（+35MB）。口径：记「**未执行**」，**不得**写「通过」
- [ ] **Step 7: 整支终审 + 收口轮** —— 派 reviewer 做整支审查；按结果修复；更新设计层/规格层的「已收尾」节与执行账本；`git merge --ff-only` 回 master（**问用户**后再做）
