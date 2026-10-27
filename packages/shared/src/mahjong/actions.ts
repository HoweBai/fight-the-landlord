/**
 * 麻将所有动作的状态机（纯函数）。
 *
 * 结算只产出**未截断**的事件账/净额；余额截断在 room-service 的 computeSettlement。
 * 版本号在每个成功动作 +1；窗口 id 在同一窗口内稳定（claim/rob/exchange/lack）。
 */
import {
  MAHJONG_SUIT_NAMES,
  ProtocolError,
  tileType,
  type MahjongAction,
  type MahjongMeldView,
  type MahjongScoreEvent,
  type MahjongSuit,
  type Tile,
} from '@fight-the-landlord/protocol';
import type { MahjongSession } from './session';
import {
  autoExchangePick,
  exchangeDirectionFor,
  exchangeHands,
  validateExchangePick,
} from './exchange';
import { autoLackSuit, canDiscard, hasLackTiles, removeTile, validateLackSuit } from './lack';
import { makeAddedGang, makeConcealedGang, makeMeldedGang, makePeng } from './meld';
import {
  activeSeats,
  canGangFromDiscard,
  canPeng,
  checkHu,
  claimCandidates,
  isForcedHu,
  nextActiveSeat,
} from './claims';
import type { ScoreResult } from './scoring';

function cloneSession(s: MahjongSession): MahjongSession {
  return {
    ...s,
    wall: [...s.wall],
    players: s.players.map((p) => ({
      ...p,
      hand: [...p.hand],
      melds: p.melds.map((m) => ({ ...m, tiles: [...m.tiles] })),
      discards: [...p.discards],
      exchangePick: [...p.exchangePick],
      passedHu: [...p.passedHu],
    })),
    scoreEvents: [...s.scoreEvents],
    pendingClaims: s.pendingClaims
      ? {
          ...s.pendingClaims,
          candidates: [...s.pendingClaims.candidates],
          responses: [...s.pendingClaims.responses],
          fanBySeat: { ...(s.pendingClaims.fanBySeat ?? {}) },
        }
      : null,
  };
}

function bump(s: MahjongSession): MahjongSession {
  s.version += 1;
  s.wallCount = s.wall.length;
  return s;
}

function nextSeq(s: MahjongSession): number {
  return s.scoreEvents.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
}

function nextTurn(s: MahjongSession, seat: number): void {
  s.state = 'play';
  s.currentPlayer = seat;
  s.windowSeq += 1;
  s.windowId = `turn:${s.windowSeq}`;
  s.pendingClaims = null;
  s.lastDiscard = null;
}

function finish(s: MahjongSession, reason: 'threeWinners' | 'wallEmpty'): void {
  s.state = 'ended';
  s.liuju = reason === 'wallEmpty';
  s.endReason = reason;
  s.winnerSeats = s.players.filter((p) => p.isOut).map((p) => p.seat);
  s.windowSeq += 1;
  s.windowId = 'ended';
  s.pendingClaims = null;
}

function checkFinished(s: MahjongSession): boolean {
  if (s.players.filter((p) => p.isOut).length >= 3) {
    finish(s, 'threeWinners');
    return true;
  }
  if (s.wall.length === 0) {
    finish(s, 'wallEmpty');
    return true;
  }
  return false;
}

function drawFor(s: MahjongSession, seat: number, fromKong: boolean): void {
  const next = s.wall.shift();
  if (!next) {
    finish(s, 'wallEmpty');
    return;
  }
  const player = s.players[seat]!;
  player.hand.push(next);
  s.lastDraw = { seat, tile: next, fromKong };
  nextTurn(s, seat);
  // 最后 4 张能胡必胡：自摸自动胡。
  if (s.rules.lastFourForcedHu && s.wall.length <= 4) {
    const check = checkHu(s, seat, next, true);
    if (check.ok) {
      applySelfDrawHu(s, seat, check.score!);
    }
  }
}

function advanceAfterDiscard(s: MahjongSession, fromSeat: number): void {
  if (checkFinished(s)) return;
  const next = nextActiveSeat(s, fromSeat);
  if (next < 0) {
    finish(s, 'threeWinners');
    return;
  }
  drawFor(s, next, false);
}

