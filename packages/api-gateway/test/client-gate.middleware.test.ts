/**
 * ClientGateMiddleware —— 客户端接入片 T5：HTTP **第 0 步端闸**（矩阵 + 留痕 + 拒绝信封）。
 *
 * ─── 两层测试面（各测其能测的）────────────────────────────────────────────
 *  ① **直驱 `use()`**（上半）：精确控制 `req.headers` 的**原始值** —— 「空白包裹 / 含换行」
 *     这类**仅单测层可达**的样本（真栈里 Node/llhttp 按 RFC 9110 剥首尾 OWS、含换行被
 *     解析器 400；规格 C12 ⚠️ r1 次要 8）只能在这一层喂给中间件；
 *  ② **真链序探针**（下半）：手搭 `configure()`（⛔ 不 import AppModule —— 会把 Nest 装配
 *     拖进单测），probe 模块的 apply 顺序 = 生产，走真 HTTP：C13 豁免本体（显式带头）·
 *     C14 闸先于 jwt（10008 ≠ 10002/10005）· C16 OPTIONS 预检（cors 短路）。
 *  ⚠️ 脚手架**必须**先 `app.enableCors(...)`（照 `main.ts:52` 次序：enableCors 先于 Nest
 *     中间件链注册）——手搭 app 漏了它，OPTIONS 会被闸拦成 10008 = **反语义绿**
 *     （T5 ⚠️ r2 次要 2）。
 *
 * ─── 判据映射（规格 §1）─────────────────────────────────────────────────
 *  C9 无头放行 · C10 app 双向 · C11 h5 双向 · C12 非法值（含注入样本负对照）·
 *  C13 三豁免 · C14 闸先于 jwt · C15 拒绝信封 · C16 OPTIONS · C25 留痕 ·
 *  C26 两计数器 · C27 unidentified 排除豁免。C14b（真链序文本判据）在
 *  `client-gate-order.gate.test.ts`。
 *
 * traceId 由 NDJSON 日志层（ALS）自动附带 —— 本层不断言（登记；T8 真栈日志实读覆盖）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  Controller,
  Get,
  HttpCode,
  Logger,
  Module,
  Post,
  type MiddlewareConsumer,
  type NestModule,
  type INestApplication,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { ErrCode, type ConfigSnapshot } from '@fight-the-landlord/protocol';
import { createCapturingSink, createRedactingLogger, metricsRegistry } from '@fight-the-landlord/shared';
import { ClientGateMiddleware, CLIENT_PLATFORM_HEADER } from '../src/auth/client-gate.middleware';
import { ClientGateService } from '../src/auth/client-gate.service';
import { AdminAuthMiddleware } from '../src/auth/admin.middleware';
import { JwtMiddleware } from '../src/auth/jwt.middleware';
import { SessionGuard } from '../src/auth/session.guard';
import { ConfigCacheService } from '../src/config/config-cache.service';
import { NotFoundEnvelopeFilter } from '../src/http/not-found.filter';
import {
  clientGateBlockedTotal,
  clientGateUnidentifiedTotal,
} from '../src/metrics/client-gate.metrics';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 闸态可控的假缓存：只实现读面 `snapshotOrNull()`（T5 消费面恰这一个方法）。 */
function makeGateCache(): { cache: ConfigCacheService; setSnapshot: (next: ConfigSnapshot | null) => void } {
  let snapshot: ConfigSnapshot | null = null;
  return {
    cache: { snapshotOrNull: () => snapshot } as unknown as ConfigCacheService,
    setSnapshot(next: ConfigSnapshot | null): void {
      snapshot = next;
    },
  };
}

/** 造快照：只含传入的键（照 `config-cache.test.ts` 的同名 helper 形态）。 */
function snapshotWith(over: Record<string, unknown> = {}): ConfigSnapshot {
  const config = {} as ConfigSnapshot;
  for (const [key, value] of Object.entries(over)) {
    (config as Record<string, { value: unknown; version: number }>)[key] = { value, version: 1 };
  }
  return config;
}

/** 暗上线种子态（两键 `true` = 全开）与全关态（两键 `false`）。 */
const BOTH_ON = (): ConfigSnapshot => snapshotWith({ 'client.appEnabled': true, 'client.h5Enabled': true });
const BOTH_OFF = (): ConfigSnapshot => snapshotWith({ 'client.appEnabled': false, 'client.h5Enabled': false });

