# 片⑦「配置中心 + 好友房开关」实施计划（v1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把散在各处的可调参数（九键）收进新的 config-service：一处改（/admin 网页）→ 写库 → 推送失效 → 各服务内存缓存立刻重载；底分档位收编成配置键并把它「改了即生效」从手工验证升级成永久判据；好友房开关三面强制、默认关。

**Architecture:** 新 config-service（NestJS + TypeORM + Redis publish）；消费侧 = 进程内快照缓存（启动重试 + pub/sub 失效 + 60s 安全网）+ 四个周期常量改 `setTimeout` 自重排；网关加 `/api/admin/*` 独立鉴权缝与两个新限流桶；管理页由门口托管（无构建静态页）；发布/回滚工具链改为「送目标 tag 自己的 compose」。

**Tech Stack:** TypeScript / NestJS（config / room / robot / gateway / protocol / shared）· MySQL 8（platform_config）· ioredis pub/sub · uni-app + Vue3（client）· vitest · Nest TCP RPC · docker compose · GitHub Actions。

## 0. 修订对账

### v2 相对 v1（r1 计划审查处置：3 Critical / 10 Important / 16 Minor）

| # | r1 的问题 | 处置 |
|---|---|---|
| X-1 | shared re-export 写成 `as SHARED_…`（无本地绑定 + 改对外名 ⇒ 自身与四条消费链全炸） | 改为 `import { DEFAULT_BASE_SCORE } …; export { DEFAULT_BASE_SCORE };`（对外名不变；真名订正已同步 spec C1 行） |
| X-2 | `rest.clientConfig` 与既有 import 重名（TS2440） | 改名 **`fetchClientConfig`** + 两个 `ClientConfig` 的消歧说明 |
| X-3 | `modelBySkill` 接在日志行（决策点是 `bot.player.ts:140`） | T8 Files 补 `bot.player.ts:140`（标「决策路径」）+ robot.service:55 标「日志行」；spec E4 行同步 |
| I-1 | no-internal-http 闸 `RPC_USAGE` 须换 `configSnapshot` | 落 T6 Files（`:75-76`） |
| I-2 | J18 闸 `design-md-ai-rollout.gate.test.ts:95-100` 须极性翻转 | 落 T17 Files |
| I-3 | 四个 workflow 的 6 行计数 | 落 T4 Files |
| I-4 | C21① 断言字面 `$IMAGE_TAG` 永假（真变量 `TAG`） | T5 Interfaces + T16 两处统一 `refs/tags/${TAG}:` |
| I-5 | BUILD_SERVICES 数字 9 vs 真值 8 | T16 改 8 项 + `:559-561` 消息 + commit 文案 |
| I-6 | slice-07.4 `:693-699` svcNames===7 在 T4 后必红（render 列每次 push 跑） | 落 **T4 同提交**（T16 的 C21① 注明明细） |
| I-7 | (a) baselines 空键会静默通过 ⇒ 改为**不加键**（CI 红未回填 ⇒ T18 回填）；(b) slice-13 floor 净减无处置 ⇒ T16 补「等量补齐 / 显式下调 floor」条款 | T16 Files + T18 预期红表述 |
| I-8 | T2 克隆清单三处错（redis.module 真名 / REDIS 令牌归属 / health 无 module） | T2 Files 重写该行 |
| I-9 | C5/C18 判据本体（`config.validation.test.ts` + 非正 + 归一化落库断言）缺座位 | T1 补非正 case；T3 补测试文件；对照表同步 |
| I-10 | 执行图缺 T15←T14、T16←T5 两条边 | 执行图修正 |
| M1–M16 | 十六个 Minor（行号 5 处 + 措辞 11 处） | 逐条落字（messages :52-64 / browser-e2e :475/:476 / gateway.controller.test :122-140 / 五列 / override 头 :12-13 / `-T` 措辞 / `--fresh` import / 循环模板 clarify / conformance build `...` 注 / C12 归属 / main.ts 口径 / 旧注释漂移 / rpc 红窗登记…） |

> **r2 修复验证（已回）**：3/3 C + 10/10 I + 16/16 M 成立；新发现 **F1–F4 + R1–R8** 已在本版逐处落字（`review-plan-r2.md`）。F2 采 A 方案：`:552` 随 T4、`RPC_PORTS` 随 T13——两处 render 列红窗关闭（r2 判「修掉 F1–F4 即可进实现」）。

---

## Global Constraints

- **提交纪律**：每次改动一个 commit，结尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`（CLAUDE.md）。
- **测试纪律**：每个改动都要写/更新测试，交付前该改动相关的测试与验证必须全过（CLAUDE.md）。
- **分支**：`feat/config-center`（开工第一步从当前 master 创建；收口用 `--ff-only` 合入 master 并删分支）。
- **判据只增不减**；`tools/conformance/baselines.json` 的 `full` 列**只由 CI 运行**回填，**不得用本机读数**；凡删既有判据必须按规格 §4.1 显式登记。
- **默认值（逐字，= 代码默认 = 种子）**：`robot.skillDistribution` `{beginner:0.15,intermediate:0.35,advanced:0.5}` · `robot.ruleFallback` `true` · `robot.modelBySkill` `{beginner:'sl',intermediate:'douzero_WP',advanced:'douzero_ADP'}` · `robot.reclaimIntervalMs` `60000` · `room.matchScanIntervalMs` `5000` · `room.autostartIntervalMs` `5000` · `room.reapIntervalMs` `60000` · `room.friendRoomEnabled` **`false`** · `game.baseScoreLevels` `[{休闲场,15},{标准场,80},{竞技场,480},{豪侠场,1200}]`。
- **缺省底分 15 唯一真源 = protocol 的 `DEFAULT_BASE_SCORE`**（shared 与 room-service 改为 re-export；**新代码禁止再定义**）。
- **测试可见 env 的解析纪律**：`CONFIG_SYNC_SAFETY_NET_MS` / `CONFIG_SYNC_DISABLE_PUSH` 空串 = 未设（`||` 不用 `??`）；生产 compose 只以空默认透传，不设实值。
- **权威文本**：设计层 `docs/superpowers/specs/2026-10-01-config-center-design.md`（v3 定稿本 @ `b83c5d4`）· 规格层 `…-spec.md`（v2 定稿本 @ `9754877`）。**遇到与真实代码冲突 ⇒ 停下报协调者，不自行改设计**。
- **参考成例**（实现时对照，别重造夹具）：`slice-07.3-edge.ts:141-159`（`--no-deps` + env 注入）· `scripts/ops/restore.sh:234-235`（mysql exec 凭据形态）· `slice-07.5-backup`（`docker exec ftl-mysql`）。

---

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `packages/protocol/src/config.ts`（新） | 九键清单/类型/`parseConfigValue`/`CLIENT_CONFIG_KEYS`/`DEFAULT_BASE_SCORE`（唯一真源） | T1 |
| `packages/protocol/src/rpc.ts` | `configSnapshot` 换 `baseScoreLevels`；`ConfigSnapshotRequest/Response` | T1 |
| `packages/shared/src/ddz/game.ts` | `DEFAULT_BASE_SCORE` → re-export（对外名不变） | T1 |
| `packages/config-service/`（新包） | 配置持久源（MySQL）+ 三出口（RPC/REST 子集/管理面）+ 写时 publish | T2/T3 |
| `packages/config-service/src/config/platform-config.service.ts` | 读（每次查库）/写（事务 version+1 + publish + announced 可见） | T2 |
| `packages/config-service/src/config/admin-auth.service.ts` | 常数时间比较 + 管理 JWT（aud=ftl-admin，2h） | T3 |
| `packages/room-service/src/config/config-cache.service.ts`（新） | 快照缓存（重试/订阅/安全网/测试 env）+ 类型化 getter | T6 |
| `packages/room-service/src/gateway/rpc.options.ts` | `CONFIG_SERVICE_RPC_*`（换掉 `USER_SERVICE_RPC_*`） | T6 |
| `packages/room-service/src/rooms/rooms.controller.ts` | 三面拒绝（create/join 拒 `12006`；list 返空） | T7 |
| `packages/robot-service/src/config/config-cache.service.ts`（新） | 同构克隆（四个 robot 键） | T8 |
| `packages/api-gateway/src/auth/admin.middleware.ts`（新） | 管理令牌验证（剥伪造/恰好一条豁免/注入 `X-Admin`） | T9 |
| `packages/api-gateway/src/auth/public-paths.ts` | + `isAdminPath`（前缀语义、与五条分列） | T9 |
| `packages/api-gateway/src/http/http-rate-limit.middleware.ts` | admin 分支（两桶/顺序/响应感知计数） | T10 |
| `packages/api-gateway/src/gateway/gateway.controller.ts` | + `config`/`admin/*` 路由；删旧端点 | T10 |
| `apps/client/src/net/rest.ts` · `stores/game.ts` · `pages/lobby/lobby.vue` · `pages/game/game.vue` | `fetchClientConfig()` + 开关 fail-safe + 入口门控 | T11 |
| `admin/index.html` · `admin/app.js` · `admin/style.css`（新） | 管理页（无构建） | T12 |
| `deploy/Caddyfile` · `Dockerfile.edge` | `/admin` 路由（catch-all 前）+ COPY | T12 |
| `docker-compose.yml` · `docker-compose.override.yml` · `scripts/deploy/build-images.sh` · `conformance-stack.sh` | 第 8 镜像/新容器/env/计数 | T4 |
| `scripts/deploy/deploy.sh` | 按 tag 取 compose（fail-closed） | T5 |
| `tools/conformance/src/lib/http.ts` | + PUT + admin helpers（`setFriendRooms`） | T14 |
| `tools/conformance/src/slices/slice-14-config-center.ts`（新） | C1/C2/C5半/C6半/C7/C8/C13/C14/C15/C16/C17/C20 | T15 |
| `tools/conformance/src/run.ts` | 注册 slice-14 + `--fresh`（C11） | T15 |
| `.github/workflows/conformance.yml` | 循环步 env + fresh 前置步 | T15 |
| `docs/design.md` · `docs/ops/first-deploy.md` · `docs/client-protocol.md` · `README.md` · `docs/games/doudizhu.md` · `deviation-ledger.md` | 修订面全表（规格 §1 J/L3） | T17 |

## 执行顺序与依赖

```
T1（protocol 契约 + 15 收敛）
 ├─→ T2（config-service 基座）─→ T3（config-service 接口面）
 ├─→ T6（room 缓存基建）─→ T7（room 消费面）
 ├─→ T8（robot 消费面，含 E2 cache）
 ├─→ T9（gateway 鉴权缝）─→ T10（gateway 限流/转发）
 ├─→ T11（客户端）· T12（admin 页 + 门口）
 └─→ T13（user-service 退役）
T4（编排面）需 T2 命名定稿（T2 落地后即可）
T5（deploy.sh 工具链）独立，可最早开工
T14（conformance 工具 + 老切片改造）需 T3（新端点）+ T7（开关行为）——lib/http 部分可在 T1 后任意点做
T15（slice-14 + fresh）需 T1–T14 全部落地（**含 T14 的 helpers**）
T16（清单/闸/重做）需 **T5**（C21① 断言其产物）+ T13（user 退役）+ T15（同分支顺序）
T17（文档）需 T4（计数定稿）+ T15（baselines 概念）
T18（全量验收）最后
```

**并行建议**：T5 可最早独立开工；T8/T9/T11/T12 与 T6/T7 无共享文件、可并行派子 agent；T14 的 `lib/http.ts` 部分可与 T2 并行（只动 tools/conformance）。

## 判据 → 任务对照（防漏）

| 判据 | 落点 |
|---|---|
| C1 C2 C8 C13 C14 C15 C16 C17 C20 | T15（slice-14） |
| C5 | T1（parse 单测+非正）+ T3（`config.validation.test.ts`：400 不落库 + 归一化落库）+ T15（真栈 2 例） |
| C6 | T3（单测）+ T15（步骤级 unset） |
| C7 | T1（`CLIENT_CONFIG_KEYS` 单测）+ T15（真栈键集） |
| C3 C4 C9 | T6/T7（room 单测）+ T8（robot 半边） |
| C10 | T6/T7/T11/T14（既有判据改造）+ T18（复跑） |
| C11 | T15（`--fresh` + conformance.yml 前置步） |
| C12 | T2⑤（publish 失败可见）+ T3（两处并列注明） |
| C18 | T1 + T3（`config.validation.test.ts`） |
| C19 | T11（client 单测） |
| C21① | T16（slice-07.4 静态判据） |
| C21② | T18（验收：发布后演练） |

---

## Task 1: protocol 契约 + `DEFAULT_BASE_SCORE` 收敛

**Files:**
- Create: `packages/protocol/src/config.ts`
- Create: `packages/protocol/src/config.test.ts`
- Modify: `packages/protocol/src/rpc.ts`（:50-51 换行；:156-165 两型换两型）
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/src/messages.test.ts:52-64`
- Modify: `packages/protocol/src/robot-availability-wiring.gate.test.ts`（标题与头部注释；机制全包扫描已自动覆盖新包——**不改扫描逻辑**）
- Modify: `packages/shared/src/ddz/game.ts:15`（真实行：`export const DEFAULT_BASE_SCORE = 15;`——**对外名就是 `DEFAULT_BASE_SCORE`**；测试里的 `SHARED_DEFAULT_BASE_SCORE` 是局部别名，r1 计划审查订正）
- Modify: `packages/room-service/src/rooms/rooms.service.ts:48`（re-export）
- Modify: `packages/room-service/test/rooms.base-score.test.ts:150-152`（注释订正，**用例体不动**）

**Interfaces:**
- Produces: `DEFAULT_BASE_SCORE: 15`（数字字面量常量）· `CONFIG_KEYS`（九键字符串联合与数组）· `ConfigKey` 类型 · `ClientConfig = { baseScoreLevels: { name: string; baseScore: number }[]; friendRoomEnabled: boolean; version: number }` · `CLIENT_CONFIG_KEYS = ['baseScoreLevels','friendRoomEnabled','version'] as const` · `BaseScoreLevel`（`{name, baseScore}`）· `ConfigSnapshot = Record<ConfigKey, { value: unknown; version: number }>` · `parseConfigValue(key: ConfigKey, value: unknown): unknown`（**返回归一化后的值**；非法抛 `ProtocolError` 中文原因）· `RPC_PATTERNS.configSnapshot = 'config.snapshot'` · `ConfigSnapshotRequest { meta?: RpcMeta }` · `ConfigSnapshotResponse { config: ConfigSnapshot; version: number }`。
- 后置约束：`shared` 与 room-service 的 `DEFAULT_BASE_SCORE`（**对外名就是它**）均为 protocol 常量的 re-export，consumer 链（`types.test.ts` / `view.builder.ts` / `game.service.ts` / `rooms.base-score.test.ts`）**不动**。

- [ ] **Step 1: 写失败测试** —— 新建 `packages/protocol/src/config.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  CLIENT_CONFIG_KEYS,
  CONFIG_KEYS,
  DEFAULT_BASE_SCORE,
  parseConfigValue,
} from './config';

describe('九键清单与客户端子集', () => {
  it('恰好九键；客户端子集恰好三键（与真栈断言同源）', () => {
    expect(CONFIG_KEYS).toEqual([
      'robot.skillDistribution', 'robot.ruleFallback', 'robot.modelBySkill',
      'robot.reclaimIntervalMs', 'room.matchScanIntervalMs',
      'room.autostartIntervalMs', 'room.reapIntervalMs',
      'room.friendRoomEnabled', 'game.baseScoreLevels',
    ]);
    expect(CLIENT_CONFIG_KEYS).toEqual(['baseScoreLevels', 'friendRoomEnabled', 'version']);
  });
});

describe('parseConfigValue', () => {
  it('skillDistribution：三键齐全、各 ≥0、合计>0 ⇒ 归一化落库（15/35/50 ⇒ 0.15/0.35/0.5）', () => {
    expect(parseConfigValue('robot.skillDistribution', { beginner: 15, intermediate: 35, advanced: 50 }))
      .toEqual({ beginner: 0.15, intermediate: 0.35, advanced: 0.5 });
  });
  it('skillDistribution：缺档 / 为负 / 合计=0 ⇒ 抛（中文原因）', () => {
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: 1, intermediate: 1 })).toThrow(/三键齐全/);
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: -1, intermediate: 1, advanced: 1 })).toThrow(/非负|≥/);
    expect(() => parseConfigValue('robot.skillDistribution', { beginner: 0, intermediate: 0, advanced: 0 })).toThrow(/合计/);
  });
  it('ruleFallback / friendRoomEnabled：严格 boolean', () => {
    expect(parseConfigValue('robot.ruleFallback', true)).toBe(true);
    expect(() => parseConfigValue('robot.ruleFallback', 'true')).toThrow(/boolean/);
  });
  it('modelBySkill：三键齐全且值 ∈ 三档模型名', () => {
    expect(parseConfigValue('robot.modelBySkill', { beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' }))
      .toEqual({ beginner: 'sl', intermediate: 'douzero_WP', advanced: 'douzero_ADP' });
    expect(() => parseConfigValue('robot.modelBySkill', { beginner: 'gpt', intermediate: 'sl', advanced: 'sl' })).toThrow(/模型名/);
  });
  it('四个周期：整数、0 < n ≤ 600000', () => {
    for (const k of ['robot.reclaimIntervalMs', 'room.matchScanIntervalMs', 'room.autostartIntervalMs', 'room.reapIntervalMs'] as const) {
      expect(parseConfigValue(k, 5000)).toBe(5000);
      expect(() => parseConfigValue(k, 0)).toThrow();
      expect(() => parseConfigValue(k, 600001)).toThrow();
      expect(() => parseConfigValue(k, 1.5)).toThrow();
    }
  });
  it('🔴 baseScoreLevels：非空、名字非空、正整数、唯一、必须含 DEFAULT_BASE_SCORE(15)', () => {
    const ok = [{ name: '休闲场', baseScore: 15 }, { name: '标准场', baseScore: 80 }];
    expect(parseConfigValue('game.baseScoreLevels', ok)).toEqual(ok);
    expect(() => parseConfigValue('game.baseScoreLevels', [])).toThrow(/非空/);
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 0 }])).toThrow(); // 非正（C5 的「非正」输入）
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: 'X', baseScore: 80 }])).toThrow(/15/);
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: 'A', baseScore: 15 }, { name: 'B', baseScore: 15 }])).toThrow(/唯一/);
    expect(() => parseConfigValue('game.baseScoreLevels', [{ name: '', baseScore: 15 }])).toThrow(/名字/);
  });
  it('未知键 ⇒ 抛', () => {
    expect(() => parseConfigValue('nope.key' as never, 1)).toThrow();
  });
  it('DEFAULT_BASE_SCORE 是 15（唯一真源）', () => {
    expect(DEFAULT_BASE_SCORE).toBe(15);
  });
});
```

把 `packages/protocol/src/messages.test.ts:52-64` 的九 pattern 用例改成（仅换一行名字）：

```ts
it('§4.2 的九个 pattern 名逐字不变（片⑦ 把第八条换成 config.snapshot）', () => {
  expect(RPC_PATTERNS).toEqual({
    gameStart: 'game.start',
    gameView: 'game.view',
    gameSnapshot: 'game.snapshot',
    gameAction: 'game.action',
    robotAcquire: 'robot.acquire',
    robotRelease: 'robot.release',
    robotDecide: 'robot.decide',
    configSnapshot: 'config.snapshot',
    robotAvailability: 'robot.availability',
  });
});
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/protocol test` ⇒ FAIL（`./config` 不存在）

- [ ] **Step 3: 实现** —— 新建 `packages/protocol/src/config.ts`：

```ts
/**
 * 片⑦：平台配置的**契约面**（九键清单、校验函数、客户端子集、缺省底分唯一真源）。
 *
 * ⚠️ `DEFAULT_BASE_SCORE` 从这里成为**唯一真源**：`shared/ddz/game.ts` 与
 * room-service 的 `rooms.service.ts` 改为 re-export（对外名字不变）。
 * 理由：写入口的「15 必须 ∈ 档位表」校验住在本包（config-service 消费），
 * 若在此再写一份 15 就是**第三处定义**（本仓对「同一事实两处实现」付过多次代价）。
 */
