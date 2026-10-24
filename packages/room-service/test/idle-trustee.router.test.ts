/**
 * 挂机治理 T6（规格 C19–C22）：room-service 的 `game.trustee` 通道。
 *
 * 覆盖：
 *  - **C19 四处 via 映射钉死**：客户端 `game.trustee` ⇒ `'manual'`；在局 `room.leave` ⇒ `'abandon'`；
 *    reconnect 与在局 `room.join` ⇒ `'reconnect'`（错映射即红）；
 *  - **C20**：12001/12004/13005 经 C→S 面**不塌缩**成 10007；
 *  - **C20b**：坏载荷（`on` 非严格 boolean）⇒ ack **10001** 且**零 RPC 调用**（本地校验产生）；
 *  - **C21 弃局五步序**：awaited 解析（清记录之前）→ 仅 playing 且（consistent 或 target==payload）
 *    才 **fire-and-forget** 转发（via `'abandon'`）→ 清记录 → ok；失败只 warn；waiting 房 leave 零转发；
 *  - **C22 回桌**：reconnect / 在局 `room.join` 两条 ⇒ trustee-off（via `'reconnect'`），**先清后 ack**
 *    （清除成功时 ack 快照不带 trustee=true；就地改写 `trustees[idx]=false`），**fail-open**。
 *
 * 判据纪律：既断言「调了谁、带了什么」（mock 调用），也断言**可观测的真结果**
 *（ack 码 / ack 快照 / 假 redis 键值）—— 只断言调用会在「调了但语义反了」时全绿。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ErrCode, type PlayerView } from '@fight-the-landlord/protocol';
import { GameServiceError } from '../src/gateway/game.client';
import { RECONNECT_HASH_KEY } from '../src/reconnect/reconnect.service';
import type { RecoverableRoom } from '../src/reconnect/reconnect.service';
import { C, makeDeps, makeRedis, makeSocket, route } from './helpers/router-deps';

afterEach(() => {
  Logger.overrideLogger(new Logger());
});

/** `resolveRecoverableRoom` 的命中结果（与 `message.router.test.ts` 的 `hit` 同形）。 */
const hit = (
  roomCode = 'ROOM1',
  source: 'ticket' | 'record' = 'record',
  status = 'playing',
): RecoverableRoom => ({ roomCode, source, status });

/** 一条 playing 状态的 `PlayerView`（只需要 C22 相关字段，其余按真实类型补齐）。 */
const view = (over: Partial<PlayerView> = {}): PlayerView => ({
  roomCode: 'ROOM1',
  version: 5,
  state: 'playing',
  baseScore: 15,
  seat: 0,
  hand: [],
  cardCounts: [1, 2, 3],
  trustees: [false, false, false],
  bottomCards: null,
  landlordSeat: null,
  currentPlayer: 0,
  recentActions: [],
  turnDeadlineAt: Date.now() + 30_000,
  bidPhase: { currentBidder: 0, bidMultiplier: 1, landlordCandidate: -1, grabActions: 0, redealCount: 0, kind: 'call', decisions: [] },
  playPhase: { bombCount: 0 },
  ...over,
});

/** 写一条指向 `roomCode` 的真实重连记录（假 redis 的 `RECONNECT_HASH_KEY` 字段）。 */
const putRecord = (redis: ReturnType<typeof makeRedis>, roomCode: string, userId = 'alice') =>
  redis.hset(
    RECONNECT_HASH_KEY,
    userId,
    JSON.stringify({ socketId: 'sock-1', roomCode, connectedAt: Date.now() }),
  );

const playingRoom = (code = 'ROOM1') => ({
  code,
  mode: 'random',
  players: [{ userId: 'alice', seat: 0 }],
  maxPlayers: 3,
  status: 'playing' as const,
  baseScore: 100,
  createdAt: Date.now(),
});

const waitingRoom = (code = 'ROOM1') => ({
  ...playingRoom(code),
  status: 'waiting' as const,
});

