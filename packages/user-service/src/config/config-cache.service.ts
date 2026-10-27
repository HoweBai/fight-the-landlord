// packages/user-service/src/config/config-cache.service.ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ConfigKey, ConfigSnapshot } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { ConfigClient } from './config.client';

/**
 * config-service 写入后广播的频道（**值经 design/spec 钉死**；发布侧 = config-service 的
 * `CONFIG_CHANGED_CHANNEL`——同一个字面量在两侧各定义一次，因为服务之间不互相 import。
 * `config-cache.test.ts` 有一条「频道名逐字」把本侧钉住；两侧一致性由机制层层兜底：
 * 丢一条通知的后果被安全网（≤60s）压住，见 design D2 与 D5）。
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/**
 * `record.retentionDays` 的**代码默认值**（= 种子 = 迁移种子值 365；缺失/非法 ⇒ 取这里的值）。
 * ⚠️ 与 `docs/superpowers/specs/2026-10-03-records-spec.md` §2.4 的种子（365）、
 * config-service 种子迁移（`1789500000000-RecordRetention`）逐值同源。
 */
export const RETENTION_DAYS_DEFAULT = 365;

/** 快照值的合法范围（规格 §2.4 的写死校验：`parseConfigValue` 同口径）。 */
const RETENTION_DAYS_MIN = 1;
const RETENTION_DAYS_MAX = 3650;

// ─── 节奏/清理三键的 user 侧常数（本片 T4；第 38–40 键；默认值 = 种子 ⚙️1）───────────
// 合法界照 `protocol/src/config.ts` 的 `parseIntervalMs`：int 毫秒、`1 ≤ n ≤ 10× 默认`。
// ⚠️ 本文件是这些常数的**唯一真源**（旧处 = 三循环文件：`records/records-cleanup.service.ts`
// / `risk/scan.service.ts` / `risk/devices-cleanup.service.ts`；T5–T7 改 re-export 保引用名）。

/** `risk.scanIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 36000000）。 */
const RISK_SCAN_INTERVAL_MIN = 1;
const RISK_SCAN_INTERVAL_MAX = 36_000_000;
/** `risk.scanIntervalMs` 的**代码默认值**（= 种子 = 第 38 键：1h；缺失/坏值 ⇒ 取此值）。 */
export const RISK_SCAN_DEFAULT_INTERVAL_MS = 3_600_000;

/** `risk.devicesCleanupIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 36000000）。 */
const RISK_DEVICES_CLEANUP_INTERVAL_MIN = 1;
const RISK_DEVICES_CLEANUP_INTERVAL_MAX = 36_000_000;
/** `risk.devicesCleanupIntervalMs` 的**代码默认值**（= 种子 = 第 39 键：1h；缺失/坏值 ⇒ 取此值）。 */
export const RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS = 3_600_000;

/** `record.cleanupIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 36000000）。 */
const RECORDS_CLEANUP_INTERVAL_MIN = 1;
const RECORDS_CLEANUP_INTERVAL_MAX = 36_000_000;
/** `record.cleanupIntervalMs` 的**代码默认值**（= 种子 = 第 40 键：1h；缺失/坏值 ⇒ 取此值）。 */
export const RECORDS_CLEANUP_DEFAULT_INTERVAL_MS = 3_600_000;

/**
 * 六循环「首排动作」的**有界等待**（本片 D2；`onModuleInit` 时快照未就绪 ⇒
 * `race(首快照, 本常数)`，超时按缺省解析先排期，下一轮重排自愈）。
 * ⚠️ **三份克隆同值**（user / payment / currency 三服务各自的 `config/config-cache.service.ts`；
 * R96 同源纪律——「同一事实两处实现」须同源同步，改一份必须三份同改）。
 */
export const SNAPSHOT_BOOT_WAIT_MS = 10_000;

/**
 * `currency.signupGrant` 的**代码默认值**（= 规格 §2.8 的种子 **0**；缺失/非法 ⇒ 取这里的值）。
 * ⚠️ 0 不是「随便一个安全值」——它的语义是**注册链路完全绕开货币服务**（§2.7 步骤 3）：
 * 绝不让坏值/缺失变成一次真实发币。
 */
export const SIGNUP_GRANT_DEFAULT = 0;

