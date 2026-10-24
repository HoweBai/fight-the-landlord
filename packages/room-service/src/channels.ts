/**
 * room-service 内部的 Redis pub/sub 频道名（**单一真源**）。
 *
 * ⚠️ 为什么单独一个文件：这两个名字原先**各声明过两份**（`match.service` 与 `ws.gateway`），
 * 而「开局」这条链抽到 `rooms/rooms.start.ts` 之后，它若从 `ws.gateway` 取常量就会
 * 形成 `rooms → gateway → match → rooms` 的**环**（Nest 报循环依赖）。
 * ⇒ 把频道名放到这层「谁都不依赖」的地方，三方各取所需。
 */
export const CHANNELS = {
  /** 匹配成功 / 超时通知（§8.2 / R46）：`match.service` 发布，`ws.gateway` 订阅后下发。 */
  matchEvents: 'match:events',
  /** 对局状态变更（§4.4）：game-service → room-service。 */
  gameEvents: 'game:events',
} as const;
