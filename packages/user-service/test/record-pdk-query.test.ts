import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ErrCode } from '@fight-the-landlord/protocol';
import { RecordsService } from '../src/records/records.service';
import { RecordsController } from '../src/records/records.controller';

/**
 * S7.2（spec §4.9.2 / §6.3）：跑得快战绩查询。
 *
 * 判据：pdk 走**单独的两张表**（`game_record_players_pdk`/`game_records_pdk`）；
 * 身份只本人、keyset 分页、JSON 列归一、`score_change`/`won` 读玩家列（A2）、
 * 默认（无 gameType）仍是斗地主表、非法 gameType ⇒ 10001。
 */
const T0 = Date.parse('2026-10-24T10:00:00.000Z');

interface Statement {
  sql: string;
  params: unknown[];
}

interface PdkRecordRow {
  id: number;
  room_code: string;
  mode: string;
  player_count: number;
  base_score: number;
  winner_seat: number;
  remaining: number[];
  multiplier: number;
  bomb_count: number;
  guan: number;
  spring: number;
  baoben_seats: number[];
  score_changes: Array<{ seat: number; delta: number }>;
  ended_at: number;
}

interface PdkPlayerRow {
  id: number;
  record_id: number;
  seat: number;
  user_id: string;
  nickname: string | null;
  hand: string;
  played_count: number;
  score_change: number;
  won: number | string;
  money_delta: number | null;
  ended_at: number;
}

class FakePdkDb {
  records: PdkRecordRow[] = [];
  players: PdkPlayerRow[] = [];
  queries: Statement[] = [];
  nextRecordId = 1;
  nextPlayerId = 1;

  dataSource = {
    query: (sql: string, params: unknown[] = []): Promise<unknown> => {
      this.queries.push({ sql, params });
      if (sql.includes('FROM `game_record_players_pdk` mine')) {
        return Promise.resolve(this.pageQuery(sql, params));
      }
      if (sql.includes('FROM `game_record_players_pdk` WHERE')) {
        return Promise.resolve(this.playersQuery(params));
      }
      return Promise.reject(new Error(`FakePdkDb 未识别的 SQL：${sql}`));
    },
  };

  addGame(opts: {
    roomCode: string;
    ownerId: string;
    ownerSeat: number;
    playerCount?: 2 | 3 | 4;
    mode?: 'random' | 'practice' | 'gold';
    endedAtMs?: number;
    baseScore?: number;
    multiplier?: number;
    winnerSeat?: number;
    moneyDelta?: number | null;
  }): void {
    const id = this.nextRecordId++;
    const playerCount = opts.playerCount ?? 3;
    const winnerSeat = opts.winnerSeat ?? opts.ownerSeat;
    const seats = Array.from({ length: playerCount }, (_, s) => s);
    const delta = (s: number) => (s === winnerSeat ? 30 : -15);
    this.records.push({
      id,
      room_code: opts.roomCode,
      mode: opts.mode ?? 'random',
      player_count: playerCount,
      base_score: opts.baseScore ?? 15,
      winner_seat: winnerSeat,
      remaining: seats.map((s) => (s === winnerSeat ? 0 : 3)),
      multiplier: opts.multiplier ?? 2,
      bomb_count: 1,
      guan: 1,
      spring: 0,
      baoben_seats: [seats.find((s) => s !== winnerSeat) ?? 0],
      score_changes: seats.map((s) => ({ seat: s, delta: delta(s) })),
      ended_at: opts.endedAtMs ?? T0,
    });
    for (const seat of seats) {
      this.players.push({
        id: this.nextPlayerId++,
        record_id: id,
        seat,
        user_id: seat === opts.ownerSeat ? opts.ownerId : `other-${seat}`,
        nickname: seat === opts.ownerSeat ? null : `玩家${seat}`,
        hand: '0f'.repeat(playerCount === 4 ? 12 : 16),
        played_count: seat === winnerSeat ? 16 : 12,
        score_change: delta(seat),
        won: seat === winnerSeat ? 1 : 0,
        money_delta: seat === opts.ownerSeat ? (opts.moneyDelta ?? null) : null,
        ended_at: opts.endedAtMs ?? T0,
      });
    }
  }

