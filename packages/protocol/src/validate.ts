/**
 * 运行期校验器。
 *
 * 这是把契约从「约定」变成「断言」的关键：类型只在编译期存在，
 * 而两端是**独立编译**的——服务端发了契约里没有的东西、或客户端
 * 误会了某个字段，只有运行期校验能当场抓住。
 *
 * 两个使用点（§6.2）：
 *  - 服务端：`validateOutbound(msg)` —— 发送前调用，拦住越界出站
 *  - 客户端：`validateInbound(msg)` —— 处理前调用，开发期即发现服务端漂移
 */

import { isValidDouZeroCard } from './codec';
import { GAME_TYPES } from './game-types';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  type ClientMessage,
  type ClientMessageType,
  type ServerMessage,
  type ServerMessageType,
} from './messages';
import type { Card, GameView, PlayerView, RoomPlayer } from './views';
import type { DdzSettlementResult } from './views';
import type { PdkPlayerView, PdkSettlementResult } from './pdk/types';
import type { MahjongAction } from './mahjong/actions';
import type { MahjongPlayerView, MahjongSettlementResult } from './mahjong/types';
import { isTile, type Tile } from './mahjong/tile';
import { pdkRecentActionsWindow } from './pdk/window';
import type { SettlementResult } from './settlement';

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * 永不出站的字段名（§4.2）。**出现任何一个都视为数据泄漏。**
 *
 * 注意 `hand` 不在这个列表里——自己的 `hand` 是要下发的；
 * 「他人的 hand」靠 `PlayerView` 的结构本身保证（它只有一个 `hand`）。
 */
export const FORBIDDEN_OUTBOUND_KEYS: readonly string[] = [
  'actionLog',
  'isRobot',
  'botId',
  'skillLevel',
  'thinkingSpeed', // 拟人化思考延迟：服务端内部字段，玩家面永不出站
  'deviceId', // K3：服务器可见；玩家面永不出站
  // 多玩法片：服务端内部/规则态字段，永不出站
  'rules', // 会话规则快照；视图用 pdkRules（白名单字段）
  'lastPlayedHand', // 规则跟牌目标；出站只给 recentActions 显示窗口
  'unusedCards', // 2 人局扣牌（审计用）
  'initialHands', // 发牌快照
  'botIds',
  'botSkillLevels',
  'botThinkingSpeeds',
  // 麻将：牌墙/RNG/过水内部结构，永不出站
  'wall',
  'rngSeed',
  'passedHu',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertNum(v: unknown, path: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ProtocolError(`${path} must be a finite number, got ${JSON.stringify(v)}`);
  }
}

function assertStr(v: unknown, path: string): asserts v is string {
  if (typeof v !== 'string') {
    throw new ProtocolError(`${path} must be a string, got ${JSON.stringify(v)}`);
  }
}

/** 整数 + 闭区间校验（`assertNum` 只保证有限数 —— 它允许 `-1`/`99`/`1.5`）。 */
function assertInt(v: unknown, path: string, min: number, max: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ProtocolError(
      `${path} must be an integer in ${min}..${max}, got ${JSON.stringify(v)}`,
    );
  }
}

/**
 * 多玩法可选字段：**只有 undefined 算缺省**；空串/未知 id 报错（K3）。
 * 审查 P2-5：复用叶子模块的 `GAME_TYPES`（零 import，不会与 game.ts 成环）；
 * 新增玩法时这里自动跟随，不再需要手工同步第二份元组。
 */
const KNOWN_GAME_TYPES = GAME_TYPES;

function assertOptionalGameType(v: unknown, path: string): void {
  if (v === undefined) return;
  if (typeof v !== 'string' || !(KNOWN_GAME_TYPES as readonly string[]).includes(v)) {
    throw new ProtocolError(
      `${path} must be one of ${KNOWN_GAME_TYPES.join(' | ')}, got ${JSON.stringify(v)}`,
    );
  }
}

function assertOptionalPlayerCount(v: unknown, path: string): void {
  if (v === undefined) return;
  assertInt(v, path, 2, 4);
}

/**
 * `Card[]` 的形状校验（R696）。
 *
 * ⚠️ **不做同 `r` 去重**——两张王的 `r` 本就不同（20 / 30），去重规则无处生效；
 * 四条同点数不同花色的牌是合法的。
 */
function assertCardArray(v: unknown, path: string): asserts v is Card[] {
  if (!Array.isArray(v)) throw new ProtocolError(`${path} must be an array`);
  v.forEach((c, i) => {
    if (!isObj(c)) {
      throw new ProtocolError(`${path}[${i}] must be a Card object with {r, s}`);
    }
    if (!isValidDouZeroCard(c.r)) {
      throw new ProtocolError(
        `${path}[${i}].r is not a valid DouZero card value: ${JSON.stringify(c.r)}`,
      );
    }
    if (!Number.isInteger(c.s) || (c.s as number) < 0 || (c.s as number) > 4) {
      throw new ProtocolError(
        `${path}[${i}].s must be an integer in 0..4, got ${JSON.stringify(c.s)}`,
      );
    }
  });
}

