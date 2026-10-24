import { describe, it, expect } from 'vitest';
import {
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  ROOM_MESSAGES,
  CAS_MESSAGES,
  type ServerMessage,
} from './messages';
import { ProtocolError, validateOutbound, validateInbound, validateClientMessage, assertNoLeak } from './validate';
import { RPC_PATTERNS } from './rpc';
import type { Card, PlayerView, DdzSettlementResult } from './views';

/** R696 之后牌是 `{r, s}`，夹具用这个构造。默认黑桃（`s = 0`）。 */
const c = (r: number, s = 0): Card => ({ r, s });

function view(over: Partial<PlayerView> = {}): PlayerView {
  return {
    roomCode: 'ABC123',
    version: 3,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [c(3), c(4), c(5)],
    cardCounts: [3, 17, 17],
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: 1,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: Date.now() + 30_000,
    bidPhase: { currentBidder: 0, bidMultiplier: 2, landlordCandidate: 1, grabActions: 3, redealCount: 0, kind: 'rob', decisions: [] },
    playPhase: { bombCount: 0 },
    ...over,
  };
}

describe('message type inventory', () => {
  it('declares 11 C→S and 12 S→C types (docs/design.md §6.3)', () => {
    expect(CLIENT_MESSAGE_TYPES).toHaveLength(11); // 挂机治理片 +1 = game.trustee
    expect(SERVER_MESSAGE_TYPES).toHaveLength(12); // 记牌器收费片 +1 = game.card_counter
    expect(SERVER_MESSAGE_TYPES).toContain('game.balances');
    expect(SERVER_MESSAGE_TYPES).toContain('game.card_counter');
    expect(CLIENT_MESSAGE_TYPES).toContain('room.match.extend');
    expect(CLIENT_MESSAGE_TYPES).toContain('game.trustee');
    expect(SERVER_MESSAGE_TYPES).toContain('match.wait_prompt');
    expect(ROOM_MESSAGES).toContain('game.card_counter');
  });

  it('marks exactly three messages as participating in baseVersion CAS', () => {
    expect([...CAS_MESSAGES]).toEqual(['game.bid', 'game.play', 'game.pass']);
  });
});

describe('RPC pattern inventory (docs/design.md §4.2, N20/P4)', () => {
  /**
   * 判据是**逐字**的：`@MessagePattern` 与 `ClientProxy.send()` 两端都 import 这些常量，
   * 因此「改了常量」会同时改两端 —— 但**常量本身漂移**（例如把 `game.view` 写成 `game.getView`）
   * 会让实现整体偏离 §4.2，而单测全绿。这条把它钉死在规格上。
   */
  it('§4.2 的二十二个 pattern 名逐字不变（片⑦ 把第八条换成 config.snapshot、记录片末位加 record.write、货币片末位加 currency.apply/currency.get、金币场末位加 record.moneyDelta、风控片末位加 risk.deviceReport、支付片末位加 currency.withdrawable.get、支付配置管理化片末位加 config.payChannel.get、通知通道管理化片末位加 config.notifyChannel.get、广告片末位加 config.adChannel.get、台费片末位加 currency.entryFeeSkip、昵称片末位加 user.nicknames.get、挂机治理片末位加 game.trustee、记牌器收费片末位加 currency.cardCounterConsume）', () => {
    expect(RPC_PATTERNS).toEqual({
      gameStart: 'game.start',
      gameView: 'game.view',
      gameSnapshot: 'game.snapshot',
      gameAction: 'game.action',
      robotAcquire: 'robot.acquire',
      robotRelease: 'robot.release',
      robotDecide: 'robot.decide',
      configSnapshot: 'config.snapshot',
      robotAvailability: 'robot.availability',
      recordWrite: 'record.write',
      currencyApply: 'currency.apply',
      currencyGet: 'currency.get',
      recordMoneyDelta: 'record.moneyDelta',
      riskDeviceReport: 'risk.deviceReport',
      currencyWithdrawableGet: 'currency.withdrawable.get',
      configPayChannelGet: 'config.payChannel.get',
      configNotifyChannelGet: 'config.notifyChannel.get',
      configAdChannelGet: 'config.adChannel.get',
      currencyEntryFeeSkip: 'currency.entryFeeSkip',
      userNicknamesGet: 'user.nicknames.get',
      gameTrustee: 'game.trustee',
      currencyCardCounterConsume: 'currency.cardCounterConsume',
    });
  });

  it('探针判别力：`toEqual` 对「改一个字符」确实会红（防判据被写成恒真）', () => {
    // R115/R150 同族：断言「没发生」之前先证明判据能观测到「发生」。
    // 用一个与上面**同形但改了一个字符**的字面量，断言它**不**等于 `RPC_PATTERNS`。
    const mutated = { ...RPC_PATTERNS, gameSnapshot: 'game.snapshot2' };
    expect(() => expect(mutated).toEqual(RPC_PATTERNS)).toThrow();
    expect(() => expect({ ...RPC_PATTERNS }).toEqual(RPC_PATTERNS)).not.toThrow();
  });
});

