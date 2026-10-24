/**
 * 切片 11 conformance：**机器人系统**（§9 驱动 / 池 / 不可区分）—— Task 8。
 *
 * 计划：`docs/superpowers/plans/2026-09-15-slice-11-robot-system.md` Task 8；
 * 权威依据：裁决 **R200–R213** + `docs/design.md` §9.1–§9.8 / §3.4 / §4.2 / §4.3 / §6.4 / §10.1。
 *
 * 六组判据（全部结构性；`CONFORMANCE_STEPS` 可逐步取 RED，**门禁一律不带它**）：
 *  1. `drive`  **§9.4 服务端驱动**：单人匹配 → 30s 补位 2 机器人 → `game.deal` → 人类此后**不动作**
 *     ⇒ 叫抢必须在 **≤15s** 内被推进（两段式：先断言窗口未到 —— 实测 elapsed 远小于 30s 超时，
 *     再断言 `version` 前进）。**旧实现**：机器人回合只能靠 30s 超时兜底 ⇒ 15s 内无转移 ⇒ RED。
 *  2. `play`   **机器人出牌 + 合法性**：人类出牌后机器人在 ≤15s 内产生状态转移；**机器人**打出的
 *     每一手的**牌面形状**合法（窗口最新一条 —— 即这次转移的动作 —— 是出牌且 `cards` 非空；
 *     协议 ④ 起 `type`/`keyRank`/`length` 不在出站面上，旧那三条子断言的**等价迁移**见
 *     `packages/game-service/test/view.builder.test.ts` 的单测）；全程**不得**出现 `system.error`
 *     （带探针正/负对照）。
 *  3. `finish` **一局能被机器人推进到结束**：人类全程 pass（首出必须出牌时打最小单张）⇒ 对局须在
 *     `GAME_DEADLINE_MS` 内以 `game.finished` 收束。**旧实现**：每个机器人回合等 30s ⇒ RED。
 *  4. `leak`   **§9.8 泄漏扫描（扩展）**：整局**每一条** S→C 消息 + `GET /api/rooms` + `room.join` ack
 *     都不得含 `bot-` / `isRobot` / `botId` / `skillLevel` / `thinkingSpeed`；**正对照**：机器人的对外 id 形如
 *     `p_<8位>`（§9.2/E9），且扫描器自带正/负对照（R212②/R115：先证明探针能观测到「发生」）。
 *  5. `pool`   **§9.6 池闭环**（**R250 重写：与池的前置状态无关**）：只断言**绝对**性质 ——
 *     ① 本局两个机器人都回到池里；② 池里**没有**悬挂成员（每个成员都必须有 `bot:{id}` 记录）；
 *     ③ `bot:{botId}` 的 `roomCode`/`seat` 已清空（或键不存在）。池的 `ZCARD` **只作 info**，
 *     **不作任何相对量断言**。同时机械判据 R207 的 `room:{code}:bots`（Hash，seat → 内部 botId）。
 *
 *     ⚠️ **R250/R243 的由来**：本组原有一条 `poolAfter.length - poolBefore.length === 本局新建数`
 *     的**相对量**等式（注释写着「全新栈上 = 净增 2」）。池**不是静止的** ——
 *     `release` 是 `void` 异步的、`reclaimIdle` 每 60s 走一趟、别的切片/用例也会留下成员、
 *     手工 `DEL bot:pool:doudizhu` 与「晚到的 release」之间还有竞态 ⇒ 那条等式实际断言的是
 *     「**没有别人动过池**」，与 §9.6 的语义无关。历史的 RED 原文（R243，P4 门禁实测）：
 *       `§9.6 池闭环：局终后 ZCARD(bot:pool:doudizhu) 净增 1（本局 2 个机器人 − 其中 1 个开局前本就
 *        空闲、复用了）= 1 → 3（…）：期望 1，实际 2`
 *     —— 本局行为完全正确，只是池里**多了一个别人释放的成员**。
 *     「池退化」这件事已由**绝对**性质承担（② 在这里、`slice-07.2-rpc` 第 2 组另有一处同源断言），
 *     而**相对量**判据对「池退化成 0 / 容量静默丢失」免疫（R115 同族）—— 两头都不该留它。
 *  6. `idem`   **幂等 acquire（R201/R210 的前提）**：对同一 `{roomCode:'S11IDEM', seats:[1]}`
 *     调两次 ⇒ 两次 `botId`/`displayId` **相同**，且**绝对性质**成立（R253/R340 换形态）：
 *     ① 第 2 次 acquire 的窗口内**没有新增**池成员；② 该 bot **不得回池**（它被占用中）；
 *     ③ 池里每个成员都必须有 `bot:{id}` 记录（悬挂为 0）。⚠️ **不再**比较两次 acquire 之间的
 *     `ZCARD`：那是**相对量** —— 它实际断言的是「我这两次读池之间没有第三方动过池」
 *     （`release` 是 `void` 异步、`reclaimIdle` 每 60s 一趟、跨运行的晚到 release 也会落地
 *     ⇒ 假红），而它对「池退化成 0 / 容量静默丢失 / 幽灵成员」**完全免疫**（N22 就是这样藏的）。
 *     判据窗口**紧贴第 2 次 acquire**（不是旧等式的「读 1 → 读 2」），否则会继承同一个假红形态。
 *     ⚠️ **载体已换（N20/P4 Task 6）**：由「直连 HTTP `POST /api/robots/acquire` + `X-Internal-Token`」
 *     改成「`rpcCall(ROBOT_RPC, RPC_PATTERNS.robotAcquire, …)`（§4.2 的 TCP 3105）」——
 *     那条 HTTP 路由已被 **R218** 整条删除。判据**不弱化**：`HTTP 200` ⇒ `ok === true`，
 *     `body.bots` ⇒ `data.bots`（同一份 §4.2 DTO）。旧栈形态：`ECONNREFUSED localhost:3105`。
 *
 * ⚠️ **片② Task 9 的两处扩展**：
 *  - 场景 C 加 **④ J26**（真栈 `/health` 三档齐备、**每档恰好** `landlord`/`landlord_down`/
 *    `landlord_up` 三个名字）与 **⑤ J33**（不带 `model` ≡ 显式 `douzero_WP`，响应**逐字节同**，
 *    夹具是三档输出已知不同的判别局面 `sl=[4] / WP=[3] / ADP=[5]`）；
 *  - 第 6 组（幂等 acquire）加一条 **`skillLevel` 等值断言**（幂等命中 ⇒ 难度不变；它是 J5c 的
 *    旁证、判别力≈60%，主判据在 robot-service 的 vitest）—— 前面另补一条「档位必须是合法值」
 *    的前提，否则 `undefined === undefined` 会让等值断言空转（R115 同族）。
 *
 * ⚠️ 判据纪律（R168/R176/R193/R212）：
 *  - **不** import `@fight-the-landlord/shared`（拿被测实现当裁判）；牌局驱动只用 `lib/ddz-driver.ts`
 *    与 `@fight-the-landlord/protocol` 的类型。协议 ④ 起 `type`/`keyRank`/`length` **不在出站面上**
 *    （`HandType` 那个契约常量也随之退场 —— 它只活在内部 RPC `RobotFeatures.lastMoveMeta` 里）。
 *    （R695 之后**没有值映射可用**了 —— 全系统只有 DouZero 一套编码，直接读 `Card.r`。）
 *  - **不**用 `Checks.eq` 比数组/对象（`!==` 永不相等）；数组一律 `JSON.stringify` 或 `length === 0`。
 *  - 断言「**没有**发生」之前先让正对照证明探针能观测到「发生」。
 *  - 涉及墙钟的判据优先**结构性**：只有「≤15s 内被推进」这一条必须用墙钟（它**就是** §9.4 的判据），
 *    其余一律按 `version` / 顺序 / 成员集合断言；**没有**「sleep 1s 再看状态」。
 *
 * ⚠️ **海森堡**：Redis 只**读**（`ZRANGE`/`ZCARD`/`HGETALL`/`GET`），不做任何写；§9.8 管的是
 * 「下发给客户端的消息」，测试读服务端内部键**不**违反它（反过来：内部 `botId` 正是客户端拿不到的）。
 *
 * ⚠️ 两处**执行期事实**（与计划文本的字面写法有差异，已在汇报里写明；不是放宽断言）：
 *  a) ⚠️ 片① R1 之后**不再成立**：起始座位是随机的 ⇒ 本切片的第 1 组不再能假定
 *     「人类在自己的**首个**回合决策」。行动者一律从视图读（`:458` 的轮询本来就这么做），
 *     但第 1 组的**判别力**随之减弱（测的窗口可能早于人类的首个决策）—— 记在规格 §5.7。
 *  b) 「人类全程 pass」在**首出**（窗口里没有出牌项）时被规则禁止（§6.2-2/C18）
 *     ⇒ 第 3 组在首出时打**最小单张**，其余一律 pass。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DOUZERO_2, ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, fieldSetViolations, info, sleep, step } from '../lib/assert';
import { HarnessClient } from '../lib/client';
import { DOUZERO_URL, getJson, registerUser, type HarnessUser } from '../lib/http';
import { danglingMembers, idempotentAcquireViolations } from '../lib/pool-idempotency';
import { ROBOT_RPC, rpcCall } from '../lib/rpc';
import {
  checkRecentWindow,
  currentView,
  mustAdvance,
  pickHumanAction,
  readRoomBots,
  sendThrottled,
  tryAdvance,
  type PlayViewWire,
} from '../lib/ddz-driver';

/** 仓库根（`dist/slices/*.js` 与 `src/slices/*.ts` 同深度 ⇒ 同一个相对路径；R179）。 */
const REPO_ROOT = resolve(__dirname, '../../../..');

