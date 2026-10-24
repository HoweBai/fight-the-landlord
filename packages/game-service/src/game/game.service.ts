// packages/game-service/src/game/game.service.ts
import { Inject, Injectable, Logger, OnApplicationShutdown, Optional, forwardRef } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrCode,
  GAME_META,
  ProtocolError,
  parseGameType,
  supportsPlayerCount,
  type GameType,
} from '@fight-the-landlord/protocol';
import {
  GameState,
  isLegalTrusteeCombo,
  onManualTrusteeOff,
  onTimeoutOccurred,
  onTrusteeOff,
  onTurnConsumed,
  type GameAction,
} from '@fight-the-landlord/shared';
import {
  createBidTimer,
  createPlayTimer,
  runWithTrace,
  type TimerHandle,
} from '@fight-the-landlord/shared';
import type {
  Card,
  GameTrusteeRequest,
  GameView,
  RobotDecideResponse,
  SkillLevel,
} from '@fight-the-landlord/protocol';
import { RobotClient } from './robot.client';
import Redis, { Redis as RedisToken } from 'ioredis';
import { GameError } from './game.errors';
import { classifyRuleError } from './rule-error.mapping';
import {
  findSeatByUserId,
} from './view.builder';
import { DdzRuntime } from '../games/ddz/runtime';
import { GameRegistry } from '../games/registry';
import type { AnyGameRuntime, GameRuntime, RuntimeCtx } from '../games/runtime';
import type { GameStartedResponse, StartGameRequest } from './dto';
// R472：`game.types.ts`（模块增强）已整体删除 —— 字段形状归 `@fight-the-landlord/shared`，
// `PlayerView` 归契约包（与 §3.2「内部类型形状必须与规格一致」同源）。
import type {
  GamePlayerBase,
  GameSession,
  GameSessionBase,
  GovernanceDurations,
  PdkSession,
  SeatGovernance,
} from '@fight-the-landlord/shared';

/**
 * 多玩法片 S4：内核持有的会话联合。
 *
 * ⚠️ 存储/读写的真源仍是 `GameSessionBase` 的字段（roomCode/version/players/...）；
 * 玩法专有字段（ddz 的 bidPhase、pdk 的 lastPlayedHand）**只**经 runtime 访问 ——
 * 本文件不得按 `gameType` 写规则分支（S1 替换清单）。
 */
export type AnyGameSession = GameSession | PdkSession;

/**
 * 反序列化边界：部署窗口内的旧会话**可能没有** `gameType`/`playerCount`
 * （类型层面两个字段是必填 ⇒ 读入时必须放宽一次，再按字段缺失做迁移）。
 */
type StoredSession = Omit<GameSessionBase, 'gameType' | 'playerCount'> & {
  gameType?: GameType;
  playerCount?: number;
  bidPhase?: GameSession['bidPhase'];
};

/** Redis pub/sub 频道：对局 S→C 推送的**唯一**通路（§4.4）。 */
export const GAME_EVENTS_CHANNEL = 'game:events';

/** TTL for game sessions in Redis (1 hour, §10.4). */
const SESSION_TTL_SECONDS = 3600;

/**
 * `GameSession` 是整体状态机，`version` 是乐观锁（§6.5 / §10.2）。
 */
@Injectable()
export class GameService implements OnApplicationShutdown {
  private readonly logger = new Logger(GameService.name);
  /**
   * 进程内**缓存**，不是真源。
   *
   * 真源是 Redis 的 `game:session:{roomCode}`（§10.2）：否则无法多实例部署、
   * 重启丢全局、回合定时器无法交接。命中缓存可以省一次 IO，但未命中必须回读
   * Redis，绝不返回 null（那是偏差 A1）。
   */
  private readonly cache = new Map<string, AnyGameSession>();
  /** Maps roomCode → current active timer handle */
  private readonly timers = new Map<string, TimerHandle>();

  /**
   * §9.4 的回合驱动：`robot.decide` 客户端。
   *
   * ⚠️ **N20/P4 Task 4**：传输已从「内部 HTTP 过渡形态」换成 §4.2 的
   * `Transport.TCP` + `ClientProxy.send()`（见 `robot.client.ts`）。生产路径上由
   * `GameModule` 用 `useFactory` **从容器**装配出来（容器里拿不到 proxy 就构造不出来）。
   *
   * 字段仍可写：`game.robot.test.ts` 等大量用例构造之后直接赋值替身
   * （R284 起构造签名是 `new GameService(redis)`，见下）。
   * `null` 表示「装配层没接上」（R217 同族的缺陷形态）—— 见 `driveOneRobotTurn()`
   * 里的 fail-loud 分支：**不静默回退**，而是记 error。
   */
  @Inject(forwardRef(() => RobotClient))
  robotClient: RobotClient | null = null;

  /**
   * 思考延迟（§9.4）。**可注入**：测试注入 `async () => {}` 得到结构性判据（0 延迟）。
   *
   * ⚠️ 参数是**单次实际延迟**（已 clamp 到 [1000, 3000]）：`base` 来自
   * `session.botThinkingSpeeds[seat]`（robot-service 建池时采样的 1–3s 基础手速），
   * 每回合叠加 ±300ms 抖动；旧会话缺该字段时 `base = 2000`。
   * 最坏 3s + `robot.decide` 5s ≈ 8s，远小于 30s 回合时限。
   */
  robotDelay: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * 片① R1：**可注入的随机源**。默认 `Math.random` ⇒ 生产行为与改动前一致。
   * 测试设 `service.random = () => 0` 以获得确定的起始座位（规格 §5.2 / §5.6）。
   *
   * ⚠️ 它必须一路传到 `createSession` / `handleBid` —— **全仓只有 4 个调用点**：
   * `startGame`（`createSession`）· `bid()` · `onTurnTimeout` · `applyDecisionToSession`。
   * 最后一处在**模块级自由函数**里（没有 `this`）⇒ 必须给它加形参、由
   * `commitRobotDecision` 传进来（它是**机器人驱动链**的叫抢路径 —— 最容易漏的一处）。
   * 漏任何一处**都不会编译失败**（`createSession`/`handleBid` 的签名有默认值）
   * ⇒ 会静默退化成真随机（判据见 `test/game.service.random.test.ts`）。
   */
  random: () => number = Math.random;

  /**
   * 思考延迟抖动的随机源（§9.3）。**独立于 `random`**：
   * `game.service.random.test.ts` 对 `random` 的消费次数有精确断言
   * （座位/流局重摇/随机地主），复用本缝会把那些判据全部打乱。
   */
  robotJitterRandom: () => number = Math.random;

  /**
   * **同房间串行闸**（R208）：同一时刻至多一个在飞的 `driveRobotTurn`。
   * 否则「一名机器人动作 ⇒ finishTransition ⇒ 再驱动」会与「定时器同时驱动」叠在一起，
   * 三个机器人抢占同一次状态转移。
   */
  private readonly robotDriving = new Set<string>();

  /**
   * **R10 / T5：同房 awaited 串行队列（per-room write queue）。**
   *
   * 存的是该房**写链的队尾**（永远是一个已消解为 `undefined` 的 promise）。
   * ⚠️ **⛔ 不照 `robotDriving` 的 drop-on-reentry**：那个 `Set` 的重入直接 `return`，
   * 对「同一时刻合法」的写法（toggle 是第一个任意时刻合法的人类写者）会**静默丢写**。
   * 这里的每个入队者都**排队等待前一个完成**（awaited），不丢弃。
   *
   * 房 `Ended` 时清理条目（见 `finishTransition` 的终局分支）——房间一局制（R9）。
   */
  private readonly roomQueues = new Map<string, Promise<void>>();

  /**
   * 本服务的 Redis 连接（§10.2 的会话真源 + §4.4 的 pub/sub）。
   *
   * ⚠️ **R284（§2.4 / R267）**：连接**由容器注入**（`RedisProviderModule` 的 `Redis`
   * token），**不再**在构造函数里 `new` —— 否则健康检查只能再建**第二个**连接源
   * （本仓已有多次「同一事实两个真源」的前科）。健康检查复用**这一个**实例。
   *
   * 字段是 `public readonly`：`game-service` 的 health 门禁要断言「容器里那个
   * 连接与它**是同一个对象**」，`private` 会让那条判据只能靠间接证据。
   */
  /**
   * 多玩法片 S1：runtime 注册表（属性注入；直连构造的单测可缺省）。
   * 缺省时只允许斗地主（本地 DdzRuntime），pdk 必须由容器装配的 registry 提供。
   */
  @Optional()
  @Inject(GameRegistry)
  registry: GameRegistry | null = null;
  private readonly fallbackRuntime = new DdzRuntime();

