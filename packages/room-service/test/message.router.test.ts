import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { throwError } from 'rxjs';
import type { Redis } from 'ioredis';
import { REQ_ID_MAX_LENGTH, toOutboundPlayerId } from '../src/gateway/message.router';
import { GameClient, GameServiceError } from '../src/gateway/game.client';
// 片② D5（Task 6）：`MatchService` 多了第 5 个构造参数 `robot: RobotClient` ——
// 本文件只走 `room.match`（入队校验 + 写队列），**不会**触发扫描 ⇒ 门禁永不发问；
// 替身仍用真类 + 会抛的假 proxy（与 :1084 的 `realGame` 同形）。
import { RobotClient } from '../src/gateway/robot.client';
import { TRANSPORT_FAILURE_MESSAGE } from '../src/gateway/transport-failure';
// ⚠️ `ReconnectService` 这里是**值导入**（Task 2）：C6 用例要用**真实** resolver（构造在同一假 redis 上）。
import { RECONNECT_HASH_KEY, ReconnectService } from '../src/reconnect/reconnect.service';
// ⚠️ 这里是**值导入**（不是 `import type`）：Task 3c 修复 1 的判据要用**真实** MatchService
// 走完 `room.match`（见本文件末尾那组用例的理由）。
import { MatchService } from '../src/match/match.service';
import { DomainError } from '../src/http/errors';
// ② 金币场 T4：门槛读边的**真实**客户端（传输故障用例走它的真实 pipeline）。
import { CurrencyClient } from '../src/currency/currency.client';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';
import { ErrCode, type Card } from '@fight-the-landlord/protocol';

/** R696：`game.play` 载荷是 `Card[]`（R697）。本文件只关心透传，故 `s` 取 0。 */
const asCards = (ranks: number[]): Card[] => ranks.map((r) => ({ r, s: 0 }));
import type { RoomsService } from '../src/rooms/rooms.service';
import type { RoomStartService } from '../src/rooms/rooms.start';
import { seat, seatsOf } from './helpers/room-fixture';
import { ccstateKey, nicknamesKey } from '../src/rooms/rooms.seats';
// 挂机治理 T6（C26）：`makeDeps`/`makeSocket`/`makeRedis`/`C`/`route` 抽到共享 helper
//（同一真源供接线闸复用 —— 闸不得依赖私有构造，且 import 测试文件会让其 describe 再注册一遍）。
import { C, makeDeps, makeRedis, makeSocket, route } from './helpers/router-deps';
import { asRedis, createFakeRedis } from './helpers/fake-redis';
import { RoomNicknamesService } from '../src/rooms/room-nicknames.service';

/**
 * C→S 路由的契约测试（§6.2 / §6.3 / §5.2 / §6.4）。
 *
 * 纯函数路由，因此不需要 socket.io 服务器 —— 断言的是协议行为本身。
 */

/**
 * **M4（台账 T6-M1）**：`Logger.overrideLogger` 是**进程级**的 —— 用后不还原的话，
 * 本文件里**后追加**的用例会静默写进一个已经死掉的 sink（既不报错、也看不到自己的
 * 日志行）；排查时表现为「日志明明打了却没有」。
 * 还原成默认形态（一个普通 `Logger` ⇒ Nest 的 `localInstance` 回落到 `ConsoleLogger`）。
 */
afterEach(() => {
  Logger.overrideLogger(new Logger());
});

