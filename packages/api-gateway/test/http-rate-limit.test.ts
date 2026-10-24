import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { createCapturingSink, createRedactingLogger } from '@fight-the-landlord/shared';
import { HttpRateLimitMiddleware } from '../src/http/http-rate-limit.middleware';
import { AdminAuthMiddleware } from '../src/auth/admin.middleware';
import {
  ADMIN_LOGIN_FAIL,
  ADMIN_WRITE,
  HTTP_IP_RATE_LIMIT,
  HTTP_RATE_LIMIT,
  PAY_ORDER_CREATE_LIMIT,
  PAY_ORDER_SYNC_LIMIT,
  PAY_REFUND_APPLY_LIMIT,
  PAY_WITHDRAW_APPLY_LIMIT,
  THROTTLED_RATE_LIMIT,
  adminLoginFailKey,
  adminWriteKey,
  clearAdminLoginFailures,
  hitPayLimit,
  isAdminLoginBlocked,
  isIpRateLimited,
  payLimitBucketOf,
  payRateLimitKey,
  recordAdminLoginFailure,
} from '../src/http/rate-limit';

/** 用例自己控制的「现在」：滑动窗口的判据必须能控制时刻，否则「窗口」这条语义测不出来。 */
const NOW = 1_700_000_000_000;

/**
 * **状态化**的内存 ZSet（只实现 §5.4 滑动窗口用到的四个命令）。
 *
 * ⚠️ 必须**真的**存成员：用「调用次数」当替身的话，「120 次之后第 121 次被拒」这条判据
 * 对自己的计数错误完全免疫 —— 而 member 必须是 `now-随机`（ZSET 成员唯一：同一毫秒的
 * 120 次请求若共用一个 member，窗口里就只剩 1 条）恰恰是这条判据真正在测的东西。
 * 教训同 `packages/room-service/test/helpers/fake-redis.ts`：替身的宽容度就是对缺陷的容忍度。
 *
 * ⚠️ 片⑦ T10 追加 `counters`（`INCR`/`GET`/`DEL`/`PEXPIRE`）：admin 登录失败桶是
 * **响应感知计数**（不是 ZSET 滑动窗），同样必须**真的**存数 —— 否则「5 次后第 6 次 429」
 * 会退化成只看调用次数。
 */
function makeZsetRedis() {
  const zsets = new Map<string, Map<string, number>>();
  /** `ratelimit:admin-login-fail:*` 的计数状态（真实 incr/get/del 语义，不共享 zsets）。 */
  const counters = new Map<string, number>();
  /**
   * 风控 T7 追加：风控旗（`risk:limit:{userId}` 等）的状态化替身 —— `exists` 真的按
   * **成员**判定（「旗在/旗无」两态各有判别力；用「调用次数」当替身会让旗在/旗无同形）。
   */
  const flags = new Set<string>();
  return {
    zsets,
    counters,
    flags,
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let removed = 0;
      for (const [member, score] of [...zset]) {
        if (score >= min && score <= max) {
          zset.delete(member);
          removed += 1;
        }
      }
      return removed;
    }),
    zcard: vi.fn(async (key: string) => zsets.get(key)?.size ?? 0),
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const zset = zsets.get(key) ?? new Map<string, number>();
      zset.set(member, score);
      zsets.set(key, zset);
      return 1;
    }),
    expire: vi.fn(async () => 1),
    // ── T10：admin 登录失败桶（INCR + 首次 PEXPIRE / GET / DEL）──────────
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    get: vi.fn(async (key: string) => {
      const value = counters.get(key);
      return value === undefined ? null : String(value);
    }),
    del: vi.fn(async (key: string) => (counters.delete(key) ? 1 : 0)),
    pexpire: vi.fn(async () => 1),
    // ── 风控 T7：旗读（EXISTS `risk:limit:{userId}`）────────────────────
    exists: vi.fn(async (key: string) => (flags.has(key) ? 1 : 0)),
  };
}

/**
 * 响应替身（在**同一处**升级以保持「一份实现」）：
 *  - `statusCode` + `on('finish')`：T10 登录分支的**响应感知**钩子（成功/失败由下游
 *    状态码决定，钩子读的就是 `res.statusCode`）；
 *  - `emitFinish(code)`：测试手动模拟「响应真正发完」（Express 的 `finish` 事件）。
 *
 * ⚠️ 钩子里的续体是 `void record…()`（**async**）—— emitFinish 之后要
 * `await flushFinishHook()` 才能看到计数落进假 Redis。
 */
function mount(redis: unknown) {
  const mw = new HttpRateLimitMiddleware(redis as never);
  const calls: Array<Record<string, unknown>> = [];
  const res = () => {
    const out: Record<string, unknown> = { status: 200 };
    const finishHandlers: Array<() => void> = [];
    const double = {
      statusCode: 200,
      status(code: number) { out.status = code; double.statusCode = code; return double; },
      json(body: unknown) { out.body = body; calls.push(out); return double; },
      on(event: string, handler: () => void) {
        if (event === 'finish') finishHandlers.push(handler);
        return double;
      },
      /** 模拟 Express：响应真正发完（下游状态码写进 `statusCode` 并触发 finish 钩子）。 */
      emitFinish(statusCode: number) {
        double.statusCode = statusCode;
        out.status = statusCode;
        for (const handler of finishHandlers) handler();
      },
    };
    return double;
  };
  return { mw, calls, res };
}

