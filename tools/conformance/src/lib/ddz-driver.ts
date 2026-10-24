/**
 * slice-09 / slice-10 **共用**的牌局驱动（R190①）—— 两个切片各抄一份必然漂移。
 *
 * 这里只有「起房 → 叫抢到 playing → 每墩首出单张、两家过牌 → 打到分出胜负」的机械动作：
 *  - 驱动只用手牌 + 单张点数（`toInternalRank`，§10 的**值映射**，不是规则引擎）算动作，
 *    **不** import `@fight-the-landlord/shared` 的 `parseHand`/`canBeat` —— 那等于拿被测实现
 *    当裁判（R168）。
 *  - 步骤 id（`selectedSteps()` / `ALL_STEPS`）与场景主体留在各自切片文件里：步骤 id 是切片自己的。
 *
 * 逐字承接 slice-09 的执行期裁决（编号见各函数注释）：
 *  - **R155**：换房前先 `close()` 上一房的客户端并 `sleep(400)`（同一 IP 的并发 WS 上限 5）；
 *    `startFreshRoom` 抛出前先 `close()` 已连上的客户端（R156，否则失败路径泄漏的 socket 会把
 *    事件循环吊住 —— 切片 7.2 实测卡了 693s 直到被 SIGTERM）。
 *  - **R172**：终局手在未修栈上**不发** `game.state_update`（`finishTransition` 直接
 *    `saveSession` + `publishEnded`）⇒ 终局手必须走 `playFinalHand()`（等 `game.finished`），
 *    用「等更新版本」的 `playAndSync()` 会在终局手白等 8s **假红**（切片 10 的 N17 落地后
 *    终局那一版视图才会出现）。
 *  - **R174**：行动者一律按 `currentPlayer` 从 `bySeat` 取，不假定「客户端连接顺序 == 轮转顺序」。
 *  - **R175**：§5.4 的 WS 限额是**每个 socket 20 条 / 5 秒** ⇒ `sendThrottled()` 保证同一
 *    client 两条消息间 ≥ `MSG_INTERVAL_MS`。
 *  - **R176**：`Checks.eq` 用 `!==` 比较 ⇒ 不得用它比数组/对象。
 *  - **R177**：叫抢驱动每轮收口前必须 `syncAll` 再读下一轮的 `currentBidder`。
 */
import { ErrCode, type Card, type ClientMessageType } from '@fight-the-landlord/protocol';
import { assertNoLeak, Checks, ConformanceError, sleep } from './assert';
import { registerUser, type HarnessUser } from './http';
import { redisRaw } from './redis';
import { HarnessClient, type AckResult } from './client';

/** 驱动内部用它，同时 re-export 一次 —— 切片只需一个 import 源（R190①）。 */
export { sleep };

/**
 * 出站线格式的 `PlayerView`（§6.4）。只声明本用例真正读的字段。
 *
 * ⚠️ 协议 ④：`lastPlayedHand` / `lastPlayerIdx` 已退役，换成窗口 2 的 `recentActions`。
 * 读点一律走本文件的助手（`lastPlay`）；逐手的在线判据是
 * `checkRecentWindow`（刚出的一手 = 窗口最新一条）与 `checkPassOccupiesSlot`
 * （「不出」也占一手）。**规则字段**（`type`/`keyRank`/`length`）不在出站面上 ⇒
 * 在线判据的等价迁移落在 `packages/game-service/test/view.builder.test.ts` 的单测里。
 */
export interface PlayViewWire {
  roomCode: string;
  version: number;
  state: 'init' | 'bidding' | 'playing' | 'ended';
  seat: number;
  hand: Card[];
  cardCounts: [number, number, number];
  bottomCards: Card[] | null;
  landlordSeat: number | null;
  currentPlayer: number;
  /** 协议 ④：窗口 2、旧 → 新；「不出」是显式的 `cards: null`。 */
  recentActions: { seat: number; cards: Card[] | null }[];
  turnDeadlineAt: number;
  bidPhase: {
    currentBidder: number;
    bidMultiplier: number;
    landlordCandidate: number;
    grabActions: number;
    redealCount: number;
  };
  /** §8.2 的炸弹计数（切片 10 的结算倍数判据要读它）。 */
  playPhase: { bombCount: number };
  /** 仅 `state === 'ended'` 时有值（§4.2 / N17）。 */
  winner?: 'landlord' | 'farmer';
}

export const STEP_TIMEOUT_MS = 8000;
export const MATCH_TIMEOUT_MS = 25_000;
/**
 * `humans < 3` 时的匹配等待窗口（② 金币场 T12）：服务端要等满补位窗口
 * `BOT_FILL_WAIT_MS`=30s（自最早入队者起算）+ 扫描周期 ≤5s 才补机器人开局 ⇒
 * 50s 仍可能不够（三人成局实测定位在 30.7s；单人补位在 slice-07/11 实测同为 ~30s 级）
 * ⇒ 给到 60s（够一轮 30s + 两轮扫描，且对「谁也没开局」的情形仍是响亮失败）。
 */
