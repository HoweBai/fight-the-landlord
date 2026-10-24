import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { RecordMoneyDeltaRequest, RecordWriteRequest } from '@fight-the-landlord/protocol';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  RecordRpcController,
  ENDED_AT_MISMATCH_THRESHOLD_MS,
} from '../src/rpc/record.rpc.controller';

/**
 * 记录片 T4/C4/C11 的**单测载体**（规格 §2.2 / 设计 D2·D3）：`record.write` 写入链。
 *
 * ⚠️ 本文件**不用真 DB**（user-service 单测惯例 = 直接 new 控制器 + 假依赖，见
 * `auth.service.test.ts`）。但这里的假 DB **不是**「按调用序返回剧本」的桩 ——
 * 它是一个**最小仿真**（事务缓冲 + `(room_code, game_version)` 唯一键 + 失败回滚），
 * 因为本任务的三条语义（幂等「恰一组行」、duplicate 比对 `ended_at`、第二表插入抛 ⇒
 * 无孤儿）都**承重**于「数据库行为」这一层；按序打桩会把断言退化成「实现调了几次」。
 *
 * ⚠️ 仿真能证的是**我们这侧**的责任：全部写入发生在**同一个** `dataSource.transaction`
 * 回调里、错误**不被吞**（⇒ 回调抛 ⇒ 缓冲丢弃）；「InnoDB 真回滚」的最终证据在
 * T9 conformance 的真栈用例（C4 幂等 ×2 + `compose exec mysql` 查行）。
 */

const T0 = Date.parse('2026-10-03T12:00:00.000Z');
/** 34 位 hex（真实包络内取值；T4 的校验只钉长度，仍用合法形态避免误导读者）。 */
const HAND34 = '0f'.repeat(17);
const BOTTOM6 = '0f'.repeat(3);

/** 一个**通过校验**的合法载荷（`mkReq` 的底座；个别用例只改一处）。 */
function mkReq(over: Partial<RecordWriteRequest> = {}): RecordWriteRequest {
  return {
    roomCode: 'ABC123',
    gameVersion: 7,
    mode: 'random',
    baseScore: 15,
    result: {
      roomCode: 'ABC123',
      baseScore: 15,
      winner: 'landlord',
      landlordSeat: 0,
      farmerSeats: [1, 2],
      multiplier: 2,
      spring: 'none',
      landlordScoreChange: 30,
      farmerScoreChange: -15,
    },
    seats: [
      { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND34 },
      { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND34 },
      { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34 },
    ],
    bottomCards: BOTTOM6,
    startedAt: T0,
    endedAt: T0 + 120_000,
    ...over,
  };
}

interface Statement {
  sql: string;
  params: unknown[];
}

interface RecordRow {
  id: number;
  room_code: string;
  game_version: number;
  ended_at: Date;
}

/** 仿真库的可变状态（事务缓冲与已提交面同形）。 */
interface FakeState {
  records: RecordRow[];
  players: Array<Record<string, unknown>>;
  nextId: number;
}

/**
 * 最小 DB 仿真：**事务缓冲 + 唯一键 + 回滚**。
 *
 * - `dataSource.transaction(cb)`：在缓冲副本上跑 `cb`；`cb` 正常返回 ⇒ 提交
 *   （缓冲换入），`cb` 抛 ⇒ 缓冲**丢弃并重新抛出**（回滚语义）。
 * - `INSERT INTO game_records` 命中已有 `(room_code, game_version)` ⇒ 抛
 *   `ER_DUP_ENTRY`（真库唯一键的等价物——它只在「SELECT 先查」漏网的竞态里才会响）。
 * - `failPlayersInsert = true` ⇒ 第二表插入抛（事务回滚用例的注入点）。
 * - T7 起同一仿真还服务 `record.moneyDelta`（非事务直查）：`SELECT p.seat` 返回该局
 *   已落库座位集合；`UPDATE … SET p.money_delta = ?` 按**真 MySQL 语义**返回 affectedRows
 *   （同值重写 = 0）——这正是「回执不得用 affectedRows」用例的承重面。
 */