/** 递归扫描，任何禁止字段出现即抛错。 */
export function assertNoLeak(node: unknown, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertNoLeak(n, `${path}[${i}]`));
    return;
  }
  if (!isObj(node)) return;
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_OUTBOUND_KEYS.includes(key)) {
      throw new ProtocolError(
        `outbound payload leaks forbidden field "${key}" at ${path}.${key} — see docs/design.md §4.2`,
      );
    }
    assertNoLeak(node[key], `${path}.${key}`);
  }
}

function assertPlayerView(v: unknown, path: string): asserts v is PlayerView {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a PlayerView object`);
  assertOptionalGameType(v.gameType, `${path}.gameType`);
  assertOptionalPlayerCount(v.playerCount, `${path}.playerCount`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.version, `${path}.version`);
  if (v.state !== 'init' && v.state !== 'bidding' && v.state !== 'playing' && v.state !== 'ended') {
    throw new ProtocolError(`${path}.state is not a valid game state: ${JSON.stringify(v.state)}`);
  }
  assertNum(v.seat, `${path}.seat`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if ((v.baseScore as number) <= 0) {
    throw new ProtocolError(`${path}.baseScore must be positive, got ${JSON.stringify(v.baseScore)}`);
  }
  assertCardArray(v.hand, `${path}.hand`);
  if (!Array.isArray(v.cardCounts) || v.cardCounts.length !== 3) {
    throw new ProtocolError(`${path}.cardCounts must be a 3-tuple`);
  }
  v.cardCounts.forEach((n, i) => assertNum(n, `${path}.cardCounts[${i}]`));
  // 挂机治理（C23）：按座位的托管态——恰三元、全 boolean，与 cardCounts 同族
  if (!Array.isArray(v.trustees) || v.trustees.length !== 3) {
    throw new ProtocolError(`${path}.trustees must be a 3-tuple`);
  }
  v.trustees.forEach((b, i) => {
    if (typeof b !== 'boolean') {
      throw new ProtocolError(`${path}.trustees[${i}] must be a boolean, got ${JSON.stringify(b)}`);
    }
  });
  // 不变式：自己的手牌张数必须与公开的计数一致
  if (v.hand.length !== (v.cardCounts as number[])[v.seat as number]) {
    throw new ProtocolError(
      `${path}: hand.length (${v.hand.length}) must equal cardCounts[seat] (${String((v.cardCounts as number[])[v.seat as number])})`,
    );
  }
  if (v.bottomCards !== null) assertCardArray(v.bottomCards, `${path}.bottomCards`);
  if (v.landlordSeat !== null) assertNum(v.landlordSeat, `${path}.landlordSeat`);
  assertNum(v.currentPlayer, `${path}.currentPlayer`);
  // 协议 ④：窗口 = 2、「不出」用 null 表示
  if (!Array.isArray(v.recentActions)) {
    throw new ProtocolError(`${path}.recentActions must be an array`);
  }
  if (v.recentActions.length > 2) {
    throw new ProtocolError(
      `${path}.recentActions must have at most 2 items (窗口 2), got ${v.recentActions.length}`,
    );
  }
  v.recentActions.forEach((a, i) => {
    const p = `${path}.recentActions[${i}]`;
    if (!isObj(a)) throw new ProtocolError(`${p} must be an object`);
    // ⚠️ 现全校验器**从不检查键存在性** ⇒ 必须显式判，否则「cards 缺失」与
    //    「cards: null」在窄化后无法区分（而后者是合法的「不出」）
    if (!('seat' in a)) throw new ProtocolError(`${p} must have a "seat" key`);
    if (!('cards' in a)) throw new ProtocolError(`${p} must have a "cards" key`);
    assertInt(a.seat, `${p}.seat`, 0, 2);
    if (a.cards === null) return; // 「不出」—— 合法且**必须**是这个字面值
    // 🔴 不得把 null 塞进 assertCardArray（它与 hand/bottomCards 共用、会因 null 变红）
    assertCardArray(a.cards, `${p}.cards`);
    if ((a.cards as Card[]).length === 0) {
      throw new ProtocolError(`${p}.cards must not be empty (空手出牌不存在；「不出」用 null 表示)`);
    }
  });
  assertNum(v.turnDeadlineAt, `${path}.turnDeadlineAt`);
  if (!isObj(v.bidPhase)) throw new ProtocolError(`${path}.bidPhase must be an object`);
  assertNum((v.bidPhase as Record<string, unknown>).currentBidder, `${path}.bidPhase.currentBidder`);
  assertNum((v.bidPhase as Record<string, unknown>).grabActions, `${path}.bidPhase.grabActions`);
  const bp = v.bidPhase as Record<string, unknown>;
  if (bp.kind !== 'call' && bp.kind !== 'rob') {
    throw new ProtocolError(`${path}.bidPhase.kind must be 'call' or 'rob', got ${JSON.stringify(bp.kind)}`);
  }
  if (!Array.isArray(bp.decisions)) {
    throw new ProtocolError(`${path}.bidPhase.decisions must be an array`);
  }
  if (bp.decisions.length > 4) {
    throw new ProtocolError(
      `${path}.bidPhase.decisions must have at most 4 items (一轮制 + 一次反抢), got ${bp.decisions.length}`,
    );
  }
  bp.decisions.forEach((d, i) => {
    const p = `${path}.bidPhase.decisions[${i}]`;
    if (!isObj(d)) throw new ProtocolError(`${p} must be an object`);
    // ⚠️ 现全校验器**从不检查键存在性** ⇒ 这里必须显式判，否则「缺 seat」会被当成合法
    if (!('seat' in d)) throw new ProtocolError(`${p} must have a "seat" key`);
    if (!('kind' in d)) throw new ProtocolError(`${p} must have a "kind" key`);
    if (!('grab' in d)) throw new ProtocolError(`${p} must have a "grab" key`);
    assertInt(d.seat, `${p}.seat`, 0, 2);
    if (d.kind !== 'call' && d.kind !== 'rob') {
      throw new ProtocolError(`${p}.kind must be 'call' or 'rob', got ${JSON.stringify(d.kind)}`);
    }
    if (typeof d.grab !== 'boolean') {
      throw new ProtocolError(`${p}.grab must be a boolean, got ${JSON.stringify(d.grab)}`);
    }
  });
}

function assertPdkPlayerView(v: unknown, path: string): asserts v is PdkPlayerView {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a PdkPlayerView object`);
  if (v.gameType !== 'paodekuai') {
    throw new ProtocolError(`${path}.gameType must be 'paodekuai', got ${JSON.stringify(v.gameType)}`);
  }
  assertOptionalPlayerCount(v.playerCount, `${path}.playerCount`);
  if (v.playerCount === undefined) {
    throw new ProtocolError(`${path}.playerCount is required for paodekuai`);
  }
  const playerCount = v.playerCount as number;
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.version, `${path}.version`);
  if (v.state !== 'playing' && v.state !== 'ended') {
    throw new ProtocolError(`${path}.state must be 'playing' | 'ended', got ${JSON.stringify(v.state)}`);
  }
  assertNum(v.seat, `${path}.seat`);
  assertInt(v.seat, `${path}.seat`, 0, playerCount - 1);
  assertNum(v.baseScore, `${path}.baseScore`);
  if ((v.baseScore as number) <= 0) {
    throw new ProtocolError(`${path}.baseScore must be positive`);
  }
  assertCardArray(v.hand, `${path}.hand`);
  if (!Array.isArray(v.cardCounts) || v.cardCounts.length !== playerCount) {
    throw new ProtocolError(`${path}.cardCounts must have length === playerCount (${playerCount})`);
  }
  v.cardCounts.forEach((n, i) => assertNum(n, `${path}.cardCounts[${i}]`));
  if (!Array.isArray(v.trustees) || v.trustees.length !== playerCount) {
    throw new ProtocolError(`${path}.trustees must have length === playerCount (${playerCount})`);
  }
  v.trustees.forEach((b, i) => {
    if (typeof b !== 'boolean') throw new ProtocolError(`${path}.trustees[${i}] must be a boolean`);
  });
  if (v.hand.length !== (v.cardCounts as number[])[v.seat as number]) {
    throw new ProtocolError(
      `${path}: hand.length (${v.hand.length}) must equal cardCounts[seat] (${String((v.cardCounts as number[])[v.seat as number])})`,
    );
  }
  assertNum(v.currentPlayer, `${path}.currentPlayer`);
  assertInt(v.currentPlayer, `${path}.currentPlayer`, 0, playerCount - 1);
  if (
    !Array.isArray(v.recentActions) ||
    v.recentActions.length > pdkRecentActionsWindow(playerCount)
  ) {
    throw new ProtocolError(
      `${path}.recentActions must be an array with at most ${pdkRecentActionsWindow(playerCount)} items (playerCount ${playerCount})`,
    );
  }
  v.recentActions.forEach((a, i) => {
    const p = `${path}.recentActions[${i}]`;
    if (!isObj(a)) throw new ProtocolError(`${p} must be an object`);
    if (!('seat' in a)) throw new ProtocolError(`${p} must have a "seat" key`);
    if (!('cards' in a)) throw new ProtocolError(`${p} must have a "cards" key`);
    assertInt(a.seat, `${p}.seat`, 0, playerCount - 1);
    if (a.cards === null) return;
    assertCardArray(a.cards, `${p}.cards`);
    if ((a.cards as Card[]).length === 0) {
      throw new ProtocolError(`${p}.cards must not be empty (「不出」用 null 表示)`);
    }
  });
  assertNum(v.turnDeadlineAt, `${path}.turnDeadlineAt`);
  if (typeof v.canPass !== 'boolean') {
    throw new ProtocolError(`${path}.canPass must be a boolean`);
  }
  assertNum(v.bombCount, `${path}.bombCount`);
  if (!isObj(v.pdkRules)) {
    throw new ProtocolError(`${path}.pdkRules must be an object`);
  }
  if (v.winnerSeats !== undefined) {
    if (!Array.isArray(v.winnerSeats) || v.winnerSeats.length === 0) {
      throw new ProtocolError(`${path}.winnerSeats must be a non-empty array`);
    }
    v.winnerSeats.forEach((s, i) => assertInt(s, `${path}.winnerSeats[${i}]`, 0, playerCount - 1));
  }
}

