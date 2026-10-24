# 挂机治理（超时缩短 + 自动托管 + 手动托管）实现计划 v1.3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 玩家离开/挂机后不再让全场每回合空等 30s——超时后缩短等待、三次自动托管（规则引擎代打）、手动动作/回桌复位、托管按钮可开可关。

**Architecture:** 治理量（`timeoutCount`/`trustee`）存会话；时长策略按**下一行动者**座位态（30s/10s/1.5s）；托管动作复用超时决策链；写路径统一 per-room 串行（含机器人提交）；新独立 RPC 边 `game.trustee`（带 `via`）与 `@MessagePattern` **同提交**落地（J21 纪律）；快照 `trustees[3]` 由 view.builder 生产。

**Tech Stack:** Nest 11 / shared 纯函数 / Redis 会话 / socket.io / uni-app 客户端 / conformance 真栈。

**依据（均已定稿）**：设计 `...2026-10-17-idle-trustee-design.md` **v1.6** · 规格 `...2026-10-17-idle-trustee-spec.md` **定稿**（C1–C39）。

**修订史**：v1.0 → 计划评审 r1「修后再评」（6 阻断 + 8 重要 + 9 次要）→ **v1.1 逐条处置** → **v1.2 自查补漏**（内联全部「同 v1.0」悬空引用）→ **差量复评 r2「修后再评」（2 阻断 + 1 重要 + 4 次要）→ v1.3 处置** → **收口复评 r3「可以定稿」**（四项重点全核实、零新发现）。**状态：定稿。**

## Global Constraints

- **命名钉子**：会话 `timeoutCount`/`trustee`；视图 `PlayerView.trustees: [boolean,boolean,boolean]`；消息 `game.trustee { on }`；RPC `RPC_PATTERNS.gameTrustee='game.trustee'` + `GameTrusteeRequest { roomCode, userId, on, via, meta? }`（via ∈ manual|reconnect|abandon；**仅** manual×{on,off}、reconnect×off、abandon×on；其余 ⇒ 10001 且不落盘）；响应 `RpcResult<{version}>` + **R220 信封 `toResult(..., dto?.meta)`**；ack `{code,data:{version}}`。
- **时长**：生产 30000/10000/1500/after3；env 读取逐字 **`Number(process.env.X) || 默认`**；conformance 注入 **1500/1000/400/3**；仅测试 env **不进 design.md §2.3**。
- **错误码**：Init⇒13009（仅单测可造）/Ended⇒13005/无会话⇒12001/无恢复房⇒12004/坏载荷⇒10001；**异常类 = `GameError`（`game.errors.ts`，`toResult` 靠其 `code` 保真，⛔ 不自造类）**。
- **复位只写 applyAction 人类动作成功路径**，且作用于 **`updated`（handler 返回的新会话）**、**在 finishTransition 之前**（⚠️ r1 阻断 5：`handlePlayCards`/`finalizeBidding` 返回新 players 数组，写 `session.players` 会静默丢复位）。
- **期限一律按「下一行动者」档写**：所有 `turnDeadlineAt` 写入点（`:254/:431/:722/:786` 一带）统一走一个 helper（⚠️ r1 阻断 3）。
- **机器人判定用 `session.botIds`**（生产 `isBot` 恒 false——⚠️ r1 阻断 4）；机器人座位不计数/不托管/trustees 恒 false。
- **R10 串行**：awaited per-room 队列覆盖四写者；**timer 回调不再包队列**（复核与执行都在 `onTurnTimeout` 的锁内——⚠️ r1 重要 9：再包一层 = 自锁停摆）。
- **纪律**：TDD；每跑独立日志文件名；「跑了/绿了」指向本次日志；假红先单跑；提交末尾带 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: shared 治理纯函数 + 会话/玩家类型

**Files:**
- Modify: `packages/shared/src/ddz/types.ts`（`GamePlayer` 两字段）
- Modify: `packages/shared/src/ddz/game.ts`（**`createSession` 的玩家字面量初始化两字段**——⚠️ r1 阻断 2）
- Create: `packages/shared/src/ddz/governance.ts`
- Modify: `packages/shared/src/index.ts`（export）
- Test: `packages/shared/src/ddz/governance.test.ts`、`types.test.ts`、`features.test.ts:28-35`（字面量连带）

