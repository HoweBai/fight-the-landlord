import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  DEFAULT_GAME_TYPE,
  ErrCode,
  GAME_META,
  isGameType,
  supportsPlayerCount,
  type GameType,
} from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { CHANNELS } from '../channels';
import { ConfigCacheService } from '../config/config-cache.service';
import { RobotClient } from '../gateway/robot.client';
import { DomainError } from '../http/errors';
import { RoomsService } from '../rooms/rooms.service';
import { RoomStartService } from '../rooms/rooms.start';
// 监控片（规格 §2.2 / O4）：队列深度 gauge —— 定义是模块级常量，写点挂在下面既有扫描环内。
// 风控片 T2：三个选择链指标（谓词拒绝 / 抽选轮次 / 不成组）同族（§2.12 room 行）。
import {
  matchNoLegalGroupTotal,
  matchPredicateRejectionsTotal,
  matchQueueLength,
  matchSelectionRoundsTotal,
} from '../metrics/room.metrics';
// 风控片 T2（§2.4-1/2）：谓词框架 —— 类型 + 两条谓词 + 全两两判定。
// ⚠️ `predicates.ts` 对本文件只有**类型导入**（`import type`，被擦除）⇒ 不成环。
import {
  canFormTable,
  PICK_FAILURE_MARK_TTL_MS,
  PREDICATE_REGISTRY,
  type MatchPredicate,
} from './predicates';

/**
 * 匹配成功 / 匹配超时事件频道：room-service 内的 WsGateway 订阅它来下发（§8.2 / R46）。
 *
 * ⚠️ 值的**单一真源**已挪到 `../channels`（那里还解释了为什么要挪：开局链抽出去之后
 * 「从这里取」会成环）。这里保留这个名字，只为既有调用方不改。
 */
export const MATCH_EVENTS_CHANNEL = CHANNELS.matchEvents;

/** §8.1：MVP 恒为 'global'，为地理谓词预留。 */
export const DEFAULT_REGION = 'global';

/**
 * 匹配模式（② 金币场 §2.1 起**三值**：`'random' | 'practice' | 'gold'`；协议面同步，
 * REST 建房的 DTO 枚举**不含 gold** —— 那条路 practice-only，勿机械跟改）。
 */
export type MatchMode = 'random' | 'practice' | 'gold';

/**
 * 撮合维度的**声明空间**（§8.1）。region 维度**现在就带着**，使地理扩展是加性变更（R43）。
 *
 * ⚠️ 片规格 §2.4 之后它们**不再用于「枚举队列」**：键里多了底分那一维（room-service 不知道
 * 全部底分，见 `parseMatchQueueKey` 与 `cancelQueue` 的注释）⇒ 每轮扫描改为
 * `SCAN match:queue:*` 再按 `MATCH_MODES` 解析。`MATCH_MODES` 因此仍是
 * **模式集合的单一真源**（解析器从它构造；② 起含 `gold` —— 解析/扫描自动跟进）；
 * `MATCH_REGIONS` 保留为 MVP 的 region 声明。
 */
export const MATCH_MODES: readonly MatchMode[] = ['random', 'practice', 'gold'] as const;
export const MATCH_REGIONS: readonly string[] = [DEFAULT_REGION] as const;

/** §10.4：匹配元数据保留 300s。 */
export const MATCH_META_TTL_SECONDS = 300;

/**
 * `MATCH_PENDING_TTL_SECONDS` / `matchPendingKey` / `PendingMatch` 的**真源已挪到叶子模块**
 * `./match-keys`（那里解释了为什么要挪：本片起 `rooms.start` / `ws.gateway` 也读写这个键，
 * 从本文件导入会构成 CJS 模块环）。这里保留 re-export，只为既有导入方不改。
 */
export {
  MATCH_PENDING_TTL_SECONDS,
  matchPendingKey,
  type PendingMatch,
} from './match-keys';

/** §8.4：人数不足时，自最早入队者的 `enteredAt` 起算的等待窗口。 */
export const BOT_FILL_WAIT_MS = 30_000;
/**
 * 机器人补位开关片：补机器人**关闭**时，越过等待窗口发给在等玩家的友好提示文案
 * （`match.wait_prompt`）。票不终止 —— 玩家可「继续等待」或取消后「重新匹配」。
 *
 * ⚠️ 面向玩家：不出现「真人 / 机器人 / 玩家不足」等表述（不暴露补位机制）；
 * 长度 ≤ 16 字（客户端底部悬浮卡片按单行排版，见设计 spec §4.3）。
 */
export const MATCH_WAIT_PROMPT_MESSAGE = '正在为你安排牌桌，请稍等片刻。';
/** §8.4：等待超过 60 秒 → 三级回退。 */
export const MATCH_MAX_WAIT_MS = 60_000;
/** §8.4：`attempts >= 10` → 三级回退。 */
export const MATCH_MAX_ATTEMPTS = 10;

/**
 * §2.3（风控 T2）：命中计数键 `risk:hit:{userId}:{predicate}` 的 TTL = **7d**。
 * 每次 INCR 后 EXPIRE（详情面读的是「近 7 天命中」）。
 */
export const RISK_HIT_TTL_SECONDS = 604_800;

/**
 * §2.3（风控 T2）：失败对的**记忆键** `match:rejected:{a}:{b}` —— **字典序**拼接，
 * 同一对不论从哪边查/写都落同一键；值 = 失败时刻 ms；TTL = `PICK_FAILURE_MARK_TTL_MS`（5s）。
 */
export function matchRejectedKey(a: string, b: string): string {
  return a <= b ? `match:rejected:${a}:${b}` : `match:rejected:${b}:${a}`;
}

/** 本片（规格 §2.5 逐字）：`match:claim:<playerId>` 的 TTL = **30s**（只靠 TTL 过期、不显式释放）。 */
export const MATCH_CLAIM_TTL_SECONDS = 30;

/**
 * 本片：玩家维度 **in-flight 声明**键 —— `startGroup` 组队成形时写（仅金币场）、
 * 撮合候选筛选读（`alive` 段批读；只跳过、不 `cancelQueue`）。
 * 目的：重叠轮/下轮扫描不把「已被某组带走、开局链在途」的人再选进第二间房
 * （不同房间号 ⇒ 收费锚防重管不着；设计 §2.7 的跨房重扣防线）。
 */
export function matchClaimKey(playerId: string): string {
  return `match:claim:${playerId}`;
}

/** §4.3：`game.start` 的跨服务超时（此前靠裸 `fetch` + `AbortController` 实现，偏差 A7/E10）。 */
export const GAME_START_TIMEOUT_MS = 3000;

/** §4.3：`robot.acquire`（room → robot）的跨服务超时（R151 —— A7 证据行点名的另一半）。 */
export const ROBOT_ACQUIRE_TIMEOUT_MS = 3000;

/**
 * §4.3 / R210（A7⑤）：跨服务调用的**最大尝试次数** —— 首次失败后**恰好重试 1 次**。
 *
 * 前提是接收端**幂等**（§4.3 的「幂等前提」）：
 *  - `game.start`：同 `roomCode` 重复调用复用会话（`GameService.startGame` 的既有幂等）；
 *  - `robot.acquire`：同 `{roomCode, seat}` 返回**同一个** `BotInstance`（R201 的幂等池）。
 */
export const RPC_MAX_ATTEMPTS = 2;

/**
 * 匹配队列键（§8.1 + 片规格 §2.4 + 多玩法 D5）。
 *
 * **形状按玩法二选一**（D5 —— 斗地主零迁移、零回滚风险）：
 *  - 斗地主恒**旧 3 段键** `match:queue:{mode}:{baseScore}:{region}`；
 *  - 跑得快恒**新 5 段键** `match:queue:{mode}:paodekuai:{playerCount}:{baseScore}:{region}`。
 *
 * ⚠️ `playerCount` 对斗地主不参与组键（它必须为 3；调用方在 Task 2.2 起用
 * `supportsPlayerCount` 拒非法人数）——这里**不得**给斗地主多写一段，否则部署窗口里的
 * 旧服务/旧票会立刻错键（D5 的红线）。
 */
export function matchQueueKey(
  mode: MatchMode,
  gameType: GameType,
  playerCount: number,
  baseScore: number,
  region = DEFAULT_REGION,
): string {
  return gameType === 'doudizhu'
    ? `match:queue:${mode}:${baseScore}:${region}`
    : `match:queue:${mode}:${gameType}:${playerCount}:${baseScore}:${region}`;
}

/** 扫描队列键的模式（`cancelQueue` 的兜底与每轮匹配扫描共用同一个形状）。 */
const MATCH_QUEUE_SCAN_PATTERN = 'match:queue:*';

/** 新 5 段键（跑得快）；先于旧 3 段解析。 */
const NEW_QUEUE_KEY_PATTERN = new RegExp(
  `^match:queue:(${MATCH_MODES.join('|')}):([a-z]+):(\\d+):(\\d+):(.+)$`,
);
/** 旧 3 段键（斗地主，D5：零迁移）。 */
const LEGACY_QUEUE_KEY_PATTERN = new RegExp(`^match:queue:(${MATCH_MODES.join('|')}):(\\d+):(.+)$`);

/**
 * 扫出来的一条队列键的**解析结果**。
 *
 * ⚠️ `key` 是**实际键**（spec §4.6.1：所有按键操作必须用它）—— `processQueue`/`failMatch`
 * 一律以它为准，**不得**用 `(mode, gameType, playerCount, baseScore, region)` 重建新键
 * （重建会让旧 3 段票/历史形状键永不匹配）。
 */
export interface ParsedQueueKey {
  key: string;
  mode: MatchMode;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  region: string;
  /** 旧 3 段键（部署窗口里的存量队列/旧票）；新 5 段键为 false。 */
  legacy: boolean;
}

/**
 * `matchQueueKey` 的**逆函数**（片规格 §2.4 的底分维度 + 多玩法 D5）：**先按新 5 段解析，
 * 再按旧 3 段解析**。
 *
 * ⚠️ 为什么匹配扫描器要「扫键」而不是「按档位枚举」：room-service **不查档位表**
 * （那是 RPC，且档位表可变 —— 枚举法对「已下架档位」的残留队列是**永久漏扫**，
 * 那些票会卡在 ZSet 里直到被人看见）。`SCAN` 穷举**不依赖任何外部状态**，
 * 与 `cancelQueue` 的兜底是同一个理由（见那里的注释）。
 *
 * mode 的集合**来自 `MATCH_MODES` 本身**（不是手写的第三份真源）；玩法/人数按
 * `GAME_TYPES`/`GameMeta.supportedPlayerCounts` 校验，不认识的一律返回 `null`
 * （调用方跳过），坏键不得把整轮扫描带崩。
 */