export const MATCH_FILL_TIMEOUT_MS = 60_000;
/** 一局最多打多少墩（地主 20 张 / 农民 17 张；30 是「再卡死就是缺陷」的上界）。 */
export const MAX_TRICKS = 30;

/**
 * 驱动发 `room.match` 时带的底分（片规格 §2.4 协议②：必填，撮合键多了这一维）。
 *
 * 值取**档位表里最小的那档**（15 = 休闲场；2026-10-21 起服务端缺省也取表内最低档，
 * 但本驱动显式发送，不依赖服务端缺省）——
 * **不**在档位表里的值会被服务端拒成 `10001`（那就成了假红）。
 *
 * ⚠️ 它还是 slice-10 结算断言（`settlement.baseScore`）的**真源**：结算里的底分
 * 必须逐字等于撮合时发的这一档。⚠️ **导出的常量**、不要在两处各写一个字面量 ——
 * 断言读旧值 100 的那次教训（Task 3e）就是这个形态。
 */
export const MATCH_BASE_SCORE = 15;

/**
 * R175：同一 socket 两条消息之间的最小间隔（§5.4 是 20 条 / 5 秒 ⇒ 300ms 给到 16.7 条 / 5 秒）。
 *
 * 为什么需要它：一局「每墩 1 张」的地主胜要发 20 次 `game.play`，加上 `room.match` /
 * `room.join` / `game.bid` 就是 23 条 —— 实测第 18 墩直接拿到 `10006`（`Too many messages`）。
 * 轮转是三家轮流，所以这条节流几乎不拖慢总时长（三家的发送天然间隔 3 个动作）。
 */
export const MSG_INTERVAL_MS = 300;
const lastSentAt = new Map<HarnessClient, number>();

/** 发一条 C→S 消息，先保证与该 client 上一条消息间隔 ≥ `MSG_INTERVAL_MS`（R175）。 */
export async function sendThrottled(
  client: HarnessClient,
  type: ClientMessageType,
  payload: Record<string, unknown>,
  baseVersion: number,
): Promise<AckResult> {
  const wait = (lastSentAt.get(client) ?? 0) + MSG_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSentAt.set(client, Date.now());
  return client.send(type, payload, baseVersion);
}

export interface FreshRoom {
  roomCode: string;
  clients: HarnessClient[];
  /** seat → client：**轮转**的落点（R174：只按 `currentPlayer` 查它，不假定数组顺序）。 */
  bySeat: Map<number, HarnessClient>;
  /** 各家各自的发牌视图（叫抢起点；也是「本局牌值集合」的来源之一）；机器人座没有客户端。 */
  deals: PlayViewWire[];
}

/**
 * `startFreshRoom` 的启动参数化（② 金币场 T12 的驱动交付物）。
 *
 * ⚠️ 默认值 = **既有调用方的逐字行为**（`slice-08/09/10` 零改动：random / 15 / 3 真人）。
 *  - `humans < 3`：其余座位由**服务端的 30s 补位窗口**（`BOT_FILL_WAIT_MS`）补机器人
 *    ⇒ `room.matched` 会比三人成局晚 ~30–40s 到达（等待窗口随之上调，见 `matchWaitMs`）。
 */
export interface FreshRoomOptions {
  /** 撮合模式（默认 `'random'`）。`'gold'` 需要 `room.goldRoomEnabled` 已开且余额过门槛。 */
  mode?: 'random' | 'gold';
  /** 撮合底分（默认 `MATCH_BASE_SCORE`=15）。 */
  baseScore?: number;
  /** 真人数量（默认 3；1|2 时其余座位补机器人 —— 补位窗口 30s + 扫描 ≤5s）。 */
  humans?: number;
  /**
   * 预注册账号（② T12：金币局**先预充再入队** —— 资金面只认真人 userId，驱动内部
   * `registerUser` 造的账号无法在入队前拿到 ⇒ 切片把账号传进来）。长度必须 = `humans`
   * （缺省 = 驱动自行注册，既有调用方逐字不变）。
   */
  users?: HarnessUser[];
}

/**
 * 起一局真实的三人对局：入队 → `room.matched` → `room.join` → 等 `game.deal`。
 *
 * 逐字沿用 `slice-08-bidding.ts:69-109` 的实现（只把 `PlayerViewWire` 换成 `PlayViewWire`）：
 * ⚠️ 每次调用都必须用**新的账号**（同账号再次 `room.match` 会撞 `12009`）—— 缺省由本函数
 *    内部 `registerUser` 注册；需要**入队前预充**（金币场）就经 `options.users` 传入
 *    （② T12 扩展；既有的 3 真人调用方零改动）；
 * ⚠️ R156：`clients` 必须在 `try` **之外**声明，catch 才够得着它。
 * ⚠️ **补位窗口**（T12 扩展）：`humans < 3` 时服务端要等满 30s（`BOT_FILL_WAIT_MS`，
 *    自最早入队者起算）+ 扫描周期（≤5s）才补机器人开局 ⇒ 匹配等待窗口从 25s 上调到 60s
 *    （`MATCH_FILL_TIMEOUT_MS`）。三人成局不受影响（仍 25s）。
 */