**Interfaces:**
- Produces: `GovernanceDurations`；`turnDurationFor(seat,d)`；`onTimeoutOccurred(seat,d)`；`onTurnConsumed(seat)`；`onTrusteeOff(seat)`；`isLegalTrusteeCombo(via,on)`。

- [ ] **Step 1: 写失败测试（失败态）**——`governance.test.ts`（⚠️ r1 次要 16：import 行含 `isLegalTrusteeCombo`，⛔ 不用 `@ts-expect-error`）：
```ts
import { describe, expect, it } from 'vitest';
import {
  isLegalTrusteeCombo,
  onTimeoutOccurred,
  onTrusteeOff,
  onTurnConsumed,
  turnDurationFor,
} from './governance';

const D = { normal: 30_000, accel: 10_000, trustee: 1_500, after: 3 };
const seat = (timeoutCount: number, trustee = false) => ({ timeoutCount, trustee });

describe('挂机治理纯函数', () => {
  it('C10：时长按治理态分档', () => {
    expect(turnDurationFor(seat(0), D)).toBe(30_000);
    expect(turnDurationFor(seat(1), D)).toBe(10_000);
    expect(turnDurationFor(seat(3, true), D)).toBe(1_500);
  });
  it('C1：超时 +1；count ≥ after ⇒ trustee（用 ≥）', () => {
    expect(onTimeoutOccurred(seat(0), D)).toMatchObject({ timeoutCount: 1, trustee: false });
    expect(onTimeoutOccurred(seat(2), D)).toMatchObject({ timeoutCount: 3, trustee: true });
    expect(onTimeoutOccurred(seat(5, true), D).trustee).toBe(true);
  });
  it('C3：回合消耗型动作 ⇒ 清零复位', () => {
    expect(onTurnConsumed(seat(3, true))).toMatchObject({ timeoutCount: 0, trustee: false });
  });
  it('C4：off/重连 ⇒ 只清 trustee、count 不动', () => {
    expect(onTrusteeOff(seat(3, true))).toMatchObject({ timeoutCount: 3, trustee: false });
  });
  it('C7b：via×on 合法组合集', () => {
    expect(isLegalTrusteeCombo('manual', true)).toBe(true);
    expect(isLegalTrusteeCombo('manual', false)).toBe(true);
    expect(isLegalTrusteeCombo('reconnect', false)).toBe(true);
    expect(isLegalTrusteeCombo('reconnect', true)).toBe(false);
    expect(isLegalTrusteeCombo('abandon', true)).toBe(true);
    expect(isLegalTrusteeCombo('abandon', false)).toBe(false);
  });
});
```
`types.test.ts` 与 `features.test.ts` 的 `GamePlayer` 字面量补两字段。

- [ ] **Step 2: 跑确认失败**：`pnpm --filter @fight-the-landlord/shared exec vitest run src/ddz/governance.test.ts src/ddz/types.test.ts src/ddz/features.test.ts`
- [ ] **Step 3: 实现**——`types.ts` 的 `GamePlayer` 加 `timeoutCount: number;` / `trustee: boolean;`；**`game.ts` 的 `createSession` 玩家字面量加 `timeoutCount: 0, trustee: false`**；`governance.ts`：
```ts
export interface GovernanceDurations { normal: number; accel: number; trustee: number; after: number }
export interface SeatGovernance { timeoutCount: number; trustee: boolean }

export function turnDurationFor(seat: SeatGovernance, d: GovernanceDurations): number {
  if (seat.trustee) return d.trustee;
  if (seat.timeoutCount > 0) return d.accel;
  return d.normal;
}

export function onTimeoutOccurred(seat: SeatGovernance, d: GovernanceDurations): SeatGovernance {
  const next = seat.timeoutCount + 1;
  return { timeoutCount: next, trustee: seat.trustee || next >= d.after };
}

export function onTurnConsumed(_seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: 0, trustee: false };
}

export function onTrusteeOff(seat: SeatGovernance): SeatGovernance {
  return { timeoutCount: seat.timeoutCount, trustee: false };
}

/** C7b：仅 manual×{on,off} / reconnect×off / abandon×on 合法。 */
export function isLegalTrusteeCombo(via: 'manual' | 'reconnect' | 'abandon', on: boolean): boolean {
  if (via === 'manual') return true;
  if (via === 'reconnect') return on === false;
  return on === true;
}
```
`index.ts` 加 `export * from './ddz/governance';`。
- [ ] **Step 4: 跑至绿 + lint** → **Step 5: Commit**
```bash
git add packages/shared && git commit -m "feat(shared): 治理纯函数 + GamePlayer 两字段（含 createSession 初始化）"
```

