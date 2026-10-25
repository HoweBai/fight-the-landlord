import { describe, it, expect, beforeEach } from 'vitest';
import type { RecordMoneyDeltaRequest, RecordWriteRequest } from '@fight-the-landlord/protocol';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RecordRpcController } from '../src/rpc/record.rpc.controller';

/**
 * Task 4.0（spec §4.9.1/§4.9.2）：跑得快记录**单独建表**的写入链。
 *
 * 判据（与 ddz 的 `record.rpc.test.ts` 同一强度级别）：
 *  - `record.write` 按 `gameType` 分支：pdk 写 `game_records_pdk` / `game_record_players_pdk`，
 *    **绝不**碰斗地主两表；
 *  - 幂等键 `(room_code, game_version)`：重复投递 ⇒ `written=false`、不新增行；
 *  - `seats[].playedCount` 必填且 = 初始手牌 − `remaining[seat]`（RH1-b）；
 *  - `bottomCards` 必须缺省；`unusedCards` 仅 2 人局且 32 hex；
 *  - `record.moneyDelta` 带 `gameType:'paodekuai'` ⇒ 回写 pdk 玩家行，不碰旧表。
 *
 * ⚠️ 与既有测试同口径：不用真 DB；假库是**最小仿真**（事务缓冲 + 唯一键 + 指定列路由），
 * 断言落在「发了哪些 SQL / 参数是什么」，而不是「实现调了几次」。
 */

const T0 = Date.parse('2026-10-24T12:00:00.000Z');
/** 16 张 = 32 hex；12 张 = 24 hex；2 人局扣牌 16 张 = 32 hex。 */
const HAND16 = '0f'.repeat(16);
const HAND12 = '0f'.repeat(12);
const UNUSED32 = '1e'.repeat(16);

interface PdkRecordRow {
  id: number;
  room_code: string;
  game_version: number;
  ended_at: number;
  params: unknown[];
}

interface PdkPlayerRow {
  record_id: number;
  seat: number;
  money_delta: number | null;
  params: unknown[];
}

/** 合法 pdk 3 人载荷底座。 */
function mkPdkReq(over: Partial<RecordWriteRequest> = {}): RecordWriteRequest {
  return {
    roomCode: 'PDK001',
    gameVersion: 3,
    mode: 'gold',
    baseScore: 15,
    gameType: 'paodekuai',
    playerCount: 3,
    result: {
      roomCode: 'PDK001',
      gameType: 'paodekuai',
      playerCount: 3,
      baseScore: 15,
      winnerSeats: [0],
      scoreChanges: [
        { seat: 0, delta: 90 },
        { seat: 1, delta: -60 },
        { seat: 2, delta: -30 },
      ],
      remaining: [0, 4, 2],
      multiplier: 1,
      bombCount: 0,
      guan: false,
      spring: false,
      baobenSeats: [],
    },
    seats: [
      // 初始 16 张 − remaining[0]=0 ⇒ playedCount 16
      { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND16, playedCount: 16 },
      // 16 − 4 = 12
      { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND16, playedCount: 12 },
      // 16 − 2 = 14
      { seat: 2, userId: null, isRobot: true, robotId: 'bot-1', hand: HAND16, playedCount: 14 },
    ],
    startedAt: T0,
    endedAt: T0 + 180_000,
    ...over,
  };
}

/**
 * 最小 pdk DB 仿真：
 *  - `game_records_pdk` / `game_record_players_pdk` 各自的内存表 + 事务缓冲；
 *  - `(room_code, game_version)` 唯一键；
 *  - 斗地主表的任何 SQL 都记进 `ddzQueries`（用于断言「pdk 分支不碰旧表」）。
 */