describe('validateOutbound', () => {
  it('accepts a well-formed game.state_update', () => {
    const msg: ServerMessage = { type: 'game.state_update', version: 3, payload: view() };
    expect(() => validateOutbound(msg)).not.toThrow();
  });

  it('is the same check on both sides', () => {
    const msg: ServerMessage = {
      type: 'game.deal',
      version: 3,
      payload: view({ state: 'bidding', bottomCards: null }),
    };
    expect(() => validateInbound('game.deal', msg)).not.toThrow();
  });

  /**
   * B2 的回归判据：**真实的 S→C 线格式里 body 没有 `type`**（网关 `client.emit(type, message)`），
   * `type` 由 socket.io 的**事件名**承载。旧实现直接 `validateOutbound(msg)` ⇒ 要求 body 带 `type`
   * ⇒ **对着 mock 能过（mock 发 `socket.emit(checked.type, checked)`）、对着真网关必抛**
   * （`ProtocolError: $.type must be a string, got undefined`），且因为没有浏览器在 CI 里，长期未被发现。
   */
  it('accepts the REAL wire shape（body 无 type，type 来自事件名）—— B2 回归', () => {
    const wire = { version: 3, payload: view({ state: 'bidding', bottomCards: null }) };
    expect('type' in wire).toBe(false);
    expect(() => validateInbound('game.deal', wire)).not.toThrow();
  });

  it('仍拒绝「事件名合法但 body 与该事件名不符」的消息', () => {
    // 事件名说 game.deal，body 却是别的形状 ⇒ 必须抛（事件名不是免检通行证）
    expect(() => validateInbound('game.deal', { version: 3, payload: { nope: true } })).toThrow(ProtocolError);
    // 事件名不在契约里 ⇒ 也必须抛
    expect(() =>
      validateInbound('game.not_a_type' as never, { version: 3, payload: {} }),
    ).toThrow(ProtocolError);
  });

  it('rejects an unknown message type', () => {
    expect(() => validateOutbound({ type: 'game.card_played', version: 1, payload: {} })).toThrow(ProtocolError);
  });

  it('accepts match.wait_prompt with a string message（机器人补位开关片）', () => {
    const msg: ServerMessage = {
      type: 'match.wait_prompt',
      version: 0,
      payload: { message: '当前在线玩家不足，可延长等待或重新匹配' },
    };
    expect(() => validateOutbound(msg)).not.toThrow();
    expect(() => validateInbound('match.wait_prompt', { version: 0, payload: msg.payload })).not.toThrow();
  });

  it('rejects match.wait_prompt without a string message', () => {
    expect(() =>
      validateOutbound({ type: 'match.wait_prompt', version: 0, payload: {} }),
    ).toThrow(ProtocolError);
    expect(() =>
      validateOutbound({ type: 'match.wait_prompt', version: 0, payload: { message: 12007 } }),
    ).toThrow(ProtocolError);
  });

  it('accepts game.card_counter with valid fields（记牌器收费片）', () => {
    const msg: ServerMessage = {
      type: 'game.card_counter',
      version: 0,
      payload: { roomCode: 'ABC123', active: true, source: 'credit' },
    };
    expect(() => validateOutbound(msg)).not.toThrow();
    expect(() => validateInbound('game.card_counter', { version: 0, payload: msg.payload })).not.toThrow();
    expect(() =>
      validateOutbound({ type: 'game.card_counter', version: 0, payload: { roomCode: 'ABC123', active: false } }),
    ).not.toThrow();
  });

  it('rejects game.card_counter with bad roomCode/active/source', () => {
    expect(() =>
      validateOutbound({ type: 'game.card_counter', version: 0, payload: { roomCode: 1, active: true } }),
    ).toThrow(ProtocolError);
    expect(() =>
      validateOutbound({ type: 'game.card_counter', version: 0, payload: { roomCode: 'ABC123', active: 1 } }),
    ).toThrow(/active/);
    expect(() =>
      validateOutbound({
        type: 'game.card_counter',
        version: 0,
        payload: { roomCode: 'ABC123', active: true, source: 'bogus' },
      }),
    ).toThrow(/source/);
  });

  it('rejects a message without version', () => {
    expect(() => validateOutbound({ type: 'game.state_update', payload: view() })).toThrow(/version/);
  });

  it('rejects a hand that disagrees with cardCounts[seat]', () => {
    const bad = view({ hand: [c(3), c(4), c(5)], cardCounts: [5, 17, 15] });
    expect(() => validateOutbound({ type: 'game.state_update', version: 3, payload: bad })).toThrow(/cardCounts\[seat\]/);
  });

  it('rejects a card value that is not a legal DouZero code', () => {
    const bad = view({ hand: [c(16)], cardCounts: [1, 17, 17] });
    expect(() => validateOutbound({ type: 'game.state_update', version: 3, payload: bad })).toThrow(/not a valid DouZero card/);
  });

  it('keeps the envelope version as the single source of truth for snapshots', () => {
    // 载荷里的 PlayerView.version 必须等于外层 version，否则客户端会在两个值之间摇摆
    expect(() =>
      validateOutbound({ type: 'game.state_update', version: 3, payload: view({ version: 99 }) }),
    ).toThrow(/must equal the envelope version/);
  });

  it('rejects a non-conserved settlement', () => {
    const bad: DdzSettlementResult = {
      roomCode: 'ABC123',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 400,
      farmerScoreChange: -100,
    };
    expect(() => validateOutbound({ type: 'game.settlement', version: 9, payload: bad })).toThrow(/conserved/);
  });

  it('accepts a conserved settlement', () => {
    const ok: DdzSettlementResult = {
      roomCode: 'ABC123',
      baseScore: 100,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 400,
      farmerScoreChange: -200,
    };
    expect(() => validateOutbound({ type: 'game.settlement', version: 9, payload: ok })).not.toThrow();
  });

  it('协议⑥：baseScore 必填且必须为正数', () => {
    const ok = { type: 'game.state_update' as const, version: 3, payload: { ...view(), baseScore: 15 } };
    expect(() => validateOutbound(ok)).not.toThrow();

    expect(() => validateOutbound({ ...ok, payload: { ...view(), baseScore: 0 } })).toThrow(
      /baseScore must be positive/,
    );
    expect(() => validateOutbound({ ...ok, payload: { ...view(), baseScore: undefined } })).toThrow(
      /baseScore must be a finite number/,
    );
  });

  it('协议③：bidPhase.kind 只接受 call / rob', () => {
    const payload = (kind: unknown) => ({
      ...view(),
      bidPhase: { ...view().bidPhase, kind },
    });
    const msg = (kind: unknown) => ({ type: 'game.state_update' as const, version: 3, payload: payload(kind) });
    expect(() => validateOutbound(msg('call'))).not.toThrow();
    expect(() => validateOutbound(msg('rob'))).not.toThrow();
    expect(() => validateOutbound(msg('grab'))).toThrow(/bidPhase\.kind must be 'call' or 'rob'/);
    expect(() => validateOutbound(msg(undefined))).toThrow(/bidPhase\.kind/);
  });

  it('协议⑦：decisions 的形状、键存在性与长度上界', () => {
    const withDecisions = (decisions: unknown) => ({
      type: 'game.state_update' as const,
      version: 3,
      payload: { ...view(), bidPhase: { ...view().bidPhase, decisions } },
    });
    const okOne = { seat: 0, kind: 'call', grab: true };
    expect(() => validateOutbound(withDecisions([okOne]))).not.toThrow();
    expect(() => validateOutbound(withDecisions([]))).not.toThrow();

    // 长度上界：一轮制（3 名玩家各决策一次）+ 一次反抢（片① R2）⇒ 最多 4 条
    const fourDecisions = [okOne, { seat: 1, kind: 'rob', grab: false }, { seat: 2, kind: 'rob', grab: true }, okOne];
    expect(() => validateOutbound(withDecisions(fourDecisions))).not.toThrow();
    expect(() => validateOutbound(withDecisions([...fourDecisions, okOne]))).toThrow(/at most 4 items/);

    // 键存在性：缺 seat 必须被拒（现全校验器从不检查键存在性）
    expect(() => validateOutbound(withDecisions([{ kind: 'call', grab: true }]))).toThrow(/must have a "seat" key/);
    // 座位必须是 0..2 的**整数**（`assertNum` 会放过 -1/99/1.5）
    expect(() => validateOutbound(withDecisions([{ seat: 9, kind: 'call', grab: true }]))).toThrow(/integer in 0\.\.2/);
    expect(() => validateOutbound(withDecisions([{ seat: 1.5, kind: 'call', grab: true }]))).toThrow(/integer in 0\.\.2/);
    // grab 必须是布尔
    expect(() => validateOutbound(withDecisions([{ seat: 0, kind: 'call', grab: 1 }]))).toThrow(/grab must be a boolean/);
  });

  it('bidPhase.decisions 允许 4 条（片① R2 的反抢）、拒绝 5 条', () => {
    const mk = (n: number) => ({
      type: 'game.state_update' as const,
      version: 3,
      payload: {
        ...view(),
        bidPhase: {
          ...view().bidPhase,
          decisions: Array.from({ length: n }, (_, i) => ({ seat: i % 3, kind: 'rob' as const, grab: true })),
        },
      },
    });
    expect(() => validateOutbound(mk(4))).not.toThrow();
    expect(() => validateOutbound(mk(5))).toThrow(/at most 4 items/);
  });

  it('协议④：recentActions 的形状、键存在性与窗口上界', () => {
    const withRecent = (recentActions: unknown) => ({
      type: 'game.state_update' as const,
      version: 3,
      payload: { ...view(), recentActions },
    });
    const played = { seat: 0, cards: [c(3)] };
    expect(() => validateOutbound(withRecent([]))).not.toThrow();
    expect(() => validateOutbound(withRecent([played]))).not.toThrow();
    // 「不出」是显式的 null（**不是**缺省值 / 空数组）
    expect(() => validateOutbound(withRecent([{ seat: 1, cards: null }]))).not.toThrow();

    // 窗口上界：最多 2 条
    expect(() =>
      validateOutbound(withRecent([played, played, played])),
    ).toThrow(/at most 2 items/);

    // 键存在性：缺 cards 必须被拒 —— 否则「cards: null」与「cards 缺失」在窄化后不可区分
    expect(() => validateOutbound(withRecent([{ seat: 0 }]))).toThrow(/must have a "cards" key/);
    expect(() => validateOutbound(withRecent([{ cards: null }]))).toThrow(/must have a "seat" key/);
    // 座位必须是 0..2 的**整数**（`assertNum` 会放过 -1/99/1.5）
    expect(() => validateOutbound(withRecent([{ seat: 9, cards: null }]))).toThrow(/integer in 0\.\.2/);
    // 空数组不是「不出」：空手出牌不存在（✋ 不得把 null 塞进 assertCardArray）
    expect(() => validateOutbound(withRecent([{ seat: 0, cards: [] }]))).toThrow(/must not be empty/);
    // 牌值仍然要合法
    expect(() => validateOutbound(withRecent([{ seat: 0, cards: [c(16)] }]))).toThrow(/not a valid DouZero card/);
  });

  it('C23：trustees 恰三元且全 boolean（坏形状响亮）', () => {
    const withTrustees = (trustees: unknown) => ({
      type: 'game.state_update' as const,
      version: 3,
      payload: { ...view(), trustees },
    });
    expect(() => validateOutbound(withTrustees([false, true, false]))).not.toThrow();
    // 非三元（含缺失/非数组）：与 cardCounts 同款「3-tuple」断言形态
    expect(() => validateOutbound(withTrustees([false, false]))).toThrow(/3-tuple/);
    expect(() => validateOutbound(withTrustees([false, false, false, true]))).toThrow(/3-tuple/);
    expect(() => validateOutbound(withTrustees(undefined))).toThrow(/3-tuple/);
    expect(() => validateOutbound(withTrustees(null))).toThrow(/3-tuple/);
    // 元素必须严格 boolean（字符串 'false' 也拒）
    expect(() => validateOutbound(withTrustees([0, false, false]))).toThrow(/trustees\[0\] must be a boolean/);
    expect(() => validateOutbound(withTrustees([false, false, 'false']))).toThrow(
      /trustees\[2\] must be a boolean/,
    );
  });
});

