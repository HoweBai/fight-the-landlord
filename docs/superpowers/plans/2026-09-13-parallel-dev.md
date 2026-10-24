# 斗地主前后端并行开发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在冻结的协议契约下，由前端与后端两个 agent 并行实现斗地主 MVP，并以端到端骨架保证「联调」从第一天就存在，而不是拖到最后。

**Architecture:** 三段式——(1) 协调者抽出 `packages/protocol` 作为唯一契约源并冻结；(2) 两端合力打通**一条**端到端骨架（登录 → 匹配 → 发牌 → 出一手 → 状态推送），同时建起联调测试管道；(3) 按**垂直切片**并行推进，**每个切片必须端到端联调通过才算完成**。

**Tech Stack:** TypeScript / NestJS 10 / socket.io 4 / ioredis / MySQL 8 + TypeORM / Vitest / pnpm workspace + Turborepo / uni-app (Vue 3) + Vite

> **协议包零依赖**：校验器用手写守卫而非 zod——省一个依赖、前端包体更小、也让「protocol 不依赖任何包」这条分层约束真正成立。

**Spec（执行者必须同时读这两份，本计划不自带规则细节）:**
- `docs/design.md` —— v4.1 主规格（协议、裁剪、身份、幂等、错误码、阶段）
- `docs/games/doudizhu.md` —— v1.2 玩法规则（牌型、轮转、结算、超时）
- `docs/appendix/platform-roadmap.md` —— 范围外功能（**不要实现**）

---

## Global Constraints

本计划的每个任务都隐含以下约束。全部来自 v4.1，**逐字照抄，不得自行解释**：

| # | 约束 |
|---|------|
| 1 | **端口**：HTTP `3000/3001/3002/3003/3005`，内部 RPC `3103/3105`，douzero `2021`，redis `6379`，mysql `3306` |
| 2 | **测试框架 Vitest**（不是 Jest）。`packages/shared` 行覆盖率 ≥ 80% |
| 3 | **服务间通信必须用 `Transport.TCP`** + `@MessagePattern`，pattern 名与 DTO 见 §4.2 |
| 4 | **对外 REST 与内部 RPC 严禁共用同一个方法**：对外走 `game.view`（裁剪），对内走 `game.snapshot`（完整） |
| 5 | **WebSocket**：socket.io 4，namespace `/ws/ddz`，dot 命名；**ack 承载响应**；**没有 `seq` 字段** |
| 6 | **幂等**：动作请求必须带 `baseVersion`，CAS 失败返回 `13004`。`13002`/`13003` 已废弃、不得使用 |
| 7 | **错误码必须是 5 位数字**（§11.2）。禁止新增字符串错误码；旧字符串码只能出现在 §11.4 的别名表里 |
| 8 | **身份只从网关注入的 `X-User-Id`（HTTP）或 socket 握手 `auth.userId`（WS）取**。**严禁**信任请求体里的 `userId`/`playerId` |
| 9 | **裁剪**：`PlayerView` 是唯一的出站对局类型。`actionLog`、他人 `hand`、`isRobot`、`botId`、`skillLevel` **永不出站** |
| 10 | **牌值编码**：接口/存储层用 DouZero 编码（`2` = 17）；**进入牌型判定前必须还原为内部 Rank**（`2` = 15） |
| 11 | **前端哑终端**：禁止任何游戏规则、牌型判定、游戏常量、货币计算（§12 的 F01–F10） |
| 12 | **契约包 `packages/protocol` 由协调者拥有**。两端**只读**；任何改动（尤其破坏性）必须两端同一个 PR |

---

## 执行模型（含取舍说明）

### 角色与工作区

| 角色 | 工作区 | 可写 | 只读 |
|------|--------|------|------|
| **协调者**（当前 agent） | `/home/howe/pokergame`（master） | `packages/protocol`、根配置、`docs/**` | — |
| **后端 agent** | `.worktrees/backend`（分支 `feat/backend`） | `packages/{api-gateway,user-service,room-service,game-service,robot-service,shared}`、`docker-compose.yml` | `packages/protocol`、`docs/**` |
| **前端 agent** | `.worktrees/frontend`（分支 `feat/frontend`） | `apps/client`（新建 uni-app） | `packages/protocol`、`docs/**` |

**目录不重叠** ⇒ 合并干净。根文件（`package.json` / `pnpm-lock.yaml` / `turbo.json` / `pnpm-workspace.yaml`）由**协调者**统一修改，两个 agent **不得**碰。

### 门禁

**每个切片必须端到端联调通过，才允许开始下一个切片。** 这是本计划与「开发完再联调」的唯一区别，也是它存在的理由。

### 与 writing-plans 默认模型的偏离（明确记录）

`writing-plans` 默认推荐「每个任务派一个**全新** subagent + 两段评审」，理由是**上下文不腐化**。本计划改用「两个**长期** agent 按层并行」，理由是**并行度**与你要求的「agent 需要理解项目」。

**代价与护栏**：
- 长期 agent 的上下文会腐化 → **我在每个切片后评审**，发现反复犯同一约定错误（例如又用字符串错误码、又信任 body 的 playerId）就**重新派生该 agent** 并把教训写进场景说明；
- 两个 agent 无法互相通信 → **我转达**；契约类问题一律由我裁决并落到 `packages/protocol`。

---

## File Structure

```
packages/protocol/                    ← 【新增】契约包，无任何依赖
├── package.json                       name: @fight-the-landlord/protocol
├── tsconfig.json
├── src/
│   ├── index.ts                       统一出口
│   ├── errors.ts                      数字错误码 enum + 每码的客户端处置
│   ├── codec.ts                       牌值编码唯一实现（DouZero ↔ 内部 Rank）
│   ├── views.ts                       Seat / RoomInfo / RoomPlayer / PlayerView / SettlementResult
│   ├── messages.ts                    C→S（8 条）与 S→C（9 条）的判别联合
│   └── validate.ts                    zod schema + validateOutbound / validateInbound
└── test/
    ├── codec.test.ts
    ├── errors.test.ts                 含「错误码集合与 §11.2 一致」的机械断言
    └── messages.test.ts

packages/shared/                      ← 后端拥有；改为依赖 protocol 的 codec
apps/client/                          ← 【新增】uni-app 工程，前端拥有
tools/mock-server/                    ← 【新增】协调者拥有：脚本化假服务端，前端可独立开发
tools/conformance/                    ← 【新增】协调者拥有：端到端联调测试
```

**依赖方向**（重要，不要搞反）：`protocol` 不依赖任何包；`shared` → `protocol`；各服务 → `shared` + `protocol`；`apps/client` → `protocol`（**只依赖 protocol，不依赖 shared**，否则会把游戏规则带进前端）。

---

## Task 0: 契约包 `packages/protocol`（协调者）

**为什么必须先做且不能并行**：两个 agent 需要一份**机器可校验**的契约。文档是给人读的叙事；`tsc` 才是两端的检查器。本轮已证明只靠文档会漏——`docs/design.md` §6.3 一度**漏掉了「请求匹配」这条 C→S 消息**，而那份文档被三组审查者逐行审过、还跑了 20 个探针。

