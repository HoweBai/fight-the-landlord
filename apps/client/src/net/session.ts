/**
 * 会话装配：把 `GameClient`（传输/契约层）与 `useGameStore`（渲染状态）接起来。
 *
 * 这里只做「搬运 + 分流」，不做任何游戏判断：
 *  - 快照类（game.deal / game.state_update）→ store.applySnapshot（内含 §6.2 丢弃规则）
 *  - 事件类（game.current_turn / finished / settlement / system.error）→ store.applyEvent
 *  - system.warning → 独立订阅：warn notice（message 原样，空则中性兜底），不进 store、永不导航
 *  - 房间类（room.matched / room.state_update）→ store.setRoom / applyRoomState
 *  - 错误码 → net/errors 的 CLIENT_ACTION 执行器
 *
 * 装配函数只接收「回调形状」，不 import pinia store 定义，
 * 这样测试可以直接注入假的 store，而 net 层永远不依赖 UI 层。
 */
import type { GameView, ServerMessage } from '@fight-the-landlord/protocol';
import { CLIENT_ACTION, ClientAction, ErrCode } from '@fight-the-landlord/protocol';
import { GameClient, type ReconnectReason } from './socket';
import type { SnapshotAckResult, SnapshotSource } from './socket';
import { createActionExecutor } from './errors';
import { playerMessage } from './copy';
import { buildSocketAuth } from '../config';
import { ensureFreshAccessToken, type TokenRenewResult } from './token-refresh';
import type { SocketFactory } from './transport';
import type { PlayerEvent } from '../stores/game';

export interface SessionNotice {
  level: 'info' | 'warn' | 'error';
  text: string;
  /** 触发这条提示的错误码（推送/请求路径都给得出；链路类提示没有码）。 */
  code?: number;
  /**
   * 提示的来源（片② D8 / Task 2）：`'action'` = 某个错误码的处置结果（可被 `clearNotice`
   * 清掉），`'transport'` = 链路事实（连接不可用/已恢复），`'system'` = 服务端推送
   * （`system.error` / `system.warning`）。
   * 缺省（`undefined`）视为「非 ACTION 提示」——与 `'transport'` 同待遇。
   */
  source?: 'action' | 'transport' | 'system';
  /** 粘性提示（链路不可用等）：不参与 TTL 自动消失，直到被新值覆盖或显式清除。 */
  sticky?: boolean;
}

export interface RoomPlayerLike {
  id: string;
  seat: number;
  cardCount?: number;
  /**
   * ② 金币场（§2.3）：座位余额——**仅金币场**的 `room.join` ack / `room.state_update`
   * 会带它（免费场/好友房恒缺省 ⇒ 座位显「—」）。store 只消费数字形态。
   */
  balance?: number;
  /**
   * 昵称片：牌桌展示用。缺省 = 服务端不知道（RPC 失败 / 存量用户 / 机器人）
   * ⇒ 页面回落「玩家N」。
   */
  nickname?: string;
}

/**
 * N30①/R455：连不上/恢复的**唯一**文案（页面只读 notice，不自己判断链路）。
 *
 * 文案里必须出现「连接不可用」：这正是 N30① 缺的那句话 —— 旧实现的用户只看到内部的
 * 「匹配失败（code=-1）」，无法区分「服务端拒绝了匹配」与「压根连不上」。
 */
export const CONNECT_UNAVAILABLE_TEXT = '连接不可用，请检查网络后重试';
export const CONNECT_RECOVERED_TEXT = '连接已恢复';

/** 与 net 层的重连原因同构（不另立一套形状，避免类型漂移）。 */
export type SessionReconnectReason = ReconnectReason;