/** 快照值的合法范围（规格 §2.8 的写死校验：int、`0 ≤ n ≤ 1,000,000`；`parseConfigValue` 同口径）。 */
const SIGNUP_GRANT_MIN = 0;
const SIGNUP_GRANT_MAX = 1_000_000;

/**
 * 风控六键的**代码默认值**（= 种子值；风控片 T4 / 规格 §2.1-3 第 20–25 键；缺失/坏值 ⇒
 * 取这里的值）。与 config-service 种子迁移（`1790000001000-RiskConfigSeed`）逐值同源。
 * ⚠️ `RISK_AUTO_THROTTLE_DEFAULT=true` 的语义 = 命中 50 分线**自动**限流（安全侧）；
 * 坏值回落 true 与种子一致（关它要显式改配置）。
 */
export const RISK_WIN_RATE_THRESHOLD_DEFAULT = 0.8;
export const RISK_MIN_GAMES_DEFAULT = 100;
export const RISK_DEVICE_LIMIT_DEFAULT = 3;
export const RISK_DEVICE_WINDOW_DAYS_DEFAULT = 30;
export const RISK_AUTO_THROTTLE_DEFAULT = true;
export const RISK_DEVICE_RETENTION_DAYS_DEFAULT = 365;
/** PDK 单玩法自动限流阈值的代码默认值（= 种子 50；缺失/非法 ⇒ 50）。 */
export const RISK_PDK_AUTO_THROTTLE_SCORE_DEFAULT = 50;

/** 风控六键的写死范围（规格 §2.1-3 表；`parseConfigValue` 同口径——两位小数逐字同式）。 */
const RISK_WIN_RATE_THRESHOLD_MIN = 0.5;
const RISK_WIN_RATE_THRESHOLD_MAX = 1;
const RISK_MIN_GAMES_MIN = 1;
const RISK_MIN_GAMES_MAX = 100_000;
const RISK_DEVICE_LIMIT_MIN = 2;
const RISK_DEVICE_LIMIT_MAX = 100;
const RISK_DEVICE_WINDOW_DAYS_MIN = 1;
const RISK_DEVICE_WINDOW_DAYS_MAX = 365;
const RISK_DEVICE_RETENTION_DAYS_MIN = 1;
const RISK_DEVICE_RETENTION_DAYS_MAX = 3_650;
/** PDK 自动限流阈值的合法范围（分数只有 25/50；26–49 与 50 同效）。 */
const RISK_PDK_AUTO_THROTTLE_SCORE_MIN = 25;
const RISK_PDK_AUTO_THROTTLE_SCORE_MAX = 50;

/** 跑得快按人数风控键（2/3/4；旧 PDK 两键为缺失时的回退）。 */
const PLAYER_WIN_RATE_KEYS: Record<2 | 3 | 4, ConfigKey> = {
  2: 'game.paodekuai.risk.player2.winRateThreshold',
  3: 'game.paodekuai.risk.player3.winRateThreshold',
  4: 'game.paodekuai.risk.player4.winRateThreshold',
};
const PLAYER_MIN_GAMES_KEYS: Record<2 | 3 | 4, ConfigKey> = {
  2: 'game.paodekuai.risk.player2.minGames',
  3: 'game.paodekuai.risk.player3.minGames',
  4: 'game.paodekuai.risk.player4.minGames',
};

/** 启动拉取失败后的重试间隔（design D2：**1s 退避重试直到首次成功**、不阻塞就绪）。 */
const STARTUP_RETRY_INTERVAL_MS = 1_000;