---

### Task 2: protocol 视图/校验/消息 + client-protocol 文档（同批）

**Files:**
- Modify: `packages/protocol/src/views.ts`（`PlayerView.trustees`）
- Modify: `packages/protocol/src/validate.ts`（`assertPlayerView` + `game.trustee` case）
- Modify: `packages/protocol/src/messages.ts`（`CLIENT_MESSAGE_TYPES` +1、**`ClientMessage` 联合成员**——⚠️ r1 次要 21）
- Modify: `docs/client-protocol.md`（消息表 + trustees——⚠️ r1 重要 12：`apps/client/test/protocol-doc-sync.test.ts:70-101` 要求表格行 == 消息集合，**必须同批**，否则 T7 必红）
- Test: `messages.test.ts:15/:37/:55-76`（`:56` 为 pattern 全对象断言本体）、`robot.test.ts:17`、`rpc.test.ts:27`（`view()` 夹具）

**Interfaces:**
- Produces: `PlayerView.trustees`；`game.trustee` 消息条目与校验。
- 注：**`RPC_PATTERNS.gameTrustee` 与请求类型移入 T4**（J21 键↔接收侧同提交——⚠️ r1 阻断 6）。**`GAME_CLIENT_TIMEOUT_MS` 属 room-service，移入 T6**（⚠️ r1 次要 15）。

- [ ] **Step 1: 写失败测试**：消息数 `:37` 10→11；**`:56` 的 `expect(RPC_PATTERNS).toEqual({...})` 留给 T4**（与 pattern 同提交，加 `gameTrustee: 'game.trustee'` 键——⚠️ r2 阻断 2：T2 动它必红）；`view()` 与 robot 夹具补 `trustees:[false,false,false]`；新增 validate 用例（`on` 非严格 boolean ⇒ 10001；`trustees` 非三元/非 boolean ⇒ 抛）。
- [ ] **Step 2: 跑确认失败** → **Step 3: 实现**——① `views.ts` 的 `PlayerView` 加：
```ts
  /** 按座位的托管态（徽标数据面；与 cardCounts 同族）。 */
  trustees: [boolean, boolean, boolean];
```
② `validate.ts`：`assertPlayerView` 加「`trustees` 恰三元且全 boolean」（照 `cardCounts` 同款断言形态）；`validateClientMessage` 穷尽 switch 加 `case 'game.trustee'`：`payload.on` 必须 `typeof === 'boolean'`，否则 `ProtocolError(10001)`。
③ `messages.ts`：`CLIENT_MESSAGE_TYPES` 置尾加 `'game.trustee'`；`ClientMessage` 联合加 `{ type: 'game.trustee'; payload: { on: boolean }; meta: RequestMeta }`（⚠️ r2 重要 3：类型名是 **`RequestMeta`**（`messages.ts:25`），`ClientMessageMeta` 不存在）。
④ `docs/client-protocol.md`：消息表加 `game.trustee` 行 + 视图字段段加 `trustees`。
- [ ] **Step 4: 跑至绿 + lint + `protocol-doc-sync` 单跑** → **Step 5: Commit**
```bash
git add packages/protocol docs/client-protocol.md && git commit -m "feat(protocol): PlayerView.trustees + game.trustee 消息/校验 + client-protocol 同批"
```

---

