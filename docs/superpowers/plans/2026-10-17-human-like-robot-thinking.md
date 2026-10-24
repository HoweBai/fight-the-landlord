# 机器人拟人化思考时间（1–3s）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个机器人拥有 1–3 秒的稳定「基础手速」，每回合在其 ±300ms 内抖动，使机器人出牌节奏接近真人。

**Architecture:** robot-service 在建池/新绑定时把 `personality.thinkingSpeed` 抽成 `[1000, 3000)` 的基础手速；room-service 经 `BotBinding` → `game.start` 透传给 game-service；game-service 存入 `session.botThinkingSpeeds`，在每次驱动机器人回合时计算 `clamp(base ± 300ms, 1000, 3000)` 并沿用既有 `robotDelay` 注入缝等待。难度只决定决策模型，与思考速度解耦。

**Tech Stack:** TypeScript、NestJS、Vitest、pnpm workspace、turbo、Redis（会话/机器人池）。

## Global Constraints

- 每个任务结束后必须创建 git commit（仓库 CLAUDE.md 规则）。
- 每个行为改动必须先写/改测试，再实现；交付前所有受影响包的测试与类型检查必须通过。
- 所有 commit message 末尾加：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 思考延迟必须严格落在 `[1000, 3000]` ms；延迟**不得**修改 `turnDeadlineAt`（§9.4）。
- `thinkingSpeed` 是**服务端内部字段**，永不出站。
- 既有随机数语义不得被破坏：`game-service` 的 `random` 仍只用于座位/流局重摇/随机地主；`robot-service` 每个新绑定仍恰好消费 2 个随机数。
- 测试命令统一用 pnpm filter（包名见各任务）。

---

## 文件结构

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `packages/protocol/src/rpc.ts` | 内部 RPC 契约：`StartGameRequest.players[].thinkingSpeed` | 1 |
| `packages/game-service/src/game/dto.ts` | `game.start` 入参镜像定义（必须与 protocol 同步） | 1 |
| `packages/protocol/src/robot.ts` | `BotPersonality.thinkingSpeed` 语义注释 | 1 |
| `packages/protocol/src/validate.ts` | 出站禁止字段闸 | 1 |
| `packages/game-service/src/game/view.builder.ts` | 出站裁剪字段清单注释 | 1 |
| `packages/shared/src/ddz/types.ts` | `GameSession.botThinkingSpeeds` | 1 |
| `packages/robot-service/src/robot/robot.pool.ts` | 基础手速采样（1–3s，与难度无关） | 2 |
| `packages/room-service/src/rooms/rooms.bots.ts` | `BotBinding.thinkingSpeed` | 3 |
| `packages/room-service/src/rooms/rooms.start.ts` | 从 `BotInstance` 拷贝并透传到 `game.start` | 3 |
| `packages/room-service/test/match.service.test.ts` | 匹配路径 `game.start` 逐字载荷断言 | 3 |
| `packages/game-service/src/game/game.service.ts` | 会话存储 + 延迟公式 + 抖动随机源 | 4 |
| `tools/conformance/src/slices/slice-11-robot-system.ts` | 时序窗口 + 泄漏标记 | 5 |
| `tools/conformance/src/lib/ddz-driver.ts` | 整局机制上界 | 5 |
| `tools/conformance/src/lib/assert.ts` | 端到端泄漏清单 | 5 |
| `tools/conformance/src/slices/slice-07.2-hardening.ts` | 泄漏标记 | 5 |
| `docs/design.md` | §9.3/§9.4/§9.6 数值同步 | 5 |

---

## Task 1: 契约层（内部字段 + 出站闸 + 会话字段）

**Files:**
- Modify: `packages/protocol/src/rpc.ts:197-214`
- Modify: `packages/protocol/src/robot.ts:6-7, 20-24`
- Modify: `packages/protocol/src/validate.ts:37-43`
- Modify: `packages/shared/src/ddz/types.ts:126-130`
- Modify: `packages/game-service/src/game/dto.ts:10-21`
- Modify: `packages/game-service/src/game/view.builder.ts:44-45`（内部字段清单注释）
- Test: `packages/protocol/src/robot.test.ts`（在文件末尾 `describe` 内追加）

**Interfaces:**
- Produces: `StartGameRequest.players[].thinkingSpeed?: number`（protocol 与 game-service dto 两份定义同形）
- Produces: `GameSession.botThinkingSpeeds?: Array<number | undefined>`
- Produces: `FORBIDDEN_OUTBOUND_KEYS` 包含 `'thinkingSpeed'`

- [ ] **Step 1: 写失败测试**

在 `packages/protocol/src/robot.test.ts` 的最后一个 `it(...)`（当前 `:85-91` 的 `FORBIDDEN_OUTBOUND_KEYS` 循环）之后、`});` 之前追加：

```ts
  it('thinkingSpeed 是服务端内部字段：混入出站消息必被拦下', () => {
    expect(() => assertNoLeak({ thinkingSpeed: 2000 })).toThrow(/thinkingSpeed/);
    expect(() =>
      validateOutbound({
        type: 'game.state_update',
        version: 1,
        payload: { ...view(), thinkingSpeed: 2000 },
      }),
    ).toThrow(/thinkingSpeed/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @fight-the-landlord/protocol exec vitest run src/robot.test.ts
```

Expected: FAIL —— `assertNoLeak` / `validateOutbound` 没有抛错（`thinkingSpeed` 还不在禁止列表里）。