/** `client_gate_blocked_total{platform}` 当前读数（0 = 该标签从未计数）。 */
async function blockedCount(platform: 'app' | 'h5'): Promise<number> {
  const { values } = await clientGateBlockedTotal.get();
  return values.find((v) => v.labels.platform === platform)?.value ?? 0;
}

/** `client_gate_unidentified_total` 当前读数（无标签）。 */
async function unidentifiedCount(): Promise<number> {
  const { values } = await clientGateUnidentifiedTotal.get();
  return values[0]?.value ?? 0;
}

/** `CodedForbidden` 的 **403 + §11.2 信封**断言（C15）；返回响应体供附加断言。 */
function expectCodedForbidden(err: unknown): { code: number; message: string; data: null } {
  expect(err, '应当抛 CodedForbidden，实际没有抛').not.toBeNull();
  const forbidden = err as { getStatus(): number; getResponse(): unknown };
  expect(forbidden.getStatus()).toBe(403);
  const body = forbidden.getResponse() as { code: number; message: string; data: null };
  expect(body).toEqual({ code: ErrCode.CLIENT_DISABLED, message: expect.any(String), data: null });
  return body;
}

/** 直驱形态（照 `http-rate-limit.test.ts` 的 `mount()` 成例）：真 `use()`、假 req、记录 next。 */
function mountUnit(cache: ConfigCacheService) {
  const mw = new ClientGateMiddleware(new ClientGateService(cache));
  const next = vi.fn();
  /** 调用中间件并捕获**同步** throw（`use()` 同步；生产链上 Nest 以同样的方式接住它）。 */
  const run = (path: string, header?: string, method = 'GET'): unknown => {
    const req = {
      originalUrl: path,
      url: path,
      method,
      headers: header === undefined ? {} : { [CLIENT_PLATFORM_HEADER]: header },
    };
    try {
      mw.use(req as never, {} as never, next);
      return null;
    } catch (err) {
      return err;
    }
  };
  return { next, run };
}

// ───────────────────────────── 留痕捕获 ─────────────────────────────

const { sink, records } = createCapturingSink();

beforeEach(() => {
  records.length = 0;
  clientGateBlockedTotal.reset();
  clientGateUnidentifiedTotal.reset();
  // `Logger.overrideLogger` 是**进程级**的 —— 每个用例装、用后还原（同 http-rate-limit 的纪律）。
  Logger.overrideLogger(createRedactingLogger(sink, { service: 'api-gateway' }));
});

afterEach(() => {
  Logger.overrideLogger(new Logger());
});

// ═════════════════════ ① 直驱 use()：矩阵 + 豁免 + 留痕 + 计数器 ═════════════════════