export async function startFreshRoom(
  labelPrefix: string,
  options: FreshRoomOptions = {},
): Promise<FreshRoom> {
  const mode = options.mode ?? 'random';
  const baseScore = options.baseScore ?? MATCH_BASE_SCORE;
  const humans = options.humans ?? 3;
  const matchWaitMs = humans === 3 ? MATCH_TIMEOUT_MS : MATCH_FILL_TIMEOUT_MS;
  if (options.users && options.users.length !== humans) {
    throw new Error(`startFreshRoom：users 数量（${options.users.length}）必须等于 humans（${humans}）`);
  }
  const clients: HarnessClient[] = [];
  try {
    for (let i = 0; i < humans; i += 1) {
      const user = options.users?.[i] ?? (await registerUser(i));
      clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
    }
    for (const client of clients) {
      // ⚠️ 片规格 §2.4 协议②：`room.match` 的 `baseScore` 必填（撮合键第三维）—— 用最小档。
      const ack = await sendThrottled(client, 'room.match', { mode, baseScore }, 0);
      if (ack.code !== ErrCode.OK) {
        throw new Error(
          `${client.label} room.match code=${ack.code} message=${JSON.stringify(ack.message)}` +
            `（mode=${mode} baseScore=${baseScore} humans=${humans}）`,
        );
      }
    }
    const matched = await Promise.all(clients.map((c) => c.waitFor('room.matched', matchWaitMs)));
    const roomCode = matched[0]!.payload.roomCode as string;

    const bySeat = new Map<number, HarnessClient>();
    for (const [i, client] of clients.entries()) {
      const seat = matched[i]!.payload.seat as number;
      bySeat.set(seat, client);
      const ack = await sendThrottled(client, 'room.join', { roomCode }, 0);
      if (ack.code !== ErrCode.OK) throw new Error(`${client.label} room.join code=${ack.code}`);
    }

    const dealMsgs = await Promise.all(clients.map((c) => c.waitFor('game.deal', matchWaitMs)));
    return {
      roomCode,
      clients,
      bySeat,
      deals: dealMsgs.map((m) => m.payload as PlayViewWire),
    };
  } catch (err) {
    // R156：**失败路径也必须收干净**，否则 socket 吊住事件循环 ⇒ `run.js` 永不退出。
    for (const client of clients) client.close();
    throw err;
  }
}

/**
 * 取该客户端**最近一次**收到的裁剪视图（同步，不等待）。
 *
 * ⚠️ 不要用 `game.deal` 里那次快照去算后续动作的 `baseVersion` —— 版本已经往前走了，会拿到 `13004`。
 */
export function currentView(client: HarnessClient): PlayViewWire {
  const latest = client.last('game.state_update') ?? client.last('game.deal');
  if (!latest) throw new Error(`尚未收到任何 game.* 推送（client=${client.label}）`);
  return latest.payload as PlayViewWire;
}

/** 任一方的最新视图（一次状态转移对三家发**同一 version**，因此谁的最新视图都等价）。 */
export function firstView(room: FreshRoom): PlayViewWire {
  return currentView(room.clients[0]!);
}

/** 等一条 version **严格大于**给定值的裁剪视图。 */
export async function waitForNewerVersion(
  client: HarnessClient,
  version: number,
): Promise<PlayViewWire> {
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayViewWire).version > version,
  );
  return msg.payload as PlayViewWire;
}

/** 等该客户端拿到**恰好** `version` 那一版裁剪视图（可能已经在 `received` 里）。 */
export async function waitForVersion(
  client: HarnessClient,
  version: number,
): Promise<PlayViewWire> {
  const existing = [...client.received]
    .reverse()
    .find((r) => (r.message?.payload as PlayViewWire | undefined)?.version === version);
  if (existing) return existing.message.payload as PlayViewWire;
  const msg = await client.waitFor(
    'game.state_update',
    STEP_TIMEOUT_MS,
    (m: any) => (m.payload as PlayViewWire).version === version,
  );
  return msg.payload as PlayViewWire;
}

/** 等三家都拿到**同一个** version（deterministic baseVersion 的来源）。 */
export async function syncAll(room: FreshRoom, version: number): Promise<void> {
  await Promise.all(room.clients.map((c) => waitForVersion(c, version)));
}

/**
 * 等一条 version **严格大于** `version` 的裁剪视图（返回 `null` 表示窗口内没有）。
 *
 * 从 `slice-11-robot-system.ts` 的机制区**抽出的共享实现**（② T12；那里曾是文件内私有）。
 * 那里的 `null` 返回值**就是**判据的负对照：把「实测 elapsed」拼进消息，让 RED 自证
 * 「不是超时兜底，而是根本没人推进」。本驱动里的用途一分为二：机制推进（`MECHANICS_TURN_MS`
 * 上界）与 `null` 探测（`DRIVE_WINDOW_MS` 严格窗口）。
 */
export async function tryAdvance(
  client: HarnessClient,
  version: number,
  timeoutMs: number,
): Promise<PlayViewWire | null> {
  try {
    const msg = await client.waitFor(
      'game.state_update',
      timeoutMs,
      (m: any) => (m.payload as PlayViewWire).version > version,
    );
    return msg.payload as PlayViewWire;
  } catch {
    return null;
  }
}

