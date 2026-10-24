// packages/payment-service/src/config/config-cache.service.ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ConfigSnapshot } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { ConfigClient } from './config.client';

/**
 * config-service 写入后广播的频道（**值经 design/spec 钉死**；发布侧 = config-service 的
 * `CONFIG_CHANGED_CHANNEL`——同一个字面量在两侧各定义一次，因为服务之间不互相 import。
 * 两侧一致性由机制层层兜底：丢一条通知的后果被安全网（≤60s）压住，见 design D2）。
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/** 启动拉取失败后的重试间隔（design D2：**1s 退避重试直到首次成功**、不阻塞就绪）。 */
const STARTUP_RETRY_INTERVAL_MS = 1_000;

/**
 * `pay.rechargeEnabled` 的**代码默认值**（= 种子 = 支付片规格 §2.5 第 26 键：`false`；
 * 缺失/非法 ⇒ 取此值）。false 的语义是**安全方向**：说不清 ⇒ 充值不开（暗上线形态，
 * P5 裁决「开关默认关」——与 `pay.withdrawEnabled` 同向）。
 */
export const RECHARGE_ENABLED_DEFAULT = false;

/**
 * `pay.withdrawEnabled` 的**代码默认值**（= 种子 = 第 27 键：`false`；T10 消费面）。
 * false 的语义同第 26 键：说不清 ⇒ 提现不开（**只挡新建**——在途照常审/确认/回滚，§5.3）。
 */
export const WITHDRAW_ENABLED_DEFAULT = false;

/** `pay.withdrawMinCoins` 的**代码默认值**（= 种子 = 第 30 键：`1000`——10 元等值门槛）。 */
export const WITHDRAW_MIN_COINS_DEFAULT = 1000;

/** `pay.withdrawMaxCoinsPerOrder` 的**代码默认值**（= 种子 = 第 31 键：`50000`——500 元等值）。 */
export const WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT = 50_000;

/** `pay.withdrawDailyMaxCoins` 的**代码默认值**（= 种子 = 第 32 键：`100000`——1000 元等值/人/日）。 */
export const WITHDRAW_DAILY_MAX_COINS_DEFAULT = 100_000;

/** `pay.withdrawTimeoutMinutes` 的**代码默认值**（= 种子 = 第 34 键：`4320`——72h 超时回滚）。 */
export const WITHDRAW_TIMEOUT_MINUTES_DEFAULT = 4320;

/**
 * 提现金币三键的合法范围（照 `protocol/src/config.ts` 的 `parsePayCoins`：int、
 * `1 ≤ n ≤ 1,000,000`——与第 28 键同族；越界回落代码默认，同 `coinPerYuan` 口径）。
 */
const WITHDRAW_COINS_MIN = 1;
const WITHDRAW_COINS_MAX = 1_000_000;

/**
 * `pay.withdrawTimeoutMinutes` 的合法范围（照 `parsePayMinutes`：int、`1 ≤ n ≤ 10080`；
 * 测试注入用 1 在域内）。
 */
const WITHDRAW_TIMEOUT_MINUTES_MIN = 1;
const WITHDRAW_TIMEOUT_MINUTES_MAX = 10_080;

/** `pay.coinPerYuan` 的**代码默认值**（= 种子 = 第 28 键：`100`）。下单快照的比率来源。 */
export const COIN_PER_YUAN_DEFAULT = 100;

/** `pay.coinPerYuan` 的合法范围（照 `protocol/src/config.ts` 的 `parsePayCoins`：int、`1 ≤ n ≤ 1,000,000`）。 */
const COIN_PER_YUAN_MIN = 1;
const COIN_PER_YUAN_MAX = 1_000_000;

/**
 * `pay.rechargePackages` 的**代码默认值**（= 种子 = 第 29 键：`[6,30,68,128,328]`；
 * 缺失/非法 ⇒ 取此值）。⚠️ 消费面（下单档位校验）拿到的是**拷贝**——防调用方改坏常量。
 */
export const RECHARGE_PACKAGES_DEFAULT: readonly number[] = [6, 30, 68, 128, 328];

/** 档位每项上界（照 `parseRechargePackages`：正整数、`≤ 9,999,999`——⚙️5 元 1–7 位形态）。 */
const RECHARGE_PACKAGE_ITEM_MAX = 9_999_999;

/** `pay.orderExpireMinutes` 的**代码默认值**（= 种子 = 第 33 键：`30`）。 */
export const ORDER_EXPIRE_MINUTES_DEFAULT = 30;

/** `pay.orderExpireMinutes` 的合法范围（照 `parsePayMinutes`：int、`1 ≤ n ≤ 10080`——一周）。 */
const ORDER_EXPIRE_MINUTES_MIN = 1;
const ORDER_EXPIRE_MINUTES_MAX = 10_080;