export interface CreateSessionOptions {
  socketFactory: SocketFactory;
  /** 客户端最近一次已应用的 version（CAS 的 baseVersion 来源）。 */
  currentVersion: () => number;
  applySnapshot: (view: GameView) => void;
  applyEvent: (event: PlayerEvent) => void;
  onRoomMatched: (payload: {
    roomCode: string;
    seat: number;
    /** 多玩法（S5.3）：新服务端携带；旧服务端缺失 ⇒ 回落 activeMode/3。 */
    gameType?: 'doudizhu' | 'paodekuai';
    playerCount?: number;
  }) => void;
  onRoomState: (payload: {
    status: string;
    players: RoomPlayerLike[];
    gameType?: 'doudizhu' | 'paodekuai';
    playerCount?: number;
  }) => void;
  /**
   * 机器人补位开关片：`match.wait_prompt`（补机器人开关关、缺人越过等待窗口时的友好提示；
   * **非终止**，票仍在队列）。页面据此给出「重新匹配 / 继续等待」两个动作。
   */
  onMatchWaitPrompt?: (payload: { message: string }) => void;
  /**
   * 记牌器收费片：`game.card_counter`（**按玩家定向**、房间级、version 恒 0）——
   * 本局记牌器是否开通；客户端只按 `active` 渲染。
   */
  onCardCounter?: (payload: {
    roomCode: string;
    active: boolean;
    source?: 'pass' | 'credit' | 'none' | 'unknown';
  }) => void;
  /** 13004 等「就地刷新快照」的处置（§6.5）。 */
  onRefreshSnapshot: () => Promise<void> | void;
  /**
   * 快照类 ack 的处置结果（`applied` / `discarded` / `rollback`）。
   * 「丢弃」时不会调用 `applySnapshot`（没有东西可应用），调用方需要这个回调才能留痕。
   */
  onSnapshotOutcome?: (result: SnapshotAckResult, source: SnapshotSource) => void;
  /** 需要重连 / 需要回大厅的信号（M08）。**经去抖**，用于「重连提示」而非导航。 */
  onReconnect: (reason: SessionReconnectReason) => void;
  /**
   * `CLIENT_ACTION` 表里**要求立即处置**的分支（`BACK_TO_LOBBY` / `RECONNECT`）。
   *
   * 与 `onReconnect` 分开是必须的：那条通道带 1 秒去抖窗口，而回大厅是**导航语义**，
   * 延迟 1 秒既没道理，也会让「补发的信号」在 store 已清空之后再触发一次导航。
   */
  onActionDisposition?: (reason: SessionReconnectReason) => void;
  onNotice?: (notice: SessionNotice) => void;
  endpoint?: string;
  namespace?: string;
  /**
   * 令牌静默旋转后，调用方（auth store）回填 accessToken / refreshToken。
   *
   * WS 恢复路径旋转令牌后，pinia auth store 仍持旧 `(a1, r1)`；
   * 若登出时先轮换再登出，会用已作废的 r1 失败（R35）。
   * 本回调由装配层（useGameSession.ts）注入 `() => auth.syncTokensFromStorage()`。
   */
  onTokensRenewed?: () => void;
}

export interface GameSession {
  client: GameClient;
  disconnect: () => void;
  /**
   * 订阅 `CLIENT_ACTION` 的导航类处置（`BACK_TO_LOBBY` / `RECONNECT`）。
   *
   * 这条通道**不走 `client.onReconnect`**（那条带 1 秒去抖，不适合导航），
   * 因此单独暴露一个观察点：既给 app 层接线，也给测试断言用。
   */
  onDisposition: (handler: (reason: SessionReconnectReason) => void) => () => void;
}

