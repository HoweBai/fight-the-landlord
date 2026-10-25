// packages/room-service/src/currency/settle.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  DEFAULT_GAME_TYPE,
  ErrCode,
  isGameType,
  isPdkSettlementResult,
  type CurrencyApplyData,
  type CurrencyBurn,
  type CurrencyEntryIn,
  type GameType,
  type SettlementResult,
} from '@fight-the-landlord/protocol';
import { incGame } from '@fight-the-landlord/shared';
import type { Room } from '../rooms/rooms.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { RecordClient } from '../gateway/record.client';
import { CurrencyClient, CurrencyServiceError } from './currency.client';
import {
  currencySettleResidueTotal,
  currencySettleResultTotal,
  recordWriteFailuresTotal,
} from '../metrics/room.metrics';

/**
 * ② 金币场 T5：**对局结算链**（算法 / 守卫 / 失败分级 / outbox / 收尾）——本片资金安全的
 * 承重任务（规格 §4/§5 逐字；设计 D3/D4/D5）。
 *
 * ─── 形态总览（三条边 + 两个 Hash + 三个收尾动作）────────────────────────────
 *  - 入口：`WsGateway.finalizeRoomEnd` 在 `releaseRobots` 之后、`!record||!version`
 *    早返**之前**调 `settle()`（fire-and-forget；结算**独立于**记录链）。
 *  - 读边 `currency.get`（结算前余额 → 截断/分摊的输入）；写边 `currency.apply`
 *    （唯一写点，`actionId=settle:<room>:<ver>` 幂等锚）；回写边 `record.moneyDelta`
 *    （三人向量含 0；`matched` 齐三座才算收敛）。
 *  - 失败分级（规格 §5 表逐字）：**超时/传输/10007** ⇒ 同 id 同载荷重发 ≤2 次
 *    （退避 300ms/1s）⇒ 仍失败入 `settle:outbox`；**14001** ⇒ 重读余额重算、
 *    `actionId :r2` 至多一轮 ⇒ 仍 14001 入 `settle:outbox`；**10001/14002** ⇒ 终态
 *    （`dropped` 指标 + ERROR，不入 outbox、不重试；14002 时 `money_delta` 留 NULL）。
 *  - `settle:outbox` / `recordmoney:outbox`：`field=<room>:<ver>`，JSON 值（结构见
 *    下方两个接口）；sweeper（`settle.sweeper.ts`）每 10s 原样重发；**TTL=1h** 超龄
 *    放弃（ERROR + 指标 + 删条目）；**告警阈值 = 最老条目 >300s**（告警先于 TTL 到达）。
 *  - 收尾顺序（各自独立 try/catch，互不阻塞）：① 广播 `game.balances`（玩家可见优先）
 *    → ② `record.moneyDelta`（不齐 ⇒ 入 `recordmoney:outbox`）→ ③ 机器人动作钩子
 *    （T6 实现本体；**零 delta 座无 `balanceAfter` ⇒ 该座跳过；全零局 ⇒ 整体跳过**）。
 *
 * ─── 两个「不得」（踩过/评审钉死的）────────────────────────────────────────
 *  - settle **不得**重读 `room:{code}:bots`：`finalizeRoomEnd` 顶部那次读之后
 *    `releaseRobots` 已 DEL 该键（重读恒空 ⇒ 带机器人的主场景会恒不结算）。
 *    `botBySeat` 由入参透传（与记录组装共用同一次读）。
 *  - `settle()` **绝不 reject**（调用方是 `void this.settleService.settle(...)`）：
 *    未处理的 rejection 会把 room-service 打成 crash-loop（Node 默认 throw）。
 *    顶层 catch ⇒ ERROR + `dropped` 指标。
 *
 * ─── 规格留白处的两条实现决策（显式登记）────────────────────────────────
 *  ① **读边复用同一条退避阶梯**：规格 §5 的重试预算字面只覆盖 apply；但读边故障模式
 *     完全相同（超时/传输 ⇒ 10007），而「一次读抖动 ⇒ 永久不结算」没有恢复路径
 *     （outbox 只能存**已算好**的载荷）。⇒ 读边按 300ms/1s ≤2 次重发，仍失败 ⇒
 *     `dropped`（响亮 ERROR；账户不动、账面可见）。「`retried`」指标对读/写两侧
 *     的每一次重发各计一次。
 *  ② **未知错误码按可重试处置**（同 id 重发 ⇒ 仍失败入 outbox）：重发以 `actionId`
 *     为幂等锚天然安全，而 `dropped` 只留给规格明文的两个终态码（10001/14002）——
 *     宁可账面可见地入箱，不可静默丢钱。
 */

/** `settle:outbox` 的 Hash 键（规格 §5 逐字）。 */
export const SETTLE_OUTBOX_KEY = 'settle:outbox';
/** `recordmoney:outbox` 的 Hash 键（规格 §5 逐字）。 */
export const RECORD_MONEY_OUTBOX_KEY = 'recordmoney:outbox';

/** 同名重发的退避阶梯（规格 §5 逐字：300ms / 1s ⇒ 连同首发共 ≤3 次尝试）。 */
export const SETTLE_RETRY_BACKOFF_MS = [300, 1_000] as const;

/** outbox 条目的 TTL（规格 §5 逐字：1h；超龄 ⇒ ERROR 放弃 + 指标 + 删条目，人工 runbook）。 */
export const SETTLE_OUTBOX_TTL_MS = 3_600_000;

/** 发给 currency-service 的 source（规格 §4 逐字）。 */
export const SETTLE_SOURCE = 'game_settle';