/** 机制用：等一次状态转移，超时抛错（附房间/版本的上下文）。 */
export async function mustAdvance(
  client: HarnessClient,
  version: number,
  timeoutMs: number,
  what: string,
): Promise<PlayViewWire> {
  const next = await tryAdvance(client, version, timeoutMs);
  if (!next) {
    throw new ConformanceError(
      `${what}：${timeoutMs}ms 内没有 version > ${version} 的 game.state_update`,
    );
  }
  return next;
}

/**
 * R207：`room:{code}:bots`（Hash：seat → 内部 botId）—— **必须在局中读**。
 *
 * 该键由 room-service 在 `robot.acquire` 后写入（`fillBots`/`writeBotBindings`）、
 * **局终 DELETE**（`releaseRobots`，自注「晚读会静默取到空」）⇒ 局后读恒空。
 * 实现逐字取自 `slice-11-robot-system.ts:166-174`（② T12 抽共享；那里与 slice-18 都用它）。
 *
 * 失败语义与 slice-11 相同：`redis-cli` 退出码非 0（容器不在/连不上）⇒ 返回 `{}`
 * （由调用方按「局中读却空」判红，而不是在这里抛一条说不清归因的错）。
 */
export function readRoomBots(roomCode: string): Record<string, string> {
  const res = redisRaw(['HGETALL', `room:${roomCode}:bots`]);
  if (res.status !== 0) return {};
  const lines = res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < lines.length; i += 2) out[lines[i]!] = lines[i + 1]!;
  return out;
}

/**
 * 按**点数**取极值。
 *
 * R695 之后全系统只有 DouZero 一套编码 ⇒ 直接比 `c.r`，`toInternalRank` 已删除。
 * R696 之后入参是 `Card[]`（带花色）—— 返回值也是 `Card`，因为调用方要把它
 * **原样**作为 `game.play` 的载荷发出去（那是 `Card[]`，不是点数）。
 */
export function extremeByRank(hand: Card[], pick: 'min' | 'max'): Card {
  return hand.reduce((best, c) => {
    const cmp = c.r - best.r;
    if (pick === 'min') return cmp < 0 ? c : best;
    return cmp > 0 ? c : best;
  }, hand[0]!);
}

/** 只手牌 + 单张（不碰规则引擎）：返回**点数最小的能压过** `lead` 的那张牌。 */
export function smallestBeatingSingle(hand: Card[], lead: Card): Card | null {
  const candidates = hand.filter((c) => c.r > lead.r).sort((a, b) => a.r - b.r);
  return candidates[0] ?? null;
}

/** 人类动作策略的产物（`pickHumanAction` 的返回）。 */
export interface HumanAction {
  kind: 'play' | 'pass';
  cards?: Card[];
  why: string;
}

/**
 * 人类的动作策略（**不用规则引擎**：只在「首出」与「跟单张」两种最简单的情形下用值映射）。
 *
 * 实现逐字取自 `slice-11-robot-system.ts:300-322`（② T12 抽共享 —— 那里与 slice-18 的
 * 金币局都靠它把人类回合推到终局；两处各抄一份必然漂移，R190①）。
 *
 * - 首出（窗口里没有出牌项）：规则禁止过牌（§6.2-2/C18）⇒ 打**最小单张**；
 * - 跟着一张单张且能压过 ⇒ 打最小可压单张；
 * - 其余一律 pass（多张牌型的比较需要规则引擎 —— 那是被测实现，R168 不许拿它当裁判）。
 */
export function pickHumanAction(view: PlayViewWire, humanSeat: number): HumanAction {
  const hand = view.hand ?? [];
  // 协议 ④：跟牌目标从「窗口里最后一条**出牌**项」读（旧 `lastPlayedHand`/`lastPlayerIdx`
  // 的等价读点，`lastPlay` 一处实现）—— 两个读法：`null` ⇒ 首出；否则看 seat 与张数。
  const item = lastPlay(view);
  if (!item) {
    const card = extremeByRank(hand, 'min');
    return { kind: 'play', cards: [card], why: '首出（不能过牌）⇒ 最小单张' };
  }
  if (item.cards.length === 1 && item.seat !== humanSeat) {
    const beat = smallestBeatingSingle(hand, item.cards[0]!);
    if (beat !== null) return { kind: 'play', cards: [beat], why: '跟单张 ⇒ 最小可压单张' };
    return { kind: 'pass', why: '跟单张但压不过 ⇒ pass' };
  }
  return { kind: 'pass', why: '多张牌型/自己最后出牌 ⇒ pass' };
}

/**
 * 窗口里**最后一条出牌项**（`cards !== null`，跳过「不出」的项）—— 旧 `lastPlayedHand`
 * 的等价读点；`null` = 窗口里还没有人出过牌。
 *
 * 等价性（本片规格 §2.3 的不变式②）：「窗口里有非 null」⟺ `lastPlayedHand !== null`；
 * 本仓单测 `packages/shared/src/ddz/recent.test.ts` 把它钉在**每个中间态**上。
 * ⚠️ 返回的是新对象 ⇒ **不得**拿它去 `checks.eq`（R176：`!==` 比较），
 * 要比就比标量（如 `lastPlay(view)?.cards[0]?.r`）。
 */