**Files:**
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/codec.ts`
- Create: `packages/protocol/src/views.ts`
- Create: `packages/protocol/src/messages.ts`
- Create: `packages/protocol/src/validate.ts`
- Create: `packages/protocol/src/index.ts`
- Test: `packages/protocol/test/codec.test.ts`
- Test: `packages/protocol/test/errors.test.ts`
- Test: `packages/protocol/test/messages.test.ts`

**Interfaces:**
- Produces: `ErrCode`（enum）、`CLIENT_ACTION`（每个错误码的客户端处置）、`toInternalRank` / `toDouZero`、`PlayerView` / `SettlementResult` / `RoomInfo` / `RoomPlayer` / `Seat`、`ClientMessage` / `ServerMessage` 判别联合、`validateOutbound` / `validateInbound`

- [ ] **Step 1: 建包骨架**

`packages/protocol/package.json`：
```json
{
  "name": "@fight-the-landlord/protocol",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": { "typescript": "^5.7.0", "vitest": "^2.1.0" }
}
```

`packages/protocol/tsconfig.json`：extends 根 `tsconfig.base.json`，`outDir: dist`、`rootDir: src`。

- [ ] **Step 2: 写 `src/codec.ts` 与它的失败测试**

```ts
// packages/protocol/test/codec.test.ts
import { describe, it, expect } from 'vitest';
import { toInternalRank, toDouZero, RANK_2 } from '../src/codec';

describe('codec', () => {
  it('maps DouZero 17 to internal rank 15', () => {
    expect(toInternalRank(17)).toBe(RANK_2);   // 15
  });
  it('maps internal rank 15 to DouZero 17', () => {
    expect(toDouZero(RANK_2)).toBe(17);
  });
  it('is identity for 3..14 and 20/30', () => {
    for (const n of [3, 7, 14, 20, 30]) {
      expect(toInternalRank(n)).toBe(n);
      expect(toDouZero(n)).toBe(n);
    }
  });
});
```

Run: `pnpm --filter @fight-the-landlord/protocol test` → 期望 FAIL（`toInternalRank` 未定义）

- [ ] **Step 3: 实现 `src/codec.ts`**

```ts
/** 内部 Rank 的 2 是 15；DouZero 的 2 是 17。这是唯一的转换真源。 */
export const RANK_2 = 15;          // 内部 Rank
export const DOUZERO_2 = 17;       // DouZero 编码

export function toInternalRank(douzeroInt: number): number {
  return douzeroInt === DOUZERO_2 ? RANK_2 : douzeroInt;
}

export function toDouZero(internalRank: number): number {
  return internalRank === RANK_2 ? DOUZERO_2 : internalRank;
}

/** 展示用：DouZero 编码 → 牌面文字 */
export function toDisplay(douzeroInt: number): string {
  const r = toInternalRank(douzeroInt);
  if (r === 20) return '小王';
  if (r === 30) return '大王';
  if (r === RANK_2) return '2';
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  return String(r);
}
```

Run: 同上 → 期望 PASS

- [ ] **Step 4: 写 `src/errors.ts` 与「与 §11.2 一致」的机械断言**

```ts
// packages/protocol/test/errors.test.ts
import { describe, it, expect } from 'vitest';
import { ErrCode, CLIENT_ACTION } from '../src/errors';

/** 这张表必须与 docs/design.md §11.2 完全一致。
 *  文档改了这里就必须同 PR 改；这里的断言防的是「代码悄悄漂移」。 */
const SPEC_CODES = [
  0,
  10001, 10002, 10003, 10004, 10005, 10006, 10007,
  11001, 11002, 11003, 11004,
  12001, 12002, 12003, 12004, 12005, 12006, 12007, 12008, 12009,
  13001, 13004, 13005, 13006, 13007, 13008, 13009, 13010,
];

describe('error codes match docs/design.md §11.2', () => {
  it('has exactly the spec set', () => {
    expect(Object.values(ErrCode).filter(v => typeof v === 'number').sort((a, b) => (a as number) - (b as number)))
      .toEqual(SPEC_CODES);
  });
  it('every non-zero code declares a client action', () => {
    for (const c of Object.values(ErrCode)) {
      if (typeof c === 'number' && c !== 0) expect(CLIENT_ACTION[c as ErrCode]).toBeDefined();
    }
  });
  it('does not contain deprecated 13002 / 13003', () => {
    const values = Object.values(ErrCode) as number[];
    expect(values).not.toContain(13002);
    expect(values).not.toContain(13003);
  });
});
```

- [ ] **Step 5: 实现 `src/errors.ts`**

```ts
export enum ErrCode {
  OK = 0,
  BAD_PARAM = 10001,
  UNAUTHENTICATED = 10002,
  FORBIDDEN = 10003,
  TOKEN_EXPIRED = 10004,
  TOKEN_INVALID = 10005,
  RATE_LIMITED = 10006,
  UPSTREAM_UNAVAILABLE = 10007,

  PHONE_TAKEN = 11001,
  BAD_CREDENTIALS = 11002,
  USER_BANNED = 11003,
  USER_NOT_FOUND = 11004,

  ROOM_NOT_FOUND = 12001,
  ROOM_FULL = 12002,
  NOT_YOUR_TURN = 12003,
  NOT_IN_ROOM = 12004,
  KICK_FORBIDDEN = 12005,
  FRIEND_ROOM_FAILED = 12006,
  MATCH_TIMEOUT = 12007,
  ROOM_ALREADY_STARTED = 12008,
  ALREADY_IN_QUEUE = 12009,

  ILLEGAL_ACTION = 13001,
  VERSION_CONFLICT = 13004,
  GAME_OVER = 13005,
  INVALID_CARDS = 13006,
  ACTION_TIMEOUT = 13007,
  BOT_DECISION_TIMEOUT = 13008,
  GAME_NOT_STARTED = 13009,
  RECONNECT_RECORD_MISSING = 13010,
}

/** 客户端对每个错误码的处置。前端实现必须按此表分支，不得自行发明。 */
export enum ClientAction {
  /** 静默忽略（幂等重复） */
  IGNORE = 'ignore',
  /** 重新拉取当前裁剪快照，再由用户重新操作（§6.5 对 13004 的唯一处置） */
  REFRESH_SNAPSHOT = 'refresh_snapshot',
  /** 主动重连（仅用于快照类 version 回退，M08） */
  RECONNECT = 'reconnect',
  /** 提示用户并终止当前操作 */
  TOAST = 'toast',
  /** 提示用户并返回大厅 */
  BACK_TO_LOBBY = 'back_to_lobby',
}