describe('ClientGateMiddleware（直驱）：矩阵 C9–C12 / 豁免 C13+C27 / 留痕 C25 / 计数器 C26', () => {
  it('C9：无头 + 闸关（两键 false）+ POST /api/auth/login ⇒ 放行（next 被调；闸对无头流量零影响）', () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { next, run } = mountUnit(cache);

    expect(run('/api/auth/login', undefined, 'POST')).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(records).toEqual([]); // 放行不留痕
  });

  it('C10：app 头双向 —— 闸关 ⇒ 403+10008；闸开 ⇒ 放行（同路径同头，排除「恒拒」）', async () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { next, run } = mountUnit(cache);

    expectCodedForbidden(run('/api/auth/login', 'app', 'POST'));
    expect(next).not.toHaveBeenCalled();
    expect(await blockedCount('app')).toBe(1);

    setSnapshot(BOTH_ON());
    expect(run('/api/auth/login', 'app', 'POST')).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);
    expect(await blockedCount('app')).toBe(1); // 闸开不再增 blocked
  });

  it('C11：h5 头双向；且两键**独立** —— {app:false, h5:true} 下 app 拦、h5 放', async () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { next, run } = mountUnit(cache);

    expectCodedForbidden(run('/api/auth/login', 'h5', 'POST'));
    expect(await blockedCount('h5')).toBe(1);

    setSnapshot(BOTH_ON());
    expect(run('/api/auth/login', 'h5', 'POST')).toBeNull();
    expect(next).toHaveBeenCalledTimes(1);

    // 两键独立（排除「读单一全局键」的塌缩实现）：app 关而 h5 开 ⇒ 只有 app 被拦
    setSnapshot(snapshotWith({ 'client.appEnabled': false, 'client.h5Enabled': true }));
    expectCodedForbidden(run('/api/auth/login', 'app', 'POST'));
    expect(run('/api/auth/login', 'h5', 'POST')).toBeNull();
    expect(await blockedCount('app')).toBe(1);
    expect(await blockedCount('h5')).toBe(1);
  });

  it('C12：非法头值一律未识别放行（含**仅单测层可达**的空白包裹/含换行/超长样本）', async () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF()); // 闸全关 —— 任一非法值被判成某端，本用例必红
    const { next, run } = mountUnit(cache);

    const illegal = [
      'App', // 值大小写敏感（§0：恰 app/h5 小写）
      'APP',
      'android',
      '',
      'x'.repeat(4096), // 超长
      ' app ', // 空白包裹（真栈里被 llhttp 剥 OWS —— 仅单测层可达）
      '\tapp', // 首部制表符（同上）
      'app\n', // 含换行（真栈被解析器 400 —— 仅单测层可达）
      'h5\t',
      'app h5', // 不做 split/归一
    ];
    for (const value of illegal) {
      expect(run('/api/auth/login', value, 'POST'), JSON.stringify(value)).toBeNull();
    }

    expect(next).toHaveBeenCalledTimes(illegal.length);
    expect(await blockedCount('app')).toBe(0);
    expect(await blockedCount('h5')).toBe(0);
    expect(await unidentifiedCount()).toBe(illegal.length);
  });

  it('C12 负对照：头值不进任何日志行（未识别 ⇒ 不留痕；拒绝行只含归一后的 platform 枚举）', () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { run } = mountUnit(cache);

    // 注入样本走未识别桶：不产生任何日志（原值自然不落日志）
    const injected = 'app\ninjected=evil';
    expect(run('/api/auth/login', injected, 'POST')).toBeNull();
    expect(records).toEqual([]);

    // 正对照：拒绝路径恰一条 warn，且只含归一后的 `platform=app`（原始头值不出现）
    expectCodedForbidden(run('/api/auth/login', 'app', 'POST'));
    const warns = records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).not.toContain('injected');
    expect(warns[0]!.msg).toContain('platform=app');
  });

  it('C13/C27：三豁免（显式带头 + 闸关）放行；豁免路径**任何形态**都不计 unidentified', async () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { next, run } = mountUnit(cache);

    const exempt = ['/api/admin', '/api/admin/xxx', '/api/health', '/api/health/live', '/api/config'];
    for (const path of exempt) {
      expect(run(path, undefined), `${path} 无头`).toBeNull();
      expect(run(path, 'app'), `${path} 带头 app`).toBeNull();
      expect(run(path, 'h5'), `${path} 带头 h5`).toBeNull();
    }
    expect(next).toHaveBeenCalledTimes(exempt.length * 3);
    expect(await unidentifiedCount()).toBe(0); // C27：排除豁免路径
    expect(await blockedCount('app')).toBe(0);
    expect(await blockedCount('h5')).toBe(0);

    // 正对照①：同一个「无头」形态打**非豁免**路径 ⇒ unidentified 增量（证明上面的 0 不是恒 0）
    expect(run('/api/auth/login', undefined, 'POST')).toBeNull();
    expect(await unidentifiedCount()).toBe(1);
    // 正对照②：同一个「带头」形态打**非豁免**路径 + 闸关 ⇒ blocked 增量
    expectCodedForbidden(run('/api/auth/login', 'app', 'POST'));
    expect(await blockedCount('app')).toBe(1);
  });

  it('C22 消费面（fail-open 读法）：从未拉到（null）/键缺失/坏值 ⇒ 放行；仅「恰为 false」才拦', async () => {
    const { cache, setSnapshot } = makeGateCache();
    const { next, run } = mountUnit(cache);

    setSnapshot(null); // 从未拉到 ⇒ 放行
    expect(run('/api/rooms', 'app')).toBeNull();
    setSnapshot(snapshotWith()); // 快照在但键缺失 ⇒ 放行
    expect(run('/api/rooms', 'app')).toBeNull();
    setSnapshot(snapshotWith({ 'client.appEnabled': 'false' })); // 坏值（字符串）⇒ 放行
    expect(run('/api/rooms', 'app')).toBeNull();
    setSnapshot(snapshotWith({ 'client.appEnabled': true })); // true ⇒ 放行
    expect(run('/api/rooms', 'app')).toBeNull();
    setSnapshot(snapshotWith({ 'client.appEnabled': false })); // 恰为 false ⇒ 拦
    expectCodedForbidden(run('/api/rooms', 'app'));

    expect(next).toHaveBeenCalledTimes(4);
    expect(await blockedCount('app')).toBe(1);
  });

  it('C25：拒绝 ⇒ 恰一条 warn，message 含三要素（platform= / trigger=switch-off / path=）', () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { run } = mountUnit(cache);

    expectCodedForbidden(run('/api/auth/login', 'h5', 'POST'));

    const warns = records.filter((r) => r.level === 'warn');
    expect(warns).toHaveLength(1);
    const warn = warns[0]!;
    // ⚠️ Nest 对**同 context 的多个 Logger 实例**追加编号（本文件多处挂载 ⇒ `…2`/`…3`）
    // —— 这里只认前缀，不钉编号（编号是实例数，不是契约）。
    expect(warn.context).toContain('ClientGateMiddleware');
    expect(warn.msg).toContain('platform=h5');
    expect(warn.msg).toContain('trigger=switch-off');
    expect(warn.msg).toContain('path=/api/auth/login');
    // traceId/source 由 NDJSON 日志层（ALS）附带 —— 本层不断言（T8 真栈日志实读覆盖）。

    // 负对照：同一次拒绝之后的**放行**不再产生 warn（拒绝才留痕）
    setSnapshot(BOTH_ON());
    expect(run('/api/auth/login', 'h5', 'POST')).toBeNull();
    expect(records.filter((r) => r.level === 'warn')).toHaveLength(1);
  });

  it('C26：blocked{platform} 按端分标签、unidentified 无标签 —— 各自增量正确；计名逐字进共享注册表', async () => {
    const { cache, setSnapshot } = makeGateCache();
    setSnapshot(BOTH_OFF());
    const { run } = mountUnit(cache);

    expectCodedForbidden(run('/api/rooms', 'app'));
    expectCodedForbidden(run('/api/rooms', 'app'));
    expectCodedForbidden(run('/api/rooms', 'h5'));
    expect(run('/api/rooms', undefined)).toBeNull();

    expect(await blockedCount('app')).toBe(2);
    expect(await blockedCount('h5')).toBe(1);
    expect(await unidentifiedCount()).toBe(1);

    // §0 钉子逐字：头名 + 两计名（就地变体按缺陷处理）；注册表同一性 —— `/metrics` 读的就是它。
    expect(CLIENT_PLATFORM_HEADER).toBe('x-client-platform');
    expect(metricsRegistry().getSingleMetric('client_gate_blocked_total')).toBeDefined();
    expect(metricsRegistry().getSingleMetric('client_gate_unidentified_total')).toBeDefined();
  });
});

