/**
 * R1104/R1105：`RpcMeta` 与 7 个 RPC 请求类型的**可选** `meta` 字段。
 *
 * ⚠️ 本文件两条判据的**真正判别力在类型层**：`packages/protocol` 的 lint（`tsc --noEmit`）
 * 会把本文件一起编译 —— 若某个请求类型的 `meta` 被改成**必填**（或漏加），
 * 下面「不传 meta / 传 meta」的夹具必有一半编译不过。vitest 在运行时只钉「省略语义」
 * 的物证：没传 `meta` 的载荷里**没有** `meta` 键（`'meta' in req === false`）。
 */
import { describe, expect, it } from 'vitest';
import {
  validateRecordMoneyDelta,
  type GameActionRequest,
  type GameSnapshotRequest,
  type GameViewRequest,
  type RecordWriteRequest,
  type RpcMeta,
  type StartGameRequest,
} from './rpc';
import type { RobotAcquireRequest, RobotDecideRequest, RobotReleaseRequest } from './robot';
import type { Card, PlayerView } from './views';
import { ProtocolError } from './validate';

/** R696 之后牌是 `{r, s}`，夹具用这个构造。默认黑桃（`s = 0`）。 */
const c = (r: number, s = 0): Card => ({ r, s });

/** `RobotDecideRequest` 的裁剪视图底座（与 `robot.test.ts` 的夹具同源）。 */
function view(): PlayerView {
  return {
    roomCode: 'ROOM1',
    version: 1,
    state: 'playing',
    baseScore: 15,
    seat: 0,
    hand: [c(3), c(4), c(5)],
    cardCounts: [3, 17, 17],
    trustees: [false, false, false],
    bottomCards: null,
    landlordSeat: null,
    currentPlayer: 0,
    recentActions: [],
    turnDeadlineAt: 0,
    bidPhase: {
      currentBidder: 0,
      bidMultiplier: 1,
      landlordCandidate: -1,
      grabActions: 0,
      redealCount: 0,
      kind: 'call',
      decisions: [],
    },
    playPhase: { bombCount: 0 },
  };
}

/** `RobotDecideRequest.features` 的公开特征底座（只含已打出信息）。 */
function features(): RobotDecideRequest['features'] {
  return {
    position: 'landlord',
    lastMove: [],
    lastMovePosition: '',
    // 协议 ④：首出（尚无上一手牌）
    lastMoveMeta: null,
    numCardsLeft: { landlord: 20, landlord_down: 17, landlord_up: 17 },
    playedCards: { landlord: [], landlord_down: [], landlord_up: [] },
    actionSeq: [],
  };
}

describe('RpcMeta（R1104/R1105）', () => {
  it('形状：traceId 必填、reqId/userId 可选', () => {
    const meta: RpcMeta = { traceId: 'T' };
    expect(meta.traceId).toBe('T');
    expect('reqId' in meta).toBe(false); // 省略语义：没值就**不出现**
  });

  it('省略语义的**类型层**证明：不传 meta 的请求仍然合法（本文件能被 tsc 编译即证明）', () => {
    // ⚠️ 这条的判别力来自 `packages/protocol` 的 `tsc --noEmit`（lint 阶段）：
    //    若把 `meta` 写成必填，这一行**编译不过** ⇒ lint 红。
    const request: StartGameRequest = { roomCode: 'R', baseScore: 100, players: [] };
    expect(request.roomCode).toBe('R');
    expect('meta' in request).toBe(false);
  });
});

/**
 * 7 个请求类型**逐一**点名（R1104）—— 防止「只加了其中几个」而上面那条判据仍绿。
 * 两半夹具都以 `satisfies` 钉住：漏加 `meta` ⇒ 「传 meta」半编译不过；
 * 改成必填 ⇒ 「不传 meta」半编译不过。运行时只断言省略语义的物证。
 */
