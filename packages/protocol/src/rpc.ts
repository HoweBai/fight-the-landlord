/**
 * §4.2 的 **TCP RPC 契约**（`docs/design.md` §4.1 / §4.2 / §4.3）。
 *
 * 本文件是 N20 迁移（独立小片 P4）的**唯一** pattern 名与载荷来源：
 * `game-service` / `robot-service` 的 `@MessagePattern` 与 `room-service` / `game-service`
 * 的 `ClientProxy.send()` 都必须 import 这里的常量，**不得**手写字面量
 * （`messages.test.ts` 有一条「pattern 名逐字」的判据钉住）。
 *
 * ⚠️ 本文件的类型**永不**出现在任何 S→C 消息、**客户端可达**的 REST 响应或日志里：
 *  - `StartGameRequest.players[].isRobot/botId/skillLevel` 是**服务间内部字段**（§4.2 逐字）；
 *  - `game.snapshot` 的响应是**完整 `GameSession`**，仅限服务间（§4.2 明写「绝不可用于对外路由」）；
 *  - `RobotDecideRequest.view` 是**裁剪视图**（§9.5）。
 *
 * 传输形态：`Transport.TCP`，`game-service` 监听 **3103**、`robot-service` 监听 **3105**、
 * `config-service` 监听 **3106**、`currency-service` 监听 **3104**、`user-service` 监听 **3101**
 * （§2.1 / §2.3 的 `RPC_PORT`）。
 * ⚠️ 3101 的**两次叙事**（别再把它们读混）：片⑦ 退役的是「room → user 读**底分档位表**」
 * 那**一条边**（随档位收编进 `config.snapshot`），**不是端口**；记录片（D2）起 `user-service`
 * 以 `record.write`（room → user 写对局记录）**重新监听 3101**。
 * 「内部 RPC 端口仅供服务间使用，**不对外暴露**」。
 */

import type { ErrCode } from './errors';
import type { Card, GameView } from './views';
import type { SettlementResult } from './settlement';
// 多玩法（Task 2.5）：`record.moneyDelta` 的玩法/人数校验要用运行期目录。
import { isGameType, supportsPlayerCount, type GameType } from './game';
import type { ConfigSnapshot } from './config';
// ⚠️ 值导入（§3 的校验函数 `validateRecordMoneyDelta` 定死在本文件；T7 的 controller 消费）
import { ProtocolError } from './validate';

/**
 * §4.2 的 **pattern 名** —— **逐字**，不得改写。
 *
 * `game.action` 是 §4.2 **未**定义、由 P4 的 **R219** 补上的（§4.2 只给了 `game.start` /
 * `game.snapshot` / `game.view` / `robot.acquire` / `robot.decide`）。理由：动作转发今天由
 * room-service 的 `message.router.forwardAction()` 用**一个**抽象
 * （`action: 'bid'|'play'|'pass'` + payload + `baseVersion`）发起，拆成三个 pattern 会把
 * 同一个 CAS 语义复制三份。**动作不重试**（§4.3 的重试表只覆盖 `game.start` /
 * `game.snapshot` / `robot.acquire`；重试 CAS 动作会重复出牌）。
 *
 * `robot.release` 同理：§4.2 的表里没有它，但 §9.6 的归池需要它，且它今天已经是
 * 「room → robot」的第三条调用（`RobotClient.release`）。
 */
