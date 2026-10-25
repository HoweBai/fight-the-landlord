/**
 * 片⑦ + 记录片 T1 + 货币核心 + ② 金币场 + 风控片 T1 + 支付片 T5 + 节奏/清理片 T1：平台配置的**契约面**
 * （九十三键清单、校验函数、客户端子集）。
 *
 * ⚠️ 2026-10-21：写入口不再要求「缺省档 ∈ 档位表」——缺省改由档位表最低档推导，
 * 本包不再提供任何底分缺省常量。
 */
import { ProtocolError } from './validate'; // 真实位置 `validate.ts:24-29`（errors.ts 无此导出——r1 计划审查订正）
import type { GameType } from './game';

export const CONFIG_KEYS = [
  'robot.skillDistribution',
  'robot.ruleFallback',
  'robot.modelBySkill',
  'robot.reclaimIntervalMs',
  'room.matchScanIntervalMs',
  'room.autostartIntervalMs',
  'room.reapIntervalMs',
  'room.friendRoomEnabled',
  'game.baseScoreLevels',
  /** 记录片 T1（第 10 键）：对局记录保留天数（int、`1 ≤ n ≤ 3650`、种子 365）。 */
  'record.retentionDays',
  /** 货币核心 T2（第 11 键）：注册赠送金币数（int、`0 ≤ n ≤ 1,000,000`、种子 0；**客户端不可见**）。 */
  'currency.signupGrant',
  /** ② 金币场（第 12 键）：免费场开关（严格 boolean、种子 `true`——保持现状）。 */
  'room.freeRoomEnabled',
  /** ② 金币场（第 13 键）：金币场开关（严格 boolean、种子 `true`——默认开，2026-10-04 用户裁决）。 */
  'room.goldRoomEnabled',
  /** ② 金币场（第 14 键）：入场门槛倍率（int、`1 ≤ n ≤ 100`、种子 10；**客户端可见**）。 */
  'currency.entryMultiplier',
  /** ② 金币场（第 15 键）：抽水百分比（int、`0 ≤ n ≤ 50`、种子 0；客户端不可见）。 */
  'currency.rakePercent',
  /** ② 金币场（第 16 键）：每日救助开关（严格 boolean、种子 `false`；客户端可见）。 */
  'currency.reliefEnabled',
  /** ② 金币场（第 17 键）：每日救助金额（int、`1 ≤ n ≤ 1,000,000`、种子 200；0 不可——停发用开关）。 */
  'currency.reliefAmount',
  /** 风控片 T1（第 18 键）：同设备谓词开关（严格 boolean、种子 `false`——谓词默认关；客户端不可见）。 */
  'risk.predicate.sameDevice',
  /** 风控片 T1（第 19 键）：同 IP 谓词开关（严格 boolean、种子 `false`——谓词默认关；客户端不可见）。 */
  'risk.predicate.sameIp',
  /** 风控片 T1（第 20 键）：胜率阈值（number、`0.5 ≤ n ≤ 1.0`、≤2 位小数、种子 0.8；客户端不可见）。 */
  'risk.winRateThreshold',
  /** 风控片 T1（第 21 键）：扫描最少局数（int、`1 ≤ n ≤ 100000`、种子 100；客户端不可见）。 */
  'risk.minGames',
  /** 风控片 T1（第 22 键）：单设备关联账号上限（int、`2 ≤ n ≤ 100`、种子 3；客户端不可见）。 */
  'risk.deviceLimit',
  /** 风控片 T1（第 23 键）：设备扫描窗口天数（int、`1 ≤ n ≤ 365`、种子 30；客户端不可见）。 */
  'risk.deviceWindowDays',
  /** 风控片 T1（第 24 键）：命中自动限流开关（严格 boolean、种子 `true`；客户端不可见）。 */
  'risk.autoThrottle',
  /** 风控片 T1（第 25 键）：设备记录保留天数（int、`1 ≤ n ≤ 3650`、种子 365；客户端不可见）。 */
  'risk.deviceRetentionDays',
  /** 支付片 T5（第 26 键）：充值开关（严格 boolean、种子 `false`——暗上线；客户端可见）。 */
  'pay.rechargeEnabled',
  /** 支付片 T5（第 27 键）：提现开关（严格 boolean、种子 `false`——暗上线；客户端可见）。 */
  'pay.withdrawEnabled',
  /** 支付片 T5（第 28 键）：金币/元比率（int、`1 ≤ n ≤ 1,000,000`、种子 100；客户端可见——档位换算展示）。 */
  'pay.coinPerYuan',
  /** 支付片 T5（第 29 键）：充值档位表（元；非空唯一正整数数组、每项 `1 ≤ n ≤ 9,999,999`、种子 `[6,30,68,128,328]`；客户端可见）。 */
  'pay.rechargePackages',
  /** 支付片 T5（第 30 键）：提现门槛金币（int、`1 ≤ n ≤ 1,000,000`、种子 1000；客户端可见）。 */
  'pay.withdrawMinCoins',
  /** 支付片 T5（第 31 键）：单笔提现上限金币（int、`1 ≤ n ≤ 1,000,000`、种子 50000；客户端可见）。 */
  'pay.withdrawMaxCoinsPerOrder',
  /** 支付片 T5（第 32 键）：单日/人提现上限金币（int、`1 ≤ n ≤ 1,000,000`、种子 100000；客户端可见）。 */
  'pay.withdrawDailyMaxCoins',
  /** 支付片 T5（第 33 键）：订单有效期分钟（int、`1 ≤ n ≤ 10080`、种子 30；客户端不可见）。 */
  'pay.orderExpireMinutes',
  /** 支付片 T5（第 34 键）：提现超时回滚分钟（int、`1 ≤ n ≤ 10080`、种子 4320=72h；客户端不可见——测试注入用 1）。 */
  'pay.withdrawTimeoutMinutes',
  /** 节奏/清理片 T1（第 35 键）：支付扫描周期——八条补偿循环的统一节奏（int、`1 ≤ n ≤ 600000`、种子 60000=60s；客户端不可见——消费方 payment-service）。 */
  'pay.scanIntervalMs',
  /** 节奏/清理片 T1（第 36 键）：支付日自检周期——入账勾稽 + 锚勾稽（int、`1 ≤ n ≤ 864000000`、种子 86400000=24h；客户端不可见——消费方 payment-service）。 */
  'pay.reconcileIntervalMs',
  /** 节奏/清理片 T1（第 37 键）：货币对账周期——账实相符/缓存漂移自愈/孤儿诊断（int、`1 ≤ n ≤ 36000000`、种子 3600000=1h；客户端不可见——消费方 currency-service）。 */
  'currency.reconcileIntervalMs',
  /** 节奏/清理片 T1（第 38 键）：风控扫描周期——内置闸 + 双谓词判定（int、`1 ≤ n ≤ 36000000`、种子 3600000=1h；客户端不可见——消费方 user-service）。 */
  'risk.scanIntervalMs',
  /** 节奏/清理片 T1（第 39 键）：风控设备记录清理周期——按 `risk.deviceRetentionDays` 保留期批删（int、`1 ≤ n ≤ 36000000`、种子 3600000=1h；客户端不可见——消费方 user-service）。 */
  'risk.devicesCleanupIntervalMs',
  /** 节奏/清理片 T1（第 40 键）：对局记录保留期清理周期——保留天数在 `record.retentionDays` 单独调（int、`1 ≤ n ≤ 36000000`、种子 3600000=1h；客户端不可见——消费方 user-service）。 */
  'record.cleanupIntervalMs',
  /** 第 41 键：救助广告位 adpid（客户端下发裸名 `reliefAdpid`；空串=未配置 ⇒ 救助入口不渲染）。 */
  'ad.reliefAdpid',
  /** 客户端接入片（第 43 键）：App 端准入（严格 boolean、种子 `true`、客户端不可见——不进 CLIENT_CONFIG_KEYS）。 */
  'client.appEnabled',
  /** 客户端接入片（第 44 键）：H5 端准入（严格 boolean、种子 `true`、客户端不可见）。 */
  'client.h5Enabled',
  /** 机器人补位开关片（第 45 键）：免费场（random）匹配缺人时是否补机器人（严格 boolean、种子 `true`——现状）。 */
  'room.freeBotFillEnabled',
  /** 机器人补位开关片（第 46 键）：金币场（gold）匹配缺人时是否补机器人（严格 boolean、种子 `true`——现状）。 */
  'room.goldBotFillEnabled',
  /**
   * 机器人补位开关片（第 47 键）：补机器人关闭时，真人匹配的**总等待上限**（int 毫秒、
   * `30000 ≤ n ≤ 1800000` 即 30s..30min、种子 300000=5min）。到点仍未凑齐 3 名真人 ⇒
   * 12007 终止；期间每 30s 可经 `match.wait_prompt` 弹窗由玩家确认延长。**客户端不可见**。
   */
  'room.matchNoBotMaxWaitMs',
  /** 提现再认证片（第 48 键）：提现敏感操作再认证开关（严格 boolean、
   *  种子 false；客户端不可见——消费方 payment-service WithdrawController.apply() 票据闸）。开关开后
   *  提现必须先调 POST /api/auth/reauth 换一次性票据（user-service 签），再带 X-Reauth-Ticket header 调 apply。 */
  'risk.withdrawReAuthEnabled',
  /** 设备绑定片（**第 49 键**；合并期由分支的第 43 键让位）：单账号设备绑定开关（严格 boolean、种子
   *  `false`——暗上线；客户端不可见——纯服务端闸：登录/注册/refresh 校验 + 网关 WS 握手校验）。 */
  'risk.deviceBindingEnabled',
  /** 记牌器片（**第 50 键**）：斗地主牌桌记牌器总开关（严格 boolean、种子 `true`——保持现状；
   *  客户端可见——裸名 `cardCounterEnabled`）。关 ⇒ 客户端入口不渲染、累积器不启动。 */
  'game.cardCounterEnabled',
  /** 记牌器收费片（**第 51 键**）：单局卡价格（整数金币 `0..1,000,000`；0 = 该商品隐藏）。
   *  客户端可见——裸名 `cardCounterPricePerGameCoins`。 */
  'game.cardCounterPricePerGameCoins',
  /** 记牌器收费片（**第 52 键**）：包时卡每小时价格（同上）。客户端可见——裸名 `cardCounterPricePerHourCoins`。 */
  'game.cardCounterPricePerHourCoins',
  /** 多玩法片（2026-10-23）：跑得快档位（斗地主继续用旧 `game.baseScoreLevels`，不迁移）。 */
  'game.levels.paodekuai',
  /** 跑得快总开关（种子 false，暗上线）。客户端可见（裸名 `games.paodekuai.enabled`）。 */
  'game.paodekuai.enabled',
  /** 跑得快 2 人场开关（种子 false；2026-10-25 起与 4 人分键）。 */
  'game.paodekuai.twoPlayerEnabled',
  /** 跑得快 4 人场开关（种子 false；键名为历史命名，语义已收窄为只关 4 人）。 */
  'game.paodekuai.nonThreePlayerEnabled',
  /** 跑得快牌型/计分开关（12 键；默认值见 shared/src/pdk/rules.ts）。 */
  'game.paodekuai.bareTrioEnabled',
  'game.paodekuai.trioWithPairEnabled',
  'game.paodekuai.bareAirplaneEnabled',
  'game.paodekuai.fourWithTwoEnabled',
  'game.paodekuai.fourWithTwoPairKickerAllowed',
  'game.paodekuai.airplaneWings',
  'game.paodekuai.bombMultiplierEnabled',
  'game.paodekuai.guanMultiplierEnabled',
  'game.paodekuai.springMultiplierEnabled',
  'game.paodekuai.multiplierCap',
  'game.paodekuai.baobenEnabled',
  /** 玩法开放开关（第 66 键）：斗地主总开关（严格 boolean、种子 true——保持现状；
   *  客户端不可见——折叠进 `games.doudizhu.enabled`）。关 ⇒ 新匹配/新建房 12012。 */
  'game.doudizhu.enabled',
  /**
   * 多玩法配置平行化（2026-10-24）：以下 24 键把原平台级/斗地主专属键迁到
   * `game.<玩法>.*`，并新增平台救助门槛。旧键保留在清单尾部（只读回退）。
   * 2026-10-25：再追加跑得快风控两键（`game.paodekuai.risk.*`），共 26 键。
   */
  'game.doudizhu.freeRoomEnabled',
  'game.doudizhu.goldRoomEnabled',
  'game.doudizhu.friendRoomEnabled',
  'game.doudizhu.freeBotFillEnabled',
  'game.doudizhu.goldBotFillEnabled',
  'game.doudizhu.rakePercent',
  'game.doudizhu.entryMultiplier',
  'game.levels.doudizhu',
  'game.doudizhu.cardCounterEnabled',
  'game.doudizhu.cardCounterPricePerGameCoins',
  'game.doudizhu.cardCounterPricePerHourCoins',
  'game.doudizhu.robot.skillDistribution',
  'game.doudizhu.robot.ruleFallback',
  'game.doudizhu.robot.modelBySkill',
  'game.doudizhu.risk.winRateThreshold',
  'game.doudizhu.risk.minGames',
  'game.paodekuai.freeRoomEnabled',
  'game.paodekuai.goldRoomEnabled',
  'game.paodekuai.friendRoomEnabled',
  'game.paodekuai.freeBotFillEnabled',
  'game.paodekuai.goldBotFillEnabled',
  'game.paodekuai.rakePercent',
  'game.paodekuai.entryMultiplier',
  /** 跑得快风控两键（2026-10-25）：与斗地主阈值独立；有对局记录即纳入扫描，无 enabled 键。 */
  'game.paodekuai.risk.winRateThreshold',
  'game.paodekuai.risk.minGames',
  /** 平台级每日救助绝对门槛（int 1..1,000,000；不随玩法变化）。 */
  'currency.reliefThresholdCoins',
  /** 代理分润（2026-10-26）：客户端注册邀请码输入框开关（严格 boolean、种子 false；客户端可见——裸名 `agentInviteEnabled`）。 */
  'agent.inviteEnabled',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * 平行化迁移后**只读**的旧键（2026-10-24）。
 *
 * - 仍在 `CONFIG_KEYS` 中：快照类型、读取回退、回滚回填都要认识它们；
 * - 管理面写入一律拒绝（`PlatformConfigService.set` 用 `isLegacyConfigKey` 拦截）；
 * - 读取顺序：新键 → 旧键（仅斗地主）→ 代码默认。
 */
export const LEGACY_CONFIG_KEYS = [
  'room.freeRoomEnabled',
  'room.goldRoomEnabled',
  'room.friendRoomEnabled',
  'room.freeBotFillEnabled',
  'room.goldBotFillEnabled',
  'currency.rakePercent',
  'currency.entryMultiplier',
  'game.baseScoreLevels',
  'game.cardCounterEnabled',
  'game.cardCounterPricePerGameCoins',
  'game.cardCounterPricePerHourCoins',
  'robot.skillDistribution',
  'robot.ruleFallback',
  'robot.modelBySkill',
  'risk.winRateThreshold',
  'risk.minGames',
] as const satisfies readonly ConfigKey[];

const LEGACY_CONFIG_KEY_SET = new Set<string>(LEGACY_CONFIG_KEYS);
export function isLegacyConfigKey(key: string): boolean {
  return LEGACY_CONFIG_KEY_SET.has(key);
}

export const CLIENT_CONFIG_KEYS = [
  'baseScoreLevels',
  'friendRoomEnabled',
  'freeRoomEnabled',
  'goldRoomEnabled',
  'reliefEnabled',
  'entryMultiplier',
  /** 支付片 T5（⚙️11）：钱包页七裸名（充值/提现开关、比率、档位、三项限额）——无 `pay.` 前缀，同 `entryMultiplier` 先例。 */
  'rechargeEnabled',
  'withdrawEnabled',
  'coinPerYuan',
  'rechargePackages',
  'withdrawMinCoins',
  'withdrawMaxCoinsPerOrder',
  'withdrawDailyMaxCoins',
  /** 提交 3：提现敏感操作再认证开关（裸名下发，客户端据此决定弹不弹密码框）。 */
  'withdrawReAuthEnabled',
  'reliefAdpid',
  /** 记牌器片：记牌器总开关（裸名下发；客户端据此渲染左上角入口与横条）。 */
  'cardCounterEnabled',
  /** 记牌器收费片：单局卡/包时卡价格（裸名下发；开始游戏页购买面板）。 */
  'cardCounterPricePerGameCoins',
  'cardCounterPricePerHourCoins',
  /** 多玩法（Task 5.1）：按玩法配置（新客户端渲染玩法卡/档位；旧客户端忽略）。 */
  'games',
  /** 多玩法配置平行化：平台级救助绝对门槛（合法值或 null）。 */
  'reliefThresholdCoins',
  'version',
  /** 代理分润：注册邀请码输入框门控（缺键/旧服务端 ⇒ false）。 */
  'agentInviteEnabled',
] as const;

export interface BaseScoreLevel {
  name: string;
  baseScore: number;
  /** 台费百分比（整数 0–100；缺省 = 0 = 不收）。2026-10-21 起为台费唯一来源。 */
  entryFeePercent?: number;
}
/** 台费费率表的一项（`entryFeeOf` 的入参元素；旧第 42 键已在阶段 2 删除）。 */
export interface EntryFeePercent {
  baseScore: number;
  percent: number;
}

/**
 * 台费率派生（唯一实现）：档位项的可选 `entryFeePercent` ⇒ `EntryFeePercent[]`；
 * 缺省字段 = 0（不收）。room-service 收费块与客户端 `entryFeeOfLevel` 共用，不得再写第二份映射。
 */
export function entryFeePercentsFromLevels(
  levels: ReadonlyArray<BaseScoreLevel>,
): EntryFeePercent[] {
  return levels.map((l) => ({ baseScore: l.baseScore, percent: l.entryFeePercent ?? 0 }));
}
/**
 * 单档台费金额（客户端「入场费」与服务端收费共用 `entryFeeOf` 公式）。
 * 档位项 ⇒ 单项费率表 ⇒ `entryFeeOf`；派生映射仍只有 `entryFeePercentsFromLevels` 一份。
 */
export function entryFeeOfLevel(level: BaseScoreLevel): number {
  return entryFeeOf(level.baseScore, entryFeePercentsFromLevels([level]));
}
/** 新客户端按玩法读取的配置（旧客户端只读 `baseScoreLevels`，零变化）。 */
export interface ClientGameConfig {
  enabled: boolean;
  supportedPlayerCounts: number[];
  defaultPlayerCount: number;
  baseScoreLevels: BaseScoreLevel[];
  /** 平行化（2026-10-24）：玩法级场次/好友房/门槛；旧服务端缺失 ⇒ 客户端回退顶层值。 */
  freeRoomEnabled?: boolean;
  goldRoomEnabled?: boolean;
  friendRoomEnabled?: boolean;
  entryMultiplier?: number;
}
export interface ClientConfig {
  baseScoreLevels: BaseScoreLevel[];
  friendRoomEnabled: boolean;
  freeRoomEnabled: boolean;
  goldRoomEnabled: boolean;
  reliefEnabled: boolean;
  entryMultiplier: number;
  /** 支付片 T5（⚙️11）：以下七字段为钱包页消费的裸名子集（键名映射逐对见设计 §9）。 */
  rechargeEnabled: boolean;
  withdrawEnabled: boolean;
  coinPerYuan: number;
  rechargePackages: number[];
  withdrawMinCoins: number;
  withdrawMaxCoinsPerOrder: number;
  withdrawDailyMaxCoins: number;
  /** 提交 3：提现敏感操作再认证开关（risk.withdrawReAuthEnabled 裸名下发；客户端据此决定弹不弹密码框）。 */
  withdrawReAuthEnabled: boolean;
  reliefAdpid: string;
  /** 记牌器片（第 50 键裸名）：牌桌左上角记牌器入口/横条的门控位。 */
  cardCounterEnabled: boolean;
  /** 记牌器收费片（第 51 键裸名）：单局卡价格（金币/局；0 = 该商品隐藏）。 */
  cardCounterPricePerGameCoins: number;
  /** 记牌器收费片（第 52 键裸名）：包时卡价格（金币/小时；0 = 该商品隐藏）。 */
  cardCounterPricePerHourCoins: number;
  /** 多玩法片：按玩法配置（旧客户端忽略；新客户端据此渲染玩法卡/档位）。 */
  games?: Partial<Record<GameType, ClientGameConfig>>;
  /** 平行化：平台级救助绝对门槛；旧服务端缺失 / 新服务端坏值 ⇒ null（客户端回退旧算法）。 */
  reliefThresholdCoins?: number | null;
  /** 代理分润：注册邀请码输入框门控（缺键/旧服务端 ⇒ false）。 */
  agentInviteEnabled: boolean;
  version: number;
}
export type ConfigSnapshot = Record<ConfigKey, { value: unknown; version: number }>;

/** 可用模型名（三档装配，片② 定稿；与 robot-service `models.ts` 的默认映射同值）。 */
const MODEL_NAMES = ['sl', 'douzero_WP', 'douzero_ADP'] as const;
const SKILLS = ['beginner', 'intermediate', 'advanced'] as const;
const CYCLE_KEYS: readonly ConfigKey[] = [
  'robot.reclaimIntervalMs', 'room.matchScanIntervalMs', 'room.autostartIntervalMs', 'room.reapIntervalMs',
];

/** 周期键的闭区间上界（规格 §2.2：`0 < n ≤ 600000`；默认值最大 60000 ⇒ 十倍余量）。 */
const MAX_CYCLE_MS = 600_000;

/**
 * 机器人补位开关片（第 47 键）：无机器人匹配总等待上限的**种子/代码默认值**与闭区间。
 * 下界 = 首个提示窗口（30s）：上限不得短于首次弹窗时间；上界 30min（运营调大等待池用）。
 */
export const NO_BOT_MAX_WAIT_DEFAULT_MS = 300_000;
const NO_BOT_MAX_WAIT_MIN_MS = 30_000;
const NO_BOT_MAX_WAIT_MAX_MS = 1_800_000;

/**
 * 节奏/清理旋钮六键（第 35–40 键）：int 毫秒、`1 ≤ n ≤ 10×默认`（照 CYCLE_KEYS 十倍余量惯例）。
 * ⚠️ 不复用 CYCLE_KEYS（上界族不同）；下界 1 保 env 等价（现行 env 语义即 >=1）。
 */
const INTERVAL_KEYS: Partial<Record<ConfigKey, number>> = {
  'pay.scanIntervalMs': 600_000,
  'pay.reconcileIntervalMs': 864_000_000,
  'currency.reconcileIntervalMs': 36_000_000,
  'risk.scanIntervalMs': 36_000_000,
  'risk.devicesCleanupIntervalMs': 36_000_000,
  'record.cleanupIntervalMs': 36_000_000,
};

/**
 * 支付片 T5（第 28/30/31/32 键）：金币量级四键共用 `1 ≤ n ≤ 1,000,000`。
 * 上界理由：新 5 源走缺省 delta 上限 1,000,000（规格 §2.1 :91「✓ 覆盖 500 元=50,000 币与 1000 元/日」）
 * —— 超过它的限额/比率配置在 `currency.apply` 一关必被拒；≥1 是比率（禁除零）与门槛语义。
 */
const PAY_COINS_KEYS: readonly ConfigKey[] = [
  'pay.coinPerYuan', 'pay.withdrawMinCoins', 'pay.withdrawMaxCoinsPerOrder', 'pay.withdrawDailyMaxCoins',
];

/** 支付片 T5（第 33/34 键）：分钟量级两键共用 `1 ≤ n ≤ 10080`（一周；测试注入用小值如 1）。 */
const PAY_MINUTES_KEYS: readonly ConfigKey[] = [
  'pay.orderExpireMinutes', 'pay.withdrawTimeoutMinutes',
];

/** 多玩法片：跑得快 boolean 键（严格 boolean）。 */
const PDK_BOOLEAN_KEYS: readonly ConfigKey[] = [
  'game.paodekuai.enabled',
  'game.paodekuai.twoPlayerEnabled',
  'game.paodekuai.nonThreePlayerEnabled',
  'game.paodekuai.bareTrioEnabled',
  'game.paodekuai.trioWithPairEnabled',
  'game.paodekuai.bareAirplaneEnabled',
  'game.paodekuai.fourWithTwoEnabled',
  'game.paodekuai.fourWithTwoPairKickerAllowed',
  'game.paodekuai.bombMultiplierEnabled',
  'game.paodekuai.guanMultiplierEnabled',
  'game.paodekuai.springMultiplierEnabled',
  'game.paodekuai.baobenEnabled',
];

/** 平行化（2026-10-24）：玩法级场次/好友房/补位/记牌器开关（严格 boolean）。 */
const GAME_BOOLEAN_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.freeRoomEnabled',
  'game.doudizhu.goldRoomEnabled',
  'game.doudizhu.friendRoomEnabled',
  'game.doudizhu.freeBotFillEnabled',
  'game.doudizhu.goldBotFillEnabled',
  'game.doudizhu.cardCounterEnabled',
  'game.doudizhu.robot.ruleFallback',
  'game.paodekuai.freeRoomEnabled',
  'game.paodekuai.goldRoomEnabled',
  'game.paodekuai.friendRoomEnabled',
  'game.paodekuai.freeBotFillEnabled',
  'game.paodekuai.goldBotFillEnabled',
];