describe('game.balances（② 金币场 ⚙️2：恰 3 条、座位升序）', () => {
  const ok = {
    type: 'game.balances' as const,
    version: 7,
    payload: { balances: [{ seat: 0, balance: 12_345 }, { seat: 1, balance: 8_001 }, { seat: 2, balance: 1 }] },
  };

  it('接受合法形状（恰 3 条、座位升序）', () => {
    expect(() => validateOutbound(ok)).not.toThrow();
  });

  it('真实线格式（body 无 type，type 来自事件名）⇒ validateInbound 接受', () => {
    expect(() => validateInbound('game.balances', { version: 7, payload: ok.payload })).not.toThrow();
  });

  it('拒非 3 条 / 座位乱序或重复 / 座位越界 / balance 非有限数', () => {
    const cases: Array<[string, unknown]> = [
      ['2 条', { balances: [{ seat: 0, balance: 1 }, { seat: 1, balance: 2 }] }],
      ['4 条', { balances: [...ok.payload.balances, { seat: 0, balance: 4 }] }],
      ['乱序', { balances: [{ seat: 1, balance: 1 }, { seat: 0, balance: 2 }, { seat: 2, balance: 3 }] }],
      ['重复座位', { balances: [{ seat: 0, balance: 1 }, { seat: 0, balance: 2 }, { seat: 2, balance: 3 }] }],
      ['座位越界', { balances: [{ seat: 0, balance: 1 }, { seat: 1, balance: 2 }, { seat: 3, balance: 3 }] }],
      ['balance 缺失', { balances: [{ seat: 0 }, { seat: 1, balance: 2 }, { seat: 2, balance: 3 }] }],
      ['balance 非数', { balances: [{ seat: 0, balance: '1' }, { seat: 1, balance: 2 }, { seat: 2, balance: 3 }] }],
    ];
    for (const [name, payload] of cases) {
      expect(() => validateOutbound({ ...ok, payload }), name).toThrow(ProtocolError);
    }
  });
});