/** §9.6 / R201 的池键（键表 §10.1；S2 起规范玩法 id = `doudizhu`，旧 `ddz` 只读）。 */
const GAME_TYPE = 'doudizhu';
const POOL_KEY = `bot:pool:${GAME_TYPE}`;

/** §8.4②：单人等待窗口 30s + 扫描周期；给到 50s（与 `slice-07` 同口径）。 */
const MATCH_WINDOW_MS = 50_000;
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
/** §9.2/E9：机器人对外 id 与人类同构的**唯一**形状。 */
const DISPLAY_ID = /^p_[0-9A-Za-z]{8}$/;
/** §9.8 的机器人标记（与 `slice-07.2-hardening` 同集合）。 */
const BOT_MARKERS = ['bot-', 'isRobot', 'botId', 'skillLevel', 'thinkingSpeed'] as const;
/** 片② Task 9（J26）：`/health` 的清单必须**恰好**这两组名字（多一个/少一个都红）。 */
const DOUZERO_MODELS = ['sl', 'douzero_WP', 'douzero_ADP'] as const;
const DOUZERO_POSITIONS = ['landlord', 'landlord_down', 'landlord_up'] as const;
const ALL_STEPS = ['drive', 'play', 'finish', 'leak', 'pool', 'idem', 'douzero'] as const;
type StepId = (typeof ALL_STEPS)[number];

/**
 * 步骤选择器（`run.js` 是 **fail-fast**，一次跑只暴露第一条失败的断言）。
 * 未知 id 必须**在任何网络动作之前**抛错 —— 手误不能被当成「筛过了」。**门禁不带该变量**。
 */
function selectedSteps(): Set<StepId> {
  const raw = process.env.CONFORMANCE_STEPS;
  if (!raw) return new Set(ALL_STEPS);
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !(ALL_STEPS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new ConformanceError(
      `CONFORMANCE_STEPS 里有未知步骤：${unknown.join(', ')}（合法值：${ALL_STEPS.join(',')}）`,
    );
  }
  return new Set(ids as StepId[]);
}

// ───────────────────────── Redis 只读探针（照 `slice-07.2-deploy` 的 spawnSync 手法）─────────────

function redisCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { status: res.status, stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
}

function redisLines(args: string[]): string[] {
  const res = redisCli(args);
  if (res.status !== 0) {
    throw new ConformanceError(
      `redis-cli ${args.join(' ')} 失败（退出码 ${res.status}）：${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** `ZRANGE bot:pool:doudizhu 0 -1`（键不存在 ⇒ `[]`；§10.1 是 ZSET，不是 Set）。 */
function poolMembers(): string[] {
  return redisLines(['ZRANGE', POOL_KEY, '0', '-1']);
}

// ⚠️ **R207 的 `room:{code}:bots` 读法已抽到 `../lib/ddz-driver` 的 `readRoomBots`**
//    （② 金币场 T12：slice-11 与 slice-18 共用同一实现；行为逐字不变 —— 退出码非 0 ⇒ `{}`）。
//    这里**不**再留第二份：两处各抄一份必然漂移（R190①）。

/** `bot:{botId}` 的 `BotInstance` JSON（键不存在 ⇒ `null`）。 */
function botRecord(botId: string): any | null {
  const res = redisCli(['GET', `bot:${botId}`]);
  if (res.status !== 0) return null;
  const text = res.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** `EXISTS bot:{botId}` ⇒ 该机器人的**记录**是否还在（R231/R250②）。 */
function recordExists(botId: string): boolean {
  return redisLines(['EXISTS', `bot:${botId}`])[0] === '1';
}

// ⚠️ **P7/R360：谓词已抽到 `../lib/pool-idempotency` 作为唯一实现**（与 `slice-07.2-rpc` 第 6 组共用）。
//    理由：两处判的是**同一件事**（幂等 acquire 对池没有副作用），各留一份就是「同一事实的第二真源」。
//    谓词是纯函数 ⇒ 判别力自证（R115）仍可用合成输入完成，不需要往共享 Redis 里写东西。
//    ⚠️ **只共用谓词，不共用 Redis 探针外壳**：两处 `redisCli`/`poolMembers` 的签名与错误路径
//    语义不同（本文件由调用方判退出码；`slice-07.2-rpc` 退出码非 0 即抛），拉平会改掉
//    本文件第 5 组既有的错误路径语义（R360 明确不许为了共用而把两处语义拉平）。

// ───────────────────────────────── 通用小工具 ─────────────────────────────────

const readView = (message: any): PlayViewWire => message.payload as PlayViewWire;

// ⚠️ **`tryAdvance` / `mustAdvance` / `pickHumanAction` / `readRoomBots` 已抽到
//    `../lib/ddz-driver` 的共享实现**（② 金币场 T12；slice-11 与 slice-18 共用 —— R190①）。
//    本文件只保留 `readView`（`tryAdvance` 判定用的投影就在这里）与各场景自己的断言。
//    ⚠️ `tryAdvance` 的 `null` 返回值**就是**第 1/2 组的负对照：判据把「实测 elapsed」拼进
//    消息，让 RED 自证「不是超时兜底，而是根本没人推进」——语义逐字保留在驱动里。

/** §9.8 的扫描器（**只有一份实现**：探针正/负对照与实际扫描共用它）。 */
function botMarkers(raw: unknown): string[] {
  const text = JSON.stringify(raw ?? null);
  return BOT_MARKERS.filter((marker) => text.includes(marker));
}

/** §9.4 的「全程不得出现 system.error」探针（正/负对照与实际计数共用它）。 */
function countSystemErrors(received: ReadonlyArray<{ type: string }>): number {
  return received.filter((r) => r.type === 'system.error').length;
}

/**
 * 第 2 组的**形状**判据：机器人打出的一手必须合法。
 *
 * 协议 ④ 起判据落在**窗口最新一条**上（`observeRobotHand` 只在「最新一条 = 这次转移的动作
 * 且是机器人出牌」时才调它）：`cards` 非空、且窗口长度 ≤ 2。
 *
 * ⚠️ 旧实现还断言过 `lastPlayedHand` 的四条（`type ≠ 0`（Invalid）· `length ≥ 0` ·
 * `keyRank ∈ cards` · 单张 `keyRank === cards[0].r`）—— 协议 ④ 之后 `type`/`keyRank`/`length`
 * **不在出站面上**（只活在内部 RPC `RobotFeatures.lastMoveMeta` 里）⇒ 这四条在这里**没有输入**。
 * 它们是**等价迁移**到 `packages/game-service/test/view.builder.test.ts` 的单测（Task A4），
 * **不是删除**；⚠️ 2026-09-28 评审订正：那条单测**必须走生产代码**（真 `handlePlayCards` 跑一次
 * 转移 + `buildPlayerView` 跑投影）—— 上一版「自己塞字面量再断言」是**恒真断言**，已被换掉。
 * ⚠️ **不得**从 `cards` 反推 `type`/`length` 把它们补回来（玩法 §5 要点 / `play.ts:68`）。
 */
function checkRobotHand(view: PlayViewWire, violations: string[]): void {
  const w = view.recentActions;
  // Minor 4（2026-09-28 评审）：与 `ddz-driver` 的两个兄弟 helper（`checkRecentWindow` /
  // `checkPassOccupiesSlot`）同款守卫 —— `recentActions` 整体缺失时要**带文案的违例**，
  // 而不是裸 TypeError（后者在 conformance 里是一条说不清归因的失败）。
  if (!Array.isArray(w)) {
    violations.push(`v${view.version}: recentActions 不是数组（${JSON.stringify(w)}）`);
    return;
  }
  const newest = w[w.length - 1];
  const where = `v${view.version}（seat ${newest?.seat ?? '?'} 机器人出牌）`;
  if (w.length > 2) violations.push(`${where}: 窗口长度 ${w.length} > 2（协议 ④：窗口 = 2 手）`);
  if (!newest) {
    violations.push(`${where}: 判据说这一版是机器人出牌，但窗口是空的`);
    return;
  }
  if (newest.cards === null) {
    violations.push(`${where}: 判据说这一版是机器人出牌，但窗口最新一条是「不出」`);
    return;
  }
  if (!Array.isArray(newest.cards) || newest.cards.length === 0) {
    violations.push(`${where}: cards 必须非空，实际 ${JSON.stringify(newest.cards)}`);
  }
}

// ───────────────────────── 第 1–5 组：一局真实的「单人 + 2 机器人」 ─────────────────────────

interface GameScenario {
  client: HarnessClient;
  user: HarnessUser;
  roomCode: string;
  joinAck: any;
  /** ack 里**非人类**的三席（应为 2 个机器人；用于第 4 组的正对照）。 */
  robotDisplayIds: string[];
  humanSeat: number;
}

async function openFilledRoom(checks: Checks): Promise<GameScenario> {
  const user = await registerUser(0);
  const client = await HarnessClient.connect('S11', user);
  try {
    // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 15 = 缺省档。
    const ack = await sendThrottled(client, 'room.match', { mode: 'random', baseScore: 15 }, 0);
    checks.eq(ack.code, ErrCode.OK, '单人 room.match code');

    const matchedAt = Date.now();
    const matched = await client.waitFor('room.matched', MATCH_WINDOW_MS);
    const windowMs = Date.now() - matchedAt;
    const roomCode = matched.payload.roomCode as string;
    info(
      `补位窗口实测 ${(windowMs / 1000).toFixed(1)}s（§8.4②：30s 窗口 + 扫描 ≤5s；` +
        `slice-07 门禁实测 30.7s）—— roomCode=${roomCode}`,
    );

    const joinAck = await client.send('room.join', { roomCode });
    checks.eq(joinAck.code, ErrCode.OK, '单人 room.join code');
    const players = (joinAck.data?.players ?? []) as Array<{ id: string; seat: number }>;
    checks.eq(players.length, 3, '补位后房间恰好 3 席（§9.6）');
    const robotDisplayIds = players.filter((p) => p.id !== user.id).map((p) => p.id);
    checks.that(
      robotDisplayIds.length === 2,
      `本房恰好 2 个非人类席位（§9.6：1 人类 + 2 机器人）—— 实际 ${JSON.stringify(robotDisplayIds)}` +
        `（若只有 1 个，多半是匹配队列里残留了上一轮的人类票：清 \`match:queue:*\` 后重跑）`,
    );

    return {
      client,
      user,
      roomCode,
      joinAck,
      robotDisplayIds,
      humanSeat: joinAck.data?.seat as number,
    };
  } catch (err) {
    // R156：失败路径也必须收干净，否则泄漏的 socket 会把事件循环吊住。
    client.close();
    throw err;
  }
}