export function lastPlay(view: PlayViewWire): { seat: number; cards: Card[] } | null {
  for (let i = view.recentActions.length - 1; i >= 0; i -= 1) {
    const a = view.recentActions[i]!;
    if (a.cards !== null) return { seat: a.seat, cards: a.cards };
  }
  return null;
}

/**
 * 协议 ④ 的**在线判据**（取代原 `checkSingleCaliber` 的线格式部分）：刚打完一手牌之后，
 * 窗口的**最新一条**必须**就是**那一手 —— 行动者、牌面逐张相等，且窗口长度 ≤ 2。
 *
 * ⚠️ **`type` / `keyRank` / `length` 不再在线可观测**：协议 ④ 之后它们是**规则字段**、
 * 不出站（只活在 `RobotFeatures.lastMoveMeta` 那个内部 RPC 上）。旧 C19 里
 * 「单张的规则字段正确」的口径是**等价迁移**到单测（`view.builder.test.ts`），不是删除。
 */
export function checkRecentWindow(
  view: PlayViewWire,
  played: Card[],
  actorSeat: number,
  violations: string[],
): void {
  const where = `v${view.version}`;
  const w = view.recentActions;
  if (!Array.isArray(w)) {
    violations.push(`${where}: recentActions 不是数组（${JSON.stringify(w)}）`);
    return;
  }
  if (w.length > 2) violations.push(`${where}: 窗口长度 ${w.length} > 2（协议 ④：窗口 = 2 手）`);
  const newest = w[w.length - 1];
  if (!newest) {
    violations.push(`${where}: 刚打出 ${JSON.stringify(played)}，但窗口是空的`);
    return;
  }
  if (newest.cards === null) {
    violations.push(`${where}: 刚打出 ${JSON.stringify(played)}，但窗口最新一条是「不出」（占位者 seat=${newest.seat}）`);
    return;
  }
  if (newest.seat !== actorSeat) {
    violations.push(`${where}: 窗口最新一条的 seat=${newest.seat}，行动者却是 ${actorSeat}`);
  }
  if (JSON.stringify(newest.cards) !== JSON.stringify(played)) {
    violations.push(
      `${where}: 窗口最新一条的 cards=${JSON.stringify(newest.cards)}，所出=${JSON.stringify(played)}`,
    );
  }
}

/**
 * 一次过牌**前后**的窗口不变式（协议 ④「窗口 = 最后 2 手」的直接推论，即本片规格
 * §2.3 不变式②的在线形态）：
 *
 *  - 过牌**不结束一墩**（过牌前窗口最新一条是**出牌**）⇒ 那一手必须**原样**留在窗口里
 *    （`seat` 与 `cards` 逐字不变）—— 「不出」占一手、但**不擦除**上一手；
 *  - 过牌**结束一墩**（过牌前窗口最新一条已经是「不出」⇒ 这一手是两次连续过牌中的第二次）
 *    ⇒ 窗口里**不得**再有任何出牌项（§6.2-5：出牌权回归，上一手作废）。
 *
 * 等式的推导只用投影的定义（`projectRecentActions` 取 `actionLog` 末两条、每次转移追加一条）：
 * 过牌后的窗口 = [过牌前的**最新**一条, 这一手过牌] ⇒ 非 null 项只可能来自过牌前那一条。
 */
export function checkPlaySurvivesPass(
  before: PlayViewWire,
  after: PlayViewWire,
  violations: string[],
): void {
  const where = `v${before.version} → v${after.version}`;
  const newestBefore = before.recentActions[before.recentActions.length - 1];
  const now = lastPlay(after);
  if (newestBefore && newestBefore.cards !== null) {
    if (!now) {
      violations.push(`${where}: 过牌不结束一墩，但过牌后窗口里没有出牌项（这一手被抹掉了）`);
      return;
    }
    if (now.seat !== newestBefore.seat || JSON.stringify(now.cards) !== JSON.stringify(newestBefore.cards)) {
      violations.push(
        `${where}: 过牌不结束一墩，上一手必须原样保留 —— 期望 seat ${newestBefore.seat} ${JSON.stringify(newestBefore.cards)}，` +
          `实际 seat ${now.seat} ${JSON.stringify(now.cards)}`,
      );
    }
    return;
  }
  // 过牌前最新一条是「不出」（或窗口为空）⇒ 这一手结束一墩（两次连续过牌）⇒ 出牌项必须已被挤出。
  if (now) {
    violations.push(
      `${where}: 两次连续过牌后窗口里仍有出牌项（seat ${now.seat} ${JSON.stringify(now.cards)}；§6.2-5 出牌权回归、上一手作废）`,
    );
  }
}

/**
 * 「**「不出」也占一手**」的在线判据（上位 §4.4 的用户逐字裁决）。
 *
 * 旧契约**根本表达不出**这件事（没有任何字段能说「谁刚过了牌」）⇒ 这是一条**新增**判据：
 * 刚过牌的那位必须出现在窗口**最新一条**里，且那一条的 `cards` 是显式的 `null`。
 *
 * 顺带钉住窗口长度 ≤ 2（「不出」占位后旧项被挤出 —— 窗口语义的机械形态）。
 */
