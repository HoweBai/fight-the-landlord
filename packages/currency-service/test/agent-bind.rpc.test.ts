import { describe, expect, it, vi } from 'vitest';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AgentBindRpcController } from '../src/agent/agent-bind.rpc.controller';
import { DomainError } from '../src/http/errors';
import type { AgentBindingsService } from '../src/agent/agent-bindings.service';

const dto = { ownerId: 'u1', code: 'ABCD2345', phone: '13800000000', source: 'signup' as const };

describe('agent.bind RPC 接收侧', () => {
  it('成功 ⇒ {ok:true,data:{status}}', async () => {
    const bindFromSignup = vi.fn(async () => ({ status: 'bound' as const }));
    const ctl = new AgentBindRpcController({ bindFromSignup } as unknown as AgentBindingsService);
    await expect(ctl.bind(dto)).resolves.toEqual({ ok: true, data: { status: 'bound' } });
  });

  it('DomainError ⇒ 原码原话；未知异常 ⇒ 10007 + 固定文案', async () => {
    const invalid = new AgentBindRpcController({
      bindFromSignup: vi.fn(async () => {
        throw new DomainError(ErrCode.AGENT_INVITE_INVALID, '邀请码无效');
      }),
    } as unknown as AgentBindingsService);
    await expect(invalid.bind(dto)).resolves.toEqual({
      ok: false,
      code: ErrCode.AGENT_INVITE_INVALID,
      message: '邀请码无效',
    });

    const boom = new AgentBindRpcController({
      bindFromSignup: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as AgentBindingsService);
    const res = await boom.bind(dto);
    expect(res).toMatchObject({ ok: false, code: ErrCode.UPSTREAM_UNAVAILABLE });
  });

  it('载荷非法 ⇒ BAD_PARAM，不调用服务', async () => {
    const bindFromSignup = vi.fn();
    const ctl = new AgentBindRpcController({ bindFromSignup } as unknown as AgentBindingsService);
    for (const bad of [
      null,
      {},
      { ...dto, ownerId: '' },
      { ...dto, code: 1 },
      { ...dto, phone: null },
      { ...dto, source: 'admin' },
    ]) {
      const res = await ctl.bind(bad as never);
      expect(res).toMatchObject({ ok: false, code: ErrCode.BAD_PARAM });
    }
    expect(bindFromSignup).not.toHaveBeenCalled();
  });
});