async function runGameScenario(checks: Checks, steps: Set<StepId>): Promise<void> {
  // 第 5 组的基线必须在**任何机器人动作之前**读（只读，不写）。
  const poolBefore = poolMembers();
  info(`开局前 ${POOL_KEY}（ZCARD=${poolBefore.length}）= ${JSON.stringify(poolBefore)}`);

  const scenario = await openFilledRoom(checks);
  const { client, user, roomCode, joinAck, robotDisplayIds, humanSeat } = scenario;
  const want = (id: StepId): boolean => steps.has(id);
  // 第 3/5 组都需要**整局打完**（池闭环以局终 release 为界）。
  // ⚠️ 第 4 组（§9.8 扫描）**不**强制打完：默认门禁跑里 `finish`/`pool` 已选中 ⇒ 扫的是整局；
  //    单独取 `CONFORMANCE_STEPS=leak` 的 RED 时扫「开局 + 叫抢」这一段（正对照「机器人对外 id」
  //    在 `room.join` ack 里就已可见）—— 单独跑不必等一局打完。
  const mustFinish = want('finish') || want('pool');

  try {
    const dealMsg = await client.waitFor('game.deal', 25_000);
    assertNoLeak(dealMsg.payload, 'game.deal(单人补位)');
    const dealView = readView(dealMsg);
    const dealAt = Date.now();
    checks.eq(dealView.seat, humanSeat, 'game.deal.seat 与 room.join ack.seat 一致');
    info(
      `game.deal：v${dealView.version} state=${dealView.state} ` +
        `currentBidder=${dealView.bidPhase.currentBidder} 人类 seat=${humanSeat} 手牌 ${dealView.hand.length} 张`,
    );

    // R207：room:{code}:bots（seat → 内部 botId）由 room-service 在 acquire 后写入、**局终删除**
    // ⇒ 必须在局中读（第 5 组用它证明「release 的是这一局的两个机器人」）。
    const roomBots = readRoomBots(roomCode);
    info(`room:${roomCode}:bots（R207）= ${JSON.stringify(roomBots)}`);

    let version = dealView.version;
    let humanBidOnce = false;

    // ── 第 1 组：§9.4 服务端驱动 ──────────────────────────────────────────
    if (dealView.bidPhase.currentBidder === humanSeat) {
      // ⚠️ 旧前提「人类坐 seat 0、`currentBidder` 初值 0 ⇒ 人类**必须**在自己的回合决策一次」
      // **已由片① R1 作废**（见文件头 ⚠️ a 的订正）：起始座位是随机的 ⇒ 本分支只在**恰好**
      // 轮到人类时成立，不再是必然。§9.4 约束的是**机器人**回合；此后人类再不动作才是本组的窗口。
      const bidAck = await sendThrottled(client, 'game.bid', { grab: true }, version);
      checks.eq(
        bidAck.code,
        ErrCode.OK,
        `人类在自己的**首个**叫抢回合决策一次（seat ${humanSeat}，grab=true ⇒ 保证有人抢、不流局）`,
      );
      version = (await mustAdvance(client, version, MECHANICS_TURN_MS, '人类自己的叫抢动作')).version;
      humanBidOnce = true;
    }

    if (want('drive')) {
      step(
        '第 1 组 §9.4：人类此后再不动作 ⇒ 机器人回合必须在 ≤15s 内被服务端推进' +
          '（旧实现只能等 30s 超时 ⇒ RED）',
      );
      const startedAt = Date.now();
      const advanced = await tryAdvance(client, version, DRIVE_WINDOW_MS);
      const elapsed = Date.now() - startedAt;
      const sinceDeal = Date.now() - dealAt;
      const observed = advanced
        ? `v${advanced.version} state=${advanced.state} currentBidder=${advanced.bidPhase.currentBidder}`
        : '（窗口内没有任何 game.state_update）';
      // 两段式①：先证明「30s 回合超时**未到**」—— elapsed 与「距 game.deal」都是实测值，
      // 拼进消息让 RED 自证：这不是超时兜底，而是根本没人推进。
      checks.that(
        elapsed < DRIVE_WINDOW_MS,
        `§9.4 服务端驱动：人类不再动作后，机器人在 ${elapsed}ms 内被推进（窗口 ${DRIVE_WINDOW_MS}ms；` +
          `距 game.deal 仅 ${sinceDeal}ms，30s 回合超时远未到 ⇒ 不是超时兜底）：${observed}`,
      );
      // 两段式②：再断言「已推进 / version 前进」。
      if (!advanced) {
        throw new ConformanceError(
          `§9.4：${DRIVE_WINDOW_MS}ms 内没有任何 game.state_update（实测 ${elapsed}ms，版本停在 v${version}）` +
            ' —— 机器人回合没有服务端驱动，只能靠 30s 超时兜底',
        );
      }
      checks.that(
        advanced.version > version,
        `version 前进 ${version} → ${advanced.version}（§9.4：机器人动作同样计入状态转移）`,
      );
      version = advanced.version;
    }

    // ── 机制：把叫抢推到 playing（未修栈上机器人回合只受 30s 超时推动 ⇒ 用 MECHANICS_TURN_MS）────
    for (let guard = 0; guard < 12; guard += 1) {
      const view = currentView(client);
      if (view.state === 'playing') {
        version = view.version;
        break;
      }
      if (view.state !== 'bidding') {
        throw new ConformanceError(`叫抢阶段意外状态 state=${view.state}（v${view.version}）`);
      }
      if (view.bidPhase.currentBidder === humanSeat) {
        const grab = !humanBidOnce; // 首个回合 grab=true（保证定地主），其余 pass
        const ack = await sendThrottled(client, 'game.bid', { grab }, view.version);
        checks.eq(ack.code, ErrCode.OK, `叫抢：人类回合决策（seat ${humanSeat}，grab=${grab}）`);
        humanBidOnce = true;
        version = (await mustAdvance(client, view.version, MECHANICS_TURN_MS, '人类叫抢动作')).version;
      } else {
        version = (
          await mustAdvance(
            client,
            view.version,
            MECHANICS_TURN_MS,
            `机器人叫抢回合（seat ${view.bidPhase.currentBidder}）`,
          )
        ).version;
      }
      if (guard === 11) throw new ConformanceError('叫抢在 12 次决策内没有进入 playing');
    }
    const playingView = currentView(client);
    if (playingView.state !== 'playing') {
      throw new ConformanceError(`叫抢没有进入 playing（state=${playingView.state}）`);
    }
    info(
      `进入 playing：v${playingView.version} 地主 seat=${playingView.landlordSeat}` +
        `（人类 ${playingView.landlordSeat === humanSeat ? '是' : '不是'}地主）`,
    );

    // ── 第 2/3 组：出牌阶段 ───────────────────────────────────────────────
    const robotHands: string[] = [];
    const caliberViolations: string[] = [];
    /**
     * 本局**人类出牌**的窗口观测次数（对称判据：协议 ④ 的窗口对两侧行动者都成立）。
     * ⚠️ Minor 3（2026-09-28 评审）：它**进断言**（下面的 `checks.atLeast`）—— 只写进收口消息
     * 的话，一局「人类一张牌都没出」会让这条对称覆盖**空转**而本片仍绿。
     */
    let humanWindowObservations = 0;
    let robotTurns = 0;
    let humanActions = 0;
    let strictWindowDone = false;
    let finished: { winner: string; at: number } | null = null;
    const playStartedAt = Date.now();
    /**
     * 机制上界：`mustFinish`（第 3/4/5 组要整局）⇒ 第 3 组的 300s 判据；
     * 否则只等「第 2 组要的第一手机器人出牌」⇒ 60s 就够（超了就 **break** 让第 2 组的收口断言去红，
     * 而不是在这里抛第 3 组的错 —— 逐步取证时 RED 必须归到**被选中的那一组**）。
     */
    const loopDeadline = playStartedAt + (mustFinish ? GAME_DEADLINE_MS : 60_000);

    for (let guard = 0; guard < 400; guard += 1) {
      const fin = client.last('game.finished');
      if (fin) {
        finished = { winner: fin.payload?.winner as string, at: Date.now() };
        break;
      }
      // 机制：不需要打完且第 2 组已拿到「至少一手机器人出牌」⇒ 收工（省时，不影响判据）。
      if (!mustFinish && (!want('play') || (strictWindowDone && robotHands.length > 0))) break;
      if (Date.now() > loopDeadline) {
        // ⚠️ **不在这里抛**：逐步取证（`CONFORMANCE_STEPS`）时 RED 必须归到**被选中的那一组**。
        // 直接跳出循环，让第 2/3/4/5 组各自的收口断言去红（没被选中的组不会下断言）。
        break;
      }

      const view = currentView(client);
      if (view.state === 'ended') {
        // 终局版本（N17）：这一版的 `game.state_update` 与 `game.finished` 来自**同一次**状态转移，
        // 两者之间有到达间隙 ⇒ 已经看到 ended 就等 `game.finished`，**不能**再往下发动作。
        const other = client.last('game.finished');
        if (other) {
          finished = { winner: other.payload?.winner as string, at: Date.now() };
        } else {
          try {
            const f = await client.waitFor('game.finished', 5_000);
            finished = { winner: f.payload?.winner as string, at: Date.now() };
          } catch {
            finished = null;
          }
        }
        break;
      }

      if (view.currentPlayer !== humanSeat) {
        // 机器人回合：机制窗口（未修栈 30s 超时兜底也能到）。
        let next: PlayViewWire | null = null;
        try {
          next = await mustAdvance(
            client,
            view.version,
            MECHANICS_TURN_MS,
            `机器人出牌回合（seat ${view.currentPlayer}）`,
          );
        } catch (err) {
          const fin3 = client.last('game.finished');
          if (fin3) {
            finished = { winner: fin3.payload?.winner as string, at: Date.now() };
            break;
          }
          throw err;
        }
        observeRobotHand(next, humanSeat, robotHands, caliberViolations);
        robotTurns += 1;
        continue;
      }

      // 人类回合。
      const action = pickHumanAction(view, humanSeat);
      const type = action.kind === 'play' ? 'game.play' : 'game.pass';
      const payload = action.kind === 'play' ? { cards: action.cards } : {};
      const ack = await sendThrottled(client, type, payload, view.version);
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(
          `人类动作被拒（§9.4：机器人走**完全相同**的校验链，人类动作必须合法）：` +
            `${type} ${JSON.stringify(payload)} → code=${ack.code} message=${JSON.stringify(ack.message)}`,
        );
      }
      if (!strictWindowDone && want('play')) {
        step(
          '第 2 组：人类出牌后机器人在 ≤15s 内**自行推进** + 每一手机器人出牌的窗口形状 + 全程无 system.error',
        );
        info(`人类动作：${action.kind} ${JSON.stringify(action.cards ?? [])}（${action.why}）`);
      }

      // ① 人类动作的**直接后果**：这一次转移是「人类一手」的产物，**不算**机器人推进。
      let afterHuman: PlayViewWire | null = null;
      try {
        afterHuman = await mustAdvance(
          client,
          view.version,
          strictWindowDone || !want('play') ? MECHANICS_TURN_MS : DRIVE_WINDOW_MS,
          '人类动作的直接转移',
        );
      } catch (err) {
        const fin4 = client.last('game.finished');
        if (fin4) {
          finished = { winner: fin4.payload?.winner as string, at: Date.now() };
          break;
        }
        throw err;
      }
      // 协议 ④ 的**对称**判据：人类自己出牌时，窗口最新一条也必须是这一手
      // （机器人侧由 observeRobotHand 查；两半合起来钉住「窗口最新一条 = 这次转移的动作」）。
      if (action.kind === 'play') {
        humanWindowObservations += 1;
        checkRecentWindow(afterHuman, action.cards!, humanSeat, caliberViolations);
      }

      observeRobotHand(afterHuman, humanSeat, robotHands, caliberViolations);
      humanActions += 1;

      if (afterHuman.state === 'ended') {
        // 人类这一手直接把对局打完（理论上只在终局手发生）⇒ 没有「下一次机器人转移」可等。
        strictWindowDone = true;
        continue;
      }

      if (strictWindowDone || !want('play')) continue;
      strictWindowDone = true;

      // ② 第 2 组的**严格窗口**：从「人类那一手」产生的版本起算，机器人必须自己在 ≤15s 内推进。
      const t0 = Date.now();
      const next = await tryAdvance(client, afterHuman.version, DRIVE_WINDOW_MS);
      const elapsed = Date.now() - t0;
      const observed = next
        ? `v${next.version} state=${next.state} currentPlayer=${next.currentPlayer}`
        : '（窗口内没有任何 game.state_update）';
      checks.that(
        elapsed < DRIVE_WINDOW_MS,
        `§9.4：人类出牌产生 v${afterHuman.version}（currentPlayer=${afterHuman.currentPlayer}）之后，` +
          `机器人在 ${elapsed}ms 内**自行**推进（窗口 ${DRIVE_WINDOW_MS}ms，30s 回合超时远未到）：${observed}`,
      );
      if (!next) {
        throw new ConformanceError(
          `§9.4 服务端驱动未落地：人类出牌产生 v${afterHuman.version} 之后，${DRIVE_WINDOW_MS}ms 内没有任何` +
            ` game.state_update（实测 ${elapsed}ms）—— 机器人回合只能靠 30s 超时兜底`,
        );
      }
      checks.that(
        next.version > afterHuman.version,
        `version 前进 v${afterHuman.version} → v${next.version}（机器人动作同样计入状态转移，§9.4）`,
      );
      checks.that(
        next.state === 'ended' ||
          (next.currentPlayer !== afterHuman.currentPlayer && next.currentPlayer !== humanSeat),
        `出牌权已从机器人 seat ${afterHuman.currentPlayer} 交给下一家` +
          `（currentPlayer=${next.currentPlayer}，人类 seat=${humanSeat}）`,
      );
      observeRobotHand(next, humanSeat, robotHands, caliberViolations);
      robotTurns += 1;
    }

    // ── 第 2 组收口：机器人出牌 + 合法性 + 无 system.error（带正/负对照）──────
    if (want('play')) {
      info(`本局观测到的机器人出牌（${robotHands.length} 手）：${robotHands.join(' | ') || '（无）'}`);
      checks.atLeast(robotHands.length, 1, '本局至少观测到 1 手机器人**出牌**（不只是 pass）');
      // ⚠️ 对称覆盖**也进断言**（Minor 3，2026-09-28 评审）：若本局人类一张牌都没出，
      //    `checkRecentWindow` 的人类侧分支一次都没跑 ⇒「窗口口径对**两侧**行动者都成立」
      //    在本局是**空转**的，而本片仍绿（此前恰好 = floor，零余量）。
      //    为什么是 atLeast 而不是 skip：① 它与机器人侧同一形态（见上一行）；
      //    ② 给本片留出余量；③ 实测（本局人类**不是**地主、最坏形态）22 次人类动作里
      //    16 次是出牌 —— 人类只在「面对单张且手里没有更大的牌」时 pass，实际几乎不发生。
      //    若它哪天真的红：消息自带读法（人类动作 N 次 / 观测 0 次），据实重新裁决，**不许**重跑碰运气。
      checks.atLeast(
        humanWindowObservations,
        1,
        `人类侧的窗口观测至少发生一次（否则上面那条对称覆盖在本局是空转）—— 本局人类动作 ${humanActions} 次`,
      );
      checks.that(
        caliberViolations.length === 0,
        `每一手机器人出牌的**窗口形状**（最新一条——即这次转移的动作——是出牌且 cards 非空、窗口 ≤ 2 手；` +
          `人类侧对称观测 ${humanWindowObservations} 次人类出牌；协议 ④ 起 type/keyRank/length 不在` +
          `出站面上，它们留在服务端的那半条口径由**走生产代码**的单测承担` +
          `（packages/game-service/test/view.builder.test.ts：handlePlayCards 跑转移 + buildPlayerView 跑投影））` +
          `${caliberViolations.length > 0 ? ` ⇒ ${caliberViolations.join(' | ')}` : ''}`,
      );
      // R212②/R115：断言「没有发生」之前先证明探针能观测到「发生」。
      checks.eq(
        countSystemErrors([{ type: 'system.error' }, { type: 'game.deal' }]),
        1,
        '探针正对照：system.error 计数器能观测到「发生」',
      );
      checks.eq(
        countSystemErrors([{ type: 'game.deal' }, { type: 'game.state_update' }]),
        0,
        '探针负对照：正常 S→C 消息不会被误计为 system.error',
      );
      const errors = countSystemErrors(client.received);
      checks.eq(
        errors,
        0,
        `全程不得出现 system.error（§9.1-1 的服务端驱动下客户端不应收到任何系统错误；实际 ${errors} 条：` +
          `${JSON.stringify(client.received.filter((r) => r.type === 'system.error').map((r) => r.message))}）`,
      );
    }

    // ── 第 3 组：一局能被机器人推进到结束 ─────────────────────────────────
    if (want('finish')) {
      step('第 3 组：人类全程 pass（首出打最小单张）⇒ 对局必须在有限时间内以 game.finished 收束');
      if (!finished) {
        const v = currentView(client);
        throw new ConformanceError(
          `第 3 组：对局在 ${GAME_DEADLINE_MS / 1000}s 内没有收束（v${v.version} state=${v.state} ` +
            `currentPlayer=${v.currentPlayer} 地主 seat=${v.landlordSeat}，已观测 ${robotTurns} 个机器人回合 + ` +
            `${humanActions} 次人类动作）—— 旧实现每个机器人回合都要等 30s 超时，几乎不可能在门禁时间内打完`,
        );
      }
      checks.that(
        finished.winner === 'landlord' || finished.winner === 'farmer',
        `game.finished.winner 合法（实际 ${JSON.stringify(finished.winner)}）`,
      );
      const totalMs = finished.at - playStartedAt;
      info(
        `对局从进 playing 到 game.finished 用时 ${(totalMs / 1000).toFixed(1)}s；` +
          `人类动作 ${humanActions} 次，服务端推进的机器人回合 ${robotTurns} 次（§9.4：客户端不参与机器人回合）`,
      );
      checks.that(
        totalMs < GAME_DEADLINE_MS,
        `对局在 ${GAME_DEADLINE_MS / 1000}s 内被推进到 game.finished（实测 ${(totalMs / 1000).toFixed(1)}s，` +
          `winner=${finished.winner}，机器人回合 ${robotTurns} 次）—— 旧实现每个机器人回合等 30s 超时`,
      );
      checks.that(
        robotTurns > humanActions,
        `机器人推进的回合数多于人类动作数（${robotTurns} > ${humanActions}）—— 这一局主要是**服务端**在打` +
          '（§9.4；人类只在自己的回合出手）',
      );
    }

    // ── 第 4 组：§9.8 泄漏扫描（扩展）────────────────────────────────────
    if (want('leak')) {
      step('第 4 组 §9.8：整局**每一条** S→C 消息 + `GET /api/rooms` + `room.join` ack 都不得含机器人标记');
      // R212②：扫描器只有一份实现 ⇒ 正/负对照直接证明实际扫描用的就是它。
      checks.eq(
        botMarkers({ id: 'bot-deadbeef', isRobot: true, botId: 'x', skillLevel: 'beginner', thinkingSpeed: 2000 }).length,
        BOT_MARKERS.length,
        `探针正对照：扫描器能识别全部 ${BOT_MARKERS.length} 种标记`,
      );
      checks.eq(
        botMarkers({ roomCode, seat: 1, hand: [3, 4] }).length,
        0,
        '探针负对照：干净的 PlayerView 不命中任何标记',
      );

      const rooms = await getJson<unknown[]>('/api/rooms', user.accessToken);
      checks.eq(rooms.status, 200, 'GET /api/rooms（§9.8 扫描面之一）的 HTTP 状态');
      const scanned: Array<[string, unknown]> = [
        ...client.received.map((m, i) => [`S→C #${i} ${m.type}`, m.message] as [string, unknown]),
        ['room.join ack', joinAck],
        ['GET /api/rooms 的 data', rooms.body?.data],
      ];
      info(
        `扫描 ${scanned.length} 条载荷（整局 S→C ${client.received.length} 条：` +
          `${client.received.map((m) => m.type).join(', ')}）`,
      );
      checks.atLeast(
        scanned.length,
        6,
        '扫描面非空（整局消息 + ack + REST；列表为空/过少时「零命中」是假绿 —— R115）',
      );
      const offenders = scanned
        .map(([label, payload]) => [label, botMarkers(payload)] as const)
        .filter(([, hits]) => hits.length > 0)
        .map(([label, hits]) => `${label} → ${hits.join(',')}`);
      checks.that(
        offenders.length === 0,
        `出站载荷里不得出现 ${BOT_MARKERS.join(' / ')}（命中：${offenders.join('；') || '无'}）`,
      );
      // §6.4 规则 4：`game.*` 载荷是 `PlayerView`，`players` / `actionLog` / `deck` 同样不许出现。
      for (const m of client.received) {
        if (m.type.startsWith('game.')) assertNoLeak(m.message, `S→C ${m.type}`);
      }
      checks.ok('整局 game.* 载荷均通过 assertNoLeak（§6.4 规则 4：无 actionLog / players / isRobot / botId）');

      // 正对照：机器人的**对外 id** 必须存在且与人类同构（§9.2/E9）—— 它同时证明本房真有机器人。
      checks.eq(robotDisplayIds.length, 2, `room.join ack 里有 2 个非人类 id：${JSON.stringify(robotDisplayIds)}`);
      const badIds = robotDisplayIds.filter((id) => !DISPLAY_ID.test(id) || id.startsWith('bot'));
      checks.that(
        badIds.length === 0,
        `机器人的对外 id 形如 \`p_<8位>\`（§9.2/E9；正对照证明本房确实有机器人、且 id 不可区分）：` +
          `实际 ${JSON.stringify(robotDisplayIds)}，违规 ${JSON.stringify(badIds)}`,
      );
      info(`人类 id=${user.id}；机器人对外 id=${JSON.stringify(robotDisplayIds)}`);
    }

    // ── 第 5 组：§9.6 池闭环（R250：只断言**绝对**性质，与池的前置状态无关）────────
    if (want('pool')) {
      step(`第 5 组 §9.6：局终后机器人回池（ZSET ${POOL_KEY}）+ bot:{botId} 的 roomCode/seat 清空`);
      const poolAfter = poolMembers();
      const afterSet = new Set(poolAfter);

      // ⚠️ R250：池的 **ZCARD 只作 info，不作断言**。`poolAfter - poolBefore` 那个**相对量**
      //    与「本局新建了几个」不是同一个命题 —— 池不是静止的（`release` 是 `void` 异步的、
      //    `reclaimIdle` 每 60s 一趟、手工 `DEL bot:pool:doudizhu` 与晚到的 release 之间有竞态，
      //    别的切片/用例也会留下成员）⇒ 那条等式实际断言的是「没有别人动过池」。
      info(
        `池计数（**只作 info，不作断言**，R250）：ZCARD ${poolBefore.length} → ${poolAfter.length}；` +
          `成员 ${JSON.stringify(poolBefore)} → ${JSON.stringify(poolAfter)}`,
      );

      // 本局两个机器人的**内部 botId**：客户端拿不到（§9.8 禁止下发），但 `bot:{botId}` 记录里有
      // `displayId`，而 `displayId` 正是 `room.join` ack 里的座位 userId（R207/§9.6 第 3 条）
      // ⇒ 在「池的前后成员」里按 displayId 反查即可，**不依赖** `room:{code}:bots` 的键名/形状。
      const candidates = [...new Set([...poolBefore, ...poolAfter])].slice(0, 40);
      const roomBotIds: string[] = [];
      for (const candidate of candidates) {
        const rec = botRecord(candidate);
        if (rec && robotDisplayIds.includes(rec.displayId)) roomBotIds.push(candidate);
      }
      info(
        `按 displayId 反查到本局机器人 ${JSON.stringify(roomBotIds)}（候选 ${JSON.stringify(candidates)}）`,
      );

      // ── ① 本局两个机器人都能被 `bot:{botId}.displayId` 对上（§9.6 归池的机械形态）──
      checks.eq(
        roomBotIds.length,
        2,
        `本局 2 个机器人都在「池的前后成员」里能被 \`bot:{botId}.displayId\` 对上（§9.6 归池的机械形态：` +
          `acquire 把它们取出池、release 把它们放回池；displayId=${JSON.stringify(robotDisplayIds)}）—— ` +
          `实际命中 ${JSON.stringify(roomBotIds)}（候选 ${JSON.stringify(candidates)}）`,
      );

      // ── ② 池索引自身的**绝对**不变式（R250②/R231/R232②）：每个成员都必须有记录 ──────
      // 与 `slice-07.2-rpc` 第 2 组**同源**（两处一起红/绿）；这里保留一条**同源**断言，
      // 因为本组是「§9.6 池闭环」的语义判据，读池时顺手钉住它的自洽性成本为零。
      checks.eq(
        danglingMembers(['bot-probe'], () => false).length,
        1,
        '探针正对照：谓词能把「索引里有、记录没有」的成员认成悬挂 —— 否则本条的「零悬挂」是空测（R115）',
      );
      checks.eq(
        danglingMembers(['bot-probe'], () => true).length,
        0,
        '探针负对照：记录存在时不得报悬挂（谓词不是「凡有成员就报」）',
      );
      const dangling = danglingMembers(poolAfter, recordExists);
      checks.that(
        dangling.length === 0,
        `池里**没有**悬挂成员（索引里有、\`bot:{id}\` 记录不存在）—— 悬挂 ${JSON.stringify(dangling)}；` +
          `池成员 ${JSON.stringify(poolAfter)}`,
      );

      // ── ③ 本局两个机器人都回到池里 + `bot:{botId}` 的绑定已清空 ─────────────
      const missing = roomBotIds.filter((id) => !afterSet.has(id));
      checks.that(
        missing.length === 0,
        `本局两个机器人都回到池里（§9.6 归池：release ⇒ ZADD bot:pool）—— 缺失 ${JSON.stringify(missing)}；` +
          `池成员 ${JSON.stringify(poolAfter)}`,
      );
      for (const botId of roomBotIds) {
        const rec = botRecord(botId);
        const cleared = rec === null || (rec.roomCode === null && rec.seat === null);
        checks.that(
          cleared,
          `bot:${botId} 的 roomCode/seat 已清空（或键不存在；R201/§9.6 归池）—— 实际 ${JSON.stringify(rec)}`,
        );
      }

      // R207：`room:{code}:bots`（Hash，field=座位号 → value=内部 botId）由 room-service 在
      // acquire 后写入、局终删除。**读得到就用（并交叉校验）；读不到就跳过**（协调者 2026-09-15 指示）。
      const hashIds = Object.values(roomBots);
      if (hashIds.length === 2 && hashIds.every((id) => id.startsWith('bot-'))) {
        checks.that(
          hashIds.every((id) => roomBotIds.includes(id)),
          `R207 交叉校验：room:${roomCode}:bots 的两个内部 botId 与「按 displayId 反查」的结果一致 —— ` +
            `Hash=${JSON.stringify(roomBots)}，反查=${JSON.stringify(roomBotIds)}`,
        );
      } else {
        info(
          `⚠️ 跳过 R207 的 room:${roomCode}:bots 判据：局中读到的内容是 ${JSON.stringify(roomBots)}` +
            '（期望 Hash 有 2 条 seat → `bot-…`）；本组其余判据改由「池成员 + bot:{botId}.displayId」承担',
        );
      }
    }
  } finally {
    client.close();
    // R155：与 slice-07/08/09/10 同规矩 —— 换房/换切片前让 disconnect 的 ZREM 落地。
    await sleep(400);
  }
}

