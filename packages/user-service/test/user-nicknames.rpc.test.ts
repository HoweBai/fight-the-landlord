import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import {
  USER_NICKNAMES_MAX_BATCH,
  UserNicknamesRpcController,
} from '../src/rpc/user-nicknames.rpc.controller';

function makeRepo(rows: Array<{ id: string; nickname: string | null }>) {
  return { findNicknamesByIds: vi.fn(async () => rows) };
}

describe('user.nicknames.get 接收侧', () => {
  it('批量返回，保持请求顺序；未找到的 userId ⇒ nickname:null', async () => {
    const repo = makeRepo([{ id: 'u2', nickname: '阿豆' }]);
    const controller = new UserNicknamesRpcController(repo as never);

    await expect(controller.get({ userIds: ['u1', 'u2'] })).resolves.toEqual({
      ok: true,
      data: {
        nicknames: [
          { userId: 'u1', nickname: null },
          { userId: 'u2', nickname: '阿豆' },
        ],
      },
    });
  });

  it('空数组不查库', async () => {
    const repo = makeRepo([]);
    const controller = new UserNicknamesRpcController(repo as never);

    await expect(controller.get({ userIds: [] })).resolves.toEqual({
      ok: true,
      data: { nicknames: [] },
    });
    expect(repo.findNicknamesByIds).not.toHaveBeenCalled();
  });

  it('非法载荷 ⇒ BAD_PARAM', async () => {
    const controller = new UserNicknamesRpcController(makeRepo([]) as never);

    for (const dto of [
      {},
      { userIds: 'u1' },
      { userIds: [''] },
      { userIds: Array.from({ length: USER_NICKNAMES_MAX_BATCH + 1 }, (_, i) => `u${i}`) },
    ]) {
      const res = await controller.get(dto as never);
      expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    }
  });

  it('数据库故障 ⇒ UPSTREAM_UNAVAILABLE（不抛）', async () => {
    const repo = {
      findNicknamesByIds: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    const controller = new UserNicknamesRpcController(repo as never);

    await expect(controller.get({ userIds: ['u1'] })).resolves.toMatchObject({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });
});