/**
 * user-service 的**配置快照缓存**（记录片 T7 / 设计 D5 —— 克隆 room 模板的第三份，
 * 前两份 = room（片⑦ T6）/ robot（片⑦ T8））。
 *
 * ─── 行为（三件）────────────────────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到首次成功**
 *     （`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，错序窗口由
 *     重试 + 安全网自愈；compose 刻意不给消费服务加 `depends_on` 硬门）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用 `RedisModule` 的实例）；
 *     收到通知 ⇒ 重拉**全量**换缓存（不做增量；版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（design D5 / 规格 §2.4）────────────────────────────────────
 *  「拿不到」= 缓存为空，且一次即时拉取也失败时，`retentionDays()` 一律回落**代码默认值
 *  365**（保留期是「热项」：配置中心挂了**不得**停止清理循环——365 是安全的保守取值）。
 *  缓存非空（哪怕旧）一律用缓存。
 *  ⚠️ 货币片 T6 的第二条读面 `signupGrant()`（§2.8）同口径回落 **0**（0 ⇒ 注册链路
 *  **完全绕开**货币服务，§2.7——读不到赠送金额时宁可「不发」，绝不猜一个数去发币）。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose 不设）────────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
 *  ⚠️ 与 room/robot 侧**同名同口径**（同构克隆的既有形态；生产不设 ⇒ 三服务各自走默认）。
 *
 * ─── 日志分源（R1107；T6 审查 Important-1 的同构落地）────────────────────────
 *  **不新造 source 值**（`TRACE_SOURCES` 恰好五个）—— 按触发者分到**既有值**：
 *   - **定时器起的一轮**（启动 1s 退避循环的每一次尝试，含首拉 + 60s 安全网的一轮）
 *     ⇒ `{traceId: randomUUID(), source: 'timer'}`；
 *   - **订阅回调 / ioredis 错误**（内部事件，无客户端请求）⇒ `{traceId: null, source: 'internal'}`
 *     —— 处理器内部**再包一次**（ioredis 回调不继承 ALS）；
 *   - 请求驱动的即时拉**不包**：承接调用方的 ALS/来源（本服务目前没有这条路径，纪律照留）。
 *  ⚠️ `bootstrap`（「进程启动早期」）**不得当兜底用**。
 *
 * ─── 关停闸（T6 审查 Important-2 的同构落地）────────────────────────────────
 *  `onApplicationShutdown` **第一行**置位；两条自重排链（退避重试 / 安全网）在**排下一个
 *  定时器之前**查它 —— 关停发生在「一轮在途」期间时，迟到的回执不得再排新定时器
 *  （否则 `clearTimeout` 只清得住**已存在**的那一个，循环会在关停后「复活」）。
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
  /** 首次成功快照的等待者（`waitForFirstSnapshot()`：首排动作的有界等待消费，测试/生产共用）。 */
  private firstSnapshotResolvers: Array<() => void> = [];
  /** 空缓存窗口内拉失败只 WARN 一次（下一次成功拉取后复位）—— 防 1s 重试刷屏。 */
  private warnedWhileEmpty = false;
  /** 关停闸（见类注）：在途一轮的迟到回执据此**不再排新定时器**。 */
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

  /**
   * 对局记录保留天数（记录片规格 §2.4：int、`1 ≤ n ≤ 3650`、种子 365）。
   * 缺失 / 类型漂移 / 越界 ⇒ **代码默认值 365**（绝不把坏值透传进清理 cutoff）。
   *
   * ⚠️ 消费方（`RecordsCleanupService`）在**每一轮开始时**重读本方法 ⇒ 「改了下一轮生效」
   * （当前一轮按旧值跑完）。
   */
  retentionDays(): number {
    const value = this.snapshot?.['record.retentionDays']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RETENTION_DAYS_MIN &&
      value <= RETENTION_DAYS_MAX
      ? value
      : RETENTION_DAYS_DEFAULT;
  }

  /**
   * 注册赠送金币数（货币片 T6 / 规格 §2.8：第 11 键 `currency.signupGrant`，
   * int、`0 ≤ n ≤ 1,000,000`、种子/缺省 **0**）。
   *
   * 缺失 / 类型漂移 / 越界 ⇒ **0**（与 `retentionDays()` 同形的防御读法；绝不放行坏值
   * 触发发币）。消费方（`AuthService.register`）在**每次注册开始时**读一次并随
   * `currency.apply` 固化 —— J5 的快照语义：此后改配置**只影响新注册用户**。
   */
  signupGrant(): number {
    const value = this.snapshot?.['currency.signupGrant']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= SIGNUP_GRANT_MIN &&
      value <= SIGNUP_GRANT_MAX
      ? value
      : SIGNUP_GRANT_DEFAULT;
  }

  /** 是否已成功拉到过一次快照（照 payment 同款；本片 ⚙️5 快路径消费）。 */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /** 首次快照就位的等待：六循环首排动作（⚙️5）的**有界等待消费**（测试/生产共用 —— 生产侧 = `bootFirstScheduling()` 的就绪路 race）。 */
  waitForFirstSnapshot(): Promise<void> {
    if (this.snapshot !== null) return Promise.resolve();
    return new Promise((resolve) => {
      this.firstSnapshotResolvers.push(resolve);
    });
  }

  // ─── 风控六键（风控片 T4 / 规格 §2.1-3 第 20–25 键；C15 getter 半边）───────────────
  // 读法逐字照 retentionDays()/signupGrant()：**缺失 / 类型漂移 / 越界 ⇒ 代码默认值**
  // （= 种子值）——绝不把坏值透传进判定/清理面。消费方在**每轮/每次用时**重读本组方法
  // ⇒「改了下一轮生效」（当前一轮按旧值跑完）。范围与 `parseConfigValue` 逐值同口径。

  /** 平行化（2026-10-24）：新键存在性优先，缺失回退旧键（null-safe）。 */
  private hasSnapshotKey(key: ConfigKey): boolean {
    return this.snapshot !== null && Object.hasOwn(this.snapshot, key);
  }

  private readWithLegacy(newKey: ConfigKey, legacyKey: ConfigKey): unknown {
    if (this.hasSnapshotKey(newKey)) return this.snapshot![newKey]?.value;
    return this.snapshot?.[legacyKey]?.value;
  }

  /** 胜率阈值归一（`parseWinRateThreshold` 同口径）；非法 ⇒ 代码默认。 */
  private normalizeWinRate(value: unknown): number {
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= RISK_WIN_RATE_THRESHOLD_MIN &&
      value <= RISK_WIN_RATE_THRESHOLD_MAX &&
      Math.round(value * 100) / 100 === value
      ? value
      : RISK_WIN_RATE_THRESHOLD_DEFAULT;
  }

  /** 最少局数归一（`parseMinGames` 同口径）；非法 ⇒ 代码默认。 */
  private normalizeMinGames(value: unknown): number {
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_MIN_GAMES_MIN &&
      value <= RISK_MIN_GAMES_MAX
      ? value
      : RISK_MIN_GAMES_DEFAULT;
  }

  /**
   * 胜率扫描阈值（第 20 键，种子 0.8；`0.5 ≤ n ≤ 1.0`、≤2 位小数 —— 两位小数口径与
   * `parseWinRateThreshold` 同式：`Math.round(n*100)/100 === n`）。消费方 = T5 扫描 hit1。
   */
  riskWinRateThreshold(): number {
    return this.normalizeWinRate(
      this.readWithLegacy(
        'game.doudizhu.risk.winRateThreshold',
        'risk.winRateThreshold',
      ),
    );
  }

  /** 扫描最少局数（第 21 键，种子 100；int、`1 ≤ n ≤ 100000`）。命中口径 = `games > minGames`（T5）。 */
  riskMinGames(): number {
    return this.normalizeMinGames(
      this.readWithLegacy('game.doudizhu.risk.minGames', 'risk.minGames'),
    );
  }

  /**
   * 跑得快胜率阈值（2026-10-25，种子 0.8）。
   * 读顺序：`game.paodekuai.risk.winRateThreshold` **存在** ⇒ 校验后使用；
   * 存在但非法 ⇒ 代码默认（**不回退斗地主**）；缺失 ⇒ 斗地主 getter（新键 → 旧键 → 默认）。
   */
  riskPaodekuaiWinRateThreshold(): number {
    const key = 'game.paodekuai.risk.winRateThreshold';
    return this.hasSnapshotKey(key)
      ? this.normalizeWinRate(this.snapshot![key]?.value)
      : this.riskWinRateThreshold();
  }

  /**
   * 跑得快扫描最少局数（2026-10-25，种子 100）。回退语义同
   * `riskPaodekuaiWinRateThreshold()`；存在但非法 ⇒ 代码默认。
   */
  riskPaodekuaiMinGames(): number {
    const key = 'game.paodekuai.risk.minGames';
    return this.hasSnapshotKey(key)
      ? this.normalizeMinGames(this.snapshot![key]?.value)
      : this.riskMinGames();
  }

  /**
   * 跑得快按人数胜率阈值（2026-10-26，种子 0.8）。
   * 读顺序：`playerN.winRateThreshold` 存在 ⇒ 校验后使用（非法 ⇒ 代码默认，**不回退**）；
   * 缺失 ⇒ `riskPaodekuaiWinRateThreshold()`（旧 PDK → DDZ 新键 → DDZ 旧键 → 默认）。
   */
  riskPaodekuaiPlayerWinRateThreshold(playerCount: 2 | 3 | 4): number {
    const key = PLAYER_WIN_RATE_KEYS[playerCount];
    return this.hasSnapshotKey(key)
      ? this.normalizeWinRate(this.snapshot![key]?.value)
      : this.riskPaodekuaiWinRateThreshold();
  }

  /**
   * 跑得快按人数最少局数（2026-10-26，种子 100）。回退语义同
   * `riskPaodekuaiPlayerWinRateThreshold()`。
   */
  riskPaodekuaiPlayerMinGames(playerCount: 2 | 3 | 4): number {
    const key = PLAYER_MIN_GAMES_KEYS[playerCount];
    return this.hasSnapshotKey(key)
      ? this.normalizeMinGames(this.snapshot![key]?.value)
      : this.riskPaodekuaiMinGames();
  }

  /**
   * PDK 单玩法自动限流阈值（2026-10-26；int 25–50，种子 50）。
   * 25 = PDK-only 25 分即自动限流；26–50 = 不自动限流（PDK+设备 50 分仍限流）。
   * 缺失/非法 ⇒ 50（== 账号级线，语义为“关闭 PDK 单命中自动限流”）。
   */
  riskPaodekuaiAutoThrottleScore(): number {
    const value = this.snapshot?.['game.paodekuai.risk.autoThrottleScore']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_PDK_AUTO_THROTTLE_SCORE_MIN &&
      value <= RISK_PDK_AUTO_THROTTLE_SCORE_MAX
      ? value
      : RISK_PDK_AUTO_THROTTLE_SCORE_DEFAULT;
  }

  /** 单设备关联账号上限（第 22 键，种子 3；int、`2 ≤ n ≤ 100`）。消费方 = T5 扫描 hit2。 */
  riskDeviceLimit(): number {
    const value = this.snapshot?.['risk.deviceLimit']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_DEVICE_LIMIT_MIN &&
      value <= RISK_DEVICE_LIMIT_MAX
      ? value
      : RISK_DEVICE_LIMIT_DEFAULT;
  }

  /** 设备扫描窗口天数（第 23 键，种子 30；int、`1 ≤ n ≤ 365`）。消费方 = T5 扫描 SQL2 的 `?`。 */
  riskDeviceWindowDays(): number {
    const value = this.snapshot?.['risk.deviceWindowDays']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_DEVICE_WINDOW_DAYS_MIN &&
      value <= RISK_DEVICE_WINDOW_DAYS_MAX
      ? value
      : RISK_DEVICE_WINDOW_DAYS_DEFAULT;
  }

  /**
   * 命中自动限流开关（第 24 键，种子 true；**严格 boolean**）。
   * 缺失 / 类型漂移 ⇒ **true**（= 种子 = 安全侧：命中 50 分线自动限流；关它要显式配置）。
   */
  riskAutoThrottle(): boolean {
    const value = this.snapshot?.['risk.autoThrottle']?.value;
    return typeof value === 'boolean' ? value : RISK_AUTO_THROTTLE_DEFAULT;
  }

  /**
   * 设备绑定总开关（设备绑定片第 49 键 `risk.deviceBindingEnabled`，种子 **false**；
   * 严格 boolean）。
   * 缺失 / 类型漂移 / 快照整体不可用 ⇒ **false**（暗上线口径：登录/WS 两条绑定闸整体
   * 短路，行为与今天逐字节一致——这是「会把人挡在门外」的安全功能，配置面不确定时
   * 不得启用）。消费方 = `AuthService`（登录/注册/refresh）；网关侧另由 config 快照
   * 经 RPC 读同键（WS 握手闸）。
   */
  deviceBindingEnabled(): boolean {
    return this.snapshot?.['risk.deviceBindingEnabled']?.value === true;
  }

  /**
   * 设备记录保留天数（第 25 键，种子 365；int、`1 ≤ n ≤ 3650`）。
   * 消费方（`DevicesCleanupService`）在**每一轮开始时**重读本方法 ⇒「改了下一轮生效」。
   */
  riskDeviceRetentionDays(): number {
    const value = this.snapshot?.['risk.deviceRetentionDays']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_DEVICE_RETENTION_DAYS_MIN &&
      value <= RISK_DEVICE_RETENTION_DAYS_MAX
      ? value
      : RISK_DEVICE_RETENTION_DAYS_DEFAULT;
  }

  // ─── 节奏/清理三键（本片 T4；规格 ⚙️4；第 38–40 键）───────────────────────────
  // 读法逐字照 retentionDays()：缺失 / 类型漂移 / 越界 ⇒ 代码默认常数（= 种子值）。
  // 🔴 janitor fail-safe（设计 D3）：**快照整体不可用同样回落**——与钱面 fail-closed
  // 刻意分层（「不确定不停扫」vs「不确定不放松钱」）。消费方在**重排处现读**本组方法
  // ⇒「改了下一轮生效」（当前一轮按旧值跑完）。

  /**
   * 风控扫描周期（第 38 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 1h。
   * 消费方 = `risk/scan.service.ts`（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  riskScanIntervalMs(): number {
    const value = this.snapshot?.['risk.scanIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_SCAN_INTERVAL_MIN &&
      value <= RISK_SCAN_INTERVAL_MAX
      ? value
      : RISK_SCAN_DEFAULT_INTERVAL_MS;
  }

  /**
   * 设备记录清理周期（第 39 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 1h。
   * 消费方 = `risk/devices-cleanup.service.ts`（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  devicesCleanupIntervalMs(): number {
    const value = this.snapshot?.['risk.devicesCleanupIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RISK_DEVICES_CLEANUP_INTERVAL_MIN &&
      value <= RISK_DEVICES_CLEANUP_INTERVAL_MAX
      ? value
      : RISK_DEVICES_CLEANUP_DEFAULT_INTERVAL_MS;
  }

  /**
   * 保留期清理周期（第 40 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 1h。
   * 消费方 = `records/records-cleanup.service.ts`（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  recordsCleanupIntervalMs(): number {
    const value = this.snapshot?.['record.cleanupIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RECORDS_CLEANUP_INTERVAL_MIN &&
      value <= RECORDS_CLEANUP_INTERVAL_MAX
      ? value
      : RECORDS_CLEANUP_DEFAULT_INTERVAL_MS;
  }

  // ─── 内部：拉取 / 订阅 / 定时器 ────────────────────────────────────────

  /**
   * 启动期拉取：失败 ⇒ 1s 后重试，**直到首次成功为止**（其后由通知/安全网驱动）。
   *
   * ⚠️ 用 `.then(onOk, onErr)` 二参形态（不是 `.catch().finally()` 链）—— 保证
   * 「重试调度」只挂在失败支路上，成功支路不会误排一个新定时器。
   *
   * 日志分源（R1107）：退避循环的**每一次尝试**（含首拉）都是「定时器起的一轮」
   * ⇒ `{traceId: randomUUID(), source: 'timer'}`。
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

  /** 拉全量快照并**整体换缓存**（成功路径：通知/安全网/启动重试共用）。 */
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
      `config snapshot applied (version=${res.version}, retentionDays=${this.retentionDays()})`,
    );
    if (this.firstSnapshotResolvers.length > 0) {
      const resolvers = this.firstSnapshotResolvers;
      this.firstSnapshotResolvers = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /**
   * 拉取失败的统一留痕（不透传 ≠ 不留痕）：
   *  - **空缓存**（=「拿不到」）⇒ WARN **一次**（1s 重试不再刷屏；成功拉取后复位）；
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
   * 🔴 **专用连接**：ioredis 进入 subscribe 模式后该连接**不能再发普通命令**
   * ⇒ 必须独立 `new Redis(...)`，不得复用 `RedisModule` 的实例。
   * `CONFIG_SYNC_DISABLE_PUSH` 非空时本方法**根本不会被调用**（连接都不会建）。
   *
   * 日志分源（R1107）：订阅面是**内部事件**（没有对应的客户端请求）⇒
   * `{traceId: null, source: 'internal'}`。
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
          // 订阅失败不致命：安全网仍会把最坏情况压到 ≤60s（最后一道）。
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
}