// ─── 节奏/清理二键的 payment 侧常数（本片 T4；第 35–36 键；默认值 = 种子 ⚙️1）─────────
// 合法界照 `protocol/src/config.ts` 的 `parseIntervalMs`：int 毫秒、`1 ≤ n ≤ 10× 默认`。
// ⚠️ 本文件是这些常数的**唯一真源**（旧处 = `scan/scan.service.ts`；T9 改 re-export 保引用名）。

/** `pay.scanIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 600000）。 */
const PAY_SCAN_INTERVAL_MIN = 1;
const PAY_SCAN_INTERVAL_MAX = 600_000;
/** `pay.scanIntervalMs` 的**代码默认值**（= 种子 = 第 35 键：60s；缺失/坏值 ⇒ 取此值）。 */
export const PAY_SCAN_DEFAULT_INTERVAL_MS = 60_000;

/** `pay.reconcileIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 864000000）。 */
const PAY_RECONCILE_INTERVAL_MIN = 1;
const PAY_RECONCILE_INTERVAL_MAX = 864_000_000;
/** `pay.reconcileIntervalMs` 的**代码默认值**（= 种子 = 第 36 键：24h；缺失/坏值 ⇒ 取此值）。 */
export const PAY_RECONCILE_DEFAULT_INTERVAL_MS = 86_400_000;

/**
 * 六循环「首排动作」的**有界等待**（本片 D2；`onModuleInit` 时快照未就绪 ⇒
 * `race(首快照, 本常数)`，超时按缺省解析先排期，下一轮重排自愈）。
 * ⚠️ **三份克隆同值**（user / payment / currency 三服务各自的 `config/config-cache.service.ts`；
 * R96 同源纪律——「同一事实两处实现」须同源同步，改一份必须三份同改）。
 */
export const SNAPSHOT_BOOT_WAIT_MS = 10_000;