- [ ] **Step 3: 最小实现**

`packages/protocol/src/validate.ts:37-43`，在 `'skillLevel',` 之后插入一行：

```ts
  'thinkingSpeed', // 拟人化思考延迟：服务端内部字段，玩家面永不出站
```

`packages/protocol/src/rpc.ts` 的 `StartGameRequest.players[]`（`skillLevel?: ...` 之后）追加：

```ts
    /** 服务端内部字段：机器人基础手速（ms，1–3s）。永不下发客户端。 */
    thinkingSpeed?: number;
```

`packages/game-service/src/game/dto.ts` 的 `players[]`（`skillLevel?: ...` 之后）追加同样字段与注释：

```ts
    /** 服务端内部字段：机器人基础手速（ms，1–3s）。永不下发客户端。 */
    thinkingSpeed?: number;
```

`packages/protocol/src/robot.ts:20-24` 改为：

```ts
/** §9.3 的性格参数（难度分级靠 `skillLevel`→模型（§9.3），思考延迟靠 `thinkingSpeed`）。 */
export interface BotPersonality {
  /** **基础手速**（ms，1–3s）：与难度无关；每回合实际延迟 = 该值 ± 300ms（夹到 [1000,3000]）。 */
  thinkingSpeed: number;
}
```

同文件 `:6-7` 的 docblock 禁止字段清单同步追加 `thinkingSpeed`：

```ts
 *  - `BotInstance.botId` / `skillLevel` / `personality.thinkingSpeed` 是**内部**字段 —— 出站由 `validateOutbound()` / `assertNoLeak()`
 *    机械拦住（`FORBIDDEN_OUTBOUND_KEYS` = `actionLog`/`isRobot`/`botId`/`skillLevel`/`thinkingSpeed`/`deviceId`〔风控片 T1 追加〕）。
```

`packages/game-service/src/game/view.builder.ts:44-45` 的裁剪规则注释追加：

```ts
 *  - `actionLog` / `isRobot` / `botId` / `skillLevel` / `thinkingSpeed` 一律不出现（`validateOutbound` 机械保证）；
```

`packages/shared/src/ddz/types.ts`，在 `botSkillLevels` 字段（`:130`）之后追加：

```ts
  /**
   * 机器人**基础手速**（ms，1–3s），按座位索引；人类玩家为 undefined。**永不出站**。
   *
   * 可选：部署窗口内升级前创建的旧会话没有该键 ⇒ 消费侧用默认值 2000ms
   * （`game.service.ts` 的 `DEFAULT_THINKING_SPEED`）。
   */
  botThinkingSpeeds?: Array<number | undefined>;
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @fight-the-landlord/protocol exec vitest run src/robot.test.ts
```

Expected: PASS（全部用例绿）。

- [ ] **Step 5: 构建依赖包并做类型检查**

> 🔴 **必须显式 build**：workspace 包的类型入口是各自的 `dist`（`packages/shared/dist/index.d.ts`），而 `pnpm --filter <pkg> lint` 绕过 turbo 的 `dependsOn: ["^build"]`。不 build 时，game-service 会在 Task 4 报 `TS2339: botThinkingSpeeds does not exist on type GameSession`，api-gateway 的运行期测试也看不到新的禁止字段。

```bash
pnpm --filter @fight-the-landlord/protocol build
pnpm --filter @fight-the-landlord/shared build
pnpm --filter @fight-the-landlord/protocol lint
pnpm --filter @fight-the-landlord/shared lint
pnpm --filter @fight-the-landlord/game-service lint
```

Expected: 五条命令均无输出错误、退出码 0。`dist` 已被 `.gitignore` 忽略，**不要**提交构建产物。

- [ ] **Step 6: 提交**

```bash
git add packages/protocol/src/rpc.ts packages/protocol/src/robot.ts packages/protocol/src/validate.ts packages/shared/src/ddz/types.ts packages/game-service/src/game/dto.ts packages/game-service/src/game/view.builder.ts packages/protocol/src/robot.test.ts
git commit -m "feat(protocol): 增加机器人基础手速内部字段与出站闸" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: robot-service 采样改为 1–3s 且与难度解耦

**Files:**
- Modify: `packages/robot-service/src/robot/robot.pool.ts:35-40`
- Modify: `packages/robot-service/src/robot/robot.pool.ts:141-145`（复用注释：手速也会重抽）
- Modify: `packages/robot-service/src/robot/robot.pool.ts:441-446`
- Test: `packages/robot-service/test/robot.pool.test.ts:59-82, 407-452`

**Interfaces:**
- Consumes: `BotInstance.personality.thinkingSpeed: number`（既有）
- Produces: 新绑定 `thinkingSpeed ∈ [1000, 3000)`（`Math.floor(random * 2000) + 1000`）
- Produces: `THINKING_SPEED_RANGE: readonly [number, number]`（导出常量，替代 `THINKING_SPEED`）

- [ ] **Step 1: 改测试（先失败）**

`packages/robot-service/test/robot.pool.test.ts` 用例 ①（`:70-71`）改为：

```ts
      expect(bot.personality.thinkingSpeed).toBe(1200); // 1000 + floor(0.1 * 2000)
