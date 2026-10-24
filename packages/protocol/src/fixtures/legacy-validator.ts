// packages/protocol/src/fixtures/legacy-validator.ts
//
// Task 0.1：**旧客户端出站校验器**的冻结副本（仅供兼容测试）。
//
// ⚠️ 这是“重构前行为”的快照，不是第二份生产校验器：
//  - 不得 import `../validate` / `./validate`（由 legacy-validator.gate.test.ts 机械拦截）；
//  - 只覆盖 ddz 相关 S→C 消息；新增字段（gameType/playerCount/scoreChanges/winnerSeats）
//    必须被**忽略**，以证明旧客户端不会因新增字段报错。
import { isValidDouZeroCard } from '../codec';
import type { Card, PlayerView, DdzSettlementResult } from '../views';

export class LegacyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyProtocolError';
  }
}

const LEGACY_SERVER_TYPES = [
  'game.deal',
  'game.state_update',
  'game.settlement',
  'game.balances',
  'game.finished',
] as const;
type LegacyServerType = (typeof LEGACY_SERVER_TYPES)[number];

const LEGACY_FORBIDDEN_KEYS = [
  'actionLog',
  'isRobot',
  'botId',
  'skillLevel',
  'thinkingSpeed',
  'deviceId',
] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertNum(v: unknown, path: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new LegacyProtocolError(`${path} must be a finite number`);
  }
}

function assertStr(v: unknown, path: string): asserts v is string {
  if (typeof v !== 'string') throw new LegacyProtocolError(`${path} must be a string`);
}

function assertInt(v: unknown, path: string, min: number, max: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new LegacyProtocolError(`${path} must be an integer in ${min}..${max}`);
  }
}

function assertCardArray(v: unknown, path: string): asserts v is Card[] {
  if (!Array.isArray(v)) throw new LegacyProtocolError(`${path} must be an array`);
  v.forEach((c, i) => {
    if (!isObj(c) || !isValidDouZeroCard(c.r)) {
      throw new LegacyProtocolError(`${path}[${i}] must be a valid Card`);
    }
    if (!Number.isInteger(c.s) || (c.s as number) < 0 || (c.s as number) > 4) {
      throw new LegacyProtocolError(`${path}[${i}].s must be 0..4`);
    }
  });
}

function assertNoLeak(node: unknown, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertNoLeak(n, `${path}[${i}]`));
    return;
  }
  if (!isObj(node)) return;
  for (const key of Object.keys(node)) {
    if ((LEGACY_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      throw new LegacyProtocolError(`leak ${path}.${key}`);
    }
    assertNoLeak(node[key], `${path}.${key}`);
  }
}

function assertPlayerView(v: unknown, path: string): asserts v is PlayerView {
  if (!isObj(v)) throw new LegacyProtocolError(`${path} must be a PlayerView`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.version, `${path}.version`);
  if (!['init', 'bidding', 'playing', 'ended'].includes(v.state as string)) {
    throw new LegacyProtocolError(`${path}.state invalid`);
  }
  assertNum(v.seat, `${path}.seat`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if ((v.baseScore as number) <= 0) throw new LegacyProtocolError(`${path}.baseScore must be > 0`);
  assertCardArray(v.hand, `${path}.hand`);
  if (!Array.isArray(v.cardCounts) || v.cardCounts.length !== 3) {
    throw new LegacyProtocolError(`${path}.cardCounts must be 3-tuple`);
  }
  v.cardCounts.forEach((n, i) => assertNum(n, `${path}.cardCounts[${i}]`));
  if (!Array.isArray(v.trustees) || v.trustees.length !== 3) {
    throw new LegacyProtocolError(`${path}.trustees must be 3-tuple`);
  }
  v.trustees.forEach((b, i) => {
    if (typeof b !== 'boolean') throw new LegacyProtocolError(`${path}.trustees[${i}] must be boolean`);
  });
  if (v.hand.length !== (v.cardCounts as number[])[v.seat as number]) {
    throw new LegacyProtocolError(`${path}.hand length != cardCounts[seat]`);
  }
  if (v.bottomCards !== null) assertCardArray(v.bottomCards, `${path}.bottomCards`);
  if (v.landlordSeat !== null) assertNum(v.landlordSeat, `${path}.landlordSeat`);
  assertNum(v.currentPlayer, `${path}.currentPlayer`);
  if (!Array.isArray(v.recentActions) || v.recentActions.length > 2) {
    throw new LegacyProtocolError(`${path}.recentActions invalid`);
  }
  assertNum(v.turnDeadlineAt, `${path}.turnDeadlineAt`);
  if (!isObj(v.bidPhase)) throw new LegacyProtocolError(`${path}.bidPhase must be object`);
  assertNum(v.bidPhase.currentBidder, `${path}.bidPhase.currentBidder`);
  assertNum(v.bidPhase.grabActions, `${path}.bidPhase.grabActions`);
}

function assertSettlement(v: unknown, path: string): asserts v is DdzSettlementResult {
  if (!isObj(v)) throw new LegacyProtocolError(`${path} must be SettlementResult`);
  assertStr(v.roomCode, `${path}.roomCode`);
  assertNum(v.baseScore, `${path}.baseScore`);
  if (v.winner !== 'landlord' && v.winner !== 'farmer') {
    throw new LegacyProtocolError(`${path}.winner invalid`);
  }
  assertNum(v.landlordSeat, `${path}.landlordSeat`);
  if (!Array.isArray(v.farmerSeats)) throw new LegacyProtocolError(`${path}.farmerSeats invalid`);
  assertNum(v.multiplier, `${path}.multiplier`);
  if (!['none', 'spring', 'anti-spring'].includes(v.spring as string)) {
    throw new LegacyProtocolError(`${path}.spring invalid`);
  }
  assertNum(v.landlordScoreChange, `${path}.landlordScoreChange`);
  assertNum(v.farmerScoreChange, `${path}.farmerScoreChange`);
}

/** 旧版 ddz 出站校验：新增字段一律忽略。 */
export function validateLegacyOutbound(msg: unknown): void {
  assertNoLeak(msg);
  if (!isObj(msg)) throw new LegacyProtocolError('message must be object');
  assertStr(msg.type, '$.type');
  if (!(LEGACY_SERVER_TYPES as readonly string[]).includes(msg.type)) {
    throw new LegacyProtocolError(`unknown legacy S→C type: ${msg.type}`);
  }
  assertNum(msg.version, '$.version');
  const p = msg.payload;
  switch (msg.type as LegacyServerType) {
    case 'game.deal':
    case 'game.state_update':
      assertPlayerView(p, '$.payload');
      if ((p as PlayerView).version !== msg.version) {
        throw new LegacyProtocolError('payload.version != envelope.version');
      }
      break;
    case 'game.settlement':
      assertSettlement(p, '$.payload');
      break;
    case 'game.balances': {
      if (!isObj(p) || !Array.isArray(p.balances) || p.balances.length !== 3) {
        throw new LegacyProtocolError('$.payload.balances must be exactly 3');
      }
      p.balances.forEach((b, i) => {
        if (!isObj(b)) throw new LegacyProtocolError(`$.payload.balances[${i}] invalid`);
        assertInt(b.seat, `$.payload.balances[${i}].seat`, 0, 2);
        assertNum(b.balance, `$.payload.balances[${i}].balance`);
      });
      break;
    }
    case 'game.finished':
      if (!isObj(p) || (p.winner !== 'landlord' && p.winner !== 'farmer')) {
        throw new LegacyProtocolError('$.payload.winner invalid');
      }
      break;
  }
}