### Task 3: game-service 治理核心 + 视图生产

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`
- Modify: `packages/game-service/src/game/view.builder.ts`（**生产 `trustees`**——⚠️ r1 阻断 1）
- Test: `packages/game-service/test/governance.test.ts`（新）、`view.builder.test.ts`（GamePlayer 字面量连带）、**`game.controller.test.ts:143-158`（`Object.keys(view).sort()` 14 键穷尽断言——⚠️ r2 次要 4 点名）**

**Interfaces:**
- Consumes: T1 纯函数。
- Produces: `durations()`（唯一 env 点）；`deadlineFor(sessionAfterTransition)`（**按下一行动者档**）；`startTurnTimer(roomCode, session, opts?: { forceNormal?: boolean; overrideMs?: number })`；`governanceOf(player)`（安全缺省）；view.builder `trustees`。

- [ ] **Step 1: 先读交界并报告**：`startTurnTimer`（:552 一带）与 `driveRobotTurn`/`commitRobotDecision` 的 timer 关系；`applyAction` 的两条人类入口（`actAndView`→`applyById` 与 REST→`bid/playCards/pass`）是否都过它；**机器人判定用 `session.botIds`（:249/:625）**；`currentBidder === -1` 的防御形态（loadSession 注释）。
- [ ] **Step 2: 写失败测试**（fake timers；表驱动）：C10 三档；C1/C2；C2b（**两处 catch** `:427` 与 `:793` 都断言重挂 normal）；C3（出牌/定地主两条新数组路径都验复位——**断言在 updated 上生效**）+ 负对照（超时自动动作不复位）；**C6（非行动者动作不改治理量）**；C5（`botIds` 座位不计数/不托管）；C10b（机器人行动后 deadline 按下一行动者档）；C6b（旧会话缺字段）；
  **view 生产**：`buildPlayerView` 输出含 `trustees` 三元（含 bot 恒 false）且过 `assertPlayerView`。
- [ ] **Step 3: 跑确认失败** → **Step 4: 实现**：
```ts
/** 唯一 env 读取点（`||` 非 `??`）。 */
private durations(): GovernanceDurations {
  return {
    normal: Number(process.env.GAME_TURN_TIMEOUT_MS) || 30_000,
    accel: Number(process.env.GAME_TURN_TIMEOUT_ACCEL_MS) || 10_000,
    trustee: Number(process.env.GAME_TRUSTEE_DELAY_MS) || 1_500,
    after: Number(process.env.GAME_TRUSTEE_AFTER) || 3,
  };
}

/**
 * 机器人判定（⚠️ r2 阻断 1 勘正）：`botIds` 是**按座位的内部 botId 数组**（可选字段），
 * `GamePlayer.id` 是对外 displayId（`p_…`）——两者**恒不相等**，⛔ 不可用 `includes(p.id)`。
 * 正确谓词与现存代码（`:625` 一带）同款：该座位有 botId ⇒ 机器人。
 */
private isBotSeat(session: GameSession, seatIdx: number): boolean {
  return session.botIds?.[seatIdx] !== undefined;
}

