import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AdminPlayersService } from '../src/players/admin-players.service';
import { AdminPlayersController } from '../src/players/admin-players.controller';
import { DomainError } from '../src/http/errors';

function makeService(over: { redisFail?: boolean } = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    void params;
    // 顺序即判据：summary 的内层也含 pdk 子查询，必须先接。
    if (sql.includes('AS new_today')) {
      return [{ total: 2, new_today: 1, new_7d: 1, active_1d: 1, active_7d: 1, active_30d: 2, inactive_14d: 0, inactive_30d: 0, never_active: 0 }];
    }
    if (sql.includes('SELECT u.id, u.phone')) {
      return [{
        id: 'u1', phone: '13800000001', nickname: '阿明', status: 'active',
        createdAt: '2026-10-01T00:00:00.000Z', last_active_ms: 1761100000000,
      }];
    }
    if (sql.includes('game_record_players_pdk') && sql.includes('COUNT(*) AS games')) {
      return [{ user_id: 'u1', games: 4, wins: 3, last_game_ms: 1761100000000 }];
    }
    if (sql.includes('COUNT(*) AS total')) return [{ total: 2 }];
    if (sql.includes('COUNT(DISTINCT device_id)')) return [{ user_id: 'u1', devices: 2 }];
    if (sql.includes('SUM(p.won)')) return [{ user_id: 'u1', games: 10, wins: 6, last_game: '2026-10-20T00:00:00.000Z' }];
    if (sql.includes('FROM risk_reviews r')) return [{ user_id: 'u1', status: 'open' }];
    if (sql.includes('SELECT p.record_id')) {
      return [{
        record_id: 7, mode: 'gold', base_score: 80, role: 'landlord', won: 1,
        score_change: 160, money_delta: 160, ended_at: '2026-10-20T00:00:00.000Z',
      }];
    }
    if (sql.includes('SELECT id FROM users WHERE id')) return [{ id: 'u1' }];
    return [];
  });
  const redis = {
    zrangebyscore: over.redisFail
      ? vi.fn().mockRejectedValue(new Error('redis down'))
      : vi.fn().mockResolvedValue(['u1']),
    zscore: vi.fn().mockResolvedValue(String(Date.now())),
    zcount: vi.fn().mockResolvedValue(1),
  };
  return { service: new AdminPlayersService({ query } as never, redis as never, { riskDeviceWindowDays: () => 30 } as never), query, redis };
}

describe('AdminPlayersService', () => {
  it('列表映射 + 在线集合 + summary', async () => {
    const { service } = makeService();
    const out = await service.list({ page: 1, pageSize: 20, sort: 'lastActive' });
    expect(out.total).toBe(2);
    expect(out.items[0]).toMatchObject({
      userId: 'u1', phone: '13800000001', nickname: '阿明', online: true,
      deviceCount: 2, games: 14, wins: 9, riskStatus: 'open',
    });
    expect(out.items[0]!.lastActiveAt).toBe(1761100000000);
    expect(out.summary).toMatchObject({ totalPlayers: 2, onlineNow: 1, newToday: 1 });
  });

  it('A2：summary/lastActive 参数单位（active/inactive 阈值 = number；createdAt 阈值 = Date）', async () => {
    const { service, query } = makeService();
    await service.list({ page: 1, pageSize: 20, sort: 'lastActive' });

    const summaryCall = query.mock.calls.find(([sql]) => String(sql).includes('AS new_today'))!;
    const params = summaryCall[1] as unknown[];
    expect(params).toHaveLength(9);
    expect(params[0]).toBeInstanceOf(Date); // new_today
    expect(params[1]).toBeInstanceOf(Date); // new_7d
    for (const i of [2, 3, 4, 5, 7]) expect(typeof params[i], `params[${i}]`).toBe('number');
    expect(params[6]).toBeInstanceOf(Date); // inactive14 createdAt
    expect(params[8]).toBeInstanceOf(Date); // inactive30 createdAt

    const listCall = query.mock.calls.find(([sql]) => String(sql).includes('SELECT u.id, u.phone'))!;
    expect(String(listCall[0])).toContain('TIMESTAMPDIFF');
    expect(String(listCall[0])).toContain('game_record_players_pdk');
  });

  it('A2：activity 筛选阈值绑 number（epoch ms），不是 Date', async () => {
    const { service, query } = makeService();
    await service.list({ page: 1, pageSize: 20, sort: 'lastActive', activity: 'active7' });
    const countCall = query.mock.calls.find(([sql]) => String(sql).includes('COUNT(*) AS total'))!;
    expect(countCall[1]).toEqual([expect.any(Number)]);
    expect(String(countCall[0])).toContain('TIMESTAMPDIFF');
    expect(String(countCall[0])).toContain('game_record_players_pdk');
  });

  it('summary 60s 缓存：第二次不再查汇总 SQL', async () => {
    const { service, query } = makeService();
    await service.list({ page: 1, pageSize: 20, sort: 'lastActive' });
    await service.list({ page: 1, pageSize: 20, sort: 'lastActive' });
    const summaryCalls = query.mock.calls.filter(([sql]) => String(sql).includes('AS new_today'));
    expect(summaryCalls).toHaveLength(1);
  });

  it('Redis 故障降级：online=false，列表不抛错', async () => {
    const { service } = makeService({ redisFail: true });
    const out = await service.list({ page: 1, pageSize: 20, sort: 'lastActive', online: 'online' });
    expect(out.items[0]!.online).toBe(false);
    expect(out.summary.onlineNow).toBe(0);
  });

  it('最近对局：未知用户 404', async () => {
    const query = vi.fn(async () => []);
    const service = new AdminPlayersService(
      { query } as never,
      { zrangebyscore: vi.fn() } as never,
      { riskDeviceWindowDays: () => 30 } as never,
    );
    await expect(service.recentGames('missing', 20)).rejects.toBeInstanceOf(DomainError);
  });

  it('最近对局映射', async () => {
    const { service } = makeService();
    const rows = await service.recentGames('u1', 20);
    expect(rows[0]).toMatchObject({ recordId: 7, mode: 'gold', won: true, scoreChange: 160 });
  });
});

describe('AdminPlayersController 参数校验', () => {
  const controller = new AdminPlayersController({ list: vi.fn(), recentGames: vi.fn() } as never);

  it('未知 query ⇒ 400', async () => {
    await expect(controller.list({ foo: 'bar' })).rejects.toMatchObject({ status: 400 });
  });

  it('pageSize 非法 ⇒ 400', async () => {
    await expect(controller.list({ pageSize: '25' })).rejects.toMatchObject({ status: 400 });
  });

  it('status 非法 ⇒ 400', async () => {
    await expect(controller.list({ status: 'x' })).rejects.toMatchObject({ status: 400 });
  });

  it('games：limit 超界 / 未知键 ⇒ 400', async () => {
    await expect(controller.games('u1', { limit: '51' })).rejects.toMatchObject({ status: 400 });
    await expect(controller.games('u1', { foo: '1' })).rejects.toMatchObject({ status: 400 });
  });

  it('错误码走 10001', async () => {
    const err = await controller.list({ page: '0' }).catch((e) => e);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse().code).toBe(ErrCode.BAD_PARAM);
  });
});
