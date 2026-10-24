import { vi } from 'vitest';
import { DEFAULT_PDK_RULES } from '@fight-the-landlord/shared';
import { supportsPlayerCount, type GameType } from '@fight-the-landlord/protocol';
import type { ConfigCacheService, CycleKey } from '../../src/config/config-cache.service';
import { CYCLE_MS_DEFAULTS } from '../../src/config/config-cache.service';

/**
 * **配置缓存**的测试桩（片⑦ T7 —— 取代 T2 起的 `config-client.stub.ts`）。
 *
 * 为什么要抽出来：`RoomsService` / `MatchService` / 两个扫描器的构造函数都多了同一个依赖
 * （`ConfigCacheService`），而 `new RoomsService(...)` 在**十个**测试文件里出现 ——
 * 每个文件各写一份 stub 就是「同一件替身、十套语义」（本仓为「第二真源」付过多次代价）。
 *
 * ⚠️ 与旧桩（`levels`）的三处差异，都是**形态跟随真身**：
 *  - `baseScoreLevels()` 是**异步**的（真身内部可能即时拉一次 RPC）；
 *  - 多了 `friendRoomEnabled()` / `cycleMs()` 两个 getter（三面拒绝与四处循环读它们）；
 *  - 缺省值**镜像生产**：档位 = 种子四档（15/80/480/1200）· 开关 = 种子
 *    （生产/种子的默认态；要反向的用例**显式** `mockReturnValue(...)` —— 与
 *    `makeConfigClient()` 缺省给真档位的同一纪律：夹具随手编值会掩盖「用的是不是真值」）·
 *    周期 = `CYCLE_MS_DEFAULTS`（缺快照时真身的兜底值）。
 */
export const BASE_SCORE_TIERS: { name: string; baseScore: number }[] = [
  { name: '休闲场', baseScore: 15 },
  { name: '标准场', baseScore: 80 },
  { name: '竞技场', baseScore: 480 },
  { name: '豪侠场', baseScore: 1200 },
];

/** 桩的形状：getter 都是 `vi.fn`，用例可以 `mockReturnValue` / `toHaveBeenCalled`。 */
export interface ConfigCacheStub {
  friendRoomEnabled: ReturnType<typeof vi.fn>;
  /** ② T4：免费场开关（`room.freeRoomEnabled`，种子 true）。 */
  freeRoomEnabled: ReturnType<typeof vi.fn>;
  /** ② T4：金币场开关（`room.goldRoomEnabled`，种子 true —— 2026-10-04 用户裁决默认开）。 */
  goldRoomEnabled: ReturnType<typeof vi.fn>;
  /** ② T4：入场门槛倍数（`currency.entryMultiplier`，种子 10）。 */
  entryMultiplier: ReturnType<typeof vi.fn>;
  /** ② T5：结算抽水比例（`currency.rakePercent`，种子 0 = 零和起点）。 */
  rakePercent: ReturnType<typeof vi.fn>;
  /** 风控 T2：同设备谓词开关（`risk.predicate.sameDevice`，种子 false）。 */
  riskPredicateSameDevice: ReturnType<typeof vi.fn>;
  /** 风控 T2：同 IP 谓词开关（`risk.predicate.sameIp`，种子 false）。 */
  riskPredicateSameIp: ReturnType<typeof vi.fn>;
  /** 台费费率（由档位表派生；种子四档 ×0 = 暗上线 ⇒ 收费块短路）。 */
  entryFeePercents: ReturnType<typeof vi.fn>;
  /** 记牌器收费片：总开关（缺省 false = 未显式开启；收费/状态用例显式 mockReturnValue(true)）。 */
  cardCounterEnabled: ReturnType<typeof vi.fn>;
  /** 记牌器收费片：两价格（缺省 10/100 = 种子）。 */
  cardCounterPrices: ReturnType<typeof vi.fn>;
  /** 机器人补位开关片：免费场补机器人开关（`room.freeBotFillEnabled`，种子 true = 现状）。 */
  freeBotFillEnabled: ReturnType<typeof vi.fn>;
  /** 机器人补位开关片：金币场补机器人开关（`room.goldBotFillEnabled`，种子 true = 现状）。 */
  goldBotFillEnabled: ReturnType<typeof vi.fn>;
  /** 机器人补位开关片：关机器人时真人等待总上限 ms（`room.matchNoBotMaxWaitMs`，种子 300000）。 */
  matchNoBotMaxWaitMs: ReturnType<typeof vi.fn>;
  /** 多玩法（Task 2.2）：跑得快总开关（种子 false = 暗上线）。 */
  paodekuaiEnabled: ReturnType<typeof vi.fn>;
  /** 多玩法（Task 2.2）：跑得快 2/4 人闸（种子 false）。 */
  paodekuaiNonThreePlayerEnabled: ReturnType<typeof vi.fn>;
  /** 多玩法（Task 2.2）：本局跑得快规则快照。 */
  pdkRules: ReturnType<typeof vi.fn>;
  /** 多玩法（Task 2.2）：玩法是否开放（ddz 恒 true；pdk 读开关）。 */
  gameEnabled: ReturnType<typeof vi.fn>;
  /** 多玩法（Task 2.2）：房间人数是否可开（含 nonThree 收窄）。 */
  supportsRoomPlayerCount: ReturnType<typeof vi.fn>;
  baseScoreLevels: ReturnType<typeof vi.fn>;
  cycleMs: ReturnType<typeof vi.fn>;
}