const GAME_RAKE_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.rakePercent',
  'game.paodekuai.rakePercent',
];
const GAME_ENTRY_MULTIPLIER_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.entryMultiplier',
  'game.paodekuai.entryMultiplier',
];
const GAME_CARD_COUNTER_PRICE_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.cardCounterPricePerGameCoins',
  'game.doudizhu.cardCounterPricePerHourCoins',
];
/** 两玩法风控阈值（2026-10-25）：同一 parser，错误文案带各自键名。 */
const GAME_RISK_WIN_RATE_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.risk.winRateThreshold',
  'game.paodekuai.risk.winRateThreshold',
];
const GAME_RISK_MIN_GAMES_KEYS: readonly ConfigKey[] = [
  'game.doudizhu.risk.minGames',
  'game.paodekuai.risk.minGames',
];

/**
 * 写入校验（管理面）——非法 ⇒ 抛 `ProtocolError`（中文原因）；合法 ⇒ 返回**归一化后**的值
 * （目前仅 `robot.skillDistribution` 有归一化：原始份额 ⇒ 占比）。
 *
 * 这是配置写入的**唯一**校验点：config-service 的 `PUT /api/admin/config/:key` 在落库
 * **之前**调用它（C5：非法 ⇒ 400 且不落库）。规则表见规格 §2.2，与 `config.test.ts` 逐条对应。
 */