export function parseMatchQueueKey(key: string): ParsedQueueKey | null {
  const five = NEW_QUEUE_KEY_PATTERN.exec(key);
  if (five) {
    const gameType = five[2]!;
    const playerCount = Number(five[3]);
    if (!isGameType(gameType) || !supportsPlayerCount(gameType, playerCount)) return null;
    return {
      key,
      mode: five[1] as MatchMode,
      gameType,
      playerCount,
      baseScore: Number(five[4]),
      region: five[5]!,
      legacy: false,
    };
  }
  const three = LEGACY_QUEUE_KEY_PATTERN.exec(key);
  if (!three) return null;
  // 旧 3 段 ⇒ 斗地主/3/legacy（D5：旧键语义不因平台化而改）。
  return {
    key,
    mode: three[1] as MatchMode,
    gameType: DEFAULT_GAME_TYPE,
    playerCount: GAME_META[DEFAULT_GAME_TYPE].defaultPlayerCount,
    baseScore: Number(three[2]),
    region: three[3]!,
    legacy: true,
  };
}

/** §10.1：排队元数据。**不是** `match:pending`（R42）。 */
export function matchMetaKey(playerId: string): string {
  return `match:meta:${playerId}`;
}

/** §3.5 的 MatchTicket。`latency` 在 MVP 恒为 0（R45）。片规格 §2.4：`baseScore` 是撮合维度。 */
export interface MatchTicket {
  playerId: string;
  mode: MatchMode;
  baseScore: number;
  region: string;
  enteredAt: number;
  latency: number;
  attempts: number;
  /**
   * 多玩法（Task 2.1）：玩家实际所在的队列键 —— **写入时冻结**。旧票缺省（部署窗口里
   * 只有三座时代的 meta）⇒ `queueKeyOfTicket` 回落到旧 3 段键。
   *
   * ⚠️ 这是「取消/探测用**真实键**」的载体（spec §4.6.1）：发票之后不得再按解析值重建。
   */
  queueKey?: string;
  /** 多玩法（Task 2.1）：玩法维度。旧票缺省 ⇒ 斗地主（K3 兼容语义）。 */
  gameType?: GameType;
  /** 多玩法（Task 2.1）：人数维度。旧票缺省 ⇒ `GameMeta[gameType].defaultPlayerCount`。 */
  playerCount?: number;
  /**
   * 风控 §2.3/§2.4-2（T2）：`match:meta` 的 `ip` —— 谓词 `sameIp` 的判定输入。
   * 缺 = 字段不存在（fail-open：谓词视为允许；写入点是 T3 的 `addToQueue` 扩展）。
   */
  ip?: string;
  /** 风控 §2.3/§2.4-2（T2）：`deviceId`（同 `ip` 的纪律）。 */
  deviceId?: string;
  /**
   * 机器人补位开关片：等待提示窗口的**锚点**（epoch ms）。缺 = 以 `enteredAt` 为锚；
   * 玩家在 `match.wait_prompt` 悬浮卡片点「继续等待」（`room.match.extend`）后平移到
   * 确认时刻 —— 下一个 30s 窗口前不再提示。**总等待上限不看它**（恒以 `enteredAt` 起算）。
   */
  promptAnchorAt?: number;
}

/**
 * 发票 → 队列键的**唯一映射**（spec §4.6.1）。
 *
 * 优先级：票上冻结的 `queueKey` ＞ 旧票（缺 gameType/playerCount）的旧 3 段键 ＞
 * 按 `matchQueueKey` 构造。旧票必须落回**旧 3 段键** —— 用新形状重建会让部署窗口里的
 * 存量票永远清不掉/探测不到（B4/RB2）。
 */
export function queueKeyOfTicket(ticket: MatchTicket): string {
  if (ticket.queueKey !== undefined) return ticket.queueKey;
  const gameType = ticket.gameType ?? DEFAULT_GAME_TYPE;
  const playerCount = ticket.playerCount ?? GAME_META[gameType].defaultPlayerCount;
  return matchQueueKey(ticket.mode, gameType, playerCount, ticket.baseScore, ticket.region);
}

/** 队列快照条目（`ZRANGE … WITHSCORES` 的原文：member + `score` = enteredAt）。 */
interface QueueEntry {
  playerId: string;
  enteredAt: number;
}

/**
 * `match_queue_length` 的聚合桶（Task 2.3）：同一 `(mode, gameType, playerCount, baseScore)`
 * 的多条 region 键**求和**。旧实现的键只有 `(mode, baseScore)` —— 会把「跑得快 3 人」和
 * 「斗地主」同底分的队列**加在一起**（spec §4.6.1：至少不能这样聚合）。
 */
interface QueueDepthBucket {
  mode: MatchMode;
  gameType: GameType;
  playerCount: number;
  baseScore: number;
  depth: number;
}
type QueueDepthLabels = Omit<QueueDepthBucket, 'depth'>;

/**
 * 风控 T2：**一轮扫描的持有对象**（`scanAndMatchInner` 建在 for 之上、按引用透传给每个桶）。
 *  - `can`：可用性门禁的跨桶 memo（片② D5/J20 的 `??=` 纪律 —— 每轮至多一次 RPC）；
 *  - `predicates`：本轮启用的谓词表（⚙️8：**每轮扫描前读一次**配置）。
 */
interface MatchRound {
  /**
   * 可用性门禁的跨桶 memo —— **按玩法**（Task 2.6 / spec §4.6.1）：每轮每种玩法至多一次 RPC。
   * 旧实现单个 boolean 会让一轮里的 pdk 桶复用 ddz 的 DouZero 结论（或反之）。
   */
  canByGameType: Map<GameType, boolean>;
  predicates: readonly MatchPredicate[];
}

/** 一对候选的判定结果（`judgePair`）：放行，或被拒（记忆命中 / 被哪些谓词拒 —— 供记账用）。 */
type PairVerdict =
  | { ok: true }
  | { ok: false; memory: boolean; rejected: readonly MatchPredicate[] };

