import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import { createInternalTokenMiddleware } from '../src/http/internal-token.middleware';
import { closeServer, mountInternalToken } from './helpers/internal-token-harness';

/**
 * N4/N7：**服务间身份边界**的 HTTP 级断言（§5.2 规则 3，R87–R89）。
 *
 * 曾经的漏洞（N4）：game-service 只有内部路由 `/snapshot` 校验 token，
 * **对外路由全都裸奔** —— 任何人直连 `localhost:3003` 并伪造 `X-User-Id`
 * 就能读到任意玩家的**完整手牌**、并能代其出牌（已有实测证据）。
 * 本用例在**实现中间件之前**必须红：无 token 的业务路由当前能通。
 *
 * ⚠️ health 那一条不是凑数：`docker-compose.yml` 的 healthcheck 是**直连**
 * `localhost:3003/api/health` 的，不豁免 ⇒ 全部容器 unhealthy ⇒ 网关依赖它们
 * ⇒ **一次「加固」把整个平台打成雪崩**（R87②）。
 */
describe('服务间身份边界（N4/N7，R87-R89）', () => {
  let server: Server;
  let baseUrl: string;

  const TOKEN = 'test-internal-token';
  /** 客户端视图路由（§7.1）；网关会把内部 token 注入到**这一跳**（N7）。 */
  const BUSINESS = '/api/games/ABC123';

  /** 中间件在构造时读取 env（与 `main.ts` 的 `app.use(createInternalTokenMiddleware())` 同时刻）。 */
  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_TOKEN = TOKEN;
    const mounted = await mountInternalToken(createInternalTokenMiddleware());
    server = mounted.server;
    baseUrl = mounted.url;
  });

  afterAll(async () => {
    await closeServer(server);
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { headers });

  it('缺少 X-Internal-Token 的业务路由 → 401 + 10002（N4/N7）', async () => {
    const res = await get(BUSINESS);
    // 修前（RED）：200 + 伪造 X-User-Id 就能拿到任意玩家的手牌视图。
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 10002, message: expect.any(String), data: null });
  });

  it('错误的 X-Internal-Token → 401 + 10002', async () => {
    const res = await get(BUSINESS, { 'X-Internal-Token': 'wrong' });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(10002);
  });

  it('正确 token → 放行（且不影响正常的身份校验）', async () => {
    const res = await get(BUSINESS, { 'X-Internal-Token': TOKEN, 'X-User-Id': 'alice' });
    expect(res.status).toBe(200);
    // 放行到的是**业务路由本身**，不是被中间件改写的响应
    expect(await res.json()).toEqual({ status: 'ok', route: BUSINESS });
  });

  it('/api/health 与 /api/health/live 都豁免：无 token 也 200（R87② + R267 的存活面）', async () => {
    // R267：`/api/health` = 就绪（compose 的 healthcheck 用它）；
    // `/api/health/live` = 存活（编排层探针**不带**内部 token，也不该带）。
    for (const path of ['/api/health', '/api/health/live']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
    }
  });

  it('豁免是**精确**匹配：健康路径的近邻仍然 401（否则豁免退化成前缀，门又开了）', async () => {
    // 判别力（R115）：先证明探针能区分「豁免」与「不豁免」—— 上面那条给出 200，
    // 这三条近似写法必须**仍然** 401。若有人把 `exemptPaths.includes` 改成
    // `path.startsWith('/api/health')`，`/api/healthz` 与 `/api/health/livex` 会变 200 ⇒ 红。
    for (const path of ['/api/healthz', '/api/health/livex', '/api/healthx']) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('R89 fail-closed：未配置 INTERNAL_SERVICE_TOKEN 时**一切业务路由都拒**（不是「没配就跳过」）', async () => {
    // 启动期由 `main.ts` 直接 `exit(1)`；这里钉住中间件自身的兜底语义 ——
    // 少这层兜底，「未配置」就真的会变成一个**静默可选开关**。
    const original = process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const mounted = await mountInternalToken(createInternalTokenMiddleware());
    try {
      const res = await fetch(`${mounted.url}${BUSINESS}`, { headers: { 'X-User-Id': 'victim' } });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe(10002);
    } finally {
      await closeServer(mounted.server);
      if (original !== undefined) process.env.INTERNAL_SERVICE_TOKEN = original;
    }
  });
});