export function parseConfigValue(key: ConfigKey, value: unknown): unknown {
  if (key === 'robot.skillDistribution') return parseSkillDistribution(value);
  if (key === 'robot.ruleFallback') return parseStrictBoolean(key, value);
  if (key === 'robot.modelBySkill') return parseModelBySkill(value);
  if (CYCLE_KEYS.includes(key)) return parseCycleMs(key, value);
  // 自有键判定必需（W1-I1）：`key in` 走原型链 ⇒ 'toString'/'constructor' 等原型名会被误判为键
  if (Object.hasOwn(INTERVAL_KEYS, key)) return parseIntervalMs(key, value);
  if (key === 'room.friendRoomEnabled') return parseStrictBoolean(key, value);
  if (key === 'game.baseScoreLevels') return parseBaseScoreLevels(value);
  if (key === 'record.retentionDays') return parseRetentionDays(value);
  if (key === 'currency.signupGrant') return parseSignupGrant(value);
  if (key === 'room.freeRoomEnabled') return parseStrictBoolean(key, value);
  if (key === 'room.goldRoomEnabled') return parseStrictBoolean(key, value);
  if (key === 'currency.entryMultiplier') return parseEntryMultiplier(value);
  if (key === 'currency.rakePercent') return parseRakePercent(value);
  if (key === 'currency.reliefEnabled') return parseStrictBoolean(key, value);
  if (key === 'currency.reliefAmount') return parseReliefAmount(value);
  if (key === 'risk.predicate.sameDevice') return parseStrictBoolean(key, value);
  if (key === 'risk.predicate.sameIp') return parseStrictBoolean(key, value);
  if (key === 'risk.winRateThreshold') return parseWinRateThreshold(value);
  if (key === 'risk.minGames') return parseMinGames(value);
  if (key === 'risk.deviceLimit') return parseDeviceLimit(value);
  if (key === 'risk.deviceWindowDays') return parseDeviceWindowDays(value);
  if (key === 'risk.autoThrottle') return parseStrictBoolean(key, value);
  if (key === 'risk.withdrawReAuthEnabled') return parseStrictBoolean(key, value);
  if (key === 'risk.deviceBindingEnabled') return parseStrictBoolean(key, value);
  if (key === 'risk.deviceRetentionDays') return parseDeviceRetentionDays(value);
  if (key === 'pay.rechargeEnabled') return parseStrictBoolean(key, value);
  if (key === 'pay.withdrawEnabled') return parseStrictBoolean(key, value);
  if (PAY_COINS_KEYS.includes(key)) return parsePayCoins(key, value);
  if (key === 'pay.rechargePackages') return parseRechargePackages(value);
  if (PAY_MINUTES_KEYS.includes(key)) return parsePayMinutes(key, value);
  if (key === 'ad.reliefAdpid') return parseReliefAdpid(value);
  if (key === 'client.appEnabled') return parseStrictBoolean(key, value);
  if (key === 'client.h5Enabled') return parseStrictBoolean(key, value);
  if (key === 'agent.inviteEnabled') return parseStrictBoolean(key, value);
  if (key === 'room.freeBotFillEnabled') return parseStrictBoolean(key, value);
  if (key === 'room.goldBotFillEnabled') return parseStrictBoolean(key, value);
  if (key === 'room.matchNoBotMaxWaitMs') return parseNoBotMaxWaitMs(value);
  if (key === 'game.cardCounterEnabled') return parseStrictBoolean(key, value);
  if (key === 'game.cardCounterPricePerGameCoins' || key === 'game.cardCounterPricePerHourCoins') {
    return parseCardCounterPrice(key, value);
  }
  if (key === 'game.levels.paodekuai') return parseBaseScoreLevels(value);
  if (key === 'game.doudizhu.enabled') return parseStrictBoolean(key, value);
  if (PDK_BOOLEAN_KEYS.includes(key)) return parseStrictBoolean(key, value);
  if (key === 'game.paodekuai.airplaneWings') return parseAirplaneWings(value);
  if (key === 'game.paodekuai.multiplierCap') return parseMultiplierCap(value);
  // ── 平行化（2026-10-24）────────────────────────────────────────────────
  if (key === 'game.levels.doudizhu') return parseBaseScoreLevels(value);
  if (GAME_BOOLEAN_KEYS.includes(key)) return parseStrictBoolean(key, value);
  if (GAME_RAKE_KEYS.includes(key)) return parseRakePercent(value, key);
  if (GAME_ENTRY_MULTIPLIER_KEYS.includes(key)) return parseEntryMultiplier(value, key);
  if (GAME_CARD_COUNTER_PRICE_KEYS.includes(key)) return parseCardCounterPrice(key, value);
  if (key === 'game.doudizhu.robot.skillDistribution') {
    return parseSkillDistribution(value, key);
  }
  if (key === 'game.doudizhu.robot.modelBySkill') return parseModelBySkill(value, key);
  if (GAME_RISK_WIN_RATE_KEYS.includes(key)) return parseWinRateThreshold(value, key);
  if (GAME_RISK_MIN_GAMES_KEYS.includes(key)) return parseMinGames(value, key);
  if (key === 'currency.reliefThresholdCoins') return parseReliefThresholdCoins(value);
  throw new ProtocolError(`未知配置键：${String(key)}`);
}