function assertTile(v: unknown, path: string): asserts v is Tile {
  if (!isTile(v)) throw new ProtocolError(`${path} must be a mahjong tile {s:0|1|2,r:1..9}`);
}

function assertTileArray(v: unknown, path: string): asserts v is Tile[] {
  if (!Array.isArray(v)) throw new ProtocolError(`${path} must be a Tile array`);
  v.forEach((t, i) => assertTile(t, `${path}[${i}]`));
}

function assertClientMahjongAction(v: unknown, path: string): asserts v is MahjongAction {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a MahjongAction object`);
  assertStr(v.type, `${path}.type`);
  switch (v.type) {
    case 'exchange': {
      assertTileArray(v.tiles, `${path}.tiles`);
      if (v.tiles.length !== 3) throw new ProtocolError(`${path}.tiles must have exactly 3 tiles`);
      if (new Set(v.tiles.map((t) => t.s)).size !== 1) {
        throw new ProtocolError(`${path}.tiles must be the same suit`);
      }
      break;
    }
    case 'lack':
      if (v.suit !== 0 && v.suit !== 1 && v.suit !== 2) {
        throw new ProtocolError(`${path}.suit must be 0|1|2`);
      }
      break;
    case 'discard':
    case 'concealedGang':
    case 'addedGang':
      assertTile(v.tile, `${path}.tile`);
      break;
    case 'selfDrawHu':
      break;
    case 'claim':
      if (v.claim !== 'hu' && v.claim !== 'gang' && v.claim !== 'peng' && v.claim !== 'pass') {
        throw new ProtocolError(`${path}.claim must be hu|gang|peng|pass`);
      }
      break;
    default:
      throw new ProtocolError(`${path}.type is unknown: ${JSON.stringify(v.type)}`);
  }
}

function assertMahjongPlayerView(v: unknown, path: string): asserts v is MahjongPlayerView {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a MahjongPlayerView object`);
  if (v.gameType !== 'mahjong') throw new ProtocolError(`${path}.gameType must be 'mahjong'`);
  if (v.playerCount !== 4) throw new ProtocolError(`${path}.playerCount must be 4`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.version, `${path}.version`);
  assertNum(v.seat, `${path}.seat`);
  assertNum(v.baseScore, `${path}.baseScore`);
  const phases = ['exchange', 'lack', 'play', 'claim', 'rob', 'draw', 'ended'];
  if (!phases.includes(v.state as string)) throw new ProtocolError(`${path}.state is invalid`);
  assertTileArray(v.hand, `${path}.hand`);
  if (!Array.isArray(v.cardCounts) || v.cardCounts.length !== 4) {
    throw new ProtocolError(`${path}.cardCounts must have length 4`);
  }
  v.cardCounts.forEach((n, i) => assertNum(n, `${path}.cardCounts[${i}]`));
  // 不变式：自己的手牌张数必须与公开的计数一致（与 ddz/pdk 对齐，提前拦截远端数据漂移）。
  if (v.hand.length !== (v.cardCounts as number[])[v.seat as number]) {
    throw new ProtocolError(
      `${path}: hand.length (${v.hand.length}) must equal cardCounts[seat] (${String((v.cardCounts as number[])[v.seat as number])})`,
    );
  }
  if (!Array.isArray(v.trustees) || v.trustees.length !== 4) {
    throw new ProtocolError(`${path}.trustees must have length 4`);
  }
  v.trustees.forEach((b, i) => {
    if (typeof b !== 'boolean') throw new ProtocolError(`${path}.trustees[${i}] must be a boolean`);
  });
  assertNum(v.dealerSeat, `${path}.dealerSeat`);
  assertNum(v.wallCount, `${path}.wallCount`);
  if (!Array.isArray(v.lackSuits) || v.lackSuits.length !== 4) {
    throw new ProtocolError(`${path}.lackSuits must have length 4`);
  }
  for (let i = 0; i < 4; i += 1) {
    const suit = v.lackSuits[i];
    if (suit !== null && suit !== 0 && suit !== 1 && suit !== 2) {
      throw new ProtocolError(`${path}.lackSuits[${i}] must be null|0|1|2`);
    }
  }
  if (!Array.isArray(v.melds) || v.melds.length !== 4) {
    throw new ProtocolError(`${path}.melds must have length 4`);
  }
  if (!Array.isArray(v.discards) || v.discards.length !== 4) {
    throw new ProtocolError(`${path}.discards must have length 4`);
  }
  v.discards.forEach((d, i) => assertTileArray(d, `${path}.discards[${i}]`));
  if (!Array.isArray(v.isOut) || v.isOut.length !== 4) {
    throw new ProtocolError(`${path}.isOut must have length 4`);
  }
  if (!Array.isArray(v.huInfos)) throw new ProtocolError(`${path}.huInfos must be an array`);
  if (!Array.isArray(v.activeSeats)) throw new ProtocolError(`${path}.activeSeats must be an array`);
  if (!Array.isArray(v.claimsForMe)) throw new ProtocolError(`${path}.claimsForMe must be an array`);
  if (!isObj(v.mahjongRules)) throw new ProtocolError(`${path}.mahjongRules must be an object`);
  if (!Array.isArray(v.revealedHands)) throw new ProtocolError(`${path}.revealedHands must be an array`);
  if (v.windowId !== undefined) assertStr(v.windowId, `${path}.windowId`);
}

