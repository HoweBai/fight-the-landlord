/**
 * 跑得快 conformance 驱动（S7.3 / spec §6.5）。
 *
 * ⚠️ **独立 oracle**：本文件**不 import** `protocol/src/pdk/rule`（也不 import shared 的
 * 跑得快规则）—— 出牌/过牌由下面的极简策略自行判定（只打单张：首出最小单张；跟牌找能压过
 * 的最小单张，无解则过）。这样「服务端把我的合法动作拒了」与「裁判实现变了」不会互相掩盖。
 *
 * 机械要点沿用 `ddz-driver` 的既有裁决：
 *  - 行动者一律按 `currentPlayer` 从 `bySeat` 取（R174）；
 *  - 每次转移后用 `sync` 把全部客户端对齐到同一 version（R177）；
 *  - 失败路径先 `close()` 全部客户端（R156：socket 泄漏会吊住事件循环）。
 */
import { ErrCode, type Card } from '@fight-the-landlord/protocol';
import { ConformanceError, sleep } from './assert';
import { registerUser, type HarnessUser } from './http';
import { HarnessClient } from './client';
import { sendThrottled } from './ddz-driver';

export const PDK_STEP_TIMEOUT_MS = 8000;
export const PDK_MATCH_TIMEOUT_MS = 30_000;

/** 出站线格式的跑得快视图（只声明驱动真正读的字段）。 */
export interface PdkViewWire {
  roomCode: string;
  gameType: 'paodekuai';
  playerCount: number;
  version: number;
  state: 'playing' | 'ended';
  seat: number;
  hand: Card[];
  cardCounts: number[];
  trustees: boolean[];
  currentPlayer: number;
  recentActions: { seat: number; cards: Card[] | null }[];
  turnDeadlineAt: number;
  canPass: boolean;
  bombCount: number;
  pdkRules: Record<string, unknown>;
  winnerSeats?: number[];
}

export interface PdkRoom {
  roomCode: string;
  clients: HarnessClient[];
  bySeat: Map<number, HarnessClient>;
  deals: PdkViewWire[];
  /** 匹配推送的原始载荷（断言 gameType/playerCount 用）。 */
  matched: any[];
}

/**
 * 起一局真实的跑得快：入队（带 gameType/playerCount）→ `room.matched` →
 * `room.join`（带 gameType）→ `game.deal`。默认 3 人（2 人场传 `playerCount: 2`）。
 */
export async function startPdkRoom(
  labelPrefix: string,
  options: { baseScore?: number; users?: HarnessUser[]; playerCount?: 2 | 3 | 4 } = {},
): Promise<PdkRoom> {
  const baseScore = options.baseScore ?? 15;
  const playerCount = options.playerCount ?? 3;
  const clients: HarnessClient[] = [];
  try {
    for (let i = 0; i < playerCount; i += 1) {
      const user = options.users?.[i] ?? (await registerUser(i));
      clients.push(await HarnessClient.connect(`${labelPrefix}${i}`, user));
    }
    for (const client of clients) {
      const ack = await client.send('room.match', {
        mode: 'random',
        baseScore,
        gameType: 'paodekuai',
        playerCount,
      });
      if (ack.code !== ErrCode.OK) {
        throw new ConformanceError(
          `${client.label} room.match code=${ack.code} message=${JSON.stringify(ack.message)}（pdk 开关是否已开？）`,
        );
      }
    }
    const matched = await Promise.all(
      clients.map((c) =>
        c.waitFor('room.matched', PDK_MATCH_TIMEOUT_MS, (m) => m?.payload?.gameType === 'paodekuai'),
      ),
    );
    const roomCode = matched[0]!.payload.roomCode as string;
    const bySeat = new Map<number, HarnessClient>();
    for (const [i, client] of clients.entries()) {
      const seat = matched[i]!.payload.seat as number;
      bySeat.set(seat, client);
      const ack = await client.send('room.join', { roomCode, gameType: 'paodekuai' });
      if (ack.code !== ErrCode.OK) throw new ConformanceError(`${client.label} room.join code=${ack.code}`);
    }
    const dealMsgs = await Promise.all(
      clients.map((c) => c.waitFor('game.deal', PDK_MATCH_TIMEOUT_MS)),
    );
    return {
      roomCode,
      clients,
      bySeat,
      deals: dealMsgs.map((m) => m.payload as PdkViewWire),
      matched: matched.map((m) => m.payload),
    };
  } catch (err) {
    for (const client of clients) client.close();
    throw err;
  }
}

