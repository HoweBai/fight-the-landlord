import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { runWithTrace } from '@fight-the-landlord/shared';
import {
  ConfigCacheService,
  CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS,
  SNAPSHOT_BOOT_WAIT_MS,
} from '../config/config-cache.service';
import { BALANCE_KEY_PREFIX, REDIS, delBalance } from '../redis/redis.module';
import {
  currencyOrphanSignupGrants,
  currencyReconcileCacheDriftTotal,
  currencyReconcileDriftAccounts,
  currencyReconcileLastSuccessTimestampSeconds,
  currencyReconcileRunsTotal,
  currencyRobotAccountsBalanceSum,
  currencyRobotPoolBalance,
} from '../metrics/currency.metrics';

/** 默认对账间隔（规格 §2.12 逐字：3600000 = 1h）—— 唯一真源已迁 `ConfigCacheService`（本片 T4）；此处 re-export 保引用面。 */
export { CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS };
/** 启动后首跑延迟（规格 §2.12 逐字：10s；配置面只改**间隔**，不改它）。 */
export const CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS = 10_000;
/** SCAN 每页建议条数（规格只写死「SCAN 游标循环」；具体页大小是实现细节）。 */
export const CURRENCY_RECONCILE_SCAN_COUNT = 100;

/**
 * 检查①的判定 SQL（规格 §2.12 表**逐字**，不得加别名/换写法；`reconcile.test.ts` 的
 * 假 DB 按**全文相等**识别 —— 改一个字符就当场红）。
 * ⚠️ 单条语句自有 InnoDB 一致快照 —— **分读**（先读账户再读流水）会与并发 apply
 * 交错造成**假漂移**，这正是判定写死为单语句的原因。
 */
const DRIFT_ACCOUNTS_SQL =
  'SELECT a.owner_id, a.balance, COALESCE(f.total,0) FROM currency_accounts a LEFT JOIN (SELECT owner_id, SUM(delta) total FROM currency_flows GROUP BY owner_id) f ON f.owner_id = a.owner_id WHERE a.balance <> COALESCE(f.total,0)';

/** 检查①回执第三列的标签：SQL 无别名 ⇒ MySQL 的列标签就是表达式原文。 */
const DRIFT_TOTAL_COLUMN = 'COALESCE(f.total,0)';

/** 检查②逐键的 MySQL 余额读 —— 与 `get.service.ts` 的 miss 回源**同形**（单行读）。 */
const BALANCE_SELECT_SQL = 'SELECT `balance` FROM `currency_accounts` WHERE `owner_id` = ?';

/** 检查③的判定 SQL（规格 §2.12 表**逐字**；只读诊断）。 */
const ORPHAN_SIGNUP_GRANTS_SQL =
  "SELECT COUNT(DISTINCT f.owner_id) FROM currency_flows f JOIN currency_ops o ON o.id = f.op_id LEFT JOIN users u ON u.id = f.owner_id WHERE o.source = 'signup_grant' AND u.id IS NULL";

/** 检查③回执的列标签（同「无别名 ⇒ 表达式原文」）。 */
const ORPHAN_COUNT_COLUMN = 'COUNT(DISTINCT f.owner_id)';

/**
 * ② 金币场（T8，规格 §7/§11.1）：机器人虚拟池的 `owner_id`（**常量**，种子/补给/回收
 * 三面共用同一字面量；类型面由首写固化为 `robot`）。
 */
export const ROBOT_POOL_OWNER_ID = 'robot-pool';

/**
 * 机器人账户余额总和（T8，§11.1 逐字口径）：`owner_type='robot'` 且
 * `owner_id LIKE 'bot-%'` —— **不含池本身**（`robot-pool` 无 `bot-` 前缀，天然排除）。
 * `COALESCE(SUM(...), 0)`：无行 ⇒ 0（不是 NULL）—— gauge 要如实报「机器人一个铜板都没有」，
 * 告警/面板不区分「0」与「查不到」。
 */
const ROBOT_ACCOUNTS_SUM_SQL =
  "SELECT COALESCE(SUM(`balance`), 0) FROM `currency_accounts` WHERE `owner_type` = 'robot' AND `owner_id` LIKE 'bot-%'";