describe('7 个请求类型各带一个**可选** `meta`（R1104）', () => {
  it('不传 meta：7 个类型全部合法，且载荷里没有 meta 键', () => {
    const reqs = [
      { roomCode: 'R', baseScore: 100, players: [] } satisfies StartGameRequest,
      { roomCode: 'R' } satisfies GameSnapshotRequest,
      { roomCode: 'R', userId: 'U' } satisfies GameViewRequest,
      { roomCode: 'R', userId: 'U', action: 'pass', payload: {}, baseVersion: 1 } satisfies GameActionRequest,
      { roomCode: 'R', seats: [1] } satisfies RobotAcquireRequest,
      { botIds: ['bot-1'] } satisfies RobotReleaseRequest,
      { roomCode: 'R', botId: 'bot-1', skillLevel: 'beginner', view: view(), features: features() } satisfies RobotDecideRequest,
    ];
    for (const req of reqs) {
      expect('meta' in req).toBe(false);
    }
  });

  it('传 meta：7 个类型全部接收（漏加字段/改成必填都会让 tsc 红）', () => {
    const meta: RpcMeta = { traceId: 'T', reqId: 'Q', userId: 'U' };
    const reqs = [
      { roomCode: 'R', baseScore: 100, players: [], meta } satisfies StartGameRequest,
      { roomCode: 'R', meta } satisfies GameSnapshotRequest,
      { roomCode: 'R', userId: 'U', meta } satisfies GameViewRequest,
      { roomCode: 'R', userId: 'U', action: 'pass', payload: {}, baseVersion: 1, meta } satisfies GameActionRequest,
      { roomCode: 'R', seats: [1], meta } satisfies RobotAcquireRequest,
      { botIds: ['bot-1'], meta } satisfies RobotReleaseRequest,
      { roomCode: 'R', botId: 'bot-1', skillLevel: 'beginner', view: view(), features: features(), meta } satisfies RobotDecideRequest,
    ];
    for (const req of reqs) {
      expect(req.meta).toBe(meta);
    }
  });
});

