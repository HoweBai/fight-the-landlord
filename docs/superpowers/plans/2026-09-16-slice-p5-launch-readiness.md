# 独立小片 P5 实施计划：上线准备收口（§2.4 健康检查 · §13.3 覆盖率门槛 · §13.4 CI 流水线 · §12.4 闸形态 · N23 死代码）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/design.md` §14.4（P3 — 上线准备）的 DoD 真正做成**可执行且会失败**的东西：`/api/health` 返回 §2.4 要求的 `checks` 并区分**存活/就绪**；`packages/shared` 的**行覆盖率门槛 ≥80% 写进配置且低于门槛会失败**（命令迄今从未跑过）；一条**六阶段 CI 流水线**（`scripts/ci.sh` + GitHub Actions）把 lint/build/test/coverage/§12.4 违禁扫描串起来；并就 §12.4 的**落地形态**给出裁决；顺手删掉 `rule/beat.ts` 的死代码（新登记 **N23**）。

**Architecture:** 本片**不动分层**，只补「上线准备」缺的那几块**可执行的门槛**。两个设计取舍：① **健康检查不新建连接** —— 每个服务用它**已有的** Redis/DataSource 依赖，避免出现第二个连接源（本仓已有「同一事实两个真源」的多次前科）；② **CI 的门面是可本地执行的脚本** —— 本仓没有可验证的远端 CI 环境，因此把「六阶段」写进 `scripts/ci.sh`（**在门禁里真的能跑**），GitHub Actions 只做一层薄调用；把不可验证的东西降到最小。

**Tech Stack:** TypeScript / NestJS 10 / ioredis / TypeORM 0.3 / Vitest 2 + `@vitest/coverage-v8` / pnpm workspace + Turborepo / Docker Compose / GitHub Actions

**Spec:**
- `docs/design.md` —— **§2.4（健康检查，逐字）· §12.2/§12.4（FORBIDDEN 清单与违规检测）· §13.3（覆盖率门槛 ≥80%）· §13.4（CI 六阶段，逐字）· §14.4（P3 上线准备的交付与 DoD）**
- `docs/superpowers/plans/deviation-ledger.md` —— §1.2 的 E1–E10（全关）、§2 的 P3/P4 小节、§3「文档待更新」
- `docs/superpowers/plans/agent-briefs.md` —— 「已知环境事实」+「切片 P3/P4 新增的通用教训」（尤其：**判据不要钉实现形态**、**判别力必须自证**、**「跑绿已有测试」不等于缺陷被覆盖**）
- **本片的来由（协调者 2026-09-16 逐节核对代码时发现）**：这三项**都不在 A.2 偏差表里、也没有任何台账编号** ⇒ 对账表的「74/75 已关闭」**不等于** design.md 全部落地。本片把它们补上并**编号入账**。

---

## Global Constraints

逐字照抄 `2026-09-13-parallel-dev.md`（端口 / Vitest / `Transport.TCP` + `@MessagePattern` / 对外 REST 与内部 RPC 不共用方法 / socket.io ack / `baseVersion` CAS + `13004` / 5 位数字错误码 / 身份只从网关注入 / 裁剪 / 牌值编码 / 前端哑终端 / `packages/protocol` 协调者独占）。

### 本切片的绑定数值（逐字，来自 `design.md`）

| 项 | 值 |
|---|---|
| `GET /api/health` 响应体（§2.4） | `{ "status": "ok", "service": "game-service", "checks": { "redis": "up", "mysql": "up" } }` |
| `status`（§2.4） | `ok` \| `degraded` |
| HTTP 状态码（§2.4） | `ok` → **200**，`degraded` → **503** |
| 覆盖率门槛（§13.3） | **`packages/shared` 行覆盖率 ≥ 80%**；其余包不设硬门槛，但新增业务逻辑必须带测试 |
| 覆盖率命令（§13.3） | `pnpm --filter @fight-the-landlord/shared test -- --coverage` |
| CI 六阶段（§13.4） | `1 install · 2 lint (tsc --noEmit，全包) · 3 build (turbo run build) · 4 test (turbo run test) · 5 coverage (shared ≥ 80%，低于门槛失败) · 6 eslint-forbidden (§12.4，发现 FORBIDDEN 即阻断)` |
| §12.4 的 FORBIDDEN 面 | F01/F02/F10（牌型判定/强度比较/倍数计算）+ M09（游戏规则常量）+ 机器人身份不外泄 |
| §14.4 的 DoD（逐字） | `pnpm test && pnpm lint`；`pnpm --filter @fight-the-landlord/shared test -- --coverage` **≥ 80%**；`docker compose up -d && docker compose ps` **8 个容器全部 healthy** |

### 协调者已实测的两条前置事实（**本片据此缩小了范围**）

1. **`packages/shared` 行覆盖率 = 93.94%**（实测，`@vitest/coverage-v8` 已装）⇒ §13.3 的 80% **本来就已满足**，本片要做的不是补测试，而是**把门槛写进配置并接进 CI**（让它**会失败**）。
2. **全仓无任何 CI 配置**（只有 compose/pnpm 的 yaml）⇒ §13.4 是**从零建**。

---

## 协调者裁决（本片新增，执行时不得再自行解释）

> 编号接 P3 的 **R266**，从 **R267** 起。**派工前先划定区间**：**后端 agent 用 R280–R299**，**conformance agent 用 R300–R319**，协调者保留 **R267–R279**。

- **R267 健康检查的形态：`/api/health` = **就绪**（含 `checks` + 可为 503），另加 `/api/health/live` = **存活**（恒 200）。**
  §2.4 只定义了 `GET /api/health`（`ok`→200 / `degraded`→503），**没有**要求两个端点；而「未区分存活/就绪」是审计记下的缺口。裁决：
  - `GET /api/health` —— **就绪**：真查依赖，任一 `down` ⇒ `status:'degraded'` + **503**（compose 的 healthcheck 继续用它，语义变成「可服务」）；
  - `GET /api/health/live` —— **存活**：**不查任何依赖**，只要进程能响应就 **200** `{status:'ok', service}`。
  **理由**：若只有就绪面，Redis 一抖容器就 `unhealthy`；而**存活探针不该因为下游抖动而失败**（那会让编排层去杀一个完全健康的进程）。两者分开后，`unhealthy` 才真正表示「不该接流量」。
  ⚠️ **不新建连接**：每个服务用它**已有的**依赖 —— `room-service`/`robot-service` 用 `RedisProviderModule` 的 `Redis` token；`user-service` 用它自己的 `RedisModule` provider + TypeORM 的 `DataSource`；`api-gateway`/`game-service` 用它们各自**已有**的客户端形态（`game-service` 的客户端今天在 `GameService` 内部，执行时把它提成一个可注入的 provider 或让健康检查复用同一个实例 —— **不得**为健康检查再 `new Redis()`）。
  ⚠️ **checks 只报自己真的依赖的**：`user-service` = `{redis, mysql}`；`room-service`/`game-service`/`robot-service`/`api-gateway` = `{redis}`。**不得**为了「看起来齐全」而报一个自己并不依赖的 `mysql: 'up'`（那是假信息）。
  ⚠️ 检查实现**逐服务各一份**（沿用 R23 的既有惯例：**不**把 Nest 代码塞进 `shared`/`protocol`，也**不**新建 workspace 包）；但**形状与文案必须逐字一致**（由 conformance 的在线判据与一条源码闸钉住，见 Task 5）。

- **R268 §12.4 的落地形态：以**既有的 vitest 源码闸**为准，CI 第 6 阶段运行它；**不**照搬规格里的 ESLint 插件形态。**
  规格 §13.4 写的是 `eslint-forbidden`（插件名 `eslint-plugin-zero-business-logic`，三条规则）。**事实**：该插件名来自**参考文档**；本仓既有的落地形态是 `apps/client/test/source-boundary.test.ts`（8 条用例，覆盖 F01/F02/F10 + M09，且**带「扫描器确实读到了文件」的自证**）。
  裁决：**以既有闸为准**，理由与 **R150/R225** 同族 —— **判据要钉「违规被拦住」这个性质，不是钉 `ESLint` 这个形态**；再写一个插件等于为同一性质造**第二个真源**（而本仓为「第二真源」付过多次代价）。
  落地：`scripts/ci.sh` 的第 6 阶段 = 跑 `apps/client` 的 `source-boundary`（+ 既有的 `no-internal-http.gate` / `outbound-timeout.gate` / `no-route-outside-api.gate` / `rule-error-mapping` 等**源码级闸**，它们同属「FORBIDDEN 必须被机械拦住」）；`docs/design.md` §12.4/§13.4 按 §A.3 **改写**掉「必须用该 ESLint 插件」的表述，写明**实际形态**与**为什么不照搬**。

- **R269 CI 的门面是**可本地执行的脚本**：`scripts/ci.sh` 六阶段逐字照 §13.4（阶段名与顺序一致），`.github/workflows/ci.yml` 只做薄调用。**
  **理由**：本仓**没有可验证的远端 CI**（无 `.github/workflows`、也无远端）。把「六阶段」写成**脚本**，它就能在门禁里**真的跑一遍**（可验证）；Actions 只承担「在远端把它跑起来」，属于**不可在本地验证**的最小面。
  ⚠️ 脚本必须**失败即非零退出**（`set -euo pipefail`），且**每个阶段都要能被单独观测**（打印阶段名 + 耗时），否则「六阶段都跑过了」无法从输出判读。

- **R270 覆盖率门槛必须**会失败**：`packages/shared/vitest.config.ts` 配 `test.coverage.thresholds.lines = 80`（+ `include: ['src/**']`、`reporter: ['text']`），并在 `packages/shared/package.json` 加 `test:coverage` 脚本。**
  ⚠️ **判据**：把 `lines` 临时抬到 `99` 必须让 `test:coverage` **红**（`ERROR: Coverage for lines (93.94%) does not meet threshold (99%)` 一类原文），改回 80 必须绿 —— **不证明「它会失败」就等于没有门槛**（本仓的门槛类判据已经翻车过两次：`allFilesStillHttp` 恒绿、`NOT_YET_MIGRATED` 恒绿）。
  ⚠️ `include` 必须是 `src/**` 而不是默认（默认会把只被 `export *` 的入口与测试夹带进来）；**不测的文件**（如纯 re-export 的 `src/index.ts`）用 `coverage.exclude` 显式列出并**在注释里写明理由** —— 不要靠调阈值来掩盖。