/**
 * payment-service 的**配置快照缓存**（支付片 T2 骨架；机制逐条克隆 room/robot/user/currency
 * 四模板的第五份 —— 键级 getter 随各消费面（T5 的 26–34 键 / T6 渠道开关）逐个落地，
 * 本骨架只交付机制本身 + `hasSnapshot()`；**T7 起已落四枚**：
 * `rechargeEnabled/coinPerYuan/rechargePackages/orderExpireMinutes`（下单链消费面）；
 * **T10 补五枚**：`withdrawEnabled/withdrawMinCoins/withdrawMaxCoinsPerOrder/
 * withdrawDailyMaxCoins/withdrawTimeoutMinutes`（提现链消费面）——缺省一律照 §2.5 种子。
 *
 * ─── 行为（三件）────────────────────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到
 *     首次成功**（`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，
 *     错序窗口由重试 + 安全网自愈）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用任何共享连接）；
 *     收到通知 ⇒ 重拉**全量**换缓存（不做增量；版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（分层，同四模板）───────────────────────────────────────────
 *  「拿不到」= 缓存为空，且一次即时拉取也失败；缓存非空（哪怕旧）一律用缓存。
 *  键级缺省（缺失/类型漂移/越界）由**各消费面**用代码默认值回落 —— 本骨架期快照尚无
 *  消费键（T5 起才有），因此只暴露 `hasSnapshot()`：**整个快照拿不到**（从未拉到）
 *  = false —— 消费面据此 **fail-closed 拒**（不确定不放松），默认值只覆盖
 *  「键缺失/坏值」、**不**覆盖「读不到配置」。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose 不设）────────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
 *  ⚠️ 与 room/robot/user/currency 侧**同名同口径**（同构克隆的既有形态；生产不设 ⇒ 五服务
 *  各自走默认）。
 *
 * ─── 日志分源（R1107）────────────────────────────────────────────────────
 *  **不新造 source 值**（`TRACE_SOURCES` 恰好五个）—— 按触发者分到**既有值**：
 *   - **定时器起的一轮**（启动 1s 退避循环的每一次尝试，含首拉 + 60s 安全网的一轮）
 *     ⇒ `{traceId: randomUUID(), source: 'timer'}`；
 *   - **订阅回调 / ioredis 错误**（内部事件，无客户端请求）⇒ `{traceId: null, source: 'internal'}`
 *     —— 处理器内部**再包一次**（ioredis 回调不继承 ALS）；
 *   - 请求驱动的即时拉**不包**：承接调用方的 ALS/来源（本服务目前没有这条路径，纪律照留）。
 *  ⚠️ `bootstrap`（「进程启动早期」）**不得当兜底用**。
 *
 * ─── 关停闸 ──────────────────────────────────────────────────────────────
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
    // 🔴 第一行置闸：在途一轮的迟到回执/`.finally` 据此**不再排新定时器**。
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
   * 是否已成功拉到过一次快照（「拿不到」的判别面）。
   *
   * 🔴 消费面在开始裁决**之前**查它：false ⇒ **fail-closed 拒**（不默认放行）。
   * 键级代码默认值只覆盖「键缺失/坏值」这一层 —— 「从未拉到配置」是更高一层的失败，
   * 不许被默认值吞掉。
   */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /* ─── 键级 getters（T7 起；缺省照种子——「键缺失/坏值」层的回落，见类注）───── */

  /**
   * 充值开关（支付片 §2.5 第 26 键）。缺失/非 boolean ⇒ **false**（说不清 ⇒ 不开）。
   * 消费面：`OrdersService.createOrder` 的 15008 闸（**只挡新建单**）。
   */
  rechargeEnabled(): boolean {
    const value = this.snapshot?.['pay.rechargeEnabled']?.value;
    return typeof value === 'boolean' ? value : RECHARGE_ENABLED_DEFAULT;
  }

  /**
   * 金币兑换比率（第 28 键；范围照 `parsePayCoins`：int、`1 ≤ n ≤ 1,000,000`）。
   * 缺失/非整数/越界 ⇒ 代码默认 **100**（=种子）——下单快照必须拿到**可用正数**
   * （0/负数/小数会算歪 `coins` 或除零）。
   */
  coinPerYuan(): number {
    const value = this.snapshot?.['pay.coinPerYuan']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= COIN_PER_YUAN_MIN &&
      value <= COIN_PER_YUAN_MAX
      ? value
      : COIN_PER_YUAN_DEFAULT;
  }

  /**
   * 充值档位表（第 29 键；范围照 `parseRechargePackages`：非空 · 每项正整数且
   * `≤ 9,999,999` · 唯一）。缺失/非法 ⇒ 代码默认**种子档位**（返回拷贝，防调用方改坏）。
   * 消费面：下单档位校验（不在表内 ⇒ 10001）。
   */
  rechargePackages(): number[] {
    const value = this.snapshot?.['pay.rechargePackages']?.value;
    if (Array.isArray(value) && value.length > 0) {
      const items: number[] = [];
      let valid = true;
      for (const item of value) {
        if (
          typeof item !== 'number' ||
          !Number.isInteger(item) ||
          item <= 0 ||
          item > RECHARGE_PACKAGE_ITEM_MAX ||
          items.includes(item)
        ) {
          valid = false;
          break;
        }
        items.push(item);
      }
      if (valid) return items;
    }
    return [...RECHARGE_PACKAGES_DEFAULT];
  }

  /**
   * 订单有效期（分钟；第 33 键；范围照 `parsePayMinutes`：int、`1 ≤ n ≤ 10080`）。
   * 缺失/非整数/越界 ⇒ 代码默认 **30**（=种子）——`expires_at` 与渠道 `timeout_express`
   * 都由它派生，坏值（0/负数）会产「下单即过期」的单。
   */
  orderExpireMinutes(): number {
    const value = this.snapshot?.['pay.orderExpireMinutes']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= ORDER_EXPIRE_MINUTES_MIN &&
      value <= ORDER_EXPIRE_MINUTES_MAX
      ? value
      : ORDER_EXPIRE_MINUTES_DEFAULT;
  }

  /* ─── T10 提现链五键（第 27/30/31/32/34 键；缺省照种子）────────────────── */

  /**
   * 提现开关（第 27 键）。缺失/非 boolean ⇒ **false**（说不清 ⇒ 不开）。
   * 消费面：`WithdrawService.applyWithin` 的 15003 闸（**只挡新建**——在途照常可审可确认、
   * 超时照常回滚，§5.3）。
   */
  withdrawEnabled(): boolean {
    const value = this.snapshot?.['pay.withdrawEnabled']?.value;
    return typeof value === 'boolean' ? value : WITHDRAW_ENABLED_DEFAULT;
  }

  /**
   * 提交 3：提现敏感操作再认证开关（config-service 第 **48** 键 `risk.withdrawReAuthEnabled`）。
   * 默认 false（暗上线——客户端不弹密码框，票据验证永远放行）。
   * 消费面：`WithdrawController.apply()` 的票据闸。
   *
   * 值在 config 表里是 varchar——`'true'/'false'` 字符串，这里做宽松解析。
   * 缺失/非布尔字符串 ⇒ false（保守，不开）。
   */
  withdrawReAuthEnabled(): boolean {
    const value = this.snapshot?.['risk.withdrawReAuthEnabled']?.value;
    return value === true || value === 'true';
  }

  /**
   * 提现门槛（第 30 键；范围照 `parsePayCoins`：int、`1 ≤ n ≤ 1,000,000`）。
   * 缺失/非整数/越界 ⇒ 代码默认 **1000**（=种子）。消费面：`coins ≥ min` 的 15003 闸
   * （下限必须落在域内：0/负数会让门槛校验形同虚设，须回落）。
   */
  withdrawMinCoins(): number {
    const value = this.snapshot?.['pay.withdrawMinCoins']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= WITHDRAW_COINS_MIN &&
      value <= WITHDRAW_COINS_MAX
      ? value
      : WITHDRAW_MIN_COINS_DEFAULT;
  }

  /** 单笔上限（第 31 键；同域）。缺失/非法 ⇒ **50000**（=种子）。消费面：`coins ≤ max` 的 15004 闸。 */
  withdrawMaxCoinsPerOrder(): number {
    const value = this.snapshot?.['pay.withdrawMaxCoinsPerOrder']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= WITHDRAW_COINS_MIN &&
      value <= WITHDRAW_COINS_MAX
      ? value
      : WITHDRAW_MAX_COINS_PER_ORDER_DEFAULT;
  }

  /**
   * 单用户单日上限（第 32 键；同域）。缺失/非法 ⇒ **100000**（=种子）。消费面：日限合计
   * （+08:00 自然日、五态计入）的 15004 闸——坏值（0/负数）会让一切申请被日限误拒，须回落。
   */
  withdrawDailyMaxCoins(): number {
    const value = this.snapshot?.['pay.withdrawDailyMaxCoins']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= WITHDRAW_COINS_MIN &&
      value <= WITHDRAW_COINS_MAX
      ? value
      : WITHDRAW_DAILY_MAX_COINS_DEFAULT;
  }

  /**
   * 超时回滚分钟数（第 34 键；范围照 `parsePayMinutes`：int、`1 ≤ n ≤ 10080`）。
   * 缺失/非法 ⇒ 代码默认 **4320**（=种子，72h）。消费面：申请插行的
   * `timeout_at = NOW(3) + INTERVAL ? MINUTE`（行内快照——后续改配置不影响在途单）。
   */
  withdrawTimeoutMinutes(): number {
    const value = this.snapshot?.['pay.withdrawTimeoutMinutes']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= WITHDRAW_TIMEOUT_MINUTES_MIN &&
      value <= WITHDRAW_TIMEOUT_MINUTES_MAX
      ? value
      : WITHDRAW_TIMEOUT_MINUTES_DEFAULT;
  }

  /* ─── 节奏/清理旋钮二键（第 35–36 键；本片 T4；缺省照种子）────────────────── */
  // 读法逐字照 coinPerYuan()：缺失 / 类型漂移 / 越界 ⇒ 代码默认常数（= 种子值）。
  // 🔴 janitor fail-safe（设计 D3）：**快照整体不可用同样回落**——与钱面（充值/提现闸的
  // fail-closed 拒）刻意分层（「不确定不停扫」vs「不确定不放松钱」）。消费方在**重排处
  // 现读**本组方法 ⇒「改了下一轮生效」（当前一轮按旧值跑完）。

  /**
   * 支付扫描周期（第 35 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 60s。
   * 消费方 = `scan/scan.service.ts` 扫描链（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  scanIntervalMs(): number {
    const value = this.snapshot?.['pay.scanIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= PAY_SCAN_INTERVAL_MIN &&
      value <= PAY_SCAN_INTERVAL_MAX
      ? value
      : PAY_SCAN_DEFAULT_INTERVAL_MS;
  }

  /**
   * 日自检周期（第 36 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 24h。
   * 消费方 = `scan/scan.service.ts` 日自检链（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  reconcileIntervalMs(): number {
    const value = this.snapshot?.['pay.reconcileIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= PAY_RECONCILE_INTERVAL_MIN &&
      value <= PAY_RECONCILE_INTERVAL_MAX
      ? value
      : PAY_RECONCILE_DEFAULT_INTERVAL_MS;
  }

  /** 首次快照就位的等待：六循环首排动作（⚙️5）的**有界等待消费**（测试/生产共用 —— 生产侧 = `bootFirstScheduling()` 的就绪路 race）。 */
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
   */
  private pullWithRetry(): void {
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      this.refreshOnce().then(
        () => undefined,
        (err: unknown) => {
          this.onRefreshFailed(err);
          // 🔴 关停闸：迟到的失败回执不得在关停后再排退避定时器。
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
    this.logger.log(`config snapshot applied (version=${res.version})`);
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
   * ⇒ 必须独立 `new Redis(...)`，不得复用任何共享实例（T8 的回调限流桶另建自己的）。
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
   * 🔴 关停闸：重排前查 `shuttingDown` —— 一轮在途时关停，`.finally` 迟到的重排必须被拦住。
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