describe('leak guard (docs/design.md §4.2)', () => {
  it('rejects a top-level forbidden key', () => {
    expect(() => assertNoLeak({ type: 'game.deal', isRobot: true })).toThrow(/forbidden field "isRobot"/);
  });

  it('rejects a nested forbidden key inside a player list', () => {
    const leaked = {
      type: 'room.state_update',
      version: 1,
      payload: { status: 'playing', players: [{ id: 'p_1', seat: 0, botId: 'bot-internal-1' }] },
    };
    expect(() => validateOutbound(leaked)).toThrow(/forbidden field "botId"/);
  });

  it('rejects an actionLog anywhere in the tree', () => {
    const leaked = { type: 'game.state_update', version: 2, payload: { ...view(), actionLog: [] } };
    expect(() => validateOutbound(leaked)).toThrow(/forbidden field "actionLog"/);
  });

  it('rejects skillLevel', () => {
    expect(() => assertNoLeak({ a: { b: [{ skillLevel: 'advanced' }] } })).toThrow(/forbidden field "skillLevel"/);
  });

  /**
   * 风控 C14（规格 §2.1-2，K3）：`deviceId` 服务器可见、**玩家面永不出站** ——
   * 与 `isRobot`/`botId` 同一道机械防线（含深层嵌套）。
   */
  it('rejects deviceId anywhere in the tree（K3：服务器可见；玩家面永不出站）', () => {
    const leaked = {
      type: 'room.state_update',
      version: 1,
      payload: { status: 'playing', players: [{ id: 'p_1', seat: 0, deviceId: 'dev-0001' }] },
    };
    expect(() => validateOutbound(leaked)).toThrow(/forbidden field "deviceId"/);
  });

  it('allows a clean PlayerView', () => {
    expect(() => assertNoLeak({ type: 'game.deal', version: 1, payload: view() })).not.toThrow();
  });
});