export function createGameSession(options: CreateSessionOptions): GameSession {
  /**
   * Task 2：本层多数提示已改为直接 `options.onNotice?.({...})`（要带 `sticky` 等新字段）；
   * 这个便利函数只留一处调用（`server_rejected` 的 `source:'transport'`）。
   */
  const notice = (
    level: SessionNotice['level'],
    text: string,
    extra?: { code?: number; source?: SessionNotice['source'] },
  ) => options.onNotice?.({ level, text, ...extra });
  const dispositionHandlers: ((reason: SessionReconnectReason) => void)[] = [];
  /** 导航类处置：先通知观察者，再交给 app 层（不去抖）。 */
  const dispose = (reason: SessionReconnectReason) => {
    for (const handler of dispositionHandlers) handler(reason);
    (options.onActionDisposition ?? options.onReconnect)(reason);
  };

  const client = new GameClient({
    endpoint: options.endpoint,
    namespace: options.namespace,
    /**
     * 函数接缝：socket.io-client 4.8.4 在每次引擎层 open（首次连接 + 自动重连 +
     * 手动 `socket.connect()`）前调用，等待 cb 返回后才发 CONNECT 包。
     *
     * 先 `ensureFreshAccessToken()`（预检 + 单飞 refresh），再调 cb 回传最新令牌。
     * `unavailable` 不挂起——带旧令牌继续握手，由服务端 10004 走恢复路径。
     */
    auth: (cb) => {
      void ensureFreshAccessToken()
        .catch((): TokenRenewResult => 'unavailable')
        .then(() => cb(buildSocketAuth()));
    },
    socketFactory: options.socketFactory,
    currentVersion: options.currentVersion,
    onTokensRenewed: options.onTokensRenewed,
    /**
     * N30①/R455：net 层只报「链路事实」，**文案与呈现统一走本层这条 notice 通道**
     * （`notice()` → `options.onNotice`，与 `room.matched` / `server_rejected` 同一条）。
     *
     * ⚠️ 实测：`socket.ts` 里**没有** `onNotice`，它的 `connect_error` 分支此前只
     * `releasePendingAndWakeWaiters()` 就结束了 ⇒ 计划骨架里的 `this.options.onNotice?.(…)`
     * 在 net 层无处可复用；若在 net 层另加一条 notice 通路就是**第二条真源**。
     * 因此线是「socket 发信号 → 会话层写 notice」，与 R166 的 `server_rejected` 同形
     * （「连不上」是**连接层的事实**，与 UI 装配无关，任何只注入 `onNotice` 的宿主都必须收到）。
     */
    onConnectUnavailable: () =>
      options.onNotice?.({
        level: 'error',
        text: CONNECT_UNAVAILABLE_TEXT,
        source: 'transport',
        sticky: true,
      }),
    onConnectAvailable: () =>
      options.onNotice?.({
        level: 'info',
        text: CONNECT_RECOVERED_TEXT,
        source: 'transport',
      }),
  });

  client.on('game.deal', (msg) => {
    options.applySnapshot((msg as Extract<ServerMessage, { type: 'game.deal' }>).payload);
  });

  client.on('game.state_update', (msg) => {
    options.applySnapshot((msg as Extract<ServerMessage, { type: 'game.state_update' }>).payload);
  });

  for (const type of [
    'game.current_turn',
    'game.finished',
    'game.settlement',
    /**
     * ② 金币场（§2.2 的客户端接线落点）：结算时刻三座余额 —— 与上面四条同一通道
     * （事件类，按 `type@version` 幂等）。store 侧三个消费点见 `applyBalances`。
     * ⚠️ **不接这条线 = 消息到达但无源**：结算页金币列会静默缺列。
     */
    'game.balances',
    'system.error',
  ] as const) {
    client.on(type, (msg) => {
      options.applyEvent(msg as PlayerEvent);
    });
  }

  /**
   * 片② D8/J14：推送路径也进 `CLIENT_ACTION` 表 —— `12007`（MATCH_TIMEOUT）此前是条死信
   *（服务端会发、客户端只进 store 的 `notices`，而全仓没有对它的渲染点）。
   *
   * 🔴 推送路径**只**消费「表里处置 = TOAST」或**未登记**的码（导航类不从这里走）：
   * `10002`/`10004`/`12001` 这类 BACK_TO_LOBBY 的**唯一**处置点是请求 ack 路径
   *（ack 里有 `reqId` 与上下文），一条无请求的推送不该把用户拽走。
   * ⚠️ 这一段与上面 `options.applyEvent` 的订阅**并存**（后者给 store 用），不是替换它。
   */
  client.on('system.error', (msg) => {
    const payload = (msg as Extract<ServerMessage, { type: 'system.error' }>).payload;
    const known = Object.prototype.hasOwnProperty.call(CLIENT_ACTION, payload.code);
    if (known && CLIENT_ACTION[payload.code as ErrCode] !== ClientAction.TOAST) return;
    client.reportErrorCode(payload.code, payload.message, 'system');
  });

  /**
   * Task 2：`system.warning` 独立订阅（不再混入 `applyEvent` 的 store 内消费）。
   * 文案 message-first（服务端给则用，空则中性兜底），来源 `system`。
   */
  client.on('system.warning', (msg) => {
    const payload = (msg as Extract<ServerMessage, { type: 'system.warning' }>).payload;
    options.onNotice?.({
      level: 'warn',
      text: payload.message || '请注意，牌局状态有变化',
      code: payload.code,
      source: 'system',
    });
  });

  client.on('room.matched', (msg) => {
    const payload = (msg as Extract<ServerMessage, { type: 'room.matched' }>).payload;
    // 走查修复：匹配成功是**常态流转**（随后直接进牌桌），不再弹常驻绿条；
    // 房间号/座位在牌桌 HUD 与座位卡上都有，提示条是纯噪音。
    options.onRoomMatched(payload);
  });

  client.on('room.state_update', (msg) => {
    options.onRoomState((msg as Extract<ServerMessage, { type: 'room.state_update' }>).payload);
  });

  /**
   * 记牌器收费片：房间级状态消息（version 恒 0）——**显式处理**，不走 `applyEvent`
   * 的 `type@version` 幂等（两个房间的 version 都是 0，会被误判重复）。
   */
  client.on('game.card_counter', (msg) => {
    options.onCardCounter?.(
      (msg as Extract<ServerMessage, { type: 'game.card_counter' }>).payload,
    );
  });

  // 机器人补位开关片：缺人友好提示（匹配级、非终止；文案由服务端给，页面只呈现 + 两个动作）。
  client.on('match.wait_prompt', (msg) => {
    const payload = (msg as Extract<ServerMessage, { type: 'match.wait_prompt' }>).payload;
    options.onMatchWaitPrompt?.(payload);
  });

  /**
   * 每个错误码都走 CLIENT_ACTION 表（§11）：
   *  - REFRESH_SNAPSHOT（`13004`/`13007`/`13009`）→ `game.resync` 就地重拉裁剪快照，
   *    **绝不**触发断线重连、**绝不**用 `game.reconnect` 冒充（§6.5 逐字）
   *  - BACK_TO_LOBBY（含 `13005` 对局已结束、`13010` 没有任何可恢复凭据）→ 回大厅 + 提示
   *  - RECONNECT → 当前表中没有任何错误码映射到它（§6.5 刻意如此）；保留分支以防表变更
   *  - TOAST → 展示；IGNORE → 静默
   */
  client.onAction(
    createActionExecutor({
      ignore: () => {},
      refreshSnapshot: () => {
        // Task 2：中性文案（不再向玩家输出内部处置名/诊断串）。
        options.onNotice?.({ level: 'warn', text: '牌局状态有更新，正在同步…', source: 'action' });
        void Promise.resolve(options.onRefreshSnapshot()).catch(() => {
          options.onNotice?.({ level: 'error', text: '同步失败，请重试', source: 'action' });
        });
      },
      reconnect: () => {
        // `RECONNECT` 是**处置**（当前表里没有码映射到它，保留以防表变更）→ 立即通道
        dispose({
          kind: 'action_reconnect',
          version: options.currentVersion(),
          message: '正在重新连接…',
        });
      },
      toast: (report) => {
        // 统一文案表（message-first + 固定表 + 中性兜底）；来源随上报路径走。
        options.onNotice?.({
          level: 'error',
          text: playerMessage(report.code, { context: 'action', serverMessage: report.message }),
          code: report.code,
          source: report.source ?? 'action',
        });
      },
      backToLobby: (report) => {
        /**
         * `BACK_TO_LOBBY`（13005 对局已结束 / 13010 没有可恢复的对局 / 11003 封禁 /
         * 10002·10004·10005 登录失效 / 11004 账号不存在 / 12001·12004·12008 房间类拒绝）
         * 的玩家文案一律来自统一文案表 `copy.ts` —— 不再有诊断串兜底
         *（诊断串只允许进 reporter/日志，规格「UI 禁止引用」）。
         */
        const text = playerMessage(report.code, {
          context: 'action',
          serverMessage: report.message,
        });
        // 提示 + 回大厅。`13010`（没有任何可恢复凭据）与 `13005`（对局已结束）都落这里。
        // ⚠️ 这是**错误码处置** ⇒ 必须带 `source: 'action'`（`clearNotice()` 才能清掉；
        // 否则「没有可恢复的对局」会永久滞留在页面顶部，2026-10-18 用户提问时发现）。
        options.onNotice?.({ level: 'warn', text, code: report.code, source: 'action' });
        // `BACK_TO_LOBBY`（含 13010/13005）是**导航处置** → 立即通道，不进去抖窗口
        dispose({
          kind: 'back_to_lobby',
          version: options.currentVersion(),
          message: text,
          code: report.code,
        });
      },
    }),
  );

  client.onReconnect((reason) => {
    /**
     * R166 / N15：`server_rejected` 的**文案**在会话层就发出去，**不**留给某个调用方。
     *
     * 为什么必须在这里（而不是只在 `useGameSession` 的 `onReconnect` 分支里）：
     * 「被服务端踢线」是**连接层的事实**，与 UI 装配无关 —— 任何调用方（含只注入
     * `onNotice` 的宿主/测试装配）都必须收到这条终止性提示。`useGameSession` 那边
     * 另外负责「**不**导航」的处置（`app 层`才有导航能力）。
     * 两处的文案**逐字相同**，且 UI 的 notice 是「后写覆盖」，因此不会出现两条提示。
     */
    if (reason.kind === 'server_rejected') notice('error', reason.message, { source: 'transport' });
    options.onReconnect(reason);
  });

  // 快照类 ack（game.resync / game.reconnect）同样走 §6.2 的快照丢弃规则
  client.onSnapshot((view) => {
    options.applySnapshot(view);
  });

  // 「丢弃」时不调用 applySnapshot，处置结果单独播报（见 CreateSessionOptions.onSnapshotOutcome）
  client.onSnapshotOutcome((result, source) => {
    options.onSnapshotOutcome?.(result, source);
  });

  client.connect();

  return {
    client,
    disconnect: () => client.destroy(),
    onDisposition: (handler) => {
      dispositionHandlers.push(handler);
      return () => {
        const i = dispositionHandlers.indexOf(handler);
        if (i >= 0) dispositionHandlers.splice(i, 1);
      };
    },
  };
}
