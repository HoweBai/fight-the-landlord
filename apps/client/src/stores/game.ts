/**
 * 对局状态仓库（Pinia）。
 *
 * 硬性边界（docs/design.md §12.1 / F03）：
 *   **只存渲染所需的状态。** 这里没有规则判定、没有倍数计算、没有底分常量、
 *   没有「能不能出这手牌」的判断——那些都由服务端写在 `PlayerView` 里下发。
 *
 * 本文件实现的是三条**契约规则**，不是游戏规则：
 *   ① 快照类丢弃规则（§6.2 / M02 / M08）
 *   ② 事件类不按 version 丢弃 + 按类型幂等（§6.2）
 *   ③ 行动者定位：叫抢阶段读 `bidPhase.currentBidder`（玩法 §9.1）
 */
import { defineStore } from 'pinia';
import {
  ErrCode,
  isGameType,
  resolveGameType,
  type ClientConfig,
  type ClientGameConfig,
  type GameType,
  type GameView,
  type PlayerView,
  type RoomPlayer,
  type ServerMessage,
  type SettlementResult,
  type Card,
  type RecentAction,
} from '@fight-the-landlord/protocol';
import type { ReconnectReason } from '../net/socket';
import type { BaseScoreLevel } from '../net/rest';
import { DEFAULT_MODE_ID } from '../gameModes';

/** 快照类消息的处置结果。 */
export type SnapshotOutcome = 'applied' | 'discarded' | 'rollback';

/** 事件类消息（不按 version 丢弃）。 */
export type PlayerEvent = Extract<
  ServerMessage,
  | { type: 'game.current_turn' }
  | { type: 'game.finished' }
  | { type: 'game.settlement' }
  | { type: 'game.balances' }
  | { type: 'system.error' }
  | { type: 'system.warning' }
>;

/**
 * 场次（② 金币场）：`room.match` 的 mode **只能**是这两个 —— `practice` 是 REST 建房
 * 专用（免费场/好友房），**不参与匹配**（§2.1「保持二值」两处：`rest.createRoom` /
 * `game.vue` 的建房调用点）。
 */
export type RoomMode = 'random' | 'gold';

/**
 * store 侧的客户端配置形状（② 金币场 §2.4；支付片 T14 扩到 14 键；广告片 T19 再加第 15 键
 * `reliefAdpid`）：与协议 `ClientConfig`
 * **逐键相同**，唯一差别 —— **数值类**可再为 **`null`**：
 *  - `entryMultiplier`：`null` = 服务端没给 / 还没取到 ⇒ **不做门槛提示**，缺键语义；
 *  - 支付片（T5 起 `ClientConfig` +7 必填；T14 在此接住）：`coinPerYuan` / `withdrawMinCoins` /
 *    `withdrawMaxCoinsPerOrder` / `withdrawDailyMaxCoins` 同族 —— `null` = 未知 ⇒ 钱包页
 *    **不渲染依赖它的那一格**（金币换算段 / 对应限额提示 / 对应本地预检），**不编一个数**
 *    （钱包片「余额/cap 未知 ⇒ 显 —，绝不回落 0」是服务端同一条纪律；前端不得拿假数当真值）。
 *  - 布尔与档位表不需要 null 这一档：`rechargeEnabled`/`withdrawEnabled` 的 fail-safe 值
 *    **本身就是** `false`（未知 = 隐藏区块，C19 同族）；`rechargePackages: []` = 没有档位可渲染。
 *  - `reliefAdpid`（string）的 fail-safe 值**本身就是**空串（见 state 的注释），同样不进 null 档。
 *
 * ⚠️ 这里**没有**给数值键预置任何「跟种子一致」的常量 —— 那是前端规则常量（M09），
 * 与服务端配置漂移时会静默显示错数。
 */
export interface ClientConfigState
  extends Omit<
    ClientConfig,
    | 'entryMultiplier'
    | 'coinPerYuan'
    | 'withdrawMinCoins'
    | 'withdrawMaxCoinsPerOrder'
    | 'withdrawDailyMaxCoins'
    | 'cardCounterEnabled'
    | 'cardCounterPricePerGameCoins'
    | 'cardCounterPricePerHourCoins'
  > {
  entryMultiplier: number | null;
  coinPerYuan: number | null;
  withdrawMinCoins: number | null;
  withdrawMaxCoinsPerOrder: number | null;
  withdrawDailyMaxCoins: number | null;
  /**
   * 记牌器开关（记牌器片）：**可缺省**——旧版服务端/旧夹具没有该键时按 `false`
   * 处理（未知 = 不开放，C19 同族）；`setClientConfig` 用 `=== true` 落库。
   */
  cardCounterEnabled?: boolean;
  /** 记牌器收费片（第 51/52 键裸名）：`null` = 旧服务端/缺键/非数字 ⇒ 购买面板不渲染。 */
  cardCounterPricePerGameCoins?: number | null;
  cardCounterPricePerHourCoins?: number | null;
}

/** 记牌器收费片：本局开通状态（`game.card_counter` 载荷；按 roomCode 存）。 */
export interface CardCounterGrantStatus {
  roomCode: string;
  active: boolean;
  source?: 'pass' | 'credit' | 'none' | 'unknown';
}

export interface ActiveTurn {  seat: number;
  /** 服务端给出的剩余毫秒（仅参考；倒计时以 turnDeadlineAt / serverDeadlineAt 为准，F06） */
  timeoutMs: number;
  /** 收到该消息时的本地时刻，用于在本地两次推送之间平滑倒计时 */
  receivedAt: number;
  version: number;
}

/** 需要重连时的信号（M08：快照类 version 回退）。 */
export interface RollbackRecord {
  fromVersion: number;
  incomingVersion: number;
  at: number;
}

export interface GameRuntime {
  reconnect: (reason: ReconnectReason) => void;
}