export const RPC_PATTERNS = {
  /** room → game：§4.2 `@MessagePattern('game.start')`。 */
  gameStart: 'game.start',
  /** room → game：§4.2 `@MessagePattern('game.view')`（按调用者裁剪；seat 由服务端从 userId 解析）。 */
  gameView: 'game.view',
  /** room → game：§4.2 `@MessagePattern('game.snapshot')`（完整会话，仅服务间）。 */
  gameSnapshot: 'game.snapshot',
  /** room → game：R219 补充（动作转发，不重试）。 */
  gameAction: 'game.action',
  /** room → robot：§4.2 `@MessagePattern('robot.acquire')`。 */
  robotAcquire: 'robot.acquire',
  /** room → robot：§9.6 归池（R219 补充）。 */
  robotRelease: 'robot.release',
  /** game → robot：§4.2 `@MessagePattern('robot.decide')`（5s / 不重试 / 失败 ⇒ 回退规则引擎）。 */
  robotDecide: 'robot.decide',
  /** 片⑦：配置中心快照（取代旧底分 RPC `config.baseScoreLevels`）——各服务 → config-service。 */
  configSnapshot: 'config.snapshot',
  /** §4.2：机器人可用性门禁（room → robot，片②）。 */
  robotAvailability: 'robot.availability',
  /** 记录片（设计 D2 / 规格 §2.2）：对局记录写入（room → user；3101 复活的唯一一条边）。 */
  recordWrite: 'record.write',
  /**
   * 货币片（T2 契约 / T4 接收侧）：`currency.apply` —— **唯一写边**（actionId 幂等）。
   * 本片发送方 = user-service 的注册赠送（`signup:<userId>`）；② 对局结算（`settle:<gameId>`）续接。
   * 请求/响应类型 = `CurrencyApplyRequest` / `CurrencyApplyResponse`（`./currency.ts`，本文件 re-export）。
   */
  currencyApply: 'currency.apply',
  /**
   * 货币片（T2 契约 / T4 接收侧）：`currency.get` —— 读余额（缓存优先、miss 回源 MySQL 写缓存；
   * `exists=false ⇒ 0`；**读路径不建行**）。请求/响应类型 = `CurrencyGetRequest` / `CurrencyGetResponse`。
   */
  currencyGet: 'currency.get',
  /**
   * 金币场（T2 契约 / T7 接收侧）：`record.moneyDelta` —— 结算资金向量回写（room → user）。
   * **deltas = 三人语义向量、含 0**（零变动座写 0，不留 NULL）；回执 = **命中的座位集合**
   * （⚠️ 不得用 affectedRows——MySQL 同值重写返回 0，幂等重发会被误判「未落库」）。
   * 请求/响应类型 = `RecordMoneyDeltaRequest` / `RecordMoneyDeltaData`（本文件下方）。
   */
  recordMoneyDelta: 'record.moneyDelta',
  /**
   * 昵称片：`user.nicknames.get` —— 批量读昵称（room → user，TCP 3101；只读边）。
   * 请求/响应类型 = `UserNicknamesGetRequest` / `UserNicknamesGetResponse`（本文件下方）。
   */
  userNicknamesGet: 'user.nicknames.get',
  /**
   * 风控片（规格 §2.1-4 / T4 接收侧）：`risk.deviceReport` —— 设备指纹上报（room → user，
   * 匹配**入队成功后**一次 fire-and-forget；不重试、失败即丢，⚙️21）。只报匹配路径
   * （好友房不报——谓词与检测均面向匹配对局，设计 §5.6）。
   * 请求/响应类型 = `RiskDeviceReportRequest` / `RiskDeviceReportResponse`（本文件下方）。
   */
  riskDeviceReport: 'risk.deviceReport',
  /**
   * 支付片（T1 契约 / T4 接收侧）：`currency.withdrawable.get` —— **可离场额度（cap）只读口径**
   * （分池唯一实现点，规格 §2.2/§2.2.1：`cap = max(0, min(cap_raw, balance))`，cap_raw 按 6 源集合
   * `recharge/game_settle/refund_hold/refund_rollback/withdraw_hold/withdraw_rollback` 求和）。
   * **只读，零写边**；响应**不是** RpcResult 信封（`{cap, balance}` 逐字）——失败以异常过线，
   * 调用方（payment 提现/退款链）按纪律 fail-closed 拒。消费纪律：资金动作时刻（锁内）调用，
   * 禁缓存、禁只查一次。
   * 请求/响应类型 = `CurrencyWithdrawableGetRequest` / `CurrencyWithdrawableGetResponse`
   * （`./currency.ts`，本文件下方 re-export）。
   */
  currencyWithdrawableGet: 'currency.withdrawable.get',
  /**
   * 支付配置管理化片（⚙️4 逐字 / T1 契约）：`config.payChannel.get` —— 渠道凭据**专用拉取通道**
   * （payment → config-service）。语义 = **每渠道调用现拉**（1000ms / 不重试 / 每调用 `.send`
   * 带 `...metaFromTrace()`，D3/§3.3）：成功 = 整图替换 payment 侧缓存，失败 = 回落上次成功值。
   * ⚠️ 该通道**不进广播快照**（`config.snapshot` 响应无 `pay.channel` 子串，§5.2 ⑤）。
   * 请求/响应类型 = `ConfigPayChannelGetRequest` / `ConfigPayChannelGetResponse`
   * （`./pay-channel`，本文件下方 re-export）。
   */
  configPayChannelGet: 'config.payChannel.get',
  /**
   * 通知通道管理化片（⚙️4 逐字 / T1 契约）：`config.notifyChannel.get` —— 通知凭据**专用拉取通道**
   * （alert-relay / am-renderer → config-service）。语义 = 专用拉取通道，消费端 **30s 轮询/无 meta**
   * （3000ms 超时 / 不重试——relay/renderer 非 Nest 服务、无 trace 基建，⚙️8 偏离登记）：
   * 成功 = 整图替换消费端缓存，失败 = 保持 last-good。
   * ⚠️ 该通道**不进广播快照**（`config.snapshot` 响应无 `notify.` 子串，§5.2 ②）。
   * 请求/响应类型 = `ConfigNotifyChannelGetRequest` / `ConfigNotifyChannelGetResponse`
   * （`./notify-channel`，经 `index.ts` re-export）。
   */
  configNotifyChannelGet: 'config.notifyChannel.get',
  /**
   * 广告片（⚙️4 逐字 / 常量 T4；pattern 随接收侧同笔落 T7——J21 约束，计划 v1.2）：
   * `config.adChannel.get` —— 广告回调密钥**专用拉取通道**（currency-service → config-service）。
   * 语义 = 消费侧**现拉 + lastGood**（成功 = 整图替换其缓存，失败 = 保持 last-good；
   * 无 lastGood ⇒ 回调 5xx，规格 §2.3；T14 消费）。
   * ⚠️ 该通道**不进广播快照**（`config.snapshot` 响应无 `ad.callback` 子串，§2.3/§5.2）。
   * 请求/响应类型 = `ConfigAdChannelGetRequest` / `ConfigAdChannelGetResponse`
   * （`./ad-channel`，经 `index.ts` re-export）。
   */
  configAdChannelGet: 'config.adChannel.get',
  /**
   * 台费片（T3 契约；**pattern 随接收侧同笔落**——J21 三同提交：键↔接收侧↔模块注册）：
   * `currency.entryFeeSkip` —— 台费免单**逐笔记账**（room → currency，TCP 3104）。
   * **写边**、`RpcResult` 信封；幂等 = `INSERT IGNORE` + `(room_code, owner_id)` 唯一键
   * （调用侧「单次不重试」——并采、双源防重）；应答 data = `{inserted: boolean}`。
   * 请求/响应类型 = `CurrencyEntryFeeSkipRequest` / `CurrencyEntryFeeSkipResponse`（`./currency.ts`）。
   */
  currencyEntryFeeSkip: 'currency.entryFeeSkip',
  /**
   * 记牌器收费片（T8 契约；**pattern 随接收侧同笔落**——J21 三同提交）：
   * `currency.cardCounterConsume` —— 开局消费权益（room → currency，TCP 3104）。
   * **写边**、`RpcResult` 信封；幂等 = `(room_code, owner_id)` 唯一键 + 回读首笔。
   * 请求/响应类型见 `./currency.ts`。
   */
  currencyCardCounterConsume: 'currency.cardCounterConsume',
  /**
   * 挂机治理片（T4 契约；**pattern 随接收侧同笔落**——J21 三同提交：键↔接收侧↔模块注册）：
   * `game.trustee` —— 托管开关（room → game，TCP 3103）。
   * **写边**、`RpcResult<{version}>` 信封；`via` 是判别位（见 `GameTrusteeRequest`）。
   */
  gameTrustee: 'game.trustee',
} as const;