  /** 按会话/请求的玩法取 runtime；未知/未装配的 pdk ⇒ 响亮失败。 */
  private runtime(gameType: GameType = 'doudizhu'): AnyGameRuntime {
    if (this.registry) return this.registry.get(gameType);
    if (gameType !== 'doudizhu') {
      throw new GameError(ErrCode.GAME_UNAVAILABLE, `玩法未开放：${gameType}`);
    }
    return this.fallbackRuntime;
  }

  /**
   * 按会话的玩法取 runtime。泛型在边界处擦除（各 runtime 的会话子类型不同），
   * 但**分派仍是按 `gameType`** —— 不得回落到斗地主。
   */
  private runtimeFor(session: AnyGameSession): GameRuntime<AnyGameSession> {
    return this.runtime(session.gameType) as unknown as GameRuntime<AnyGameSession>;
  }

  private runtimeCtx(actorSeat: number): RuntimeCtx {
    return {
      now: Date.now(),
      random: this.random,
      governance: this.durations(),
      actorSeat,
    };
  }

  /** 按会话玩法生成裁剪视图（ddz/pdk 各自实现；本文件不做玩法分支）。 */
  private buildSeatView(session: AnyGameSession, seat: number): GameView {
    return this.runtimeFor(session).buildView(session, seat);
  }

  constructor(
    /**
     * ⚠️ **显式 `@Inject(...)`**（本仓既有惯例，见 `session.guard.ts`）：
     * 不依赖 `emitDecoratorMetadata` 发出的 `design:paramtypes` —— tsc 构建会发它，
     * 但 **vitest/esbuild 不发** ⇒ 只靠类型的注入在单测里会静默注入 `undefined`
     * （本片实测：容器门禁因此红）。token 与类型同名，另起一个别名只为可读。
     */
    @Inject(RedisToken) public readonly redis: Redis,
  ) {}

  // ─── 存储 ───────────────────────────────────────────────────────

  /** Persist a game session to Redis with TTL. */
  private async saveSession(roomCode: string, session: AnyGameSession): Promise<void> {
    this.cache.set(roomCode, session);
    await this.redis.set(
      `game:session:${roomCode}`,
      JSON.stringify(session),
      'EX',
      SESSION_TTL_SECONDS,
    );
  }

  /**
   * Load a game session from Redis. Returns null when it truly does not exist ——
   * **以及**当键在、但 `JSON.parse` 或下面的老会话迁移抛错时（两者同在一个 `try` 里）：
   * 畸形数据一律降级成「不存在」（fail-closed，故意：坏数据不驱动游戏），只留一条
   * `Corrupt session …` 日志。
   */
  async loadSession<S extends AnyGameSession = GameSession>(
    roomCode: string,
  ): Promise<S | null> {
    const data = await this.redis.get(`game:session:${roomCode}`);
    if (!data) return null;
    try {
      const parsed = JSON.parse(data) as StoredSession;
      /**
       * 多玩法片 S1：部署窗口内的旧会话没有 `gameType`/`playerCount`。
       * - 有 `bidPhase` ⇒ 旧 ddz 会话，补 `doudizhu`/3；
       * - 无 `bidPhase` ⇒ 不是可识别的 ddz 会话（pdk 会话一律写 `gameType`，
       *   缺了即 fail closed —— 不把跑得快当斗地主）。
       * 不改 `version`、不落盘（下一次状态转移自然写回）。
       */
      if (parsed.gameType === undefined) {
        if (parsed.bidPhase !== undefined) {
          parsed.gameType = 'doudizhu';
          parsed.playerCount = 3;
        } else {
          throw new Error('session without gameType and without ddz fields');
        }
      }
      if (parsed.playerCount === undefined) parsed.playerCount = 3;

      // ── 跑得快会话：只做形状守卫；玩法字段交给 PdkRuntime（S4）──────────
      if (parsed.gameType === 'paodekuai') {
        const pdk = parsed as unknown as PdkSession;
        if (
          !pdk.rules ||
          !Array.isArray(pdk.players) ||
          !Array.isArray(pdk.actionLog) ||
          typeof pdk.currentPlayer !== 'number' ||
          typeof pdk.lastPlayerIdx !== 'number'
        ) {
          throw new Error('corrupt pdk session');
        }
        return pdk as unknown as S;
      }

      const session = parsed as unknown as GameSession;
      const bp = session.bidPhase;
      /**
       * 🔴 片① R2 的**一次性迁移**（规格 §7.1）：老会话（本片部署前写出的）运行时**没有**
       * `firstCaller` / `antiRobGranted`（类型层面是必填 ⇒ 只能对 `undefined` 做判定）。
       *
       * ⚠️ 这是全仓**唯一**允许读 `decisions` 做判定的位置 —— 老数据里它是 `firstCaller`
       * 的唯一真源（§2 的「禁止读 decisions」只针对新代码的判定逻辑）。
       *
       * ⚠️ `bp &&` 守卫必须在：`view.builder` 全程用 `bidPhase?.` 兜底，缺 `bidPhase`
       * 的会话若在这里直接取字段会抛 TypeError（现有 try 只包 `JSON.parse` 那一行）。
       *
       * ⚠️ **不改 `version`**（改了会破坏在途客户端的 CAS），也**不落盘** ——
       * 迁移改的是 `JSON.parse` 出来的新对象（无别名问题），下一次状态转移经
       * `finishTransition` 自然把两个新字段写回。
       */
      if (bp && (bp as { firstCaller?: number }).firstCaller === undefined) {
        const firstGrab = (bp.decisions ?? []).find((d) => d.grab);
        // ⚠️ `decisions` **整个缺失**（协议⑦ 之前的会话）时**不能**落 -1：否则
        //     `grabActions ∈ {1,2}` 的中途房仍会「必然误触发反抢」⇒ `currentBidder = -1`
        //     ⇒ 每次 `game.bid` 抛 Not your turn、超时取 `players[-1]` ⇒ 每 30s 空转一次、
        //     房间永久停摆。退化到 `landlordCandidate` 即 `firstCaller === landlordCandidate`
        //     ⇒ 「不派发反抢」= **旧行为**，正是兼容所需。
        bp.firstCaller = firstGrab?.seat ?? (bp.landlordCandidate >= 0 ? bp.landlordCandidate : -1);
        // 已走满 3 拍 ⇒ 反抢权「已用过/已作废」⇒ 阈值抬到 4，不再派发反抢帧。
        bp.antiRobGranted = bp.grabActions >= 3;
      }
      /**
       * 挂机治理 T3（C6b / 规格 §0）：部署窗口内的旧会话（SESSION_TTL 1h 内写出）的
       * `players[i]` **没有** `timeoutCount` / `trustee` —— 类型层是必填 ⇒ 只能对
       * `undefined` 判定。缺省为「未超时 / 未托管」：不迁移的话 `undefined + 1 = NaN`，
       * 治理量会静默失效（永远落不进 accel/trustee 档，也永远不托管）。
       *
       * 与上面的 bidPhase 迁移同款：改的是 `JSON.parse` 出来的新对象（无别名问题）、
       * **不落盘** —— 下一次状态转移经 `finishTransition` 自然写回。
       * `players` 缺失/非数组属坏形状 ⇒ 由外层 `try` 降级成「不存在」（fail-closed）。
       */
      session.players = session.players.map((p) => ({
        ...p,
        timeoutCount: p.timeoutCount ?? 0,
        trustee: p.trustee ?? false,
      }));
      return session as unknown as S;
    } catch {
      this.logger.error(`Corrupt session in Redis for room ${roomCode}`);
      return null;
    }
  }

  /**
   * 读写入口：缓存 → Redis（§7.4 偏差 A1 的修正）。
   * `loadSession()` 此前是死代码，现在它是唯一的状态来源。
   */
  async getSession<S extends AnyGameSession = GameSession>(roomCode: string): Promise<S | null> {
    const cached = this.cache.get(roomCode);
    if (cached) return cached as S;
    const loaded = await this.loadSession<S>(roomCode);
    if (loaded) this.cache.set(roomCode, loaded);
    return loaded;
  }