```

`片② D2/J5` 用例（`:417-432`）整体替换为：

```ts
  it('片② D2/J5：release 后再 acquire ⇒ 难度与基础手速都重抽并写回', async () => {
    const seq = [0.1, 0.1, 0.9, 0.9];   // 每次新绑定 = [难度, 手速]
    pool.random = () => seq.shift()!;

    const [a] = await pool.acquire('R1', [1]);
    await pool.release([a.botId]);
    const [b] = await pool.acquire('R2', [1]);

    expect(a.skillLevel).toBe('beginner');
    expect(a.personality.thinkingSpeed).toBe(1200);   // 1000 + floor(0.1 * 2000)
    expect(b.skillLevel).toBe('advanced');
    expect(b.personality.thinkingSpeed).toBe(2800);   // 1000 + floor(0.9 * 2000)
    expect((await pool.get(b.botId))?.skillLevel).toBe('advanced');   // 写回要落盘
    expect((await pool.get(b.botId))?.personality.thinkingSpeed).toBe(2800); // 手速也必须落盘
  });

  it('基础手速采样边界：[1000, 3000)', async () => {
    pool.random = () => 0;
    const [low] = await pool.acquire('RB0', [0]);
    expect(low!.personality.thinkingSpeed).toBe(1000);

    pool.random = () => 0.999999;
    const [high] = await pool.acquire('RB1', [0]);
    expect(high!.personality.thinkingSpeed).toBe(2999);
  });