/** 所有 deadline 写入点统一走它（按**下一行动者**档；机器人/缺位 ⇒ normal）。 */
private deadlineFor(session: GameSession): number {
  const idx = session.state === GameState.Bidding ? session.bidPhase.currentBidder : session.currentPlayer;
  const d = this.durations();
  const p = idx >= 0 ? session.players[idx] : undefined;
  const ms = p === undefined || this.isBotSeat(session, idx) ? d.normal : turnDurationFor(p, d);
  return Date.now() + ms;
}
```
`startTurnTimer` 增 `opts`，**时长优先级逐字写死**（⚠️ r2 次要 5）：`const ms = opts.overrideMs ?? (opts.forceNormal ? d.normal : this.deadlineFor(session) - Date.now());`——`overrideMs`（R8① min）> `forceNormal`（R106）> 默认（按下一行动者档派生）；时长计算用 `deadlineFor` 同源；**四处 deadline 写入点全部改走 `deadlineFor(updated)`**（⚠️ r1 阻断 3：`:254/:431/:722/:786` 一带，含机器人提交后的 `:722`）；`onTurnTimeout` 成功分支：`const g = this.isBotSeat(...) ? 跳过 : onTimeoutOccurred(...)` 作用于 **updated**；`applyAction` 人类路径：`updated.players[idx] = { ...updated.players[idx], ...onTurnConsumed(...) }` **在 finishTransition 之前**（⚠️ r1 阻断 5）；两处 catch 重挂 `startTurnTimer(roomCode, session, { forceNormal: true })`；`loadSession` 缺省；`governanceOf(p)` = `{ timeoutCount: p?.timeoutCount ?? 0, trustee: p?.trustee ?? false }`（⚠️ r1 次要 17：缺位不抛）。
**view.builder**：`buildPlayerView` 产出（⚠️ r2 阻断 1：按**座位下标**查 botIds，⛔ 不按 id 比）：
```ts
const trustees = session.players.map((p, i) =>
  session.botIds?.[i] !== undefined ? false : p.trustee === true,
) as [boolean, boolean, boolean];
```
并过 `assertPlayerView`。
- [ ] **Step 5: 跑至绿 + lint + 全包回归** → **Step 6: Commit**
```bash
git add packages/game-service && git commit -m "feat(game): 治理核心（下一行动者档/计数/复位 updated/R106 normal/迁移）+ view 生产 trustees"
```

---

### Task 4: `game.trustee` 边（pattern+handler 同提交）+ R8/R6

**Files:**
- Modify: `packages/protocol/src/rpc.ts`（`gameTrustee` pattern + `GameTrusteeRequest`——**与 handler 同提交**，J21）
- Modify: `packages/game-service/src/rpc/game.rpc.controller.ts`（`@MessagePattern`）
- Modify: `packages/game-service/src/game/game.service.ts`（`applyTrustee` + `startTurnTimer` 的 `rescheduleTurn` 辅助）
- Test: `packages/game-service/test/trustee.test.ts`（新）、`packages/protocol/src/messages.test.ts:56`（pattern 全对象断言 +1——与 pattern 同批）、`robot-availability-wiring.gate.test.ts` 复跑

**Interfaces:**
- Consumes: T1 `isLegalTrusteeCombo`；T2 视图；T3 `durations`/`deadlineFor`。
- Produces: `applyTrustee(dto): Promise<{version:number}>`。

- [ ] **Step 1: 写失败测试**（表驱动，同 v1.0 + C7b/C8/C9/C11–C14/C4）→ **Step 2: 确认失败** → **Step 3: 实现**：
```ts
// game.rpc.controller.ts（⚠️ r1 重要 7：this.gameService；GameError；组合校验传两参）
@MessagePattern(RPC_PATTERNS.gameTrustee)
async trustee(@Payload() dto: GameTrusteeRequest): Promise<RpcResult<{ version: number }>> {
  return toResult(() => this.gameService.applyTrustee(dto), dto?.meta);
}
```
```ts
// game.service.ts
async applyTrustee(dto: GameTrusteeRequest): Promise<{ version: number }> {
  if (!isLegalTrusteeCombo(dto.via, dto.on)) throw new GameError(ErrCode.BAD_PARAM, '非法 trustee 组合');
  const session = await this.getSession(dto.roomCode);
  if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, '房间不存在');
  if (session.state === GameState.Init) throw new GameError(ErrCode.GAME_NOT_STARTED, '对局未开始');
  if (session.state === GameState.Ended) throw new GameError(ErrCode.GAME_OVER, '对局已结束');
  const idx = session.players.findIndex((p) => p.id === dto.userId);
  if (idx < 0) throw new GameError(ErrCode.NOT_IN_ROOM, '不在该房');
  if (this.isBotSeat(session, idx)) throw new GameError(ErrCode.BAD_PARAM, '机器人座位无治理量');
  if (session.players[idx].trustee === dto.on) return { version: session.version }; // 守卫后 no-op
  // 轻量转移：读入锁（T5 提供 runSerialized 后包入）→ 改 trustee（off 用 onTrusteeOff：count 不动）
  // → R8 分支（当前行动者是本人时）：
  //   ① on=true：rescheduleTurn(roomCode, updated, min(max(剩余,0), trusteeMs))（写 deadline 后 publish）
  //   ② on=false && via==='manual'：不重排不重算
  //   ③ on=false && via==='reconnect' 且原 true 且本人行动者：rescheduleTurn(…, count>0?accel:normal)
  //   ④ 非行动者：不动 timer/deadline
  // → version+1 → saveSession → publishSeatViews。
}
```
`rescheduleTurn(roomCode, session, ms)`：`session.turnDeadlineAt = Date.now() + ms; this.startTurnTimer(roomCode, session, { overrideMs: ms });` **先改 deadline 再 publish**（publish 由调用方在 save 后统一做）。
- [ ] **Step 4: 跑至绿 + J21 闸复跑 + lint** → **Step 5: Commit**
```bash
git add packages/protocol packages/game-service && git commit -m "feat(game): game.trustee 边（pattern+handler 同提交）+ R8 三分支 + R6 例外"
```

---

### Task 5: R10 同房写串行 + 机器人互锁 + timer 回合身份复核

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts`
- Test: `packages/game-service/test/concurrency.test.ts`（新）

