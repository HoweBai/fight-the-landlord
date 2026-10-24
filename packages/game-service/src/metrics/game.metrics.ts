// packages/game-service/src/metrics/game.metrics.ts
import { createGauge } from '@fight-the-landlord/shared';

/**
 * ⚠️ **显式注解**（不是从推断来）：`createGauge` 的返回类型在 .d.ts 里若走推断，会引用
 * `shared/node_modules/prom-client` 的**非便携路径**（TS2742 —— 而 `prom-client`
 * **不是** game-service 的依赖，不能直接 import 它的类型）。
 * `ReturnType<typeof …>` 的注解既保住完整类型（prom-client 的方法面都在），又只引用
 * 本包可见的符号 ⇒ 声明产物便携。（与 room-service 的 `room.metrics.ts` 同款处置。）
 */
type GaugeOf = ReturnType<typeof createGauge>;

/**
 * 活跃对局会话数（监控片 · 规格 §2.2）。
 *
 * 🔴 **per-instance 语义**（规格写死，HELP 已注明）：读数 = `GameService` 的
 * **进程内缓存**大小（`activeSessionCount()` = `cache.size`，`game.service.ts:77`）——
 * 会话真源在 Redis（多实例共享），但 `cache` 是各实例自己的 ⇒ 多实例部署时本指标是
 * **每实例各自的值**，面板/告警须按实例求和（或对 `sum by ()` 聚合）。
 * ⚠️ 与 room-service 的 `rooms_active`（全栈口径：Redis SCAN 聚合）**刻意不同** ——
 * 会话表目前没有便宜的全量真源读取形态，本片不改存储面（规格 §2.2 行已登记该差异）。
 */
export const gamesActive: GaugeOf = createGauge(
  'games_active',
  'game-service 本实例内存缓存中的活跃对局会话数（**per-instance** 语义：多实例部署时各实例各报自己的 cache.size）。',
);