/** 等 finish 钩子的 async 续体（`void record…()`）跑完。 */
const flushFinishHook = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('HTTP 限流中间件（§5.4 / R141）', () => {
  // ⚠️ 每个假 Redis 都必须实现 `zremrangebyscore`（`hitHttpLimit` 的第一步就调它）。
  //    漏了它会在中间件的 catch 里变成 503 —— 用例会以「fail-closed 生效」的**假象**通过/失败。
  /**
   * ⚠️ 标题与判据在 P11 被**收窄**（原为「完全不计数 / 一次 Redis 都不打」）：
   * R453 新增了第五个维度「单 IP HTTP」，公开路径从此**必然**要打 Redis（按 IP 记账）。
   * 这条用例要守的东西没变 —— **用户维度**不得被公开路径碰到（R141/R146 的投毒面）。
   */
  it('公开路径（没有已认证的 x-user-id）**不按用户计数**，但仍按 IP 计数（R141 + R453）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);
    const next = vi.fn();
    await mw.use({ headers: {}, ip: '203.0.113.7' } as never, res() as never, next);

    expect(next).toHaveBeenCalled();
    // 桶**只有** IP 那一个：用户维度的键一次都没建/没查
    expect([...redis.zsets.keys()]).toEqual(['ratelimit:http-ip:203.0.113.7']);
    expect(redis.zcard).toHaveBeenCalledTimes(1);
    expect(redis.zcard).toHaveBeenCalledWith('ratelimit:http-ip:203.0.113.7');
  });

  it('已认证用户超过 20/5s → 429 + 10006；前 20 次 next()', async () => {
    // ⚠️ 必须用**状态化** ZSet 替身：两个维度的桶要能分别计数。
    //    旧替身用「一个共享计数器」模拟 zcard/zadd ⇒ IP 维度的记账会把用户维度提前顶到 20
    //    （第 11 次就 429），症状是「用户限流变成了 10/5s」这种**看起来像限流生效**的假红。
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);
    for (let i = 0; i < HTTP_RATE_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use({ headers: { 'x-user-id': 'u1' }, ip: '203.0.113.7' } as never, res() as never, next);
      expect(next).toHaveBeenCalled();
    }
    const next = vi.fn();
    await mw.use({ headers: { 'x-user-id': 'u1' }, ip: '203.0.113.7' } as never, res() as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 429, body: { code: 10006, message: expect.any(String), data: null } });
    // 正对照：这次拒绝来自**用户**桶（IP 桶只有 21 条，离 120 还远）
    // —— 否则「429」可能只是 IP 阈值被写成了某个更小的值。
    expect(redis.zsets.get('ratelimit:http:u1')?.size).toBe(HTTP_RATE_LIMIT.max);
    expect(redis.zsets.get('ratelimit:http-ip:203.0.113.7')?.size).toBe(HTTP_RATE_LIMIT.max + 1);
    expect(redis.zsets.get('ratelimit:http-ip:203.0.113.7')!.size).toBeLessThan(HTTP_IP_RATE_LIMIT.max);
  });

  it('Redis 故障 → **fail closed**（503 + 10007），不得静默放行', async () => {
    const redis = {
      zremrangebyscore: vi.fn(async () => 0),
      zcard: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      zadd: vi.fn(),
      expire: vi.fn(),
    };
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use({ headers: { 'x-user-id': 'u1' }, ip: '203.0.113.7' } as never, res() as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 503, body: { code: 10007, message: expect.any(String), data: null } });
  });

  /**
   * IP 维度把**未认证路径**（`auth/*`）也纳入了计数 ⇒ 它同时把它们纳入了 fail-closed。
   * 这是 R453 的必然连带（「计数不可用就放行」会让 IP 维度变成静默可选开关）。
   *
   * ⚠️ R462 收窄：**健康端点不在此列**（见文件末尾的 R462 一组）—— §2.4 的存活面
   * **不查依赖**，就绪面的响应体是 `{status,service,checks}`，两者都不能被改写成 `10007`。
   */
  it('未认证的 `auth/*` 在 Redis 故障时 fail-closed（503 + 10007），不得静默放行', async () => {
    const redis = {
      zremrangebyscore: vi.fn(async () => 0),
      zcard: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      zadd: vi.fn(),
      expire: vi.fn(),
    };
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use(
      { originalUrl: '/api/auth/register', headers: {}, ip: '203.0.113.7' } as never,
      res() as never,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 503, body: { code: 10007, message: expect.any(String), data: null } });
  });

  /**
   * R141①：**用户维度**的桶是「已认证的 userId」，所以「没有 x-user-id」与「空字符串」
   * 都**不得**碰 `ratelimit:http:` 那个桶。否则 R146 之前那条「拿别人的 X-User-Id 打
   * 公开路径」的投毒路径会从另一个口子回来。
   *
   * ⚠️ P11/R453 收窄：IP 桶（`ratelimit:http-ip:`）**必须**被记账 —— 被判据钉住的
   * 是「哪个桶」，不是「有没有打 Redis」。
   */
  it('空字符串的 x-user-id 不按用户计数（只在**验签后**的非空字符串上计）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);
    const next = vi.fn();
    await mw.use({ headers: { 'x-user-id': '' }, ip: '203.0.113.7' } as never, res() as never, next);

    expect(next).toHaveBeenCalled();
    // 用户桶一个键都没建（IP 桶不受影响，见 R453）
    expect([...redis.zsets.keys()]).toEqual(['ratelimit:http-ip:203.0.113.7']);
  });

  /**
   * Express 把头解析成 `string | string[]`。数组形态取**首元素**（与
   * `gateway.controller.ts` 的 `headersOf()`、`jwt.middleware.ts` 的取值一致）——
   * 三处**同一口径**，否则「限流按谁计」与「身份转发给谁」会漂移。
   */
  it('数组形态的 x-user-id 取首元素计数（与 headersOf 同口径）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);
    const next = vi.fn();
    await mw.use({ headers: { 'x-user-id': ['u1', 'u2'] }, ip: '203.0.113.7' } as never, res() as never, next);

    expect(next).toHaveBeenCalled();
    expect(redis.zcard).toHaveBeenCalledWith('ratelimit:http:u1');
  });
});

/**
 * §5.4 的**第五个维度：单 IP HTTP**（N13 / R453）。
 *
 * N13 登记时的阻塞逐字是「凭空加一维会打伤 conformance 的造数步骤（`slice-07.1`
 * 一次连发 20 个注册）」—— 因此这一组必须同时含**正对照**（那 20 连发全部放行）。
 */
