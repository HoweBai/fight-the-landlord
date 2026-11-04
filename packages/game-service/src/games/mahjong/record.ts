/** 麻将记录信封（服务端内部；历史接口再用 MahjongRecordView 裁剪）。 */
import {
  encodeMahjongHand,
  type MahjongRecordEnvelope,
  type MahjongScoreEvent,
} from '@fight-the-landlord/protocol';
import type { MahjongSession } from '@fight-the-landlord/shared';
import { settleMahjong } from '@fight-the-landlord/shared';

export function buildMahjongRecord(session: MahjongSession): MahjongRecordEnvelope {
  let deltas = [0, 0, 0, 0];
  let burn: MahjongRecordEnvelope['resultSummary']['burn'] = [];
  let rakeTotal = 0;
  let writtenOff: MahjongRecordEnvelope['resultSummary']['writtenOff'] = [];
  let fanDetails: MahjongRecordEnvelope['resultSummary']['fanDetails'] = [];
  let events: MahjongScoreEvent[] = [...session.scoreEvents];
  if (session.state === 'ended') {
    const result = settleMahjong(session);
    deltas = result.scoreChanges.map((c) => c.delta);
    burn = result.burn;
    rakeTotal = result.rakeTotal;
    writtenOff = result.writtenOff;
    fanDetails = result.fanDetails;
    events = result.events;
  }
  return {
    startedAt: session.createdAt,
    gameType: 'mahjong',
    playerCount: 4,
    dealerSeat: session.dealerSeat,
    rules: session.rules,
    rngSeed: session.rngSeed,
    seats: session.players.map((p) => ({
      seat: p.seat,
      playerId: p.id,
      isRobot: p.isBot,
      hand: encodeMahjongHand(session.initialHands?.[p.seat] ?? p.hand),
      finalHand: encodeMahjongHand(p.hand),
      melds: p.melds.map((m) => ({ ...m, tiles: [...m.tiles] })),
      discards: [...p.discards],
      lackSuit: p.lackSuit,
      isOut: p.isOut,
      ...(p.hu === null ? {} : { hu: p.hu, fan: p.hu.fan, multiplier: p.hu.multiplier }),
      delta: deltas[p.seat] ?? 0,
    })),
    actions: session.actionLog,
    resultSummary: {
      fanDetails,
      events,
      burn,
      rakeTotal,
      writtenOff,
      liuju: session.endReason === 'wallEmpty',
      huazhuSeats: session.players
        .filter((p) => p.lackSuit !== null && p.hand.some((t) => t.s === p.lackSuit))
        .map((p) => p.seat),
      endReason: session.endReason ?? 'threeWinners',
    },
  };
}
