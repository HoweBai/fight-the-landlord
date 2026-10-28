/**
 * 四川麻将 conformance 驱动（T12 / spec §7）。
 *
 * ⚠️ **独立 oracle**：本文件不 import `shared/src/mahjong` 的任何规则/状态机；
 * 只读服务端视图（`MahjongPlayerView` 的出站字段）并按下面的极简策略行动：
 *  - 换三张：选数量最多的一门，取该门前 3 张；
 *  - 定缺：选数量最少的一门（并列按 万→筒→条）；
 *  - 响应窗口：能胡就胡，否则过；不碰/不杠（本 oracle 只验证主路径）；
 *  - 出牌：有缺门牌先打缺门，否则打第一张；自摸能胡就胡。
 *
 * 机械要点沿用 `pdk-driver`：按座位取行动者、每次动作带 `windowId`、失败关闭全部客户端。
 */
import {
  ErrCode,
  type MahjongAction,
  type MahjongPlayerView,
  type Tile,
} from '@fight-the-landlord/protocol';
import { ConformanceError, sleep } from './assert';
import { registerUser, type HarnessUser } from './http';
import { HarnessClient } from './client';

export const MAHJONG_MATCH_TIMEOUT_MS = 90_000;
export const MAHJONG_STEP_TIMEOUT_MS = 240_000;

export interface MahjongRoom {
  roomCode: string;
  clients: HarnessClient[];
  bySeat: Map<number, HarnessClient>;
  deals: MahjongPlayerView[];
  matched: any[];
}