describe('C19 · 四处 via 映射钉死', () => {
  beforeEach(() => vi.clearAllMocks());

  it("客户端 case `game.trustee{on:true}` ⇒ via 'manual'（on 原样转发）", async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('game.trustee', { on: true }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledTimes(1);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', true, 'manual');
    // ack 带回下游的 `{version}`（信封解包）
    expect(ack.data).toEqual({ version: 2 });
  });

  it("客户端 case `game.trustee{on:false}` ⇒ 仍是 via 'manual'（解除也是手动）", async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('game.trustee', { on: false }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', false, 'manual');
  });

  it("在局 `room.leave` ⇒ via 'abandon'、on=true", async () => {
    const { deps, game, redis, reconnect } = makeDeps();
    await putRecord(redis, 'ROOM1');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', true, 'abandon');
  });

  it("`game.reconnect` ⇒ via 'reconnect'、on=false", async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue(view());

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', false, 'reconnect');
  });

  it("在局 `room.join` ⇒ via 'reconnect'、on=false", async () => {
    const { deps, game, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue(playingRoom());

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', false, 'reconnect');
  });

  it("负对照：waiting 房 `room.join` 零转发（不在局无治理量）", async () => {
    const { deps, game, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue(waitingRoom());

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).not.toHaveBeenCalled();
  });
});

describe('C20 · 错误码透传（12001/12004/13005 不塌缩成 10007）', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [ErrCode.ROOM_NOT_FOUND, '房间不存在'],
    [ErrCode.NOT_IN_ROOM, '不在该房'],
    [ErrCode.GAME_OVER, '对局已结束'],
  ] as const)('下游 %i 经 C→S 面原样回给客户端（不是 10007）', async (code, message) => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.trustee.mockRejectedValue(new GameServiceError(code, message));

    const ack = await route(deps, makeSocket('alice'), C('game.trustee', { on: true }));

    expect(ack.code).toBe(code);
    expect(ack.code).not.toBe(ErrCode.UPSTREAM_UNAVAILABLE);
    expect(ack.message).toBe(message); // 业务文案逐字（客户端要展示）
  });

  it('负对照：传输层故障仍是 10007（透传面不放宽）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.trustee.mockRejectedValue(new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, '服务暂不可用'));

    const ack = await route(deps, makeSocket('alice'), C('game.trustee', { on: true }));

    expect(ack.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE);
  });
});

describe('C20b · 坏载荷 ⇒ 10001 且零 RPC 调用', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['字符串 on', { on: 'false' }],
    ['数字 on', { on: 1 }],
    ['缺 on', {}],
    ['null on', { on: null }],
  ])('%s ⇒ 本地 validateClientMessage 产生 10001，game.trustee 零调用', async (_label, payload) => {
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const { deps, game } = makeDeps({ logger: logger as unknown as Logger });

    const ack = await route(deps, makeSocket('alice'), C('game.trustee', payload));

    expect(ack.code).toBe(ErrCode.BAD_PARAM);
    expect(game.trustee).not.toHaveBeenCalled();
    // 校验在 dispatch **之前**失败 ⇒ 连 resolver 都不该被问（零副作用）
    expect(deps.reconnect.resolveRecoverableRoom).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Rejected malformed client message'));
  });
});

