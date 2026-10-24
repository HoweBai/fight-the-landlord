// packages/api-gateway/src/config/config-cache.service.ts
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
 * api-gateway 的**配置快照缓存**（客户端接入片 T4；骨架逐段克隆 payment-service 的同名
 * 文件——读面按差异清单裁剪：**只保留 `snapshotOrNull()` + `waitForFirstSnapshot()`**，
 * 不建 payment 的键级 getter 族；网关消费面（T5 `ClientGateService` / T6 socket 闸）
 * **直读快照**做闸判定）。
 *
 * ─── 行为（三件，同 payment 骨架）────────────────────────────────────────
 *  ① **启动**：`config.snapshot` 拉全量 → 存进进程内缓存；失败 ⇒ **1s 退避重试直到
 *     首次成功**（`onModuleInit` **同步返回**、不阻塞就绪 —— config-service 是**软依赖**，
 *     错序窗口由重试 + 安全网自愈）；
 *  ② **推送**：订阅 `config:changed`（🔴 **专用连接** `new Redis(...)` —— ioredis 进入
 *     subscribe 模式后该连接不能再发普通命令，**不得**复用任何共享连接；网关的共享
 *     `REDIS` provider 是 **SessionGuard/限流/WS 名额**共用实例，向它 subscribe =
 *     登录验签/限流/名额同时失效 ⇒ 绝不触碰）；收到通知 ⇒ 重拉**全量**换缓存
 *     （不做增量；版本不前进也换，简单优先）；
 *  ③ **安全网**：默认每 60s **无条件**重拉一次（redis pub/sub 是 at-most-once、断线期间
 *     消息永久丢失 ⇒ 没有它就会出现「改了没生效、日志里也查不出来」；它把最坏情况从
 *     「永久陈旧」压到「≤60s 陈旧」）。
 *
 * ─── 失败语义（**两态**，本片 design 订正后的逐字口径）─────────────────────
 *  ① **拉过 ⇒ last-good 继续执法**：刷新失败一律**保留上次成功快照**（不覆盖）——
 *     关闸期间一次拉取失败**不**开门（关态不被一次失败放门）；
 *  ② **从未拉到 ⇒ `snapshotOrNull()` 返 `null`**：调用方（`ClientGateService`）据此
 *     **放行**（fail-open 的固有起点，可接受——防的是「开关机制把全网关拖瘫」，不是防
 *     冷启窗口；`client.*` 两键种子 `true` = 暗上线全开，与放行同向）。
 *  ⚠️ 快照整体不可用**不**返回空对象/默认对象：`null` 与「快照在但键缺失」是两个不同的
 *  事实，本层如实区分（消费面对键缺失另有 fail-open 读法：`snap[键]?.value !== false`）。
 *
 * ─── 测试 env 两枚（**仅测试注入**；生产 compose 不设）────────────────────
 *  - `CONFIG_SYNC_SAFETY_NET_MS`（默认 60000）；
 *  - `CONFIG_SYNC_DISABLE_PUSH`（非空 ⇒ 不订阅，变异开关）。
 *  🔴 解析纪律：**空串 = 未设**（compose 是空默认透传 `${X:-}`）—— 两处都用 `||` 语义
 *  （`Number('') || 60000`；`('' ?? '') !== ''` 为 false），**不用** `??`（规格 I1）。
 *  ⚠️ 与 user/room/robot/currency/payment 侧**同名同口径**（同构克隆的既有形态；生产不设
 *  ⇒ 六服务各自走默认）。
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
  /** 首次成功快照的等待者（`waitForFirstSnapshot()`：测试/生产共用的就绪等待面）。 */
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

  // ─── 读面 ──────────────────────────────────────────────────────────────

  /**
   * 当前快照的**如实读面**（**从未拉到 ⇒ `null`**；两态语义见类注）。
   *
   * 🔴 消费面（`ClientGateService`）的闸判定读它：`null` ⇒ **放行**（fail-open）；
   * 非 null ⇒ `snap[键]?.value !== false` ⇒ 放行（仅「拉到过且值恰为 `false`」才关）。
   * ⚠️ 返回的是**进程内缓存本体**：调用方只读（本项目消费面不改写快照；刷新是整体
   * 换对象引用——`refreshOnce` 成功时一次性替换 ⇒ 持有旧引用的调用方看到一致的旧视图）。
   */
  snapshotOrNull(): ConfigSnapshot | null {
    return this.snapshot;
  }

  /** 首次快照就位的等待：成功拉取会唤醒**在它之前注册**的等待者（测试/生产共用）。 */
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
   *  - **空缓存**（=「从未拉到」）⇒ WARN **一次**（1s 重试不再刷屏；成功拉取后复位）；
   *  - **有旧值** ⇒ 继续用旧值（last-good 执法），每次失败各记一条（推送/安全网各有
   *    节奏，不会刷屏）。
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
   * ⇒ 必须独立 `new Redis(...)`，不得复用任何共享实例。**网关这里是重中之重**：
   * 共享 `REDIS` provider 是 SessionGuard/限流/WS 名额**共用实例**，向它 subscribe
   * = 登录验签/限流/名额同时失效（design §四.2）。
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