class FakeDb {
  committed: FakeState = { records: [], players: [], nextId: 1 };
  /** 昵称快照的真源（模拟 `users` 表：id → nickname，缺键 = 查无此人 ⇒ NULL）。 */
  users = new Map<string, string | null>();
  failPlayersInsert = false;
  /** 注入点：record.moneyDelta 的 UPDATE 抛（库故障分支用例）。 */
  failMoneyDeltaUpdate = false;
  /** **全部**语句（含回滚事务里的）——「查了哪些 id」「发过哪些 INSERT/UPDATE」的观测面。 */
  queries: Statement[] = [];
  /** 每次 moneyDelta UPDATE 的 affectedRows（真 MySQL 语义：同值重写 = 0）。 */
  updateAffectedRows: number[] = [];
  transactionCalls = 0;

  dataSource = {
    /** 非事务直查（record.moneyDelta 的 SELECT / UPDATE 路径）。 */
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      return this.route(this.committed, sql, params);
    },
    transaction: async <T>(
      cb: (m: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> => {
      this.transactionCalls += 1;
      const staged: FakeState = {
        records: [...this.committed.records],
        // player 行按对象复制：缓冲里的改写不落到已提交面（回滚语义与真库一致）。
        players: this.committed.players.map((p) => ({ ...p })),
        nextId: this.committed.nextId,
      };
      const manager = {
        query: (sql: string, params: unknown[] = []): Promise<unknown> => {
          this.queries.push({ sql, params });
          return this.route(staged, sql, params);
        },
      };
      const result = await cb(manager);
      // 提交：缓冲换入（cb 抛时不会走到这里 ⇒ 回滚语义）。
      this.committed = staged;
      return result;
    },
  };

  /** 预置既有行（幂等 / `ended_at` 比对用例的起点）。 */
  seedRecord(roomCode: string, gameVersion: number, endedAtMs: number): void {
    this.committed.records.push({
      id: this.committed.nextId,
      room_code: roomCode,
      game_version: gameVersion,
      ended_at: new Date(endedAtMs),
    });
    this.committed.nextId += 1;
  }

  /** 预置一局「记录行 + 指定座位玩家行」（moneyDelta 用例的起点；money_delta 起点恒 NULL）。 */
  seedGame(roomCode: string, gameVersion: number, seats: readonly number[] = [0, 1, 2]): void {
    const id = this.committed.nextId;
    this.committed.nextId += 1;
    this.committed.records.push({
      id,
      room_code: roomCode,
      game_version: gameVersion,
      ended_at: new Date(T0),
    });
    for (const seat of seats) this.committed.players.push({ record_id: id, seat, money_delta: null });
  }

  /** 已提交面上某座当前的 money_delta（未找到 = undefined）。 */
  moneyDeltaOf(roomCode: string, gameVersion: number, seat: number): unknown {
    const record = this.committed.records.find(
      (r) => r.room_code === roomCode && r.game_version === gameVersion,
    );
    const player = record
      ? this.committed.players.find((p) => p.record_id === record.id && p.seat === seat)
      : undefined;
    return player?.money_delta;
  }

  private async route(state: FakeState, sql: string, params: unknown[]): Promise<unknown> {
    // ── 金币场 T7：record.moneyDelta 的两条 SQL（规格 §3；无反引号形态）────────
    if (sql.startsWith('SELECT p.seat')) {
      const [roomCode, gameVersion] = params as [string, number];
      const record = state.records.find(
        (r) => r.room_code === roomCode && r.game_version === gameVersion,
      );
      if (!record) return [];
      return state.players.filter((p) => p.record_id === record.id).map((p) => ({ seat: p.seat }));
    }
    if (sql.includes('SET p.money_delta')) {
      if (this.failMoneyDeltaUpdate) throw new Error('money_delta update boom');
      const [delta, roomCode, gameVersion, seat] = params as [number, string, number, number];
      const record = state.records.find(
        (r) => r.room_code === roomCode && r.game_version === gameVersion,
      );
      const player = record
        ? state.players.find((p) => p.record_id === record.id && p.seat === seat)
        : undefined;
      if (!player) {
        this.updateAffectedRows.push(0);
        return { affectedRows: 0 };
      }
      // 真 MySQL 语义：同值重写 ⇒ affectedRows = 0（回执不得依赖它）。
      const changed = player.money_delta !== delta;
      player.money_delta = delta;
      this.updateAffectedRows.push(changed ? 1 : 0);
      return { affectedRows: changed ? 1 : 0 };
    }
    if (sql.includes('FROM `game_records`')) {
      const [roomCode, gameVersion] = params as [string, number];
      return state.records
        .filter((r) => r.room_code === roomCode && r.game_version === gameVersion)
        .map((r) => ({ id: r.id, ended_at: r.ended_at }));
    }
    if (sql.includes('FROM `users`')) {
      return (params as string[])
        .filter((id) => this.users.has(id))
        .map((id) => ({ id, nickname: this.users.get(id) }));
    }
    if (sql.includes('INSERT INTO `game_records`')) {
      const [roomCode, gameVersion] = params as [string, number];
      if (state.records.some((r) => r.room_code === roomCode && r.game_version === gameVersion)) {
        throw Object.assign(new Error('Duplicate entry for unique key uk_room_version'), {
          code: 'ER_DUP_ENTRY',
        });
      }
      const id = state.nextId;
      state.nextId += 1;
      state.records.push({
        id,
        room_code: roomCode,
        game_version: gameVersion,
        ended_at: params[12] as Date,
      });
      return { insertId: id };
    }
    if (sql.includes('INSERT INTO `game_record_players`')) {
      if (this.failPlayersInsert) throw new Error('players insert boom');
      state.players.push({ record_id: params[0], seat: params[1], money_delta: null });
      return { insertId: state.nextId };
    }
    throw new Error(`FakeDb 未识别的 SQL：${sql}`);
  }
}

const playerInserts = (db: FakeDb): Statement[] =>
  db.queries.filter((s) => s.sql.includes('INSERT INTO `game_record_players`'));

const recordInserts = (db: FakeDb): Statement[] =>
  db.queries.filter((s) => s.sql.includes('INSERT INTO `game_records`'));

const usersSelects = (db: FakeDb): Statement[] =>
  db.queries.filter((s) => s.sql.startsWith('SELECT') && s.sql.includes('FROM `users`'));

const moneyDeltaSelects = (db: FakeDb): Statement[] =>
  db.queries.filter((s) => s.sql.startsWith('SELECT p.seat'));

const moneyDeltaUpdates = (db: FakeDb): Statement[] =>
  db.queries.filter((s) => s.sql.includes('SET p.money_delta'));

describe('记录片 T4：record.write 接收侧（规格 §2.2 / 设计 D2·D3）', () => {
  let db: FakeDb;
  let controller: RecordRpcController;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeDb();
    controller = new RecordRpcController(db.dataSource as never);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('写成功：恰 1+3 行、按座位序、role/score/won 映射正确、昵称快照来自 users 表', async () => {
    db.users.set('u-A', 'Alice');
    db.users.set('u-B', null); // 人类但无昵称 ⇒ 快照 NULL（不是缺省成别的）
    // 座位故意乱序送入：服务端必须**按座位序**落库
    const req = mkReq({
      seats: [
        { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34 },
        { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND34 },
        { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND34 },
      ],
    });

    const res = await controller.write(req);

    expect(res).toEqual({ ok: true, data: { written: true } });

    // ── 记录行：1 条，参数逐位核对（列序与迁移 DDL 一致）────────────────
    const records = recordInserts(db);
    expect(records).toHaveLength(1);
    expect(records[0]!.params).toEqual([
      'ABC123',
      7,
      'random',
      15,
      'landlord',
      0,
      2,
      'none',
      30,
      -15,
      BOTTOM6,
      new Date(T0), // started_at：自信封（会话创建时刻）
      new Date(T0 + 120_000), // ended_at：room 收事件时刻
    ]);

    // ── 玩家行：恰 3 条、按座位序 0/1/2 ────────────────────────────────
    const players = playerInserts(db);
    expect(players).toHaveLength(3);
    expect(players.map((s) => s.params[1])).toEqual([0, 1, 2]);

    // 座位 0：地主（landlordSeat=0）⇒ landlordScoreChange + won=1
    expect(players[0]!.params).toEqual([
      1, // record_id = 首个自增 id
      0,
      'u-A',
      0, // is_robot=false
      null, // robotId
      'Alice', // 昵称快照（按 user_id IN 查 users 表）
      'landlord',
      30,
      1, // won：role === winner
      HAND34,
      new Date(T0 + 120_000),
    ]);
    // 座位 1：农民 ⇒ farmerScoreChange + won=0（winner=landlord）+ 库中昵称 NULL
    expect(players[1]!.params).toEqual([1, 1, 'u-B', 0, null, null, 'farmer', -15, 0, HAND34, new Date(T0 + 120_000)]);
    // 座位 2：机器人 ⇒ user_id NULL、nickname NULL；robotId 是**内部 botId**、绝不写 displayId
    expect(players[2]!.params).toEqual([1, 2, null, 1, 'bot-1', null, 'farmer', -15, 0, HAND34, new Date(T0 + 120_000)]);

    // ── 昵称快照查询：IN 查仅含两个人类 id（机器人不进查询）────────────
    const userQueries = usersSelects(db);
    expect(userQueries).toHaveLength(1);
    expect(userQueries[0]!.sql).toContain('IN (?, ?)');
    expect(userQueries[0]!.params).toEqual(['u-A', 'u-B']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('mode 三值（§2.1）：gold 通过校验并原样落库（user-service 面三值化）', async () => {
    const res = await controller.write(mkReq({ mode: 'gold' }));
    expect(res).toEqual({ ok: true, data: { written: true } });
    expect(recordInserts(db)[0]!.params[2]).toBe('gold');
  });

  it('昵称快照：查无此人（账号已删）⇒ NULL，不抛', async () => {
    db.users.set('u-A', 'Alice'); // u-B 不在表里
    const res = await controller.write(mkReq());
    expect(res).toEqual({ ok: true, data: { written: true } });
    expect(playerInserts(db)[1]!.params[5]).toBeNull();
  });

  it('机器人昵称快照：trim 后落库；未带则 NULL', async () => {
    const req = mkReq({
      seats: [
        { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND34 },
        { seat: 1, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34, nickname: ' 阿豆 ' },
        { seat: 2, userId: null, isRobot: true, robotId: 'bot-2', hand: HAND34 },
      ],
    });

    const res = await controller.write(req);

    expect(res).toEqual({ ok: true, data: { written: true } });
    const players = playerInserts(db);
    expect(players[1]!.params[5]).toBe('阿豆');
    expect(players[2]!.params[5]).toBeNull();
    // `robot_id` 仍是内部 botId（`bot-1`），不是 displayId；展示名只进 nickname 列。
  });

  it('人类座携带昵称快照 ⇒ BAD_PARAM（人类快照只能来自 users）', async () => {
    const res = await controller.write(
      mkReq({
        seats: [
          { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND34, nickname: '阿豆' },
          { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND34 },
          { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34 },
        ],
      }),
    );

    expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    expect(db.transactionCalls).toBe(0);
  });

  it('!isRobot && userId === null ⇒ BAD_PARAM（不写「没有 user_id 的人类行」）', async () => {
    const res = await controller.write(
      mkReq({
        seats: [
          { seat: 0, userId: null, isRobot: false, robotId: null, hand: HAND34 },
          { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND34 },
          { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34 },
        ],
      }),
    );

    expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    expect(db.transactionCalls).toBe(0);
  });

  it('机器人昵称非法（非字符串 / 空白 / 超 50 字）⇒ BAD_PARAM', async () => {
    for (const nickname of [123, '   ', 'a'.repeat(51)] as unknown[]) {
      const res = await controller.write(
        mkReq({
          seats: [
            { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND34 },
            { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND34 },
            { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND34, nickname },
          ] as never,
        }),
      );
      expect(res, `nickname=${JSON.stringify(nickname)}`).toMatchObject({
        ok: false,
        code: ErrCode.BAD_PARAM,
      });
    }
    expect(db.transactionCalls).toBe(0);
  });

  it('幂等：同 payload ×2 ⇒ 恰一组行 + 第二次 written:false（无 INSERT、无 error 日志）', async () => {
    db.users.set('u-A', 'Alice');
    const req = mkReq();

    const first = await controller.write(req);
    const second = await controller.write(req);

    expect(first).toEqual({ ok: true, data: { written: true } });
    expect(second).toEqual({ ok: true, data: { written: false } });
    // 恰一组行：第二次没有发出任何 INSERT（全部语句面里仍是 1+3 条）
    expect(recordInserts(db)).toHaveLength(1);
    expect(playerInserts(db)).toHaveLength(3);
    expect(db.committed.records).toHaveLength(1);
    expect(db.committed.players).toHaveLength(3);
    // ended_at 一致（逐毫秒）⇒ 不得告警
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ended_at 比对：|差| ≤ 阈值 ⇒ 静默 written:false；超阈值 ⇒ error 日志（码复用保险）', async () => {
    const req = mkReq();
    // 边界内：恰在阈值上（|差| = 阈值，非「超」）⇒ 不告警
    db.seedRecord(req.roomCode, req.gameVersion, req.endedAt + ENDED_AT_MISMATCH_THRESHOLD_MS);
    expect(await controller.write(req)).toEqual({ ok: true, data: { written: false } });
    expect(errorSpy).not.toHaveBeenCalled();

    // 超阈值 1ms ⇒ error 级日志（响亮不静默），但仍返回 written:false 信封（不抛）
    db = new FakeDb();
    db.seedRecord(req.roomCode, req.gameVersion, req.endedAt + ENDED_AT_MISMATCH_THRESHOLD_MS + 1);
    controller = new RecordRpcController(db.dataSource as never);
    expect(await controller.write(req)).toEqual({ ok: true, data: { written: false } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]![0]);
    expect(line).toContain('ABC123');
    expect(line).toContain('7');
    expect(line).toContain('ended_at');
  });

  it('ended_at 差为负数（既有行更早）同样按 |差| 判：超阈值 ⇒ 告警', async () => {
    const req = mkReq();
    db.seedRecord(req.roomCode, req.gameVersion, req.endedAt - ENDED_AT_MISMATCH_THRESHOLD_MS * 10);
    expect(await controller.write(req)).toEqual({ ok: true, data: { written: false } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('非法 payload ⇒ {ok:false,10001} 且**不开事务**（校验先于任何库操作）', async () => {
    const seat = (over: Partial<RecordWriteRequest['seats'][number]>): RecordWriteRequest['seats'][number] => ({
      seat: 0,
      userId: 'u-A',
      isRobot: false,
      robotId: null,
      hand: HAND34,
      ...over,
    });
    const cases: Array<[string, RecordWriteRequest]> = [
      ['seats 只有 2 条', mkReq({ seats: [seat({ seat: 0 }), seat({ seat: 1, userId: 'u-B' })] })],
      ['座位不是 0/1/2 各一', mkReq({ seats: [seat({ seat: 0 }), seat({ seat: 0 }), seat({ seat: 1, userId: 'u-B' })] })],
      [
        'isRobot 座位带了 userId（绝不写 displayId）',
        mkReq({
          seats: [
            seat({ seat: 0 }),
            seat({ seat: 1, userId: 'u-B' }),
            seat({ seat: 2, userId: 'bot-display-id', isRobot: true, robotId: 'bot-1' }),
          ],
        }),
      ],
      [
        'hand 长 33',
        mkReq({
          seats: [
            seat({ seat: 0, hand: '0f'.repeat(16) + '0' }),
            seat({ seat: 1, userId: 'u-B' }),
            seat({ seat: 2, userId: null, isRobot: true, robotId: 'bot-1' }),
          ],
        }),
      ],
      ['bottomCards 长 5', mkReq({ bottomCards: '0f0f0' })],
      ['mode 非枚举值', mkReq({ mode: 'ranked' as never })],
      ['endedAt 非有限数', mkReq({ endedAt: Number.NaN })],
    ];

    for (const [label, req] of cases) {
      const res = await controller.write(req);
      expect(res.ok, label).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.code, label).toBe(10001); // ErrCode.BAD_PARAM
      expect(res.message, label).toMatch(/\S/);
    }
    expect(db.transactionCalls).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled(); // 校验失败是调用方 bug，不是 error 级运维告警
  });

  it('事务回滚：第二表插入抛 ⇒ ok:false、无 record 孤儿、只有一个事务', async () => {
    db.users.set('u-A', 'Alice');
    db.failPlayersInsert = true;

    const res = await controller.write(mkReq());

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.message).toContain('players insert boom');
    // 回滚仿真：缓冲丢弃 ⇒ 已提交面里**一条行都没有**（不会「有记录无 players」）
    expect(db.committed.records).toHaveLength(0);
    expect(db.committed.players).toHaveLength(0);
    // 全部写入都在**同一个**事务回调里发生
    expect(db.transactionCalls).toBe(1);
    // 失败不得静默
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('探针判别力（自证）：关掉注入点 ⇒ 同形调用绿；开回 ⇒ 红——证明回滚用例不是恒真构造', async () => {
    db.users.set('u-A', 'Alice');
    db.failPlayersInsert = false;
    expect(await controller.write(mkReq())).toEqual({ ok: true, data: { written: true } });
    expect(db.transactionCalls).toBe(1);

    db.failPlayersInsert = true;
    const failed = await controller.write(mkReq({ gameVersion: 8 }));
    expect(failed.ok).toBe(false);
    expect(db.transactionCalls).toBe(2);
    expect(db.committed.records).toHaveLength(1); // 只留下第一局的 1 行（第二局回滚）
  });
});

// ─── 金币场 T7：record.moneyDelta 接收侧（规格 §3 / C7）──────────────────────

/** 规格 §3 的 SQL 逐字（**测试侧独立誊写**——断言的是执行面，不 import 实现常量）。 */
const SPEC_SEATS_SQL =
  'SELECT p.seat FROM game_record_players p JOIN game_records r ON p.record_id = r.id WHERE r.room_code = ? AND r.game_version = ?';
const SPEC_UPDATE_SQL =
  'UPDATE game_record_players p JOIN game_records r ON p.record_id = r.id SET p.money_delta = ? WHERE r.room_code = ? AND r.game_version = ? AND p.seat = ?';

/** 合法 deltas 向量（含正/负；`over` 只改指定座的取值）。 */
function mkDeltas(over: { 0?: number; 1?: number; 2?: number } = {}): RecordMoneyDeltaRequest['deltas'] {
  return [
    { seat: 0, delta: over[0] ?? 1500 },
    { seat: 1, delta: over[1] ?? -900 },
    { seat: 2, delta: over[2] ?? -600 },
  ];
}

function mkDeltaReq(over: Partial<RecordMoneyDeltaRequest> = {}): RecordMoneyDeltaRequest {
  return { roomCode: 'ABC123', gameVersion: 7, deltas: mkDeltas(), ...over };
}

describe('金币场 T7：record.moneyDelta 接收侧（规格 §3 / C7）', () => {
  let db: FakeDb;
  let controller: RecordRpcController;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new FakeDb();
    controller = new RecordRpcController(db.dataSource as never);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('正路径：三座齐 ⇒ matched=[0,1,2] 逐座回写；SQL 与规格 §3 逐字（先 SELECT 存在集合、再交集 UPDATE）', async () => {
    db.seedGame('ABC123', 7);

    const res = await controller.moneyDelta(mkDeltaReq());

    expect(res).toEqual({ ok: true, data: { matched: [0, 1, 2] } });
    // 语句序与逐字：① 存在集合读 → ②③④ 逐座回写（座位升序）
    expect(db.queries.map((s) => s.sql)).toEqual([
      SPEC_SEATS_SQL,
      SPEC_UPDATE_SQL,
      SPEC_UPDATE_SQL,
      SPEC_UPDATE_SQL,
    ]);
    expect(moneyDeltaSelects(db)[0]!.params).toEqual(['ABC123', 7]);
    expect(moneyDeltaUpdates(db).map((s) => s.params)).toEqual([
      [1500, 'ABC123', 7, 0],
      [-900, 'ABC123', 7, 1],
      [-600, 'ABC123', 7, 2],
    ]);
    // 落库面终值（含负值原样）
    expect(db.moneyDeltaOf('ABC123', 7, 0)).toBe(1500);
    expect(db.moneyDeltaOf('ABC123', 7, 1)).toBe(-900);
    expect(db.moneyDeltaOf('ABC123', 7, 2)).toBe(-600);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('边界：±(2^31−1) 与 0 原样回写（int 容量上界内全收）', async () => {
    db.seedGame('ABC123', 7);

    const res = await controller.moneyDelta(
      mkDeltaReq({ deltas: mkDeltas({ 0: 2_147_483_647, 1: 0, 2: -2_147_483_647 }) }),
    );

    expect(res).toEqual({ ok: true, data: { matched: [0, 1, 2] } });
    expect(db.moneyDeltaOf('ABC123', 7, 0)).toBe(2_147_483_647);
    expect(db.moneyDeltaOf('ABC123', 7, 1)).toBe(0);
    expect(db.moneyDeltaOf('ABC123', 7, 2)).toBe(-2_147_483_647);
  });

  it('幂等重发：同 payload ×2 ⇒ matched 两次都 [0,1,2]（第二次同值重写 affectedRows=0——回执不得依赖它）', async () => {
    db.seedGame('ABC123', 7);
    const req = mkDeltaReq();

    const first = await controller.moneyDelta(req);
    const second = await controller.moneyDelta(req);

    expect(first).toEqual({ ok: true, data: { matched: [0, 1, 2] } });
    expect(second).toEqual({ ok: true, data: { matched: [0, 1, 2] } });
    // 机械证据：第二轮三次 UPDATE 的 affectedRows 全 0（真 MySQL 同值重写语义），
    // 回执仍齐三座 ⇒「回执行存在性、不得用 affectedRows」被钉住。
    expect(db.updateAffectedRows).toEqual([1, 1, 1, 0, 0, 0]);
    expect(moneyDeltaUpdates(db)).toHaveLength(6);
    expect(db.moneyDeltaOf('ABC123', 7, 0)).toBe(1500);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('记录行缺失（record.write 未落/乱序到达）⇒ {ok:true, matched:[]}——不是错误，且零 UPDATE', async () => {
    const res = await controller.moneyDelta(mkDeltaReq());

    expect(res).toEqual({ ok: true, data: { matched: [] } });
    expect(db.queries.map((s) => s.sql)).toEqual([SPEC_SEATS_SQL]);
    expect(moneyDeltaUpdates(db)).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('交集语义：记录存在但只有部分座位（0/1）⇒ matched=[0,1]、只更存在的座（欠座交 room 侧重试收敛）', async () => {
    db.seedGame('ABC123', 7, [0, 1]);

    const res = await controller.moneyDelta(mkDeltaReq());

    expect(res).toEqual({ ok: true, data: { matched: [0, 1] } });
    expect(moneyDeltaUpdates(db).map((s) => s.params[3])).toEqual([0, 1]);
    expect(db.moneyDeltaOf('ABC123', 7, 2)).toBeUndefined(); // 不存在的座：零 UPDATE、不留值
  });

  it('非法 payload ⇒ {ok:false,10001} 且**零库操作**（唯一校验点 = protocol 的 validateRecordMoneyDelta）', async () => {
    const cases: Array<[string, unknown]> = [
      ['非对象', null],
      ['roomCode 空串', mkDeltaReq({ roomCode: '' })],
      ['roomCode 17 字符', mkDeltaReq({ roomCode: 'R'.repeat(17) })],
      ['gameVersion 0', mkDeltaReq({ gameVersion: 0 })],
      ['deltas 只有 2 条', mkDeltaReq({ deltas: mkDeltas().slice(0, 2) })],
      [
        '座位非升序（1,0,2）',
        mkDeltaReq({
          deltas: [
            { seat: 1, delta: 10 },
            { seat: 0, delta: 20 },
            { seat: 2, delta: 30 },
          ],
        }),
      ],
      ['delta 非整数（1.5）', mkDeltaReq({ deltas: mkDeltas({ 0: 1.5 }) })],
      ['|delta| 超 2^31−1', mkDeltaReq({ deltas: mkDeltas({ 2: 2_147_483_648 }) })],
      [
        'delta 是字符串',
        mkDeltaReq({
          deltas: [
            { seat: 0, delta: '1500' as never },
            { seat: 1, delta: 0 },
            { seat: 2, delta: 0 },
          ],
        }),
      ],
    ];

    for (const [label, req] of cases) {
      const res = await controller.moneyDelta(req as never);
      expect(res.ok, label).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.code, label).toBe(10001); // ErrCode.BAD_PARAM
      expect(res.message, label).toMatch(/\S/);
    }
    expect(db.queries).toHaveLength(0); // 校验先于任何库操作
    expect(errorSpy).not.toHaveBeenCalled(); // 校验失败是调用方 bug，不是 error 级运维告警
  });

  it('库故障：UPDATE 抛 ⇒ {ok:false,10007} + error 日志（响亮不静默）', async () => {
    db.seedGame('ABC123', 7);
    db.failMoneyDeltaUpdate = true;

    const res = await controller.moneyDelta(mkDeltaReq());

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe(10007); // ErrCode.UPSTREAM_UNAVAILABLE
    expect(res.message).toContain('money_delta update boom');
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
