/**
 * 支付片 T2：payment-service 骨架的**启动面测试**（任务卡 Test: `boot.test.ts` ——
 * 「app 起 · `/health` 形状 · metrics 端点存在」）。
 *
 * ## 覆盖面（四块）
 *  ① **源码接线**：`src/main.ts` 的六条写死项（端口 3007 / metrics 9007 逐字 / fail-closed
 *     token / 短名 / 零被调 RPC / 反硬编码负向）—— 形态照 `currency-service/test/port.test.ts`
 *     （E2 先例；正则从源码里抓，判据比实现形态长寿，见 R150）。
 *  ② **app 起（真 Nest 管线 + 真 HTTP）**：`HealthController + HealthService`（`DataSource`
 *     就地假装配）+ 与 `main.ts` **逐字同形**的中间件/前缀（差异面 = 零 RPC/无 fail-closed
 *     exit/无 metrics 监听，见下方说明）⇒ `GET /api/health` 真 200 + 形状。
 *  ③ **`/health` 形状本体**：`ok`/`degraded`（503）/探测失败不抛/存活面不查依赖 ——
 *     照 `currency-service/test/health.test.ts` 先例（R267：checks **只报自己真的依赖的**）。
 *  ④ **metrics 端点存在**：`startMetricsListener` 真起一条（freePort）+ 无 Bearer ⇒ 401 /
 *     带 Bearer ⇒ 200（守卫本体在 shared，这里证「本服务调用的那个端点」活着）；外加
 *     `main.ts` 的 `{ port: 9007 }` 逐字（①）。
 *
 * ## 另两块同文件断言（本卡自身的判据物）
 *  - **数据库迁移表第三份独立**（`migrations_payment`：与 user 默认 `migrations` /
 *    `migrations_config` / `migrations_currency` 互异）—— 防「拷 currency 忘了改名」这种
 *    只有真容器才红的静默错误；
 *  - **⚙️8 HTTP_STATUS 全表**：10001→400 / 15001→502 / 15002→404 / 15003–15006·15008·15009→409；
 *    **15007 不得在表**（不出站：日志+指标）；不补则 4xx 静默变 500（货币片 §8 学费）。
 *
 * ## 测试纪律
 *  - HTTP 客户端一律 `node:http`（**不用 fetch**）：Node fetch 有「封禁端口表」，会与
 *    Windows 动态端口的已知假红族⑤撞车；`agent: false` 避免 keep-alive 把 `close()` 挂住。
 *  - 端口用「先占后放」的 `freePort()`（照 `shared/src/metrics/metrics-listener.test.ts` 先例）。
 *  - ⚠️ 真 HTTP + `listen` 在 Windows 上有已知假红族⑤（本仓判别法：同一次 run 里同文件
 *    在某阶段绿、另一阶段红 ⇒ 环境假红）——Linux CI 免疫。
 */
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer, get as httpGetRaw } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createInternalTokenMiddleware } from '../src/http/internal-token.middleware';
import { createTraceMiddleware, createHttpMetricsMiddleware, startMetricsListener } from '@fight-the-landlord/shared';
import { ErrCode } from '@fight-the-landlord/protocol';
import { AppModule } from '../src/app.module';
import { ConfigModule } from '../src/config/config.module';
import { paymentDatabaseOptions, paymentDataSourceOptions } from '../src/database.config';
import { DomainError, HTTP_STATUS, httpException, toHttpException } from '../src/http/errors';
import { HealthController } from '../src/health/health.controller';
import { CashierController } from '../src/cashier/cashier.controller';
import { HealthService } from '../src/health/health.service';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const SRC = readFileSync(join(PACKAGE_DIR, 'src/main.ts'), 'utf-8');
const METRICS_SRC = readFileSync(join(PACKAGE_DIR, 'src/metrics/payment.metrics.ts'), 'utf-8');

/** 先占一个 `listen(0)` 端口再释放（避开 Windows 动态端口上的已知竞态；同 shared 先例）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGetRaw({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

/* ================================================================== *
 * ① 源码接线（main.ts —— 判据照 currency port.test.ts 形态，含判别力自证）
 * ================================================================== */
