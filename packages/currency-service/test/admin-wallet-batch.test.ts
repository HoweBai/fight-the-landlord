import { describe, expect, it, vi } from 'vitest';
import { AdminWalletController } from '../src/admin/admin-wallet.controller';

function controllerWith(query: ReturnType<typeof vi.fn>) {
  return new AdminWalletController({} as never, { query } as never);
}

describe('AdminWalletController.batchAccounts（玩家管理页）', () => {
  it('去重 + 未开户补 0/false + 金额归一', async () => {
    const query = vi.fn(async () => [
      { owner_id: 'u1', balance: '120' },
      { owner_id: 'u2', balance: 7 },
    ]);
    const res = await controllerWith(query).batchAccounts({ userIds: ['u1', 'u1', 'u2', 'u3'] });
    expect(res.data.accounts).toEqual([
      { userId: 'u1', balance: 120, exists: true },
      { userId: 'u2', balance: 7, exists: true },
      { userId: 'u3', balance: 0, exists: false },
    ]);
  });

  it('空数组 / 超 100 / 非法元素 ⇒ 400', async () => {
    const c = controllerWith(vi.fn());
    await expect(c.batchAccounts({ userIds: [] })).rejects.toMatchObject({ status: 400 });
    await expect(c.batchAccounts({ userIds: 'u1' })).rejects.toMatchObject({ status: 400 });
    await expect(c.batchAccounts({ userIds: ['u1', 2] })).rejects.toMatchObject({ status: 400 });
    await expect(
      c.batchAccounts({ userIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