/** 起一局 4 人四川麻将（随机/金币场；默认 4 真人）。 */
export async function startMahjongRoom(
  labelPrefix: string,
  options: {
    mode?: 'random' | 'gold';
    baseScore?: number;
    users?: HarnessUser[];
  } = {},
): Promise<MahjongRoom> {
  const baseScore = options.baseScore ?? 15;
  const mode = options.mode ?? 'random';
  const clients: HarnessClient[] = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      const user = options.users?.[i] ?? (await registerUser(100 + i));
      clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
    }
    for (const client of clients) {
      const ack = await client.send('room.match', {
        mode,
        baseScore,
        gameType: 'mahjong',
        playerCount: 4,
      });
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(
          `${client.label} room.match code=${ack.code} message=${JSON.stringify(ack.message)}（麻将开关/免费场是否已开？）`,
        );
      }
    }
    const matched = await Promise.all(
      clients.map((c) =>
        c.waitFor('room.matched', MAHJONG_MATCH_TIMEOUT_MS, (m) => m?.payload?.gameType === 'mahjong'),
      ),
    );
    const roomCode = matched[0]!.payload.roomCode as string;
    const bySeat = new Map<number, HarnessClient>();
    for (const [i, client] of clients.entries()) {
      const seat = matched[i]!.payload.seat as number;
      bySeat.set(seat, client);
      const ack = await client.send('room.join', { roomCode, gameType: 'mahjong' });
      if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.join code=${ack.code}`);
    }
    const dealMsgs = await Promise.all(
      clients.map((c) => c.waitFor('game.deal', MAHJONG_MATCH_TIMEOUT_MS)),
    );
    return {
      roomCode,
      clients,
      bySeat,
      deals: dealMsgs.map((m) => m.payload as MahjongPlayerView),
      matched: matched.map((m) => m.payload),
    };
  } catch (err) {
    const seen = clients
      .map((c) => `${c.label}:${c.received.map((r) => r.type).join(',') || '(none)'}`)
      .join(' | ');
    for (const client of clients) client.close();
    throw new Error(`${(err as Error).message}；已收消息=[${seen}]`);
  }
}

/** 某客户端最近一次收到的麻将视图。 */
export function currentMahjongView(client: HarnessClient): MahjongPlayerView | undefined {
  for (let i = client.received.length - 1; i >= 0; i -= 1) {
    const r = client.received[i]!;
    if (r.type === 'game.deal' || r.type === 'game.state_update') {
      return r.message?.payload as MahjongPlayerView;
    }
  }
  return undefined;
}

function suitCounts(hand: readonly Tile[]): [number, number, number] {
  const counts: [number, number, number] = [0, 0, 0];
  for (const tile of hand) counts[tile.s] += 1;
  return counts;
}

/** 换三张：数量最多的一门取 3 张（13 张牌必有某门 ≥5）。 */
export function pickExchangeTiles(hand: readonly Tile[]): Tile[] {
  const counts = suitCounts(hand);
  let best: 0 | 1 | 2 = 0;
  for (const suit of [1, 2] as const) if (counts[suit] > counts[best]) best = suit;
  return hand.filter((t) => t.s === best).slice(0, 3).map((t) => ({ ...t }));
}

/** 定缺：数量最少的一门（并列按 万→筒→条）。 */
export function pickLackSuit(hand: readonly Tile[]): 0 | 1 | 2 {
  const counts = suitCounts(hand);
  let best: 0 | 1 | 2 = 0;
  for (const suit of [1, 2] as const) if (counts[suit] < counts[best]) best = suit;
  return best;
}

/** 出牌：有缺门牌先打缺门，否则打第一张。 */
export function pickDiscardTile(view: MahjongPlayerView): Tile {
  const lack = view.lackSuits[view.seat];
  if (lack !== null) {
    const lackTile = view.hand.find((t) => t.s === lack);
    if (lackTile) return { ...lackTile };
  }
  const tile = view.hand[0];
  if (!tile) throw new ConformanceError('mahjong oracle：行动者手牌为空（对局应已结束）');
  return { ...tile };
}

/** 纯策略：只读视图字段，不判规则。 */
export function pickMahjongAction(view: MahjongPlayerView): MahjongAction | null {
  if (view.state === 'ended') return null;
  if (view.state === 'exchange') return { type: 'exchange', tiles: pickExchangeTiles(view.hand) };
  if (view.state === 'lack') return { type: 'lack', suit: pickLackSuit(view.hand) };
  const hu = view.claimsForMe.find((c) => c.claim === 'hu');
  if (view.state === 'claim' || view.state === 'rob') {
    if (hu) return { type: 'claim', claim: 'hu' };
    const pass = view.claimsForMe.find((c) => c.claim === 'pass');
    return { type: 'claim', claim: pass ? 'pass' : (view.claimsForMe[0]?.claim ?? 'pass') };
  }
  if (view.state === 'play') {
    if (hu) return { type: 'selfDrawHu' };
    return { type: 'discard', tile: pickDiscardTile(view) };
  }
  return null;
}

export interface MahjongOutcome {
  actions: number;
  finished: any;
  settlement: any;
  finalViews: MahjongPlayerView[];
}

/**
 * 把一局从 `game.deal` 驱到 `game.finished`（4 个真人）。
 * 判据留在切片里；本函数只做推进 + 事实回传。动作被拒/超时 ⇒ 抛。
 */
export async function playMahjongToEnd(room: MahjongRoom): Promise<MahjongOutcome> {
  const sent = new Set<string>();
  const deadline = Date.now() + MAHJONG_STEP_TIMEOUT_MS;
  let actions = 0;

  const finishedOn = (): any | undefined => {
    for (const client of room.clients) {
      const msg = client.last('game.finished');
      if (msg) return msg;
    }
    return undefined;
  };

  while (Date.now() < deadline) {
    if (finishedOn()) break;
    const pending = room.clients.filter((client) => {
      const view = currentMahjongView(client);
      return view !== undefined && view.state !== 'ended' && view.activeSeats.includes(view.seat);
    });
    if (pending.length === 0) {
      await sleep(50);
      continue;
    }
    await Promise.all(
      pending.map(async (client) => {
        const view = currentMahjongView(client);
        if (!view) return;
        const action = pickMahjongAction(view);
        if (!action) return;
        const key = `${view.windowId ?? 'x'}:${view.version}:${view.seat}`;
        if (sent.has(key)) return;
        sent.add(key);
        const ack = await client.send('game.play', { mahjong: action }, view.version, view.windowId);
        if (ack.code === ErrCode.OK) {
          actions += 1;
          return;
        }
        if (ack.code === ErrCode.VERSION_CONFLICT || ack.code === ErrCode.NOT_YOUR_TURN) {
          sent.delete(key);
          await sleep(80);
          return;
        }
        throw new ConformanceError(
          `${client.label} 麻将动作 ${action.type} 被拒：code=${ack.code} message=${JSON.stringify(ack.message)}`,
        );
      }),
    );
    await sleep(40);
  }

  const finished = finishedOn();
  if (!finished) throw new ConformanceError(`麻将对局 ${MAHJONG_STEP_TIMEOUT_MS}ms 内未结束`);
  let settlement: any;
  for (let i = 0; i < 100 && settlement === undefined; i += 1) {
    for (const client of room.clients) {
      const msg = client.last('game.settlement');
      if (msg) {
        settlement = msg;
        break;
      }
    }
    if (settlement === undefined) await sleep(100);
  }
  if (settlement === undefined) throw new ConformanceError('麻将对局结束后 10s 内未收到 game.settlement');
  return {
    actions,
    finished,
    settlement,
    finalViews: room.clients.map((c) => currentMahjongView(c)!).filter(Boolean),
  };
}

/** 断线重连一个座位（同一账号；用 `game.reconnect` 的 ack 快照回填视图）。 */
export async function reconnectMahjongSeat(room: MahjongRoom, seat: number): Promise<HarnessClient> {
  const old = room.bySeat.get(seat);
  if (!old) throw new ConformanceError(`麻将重连：座位 ${seat} 不在房间`);
  old.disconnect();
  await sleep(300);
  const client = await HarnessClient.connect(`S36-re${seat}`, old.user);
  const ack = await client.send('game.reconnect', { lastVersion: 0 });
  if (ack.code !== ErrCode.OK || ack.data === undefined) {
    throw new ConformanceError(`麻将重连失败：code=${ack.code} message=${JSON.stringify(ack.message)}`);
  }
  // 把 ack 快照注入 received，供 currentMahjongView / 驱动复用（与推送同形）。
  client.received.push({
    type: 'game.deal',
    message: { type: 'game.deal', version: ack.data.version, payload: ack.data },
    at: Date.now(),
  });
  const idx = room.clients.indexOf(old);
  if (idx >= 0) room.clients[idx] = client;
  room.bySeat.set(seat, client);
  return client;
}