describe('金币场 RPC 契约（② §2.1 / §3）', () => {
  it("RecordWriteRequest.mode 三值：'gold' 在类型面可构造（判别力来自 protocol 的 tsc --noEmit）", () => {
    const mode: RecordWriteRequest['mode'] = 'gold';
    expect(mode).toBe('gold');
  });

  it('RecordWriteRequest.seats[].nickname：机器人座可带快照、人类座可为 null（判别力来自 tsc --noEmit）', () => {
    const req = {
      roomCode: 'R',
      gameVersion: 1,
      mode: 'random',
      baseScore: 15,
      result: {
        roomCode: 'R',
        baseScore: 15,
        winner: 'landlord',
        landlordSeat: 0,
        farmerSeats: [1, 2],
        multiplier: 1,
        spring: 'none',
        landlordScoreChange: 2,
        farmerScoreChange: -1,
      },
      seats: [
        { seat: 0, userId: 'u1', isRobot: false, robotId: null, hand: '0'.repeat(34), nickname: null },
        { seat: 1, userId: null, isRobot: true, robotId: 'bot-1', hand: '0'.repeat(34), nickname: '阿豆' },
        { seat: 2, userId: null, isRobot: true, robotId: 'bot-2', hand: '0'.repeat(34) },
      ],
      bottomCards: '0'.repeat(6),
      startedAt: 0,
      endedAt: 0,
    } satisfies RecordWriteRequest;
    expect(req.seats[1]!.nickname).toBe('阿豆');
    expect(req.seats[0]!.nickname).toBeNull();
  });

  it('validateRecordMoneyDelta 合法面：恰 3 条、座位 0,1,2 升序、delta 整数含 0（±2^31−1 边界）+ meta', () => {
    const ok = {
      roomCode: 'ABC123',
      gameVersion: 3,
      deltas: [
        { seat: 0, delta: 100 },
        { seat: 1, delta: -100 },
        { seat: 2, delta: 0 },
      ],
    };
    expect(() => validateRecordMoneyDelta(ok)).not.toThrow();
    expect(() =>
      validateRecordMoneyDelta({
        ...ok,
        deltas: [
          { seat: 0, delta: 2_147_483_647 },
          { seat: 1, delta: -2_147_483_647 },
          { seat: 2, delta: 0 },
        ],
        meta: { traceId: 't-1' },
      }),
    ).not.toThrow();
  });

  it('validateRecordMoneyDelta 校验矩阵：每条非法输入 ⇒ ProtocolError 且中文原因', () => {
    const ok = {
      roomCode: 'ABC123',
      gameVersion: 3,
      deltas: [
        { seat: 0, delta: 100 },
        { seat: 1, delta: -100 },
        { seat: 2, delta: 0 },
      ],
    };
    const withDeltas = (deltas: unknown) => ({ ...ok, deltas });
    const cases: Array<[string, unknown]> = [
      ['请求非对象', null],
      ['请求是数组', []],
      ['roomCode 缺失', { ...ok, roomCode: undefined }],
      ['roomCode 空串', { ...ok, roomCode: '' }],
      ['roomCode 超 16', { ...ok, roomCode: 'a'.repeat(17) }],
      ['roomCode 非字符串', { ...ok, roomCode: 123 }],
      ['gameVersion = 0', { ...ok, gameVersion: 0 }],
      ['gameVersion 非整数', { ...ok, gameVersion: 1.5 }],
      ['gameVersion 字符串', { ...ok, gameVersion: '3' }],
      ['deltas 非数组', withDeltas('x')],
      ['deltas 2 条', withDeltas(ok.deltas.slice(0, 2))],
      ['deltas 4 条', withDeltas([...ok.deltas, { seat: 0, delta: 1 }])],
      ['座位乱序', withDeltas([{ seat: 1, delta: 1 }, { seat: 0, delta: 2 }, { seat: 2, delta: 3 }])],
      ['座位重复', withDeltas([{ seat: 0, delta: 1 }, { seat: 0, delta: 2 }, { seat: 2, delta: 3 }])],
      ['座位越界', withDeltas([{ seat: 0, delta: 1 }, { seat: 1, delta: 2 }, { seat: 3, delta: 3 }])],
      ['座位缺失', withDeltas([{ delta: 1 }, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
      ['entry 非对象', withDeltas([1, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
      ['delta 非整数', withDeltas([{ seat: 0, delta: 1.5 }, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
      ['delta 非数', withDeltas([{ seat: 0, delta: '1' }, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
      ['delta > 2^31−1', withDeltas([{ seat: 0, delta: 2_147_483_648 }, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
      ['delta < −2^31−1', withDeltas([{ seat: 0, delta: -2_147_483_648 }, { seat: 1, delta: 2 }, { seat: 2, delta: 3 }])],
    ];
    for (const [name, req] of cases) {
      expect(() => validateRecordMoneyDelta(req), name).toThrow(ProtocolError);
      expect(() => validateRecordMoneyDelta(req), name).toThrow(/[一-鿿]/);
    }
  });

  it('validateRecordMoneyDelta 多玩法（Task 2.5）：长度 = playerCount（2/3/4）；非法玩法/人数 ⇒ ProtocolError', () => {
    const pdkDeltas = (n: number) =>
      Array.from({ length: n }, (_, seat) => ({ seat, delta: seat === 0 ? 15 * (n - 1) : -15 }));
    expect(() =>
      validateRecordMoneyDelta({
        roomCode: 'ABC123',
        gameVersion: 3,
        gameType: 'paodekuai',
        playerCount: 2,
        deltas: pdkDeltas(2),
      }),
    ).not.toThrow();
    expect(() =>
      validateRecordMoneyDelta({
        roomCode: 'ABC123',
        gameVersion: 3,
        gameType: 'paodekuai',
        playerCount: 4,
        deltas: pdkDeltas(4),
      }),
    ).not.toThrow();
    // 旧请求（无两字段）仍是斗地主/3 —— 兼容语义不变
    expect(() =>
      validateRecordMoneyDelta({ roomCode: 'ABC123', gameVersion: 3, deltas: pdkDeltas(3) }),
    ).not.toThrow();

    const cases: Array<[string, unknown]> = [
      [
        'pdk 2 人却给 3 条',
        { roomCode: 'ABC123', gameVersion: 3, gameType: 'paodekuai', playerCount: 2, deltas: pdkDeltas(3) },
      ],
      [
        'pdk 5 人（不在 supportedPlayerCounts）',
        { roomCode: 'ABC123', gameVersion: 3, gameType: 'paodekuai', playerCount: 5, deltas: pdkDeltas(5) },
      ],
      [
        'ddz 2 人（斗地主只支持 3）',
        { roomCode: 'ABC123', gameVersion: 3, gameType: 'doudizhu', playerCount: 2, deltas: pdkDeltas(2) },
      ],
      [
        '非法 gameType',
        { roomCode: 'ABC123', gameVersion: 3, gameType: 'ddz', playerCount: 3, deltas: pdkDeltas(3) },
      ],
      [
        'gameType 空串',
        { roomCode: 'ABC123', gameVersion: 3, gameType: '', deltas: pdkDeltas(3) },
      ],
      [
        'playerCount 非整数',
        { roomCode: 'ABC123', gameVersion: 3, playerCount: 3.5, deltas: pdkDeltas(3) },
      ],
    ];
    for (const [name, req] of cases) {
      expect(() => validateRecordMoneyDelta(req), name).toThrow(ProtocolError);
    }
  });
});