describe('T2 源码接线：main.ts 的六条写死项（E2/⚙️2/R89）', () => {
  it('反向：源码里不得出现 `listen(3007)` 这种字面量调用（禁止硬编码端口）', () => {
    expect(/listen\(\s*3007\s*\)/.test(SRC), 'main.ts 仍在硬编码 listen(3007)').toBe(false);
  });

  it('正向①：必须读 `process.env.PORT`，默认值逐字 `3007`（⚙️2）', () => {
    expect(SRC).toMatch(/process\.env\.PORT/);
    expect(SRC, 'PORT 的默认值必须是本服务的端口 3007').toMatch(/PORT\s*\?\?\s*'3007'/);
  });

  it('正向②：metrics 监听逐字 `startMetricsListener({ port: 9007 })`（⚙️2：Bearer 守卫在 shared）', () => {
    expect(SRC).toMatch(/startMetricsListener\(\s*\{\s*port:\s*9007\s*\}\s*\)/);
  });

  it('正向③：fail-closed —— 未配置 `INTERNAL_SERVICE_TOKEN` ⇒ `process.exit(1)`（照 currency main.ts:12-14）', () => {
    expect(SRC).toMatch(/process\.env\.INTERNAL_SERVICE_TOKEN/);
    expect(SRC).toMatch(/process\.exit\(1\)/);
  });

  it('正向④：脱敏日志器的 service 短名逐字 `payment-service`（service-name 闸同判）', () => {
    expect(SRC).toMatch(/service:\s*'payment-service'/);
  });

  it('正向⑤（⚙️2）：**零被调 RPC 面** —— main.ts 不得出现 `connectMicroservice`（不开 TCP）', () => {
    expect(SRC).not.toMatch(/connectMicroservice/);
  });

  it('探针判别力自证（R115/R150）：反向正则抓得住硬编码、三处正向正则对错值必须红', () => {
    expect(/listen\(\s*3007\s*\)/.test('  await app.listen(3007);')).toBe(true);
    expect(/listen\(\s*3007\s*\)/.test('  await app.listen(port);')).toBe(false);
    expect(/PORT\s*\?\?\s*'3007'/.test("process.env.PORT ?? '3006'")).toBe(false);
    expect(/startMetricsListener\(\s*\{\s*port:\s*9007\s*\}\s*\)/.test('startMetricsListener({ port: 9006 })')).toBe(false);
  });

  it('metrics 骨架：本文件只经 shared 构造器注册（**不得**直连 prom-client —— registry 同一性纪律）', () => {
    expect(METRICS_SRC).not.toMatch(/from\s+['"]prom-client['"]/);
    expect(METRICS_SRC).not.toMatch(/\bnew\s+(Counter|Gauge|Histogram)\b/);
  });
});

/* ================================================================== *
 * ② app 起（真 Nest 管线 + 真 HTTP）与 ③ /health 形状
 * ================================================================== */

/** `DataSource` 替身：健康检查打的是 `SELECT 1`。 */
function createDataSourceDouble() {
  return { query: async () => [{ '1': 1 }] };
}

const bodyOf = (value: unknown) =>
  value as { status: string; service: string; checks?: Record<string, string> };

describe('② app 起 + ③ /health 形状（§2.4 / R267 —— 照 currency health.test.ts 先例）', () => {
  let app: INestApplication;
  let port = 0;
  let db: ReturnType<typeof createDataSourceDouble>;
  const savedToken = process.env.INTERNAL_SERVICE_TOKEN;

  beforeAll(async () => {
    // 与 `src/main.ts` 逐字同形（差异面 = 零 RPC / 无 fail-closed exit / 无 metrics 监听）。
    process.env.INTERNAL_SERVICE_TOKEN = 'boot-test-token';
    db = createDataSourceDouble();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: DataSource, useValue: db }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(createTraceMiddleware());
    app.use(createHttpMetricsMiddleware());
    app.use(createInternalTokenMiddleware());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    port = await freePort();
    await app.listen(port, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  });

  it('`GET /api/health` ⇒ 真 200，形状逐字 status=ok / service=payment-service / checks 恰 {mysql:up}', async () => {
    const res = await httpGet(port, '/api/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      service: 'payment-service',
      checks: { mysql: 'up' },
    });
  });

  it('`GET /api/health/live` ⇒ 200 且**无** checks（存活面不查依赖，R267）', async () => {
    const res = await httpGet(port, '/api/health/live');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', service: 'payment-service' });
  });

  it('豁免面是**精确**的（R293 负对照）：`/api/healthz` 无 token ⇒ 401；带正确 token ⇒ 404（路由不存在）', async () => {
    const noToken = await httpGet(port, '/api/healthz');
    expect(noToken.status).toBe(401);
    const withToken = await httpGet(port, '/api/healthz', { 'x-internal-token': 'boot-test-token' });
    expect(withToken.status).toBe(404);
  });
});

describe('③ /health 形状（直调面：degraded ⇒ 503 / 探测失败不抛 / 存活面不碰依赖）', () => {
  it('MySQL down ⇒ status=degraded + checks {mysql:down}；HTTP 503', async () => {
    const codes: number[] = [];
    const svc = new HealthService({
      query: async () => {
        throw new Error('ECONNREFUSED');
      },
    } as unknown as DataSource);
    const body = bodyOf(await new HealthController(svc).check({ status: (c) => void codes.push(c) }));
    expect(body).toEqual({
      status: 'degraded',
      service: 'payment-service',
      checks: { mysql: 'down' },
    });
    expect(codes).toEqual([503]);
  });

  it('探测失败**不得**让健康检查自己抛（那会变成 500 而不是 503）', async () => {
    const svc = new HealthService({
      query: async () => {
        throw new Error('boom');
      },
    } as unknown as DataSource);
    await expect(svc.check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('存活面：**不查依赖**、只报 status+service（R267）', async () => {
    let called = 0;
    const svc = new HealthService({
      query: async () => {
        called += 1;
        return [];
      },
    } as unknown as DataSource);
    expect(svc.live()).toEqual({ status: 'ok', service: 'payment-service' });
    expect(called).toBe(0);
  });

  it('容器解析（R216/R217）：`HealthService` 从真容器解析，注入的 `DataSource` 就是那个替身', async () => {
    const freshDb = createDataSourceDouble();
    const mod = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService, { provide: DataSource, useValue: freshDb }],
    }).compile();
    expect(mod.get(HealthController)).toBeInstanceOf(HealthController);
    await expect(mod.get(HealthService).check()).resolves.toEqual({
      status: 'ok',
      service: 'payment-service',
      checks: { mysql: 'up' },
    });
    await mod.close();
  });
});

/* ================================================================== *
 * ④ metrics 端点存在（真监听一条 + Bearer 两种读数）
 * ================================================================== */
describe('④ metrics 端点存在：`startMetricsListener` 真起 + Bearer 守卫两读数', () => {
  let closers: Array<{ close(): Promise<void> }> = [];
  const savedToken = process.env.INTERNAL_SERVICE_TOKEN;

  afterEach(async () => {
    await Promise.all(closers.map((c) => c.close()));
    closers = [];
    if (savedToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
    else process.env.INTERNAL_SERVICE_TOKEN = savedToken;
  });

  it('无 Bearer ⇒ 401；带正确 Bearer ⇒ 200 且是 prom 文本（`# TYPE ` 行在场）', async () => {
    process.env.INTERNAL_SERVICE_TOKEN = 'boot-test-token';
    const port = await freePort();
    closers.push(startMetricsListener({ port }));

    expect((await httpGet(port, '/metrics')).status).toBe(401);
    const ok = await httpGet(port, '/metrics', { authorization: 'Bearer boot-test-token' });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/plain; version=0.0.4');
    expect(ok.body).toMatch(/^# TYPE /m);
  });

  it('env 未设 ⇒ 一律 401（fail-closed；空串 = 未设口径）', async () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    const port = await freePort();
    closers.push(startMetricsListener({ port }));
    expect((await httpGet(port, '/metrics')).status).toBe(401);
  });
});

/* ================================================================== *
 * 附加判据物 1：⭐ 迁移表第三份独立（`migrations_payment`）
 * ================================================================== */
describe('数据库配置：`migrations_payment` 第三份独立（⚙️1/⚙️9 同族；防拷贝忘改名）', () => {
  it('`paymentDatabaseOptions()`：migrationsTableName = `migrations_payment`，且与另三份逐字互异', () => {
    const opts = paymentDatabaseOptions();
    expect(opts.migrationsTableName).toBe('migrations_payment');
    for (const other of ['migrations', 'migrations_config', 'migrations_currency']) {
      expect(opts.migrationsTableName).not.toBe(other);
    }
    // 与 user/config/currency 同口径：显式迁移、启动自动跑。
    expect(opts.synchronize).toBe(false);
    expect(opts.migrationsRun).toBe(true);
  });

  it('`data-source.ts` 的 CLI DataSource 与运行期共用同一份连接/迁移选项', () => {
    const opts = paymentDataSourceOptions();
    expect(opts.migrationsTableName).toBe('migrations_payment');
  });
});

/* ================================================================== *
 * 附加判据物 2：⚙️8 HTTP_STATUS 全表
 * ================================================================== */
describe('⚙️8 HTTP_STATUS 全表（不补则 4xx 静默变 500 —— 货币片 §8 学费）', () => {
  it('九条映射逐条在场：10001→400 / 15001→502 / 15002→404 / 15003–15006·15008·15009→409', () => {
    expect(HTTP_STATUS[ErrCode.BAD_PARAM]).toBe(400);
    expect(HTTP_STATUS[ErrCode.PAY_CHANNEL_ERROR]).toBe(502);
    expect(HTTP_STATUS[ErrCode.PAY_ORDER_NOT_FOUND]).toBe(404);
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAW_UNAVAILABLE]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAW_LIMIT]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_WITHDRAWABLE_INSUFFICIENT]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_REFUND_UNAVAILABLE]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_DISABLED]).toBe(409);
    expect(HTTP_STATUS[ErrCode.PAY_STATE_CONFLICT]).toBe(409);
  });

  it('15007（PAY_NOTIFY_VERIFY_FAILED）**不得**在表（不出站：日志+指标；入 RESERVED_CODES）', () => {
    expect(HTTP_STATUS[ErrCode.PAY_NOTIFY_VERIFY_FAILED]).toBeUndefined();
  });

  it('httpException：信封 `{code,message,data:null}` + 按表取状态码', () => {
    const ex = httpException(ErrCode.PAY_ORDER_NOT_FOUND, '订单不存在或已失效');
    expect(ex.getStatus()).toBe(404);
    expect(ex.getResponse()).toEqual({
      code: ErrCode.PAY_ORDER_NOT_FOUND,
      message: '订单不存在或已失效',
      data: null,
    });
  });

  it('DomainError → toHttpException 翻码；非 DomainError ⇒ 兜底 10001/400', () => {
    const dom = toHttpException(new DomainError(ErrCode.PAY_STATE_CONFLICT, '状态已变更'));
    expect(dom.getStatus()).toBe(409);
    expect((dom.getResponse() as { code: number }).code).toBe(ErrCode.PAY_STATE_CONFLICT);

    const plain = toHttpException(new Error('boom'));
    expect(plain.getStatus()).toBe(400);
    expect((plain.getResponse() as { code: number }).code).toBe(ErrCode.BAD_PARAM);
  });
});

/* ================================================================== *
 * 附加判据物 3：模块注册面（AppModule）
 * ================================================================== */
describe('模块注册面（T6 教训：未注册 = 单测全绿而真容器 404/不生效）', () => {
  it('`HealthController` 在 AppModule 的 controllers 里；`ConfigModule` 在 imports 里（ConfigCache 就绪）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(HealthController);
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(ConfigModule);
  });

  it('`CashierController` 在 AppModule 的 controllers 里（wap.pay 桥接页；未注册 = 充值跳转真容器 404）', () => {
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    expect(controllers).toContain(CashierController);
  });
});