```

`难度分布与思考延迟按 §9.3 的三档取值` 用例（`:434-452`）整体替换为：

```ts
  it('难度分布按 §9.3 三档；基础手速统一 1–3s、与难度无关', async () => {
    // 每个新绑定消费 2 个随机数：[难度, 手速]
    const seq = [0.1, 0.5, 0.3, 0.5, 0.6, 0.5];
    pool.random = () => seq.shift()!;

    const [beg] = await pool.acquire('R9', [0]);
    expect(beg!.skillLevel).toBe('beginner');
    expect(beg!.personality.thinkingSpeed).toBe(2000); // 1000 + floor(0.5 * 2000)

    const [mid] = await pool.acquire('R9', [1]);
    expect(mid!.skillLevel).toBe('intermediate');
    expect(mid!.personality.thinkingSpeed).toBe(2000);

    const [adv] = await pool.acquire('R9', [2]);
    expect(adv!.skillLevel).toBe('advanced');
    expect(adv!.personality.thinkingSpeed).toBe(2000);
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @fight-the-landlord/robot-service exec vitest run test/robot.pool.test.ts
```

Expected: FAIL —— 旧实现给 beginner 的速度区间是 800–1500（`0.1` ⇒ 870），不是 1200。

- [ ] **Step 3: 最小实现**

`packages/robot-service/src/robot/robot.pool.ts:35-40` 替换为：

```ts
/** §9.3 拟人化基础手速区间（ms）：与难度无关，1–3s。 */
export const THINKING_SPEED_RANGE: readonly [number, number] = [1000, 3000];
```

`:441-446` 的 `roll()` 替换为：

```ts
  /** 抽一次：skillLevel（可配比例）+ 1–3s 基础手速（与难度无关）。**只在新建绑定时调用**。 */
  private roll(): { skillLevel: SkillLevel; thinkingSpeed: number } {
    const skillLevel = this.pickSkillLevel();
    const [min, max] = THINKING_SPEED_RANGE;
    return { skillLevel, thinkingSpeed: Math.floor(this.random() * (max - min)) + min };
  }
```

同时把 `:141` 的注释改为：

```ts
      // 🔴 抽要在「复用 or 新建」之前 —— 池里捞回来的实例带着**上一局**的难度与基础手速（D2）
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm --filter @fight-the-landlord/robot-service exec vitest run test/robot.pool.test.ts
```

Expected: PASS。特别确认 `片② D2/J5c：每新绑定恰好抽 2 个随机数，幂等命中 0 个` 仍绿。

- [ ] **Step 5: 类型检查**

```bash
pnpm --filter @fight-the-landlord/robot-service lint
```

Expected: 无错误、退出码 0。

- [ ] **Step 6: 提交**

```bash
git add packages/robot-service/src/robot/robot.pool.ts packages/robot-service/test/robot.pool.test.ts
git commit -m "feat(robot): 基础手速改为与难度无关的 1–3s 区间" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: room-service 透传 `thinkingSpeed`

**Files:**
- Modify: `packages/room-service/src/rooms/rooms.bots.ts:13-18`
- Modify: `packages/room-service/src/rooms/rooms.start.ts:262-267`
- Modify: `packages/room-service/src/rooms/rooms.start.ts:558-574`
- Test: `packages/room-service/test/rooms.start.test.ts:130-136`
- Test: `packages/room-service/test/match.service.test.ts:1300-1304, 1803-1816`（匹配路径的**逐字载荷**断言，必改）

**Interfaces:**
- Consumes: `BotInstance.personality.thinkingSpeed: number`（从 `robot.acquire` 返回）
- Produces: `BotBinding.thinkingSpeed: number`
- Produces: `game.start` 载荷机器人座位含 `thinkingSpeed: number`；人类座位不含该字段

- [ ] **Step 1: 改测试（先失败）**

`packages/room-service/test/rooms.start.test.ts` 的 `:130-136` 改为：

```ts
    // `game.start` 的载荷：人类不带 botId/thinkingSpeed，机器人**必须**带（§9.6 第 4 条）
    const start = calls.find((c) => c.pattern === RPC_PATTERNS.gameStart)!.data as {
      players: Array<Record<string, unknown>>;
    };
    expect(start.players).toHaveLength(3);
    const human = start.players.find((p) => p.id === 'u1');
    expect(human).toBeDefined(); // 反空转：find 失败时下面的负向断言会假绿
    expect(human).not.toHaveProperty('botId');
    expect(human).not.toHaveProperty('thinkingSpeed');
    const robots = start.players.filter((p) => p.isRobot === true);
    expect(robots).toHaveLength(2);
    for (const robot of robots) {
      expect(robot).toHaveProperty('botId');
      expect(robot).toHaveProperty('skillLevel');
      expect(robot.thinkingSpeed).toBe(900); // 来自 botOf 的 personality.thinkingSpeed
    }
```

`packages/room-service/test/match.service.test.ts:1300-1304` 的两条机器人条目补 `thinkingSpeed: 900`：

```ts
      expect(body.players).toEqual([
        { id: 'u1', seat: 0, isRobot: false },
        { id: 'p_seat1000', seat: 1, isRobot: true, botId: 'bot-internal-1', skillLevel: 'beginner', thinkingSpeed: 900 },
        { id: 'p_seat2000', seat: 2, isRobot: true, botId: 'bot-internal-2', skillLevel: 'beginner', thinkingSpeed: 900 },
      ]);
```

`packages/room-service/test/match.service.test.ts:1803-1816` 同样补 `thinkingSpeed: 900`：

```ts
            { id: 'p_00000001', seat: 1, isRobot: true, botId: 'bot-abc', skillLevel: 'beginner', thinkingSpeed: 900 },
            { id: 'p_00000002', seat: 2, isRobot: true, botId: 'bot-abc', skillLevel: 'beginner', thinkingSpeed: 900 },
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @fight-the-landlord/room-service exec vitest run test/rooms.start.test.ts
```

Expected: FAIL —— `robot.thinkingSpeed` 为 `undefined`。

- [ ] **Step 3: 最小实现**

`packages/room-service/src/rooms/rooms.bots.ts:13-18` 改为：

```ts
export interface BotBinding {
  seat: number;
  botId: string;
  skillLevel: SkillLevel;
  /** 基础手速（ms，1–3s）：随 `game.start` 透传给 game-service，**永不下发客户端**。 */
  thinkingSpeed: number;
  displayId: string;
}
```

`packages/room-service/src/rooms/rooms.start.ts:262-267` 的 `botBindings.push({...})` 增加一行（对损坏/缺 `personality` 的旧记录兜底）：

```ts
        botBindings.push({
          seat: bot.seat ?? bound?.seat ?? current.players.length - 1,
          botId: bot.botId,
          skillLevel: bot.skillLevel,
          // 旧记录缺 personality 时不得让补位失败（此前这条链从不读 personality）
          thinkingSpeed:
            typeof bot.personality?.thinkingSpeed === 'number' &&
            Number.isFinite(bot.personality.thinkingSpeed)
              ? bot.personality.thinkingSpeed
              : 2000,
          displayId: bot.displayId,
        });
```

`packages/room-service/src/rooms/rooms.start.ts:558-574` 的 `buildStartPlayers` 机器分支增加一行：

```ts
      return {
        id: s.userId,
        seat: s.seat,
        isRobot: s.isRobot,
        botId: bot.botId,
        skillLevel: bot.skillLevel,
        thinkingSpeed: bot.thinkingSpeed,
      };
```

- [ ] **Step 4: 运行**整个** room-service 测试套件确认通过**

```bash
pnpm --filter @fight-the-landlord/room-service test
```

Expected: PASS。**必须跑全量**——`match.service.test.ts` 的两处逐字载荷断言只有全量才会覆盖（只跑 `rooms.start.test.ts` 会假绿）。

- [ ] **Step 5: 类型检查**

```bash
pnpm --filter @fight-the-landlord/room-service lint
```

Expected: 无错误、退出码 0。

- [ ] **Step 6: 提交**

```bash
git add packages/room-service/src/rooms/rooms.bots.ts packages/room-service/src/rooms/rooms.start.ts packages/room-service/test/rooms.start.test.ts packages/room-service/test/match.service.test.ts
git commit -m "feat(room): 机器人基础手速随 game.start 透传" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: game-service 存储基础手速并实现 ±300ms 抖动

**Files:**
- Modify: `packages/game-service/src/game/game.service.ts:96-120`（新增注入缝）
- Modify: `packages/game-service/src/game/game.service.ts:249-252`（填充会话）
- Modify: `packages/game-service/src/game/game.service.ts:645-651`（延迟公式）
- Modify: `packages/game-service/src/game/game.service.ts:798-803`（常量替换 `thinkingSpeedOf`）
- Test: `packages/game-service/test/game.robot.test.ts:35-46, 215-230`
- Test: `packages/game-service/test/full-game.test.ts:28-36`
- Test: `packages/game-service/test/game.service.random.test.ts:100`

**Interfaces:**
- Consumes: `StartGameRequest.players[].thinkingSpeed?: number`（Task 1）
- Consumes: `GameSession.botThinkingSpeeds?: Array<number | undefined>`（Task 1）
- Produces: `GameService.robotJitterRandom: () => number`（测试可注入）
- Produces: 每回合延迟 = `clamp(Math.round(base + (rand*2-1)*300), 1000, 3000)`；
  `base = Number.isFinite(session.botThinkingSpeeds?.[seat]) ? 该值 : 2000`

- [ ] **Step 1: 改测试（先失败）**

`packages/game-service/test/game.robot.test.ts:35-46` 的 `robotDto` 改为：

```ts
/** 三人**全是机器人**的开局 DTO（`botId` + `skillLevel` + `thinkingSpeed` 由 room-service 透传，§9.6 第 4 条）。 */
const robotDto = (roomCode: string, thinkingSpeed = 2000) => ({
  roomCode,
  baseScore: 100,
  players: [0, 1, 2].map((seat) => ({
    id: `p_bot${seat}`,
    seat,
    isRobot: true,
    botId: `bot-${seat}`,
    skillLevel: 'beginner' as const,
    thinkingSpeed,
  })),
});
```

`:215-230` 的用例 ⑤ 整体替换，并追加 ⑤b–⑤i。文件顶部的 shared 导入追加 `createSession, dealCards`：

```ts
import {
  GameState,
  createSession,
  dealCards,
  createCapturingSink,
  createRedactingLogger,
} from '@fight-the-landlord/shared';
```

```ts
  it('⑤ 思考延迟 = 基础手速 ± 300ms、先等后决策、计入 30s 且**不顺延** turnDeadlineAt（§9.4）', async () => {
    const delays: number[] = [];
    const events: string[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
      events.push('delay');
    };
    const originalDecide = service.robotClient!.decide.bind(service.robotClient);
    service.robotClient!.decide = async (req: RobotDecideRequest) => {
      events.push('decide');
      return originalDecide(req);
    };
    service.robotJitterRandom = () => 0.5; // jitter = 0 ⇒ 恰为基础手速

    await service.startGame(robotDto('ROOM-R6', 2000));
    await flush();

    const after = (await service.getSession('ROOM-R6'))!;
    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBe(2000);
    // J6：先延迟、后决策（顺序不可颠倒）
    expect(events.slice(0, 2)).toEqual(['delay', 'decide']);
    // ⚠️ 判据：延迟**不得**加到 deadline 上（假计时器下 Date.now() 冻结 ⇒ 恰好 30000）
    expect((after.turnDeadlineAt ?? 0) - Date.now()).toBe(30_000);
  });

  it('⑤b 抖动下界：jitterRandom 0 ⇒ base−300', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0;

    await service.startGame(robotDto('ROOM-R6L', 2000));
    await flush();
    expect(delays[0]).toBe(1700);
  });

  it('⑤b2 抖动上界：jitterRandom 1 ⇒ base+300', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 1;

    await service.startGame(robotDto('ROOM-R6H', 2000));
    await flush();
    expect(delays[0]).toBe(2300);
  });

  it('⑤c 越界基础手速被夹到 1000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    await service.startGame(robotDto('ROOM-R6C', 400));
    await flush();
    expect(delays[0]).toBe(1000);
  });

  it('⑤d game.start 载荷缺 thinkingSpeed ⇒ 默认 2000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    const dto = robotDto('ROOM-R6D');
    for (const p of dto.players) delete (p as { thinkingSpeed?: number }).thinkingSpeed;
    await service.startGame(dto);
    await flush();
    expect(delays[0]).toBe(2000);
  });

  it('⑤e 上界夹取：2990 + 300 ⇒ 3000', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 1;

    await service.startGame(robotDto('ROOM-R6E', 2990));
    await flush();
    expect(delays[0]).toBe(3000);
  });

  it('⑤f 旧会话（Redis JSON 无 botThinkingSpeeds 键）⇒ 默认 2000ms，不崩', async () => {
    const delays: number[] = [];

    // 构造一份升级前写出的会话：**没有** botThinkingSpeeds 键
    const baseSession = createSession('ROOM-OLD', ['p_bot0', 'p_bot1', 'p_bot2'], () => 0);
    baseSession.botIds = ['bot-0', 'bot-1', 'bot-2'];
    baseSession.botSkillLevels = ['beginner', 'beginner', 'beginner'];
    const oldSession = { ...dealCards(baseSession), turnDeadlineAt: Date.now() + 30_000 };
    expect('botThinkingSpeeds' in oldSession).toBe(false);
    await redisDouble.set('game:session:ROOM-OLD', JSON.stringify(oldSession));

    // 新实例强制走 Redis（不命中 service 的内存 cache）
    const fresh = new GameService(redisDouble as unknown as Redis);
    fresh.random = () => 0;
    fresh.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    fresh.robotJitterRandom = () => 0.5;
    fresh.robotClient = {
      decide: async (): Promise<RobotDecideResponse> => ({ kind: 'pass', source: 'douzero' }),
    } as never;

    await fresh['driveRobotTurn']('ROOM-OLD');

    expect(delays.length).toBeGreaterThan(0);
    expect(delays[0]).toBe(2000);
    expect((await fresh.getSession('ROOM-OLD'))!.version).toBeGreaterThan(oldSession.version);
  });

  it('⑤g 基础手速按座位索引（座位 0/1/2 = 1000/2000/2990）', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    const dto = robotDto('ROOM-R6G');
    dto.players[0]!.thinkingSpeed = 1000;
    dto.players[1]!.thinkingSpeed = 2000;
    dto.players[2]!.thinkingSpeed = 2990;
    await service.startGame(dto);
    await flush();

    // 叫抢起始座位 = floor(random(=0) * 3) = 0 ⇒ 前三拍依次是座位 0 → 1 → 2（用例 ④ 同款判据）
    expect(delays.slice(0, 3)).toEqual([1000, 2000, 2990]);
  });

  it('⑤h 每回合重新抖动，且每一手决策前恰好一次延迟', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    const seq = [0, 1, 0, 1];
    service.robotJitterRandom = () => seq.shift() ?? 0.5;

    await service.startGame(robotDto('ROOM-R6H2', 2000));
    await flush();

    expect(delays.length).toBeGreaterThan(3);
    expect(delays.slice(0, 4)).toEqual([1700, 2300, 1700, 2300]);
    // 整局驱动期间：延迟次数 === 决策次数 ⇒ 挡住「整局只抽一次抖动 / 只延迟第一手」
    expect(delays.length).toBe(decideCalls.length);
  });

  it('⑤i 非有限基础手速（NaN）⇒ 默认 2000ms', async () => {
    const delays: number[] = [];
    service.robotDelay = async (ms: number) => {
      delays.push(ms);
    };
    service.robotJitterRandom = () => 0.5;

    await service.startGame(robotDto('ROOM-R6I', Number.NaN));
    await flush();
    expect(delays[0]).toBe(2000);
  });
