import { createCounter, createGauge } from '@fight-the-landlord/shared';

/**
 * 玩家/营收指标（2026-10-22；Grafana 08 看板）。
 * ⚠️ 必须走 shared 构造器 + `ReturnType<typeof ...>` 注记（否则落 globalRegistry 或 TS2742）。
 */
export const userRegistrationsTotal: ReturnType<typeof createCounter> = createCounter(
  'user_registrations_total',
  '注册成功计数（账号创建且绑定闸通过后的成功返回点；失败路径不计）。',
);

export const playersTotal: ReturnType<typeof createGauge> = createGauge(
  'players_total',
  '玩家账号总数（统计任务每 5 分钟覆盖写）。',
);
export const playersActive1d: ReturnType<typeof createGauge> = createGauge(
  'players_active_1d',
  '近 1 天活跃玩家数（canonical lastActiveAt）。',
);
export const playersActive7d: ReturnType<typeof createGauge> = createGauge(
  'players_active_7d',
  '近 7 天活跃玩家数（canonical lastActiveAt）。',
);
export const playersActive30d: ReturnType<typeof createGauge> = createGauge(
  'players_active_30d',
  '近 30 天活跃玩家数（canonical lastActiveAt）。',
);
export const playersInactive14d: ReturnType<typeof createGauge> = createGauge(
  'players_inactive_14d',
  '14 天未活跃玩家数（排除注册不足窗口且从未活跃的账号）。',
);
export const playersInactive30d: ReturnType<typeof createGauge> = createGauge(
  'players_inactive_30d',
  '30 天未活跃玩家数（排除注册不足窗口且从未活跃的账号）。',
);
export const playersOnlinePresence: ReturnType<typeof createGauge> = createGauge(
  'players_online_presence',
  '当前在线玩家数（Redis presence:online，最后心跳 ≤60s）。',
);