export const CLIENT_ACTION: Record<ErrCode, ClientAction> = {
  [ErrCode.OK]: ClientAction.IGNORE,
  [ErrCode.BAD_PARAM]: ClientAction.TOAST,
  [ErrCode.UNAUTHENTICATED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.FORBIDDEN]: ClientAction.TOAST,
  [ErrCode.TOKEN_EXPIRED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.TOKEN_INVALID]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.RATE_LIMITED]: ClientAction.TOAST,
  [ErrCode.UPSTREAM_UNAVAILABLE]: ClientAction.TOAST,
  [ErrCode.PHONE_TAKEN]: ClientAction.TOAST,
  [ErrCode.BAD_CREDENTIALS]: ClientAction.TOAST,
  [ErrCode.USER_BANNED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.USER_NOT_FOUND]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.ROOM_NOT_FOUND]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.ROOM_FULL]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.NOT_YOUR_TURN]: ClientAction.IGNORE,          // 几乎总是本地状态过期
  [ErrCode.NOT_IN_ROOM]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.KICK_FORBIDDEN]: ClientAction.TOAST,
  [ErrCode.FRIEND_ROOM_FAILED]: ClientAction.TOAST,
  [ErrCode.MATCH_TIMEOUT]: ClientAction.TOAST,
  [ErrCode.ROOM_ALREADY_STARTED]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.ALREADY_IN_QUEUE]: ClientAction.IGNORE,
  [ErrCode.ILLEGAL_ACTION]: ClientAction.TOAST,
  [ErrCode.VERSION_CONFLICT]: ClientAction.REFRESH_SNAPSHOT,  // §6.5：唯一处置
  [ErrCode.GAME_OVER]: ClientAction.BACK_TO_LOBBY,
  [ErrCode.INVALID_CARDS]: ClientAction.TOAST,
  [ErrCode.ACTION_TIMEOUT]: ClientAction.REFRESH_SNAPSHOT,
  [ErrCode.BOT_DECISION_TIMEOUT]: ClientAction.IGNORE,        // 内部码，客户端不应收到
  [ErrCode.GAME_NOT_STARTED]: ClientAction.REFRESH_SNAPSHOT,
  [ErrCode.RECONNECT_RECORD_MISSING]: ClientAction.BACK_TO_LOBBY,
};
```

Run: `pnpm --filter @fight-the-landlord/protocol test` → 期望 PASS

- [ ] **Step 6: 写 `src/views.ts`**

字段**逐字**照 `docs/design.md` §3.1 / §3.2 / §4.2：

```ts
import type { ErrCode } from './errors';

export interface Seat { userId: string; seat: number; isRobot: boolean }
export interface RoomInfo {
  code: string;
  mode: 'random' | 'practice';
  status: 'waiting' | 'playing' | 'finished' | 'cancelled';
  playerCount: number;
  maxPlayers: number;
  baseScore: number;
}
export interface RoomPlayer { id: string; seat: number; cardCount?: number }

export interface LastPlayedHand { cards: number[]; type: number; keyRank: number; length: number }

export interface PlayerView {
  roomCode: string;
  version: number;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  seat: number;
  hand: number[];                                  // 仅自己的手牌
  cardCounts: [number, number, number];
  bottomCards: number[] | null;
  landlordSeat: number | null;                     // 「谁是地主」的唯一来源
  currentPlayer: number;
  lastPlayedHand: LastPlayedHand | null;
  lastPlayedIdx: number;
  turnDeadlineAt: number;
  bidPhase: {
    currentBidder: number;                         // 叫抢期行动者在这里
    bidMultiplier: number;
    landlordCandidate: number;
    grabActions: number;
    redealCount: number;
  };
  playPhase: { bombCount: number };
  winner?: 'landlord' | 'farmer';
}

export interface SettlementResult {
  roomCode: string;
  baseScore: number;
  winner: 'landlord' | 'farmer';
  landlordSeat: number;
  farmerSeats: number[];
  multiplier: number;
  spring: 'none' | 'spring' | 'anti-spring';
  landlordScoreChange: number;
  farmerScoreChange: number;
}

export interface Ack<T = unknown> { code: ErrCode; message?: string; data?: T }
```

- [ ] **Step 7: 写 `src/messages.ts`（判别联合）**

**C→S 共 8 条、S→C 共 9 条**，清单来自 §6.3。**这份清单本身就是契约，改动需两端同 PR。**

```ts
import type { PlayerView, RoomPlayer, RoomInfo, SettlementResult } from './views';

/** 每个请求都带这三个字段（§6.2）。没有 seq。 */
export interface RequestMeta {
  reqId: string;          // UUID，仅用于日志追踪
  baseVersion: number;    // 仅 game.bid / game.play / game.pass 有意义，其余传 0
  timestamp: number;
}

export type ClientMessage =
  | { type: 'room.match';    meta: RequestMeta; payload: { mode: 'random' | 'practice' } }
  | { type: 'room.unmatch';  meta: RequestMeta; payload: Record<string, never> }
  | { type: 'room.join';     meta: RequestMeta; payload: { roomCode: string } }
  | { type: 'room.leave';    meta: RequestMeta; payload: { roomCode: string } }
  | { type: 'game.bid';      meta: RequestMeta; payload: { grab: boolean } }
  | { type: 'game.play';     meta: RequestMeta; payload: { cards: number[] } }
  | { type: 'game.pass';     meta: RequestMeta; payload: Record<string, never> }
  | { type: 'game.reconnect';meta: RequestMeta; payload: { lastVersion?: number } };

export type ServerMessage =
  | { type: 'room.matched';      version: number; payload: { roomCode: string; seat: number } }
  | { type: 'room.state_update'; version: number; payload: { status: RoomInfo['status']; players: RoomPlayer[] } }
  | { type: 'game.deal';         version: number; payload: PlayerView }
  | { type: 'game.current_turn'; version: number; payload: { seat: number; timeoutMs: number } }
  | { type: 'game.state_update'; version: number; payload: PlayerView }
  | { type: 'game.finished';     version: number; payload: { winner: 'landlord' | 'farmer' } }
  | { type: 'game.settlement';   version: number; payload: SettlementResult }
  | { type: 'system.error';      version: number; payload: { code: number; message: string } }
  | { type: 'system.warning';    version: number; payload: { code: number; message: string } };