function openClaimWindow(
  s: MahjongSession,
  kind: 'claim' | 'rob',
  discard: Tile,
  fromSeat: number,
  candidates: number[],
  gangMeldIndex?: number,
): void {
  s.windowSeq += 1;
  s.windowId = `${kind}:${s.windowSeq}`;
  s.state = 'claim';
  // 抢杠窗口不继承「上一次杠后补牌」的 lastDraw（否则抢杠胡会被再算一次杠上炮）。
  if (kind === 'rob') s.lastDraw = null;
  s.pendingClaims = {
    kind,
    discard,
    fromSeat,
    candidates,
    responses: [],
    fanBySeat: {},
    ...(gangMeldIndex === undefined ? {} : { gangMeldIndex }),
  };
}

function gangPayers(s: MahjongSession, seat: number, kind: 'melded' | 'added' | 'concealed', fromSeat?: number): Array<{ seat: number; amount: number }> {
  const others = activeSeats(s).filter((x) => x !== seat);
  const unit = s.baseScore;
  if (kind === 'melded') {
    if (fromSeat === undefined) throw new ProtocolError('直杠缺少点杠者');
    if (s.rules.directGangMode === 'contract') return [{ seat: fromSeat, amount: 2 * unit }];
    return [
      { seat: fromSeat, amount: 2 * unit },
      ...others.filter((x) => x !== fromSeat).map((x) => ({ seat: x, amount: unit })),
    ];
  }
  if (kind === 'added') return others.map((x) => ({ seat: x, amount: unit }));
  return others.map((x) => ({ seat: x, amount: 2 * unit }));
}

function addGangEvent(
  s: MahjongSession,
  seat: number,
  kind: 'melded' | 'added' | 'concealed',
  tile: Tile,
  fromSeat?: number,
): void {
  s.scoreEvents.push({
    kind: 'gang',
    seq: nextSeq(s),
    seat,
    gang: kind,
    tile,
    payers: gangPayers(s, seat, kind, fromSeat),
  });
}

function addHuEvent(
  s: MahjongSession,
  seat: number,
  fromSeat: number | null,
  score: ScoreResult,
): void {
  const payers =
    fromSeat === null
      ? activeSeats(s).filter((x) => x !== seat)
      : [fromSeat];
  const per = score.multiplier * s.baseScore + score.selfDrawBonusBase * s.baseScore;
  s.scoreEvents.push({
    kind: 'hu',
    seq: nextSeq(s),
    seat,
    fromSeat,
    fan: score.fan,
    multiplier: score.multiplier,
    payers: payers.map((x) => ({ seat: x, amount: per })),
    items: score.items,
  });
}

function markHu(
  s: MahjongSession,
  seat: number,
  fromSeat: number | null,
  tile: Tile,
  score: ScoreResult,
  tileFromHand: boolean,
): void {
  const player = s.players[seat]!;
  if (fromSeat !== null) {
    const source = s.players[fromSeat]!;
    if (tileFromHand) {
      source.hand = removeTile(source.hand, tile);
    } else {
      const idx = source.discards.map((t) => tileType(t)).lastIndexOf(tileType(tile));
      if (idx >= 0) source.discards.splice(idx, 1);
    }
    player.hand.push(tile);
  }
  player.isOut = true;
  player.hu = {
    seat,
    fromSeat,
    tile,
    fan: score.fan,
    multiplier: score.multiplier,
    items: score.items,
    selfDraw: fromSeat === null,
  };
  addHuEvent(s, seat, fromSeat, score);
}

function applySelfDrawHu(s: MahjongSession, seat: number, score: ScoreResult): void {
  const tile = s.lastDraw?.tile;
  if (!tile) throw new ProtocolError('自摸缺少摸牌记录');
  markHu(s, seat, null, tile, score, true);
  if (checkFinished(s)) return;
  const next = nextActiveSeat(s, seat);
  if (next < 0) {
    finish(s, 'threeWinners');
    return;
  }
  drawFor(s, next, false);
}