/** `RPC_PATTERNS` 的取值联合（`'game.start' | 'game.view' | …`）。 */
export type RpcPattern = (typeof RPC_PATTERNS)[keyof typeof RPC_PATTERNS];

/**
 * 货币片（T2 契约定义在 `./currency.ts`，T4 在此 re-export）：**pattern 与载荷类型同门** ——
 * 消费方（user-service 的 `CurrencyClient`、② 的对局结算）从本文件一处取 `RPC_PATTERNS` 与
 * 请求/响应类型。⚠️ **仅类型**（`export type`，编译期擦除）：本文件与 `./currency.ts` 之间
 * **无运行期依赖**（后者只以 `import type` 反向引用本文件的 `RpcMeta`/`RpcResult`）。
 */
export type {
  CurrencyApplyRequest,
  CurrencyApplyData,
  CurrencyApplyResponse,
  CurrencyGetRequest,
  CurrencyGetData,
  CurrencyGetResponse,
  CurrencyWithdrawableGetRequest,
  CurrencyWithdrawableGetResponse,
  CurrencyEntryFeeSkipRequest,
  CurrencyEntryFeeSkipData,
  CurrencyEntryFeeSkipResponse,
} from './currency';

/**
 * 支付配置管理化片（T1）：**pattern 与载荷类型同门** —— 拉取方（T8 的
 * `ConfigClient.payChannel`）与接收方（T6 的 `config.rpc.controller`）从本文件一处取
 * `RPC_PATTERNS` 与请求/响应类型。⚠️ **仅类型**（`export type`，编译期擦除）：本文件与
 * `./pay-channel.ts` 之间**无运行期依赖**（后者只以 `import type` 反向引用本文件的 `RpcMeta`）。
 */