- [ ] **Step 1: 写失败测试**：C16/C17/C18/C15（同 v1.0 清单）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**：
```ts
/** R10：同房 awaited 串行队列（⛔ 不照 robotDriving 的 drop-on-reentry）。Ended 清理条目。 */
private runSerialized<T>(roomCode: string, fn: () => Promise<T>): Promise<T> {
  const prev = this.roomQueues.get(roomCode) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  this.roomQueues.set(roomCode, next.then(() => undefined, () => undefined));
  return next;
}
```
四写者（applyAction / onTurnTimeout / applyTrustee / commitRobotDecision）入口包队列；**timer 回调只捕获 `{actorSeat, deadlineAt}` 并直接调 `this.onTurnTimeout(roomCode, expected)`**——⚠️ r2 次要 6 补签名：`onTurnTimeout(roomCode: string, expected?: { actorSeat: number; deadlineAt: number })`，锁内复核 `state∈{Init,Ended}` 或 `session.currentBidder/currentPlayer`/`turnDeadlineAt` 与 `expected` 不符 ⇒ 放弃；⛔ 回调不另包 runSerialized（⚠️ r1 重要 9：双层排队 = 自锁停摆）；`commitRobotDecision` 锁内 state/actor 复验 + rebase + 打断则返回 true 重驱。
- [ ] **Step 4: 跑至绿 + 全包回归 + lint** → **Step 5: Commit**
```bash
git add packages/game-service && git commit -m "feat(game): R10 串行四写者 + 机器人互锁重驱 + timer 回合身份复核（回调不入队）"
```

---

### Task 6: room-service（边调用/三转发/新 case/接线闸）

**Files:**
- Modify: `packages/room-service/src/gateway/game.client.ts`（`trustee()` + **`GAME_CLIENT_TIMEOUT_MS.trustee=2000`（此文件 `:38`——⚠️ r1 次要 15）**）
- Modify: `packages/room-service/src/gateway/message.router.ts`（case + 三转发）
- Modify: `packages/room-service/src/gateway/ws.gateway.ts`（`@SubscribeMessage`）
- Test: `idle-trustee.router.test.ts`（新）、接线闸新文件、`ws.gateway.test.ts:1018/:1328`、`game.client.test.ts:133`

- [ ] **Step 1: 写失败测试**（C19 四处 via / C20 / C20b / C21 / C22 / C26 两条腿 + 正负对照）。C21 补 **`target == payload roomCode` 支**；**在局 `room.join` 判别门**（⚠️ r1 次要 18）；C22 的清后 ack：**清除成功后重新取 view（或就地改写 `trustees[idx]=false`）再 ack**（⚠️ r1 重要 19）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（router 五步序同 v1.0 + 上述补丁；`ws.gateway.ts` 装饰器；接线闸两腿利用 `message.router.test.ts` 的 deps 工厂——**先把该工厂导出**）。
- [ ] **Step 4: 跑至绿 + lint + 全包回归** → **Step 5: Commit**
```bash
git add packages/room-service && git commit -m "feat(room): game.trustee 通道（三转发/五步序/接线两腿）+ 客户端超时表"
```

---

### Task 7: 客户端（按钮/徽标/发送面）

**Files:**
- Modify: `apps/client/src/components/MoreMenu.vue`、`apps/client/src/pages/table/*`（徽标 + **`table.vue:536-537` 的本地 `send()` 联合扩 `'game.trustee'`**——⚠️ r1 次要 20）
- Modify: 夹具 `fake-socket.ts:195`、`tools/mock-server/src/scripted-game.ts:204`（+ `index.ts:255/:265-274`——本轮一并补，⚠️ r1 重要 10）
- Test: `more-menu.test.ts`、徽标测试（新）、`browser-e2e.mjs` 注入视图防御（C28）

- [ ] **Step 1: 写失败测试**（C27/C28/C29 + 文案「托管中」常量）→ **Step 2: 确认失败** → **Step 3: 实现**（防御读 `trustees?.[i] ?? false`）→ **Step 4: 跑至绿 + client lint** → **Step 5: Commit**
```bash
git add apps/client tools/mock-server && git commit -m "feat(client): 托管按钮/徽标 + 发送面扩型 + 夹具"
```

---

### Task 8: conformance（slice-27，**3 真人驱动、无机器人**）

