import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { UserAgentProfileRpcController } from '../src/rpc/user-agent-profile.rpc.controller';
import type { UsersRepository } from '../src/users/users.repository';

function make(repo: Partial<UsersRepository>) {
  return new UserAgentProfileRpcController(repo as UsersRepository);
}

describe('user.agentProfile.get 接收侧', () => {
  it('命中 ⇒ nickname + phone；不存在 ⇒ 双 null', async () => {
    const hit = make({
      findById: vi.fn(async () => ({ nickname: '小明', phone: '13800000000' })) as never,
    });
    await expect(hit.get({ userId: 'u1' })).resolves.toEqual({
      ok: true,
      data: { userId: 'u1', nickname: '小明', phone: '13800000000' },
    });

    const miss = make({ findById: vi.fn(async () => null) as never });
    await expect(miss.get({ userId: 'u2' })).resolves.toEqual({
      ok: true,
      data: { userId: 'u2', nickname: null, phone: null },
    });
  });

  it('非法载荷 ⇒ BAD_PARAM，不查库', async () => {
    const findById = vi.fn();
    const ctl = make({ findById: findById as never });
    for (const bad of [null, {}, { userId: '' }, { userId: 1 }]) {
      const res = await ctl.get(bad as never);
      expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    }
    expect(findById).not.toHaveBeenCalled();
  });

  it('DB 故障 ⇒ UPSTREAM_UNAVAILABLE', async () => {
    const ctl = make({
      findById: vi.fn(async () => {
        throw new Error('db down');
      }) as never,
    });
    await expect(ctl.get({ userId: 'u1' })).resolves.toMatchObject({
      ok: false,
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });
});