describe('单 IP HTTP 维度（§5.4 第五维 / N13 / R453）', () => {
  it('阈值就是裁决值 120 次 / 60 秒（不是 §5.4 表格里单用户的 20/5s）', () => {
    // R453 逐字：「IP 维度阈值取 { max: 120, windowMs: 60_000 }」。
    // 断言**字面量**：用常量自比会让「把阈值改成 20 或 1200」这类漂移完全测不出来。
    expect(HTTP_IP_RATE_LIMIT).toEqual({ max: 120, windowMs: 60_000 });
  });

  it('同一 IP 在窗口内超过 120 次请求会被拒（N13/R453）', async () => {
    const redis = makeZsetRedis();
    for (let i = 0; i < HTTP_IP_RATE_LIMIT.max; i += 1) {
      expect(await isIpRateLimited(redis as never, '203.0.113.7', NOW)).toBe(false);
    }
    // 第 121 次：`>= max` ⇒ 拒绝
    expect(await isIpRateLimited(redis as never, '203.0.113.7', NOW)).toBe(true);
  });

  it('正对照：conformance 的 20 连发注册必须全部放行（N13/R453 —— 这就是原登记的阻塞）', async () => {
    // `slice-07.1-room-atomic-seating.ts:43` 的 `BURST = 20`：原登记说「凭空加一维会打伤
    // 造数步骤」，120/min 下它只占 1/6。写成**字面量 20**（不引用 conformance 的常量）：
    // 这条判据的内容就是「20 这个规模的突发不受影响」。
    const redis = makeZsetRedis();
    for (let i = 0; i < 20; i += 1) {
      expect(await isIpRateLimited(redis as never, '198.51.100.9', NOW)).toBe(false);
    }
  });

  it('不同 IP 互不影响（桶的维度是 IP，不是全局）', async () => {
    const redis = makeZsetRedis();
    for (let i = 0; i < HTTP_IP_RATE_LIMIT.max; i += 1) {
      await isIpRateLimited(redis as never, 'A', NOW);
    }
    expect(await isIpRateLimited(redis as never, 'A', NOW)).toBe(true);
    expect(await isIpRateLimited(redis as never, 'B', NOW)).toBe(false);
  });

  it('窗口滑出后重新放行（ZREMRANGEBYSCORE 真的按窗口清理）', async () => {
    const redis = makeZsetRedis();
    for (let i = 0; i < HTTP_IP_RATE_LIMIT.max; i += 1) {
      await isIpRateLimited(redis as never, 'C', NOW);
    }
    expect(await isIpRateLimited(redis as never, 'C', NOW)).toBe(true);
    // 越过整个窗口 ⇒ 老成员全部滑出
    expect(await isIpRateLimited(redis as never, 'C', NOW + HTTP_IP_RATE_LIMIT.windowMs)).toBe(false);
  });

  /**
   * **接线判据**（本片的关键一条）：N13 的缺口是「登录/注册/刷新无 IP 维度限流」，
   * 而这三条路径**永远没有**已认证的 `x-user-id`。因此 IP 判定必须在
   * 「没有 x-user-id 就 next()」那条早退**之前** —— 否则该维度对它们完全不可达，
   * N13 名义上关闭、实质上没关。
   *
   * 判据同时钉住两件事：① 未认证请求在第 121 次拿到 **429 + `10006` + `{code,message,data:null}`**
   * （与既有 429 响应**同形**）；② 用户维度的桶（`ratelimit:http:`）**一次都没被碰**
   * （R141/R146：客户端伪造 `X-User-Id` 不能投毒）。
   */
  it('未认证路径（登录/注册/刷新的形状）也会被 IP 维度拦住：第 121 次 429 + 10006', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < HTTP_IP_RATE_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use(
        { originalUrl: '/api/auth/register', headers: {}, ip: '203.0.113.7' } as never,
        res() as never,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
    }
    const next = vi.fn();
    await mw.use(
      { originalUrl: '/api/auth/register', headers: {}, ip: '203.0.113.7' } as never,
      res() as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 429,
      body: { code: 10006, message: expect.any(String), data: null },
    });
    // 用户维度的键必须**一次都没碰**（IP 键叫 `ratelimit:http-ip:`，不是 `ratelimit:http:`）
    expect(redis.zadd).not.toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:http:/),
      expect.any(Number),
      expect.any(String),
    );
    expect(redis.zadd).toHaveBeenCalledWith(
      'ratelimit:http-ip:203.0.113.7',
      expect.any(Number),
      expect.any(String),
    );
  });
});

/**
 * **R462：健康端点豁免 IP 维度。**
 *
 * 事实（协调者门禁实测原文，不是推断）：
 * ```
 * ❌ slice-07.2-deploy 失败：一次性容器 30s 内没有在 http://localhost:3999 提供存活面
 *    （容器日志尾部：[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6399 …）
 * ```
 * 该切片起一次性容器 + `REDIS_URL=redis://127.0.0.1:6399`（无监听）后请求 `GET /api/health/live`；
 * P11 的第一版实现把 IP 判定放在「没有 userId 就放行」的早退**之前**，而那条早退此前**同时**
 * 是「健康端点不进 Redis」的原因 ⇒ 存活面被 `catch` 判成 fail-closed **503 + 10007**。
 *
 * §2.4 / R267 / R285 逐字：`GET /api/health/live` = **存活**（**不查任何依赖**、恒 **200**、
 * 响应体不含 `checks`）；`GET /api/health` = **就绪**（按 `status` 返 200/503，响应体
 * `{status, service, checks}`）。**两者都不能被限流中间件改写成 `{code, message, data:null}`** ——
 * 否则编排层的存活探针会在 Redis 抖动时杀掉一个健康的进程（这正是 R267 分两个端点的理由）。
 *
 * 判据纪律（R115）：**正对照必须在同一组里** —— 同样的抛错替身下 `auth/*` 仍要 fail-closed，
 * 否则「豁免」会被写成「整个中间件失效」。
 */
describe('R462：健康端点豁免（§2.4 存活面不查依赖）', () => {
  /** 任何一次访问都失败的 Redis 替身（模拟 deploy 切片的 `REDIS_URL` 无监听）。 */
  const brokenRedis = () => ({
    zremrangebyscore: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    zcard: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    zadd: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    expire: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
  });

  it('R462①：`/api/health/live` 在 Redis 不可用时**仍放行**且一次 Redis 都不打（存活面不查依赖）', async () => {
    const redis = brokenRedis();
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use(
      { originalUrl: '/api/health/live', headers: {}, ip: '203.0.113.7' } as never,
      res() as never,
      next,
    );

    // ⚠️ `calls` 先断言：RED 现场它会把限流中间件写下的 **503 + 10007** 原文打出来
    //    （那正是 R462 的回归证据），而不是只报一句「next 没被调用」。
    expect(calls).toEqual([]); // 没有 503（也没有 429）
    expect(next).toHaveBeenCalledTimes(1);
    expect(redis.zcard).not.toHaveBeenCalled();
    expect(redis.zadd).not.toHaveBeenCalled();
  });

  it('R462①′：`/api/health`（就绪面）同样豁免 —— 它的响应体由 §2.4 规定为 {status,service,checks}', async () => {
    const redis = brokenRedis();
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use(
      { originalUrl: '/api/health', headers: {}, ip: '203.0.113.7' } as never,
      res() as never,
      next,
    );

    // 就绪面自己的「degraded ⇒ 503」由 `HealthController.check()` 决定，**不是**限流中间件
    // 写一个 `10007` 信封（那会破坏 §2.4 的响应体形状与 compose healthcheck 的判读）。
    expect(calls).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
    expect(redis.zcard).not.toHaveBeenCalled();
  });

  it('R462② 正对照：同一个抛错替身下 `/api/auth/register` **必须** fail-closed（503 + 10007）', async () => {
    const redis = brokenRedis();
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use(
      { originalUrl: '/api/auth/register', headers: {}, ip: '203.0.113.7' } as never,
      res() as never,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 503,
      body: { code: 10007, message: expect.any(String), data: null },
    });
  });
});

