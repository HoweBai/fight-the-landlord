import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { RPC_PATTERNS } from '@fight-the-landlord/protocol';
import { NicknameClient } from '../src/gateway/nickname.client';

function fakeProxy(handler: () => unknown) {
  const calls: Array<{ pattern: string; data: unknown }> = [];
  const send = vi.fn((pattern: string, data: unknown) => {
    calls.push({ pattern, data });
    return handler();
  });
  return { proxy: { send } as never, calls };
}

describe('NicknameClient.getNicknames', () => {
  it('打 user.nicknames.get，返回 userId → nickname 映射', async () => {
    const { proxy, calls } = fakeProxy(() =>
      of({
        ok: true,
        data: {
          nicknames: [
            { userId: 'u1', nickname: '阿豆' },
            { userId: 'u2', nickname: null },
          ],
        },
      }),
    );
    const client = new NicknameClient(proxy);

    const result = await client.getNicknames(['u1', 'u2']);

    expect(calls[0]!.pattern).toBe(RPC_PATTERNS.userNicknamesGet);
    expect(calls[0]!.data).toEqual({ userIds: ['u1', 'u2'] });
    expect(result.get('u1')).toBe('阿豆');
    expect(result.get('u2')).toBeNull();
  });

  it('下游业务错误 ⇒ 空 map（不抛，昵称是展示字段）', async () => {
    const { proxy } = fakeProxy(() => of({ ok: false, code: 10001, message: 'bad' }));
    await expect(new NicknameClient(proxy).getNicknames(['u1'])).resolves.toEqual(new Map());
  });

  it('传输故障 ⇒ 空 map（不抛）', async () => {
    const { proxy } = fakeProxy(() => throwError(() => new Error('ECONNREFUSED')));
    await expect(new NicknameClient(proxy).getNicknames(['u1'])).resolves.toEqual(new Map());
  });

  it('空 userIds ⇒ 空 map 且不发 RPC', async () => {
    const { proxy, calls } = fakeProxy(() => of({ ok: true, data: { nicknames: [] } }));
    await expect(new NicknameClient(proxy).getNicknames([])).resolves.toEqual(new Map());
    expect(calls).toHaveLength(0);
  });
});
