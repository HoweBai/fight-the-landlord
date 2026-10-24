import 'reflect-metadata';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Seat } from '@fight-the-landlord/protocol';
import { RoomsService, toRoomInfo, type Room } from '../src/rooms/rooms.service';
import { fillAtKey, roomBalancesKey, seatsKey, ROOM_TTL_SECONDS } from '../src/rooms/rooms.seats';
import { MANUAL_FILL_MIN_WAIT_MS, MANUAL_ROOM_TIMEOUT_MS } from '../src/rooms/rooms.timeout';
import { createFakeRedis, asRedis, type FakeRedis } from './helpers/fake-redis';
import { asConfigCache, makeConfigCache } from './helpers/config-cache.stub';
import { seat, seatsOf } from './helpers/room-fixture';

/** 内部 `Room` 的最小工厂（§3.1 形状）。 */
const room = (over: Partial<Room> = {}): Room => ({
  code: 'AAA111',
  mode: 'random',
  baseScore: 15,
  players: [],
  maxPlayers: 3,
  status: 'waiting',
  createdAt: Date.now(),
  timeoutAt: Date.now() + 30_000,
  ...over,
});

describe('RoomsService（§3.1 / §10.1 / §10.2 / R124–R128）', () => {
  let service: RoomsService;
  let redis: FakeRedis;
  let cache: ReturnType<typeof makeConfigCache>;

  beforeEach(() => {
    redis = createFakeRedis();
    cache = makeConfigCache();
    service = new RoomsService(asRedis(redis), asConfigCache(cache));
  });

  it('create 的持久化元数据是 **Hash**、不含 players（R124 + N9）', async () => {
    const created = await service.create({ mode: 'random', roomCode: 'NEW001' });
    // §10.1：`room:{code}` 是 **Hash**（N9）——它不得再是 String(JSON)
    expect(redis.strings.has('room:NEW001'), 'room:{code} 仍是 String —— §10.1 要求 Hash').toBe(false);
    const stored = redis.hashes.get('room:NEW001')!;
    expect(created.players).toEqual([]);
    expect('players' in stored).toBe(false);
    // 元数据键的 TTL 现在来自 writeMeta 里**显式**的 `expire()`（Hash 不继承任何 TTL）
    expect(redis.ttls.get('room:NEW001')).toBe(ROOM_TTL_SECONDS);
    expect(await redis.ttl('room:NEW001')).toBe(ROOM_TTL_SECONDS);
  });

  it('N9：room:{code} 的字段**恰好** 8 个（§10.1 + 多玩法 gameType），且每个值都是字符串', async () => {
    const created = await service.create({ mode: 'random' });
    const key = `room:${created.code}`;
    const hash = redis.hashes.get(key)!;
    expect(hash, 'room:{code} 不是 Hash').toBeDefined();
    expect(Object.keys(hash).sort()).toEqual(
      ['baseScore', 'code', 'createdAt', 'gameType', 'maxPlayers', 'mode', 'status', 'timeoutAt'].sort(),
    );
    for (const [field, value] of Object.entries(hash)) {
      expect(typeof value, `${field} 必须是字符串`).toBe('string');
    }
    // 判别力：多一个字段（例如把 players 塞回来）必须让上面那条红
    expect(Object.keys({ ...hash, players: '[]' }).length).toBe(9);
  });

  it('N9/E6：读回时类型必须还原（Number 字段不得变字符串）', async () => {
    const created = await service.create({ mode: 'random' });
    const room = await service.findOne(created.code);

    expect(typeof room!.baseScore).toBe('number');
    expect(typeof room!.maxPlayers).toBe('number');
    expect(typeof room!.createdAt).toBe('number');
    expect(typeof room!.timeoutAt).toBe('number');
    expect(room!.timeoutAt).toBeGreaterThan(room!.createdAt);
    expect(room!.code).toBe(created.code);
    expect(room!.mode).toBe('random');
    expect(room!.status).toBe('waiting');
  });

  it('create 补上 RoomInfo 需要的 baseScore，且 createdAt 是 number（§3.1）', async () => {
    const created = await service.create({ mode: 'practice', roomCode: 'META01' });
    const stored = redis.hashes.get('room:META01')!;

    expect(created.baseScore).toBe(15);
    expect(typeof created.createdAt).toBe('number');
    // Hash 里一律是字符串（§10.1），读回时由 readMeta 还原成 number
    expect(stored.baseScore).toBe('15');
    expect(Number(stored.createdAt)).toBe(created.createdAt);
  });

  it('join 走 HSETNX 原子占座（§10.2）：不做 GET→改→SET，也不用 HSET 覆盖座位字段', async () => {
    await service.create({ mode: 'random', roomCode: 'JOIN01' });
    const joined = await service.join('JOIN01', 'user-1');

    expect(joined.players).toEqual([seat('user-1', 0)]);
    expect(redis.hsetnx).toHaveBeenCalledWith('room:JOIN01:seats', '0', JSON.stringify(seat('user-1', 0)));
    // 反向断言：**座位键**的字段写入只允许 HSETNX（HSET 会顶掉别人已占的座位）。
    // ⚠️ 必须**按键**过滤：元数据 Hash（`room:JOIN01`）的写入本来就是 HSET（N9）。
    expect(redis.hset.mock.calls.filter(([key]) => key === seatsKey('JOIN01'))).toEqual([]);
    // 占座给的座位键带 §10.1 的 TTL
    expect(redis.ttls.get(seatsKey('JOIN01'))).toBe(ROOM_TTL_SECONDS);
  });

  it('好友房（practice）按玩法闸拒绝；匹配房 join 不受好友房闸影响', async () => {
    cache.paodekuaiEnabled.mockReturnValue(true);
    cache.friendRoomEnabled.mockImplementation((gameType: unknown) => gameType === 'paodekuai');
    await service.create({ mode: 'practice', roomCode: 'FRI001', gameType: 'doudizhu' });
    await expect(service.join('FRI001', 'u1', 'doudizhu')).rejects.toThrow('好友房暂未开放');

    await service.create({ mode: 'practice', roomCode: 'FRI002', gameType: 'paodekuai' });
    await expect(service.join('FRI002', 'u1', 'paodekuai')).resolves.toMatchObject({
      code: 'FRI002',
    });

    await service.create({ mode: 'random', roomCode: 'RND001', gameType: 'doudizhu' });
    await expect(service.join('RND001', 'u1', 'doudizhu')).resolves.toMatchObject({
      code: 'RND001',
    });
  });

  it('重复 join 同一 userId → 原座位、人数不变（R126；旧实现会 push 两次）', async () => {
    await service.create({ mode: 'random', roomCode: 'JOIN01' });
    await service.join('JOIN01', 'user-1');
    const again = await service.join('JOIN01', 'user-1');

    expect(again.players).toEqual([seat('user-1', 0)]);
    expect(await service.findOne('JOIN01')).toMatchObject({ players: [seat('user-1', 0)] });
  });

  it('第 4 人 → 12002，且**不占用任何座位**（HLEN 仍为 3）', async () => {
    await service.create({ mode: 'random', roomCode: 'FULL01' });
    await service.join('FULL01', 'user-1');
    await service.join('FULL01', 'user-2');
    await service.join('FULL01', 'user-3');
    await expect(service.join('FULL01', 'user-4')).rejects.toThrow('房间已满');
    expect(Object.keys(redis.hashes.get(seatsKey('FULL01'))!).sort()).toEqual(['0', '1', '2']);
  });

  it('join to non-existent room throws', async () => {
    await expect(service.join('NONEXIST', 'user-1')).rejects.toThrow('房间不存在');
  });

  it('空位存在但已开局 → 12008（R127 的顺序）', async () => {
    await service.create({ mode: 'random', roomCode: 'PLAY01' });
    await service.updateStatus('PLAY01', 'playing');
    await expect(service.join('PLAY01', 'user-1')).rejects.toThrow('游戏已开始');
  });

  it('addBot 用 isRobot: true 占**下一个**空位', async () => {
    await service.create({ mode: 'random', roomCode: 'BOT001' });
    await service.join('BOT001', 'user-1');
    const withBot = await service.addBot('BOT001', 'bot-abc');
    expect(withBot.players).toEqual([seat('user-1', 0), seat('bot-abc', 1, true)]);
  });

  it('createGameRoom 原子坐满人类（isRobot: false）且元数据不含 players', async () => {
    // 片规格 §2.4：底分随队列进来 ⇒ 这里显式给一档真档位（校验由 `create()` 统一承担）
    const created = await service.createGameRoom(['u1', 'u2'], 'random', 15);
    expect(created.players).toEqual(seatsOf('u1', 'u2'));
    expect('players' in (redis.hashes.get(`room:${created.code}`) ?? {})).toBe(false);
    expect(Object.keys(redis.hashes.get(seatsKey(created.code))!).sort()).toEqual(['0', '1']);
  });

  /**
   * `leaveSeat`（本片 · spec §3.5 / R906 / R916）—— 退房**真的腾出座位**。
   *
   * 为什么必须有它：本片引入「满即开局 / 不足则补机器人」之后，
   * **漏座的 `3/3` 房间会永远开不了局**（满分支不触发：人早走了；不足分支也不触发：
   * 座位数说满了）。而 MVP 没有踢人，所以「自己退房」是**唯一**的离开方式 ⇒ 它必须能腾座位。
   */
  describe('leaveSeat：退房腾座位（对称于 claimSeat）', () => {
    it('腾出座位：playerCount 减 1，且**只删自己那一格**', async () => {
      await service.create({ mode: 'practice', roomCode: 'LEAV01' });
      await service.join('LEAV01', 'user-1');
      await service.join('LEAV01', 'user-2');

      const after = await service.leaveSeat('LEAV01', 'user-1');

      expect(after.players).toEqual([seat('user-2', 1)]);
      expect(await service.findOne('LEAV01')).toMatchObject({ players: [seat('user-2', 1)] });
    });

    it('幂等：没坐过 / 连走两次 —— 都不抛、也不动别人的座位', async () => {
      await service.create({ mode: 'practice', roomCode: 'LEAV01' });
      await service.join('LEAV01', 'user-2');

      await expect(service.leaveSeat('LEAV01', 'user-9')).resolves.toBeDefined(); // 没坐过
      await service.leaveSeat('LEAV01', 'user-2');
      const again = await service.leaveSeat('LEAV01', 'user-2'); // 再走一次

      expect(again.players).toEqual([]);
    });

    it('腾座位后原座位**可被别人占**（HSETNX 能重新写进去）', async () => {
      await service.create({ mode: 'practice', roomCode: 'LEAV01' });
      await service.join('LEAV01', 'user-1');
      await service.leaveSeat('LEAV01', 'user-1');

      const rejoin = await service.join('LEAV01', 'user-3');

      expect(rejoin.players).toEqual([seat('user-3', 0)]); // 拿回被腾出来的 0 号位
    });

    it('房间不存在 → 12001（与 join 同形的前置检查）', async () => {
      await expect(service.leaveSeat('NONEXIST', 'user-1')).rejects.toThrow('房间不存在');
    });

    /**
     * 🔴 R916：**对局中一律不动座位**。
     *
     * `room.leave` 是**两种离开**共用的：`waiting` 房里是「我不等了」（该腾座位），
     * `playing` 房里是「我不玩了」（**不得**动座位 —— 座位的真源是对局）。
     * 动它会让 `game-service` 的座位映射与 `room.players` **分叉**（R124 警告的漂移形态）。
     * 负对照：**同一房间**在 `waiting` 时会腾、转 `playing` 后不腾。
     */
    it('status !== waiting ⇒ 不腾座位（R916：对局中离开不改变座位）', async () => {
      await service.create({ mode: 'practice', roomCode: 'PLAY01' });
      await service.join('PLAY01', 'user-1');
      await service.join('PLAY01', 'user-2');

      // 正对照：还在 waiting ⇒ 腾
      const whileWaiting = await service.leaveSeat('PLAY01', 'user-1');
      expect(whileWaiting.players).toEqual([seat('user-2', 1)]);

      await service.updateStatus('PLAY01', 'playing');
      const whilePlaying = await service.leaveSeat('PLAY01', 'user-2');

      expect(whilePlaying.players, '对局中离开不得腾座位').toEqual([seat('user-2', 1)]);
    });
  });

  /**
   * 补位死线的**落盘**（本片 · spec §3.1 / R904b）。
   *
   * ⚠️ 为什么必须落盘而不是每次扫描现抽：现抽会让**同一个房间每一轮抽到不同的死线**
   * ⇒ 玩家等多久取决于它被扫到几次（行为非确定），而且判据不可判。
   */
  /**
   * `cancelIfStillWaiting`（本片 · spec §2 / R1002）—— **真原子 CAS**。
   *
   * 修的是什么：`updateStatus()` 是「读 → 写」两步、**中间有真实 await** ⇒ 在
   * 「判 `waiting`」与「写 `cancelled`」之间，另一个定时器可以把房间推进到 `playing`
   *（`startRoom` 只认 `waiting`，它**会**赢这一场）⇒ 随后 `cancelled` 覆盖上去
   * ⇒ **房间变终态、玩家还坐在里面**。
   *
   * ⚠️ **单实例即可命中**（两个定时器交错），不是多实例专属。
   * ⚠️ 这里只验证**脚本语义**；**原子性**在假 Redis 上不可证（它没有「交错」这个可能）
   * —— 那一条落在真 Redis（conformance，见 spec §6.1）。
   */
  describe('cancelIfStillWaiting：真原子 CAS（只从 waiting 取消）', () => {
    it('正对照：waiting ⇒ 返回 true、状态变 cancelled、timeoutAt 归零', async () => {
      await service.create({ mode: 'practice', roomCode: 'CAS001' });
      expect((await service.findOne('CAS001'))!.timeoutAt).toBeGreaterThan(0);

      const changed = await service.cancelIfStillWaiting('CAS001');

      expect(changed).toBe(true);
      const after = (await service.findOne('CAS001'))!;
      expect(after.status).toBe('cancelled');
      expect(after.timeoutAt, 'E6：离开 waiting ⇒ 窗口关闭、时刻归零').toBe(0);
    });

    it('🔴 负对照：playing ⇒ 返回 false，且状态与时刻**一格未动**', async () => {
      await service.create({ mode: 'practice', roomCode: 'CAS002' });
      await service.updateStatus('CAS002', 'playing');

      const changed = await service.cancelIfStillWaiting('CAS002');

      expect(changed, '对局中的房间不得被取消').toBe(false);
      const after = (await service.findOne('CAS002'))!;
      expect(after.status).toBe('playing');
      expect(after.timeoutAt).toBe(0); // 仍是「窗口已关闭」，没被改写
    });

    it('负对照：finished / cancelled 同形（不得把终态改回来）', async () => {
      for (const status of ['finished', 'cancelled'] as const) {
        const code = `CAS00${status === 'finished' ? '3' : '4'}`;
        await service.create({ mode: 'practice', roomCode: code });
        await service.updateStatus(code, status);

        expect(await service.cancelIfStillWaiting(code)).toBe(false);
        expect((await service.findOne(code))!.status).toBe(status);
      }
    });

    it('边界：房间不存在 ⇒ false（**不抛** —— 调用方是降级路径，不该因此崩）', async () => {
      await expect(service.cancelIfStillWaiting('NOPE01')).resolves.toBe(false);
    });

    it('不变量：CAS 之后 `room:{code}` 仍是**恰好八个**字段（不得引入新字段）', async () => {
      await service.create({ mode: 'practice', roomCode: 'CAS005' });

      await service.cancelIfStillWaiting('CAS005');

      expect(Object.keys(redis.hashes.get('room:CAS005')!).sort()).toEqual(
        ['baseScore', 'code', 'createdAt', 'gameType', 'maxPlayers', 'mode', 'status', 'timeoutAt'].sort(),
      );
    });
  });

  describe('fillat：补位死线的派生键', () => {
    it('写入 / 读回；且带 §10.1 的 TTL（与房间同寿命）', async () => {
      await service.create({ mode: 'practice', roomCode: 'FILL01' });

      await service.setFillDeadline('FILL01', 123_456);

      expect(await service.readFillDeadline('FILL01')).toBe(123_456);
      expect(redis.ttls.get(fillAtKey('FILL01'))).toBe(ROOM_TTL_SECONDS);
    });

    it('没写过 ⇒ null（不是 0、也不是抛错）', async () => {
      await service.create({ mode: 'practice', roomCode: 'FILL01' });
      expect(await service.readFillDeadline('FILL01')).toBeNull();
    });

    it('deleteRoom 把它**一起删掉**（否则回收后留孤儿键 —— N31 的形态）', async () => {
      await service.create({ mode: 'practice', roomCode: 'FILL01' });
      await service.setFillDeadline('FILL01', 1);

      await service.deleteRoom('FILL01');

      expect(await service.readFillDeadline('FILL01')).toBeNull();
      expect(redis.strings.has(fillAtKey('FILL01'))).toBe(false);
    });

    /**
     * ② 金币场 T5：`room:{code}:balances`（开局三座余额的派生键）也必须进删除集 ——
     * 与上面的 `fillat` **同一条理由**（留孤儿键 = 看不见也回收不到，只能等 TTL）。
     */
    it('deleteRoom 也把 balances 派生键一起删掉（② T5）', async () => {
      await service.create({ mode: 'gold', roomCode: 'BAL01' });
      await redis.hset(roomBalancesKey('BAL01'), { '0': '12345', '1': '6789' });
      // 正对照：键确实在（否则「删除后不存在」是空测）
      expect(redis.hashes.has(roomBalancesKey('BAL01'))).toBe(true);

      await service.deleteRoom('BAL01');

      expect(redis.hashes.has(roomBalancesKey('BAL01'))).toBe(false);
    });
  });

  /**
   * 占用变化 ⇒ **重置等待窗口**（本片 · spec §3.1 / R904）。
   *
   * ⚠️ 随机源注入（`setRandom(() => 0)`）才能**判死线的具体值** —— 否则这条只能判「变过」。
   */
  describe('resetWaitingWindow：占用变化后重抽死线 + 重写回收窗口', () => {
    const T0 = 1_700_000_000_000;

    it('waiting 房：两个时刻都被重写（死线 = now + 20s + rand，回收 = now + 40s）', async () => {
      await service.create({ mode: 'practice', roomCode: 'WIND01' }, { timeoutMs: 1_000 });
      service.setRandom(() => 0); // 注入随机源 ⇒ 死线**可判**（否则只能判「变过」）
      service.setClock(() => T0); // 注入时钟 ⇒ 断言的是**值**，不是「比刚才大」

      await service.resetWaitingWindow('WIND01');

      const after = await service.findOne('WIND01');
      expect(after!.timeoutAt).toBe(T0 + MANUAL_ROOM_TIMEOUT_MS);
      expect(await service.readFillDeadline('WIND01')).toBe(T0 + MANUAL_FILL_MIN_WAIT_MS);
      // 硬不变量：补位**永远早于**回收（10 秒余量留给「补位 + game.start」）
      expect((await service.readFillDeadline('WIND01'))!).toBeLessThan(after!.timeoutAt);
    });

    it('负对照：playing 房一律不动（R916：等待窗口已关闭，不得复活）', async () => {
      await service.create({ mode: 'practice', roomCode: 'WIND02' });
      await service.updateStatus('WIND02', 'playing');
      await service.setFillDeadline('WIND02', 42);

      await service.resetWaitingWindow('WIND02');

      expect((await service.findOne('WIND02'))!.timeoutAt).toBe(0); // 仍是「窗口已关闭」
      expect(await service.readFillDeadline('WIND02')).toBe(42);    // 死线一字未动
    });

    it('房间没了 ⇒ 无声返回（不抛）', async () => {
      await expect(service.resetWaitingWindow('NONEXIST')).resolves.toBeUndefined();
    });
  });

  it('findOne 从 Hash 投影并按 seat 升序（Hash 字段顺序不是契约）', async () => {
    await service.create({ mode: 'random', roomCode: 'ORD001' });
    redis.hashes.set(seatsKey('ORD001'), {
      '2': JSON.stringify(seat('c', 2)),
      '0': JSON.stringify(seat('a', 0)),
      '1': JSON.stringify(seat('b', 1)),
    });
    expect((await service.findOne('ORD001'))!.players).toEqual(seatsOf('a', 'b', 'c'));
  });

  it('updateStatus 不丢座位，且**不把 players 写回元数据**（R124：调用方传的是 Room，必须显式投影）', async () => {
    await service.create({ mode: 'random', roomCode: 'UPD001' });
    await service.join('UPD001', 'user-1');
    const started = await service.updateStatus('UPD001', 'playing');

    expect(started.status).toBe('playing');
    expect(started.players).toEqual([seat('user-1', 0)]);
    expect((await service.findOne('UPD001'))!.players).toEqual([seat('user-1', 0)]);

    // 关键：updateStatus 收到的是含 players 的 Room，落盘时**必须**被剥掉
    const stored = redis.hashes.get('room:UPD001')!;
    expect('players' in stored).toBe(false);
    expect(stored).toMatchObject({ code: 'UPD001', status: 'playing', maxPlayers: '3' });
    // E6：离开 waiting ⇒ timeoutAt 归零
    expect(stored.timeoutAt).toBe('0');
  });

  it('findAll 用 SCAN、排除 room:{code}:seats 派生键、playerCount 来自 seats', async () => {
    await service.create({ mode: 'random', roomCode: 'AAA111' });
    await service.join('AAA111', 'u1');
    await service.create({ mode: 'practice', roomCode: 'BBB222' });
    await service.updateStatus('BBB222', 'cancelled');
    redis.scan.mockResolvedValue(['0', ['room:AAA111', 'room:AAA111:seats', 'room:BBB222']]);

    const all = await service.findAll();
    expect(redis.keys).not.toHaveBeenCalled();
    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'room:*', 'COUNT', 100);
    expect(all.map((r) => r.code)).toEqual(['AAA111']); // cancelled 不进列表
    expect(all[0]!.players).toEqual(seatsOf('u1'));
  });

  it('findAll 走完游标（cursor 非 0 时继续扫）', async () => {
    await service.create({ mode: 'random', roomCode: 'AAA111' });
    await service.create({ mode: 'random', roomCode: 'CCC333' });
    redis.scan
      .mockResolvedValueOnce(['17', ['room:AAA111']])
      .mockResolvedValueOnce(['0', ['room:CCC333']]);

    const all = await service.findAll();

    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(all.map((r) => r.code).sort()).toEqual(['AAA111', 'CCC333']);
  });

  it('toRoomInfo 只含七个字段（playerCount 来自 seats 数，不泄漏 id；gameType 供新客户端选 board）', () => {
    const info = toRoomInfo(room({ code: 'AAA111', players: seatsOf('u1', 'u2') }));
    expect(Object.keys(info).sort()).toEqual(
      ['baseScore', 'code', 'gameType', 'maxPlayers', 'mode', 'playerCount', 'status'].sort(),
    );
    expect(info.playerCount).toBe(2);
    expect(info.gameType).toBe('doudizhu');
    expect(JSON.stringify(info)).not.toContain('u1');
  });

  it('generateCode 恒为 6 位大写 base36（N8：Math.random() 恰为 0 时旧实现返回空串）', async () => {
    const spy = vi.spyOn(Math, 'random');
    try {
      // 旧实现：'0'.toString(36) = '0' ⇒ substring(2,6) = '' ⇒ 空串 ⇒ 网关形状闸 10001
      spy.mockReturnValue(0);
      const zero = await service.create({ mode: 'random' });
      expect(zero.code).toBe('000000');

      // 另一类边界：base36 表示短于 6 位（旧实现会返回 1~5 个字符）
      spy.mockReturnValue(0.5); // '0.i' ⇒ substring(2,8) = 'i' ⇒ 旧实现是 'I'
      const short = await service.create({ mode: 'random' });
      expect(short.code).toMatch(/^[0-9A-Z]{6}$/);

      // 正对照：正常随机值也必须满足同一形状契约
      spy.mockRestore();
      const normal = await service.create({ mode: 'random' });
      expect(normal.code).toMatch(/^[0-9A-Z]{6}$/);
    } finally {
      spy.mockRestore();
    }
  });

  it('findAll **跳过派生键**（room:{code}:seats / :cardcount 不得被当成房间）', async () => {
    // §10.1 的键表：既有 `room:{code}`（元数据 Hash）也有 `room:{code}:seats` / `:cardcount` 派生键。
    const meta: Record<string, string> = {
      code: 'AAA111',
      mode: 'random',
      baseScore: '100',
      maxPlayers: '3',
      status: 'waiting',
      createdAt: String(Date.now()),
      timeoutAt: String(Date.now() + 30_000),
    };
    redis.scan.mockResolvedValue(['0', ['room:AAA111', 'room:AAA111:seats', 'room:AAA111:cardcount']]);
    // 刻意让派生键上的元数据读也能解析出**同一份合法元数据** —— 否则守卫被删掉也没人发现。
    // （判据是**行为**的：守卫没了，`all` 里就会出现第二个 code=AAA111 的房间。）
    (redis.hgetall as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(meta);

    const all = await service.findAll();

    expect(all.map((r) => r.code)).toEqual(['AAA111']);
  });

  it('形状非法的 seats 字段被丢弃（坏数据不得把服务打崩）', async () => {
    await service.create({ mode: 'random', roomCode: 'BAD001' });
    redis.hashes.set(seatsKey('BAD001'), { '0': '{oops', '1': JSON.stringify({ userId: 'u1' }) });
    expect((await service.findOne('BAD001'))!.players).toEqual([]);
  });

  it('readSeats 的坏字段不影响好字段（逐字段丢弃，不是整体报废）', async () => {
    await service.create({ mode: 'random', roomCode: 'BAD002' });
    await service.join('BAD002', 'good');
    const hash = redis.hashes.get(seatsKey('BAD002'))!;
    // 座位 1 = 合法 JSON 但缺 isRobot；座位 2 = 根本不是 JSON
    hash['1'] = JSON.stringify({ userId: 'noflag', seat: 1 });
    hash['2'] = 'not-json';
    redis.hashes.set(seatsKey('BAD002'), hash);

    expect((await service.findOne('BAD002'))!.players).toEqual([seat('good', 0)]);
  });

  it('座位是整数且以字符串字段名落盘（§10.1：field = seat）', async () => {
    await service.create({ mode: 'random', roomCode: 'INT001' });
    await service.join('INT001', 'u1');
    await service.addBot('INT001', 'bot-x');

    const hash = redis.hashes.get(seatsKey('INT001'))!;
    expect(Object.keys(hash)).toEqual(['0', '1']);
    expect(JSON.parse(hash['1']!) as Seat).toEqual(seat('bot-x', 1, true));
  });

  it('已满时 addBot → 12002（机器人走同一个原子入口，§9.6 第 3 条）', async () => {
    await service.create({ mode: 'random', roomCode: 'BOTFUL' });
    await service.join('BOTFUL', 'u1');
    await service.join('BOTFUL', 'u2');
    await service.join('BOTFUL', 'u3');
    await expect(service.addBot('BOTFUL', 'bot-late')).rejects.toThrow('房间已满');
    expect(Object.keys(redis.hashes.get(seatsKey('BOTFUL'))!).sort()).toEqual(['0', '1', '2']);
  });

  it('addBot 到不存在的房间 → 12001', async () => {
    await expect(service.addBot('NOPE01', 'bot-abc')).rejects.toThrow('房间不存在');
  });

  it('updateStatus 到不存在的房间 → 12001', async () => {
    await expect(service.updateStatus('NOPE02', 'playing')).rejects.toThrow('房间不存在');
  });
});