/**
 * 杠上炮：把**指定杠事件**已收的杠分转给胡牌者（`gangTransfer`）。
 *
 * - `toEachWinner`：每个赢家各收**全额**杠分（一炮多响时杠家分别付；差额由后续截断兜底）；
 * - `split`：杠分均分给赢家，余数按座位升序；
 * - `none`：退回原付款人（reason=`shootAfterGang`）。
 * 同一笔杠分只生成一组转移/退回（`gangShootSeq` 每个弃牌窗口只指向一次杠）。
 */
function applyGangShoot(s: MahjongSession, seq: number, winners: readonly number[]): void {
  const gang = s.scoreEvents.find(
    (e): e is Extract<MahjongScoreEvent, { kind: 'gang' }> => e.kind === 'gang' && e.seq === seq,
  );
  if (!gang) throw new ProtocolError(`杠上炮引用的杠事件不存在：${seq}`);
  const total = gang.payers.reduce((acc, p) => acc + p.amount, 0);
  const sorted = [...winners].sort((a, b) => a - b);
  if (s.rules.gangTransfer === 'none') {
    s.scoreEvents.push({
      kind: 'refund',
      seq: nextSeq(s),
      ref: seq,
      fromSeat: gang.seat,
      toSeats: gang.payers.map((p) => ({ seat: p.seat, amount: p.amount })),
      reason: 'shootAfterGang',
    });
    return;
  }
  if (s.rules.gangTransfer === 'toEachWinner') {
    for (const seat of sorted) {
      s.scoreEvents.push({
        kind: 'transfer',
        seq: nextSeq(s),
        ref: seq,
        fromSeat: gang.seat,
        toSeat: seat,
        amount: total,
        reason: 'gangShoot',
      });
    }
    return;
  }
  // split：均分，余数按座位升序（与文档 §5 逐字）。
  const base = Math.floor(total / sorted.length);
  const remainder = total - base * sorted.length;
  sorted.forEach((seat, index) => {
    const amount = base + (index < remainder ? 1 : 0);
    if (amount <= 0) return;
    s.scoreEvents.push({
      kind: 'transfer',
      seq: nextSeq(s),
      ref: seq,
      fromSeat: gang.seat,
      toSeat: seat,
      amount,
      reason: 'gangShoot',
    });
  });
}

function resolveClaims(s: MahjongSession): void {
  const pc = s.pendingClaims;
  if (!pc) return;
  const huSeats: number[] = [];
  for (const seat of pc.candidates) {
    if (pc.responses.some((r) => r.seat === seat && r.claim === 'hu')) {
      const check = checkHu(
        s,
        seat,
        pc.discard,
        false,
        pc.kind === 'rob',
        pc.kind === 'claim' && pc.gangShootSeq !== undefined,
      );
      if (check.ok) huSeats.push(seat);
    }
  }

  if (huSeats.length > 0) {
    // 杠上炮：先转移/退回杠分，再记胡事件（事件顺序 = 文档 §4.6 的 2→5）。
    if (pc.kind === 'claim' && pc.gangShootSeq !== undefined) {
      applyGangShoot(s, pc.gangShootSeq, huSeats);
    }
    for (let i = 0; i < huSeats.length; i += 1) {
      const seat = huSeats[i]!;
      const check = checkHu(
        s,
        seat,
        pc.discard,
        false,
        pc.kind === 'rob',
        pc.kind === 'claim' && pc.gangShootSeq !== undefined,
      );
      // 抢杠一炮多响：物理杠牌只从杠者手牌移除一次；后续赢家按「复制一张」处理
      //（tileFromHand=false 不会去 discards 删除，只把牌加入自己手牌）。
      markHu(s, seat, pc.fromSeat, pc.discard, check.score!, pc.kind === 'rob' && i === 0);
    }
    s.pendingClaims = null;
    if (checkFinished(s)) return;
    const next = nextActiveSeat(s, pc.fromSeat);
    if (next < 0) {
      finish(s, 'threeWinners');
      return;
    }
    drawFor(s, next, false);
    return;
  }

  if (pc.kind === 'rob') {
    // 无人抢杠 ⇒ 补杠成立。
    s.pendingClaims = null;
    applyAddedGangNow(s, pc.fromSeat, pc.gangMeldIndex!, pc.discard);
    return;
  }

  const gangResponse = pc.responses.find((r) => r.claim === 'gang');
  if (gangResponse && canGangFromDiscard(s, gangResponse.seat, pc.discard)) {
    const player = s.players[gangResponse.seat]!;
    const made = makeMeldedGang(player.hand, pc.discard, pc.fromSeat);
    player.hand = made.hand;
    player.melds.push(made.meld);
    s.pendingClaims = null;
    addGangEvent(s, gangResponse.seat, 'melded', pc.discard, pc.fromSeat);
    drawFor(s, gangResponse.seat, true);
    return;
  }

  const pengResponse = pc.responses.find((r) => r.claim === 'peng');
  if (pengResponse && canPeng(s, pengResponse.seat, pc.discard)) {
    const player = s.players[pengResponse.seat]!;
    const made = makePeng(player.hand, pc.discard, pc.fromSeat);
    player.hand = made.hand;
    player.melds.push(made.meld);
    s.pendingClaims = null;
    s.lastDiscard = null;
    nextTurn(s, pengResponse.seat);
    s.lastDraw = null;
    return;
  }

  s.pendingClaims = null;
  advanceAfterDiscard(s, pc.fromSeat);
}