export function checkPassOccupiesSlot(
  view: PlayViewWire,
  passerSeat: number,
  violations: string[],
): void {
  const where = `v${view.version}`;
  const w = view.recentActions;
  if (!Array.isArray(w)) {
    violations.push(`${where}: recentActions 不是数组（${JSON.stringify(w)}）`);
    return;
  }
  if (w.length > 2) violations.push(`${where}: 窗口长度 ${w.length} > 2（协议 ④：窗口 = 2 手）`);
  const newest = w[w.length - 1];
  if (!newest) {
    violations.push(`${where}: 有人过牌，但窗口是空的`);
    return;
  }
  if (newest.cards !== null) {
    violations.push(`${where}: 有人过牌，但窗口最新一条是出牌（${JSON.stringify(newest.cards)}）`);
    return;
  }
  if (newest.seat !== passerSeat) {
    violations.push(`${where}: 窗口最新一条的 seat=${newest.seat}，过牌者却是 ${passerSeat}`);
  }
}

/** 本房**开局 54 张**的点数集合（三家发牌 + 底牌）；R168 要求 `info` 打印它。 */
export function deckValues(room: FreshRoom): number[] {
  const values = new Set<number>();
  for (const deal of room.deals) for (const c of deal.hand) values.add(c.r);
  for (const client of room.clients) for (const c of currentView(client).bottomCards ?? []) values.add(c.r);
  return [...values].sort((a, b) => a - b);
}

/**
 * 三家**进 playing 时**的手牌（DouZero 值）。
 *
 * 这行必须在各场景 Point-of-no-return **之前**打印：失败时（例如 C16 的终局手超时）后面的
 * `info` 根本到不了，而没有它就说不清「这一跑到底有没有打出 DouZero `17`（2）」（C19 的覆盖度）。
 */
export function handsInfo(room: FreshRoom): string {
  return room.clients
    .map((c) => {
      const view = currentView(c);
      return `seat ${view.seat}=${JSON.stringify(view.hand)}`;
    })
    .join(' · ');
}

/** 打出一手并等三家同步到新版本。**只用于非终局手**（终局手见 `playFinalHand`，R172）。 */
export async function playAndSync(
  room: FreshRoom,
  actor: HarnessClient,
  cards: Card[],
  checks: Checks,
  what: string,
): Promise<PlayViewWire> {
  const before = currentView(actor);
  const ack = await sendThrottled(actor, 'game.play', { cards }, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（seat ${before.seat}）`);
  const next = await waitForNewerVersion(actor, before.version);
  await syncAll(room, next.version);
  return next;
}

/**
 * 过牌并等三家同步到新版本。
 *
 * `windowViolations`（可选）：传入则对**这次过牌的产物**跑两条协议 ④ 判据 ——
 * `checkPassOccupiesSlot`（「不出」也占一手、占位者 = 过牌者）与
 * `checkPlaySurvivesPass`（不结束一墩则上一手原样保留；结束一墩则必须已被挤出）。每一手
 * 过牌都该查，而**过牌者的座位**与**过牌前的窗口**只有本函数知道（R174）⇒ 检查放在这里，
 * 调用方只需把自己那本违例册递进来。
 */
export async function passAndSync(
  room: FreshRoom,
  actor: HarnessClient,
  checks: Checks,
  what: string,
  windowViolations?: string[],
): Promise<PlayViewWire> {
  const before = currentView(actor);
  const ack = await sendThrottled(actor, 'game.pass', {}, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（seat ${before.seat}）`);
  const next = await waitForNewerVersion(actor, before.version);
  await syncAll(room, next.version);
  if (windowViolations) {
    checkPassOccupiesSlot(next, before.seat, windowViolations);
    checkPlaySurvivesPass(before, next, windowViolations);
  }
  return next;
}

/**
 * 出**终局手**（把手里最后一张打完，R172）。
 *
 * ⚠️ 在**未修栈**上这一手**不会**有 `game.state_update`：§7 的结束路径在 `finishTransition` 里
 * 直接 `saveSession` + `publishEnded`（只发 `game.ended` ⇒ 客户端收到 `game.finished` +
 * `game.settlement`），**不**走 `publishSeatViews`。因此终局手**必须**等 `game.finished`，
 * 用 `playAndSync` 等「更新版本」会白等 8 秒然后**假红**（计划初稿的缺陷）。
 *
 * 连带事实（与 N17 互证）：局终的 `state = 'ended'` 视图在未修栈上**从不**下发，因此终局手的
 * 窗口口径（`checkRecentWindow`）在线不可观测 —— 未修栈上口径断言只覆盖非终局手
 * （场景 A 19 手 / 场景 B 15 手）。切片 10 的 N17 修好后终局那一版视图才出现（切片 10 断言它）。
 */
export async function playFinalHand(
  actor: HarnessClient,
  cards: Card[],
  checks: Checks,
  what: string,
): Promise<'landlord' | 'farmer'> {
  const before = currentView(actor);
  const ack = await sendThrottled(actor, 'game.play', { cards }, before.version);
  checks.eq(ack.code, ErrCode.OK, `${what}（终局手，seat ${before.seat}）`);
  const finished = await actor.waitFor('game.finished', STEP_TIMEOUT_MS);
  return finished.payload.winner as 'landlord' | 'farmer';
}