/**
 * 片⑦ T10（设计 D6 / spec F4+F5 / C15）：admin 两桶。
 *
 *  - **登录失败桶**：单 IP 5 次 / 5 分钟，**失败计次（响应 finish 钩子：401 ⇒ 计、
 *    200 ⇒ 清、其余不计）、成功清零** —— 与既有「请求计数」族**形态不同**（新实现点）；
 *  - **管理写桶**：按管理令牌指纹（sha256 前 16 位）30 次 / 5 分钟（ZSET 滑动窗）；
 *  - **跳过面**：登录与持令牌写**跳过**既有 IP 维（本桶更严/更有针对性）；持令牌
 *    非写路径（GET）**保留** IP 维；**无令牌/坏令牌**在 `AdminAuthMiddleware` 处
 *    立即 401 —— 显式登记的接受口径（成本低、无放大面）。
 *
 * ⚠️ **达界语义**（spec F5 逐字：**桶达界 ⇒ 正确口令也 429**；「检查在比较之前」）：
 * 第 6 次请求在**入口**就被拒、`next()` 根本不发生 ⇒ 下游**永远不会比较口令**
 * —— 这就是「正确口令也 429」的机制（C15 在真栈上钉同一条）。
 */
describe('片⑦ T10：admin 两桶（登录失败桶 / 持令牌写桶）', () => {
  const ADMIN_IP = '203.0.113.9';

  /** 登录请求（无 X-Admin —— 它是豁免入口本身，由 AdminAuth 放行）。 */
  const LOGIN = () => ({
    originalUrl: '/api/admin/login',
    url: '/api/admin/login',
    method: 'POST',
    headers: {} as Record<string, unknown>,
    ip: ADMIN_IP,
  });
  /** 持令牌写请求（`X-Admin: 1` + `adminTokenFp` 都是 T9 中间件的**验真产物**）。 */
  const ADMIN_PUT = (fp = 'fp-abc') => ({
    originalUrl: '/api/admin/config/room.friendRoomEnabled',
    url: '/api/admin/config/room.friendRoomEnabled',
    method: 'PUT',
    headers: { 'x-admin': '1' } as Record<string, unknown>,
    adminTokenFp: fp,
    ip: ADMIN_IP,
  });
  /** 持令牌但**非写**路径：保留既有 IP 维（spec F5）。 */
  const ADMIN_GET = () => ({
    originalUrl: '/api/admin/config',
    url: '/api/admin/config',
    method: 'GET',
    headers: { 'x-admin': '1' } as Record<string, unknown>,
    ip: ADMIN_IP,
  });

  it('阈值与键名逐字（规格 §2.6：登录 5/5min、写 30/5min；别的字面量都不算数）', () => {
    expect(ADMIN_LOGIN_FAIL).toEqual({ max: 5, windowMs: 300_000 });
    expect(ADMIN_WRITE).toEqual({ max: 30, windowMs: 300_000 });
    expect(adminLoginFailKey('1.2.3.4')).toBe('ratelimit:admin-login-fail:1.2.3.4');
    expect(adminWriteKey('deadbeef')).toBe('ratelimit:admin-write:deadbeef');
  });

  it('达界语义（GET ≥ max ⇒ true）与失败计次（INCR + **首次** PEXPIRE、成功清零）', async () => {
    const redis = makeZsetRedis();
    for (let i = 0; i < ADMIN_LOGIN_FAIL.max - 1; i += 1) {
      await recordAdminLoginFailure(redis as never, ADMIN_IP);
    }
    expect(await isAdminLoginBlocked(redis as never, ADMIN_IP)).toBe(false); // 4 < 5
    await recordAdminLoginFailure(redis as never, ADMIN_IP); // 第 5 次失败
    expect(await isAdminLoginBlocked(redis as never, ADMIN_IP)).toBe(true); // 5 ≥ 5

    // TTL 只在**首次** INCR 时设置（窗口从第一次失败起算，不被后续失败顺延）
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
    expect(redis.pexpire).toHaveBeenCalledWith(adminLoginFailKey(ADMIN_IP), ADMIN_LOGIN_FAIL.windowMs);

    await clearAdminLoginFailures(redis as never, ADMIN_IP);
    expect(await isAdminLoginBlocked(redis as never, ADMIN_IP)).toBe(false);
    expect(redis.counters.has(adminLoginFailKey(ADMIN_IP))).toBe(false);
  });

  it('① 登录桶：5 次失败（401）后第 6 次**直接 429**（检查在口令比较之前 ⇒ 正确口令也拒）', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    // 前 5 次：`next()` 都放行 —— 也就是说这 5 次请求**到了下游**（由下游比口令、回 401）。
    for (let i = 0; i < ADMIN_LOGIN_FAIL.max; i += 1) {
      const response = res();
      const next = vi.fn();
      await mw.use(LOGIN() as never, response as never, next);
      expect(next, `第 ${i + 1} 次必须放行到下游（前 5 次是下游在比口令）`).toHaveBeenCalledTimes(1);
      response.emitFinish(401); // 下游：口令错误 ⇒ 401
      await flushFinishHook();
    }
    expect(redis.counters.get(adminLoginFailKey(ADMIN_IP))).toBe(ADMIN_LOGIN_FAIL.max);

    // 第 6 次：桶达界 ⇒ 入口即 429。**`next()` 不发生** ⇒ 请求根本不会被转发、
    // 口令永远不会被比较 —— 「正确口令也 429」的机制就在这里。
    const sixth = res();
    const nextSixth = vi.fn();
    await mw.use(LOGIN() as never, sixth as never, nextSixth);

    expect(nextSixth).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 429,
      body: { code: 10006, message: expect.any(String), data: null },
    });
    // 429 属于 finish 钩子的「其余」态（不计不清）—— 桶里仍是 5，攻击不成规模
    await flushFinishHook();
    expect(redis.counters.get(adminLoginFailKey(ADMIN_IP))).toBe(ADMIN_LOGIN_FAIL.max);
  });

  it('①b 成功登录（finish=200）⇒ **清桶**：此前累计的失败全部作废', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (let i = 0; i < 3; i += 1) {
      const response = res();
      await mw.use(LOGIN() as never, response as never, vi.fn());
      response.emitFinish(401);
      await flushFinishHook();
    }
    expect(redis.counters.get(adminLoginFailKey(ADMIN_IP))).toBe(3);

    const ok = res();
    const next = vi.fn();
    await mw.use(LOGIN() as never, ok as never, next);
    ok.emitFinish(200);
    await flushFinishHook();

    expect(next).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith(adminLoginFailKey(ADMIN_IP));
    expect(redis.counters.has(adminLoginFailKey(ADMIN_IP))).toBe(false);
    expect(await isAdminLoginBlocked(redis as never, ADMIN_IP)).toBe(false);
  });

  it('①c finish 钩子三态：其余状态码（404 管理面未启用 / 400 参数错）**不计不清**', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (const status of [404, 400, 503]) {
      const response = res();
      await mw.use(LOGIN() as never, response as never, vi.fn());
      response.emitFinish(status);
      await flushFinishHook();
    }

    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  /**
   * ③ T5 扩边（规格 §2.3）：「失败判据从『仅 401』扩为『401 或 403』」——
   * 403（账号停用 / 角色不足）与 401（用户名或口令错）同样是**口令被比较过**的失败信号，
   * 不计数就是给爆破留一条「试到停用账号为止不涨桶」的旁路。200 仍清零、其余仍不计。
   */
  it('①d（T5）：403 也计失败 —— 401 与 403 混合累计到 5 即达界', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    const statuses = [401, 403, 401, 403, 401];
    for (const status of statuses) {
      const response = res();
      const next = vi.fn();
      await mw.use(LOGIN() as never, response as never, next);
      expect(next, `status=${status} 前 5 次必须放行`).toHaveBeenCalledTimes(1);
      response.emitFinish(status);
      await flushFinishHook();
    }

    expect(redis.counters.get(adminLoginFailKey(ADMIN_IP))).toBe(ADMIN_LOGIN_FAIL.max);
    expect(await isAdminLoginBlocked(redis as never, ADMIN_IP)).toBe(true);
  });

  it('①e（T5）：403 累计后**成功登录（200）照样清桶**（清零判据不变）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (const status of [403, 403]) {
      const response = res();
      await mw.use(LOGIN() as never, response as never, vi.fn());
      response.emitFinish(status);
      await flushFinishHook();
    }
    expect(redis.counters.get(adminLoginFailKey(ADMIN_IP))).toBe(2);

    const ok = res();
    await mw.use(LOGIN() as never, ok as never, vi.fn());
    ok.emitFinish(200);
    await flushFinishHook();

    expect(redis.counters.has(adminLoginFailKey(ADMIN_IP))).toBe(false);
  });

  it('② 写桶：30 次 PUT 放行、第 31 次 429 + 10006（滑动窗；键按 tokenFp）', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < ADMIN_WRITE.max; i += 1) {
      const next = vi.fn();
      await mw.use(ADMIN_PUT() as never, res() as never, next);
      expect(next, `第 ${i + 1} 次写必须放行`).toHaveBeenCalledTimes(1);
    }
    const next31 = vi.fn();
    await mw.use(ADMIN_PUT() as never, res() as never, next31);

    expect(next31).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 429,
      body: { code: 10006, message: expect.any(String), data: null },
    });
    expect(redis.zsets.get(adminWriteKey('fp-abc'))?.size).toBe(ADMIN_WRITE.max);

    // 维度是**令牌指纹**：另一张令牌（另一个指纹）不受影响
    const other = vi.fn();
    await mw.use(ADMIN_PUT('fp-other') as never, res() as never, other);
    expect(other).toHaveBeenCalledTimes(1);
  });

  /**
   * ③ T5 扩边（规格 §2.3）：「写桶从『仅 PUT』扩为『`X-Admin==='1'` 且 method ∉ {GET,HEAD,OPTIONS}』」
   * —— 账号 CRUD（POST/PATCH）与反冲、对账运行全是写面，只拦 PUT 等于把新写面全漏出管理写桶。
   * `GET/HEAD/OPTIONS` 仍落回既有 IP 维（读面不占写桶）。
   */
  it('②b（T5）：写桶条件 = 持令牌且非 GET/HEAD/OPTIONS —— POST/PATCH/DELETE 全进写桶（键按 fps）', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const redis = makeZsetRedis();
      const { mw, res } = mount(redis);
      const request = {
        originalUrl: '/api/admin/accounts',
        url: '/api/admin/accounts',
        method,
        headers: { 'x-admin': '1' } as Record<string, unknown>,
        adminTokenFp: 'fp-m',
        ip: ADMIN_IP,
      };
      const next = vi.fn();

      await mw.use(request as never, res() as never, next);

      expect(next, method).toHaveBeenCalledTimes(1);
      expect([...redis.zsets.keys()], method).toEqual([adminWriteKey('fp-m')]);
      expect(redis.zadd, method).toHaveBeenCalledWith(adminWriteKey('fp-m'), expect.any(Number), expect.any(String));
    }
  });

  it('②c（T5）：GET/HEAD/OPTIONS **不进**写桶（保留既有 IP 维 —— 只有写面计数归令牌）', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const redis = makeZsetRedis();
      const { mw, res } = mount(redis);
      const request = {
        originalUrl: '/api/admin/accounts',
        url: '/api/admin/accounts',
        method,
        headers: { 'x-admin': '1' } as Record<string, unknown>,
        adminTokenFp: 'fp-m',
        ip: ADMIN_IP,
      };
      const next = vi.fn();

      await mw.use(request as never, res() as never, next);

      expect(next, method).toHaveBeenCalledTimes(1);
      expect([...redis.zsets.keys()], method).toEqual([`ratelimit:http-ip:${ADMIN_IP}`]);
    }
  });

  it('③ 无令牌 / 坏令牌的 admin 请求在 AdminAuth 处**立即 401**、限流中间件一次都不跑（不产生任何桶键）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);
    const adminAuth = new AdminAuthMiddleware();

    const cases: Array<[string, Record<string, string>]> = [
      ['无令牌', {}], // ⇒ 10002 UNAUTHENTICATED
      ['坏令牌', { authorization: 'Bearer garbage' }], // ⇒ 10005 TOKEN_INVALID
    ];
    for (const [label, headers] of cases) {
      const request = {
        originalUrl: '/api/admin/config',
        url: '/api/admin/config',
        method: 'GET',
        headers: headers as Record<string, unknown>,
        ip: ADMIN_IP,
      };
      const response = res();
      const next = vi.fn();
      let rateLimitRan = false;
      let thrown: unknown = null;
      try {
        await adminAuth.use(request as never, response as never, () => {
          rateLimitRan = true;
          void mw.use(request as never, response as never, next);
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown, label).not.toBeNull();
      expect((thrown as { getStatus: () => number }).getStatus(), label).toBe(401);
      expect(rateLimitRan, `${label}：都不该到达限流中间件`).toBe(false);
    }

    // 「不产生桶键」的最强形态：限流层根本没跑 ⇒ 一条 Redis 命令都没打、两个桶都是空的
    expect(redis.zadd).not.toHaveBeenCalled();
    expect(redis.zcard).not.toHaveBeenCalled();
    expect(redis.zremrangebyscore).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.pexpire).not.toHaveBeenCalled();
    expect(redis.zsets.size).toBe(0);
    expect(redis.counters.size).toBe(0);
  });

  it('④ 跳过面：登录与持令牌写**不涨**既有 IP 维（`ratelimit:http-ip:*` 一个键都不建）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    await mw.use(LOGIN() as never, res() as never, vi.fn());
    await mw.use(ADMIN_PUT() as never, res() as never, vi.fn());

    expect(redis.zadd).not.toHaveBeenCalledWith(
      expect.stringMatching(/^ratelimit:http-ip:/),
      expect.any(Number),
      expect.any(String),
    );
    // 只该有**一个**键：写桶那一个（登录的失败计数由 finish 钩子驱动，此刻还没有响应）
    expect([...redis.zsets.keys()]).toEqual([adminWriteKey('fp-abc')]);
  });

  it('④b 持令牌但**非写**路径（GET /api/admin/config）**保留**既有 IP 维', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    const next = vi.fn();
    await mw.use(ADMIN_GET() as never, res() as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect([...redis.zsets.keys()]).toEqual(['ratelimit:http-ip:203.0.113.9']);
  });

  it('④c 落回面：无 X-Admin 的 PUT（理论上不可达 —— AdminAuth 先 401）落回既有流程 ⇒ 走 IP 维', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    const request = { ...ADMIN_PUT(), headers: {} as Record<string, unknown> }; // 没有验真产物
    const next = vi.fn();
    await mw.use(request as never, res() as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    // 写桶**不得**被记账（没有 `X-Admin` 就不是「持令牌写」），而是 IP 维兜住
    expect([...redis.zsets.keys()]).toEqual(['ratelimit:http-ip:203.0.113.9']);
  });
});

