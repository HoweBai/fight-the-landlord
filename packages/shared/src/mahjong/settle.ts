/**
 * 麻将结算：**未截断**的事件账 + 逐座净额。
 *
 * 余额截断/抽水/burn 上账在 room-service 的 computeSettlement（唯一有余额的一层）。
 * 本文件只负责规则上的零和事件与 flower-pig burn 标记。
 */
import {
  tileType,
  type MahjongSettlementResult,
  type MahjongScoreEvent,
} from '@fight-the-landlord/protocol';
import type { MahjongSession } from './session';
import { hasLackTiles } from './lack';
import { presentSuits } from './lack';
import { tingResult } from './ting';
import { activeSeats } from './claims';

function capMultiplier(session: MahjongSession): number {
  return 2 ** Math.max(0, session.rules.fanCap - session.rules.fanBase);
}

function applyEvent(
  deltas: number[],
  event: MahjongScoreEvent,
): void {
  switch (event.kind) {
    case 'gang':
      for (const p of event.payers) {
        deltas[p.seat] = (deltas[p.seat] ?? 0) - p.amount;
        deltas[event.seat] = (deltas[event.seat] ?? 0) + p.amount;
      }
      break;
    case 'hu':
      for (const p of event.payers) {
        deltas[p.seat] = (deltas[p.seat] ?? 0) - p.amount;
        deltas[event.seat] = (deltas[event.seat] ?? 0) + p.amount;
      }
      break;
    case 'transfer':
      deltas[event.fromSeat] = (deltas[event.fromSeat] ?? 0) - event.amount;
      deltas[event.toSeat] = (deltas[event.toSeat] ?? 0) + event.amount;
      break;
    case 'refund':
      for (const p of event.toSeats) {
        deltas[event.fromSeat] = (deltas[event.fromSeat] ?? 0) - p.amount;
        deltas[p.seat] = (deltas[p.seat] ?? 0) + p.amount;
      }
      break;
    case 'chajiao':
      deltas[event.fromSeat] = (deltas[event.fromSeat] ?? 0) - event.amount;
      deltas[event.toSeat] = (deltas[event.toSeat] ?? 0) + event.amount;
      break;
    case 'huazhu':
      if (event.mode === 'payEach') {
        for (const p of event.payees) {
          deltas[event.seat] = (deltas[event.seat] ?? 0) - p.amount;
          deltas[p.seat] = (deltas[p.seat] ?? 0) + p.amount;
        }
      }
      break;
  }
}

export function settleMahjong(session: MahjongSession): MahjongSettlementResult {
  if (session.state !== 'ended') {
    throw new Error(`麻将结算要求 ended 状态，当前 ${session.state}`);
  }
  const events: MahjongScoreEvent[] = [...session.scoreEvents];
  const nextSeq = (): number => events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  const burn: Array<{ seat: number; amount: number; reason: 'flowerPig' }> = [];
  const huazhuSeats: number[] = [];
  const chajiao: Array<{ from: number; to: number; amount: number }> = [];
  const base = session.baseScore;

  if (session.endReason === 'wallEmpty') {
    const active = activeSeats(session);
    const flowerPigs = active.filter((seat) => {
      const p = session.players[seat]!;
      return (
        p.lackSuit !== null &&
        (hasLackTiles(p.hand, p.lackSuit) ||
          p.melds.some((m) => m.tiles.some((t) => t.s === p.lackSuit)) ||
          presentSuits(p.hand).length === 3)
      );
    });
    huazhuSeats.push(...flowerPigs);
    const nonPig = active.filter((seat) => !flowerPigs.includes(seat));
    const ready = nonPig.filter((seat) => {
      const p = session.players[seat]!;
      return tingResult(p.hand, p.melds, p.lackSuit!, session.rules).tiles.length > 0;
    });
    const notReady = nonPig.filter((seat) => !ready.includes(seat));

    // 退税（spec §4.6 第 4 步）：必须在查叫/花猪之前生成，截断时优先退还尚未转移的杠分。
    // `refundOnDraw` 两档在当前事件模型下同义：退税对象都是**杠事件收款人（杠者）**
    // 且该座未听/花猪；保留配置是为了让规则预设自描述（SBR 文档写“仅杠者”）。
    const notReadySet = new Set<number>([...notReady, ...flowerPigs]);
    const settledRefs = new Set(
      events
        .filter((e) => e.kind === 'transfer' || e.kind === 'refund')
        .map((e) => e.ref),
    );
    for (const event of [...events]) {
      if (event.kind !== 'gang') continue;
      if (!notReadySet.has(event.seat)) continue;
      if (settledRefs.has(event.seq)) continue;
      events.push({
        kind: 'refund',
        seq: nextSeq(),
        ref: event.seq,
        fromSeat: event.seat,
        toSeats: event.payers.map((p) => ({ seat: p.seat, amount: p.amount })),
        reason: 'notReady',
      });
    }

    if (session.rules.chajiaoEnabled && !(session.rules.chajiaoAllSameState === 'none' && notReady.length === 0)) {
      for (const from of notReady) {
        for (const to of ready) {
          const p = session.players[to]!;
          const maxFan = tingResult(p.hand, p.melds, p.lackSuit!, session.rules).maxFan;
          const amount = 2 ** Math.max(0, Math.min(maxFan, session.rules.fanCap) - session.rules.fanBase) * base;
          events.push({ kind: 'chajiao', seq: nextSeq(), fromSeat: from, toSeat: to, amount, fan: maxFan });
          chajiao.push({ from, to, amount });
        }
      }
    }

    for (const seat of flowerPigs) {
      if (session.rules.huazhuMode === 'payEach') {
        const payeeSeats =
          session.rules.huazhuPayees === 'nonFlowerPig'
            ? [0, 1, 2, 3].filter((x) => !flowerPigs.includes(x))
            : nonPig;
        const payees = payeeSeats.map((x) => ({ seat: x, amount: capMultiplier(session) * base }));
        events.push({
          kind: 'huazhu',
          seq: nextSeq(),
          seat,
          amount: capMultiplier(session) * base,
          mode: 'payEach',
          payees,
        });
      } else if (session.rules.huazhuMode === 'burn48') {
        const amount = 48 * base;
        events.push({ kind: 'huazhu', seq: nextSeq(), seat, amount, mode: 'burn48', payees: [] });
        burn.push({ seat, amount, reason: 'flowerPig' });
      }
    }

  }

  const deltas = [0, 0, 0, 0];
  for (const event of events) applyEvent(deltas, event);
  const sum = deltas.reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new Error(`麻将结算非零和：${sum}`);

  const fanDetails = events
    .filter((e): e is Extract<MahjongScoreEvent, { kind: 'hu' }> => e.kind === 'hu')
    .map((e) => ({ seat: e.seat, fan: e.fan, multiplier: e.multiplier, items: e.items }));

  return {
    roomCode: session.roomCode,
    gameType: 'mahjong',
    playerCount: 4,
    baseScore: base,
    winnerSeats: session.players.filter((p) => p.isOut).map((p) => p.seat),
    scoreChanges: deltas.map((delta, seat) => ({ seat, delta })),
    fanDetails,
    events,
    burn,
    rakeTotal: 0,
    chajiao,
    liuju: session.endReason === 'wallEmpty',
    huazhuSeats,
    endReason: session.endReason ?? 'threeWinners',
    writtenOff: [],
  };
}

export { tileType };