function applyAddedGangNow(s: MahjongSession, seat: number, meldIndex: number, tile: Tile): void {
  const player = s.players[seat]!;
  const meld = player.melds[meldIndex];
  if (!meld) throw new ProtocolError('补杠副露不存在');
  const made = makeAddedGang(player.hand, meld, tile);
  player.hand = made.hand;
  player.melds[meldIndex] = made.meld;
  addGangEvent(s, seat, 'added', tile);
  drawFor(s, seat, true);
}

function startExchange(s: MahjongSession, random: () => number): void {
  const picks = s.players.map((p) => p.exchangePick);
  if (picks.some((p) => p.length !== 3)) {
    throw new ProtocolError('换三张尚未全部完成');
  }
  const direction = exchangeDirectionFor(random, s.rules.exchangeDirection);
  const hands = exchangeHands(s.players.map((p) => p.hand), picks, direction);
  hands.forEach((hand, seat) => {
    s.players[seat]!.hand = hand;
    s.players[seat]!.exchangePick = [];
  });
  s.exchangeDirection = direction;
  s.state = 'lack';
  s.windowId = 'lack';
  s.windowSeq += 1;
}

function startPlayAfterLack(s: MahjongSession): void {
  if (s.players.some((p) => p.lackSuit === null)) throw new ProtocolError('定缺尚未全部完成');
  drawFor(s, s.dealerSeat, false);
}

/**
 * 动作入口。`random` 只用于换三张方向；其余动作确定性。
 */