/** 记牌器收费片（第 51/52 键）：整数金币 `0 ≤ n ≤ 1,000,000`；0 = 该商品隐藏/免费态。 */
function parseCardCounterPrice(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数金币（收到 ${JSON.stringify(value)}）`);
  }
  if (value < 0 || value > 1_000_000) {
    throw new ProtocolError(`${key} 必须在 0 ≤ n ≤ 1000000 范围内（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

/** 跑得快飞机翅膀类型：`pairs | singles | both`。 */
function parseAirplaneWings(value: unknown): 'pairs' | 'singles' | 'both' {
  if (value !== 'pairs' && value !== 'singles' && value !== 'both') {
    throw new ProtocolError(
      `game.paodekuai.airplaneWings 必须是 'pairs' | 'singles' | 'both'（收到 ${JSON.stringify(value)}）`,
    );
  }
  return value;
}

/** 跑得快全场倍数上限：整数 `1 ≤ n ≤ 1024`。 */
function parseMultiplierCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(
      `game.paodekuai.multiplierCap 必须是整数（收到 ${JSON.stringify(value)}）`,
    );
  }
  if (value < 1 || value > 1024) {
    throw new ProtocolError(
      `game.paodekuai.multiplierCap 必须在 1 ≤ n ≤ 1024 范围内（收到 ${JSON.stringify(value)}）`,
    );
  }
  return value;
}