```

`packages/game-service/test/full-game.test.ts:35` 之后追加一行：

```ts
    service.robotDelay = async () => {}; // 防御性：若未来推进到机器人回合，避免真实 1–3s 等待
```

`packages/game-service/test/game.service.random.test.ts:100` 附近（`service.robotDelay = async () => {};` 之后）追加：

```ts
    service.robotJitterRandom = () => 0.5; // 与 random 分离；此处固定以消除无关随机
```

同文件 `:93-95` 的过期注释改为：

```ts
     *  - 0 思考延迟：否则每次机器人决策真等 1–3s（基础手速 ±300ms），而 `waitForPlaying` 是
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm --filter @fight-the-landlord/game-service exec vitest run test/game.robot.test.ts
```

Expected: FAIL —— 旧实现 `delays[0]` 是 1500（按难度硬编码），且 `robotJitterRandom` 未被读取。

- [ ] **Step 3: 最小实现**

`packages/game-service/src/game/game.service.ts`，把现有 `robotDelay` 的 docblock（`:96-104`）整体替换为：

```ts
  /**
   * 思考延迟（§9.4）。**可注入**：测试注入 `async () => {}` 得到结构性判据（0 延迟）。
   *
   * ⚠️ 参数是**单次实际延迟**（已 clamp 到 [1000, 3000]）：`base` 来自
   * `session.botThinkingSpeeds[seat]`（robot-service 建池时采样的 1–3s 基础手速），
   * 每回合叠加 ±300ms 抖动；旧会话缺该字段时 `base = 2000`。
   * 最坏 3s + `robot.decide` 5s ≈ 8s，远小于 30s 回合时限。
   */
