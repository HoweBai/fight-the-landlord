// packages/room-service/src/config/config-cache.service.ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  DEFAULT_GAME_TYPE,
  ErrCode,
  NO_BOT_MAX_WAIT_DEFAULT_MS,
  entryFeePercentsFromLevels,
  parseConfigValue,
  supportsPlayerCount,
  type BaseScoreLevel,
  type ConfigKey,
  type ConfigSnapshot,
  type EntryFeePercent,
  type GameType,
  type PdkRulesConfig,
} from '@fight-the-landlord/protocol';
import { DEFAULT_PDK_RULES, runWithTrace } from '@fight-the-landlord/shared';
import { ConfigClient, ConfigServiceError } from '../gateway/config.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../gateway/transport-failure';

/**
 * config-service 写入后广播的频道（**值经 design/spec 钉死**；发布侧 = config-service 的
 * `CONFIG_CHANGED_CHANNEL`——同一个字面量在两侧各定义一次，因为服务之间不互相 import。
 * `config-cache.test.ts` 有一条「频道名逐字」把本侧钉住；两侧一致性由机制层层兜底：
 * 丢一条通知的后果被安全网（≤60s）压住，见 design D2）。
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/**
 * 三个周期键的**代码默认值**（= 种子 = 旧 env 现值；缺失/非数 ⇒ 取这里的值）。
 * ⚠️ 与 `docs/superpowers/specs/2026-10-01-config-center-spec.md` §2.2 的种子逐键同值。
 */
export const CYCLE_MS_DEFAULTS = {
  'room.matchScanIntervalMs': 5_000,
  'room.autostartIntervalMs': 5_000,
  'room.reapIntervalMs': 60_000,
} as const;
export type CycleKey = keyof typeof CYCLE_MS_DEFAULTS;

/**
 * `currency.entryMultiplier` 的**代码默认值**（= 种子 = 规格 §1.1 第 14 键）。
 * 快照缺失/越界时 `entryMultiplier()` 取它（范围哨兵 —— 消费方永远拿到可用的数）。
 */
export const ENTRY_MULTIPLIER_DEFAULT = 10;

/**
 * `currency.rakePercent` 的**代码默认值**（= 种子 = 规格 §1.1 第 15 键）。
 * 快照缺失/越界时 `rakePercent()` 取它（范围哨兵）。**默认 0 = 零和**（设计 D3 起点）。
 */
export const RAKE_PERCENT_DEFAULT = 0;

/** 启动拉取失败后的重试间隔（design D2：**1s 退避重试直到首次成功**、不阻塞就绪）。 */
const STARTUP_RETRY_INTERVAL_MS = 1_000;

/**
 * room-service 的**配置快照缓存**（片⑦ design D2 —— 本片最要紧的一条）。
 *
 * ─── 行为（三件）────────────────────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到首次成功**
 *     （`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，错序窗口由
 *     重试 + 安全网自愈；compose 刻意不给消费服务加 `depends_on` 硬门）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用 `RedisProviderModule` 的实例；
 *     形态照 `ws.gateway.ts` 的订阅连接）；收到通知 ⇒ 重拉**全量**换缓存（不做增量；
 *     版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（分层，design D2 写死）─────────────────────────────────────
 *  「拿不到」= 缓存为空，且一次即时拉取也失败；缓存非空（哪怕旧）一律用缓存。
 *  - **热项**（开关/周期）取**代码默认值**（配置中心挂了**不得**停止服务）；
 *  - **底分档位**保持 **fail-closed**（`10007`，绝不静默放行）。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose **不设**）────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，C17a 的变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
 *
 * ─── 日志分源（R1107；T6 审查 Important-1）──────────────────────────────
 *  design D2 的「重载/失败都记 NDJSON（`source = config-reload 之类`）」落到本服务时
 *  **不新造 source 值**（`TRACE_SOURCES` 恰好五个、加值要动 shared 的判据）——
 *  按触发者分到**既有值**：
 *   - **定时器起的一轮**（启动 1s 退避循环的每一次尝试，含首拉 + 60s 安全网的一轮）
 *     ⇒ `{traceId: randomUUID(), source: 'timer'}`（先例：`rooms.reaper.ts` / `rooms.autostart.ts`
 *       / `match.service.ts` 的定时循环——「这一轮」就是来源，每轮自建 id）；
 *   - **订阅回调 / ioredis 错误**（内部事件，无客户端请求）⇒ `{traceId: null, source: 'internal'}`
 *     （先例：`ws.gateway.ts` 的两条订阅——不编造 id、来源如实）；
 *   - 请求驱动的即时拉（`baseScoreLevels()` 空缓存那一拉）**不包**：它跑在调用方的
 *     ALS 里（WS/HTTP 的 `edge`/`rpc`），承接请求的来源正是如实。
 *  ⚠️ `bootstrap`（「进程启动早期」）**不得当兜底用** —— 上面每条路径都必须落到真实来源。
 */