**Files:**
- Create: `tools/conformance/src/slices/slice-27-idle-trustee.ts`
- Modify: `tools/conformance/src/run.ts`、`tools/conformance/baselines.json`（**仅 full 列**）
- Modify: `docker-compose.yml`（game-service 块四个 `${VAR:-}`）

- [ ] **Step 1: 写片**。头注释照 slice-26 体例（临时注入 ⇒ **finally 还原**、RUN_TAG/AID 纪律、读数维度）。⚠️ r1 重要 13：**驱动方 = registerUser 造 3 个真人，⛔ 不用补位机器人**（注入 normal=1500 与机器人 beginner 思考 1500 打平会抖动）。六组：
```
⓪ 前置：注入四 env 重建 game-service → 健康 → 两键基线读
A 加速两档：一真人不动 ⇒ 首回合超时（wait normal=1500）→ 下一回合 deadline 差 ≈ accel=1000
B 自动托管：第三次超时后 ⇒ trustees[seat]=true（快照实读）且后续回合 ≤ trustee=400 自动动作
C 复位（accel 档）：via manual 解除 → 该玩家在其回合（1000ms）内手动动作 ⇒ count 归零（redis 实读）
D R8/R6 格：R8① deadline 收缩 min；R8② manual off 不重排；R8③ 非行动者不动（快照差分）；
  C14 回桌按 count 基线重排
E 弃局→回桌：真实 leave（确认弃局）⇒ trustees 置位；room.join 回桌 ⇒ 解除 + 可继续动作
F 回调复核：非行动者 toggle 后定时到点 ⇒ 仍自动动作
收尾：finally 还原 env + 重建回默认 + 健康探针 + 治理态复验
```
- [ ] **Step 2: 注册 + baselines 仅 full** → **Step 3: 前置重建（本分支源码）+ 两跑一致** → **Step 4: Commit**
```bash
git add tools/conformance docker-compose.yml && git commit -m "test(conformance): slice-27-idle-trustee（真实人驱动 + 注入/还原）+ compose env"
```

---

### Task 9: 文档 + 全量门禁 + 收口

**Files:**
- Modify: `docs/design.md`（`:309/:348/:814/:1517/:633`、§4.2/§4.3/§6.3/§6.4、§9；⚠️ `:814` **两处计数**：消息条数与 `@SubscribeMessage` 个数（现 10、本片后 11）——⚠️ r1 次要 22）
- Modify: `docs/games/doudizhu.md`（7 处 + 新增小节）

- [ ] **Step 1: 文档两件**（C30/C31 逐点；`:633` pattern 计数本片后 = 20）。
- [ ] **Step 2: 全量门禁（⚠️ r1 重要 11 补全）**：**七个包**（shared/protocol/game-service/room-service/client/robot-service/tools-mock-server 的 lint）+ 静态闸 + slice-27 两跑 + 受影响既有片（05/11 必跑）；**既有全序一次**（C39 的执行载体；18/24 相位红按预登记）。
- [ ] **Step 3: 收口 grep**：`30_000|30000|30 000` 活面表述。
- [ ] **Step 4: Commit**（文档批）。
- [ ] **Step 5: 部署**（⚠️ 控制器执行、用户发话）：`deploy-dev.sh` + 钉 IP + 容器实读 + 测试服残行核查。

---

## Self-Review 记录（v1.1 更新）

- **规格覆盖**：C1–C6b→T1/T3 · C7/C7b–C9→T4 · C10–C14→T3/T4 · C15–C18→T5 · C19–C22→T6 · C23–C25→T2/T6/T7/T9 · C26→T6 · C27–C29→T7 · C30–C33→T9/T2 · C34–C37→T8 · C38–C39→T9/人工。无缺口。
- **已知取舍**：机器人档 = normal 且不参与治理（botIds 判定）；conformance 不测真实 30s；部署待用户发话。
- **r1 处置对照**：阻断 1→T3 view.builder；2→T1 game.ts；3→T3 deadlineFor 四处；4→T3 isBotSeat(botIds)+计数守卫；5→T3 updated 复位；6→T4 pattern/handler 同提交。重要 7→T4 代码勘正；8→startTurnTimer opts.overrideMs；9→T5 回调不入队；10→T3/T7/T9 夹具清单；11→T9 七包+全序；12→T2 文档同批；13→T8 三真人；14→governanceOf/代码骨架/R106 两 catch。次要 15–23→各任务内 ⚠️ 标注。
