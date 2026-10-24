/**
 * 应用层空闲超时断连（客户端）。
 *
 * 动机（slice-p27 / commit-2）：
 *  - engine.io 心跳 30s / pingTimeout 90s，**纯引擎层**的空闲连接 90s 就被回收——
 *    只要手机活着、应用在前台，客户端就会响应 ping，引擎层连接一直健康；
 *  - 但「用户挂在大厅、25 分钟没碰屏幕」这种场景下，连接层的心跳还在白白跑，
 *    对手机侧是无谓心跳 + 服务端是无谓连接槽位占用。
 *  - 本模块在**非对局状态**（`gameStore.view === null`）下，用 25 分钟应用层空闲
 *    主动断开 socket 连接。对局中（有 view 或 roomCode）不踢，避免打断对局。
 *
 * 前后台处理：
 *  - 切后台（visibilitychange false）⇒ 暂停计时（后台时间不算空闲）；
 *  - 回前台 ⇒ 立即重置计时器 + 立即检查一次（如果前后台时间加起来 > 25min 则立即断）。
 *
 * 与其他模块的边界：
 *  - 不在 net 层（GameClient 只暴露 `lastActivity` 只读 getter + `disconnect()`）；
 *  - 不侵入 store（只消费只读状态 `view` / `roomCode`）；
 *  - 不做「用户交互活动」监听（太侵入）——只靠"收发应用帧"判定。
 */

import { onUnmounted } from 'vue';
import type { GameClient } from '../net/socket';
import { startAppVisibility } from './useAppVisibility';

/** 空闲判定阈值：25 分钟。单位 ms。 */
export const IDLE_TIMEOUT_MS = 25 * 60 * 1000;

/** 检查周期：每 60 秒跑一次判定。 */
const CHECK_INTERVAL_MS = 60_000;

export interface IdleWatchOptions {
  client: GameClient;
  /** 判定「是否在对局中」的函数——返回 true 时豁免空闲断连。 */
  isInGame: () => boolean;
  /** 自定义 now()（测试用）。 */
  now?: () => number;
}

export interface IdleWatchController {
  /** 停止计时器并注销前后台监听。 */
  stop(): void;
  /** 手动触发一次空闲判定（回前台时调用）。 */
  checkNow(): void;
}

export function startIdleWatch(opts: IdleWatchOptions): IdleWatchController {
  const { client, isInGame, now = () => Date.now() } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  const check = (): void => {
    const activity = client.lastActivity;
    // 会话刚创建，还没稳定，跳过
    if (activity === 0) return;
    // 引擎层没连或已死态，不用管——重连链会自己处理
    if (!client.connected) return;
    // 对局中豁免
    if (isInGame()) return;
    // 暂停中（后台）：当前不算空闲
    if (paused) return;

    const idleMs = now() - activity;
    if (idleMs >= IDLE_TIMEOUT_MS) {
      // 断连后重连由既有重连链处理（give-up 22 次兜底）
      client.disconnect();
    }
  };

  const handleShow = (): void => {
    if (paused) paused = false;
    // 回前台立即检查——前后台加起来可能已超时
    check();
  };

  const handleHide = (): void => {
    if (!paused) paused = true;
  };

  // 计时器（仅在前台运行，后台由 paused 门住）
  timer = setInterval(check, CHECK_INTERVAL_MS);

  // 前后台监听（复用已有基础设施：uni.onAppShow/Hide + document.visibilitychange）
  const visibility = startAppVisibility();
  const offShow = visibility.onShow(handleShow);
  const offHide = visibility.onHide(handleHide);

  const controller: IdleWatchController = {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      offShow();
      offHide();
      visibility.stop();
    },
    checkNow: check,
  };

  return controller;
}

/**
 * 组件层封装（setup 期自动启动、卸载时自动 stop）。
 * 入口（main.ts / useGameSession）用 `startIdleWatch` 手动管理。
 */
export function useIdleWatch(opts: IdleWatchOptions): void {
  const ctrl = startIdleWatch(opts);
  onUnmounted(() => ctrl.stop());
}