  /**
   * 监控片（规格 §2.2）：`games_active` 的**只读**读数点 —— 本实例缓存里的会话数。
   *
   * 🔴 **per-instance 语义**（HELP 已注明）：`cache` 是**进程内缓存**、不是全栈会话表
   *（真源在 Redis，多实例共享；各实例的 cache 各自持有自己服务过的会话）。
   * 只暴露读数，不给任何写路径 —— 缓存的生命周期仍由 `saveSession`/`loadSession` 管。
   */
  activeSessionCount(): number {
    return this.cache.size;
  }

  // ─── 对外契约（§4.2）────────────────────────────────────────────

  /**
   * `game.start`：room-service 开局时调用（幂等——同 roomCode 重复调用不重新发牌）。
   * 内部 RPC 入口，**绝不可**直接对外路由（§4.2）。
   */
  async startGame(dto: StartGameRequest): Promise<GameStartedResponse> {
    const gameType = parseGameType(dto.gameType);
    const playerCount = dto.playerCount ?? GAME_META[gameType].defaultPlayerCount;
    if (!supportsPlayerCount(gameType, playerCount)) {
      throw new GameError(ErrCode.GAME_UNAVAILABLE, `玩法 ${gameType} 不支持 ${playerCount} 人`);
    }

    const existing = await this.getSession(dto.roomCode);
    if (existing) {
      // 幂等只对**同玩法/同人数/同规则快照**成立；不同玩法不得静默复用旧会话。
      if (
        existing.gameType !== gameType ||
        existing.playerCount !== playerCount ||
        JSON.stringify(existing.rules ?? null) !== JSON.stringify(dto.rules ?? null)
      ) {
        throw new GameError(ErrCode.GAME_UNAVAILABLE, '同一房间的玩法/人数/规则不一致');
      }
      this.logger.log(`Reusing existing session for room ${dto.roomCode}`);
      return { roomCode: existing.roomCode, state: existing.state, version: existing.version };
    }

    if (dto.players.length !== playerCount) {
      throw new GameError(
        ErrCode.BAD_PARAM,
        `game.start 需要 ${playerCount} 名玩家，收到 ${dto.players.length} 名`,
      );
    }

    // 2026-10-21：底分不再有代码兜底；0/负数/小数绝不能静默流入结算。
    // 位置在幂等早退之后：重复 game.start 仍返回既有会话（即便本次载荷非法）。
    if (!Number.isInteger(dto.baseScore) || dto.baseScore <= 0) {
      throw new GameError(ErrCode.BAD_PARAM, '底分必须是正整数');
    }

    const players = [...dto.players].sort((a, b) => a.seat - b.seat);
    /**
     * 内部测试钩子（Task 4.4 / spec §5.2）：`seed`/`testDeck` **仅在
     * `INTERNAL_TEST_HOOKS=1` 时生效**；关闭时**忽略 + WARN**（不拒绝、不 10001 ——
     * 生产客户端即使误带也不能因此开局失败，但也绝不能让确定性牌堆流入生产）。
     */
    const hooksEnabled = process.env.INTERNAL_TEST_HOOKS === '1';
    if ((dto.seed !== undefined || dto.testDeck !== undefined) && !hooksEnabled) {
      this.logger.warn(
        `Ignoring test hooks (seed/testDeck) for room ${dto.roomCode}: INTERNAL_TEST_HOOKS is not '1'`,
      );
    }
    let created: AnyGameSession;
    try {
      created = this.runtime(gameType).create({
        roomCode: dto.roomCode,
        gameType,
        playerCount,
        baseScore: dto.baseScore,
        players,
        rules: dto.rules,
        random: this.random,
        seed: hooksEnabled ? dto.seed : undefined,
        testDeck: hooksEnabled ? dto.testDeck : undefined,
      });
    } catch (err) {
      // 非法 testDeck / 非法规则快照（ProtocolError）⇒ 契约的 `10001`，不是 500。
      if (err instanceof ProtocolError) {
        throw new GameError(ErrCode.BAD_PARAM, err.message);
      }
      throw err;
    }
    const started: AnyGameSession = { ...created, turnDeadlineAt: this.deadlineFor(created) };

    await this.saveSession(dto.roomCode, started);
    await this.publishSeatViews('game.started', started);
    this.startTurnTimer(dto.roomCode, started);
    this.logger.log(`Game created for room ${dto.roomCode} (version ${started.version})`);
    // §9.4：开局之后同样要检查「当前行动者是不是机器人」（叫抢第一个行动者可能就是它）
    void this.driveRobotTurn(dto.roomCode);
    return { roomCode: started.roomCode, state: started.state, version: started.version };
  }

  /** `game.snapshot`：**完整** `GameSession`。仅限服务间调用（§4.2 / §7.1）。 */
  async getSnapshot<S extends AnyGameSession = GameSession>(roomCode: string): Promise<S | null> {
    return this.getSession<S>(roomCode);
  }

  /** `game.view`：按座位裁剪的 `GameView`（§4.2 / §6.4）。对外路由只能走这一个。 */
  async getView(roomCode: string, seat: number): Promise<GameView | null> {
    const session = await this.getSession(roomCode);
    if (!session) return null;
    return this.buildSeatView(session, seat);
  }

  /**
   * **R224（§4.2 逐字）**：座位**只**由 `userId` 解析 —— HTTP 面与 RPC 面共用的
   * **唯一**入口。
   *
   * §4.2：「**seat 由服务端从 userId 解析，不由调用方提供** —— 否则调用方可指定他人座位，
   * 等于绕过裁剪。」因此两个面（`GET /api/games/:roomCode` 与 `@MessagePattern('game.view')`）
   * **都**只把 `userId` 传进来，由这里做唯一一次 `findSeatByUserId()`。
   * 全仓**不得**再出现第二处对 `findSeatByUserId` 的调用点（机械闸钉住）。
   *
   * 错误码与旧 HTTP 控制器**逐字同码**（不新增错误码）：
   *  - 对局不存在 ⇒ `12001 ROOM_NOT_FOUND`
   *  - 调用者不在本局 ⇒ `12004 NOT_IN_ROOM`
   */
  async getViewForUser(roomCode: string, userId: string): Promise<GameView> {
    const session = await this.getSession(roomCode);
    if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, 'Game not found', 404);

    const seat = findSeatByUserId(session, userId);
    if (seat < 0) throw new GameError(ErrCode.NOT_IN_ROOM, 'You are not in this game', 403);