/** 严格 boolean（`'true'` 这类字符串**不算**——规格 §2.2 的「严格」口径）。 */
function parseStrictBoolean(key: ConfigKey, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ProtocolError(`${key} 必须是 boolean（严格类型：字符串 'true'/'false' 不算）`);
  }
  return value;
}

/** 周期毫秒：整数且 `0 < n ≤ 600000`（规格 §2.2）。 */
function parseCycleMs(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数毫秒`);
  }
  if (value <= 0 || value > MAX_CYCLE_MS) {
    throw new ProtocolError(`${key} 必须在 0 < n ≤ ${MAX_CYCLE_MS}（毫秒）范围内`);
  }
  return value;
}

/**
 * 无机器人匹配总等待上限（第 47 键）：整数毫秒且
 * `30000 ≤ n ≤ 1800000`（30s..30min；种子 300000=5min）。
 */
function parseNoBotMaxWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('room.matchNoBotMaxWaitMs 必须是整数毫秒');
  }
  if (value < NO_BOT_MAX_WAIT_MIN_MS || value > NO_BOT_MAX_WAIT_MAX_MS) {
    throw new ProtocolError(
      `room.matchNoBotMaxWaitMs 必须在 ${NO_BOT_MAX_WAIT_MIN_MS} ≤ n ≤ ${NO_BOT_MAX_WAIT_MAX_MS}（毫秒）范围内`,
    );
  }
  return value;
}

/** 节奏/清理间隔：整数毫秒且 `1 ≤ n ≤ INTERVAL_KEYS[key]`（本片 ⚙️2 逐字）。 */
function parseIntervalMs(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数毫秒`);
  }
  const max = INTERVAL_KEYS[key] as number;
  if (value < 1 || value > max) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ ${max}（毫秒）范围内`);
  }
  return value;
}

/** 救助广告位 adpid：string；trim 后 `''`（未配置）或 base62 ≤32（规格 §2.1 ⚙️A）。 */
function parseReliefAdpid(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProtocolError('ad.reliefAdpid 必须是字符串（严格类型：数字 / 布尔不算）');
  }
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (!/^[0-9A-Za-z]{1,32}$/.test(trimmed)) {
    throw new ProtocolError('ad.reliefAdpid 必须是 ≤32 位 base62 字母数字（或空串）；已 trim');
  }
  return trimmed;
}

/** 记录保留天数（记录片 §2.4）：int 且 `1 ≤ n ≤ 3650`（种子 365）。 */
function parseRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('record.retentionDays 必须是整数天数');
  }
  if (value < 1 || value > 3650) {
    throw new ProtocolError('record.retentionDays 必须在 1 ≤ n ≤ 3650（天）范围内');
  }
  return value;
}

/** 注册赠送金币（货币核心 §2.8）：int 且 `0 ≤ n ≤ 1,000,000`（种子 0；`0` = 不赠送）。 */
function parseSignupGrant(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('currency.signupGrant 必须是整数金币');
  }
  if (value < 0 || value > 1_000_000) {
    throw new ProtocolError('currency.signupGrant 必须在 0 ≤ n ≤ 1000000 范围内');
  }
  return value;
}

/** 入场门槛倍率（② 金币场 §1.1）：int 且 `1 ≤ n ≤ 100`（种子 10；客户端可见——门槛提示要用）。 */
function parseEntryMultiplier(value: unknown, key = 'currency.entryMultiplier'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数`);
  }
  if (value < 1 || value > 100) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ 100 范围内`);
  }
  return value;
}

/** 抽水百分比（② 金币场 §1.1）：int 且 `0 ≤ n ≤ 50`（种子 0；客户端不可见）。 */
function parseRakePercent(value: unknown, key = 'currency.rakePercent'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数`);
  }
  if (value < 0 || value > 50) {
    throw new ProtocolError(`${key} 必须在 0 ≤ n ≤ 50 范围内`);
  }
  return value;
}