- **R271 `rule/beat.ts` 的 `canBeatWithHand` 是**死代码**（实测 0% 行覆盖率，全仓无生产调用点）⇒ 删除，并登记为 **N23**。**
  **事实**：它只被 `shared/index.ts` 的 `export *` 带出；真正的比较走 `rule.ts` 的 `canBeat`。它同时是**「同一事实的第二实现」**（本仓反复出现的模式）。
  裁决：**删除**（YAGNI + 消灭第二实现）。⚠️ 删之前必须**实证无调用点**（`grep -rn "canBeatWithHand"` 覆盖 `packages/**/src` 与 `apps/**`），并把 grep 原文贴进汇报；**不得**只因为「覆盖率 0%」就删（覆盖率是线索，不是证据）。

---

## 执行模型（与切片 5–11 / P3 / P4 相同）

| 角色 | 工作区 | 拥有本片的哪些任务 |
|------|--------|------------------|
| **协调者** | `/home/howe/pokergame`（master） | **Task 0（派工前：`@vitest/coverage-v8` 依赖落盘）**、评审、合并、门禁、`docs/**` 收口（§12.4/§13.4/§2.4 注记 + 台账 N23/N24 + §0 重算） |
| **后端 agent** | `.worktrees/backend`（`feat/backend`） | **Task 1–4**（§2.4 健康检查 · §13.3 门槛 · §13.4 CI · N23 删死代码）。编号区间 **R280–R299** |
| **conformance agent** | `/home/howe/pokergame`（主检出，`tools/conformance/**`） | **Task 5**（在线判据 + 三处「会失败」的自证）。编号区间 **R300–R319** |
| 前端 | —— | **本片无前端改动**（§12.4 的闸已存在于 `apps/client/test/`，只被 CI 调用，不新增用例） |

**开工前固定动作（两个 agent 都逐字执行）**：

```bash
# 后端 agent
cd /home/howe/pokergame/.worktrees/backend
pwd && git branch --show-current          # 必须输出 feat/backend
git merge master --no-edit                # 协调者已把 Task 0 与本计划推到 master
CI=true pnpm install --store-dir .pnpm-store   # ⚠️ 必须带 --store-dir（工作区外的 ~/.pnpm-store 会被沙箱拒绝）
pnpm exec turbo run build --force

# conformance agent（主检出，master）
cd /home/howe/pokergame
pwd && git branch --show-current          # 必须是 master
pnpm exec turbo run build --force         # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
```

**⚠️ conformance 必须独占跑**（网关按 IP 计并发 WS 连接、上限 5）；跑任何切片期间其他人不得重建/重启容器。

**汇报格式**（统一，逐条对应 DoD 并附**实际命令与输出**）：完成情况 / 改动清单（文件 + 一句话 + commit sha）/ 阻塞未完成 / 需要协调者裁决的事项 / 我发现的文档未记录的问题。

---

## File Structure

```
packages/shared/package.json                       Modify: `test:coverage` 脚本（Task 2，协调者已加依赖）
packages/shared/vitest.config.ts                   Modify: coverage.include / thresholds.lines: 80 / exclude + 理由（R270）
packages/shared/src/rule/beat.ts                   **Delete**: `canBeatWithHand` 死代码（N23/R271）
packages/shared/src/index.ts                       Modify: 去掉 `export * from './rule/beat'`（N23）

packages/api-gateway/src/health/health.controller.ts        Modify: checks + live（R267）
packages/api-gateway/src/health/health.service.ts           Create: 依赖探测的唯一实现（R267）
packages/user-service/src/health/health.{controller,service}.ts   Modify/Create: {redis, mysql}
packages/room-service/src/health/health.{controller,service}.ts   Modify/Create: {redis}
packages/game-service/src/health/health.{controller,service}.ts   Modify/Create: {redis}
packages/robot-service/src/health/health.{controller,service}.ts  Modify/Create: {redis}
packages/*/test/health.test.ts                     Create/Modify: checks 形状 + 503 + live 恒 200（每个服务一份）

scripts/ci.sh                                      Create: §13.4 六阶段（R269）
package.json                                       Modify: `"ci": "bash scripts/ci.sh"` 脚本
.github/workflows/ci.yml                           Create: 薄调用 scripts/ci.sh（R269）

tools/conformance/src/slices/slice-07.2-deploy.ts  Modify: §2.4 健康检查的在线判据（Task 5；与既有 prod/runtime 步骤并列）
tools/conformance/src/slices/slice-07.2-hardening.ts Modify: 「CI 第 6 阶段真的会拦住」的判据（Task 5）
docs/design.md                                     Modify: §2.4/§12.4/§13.3/§13.4 注记（协调者收口）
docs/superpowers/plans/deviation-ledger.md          Modify: 新增 N23（死代码）/N24（CI+覆盖率门槛）/N25（健康检查）并**同片关闭** + §0 重算
docs/superpowers/plans/agent-briefs.md             Modify: 门禁实测 + 教训（协调者）
```

---

## Task 0（协调者，**已完成**）：`@vitest/coverage-v8` 依赖落盘

**Files:** Modify `packages/shared/package.json`、`pnpm-lock.yaml`

- [x] **Step 1: 加依赖**（`@vitest/coverage-v8@^2.1.0`，与 `vitest` 同版本线）—— 已完成，diff 只新增该包及其传递依赖，**未动任何已有条目**
- [x] **Step 2: 实测覆盖率并留档**（**这是本片范围的依据**）

```bash
cd packages/shared && npx vitest run --coverage --coverage.include='src/**' --coverage.reporter=text
# ✅ 171 passed · All files 93.94% lines（≥ 80%）
# ⚠️ 顺带发现：src/rule/beat.ts = 0%（死代码，→ N23）；src/index.ts = 0%（纯 re-export）
```
- [x] **Step 3: 提交**（`chore(shared): 加 @vitest/coverage-v8 —— §13.3 的门槛命令此前在本机无法执行`）

---

## Task 1: §2.4 健康检查 —— `checks` + 存活/就绪（R267）

**Files:** 五个服务的 `src/health/health.service.ts`（Create）+ `health.controller.ts`（Modify）+ `test/health.test.ts`（Create/Modify）

**Interfaces:**
- Consumes: 各服务**已有的** Redis provider / `DataSource`（见 R267；**不得新建连接**）
- Produces: `HealthService.check(): Promise<{status:'ok'|'degraded'; service:string; checks:Record<string,'up'|'down'>}>`；`GET /api/health`（就绪，200/503）与 `GET /api/health/live`（存活，恒 200）

- [ ] **Step 1: 写失败测试**（每个服务一份；下面是 `room-service` 的形态，其余同形但只报自己真的依赖的东西）
```ts
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health/health.controller';
import { HealthService } from '../src/health/health.service';

const build = async (ping: () => Promise<string>) => {
  const mod = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: HealthService, useValue: {
      check: async () => {
        try { await ping(); return { status: 'ok', service: 'room-service', checks: { redis: 'up' } }; }
        catch { return { status: 'degraded', service: 'room-service', checks: { redis: 'down' } }; }
      },
      live: () => ({ status: 'ok', service: 'room-service' }),
    } }],
  }).compile();
  return mod.get(HealthController);
};

describe('§2.4 健康检查（R267）', () => {
  it('就绪：依赖正常 ⇒ status=ok + checks.redis=up；HTTP 200', async () => {
    const c = await build(async () => 'PONG');
    expect(await c.check()).toEqual({ status: 'ok', service: 'room-service', checks: { redis: 'up' } });
  });

  it('就绪：依赖不可用 ⇒ status=degraded + checks.redis=down（HTTP 状态由控制器保证 503）', async () => {
    const c = await build(async () => { throw new Error('redis down'); });
    expect(await c.check()).toEqual({ status: 'degraded', service: 'room-service', checks: { redis: 'down' } });
  });

  it('存活：**不查依赖**，恒 200（正对照：把 Redis 打断也不影响它）', async () => {
    const c = await build(async () => { throw new Error('redis down'); });
    expect(await c.live()).toEqual({ status: 'ok', service: 'room-service' });
  });
});
```
- [ ] **Step 2: 跑测确认失败** → `Cannot find module '../src/health/health.service'`
- [ ] **Step 3: 实现**
```ts
// packages/room-service/src/health/health.service.ts（形状与文案**五个服务逐字一致**，只有依赖清单不同）
import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/** §2.4：`checks` 的取值只有这两个字面量。 */
export type CheckState = 'up' | 'down';
export interface HealthBody { status: 'ok' | 'degraded'; service: string; checks: Record<string, CheckState>; }

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  /** ⚠️ 注入本服务**已有**的 Redis（R267：不得为健康检查新建连接）。 */
  constructor(private readonly redis: Redis) {}

  /** 存活：**不查任何依赖** —— 下游抖动不该让编排层去杀一个健康的进程。 */
  live(): HealthBody { return { status: 'ok', service: 'room-service', checks: {} }; }

  /** 就绪：真查依赖；任一 `down` ⇒ `degraded`（控制器据此返 503）。 */
  async check(): Promise<HealthBody> {
    const checks: Record<string, CheckState> = {};
    checks.redis = (await this.probe('redis', () => this.redis.ping())) ? 'up' : 'down';
    const status = Object.values(checks).every((c) => c === 'up') ? 'ok' : 'degraded';
    return { status, service: 'room-service', checks };
  }

  /** 探测的唯一入口：**吞掉异常并记日志**（健康检查自己绝不能抛 —— 那会变成 500 而不是 503）。 */
  private async probe(name: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return true; }
    catch (err) { this.logger.warn(`health check ${name} failed: ${err instanceof Error ? err.message : String(err)}`); return false; }
  }
}
```
```ts
// health.controller.ts：⚠️ `live()` 必须显式 200；`check()` 必须**按 status 设码**
import { Controller, Get, HttpCode, Res } from '@nestjs/common';
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')            // ⚠️ 在 `@Get()` **之前**声明，避免被参数化路由吃掉
  @HttpCode(200)
  live() { return this.health.live(); }

  @Get()
  async check(@Res({ passthrough: true }) res: { status: (c: number) => void }) {
    const body = await this.health.check();
    res.status(body.status === 'ok' ? 200 : 503);   // §2.4：ok→200 / degraded→503
    return body;
  }
}
```
  ⚠️ **`user-service` 的 `checks` 是 `{redis, mysql}`**（`DataSource.query('SELECT 1')`）；其余四个是 `{redis}`。
  ⚠️ `game-service` 的 Redis 今天在 `GameService` 内部 `new Redis()` ⇒ 执行期把它提成一个 provider（`RedisProviderModule` 同款）并让 `GameService` 注入，**不得**为健康检查再建一个连接。**这条改动要记执行期裁决。**
  ⚠️ `api-gateway` 的限流 Redis 已是 provider（`app.module.ts`）⇒ 直接注入它。
