import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  AGENT_JWT_AUDIENCE,
  AGENT_JWT_TYP,
  AgentAuthMiddleware,
  agentJwtSecret,
} from '../src/auth/agent.middleware';
import { AGENT_ID_HEADER, AGENT_VER_HEADER } from '../src/auth/identity-headers';

const REPO = join(fileURLToPath(new URL('../../..', import.meta.url)));

function makeReq(path: string, headers: Record<string, string> = {}) {
  return { originalUrl: path, url: path, headers: { ...headers } } as never;
}

async function statusOf(fn: () => Promise<void>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (err) {
    return err instanceof HttpException ? err.getStatus() : -1;
  }
}

function tokenWith(payload: Record<string, unknown>, audience = AGENT_JWT_AUDIENCE): string {
  return new JwtService({ secret: agentJwtSecret() }).sign(payload, {
    expiresIn: 60,
    audience,
  });
}

afterEach(() => {
  delete process.env.AGENT_JWT_SECRET;
});

describe('AgentAuthMiddleware', () => {
  it('登录路径豁免；非 agent 路径 next 且剥伪造头', async () => {
    process.env.AGENT_JWT_SECRET = 'test-agent-secret';
    const mw = new AgentAuthMiddleware();
    const next = vi.fn();

    const login = makeReq('/api/agent/login', {
      [AGENT_ID_HEADER]: 'evil',
      [AGENT_VER_HEADER]: '9',
    });
    await mw.use(login, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect((login as { headers: Record<string, unknown> }).headers[AGENT_ID_HEADER]).toBeUndefined();

    const other = makeReq('/api/admin/config', { [AGENT_ID_HEADER]: 'evil' });
    await mw.use(other, {} as never, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect((other as { headers: Record<string, unknown> }).headers[AGENT_ID_HEADER]).toBeUndefined();
  });

  it('缺 Bearer / 坏令牌 / 错 aud / 错 typ / 错 sub ⇒ 401', async () => {
    process.env.AGENT_JWT_SECRET = 'test-agent-secret';
    const mw = new AgentAuthMiddleware();
    const next = vi.fn();

    expect(await statusOf(() => mw.use(makeReq('/api/agent/me'), {} as never, next))).toBe(401);
    expect(
      await statusOf(() =>
        mw.use(makeReq('/api/agent/me', { authorization: 'Bearer bad' }), {} as never, next),
      ),
    ).toBe(401);
    expect(
      await statusOf(() =>
        mw.use(
          makeReq('/api/agent/me', {
            authorization: `Bearer ${tokenWith({ sub: 'ag_1', typ: AGENT_JWT_TYP, ver: 3 }, 'ftl-admin')}`,
          }),
          {} as never,
          next,
        ),
      ),
    ).toBe(401);
    for (const payload of [
      { sub: 'ag_1', typ: 'other', ver: 3 },
      { sub: 'user_1', typ: AGENT_JWT_TYP, ver: 3 },
      { sub: 'ag_1', typ: AGENT_JWT_TYP, ver: -1 },
      { sub: 'ag_1', typ: AGENT_JWT_TYP },
    ]) {
      expect(
        await statusOf(() =>
          mw.use(
            makeReq('/api/agent/me', {
              authorization: `Bearer ${tokenWith(payload)}`,
            }),
            {} as never,
            next,
          ),
        ),
      ).toBe(401);
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('有效令牌 ⇒ 注入 x-agent-id / x-agent-ver（覆盖客户端伪造值）', async () => {
    process.env.AGENT_JWT_SECRET = 'test-agent-secret';
    const mw = new AgentAuthMiddleware();
    const next = vi.fn();
    const req = makeReq('/api/agent/overview', {
      authorization: `Bearer ${tokenWith({ sub: 'ag_1', typ: AGENT_JWT_TYP, ver: 7 })}`,
      [AGENT_ID_HEADER]: 'evil',
      [AGENT_VER_HEADER]: '9',
    });

    await mw.use(req, {} as never, next);

    const headers = (req as { headers: Record<string, unknown> }).headers;
    expect(headers[AGENT_ID_HEADER]).toBe('ag_1');
    expect(headers[AGENT_VER_HEADER]).toBe('7');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('跨服务密钥链逐字同源：常量统一从 protocol 包 import，消除手工同步', () => {
    const currency = readFileSync(
      join(REPO, 'packages/currency-service/src/agent/agent-auth.service.ts'),
      'utf-8',
    );
    const gateway = readFileSync(join(REPO, 'packages/api-gateway/src/auth/agent.middleware.ts'), 'utf-8');
    const protocolSrc = readFileSync(
      join(REPO, 'packages/protocol/src/agent-auth.ts'),
      'utf-8',
    );
    const fallbackLine = "AGENT_JWT_SECRET_FALLBACK = 'dev-secret-change-in-production'";
    // 常量真源必须在 protocol
    expect(protocolSrc).toContain(fallbackLine);
    expect(protocolSrc).toContain("AGENT_JWT_AUDIENCE = 'ftl-agent'");
    expect(protocolSrc).toContain("AGENT_JWT_TYP = 'agent-access'");
    // 两侧不得再自定义常量，必须从 protocol import
    for (const source of [currency, gateway]) {
      expect(source).toMatch(/from ['"]@fight-the-landlord\/protocol['"]/);
      expect(source).toContain('AGENT_JWT_SECRET_FALLBACK');
      expect(source).toContain("'ftl-agent'");
      // 各自仍有密钥解析函数（依赖 process.env，留在服务内）
      expect(source).toContain('process.env.AGENT_JWT_SECRET ||');
      expect(source).toContain('process.env.JWT_SECRET ||');
    }
  });
});