@Injectable()
export class ConfigCacheService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ConfigCacheService.name);

  /** 进程内快照（`null` = 从未拉到 —— 「拿不到」的定义见类注）。 */
  private snapshot: ConfigSnapshot | null = null;
  /** 专用订阅连接（`CONFIG_SYNC_DISABLE_PUSH` 时**不创建**）。 */
  private subscriber: Redis | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 首次成功快照的等待者（`waitForFirstSnapshot()`，测试用）。 */
  private firstSnapshotResolvers: Array<() => void> = [];
  /** 空缓存窗口内拉失败只 WARN 一次（下一次成功拉取后复位）—— 防 1s 重试刷屏。 */
  private warnedWhileEmpty = false;
  /**
   * 关停闸（T6 审查 Important-2）：`onApplicationShutdown` **第一行**置位；两条自重排链
   * （退避重试 / 安全网）在**排下一个定时器之前**查它 —— 关停发生在「一轮在途」期间时，
   * 迟到的回执不得再排新定时器（否则 `clearTimeout` 只清得住**已存在**的那一个，
   * 循环会在关停后「复活」，测试进程/容器就会看到永不停止的重拉）。
   */
  private shuttingDown = false;

  /** ⚠️ 空串=未设：`Number('') = 0` ⇒ 走默认 60000（`||` 不用 `??`）。 */
  private readonly safetyNetMs = Number(process.env.CONFIG_SYNC_SAFETY_NET_MS) || 60_000;
  /** ⚠️ 空串=未设：非空 ⇒ 关推送（`||` 语义同 I1；`undefined` 与 `''` 都算未设）。 */
  private readonly pushDisabled = (process.env.CONFIG_SYNC_DISABLE_PUSH || '') !== '';

  /** ⚠️ **值导入** `ConfigClient`（DI 陷阱纪律）：类型导入会被擦除 ⇒ 容器启动即崩。 */
  constructor(private readonly client: ConfigClient) {}

  onModuleInit(): void {
    // 🔴 **不得 await 首次拉取**（不阻塞就绪）：失败走 1s 退避重试，直到首次成功为止。
    this.pullWithRetry();
    if (!this.pushDisabled) this.startSubscription();
    this.scheduleSafetyNet();
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的迟到回执/`.finally` 据此**不再排新定时器**（Important-2）。
    this.shuttingDown = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (subscriber) void Promise.resolve(subscriber.quit()).catch(() => undefined);
  }

  // ─── 读面（getters）────────────────────────────────────────────────────

  /** 好友房开关。缺失/非 boolean ⇒ **false**（安全方向：配置说不清 ⇒ 不开）。 */
  friendRoomEnabled(): boolean {
    const value = this.snapshot?.['room.friendRoomEnabled']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /**
   * 免费场开关（② 金币场 §1.1 第 12 键；设计 D2）。缺失/非 boolean ⇒ **true**
   * ——与种子一致（`room.freeRoomEnabled=true`：免费场**保持现状开**，新开关不是为关它加的；
   * 配置说不清时不改变现状、不掐掉服务）。
   */
  freeRoomEnabled(): boolean {
    const value = this.snapshot?.['room.freeRoomEnabled']?.value;
    return typeof value === 'boolean' ? value : true;
  }

  /**
   * 金币场开关（② 金币场 §1.1 第 13 键；设计 D2）。缺失/非 boolean ⇒ **true**
   * ——与种子一致（`room.goldRoomEnabled=true`：**默认开**，2026-10-04 用户裁决；
   * 原「暗上线 = 缺省关」同款翻转。与 `freeRoomEnabled` 同一个方向：配置说不清时
   * 不改变种子现状、不掐服务）。
   */
  goldRoomEnabled(): boolean {
    const value = this.snapshot?.['room.goldRoomEnabled']?.value;
    return typeof value === 'boolean' ? value : true;
  }

  /**
   * 机器人补位开关片（第 45 键）：**免费场**匹配缺人时是否补机器人。
   * 缺失/非 boolean ⇒ **true**（与种子一致 = 现状：缺人等 30s 后补机器人开局；
   * 关掉后缺人只发 `match.wait_prompt`、绝不补机器人，总等待上限到点发 12007）。
   */
  freeBotFillEnabled(): boolean {
    const value = this.snapshot?.['room.freeBotFillEnabled']?.value;
    return typeof value === 'boolean' ? value : true;
  }

  /**
   * 机器人补位开关片（第 46 键）：**金币场**匹配缺人时是否补机器人。缺省方向与
   * `freeBotFillEnabled()` 逐字同（true = 现状）。`practice`（好友房）不读这两个开关。
   */
  goldBotFillEnabled(): boolean {
    const value = this.snapshot?.['room.goldBotFillEnabled']?.value;
    return typeof value === 'boolean' ? value : true;
  }

  /**
   * 机器人补位开关片（第 47 键）：补机器人**关闭**时，真人匹配的总等待上限（毫秒，
   * 自票的原始 `enteredAt` 起算；玩家点「延长」只平移提示窗口、不重置本上限）。
   * 缺失/非整数/越界 ⇒ 代码默认 300000（= 种子；范围哨兵照 protocol parser 30000..1800000）。
   */
  matchNoBotMaxWaitMs(): number {
    const value = this.snapshot?.['room.matchNoBotMaxWaitMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 30_000 &&
      value <= 1_800_000
      ? value
      : NO_BOT_MAX_WAIT_DEFAULT_MS;
  }

  /**
   * 入场门槛倍数（② 金币场 §1.1 第 14 键；设计 D8/§5.1 的 `baseScore × entryMultiplier`）。
   *
   * 缺失/非整数/**越界（范围哨兵）** ⇒ 代码默认 `10`（=种子）。范围照
   * `protocol/src/config.ts` 的 `parseEntryMultiplier`（`1..100`）—— 快照里出现越界值
   * 理论上不可能（写入口已拦），但消费方（门槛 14003 / 机器人水位）拿到的必须是
   * **可用的数字**：这里兜一道，绝不让 0/负数/小数漏进 `needed` 的乘法。
   */
  entryMultiplier(): number {
    const value = this.snapshot?.['currency.entryMultiplier']?.value;
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100
      ? value
      : ENTRY_MULTIPLIER_DEFAULT;
  }

  /**
   * 风控谓词开关之一（风控 §2.1 第 18 键 `risk.predicate.sameDevice`；§2.4-2 启停来自
   * config-cache · ⚙️8）。缺失/非 boolean ⇒ **false**（谓词**默认关** —— 与种子一致；
   * 默认关意味着匹配链走零新增读的快路径，行为与改造前同）。
   *
   * ⚠️ **消费纪律（⚙️8）**：`MatchService` **每轮扫描前读一次**（不是每个候选读一次）——
   * 热生效 ≤60s 的安全网是既有机制，本 getter 不引入新缓存。
   */
  riskPredicateSameDevice(): boolean {
    const value = this.snapshot?.['risk.predicate.sameDevice']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /** 风控谓词开关之二（第 19 键 `risk.predicate.sameIp`；语义与缺省同上一 getter）。 */
  riskPredicateSameIp(): boolean {
    const value = this.snapshot?.['risk.predicate.sameIp']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /**
   * 结算抽水比例（② 金币场 §1.1 第 15 键；设计 D3/§5 的 `floor(g × p / 100)`）。
   *
   * 缺失/非整数/**越界（范围哨兵，`0..50`）** ⇒ 代码默认 `0`（=种子：零和起点，
   * 抽水是运营开关不是默认行为）。范围照 `protocol/src/config.ts` 的 `parseRakePercent`。
   * 消费方 = T5 的结算算法（`settle.service.ts`）——它必须永远拿到一个可用的整数，
   * 绝不让越界值漏进 `floor(g × p / 100)`。
   */
  rakePercent(): number {
    const value = this.snapshot?.['currency.rakePercent']?.value;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 50
      ? value
      : RAKE_PERCENT_DEFAULT;
  }

  /**
   * 台费费率表（2026-10-21 起**唯一来源 = 各玩法档位表**；旧第 42 键已删）。
   *
   * 多玩法（Task 2.2 / D8）：`gameType` 缺省斗地主（既有调用零改动）——
   * 斗地主读旧键 `game.baseScoreLevels`，跑得快读 `game.levels.paodekuai`。
   *
   * **fail 方向 = 空表**：快照缺失 / 档位表缺失 / 形状坏 / 越界 ⇒ `[]`（= 全 0 = 不收），
   * **绝不抛** —— 与 `baseScoreLevels()` 的 fail-closed 相反。依据：收费是收入面，
   * 失败方向必须是不收（玩家无害），且不回退开局。
   *
   * ⚠️ 校验族**不复制第二份**：直接复用写入口的 `parseConfigValue`（唯一校验点纪律）；
   * 派生用 protocol 的 `entryFeePercentsFromLevels`（与客户端 `entryFeeOfLevel` 共用 `entryFeeOf` 公式）。
   */
  entryFeePercents(gameType: GameType = DEFAULT_GAME_TYPE): EntryFeePercent[] {
    const key = this.levelsKeyOf(gameType);
    const value = this.snapshot?.[key]?.value;
    if (value === undefined) return [];
    try {
      const levels = parseConfigValue(key, value) as BaseScoreLevel[];
      return entryFeePercentsFromLevels(levels);
    } catch {
      return [];
    }
  }

  /**
   * 玩法总开关（Task 2.2 / spec §4.7.1）：`game.paodekuai.enabled` 种子 `false`（暗上线）。
   * 斗地主恒开（本片不为它引入开关 —— 旧行为零变化）。
   */
  paodekuaiEnabled(): boolean {
    const value = this.snapshot?.['game.paodekuai.enabled']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /** 跑得快 2/4 人闸（Task 2.2 / D20）：种子 `false` ⇒ 只开放 3 人。 */
  paodekuaiNonThreePlayerEnabled(): boolean {
    const value = this.snapshot?.['game.paodekuai.nonThreePlayerEnabled']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /** 玩法是否开放（斗地主恒真；跑得快读运营开关）。 */
  gameEnabled(gameType: GameType): boolean {
    return gameType === 'paodekuai' ? this.paodekuaiEnabled() : true;
  }

  /**
   * 房间人数是否可开（Task 2.2 / spec §4.6.2）：先查 `GameMeta.supportedPlayerCounts`，
   * 再按 `game.paodekuai.nonThreePlayerEnabled` 把跑得快收窄为 `[3]`（D20）。
   * 斗地主只支持 3（`GameMeta` 单一真源）。
   */
  supportsRoomPlayerCount(gameType: GameType, playerCount: number): boolean {
    if (!supportsPlayerCount(gameType, playerCount)) return false;
    return gameType !== 'paodekuai' || playerCount === 3 || this.paodekuaiNonThreePlayerEnabled();
  }

  /**
   * 本局跑得快规则快照（spec §4.7.1 / §5.6）：11 个规则键组装成 `PdkRulesConfig`。
   *
   * 失败语义：
   *  - **缺键 ⇒ 默认值**（= 种子；快照未含该段时同旧配置缺段的处置）；
   *  - **存在但非法 ⇒ 抛**（`parseConfigValue` 的严格校验）—— spec §7.3：
   *    规则/配置错误必须在**开局前**暴露，不得在牌局中途静默降级。
   *    调用方（`rooms.start`）按「规则快照不可用」走 strict/retry（Task 2.4）。
   */
  pdkRules(): PdkRulesConfig {
    const read = (key: ConfigKey, fallback: boolean | number | PdkRulesConfig['airplaneWings']) => {
      const value = this.snapshot?.[key]?.value;
      return value === undefined ? fallback : (parseConfigValue(key, value) as typeof fallback);
    };
    return {
      bareTrioEnabled: read('game.paodekuai.bareTrioEnabled', DEFAULT_PDK_RULES.bareTrioEnabled) as boolean,
      trioWithPairEnabled: read('game.paodekuai.trioWithPairEnabled', DEFAULT_PDK_RULES.trioWithPairEnabled) as boolean,
      bareAirplaneEnabled: read('game.paodekuai.bareAirplaneEnabled', DEFAULT_PDK_RULES.bareAirplaneEnabled) as boolean,
      fourWithTwoEnabled: read('game.paodekuai.fourWithTwoEnabled', DEFAULT_PDK_RULES.fourWithTwoEnabled) as boolean,
      fourWithTwoPairKickerAllowed: read(
        'game.paodekuai.fourWithTwoPairKickerAllowed',
        DEFAULT_PDK_RULES.fourWithTwoPairKickerAllowed,
      ) as boolean,
      airplaneWings: read('game.paodekuai.airplaneWings', DEFAULT_PDK_RULES.airplaneWings) as PdkRulesConfig['airplaneWings'],
      bombMultiplierEnabled: read(
        'game.paodekuai.bombMultiplierEnabled',
        DEFAULT_PDK_RULES.bombMultiplierEnabled,
      ) as boolean,
      guanMultiplierEnabled: read(
        'game.paodekuai.guanMultiplierEnabled',
        DEFAULT_PDK_RULES.guanMultiplierEnabled,
      ) as boolean,
      springMultiplierEnabled: read(
        'game.paodekuai.springMultiplierEnabled',
        DEFAULT_PDK_RULES.springMultiplierEnabled,
      ) as boolean,
      multiplierCap: read('game.paodekuai.multiplierCap', DEFAULT_PDK_RULES.multiplierCap) as number,
      baobenEnabled: read('game.paodekuai.baobenEnabled', DEFAULT_PDK_RULES.baobenEnabled) as boolean,
    };
  }

  /** 玩法档位键：斗地主继续沿用旧键（D8：不迁移/不双写）；跑得快新键。 */
  private levelsKeyOf(gameType: GameType): 'game.baseScoreLevels' | 'game.levels.paodekuai' {
    return gameType === 'paodekuai' ? 'game.levels.paodekuai' : 'game.baseScoreLevels';
  }

  /**
   * 记牌器总开关（第 50 键）。缺失/非 boolean ⇒ **false**（与客户端 fail-safe 同向：
   * 说不清 = 不开放；急停方向安全）。消费方 = 开局状态块。
   */
  cardCounterEnabled(): boolean {
    const value = this.snapshot?.['game.cardCounterEnabled']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /**
   * 记牌器两价格（第 51/52 键）。缺失/类型漂移/越界 ⇒ **10/100**（= 种子；消费方拿到的
   * 必须是可用数字）。校验族复用写入口 `parseConfigValue`（唯一校验点纪律）。
   */
  cardCounterPrices(): { perGame: number; perHour: number } {
    const read = (
      key: 'game.cardCounterPricePerGameCoins' | 'game.cardCounterPricePerHourCoins',
      fallback: number,
    ): number => {
      const value = this.snapshot?.[key]?.value;
      if (value === undefined) return fallback;
      try {
        return parseConfigValue(key, value) as number;
      } catch {
        return fallback;
      }
    };
    return {
      perGame: read('game.cardCounterPricePerGameCoins', 10),
      perHour: read('game.cardCounterPricePerHourCoins', 100),
    };
  }

  /**
   * 周期键（毫秒）。缺失/非正数 ⇒ 代码默认值（5000/5000/60000）。
   * ⚠️ 消费方（四个循环）在**每一轮结束时**重读本方法 ⇒ 「改了下一轮生效」
   * （当前一轮按旧值跑完 —— C9 的口径）。
   */
  cycleMs(key: CycleKey): number {
    const value = this.snapshot?.[key]?.value;
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : CYCLE_MS_DEFAULTS[key];
  }

  /**
   * 底分档位表（fail-closed）。
   *
   * - 缓存非空（非空数组）⇒ 直接返回旧值（哪怕旧 —— design D2 的失败语义分层）；
   * - 缓存为空 ⇒ **即时拉一次**；拉成功仍取不到表 ⇒ 抛 `ConfigServiceError(10007)`；
   *   拉失败 ⇒ 抛 `snapshot()` 的原始错误（真 client 的形状 = `ConfigServiceError(10007)`
   *   或下游 5 位码 —— 与旧 `levels()` 逐字同级）。
   *
   * ⚠️ 与旧语义的差异**显式登记**（design D2）：旧 = 「每一次读都可能 10007」（每次 RPC）；
   * 新 = 「仅缓存为空的窗口内才可能 10007」。调用方（`RoomsService` / `MatchService`）的
   * catch → `DomainError(10007)` 翻译**逐字不变**。
   */
  async baseScoreLevels(gameType: GameType = DEFAULT_GAME_TYPE): Promise<BaseScoreLevel[]> {
    const cached = this.readLevels(gameType);
    if (cached) return cached;
    await this.refreshOnce();
    const again = this.readLevels(gameType);
    if (again) return again;
    // 快照在手但表缺失/非法（config-service 的写入口保证它不会发生）⇒ 仍按
    // 「拿不到」处置：固定文案 + 10007（绝不返回空数组 —— 片规格 §2.4 的红线）。
    // 多玩法（D8）：跑得快读 `game.levels.paodekuai`、**不回落**斗地主档位表。
    throw new ConfigServiceError(ErrCode.UPSTREAM_UNAVAILABLE, TRANSPORT_FAILURE_MESSAGE);
  }

  /** 首次快照就位的等待（**测试用**：给「启动拉取」一个可 await 的把手；生产不用）。 */
  waitForFirstSnapshot(): Promise<void> {
    if (this.snapshot !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.firstSnapshotResolvers.push(resolve);
    });
  }

  // ─── 内部：拉取 / 订阅 / 定时器 ────────────────────────────────────────

  /**
   * 启动期拉取：失败 ⇒ 1s 后重试，**直到首次成功为止**（其后由通知/安全网驱动）。
   *
   * ⚠️ 用 `.then(onOk, onErr)` 二参形态（不是 `.catch().finally()` 链）—— 保证
   * 「重试调度」只挂在失败支路上，成功支路不会误排一个新定时器。
   *
   * 日志分源（R1107）：退避循环的**每一次尝试**（含首拉）都是「定时器起的一轮」
   * ⇒ `{traceId: randomUUID(), source: 'timer'}`（首拉也在本循环里 —— 起栈日志
   * `task-6-room-boot.log` 路径上它就是第 1 轮）。
   */
  private pullWithRetry(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      this.refreshOnce().then(
        () => undefined,
        (err: unknown) => {
          this.onRefreshFailed(err);
          // 🔴 关停闸（Important-2）：迟到的失败回执不得在关停后再排退避定时器。
          if (this.shuttingDown) return;
          this.retryTimer = setTimeout(() => this.pullWithRetry(), STARTUP_RETRY_INTERVAL_MS);
        },
      );
    });
  }

  /** 拉全量快照并**整体换缓存**（成功路径：通知/安全网/启动重试/空缓存即时拉共用）。 */
  private async refreshOnce(): Promise<void> {
    const res = await this.client.snapshot();
    this.snapshot = res.config;
    this.warnedWhileEmpty = false;
    // 首次成功 ⇒ 停掉启动重试（若已由安全网抢先成功，这里清掉的是一次多余的重试）。
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.logger.log(
      `config snapshot applied (version=${res.version}, friendRoomEnabled=${this.friendRoomEnabled()}, baseScoreLevels=${this.readLevels()?.length ?? 0})`,
    );
    if (this.firstSnapshotResolvers.length > 0) {
      const resolvers = this.firstSnapshotResolvers;
      this.firstSnapshotResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /**
   * 拉取失败的统一留痕（不透传 ≠ 不留痕）：
   *  - **空缓存**（= design D2 的「拿不到」）⇒ WARN **一次**（1s 重试不再刷屏；成功拉取后复位）；
   *  - **有旧值** ⇒ 继续用旧值，每次失败各记一条（推送/安全网各有节奏，不会刷屏）。
   */
  private onRefreshFailed(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    if (this.snapshot === null) {
      if (!this.warnedWhileEmpty) {
        this.warnedWhileEmpty = true;
        this.logger.warn(`config snapshot unavailable (serving code defaults): ${reason}`);
      }
      return;
    }
    this.logger.warn(`config snapshot reload failed (keeping cached snapshot): ${reason}`);
  }

  /**
   * 🔴 **专用连接**（design D1 M-5）：ioredis 进入 subscribe 模式后该连接**不能再发普通
   * 命令** ⇒ 必须独立 `new Redis(...)`，不得复用各服务现有 provider 实例。
   * `CONFIG_SYNC_DISABLE_PUSH` 非空时本方法**根本不会被调用**（连接都不会建）。
   *
   * 日志分源（R1107）：订阅面是**内部事件**（没有对应的客户端请求）⇒
   * `{traceId: null, source: 'internal'}`（先例 `ws.gateway.ts` 的两条订阅）。
   */
  private startSubscription(): void {
    const subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.subscriber = subscriber;
    runWithTrace({ traceId: null, source: 'internal' }, () => {
      subscriber.on('error', (err: Error) =>
        // ⚠️ ioredis 的回调**不在**注册时那层包裹的作用域里（事件循环自有其异步上下文，
        // ALS 按「谁发起的」传播）⇒ 处理器内部**再包一次**（ws.gateway.ts 的同款注记）。
        runWithTrace({ traceId: null, source: 'internal' }, () =>
          this.logger.error(`Redis subscriber error: ${err.message}`),
        ),
      );
      subscriber.on('message', (channel: string) =>
        // 同上：回调内再包一次 —— 否则重载日志会落回 `bootstrap`（假话）。
        runWithTrace({ traceId: null, source: 'internal' }, () => this.handleConfigChanged(channel)),
      );
      void subscriber
        .subscribe(CONFIG_CHANGED_CHANNEL)
        .then(() => this.logger.log(`Subscribed to ${CONFIG_CHANGED_CHANNEL}`))
        .catch((err: unknown) => {
          // 订阅失败不致命：安全网仍会把最坏情况压到 ≤60s（design D2 的最后一道）。
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `subscribe ${CONFIG_CHANGED_CHANNEL} failed (safety net still applies): ${reason}`,
          );
        });
    });
  }

  /**
   * 收到 `config:changed` ⇒ 重拉全量换缓存。
   * ⚠️ **不解析 payload、不做增量、不比版本**（简单优先 —— 全量很小，少一处出错的地方）。
   * 返回 Promise 是为了让测试可以 await 这条路径（ioredis 侧不看返回值）。
   */
  private async handleConfigChanged(channel: string): Promise<void> {
    if (channel !== CONFIG_CHANGED_CHANNEL) return;
    try {
      await this.refreshOnce();
    } catch (err) {
      this.onRefreshFailed(err);
    }
  }

  /**
   * 安全网：每 `safetyNetMs` **无条件**重拉一次；拉完（无论成败）重排下一轮（自重排）。
   *
   * 日志分源（R1107）：这也是「定时器起的一轮」⇒ 每轮自建 traceId + `source: 'timer'`。
   * 🔴 关停闸（Important-2）：重排前查 `shuttingDown` —— 一轮在途时关停，`.finally`
   * 迟到的重排必须被拦住。
   */
  private scheduleSafetyNet(): void {
    this.safetyTimer = setTimeout(() => {
      runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
        void this.refreshOnce()
          .catch((err: unknown) => this.onRefreshFailed(err))
          .finally(() => {
            if (!this.shuttingDown) this.scheduleSafetyNet();
          });
      });
    }, this.safetyNetMs);
  }

  /** 取缓存里的档位表（按玩法）：非空数组 ⇒ 返回；否则 `null`（「取不到」）。 */
  private readLevels(gameType: GameType = DEFAULT_GAME_TYPE): BaseScoreLevel[] | null {
    const value = this.snapshot?.[this.levelsKeyOf(gameType)]?.value;
    return Array.isArray(value) && value.length > 0 ? (value as BaseScoreLevel[]) : null;
  }
}
