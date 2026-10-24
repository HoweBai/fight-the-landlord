/**
 * 对局会话的单例装配（app 层）。
 *
 * 把 `createGameSession` 与 pinia store 接起来，并集中处理：
 *  - 匹配成功 → 进牌桌
 *  - 快照回退 / 需要回到大厅 → 切页
 *  - 13004 → 就地刷新快照（**不重连**，§6.5）
 *
 * 页面只通过 `useGameSession()` 拿到 client 与提示，不直接碰 net 细节。
 */
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import type { GameType } from '@fight-the-landlord/protocol';
import { isGameType } from '@fight-the-landlord/protocol';
import type { SocketFactory } from '../net/transport';
import type { ConnectionState, RequestOutcome } from '../net/socket';
import {
  createGameSession,
  type CreateSessionOptions,
  type GameSession,
  type RoomPlayerLike,
  type SessionNotice,
  type SessionReconnectReason,
} from '../net/session';
import { useGameStore } from '../stores/game';
import { bindAuthRuntime, useAuthStore } from '../stores/auth';
import { startAppVisibility, type VisibilityController } from './useAppVisibility';
import { startIdleWatch, type IdleWatchController } from './useIdleWatch';
import { createSessionNoticeController } from './sessionNotice';

/**
 * 进房是**自动路径**（`room.matched` → `room.join`），配额显式写死在这里：
 * 改 `sendQueued` 的默认值**不得**静默改变进房语义（R60）。
 */
const JOIN_MAX_ATTEMPTS = 5;

export interface GameSessionHandle {
  client: ReturnType<typeof createGameSession>['client'];
  /** 订阅 `CLIENT_ACTION` 的导航类处置（走立即通道，不进去抖窗口）。 */
  onDisposition: GameSession['onDisposition'];
  notice: Ref<SessionNotice | null>;
  /**
   * 片② D8：清掉**当前**那条「动作来源」的提示（玩家重开匹配时调用）。
   * 链路类提示（`source:'transport'`）与其余来源不受影响。
   */
  clearNotice: () => void;
  /** 销毁会话时清掉 notice 的 TTL timer（`stopGameSession` 在 `disconnect()` 之前调用）。 */
  disposeNotice: () => void;
  disconnect: () => void;
  /**
   * 项 2：连接相位（connected / reconnecting / dead）的响应式镜像。
   * 牌桌的 `ConnectionOverlay` 只读它；手动重连走 `client.retryConnect()`。
   */
  connectionState: Ref<ConnectionState>;
}

let handle: GameSessionHandle | null = null;

/**
 * **响应式**的当前会话句柄（2026-10-13 修复「换会话后旧死态/旧提示残留」）。
 *
 * `getGameSession()` 是**非响应式**的（动作调用专用）。组件若在 `computed` 里直接调它，
 * 首次求值会把**旧会话的 ref** 记为唯一依赖 —— 换会话（`restartGameSession()`）只改模块变量，
 * 不触发任何响应式更新 ⇒ 旧会话的死态/提示**永久钉在 UI 上**。
 *
 * 实测显影路径（App 首登必现，H5 被换页时序掩盖）：冷启动的**匿名**会话被网关拒
 * （`10002 missing auth.token`，设计如此）⇒ 登录成功重建会话、新连接完全健康，玩法页却仍显示
 * 「服务端拒绝该连接（code=10002）：已停止自动重连」+ 死态横条；**退出重登即消失**。
 *
 * ⇒ **纪律：组件读会话状态（notice / connectionState）一律走本 ref，不得在 `computed`
 *   里直接 `getGameSession()`**（动作调用不受此限）。回归判据在 `connection-dead.test.ts`
 *   的「换会话 ⇒ 横条消失」。
 */
export const currentSession: ShallowRef<GameSessionHandle | null> = shallowRef(null);

