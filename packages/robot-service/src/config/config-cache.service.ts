// packages/robot-service/src/config/config-cache.service.ts
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { ConfigSnapshot, SkillLevel } from '@fight-the-landlord/protocol';
import { runWithTrace } from '@fight-the-landlord/shared';
import { ConfigClient } from './config.client';
import { ROBOT_CONFIG_DEFAULTS, SKILL_LEVELS, parseSkillDistribution } from '../robot/config';
import { type DouZeroModel } from '../robot/models';

/**
 * config-service 写入后广播的频道（**值经 design/spec 钉死**；发布侧 = config-service 的
 * `CONFIG_CHANGED_CHANNEL`——同一个字面量在两侧各定义一次，因为服务之间不互相 import。
 * `config-cache.test.ts` 有一条「频道名逐字」把本侧钉住；两侧一致性由机制层层兜底：
 * 丢一条通知的后果被安全网（≤60s）压住，见 design D2）。
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/** 启动拉取失败后的重试间隔（design D2：**1s 退避重试直到首次成功**、不阻塞就绪）。 */
const STARTUP_RETRY_INTERVAL_MS = 1_000;

/** douzero 侧认可的模型目录名（校验快照值用；与 `models.ts` 的词表同源同值）。 */
const MODEL_NAMES: readonly DouZeroModel[] = ['sl', 'douzero_WP', 'douzero_ADP'];

/**
 * 快照值（JSON 对象形态）→ 既有**有序对**形态（`SKILL_LEVELS` 顺序 —— 与
 * `parseSkillDistribution` 的输出形态逐位一致）；形状非法 ⇒ `null`（调用方取默认）。
 *
 * 只做**转换**不做归一化：写入侧（config-service）已按合计归一化落库（规格 §2.2）。
 */
function toSkillPairs(value: unknown): ReadonlyArray<readonly [SkillLevel, number]> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const table = value as Record<string, unknown>;
  const pairs: Array<readonly [SkillLevel, number]> = [];
  let total = 0;
  for (const level of SKILL_LEVELS) {
    const weight = table[level];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) return null;
    pairs.push([level, weight] as const);
    total += weight;
  }
  return total > 0 ? pairs : null;
}

/** 快照值 → 三档模型映射；任一键缺失 / 值不在认可词表 ⇒ `null`（调用方取默认）。 */
function toModelMapping(value: unknown): Record<SkillLevel, DouZeroModel> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const table = value as Record<string, unknown>;
  const out = {} as Record<SkillLevel, DouZeroModel>;
  for (const level of SKILL_LEVELS) {
    const model = table[level];
    if (typeof model !== 'string' || !MODEL_NAMES.includes(model as DouZeroModel)) return null;
    out[level] = model as DouZeroModel;
  }
  return out;
}

/**
 * robot-service 的**配置快照缓存**（片⑦ design D2；T8 = T6 `ConfigCacheService` 的
 * **同构克隆**，room 的四个房间键换成 robot 的四键）。
 *
 * ─── 行为（三件）────────────────────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到首次成功**
 *     （`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，错序窗口由
 *     重试 + 安全网自愈；compose 刻意不给消费服务加 `depends_on` 硬门）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用 `RedisProviderModule` 的实例）；
 *     收到通知 ⇒ 重拉**全量**换缓存（不做增量；版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（design D2）────────────────────────────────────────────────
 *  robot 的四键**全是热项**（skillDistribution 下一次抽档 / ruleFallback 每次门禁 /
 *  modelBySkill 每次决策装配 / reclaimIntervalMs 下一轮）：「拿不到」= 缓存为空，且一次
 *  即时拉取也失败时，getter 一律取**代码默认值**（`ROBOT_CONFIG_DEFAULTS` = 种子）。
 *  **配置中心挂了不得停止服务**（C3 的 robot 半边）—— 快照非空（哪怕旧）一律用缓存。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose 不设）────────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，C17a 的变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
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
  /** 首次成功快照的等待者（`waitForFirstSnapshot()`，测试用）。 */
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

  // ─── 读面（四个 getter；缺快照/缺失键/形状非法 ⇒ 代码默认值 = 种子）──────────

  /**
   * 抽档比例（有序对；`RobotPool.pickSkillLevel()` 下一拍抽档时现读）。
   * 快照值（JSON 对象）⇒ 有序对；缺失/非法 ⇒ 解析默认串（`'15,35,50' ≡ .15/.35/.5` 口径）。
   */
  skillDistribution(): ReadonlyArray<readonly [SkillLevel, number]> {
    const value = this.snapshot?.['robot.skillDistribution']?.value;
    return (
      toSkillPairs(value) ??
      parseSkillDistribution(ROBOT_CONFIG_DEFAULTS['robot.skillDistribution'])
    );
  }

  /**
   * 规则兜底开关（`DouZeroHealth.canProvide()` 的门禁短路用它；**不是决策路径**）。
   * 缺失/非 boolean ⇒ **true**（=种子；开关的世界默认，方向与「好友房 false」相反 ——
   * 规则兜底开着的旧世界是兼容面，见 design D3）。
   */
  ruleFallback(): boolean {
    const value = this.snapshot?.['robot.ruleFallback']?.value;
    return typeof value === 'boolean' ? value : ROBOT_CONFIG_DEFAULTS['robot.ruleFallback'];
  }

  /**
   * 三档 → 模型名（**决策路径**：`BotPlayer.buildDouZeroContext()` 组装 DouZero 请求时现读）。
   * 缺失/非法（键缺、值不在 `sl|douzero_WP|douzero_ADP`）⇒ `models.ts` 的默认映射。
   */
  modelBySkill(): Record<SkillLevel, DouZeroModel> {
    const value = this.snapshot?.['robot.modelBySkill']?.value;
    return toModelMapping(value) ?? ROBOT_CONFIG_DEFAULTS['robot.modelBySkill'];
  }

  /**
   * 兜底回收周期（毫秒）。缺失/非正数/非整数 ⇒ 代码默认值（60000）。
   * ⚠️ 消费方（`RobotReclaimTask`）**每一轮结束时**重读本方法 ⇒ 「改了下一轮生效」
   * （当前一轮按旧值跑完 —— C9 的口径）。
   */
  reclaimIntervalMs(): number {
    const value = this.snapshot?.['robot.reclaimIntervalMs']?.value;
    return typeof value === 'number' && Number.isInteger(value) && value > 0
      ? value
      : ROBOT_CONFIG_DEFAULTS['robot.reclaimIntervalMs'];
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
   * ⇒ `{traceId: randomUUID(), source: 'timer'}`。
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
      `config snapshot applied (version=${res.version}, ruleFallback=${this.ruleFallback()}, reclaimIntervalMs=${this.reclaimIntervalMs()})`,
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
   * 命令** ⇒ 必须独立 `new Redis(...)`，不得复用 `RedisProviderModule` 的实例。
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
        // ALS 按「谁发起的」传播）⇒ 处理器内部**再包一次**。
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
