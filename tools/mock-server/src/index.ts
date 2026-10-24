/**
 * Mock 服务 —— 让前端在后端就绪之前就能开发。
 *
 * 两条设计原则（也是它的全部价值）：
 *  1. **与契约同源**：每个出站消息都过 `validateOutbound()`，mock 自己先被契约约束住，
 *     这样前端对 mock 开发出来的东西，对真实后端同样成立。
 *  2. **严格裁剪**：只按座位发对应的 `PlayerView`，他人只有张数。
 *
 * 它**不是**规则实现：不校验牌型、不判规则。真实规则在 game-service。
 *
 * 用法：
 *   pnpm --filter @fight-the-landlord/mock-server build
 *   PORT=3400 node tools/mock-server/dist/index.js
 * 前端把 socket 的 URL 指到 `http://localhost:3400`，namespace 与真实一致（`/ws/ddz`）。
 *
 * 现在它还带**两条只读 REST**（`GET /api/config` · `GET /api/rooms`），
 * 与 WS 共用同一个端口 —— 客户端不需要为 mock 配第二套端点。
 *（片⑦ 起旧端点 `GET /api/base-score-levels` 退役，收编为 `GET /api/config` 的配置子集；
 *  ② 金币场起该子集 = 七键（金币场口径）。⚠️ 支付片起真契约已扩到 14 键、mock 未跟（自含开发
 *  工具、无红；对着 mock 开发钱包页前需先补七支付键——登记见 progress.md T5⑤/T16b）。）
 */

import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  ErrCode,
  validateOutbound,
  validateClientMessage,
  CAS_MESSAGES,
  type Ack,
  type ClientMessage,
  type ServerMessage,
} from '@fight-the-landlord/protocol';
import { ScriptedGame, MOCK_ROOM_CODE, type Transition } from './scripted-game';
import { installRest, type RoomInfoLike } from './rest';

const PORT = Number(process.env.PORT ?? 3400);
const FILLER_IDS = ['p_mock01', 'p_mock02'];

interface GameEntry {
  game: ScriptedGame;
  seats: Map<string, number>;   // userId → seat
  /** 这次匹配带来的底分（协议② 的 `room.match.payload.baseScore`）—— `GET /api/rooms` 报真值要用它。 */
  baseScore: number;
}

const games = new Map<string, GameEntry>();

/**
 * ⚠️ **不能写成 `new Server(PORT, …)`**（2026-09-27 实测）：socket.io@4.8.3 的**端口形态**
 * 会给 http server 装一个**恒 404 的 request 监听者**（`dist/index.js` 的 `attach()`），
 * 它**先于** `installRest` 的监听者把响应写完 ⇒ REST 的 `writeHead` 抛
 * `Cannot write headers after they are sent`、进程当场退出。裸 `createServer()` 上没有它
 * （详见 `rest.ts` 文件头的两条实测纪律）。
 */
const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: '*' } });
httpServer.listen(PORT);
const ns = io.of('/ws/ddz');

/**
 * mock 的 **REST 面**（片② 客户端新增）：`GET /api/config`（片⑦ 起；旧端点
 * `/api/base-score-levels` 已退役）与 `GET /api/rooms`。
 *
 * ⚠️ **必须挂在 `io.httpServer` 上**（不是另起一台服务器）：客户端把 REST 与 socket.io
 * 当作**同一个 origin**（`config.ts` 的 `apiBase` 与 `wsEndpoint`）—— 分开两台就与真形态不符。
 * ⚠️ 房间表**现取**（`rooms()` 是闭包，不是快照）⇒ 房间里的人变了，`GET /api/rooms` 立刻跟着变。
 */
function liveRooms(): RoomInfoLike[] {
  return [...games.entries()].map(([code, entry]) => ({
    code,
    mode: 'random',
    status: 'playing',
    playerCount: entry.seats.size,
    maxPlayers: 3,
    baseScore: entry.baseScore,
  }));
}
installRest(io.httpServer, liveRooms);