/**
 * 入口注入的工厂，**记住**它供登录/登出后重建会话使用。
 *
 * ⚠️ 工厂必须由外部注入（net 层不 import socket.io-client），因此这里只能记引用；
 * 也**不要**从 `main.ts` 导出它——`main.ts → App.vue → login.vue → main.ts`
 * 会构成入口模块循环依赖。
 */
let storedFactory: SocketFactory | null = null;

/**
 * 回前台令牌续期的可见性控制器（模块级单例，**不 stop**）。
 *
 * 冷启动 / App 息屏隔夜后 access token 过期，回前台时触发
 * `renewHydratedSession()` 预检（本地 JWT exp 未过期则零请求），避免用户
 * 回前台后第一次操作才拿到 10004。
 *
 * 生命周期与 app 同长：`startGameSession()` 首次调用时挂上，
 * 后续 `restartGameSession()` / `stopGameSession()` 不清理，
 * 回前台续期不依赖任何会话句柄。
 */
let visibilityController: VisibilityController | null = null;

/**
 * 应用层空闲超时控制器（与会话同生命周期）。
 * 非对局状态 + 25min 空闲时主动断开 socket，节省电量与连接槽位。
 * stopGameSession 时一并 stop（会话重建时 startGameSession 会重新 start）。
 */
let idleWatchController: IdleWatchController | null = null;

export function getGameSession(): GameSessionHandle {
  if (!handle) throw new Error('会话尚未建立：请先调用 startGameSession()');
  return handle;
}

export function isGameSessionReady(): boolean {
  return handle !== null;
}

/**
 * 销毁本地 WS 会话。
 *
 * ⚠️ **同时复位 game store**（R419/N30②）：会话没了 ⇒ 本地那份「对局渲染状态」也失去意义。
 * 不复位的实测后果：用户在 `matching=true` 时点「退出」→ 回登录页 → 再登录任意账号，
 * 开始游戏页直接是「正在匹配…」+「取消匹配」，**没有「开始游戏」可点**（须先点一次「取消匹配」）。
 * `matching` 由 store 持有（R49），页面只读它 ⇒ 只有 store 复位才能修掉。
 *
 * ⚠️ 这一处覆盖**三条**路径：`signOut()` 与 REST `BACK_TO_LOBBY`（两者都经 `clearLocalSession()`
 * 的 R36 钩子）以及 `restartGameSession()`（登录后重建）。后者顺带复位是**正确**的语义 ——
 * 刚登录的会话不存在任何对局。
 */
export function stopGameSession(): void {
  idleWatchController?.stop();
  idleWatchController = null;
  handle?.disposeNotice();
  handle?.disconnect();
  handle = null;
  currentSession.value = null;
  useGameStore().reset();
}

/**
 * 用**当前**的令牌重建会话（登录成功、登出之后调用）。
 *
 * 登录前可能已有一个匿名/开发身份的会话，`stopGameSession()` 会先把它销毁，
 * 新连接的握手才会用上刚写入 `clientConfig.token` 的令牌（§5.1）。
 */
export function restartGameSession(): GameSessionHandle {
  if (!storedFactory) throw new Error('会话尚未初始化：请先调用 startGameSession()');
  const socketFactory = storedFactory;
  stopGameSession();
  return startGameSession(socketFactory);
}

/** 会话装配产出的东西：给 `createGameSession` 的选项 + UI 要用的提示 ref。 */
export interface GameSessionOptions {
  options: CreateSessionOptions;
  notice: Ref<SessionNotice | null>;
  setSessionNotice: (n: SessionNotice | null) => void;
  clearActionNotice: () => void;
  disposeNotice: () => void;
}