/**
 * ③ 机器人动作的**钩子 token**。本体 = `RobotFunding.afterSettle`（T6）——
 * `CurrencyModule` 以 `useExisting: RobotFunding` 提供（同一单例；`StartModule` 的
 * ensure 边注入的也是它）。⚠️ 当初留成**显式 no-op provider**而不是 `@Optional()`
 * 注入：后者在缺 provider 时静默注入 undefined ⇒ 整条路径无声消失（本仓记过四次）。
 */
export const SETTLE_ROBOT_HOOK = 'ROOM_SERVICE_SETTLE_ROBOT_HOOK';

/** ③ 的接口：只收「机器人座且**有** `balanceAfter`（= 本局有非零 delta）」，按座位升序。 */
export interface SettleRobotHook {
  afterSettle(
    balances: Array<{ botId: string; balanceAfter: number }>,
    gameType: GameType,
  ): Promise<void>;
}

/** `game.balances` 广播回调（由 `WsGateway` 在构造期绑定 —— 实现挂点在 ws 层）。 */
export type SettleBroadcastFn = (
  roomCode: string,
  version: number,
  balances: Array<{ seat: number; balance: number }>,
  /** 多玩法（Task 2.5）：pdk 才带（斗地主广播形状零变化）。 */
  meta?: { gameType: GameType; playerCount: number },
) => void;

/** 一座的结算身份（ownerId = 人类 `userId` / 机器人**内部** `botId`，绝不写 displayId）。 */
export interface SettleSeatRef {
  seat: number;
  ownerId: string;
  ownerType: 'user' | 'robot';
}

/** `settle()` 的入参（`finalizeRoomEnd` 透传 —— 见「两个不得」）。 */
export interface SettleInput {
  roomCode: string;
  /** `game.ended` 信封的 version（缺 ⇒ 守卫跳过 —— `settle:<room>:undefined` 会一路撞 10001）。 */
  version: number | undefined;
  result: SettlementResult | undefined;
  /** 房间元数据（`roomsService.findOne`，同 `writeGameRecord` 口径）；缺失 ⇒ WARN 跳过。 */
  room: Room | null;
  /** `finalizeRoomEnd` 顶部那次 bots 读（座位对齐）——**不得**在 settle 内重读。 */
  botBySeat: ReadonlyMap<number, string>;
}

/** `settle:outbox` 的条目（规格 §5 逐字字段：`{actionId, entries, roomCode, gameVersion, round, seats, createdAt}`）。 */
export interface SettleOutboxEntry {
  actionId: string;
  entries: CurrencyEntryIn[];
  roomCode: string;
  gameVersion: number;
  /** 1 = 首发；2 = 14001 后的 `:r2` 重算轮（至多一轮）。 */
  round: 1 | 2;
  /** 本局销毁（本片）：残差——随 apply 载荷捎带；**旧条目可能缺失**（读侧按 `typeof === 'number'` 判）。 */
  residue: number;
  /** 本局销毁（本片）：抽水。 */
  rakeTotal: number;
  /** 收尾链（广播三座/机器人钩子）用的座位身份快照。 */
  seats: SettleSeatRef[];
  createdAt: number;
  /** 多玩法（Task 2.5 / N2）：本局玩法/人数。**旧条目可能缺失** ⇒ 斗地主/3。 */
  gameType?: GameType;
  playerCount?: number;
}

/** `recordmoney:outbox` 的条目（规格 §5 逐字字段：`{roomCode, gameVersion, deltas, createdAt}`）。 */
export interface RecordMoneyOutboxEntry {
  roomCode: string;
  gameVersion: number;
  deltas: Array<{ seat: number; delta: number }>;
  createdAt: number;
  /** 多玩法（Task 2.5 / H6）：**旧条目可能缺失** ⇒ 斗地主/3。 */
  gameType?: GameType;
  playerCount?: number;
}

/** 一次结算的**纯计算结果**（`computeSettlement` 的产物；写入边与收尾链共用）。 */
export interface SettleComputation {
  actionId: string;
  /** 非零 delta 的 entries（规格 §4：全零 ⇒ 空数组 ⇒ 不调 apply）。 */
  entries: CurrencyEntryIn[];
  /** 三人语义向量（座位升序、**含 0**）—— `record.moneyDelta` 的原样载荷。 */
  deltas: Array<{ seat: number; delta: number }>;
  /** `P − Σg[i]`（销毁；∈ [0, 赢家数)）。 */
  residue: number;
  /** `Σrake[i]`（销毁；随 residue 一并可核对）。 */
  rakeTotal: number;
}

/**
 * 结算算法（规格 §4 伪码**逐字**；纯函数 —— 单测矩阵直接打它）。
 *
 * ```
 * raw[i]   = seat i 是 landlord ? result.landlordScoreChange : result.farmerScoreChange
 * 输家 i:  pay[i] = min(−raw[i], balance[i])    // balance 缺失（exists=false）按 0
 *          delta[i] = −pay[i];  P += pay[i]
 * 赢家 i:  g[i] = floor(raw[i] × P / Σraw[赢家])   // Σraw[赢家] = Σraw[输家]（玩法守恒）
 *          rake[i] = floor(g[i] × rakePercent / 100)
 *          delta[i] = g[i] − rake[i]
 * residue  = P − Σg[i]     // ∈ [0, 赢家数)；销毁，计 currency_settle_residue_total
 * entries  = 非零 delta 的 {ownerId, ownerType, delta}
 * ```
 * 分差为 0 的座位（理论不发生）⇒ 不产生 entry，但 `deltas` 向量仍含 0（规格 §4 末行）。
 */