- [ ] **Step 4: 跑绿 + 容器验证**（改动涉及 5 个服务的启动路径 ⇒ **必须**重建并确认 healthy，别只看单测）
```bash
pnpm exec turbo run test lint --force
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d && sleep 25
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s -o /dev/null -w '%{http_code} ' localhost:$p/api/health; curl -s localhost:$p/api/health; echo; done
# ✅ 每个都必须含 checks；:3001 的 checks 必须是 {redis,mysql}
curl -s localhost:3002/api/health/live   # ✅ 恒 200 且 checks 为空
```
- [ ] **Step 5: 提交**（`feat(health): §2.4 的 checks + 存活/就绪分离（五个服务）（R267）`）

---

## Task 2: §13.3 覆盖率门槛 —— 让它**会失败**（R270）

**Files:** Modify `packages/shared/vitest.config.ts`、`packages/shared/package.json`

- [ ] **Step 1: 先取「门槛会失败」的 RED**（**这条判据的核心是「会失败」，所以先证明它会**）
```bash
cd packages/shared
npx vitest run --coverage --coverage.include='src/**' --coverage.thresholds.lines=99 2>&1 | tail -5
# ✅ 期望红：`ERROR: Coverage for lines (93.94%) does not meet global threshold (99%)`（原文贴进汇报）
```
- [ ] **Step 2: 实现**
```ts
// packages/shared/vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // 纯 re-export 的入口不计（它没有可执行逻辑）；**其余一律计入**。
      // ⚠️ 不要靠调阈值掩盖未测文件 —— 要排除就写在这里并给出理由。
      exclude: ['src/index.ts'],
      reporter: ['text'],
      // §13.3：**行覆盖率 ≥ 80%**，低于门槛**必须失败**（R270）。
      thresholds: { lines: 80 },
    },
  },
});
```
```json
// packages/shared/package.json：scripts 里加
"test:coverage": "vitest run --coverage"
```
- [ ] **Step 3: 跑绿 + 反向自证**
```bash
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 93.94% ≥ 80% 通过
# 反向：临时把阈值改 99 ⇒ 必须红（与 Step 1 同形，但走**产品脚本**）；改回 80 ⇒ 绿
```
- [ ] **Step 4: 提交**（`test(shared): §13.3 覆盖率门槛入配置（lines ≥ 80，低于门槛会失败）（R270）`）

---

## Task 3: §13.4 CI 六阶段 —— `scripts/ci.sh` + Actions 薄调用（R269）

**Files:** Create `scripts/ci.sh`、`.github/workflows/ci.yml`；Modify 根 `package.json`

- [ ] **Step 1: 写脚本**（**逐字**照 §13.4 的阶段名与顺序；失败即非零退出；每阶段可观测）
```bash
#!/usr/bin/env bash
# §13.4 的 CI 六阶段（R269）。**逐字**照规格的阶段名与顺序。
# ⚠️ 本脚本是「门槛」的门面：**必须失败即非零退出**，且每阶段都要在输出里可辨认（否则
#    「六个阶段都跑过了」无法从原文判读 —— 本仓已有两次「判据恒绿」的前科）。
set -euo pipefail
cd "$(dirname "$0")/.."

stage() { printf '\n=== [ci] %s ===\n' "$1"; }

stage "1/6 install"
pnpm install --frozen-lockfile

stage "2/6 lint"
pnpm exec turbo run lint --force

stage "3/6 build"
pnpm exec turbo run build --force

stage "4/6 test"
pnpm exec turbo run test --force

stage "5/6 coverage (shared ≥ 80%)"
pnpm --filter @fight-the-landlord/shared test:coverage

stage "6/6 eslint-forbidden (§12.4)"
# R268：本仓的 §12.4 落地形态是 **vitest 源码级闸**（不是 ESLint 插件）——
# 它们同属「FORBIDDEN 必须被机械拦住」这一性质，逐个列出以便从输出判读覆盖面。
pnpm --filter @fight-the-landlord/client test -- source-boundary
pnpm --filter @fight-the-landlord/room-service test -- no-internal-http.gate
pnpm --filter @fight-the-landlord/api-gateway test -- outbound-timeout.gate
pnpm --filter @fight-the-landlord/api-gateway test -- no-route-outside-api.gate
pnpm --filter @fight-the-landlord/game-service test -- rule-error-mapping

printf '\n=== [ci] 六阶段全部通过 ===\n'
```
- [ ] **Step 2: Actions 薄调用**
```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4          # ⚠️ 版本与 package.json 的 packageManager 一致
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: bash scripts/ci.sh             # ← 单一真源：不在 YAML 里重抄六个阶段
```
  ⚠️ **不在 workflow 里重抄六阶段** —— 那是第二个真源；YAML 只负责环境与调用。
- [ ] **Step 3: 加根脚本 + 本地跑通**
```json
// 根 package.json：scripts 里加
"ci": "bash scripts/ci.sh"
```
```bash
timeout 1200 pnpm run ci    # ✅ 六阶段全绿，输出里能看到 1/6…6/6（原文贴进汇报）
```
  ⚠️ 若某条源码闸的 `test` 过滤名与实际文件名不符，以**实际文件名**为准（先 `ls` 再写），并在汇报里说明改了哪一处。
- [ ] **Step 4: 提交**（`ci: §13.4 六阶段脚本 + Actions 薄调用（R269/R268）`）

---

## Task 4: N23 —— 删除 `rule/beat.ts` 的死代码（R271）

**Files:** Delete `packages/shared/src/rule/beat.ts`；Modify `packages/shared/src/index.ts`

- [ ] **Step 1: 先实证无调用点**（**必要前置**；覆盖率 0% 只是线索）
```bash
grep -rn "canBeatWithHand" packages/*/src packages/*/test apps/*/src apps/*/test tools/ | grep -v node_modules
# ✅ 期望：只命中 `shared/src/index.ts` 的 `export * from './rule/beat'`（+ 本计划/文档）
#    ⇒ 无任何**生产调用点**。把 grep 原文贴进汇报。
```
- [ ] **Step 2: 删除**（`rule/beat.ts` + `index.ts` 的那一行 re-export）—— ⚠️ 删后 `shared` 的覆盖率会**上升**（少了一个 0% 文件），这是**预期**，不要读成「测试变多了」。
- [ ] **Step 3: 跑绿 + 覆盖率复核**
```bash
pnpm --filter @fight-the-landlord/shared test:coverage   # ✅ 通过；All files 行覆盖率**上升**
pnpm exec turbo run test lint --force                    # ✅ 29/29
```
- [ ] **Step 4: 提交**（`refactor(shared): 删除 rule/beat.ts 的 canBeatWithHand 死代码（N23/R271）`）

**后端 DoD**：`cd .worktrees/backend && pnpm exec turbo run test lint --force` 全绿（0 cached）+ `build --force` 10/10 + **`pnpm run ci` 六阶段全绿**；汇报附：五个服务的 `curl /api/health` 原文、`/api/health/live` 原文、覆盖率门槛**反向自证**（阈值 99 ⇒ 红）原文、`canBeatWithHand` 的 grep 原文。

---

## Task 5（conformance agent）：在线判据 + 三处「会失败」的自证

**Files:** Modify `tools/conformance/src/slices/slice-07.2-deploy.ts`、`slice-07.2-hardening.ts`

**Interfaces:**
- Consumes: 各服务的 `/api/health`（Task 1）、`scripts/ci.sh`（Task 3）
- Produces: §2.4 的在线判据；§12.4 闸「真的拦得住」的判据；覆盖率门槛「真的会失败」的判据

- [ ] **Step 1: §2.4 健康检查的在线判据**（`slice-07.2-deploy`，与既有 prod/dev/runtime 步骤并列，id 如 `health`）
  - 五个服务（经网关 + 直连）`GET /api/health` ⇒ **200** 且 body **含 `checks`**；`user-service` 的 `checks` **恰好** `{redis, mysql}`，其余四个**恰好** `{redis}`（**字段集断言**，防「报了并不依赖的东西」）；
  - `GET /api/health/live` ⇒ **200** 且 `checks` 为空（存活面不查依赖）；
  - **`degraded` ⇒ 503 的可控构造**（`run.js` 是 fail-fast，而这条需要一个**坏依赖**）：
    ⚠️ **不要**去停容器（会污染同轮其它切片 —— A7 的 e2e 就是因为这个被刻意不做的）。
    可行构造：**临时把某服务的 `REDIS_URL` 指向一个没有监听的地址**并只重启**那一个**服务 ⇒ 断言 `503 + checks.redis=down`，随后**恢复并确认回到 200**（`finally` 里恢复，且**断言恢复成功**）。
    ⚠️ 若你判断该构造也不安全（会让同轮其它切片假红），**退一步**：把「503 的形态」交给**单测**（Task 1 已覆盖控制器设码），并在在线判据里**只**断言 200 路径 + `checks` 字段集，**同时在输出里写明「503 未做 e2e，理由」**（本仓对 A7 就是这么处理的，先例在案）。