/**
 * 第 2 组的观测：**这一次转移**（`next`）的窗口最新一条**就是**它的动作 ——
 * 若那条是**出牌**且出牌者不是人类 ⇒ 记一手机器人出牌并跑形状判据。
 *
 * 为什么按「窗口最新一条」归属：协议 ④ 起 `PlayerView` 不再有 `lastPlayedHand` /
 * `lastPlayerIdx`（都退役了）。窗口=2、每次状态转移由 `actionLog` 追加**恰好一条**
 * （`projectRecentActions` 是唯一投影）⇒ `recentActions` 的**最后一条**就是这次转移的动作，
 * 它的 `seat` 就是「这一手是谁打的」的在线来源。
 *
 * ⚠️ 为什么**不**比较 `JSON.stringify(prev.recentActions)`（计划 Task A4 的伪代码）：
 * 人类**过牌**的那次转移里窗口变了、但最新一条是「不出」，用「窗口变没变」当闸会把
 * 上一次转移里已经记过的机器人出牌**再记一遍**（同一手被记两次，且形状判据会对着
 * 「最新一条是『不出』」的视图误报）。「这一次转移的动作」比「窗口有没有变」更准，
 * 且**不需要** `prev`（`prev` 是旧契约 `lastPlayedHand` 比较的残留，已随之删除）。
 */