export function computeSettlement(input: {
  roomCode: string;
  version: number;
  round: 1 | 2;
  result: SettlementResult;
  seats: readonly SettleSeatRef[];
  /** ownerId → 结算前余额；**缺失按 0**（`exists=false` 口径 —— 读路径不建行）。 */
  balances: ReadonlyMap<string, number>;
  rakePercent: number;
}): SettleComputation {
  const { roomCode, version, round, result, balances, rakePercent } = input;
  const ordered = [...input.seats].sort((a, b) => a.seat - b.seat);
  const rawOf = (seat: SettleSeatRef): number => {
    if (isPdkSettlementResult(result)) {
      return result.scoreChanges.find((c) => c.seat === seat.seat)?.delta ?? 0;
    }
    return seat.seat === result.landlordSeat ? result.landlordScoreChange : result.farmerScoreChange;
  };

  const winners = ordered.filter((s) => rawOf(s) > 0);
  const losers = ordered.filter((s) => rawOf(s) < 0);
  const deltaBySeat = new Map<number, number>(ordered.map((s) => [s.seat, 0]));

  let pool = 0;
  for (const s of losers) {
    // 输光截断（D3）：应付超过余额 ⇒ 只付余额，不欠账（也就不可能 14001）。
    const pay = Math.min(-rawOf(s), balances.get(s.ownerId) ?? 0);
    // ⚠️ `-0` 归一：`-pay` 在 pay=0 时是 `-0`（Object.is 层面 ≠ 0，序列化/断言都会出怪相）。
    deltaBySeat.set(s.seat, pay === 0 ? 0 : -pay);
    pool += pay;
  }

  const winnerRawSum = winners.reduce((acc, s) => acc + rawOf(s), 0);
  let gainedSum = 0;
  let rakeTotal = 0;
  if (winners.length > 0 && winnerRawSum > 0) {
    for (const s of winners) {
      const gain = Math.floor((rawOf(s) * pool) / winnerRawSum); // 截断后的 P 按原始分差分摊
      const rake = Math.floor((gain * rakePercent) / 100);
      deltaBySeat.set(s.seat, gain - rake);
      gainedSum += gain;
      rakeTotal += rake;
    }
  }

  const residue = pool - gainedSum;
  const deltas = ordered.map((s) => ({ seat: s.seat, delta: deltaBySeat.get(s.seat) ?? 0 }));
  const entries: CurrencyEntryIn[] = ordered
    .map((s) => ({
      ownerId: s.ownerId,
      ownerType: s.ownerType,
      delta: deltaBySeat.get(s.seat) ?? 0,
    }))
    .filter((entry) => entry.delta !== 0);

  const actionId =
    round === 2 ? `settle:${roomCode}:${version}:r2` : `settle:${roomCode}:${version}`;
  return { actionId, entries, deltas, residue, rakeTotal };
}

/** `matched` 齐 playerCount 座（规格 §3；多玩法 Task 2.5：0..playerCount-1）。 */
function coversAllSeats(matched: readonly number[], playerCount: number): boolean {
  for (let seat = 0; seat < playerCount; seat += 1) {
    if (!matched.includes(seat)) return false;
  }
  return true;
}

/** `game.balances` / `record.moneyDelta` 的按玩法字段：pdk 或不等于 3 座才带（ddz 旧形状零变化）。 */
function gameMetaOf(
  gameType: GameType,
  playerCount: number,
): { gameType: GameType; playerCount: number } | undefined {
  return gameType === 'paodekuai' || playerCount !== 3 ? { gameType, playerCount } : undefined;
}