/**
 * 每日救助金额（② 金币场 §1.1）：int 且 `1 ≤ n ≤ 1,000,000`（种子 200；0 不可——停发用开关）。
 */
function parseReliefAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('currency.reliefAmount 必须是整数金币');
  }
  if (value < 1 || value > 1_000_000) {
    throw new ProtocolError('currency.reliefAmount 必须在 1 ≤ n ≤ 1000000 范围内');
  }
  return value;
}

/** 每日救助绝对门槛（平行化）：int 且 `1 ≤ n ≤ 1,000,000`。 */
function parseReliefThresholdCoins(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('currency.reliefThresholdCoins 必须是整数金币');
  }
  if (value < 1 || value > 1_000_000) {
    throw new ProtocolError(
      'currency.reliefThresholdCoins 必须在 1 ≤ n ≤ 1000000 范围内',
    );
  }
  return value;
}

/** 胜率阈值（风控片 T1 第 20 键）：number 且 `0.5 ≤ n ≤ 1.0` 且**最多两位小数**（种子 0.8）。 */
function parseWinRateThreshold(value: unknown, key = 'risk.winRateThreshold'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError(`${key} 必须是 number`);
  }
  if (value < 0.5 || value > 1) {
    throw new ProtocolError(`${key} 必须在 0.5 ≤ n ≤ 1.0 范围内`);
  }
  // 两位小数口径：`Math.round` 往返相等才算（0.785 ⇒ 0.79 ≠ 0.785 ⇒ 拒）。
  if (Math.round(value * 100) / 100 !== value) {
    throw new ProtocolError(`${key} 最多两位小数`);
  }
  return value;
}