/** 某客户端最近一次收到的跑得快视图（`game.deal` 或 `game.state_update`）。 */
export function currentPdkView(client: HarnessClient): PdkViewWire | undefined {
  for (let i = client.received.length - 1; i >= 0; i -= 1) {
    const r = client.received[i]!;
    if (r.type === 'game.deal' || r.type === 'game.state_update') {
      return r.message?.payload as PdkViewWire;
    }
  }
  return undefined;
}

/** 把全部客户端对齐到同一 version（等到各自收到该版本或更新）。 */
export async function syncPdkAll(room: PdkRoom, version: number): Promise<void> {
  await Promise.all(
    room.clients.map(async (client) => {
      for (let i = 0; i < 100; i += 1) {
        const v = currentPdkView(client);
        if (v && v.version >= version) return;
        await sleep(50);
      }
      throw new ConformanceError(`${client.label} 未对齐到 v${version}`);
    }),
  );
}

/** 等一次 version 推进（state_update 或 finished）；超时返回 null。 */
export async function tryAdvancePdk(
  client: HarnessClient,
  fromVersion: number,
  timeoutMs = PDK_STEP_TIMEOUT_MS,
): Promise<PdkViewWire | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = currentPdkView(client);
    if (view && view.version > fromVersion) return view;
    if (client.last('game.finished')) return null;
    await sleep(100);
  }
  return null;
}

function minByCard(cards: readonly Card[]): Card | null {
  let best: Card | null = null;
  for (const c of cards) {
    if (best === null || c.r < best.r || (c.r === best.r && c.s < best.s)) best = c;
  }
  return best;
}

/**
 * **独立 oracle**：只打单张。
 *
 * - 首出（窗口里没有对手的牌 / 最后一个真牌是我自己）⇒ 最小单张；
 * - 跟牌 ⇒ 找能压过目标点数的**最小单张**；没有 ⇒ `{kind:'pass'}`。
 *
 * 本策略保证对局必然收束（每次首出至少出 1 张；跟牌要么出牌要么过，其余全过后回到首出）。
 */
export function pickPdkAction(view: PdkViewWire): { kind: 'play'; cards: Card[] } | { kind: 'pass' } {
  const hand = view.hand;
  if (hand.length === 0) throw new ConformanceError('pdk oracle：行动者手牌为空（对局应已结束）');
  let targetRank: number | null = null;
  for (let i = view.recentActions.length - 1; i >= 0; i -= 1) {
    const a = view.recentActions[i]!;
    if (a.cards === null) continue; // 过牌不改变跟牌目标
    if (a.seat === view.currentPlayer) break; // 自己最后出的牌 ⇒ 重新首出
    if (a.cards.length !== 1) {
      throw new ConformanceError(
        `pdk oracle：遇到非单张的对手出牌（${a.cards.length} 张）—— 本 oracle 只驱动单张策略`,
      );
    }
    targetRank = a.cards[0]!.r;
    break;
  }
  if (targetRank === null) {
    return { kind: 'play', cards: [{ ...(minByCard(hand) as Card) }] };
  }
  const beating = hand.filter((c) => c.r > targetRank);
  const pick = minByCard(beating);
  if (pick === null) return { kind: 'pass' };
  return { kind: 'play', cards: [{ ...pick }] };
}

/** 一局的驱动读数。 */
export interface PdkOutcome {
  winnerSeats: number[];
  actions: number;
  passes: number;
  finishedPayload: any;
  settlement: any;
  finalView: PdkViewWire;
}