class FakePdkDb {
  records: PdkRecordRow[] = [];
  players: PdkPlayerRow[] = [];
  nextId = 1;
  users = new Map<string, string | null>();
  /** 观察面：全部 SQL（含事务内）。 */
  queries: Array<{ sql: string; params: unknown[] }> = [];
  /** 任何引用斗地主两表的 SQL（pdk 分支必须为空）。 */
  ddzQueries: string[] = [];
  transactionCalls = 0;

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      return Promise.resolve(this.route(this, sql, params));
    },
    transaction: async <T>(
      cb: (m: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
    ): Promise<T> => {
      this.transactionCalls += 1;
      const staged: FakePdkDb = Object.assign(Object.create(FakePdkDb.prototype), this, {
        records: this.records.map((r) => ({ ...r, params: [...r.params] })),
        players: this.players.map((p) => ({ ...p, params: [...p.params] })),
        queries: this.queries,
        ddzQueries: this.ddzQueries,
      });
      const manager = {
        query: (sql: string, params: unknown[] = []): Promise<unknown> => {
          this.queries.push({ sql, params });
          return Promise.resolve(this.route(staged, sql, params));
        },
      };
      const result = await cb(manager);
      // 提交：缓冲换入（cb 抛时走不到这里 ⇒ 回滚）。
      this.records = staged.records;
      this.players = staged.players;
      this.nextId = staged.nextId;
      return result;
    },
  };

  private route(state: FakePdkDb, sql: string, params: unknown[]): unknown {
    if (/FROM `game_records_pdk`/.test(sql)) {
      return state.records
        .filter((r) => r.room_code === params[0] && r.game_version === params[1])
        .map((r) => ({ id: r.id, ended_at: r.ended_at }));
    }
    if (/INSERT INTO `game_records_pdk`/.test(sql)) {
      const id = state.nextId++;
      state.records.push({
        id,
        room_code: String(params[0]),
        game_version: Number(params[1]),
        ended_at: Number(params[16]),
        params: [...params],
      });
      return { insertId: id };
    }
    if (/INSERT INTO `game_record_players_pdk`/.test(sql)) {
      state.players.push({
        record_id: Number(params[0]),
        seat: Number(params[1]),
        money_delta: null,
        params: [...params],
      });
      return undefined;
    }
    if (/SELECT p\.seat FROM game_record_players_pdk/.test(sql)) {
      const record = state.records.find(
        (r) => r.room_code === params[0] && r.game_version === params[1],
      );
      if (!record) return [];
      return state.players
        .filter((p) => p.record_id === record.id)
        .map((p) => ({ seat: p.seat }));
    }
    if (/UPDATE game_record_players_pdk/.test(sql)) {
      const record = state.records.find(
        (r) => r.room_code === params[1] && r.game_version === params[2],
      );
      if (record) {
        const row = state.players.find((p) => p.record_id === record.id && p.seat === params[3]);
        if (row) row.money_delta = Number(params[0]);
      }
      return undefined;
    }
    if (/FROM `users`/.test(sql)) {
      return [...state.users.entries()].map(([id, nickname]) => ({ id, nickname }));
    }
    if (/`game_record_players`|`game_records`/.test(sql)) {
      state.ddzQueries.push(sql);
      return [];
    }
    throw new Error(`unexpected SQL in pdk fake: ${sql}`);
  }
}

function makeController(db: FakePdkDb): RecordRpcController {
  return new RecordRpcController(db.dataSource as never);
}