/**
 * 构建会话装配的**全部接线**（可导出、可测试）。
 *
 * ⚠️ 存在的理由：这是 `de13b2b` 那批行为（`back_to_lobby` → `store.reset()`、
 * `REFRESH_SNAPSHOT` → `resync()`、两条 notice、导航守卫）的**唯一**落点。
 * 如果测试另抄一份选项对象，生产接线就没人覆盖了——回归会直接通过 CI。
 *
 * `sessionRef` 用来打破循环：`onRefreshSnapshot` 需要拿到 `session.client`，
 * 而 session 又是由这份 options 创建出来的。调用方创建后把 session 填进去即可。
 *
 * 每项处置都必须可追溯到契约：
 *  - `REFRESH_SNAPSHOT`（`13004`/`13007`/`13009`）→ `game.resync`，**不得**用 `game.reconnect`（§6.5）
 *  - `BACK_TO_LOBBY`（含 `13005`/`13010`）→ 提示 + 回大厅 + 清空对局渲染状态
 *  - 快照类 ack 的「丢弃」→ 在 store 里留痕（§6.2 / M02）
 */
export function createSessionOptions(
  socketFactory: SocketFactory,
  sessionRef: { client?: GameSession['client'] },
): GameSessionOptions {
  const store = useGameStore();
  const auth = useAuthStore();
  const noticeCtl = createSessionNoticeController();
  const notice = noticeCtl.notice;
  const setSessionNotice = noticeCtl.set;
  const clearActionNotice = noticeCtl.clearAction;
  const disposeNotice = noticeCtl.dispose;

  /** 只在「确实还有一局在对局中」时才切回牌桌。 */
  const canShowTable = (): boolean => store.roomCode !== null && store.view !== null;

  /**
   * R50 / §8.2：**收到 `room.matched` 后必须 `room.join`**，且只有 ack `code 0` 才进牌桌。
   *
   * 不 join 的后果（旧实现的真实缺陷）：服务端不写 `reconnect:active`、
   * `socket.join(roomCode)` 从不发生、`room.join` ack 里的 `players` 从不被消费。
   *
   * ⚠️ 尝试配额用尽仍被串行队列占着时**不导航、也不自动重试**（R60）。这里**没有丢局**：
   * 服务端此刻已经写了 `match:pending:{playerId}` 与 `reconnect:active`，用户刷新或断线重连
   * 会走 §6.6/§8.2 的补回路径把这一局找回来。在这里自动重试反而会和 `CLIENT_ACTION`
   * 强制的恢复请求（`13004` → `game.resync`）抢串行队列，得不偿失。
   */
  async function joinMatchedRoom(roomCode: string, gameType: GameType): Promise<void> {
    const client = sessionRef.client;
    if (!client) return;
    let outcome: RequestOutcome;
    try {
      // S5.3：所有 `room.join` 都带 gameType（旧服务端忽略；pdk 房缺它会被 12012 拒）。
      outcome = await client.sendQueued('room.join', { roomCode, gameType }, JOIN_MAX_ATTEMPTS);
    } catch {
      return; // 会话已被拆除（登出/销毁）：不导航、不提示
    }
    if (outcome.status !== 'sent') {
      setSessionNotice({ level: 'warn', text: '进房失败，请重试', source: 'action' });
      return;
    }
    if (outcome.code !== 0) {
      // 非 0 已由 CLIENT_ACTION 表派发（12004/12001 → BACK_TO_LOBBY）。
      // 这里只保证「被拒就不导航、不留下半个房间状态」。
      store.reset();
      return;
    }
    /**
     * R61：**不伪造服务端没给的状态**。`room.join` 的 ack 载荷只有
     * `{ roomCode, seat, players }` —— 没有 `status`（那是 `room.state_update` 的字段）。
     * 早先在这里硬编码 `status: 'playing'` 是在替服务端下结论。
     */
    const data = outcome.data as { players?: RoomPlayerLike[] } | undefined;
    store.applyRoomState({ players: data?.players ?? [] });
    auth.navigate('table');
  }

  const options: CreateSessionOptions = {
    socketFactory,
    currentVersion: () => store.currentVersion,
    applySnapshot: (view) => {
      const outcome = store.applySnapshot(view);
      if (outcome === 'rollback') {
        setSessionNotice({ level: 'warn', text: '牌局状态有更新，正在同步…', source: 'transport' });
      }
    },
    onSnapshotOutcome: (result) => {
      // 「丢弃」（version === 当前）没有东西可应用，但 UI 仍要留痕（§6.2 / M02）
      if (result.status === 'discarded') store.recordSnapshotOutcome('discarded');
    },
    applyEvent: (event) => {
      store.applyEvent(event);
    },
    onRoomMatched: (payload) => {
      /**
       * S5.3：`room.matched` 带 gameType/playerCount（旧服务端缺这两个字段 ⇒ 回落
       * `activeMode`/3）。自动 join 必须原样回传 gameType —— pdk 房缺它会被 12012 拒。
       */
      const gameType: GameType = payload.gameType ??
        (isGameType(store.activeMode) ? store.activeMode : 'doudizhu');
      store.setActiveMode(gameType);
      store.setPlayerCount(payload.playerCount ?? 3);
      // 先记住房间号：重连、离开、`game.resync` 的兜底都要用它（§8.2）。
      store.setRoom(payload.roomCode, payload.seat);
      // R49：已成局 → 匹配中状态终止（大厅按钮不再是「正在匹配…」）
      store.setMatching(false);
      // R50：§8.2 —— 收到推送后**主动进房**，成功才导航。
      void joinMatchedRoom(payload.roomCode, gameType);
    },
    onRoomState: (payload) => {
      // 房态推送同样携带玩法/人数（旧服务端缺省 ⇒ 不清写）。
      if (payload.gameType) store.setActiveMode(payload.gameType);
      if (typeof payload.playerCount === 'number') {
        store.setPlayerCount(payload.playerCount);
      }
      store.applyRoomState(payload);
    },
    // 记牌器收费片：本局开通状态（房间级；按 roomCode 存，渲染时比较当前房）。
    onCardCounter: (payload) => {
      store.applyCardCounterStatus(payload);
    },
    // 机器人补位开关片：缺人友好提示 → store 悬浮卡片态（页面呈现「重新匹配 / 继续等待」）。
    onMatchWaitPrompt: ({ message }) => {
      store.showMatchWaitPrompt(message);
    },
    onRefreshSnapshot: async () => {
      // §6.5：13004 / 13007 / 13009 的唯一处置——走 game.resync 重拉裁剪快照，由用户重新发起操作。
      // **不得**改用 game.reconnect（§6.5 逐字禁止）。
      const result = await sessionRef.client!.resync();
      if (result.status === 'applied') {
        setSessionNotice({ level: 'info', text: '已同步到最新状态，请重新操作。', source: 'action' });
      }
    },
    /**
     * `CLIENT_ACTION` 的导航类处置（`BACK_TO_LOBBY` / `RECONNECT`）：**立即**执行，
     * 不进去抖窗口。`13010`（没有任何可恢复凭据）与 `13005`（对局已结束）都走这里。
     */
    onActionDisposition: (reason: SessionReconnectReason) => {
      // ⚠️ 带 `source: 'action'`（与 session.ts 的 backToLobby 一致）：这是错误码处置，
      // 必须可被 `clearNotice()` 清掉 —— 否则「没有可恢复的对局」会永久滞留（2026-10-18）。
      setSessionNotice({
        level: 'warn',
        text: reason.message,
        ...(reason.code !== undefined ? { code: reason.code } : {}),
        source: 'action',
      });
      store.reset();
      auth.navigate('lobby');
    },
    onReconnect: (reason: SessionReconnectReason) => {
      /**
       * R166 / N15：`server_rejected` 是**终止性**信号（服务端踢线）——
       * 只给明确提示，**不导航**：回到牌桌只会得到一张连不上的桌子。
       */
      if (reason.kind === 'server_rejected') {
        setSessionNotice({ level: 'error', text: reason.message, source: 'transport' });
        return;
      }
      setSessionNotice({ level: 'warn', text: reason.message, source: 'transport' });

      if (reason.kind === 'snapshot_unavailable') {
        // 链路回来了但没取回快照：只提示，**不做导航**（宁可留在原地也不要跳到空牌桌）
        return;
      }
      /**
       * ⚠️ **陈旧导航守卫**（修复轮 1/2 / I2、R17）：每个导航分支都必须先确认
       * 「确实还有一局在对局中」。
       *
       * 去抖窗口会把在窗口内到达的信号**补发**，`socket_reconnect` 也不例外——
       * `version_rollback` 先开窗，它就被记进 `pendingReconnectReason`，1 秒后才补发。
       * 若这 1 秒内 `13010`/`13005` 的处置已经 `store.reset()` 回过大厅，补发时 store
       * 是空的，直接 `navigate('table')` 会把用户拽到一张空牌桌。
       *
       * `back_to_lobby` 之类的处置走 `onActionDisposition`，根本不会到这里。
       */
      if (canShowTable()) auth.navigate('table');
    },
    onNotice: (n) => {
      setSessionNotice(n);
    },
    onTokensRenewed: () => {
      useAuthStore().syncTokensFromStorage();
    },
  };

  return { options, notice, setSessionNotice, clearActionNotice, disposeNotice };
}