- [ ] **Step 2: §12.4 闸「真的拦得住」的判据**（`slice-07.2-hardening` 或 deploy）
  回归已有闸的**探针判别力**：向 `apps/client/src` 注入一个含 `牌型`/`baseScore` 字面量的临时文件 ⇒ `source-boundary` **必须红**；删除后恢复绿。**这证明 CI 第 6 阶段不是空跑**（R115/R268）。
  ⚠️ 注入的文件必须**只碰你自己的临时文件**、并在 `finally` 里删除 + **断言删除成功**（不要污染工作区 —— 那会让门禁的 git 状态审查失败）。
- [ ] **Step 3: 覆盖率门槛「真的会失败」的判据**
  断言 `packages/shared/vitest.config.ts` 里 `thresholds.lines === 80`（**读文件**，不是读运行结果），并**并列**一条**反向**判据：把该值临时改成 `99` 后 `pnpm --filter @fight-the-landlord/shared test:coverage` **必须非零退出**（`spawnSync` 捕获退出码），**改回后必须零退出**（`finally` 恢复）。
  ⚠️ 这条**修改的是产品配置文件**，因此恢复断言是硬要求；若你判断风险高于收益，改为**只读**断言 + 在输出里写明「没有做变异自证，理由是它会改产品配置」，并**交给门禁由协调者手工验一次**。
- [ ] **Step 4: 跑（独占）**
```bash
cd /home/howe/pokergame
pnpm exec turbo run build --force
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
pnpm --filter @fight-the-landlord/conformance build
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening
timeout 300 node tools/conformance/dist/run.js slice-11
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary
timeout 300 node tools/conformance/dist/run.js slice-07
```
- [ ] **Step 5: 交接**：附每条新判据的**修前 RED 原文** + 「哪几条在旧栈上也绿、为什么」（切片 11 教训第 7 条）+ 503 那条的取舍理由。

**conformance DoD**：上面 6 条切片全绿 + 三处自证的实际输出 + 每条新判据的修前 RED 原文。

---

## 门禁（协调者，两个 agent 都 settle **之后**执行；conformance 独占）

```bash
cd /home/howe/pokergame
git merge feat/backend --no-edit

pnpm exec turbo run test lint --force      # ✅ 29/29、0 cached
pnpm exec turbo run build --force          # ✅ 10/10
pnpm run ci                                # ✅ §13.4 六阶段全绿（**本片的核心 DoD**）
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 前端回归

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8 个容器全部 healthy（§14.4 的 DoD 逐字）
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s localhost:$p/api/health; echo; done
# ✅ 每个都含 checks；:3001 = {redis,mysql}；其余 = {redis}
curl -s localhost:3002/api/health/live     # ✅ 200 且 checks 为空

docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
timeout 300 node tools/conformance/dist/run.js slice-07.2-deploy     # ✅（+N12/N14/§2.4）
timeout 300 node tools/conformance/dist/run.js slice-07.2-hardening  # ✅
timeout 300 node tools/conformance/dist/run.js slice-11              # ✅ 46 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-rpc        # ✅ 61 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-boundary   # ✅ 82 项
timeout 300 node tools/conformance/dist/run.js slice-07.2-security   # ✅ 40 项
timeout 300 node tools/conformance/dist/run.js slice-07.1            # ✅ 28 项
timeout 300 node tools/conformance/dist/run.js slice-07              # ✅ 39 项
timeout 300 node tools/conformance/dist/run.js slice-10              # ✅ 185 项
timeout 300 node tools/conformance/dist/run.js slice-09              # ✅ 160 项
timeout 300 node tools/conformance/dist/run.js slice-08              # ✅ 55 项
timeout 300 node tools/conformance/dist/run.js slice-06              # ✅ 通过（只看尾行）
timeout 300 node tools/conformance/dist/run.js slice-05              # ✅ 29 项
docker compose logs api-gateway | grep -c 'Blocked outbound'         # ✅ 0
```

**收口（协调者）**：
1. `docs/design.md`：**§2.4** 的 `[部分实现]` 改为 `[已实现]`（写清两个端点与 checks 的依赖清单）；**§12.4** 按 R268 改写（落地形态是 vitest 源码闸 + **为什么不照搬 ESLint 插件**）；**§13.3** 补「门槛已配置 + 实测 93.94%」；**§13.4** 标注六阶段的实际落地（`scripts/ci.sh`）与第 6 阶段的真实内容；
2. `deviation-ledger.md`：**新增并同片关闭 N23（`rule/beat.ts` 死代码）/ N24（§13.3+§13.4 的 CI 与覆盖率门槛）/ N25（§2.4 健康检查 `checks` + 存活就绪）**（这三条是「A.2 没有、也从未编号」的缺口，按 §5 第 2 条追加为 N 系列）；§0 用 `node scripts/ledger-counts.mjs` 重算；
3. `agent-briefs.md`：追加 P5 的门禁实测块 + 教训；更新「交接现状」（**MVP 收口后剩余 = N13 一条 roadmap 项**）；
4. 本计划文件追加「门禁实测」块。

---

## Self-Review

**Spec coverage**

| 规格 | 落在哪个 Task |
|---|---|
| §2.4 `checks` 字段 + `ok/degraded` + 200/503 | Task 1（R267）+ Task 5 Step 1 |
| §2.4「未区分存活/就绪」 | Task 1（`/api/health/live`）+ Task 5 Step 1 |
| §13.3 `shared` 行覆盖率 ≥80% + 命令 | Task 2（R270）+ Task 5 Step 3（**会失败**的自证） |
| §13.4 六阶段 | Task 3（`scripts/ci.sh`）+ Task 5 Step 2 |
| §12.4 FORBIDDEN 的机械拦截 | R268 + Task 3 第 6 阶段 + Task 5 Step 2 |
| §14.4 DoD（`ci` + 覆盖率 + 8 容器 healthy） | 门禁块逐条 |
| N23 死代码 | Task 4（R271） |

**Placeholder scan**：无 TBD。Task 1 的 `game-service` Redis provider 提取、Task 3 的 test 过滤名、Task 5 的 503 构造都写明了**具体做法 + 已知风险 + 退路**，不是占位符。

**Type consistency**：`HealthBody`/`CheckState` 在 Task 1 定义、Task 5 消费（字段集断言以它为准）；`test:coverage` 脚本名在 Task 2 定义、Task 3 的第 5 阶段与 Task 5 Step 3 消费；`scripts/ci.sh` 的阶段名与 §13.4 **逐字一致**（`1 install` … `6 eslint-forbidden`）。

**⚠️ 本片的三个高风险点（执行时优先验证）**
1. **Task 1 改的是五个服务的启动路径** ⇒ 必须**真的重建并确认 healthy**（本仓已有两次「单测全绿、容器红」：R216/R217 与 R239）；`/api/health` 的 503 语义一旦写错会让**全部容器 unhealthy**。
2. **Task 3 的 `pnpm install --frozen-lockfile`** 在 CI 脚本里是硬要求，但**本地**若 lockfile 与 package.json 不同步会直接失败 ⇒ 先跑一次 `pnpm install --store-dir .pnpm-store` 对齐并提交。
3. **Task 5 Step 3 会改产品配置**（覆盖率阈值）⇒ 恢复断言是硬要求；宁可降级为「只读断言 + 人工门禁验证」，也不要留下一个可能被中断、从而把 99 留在仓库里的变异。

---

## 执行期裁决（回填区，**不要删**）

（执行期发现与代码事实不符时，在此追加一条并编号：**后端 agent 用 R284–R299**（原定 R280–R299，见 **R288**）、conformance agent 用 R300–R319，说明「计划怎么写 / 事实是什么 / 怎么改的」。）

### R284 `game-service` 的 Redis 连接提成 provider，`GameService` 与健康检查复用同一个实例

**计划怎么写**：Task 1 的 ⚠️「`game-service` 的 Redis 今天在 `GameService` 内部 `new Redis()` ⇒
执行期把它提成一个 provider（`RedisProviderModule` 同款）并让 `GameService` 注入，**不得**为健康检查
再建一个连接。**这条改动要记执行期裁决。**」

**事实是什么**：`game-service/src/game/game.service.ts:99` 确实是
`this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379')`（构造函数内），
且没有任何 provider 暴露这个连接 ⇒ 健康检查无从复用。

**怎么改的**：
1. 新建 `packages/game-service/src/redis.provider.module.ts`（形态与 `room-service`/`robot-service` 同款：
   `@Global()` + `createRedis()` + `provide: Redis`，token 就是类本身）；`GameModule` 的 `imports` 加上它。
2. `GameService` 的字段改为 `constructor(@Inject(RedisToken) public readonly redis: Redis) {}` ——
   **`public readonly`**：health 门禁要断言「容器里那个连接与 `GameService.redis` **是同一个对象**」，
   `private` 会让这条判据只能靠间接证据。
3. 既有单测里 **9 处** `new GameService()` 改成 `new GameService(redisDouble)`（`game.service.redis.test.ts`
   用它的局部 `redis` 变量）；`game.module.wiring.test.ts` 的**内联装配**补上 `{ provide: Redis, useValue: redisDouble }`
   —— 那段内联装配与生产装配漂移时本来就该红（注释已写明）。
4. `test/helpers-ioredis.ts` 的 mock 工厂**同时**导出 `default` 与 `Redis`：少了命名导出，
   7 个既有测试文件在**链接期**就炸（`No "Redis" export is defined on the "ioredis" mock`），
   那是整文件级失败。

**判据（判别力已自证）**：`packages/game-service/test/health.test.ts` 的「复用判据」断言
`mod.get(GameService).redis === conn`（`conn` 是 `createRedis()` 在 mock 下的返回值）
且 `mod.get(Redis) === conn`；「健康检查另起 `new Redis()`」或「`GameService` 仍自己 `new`」两种回归都会让它红。