/**
 * 风控 T7（规格 §2.6-2 / C9 网关侧）：**HTTP 用户维限流档** —— 在既有用户维判定处
 * **先读** `EXISTS risk:limit:{userId}`（`isThrottled` 单独 catch ⇒ 按无旗 + error 日志，F8）：
 *  - 旗在 ⇒ 以 `THROTTLED_RATE_LIMIT`（3/1s）对**同一键** `ratelimit:http:{userId}` 判定；
 *  - 旗无 ⇒ **20/5s 原样**（负对照）；
 *  - 旗读错 ⇒ 走正常阈值（**不 503** —— 旗读故障不得吞进 fail-closed 管道）；
 *  - 🔴 不变量回归：**正常限流链自身**的 Redis 故障语义不变（503 + 10007）。
 */
describe('风控 T7：HTTP 限流档（§2.6-2：旗读 fail-open；正常链 fail-closed 不变量）', () => {
  afterEach(() => {
    // `Logger.overrideLogger` 是**进程级**的 —— 用后还原（同 proxy.gateway.test.ts 的纪律）。
    Logger.overrideLogger(new Logger());
  });

  const AUTHED = { headers: { 'x-user-id': 'u1' }, ip: '203.0.113.7' };

  it('旗在 ⇒ 3/1s：前 3 次 next()、**第 4 次 429 + 10006**（判定键仍是 `ratelimit:http:u1`）', async () => {
    const redis = makeZsetRedis();
    redis.flags.add('risk:limit:u1');
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < THROTTLED_RATE_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use({ ...AUTHED } as never, res() as never, next);
      expect(next, `第 ${i + 1} 次（档位内）必须放行`).toHaveBeenCalledTimes(1);
    }
    const fourth = vi.fn();
    await mw.use({ ...AUTHED } as never, res() as never, fourth);

    expect(fourth).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 429,
      body: { code: 10006, message: expect.any(String), data: null },
    });
    // 正对照：拒绝来自**档位阈值**（同一键 3 条），而不是 IP 维或别的桶
    expect(redis.zsets.get('ratelimit:http:u1')?.size).toBe(THROTTLED_RATE_LIMIT.max);
    expect(redis.zsets.get('ratelimit:http-ip:203.0.113.7')!.size).toBeLessThan(HTTP_IP_RATE_LIMIT.max);
  });

  it('旗无 ⇒ **20/5s 原样**（负对照：第 4 次不得被档位阈值拦）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (let i = 0; i < 4; i += 1) {
      const next = vi.fn();
      await mw.use({ ...AUTHED } as never, res() as never, next);
      expect(next, `第 ${i + 1} 次不得被 3/1s 拦`).toHaveBeenCalledTimes(1);
    }
    expect(redis.zsets.get('ratelimit:http:u1')?.size).toBe(4);
    expect(redis.exists).toHaveBeenCalledWith('risk:limit:u1');
  });

  it('🔴 旗读故障 ⇒ **按无旗**（走 20/5s）+ error 日志；**不得** 503（F8：单独 catch）', async () => {
    const { sink, records } = createCapturingSink();
    Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
    const redis = makeZsetRedis();
    redis.exists.mockRejectedValueOnce(new Error('flag store down'));
    const { mw, calls, res } = mount(redis);

    const next = vi.fn();
    await mw.use({ ...AUTHED } as never, res() as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]); // 没有 503（也没有 429）信封
    expect(redis.zsets.get('ratelimit:http:u1')?.size).toBe(1); // 真的走了正常阈值链
    expect(
      records.some((r) => r.level === 'error' && r.msg.includes('risk:limit')),
    ).toBe(true);
  });

  it('🔴 正常链 fail-closed 不变量回归：旗读正常、**正常判定** Redis 错 ⇒ 503 + 10007（不得放行）', async () => {
    const redis = {
      zremrangebyscore: vi.fn(async () => 0),
      zcard: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      zadd: vi.fn(),
      expire: vi.fn(),
      exists: vi.fn(async () => 0), // 旗读正常（按无旗）⇒ 故障只可能来自正常链
    };
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use({ ...AUTHED } as never, res() as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 503,
      body: { code: 10007, message: expect.any(String), data: null },
    });
  });
});