describe('routeClientMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  /** 一个「alice 在里面」的房间（§3.1 形状），供 join / leave / reconnect 共用。 */
  const roomInfo = (code: string) => ({
    code,
    mode: 'random',
    players: seatsOf('alice'),
    maxPlayers: 3,
    status: 'waiting' as const,
    baseScore: 100,
    createdAt: Date.now(),
  });

  /**
   * Task 2（规格 v1.1 §2.3）：`resolveRecoverableRoom` 替身的命中结果 —— 显式落码，
   * 供全文件（reconnect 四步 / resync / forwardAction 家族）共用。
   */
  const hit = (roomCode = 'ROOM1', source: 'ticket' | 'record' = 'record', status = 'playing') =>
    ({ roomCode, source, status });

  // ─── 身份（§5.2）─────────────────────────────────────────────────

  it('rejects an unauthenticated socket with 10002', async () => {
    const { deps, match } = makeDeps();
    const ack = await route(deps, makeSocket(), C('room.match', { mode: 'random', baseScore: 15 }));
    expect(ack.code).toBe(10002);
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('takes identity only from socket.data.userId, never from the payload', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    // ⚠️ R471 之后这里**不能**再传不符的 `playerId`（那会命中 §5.3⑦ 的 12003）；
    //    载荷里的 `userId` 仍然被完全忽略 —— 那正是本用例要钉的性质。
    await route(deps, makeSocket('alice'), C('game.bid', { grab: true, userId: 'victim' }));

    expect(game.action).toHaveBeenCalledWith('ROOM1', 'bid', 'alice', { grab: true, baseVersion: 0 });
  });

  // ─── §5.3⑦ / R471：`playerId` 只作一致性校验 ─────────────────────

  it('载荷带不符的 playerId ⇒ ack 12003（§5.3⑦ / R471）', async () => {
    const { deps, game, redis } = makeDeps();
    await redis.hset('reconnect:active', 'alice', JSON.stringify({ roomCode: 'ROOM1' }));

    const ack = await route(deps, makeSocket('alice'), C('game.bid', { grab: true, playerId: 'someone-else' }));

    expect(ack.code).toBe(12003);
    // 反面对照：不得把不符的动作继续转发给下游。
    expect(game.action).not.toHaveBeenCalled();
  });

  it('正对照：playerId 与身份一致 ⇒ 放行（不得误伤）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('game.bid', { grab: true, playerId: 'alice' }));

    expect(ack.code).not.toBe(12003);
    expect(game.action).toHaveBeenCalledWith('ROOM1', 'bid', 'alice', { grab: true, baseVersion: 0 });
  });

  it('正对照：完全不传 playerId ⇒ 放行（§5.3⑦ 是「若传了就校验」，不是必填）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('game.bid', { grab: true }));

    expect(ack.code).not.toBe(12003);
    expect(game.action).toHaveBeenCalledWith('ROOM1', 'bid', 'alice', { grab: true, baseVersion: 0 });
  });

  it('rejects a message type outside the contract with 10001', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('game.match.quick', {}));
    expect(ack.code).toBe(10001);
  });

  it('rejects a body that is missing the flat meta triple with 10001', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), { type: 'room.match', body: { payload: { mode: 'random' } } });
    expect(ack.code).toBe(10001);
  });

  it('rejects a stale timestamp with 13001 (M01)', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.unmatch', {}, { timestamp: Date.now() - 10_000 }));
    expect(ack.code).toBe(13001);
  });

  it('rate limits a single connection at 20 messages / 5s with 10006', async () => {
    const { deps } = makeDeps();
    const sock = makeSocket('alice');
    let last: { code: number } | undefined;
    for (let i = 0; i < 21; i++) last = await route(deps, sock, C('room.unmatch'));
    expect(last!.code).toBe(10006);
  });

  // ─── 风控 T3：封禁读点 / WS 限流档（§2.6-3 / §2.7-2 / C9）──────────

  /**
   * **风控 T3 · WS 限流档**（规格 §2.6-3/4）：`risk:limit:{userId}` 旗在 ⇒ 以
   * `THROTTLED_RATE_LIMIT = 3/1000ms` 对 **`ratelimit:ws-risk:{userId}`** 判定
   *（**按 userId 聚合**，替代按 socketId）；旗无 ⇒ 20/5s 按 socketId **原样**（负对照）。
   * 旗读故障 ⇒ **按无旗**（单独 catch，F8）——不得吞进既有 fail 语义。
   */
  describe('风控 T3 · WS 限流档（§2.6-3：userId 聚合 + 阈值参数化）', () => {
    /**
     * 构造旗读故障（只对指定前缀的键抛错，其余照常）——「单独 catch ⇒ 按无旗」的取证器。
     */
    const failExistsFor = (redis: ReturnType<typeof makeRedis>, prefix: string): void => {
      const existsMock = redis.exists as unknown as ReturnType<typeof vi.fn>;
      const real = existsMock.getMockImplementation()!;
      existsMock.mockImplementation(async (key: string) => {
        if (String(key).startsWith(prefix)) throw new Error('redis down');
        return real(key);
      });
    };

    it('旗在 ⇒ 3/1s **按 userId 聚合**：两条连接合计，第 4 条消息 ack 10006', async () => {
      const { deps, redis } = makeDeps();
      await redis.set('risk:limit:alice', JSON.stringify({ source: 'manual', at: Date.now() }));
      const first = makeSocket('alice');
      const second = makeSocket('alice');
      (second as unknown as { id: string }).id = 'sock-2';

      // 前 3 条（都走第一条连接）按档位放行
      for (let i = 0; i < 3; i++) {
        expect((await route(deps, first, C('room.unmatch'))).code).toBe(0);
      }
      // 第 4 条换一条连接发出 —— **同一 userId** ⇒ 同一个桶 ⇒ 超限
      expect((await route(deps, second, C('room.unmatch'))).code).toBe(10006);
      // 键形状逐字 = 规格 §2.6-3
      expect(redis.zadd).toHaveBeenCalledWith('ratelimit:ws-risk:alice', expect.any(Number), expect.any(String));
    });

    it('旗无 ⇒ **20/5s 原样**（负对照）：第 4 条不禁，且键仍是 ratelimit:ws:{socketId}', async () => {
      const { deps, redis } = makeDeps();
      const sock = makeSocket('alice');

      for (let i = 0; i < 4; i++) {
        expect((await route(deps, sock, C('room.unmatch'))).code, `第 ${i + 1} 条不得被档位阈值拦`).toBe(0);
      }
      const keys = (redis.zadd as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(keys.length).toBeGreaterThanOrEqual(4); // 正对照：真的走过限流桶
      expect(keys.every((k) => k === 'ratelimit:ws:sock-1')).toBe(true);
      expect(keys.some((k) => k === 'ratelimit:ws-risk:alice')).toBe(false);
    });

    it('旗读故障 ⇒ **按无旗**（走 20/5s、无抛出）+ error 日志（F8：单独 catch）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
      const { deps, redis } = makeDeps();
      failExistsFor(redis, 'risk:limit:');
      const sock = makeSocket('alice');

      for (let i = 0; i < 4; i++) {
        expect((await route(deps, sock, C('room.unmatch'))).code).toBe(0);
      }
      expect(records.map((r) => r.msg).join('\n')).toContain('risk:limit');
    });
  });

  /**
   * **风控 T3 · 封禁读点 ③④**（规格 §2.7-2 / C9）：入队前 / join 前读
   * `risk:banned:{userId}`（**单独 catch ⇒ 放行 + error 日志**，R11/F8）。
   */
  describe('风控 T3 · 封禁读点（§2.7-2 ③④：旗在 ⇒ 11003；旗读故障 ⇒ 放行）', () => {
    it('旗在 ⇒ room.match ack 11003、**不调** addToQueue（入队前拦）', async () => {
      const { deps, match, redis } = makeDeps();
      await redis.set('risk:banned:alice', '1');

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(11003);
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    /**
     * **波 2 F8：封禁读点 ③ 先于 dup/12009 判定的次序钉**。
     *
     * 夹具 = 「本会走 12009」的完整形态（meta 在〔makeDeps 缺省〕+ 队列成员在）——
     * 封禁旗一旦命中，必须**先**答 `11003`：封禁是准入闸，一律不泄漏「你有没有旧票」
     * （12009）这条信息。无此用例时，把旗读挪到 dup 探测之后**任何测试都不会红**
     *（无旗路径的 12009 用例照绿）。
     *
     * 顺带钉**无退队副作用**：拒绝路径不得碰旧票（`cancelQueue` 零调用、队列成员保持）——
     * 与 R63 的「meta 不在 ⇒ 先清理」相反：这里是**有**票、人被封，票不归本读点处置。
     */
    it('波 2 F8 次序钉：旗在 + 旧票（meta/队列命中，本会 12009）⇒ ack 11003 而非 12009；旧票保持', async () => {
      const { deps, match, redis } = makeDeps();
      // 「本会 12009」的夹具：队列成员在 + makeDeps 缺省的「meta 在」
      await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
      await redis.set('risk:banned:alice', '1');

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(11003);
      // 无退队副作用：拒绝路径不碰旧票（不 cancelQueue、不 addToQueue、成员保持）
      expect(match.cancelQueue).not.toHaveBeenCalled();
      expect(match.addToQueue).not.toHaveBeenCalled();
      // ⚠️ 走 `zscore` **读回**（本文件的 redis 替身不暴露 zsets 内部表 —— 只暴露
      // `_hashes`/`_strings`；早一稿直捅内部表在变体下被掩盖过，见波 2 F8 台账）。
      expect(
        await redis.zscore('match:queue:random:15:global', 'alice'),
        '旧票必须保持（拒绝路径不得碰它）',
      ).not.toBeNull();
    });

    /** 正对照：同夹具**去掉旗** ⇒ 确实走 12009（证明上面那条不是「本来就不会 12009」的空转）。 */
    it('波 2 F8 正对照：同夹具无旗 ⇒ 照常 12009（有条目 ≠ 被误拦）', async () => {
      const { deps, match, redis } = makeDeps();
      await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(12009);
      expect(match.cancelQueue).not.toHaveBeenCalled();
    });

    it('旗在 ⇒ room.join ack 11003、**不** socket.join（join 前拦）', async () => {
      const { deps, rooms, redis } = makeDeps();
      rooms.findOne.mockResolvedValue({
        code: 'ROOM1',
        mode: 'random',
        players: seatsOf('alice'),
        maxPlayers: 3,
        status: 'waiting',
        baseScore: 100,
        createdAt: Date.now(),
      });
      await redis.set('risk:banned:alice', '1');
      const sock = makeSocket('alice');

      const ack = await route(deps, sock, C('room.join', { roomCode: 'ROOM1' }));

      expect(ack.code).toBe(11003);
      expect(sock.join).not.toHaveBeenCalled();
    });

    it('旗读故障 ⇒ **放行 + 无抛出**（room.match 照常入队）+ error 日志', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));
      const { deps, match, redis } = makeDeps();
      const existsMock = redis.exists as unknown as ReturnType<typeof vi.fn>;
      const real = existsMock.getMockImplementation()!;
      existsMock.mockImplementation(async (key: string) => {
        if (String(key).startsWith('risk:banned:')) throw new Error('redis down');
        return real(key);
      });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalled();
      expect(records.map((r) => r.msg).join('\n')).toContain('risk:banned');
    });

    it('旗读故障 ⇒ join 也放行（不吞进既有 fail 语义）', async () => {
      const { deps, rooms, redis } = makeDeps();
      rooms.findOne.mockResolvedValue(null); // 房间不存在 ⇒ 正常语义是 12001（证明真的走进了正常链）
      const existsMock = redis.exists as unknown as ReturnType<typeof vi.fn>;
      const real = existsMock.getMockImplementation()!;
      existsMock.mockImplementation(async (key: string) => {
        if (String(key).startsWith('risk:banned:')) throw new Error('redis down');
        return real(key);
      });

      const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM9' }));

      expect(ack.code).toBe(12001); // 正常链的错误语义原样（不是 11003、不是 13001）
    });
  });

  /**
   * **风控 T3 · room.match 的 meta 写点与 deviceReport**（规格 §2.3 / §2.8 发送侧 / C8）：
   * `clientIp`（握手注入）与**校验后的** `deviceId` 经 extras 落 `match:meta`；
   * 入队**成功后** fire-and-forget 上报 `risk.deviceReport`（deviceId 缺省不调；失败不调）。
   */
  describe('风控 T3 · meta 写点与 deviceReport（§2.3 / §2.8 / C8）', () => {
    it('clientIp + deviceId ⇒ extras 原样交给 addToQueue（meta 两字段的写入侧）', async () => {
      const { deps, match } = makeDeps();
      const sock = makeSocket('alice', { clientIp: '203.0.113.7' });

      const ack = await route(deps, sock, C('room.match', { mode: 'random', baseScore: 15, deviceId: 'dev-abc123' }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {
        ip: '203.0.113.7',
        deviceId: 'dev-abc123',
      }, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('两字段缺省 ⇒ extras = 空对象（缺 = 不写该字段 —— fail-open 的写入侧）', async () => {
      const { deps, match } = makeDeps();

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('deviceId 在 + 入队成功 ⇒ `report` 恰一次（mock）；无 deviceId ⇒ 不调（正/负对照）', async () => {
      const { deps, risk } = makeDeps();

      await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15, deviceId: 'dev-abc123' }));
      expect(risk.report).toHaveBeenCalledTimes(1);
      expect(risk.report).toHaveBeenCalledWith('alice', 'dev-abc123');

      (risk.report as unknown as ReturnType<typeof vi.fn>).mockClear();
      await route(deps, makeSocket('bob'), C('room.match', { mode: 'random', baseScore: 15 }));
      expect(risk.report, 'deviceId 缺省（旧客户端）不得上报').not.toHaveBeenCalled();
    });

    it('入队**失败** ⇒ 不调 `report`（恰在 addToQueue 成功之后）', async () => {
      const { deps, match, risk } = makeDeps();
      match.addToQueue.mockRejectedValueOnce(
        new DomainError(ErrCode.UPSTREAM_UNAVAILABLE, '底分档位表不可用'),
      );

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15, deviceId: 'dev-abc123' }));

      expect(ack.code).toBe(10007);
      expect(risk.report).not.toHaveBeenCalled();
    });
  });

  // ─── room.match / room.matched（§6.3 / §8.2）─────────────────────

  it('room.match queues the player with the base-score-qualified key and answers code 0', async () => {
    const { deps, match } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(0);
    // 片规格 §2.4：`payload.baseScore` 必须原样穿到排队那一跳（撮合键的第三维）
    // 风控 T3：末位 = extras（本请求无 clientIp / deviceId ⇒ 空对象 —— 缺 = 不写该字段）
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  it('room.match answers 12009 when already queued', async () => {
    const { deps, redis, match } = makeDeps();
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
    expect(ack.code).toBe(12009);
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  it('room.match answers 12009 when queued in the other mode too', async () => {
    const { deps, redis } = makeDeps();
    await redis.zadd('match:queue:practice:15:global', Date.now(), 'alice');

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
    expect(ack.code).toBe(12009);
  });

  it('换底分重排：meta 指向旧 80 队列、本次请求 15 ⇒ 自动换队（先清旧票再入新队；不开双队列）', async () => {
    const { deps, redis, match } = makeDeps();
    // 玩家此前按 80 排着队（meta 也这么说），现在又用 15 发了一次 room.match
    await redis.zadd('match:queue:random:80:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue({
      playerId: 'alice',
      mode: 'random',
      baseScore: 80,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    });

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    // 机器人补位开关片（用户裁决）：维度不同不再回 12009 —— 先取消 meta 指向的**旧**队列票
    //（探测键必须来自 meta，只按本次请求的 15 查会漏 ⇒ 同一个人同时躺在两条队列上），
    // 再按本次请求正常入新队；新底分不得被静默忽略。
    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  it('换场次重排：旧票 gold/15、本次请求 random/15 ⇒ 自动换队（mode 维度不同即换）', async () => {
    const { deps, redis, match } = makeDeps();
    await redis.zadd('match:queue:gold:15:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue({
      playerId: 'alice',
      mode: 'gold',
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    });

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  /**
   * P1-9：换场的**校验必须先于撤销旧票**。
   *
   * 旧实现：维度不同 ⇒ 立刻 `cancelQueue`，随后才查场次开关/入场门槛 —— 新场次被拒
   *（12010/14003）时玩家已经退出旧队列、也没进新队列，等于凭空丢队。
   */
  it('P1-9：换场被开关拒绝（12010）⇒ 旧队列原样保留', async () => {
    const { deps, redis, match, configCache } = makeDeps();
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue({
      playerId: 'alice',
      mode: 'random',
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    });
    configCache.goldRoomEnabled.mockReturnValue(false);

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

    expect(ack.code).toBe(12010);
    expect(match.cancelQueue, '被拒绝的换场不得撤旧票').not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
    expect(await redis.zscore('match:queue:random:15:global', 'alice')).not.toBeNull();
  });

  it('P1-9：换场被入场门槛拒绝（14003）⇒ 旧队列原样保留', async () => {
    const { deps, redis, match, configCache, currency } = makeDeps();
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue({
      playerId: 'alice',
      mode: 'random',
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    });
    configCache.goldRoomEnabled.mockReturnValue(true);
    configCache.entryMultiplier.mockReturnValue(10);
    currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 149, exists: true }] });

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

    expect(ack.code).toBe(14003);
    expect(match.cancelQueue, '门槛拒绝不得撤旧票').not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
    expect(await redis.zscore('match:queue:random:15:global', 'alice')).not.toBeNull();
  });

  it('room.match.extend：调 extendWait 且恒回 0（票不在时由服务端幂等 no-op）', async () => {
    const { deps, match } = makeDeps();

    const ack = await route(deps, makeSocket('alice'), C('room.match.extend', {}));

    expect(ack.code).toBe(0);
    expect(match.extendWait).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).not.toHaveBeenCalled();
    expect(match.cancelQueue).not.toHaveBeenCalled();
  });

  it('meta 已过期但 ZSet 成员还在（孤儿）→ 先清理再入队，**不**返回 12009（R63）', async () => {
    const { deps, match, redis } = makeDeps();
    // 只留 ZSet 成员，不写 match:meta —— 复现「meta 到期而 ZSet 无 TTL」的分叉
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
    match.readMeta.mockResolvedValue(null);

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
  });

  it('meta 在 + ZSet 成员在 → 仍然 12009（幂等判定不得被 R63 改坏）', async () => {
    const { deps, match, redis } = makeDeps();
    await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
    // makeDeps 的默认 readMeta 就是「meta 在」
    expect(await match.readMeta('alice')).not.toBeNull();

    const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

    expect(ack.code).toBe(12009);
    expect(match.cancelQueue).not.toHaveBeenCalled();
    expect(match.addToQueue).not.toHaveBeenCalled();
  });

  // ── ② 金币场 §2.1：三值探测 —— 其余**两种**模式都探 ─────────────────
  //
  // 修前 `otherMode` 是二值时代的形状（random ↔ practice 互猜）⇒ **gold 队列被漏掉**：
  // 换场请求探测不到旧票，同一个人能同时躺在两条队列上。本组钉「覆盖其余两模式」。
  describe('② 三值探测（§2.1）：其余两种模式都探', () => {
    const goldTicket = {
      playerId: 'alice',
      mode: 'gold' as const,
      baseScore: 15,
      region: 'global',
      enteredAt: Date.now(),
      latency: 0,
      attempts: 0,
    };

    it('gold 队列 + 再次 gold 请求 ⇒ 12009（meta 指向金币队列）', async () => {
      const { deps, match, redis } = makeDeps();
      await redis.zadd('match:queue:gold:15:global', Date.now(), 'alice');
      match.readMeta.mockResolvedValue(goldTicket);

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(12009);
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    it('🔴 gold 孤儿票 + random 请求 ⇒ 先清理再入队（旧二值探测看不见 gold ⇒ 本条恒红）', async () => {
      const { deps, match, redis } = makeDeps();
      // meta 已过期（readMeta → null）但 gold 队列有残留 —— 旧实现的探测只覆盖
      // random/practice 两键，gold 残留既不会被发现、也不会被清掉。
      await redis.zadd('match:queue:gold:15:global', Date.now(), 'alice');
      match.readMeta.mockResolvedValue(null);

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.cancelQueue, 'gold 孤儿必须先清（探测覆盖其余两模式）').toHaveBeenCalledWith('alice');
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('random 孤儿票 + gold 请求 ⇒ 先清理再入队（探测在反方向同样覆盖）', async () => {
      const { deps, match, redis, configCache, currency } = makeDeps();
      await redis.zadd('match:queue:random:15:global', Date.now(), 'alice');
      match.readMeta.mockResolvedValue(null);
      configCache.goldRoomEnabled.mockReturnValue(true); // 走到入队那一跳需要场次开着
      currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 150, exists: true }] }); // 且余额过门槛

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.cancelQueue, 'random 孤儿必须先清').toHaveBeenCalledWith('alice');
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'gold', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });
  });

  // ── ② 金币场 T4：双开关（C1/C2）与入场门槛（C4）────────────────────
  //
  // 锚点 = 设计 D8：`handleMatch` 内、孤儿/重复探测**之后**、`addToQueue` **之前**。
  // 本组是 C1/C2/C4 的「router 分支」单测载体（节点判据：规格 §15 载体列）。
  describe('② 金币场：双开关（C1/C2）与入场门槛（C4）', () => {
    it('C2：gold 关（显式）⇒ 12010、不入队、**资金边零调用**；开 ⇒ 入队（正对照）', async () => {
      const { deps, match, configCache, currency } = makeDeps();
      // 2026-10-04 用户裁决：种子默认开 ⇒ 夹具缺省也是 true；「关」场景**显式**构造
      //（两个方向的行为覆盖都要在）。
      expect(configCache.goldRoomEnabled()).toBe(true); // 缺省即种子态 true —— 钉一遍免得夹具漂移
      configCache.goldRoomEnabled.mockReturnValue(false);

      const off = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(off.code).toBe(ErrCode.ROOM_MODE_DISABLED); // 12010
      expect(off.code).toBe(12010); // §10 的码值逐字
      expect(off.message).toBe('该场次暂未开放'); // §10 文案逐字
      expect(match.addToQueue).not.toHaveBeenCalled();
      expect(currency.get, '开关先于 get：关着的场次不得再打资金边').not.toHaveBeenCalled();

      configCache.goldRoomEnabled.mockReturnValue(true); // 用户开开关
      // ⚠️ 开开关只是第一道闸 —— 门槛（C4）紧随其后：正对照必须让余额也够
      //（缺省 balance=0 会让这里以 14003 变红，与开关无关）。
      currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 150, exists: true }] });
      const on = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));
      expect(on.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'gold', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('C1：free 关 ⇒ random 被 12010 拒；恢复 ⇒ 入队（正对照）', async () => {
      const { deps, match, configCache } = makeDeps();
      configCache.freeRoomEnabled.mockReturnValue(false);

      const off = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
      expect(off.code).toBe(12010);
      expect(match.addToQueue).not.toHaveBeenCalled();

      configCache.freeRoomEnabled.mockReturnValue(true);
      const on = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
      expect(on.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('C1 边界：practice 不在双开关范围（好友房走 REST 建房入口的 friendRoomEnabled/12006）', async () => {
      const { deps, match, configCache } = makeDeps();
      configCache.freeRoomEnabled.mockReturnValue(false);
      configCache.goldRoomEnabled.mockReturnValue(false);

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'practice', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'practice', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
      // 反空测：两个开关都**不该**为 practice 被读（读了说明映射写错了形状）。
      expect(configCache.freeRoomEnabled).not.toHaveBeenCalled();
      expect(configCache.goldRoomEnabled).not.toHaveBeenCalled();
    });

    it('C4：余额 < baseScore × entryMultiplier ⇒ 14003（消息含所需金额）、不入队', async () => {
      const { deps, match, configCache, currency } = makeDeps();
      configCache.goldRoomEnabled.mockReturnValue(true);
      configCache.entryMultiplier.mockReturnValue(10);
      currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 149, exists: true }] });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(ErrCode.E_ENTRY_THRESHOLD); // 14003
      expect(ack.code).toBe(14003);
      expect(ack.message).toBe('金币不足：该场次需要 ≥ 150'); // needed = 15 × 10（须含具体金额）
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    it('C4 边界：余额**恰达**门槛（= needed）⇒ 入队（判定是 ≥，不是 >）', async () => {
      const { deps, match, configCache, currency } = makeDeps();
      configCache.goldRoomEnabled.mockReturnValue(true);
      currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 150, exists: true }] });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'gold', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('C4：exists=false（未开户）按 0 判 ⇒ 14003（contract 上 balance 就是 0）', async () => {
      const { deps, configCache, currency } = makeDeps();
      configCache.goldRoomEnabled.mockReturnValue(true);
      currency.get.mockResolvedValue({ balances: [{ ownerId: 'alice', balance: 0, exists: false }] });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(14003);
    });

    it('C4：免费场（random）**不查资金** —— get 零调用、余额为 0 也照常入队', async () => {
      const { deps, match, currency } = makeDeps();
      // 若实现误把门槛套到免费场，这个会抛的替身会让用例以 10007/13001 变红。
      currency.get.mockRejectedValue(new Error('免费场不得触碰资金边'));

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(currency.get).not.toHaveBeenCalled();
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('C4：get 传输故障 ⇒ ack 10007（真 CurrencyClient + 假 proxy；消息不含内部详情）', async () => {
      const made = makeDeps();
      made.configCache.goldRoomEnabled.mockReturnValue(true);
      // 与「真 GameClient + 假 ClientProxy」用例同形：缺陷可能出现在两侧接缝
      //（client 的消息构造 + router 的错误映射），mock 掉任一半都测不到。
      const realCurrency = new CurrencyClient({
        send: () => throwError(() => new Error('connect ECONNREFUSED 172.28.0.10:3104')),
      } as never);

      const ack = await route(
        { ...made.deps, currency: realCurrency },
        makeSocket('alice'),
        C('room.match', { mode: 'gold', baseScore: 15 }),
      );

      expect(ack.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE); // 10007 —— 修前会落 13001
      expect(ack.code).not.toBe(13001);
      expect(ack.message).toBe(TRANSPORT_FAILURE_MESSAGE); // 固定文案
      expect(ack.message ?? '').not.toContain('ECONNREFUSED');
      expect(ack.message ?? '').not.toContain('172.28.0.10');
    });

    it('顺序契约（D8 锚点）：dup 探测先于开关 —— 已在金币队列 ⇒ 12009（即便场次已关）', async () => {
      const { deps, match, redis, configCache } = makeDeps();
      await redis.zadd('match:queue:gold:15:global', Date.now(), 'alice');
      match.readMeta.mockResolvedValue({
        playerId: 'alice', mode: 'gold', baseScore: 15, region: 'global',
        enteredAt: Date.now(), latency: 0, attempts: 0,
      });
      // **显式**关（种子默认已翻为 true，2026-10-04 裁决）—— 若开关先于探测，这里拿的是 12010。
      configCache.goldRoomEnabled.mockReturnValue(false);
      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(ErrCode.ALREADY_IN_QUEUE);
      expect(ack.code).not.toBe(12010);
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    it('顺序契约（D8 锚点）：开关先于 get —— 开关关时资金边零调用（会抛的 get 自证）', async () => {
      const { deps, currency, configCache } = makeDeps();
      currency.get.mockRejectedValue(new Error('开着的场次才配走资金边'));
      // **显式**关（种子默认已翻为 true，2026-10-04 裁决）—— 开关关才有判别力。
      configCache.goldRoomEnabled.mockReturnValue(false);

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'gold', baseScore: 15 }));

      expect(ack.code).toBe(12010); // 若顺序反了，这里会是 10007/13001
      expect(currency.get).not.toHaveBeenCalled();
    });
  });

  // ── 本片：room.match 在局/在房守卫（规格 §2.2 / C1-C6）────────────────
  //
  // 用户裁决 K2：在局/在房者不得匹配。判据两段：resolver 第一遍命中（waiting/playing）；
  // playing 再加 view-ended 放行（`updateStatus(finished)` 是 fire-and-forget ——
  // 写丢失不把玩家卡到房键 TTL）。失败面是契约的一半：缺失类 ⇒ 12011（**不得**上抛成
  // 12001，那会让客户端 BACK_TO_LOBBY 静默踢回大厅）；仅传输类故障原样上抛（走既有面）。
  describe('本片：room.match 在局/在房守卫（C1-C6）', () => {
    /** resolver 命中形状（§2.2 的唯一输入）：房号 + 来源 + 房态。 */
    const claim = (status: string) => ({ roomCode: 'ROOM1', source: 'record' as const, status });

    it('C1：playing + view 非 ended ⇒ 12011（码与 message 逐字）、未入队', async () => {
      const { deps, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
      game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'playing', trustees: [false, false, false], version: 5 });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(ErrCode.ALREADY_IN_GAME);
      expect(ack.code).toBe(12011); // §0.3-1：码值逐字
      expect(ack.message).toBe('You are still in an active game'); // §0.3-1：message 逐字（waiting/playing 共用）
      // 第二段用 resolver 的房号 + 请求者身份取视图（不得用别的来源）
      expect(game.view).toHaveBeenCalledWith('ROOM1', 'alice');
      expect(match.addToQueue).not.toHaveBeenCalled();
      // zscore 证「未入队」：真实队列键上读回无成员（不只信替身的调用记录）。
      // ⚠️ 门审 T2-I1 口径：本条是**随附一致性断言**（真证书 = 上一条 `addToQueue` 未被调 ——
      // 替身只在被调时写队列，单看读回判别力有限；两条并立才完整）。
      expect(await deps.redis.zscore('match:queue:random:15:global', 'alice')).toBeNull();
    });

    it('C2：waiting ⇒ 12011 且 **不调** game.view（第二段只对 playing 展开）', async () => {
      const { deps, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockResolvedValue(claim('waiting'));

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(12011);
      expect(game.view, 'waiting 无第二段：不得去取视图').not.toHaveBeenCalled();
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    it('C3：无凭据 / finished / 已回收 ⇒ 放行入队（三个正对照）', async () => {
      // ① 无凭据（makeDeps 缺省 resolver → null）：守卫整体跳过，直奔入队
      {
        const { deps, match, game } = makeDeps();
        const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
        expect(ack.code).toBe(0);
        expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
        expect(game.view).not.toHaveBeenCalled();
      }
      // ② finished（fire-and-forget 写丢失的接受面）与 ③ 已回收（cancelled）：同样放行
      for (const status of ['finished', 'cancelled']) {
        const { deps, match, game, reconnect } = makeDeps();
        reconnect.resolveRecoverableRoom.mockResolvedValue(claim(status));

        const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

        expect(ack.code, `status=${status} 不得被守卫拦`).toBe(0);
        expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
        expect(game.view, `status=${status} 无第二段`).not.toHaveBeenCalled();
      }
    });

    it("C4：playing + view.state === 'ended' ⇒ 放行入队（结束瞬间的兜底放行）", async () => {
      const { deps, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
      game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'ended', version: 22 });

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(0);
      expect(match.addToQueue).toHaveBeenCalledWith('alice', 'random', 15, undefined, {}, { gameType: 'doudizhu', playerCount: 3 });
    });

    it('C5①：resolver reject（凭据读故障）⇒ 13001（**不是** 12011 —— 读故障不得伪装成在局）', async () => {
      const { deps, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockRejectedValue(new Error('redis down'));

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(13001);
      expect(ack.code).not.toBe(12011);
      expect(game.view).not.toHaveBeenCalled();
      expect(match.addToQueue).not.toHaveBeenCalled();
    });

    it('C5②：view 传输类 ⇒ ∈ 既有失败面（10007/13001）且 ≠ 12011（专用分支先于通用 catch）', async () => {
      const { deps, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));

      // ① GameServiceError(10007)：外层 GameServiceError 分支照实 ack —— 不得被吞成 12011
      game.view.mockRejectedValueOnce(new GameServiceError(10007, 'game-service unavailable'));
      const known = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
      expect(known.code).toBe(10007);
      expect(known.code).not.toBe(12011);
      expect(match.addToQueue).not.toHaveBeenCalled();

      // ② 非 GameServiceError 的传输类（连接被 reset 这类）⇒ 通用 catch ⇒ 13001，同样 ≠ 12011
      game.view.mockRejectedValueOnce(new Error('socket hang up'));
      const unknown = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));
      expect(unknown.code).toBe(13001);
      expect(unknown.code).not.toBe(12011);
    });

    it('C5③：view 缺失类（ROOM_NOT_FOUND / NOT_IN_ROOM / 直接 null）⇒ 12011（不得上抛成 12001）', async () => {
      // ① ROOM_NOT_FOUND（12001）：isMissingGameError 分流 ⇒ 视同拿不到 ⇒ 12011
      {
        const { deps, game, match, reconnect } = makeDeps();
        reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
        game.view.mockRejectedValueOnce(new GameServiceError(ErrCode.ROOM_NOT_FOUND, 'Game not found'));

        const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

        expect(ack.code).toBe(12011);
        // 反面对照：**不得**上抛成 12001 —— 客户端 CLIENT_ACTION[12001] 是 BACK_TO_LOBBY，
        // 会把还在局里的玩家静默踢回大厅（这才是守卫存在的意义）。
        expect(ack.code).not.toBe(12001);
        expect(match.addToQueue).not.toHaveBeenCalled();
      }
      // ② NOT_IN_ROOM（12004）同族
      {
        const { deps, game, reconnect } = makeDeps();
        reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
        game.view.mockRejectedValueOnce(new GameServiceError(ErrCode.NOT_IN_ROOM, 'You are not in this game'));

        expect((await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }))).code).toBe(12011);
      }
      // ③ view 直接解析成 null（结束瞬间竞态：会话已收）⇒ 同样 12011
      {
        const { deps, game, reconnect } = makeDeps();
        reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
        game.view.mockResolvedValue(null);

        expect((await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }))).code).toBe(12011);
      }
    });

    it('C6：封禁 + 在局 ⇒ 11003（封禁主闸先于守卫 —— 次序由本用例钉住）', async () => {
      const { deps, redis, game, match, reconnect } = makeDeps();
      reconnect.resolveRecoverableRoom.mockResolvedValue(claim('playing'));
      game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'playing', trustees: [false, false, false], version: 5 });
      await redis.set('risk:banned:alice', '1');

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(ErrCode.USER_BANNED); // 11003
      expect(ack.code).not.toBe(12011);
      // 封禁是准入闸：一切队列探测之前 —— 连 resolver 都不该被打到
      expect(reconnect.resolveRecoverableRoom).not.toHaveBeenCalled();
      expect(game.view).not.toHaveBeenCalled();
      expect(match.addToQueue).not.toHaveBeenCalled();
    });
  });

  it('room.unmatch 取消排队（不再按两个模式各删一次）', async () => {
    const { deps, match } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.unmatch', {}));

    expect(ack.code).toBe(0);
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
  });

  // ─── room.join / room.state_update 裁剪（§6.4 规则 3）────────────

  it('座位取自 `Seat.seat`，不是 players 数组下标（R128）', async () => {
    const { deps, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      // 数组顺序与座位号**故意错开**：按下标取会得到 0/1/2，按 `seat` 取才是 2/0/1
      players: [seat('bob', 2), seat('alice', 0), seat('carol', 1)],
    });

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect((ack.data as { seat: number }).seat).toBe(0); // 下标会给出 1
    const data = ack.data as { players: Array<{ id: string; seat: number }> };
    expect(data.players.map((p) => p.seat)).toEqual([2, 0, 1]); // 顺序 = room.players 的顺序
  });

  it('room.join returns the trimmed RoomPlayer list and records seat owners', async () => {
    const { deps, rooms, seatEvents, redis } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM1',
      mode: 'random',
      players: seatsOf('alice', 'bob', 'p_1234'),
      maxPlayers: 3,
      status: 'playing',
      baseScore: 100,
      createdAt: Date.now(),
    });
    await redis.hset('room:ROOM1:cardcount', 'alice', '17');
    await redis.hset('room:ROOM1:cardcount', 'bob', '17');

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(ack.data).toMatchObject({ roomCode: 'ROOM1', seat: 0 });
    const players = (ack.data as { players: Array<Record<string, unknown>> }).players;
    expect(players).toEqual([
      { id: 'alice', seat: 0, cardCount: 17 },
      { id: 'bob', seat: 1, cardCount: 17 },
      { id: 'p_1234', seat: 2 },
    ]);
    // §9.1：机器人在所有下发消息中不可区分 —— 不得出现 isRobot/bot 前缀
    const serialized = JSON.stringify(players);
    expect(serialized).not.toContain('isRobot');
    expect(serialized).not.toContain('bot');
    expect(seatEvents[0]!.seats).toHaveLength(3);
  });

  it('room.join players 带昵称：人类与机器人都来自 ensure 的缓存', async () => {
    const { deps, rooms, nicknames } = makeDeps();
    nicknames.ensure.mockResolvedValue(
      new Map([
        ['alice', '阿豆'],
        ['p_1234', '小北'],
      ]),
    );
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      players: [seat('alice', 0), seat('bob', 2), seat('p_1234', 1, true)],
      status: 'playing',
    });

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));
    const players = (ack.data as { players: Array<Record<string, unknown>> }).players;

    expect(players[0]).toMatchObject({ seat: 0, nickname: '阿豆' });
    expect(players[2]).toMatchObject({ seat: 1, nickname: '小北' });
    expect(players[1]!.nickname).toBeUndefined();
  });

  it('机器人昵称走真实 RoomNicknamesService：缓存命中，缺失的人类才回源', async () => {
    const nameRedis = createFakeRedis();
    await nameRedis.hset(nicknamesKey('ROOM1'), { alice: '阿豆', p_1234: '小北' });
    const client = { getNicknames: vi.fn().mockResolvedValue(new Map()) };
    const service = new RoomNicknamesService(asRedis(nameRedis), client as never);
    const { deps, rooms } = makeDeps({ nicknames: service as never });
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      players: [seat('alice', 0), seat('bob', 2), seat('p_1234', 1, true)],
      status: 'playing',
    });

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));
    const players = (ack.data as { players: Array<Record<string, unknown>> }).players;

    expect(players[0]).toMatchObject({ seat: 0, nickname: '阿豆' });
    expect(players[2]).toMatchObject({ seat: 1, nickname: '小北' });
    expect(players[1]!.nickname).toBeUndefined();
    // 只有缺失的人类 bob 回源；机器人 displayId 绝不进 RPC。
    expect(client.getNicknames).toHaveBeenCalledWith(['bob']);
  });

  it('room.join 成功后向房间广播 room.state_update（玩家列表来自 buildRoomPlayers）', async () => {
    const { deps, rooms, nicknames, roomStateEvents } = makeDeps();
    nicknames.ensure.mockResolvedValue(new Map([['alice', '阿豆']]));
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      players: seatsOf('alice'),
      status: 'waiting',
    });

    await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(roomStateEvents).toHaveLength(1);
    expect(roomStateEvents[0]).toMatchObject({
      roomCode: 'ROOM1',
      status: 'waiting',
      players: [{ id: 'alice', seat: 0, nickname: '阿豆' }],
    });
  });

  it('room.leave 成功后广播（重新读取房间，离开者不在列表里）', async () => {
    const { deps, rooms, roomStateEvents } = makeDeps();
    rooms.findOne
      .mockResolvedValueOnce({ ...roomInfo('ROOM1'), players: seatsOf('alice', 'bob') })
      .mockResolvedValueOnce({ ...roomInfo('ROOM1'), players: seatsOf('bob') });

    await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(roomStateEvents).toHaveLength(1);
    expect(roomStateEvents[0]).toMatchObject({
      roomCode: 'ROOM1',
      players: [{ id: 'bob', seat: 0 }],
    });
  });

  /**
   * ② 金币场 T5（规格 §2.3）：`RoomPlayer.balance` 来自派生键 `room:{code}:balances`
   * （金币场开局时由 `RoomStartService` 写入）。
   *
   * 双向判据：有键 ⇒ 有字段（按座位取）；**无键 ⇒ 字段永不出现**（免费场/好友房
   * 「整场统一 —」的不可区分性红线；金币场读失败同走这一支）。
   */
  it('② T5：金币场的 balances 键 ⇒ balance 按座位出现；无键 ⇒ 字段不出现', async () => {
    const { deps, rooms, redis } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM1',
      mode: 'gold',
      players: seatsOf('alice', 'bob', 'p_1234'),
      maxPlayers: 3,
      status: 'playing',
      baseScore: 15,
      createdAt: Date.now(),
    });
    await redis.hset('room:ROOM1:balances', '0', '12345');
    await redis.hset('room:ROOM1:balances', '2', '6789');

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    const players = (ack.data as { players: Array<Record<string, unknown>> }).players;
    expect(players).toEqual([
      { id: 'alice', seat: 0, balance: 12345 },
      { id: 'bob', seat: 1 }, // 该座无字段（键里缺 seat 1）⇒ 省略（客户端显「—」）
      { id: 'p_1234', seat: 2, balance: 6789 },
    ]);
    // 不可区分性红线：机器人的对外形态里不得出现 isRobot / bot 前缀
    const serialized = JSON.stringify(players);
    expect(serialized).not.toContain('isRobot');
    expect(serialized).not.toContain('bot');

    // 无键（免费场/好友房，或金币场读失败）⇒ balance 字段**永不出现**
    rooms.findOne.mockResolvedValue({
      code: 'ROOM2',
      mode: 'random',
      players: seatsOf('alice'),
      maxPlayers: 3,
      status: 'playing',
      baseScore: 100,
      createdAt: Date.now(),
    });
    const ack2 = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM2' }));
    const players2 = (ack2.data as { players: Array<Record<string, unknown>> }).players;
    expect(players2).toEqual([{ id: 'alice', seat: 0 }]);
  });

  it('room.join is allowed via a pending match even before the room member list is written', async () => {
    const { deps, rooms, redis } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM2',
      mode: 'random',
      players: [],
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM2');
    await redis.hset('match:pending:alice', 'seat', '2');

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM2' }));
    expect(ack.code).toBe(0);
    // R48 之后座位只能来自两个真相源：`room.players` 里自己那条 `Seat.seat`，或 `match:pending.seat`。
    // 旧实现从**出站** players 里反查（掩码后就查不到自己了 → 恒定回落到 0）。
    expect((ack.data as { seat: number }).seat).toBe(2);
  });

  it('room.join ack 中机器人 id 不以 bot 为前缀（§9.8）', async () => {
    const { deps, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      players: [...seatsOf('alice'), seat('bot-abc', 1, true), seat('bot-def', 2, true)],
    });

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    const data = ack.data as { seat: number; players: Array<{ id: string; seat: number }> };
    expect(data.seat).toBe(0);
    expect(data.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(data.players.some((p) => p.id.startsWith('bot'))).toBe(false);
    expect(JSON.stringify(data)).not.toContain('bot');
  });

  it('投递路由表登记的仍是**真实** id（反向断言：掩码不得进入 seatOwners）', async () => {
    const { deps, rooms, seatEvents } = makeDeps();
    rooms.findOne.mockResolvedValue({
      ...roomInfo('ROOM1'),
      players: [...seatsOf('alice'), seat('bot-abc', 1, true)],
    });

    await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    // 若这里拿到 `seat-1`，game.deal 就会投递到一个不存在的玩家 → 机器人座位永远收不到牌
    expect(seatEvents).toHaveLength(1);
    expect(seatEvents[0]!.seats).toEqual([
      { userId: 'alice', seat: 0 },
      { userId: 'bot-abc', seat: 1 },
    ]);
  });

  it('toOutboundPlayerId 只掩码 bot- 前缀', () => {
    expect(toOutboundPlayerId('bot-abc', 1)).toBe('seat-1');
    expect(toOutboundPlayerId('11111111-2222-3333-4444-555555555555', 2)).toBe(
      '11111111-2222-3333-4444-555555555555',
    );
  });

  /**
   * R207（E9 的机械判据）：机器人对外 id 统一到 `p_<8位>` 之后，
   * 掩码函数对**正常 id 必须原样返回** —— 否则每个真人玩家都会被改写成 `seat-N`，
   * 而这条路径**不会有任何测试红**（掩码保留为纵深防御，正常路径本不该触发它）。
   *
   * 正/负对照成对：`bot-` 前缀仍必须被掩掉（否则「保留为纵深防御」是空话）。
   */
  it('toOutboundPlayerId 对 `p_<8位>` 原样返回（R207：不得把正常 id 也掩掉）', () => {
    expect(toOutboundPlayerId('p_1234abcd', 0)).toBe('p_1234abcd');
    expect(toOutboundPlayerId('p_00000000', 2)).toBe('p_00000000');
    expect(toOutboundPlayerId('bot-1234abcd', 0)).toBe('seat-0'); // 纵深防御仍在
  });

  it('room.join answers 12001 for an unknown room', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'NOPE' }));
    expect(ack.code).toBe(12001);
  });

  it('room.join answers 12004 when the caller is neither a member nor pending', async () => {
    const { deps, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM3',
      mode: 'random',
      players: seatsOf('someone-else'),
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });
    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM3' }));
    expect(ack.code).toBe(12004);
  });

  it('room.join 刷新重连记录（touch 只写哈希，§6.6.1 时机 1）', async () => {
    const { deps, rooms, reconnect } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM4',
      mode: 'random',
      players: seatsOf('alice'),
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });

    const sock = makeSocket('alice');
    await route(deps, sock, C('room.join', { roomCode: 'ROOM4' }));

    // 写入侧的唯一实现是 `ReconnectService.touch()`（它只写哈希字段、不设 TTL，
    // 见 reconnect.service.test.ts）—— 不再由路由直接拼键（偏差 C12）。
    expect(reconnect.touch).toHaveBeenCalledWith('alice', sock.id, 'ROOM4');
  });

  it('room.leave 用 clearConnection 清掉重连记录（只删哈希）', async () => {
    const { deps, reconnect } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(reconnect.clearConnection).toHaveBeenCalledWith('alice');
  });

  it('room.leave 同时清除 match:pending:{playerId}（§6.6.1 判定顺序第 1 步）', async () => {
    const { deps, redis, rooms } = makeDeps();
    rooms.findOne.mockResolvedValue({
      code: 'ROOM1',
      mode: 'random',
      players: seatsOf('alice'),
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM1');
    await redis.hset('match:pending:alice', 'seat', '0');

    const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    expect(await redis.hget('match:pending:alice', 'roomCode')).toBeNull();
    expect(await redis.exists('match:pending:alice')).toBe(0);
  });

  // ── 本片（自动开局）：占用变化 ⇒ 重置等待窗口 ──────────────────
  /**
   * `waiting` 房间里**入座 / 退座**都要重抽补位死线并重写回收窗口（spec §3.1 / R904）。
   *
   * 为什么：`timeoutAt` / `fillat` 在 `create()` 时定死，而房主建完房到真正有人进来
   * 之间可能隔一会儿 —— 不重置的话，房主一进来就只剩几秒了。
   *
   * ⚠️ **`playing` 房间必须跳过**（R916）：对局中的进出不该动窗口（`timeoutAt` 归零是
   * 「等待窗口已关闭」的既有纪律，不得复活）。
   */
  describe('占用变化 ⇒ 重置等待窗口（R904 / R916）', () => {
    const waitingRoom = (code: string, players = seatsOf('alice')) => ({
      code,
      mode: 'random',
      players,
      maxPlayers: 3,
      status: 'waiting',
      baseScore: 100,
      createdAt: Date.now(),
    });

    it('room.join 成功 ⇒ 重抽死线 + 重写回收窗口', async () => {
      const { deps, rooms } = makeDeps();
      rooms.findOne.mockResolvedValue(waitingRoom('ROOM5'));

      const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM5' }));

      expect(ack.code).toBe(0);
      expect(rooms.resetWaitingWindow, 'join 必须重置等待窗口').toHaveBeenCalledWith('ROOM5');
    });

    it('room.leave 成功 ⇒ 腾座位 + 重置等待窗口', async () => {
      const { deps, rooms } = makeDeps();
      rooms.findOne.mockResolvedValue(waitingRoom('ROOM6'));

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM6' }));

      expect(ack.code).toBe(0);
      expect(rooms.leaveSeat, '退房必须腾座位（R906）').toHaveBeenCalledWith('ROOM6', 'alice');
      expect(rooms.resetWaitingWindow).toHaveBeenCalledWith('ROOM6');
    });

    /**
     * ⚠️ **路由不做状态判断**，它只负责「房间在 ⇒ 把两件事交出去」。
     * `status === 'waiting'` 的那道闸在 **`leaveSeat` / `resetWaitingWindow` 内部**
     *（R916 的唯一落点，服务层判据见 `rooms.service.test.ts` 的正/负对照）。
     *
     * 本文件把 `rooms` 整个替掉了 ⇒ 在这里断言「对局中不腾」等于**断言替身的行为**，
     * 那正是本仓反复付代价的假绿形态。⇒ 这里只钉**接线**（两个方法都被调到、且房号对），
     * **效果**由服务层用例钉。
     */
    it('房间在 ⇒ 两个方法都被调到（状态闸在服务层，不在这里）', async () => {      const { deps, rooms } = makeDeps();
      rooms.findOne.mockResolvedValue({ ...waitingRoom('ROOM8'), status: 'playing' });

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM8' }));

      expect(ack.code).toBe(0);
      expect(rooms.leaveSeat).toHaveBeenCalledWith('ROOM8', 'alice');
      expect(rooms.resetWaitingWindow).toHaveBeenCalledWith('ROOM8');
    });

    /**
     * 本片（spec §3.3 / R902）：**最后一个入座者同步触发开局**。
     *
     * 为什么不能只靠 5 秒一轮的扫描器：用户裁决是「**房间满即开局**」——
     * 三个真人到齐却要等到下个扫描周期（最多 5 秒）才发牌，那是白等。
     * ⚠️ 它**不是**第二条开局实现：只是把同一个 `startRoom` 早叫一步
     *（扫描器仍是兜底，两个触发器共用同一条链 —— R909 的唯一写入点不破）。
     */
    it('入座后**房间满** ⇒ 立刻触发开局（不等扫描周期）', async () => {
      const { deps, rooms, roomStart } = makeDeps();
      rooms.findOne.mockResolvedValue({
        ...waitingRoom('ROOM9', seatsOf('alice', 'bob', 'carol')),
      });

      const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM9' }));

      expect(ack.code).toBe(0);
      expect(roomStart.startRoom).toHaveBeenCalledWith('ROOM9', { strict: true });
    });

    it('负对照：入座后**还没满** ⇒ 不触发（交给扫描器等死线）', async () => {
      const { deps, rooms, roomStart } = makeDeps();
      rooms.findOne.mockResolvedValue(waitingRoom('ROOM10', seatsOf('alice')));

      const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM10' }));

      expect(ack.code).toBe(0);
      expect(roomStart.startRoom, '没满就开 = 少一个人开局').not.toHaveBeenCalled();
    });

    it('负对照：房间已经没了 ⇒ room.leave 仍然成功，且**两个方法都不调**', async () => {
      const { deps, rooms } = makeDeps(); // findOne 默认 null
      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'GONE01' }));

      expect(ack.code, '房间没了也要让玩家走得掉').toBe(0);
      expect(rooms.leaveSeat).not.toHaveBeenCalled();
      expect(rooms.resetWaitingWindow).not.toHaveBeenCalled();
    });
  });

  // ── 本片：room.leave 清理单闸（规格 §2.3 / C7 的 router 半边）────────────
  //
  // 设计 §3.2：两凭据（`reconnect:active` 记录、`match:pending.roomCode`）**各自**
  // 「缺席 或 roomCode === 请求值」⇒ 清理全做（clearConnection + del pending + onSeatLeft）；
  // **任一「存在且不一致」⇒ 清理全不做**（防「错房号 leave 即解锁匹配」旁路）。
  // 三种情况都返 ok() —— 清理是幂等内务，不改变 leave 本身的应答。
  describe('本片：room.leave 清理单闸（C7）', () => {
    /** 写一条指向 `roomCode` 的真实重连记录（假 redis 的 `RECONNECT_HASH_KEY` 字段）。 */
    const putRecord = (redis: ReturnType<typeof makeRedis>, roomCode: string) =>
      redis.hset(
        RECONNECT_HASH_KEY,
        'alice',
        JSON.stringify({ socketId: 'sock-1', roomCode, connectedAt: Date.now() }),
      );

    it('一致清：两凭据都指向本房 ⇒ clearConnection + del pending + onSeatLeft 全做', async () => {
      const onSeatLeft = vi.fn();
      const { deps, redis, reconnect } = makeDeps({ onSeatLeft });
      await putRecord(redis, 'ROOM1');
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM1');

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

      expect(ack.code).toBe(0);
      expect(reconnect.clearConnection).toHaveBeenCalledWith('alice');
      expect(await redis.hget(RECONNECT_HASH_KEY, 'alice')).toBeNull(); // 真实键读回（不经替身断言）
      expect(await redis.hget('match:pending:alice', 'roomCode')).toBeNull();
      expect(onSeatLeft).toHaveBeenCalledWith('ROOM1', 'alice');
    });

    it('不一致不清①（记录半边否决）：记录存在且 ≠ 请求房号 ⇒ 全不清、仍 ok', async () => {
      const onSeatLeft = vi.fn();
      const { deps, redis, reconnect } = makeDeps({ onSeatLeft });
      // 记录指向 ROOM2、pending 与请求一致 —— 记录这一条就足以否决全部清理
      await putRecord(redis, 'ROOM2');
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM1');

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

      expect(ack.code, '不一致也返回 ok（清理与否是内务）').toBe(0);
      expect(reconnect.clearConnection).not.toHaveBeenCalled();
      expect(await redis.hget(RECONNECT_HASH_KEY, 'alice'), '不一致 ⇒ 记录必须原样保留').not.toBeNull();
      expect(await redis.hget('match:pending:alice', 'roomCode'), '不一致 ⇒ pending 也不得被清').toBe('ROOM1');
      expect(onSeatLeft).not.toHaveBeenCalled();
    });

    it('不一致不清②（pending 半边否决）：pending 存在且 ≠ 请求房号 ⇒ 同样全不清', async () => {
      const onSeatLeft = vi.fn();
      const { deps, redis, reconnect } = makeDeps({ onSeatLeft });
      // 记录缺席、pending 指向 ROOM2 —— pending 这一条就足以否决全部清理
      await redis.hset('match:pending:alice', 'roomCode', 'ROOM2');

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

      expect(ack.code).toBe(0);
      expect(reconnect.clearConnection).not.toHaveBeenCalled();
      expect(await redis.hget('match:pending:alice', 'roomCode')).toBe('ROOM2');
      expect(onSeatLeft).not.toHaveBeenCalled();
    });

    it('缺席清且幂等：两凭据都缺席 ⇒ 照清；连发两次都 ok、不抛（钉 :1092-1097 / :1212-1219 语义）', async () => {
      const onSeatLeft = vi.fn();
      const { deps, reconnect } = makeDeps({ onSeatLeft });

      const first = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));
      const second = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

      expect(first.code).toBe(0);
      expect(second.code, '幂等：没有凭据可清时 leave 仍须 ok，且不得抛').toBe(0);
      expect(reconnect.clearConnection).toHaveBeenCalledTimes(2);
      expect(onSeatLeft).toHaveBeenCalledTimes(2);
    });
  });

  // ── N34 / R524：`room.join` 成功后必须**兜底清票** ────────────────
  //
  // 缺陷形态（P11 前端 agent 发现、P13/P14 未修）：`room.join` 既不取消队列也不清
  // `match:pending`（只有 `room.leave` 清）⇒ 用户在「正在匹配…」时点「创建房间」或「加入」，
  // 服务端仍持有他的队列成员与票据，之后可能给他推 `room.matched {另一个房间}` ——
  // 而他正坐在这一间里。R418 同族：复位点要写在**唯一共同写入处**（两条入口都不会漏）。

  it('room.join 成功后兜底清票：显式取消排队 + 真实删掉 match:pending（N34/R524）', async () => {
    const { deps, rooms, match, redis } = makeDeps();
    rooms.findOne.mockResolvedValue(roomInfo('ROOM1')); // alice 在房里
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM1');
    await redis.hset('match:pending:alice', 'seat', '0');

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM1' }));

    expect(ack.code).toBe(0);
    // ① 契约：替身只能断言「被调用 + 实参」（切片 7 教训 1：断言次数不等于断言契约）
    expect(match.cancelQueue).toHaveBeenCalledWith('alice');
    // ② 行为：**真实** Redis 上的票据必须没了（这条不经替身）
    expect(await redis.hget('match:pending:alice', 'roomCode')).toBeNull();
    expect(await redis.exists('match:pending:alice')).toBe(0);
  });

  it('正对照：room.join **失败**时不得清票（否则把还在匹配的人踢出队列）', async () => {
    const { deps, rooms, match, redis } = makeDeps();
    rooms.findOne.mockResolvedValue(null); // 房间不存在 ⇒ 直接失败
    await redis.hset('match:pending:alice', 'roomCode', 'ROOM9');

    const ack = await route(deps, makeSocket('alice'), C('room.join', { roomCode: 'ROOM9' }));

    expect(ack.code).toBe(12001);
    expect(match.cancelQueue).not.toHaveBeenCalled();
    expect(await redis.hget('match:pending:alice', 'roomCode')).toBe('ROOM9'); // 票还在
  });

  it('room.leave 之后 game.reconnect → 13010（不得把玩家送回他刚主动离开的房间）', async () => {
    // 与 C6 同接线：**真实 resolver** 构建在同一假 redis 上 —— 本用例的因果链就是「真实键被清」，
    // 替身驱动的 13010 在这里等于空转，钉不住「leave 真的清了两把键」。
    const shared = makeRedis();
    const { deps, rooms, game } = makeDeps({
      redis: shared as unknown as Redis,
      reconnect: new ReconnectService(shared as unknown as Redis) as unknown as ReconnectService,
    });
    // 真实前置：匹配成功写入 match:pending，room.join 写入重连记录，房间键存活
    rooms.findOne.mockResolvedValue(roomInfo('ROOM1'));
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'playing', trustees: [false, false, false], version: 4 });
    await shared.hset('match:pending:alice', 'roomCode', 'ROOM1');
    await shared.hset('room:ROOM1', 'status', 'playing');
    await shared.hset(
      RECONNECT_HASH_KEY,
      'alice',
      JSON.stringify({ socketId: 'sock-1', roomCode: 'ROOM1', connectedAt: Date.now() }),
    );

    // 自证前置：没有 room.leave 时同一套键本会命中并恢复快照（否则下面那条 13010 是空转）
    expect((await route(deps, makeSocket('alice'), C('game.reconnect', {}))).code).toBe(0);
    game.view.mockClear();

    await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', { lastVersion: 3 }));

    expect(ack.code).toBe(13010);
    expect(ack.code).not.toBe(12001);
    expect(ack.code).not.toBe(0);
    // 没有命中任何回退路径：既没有 match:pending，也没有重连记录
    expect(await shared.hget('match:pending:alice', 'roomCode')).toBeNull();
    expect(await shared.hget(RECONNECT_HASH_KEY, 'alice')).toBeNull();
    expect(game.view).not.toHaveBeenCalled();
  });

  // ─── game.* 动作 ────────────────────────────────────────────────

  it('game.bid forwards to game-service with the caller identity and baseVersion', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    const ack = await route(deps, makeSocket('alice'), C('game.bid', { grab: true }, { baseVersion: 7 }));

    expect(ack.code).toBe(0);
    expect(game.action).toHaveBeenCalledWith('ROOM1', 'bid', 'alice', { grab: true, baseVersion: 7 });
  });

  it('game.play forwards the cards and baseVersion', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));

    // ⚠️ R697 之后载荷必须是 `Card[]`：`routeClientMessage` 会先过
    // `validateClientMessage`，用裸数字（`[3, 4]`）会**校验失败返回 10001**，
    // 根本走不到转发那一步（实测踩过）。
    await route(deps, makeSocket('alice'), C('game.play', { cards: asCards([3, 4]) }, { baseVersion: 9 }));
    expect(game.action).toHaveBeenCalledWith('ROOM1', 'play', 'alice', {
      cards: asCards([3, 4]),
      baseVersion: 9,
    });
  });

  it('surfaces the downstream error code in the ack (13004 on version conflict)', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.action.mockRejectedValue(new GameServiceError(13004, 'Version conflict'));

    const ack = await route(deps, makeSocket('alice'), C('game.play', { cards: asCards([3]) }, { baseVersion: 1 }));
    expect(ack.code).toBe(13004);
  });

  it('answers 12004 when the player has no active room', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('game.pass', {}));
    expect(ack.code).toBe(12004);
  });

  // ─── game.reconnect（规格 v1.1 §2.3 的四步判定）─────────────────────

  it('① resolver 无命中 → 13010（**不是** 12001），且不取 view', async () => {
    const { deps, game } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', { lastVersion: 1 }));

    expect(ack.code).toBe(13010);
    expect(ack.code).not.toBe(12001);
    expect(game.view).not.toHaveBeenCalled();
  });

  it('① resolver 经 pending 命中 → 按它取快照（code 0）', async () => {
    const { deps, game, reconnect, reconnected } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM2', 'ticket'));
    game.view.mockResolvedValue({ roomCode: 'ROOM2', seat: 1, state: 'playing', trustees: [false, false, false], version: 3 });

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(game.view).toHaveBeenCalledWith('ROOM2', 'alice');
    expect(ack.data).toMatchObject({ roomCode: 'ROOM2', seat: 1, version: 3 });
    expect(reconnected).toHaveLength(1);
  });

  it('重连成功 ⇒ 补发 game.card_counter（ccstate 有行；按 seat 读、version 0）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM2'));
    game.view.mockResolvedValue({
      roomCode: 'ROOM2',
      seat: 1,
      state: 'playing',
      trustees: [false, false, false],
      version: 3,
    });
    await deps.redis.hset(
      ccstateKey('ROOM2'),
      '1',
      JSON.stringify({ active: true, source: 'credit' }),
    );

    const socket = makeSocket('alice');
    const ack = await route(deps, socket, C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(socket.emitted).toContainEqual([
      'game.card_counter',
      { version: 0, payload: { roomCode: 'ROOM2', active: true, source: 'credit' } },
    ]);
  });

  it('C6 单测：陈旧哈希（死房）+ 存活新局（pending）⇒ 拉回**新局**（阻断项回归）', async () => {
    // 真实 resolver 必须构建在 makeDeps 内部的**同一**假 redis 上：先建 redis，再经 over 注入
    const shared = makeRedis();
    await shared.hset(
      RECONNECT_HASH_KEY,
      'alice',
      JSON.stringify({ socketId: 's', roomCode: 'DEAD', connectedAt: Date.now() }),
    );
    await shared.hset('match:pending:alice', 'roomCode', 'ROOM2');
    await shared.hset('room:ROOM2', 'status', 'playing');
    const { deps, game } = makeDeps({
      redis: shared as unknown as Redis,
      reconnect: new ReconnectService(shared as unknown as Redis) as unknown as ReconnectService,
    });
    game.view.mockResolvedValue({ roomCode: 'ROOM2', seat: 1, state: 'playing', trustees: [false, false, false], version: 3 });

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(0);
    expect(game.view).toHaveBeenCalledWith('ROOM2', 'alice');
  });

  it('② 命中但 view 为 ended → 13005，不恢复投递', async () => {
    const { deps, game, reconnect, reconnected } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'ended', version: 22 });

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(13005);
    expect(reconnected).toHaveLength(0);
  });

  it('③ 命中 + view 拿不到 + 房间键在 → 13009（可重试）', async () => {
    const { deps, game, reconnect, rooms } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockResolvedValue(null);
    rooms.findOne.mockResolvedValue(roomInfo('ROOM1'));

    expect((await route(deps, makeSocket('alice'), C('game.reconnect', {}))).code).toBe(13009);
  });

  it('④ 命中 + view 拿不到 + 房间键不存在 → 13010', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockResolvedValue(null);

    expect((await route(deps, makeSocket('alice'), C('game.reconnect', {}))).code).toBe(13010);
  });

  it('⑤ 其余 → code 0 + 当前版本快照 + touch + 恢复投递（§6.6.1 时机 2）', async () => {
    const { deps, game, reconnect, reconnected } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 2, state: 'playing', trustees: [false, false, false], version: 41 });

    // 载荷带 `lastVersion: 7` 而快照是 version 41：`lastVersion` **不参与 CAS**，
    // 一律回当前版本（这正是不加判据的判据 —— 若哪天有人把它接进版本比对，这里先红）。
    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', { lastVersion: 7 }));

    expect(ack.code).toBe(0);
    expect(ack.data).toMatchObject({ roomCode: 'ROOM1', seat: 2, version: 41 });
    expect(reconnect.touch).toHaveBeenCalledWith('alice', expect.anything(), 'ROOM1');
    expect(reconnected).toHaveLength(1);
  });

  it('⑤ 日志里留痕 lastVersion（不参与 CAS，只便于排查）', async () => {
    const { deps, game, reconnect } = makeDeps();
    const logSpy = vi.spyOn(deps.logger, 'log');
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, state: 'playing', trustees: [false, false, false], version: 9 });

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', { lastVersion: 7 }));

    // `lastVersion=7` 在**成功**（Reconnect attempt）与**拒绝**（Reconnect rejected）两条
    // 日志里都出现 ⇒ 单靠它定位不到是哪条；先钉住成功路径（code 0），留痕断言才有判据力。
    expect(ack.code).toBe(0);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('lastVersion=7');
  });

  it('下游 ROOM_NOT_FOUND → 13010，**绝不是** 12001（缺陷 B-c）', async () => {
    const { deps, game, reconnect, rooms } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockRejectedValue(new GameServiceError(12001, 'Game not found'));
    rooms.findOne.mockResolvedValue(null);

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(13010);
    expect(ack.code).not.toBe(12001);
  });

  it('下游 12004（不在该局）也算「找不到可恢复的对局」→ 13010', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockRejectedValue(new GameServiceError(12004, 'You are not in this game'));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(13010);
  });

  it('真·下游故障（10007）如实上抛，不得伪装成 13010', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
    game.view.mockRejectedValue(new GameServiceError(10007, 'game-service unavailable'));

    const ack = await route(deps, makeSocket('alice'), C('game.reconnect', {}));

    expect(ack.code).toBe(10007);
  });

  it('game.resync returns the current trimmed snapshot (§6.5, the 13004 recovery channel)', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, version: 8 });

    const ack = await route(deps, makeSocket('alice'), C('game.resync', {}));
    expect(ack.code).toBe(0);
    expect(ack.data).toMatchObject({ roomCode: 'ROOM1', version: 8 });
    expect(game.action).not.toHaveBeenCalled();
  });

  it('game.resync falls back to match:pending when the player has not joined yet', async () => {
    // 该语义现由 resolver 承担：**真实 resolver**（与 C6 同接线）在同一假 redis 上按存活谓词择优
    const shared = makeRedis();
    await shared.hset('match:pending:alice', 'roomCode', 'ROOM2');
    await shared.hset('room:ROOM2', 'status', 'playing');
    const { deps, game } = makeDeps({
      redis: shared as unknown as Redis,
      reconnect: new ReconnectService(shared as unknown as Redis) as unknown as ReconnectService,
    });
    game.view.mockResolvedValue({ roomCode: 'ROOM2', seat: 1, version: 3 });

    const ack = await route(deps, makeSocket('alice'), C('game.resync', {}));
    expect(ack.code).toBe(0);
    expect(game.view).toHaveBeenCalledWith('ROOM2', 'alice');
    expect(ack.data).toMatchObject({ roomCode: 'ROOM2' }); // 拉回的是 pending 指的房
  });

  it('game.resync answers 12004 when there is no active game', async () => {
    const { deps } = makeDeps();
    const ack = await route(deps, makeSocket('alice'), C('game.resync', {}));
    expect(ack.code).toBe(12004);
  });

  it('§6.5：game.resync 是 13004 的唯一恢复通道，与 game.reconnect 语义不同', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, version: 8 });

    const ack = await route(deps, makeSocket('alice'), C('game.resync', {}));

    expect(ack.code).toBe(0);
    // resync 定位走 resolver、只重新拉快照：不 touch 重连记录、不恢复投递（那些是 game.reconnect 独有的）
    expect(reconnect.touch).not.toHaveBeenCalled();
  });

  it('game.resync 也补发 game.card_counter（ccstate 有行；三条补发路径之三）', async () => {
    const { deps, game, reconnect } = makeDeps();
    reconnect.resolveRecoverableRoom.mockResolvedValue(hit('ROOM1'));
    game.view.mockResolvedValue({ roomCode: 'ROOM1', seat: 0, version: 8 });
    await deps.redis.hset(
      ccstateKey('ROOM1'),
      '0',
      JSON.stringify({ active: true, source: 'pass' }),
    );

    const socket = makeSocket('alice');
    const ack = await route(deps, socket, C('game.resync', {}));

    expect(ack.code).toBe(0);
    expect(socket.emitted).toContainEqual([
      'game.card_counter',
      { version: 0, payload: { roomCode: 'ROOM1', active: true, source: 'pass' } },
    ]);
  });

  // ── Task 3c 修复 1：WS 边界的错误码映射（与 HTTP 面 `toHttpException` 对称）─────
  //
  // **为什么必须有这一组**：catch 此前只翻译 `GameServiceError`，其余一律 `13001` +
  // **原样透传的内部消息**。Task 3b 之后 `room.match` 有两条新可达路径：
  //  ① 非法底分（`DomainError(BAD_PARAM)`）—— 用户可见文案恰好正确，只有**数字码**不精确；
  //  ② 档位表读不到（`ConfigServiceError`）—— 消息是 `user-service unavailable: <详情>`，
  //     它会当 **toast 弹给玩家**。
  //
  // ⚠️ 这一支改的是**所有** WS DomainError（不只上面两条）⇒ 既有路径也逐个钉住：
  //  · `room.leave` 的 `leaveSeat` 撞上「房间在读与写之间被删」⇒ `ROOM_NOT_FOUND`
  //    （修前 13001 + '房间不存在' ⇒ 现在是 **12001**）；
  //  · 其余 `room.*` / `game.*` 分支逐条核过：`findOne` / `resetWaitingWindow` /
  //    `cancelQueue` / `readMeta` / `touch` / `clearConnection` 都**不抛** DomainError，
  //    `game.*` 抛的是 `GameServiceError`（本来就有自己的分支）⇒ 受影响的只有上面三条。
  describe('WS 边界错误码映射（Task 3c 修复 1）', () => {
    /** 真实 `MatchService` 接在同一套替身上：`room.match` 的**整条链**都真跑。 */
    function realMatchDeps() {
      const made = makeDeps();
      const configCache = makeConfigCache(); // 真档位（15/80/480/1200）
      const match = new MatchService(
        made.redis,
        made.rooms as unknown as RoomsService,
        made.roomStart as unknown as RoomStartService,
        asConfigCache(configCache),
        // 片② D5（Task 6）：可用性门禁的注入点。本组用例只走 `room.match`（不跑扫描）
        // ⇒ 这条 RPC 不会被发出；假 proxy 会抛 ⇒ 万一被发出，fail-open 也一样不崩。
        new RobotClient({
          send: () => throwError(() => new Error('robot-service not reachable in this test')),
        } as never),
      );
      return { ...made, configCache, realMatch: match };
    }

    it('🔴 非法底分（DomainError BAD_PARAM，Task 3b 新增路径）⇒ ack 10001，不是 13001', async () => {
      const { deps, realMatch } = realMatchDeps();

      const ack = await route(
        { ...deps, match: realMatch },
        makeSocket('alice'),
        C('room.match', { mode: 'random', baseScore: 999 }),
      );

      expect(ack.code).toBe(ErrCode.BAD_PARAM); // 10001：与 HTTP 面 `toHttpException` 同码
      expect(ack.message).toBe('底分不属于档位表'); // DomainError 的消息是**面向调用方**的
    });

    it('🔴 档位表读不到（UPSTREAM_UNAVAILABLE，Task 3b 新增路径）⇒ ack 10007，且**不得**带内部详情', async () => {
      const { deps, realMatch, configCache } = realMatchDeps();
      configCache.baseScoreLevels.mockRejectedValue(
        new Error('user-service unavailable: connect ECONNREFUSED 172.28.0.9:3100'),
      );

      const ack = await route(
        { ...deps, match: realMatch },
        makeSocket('alice'),
        C('room.match', { mode: 'random', baseScore: 15 }),
      );

      expect(ack.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE); // 10007
      // 🔴 这条是**用户裁决**的那半边：`user-service unavailable: <详情>` 修前会被当 toast
      // 弹给玩家。详情只许进服务端日志（`MatchService` 的 warn 行）。
      expect(ack.message ?? '').not.toContain('ECONNREFUSED');
      expect(ack.message ?? '').not.toContain('user-service');
    });

    it('🔴 未知异常仍是 13001，但**内部详情只进日志**（不得原样当 ack.message）', async () => {
      const logs: string[] = [];
      const logger = {
        log: vi.fn(),
        warn: vi.fn((m: string) => logs.push(m)),
        error: vi.fn((m: string) => logs.push(m)),
      };
      const { deps, match } = makeDeps({ logger: logger as unknown as Logger });
      match.addToQueue.mockRejectedValue(
        new Error('ECONNREFUSED 172.28.0.5:3306 — internal topology leaked'),
      );

      const ack = await route(deps, makeSocket('alice'), C('room.match', { mode: 'random', baseScore: 15 }));

      expect(ack.code).toBe(13001);
      expect(ack.message ?? '').not.toContain('ECONNREFUSED');
      expect(ack.message ?? '').not.toContain('172.28.0.5');
      // 反面：留痕 —— 详情必须**进日志**（否则「不透传」会连排障线索一起修掉）
      expect(logs.join('\n')).toContain('172.28.0.5');
    });

    it('既有路径：room.leave 的 leaveSeat 撞上房间已被删（ROOM_NOT_FOUND）⇒ ack 12001（修前 13001）', async () => {
      const { deps, rooms } = makeDeps();
      rooms.findOne.mockResolvedValue(roomInfo('ROOM1'));
      rooms.leaveSeat.mockRejectedValue(new DomainError(ErrCode.ROOM_NOT_FOUND, '房间不存在'));

      const ack = await route(deps, makeSocket('alice'), C('room.leave', { roomCode: 'ROOM1' }));

      expect(ack.code).toBe(ErrCode.ROOM_NOT_FOUND); // 12001
      expect(ack.code).not.toBe(13001);
    });

    /**
     * 🔴 **Task 3g 修复 I2 的端到端半边**（真 `GameClient`，不只是 mock 一个 GameServiceError）。
     *
     * 修前 `GameClient.call()` 在传输故障下抛的消息是 `` `game-service unavailable: ${reason}` ``，
     * 而 `reason` 是 `ECONNREFUSED 172.28.0.7:3002` 这类**内部拓扑** ⇒ 本支（照实 ack）
     * 把它当 toast 弹给玩家。修后：码仍是 10007，消息是固定文案。
     *
     * 用**真** client 而不是 mock 的理由：这条链的两半（`game.client` 的构造 + `message.router`
     * 的 ack）正是缺陷发生的地方，mock 掉任何一半都测不到「消息原样透传」这个接缝。
     */
    it('🔴 传输层故障（真 GameClient + 假 ClientProxy）⇒ ack 10007 且消息里没有内部详情', async () => {
      const made = makeDeps();
      made.reconnect.resolveRecoverableRoom.mockResolvedValue(hit());
      const realGame = new GameClient({
        send: () => throwError(() => new Error('ECONNREFUSED 172.28.0.7:3002')),
      } as never);

      const ack = await route(
        { ...made.deps, game: realGame },
        makeSocket('alice'),
        C('game.resync', {}),
      );

      expect(ack.code).toBe(ErrCode.UPSTREAM_UNAVAILABLE); // 10007 —— 不是 13001
      expect(ack.message).toBe(TRANSPORT_FAILURE_MESSAGE);
      expect(ack.message ?? '').not.toContain('ECONNREFUSED');
      expect(ack.message ?? '').not.toContain('172.28.0.7');
    });
  });

  // ── 判据 6′：WS 消息入口包 ALS（连接级 traceId + 消息级 reqId）─────────
  //
  // spec §3 的载体表：WS 消息是「`socket.data.traceId`（连接级，来自网关握手
  // `auth.traceId`）+ 消息自带 `reqId`」，在**消息入口一处**（`message.router.ts`）
  // `als.run` 包住处理（这与复核⑦ 是一对：网关侧生成点上移后，两侧的行才是同一个 id）。
  //
  // 观测口：Nest 的全局 logger 是**进程级**的 —— `Logger.overrideLogger` 装一个捕获
  // sink，服务自己 `new Logger(...)` 打的行（含 `deps.logger`）就全部进来，
  // 不需要真去抓 stdout（`createCapturingSink` 就是为此而生的）。
  describe('判据 6′：WS 消息入口包 ALS', () => {
    it('判据 6′：WS 消息处理期间的日志带连接级 traceId + 消息级 reqId', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

      const { deps } = makeDeps();
      const sock = makeSocket('U1', { traceId: 'CONN1' });
      // ⚠️ 请求体**刻意不含 `timestamp`**（与 brief 逐字同形）⇒ `validateClientMessage` 拒绝。
      // 「处理一条消息期间」**包含被拒的处理**：`Rejected malformed client message` 恰是最需要
      // reqId 的行（排障第一问是「这条 reqId 为什么被拒」）⇒ 它必须带上下文。
      // 这也是「ALS 包住**整条消息**（含校验），而不是只包住 dispatch」的机械判据：
      // 把包裹点挪进 dispatch 的那一侧，本用例就红。
      await route(deps, sock, {
        type: 'room.join',
        body: { reqId: 'REQ1', baseVersion: 0, payload: { roomCode: 'AAA111' } },
      });

      expect(records.some((r) => r.traceId === 'CONN1' && r.reqId === 'REQ1')).toBe(true);
    });

    /**
     * **判据 13①**（最终评审 I1）：`reqId` 是客户端可控的 ⇒ **ALS 边界**必须限长。
     *
     * 为什么必须有：engine.io 单帧上限 1MB × 限流 20 条/5s ⇒ 单连接 ≈4MB/s ⇒
     * `max-size: 10m × max-file: 5`（≈50MB）十几秒就被冲掉 —— 把本片「日志有上限」
     * 的目的**反过来用**（对手拿不到任何数据，却抹掉了排障现场）。
     */
    it('判据 13①：超长 `reqId`（5000 字符，客户端可控）⇒ 记录里被截断到 64', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

      const { deps } = makeDeps();
      const sock = makeSocket('U1', { traceId: 'CONN1' });
      const ack = await route(deps, sock, C('room.match', { mode: 'random', baseScore: 15 }, { reqId: 'x'.repeat(5000) }));

      expect(ack.code).toBe(0);
      const queued = records.find((r) => r.msg.includes('queued for random match'));
      expect(queued, '业务成功路径的日志必须在（否则这条判据是空转）').toBeDefined();
      expect(queued!.reqId).not.toBeNull();
      expect(queued!.reqId!.length).toBe(REQ_ID_MAX_LENGTH);
      // 正对照的一半：截断的是**尾部**（前 64 个字符逐字保留 ⇒ 排障时前缀仍可辨认）。
      expect(queued!.reqId).toBe('x'.repeat(REQ_ID_MAX_LENGTH));
    });

    /**
     * **判据 13② 的 WS 侧半边**（最终评审 I1）：手机号 / JWT 形状的 `reqId` 从
     * **真实消息入口**进来时，落盘的记录里必须是脱敏后的形态 ——
     * 于是**判据 8 的泄敏采样**（扫五个服务的真实 NDJSON 行）不可能被这条路径打红。
     */
    it('判据 13②：`reqId` 里的手机号 / JWT 形状 ⇒ 记录里是脱敏形态（判据 8 因此不可被它打红）', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

      const { deps } = makeDeps();
      const phoneSock = makeSocket('U1', { traceId: 'CONN1' });
      await route(deps, phoneSock, C('room.match', { mode: 'random', baseScore: 15 }, { reqId: '13912345678' }));
      const jwtSock = makeSocket('U2', { traceId: 'CONN2' });
      await route(deps, jwtSock, C('room.match', { mode: 'random', baseScore: 15 }, {
        reqId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefgh',
      }));

      expect(records.map((r) => r.reqId)).toEqual(
        expect.arrayContaining(['139****5678', '[REDACTED_JWT]']),
      );
      // 判据 8 的两条模式（原文见 `tools/conformance/src/slices/slice-12-manual-join.ts`）：
      for (const line of records.map((r) => JSON.stringify(r))) {
        expect(line).not.toMatch(/\b1[3-9]\d{9}\b/);
        expect(line).not.toMatch(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/);
      }
    });

    it('判据 6′（正对照）：处理**成功**的业务消息，日志同样带两个 id', async () => {
      const { sink, records } = createCapturingSink();
      Logger.overrideLogger(createRedactingLogger(sink, { service: 'room-service' }));

      const { deps } = makeDeps();
      const sock = makeSocket('U1', { traceId: 'CONN1' });
      const ack = await route(deps, sock, C('room.match', { mode: 'random', baseScore: 15 }, { reqId: 'REQ1' }));

      expect(ack.code).toBe(0);
      // `handleMatch` 成功路径会写一条业务日志 —— 判据落在**它**上面（而不是只落在拒绝路径）。
      const queued = records.find((r) => r.msg.includes('queued for random match'));
      expect(queued, '业务成功路径的日志必须在（否则这条判据是空转）').toBeDefined();
      expect(queued!.traceId).toBe('CONN1');
      expect(queued!.reqId).toBe('REQ1');
      expect(queued!.userId).toBe('U1');
    });
  });
});