export function applyMahjongAction(
  session: MahjongSession,
  seat: number,
  action: MahjongAction,
  random: () => number,
): MahjongSession {
  const s = cloneSession(session);
  const player = s.players[seat];
  if (!player) throw new ProtocolError(`座位 ${seat} 不存在`);
  if (s.state === 'ended') throw new ProtocolError('对局已结束');

  switch (action.type) {
    case 'exchange': {
      if (s.state !== 'exchange') throw new ProtocolError('当前不是换三张阶段');
      if (player.exchangePick.length > 0) throw new ProtocolError('换三张已提交');
      validateExchangePick(player.hand, action.tiles);
      player.exchangePick = [...action.tiles];
      if (s.players.every((p) => p.exchangePick.length === 3)) startExchange(s, random);
      break;
    }
    case 'lack': {
      if (s.state !== 'lack') throw new ProtocolError('当前不是定缺阶段');
      if (player.lackSuit !== null) throw new ProtocolError('定缺已提交');
      validateLackSuit(player.hand, action.suit);
      player.lackSuit = action.suit;
      if (s.players.every((p) => p.lackSuit !== null)) startPlayAfterLack(s);
      break;
    }
    case 'discard': {
      if (s.state !== 'play') throw new ProtocolError('当前不是出牌阶段');
      if (s.currentPlayer !== seat) throw new ProtocolError('不是你的回合');
      const lack = player.lackSuit!;
      if (!canDiscard(player.hand, lack, action.tile)) {
        throw new ProtocolError(hasLackTiles(player.hand, lack) ? '必须先打完缺门牌' : '牌不在手牌中');
      }
      // 杠上炮判定：本张弃牌来自杠后补牌 ⇒ 记下那一次杠事件，胡牌时生成呼叫转移/退回。
      const gangShootSeq =
        s.lastDraw?.fromKong === true
          ? [...s.scoreEvents].reverse().find((e) => e.kind === 'gang' && e.seat === seat)?.seq
          : undefined;
      player.hand = removeTile(player.hand, action.tile);
      player.discards.push(action.tile);
      s.lastDiscard = { seat, tile: action.tile };
      s.lastDraw = null;
      const pc = {
        kind: 'claim' as const,
        discard: action.tile,
        fromSeat: seat,
        candidates: [] as number[],
      };
      // 临时窗口用于候选计算（claimCandidates 读 pendingClaims）。
      s.pendingClaims = {
        ...pc,
        responses: [],
        fanBySeat: {},
        ...(gangShootSeq === undefined ? {} : { gangShootSeq }),
      };
      const candidates = claimCandidates(s);
      if (candidates.length === 0) {
        s.pendingClaims = null;
        advanceAfterDiscard(s, seat);
      } else {
        openClaimWindow(s, 'claim', action.tile, seat, candidates);
        // 杠上炮标记必须挂在**正式窗口**上（临时窗口会被 openClaimWindow 覆盖）。
        if (gangShootSeq !== undefined) s.pendingClaims.gangShootSeq = gangShootSeq;
      }
      break;
    }
    case 'concealedGang': {
      if (s.state !== 'play' || s.currentPlayer !== seat) throw new ProtocolError('不是你的回合');
      if (s.wall.length === 0) throw new ProtocolError('牌墙已空，不能杠');
      if (player.lackSuit !== null && action.tile.s === player.lackSuit) {
        throw new ProtocolError('缺门牌不能杠');
      }
      const made = makeConcealedGang(player.hand, action.tile);
      player.hand = made.hand;
      player.melds.push(made.meld);
      addGangEvent(s, seat, 'concealed', action.tile);
      drawFor(s, seat, true);
      break;
    }
    case 'addedGang': {
      if (s.state !== 'play' || s.currentPlayer !== seat) throw new ProtocolError('不是你的回合');
      if (s.wall.length === 0) throw new ProtocolError('牌墙已空，不能杠');
      const meldIndex = player.melds.findIndex(
        (m) => m.kind === 'peng' && m.tiles[0]?.s === action.tile.s && m.tiles[0]?.r === action.tile.r,
      );
      if (meldIndex < 0) throw new ProtocolError('没有可补杠的碰');
      const robbers = activeSeats(s).filter(
        (x) => x !== seat && checkHu(s, x, action.tile, false, true).ok,
      );
      if (robbers.length > 0) {
        openClaimWindow(s, 'rob', action.tile, seat, robbers, meldIndex);
      } else {
        applyAddedGangNow(s, seat, meldIndex, action.tile);
      }
      break;
    }
    case 'selfDrawHu': {
      if (s.state !== 'play' || s.currentPlayer !== seat) throw new ProtocolError('不是你的回合');
      const tile = s.lastDraw?.tile;
      if (!tile) throw new ProtocolError('没有刚摸到的牌');
      const check = checkHu(s, seat, tile, true);
      if (!check.ok) throw new ProtocolError('当前手牌不能自摸胡');
      applySelfDrawHu(s, seat, check.score!);
      break;
    }
    case 'claim': {
      const pc = s.pendingClaims;
      if (!pc || s.state !== 'claim') throw new ProtocolError('当前没有响应窗口');
      if (!pc.candidates.includes(seat)) throw new ProtocolError('你不在响应候选中');
      if (pc.responses.some((r) => r.seat === seat)) throw new ProtocolError('已响应');
      if (action.claim === 'hu') {
        if (
          !checkHu(
            s,
            seat,
            pc.discard,
            false,
            pc.kind === 'rob',
            pc.kind === 'claim' && pc.gangShootSeq !== undefined,
          ).ok
        ) {
          throw new ProtocolError('不能胡这张牌');
        }
      } else if (action.claim === 'pass') {
        if (isForcedHu(s, seat, pc.discard)) throw new ProtocolError('最后四张能胡必胡');
        const passed = checkHu(
          s,
          seat,
          pc.discard,
          false,
          pc.kind === 'rob',
          pc.kind === 'claim' && pc.gangShootSeq !== undefined,
        );
        if (passed.ok) {
          player.passedHu.push({ tile: tileType(pc.discard), fan: passed.score!.fan });
        }
      } else if (action.claim === 'gang') {
        if (pc.kind !== 'claim' || !canGangFromDiscard(s, seat, pc.discard)) {
          throw new ProtocolError('不能杠这张牌');
        }
      } else if (action.claim === 'peng') {
        if (pc.kind !== 'claim' || !canPeng(s, seat, pc.discard)) {
          throw new ProtocolError('不能碰这张牌');
        }
      }
      pc.responses.push({ seat, claim: action.claim });
      if (pc.responses.length === pc.candidates.length) resolveClaims(s);
      break;
    }
    default:
      throw new ProtocolError(`未知麻将动作：${JSON.stringify(action)}`);
  }
  return bump(s);
}