/**
 * 让**当前回合**的那位过牌（R174）。
 *
 * 轮转顺序由服务端的 `currentPlayer` 决定，**不**由客户端的连接顺序决定 —— 计划 Task 8 里
 * 「按 farmersA 顺序依次过牌」/「先地主再另一农民」的固定顺序在座位不巧时会发出
 * **非当前回合**的动作（`12003`）。
 *
 * `windowViolations` 语义同 `passAndSync`（协议 ④：「不出」占一手 + 占位者 = 过牌者）。
 */
export async function passCurrent(
  room: FreshRoom,
  checks: Checks,
  what: string,
  windowViolations?: string[],
): Promise<void> {
  const turn = firstView(room).currentPlayer;
  const actor = room.bySeat.get(turn);
  if (!actor) throw new ConformanceError(`${what}：currentPlayer=${turn} 没有对应客户端`);
  await passAndSync(room, actor, checks, what, windowViolations);
}

/**
 * 「1 抢 + 2 不抢」把一局从叫抢推到 `playing`（照 `slice-08` 按**服务端给的顺序**决策）。
 *
 * 收口断言用**同一个 version**：三家必须看到同一版 `playing` 视图（§6.2 / §6.4）。
 */
export async function playBiddingToPlaying(room: FreshRoom, checks: Checks): Promise<void> {
  let version = room.deals[0]!.version;
  // R177：第一次读 `currentBidder` 之前也要同步 —— `room.deals[0]` 只是**某一个**客户端的发牌视图。
  await syncAll(room, version);
  const grabs = [true, false, false];

  for (let round = 0; round < 3; round += 1) {
    const bidder = firstView(room).bidPhase.currentBidder;
    const actor = room.bySeat.get(bidder);
    if (!actor) throw new ConformanceError(`叫抢：currentBidder=${bidder} 没有对应客户端`);
    const grab = grabs[round]!;

    const ack = await sendThrottled(actor, 'game.bid', { grab }, version);
    checks.eq(ack.code, ErrCode.OK, `叫抢第 ${round + 1}/3 次决策：座位 ${bidder} game.bid(grab=${grab})`);

    const next = await waitForNewerVersion(actor, version);
    assertNoLeak(next, `game.state_update(叫抢第 ${round + 1} 次)`);
    version = next.version;
    // R177：`waitForNewerVersion` 只保证**行动者**拿到了新版，而下一次读 `currentBidder` 走的是
    // `firstView(room)`（clients[0]）—— 它可能还停在上一版 ⇒ 会对着**上一轮的叫抢者**发 `game.bid`，
    // 实测拿到 `12003`（`叫抢第 3/3 次决策：座位 1 game.bid(grab=false)：期望 0，实际 12003`）。
    // 因此每轮收口前必须让三家都到这一版再读下一轮的 `currentBidder`。
    await syncAll(room, version);

    if (round === 2) {
      checks.eq(next.state, 'playing', '第 3 次决策后进入出牌阶段');
      checks.eq(next.currentPlayer, next.landlordSeat, 'currentPlayer = 地主（§3.4-6）');
    } else {
      checks.eq(next.state, 'bidding', `第 ${round + 1} 次决策后仍在叫抢`);
    }
  }

  checks.that(
    room.clients.every((c) => currentView(c).state === 'playing'),
    `三家都拿到同一版 playing 视图（v${version}，deterministic baseVersion 的来源）`,
  );
}

/** `playFullGameToEnd` 的时长上界（含机器人局；机器人平均每手约 2s，纯机制常量，不是判据）。 */
export const FULL_GAME_DEADLINE_MS = 300_000;
/** 机器人回合的机制等待（同 slice-11 `MECHANICS_TURN_MS` 的角色：> 任何判据窗口、含 30s 超时兜底）。 */
const ROBOT_TURN_WAIT_MS = 40_000;

/** `playFullGameToEnd` 的收束产物（判据留在切片里；驱动只回事实）。 */
export interface FullGameOutcome {
  winner: 'landlord' | 'farmer';
  /** 人类动作（叫抢/出牌/过牌）总数 —— 各客户端之和。 */
  humanActions: number;
  /** 被服务端推进的机器人回合数（≥1 的手数——叫抢与出牌合计）。 */
  robotTurns: number;
}

/**
 * 把一局从 `game.deal` 驱到 `game.finished`（② 金币场 T12 的驱动交付物）。
 *
 * 适用形态：**人类客户端数 1–3 的任意组合**（机器人座无客户端、由服务端驱动）。
 * 与 `slice-11` 的第 2/3 组循环的差别：这里**不下断言**（判据留在切片里）、不测严格窗口，
 * 只做两件事 —— 轮到人类就按 `pickHumanAction` 出牌、轮到机器人就等服务器推进。
 *
 * 机械要点（都踩过）：
 *  - 行动者一律按 `currentPlayer`/`currentBidder` 从 `bySeat` 取（R174）；
 *  - **叫抢**：纳入的**第一个**人类决策一律 `grab=true`（必然定地主 ⇒ 免流局重发；
 *    之后的决策 `grab=false`）——同 slice-11 的单人策略，两个人类时不变量仍成立；
 *  - 每次转移后用 `syncAll` 把**所有**人类客户端对齐到同一 version 再读下一轮（R177 的两家版）；
 *  - `game.finished` 先到而 `state_update` 未到的间隙（R172/N17）按「顶环再查一次」处理；
 *  - **不 catch 编程错误**：人类动作被拒（非 0 ack）当场抛 —— 那说明输入非法或栈没起对。
 */