function observeRobotHand(
  next: PlayViewWire,
  humanSeat: number,
  hands: string[],
  violations: string[],
): void {
  // ⚠️ Minor 4 的守卫**这里也必须加**（2026-09-28 评审只点了 `checkRobotHand`，但那个守卫
  //    单独放着会**永远轮不到**）：`checkRobotHand` 由本函数调用，而**首次解引用**
  //    `recentActions` 的是下一行 ⇒ `recentActions` 整体缺失时先崩的是这里（裸 TypeError）。
  //    记一条带文案的违例（收口断言 `caliberViolations.length === 0` 会红），与两个兄弟 helper 同款。
  if (!Array.isArray(next.recentActions)) {
    violations.push(`v${next.version}: recentActions 不是数组（${JSON.stringify(next.recentActions)}）`);
    return;
  }
  const newest = next.recentActions[next.recentActions.length - 1];
  if (!newest) return;
  if (newest.cards === null) return; // 这次转移的动作是「不出」⇒ 不是一手出牌（但「不出」占位本身由别的判据管）
  if (newest.seat === humanSeat) return; // 这一手是人类出的
  hands.push(`v${next.version} seat ${newest.seat} ${JSON.stringify(newest.cards)}`);
  checkRobotHand(next, violations);
}

// ───────────────────────── 第 6 组：幂等 acquire（TCP RPC，N20/P4 换载体）─────────────────────────