/**
 * 假 Redis 自身的契约（`test/helpers/fake-redis.ts`）。
 *
 * 存在的理由：`del` 此前只碰 `strings` —— 真实 Redis 的 `DEL` 对**任何类型**的键
 * 都生效，于是将来任何 `del(hashKey)` 的断言都是**静默假绿**（本项目最贵的一类缺陷）。
 * `exists` / `ttl` 是**同一族**（真实语义也不看类型）；合并后由协调者一并补齐。
 */
describe('FakeRedis 的键类型语义与真实 Redis 一致（DEL / EXISTS / TTL）', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = createFakeRedis();
  });

  it('DEL 删 Hash 键并计入返回值（旧假 Redis 会静默返回 0）', async () => {
    await redis.hset('room:AAA111:seats', '0', JSON.stringify(seat('u1', 0)));

    expect(await redis.del('room:AAA111:seats')).toBe(1);
    expect(redis.hashes.has('room:AAA111:seats')).toBe(false);
    expect(await redis.hgetall('room:AAA111:seats')).toEqual({});
  });

  it('DEL 删 ZSet 键并计入返回值', async () => {
    await redis.zadd('match:queue:random:global', 1000, 'u1');

    expect(await redis.del('match:queue:random:global')).toBe(1);
    expect(redis.zsets.has('match:queue:random:global')).toBe(false);
    expect(await redis.zcard('match:queue:random:global')).toBe(0);
  });

  it('DEL 混合同类型，逐个计数（不存在的键不计）', async () => {
    await redis.hset('h', 'f', 'v');
    await redis.zadd('z', 1, 'm');
    await redis.set('s', 'value');

    expect(await redis.del('h', 'z', 's', 'missing')).toBe(3);
    expect(redis.hashes.has('h')).toBe(false);
    expect(redis.zsets.has('z')).toBe(false);
    expect(redis.strings.has('s')).toBe(false);
  });

  // ── 与 del 同一族的「假 Redis 比真 Redis 更宽容」────────────────────

  it('EXISTS 认 ZSet 键（旧假 Redis 对 ZSet 返回 0 ⇒ 「队列已清空」会是假绿）', async () => {
    await redis.zadd('match:queue:random:global', 1000, 'u1');

    expect(await redis.exists('match:queue:random:global')).toBe(1);
    expect(await redis.exists('match:queue:random:global', 'nope')).toBe(1);

    await redis.del('match:queue:random:global');
    expect(await redis.exists('match:queue:random:global')).toBe(0);
  });

  it('TTL 对 ZSet 键返回 -1（存在但无 TTL），键不存在才返回 -2', async () => {
    await redis.zadd('match:queue:random:global', 1000, 'u1');

    expect(await redis.ttl('match:queue:random:global')).toBe(-1);
    expect(await redis.ttl('missing')).toBe(-2);
  });
});