@Injectable()
export class MatchService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MatchService.name);
  /**
   * 扫描循环的定时器。片⑦ T7 起是 **`setTimeout` 自重排链**（不再是 `setInterval`；
   * 周期来自 `configCache.cycleMs('room.matchScanIntervalMs')` —— env 覆盖的
   * `MATCH_SCAN_INTERVAL_MS` 已退役）。
   */
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 关停闸（照 `ConfigCacheService` 的成例）：在途一轮的 `.finally` 迟到回执
   * **不得**在关停后再排定时器（否则 `clearTimeout` 只清得住已存在的那一个，
   * 循环会在关停后「复活」）。
   */
  private shuttingDown = false;

  /**
   * 监控片（规格 §2.2）：上一轮**已 set 过** `match_queue_length` 的 `mode|baseScore`
   * 组合 —— 本轮消失的档位要归零（队列清空 ⇒ Redis 自动删键 ⇒ SCAN 扫不到；
   * 不归零的话旧读数会永远挂在面板上）。见 `publishQueueDepths`。
   */
  private publishedQueueDepths = new Map<string, QueueDepthLabels>();

  constructor(
    private readonly redis: Redis,
    private readonly roomsService: RoomsService,
    /**
     * 本片（spec §2.2 / R915）：**补机器人 + 开局 + 通知**搬到了 `RoomStartService`
     *（手动房与匹配路径共用；`playing` 的写入点因此只剩一处）。
     * ⚠️ 搬家的**理由**是模块依赖：本模块已经依赖 `RoomsModule`，若再让 rooms 侧
     * 反过来注入本服务，两边就成环（Nest 报循环依赖）。
     */
    private readonly roomStart: RoomStartService,
    /**
     * 片规格 §2.5（「非法 `baseScore` 被拒：`room.match` 与 `POST /api/rooms` 两条路都要测」）：
     * 入队前要校验底分属于档位表 ⇒ 本服务依赖与 `RoomsService` **同一个**
     * `ConfigCacheService` 单例（片⑦ T7 起从 `ConfigClient` 重接线到它 —— 快照缓存，
     * 同一张表、同一个 10007 失败语义；`ConfigCacheService` 由 `ConfigCacheModule`
     * 提供并 export）。
     *
     * ⚠️ **值导入**（不是 `import type`）：`emitDecoratorMetadata` 需要运行期的类引用，
     * 类型导入会在容器解析依赖时变成 `Object` ⇒ **启动即崩**（本仓已知的 DI 陷阱；
     * `rooms.service.ts` 的 `configCache` 参数上写着同一句，`ws.module.wiring.test.ts`
     * 是钉住这件事的容器门禁）。
     */
    private readonly configCache: ConfigCacheService,
    /**
     * 片② D5（Task 6）：**可用性门禁**的探询边（room → robot 的 `robot.availability`，
     * 与 `RoomStartService` 用的是同一个客户端类 —— 由 `RpcClientsModule` 提供并 export）。
     *
     * ⚠️ 与上面的 `configCache` 同一条 DI 规则：**值导入**（`import type` 会让元数据变成
     * `Object` ⇒ 容器启动即崩，且单测全绿）。
     */
    private readonly robot: RobotClient,
  ) {}

  /** §7.3 偏差 A4：`startMatchingLoop()` 此前**从未被调用** → 匹配循环不启动。 */
  onModuleInit(): void {
    this.startMatchingLoop();
  }

  /** 可注入时钟（**仅供测试**；生产路径永远是 `Date.now`）。 */
  private clock: () => number = () => Date.now();

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /**
   * 风控 T2（§2.4-3）：可注入随机源（**仅供测试**；生产路径永远是 `Math.random`）——
   * 照 `setClock` 的成例（字段 + setter）。
   *
   * ⚠️ **不得**改成构造器形参（F5 的定案）：裸可选参在 Nest 的 DI 里会以 `Function`
   * token 去解析（**容器启动即崩**），而单测直接 `new` 看不见这个形态 —— 又是
   * 「单测看不见的 DI 陷阱」家族。
   */
  private rng: () => number = () => Math.random();

  setRng(rng: () => number): void {
    this.rng = rng;
  }

  /** §8.1：读回排队元数据。字段缺失（键过期）时返回 `null`。 */
  async readMeta(playerId: string): Promise<MatchTicket | null> {
    const raw = await this.redis.hgetall(matchMetaKey(playerId));
    if (!raw || Object.keys(raw).length === 0) return null;
    const ticket: MatchTicket = {
      playerId,
      /**
       * 🔴 **保真三值**（② §2.1）：`gold` 票必须原样读回。修前这里把「非 practice」
       * 一律归一成 `'random'`（二值时代的形状）—— 后果是**金币票的 `cancelQueue`
       * 照着归一出错键**（`match:queue:random:…`）：ZREM 落空、meta 一删，票就永远
       * 残留在金币队列里（R63 的孤儿形态反过来咬一次，且 C21 的「取消后 60s 内不得
       * 再被撮合」直接失效）。不认识/缺省的旧 meta 仍落 `'random'`（兼容）；
       * 成员集合取自 `MATCH_MODES` 单一真源，不手写第三份字面量。
       */
      mode: (MATCH_MODES as readonly string[]).includes(raw.mode ?? '')
        ? (raw.mode as MatchMode)
        : 'random',
      // 片规格 §2.4：底分是 Ticket 的撮合维度（迁移期缺字段的旧 meta 记 0 —— 它永远不会
      // 与任何真实队列键相等，好过编一个「看似合法」的档位值）。
      baseScore: Number(raw.baseScore ?? 0),
      region: raw.region ?? DEFAULT_REGION,
      enteredAt: Number(raw.enteredAt ?? 0),
      latency: Number(raw.latency ?? 0),
      attempts: Number(raw.attempts ?? 0),
    };
    // 风控 §2.3（T2）：两新字段 —— **缺 ⇒ 不上字段**（谓词侧 fail-open 的一半；
    // 「有则读回」的判据用 `in` 钉住 —— `toEqual` 会忽略 undefined 值，钉不住）。
    if (raw.ip !== undefined) ticket.ip = raw.ip;
    if (raw.deviceId !== undefined) ticket.deviceId = raw.deviceId;
    /**
     * 多玩法（Task 2.1）：三新字段同一条「缺 ⇒ 不上字段」纪律（`queueKeyOfTicket` 据此
     * 识别旧票）。值非法（含历史写回的字符串 `"undefined"`）⇒ 按缺省处理 + WARN：
     * 扫描前置筛选每票都会走到这里，**不得**让一条坏 meta 把整轮扫描带崩。
     */
    if (raw.queueKey !== undefined && raw.queueKey !== 'undefined' && raw.queueKey !== '') {
      ticket.queueKey = raw.queueKey;
    }
    if (raw.gameType !== undefined) {
      if (isGameType(raw.gameType)) {
        ticket.gameType = raw.gameType;
      } else {
        this.logger.warn(`match:meta:${playerId} has invalid gameType ${JSON.stringify(raw.gameType)} — treating as legacy`);
      }
    }
    if (raw.playerCount !== undefined) {
      const count = Number(raw.playerCount);
      const gameType = ticket.gameType ?? DEFAULT_GAME_TYPE;
      if (Number.isInteger(count) && count > 0 && supportsPlayerCount(gameType, count)) {
        ticket.playerCount = count;
      } else {
        this.logger.warn(`match:meta:${playerId} has invalid playerCount ${JSON.stringify(raw.playerCount)} — treating as absent`);
      }
    }
    // 机器人补位开关片：提示窗口锚点（缺字段 = 以 enteredAt 为锚；NaN 也按缺省处理）。
    if (raw.promptAnchorAt !== undefined && Number.isFinite(Number(raw.promptAnchorAt))) {
      ticket.promptAnchorAt = Number(raw.promptAnchorAt);
    }
    return ticket;
  }

  /**
   * 加入匹配队列（§8.1）：队列 ZSet + `match:meta`（R42）。底分进键、也进 meta（片规格 §2.4）。
   *
   * 🔴 **入队前先校验底分属于档位表**（片规格 §2.5 的匹配那条）：校验点在**写任何键之前** ——
   * 非档位值放行会建出一条**只有他自己**的毒化队列（没有别人会拿那个底分去匹配），
   * 扫描器每轮为它建一次房、每轮撞 `create()` 的档位校验，玩家白等 60 秒拿 12007。
   *
   * ⚠️ 校验**不缓存**档位表：表可以被后台改（规格 §2.3），缓存会把「改了即生效」变成
   * 「改了要重启」——那正是本片要保住的性质（`RoomsService.create()` 每次也重新读表）。
   *
   * 🔴 **写序：HSET meta 先于 ZADD —— 顺序是语义的一部分（风控 T3 · 波 1 核验 F1′）**：
   * 扫描的**前置筛选**对每张 ZSet 成员票无条件 `readMeta`（风控 T2 §2.4-3：读不到 = 孤儿
   * ⇒ 静默 `cancelQueue` 清出）。旧序（ZADD → HSET）的窗口里，成员已可见而 meta 未落 ——
   * 扫描恰好落在两步之间就会把这张**正在入队**的票当孤儿清掉，随后 HSET 落地 ⇒ 玩家
   * ack 成功却不在队列（静默失联，窗口 ≈ 一次 Redis RTT/次入队）。新序（meta 先写、
   * 成员后现）下扫描**绝不会**见到「有票无 meta」的**本路径**成员；反向窗口（meta 在、
   * 成员未现）无任何消费者（读 meta 的只有 `cancelQueue` 与前置筛选，两者对孤 meta 无害）。
   * 顺序由 `match.service.test.ts` 的 op-log（`invocationCallOrder`）断言用例机械钉住。
   */
  async addToQueue(
    playerId: string,
    mode: MatchMode,
    baseScore: number,
    region = DEFAULT_REGION,
    /**
     * 风控 T3（规格 §2.3 `match:meta` 行）：随单写入的新字段（`ip` / `deviceId`）。
     * **存在才写对应 Hash 字段**（缺 = 不写 —— 谓词侧 fail-open 的写入侧）。
     * 调用方 = `handleMatch`（`socket.data.clientIp` + 校验后的 `deviceId`）。
     */
    extras?: { ip?: string; deviceId?: string },
    /**
     * 多玩法（Task 2.1）：`gameType` / `playerCount` 维度。缺省 = 斗地主/3（旧调用面零改动）。
     * 写入 `match:meta` 的 `gameType`/`playerCount`/`queueKey`（后者是取消/探测的真实键）。
     */
    dimensions?: { gameType?: GameType; playerCount?: number },
  ): Promise<void> {
    const gameType = dimensions?.gameType ?? DEFAULT_GAME_TYPE;
    const playerCount = dimensions?.playerCount ?? GAME_META[gameType].defaultPlayerCount;
    await this.assertKnownBaseScore(gameType, baseScore);
    const queueKey = matchQueueKey(mode, gameType, playerCount, baseScore, region);
    const now = this.clock();
    const meta: Record<string, string> = {
      playerId,
      mode,
      baseScore: String(baseScore),
      region,
      enteredAt: String(now),
      latency: '0',
      attempts: '0',
      gameType,
      playerCount: String(playerCount),
      queueKey,
    };
    if (extras?.ip !== undefined) meta.ip = extras.ip;
    if (extras?.deviceId !== undefined) meta.deviceId = extras.deviceId;
    await this.redis.hset(matchMetaKey(playerId), meta);
    await this.redis.expire(matchMetaKey(playerId), MATCH_META_TTL_SECONDS);
    await this.redis.zadd(queueKey, now, playerId);
    this.logger.log(`Player ${playerId} added to queue: ${mode}/${baseScore}/${region}`);
  }

  /**
   * 底分必须属于**当前生效的**档位表（片规格 §2.5）—— 与 `RoomsService.create()` 走
   * **同一条** room→user RPC 边、同一条规则、同一个码、同一句消息：两条路的拒绝形状
   * 必须一致（否则「两条路都测过」可能测的是两份不同的真源）。
   *
   * ⚠️ **失败一律抛**，两个方向都不许吞：
   *  - 底分不在表里 ⇒ `DomainError(BAD_PARAM)`（10001，既有码）；
   *  - **读不到表 ⇒ 翻成 `DomainError(UPSTREAM_UNAVAILABLE)`（10007）**，
   *    与 `RoomsService.create()` 对同一次读的处置**同形**（那里也翻成领域错误）。
   *    写成 `catch { return [] }` 是把「读不到」伪装成「没有档位」—— 与「拿不到就跳过校验」
   *    是同一个后门（规格 §2.4 的红线），那会让**任何**底分（含非法值）畅通无阻。
   *
   * 🔴 **为什么不能原样上抛 `ConfigServiceError`**（Task 3c 修复 1，用户裁决）：
   * 它的消息是 `user-service unavailable: <详情>`，而本方法跑在 `room.match` 的处理链里
   * ⇒ 修前那串**内部详情**会经 WS 边界的通用 catch 一路冒到 ack，**被当 toast 弹给玩家**。
   * 翻成领域错误后：码是 10007（WS 面与 HTTP 面同码），消息只有一句面向玩家的话；
   * **详情只进日志**（下面这行 warn —— 不透传 ≠ 不留痕）。
   */
  private async assertKnownBaseScore(gameType: GameType, baseScore: number): Promise<void> {
    let levels: { name: string; baseScore: number }[];
    try {
      // 片⑦ T7：来源换成配置快照缓存（与 `RoomsService.create()` 是**同一个**单例、
      // 同一张表 —— 两条路的拒绝形状必须一致）。**catch 与 10007 翻译逐字不动**。
      // 多玩法（Task 2.2 / D8）：按玩法取表 —— 斗地主读旧键、跑得快读 `game.levels.paodekuai`。
      levels = await this.configCache.baseScoreLevels(gameType);
    } catch (err) {
      this.logger.warn(
        `Base score levels unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '底分档位表不可用');
    }
    if (!levels.some((l) => l.baseScore === baseScore)) {
      throw new DomainError(ErrCode.BAD_PARAM, '底分不属于档位表');
    }
  }

  /**
   * 取消排队（`room.unmatch` 与「匹配成功后出队」共用）。
   *
   * - meta 在 → 按 meta 里的 `(mode, baseScore, region)` 精确定位并 `ZREM`；
   * - meta 丢失（过期/重启）→ 按 `SCAN match:queue:*` 兜底，保证幂等；
   * - **绝不碰 `match:pending`**：它承载的是匹配结果，与排队状态无关（R42）。
   */
  async cancelQueue(playerId: string): Promise<void> {
    const meta = await this.readMeta(playerId);
    if (meta) {
      // 多玩法（Task 2.1）：按票上冻结的**真实键** ZREM —— 旧票落回旧 3 段键，
      // 新跑得快票落回 5 段键；不得按解析值重建（B4/RB2）。
      await this.redis.zrem(queueKeyOfTicket(meta), playerId);
    } else {
      // ⚠️ **兜底改 SCAN**（片规格 §2.4）：原来遍历 `(mode, region)`，加了底分维度后
      // 需要「知道所有底分」，而 room-service 不查表（那是 RPC —— meta 丢失时正是不该
      // 再依赖别的服务的时候）。`SCAN` 穷举**不依赖任何外部状态**，且这条路径罕见。
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', MATCH_QUEUE_SCAN_PATTERN, 'COUNT', 100);
        cursor = next;
        for (const k of keys) await this.redis.zrem(k, playerId);
      } while (cursor !== '0');
    }
    await this.redis.del(matchMetaKey(playerId));
  }

  /**
   * Start the periodic matching scan. Call once during app bootstrap.
   *
   * 片⑦ T7：`setInterval` → **`setTimeout` 自重排链**（同构模板见 `rooms.reaper.ts`
   * / `rooms.autostart.ts`）。口径（M-6/C9）：**当前一轮按旧值跑完 ⇒ 其后按新值排下一轮**
   * —— 周期在**排下一轮时**从 `configCache.cycleMs()` 现读，因此配置改了**不用重启**、
   * 也不打断在途的一轮。
   *
   * ⚠️ 自重排顺带消除了原来 `setInterval` 的**同进程重叠**（一轮 >5s 时两轮并行）——
   * `failMatch` 的 ZREM-first 幂等（J27）仍原样保留：多实例部署下重叠依旧可能，
   * 那条防线不动。
   */
  startMatchingLoop(): void {
    if (this.scanTimer) return;
    this.scheduleNext();
    this.logger.log(
      `Match scan loop started (interval: ${this.configCache.cycleMs('room.matchScanIntervalMs')}ms)`,
    );
  }

  /** 排下一轮（周期**现读** —— C9 的口径落点）。 */
  private scheduleNext(): void {
    this.scanTimer = setTimeout(() => this.runOnce(), this.configCache.cycleMs('room.matchScanIntervalMs'));
  }

  /**
   * 一轮（既有定时回调体原文：ALS 包裹 + 轮级 catch；末尾接自重排）。
   *
   * **R1107 / 复核⑭**：**轮级 catch**（`Match scan failed`）也必须有来源 —— 它不在
   * `scanAndMatch` 的 ALS 之内 ⇒ 不包就会落在 `bootstrap`（**假话**：这行恰恰说明
   * **一轮定时扫描**失败了）。
   *
   * `traceId: null` 是**接受的取舍**（spec §6 已登记）：这一层看不到内层工作单元
   *（`scanAndMatch` 自建）的 id；替代方案要给它加签名参数，代价大于收益。
   * ⚠️ 一轮只起**一个**工作 id：这层 null 只覆盖 catch 兜底行。
   */
  private runOnce(): void {
    runWithTrace({ traceId: null, source: 'timer' }, () => {
      void this.scanAndMatch()
        .catch((err) => this.logger.error(`Match scan failed: ${String(err)}`))
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（T6 修复轮的同一纪律）。
          if (!this.shuttingDown) this.scheduleNext();
        });
    });
  }

  /** 立刻执行一次扫描（供测试与联调使用，不等待下一个周期）。 */
  async scanOnce(): Promise<void> {
    await this.scanAndMatch();
  }

  /**
   * **R1107 / 判据 11 + 复核⑭**：匹配扫描器是**定时器驱动**的一轮工作（spec §3 载体表
   * 「定时器」行）—— 与 `RoomsReaperTask.reapOnce` / `RoomsAutostartTask.scanOnce` **同形**：
   * 每轮**自建**一个 traceId 并带 `source: 'timer'`。定时器起的一轮**不是**「没有来源」，
   * 而是以「**这一轮**扫描」为来源；ALS 里真没有值时才降级 `null` + `bootstrap`。
   *
   * 包裹点在**方法体外层**（方法体逐字搬进 `scanAndMatchInner`）：`scanOnce`（测试/运维）
   * 与 `startMatchingLoop` 的周期回调都经由它 ⇒ 两条路径共用同一条链。搬家只搬顺序
   * （早返回、单队列 try-catch 一律照旧），**不改任何判定逻辑**。
   *
   * ⚠️ `processQueue` 里也跑**由客户端请求带来的业务**（那个人可能还带着别处的上下文）
   * —— 那些行的上下文会被这一轮的 id **覆盖**。**这是有意的**：它们确实由这一轮扫描产生
   *（spec §3 载体表「定时器」行的同一语义；一轮的行能成组优于保留入队时的旧上下文）。
   */
  private async scanAndMatch(): Promise<void> {
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.scanAndMatchInner());
  }

  /**
   * ALS 包裹外的那一层：扫描**所有存在的队列键**，逐个处理。
   *
   * ⚠️ **为什么是 SCAN 而不是枚举 `MATCH_MODES × MATCH_REGIONS`**（片规格 §2.4）：
   * 加了底分维度后，队列键的第三段**不是 room-service 知道的东西**（档位表在
   * user-service 的库里，经 RPC 读；而且档位表可变、队列键没有 TTL）——
   * 按档位枚举会**永久漏扫**已下架档位的残留队列。扫键**不依赖任何外部状态**，
   * 与 `cancelQueue` 的兜底是同一个理由。
   *
   * 单个队列失败不得拖垮其余队列（旧实现会让第一个异常终止整轮扫描）——
   * 判据同形保留，只是单位从 `(mode, region)` 变成「一条队列键」。
   */
  private async scanAndMatchInner(): Promise<void> {
    /**
     * 片② D5/J20：**轮次持有对象** —— 可用性门禁每轮至多问一次，答案由**这一轮**
     * 的持有对象跨桶复用。
     *
     * 风控 T2：`predicates` 也挂在这里 —— **每轮扫描前读一次**配置（⚙️8），这一轮的
     * 每个桶共用同一份启用谓词表（轮中改配置 ⇒ 下一轮生效；≤60s 安全网是既有机制）。
     *
     * 🔴 `round` 必须建在 for **之上**、且**按引用**传给 `processQueue`
     * （传原始值只改形参、不回写调用方 ⇒ 跨桶 memo 从根上不成立）。为什么是参数透传
     * 而非实例字段：定时器**无防重入**（一轮 >5s 时两轮重叠）—— 字段 + 每轮开头重置
     * 会让第二轮重置后第一轮**再问一次**，退化成 k×超时（设计 §D5 写死的形态）。
     */
    const round: MatchRound = {
      canByGameType: new Map(),
      predicates: this.enabledPredicates(),
    };
    /**
     * 监控片（规格 §2.2 + Task 2.3）：本轮的队列深度读数 ——
     * `mode|gameType|playerCount|baseScore` → 聚合深度（同档位多个 region 键**求和**）。
     * `unresolved` = ZCARD 失败过的聚合键（本轮**不**给它写任何值，见 `publishQueueDepths`）。
     */
    const depths = new Map<string, QueueDepthBucket>();
    const unresolved = new Set<string>();
    for (const key of await this.listQueueKeys()) {
      const queue = parseMatchQueueKey(key);
      if (!queue) continue; // 坏键（形状不认识）跳过，不得把整轮扫描带崩
      await this.readQueueDepth(key, queue, depths, unresolved);
      try {
        await this.processQueue(queue, round);
      } catch (err) {
        this.logger.error(`Match scan for ${key} failed: ${String(err)}`);
      }
    }
    this.publishQueueDepths(depths, unresolved);
  }

  /**
   * 监控片（规格 §2.2 · C11）：对扫到的每个队列键 `ZCARD` 读深（本片**新增**的读命令），
   * 按 `(mode, baseScore)` 聚合 —— **region 维求和**（同档位在多个 region 上的队列长度
   * 相加；现部署只有 `global` 一个 region，求和是给地理扩展留的口径）。
   *
   * 失败姿态：读深失败**不得**影响匹配本身（本方法自吞、只记日志，与 `processQueue`
   * 的失败处置分开）—— 该聚合键进 `unresolved`，本轮既不 set 也不归零（宁留旧值，
   * 不把「读不到」写成假 0）。
   */
  private async readQueueDepth(
    key: string,
    queue: ParsedQueueKey,
    depths: Map<string, QueueDepthBucket>,
    unresolved: Set<string>,
  ): Promise<void> {
    const { mode, gameType, playerCount, baseScore } = queue;
    const aggKey = `${mode}|${gameType}|${playerCount}|${baseScore}`;
    try {
      const depth = await this.redis.zcard(key);
      const current = depths.get(aggKey);
      if (current) current.depth += depth;
      else depths.set(aggKey, { mode, gameType, playerCount, baseScore, depth });
    } catch (err) {
      unresolved.add(aggKey);
      this.logger.error(`Match queue depth for ${key} failed: ${String(err)}`);
    }
  }

  /**
   * 监控片（规格 §2.2）：把本轮聚合出的深度 set 进 `match_queue_length`，并把
   * **上一轮出现过、本轮确认消失**的档位归零（键被删 ⇒ 扫不到；不归零 = 陈旧读数）。
   * `unresolved`（ZCARD 失败）的档位既不 set 也不归零、且**继续跟踪**到下一轮 ——
   * 避免把「读不到」写成「队列为空」。
   */
  private publishQueueDepths(
    depths: Map<string, QueueDepthBucket>,
    unresolved: ReadonlySet<string>,
  ): void {
    const labelsOf = (bucket: QueueDepthLabels): Record<string, string> => ({
      mode: bucket.mode,
      game_type: bucket.gameType,
      player_count: String(bucket.playerCount),
      base_score: String(bucket.baseScore),
    });
    for (const [aggKey, bucket] of this.publishedQueueDepths) {
      const stillTracked = depths.has(aggKey) || unresolved.has(aggKey);
      if (!stillTracked) matchQueueLength.set(labelsOf(bucket), 0);
    }
    const next = new Map<string, QueueDepthLabels>();
    for (const [aggKey, bucket] of depths) {
      matchQueueLength.set(labelsOf(bucket), bucket.depth);
      next.set(aggKey, {
        mode: bucket.mode,
        gameType: bucket.gameType,
        playerCount: bucket.playerCount,
        baseScore: bucket.baseScore,
      });
    }
    for (const [aggKey, labels] of this.publishedQueueDepths) {
      if (!next.has(aggKey) && unresolved.has(aggKey)) next.set(aggKey, labels);
    }
    this.publishedQueueDepths = next;
  }

  /**
   * `SCAN` 穷举现存队列键（游标式，`MATCH_QUEUE_SCAN_PATTERN` 与 `cancelQueue` 共用）。
   *
   * ⚠️ **必须去重**（Task 3c 修复 3）：Redis 的游标式 `SCAN` **不保证不重复** ——
   * 文档明写「同一个元素可能在多次迭代里被返回多次」。而本方法的消费点是
   * `scanAndMatchInner` 的「一个键 = 一轮 `processQueue`」⇒ 重复那一轮会把
   * `incrementAttempts()` 多跑一次，玩家在什么都没变的情况下**提前耗掉**
   * `MATCH_MAX_ATTEMPTS` 的重试预算（拿不到完整的 60 秒等待窗口）。
   * 去重放在**唯一**的消费点（这里），`cancelQueue` 那条兜底路径对重复 `ZREM` 天然幂等。
   */
  private async listQueueKeys(): Promise<string[]> {
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', MATCH_QUEUE_SCAN_PATTERN, 'COUNT', 100);
      cursor = next;
      for (const key of batch) keys.add(key);
    } while (cursor !== '0');
    return [...keys];
  }

  /**
   * 单个 `(mode, gameType, playerCount, baseScore, region)` 队列的匹配
   *（§8.2/§8.4 + 片规格 §2.4 + 风控 §2.4-3/4/7 + 多玩法 Task 2.3）。
   *
   * 组大小 = 队列的 `playerCount`（2/3/4），不再写死 3。
   *
   * 顺序是契约的一部分（风控 T2 起重写；波 1 F1 补孤儿前置清出）：
   *  ⓪ **前置筛选**（每票一读 meta）：**孤儿票**（meta 读不到）静默清出（`cancelQueue`，
   *     无 12007）；其余进候选 —— **到点者**（`waited ≥ 60s` 或 `≥30s 且 attempts ≥ 10`）
   *     **不再直接淘汰**：先并入正常抽取（§2.4-4），本轮未成组者走兜底集合（⚙️14）；
   *  ② **≥ playerCount 人**：洗牌**副本** → 随机贪心取 playerCount（逐对过「记忆 ∩ 谓词」，
   *     失败记账）；凑满 ⇒ 成组；凑不满 ⇒ **最大合法子集 S**（最长等待者起算，
   *     ⚙️14/⚙️22-②）：`|S|=playerCount` ⇒ 直接成组；`|S|<playerCount` ⇒ S + 机器人补满
   *    （30s 窗口；机器人数量由房间空位自动决定）；窗口未到 ⇒ 本轮不动；
   *  ③ **< playerCount 人且未越 30 秒窗口** → 本周期什么都不做（**绝不丢人**，R44），也绝不提前问门禁；
   *  ④ **< playerCount 人且已越窗口** → 先问一次**可用性门禁**（片② D5，`round` 跨桶 memo）：
   *     `canProvide === false` ⇒ **只判**「窗口已到点」的人（12007 + 中文文案）、
   *     **本轮不建房**、其余留队；问不到 ⇒ fail-open；
   *  ⑤ 补机器**前**先对真人子集做两两谓词判定（`canFormTable`）：不通过 ⇒ **拆组** ——
   *     S（最长等待者的合法子集）先开，拆出者按「子集 = 1」同规（§2.4-7）；
   *  ⑥ 到点兜底：本轮未被任何组选走的到点者按谓词贪心成组（≤ playerCount）⇒ 各房补机器人；
   *     门禁不能给 ⇒ 该组 12007（⚙️14）。
   *
   * 🔴 **底分/玩法/人数随队列走**（片规格 §2.4 + D5）：建出的房间 = 这三/五维 ——
   * 「不同底分/玩法/人数不会同房」因此不是靠谓词，而是靠**他们压根不在同一条队列上**。
   *
   * **出队只在成功或最终失败时发生**：候选留在 ZSet 里 `score` 不变 ⇒
   * `enteredAt` 天然被保留（§8.4「回队时间戳必须保留」），不需要任何重新入队。
   */
  private async processQueue(
    /** 扫出来的**实际**队列（`key` 是唯一操作目标；`legacy`/维度只供语义判断与日志）。 */
    queue: ParsedQueueKey,
    /** 片② D5/J20 + 风控 ⚙️8：**这一轮**的持有对象（`scanAndMatchInner` 建在 for 之上、按引用透传）。 */
    round: MatchRound,
  ): Promise<void> {
    // 关闭的玩法：暂停匹配（票保留、不建组、不逐 tick 抛 12012）——重新开放后按原逻辑继续。
    if (!this.configCache.gameEnabled(queue.gameType)) return;
    const { mode, playerCount, baseScore, region } = queue;
    const raw = await this.redis.zrange(queue.key, 0, -1, 'WITHSCORES');
    if (raw.length === 0) return;

    const queued: QueueEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      queued.push({ playerId: raw[i]!, enteredAt: Number(raw[i + 1] ?? 0) });
    }

    const now = this.clock();

    /**
     * ① **前置筛选**（风控 §2.4-4 明改点 + 波 1 F1 修复 + 波 2 F4）——对**每张票读一次** `readMeta`：
     *
     *  - **孤儿票**（meta 读不到 —— 崩溃/断线的无 TTL 残留，R63 形态）：记入 `orphans`，
     *    循环后经 `cancelQueue` **静默清出**（**无 12007** —— 所有者已不存在）+ debug 一行。
     *    ⚠️ 这道筛选是**必需**的（波 1 F1）：撤掉「到点直走 failMatch」之后，孤儿不再有任何
     *    出口，会被随机抽取/兜底拉进一座**永不有人加入的座位**（房间永远开不完）；
     *  - **有 meta 的到点者**（`waited ≥ 60s` 或 `≥30s 且 attempts ≥ 10`）**不再在此直走
     *    `failMatch`**：先并入正常抽取（仍可被选入合法组 = 更优结局），本轮未成组者才走
     *    兜底集合（`timedOutFallback`）——断线者留有 meta ⇒ 可兜底成局、重连后经
     *    `match:pending` 补回（有意行为）；
     *  - **封禁旗在的存量票**（波 2 F4，见下方批读撤出）：同样**永不进入选择/兜底**。
     *
     * ⚠️ 判据必须**按票**（R57）：写成「队首超时 → failMatch(整队)」会把**刚刚入队**的人
     * 一起判失败。波 1 F1 起票在手上（每票一读）⇒ 原「≥30s 才读 meta」的省读优化**收编**
     * （`ticket.attempts` 直接判定）；快路径的省读只剩「谓词关闭 ⇒ 不查记忆键」那一层。
     */
    const tickets = new Map<string, MatchTicket>();
    const orphans: QueueEntry[] = [];
    let alive: QueueEntry[] = [];
    const timedOut = new Set<string>();
    for (const q of queued) {
      const ticket = await this.readMeta(q.playerId);
      if (!ticket) {
        orphans.push(q);
        continue;
      }
      tickets.set(q.playerId, ticket);
      const waitedMs = now - q.enteredAt;
      if (waitedMs >= MATCH_MAX_WAIT_MS) {
        timedOut.add(q.playerId);
      } else if (waitedMs >= BOT_FILL_WAIT_MS && ticket.attempts >= MATCH_MAX_ATTEMPTS) {
        timedOut.add(q.playerId);
      }
      alive.push(q);
    }
    if (orphans.length > 0) {
      // 静默清出（无 12007：所有者已不存在 —— 发的通告没有接收方，只会是噪音）
      this.logger.debug(
        `Clearing ${orphans.length} orphan ticket(s) in ${mode}/${baseScore}/${region}: ${orphans
          .map((o) => o.playerId)
          .join(', ')}`,
      );
      try {
        for (const o of orphans) await this.cancelQueue(o.playerId);
      } catch (err) {
        // 清不完不致命（下轮重试 —— 还在 zset 里就会被再次前置筛选抓到）
        this.logger.warn(`Orphan cleanup failed in ${mode}/${baseScore}/${region}: ${String(err)}`);
      }
    }

    /**
     * ② **封禁存量票前置撤出**（波 2 F4）：已被 ban 的排队者，其票在 meta TTL 内仍可被撮合
     * ⇒ 房按权威座位表 3/3 开局、而该位 `room.join` 被 ④ 拦 ⇒ **幽灵位**（余两家每回合空等
     * 超时；金币场含结算）。⇒ 封禁者**永不进入选择/兜底**；`room.join` 拦点仍是第二道防线
     * （不动）。旗读纪律（R11/F8）：**批读一次**（pipeline，避免 N 次往返）+ 单独 try/catch
     * ⇒ **按无旗**（读失败绝不影响匹配，只上 error 日志）。
     */
    const banned = await this.readBannedFlags(alive.map((q) => q.playerId));
    if (banned.size > 0) {
      const evicted = alive.filter((q) => banned.has(q.playerId));
      alive = alive.filter((q) => !banned.has(q.playerId));
      // 静默清出（无 12007：已封禁者收到的任何通告都没有意义）
      this.logger.debug(
        `banned evicted ${evicted.length} ticket(s) in ${mode}/${baseScore}/${region}: ${evicted
          .map((e) => e.playerId)
          .join(', ')}`,
      );
      try {
        for (const e of evicted) await this.cancelQueue(e.playerId);
      } catch (err) {
        this.logger.warn(`Banned ticket eviction failed in ${mode}/${baseScore}/${region}: ${String(err)}`);
      }
    }

    // 多玩法 Task 2.1/2.4 / spec RH3-a：in-flight 声明筛选 —— **全模式**（不只是金币场）。
    // 持有 `match:claim:` 的玩家（已被某组带走、开局链在途）本轮**跳过、不 cancelQueue**。
    // Task 2.4：claim 的值 = **roomCode** —— 若该房已不在 `waiting`（开局成功但 onSeats
    // 延迟/失败），这张票就是陈旧的 ⇒ 按 `queueKeyOfTicket` 幂等 `cancelQueue` 清理，
    // 保证下一轮不会把同一批人再选进第二间房（人票两空的前置条件）。
    const claims = await this.readClaimRooms(alive.map((q) => q.playerId));
    if (claims.size > 0) {
      alive = alive.filter((q) => !claims.has(q.playerId));
      const stale: string[] = [];
      for (const [playerId, roomCode] of claims) {
        const claimedRoom = await this.roomsService.findOne(roomCode);
        // 只清「房**存在**且已不在 waiting」的票（= 已开局但 onSeats 未删）。
        // 房读不到 ⇒ 按在途处理（不误清；claim TTL 到期后自然放行）。
        if (claimedRoom && claimedRoom.status !== 'waiting') stale.push(playerId);
      }
      for (const playerId of stale) {
        try {
          await this.cancelQueue(playerId);
        } catch (err) {
          this.logger.warn(`stale claim ticket cleanup failed for ${playerId}: ${String(err)}`);
        }
      }
      this.logger.debug(
        `claimed skipped ${claims.size} ticket(s) in ${mode}/${baseScore}/${region}` +
          `${stale.length > 0 ? ` (cleaned ${stale.length} stale ticket(s))` : ''}: ${[...claims.keys()].join(', ')}`,
      );
    }

    if (alive.length === 0) return;

    // ZRANGE 升序 + 逐个过滤 ⇒ `alive[0]` 是「仍在队列里」最久的那个（§8.1 先到先服务）。
    // ⚙️23：它取**原序数组** —— 洗牌只发生在其副本上（子集路径依赖这一点）。
    const oldest = alive[0]!;
    const waited = now - oldest.enteredAt;

    const predicates = round.predicates;
    // ⚙️2：attempts 的第二增点（成组失败）与第一增点（既有补位失败）共用这张去重表 ——
    // 每人每轮至多 +1（同一轮多对拒绝只记第一对的两端）。
    const bumped = new Set<string>();

    /**
     * 机器人补位开关片：本队列是否允许缺人补机器人。
     *  - `practice`（好友房自动开局扫描器路径）**不受控** —— 保持现状恒补；
     *  - `random` / `gold` 各读各的运营开关（缺省 true = 暗上线，行为与今天逐字节一致）。
     * 关闭 ⇒ 走独立的 `processQueueNoBots`：只接受 **playerCount 名真人**满座、缺人发等待提示、
     * 总等待上限到点发 12007 —— **绝不**问门禁、**绝不**用机器人给缺人子集开局。
     */
    if (!this.botFillEnabled(mode, queue.gameType)) {
      await this.processQueueNoBots(alive, tickets, queue, predicates, now, bumped);
      return;
    }

    // ② ≥ playerCount 人：洗牌副本 → 随机贪心取 playerCount（逐对过「记忆 ∩ 谓词」；失败即记账）
    if (alive.length >= playerCount) {
      matchSelectionRoundsTotal.inc(); // §2.4-5：每轮桶内 alive ≥ playerCount
      const selected = await this.randomGreedyPick(
        alive,
        tickets,
        predicates,
        now,
        bumped,
        playerCount,
      );
      if (selected.length === playerCount) {
        const started = await this.startGroup(selected, queue, bumped);
        if (started) {
          await this.timedOutFallback(alive, timedOut, new Set(selected), queue, round, tickets, now, bumped);
        }
        return;
      }
      matchNoLegalGroupTotal.inc(); // §2.4-5：≥ playerCount 且本轮贪心未成组（可观测定义）

      // 凑不满 ⇒ 子集/兜底路径（⚙️14）：对**最长等待者**取贪心最大合法子集 S
      const subset = await this.maxLegalSubset(alive, tickets, predicates, now, playerCount);
      if (subset.length === playerCount) {
        // ⚙️22-②：|S| = playerCount ⇒ **直接成组**（无需机器人 / 无需窗口）
        const started = await this.startGroup(subset, queue, bumped);
        if (started) {
          await this.timedOutFallback(alive, timedOut, new Set(subset), queue, round, tickets, now, bumped);
        }
        return;
      }
      if (waited < BOT_FILL_WAIT_MS) return; // 窗口未到 ⇒ 本轮不动（到点者必 ≥30s ⇒ 此刻不存在）
      if (!(await this.gateAllows(round, queue.gameType))) {
        // 门禁不能给：只判「窗口已到点」的人（12007）、其余留队（J6 语义不动）
        await this.failExpired(alive, now, queue);
        return;
      }
      // |S| < playerCount ⇒ S + 机器人补满（数量由房间空位自动决定）
      const started = await this.startGroup(subset, queue, bumped);
      if (started) {
        await this.timedOutFallback(alive, timedOut, new Set(subset), queue, round, tickets, now, bumped);
      }
      return;
    }

    // ── < playerCount 人越窗主路径（§2.4-7：既有 :591-600 流程 + 谓词拆分）────────
    if (waited < BOT_FILL_WAIT_MS) return; // ④ 还在窗口内（也**绝不提前问门禁**）

    if (!(await this.gateAllows(round, queue.gameType))) {
      // ⑤ 门禁不能给：只判「窗口已到点」的人（12007 + 中文文案）、本轮不建房、其余留队（J6 原文）
      await this.failExpired(alive, now, queue);
      return;
    }

    // ⑥ 补机器**前**先对真人子集做两两判定（`canFormTable`：**纯谓词** —— 「记忆消费」
    // 是随机抽取的职责，§2.4-3）；不通过 ⇒ **拆组**（§2.4-7）
    const humanTickets = alive.map((q) => tickets.get(q.playerId)!);
    if (canFormTable(humanTickets, predicates)) {
      await this.startGroup(alive.map((q) => q.playerId), queue, bumped);
      return;
    }

    // 拆组：S（最长等待者的合法子集）先开；**拆出者**按「子集 = 1」同规 ——
    // 窗口**自各人 enteredAt 起算**（不被先到者连坐），≥30s 才「本人 + 机器人」
    const subset = await this.maxLegalSubset(alive, tickets, predicates, now, playerCount);
    if (!(await this.startGroup(subset, queue, bumped))) return;
    const inSubset = new Set(subset);
    for (const q of alive) {
      if (inSubset.has(q.playerId)) continue;
      if (now - q.enteredAt < BOT_FILL_WAIT_MS) continue; // 自家窗口未到 ⇒ 留队
      if (!(await this.startGroup([q.playerId], queue, bumped))) return;
    }
  }

  /**
   * 机器人补位开关片 + 平行化：该模式的匹配队列缺人时**是否允许补机器人**。
   * `practice` 不受开关管控（好友房路径保持现状）；`random`/`gold` 按**玩法**读开关。
   */
  private botFillEnabled(mode: MatchMode, gameType: GameType = DEFAULT_GAME_TYPE): boolean {
    if (mode === 'random') return this.configCache.freeBotFillEnabled(gameType);
    if (mode === 'gold') return this.configCache.goldBotFillEnabled(gameType);
    return true;
  }

  /**
   * 机器人补位开关**关闭**时的队列处理（与补机器人路径并列的另一条主路径）。
   *
   * 与 `processQueue` 的关键差异（用户裁决）：
   *  ① **绝不问机器人门禁、绝不补机器人**：不足 **playerCount** 的合法子集**不开局**（哪怕已越过
   *     30s 窗口）；只有凑齐 **playerCount 名真人**才走既有 `startGroup`（满座 ⇒ `fillBots`
   *     早返，行为天然安全）。
   *  ② **总等待上限**（`room.matchNoBotMaxWaitMs`，缺省 300s）：自票的**原始
   *      `enteredAt`** 起算（延长/重新入队都不重置它）⇒ 到点的票**逐票** 12007 终局
   *      （复用 `failMatch` 的 ZREM-first 幂等纪律，多实例重叠轮不发第二条）。
   *  ③ 未满上限且越过 30s 提示窗口 ⇒ 发**友好等待提示** `match.wait_prompt`（票留队、
   *     匹配不终止）；玩家可 `room.match.extend` 再等一个窗口，或取消后重新匹配。
   *
   * 既有 `timedOut`（60s/attempts≥10 的机器人兜底集合）在本路径**不生效**：它存在的
   * 唯一出口是「补机器人成局」，与开关关闭的语义冲突 —— 到点出口统一为 ② 的可配置上限。
   */
  private async processQueueNoBots(
    aliveIn: readonly QueueEntry[],
    tickets: ReadonlyMap<string, MatchTicket>,
    queue: ParsedQueueKey,
    predicates: readonly MatchPredicate[],
    now: number,
    bumped: Set<string>,
  ): Promise<void> {
    let alive = [...aliveIn];

    // ① 总等待上限到点 ⇒ 逐票 12007（failMatch 内部 ZREM-first + meta 清理 + 幂等发布）。
    const maxWaitMs = this.configCache.matchNoBotMaxWaitMs();
    const reachedCap = alive.filter((q) => now - q.enteredAt >= maxWaitMs);
    if (reachedCap.length > 0) {
      const cappedIds = new Set(reachedCap.map((q) => q.playerId));
      alive = alive.filter((q) => !cappedIds.has(q.playerId));
      await this.failMatch(
        reachedCap.map((q) => q.playerId),
        queue.key,
        '匹配超时：当前在线玩家不足，请稍后再试',
      );
    }
    if (alive.length === 0) return;

    // ② 只接受 **playerCount 名真人**满座：先随机贪心、失败再取最长等待者的最大合法子集；
    //    子集 < playerCount ⇒ 绝不开局，直接落到 ③ 的等待提示。
    const playerCount = queue.playerCount;
    if (alive.length >= playerCount) {
      matchSelectionRoundsTotal.inc();
      const selected = await this.randomGreedyPick(
        alive,
        tickets,
        predicates,
        now,
        bumped,
        playerCount,
      );
      if (selected.length === playerCount) {
        await this.startGroup(selected, queue, bumped);
        return;
      }
      matchNoLegalGroupTotal.inc();
      const subset = await this.maxLegalSubset(alive, tickets, predicates, now, playerCount);
      if (subset.length === playerCount) {
        await this.startGroup(subset, queue, bumped);
        return;
      }
    }

    // ③ 缺人未到上限：越过 30s 窗口者按人发等待提示（每窗口至多一条；票原样留队）。
    await this.promptWaitingPlayers(alive, tickets, now);
  }

  /**
   * 机器人补位开关片：对仍在队列、已越过提示窗口的玩家发 `match.wait_prompt`。
   *
   * **幂等（与 failMatch 同族纪律）**：提示窗口在 `match:meta` 里以
   * `promptWin:<anchor>:<idx>` 字段占位，`HSETNX` 原子领取 —— 同一窗口重叠轮/多实例只有
   * 一个领取成功（返回 1）⇒ 每人每窗口**至多一条**；窗口索引由「锚点」（缺省 =
   * `enteredAt`，玩家点延长后平移到确认时刻）除以 `BOT_FILL_WAIT_MS` 决定。
   *
   * **字段名必须带锚点**：延长后锚点平移，旧锚点名下的窗口占位若复用同名键，会把新锚点
   * 下序号相同的窗口误判成「已提示」（玩家明明还没在新一轮里被提示过）。
   *
   * 领取成功同时**续期 meta**（EX 300s）：上限可配到 30min，不能让 meta 的 300s TTL
   * 先把等待中的票变成被静默清出的孤儿。
   */
  private async promptWaitingPlayers(
    entries: readonly QueueEntry[],
    tickets: ReadonlyMap<string, MatchTicket>,
    now: number,
  ): Promise<void> {
    const prompted: string[] = [];
    for (const q of entries) {
      if (now - q.enteredAt < BOT_FILL_WAIT_MS) continue; // 首个窗口未到 ⇒ 不提示
      const ticket = tickets.get(q.playerId);
      if (!ticket) continue;
      const anchor = ticket.promptAnchorAt ?? q.enteredAt;
      const windowIndex = Math.floor((now - anchor) / BOT_FILL_WAIT_MS);
      if (!Number.isFinite(windowIndex) || windowIndex < 0) continue;
      const claimed = await this.redis.hsetnx(
        matchMetaKey(q.playerId),
        `promptWin:${anchor}:${windowIndex}`,
        String(now),
      );
      if (claimed !== 1) continue; // 本窗口已被（本轮或它实例）提示过
      await this.redis.expire(matchMetaKey(q.playerId), MATCH_META_TTL_SECONDS);
      prompted.push(q.playerId);
    }
    if (prompted.length === 0) return;
    try {
      await this.redis.publish(
        MATCH_EVENTS_CHANNEL,
        JSON.stringify({
          event: 'match.wait_prompt',
          playerIds: prompted,
          message: MATCH_WAIT_PROMPT_MESSAGE,
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to publish match.wait_prompt: ${String(err)}`);
    }
  }

  /**
   * 机器人补位开关片：`room.match.extend` 的服务端动作 —— 玩家在等待提示悬浮卡片点
   * 「继续等待」。票**留在原队列**（排队位置/`enteredAt` 不变），只把提示窗口
   * 锚点平移到当前时刻，并**预置领取新锚点的窗口 0** ⇒ 接下来一个 30s 窗口内不再弹
   * 提示（玩家刚确认过，语义上该窗口已「应答」）。
   * 票已不在（已开局/已超时/已取消 ⇒ meta 读不到）⇒ **幂等 no-op**。
   */
  async extendWait(playerId: string): Promise<void> {
    const ticket = await this.readMeta(playerId);
    if (!ticket) return;
    const now = String(this.clock());
    // 预置 `promptWin:<新锚点>:0`：否则下一轮扫描在新锚点的窗口 0 会立即补弹一次。
    await this.redis.hset(matchMetaKey(playerId), {
      promptAnchorAt: now,
      [`promptWin:${now}:0`]: now,
    });
    await this.redis.expire(matchMetaKey(playerId), MATCH_META_TTL_SECONDS);
  }

  /**
   * ⚙️8：本轮启用的谓词表 —— **每轮扫描前读一次**配置（缺省 false ⇒ 空表 = 零新增读快路径）。
   * 顺序固定（sameDevice → sameIp），与 `PREDICATE_REGISTRY` 同源。
   */
  private enabledPredicates(): readonly MatchPredicate[] {
    const enabled: MatchPredicate[] = [];
    if (this.configCache.riskPredicateSameDevice()) enabled.push(PREDICATE_REGISTRY.sameDevice);
    if (this.configCache.riskPredicateSameIp()) enabled.push(PREDICATE_REGISTRY.sameIp);
    return enabled;
  }

  /**
   * 波 2 F4：批量读**封禁旗**（`EXISTS risk:banned:{userId}`；§2.3 的旗键，写点 = 管理动作
   * / 扫描自愈，不在本服务）—— 用 `pipeline` **一次往返**（避免 N 次 EXISTS）。
   *
   * 旗读纪律（R11/F8，Global Constraints）：**单独 try/catch ⇒ 按无旗** + **error 日志**
   * —— 读失败绝不影响匹配（fail-open）；逐条错误同样按无旗（不因单条异常连坐全批）。
   */
  private async readBannedFlags(playerIds: readonly string[]): Promise<Set<string>> {
    const banned = new Set<string>();
    if (playerIds.length === 0) return banned;
    try {
      const pipeline = this.redis.pipeline();
      for (const id of playerIds) pipeline.exists(`risk:banned:${id}`);
      const results = await pipeline.exec();
      (results ?? []).forEach(([err, res], index) => {
        if (!err && res === 1) banned.add(playerIds[index]!);
      });
      return banned;
    } catch (err) {
      this.logger.error(`risk:banned flag read failed (treating nobody as banned): ${String(err)}`);
      return new Set();
    }
  }

  /**
   * 多玩法（Task 2.4）：批量读 **in-flight 声明**（`GET match:claim:{playerId}`；pipeline 一次往返）。
   * 值 = **roomCode**（Task 2.4 起；调用方据此判断房是否已开局 ⇒ 清陈旧票）。
   *
   * 旗读纪律照 `readBannedFlags`（R11/F8）：单独 try/catch ⇒ **按无 claim** + error 日志
   * ——读失败绝不影响匹配（fail-open）；逐条错误同样按无 claim。
   */
  private async readClaimRooms(playerIds: readonly string[]): Promise<Map<string, string>> {
    const claimed = new Map<string, string>();
    if (playerIds.length === 0) return claimed;
    try {
      const pipeline = this.redis.pipeline();
      for (const id of playerIds) pipeline.get(matchClaimKey(id));
      const results = await pipeline.exec();
      (results ?? []).forEach(([err, res], index) => {
        if (!err && typeof res === 'string' && res.length > 0) claimed.set(playerIds[index]!, res);
      });
      return claimed;
    } catch (err) {
      this.logger.error(`match:claim flag read failed (treating nobody as claimed): ${String(err)}`);
      return new Map();
    }
  }

  /** Fisher–Yates，洗 **`entries` 的副本**（⚙️23：原序数组保留给 oldest / 最长等待者判定）。 */
  private shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.min(i, Math.floor(this.rng() * (i + 1)));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  /**
   * 一对候选的「允许」判定（D1：**不在 5s `match:rejected` 记忆内 ∩ 全部启用谓词通过**）。
   * **纯读**（不写记忆、不计数、不加 attempts —— 记账是随机抽取的职责，见 `randomGreedyPick`）。
   *
   *  - 谓词未启用 ⇒ 直接放行（快路径：谓词默认关 ⇒ 连记忆 GET 都不发生）；
   *  - 票缺（防御分支：前置筛选后 `alive` 全员有票 —— 保留以防调用面变化）⇒ fail-open；
   *  - 记忆：值 = 失败时刻 ms；`now − 值 < 5s` 才算命中（键的 TTL 是兜底，这层是显式判据
   *    —— 也正因如此，测试替身不需要模拟 TTL 到期；**过期 ⇒ 不命中 + 重判 + 重写**）。
   */
  private async judgePair(
    a: MatchTicket | undefined,
    b: MatchTicket | undefined,
    predicates: readonly MatchPredicate[],
    now: number,
  ): Promise<PairVerdict> {
    if (predicates.length === 0) return { ok: true };
    if (!a || !b) return { ok: true };
    const marked = await this.redis.get(matchRejectedKey(a.playerId, b.playerId));
    if (marked !== null && now - Number(marked) < PICK_FAILURE_MARK_TTL_MS) {
      return { ok: false, memory: true, rejected: [] };
    }
    const rejected = predicates.filter((predicate) => !predicate.allows(a, b));
    if (rejected.length > 0) return { ok: false, memory: false, rejected };
    return { ok: true };
  }

  /**
   * 随机贪心抽取（§2.4-3）：洗牌**副本**后依序取候选 —— 与已选全员「两两允许」才入选；
   * 凑满 **playerCount** ⇒ 返回该组；凑不满 ⇒ 返回已选（调用方转最大合法子集路径）。
   *
   * **失败记账只在抽取（这里）发生**（F5 定案；子集/兜底路径纯读不记账）：
   *  - **谓词拒绝** ⇒ 写记忆 + 每拒绝谓词两端 `risk:hit` INCR + 指标 +1；
   *  - **记忆拒绝** ⇒ 不重写记忆、不 INCR、不计数；
   *  - 两端 attempts+1（经 `bumpAttempts` 按人每轮去重 —— ⚙️2）；
   *  - **「洗牌未轮到」不计**（凑满 playerCount 即收手 —— 后面的候选连判定都不发生）。
   *
   * 多玩法（Task 2.3）：组大小读队列的 `playerCount`（2/3/4），不再写死 3。
   */
  private async randomGreedyPick(
    entries: readonly QueueEntry[],
    tickets: ReadonlyMap<string, MatchTicket>,
    predicates: readonly MatchPredicate[],
    now: number,
    bumped: Set<string>,
    playerCount: number,
  ): Promise<string[]> {
    const shuffled = this.shuffle(entries);
    const selected: string[] = [];
    for (const candidate of shuffled) {
      if (selected.length >= playerCount) break;
      if (predicates.length === 0) {
        selected.push(candidate.playerId); // 谓词关 ⇒ 全允许（快路径：无判定、无记账）
        continue;
      }
      let rejection: Extract<PairVerdict, { ok: false }> | null = null;
      let conflict: string | null = null;
      for (const member of selected) {
        const verdict = await this.judgePair(
          tickets.get(candidate.playerId),
          tickets.get(member),
          predicates,
          now,
        );
        if (!verdict.ok) {
          rejection = verdict;
          conflict = member;
          break; // 与任一已选相斥 ⇒ 本候选出局（不再对后续已选逐对判定）
        }
      }
      if (!rejection) {
        selected.push(candidate.playerId);
        continue;
      }
      await this.accountRejection(candidate.playerId, conflict!, rejection, now, bumped);
    }
    return selected;
  }

  /**
   * 成组失败记账（§2.4-3 / F5）：谓词拒绝 ⇒ 记忆（字典序键/TTL 5s/值=now）+ 指标 + 命中 INCR；
   * 记忆拒绝 ⇒ 仅 attempts。attempts 经 `bumpAttempts` 按人去重（⚙️2）。
   */
  private async accountRejection(
    aId: string,
    bId: string,
    verdict: Extract<PairVerdict, { ok: false }>,
    now: number,
    bumped: Set<string>,
  ): Promise<void> {
    if (!verdict.memory) {
      await this.redis.set(matchRejectedKey(aId, bId), String(now), 'PX', PICK_FAILURE_MARK_TTL_MS);
      for (const predicate of verdict.rejected) {
        matchPredicateRejectionsTotal.inc({ predicate: predicate.name });
        await this.incrRiskHit(aId, predicate.name);
        await this.incrRiskHit(bId, predicate.name);
      }
    }
    await this.bumpAttempts([aId, bId], bumped);
  }

  /** §2.3：`risk:hit:{userId}:{predicate}` INCR + EXPIRE 7d（每次 INCR 后重新计量）。 */
  private async incrRiskHit(userId: string, predicate: string): Promise<void> {
    const key = `risk:hit:${userId}:${predicate}`;
    await this.redis.incr(key);
    await this.redis.expire(key, RISK_HIT_TTL_SECONDS);
  }

  /**
   * `attempts` 的增点封装（⚙️2：成组失败 = 第二增点；既有补位失败 = 第一增点，同走这里）：
   * 按人**每轮去重** —— 同一轮里多对拒绝、或成组失败与补位失败叠加时，每人至多 +1。
   */
  private async bumpAttempts(playerIds: readonly string[], bumped: Set<string>): Promise<void> {
    const fresh = playerIds.filter((id) => !bumped.has(id));
    for (const id of fresh) bumped.add(id);
    await this.incrementAttempts(fresh);
  }

  /**
   * ⚙️14 / ⚙️22-②：对**最长等待者**（原序最久者 = `entries[0]`）取贪心**最大合法子集** S
   * （组 ≤ `playerCount` 人、组内两两允许 —— 含记忆判定）。**纯读**：不做失败记账
   *（记账只在随机抽取）。⚠️ `entries` 必须是**原序**数组（洗牌只发生在副本上 —— ⚙️23）。
   */
  private async maxLegalSubset(
    entries: readonly QueueEntry[],
    tickets: ReadonlyMap<string, MatchTicket>,
    predicates: readonly MatchPredicate[],
    now: number,
    playerCount: number,
  ): Promise<string[]> {
    const subset: string[] = [];
    for (const candidate of entries) {
      if (subset.length >= playerCount) break;
      if (subset.length === 0 || predicates.length === 0) {
        subset.push(candidate.playerId); // S 从最长等待者起算；谓词关 ⇒ 全允许
        continue;
      }
      let allowed = true;
      for (const member of subset) {
        const verdict = await this.judgePair(
          tickets.get(candidate.playerId),
          tickets.get(member),
          predicates,
          now,
        );
        if (!verdict.ok) {
          allowed = false;
          break;
        }
      }
      if (allowed) subset.push(candidate.playerId);
    }
    return subset;
  }

  /**
   * §2.4-4 / ⚙️14：**到点者兜底** —— 本轮未被任何组选走的到点者按谓词**贪心成组**
   * （组 ≤ playerCount 人、组内两两允许）⇒ 各房补机器人；门禁（`round.can` 复用）不能给 ⇒
   * **该组 12007**（既有 `failMatch` 原文：语义/幂等面不动）。组恰满 playerCount 人时不问门禁
   *（真人够 —— J9 同规）。
   */
  private async timedOutFallback(
    entries: readonly QueueEntry[],
    timedOut: ReadonlySet<string>,
    matched: ReadonlySet<string>,
    queue: ParsedQueueKey,
    round: MatchRound,
    tickets: ReadonlyMap<string, MatchTicket>,
    now: number,
    bumped: Set<string>,
  ): Promise<void> {
    if (timedOut.size === 0) return;
    const residual = entries.filter((q) => timedOut.has(q.playerId) && !matched.has(q.playerId));
    if (residual.length === 0) return;
    for (const group of await this.greedyHumanGroups(
      residual,
      tickets,
      round.predicates,
      now,
      queue.playerCount,
    )) {
      if (group.length < queue.playerCount && !(await this.gateAllows(round, queue.gameType))) {
        await this.failMatch(group, queue.key, '当前无匹配的玩家');
        continue;
      }
      if (!(await this.startGroup(group, queue, bumped))) return;
    }
  }

  /**
   * 兜底成组用的贪心分组：反复「取剩余里最长等待者的最大合法子集」（复用 `maxLegalSubset`
   * —— 分组规则只此一份），直到分完。组 ≤ playerCount 人、组内两两允许（含记忆判定）。纯读。
   */
  private async greedyHumanGroups(
    entries: readonly QueueEntry[],
    tickets: ReadonlyMap<string, MatchTicket>,
    predicates: readonly MatchPredicate[],
    now: number,
    playerCount: number,
  ): Promise<string[][]> {
    const groups: string[][] = [];
    let remaining = [...entries];
    while (remaining.length > 0) {
      const group = await this.maxLegalSubset(remaining, tickets, predicates, now, playerCount);
      groups.push(group);
      const taken = new Set(group);
      remaining = remaining.filter((q) => !taken.has(q.playerId));
    }
    return groups;
  }

  /**
   * 可用性门禁（片② D5 · J20 的 `??=` 口径 + Task 2.6 按玩法）：
   * **每轮每种玩法至多问一次**（答案挂在轮次持有对象的 Map 上）。
   */
  private async gateAllows(round: MatchRound, gameType: GameType): Promise<boolean> {
    const cached = round.canByGameType.get(gameType);
    if (cached !== undefined) return cached;
    const can = await this.robot.availability(gameType);
    round.canByGameType.set(gameType, can);
    return can;
  }

  /**
   * 门禁不能给时的既有处置（原 :591-600 的 `expired` 过滤逐字）：**只判**「窗口已到点」
   * 的人（12007 + 中文文案），其余留队（J6：刚入队的人**不得**被连坐）。
   */
  private async failExpired(
    entries: readonly QueueEntry[],
    now: number,
    queue: ParsedQueueKey,
  ): Promise<void> {
    const expired = entries
      .filter((q) => now - q.enteredAt >= BOT_FILL_WAIT_MS)
      .map((q) => q.playerId);
    if (expired.length > 0) {
      await this.failMatch(expired, queue.key, '当前无匹配的玩家');
    }
  }

  /**
   * 把一组真人开成一局（既有开局链抽出 —— `createGameRoom` → `startRoom` → 失败降级）。
   * **机器人数量由房间空位自动决定**（`RoomStartService.fillBots` 补到 `room.maxPlayers`）。
   *
   * 多玩法（Task 2.3）：房间按**队列维度**建 —— `gameType`/`playerCount` 随 `queue` 进来，
   * `createGameRoom` 落进 `RoomMeta`（`maxPlayers` = playerCount，2/3/4）。
   *
   * ⚠️ **开局链的三条纪律逐字保留**（原 :655-695）：
   *  - `strict: false` —— 匹配路径保持现状（`game.start` 失败也照写 `playing`；台账 N36，本片不动）；
   *  - `announceFirst: true` —— **先公告、再开局**（`game.deal` 靠客户端收到 `room.matched` 后
   *    自己 `room.join` 登记座位；顺序反了就是三家都收不到牌）；
   *  - `onSeats` = 退匹配队列（队列是匹配专属职责；**出队必须在补位成功、开局之前**）。
   *
   * ⚠️ **失败处置不动**（原 :655-674 = §8.4② 的降级）：`startRoom` 返回 false 有**两种**
   * 原因（补位/开局失败 ⇒ 该降级；房间已被别人开起来 ⇒ **不得**动它），两者的分叉**必须
   * 原子** ⇒ 走 `cancelIfStillWaiting`（CAS），成立才 `attempts+1`（经 `bumpAttempts` 去重）。
   * 返回 false ⇒ 调用方**中止本桶本轮**（避免对注定失败的补位链反复建孤儿房）。
   *
   * 座位归属的**唯一真源**是 room-service 的 seats Hash（R124/R129）：
   * `createGameRoom` / `addBot` 返回的 `Room.players` 就是权威座位表 —— 不得本地推导。
   */
  private async startGroup(
    humans: string[],
    queue: ParsedQueueKey,
    bumped: Set<string>,
  ): Promise<boolean> {
    const room = await this.roomsService.createGameRoom(
      humans,
      queue.mode,
      queue.baseScore,
      queue.gameType,
      queue.playerCount,
    );
    // 多玩法 Task 2.4（spec §4.6.1）：claim 的值 = **roomCode**（不是 '1'）——
    // 下一轮扫描据此识别「已开局但票未删」（onSeats 延迟/失败），幂等 cancelQueue 清理。
    // 位置：`createGameRoom` 之后、`startRoom` 之前（spec 的「startRoom 前」）。
    // 只靠 TTL 30s 过期、不显式释放（幂等简单）；写失败 **fail-open**。
    try {
      for (const playerId of humans) {
        await this.redis.set(
          matchClaimKey(playerId),
          room.code,
          'EX',
          MATCH_CLAIM_TTL_SECONDS,
          'NX',
        );
      }
    } catch (err) {
      this.logger.error(`match claim write failed（fail-open，继续成组）: ${String(err)}`);
    }
    const outcome = await this.roomStart.startRoomOutcome(room.code, {
      strict: false,
      announceFirst: true,
      onSeats: async (seats) => {
        for (const s of seats) {
          if (s.isRobot) continue; // R47：机器人在本服务这条路径上无事可做（无队列、无凭据）
          await this.cancelQueue(s.userId);
        }
      },
    });
    if (outcome === 'started') {
      this.logger.log(
        `Matched ${room.players.length} seats to room ${room.code} (mode: ${queue.mode}/${queue.gameType}/${queue.playerCount}/${queue.baseScore}/${queue.region})`,
      );
      return true;
    }
    /**
     * 三态消费（Task 2.4 / spec RH3-c）：
     *  - `fatal` ⇒ 与旧 false 分支逐字相同（CAS 取消 + attempts+1）；
     *  - `retryable`（pdk 规则/开局失败）⇒ **不取消房/票**，留待下一轮（预算在 room 侧计）；
     *  - `legacy-failed`（ddz strict:false 失败仍写 playing，N36）⇒ 旧行为不新增 cancel。
     */
    if (outcome === 'fatal') {
      const cancelled = await this.roomsService.cancelIfStillWaiting(room.code);
      if (cancelled) {
        this.logger.error(`Room start failed for ${room.code}（补位失败或 game.start 失败）`);
        await this.bumpAttempts(humans, bumped);
      }
    }
    return false;
  }

  /**
   * §4.2：`robot.acquire`（**N20/P4 Task 3：TCP RPC**，不再是内部 HTTP）。
   *
   * ⚠️ 旧的「`/api` 前缀不能省」「`X-Internal-Token` 不能省」两条教训在这里**换了载体**
   * 但**没有消失**：现在的等价物是 **pattern 名**（`RPC_PATTERNS.robotAcquire`
   * 而非手写字面量）与**端口/主机**（`ROBOT_SERVICE_RPC_HOST/PORT`）。
   * 由 `test/no-internal-http.gate.test.ts` 的正向判据 + `test/match.service.test.ts`
   * 的载荷判据共同钉住 —— 替身不会因为 pattern 写错而失败，只有真实拓扑才拒（R70 同族）。
   */
  /** §8.1：`match:meta.attempts` 每轮 +1，供 `MATCH_MAX_ATTEMPTS` 判定。 */
  private async incrementAttempts(playerIds: string[]): Promise<void> {
    for (const playerId of playerIds) {
      await this.redis.hincrby(matchMetaKey(playerId), 'attempts', 1);
    }
  }

  /**
   * §8.4 ③：最终失败 → 下发 `12007` 并出队（R46）。
   *
   * 走 `match:events` → `WsGateway.onMatchEvent` → S→C `system.error`：
   * `room.match` 的 ack 早已返回，§6.3 又不允许响应型事件。
   *
   * `playerIds` 是**逐票**淘汰出来的超时票（R57），绝不是整条队列。
   *
   * 🔴 **幂等（片② D5 / J27）**：定时器**无防重入** ⇒ 一轮 >5s 时两轮重叠，重叠轮里
   * 后一轮的 `zrange` 快照可能仍含**已被判失败**的票（前一轮刚 `ZREM` 掉）⇒ 不设防
   * 就会发**第二条 12007**（本片的门禁把一轮拉长到 ≤2s+，显著放大了这个窗口）。
   *
   * 修法两条**缺一不可**（设计 v7-1 已钉死形态）：
   *  ① `ZREM` 提到 publish **之前** —— 它同时就是「这票还在不在队里」的原子判据；
   *  ② publish 的 `playerIds` 只能是 `zrem` 返回 **1** 的**子集**（谁已经被清掉谁就不发），
   *     子集为空 ⇒ **整条不发**。⚠️「只要有任一移除成功就把**原数组**发出去」是错的：
   *     已被重叠轮处理的人照样收到第二条（J27 的构造多票化就是为了区分这两种读法）。
   *
   * ⚠️ `match:meta` 的 `del` **无条件执行**（不看 `zrem` 结果）：meta 是被重叠轮**留上**的
   * 残留时也要清干净 —— 否则那些票下次入队会带着旧的 `attempts`。
   */
  private async failMatch(
    playerIds: string[],
    /** **实际**队列键（来自扫描结果）—— 不得按解析值重建（spec §4.6.1）。 */
    queueKey: string,
    message: string,
  ): Promise<void> {
    const notified: string[] = [];
    for (const playerId of playerIds) {
      const removed = await this.redis.zrem(queueKey, playerId);
      if (removed > 0) notified.push(playerId); // 只发真的被移除的
      await this.redis.del(matchMetaKey(playerId));
    }
    if (notified.length === 0) return;
    try {
      await this.redis.publish(
        MATCH_EVENTS_CHANNEL,
        JSON.stringify({
          event: 'match.timeout',
          playerIds: notified,
          code: ErrCode.MATCH_TIMEOUT,
          message,
        }),
      );
    } catch (err) {
      this.logger.error(`Failed to publish match.timeout: ${String(err)}`);
    }
    this.logger.warn(`Match timed out for ${notified.length} player(s) in ${queueKey}`);
  }

  /**
   * §5.2 规则 3（R90）：**服务间调用的身份载体**。
   *
   * ⚠️ **N20/P4 Task 3**：room-service 的全部服务间调用已迁到 **TCP RPC**，而
   * TCP 监听方**不走 HTTP 中间件**（R223）—— 因此本服务**不再**需要
   * `X-Internal-Token`（`internalHeaders()` 随之删除）。身份边界改由
   * 「RPC 端口只在 compose 内网可达」承担（基文件 `expose`，宿主映射只在 override）。
   *
   * ⚠️ 但**不要**因此删掉 HTTP 面的 `INTERNAL_SERVICE_TOKEN`：room-service 自己的
   * HTTP 面（`/api/rooms/*`、`/api/health`）仍由全局中间件保护，网关仍要注入该头。
   */

  /**
   * §4.2：`game.start`（**N20/P4 Task 3：TCP RPC**，不再是内部 HTTP）。
   *
   * ⚠️ 旧的「必须走注入的 `HttpService`」（E10/R130：裸 `fetch` 会让单测真的发网络请求，
   * 判据是假的）在这里**换了载体但同一个道理**：现在必须走**注入的 `GameClient`**
   * （它内部持有容器给的 `ClientProxy`）—— 单测注入假 proxy，绝不真发网络。
   *
   * ⚠️ `baseScore` **必须**来自房间元数据（§3.1 `Room.baseScore` → §4.2 `game.start`）：
   * 此前这里硬编码 `100`，于是「房间底分」这条链路在最后一跳断掉（N19 / 切片 10）。
   *
   * 失败**不得**让匹配流程崩溃（§8.2：下个周期重试），但必须留痕 —— 静默吞掉
   * 等于「30 秒补机器人上线即炸」再演一次（R70 的教训）。
   */
  async onApplicationShutdown(): Promise<void> {
    // 🔴 第一行置闸（照 `ConfigCacheService` 的成例）：在途一轮的 `.finally` 据此
    // 不再排新定时器 —— 否则关停只清得掉「已存在」的那一个，循环会复活。
    this.shuttingDown = true;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }
}