/** 参与 baseVersion CAS 的请求（§6.5 的适用范围表） */
export const CAS_MESSAGES = ['game.bid', 'game.play', 'game.pass'] as const;
```

- [ ] **Step 8: 写 `src/validate.ts`**

用 zod 为 `ClientMessage` / `ServerMessage` 各写一个 schema，导出：

```ts
export function validateOutbound(msg: unknown): ServerMessage   // 服务端发送前调用，不符即抛错
export function validateInbound(msg: unknown): ServerMessage    // 客户端处理前调用，不符即拒绝并记日志
export function validateClientMessage(msg: unknown): ClientMessage
```

**这一步是契约从「约定」变成「断言」的关键**：服务端拦住「发了契约里没有的东西」，客户端在开发期就发现服务端漂移，而不是等 UI 莫名错乱。

- [ ] **Step 9: 加 `src/index.ts` 出口，跑通全包**

Run:
```bash
pnpm install
pnpm --filter @fight-the-landlord/protocol build
pnpm --filter @fight-the-landlord/protocol test
pnpm --filter @fight-the-landlord/protocol lint
```
Expected: 三条全绿。

- [ ] **Step 10: 把 `packages/shared` 的编码实现改为引用本包**

`packages/shared/src/ddz/game.ts` 的 `cardToInt` / `intToCard` 与 `ddz/play.ts:7-21` 的 `douzeroIntToCard` 都改为 `import { toInternalRank, toDouZero } from '@fight-the-landlord/protocol'`。

> **同时需要一处规格同步**：`docs/games/doudizhu.md` §10 目前写「唯一真源在 `packages/shared/src/ddz/game.ts`」；改为「唯一真源在 `packages/protocol/src/codec.ts`，`shared` 引用它」。这是加性澄清，不改语义。

Run: `pnpm --filter @fight-the-landlord/shared test` → 期望 91 个用例仍全绿（**注意**：其中 3 个用例锁定了错误行为——`settle.test.ts:35` 断言加法倍数、`play.test.ts:74-75` 与 `:107` 断言错误规则。**本任务不动它们**，它们由后端 agent 在切片 D/E 一并修正）。

- [ ] **Step 11: 提交**

```bash
git add packages/protocol packages/shared/src/ddz docs/games/doudizhu.md
git commit -m "feat(protocol): 抽出协议契约包作为前后端唯一契约源"
```

---

## Task 1: worktree 与基线（协调者）

**Files:**
- Modify: `.gitignore`（加 `.worktrees/`）

- [ ] **Step 1: 忽略 `.worktrees/` 并提交**

按 `using-git-worktrees` skill 的安全要求：**未忽略就创建 worktree 会把整个工作区提交进仓库**。

```bash
printf '\n# git worktrees\n.worktrees/\n' >> .gitignore
git add .gitignore && git commit -m "chore: ignore .worktrees"
```

- [ ] **Step 2: 建两个 worktree**

```bash
git worktree add .worktrees/backend  -b feat/backend
git worktree add .worktrees/frontend -b feat/frontend
```

- [ ] **Step 3: 各自安装依赖、构建、跑基线**

```bash
(cd .worktrees/backend  && pnpm install && pnpm build)
(cd .worktrees/frontend && pnpm install && pnpm build)
(cd .worktrees/backend  && pnpm --filter @fight-the-landlord/protocol test)   # 期望 33/33
(cd .worktrees/backend  && pnpm --filter @fight-the-landlord/shared test)     # 期望 91/91
```

> ⚠️ **必须先 `pnpm build`，不能直接 `pnpm --filter <pkg> test`。**
> `dist/` 是 gitignore 的，全新 worktree **没有任何构建产物**；而 `protocol` 的入口是 `dist/index.js`，
> 所以 `shared` 会因解析不到 `@fight-the-landlord/protocol` 而 **4 个测试文件 collect 失败**（表现为「57/91 通过」）。
> `turbo run test` 自带 `dependsOn: ["build"]` 所以走 `pnpm test` 不会有这个问题——但直接 `--filter` 会绕过 turbo。
> turbo 缓存是跨 worktree 共享的，所以这一步通常 1 秒内完成。

> ⚠️ **`room-service` 的 `match.service.test.ts` 有未 mock 的真实网络调用**（见 A.2 E10）：
> 它会在容器未运行时挂死 5 秒超时（2 个用例）。跑后端测试前先 `docker compose up -d`。

**基线必须是绿的**——`api-gateway` 的 8 个失败用例是**已知的预先存在缺陷**（见 A.2 E1），是后端 agent 的第一个任务，不是在 worktree 里新引入的。

---

## Task 2: 后端骨架 —— 一条最小路径（后端 agent）

**目标**：让 `登录 → 匹配 → room.matched → 发牌 → 出一手 → 收到 game.state_update` 这条路径在**真实后端**上跑通。允许最简实现（房间/对局可硬编码，机器人先不接）。

**Files:**
- Modify: `packages/api-gateway/src/auth/jwt.middleware.ts`（**先修 S1**：白名单去掉 `'/'`）
- Modify: `packages/api-gateway/src/gateway/*`（身份注入 `X-User-Id` + `INTERNAL_SERVICE_TOKEN`）
- Modify: `packages/game-service/src/game/game.controller.ts`（**先修 S2/S8**：`/api/games/*` 不得返回完整 session）
- Create: `packages/game-service/src/game/view.builder.ts`（把 `GameSession` 裁成 `PlayerView`）
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（接线 `@SubscribeMessage`、正确的 server 实例、`socket.data.userId`）
- Create: `packages/room-service/src/gateway/message.router.ts`（按 `ClientMessage` 分发）
- Modify: `packages/game-service/src/game/game.service.ts`（`version + 1`、`turnDeadlineAt`、去掉进程内 Map 作为真源）

**Interfaces:**
- Consumes: Task 0 的 `ErrCode` / `PlayerView` / `ClientMessage` / `ServerMessage` / `validateOutbound`
- Produces: 可用的 `room.match` / `room.matched` / `game.deal` / `game.play` / `game.state_update` 最小闭环

**DoD（可执行，不是散文）**

```bash
# 1) S1 必须已修：匿名写操作被拒
curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3000/api/rooms    # 期望 401

# 2) S2/S8 必须已修：看不到他人手牌
TOKEN=... ; curl -s localhost:3000/api/games/<code> -H "Authorization: Bearer $TOKEN" \
  | jq '[.players[].hand | length] | max'                                   # 期望 <= 20 且只有自己的手牌有牌面
# 更硬的断言：出站校验器对每条推送断言「无他人手牌、无 actionLog、无 isRobot」

# 3) 全绿
pnpm test
```

- [ ] **Step 1:** 先修 S1（白名单）并补一个测试断言「匿名 POST /api/rooms → 401」
- [ ] **Step 2:** 身份注入 + `INTERNAL_SERVICE_TOKEN`，下游只认 `X-User-Id`
- [ ] **Step 3:** 实现 `view.builder.ts`，并给所有出站路径接上 `validateOutbound`
- [ ] **Step 4:** WS 接线（`@SubscribeMessage` + `socket.data.userId` 来自握手 `auth`）
- [ ] **Step 5:** 打通 `room.match → room.matched → game.deal → game.play → game.state_update`
- [ ] **Step 6:** 跑 DoD 三条，提交

---

## Task 3: 前端骨架 —— uni-app 工程 + mock（前端 agent）

**Files:**
- Create: `apps/client/`（uni-app + Vue 3 + Vite 工程；`package.json` 名 `@fight-the-landlord/client`）
- Create: `apps/client/src/net/socket.ts`（socket.io 客户端 + ack + `baseVersion` + `reqId`）
- Create: `apps/client/src/net/validate.ts`（复用 `validateInbound`）
- Create: `apps/client/src/stores/game.ts`（Pinia；**只存渲染所需状态**）
- Create: `apps/client/src/pages/{login,lobby,room,table}.vue`
- Create: `apps/client/src/components/Card.vue`（用 `toDisplay()` 渲染牌面）

**Interfaces:**
- Consumes: Task 0 的 `PlayerView` / `ServerMessage` / `ErrCode` / `CLIENT_ACTION` / `toDisplay`
- Produces: 能对 mock 跑通同一路径的客户端

**硬性约束（违反即打回）**

1. **不得 import `@fight-the-landlord/shared`**（会把游戏规则带进前端）。只允许 `protocol`。
2. 不得出现任何牌型判定、倍数计算、底分常量（§12 F01/F02/F09/F10）。
3. 每个入站消息先过 `validateInbound`。
4. 每个错误码走 `CLIENT_ACTION` 表分支，不自行发明处置。

**DoD**

```bash
cd apps/client
pnpm test          # 含一条「前端不依赖 shared」的断言，以及 §12.4 的「源码静态扫描」用例
pnpm lint          # vue-tsc --noEmit
pnpm build
```

> **§12.4 的落地形态已按规格收敛（2026-09-13 协调者修订）**：本行原文写「`pnpm lint` 含三条 ESLint 规则」，
> 与 `docs/design.md` §12.4 自己的 **MVP 形态**条款不符——该条款明确允许在自定义 ESLint 插件就绪前，
> 用**跑在 `pnpm test` 里的源码静态扫描测试**实现同一约束。实测 `apps/client` 的 `lint` 只是
> `vue-tsc --noEmit`，仓库根无任何 ESLint 配置。故本切片的等价保护是
> `apps/client/test/source-boundary.test.ts`（由 `pnpm test` 执行）；ESLint 插件是后续加固，不阻塞切片。

- [ ] **Step 1:** 建工程骨架，加 `pnpm-workspace.yaml` 的 `apps/*`（**这行由协调者改**，见 Global Constraints 12）
- [ ] **Step 2:** 接入 `protocol` 的编码与类型
- [ ] **Step 3:** 写 socket 客户端（ack + `baseVersion` + `reqId` + 入站校验）
- [ ] **Step 4:** 四个页面 + `Card.vue`
- [ ] **Step 5:** 接 §12.4 的 ESLint 规则
- [ ] **Step 6:** 对 mock 跑通骨架路径，提交

---

## Task 4: Mock 服务与联调管道（协调者）

**为什么必须做**：它是**唯一**能让前端不等后端的手段，也是**契约空洞的探测器**。前端每写一个 UI 交互，就会立刻发现契约里缺哪条消息。

**Files:**
- Create: `tools/mock-server/src/index.ts`（socket.io server，实现 Task 0 的契约）
- Create: `tools/mock-server/src/scripted-game.ts`（脚本化对局：自己跟自己打一局）
- Create: `tools/conformance/src/skeleton.test.ts`（**真实后端** + 真实 socket 客户端，跑通骨架路径）

- [ ] **Step 1:** mock 实现 `room.match → room.matched → game.deal → game.bid → game.play → game.state_update → game.finished → game.settlement`
- [ ] **Step 2:** mock 的每条出站都走 `validateOutbound`（保证 mock 与契约同源）
- [ ] **Step 3:** 写 conformance 测试：起真实后端 + 连三个客户端，断言骨架路径走通
- [ ] **Step 4:** 把 conformance 挂进 CI

---

## Task 5–10: 垂直切片（两端并行）

**每个切片的完成判据统一为**：该切片的后端 DoD + 前端 DoD + conformance 用例**三者同时通过**。**未通过不得开始下一片。**

> **进度（2026-09-13）**
> - **切片 5（断线重连）已完成并合并**（`a4c7781`）：`slice-05` → 29 项断言。含**负对照**（在未修复的镜像上跑同一用例，
>   匹配/发牌/进房/叫抢全部走通、恰好卡在重连那一步拿到 `13010`），证明用例有判别力。
> - **切片 6（登录 + 房间列表）已完成并合并**（`42b64bb`）：`slice-06` → 39 项断言，`slice-05` 回归 29 项断言；
>   工作区 `pnpm build/test/lint` 19/19 三项全绿。计划 `2026-09-13-slice-06-login-and-room-list.md` 里记了
>   执行期发现的三处计划缺陷（R38/R39/R40）与一处评审 Critical（R41：**网关有两个验签点**）。
> - 开工前**必读** `agent-briefs.md` 的「交接现状」「切片 6 门禁实测」「已知环境事实」——
>   尤其两条：跑 conformance 前必须重建镜像，而本机 `registry-mirrors` 全挂时要用
>   **`DOCKER_BUILDKIT=0 docker compose build`**。
> - **下一片 = 切片 7（匹配 → 进房）**。它需要**先写计划**（`/writing-plans`），再按「后端 / 前端 / conformance」三方分工派发。
>   参考模板：切片 6 的计划文件把「裁决、Interfaces、TDD 步骤、门禁命令」都写全了，可照它的结构写切片 7。
> - **切片 7 计划已落盘（`ad2cbb1`）**：`2026-09-13-slice-07-match-and-join.md`。
>   核心裁决 R42–R54，其中 **R44**（超时**补机器人**，绝不静默丢弃）与 **R50**（前端 `room.matched` 后必须 `room.join`）
>   是本片真正的修复点；Task 1–3 后端、Task 4–5 前端、Task 6 由协调者写 conformance 并跑门禁。
> - **切片 7（匹配 → 进房）已完成并合并（`9dcbaa6`）**：`slice-07` → **39 项断言**，`slice-06` → 99 项、
>   `slice-05` → 29 项（回归全绿）；`turbo run test+lint` **29/29**、`build` **10/10**（全部 `--force`、0 cached）；
>   `room-service` 103 → **126**、`client` 119 → **137**。
>   **门禁抓出的真缺陷（都不是「跑绿已有测试」能发现的）**：
>   **R44**（旧实现超时把玩家静默丢弃 / 单人永不被处理）、**R48**（`bot-` 前缀出站泄漏，既有断言用的数据恰好不含 bot）、
>   **R57**（计划初稿的「12007 整队淘汰」会被**历史残留队列成员**带崩，评审 conformance 用例时发现）、
>   **R70**（`acquireBot` 少 `/api` 前缀 → 真实拓扑 **404**，**30 秒补机器人在部署环境里从未成功过**；
>   单测抓不到是因为替身只断言了调用次数、没断言 URL）。
>   执行期裁决共 **R55–R71**，计划文件里逐条有据可查；`agent-briefs.md` 另记了 5 条通用教训
>   （替身契约 / 反向断言 / 变异自证 / 门禁同负载 / 因果靠插桩）。
> - **门禁陷阱（必记）**：合并后第一次 `pnpm test` 打印 `Cached: 19 cached / FULL TURBO` 是 turbo
>   **回放缓存日志**，不是真跑；门禁必须 `pnpm exec turbo run test lint --force`。

> **进度（2026-09-15）—— 切片 7.1（room-service 收尾：C11 原子入座 + E10 单测去网络依赖）已完成并门禁通过**
>
> 计划：`2026-09-15-slice-07.1-room-atomic-seating.md`（裁决 **R124–R134**）。**无前端**，两方分工：
> 后端 agent 做 Task 1–3（`77de3d0`/`52708c6`/`e167949`/`0f98391`/`58aa73f`）、
> conformance 方做 Task 4（`c80645b`/`66e7496`），协调者合并 `9eb410c` + 补一条 `8496ab8`。
>
> **门禁（master `8496ab8`，全部 `--force`、0 cached）**：
> `turbo run test lint --force` ✅ **29/29** · `turbo run build --force` ✅ **10/10**；
> **`room-service` 134 → 156** · `shared` 100 · `client` 142(+2 skipped) · `game-service` 67 ·
> `api-gateway` 81 · `user-service` 29 · `protocol` 39 · `robot-service` 12。
> conformance（先主检出 `build --force`，再 `DOCKER_BUILDKIT=0 docker compose build room-service`）：
> **`slice-07.1` ✅ 28 项 / 2.4s** · `slice-07` ✅ 39 · `slice-06` ✅ 169 · `slice-08` ✅ 55 ·
> `slice-07.2-security` ✅ 39 · `slice-07.2-boundary` ✅ 70 · `slice-05` ✅ 29（回归全绿）。
>
> **关闭的偏差**：**C11 / E10 / N8**；**新增编号 N9**（§10.1 的「`room:{code}` 元数据应是 Hash」此前
> 只在 `design.md` 的 `[偏差]` 段里、对账表**无编号** —— 本片登记）。
> **负对照（未修镜像上跑同一条用例，4 次重跑一致）**：
> `❌ 重复 join 后 playerCount（旧实现 = 2）：期望 1，实际 2`；容器内取证 `players.push` ×2、`hsetnx` ×0。
>
> **执行期抓出的两类真问题**（都不是「跑绿已有测试」能发现的）：
> **R132**（conformance 方查出）：**「并发复现竞态」需要连接已预热** —— 冷连接时 TCP accept 会把
> 20 路并发**串行化**，旧实现**意外正确**（`ok=3 / playerCount=3`，用例假绿）；改用显式 keep-alive 池
> 预热 `BURST+4` 条后，第 ③ 组在同一未修镜像上复现 RED（`期望 3，实际 20`）。
> 同一条还给出：**`playerCount` 只能证「不超员」**（旧实现实测 `ok=4 / playerCount=3`），
> **`并发成功路数 === 3` 才是「不丢人」的判据**。
> **writeMeta 缺陷**（协调者评审查出，是**计划自身的 bug**）：`updateStatus` 把含 `players` 的 `Room`
> 传给 `writeMeta`，而 `RoomMeta` 只是**编译期**类型 ⇒ `JSON.stringify` 会把 `players` 写回 `room:{code}` JSON，
> 座位出现第二个会漂移的真源（违反 R124）。已在 `writeMeta` 内部显式投影 + 补判据（`52708c6`）。
> **计划漏抄一条对账表条目**：**N8** 由后端 agent 对照对账表查出（R133）。
>
> **下一片 = 切片 7.2 完整片**（S4/S5/S6/S7/A6/A7 + N5/N6 + **R98**，必须在切片 9 前），再切片 9（出牌轮转）。

> **进度（2026-09-15）—— 切片 8（叫抢地主）已完成并门禁通过**
>
> 计划：`2026-09-15-slice-08-bidding.md`（裁决 **R101–R123**）。三方分工与切片 7 相同：
> 后端 agent 做 Task 1–4、前端 agent 做 Task 5、协调者写 Task 6（`slice-08` conformance）。
> **后端 `feat/backend`**（`57ad8ca`/`c68a5d8`/`dbd5a10`/`877d780`）+ **前端 `feat/frontend`**（`f529274`）
> 两条线文件集互不相交，合并干净。
>
> **门禁（master `ef7c89c`，全部 `--force`、0 cached）**：
> `turbo run test lint --force` ✅ **29/29** · `turbo run build --force` ✅ **10/10**；
> `client` **142**(+2 skipped) · `shared` **100** · `game-service` **67** · `robot-service` **12** ·
> `api-gateway` 81 · `room-service` 134 · `user-service` 29 · `protocol` 39。
> conformance：`slice-08` ✅ **55 项 / 10.4s** · `slice-07` ✅ 39 · `slice-06` ✅ 124 ·
> `slice-07.2-security` ✅ 39 · `slice-07.2-boundary` ✅ 70 · `slice-05` ✅ 29（回归全绿）。
>
> **关闭的偏差**：**C4 / C15 / C22 / C23 / C24**（`deviation-ledger.md` §1.1 已逐条改写）。
> **执行期新增的裁决**：**R116**（C15 的**第四处**连带补偿：`computePlayedCards()` 双重扣减底牌 ——
> 底牌已在地主手牌里，再减一次会让与底牌同值的牌被判成「未出」）、
> **R117**（no-op 变异实例：两条「显然成立」的断言对双重扣减恒等，必须构造「第一次扣除提前耗尽」的输入）、
> **R118**（**C15 的漏删在门禁里抓不住**：旧补偿在 `hand.push` 后重算 `cardCounts`，
> 人为满足 `protocol/src/validate.ts:100`，而协议校验不检查牌堆守恒 ⇒ 既有 61 条用例一条也抓不到 23 张；
> 已补一条守恒断言，并**登记**「契约侧机械闸」为后续加固项）、
> **R119**（`GameService.timers` **从不自我清理** ⇒ `timers.has()` 不能当「有活动计时器」用；
> 本片把判据改成结构性，隐患**未修**、建议单独立条）、
> **R120–R123**（计划缺陷就地修正：非法牌值夹具、`new Set(...).size === 54` 不可能成立、
> Task 4 首条用例走不到 `catch`、`handleBid` 结束判据按 §3.2 收敛）。
> 前端侧 **R112–R115**（CAS 消息的 ack 不释放串行队列、jsdom 下 click 打在 disabled 上是静默 no-op 等）
> 已写进 `agent-briefs.md` 的「切片 8 新增的通用教训」。
>
> **下一片 = 切片 7.1（C11 原子入座 + E10 单测去网络依赖）**，然后 **7.2 完整片**（S4/S5/S6/S7/A6/A7 +
> N5/N6 + R98，**必须在切片 9 前**），再切片 9。

> **进度（2026-09-14）—— 切片 7.2-P0/P1 安全收口已完成**
>
> 起因：对该做切片 8 之前做了一次 **A.2 偏差对账**（4 个只读审计 × 51 条 → `docs/superpowers/plans/deviation-ledger.md`，
> 每条含判定/证据/关闭者/归属 + **按切片的待办清单**）。对账时发现一条**已可用的作弊路径**：
> `GET /api/games/:roomCode?seat=<n>` 无归属校验 + 网关未编码路径参数 ⇒ `GET /api/games/<code>%3Fseat=1`
> 经网关即可读到**他人完整手牌**（配 `GET /api/rooms` 列房间号）。故插入两片：
>
> - **P0（`ff44a4d`）**：删掉 `?seat=`（全仓含测试**零调用方**，只有一句误导性注释提到它）；
>   网关对 **5 处**路径参数做「**形状闸**（`/^[0-9A-Z]{6}$/` → `10001` 且**不打下游**）+ 编码」。
> - **P1（`9084bf9` + `27fcf53`）**：网关**每一跳**注入 `X-Internal-Token`；user/room/game/robot 用本地中间件
>   在**全部业务路由**校验（`/api/health` 豁免，否则容器全 unhealthy）；`acquireBot`/`startGame` 无条件带头；
>   网关与 WS 握手都 fail-closed。
>
> **门禁（master，全部 `--force`、0 cached）**：`slice-07.2-boundary` ✅ **70 项** ·
> `slice-07.2-security` ✅ 39 · `slice-07` ✅ 39 · `slice-06` ✅ 94 · `slice-05` ✅ 29；
> `turbo run test lint --force` ✅ **29/29**（room-service 134 · client 137 · game-service 61 · api-gateway 81 · user-service 29）。
> **对账表判定变化**：**S2/S8**（读他人手牌）与 **N3/N4/N7** 关闭；仍开放 26 条。
>
> ⚠️ **两个必读的陷阱（已写进 `agent-briefs.md`）**：
> ① `docker-compose.yml:154` 把宿主 `packages/robot-service/dist` **bind-mount** 进容器
>    ⇒ **对 robot-service 重建镜像无效**，跑 conformance 前**必须先在主检出** `pnpm exec turbo run build --force`
>    （症状：四个服务里**只有某一个「不听话」**，而镜像里明明有新代码 —— P1 实测就是这么卡住的）；
> ② `Dockerfile.user-service` 的 `pnpm install` 必须 `--ignore-scripts`（否则 sqlite3 的 `prebuild-install`
>    去 GitHub 拉包且无超时，本机实测卡 50 分钟），但**必须**随后 `node-pre-gyp --build-from-source` 重建 bcrypt，
>    否则 user-service 以 `MODULE_NOT_FOUND` 崩溃重启。
>
> ⚠️ **仍不可部署**（§A.3）：P1 的边界只在「**不发布 3001–3005** + **显式配置 `INTERNAL_SERVICE_TOKEN`**」时成立；
> 当前 compose 两条都不满足（端口全发布 + 默认 token 是仓库公开常量）⇒ 用默认值部署仍可冒充（见对账表 R98）。
>
> **下一片 = 切片 8（叫抢地主）**，**建议新开 session**：先读 `agent-briefs.md` 的「交接现状 / 切片 7 门禁实测 /
> 切片 7.2-P0/P1 门禁实测 / 已知环境事实」，再读 `deviation-ledger.md` §2 里属于切片 8 的清单
> （C4 流局重发 · **C15 底牌并入地主手牌，三处同片同改** · C22 超时重挂 · C23 倍率上限 8 · C24 `currentBidder` 双重推进），
> 然后按切片 7 的同一套流程写计划（`/writing-plans`）并派「后端 / 前端 / conformance」三方。
> **执行顺序**：切片 8 → 7.1（C11 原子入座 + E10 单测去网络依赖）→ **7.2 完整片**（S4/S5/S6/S7/A6/A7 + N5/N6 + R98，**必须在切片 9 前**）→ 切片 9 → 10 → 11。

> **进度（2026-09-15）—— 切片 7.2 完整片（安全收口）已完成并门禁通过**
>
> 计划：`2026-09-15-slice-07.2-security-hardening.md`（裁决 **R135–R156**，其中 R148–R156 是执行期查出的机制/计划缺陷）。
> 分工：后端 agent 做 Task 1–6（`5be7522`/`12afb5e`/`55bf9f6`/`bd2c69d`/`5c8398e`/`f17468d`/`e05237e`）、
> conformance 方做 Task 7（`66df226`）、协调者收尾（R154/R155/R156 三处修复 + 文档 + `scripts/ledger-counts.mjs`）。
>
> **门禁（master `0617152`，全部 `--force`、0 cached）**：`turbo run test lint --force` ✅ **29/29** · `turbo run build --force` ✅ **10/10**；
> `api-gateway` 84→**106** · `shared` 100→**116** · `room-service` 156→**157** · `robot-service` 12→**15** ·
> `game-service` 67 · `user-service` 29 · `protocol` 39 · `client` 142(+2 skipped)。
> conformance：**`slice-07.2-hardening` ✅ 53 项 / 10.6s** · **`slice-07.2-deploy` ✅ 22 项 / 9.8s**（**R98 核心闸门**）·
> `slice-07.2-boundary` ✅ 70 · `slice-07.2-security` ✅ 40 · `slice-07.1` ✅ 28 · `slice-07` ✅ 39 ·
> `slice-06` ✅ 209 · `slice-08` ✅ 55 · `slice-05` ✅ 29（回归全绿）。
>
> **关闭的偏差**：**S4 / S5 / S6 / S7 / A6 + N5 / N6 + N10 / N11**；**§A.3 部署闸门解除**（S1–S8 全 8/8 关闭）；
> **A7 收窄为部分关闭**（网关侧超时 + `10007`/503 + `acquireBot` 的 3s 已完成，剩 `game.client.ts`→`HttpService` 与全链路重试 ⇒ 切片 11）；
> **新增 N12–N15**。另：对账表 **§0 的统计漂移**（C 区实际 27 行、曾写 26）已校正，并新增 `scripts/ledger-counts.mjs` 做机械校验。
>
> **负对照（conformance 方在**未修** master 镜像上逐条取）**：`/`→200+HTML · `robots/move`→500 · `robots/create`→201+`bot-…` ·
> `POST /api/games`→201 · 视图 `body.code===undefined` · 限流超限被拒 **0** 次（20 连发 313ms） · 第 6 条 WS 连接一直连着 ·
> `proxy.gateway.ts` 无超时 · 生产形态 8 个服务全发布端口。
>
> **执行期抓出的七条硬知识**（细节见 `agent-briefs.md` 的「切片 7.2 门禁实测」与「切片 7.2 新增的通用教训」）：
> **R148** Nest 自定义 logger 缺 `setLogLevels` ⇒ 网关启动即崩（接口上可选、运行时不是）·
> **R149** `forRoutes('*')` 被 `setGlobalPrefix('api')` 收窄 ⇒ `/api` 之外的处理器整条绕过验签 ·
> **R150** 源码机械闸的正则要盖住注入式 `fetchImpl(`，且必须自带探针判别力自测 ·
> **R152** socket.io 客户端上「服务端握手后拒绝」= `connect` → `system.error` → `disconnect`（不是 `connect_error`）·
> **R154** `turbo.json` 的 `lint` 缺 `^build` ⇒ 跨包新增导出 + dist 过期 = 假红 ·
> **R155** §5.4 的 5 连接上限撞到我们自己的 `slice-08`（6 条并发 ⇒ 第 6 条被踢、`code=-1`）—— **改用例**而不是放宽限额 ·
> **R156** `run.js` 只设 `exitCode` 不退出 ⇒ 失败泄漏 socket 会把门禁**永久卡住**（实测 693s）。
>
> **下一片 = 切片 9（出牌轮转）**：C5（最后出牌者超时打最小单张）· C16（农民胜利 `every`→`some`）· C18（过牌前置）·
> C19（牌值单一口径）· C20（`lastPlayedHand.length` 单位）· **C6+N2**（错误映射可枚举 + 机械测试）+ 前端选牌/出牌/过牌与倒计时。

> **进度（2026-09-15）—— 切片 9（出牌轮转）已完成并门禁通过**
>
> 计划：`2026-09-15-slice-09-play-rotation.md`（裁决 **R157–R171** + 执行期 **R172–R181**）。三方分工：
> 后端 agent 做 Task 1–5（`4b8974b`/`bab2c26`/`2cff749`/`9e7c85b`/`1b0548a`，合并 `0487543`）、
> 前端 agent 做 Task 6–7（`00f00c5`/`32e7e09`/`db8b698`，合并 `c0469e7`）、
> conformance 方做 Task 8（`e81c84f`/`eee42d4`）+ 协调者收尾（`6f70ab0`/`cb2b208`）。
>
> **门禁（master `cb2b208`，全部 `--force`、0 cached）**：
> `turbo run test lint --force` ✅ **29/29** · `turbo run build --force` ✅ **10/10**；
> `shared` 116→**127** · `game-service` 67→**73** · `client` 142→**154**(+2 skipped) · 其余不回归。
> conformance **10/10**：**`slice-09` ✅ 155 项 / 26.1s（新增）** · `slice-08` ✅ 55 · `slice-07.2-hardening` ✅ 53 ·
> `slice-07.2-deploy` ✅ 22 · `slice-07.2-boundary` ✅ 70 · `slice-07.2-security` ✅ 40 · `slice-07.1` ✅ 28 ·
> `slice-07` ✅ 39 · `slice-06` ✅ 249 · `slice-05` ✅ 29（全回归无碍）。
>
> **关闭的偏差**：**C16 / C18 / C19 / C20 / N2 / N16 / N18**；
> **部分关闭（写清剩下哪一半）**：**C5**（§9.1 ①②③ 最优跟牌 ⇒ 切片 11，与 E4 同改）· **C6**（`HandType.Invalid` 启用 ⇒ 切片 11）·
> **N15**（后端把限额挪到 namespace middleware ⇒ 独立小片 P3）；**新增 N17**（局终不下发 `state='ended'` 视图 ⇒ 切片 10）。
>
> **执行期抓出的三处真问题（都不是「跑绿已有测试」能发现的）**：
> **R172**（计划缺陷）§7 的结束路径不发 `game.state_update` ⇒ 终局手必须等 `game.finished`，否则**在已修的实现上假红 8 秒**；
> **N1 的真实后果** 首次打到对局结束才发现 `game.settlement` **整条被网关出站校验拦掉**
> （`Blocked outbound game.settlement …: ProtocolError: $.payload.baseScore must be a finite number`，网关日志 6 条）
> ⇒ 客户端只收 `game.finished`，`store.settlement` 恒为 `null`（本片**刻意不修**：N1 是切片 10 的头条）；
> **R179**（闸失效模式）机械闸的相对路径在 `.worktrees/<role>` 里**静默扫到主检出的旧源码** ⇒ 闸恒绿；
> 修法是「向上找目录 + 断言扫到本分支独有标记」。
>
> **另一条通用教训（前端执行期实测）**：UI 选中态必须钉在**实例**（下标）而不是**值** —— 按值记录会让
> 「同点数最多选一张」⇒ **对子/三张/炸弹从 UI 永远送不出去**（N18/R173，本片修）。
>
> **下一片 = 切片 10（结算）**：C1（倍数改乘法）· C2（座位语义 `landlordSeat`）· C3（春天/反春）· C26（`baseScore`）·
> **N1**（结算载荷逐字段等于 `SettlementResult`；**并在 `slice-09` 恢复「`game.settlement` 到达」那条断言**）
> + 前端结算页 + **N17**（局终下发 `ended` 视图）+ conformance 分数守恒。

| # | 切片 | 后端 | 前端 | conformance 断言 |
|---|------|------|------|------------------|
| 5 | **断线重连**（提前） | `game.reconnect` + `reconnect:active` 独立键 35s TTL + 30s 窗口 + `13010` | 重连状态机：断线 → `lastVersion` → 收快照 → 恢复渲染 | 断网 10s 后重连，客户端状态与服务端一致 |
| 6 | 登录 + 房间列表 | `refresh`/`logout` 端点 + `session:{jti}` 白名单；`GET /api/rooms → RoomInfo[]` | 登录页、大厅页、Token 持久化与刷新 | 注册 → 登录 → 列表 → 刷新令牌 → 登出 |
| 7 | 匹配 → 进房 | 队列带 `region`、30s 冷启动补机器人、`room.matched`、`match:pending` | 匹配按钮、取消、`room.matched` 后进房 | 3 人入队 → 成局 → 三方都收到 `room.matched` |
| 8 | 叫抢地主 | `grabActions` 按决策次数、上限 8、流局重发、随机地主写 `landlordCandidate`、`13009` | 叫抢 UI（读 `bidPhase.currentBidder`，**不是** `currentPlayer`） | 1 抢 + 2 不抢 → 地主正确、倍数正确 |
| 9 | 出牌轮转 | **修正 C16/C18/C19/C20**（农民胜 `some`、过牌前置、编码双口径、`lastPlayedHand.length`）+ `version+1` | 选牌、出牌、过牌、倒计时（`turnDeadlineAt`） | 一局打到分出胜负，无卡死 |
| 10 | 结算 | **修正 C1/C2/C3**（倍数乘法、座位语义、春天）+ `baseScore` 入 `GameSession` + `SettlementResult` | 结算页（`winner`/`spring`/`multiplier`） | 分数守恒：地主变动 + 两农民变动 = 0 |

**切片 9 的测试连带要求**：必须**同步修改**锁定了错误行为的三个既有用例——`packages/shared/src/ddz/settle.test.ts:35`（断言加法倍数）、`play.test.ts:74-75`、`play.test.ts:107`（断言 `farmers.every`）。**不改测试就等于保留缺陷。**

**切片的纵向交付物**（每片都要有）：契约若有改动 → 两端同一 PR；后端 DoD 命令；前端 DoD 命令；一条 conformance 用例。

---

## Self-Review

**1. Spec coverage**

| v4.1 章节 | 落在哪个任务 |
|---|---|
| §2 架构/端口/环境变量 | Global Constraints 1 + Task 2 |
| §3 数据模型 | Task 0（views.ts）+ Task 2（`baseScore`/`turnDeadlineAt`） |
| §4 服务间通信 | Task 2（TCP RPC + `game.view` 拆分） |
| §5 身份与安全（含 S1–S8） | Task 2 Step 1–2 + 切片 6 |
| §6 WebSocket 协议（含裁剪、幂等、重连） | Task 0 + Task 2 Step 3–5 + 切片 5/9 |
| §7 核心服务规格 | Task 2 + 切片 6/9 |
| §8 匹配系统 | 切片 7 |
| §9 机器人系统 | **未覆盖** ⚠️ 见下 |
| §10 存储设计 | Task 2（对局外置）+ 切片 5/7 |
| §11 错误码 | Task 0（errors.ts） |
| §12 前端约束 | Task 3 硬性约束 + 切片 6–10 |
| §13 测试策略 | Task 4（conformance）+ 各切片 DoD |
| §14 阶段 DoD | 切片 5–10 的 DoD |
| 玩法 §3/§6/§7/§8 | 切片 8/9/10 |

**⚠️ 已知缺口：§9 机器人系统没有切片。** 它依赖 DouZero 服务与双轨 AI，工作量独立于前后端主路径。**建议放最后单独开工**（Task 11），或在本轮之后另立计划。这是有意推迟，不是遗漏——记录在此以免被忘记。

**2. Placeholder scan**：本计划无 TBD/TODO；所有代码步骤给了可执行代码；所有 DoD 给了可直接跑的命令。切片表用的是「文件+判据」粒度而非逐行代码，**这是有意的**：切片的规则细节在 v1.2 玩法规则里已逐条写明，重复一遍会产生第二个真相源。

**3. Type consistency**：`PlayerView` 的字段名在 Task 0 定义、Task 2 生成、Task 3 消费，三处一致；**出站与内部统一使用 `lastPlayerIdx`**（不引入 `lastPlayedIdx` 这类同义异名——字段名漂移是这份规格前两轮的主要缺陷来源之一）；`ErrCode.VERSION_CONFLICT` 在 Task 0 定义、切片 9 使用；`grabActions` 在 views 与切片 8 一致。

---

## 下一步

计划落盘后，两个 agent 的启动说明（scenario brief）由协调者单独提供——它们**不共享本会话的上下文**，所以每份说明必须自带：读哪两份 spec、自己在哪个 worktree、可写哪些目录、本切片是哪几个、DoD 命令、汇报格式。