### R285 `/api/health/live` 的响应体**不含** `checks`

**计划怎么写**：Task 1 Step 3 的示例实现里 `live(): HealthBody { return { status:'ok', service, checks: {} }; }`
（`HealthBody`，带一个空 `checks`）；而 Step 1 的测试写 `expect(await c.live()).toEqual({status:'ok', service})`
（**没有** `checks`），Task 5 Step 1 又要求「`/api/health/live` ⇒ 200 且 `checks` 为空」。

**事实是什么**：计划内部三种表述不一致：`checks: {}`（空对象）与「不含 `checks` 键」是**两个不同的形状**，
两者不可能同时满足同一条 `toEqual`。§2.4 只定义了 `/api/health` 的响应体（含 `checks`），
**没有**给存活面定义任何字段。

**怎么改的**：取**不含 `checks` 键**那一支，理由有二：① 它同时满足 Step 1 的 `toEqual`（严格相等，
多一个键就会红）与 Task 5「`checks` 为空」的字段集断言；② 存活面**不查任何依赖**，
报一个空 `checks: {}` 会让读侧误以为「检查过、都过了」。落地为独立类型
`LivenessBody = { status:'ok'; service: string }`（五个服务逐字一致）。
⚠️ 交付给 conformance 的口径就是**这一条**：`live` 只断 `status`/`service` 两个字段。

### R286 健康检查的注入一律显式 `@Inject(...)`（esbuild 不发 `design:paramtypes`）

**计划怎么写**：Task 1 Step 3 的示例是 `constructor(private readonly redis: Redis) {}` —— 靠**类型**
解析注入 token（`design:paramtypes`）。

**事实是什么**：tsc 构建确实会发 `design:paramtypes`（`packages/*/tsconfig.json` 都开了
`emitDecoratorMetadata`），**所以生产路径今天是对的**；但 **vitest/esbuild 不发**它，
于是容器门禁用例里 `HealthService` 被注入 `undefined`（实测原文：`hs.redis = undefined`）。
这不是「测试写错了」，而是**判据与实现形态的耦合**：本仓两次「单测全绿、容器红」（R216/R217）
正是这一类。

**怎么改的**：五个 `HealthService` 与 `GameService` 的构造参数全部改成显式 token
（`@Inject(Redis)` / `@Inject(REDIS)` / `@Inject(DataSource)`）—— 这正是本仓**既有惯例**
（`api-gateway/src/auth/session.guard.ts:20`、`http/http-rate-limit.middleware.ts:30`、
`user-service/src/auth/token.service.ts:51` 全都是这么写的）。副作用是**生产与单测走同一条解析路径**，
「源码里注入的是什么」变成可读的。⛔ 这**不是**把判据改弱：显式 token 比 `design:paramtypes`
**更严**（后者依赖构建器行为，换打包器就静默变 `undefined`）。

### R287 计划给出的注入 token 名与实际不符之处（`game-service` 的 `Redis`）

**计划怎么写**：Task 1 Step 3 的注释「`room-service`/`robot-service` 用 `RedisProviderModule` 的 `Redis` token」
（对），以及 R267 里「`user-service` 用它自己的 `RedisModule` provider + TypeORM 的 `DataSource`」（对）。

**事实是什么**：两处**需要纠正**的细节：① `room-service` / `robot-service` 的 provider 文件**确实叫**
`redis.provider.module.ts`，但 `room-service` 的 fake-redis 替身（`test/helpers/fake-redis.ts`）
**没有** `ping` 也**没有** `on` —— 健康检查接进来之后，前者让 6 条用例全红、后者让 provider 构造期
`TypeError: redis.on is not a function`；② `api-gateway` 的 `REDIS` 是一个**字符串常量 token**
（`auth/session.guard.ts`），与另外四个「类就是 token」不同。

**怎么改的**：给两份 fake-redis 补 `ping`（真实语义：连通 `'PONG'` / 不可用 reject）与 `on`（构造期注册），
补 `on` 时同步验证「不补就红」；`api-gateway` 的 provider 单独放
`src/redis.provider.module.ts`（`provide: REDIS`），**选项逐字保留**
（`maxRetriesPerRequest: 1` + `enableOfflineQueue: false`，R26/S6 的快速失败语义）。

### R288 执行期裁决的编号区间由 R280–R299 改为 **R284–R299**

**计划怎么写**：本文件「执行期裁决（回填区）」与 Global Constraints 的派工说明都写
「后端 agent 用 **R280–R299**」。

**事实是什么**：**R280–R283 已被 P3 的 conformance agent 占用**（见
`2026-09-16-slice-p3-engineering-closeout.md` 第 859/879/900/919 行；其中 R280/R282 还被
`agent-briefs.md` 与台账 N14/N15 交叉引用）。这是 P3 派工时区间划错留下的坑，不是本片的执行缺陷。

**怎么改的**：协调者现场裁决：后端 agent 改用 **R284–R299**；回填区说明已同步改成
「后端 agent 用 R284–R299（原定 R280–R299，见 R288）」。本条与上文 R284–R287 都落在新区间内。

### R289 `coverage.exclude` 在 vitest 里是**整体覆盖**，不是增量 —— 必须延用默认值

**计划怎么写**：Task 2 Step 2 给的配置只有 `exclude: ['src/index.ts']`。

**事实是什么**：vitest 的 `test.coverage.exclude` **有默认值**
（`**/node_modules/**`、`**/dist/**`、`**/*.{test,spec}.{js,ts,…}` 等），而**用户只要写了这个键就整体替换**它。
实测（本片首次跑绿时）：报告里赫然出现 `rule.test.ts` / `autoplay.test.ts` / `message.test.ts` /
`redacting-logger.test.ts` 等**测试文件自己**，而且 `All files` 的分母因此变成「测试代码 + 生产代码」
⇒ 这个数字**不再是** §13.3 说的「`packages/shared` 行覆盖率」。

**怎么改的**：`exclude: [...coverageConfigDefaults.exclude, 'src/index.ts', 'src/protocol/message.ts']`
（`coverageConfigDefaults` 由 `vitest/config` 导出）。这比计划更严：它把「默认排除」
变成**显式可见**的一行，而不是靠「碰巧没写 exclude」隐式生效。

### R290 额外排除 `src/protocol/message.ts`（纯类型，编译后是空文件）+ 实测读数

**计划怎么写**：R270 只说「**不测的文件**（如纯 re-export 的 `src/index.ts`）用 `coverage.exclude`
显式列出并**在注释里写明理由**」。

**事实是什么**：`src/protocol/message.ts` 里**只有** `export type` / `export interface`，
编译产物 `packages/shared/dist/protocol/message.js` 只剩 `"use strict"` + `__esModule` 标记
（112 字节）⇒ **没有任何测试能够执行到它**，它的 0% 不是「没测」而是「不可测」。

**怎么改的**：写进 `exclude` 并在配置注释里逐字说明理由（不是靠调阈值掩盖）。
**实测读数**（必须与计划预估区分）：计划说基线 93.94%；那是**含** `index.ts` 与 `message.ts`
两个 0% 文件的默认口径。本片落地后：Task 2 绿 = **95.38%**；Task 4 删掉 `rule/beat.ts`（第三个 0% 文件）后
= **97.58%**。三次读数都 ≥ 80%，门槛本身由「临时改 99 ⇒ 红」自证（见 Task 2 的汇报原文）。

### R291 CI 第 6 阶段必须**断言每条闸真的跑了用例**（比计划更严，且已自证判别力）

**计划怎么写**：Task 3 Step 1 的第 6 阶段是五条裸 `pnpm --filter … test -- <过滤名>`，
末尾直接打印「六阶段全部通过」。

**事实是什么**：这类命令的**过滤名是与文件名耦合的字符串**。若将来有人重命名测试文件而忘了改
`ci.sh`，`vitest` 的行为有两种：① 直接 `No test files found, exiting with code 1`（这条会红，安全）；
② 加了 `--passWithNoTests` 一类旗标、或过滤名命中了一个「全是 `it.skip`」的文件
⇒ **`Tests 0 passed` 而退出码为 0** ⇒ 第 6 阶段**恒绿**。这正是本仓两次翻车的形态
（`allFilesStillHttp`、`NOT_YET_MIGRATED`），也正是协调者点名的「`tests: 0` 不算通过」。

**怎么改的**：第 6 阶段经一个 `run_gate` 执行器：捕获并打印输出，然后
`sed -nE 's/.*Tests +([0-9]+) passed.*/\1/p'` 取通过数并断言 **`n ≥ 1`**，否则脚本非零退出并点名该闸。
**判别力自证（实跑原文，非机制推断）**：把自证副本里的五条闸换成两条探针
（只改了「跳过 1–5 阶段」与那五行闸，`run_gate` 逐字未改）：
- 探针 A = `… test -- --passWithNoTests definitely-not-a-real-gate` ⇒ 命令**退出 0**、
  `No test files found, exiting with code 0` ⇒ 脚本仍 `SCRIPT_EXIT=1` 并打印
  `!!! [ci] probeA/零用例(过滤名失效) 没有跑任何用例（Tests=0）—— 过滤名失效会让这道闸恒绿`；
- 探针 B = 一条**真的失败**的闸 ⇒ `SCRIPT_EXIT=1`、`!!! [ci] probeB/真失败 失败`。
⇒ 新形态**严格强于**计划的裸调用（裸调用在 A 的情形下会绿）。

### R292 `--frozen-lockfile` 保留，`--store-dir` 按环境条件附加（本机沙箱）

**计划怎么写**：Task 3 Step 1 的第 1 阶段是 `pnpm install --frozen-lockfile`（且在「三个高风险点」里
要求：**本地**若 lockfile 与 package.json 不同步会直接失败 ⇒ 先跑一次对齐；
若本机仍不可行，**不要**悄悄删掉它 —— 记一条执行期裁决并给出替代）。