/** 从 outbox 条目还原三人向量（entries 只含非零 ⇒ 其余座补 0）。 */
function deltasFromEntry(entry: SettleOutboxEntry): Array<{ seat: number; delta: number }> {
  return [...entry.seats]
    .sort((a, b) => a.seat - b.seat)
    .map((seat) => ({
      seat: seat.seat,
      delta: entry.entries.find((e) => e.ownerId === seat.ownerId)?.delta ?? 0,
    }));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 失败分级的内部结果（`applyGraded` 的产物）。 */
type ApplyOutcome =
  | { kind: 'ok' | 'replayed'; data: CurrencyApplyData }
  | { kind: 'r2' }
  | { kind: 'dropped'; reason: 'invalid' | 'conflict' }
  | { kind: 'outboxed'; error: unknown };

/**
 * 结算服务（DI 装配见 `currency.module.ts`；广播回调由 `WsGateway` 构造期 `bindBroadcast`）。
 *
 * ⚠️ **值导入**（DI 陷阱纪律）：`Redis` / `ConfigCacheService` / `RecordClient` / `CurrencyClient`
 * 都是构造参数上的类引用 —— `import type` 会被擦除 ⇒ 真容器启动即崩（单测直接 `new` 看不见）。
 */
@Injectable()
export class SettleService {
  private readonly logger = new Logger(SettleService.name);
  /** `game.balances` 的广播回调（sweeper 晚到的收尾也要用它 ⇒ 绑一次、两路共用）。 */
  private broadcast: SettleBroadcastFn | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly currency: CurrencyClient,
    private readonly configCache: ConfigCacheService,
    private readonly record: RecordClient,
    @Inject(SETTLE_ROBOT_HOOK) private readonly robotHook: SettleRobotHook,
  ) {}

  /** 绑定广播回调（`WsGateway` 构造期调用；实现挂点在 ws 层）。 */
  bindBroadcast(fn: SettleBroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * 结算一局（fire-and-forget 入口 —— **绝不 reject**，见文件头）。
   *
   * 守卫（缺任 ⇒ WARN + `dropped` 指标 + 不结算；mode 非 gold ⇒ 静默返回）：
   * 房间存在 ∧ `mode==='gold'` ∧ `result` 存在 ∧ `version` 非空（正整数）∧
   * 三座位齐（恰 0/1/2）∧ 机器人座映射齐（`botBySeat`，C25）。
   */
  async settle(input: SettleInput): Promise<void> {
    try {
      await this.settleInner(input);
    } catch (err) {
      // 顶层兜底：settle 的调用方是 `void …` ⇒ 任何逃逸的 rejection 都会把进程打成
      // crash-loop（Node 默认 --unhandled-rejections=throw）。宁可账面可见地响一声。
      const topGameType = input.result !== undefined && isPdkSettlementResult(input.result)
        ? 'paodekuai' : 'doudizhu';
      this.dropError(input.roomCode, input.version, topGameType, 'unexpected error', err);
    }
  }

  private async settleInner(input: SettleInput): Promise<void> {
    const { roomCode } = input;

    // ── 守卫①：房间元数据（mode 与座位/ownerId 的**唯一**来源；同 writeGameRecord 口径）──
    if (!input.room) {
      // 此处**不计指标**：拿不到房间就无从判定它是不是金币局（免费场同样走这一行）——
      // 计入会让 dropped 统计失真（规格 §4：room 缺失只 WARN 跳过，与记录链同口径）。
      this.logger.warn(
        `Currency settle skipped for room ${roomCode}: room data missing (room keys expired — TTL window)`,
      );
      return;
    }
    const room = input.room;
    const gameType = room.gameType ?? DEFAULT_GAME_TYPE;

    // ── 守卫②：mode==='gold'（免费场/好友房是**正常路径** ⇒ 静默返回，不 WARN 不指标）──
    if (room.mode !== 'gold') return;

    // ── 守卫③：result 存在 ─────────────────────────────────────────────
    if (!input.result) {
      this.dropWarn(roomCode, input.version, gameType, 'game.ended carries no result');
      return;
    }
    const result = input.result;

    // ── 守卫④：version 非空（正整数）—— actionId 与 moneyDelta 的 gameVersion 全依赖它 ──
    const version = input.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
      this.dropWarn(
        roomCode,
        version,
        gameType,
        'game.ended carries no version (settle:<room>:undefined would collide with 10001)',
      );
      return;
    }

    /**
     * 多玩法（Task 2.5）：玩法/人数 = **房间元数据**（`RoomMeta.gameType`/`maxPlayers`）。
     * 结果与房间必须同玩法/同人数（pdk 的 `playerCount` 由结算向量自带）。
     */
    const playerCount = room.maxPlayers;
    const resultIsPdk = isPdkSettlementResult(result);
    if (resultIsPdk !== (gameType === 'paodekuai')) {
      this.dropWarn(roomCode, version, gameType, `settlement gameType mismatch (room=${gameType})`);
      return;
    }
    if (resultIsPdk && result.playerCount !== playerCount) {
      this.dropWarn(
        roomCode,
        version,
        gameType,
        `settlement playerCount mismatch (result=${result.playerCount}, room=${playerCount})`,
      );
      return;
    }

    // ── 守卫⑤：座位齐（0..playerCount-1） + 机器人座映射齐（映射来自入参透传 —— 不得重读 bots 键）────
    const seats = this.resolveSeats(room, input.botBySeat, version, playerCount, gameType);
    if (!seats) return;

    const rakePercent = this.configCache.rakePercent(gameType);

    // ── 读边：结算前余额（截断/分摊的输入）──────────────────────────────
    let balances: ReadonlyMap<string, number>;
    try {
      balances = await this.readBalances(seats.map((s) => s.ownerId), gameType);
    } catch (err) {
      this.dropError(roomCode, version, gameType, 'balance read failed', err);
      return;
    }

    // 当前计算所用的读数（finalize 里给「零 delta 座」兜底广播值 —— r2 轮之后要用重读值）。
    let balancesUsed: ReadonlyMap<string, number> = balances;
    let round: 1 | 2 = 1;
    let computed = computeSettlement({
      roomCode,
      version,
      round,
      result: input.result,
      seats,
      balances,
      rakePercent,
    });

    if (computed.entries.length === 0) {
      // 全零（规格 §4/§5）：不调 apply；仍走「广播 + moneyDelta(全 0)」收尾（三态之二）。
      incGame(currencySettleResultTotal, gameType, 1, { result: 'ok' });
      this.logger.log(
        `Currency settle for room ${roomCode} (version ${version}): all deltas zero — no apply (broadcast + moneyDelta only)`,
      );
      await this.finalize({ roomCode, version, seats, computed, data: null, preBalances: balances, gameType, playerCount });
      return;
    }

    let outcome = await this.applyGraded(computed.actionId, computed.entries, roomCode, version, round, {
      residue: computed.residue,
      rake: computed.rakeTotal,
    }, gameType);

    if (outcome.kind === 'r2') {
      // ── 14001 ⇒ 重读余额、重算，`:r2` 重发**至多一轮**（规格 §5）────────────
      incGame(currencySettleResultTotal, gameType, 1, { result: 'r2' });
      let balances2: ReadonlyMap<string, number>;
      try {
        balances2 = await this.readBalances(seats.map((s) => s.ownerId), gameType);
      } catch (err) {
        this.dropError(roomCode, version, gameType, 'balance re-read for :r2 failed', err);
        return;
      }
      balancesUsed = balances2;
      round = 2;
      computed = computeSettlement({
        roomCode,
        version,
        round,
        result: input.result,
        seats,
        balances: balances2,
        rakePercent,
      });
      if (computed.entries.length === 0) {
        // 重算后全零（P 被新余额截到 0 —— 理论极罕见）：与全零局同处置。
        incGame(currencySettleResultTotal, gameType, 1, { result: 'ok' });
        await this.finalize({ roomCode, version, seats, computed, data: null, preBalances: balances2, gameType, playerCount });
        return;
      }
      outcome = await this.applyGraded(computed.actionId, computed.entries, roomCode, version, round, {
        residue: computed.residue,
        rake: computed.rakeTotal,
      }, gameType);
      if (outcome.kind === 'r2') {
        // 仍 14001（规格 §5：至多一轮 ⇒ 入 outbox；不再重算）。
        outcome = { kind: 'outboxed', error: new Error('14001 persisted after :r2 recompute') };
      }
    }

    if (outcome.kind === 'dropped') return; // applyGraded 内已 ERROR + dropped 指标

    if (outcome.kind === 'outboxed') {
      try {
        await this.redis.hset(
          SETTLE_OUTBOX_KEY,
          `${roomCode}:${version}`,
          JSON.stringify({
            actionId: computed.actionId,
            entries: computed.entries,
            roomCode,
            gameVersion: version,
            round,
            seats,
            residue: computed.residue,
            rakeTotal: computed.rakeTotal,
            createdAt: Date.now(),
            // 多玩法（Task 2.5 / N2）：重发时广播/moneyDelta 都从条目取，不得缺省 3 座。
            gameType,
            playerCount,
          } satisfies SettleOutboxEntry),
        );
      } catch (err) {
        // 写箱失败 = 唯一的补偿路径也断了：apply 已最终失败（**钱未动**）且再无自动重试 ⇒
        // 终态，人工按 actionId 对账。**不计 `outboxed`**——「入箱」没有发生（条目不存在，
        // sweeper 永远不会认领它），计它会给出虚假承诺并把告警面口径带偏。按 `dropped`
        // 口径（「终态且未动钱」——同「余额读最终失败」「outbox 超龄放弃」一族）计入。
        this.dropError(
          roomCode,
          version,
          gameType,
          `settle outbox write failed (round ${round}) — entry NOT queued; manual reconciliation by actionId=${computed.actionId}`,
          err,
        );
        return;
      }
      incGame(currencySettleResultTotal, gameType, 1, { result: 'outboxed' });
      this.logger.error(
        `Currency settle outboxed for room ${roomCode} (version ${version}, round ${round}): apply failed after retries — sweeper will resend (actionId=${computed.actionId})`,
      );
      return;
    }

    incGame(currencySettleResultTotal, gameType, 1, { result: outcome.kind });
    await this.finalize({
      roomCode,
      version,
      seats,
      computed,
      data: outcome.data,
      preBalances: balancesUsed,
      gameType,
      playerCount,
    });
  }

  /**
   * 写边：`currency.apply` + 失败分级（规格 §5 表逐字；返回分级结果，副作用=指标/日志）。
   *
   * 重发退避在**每次尝试之前**（300ms/1s）—— 与读边共用同一条阶梯与 `retried` 指标。
   */
  private async applyGraded(
    actionId: string,
    entries: CurrencyEntryIn[],
    roomCode: string,
    version: number,
    round: 1 | 2,
    burn: CurrencyBurn,
    gameType: GameType,
  ): Promise<ApplyOutcome> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SETTLE_RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(SETTLE_RETRY_BACKOFF_MS[attempt - 1]!);
        incGame(currencySettleResultTotal, gameType, 1, { result: 'retried' });
      }
      try {
        const data = await this.currency.apply({
          actionId,
          source: SETTLE_SOURCE,
          entries,
          refId: `${roomCode}:${version}`,
          burn,
          gameType,
        });
        return data.replayed ? { kind: 'replayed', data } : { kind: 'ok', data };
      } catch (err) {
        if (!(err instanceof CurrencyServiceError)) throw err; // 编程错误 ⇒ 顶层兜底 dropped
        switch (err.code) {
          case ErrCode.E_INSUFFICIENT_FUNDS: // 14001
            return { kind: 'r2' };
          case ErrCode.BAD_PARAM: // 10001：确定性回滚（校验/类型闸）⇒ 终态
            this.dropError(
              roomCode,
              version,
              gameType,
              `apply rejected as invalid (10001, round ${round}; deterministic — not retried, not outboxed)`,
              err,
            );
            return { kind: 'dropped', reason: 'invalid' };
          case ErrCode.E_ACTION_CONFLICT: // 14002：同 id 异载荷（他方已结算）⇒ 终态
            this.dropError(
              roomCode,
              version,
              gameType,
              `apply conflict (14002, round ${round}; another settlement won — money_delta stays NULL, reconcile via currency_flows)`,
              err,
            );
            return { kind: 'dropped', reason: 'conflict' };
          case ErrCode.UPSTREAM_UNAVAILABLE: // 10007：超时/传输 ⇒ 同 id 同载荷重发
          default: {
            // 未知码按可重试处置（见文件头「实现决策②」）
            lastError = err;
            continue;
          }
        }
      }
    }
    return { kind: 'outboxed', error: lastError };
  }

  /**
   * 读边：`currency.get`（传输类失败按共享退避阶梯重发 ≤2 次 —— 见文件头「实现决策①」）。
   *
   * `exists=false` 的账户契约上 `balance` 就是 0 ⇒ 直接采用（缺失条目按 0 兜底）。
   */
  private async readBalances(ownerIds: string[], gameType: GameType): Promise<Map<string, number>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= SETTLE_RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(SETTLE_RETRY_BACKOFF_MS[attempt - 1]!);
        incGame(currencySettleResultTotal, gameType, 1, { result: 'retried' });
      }
      try {
        const { balances } = await this.currency.get({ ownerIds });
        const out = new Map<string, number>();
        for (const entry of balances) out.set(entry.ownerId, entry.balance);
        return out;
      } catch (err) {
        if (err instanceof CurrencyServiceError && err.code === ErrCode.UPSTREAM_UNAVAILABLE) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /**
   * 守卫⑤：座位齐（**恰 `0..playerCount-1`** —— 2/3/4 人）∧ 机器人座映射齐（C25）。
   * 缺任 ⇒ WARN + `dropped` 指标 + 返回 `null`（不结算）。
   */
  private resolveSeats(
    room: Room,
    botBySeat: ReadonlyMap<number, string>,
    version: number,
    playerCount: number,
    gameType: GameType,
  ): SettleSeatRef[] | null {
    const players = room.players;
    const seatIndexes = Array.from({ length: playerCount }, (_, seat) => seat);
    const seatsComplete =
      players.length === playerCount && seatIndexes.every((seat) => players.some((p) => p.seat === seat));
    if (!seatsComplete) {
      this.dropWarn(
        room.code,
        version,
        gameType,
        `room seats incomplete (expected ${playerCount}, players=[${players.map((p) => p.seat).join(',')}])`,
      );
      return null;
    }
    const refs: Array<SettleSeatRef | null> = [...players]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => {
        if (!p.isRobot) return { seat: p.seat, ownerId: p.userId, ownerType: 'user' as const };
        // 机器人座：ownerId = **内部** botId（自入参透传的映射；displayId 绝不出现在资金面）
        const botId = botBySeat.get(p.seat);
        return botId ? { seat: p.seat, ownerId: botId, ownerType: 'robot' as const } : null;
      });
    if (refs.some((ref) => ref === null)) {
      this.dropWarn(room.code, version, gameType, 'robot seat mapping missing (botBySeat incomplete)');
      return null;
    }
    return refs as SettleSeatRef[];
  }

  /**
   * 收尾三件事（规格 §5 逐字顺序；**各自独立 try/catch，互不阻塞**）：
   * ① 广播 `game.balances` → ② `record.moneyDelta` → ③ 机器人动作钩子。
   */
  private async finalize(args: {
    roomCode: string;
    version: number;
    seats: SettleSeatRef[];
    computed: SettleComputation;
    data: CurrencyApplyData | null;
    preBalances: ReadonlyMap<string, number>;
    /** 多玩法（Task 2.5）：广播/moneyDelta 的玩法字段（ddz 走旧形状）。 */
    gameType: GameType;
    playerCount: number;
  }): Promise<void> {
    const { roomCode, version, seats, computed, data, preBalances, gameType, playerCount } = args;

    // 残差销毁记账（§4）：**零和局也 inc 0** —— 任何金币局之后该序列必然出现（H 组据此核对）。
    incGame(currencySettleResidueTotal, gameType, computed.residue);
    if (computed.residue > 0 || computed.rakeTotal > 0) {
      this.logger.log(
        `Currency settle residue for room ${roomCode} (version ${version}): residue=${computed.residue} rake=${computed.rakeTotal} (destroyed — cross-check via currency_flows)`,
      );
    }

    // ① 广播（玩家可见优先；失败只记日志、不阻塞后续两步）
    try {
      if (!this.broadcast) {
        this.logger.warn(
          `Currency settle broadcast skipped for room ${roomCode} (version ${version}): broadcast callback not bound (WsGateway wiring bug)`,
        );
      } else {
        const balances = await this.resolveBroadcastBalances(seats, data, preBalances);
        // 语义（规格 §2.2）：balance = 该座 owner 的**结算时刻**余额 —— replayed 响应的
        // balanceAfter 是**历史快照**，在此语义下就是「结算时刻值」（客户端只做展示）。
        // 多玩法（Task 2.5）：pdk 才带 gameType/playerCount（ddz 广播形状逐字不变）。
        this.broadcast(roomCode, version, balances, gameMetaOf(gameType, playerCount));
      }
    } catch (err) {
      this.logger.error(
        `Currency settle broadcast failed for room ${roomCode} (version ${version}): ${String(err)}`,
      );
    }

    // ② record.moneyDelta（N 座向量含 0；不齐 ⇒ 入 recordmoney:outbox）
    try {
      await this.pushMoneyDelta(roomCode, version, computed.deltas, gameType, playerCount);
    } catch (err) {
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.error(
        `Currency moneyDelta queueing failed for room ${roomCode} (version ${version}): ${String(err)}`,
      );
    }

    // ③ 机器人动作（T6 钩子；零 delta 座无 balanceAfter ⇒ 该座跳过；全零局 data=null ⇒ 整体跳过）
    if (data) {
      const afterByOwner = new Map(data.entries.map((e) => [e.ownerId, e.balanceAfter]));
      const robotBalances = seats
        .filter((s) => s.ownerType === 'robot' && afterByOwner.has(s.ownerId))
        .map((s) => ({ botId: s.ownerId, balanceAfter: afterByOwner.get(s.ownerId)! }));
      if (robotBalances.length > 0) {
        try {
          await this.robotHook.afterSettle(robotBalances, gameType);
        } catch (err) {
          // fail-open（规格 §7）：失败只记指标/日志，绝不阻塞收尾链的其余部分。
          this.logger.warn(
            `Robot after-settle funding failed for room ${roomCode} (version ${version}; fail-open): ${String(err)}`,
          );
        }
      }
    }
  }

  /**
   * 三座余额 → 广播载荷（座位升序、恰 3 条）。
   *
   * 有 entry 的座 ⇒ apply 响应的 `balanceAfter`；**零 delta 座**（无 entry）⇒ 结算前读数
   * （in-process 路径）或现读一次（outbox 重发路径 —— 那时「结算前读数」已不在手上）。
   */
  private async resolveBroadcastBalances(
    seats: SettleSeatRef[],
    data: CurrencyApplyData | null,
    preBalances: ReadonlyMap<string, number>,
  ): Promise<Array<{ seat: number; balance: number }>> {
    const afterByOwner = new Map<string, number>(
      (data?.entries ?? []).map((e) => [e.ownerId, e.balanceAfter]),
    );
    const known = new Map<string, number>(preBalances);
    const missing = seats.filter((s) => !afterByOwner.has(s.ownerId) && !known.has(s.ownerId));
    if (missing.length > 0) {
      const { balances } = await this.currency.get({ ownerIds: missing.map((s) => s.ownerId) });
      for (const entry of balances) known.set(entry.ownerId, entry.balance);
    }
    return [...seats]
      .sort((a, b) => a.seat - b.seat)
      .map((s) => ({ seat: s.seat, balance: afterByOwner.get(s.ownerId) ?? known.get(s.ownerId) ?? 0 }));
  }

  /** ② 的实现：命中 N 座 ⇒ 完成；缺座/抛错 ⇒ 入 `recordmoney:outbox`（sweeper 收敛）。 */
  private async pushMoneyDelta(
    roomCode: string,
    version: number,
    deltas: Array<{ seat: number; delta: number }>,
    gameType: GameType,
    playerCount: number,
  ): Promise<void> {
    const meta = gameMetaOf(gameType, playerCount);
    try {
      const { matched } = await this.record.moneyDelta({
        roomCode,
        gameVersion: version,
        ...(meta ?? {}),
        deltas,
      });
      if (coversAllSeats(matched, playerCount)) {
        this.logger.log(
          `money_delta written for room ${roomCode} (version ${version}; matched all ${playerCount} seats)`,
        );
        return;
      }
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.warn(
        `record.moneyDelta partial for room ${roomCode} (version ${version}): matched=[${matched.join(',')}] — queued for sweep`,
      );
    } catch (err) {
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.warn(
        `record.moneyDelta failed for room ${roomCode} (version ${version}): ${String(err)} — queued for sweep`,
      );
    }
    await this.redis.hset(
      RECORD_MONEY_OUTBOX_KEY,
      `${roomCode}:${version}`,
      JSON.stringify({
        roomCode,
        gameVersion: version,
        deltas,
        createdAt: Date.now(),
        gameType,
        playerCount,
      } satisfies RecordMoneyOutboxEntry),
    );
  }

  // ─── sweeper 的每条目处置（迭代/计时器在 `settle.sweeper.ts`）──────────────

  /**
   * 处置一条 `settle:outbox`：超龄 ⇒ 放弃；否则**原样重发**（同 id 同载荷）；成功 ⇒
   * 走完整收尾（广播 + moneyDelta + 机器人钩子）**并**从箱中清除 —— **收尾在前、
   * 清除在后**（规格 §5 字面顺序；崩在两者之间只多一次幂等重放，不留永久缺失）。
   */
  async resendSettleOutboxEntry(field: string, entry: SettleOutboxEntry, now: number): Promise<void> {
    const gameType = isGameType(entry.gameType) ? entry.gameType : DEFAULT_GAME_TYPE;
    if (now - entry.createdAt > SETTLE_OUTBOX_TTL_MS) {
      await this.redis.hdel(SETTLE_OUTBOX_KEY, field);
      incGame(currencySettleResultTotal, gameType, 1, { result: 'dropped' });
      this.logger.error(
        `Currency settle outbox entry abandoned for room ${entry.roomCode} (version ${entry.gameVersion}, round ${entry.round}): age exceeded 1h — manual runbook (reconcile via currency_flows by actionId=${entry.actionId})`,
      );
      return;
    }
    try {
      // 本片：新条目携带销毁两值 ⇒ 带 burn 重发（与首发同指纹）；旧条目（无字段）⇒ **不带**
      // burn（旧指纹、可正常重放；该 op 两列为 NULL）。条件展开——不得传显式 undefined 占键。
      const burnPayload =
        typeof entry.residue === 'number' && typeof entry.rakeTotal === 'number'
          ? { burn: { residue: entry.residue, rake: entry.rakeTotal } }
          : {};
      const data = await this.currency.apply({
        actionId: entry.actionId,
        source: SETTLE_SOURCE,
        entries: entry.entries,
        refId: `${entry.roomCode}:${entry.gameVersion}`,
        ...burnPayload,
        // A2：旧条目（无 gameType）不得凭空补 ddz；新条目原样带回。
        ...(entry.gameType === undefined ? {} : { gameType: entry.gameType }),
      });
      incGame(currencySettleResultTotal, gameType, 1, { result: data.replayed ? 'replayed' : 'ok' });
      this.logger.log(
        `Currency settle outbox entry delivered for room ${entry.roomCode} (version ${entry.gameVersion}, round ${entry.round}, replayed=${String(data.replayed)})`,
      );
      // 顺序（规格 §5 逐字）：成功 ⇒ **走完整收尾并从两箱清除** —— finalize 先、hdel 后。
      // 崩在两者之间（条目留存）⇒ 下一轮重发是 replayed（幂等锚在 actionId），最坏代价 =
      // 多播一次 balances + 同值重写 moneyDelta（皆幂等）；反过来（先清后收尾）一旦清了箱
      // 没收尾，钱已动而 game.balances 广播与 money_delta 永久缺失且无队列/告警留痕。
      await this.finalize({
        roomCode: entry.roomCode,
        version: entry.gameVersion,
        seats: entry.seats,
        computed: {
          actionId: entry.actionId,
          entries: entry.entries,
          deltas: deltasFromEntry(entry),
          // 条目已带 residue/rakeTotal（本片）——但 finalize 的残差指标**有意不计**（D6：
          // 「账」以 entries 为准；指标语义是「in-process 收尾口径」，改动需单独理由）。
          residue: 0,
          rakeTotal: 0,
        },
        data,
        preBalances: new Map(),
        // 多玩法（Task 2.5 / N2）：从**条目**取（旧条目缺字段 ⇒ 斗地主/3）。
        gameType,
        playerCount: entry.playerCount ?? 3,
      });
      await this.redis.hdel(SETTLE_OUTBOX_KEY, field);
    } catch (err) {
      if (
        err instanceof CurrencyServiceError &&
        (err.code === ErrCode.BAD_PARAM || err.code === ErrCode.E_ACTION_CONFLICT)
      ) {
        await this.redis.hdel(SETTLE_OUTBOX_KEY, field);
        this.dropError(
          entry.roomCode,
          entry.gameVersion,
          gameType,
          `outbox resend terminal (code ${err.code}; money_delta stays NULL)`,
          err,
        );
        return;
      }
      // 10007 / 14001 / 未知 ⇒ 留在箱里，下一轮（10s 后）原样再试（TTL 兜底）。
      this.logger.warn(
        `Currency settle outbox resend failed for room ${entry.roomCode} (version ${entry.gameVersion}, round ${entry.round}): ${String(err)} — kept for next sweep`,
      );
    }
  }

  /** 处置一条 `recordmoney:outbox`：超龄 ⇒ 放弃；否则重发，`matched` 齐三座 ⇒ 清除。 */
  async resendRecordMoneyOutboxEntry(
    field: string,
    entry: RecordMoneyOutboxEntry,
    now: number,
  ): Promise<void> {
    const gameType = isGameType(entry.gameType) ? entry.gameType : DEFAULT_GAME_TYPE;
    if (now - entry.createdAt > SETTLE_OUTBOX_TTL_MS) {
      await this.redis.hdel(RECORD_MONEY_OUTBOX_KEY, field);
      incGame(currencySettleResultTotal, gameType, 1, { result: 'dropped' });
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.error(
        `recordmoney:outbox entry abandoned for room ${entry.roomCode} (version ${entry.gameVersion}): age exceeded 1h — money_delta stays NULL (manual runbook)`,
      );
      return;
    }
    try {
      // 多玩法（Task 2.5 / H6）：从**条目**取（旧条目缺字段 ⇒ 斗地主/3）。
      const playerCount = entry.playerCount ?? 3;
      const meta = gameMetaOf(gameType, playerCount);
      const { matched } = await this.record.moneyDelta({
        roomCode: entry.roomCode,
        gameVersion: entry.gameVersion,
        ...(meta ?? {}),
        deltas: entry.deltas,
      });
      if (coversAllSeats(matched, playerCount)) {
        await this.redis.hdel(RECORD_MONEY_OUTBOX_KEY, field);
        this.logger.log(
          `recordmoney:outbox entry converged for room ${entry.roomCode} (version ${entry.gameVersion}; matched all ${playerCount} seats)`,
        );
        return;
      }
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.warn(
        `recordmoney:outbox resend still partial for room ${entry.roomCode} (version ${entry.gameVersion}): matched=[${matched.join(',')}] — kept for next sweep`,
      );
    } catch (err) {
      incGame(recordWriteFailuresTotal, gameType, 1, { kind: 'money_delta' });
      this.logger.warn(
        `recordmoney:outbox resend failed for room ${entry.roomCode} (version ${entry.gameVersion}): ${String(err)} — kept for next sweep`,
      );
    }
  }

  // ─── 日志 / 指标小工具 ─────────────────────────────────────────────

  /** 守卫不齐（金币局异常终局，人工核；理论不发生）⇒ WARN + `dropped` 指标、不结算。 */
  private dropWarn(
    roomCode: string,
    version: number | undefined,
    gameType: GameType,
    reason: string,
  ): void {
    incGame(currencySettleResultTotal, gameType, 1, { result: 'dropped' });
    this.logger.warn(
      `Currency settle skipped for room ${roomCode} (version ${String(version)}): ${reason}`,
    );
  }

  /** 终态失败（含 outbox 超龄放弃 / outbox 写入失败）⇒ ERROR（含 roomCode/version）+ `dropped` 指标。 */
  private dropError(
    roomCode: string,
    version: number | undefined,
    gameType: GameType,
    reason: string,
    err?: unknown,
  ): void {
    incGame(currencySettleResultTotal, gameType, 1, { result: 'dropped' });
    this.logger.error(
      `Currency settle failed for room ${roomCode} (version ${String(version)}): ${reason}${err === undefined ? '' : ` — ${String(err)}`}`,
    );
  }
}
