import { describe, expect, it } from 'vitest';
import { RecordsService } from '../src/records/records.service';

/**
 * T12：麻将战绩查询面。
 *
 * 判据：只本人（SQL 身份参数）、只给自己的初始手牌（`ownHand`）、他人行不含手牌字段、
 * 座位/缺门/番/分差原样映射、游标由最后一行生成。
 */
const T0 = Date.parse('2026-10-03T10:00:00.000Z');

function serviceWith(rows: {
  page: unknown[];
  players: unknown[];
}): { service: RecordsService; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const dataSource = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM `game_record_players_mahjong` mine')) {
        return Promise.resolve(rows.page);
      }
      if (sql.includes('FROM `game_record_players_mahjong` WHERE')) {
        return Promise.resolve(rows.players);
      }
      return Promise.reject(new Error(`未识别 SQL：${sql}`));
    },
  };
  return { service: new RecordsService(dataSource as never), calls };
}

describe('RecordsService.getMyMahjongRecords', () => {
  const page = [
    {
      mine_id: 9,
      my_seat: 2,
      ended_at: T0 + 60_000,
      record_id: 7,
      room_code: 'MJ01',
      mode: 'gold',
      player_count: 4,
      base_score: 15,
      dealer_seat: 1,
    },
  ];
  const players = [0, 1, 2, 3].map((seat) => ({
    record_id: 7,
    seat,
    nickname: seat === 0 ? '甲' : null,
    is_robot: seat === 3 ? 1 : 0,
    hand: '1'.repeat(27),
    final_hand: seat === 1 ? '2'.repeat(27) : null,
    melds: [],
    discards: [],
    lack_suit: seat,
    is_out: seat === 1 ? 1 : 0,
    fan: seat === 1 ? 3 : null,
    multiplier: seat === 1 ? 8 : null,
    score_change: seat === 1 ? 30 : seat === 2 ? -10 : -10,
  }));

  it('只查本人 + 只给自己的初始手牌；他人行不含 hand/finalHand', async () => {
    const { service, calls } = serviceWith({ page, players });
    const out = await service.getMyMahjongRecords('u-me');

    expect(calls[0]!.params[0]).toBe('u-me');
    expect(out.items).toHaveLength(1);
    const rec = out.items[0]!;
    expect(rec).toMatchObject({
      roomCode: 'MJ01',
      gameType: 'mahjong',
      mode: 'gold',
      playerCount: 4,
      dealerSeat: 1,
      ownSeat: 2,
      ownHand: '1'.repeat(27),
      endedAt: T0 + 60_000,
    });
    expect(rec.seats).toHaveLength(4);
    expect(rec.seats[0]).toMatchObject({ seat: 0, nickname: '甲', isRobot: false });
    expect(rec.seats[1]).toMatchObject({ seat: 1, isOut: true, fan: 3, delta: 30 });
    expect(rec.seats[3]).toMatchObject({ seat: 3, isRobot: true });
    for (const seat of rec.seats) {
      expect(seat).not.toHaveProperty('hand');
      expect(seat).not.toHaveProperty('finalHand');
    }
    expect(out.nextCursor).toBeNull();
  });

  it('翻页：多取一行判 hasMore，游标出自本页最后一行', async () => {
    const second = { ...page[0]!, mine_id: 8, ended_at: T0 };
    const { service } = serviceWith({ page: [page[0]!, second], players });
    const out = await service.getMyMahjongRecords('u-me', { limit: '1' });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).not.toBeNull();
  });
});
