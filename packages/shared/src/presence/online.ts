/**
 * 在线 presence 的共享契约（2026-10-22 玩家管理页）：
 * room-service 写、user-service 读；Redis ZSET `presence:online`
 * （member = userId，score = 最后心跳 epoch ms）。
 *
 * ⚠️ 必须经 barrel 导出（本包无 `exports` 映射，不能深路径导入）。
 * ⚠️ 键名/窗口是跨服务单一真源：room 与 user 不得各自拼字符串。
 */
export const ONLINE_USERS_KEY = 'presence:online';

/** 在线判定窗口：最后心跳距今 ≤ 60s（socket.io pingInterval=30s，可容忍一次丢包）。 */
export const ONLINE_TTL_MS = 60_000;

/** 过期成员清理阈值：统计任务每 5 分钟删除超过 5 分钟未心跳的成员。 */
export const ONLINE_PRUNE_MS = 5 * 60_000;

/** 玩家汇总快照键（user-service 统计任务写，列表请求读；TTL 10 分钟）。 */
export const PLAYERS_SUMMARY_KEY = 'players:summary';