    const view = await this.getView(roomCode, seat);
    if (!view) throw new GameError(ErrCode.ROOM_NOT_FOUND, 'Game not found', 404);
    return view;
  }

  /**
   * `game.trustee`：托管开关（挂机治理 T4 / 规格 C7–C14、R6/R8）。
   *
   * 守卫顺序即规格（**C7：守卫先于 no-op**）：组合 → 会话 → 态 → 座位 → 机器人 → no-op。
   * 通过后是**轻量转移**：save + version+1 + `publishSeatViews`，**不经 `finishTransition`**
   *（治理态变更不算回合转移：不结算、不重挂满额 timer、不驱动机器人）。
   *
   * R8 分支 —— **仅当本人恰是当前行动者**（否则 C13：timer/deadline 均不动）：
   *  ① `on=true` ⇒ deadline 收缩到 `max(0, min(剩余, trustee 档))`（min 不延长、clamp 非负）；
   *  ② `on=false && via='manual' && 已达到自动托管阈值`（C4′）⇒ count 清零 + 重排到 **accel 档**
   *     （给回来的玩家一个可操作窗口；旧短计时器被 `clearTimer` 清掉，不会抢先自动出牌）；
   *  ③ `on=false && via='manual' && 阈值未到`（手动开启的托管）⇒ 只清 trustee、count 不动；
   *     不重排不重算（本轮仍按原短延时自动走一次，防续命）；
   *  ④ `on=false && via='reconnect'`（原 true 由 no-op 守卫保证）⇒ R6 例外：
   *     只清 trustee、count 保留；按 count 基线重排（count>0 ⇒ accel，否则 normal）。
   *
   * 「先改 deadline 再 publish」由调用顺序保证：`rescheduleTurn`（写 deadline + 装 timer）
   * 先于 `saveSession` / `publishSeatViews`。
   *
   * ⚠️ R10 串行闸（T5）：本方法**入口**包入 per-room 队列（四写者之一）——
   * 读→算→落盘→推送整段都在锁内，因此「同 tick 出牌 + toggle」不会读到同一版本。
   */
  async applyTrustee(dto: GameTrusteeRequest): Promise<{ version: number }> {
    return this.runSerialized(dto.roomCode, () => this.applyTrusteeLocked(dto));
  }

  private async applyTrusteeLocked(dto: GameTrusteeRequest): Promise<{ version: number }> {
    if (!isLegalTrusteeCombo(dto.via, dto.on)) {
      throw new GameError(ErrCode.BAD_PARAM, '非法 trustee 组合');
    }
    const session = await this.getSession(dto.roomCode);
    if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, '房间不存在');
    if (session.state === GameState.Init) {
      throw new GameError(ErrCode.GAME_NOT_STARTED, '对局未开始');
    }
    if (session.state === GameState.Ended) throw new GameError(ErrCode.GAME_OVER, '对局已结束');
    const idx = session.players.findIndex((p) => p.id === dto.userId);
    if (idx < 0) throw new GameError(ErrCode.NOT_IN_ROOM, '不在该房');
    if (this.isBotSeat(session, idx)) throw new GameError(ErrCode.BAD_PARAM, '机器人座位无治理量');

    // 守卫之后才允许 no-op（C8）：目标值 = 现值 ⇒ 零落盘 / 零 bump / 零推送。
    const before = this.governanceOf(session.players[idx]);
    if (before.trustee === dto.on) return { version: session.version };

    const d = this.durations();
    /**
     * C4′（本片）：是否「已达到自动托管阈值」。与 `onTimeoutOccurred` 的置位条件同源
     * （`timeoutCount >= after`），因此只有系统已/应接管的托管才允许在 manual off 时清零；
     * 手动 on→off（阈值未到）不清零——否则两次 UI 操作即可无限绕过加速档（B1）。
     */
    const autoTrusted = before.timeoutCount >= d.after;

    // 联合会话的 spread 在类型上分成两支；players 的具体子类型由 runtime 维护，
    // 这里只改治理态（基类字段），因此在边界做一次结构化 cast。
    const updated = {
      ...session,
      players: session.players.map((p, i) =>
        i === idx
          ? {
              ...p,
              // off 分来源：自动托管 ⇒ 清零（C4′）；手动开启的托管 / reconnect ⇒ 只清 trustee（C4）。
              ...(dto.on
                ? { trustee: true }
                : dto.via === 'manual' && autoTrusted
                  ? onManualTrusteeOff(this.governanceOf(p))
                  : onTrusteeOff(this.governanceOf(p))),
            }
          : p,
      ),
      version: session.version + 1,
    } as AnyGameSession;

    // R8：只有「本人是当前行动者」才有 timer/deadline 语义（C13 反之不动）。
    const actorSeat = this.runtimeFor(session).currentActor(session);
    if (actorSeat === idx) {
      if (dto.on) {
        // R8①：不延长（min），并 clamp 到非负。
        const remaining = Math.max(0, session.turnDeadlineAt - Date.now());
        this.rescheduleTurn(dto.roomCode, updated, Math.min(remaining, d.trustee));
      } else if (dto.via === 'reconnect' && before.trustee) {
        // R6 例外（C14）：按 count 基线重排（count>0 ⇒ accel，否则 normal）。
        const count = this.governanceOf(updated.players[idx]).timeoutCount;
        this.rescheduleTurn(dto.roomCode, updated, count > 0 ? d.accel : d.normal);
      } else if (dto.via === 'manual' && autoTrusted) {
        /**
         * C4′（D7）：自动托管取消且本人正是行动者 ⇒ 给回来的玩家一个可操作的加速档窗口。
         * `rescheduleTurn` 内部先 `clearTimer` ⇒ 旧短计时器不会在 2s 后抢先自动出牌；
         * 一次自动托管最多换一次 10s（随后 count=0，无法靠反复 on/off 续命）。
         */
        this.rescheduleTurn(dto.roomCode, updated, d.accel);
      }
      // R8②：manual off（手动开启的托管）⇒ 不重排不重算（本轮仍按原短延时自动走一次）。
    }

    await this.saveSession(dto.roomCode, updated);
    await this.publishSeatViews('game.state_updated', updated);
    return { version: updated.version };
  }

  // ─── 动作 ───────────────────────────────────────────────────────

  /**
   * 动作执行 + 按调用者座位裁剪的视图。
   *
   * 动作的响应**绝不能**回吐完整 `GameSession`（含三家手牌）—— 那正是 S2/S8
   * 的泄漏形态，只是换了个入口。返回 `PlayerView` 让「谁调用就只看到谁」这条
   * 规则在一次动作里也成立。
   */
  async actAndView(
    roomCode: string,
    userId: string,
    action: 'bid' | 'play' | 'pass',
    payload: { grab?: boolean; cards?: Card[] },
    baseVersion?: number,
  ): Promise<GameView> {
    await this.applyById(roomCode, userId, action, payload, baseVersion);
    const session = await this.getSession(roomCode);
    if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, `Game not found: ${roomCode}`, 404);
    const seat = findSeatByUserId(session, userId);
    if (seat < 0) throw new GameError(ErrCode.NOT_IN_ROOM, 'You are not in this game', 403);
    return this.buildSeatView(session, seat);
  }

  private async applyById<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    action: 'bid' | 'play' | 'pass',
    payload: { grab?: boolean; cards?: Card[] },
    baseVersion?: number,
  ): Promise<S> {
    switch (action) {
      case 'bid':
        return this.bid<S>(roomCode, userId, payload.grab ?? false, baseVersion);
      case 'play':
        return this.playCards<S>(roomCode, userId, payload.cards ?? [], baseVersion);
      case 'pass':
        return this.pass<S>(roomCode, userId, baseVersion);
    }
  }

  async bid<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    grab: boolean,
    baseVersion?: number,
  ): Promise<S> {
    return this.applyAction<S>(roomCode, userId, baseVersion, { kind: 'bid', grab });
  }

  async playCards<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    cards: Card[],
    baseVersion?: number,
  ): Promise<S> {
    return this.applyAction<S>(roomCode, userId, baseVersion, { kind: 'play', cards });
  }

  async pass<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    baseVersion?: number,
  ): Promise<S> {
    return this.applyAction<S>(roomCode, userId, baseVersion, { kind: 'pass' });
  }

  /**
   * **R10：同房 awaited 串行队列**（T5）。
   *
   * 四个写者（`applyAction` / `onTurnTimeout` / `applyTrustee` / `commitRobotDecision`）
   * 的**入口**包这一层；临界区覆盖 **read → compute → save → publish → startTurnTimer 整段**。
   *
   * `prev.then(fn, fn)`：前一个任务失败也继续跑下一个（队尾被归一成永不 reject 的
   * `Promise<void>`），失败本身只抛给**该次**调用方 —— 一个客户端动作被拒不会毒化整条队列。
   *
   * ⚠️ **timer 回调不另包这一层**（r1 重要 9）：`onTurnTimeout` 自己已在入口入队，
   * 回调再包一次 = 在外层任务里等待自己入队的内层任务 = **自锁停摆**
   * （R106/R525 反复修的正是「房间再也没有活动计时器」形态）。
   *
   * ⚠️ **⛔ 锁内不得递归调 `driveRobotTurn`**（r6）：`robotDriving` 的 drop-on-reentry
   * 会让递归静默 no-op ⇒ 重驱退化。被打断的机器人提交**返回 true**，由
   * `driveRobotTurn` 的循环**下一轮**重新读会话再驱动。
   */
  private runSerialized<T>(roomCode: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.roomQueues.get(roomCode) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.roomQueues.set(roomCode, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * 所有动作的唯一执行路径。
   *
   * 顺序即规格（§6.5）：
   *  1. 会话存在 → 否则 `12001`
   *  2. `state === 'init'` → `13009`（对局尚未开始）
   *  3. 已结束 → `13005`
   *  4. CAS：`baseVersion !== session.version` → `13004`（唯一处置是刷新快照）
   *  5. 交给规则引擎；它抛的字符串错误按内容映射为 `12003`/`13006`
   *
   * 身份**只**来自调用方传入的 userId（网关注入的 `X-User-Id`，§5.2），
   * 规则引擎内部再由 id 定位座位（§5.3）。
   */
  private async applyAction<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    baseVersion: number | undefined,
    action: GameAction,
  ): Promise<S> {
    // R10：人类动作是四写者之一 —— 入口入队，临界区覆盖整段转移（T5）。
    return this.runSerialized(roomCode, () =>
      this.applyActionLocked<S>(roomCode, userId, baseVersion, action),
    );
  }

  private async applyActionLocked<S extends AnyGameSession = GameSession>(
    roomCode: string,
    userId: string,
    baseVersion: number | undefined,
    action: GameAction,
  ): Promise<S> {
    const session = await this.getSession(roomCode);
    if (!session) throw new GameError(ErrCode.ROOM_NOT_FOUND, `Game not found: ${roomCode}`, 404);
    if (session.state === GameState.Init) {
      throw new GameError(ErrCode.GAME_NOT_STARTED, 'Game has not started', 409);
    }
    if (session.state === GameState.Ended) {
      throw new GameError(ErrCode.GAME_OVER, 'Game is over', 409);
    }
    if (baseVersion !== undefined && baseVersion !== session.version) {
      throw new GameError(
        ErrCode.VERSION_CONFLICT,
        `Version conflict: expected ${baseVersion}, current ${session.version}`,
        409,
      );
    }

    this.clearTimer(roomCode);
    let updated: AnyGameSession;
    try {
      const actorSeat = findSeatByUserId(session, userId);
      // 保留既有错误文案：`classifyRuleError` 靠它映射 12004。
      if (actorSeat < 0) throw new Error(`Player ${userId} not found`);
      updated = this.runtimeFor(session).applyAction(session, action, this.runtimeCtx(actorSeat)).session;
    } catch (err) {
      const code = classifyRuleError(err);
      /**
       * N37 / R525：`clearTimer` 在**动作执行之前**（上面那一行）就无条件清掉了旧句柄 ——
       * 若这里直接抛错，本房间就**再也没有活动计时器**（该回合零时限）：当前玩家若掉线/不操作，
       * 对局**永久停摆**，而客户端只会看到一次「动作被拒」。
       * ⇒ 按 `onTurnTimeout` 的 catch（`this.startTurnTimer(roomCode, session, { forceNormal: true });`）**同形**重挂：
       *   用**当前会话**、**不落盘、不改 `version`** —— 拒绝不等于一次状态转移，
       *   替服务端编造转移会让 `version` 与客户端观测错位（R106③ 同族）。
       *
       * ⚠️ 日志级别是 **`warn`** 而不是 `error`（执行期裁决 **R528** 修正 R525 的措辞）：
       *    动作被拒是**正常的客户端行为**（点错、越权尝试），不是服务端异常；
       *    用 `error` 会把正常路径刷成错误日志、淹没真正的异常。
       */
      this.logger.warn(
        `Action rejected for room ${roomCode} (user ${userId}, code ${code}): ${(err as Error).message}`,
      );
      this.startTurnTimer(roomCode, session, { forceNormal: true });
      throw new GameError(code, (err as Error).message, code === ErrCode.NOT_YOUR_TURN ? 403 : 400);
    }

    /**
     * 挂机治理 C3：**手动**回合消耗型动作成功 ⇒ 清零 + 解除托管。
     *
     * ⚠️ 必须写在 handler 返回的 **`updated`** 上（新 players 数组）—— 写
     * `session.players` 会被新数组覆盖、**静默丢失**。⚠️ 必须在 `finishTransition`
     * **之前**（它负责落盘/推送/重挂）。⚠️ 只写人类路径：超时链直接调
     * `handleBid`/`handlePlayTimeout`，不经这里 ⇒ 超时不会复位（C1 才达得到 3）。
     * 成功的动作必然来自行动者本人 ⇒ 按 `userId` 定位到的座位就是本次被消耗的回合。
     */
    const consumedSeat = findSeatByUserId(updated, userId);
    if (consumedSeat >= 0) {
      updated.players[consumedSeat] = {
        ...updated.players[consumedSeat],
        ...onTurnConsumed(this.governanceOf(updated.players[consumedSeat])),
      };
    }

    updated.turnDeadlineAt = this.deadlineFor(updated);
    await this.finishTransition(roomCode, updated);
    return updated as unknown as S;
  }

  /** 结算 + 持久化 + 推送 + 重挂定时器。 */
  private async finishTransition(roomCode: string, session: AnyGameSession): Promise<void> {
    const runtime = this.runtimeFor(session);
    if (runtime.isFinished(session)) {
      session = runtime.finish(session, Date.now());
      this.clearTimer(roomCode);
      await this.saveSession(roomCode, session);
      // N17/R187：局终也要下发 `state==='ended'` 的裁剪视图 —— 它就是此前**整体缺失**的
      // 「最后一手」视图（切片 9 实测：逐手在线可观测 19/20、15/16）。
      // 顺序不可反：§6.7 要求同一次转移内 `game.state_update` 先到并被客户端应用，
      // 否则结算渲染时看不到最终手牌张数（`game.settlement` 与 `game.current_turn` 都不带 `cardCounts`）。
      await this.publishSeatViews('game.state_updated', session);
      await this.publishEnded(roomCode, session);
      // R10 / T5：房 Ended ⇒ 清理该房的串行队列条目（房间一局制，R9）。
      // 已入队的残余写者在 Ended 后都是无写路径（applyAction/applyTrustee 抛 13005，
      // onTurnTimeout 由回合身份复核放弃，机器人提交按 state/actor 复验放弃）⇒ 清理安全。
      this.roomQueues.delete(roomCode);
      const winner =
        session.gameType === 'doudizhu' ? session.winner : session.winnerSeats?.join(',');
      this.logger.log(`Game ${roomCode} ended. Winner: ${winner ?? 'unknown'}`);
      return;
    }

    await this.saveSession(roomCode, session);
    await this.publishSeatViews('game.state_updated', session);
    this.startTurnTimer(roomCode, session);
    // §9.4：**每一次**状态转移之后都检查当前行动者（顺序：落盘 → 推送 → 重挂计时器 → 驱动）
    void this.driveRobotTurn(roomCode);
  }

  // ─── 推送（§4.4）────────────────────────────────────────────────

  /**
   * 发布**按座位预先裁剪**的视图；room-service 只按 seat 投递，不做业务判断。
   *
   * 这是对局 S→C 的唯一通路：game-service 不持有任何 socket 连接（§4.1）。
   */
  private async publishSeatViews(
    event: 'game.started' | 'game.state_updated',
    session: AnyGameSession,
  ): Promise<void> {
    const seatViews = this.runtimeFor(session).buildAllViews(session);
    await this.redis.publish(
      GAME_EVENTS_CHANNEL,
      JSON.stringify({
        event,
        roomCode: session.roomCode,
        gameType: session.gameType,
        playerCount: session.playerCount,
        version: session.version,
        seatViews,
      }),
    );
  }

  private async publishEnded(roomCode: string, session: AnyGameSession): Promise<void> {
    const runtime = this.runtimeFor(session);
    // runtime.settle() 返回契约结算形状（ddz 9 键 / pdk 向量）⇒ **不得**再拼一次（R187）。
    const result = runtime.settle(session);
    // 记录片 T3：附 `record` 信封；旧会话无快照 ⇒ 键不存在（runtime.buildRecord 的窗口守卫）。
    const record = runtime.buildRecord(session);
    await this.redis.publish(
      GAME_EVENTS_CHANNEL,
      JSON.stringify({
        event: 'game.ended',
        roomCode,
        gameType: session.gameType,
        playerCount: session.playerCount,
        version: session.version,
        result,
        ...(record ? { record } : {}),
      }),
    );
  }

  /** 显式发布 `game.ended`（结算由调用方给出）。Exposed for testing. */
  async notifyRoomEnded(
    roomCode: string,
    result: { winner: 'landlord' | 'farmer' } & Record<string, unknown>,
  ): Promise<void> {
    await this.redis.publish(
      GAME_EVENTS_CHANNEL,
      JSON.stringify({ event: 'game.ended', roomCode, result }),
    );
  }

  // ─── 定时器（玩法 §9.2）─────────────────────────────────────────

  async onApplicationShutdown(): Promise<void> {
    for (const handle of this.timers.values()) {
      handle.clear();
    }
    this.timers.clear();
    await this.redis.quit();
  }

  // ─── 挂机治理（规格 C1–C6b / C10）──────────────────────────────

  /** 唯一 env 读取点（`||` 非 `??`）。 */
  private durations(): GovernanceDurations {
    return {
      normal: Number(process.env.GAME_TURN_TIMEOUT_MS) || 30_000,
      accel: Number(process.env.GAME_TURN_TIMEOUT_ACCEL_MS) || 10_000,
      trustee: Number(process.env.GAME_TRUSTEE_DELAY_MS) || 2_000,
      after: Number(process.env.GAME_TRUSTEE_AFTER) || 3,
    };
  }

  /**
   * 机器人判定（⚠️ 任务书 r2 阻断 1 勘正）：`botIds` 是**按座位的内部 botId 数组**
   * （可选字段），`GamePlayer.id` 是对外 displayId（`p_…`）——两者**恒不相等**，
   * ⛔ 不可用 `includes(p.id)`。正确谓词与 `driveRobotTurn()` 同款：该座位有 botId
   * ⇒ 机器人。⛔ 也不用 `isBot`——它在生产恒为 false（那会让豁免全线失效）。
   */
  private isBotSeat(session: AnyGameSession, seatIdx: number): boolean {
    return session.botIds?.[seatIdx] !== undefined;
  }

  /** 所有 deadline 写入点统一走它（按**下一行动者**档；机器人/缺位 ⇒ normal）。 */
  private deadlineFor(session: AnyGameSession): number {
    const runtime = this.runtimeFor(session);
    const idx = runtime.currentActor(session);
    const d = this.durations();
    const p = idx >= 0 ? session.players[idx] : undefined;
    const ms =
      p === undefined || this.isBotSeat(session, idx)
        ? d.normal
        : runtime.turnDuration(session, idx, d);
    return Date.now() + ms;
  }

  /** 安全缺省（旧会话/残缺形状）：缺位不抛。 */
  private governanceOf(p: GamePlayerBase | undefined): SeatGovernance {
    return { timeoutCount: p?.timeoutCount ?? 0, trustee: p?.trustee ?? false };
  }

  private startTurnTimer(
    roomCode: string,
    session: AnyGameSession,
    opts?: { forceNormal?: boolean; overrideMs?: number },
  ): void {
    this.clearTimer(roomCode);
    if (session.state === GameState.Ended || session.state === GameState.Init) return;

    // 时长优先级（逐字，⚠️ r2 次要 5）：overrideMs（R8① min）> forceNormal（R106）> 默认档。
    const d = this.durations();
    const timeoutMs =
      opts?.overrideMs ??
      (opts?.forceNormal ? d.normal : this.deadlineFor(session) - Date.now());
    const runtime = this.runtimeFor(session);
    const timerFn = runtime.timerPhase(session) === 'bid' ? createBidTimer : createPlayTimer;
    /**
     * R10 / T5（r2 次要 6）：回调只捕获**回合身份** `{actorSeat, deadlineAt}`，
     * 复核发生在 `onTurnTimeout` 的**锁内**（同一写者的入口）。
     * ⚠️ **⛔ 回调不另包 `runSerialized`** —— `onTurnTimeout` 自己已在入口入队，
     * 再包一层 = 外层任务等自己入队的内层任务 = 自锁停摆（r1 重要 9）。
     * ⚠️ 捕获的是**安装时**的回合身份（`deadlineAt` 取 `session.turnDeadlineAt`，
     * 而不是 `Date.now() + timeoutMs`）：R106 的 forceNormal 重挂不改 deadline，
     * 复核要能区分「回合被换掉」与「同一回合的重挂」。
     */
    const expected = {
      actorSeat: runtime.currentActor(session),
      deadlineAt: session.turnDeadlineAt,
    };
    const handle = timerFn(() => {
      // **R1107 / 判据 11**：超时链**不是**「没有来源」—— 它以「**这次超时**」为来源
      // ⇒ 回调里自建一个 traceId + `source: 'timer'`（spec §3 载体表的「定时器」行）。
      // ⚠️ 包裹点必须在**回调体**：包进 `onTurnTimeout` 内部也能让超时那一行带上 id，
      //    但这条链后续长出来的步骤会重新掉回 `bootstrap` —— 判据要的是「**这一轮**
      //    从被触发到结束都在同一条链上」（ALS 按**谁发起的**传播，定时器正是发起者）。
      void runWithTrace({ traceId: randomUUID(), source: 'timer' }, () =>
        this.onTurnTimeout(roomCode, expected),
      );
    }, timeoutMs);
    this.timers.set(roomCode, handle);
    this.logger.log(`Turn timer started for room ${roomCode} (${session.state})`);
  }

  /**
   * R8/R6：**只**重排当前回合的截止时刻与计时器（不落盘、不推送）。
   *
   * ⚠️ 顺序钉死：先写 `turnDeadlineAt`，再 `startTurnTimer(..., { overrideMs })`。
   * publish 由调用方（`applyTrustee`）在 save 后统一做 ⇒ 出站视图携带的必然是**新** deadline。
   */
  private rescheduleTurn(roomCode: string, session: AnyGameSession, ms: number): void {
    session.turnDeadlineAt = Date.now() + ms;
    this.startTurnTimer(roomCode, session, { overrideMs: ms });
  }

  private clearTimer(roomCode: string): void {
    const handle = this.timers.get(roomCode);
    if (handle) {
      handle.clear();
      this.timers.delete(roomCode);
    }
  }

  /**
   * 回合超时 = 服务端**内部自动行为**，不向客户端返回错误码（§11.2 的 `13007` 保留不用）。
   *
   * 叫抢阶段的行动者是 `bidPhase.currentBidder`，**不是** `currentPlayer`
   * （玩法 §9.1 / 偏差 C28）—— 叫抢期 `currentPlayer` 恒为 0，用它会替错人决策。
   *
   * C22① / R106：超时动作**抛错**时（今天的**唯一**可达形态是防御分支：当前行动者手牌为空
   * ⇒ `handlePlayTimeout` 抛 `Player … has no card to play`；切片 9 之前那条
   * 「最后出牌者超时 ⇒ `handlePass` 抛 `Cannot pass when you last played`」已随 C5 的修复消失，
   * 因为 `handlePlayTimeout` 只在**过牌合法**时才过牌）必须「**不静默吞错 + 重挂计时器**」：
   *  ① 记 `logger.error`（带房间、座位、原始错误）；
   *  ② 用**当前会话**重挂 30s 计时器 —— 否则这个房间从此再也没有活动计时器，
   *     之后所有回合都不再超时，对局**永久停摆**（`applyAction` 一开头就 clearTimer，
   *     而 `finishTransition` 只在成功路径重挂）；
   *  ③ **不修改会话、不落盘、不推送** —— 抛错意味着这次自动动作没有发生，
   *     替服务端编造一次状态转移会让 `version` 与客户端观测错位。
   *
   * ⚠️ 出牌阶段走 `handlePlayTimeout`（§9.1 的**可执行**半边，C5/R162/R163）：
   * 首出 / 一墩回到最后出牌者 ⇒ 打**手牌中点数最小的单张**（单张永远合法 ⇒ 一定可执行），
   * 跟牌 ⇒ 过牌。§9.1 的 ①②③（同型最小可压 / 最小炸弹 / 王炸）依赖 `rule/autoplay.ts`
   * 补满 14 种牌型（对账表 E4）⇒ 归**切片 11**。
   */
  // ─── §9.4 机器人回合驱动 ────────────────────────────────────────

  /**
   * §9.4：**当前行动者是机器人 ⇒ 由 game-service 推进它的回合**（客户端不参与）。
   *
   * 行动者判定（与玩法 §9.1 一致）：`bidding` ⇒ `bidPhase.currentBidder`；
   * `playing` ⇒ `currentPlayer`；`ended`/`init` ⇒ 不驱动。
   *
   * **同房间串行**（R208）：重入直接返回；因此本方法内的循环负责「连续多个机器人」的情形
   * （例如两名机器人连着行动），而不会与外层调用并发。
   *
   * **思考延迟**按 §9.4 计入 30s 回合时限：只等待，**不修改** `turnDeadlineAt`。
   *
   * **失败/非法**（§9.4 逐字）：`robot.decide` 超时/失败 ⇒ 规则引擎；
   * 动作被规则拒绝 ⇒ **必须回退规则引擎重决策**，仍失败才 pass。
   */
  private async driveRobotTurn(roomCode: string): Promise<void> {
    if (this.robotDriving.has(roomCode)) return;
    this.robotDriving.add(roomCode);
    try {
      for (;;) {
        const session = await this.getSession(roomCode);
        if (!session) return;
        if (session.state !== GameState.Bidding && session.state !== GameState.Playing) return;

        const seat = this.runtimeFor(session).currentActor(session);
        const botId = session.botIds?.[seat];
        const playerId = session.players[seat]?.id;
        if (!botId || !playerId) return; // 人类回合（或座位不存在）⇒ 停

        const advanced = await this.driveOneRobotTurn(roomCode, session, seat, botId, playerId);
        if (!advanced) return; // 一次都没推进 ⇒ 不空转
      }
    } finally {
      this.robotDriving.delete(roomCode);
    }
  }

  /** 驱动**一次**机器人动作；返回是否产生了状态转移。 */
  private async driveOneRobotTurn(
    roomCode: string,
    session: AnyGameSession,
    seat: number,
    botId: string,
    playerId: string,
  ): Promise<boolean> {
    const skillLevel: SkillLevel = session.botSkillLevels?.[seat] ?? 'beginner';
    // §9.5：机器人只拿**与人类完全相同**的裁剪视图 + 由 actionLog 投影出的公开特征
    const runtime = this.runtimeFor(session);
    const { view, features } = runtime.buildRobotInput(session, seat);

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

    /**
     * ⚠️ **fail loud（R217 同族）**：装配层没把 `robot.decide` 客户端接上时（`null`），
     * 不能静默当作「决策失败 ⇒ 规则引擎」—— 那会让**整条 RPC 通道失效却全绿**
     * （所有机器人永远走本地规则引擎，`source==='douzero'` 永不出现，而单测照样通过）。
     * 记 error 之后仍然回退规则引擎：对局必须继续（§9.4 的降级是逐次决策，不是整局失败）。
     */
    if (!this.robotClient) {
      this.logger.error(
        `robot.decide client is NOT wired for ${roomCode} (GameModule assembly bug): ` +
          `falling back to the rule engine for every robot turn`,
      );
    }
    const decided = this.robotClient
      ? await this.robotClient.decide({
          roomCode,
          botId,
          skillLevel,
          view,
          features,
        })
      : null;
    if (!decided) {
      // 片② D10/J25：这一支走的是**第三条决策路径**（游戏侧规则引擎兜底，不经 robot-service）
      // ⇒ 标记是「全量化」观测里唯一能把它认出来的凭据。
      this.logger.warn(
        `robot.decide failed for ${roomCode} seat ${seat}; using the rule engine ` +
          '(fallback=game-service-rule reason=decide-failed)',
      );
    }
    // 协议 ④ 的连带面：跟牌目标直接来自 `session.lastPlayedHand`（规则态，**不投影、不再解析**）
    const first = decided ?? this.ruleDecision(session, seat);
    if (await this.commitRobotDecision(roomCode, session, playerId, first, view)) return true;

    /**
     * §9.4 逐字：「**动作被规则拒绝 ⇒ 必须回退规则引擎重决策，不得直接 pass**」。
     * 这里再算一次规则引擎的动作（`ruleDecision` 是纯函数，确定性）；
     * 若它**就是**刚才被拒的那个动作（说明 DouZero 与规则引擎给出同一个非法动作），
     * 那说明规则引擎也无解 ⇒ 才走 `pass`。
     */
    const fallback = this.ruleDecision(session, seat);
    if (JSON.stringify(fallback) !== JSON.stringify(first)) {
      if (await this.commitRobotDecision(roomCode, session, playerId, fallback, view)) return true;
    }
    return this.commitRobotDecision(roomCode, session, playerId, { kind: 'pass' }, view);
  }

  /**
   * 把动作交给**与人类完全相同**的校验链（`handleBid`/`handlePlayCards`/`handlePass`）。
   *
   * **R10 / T5（机器人互锁）**：本方法是四写者之一，入口入队。`driveRobotTurn` 先
   * `getSession`、再 await 思考延迟（≈1.5s）+ `robot.decide`（≈5s），手里的
   * `session` 快照最多已旧 ~6.5s —— 而 toggle 是**第一个任意时刻合法的人类写者**。
   *
   * 锁内规则（⛔ 不按 version 严格复验 —— 治理转移只 bump version，不影响决策有效性，
   * 严格复验会让人一频繁 toggle 就反复丢弃重驱）：
   *  - **state/actor 复验**：入锁后重读会话；`state` 或当前行动者（座位 + `playerId`）
   *    与快照不符 ⇒ **丢弃本次决策**，返回 `true` 让 `driveRobotTurn` 循环**下一轮**重驱。
   *    ⚠️ **⛔ 锁内不得递归调 `driveRobotTurn`**：`robotDriving` 的 drop-on-reentry 会
   *    让递归静默 no-op ⇒ 机器人永远轮不到、退化成 30s 超时兜底。
   *  - **rebase**：复验通过 ⇒ 用**入锁后重读的会话**应用已决定的动作（⛔ 不是把旧快照
   *    原样保存 —— 那会静默覆盖掉思考期间发生的治理转移）。
   */
  private async commitRobotDecision(
    roomCode: string,
    session: AnyGameSession,
    playerId: string,
    decision: { kind: 'play' | 'pass'; cards?: number[] },
    view: GameView,
  ): Promise<boolean> {
    return this.runSerialized(roomCode, () =>
      this.commitRobotDecisionLocked(roomCode, session, playerId, decision, view),
    );
  }

  private async commitRobotDecisionLocked(
    roomCode: string,
    session: AnyGameSession,
    playerId: string,
    decision: { kind: 'play' | 'pass'; cards?: number[] },
    view: GameView,
  ): Promise<boolean> {
    /**
     * 入锁后重读（rebase 的真源）。快照 `session` **只**用作回合身份基线：
     * 它决定「这次决策是为谁、在哪个态下算的」。
     */
    const current = await this.getSession(roomCode);
    const expectedActor = this.runtimeFor(session).currentActor(session);
    const currentActor = current === null ? -1 : this.runtimeFor(current).currentActor(current);
    const sameTurn =
      current !== null &&
      current.state === session.state &&
      currentActor === expectedActor &&
      current.players[currentActor]?.id === playerId;
    if (!sameTurn) {
      // 被打断 ⇒ 丢弃本次决策；返回 true = 「让循环下一轮重读会话再驱动」。
      // （会话消失/终局时重驱只会立即停下，返回 true 同样无害。）
      this.logger.log(
        `Robot decision discarded for ${roomCode} (${playerId}): turn moved ` +
          `(state ${session.state}→${current?.state ?? 'gone'}, actor ${expectedActor}→${currentActor}); re-driving`,
      );
      return true;
    }

    let updated: AnyGameSession;
    try {
      // ⚠️ rebase：用 `current`（入锁后重读）而不是 `session`（旧快照）。
      updated = this.applyRobotDecision(current, expectedActor, decision);
    } catch (err) {
      // 片② D10/J25：被人类的校验链拒绝 ⇒ 同样是兜底路径（回退规则引擎重决策，不是直接 pass）。
      // ⚠️ catch 吞掉了 err（return false）⇒ `String(err)` 是全系统**唯一**落拒绝原因处，
      // 不得删除（`game.robot.test.ts` 的修复轮断言钉住该尾缀）。
      this.logger.warn(
        `Robot action rejected for ${roomCode} (${playerId}, ${decision.kind}): ${String(err)} ` +
          '(fallback=game-service-rule reason=action-rejected)',
      );
      return false;
    }
    // 与人类动作同一条收尾路径：重算回合截止时刻 → 结算/落盘/推送/重挂计时器
    updated.turnDeadlineAt = this.deadlineFor(updated);
    await this.finishTransition(roomCode, updated);
    this.logger.log(
      `Robot ${playerId} applied ${decision.kind} in ${roomCode} (state ${view.state}, version ${updated.version})`,
    );
    return true;
  }

  /**
   * **本地规则引擎**的兜底决策（§9.4 的「失败/非法 ⇒ 规则引擎」）。
   *
   * 与 `robot-service` 用的是**同一份**实现（`shared` 的 `findSmallestBeatingCards`），
   * 不在这里重写第二份（R202/E4 的唯一实现）。
   *
   * 叫抢阶段：兜底一律**不抢**（`pass`）—— 保守且合法；三家都不抢时 §3.2/§3.3 的
   * 「一轮走满 3 次 ⇒ 流局重发，第 3 次随机指定地主」会保证对局继续推进。
   *
   * ⚠️ **入参从 `PlayerView` 改成「手牌 + 跟牌目标 + 阶段」**（协议 ④ 的连带面）：
   * `view.lastPlayedHand` 已经退役，而跟牌目标是**规则输入**、本来就不该从显示层取。
   * 调用方（`driveOneRobotTurn`）手里有 `session`，目标直接来自 `session.lastPlayedHand`
   * —— **不需要**任何投影或再解析（R157/玩法 §5：不得重新解析 `cards` 反推 type/length）。
   */
  private ruleDecision(session: AnyGameSession, seat: number): RobotDecideResponse {
    const action = this.runtimeFor(session).autoAction(session, seat);
    if (action.kind === 'bid') return { kind: 'pass', source: 'rule' };
    if (action.kind === 'pass') return { kind: 'pass', source: 'rule' };
    // `RobotDecideResponse.cards` 是 rank-only（AI 契约）；花色由 backfillSuits 统一补。
    return { kind: 'play', cards: action.cards.map((card) => card.r), source: 'rule' };
  }

  /**
   * 把 robot-service 的 rank-only 决策接回**与人类完全相同**的 runtime 校验链。
   * 花色补回仍由 `backfillSuits()` 统一做（唯一落点）。
   */
  private applyRobotDecision(
    session: AnyGameSession,
    seat: number,
    decision: { kind: 'play' | 'pass'; cards?: number[] },
  ): AnyGameSession {
    const runtime = this.runtimeFor(session);
    const ctx = this.runtimeCtx(seat);
    // 叫抢阶段只有斗地主（`timerPhase==='bid'`）；跑得快恒 play。
    if (runtime.timerPhase(session) === 'bid') {
      return runtime.applyAction(
        session,
        { kind: 'bid', grab: decision.kind === 'play' },
        ctx,
      ).session;
    }
    if (decision.kind === 'pass') {
      return runtime.applyAction(session, { kind: 'pass' }, ctx).session;
    }
    const player = session.players[seat];
    if (!player) throw new Error(`Robot seat ${seat} has no player`);
    const cards = backfillSuits(player.hand, decision.cards ?? []);
    return runtime.applyAction(session, { kind: 'play', cards }, ctx).session;
  }

  /**
   * **R10 / T5：timer 回调的回合身份复核在锁内做**。
   *
   * `expected` 是 `startTurnTimer` 在**安装时**捕获的回合身份（`{actorSeat, deadlineAt}`）；
   * timer 回调**只**把它原样传进来（⛔ 回调不另包 `runSerialized` —— 见 `runSerialized` 的注释）。
   *
   * 入锁后复核（⚠️ 按**回合身份**，⛔ 不按 session version）：
   *  - `state ∈ {Init, Ended}` ⇒ 放弃；
   *  - 当前行动者（叫抢看 `currentBidder`、出牌看 `currentPlayer`）或 `turnDeadlineAt`
   *    与 `expected` 不符 ⇒ 放弃（回合已被换掉）。
   *  - **纯 version 变化（治理转移）不算失效** —— 否则非行动者 toggle 会让回调放弃，
   *    而 R8③ 又不动 timer ⇒ AFK 回合永久停摆（r5 阻断 1；R106/R525 同族最怕形态）。
   */
  private async onTurnTimeout(
    roomCode: string,
    expected?: { actorSeat: number; deadlineAt: number },
  ): Promise<void> {
    return this.runSerialized(roomCode, () => this.onTurnTimeoutLocked(roomCode, expected));
  }

  private async onTurnTimeoutLocked(
    roomCode: string,
    expected?: { actorSeat: number; deadlineAt: number },
  ): Promise<void> {
    const session = await this.getSession(roomCode);
    if (!session) return;
    if (expected) {
      if (session.state === GameState.Init || session.state === GameState.Ended) return;
      const currentActorSeat = this.runtimeFor(session).currentActor(session);
      if (
        currentActorSeat !== expected.actorSeat ||
        session.turnDeadlineAt !== expected.deadlineAt
      ) {
        return;
      }
    }

    const actorSeat = this.runtimeFor(session).currentActor(session);
    const playerId = session.players[actorSeat]?.id;
    this.logger.log(`Turn timeout for room ${roomCode}: seat ${actorSeat} (${playerId ?? 'unknown'})`);
    if (!playerId) {
      // 座位不存在（会话被外部改坏 / 人数不足）：不会自愈，但**必须**重挂，
      // 否则这一局静默停摆且没有任何后续信号。
      this.logger.error(
        `Timeout action impossible for room ${roomCode}: seat ${actorSeat} has no player`,
      );
      this.startTurnTimer(roomCode, session);
      return;
    }

    try {
      const updated = this.runtimeFor(session).onTimeout(
        session,
        this.runtimeCtx(actorSeat),
      ).session;
      /**
       * 挂机治理 C1 / C5：超时自动动作**成功**才计数（抛错走 catch，不计数）。
       * 机器人座位**豁免** —— 用 `botIds` 座位判定（⛔ 不是 `isBot`）：
       * 不累加 count、不置 trustee（视图侧同款豁免在 `view.builder`）。
       * 作用于 **`updated`**（同 C3：写 `session` 会丢）。
       */
      if (!this.isBotSeat(updated, actorSeat)) {
        updated.players[actorSeat] = {
          ...updated.players[actorSeat],
          ...onTimeoutOccurred(this.governanceOf(updated.players[actorSeat]), this.durations()),
        };
      }
      updated.turnDeadlineAt = this.deadlineFor(updated);
      await this.finishTransition(roomCode, updated);
    } catch (err) {
      this.logger.error(
        `Timeout action failed for room ${roomCode} (seat ${actorSeat}, ${playerId}): ${String(err)}`,
      );
      // R106③：不落盘、不改 version；R106②：重挂，使下一次超时仍会发生。
      // R106 + C2b：**按 normal 档重挂**（forceNormal）—— 即使行动者在托管中也不得
      // 用 trustee 短延时（防错误日志风暴）。
      this.startTurnTimer(roomCode, session, { forceNormal: true });
    }
  }
}

