import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { ErrCode, RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { AgentUserClient, AgentUserRpcError } from '../src/agent/agent-user.client';

function makeClient(response: unknown) {
  const send = vi.fn((_pattern: string, _payload: unknown) => of(response));
  const client = new AgentUserClient({ send } as never);
  return { client, send };
}

describe('AgentUserClient（currency → user 只读边）', () => {
  it('nicknames：成功解包；空数组不发 RPC', async () => {
    const { client, send } = makeClient({
      ok: true,
      data: { nicknames: [{ userId: 'u1', nickname: '小明' }] },
    });
    await expect(client.nicknames(['u1'])).resolves.toEqual([
      { userId: 'u1', nickname: '小明' },
    ]);
    expect(send).toHaveBeenCalledWith(
      RPC_PATTERNS.userNicknamesGet,
      expect.objectContaining({ userIds: ['u1'] }),
    );

    const empty = makeClient({ ok: true, data: { nicknames: [] } });
    await expect(empty.client.nicknames([])).resolves.toEqual([]);
    expect(empty.send).not.toHaveBeenCalled();
  });

  it('profile：成功解包', async () => {
    const { client, send } = makeClient({
      ok: true,
      data: { userId: 'u1', nickname: '小明', phone: '13800000000' },
    });
    await expect(client.profile('u1')).resolves.toEqual({
      userId: 'u1',
      nickname: '小明',
      phone: '13800000000',
    });
    expect(send).toHaveBeenCalledWith(
      RPC_PATTERNS.userAgentProfileGet,
      expect.objectContaining({ userId: 'u1' }),
    );
  });

  it('业务错误 ⇒ AgentUserRpcError 原码；传输错误 ⇒ 10007', async () => {
    const { client } = makeClient({ ok: false, code: ErrCode.BAD_PARAM, message: 'bad' });
    await expect(client.nicknames(['u1'])).rejects.toMatchObject({
      name: 'AgentUserRpcError',
      code: ErrCode.BAD_PARAM,
    });

    const send = vi.fn(() => throwError(() => new Error('ECONNREFUSED')));
    const down = new AgentUserClient({ send } as never);
    await expect(down.profile('u1')).rejects.toBeInstanceOf(AgentUserRpcError);
    await expect(down.profile('u1')).rejects.toMatchObject({
      code: ErrCode.UPSTREAM_UNAVAILABLE,
    });
  });

  it('nicknames 超过 50 分批拉取（60 ⇒ 50+10），结果合并（r3 Minor #5）', async () => {
    const send = vi.fn((_pattern: string, payload: { userIds: string[] }) =>
      of({
        ok: true,
        data: { nicknames: payload.userIds.map((id) => ({ userId: id, nickname: id })) },
      }),
    );
    const client = new AgentUserClient({ send } as never);
    const ids = Array.from({ length: 60 }, (_, i) => `u${i}`);
    const out = await client.nicknames(ids);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]![1] as { userIds: string[] }).userIds).toHaveLength(50);
    expect((send.mock.calls[1]![1] as { userIds: string[] }).userIds).toHaveLength(10);
    expect(out).toHaveLength(60);
    expect(out[59]).toEqual({ userId: 'u59', nickname: 'u59' });
  });
});