function assertMahjongSettlement(v: unknown, path: string): asserts v is MahjongSettlementResult {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a MahjongSettlementResult object`);
  if (v.gameType !== 'mahjong') throw new ProtocolError(`${path}.gameType must be 'mahjong'`);
  if (v.playerCount !== 4) throw new ProtocolError(`${path}.playerCount must be 4`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if (!Array.isArray(v.winnerSeats)) throw new ProtocolError(`${path}.winnerSeats must be an array`);
  if (!Array.isArray(v.scoreChanges) || v.scoreChanges.length !== 4) {
    throw new ProtocolError(`${path}.scoreChanges must have length 4`);
  }
  let sum = 0;
  v.scoreChanges.forEach((c, i) => {
    if (!isObj(c)) throw new ProtocolError(`${path}.scoreChanges[${i}] must be an object`);
    assertNum(c.seat, `${path}.scoreChanges[${i}].seat`);
    assertNum(c.delta, `${path}.scoreChanges[${i}].delta`);
    sum += c.delta as number;
  });
  if (sum !== 0) throw new ProtocolError(`${path}: scoreChanges must be zero-sum, got ${sum}`);
  if (!Array.isArray(v.fanDetails)) throw new ProtocolError(`${path}.fanDetails must be an array`);
  if (!Array.isArray(v.events)) throw new ProtocolError(`${path}.events must be an array`);
  if (!Array.isArray(v.burn)) throw new ProtocolError(`${path}.burn must be an array`);
  assertNum(v.rakeTotal, `${path}.rakeTotal`);
  if (!Array.isArray(v.chajiao)) throw new ProtocolError(`${path}.chajiao must be an array`);
  if (typeof v.liuju !== 'boolean') throw new ProtocolError(`${path}.liuju must be boolean`);
  if (!Array.isArray(v.huazhuSeats)) throw new ProtocolError(`${path}.huazhuSeats must be an array`);
  if (v.endReason !== 'threeWinners' && v.endReason !== 'wallEmpty') {
    throw new ProtocolError(`${path}.endReason is invalid`);
  }
  if (!Array.isArray(v.writtenOff)) throw new ProtocolError(`${path}.writtenOff must be an array`);
}

function assertGameView(v: unknown, path: string): asserts v is GameView {
  if (isObj(v) && v.gameType === 'paodekuai') {
    assertPdkPlayerView(v, path);
    return;
  }
  if (isObj(v) && v.gameType === 'mahjong') {
    assertMahjongPlayerView(v, path);
    return;
  }
  assertPlayerView(v, path);
}

function assertDdzSettlement(v: unknown, path: string): asserts v is DdzSettlementResult {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a SettlementResult object`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if (v.winner !== 'landlord' && v.winner !== 'farmer') {
    throw new ProtocolError(`${path}.winner must be 'landlord' | 'farmer'`);
  }
  assertNum(v.landlordSeat, `${path}.landlordSeat`);
  if (!Array.isArray(v.farmerSeats)) throw new ProtocolError(`${path}.farmerSeats must be an array`);
  assertNum(v.multiplier, `${path}.multiplier`);
  if (v.spring !== 'none' && v.spring !== 'spring' && v.spring !== 'anti-spring') {
    throw new ProtocolError(`${path}.spring must be 'none' | 'spring' | 'anti-spring'`);
  }
  assertNum(v.landlordScoreChange, `${path}.landlordScoreChange`);
  assertNum(v.farmerScoreChange, `${path}.farmerScoreChange`);
  // 不变式：分数必须守恒（玩法 §8.4）
  const sum = (v.landlordScoreChange as number) + (v.farmerScoreChange as number) * (v.farmerSeats as number[]).length;
  if (sum !== 0) throw new ProtocolError(`${path}: score must be conserved, got sum=${sum}`);
}

