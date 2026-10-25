// packages/room-service/src/rooms/rooms.start.ts
import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { BotInstance, Seat } from '@fight-the-landlord/protocol';
import {
  DEFAULT_GAME_TYPE,
  entryFeeOf,
  ErrCode,
  GAME_META,
  type Card,
  type CurrencyApplyData,
  type EntryFeeSkipReason,
  type GameType,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';
import { clearBotBindings, readBotBindings, writeBotBindings, botsKey, type BotBinding } from './rooms.bots';
import { ensureBotDisplayNames } from './bot-names';
import { type Room, RoomsService } from './rooms.service';
import { roomBalancesKey, ROOM_TTL_SECONDS, ccstateKey, startAttemptsKey } from './rooms.seats';
import { isWaitingExpired } from './rooms.timeout';
import { GameClient } from '../gateway/game.client';
import { RobotClient } from '../gateway/robot.client';
// ⚠️ 从**叶子模块**导入（不是 `../match/match.service`）：后者以值导入引本文件
//（DI 元数据）⇒ 反向导入会构成 CJS 模块环（失败模式是加载序相关的启动崩，只有真容器会红）。
import { MATCH_PENDING_TTL_SECONDS, matchPendingKey } from '../match/match-keys';
import { CHANNELS } from '../channels';
// ② 金币场 T5：金币房开局的**三座余额下发**读边（`currency.get`）。
// ⚠️ **值导入**（DI 陷阱纪律）：构造参数的类型元数据要用运行期类引用。
import { CurrencyClient, CurrencyServiceError } from '../currency/currency.client';
// ② 金币场 T6：机器人资金面（金币场补位后的 ensure 边 —— 补给观测与注资）。
// ⚠️ **值导入**（同上；由 `CurrencyModule` 提供，`StartModule` 已 import 它）。
import { RobotFunding } from '../currency/robot-funding';
// 断点④修复（本片 Task 5 · 设计 v1.3.1 §4.4）：开局为人类座位写重连记录（`touch`）。
// ⚠️ **值导入**（DI 陷阱纪律）：构造参数的类型元数据要用运行期类引用 —— `import type`
// 会让容器启动即崩（`Nest can't resolve dependencies of the RoomStartService`），
// 而单测**直接 `new`、不做 DI 解析** ⇒ 全绿看不见。由 `ReconnectModule` 提供
//（`StartModule` 已 import 它；叶子依赖，无环）。
import { ReconnectService } from '../reconnect/reconnect.service';
import { ConfigCacheService } from '../config/config-cache.service';
// 监控片（规格 §2.2）：模块级计数常量（不做成注入 —— 见 room.metrics.ts 头注）。
import { gameStartFailuresTotal, gamesStartedTotal } from '../metrics/room.metrics';
import { incGame } from '@fight-the-landlord/shared';

/** A1：failPdkStart 的指标 reason 枚举；null = start_rpc 已在 startAndAnnounce 的 catch 计过。 */
type PdkStartFailureReason = 'bot_fill' | 'pending_write' | 'rules' | null;
import { entryFeeConflictTotal, entryFeeSkippedTotal } from '../metrics/room.metrics';
import { cardCounterConsumedTotal, cardCounterConsumeErrorTotal } from '../metrics/room.metrics';

/**
 * §4.3 / R210：同参数重试**恰好 1 次**（`maxAttempts = 2`）。与 `MatchService` 同值 ——
 * 两处都是「幂等操作失败重试一次」，各自独立（一个服务队列语义、一个服务房间语义）。
 */
export const RPC_MAX_ATTEMPTS = 2;

/** 台费 op 的 source（本片规格 §2.3 逐字）。 */
export const ENTRY_FEE_SOURCE = 'entry_fee';
/** 台费重试退避（规格 §2.3 逐字：首发 + ≤2 次重试；退避 300ms / 1000ms —— 照结算先例）。 */
export const ENTRY_FEE_RETRY_BACKOFF_MS = [300, 1_000] as const;

/**
 * 开局结局（多玩法 Task 2.4 / spec RH3-c）：`startRoom()` 的 boolean 包装无法区分
 * 「可重试」与「致命」——pdk strict 失败必须留 `waiting` 重试，只有 fatal 才允许
 * `startGroup` 调 `cancelIfStillWaiting`（否则「票已删、房已 cancelled、玩家收到 matched」）。
 *
 *  - `started`：`game.start` 成功（strict 下 ⟺ 房间已写 `playing`）；
 *  - `retryable`：pdk 规则/开局失败 —— 房留 `waiting`、`start_attempts` 已 +1；
 *  - `fatal`：房间不在 `waiting` / ddz 旧语义失败 / pdk 重试预算耗尽（房已取消）；
 *  - `legacy-failed`：ddz `strict:false` 的 `game.start` 失败但仍写 `playing`（N36），
 *    包装层返回 false，`startGroup` **不新增 cancel**（旧行为逐字保留）。
 */
export type StartRoomOutcome = 'started' | 'retryable' | 'fatal' | 'legacy-failed';

/** pdk 开局重试预算（spec RH3-d：`>= 5` 或 waiting timeout ⇒ 取消房）。 */
export const START_ATTEMPTS_MAX = 5;
/** 重试中的 warning 文案（spec RH3-b：`10007`，message 区分「正在重试」/「已取消」）。 */
export const START_RETRY_WARNING_MESSAGE = '本局正在重试开局，请稍候';
export const START_CANCELLED_WARNING_MESSAGE = '本局开局失败，已取消匹配，请重新匹配';

/** `startRoom` 的入参（`seed`/`testDeck` 仅内部测试钩子 —— Task 4.4 的 conformance 通道）。 */
export interface StartRoomOptions {
  strict: boolean;
  announceFirst?: boolean;
  onSeats?: (seats: Seat[]) => Promise<void>;
  /** 内部测试钩子：固定随机种子（仅 `INTERNAL_TEST_HOOKS=1` 时 game-service 生效）。 */
  seed?: number;
  /** 内部测试钩子：固定牌堆（同上）；合法性由 game-service 校验。 */
  testDeck?: Card[];
}

/**
 * §8.2/R47 的**人类谓词**：`match:pending` 的写入与 `room.matched` 的广播**共用**这一份
 *（两处各写一份过滤就迟早漂移 —— 一边加了新条件、另一边没加，症状是「机器人收到
 * `room.matched`」/「机器人占了补回凭据」这类出站泄漏）。
 */
function humanSeats(seats: Seat[]): Array<{ userId: string; seat: number }> {
  return seats.filter((s) => !s.isRobot).map(({ userId, seat }) => ({ userId, seat }));
}

/**
 * **开局**（本片 · spec §2.2 / §3.3 / R915）：补机器人（如需）→ `game.start` → `playing` → 通知。
 *
 * **为什么是一个独立服务而不是 `MatchService` 的方法**：
 * 既有的依赖方向是 `MatchModule → RoomsModule`（`MatchService` 注入 `RoomsService`），
 * 而「自动开局扫描器」住在 rooms 侧、又需要这套开局链 ⇒ 若把链留在 `MatchService`，
 * rooms ⇒ match 的反向依赖会与上面那条**成环**（Nest 报循环依赖）。⇒ 抽出来，两边都注入它。
 *
 * **附带收益**：在 `strict` 模式下，`playing` 的写入点只剩这里一处
 *（匹配路径目前仍是**宽松**模式，见 `startRoom` 的 `strict` 说明）。
 *
 * 🔴 **本服务写 `match:pending`**（片⑦ 修复起）：一切开局都为**人类**座位写凭据 ——
 * 「错过 `room.matched`」者的唯一补回依据（§8.2；单一来源，见 `startRoom` 的 ①）。
 * ⚠️ **但绝不碰匹配队列**（那是匹配专属职责，仍在 `MatchService`）。
 */
@Injectable()
export class RoomStartService {
  private readonly logger = new Logger(RoomStartService.name);

  constructor(
    private readonly redis: Redis,
    private readonly rooms: RoomsService,
    private readonly game: GameClient,
    private readonly robot: RobotClient,
    /**
     * ② 金币场 T5：金币房开局的**三座余额下发**读边（`currency.get`；读失败 ⇒ 省略
     * `RoomPlayer.balance` 字段、**不阻塞开局** —— 与结算资金安全不同级）。
     * 由 `CurrencyModule` 提供（`StartModule` 已 import 它）。
     */
    private readonly currency: CurrencyClient,
    /**
     * ② 金币场 T6：机器人资金面（金币场 `fillBots` 内的 **ensure 边** —— 补位成功后、
     * `game.start` 前为刚入座的机器人补水位）。由 `CurrencyModule` 提供（同一单例 ——
     * 结算后动作的钩子也注入它）。
     */
    private readonly robotFunding: RobotFunding,
    /**
     * 断点④修复（本片 Task 5 · 设计 v1.3.1 §4.4）：**开局写重连记录**（`touch`）——
     * 「匹配后从未 `room.join`」的玩家在 `match:pending` 票过期后仍可凭
     * `reconnect:active` 哈希回桌（断点④）。经本服务写 ⇒ 键名/JSON 单一来源。
     * 由 `ReconnectModule` 提供（`StartModule` 已 import 它）。
     */
    private readonly reconnect: ReconnectService,
    /**
     * 本片（台费并入片）：台费费率（由 `game.baseScoreLevels[].entryFeePercent` 派生）—— 收费块唯一配置消费点。
     * 由 `ConfigCacheModule` 提供（**StartModule 已 import 它**）。
     * ⚠️ **值导入**（DI 陷阱纪律）：类型导入会在容器解析依赖时变成 `Object` ⇒ 启动即崩。
     */
    private readonly configCache: ConfigCacheService,
  ) {}

  /**
   * 把**已存在且仍在 `waiting`** 的房间开起来（**幂等** —— 扫描器每个周期都可能再调一次）。
   *
   * ① 房间不在 / 已不是 `waiting` ⇒ 返回 `false`（**这就是幂等**：第二轮扫到同一个房间时，
   *    它已经是 `playing` 了）；
   * ② 缺人 ⇒ 补机器人；
   * ③ `game.start` ⇒ 写 `playing` + 通知。
   *
   * ⚠️ **`strict` 决定「`game.start` 失败之后怎么办」——两条路径的处置本来就不同**：
   *  - `strict: true`（**手动房**，本片新增）：失败 ⇒ **不写 `playing`**、返回 `false`。
   *    房间留 `waiting` ⇒ 下个扫描周期重试；最坏由回收任务按 `MANUAL_ROOM_TIMEOUT_MS` 删房。
   *    **为什么必须这样**：`playing` 是**唯一**逃离回收任务的状态（`isWaitingExpired` 明文
   *    不回收 `playing`）⇒ 失败还写 `playing` 就是「3 个玩家对着空牌桌等 1 小时 TTL」（H1）。
   *  - `strict: false`（**匹配路径**，保持现状）：失败**照样**写 `playing`。这是台账 **N36**
   *    登记的已知边界（已裁「本仓不实现」其降级），由 `match.service.test.ts` 钉住 ⇒
   *    **本片不动它**（spec §7「明确不做」）。等将来要收 N36 时，把这条也切成 `strict: true`。
   *
   * `onSeats`：**补位成功、开局之前的挂钩**（调用方用它退匹配队列 —— 那是匹配专属
   * 职责，本服务不碰）。⚠️ 它在**补位失败时不会被调用**：那正是 §8.4②「不丢人」
   * 需要的时刻边界（票要留着下轮重试）。抛错 ⇒ 本轮开局失败（返回 `false`）。
   * ⚠️ 片⑦ 修复起，它**不再是** `match:pending` 的写入点（那已上移为本方法自己执行的
   * 单一来源 —— 原先只有匹配路径调用挂钩，好友房因此无凭据，见下方 ① 的注释）。
   *
   * 🔴 `announceFirst`：**先把「开局了」广播出去、再调 `game.start`**。
   *
   * ⚠️ 这条顺序是**踩出来的**（spec §8.1 的已知代价）：`game.deal` 的投递靠
   * `WsGateway.seatOwners` 那张**内存**表，而它是在**客户端收到 `room.matched` 之后
   * 自己发 `room.join`** 时才登记的。若先 `game.start`，`game.started` 会在玩家还没进房时
   * 抵达网关 ⇒ **三家都收不到 `game.deal`**（实测：`inbound game.started … owners=`（空））。
   * 匹配路径**本来**就是这个顺序（旧 `processQueue` 先 `announce` 再 `startGame`），
   * 抽服务时被我调换了 —— 这条参数把那个顺序**显式**固化下来。
   *
   * ─────────────────────────────────────────────────────────────────────
   * 🔴 **真上多实例时才要做的事**（片⑥ · spec §4 / R1005：**清单，本仓未实施**）
   * ─────────────────────────────────────────────────────────────────────
   *
   * **本方法就是唯一的临界区**（「判 `waiting` → 补位 → 开局」这三步），
   * 所以这张清单挂在这里 —— 读代码的人一定会经过它。
   *
   * | # | 做什么 | 为什么 |
   * |---|---|---|
   * | 1 | 给下面这段「判 `waiting` → 补位 → 开局」加 `SET NX EX`（几秒） | 省掉**一次多余**的 `robot.acquire` RPC。**不是**为了正确性 —— 片⑥ 的 CAS（`cancelIfStillWaiting`）之后，**已知的正确性缺口为零** |
   * | 2 | 两条回收循环（房间回收 / 机器人回收）**明确标注「无需锁」** | 它们的每个动作本身幂等（`DEL`/`ZREM` 对不存在的键返回 0）；上锁是纯开销 |
   * | 3 | 复核 `game-service` 的**会话表**与 robot 的**池**是否也各自持有进程内状态 | ⚠️ **片⑥ 的已知未覆盖项**：只核实了四条定时循环，**没有**核实这两处进程内状态（多实例下会分叉）。上多实例前必须核 |
   *
   * ⚠️ **第 1 条为什么现在不做**（R1001）：锁换来的是「省一次多余的 RPC」，
   * 而代价是新机制 + 热路径多一次往返。**判据**（片⑥ 的 W1–W4）钉的是**安全**，
   * 不是**互斥** —— 两个实例都成功是**允许**的（spec §0.3）。
   *
   * @returns 真的开起来了（`strict` 下也要求 `game.start` 成功）⇒ `true`
   */
  async startRoom(code: string, options: StartRoomOptions): Promise<boolean> {
    return (await this.startRoomOutcome(code, options)) === 'started';
  }

  /**
   * 开局链的**三态实现**（多玩法 Task 2.4 / spec §4.6.3）：
   *
   *  - 斗地主：行为逐字沿用旧语义（`startRoom` 包装层只在 `'started'` 返回 true）；
   *  - 跑得快：**读规则快照成功 → announce → `game.start(strict:true, rules)` → `onSeats` 后置**；
   *    失败一律不写 `playing`、不取消房/票，`room:{code}:start_attempts` +1（TTL=房间 TTL），
   *    下一轮扫描重试；预算耗尽或 waiting timeout ⇒ 取消房 + `system_warning(10007)` + 归池机器人。
   *
   * ⚠️ `onSeats` 失败（pdk）**不**把已开局的房判失败：claims（= roomCode）让下一轮扫描
   * 识别「已开局但票未删」，按 `queueKeyOfTicket` 幂等 `cancelQueue` 清理（MatchService 侧）。
   */
  async startRoomOutcome(code: string, options: StartRoomOptions): Promise<StartRoomOutcome> {
    const room = await this.rooms.findOne(code);
    if (!room || room.status !== 'waiting') return 'fatal';

    const gameType = room.gameType ?? DEFAULT_GAME_TYPE;
    const isPdk = gameType === 'paodekuai';
    // pdk 全程 strict（spec §4.6.3）：失败**不得**写 playing / 调 onSeats / 取消票。
    const strict = isPdk ? true : options.strict;

    const filled = await this.fillBots(code, room);
    if (!filled) {
      if (isPdk) {
        return this.failPdkStart(code, room, room.players, 'bot_fill', 'bot fill failed', options.onSeats);
      }
      incGame(gameStartFailuresTotal, gameType, 1, { reason: 'bot_fill' });
      return 'fatal';
    }

    /**
     * 机器人拟人昵称（2026-10-22 片）：在 `fillBots` **之后**、开局之前落盘。
     *
     * 🔴 输入必须是 `filled.seats` 的**全量**机器人座位，不能只用本次 acquire 的
     * `botBindings`：预置机器人、半途 acquire 失败后重试补上的机器人都不在本次
     * bindings 里，却同样需要昵称（对抗审查 阻断-1）。
     *
     * fail-open：`ensureBotDisplayNames` 内部吞掉全部异常 ⇒ 昵称失败不会让开局失败。
     */
    await ensureBotDisplayNames(
      this.redis,
      code,
      filled.seats
        .filter((seat) => seat.isRobot)
        .map((seat) => ({ seat: seat.seat, displayId: seat.userId })),
    );

    /**
     * ① 写凭据（片⑦ 修复 · slice12-race-fix-design §1）：**一切开局**都为人类座位写
     * `match:pending:{playerId}` —— 「错过 `room.matched`」者的唯一补回依据
     *（`game.reconnect` 第①步，见 `message.router`；连接时的主动补推见 `ws.gateway`）。
     * 在此之前只有**匹配路径**经 `onSeats` 挂钩写 ⇒ 好友房没有凭据、竞态无法补回。
     *
     * ⚠️ 位置不可动（两条理由都踩过）：
     *  - **在补位成功之后**：补位失败 ⇒ 票要留着下轮重试（§8.4②「不丢人」），
     *    此时写凭据会留下指向一个 `cancelled` 房间的垃圾凭据；
     *  - **在 `startAndAnnounce` 的两条 announce 与 `game.start` 之前**：窗口期内客户端
     *    可能已收到 `room.matched` 却查不到 `match:pending` —— 那正是它「错过推送后补回」
     *    的唯一依据（§8.2）。该顺序原由匹配路径的 `onSeats` 挂钩保证，片⑦ 起由本方法
     *    自己保证（单一来源，两条路径同序等价）。
     *
     * ⚠️ **写失败 ⇒ log + return false**（镜像 `onSeats` 的 catch，裁决 E）：房间留
     * `waiting` ⇒ 下个扫描周期重试；吞异常会让「毒键 ⇒ 降级」的判据（slice-12 步骤 10）
     * 与 `match.service.test.ts` 的「降级不丢人」变成**空测**。
     */
    try {
      for (const { userId, seat } of humanSeats(filled.seats)) {
        await this.redis.hset(matchPendingKey(userId), { roomCode: code, seat: String(seat) });
        await this.redis.expire(matchPendingKey(userId), MATCH_PENDING_TTL_SECONDS);
        // §4.4（设计 v1.3.1）：开局同时写重连记录 —— 「匹配后从未 room.join」的玩家
        // 在票过期后仍可凭它回桌（断点④）。经 ReconnectService 写（键名/JSON 单一来源）。
        await this.reconnect.touch(userId, '', code);
      }
    } catch (err) {
      this.logger.error(`Failed to store match:pending / reconnect record for ${code}: ${String(err)}`);
      if (isPdk) {
        return this.failPdkStart(
          code, room, filled.seats, 'pending_write', 'match:pending write failed', options.onSeats,
        );
      }
      incGame(gameStartFailuresTotal, gameType, 1, { reason: 'pending_write' });
      return 'fatal';
    }

    /**
     * ② 金币场 T5（设计 §2 D7 / 规格 §2.3）：**金币房开局三座余额下发** —— 一次性
     * `currency.get`，写入派生键 `room:{code}:balances`（随 `room.join` 的 players 列表
     * 下发 `RoomPlayer.balance`）。读失败 ⇒ WARN + **不写键**（= 省略字段，客户端显「—」），
     * **不阻塞开局**（与结算资金安全不同级）。
     *
     * ⚠️ 位置：在 `startAndAnnounce` **之前** —— 匹配路径的 `room.matched` 公告发生在
     * 其中，客户端收到后立刻 `room.join` ⇒ 键必须先就位（否则首拉竞态恒「—」）。
     * ⚠️ 非金币场**零资金调用**（与 T4 门槛读边同一条纪律）。
     */
    if (room.mode === 'gold') {
      await this.storeGoldBalances(code, filled.seats);
    }

    /**
     * ③ pdk 规则快照（spec §4.6.3 / RH3-e）：**必须在 announce / onSeats / game.start 之前**读。
     * 失败 ⇒ 不 announce、不 start、不调 onSeats；房间留 `waiting`，重试预算 +1。
     */
    let rules: PdkRulesConfig | undefined;
    if (isPdk) {
      try {
        rules = this.configCache.pdkRules();
      } catch (err) {
        return this.failPdkStart(
          code,
          room,
          filled.seats,
          'rules',
          `pdk rules unavailable: ${err instanceof Error ? err.message : String(err)}`,
          options.onSeats,
        );
      }
    }

    // 斗地主：`onSeats` 仍在开局**之前**（旧顺序逐字保留）；pdk 后置到 game.start 成功之后。
    if (!isPdk && options.onSeats) {
      try {
        await options.onSeats(filled.seats);
      } catch (err) {
        incGame(gameStartFailuresTotal, gameType, 1, { reason: 'on_seats' });
        this.logger.error(`onSeats hook failed for ${code}: ${String(err)}`);
        return 'fatal';
      }
    }

    const ok = await this.startAndAnnounce(
      code,
      room.baseScore,
      filled.seats,
      filled.bindings,
      strict,
      // pdk：读规则成功 → announce → game.start（顺序固定；好友房发布路径也如此）。
      isPdk ? true : options.announceFirst === true,
      gameType,
      room.maxPlayers,
      rules,
      { seed: options.seed, testDeck: options.testDeck },
    );

    if (!ok) {
      if (isPdk) {
        // start_rpc 已在 startAndAnnounce 的 catch 计过；这里只做重试/取消
        return this.failPdkStart(code, room, filled.seats, null, 'game.start failed', options.onSeats);
      }
      // 斗地主旧语义：strict 失败 ⇒ fatal（startGroup 的 cancel 分支）；
      // strict:false 的失败仍写 playing（N36）⇒ legacy-failed（包装层 false、不加 cancel）。
      return strict ? 'fatal' : 'legacy-failed';
    }

    /**
     * ④ pdk：`onSeats` **后置**到 `game.start` 成功之后（spec RH3-a/§4.6.3）。
     * 失败只 WARN —— 房已开成功；未删的票由下一轮扫描凭 claim（= roomCode）幂等清理。
     */
    if (isPdk && options.onSeats) {
      try {
        await options.onSeats(filled.seats);
      } catch (err) {
        this.logger.warn(
          `onSeats hook failed after start for ${code} (stale tickets cleaned by next scan): ${String(err)}`,
        );
      }
    }

    /**
     * 本片 D1（方案 C）：**收费位 = `game.start` 成功之后**、且 `room.mode === 'gold'`。
     * 台费按**玩法**档位取表（D8）；记牌器按能力位（D17：跑得快不扣费/不下发）。
     */
    await Promise.all([
      room.mode === 'gold'
        ? this.chargeEntryFees(code, room.baseScore, filled.seats, gameType)
        : Promise.resolve(),
      GAME_META[gameType].capabilities.cardCounter
        ? this.updateCardCounterStatuses(code, room.mode, filled.seats)
        : Promise.resolve(),
    ]);
    return 'started';
  }

  /**
   * pdk 开局失败（spec RH3-d）：重试预算 + 终局取消 + 定向 warning + 机器人归池。
   *
   * - 每次失败 `INCR room:{code}:start_attempts` 并续 TTL（随房回收；`deleteRoom` 删除集含它）；
   * - `>= 5` 或 waiting timeout ⇒ `cancelIfStillWaiting` + `system_warning(10007, 已取消)` +
   *   `robot.release`（带绑定表里的内部 botId）；
   * - 未到预算 ⇒ `system_warning(10007, 正在重试)`，返回 `retryable`（**不取消票/房**）。
   */
  private async failPdkStart(
    code: string,
    room: Room,
    seats: Seat[],
    metricReason: PdkStartFailureReason,
    detail: string,
    onSeats?: (seats: Seat[]) => Promise<void>,
  ): Promise<StartRoomOutcome> {
    const key = startAttemptsKey(code);
    const attempts = await this.redis.incr(key);
    await this.redis.expire(key, ROOM_TTL_SECONDS);
    if (metricReason !== null) {
      incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: metricReason });
    }
    const expired = isWaitingExpired(room, this.rooms.now());
    this.logger.warn(
      `pdk start failed for ${code} (attempt ${attempts}/${START_ATTEMPTS_MAX}${expired ? ', waiting expired' : ''}): ${detail}`,
    );

    if (attempts >= START_ATTEMPTS_MAX || expired) {
      const cancelled = await this.rooms.cancelIfStillWaiting(code);
      if (cancelled) {
        incGame(gameStartFailuresTotal, 'paodekuai', 1, { reason: 'cancelled' });
        // spec §4.6.3：终局取消**要清票**（按 queueKeyOfTicket —— 由匹配侧的 onSeats 回调完成）。
        // 与 retryable 的「不取消票」相对：重试期间票必须留着，否则人票两空。
        if (onSeats) {
          try {
            await onSeats(seats);
          } catch (err) {
            this.logger.warn(`final onSeats cleanup failed for ${code}: ${String(err)}`);
          }
        }
        await this.releaseBotsFor(code);
        await this.publishStartWarning(seats, START_CANCELLED_WARNING_MESSAGE);
        this.logger.error(`pdk start cancelled for ${code} after ${attempts} attempt(s)`);
      }
      return 'fatal';
    }

    await this.publishStartWarning(seats, START_RETRY_WARNING_MESSAGE);
    return 'retryable';
  }

  /** 定向 `system.warning`（经 `match:events` → WsGateway；**不**临时发明第二条通路）。 */
  private async publishStartWarning(seats: Seat[], message: string): Promise<void> {
    const playerIds = humanSeats(seats).map((s) => s.userId);
    if (playerIds.length === 0) return;
    try {
      await this.redis.publish(
        CHANNELS.matchEvents,
        JSON.stringify({
          event: 'system_warning',
          playerIds,
          code: ErrCode.UPSTREAM_UNAVAILABLE,
          message,
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to publish system_warning for start failure: ${String(err)}`);
    }
  }

  /** 取消房时归池本房机器人（绑定表是 botId 的唯一来源；失败只 WARN，TTL 兜底回收）。 */
  private async releaseBotsFor(code: string): Promise<void> {
    try {
      const botIds = await readBotBindings(this.redis, code);
      if (botIds.length > 0) await this.robot.release(botIds);
      await clearBotBindings(this.redis, code);
    } catch (err) {
      this.logger.error(`Failed to release robots for cancelled room ${code}: ${String(err)}`);
    }
  }

  /**
   * 补机器人到满座（`maxPlayers`）。**已在座的人不重排**（座位号取自权威座位表 R128）。
   *
   * @returns 补齐后的座位表 + 绑定；补位失败 ⇒ `null`（调用方据此**不写 `playing`**）
   */
  private async fillBots(
    code: string,
    room: Room,
  ): Promise<{ seats: Seat[]; bindings: BotBinding[] } | null> {
    let current = room;
    const botBindings: BotBinding[] = [];
    const gameType = room.gameType ?? DEFAULT_GAME_TYPE;
    try {
      const empty = room.maxPlayers - room.players.length;
      for (let i = 0; i < empty; i += 1) {
        // 真正落到哪个座位由 `addBot` 内部的 **HSETNX** 决定（原子）—— 这里给的只是下界，
        // 服务端权威座位表永远是 `room.players`（R128/R129：不得本地推导座位号）。
        // 多玩法（Task 2.6）：按房间玩法取对应池（pdk 与 ddz 池隔离）。
        const bot = await this.acquireBot(code, current.players.length, gameType);
        // §9.6 第 3 条：座位里的 `userId` 是**对外** `displayId`（`p_<8位>`），
        // 不是内部 `botId` —— 后者永不下发（§9.2/R207）。
        current = await this.rooms.addBot(code, bot.displayId);
        const bound = current.players.find((p) => p.userId === bot.displayId);
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
      }
      /**
       * P0-2：**恢复本次没有补位的已入座机器人**（`game.start` / `ensureBots` 失败后的
       * 重试路径必走这里：房已满 ⇒ 上面的循环一步不走）。不恢复的话
       * `buildStartPlayers` 只按**本次** bindings 装饰 ⇒ 机器人缺 `botId`/`skillLevel`
       * ⇒ game-service 的 `driveRobotTurn` 起不来，机器人永久不动。
       *
       * 恢复来源是 robot-service 的**持久化绑定**（`room → seat` 索引 + `bot:{botId}`，
       * `robot.acquire` 对已绑定座位幂等返回原实例 —— R201），它同时带回
       * `skillLevel` / `personality.thinkingSpeed`；room 侧的 `room:{code}:bots`
       * 只有 `seat → botId`，不足以还原 `game.start` 载荷。失败按补位失败处理
       *（catch ⇒ `null` ⇒ 不开局），绝不能带着缺身份的机器人开局。
       */
      botBindings.push(...(await this.recoverBotBindings(code, current.players, botBindings)));
      // R207：`seat → botId` 落 `room:{code}:bots`（局终 `robot.release` 的唯一来源）
      await writeBotBindings(this.redis, code, botBindings);
      /**
       * ② 金币场 T6（规格 §7）：**补位后、`game.start` 前的机器人注资（ensure）**——
       * 以本次 acquire 到的**内部** `botId` 为观测对象（资金面绝不用出站 `displayId`）。
       *
       * - **位置**：在 `writeBotBindings` **之后** —— 若下面 ensure 抛、本方法返回 null，
       *   绑定表已落盘（局终/取消路径归池要读它，R207）；顺序反过来会留下「机器人在座、
       *   绑定佚失」的孤儿形态。
       * - **失败 ⇒ 抛**（落入本方法的 catch ⇒ `fillBots` 返回 `null`）：既有补位失败路径
       *   （`startRoom` false ⇒ 匹配侧 cancel + attempts+1）原样复用 —— 资金安全与开局
       *   **同生共死**：补不到钱的机器人不上桌。
       * - **非金币场零资金调用**（与 T4 门槛读边 / T5 余额下发同一条纪律）；房满无补位
       *   （上面的早返）连这一行都不会走到。
       */
      if (room.mode === 'gold' && botBindings.length > 0) {
        await this.robotFunding.ensureBots(botBindings.map((b) => b.botId), gameType);
      }
      return { seats: current.players, bindings: botBindings };
    } catch (err) {
      /**
       * ⚠️ **与匹配路径的处置不同**（有意）：`MatchService` 那边补位失败会置 `cancelled`
       * 并 `attempts+1` —— 它有**队列**要收（把人退队/重排）。而本服务不做那件事
       *（队列是匹配专属），于是两条路径的补位失败语义在这里分叉：见 §8.1 的已知代价。
       */
      this.logger.error(`Bot fill failed for ${code}: ${String(err)}`);
      return null;
    }
  }

  /**
   * P0-2：为**已在座但不在本次 bindings 里**的机器人恢复完整绑定。
   *
   * `robot.acquire` 对已绑定 `{roomCode, seat}` 幂等（回报原 `BotInstance`），因此这里
   * **不会新分配机器人**：只要 robot-service 的绑定还在，`botId`/`skillLevel`/
   * `thinkingSpeed` 与首次补位完全一致。空集 ⇒ 零 RPC（全人类满房的行为不变）。
   *
   * 任何座位拿不到有效实例 ⇒ **抛**（落入 `fillBots` 的 catch ⇒ 不开局）：
   * 缺 `botId` 的机器人上桌后永远不会动，比「本轮不开、下轮重试」更糟。
   */
  private async recoverBotBindings(
    code: string,
    seats: Seat[],
    known: ReadonlyArray<BotBinding>,
  ): Promise<BotBinding[]> {
    const coveredSeats = new Set(known.map((b) => b.seat));
    // 绑定与座位表以 `displayId` 关联（`Seat.userId` 是出站 id）：座位号以 bindings 为准，
    // 但身份判定两者任一命中即视为已覆盖，避免对同一机器人重复 acquire。
    const coveredDisplayIds = new Set(known.map((b) => b.displayId));
    const missingSeats = seats
      .filter(
        (s) => s.isRobot && !coveredSeats.has(s.seat) && !coveredDisplayIds.has(s.userId),
      )
      .map((s) => s.seat);
    if (missingSeats.length === 0) return [];

    const { bots } = await this.robot.acquire(code, missingSeats);
    const bySeat = new Map((bots ?? []).map((b) => [b.seat, b]));
    return missingSeats.map((seatNo) => {
      const bot = bySeat.get(seatNo);
      if (!bot?.botId || !bot.displayId) {
        throw new Error(`robot.acquire recovered no bot for ${code} seat ${seatNo}`);
      }
      return {
        seat: seatNo,
        botId: bot.botId,
        skillLevel: bot.skillLevel,
        thinkingSpeed:
          typeof bot.personality?.thinkingSpeed === 'number' &&
          Number.isFinite(bot.personality.thinkingSpeed)
            ? bot.personality.thinkingSpeed
            : 2000,
        displayId: bot.displayId,
      };
    });
  }

  /**
   * ② 金币场 T5：把三座余额写进派生键 `room:{code}:balances`（`field = seat`）。
   *
   * - ownerId 真源：人类座 = `Seat.userId`（真实 `userId`）；机器人座 = `room:{code}:bots`
   *   绑定表里的**内部** `botId`（`Seat.userId` 是出站 `displayId`，资金面**绝不**用它）。
   *   绑定表在开局前由 `fillBots` 写好、局终才 DEL ⇒ 此刻是权威来源（对「房已满、
   *   本轮没补新位」的重试路径同样成立 —— 这正是不能只用 `fillBots` 返回值的原因）。
   * - **失败方向（规格 §2.3 逐字）**：任何失败（RPC 传输/解析/Redis）⇒ WARN + 不写键，
   *   开局照常。省略字段是契约允许的（客户端显「—」）—— 与结算的「宁可账面可见」不同级。
   */
  private async storeGoldBalances(code: string, seats: Seat[]): Promise<void> {
    try {
      const botSeatMap = (await this.redis.hgetall(botsKey(code))) ?? {};
      const ownerIds: string[] = [];
      for (const seat of seats) {
        const ownerId = seat.isRobot ? botSeatMap[String(seat.seat)] : seat.userId;
        if (!ownerId) {
          this.logger.warn(
            `Gold balances skipped for ${code}: bot binding missing for robot seat ${seat.seat} (omitting seat balances)`,
          );
          return;
        }
        ownerIds.push(ownerId);
      }
      const { balances } = await this.currency.get({ ownerIds });
      const fields: Record<string, string> = {};
      for (const seat of seats) {
        const ownerId = seat.isRobot ? botSeatMap[String(seat.seat)]! : seat.userId;
        const entry = balances.find((b) => b.ownerId === ownerId);
        if (entry) fields[String(seat.seat)] = String(entry.balance);
      }
      if (Object.keys(fields).length === 0) return;
      await this.redis.hset(roomBalancesKey(code), fields);
      await this.redis.expire(roomBalancesKey(code), ROOM_TTL_SECONDS);
    } catch (err) {
      // 读失败 ⇒ 省略该字段（客户端显「—」），不阻塞开局。
      this.logger.warn(
        `Gold balance read failed for ${code} (omitting seat balances): ${String(err)}`,
      );
    }
  }

  /**
   * 台费收费块（本片规格 §2.3 逐字；D1–D5）。
   *
   * - **fee 快照**：fee/entries 在本次调用开头算一次，**不随重试重读配置**（14002 收窄为
   *   「跨调用并发 × 中途改费率」——r2-F1）；**该房 fee==0 整块短路**（D5：表缺失/形状坏/
   *   未命中该房 baseScore/该档 percent=0，任一来源 ⇒ 零 apply、零记录、零指标、零时延）。
   * - **逐人独立、并发发起**（`Promise.all`；各笔 actionId 互不依赖；整块最坏 ≈10.3s = 单人上界）。
   * - 单人结局四分支与免单闭环在 `chargeOne`；本方法只做「一次快照 + 并发扇出」+ 防御性外壳。
   */
  private async chargeEntryFees(
    code: string,
    baseScore: number,
    seats: Seat[],
    gameType: GameType,
  ): Promise<void> {
    try {
      // 多玩法（D8/Task 2.4）：台费费率按**玩法**档位表取（斗地主旧键 / 跑得快新键）。
      const fee = entryFeeOf(baseScore, this.configCache.entryFeePercents(gameType));
      if (fee === 0) return; // D5：该房 fee==0 ⇒ 整块跳过（不读不写不计）

      const humans = humanSeats(seats);
      await Promise.all(
        humans.map(({ userId, seat }) => this.chargeOne(code, baseScore, seat, userId, fee, gameType)),
      );
    } catch (err) {
      // 「整块不阻断」的兜底外壳（单人函数已各自全捕获；这里防御配置读等意外）。
      this.logger.warn(`entry fee block failed for ${code} (startRoom unaffected): ${String(err)}`);
    }
  }

  /**
   * 记牌器收费片：开局状态块（规格 §2.4e / 设计 §3.4.2）。**所有模式都执行**：
   *  - 总开关关 ⇒ 全部真人 inactive（不消费；急停语义）；
   *  - 非金币场 / 金币场两价皆 0 ⇒ active=总开关（免费态，不消费）；
   *  - 金币场且至少一价 >0 ⇒ 逐位真人 `currency.cardCounterConsume`（**逐位并发**）；
   *    未知态 ⇒ active=true/source=unknown（玩家优先，D16）+ 指标。
   *
   * 结果写 `room:{code}:ccstate`（field=seat）+ 发布 `match:events` 的 `card_counter` 事件。
   * **整块绝不抛**（开局不受影响）；写键/发布失败只 error 日志（客户端 fail-closed）。
   */
  private async updateCardCounterStatuses(
    code: string,
    mode: Room['mode'],
    seats: Seat[],
  ): Promise<void> {
    interface StatusEntry {
      seat: number;
      userId: string;
      active: boolean;
      source?: 'pass' | 'credit' | 'none' | 'unknown';
    }
    try {
      const humans = humanSeats(seats);
      if (humans.length === 0) return;
      const master = this.configCache.cardCounterEnabled();
      const { perGame, perHour } = this.configCache.cardCounterPrices();
      const charged = mode === 'gold' && (perGame > 0 || perHour > 0);

      const statuses: StatusEntry[] = [];
      if (!master) {
        for (const h of humans) statuses.push({ ...h, active: false });
      } else if (!charged) {
        for (const h of humans) statuses.push({ ...h, active: true });
      } else {
        const results = await Promise.all(
          humans.map(async (h): Promise<StatusEntry> => {
            try {
              const data = await this.currency.cardCounterConsume({
                roomCode: code,
                ownerId: h.userId,
                seat: h.seat,
              });
              cardCounterConsumedTotal.inc({ source: data.source });
              this.logger.log(
                `event=card_counter.consumed roomCode=${code} ownerId=${h.userId} seat=${h.seat} source=${data.source} active=${String(data.active)}`,
              );
              return { ...h, active: data.active, source: data.source };
            } catch (err) {
              cardCounterConsumeErrorTotal.inc();
              this.logger.warn(
                `event=card_counter.consume_error roomCode=${code} ownerId=${h.userId} seat=${h.seat} reason=${err instanceof Error ? err.message : String(err)}`,
              );
              return { ...h, active: true, source: 'unknown' };
            }
          }),
        );
        statuses.push(...results);
      }

      const key = ccstateKey(code);
      // 写前用**当前权威座位表**复核 (seat,userId)：座位漂移/离座后不得把旧映射写进状态键。
      const current = await this.rooms.findOne(code);
      if (current === null) {
        this.logger.warn(`event=card_counter.status_skipped roomCode=${code} reason=room_missing`);
        return;
      }
      const currentHumans = new Set(
        current.players.filter((p) => !p.isRobot).map((p) => `${p.seat}:${p.userId}`),
      );
      const effective = statuses.filter((status) =>
        currentHumans.has(`${status.seat}:${status.userId}`),
      );
      const fields: Record<string, string> = {};
      for (const status of effective) {
        fields[String(status.seat)] = JSON.stringify({
          active: status.active,
          ...(status.source === undefined ? {} : { source: status.source }),
        });
      }
      await this.redis.hset(key, fields);
      await this.redis.expire(key, ROOM_TTL_SECONDS);

      for (const status of effective) {
        await this.redis.publish(
          CHANNELS.matchEvents,
          JSON.stringify({
            event: 'card_counter',
            userId: status.userId,
            roomCode: code,
            active: status.active,
            ...(status.source === undefined ? {} : { source: status.source }),
          }),
        );
      }
    } catch (err) {
      this.logger.error(
        `event=card_counter.status_failed roomCode=${code} reason=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 单人台费（规格 §2.3 逐字）：**首发 + ≤2 次重试**（退避 300ms/1s；单次 3s 超时在
   * `CurrencyClient` 内部）、**同锚同载荷**（actionId/entries 一次算定）。本函数**绝不抛**。
   *
   * 结局四分支：
   *  - `ok:true`（含 `replayed:true`）⇒ 成功；余额回写（派生键 + EXPIRE；失败只 warn）；
   *  - `14001` ⇒ 免单 `insufficient_funds`（单人 op ⇒ 归因精确到当事人）；
   *  - `14002` ⇒ **视为已收**：响亮日志 + `entry_fee_conflict_total`；**不记 skips、不计漏收**；
   *  - `10007`/超时族（重试耗尽仍无结局）⇒ 免单 `unknown_outcome`；
   *  - 其它业务码（含 10001）与其它异常 ⇒ 免单 `internal_error`（确定性失败，不重试）。
   */
  private async chargeOne(
    code: string,
    baseScore: number,
    seat: number,
    ownerId: string,
    fee: number,
    gameType: GameType,
  ): Promise<void> {
    const actionId = `entryfee:${code}:${ownerId}`;
    const entries = [{ ownerId, delta: -fee }];
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= ENTRY_FEE_RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, ENTRY_FEE_RETRY_BACKOFF_MS[attempt - 1]!));
      }
      try {
        const data = await this.currency.apply({ actionId, source: ENTRY_FEE_SOURCE, entries, refId: code });
        await this.writeBackFeeBalance(code, seat, ownerId, data);
        return;
      } catch (err) {
        if (err instanceof CurrencyServiceError) {
          if (err.code === ErrCode.E_INSUFFICIENT_FUNDS) {
            await this.recordEntryFeeSkip(code, seat, ownerId, baseScore, fee, 'insufficient_funds', actionId, gameType);
            return;
          }
          if (err.code === ErrCode.E_ACTION_CONFLICT) {
            // 14002 ⟺ 同锚已有**成功提交** ⇒ 该笔台费已收（「视为已收」——r2-F1/r2-delta-F2 清残留：
            // 记成漏收会让用户⑥ 的统计面系统性假漏收）。响亮日志 + 专用计数；不记 skips、不回写。
            this.logger.error(
              `entry fee conflict（同锚已有成功提交，视为已收——不记漏收）room=${code} owner=${ownerId} actionId=${actionId}`,
            );
            incGame(entryFeeConflictTotal, gameType, 1);
            return;
          }
          if (err.code === ErrCode.UPSTREAM_UNAVAILABLE) {
            lastError = err; // 10007/超时族：无结局 ⇒ 同锚同载荷重发（重放判定是唯一结局判定手段）
            continue;
          }
        }
        // 其它业务码（如 10001）与其它异常：确定性的失败 ⇒ 免单 internal_error（不重试）。
        await this.recordEntryFeeSkip(code, seat, ownerId, baseScore, fee, 'internal_error', actionId, gameType);
        return;
      }
    }
    // 首发 + ≤2 重试耗尽仍无结局 ⇒ 免单 unknown_outcome。
    this.logger.warn(`entry fee unresolved after retries room=${code} owner=${ownerId}: ${String(lastError)}`);
    await this.recordEntryFeeSkip(code, seat, ownerId, baseScore, fee, 'unknown_outcome', actionId, gameType);
  }

  /**
   * 余额回写（D2/r2-F2）：成功/重放后，以响应 `entries[].balanceAfter` HSET
   * `room:{code}:balances`（seat→值）并补 `EXPIRE ROOM_TTL_SECONDS`（照 `storeGoldBalances` 纪律）。
   * 失败 ⇒ warn（显示回落扣前值、至结算自愈——设计 §6-9；**钱面无影响**）。绝不抛。
   */
  private async writeBackFeeBalance(
    code: string,
    seat: number,
    ownerId: string,
    data: CurrencyApplyData,
  ): Promise<void> {
    try {
      const entry = data.entries.find((e) => e.ownerId === ownerId);
      if (entry === undefined) {
        this.logger.warn(`entry fee write-back skipped for ${code}: 响应缺 ownerId=${ownerId}（不写假值）`);
        return;
      }
      await this.redis.hset(roomBalancesKey(code), { [String(seat)]: String(entry.balanceAfter) });
      await this.redis.expire(roomBalancesKey(code), ROOM_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        `entry fee write-back failed for ${code} seat=${seat}（显示回落扣前值；钱面无影响）: ${String(err)}`,
      );
    }
  }

  /**
   * 免单记账（规格 §2.4 三面 + 判别三步 r2-delta-F1；本函数绝不抛）。
   *
   * ① 逐笔日志（NDJSON 九字段 + traceId 全链）：`event='entry_fee.skipped'` +
   *    `roomCode/ownerId/seat/baseScore/levelName(反查失败省略)/feeAmount/reason/opActionId`，
   *    每笔一行、绝不合并；② 指标 `entry_fee_skipped_total{reason}`（有界 ×3）；
   * ③ 库面 skip RPC（单次尝试、不重试——防调用内重发重复；跨调用重复由唯一键 + INSERT IGNORE 兜）。
   *
   * 判别三步：`inserted=true` ⇒ inc 指标 + 逐笔日志；`false`（同房二开重复）⇒ 仅 debug、零指标；
   * **RPC 失败（无法判别）⇒ 照计指标 + warn 注明「落行失败」**（降级面：宁可多记一笔可解释读数，不漏记）。
   */
  private async recordEntryFeeSkip(
    code: string,
    seat: number,
    ownerId: string,
    baseScore: number,
    fee: number,
    reason: EntryFeeSkipReason,
    opActionId: string,
    gameType: GameType,
  ): Promise<void> {
    const levelName = await this.levelNameFor(gameType, baseScore);
    const fields =
      `roomCode=${code} ownerId=${ownerId} seat=${seat} baseScore=${baseScore}` +
      `${levelName === null ? '' : ` levelName=${levelName}`} feeAmount=${fee} reason=${reason} opActionId=${opActionId}`;
    try {
      const { inserted } = await this.currency.entryFeeSkip({
        roomCode: code,
        ownerId,
        seat,
        baseScore,
        feeAmount: fee,
        reason,
      });
      if (!inserted) {
        this.logger.debug(`entry_fee.skipped（同房重复，未新增行）${fields}`);
        return;
      }
      incGame(entryFeeSkippedTotal, gameType, 1, { reason });
      this.logger.warn(`entry_fee.skipped ${fields}`);
    } catch (err) {
      incGame(entryFeeSkippedTotal, gameType, 1, { reason });
      this.logger.warn(`entry_fee.skipped（落行失败）${fields} —— ${String(err)}`);
    }
  }

  /** 日志面用：`(gameType, baseScore)` → 档位名（反查失败/表不可用 ⇒ null ⇒ 字段省略——绝不为日志阻断收费链）。 */
  private async levelNameFor(gameType: GameType, baseScore: number): Promise<string | null> {
    try {
      // 多玩法（D8）：按玩法取档位表 —— 斗地主旧键 / 跑得快 `game.levels.paodekuai`。
      const levels = await this.configCache.baseScoreLevels(gameType);
      return levels.find((l) => l.baseScore === baseScore)?.name ?? null;
    } catch {
      return null;
    }
  }

  private async startAndAnnounce(
    code: string,
    baseScore: number,
    seats: Seat[],
    bindings: BotBinding[],
    strict: boolean,
    announceFirst: boolean,
    gameType: GameType,
    playerCount: number,
    /** pdk 的规则快照（D19：局中改配置不影响进行中的牌局）；斗地主为 undefined。 */
    rules: PdkRulesConfig | undefined,
    /** 内部测试钩子（Task 4.4）：仅 conformance 传入；生产 undefined。 */
    testHooks: { seed?: number; testDeck?: Card[] },
  ): Promise<boolean> {
    const players = this.buildStartPlayers(seats, bindings);
    // 🔴 匹配路径：**先公告、再开局**（见 `startRoom` 的 `announceFirst` 说明 ——
    //    否则 `game.deal` 会在玩家登记座位之前发出去，三家都收不到）
    if (announceFirst) await this.announce(code, seats, gameType, playerCount);
    let ok = true;
    try {
      /**
       * R210：`game.start` **幂等**（同 roomCode 复用会话）⇒ 失败重试恰好 1 次。
       * ⚠️ 超时（3s）与「重试恰好 1 次」都在 `GameClient.start` **内部**（§4.3 / R221：
       * `timeout()` 在 `retry()` 之内 ⇒ 每次尝试重新计时）。这里**不再**套第二层
       * `withRetry` —— 两层叠加会把「恰好 2 次尝试」变成 4 次，与 §4.3 逐字冲突。
       */
      await this.game.start({
        roomCode: code,
        gameType,
        playerCount,
        baseScore,
        players,
        ...(rules === undefined ? {} : { rules }),
        ...(testHooks.seed === undefined ? {} : { seed: testHooks.seed }),
        ...(testHooks.testDeck === undefined ? {} : { testDeck: testHooks.testDeck }),
      });
    } catch (err) {
      incGame(gameStartFailuresTotal, gameType, 1, { reason: 'start_rpc' });
      this.logger.error(`Failed to start game for room ${code}: ${String(err)}`);
      ok = false;
    }

    // strict（手动房）：开局失败**不得**写 `playing` ⇒ 提前返回（H1）
    if (!ok && strict) return false;

    // §3.1 / N31（R452）：开局成功 ⇒ 房间离开 `waiting`。**必须在 `game.start` 之后**
    //（放之前的话，会话都还没建就宣告开局）。
    await this.rooms.updateStatus(code, 'playing');
    /**
     * 监控片（规格 §2.2）：`games_started_total` 的「**确实开起来了**」点 —— 落在这里的
     * 两条纪律：
     *  ① `ok === true` 才计：`strict` 下失败已在上面早返；`strict: false`（匹配路径）
     *     的失败会照旧写 `playing`（N36 的已知边界）但**没有会话** —— 那是「假开局」，
     *     计入会让 `games_started_total − games_ended_total` 包含**永不结算**的局。
     *  ② 放在 `updateStatus` **之后**：写状态抛错 ⇒ 本轮不计；扫描器重试时
     *     `game.start` 幂等复用会话、状态写成功后**恰补记一次** —— 若放在 `game.start`
     *     之后，这条重试会把同一局计两次。
     */
    if (ok) incGame(gamesStartedTotal, gameType);
    if (!announceFirst) await this.announce(code, seats, gameType, playerCount);
    return ok;
  }

  /**
   * §9.6 第 4 条 / R207：机器人座位必须带上 `isRobot: true` **与 `botId` + `skillLevel`**
   * —— 少了后两者，game-service 无从知道该用哪个 `botId` 调 `robot.decide`
   *（§9.4 的回合驱动因此起不来）。
   *
   * ⚠️ `id` 仍是**对外** `displayId`（`Seat.userId`），内部 `botId` 只在服务间传递、永不出站。
   */
  private buildStartPlayers(
    seats: Seat[],
    botBindings: BotBinding[],
  ): Array<Record<string, unknown>> {
    const bySeat = new Map(botBindings.map((b) => [b.seat, b]));
    return seats.map((s) => {
      const bot = bySeat.get(s.seat);
      if (!bot || !s.isRobot) return { id: s.userId, seat: s.seat, isRobot: s.isRobot };
      return {
        id: s.userId,
        seat: s.seat,
        isRobot: s.isRobot,
        botId: bot.botId,
        skillLevel: bot.skillLevel,
        thinkingSpeed: bot.thinkingSpeed,
      };
    });
  }

  /**
   * 把开局广播给本进程内的 WsGateway（经由 Redis pub/sub）。
   *
   * ⚠️ **人**才收到 `room.matched`（R47：机器人不写 `match:pending`、不发 `room.matched`）。
   * 客户端收到它就 `joinMatchedRoom()` ⇒ 自动进牌桌 + 收 `game.deal`
   *（本片客户端零改动的**前提**）。
   */
  private async announce(
    code: string,
    seats: Seat[],
    gameType: GameType,
    playerCount: number,
  ): Promise<void> {
    const humans = humanSeats(seats);
    if (humans.length === 0) return;
    try {
      await this.redis.publish(
        CHANNELS.matchEvents,
        JSON.stringify({
          event: 'room.matched',
          roomCode: code,
          seats: humans,
          // 多玩法（Task 2.2 / spec §4.6.2）：客户端据此选 board / 自动 join 回传玩法。
          gameType,
          playerCount,
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to announce match for ${code}: ${String(err)}`);
    }
  }

  /** §4.2：`robot.acquire`。R210：同参数重试**恰好 1 次**（幂等由机器人池 R201 保证）。 */
  private async acquireBot(roomCode: string, seat: number, gameType: GameType): Promise<BotInstance> {
    let lastError: unknown;
    for (let i = 0; i < RPC_MAX_ATTEMPTS; i += 1) {
      try {
        // §4.3：3s 超时在 `RobotClient.acquire` 内部 —— 本方法只管「空响应 = 本次补位失败」
        const { bots } = await this.robot.acquire(roomCode, [seat], gameType);
        const bot = bots?.[0];
        if (!bot || !bot.botId || !bot.displayId) {
          throw new Error(`robot.acquire returned no bot for ${roomCode} seat ${seat}`);
        }
        return bot;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}
