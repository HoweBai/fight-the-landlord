# 机器人拟人化思考时间（1–3s）设计

> **状态**：已实现；J10（conformance slice-11 真栈）已于 2026-10-17 在重建镜像上通过（64 项断言，用时 76s）。
> **日期**：2026-10-17。
> **来源**：用户需求「让机器人做得尽量像人一点，出牌时有一定的思考时间 1–3 秒」+ 本轮 4 条裁决（延迟模型、难度关系、抖动幅度、叫抢阶段）+ 设计审查修订。
> **关系**：本文**只**改思考延迟；`skillLevel` → 决策模型的映射（片② D2）不变；`2026-10-01-ai-rollout-design.md` 的 `thinkingSpeed` 区间与「每新绑定重抽」语义保持，仅把区间从按难度三档改为统一 1–3s。

---

## 1. 目标与非目标

### 1.1 目标

1. 每个机器人在**建池/新绑定**时抽一个稳定的「基础手速」`base ∈ [1000, 3000) ms`，作为 `personality.thinkingSpeed` 持久化。
2. 每次行动（**叫抢 + 出牌**）的实际延迟 = `clamp(base ± 300ms, 1000, 3000)`，即同一局内该机器人快慢稳定、每手有自然抖动。
3. 延迟**不顺延** `turnDeadlineAt`（沿用 §9.4）。最坏 3s + `robot.decide` 5s = **8s ≪ 30s** 回合时限。
4. 难度（`beginner` / `intermediate` / `advanced`）**不再影响**思考速度；难度只决定决策模型。

### 1.2 非目标

- 不做「按情境动态变化」（跟牌快、拆牌慢）—— 用户明确选择固定性格 + 抖动。
- 不做偶发「走神/长考」—— 严格保证单次延迟 ≤ 3s。
- **不**把基础手速做成跨对局稳定：现有 `acquire` 在每次**新绑定**时重抽 `skillLevel` 与 `thinkingSpeed`（片② D2/J5b），本片保持该语义。同一局内稳定即可。
- 不把 1–3s 区间做成配置中心键；先作为代码常量。
- 不改 `robot.decide` 的 5s 超时与 30s 回合时限。

---

## 2. 现状（事实核查）

| 事实 | 位置 |
| --- | --- |
| `thinkingSpeed` 按难度三档采样：beginner 800–1500 / intermediate 500–1000 / advanced 300–800 | `robot-service/src/robot/robot.pool.ts:35-40` |
| `acquire` 新绑定分支：难度与手速一起抽；幂等命中原样返回不重抽 | `robot-service/src/robot/robot.pool.ts:132-155`（重抽在 `:141-145`） |
| `game.start` 的 `players[]` 目前只带 `botId` + `skillLevel`，**不带** `thinkingSpeed` | `protocol/src/rpc.ts:197-214`、`game-service/src/game/dto.ts:10-21` |
| room-service 的 `BotBinding` 只存 seat/botId/skillLevel/displayId，丢弃 `personality` | `room-service/src/rooms/rooms.bots.ts:13-18`、`rooms.start.ts:262-267` |
| `buildStartPlayers` 组装 `game.start` 载荷 | `room-service/src/rooms/rooms.start.ts:558-574` |
| game-service 实际延迟 = 按难度硬编码上界 1500/1000/800，**不读**持久化的 `thinkingSpeed` | `game-service/src/game/game.service.ts:645-651`、`:798-803` |
| 思考延迟注入缝 `robotDelay` 已存在（测试可注入 0 延迟） | `game-service/src/game/game.service.ts:96-107` |
| `random` 注入缝被精确计数断言（4 个调用点） | `game-service/test/game.service.random.test.ts:106-133` |
| 出站禁止字段闸 | `protocol/src/validate.ts:37-43` |
| conformance slice-11 用 5s 窗口判「机器人自驱」，整局 150s 上限 | `tools/conformance/src/slices/slice-11-robot-system.ts:104-113` |

---

## 3. 裁决（D）

### D1：基础手速区间与采样（robot-service）

- 删除按难度的 `THINKING_SPEED: Record<SkillLevel, [number, number]>`，改为**单一区间常量**：

  ```ts
  /** 拟人化基础手速区间（ms），与难度无关。 */
  export const THINKING_SPEED_RANGE: readonly [number, number] = [1000, 3000];
  ```

- `roll()` 改为两件独立的事：

  ```ts
  const skillLevel = this.pickSkillLevel();
  const [min, max] = THINKING_SPEED_RANGE;
  const thinkingSpeed = Math.floor(this.random() * (max - min)) + min; // [1000, 3000)
  return { skillLevel, thinkingSpeed };
  ```