/**
 * 兼容三种响应形态：R220 的 `{ok,data:{bots}}` 信封、裸 `{bots}`、`{code,message,data:{bots}}`。
 *
 * ⚠️ P4（N20）之后这条通道是 **TCP RPC**（§4.2），响应就是 `RpcResult<RobotAcquireResponse>`
 * ⇒ 走第一种分支。后两种保留是因为本函数只做「取出 bots」，**不**承担判据 ——
 * 判据在下面的 `checks`（`ok === true` 与 bot 的形状）。
 */
function acquireBots(payload: unknown): any[] {
  const r = payload as any;
  if (Array.isArray(r?.data?.bots)) return r.data.bots as any[];
  if (Array.isArray(r?.bots)) return r.bots as any[];
  return [];
}

async function runIdempotentAcquire(checks: Checks): Promise<void> {
  step(
    "第 6 组 R201：对同一 " +
      `\`{roomCode:'S11IDEM', seats:[1]}\` 调两次 \`${RPC_PATTERNS.robotAcquire}\`（直连 TCP ${ROBOT_RPC.port}）` +
      '⇒ 同一 bot + 绝对性质（窗口内不新增池成员 / 该 bot 不回池 / 无悬挂成员）',
  );
  info('载体变更（N20/P4 Task 6）：**直连 HTTP `POST /api/robots/acquire` 已被删除**（R218），');
  info(`  这条判据改走 \`rpcCall(ROBOT_RPC, RPC_PATTERNS.robotAcquire, …)\` —— 断言口径**不弱化**：`);
  info('  旧的 `HTTP 200` 换成 `ok === true`，`first.body.bots` 换成 `first.data.bots`（同一份 §4.2 DTO）。');
  info('  修前（旧栈）形态：`RPC 传输层故障（ECONNREFUSED）：localhost:3105 …`（3105 无 connectMicroservice）。');
  const body = { roomCode: 'S11IDEM', seats: [1] };

  const first = await rpcCall<{ bots: any[] }>(ROBOT_RPC, RPC_PATTERNS.robotAcquire, body);
  info(`第 1 次 acquire：ok=${first.ok} raw=${JSON.stringify(first).slice(0, 300)}`);
  checks.that(
    first.ok,
    `第 1 次 acquire 必须 ok=true（TCP ${ROBOT_RPC.port}；旧实现无 RPC 监听 ⇒ ECONNREFUSED）—— 实际 ${JSON.stringify(first)}`,
  );
  if (!first.ok) {
    throw new ConformanceError(`第 6 组前置失败：acquire 没有返回信封成功（${JSON.stringify(first)}）`);
  }
  const bots1 = acquireBots(first);
  checks.eq(
    bots1.length,
    1,
    `第 1 次 acquire 返回 1 个机器人（§4.2 RobotAcquireResponse.bots）：实际 ${JSON.stringify(bots1)}`,
  );
  if (bots1.length === 0) {
    throw new ConformanceError(
      `第 6 组前置失败：acquire 没有返回机器人（ok=${first.ok}，原始响应 ${JSON.stringify(first)}）`,
    );
  }
  const bot1 = bots1[0];
  checks.that(
    typeof bot1.botId === 'string' && bot1.botId.startsWith('bot-'),
    `内部 botId 形如 \`bot-<uuid8>\`（R207/E9；这是服务间响应，不是 S→C 消息）：${JSON.stringify(bot1.botId)}`,
  );
  checks.that(
    DISPLAY_ID.test(String(bot1.displayId)) && !String(bot1.displayId).startsWith('bot'),
    `对外 displayId 与人类同构 \`p_<8位>\`（§9.2/E9）：${JSON.stringify(bot1.displayId)}`,
  );
  checks.eq(bot1.roomCode, 'S11IDEM', 'BotInstance.roomCode 由 robot-service 写入（§9.6 第 2 条）');
  checks.eq(bot1.seat, 1, 'BotInstance.seat 由 robot-service 写入（§9.6 第 2 条）');

  const poolAfterFirst = poolMembers();
  info(`第 1 次 acquire 后 ${POOL_KEY}（ZCARD=${poolAfterFirst.length}）= ${JSON.stringify(poolAfterFirst)}`);

  // ⚠️ R253/R340：**旧等式已删** —— `checks.eq(poolAfterSecond.length, poolAfterFirst.length, …)`
  //    是**相对量**：它实际断言的是「我这两次读池之间没有第三方动过池」
  //    （`releaseRobots()` 是 `void` 异步、`reclaimIdle()` 每 60s 一次、跨运行的晚到 `release`
  //    也会落地 —— P3 实测 robot-service 日志里有非本次运行的补位局与 release 交错，
  //    把 `ZCARD` 从 2 抬到 4 ⇒ 假红），而它对「池退化成 0 / 容量静默丢失 / 幽灵成员」
  //    **完全免疫**（那正是 N22 藏很久的原因；P3 教训第 2 条）。
  //    ⇒ 换成下面的**绝对性质**谓词（`idempotentAcquireViolations`），窗口 = 第 2 次 acquire 本身。

  // ── 绝对性质（R253/R312）：窗口 = 第 2 次 acquire 本身，不是「读 1 → 读 2」─────────
  //    窗口左端**必须**紧贴这次 acquire 读（读在 `rpcCall` 之前一行），否则窗口会横跨
  //    「我两次 acquire 之间的调度/IO 间隙」，那正是旧等式假红的来源（R341 实测：
  //    同一份观测值下宽窗口报 1 条违规、窄窗口 0 条）。
  const poolBeforeSecond = poolMembers();
  info(`第 2 次 acquire 前 ${POOL_KEY}（ZCARD=${poolBeforeSecond.length}）= ${JSON.stringify(poolBeforeSecond)}`);

  const second = await rpcCall<{ bots: any[] }>(ROBOT_RPC, RPC_PATTERNS.robotAcquire, body);
  info(`第 2 次 acquire：ok=${second.ok} raw=${JSON.stringify(second).slice(0, 300)}`);
  checks.that(second.ok, `第 2 次 acquire 必须 ok=true —— 实际 ${JSON.stringify(second)}`);
  if (!second.ok) {
    throw new ConformanceError(`第 6 组：第 2 次 acquire 没有返回信封成功（${JSON.stringify(second)}）`);
  }
  const bots2 = acquireBots(second);
  checks.eq(bots2.length, 1, `第 2 次 acquire 返回 1 个机器人：实际 ${JSON.stringify(bots2)}`);
  if (bots2.length === 0) {
    throw new ConformanceError(
      `第 6 组：第 2 次 acquire 没有返回机器人（ok=${second.ok}，原始响应 ${JSON.stringify(second)}）`,
    );
  }
  const bot2 = bots2[0];

  // ── 保留下来的既有断言（R201 的**最强**一条）：两次 acquire 是**同一个** bot ────────
  checks.eq(bot2.botId, bot1.botId, '两次 acquire 返回**同一个** botId（R201 幂等 ⇒ A7⑤「重试 1 次」的前提）');
  checks.eq(bot2.displayId, bot1.displayId, '两次 acquire 返回**同一个** displayId');
  // 片② Task 9：幂等命中 ⇒ 难度不变（D2；J5c 的**旁证**，主判据在 robot-service 的 vitest）。
  // ⚠️ 先钉「档位是合法值」：缺了这条，`undefined === undefined` 会让下面的等值断言空转（R115 同族）。
  checks.that(
    ['beginner', 'intermediate', 'advanced'].includes(bot1.skillLevel),
    `两次 acquire 的 bot 必须带合法难度档（否则等值断言会空转）—— 实际 ${JSON.stringify(bot1.skillLevel)}`,
  );
  checks.eq(bot2.skillLevel, bot1.skillLevel, '幂等命中 ⇒ 难度不变（片② D2）');

  const poolAfterSecond = poolMembers();
  info(
    `第 2 次 acquire 后 ${POOL_KEY}（ZCARD=${poolAfterSecond.length}）= ${JSON.stringify(poolAfterSecond)}` +
      `（**只作 info，不作相对量断言**：R253 之后池计数的增减不是判据）`,
  );

  // ── 判别力自证（R115）：同一个纯谓词喂合成坏输入，必须逐条报违规 ────────────────
  //    每条坏输入**只**触发一条违规（不要同时改成员集合与记录存在性，否则「抓到了」
  //    可能来自另一条分支 —— 那是空测）。
  const probeAdded = idempotentAcquireViolations(
    ['bot-probe-a'],
    ['bot-probe-b'],
    'bot-probe-a',
    () => true,
  );
  const probeReturned = idempotentAcquireViolations(
    ['bot-probe-a'],
    ['bot-probe-a'],
    'bot-probe-a',
    () => true,
  );
  const probeDangling = idempotentAcquireViolations(
    ['bot-probe-a'],
    ['bot-probe-a'],
    'bot-probe-b',
    () => false,
  );
  const probeClean = idempotentAcquireViolations(
    [],
    [],
    'bot-probe-b',
    () => true,
  );
  checks.eq(
    probeAdded.length,
    1,
    '探针正对照①：窗口内**新增**成员（池大小不变、只换了一个）⇒ 谓词必须报违规 —— ' +
      `实际 ${JSON.stringify(probeAdded)}`,
  );
  checks.eq(
    probeReturned.length,
    1,
    '探针正对照②：被占用的 bot **回池** ⇒ 谓词必须报违规 —— ' + `实际 ${JSON.stringify(probeReturned)}`,
  );
  checks.eq(
    probeDangling.length,
    1,
    '探针正对照③：池成员缺 `bot:{id}` 记录 ⇒ 谓词必须报违规 —— ' + `实际 ${JSON.stringify(probeDangling)}`,
  );
  // ⚠️ 负对照的输入必须与三条正对照**都不同**：空窗口 ⇒ ①的「新增」为空集；
  //    `exists` 恒真 ⇒ ③的悬挂为空集；该 bot 不在 `after` ⇒ ②不成立。
  //    （若只把「窗口相同」当作负对照，它在「谓词恒不报②」时也过 ⇒ 那是空测。）
  checks.eq(
    probeClean.length,
    0,
    '探针**负**对照：空窗口（两次读都是空池、该 bot 不在池）⇒ 谓词不得报违规' +
      '（否则判据恒红）—— ' + `实际 ${JSON.stringify(probeClean)}`,
  );

  // ── 实际判定：绝对性质（与上面四条探针**共用同一个谓词** ⇒ 判别力已被自证）──────
  const violations = idempotentAcquireViolations(
    poolBeforeSecond,
    poolAfterSecond,
    String(bot2.botId),
    recordExists,
  );
  checks.that(
    violations.length === 0,
    '第二次 acquire 的**绝对性质**必须全部成立（R253/R312；**不是**比较池计数）：' +
      '①窗口内**没有新增**池成员；②第 2 次 acquire 的 bot **不得回池**（它被占用中）；' +
      `③池里每个成员都必须有 \`bot:{id}\` 记录（悬挂为 0）—— 违规 ${violations.length} 条：` +
      `${violations.join('；') || '无'}（窗口 ${JSON.stringify(poolBeforeSecond)} → ` +
      `${JSON.stringify(poolAfterSecond)}；两次 acquire 之间池计数可因第三方写入而变，那不是判据）`,
  );
}