/** 扫描最少局数（风控片 T1 第 21 键）：int 且 `1 ≤ n ≤ 100000`（种子 100）。 */
function parseMinGames(value: unknown, key = 'risk.minGames'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数`);
  }
  if (value < 1 || value > 100_000) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ 100000 范围内`);
  }
  return value;
}

/** 单设备关联账号上限（风控片 T1 第 22 键）：int 且 `2 ≤ n ≤ 100`（种子 3；1 = 无意义——忽略它就是它）。 */
function parseDeviceLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('risk.deviceLimit 必须是整数');
  }
  if (value < 2 || value > 100) {
    throw new ProtocolError('risk.deviceLimit 必须在 2 ≤ n ≤ 100 范围内');
  }
  return value;
}

/** 设备扫描窗口天数（风控片 T1 第 23 键）：int 且 `1 ≤ n ≤ 365`（种子 30）。 */
function parseDeviceWindowDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('risk.deviceWindowDays 必须是整数');
  }
  if (value < 1 || value > 365) {
    throw new ProtocolError('risk.deviceWindowDays 必须在 1 ≤ n ≤ 365 范围内');
  }
  return value;
}

/** 设备记录保留天数（风控片 T1 第 25 键）：int 且 `1 ≤ n ≤ 3650`（种子 365）。 */
function parseDeviceRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError('risk.deviceRetentionDays 必须是整数天数');
  }
  if (value < 1 || value > 3650) {
    throw new ProtocolError('risk.deviceRetentionDays 必须在 1 ≤ n ≤ 3650（天）范围内');
  }
  return value;
}

/** 支付金币量键（支付片 T5 第 28/30/31/32 键）：int 且 `1 ≤ n ≤ 1,000,000`（上界理由见 `PAY_COINS_KEYS`）。 */
function parsePayCoins(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数金币`);
  }
  if (value < 1 || value > 1_000_000) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ 1000000 范围内`);
  }
  return value;
}

/**
 * 充值档位表（支付片 T5 第 29 键；照 `parseBaseScoreLevels` 先例）：非空 · 每项正整数（元）
 * 且 **≤ 9,999,999** · **唯一**。上界理由：⚙️5 的元金额形态是 1–7 位数字，
 * 且 `amount_fen = packageYuan × 100` 必须装得进 int 列（payment_orders，规格 §2.3）。
 */
function parseRechargePackages(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolError('pay.rechargePackages 必须是非空数组');
  }
  const packages: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw new ProtocolError('充值档位必须是正整数（元）');
    }
    if (item > 9_999_999) {
      throw new ProtocolError('充值档位必须在 1..9999999 范围内（元；⚙️5 的 1–7 位形态）');
    }
    if (packages.includes(item)) {
      throw new ProtocolError(`充值档位必须唯一（重复：${item}）`);
    }
    packages.push(item);
  }
  return packages;
}

/** 支付分钟量键（支付片 T5 第 33/34 键）：int 且 `1 ≤ n ≤ 10080`（一周）。 */
function parsePayMinutes(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ProtocolError(`${key} 必须是整数分钟`);
  }
  if (value < 1 || value > 10_080) {
    throw new ProtocolError(`${key} 必须在 1 ≤ n ≤ 10080（分钟）范围内`);
  }
  return value;
}