- **随机数消费数不变**：每个新绑定恰好 2 次（难度 + 手速）；幂等命中 0 次。J5b/J5c 判据继续成立。
- `BotPersonality.thinkingSpeed` 的注释改为：**基础手速**（1–3s），每回合实际延迟 = 基础值 ± 300ms 抖动。

### D2：载荷透传（room-service → game-service）

- `BotBinding` 增加 `thinkingSpeed: number`；`fillBots` 从 `bot.personality.thinkingSpeed` 填入。
- `buildStartPlayers` 对机器人座位输出 `thinkingSpeed`。
- `StartGameRequest.players[]`（**两份定义同步改**）增加可选内部字段：

  ```ts
  /** 服务端内部字段：机器人基础手速（ms）。永不下发客户端。 */
  thinkingSpeed?: number;
  ```

  落点：`protocol/src/rpc.ts:197-214` 与 `game-service/src/game/dto.ts:10-21`。
- 该字段**不**写入 `room:{code}:bots` Hash（该表只存 seat→botId）；它随 `acquire` 返回的 `BotInstance` 在内存中直达 `game.start`，服务重启后由幂等 `acquire` 重新取回同一个 `BotInstance`。

### D3：会话存储（game-service）

`GameSession` 增加内部字段，与 `botSkillLevels` 同构：

```ts
/** 机器人基础手速（ms），按座位索引；人类玩家为 undefined。永不出站。 */
botThinkingSpeeds?: Array<number | undefined>;
```

- `startGame` 从 `players[].thinkingSpeed` 填充。
- **可选**：部署窗口内升级前创建的旧会话没有该键 ⇒ 使用默认值（见 D4），不得崩。

### D4：延迟计算（game-service）

```ts
const DEFAULT_THINKING_SPEED = 2000;   // 旧会话/缺字段兜底（区间中点）
const THINKING_JITTER_MS = 300;
const THINKING_MIN_MS = 1000;
const THINKING_MAX_MS = 3000;

const base = session.botThinkingSpeeds?.[seat] ?? DEFAULT_THINKING_SPEED;
const jitter = (this.robotJitterRandom() * 2 - 1) * THINKING_JITTER_MS; // [-300, +300)
const delay = Math.min(
  THINKING_MAX_MS,
  Math.max(THINKING_MIN_MS, Math.round(base + jitter)),
);
await this.robotDelay(delay);
```

- 新增**独立**注入缝：`robotJitterRandom: () => number = Math.random`。
  **不得复用** `this.random` —— `game.service.random.test.ts` 断言了 `random` 的精确消费次数。
- `robotDelay` 注入缝保持不变；默认仍为 `setTimeout`。
- 删除 `thinkingSpeedOf(skillLevel)`。
- 延迟位置不变：仍在 `driveOneRobotTurn` 里、`robot.decide` **之前**；叫抢与出牌共用同一路径。
- 延迟**仍不修改** `turnDeadlineAt`。

### D5：兼容与旧数据

- 空闲池中的老机器人：下次被 `acquire`（新绑定）时会按新区间重抽，无需迁移脚本。
- 部署窗口内**已绑定**的老机器人：`thinkingSpeed` 可能是旧的 300–1500，消费时被 D4 的 clamp 收敛到 `[1000, 3000]`，不会慢于 1s，也不会超过 3s。
- **不**在 `acquire` 的幂等命中分支重抽/改写越界值（否则破坏 R201 幂等与 J5c 的 Δ=0 判据）。
- **滚动部署窗口**：若 room-service 仍是旧版本（不发送 `thinkingSpeed`），新 game-service 会给该窗口内的所有机器人统一 `2000 ± 300ms`，暂时忽略池里的基础手速。这是**安全的降级**，窗口结束后自动恢复；不为此增加兼容代码。

### D6：出站泄漏闸

把 `thinkingSpeed` 加入 `FORBIDDEN_OUTBOUND_KEYS`（`protocol/src/validate.ts:37-43`），与 `skillLevel` 同级。它现在会出现在 `game.start` 的内部载荷与会话里，必须机械保证永不下发客户端。

### D7：conformance 时序窗口调整

`DRIVE_WINDOW_MS` 从 **5s → 15s**（`slice-11-robot-system.ts:106`）。理由：

- 旧：固定 1.5s 延迟，5s 窗口有富余。
- 新：最坏 3s 延迟 + `robot.decide` 5s 超时 = 8s，还要叠加落盘/pubsub/WS 投递；10s 只有 2s 余量，CI 负载下会 flaky。
- 15s 仍 **≪ 30s**，判据「机器人是自驱、不是 30s 超时兜底」的判别力不变。