  private pageQuery(_sql: string, params: unknown[]): unknown[] {
    const userId = String(params[0]);
    let i = 1;
    const mineByRecord = new Map(
      this.players.filter((p) => p.user_id === userId).map((p) => [p.record_id, p]),
    );
    let rows = this.records.filter((r) => mineByRecord.has(r.id));
    // mode / 日期 / 游标（本文件只覆盖 mode + 游标；日期断言看参数）
    if (String(_sql).includes('r.`mode` = ?')) {
      const mode = params[i++] as string;
      rows = rows.filter((r) => r.mode === mode);
    }
    if (String(_sql).includes('mine.`ended_at` >= ?')) {
      const from = Number(params[i++]);
      const to = Number(params[i++]);
      rows = rows.filter((r) => r.ended_at >= from && r.ended_at < to);
    }
    if (String(_sql).includes('mine.`ended_at` < ?')) {
      const end = Number(params[i++]);
      const same = Number(params[i++]);
      const id = Number(params[i++]);
      rows = rows.filter(
        (r) =>
          r.ended_at < end ||
          (r.ended_at === same && (mineByRecord.get(r.id)?.id ?? 0) < id),
      );
    }
    const limit = Number(params[params.length - 1]);
    return [...rows]
      .sort(
        (a, b) =>
          b.ended_at - a.ended_at ||
          (mineByRecord.get(b.id)?.id ?? 0) - (mineByRecord.get(a.id)?.id ?? 0),
      )
      .slice(0, limit)
      .map((r) => {
        const mine = mineByRecord.get(r.id)!;
        return {
          mine_id: mine.id,
          my_seat: mine.seat,
          money_delta: mine.money_delta,
          ended_at: r.ended_at,
          record_id: r.id,
          room_code: r.room_code,
          mode: r.mode,
          player_count: r.player_count,
          base_score: r.base_score,
          winner_seat: r.winner_seat,
          remaining: r.remaining,
          multiplier: r.multiplier,
          bomb_count: r.bomb_count,
          guan: r.guan,
          spring: r.spring,
          baoben_seats: r.baoben_seats,
          score_changes: r.score_changes,
        };
      });
  }

  private playersQuery(params: unknown[]): unknown[] {
    const ids = params.map(Number);
    return this.players
      .filter((p) => ids.includes(p.record_id))
      .sort((a, b) => a.record_id - b.record_id || a.seat - b.seat)
      .map((p) => ({
        record_id: p.record_id,
        seat: p.seat,
        nickname: p.nickname,
        hand: p.hand,
        played_count: p.played_count,
        score_change: p.score_change,
        won: p.won,
      }));
  }
}

function makeService(db: FakePdkDb): RecordsService {
  return new RecordsService(db.dataSource as never);
}