export async function playFullGameToEnd(
  room: FreshRoom,
  what: string,
  opts: { maxMs?: number } = {},
): Promise<FullGameOutcome> {
  const reader = room.clients[0]!;
  const maxMs = opts.maxMs ?? FULL_GAME_DEADLINE_MS;
  const deadline = Date.now() + maxMs;
  let version = firstView(room).version;
  let humanBidDone = false;
  let humanActions = 0;
  let robotTurns = 0;

  const finishedOn = (): any | undefined => {
    for (const c of room.clients) {
      const m = c.last('game.finished');
      if (m) return m;
    }
    return undefined;
  };
  /** 等一次推进；窗口内没有且也没收束 ⇒ 抛（收束则返回 null，顶环去取 winner）。 */
  const advanceAfter = async (
    fromVersion: number,
    timeoutMs: number,
    where: string,
  ): Promise<PlayViewWire | null> => {
    const next = await tryAdvance(reader, fromVersion, timeoutMs);
    if (!next && !finishedOn()) {
      throw new ConformanceError(
        `${what}：${where} 之后 ${timeoutMs}ms 内没有 version > ${fromVersion} 的 game.state_update`,
      );
    }
    return next;
  };

  for (let guard = 0; guard < 600; guard += 1) {
    const fin = finishedOn();
    if (fin) {
      return { winner: fin.payload?.winner as 'landlord' | 'farmer', humanActions, robotTurns };
    }
    if (Date.now() > deadline) {
      const v = currentView(reader);
      throw new ConformanceError(
        `${what}：对局在 ${maxMs}ms 内没有收束（v${v.version} state=${v.state} currentPlayer=${v.currentPlayer}，` +
          `人类动作 ${humanActions} 次 + 机器人回合 ${robotTurns} 次）`,
      );
    }

    // R177 的两家版：读状态之前把全部客户端对齐到同一 version。
    await syncAll(room, version);
    const view = currentView(reader);
    version = view.version;

    if (view.state === 'ended') {
      // N17：终局视图与 game.finished 是同一次转移的两个投递，之间有间隙 ⇒ 等它落地。
      const done = await reader.waitFor('game.finished', STEP_TIMEOUT_MS);
      return { winner: done.payload?.winner as 'landlord' | 'farmer', humanActions, robotTurns };
    }

    if (view.state === 'bidding') {
      const bidder = view.bidPhase.currentBidder;
      const actor = room.bySeat.get(bidder);
      if (!actor) {
        const next = await advanceAfter(view.version, ROBOT_TURN_WAIT_MS, `机器人叫抢回合（seat ${bidder}）`);
        robotTurns += 1;
        if (next) version = next.version;
        continue;
      }
      const grab = !humanBidDone; // 首个纳入的人类决策 grab=true ⇒ 必然定地主
      const ack = await sendThrottled(actor, 'game.bid', { grab }, view.version);
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(
          `${what}：叫抢决策被拒（seat ${bidder} grab=${grab}）code=${ack.code} message=${JSON.stringify(ack.message)}`,
        );
      }
      humanBidDone = true;
      humanActions += 1;
      const next = await advanceAfter(view.version, STEP_TIMEOUT_MS, `人类叫抢决策（seat ${bidder}）`);
      if (next) version = next.version;
      continue;
    }

    if (view.state === 'playing') {
      const turn = view.currentPlayer;
      const actor = room.bySeat.get(turn);
      if (!actor) {
        const next = await advanceAfter(view.version, ROBOT_TURN_WAIT_MS, `机器人出牌回合（seat ${turn}）`);
        robotTurns += 1;
        if (next) version = next.version;
        continue;
      }
      const action = pickHumanAction(currentView(actor), turn);
      const type = action.kind === 'play' ? 'game.play' : 'game.pass';
      const payload = action.kind === 'play' ? { cards: action.cards } : {};
      const ack = await sendThrottled(actor, type, payload, view.version);
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(
          `${what}：人类动作被拒（seat ${turn} ${type} ${JSON.stringify(payload)}）` +
            `code=${ack.code} message=${JSON.stringify(ack.message)}`,
        );
      }
      humanActions += 1;
      const next = await advanceAfter(view.version, STEP_TIMEOUT_MS, `人类动作（seat ${turn} ${action.kind}）`);
      if (next) version = next.version;
      continue;
    }

    throw new ConformanceError(`${what}：意外的 state=${view.state}（v${view.version}）`);
  }
  throw new ConformanceError(`${what}：600 步内没有收束（guard 用尽）`);
}