```

并在 `random` 字段（`:120`）之后追加：

```ts
  /**
   * 思考延迟抖动的随机源（§9.3）。**独立于 `random`**：
   * `game.service.random.test.ts` 对 `random` 的消费次数有精确断言
   * （座位/流局重摇/随机地主），复用本缝会把那些判据全部打乱。
   */
  robotJitterRandom: () => number = Math.random;
```

`startGame` 中 `session.botSkillLevels = ...`（`:251`）之后追加：

```ts
    // §9.3：机器人基础手速（1–3s，与难度无关）。**永不出站**
    session.botThinkingSpeeds = players.map((p) => (p.isRobot ? p.thinkingSpeed : undefined));
```

`driveOneRobotTurn`（`:650-651`）替换为：

```ts
    // §9.3/§9.4 的思考延迟：基础手速 ± 300ms，先等再决策（等待**不**顺延 turnDeadlineAt）
    const rawBase = session.botThinkingSpeeds?.[seat];
    const base =
      typeof rawBase === 'number' && Number.isFinite(rawBase)
        ? rawBase
        : DEFAULT_THINKING_SPEED;
    const jitter = (this.robotJitterRandom() * 2 - 1) * THINKING_JITTER_MS;
    await this.robotDelay(
      Math.min(THINKING_MAX_MS, Math.max(THINKING_MIN_MS, Math.round(base + jitter))),
    );