**事实是什么**：lockfile **是**同步的（`Lockfile is up to date, resolution step is skipped`，
Task 0 已把 `@vitest/coverage-v8` 落盘）；失败的**不是** `--frozen-lockfile`，而是
**store 目录的写权限**：本机沙箱禁止写工作区之外的 `~/.pnpm-store`，实测原文
`ERR_PNPM_EACCES Failed to add tarball … to store: EACCES: permission denied, open '/home/howe/.pnpm-store/v3/files/…'`。
（这正是 `agent-briefs.md`「已知环境事实」里那条：`pnpm install` 需要写 `~/.pnpm-store`，
被沙箱拒绝时用 `--store-dir .pnpm-store`。）

**怎么改的**：`--frozen-lockfile` **始终保留**（它是这条判据的语义）；只在仓库内**已存在**
`.pnpm-store`（`.gitignore` 已忽略）时才附加 `--store-dir .pnpm-store`：

```bash
STORE_ARG=()
if [ -d .pnpm-store ]; then STORE_ARG=(--store-dir .pnpm-store); fi
pnpm install --frozen-lockfile ${STORE_ARG[@]+"${STORE_ARG[@]}"}
```

**在真正的 CI 上**（GitHub Actions + `setup-node` 的 `cache: pnpm`）该目录不存在
⇒ 参数不出现，命令与 §13.4 **逐字一致**。实测（本机）：`1/6 install` 绿
（`Lockfile is up to date` / `Done in 1s using pnpm v9.15.9`）。

### R293 容器验收抓到**两个**真缺陷：`/api/health/live` 未被任何免鉴权清单覆盖 + `robot-service` 的控制器被两个模块注册

**计划怎么写**：Task 1 Step 4 只要求「重建容器并确认 healthy」＋ 五个 `/api/health` 含 `checks`；
R267 只说新增 `/api/health/live` = 存活、恒 200。计划**没有**提到「新端点还要进免鉴权清单」，
也没有提到 `robot-service` 的模块注册形态。

**事实是什么**（**第一次**容器验收的实测原文，2026-09-16；此时 5 个服务的镜像已含 Task 1 代码）：

```
ftl-robot-service   Restarting (1) 10 seconds ago        ← crash-loop
:3000 200 {"status":"ok","service":"api-gateway"}         ← 注意：无 checks（→ R294）
:3001 200 {"status":"ok","service":"user-service","checks":{"redis":"up","mysql":"up"}}
:3002 200 {"status":"ok","service":"room-service","checks":{"redis":"up"}}
:3003 200 {"status":"ok","service":"game-service","checks":{"redis":"up"}}
:3005 000                                                 ← robot 没起来
curl :3002/api/health/live → 401 {"code":10002,"message":"Internal token required","data":null}
curl :3000/api/health/live → 401 {"code":10002,"message":"Missing or invalid Authorization header",...}
```

① **`/api/health/live` 恒 401**：网关的 `publicPaths`（§7.1 白名单）与四个下游的
`DEFAULT_EXEMPT_PATHS` **都只列了 `/api/health`**，而两处的匹配都是**精确**的
（`exact match only` / `exemptPaths.includes(req.path)`）⇒ 新的存活面天然不被豁免。
**计划的 DoD 完全没有覆盖这一条**（计划只写了 compose 的 healthcheck 用 `/api/health`）。

② **`robot-service` 启动即崩**：`HealthController` **同时**被 `AppModule` 与 `RobotModule`
注册（`robot.module.ts` 的 `controllers: [RobotController, RobotRpcController, HealthController]`）。
没有构造参数时无害；本片给它加了 `HealthService` 依赖之后，`RobotModule` 上下文里解析不到
那个 provider ⇒
`Nest can't resolve dependencies of the HealthController (?) … available in the RobotModule context`。
⚠️ **所有单测都是绿的**（它们直接 `new HealthController(service)`，不经容器）。

**怎么改的**：
- `/api/health/live` 作为**精确条目**加进两处清单（**不**把 `/api/health` 改成前缀 ——
  那会让 `/api/healthz` 一类路径静默变公开；负对照已写进判据）。
  ⚠️ `design.md` §7.1 白名单原文写「**仅** … 四条」⇒ **需补第 5 条**（`docs/**` 归协调者）。
- `RobotModule` 不再声明 `HealthController`（与另外四个服务一致，由 `AppModule` 声明）。

### R294 容器验收抓到**第三个**缺陷：`GatewayController` 的 `@Get('health')` 遮蔽了 §2.4 的就绪面

**计划怎么写**：计划假定「五个服务的 `health.controller.ts` 目前都是只有 `@Get()` 返回
`{status:'ok',service}` 的占位实现」⇒ 改那一个文件就能让 §2.4 落地。

**事实是什么**：`api-gateway` 的 `/api/health` **有两个**处理器 ——
`GatewayController`（`@Controller()` ⇒ `@Get('health')` = `/api/health`）与
`HealthController`（`@Get()`）。两者在 `AppModule` 的 `controllers: [GatewayController,
HealthController]` 里**声明顺序**决定谁生效（Express 取**先注册**的）⇒ R293 那轮实测
`:3000/api/health` 返回 `{"status":"ok","service":"api-gateway"}`，**没有 `checks`**
（即 §2.4/R267 的就绪面在网关这一跳**静默失效**）。`grep` 计划里提到的「五个 health.controller.ts」
是**找不到**这条的 —— 它在 `gateway.controller.ts` 里。

**怎么改的**：删掉 `GatewayController.health()`（健康面**只有** `HealthController` 一处真源），
并把 `gateway.e2e.test.ts` 那个**手搭 express 路由表**里复刻的旧形状补上 `checks`
（它此前正好把缺陷「复刻」进了脚手架 ⇒ 单测看不见）。

**真容器证据（隔离的一次性容器，跑完即删；不碰常驻的 8 个）**：
```
READY /api/health      3999 => 503
{"status":"degraded","service":"api-gateway","checks":{"redis":"down"}}
LIVE  /api/health/live 3999 => 200
{"status":"ok","service":"api-gateway"}
```
（构造方式：用 `pokergame-api-gateway` 镜像起一个 `-e REDIS_URL=redis://127.0.0.1:6399`
的一次性容器 ⇒ 依赖不可用。**没有**去停/改常驻容器，也没有动 `~/.pnpm-store` 之外的系统配置。）
这条同时把 R267 的两半都钉住了：**degraded ⇒ 503**、**存活面不受下游影响 ⇒ 200**。

### R295 新增三条**容器装配不变式**的源码闸（比计划多，且每条都自证判别力）

**计划怎么写**：计划只要求「每个改动都要有对应测试」（CLAUDE.md），没有要求为装配形态建闸。

**事实是什么**：R293/R294 的三个缺陷有**同一个形状** ——
**单测全绿，只有真容器（或从源码算出来的不变式）能看见**：
① 新路由没进免鉴权清单；② 控制器被两个模块注册；③ 同路径路由被重复注册。
这正是本仓 R216/R217/R239 的同族（「DI 通了」≠「容器真的起得来」），而计划派给单测的
任务（每个服务一份 health.test.ts）**结构上覆盖不到**这三条。

**怎么改的**：新增 `packages/api-gateway/test/container-assembly.gate.test.ts`（7 条用例），
三条不变式全部**从源码两侧提取**、不把当前实现形状钉进判据：
1. 每个服务 `HealthController` 注册的每条路由 ⊆ 该服务的免鉴权清单；
2. 一个控制器类只能被**一个**模块注册（**按服务**判定 —— 五个服务各有一个同名
   `HealthController`，它们是五个不同的类；本条第一次写成了全局判定 ⇒ 自己先假红了一次）；
3. 同一服务内不得有**同路径同动词**的重复路由。
每条都带**判别力自证**（注入式）：拿掉 `room-service` 的 live 豁免 ⇒ 红并点名；
把 `HealthController` 加回 `RobotModule` ⇒ 红；把 `@Get('health')` 加回 `GatewayController`
⇒ 红并点名两个文件；另外三条负对照证明正确实现**不会**假红。
⚠️ 提取器**必须先去注释**：本仓控制器注释里就写着 `@Get('live')`，按原始文本提取会造出
**幽灵路由** ⇒ 假红（实测撞到，已加判据钉住）。

### R296 `HealthController` 与新端点的最终形态（汇总，供 Task 5 与收口对齐）

**五个服务一致的部分**（逐字）：`GET /api/health` = 就绪（`checks` + 可 503）、
`GET /api/health/live` = 存活（**不含** `checks`、恒 200）、`HealthService.live()/check()` 同形。

**每个服务差异的部分（只有这一处）**：`checks` 的键集合 ——
`user-service` = `{redis, mysql}`（`redis.ping()` + `DataSource.query('SELECT 1')`），
`api-gateway`/`room-service`/`game-service`/`robot-service` = `{redis}`（`redis.ping()`）。

**交付给 conformance（Task 5）的在线口径**：
- 五个服务 `:3000 :3001 :3002 :3003 :3005` 的 `GET /api/health` ⇒ **200** + 上述字段集**恰好**；
- 五个服务的 `GET /api/health/live` ⇒ **200** + body **不含** `checks`（字段集恰好 `{status,service}`）；
- `degraded ⇒ 503` 的构造：**推荐**用「一次性容器 + `REDIS_URL` 指向无监听端口」
  （本片 R294 已实测可用，**不需**停常驻容器、不污染同轮其它切片）；
- 新增：`/api/health/live` 是**公开**路径（无凭证 200）—— 它现在是 §7.1 白名单的第 5 条，
  与 `/api/auth/*` 三条并列，**不是**前缀匹配（`/api/healthz`・`/api/health/livex` 必须仍 401）。


### R300 网关**不代理**下游健康面 ⇒ Task 5 Step 1 的「五个服务（经网关 + 直连）」按实测拓扑落地

**计划怎么写**：Task 5 Step 1 第 1 条写「五个服务（**经网关 + 直连**）`GET /api/health` ⇒ 200 且 body
含 `checks`」；R296 的交付口径也写「五个服务 `:3000 :3001 :3002 :3003 :3005` 的 `GET /api/health`」，
读起来像「五个服务的健康面都能经网关拿到」。