/** 总和回执的列标签（同「无别名 ⇒ 表达式原文」）。 */
const ROBOT_ACCOUNTS_SUM_COLUMN = 'COALESCE(SUM(`balance`), 0)';

/** 驱动读出的 number/bigint ⇒ 安全整数（读不出 ⇒ 抛，不静默编造读数；同 apply.service 先例）。 */
function requireSafeInt(value: unknown, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${context}：读出的值不是安全整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
}

/** 一轮的读数（日志之外的机械回执；测试与运维用）。 */
export interface CurrencyReconcileRoundResult {
  /** ① 账实不符账户数（`currency_reconcile_drift_accounts` 同值）。 */
  driftAccounts: number;
  /** ② 本轮 DEL 掉的漂移缓存键数。 */
  cacheDriftDeleted: number;
  /** ③ 孤儿赠送账户数（`currency_orphan_signup_grants` 同值）。 */
  orphanSignupGrants: number;
  /** ② 金币场：机器人虚拟池余额（`currency_robot_pool_balance` 同值；未种子 ⇒ 0）。 */
  robotPoolBalance: number;
  /** ② 金币场：机器人账户余额总和（`currency_robot_accounts_balance_sum` 同值；不含池）。 */
  robotAccountsBalanceSum: number;
}

/**
 * 手动触发遇 `inFlight` 旗（③ T8，§2.7：「对账正在跑」）——`runReconcileOnce` 抛本型别；
 * 控制器据此翻 **409 借 10001**「对账正在运行」（响应信封留在控制层，服务层不碰 HTTP）。
 */
export class ReconcileInFlightError extends Error {
  constructor() {
    super('对账正在运行');
    this.name = 'ReconcileInFlightError';
  }
}

/** 对账面板读口状态（③ T8，§2.7 GET 的 `data` 形状；**内存态**——重启后前四项 null = 「未知」）。 */
export interface CurrencyReconcileStatus {
  /** 最近一轮**尝试**时刻（epoch ms；成败都刷）；null = 本进程尚未跑过。 */
  lastAttemptAt: number | null;
  /** 最近一轮**成功**时刻（epoch ms）；null = 本进程尚未成功过。 */
  lastSuccessAt: number | null;
  /** 最近一轮成功的读数（形状 = `CurrencyReconcileRoundResult`）；null = 未见成功。 */
  lastResult: CurrencyReconcileRoundResult | null;
  /** 最近一次失败的错误文本（截断 500 字）；null = 本进程尚未失败过（成功轮不擦——面板据 lastAttemptAt vs lastSuccessAt 判新旧）。 */
  lastError: string | null;
  /** `inFlight` 旗（手动与定时链共用一把）——GET 期间的实时值。 */
  running: boolean;
}