/** 窗口超时：对每个 pending 座位执行默认动作（换/缺/过/自动出牌）。 */
export function timeoutMahjong(session: MahjongSession, random: () => number): MahjongSession {
  let s = session;
  if (s.state === 'exchange') {
    for (const p of s.players) {
      if (p.exchangePick.length === 0) {
        s = applyMahjongAction(s, p.seat, { type: 'exchange', tiles: autoExchangePick(p.hand) }, random);
      }
    }
    return s;
  }
  if (s.state === 'lack') {
    for (const p of s.players) {
      if (p.lackSuit === null) {
        s = applyMahjongAction(s, p.seat, { type: 'lack', suit: autoLackSuit(p.hand) }, random);
      }
    }
    return s;
  }
  if (s.state === 'claim') {
    while (s.state === 'claim') {
      const pc = s.pendingClaims;
      if (!pc) break;
      const seat = pc.candidates.find((x) => !pc.responses.some((r) => r.seat === x));
      if (seat === undefined) break;
      const forced = isForcedHu(s, seat, pc.discard);
      s = applyMahjongAction(s, seat, { type: 'claim', claim: forced ? 'hu' : 'pass' }, random);
    }
    return s;
  }
  if (s.state === 'play') {
    return applyMahjongAction(s, s.currentPlayer, autoAction(s, s.currentPlayer), random);
  }
  return s;
}

/** 单一自动决策入口：超时/托管/机器人共用。 */
export function autoAction(session: MahjongSession, seat: number): MahjongAction {
  const player = session.players[seat]!;
  if (session.state === 'exchange') {
    return { type: 'exchange', tiles: autoExchangePick(player.hand) };
  }
  if (session.state === 'lack') {
    return { type: 'lack', suit: autoLackSuit(player.hand) };
  }
  if (session.state === 'claim') {
    const pc = session.pendingClaims!;
    if (
      checkHu(
        session,
        seat,
        pc.discard,
        false,
        pc.kind === 'rob',
        pc.kind === 'claim' && pc.gangShootSeq !== undefined,
      ).ok
    ) {
      return { type: 'claim', claim: 'hu' };
    }
    return { type: 'claim', claim: 'pass' };
  }
  if (session.state === 'play') {
    const tile = session.lastDraw?.tile;
    if (tile && checkHu(session, seat, tile, true).ok) return { type: 'selfDrawHu' };
    const lack = player.lackSuit!;
    const sorted = [...player.hand].sort((a, b) => {
      const aLack = a.s === lack ? 0 : 1;
      const bLack = b.s === lack ? 0 : 1;
      return aLack - bLack || a.r - b.r || a.s - b.s;
    });
    const pick = sorted[0]!;
    return { type: 'discard', tile: pick };
  }
  throw new ProtocolError(`当前状态 ${session.state} 没有自动动作`);
}

export function suitLabel(suit: MahjongSuit): string {
  return MAHJONG_SUIT_NAMES[suit]!;
}

export function meldTiles(melds: readonly MahjongMeldView[]): Tile[] {
  return melds.flatMap((m) => m.tiles);
}

export { makeAddedGang, makeConcealedGang, makeMeldedGang, makePeng };