/**
 * 建一个配置缓存桩。`baseScoreLevels` 缺省返回 `BASE_SCORE_TIERS`（真档位）；
 * 传 `[]` 可以构造「表是空的」，传别的数组可以构造「夹具专属档位」。
 *
 * ② T4 起多三个 getter，缺省值**镜像生产种子**（与 friendRoomEnabled 的同一纪律）：
 * `freeRoomEnabled=true`（免费场保持现状开）/ `goldRoomEnabled=true`（默认开，2026-10-04
 * 用户裁决）/ `entryMultiplier=10` —— 要「关」「别的倍数」的用例**显式** `mockReturnValue`。
 * ② T5 再加 `rakePercent`（缺省 0 = 零和起点；要抽水用例显式覆写）。
 */
export function makeConfigCache(
  tiers: { name: string; baseScore: number }[] = BASE_SCORE_TIERS,
): ConfigCacheStub {
  // 多玩法（Task 2.2）：玩法开关与人数闸要有**一份**状态，`gameEnabled`/
  // `supportsRoomPlayerCount` 才能跟随用例对两个开关的 mockReturnValue。
  const paodekuaiEnabled = vi.fn(() => false);
  const paodekuaiNonThreePlayerEnabled = vi.fn(() => false);
  return {
    // 测试桩默认「好友房开着」：大多数用例不是在测好友房闸；闸的正反例显式 mockReturnValue。
    friendRoomEnabled: vi.fn(() => true),
    freeRoomEnabled: vi.fn(() => true),
    goldRoomEnabled: vi.fn(() => true),
    entryMultiplier: vi.fn(() => 10),
    rakePercent: vi.fn(() => 0),
    // 风控 T2：谓词默认**关**（与种子一致）—— 要「开」的用例显式 mockReturnValue(true)。
    riskPredicateSameDevice: vi.fn(() => false),
    riskPredicateSameIp: vi.fn(() => false),
    // 本片：费率缺省**镜像种子**（4 行 ×0 ⇒ entryFeeOf 恒 0 ⇒ 既有用例全部走「短路」快路径）。
    entryFeePercents: vi.fn(() =>
      BASE_SCORE_TIERS.map((t) => ({ baseScore: t.baseScore, percent: 0 })),
    ),
    // 记牌器收费片：缺省**关**（未显式开启）；价格 10/100（= 种子）。要测开启态显式 mock。
    cardCounterEnabled: vi.fn(() => false),
    cardCounterPrices: vi.fn(() => ({ perGame: 10, perHour: 100 })),
    // 机器人补位开关片：缺省**双开**（= 种子 = 现状；要测关机器人路径的用例显式 mockReturnValue(false)）。
    freeBotFillEnabled: vi.fn(() => true),
    goldBotFillEnabled: vi.fn(() => true),
    matchNoBotMaxWaitMs: vi.fn(() => 300_000),
    // 多玩法（Task 2.2）：缺省 = 种子（pdk 暗上线、2/4 人闸关）。
    paodekuaiEnabled,
    paodekuaiNonThreePlayerEnabled,
    pdkRules: vi.fn(() => ({ ...DEFAULT_PDK_RULES })),
    gameEnabled: vi.fn((gameType: GameType) =>
      gameType === 'paodekuai' ? paodekuaiEnabled() : true,
    ),
    supportsRoomPlayerCount: vi.fn((gameType: GameType, playerCount: number) => {
      if (!supportsPlayerCount(gameType, playerCount)) return false;
      return gameType !== 'paodekuai' || playerCount === 3 || paodekuaiNonThreePlayerEnabled();
    }),
    baseScoreLevels: vi.fn(async (_gameType?: GameType) =>
      _gameType === undefined || _gameType === 'doudizhu'
        ? tiers
        : // 跑得快档位由用例显式 mockResolvedValue；缺省给同值（= spec 默认四档）——
          // 不在这里造第二套档位常量。
          tiers,
    ),
    cycleMs: vi.fn((key: CycleKey) => CYCLE_MS_DEFAULTS[key]),
  };
}

/** 照 `asRedis()` 的成例：桩**不参与** `ConfigCacheService` 的结构校验，断言转换。 */
export function asConfigCache(stub: ConfigCacheStub): ConfigCacheService {
  return stub as unknown as ConfigCacheService;
}