`GAME_DEADLINE_MS` 从 **150s → 300s**（`:113`）。定量依据修正：旧实现的平均延迟不是 1.5s，而是按默认难度分布 `0.15/0.35/0.5` 对 1500/1000/800 加权 ⇒ **约 975ms**；新实现平均 **约 2s**，约为旧值的 **2 倍**（不是 +33%）。按整局 60–78 次动作估算，150s 余量不足，取 300s。

`tools/conformance/src/lib/ddz-driver.ts:665` 的 `FULL_GAME_DEADLINE_MS`（slice-18/25 的完整对局上界）同样从 **180s → 300s**；它是机制上界，不是判据。

其余硬编码窗口（`MATCH_WINDOW_MS = 50s`、`MECHANICS_TURN_MS = 40s`、`ROBOT_TURN_WAIT_MS = 40s`）均大于单回合最坏 8s，不需调整。

### D8：文档同步

- `docs/design.md:1483-1487`：`thinkingSpeed` 列由按难度三档改为统一 **1000–3000**，并注明与难度无关。
- `docs/design.md:1515`：最坏耗时 6.5s → **8s**。
- `docs/2026-08-31-game-platform-architecture-design.md:2799-2819` 的 `ThinkingDelay` 模型（jitter 0–500 + 偶发走神）与本设计不同：本片是**有界简化版**（严格 ≤3s）。在新规格的「偏差登记」中说明，避免未来对账时被当作漏实现。

---

## 4. 数据流

```
robot-service: acquire 新绑定
  roll() → skillLevel + thinkingSpeed ∈ [1000, 3000)
  persist bot:{botId}.personality.thinkingSpeed
        │
        ▼  RobotAcquireResponse.bots[].personality.thinkingSpeed
room-service: fillBots → BotBinding.thinkingSpeed
  buildStartPlayers → game.start.players[].thinkingSpeed
        │
        ▼
game-service: startGame → session.botThinkingSpeeds[seat]
        │
        ▼  机器人回合
driveOneRobotTurn: base = session.botThinkingSpeeds[seat] ?? 2000
  delay = clamp(round(base + U[-300, 300)), 1000, 3000)
  await robotDelay(delay)  →  robot.decide  →  应用动作
```