/**
 * 支付片 T13（规格 §2.4.1 限流脚注逐字）：**玩家面写端点三档桶** ——
 * `POST /api/pay/orders` 10/分 · `POST …/orders/:no/sync` 30/分 · `POST /api/pay/refunds`
 * 与 `POST /api/pay/withdrawals` **各** 5/分（用户维）。
 *
 * ⚠️ 夹具用 **fake timers**（每发间隔 1s）：三档都是「每分」桶，而既有用户维是 20/5s ——
 * 背靠背连发 20 发以上会让**通用维先拦**（第 21 发起 429 但那是 20/5s 的界，不是 30/分
 * 的界——假红/假绿的经典形态）。1s 间隔下 5s 窗内至多 5 条（< 20），每档都恰测到它自己的界。
 */
describe('支付片 T13：玩家面写端点三档桶（§2.4.1 脚注逐字；用户维；与既有维度并存）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const AUTHED = (path: string, method = 'POST') => ({
    originalUrl: path,
    url: path,
    method,
    headers: { 'x-user-id': 'u1' } as Record<string, unknown>,
    ip: '203.0.113.7',
  });

  it('阈值与键名逐字（10/30/5/5 每 60 秒；键 ratelimit:pay-*:{userId}——别的字面量都不算数）', () => {
    expect(PAY_ORDER_CREATE_LIMIT).toEqual({ max: 10, windowMs: 60_000 });
    expect(PAY_ORDER_SYNC_LIMIT).toEqual({ max: 30, windowMs: 60_000 });
    expect(PAY_REFUND_APPLY_LIMIT).toEqual({ max: 5, windowMs: 60_000 });
    expect(PAY_WITHDRAW_APPLY_LIMIT).toEqual({ max: 5, windowMs: 60_000 });
    expect(payRateLimitKey('pay-order', 'u1')).toBe('ratelimit:pay-order:u1');
    expect(payRateLimitKey('pay-sync', 'u1')).toBe('ratelimit:pay-sync:u1');
    expect(payRateLimitKey('pay-refund', 'u1')).toBe('ratelimit:pay-refund:u1');
    expect(payRateLimitKey('pay-withdraw', 'u1')).toBe('ratelimit:pay-withdraw:u1');
  });

  it('路径判定表（唯一实现 payLimitBucketOf）：正例 + 归一（大小写/尾斜杠）+ 近邻负例', () => {
    expect(payLimitBucketOf('POST', '/api/pay/orders')).toBe('pay-order');
    expect(payLimitBucketOf('POST', '/api/pay/orders/pay_x/sync')).toBe('pay-sync');
    expect(payLimitBucketOf('POST', '/api/pay/refunds')).toBe('pay-refund');
    expect(payLimitBucketOf('POST', '/api/pay/withdrawals')).toBe('pay-withdraw');
    // ⚙️20 同族：Express 路由大小写不敏感、非严格路由（尾斜杠同命中）⇒ 判定必须归一，
    // 否则变体绕过专属桶（多计只让桶更严，方向 fail-closed）。
    expect(payLimitBucketOf('POST', '/API/PAY/ORDERS')).toBe('pay-order');
    expect(payLimitBucketOf('post', '/api/pay/orders/')).toBe('pay-order');
    expect(payLimitBucketOf('POST', '/api/pay/orders//')).toBe('pay-order');
    expect(payLimitBucketOf('POST', '/API/pay/withdrawals/')).toBe('pay-withdraw');
    // 负例（近邻路径不得命中；非 POST 一律 null）
    for (const [m, p] of [
      ['GET', '/api/pay/orders'],
      ['GET', '/api/pay/orders/mine'],
      ['POST', '/api/pay/orders/mine'], // 不是 `/sync` 尾段
      ['POST', '/api/pay/orders/pay_x'], // 缺 /sync
      ['POST', '/api/pay/orders/pay_x/sync/extra'],
      ['POST', '/api/pay/ordersx'],
      ['POST', '/api/payx/orders'],
      ['POST', '/api/payx/orders/pay_x/sync'],
      ['POST', '/api/admin/pay/orders'], // 管理面近邻（且 POST 未登记）
      ['POST', '/api/admin/pay/refunds/rf_1/review'],
      ['POST', '/api/pay/wallet/summary'],
      ['POST', '/api/pay'],
      ['POST', '/'],
    ] as Array<[string, string]>) {
      expect(payLimitBucketOf(m, p), `${m} ${p}`).toBeNull();
    }
    // 非法 method 形态（单测直驱中间件时可能 undefined）⇒ null，不得抛
    expect(payLimitBucketOf(undefined, '/api/pay/orders')).toBeNull();
  });

  it('① 下单桶：10 次放行、第 11 次 429 + 10006（正对照：通用用户维 11 < 20 远未达界）', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < PAY_ORDER_CREATE_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use(AUTHED('/api/pay/orders') as never, res() as never, next);
      expect(next, `第 ${i + 1} 次必须放行`).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
    }
    const eleventh = vi.fn();
    await mw.use(AUTHED('/api/pay/orders') as never, res() as never, eleventh);

    expect(eleventh).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 429, body: { code: 10006, message: expect.any(String), data: null } });
    expect(redis.zsets.get('ratelimit:pay-order:u1')?.size).toBe(PAY_ORDER_CREATE_LIMIT.max);
    expect(redis.zsets.get('ratelimit:http:u1')!.size).toBeLessThan(HTTP_RATE_LIMIT.max);
    expect(redis.zsets.get('ratelimit:http-ip:203.0.113.7')!.size).toBeLessThan(HTTP_IP_RATE_LIMIT.max);
  });

  it('② sync 桶：30 次放行、第 31 次 429（参数尾段路径命中；键 ratelimit:pay-sync:u1）', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < PAY_ORDER_SYNC_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use(AUTHED('/api/pay/orders/pay_x/sync') as never, res() as never, next);
      expect(next, `第 ${i + 1} 次必须放行`).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
    }
    const thirtyFirst = vi.fn();
    await mw.use(AUTHED('/api/pay/orders/pay_x/sync') as never, res() as never, thirtyFirst);

    expect(thirtyFirst).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 429, body: { code: 10006, message: expect.any(String), data: null } });
    expect(redis.zsets.get('ratelimit:pay-sync:u1')?.size).toBe(PAY_ORDER_SYNC_LIMIT.max);
  });

  it('③ 退款申请桶：5 次放行、第 6 次 429（键 ratelimit:pay-refund:u1）', async () => {
    const redis = makeZsetRedis();
    const { mw, calls, res } = mount(redis);

    for (let i = 0; i < PAY_REFUND_APPLY_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use(AUTHED('/api/pay/refunds') as never, res() as never, next);
      expect(next, `第 ${i + 1} 次必须放行`).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
    }
    const sixth = vi.fn();
    await mw.use(AUTHED('/api/pay/refunds') as never, res() as never, sixth);

    expect(sixth).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({ status: 429, body: { code: 10006, message: expect.any(String), data: null } });
    expect(redis.zsets.get('ratelimit:pay-refund:u1')?.size).toBe(PAY_REFUND_APPLY_LIMIT.max);
  });

  it('④ 提现申请桶：5/6——与退款桶**独立**（「申请各 5/分」不是合计 5/分）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    // 先打满退款桶
    for (let i = 0; i < PAY_REFUND_APPLY_LIMIT.max; i += 1) {
      await mw.use(AUTHED('/api/pay/refunds') as never, res() as never, vi.fn());
      vi.advanceTimersByTime(1000);
    }
    // 提现桶独立：5 次照常放行
    for (let i = 0; i < PAY_WITHDRAW_APPLY_LIMIT.max; i += 1) {
      const next = vi.fn();
      await mw.use(AUTHED('/api/pay/withdrawals') as never, res() as never, next);
      expect(next, `提现第 ${i + 1} 次必须放行（退款桶满不豁免也不殃及）`).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
    }
    const sixth = vi.fn();
    await mw.use(AUTHED('/api/pay/withdrawals') as never, res() as never, sixth);
    expect(sixth).not.toHaveBeenCalled();
    expect(redis.zsets.get('ratelimit:pay-withdraw:u1')?.size).toBe(PAY_WITHDRAW_APPLY_LIMIT.max);
    expect(redis.zsets.get('ratelimit:pay-refund:u1')?.size).toBe(PAY_REFUND_APPLY_LIMIT.max);
  });

  it('桶互不串扰：下单桶满 ⇒ 退款/提现/sync 照常放行（四把独立键）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (let i = 0; i < PAY_ORDER_CREATE_LIMIT.max; i += 1) {
      await mw.use(AUTHED('/api/pay/orders') as never, res() as never, vi.fn());
      vi.advanceTimersByTime(1000);
    }
    for (const path of ['/api/pay/refunds', '/api/pay/withdrawals', '/api/pay/orders/pay_x/sync']) {
      const next = vi.fn();
      await mw.use(AUTHED(path) as never, res() as never, next);
      expect(next, path).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
    }
  });

  it('非 POST / 近邻路径不进专属桶（GET mine 只落既有维度——键集逐字钉）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    await mw.use(AUTHED('/api/pay/orders/mine', 'GET') as never, res() as never, vi.fn());
    await mw.use(AUTHED('/api/pay/wallet/summary', 'GET') as never, res() as never, vi.fn());

    expect([...redis.zsets.keys()].sort()).toEqual(['ratelimit:http-ip:203.0.113.7', 'ratelimit:http:u1']);
  });

  it('变体计桶（⚙️20 同族）：大小写与尾斜杠命中同一把桶', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    await mw.use(AUTHED('/API/PAY/ORDERS') as never, res() as never, vi.fn());
    await mw.use(AUTHED('/api/pay/orders/') as never, res() as never, vi.fn());

    expect(redis.zsets.get('ratelimit:pay-order:u1')?.size).toBe(2);
  });

  it('用户维：u2 不占 u1 的桶（桶按 userId 分键）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    for (let i = 0; i < PAY_REFUND_APPLY_LIMIT.max + 1; i += 1) {
      const req =
        i === PAY_REFUND_APPLY_LIMIT.max
          ? { ...AUTHED('/api/pay/refunds'), headers: { 'x-user-id': 'u2' } }
          : AUTHED('/api/pay/refunds');
      const next = vi.fn();
      await mw.use(req as never, res() as never, next);
      expect(next, `第 ${i + 1} 发`).toHaveBeenCalledTimes(1); // u1 满 5 后 u2 的第 1 发照常放行
      vi.advanceTimersByTime(1000);
    }
    expect(redis.zsets.get('ratelimit:pay-refund:u1')?.size).toBe(PAY_REFUND_APPLY_LIMIT.max);
    expect(redis.zsets.get('ratelimit:pay-refund:u2')?.size).toBe(1);
  });

  it('admin 写端点不进支付桶（admin/pay/refunds/:no/review ⇒ 管理写桶；负对照）', async () => {
    const redis = makeZsetRedis();
    const { mw, res } = mount(redis);

    await mw.use(
      {
        originalUrl: '/api/admin/pay/refunds/rf_1/review',
        method: 'POST',
        headers: { 'x-admin': '1' } as Record<string, unknown>,
        adminTokenFp: 'fp-abc',
        ip: '203.0.113.7',
      } as never,
      res() as never,
      vi.fn(),
    );

    expect([...redis.zsets.keys()]).toEqual([adminWriteKey('fp-abc')]);
  });

  it('🔴 专属桶的存储故障同样 fail closed（503 + 10007；与既有维度同一条——不因新桶开新口子）', async () => {
    const redis = {
      zremrangebyscore: vi.fn(async () => 0),
      zcard: vi.fn(async (key: string) => {
        if (String(key).startsWith('ratelimit:pay-')) throw new Error('ECONNREFUSED');
        return 0;
      }),
      zadd: vi.fn(async () => 1),
      expire: vi.fn(async () => 1),
      exists: vi.fn(async () => 0), // 旗读正常 ⇒ 故障只可能来自支付桶
    };
    const { mw, calls, res } = mount(redis);
    const next = vi.fn();
    await mw.use(AUTHED('/api/pay/orders') as never, res() as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
      status: 503,
      body: { code: 10007, message: expect.any(String), data: null },
    });
  });

  it('窗口滑出后重新放行（hitPayLimit：ZREMRANGEBYSCORE 真的按窗口清理）', async () => {
    const redis = makeZsetRedis();
    for (let i = 0; i < PAY_WITHDRAW_APPLY_LIMIT.max; i += 1) {
      expect(await hitPayLimit(redis as never, 'pay-withdraw', 'u1', NOW)).toBe(false);
    }
    expect(await hitPayLimit(redis as never, 'pay-withdraw', 'u1', NOW)).toBe(true);
    // 越过整个窗口 ⇒ 老成员全部滑出
    expect(await hitPayLimit(redis as never, 'pay-withdraw', 'u1', NOW + 60_000)).toBe(false);
  });
});