/**
 * 对账自调度循环（货币片 T8；规格 §2.12 逐字）：账实相符（只报不改）/ 缓存一致性（自愈）/
 * 孤儿赠送（只读诊断）三检查 + 7 条指标中的四条写点。
 *
 * ─── 循环（规格 §2.12 逐字；本片 ⚙️5–⚙️7：间隔 = 配置第 37 键 `currency.reconcileIntervalMs`）──
 *  - 形态照记录片 `records-cleanup.service.ts`：`setTimeout` **自重排链**（一轮跑完再排
 *    下一轮 —— **串行无重入**）+ 关停闸；默认间隔 **1h**（缺键/坏值/快照整体不可用 ⇒ 回落
 *    种子常数 —— 唯一真源 = `ConfigCacheService`）；**启动后 10s 首跑**（常数，不受配置影响）。
 *    间隔**排期处现读**（`resolveIntervalMs()` ⇒ `configCache.reconcileIntervalMs()`）——
 *    旧 env 注入面 `CURRENCY_RECONCILE_INTERVAL_MS` 已退役（本片 ⚙️8）。
 *  - 🔴 **自调度自重排**（`setTimeout` → 一轮跑完再排下一轮）：**当前一轮按旧值跑完 ⇒
 *    其后按现读的缓存值排期**（已排定的一轮不撤；改键最坏在「本间隔 + 新间隔」内生效 ——
 *    `setInterval` 无法承载「重排现读」的口径）。
 *  - 🔴 **首排动作**（本片 ⚙️5）：`onModuleInit` **同步返回**；`hasSnapshot()` 就绪 ⇒ 同帧
 *    解析+打+排；未就绪 ⇒ 有界等待 `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 两路经 **once 闸**
 *    汇入 `afterSnapshotReady()`（至多一次：超时后快照迟到 ⇒ 就绪路 no-op，败方定时器清除），
 *    超时路按缺省解析先排期、下一轮重排自愈。等待发生在**排期面**（不阻塞容器就绪）。
 *  - ⚠️ 配置的是**间隔**，不是首跑延迟：首跑恒在启动 10s 后（规格 §2.12 的两个数字是两条独立事实）。
 *
 * ─── 三检查与错误姿态 ────────────────────────────────────────────────────
 *  - 一轮 = 三检查**顺序**执行 + 轮末两 gauge 刷新（② 金币场，T8）；任一步抛（查询/驱动
 *    回执异常）⇒ 整轮失败：由 `runRound`
 *    的 catch 记 error 留痕、`last_success` **不 set**、循环继续（下一轮照排）——记录片
 *    同款失败姿态。
 *  - ⚠️ **漂移是「检查结果」不算失败**：账实漂移只记 error 行 + gauge，**绝不自修**
 *    （钱的事只报不改，人工裁决）；一轮跑完（含漂移轮）即 set `last_success`。
 *  - 检查②的漂移**自愈**：值不等 / 值损坏 / 账户不存在 ⇒ DEL 键（下读回源）+ counter；
 *    「MySQL 有而缓存缺」**不算**漂移（缓存缺不是不一致，只是未热）。
 *
 * ─── 日志（九字段 NDJSON 既有形状；traceId 随 ALS 上下文）───────────────────
 *  漂移逐行 level=error（含 ownerId / 两值 / 差）；孤儿 >0 与轮摘要各一条；整轮失败
 *  level=error。来源 `source: 'timer'` + 每轮自建 traceId（「这一轮」就是来源）。
 *  ⚠️ **一轮 = 恰一个 traceId**（T8b）：两个入口（定时链 / 手动触发）各自只做**一次**
 *  `runWithTrace` 包裹，共享内层 `runReconcileInner` —— 两层嵌套会让检查行/摘要行与
 *  失败行的 `.catch` 回调分属两个上下文（AsyncLocalStorage 的续体上下文 = `.catch`
 *  注册时刻的上下文），按 traceId 归并时丢一半。成例 = 记录片 `records-cleanup.service.ts`。
 *
 * ─── 面板状态与互斥（③ T8，§2.7/设计 §5.7）─────────────────────────────
 *  - 状态四字段（`lastAttemptAt/lastSuccessAt/lastResult/lastError`）+ `inFlight` 旗：`getStatus()`
 *    直读（内存态；新进程全 null = 「未知」，不伪造）；刷新规则见 `runReconcileInner` 头；
 *  - 互斥：手动遇旗 ⇒ 抛 `ReconcileInFlightError`（控制器翻 **409 借 10001**「对账正在运行」）；
 *    定时遇旗 ⇒ 跳过本轮（warn 一行、不写 `lastAttemptAt`——本轮未尝试）+ 照常自重排。
 *
 * ─── 指标（§2.12 表的 T8 四条 + ② 金币场的两个 gauge；定义见 `metrics/currency.metrics.ts`）──
 *  `runs_total` 每轮开始 +1；`last_success` 启动置 0、成功后 set；`drift_accounts` /
 *  `orphan_signup_grants` 每轮 set；缓存漂移与写穿失败共用 `cache_drift_total`。
 *  ⚠️ **② 金币场**（本片 T8）：轮末再 set `robot_pool_balance` / `robot_accounts_balance_sum`
 *  两个 gauge（§11.1「对账循环每轮刷新」）。
 *
 * ⚠️ **DI 纪律**：`DataSource` 值导入 + 显式 `@Inject`（DI 陷阱纪律）；`Redis` 只作
 * 参数类型 ⇒ `import type` 安全（同 `ApplyService` / `GetService`）；`ConfigCacheService`
 * 值导入、直接参数注入（**无 `@Inject`** —— 照 user 三循环先例；类型导入会被擦除 ⇒
 * 容器启动即崩）。
 */