// ═════════════════════ ② 真链序探针（手搭 configure()，真 HTTP） ═════════════════════

/** 探针控制器（最小路由面：真 HTTP 需要一个 2xx 落点来证明「放行」）。 */
@Controller('auth')
class ProbeAuthController {
  @Post('login')
  // `@HttpCode(200)`：POST 的 Nest 默认 201 会在放行格与拒绝格之间引入第三种状态码
  // —— 真实登录（下游 user-service 的处理器）回的就是 200，探针照此对齐。
  @HttpCode(200)
  login(): { code: number } {
    return { code: 0 };
  }
}

@Controller('rooms')
class ProbeRoomsController {
  @Get()
  rooms(): { code: number } {
    return { code: 0 };
  }
}

@Controller('health')
class ProbeHealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }
}

/** `/api/config` 的形态照真实路由（`gateway.controller.ts` 的 `@Get('config')`，空前缀）。 */
@Controller()
class ProbeConfigController {
  @Get('config')
  config(): { code: number } {
    return { code: 0 };
  }
}

@Controller('admin')
class ProbeAdminController {
  @Get('probe')
  probe(): { code: number } {
    return { code: 0 };
  }
}

/** 闸态（探针专用，逐用例改写）。 */
const gateState = { snapshot: null as ConfigSnapshot | null };
const gateCacheStub = { snapshotOrNull: (): ConfigSnapshot | null => gateState.snapshot };
const mockJwt = { verify: vi.fn() };
const mockSession = { isActive: vi.fn(async () => true) };