**事实是什么**（实测，2026-09-16）：`:3000/api/health` 的响应体是
`{"status":"ok","service":"api-gateway","checks":{"redis":"up"}}` —— 网关报的是**它自己**；网关的
路由表里**没有**任何「转发下游健康面」的入口（§7.1 的代理路由只有业务面）⇒「经网关拿到
room-service 的 health」在本仓**不存在**这种拓扑。按字面写「五个服务都经网关」会在**正确实现**上
假红（R150/R241 同族：判据钉了想象中的拓扑）。

**怎么改的**：判据按实测拓扑写 —— 网关那一跳用 `GATEWAY_URL`（= 经网关），四个下游用
`3001/3002/3003/3005` **直连**；并加一条拓扑断言 `body.service === 'api-gateway'`，把「网关报的是
自己」变成**判据**（将来若有人把健康面改成转发，语义变化会当场暴露）。该步的 `info()`
把拓扑事实与 R293/R294 的修前原文都打了出来。

### R301 存活面按 R285 落地为「字段集**恰好** `{status, service}`」——`checks: {}` 也算违规

**计划怎么写**：Task 5 Step 1 第 2 条写「`/api/health/live` ⇒ 200 且 `checks` **为空**」，而 Task 1 的
示例实现写的是 `checks: {}`；R285 已裁决取「**不含** `checks` 键」那一支，但计划的措辞没改。

**事实是什么**：实测五个服务的 `/api/health/live` 都是 `{"status":"ok","service":"<name>"}`（**没有**
`checks` 键）。「`checks` 为空」这句话本身有歧义 —— 空对象与不存在是**两个形状**，而 R285 的裁决正是
要把它固定成「不存在」。

**怎么改的**：判据钉**键集合恰好** `['status','service']`，并显式加一条判别力断言：
`{status, service, checks:{}}` **必须**报违规（把 R285 的两支分开）。这样将来若有人把 `live()` 改回
`checks: {}`，判据会红 —— 而不是被「`checks` 为空」这句模糊措辞放过去。

### R302 `degraded ⇒ 503` 用**一次性容器**做真 e2e（未走「交给单测」的退路）

**计划怎么写**：Task 5 Step 1 最后一条给了两条路：①「临时把某服务的 `REDIS_URL` 指向没有监听的
地址**并只重启那一个服务**」，随后**恢复并确认回到 200**；②若判断该构造不安全，退化到单测 +
在输出里写明「503 未做 e2e，理由」。

**事实是什么**：路径 ① 要改**常驻栈**（重启某个容器）⇒ 与「同轮其它切片共享 Redis 与连接名额」
冲突（A7 的 e2e 就是为此刻意不做的）。但 R294 已实测出**第三条路**：用**同一个镜像**起一个
**一次性**容器（`-e REDIS_URL=redis://127.0.0.1:6399` + `-p 3999:3000`）—— 依赖不可用、常驻栈
**零改动**、跑完即删。

**怎么改的**：走第三条路（**真 e2e**，不是单测）。实测原文：
`READY http://localhost:3999/api/health => 503 {"status":"degraded","service":"api-gateway","checks":{"redis":"down"}}`
与 `LIVE  http://localhost:3999/api/health/live => 200 {"status":"ok","service":"api-gateway"}`。
收尾在 `finally` 里 `docker rm -f` 并断言 `docker ps -a --filter name=…` 为空；另加一条 R115 正对照
（容器存在时该探针必须看得见它 —— 否则收尾的「为空」是空测）。

### R303 注入探针里的 `牌型` 只能是**注释** —— 真正的违规必须是 `baseScore` 字面量

**计划怎么写**：Task 5 Step 2 写「向 `apps/client/src` 注入一个含 `牌型`/`baseScore` 字面量的临时文件
⇒ `source-boundary` **必须红**」。

**事实是什么**：`apps/client/test/source-boundary.test.ts` 的扫描器**不拦**「`牌型`」这个字符串本身 ——
它拦的是 banned 标识符（`isValidHand`/`findBeating*`/…）、底分**赋值**字面量、自制牌面映射、应用层
`ping/pong`。把「文件里出现 `牌型`」当作触发条件，会在**正确实现**上假红。

**怎么改的**：探针文件里 `牌型` 只出现在**注释**（充当「注释不算违规」的负对照），真正触发红的是
`export const baseScore = 100;`；并断言 RED 输出**点名**探针文件名与 `baseScore`，把红归因到本探针。
另跑一次**注入前基线**必须绿 —— 否则「注入后红」不可归因（可能本来就红）。

### R304 第二条注入探针选 `rule-error-mapping`（与 `source-boundary` **不同形态**）

**计划怎么写**：Task 5 Step 2 的 ⚠️ 建议「同时覆盖第 6 阶段的第五条闸或至少一条与 source-boundary
**形态不同**的闸」，同时明确「不要为了凑数而做没有判别力的注入」。

**事实是什么**：五条闸**都是**源码级 vitest 闸，但形态可分两类 ——「扫描禁止字面量/标识符」
（`source-boundary`、`no-internal-http.gate`、`outbound-timeout.gate`、`no-route-outside-api.gate`）与
「**集合覆盖**」（`rule-error-mapping`：`shared/src/{ddz,rule}` 的 throw 站点集合必须 ⊆ `RULE_ERROR_MAPPINGS`，
它不扫任何「禁止」字面量）。

**怎么改的**：第二条探针选 `rule-error-mapping`：向 `packages/shared/src/rule` 注入一个未映射的
`throw new Error('conformance probe: …')`。RED 原文：`AssertionError:
rule/__conformance_probe__.ts 的 throw「conformance probe: this rule error maps to nothing in
RULE_ERROR_MAPPINGS」没有任何映射（新增 throw 必须同步加映射）: expected undefined to be defined`；
删除后恢复绿。两次注入都在 `finally` 里删除并**断言删除成功**。

### R305 追加一条**只读**判据：`scripts/ci.sh` 第 6 阶段的五条闸必须齐全、且过滤名能解析到真实文件

**计划怎么写**：计划没有这条（Task 5 Step 2 只要求注入探针）。

**事实是什么**：R291 把「过滤名与文件名脱节 ⇒ vitest 跑 0 个用例而退出 0 ⇒ 闸恒绿」做成 `run_gate`
的**运行期**断言；但那条断言只有在 CI 真跑起来之后才生效，而「接线错误」在**静态**上就能看出来，
可以在 conformance 里更早点名（且属于「§12.4 的覆盖面不许静默缩水」这一性质）。

**怎么改的**：`gate` 步第 ① 部分**只读** `scripts/ci.sh`（不改产品文件），提取 `run_gate` 接线，
断言五条闸齐全、每条的过滤名能在对应包的 `test/` 下匹配到真实存在的 `.test.ts`；提取器与判据各带一条
**合成输入**的判别力自证与负对照（合成里塞一个不存在的过滤名 ⇒ 必须报违规）。

### R306 覆盖率门槛做**变异自证**（不降级为只读 + 人工门禁），恢复做**三层**保险

**计划怎么写**：Task 5 Step 3 允许「只读断言 + 在输出里写明理由，交给门禁由协调者手工验一次」
（协调者已实测过一次：99 ⇒ 红 / 80 ⇒ 绿）。

**事实是什么**：R270 的核心判据就是「**它会失败**」—— 只读断言证明不了这一条，而把它留给人工等于
把「会失败」变成一次性动作。代价可控（一次 `test:coverage` ≈ 2.7s），风险全部集中在**恢复**上。

**怎么改的**：做变异自证，恢复做成**三层**：`try/finally` 显式恢复 + `process.on('exit')`
（`run.js` 的失败路径会 `process.exit`，它**不**执行 finally）+ `SIGINT/SIGTERM/SIGHUP`
（门禁给每条切片套了 `timeout`，被它杀掉时**不**触发 `exit` 事件）。恢复用**原始字符串备份**，
不用重新拼写；恢复后断言逐字相同并打印 sha256。实测：99 ⇒ 退出码 1 +
`ERROR: Coverage for lines (97.58%) does not meet global threshold (99%)`；80 ⇒ 退出码 0
（`All files 97.58%`）；恢复校验 sha256 前 16 位两侧都是 `d470ef6da8c4d362`（1515B）。

**两层兜底恢复的**实测**（不是机制推断）**：写一个只做「备份 + 变异」的脚本，然后
①`kill -TERM` ⇒ `⚠️ conformance 收到 SIGTERM：已把探针注入/变异的文件恢复原状（退出码 143）`
且文件与备份 `diff` 逐字相同；②脚本内直接 `process.exit(1)`（= `run.js` 兜底 timer 的退出方式，
**不**执行 finally）⇒ 文件同样逐字恢复。两次都断言了 `lines: 99` 计数为 0。

### R307 修前 RED 的取法：**受控复现**（修前镜像已不存在，且本 agent 不得回退 `packages/**`）

**计划怎么写**：Task 5 Step 5 要求「附每条新判据的**修前 RED 原文**」；切片 11 教训第 7 条要求
「先证明你的新判据在修前是红的，否则它可能是恒绿」。

**事实是什么**：协调者已把五个服务的镜像重建为**修后**代码、并 `up -d`，主检出也没有可回退的
工作区；而本 agent 的写权限**限于** `tools/conformance/**`（计划第 81 行、派工书都写明不得改
`packages/**`）⇒ 在历史栈上实跑这几条新判据**不可行**。

**怎么改的**：把修前的**实测形态**（R293 的 `curl :3002/api/health/live → 401 {"code":10002,…}`、
R294 的 `:3000 200 {"status":"ok","service":"api-gateway"}`）当作**输入**喂给本片新写的纯函数谓词，
断言谓词**报违规**并把判据原文打进输出。关键一点：修前的 `:3000/api/health` 体逐字等于**今天**
`/api/health/live` 的体（都是 `{"status":"ok","service":"api-gateway"}`），所以其中一条受控复现用的
输入是**真实 HTTP 响应**，不是手写字面量。该步的 `info()` 已写明「这**不是**历史镜像上的实跑」。
§12.4 与 §13.3 两处则是**真** RED：注入/变异把闸**当场**弄红（退出码 1 与门槛原文都留档）。