export const useGameStore = defineStore('game', {
  state: () => ({
    /** 客户端最近一次**已应用**的 version。CAS 请求的 baseVersion 从这里取（§6.5）。 */
    currentVersion: -1,
    /** 服务端下发的裁剪视图——**唯一的对局输入**（§6.4；ddz/pdk 联合）。 */
    view: null as GameView | null,
    /** 自己的座位。 */
    mySeat: null as number | null,
    /** 本局人数（`view.playerCount` / `room.matched.playerCount`；旧服务端缺省 3）。 */
    playerCount: 3 as number,
    roomCode: null as string | null,
    roomStatus: null as string | null,
    /** R49：是否正在匹配中。页面不持有它 —— 否则 12007 到达时页面无法感知。 */
    matching: false,
    /**
     * 匹配**计时起点**（epoch ms；`null` = 未在匹配中）。
     * ⚠️ 必须住 store 而不是页面局部：匹配中点「返回大厅」是**纯导航、不撤票**（K3 裁决）
     * ⇒ 回来时 `matching` 仍是 true；页面局部起点会随卸载丢失，秒表就只能显示 0s
     * （2026-10-18 实机走查形态：「正在匹配…0s」）。
     */
    matchingStartedAt: null as number | null,
    /**
     * 机器人补位开关片：服务端 `match.wait_prompt` 的**友好等待提示**文案
     * （补机器人开关关、缺人越过 30s 窗口时到达；**非终止**：票仍在队列里）。
     * `null` = 没有待应答的提示。悬浮卡片动作（重新匹配 / 继续等待）、入队、匹配终止
     * （成局/12007/取消）与 `reset()` 都清它 —— 它是「匹配中」的从属态，不得活过匹配。
     */
    matchWaitPrompt: null as string | null,
    /**
     * R658「再来一局」的**一次性意向**：牌桌在回玩法页前写它，玩法页 `game.vue` 挂载时**消费一次**。
     *
     * ⚠️ 它不是对局状态、也不是「匹配中」：牌桌**不**在这里发 `room.match`
     *（匹配的唯一实现仍在玩法页 `game.vue`，R454）—— 这里只把「用户想再来一局」这件事跨页带过去。
     * 读后即清 ⇒ 幂等（见 `consumeRematch()`），并由 `reset()` 在换局/销毁会话边界清掉。
     */
    rematchPending: false,
    /**
     * 当前玩法（片③ R752）：**跨页载体** —— 大厅选完写它、玩法页读它。
     *
     * ⚠️ 为什么必须进 store：`pageUrl()` 是**固定映射**、不能带 query（带了会破
     * `page-stack` 的「pageUrl 与 pages.json 逐条一致」判据）⇒ 页面之间只能靠 store 传值。
     * ⚠️ 顺序是**先写它、再 `navigate('game')`**（与 `requestRematch()` 同一纪律）。
     */
    activeMode: DEFAULT_MODE_ID as string,
    /**
     * 多玩法（S5.4）：按玩法的客户端配置（`GET /api/config` 的 `games`）。
     * 缺省 `{}` = 旧服务端/未取到 ⇒ 只有斗地主可见（旧行为）。
     */
    games: {} as Partial<Record<GameType, ClientGameConfig>>,
    /**
     * 底分档位表（服务端下发：`GET /api/config` 的 `baseScoreLevels` —— 片⑦ 起与
     * 好友房开关**同一条响应**，一次取、不缓存）。
     *
     * ⚠️ **跨页载体**（与 `activeMode` 同族）：**大厅**挂载时取一次并写这里，
     * **开始游戏页**复用它查场次名（**不重复调接口** —— 片规格 §3 的第二个接口）。
     * ⚠️ 空数组是**如实的**「还没取到 / 取失败」，**不是**「服务端说没有档位」——
     *    页面据此不渲染任何卡（**不猜一个底分**，M09）。
     */
    baseScoreLevels: [] as BaseScoreLevel[],
    /**
     * 好友房开关（服务端下发：`GET /api/config` 的 `friendRoomEnabled`）——「好友房」入口的门控位。
     *
     * 🔴 **初值写死 `false`（fail-safe：未知 = 隐藏）**：配置没取到 / 拉取失败 / 还没挂过大厅时，
     * 入口一律**不渲染**（C19）。写成 `undefined` 会让「配置到达前」与「服务端说开」不可区分，
     * 入口闪现。**只有**服务端明确说 `true` 才渲染入口。
     */
    friendRoomEnabled: false,
    /**
     * 免费场开关（② 金币场 §2.4；`GET /api/config` 的 `freeRoomEnabled`）。
     *
     * 🔴 **初值/fail-safe = `false`（未知 = 不渲染）**，与 `friendRoomEnabled` 同一纪律：
     * 配置到达前、拉取失败、响应违约时，场次切换里**不出现**这一项（不闪一个可能是错的选项）。
     * ⚠️ 与「**缺键语义**」是**两件事**：服务端**成功响应**里缺这个键（旧版服务端）
     * ⇒ 按 `true` 归一（与种子一致，见 `lobby.vue` 的归一化）；那是「服务端答了、只是没带这个键」，
     * 这是「服务端根本没答」。
     */
    freeRoomEnabled: false,
    /**
     * 金币场开关（同族）：初值 `false`（配置到达前不闪）；**拉取失败/违约 ⇒ fail-safe
     * 写 `true`**（2026-10-04 用户裁决：金币场默认开 —— 与种子一致）；成功响应缺键
     * ⇒ 按 `true`（§2.4）。
     */
    goldRoomEnabled: false,
    /** 每日救助开关（同族）：初值/fail-safe `false`；成功响应缺键 ⇒ 按 `false`（§2.4）。 */
    reliefEnabled: false,
    /**
     * 记牌器开关（记牌器片第 50 键 `game.cardCounterEnabled` 的裸名下发）——
     * 牌桌左上角入口与横条的门控位。
     *
     * 🔴 初值/fail-safe = `false`（未知 = 不渲染，C19 同族）；成功响应缺键 ⇒ 按 `false`
     * （旧版服务端没有该能力 = 不开放）。
     */
    cardCounterEnabled: false,
    /**
     * P1-10：最近一次 `GET /api/config` **没有拿到服务端配置**的标记
     *（lobby 的失败/违约路径置 `true`；`setClientConfig` 收到服务端配置即清 `false`）。
     *
     * 🔴 为什么需要它：失败路径写的是 `FAILSAFE_CLIENT_CONFIG`，其中
     * `cardCounterEnabled: false` 的含义是「**未知**」而不是「服务端说关」。牌桌的记牌器
     * 门控若只看 `cardCounterEnabled`，已付费玩家会因一次网络抖动被隐藏记牌器
     *（本房 `game.card_counter{active}` 是服务端权威权益）。本标记只用于区分这两种 false。
     */
    clientConfigFailsafe: false,
    /**
     * 记牌器收费片（第 51/52 键裸名）：`null` = 未知（旧服务端/缺键/拉取失败）⇒
     * 购买面板整块不渲染（不编价格）。
     */
    cardCounterPricePerGameCoins: null as number | null,
    cardCounterPricePerHourCoins: null as number | null,
    /**
     * 记牌器收费片：**本房**服务端权威状态（`game.card_counter`；按 roomCode 存）。
     * 渲染判定：总开关 ∧（本房有状态 ⇒ active；无状态且价格键缺省=旧服务端 ⇒ 回退总开关；
     * 无状态且价格已知识=新服务端 ⇒ fail-closed）。
     */
    cardCounterStatus: null as CardCounterGrantStatus | null,
    /**
     * 救助广告位（广告片 T19 · 第 15 键 `reliefAdpid`；源 = 配置中心第 41 键
     * `ad.reliefAdpid` 的**裸名下发**）。
     *
     * 🔴 初值/fail-safe/缺键 = **空串**（= 未配置 ⇒ 救助入口不渲染，规格 §2.9 入口条件
     * 的第三个合取项）。它是**参数值**（广告位 id）不是开关：不校验内容、逐字透传给
     * `playRewardedAd`（合法性由服务端第 41 键的 parse 保证）。
     */
    reliefAdpid: '',
    /**
     * 入场门槛倍率（`currency.entryMultiplier`，客户端可见的唯一货币键）。
     *
     * `null` = **服务端没给**（缺键 / 还没取到 / 拉取失败）⇒ **不做门槛提示**、
     * 不做余额置灰（§2.4 缺键语义；门槛判定始终以服务端 14003 为权威）。
     */
    entryMultiplier: null as number | null,
    /* ------------------------------------------------------------------ *
     * 支付片 T14：钱包页消费的七个裸名子集（`GET /api/config` 一次写全；
     * 键名映射逐对见设计 §9）。fail-safe/缺键语义见 `ClientConfigState` 的头注——
     * 这里只登记**初值**：一切「未知」态都不渲染依赖它的东西（C19 同族）。
     * ------------------------------------------------------------------ */
    /**
     * 充值开关（`pay.rechargeEnabled`）。🔴 初值 `false`（未知 = 充值区不渲染）；
     * **只有**服务端明确说 `true` 才渲染（`lobby.vue` 的归一化：`=== true`）。
     */
    rechargeEnabled: false,
    /** 提现开关（同族；控制提现区渲染）。 */
    withdrawEnabled: false,
    /**
     * 提交 3：提现敏感操作再认证开关（`risk.withdrawReAuthEnabled`；默认 false = 暗上线）。
     * 开关开 ⇒ 钱包页提现按钮前弹密码框 → POST /auth/reauth 换票据 → 带 X-Reauth-Ticket 调 apply。
     */
    withdrawReAuthEnabled: false,
    /** 金币/元比率（`pay.coinPerYuan`；档位按钮的金币换算展示用——下单快照在服务端）。 */
    coinPerYuan: null as number | null,
    /** 充值档位表（元；`[]` = 没给/空表 ⇒ 不渲染任何档位按钮——与底分表空表同一语义）。 */
    rechargePackages: [] as number[],
    /** 提现门槛（金币；`null` = 未知 ⇒ 占位/提示/本地预检各去一格）。 */
    withdrawMinCoins: null as number | null,
    /** 单笔提现上限（同族）。 */
    withdrawMaxCoinsPerOrder: null as number | null,
    /** 单日/人提现上限（同族；「当日剩余」由 `summary` 的实算值给，不用它现场相减）。 */
    withdrawDailyMaxCoins: null as number | null,
    /**
     * 大厅**选中的底分**（片规格 §3 裁决一：点底分卡 = 写它 + 进开始游戏页）。
     *
     * ⚠️ **不预置缺省值**：任何缺省值都是前端规则常量（M09 禁止）。计划 A 的 Task 3f
     * 曾让开始游戏页「取档位表第一档」——那是过渡实现，本片换成「用户选的那个」之后，
     * **「选中的底分」才有可观测的含义**（否则「选了没用」与「没选也能进」不可区分）。
     * `null` = 还没选过 ⇒ 开始游戏页的按钮禁用并给出提示。
     */
    selectedBaseScore: null as number | null,
    /**
     * **大厅选中的场次**（② 金币场 §14）：大厅的场次切换写它、开始游戏页的 `room.match`
     * 读它（替换此前硬编码的 `'random'`）。
     *
     * ⚠️ 与 `activeMode`/`selectedBaseScore` 同族：**页面的选择**，`reset()` 不动它
     * （「再来一局」用的仍是同一场次）。默认 `'random'`（免费场）——与种子一致。
     */
    roomMode: 'random' as RoomMode,
    /**
     * 我的钱包余额（`GET /api/wallet/balance`；② §14 的余额 chip）。
     *
     * `null` = **未知**（还没取到 / 取失败）⇒ chip 显「—」、救助入口不点亮、
     * 档位卡不做置灰（服务端仍是权威）。三个写入点：大厅挂载取数、`game.balances`
     * 到达时按我那一座本地更新（§14）、救助响应里的 `balance`。
     */
    walletBalance: null as number | null,
    /**
     * 钱包页与充值/提现子页**共享的摘要**（2026-10-23 钱包拆分 §4.5）。
     *
     * 为什么进 store：`navigateBack` 在 App 不重挂钱包页、H5 可能重挂 ⇒ 页面私有
     * summary 会显旧值；两页取数乱序由 `walletSummarySeq` 拦掉。
     */
    walletSummary: null as {
      balance: number;
      withdrawable: number;
      dailyWithdrawRemainingCoins: number;
    } | null,
    /** 摘要失败文案（静态状态位；成功写摘要时清空 —— 两页共用一份，避免新值 + 旧失败行同屏）。 */
    walletSummaryError: '',
    /** 摘要请求世代号：`beginWalletSummaryRequest` 自增；写入只接受不小于当前值的请求。 */
    walletSummarySeq: 0,
    /** 提现成功后的记录失效标记（钱包页消费后重取提现 tab；H5 重挂时也能读到）。 */
    walletRecordsStale: false,
    /**
     * 支付片 T14：**回跳单号**（`?pay=<orderNo>` 的跨页载体）。
     *
     * 为什么进 store：`pageUrl()` 是固定映射、`navigateTo` 的目标页也**不读页面参数**
     * （`@dcloudio/uni-app` 的 `onLoad` 被 import 边界闸挡在 `src/**` 之外——历史页记着
     * 同一条）⇒ 页面之间只能靠 store 传值（`activeMode`/`selectedBaseScore` 同族）。
     *
     * 写入点 = 大厅挂载时消费 URL（`net/pay.ts#consumePayReturnOrderNo`）；
     * 读取点 = 钱包页挂载（**保留到终态/用户关闭**——H5 上进入充值/提现子页会让钱包页
     * 卸载，挂载即清会让回跳面板与轮询永久消失）。回大厅（钱包页 `onBack`）与会话销毁
     * （`reset()`）时清空。`null` = 没有待处理的回跳。
     */
    walletReturnOrderNo: null as string | null,
    /**
     * 各座位的**钱包余额**（`room.join` ack / `room.state_update` 的 `players[].balance`）。
     *
     * 🔴 **只有金币场会有值**：服务端只在金币场的房间数据里写余额派生键
     * （免费场/好友房/读失败 ⇒ 该字段**永不出现**）⇒ 免费场三座恒「—」
     * 靠的是「这里根本没有值」，**不靠客户端判断场次**（D7 不可区分性红线）。
     */
    seatBalances: {} as Record<number, number>,
    /**
     * 昵称片：座位 → 昵称（来源 = `room.join` ack / `room.state_update` 的
     * `players[].nickname`）。缺省即「服务端没给」⇒ 页面回落「玩家N」。
     */
    seatNicknames: {} as Record<number, string>,
    /**
     * **结算时刻**的三座余额（`game.balances` 消息；`null` = 还没到达）。
     *
     * 与 `seatBalances` 分开是必须的：结算页金币列的三态要求「**这条消息**到没到」
     * 可判（未到 ⇒「结算中…」/ 5s 后「—」），而 `seatBalances` 里的开局余额
     * 在结算消息到达前就已经存在 —— 合成一个 map 会让「未到」不可判。
     */
    settlementBalances: null as Record<number, number> | null,
    /** 最近一次 game.current_turn（回合开始）。 */
    activeTurn: null as ActiveTurn | null,
    finished: null as
      | { winner: 'landlord' | 'farmer' }
      | { gameType: 'paodekuai'; winnerSeats: number[] }
      | null,
    settlement: null as SettlementResult | null,
    /** 已处理过的事件键 `${type}@${version}`——事件类幂等（§6.2）。 */
    appliedEventKeys: [] as string[],
    /** 最近一次回退记录；非 null 表示「需要主动重连」（M08）。 */
    rollback: null as RollbackRecord | null,
    lastSnapshotOutcome: null as SnapshotOutcome | null,
    /** 运行时钩子（由 app 层注入；markRaw 避免把函数塞进响应式代理）。 */
    runtime: null as GameRuntime | null,
  }),

  getters: {
    hand: (s): Card[] => s.view?.hand ?? [],
    cardCounts: (s): number[] => s.view?.cardCounts ?? [0, 0, 0],
    /**
     * 当前视图的玩法（S5.3）：**只有字段缺失**才缺省斗地主；pdk 专属字段存在但
     * `gameType` 缺失 ⇒ `resolveGameType` 抛错（调用方 fail closed，绝不按斗地主渲染）。
     */
    gameType: (s): GameType => (s.view ? resolveGameType(s.view) : 'doudizhu'),
    /** 当前选中的玩法（`activeMode` 的合法化；未知 ⇒ 斗地主）。 */
    activeGameType: (s): GameType =>
      isGameType(s.activeMode) ? s.activeMode : 'doudizhu',
    /** 玩法是否可见（旧服务端没有 `games` ⇒ 只有斗地主；新服务端读 `enabled`）。 */
    modeEnabled: (s) => (id: string): boolean => {
      const cfg = isGameType(id) ? s.games[id] : undefined;
      if (cfg) return cfg.enabled === true;
      return id === 'doudizhu';
    },
    /**
     * 当前玩法的底分档位表：新服务端读 `games[activeMode].baseScoreLevels`；
     * 旧服务端（无 `games`）斗地主回落顶层 `baseScoreLevels`（**不迁移**）。
     */
    activeLevels: (s): BaseScoreLevel[] => {
      const id = isGameType(s.activeMode) ? s.activeMode : 'doudizhu';
      const cfg = s.games[id];
      if (cfg) return cfg.baseScoreLevels;
      return id === 'doudizhu' ? s.baseScoreLevels : [];
    },
    /** 跑得快视图（窄化；非 pdk ⇒ null）。 */
    pdkView: (s): Extract<GameView, { gameType: 'paodekuai' }> | null =>
      s.view && s.view.gameType === 'paodekuai' ? s.view : null,
    /** 斗地主视图（窄化；pdk ⇒ null）。旧服务端视图没有 gameType ⇒ 视为 ddz。 */
    ddzView: (s): PlayerView | null =>
      s.view && s.view.gameType !== 'paodekuai' ? (s.view as PlayerView) : null,
    /** 跑得快：服务端算好的过牌许可（非 pdk ⇒ false）。 */
    canPass: (s): boolean => (s.view?.gameType === 'paodekuai' ? s.view.canPass : false),
    /** 跑得快：当前裸四张炸弹数（显示/预览）。 */
    pdkBombCount: (s): number =>
      s.view?.gameType === 'paodekuai' ? s.view.bombCount : 0,
    /** 跑得快：本局规则快照（hint/bot 共用；非 pdk ⇒ null）。 */
    pdkRules: (s) => (s.view?.gameType === 'paodekuai' ? s.view.pdkRules : null),
    /** 跑得快：结束时的获胜座位。 */
    pdkWinnerSeats: (s): number[] | null =>
      s.view?.gameType === 'paodekuai' ? (s.view.winnerSeats ?? null) : null,
    /** 斗地主叫抢段（非 ddz ⇒ null；页面/音效读它做窄化）。 */
    ddzBidPhase: (s): PlayerView['bidPhase'] | null =>
      s.view && s.view.gameType !== 'paodekuai' ? (s.view as PlayerView).bidPhase : null,
    /** 斗地主出牌段（非 ddz ⇒ null）。 */
    ddzPlayPhase: (s): PlayerView['playPhase'] | null =>
      s.view && s.view.gameType !== 'paodekuai' ? (s.view as PlayerView).playPhase : null,
    /** 「谁是地主」的唯一来源（§6.4；非 ddz ⇒ null）。 */
    landlordSeat: (s): number | null =>
      s.view && s.view.gameType !== 'paodekuai' ? (s.view as PlayerView).landlordSeat : null,
    /** 底牌：叫抢阶段恒为 null，state === 'playing' 后才可见（§6.4；非 ddz ⇒ null）。 */
    bottomCards: (s): Card[] | null =>
      s.view && s.view.gameType !== 'paodekuai' ? (s.view as PlayerView).bottomCards : null,
    /**
     * 桌面历史牌（协议 ④）：窗口 2、旧 → 新、「不出」是显式的 `cards: null`。
     * ⚠️ 缺字段（真浏览器探针的 `seedFinishedGame` 注入的残缺视图）⇒ `[]`，**不抛错**（R661）。
     *
     * ⚠️ **这里是窗口的唯一出口**（Task B2 起）：页面按座位从这个窗口分派到各槽
     *（`table.vue` 的 `actionOf(seat)`）。此前那个「窗口里最后一条 `cards !== null`」的
     * 过渡 getter（`lastPlay`）**已删** —— 它的最后两个消费者随窗口渲染一起消失了。
     */
    recentActions: (s): RecentAction[] => s.view?.recentActions ?? [],
    /**
     * 当前行动者。
     * **叫抢阶段是 `bidPhase.currentBidder`，不是 `currentPlayer`**（玩法 §9.1）。
     */
    actorSeat: (s): number | null => {
      const v = s.view;
      if (!v) return null;
      // 叫抢段只有斗地主；pdk 恒 `playing`（行动者 = currentPlayer）。
      if (v.state === 'bidding') {
        return (v as PlayerView).bidPhase.currentBidder;
      }
      if (v.state === 'playing') return v.currentPlayer;
      return null;
    },
    isMyTurn(): boolean {
      return this.actorSeat !== null && this.actorSeat === this.mySeat;
    },
    /** 最近一次 game.current_turn 指向的座位（未经 phase 归一化，仅供调试/展示）。 */
    activeTurnSeat: (s): number | null => s.activeTurn?.seat ?? null,
    /** 是否处在叫抢阶段（决定 UI 显示「叫抢」还是「出牌」按钮）。 */
    isBidding: (s): boolean => s.view?.state === 'bidding',
    isPlaying: (s): boolean => s.view?.state === 'playing',
    /** 局终（N17）：服务端下发了 `state='ended'` 的视图 ⇒ 没有下一步动作，UI 必须停止显示动作按钮。 */
    isEnded: (s): boolean => s.view?.state === 'ended',
    /** 已进房但还没收到 game.deal（等待发牌）。 */
    waitingForDeal: (s): boolean => s.view === null,
    /** 选中底分对应的**场次名**；查不到返回 `null` —— **不编名字**（片规格 §4）。 */
    selectedLevelName: (s): string | null => {
      const levels = s.games[isGameType(s.activeMode) ? s.activeMode : 'doudizhu']?.baseScoreLevels
        ?? (s.activeMode === 'doudizhu' || !isGameType(s.activeMode) ? s.baseScoreLevels : []);
      return levels.find((l) => l.baseScore === s.selectedBaseScore)?.name ?? null;
    },
    /**
     * **本局**的场次名：拿服务端的 `view.baseScore` 去档位表查（协议⑥）。
     *
     * ⚠️ 与 `selectedLevelName` 的区别：那个查的是「用户**选中**的底分」（进房前），
     * 这个查的是「**服务端说这局是**多少底分」（进房后）。**两个都要有** ——
     * 用选中值去显示牌桌会让「服务端给的底分与用户选的不一致」这种真实情况被掩盖。
     *
     * ⚠️ **查询入口必须在这里**（片规格 §3.2 逐字）：页面就地 `find()` 会变成第二个查询实现。
     * ⚠️ 查不到 ⇒ `null`，**不编名字**（既有纪律）；缺字段（探针注入的残缺视图）⇒ 同样 `null`（R661）。
     */
    viewLevelName: (s): string | null => {
      const bs = s.view?.baseScore;
      if (typeof bs !== 'number') return null;
      const levels = s.games[isGameType(s.activeMode) ? s.activeMode : 'doudizhu']?.baseScoreLevels
        ?? (s.activeMode === 'doudizhu' || !isGameType(s.activeMode) ? s.baseScoreLevels : []);
      return levels.find((l) => l.baseScore === bs)?.name ?? null;
    },
    /** 倒计时基准：来自服务端的 `turnDeadlineAt`（F06：不用本地时间判断规则）。 */
    deadlineAt: (s): number | null => s.view?.turnDeadlineAt ?? null,
    /**
     * 某个座位的**余额**（真值来源：`seatBalances`）。查不到 ⇒ `null` ⇒ 调用方显「—」。
     *
     * ⚠️ 查询入口进 store（与 `viewLevelName` 同一条纪律）：页面就地读 `seatBalances`
     * 会变成第二个读取实现 —— 而「缺 ⇒ null 不编」这条口径只能有一个出口。
     */
    seatBalance: (s) => (seat: number): number | null => s.seatBalances[seat] ?? null,
    /** 某个座位的昵称（真值来源：`seatNicknames`）。查不到 ⇒ `null` ⇒ 调用方回落「玩家N」。 */
    seatNickname: (s) => (seat: number): string | null => s.seatNicknames[seat] ?? null,
    /**
     * 某档底分的**金币门槛** = `baseScore × entryMultiplier`（服务端 14003 的同一算式：
     * `message.router.ts` 的 `needed = baseScore * configCache.entryMultiplier()`）。
     *
     * `entryMultiplier` 未知（缺键/没取到）⇒ `null` ⇒ **不做门槛提示、不置灰**（§2.4）。
     * 🔴 两个乘数**都来自服务端**（底分来自档位表、倍率来自配置）—— 本仓不得出现任何
     * 门槛字面量（`source-boundary` 的机械扫描盯着）。
     */
    goldThreshold: (s) => (baseScore: number): number | null =>
      s.entryMultiplier === null ? null : baseScore * s.entryMultiplier,
    /**
     * 「领取救助」入口的点亮条件（§14）：`reliefEnabled` ∧ 余额 **<**
     * `档位表最低档 × entryMultiplier`。
     *
     * 2026-10-21：门槛的底分锚点来自服务端档位表（不再有代码常量）。
     * ⚠️ 档位表为空 ⇒ **不点亮**（`Math.min()` 空数组 = Infinity，直接比较会恒真）。
     * ⚠️ 余额未知（`null`）或倍率未知 ⇒ **不点亮**（fail-safe：未知不放行 ——
     * 服务端仍是权威，领不了会被 14004 接住）。
     */
    reliefAvailable: (s): boolean => {
      if (s.baseScoreLevels.length === 0) return false;
      const lowest = s.baseScoreLevels.reduce((m, l) => Math.min(m, l.baseScore), Infinity);
      return (
        s.reliefEnabled &&
        s.walletBalance !== null &&
        s.entryMultiplier !== null &&
        s.walletBalance < lowest * s.entryMultiplier
      );
    },
  },

  actions: {
    /** 由 app 层注入「需要重连」的执行体（真正的重连动作在 net 层）。 */
    bindRuntime(runtime: GameRuntime) {
      this.runtime = runtime;
      return this;
    },

    /**
     * 写入「我在哪个房间的哪个座位」。
     *
     * ⚠️ **这里是「换局」的唯一复位点**（R418/N32）。`version` 是**每局**的版本号
     * （`design.md` §0.3 术语表逐字：「对局版本（version） | **每局**状态版本号」），
     * 而本 store **跨局存活** ⇒ 进新房间时必须复位 `currentVersion`，否则上一局的终值会把
     * 新局的 `v1` 快照按 M08（§6.2 快照类 `version < currentVersion` ⇒ 主动重连）判成**回退**丢弃。
     * 实测后果（真浏览器逐帧）：连发 `game.reconnect` → `13010` → 被踢回大厅，**第二局永远进不去**。
     *
     * ⚠️ **这不违反 M08**（R417）：M08 的比较集是**同一局内**的 version 序列；上一局的 50 与新局的 1
     * **不在同一个比较集里**，跨局比较不是「回退」而是「换了命名空间」。在换局边界复位，
     * **恢复的正是 M08 的前提**（`currentVersion` 属于当前局）。同一局内的 M08 语义由
     * `applySnapshot` 原样保留（见 `game-store-session-reset.test.ts` 的正对照）。
     *
     * 为什么复位写在这里而不是各个入口：进房有**两条**路径（`room.matched` 的自动进房、
     * 玩法页输入房号的手动加入），两条都写这个 setter。写在入口就必然漏掉一条（R418）。
     *
     * 幂等守卫：**只有 `roomCode` 真的变了才复位** —— 重复到达的 `room.matched`
     * （或同一房间的再次进房）不得清掉**进行中**的对局。
     */
    setRoom(roomCode: string, seat: number) {
      if (this.roomCode !== null && this.roomCode !== roomCode) this.reset();
      this.roomCode = roomCode;
      this.mySeat = seat;
    },

    setMySeat(seat: number) {
      this.mySeat = seat;
    },

    setMatching(matching: boolean) {
      if (matching) {
        // 已在匹配中再次置 true（页面重挂载 / 匹配中换底分再匹配）⇒ **不重置**起点：
        // 玩家感知的是「这一轮匹配已等了多久」，换队不改变连续等待的事实。
        if (this.matchingStartedAt === null) this.matchingStartedAt = Date.now();
      } else {
        this.matchingStartedAt = null;
      }
      this.matching = matching;
      // 提示是「匹配中」的从属态：重新入队/匹配终止（成局·取消·12007 经由 setter 的路径）
      // 都把上一轮未应答的提示收口，不让旧卡片闪进新一轮。
      this.matchWaitPrompt = null;
    },

    /**
     * 机器人补位开关片：收下 `match.wait_prompt` 文案。🔴 只在**仍在匹配中**时生效 ——
     * 推送与成局/超时竞速时，迟到的提示不得在匹配已结束后凭空弹出一个对话框。
     */
    showMatchWaitPrompt(message: string) {
      if (this.matching) this.matchWaitPrompt = message;
    },

    /** 玩家在悬浮卡片点了「重新匹配 / 继续等待」⇒ 关闭卡片（匹配本身的处置由页面做）。 */
    clearMatchWaitPrompt() {
      this.matchWaitPrompt = null;
    },

    /**
     * R658：写下「再来一局」的一次性意向（`table.vue` 的 `onAgain()` 在回玩法页前调用）。
     *
     * ⚠️ 这里**不**发任何网络请求：`room.match` 仍只有玩法页 `game.vue` 一处实现（R454/R658），
     * 牌桌只是把用户的意图交给玩法页的挂载消费 —— 不复制第二份匹配逻辑。
     */
    requestRematch() {
      this.rematchPending = true;
    },

    /**
     * R658：**读取并立即清空**这个意向（读后即清 ⇒ 幂等）。
     *
     * 调用点只有玩法页 `game.vue` 的 `onMounted`（`if (store.consumeRematch()) void match();`）。
     * 第二次调用必须返回 `false`：否则「返回大厅」后重进玩法页、页面重挂载或用户刷新会把上一局的意向
     * **重复兑现**成第二次匹配。
     */
    consumeRematch(): boolean {
      const pending = this.rematchPending;
      this.rematchPending = false;
      return pending;
    },

    /** R752：写当前玩法（大厅点卡时写、玩法页读；**不是**对局状态，`reset()` 不动它）。 */
    setActiveMode(id: string) {
      this.activeMode = id;
    },

    /** S5.3：写本局人数（`room.matched`/`room.state_update`；缺省 3）。 */
    setPlayerCount(count: number) {
      this.playerCount = count;
    },

    /**
     * 写客户端配置（大厅取到后写；片⑦ 起一次写两字段，② 金币场起逐键写全；
     * 支付片 T14 起含支付七键，广告片 T19 起含 `reliefAdpid`，提现再认证片起含
     * `withdrawReAuthEnabled` ——T5 登记的类型面过渡红在此愈合）。
     *
     * ⚠️ 成功路径写服务端给的整份配置（哑终端）；**失败路径由调用方**（`lobby.vue`）
     * 写 fail-safe 值（空表 + 全关闸 + 各数值 `null` + `reliefAdpid: ''`）—— 空表的含义见
     * state 的注释；各关闸 `false` = 未知 = 不渲染（C19 同族）。字段**同生共死**：
     * 没有「只更一半」的调用姿势。
     * ⚠️ 响应里**缺键**的归一化（free 缺 ⇒ 开等，§2.4；支付七键缺 ⇒ 关/null；`reliefAdpid`
     * 缺 ⇒ 空串）是**调用方**的事（`lobby.vue`）——到这里的永远是一份**完整**的
     * `ClientConfigState`。
     */
    setClientConfig(cfg: ClientConfigState) {
      // P1-10：服务端配置到达 ⇒ 上一轮的「失败标记」退场（false 现在是权威的「关」）。
      this.clientConfigFailsafe = false;
      this.baseScoreLevels = cfg.baseScoreLevels;
      // 多玩法（S5.4）：`games` 缺省 = 旧服务端（只有斗地主可见）。
      this.games = cfg.games ?? {};
      this.friendRoomEnabled = cfg.friendRoomEnabled;
      this.freeRoomEnabled = cfg.freeRoomEnabled;
      this.goldRoomEnabled = cfg.goldRoomEnabled;
      this.reliefEnabled = cfg.reliefEnabled;
      this.cardCounterEnabled = cfg.cardCounterEnabled === true;
      this.cardCounterPricePerGameCoins = cfg.cardCounterPricePerGameCoins ?? null;
      this.cardCounterPricePerHourCoins = cfg.cardCounterPricePerHourCoins ?? null;
      this.reliefAdpid = cfg.reliefAdpid;
      this.entryMultiplier = cfg.entryMultiplier;
      this.rechargeEnabled = cfg.rechargeEnabled;
      this.withdrawEnabled = cfg.withdrawEnabled;
      this.withdrawReAuthEnabled = cfg.withdrawReAuthEnabled === true;
      this.coinPerYuan = cfg.coinPerYuan;
      this.rechargePackages = cfg.rechargePackages;
      this.withdrawMinCoins = cfg.withdrawMinCoins;
      this.withdrawMaxCoinsPerOrder = cfg.withdrawMaxCoinsPerOrder;
      this.withdrawDailyMaxCoins = cfg.withdrawDailyMaxCoins;
    },

    /**
     * P1-10：`GET /api/config` **没有拿到服务端配置**（网络失败 / 非 0 信封 / 违约响应）。
     *
     * 调用方随后仍会写 `FAILSAFE_CLIENT_CONFIG`（各闸按 fail-safe 语义），本标记让消费点
     * 能区分「服务端明确关」与「配置未知」。
     */
    markClientConfigFailsafe() {
      this.clientConfigFailsafe = true;
    },

    /** ② 大厅的场次切换：写选中的场次（开始游戏页的 `room.match` 读它）。**不是**对局状态。 */
    setRoomMode(mode: RoomMode) {
      this.roomMode = mode;
    },

    /** 写钱包余额（大厅取数 / 救助响应 / 钱包页摘要；`null` = 未知）。 */
    setWalletBalance(balance: number | null) {
      this.walletBalance = balance;
    },

    /**
     * 发起一发摘要请求 → 返回本次请求的世代号（2026-10-23 钱包拆分 §4.5）。
     * 写入方只能在序号不小于当前值时生效 ⇒ 慢响应晚到不会覆盖新数据。
     */
    beginWalletSummaryRequest(): number {
      this.walletSummarySeq += 1;
      return this.walletSummarySeq;
    },

    /** 写共享摘要（序号化）；返回是否生效。`s !== null` 时同步 `walletBalance`。 */
    applyWalletSummary(
      s: { balance: number; withdrawable: number; dailyWithdrawRemainingCoins: number } | null,
      seq: number,
    ): boolean {
      if (seq < this.walletSummarySeq) return false;
      this.walletSummary = s;
      this.walletSummaryError = '';
      if (s !== null) this.walletBalance = s.balance;
      return true;
    },

    /** 写摘要失败文案（序号化）；返回是否生效。旧摘要刻意保留（失败不擦成空）。 */
    setWalletSummaryError(text: string, seq: number): boolean {
      if (seq < this.walletSummarySeq) return false;
      this.walletSummaryError = text;
      return true;
    },

    /** 记牌器收费片：落本房权威状态（同房重复到达幂等覆盖；跨房由 reset/换房清）。 */
    applyCardCounterStatus(payload: CardCounterGrantStatus) {
      this.cardCounterStatus = { ...payload };
    },

    /**
     * 支付片 T14：写/清**回跳单号**（大厅消费 `?pay=` 时写；钱包页保留到终态/关闭，
     * 回大厅与会话销毁时清）。
     * ⚠️ 与 `setActiveMode` 同族：**不是**对局状态；`reset()` 清它只为防「换账号后
     * 看到上一个账号的单号面板」。
     */
    setWalletReturnOrderNo(orderNo: string | null) {
      this.walletReturnOrderNo = orderNo;
    },

    /**
     * 写选中的底分（大厅点底分卡时写、开始游戏页读）。
     * ⚠️ 与 `setActiveMode` 同族：**不是**对局状态，`reset()` 不动它。
     */
    setSelectedBaseScore(baseScore: number | null) {
      this.selectedBaseScore = baseScore;
    },

    /**
     * 写入房间状态 / 校正自己的座位。**不缓存成员列表** ——
     * 牌桌渲染用的张数来源是 `PlayerView.cardCounts`（`store.cardCounts`），
     * 房间成员列表本身在客户端没有任何消费者（N38 删掉的死状态，勿再加回）。
     *
     * R61：`status` 是**可选**的 —— 两条来源的载荷形状不同：
     *  - `room.join` 的 ack：`{ roomCode, seat, players }`（**没有** `status`）；
     *  - `room.state_update` 推送：带 `status`。
     * 因此只有服务端**真的给了** `status` 才写 `roomStatus`；缺省时保持原值不变，
     * **不得**由客户端替服务端编一个（早先在 join 路径硬编码 `'playing'` 就是这个错）。
     *
     * `players` 仍然要消费：ack 与推送都可能携带「我」的座位，这里是 `mySeat`
     * 相对 `room.join` 的 `seat` 字段的校正点。
     *
     * ② 金币场（§2.3）：`players[].balance` 同样在**这里**消费（金币场每座带余额；
     * 免费场/好友房**永不出现**该字段 ⇒ 三座恒「—」）。只在字段**真的是数字**时写
     * —— 服务端读失败时省略字段，那是「这局没有真值」，**不得**清掉或补一个 0。
     */
    applyRoomState(payload: { status?: string; players: RoomPlayer[] }) {
      if (payload.status !== undefined) this.roomStatus = payload.status;
      const me = payload.players.find((p) => p.seat === this.mySeat);
      if (me) this.mySeat = me.seat;
      for (const p of payload.players) {
        if (typeof p.balance === 'number') this.seatBalances[p.seat] = p.balance;
        // 昵称片：空串/缺省都不写（空串是服务端「已知无昵称」的语义，不该变成空名字）。
        if (typeof p.nickname === 'string' && p.nickname.length > 0) {
          this.seatNicknames[p.seat] = p.nickname;
        }
      }
    },

    /**
     * ② 金币场（§2.2）：应用 `game.balances` —— 结算时刻的三座余额。
     *
     * 三个落点（同一个载荷，三处消费）：
     *  ① `settlementBalances`：结算页金币列的**唯一**到达信号（三态判据，见 state 注释）；
     *  ② `seatBalances`：牌桌座位余额跟着刷成结算时刻值（同一份事实的更新，不造第二份）；
     *  ③ `walletBalance`：我那一座的值**本地更新余额 chip**（§14 逐字；后续拉取仍是权威）。
     *
     * ⚠️ 载荷形状由协议校验器钉死（恰 3 条、座位升序），这里不再复核 —— 哑终端。
     */
    applyBalances(payload: { balances: { seat: number; balance: number }[] }) {
      const map: Record<number, number> = {};
      for (const b of payload.balances) map[b.seat] = b.balance;
      this.settlementBalances = map;
      Object.assign(this.seatBalances, map);
      const mine = this.mySeat === null ? undefined : map[this.mySeat];
      if (typeof mine === 'number') this.walletBalance = mine;
    },

    /**
     * 应用一个**裁剪快照**（`game.deal` / `game.state_update` / `game.reconnect` 的 ack）。
     *
     * §6.2 丢弃规则：
     *  - `version === currentVersion` → 丢弃（重复送达）
     *  - `version < currentVersion`  → **回退**：按 M08 主动重连，**不做本地修复**
     *  - `version > currentVersion`  → 应用
     */
    applySnapshot(view: GameView): SnapshotOutcome {
      /**
       * 玩法识别（S5.3）：只有**字段缺失**才缺省斗地主；pdk 专属字段存在但 `gameType`
       * 缺失 ⇒ fail closed（丢弃，绝不把跑得快视图当斗地主渲染）。
       */
      let gameType: GameType;
      try {
        gameType = resolveGameType(view);
      } catch {
        this.lastSnapshotOutcome = 'discarded';
        return 'discarded';
      }
      const current = this.currentVersion;
      if (current >= 0 && view.version === current) {
        this.lastSnapshotOutcome = 'discarded';
        return 'discarded';
      }
      if (current >= 0 && view.version < current) {
        this.rollback = { fromVersion: current, incomingVersion: view.version, at: Date.now() };
        this.lastSnapshotOutcome = 'rollback';
        this.runtime?.reconnect({
          kind: 'version_rollback',
          version: view.version,
          message: '牌局状态有更新，正在同步…',
        });
        return 'rollback';
      }
      this.view = view;
      this.activeMode = gameType;
      this.playerCount = view.playerCount ?? 3;
      this.currentVersion = view.version;
      this.mySeat = view.seat;
      this.roomCode = view.roomCode;
      this.rollback = null;
      this.lastSnapshotOutcome = 'applied';
      return 'applied';
    },

    /**
     * 记录一次**快照类 ack** 的处置结果，但**不改动对局状态**。
     *
     * 用途：`game.resync` / `game.reconnect` 的 ack 被判为「丢弃」时（§6.2：`version === 当前`），
     * 根本没有东西可以 `applySnapshot`，而 UI 仍然需要知道「已经是最新」而不是「什么都没发生」。
     *
     * ⚠️ 只允许用于「丢弃」这类**不改变状态**的判定；
     * 回退（`< 当前`）已经在 `applySnapshot` 里记了 `rollback` 并发出 M08 重连信号。
     */
    recordSnapshotOutcome(outcome: SnapshotOutcome) {
      this.lastSnapshotOutcome = outcome;
    },

    /**
     * 应用一个**事件类**消息。
     *
     * 事件类**不按 version 丢弃**（否则与快照同版本的 `game.current_turn` 会被误丢，
     * 玩家永远收不到自己的回合）。重复到达时按类型幂等。
     */
    applyEvent(event: PlayerEvent): boolean {
      const version = event.version ?? this.currentVersion;
      const key = `${event.type}@${version}`;
      if (this.appliedEventKeys.includes(key)) return false;
      this.appliedEventKeys.push(key);

      switch (event.type) {
        case 'game.current_turn':
          this.activeTurn = {
            seat: event.payload.seat,
            timeoutMs: event.payload.timeoutMs,
            receivedAt: Date.now(),
            version,
          };
          break;
        case 'game.finished':
          // 斗地主旧形状 `{winner}`；pdk `{gameType:'paodekuai', winnerSeats}`。
          if ('winner' in event.payload) {
            this.finished = { winner: event.payload.winner };
          } else if (event.payload.gameType === 'paodekuai') {
            this.finished = {
              gameType: 'paodekuai',
              winnerSeats: event.payload.winnerSeats,
            };
          }
          break;
        case 'game.settlement':
          // 玩法联合：ddz 旧 9 键 / pdk 向量都原样存（页面按 `isPdkSettlementResult` 分派）。
          this.settlement = event.payload;
          break;
        case 'game.balances':
          /**
           * ② 金币场（§2.2）：结算时刻三座余额。走**事件类**通道（协议 `EVENT_MESSAGES`
           * 已把它登记为事件类：`version` 与 `game.settlement` 同值、同一局至多一条有效凭据）
           * ⇒ 上面的 `type@version` 幂等键天然覆盖重复推送。
           */
          this.applyBalances(event.payload);
          break;
        case 'system.error':
          /**
           * Task 2：store 不再保存 `notices`（提示统一走会话 notice / `system.warning`
           * 独立订阅）。这里只保留 12007 的匹配终止复位。
           */
          // R49：`12007`（MATCH_TIMEOUT）是匹配的**终止**信号 —— 必须复位匹配中状态，
          // 否则玩法页的按钮永久停在「正在匹配…」，用户再也点不了第二次。
          if (event.payload.code === ErrCode.MATCH_TIMEOUT) {
            // 走 setter 收口（`matching` + `matchingStartedAt` + 提示三件同清）。
            this.setMatching(false);
          }
          break;
        default:
          break;
      }
      return true;
    },

    /**
     * 清空对局渲染状态（**不是**对局状态本身 —— 对局状态永远以服务端为准）。
     *
     * 四个调用点，各自对应一个**生命周期边界**：
     *  - `setRoom()`：**换房间**（换局 ⇒ 换 version 命名空间，N32/R418）
     *  - `stopGameSession()`：**销毁本地会话**（登出/登录重建，N30②/R419）
     *  - `joinMatchedRoom()`：自动进房被服务端拒（`room.join` 非 0）⇒ **不留半个房间状态**
     *  - `onActionDisposition()`：服务端明确要求回大厅（`13005`/`13010`）
     * `matching` 也在复位范围内 —— 否则「退出登录 → 再登录」后玩法页会停在
     * 「正在匹配…」且没有可点的「开始游戏」（N30② 的实测形态）。
     * `rematchPending`（R658）同理：它是**上一局**的一次性意向，换局边界不得带过去
     * （否则新局的玩法页挂载会把旧意向兑现成一次用户没点的匹配）。
     */
    reset() {
      this.currentVersion = -1;
      this.view = null;
      this.mySeat = null;
      this.roomCode = null;
      this.roomStatus = null;
      // 记牌器收费片：本房状态随房间清空（跨房不复用）。
      this.cardCounterStatus = null;
      // 走 setter 收口（`matching` + `matchingStartedAt` + 提示三件同清）。
      this.setMatching(false);
      this.rematchPending = false;
      this.activeTurn = null;
      this.finished = null;
      this.settlement = null;
      this.appliedEventKeys = [];
      this.rollback = null;
      this.lastSnapshotOutcome = null;
      /**
       * ② 金币场：钱包余额与两处座位余额**跟着会话/房间走**，一并清掉：
       *  - `walletBalance` 是**上一条会话**的服务端事实 —— 不清的话「登出 → 换个账号登录」
       *    期间顶栏会显示**上一个人**的余额（与 `nickname` 不清是同一类缺陷）；
       *  - `seatBalances` / `settlementBalances` 是**这一局**的事实（换局/回厅即作废）——
       *    留着会让下一局的金币列把上一局的余额当成「已到达」。
       *  `reset()` 的四个调用点（换房间 / 销毁会话 / 进房被拒 / 服务端要求回大厅）之后，
       *  大厅挂载会重取余额、牌桌会从新的 join ack 重建 —— 没有一处依赖旧值。
       */
      this.walletBalance = null;
      /**
       * 钱包拆分 §4.5：摘要/错误/失效标记同属**上一条会话**的服务端事实。
       * ⚠️ 序号**自增**而不是归 0 —— 归 0 会让旧会话的在途响应变成「更新序号」而写回。
       */
      this.walletSummary = null;
      this.walletSummaryError = '';
      this.walletSummarySeq += 1;
      this.walletRecordsStale = false;
      // 回跳载体：不跨会话（换账号后不得看到上一账号的单号面板）。
      this.walletReturnOrderNo = null;
      this.seatBalances = {};
      // 昵称片：换房/回大厅不残留上一局的名字。
      this.seatNicknames = {};
      this.settlementBalances = null;
      // ⚠️ 刻意**不**清 `activeMode` / `selectedBaseScore` / `roomMode` / `baseScoreLevels` /
      //    `friendRoomEnabled` / `freeRoomEnabled` / `goldRoomEnabled` / `reliefEnabled` /
      //    `reliefAdpid` / `entryMultiplier` / 支付七键（`rechargeEnabled`…`withdrawDailyMaxCoins`）：
      //    它们是**页面的选择 / 服务端下发的配置**，不是对局状态（spec §3「跨页状态归 store」）。
      //    `reset()` 的四个调用点全是**生命周期边界**（换房间 / 销毁会话 /
      //    进房被拒 / 服务端要求回大厅），没有一个是「用户想重选底分 / 重选场次」，
      //    更没有一个是「服务端改了配置」——配置由大厅挂载时重取。
    },
  },
});