function send(socket: Socket, msg: ServerMessage): void {
  // 每条出站都过契约校验：mock 自己先被约束住
  const checked = validateOutbound(msg);
  socket.emit(checked.type, checked);
}

function ackErr<T>(ack: unknown, code: ErrCode, message?: string): void {
  if (typeof ack === 'function') (ack as (r: Ack<T>) => void)({ code, message });
}

function ackOk<T>(ack: unknown, data?: T): void {
  if (typeof ack === 'function') (ack as (r: Ack<T>) => void)({ code: ErrCode.OK, data });
}

/** 把一次状态转移广播给**所有已连接且在该局中**的座位，每人只收自己的视图 */
function broadcast(entry: GameEntry, t: Transition): void {
  for (const [userId, seat] of entry.seats) {
    const socket = connected.get(userId);
    if (!socket) continue;
    const view = t.seatViews[seat];
    if (!view) continue;
    if (t.settled) {
      send(socket, { type: 'game.finished', version: t.version, payload: { winner: t.settled.winner } });
      send(socket, { type: 'game.settlement', version: t.version, payload: t.settled });
    } else {
      send(socket, { type: 'game.state_update', version: t.version, payload: view });
      send(socket, {
        type: 'game.current_turn',
        version: t.version,
        payload: { seat: t.currentSeat, timeoutMs: Math.max(0, view.turnDeadlineAt - Date.now()) },
      });
    }
  }
}

/** userId → socket（mock 里每个用户一条连接） */
const connected = new Map<string, Socket>();