function assertPdkSettlement(v: unknown, path: string): asserts v is PdkSettlementResult {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a PdkSettlementResult object`);
  if (v.gameType !== 'paodekuai') {
    throw new ProtocolError(`${path}.gameType must be 'paodekuai'`);
  }
  assertOptionalPlayerCount(v.playerCount, `${path}.playerCount`);
  if (v.playerCount === undefined) {
    throw new ProtocolError(`${path}.playerCount is required for paodekuai`);
  }
  const playerCount = v.playerCount as number;
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if (!Array.isArray(v.winnerSeats) || v.winnerSeats.length === 0) {
    throw new ProtocolError(`${path}.winnerSeats must be a non-empty array`);
  }
  v.winnerSeats.forEach((s, i) => assertInt(s, `${path}.winnerSeats[${i}]`, 0, playerCount - 1));

  if (!Array.isArray(v.scoreChanges) || v.scoreChanges.length !== playerCount) {
    throw new ProtocolError(`${path}.scoreChanges must have length === playerCount (${playerCount})`);
  }
  let sum = 0;
  v.scoreChanges.forEach((c, i) => {
    const p = `${path}.scoreChanges[${i}]`;
    if (!isObj(c)) throw new ProtocolError(`${p} must be an object`);
    assertInt(c.seat, `${p}.seat`, 0, playerCount - 1);
    assertNum(c.delta, `${p}.delta`);
    if (i > 0 && (c.seat as number) <= (v.scoreChanges as { seat: number }[])[i - 1]!.seat) {
      throw new ProtocolError(`${path}.scoreChanges must be sorted by seat ascending`);
    }
    sum += c.delta as number;
  });
  if (sum !== 0) throw new ProtocolError(`${path}: score must be conserved, got sum=${sum}`);

  if (!Array.isArray(v.remaining) || v.remaining.length !== playerCount) {
    throw new ProtocolError(`${path}.remaining must have length === playerCount (${playerCount})`);
  }
  v.remaining.forEach((n, i) => assertInt(n, `${path}.remaining[${i}]`, 0, 999));
  assertNum(v.multiplier, `${path}.multiplier`);
  assertInt(v.bombCount, `${path}.bombCount`, 0, 999);
  if (typeof v.guan !== 'boolean') throw new ProtocolError(`${path}.guan must be a boolean`);
  if (typeof v.spring !== 'boolean') throw new ProtocolError(`${path}.spring must be a boolean`);
  if (!Array.isArray(v.baobenSeats)) {
    throw new ProtocolError(`${path}.baobenSeats must be an array`);
  }
  v.baobenSeats.forEach((s, i) => assertInt(s, `${path}.baobenSeats[${i}]`, 0, playerCount - 1));
}

function assertSettlement(v: unknown, path: string): asserts v is SettlementResult {
  if (isObj(v) && v.gameType === 'paodekuai') {
    assertPdkSettlement(v, path);
    return;
  }
  if (isObj(v) && v.gameType === 'mahjong') {
    assertMahjongSettlement(v, path);
    return;
  }
  assertDdzSettlement(v, path);
}

function assertRoomPlayer(v: unknown, path: string): asserts v is RoomPlayer {
  if (!isObj(v)) throw new ProtocolError(`${path} must be a RoomPlayer object`);
  assertStr(v.id, `${path}.id`);
  assertNum(v.seat, `${path}.seat`);
  if (v.nickname !== undefined) assertStr(v.nickname, `${path}.nickname`);
}

/** 服务端**发送前**调用。违反契约即抛错，让 bug 在服务端就暴露。 */
export function validateOutbound(msg: unknown): ServerMessage {
  assertNoLeak(msg);
  if (!isObj(msg)) throw new ProtocolError('message must be an object');
  const { type } = msg;
  assertStr(type, '$.type');
  if (!SERVER_MESSAGE_TYPES.includes(type as ServerMessageType)) {
    throw new ProtocolError(`unknown S→C message type: "${type}" (see docs/design.md §6.3)`);
  }
  assertNum(msg.version, '$.version');
  const p = msg.payload;
  switch (type as ServerMessageType) {
    case 'game.deal':
    case 'game.state_update':
      assertGameView(p, '$.payload');
      // 快照类消息的版本**只有一个来源**：外层信封的 version。
      // 载荷里的 version 必须与它相等，否则客户端会在两个值之间摇摆。
      if ((p as GameView).version !== msg.version) {
        throw new ProtocolError(
          `$.payload.version (${String((p as GameView).version)}) must equal the envelope version (${String(msg.version)})`,
        );
      }
      break;
    case 'game.settlement':
      assertSettlement(p, '$.payload');
      break;
    case 'game.balances': {
      // 多玩法：长度 = playerCount（缺失 = 斗地主/3）；座位升序、各座至多一条。
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertOptionalGameType(p.gameType, '$.payload.gameType');
      assertOptionalPlayerCount(p.playerCount, '$.payload.playerCount');
      const expected = (p.playerCount as number | undefined) ?? 3;
      if (!Array.isArray(p.balances)) throw new ProtocolError('$.payload.balances must be an array');
      if (p.balances.length !== expected) {
        throw new ProtocolError(
          `$.payload.balances must have exactly ${expected} items (playerCount), got ${p.balances.length}`,
        );
      }
      p.balances.forEach((b, i) => {
        const path = `$.payload.balances[${i}]`;
        if (!isObj(b)) throw new ProtocolError(`${path} must be an object`);
        assertInt(b.seat, `${path}.seat`, 0, expected - 1);
        assertNum(b.balance, `${path}.balance`);
        if (i > 0 && (b.seat as number) <= (p.balances as { seat: number }[])[i - 1]!.seat) {
          throw new ProtocolError(`$.payload.balances must be sorted by seat ascending (座位升序、各座至多一条)`);
        }
      });
      break;
    }
    case 'room.matched': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertStr(p.roomCode, '$.payload.roomCode');
      assertNum(p.seat, '$.payload.seat');
      assertOptionalGameType(p.gameType, '$.payload.gameType');
      assertOptionalPlayerCount(p.playerCount, '$.payload.playerCount');
      break;
    }
    case 'room.state_update': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertStr(p.status, '$.payload.status');
      assertOptionalGameType(p.gameType, '$.payload.gameType');
      assertOptionalPlayerCount(p.playerCount, '$.payload.playerCount');
      if (!Array.isArray(p.players)) throw new ProtocolError('$.payload.players must be an array');
      p.players.forEach((pl, i) => assertRoomPlayer(pl, `$.payload.players[${i}]`));
      break;
    }
    case 'match.wait_prompt': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertStr(p.message, '$.payload.message');
      break;
    }
    case 'game.card_counter': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertStr(p.roomCode, '$.payload.roomCode');
      if (typeof p.active !== 'boolean') {
        throw new ProtocolError('$.payload.active must be a boolean');
      }
      if (
        p.source !== undefined &&
        !['pass', 'credit', 'none', 'unknown'].includes(p.source as string)
      ) {
        throw new ProtocolError("$.payload.source must be 'pass' | 'credit' | 'none' | 'unknown'");
      }
      break;
    }
    case 'game.current_turn': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertNum(p.seat, '$.payload.seat');
      assertNum(p.timeoutMs, '$.payload.timeoutMs');
      break;
    }
    case 'game.finished': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      if (p.gameType === 'paodekuai') {
        if (!Array.isArray(p.winnerSeats) || p.winnerSeats.length === 0) {
          throw new ProtocolError('$.payload.winnerSeats must be a non-empty array');
        }
        p.winnerSeats.forEach((s, i) => assertInt(s, `$.payload.winnerSeats[${i}]`, 0, 3));
        break;
      }
      if (p.gameType === 'mahjong') {
        // 血战可能无人胡（荒庄）⇒ winnerSeats 允许空数组。
        if (!Array.isArray(p.winnerSeats)) {
          throw new ProtocolError('$.payload.winnerSeats must be an array');
        }
        p.winnerSeats.forEach((s, i) => assertInt(s, `$.payload.winnerSeats[${i}]`, 0, 3));
        if (p.endReason !== 'threeWinners' && p.endReason !== 'wallEmpty') {
          throw new ProtocolError("$.payload.endReason must be 'threeWinners' | 'wallEmpty'");
        }
        if (!Array.isArray(p.huazhuSeats)) {
          throw new ProtocolError('$.payload.huazhuSeats must be an array');
        }
        p.huazhuSeats.forEach((s, i) => assertInt(s, `$.payload.huazhuSeats[${i}]`, 0, 3));
        break;
      }
      if (p.winner !== 'landlord' && p.winner !== 'farmer') {
        throw new ProtocolError("$.payload.winner must be 'landlord' | 'farmer'");
      }
      break;
    }
    case 'system.error':
    case 'system.warning': {
      if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
      assertNum(p.code, '$.payload.code');
      assertStr(p.message, '$.payload.message');
      break;
    }
    default: {
      // 穷尽性检查：新增 S→C 消息类型时这里会编译失败
      const never: never = type as never;
      throw new ProtocolError(`unhandled S→C message type: ${String(never)}`);
    }
  }
  return msg as ServerMessage;
}

/**
 * 客户端**处理前**调用。与服务端同一套检查——契约是双向的。
 *
 * ⚠️ **S→C 的线格式把事件名与消息体分开了**（B2 修复）：socket.io 的**事件名**承载 `type`，
 * 消息体只有 `{ version, payload }` —— 真实网关就是这么发的
 * （`api-gateway/src/gateway/proxy.gateway.ts`：`client.emit(type, message)`，而它只在**出站校验前**
 * 临时补 `type`）。⇒ 客户端**必须**把事件名 `type` 一起传进来，由本函数合回完整消息再校验。
 *
 * ⚠️ **为什么 `type` 是必填而不是可选**：它可选的话，「有人忘了传」就会退化成「要求 body 带 `type`」
 * —— 而那正是**对着 mock 能过、对着真网关必抛**的那个漂移形态（`mock-server` 发的是
 * `socket.emit(checked.type, checked)`，body 里**带** `type`）。必填能让编译器把漏传钉死在编译期。
 */
export function validateInbound(type: ServerMessageType, msg: unknown): ServerMessage {
  if (!isObj(msg)) throw new ProtocolError('message must be an object');
  // 事件名是 `type` 的**唯一**来源；body 里若也带了 `type`（mock 形态），以事件名为准覆盖之，
  // 避免「同一个字段两个来源」在服务端漂移时静默通过。
  return validateOutbound({ ...(msg as Record<string, unknown>), type });
}

/**
 * 校验 C→S 请求。
 *
 * **线格式是扁平的**（§6.2）：`type` 由 **socket.io 的事件名**承载，meta 字段**平铺**在请求体里。
 *
 * ```ts
 * socket.timeout(5000).emit(type, { reqId, baseVersion, timestamp, payload }, (err, res) => ...)
 * ```
 *
 * 本函数把扁平体组装成逻辑格式 `{ type, meta, payload }` 再返回。
 * **请求体里不重复 `type`**——这是 §6.2 的约定，校验器必须迁就线格式，而不是反过来。
 */
export function validateClientMessage(type: unknown, body: unknown): ClientMessage {
  assertStr(type, 'event name');
  if (!CLIENT_MESSAGE_TYPES.includes(type as ClientMessageType)) {
    throw new ProtocolError(`unknown C→S message type: "${String(type)}" (see docs/design.md §6.3)`);
  }
  if (!isObj(body)) throw new ProtocolError('request body must be an object');
  assertStr(body.reqId, '$.reqId');
  assertNum(body.baseVersion, '$.baseVersion');
  assertNum(body.timestamp, '$.timestamp');
  if (body.windowId !== undefined) assertStr(body.windowId, '$.windowId');
  const p = body.payload;
  if (!isObj(p)) throw new ProtocolError('$.payload must be an object');
  switch (type as ClientMessageType) {
    case 'room.match':
      if (p.mode !== 'random' && p.mode !== 'practice' && p.mode !== 'gold') {
        throw new ProtocolError("$.payload.mode must be 'random' | 'practice' | 'gold'");
      }
      // 片规格 §2.4 协议②：baseScore **必填**。可选的话撮合键那一维可能是 undefined、
      // 产生两种 key；必填让「不同底分不会同房」在类型上就成立。
      assertNum(p.baseScore, '$.payload.baseScore');
      assertOptionalGameType(p.gameType, '$.payload.gameType');
      assertOptionalPlayerCount(p.playerCount, '$.payload.playerCount');
      // 风控片 T1（规格 §2.1-1 / C13）：deviceId 可缺省（旧客户端）；存在 ⇒ string、
      // 长度 8..64、charset [A-Za-z0-9._-]（客户端 randomUUID 与 `dev-<base36>` 形态），
      // 否则 ProtocolError（⇒ 400 / 10001）。
      if (p.deviceId !== undefined) {
        if (
          typeof p.deviceId !== 'string' ||
          p.deviceId.length < 8 ||
          p.deviceId.length > 64 ||
          !/^[A-Za-z0-9._-]+$/.test(p.deviceId)
        ) {
          throw new ProtocolError(
            '$.payload.deviceId must be a string of 8..64 chars matching [A-Za-z0-9._-]',
          );
        }
      }
      break;
    case 'room.join':
      assertStr(p.roomCode, '$.payload.roomCode');
      assertOptionalGameType(p.gameType, '$.payload.gameType');
      break;
    case 'room.leave':
      assertStr(p.roomCode, '$.payload.roomCode');
      break;
    case 'game.bid':
      if (typeof p.grab !== 'boolean') throw new ProtocolError('$.payload.grab must be a boolean');
      break;
    // 挂机治理：托管开关（manual via 由 room-service 转发时补齐）。
    // ⛔ 不得写成裸 `break` —— `on` 必须严格 boolean（字符串 'false' 也拒 ⇒ 10001）。
    case 'game.trustee':
      if (typeof p.on !== 'boolean') throw new ProtocolError('$.payload.on must be a boolean');
      break;
    case 'game.play': {
      const hasCards = p.cards !== undefined;
      const hasMahjong = p.mahjong !== undefined;
      if (hasCards === hasMahjong) {
        throw new ProtocolError('$.payload must contain exactly one of cards|mahjong');
      }
      if (hasCards) {
        assertCardArray(p.cards, '$.payload.cards');
        if ((p.cards as Card[]).length === 0) {
          throw new ProtocolError('$.payload.cards must not be empty — use game.pass instead');
        }
      } else {
        assertClientMahjongAction(p.mahjong, '$.payload.mahjong');
      }
      break;
    }
    case 'game.reconnect':
      if (p.lastVersion !== undefined) assertNum(p.lastVersion, '$.payload.lastVersion');
      break;
    case 'room.unmatch':
    case 'room.match.extend':
    case 'game.pass':
    case 'game.resync':
      break;
    default: {
      const never: never = type as never;
      throw new ProtocolError(`unhandled C→S message type: ${String(never)}`);
    }
  }
  return {
    type,
    meta: {
      reqId: body.reqId as string,
      baseVersion: body.baseVersion as number,
      timestamp: body.timestamp as number,
      ...(body.windowId === undefined ? {} : { windowId: body.windowId as string }),
    },
    payload: p,
  } as ClientMessage;
}