/**
 * 探针模块：apply 顺序 = 生产 `app.module.ts`（`ClientGateMiddleware` 第 0 步）。
 * ⛔ 不 import AppModule；`HttpRateLimitMiddleware` 不在此组（它的 Redis 维度各在
 * `http-rate-limit.test.ts` 单独钉 —— 与本组关注的端闸链序无关）。
 */
@Module({
  controllers: [
    ProbeAuthController,
    ProbeRoomsController,
    ProbeHealthController,
    ProbeConfigController,
    ProbeAdminController,
  ],
  providers: [
    { provide: ConfigCacheService, useValue: gateCacheStub },
    ClientGateService,
    { provide: JwtService, useValue: mockJwt },
    { provide: SessionGuard, useValue: mockSession },
  ],
})
class ClientGateProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ClientGateMiddleware, JwtMiddleware, AdminAuthMiddleware).forRoutes('{/*splat}');
  }
}

describe('真链序探针（手搭 configure()，真 HTTP）：C13 豁免本体 / C14 闸先于 jwt / C16 OPTIONS', () => {
  let app: INestApplication;
  let baseUrl: string;

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, init);
  const withPlatform = (platform?: string): Record<string, string> =>
    platform === undefined ? {} : { [CLIENT_PLATFORM_HEADER]: platform };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClientGateProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api'); // 与 src/main.ts 一致
    // ⚠️ 照 `main.ts:52` 的次序：enableCors 先于 Nest 中间件链（init、configure 之前注册）
    // —— 手搭 app 漏了它 ⇒ OPTIONS 预检会被闸拦成 10008 = 反语义绿（T5 ⚠️ r2 次要 2）。
    app.enableCors({ exposedHeaders: ['X-Trace-Id'] });
    app.useGlobalFilters(new NotFoundEnvelopeFilter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    mockJwt.verify.mockReset(); // 各用例自行打桩；未打桩时 verify ⇒ undefined ⇒ 10005（真链的可控形态）
    mockSession.isActive.mockResolvedValue(true);
    gateState.snapshot = BOTH_OFF(); // 默认闸关 —— 拦截格与放行格共用同一基态
  });

  it('C9：无头 + 闸关 + POST /api/auth/login ⇒ 200（真 HTTP 落点证明放行）', async () => {
    const res = await call('/api/auth/login', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0 });
  });

  it('C10/C15：app 头双向（真 HTTP）—— 闸关 ⇒ 403 + {code:10008,message,data:null}；闸开 ⇒ 200', async () => {
    const blocked = await call('/api/auth/login', { method: 'POST', headers: withPlatform('app') });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({
      code: ErrCode.CLIENT_DISABLED,
      message: expect.any(String),
      data: null,
    });

    gateState.snapshot = BOTH_ON();
    const allowed = await call('/api/auth/login', { method: 'POST', headers: withPlatform('app') });
    expect(allowed.status).toBe(200);
  });

  it('C11：h5 头双向（真 HTTP）', async () => {
    const blocked = await call('/api/auth/login', { method: 'POST', headers: withPlatform('h5') });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe(ErrCode.CLIENT_DISABLED);

    gateState.snapshot = BOTH_ON();
    const allowed = await call('/api/auth/login', { method: 'POST', headers: withPlatform('h5') });
    expect(allowed.status).toBe(200);
  });

  it('C12 真栈可达列：App / APP / android / 空串 ⇒ 放行，且都进未识别桶（值原样到达、大小写敏感）', async () => {
    for (const value of ['App', 'APP', 'android', '']) {
      const res = await call('/api/auth/login', { method: 'POST', headers: withPlatform(value) });
      expect({ value, status: res.status }).toEqual({ value, status: 200 });
    }
    expect(await unidentifiedCount()).toBe(4);
  });

  it('C13/C27：三豁免显式带头 + 闸关仍通（豁免本体）；且不计 unidentified', async () => {
    // admin：闸最先 ⇒ 豁免缺失的话这条会是 403+10008；到达 AdminAuth ⇒ 401+10002（无令牌）。
    const admin = await call('/api/admin/probe', { headers: withPlatform('app') });
    expect(admin.status).toBe(401);
    expect(await admin.json()).toMatchObject({ code: ErrCode.UNAUTHENTICATED, data: null });

    // health 两条：公开（匿名 200）。
    for (const path of ['/api/health', '/api/health/live']) {
      const res = await call(path, { headers: withPlatform('h5') });
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
    // `/api/config` 在**玩家验签**面内（不在公开白名单 —— `gateway.controller.ts:106`
    // 「经玩家验签」）：本格带有效令牌打，被验的唯一对象才是端闸豁免。
    mockJwt.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'j1' });
    const config = await call('/api/config', {
      headers: { ...withPlatform('h5'), authorization: 'Bearer valid' },
    });
    expect(config.status).toBe(200);

    expect(await unidentifiedCount()).toBe(0);

    // 负对照（同一基态、同一个头）：非豁免路径 ⇒ 403+10008 —— 证明 admin/health/config 的
    // 「通」来自豁免本体，而不是闸整体失灵。
    const negative = await call('/api/auth/login', { method: 'POST', headers: withPlatform('app') });
    expect(negative.status).toBe(403);
    expect((await negative.json()).code).toBe(ErrCode.CLIENT_DISABLED);
  });

  it('C14：闸先于 jwt —— 无/坏 token + 关闸端 + 非豁免 ⇒ 10008（不是 10002/10005）', async () => {
    // 无 token：若 jwt 先跑会是 401+10002；实际 403+10008 ⇒ 闸在前。
    const noToken = await call('/api/rooms', { headers: withPlatform('app') });
    expect(noToken.status).toBe(403);
    expect((await noToken.json()).code).toBe(ErrCode.CLIENT_DISABLED);

    // 坏 token：若 jwt 先跑会是 401+10005；实际 403+10008。
    const badToken = await call('/api/rooms', {
      headers: { ...withPlatform('app'), authorization: 'Bearer garbage' },
    });
    expect(badToken.status).toBe(403);
    expect((await badToken.json()).code).toBe(ErrCode.CLIENT_DISABLED);

    // 正对照①（排除「jwt 根本不产 10002」）：闸开 + 无 token ⇒ 401+10002
    gateState.snapshot = BOTH_ON();
    const jwtNoToken = await call('/api/rooms', { headers: withPlatform('app') });
    expect(jwtNoToken.status).toBe(401);
    expect((await jwtNoToken.json()).code).toBe(ErrCode.UNAUTHENTICATED);

    // 正对照②（排除「jwt 根本不产 10005」）：闸开 + 坏 token ⇒ 401+10005
    const jwtBadToken = await call('/api/rooms', {
      headers: { ...withPlatform('app'), authorization: 'Bearer garbage' },
    });
    expect(jwtBadToken.status).toBe(401);
    expect((await jwtBadToken.json()).code).toBe(ErrCode.TOKEN_INVALID);

    // 正对照③（链的完整成功路径）：有效令牌 + 闸开 ⇒ 200
    mockJwt.verify.mockReturnValue({ sub: 'u1', typ: 'access', jti: 'j1' });
    const ok = await call('/api/rooms', {
      headers: { ...withPlatform('app'), authorization: 'Bearer valid' },
    });
    expect(ok.status).toBe(200);
  });

  it('C16：OPTIONS 预检（带 h5 头 + 闸关打 login）⇒ 被 cors 短路（204 + ACAO，非 10008）', async () => {
    const preflight = await call('/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://h5.example.com',
        'Access-Control-Request-Method': 'POST',
        ...withPlatform('h5'),
      },
    });
    expect(preflight.status).toBe(204); // cors 预检默认 204 —— 请求没有到达闸
    expect(preflight.headers.get('access-control-allow-origin')).toBeTruthy();

    // 负对照（同一时刻、同一头、同一路径的 POST）：闸真的在关态 ⇒ 403+10008
    // —— 排除「上格 204 其实是闸放行」的假绿。
    const negative = await call('/api/auth/login', { method: 'POST', headers: withPlatform('h5') });
    expect(negative.status).toBe(403);
    expect((await negative.json()).code).toBe(ErrCode.CLIENT_DISABLED);
  });
});
