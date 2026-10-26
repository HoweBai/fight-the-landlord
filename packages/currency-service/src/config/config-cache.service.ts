// packages/currency-service/src/config/config-cache.service.ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type {
  BaseScoreLevel,
  ConfigKey,
  ConfigSnapshot,
  EntryFeePercent,
  GameType,
} from '@fight-the-landlord/protocol';
import { entryFeePercentsFromLevels } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { ConfigClient } from './config.client';

/**
 * config-service 写入后广播的频道（**值经 design/spec 钉死**；发布侧 = config-service 的
 * `CONFIG_CHANGED_CHANNEL`——同一个字面量在两侧各定义一次，因为服务之间不互相 import。
 * `config-cache.test.ts` 有一条「频道名逐字」把本侧钉住；两侧一致性由机制层层兜底：
 * 丢一条通知的后果被安全网（≤60s）压住，见 design D2）。
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/**
 * `currency.reliefEnabled` 的**代码默认值**（= 种子 = ② 规格 §1 第 16 键：`false`；
 * 缺失/非法 ⇒ 取这里的值）。false 的语义是**安全方向**：配置说不清 ⇒ 救助不开
 * （与 room 侧 `friendRoomEnabled` 同一个方向；`goldRoomEnabled` 经 2026-10-04
 * 用户裁决已翻为默认开，不再同向）。
 */
export const RELIEF_ENABLED_DEFAULT = false;

/**
 * `currency.reliefAmount` 的**代码默认值**（= 种子 = ② 规格 §1 第 17 键：`200`；
 * 缺失/非法 ⇒ 取这里的值）。⚠️ 0 不是「停发」的合法表达（停发用开关）——坏值回落
 * 到一个**能过 apply 校验**的可用金额，绝不把 0/负数透传进发放载荷。
 */
export const RELIEF_AMOUNT_DEFAULT = 200;

/** `currency.reliefAmount` 的合法范围（② 规格 §1 的写死校验：int、`1 ≤ n ≤ 1,000,000`）。 */
const RELIEF_AMOUNT_MIN = 1;
const RELIEF_AMOUNT_MAX = 1_000_000;

/**
 * `currency.reconcileIntervalMs` 的合法上界（照 `parseIntervalMs`：1 ≤ n ≤ 36000000）。
 */
const CURRENCY_RECONCILE_INTERVAL_MIN = 1;
const CURRENCY_RECONCILE_INTERVAL_MAX = 36_000_000;
/** `currency.reconcileIntervalMs` 的**代码默认值**（= 种子 = 第 37 键：1h；缺失/坏值 ⇒ 取此值）。 */
export const CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS = 3_600_000;

/**
 * 六循环「首排动作」的**有界等待**（本片 D2；`onModuleInit` 时快照未就绪 ⇒
 * `race(首快照, 本常数)`，超时按缺省解析先排期，下一轮重排自愈）。
 * ⚠️ **三份克隆同值**（user / payment / currency 三服务各自的 `config/config-cache.service.ts`；
 * R96 同源纪律——「同一事实两处实现」须同源同步，改一份必须三份同改）。
 */
export const SNAPSHOT_BOOT_WAIT_MS = 10_000;

/** 启动拉取失败后的重试间隔（design D2：**1s 退避重试直到首次成功**、不阻塞就绪）。 */
const STARTUP_RETRY_INTERVAL_MS = 1_000;