```

文件底部 `thinkingSpeedOf()`（`:798-803`）整体替换为：

```ts
/** §9.3 拟人化思考延迟：基础手速缺省值（ms，区间中点；旧会话/旧房间无该字段时使用）。 */
const DEFAULT_THINKING_SPEED = 2000;
/** 每回合相对基础手速的抖动幅度（±ms）。 */
const THINKING_JITTER_MS = 300;
/** 单次延迟下界（ms）。 */
const THINKING_MIN_MS = 1000;
/** 单次延迟上界（ms）。 */
const THINKING_MAX_MS = 3000;
```

- [ ] **Step 4: 运行目标测试确认通过**

```bash
pnpm --filter @fight-the-landlord/game-service exec vitest run test/game.robot.test.ts
```

Expected: PASS（含 ⑤、⑤b、⑤b2、⑤c、⑤d、⑤e、⑤f、⑤g、⑤h、⑤i 与既有 ①–④、⑥）。

- [ ] **Step 5: 运行 game-service 全量测试**

```bash
pnpm --filter @fight-the-landlord/game-service test
```

Expected: 全部 PASS（尤其 `game.service.random.test.ts` 的 `randomCalls === 1` / `=== 4` 不被破坏）。

- [ ] **Step 6: 类型检查**

```bash
pnpm --filter @fight-the-landlord/game-service lint
```

Expected: 无错误、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add packages/game-service/src/game/game.service.ts packages/game-service/test/game.robot.test.ts packages/game-service/test/full-game.test.ts packages/game-service/test/game.service.random.test.ts
git commit -m "feat(game): 机器人思考延迟改为基础手速 ±300ms" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: conformance 时序窗口、泄漏闸与文档同步

**Files:**
- Modify: `tools/conformance/src/slices/slice-11-robot-system.ts:105-113`（窗口常量 + 文件头/步骤文案）
- Modify: `tools/conformance/src/lib/ddz-driver.ts:664-665`（`FULL_GAME_DEADLINE_MS`）
- Modify: `tools/conformance/src/lib/assert.ts:27`（`LEAK_KEYS`）
- Modify: `tools/conformance/src/slices/slice-11-robot-system.ts:117` + 探针对象 `:672`
- Modify: `tools/conformance/src/slices/slice-07.2-hardening.ts:299` + 探针对象 `:642`
- Modify: `tools/conformance/src/slices/slice-07-match-join.ts:140`（过期数值注释）
- Modify: `docs/design.md:1483-1487, 1515, 1533`

**Interfaces:**
- Produces: `DRIVE_WINDOW_MS = 15_000`、`GAME_DEADLINE_MS = 300_000`、`FULL_GAME_DEADLINE_MS = 300_000`
- Produces: conformance 的 `LEAK_KEYS` / `BOT_MARKERS` 包含 `thinkingSpeed`
- 注：规格 D8 第三条（与 2026-08-31 旧架构文档的偏差）由规格 §8 承载，**不改历史文档**。

- [ ] **Step 1: 修改 slice-11 的窗口常量与注释**

`tools/conformance/src/slices/slice-11-robot-system.ts:105-113` 替换为：

```ts
/**
 * §9.4 的严格窗口：机器人回合必须在这个量级内被推进。
 * 推导：思考延迟上界 3s + `robot.decide` 超时 5s + 落盘/pubsub 余量 ⇒ 15s（仍 ≪ 30s，
 * 「不是 30s 超时兜底」的判别力不变）。
 */
const DRIVE_WINDOW_MS = 15_000;
/**
 * **机制**等待窗口（不是判据）：必须 > 30s —— 未修栈上机器人回合**只**能被 30s 超时推动，
 * 而 `CONFORMANCE_STEPS=play` 之类的逐步取证要能在同一份代码上跑到出牌阶段。
 */