ns.on('connection', (socket: Socket) => {
  const auth = (socket.handshake.auth ?? {}) as { userId?: string };
  const userId = auth.userId;
  if (!userId) {
    socket.emit('system.error', {
      type: 'system.error',
      version: 0,
      payload: { code: ErrCode.UNAUTHENTICATED, message: 'mock 要求握手 auth 带 userId' },
    } satisfies ServerMessage);
    socket.disconnect(true);
    return;
  }
  connected.set(userId, socket);
  // eslint-disable-next-line no-console
  console.log(`[mock] connected userId=${userId} socket=${socket.id}`);

  socket.on('disconnect', () => {
    if (connected.get(userId) === socket) connected.delete(userId);
  });

  /** 统一的请求入口：校验 → 分发 → ack。
   *  线格式是扁平的 —— `type` 由事件名承载，请求体是 `{reqId, baseVersion, timestamp, payload}`。 */
  const handle = (type: string, body: unknown, ack: unknown): void => {
    let msg: ClientMessage;
    try {
      msg = validateClientMessage(type, body);
    } catch (err) {
      ackErr(ack, ErrCode.BAD_PARAM, (err as Error).message);
      return;
    }

    // 找到该用户所在的局
    let entry: GameEntry | undefined;
    for (const e of games.values()) if (e.seats.has(userId)) { entry = e; break; }
    const mySeat = entry?.seats.get(userId);

    // §6.5：只有 CAS_MESSAGES 参与 baseVersion 校验
    if (entry && mySeat !== undefined && (CAS_MESSAGES as readonly string[]).includes(msg.type)) {
      const current = entry.game.getVersion();
      if (msg.meta.baseVersion !== current) {
        ackErr(
          ack,
          ErrCode.VERSION_CONFLICT,
          `baseVersion=${msg.meta.baseVersion} but server is at ${current}`,
        );
        return;
      }
    }

    switch (msg.type) {
      case 'room.match': {
        const game = new ScriptedGame([userId, ...FILLER_IDS]);
        const seats = new Map<string, number>([[userId, 0]]);
        // 协议②（片规格 §2.4）：`room.match` 的 `baseScore` **必填**，且由客户端从服务端
        // 下发的档位表里选。mock **不校验**它的合法性（规则权威在 room-service），
        // 只**记住**它 —— `GET /api/rooms` 要如实把它报回去。
        games.set(MOCK_ROOM_CODE, { game, seats, baseScore: msg.payload.baseScore });
        ackOk(ack, { queued: true });
        send(socket, { type: 'room.matched', version: 0, payload: { roomCode: MOCK_ROOM_CODE, seat: 0 } });
        return;
      }

      case 'room.unmatch': {
        ackOk(ack);
        return;
      }

      case 'room.match.extend': {
        // 机器人补位开关片：玩家在 `match.wait_prompt` 悬浮卡片上点「继续等待」⇒ 再等一个窗口
        // （服务端：平移提示窗口、**不重置** `room.matchNoBotMaxWaitMs` 总上限）。
        // mock 无真实匹配队列/计时器 ⇒ 只兑现「空 payload 的确认类消息」契约面。
        ackOk(ack);
        return;
      }

      case 'room.join': {
        if (msg.payload.roomCode !== MOCK_ROOM_CODE || !entry || mySeat === undefined) {
          ackErr(ack, ErrCode.ROOM_NOT_FOUND);
          return;
        }
        ackOk(ack, { roomCode: MOCK_ROOM_CODE, seat: mySeat, players: roomPlayers(entry) });
        const t = entry.game.deal();
        const view = t.seatViews[mySeat]!;
        send(socket, { type: 'game.deal', version: t.version, payload: view });
        send(socket, {
          type: 'game.current_turn',
          version: t.version,
          payload: { seat: t.currentSeat, timeoutMs: Math.max(0, view.turnDeadlineAt - Date.now()) },
        });
        broadcast(entry, t);
        return;
      }

      case 'room.leave': {
        ackOk(ack);
        games.delete(MOCK_ROOM_CODE);
        return;
      }

      case 'game.bid': {
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.GAME_NOT_STARTED);
        ackOk(ack);
        broadcast(entry, entry.game.bid(mySeat, msg.payload.grab));
        return;
      }

      case 'game.play': {
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.GAME_NOT_STARTED);
        if (entry.game.getCurrentSeat() !== mySeat) return ackErr(ack, ErrCode.NOT_YOUR_TURN);
        ackOk(ack);
        broadcast(entry, entry.game.play(mySeat, msg.payload.cards));
        return;
      }

      case 'game.pass': {
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.GAME_NOT_STARTED);
        if (entry.game.getCurrentSeat() !== mySeat) return ackErr(ack, ErrCode.NOT_YOUR_TURN);
        ackOk(ack);
        broadcast(entry, entry.game.pass(mySeat));
        return;
      }

      case 'game.reconnect': {
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.RECONNECT_RECORD_MISSING);
        ackOk(ack, entry.game.getViewFor(mySeat));
        return;
      }

      case 'game.resync': {
        // 13004 的恢复通道：只重新拉当前裁剪快照
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.GAME_NOT_STARTED);
        ackOk(ack, entry.game.getViewFor(mySeat));
        return;
      }

      case 'game.trustee': {
        /**
         * 挂机治理（C25）：mock **不实现**治理规则（它不是规则实现，也不跑 timer）——
         * 这里只把消息收进穷尽 switch 并回 `code 0`，视图里的 `trustees` 恒 false。
         * 真实托管行为由 game-service 提供（真后端 / conformance 面）。
         */
        if (!entry || mySeat === undefined) return ackErr(ack, ErrCode.GAME_NOT_STARTED);
        ackOk(ack);
        return;
      }

      default: {
        const never: never = msg;
        ackErr(ack, ErrCode.BAD_PARAM, `unhandled: ${JSON.stringify(never)}`);
      }
    }
  };

  // 11 条 C→S 消息全部走同一个入口。契约要求整个请求体是一个对象（§6.2）。
  for (const type of [
    'room.match',
    'room.unmatch',
    'room.match.extend',
    'room.join',
    'room.leave',
    'game.bid',
    'game.play',
    'game.pass',
    'game.trustee',
    'game.reconnect',
    'game.resync',
  ] as const) {
    socket.on(type, (body: unknown, ack: unknown) => handle(type, body, ack));
  }
});

function roomPlayers(entry: GameEntry): { id: string; seat: number; cardCount?: number }[] {
  return [...entry.seats.entries()].map(([id, seat]) => ({ id, seat }));
}

// eslint-disable-next-line no-console
console.log(`[mock] listening on :${PORT} namespace /ws/ddz`);