/**
 * 建立会话。`socketFactory` 必须由入口注入（生产用 socket.io-client，
 * 测试用假 socket）——net 层不自己 import socket.io-client。
 */
export function startGameSession(socketFactory: SocketFactory): GameSessionHandle {
  storedFactory = socketFactory;
  // R36：把「销毁本地 WS 会话」的钩子交给 auth store（`clearLocalSession()` 里调用）。
  // 绑定放在 `handle` 的早退之前：重启会话时钩子仍指向同一个 stopGameSession。
  bindAuthRuntime({ stopSession: stopGameSession });
  if (handle) return handle;

  // 回前台预检（不 stop，生命周期与 app 同长）：息屏隔夜后 access token 过期，
  // 回前台时本地 JWT exp 预检，新鲜则零请求，过期则单飞 refresh。
  // 首次调用时挂上；`restartGameSession` 不清理，控制器继续工作。
  if (!visibilityController) {
    visibilityController = startAppVisibility();
    visibilityController.onShow(() => {
      void useAuthStore().renewHydratedSession();
    });
  }

  const sessionRef: { client?: GameSession['client'] } = {};
  const { options, notice, clearActionNotice, disposeNotice } = createSessionOptions(
    socketFactory,
    sessionRef,
  );
  const session = createGameSession(options);
  sessionRef.client = session.client;

  // 应用层空闲超时：非对局状态 + 25min 空闲 → 主动断开 socket
  // （对局中豁免，避免打断对局；前后台暂停在 useIdleWatch 内部处理）
  const store = useGameStore();
  idleWatchController = startIdleWatch({
    client: session.client,
    isInGame: () => store.view !== null || store.roomCode !== null,
  });

  // 项 2：连接相位的响应式镜像（初值取 client 当前快照，之后随订阅更新）。
  const connectionState = ref<ConnectionState>(session.client.connectionState);
  session.client.onConnectionState((state) => {
    connectionState.value = state;
  });

  // store 侧的 version 回退信号 → 主动重连（M08/§6.6）：携带客户端**已应用**的 version（M03）
  store.bindRuntime({
    reconnect: () => {
      void session.client.reconnect(store.currentVersion);
    },
  });

  /** 片② D8：只清「ACTION 来源」的那条 notice（连接不可用那条带 source:'transport'，不受影响）。 */
  const clearNotice = () => {
    clearActionNotice();
  };

  handle = {
    client: session.client,
    onDisposition: (handler) => session.onDisposition(handler),
    notice,
    clearNotice,
    disposeNotice: () => disposeNotice(),
    connectionState,
    disconnect: () => {
      session.disconnect();
      handle = null;
      currentSession.value = null;
    },
  };
  currentSession.value = handle;
  return handle;
}