import { ProtocolError } from './validate'; // 真实位置 `validate.ts:24-29`（errors.ts 无此导出——r1 计划审查订正）

export const DEFAULT_BASE_SCORE = 15;

export const CONFIG_KEYS = [
  'robot.skillDistribution',
  'robot.ruleFallback',
  'robot.modelBySkill',
  'robot.reclaimIntervalMs',
  'room.matchScanIntervalMs',
  'room.autostartIntervalMs',
  'room.reapIntervalMs',
  'room.friendRoomEnabled',
  'game.baseScoreLevels',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const CLIENT_CONFIG_KEYS = ['baseScoreLevels', 'friendRoomEnabled', 'version'] as const;

export interface BaseScoreLevel { name: string; baseScore: number }
export interface ClientConfig {
  baseScoreLevels: BaseScoreLevel[];
  friendRoomEnabled: boolean;
  version: number;
}
export type ConfigSnapshot = Record<ConfigKey, { value: unknown; version: number }>;

/** 可用模型名（三档装配，片② 定稿；与 robot-service `models.ts` 的默认映射同值）。 */
const MODEL_NAMES = ['sl', 'douzero_WP', 'douzero_ADP'] as const;
const SKILLS = ['beginner', 'intermediate', 'advanced'] as const;
const CYCLE_KEYS: readonly ConfigKey[] = [
  'robot.reclaimIntervalMs', 'room.matchScanIntervalMs', 'room.autostartIntervalMs', 'room.reapIntervalMs',
];

/** 写入校验（管理面）——非法 ⇒ 抛 ProtocolError（中文原因）；合法 ⇒ 返回**归一化后**的值。 */
export function parseConfigValue(key: ConfigKey, value: unknown): unknown {
  // 逐个键实现（规则表见规格 §2.2）；skillDistribution 归一化：各值 ≥0、三键齐全、
  // 合计 >0 ⇒ 除以合计；baseScoreLevels 校验含 DEFAULT_BASE_SCORE。
  // 未知键 ⇒ 抛。实现时保持与下方测试逐条对应。
}
```

（`parseConfigValue` 的完整实现按上面测试逐条写；`rpc.ts` 侧：把 `baseScoreLevels: 'config.baseScoreLevels'` 行换成 `configSnapshot: 'config.snapshot'`，加注释「片⑦：配置中心快照（取代旧底分 RPC）」；把 `BaseScoreLevelsRequest/Response`（:156-165）替换为：）

```ts
/** 各服务 → config-service：全量配置快照（片⑦ D1）。 */
export interface ConfigSnapshotRequest { meta?: RpcMeta }
/** `config.snapshot` 响应：每键 value+version；全局 version = MAX(每键)。 */
export interface ConfigSnapshotResponse { config: ConfigSnapshot; version: number }
```

`index.ts` 导出面同步（加 `./config` 的全部导出；删 `BaseScoreLevels*` 若有）。`shared/ddz/game.ts:15` 改为（**必须建本地绑定**——同文件 `:44` 自身要用；对外名保持 `DEFAULT_BASE_SCORE`）：

```ts
import { DEFAULT_BASE_SCORE } from '@fight-the-landlord/protocol';
export { DEFAULT_BASE_SCORE };
```

`rooms.service.ts:48` 改为（**同文件 `:222` 自用 `DEFAULT_BASE_SCORE` ⇒ 必须建本地绑定**——裸 `export {…} from` 会 TS2552；r2-F1）：

```ts
import { DEFAULT_BASE_SCORE } from '@fight-the-landlord/protocol';
export { DEFAULT_BASE_SCORE };
```

⚠️ 顺手订正两处失效注释：`shared/ddz/game.ts:13` 与 `rooms.service.ts:46` 的「同值的一对——改一个就得改另一个」（收敛后不再是一对——r2-R8）。

`robot-availability-wiring.gate.test.ts`：用例标题 `'J21①：…（九键，含 user-service 的 config.baseScoreLevels）'` 改成 `（九键，含 config-service 的 config.snapshot）`；文件头「接收侧地图」注释里 `config.baseScoreLevels → packages/user-service/…` 行改成 `config.snapshot → packages/config-service/src/rpc/config.rpc.controller.ts`。**扫描逻辑与断言不动**（全包扫描自动覆盖 config-service）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/protocol test` ⇒ PASS，**除 J21 门禁的 2 项已知窗口**（`robot-availability-wiring.gate.test.ts` 的 `J21①` 与「真实仓库零违规」：`config.snapshot` 的**接收侧**要到 T3（config-service 建 rpc controller）/T13（user-service 退场）才存在——spec §4.1:259 预裁定；T1 实测复现 = `2 failed | 6 passed`；这两项在报告与 commit message 里**显式登记为已知窗口**，T3/T13 落地后复核转绿）；`pnpm --filter @fight-the-landlord/protocol run lint` ⇒ 0 error；再 `pnpm --filter @fight-the-landlord/shared test` 与 `pnpm --filter @fight-the-landlord/room-service test`（`rooms.base-score.test.ts` 仍须绿——re-export 后同值对同义反复，把 `:150-152` 的「判别力自证」注释改成「改 `packages/protocol/src/config.ts` 的 `DEFAULT_BASE_SCORE` ⇒ ②∈表 当场红」）；⚠️ **窗口②（T1 实测登记；T1 审查补宽）**：room-service / user-service 的 `run lint`（tsc）在其消费点改完前会红（`config.client.ts` / `base-score-levels.rpc.controller.ts` 引用已删除的导出）——分别由 **T6 / T13** 闭合；**test 侧同引**（`test/config.client.test.ts` / `test/base-score-levels.rpc.test.ts`，窗口内断言为同义反复）实际也含已删键，两包 lint 首段失败 ⇒ test 段未执行；两包**单测**不受影响；⚠️ protocol 有 **dist 消费链**——若下游包报 TS 解析错，先 `pnpm run ci` 或 turbo 构建一次让 dist 新鲜（r2 微瑕）

- [ ] **Step 5: 提交**

```bash
git add packages/protocol/src/config.ts packages/protocol/src/config.test.ts packages/protocol/src/rpc.ts packages/protocol/src/index.ts packages/protocol/src/messages.test.ts packages/protocol/src/robot-availability-wiring.gate.test.ts packages/shared/src/ddz/game.ts packages/room-service/src/rooms/rooms.service.ts packages/room-service/test/rooms.base-score.test.ts
git commit -m "feat(protocol): 九键契约与 parseConfigValue；config.snapshot 取代 config.baseScoreLevels；DEFAULT_BASE_SCORE 收敛为唯一真源（J21 接收侧 2 项为已知窗口，T3/T13 后转绿）"
```

---

## Task 2: config-service 基座（包骨架 / 数据层 / 迁移 / 健康 / 镜像）

**Files:**
- Create: `packages/config-service/package.json` · `tsconfig.json`
- Create: `packages/config-service/src/main.ts` · `src/app.module.ts` · `src/database.config.ts` · `src/data-source.ts`
- Create: `packages/config-service/src/config/platform-config.entity.ts` · `src/config/platform-config.service.ts`
- Create: `packages/config-service/src/migrations/1789200000000-PlatformConfig.ts`
- Create: `packages/config-service/src/health/`（真实形态：user-service **只有** `health.controller.ts` + `health.service.ts`、**无 module 文件** ⇒ 同形态写两文件、装配并入 app.module）· `src/http/{internal-token.middleware,errors}.ts` · `src/redis/redis.module.ts`（真实名**无 `provider`**；⚠️ 其 `:3` 从 `../auth/token.service` 取 `REDIS` 令牌 ⇒ config-service 需**自建最小 token 提供**（复制 user-service `auth/token.service.ts` 的 REDIS 相关最小面）——逐字克隆编译不过（r1 计划审查 I-8））
- Create: `packages/config-service/test/platform-config.service.test.ts` · `test/migration.test.ts`
- Create: `Dockerfile.config-service`（照 `Dockerfile.user-service`）

**Interfaces:**
- Consumes: T1 的 `CONFIG_KEYS`/`parseConfigValue`/`ConfigSnapshot`。
- Produces: `PlatformConfigService`：`list(): Promise<{ key: ConfigKey; value: unknown; version: number }[]>`（每次查库、不缓存）· `get(key): Promise<{value; version} | null>` · `set(key: ConfigKey, value: unknown, updatedBy: string): Promise<{ version: number; announced: boolean }>`（校验→事务 upsert→PUBLISH `config:changed`）。端口：HTTP 3006 / RPC 3106。

- [ ] **Step 1: 写失败测试** —— `test/platform-config.service.test.ts`（数据层用 TypeORM 的测试替身或真库由实现者按 `user-service` 既有测试形态选择——**先读 `packages/user-service/test/base-score-levels.test.ts` 的夹具形态照抄**）：覆盖 ① `list()` 首查命中九键（用真迁移跑出的库或 mock repo，见上）② `set()` 首写：INSERT 从 version 1、`list` 可见新值 ③ **并发首建同键**：两次 `set` 都成功且 version 严格递增 ④ **同键并发（Promise.all 两写）**：version = v0+2、终值=其一（C13 单测半边）⑤ publish 抛错 ⇒ 返回 `{announced:false}` 且值已落库（C12）⑥ 未知键/非法值 ⇒ 抛 `ProtocolError` 且不落库（C5 半边）。`test/migration.test.ts`：照 `user-service/test/migration.test.ts` 形态断言 `platform_config` **五列**（key/value/version/updated_at/updated_by——spec §2.1）与九行种子（值逐字对照 §2.2）。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/config-service test` ⇒ FAIL（包不存在；先建包骨架后红在实现缺失）

- [ ] **Step 3: 实现** —— 关键片段（其余照 user-service 克隆）：

`src/database.config.ts`（与 user-service 逐字同形的差异只在文件名/注释/下面这行）：

```ts
    /** 片⑦：与 user-service 共库 ⇒ 迁移表**必须**独立（否则互相把对方的记录当「未知已执行」）。 */
    migrationsTableName: 'migrations_config',
```

`src/config/platform-config.service.ts` 的写入核心：

```ts
  /** 写：校验（protocol）→ 事务内 version+1 → publish（失败不拦写、announced 如实）。 */
  async set(key: ConfigKey, value: unknown, updatedBy: string): Promise<{ version: number; announced: boolean }> {
    const normalized = parseConfigValue(key, value); // 非法 ⇒ ProtocolError（调用方 400）
    const version = await this.repo.manager.transaction(async (em) => {
      // 行锁自增：UPDATE ... SET value=?, version=version+1, updated_at=NOW(3), updated_by=? WHERE `key`=?
      // affected=0 ⇒ INSERT（version 1）；并发首建冲突 ⇒ 重试一次 UPDATE（唯一键冲突兜底）。
    });
    let announced = true;
    try { await this.redis.publish(CONFIG_CHANGED_CHANNEL, JSON.stringify({ keys: [key] })); }
    catch (err) { announced = false; this.logger.warn(`config publish failed: ${...}`); } // C12
    return { version, announced };
  }
```

`src/main.ts` 照 user-service 克隆，**TCP 监听顺序照 `game-service/src/main.ts`**（spec A2 口径）（fail-closed `INTERNAL_SERVICE_TOKEN`；logger `{ service: 'config-service' }`；`PORT ?? '3006'`；`RPC_PORT ?? '3106'`）。迁移 `1789200000000-PlatformConfig.ts`：建表 DDL 逐字用规格 §2.1；种子九键（`INSERT ... VALUES` 九行，`value` 用 `CAST('…' AS JSON)` 或直接 JSON 字面量——与 MySQL 8 的 json 列兼容写法照 migration 实际跑通为准）。`Dockerfile.config-service` 照 `Dockerfile.user-service` 改包名与构建目标。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/config-service test` ⇒ PASS；`run lint` ⇒ 0 error；**本机起库验证迁移**：`docker compose build config-service && docker compose up -d mysql config-service` ⇒ `docker exec ftl-mysql mysql -uroot -proot fight_the_landlord -e "SELECT \`key\`,version FROM platform_config"` ⇒ 九行 version=1

- [ ] **Step 5: 提交**

```bash
git add packages/config-service Dockerfile.config-service
git commit -m "feat(config-service): 新服务基座 —— platform_config 迁移（九键种子）+ 版本化读写 + publish；镜像骨架"
```

---

## Task 3: config-service 接口面（子集 / 管理面 / 管理令牌 / RPC）

**Files:**
- Create: `packages/config-service/src/config/client-config.controller.ts` · `src/config/admin.controller.ts` · `src/config/admin-auth.service.ts` · `src/rpc/config.rpc.controller.ts` · `src/config/config.module.ts`
- Modify: `packages/config-service/src/app.module.ts`
- Create: `packages/config-service/test/admin-auth.test.ts` · `test/client-config.test.ts` · `test/admin.controller.test.ts` · `test/config.validation.test.ts`（**C5/C18 本体**：parse 非正输入 + **归一化落库断言**——PUT `robot.skillDistribution` 为 `{15,35,50}` ⇒ 200 且 `GET /api/admin/config` 存 `0.15/0.35/0.5`；PUT levels 不含 15 ⇒ 400）

**Interfaces:**
- Consumes: T2 的 `PlatformConfigService`；T1 的 `CLIENT_CONFIG_KEYS`/`ConfigSnapshotResponse`/`RPC_PATTERNS.configSnapshot`。
- Produces: `GET /api/config`（子集三键）· `POST /api/admin/login`（未设口令=unset 或空串 ⇒ **404**；错口令 ⇒ 401 不签；成功 ⇒ `{token, expiresIn:7200}`）· `GET /api/admin/config`（全量，含每键 version）· `PUT /api/admin/config/:key`（`{saved:true, announced, version}`）；`AdminAuthService.verifyPassword`（`crypto.timingSafeEqual`）与 `signToken/verifyToken`（aud `ftl-admin`）；`ConfigRpcController`（`@MessagePattern(RPC_PATTERNS.configSnapshot)`，响应 `{config, version}`，全局 version=MAX）。所有 `/api/admin/*` 路由 fail-closed 校验 `X-Admin: 1`（login 除外）。

- [ ] **Step 1: 写失败测试** —— `test/admin-auth.test.ts`：① 未设口令（`delete process.env.ADMIN_PASSWORD`）⇒ `login` 404 ② 错口令 ⇒ 401 且响应**无** token 字段（C6）③ 正确口令 ⇒ 200 + token 可被 `verifyToken` 验、`aud='ftl-admin'`、`exp-iat=7200` ④ 常数时间比较路径存在（源码级：`timingSafeEqual` 被调用——照 `admin-auth.service.ts` 的实现用 spy 或读源）。`test/client-config.test.ts`：`GET /api/config` 的 data 键集**恰好** `CLIENT_CONFIG_KEYS`（C7 半边）+ 值形状。`test/admin.controller.test.ts`：无 `X-Admin` ⇒ 401；`X-Admin: 1` + `PUT` 非法值 ⇒ 400 且 `PlatformConfigService.list` 里值未变（C5 集成半边）；成功 PUT ⇒ `{saved:true, announced, version}`。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/config-service test` ⇒ FAIL

- [ ] **Step 3: 实现** —— `admin-auth.service.ts` 核心：

```ts
  /** 常数时间比较；ENV 未设或空串 ⇒ null（调用方回 404「管理面未启用」——规格 §2.2/§D6）。 */
  private readonly password = (process.env.ADMIN_PASSWORD ?? '') || null;
  verifyPassword(input: string): boolean {
    if (!this.password) return false;                       // 未启用由 controller 分流成 404
    const a = Buffer.from(input), b = Buffer.from(this.password);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  signToken(): string {
    return new JwtService({ secret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production' }) // ⚠️ || 非 ??：compose 空串透传下 ?? 不回落 ⇒ 登录 500（T9 实拍补登）
      .sign({}, { audience: 'ftl-admin', expiresIn: '2h' });
  }
```

`admin.controller.ts`：三个路由 + `X-Admin` guard（`login` 单条豁免；guard 逻辑写成**可单测的纯函数**或 Nest guard，规格要求「豁免恰好一条」——判据由 T9 的网关侧测试与 C6 覆盖）。`client-config.controller.ts`：读 `list()` → 组装三键（`version` = MAX）。`config.rpc.controller.ts`：`@MessagePattern(RPC_PATTERNS.configSnapshot)` 返回 `ConfigSnapshotResponse`。`config.module.ts` 装配并 export `PlatformConfigService`；`app.module.ts` 挂控制器与 RPC。

- [ ] **Step 4: 跑测试确认绿** —— 同上 + `run lint`；**真容器烟测**：`docker compose build config-service && docker compose up -d config-service` ⇒ `curl -s http://localhost:3006/api/admin/login -X POST -H 'content-type: application/json' -d '{"password":"x"}'`（dev 形态；未配口令时预期 404）

- [ ] **Step 5: 提交**

```bash
git add packages/config-service
git commit -m "feat(config-service): 三接口面 —— 客户端子集 / 管理面（404/401/400 + announced）/ config.snapshot RPC"
```

---

## Task 4: 编排面（第 8 镜像 / compose / override / 栈脚本）

**Files:**
- Modify: `docker-compose.yml`（config-service 块 + room `:206-207` 换 env + room/robot 测试 env 透传 + robot 删 `:301-302` + gateway 加 `CONFIG_SERVICE_URL` + 头注释计数 + 软依赖注释）
- Modify: `.github/workflows/images.yml:1/:31`（「7 个自建镜像」/「构建并推送 7 个镜像」→8）· `release.yml:43`（同文案→8）与 `:82`（「7 个服务镜像 ≈4.9GB」→8——60 分钟算术注释同步）· `ci.yml:39` 与 `conformance.yml:49`（「不构建 5 个服务」→6）（r1 计划审查 I-3）
- Modify: `tools/conformance/src/slices/slice-07.4-pipeline.ts:693-699`（compose 带 `build:` 服务**恰好** 7 → **8** + 消息同步——该断言在 `render` 列（每次 push 的 render-gate 都跑）⇒ **必须与 compose 改动同提交**，否则 T4 落地即红；r1 计划审查 I-6）
- Modify: `docker-compose.override.yml`（config-service 块：`3106:3106` + `ADMIN_PASSWORD: ${ADMIN_PASSWORD:-}` + `INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN:-dev-internal-token-change-in-production}`；`:46` 注释更新；**头 `:12-13` 计数**（「仍是 8 个容器…第 9 个（门口）」→「9 个容器…第 10 个（门口）」——r1-M7））
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:552/:559-561`（BUILD_SERVICES 7→8 + 消息「恰好这 7 个」→8——该断言在 `render` 列、每 push 跑 ⇒ **与 compose 同提交**；r2-F2）
- Modify: `scripts/deploy/build-images.sh:2/:32`（7→8）
- Modify: `scripts/deploy/conformance-stack.sh:18`（SERVICES 加 `config-service`，字典序）+ 顶部 `export ADMIN_PASSWORD="${ADMIN_PASSWORD:-conformance-admin-pass}"`

**Interfaces:**
- Consumes: T2 的端口/容器名（`ftl-config-service`、3006/3106）。
- Produces: 可渲染的双形态 compose；`conformance-stack.sh` 起 8 服务；测试口令 `conformance-admin-pass`（与 `lib/http.ts` 常量两处同源，T14 落）。

- [ ] **Step 1: 写失败测试（渲染级）** —— 本任务无单测；以小步验证替代：先只加 compose 的 config-service 块（照 user-service 块逐段：`build/dockerfile: Dockerfile.config-service`、`image: ${IMAGE_PREFIX:-pokergame}-config-service:${IMAGE_TAG:-latest}`、`container_name: ftl-config-service`、logging 块、`expose: ["3006","3106"]`、env（`DB_*`、`REDIS_URL=redis://redis:6379`、`RPC_PORT=3106`、`INTERNAL_SERVICE_TOKEN=${INTERNAL_SERVICE_TOKEN:-}`、`ADMIN_PASSWORD=${ADMIN_PASSWORD:-}`、`ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET:-}`）、`depends_on: mysql/redis healthy`、healthcheck `curl -f http://localhost:3006/api/health`、networks）

- [ ] **Step 2: 渲染验证** —— `docker compose -f docker-compose.yml config >/dev/null && docker compose config >/dev/null`（两形态都渲染通过）+ `docker compose -f docker-compose.yml config --services | sort` ⇒ 十项（含 config-service、edge）

- [ ] **Step 3: 其余编排改动** —— ① room-service env（`:206-207`）：`USER_SERVICE_RPC_HOST`/`USER_SERVICE_RPC_PORT` 两行换成 `CONFIG_SERVICE_RPC_HOST=config-service` / `CONFIG_SERVICE_RPC_PORT=3106`（注释同步：room→config 读快照）；② room/robot 各加两行测试 env 透传（`CONFIG_SYNC_SAFETY_NET_MS=${CONFIG_SYNC_SAFETY_NET_MS:-}` / `CONFIG_SYNC_DISABLE_PUSH=${CONFIG_SYNC_DISABLE_PUSH:-}`，注释「仅测试注入；空串=未设」）；③ robot 删 `:301-302`；④ api-gateway env 加 `CONFIG_SERVICE_URL=http://config-service:3006`；⑤ **compose 头注释计数**（`其余 8 个服务`→9；`生产部署…9 个服务：8 + 门口`→`10 个服务：9 + 门口`）；⑥ **软依赖注释**（在 config-service 块附近：为什么不加 `depends_on` 硬门——D8-3/§5.2-9）；⑦ override 整块 + `:46` 注释 + **override 头 `:12-13` 计数**；⑧ 两个脚本计数与 SERVICES/口令 export；⑨ **工作流计数六行 + slice-07.4 的 `:693-699` + slice-07.2-deploy 的 `:552/:559-561`**（见 Files——与 compose **同一提交**，三者都在 `render` 列、每 push 跑）；⑩ `RPC_PORTS` 换键（slice-07.2-deploy `:141-146`）**随 T13**（用户退役）一起改——config 的 expose/override 在本任务已就位 ⇒ T13 换键即刻全绿（r2-F2 的 A 方案）。**不许两边都不改。**

- [ ] **Step 4: 真栈验证（本机）** —— `docker compose build && docker compose up -d --wait`（dev 形态）⇒ `docker compose ps` 全部 healthy（9 常驻）+ `curl -s http://localhost:3006/api/health` ⇒ `checks.redis/mysql up`；`bash scripts/deploy/conformance-stack.sh down` 收尾干净

- [ ] **Step 5: 提交**

```bash
git add docker-compose.yml docker-compose.override.yml scripts/deploy/build-images.sh scripts/deploy/conformance-stack.sh .github/workflows/images.yml .github/workflows/release.yml .github/workflows/ci.yml .github/workflows/conformance.yml tools/conformance/src/slices/slice-07.4-pipeline.ts tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "chore(compose): 第 8 镜像 config-service + room/robot/gateway env 与测试透传；计数与软依赖注释"
```

---

## Task 5: deploy.sh 按 tag 取 compose（回滚工具链修复）

**Files:**
- Modify: `scripts/deploy/deploy.sh`（在 `--assert-clean` 早退块 `:36-81` **之后**、scp compose `:106` 之前插入「按 tag 取 compose」段；scp 改送该文件）

**Interfaces:**
- Produces: 远端 `/srv/pokergame/docker-compose.yml` 的内容来源 = `refs/tags/${TAG}:docker-compose.yml`（**变量真名是 `TAG`**——`deploy.sh:83`；`$IMAGE_TAG` 是 CI 侧变量、远端脚本里不存在，写它会永假；r1 计划审查 I-4）（取不到 ⇒ 报错 + `exit 1`）；覆盖三路（CI push / CI dispatch / 本机 `rollback.sh:37` 转发）。

- [ ] **Step 1: 写失败验证** —— 先证明现状会坏：`git show "refs/tags/v1.2.0:docker-compose.yml" | grep -c config-service` ⇒ **0**（旧 tag 无它）；`git show "refs/tags/v9.9.9-nope:docker-compose.yml"` ⇒ exit 128（fail-closed 的依据）

- [ ] **Step 2: 实现** —— 插入段（本地展开、`set -e` 友好）：

```bash
# ── 片⑦（裁决 9 / D8-5）：送机 compose = **目标 tag 自己的**，不是本检出 ─────────────
# ⚠️ 必须放在 `--assert-clean` 早退块**之后**（那块是独立入口，不得被 git 操作拖累）。
# ⚠️ 失败 ⇒ 响亮失败（fail-closed）：不静默回退到本检出（那正是「回滚送 master compose
#    ⇒ 拉不存在的 config-service:旧tag ⇒ 中止」的根因，r2 实测）。
git fetch --tags --force >/dev/null 2>&1 || true
COMPOSE_DEPLOY="$(mktemp)"
if ! git show "refs/tags/${TAG}:docker-compose.yml" > "$COMPOSE_DEPLOY" 2>/dev/null; then
  printf '❌ [deploy] 取不到 tag %s 的 docker-compose.yml（回滚目标版本不存在？）——拒绝继续\n' "$TAG" >&2
  exit 1
fi
trap 'rm -f "$COMPOSE_DEPLOY"' EXIT
```

`scp` 行改为 `scp … "$COMPOSE_DEPLOY" "$TARGET:$REMOTE_DIR/docker-compose.yml"`（远端**文件名不变**——`--assert-clean` 的两文件纪律不破）。

- [ ] **Step 3: 本地验证（干跑）** —— `bash -n scripts/deploy/deploy.sh` 语法通过；在临时目录模拟：`TAG=v1.2.0` 跑取文件逻辑 ⇒ 得到旧 compose；`TAG=v9.9.9-nope` ⇒ 走 exit 1 分支并打印错误（以 `bash -c` 带桩覆盖 ssh/scp 命令即可，或直接手工执行两段 `git show`）；把 `TAG=v1.2.0` 取出的 compose 与 `docker compose -f - config --services` 对一眼 ⇒ 无 config-service

- [ ] **Step 4: 提交**

```bash
git add scripts/deploy/deploy.sh
git commit -m "fix(deploy): 送机 compose 改为按目标 tag 从 git 取（fail-closed）——跨配置中心边界回滚恢复一键可用"
```

---

## Task 6: room-service 配置缓存基建（RPC 客户端 + 缓存服务 + rpc.options）

**Files:**
- Modify: `packages/room-service/src/gateway/config.client.ts`（`levels()`(:55-85) → `snapshot()`）
- Create: `packages/room-service/src/config/config-cache.service.ts` · `src/config/config-cache.module.ts`
- Modify: `packages/room-service/src/gateway/rpc.options.ts:32-41`（`USER_SERVICE_RPC_HOST/PORT` → `CONFIG_SERVICE_RPC_HOST/PORT`，默认 `config-service`/`3106`）
- Modify: `packages/room-service/test/no-internal-http.gate.test.ts:75-76`（`RPC_USAGE` 枚举 `baseScoreLevels` → **`configSnapshot`**——T6 把 `config.client.ts` 的调用改名后，该闸的正向断言（:170-176：RPC_CLIENTS 每个文件必须命中）会红；r1 计划审查 I-1）
- Modify: `packages/room-service/src/app.module.ts`（装配 `ConfigCacheModule`）
- Modify: `packages/room-service/test/config.client.test.ts`
- Create: `packages/room-service/test/config-cache.test.ts`

**Interfaces:**
- Consumes: T1 的 `RPC_PATTERNS.configSnapshot` / `ConfigSnapshotResponse` / `ConfigKey`；`ConfigServiceError` 与 `TRANSPORT_FAILURE_MESSAGE`（`gateway/transport-failure.ts`）沿用。
- Produces:
  - `ConfigClient.snapshot(): Promise<ConfigSnapshotResponse>`（3s 超时、不重试；传输失败 ⇒ `ConfigServiceError(10007, TRANSPORT_FAILURE_MESSAGE)`——**逐字保持** `levels()` 的失败形状）。
  - `ConfigCacheService`：`friendRoomEnabled(): boolean`（缺失 ⇒ **false**）· `baseScoreLevels(): Promise<{name;baseScore}[]>`（缓存空 + 即时拉取失败 ⇒ **抛 `ConfigServiceError(10007)`**；有旧值 ⇒ 返回旧值）· `cycleMs(key: 'room.matchScanIntervalMs'|'room.autostartIntervalMs'|'room.reapIntervalMs'): number`（缺失 ⇒ 5000/5000/60000）· `waitForFirstSnapshot(): Promise<void>`（测试用）。
  - 行为：`onModuleInit` → 拉快照（失败 ⇒ **1s 退避重试直到首次成功**，不阻塞就绪）→ 订阅 `config:changed`（🔴 **专用连接**：`new Redis(process.env.REDIS_URL)`——既有 provider 复用会破 subscribe 模式）→ **60s 安全网自重排**（收通知/每轮都重拉全量换缓存；版本不前进也换，简单优先）。
  - 测试 env（**空串=未设**，`||` 不用 `??`）：`CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）· `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，变异用）。

- [ ] **Step 1: 写失败测试** —— 先读 `packages/room-service/test/match.service.test.ts` 的 Redis 替身形态（`createFakeRedis`/`asRedis` 一类）**照抄夹具**，再写 `test/config-cache.test.ts`：

```ts
// 覆盖（夹具：假 ConfigClient 可控成功/失败 + vi.useFakeTimers + 既有假 Redis）：
it('C3：拉取失败 + 空缓存 ⇒ 服务照常（不抛不 exit），热项取默认值', async () => {
  client.snapshot = vi.fn().mockRejectedValue(new Error('down'));
  const cache = new ConfigCacheService(client, fakeRedis);
  await expect(cache.onModuleInit()).resolves.toBeUndefined();
  expect(cache.friendRoomEnabled()).toBe(false);          // 默认 false（安全方向）
  expect(cache.cycleMs('room.matchScanIntervalMs')).toBe(5000);
});
it('C4：空缓存 + 拉失败 ⇒ baseScoreLevels() 抛 ConfigServiceError(10007)', async () => { /* 断言 err.code === ErrCode.UPSTREAM_UNAVAILABLE */ });
it('C4b：缓存有旧值 ⇒ 用旧值、不抛', async () => { /* 先成功拉一次，再让 client 变红，断言返回旧值 */ });
it('通知 ⇒ 重拉并换缓存（版本前进）', async () => { /* 触发订阅回调，断言 getter 反映新值 */ });
it('安全网：CONFIG_SYNC_SAFETY_NET_MS=100 ⇒ 每 100ms 无条件重拉（假时钟）', async () => { /* vi.advanceTimersByTimeAsync */ });
it('CONFIG_SYNC_DISABLE_PUSH 非空 ⇒ 不建订阅连接（变异开关可控）', async () => { /* 断言未 new Redis / 未 subscribe —— 用 spy */ });
it('空串 env = 未设：CONFIG_SYNC_SAFETY_NET_MS="" ⇒ 走 60000 默认', async () => { /* 规格 I1 解析纪律 */ });
```

`test/config.client.test.ts`：把 `levels()` 用例改成 `snapshot()`（RPC 名/载荷形状逐条改；**失败语义用例不动**——那是本片要保的性质）。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/room-service test` ⇒ FAIL

- [ ] **Step 3: 实现** —— `config.client.ts`：`levels()` 改名 `snapshot()`，`send` 的 pattern 换 `RPC_PATTERNS.configSnapshot`，返回 `res.data`；其余（try/catch、10007、日志脱敏）**逐字保留**。`config-cache.service.ts` 骨架：

```ts
@Injectable()
export class ConfigCacheService implements OnModuleInit, OnApplicationShutdown {
  private snapshot: ConfigSnapshot | null = null;
  private subscriber: Redis | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** ⚠️ 空串=未设（compose 是空默认透传）：|| 语义。 */
  private readonly safetyNetMs = Number(process.env.CONFIG_SYNC_SAFETY_NET_MS) || 60_000;
  private readonly pushDisabled = (process.env.CONFIG_SYNC_DISABLE_PUSH ?? '') !== '';

  onModuleInit(): void {
    void this.pullWithRetry();                       // 1s 退避直到首次成功（不阻塞）
    if (!this.pushDisabled) this.startSubscription(); // 专用连接
    this.scheduleSafetyNet();                         // 60s 自重排、无条件重拉
  }
  private scheduleSafetyNet(): void {
    this.safetyTimer = setTimeout(() => { void this.refreshOnce().finally(() => this.scheduleSafetyNet()); }, this.safetyNetMs);
  }
  friendRoomEnabled(): boolean { return this.readBool('room.friendRoomEnabled', false); }
  cycleMs(key: CycleKey): number { /* 读 snapshot；缺失/非数 ⇒ 默认（5000/5000/60000） */ }
  async baseScoreLevels(): Promise<BaseScoreLevel[]> {
    const cached = this.readLevels();                // 非空数组 ⇒ 直接返回（哪怕旧）
    if (cached) return cached;
    await this.refreshOnce();                        // 空缓存 ⇒ 即时拉一次（失败 ⇒ throw）
    const again = this.readLevels();
    if (again) return again;
    throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
  }
}
```

`onApplicationShutdown`：清两个 timer + `subscriber?.quit()`。`rpc.options.ts` 按文件内既有形态改两行默认值（`'config-service'` / `'3106'`）。`app.module.ts` 装配（**值导入** `ConfigCacheService`，DI 陷阱纪律）。

- [ ] **Step 4: 跑测试确认绿** —— 同上 ⇒ PASS；`run lint` ⇒ 0 error

- [ ] **Step 5: 提交**

```bash
git add packages/room-service/src/gateway/config.client.ts packages/room-service/src/gateway/rpc.options.ts packages/room-service/src/config packages/room-service/src/app.module.ts packages/room-service/test/config-cache.test.ts packages/room-service/test/config.client.test.ts
git commit -m "feat(room): 配置快照缓存（启动重试/专用订阅/60s 安全网/测试 env）+ config.snapshot 客户端"
```

---

## Task 7: room-service 消费面（三面拒绝 / 底分走缓存 / 四处自重排）

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.controller.ts`（`create()`(:41) 与 `join()`(:56) 开头拒 `12006`；`findAll()`(:24) 开关关 ⇒ 返 `[]`）
- Modify: `packages/room-service/src/rooms/rooms.service.ts`（`create()` 的 `configClient.levels()`(:193) → `configCache.baseScoreLevels()`；构造注入换 `ConfigCacheService`）
- Modify: `packages/room-service/src/match/match.service.ts`（构造 `config: ConfigClient` → `configCache: ConfigCacheService`；`assertKnownBaseScore()`(:242) 改缓存；`scanIntervalMs`(:127) 删；`startMatchingLoop()`(:286) 自重排）
- Modify: `packages/room-service/src/rooms/rooms.autostart.ts`（`AUTOSTART_SCAN_INTERVAL_MS`(:9) 删；循环自重排）
- Modify: `packages/room-service/src/rooms/rooms.reaper.ts`（`REAP_INTERVAL_MS`(:9) 删；循环自重排）
- Modify: `packages/room-service/src/rooms/rooms.module.ts` · `src/rooms/start.module.ts`（按需装配 `ConfigCacheModule`）
- Create/Modify: `test/rooms.controller-switch.test.ts`（新）· `test/config-cache.test.ts`（C9 三处自重排补测）· `test/match.service.test.ts`（正对照一条）

**Interfaces:**
- Consumes: T6 的 `ConfigCacheService`。
- Produces: 三面行为（throw `DomainError(ErrCode.FRIEND_ROOM_FAILED, '好友房暂未开放')`）；四处循环均「当前一轮按旧值跑完 ⇒ 其后按新值排下一轮」。

- [ ] **Step 1: 写失败测试** —— 先读 `test/match.service.test.ts` 与（若存在）`test/rooms.controller.test.ts` 的真实夹具形态，照抄。新用例：

```ts
// rooms.controller-switch.test.ts（构造 controller，mock cache.friendRoomEnabled）
it('C8①：开关关 ⇒ POST /api/rooms 抛 12006（拒绝在 controller 入口）', async () => {
  cache.friendRoomEnabled.mockReturnValue(false);
  await expect(controller.create({ mode: 'random' })).rejects.toMatchObject({ code: ErrCode.FRIEND_ROOM_FAILED });
});
it('C8②：开关关 ⇒ join 抛 12006', async () => { /* 同上 */ });
it('C8③：开关关 ⇒ findAll 返回空数组（code 0、data []）', async () => {
  expect(await controller.findAll()).toEqual({ code: ErrCode.OK, data: [] });
});
it('C8 正对照：开关关时匹配路径不受影响（createGameRoom 照常建局）', async () => {
  // 用 match.service 既有夹具：cache.friendRoomEnabled=false，走一轮配对 ⇒ roomsService.create 被调用（无开关检查）
});
```

`config-cache.test.ts` 补 C9 三条（三处循环，模板见 Step 3）。既有依赖 `ConfigClient` 的测试（`rooms.base-score.test.ts` 若构造 `new RoomsService(..., configClient, ...)`）**同步把替身换成 ConfigCacheService**（先全仓 grep `ConfigClient` 找齐构造点——本仓血训：构造点连续性漏三回）。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/room-service test` ⇒ FAIL

- [ ] **Step 3: 实现** —— controller（三处，落层=**controller 入口**，不进共用 `create()`）：

```ts
  @Get()
  async findAll() {
    if (!this.configCache.friendRoomEnabled()) return { code: ErrCode.OK, data: [] };
    // …既有实现
  }
  @Post()
  async create(@Body() dto: CreateRoomDto) {
    if (!this.configCache.friendRoomEnabled()) throw new DomainError(ErrCode.FRIEND_ROOM_FAILED, '好友房暂未开放');
    // …既有实现（catch 照旧 toHttpException）
  }
  @Post(':code/join')
  async join(...) { if (!this.configCache.friendRoomEnabled()) throw new DomainError(...); ... }
```

`rooms.service.ts`：构造参数 `private readonly configClient: ConfigClient` → `private readonly configCache: ConfigCacheService`（**值导入**）；`:193` 改 `await this.configCache.baseScoreLevels()`（**catch 块与 10007 翻译逐字不动**）。`match.service.ts`：`assertKnownBaseScore()` 的 `this.config.levels()` 同步换。四处循环转换（**同构模板**；`runOnce` = 把既有回调体**提出为私有方法**（保持既有 `runWithTrace` 包裹在方法内与既有轮级 catch 语义）；match 侧若 `scanAndMatch` 已可直调则用它、不强改名的——四处逐一对照其真实结构，r1-M11）：

```ts
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduleNext(): void {
    // 口径（M-6/C9）：当前一轮按旧值跑完，其后按新值排下一轮。
    this.timer = setTimeout(() => { void this.runOnce().finally(() => this.scheduleNext()); },
      this.configCache.cycleMs('room.autostartIntervalMs'));  // reaper: 'room.reapIntervalMs'；match: 'room.matchScanIntervalMs'
  }
  onApplicationShutdown(): void { if (this.timer) clearTimeout(this.timer); }
```

C9 测试模板（三处循环各一条，假时钟）：

```ts
it('C9：改小后下一轮生效（当前一轮按旧值跑完）', async () => {
  vi.useFakeTimers();
  cache.cycleMs.mockReturnValue(1000);
  task.startScanLoop();                       // 改名/形态以真实方法为准
  await vi.advanceTimersByTimeAsync(1000);    // 第 1 轮（按旧值 1000）
  cache.cycleMs.mockReturnValue(100);         // 改小
  await vi.advanceTimersByTimeAsync(100);     // 第 2 轮（按新值 100）
  expect(workSpy).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/room-service test` ⇒ PASS；`run lint` ⇒ 0 error；**全仓 grep `UserServiceRpc\|USER_SERVICE_RPC` 应零命中**

- [ ] **Step 5: 提交**

```bash
git add packages/room-service
git commit -m "feat(room): 好友房开关三面（controller 入口）+ 底分走缓存（10007 语义不变）+ 四处循环自重排"
```

---

## Task 8: robot-service 消费面（env 退役 / 四键缓存 / J29 白名单）

**Files:**
- Modify: `packages/robot-service/src/robot/config.ts`（**env 解析退役**：删 `parseRuleFallback` 与 `getRobotConfig` 的 env 读取；保留 `DEFAULT_SKILL_DISTRIBUTION` 常量与 `parseSkillDistribution` 纯函数（无 env 参数形态按实现需要收窄，测试同步））
- Create: `packages/robot-service/src/config/config-cache.service.ts` · `config-cache.module.ts`（克隆 T6 的，键换 `robot.skillDistribution`/`robot.ruleFallback`/`robot.modelBySkill`/`robot.reclaimIntervalMs`；getter：`skillDistribution(): ReadonlyArray<readonly [SkillLevel, number]>`（从 JSON 对象转既有有序对形态；缺失 ⇒ 默认解析）、`ruleFallback(): boolean`（默认 true）、`modelBySkill(): Record<SkillLevel, string>`（默认 = `models.ts` 的映射）、`reclaimIntervalMs(): number`（默认 60000））
- Modify: `packages/robot-service/src/robot/robot.pool.ts`（抽档处：`getRobotConfig().skillDistribution` → `configCache.skillDistribution()`）
- Modify: `packages/robot-service/src/robot/douzero.health.ts:25`（`getRobotConfig().ruleFallback` → `configCache.ruleFallback()`——**探测门禁**，不是决策路径）
- Modify: `packages/robot-service/src/robot/bot.player.ts:140`（**决策路径**的模型装配读点——`buildDouZeroContext` 组装发给 DouZero 的请求；`modelBySkill` **必须**接这里，否则 /admin 改键后模型不随动而日志字面变化（静默无效）——r1 计划审查 X-3）
- Modify: `packages/robot-service/src/robot/robot.service.ts:55`（**日志行**的 `MODEL_BY_SKILL` 读取点——随 cache 同步，但注意它不是决策点）
- Modify: `packages/robot-service/src/robot/robot.reclaim.task.ts`（`:8` env 删；循环自重排 + `configCache.reclaimIntervalMs()`）
- Modify: `packages/robot-service/src/robot/robot.module.ts` · `src/app.module.ts`（装配）
- Modify: `packages/robot-service/test/robot.config.test.ts`（env 语义退役：删 fail-closed 相关用例——**显式登记**，语义继受 = C5）· `test/douzero.health.test.ts` · `test/robot.pool.test.ts` · `test/no-switch-in-decision.gate.test.ts`（**白名单/断言同步**——先读它的扫描谓词再改）· Create: `test/config-cache.test.ts`

**Interfaces:**
- Consumes: T6 的缓存模板与 T1 契约。
- Produces: 四个 getter（形状如上）；`robot.config.test.ts` 的 `'15,35,50'` 归一化语义保留（`parseSkillDistribution` 纯函数不动它的口径）。

- [ ] **Step 1: 写失败测试** —— 克隆 T6 的 `config-cache.test.ts` 改造（C3 半边：拉失败 ⇒ 四 getter 全默认；通知换缓存）；`no-switch-in-decision.gate.test.ts` 先跑一遍**记录当前白名单**（应为 `config.ts` + `douzero.health.ts`），改后应变为「`config.ts`（默认值）+ `config-cache.service.ts`（新定义点）+ `douzero.health.ts`（合法消费者）」——具体白名单常量名与谓词以该文件实际实现为准，**只调白名单/集合断言，不弱化扫描**

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/robot-service test` ⇒ FAIL（gate 与 cache 红）

- [ ] **Step 3: 实现** —— `config.ts` 的 `parseSkillDistribution` 保留（`raw` 参数删或保留默认值按既有调用点收窄——实现时全仓 grep `getRobotConfig\|parseRuleFallback\|resetRobotConfigForTests` 找齐引用点，逐个改到 cache；**`getRobotConfig` 删除**）。`robot.reclaim.task.ts` 循环照 T7 模板（`cycleMs` → `reclaimIntervalMs()`）。`pool/health/service` 三处替换按上表（每处只换数据来源，行为分支不动）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/robot-service test` ⇒ PASS；`run lint` ⇒ 0 error；全仓 grep `ROBOT_RULE_FALLBACK\|ROBOT_SKILL_DISTRIBUTION\|ROBOT_RECLAIM_INTERVAL_MS` 在 `packages/` 下**零命中**（除注释说明处）

- [ ] **Step 5: 提交**

```bash
git add packages/robot-service
git commit -m "feat(robot): 三 env 退役 —— 四键走 ConfigCache；J29 白名单同步；自重排"
```

---

## Task 9: gateway 鉴权缝（admin 路径跳过玩家验签 + AdminAuthMiddleware）

**Files:**
- Modify: `packages/api-gateway/src/auth/public-paths.ts`（+ `ADMIN_PREFIX`/`isAdminPath` + 大注释）
- Modify: `packages/api-gateway/src/auth/identity-headers.ts`（+ `ADMIN_HEADER = 'x-admin'`——头名**单一真源**与既有三个头同处）
- Modify: `packages/api-gateway/src/auth/jwt.middleware.ts:104`（`if (isPublicPath(path) || isAdminPath(path))`）
- Create: `packages/api-gateway/src/auth/admin.middleware.ts`
- Modify: `packages/api-gateway/src/app.module.ts`（`consumer.apply(JwtMiddleware, AdminAuthMiddleware, HttpRateLimitMiddleware).forRoutes('*')` + 注释更新）
- Modify: `docker-compose.yml` **api-gateway 块**（+ `ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET:-}`——**验签侧与签发侧同钥**；T4 实测补登 C4-1：漏则生产设定后管理令牌全 401、dev 双空回退掩盖；与 T9 的 AdminAuthMiddleware 同提交）
- Create: `packages/api-gateway/test/admin.middleware.test.ts`

**Interfaces:**
- Produces: `isAdminPath(path): boolean`（**前缀**语义 `/api/admin`；注释写明为何前缀安全——其下全部路径都要管理令牌或 login、且**绝不进** `PUBLIC_PATHS`）· `AdminAuthMiddleware`（先剥 `X-Admin` → login 豁免**恰好一条** → 验管理令牌（aud `ftl-admin`）→ 注入 `X-Admin: 1` + 挂 `req.adminTokenFp`（sha256 前 16 位，T10 限流用））。

- [ ] **Step 1: 写失败测试** —— `test/admin.middleware.test.ts`（照 `jwt.middleware.test.ts` 的夹具形态）：

```ts
it('非 admin 路径 ⇒ 直接放行（本中间件不管）', ...);
it('🔴 先剥伪造 X-Admin：带 X-Admin:1 的请求在验真前该头已不在', ...);
it('login 豁免恰好一条：POST /api/admin/login 无令牌放行', ...);
it('其余 admin 路径无令牌 ⇒ 401 UNAUTHENTICATED / 坏令牌 ⇒ 401 TOKEN_INVALID 且不注入 X-Admin', ...);
it('有效管理令牌（aud=ftl-admin）⇒ 注入 X-Admin:1 且挂出 adminTokenFp', ...);
it('玩家令牌（aud 不对）⇒ 401（不认）', ...);
```

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/api-gateway test` ⇒ FAIL

- [ ] **Step 3: 实现** —— `admin.middleware.ts` 核心（完整逻辑）：

```ts
@Injectable()
export class AdminAuthMiddleware implements NestMiddleware {
  private readonly jwt = new JwtService({
    secret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production', // ⚠️ || 非 ??（空串=未设；T9 实拍）
  });
  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const path = requestPath(req);
    delete req.headers[ADMIN_HEADER];                       // ① 先剥（X-User-Id 同族纪律）
    if (!isAdminPath(path)) { next(); return; }
    if (path === '/api/admin/login') { next(); return; }    // ② 豁免**恰好一条**
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new CodedUnauthorized(ErrCode.UNAUTHENTICATED, 'Missing admin token');
    let payload: unknown;
    try { payload = this.jwt.verify(auth.slice(7), { audience: 'ftl-admin' }); }
    catch { throw new CodedUnauthorized(ErrCode.TOKEN_INVALID, 'Invalid or expired admin token'); }
    void payload;
    req.headers[ADMIN_HEADER] = '1';                        // ③ 注入
    (req as { adminTokenFp?: string }).adminTokenFp =
      createHash('sha256').update(auth.slice(7)).digest('hex').slice(0, 16);
    next();
  }
}
```

`public-paths.ts`：加（与 `PUBLIC_PATHS` **分列**，注释「语义不同：这里是**不适用玩家凭据**，不是**无需凭据**」）：

```ts
export const ADMIN_PREFIX = '/api/admin';
/** 片⑦ D6：管理面路径（前缀语义）。消费方：JwtMiddleware（整段跳过玩家验签）。
 *  ⚠️ 绝不并入 PUBLIC_PATHS（那是「无需凭据」清单）；前缀安全性见文件头注释。 */
export function isAdminPath(path: string): boolean {
  return path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);
}
```

`app.module.ts`：apply 列表插入 `AdminAuthMiddleware`（Jwt → Admin → RateLimit——顺序即契约，注释写明）。

- [ ] **Step 4: 跑测试确认绿** —— 同上 + `run lint` + **既有 `jwt.middleware.test.ts` 全绿**（负对照 `/api/auth/login-as-admin` 不受前缀规则误伤——`isAdminPath` 是 `/api/admin` 前缀，不匹配它）

- [ ] **Step 5: 提交**

```bash
git add packages/api-gateway/src/auth packages/api-gateway/src/app.module.ts packages/api-gateway/test/admin.middleware.test.ts
git commit -m "feat(gateway): 管理面鉴权缝 —— admin 前缀跳过玩家验签 + AdminAuth（剥伪造/一条豁免/注入 X-Admin）"
```

---

## Task 10: gateway 限流与转发（两桶 / 四路由 / 旧端点退役）

**Files:**
- Modify: `packages/api-gateway/src/http/rate-limit.ts`（+ 两个 admin 桶的阈值/键/函数）
- Modify: `packages/api-gateway/src/http/http-rate-limit.middleware.ts`（admin 分支 + 响应 finish 钩子）
- Modify: `packages/api-gateway/src/gateway/proxy.gateway.ts`（+ `forwardToConfigSvc`、`PUT` 支持）
- Modify: `packages/api-gateway/src/gateway/gateway.controller.ts`（+ `@Get('config')`/`@Post('admin/login')`/`@Get('admin/config')`/`@Put('admin/config/:key')`；**删** `@Get('base-score-levels')`(:96-99)；`headersOf()` + `X-Admin` 转发）
- Modify: `packages/api-gateway/test/gateway.controller.test.ts:122-140`（旧端点转发测试 → 新路由；r1-M4 行号订正）
- Modify: `packages/api-gateway/test/http-rate-limit.test.ts`（+ admin 桶用例）

**Interfaces:**
- Consumes: T9 的 `ADMIN_HEADER` / `req.adminTokenFp`。
- Produces: `ADMIN_LOGIN_FAIL = {max:5, windowMs:300_000}` · `ADMIN_WRITE = {max:30, windowMs:300_000}` · `adminLoginFailKey(ip) = 'ratelimit:admin-login-fail:{ip}'` · `adminWriteKey(fp) = 'ratelimit:admin-write:{fp}'` · `isAdminLoginBlocked/recordAdminLoginFailure/clearAdminLoginFailures/hitAdminWrite` · 网关路由表 +4/-1。

- [ ] **Step 1: 写失败测试** —— `test/http-rate-limit.test.ts` 补：① 登录桶：5 次 401 后第 6 次（含**正确口令**）⇒ 429（桶达界语义）；200 成功 ⇒ 清桶 ② 写桶：31 次 PUT ⇒ 429（滑动窗，同既有 `hitHttpLimit` 夹具）③ **无令牌/坏令牌的 admin 请求不经任何桶**（在 T9 处即 401——本测试断言「不产生桶键」）④ 登录与持令牌写**跳过**既有 IP 维（断言 `ratelimit:http-ip:*` 不涨）；持令牌 GET 保留 IP 维（涨）。`test/gateway.controller.test.ts`：旧端点用例改 `@Get('config')` 转发断言（路径 `/api/config`、header 注入含 X-Admin 情形）。

- [ ] **Step 2: 跑测试确认红** —— 同上

- [ ] **Step 3: 实现** —— `rate-limit.ts`（两桶 + 四个函数；失败计次 = `INCR`+首次 `PEXPIRE`，`GET ≥ max ⇒ true`；写桶照 `hitHttpLimit` 的 ZSET 形态）；middleware 分支（**完整替身逻辑**）：

```ts
    const path = requestPath(req);
    if (isAdminPath(path)) {
      const isLogin = path === '/api/admin/login';
      if (isLogin) {
        // 既有 IP 维**跳过**（本桶更严）；桶达界 ⇒ 正确口令也 429（检查在比较之前）。
        if (await isAdminLoginBlocked(this.redis, clientIp(req))) { rejectRateLimited(res); return; }
        // 失败计次 = **响应感知**（finish 钩子）：401 ⇒ 计、200 ⇒ 清、其余不计。
        res.on('finish', () => {
          const ip = clientIp(req);
          void (res.statusCode === 401
            ? recordAdminLoginFailure(this.redis, ip)
            : res.statusCode === 200
              ? clearAdminLoginFailures(this.redis, ip)
              : Promise.resolve()).catch(() => {});
        });
        next(); return;
      }
      if (req.headers[ADMIN_HEADER] === '1' && req.method === 'PUT') {
        const fp = (req as { adminTokenFp?: string }).adminTokenFp ?? 'unknown';
        if (await hitAdminWrite(this.redis, fp)) { rejectRateLimited(res); return; }
        next(); return;
      }
      // 其余（持令牌 GET / 理论上不可达的无令牌类）⇒ 落回既有流程（IP 维覆盖）
    }
    // …既有健康豁免 / IP 维 / 用户维（不动）
```

`proxy.gateway.ts`：`forwardToConfigSvc` 照 `forwardToUserSvc`(:515) 克隆（基址 `process.env.CONFIG_SERVICE_URL ?? 'http://config-service:3006'`）；`forward()`(:553) 的 method 类型**确认/扩到含 `'PUT'`**。`gateway.controller.ts`：四路由照 `rooms` 族写法（`@Put` 记得 import）；`headersOf()`(:236-258) 加：

```ts
  const admin = req?.headers?.[ADMIN_HEADER];
  if (admin === '1') headers.admin = true;   // DownstreamHeaders 同步加 admin?: boolean；forward() 里映射成 x-admin 头
```

删旧端点路由与其上注释块（`:91-99`）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/api-gateway test` ⇒ PASS；`run lint`；**真栈手测**（dev 形态）：`curl -s -X POST localhost:3000/api/admin/login -H 'content-type: application/json' -d '{"password":"conformance-admin-pass"}'` ⇒ 200+token；带 token `curl -s -H 'Authorization: Bearer <t>' localhost:3000/api/admin/config` ⇒ 200 九键；`curl -s localhost:3000/api/base-score-levels -H 'Authorization: Bearer <玩家token>'` ⇒ 404

- [ ] **Step 5: 提交**

```bash
git add packages/api-gateway
git commit -m "feat(gateway): admin 两桶限流（失败计次/达界语义/顺序）+ /api/config 与 /api/admin/* 转发；旧端点退役"
```

---

## Task 11: 客户端（fetchClientConfig / fail-safe / 入口门控）

**Files:**
- Modify: `apps/client/src/net/rest.ts:241-259`（`BaseScoreLevel` 改 protocol re-export；`baseScoreLevels()` → **`fetchClientConfig()`**——⚠️ **不能**叫 `clientConfig`：`rest.ts:12` 已从 `../config` import 同名函数，重名 = TS2440（r1 计划审查 X-2）；协议 `ClientConfig` 与 `apps/client/src/config.ts:11` 的**构建期**同名 interface 是不同物——若同文件并用，import 时 `as` 消歧）
- Modify: `apps/client/src/stores/game.ts`（+ `friendRoomEnabled: false` 初值 + `setClientConfig`；`setBaseScoreLevels` 由它取代）
- Modify: `apps/client/src/pages/lobby/lobby.vue:86-133`（`loadLevels` → `loadClientConfig`；失败分支写 `{baseScoreLevels: [], friendRoomEnabled: false, version: 0}`）
- Modify: `apps/client/src/pages/game/game.vue:369-378`（入口 `v-if="store.friendRoomEnabled"`）
- Modify: `apps/client/test/base-score-selection.test.ts` · `test/auth-ui-wiring.test.ts` · `test/table-center.test.ts`
- Create: `apps/client/test/friend-room-gate.test.ts`（C19）

**Interfaces:**
- Consumes: T1 的 `ClientConfig`/`BaseScoreLevel`。
- Produces: `rest.fetchClientConfig(): Promise<RestResponse<ClientConfig>>`（`authedGet('/config')`）· store：`friendRoomEnabled`（初值 false）· `setClientConfig(cfg)`。

- [ ] **Step 1: 写失败测试** —— `test/friend-room-gate.test.ts`：

```ts
it('C19：fetchClientConfig 失败 ⇒ friendRoomEnabled 保持 false（入口不渲染的依据）', async () => {
  // mock rest.fetchClientConfig 抛错 ⇒ 调 lobby 的加载函数（或 setClientConfig 的失败分支）⇒ store.friendRoomEnabled === false
});
it('store 初值 = false（fail-safe 默认）', () => {
  const store = useGameStore(); expect(store.friendRoomEnabled).toBe(false);
});
```

三处既有测试按新 API 改（`rest.baseScoreLevels` → `rest.fetchClientConfig`、`setBaseScoreLevels` → `setClientConfig`）。

- [ ] **Step 2: 跑测试确认红** —— `pnpm --filter @fight-the-landlord/client test` ⇒ FAIL

- [ ] **Step 3: 实现** —— rest.ts：

```ts
export type { BaseScoreLevel } from '@fight-the-landlord/protocol';
/** 片⑦：客户端配置（`GET /api/config`）—— 底分档位 + 好友房开关 + 版本，一次取、不缓存。
 *  ⚠️ 函数名是 `fetchClientConfig`：本文件 `:12` 已有 `clientConfig`（来自 `../config`）——重名编译炸。 */
export function fetchClientConfig(): Promise<RestResponse<ClientConfig>> {
  return authedGet<ClientConfig>('/config');
}
```

stores/game.ts：state 加 `friendRoomEnabled: false`（注释：fail-safe——未知=隐藏）；action `setClientConfig(cfg: ClientConfig) { this.baseScoreLevels = cfg.baseScoreLevels; this.friendRoomEnabled = cfg.friendRoomEnabled; }`；删 `setBaseScoreLevels`（调用点全改）。lobby.vue：`loadLevels` → `loadClientConfig`（成功 `store.setClientConfig(res.data)`；失败 `store.setClientConfig({ baseScoreLevels: [], friendRoomEnabled: false, version: 0 })`——保留既有「失败写空表」语义）；重放分支照旧。game.vue：按钮加 `v-if="store.friendRoomEnabled"`（只加这一处 v-if，其余模板不动）。

- [ ] **Step 4: 跑测试确认绿** —— `pnpm --filter @fight-the-landlord/client test` ⇒ PASS；`pnpm --filter @fight-the-landlord/client run lint`（或 vue-tsc，按包内脚本）

- [ ] **Step 5: 提交**

```bash
git add apps/client
git commit -m "feat(client): fetchClientConfig() 收编（含 friendRoomEnabled fail-safe）—— 入口按配置门控"
```

---

## Task 12: 管理页（admin/）+ 门口（Caddy / Dockerfile.edge）

**Files:**
- Create: `admin/index.html` · `admin/app.js` · `admin/style.css`
- Modify: `Dockerfile.edge`（stage 二 + `COPY admin /srv/admin`）
- Modify: `deploy/Caddyfile`（两条 `handle` 插在 catch-all `:35` **之前**）

**Interfaces:**
- Consumes: T3 的管理 API 契约（§2.5）；T10 的路由。
- Produces: `GET /admin/` 与 `GET /admin`（301）⇒ 管理页；页面文案含「已保存（版本 N）；各服务 ≤60s 内生效」。

- [ ] **Step 1: 实现页面（无构建、三文件）** —— `app.js` 关键逻辑（完整可用的最小实现）：

```js
const TOKEN_KEY = 'ftl-admin-token';
async function api(path, opts = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const res = await fetch(path, { ...opts, headers: {
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }});
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function login(password) {
  const { status, body } = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
  if (status === 404) return showMsg('管理面未启用（服务端未设置口令）');
  if (status === 401) return showMsg('口令错误');
  if (status === 429) return showMsg('尝试过于频繁，请稍后再试');
  sessionStorage.setItem(TOKEN_KEY, body.data.token); await loadAll();
}
async function loadAll() { /* GET /api/admin/config → 左侧键列表（九键）+ 右侧编辑器（JSON textarea / boolean 开关） */ }
async function save(key, value) {
  const { status, body } = await api(`/api/admin/config/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) });
  if (status === 400) return showMsg(`未保存：${body.message}`);
  if (status === 401) return showMsg('令牌过期，请重新登录');
  showMsg(body.data.announced
    ? `已保存（版本 ${body.data.version}）；各服务 ≤60s 内生效`
    : `已保存（版本 ${body.data.version}）；推送失败，将在 ≤60s 内经安全网生效`);
  await loadAll();
}
```

`index.html`：深色等宽极简（标题「FTL 管理面」、登录表单、左右布局）；`style.css` 自定（观感不设限）；页面**不含任何配置值**（登录后才拉）。

- [ ] **Step 2: 门口接线** —— `Dockerfile.edge` stage 二：`COPY --from=web /app/apps/client/dist/build/h5 /srv` 之后加 `COPY admin /srv/admin`。`Caddyfile`：在 `handle {`（catch-all，`:35`）**之前**插入：

```
	handle /admin/* {
		root * /srv
		file_server
	}
	handle /admin {
		redir /admin/ 301
	}
```

- [ ] **Step 3: 本机真门口验证** —— `docker compose --profile edge build edge && docker compose --profile edge up -d edge` ⇒ `curl -si http://localhost:8080/admin/ | head -1` ⇒ `200`；`curl -s http://localhost:8080/admin/ | grep -o '<title>[^<]*'` ⇒ 管理页标题；`curl -si http://localhost:8080/admin | head -1` ⇒ `301`；`curl -s http://localhost:8080/ | grep -c 好友房`（H5 照旧可达——catch-all 未被破）

- [ ] **Step 4: 提交**

```bash
git add admin Dockerfile.edge deploy/Caddyfile
git commit -m "feat(admin): 门口托管管理页（无构建）+ Caddy /admin 路由（catch-all 前）+ 镜像 COPY"
```

---

## Task 13: user-service 退役（代码删除 + compose 死配置清理）

**Files:**
- Delete: `packages/user-service/src/config/`（4 文件）· `src/rpc/base-score-levels.rpc.controller.ts` · `test/base-score-levels.test.ts` · `test/base-score-levels.rpc.test.ts`
- Modify: `packages/user-service/src/main.ts`（删微服务块 `:56-60` 与其上注释；保留 fail-closed/logger/前缀/端口）
- Modify: `packages/user-service/src/app.module.ts`（删 `ConfigModule` 与 RPC 控制器装配）
- Modify: `packages/user-service/src/health/health.service.ts:34`（「本服务是唯一报 mysql 的」注释改）
- Modify: `docker-compose.yml` user-service 块：`:146-148` 删 `3101`（保 `"3001"`）+ `:142-144` 注释删 + **`:157-158` 的 `RPC_PORT=3101` 删**
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts:141-146`（`RPC_PORTS`：`'user-service':'3101'` → **`'config-service':'3106'`**——与用户退役**同提交**（①b 在 render 列每 push 跑；config 的 expose/override 在 T4 已就位 ⇒ 换键即刻全绿）；r2-F2）
- Keep（**遗留登记**）：`src/migrations/1789100000000-BaseScoreLevels.ts` + `test/migration.test.ts`（表留库；迁移注释头加一行「片⑦ 起为遗留表/迁移，无读者，待确认后清理」）

**Interfaces:**
- 判据减少显式登记：删除的 `base-score-levels.test.ts` / `base-score-levels.rpc.test.ts` 所测语义（档位语义/10007/缺省∈表）由 C10 继受（新端点切片 + T7 单测 + 既有 `rooms.base-score.test.ts`）。

- [ ] **Step 1: 基线** —— `pnpm --filter @fight-the-landlord/user-service test` ⇒ 全绿（记录条数）

- [ ] **Step 2: 删除与改装配** —— 按 Files 执行；`main.ts` 删块后**确认 `connectMicroservice`/`startAllMicroservices` 两调用在 user-service 全仓零命中**

- [ ] **Step 3: 跑测试确认绿** —— 同上 ⇒ PASS（少了两个测试文件，其余全绿）；`run lint` ⇒ 0；`docker compose build user-service && docker compose up -d user-service` ⇒ healthy；`docker compose ps` 里 user-service **不再暴露 3101**（`docker compose config` 断言 expose 列表 `['3001']`）；⚠️ 本任务落地 → T16 之间，`slice-07.2-rpc` 第 7 组**必红**（**已知窗口**，T16 接住——r1-M13；T15 只跑 slice-14、不受影响）

- [ ] **Step 4: 提交**

```bash
git add -A packages/user-service docker-compose.yml tools/conformance/src/slices/slice-07.2-deploy.ts
git commit -m "refactor(user): 底分档位 RPC 退场（唯一 pattern 随收编删除，TCP 监听退役；RPC_PORTS 换键 ←slice-07.2-deploy）——遗留表/迁移保留；判据减少显式登记"
```

---

## Task 14: conformance 工具 + 老切片共存改造 + mock-server

**Files:**
- Modify: `tools/conformance/src/lib/http.ts`（`request()` method 加 `'PUT'`；+ `putJson`；+ `ADMIN_PASSWORD`/`adminLogin`/`adminGetConfig`/`adminPutConfig`/`setFriendRooms`；+ 顺手：`:23` 计数注释残留——T4 实测补登）
- Modify: `tools/conformance/src/slices/slice-06-auth-rooms.ts`（开头 `setFriendRooms(true, user.accessToken)`；`:109-121` 旧端点 → `GET /api/config`，字段 `levels` → `baseScoreLevels`；`:98-101` 旧端点注释漂移同改——r1-M2）
- Modify: `tools/conformance/src/slices/slice-07.1-room-atomic-seating.ts` · `slice-07.2-hardening.ts` · `slice-12-manual-join.ts:91`,`:419`（**各自开头**开启 `setFriendRooms(true, user.accessToken)`——非紧贴某行；**不改断言语义**；r1-M10）
- Modify: `scripts/browser-e2e.mjs:475/:476`（r1-M3 行号订正；等 `GET /api/config` 就绪）+ `:609-697`（setup 经 admin 开启好友房——探针是独立脚本，自带 fetch 助手）+ 顺手 `:35` 计数注释残留（T4 实测补登）
- Modify: `tools/mock-server/src/rest.ts:117`（旧端点 → `GET /api/config`：`{baseScoreLevels, friendRoomEnabled:false, version:0}` + 鉴权说明）+ `src/index.ts:16,:59`（头注释/挂载说明）+ `test/rest.test.ts`

**Interfaces:**
- Produces: `putJson(path, body, token)` · `ADMIN_PASSWORD`（默认 `'conformance-admin-pass'`；注释「与 `conformance-stack.sh` 的 export **两处同源**」）· `adminLogin(): Promise<string>` · `adminPutConfig(key, value, token)` · `adminGetConfig(token)` · `setFriendRooms(enabled: boolean, playerToken: string): Promise<void>`（PUT + **以建房行为轮询至生效** ≤30s：enabled ⇒ `POST /api/rooms` 得 `code 0`；disabled ⇒ 得 `12006`；轮询产生的探针房是副产品、无害）。

- [ ] **Step 1: 写工具与改造** —— `lib/http.ts`：

```ts
async function request(method: 'GET' | 'POST' | 'PUT', ...) { /* 既有实现，method 类型放宽 */ }
export function putJson<T = any>(path: string, body: unknown, token?: string): Promise<HttpResult<T>> {
  return request('PUT', path, body, token);
}

/** 片⑦：管理面。⚠️ 默认值必须与 `scripts/deploy/conformance-stack.sh` 的 export 逐字一致（两处同源）。 */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'conformance-admin-pass';
export async function adminLogin(): Promise<string> { ... }
export function adminPutConfig(key: string, value: unknown, token: string): Promise<HttpResult> { ... }

/**
 * 置好友房开关并**轮询至生效**（规格 §3 `setFriendRooms`）。
 * ⚠️ 生效观测点 = **建房行为**（consumer 缓存的真实出口）；`GET /api/config` 只反映库、证不了缓存。
 */
export async function setFriendRooms(enabled: boolean, playerToken: string): Promise<void> {
  const admin = await adminLogin();
  const put = await adminPutConfig('room.friendRoomEnabled', enabled, admin);
  if (put.body?.code !== 0) throw new ConformanceError(`置 friendRoomEnabled=${enabled} 失败：${JSON.stringify(put.body)}`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const probe = await postJson('/api/rooms', { mode: 'random' }, playerToken);
    const effective = enabled ? probe.body?.code === ErrCode.OK : probe.body?.code === ErrCode.FRIEND_ROOM_FAILED;
    if (effective) return;
    if (Date.now() >= deadline) throw new ConformanceError(`friendRoomEnabled=${enabled} 30s 内未生效（最后一次 ${probe.body?.code}）`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
```

K4/K5 的切片改造：在**各自开头**（注册用户之后）插 `await setFriendRooms(true, user.accessToken)`；slice-06 的 `:109-121` 段把 `getJson('/api/base-score-levels', …)` 换成 `getJson<{ baseScoreLevels: { name: string; baseScore: number }[] }>('/api/config', user.accessToken)` 并把取值改成 `body.data.baseScoreLevels`（**成员断言逐字保留**）。browser-e2e 按其 .mjs 形态实现同样的「登录 admin → PUT → 轮询建房」。

- [ ] **Step 2: 跑受影响的切片（本机 dev 栈）** —— `pnpm --filter @fight-the-landlord/conformance build`（不带 `...` 需 protocol 的 **dist** 新鲜——T1 改过 protocol 后先 `pnpm run ci` 或 turbo 构建一次；ci.yml:37-39 先例，r1-M14）后逐条：`node tools/conformance/dist/run.js slice-06` · `slice-07.1` · `slice-07.2-hardening` · `slice-12` ⇒ 全绿（需要 T1/T3/T4/T7/T10 已落地起栈）

- [ ] **Step 3: 提交**

```bash
git add tools/conformance/src/lib/http.ts tools/conformance/src/slices/slice-06-auth-rooms.ts tools/conformance/src/slices/slice-07.1-room-atomic-seating.ts tools/conformance/src/slices/slice-07.2-hardening.ts tools/conformance/src/slices/slice-12-manual-join.ts scripts/browser-e2e.mjs
git commit -m "test(conformance): admin helpers + setFriendRooms（行为轮询）；slice-06/07.1/hardening/12 共存改造 + 探针新端点"
```

---

## Task 15: slice-14 新片 + `--fresh` 前置步（C 判据载体）

**Files:**
- Create: `tools/conformance/src/slices/slice-14-config-center.ts`
- Modify: `tools/conformance/src/run.ts`（CASES 末尾注册 `'slice-14-config-center'`；**`--fresh` 早期返回模式**：在 `--list` 分支旁加一个分支，`--fresh` ⇒ 注册用户 → `GET /api/config` ⇒ 断言 `friendRoomEnabled === false`，打印结论、按退出码结束；不是 case）
- Modify: `.github/workflows/conformance.yml`（① 起栈步与循环步**各加** `env: ADMIN_PASSWORD: conformance-admin-pass`（workflow 环境继承不到 stack 脚本的 export ⇒ 两处都要显式给；与 stack 脚本/`lib/http.ts` 三处同源，注释互指）② 在「起真栈」与「跑全部切片」之间加 `- name: 默认态前置断言（C11）` ⇒ `run: node tools/conformance/dist/run.js --fresh`）；ISOLATED_KEYS **无需**扩展（无断言读取新 env——r2 已核）

**Interfaces:**
- Consumes: T14 的 helpers；T1–T13 的全部行为。
- Produces: 12 条 conformance 判据；`--fresh` 前置步（**不进 baselines**——不在切片循环日志里）。

- [ ] **Step 1: 实现 slice-14** —— 骨架与**状态编排**（规格 §3 末小节逐字执行；`Checks` 形态先读 `slice-12` 照抄）：

```ts
export async function runSlice14(): Promise<Checks> {
  const checks = new Checks();
  const user = await registerUser(14);
  const admin = await adminLogin();
  const compose = /* 照 slice-07.3-edge.ts:141-159 的 spawnSync 形态 */;
  const exec = /* 照 slice-07.5-backup 的 `docker exec` 形态；若用 `docker compose exec` 则必带 `-T`（`docker exec` 无此旗标）——两者按所选 helper 定 */;

  // ── 编排第 1 段：C1（**自带前置：不假设前序状态**）+ C17a ────────────────
  await setFriendRooms(false, user.accessToken);              // 前置
  step('C1①②③：改了即生效（推送路径，30s < 安全网 60s——只证推送）');
  const off1 = await postJson('/api/rooms', { mode: 'random' }, user.accessToken);
  checks.eq(off1.body?.code, ErrCode.FRIEND_ROOM_FAILED, 'C1① 起态 false ⇒ 12006');
  await adminPutConfig('room.friendRoomEnabled', true, admin);
  await pollConfigValue(user, 'friendRoomEnabled', true, 30_000, checks); // GET /api/config 轮询 ≤30s
  const on1 = await postJson('/api/rooms', { mode: 'random' }, user.accessToken);
  checks.eq(on1.body?.code, ErrCode.OK, 'C1② true 后建房 code 0');
  await adminPutConfig('room.friendRoomEnabled', false, admin);
  await pollConfigValue(user, 'friendRoomEnabled', false, 30_000, checks);
  const off2 = await postJson('/api/rooms', { mode: 'random' }, user.accessToken);
  checks.eq(off2.body?.code, ErrCode.FRIEND_ROOM_FAILED, 'C1③ 还原 ⇒ 12006');

  step('C17a：关推送（CONFIG_SYNC_DISABLE_PUSH=1 注入 room-service）⇒ 30s 时点仍未生效 ⇒ 推送路径得证');
  // up -d --no-deps room-service（env 注入）→ setFriendRooms 前置 false → PUT true →
  // 等 30s → 建房仍 12006（checks.eq）→ 再等 ≤70s 内变 201（安全网兜底正证）→ 还原注入 + 置回 false

  // ── 编排第 2 段：C2 + C17b（直接改库造丢消息；mysql exec 见规格 §C2 的完整命令形态）──
  step('C2：直接改库 ⇒ 无 publish ⇒ ≤70s 由安全网送达（收尾经 admin 写回）');
  // exec mysql: UPDATE platform_config SET value=CAST('true' AS JSON), version=version+1,
  //   updated_at=NOW(3), updated_by='drill' WHERE `key`='room.friendRoomEnabled'
  // ⇒ 轮询 ≤70s 建房变 code 0 ⇒ 收尾 adminPutConfig(false) + pollConfigValue(false)
  step('C17b：CONFIG_SYNC_SAFETY_NET_MS=600000 注入 ⇒ 改库 ⇒ 70s 时点仍未翻转 ⇒ 安全网得证 ⇒ 还原');
  // 还原 = up -d --no-deps room-service（正常 env；重建即拉最新快照）⇒ 建房回 12006

  // ── 编排第 3 段：C8（ON 窗造在途房）────────────────────────────────────
  step('C8：ON 窗 ⇒ 造在途房 ⇒ 置 false ⇒ 三面 + 匹配正对照（正对照在 T7 单测）');
  await setFriendRooms(true, user.accessToken);
  const created = await postJson<{ code: string }>('/api/rooms', { mode: 'random' }, user.accessToken);
  const roomCode = created.body?.data?.code ?? '';
  await setFriendRooms(false, user.accessToken);
  const join = await postJson(`/api/rooms/${roomCode}/join`, {}, user.accessToken);
  checks.eq(join.body?.code, ErrCode.FRIEND_ROOM_FAILED, 'C8② 占座拒 12006');
  const list = await getJson('/api/rooms', user.accessToken);
  checks.eq(list.body?.code, ErrCode.OK, 'C8③ 列表 code 0'); checks.that(Array.isArray(list.body?.data) && list.body.data.length === 0, 'C8③ 空数组');

  // ── 编排第 4 段：C13（键写死 friendRoomEnabled；admin 读定终值 ⇒ 建房探针轮询 ≤30s 收口）──
  // Promise.all 两 PUT（[true,false]）⇒ 都 200；adminGetConfig 该键 version = v0+2；终值=其一 ⇒
  // 建房探针（轮询 ≤30s 至与终值一致——**小于安全网 60s**）⇒ 收尾置回 false

  // ── 编排第 5 段：C16（自带前置 true）────────────────────────────────────
  step('C16：错序自愈（stop config → force-recreate room → 热项默认 / start config → ≤70s 恢复）');
  // setFriendRooms(true) 前置 → compose stop config-service →
  //   compose up -d --no-deps --force-recreate room-service → 等 room healthy →
  //   建房 ⇒ 12006（热项默认 false 的证据）→ compose start config-service →
  //   轮询 ≤70s 建房 ⇒ code 0（自愈）→ setFriendRooms(false) 收尾

  // ── 编排第 6 段（与开关态无关）：C5半 / C6半 / C7 / C14 / C15 / C20 ─────
  step('C5半：真栈 2 例非法 PUT ⇒ 400 且值未变（adminGetConfig 前后对比）');
  step('C6半：步骤级 unset（显式空串注入 + up -d --no-deps config-service）⇒ login 404 ⇒ 还原');
  step('C7：GET /api/config 的 data 键集排序后**恰好** [baseScoreLevels, friendRoomEnabled, version]');
  step('C14：匿名 GET /api/config ⇒ 401；匿名 GET /api/admin/config ⇒ 401');

  step('C15：5×错口令 ⇒ 第 6 次 429 ⇒ 正确口令也 429（桶达界）⇒ 清键 ⇒ 正确口令 200（自证清干净）');
  for (let i = 0; i < 5; i++) await postJson('/api/admin/login', { password: 'wrong-' + i });
  const sixth = await postJson('/api/admin/login', { password: 'wrong-5' });
  checks.eq(sixth.status, 429, 'C15 第 6 次 429');
  const rightWhileLocked = await postJson('/api/admin/login', { password: ADMIN_PASSWORD });
  checks.eq(rightWhileLocked.status, 429, 'C15 桶达界 ⇒ 正确口令也 429');
  exec("redis", "sh", "-c", "redis-cli --scan --pattern 'ratelimit:admin-login-fail:*' | xargs -r redis-cli DEL"); // docker compose exec -T
  const relogin = await postJson('/api/admin/login', { password: ADMIN_PASSWORD });
  checks.eq(relogin.status, 200, 'C15 清桶后正确口令可登录（自证）');

  step('C20：GET /admin/（8080）⇒ 200 + 管理页标志串；GET /admin ⇒ 301 跟随 ⇒ 200');
  const adminPage = await fetch(`http://localhost:${process.env.EDGE_HTTP_PORT ?? 8080}/admin/`);
  checks.eq(adminPage.status, 200, 'C20 /admin/ 200');
  checks.that((await adminPage.text()).includes('FTL 管理面'), 'C20 含管理页标志串');
  const adminRedirect = await fetch(`http://localhost:${process.env.EDGE_HTTP_PORT ?? 8080}/admin`); // fetch 默认跟随 301
  checks.eq(adminRedirect.status, 200, 'C20 /admin（301 跟随）200');

  // ── 统一收尾 ────────────────────────────────────────────────────────────
  await setFriendRooms(false, user.accessToken);
  return checks;
}
```

**片内本地 helper**（写在 slice-14 文件顶部；规格 §3 的 `pollConfigValue`）：

```ts
/** GET /api/config 轮询 ≤timeout（观察点 = config-service 的读面；消费侧生效另由建房探针观测）。 */
async function pollConfigValue(user: HarnessUser, field: 'friendRoomEnabled', expected: boolean, timeoutMs: number, checks?: Checks): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cfg = await getJson<Record<string, unknown>>('/api/config', user.accessToken);
    if (cfg.body?.data?.[field] === expected) return;
    if (Date.now() >= deadline) throw new ConformanceError(`${field}=${expected} ${timeoutMs}ms 内未生效（最后 ${JSON.stringify(cfg.body?.data)}）`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
```

C16 段的精确序列（编排第 5 段的展开）：

```ts
  await setFriendRooms(true, user.accessToken);                       // 前置（S-C1）
  checks.eq((await postJson('/api/rooms', { mode: 'random' }, user.accessToken)).body?.code, ErrCode.OK, 'C16 前置 true 生效');
  compose('stop', 'config-service');
  compose('up', '-d', '--no-deps', '--force-recreate', 'room-service');
  await waitRoomHealthy();                                            // 轮询 room-service /api/health 200（≤60s）
  checks.that((await postJson('/api/rooms', { mode: 'random' }, user.accessToken)).body?.code === ErrCode.FRIEND_ROOM_FAILED, 'C16② 热项取默认 false（12006）');
  compose('start', 'config-service');
  await waitUntil(() => postJson('/api/rooms', { mode: 'random' }, user.accessToken).then(r => r.body?.code === ErrCode.OK), 70_000); // C16③ 自愈
  await setFriendRooms(false, user.accessToken);                      // 收尾
```

`run.ts` 的 `--fresh`（照 `--list` 的早期返回，写在 case 查找之前）：

```ts
if (args.includes('--fresh')) {
  const user = await registerUser(0);
  const cfg = await getJson<{ friendRoomEnabled: boolean }>('/api/config', user.accessToken);
  const ok = cfg.body?.code === 0 && cfg.body.data?.friendRoomEnabled === false;
  console.log(ok
    ? '✅ fresh 态前置断言（C11）：friendRoomEnabled === false（种子=生产默认）'
    : `❌ fresh 态前置断言（C11）失败：${JSON.stringify(cfg.body)}（期望 false —— 栈种子被改过？）`);
  process.exitCode = ok ? 0 : 1;
  return;
}
```

（⚠️ `--fresh` 分支需在 `run.ts` 顶部**新增** `registerUser`/`getJson` 的 import——来自 `../lib/http`，r1-M8。）`conformance.yml` 两处 env + fresh 步骤（见 Files/Interfaces 的三处同源注释）。

- [ ] **Step 2: 本机真栈跑 slice-14** —— `bash scripts/deploy/conformance-stack.sh up` ⇒ `node tools/conformance/dist/run.js slice-14-config-center` ⇒ 全绿（该片含 docker 操作，本机 Windows 亦可跑；预计 3–5 分钟——C2/C17 的等待占大头）；`node tools/conformance/dist/run.js --fresh`（**重启栈后**跑）⇒ ✅；**变异**：`CONFIG_SYNC_DISABLE_PUSH=1 docker compose up -d --no-deps room-service` 后重复 C1 段 ⇒ 30s 窗内不生效（C1 红，即变异红）

- [ ] **Step 3: 提交**

```bash
git add tools/conformance/src/slices/slice-14-config-center.ts tools/conformance/src/run.ts .github/workflows/conformance.yml
git commit -m "test(conformance): slice-14 配置中心（C1/C2/C8/C13-C17/C20 + 状态编排）+ --fresh 前置步（C11）"
```

---

## Task 16: conformance 清单 / 闸 / 重做（K6/K7/K8/K11）

**Files:**
- Modify: `tools/conformance/src/slices/slice-07.2-deploy.ts`（`:552/:559-561` 与 `:141-146` **已在 T4/T13 改掉——本任务只核** · `:918-922` LOG_LIMIT_TARGETS + `ftl-config-service`（9 → **10** 项）· `:123` TOKEN_SERVICES 5→6 · `:71` 与文案 `:912/:914/:1232` 的「8 个容器」→9）
- Modify: `tools/conformance/src/slices/slice-07.2-rpc.ts`（第 7 组 `:951-970` 的 `['user-service','3101']` 面 → `['config-service','3106']`；头注释 `:45`/`:943-944` 同步）
- Modify: `tools/conformance/src/slices/slice-07.4-pipeline.ts`（+ C21①：读 `scripts/deploy/deploy.sh` 源断言含 `refs/tags/${TAG}:docker-compose.yml` 与 fail-closed `exit 1` 分支；注释写判别力自证——删该段/改回本检出 ⇒ 本判据红。:693-699 的计数已在 T4 同提交改掉）+ 顺手 `slice-07.3-edge.ts:18/:168` 计数注释残留（T4 实测补登）
- Modify: `tools/conformance/src/slices/slice-13-ai-rollout.ts`（`:698-709` J22-OFF 重做：关闭态经 `adminPutConfig('robot.ruleFallback', false)` + 一次性容器经 `compose run`（**自动入网，勿加 `--network`**）⇒ 断言 `canProvide:false` ⇒ 用后置回 true；`:751-776` J4：junk env 用例删改 + commit message/登记注明**判据减少**（语义继受 = C5））
- Modify: `tools/conformance/baselines.json`：**不加键**——`check-baselines.mjs` 的「未回填」分支只在**键缺席**时触发（r1 计划审查 I-7a：空串值会走 `n < "" = false` **静默通过**）；先例 = `_backfill` 注释（slice-13/07.5 都是「新增 ⇒ CI 红未回填 ⇒ 从日志回填」）。slice-14 的条目由 **T18 从 CI 日志回填**。同时：**slice-13 的 `full` floor（≈:30，值 35）**——J4 删改减 checks，J22 重做应尽量等量补齐；若净减跌破 floor ⇒ **同提交下调 floor 并在 commit message 注明理由**（仓规允许、须显式；r1 计划审查 I-7b）

**Interfaces:**
- 依赖：T13（user 退役）已落地——①b/②b/第 7 组的 3106 断言此刻才成立。

- [ ] **Step 1: 先跑旧断言看红** —— dev 栈上 `node … run.js slice-07.2-deploy` ⇒ 预期在 LOG_LIMIT_TARGETS / TOKEN_SERVICES / 文案处红（`:552` 与 `RPC_PORTS` 已在 T4/T13 改掉、不在此列——r2-F2/R6）；`slice-07.2-rpc` ⇒ 第 7 组红（T13 起的已知窗口）

- [ ] **Step 2: 逐处改** —— 按 Files；改完 `pnpm --filter @fight-the-landlord/conformance build`

- [ ] **Step 3: 跑四条切片** —— `slice-07.2-deploy`（含 prod/dev 两形态渲染 + 真容器段）· `slice-07.2-rpc` · `slice-07.4-pipeline` · `slice-13-ai-rollout` ⇒ 全绿；`slice-07.4` 另做**判别力自证**：临时把 deploy.sh 的 `git show` 段改回 `scp … docker-compose.yml` ⇒ C21① 红 ⇒ 改回

- [ ] **Step 4: 提交**

```bash
git add tools/conformance/src/slices/slice-07.2-deploy.ts tools/conformance/src/slices/slice-07.2-rpc.ts tools/conformance/src/slices/slice-07.4-pipeline.ts tools/conformance/src/slices/slice-13-ai-rollout.ts tools/conformance/baselines.json
git commit -m "test(conformance): 清单 swap（3106 / 第 8 镜像 / 6 清单）+ C21 静态闸 + slice-13 J22/J4 重做（J4 判据减少登记）"
```

---

## Task 17: 文档面（design.md / 手册 / client-protocol / README / 台账）

**Files:**
- Modify: `docs/design.md`（§5.1-A 全表：`:157/:159/:188/:539/:543/:558/:999/:1012/:1150/:1186/:1587/:1718/:1727` + §2.1/§2.3/§2.4/§4.1/§4.2/§4.3/§7.1/§10.1/§10.3/§11.2 + 新增「配置中心」节）
- Modify: `docs/ops/first-deploy.md`（§5.1-B 全表：计数 `:3/:25/:32/:123` + env `:223` + 🔴 **`:249` 预期输出按新栈重算**（口径以该处上下文为准：用新 compose 数 env 行/JWT_SECRET 出现次数）+ `:670/:680/:699/:716/:732/:736/:781-783` + **新增「怎么改配置」与「回滚注意」两节**）
- Modify: `docs/client-protocol.md`（替换 `:52` + 改写 `:54-60` + 修 `:62-63`）
- Modify: `README.md:35-44`（+config-service 3006/3106；顺手补 robot-service:3005）· `docs/games/doudizhu.md:341`（100→15）
- Modify: `docs/superpowers/plans/deviation-ledger.md`（+ 两条：遗留表/迁移 · `room:{code}:fillat` 被 WS 路径写入的现状）
- Modify: `packages/shared/test/design-md-ai-rollout.gate.test.ts:95-100`（**J18② 极性翻转**：断言设计 §2.3 **不得**再含三个退役 env、且**应含** `ADMIN_PASSWORD`/`CONFIG_SERVICE_RPC_*` 等新行——本任务删 §2.3 三行后旧断言必红；退役的守卫也机械化；r1 计划审查 I-2）

**Interfaces:**
- 依赖：T4（计数定稿）· T15（conformance 形态定稿，手册里 baselines 相关句同步）。

- [ ] **Step 1: design.md** —— 逐行对照规格 §1-J1 行执行；`:1012` 是 4 行块状条目（含 2026-09-27 复核订正史）——**整块处置**（替换为 `GET /api/config` 行 + 旧端点删除说明）；新增「配置中心」节按设计 §5.1-A 末行清单。

- [ ] **Step 2: first-deploy.md** —— 计数一行行改；`:249` 的预期输出**重算实据**：起新栈后按该处描述的检查动作实际执行一遍，把真实读数写回（**手册预期输出 = 判据的一部分**）；「怎么改配置」节内容：打开 `https://<域名>/admin`、口令来源（部署时 `.env` 的 `ADMIN_PASSWORD`）、保存后看「已保存（版本 N）；各服务 ≤60s 内生效」、好友房默认关（上线首个动作 = 要开就打开）；「回滚注意」节：全量换 tag、孤儿容器无害、ops 脚本从新检出送（刻意偏离）。

- [ ] **Step 3: 其余文档 + 台账** —— 按 Files 逐处；client-protocol 改写时**保留**「底分只能取自这张表」活契约、「不缓存」句反转成「缓存 + 推送 + 安全网语义（≤60s 生效）」；`:62-63` 的「第 8 条」引用改「`GET /api/config` 的 `baseScoreLevels`」。

- [ ] **Step 4: 提交**

```bash
git add docs README.md
git commit -m "docs(config-center): design.md/手册/client-protocol/README 修订面全表 + 台账两条（遗留表 / fillat 现状）"
```

---

## Task 18: 全量验收与收口

**Files:** 无代码改动（只跑与登记）。

- [ ] **Step 1: 本机全量门禁** —— `pnpm run ci`（六阶段）⇒ EXIT=0；`pnpm --filter @fight-the-landlord/conformance build` 

- [ ] **Step 2: 本机真栈全量 conformance** —— `bash scripts/deploy/conformance-stack.sh up` ⇒ 按 `--list` 顺序逐条跑（`for c in $(node tools/conformance/dist/run.js --list); do node tools/conformance/dist/run.js "$c"; done`）⇒ 全绿（Windows 上 `slice-07.5` 的 flock 两条按既有纪律**显式跳过**、不得读成通过）；收尾 `down` 干净

- [ ] **Step 3: 真浏览器探针** —— 按 memory 的三处 Windows 绕法（`--no-server` + `CHROME_BIN` + `--cdp-port 18800`）跑 `scripts/browser-e2e.mjs` ⇒ 全绿（含好友房开启后的创建流）

- [ ] **Step 4: 合入与推送** —— `git merge --ff-only feat/config-center` ⇒ 删分支 ⇒ master 上**复跑 `pnpm run ci`**（干净）⇒ 推 origin（**用户授权后**；推 ≠ 上线）

- [ ] **Step 5: CI 与 baselines 回填** —— 三 workflow 全绿；`conformance` 首轮会因 `slice-14` 基线未回填而红（**预期**）⇒ 从该 run 日志取 `[baseline] full slice-14-config-center = <N>` 回填 `baselines.json` ⇒ 再推 ⇒ 三绿

- [ ] **Step 6: 发布与演练（验收项；用户授权后）** —— ① **服务器 `.env` 手工追加** `ADMIN_PASSWORD` 与 `ADMIN_JWT_SECRET`（手册新节的命令；`.env` 部署永不覆盖）② 打 tag `v1.3.0` ⇒ release（images → conformance → deploy）全绿 ⇒ 线上独立验证（强制指 IP `<DEV_HOST_IP>`：`/api/health` + `GET /admin/` + 好友房关闭态）⇒ **跨边界回滚演练（C21②）**：dispatch 回 v1.2.0（验旧栈 + 孤儿容器）⇒ 回 v1.3.0 ⇒ 各留证据（两次 deploy 日志 + 线上健康）

- [ ] **Step 7: 如实登记未执行/未验证项** —— 按本仓纪律写入收口记录（不得把未跑写成跑了）；含：Windows 跳过的断言、需用户在场的验收（若有）、已知假红核对

- [ ] **Step 8: 收口提交**

```bash
git add -A
git commit -m "chore(config-center): 片⑦ 收口 —— baselines 回填（CI 读数）+ 验收证据与未执行项登记"
```