// ───────────────── 场景 C：DouZero 线协议（§9.3 双轨的 AI 半边）─────────────────

/**
 * 场景 C 钉的是 **robot-service ↔ DouZero 的线协议**，不是 AI 强度。
 *
 * ## 为什么必须有这一组（它会红的那个真缺陷）
 *
 * `DouZeroRequestBody.must_play` 曾**声明了却从不赋值**（`douzero.client.ts`）⇒ Python 侧
 * `server.py:150` 的 `data.get("must_play", True)` 恒取 `True` ⇒ `:174` 的
 * `rival_move = [] if must_play else last_move` 让**每一次调用都按「自由首出」**算合法动作集：
 * 手里**所有**牌都合法、且 **`[]`（过牌）不在其中** ⇒
 *   ① DouZero **结构上永远无法过牌**（`gen_moves()` 只产非空动作）；
 *   ② 跟牌时它可能挑出一手**压不上**的牌 ⇒ 被 game-service 当场拒
 *      （`Invalid move - cannot beat last hand`，实测 93/1371 ≈ 6.8%）⇒ **静默降级成规则引擎**
 *      ⇒ advanced 机器人频繁表现得和规则机器人一样笨。
 *
 * 单元判据（`packages/robot-service/test/douzero.client.test.ts`）钉的是**我方发出去的字节**；
 * 本组钉的是**对面怎么理解这些字节** —— 两半合起来才盖住那条接缝。任何一侧改了语义，这里红。
 *
 * ## 为什么只给 3 张牌
 *
 * 牌越少 ⇒ 合法动作集越小 ⇒ 判据越接近**唯一解**，越不依赖 DouZero 的策略偏好。
 * 本组**不**断言「它一定选哪一手」（那是 AI 强度问题，会把判据变成对模型的脆弱快照）。
 */
interface DouZeroRequest {
  position: string;
  hand: number[];
  bottom_cards: number[];
  last_move: number[];
  last_move_position: string;
  num_cards_left: Record<string, number>;
  played_cards_landlord: number[];
  played_cards_landlord_down: number[];
  played_cards_landlord_up: number[];
  card_play_action_seq: number[][];
  must_play: boolean;
}