/**
 * currency-service 的**配置快照缓存**（② 金币场 T8 / 规格 §9 —— 本服务首次接配置，
 * 克隆 room/robot/user 三模板的第四份）。
 *
 * ─── 行为（三件）────────────────────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到
 *     首次成功**（`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，
 *     错序窗口由重试 + 安全网自愈）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用 `RedisModule` 的实例）；
 *     收到通知 ⇒ 重拉**全量**换缓存（不做增量；版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（分层，规格 §9 写死）───────────────────────────────────────
 *  「拿不到」= 缓存为空，且一次即时拉取也失败；缓存非空（哪怕旧）一律用缓存。
 *  - **三键的键级缺省**（缺失/类型漂移/越界）⇒ 各自**代码默认值**（false / 200 / 10）——
 *    与 room 侧「热项取默认」同口径；
 *  - 🔴 **整个快照拿不到**（从未拉到）⇒ `hasSnapshot()` = false —— relief 端点据此
 *    **503/10007（不默认放行）**：默认值只覆盖「键缺失/坏值」，**不**覆盖「读不到配置」。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose 不设）────────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
 *  ⚠️ 与 room/robot/user 侧**同名同口径**（同构克隆的既有形态；生产不设 ⇒ 四服务各自走默认）。
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
   * 🔴 relief 端点（规格 §9）在开始裁决**之前**查它：false ⇒ **503/10007
   * （不默认放行）**。三个带代码默认值的 getter 只覆盖「键缺失/坏值」这一层 ——
   * 「从未拉到配置」是更高一层的失败，不许被默认值吞掉；档位表（第四键）没有代码
   * 默认值，缺失/坏值同样按 fail-closed 处理。
   */
  hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /** 每日救助开关（② 规格 §1 第 16 键）。缺失/非 boolean ⇒ **false**（说不清 ⇒ 不开）。 */
  reliefEnabled(): boolean {
    const value = this.snapshot?.['currency.reliefEnabled']?.value;
    return typeof value === 'boolean' ? value : RELIEF_ENABLED_DEFAULT;
  }

  /**
   * 每日救助金额（② 规格 §1 第 17 键；范围照 `protocol/src/config.ts` 的
   * `parseReliefAmount`：int、`1 ≤ n ≤ 1,000,000`）。
   *
   * 缺失/非整数/越界 ⇒ 代码默认 **200**（=种子）。快照里出现越界值理论上不可能
   * （写入口已拦），但发放载荷必须是**可用金额**：这里兜一道，绝不让 0/负数/小数
   * 漏进 `apply`（那会 10001 拒绝或发错钱）。
   */
  reliefAmount(): number {
    const value = this.snapshot?.['currency.reliefAmount']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= RELIEF_AMOUNT_MIN &&
      value <= RELIEF_AMOUNT_MAX
      ? value
      : RELIEF_AMOUNT_DEFAULT;
  }

  /**
   * 每日救助绝对门槛（平行化 2026-10-24）：平台级金币数，`1..1,000,000`。
   * 缺失/非法 ⇒ **null**（钱路径 fail-closed；调用方按瞬态处理，绝不按 150 猜）。
   */
  reliefThresholdCoins(): number | null {
    const value = this.snapshot?.['currency.reliefThresholdCoins']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 1_000_000
      ? value
      : null;
  }

  /**
   * 记牌器总开关（斗地主新键，旧键回退）。缺失/坏值 ⇒ **false**（与客户端 fail-safe 同向：
   * 说不清 = 不开放）。消费方 = 购买端点（effect 内；关 ⇒ 14008）。
   */
  cardCounterEnabled(): boolean {
    const value = this.readWithLegacy(
      'game.doudizhu.cardCounterEnabled',
      'game.cardCounterEnabled',
    );
    return typeof value === 'boolean' ? value : false;
  }

  /** 代理邀请码开关（2026-10-26 第 101 键）。缺失/坏值 ⇒ **false**（说不清 = 不收集邀请码）。 */
  agentInviteEnabled(): boolean {
    const value = this.snapshot?.['agent.inviteEnabled']?.value;
    return typeof value === 'boolean' ? value : false;
  }

  /**
   * 记牌器两价格（斗地主新键，旧键回退）。缺失/坏值/越界 ⇒ **10/100**（= 种子；
   * 消费方拿到的必须是可用数字）。消费方 = 购买端点（effect 内与服务端当前价比对；
   * 区间 `0..1,000,000`）。
   */
  cardCounterPrices(): { perGame: number; perHour: number } {
    const pick = (value: unknown, fallback: number): number =>
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 1_000_000
        ? value
        : fallback;
    return {
      perGame: pick(
        this.readWithLegacy(
          'game.doudizhu.cardCounterPricePerGameCoins',
          'game.cardCounterPricePerGameCoins',
        ),
        10,
      ),
      perHour: pick(
        this.readWithLegacy(
          'game.doudizhu.cardCounterPricePerHourCoins',
          'game.cardCounterPricePerHourCoins',
        ),
        100,
      ),
    };
  }

  /** 新键存在性优先，缺失回退旧键（仅斗地主专属键）。 */
  private readWithLegacy(newKey: string, legacyKey: string): unknown {
    if (this.snapshot !== null && Object.hasOwn(this.snapshot, newKey)) {
      return this.snapshot[newKey as ConfigKey]?.value;
    }
    return this.snapshot?.[legacyKey as ConfigKey]?.value;
  }

  // ─── 节奏键（本片 T4；规格 ⚙️4；第 37 键）────────────────────────────────────
  // 读法逐字照 reliefAmount()：缺失 / 类型漂移 / 越界 ⇒ 代码默认常数（= 种子值）。
  // 🔴 janitor fail-safe（设计 D3）：**快照整体不可用同样回落**——与 relief 端点的
  // fail-closed 拒（`hasSnapshot()` 判别面）刻意分层（「不确定不停扫」vs「不确定不放松钱」）。
  // 消费方在**重排处现读**本方法 ⇒「改了下一轮生效」（当前一轮按旧值跑完）。

  /**
   * 对账周期（第 37 键；本片）。缺失/类型漂移/越界 ⇒ 代码默认 1h。
   * 消费方 = `reconcile/reconcile.service.ts`（重排处现读 ⇒ 改后下一轮排期生效）。
   * ⚠️ 快照整体不可用同样回落（janitor fail-safe——与钱面 fail-closed 刻意分层）。
   */
  reconcileIntervalMs(): number {
    const value = this.snapshot?.['currency.reconcileIntervalMs']?.value;
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= CURRENCY_RECONCILE_INTERVAL_MIN &&
      value <= CURRENCY_RECONCILE_INTERVAL_MAX
      ? value
      : CURRENCY_RECONCILE_DEFAULT_INTERVAL_MS;
  }

  /**
   * C2：某玩法的台费档位费率表。返回 `null` = 快照不可用/档位缺失/非法（配置不可用，
   * 调用方跳过台费检查）；返回 `[]` = 合法空表；合法全 0 档位 ⇒ **非空全 0 数组**
   * （不丢档位，`entryFeeOf` 自然得 0）。
   *
   * 读法：`game.levels.<gameType>` 存在 ⇒ 只认它（非法 ⇒ null，不回退）；缺失 ⇒ 斗地主回退
   * 旧 `game.baseScoreLevels`；跑得快无旧键 ⇒ null。
   */
  entryFeePercents(gameType: GameType): readonly EntryFeePercent[] | null {
    const key = gameType === 'paodekuai' ? 'game.levels.paodekuai' : 'game.levels.doudizhu';
    const primary = this.snapshot?.[key]?.value;
    if (primary !== undefined) {
      return isValidLevels(primary) ? entryFeePercentsFromLevels(primary) : null;
    }
    if (gameType !== 'doudizhu') return null;
    const legacy = this.snapshot?.['game.baseScoreLevels']?.value;
    if (legacy === undefined) return null;
    return isValidLevels(legacy) ? entryFeePercentsFromLevels(legacy) : null;
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
    this.logger.log(
      `config snapshot applied (version=${res.version}, reliefEnabled=${this.reliefEnabled()})`,
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
   * ⇒ 必须独立 `new Redis(...)`，不得复用 `RedisModule` 的实例（那个实例还要发余额缓存命令）。
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

/** C2：档位表形状自保（只用于台费对账；非法 ⇒ 配置不可用，不猜）。 */
function isValidLevels(value: unknown): value is BaseScoreLevel[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const level = item as Partial<BaseScoreLevel>;
    return (
      typeof level.name === 'string' &&
      level.name.length > 0 &&
      Number.isInteger(level.baseScore) &&
      (level.baseScore as number) > 0 &&
      (level.entryFeePercent === undefined ||
        (Number.isInteger(level.entryFeePercent) &&
          level.entryFeePercent >= 0 &&
          level.entryFeePercent <= 100))
    );
  });
}