export type { ConfigPayChannelGetRequest, ConfigPayChannelGetResponse } from './pay-channel';

/**
 * 跨 RPC 边界的**显式结果信封**（P4/R220）。
 *
 * 为什么不用 Nest 的 `RpcException`：它在客户端侧只剩 `message`/`status`（**字符串**），
 * 而本仓的硬性约束是「错误码必须是 5 位数字，调用方按码分流」
 * （`message.router.isMissingGameError` 要区分 `12004` 与 `10007`；§11.2）。
 * 因此**业务错误不抛，作为 `{ok:false, code, message}` 返回**；
 * 只有**传输层故障**（连不上 / 超时）由调用方映射成 `UPSTREAM_UNAVAILABLE (10007)`。
 */
export type RpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrCode; message: string };

/**
 * **RPC 的元数据**（§15.3 的 traceId/reqId/userId 过 RPC 那一跳的载体）。
 *
 * ⚠️ **是一个可选字段**（`meta?: RpcMeta`），**不是** `extends RpcMeta`：后者会把三个 id
 * 摊平到载荷顶层，而 R1105 的省略语义要的是「**有值才出现**」的一个字段 ——
 * 既有「逐字载荷」断言也正是靠它不受影响。
 * ⚠️ 为什么带 `userId`：不带的话 `game.start`/`game.action` 在 game-service 侧的
 * 日志里 `userId` 只能是 null，而 §15.3 要求「`userId`（**若有**）」——这两条链上"有"。
 */
export interface RpcMeta {
  traceId: string;
  reqId?: string;
  userId?: string;
}

