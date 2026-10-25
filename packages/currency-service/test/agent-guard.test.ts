import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { AgentGuard, AGENT_ID_HEADER, AGENT_VER_HEADER, type AgentRequest } from '../src/agent/agent.guard';

function makeContext(req: Partial<AgentRequest> & { path: string; method: string }) {
  const request: AgentRequest = { headers: {}, ...req };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function makeGuard(row: Record<string, unknown> | null) {
  const dataSource = { query: vi.fn(async () => (row === null ? [] : [row])) };
  return new AgentGuard(dataSource as unknown as DataSource);
}

async function statusOf(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

const okRow = { id: 'ag_1', status: 'active', must_change_password: 0, token_version: 3 };

describe('AgentGuard', () => {
  it('缺 x-agent-id / x-agent-ver ⇒ 401', async () => {
    const guard = makeGuard(okRow);
    for (const headers of [{}, { [AGENT_ID_HEADER]: 'ag_1' }, { [AGENT_VER_HEADER]: '3' }]) {
      const { ctx } = makeContext({ path: '/api/agent/me', method: 'GET', headers });
      expect(await statusOf(() => guard.canActivate(ctx))).toBe(401);
    }
  });

  it('ver 与 token_version 不一致 ⇒ 401（改密/重置后旧令牌失效）', async () => {
    const guard = makeGuard(okRow);
    const { ctx } = makeContext({
      path: '/api/agent/me',
      method: 'GET',
      headers: { [AGENT_ID_HEADER]: 'ag_1', [AGENT_VER_HEADER]: '2' },
    });
    expect(await statusOf(() => guard.canActivate(ctx))).toBe(401);
  });

  it('有效身份 ⇒ true 且写入 agentId；冻结允许', async () => {
    const guard = makeGuard({ ...okRow, status: 'frozen' });
    const { ctx, request } = makeContext({
      path: '/api/agent/overview',
      method: 'GET',
      headers: { [AGENT_ID_HEADER]: 'ag_1', [AGENT_VER_HEADER]: '3' },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.agentId).toBe('ag_1');
  });

  it('must_change_password=1 ⇒ 只放行 me/password', async () => {
    const guard = makeGuard({ ...okRow, must_change_password: 1 });
    const headers = { [AGENT_ID_HEADER]: 'ag_1', [AGENT_VER_HEADER]: '3' };

    for (const [method, path] of [
      ['GET', '/api/agent/me'],
      ['POST', '/api/agent/password'],
    ] as const) {
      const { ctx } = makeContext({ path, method, headers });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
    const { ctx } = makeContext({ path: '/api/agent/overview', method: 'GET', headers });
    expect(await statusOf(() => guard.canActivate(ctx))).toBe(403);
  });

  it('代理不存在 ⇒ 401', async () => {
    const guard = makeGuard(null);
    const { ctx } = makeContext({
      path: '/api/agent/me',
      method: 'GET',
      headers: { [AGENT_ID_HEADER]: 'ag_x', [AGENT_VER_HEADER]: '0' },
    });
    expect(await statusOf(() => guard.canActivate(ctx))).toBe(401);
  });
});