async function askDouZero(body: DouZeroRequest): Promise<number[]> {
  const res = await fetch(`${DOUZERO_URL}/decide_play`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new ConformanceError(
      `DouZero 未就绪：POST ${DOUZERO_URL}/decide_play ⇒ HTTP ${res.status} ${res.statusText}`,
    );
  }
  const data = (await res.json()) as { action?: unknown };
  if (!Array.isArray(data.action)) {
    throw new ConformanceError(`DouZero 响应形状异常（缺 action 数组）：${JSON.stringify(data)}`);
  }
  return data.action as number[];
}

/**
 * 最小但完整的局面：`landlord_up` 手里只剩 `[3,4,5]`，桌上是 `landlord` 的一手。
 * `must_play` 由调用方给 —— 它正是本组要考的**唯一变量**。
 */
function douZeroProbe(lastMove: number[], mustPlay: boolean): DouZeroRequest {
  return {
    position: 'landlord_up',
    hand: [3, 4, 5],
    bottom_cards: [],
    last_move: lastMove,
    last_move_position: lastMove.length > 0 ? 'landlord' : '',
    num_cards_left: { landlord: 2, landlord_up: 3, landlord_down: 3 },
    played_cards_landlord: [],
    played_cards_landlord_down: [],
    played_cards_landlord_up: [],
    card_play_action_seq: [],
    must_play: mustPlay,
  };
}

export async function runDouZeroContract(checks: Checks): Promise<void> {
  // ── ① 跟牌 + 压不过 ⇒ **必须过牌**（合法动作集只有 `[[]]`，这是唯一解）──────
  const noBeat = await askDouZero(douZeroProbe([DOUZERO_2], false));
  checks.eq(
    noBeat.length,
    0,
    '① `must_play=false` + 压不过 ⇒ **必须返回 `[]`（过牌）**：`landlord_up` 手里 [3,4,5] ' +
      `压不过单张 2（rank ${DOUZERO_2}）、也没有炸弹 ⇒ 合法动作集只有过牌（唯一解）；` +
      `实际返回 ${JSON.stringify(noBeat)}`,
  );

  // ── ② 跟牌 + 压得过 ⇒ 结果**必须合法**（`[]` 或压得过的牌，不得返回压不过的）──
  const beat = await askDouZero(douZeroProbe([3], false));
  checks.that(
    beat.length === 0 || Math.max(...beat) > 3,
    '② `must_play=false` + 压得过 ⇒ 返回的要么是 `[]`（价值函数认为过牌更优 —— 合法）、' +
      '要么是一手**压得过**的牌；**不得**返回压不过的牌：桌上单张 3，' +
      `实际返回 ${JSON.stringify(beat)}`,
  );

  // ── ③ 对照：同一局面换成 `must_play=true` ⇒ **必然硬出一手压不过的牌** ──────
  // 这不是「再断言一次同一件事」：它与 ① 在**同一局面**上给出**不同结果**，
  // 正是「must_play 这一格必须传对」的可执行证据（本仓的负对照手法）。
  const forcedLead = await askDouZero(douZeroProbe([DOUZERO_2], true));
  checks.that(
    forcedLead.length > 0,
    '③ 对照：同一局面（压不过单张 2）在 `must_play=true` 下，服务按**自由首出**算合法动作集' +
      '（`[]` 不在其中）⇒ 它**必然**硬出一手压不过的牌 —— 与 ① 的结果**必须不同**；' +
      `实际返回 ${JSON.stringify(forcedLead)}`,
  );

  info(
    `DouZero 线协议读数：① 压不过+must_play=false ⇒ ${JSON.stringify(noBeat)} · ` +
      `② 压得过+must_play=false ⇒ ${JSON.stringify(beat)} · ` +
      `③ 压不过+must_play=true ⇒ ${JSON.stringify(forcedLead)}`,
  );

  // ── ④ J26（片②）：真栈 `/health` 三档齐备、**每档恰好**三个位置名 ──────────────────
  //    为什么单列：场景 C 的探针体**没有** `model` 字段、只走默认 WP ⇒ 缺 sl/ADP 在真栈上零判据；
  //    而 `/health` 是「坏 douzero 在生产**运行时**无声」的唯一机械防线（恒 200 ⇒ 编排层永远不知道）。
  //    ⚠️ 不能只断「每档 3 个位置」：名字重/缺的 body 长度齐 ⇒ 本断言绿，而门禁解析（按名称集合）
  //    会答 `models-incomplete` —— 必须按**名称集合**判（`fieldSetViolations` 的恰好语义）。
  //    ⚠️ 直连 douzero 只能**裸 fetch**：`getJson` 走网关、读不到它（douzero 不在网关路由表里）。
  const healthRes = await fetch(`${DOUZERO_URL}/health`, { signal: AbortSignal.timeout(15_000) });
  const health = (await healthRes.json()) as { status?: unknown; models?: Record<string, unknown> };
  checks.eq(healthRes.status, 200, 'J26：douzero /health 恒 200');
  const modelKeys =
    health.models && typeof health.models === 'object' && !Array.isArray(health.models)
      ? Object.keys(health.models)
      : [];
  const modelKeyViolations = fieldSetViolations(modelKeys, DOUZERO_MODELS);
  checks.that(
    modelKeyViolations.length === 0,
    `J26：/health.models 三档齐备（sl / douzero_WP / douzero_ADP **恰好**三个键）—— ` +
      `违规 ${modelKeyViolations.length} 条：${modelKeyViolations.join('、') || '无'}`,
  );
  for (const model of DOUZERO_MODELS) {
    const positions = health.models?.[model];
    const violations = Array.isArray(positions)
      ? fieldSetViolations(positions.map(String), DOUZERO_POSITIONS)
      : [`${model} 的位置清单不是数组：${JSON.stringify(positions)}`];
    checks.that(
      violations.length === 0,
      `J26：${model} 档恰好 landlord / landlord_down / landlord_up 三个名字 —— ` +
        `违规 ${violations.length} 条：${violations.join('、') || '无'}`,
    );
  }

  // ── ⑤ J33（片②）：不带 `model` ≡ 显式 `douzero_WP`（**响应逐字节相同**）────────────
  //    兼容面：旧 robot-service（不带 model）配新 douzero —— 缺省档写错整个兼容面就塌。
  //    ⚠️ 判别力来源：只比「两次响应相等」会被「缺省漂移到别的档、两次一起漂」骗过 ⇒ 夹具必须挑
  //    三档输出**已知不同**的局面（规格 §3 实测锚定：sl=[4] / WP=[3] / ADP=[5]），这里同时钉读数=[3]。
  const j33Payload = {
    position: 'landlord_up',
    hand: [3, 4, 5],
    bottom_cards: [],
    last_move: [5],
    last_move_position: 'landlord',
    num_cards_left: { landlord: 5, landlord_down: 5, landlord_up: 3 },
    played_cards_landlord: [],
    played_cards_landlord_down: [],
    played_cards_landlord_up: [],
    card_play_action_seq: [],
    must_play: true,
  };
  const postRaw = async (b: unknown): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${DOUZERO_URL}/decide_play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: await res.text() };
  };
  const noModel = await postRaw(j33Payload);
  const withModel = await postRaw({ ...j33Payload, model: 'douzero_WP' });
  checks.eq(noModel.status, 200, 'J33：不带 model 的请求 ⇒ 200');
  checks.that(
    noModel.text === withModel.text,
    'J33：不带 model 与显式 douzero_WP 的响应**逐字节相同**（缺省档 = WP）—— ' +
      `实际 ${JSON.stringify(noModel.text)} vs ${JSON.stringify(withModel.text)}`,
  );
  checks.that(
    JSON.stringify((JSON.parse(noModel.text) as { action?: unknown }).action) === '[3]',
    'J33：判别局面下 WP 档动作 = [3]（缺省档漂移 ⇒ 逐字节对比或本读数至少一条红）—— ' +
      `实际 ${noModel.text}`,
  );
  info(`J33 读数：不带 model / 显式 WP = ${JSON.stringify(noModel.text)} / ${JSON.stringify(withModel.text)}`);
}

// ───────────────────────────────── 入口 ─────────────────────────────────

export async function runSlice11(): Promise<Checks> {
  const checks = new Checks();
  // 未知步骤 id 必须**在任何网络动作之前**抛错（否则手误会被当成「筛过了」）。
  const steps = selectedSteps();
  const needGame = (['drive', 'play', 'finish', 'leak', 'pool'] as const).some((id) => steps.has(id));

  if (needGame) {
    step('场景 A：单人匹配 → 30s 补位 2 机器人 → 一局（§9.4 驱动 / §9.8 不可区分 / §9.6 池闭环）');
    await runGameScenario(checks, steps);
  }
  if (steps.has('idem')) {
    step('场景 B：幂等 acquire（R201；直连 robot-service）');
    await runIdempotentAcquire(checks);
  }
  if (steps.has('douzero')) {
    step('场景 C：DouZero 线协议（§9.3 双轨的 AI 半边；直连 douzero）');
    await runDouZeroContract(checks);
  }
  info(`步骤：${[...steps].join(',')}`);
  return checks;
}