/** §4.2 的 `game.start` 入参。座位与身份由 **room-service** 决定。 */
export interface StartGameRequest {
  roomCode: string;
  baseScore: number;
  /** 多玩法：过渡期可选；缺失 = doudizhu。 */
  gameType?: GameType;
  /** 过渡期可选；缺失 = GameMeta.defaultPlayerCount。 */
  playerCount?: number;
  /** 跑得快规则快照；斗地主不用。 */
  rules?: unknown;
  /** 内部测试专用：固定随机种子/牌堆（仅 INTERNAL_TEST_HOOKS=1，生产默认关闭）。 */
  seed?: number;
  testDeck?: Card[];
  players: {
    /** 对外 ID：人类为 `userId`，机器人为 `displayId`（§9.2）。 */
    id: string;
    seat: number;
    /** 服务间内部字段：game-service 据此判断机器人回合（§9.4）。**永不下发客户端**。 */
    isRobot: boolean;
    /** 服务间内部字段：机器人内部 ID，用于调 `robot.decide`。人类玩家为 `undefined`。 */
    botId?: string;
    /** 服务间内部字段：机器人难度。 */
    skillLevel?: 'beginner' | 'intermediate' | 'advanced';
    /** 服务端内部字段：机器人基础手速（ms，1–3s）。永不下发客户端。 */
    thinkingSpeed?: number;
  }[];
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** §4.2 的 `game.start` 出参。 */
export interface GameStartedResponse {
  roomCode: string;
  state: string;
  version: number;
  /** 多玩法：过渡期可选；缺失 = doudizhu/3。 */
  gameType?: GameType;
  playerCount?: number;
}

/** §4.2 的 `game.snapshot` 入参。 */
export interface GameSnapshotRequest {
  roomCode: string;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/**
 * §4.2 的 `game.view` 入参。
 *
 * ⚠️ **只有 `userId`，没有 `seat`** —— §4.2 逐字：「**seat 由服务端从 userId 解析，
 * 不由调用方提供** —— 否则调用方可指定他人座位，等于绕过裁剪」。
 */
export interface GameViewRequest {
  roomCode: string;
  userId: string;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** R219：动作转发（room → game）。`payload`：bid `{grab}` / play `{cards}` / pass `{}`。 */
export interface GameActionRequest {
  roomCode: string;
  userId: string;
  action: 'bid' | 'play' | 'pass';
  /**
   * R697：`play` 时是 `{ cards: Card[] }`（**带花色**，服务端按身份精确摘除）。
   *
   * ⚠️ 这里此前是 `Record<string, unknown>`，调用方靠 `as` 断言收窄
   * （`game.rpc.controller.ts`）—— 那是 spec §3.5-A 记的**类型断言绕过**：
   * 编译器被明确告知「别管」，形状错了也不会报。R697 之后直接给出精确类型，
   * **那处 `as` 随之删除**。
   */
  payload: { grab?: boolean; cards?: Card[] };
  /** §6.5 的 CAS 版本号；`bid`/`play`/`pass` 需要真实值。 */
  baseVersion: number;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** R219：动作应答 —— 成功时 `data` 是**该玩家自己的**裁剪视图（`actAndView` 的产物）。 */
export type GameActionResponse = GameView;

/**
 * 挂机治理片（T4 契约 / 接收侧）：`game.trustee` 入参 —— 托管开关（room → game）。
 *
 * ⚠️ `via` 是**判别位**（规格 v1.6 的 r1 阻断 1：C12 与 C14 是同输入、互斥语义，
 * 无判别位无法实现）：
 *  - `manual`    = 客户端按钮（`manual×{on,off}` 合法）；
 *  - `reconnect` = 重连 / 回桌（`room.join`；仅 `reconnect×off` 合法）；
 *  - `abandon`   = 在局 `leave`（仅 `abandon×on` 合法）。
 * **其余组合 ⇒ `10001` 且不落盘**（C7b，game-service 侧守卫）。
 *
 * 响应 = `RpcResult<{ version: number }>`；业务错误以 `GameError.code` 过 `toResult` 信封。
 */
export interface GameTrusteeRequest {
  roomCode: string;
  userId: string;
  on: boolean;
  via: 'manual' | 'reconnect' | 'abandon';
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** 各服务 → config-service：全量配置快照（片⑦ D1）。 */
export interface ConfigSnapshotRequest { meta?: RpcMeta }
/** `config.snapshot` 响应：每键 value+version；全局 version = MAX(每键)。 */
export interface ConfigSnapshotResponse { config: ConfigSnapshot; version: number }

/**
 * 记录片（规格 §2.2 / 设计 D2 逐字）：room → user 的 `record.write` 入参。
 *
 * ⚠️ **字段语义的都是「真源侧已解析」的形态**（room 组装时定）：
 *  - `seats[].userId`：人类 = 真 `Seat.userId`；**机器人座 = `null`**（绝不写 `displayId`）；
 *  - `seats[].isRobot`：真源 = room `Seat.isRobot`（**不是** game 信封的派生值）；
 *  - `seats[].robotId`：内部 botId（`room:{code}:bots` Hash 按**座位号**对齐读出），非 displayId；
 *  - `seats[].hand` / `bottomCards`：T1 codec 编码后的 **hex 串**（34 / 6 位；room 不重编码——
 *    信封已带串）。**在这里是 `string` 类型**：接收侧校验只按**长度**（34/6），
 *    完整合法性（包络内非法值）由 T1 的 codec 在**编码端**保证（`records.ts`）。
 *  - `seats[].nickname`：**仅机器人座**的展示昵称快照（room 从昵称 Hash 读取）；
 *    人类座必须省略 / `null` —— 人类昵称仍由接收侧按 `user_id` 查 `users`。
 *  - `result`：`SettlementResult` **全量原样**（写入侧只取其中若干列，见 DDL）。
 *  - `startedAt` / `endedAt`：epoch ms；`startedAt` = 会话创建时刻（自信封）、
 *    `endedAt` = room 收 `game.ended` 时刻。
 */
export interface RecordWriteRequest {
  roomCode: string;
  gameVersion: number;
  /** ② 金币场：`'gold'` 进记录面（战绩页金币列与 mode 中文映射都要靠它区分）。 */
  mode: 'random' | 'practice' | 'gold';
  baseScore: number;
  /** 多玩法：过渡期可选；缺失 = doudizhu/3。 */
  gameType?: GameType;
  playerCount?: number;
  result: SettlementResult;
  seats: Array<{
    seat: number;
    userId: string | null;
    isRobot: boolean;
    robotId: string | null;
    hand: string;
    /** 跑得快：本局实际打出的张数（关牌判定）；斗地主省略。 */
    playedCount?: number;
    /**
     * 仅机器人座：本局展示昵称快照（room 从 `room:{code}:nicknames` 读取）。
     * 人类座必须省略/null —— 人类昵称仍由 user-service 按 `user_id` 查 `users`。
     * `displayId` 仍绝不落库；本字段只是展示名。
     */
    nickname?: string | null;
  }>;
  /** 斗地主底牌编码（3 张 = 6 hex）；跑得快必须省略。 */
  bottomCards?: string;
  /** 跑得快 2 人局扣下的 16 张（32 hex，仅审计）；其他玩法省略。 */
  unusedCards?: string;
  startedAt: number;
  endedAt: number;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** `record.write` 响应：`written=false` = 幂等命中（非错误）。 */
export type RecordWriteResponse = RpcResult<{ written: boolean }>;

/** 昵称片：`user.nicknames.get` 入参。`userIds` 由调用方去重，最多 50 个。 */
export interface UserNicknamesGetRequest {
  userIds: string[];
}

/** 单个 userId 的昵称读结果；`null` = 用户不存在或没有昵称（都是合法事实）。 */
export interface UserNicknameEntry {
  userId: string;
  nickname: string | null;
}

/** 昵称片：`user.nicknames.get` 响应（`RpcResult` 信封，与 `record.write` 同形）。 */
export type UserNicknamesGetResponse = RpcResult<{ nicknames: UserNicknameEntry[] }>;

/**
 * 金币场（规格 §3 逐字）：room → user 的 `record.moneyDelta` 入参 —— 结算后 `money_delta`
 * 向量回写（**deltas = 三人语义向量、含 0**，零变动座写 0、不留 NULL）。
 *
 * 收敛语义（T5 消费）：`matched` **齐三座**才算完成；不足 ⇒ 留 `recordmoney:outbox` 重试
 * （record 行可能尚未落库——两写皆幂等、乱序无害）。
 */
export interface RecordMoneyDeltaRequest {
  /** 非空、≤16。 */
  roomCode: string;
  /** 正整数。 */
  gameVersion: number;
  /** 多玩法：过渡期可选；缺失 = doudizhu/3。 */
  gameType?: GameType;
  playerCount?: number;
  /** 座位升序；长度 = playerCount（旧 = 恰 3 条、座位 `{0,1,2}`）。 */
  deltas: Array<{ seat: number; delta: number }>;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/** `record.moneyDelta` 响应 data：命中的座位集合（升序）。 */
export interface RecordMoneyDeltaData { matched: number[] }

/** `record.moneyDelta` 响应。 */
export type RecordMoneyDeltaResponse = RpcResult<RecordMoneyDeltaData>;

/**
 * `record.moneyDelta` 载荷的**唯一校验点**（T2 定义、T7 消费；规格 §3 逐字）：
 * roomCode 非空 ≤16 / gameVersion 正整数 / `gameType`（可选，缺省 doudizhu）/
 * `playerCount`（可选，缺省 3，且必须在该玩法 `supportedPlayerCounts` 内）/
 * deltas **长度 = playerCount**、座位 `0..playerCount-1` 各一升序 /
 * delta 为整数（含 0）且 `|delta| ≤ 2^31−1`。非法 ⇒ 抛 `ProtocolError`（中文原因，
 * 与 `validateCurrencyApply` 同口径）——controller 侧翻成 `{ok:false, BAD_PARAM}`。
 *
 * 多玩法（Task 2.5 / H6）：旧请求（无两字段）语义与旧版逐字一致（恰 3 条、座位 0..2）。
 */
export function validateRecordMoneyDelta(req: unknown): void {
  if (typeof req !== 'object' || req === null || Array.isArray(req)) {
    throw new ProtocolError('record.moneyDelta 请求必须是对象');
  }
  const { roomCode, gameVersion, gameType, playerCount, deltas } = req as Record<string, unknown>;

  if (typeof roomCode !== 'string' || roomCode.length === 0 || roomCode.length > 16) {
    throw new ProtocolError(`roomCode 必须是 1..16 字符的非空字符串（收到 ${JSON.stringify(roomCode)}）`);
  }
  if (typeof gameVersion !== 'number' || !Number.isInteger(gameVersion) || gameVersion <= 0) {
    throw new ProtocolError(`gameVersion 必须是正整数（收到 ${JSON.stringify(gameVersion)}）`);
  }
  if (gameType !== undefined && !isGameType(gameType)) {
    throw new ProtocolError(
      `gameType 必须是 doudizhu | paodekuai（收到 ${JSON.stringify(gameType)}）`,
    );
  }
  const resolvedGameType: GameType = gameType === undefined ? 'doudizhu' : gameType;
  if (playerCount !== undefined && (typeof playerCount !== 'number' || !Number.isInteger(playerCount))) {
    throw new ProtocolError(`playerCount 必须是整数（收到 ${JSON.stringify(playerCount)}）`);
  }
  const expected = playerCount === undefined ? 3 : (playerCount as number);
  if (!supportsPlayerCount(resolvedGameType, expected)) {
    throw new ProtocolError(
      `playerCount ${expected} 不在玩法 ${resolvedGameType} 的 supportedPlayerCounts 内`,
    );
  }
  if (!Array.isArray(deltas) || deltas.length !== expected) {
    throw new ProtocolError(
      `deltas 必须是恰 ${expected} 条的数组、座位升序（收到 ${Array.isArray(deltas) ? `${deltas.length} 条` : JSON.stringify(deltas)}）`,
    );
  }
  for (let i = 0; i < deltas.length; i++) {
    const entry: unknown = deltas[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProtocolError(`deltas[${i}] 必须是 { seat, delta } 对象`);
    }
    const { seat, delta } = entry as Record<string, unknown>;
    // 「长度 = playerCount、座位 0..playerCount-1 各一、升序」⇔ 第 i 条的 seat === i。
    if (seat !== i) {
      throw new ProtocolError(
        `deltas[${i}].seat must be ${i}（长度 = playerCount、座位 0..${expected - 1} 各一、升序；收到 ${JSON.stringify(seat)}）`,
      );
    }
    if (typeof delta !== 'number' || !Number.isInteger(delta) || Math.abs(delta) > 2_147_483_647) {
      throw new ProtocolError(
        `deltas[${i}].delta 必须是整数（含 0）且 |delta| ≤ 2147483647（收到 ${JSON.stringify(delta)}）`,
      );
    }
  }
}

/**
 * 风控片（规格 §2.1-4 / 设计 D3）：room → user 的 `risk.deviceReport` 入参 ——
 * **匹配入队成功后**一次 fire-and-forget 的 deviceId 上报（K3：deviceId 原文入库；
 * 玩家面永不出站）。
 *
 * ⚠️ **无校验函数**（对比 `validateRecordMoneyDelta`）：接收侧（T4 的
 * `device-report.rpc.controller.ts`）只做形状级校验（两字段非空 string、deviceId ≤64），
 * 不做 charset 级复检 —— 值域纪律由发送侧（room `room.match` 的 protocol 校验，
 * C13）+ 客户端生成形态（⚙️16）承担；这里是**威慑级采集**（设计登记），不是强控。
 */
export interface RiskDeviceReportRequest {
  /** 上报者的 `users.id`（不存在 ⇒ 接收侧回 `{ok:false, code:'BAD_PARAM'}`）。 */
  userId: string;
  /** 客户端生成的设备指纹（≤64；原文入库，仅管理面可见）。 */
  deviceId: string;
  /** R1104/R1105：RPC 元数据（ALS 里有 traceId 时**才出现**；§15.3 的 id 过这一跳的载体）。 */
  meta?: RpcMeta;
}

/**
 * `risk.deviceReport` 响应（规格 §2.1-4 **逐字**）：**不是** `RpcResult` 信封 ——
 * 无 `data`/`message`，`{ ok:true } | { ok:false; code:string }`。失败码命名沿用
 * `record.write` 先例（`BAD_PARAM`）；调用方（room）fire-and-forget，失败只留 warn 一行的
 * ⚙️21 语义 ⇒ 这里不挂可重试的传输级错误面。
 */
export type RiskDeviceReportResponse = { ok: true } | { ok: false; code: string };