@Injectable()
export class ReconcileService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReconcileService.name);
  /** 自重排定时器（`setTimeout` 链；记录片清理循环的同款形态）。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 关停闸：在途一轮的迟到自重排不得复活循环（照 `RecordsCleanupService` 成例）。 */
  private shuttingDown = false;

  /**
   * 互斥旗（③ T8，§2.7/⚙️5：手动与定时链共用一把；`runReconcileInner` 入口 set、finally 清）。
   * `getStatus().running` 与它同源；手动遇旗 ⇒ `ReconcileInFlightError`（409），定时遇旗 ⇒ 跳过。
   */
  private inFlight = false;

  /* ─── 对账面板状态（③ T8，§2.7/设计 §5.7；内存态——新进程全 null = 「未知」，不伪造）─── */
  /** 每一轮尝试（成败都）刷（入口、检查之前）；null = 本进程未尝试过。 */
  private lastAttemptAt: number | null = null;
  /** 成功轮刷；失败轮不动（保留上一成功面）。 */
  private lastSuccessAt: number | null = null;
  private lastResult: CurrencyReconcileRoundResult | null = null;
  /** 失败轮刷 = `String(err).slice(0, 500)`；成功轮不擦（「最近一次错误」）。 */
  private lastError: string | null = null;

  constructor(
    /** ⚠️ 显式 `@Inject(...)`（本仓惯例）：不依赖 `emitDecoratorMetadata`（单测里会静默 undefined）。 */
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    /** 值导入（DI 陷阱纪律；**无 `@Inject`** —— 照 user 三循环先例，注入由参数类型解析）。 */
    private readonly configCache: ConfigCacheService,
  ) {}

  onModuleInit(): void {
    // **先置 0**（「从未成功」语义 —— 首启 / 一直失败都要被告警命中）**再**进首排动作
    // （本片 ⚙️5；排首跑在其内）。顺序即语义，别对调（照记录片 T6 成例）。
    currencyReconcileLastSuccessTimestampSeconds.set(0);
    this.bootFirstScheduling();
  }

  /**
   * 首排动作（本片 ⚙️5，D2；`onModuleInit` **同步返回**，此处不阻塞容器就绪）：
   *
   * - **快路径（真同步）**：`hasSnapshot()` 就绪 ⇒ 同帧解析+打启动行+排首跑（不经 await/微任务）；
   * - **有界等待**：未就绪 ⇒ `race(首快照, SNAPSHOT_BOOT_WAIT_MS)` —— 超时/就绪两路经 **once 闸
   *   `settle`** 汇入（先到先赢、后到 no-op、败方定时器清除）。🔴 不可放宽：没有它，「超时后
   *   快照迟到」会二次排期（双链 —— `onApplicationShutdown` 只清得掉一个句柄，另一条链复活）；
   * - 降级拓扑（配置服务不可用）：≤10s 后按缺省解析先打行排期，下一轮重排自愈。
   */
  private bootFirstScheduling(): void {
    if (this.configCache.hasSnapshot()) {
      this.afterSnapshotReady(); // 快路径：同帧（真同步）
      return;
    }
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.afterSnapshotReady();
    };
    const timeout = setTimeout(settle, SNAPSHOT_BOOT_WAIT_MS);
    void this.configCache.waitForFirstSnapshot().then(settle, settle);
  }

  /**
   * 首排动作**唯一落点**（快/超时/就绪 三路共用；once 闸保证至多一次 —— 见 `bootFirstScheduling`）。
   * 续体先查关停闸（照关停闸纪律）：关停发生在等待期间 ⇒ 迟到的续体不得打行/排期。
   * 解析（`resolveIntervalMs()`，与重排处同一入口）⇒ 打启动行（⚙️6 逐字，interval 位 = 解析值）
   * ⇒ 排首跑（`CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS` 常数 —— **配置的是间隔，不是首跑延迟**）。
   */
  private afterSnapshotReady(): void {
    if (this.shuttingDown) return;
    this.logger.log(
      `Currency reconcile loop started (first run in ${CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS}ms, interval ${this.resolveIntervalMs()}ms)`,
    );
    this.scheduleNext(CURRENCY_RECONCILE_FIRST_RUN_DELAY_MS);
  }

  /** 间隔解析（本片 ⚙️7）：启动行与重排处**同一入口**；内部 = 缓存键级 getter（现读）。 */
  private resolveIntervalMs(): number {
    return this.configCache.reconcileIntervalMs();
  }

  /** 排下一轮（10s 首跑常数 / 其后间隔 = 重排处现读 —— 见类注的「配置的是间隔」）。 */
  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => this.runRound(), delayMs);
  }

  /**
   * 面板读口（③ T8，§2.7 GET 的 `data`）：状态四字段 + `running`（= `inFlight` 旗，实时值）。
   * 内存态直读——新进程前四项 null = 「未知」，如实呈现，**不伪造**。
   */
  getStatus(): CurrencyReconcileStatus {
    return {
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      running: this.inFlight,
    };
  }

  /**
   * 定时器起的一轮：ALS 包裹（自建 id + `timer` 来源）→ 跑 → 成败都留痕 → 关停闸后自重排。
   * 直呼**共享内层**（不是 `runReconcileOnce`）—— 一轮恰一层包裹（T8b）；轮级 catch 的
   * 续体上下文 = 注册时刻 = 本包裹 ⇒ 失败行与包内一切日志行同属「这一轮」的一个 id。
   *
   * ⚠️ 互斥（③ T8，§2.7）：**起跑前**查 `inFlight` 旗——手动一轮在途 ⇒ **跳过本轮**
   * （一行 warn、**不写** `lastAttemptAt`，本轮未尝试）+ **照常自重排**（串行链继续）。
   * 跳过在 `runWithTrace` **之外**（未尝试 ⇒ 无「这一轮」：不建 trace、零包裹）。
   */
  private runRound(): void {
    if (this.inFlight) {
      this.logger.warn('currency reconcile skipped: a round is already in flight（inFlight 互斥）');
      this.scheduleNext(this.resolveIntervalMs()); // 重排现读（本片 ⚙️7；跳过轮同口径）
      return;
    }
    runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => {
      void this.runReconcileInner()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`currency reconcile failed: ${reason}`); // last_success 不 set（此刻它保留旧值）
        })
        .finally(() => {
          // 🔴 关停闸：在途一轮的迟到回执不得在关停后再排定时器（否则循环「复活」）；
          // 间隔在**重排处现读**（本片 ⚙️7：改键自该轮收尾排期起生效）。
          if (!this.shuttingDown) this.scheduleNext(this.resolveIntervalMs());
        });
    });
  }

  /**
   * 立即对账一轮（**测试 / 运维手动触发**用，不等下一个周期）。返回值 = 三检查读数；
   * 任一检查抛 ⇒ reject（由调用方/`runRound` 处置 —— 定时链下不影响自重排）。
   * 直呼方**自己**恰包一层 `runWithTrace`（定时链走 `runRound` 的包裹、不叠层 —— T8b）。
   *
   * ⚠️ 互斥（③ T8，§2.7）：`inFlight`（手动或定时一轮在途）⇒ 抛 `ReconcileInFlightError`
   * （控制器翻 **409 借 10001**「对账正在运行」）—— 不叠跑；此时**不**包裹 trace（无尝试即无
   * 「这一轮」的包裹；对成功路径的包裹次数不变）。
   */
  async runReconcileOnce(): Promise<CurrencyReconcileRoundResult> {
    if (this.inFlight) throw new ReconcileInFlightError();
    return runWithTrace({ traceId: randomUUID(), source: 'timer' }, () => this.runReconcileInner());
  }

  /**
   * 一轮的实体（**共享内层**：定时链与手动触发两入口共用 —— 两入口各自恰一次
   * `runWithTrace` 包裹，本函数内不再包）。
   * 三检查顺序执行（①→②→③）；全部无异常跑完才 set `last_success`。
   *
   * ─── 面板状态与互斥旗（③ T8，§2.7/⚙️5）──────────────────────────────────
   *  - `inFlight` 旗：**入口 set、finally 清**（覆盖成败两路径；跳过轮不进本函数 ⇒ 旗帜不动）；
   *  - `lastAttemptAt`：**每一轮尝试（成败都）**在入口（检查之前）刷 —— 面板据此表达
   *    「最近一次尝试失败于何时」（设计 G7）；跳过轮不写（本轮未尝试）；
   *  - 成功轮另刷 `lastSuccessAt` + `lastResult`（失败轮不动这两项 = 保留上一成功面）；
   *  - 失败轮刷 `lastError` = `String(err).slice(0, 500)`（截断 500 字）；成功轮**不擦**它
   *    （规格只写「成功另刷后两项」——「最近一次错误」语义，面板据两时间戳判新旧）。
   */
  private async runReconcileInner(): Promise<CurrencyReconcileRoundResult> {
    this.inFlight = true;
    try {
      this.lastAttemptAt = Date.now();
      // 「每轮**开始** +1」：放在检查之前 ⇒ 查询抛错的失败轮也计入（与 last_success 成对读）。
      currencyReconcileRunsTotal.inc();
      const driftAccounts = await this.checkAccountLedger();
      const cacheDriftDeleted = await this.checkCacheConsistency();
      const orphanSignupGrants = await this.checkOrphanSignupGrants();
      // ② 金币场（T8）：轮末刷新两个 gauge（池 / 机器人总和 —— §11.1「对账循环每轮刷新」）。
      const { robotPoolBalance, robotAccountsBalanceSum } = await this.refreshRobotGauges();
      this.logger.log(
        `currency reconcile done: driftAccounts=${driftAccounts} cacheDriftDeleted=${cacheDriftDeleted} orphanSignupGrants=${orphanSignupGrants} robotPoolBalance=${robotPoolBalance} robotAccountsBalanceSum=${robotAccountsBalanceSum}`,
      );
      const result: CurrencyReconcileRoundResult = {
        driftAccounts,
        cacheDriftDeleted,
        orphanSignupGrants,
        robotPoolBalance,
        robotAccountsBalanceSum,
      };
      // 成功轮刷新（⚙️5「成功另刷后两项」）；last_success 指标与 lastSuccessAt **同刻**（同一次 Date.now）。
      const finishedAt = Date.now();
      this.lastSuccessAt = finishedAt;
      this.lastResult = result;
      // 漂移是「检查结果」不算失败 ⇒ 照 set；查询抛错走不到这里（不 set）。
      currencyReconcileLastSuccessTimestampSeconds.set(finishedAt / 1000);
      return result;
    } catch (err: unknown) {
      // 失败轮：刷 lastError（截断 500 字）+ 入口已刷的 lastAttemptAt；不动上一成功面。
      this.lastError = String(err).slice(0, 500);
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * 检查①：账实相符（§2.12 表逐字）—— 单条 SQL 判 `balance ≠ SUM(flows.delta)`。
   * 每行 level=error（含 ownerId / 两值 / 差）+ gauge = 行数；**不自修**（只报不改：
   * 本检查除这条 SELECT 外不发任何语句 —— 测试以「库零写」钉死）。
   */
  private async checkAccountLedger(): Promise<number> {
    const rows = (await this.dataSource.query(DRIFT_ACCOUNTS_SQL)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const ownerId = String(row['owner_id']);
      const balance = requireSafeInt(row['balance'], `检查① balance ownerId=${ownerId}`);
      const flowsTotal = requireSafeInt(row[DRIFT_TOTAL_COLUMN], `检查① 流水合计 ownerId=${ownerId}`);
      this.logger.error(
        `currency reconcile drift ownerId=${ownerId} balance=${balance} flowsTotal=${flowsTotal} diff=${balance - flowsTotal}`,
      );
    }
    currencyReconcileDriftAccounts.set(rows.length);
    return rows.length;
  }

  /**
   * 检查②：缓存一致性（§2.12 表）—— `SCAN currency:balance:*`（**游标循环**）逐键
   * GET 值 vs MySQL 余额；**不等 ⇒ DEL 键 + counter**（自愈，下读回源）。
   *  - 「账户不存在也算漂移」（缓存键在而账户行没了 ⇒ 该键是幽灵，DEL）；
   *  - 「MySQL 有而缓存缺」**不算**（不是不一致）；
   *  - ⚠️ 读**原始串**（不用 `getBalance()` 帮助层）：它把「缺键」与「值损坏」都归一成
   *    `null` —— 而这里两者语义相反（缺键不算漂移；值损坏是不等，照 DEL 自愈；
   *    `redis.module.ts` 的值契约注释同此口径）。
   */
  private async checkCacheConsistency(): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${BALANCE_KEY_PREFIX}*`,
        'COUNT',
        String(CURRENCY_RECONCILE_SCAN_COUNT),
      );
      cursor = next;
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (raw === null) continue; // SCAN 与 GET 之间键没了 = 缓存缺（不算漂移）
        const ownerId = key.slice(BALANCE_KEY_PREFIX.length);
        const rows = (await this.dataSource.query(BALANCE_SELECT_SQL, [ownerId])) as Array<{
          balance: unknown;
        }>;
        const actual = rows.length === 0 ? null : requireSafeInt(rows[0]!.balance, `检查② balance ownerId=${ownerId}`);
        // 相符判据：行在 + 值形态合规（十进制整数串）+ 数值相等；其余三支（值不等 / 值损坏 /
        // 账户不存在）都是漂移。
        if (actual !== null && /^-?\d+$/.test(raw) && Number(raw) === actual) continue;
        await delBalance(this.redis, ownerId); // 自愈（下读回源）；DEL 失败 ⇒ 本轮失败（响亮）
        currencyReconcileCacheDriftTotal.inc();
        deleted += 1;
      }
    } while (cursor !== '0');
    return deleted;
  }

  /**
   * 检查③：孤儿赠送（§2.12 表逐字，**只读诊断**）—— `signup_grant` 流水的 owner
   * 在 `users` 表已不存在（用户被删而流水永久保留）去重计数 ⇒ gauge；>0 记日志。
   */
  private async checkOrphanSignupGrants(): Promise<number> {
    const rows = (await this.dataSource.query(ORPHAN_SIGNUP_GRANTS_SQL)) as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      throw new Error(`检查③ 孤儿诊断：COUNT 查询应恰回一行（收到 ${rows.length} 行）`);
    }
    const count = requireSafeInt(rows[0]![ORPHAN_COUNT_COLUMN], '检查③ 孤儿计数');
    currencyOrphanSignupGrants.set(count);
    if (count > 0) {
      this.logger.warn(
        `currency reconcile orphan signup grants: count=${count}（signup_grant 流水的 users 行不存在 —— 只读诊断）`,
      );
    }
    return count;
  }

  /**
   * ② 金币场（T8，§7/§11.1）：**轮末**刷新两个机器人资金 gauge。
   *  - 池 = `owner_id='robot-pool'` 的单行读（与检查②逐键回源**同一 SQL 常量**；行不存在
   *    ⇒ **0** —— 告警 `CurrencyRobotPoolLow` 必须能命中「池根本没种子」）；
   *  - 总和 = `owner_type='robot'` 且 `owner_id LIKE 'bot-%'`（**不含池**；僵尸余额观测面）。
   * 查询抛错 ⇒ 本轮失败（与三检查同一姿态：`last_success` 不 set、下一轮照跑）。
   */
  private async refreshRobotGauges(): Promise<{
    robotPoolBalance: number;
    robotAccountsBalanceSum: number;
  }> {
    const poolRows = (await this.dataSource.query(BALANCE_SELECT_SQL, [ROBOT_POOL_OWNER_ID])) as Array<{
      balance: unknown;
    }>;
    const robotPoolBalance =
      poolRows.length === 0
        ? 0 // 未种子 = 0（不是「读不到」——「读不到」会由驱动抛错，走本轮失败路径）
        : requireSafeInt(poolRows[0]!.balance, `机器人池 balance ownerId=${ROBOT_POOL_OWNER_ID}`);

    const sumRows = (await this.dataSource.query(ROBOT_ACCOUNTS_SUM_SQL)) as Array<Record<string, unknown>>;
    if (sumRows.length !== 1) {
      throw new Error(`机器人总和：SUM 查询应恰回一行（收到 ${sumRows.length} 行）`);
    }
    const robotAccountsBalanceSum = requireSafeInt(sumRows[0]![ROBOT_ACCOUNTS_SUM_COLUMN], '机器人账户余额总和');

    currencyRobotPoolBalance.set(robotPoolBalance);
    currencyRobotAccountsBalanceSum.set(robotAccountsBalanceSum);
    return { robotPoolBalance, robotAccountsBalanceSum };
  }

  onApplicationShutdown(): void {
    // 🔴 第一行置闸：在途一轮的 `.finally` 据此不再排新定时器（同款闸的先例见记录片）。
    this.shuttingDown = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