**「旧栈上也绿」的那一条，以及它凭什么不是恒绿**：近邻负对照（`/api/healthz`・`/api/health/livex`
匿名 ⇒ 401）在**修前栈上也是绿的** —— 那两条路径当时本来就不公开。它是**回归闸**
（守「有人把 `/api/health` 改成前缀」这个未来回归），不是缺陷探测闸，这一点**必须写明**
（切片 11 教训第 7 条）。它的判别力用**实测**承担，而不是机制推断：
带一个有效凭证打同一条 `/api/healthz` ⇒ **404 + `10001`**
（`{"code":10001,"message":"Cannot GET /api/healthz","data":null}`），而匿名 ⇒ **401 + `10002`**。
两个观测值合起来证明「匿名时的 401 只能来自验签中间件」；若白名单变成前缀，匿名请求会走到路由层
拿到 **404** ⇒ 那条 `checks.eq(status, 401)` 立刻红。另外，「修前 `/api/health/live` 恒 401」这一半
也有实测复现：把**真实的** 401 响应当作存活体喂给存活面谓词 ⇒ 谓词报违规（判据原文已打进输出）。

### R308 conformance 断言计数变化（供协调者重算台账与门禁预期）

**计划怎么写**：计划的 Files 只写「Modify 两个 slice 文件」，没有给断言数的预期；
`deviation-ledger.md` 与门禁记录里是**修前**读数（`slice-07.2-deploy` **55**、`slice-07.2-hardening` **73**）。

**事实是什么**（实测，2026-09-16，本片修后、独占跑、每条套 `timeout 300`）：
`slice-07.2-deploy` = **104**（+49，全部来自新的 `health` 步）、`slice-07.2-hardening` = **103**
（+30：`gate` **12** 项 + `cov` **18** 项）；其余四条不变（`slice-11` 46、`slice-07.2-rpc` 61、
`slice-07.2-boundary` 82、`slice-07` 39）。

**怎么改的**：无代码改动（这是读数）。协调者收口时请把台账/门禁记录里的计数同步成本片的实测值。

---

## 门禁实测（协调者，两个 agent 都 settle 之后；conformance 独占）

**HEAD = `e48a252`**（`feat/backend` 已合并；后端 agent `f039981`/`f082cf6`/`c563fd8`/`e0642ca`/`2c49221`/`94edc10`/`7359cf6`/`6a69efa`；
conformance agent `fdb797e`/`5261a7d`/`5478e84`/`62a8043`/`e48a252`）。全部 `--force`、**0 cached**。

```bash
cd /home/howe/pokergame
pnpm exec turbo run test lint --force      # ✅ Tasks: 29 successful, 29 total / Cached: 0 cached
pnpm exec turbo run build --force          # ✅ Tasks: 10 successful, 10 total / Cached: 0 cached
timeout 1200 pnpm run ci                   # ✅ CI_EXIT=0 ——「=== [ci] 六阶段全部通过 ===」
#  1/6 install 3s（Lockfile is up to date）· 2/6 lint 9s（12/12, 0 cached）· 3/6 build 10s
#  · 4/6 test 26s · 5/6 coverage 2s · 6/6 eslint-forbidden (§12.4) 5s
#  第 6 阶段五条闸（每条都断言 Tests N passed ≥ 1，R291）：
#    client/source-boundary ✓ 8 · room-service/no-internal-http.gate ✓ 8
#    api-gateway/outbound-timeout.gate ✓ 5 · api-gateway/no-route-outside-api.gate ✓ 6
#    game-service/rule-error-mapping ✓ 3
cd apps/client && pnpm test && pnpm lint && pnpm build && cd ../..   # ✅ 163 passed(+2 skipped) · vue-tsc 干净 · build OK
                                           #    （**本片零前端改动**；`apps/` 的 diff 为空）

pnpm --filter @fight-the-landlord/shared test:coverage    # ✅ All files 97.58% ≥ 80，EXIT=0

pnpm exec turbo run build --force          # ⚠️ 跑 conformance 前必跑（robot-service 是 bind-mount）
DOCKER_BUILDKIT=0 docker compose build && docker compose up -d
docker compose ps                          # ✅ 8/8 healthy（§14.4 的 DoD 逐字）：
#  ftl-api-gateway / ftl-douzero / ftl-game-service / ftl-mysql
#  ftl-redis / ftl-robot-service / ftl-room-service / ftl-user-service   全部 Up (healthy)
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s -o /dev/null -w '%{http_code} ' localhost:$p/api/health; curl -s localhost:$p/api/health; echo; done
#  ✅ :3000 200 {"status":"ok","service":"api-gateway","checks":{"redis":"up"}}
#     :3001 200 {"status":"ok","service":"user-service","checks":{"redis":"up","mysql":"up"}}   ← 恰好 {redis,mysql}
#     :3002 200 {"status":"ok","service":"room-service","checks":{"redis":"up"}}
#     :3003 200 {"status":"ok","service":"game-service","checks":{"redis":"up"}}
#     :3005 200 {"status":"ok","service":"robot-service","checks":{"redis":"up"}}
for p in 3000 3001 3002 3003 3005; do printf ':%s ' $p; curl -s localhost:$p/api/health/live; echo; done
#  ✅ 五个都 200 {"status":"ok","service":"<名>"} —— **不含 checks**（R285）
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/healthz       # ✅ 401（近邻负对照）
curl -s -o /dev/null -w '%{http_code}\n' localhost:3002/api/health/livex  # ✅ 401

docker compose exec -T redis redis-cli DEL bot:pool:ddz >/dev/null
for s in slice-07.2-deploy slice-07.2-hardening slice-11 slice-07.2-rpc slice-07.2-boundary \
         slice-07.2-security slice-07.1 slice-07 slice-10 slice-09 slice-08 slice-06 slice-05; do
  timeout 300 node tools/conformance/dist/run.js "$s"
done
# ✅ slice-07.2-deploy 通过：104 项断言，13.1s   （55 → +49：§2.4 健康检查在线判据）
# ✅ slice-07.2-hardening 通过：103 项断言，24.7s（73 → +30：§12.4 闸判别力 + §13.3 门槛变异）
# ✅ slice-11 46 · slice-07.2-rpc 61 · slice-07.2-boundary 82 · slice-07.2-security 40
# ✅ slice-07.1 28 · slice-07 39 · slice-10 185 · slice-09 160 · slice-08 55 · slice-06 199 · slice-05 29
# ⇒ **13/13 全绿**

docker compose logs api-gateway | grep -c 'Blocked outbound'                                    # ✅ 0
docker compose logs game-service robot-service | grep -cE 'ECONNREFUSED|ETIMEDOUT|ECONNRESET'   # ✅ 0
```

**关闭的偏差**：**N23**（死代码）· **N24**（§13.3 门槛 + §13.4 CI 六阶段）· **N25**（§2.4 `checks` + 存活/就绪）。
**对账表 §0 现为 78 条：77 已关闭 / 0 部分关闭 / 1 仍开放**（`node scripts/ledger-counts.mjs` 已校验逐区一致）。

**门禁期抓到的真问题（本片全部是「单测全绿、只有真容器/门禁能看见」）**：
1. **Task 1 容器验收抓到 3 个真缺陷**（R293/R294）：`/api/health/live` 恒 401（两处免鉴权清单都是**精确**匹配、只列了 `/api/health`）· `ftl-robot-service` crash-loop（`HealthController` 被 `AppModule` 与 `RobotModule` **同时注册**，加构造依赖后解析不到 provider）· `:3000/api/health` 没有 `checks`（`GatewayController.@Get('health')` 与 `HealthController.@Get()` **同路径重复注册**，Express 取先注册者 ⇒ §2.4 在网关**静默失效**）。⇒ 新增 `container-assembly.gate.test.ts`（8 用例、三条装配不变式）。
2. **`coverage.exclude` 是整体覆盖**（R289）：自写数组会静默取消 vitest 默认的 `**/*.test.ts` 排除 ⇒ **测试文件进分母**。这是最容易把门槛做假、且**不报错**的地方。
3. **CI 第 6 阶段的裸调用会恒绿**（R291）：过滤名与文件名脱节时 vitest 会「0 用例而退出码 0」⇒ 改成断言 `Tests N passed ≥ 1`，并用探针 A 自证。
4. **两条新在线判据在修前栈上也绿**（R307）：近邻 401 是**回归闸**不是缺陷探测闸 —— 判别力靠成对实测值承担（匿名 `/api/healthz` = 401 vs **带凭证** = 404 + `10001`）。
5. **调度冲突（本片独有）**：一次 session 异常中断后，协调者未先核实 agent 存活就**重复派了同一个 Task** ⇒ 两个 conformance agent 并发改写 `tools/conformance/**`；其中一个靠 **mtime 秒级推进**识别出「活的并发写入」并**停手上报**（未抢写）。⇒ 恢复中断 session 前先 `list_agents`。

---

## 下一步

- ✅ 已完成：Task 0–5（后端 agent Task 1–4 · conformance agent Task 5）→ 协调者合并 `feat/backend`、跑门禁、收口 `design.md` §2.4/§7.1/§12.4/§13.3/§13.4/§13.5/§14.4 与台账（**N23/N24/N25** + §0 重算 78 条）。
- **MVP 范围内的偏差已全部关闭**；唯一仍开放的是 **N13**（登录/注册/刷新无 IP 维度限流 —— roadmap §16 风控，**不是**本 MVP 的安全边界）。
- 留给后来人的候选：`agent-briefs.md` 里已登记的两条（**R253**：`slice-11` 第 6 组仍有相对量池判据 / `api-gateway` 缺 `reflect-metadata` 直接依赖），以及 `deviation-ledger.md` §3「文档待更新」里 P5 未动的过期内联 `[偏差]` 注记。