/** 技能分布：三键齐全、各值 ≥ 0、合计 > 0 ⇒ **归一化成占比**（15/35/50 ⇒ 0.15/0.35/0.5）。 */
function parseSkillDistribution(
  value: unknown,
  key = 'robot.skillDistribution',
): Record<(typeof SKILLS)[number], number> {
  if (!isObj(value)) throw new ProtocolError(`${key} 必须是对象`);
  for (const skill of SKILLS) {
    if (!(skill in value)) {
      throw new ProtocolError(`${key} 必须三键齐全（缺 ${skill}）`);
    }
  }
  const beginner = readShare(value.beginner, 'beginner', key);
  const intermediate = readShare(value.intermediate, 'intermediate', key);
  const advanced = readShare(value.advanced, 'advanced', key);
  const sum = beginner + intermediate + advanced;
  if (sum <= 0) throw new ProtocolError(`${key} 合计必须 > 0`);
  return { beginner: beginner / sum, intermediate: intermediate / sum, advanced: advanced / sum };
}

function readShare(v: unknown, skill: string, key: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new ProtocolError(`${key}.${skill} 必须是 ≥ 0 的数（非负）`);
  }
  return v;
}

/** 三档模型装配：三键齐全、值 ∈ 三档模型名（`robot-service/models.ts` 的同一集合）。 */
function parseModelBySkill(
  value: unknown,
  key = 'robot.modelBySkill',
): Record<(typeof SKILLS)[number], string> {
  if (!isObj(value)) throw new ProtocolError(`${key} 必须是对象`);
  for (const skill of SKILLS) {
    if (!(skill in value)) {
      throw new ProtocolError(`${key} 必须三键齐全（缺 ${skill}）`);
    }
  }
  return {
    beginner: readModelName(value.beginner, 'beginner', key),
    intermediate: readModelName(value.intermediate, 'intermediate', key),
    advanced: readModelName(value.advanced, 'advanced', key),
  };
}

function readModelName(v: unknown, skill: string, key: string): string {
  if (typeof v !== 'string' || !(MODEL_NAMES as readonly string[]).includes(v)) {
    throw new ProtocolError(
      `${key}.${skill} 不是可用模型名（只允许 ${MODEL_NAMES.join(' / ')}）`,
    );
  }
  return v;
}

/**
 * 底分单档上限（② 金币场 §8 / C24，对设计 C23 的加强）：`floor((2^31−1) / 2^18)` = 8191。
 * 论证：`money_delta`/`balance` 列均为 int，最坏单条 = `baseScore × 2^18`
 * （地主 ±2u、u = 底分 × BID8 × 2^13 × 春天 2）⇒ 8191 是「任何派生金币数都装得进 int」的充分上界。
 */
const MAX_BASE_SCORE = 8191;

/**
 * 底分档位表（C18 + C24）：非空 · `name` 非空 · `baseScore` 正整数且 **≤ 8191** · **唯一**。
 *
 * ⚠️ 2026-10-21 起**不再要求包含某个缺省档**：缺省底分改为「表内数值最小档」，
 * 由消费方（room-service）从表本身推导 —— 这样换经济只需改配置，不必改代码常量。
 *
 * 同日：每项可选 `entryFeePercent`（0–100 整数，缺省 0）= 台费唯一来源。**校验后必须写回**
 * 返回对象（parser 的返回值就是写入口落库值；漏写会让整张表静默退化为 0 费率）。
 */
function parseBaseScoreLevels(value: unknown): BaseScoreLevel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProtocolError('game.baseScoreLevels 必须是非空数组');
  }
  const levels: BaseScoreLevel[] = [];
  for (const item of value) {
    if (!isObj(item)) {
      throw new ProtocolError('game.baseScoreLevels 每一项必须是 { name, baseScore }');
    }
    const { name, baseScore, entryFeePercent } = item;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ProtocolError('底分档位名字必须是非空字符串');
    }
    if (typeof baseScore !== 'number' || !Number.isInteger(baseScore) || baseScore <= 0) {
      throw new ProtocolError(`底分档位「${name}」的 baseScore 必须是正整数`);
    }
    if (baseScore > MAX_BASE_SCORE) {
      throw new ProtocolError(
        `底分档位「${name}」的 baseScore 必须在 1..${MAX_BASE_SCORE} 范围内（金币金额列 int 的容量上界）`,
      );
    }
    if (entryFeePercent !== undefined) {
      if (
        typeof entryFeePercent !== 'number' ||
        !Number.isInteger(entryFeePercent) ||
        entryFeePercent < 0 ||
        entryFeePercent > 100
      ) {
        throw new ProtocolError(
          `底分档位「${name}」的 entryFeePercent 必须是 0 ≤ n ≤ 100 的整数`,
        );
      }
    }
    if (levels.some((l) => l.baseScore === baseScore)) {
      throw new ProtocolError(`底分必须唯一（重复：${baseScore}）`);
    }
    const level: BaseScoreLevel = { name, baseScore };
    if (entryFeePercent !== undefined) level.entryFeePercent = entryFeePercent;
    levels.push(level);
  }
  return levels;
}

/**
 * 台费金额（本片；客户端=服务端**同一函数**）：按 `baseScore` 精确匹配 ⇒ 未命中 ⇒ 0；
 * 命中 ⇒ `percent > 0 ? max(1, floor(baseScore * percent / 100)) : 0`。
 * 算术界：`baseScore ≤ 8191`、`percent ≤ 100` ⇒ 单笔 ≤ 8191（双精度内精确；远低于
 * `MAX_ABS_DELTA` 默认 1e6 ⇒ **无需** source 化上限）。**percent = 0 ⇒ 0 且无保底**
 * （暗上线不产生任何 1 枚误扣）。显式 `Math.floor`（照结算同族）。
 */
export function entryFeeOf(baseScore: number, percents: ReadonlyArray<EntryFeePercent>): number {
  const hit = percents.find((p) => p.baseScore === baseScore);
  if (hit === undefined || hit.percent <= 0) return 0;
  return Math.max(1, Math.floor((baseScore * hit.percent) / 100));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