describe('S7.2：pdk 战绩查询（单独两表）', () => {
  it('返回 PdkRecord：字段/players/playedCount/won/moneyDelta；SQL 只查 pdk 两表且身份=本人', async () => {
    const db = new FakePdkDb();
    db.addGame({
      roomCode: 'PDK1',
      ownerId: 'u1',
      ownerSeat: 1,
      winnerSeat: 0,
      moneyDelta: -30,
    });
    const page = await makeService(db).getMyPdkRecords('u1');

    expect(page.items).toHaveLength(1);
    const record = page.items[0]!;
    expect(record.gameType).toBe('paodekuai');
    expect(record.roomCode).toBe('PDK1');
    expect(record.playerCount).toBe(3);
    expect(record.winnerSeats).toEqual([0]);
    expect(record.remaining).toEqual([0, 3, 3]);
    expect(record.multiplier).toBe(2);
    expect(record.bombCount).toBe(1);
    expect(record.guan).toBe(true);
    expect(record.spring).toBe(false);
    expect(record.baobenSeats).toEqual([1]);
    expect(record.mySeat).toBe(1);
    expect(record.moneyDelta).toBe(-30);
    expect(record.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(record.players.map((p) => p.won)).toEqual([true, false, false]);
    expect(record.players.map((p) => p.scoreChange)).toEqual([30, -15, -15]);
    expect(record.players.every((p) => p.hand.length === 16)).toBe(true);
    expect(record.players[1]!.nickname).toBeNull();

    // 只查 pdk 两表；身份参数 = 调用者
    expect(db.queries.some((q) => q.sql.includes('game_records r'))).toBe(false);
    const pageQuery = db.queries.find((q) => q.sql.includes('FROM `game_record_players_pdk` mine'))!;
    expect(pageQuery.params[0]).toBe('u1');
    expect(pageQuery.params).toContain('u1');
  });

  it('A2：players[].scoreChange/won 读玩家列（不读父 JSON）；won 字符串 0/1 也认', async () => {
    const db = new FakePdkDb();
    db.addGame({ roomCode: 'PDKCOLS', ownerId: 'u1', ownerSeat: 1, winnerSeat: 0 });
    // 把父 JSON 改成与列不同的值：DTO 若仍从 JSON 派生就会红。
    db.records[0]!.score_changes = [
      { seat: 0, delta: 999 },
      { seat: 1, delta: 999 },
      { seat: 2, delta: 999 },
    ];
    db.players[0]!.won = '1';
    db.players[1]!.won = '0';

    const page = await makeService(db).getMyPdkRecords('u1');
    const record = page.items[0]!;
    expect(record.players.map((p) => p.scoreChange)).toEqual([30, -15, -15]);
    expect(record.players.map((p) => p.won)).toEqual([true, false, false]);
  });

  it('4 人局：初始手牌按 12 张解码', async () => {
    const db = new FakePdkDb();
    db.addGame({ roomCode: 'PDK4', ownerId: 'u4', ownerSeat: 3, playerCount: 4, winnerSeat: 3 });
    const page = await makeService(db).getMyPdkRecords('u4');
    expect(page.items[0]!.playerCount).toBe(4);
    expect(page.items[0]!.players.every((p) => p.hand.length === 12)).toBe(true);
  });

  it('keyset 翻页：limit+1 判 hasMore；cursor 原样续页且不重复', async () => {
    const db = new FakePdkDb();
    db.addGame({ roomCode: 'A', ownerId: 'u1', ownerSeat: 0, endedAtMs: T0 + 2 });
    db.addGame({ roomCode: 'B', ownerId: 'u1', ownerSeat: 0, endedAtMs: T0 + 1 });
    db.addGame({ roomCode: 'C', ownerId: 'u1', ownerSeat: 0, endedAtMs: T0 });
    const svc = makeService(db);

    const first = await svc.getMyPdkRecords('u1', { limit: '2' });
    expect(first.items.map((r) => r.roomCode)).toEqual(['A', 'B']);
    expect(first.nextCursor).not.toBeNull();

    const second = await svc.getMyPdkRecords('u1', { limit: '2', cursor: first.nextCursor! });
    expect(second.items.map((r) => r.roomCode)).toEqual(['C']);
    expect(second.nextCursor).toBeNull();

    // 非法游标 ⇒ 10001（不静默回落第一页）
    await expect(svc.getMyPdkRecords('u1', { cursor: 'bogus' })).rejects.toMatchObject({
      code: ErrCode.BAD_PARAM,
    });
  });

  it('mode 筛选：参数绑定且只回匹配行', async () => {
    const db = new FakePdkDb();
    db.addGame({ roomCode: 'G', ownerId: 'u1', ownerSeat: 0, mode: 'gold', endedAtMs: T0 + 1 });
    db.addGame({ roomCode: 'R', ownerId: 'u1', ownerSeat: 0, mode: 'random', endedAtMs: T0 });
    const page = await makeService(db).getMyPdkRecords('u1', { mode: 'gold' });
    expect(page.items.map((r) => r.roomCode)).toEqual(['G']);
    const q = db.queries.find((x) => x.sql.includes('FROM `game_record_players_pdk` mine'))!;
    expect(q.params).toContain('gold');
  });
});

describe('S7.2：控制器 gameType 分支', () => {
  const controllerWith = (svc: Partial<RecordsService>) =>
    new RecordsController(svc as unknown as RecordsService);

  it('缺省/斗地主 ⇒ 调用斗地主查询；paodekuai ⇒ 调用 pdk 查询', async () => {
    const calls: string[] = [];
    const svc = {
      getMyRecords: async () => {
        calls.push('ddz');
        return { items: [], nextCursor: null };
      },
      getMyPdkRecords: async () => {
        calls.push('pdk');
        return { items: [], nextCursor: null };
      },
    };
    const controller = controllerWith(svc as never);
    await controller.mine('u1');
    await controller.mine('u1', undefined, undefined, undefined, undefined, undefined, 'doudizhu');
    await controller.mine('u1', undefined, undefined, undefined, undefined, undefined, 'paodekuai');
    expect(calls).toEqual(['ddz', 'ddz', 'pdk']);
  });

  it('非法 gameType ⇒ 10001（BAD_PARAM）', async () => {
    const controller = controllerWith({} as never);
    let error: unknown;
    try {
      await controller.mine('u1', undefined, undefined, undefined, undefined, undefined, 'mahjong');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({ code: ErrCode.BAD_PARAM });
  });
});