/** §9.3 拟人化思考延迟：基础手速缺省值（ms，区间中点；旧会话/旧房间无该字段时使用）。 */
const DEFAULT_THINKING_SPEED = 2000;
/** 每回合相对基础手速的抖动幅度（±ms）。 */
const THINKING_JITTER_MS = 300;
/** 单次延迟下界（ms）。 */
const THINKING_MIN_MS = 1000;
/** 单次延迟上界（ms）。 */
const THINKING_MAX_MS = 3000;

/**
 * 把一次机器人动作交给**与人类完全相同**的规则引擎入口（R208）。
 *
 * ⚠️ 叫抢阶段用 `grab` 语义：`kind === 'play'` ⇒ 抢（§4.2 的 `RobotDecideResponse`
 * 没有 `bid` 取值，本片约定 `play/pass` = 抢/不抢 —— 执行期裁决，见计划回填区）。
 */
/**
 * 为 **rank-only** 的机器人决策补回花色（spec §4 的 ① 与 ③ **共用这一处**）。
 *
 * ⚠️ **必须是确定性的**：同点数里取 `s` 最小的那张。
 * 非确定的挑法会让「同一个点数集」在不同运行里落到不同的牌上，而牌会进
 * `lastPlayedHand` 与 `actionLog` —— 断言的期望值就没法写，判据只能退化成
 * 「非空即可」。
 *
 * ⚠️ **必须只有一处**：①（DouZero 决策）与 ③（本地规则兜底）都经
 * `commitRobotDecision` 汇到这里。分头实现会产生两套挑法，同一手牌出不同的花色。
 *
 * ⚠️ **这不是「编造」花色**：牌来自行动者**真实的**手牌，挑的是真实存在的那一张
 * （`douzeroIntToCard` 那种凭空的 `suit: Club` 已经在 R696 里删掉了）。
 *
 * 手里找不到该点数时返回 `{r, s: 0}` 这个**不可能在手里**的哨兵，
 * 让 `handlePlayCards` 的「按身份精确摘除」去拒绝 —— 保持**单一拒绝点**。
 */
function backfillSuits(hand: Card[], ranks: number[]): Card[] {
  const pool = [...hand];
  return ranks.map((r) => {
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i]!.r !== r) continue;
      if (best === -1 || pool[i]!.s < pool[best]!.s) best = i;
    }
    if (best === -1) return { r, s: -1 }; // 哨兵：`s` 不在 0–4 值域，必然被拒
    return pool.splice(best, 1)[0]!;
  });
}