describe('RoomPlayer.nickname（昵称片）', () => {
  it('nickname 是可选字段：缺省合法、字符串合法、非字符串拒绝', () => {
    const base = {
      type: 'room.state_update' as const,
      version: 0,
      payload: { status: 'waiting', players: [{ id: 'p1', seat: 0 }] },
    };
    expect(() => validateOutbound(base)).not.toThrow();
    expect(() =>
      validateOutbound({
        ...base,
        payload: { status: 'waiting', players: [{ id: 'p1', seat: 0, nickname: '阿豆' }] },
      }),
    ).not.toThrow();
    expect(() =>
      validateOutbound({
        ...base,
        payload: { status: 'waiting', players: [{ id: 'p1', seat: 0, nickname: 42 }] },
      }),
    ).toThrow(/nickname/);
  });
});

describe('user.nicknames.get（昵称片 RPC）', () => {
  it('pattern 名逐字', () => {
    expect(RPC_PATTERNS.userNicknamesGet).toBe('user.nicknames.get');
  });
});

describe('validateClientMessage（线格式扁平：type 由事件名承载）', () => {
  const wire = (payload: unknown, baseVersion = 0) => ({
    reqId: 'r-1',
    baseVersion,
    timestamp: Date.now(),
    payload,
  });

  it('accepts game.play with cards', () => {
    expect(() => validateClientMessage('game.play', wire({ cards: [c(3, 0), c(3, 1)] }, 7))).not.toThrow();
  });

  it('assembles the logical shape from the flat wire body', () => {
    const msg = validateClientMessage('game.bid', wire({ grab: true }, 5));
    expect(msg.type).toBe('game.bid');
    expect(msg.meta.baseVersion).toBe(5);
    expect(msg.payload).toEqual({ grab: true });
  });

  it('accepts game.resync —— 13004 的恢复通道', () => {
    expect(() => validateClientMessage('game.resync', wire({}))).not.toThrow();
  });

  it('rejects game.play with an empty card list (must use game.pass)', () => {
    expect(() => validateClientMessage('game.play', wire({ cards: [] }))).toThrow(/use game.pass/);
  });

  it('rejects a flat body missing the meta fields', () => {
    expect(() => validateClientMessage('game.pass', { payload: {} })).toThrow(/reqId/);
  });

  it('rejects an unknown event name', () => {
    expect(() => validateClientMessage('game.card_played', wire({}))).toThrow(/unknown C→S message type/);
  });

  it('rejects room.match with an unknown mode', () => {
    expect(() => validateClientMessage('room.match', wire({ mode: 'ranked', baseScore: 15 }))).toThrow(/mode/);
  });

  it('accepts room.match with a valid mode（三值：random / practice / gold）', () => {
    for (const mode of ['random', 'practice', 'gold'] as const) {
      expect(
        () => validateClientMessage('room.match', wire({ mode, baseScore: 15 })),
        mode,
      ).not.toThrow();
    }
  });

  /**
   * 片规格 §2.4 协议②（§2.5「非法 `baseScore` 被拒 —— `room.match` 这条也要测」）：
   * `baseScore` **必填**。缺了它撮合键那一维就会是 `undefined`（两种 key）⇒ 当场拒绝。
   */
  it('rejects room.match without baseScore（协议② 必填）', () => {
    expect(() => validateClientMessage('room.match', wire({ mode: 'random' }))).toThrow(/baseScore/);
  });

  it('rejects room.match with a non-numeric baseScore', () => {
    expect(() =>
      validateClientMessage('room.match', wire({ mode: 'random', baseScore: '15' })),
    ).toThrow(/baseScore/);
  });

  /**
   * 风控 C13（规格 §2.1-1）：`deviceId` 缺省 ⇒ 过（上面全部既有用例即正对照）；
   * 存在 ⇒ string、长度 8..64、charset `[A-Za-z0-9._-]`，否则 `ProtocolError`。
   */
  it('accepts room.match deviceId：36 位 UUID 与 8 位最短例（client 生成形态）', () => {
    expect(() =>
      validateClientMessage(
        'room.match',
        wire({ mode: 'random', baseScore: 15, deviceId: '123e4567-e89b-12d3-a456-426614174000' }),
      ),
    ).not.toThrow();
    expect(() =>
      validateClientMessage('room.match', wire({ mode: 'practice', baseScore: 15, deviceId: 'dev-0001' })),
    ).not.toThrow();
  });

  it('rejects room.match deviceId：7 位 / 65 位 / 含空格 / 含中文 / 非 string（C13）', () => {
    const cases: Array<[string, unknown]> = [
      ['7 位（太短）', '1234567'],
      ['65 位（太长）', 'a'.repeat(65)],
      ['含空格', 'dev 0001'],
      ['含中文', '设备-0001'],
      ['非 string', 12345678],
    ];
    for (const [name, deviceId] of cases) {
      expect(
        () => validateClientMessage('room.match', wire({ mode: 'random', baseScore: 15, deviceId })),
        name,
      ).toThrow(/deviceId/);
    }
  });

  it('accepts room.match.extend with an empty payload（机器人补位开关片：延长匹配）', () => {
    expect(() => validateClientMessage('room.match.extend', wire({}))).not.toThrow();
  });

  /**
   * 挂机治理片：`game.trustee { on: boolean }` 托管开关（manual via）。
   * C24 的载荷校验半边 + C20b 的校验半边（room-service 本地校验 ⇒ 10001 的来源）。
   */
  it('accepts game.trustee with a strict boolean on', () => {
    for (const on of [true, false]) {
      expect(() => validateClientMessage('game.trustee', wire({ on })), String(on)).not.toThrow();
    }
  });

  it('assembles game.trustee into the logical shape（type / meta / payload）', () => {
    const msg = validateClientMessage('game.trustee', wire({ on: true }, 0));
    expect(msg.type).toBe('game.trustee');
    expect(msg.meta.baseVersion).toBe(0);
    expect(msg.payload).toEqual({ on: true });
  });

  it("rejects game.trustee with a non-strict boolean on（字符串 'false' 也拒）", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["字符串 'false'", { on: 'false' }],
      ["字符串 'true'", { on: 'true' }],
      ['数字 0', { on: 0 }],
      ['数字 1', { on: 1 }],
      ['null', { on: null }],
      ['缺 on', {}],
    ];
    for (const [name, payload] of cases) {
      expect(() => validateClientMessage('game.trustee', wire(payload)), name).toThrow(ProtocolError);
      expect(() => validateClientMessage('game.trustee', wire(payload)), name).toThrow(
        /on must be a boolean/,
      );
    }
  });
});