const MECHANICS_TURN_MS = 40_000;
/** 第 3 组的「有限时间」：局终上界（机器人平均每手约 2s，且要容纳 30s 超时兜底）。 */
const GAME_DEADLINE_MS = 300_000;
```

同文件头部/步骤文案里的旧数值同步改：`:9-11`、`:64`、`:361`、`:444` 中的「≤5s」→「≤15s」、「150s」→「300s」。

- [ ] **Step 2: 修改 `FULL_GAME_DEADLINE_MS`**

`tools/conformance/src/lib/ddz-driver.ts:664-665` 替换为：

```ts
/** `playFullGameToEnd` 的时长上界（含机器人局；机器人平均每手约 2s，纯机制常量，不是判据）。 */
export const FULL_GAME_DEADLINE_MS = 300_000;
```

- [ ] **Step 3: 同步 conformance 的第二份泄漏清单**

`tools/conformance/src/lib/assert.ts:27` 改为：

```ts
export const LEAK_KEYS = ['actionLog', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed', 'players'] as const;
```

`tools/conformance/src/slices/slice-11-robot-system.ts:117` 改为：

```ts
const BOT_MARKERS = ['bot-', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed'] as const;
```

同文件探针对象 `:672` 补一个字段（正对照必须能命中全部标记）：

```ts
        botMarkers({ id: 'bot-deadbeef', isRobot: true, botId: 'x', skillLevel: 'beginner', thinkingSpeed: 2000 }).length,
```

`tools/conformance/src/slices/slice-07.2-hardening.ts:299` 与探针 `:642` 做同样修改：

```ts
const BOT_MARKERS = ['bot-', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed'] as const;
```

```ts
      const probeHit = botMarkers({ id: 'bot-deadbeef', isRobot: true, botId: 'x', skillLevel: 'beginner', thinkingSpeed: 2000 });
```

- [ ] **Step 4: 同步过期数值注释**

`tools/conformance/src/slices/slice-07-match-join.ts:140` 的「`beginner` 800–1500ms」改为：

```ts
    // 落地 §9.4 的服务端驱动后，机器人会在 `thinkingSpeed` 量级（基础手速 1–3s，每回合 ±300ms）
```

`packages/game-service/test/game.service.random.test.ts:93-95` 的「真等 1500ms」已在 Task 4 改为「真等 1–3s」。

- [ ] **Step 5: 修改 `docs/design.md`**

`docs/design.md:1483-1487` 的 `thinkingSpeed` 列改为统一区间，并在表下补一句：

```markdown
| skillLevel   | 决策源（模型）                   | thinkingSpeed（基础手速） |
| ------------ | -------------------------------- | ------------------------- |
| beginner     | DouZero **`sl`**（监督学习基线） | 1000–3000 ms              |
| intermediate | DouZero **`douzero_WP`**         | 1000–3000 ms              |
| advanced     | DouZero **`douzero_ADP`**        | 1000–3000 ms              |

> 2026-10-17：思考速度与难度**解耦** —— 三档都从 1000–3000 ms 抽「基础手速」，每回合实际延迟 = 基础值 ± 300 ms（夹到 `[1000, 3000]`）。
```

`docs/design.md:1515` 替换为：

```markdown
- **思考延迟计入 30s 回合时限**：`turnDeadlineAt` 自状态转移时刻起算，**不因机器人思考而顺延**。`thinkingSpeed`（1000–3000 ms）与 `robot.decide` 的 5s 超时都发生在这 30s 之内，实现时必须保证三者之和（思考延迟 + RPC 超时 + 规则引擎兜底）显著小于 30000 ms——当前取值下最坏约 8s，安全。
```

`docs/design.md:1533` 的「难度（`skillLevel` 与 `personality.thinkingSpeed`）只在『新绑定』上当场抽取」改为：

```markdown
难度（`skillLevel`）与基础手速（`personality.thinkingSpeed`）各自独立抽取，**只在「新绑定」上当场抽取**并随实例写回（`bot:{botId}`）—— 同一 `{roomCode, seat}` 的**幂等命中原样返回、不重抽**（`acquire` 失败重试 1 次的前提）；
```

- [ ] **Step 6: 类型检查**

```bash
pnpm --filter @fight-the-landlord/conformance lint
```

Expected: 无错误、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add tools/conformance/src/slices/slice-11-robot-system.ts tools/conformance/src/lib/ddz-driver.ts tools/conformance/src/lib/assert.ts tools/conformance/src/slices/slice-07.2-hardening.ts tools/conformance/src/slices/slice-07-match-join.ts docs/design.md
git commit -m "chore(conformance,docs): 思考延迟窗口、泄漏闸与 §9.3/§9.4 数值同步" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 全量回归验证

**Files:** 无新增改动（只验证）。

- [ ] **Step 1: 运行全部受影响包的测试**

```bash
pnpm --filter @fight-the-landlord/protocol test
pnpm --filter @fight-the-landlord/shared test
pnpm --filter @fight-the-landlord/robot-service test
pnpm --filter @fight-the-landlord/room-service test
pnpm --filter @fight-the-landlord/game-service test
pnpm --filter @fight-the-landlord/api-gateway test
```

Expected: 六个包全部 PASS，0 failed。`api-gateway` 覆盖 `FORBIDDEN_OUTBOUND_KEYS` 的消费侧。

- [ ] **Step 2: 运行全部受影响包的类型检查**

```bash
pnpm --filter @fight-the-landlord/protocol lint
pnpm --filter @fight-the-landlord/shared lint
pnpm --filter @fight-the-landlord/robot-service lint
pnpm --filter @fight-the-landlord/room-service lint
pnpm --filter @fight-the-landlord/game-service lint
pnpm --filter @fight-the-landlord/conformance lint
pnpm --filter @fight-the-landlord/api-gateway lint
```

Expected: 七条命令全部退出码 0。

- [ ] **Step 3: 真栈 conformance（J10）**

若 compose 栈可用：

```bash
pnpm --filter @fight-the-landlord/conformance build
pnpm --filter @fight-the-landlord/conformance conformance:slice-11
```

Expected: slice-11 全绿。若真栈不可用，**在交付报告中逐字写明「J10 未验证」**，并不得宣称 D7 已完成；该项留给 CI/真栈执行。

- [ ] **Step 4: 确认工作区干净**

```bash
git status --short
```

Expected: 无输出（所有改动已在前面任务中提交）。

- [ ] **Step 5: 如果 Step 1/2/3 暴露回归**

按失败用例所在包回到对应任务修复，补测试后再提交；不得跳过或放宽断言。

---

## 自审记录（计划完成时）

- **Spec 覆盖**：D1→Task 2；D2→Task 1+3；D3→Task 1+4；D4→Task 4；D5→Task 4（⑤c 越界、⑤d 缺字段、⑤f 真旧会话、⑤i 非有限值）+ Task 2（重抽）；D6→Task 1 + Task 5（conformance 第二份清单）；D7→Task 5；D8→Task 5。
- **判据覆盖**：J1/J2→Task 2；J3/J4/J5→Task 4（⑤/⑤b/⑤b2/⑤c/⑤d/⑤e/⑤f）；J6→Task 4（⑤ 的顺序 + deadline）；J7→Task 3；J8→Task 1；J9→Task 4（⑤h 的「延迟次数 === 决策次数」）；J10→Task 6 Step 3（真栈可用则跑；不可用则交付报告显式写「J10 未验证」，不得宣称 D7 完成）。
- **评审修订**（本计划 v2）：补 shared/protocol `build` 步骤（dist 陈旧会让 game-service tsc 必红）；补 `match.service.test.ts` 两处逐字载荷；把「缺 DTO 字段」与「真旧会话缺键」拆成 ⑤d/⑤f；增加座位索引（⑤g）与每回合抖动（⑤h）判据；修正 D7 定量依据（旧平均约 975ms，新约 2s ≈ 2 倍）并补 `FULL_GAME_DEADLINE_MS`；同步 conformance 第二份泄漏清单与所有过期注释。
- **类型一致性**：`botThinkingSpeeds`（复数）在 shared / game.service 一致；`thinkingSpeed`（单数）在 protocol/dto/rooms/game.start 一致；`THINKING_SPEED_RANGE` 仅在 robot-service 使用。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码与命令。