describe('Task 4.0：record.write 的 pdk 分支（spec §4.9.2）', () => {
  let db: FakePdkDb;

  beforeEach(() => {
    db = new FakePdkDb();
    db.users.set('u-A', '甲');
    db.users.set('u-B', '乙');
  });

  it('3 人写入：1 父行 + 3 玩家行，字段映射正确且不碰斗地主表', async () => {
    const res = await makeController(db).write(mkPdkReq());

    expect(res).toEqual({ ok: true, data: { written: true } });
    expect(db.records).toHaveLength(1);
    expect(db.players).toHaveLength(3);
    expect(db.ddzQueries).toEqual([]);

    const parent = db.records[0]!;
    // 列序：room_code, game_version, mode, game_type, player_count, base_score, winner_seat, remaining,
    //       multiplier, bomb_count, guan, spring, baoben_seats, score_changes, unused_cards,
    //       started_at, ended_at
    expect(parent.params).toEqual([
      'PDK001',
      3,
      'gold',
      'paodekuai',
      3,
      15,
      0,
      JSON.stringify([0, 4, 2]),
      1,
      0,
      0,
      0,
      JSON.stringify([]),
      JSON.stringify([
        { seat: 0, delta: 90 },
        { seat: 1, delta: -60 },
        { seat: 2, delta: -30 },
      ]),
      null,
      T0,
      T0 + 180_000,
    ]);

    // 玩家行：seat 升序、played_count/score_change/won 来自结算；昵称快照人类查 users。
    const bySeat = new Map(db.players.map((p) => [p.seat, p]));
    expect([...bySeat.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(bySeat.get(0)!.params).toEqual([1, 0, 'u-A', 0, null, '甲', HAND16, 16, 90, 1, T0 + 180_000]);
    expect(bySeat.get(1)!.params).toEqual([1, 1, 'u-B', 0, null, '乙', HAND16, 12, -60, 0, T0 + 180_000]);
    expect(bySeat.get(2)!.params).toEqual([1, 2, null, 1, 'bot-1', null, HAND16, 14, -30, 0, T0 + 180_000]);
    expect(db.players.every((p) => p.money_delta === null)).toBe(true);
  });

  it('幂等：同一 (room_code, game_version) 重复投递 ⇒ written=false、不新增行', async () => {
    const controller = makeController(db);
    await controller.write(mkPdkReq());
    const second = await controller.write(mkPdkReq());

    expect(second).toEqual({ ok: true, data: { written: false } });
    expect(db.records).toHaveLength(1);
    expect(db.players).toHaveLength(3);
  });

  it('2 人局：16 张手牌（32 hex）+ unusedCards 32 hex 落 unused_cards', async () => {
    const req = mkPdkReq({
      gameType: 'paodekuai',
      playerCount: 2,
      result: {
        roomCode: 'PDK001',
        gameType: 'paodekuai',
        playerCount: 2,
        baseScore: 15,
        winnerSeats: [1],
        scoreChanges: [
          { seat: 0, delta: -30 },
          { seat: 1, delta: 30 },
        ],
        remaining: [2, 0],
        multiplier: 2,
        bombCount: 1,
        guan: false,
        spring: false,
        baobenSeats: [],
      },
      seats: [
        { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND16, playedCount: 14 },
        { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND16, playedCount: 16 },
      ],
      unusedCards: UNUSED32,
    });

    const res = await makeController(db).write(req);
    expect(res.ok).toBe(true);
    expect(db.records[0]!.params[14]).toBe(UNUSED32);
    expect(db.records[0]!.params[4]).toBe(2);
  });

  it('4 人局：12 张（24 hex）合法', async () => {
    const req = mkPdkReq({
      playerCount: 4,
      result: {
        roomCode: 'PDK001',
        gameType: 'paodekuai',
        playerCount: 4,
        baseScore: 15,
        winnerSeats: [0],
        scoreChanges: [
          { seat: 0, delta: 90 },
          { seat: 1, delta: -30 },
          { seat: 2, delta: -30 },
          { seat: 3, delta: -30 },
        ],
        remaining: [0, 3, 2, 1],
        multiplier: 1,
        bombCount: 0,
        guan: true,
        spring: false,
        baobenSeats: [3],
      },
      seats: [
        { seat: 0, userId: 'u-A', isRobot: false, robotId: null, hand: HAND12, playedCount: 12 },
        { seat: 1, userId: 'u-B', isRobot: false, robotId: null, hand: HAND12, playedCount: 9 },
        { seat: 2, userId: 'u-C', isRobot: false, robotId: null, hand: HAND12, playedCount: 10 },
        { seat: 3, userId: 'u-D', isRobot: false, robotId: null, hand: HAND12, playedCount: 11 },
      ],
    });

    const res = await makeController(db).write(req);
    expect(res.ok).toBe(true);
    expect(db.players.find((p) => p.seat === 3)!.params[7]).toBe(11);
  });

  const rejected: Array<[string, Partial<RecordWriteRequest>, RegExp]> = [
    ['seats 数量与 playerCount 不符', { seats: mkPdkReq().seats.slice(0, 2) }, /seats 必须恰 3 条/],
    [
      'playedCount 缺失',
      { seats: mkPdkReq().seats.map((s) => ({ ...s, playedCount: undefined })) },
      /playedCount/,
    ],
    [
      'playedCount 与 remaining 不一致',
      { seats: mkPdkReq().seats.map((s, i) => (i === 1 ? { ...s, playedCount: 11 } : s)) },
      /playedCount/,
    ],
    [
      '手牌长度不是 32 hex（3 人）',
      { seats: mkPdkReq().seats.map((s, i) => (i === 0 ? { ...s, hand: HAND12 } : s)) },
      /hand 必须是 32 位字符串/,
    ],
    ['pdk 不得带 bottomCards', { bottomCards: '0f'.repeat(3) }, /bottomCards/],
    [
      'unusedCards 仅 2 人局',
      { unusedCards: UNUSED32 },
      /unusedCards/,
    ],
    [
      'gameType=paodekuai 但 result 是斗地主结算',
      {
        result: {
          roomCode: 'PDK001',
          baseScore: 15,
          winner: 'landlord',
          landlordSeat: 0,
          farmerSeats: [1, 2],
          multiplier: 1,
          spring: 'none',
          landlordScoreChange: 0,
          farmerScoreChange: 0,
        },
      },
      /result 必须是跑得快结算/,
    ],
    [
      'playerCount 与 result 不一致',
      { playerCount: 4 },
      /playerCount/,
    ],
  ];

  for (const [name, over, pattern] of rejected) {
    it(`拒收：${name}`, async () => {
      const res = await makeController(db).write(mkPdkReq(over));
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable: 上一行已断言 ok=false');
      expect(res.code).toBe(ErrCode.BAD_PARAM);
      expect(res.message).toMatch(pattern);
      expect(db.records).toHaveLength(0);
      expect(db.players).toHaveLength(0);
    });
  }
});

describe('Task 4.0：record.moneyDelta 的 pdk 分支（spec §4.9.2）', () => {
  let db: FakePdkDb;

  beforeEach(async () => {
    db = new FakePdkDb();
    db.users.set('u-A', '甲');
    db.users.set('u-B', '乙');
    await makeController(db).write(mkPdkReq());
  });

  it('按 gameType=paodekuai 回写 pdk 玩家行，matched 来自存在集合', async () => {
    const req: RecordMoneyDeltaRequest = {
      roomCode: 'PDK001',
      gameVersion: 3,
      gameType: 'paodekuai',
      playerCount: 3,
      deltas: [
        { seat: 0, delta: 90 },
        { seat: 1, delta: -60 },
        { seat: 2, delta: -30 },
      ],
    };

    const res = await makeController(db).moneyDelta(req);
    expect(res).toEqual({ ok: true, data: { matched: [0, 1, 2] } });
    expect(db.players.map((p) => [p.seat, p.money_delta])).toEqual([
      [0, 90],
      [1, -60],
      [2, -30],
    ]);
    expect(db.ddzQueries).toEqual([]);
  });

  it('记录行尚未落库 ⇒ matched=[]（乱序由 outbox 重发收敛）', async () => {
    const res = await makeController(db).moneyDelta({
      roomCode: 'PDK001',
      gameVersion: 99,
      gameType: 'paodekuai',
      playerCount: 3,
      deltas: [
        { seat: 0, delta: 1 },
        { seat: 1, delta: -1 },
        { seat: 2, delta: 0 },
      ],
    });
    expect(res).toEqual({ ok: true, data: { matched: [] } });
  });
});
