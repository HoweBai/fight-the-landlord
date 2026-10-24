// packages/room-service/src/match/match-keys.ts
/**
 * `match:pending` 的**叶子模块**（片⑦ 修复 · slice12-race-fix-design §1「消环」）。
 *
 * ⚠️ 为什么单独一个文件（**无任何导入**的叶子）：
 *  - 本片起 `rooms.start.ts`（写凭据）与 `ws.gateway.ts`（连接补推）**都要**读写这个键；
 *  - 而它们一旦从 `match.service.ts` 导入就会构成 **CJS 模块环** —— `match.service.ts`
 *    以**值导入**引 `RoomStartService`（DI 元数据，`match.service.ts` 顶部），
 *    新边 `rooms.start → match.service` 会环回来；
 *  - 环的失败模式是**加载序相关的启动崩**（DI 陷阱家族）：单测与 `tsc` 都看不见，
 *    **只有真容器会红**。
 * ⇒ 键名 / TTL / 形状落在叶子里；`match.service.ts` 照旧 **re-export**
 *（`message.router.ts` 等既有导入面一行不改）。
 */

/** §10.4：匹配结果与匹配元数据一样保留 300s。 */
export const MATCH_PENDING_TTL_SECONDS = 300;

/** §10.1/§8.2：开局结果，供错过 `room.matched` 的客户端（经 `game.reconnect`）
 *  与连接建立时的网关补推（`WsGateway`）补回。写入者 = `RoomStartService.startRoom`
 *  的单一来源（**一切开局**，仅人类座位，R47）。 */
export function matchPendingKey(playerId: string): string {
  return `match:pending:${playerId}`;
}

/** §8.2：开局后写入的结果（**只有**这两个字段，R42）。 */
export interface PendingMatch {
  roomCode: string;
  seat: number;
}