/**
 * 把一局从 `game.deal` 驱到 `game.finished`（playerCount 个真人；本 oracle 只打单张）。
 * 判据留在切片里；本函数只做推进 + 事实回传。动作被拒/超时 ⇒ 抛。
 */
export async function playPdkToEnd(room: PdkRoom, what: string): Promise<PdkOutcome> {
  const reader = room.clients[0]!;
  let version = room.deals[0]!.version;
  let actions = 0;
  let passes = 0;
  const deadline = Date.now() + 300_000;

  const finishedOn = (): any | undefined => {
    for (const c of room.clients) {
      const m = c.last('game.finished');
      if (m) return m;
    }
    return undefined;
  };

  for (let guard = 0; guard < 1000; guard += 1) {
    const fin = finishedOn();
    if (fin) {
      const settlementMsg = await reader
        .waitFor('game.settlement', PDK_STEP_TIMEOUT_MS)
        .catch(() => undefined);
      const finalView = currentPdkView(reader)!;
      return {
        winnerSeats: [...((fin.payload?.winnerSeats as number[]) ?? [])],
        actions,
        passes,
        finishedPayload: fin.payload,
        settlement: settlementMsg?.payload,
        finalView,
      };
    }
    if (Date.now() > deadline) {
      const v = currentPdkView(reader);
      throw new ConformanceError(
        `${what}：跑得快 300s 内未收束（v${v?.version ?? '?'} state=${v?.state ?? '?'}）`,
      );
    }

    await syncPdkAll(room, version);
    const view = currentPdkView(reader)!;
    version = view.version;

    if (view.state === 'ended') {
      const done = await reader.waitFor('game.finished', PDK_STEP_TIMEOUT_MS);
      const settlementMsg = await reader
        .waitFor('game.settlement', PDK_STEP_TIMEOUT_MS)
        .catch(() => undefined);
      return {
        winnerSeats: [...((done.payload?.winnerSeats as number[]) ?? [])],
        actions,
        passes,
        finishedPayload: done.payload,
        settlement: settlementMsg?.payload,
        finalView: currentPdkView(reader)!,
      };
    }

    const actorClient = room.bySeat.get(view.currentPlayer);
    if (!actorClient) {
      // 本驱动起的真人座位都已登记在 bySeat；机器人回合（未来扩展）等服务器推进。
      const next = await tryAdvancePdk(reader, view.version, 40_000);
      if (!next && !finishedOn()) {
        throw new ConformanceError(`${what}：机器人回合后 40s 无推进（seat ${view.currentPlayer}）`);
      }
      if (next) version = next.version;
      continue;
    }
    // ⚠️ 出牌必须从**行动者自己**的视图读手牌（reader 的 `hand` 只是 reader 自己的牌；
    //    用 reader 的视图选牌会在 seat≠0 时发出「不在手中」的牌）。
    const actorView = currentPdkView(actorClient)!;
    const action = pickPdkAction(actorView);
    // ⚠️ §5.4：同一 socket 20 条 / 5s ⇒ 与 ddz 驱动共用 `sendThrottled`（≥300ms 间隔）。
    const ack =
      action.kind === 'play'
        ? await sendThrottled(actorClient, 'game.play', { cards: action.cards }, view.version)
        : await sendThrottled(actorClient, 'game.pass', {}, view.version);
    if (ack.code !== ErrCode.OK) {
      throw new ConformanceError(
        `${what}：${action.kind} 被拒（seat ${view.currentPlayer}）code=${ack.code} message=${JSON.stringify(ack.message)}`,
      );
    }
    actions += 1;
    if (action.kind === 'pass') passes += 1;
    const next = await tryAdvancePdk(reader, view.version, PDK_STEP_TIMEOUT_MS);
    if (!next && !finishedOn()) {
      throw new ConformanceError(`${what}：动作后 ${PDK_STEP_TIMEOUT_MS}ms 无 version 推进`);
    }
    if (next) version = next.version;
  }
  throw new ConformanceError(`${what}：驱动循环 1000 步未收束`);
}