describe('C21 · 弃局五步序（room.leave ⇒ abandon 转发）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('awaited 解析在清记录之前；转发在清记录之前发起；则清记录 ⇒ ok', async () => {
    const { deps, redis, reconnect, game } = makeDeps();
    await putRecord(redis, 'ROOM1');
    const order: string[] = [];

    reconnect.resolveRecoverableRoom.mockImplementation(async () => {
      // 解析那一刻**记录必须还在**（先清后解析会让 resolver 候选源消失 —— R5 的钉死点）
      expect(await redis.hget(RECONNECT_HASH_KEY, 'alice')).not.toBeNull();
      order.push('resolve');
      return hit('ROOM1');
    });
    game.trustee.mockImplementation(async () => {
      order.push('trustee');
      return { version: 3 };
    });
    reconnect.clearConnection.mockImplementation(async (playerId: string) => {
      order.push('clear');
      await redis.hdel(RECONNECT_HASH_KEY, playerId);
    });

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(order).toEqual(['resolve', 'trustee', 'clear']);
    expect(await redis.hget(RECONNECT_HASH_KEY, 'alice')).toBeNull(); // ③ 清记录真的发生
  });

  it('**fire-and-forget**：转发永不回包也不阻塞 ack（awaited 会把 ack 拖到 2s）', async () => {
    const { deps, redis, reconnect, game } = makeDeps();
    await putRecord(redis, 'ROOM1');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.trustee.mockReturnValue(new Promise(() => {})); // 永不 settle

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0); // 若实现是 await，这里会挂到用例超时
    expect(game.trustee).toHaveBeenCalledTimes(1);
  });

  it('负对照：waiting 房 leave **零转发**（不得产生注定 13009 的噪音 RPC）', async () => {
    const { deps, game, redis, reconnect } = makeDeps();
    await putRecord(redis, 'ROOM1');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1', 'record', 'waiting'));

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).not.toHaveBeenCalled();
  });

  it('负对照：无任何可恢复凭据（resolved=null）⇒ 零转发、leave 仍 ok', async () => {
    const { deps, game } = makeDeps(); // 缺省 resolve = null

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).not.toHaveBeenCalled();
  });

  it('`target == payload roomCode` 支：凭据不一致（记录指向别房）但解析目标恰是本房 ⇒ 仍转发', async () => {
    const { deps, game, redis, reconnect } = makeDeps();
    await putRecord(redis, 'ROOM2'); // 记录指向 ROOM2 ⇒ consistent=false
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1')); // 但存活候选是本房

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', true, 'abandon');
  });

  it('错房号 leave 不得置**错房**：解析目标 ≠ 请求房号且凭据不一致 ⇒ 零转发、记录原样保留', async () => {
    const { deps, game, redis, reconnect } = makeDeps();
    await putRecord(redis, 'ROOM2');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM2')); // 目标房是 ROOM2

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).not.toHaveBeenCalled();
    expect(await redis.hget(RECONNECT_HASH_KEY, 'alice'), '不一致 ⇒ 记录必须原样保留').not.toBeNull();
  });

  it('转发失败只 warn（fail-open）：ack 仍 ok，且警告落在日志里', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const { deps, game, redis, reconnect } = makeDeps({ logger: logger as unknown as Logger });
    await putRecord(redis, 'ROOM1');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.trustee.mockRejectedValue(new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down'));

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Trustee-on (abandon) failed')),
    );
  });
});

describe('C22 · 回桌解除托管（先清后 ack / fail-open）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reconnect：清除成功后 ack 快照**就地改写** trustees[自己座位]=false（且 onReconnected 收到同一视图）', async () => {
    const { deps, game, reconnect, reconnected } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue(view({ seat: 1, trustees: [false, true, false] }));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledWith('ROOM1', 'alice', false, 'reconnect');
    expect((ack.data as PlayerView).trustees).toEqual([false, false, false]);
    // 投递链路恢复也拿改写后的视图（它只读 roomCode/seat，但保持单一真源）
    expect((reconnected[0]!.view as PlayerView).trustees).toEqual([false, false, false]);
  });

  it('reconnect fail-open：清除失败 ⇒ ack 仍 ok + **旧视图**（设计 §六 显式接受格①）', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const { deps, game, reconnect } = makeDeps({ logger: logger as unknown as Logger });
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue(view({ seat: 1, trustees: [false, true, false] }));
    game.trustee.mockRejectedValue(new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down'));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect((ack.data as PlayerView).trustees).toEqual([false, true, false]); // 失败不伪造已清
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Trustee-off (reconnect) failed'),
    );
  });

  it('reconnect 到 ended 局 ⇒ 13005 且**零转发**（结束局无治理量）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue(view({ state: 'ended' }));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(ErrCode.GAME_OVER);
    expect(game.trustee).not.toHaveBeenCalled();
  });

  it('reconnect 到 init 局（未开始）⇒ 照常回快照、零转发（注定 13009 的噪音 RPC 不发）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue(view({ state: 'init' }));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(game.trustee).not.toHaveBeenCalled();
  });

  it('在局 room.join fail-open：清除失败不阻断入座（ack 仍 ok）', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
    const { deps, game, rooms } = makeDeps({ logger: logger as unknown as Logger });
    rooms.findOne.mockResolvedValue(playingRoom());
    game.trustee.mockRejectedValue(new GameServiceError(ErrCode.UPSTREAM_UNAVAILABLE, 'down'));

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(game.trustee).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Trustee-off (reconnect) failed'),
    );
  });

  it('先清后 ack：room.join 的 ack 返回时 trustee 清除必须已经**完成**（不是排队中）', async () => {
    const { deps, game, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue(playingRoom());
    let cleared = false;
    game.trustee.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleared = true;
      return { version: 2 };
    });

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(cleared).toBe(true);
  });
});
