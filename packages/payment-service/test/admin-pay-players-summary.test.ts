import { describe, expect, it, vi } from 'vitest';
import { AdminPayController } from '../src/admin/admin-pay.controller';

function controllerWith(query: ReturnType<typeof vi.fn>) {
  return new AdminPayController({ query } as never, {} as never, {} as never, {} as never);
}

describe('AdminPayController.playersSummary（玩家管理页）', () => {
  it('按 credited_at 聚合 + 去重 + 无记录补 0/null', async () => {
    const query = vi.fn(async () => [
      { user_id: 'u1', cnt: 2, fen: '1200', last_at: '2026-10-20T00:00:00.000Z' },
    ]);
    const res = await controllerWith(query).playersSummary({ userIds: ['u1', 'u1', 'u2'] });
    expect(res.data.players).toEqual([
      { userId: 'u1', rechargeCount: 2, rechargeFen: 1200, lastRechargeAt: 1792454400000 },
      { userId: 'u2', rechargeCount: 0, rechargeFen: 0, lastRechargeAt: null },
    ]);
    const firstSql = (query.mock.calls[0] as unknown[] | undefined)?.[0];
    expect(String(firstSql)).toContain('credited_at IS NOT NULL');
  });

  it('空数组 / 超 100 / 非法元素 ⇒ 400', async () => {
    const c = controllerWith(vi.fn());
    await expect(c.playersSummary({ userIds: [] })).rejects.toMatchObject({ status: 400 });
    await expect(c.playersSummary({ userIds: [null] })).rejects.toMatchObject({ status: 400 });
    await expect(
      c.playersSummary({ userIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