---

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/robot-service/src/robot/robot.pool.ts` | `THINKING_SPEED` → `THINKING_SPEED_RANGE = [1000, 3000]`；`roll()` 解耦难度与手速；注释同步 |
| `packages/protocol/src/robot.ts` | `BotPersonality.thinkingSpeed` 注释改为「基础手速 1–3s，每回合 ±300ms 抖动」 |
| `packages/protocol/src/rpc.ts` | `StartGameRequest.players[]` 增加 `thinkingSpeed?: number` |
| `packages/game-service/src/game/dto.ts` | 同步上述字段（两份定义必须同改） |
| `packages/room-service/src/rooms/rooms.bots.ts` | `BotBinding` 增加 `thinkingSpeed: number` |
| `packages/room-service/src/rooms/rooms.start.ts` | `fillBots` 拷贝 `personality.thinkingSpeed`；`buildStartPlayers` 透传 |
| `packages/shared/src/ddz/types.ts` | `GameSession.botThinkingSpeeds?: Array<number \| undefined>` |
| `packages/game-service/src/game/game.service.ts` | `startGame` 填充；新增 `robotJitterRandom`；`driveOneRobotTurn` 用 D4 公式；删除 `thinkingSpeedOf` |
| `packages/protocol/src/validate.ts` | `FORBIDDEN_OUTBOUND_KEYS` 增加 `thinkingSpeed` |
| `packages/game-service/src/game/view.builder.ts` | 出站裁剪字段清单注释同步 |
| `packages/room-service/test/match.service.test.ts` | 匹配路径两处 `game.start` 逐字载荷断言补 `thinkingSpeed: 900` |
| `tools/conformance/src/slices/slice-11-robot-system.ts` | `DRIVE_WINDOW_MS` 15s；`GAME_DEADLINE_MS` 300s；`BOT_MARKERS` 增加 `thinkingSpeed` |
| `tools/conformance/src/lib/ddz-driver.ts` | `FULL_GAME_DEADLINE_MS` 180s → 300s |
| `tools/conformance/src/lib/assert.ts` | `LEAK_KEYS` 增加 `thinkingSpeed` |
| `tools/conformance/src/slices/slice-07.2-hardening.ts` | `BOT_MARKERS` 增加 `thinkingSpeed` |
| `tools/conformance/src/slices/slice-07-match-join.ts` | 过期数值注释同步 |
| `docs/design.md` | §9.3 表、§9.4 最坏耗时、§9.6 抽取语义 |
| `packages/game-service/test/full-game.test.ts` | 防御性注入 0 延迟 |
| `packages/game-service/test/game.robot.test.ts` | 重写过期的 1500ms 断言；覆盖抖动、clamp、旧会话、座位索引、每回合抖动 |
| `packages/robot-service/test/robot.pool.test.ts` | 三档区间断言改为统一 `[1000, 3000)`；J5b/J5c 的消费计数不变 |

---

## 6. 判据（实现验收）

| # | 判据 | 判据形态 | 落点 |
| --- | --- | --- | --- |
| J1 | 新机器人 `thinkingSpeed ∈ [1000, 3000)`，且与 `skillLevel` 无关 | 固定随机源，逐档断言 | robot-service vitest |
| J2 | 每个新绑定仍恰好消费 2 个随机数；幂等命中 Δ=0 | 计数桩 | robot-service vitest（既有 J5c 保持） |
| J3 | 延迟公式：注入 `robotJitterRandom` 0 / 0.5 / 1 ⇒ `base−300 / base / base+300`；且**每回合**重新抖动、每手决策前恰好一次延迟（`delay 次数 === decide 次数`） | 捕获 `robotDelay` 参数 + 序列随机源 | game-service vitest |
| J4 | 越界 clamp：base=400 ⇒ 1000；base=2990 + jitter ⇒ 3000 | 捕获参数 | game-service vitest |
| J5 | **旧会话**（Redis JSON **没有** `botThinkingSpeeds` 键）⇒ 2000ms 且不崩；DTO 缺字段、NaN 同样回落 2000ms | 构造无键会话 + 新实例 `loadSession` 驱动 | game-service vitest |
| J6 | 延迟仍在 `robot.decide` **之前**，且 `turnDeadlineAt` 不顺延 | 顺序 + 30_000 断言 | `game.robot.test.ts`（改写过期的 1500ms 断言） |
| J7 | `game.start` 载荷携带 `thinkingSpeed`；room-service 从 `BotInstance.personality` 取值；人类座位不带该字段 | 载荷断言 | room-service vitest（含 `match.service.test.ts` 两处逐字载荷） |
| J8 | `thinkingSpeed` 出现在任何出站消息 ⇒ `assertNoLeak` 抛错；conformance 的 `LEAK_KEYS` / `BOT_MARKERS` 同样覆盖 | 正负对照 | protocol vitest + conformance lint |
| J9 | 全机器人局在 0 延迟下仍能跑完；`full-game.test.ts` 的注入是防御性的（当前该用例不会推进到机器人回合） | 既有整局用例 | game-service vitest |
| J10 | conformance slice-11 在新区间下端到端绿 | 真栈 | conformance（真栈不可用时交付报告必须写「J10 未验证」，不得宣称 D7 完成） |

---

## 7. 风险与已知边界

1. **整局时长变长**：机器人平均每手 2s，全机器人局约 2–3 分钟。这是用户要的拟人化代价；conformance 三个上界已同步放宽（`DRIVE_WINDOW_MS` 15s、`GAME_DEADLINE_MS` 300s、`FULL_GAME_DEADLINE_MS` 300s）。
2. **旧会话**：仅默认 2000ms，行为安全；窗口 ≤ SESSION_TTL（1h）。
3. **房满早返的既有窄缝**：`fillBots` 在房间已满时返回 `bindings: []`，预置机器人座位拿不到 `botId/skillLevel/thinkingSpeed`（既有行为，已在 `rooms.start.test.ts:346` 登记），本片不修、不回归。
4. **`thinkingSpeed` 语义变更**：从「按难度区间的采样值」变为「与难度无关的基础手速」。所有读取方（本片之后只有 game-service）必须按新语义理解；注释已同步。

---

## 8. 有意偏差登记

| 文档 | 原描述 | 本设计 |
| --- | --- | --- |
| `2026-08-31-game-platform-architecture-design.md:2799-2819` | `ThinkingDelay`：`base + random(0,500)`，低级机器人偶发 `+random(1000,3000)` 走神 | 有界简化：`base ± 300`，严格 `[1000, 3000]`，无走神分支（用户要求单次 ≤3s） |
| `2026-10-01-ai-rollout-design.md` | `thinkingSpeed` 按难度三档区间 | 统一 1–3s，与难度解耦；「每新绑定重抽、幂等命中不重抽」不变 |
